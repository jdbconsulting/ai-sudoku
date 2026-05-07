<script lang="ts">
	import Game from '$lib/sudoku/Game.svelte';
	import HighScoreBoard from '$lib/sudoku/HighScoreBoard.svelte';
	import { GameState } from '$lib/sudoku/state.svelte';
	import type { HighScore } from '$lib/sudoku/highscores';
	import type { FullScore } from '$lib/sudoku/leaderboard';

	// Two flavours of tab: a single permanent "high score board" pinned on
	// the left (id = LEADERBOARD_ID, can't be closed), and any number of
	// regular game tabs the user opens. Discriminated unions keep the
	// rendering and tab-bar logic honest about which is which.
	const LEADERBOARD_ID = 0;
	type LeaderboardTab = { kind: 'leaderboard'; id: typeof LEADERBOARD_ID };
	type GameTab = { kind: 'game'; id: number; game: GameState };
	type Tab = LeaderboardTab | GameTab;

	let nextId = 1;
	function newGameTab(): GameTab {
		return { kind: 'game', id: nextId++, game: new GameState(2, 2, 2) };
	}

	const leaderboardTab: LeaderboardTab = { kind: 'leaderboard', id: LEADERBOARD_ID };

	let tabs = $state<Tab[]>([leaderboardTab]);
	let activeId = $state<number>(LEADERBOARD_ID);

	let activeTab = $derived(tabs.find((t) => t.id === activeId) ?? tabs[0]);

	const tabScoreFmt = new Intl.NumberFormat('en-US');
	function tabLabel(t: Tab): string {
		if (t.kind === 'leaderboard') return '🏆 High Score Board';
		const g = t.game;
		const star = g.solved ? ' ★' : '';
		const s = Number.isFinite(g.score) ? tabScoreFmt.format(g.score) : '—';
		return `⟨${g.m},${g.n},${g.p}⟩  ${s}${star}`;
	}

	function addTab() {
		const t = newGameTab();
		tabs.push(t);
		activeId = t.id;
	}

	function openHighScore(entry: HighScore) {
		// Each Play click spawns a fresh tab so the leaderboard works as a
		// non-destructive launcher — the user's other in-progress puzzles
		// are never overwritten.
		const t = newGameTab();
		entry.apply(t.game);
		tabs.push(t);
		activeId = t.id;
	}

	function openUserScore(entry: FullScore) {
		// Same non-destructive policy as openHighScore: every replay
		// click gets its own tab. The HighScoreBoard already awaited
		// the API fetch, so by the time we get here the boards are in
		// hand and applying them is synchronous.
		const t = newGameTab();
		t.game.loadFlatBoards(entry.m, entry.n, entry.p, entry.A, entry.B, entry.C);
		tabs.push(t);
		activeId = t.id;
	}

	function closeTab(id: number, event?: Event) {
		event?.stopPropagation();
		// The leaderboard is permanent: ignore any close attempt that
		// somehow targets it (the close button isn't even rendered on
		// that tab, but defence-in-depth is cheap).
		if (id === LEADERBOARD_ID) return;
		const idx = tabs.findIndex((t) => t.id === id);
		if (idx < 0) return;

		tabs.splice(idx, 1);
		if (activeId === id) {
			const neighbour = tabs[idx] ?? tabs[idx - 1] ?? tabs[0];
			activeId = neighbour.id;
		}
	}

	function selectTab(id: number) {
		activeId = id;
	}

	function onTabKeydown(event: KeyboardEvent, id: number) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			selectTab(id);
		}
	}

	let helpDialog = $state<HTMLDialogElement | undefined>();

	function openHelp() {
		helpDialog?.showModal();
	}

	function closeHelp() {
		helpDialog?.close();
	}

	// Close when clicking the backdrop. The native <dialog> reports the dialog
	// itself as the click target when the backdrop is clicked.
	function onDialogClick(event: MouseEvent) {
		if (event.target === helpDialog) closeHelp();
	}

	// Auto-open on initial page load.
	$effect(() => {
		helpDialog?.showModal();
	});
</script>

<svelte:head>
	<title>AI Sudoku — Find a faster matrix multiplication algorithm</title>
	<meta
		name="description"
		content="A puzzle game where you discover bilinear matrix multiplication algorithms by zeroing out the residual tensor."
	/>
	<meta name="author" content="JD Brinton" />

	<meta property="og:type" content="article" />
	<meta property="og:site_name" content="AI Sudoku" />
	<meta property="og:title" content="AI Sudoku — Find a faster matrix multiplication algorithm" />
	<meta
		property="og:description"
		content="A puzzle game where you discover bilinear matrix multiplication algorithms by zeroing out the residual tensor."
	/>
	<meta property="og:url" content="https://ai-sudoku.org/" />
	<meta property="og:image" content="https://ai-sudoku.org/og-image.png" />
	<meta property="og:image:type" content="image/png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:alt" content="AI Sudoku logo" />

	<meta property="article:author" content="https://jdbrinton.consulting" />
	<meta property="article:published_time" content="2026-05-07T00:00:00Z" />

	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content="AI Sudoku — Find a faster matrix multiplication algorithm" />
	<meta
		name="twitter:description"
		content="A puzzle game where you discover bilinear matrix multiplication algorithms by zeroing out the residual tensor."
	/>
	<meta name="twitter:image" content="https://ai-sudoku.org/og-image.png" />
	<meta name="twitter:image:alt" content="AI Sudoku logo" />
</svelte:head>

<div class="prize-stack" role="status" aria-label="Prize announcements">
	<div class="prize-banner gold" title="First player to score 1,000 or higher wins US$10,000">
		<span class="prize-amount">US$10,000</span>
		<span class="prize-text">prize for the first score of 1,000 or higher!</span>
	</div>
	<div class="prize-banner silver" title="First player to score 100 or higher wins US$1,000">
		<span class="prize-amount">US$1,000</span>
		<span class="prize-text">prize for the first score of 100 or higher!</span>
	</div>
</div>

<div class="page">
	<header class="banner">
		<div class="brand">
			<span class="logo">AI</span>
			<h1>SUDOKU</h1>
			<button
				type="button"
				class="help-btn"
				aria-label="Show help"
				title="How to play"
				onclick={openHelp}
			>
				?
			</button>
		</div>
	</header>

	<dialog
		bind:this={helpDialog}
		class="help-dialog"
		aria-labelledby="help-title"
		onclick={onDialogClick}
	>
		<button
			type="button"
			class="dialog-close"
			aria-label="Close help"
			title="Close"
			onclick={closeHelp}
		>
			×
		</button>
		<div class="help-dialog-inner">
			<h2 id="help-title">How to play</h2>
			<p class="tagline">
				Help make AI faster by inventing a new algorithm! When you play this game and achieve a new
				high score, you have discovered a new algorithm that will directly improve the performance
				of AI. Each puzzle gives you three small grids —
				<code>A</code>, <code>B</code>, and <code>C</code> — whose cells you set to
				<code>−1</code>, <code>0</code>, or <code>+1</code>. Your goal is to wipe the bottom
				<em>residual</em> grid completely clean while filling in as few pages as possible. Larger boards
				are harder to solve, but the reward is greater.
			</p>

			<h3>Controls</h3>
			<ul class="instr">
				<li>
					<strong>Click</strong> a cell to cycle <code>0 → +1 → −1 → 0</code>.
					<strong>Shift-click</strong>
					reverses; <strong>right-click</strong> resets to 0.
				</li>
				<li><strong>Click + drag</strong> rotates the 3D stack (flick to spin).</li>
				<li><strong>Scroll</strong> over a board to step through its rank pages.</li>
				<li>Click the small corner tab on a page to make it the active page.</li>
				<li>Use the tabs above the board to keep several puzzles open at once.</li>
			</ul>

			<h3>Why it matters</h3>
			<p class="meta-text">
				The schoolbook way to multiply two matrices uses <code>M·N·P</code> multiplications. In
				1969, Strassen showed that two <code>2×2</code> matrices need only <strong>7</strong>
				multiplications instead of the obvious <strong>8</strong> — a small win that compounds into
				a much faster algorithm at large scales. DeepMind's AlphaTensor recently used AI to find
				similar tricks for bigger matrices, using only <code>−1</code>, <code>0</code>, and
				<code>+1</code>. This game is a hands-on sandbox for that same search. It is called a
				<code>bilinear</code> algorithm because it is a generalization of matrix multiplication.
			</p>

			<h3>Scoring</h3>
			<p class="meta-text">
				Every page you fill in counts against you, and any leftover error in the residual grid adds
				to that tally. Fewer pages → faster algorithm → an exponentially bigger score. Doing worse
				than the schoolbook algorithm gives a negative score, down to
				<code>−1,000,000</code>.
			</p>
			<p class="meta-text">
				The <code>+1,000,000</code> ceiling sits at the conjectured asymptotic limit
				<code>ω = 2</code>, but no recursive base case can hit it exactly — divide-and-conquer adds
				a <code>log N</code> factor from the combine step that keeps the
				<em>effective</em> exponent slightly above 2. So the cap is approached, never reached;
				bigger <code>⟨m,n,p⟩</code> have shallower recursions and approach it more closely.
			</p>
			<p class="meta-text prize-note">
				<strong>Prize:</strong> if you achieve a score you believe is eligible for a prize, save
				your game to a file using the <strong>Save game…</strong> button and send it to the company linked
				at the bottom of the page.
			</p>

			<div class="dialog-actions">
				<button type="button" class="dialog-ok" onclick={closeHelp}>Got it</button>
			</div>
		</div>
	</dialog>

	<div class="tabbar" role="tablist" aria-label="Open puzzles">
		<div class="tabs">
			{#each tabs as t (t.id)}
				<div
					class="tab"
					class:active={t.id === activeId}
					class:solved={t.kind === 'game' && t.game.solved}
					class:leaderboard={t.kind === 'leaderboard'}
					role="tab"
					tabindex="0"
					aria-selected={t.id === activeId}
					title={tabLabel(t)}
					onclick={() => selectTab(t.id)}
					onkeydown={(e) => onTabKeydown(e, t.id)}
				>
					<span class="tab-label">{tabLabel(t)}</span>
					{#if t.kind !== 'leaderboard'}
						<button
							type="button"
							class="tab-close"
							aria-label="Close puzzle"
							title="Close puzzle"
							onclick={(e) => closeTab(t.id, e)}
						>
							×
						</button>
					{/if}
				</div>
			{/each}
		</div>
		<button
			type="button"
			class="tab-add"
			aria-label="New puzzle"
			title="New puzzle"
			onclick={addTab}
		>
			+
		</button>
	</div>

	{#key activeTab.id}
		{#if activeTab.kind === 'leaderboard'}
			<HighScoreBoard onPlay={openHighScore} onPlayUserScore={openUserScore} />
		{:else}
			<Game game={activeTab.game} />
		{/if}
	{/key}

	<footer class="site-footer">
		<span>A puzzle by</span>
		<a
			class="footer-link"
			href="https://jdbrinton.consulting"
			target="_blank"
			rel="noopener noreferrer"
		>
			JD Brinton Consulting
		</a>
		<span class="footer-sep" aria-hidden="true">·</span>
		<a
			class="footer-source"
			href="https://github.com/jdbconsulting/ai-sudoku"
			target="_blank"
			rel="noopener noreferrer"
			title="View source on GitHub"
		>
			<svg
				class="footer-source-icon"
				viewBox="0 0 16 16"
				width="14"
				height="14"
				aria-hidden="true"
				focusable="false"
			>
				<path
					fill="currentColor"
					d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
				/>
			</svg>
			<span>Source on GitHub</span>
		</a>
	</footer>
</div>

<style>
	.page {
		min-height: 100dvh;
		padding: 2rem clamp(0.875rem, 2vw, 1.75rem) 4rem;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		max-width: 1700px;
		margin: 0 auto;
		color: rgb(226 232 240);
	}

	.prize-stack {
		/* Fixed so the prizes stay visible while scrolling. Rendered outside
		   `.page` so the page's max-width / centering doesn't pull them off
		   the right edge on wide viewports. */
		position: fixed;
		top: 0.75rem;
		right: 0.75rem;
		z-index: 50;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.4rem;
		pointer-events: none;
		max-width: calc(100vw - 1.5rem);
	}
	.prize-banner {
		display: inline-flex;
		align-items: baseline;
		gap: 0.4rem;
		padding: 0.45rem 0.85rem;
		border-radius: 999px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.78rem;
		letter-spacing: 0.04em;
		color: rgb(15 23 42);
		box-shadow:
			0 6px 18px rgba(0, 0, 0, 0.35),
			0 0 0 1px oklch(0.95 0.12 90 / 0.35) inset;
		max-width: 100%;
	}
	.prize-banner.gold {
		background: linear-gradient(135deg, oklch(0.88 0.18 90), oklch(0.82 0.2 60));
		border: 1px solid oklch(0.55 0.16 70);
	}
	.prize-banner.silver {
		background: linear-gradient(135deg, oklch(0.92 0.02 250), oklch(0.78 0.03 250));
		border: 1px solid oklch(0.6 0.02 250);
		box-shadow:
			0 6px 18px rgba(0, 0, 0, 0.3),
			0 0 0 1px oklch(0.96 0.01 250 / 0.5) inset;
	}
	.prize-amount {
		font-weight: 800;
		font-size: 0.95rem;
		letter-spacing: 0.03em;
	}
	.prize-text {
		font-weight: 600;
	}
	@media (max-width: 540px) {
		/* On phones the fixed top-right banners overlap the header and help
		   button. Drop them out of the overlay layer and let them sit in
		   normal page flow instead — since the prize-stack precedes
		   `.page` in the DOM, they end up as a clean header strip without
		   obstructing anything underneath. */
		.prize-stack {
			position: static;
			align-items: stretch;
			max-width: none;
			gap: 0.3rem;
			padding: 0.55rem 0.6rem 0;
			pointer-events: auto;
		}
		.prize-banner {
			font-size: 0.7rem;
			padding: 0.35rem 0.65rem;
			justify-content: center;
		}
		.prize-amount {
			font-size: 0.82rem;
		}
		/* Tighten page gutters on phones so 240–280px-wide boards don't
		   need horizontal scrolling. The clamp() on desktop padding keeps
		   the wider rule untouched. */
		.page {
			padding: 0.6rem 0.6rem 3rem;
			gap: 1rem;
		}
	}

	.banner {
		text-align: center;
	}
	.brand {
		display: inline-flex;
		align-items: center;
		gap: 0.6rem;
		margin-bottom: 0.4rem;
	}
	.brand .logo {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 800;
		font-size: 1.2rem;
		letter-spacing: 0.06em;
		color: rgb(15 23 42);
		background: linear-gradient(135deg, oklch(0.85 0.18 145), oklch(0.78 0.18 230));
		padding: 0.15rem 0.55rem;
		border-radius: 6px;
	}
	.brand h1 {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 800;
		letter-spacing: 0.18em;
		font-size: clamp(1.6rem, 3vw, 2.4rem);
		margin: 0;
		background: linear-gradient(180deg, rgb(248 250 252), rgb(148 163 184));
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
	.tagline {
		max-width: 70ch;
		margin: 0.5rem auto;
		color: rgb(203 213 225);
	}
	.tagline code,
	.help-dialog code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: rgb(30 41 59);
		padding: 0 0.35em;
		border-radius: 4px;
		color: rgb(125 211 252);
	}
	.instr {
		max-width: 70ch;
		margin: 0.25rem auto 0;
		font-size: 0.85rem;
		color: rgb(148 163 184);
	}

	/* === Help button & dialog ============================================== */
	.help-btn {
		all: unset;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.6rem;
		height: 1.6rem;
		margin-left: 0.4rem;
		border-radius: 50%;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 800;
		font-size: 0.95rem;
		color: rgb(203 213 225);
		background: oklch(0.22 0.03 240 / 0.7);
		border: 1px solid rgb(51 65 85);
		cursor: pointer;
		transition:
			background-color 120ms ease,
			color 120ms ease,
			border-color 120ms ease;
	}
	.help-btn:hover {
		background: oklch(0.32 0.05 240 / 0.9);
		color: rgb(248 250 252);
		border-color: oklch(0.7 0.18 230);
	}
	.help-btn:focus-visible {
		outline: 2px solid oklch(0.7 0.18 230);
		outline-offset: 2px;
	}

	.help-dialog {
		/* Center on both axes. Native <dialog> in modal mode is position: fixed
		   with `margin: auto`; `inset: 0` lets margin: auto resolve vertically too. */
		inset: 0;
		margin: auto;
		padding: 0;
		border: 1px solid rgb(51 65 85);
		border-radius: 12px;
		background: oklch(0.16 0.02 240);
		color: rgb(226 232 240);
		max-width: min(90vw, 70ch);
		max-height: min(95vh, 60rem);
		width: 100%;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
		overflow: hidden;
	}
	.help-dialog::backdrop {
		background: rgba(2, 6, 23, 0.35);
	}
	.help-dialog-inner {
		padding: 1.5rem 1.75rem 1.25rem;
		max-height: inherit;
		overflow-y: auto;
		scrollbar-width: thin;
	}
	.help-dialog h2 {
		margin: 0 0 0.75rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 700;
		font-size: 1.1rem;
		letter-spacing: 0.06em;
		color: rgb(248 250 252);
	}
	.help-dialog h3 {
		margin: 1.1rem 0 0.4rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 700;
		font-size: 0.85rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: rgb(148 163 184);
	}
	.help-dialog .tagline,
	.help-dialog .instr,
	.help-dialog .meta-text {
		text-align: left;
		max-width: none;
		margin: 0 0 0.75rem;
	}
	.help-dialog .instr {
		font-size: 0.85rem;
		color: rgb(203 213 225);
		padding-left: 1.1rem;
		margin: 0 0 0.5rem;
	}
	.help-dialog .instr li {
		margin-bottom: 0.3rem;
	}
	.help-dialog .meta-text {
		font-size: 0.85rem;
		color: rgb(148 163 184);
	}
	.help-dialog em {
		color: rgb(203 213 225);
		font-style: italic;
	}
	.help-dialog .prize-note {
		/* Tinted callout that echoes the gold prize banner up top, so the two
		   feel like the same announcement. */
		margin-top: 0.5rem;
		padding: 0.55rem 0.75rem;
		border-radius: 8px;
		border: 1px solid oklch(0.55 0.16 70 / 0.6);
		background: oklch(0.3 0.08 70 / 0.25);
		color: rgb(226 232 240);
	}
	.help-dialog .prize-note strong {
		color: oklch(0.88 0.18 90);
	}

	.dialog-close {
		all: unset;
		position: absolute;
		top: 0.5rem;
		right: 0.6rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.6rem;
		height: 1.6rem;
		border-radius: 6px;
		font-size: 1.2rem;
		line-height: 1;
		color: rgb(148 163 184);
		background: oklch(0.16 0.02 240 / 0.8);
		cursor: pointer;
		z-index: 1;
	}
	.dialog-close:hover {
		background: oklch(0.62 0.22 25 / 0.25);
		color: oklch(0.85 0.18 25);
	}
	.dialog-close:focus-visible {
		outline: 2px solid oklch(0.7 0.18 230);
		outline-offset: 1px;
	}

	.dialog-actions {
		display: flex;
		justify-content: flex-end;
	}
	.dialog-ok {
		all: unset;
		padding: 0.4rem 0.9rem;
		border-radius: 8px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.8rem;
		letter-spacing: 0.06em;
		color: rgb(15 23 42);
		background: linear-gradient(135deg, oklch(0.85 0.18 145), oklch(0.78 0.18 230));
		cursor: pointer;
		font-weight: 700;
	}
	.dialog-ok:hover {
		filter: brightness(1.1);
	}
	.dialog-ok:focus-visible {
		outline: 2px solid oklch(0.7 0.18 230);
		outline-offset: 2px;
	}

	/* === Tab bar ============================================================ */
	.tabbar {
		display: flex;
		align-items: end;
		gap: 0.4rem;
		border-bottom: 1px solid rgb(30 41 59);
		padding: 0 0.25rem;
		margin-bottom: -0.5rem;
		overflow-x: auto;
		/* `overflow-x: auto` implicitly promotes overflow-y from `visible` to
		   `auto`, which then catches the 1px nudge from `.tab { top: 1px }`
		   and shows a useless vertical scrollbar. Pin it to `hidden`. */
		overflow-y: hidden;
		scrollbar-width: thin;
	}
	.tabs {
		display: flex;
		gap: 0.25rem;
		flex-wrap: nowrap;
	}
	.tab {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.45rem 0.6rem 0.45rem 0.85rem;
		background: oklch(0.16 0.02 240 / 0.5);
		border: 1px solid rgb(30 41 59);
		border-bottom: none;
		border-radius: 8px 8px 0 0;
		color: rgb(148 163 184);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.78rem;
		letter-spacing: 0.04em;
		cursor: pointer;
		user-select: none;
		white-space: nowrap;
		position: relative;
		top: 1px; /* sit on top of the bottom border */
		transition:
			background-color 120ms ease,
			color 120ms ease,
			border-color 120ms ease;
	}
	.tab:hover {
		background: oklch(0.22 0.03 240 / 0.7);
		color: rgb(203 213 225);
	}
	.tab.active {
		background: oklch(0.16 0.02 240 / 0.9);
		border-color: rgb(51 65 85);
		color: rgb(248 250 252);
		box-shadow: 0 -2px 0 0 oklch(0.7 0.18 230) inset;
	}
	.tab.solved .tab-label {
		color: oklch(0.85 0.2 145);
	}
	.tab.leaderboard {
		/* Pinned tab — slightly warmer background and a small left padding bump
		   to make the trophy emoji breathe. The lack of a close × also visually
		   distinguishes it from regular puzzle tabs. */
		padding-left: 0.95rem;
		padding-right: 0.95rem;
		background: oklch(0.18 0.04 70 / 0.45);
		border-color: oklch(0.35 0.06 70);
		color: oklch(0.85 0.12 70);
	}
	.tab.leaderboard:hover {
		background: oklch(0.24 0.06 70 / 0.7);
		color: oklch(0.92 0.14 70);
	}
	.tab.leaderboard.active {
		background: oklch(0.2 0.05 70 / 0.85);
		border-color: oklch(0.55 0.12 70);
		color: oklch(0.95 0.16 70);
		box-shadow: 0 -2px 0 0 oklch(0.78 0.18 70) inset;
	}
	.tab:focus-visible {
		outline: 2px solid oklch(0.7 0.18 230);
		outline-offset: 2px;
	}
	.tab-label {
		pointer-events: none;
	}
	.tab-close {
		all: unset;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.25rem;
		height: 1.25rem;
		border-radius: 4px;
		font-size: 1rem;
		line-height: 1;
		color: rgb(100 116 139);
		cursor: pointer;
	}
	.tab-close:hover {
		background: oklch(0.62 0.22 25 / 0.25);
		color: oklch(0.78 0.18 25);
	}
	.tab-close:focus-visible {
		outline: 2px solid oklch(0.7 0.18 230);
		outline-offset: 1px;
	}
	.tab-add {
		all: unset;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 8px 8px 0 0;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 1.1rem;
		color: rgb(148 163 184);
		background: transparent;
		border: 1px dashed rgb(51 65 85);
		border-bottom: none;
		cursor: pointer;
		margin-left: 0.25rem;
		position: relative;
		top: 1px;
	}
	.tab-add:hover {
		background: oklch(0.22 0.03 240 / 0.7);
		color: rgb(248 250 252);
		border-style: solid;
	}
	.tab-add:focus-visible {
		outline: 2px solid oklch(0.7 0.18 230);
		outline-offset: 2px;
	}

	/* === Footer ============================================================ */
	.site-footer {
		/* `margin-top: auto` pushes us to the very bottom of the flex column —
		   the `.page` container is at least 100dvh tall, so on short pages the
		   footer still parks against the bottom instead of floating mid-screen. */
		margin-top: auto;
		padding-top: 2rem;
		display: flex;
		justify-content: center;
		align-items: baseline;
		gap: 0.4rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.78rem;
		letter-spacing: 0.04em;
		color: rgb(100 116 139);
		border-top: 1px solid rgb(30 41 59);
	}
	.footer-link {
		color: rgb(203 213 225);
		text-decoration: none;
		font-weight: 700;
		background: linear-gradient(135deg, oklch(0.85 0.18 145), oklch(0.78 0.18 230));
		-webkit-background-clip: text;
		background-clip: text;
		-webkit-text-fill-color: transparent;
		transition: filter 120ms ease;
	}
	.footer-link:hover {
		filter: brightness(1.15);
		text-decoration: underline;
		text-decoration-color: oklch(0.78 0.18 230);
		text-underline-offset: 3px;
	}
	.footer-link:focus-visible {
		outline: 2px solid oklch(0.7 0.18 230);
		outline-offset: 3px;
		border-radius: 2px;
	}
	.footer-sep {
		color: rgb(71 85 105);
	}
	.footer-source {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		color: rgb(148 163 184);
		text-decoration: none;
		transition: color 120ms ease;
	}
	.footer-source:hover {
		color: rgb(226 232 240);
		text-decoration: underline;
		text-underline-offset: 3px;
	}
	.footer-source:focus-visible {
		outline: 2px solid oklch(0.7 0.18 230);
		outline-offset: 3px;
		border-radius: 2px;
	}
	.footer-source-icon {
		flex-shrink: 0;
		position: relative;
		top: 1.5px;
	}
</style>
