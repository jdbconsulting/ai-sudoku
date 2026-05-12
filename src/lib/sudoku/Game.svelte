<script lang="ts">
	import { browser } from '$app/environment';
	import Board3D from './Board3D.svelte';
	import ResidualGrid from './ResidualGrid.svelte';
	import SolutionDialog from './SolutionDialog.svelte';
	import SubmitScoreDialog from './SubmitScoreDialog.svelte';
	import type { GameState } from './state.svelte';
	import { formatAlphabet, sameAlphabet, DEFAULT_ALPHABET } from './alphabets';

	// Active-puzzle view. Owns the toolbar (clear / randomize /
	// load-naive / save / load / submit), the scoreboard, and the
	// boards + residual layout. The size-picker and preset list
	// that used to live here have moved to the dedicated "+ New
	// Game" tab in `+page.svelte` so changing dimensions cleanly
	// spawns a fresh tab instead of clobbering whatever the player
	// already has in flight.

	type Props = { game: GameState };
	let { game }: Props = $props();

	let dialogOpen = $state(false);
	let dialogMode = $state<'export' | 'import'>('export');
	let submitDialogOpen = $state(false);

	function openDialog(mode: 'export' | 'import') {
		dialogMode = mode;
		dialogOpen = true;
	}

	// Tracks which preset is currently being applied so we can show
	// a transient busy state if needed. The `queueMicrotask` defers
	// the heavy board mutation a tick so the click feedback paints
	// before we kick off the work.
	let presetBusy = $state('');

	function loadPreset(kind: 'standard' | 'clear' | 'random') {
		presetBusy = kind;
		queueMicrotask(() => {
			if (kind === 'standard') game.loadStandard();
			else if (kind === 'clear') game.clear();
			else if (kind === 'random') game.randomize();
			presetBusy = '';
		});
	}

	const fmtScore = new Intl.NumberFormat('en-US');
	function formatScore(s: number): string {
		if (!Number.isFinite(s)) return '—';
		return fmtScore.format(s);
	}

	// Compact pretty-printer for the active alphabet (e.g. "{−1, 0, +1}").
	// Reactivity tracks game.alphabet so a preset loader that snaps it to
	// the default during play (Strassen / Famous / AlphaTensor) updates
	// the badge live.
	let alphabetLabel = $derived(formatAlphabet(game.alphabet));
	let alphabetIsDefault = $derived(sameAlphabet(game.alphabet, DEFAULT_ALPHABET));
</script>

<section class="toolbar-card card">
	<div class="row toolbar">
		<span class="dims" title={`Active puzzle: ⟨${game.m},${game.n},${game.p}⟩`}>
			⟨{game.m},{game.n},{game.p}⟩
		</span>
		<span
			class="alphabet-badge"
			class:advanced={!alphabetIsDefault}
			title={`Cells of this puzzle are restricted to ${alphabetLabel}. Pick a different alphabet from the New Game tab to start a fresh puzzle in another world.`}
		>
			{alphabetLabel}
		</span>
		<span class="toolbar-sep" aria-hidden="true"></span>
		<button type="button" onclick={() => loadPreset('clear')}>Clear all</button>
		<button type="button" onclick={() => loadPreset('random')}>Randomize</button>
		<button
			type="button"
			onclick={() => loadPreset('standard')}
			title="Schoolbook m·n·p multiplications (ω = 3)"
		>
			Load Naive (R = m·n·p)
		</button>
		<span class="toolbar-sep" aria-hidden="true"></span>
		<button
			type="button"
			onclick={() => openDialog('export')}
			title="Save the current boards as JSON"
		>
			Save game…
		</button>
		<button
			type="button"
			onclick={() => openDialog('import')}
			title="Load boards from a JSON game file"
		>
			Load game…
		</button>
		<button
			type="button"
			class="primary submit"
			onclick={() => (submitDialogOpen = true)}
			title="Send these boards to the High Score Board (server recomputes the score)"
		>
			Submit score…
		</button>
		<span class="toolbar-hint">
			Want to switch sizes? Click <strong>+ New Game</strong> in the tab bar
			to start a fresh puzzle without disturbing this one.
		</span>
	</div>
</section>

<SolutionDialog {game} bind:open={dialogOpen} mode={dialogMode} />
<SubmitScoreDialog {game} bind:open={submitDialogOpen} />

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

<div class="boards-residual-row">
	<section class="boards panel">
		{#if browser}
			<Board3D {game} />
		{:else}
			<div class="board-placeholder">A · B · C</div>
		{/if}
	</section>

	<div class="residual-section">
		<ResidualGrid {game} />
	</div>
</div>

<!-- Mobile-only sticky score bar. Pinned to the bottom of the viewport so
     the player's score is always visible while they're tapping cells, even
     on tall pages where the full scoreboard has scrolled offscreen. The
     full scoreboard above is left untouched — this is just a always-on
     reminder of the headline number. Display: none on desktop. -->
<div
	class="mobile-score-bar"
	class:solved={game.solved}
	class:negative={game.score < 0}
	role="status"
	aria-live="polite"
>
	<span class="label">Score</span>
	<span class="value">{formatScore(game.score)}</span>
</div>

<style>
	.card {
		background: oklch(0.16 0.02 240 / 0.7);
		border: 1px solid rgb(30 41 59);
		border-radius: 14px;
		padding: 1rem 1.25rem;
		backdrop-filter: blur(6px);
	}

	.toolbar-card .row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.6rem;
	}
	.toolbar-sep {
		display: inline-block;
		width: 1px;
		align-self: stretch;
		background: rgb(51 65 85);
		margin: 0 0.2rem;
	}
	.dims {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 700;
		font-size: 0.95rem;
		letter-spacing: 0.04em;
		color: rgb(248 250 252);
		padding: 0.2rem 0.55rem;
		background: oklch(0.22 0.03 240 / 0.7);
		border: 1px solid rgb(51 65 85);
		border-radius: 6px;
	}
	.alphabet-badge {
		/* Sits right next to the ⟨m,n,p⟩ dims badge so the player can
		   see "what world am I in" at a glance. Plain slate styling
		   for the classical default; warm-amber accent when the
		   alphabet is one of the advanced presets, echoing the
		   Famous Algorithms author colour in the leaderboard so
		   "advanced / unusual" reads as the same family across the
		   app. */
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 600;
		font-size: 0.78rem;
		letter-spacing: 0.04em;
		color: rgb(203 213 225);
		padding: 0.2rem 0.55rem;
		background: oklch(0.18 0.02 240 / 0.65);
		border: 1px solid rgb(51 65 85);
		border-radius: 6px;
	}
	.alphabet-badge.advanced {
		color: oklch(0.92 0.14 70);
		background: oklch(0.22 0.05 70 / 0.55);
		border-color: oklch(0.45 0.1 70);
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
		/* Echoes the teal/green of the New Game tab in `+page.svelte`
		   (`.tab.newgame`) so the hint visually points at the exact
		   tab the player is meant to click. */
		color: oklch(0.85 0.12 175);
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
	button.submit {
		/* Different palette than "Apply size" so the two primary buttons in
		   the same card don't compete; green hints at "publish / commit". */
		background: linear-gradient(135deg, oklch(0.78 0.18 145), oklch(0.62 0.16 175));
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

	/* Side-by-side row holding the 3D combined board on the left and
	   the residual heatmap on the right, each 1/2 the page width.
	   `align-items: stretch` makes the two panels share the same
	   outer height — the Board3D card's natural height (a square
	   canvas-container plus its h-sliders + chrome) sets the bar,
	   and the residual card's `.canvas-wrap` flex-fills whatever
	   vertical space remains inside it after its header + legend.
	   That keeps the residual canvas the same on-screen height as
	   the game canvas regardless of whether the heatmap itself is
	   tall+narrow or short+wide for the current ⟨m, n, p⟩. */
	.boards-residual-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1.5rem;
		align-items: stretch;
		width: 100%;
	}
	.boards-residual-row > * {
		/* Without `min-width: 0` the canvases inside (which have
		   intrinsic widths) would force the grid track to grow
		   beyond 1fr and break the 50/50 split. */
		min-width: 0;
	}

	/* Shared "framed panel" look for the boards card on the left
	   and the ResidualGrid wrap on the right. The residual panel's
	   chrome lives inside `ResidualGrid.svelte` (.wrap) and these
	   values are kept in lockstep with it so the two halves of the
	   row read as a matched pair. The Board3D `.board-wrap` is a
	   direct child here and is `width: 100%` itself, so the canvas
	   + slider rails fill out the panel almost edge-to-edge. */
	.boards.panel {
		display: flex;
		justify-content: center;
		align-items: center;
		padding: 1.5rem;
		border: 1px solid rgb(51 65 85);
		border-radius: 14px;
		background: radial-gradient(
			circle at top,
			oklch(0.18 0.02 240 / 0.6),
			oklch(0.12 0.02 240 / 0.6)
		);
	}
	.board-placeholder {
		width: 100%;
		aspect-ratio: 1 / 1;
		max-width: 480px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 2rem;
		font-weight: 700;
		color: oklch(0.4 0.04 240);
		border: 1px dashed oklch(0.3 0.02 240);
		border-radius: 14px;
	}
	.residual-section {
		/* Plain flex container — the residual's frame/border is
		   provided by `.wrap` inside ResidualGrid.svelte. We just
		   need a grid-cell wrapper here so the half-width split
		   in `.boards-residual-row` works. */
		display: flex;
		justify-content: center;
		width: 100%;
	}

	/* Stack the boards + residual vertically below ~960px — but only
	   when the viewport is in portrait orientation. In portrait, each
	   half-width panel becomes too narrow to render the 3D scene
	   controls or the nested heatmap legibly, and the user has
	   plenty of vertical space to scroll through a one-column stack.

	   In landscape on the same narrow widths (e.g. iPhone 14 Pro Max
	   landscape at 932 × 430), stacking is actively harmful: each
	   panel is ~932px wide and square, so even the top panel doesn't
	   fit in the 430px viewport, and the residual ends up two
	   screenfuls below. Keeping the side-by-side `1fr 1fr` layout
	   there cuts each panel to ~466px wide × 466px tall, which is
	   still cramped but lets the player at least see both halves
	   at once with only a small scroll. */
	@media (max-width: 960px) and (orientation: portrait) {
		.boards-residual-row {
			grid-template-columns: 1fr;
		}
	}

	/* Sticky mobile score bar. Hidden by default; the @media block below
	   reveals it on phones. Z-index sits above the prize banners (z 50) so
	   nothing in the page can overlap the score readout. */
	.mobile-score-bar {
		display: none;
	}

	@media (max-width: 540px) {
		/* Trim card gutters on phones so the square Board3D canvas can use
		   nearly the full viewport width inside the boards card and the
		   residual matrix isn't pinched by 1.25rem of inner padding. */
		.card {
			padding: 0.75rem 0.6rem;
		}
		.mobile-score-bar {
			display: flex;
			align-items: baseline;
			justify-content: space-between;
			gap: 0.75rem;
			position: fixed;
			bottom: 0;
			left: 0;
			right: 0;
			z-index: 60;
			/* env() handles the home-indicator inset on iOS so the
			   bar's content isn't tucked under the system gesture
			   strip; the fallback keeps the same visual padding on
			   browsers without env() support. */
			padding: 0.55rem 0.9rem calc(0.55rem + env(safe-area-inset-bottom, 0px));
			background: oklch(0.14 0.02 240 / 0.92);
			border-top: 1px solid rgb(51 65 85);
			box-shadow: 0 -6px 18px rgba(0, 0, 0, 0.5);
			backdrop-filter: blur(8px);
			font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		}
		.mobile-score-bar .label {
			font-size: 0.7rem;
			text-transform: uppercase;
			letter-spacing: 0.1em;
			color: rgb(148 163 184);
		}
		.mobile-score-bar .value {
			font-size: 1.25rem;
			font-weight: 700;
			color: oklch(0.85 0.18 50);
			font-variant-numeric: tabular-nums;
		}
		.mobile-score-bar.negative .value {
			color: oklch(0.7 0.22 25);
		}
		.mobile-score-bar.solved .value {
			color: oklch(0.78 0.2 145);
		}
	}
</style>
