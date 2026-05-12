<script lang="ts">
	import { tick } from 'svelte';
	import type { GameState } from './state.svelte';
	import { putSave, saveExists, suggestSaveName, type SaveMeta } from './saves';

	// Save-game dialog. Two options inside the same modal: snapshot
	// the current boards to *this browser* under a user-chosen name
	// (recoverable later from the New Game tab), or copy/download the
	// boards as a portable JSON file. The matching *load* paths used
	// to live in this same dialog as a separate `mode === 'import'`
	// route — they were moved out to the New Game tab so loading a
	// save spawns a fresh game tab the same way every other launch
	// path (presets, leaderboard replays) does. With the import side
	// gone, the dialog is now purely about persisting the puzzle the
	// player has in front of them right now.
	type Props = {
		game: GameState;
		open: boolean;
		onClose?: () => void;
	};

	let { game, open = $bindable(), onClose }: Props = $props();

	let dialogEl: HTMLDialogElement | null = $state(null);
	let nameInputEl: HTMLInputElement | null = $state(null);

	// Save-name and a shared status line. The "Export as JSON" path
	// builds its payload on demand inside `downloadFile` so the
	// blob always reflects the boards at click time — no separate
	// `jsonText` state to keep in sync.
	let saveName = $state('');
	let status = $state<string>('');
	let statusKind = $state<'ok' | 'err' | ''>('');

	// Controlled by the parent via the `open` prop. We materialise that
	// into an actual <dialog> showModal() / close() call inside an effect
	// so the native modal semantics (backdrop, ESC-to-close, focus trap)
	// stay in sync with reactive state.
	$effect(() => {
		const el = dialogEl;
		if (!el) return;
		if (open && !el.open) {
			// Refresh the suggested save name on every (re-)open so
			// the timestamp and score reflect the player's most
			// recent edits rather than whatever they were the first
			// time the dialog was constructed.
			saveName = suggestSaveName(game.m, game.n, game.p, game.score);
			setStatus('', '');
			el.showModal();
			tick().then(() => nameInputEl?.focus());
		} else if (!open && el.open) {
			el.close();
		}
	});

	function setStatus(msg: string, kind: 'ok' | 'err' | '' = '') {
		status = msg;
		statusKind = kind;
	}

	function close() {
		open = false;
		setStatus('', '');
		onClose?.();
	}

	// Tracks whether the typed name collides with a save that
	// already exists so the UI can warn "this will overwrite X"
	// instead of springing the surprise on the player at click
	// time. Recomputed on every keystroke; `saveExists` is just a
	// `listSaves().some(...)` call so the per-character cost is
	// trivial.
	let trimmedName = $derived(saveName.trim());
	let nameCollides = $derived(trimmedName.length > 0 && saveExists(trimmedName));

	function saveToBrowser() {
		const name = trimmedName;
		if (!name) {
			setStatus('Give the save a name first.', 'err');
			return;
		}
		const meta: SaveMeta = {
			name,
			m: game.m,
			n: game.n,
			p: game.p,
			R: game.R,
			score: game.score,
			omega: game.omega,
			solved: game.solved,
			savedAt: Date.now()
		};
		const result = putSave(meta, game.toSolutionJSON());
		if (result.ok) {
			setStatus(
				`Saved to this browser as “${name}”. Resume it from the New Game tab.`,
				'ok'
			);
		} else {
			setStatus(result.error, 'err');
		}
	}

	function defaultFilename(): string {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		return `ai-sudoku-${game.m}x${game.n}x${game.p}-${stamp}.json`;
	}

	function downloadFile() {
		// Snapshot the boards at click time rather than on dialog
		// open: the player may have edited a cell in the background
		// (Game.svelte is still mounted behind the modal) and we
		// want the file to match what's currently on screen.
		const jsonText = JSON.stringify(game.toSolutionJSON(), null, 2);
		const blob = new Blob([jsonText], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = defaultFilename();
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		setStatus(`Saved as ${a.download}.`, 'ok');
	}

	// Native <dialog> emits a 'close' event when ESC is pressed or close()
	// is called. Mirror it back onto our controlled `open` prop so the
	// parent's state stays accurate.
	function onNativeClose() {
		if (open) open = false;
		onClose?.();
	}

	// Submit the name input on Enter — saves the player a tab+click
	// trip from the input to the "Save to browser" button, which is
	// the most likely thing they're trying to do after typing.
	function onNameKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			saveToBrowser();
		}
	}
</script>

<dialog
	bind:this={dialogEl}
	onclose={onNativeClose}
	class="m-auto w-[min(90vw,720px)] rounded-2xl border border-slate-700 bg-slate-900/95 p-0 text-slate-100 shadow-2xl backdrop:bg-slate-950/70 backdrop:backdrop-blur-sm"
>
	<form method="dialog" class="flex flex-col gap-5 p-6">
		<header class="flex items-start justify-between gap-4">
			<div>
				<h2 class="font-mono text-lg font-semibold tracking-wide text-slate-50">
					Save game
				</h2>
				<p class="mt-1 text-xs text-slate-400">
					Snapshot the current ⟨{game.m},{game.n},{game.p}⟩ boards. Save to this browser
					under a name you can recall from the New Game tab, or export the boards as a
					portable JSON file you can share or stash on disk.
				</p>
			</div>
			<button
				type="button"
				onclick={close}
				aria-label="Close"
				class="rounded-md border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-300 hover:bg-slate-700 hover:text-slate-100"
			>
				×
			</button>
		</header>

		<!-- Save to this browser ============================================= -->
		<section class="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-950/40 p-4">
			<h3
				class="font-mono text-[0.72rem] font-semibold uppercase tracking-widest text-slate-400"
			>
				Save to this browser
			</h3>
			<p class="text-xs text-slate-400">
				Stored locally in this browser only (no server, no account). Resume it later
				from the <span class="text-emerald-300">+ New Game</span> tab.
			</p>
			<div class="flex flex-wrap items-stretch gap-2">
				<input
					bind:this={nameInputEl}
					bind:value={saveName}
					onkeydown={onNameKeydown}
					type="text"
					maxlength="80"
					placeholder="Save name"
					class="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-sky-400 focus:outline-none"
				/>
				<button
					type="button"
					onclick={saveToBrowser}
					disabled={trimmedName.length === 0}
					class="rounded-md border border-transparent bg-linear-to-br from-emerald-400 to-teal-500 px-3 py-1.5 text-sm font-semibold text-slate-900 hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100"
				>
					Save to browser
				</button>
			</div>
			{#if nameCollides}
				<p class="text-xs text-amber-300">
					A save named “{trimmedName}” already exists — this will overwrite it.
				</p>
			{/if}
		</section>

		<!-- Export as JSON ================================================== -->
		<section class="flex flex-col gap-3 rounded-lg border border-slate-700 bg-slate-950/40 p-4">
			<h3
				class="font-mono text-[0.72rem] font-semibold uppercase tracking-widest text-slate-400"
			>
				Export as JSON
			</h3>
			<p class="text-xs text-slate-400">
				Portable snapshot you can re-import from the New Game tab on any device — the
				same format the leaderboard accepts.
			</p>
			<div class="flex flex-wrap items-center justify-end gap-2">
				<button
					type="button"
					onclick={downloadFile}
					class="rounded-md border border-transparent bg-linear-to-br from-sky-400 to-indigo-500 px-3 py-1.5 text-sm font-semibold text-slate-900 hover:brightness-110"
				>
					Save as file
				</button>
			</div>
		</section>

		{#if status}
			<p
				class="text-xs"
				class:text-emerald-400={statusKind === 'ok'}
				class:text-rose-400={statusKind === 'err'}
				class:text-slate-400={statusKind === ''}
			>
				{status}
			</p>
		{/if}

		<footer class="flex items-center justify-end gap-2">
			<button
				type="button"
				onclick={close}
				class="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
			>
				Close
			</button>
		</footer>
	</form>
</dialog>
