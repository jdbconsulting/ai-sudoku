// Cell alphabets — the discrete set of values a player is allowed to put
// into the A/B/C boards. The original game shipped with the classical
// {−1, 0, +1} alphabet that every famous matmul algorithm (Strassen,
// Laderman, AlphaTensor) lives in. We now also support a small handful
// of curated alternatives so the player can experiment with simpler
// (Boolean-only {0, +1}) or richer (half-integer / ±2) coefficient
// worlds and watch the resulting score / residual change.
//
// Each alphabet is a strictly-sorted list of distinct numeric values
// that MUST include `0` (every algorithm trivially requires the option
// of leaving a cell empty) and is closed under `cycle()` — meaning the
// UI can walk through it forward and backward without surprises. The
// list is the *only* source of truth for what the player can type into
// a cell; the rest of the codebase (state, Board3D textures, server
// validation) reads it from here.
//
// We deliberately stop at small finite sets: the score formula doesn't
// care what's in the alphabet (it just looks at the residual + ranks
// used), so the alphabet's job is purely to constrain the search space.
// A {-1, 0, +1} alphabet matches the literature; the half-integer
// alphabets approximate the continuous polynomial-coefficient algorithms
// that Bini-style border-rank constructions inhabit; and the ±2 alphabets
// open the door to fairly compact "matrix-of-small-integers" decompositions
// that show up in approximate / numerical matmul research.

export type Alphabet = readonly number[];

// Three-tier ordering used by the New Game picker to group the
// catalogue visually:
//   * `standard` — the classical default ({−1, 0, +1}). Always at
//                   the top so the picker leads with the historical
//                   game experience.
//   * `uncommon`  — the Boolean-only {0, +1} world. Same conceptual
//                   simplicity as the default but no longer matches
//                   the literature, so it gets its own tier rather
//                   than living alongside the default.
//   * `advanced`  — wider alphabets (half-integers, ±2) where the
//                   residual takes |Γ| > 1 or fractional values and
//                   the player is leaving the well-studied
//                   ±1/0 regime behind.
export type AlphabetTier = 'standard' | 'uncommon' | 'advanced';

export type AlphabetPreset = {
	// Stable URL-safe identifier; persisted in solution files and sent
	// over the leaderboard wire so a row can be replayed in the exact
	// world it was authored in.
	id: string;
	// Display label rendered in the picker / scoreboard. Uses Unicode
	// minus / vulgar-fraction characters so the printed alphabet matches
	// the on-board glyphs the player actually sees.
	label: string;
	tier: AlphabetTier;
	values: Alphabet;
};

// Default alphabet. Matches the historical game and every preset
// algorithm (Strassen, Laderman, AlphaTensor) shipped in the famous
// algorithms registry, so loading any of those switches the alphabet
// back to this implicitly.
export const DEFAULT_ALPHABET: Alphabet = [-1, 0, 1];

// === Catalogue =============================================================
// Ordered for display: standard alphabets first (so the picker leads with
// the familiar ±1/0 default), then advanced. Each `values` list MUST be
// strictly increasing and contain 0; verified at module load below.

export const ALPHABET_PRESETS: ReadonlyArray<AlphabetPreset> = [
	{
		id: 'pm1',
		label: '{−1, 0, +1}',
		tier: 'standard',
		values: [-1, 0, 1]
	},
	{
		id: 'p01',
		label: '{0, +1}',
		tier: 'uncommon',
		values: [0, 1]
	},
	{
		id: 'pm1-half',
		label: '{−1, −½, 0, +½, +1}',
		tier: 'advanced',
		values: [-1, -0.5, 0, 0.5, 1]
	},
	{
		id: 'pm2-int',
		label: '{−2, −1, 0, +1, +2}',
		tier: 'advanced',
		values: [-2, -1, 0, 1, 2]
	},
	{
		id: 'pm2-half',
		label: '{−2, −1, −½, 0, +½, +1, +2}',
		tier: 'advanced',
		values: [-2, -1, -0.5, 0, 0.5, 1, 2]
	}
];

// Validate every preset at module load: this is tiny (≤ 7 values per
// alphabet × 5 alphabets) and protects us from a typo in the table
// silently breaking cycle() or server validation later.
for (const a of ALPHABET_PRESETS) {
	if (a.values.length < 2) {
		throw new Error(`alphabet ${a.id}: must have at least 2 values`);
	}
	if (!a.values.includes(0)) {
		throw new Error(`alphabet ${a.id}: must contain 0`);
	}
	for (let i = 1; i < a.values.length; i++) {
		if (!(a.values[i] > a.values[i - 1])) {
			throw new Error(`alphabet ${a.id}: values must be strictly increasing`);
		}
	}
}

export function findAlphabetPreset(id: string): AlphabetPreset | undefined {
	return ALPHABET_PRESETS.find((a) => a.id === id);
}

// Try to match a raw `values` list back to one of our named presets so
// that JSON solution files / leaderboard payloads can round-trip cleanly.
// Returns null when the values don't match any preset exactly — callers
// then keep the raw `values` list and just lose the convenient label.
export function matchAlphabet(values: Alphabet): AlphabetPreset | null {
	for (const a of ALPHABET_PRESETS) {
		if (sameAlphabet(a.values, values)) return a;
	}
	return null;
}

export function sameAlphabet(a: Alphabet, b: Alphabet): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

// Pick the canonical alphabet for a given preset id, with a fallback to
// the default. Used by the New Game tab when the picker is initialised
// from a stored / serialized id, and by the parsing path for solution
// files / leaderboard rows.
export function alphabetFromId(id: string | undefined): Alphabet {
	if (!id) return DEFAULT_ALPHABET;
	return findAlphabetPreset(id)?.values ?? DEFAULT_ALPHABET;
}

// === Cycle =================================================================
// Step a cell value forward or backward through the alphabet. Callers
// pass in the current value (which is expected to be in the alphabet —
// if not, we snap to the nearest value and start cycling from there).
// `dir > 0` advances toward higher values; `dir < 0` retreats. Wraps
// around the endpoints both ways — the player can keep clicking past
// the highest value and it loops back to the lowest. This keeps the
// click feel exactly the same as the original 0 → +1 → −1 → 0 cycle
// on the default alphabet, generalised to anything in the catalogue.

export function cycleValue(alphabet: Alphabet, current: number, dir: number): number {
	const idx = nearestIndex(alphabet, current);
	const step = dir >= 0 ? 1 : -1;
	const next = ((idx + step) % alphabet.length + alphabet.length) % alphabet.length;
	return alphabet[next];
}

// Map an arbitrary value to its index in the alphabet, falling back to
// the closest match by absolute distance when no exact hit is found.
// Defensive: real input should always be in the alphabet, but a stale
// board (saved with one alphabet, loaded under another) could land
// outside.
export function nearestIndex(alphabet: Alphabet, value: number): number {
	let best = 0;
	let bestDist = Math.abs(alphabet[0] - value);
	for (let i = 1; i < alphabet.length; i++) {
		const d = Math.abs(alphabet[i] - value);
		if (d < bestDist) {
			best = i;
			bestDist = d;
		}
	}
	return best;
}

export function isInAlphabet(alphabet: Alphabet, value: number): boolean {
	for (const v of alphabet) {
		if (v === value) return true;
	}
	return false;
}

// Snap a value to its nearest alphabet entry, used when loading a JSON
// solution / leaderboard replay so a slightly-corrupted file (or a stored
// value just outside floating-point exactness) doesn't poison the boards.
export function snapToAlphabet(alphabet: Alphabet, value: number): number {
	return alphabet[nearestIndex(alphabet, value)];
}

// === Display ===============================================================
// Helpers for turning a numeric cell value into the short human-readable
// form rendered on the 3D board textures, the tooltips, and the alphabet
// preview chips. Uses Unicode glyphs so the printed form lines up with
// the alphabet labels above (e.g. "−½" rather than "-0.5").
//
// We special-case the half-integers ±½ because they're the only fractions
// in the supported alphabets; for everything else the integer numeric
// form is fine. The leading sign is rendered with the typographic minus
// sign (U+2212) when negative and the plain "+" when positive — same as
// the original {−1, 0, +1} textures.

export function formatSign(v: number): '−' | '+' | '' {
	if (v < 0) return '−';
	if (v > 0) return '+';
	return '';
}

export function formatMagnitude(v: number): string {
	const abs = Math.abs(v);
	if (abs === 0) return '';
	if (abs === 0.5) return '½';
	if (Number.isInteger(abs)) {
		// Integer magnitudes of 1 omit the digit (the bare sign reads
		// as "±1" without ambiguity), matching the historical glyph.
		if (abs === 1) return '';
		return String(abs);
	}
	// Fallback for any value we don't have a dedicated glyph for. None
	// of the shipped alphabets hit this branch — it's just here so an
	// imported solution with an unfamiliar value still renders something
	// readable instead of a blank cell.
	return abs.toString();
}

// Compact one-string glyph for a value: sign + magnitude (e.g. "+½",
// "−2", "+1"). Empty string for zero (handled separately by the
// renderer which paints a yellow empty-cell texture). NOTE: ±1
// renders as just the sign ("+" or "−") because the on-board texture
// reads more cleanly with a single bold glyph than with "+1" — this
// matches the historical Strassen-era convention that's already baked
// into every screenshot in the README.
export function formatGlyph(v: number): string {
	if (v === 0) return '';
	const sign = formatSign(v);
	const mag = formatMagnitude(v);
	return sign + mag;
}

// Prose form of a value — like `formatGlyph` but always prints the
// magnitude, so ±1 reads as "+1" / "−1" rather than the bare sign.
// Use this for alphabet labels in scoreboard chips, the leaderboard,
// JSON tooltips — anywhere the value appears inside a sentence rather
// than on a board cell.
export function formatValue(v: number): string {
	if (v === 0) return '0';
	const sign = formatSign(v);
	const abs = Math.abs(v);
	if (abs === 0.5) return sign + '½';
	if (Number.isInteger(abs)) return sign + String(abs);
	return sign + abs.toString();
}

// Compact alphabet rendering for tooltips / scoreboard chips, e.g.
// "{−1, 0, +1}" — same convention as `AlphabetPreset.label`.
export function formatAlphabet(alphabet: Alphabet): string {
	const parts = alphabet.map((v) => formatValue(v));
	return '{' + parts.join(', ') + '}';
}
