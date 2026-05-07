<script lang="ts">
	import { untrack } from 'svelte';
	import { browser } from '$app/environment';
	import Board3D from './Board3D.svelte';
	import ResidualGrid from './ResidualGrid.svelte';
	import SolutionDialog from './SolutionDialog.svelte';
	import type { GameState } from './state.svelte';

	type Props = { game: GameState };
	let { game }: Props = $props();

	let dialogOpen = $state(false);
	let dialogMode = $state<'export' | 'import'>('export');

	function openDialog(mode: 'export' | 'import') {
		dialogMode = mode;
		dialogOpen = true;
	}

	// Local form state (applied via "Apply" so we don't thrash boards on each
	// keystroke). Seeded from the current game config on mount; this component
	// is re-mounted per tab switch so values track the active puzzle. We use
	// `untrack` to make the "initial value only" intent explicit.
	let mInput = $state(untrack(() => game.m));
	let nInput = $state(untrack(() => game.n));
	let pInput = $state(untrack(() => game.p));

	let presetBusy = $state('');

	function applyConfig() {
		const m = clampInt(mInput, 2, 8);
		const n = clampInt(nInput, 2, 8);
		const p = clampInt(pInput, 2, 8);
		mInput = m;
		nInput = n;
		pInput = p;
		game.resize(m, n, p);
	}

	function clampInt(v: number, lo: number, hi: number): number {
		const n = Math.round(Number(v) || 0);
		return Math.min(hi, Math.max(lo, n));
	}

	function loadPreset(kind: 'standard' | 'clear' | 'random') {
		presetBusy = kind;
		queueMicrotask(() => {
			if (kind === 'standard') game.loadStandard();
			else if (kind === 'clear') game.clear();
			else if (kind === 'random') game.randomize();
			presetBusy = '';
		});
	}

	function setExample(m: number, n: number, p: number) {
		mInput = m;
		nInput = n;
		pInput = p;
		applyConfig();
	}

	const fmtScore = new Intl.NumberFormat('en-US');
	function formatScore(s: number): string {
		if (!Number.isFinite(s)) return '—';
		return fmtScore.format(s);
	}
</script>

<section class="config card">
	<div class="row">
		<label>
			<span>m</span>
			<input type="number" min="2" max="8" bind:value={mInput} />
		</label>
		<label>
			<span>n</span>
			<input type="number" min="2" max="8" bind:value={nInput} />
		</label>
		<label>
			<span>p</span>
			<input type="number" min="2" max="8" bind:value={pInput} />
		</label>
		<button class="primary" type="button" onclick={applyConfig}>Apply size</button>
	</div>
	<p class="dim-hint">Each dimension can be set from <code>2</code> to <code>8</code>.</p>
	<div class="row examples">
		<span class="lbl">Game board presets:</span>
		<button type="button" onclick={() => setExample(2, 2, 2)}>⟨2,2,2⟩</button>
		<button type="button" onclick={() => setExample(2, 2, 3)}>⟨2,2,3⟩</button>
		<button type="button" onclick={() => setExample(2, 3, 3)}>⟨2,3,3⟩</button>
		<button type="button" onclick={() => setExample(3, 3, 3)}>⟨3,3,3⟩</button>
		<button type="button" onclick={() => setExample(4, 4, 4)}>⟨4,4,4⟩</button>
		<button type="button" onclick={() => setExample(4, 5, 5)}>⟨4,5,5⟩</button>
		<button type="button" onclick={() => setExample(5, 5, 5)}>⟨5,5,5⟩</button>
	</div>
	<div class="row toolbar">
		<button type="button" onclick={() => loadPreset('clear')}>Clear all</button>
		<button type="button" onclick={() => loadPreset('random')}>Randomize</button>
		<button type="button" onclick={() => loadPreset('standard')}
			title="Schoolbook m·n·p multiplications (ω = 3)">
			Load Naive (R = m·n·p)
		</button>
		<span class="toolbar-sep" aria-hidden="true"></span>
		<button type="button" onclick={() => openDialog('export')}
			title="Save the current boards as JSON">
			Save game…
		</button>
		<button type="button" onclick={() => openDialog('import')}
			title="Load boards from a JSON game file">
			Load game…
		</button>
		<span class="toolbar-hint">
			Want a head start? Open the
			<strong>🏆 High Score Board</strong> tab for ready-made solutions.
		</span>
	</div>
</section>

<SolutionDialog {game} bind:open={dialogOpen} mode={dialogMode} />

<div class="view-controls">
	<label class="spacing-ctrl">
		<span>Page spacing</span>
		<input
			type="range"
			min="0.04"
			max="1.4"
			step="0.01"
			bind:value={game.tightGap}
		/>
		<output>{game.tightGap.toFixed(2)}</output>
	</label>
	<label class="spacing-ctrl">
		<span>Clearance</span>
		<input
			type="range"
			min="0.2"
			max="10"
			step="0.05"
			bind:value={game.clearance}
			title="Symmetric gap carved out in front of and behind the active page"
		/>
		<output>{game.clearance.toFixed(2)}</output>
	</label>
</div>

<section class="scoreboard card">
	<div class="metric" class:solved={game.solved}>
		<span class="label">Residual non-zeros</span>
		<span class="value">{game.residualNonzero}</span>
		<span class="sub">/ {game.sa * game.sb * game.sc}</span>
	</div>
	<div class="metric">
		<span class="label">Σ|Γ| fix cost</span>
		<span class="value">{game.residualSumAbs}</span>
		<span class="sub">naive ±1 patch terms</span>
	</div>
	<div class="metric">
		<span class="label">Pages used</span>
		<span class="value">{game.ranksUsed}</span>
		<span class="sub">/ {game.R} (= m·n·p)</span>
	</div>
	<div class="metric">
		<span class="label">R<sub class="sub-eff">eff</sub></span>
		<span class="value">{game.effectiveRank}</span>
		<span class="sub">used + fix cost</span>
	</div>
	<div class="metric omega">
		<span class="label">ω &nbsp;asymptotic exp.</span>
		<span
			class="value"
			title="max(3·ln(R_eff)/ln(m·n·p), 2 + ln(depth+1)/ln(N_ref)) at N_ref = 2²⁰; the polylog floor accounts for divide-and-conquer recursion overhead."
			>{game.omega.toFixed(3)}</span
		>
		<span class="sub">2 = ideal · 3 = naive</span>
	</div>
	<div class="metric score" class:negative={game.score < 0}>
		<span class="label">Score</span>
		<span class="value">{formatScore(game.score)}</span>
		<span class="sub">+10⁶ at ω=2 · 1 at ω=3 · −10⁶ at ω=9</span>
	</div>
	<div class="trophy" class:visible={game.solved} role="status" aria-live="polite">
		★ Algorithm valid! Empty more rank pages (or grow &lt;m,n,p&gt;) to achieve a higher score.
	</div>
</section>

<section class="boards card">
	<div class="boards-row">
		{#if browser}
			<Board3D {game} board="A" title="A" hue={230} />
			<Board3D {game} board="B" title="B" hue={340} />
			<Board3D {game} board="C" title="C" hue={45} />
		{:else}
			<div class="board-placeholder">A</div>
			<div class="board-placeholder">B</div>
			<div class="board-placeholder">C</div>
		{/if}
	</div>
</section>

<section class="card residual-section">
	<ResidualGrid {game} />
</section>

<style>
	.card {
		background: oklch(0.16 0.02 240 / 0.7);
		border: 1px solid rgb(30 41 59);
		border-radius: 14px;
		padding: 1rem 1.25rem;
		backdrop-filter: blur(6px);
	}

	.config .row {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: 0.6rem;
	}
	.config label {
		display: inline-flex;
		flex-direction: column;
		gap: 0.15rem;
		font-size: 0.7rem;
		color: rgb(148 163 184);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.config input {
		width: 64px;
		background: rgb(15 23 42);
		border: 1px solid rgb(51 65 85);
		color: rgb(248 250 252);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		padding: 0.4rem 0.5rem;
		border-radius: 6px;
		font-size: 1rem;
	}
	.config input:focus {
		outline: 2px solid oklch(0.7 0.18 230);
		border-color: transparent;
	}
	.dim-hint {
		margin: 0.4rem 0 0;
		font-size: 0.75rem;
		color: rgb(148 163 184);
	}
	.dim-hint code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: rgb(30 41 59);
		padding: 0 0.3em;
		border-radius: 4px;
		color: rgb(125 211 252);
	}
	.toolbar {
		margin-top: 0.4rem;
	}
	.toolbar-sep {
		display: inline-block;
		width: 1px;
		align-self: stretch;
		background: rgb(51 65 85);
		margin: 0 0.2rem;
	}
	.examples {
		margin-top: 0.6rem;
		gap: 0.4rem;
		font-size: 0.78rem;
	}
	.examples .lbl {
		color: rgb(148 163 184);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		align-self: center;
	}

	.toolbar-hint {
		margin-left: 0.5rem;
		align-self: center;
		font-size: 0.75rem;
		color: rgb(148 163 184);
		max-width: 36ch;
		line-height: 1.35;
	}
	.toolbar-hint strong {
		color: oklch(0.88 0.14 70);
		font-weight: 600;
	}

	button {
		background: rgb(30 41 59);
		color: rgb(226 232 240);
		border: 1px solid rgb(51 65 85);
		padding: 0.45rem 0.85rem;
		border-radius: 6px;
		font-size: 0.85rem;
		cursor: pointer;
		font-family: inherit;
	}
	button:hover:not(:disabled) {
		background: rgb(51 65 85);
		border-color: rgb(100 116 139);
	}
	button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	button.primary {
		background: linear-gradient(135deg, oklch(0.62 0.18 230), oklch(0.55 0.18 260));
		color: rgb(15 23 42);
		font-weight: 600;
		border-color: transparent;
	}

	.scoreboard {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 1.5rem;
		justify-content: center;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
	}
	.metric {
		display: flex;
		flex-direction: column;
		align-items: center;
		min-width: 110px;
	}
	.metric .label {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: rgb(148 163 184);
	}
	.metric .value {
		font-size: 1.8rem;
		font-weight: 700;
		color: rgb(248 250 252);
	}
	.metric .sub {
		font-size: 0.75rem;
		color: rgb(100 116 139);
	}
	.metric.solved .value {
		color: oklch(0.78 0.2 145);
	}
	.metric.score .value {
		color: oklch(0.85 0.18 50);
		font-variant-numeric: tabular-nums;
	}
	.metric.score.negative .value {
		color: oklch(0.7 0.22 25);
	}
	.metric.omega .value {
		color: rgb(125 211 252);
		font-variant-numeric: tabular-nums;
	}
	.sub-eff {
		font-size: 0.7em;
		color: rgb(100 116 139);
	}
	.trophy {
		flex-basis: 100%;
		text-align: center;
		color: oklch(0.85 0.2 145);
		font-weight: 600;
		letter-spacing: 0.04em;
		text-shadow: 0 0 14px oklch(0.7 0.2 145 / 0.6);
		visibility: hidden;
		opacity: 0;
		transition: opacity 200ms ease;
	}
	.trophy.visible {
		visibility: visible;
		opacity: 1;
	}

	.boards-row {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1.25rem;
		align-items: center;
		justify-items: center;
	}
	.view-controls {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: 0.5rem 1.5rem;
		margin: 0;
	}
	.spacing-ctrl {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.78rem;
		color: rgb(148 163 184);
	}
	.spacing-ctrl span {
		text-transform: uppercase;
		letter-spacing: 0.08em;
		min-width: 7em;
		text-align: right;
	}
	.spacing-ctrl input[type='range'] {
		accent-color: oklch(0.7 0.18 230);
		width: 200px;
	}
	.spacing-ctrl output {
		min-width: 2.4em;
		text-align: right;
		color: rgb(226 232 240);
	}
	.board-placeholder {
		width: 360px;
		height: 360px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 4rem;
		font-weight: 700;
		color: oklch(0.4 0.04 240);
		border: 1px dashed oklch(0.3 0.02 240);
		border-radius: 14px;
	}
	.residual-section {
		display: flex;
		justify-content: center;
		padding: 1rem;
	}

	@media (max-width: 900px) {
		.boards-row {
			grid-template-columns: 1fr;
		}
	}
</style>
