<script lang="ts">
	import { tick } from 'svelte';
	import type { GameState } from './state.svelte';

	type Mode = 'export' | 'import';
	type Props = {
		game: GameState;
		open: boolean;
		mode: Mode;
		onClose?: () => void;
	};

	let { game, open = $bindable(), mode, onClose }: Props = $props();

	let dialogEl: HTMLDialogElement | null = $state(null);
	let textareaEl: HTMLTextAreaElement | null = $state(null);
	let fileInputEl: HTMLInputElement | null = $state(null);

	// Controlled by the parent via the `open` prop. We materialise that
	// into an actual <dialog> showModal() / close() call inside an effect
	// so the native modal semantics (backdrop, ESC-to-close, focus trap)
	// stay in sync with reactive state.
	$effect(() => {
		const el = dialogEl;
		if (!el) return;
		if (open && !el.open) {
			// Refresh exported text every time we (re-)open in export mode so
			// edits to the boards in the meantime are reflected.
			if (mode === 'export') {
				text = JSON.stringify(game.toSolutionJSON(), null, 2);
				status = '';
			}
			el.showModal();
			tick().then(() => textareaEl?.focus());
		} else if (!open && el.open) {
			el.close();
		}
	});

	let text = $state('');
	let status = $state<string>('');
	let statusKind = $state<'ok' | 'err' | ''>('');

	function setStatus(msg: string, kind: 'ok' | 'err' | '' = '') {
		status = msg;
		statusKind = kind;
	}

	function close() {
		open = false;
		setStatus('', '');
		onClose?.();
	}

	function defaultFilename(): string {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
		return `ai-sudoku-${game.m}x${game.n}x${game.p}-${stamp}.json`;
	}

	async function copyToClipboard() {
		try {
			await navigator.clipboard.writeText(text);
			setStatus('Copied to clipboard.', 'ok');
		} catch (e) {
			// Fallback: select the textarea so the user can copy manually.
			textareaEl?.select();
			setStatus(`Copy failed (${(e as Error).message}). Text is selected — press Ctrl/Cmd+C.`, 'err');
		}
	}

	function downloadFile() {
		const blob = new Blob([text], { type: 'application/json' });
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

	function applyImport() {
		try {
			const data = JSON.parse(text);
			game.loadSolutionJSON(data);
			setStatus(`Loaded ⟨${game.m},${game.n},${game.p}⟩ R=${game.R} successfully.`, 'ok');
			// Auto-close on a clean import so the player can immediately see
			// the freshly populated boards.
			setTimeout(close, 600);
		} catch (e) {
			setStatus((e as Error).message, 'err');
		}
	}

	function pickFile() {
		fileInputEl?.click();
	}

	async function onFileChange(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // allow re-selecting the same file later
		if (!file) return;
		try {
			text = await file.text();
			setStatus(`Loaded ${file.name} into the editor — review then click Apply.`, 'ok');
		} catch (e) {
			setStatus(`Could not read file: ${(e as Error).message}`, 'err');
		}
	}

	// Native <dialog> emits a 'close' event when ESC is pressed or close()
	// is called. Mirror it back onto our controlled `open` prop so the
	// parent's state stays accurate.
	function onNativeClose() {
		if (open) open = false;
		onClose?.();
	}
</script>

<dialog
	bind:this={dialogEl}
	onclose={onNativeClose}
	class="m-auto w-[min(90vw,720px)] rounded-2xl border border-slate-700 bg-slate-900/95 p-0 text-slate-100 shadow-2xl backdrop:bg-slate-950/70 backdrop:backdrop-blur-sm"
>
	<form method="dialog" class="flex flex-col gap-4 p-6">
		<header class="flex items-start justify-between gap-4">
			<div>
				<h2 class="font-mono text-lg font-semibold tracking-wide text-slate-50">
					{mode === 'export' ? 'Export solution' : 'Import solution'}
				</h2>
				<p class="mt-1 text-xs text-slate-400">
					{#if mode === 'export'}
						JSON snapshot of the current ⟨{game.m},{game.n},{game.p}⟩ boards. Copy to
						clipboard or save as a <code class="rounded bg-slate-800 px-1 text-sky-300">.json</code> file.
					{:else}
						Paste a JSON solution below or load one from disk, then click <strong>Apply</strong>.
						The puzzle will be resized to match.
					{/if}
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

		<textarea
			bind:this={textareaEl}
			bind:value={text}
			readonly={mode === 'export'}
			spellcheck="false"
			class="h-72 w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-xs leading-relaxed text-sky-200 focus:border-sky-400 focus:outline-none"
			placeholder={mode === 'import' ? 'Paste solution JSON here…' : ''}
		></textarea>

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

		<footer class="flex flex-wrap items-center justify-end gap-2">
			{#if mode === 'export'}
				<button
					type="button"
					onclick={copyToClipboard}
					class="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 hover:bg-slate-700"
				>
					Copy to clipboard
				</button>
				<button
					type="button"
					onclick={downloadFile}
					class="rounded-md border border-transparent bg-linear-to-br from-sky-400 to-indigo-500 px-3 py-1.5 text-sm font-semibold text-slate-900 hover:brightness-110"
				>
					Save as file
				</button>
			{:else}
				<input
					bind:this={fileInputEl}
					type="file"
					accept="application/json,.json"
					class="hidden"
					onchange={onFileChange}
				/>
				<button
					type="button"
					onclick={pickFile}
					class="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 hover:bg-slate-700"
				>
					Load from file…
				</button>
				<button
					type="button"
					onclick={applyImport}
					class="rounded-md border border-transparent bg-linear-to-br from-emerald-400 to-teal-500 px-3 py-1.5 text-sm font-semibold text-slate-900 hover:brightness-110"
				>
					Apply
				</button>
			{/if}
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
