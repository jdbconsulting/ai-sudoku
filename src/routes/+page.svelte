<script lang="ts">
	import Game from '$lib/sudoku/Game.svelte';
	import HighScoreBoard from '$lib/sudoku/HighScoreBoard.svelte';
	import NewGameTab from '$lib/sudoku/NewGameTab.svelte';
	import HelpTab from '$lib/sudoku/HelpTab.svelte';
	import { GameState } from '$lib/sudoku/state.svelte';
	import { DEFAULT_ALPHABET, type Alphabet } from '$lib/sudoku/alphabets';
	import type { HighScore } from '$lib/sudoku/highscores';
	import type { FullScore } from '$lib/sudoku/leaderboard';
	import { logGameStarted } from '$lib/sudoku/analytics';

	// Four flavours of tab, all in one tab-bar:
	//   * one permanent leaderboard tab (`LEADERBOARD_ID`) on the far
	//     left — can't be closed, opens the high-score board;
	//   * one permanent "New Game" tab (`NEW_GAME_ID`) — also can't
	//     be closed, hosts the size-picker + presets UI that used to
	//     live inside `Game.svelte`;
	//   * one permanent "How to play" tab (`HELP_ID`) — used to be
	//     a `<dialog>` that auto-popped on every page load, which
	//     was annoying. Now it's just a tab the user opens on demand;
	//   * any number of regular game tabs the user opens by clicking
	//     a preset on the New Game tab or a Play button on the
	//     leaderboard.
	// Discriminated unions keep the rendering and tab-bar logic
	// honest about which is which.
	const LEADERBOARD_ID = 0;
	const NEW_GAME_ID = -1;
	const HELP_ID = -2;
	type LeaderboardTab = { kind: 'leaderboard'; id: typeof LEADERBOARD_ID };
	type NewGameTabState = { kind: 'newGame'; id: typeof NEW_GAME_ID };
	type HelpTabState = { kind: 'help'; id: typeof HELP_ID };
	type GameTab = { kind: 'game'; id: number; game: GameState };
	type Tab = LeaderboardTab | NewGameTabState | HelpTabState | GameTab;

	let nextId = 1;
	// Factory for in-progress puzzle tabs. Renamed from the
	// historical `newGameTab` so the function name doesn't clash
	// with the imported `NewGameTab` Svelte component (which is the
	// permanent picker tab, not a game). Defaulting to ⟨2,2,2⟩ +
	// {−1, 0, +1} keeps the legacy callers in `openHighScore` /
	// `openUserScore` working — those overwrite the boards (and the
	// alphabet, where relevant) immediately afterwards anyway.
	function makeGameTab(
		m = 2,
		n = 2,
		p = 2,
		alphabet: Alphabet = DEFAULT_ALPHABET
	): GameTab {
		return { kind: 'game', id: nextId++, game: new GameState(m, n, p, alphabet) };
	}

	const leaderboardTab: LeaderboardTab = { kind: 'leaderboard', id: LEADERBOARD_ID };
	const newGameTab: NewGameTabState = { kind: 'newGame', id: NEW_GAME_ID };
	const helpTab: HelpTabState = { kind: 'help', id: HELP_ID };

	// Tab order: help, leaderboard, new game, then any open puzzles.
	// Help sits first and is the default landing tab so first-time
	// visitors see "How to play" by default — replicating what the
	// old auto-popping help dialog did, but as an inline tab they
	// can dismiss with a single click on a different tab. The CTA
	// buttons inside HelpTab itself (which call back to `selectTab`
	// below) point users straight at the leaderboard or the new-game
	// picker once they're done reading.
	let tabs = $state<Tab[]>([helpTab, leaderboardTab, newGameTab]);
	let activeId = $state<number>(HELP_ID);

	let activeTab = $derived(tabs.find((t) => t.id === activeId) ?? tabs[0]);

	const tabScoreFmt = new Intl.NumberFormat('en-US');
	function tabLabel(t: Tab): string {
		if (t.kind === 'leaderboard') return '🏆 High Score Board';
		if (t.kind === 'newGame') return '+ New Game';
		if (t.kind === 'help') return '❓ How to play';
		const g = t.game;
		const star = g.solved ? ' ★' : '';
		const s = Number.isFinite(g.score) ? tabScoreFmt.format(g.score) : '—';
		return `⟨${g.m},${g.n},${g.p}⟩  ${s}${star}`;
	}

	function createGameFromConfig(m: number, n: number, p: number, alphabet: Alphabet) {
		// Driven by the New Game tab's preset / custom-size buttons.
		// Always spawns a *fresh* game tab and switches to it so the
		// New Game tab itself stays focused on configuration; existing
		// in-progress puzzles in other tabs are never disturbed.
		const t = makeGameTab(m, n, p, alphabet);
		tabs.push(t);
		activeId = t.id;
		// Logging here (rather than inside `makeGameTab`) keeps the
		// 'famous' / 'replay' paths from double-counting: those
		// construct a tab and then immediately overwrite the boards,
		// so they each emit their own dedicated event.
		logGameStarted(m, n, p, 'new');
	}

	function loadSavedGame(data: unknown) {
		// Driven by the "Saved games" picker in the New Game tab —
		// both the browser-storage rows and the legacy "Load from
		// file…" button funnel into this single entry point. Same
		// non-destructive policy as the other launchers: we always
		// spawn a *fresh* game tab so the user's in-flight puzzles
		// in other tabs are never overwritten.
		//
		// `loadSolutionJSON` parses + validates the payload first
		// and throws on schema mismatch. We construct the tab
		// upfront but only register it on success — that keeps a
		// failed load from leaving a phantom tab behind, and the
		// thrown error bubbles back to the New Game tab where it's
		// rendered next to the picker.
		const t = makeGameTab();
		t.game.loadSolutionJSON(data);
		tabs.push(t);
		activeId = t.id;
		logGameStarted(t.game.m, t.game.n, t.game.p, 'saved');
	}

	function openHighScore(entry: HighScore) {
		// Each Play click spawns a fresh tab so the leaderboard works as a
		// non-destructive launcher — the user's other in-progress puzzles
		// are never overwritten. `entry.apply()` resets the alphabet to
		// the default {−1, 0, +1} since every shipped Famous Algorithm
		// (Strassen, Laderman, AlphaTensor) was authored in that world.
		const t = makeGameTab();
		entry.apply(t.game);
		tabs.push(t);
		activeId = t.id;
		logGameStarted(t.game.m, t.game.n, t.game.p, 'famous');
	}

	function openUserScore(entry: FullScore) {
		// Same non-destructive policy as openHighScore: every replay
		// click gets its own tab. The HighScoreBoard already awaited
		// the API fetch, so by the time we get here the boards are in
		// hand and applying them is synchronous. Pre-feature rows
		// (missing `alphabet`) fall through to the default {−1, 0, +1}.
		const alphabet =
			entry.alphabet && entry.alphabet.length > 0 ? entry.alphabet : DEFAULT_ALPHABET;
		const t = makeGameTab(entry.m, entry.n, entry.p, alphabet);
		t.game.loadFlatBoards(entry.m, entry.n, entry.p, entry.A, entry.B, entry.C, alphabet);
		tabs.push(t);
		activeId = t.id;
		logGameStarted(entry.m, entry.n, entry.p, 'replay');
	}

	function closeTab(id: number, event?: Event) {
		event?.stopPropagation();
		// All three pinned tabs (leaderboard, New Game, How to play)
		// are permanent: ignore any close attempt that somehow targets
		// them (the close button isn't even rendered on those tabs,
		// but defence-in-depth is cheap).
		if (id === LEADERBOARD_ID || id === NEW_GAME_ID || id === HELP_ID) return;
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
		<span class="prize-text">prize for first score ≥ 1,000 (ω ≤ 2.5)!</span>
	</div>
	<!-- Silver tier deliberately set so that *somebody who finds the
	     <3,3,3> rank-19 algorithm Bläser proved must exist (R ≥ 19
	     lower bound) wins the prize* — that algorithm scores exactly
	     83 in the live scoreboard pipeline (`computeScore(computeOmega(
	     3,3,3, 19))` = 83), so the threshold is tuned to exactly that
	     value rather than the round-number 100 we used before.
	     The omega annotation `ω ≤ 2.68` is the rounded boundary of
	     `score ≥ 83` (precise threshold ≈ 2.6806; we round *down* to
	     2.68 so the printed bound is conservative — anything strictly
	     ≤ 2.68 definitely scores ≥ 83). -->
	<div class="prize-banner silver" title="First player to score 83 or higher wins US$1,000">
		<span class="prize-amount">US$1,000</span>
		<span class="prize-text">prize for first score ≥ 83 (ω ≤ 2.68)!</span>
	</div>
</div>

<div class="page">
	<header class="banner">
		<div class="brand">
			<span class="logo">AI</span>
			<h1>SUDOKU</h1>
		</div>
	</header>

	<div class="tabbar" role="tablist" aria-label="Open puzzles">
		<div class="tabs">
			{#each tabs as t (t.id)}
				<div
					class="tab"
					class:active={t.id === activeId}
					class:solved={t.kind === 'game' && t.game.solved}
					class:leaderboard={t.kind === 'leaderboard'}
					class:newgame={t.kind === 'newGame'}
					class:help={t.kind === 'help'}
					role="tab"
					tabindex="0"
					aria-selected={t.id === activeId}
					title={tabLabel(t)}
					onclick={() => selectTab(t.id)}
					onkeydown={(e) => onTabKeydown(e, t.id)}
				>
					<span class="tab-label">{tabLabel(t)}</span>
					{#if t.kind === 'game'}
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
		<!-- The old "+ New puzzle" button used to live here. With the
		     permanent "+ New Game" tab now sitting next to the
		     leaderboard, a separate "+" button would just duplicate
		     that affordance, so we removed it. Anyone arriving via
		     muscle memory just clicks the New Game tab instead. -->
	</div>

	{#key activeTab.id}
		{#if activeTab.kind === 'leaderboard'}
			<HighScoreBoard onPlay={openHighScore} onPlayUserScore={openUserScore} />
		{:else if activeTab.kind === 'newGame'}
			<NewGameTab onCreate={createGameFromConfig} onLoad={loadSavedGame} />
		{:else if activeTab.kind === 'help'}
			<HelpTab
				onOpenLeaderboard={() => selectTab(LEADERBOARD_ID)}
				onOpenNewGame={() => selectTab(NEW_GAME_ID)}
			/>
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
		/* On phones the fixed top-right banners would overlap the brand
		   header. Drop them out of the overlay layer and let them sit in
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
		   the wider rule untouched. `overflow-x: clip` is a final
		   safeguard so any stray child overflow (e.g. a momentarily
		   oversized canvas) never produces a horizontal scrollbar.
		   The bottom padding clears the mobile score bar (≈3rem,
		   `position: fixed` from Game.svelte) plus the iOS
		   home-indicator inset so the footer never disappears under
		   it. The residual panel itself flows in normal page order
		   on mobile — no offset is needed for it. */
		.page {
			padding: 0.6rem 0.6rem calc(3rem + env(safe-area-inset-bottom, 0px));
			gap: 1rem;
			overflow-x: clip;
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
	/* The help content has its own component (`HelpTab.svelte`) with
	   self-scoped styles — `.tagline`, `.instr`, `.meta-text`, the
	   prize table, and so on all live there now. The help button in
	   the brand banner and the modal dialog wrapper are gone, since
	   "How to play" is reachable as a regular tab next to New Game. */

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
	.tab.newgame {
		/* Twin pinned tab to the leaderboard, but tinted teal/green so
		   "create" reads as visually distinct from "review" without
		   either fighting the surrounding game tabs. Same padding bump
		   as the leaderboard so the leading "+" glyph and "New Game"
		   label have similar breathing room as the trophy. */
		padding-left: 0.95rem;
		padding-right: 0.95rem;
		background: oklch(0.2 0.04 175 / 0.45);
		border-color: oklch(0.35 0.06 175);
		color: oklch(0.85 0.12 175);
	}
	.tab.newgame:hover {
		background: oklch(0.26 0.06 175 / 0.7);
		color: oklch(0.92 0.14 175);
	}
	.tab.newgame.active {
		background: oklch(0.22 0.05 175 / 0.85);
		border-color: oklch(0.55 0.12 175);
		color: oklch(0.95 0.16 175);
		box-shadow: 0 -2px 0 0 oklch(0.78 0.18 175) inset;
	}
	.tab.help {
		/* Third pinned tab in a sky-blue tint so the trio (gold
		   leaderboard, teal new-game, blue help) reads as a coherent
		   navigation strip distinct from the user's open puzzles. The
		   blue echoes the focus outline / `code` callout colour used
		   throughout the help body so the tab and its contents feel
		   like one unit. */
		padding-left: 0.95rem;
		padding-right: 0.95rem;
		background: oklch(0.2 0.04 230 / 0.45);
		border-color: oklch(0.35 0.06 230);
		color: oklch(0.85 0.1 230);
	}
	.tab.help:hover {
		background: oklch(0.26 0.06 230 / 0.7);
		color: oklch(0.92 0.12 230);
	}
	.tab.help.active {
		background: oklch(0.22 0.05 230 / 0.85);
		border-color: oklch(0.55 0.12 230);
		color: oklch(0.95 0.14 230);
		box-shadow: 0 -2px 0 0 oklch(0.78 0.18 230) inset;
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
