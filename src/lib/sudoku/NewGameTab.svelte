<script lang="ts">
	// Permanent "New Game" tab in the tab bar. Plays the same role the
	// "+" button used to: every click here spawns a fresh `GameState`
	// inside a brand-new game tab and switches to it. Unlike the old
	// "+" button, the player picks the dimensions up-front (custom or
	// preset) and gets a paragraph of historical context next to each
	// preset so the choice isn't blind. The active game tabs no longer
	// carry their own size config; resizing means starting a new game,
	// which keeps existing in-progress puzzles in their own tabs
	// instead of clobbering them on every dimension change.

	import {
		ALPHABET_PRESETS,
		type Alphabet,
		type AlphabetPreset,
		type AlphabetTier
	} from './alphabets';

	type Props = {
		// Called with the player's chosen ⟨m, n, p⟩ and the alphabet
		// they picked above (or the default {−1, 0, +1}). The parent
		// (`+page.svelte`) is responsible for actually constructing
		// the `GameState`, pushing the tab, and switching focus —
		// keeping that logic in one place lets the tab routing and
		// telemetry stay coherent with the leaderboard's
		// `onPlay`/`onPlayUserScore` paths.
		onCreate: (m: number, n: number, p: number, alphabet: Alphabet) => void;
	};

	let { onCreate }: Props = $props();

	// Selected alphabet. Defaults to the classical {−1, 0, +1} so a
	// player who never touches the picker gets the historical game
	// experience. Stored as the preset id rather than the values list
	// so reactivity tracks a stable primitive — the actual values are
	// fished out of `ALPHABET_PRESETS` when we need to apply them.
	let alphabetId = $state<string>('pm1');
	let selectedAlphabet = $derived<AlphabetPreset>(
		ALPHABET_PRESETS.find((a) => a.id === alphabetId) ?? ALPHABET_PRESETS[0]
	);

	// Split the catalogue into the three tiers the picker renders as
	// stacked single-column boxes (Standard → Uncommon → Advanced). Each
	// tier becomes its own labelled fieldset so the visual grouping
	// matches the conceptual one: the historical default at top, the
	// Boolean simplification right below it, then the wider
	// experimental alphabets at the bottom.
	type TierRow = { id: AlphabetTier; legend: string; hint: string };
	const TIERS: ReadonlyArray<TierRow> = [
		{
			id: 'standard',
			legend: 'Standard',
			hint: 'Classical alphabet — every famous matmul algorithm (Strassen, Laderman, AlphaTensor) lives in here.'
		},
		{
			id: 'uncommon',
			legend: 'Uncommon',
			hint: 'Boolean-only world. Cells are either off (0) or on (+1); residual cells can only grow positive.'
		},
		{
			id: 'advanced',
			legend: 'Advanced',
			hint: 'Wider coefficient worlds — products of cell values span half-integers or |v|>1, and the residual can take |Γ|>1 / fractional values.'
		}
	];
	const tieredAlphabets = $derived(
		TIERS.map((t) => ({
			...t,
			items: ALPHABET_PRESETS.filter((a) => a.tier === t.id)
		}))
	);

	// Custom-size inputs. Default to ⟨2,2,2⟩ to match the previous
	// "+" button behaviour for the no-input case.
	let mInput = $state(2);
	let nInput = $state(2);
	let pInput = $state(2);

	function clampInt(v: number, lo: number, hi: number): number {
		const n = Math.round(Number(v) || 0);
		return Math.min(hi, Math.max(lo, n));
	}

	function startCustom() {
		const m = clampInt(mInput, 2, 7);
		const n = clampInt(nInput, 2, 7);
		const p = clampInt(pInput, 2, 7);
		mInput = m;
		nInput = n;
		pInput = p;
		onCreate(m, n, p, selectedAlphabet.values);
	}

	type Preset = {
		m: number;
		n: number;
		p: number;
		// Inline historical / mathematical context for the preset,
		// rendered via `{@html}` so we can embed `<a href>` citations
		// to the relevant papers and `<em>` for term emphasis. All
		// strings here are static authored content — never user input
		// — so the {@html} usage is safe by construction.
		// Anchored on the named results the player is most likely to
		// recognise (Strassen, Hopcroft-Kerr, Bini, Laderman, Bläser,
		// Sedoglavic-Smirnov, Moosbauer-Poole / Kauers-Wood,
		// Landsberg-Ottaviani, AlphaTensor) and the schoolbook /
		// best-known / lower-bound rank trio that frames what a
		// "good" score on this size looks like. Use `&amp;` for
		// literal ampersands (e.g. "Hopcroft &amp; Kerr") because the
		// text is now rendered as raw HTML.
		description: string;
		// Optional bright-red call-out rendered under the description.
		// Set on the presets where there is a concrete, currently
		// achievable prize hook:
		//   * ⟨3,3,3⟩ — the silver prize threshold (`score ≥ 83`,
		//     see `+page.svelte`'s prize-banner comment) was
		//     deliberately tuned so a rank-19 algorithm (Bläser's
		//     proven lower bound) wins on the nose;
		//   * ⟨6,6,6⟩ — the smallest cube where the gold tier
		//     (`score ≥ 1,000`, i.e. `R ≤ 88` here) sits *strictly
		//     above* the proven lower bound (R ≥ 76 from Bläser),
		//     leaving a 12-rank window [76, 87] that is currently
		//     uncharted: no algorithm has been constructed there,
		//     and no proof rules one out either. A lower bound only
		//     forbids ranks strictly below it — it makes no promise
		//     that anything in the gap is actually achievable.
		// Same {@html} rendering as `description`, so anchor tags
		// and `<strong>` etc. are allowed.
		prizeCall?: string;
	};

	// Scores below are produced by `computeScore(computeOmega(m, n, p, R))`
	// from `tensor.ts` (the same pipeline that drives the live scoreboard
	// while playing). They are precomputed at authoring time rather than
	// at render time because the values are rank-bound trivia for the
	// player; nothing here changes when the player edits a board, so a
	// runtime call would just be wasted work.
	const presets: Preset[] = [
		{
			m: 2,
			n: 2,
			p: 2,
			description:
				"Strassen's foundational 1969 result: R = 7 (score 14) instead of the schoolbook R = 8 (score 1). Hopcroft &amp; Kerr proved in 1971 that R = 7 is optimal — no algorithm can do it in 6. The entire ±1/0 solution space has been exhaustively explored, so 14 is the highest score possible at this size."
		},
		{
			m: 2,
			n: 2,
			p: 3,
			description:
				'Hopcroft &amp; Kerr (1971) proved R = 11 is optimal (score 4); schoolbook R = 12 (score 1). All six permutations of {2, 2, 3} share the same rank but produce different board shapes — try ⟨3,2,2⟩ below for the exact shape Bini used in his classical paper.'
		},
		{
			m: 3,
			n: 2,
			p: 2,
			description:
				'Bini, Capovani, Lotti &amp; Romani (1979) introduced <em>border rank</em> on this exact shape — a 5-multiplication ε-approximate algorithm (not realisable in ±1/0 entries) that derandomises into a faster exact matrix-multiplication algorithm. The result launched three decades of progress on the matrix-multiplication exponent ω. Exact rank R = 11 (same as ⟨2,2,3⟩; score 4); schoolbook R = 12 (score 1).'
		},
		{
			m: 2,
			n: 3,
			p: 3,
			description:
				'Best known R = 15 (Smirnov; reproduced by AlphaTensor in 2022; score 14). Schoolbook R = 18 (score 1).'
		},
		{
			m: 3,
			n: 3,
			p: 3,
			description:
				"Laderman (1976) gave a clever R = 23 algorithm (score 8). Bläser (2003) proved R ≥ 19 — meaning no algorithm can use 18 or fewer multiplications. The gap [19, 23] has resisted every attack for 20+ years; finding a rank-19 algorithm at this size would lift the score to 83 and be a major open-problem result. Schoolbook R = 27 (score 1).",
			prizeCall:
				'Find an explicit rank-19 algorithm here and win the US$1,000 silver prize.'
		},
		{
			m: 4,
			n: 4,
			p: 4,
			description:
				'Strassen recursion on nested 2×2 blocks gives R = 49 (score 14). AlphaTensor (DeepMind, 2022) improved this to R = 47 modulo 2 (equivalent score 22 if it were realisable in ±1/0); over the integers with ±1/0 entries the best known remains R = 49. Schoolbook R = 64 (score 1).'
		},
		{
			m: 4,
			n: 5,
			p: 5,
			description: 'Best known R = 76 (AlphaTensor, 2022; score 12). Schoolbook R = 100 (score 1).'
		},
		{
			m: 5,
			n: 5,
			p: 5,
			description:
				'Best-known explicit R = 98 (<a href="https://arxiv.org/abs/2101.12568" target="_blank" rel="noopener noreferrer">Sedoglavic &amp; Smirnov, 2021</a>; score 8); the same paper bounds the <em>border</em> rank by 89 (score 18 if it were realisable in ±1/0 — approximate algorithms can shave another 9 multiplications). Schoolbook R = 125 (score 1). AlphaTensor (2022) improved several neighbouring sizes but did not break this frontier.'
		},
		{
			m: 6,
			n: 6,
			p: 6,
			description:
				'Frontier of fast matrix multiplication research. Best-known explicit upper bound R ≤ 153 (<a href="https://arxiv.org/abs/2505.05896" target="_blank" rel="noopener noreferrer">Kauers &amp; Wood, 2025</a>, derived from the Moosbauer-Poole algorithms; score 14). Proved lower bound R ≥ 76 (<a href="https://www.sciencedirect.com/science/article/pii/S0885064X02000079" target="_blank" rel="noopener noreferrer">Bläser, 2003</a>) — meaning no algorithm with 75 or fewer multiplications can exist; whether anything in the gap [76, 153] is achievable is wide open, and an algorithm hitting the bound exactly at R = 76 would score 3,147. For approximate / border-rank algorithms, Landsberg &amp; Ottaviani\'s general 2n²−n bound (<a href="https://arxiv.org/abs/1112.6007" target="_blank" rel="noopener noreferrer">2013</a>) shows the <em>border</em> rank is at least 66 at n = 6 — whether that bound is tight or the true border rank is much higher is itself an open question. Schoolbook R = 216 (score 1).',
			prizeCall:
				"Research territory — likely where you'll need to plant your flag for the US$10,000 gold prize. Any R ≤ 88 wins gold here, and Bläser's lower bound only rules out R &lt; 76. That leaves a 12-rank window [76, 87] where no algorithm has ever been built and no proof has ruled one out — be the first to find out which side of that question is correct."
		}
	];
</script>

<section class="newgame card">
	<header>
		<h2>New game</h2>
		<p class="lede">
			Pick a preset below to start a fresh game in a new tab, or punch in custom dimensions.
			Existing tabs are kept untouched, so you can keep several puzzles in flight at once.
		</p>
	</header>

	<!-- =====================================================================
	     Alphabet picker. Three single-column tiers stacked vertically
	     (Standard → Uncommon → Advanced), each its own labelled fieldset
	     so the visual grouping mirrors the conceptual one. The
	     selection applies to every game spawned from this tab — both
	     the custom-size button and the preset rows below.
	     ===================================================================== -->
	<fieldset class="alpha-group" aria-labelledby="alpha-group-label">
		<legend id="alpha-group-label">Alphabet</legend>
		<div class="alpha-tiers">
			{#each tieredAlphabets as tier (tier.id)}
				{#if tier.items.length > 0}
					<fieldset class="alpha-tier {tier.id}">
						<legend>{tier.legend}</legend>
						<div class="alpha-options">
							{#each tier.items as preset (preset.id)}
								<label
									class="alpha-opt"
									class:active={alphabetId === preset.id}
									title={tier.hint}
								>
									<input
										type="radio"
										name="alphabet"
										value={preset.id}
										bind:group={alphabetId}
									/>
									<span class="alpha-label">{preset.label}</span>
									{#if preset.id === 'pm1'}
										<span class="alpha-tag">default</span>
									{/if}
								</label>
							{/each}
						</div>
					</fieldset>
				{/if}
			{/each}
		</div>
		<p class="alpha-hint">
			New games spawned here will be restricted to <code>{selectedAlphabet.label}</code>. Famous
			algorithm replays load the alphabet their factorization was authored in — most use the classical
			<code>{`{−1, 0, +1}`}</code>, but a curated handful of AlphaTensor results use the wider
			<code>{`{−2, −1, 0, +1, +2}`}</code>.
		</p>
	</fieldset>

	<fieldset class="custom" aria-labelledby="custom-group-label">
		<legend id="custom-group-label">Board size</legend>
		<div class="custom-row">
			<label>
				<span>m</span>
				<input type="number" min="2" max="7" bind:value={mInput} />
			</label>
			<label>
				<span>n</span>
				<input type="number" min="2" max="7" bind:value={nInput} />
			</label>
			<label>
				<span>p</span>
				<input type="number" min="2" max="7" bind:value={pInput} />
			</label>
			<button class="primary" type="button" onclick={startCustom}>Start custom game</button>
		</div>
		<p class="dim-hint">
			Each dimension can be set from <code>2</code> to <code>7</code>.
		</p>
	</fieldset>

	<h3>Preset sizes</h3>
	<ul class="presets">
		{#each presets as preset (`${preset.m},${preset.n},${preset.p}`)}
			<li class="preset">
				<button
					class="preset-btn"
					type="button"
					onclick={() => onCreate(preset.m, preset.n, preset.p, selectedAlphabet.values)}
					title={`Start a new ⟨${preset.m},${preset.n},${preset.p}⟩ game in the ${selectedAlphabet.label} alphabet`}
				>
					⟨{preset.m},{preset.n},{preset.p}⟩
				</button>
				<div class="preset-text">
					<!-- Using {@html} so descriptions can carry citation
					     <a> tags and the occasional <em>; the strings
					     are static authored content (see comment on the
					     `description` / `prizeCall` fields above) so
					     there is no XSS surface here. -->
					<p class="preset-desc">{@html preset.description}</p>
					{#if preset.prizeCall}
						<p class="preset-prize">{@html preset.prizeCall}</p>
					{/if}
				</div>
			</li>
		{/each}
	</ul>
</section>

<style>
	.newgame {
		background: oklch(0.16 0.02 240 / 0.7);
		border: 1px solid rgb(30 41 59);
		border-radius: 14px;
		padding: 1.5rem 1.75rem;
		backdrop-filter: blur(6px);
		max-width: 80ch;
		margin: 0 auto;
	}

	header {
		margin-bottom: 1rem;
	}
	header h2 {
		margin: 0 0 0.4rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 700;
		font-size: 1.15rem;
		letter-spacing: 0.06em;
		color: rgb(248 250 252);
	}
	.lede {
		margin: 0;
		color: rgb(203 213 225);
		font-size: 0.9rem;
		line-height: 1.5;
		max-width: 70ch;
	}

	.alpha-group {
		/* Outer wrapper around the two tier fieldsets. The nested
		   fieldset markup is what gives us free <legend> alignment
		   and the "boxed group" semantics the user asked for; the
		   default UA fieldset border is preserved (just restyled)
		   and the inner tiers nest inside it as their own boxes.
		   Reset margins/padding so the wrapper sits flush with the
		   surrounding cards rather than picking up the UA's default
		   inset. */
		margin: 0.75rem 0 1rem;
		padding: 0.65rem 1rem 0.9rem;
		border: 1px solid rgb(30 41 59);
		border-radius: 10px;
		background: oklch(0.14 0.02 240 / 0.6);
	}
	.alpha-group > legend,
	.custom > legend {
		/* Shared top-level legend style for the two outer fieldsets
		   ("Alphabet" and "Board size"). Kept in one rule so the two
		   group labels stay visually identical — same monospace caps,
		   same slate tint — and the picker reads as a coherent stack
		   of labelled boxes. */
		padding: 0 0.45rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 700;
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: rgb(148 163 184);
	}
	.alpha-tiers {
		/* Three nested fieldsets stacked into a single column —
		   Standard → Uncommon → Advanced — so the picker reads top-down
		   from "classical default" to "experimental wider alphabet".
		   Wider hierarchy means the inner-fieldset borders carry the
		   grouping and we don't need any horizontal partitioning. */
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.alpha-tier {
		/* Three nested fieldsets — one per tier (Standard, Uncommon,
		   Advanced). Each gets its own border + legend so the visual
		   grouping reads top-to-bottom as a stack of clearly-labelled
		   boxes. */
		margin: 0;
		padding: 0.5rem 0.85rem 0.65rem;
		border: 1px solid rgb(30 41 59);
		border-radius: 8px;
		background: oklch(0.16 0.02 240 / 0.55);
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.alpha-options {
		/* Holds the radio rows inside a tier. Single column today,
		   but kept as its own flex container so future tiers with
		   more than ~3 alphabets can wrap into two visual columns
		   without disturbing the tier's border or legend. */
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
	}
	.alpha-tier > legend {
		padding: 0 0.35rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 700;
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: rgb(148 163 184);
	}
	.alpha-tier.uncommon > legend {
		/* Uncommon tier — Boolean-only world. Reads as a "halfway
		   house" between the canonical default and the experimental
		   advanced tier, so we tint the legend slate-cyan to signal
		   "still simple, just not the literature default". */
		color: oklch(0.78 0.08 200);
	}
	.alpha-tier.advanced > legend {
		/* Advanced tier uses the same warm-amber accent the Famous
		   Algorithms author tags use on the leaderboard — signals
		   "more involved, here be dragons" without being noisy. */
		color: oklch(0.82 0.12 65);
	}
	.alpha-opt {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3rem 0.45rem;
		border-radius: 6px;
		border: 1px solid transparent;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.8rem;
		color: rgb(203 213 225);
		cursor: pointer;
		transition: background-color 100ms ease, border-color 100ms ease;
	}
	.alpha-opt:hover {
		background: oklch(0.2 0.03 240 / 0.6);
		border-color: rgb(51 65 85);
	}
	.alpha-opt.active {
		background: oklch(0.24 0.05 175 / 0.65);
		border-color: oklch(0.55 0.12 175);
		color: rgb(248 250 252);
	}
	.alpha-opt input[type='radio'] {
		accent-color: oklch(0.7 0.18 175);
		cursor: pointer;
	}
	.alpha-label {
		flex: 1;
		min-width: 0;
		letter-spacing: 0.03em;
	}
	.alpha-tag {
		flex-shrink: 0;
		padding: 0.05rem 0.45rem;
		font-size: 0.6rem;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: oklch(0.7 0.04 240);
		background: oklch(0.2 0.03 240 / 0.7);
		border-radius: 999px;
	}
	.alpha-hint {
		margin: 0.6rem 0 0;
		font-size: 0.75rem;
		color: rgb(148 163 184);
		line-height: 1.4;
	}
	.alpha-hint code {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: rgb(30 41 59);
		padding: 0 0.3em;
		border-radius: 4px;
		color: rgb(125 211 252);
	}

	.custom {
		margin: 0.75rem 0 1rem;
		padding: 0.9rem 1rem;
		border: 1px solid rgb(30 41 59);
		border-radius: 10px;
		background: oklch(0.14 0.02 240 / 0.6);
	}
	.custom-row {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: 0.6rem;
	}
	.custom label {
		display: inline-flex;
		flex-direction: column;
		gap: 0.15rem;
		font-size: 0.7rem;
		color: rgb(148 163 184);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.custom input {
		width: 64px;
		background: rgb(15 23 42);
		border: 1px solid rgb(51 65 85);
		color: rgb(248 250 252);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		padding: 0.4rem 0.5rem;
		border-radius: 6px;
		font-size: 1rem;
	}
	.custom input:focus {
		outline: 2px solid oklch(0.7 0.18 230);
		border-color: transparent;
	}
	.dim-hint {
		margin: 0.55rem 0 0;
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

	h3 {
		margin: 1.1rem 0 0.75rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 700;
		font-size: 0.85rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: rgb(148 163 184);
	}

	.presets {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.preset {
		display: flex;
		align-items: flex-start;
		gap: 1rem;
		padding: 0.75rem 0.9rem;
		border: 1px solid rgb(30 41 59);
		border-radius: 10px;
		background: oklch(0.14 0.02 240 / 0.55);
		transition: border-color 120ms ease, background-color 120ms ease;
	}
	.preset:hover {
		border-color: rgb(51 65 85);
		background: oklch(0.18 0.03 240 / 0.7);
	}
	.preset-btn {
		flex-shrink: 0;
		min-width: 6.5rem;
		padding: 0.65rem 0.85rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 700;
		font-size: 1rem;
		letter-spacing: 0.04em;
		color: rgb(15 23 42);
		background: linear-gradient(135deg, oklch(0.78 0.18 145), oklch(0.62 0.16 175));
		border: 1px solid transparent;
		border-radius: 8px;
		cursor: pointer;
		transition: filter 120ms ease, transform 120ms ease;
	}
	.preset-btn:hover {
		filter: brightness(1.1);
	}
	.preset-btn:active {
		transform: translateY(1px);
	}
	.preset-btn:focus-visible {
		outline: 2px solid oklch(0.7 0.18 230);
		outline-offset: 2px;
	}
	.preset-text {
		/* Wrapper so the description paragraph and the optional red
		   prize-call paragraph below it share a single flex column —
		   this is what makes the row's flex layout treat the two
		   text lines as one logical block sitting beside the preset
		   button, instead of two separate flex children that would
		   each compete for width with the button. */
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}
	.preset-desc {
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.55;
		color: rgb(203 213 225);
	}
	.preset-desc :global(a) {
		/* Inline citation links inside the description prose. Match
		   the `code` callout colour used elsewhere in the help body
		   so the cited reference reads as the same family of "blue
		   pointer-to-something-technical" the rest of the app uses
		   (`code` background in HelpTab.svelte, focus outlines, etc.).
		   `:global` is required because the descriptions come through
		   `{@html}` and the resulting <a> elements aren't seen by the
		   Svelte CSS scoper. */
		color: rgb(125 211 252);
		text-decoration: underline;
		text-decoration-color: oklch(0.7 0.18 230 / 0.45);
		text-underline-offset: 2px;
		transition: color 120ms ease, text-decoration-color 120ms ease;
	}
	.preset-desc :global(a:hover) {
		color: oklch(0.85 0.18 230);
		text-decoration-color: oklch(0.85 0.18 230);
	}
	.preset-desc :global(a:focus-visible) {
		outline: 2px solid oklch(0.7 0.18 230);
		outline-offset: 2px;
		border-radius: 2px;
	}
	.preset-desc :global(em) {
		/* Subtle italic emphasis on terms-of-art (e.g. "border rank"
		   in the ⟨3,2,2⟩ description). Lightened to stand out a touch
		   without competing with the citation links above. */
		font-style: italic;
		color: rgb(226 232 240);
	}
	.preset-prize {
		/* Red callout flagging presets where there is a real, currently
		   achievable prize hook (only ⟨3,3,3⟩ today: a rank-19 algorithm
		   matches Bläser's lower bound and earns the silver tier).
		   Same red the rest of the app uses for "stop / important"
		   signals (`oklch(0.7 0.22 25)` — see `.impossible` in
		   HelpTab.svelte and the negative-score colour in Game.svelte's
		   `.metric.score.negative`), so the eye recognises it as a
		   high-priority annotation rather than yet another body
		   paragraph. Bold + slight letterspacing pushes the
		   announcement-y feel further. */
		margin: 0;
		font-size: 0.85rem;
		line-height: 1.45;
		font-weight: 700;
		letter-spacing: 0.01em;
		color: oklch(0.7 0.22 25);
	}

	button.primary {
		background: linear-gradient(135deg, oklch(0.62 0.18 230), oklch(0.55 0.18 260));
		color: rgb(15 23 42);
		font-weight: 600;
		border: 1px solid transparent;
		padding: 0.45rem 0.85rem;
		border-radius: 6px;
		font-size: 0.85rem;
		cursor: pointer;
		font-family: inherit;
	}
	button.primary:hover {
		filter: brightness(1.1);
	}
	button.primary:focus-visible {
		outline: 2px solid oklch(0.7 0.18 230);
		outline-offset: 2px;
	}

	@media (max-width: 640px) {
		.newgame {
			padding: 1rem 0.85rem;
		}
		.preset {
			flex-direction: column;
			gap: 0.5rem;
			align-items: stretch;
		}
		.preset-btn {
			min-width: 0;
			align-self: flex-start;
		}
	}
</style>
