<script lang="ts">
	import { tick } from 'svelte';
	import type { GameState } from './state.svelte';
	import {
		apiEnabled,
		LeaderboardError,
		loadStoredUsername,
		saveStoredUsername,
		submitScore,
		type SubmitResult
	} from './leaderboard';
	import { formatAlphabet } from './alphabets';

	type Props = {
		game: GameState;
		open: boolean;
		onClose?: () => void;
	};

	let { game, open = $bindable(), onClose }: Props = $props();

	let dialogEl: HTMLDialogElement | null = $state(null);
	let usernameInputEl: HTMLInputElement | null = $state(null);

	let username = $state('');
	let submitting = $state(false);
	// One of: idle, ok (server accepted), err (validation/network failure).
	// `result` carries the server's authoritative numbers when ok.
	let status = $state<'idle' | 'ok' | 'err'>('idle');
	let message = $state('');
	let result = $state<SubmitResult | null>(null);

	const fmtScore = new Intl.NumberFormat('en-US');

	$effect(() => {
		const el = dialogEl;
		if (!el) return;
		if (open && !el.open) {
			username = loadStoredUsername();
			status = 'idle';
			message = '';
			result = null;
			el.showModal();
			tick().then(() => usernameInputEl?.focus());
		} else if (!open && el.open) {
			el.close();
		}
	});

	function close() {
		open = false;
		onClose?.();
	}

	async function onSubmit(event?: Event) {
		event?.preventDefault();
		if (submitting) return;
		const trimmed = username.trim().replace(/\s+/g, ' ');
		if (!trimmed) {
			status = 'err';
			message = 'Please enter a username.';
			return;
		}

		submitting = true;
		status = 'idle';
		message = '';
		try {
			const r = await submitScore(trimmed, game);
			result = r;
			status = 'ok';
			message = `Submitted! Server score: ${fmtScore.format(r.score)}.`;
			// Persist the *server-canonical* username (which may differ from
			// what we typed if the server collapsed whitespace, etc.) so the
			// next dialog opens with the same casing it'll use server-side.
			saveStoredUsername(r.username);
			username = r.username;
		} catch (err) {
			status = 'err';
			message =
				err instanceof LeaderboardError
					? err.message
					: err instanceof Error
						? err.message
						: String(err);
		} finally {
			submitting = false;
		}
	}

	function onNativeClose() {
		if (open) open = false;
		onClose?.();
	}
</script>

<dialog
	bind:this={dialogEl}
	onclose={onNativeClose}
	class="m-auto w-[min(92vw,520px)] rounded-2xl border border-slate-700 bg-slate-900/95 p-0 text-slate-100 shadow-2xl backdrop:bg-slate-950/70 backdrop:backdrop-blur-sm"
>
	<form method="dialog" onsubmit={onSubmit} class="flex flex-col gap-4 p-6">
		<header class="flex items-start justify-between gap-4">
			<div>
				<h2 class="font-mono text-lg font-semibold tracking-wide text-slate-50">Submit score</h2>
				<p class="mt-1 text-xs text-slate-400">
					Send your current ⟨{game.m},{game.n},{game.p}⟩ boards to the leaderboard. The server
					recomputes the score from scratch, so whatever ranks is provably valid.
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

		<div
			class="grid grid-cols-4 gap-3 rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 font-mono text-xs text-slate-300"
		>
			<div>
				<div class="text-[0.65rem] tracking-widest text-slate-500 uppercase">⟨m,n,p⟩</div>
				<div class="text-sm text-slate-100">⟨{game.m},{game.n},{game.p}⟩</div>
			</div>
			<div>
				<div class="text-[0.65rem] tracking-widest text-slate-500 uppercase">Alphabet</div>
				<div class="text-sm text-slate-100" title="Cell-value alphabet for this submission">
					{formatAlphabet(game.alphabet)}
				</div>
			</div>
			<div>
				<div class="text-[0.65rem] tracking-widest text-slate-500 uppercase">R<sub>eff</sub></div>
				<div class="text-sm text-slate-100">{game.effectiveRank}</div>
			</div>
			<div>
				<div class="text-[0.65rem] tracking-widest text-slate-500 uppercase">Local score</div>
				<div class="text-sm text-amber-300">{fmtScore.format(game.score)}</div>
			</div>
		</div>

		{#if !apiEnabled}
			<p
				class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
			>
				This build was compiled without a leaderboard backend (<code
					class="rounded bg-slate-800 px-1">PUBLIC_API_URL</code
				> is unset). Submission is disabled.
			</p>
		{/if}

		<label class="flex flex-col gap-1">
			<span class="text-[0.65rem] tracking-widest text-slate-400 uppercase">Username</span>
			<input
				bind:this={usernameInputEl}
				bind:value={username}
				type="text"
				maxlength="20"
				autocomplete="off"
				spellcheck="false"
				disabled={!apiEnabled || submitting || status === 'ok'}
				placeholder="e.g. joel"
				class="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100 focus:border-sky-400 focus:outline-none disabled:opacity-60"
			/>
			<span class="text-[0.7rem] text-slate-500">
				1–20 characters. Letters, digits, spaces, hyphens, underscores. Saved locally so you don't
				have to retype it.
			</span>
		</label>

		{#if status === 'ok' && result}
			<div
				class="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"
			>
				<div class="font-semibold">{message}</div>
				<div class="mt-1 text-emerald-100/80">
					ω = {result.omega.toFixed(3)} · R<sub>eff</sub> = {result.Reff}
					{#if result.solved}· <span class="text-emerald-300">★ solved</span>{/if}
				</div>
			</div>
		{:else if status === 'err'}
			<p
				class="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
			>
				{message}
			</p>
		{/if}

		<footer class="flex flex-wrap items-center justify-end gap-2">
			<button
				type="button"
				onclick={close}
				class="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
			>
				{status === 'ok' ? 'Done' : 'Cancel'}
			</button>
			{#if status !== 'ok'}
				<button
					type="submit"
					disabled={!apiEnabled || submitting}
					class="rounded-md border border-transparent bg-linear-to-br from-sky-400 to-indigo-500 px-3 py-1.5 text-sm font-semibold text-slate-900 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{submitting ? 'Submitting…' : 'Submit'}
				</button>
			{/if}
		</footer>
	</form>
</dialog>
