<script lang="ts">
	// Permanent "How to play" tab. This used to be a `<dialog>` that
	// auto-opened (`showModal`) on every page load via a `$effect` in
	// `+page.svelte`; the auto-popping was annoying on every reload, so
	// we converted the same content to a regular tab that the player
	// can visit on demand and dismiss simply by clicking another tab.
	// Keeping the markup + styles inside this component (rather than
	// scattering them across `+page.svelte`) means the help content
	// owns its own CSS scope — no more `.help-dialog .tagline`-style
	// selectors leaking out of the dialog wrapper that no longer
	// exists.

	// Sits as the *first* (default) tab in the bar, so a visitor who
	// just landed on the page sees the tutorial. Once they've read it,
	// the CTAs at the top point them at the leaderboard, the size picker,
	// or straight into ⟨3,3,3⟩ with the classical alphabet.

	type Props = {
		// Called when the player clicks the "🏆 High Score Board"
		// CTA. Parent (`+page.svelte`) resolves this to
		// `selectTab(LEADERBOARD_ID)` so the tab-bar state stays the
		// single source of truth for navigation.
		onOpenLeaderboard: () => void;
		// Called when the player clicks the "+ New Game" CTA.
		// Resolved to `selectTab(NEW_GAME_ID)` upstream.
		onOpenNewGame: () => void;
		// Spawn ⟨3,3,3⟩ with {−1, 0, +1} and switch to that game tab.
		onQuickPlay: () => void;
	};

	let { onOpenLeaderboard, onOpenNewGame, onQuickPlay }: Props = $props();
</script>

<section class="help card">
	<h2 class="cta-heading">Ready to play?</h2>
	<div class="ctas">
		<button class="cta cta-leaderboard" type="button" onclick={onOpenLeaderboard}>
			<span class="cta-title">🏆 High Score Board</span>
			<span class="cta-sub">Browse top scores and replay famous algorithms</span>
			<span class="cta-arrow" aria-hidden="true">→</span>
		</button>
		<button class="cta cta-newgame" type="button" onclick={onOpenNewGame}>
			<span class="cta-title">+ New Game</span>
			<span class="cta-sub">Pick a board size and start a fresh puzzle</span>
			<span class="cta-arrow" aria-hidden="true">→</span>
		</button>
		<button class="cta cta-quickplay" type="button" onclick={onQuickPlay}>
			<span class="cta-title">Quick Play</span>
			<span class="cta-sub">Start ⟨3,3,3⟩ with <code>{`{−1, 0, +1}`}</code></span>
			<span class="cta-arrow" aria-hidden="true">→</span>
		</button>
	</div>
	<br />
	<h2 id="help-title">How to play</h2>
	<p class="tagline">
		Help make AI better by inventing a new algorithm! When you play this game and achieve a new
		high score, you have discovered a new algorithm that will directly improve the performance of
		AI. Each puzzle gives you a single board with three sub-grids —
		<code>A</code> (bottom-left), <code>B</code> (top-right), and <code>C</code> (bottom-right) —
		laid out so the shared dimensions of an <code>A·B = C</code> matrix multiplication line up
		edge-to-edge. Fill in cells from the puzzle's alphabet — the classical default is
		<code>{`{−1, 0, +1}`}</code>, but the New Game tab lets you pick a wider one. Your goal is to
		wipe the bottom <em>residual</em> grid completely clean while filling in as few pages as
		possible. Larger boards are harder to solve, but the reward is greater.
	</p>

	<h3>Controls</h3>
	<ul class="instr">
		<li>
			<strong>Click</strong> a cell to cycle through the puzzle's alphabet.
			<strong>Shift-click</strong> reverses; <strong>right-click</strong> resets to 0.
		</li>
		<li><strong>Click + drag</strong> rotates the 3D stack (flick to spin).</li>
		<li><strong>Scroll</strong> over the board to step through its rank pages.</li>
		<li>Click the small corner tab on a page to make it the active page.</li>
		<li>Use the tabs above the board to keep several puzzles open at once.</li>
	</ul>

	<h3>Why it matters</h3>
	<p class="meta-text">
		The schoolbook way to multiply two matrices uses <code>M·N·P</code> multiplications. In 1969,
		Strassen showed that two <code>2×2</code> matrices need only <strong>7</strong> multiplications
		instead of the obvious <strong>8</strong> — a small win that compounds into a much faster
		algorithm at large scales. DeepMind's AlphaTensor and the Moosbauer-Poole / Kauers-Wood
		flip-graph results have recently extended this kind of trick to bigger matrices, mostly with
		small integer entries. This game is a hands-on sandbox for that same search. It is called a
		<code>bilinear</code> algorithm because it is a generalization of matrix multiplication.
	</p>

	<h3>Scoring</h3>
	<p class="meta-text">
		Every page you fill in counts against you, and any leftover error in the residual grid adds to
		that tally. Fewer pages → faster algorithm → an exponentially bigger score. Doing worse than
		the schoolbook algorithm gives a negative score, down to
		<code>−1,000,000</code>.
	</p>
	<p class="meta-text">
		The <code>+1,000,000</code> ceiling sits at the conjectured asymptotic limit
		<code>ω = 2</code>, but no recursive base case can hit it exactly — divide-and-conquer adds a
		<code>log N</code> factor from the combine step that keeps the
		<em>effective</em> exponent slightly above 2. So the cap is approached, never reached; bigger
		<code>⟨m,n,p⟩</code> have shallower recursions and approach it more closely.
	</p>
	<p class="meta-text">
		Concretely, here is the maximum rank <code>R</code> you can land at on a few small cube boards
		and still clear each prize tier (assuming a fully-solved residual). Smaller boards are tougher:
		the integer rank ladder is short, so each step you save matters more.
	</p>
	<!--
		Silver column thresholds correspond to score ≥ 83 (≈ ω ≤ 2.68);
		the threshold was deliberately tuned so a ⟨3,3,3⟩ rank-19
		algorithm — Bläser's proven lower bound, but unknown whether
		any explicit ±1/0 algorithm achieves it — would land exactly on
		the prize boundary. Gold thresholds correspond to score ≥ 1,000
		(ω ≤ 2.5) and are unchanged.

		For each board, the displayed R is the largest integer rank
		that still clears the tier when plugged through `computeScore(
		computeOmega(m, n, p, R))` from `tensor.ts`. Anything below
		Hopcroft & Kerr's lower bound (rank 7 for ⟨2,2,2⟩, rank 19 for
		⟨3,3,3⟩ thanks to Bläser, etc.) carries a `proven impossible`
		annotation so players know not to chase a closed door.
	-->
	<table class="prize-table">
		<thead>
			<tr>
				<th>Board</th>
				<th>US$1,000 (score ≥ 83)</th>
				<th>US$10,000 (score ≥ 1,000)</th>
				<th>For reference</th>
			</tr>
		</thead>
		<tbody>
			<tr>
				<td><code>⟨2,2,2⟩</code></td>
				<td>
					<code>R ≤ 6</code>
					<div class="impossible">(proven impossible)</div>
				</td>
				<td>
					<code>R ≤ 5</code>
					<div class="impossible">(proven impossible)</div>
				</td>
				<td>Strassen <code>R = 7</code> (score 14)</td>
			</tr>
			<tr>
				<td><code>⟨3,3,3⟩</code></td>
				<td>
					<code>R ≤ 19</code>
					<div class="open">(now open to prize!)</div>
				</td>
				<td>
					<code>R ≤ 15</code>
					<div class="impossible">(proven impossible)</div>
				</td>
				<td>Schoolbook <code>R = 27</code></td>
			</tr>
			<tr>
				<td><code>⟨4,4,4⟩</code></td>
				<td><code>R ≤ 41</code></td>
				<td><code>R ≤ 32</code></td>
				<td>AlphaTensor <code>R = 49</code> (score 14)</td>
			</tr>
			<tr>
				<td><code>⟨5,5,5⟩</code></td>
				<td><code>R ≤ 74</code></td>
				<td><code>R ≤ 55</code></td>
				<td>Schoolbook <code>R = 125</code></td>
			</tr>
		</tbody>
	</table>
	<p class="meta-text prize-note">
		<strong>Prize:</strong> if you achieve a score you believe is eligible for a prize, save your
		game to a file using the <strong>Save game…</strong> button and send it to the company linked
		at the bottom of the page.
	</p>
</section>

<style>
	.help {
		background: oklch(0.16 0.02 240 / 0.7);
		border: 1px solid rgb(30 41 59);
		border-radius: 14px;
		padding: 1.5rem 1.75rem;
		backdrop-filter: blur(6px);
		max-width: 80ch;
		margin: 0 auto;
		color: rgb(226 232 240);
	}
	.help code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: rgb(30 41 59);
		padding: 0 0.35em;
		border-radius: 4px;
		color: rgb(125 211 252);
	}
	h2 {
		margin: 0 0 0.75rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 700;
		font-size: 1.1rem;
		letter-spacing: 0.06em;
		color: rgb(248 250 252);
	}
	h3 {
		margin: 1.1rem 0 0.4rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 700;
		font-size: 0.85rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: rgb(148 163 184);
	}
	.tagline,
	.meta-text {
		margin: 0 0 0.75rem;
		font-size: 0.85rem;
		line-height: 1.55;
		color: rgb(148 163 184);
		text-align: left;
	}
	.tagline {
		color: rgb(203 213 225);
	}
	.instr {
		font-size: 0.85rem;
		color: rgb(203 213 225);
		padding-left: 1.1rem;
		margin: 0 0 0.5rem;
	}
	.instr li {
		margin-bottom: 0.3rem;
	}
	em {
		color: rgb(203 213 225);
		font-style: italic;
	}
	.prize-note {
		/* Tinted callout that echoes the gold prize banner up top, so the
		   two feel like the same announcement. */
		margin-top: 0.5rem;
		padding: 0.55rem 0.75rem;
		border-radius: 8px;
		border: 1px solid oklch(0.55 0.16 70 / 0.6);
		background: oklch(0.3 0.08 70 / 0.25);
		color: rgb(226 232 240);
	}
	.prize-note strong {
		color: oklch(0.88 0.18 90);
	}

	.prize-table {
		width: 100%;
		margin: 0.6rem 0;
		border-collapse: collapse;
		font-size: 0.8rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		color: rgb(203 213 225);
	}
	.prize-table th,
	.prize-table td {
		padding: 0.4rem 0.6rem;
		text-align: left;
		border-bottom: 1px solid rgb(30 41 59);
	}
	.prize-table th {
		font-weight: 600;
		color: rgb(148 163 184);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		font-size: 0.7rem;
		border-bottom-color: rgb(51 65 85);
	}
	.prize-table tbody tr:last-child td {
		border-bottom: none;
	}
	.prize-table code {
		color: rgb(125 211 252);
	}
	.prize-table .impossible {
		/* Red, slightly smaller annotation that sits under the rank cell.
		   Matches the negative-score red used elsewhere (oklch 0.7 0.22 25)
		   so "proven impossible" reads as a hard-stop signal. */
		margin-top: 0.15rem;
		font-size: 0.65rem;
		color: oklch(0.7 0.22 25);
		letter-spacing: 0.02em;
	}
	.prize-table .open {
		/* Counterpart to `.impossible`: same size and placement, but
		   tinted teal/green to read as "open problem, theoretically
		   winnable" rather than "stop, don't bother". Used on the
		   ⟨3,3,3⟩ silver-tier cell (R ≤ 19) since 19 sits right at
		   Bläser's proven lower bound — no algorithm can do better,
		   but whether *any* explicit rank-19 algorithm exists is
		   still wide open. The teal echoes the New Game tab's accent
		   so the cell visually rhymes with the ⟨3,3,3⟩ preset
		   description over there, where the same lower bound is
		   discussed at length. */
		margin-top: 0.15rem;
		font-size: 0.65rem;
		color: oklch(0.78 0.14 175);
		letter-spacing: 0.02em;
		font-weight: 600;
	}

	.cta-heading {
		/* Uses the same uppercase ui-mono section heading look as the
		   "Controls" / "Why it matters" / "Scoring" sections above so
		   the CTAs read as one more part of the help flow rather than
		   bolted-on chrome. */
		margin-top: 1.4rem;
	}
	.ctas {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
		margin: 0.4rem 0 0.2rem;
	}
	.cta {
		/* Card-style call-to-action button. Each CTA borrows the
		   accent palette of the destination tab (gold for leaderboard,
		   teal for new game) so the colour choice itself signals
		   where the click will land you, mirroring the same tints on
		   `.tab.leaderboard` and `.tab.newgame` in `+page.svelte`. */
		display: grid;
		grid-template-columns: 1fr auto;
		grid-template-rows: auto auto;
		grid-template-areas:
			'title arrow'
			'sub arrow';
		row-gap: 0.2rem;
		column-gap: 0.6rem;
		align-items: center;
		text-align: left;
		padding: 0.85rem 1rem;
		border-radius: 10px;
		border: 1px solid rgb(51 65 85);
		background: oklch(0.18 0.02 240 / 0.7);
		color: rgb(226 232 240);
		font-family: inherit;
		cursor: pointer;
		transition: filter 120ms ease, transform 120ms ease, border-color 120ms ease,
			background-color 120ms ease;
	}
	.cta:hover {
		filter: brightness(1.1);
		border-color: rgb(100 116 139);
	}
	.cta:active {
		transform: translateY(1px);
	}
	.cta:focus-visible {
		outline: 2px solid oklch(0.7 0.18 230);
		outline-offset: 2px;
	}
	.cta-title {
		grid-area: title;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 700;
		font-size: 1.05rem;
		letter-spacing: 0.04em;
	}
	.cta-sub {
		grid-area: sub;
		font-size: 0.78rem;
		color: rgb(148 163 184);
		line-height: 1.35;
	}
	.cta-arrow {
		grid-area: arrow;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 1.5rem;
		font-weight: 700;
		color: inherit;
		opacity: 0.65;
		transition: transform 120ms ease, opacity 120ms ease;
	}
	.cta:hover .cta-arrow {
		transform: translateX(3px);
		opacity: 1;
	}
	.cta-leaderboard {
		background: oklch(0.22 0.05 70 / 0.6);
		border-color: oklch(0.4 0.08 70);
		color: oklch(0.92 0.14 70);
	}
	.cta-leaderboard:hover {
		background: oklch(0.28 0.07 70 / 0.8);
		border-color: oklch(0.6 0.14 70);
	}
	.cta-leaderboard .cta-sub {
		color: oklch(0.78 0.06 70);
	}
	.cta-newgame {
		background: oklch(0.22 0.05 175 / 0.6);
		border-color: oklch(0.4 0.08 175);
		color: oklch(0.92 0.14 175);
	}
	.cta-newgame:hover {
		background: oklch(0.28 0.07 175 / 0.8);
		border-color: oklch(0.6 0.14 175);
	}
	.cta-newgame .cta-sub {
		color: oklch(0.78 0.06 175);
	}
	.cta-quickplay {
		grid-column: 1 / -1;
		background: oklch(0.22 0.05 250 / 0.55);
		border-color: oklch(0.42 0.1 250);
		color: oklch(0.92 0.08 250);
	}
	.cta-quickplay:hover {
		background: oklch(0.28 0.06 250 / 0.75);
		border-color: oklch(0.55 0.14 250);
	}
	.cta-quickplay .cta-sub {
		color: oklch(0.8 0.06 250);
	}
	.cta-quickplay .cta-sub code {
		background: oklch(0.26 0.04 250 / 0.8);
		color: oklch(0.85 0.12 230);
	}

	@media (max-width: 640px) {
		.help {
			padding: 1rem 0.85rem;
		}
		.prize-table {
			font-size: 0.72rem;
		}
		.prize-table th,
		.prize-table td {
			padding: 0.35rem 0.4rem;
		}
		.ctas {
			/* Stack CTAs vertically on phones so each button can
			   stretch to full width and the title/subtitle don't
			   wrap awkwardly inside a half-screen card. */
			grid-template-columns: 1fr;
		}
	}
</style>
