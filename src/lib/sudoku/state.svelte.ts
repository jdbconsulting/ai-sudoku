import {
	computeOmega,
	computeResidual,
	computeScore,
	computeTargetTensor,
	countNonzero,
	loadStandardAlgorithm,
	loadStrassen,
	maxAbs,
	rankBounds,
	ranksUsed,
	sumAbs
} from './tensor';
import { decodeFactor, findAlphaTensorPreset, type AlphaTensorPreset } from './alphatensor';
import { buildFactors, findFamousAlgorithm, type FamousAlgorithm } from './famous';
import { findFlipGraphPreset, type FlipGraphPreset } from './flipgraph';
import {
	alphabetFromId,
	cycleValue,
	DEFAULT_ALPHABET,
	isInAlphabet,
	matchAlphabet,
	sameAlphabet,
	snapToAlphabet,
	type Alphabet
} from './alphabets';

// Cell values are any number in the active alphabet. The runtime type
// is just `number` — we don't carry a tagged-union here because (a) the
// alphabet is configurable per-game and (b) typed-array reads from
// Float32Array would defeat the literal-union narrowing anyway.
export type CellValue = number;
export type Board = 'A' | 'B' | 'C';

export class GameState {
	m = $state(2);
	n = $state(2);
	p = $state(2);

	// Active page index (0..R-1). The three matrices A, B, C are now
	// rendered together as a single combined board, so they share one
	// active page rather than tracking three independent indices.
	page = $state(0);

	// Boards stored as flat Float32Arrays. We track changes via a
	// version counter because typed arrays aren't deeply tracked by
	// Svelte's reactivity. Float32 (rather than Int8 like the original
	// implementation) so half-integer alphabet values ±½ round-trip
	// exactly through the storage layer.
	A: Float32Array = $state(new Float32Array(0));
	B: Float32Array = $state(new Float32Array(0));
	C: Float32Array = $state(new Float32Array(0));
	version = $state(0);
	T: Float32Array = new Float32Array(0);

	// Active alphabet. Set when the game is constructed (from the
	// NewGameTab picker) and replaced when a preset loader is invoked
	// — e.g. `loadStrassen()` snaps it back to {−1, 0, +1} because the
	// Strassen coefficients only live in that alphabet. Stored as a
	// frozen tuple so accidental mutation is caught by the type
	// system and the runtime reference equality is stable across
	// reactivity passes.
	alphabet: Alphabet = $state(DEFAULT_ALPHABET);

	// 3D viewing controls (page spacing & active-page clearance) live as
	// local $state inside the Board3D component. Nothing on the
	// game-mechanics side reads those values, so they don't belong here
	// on GameState.

	constructor(m = 2, n = 2, p = 2, alphabet: Alphabet = DEFAULT_ALPHABET) {
		this.alphabet = alphabet;
		this.resize(m, n, p);
	}

	// The number of rank slots is always the trivial schoolbook bound m·n·p.
	// The player lowers the *effective* rank simply by leaving pages blank,
	// which keeps the controls minimal (no separate "R" dial).
	get R() {
		return this.m * this.n * this.p;
	}

	get sa() {
		return this.m * this.n;
	}
	get sb() {
		return this.n * this.p;
	}
	get sc() {
		return this.m * this.p;
	}

	// `fillNaive` seeds the boards with the schoolbook m·n·p algorithm so the
	// player always starts from a valid (if maximally-ranked) decomposition.
	// Callers that immediately overwrite the boards (e.g. `loadSolutionJSON`)
	// pass `false` to skip the wasted allocation+fill.
	resize(m: number, n: number, p: number, { fillNaive = true } = {}) {
		this.m = m;
		this.n = n;
		this.p = p;
		const R = m * n * p;
		this.A = new Float32Array(R * m * n);
		this.B = new Float32Array(R * n * p);
		this.C = new Float32Array(R * m * p);
		this.T = computeTargetTensor(m, n, p);
		this.page = 0;
		if (fillNaive) {
			const out = loadStandardAlgorithm({ m, n, p, R });
			if (out) {
				this.A = out.A;
				this.B = out.B;
				this.C = out.C;
			}
		}
		this.version++;
	}

	clear() {
		this.A.fill(0);
		this.B.fill(0);
		this.C.fill(0);
		this.version++;
	}

	// Set the alphabet on a live game. Used by JSON load + leaderboard
	// replay paths so they can carry the right alphabet into the
	// already-constructed GameState. We don't snap existing cells to
	// the new alphabet here — callers either reset the boards first
	// (resize path) or overwrite them immediately after.
	setAlphabet(alphabet: Alphabet) {
		this.alphabet = alphabet;
		this.version++;
	}

	loadStandard() {
		const out = loadStandardAlgorithm({ m: this.m, n: this.n, p: this.p, R: this.R });
		if (!out) return false;
		this.A = out.A;
		this.B = out.B;
		this.C = out.C;
		this.version++;
		return true;
	}

	loadStrassen() {
		const out = loadStrassen({ m: this.m, n: this.n, p: this.p, R: this.R });
		if (!out) return false;
		// Strassen's coefficients are in {−1, 0, +1}, so we silently
		// upgrade the active alphabet if the player was in a stricter
		// world (e.g. {0, +1}) and would otherwise be unable to enter
		// ±1 values. Matches the principle that "preset loaders set up
		// a *valid* starting state, including the alphabet they were
		// authored in".
		this.maybeUpgradeAlphabetTo(DEFAULT_ALPHABET);
		this.A = out.A;
		this.B = out.B;
		this.C = out.C;
		this.version++;
		return true;
	}

	// Load a precomputed AlphaTensor factorization, resizing the board to match
	// the preset's <m, n, p> first. The factorization uses fewer than m·n·p ranks
	// so its trailing pages are left empty (zero-filled), which is exactly the
	// "fewer pages → faster algorithm" state the player is trying to discover.
	loadAlphaTensor(m: number, n: number, p: number): boolean {
		const preset = findAlphaTensorPreset(m, n, p);
		if (!preset) return false;
		this.applyAlphaTensorPreset(preset);
		return true;
	}

	applyAlphaTensorPreset(preset: AlphaTensorPreset): void {
		// AlphaTensor presets carry their authoring alphabet on the
		// preset record itself: most use the classical {−1, 0, +1},
		// but a curated handful (e.g. ⟨3,3,3⟩ R=23, ⟨5,5,5⟩ R=98)
		// use the wider {−2..+2}. Falling back to the default keeps
		// older presets that don't carry an explicit alphabet working
		// unchanged.
		this.alphabet = preset.alphabet ?? DEFAULT_ALPHABET;
		this.resize(preset.m, preset.n, preset.p, { fillNaive: false });
		// Buffers are sized for R = m·n·p slots; the preset only fills the
		// first `preset.R` of them. Leaving the tail zero is exactly what we
		// want — those pages contribute nothing and won't count toward the
		// "ranks used" tally.
		const a = decodeFactor(preset.A);
		const b = decodeFactor(preset.B);
		const c = decodeFactor(preset.C);
		this.A.set(a);
		this.B.set(b);
		this.C.set(c);
		this.version++;
	}

	// Load a flip-graph–discovered factorization (Moosbauer-Poole 2025,
	// Kauers-Wood 2025, etc.). Keyed by id because each paper publishes
	// only one or two large factorizations rather than a full catalogue,
	// so the natural lookup is "which paper's preset" rather than "which
	// ⟨m,n,p⟩". Shares the bulk-encoded board format with AlphaTensor
	// presets — same `decodeFactor`, same per-cell legend, same
	// `Float32Array` materialisation — so the apply path is a direct
	// reuse of `applyAlphaTensorPreset`'s body.
	loadFlipGraph(id: string): boolean {
		const preset = findFlipGraphPreset(id);
		if (!preset) return false;
		this.applyFlipGraphPreset(preset);
		return true;
	}

	applyFlipGraphPreset(preset: FlipGraphPreset): void {
		this.alphabet = preset.alphabet ?? DEFAULT_ALPHABET;
		this.resize(preset.m, preset.n, preset.p, { fillNaive: false });
		const a = decodeFactor(preset.A);
		const b = decodeFactor(preset.B);
		const c = decodeFactor(preset.C);
		this.A.set(a);
		this.B.set(b);
		this.C.set(c);
		this.version++;
	}

	// Load a hand-curated classical algorithm by id (e.g. "laderman-3x3x3").
	// Same shape as loadAlphaTensor: resizes the board to the algorithm's
	// <m,n,p> first, then fills the first R rank slots from the registry.
	loadFamous(id: string): boolean {
		const alg = findFamousAlgorithm(id);
		if (!alg) return false;
		this.applyFamous(alg);
		return true;
	}

	applyFamous(alg: FamousAlgorithm): void {
		this.alphabet = DEFAULT_ALPHABET;
		this.resize(alg.m, alg.n, alg.p, { fillNaive: false });
		const { A, B, C } = buildFactors(alg);
		this.A.set(A);
		this.B.set(B);
		this.C.set(C);
		this.version++;
	}

	// Apply a leaderboard replay: resize to <m,n,p>, then overwrite the
	// boards. Accepts plain number[] (what the API delivers as JSON) so
	// callers don't have to materialise typed arrays first. Throws if
	// any length doesn't match the (m·n·p)-derived expectation, since
	// that would silently corrupt the residual.
	loadFlatBoards(
		m: number,
		n: number,
		p: number,
		A: ReadonlyArray<number> | Float32Array,
		B: ReadonlyArray<number> | Float32Array,
		C: ReadonlyArray<number> | Float32Array,
		alphabet: Alphabet = DEFAULT_ALPHABET
	): void {
		const R = m * n * p;
		if (A.length !== R * m * n) throw new Error(`A length ${A.length} ≠ ${R * m * n}`);
		if (B.length !== R * n * p) throw new Error(`B length ${B.length} ≠ ${R * n * p}`);
		if (C.length !== R * m * p) throw new Error(`C length ${C.length} ≠ ${R * m * p}`);
		this.alphabet = alphabet;
		this.resize(m, n, p, { fillNaive: false });
		copyInto(A, this.A);
		copyInto(B, this.B);
		copyInto(C, this.C);
		this.version++;
	}

	randomize(density = 0.45) {
		// Pick uniformly from the non-zero alphabet entries so the
		// randomiser still works on alphabets like {0, +1} (one
		// non-zero entry, density-many cells become +1) and the
		// half-integer / ±2 worlds (each non-zero cell uniformly
		// chosen from the alphabet's non-zero values).
		const nz = this.alphabet.filter((v) => v !== 0);
		const fill = (arr: Float32Array) => {
			for (let i = 0; i < arr.length; i++) {
				if (nz.length > 0 && Math.random() < density) {
					arr[i] = nz[Math.floor(Math.random() * nz.length)];
				} else {
					arr[i] = 0;
				}
			}
		};
		fill(this.A);
		fill(this.B);
		fill(this.C);
		this.version++;
	}

	cycle(board: Board, page: number, row: number, col: number, dir = 1) {
		const arr = board === 'A' ? this.A : board === 'B' ? this.B : this.C;
		const cols = board === 'A' ? this.n : this.p;
		const rows = board === 'A' ? this.m : board === 'B' ? this.n : this.m;
		const pageSize = rows * cols;
		const idx = page * pageSize + row * cols + col;
		const cur = arr[idx];
		arr[idx] = cycleValue(this.alphabet, cur, dir);
		this.version++;
	}

	setCell(board: Board, page: number, row: number, col: number, value: CellValue) {
		const arr = board === 'A' ? this.A : board === 'B' ? this.B : this.C;
		const cols = board === 'A' ? this.n : this.p;
		const rows = board === 'A' ? this.m : board === 'B' ? this.n : this.m;
		const pageSize = rows * cols;
		// Snap to the active alphabet so a stale `value` (e.g. arriving
		// from a JSON file authored in a wider alphabet) can't introduce
		// out-of-band entries that would later trip the server's
		// validator. For values already in the alphabet this is a no-op.
		const snapped = isInAlphabet(this.alphabet, value)
			? value
			: snapToAlphabet(this.alphabet, value);
		arr[page * pageSize + row * cols + col] = snapped;
		this.version++;
	}

	getCell(board: Board, page: number, row: number, col: number): CellValue {
		const arr = board === 'A' ? this.A : board === 'B' ? this.B : this.C;
		const cols = board === 'A' ? this.n : this.p;
		const rows = board === 'A' ? this.m : board === 'B' ? this.n : this.m;
		return arr[page * rows * cols + row * cols + col];
	}

	// Switch the alphabet *upward* only — used by preset loaders that
	// produce coefficients outside the player's current alphabet. We
	// never silently *narrow* the alphabet (that would erase cells),
	// only widen it to a known superset. Callers pass the loader's
	// authoring alphabet; if the current alphabet is already a
	// superset, this is a no-op.
	private maybeUpgradeAlphabetTo(target: Alphabet): void {
		if (sameAlphabet(this.alphabet, target)) return;
		const cur = new Set(this.alphabet);
		for (const v of target) {
			if (!cur.has(v)) {
				// Current alphabet is missing a value the loader needs.
				// Easiest fix: replace with the target alphabet.
				this.alphabet = target;
				return;
			}
		}
	}

	// === Serialization =====================================================
	// JSON shape (version 2):
	//   {
	//     "kind": "ai-sudoku-solution",
	//     "version": 2,
	//     "alphabet": [number, ...],     // strict-increasing, includes 0
	//     "m": <int>, "n": <int>, "p": <int>,
	//     "R": <int>,                    // = m*n*p, denormalized sanity-check
	//     "A": [[[...m×n...]] × R],      // R pages, each m×n, values in alphabet
	//     "B": [[[...n×p...]] × R],
	//     "C": [[[...m×p...]] × R]
	//   }
	// Version 1 (no `alphabet` field, values restricted to {−1, 0, +1}) is
	// still accepted on input — it just gets the default alphabet attached.
	toSolutionJSON(): SolutionFile {
		return {
			kind: 'ai-sudoku-solution',
			version: 2,
			alphabet: Array.from(this.alphabet),
			m: this.m,
			n: this.n,
			p: this.p,
			R: this.R,
			A: pagesToNested(this.A, this.R, this.m, this.n),
			B: pagesToNested(this.B, this.R, this.n, this.p),
			C: pagesToNested(this.C, this.R, this.m, this.p)
		};
	}

	// Replace the current boards from a parsed solution file. Resizes the
	// puzzle to match the file's <m,n,p> first. Throws on malformed input so
	// the caller can surface a useful error in the import dialog.
	loadSolutionJSON(data: unknown): void {
		const sol = parseSolutionFile(data);
		this.alphabet = sol.alphabet;
		this.resize(sol.m, sol.n, sol.p, { fillNaive: false });
		nestedToPages(sol.A, this.A, sol.R, sol.m, sol.n);
		nestedToPages(sol.B, this.B, sol.R, sol.n, sol.p);
		nestedToPages(sol.C, this.C, sol.R, sol.m, sol.p);
		this.version++;
	}

	residual = $derived.by(() => {
		// touch the version trigger so this re-runs on edits
		this.version;
		return computeResidual(
			{ m: this.m, n: this.n, p: this.p, R: this.R },
			this.A,
			this.B,
			this.C,
			this.T
		);
	});

	residualNonzero = $derived(countNonzero(this.residual));
	residualMaxAbs = $derived(maxAbs(this.residual));

	// L1 norm of the residual: Σ |Γ|. With the default {−1, 0, +1}
	// alphabet this is exactly the "naive ±1 patch cost" the original
	// help text described; with broader alphabets it's no longer a
	// crisp count of rank-1 patch terms (a {0, +1}-only alphabet can't
	// even represent a single ±1 patch), but it's still a monotone
	// "distance to solved" measure, which is what `effectiveRank`
	// downstream actually needs.
	residualSumAbs = $derived(sumAbs(this.residual));

	ranksUsed = $derived.by(() => {
		this.version;
		return ranksUsed({ m: this.m, n: this.n, p: this.p, R: this.R }, this.A, this.B, this.C);
	});

	// Lower / upper bounds on rank for the current <m,n,p>.
	bounds = $derived(rankBounds(this.m, this.n, this.p));

	solved = $derived(this.residualNonzero === 0);

	// Effective rank R_eff = (rank slots actually used) + (naive cost to fix
	// the residual). When the residual is zero this is just `ranksUsed`; when
	// the boards are empty the residual equals T and Σ|Γ| = m·n·p, so
	// R_eff = m·n·p (the trivial schoolbook algorithm). Anything in between
	// is the player's progress along the trade-off curve.
	effectiveRank = $derived(this.ranksUsed + this.residualSumAbs);

	// Asymptotic complexity exponent ω and gamified score derive from
	// pure helpers in tensor.ts so the high score board can rate pre-baked
	// algorithms with the exact same formulas.
	omega = $derived(computeOmega(this.m, this.n, this.p, this.effectiveRank));
	score = $derived(computeScore(this.omega));
}

// ---------------------------------------------------------------------------
// Solution file (de)serialization
// ---------------------------------------------------------------------------

export type SolutionFile = {
	kind: 'ai-sudoku-solution';
	version: 2;
	// Strict-increasing list including 0; the values the boards were
	// authored in. Persisted explicitly so a file authored in a wider
	// alphabet can't be silently truncated on load.
	alphabet: number[];
	m: number;
	n: number;
	p: number;
	R: number;
	A: CellValue[][][];
	B: CellValue[][][];
	C: CellValue[][][];
};

// Internal "parsed" shape — same as SolutionFile but with a tight
// `Alphabet` type so the rest of state.svelte.ts can rely on it being
// a frozen list-of-numbers without re-validating.
type ParsedSolution = {
	alphabet: Alphabet;
	m: number;
	n: number;
	p: number;
	R: number;
	A: CellValue[][][];
	B: CellValue[][][];
	C: CellValue[][][];
};

function pagesToNested(
	flat: Float32Array,
	pages: number,
	rows: number,
	cols: number
): CellValue[][][] {
	const out: CellValue[][][] = new Array(pages);
	for (let r = 0; r < pages; r++) {
		const page: CellValue[][] = new Array(rows);
		for (let i = 0; i < rows; i++) {
			const row: CellValue[] = new Array(cols);
			for (let j = 0; j < cols; j++) {
				row[j] = flat[r * rows * cols + i * cols + j];
			}
			page[i] = row;
		}
		out[r] = page;
	}
	return out;
}

function nestedToPages(
	nested: CellValue[][][],
	dest: Float32Array,
	pages: number,
	rows: number,
	cols: number
): void {
	for (let r = 0; r < pages; r++) {
		for (let i = 0; i < rows; i++) {
			for (let j = 0; j < cols; j++) {
				dest[r * rows * cols + i * cols + j] = nested[r][i][j];
			}
		}
	}
}

function copyInto(src: ReadonlyArray<number> | Float32Array, dest: Float32Array): void {
	if (src instanceof Float32Array) {
		dest.set(src);
		return;
	}
	for (let i = 0; i < src.length; i++) dest[i] = src[i];
}

function parseSolutionFile(data: unknown): ParsedSolution {
	if (!data || typeof data !== 'object') throw new Error('Solution must be a JSON object.');
	const obj = data as Record<string, unknown>;
	if (obj.kind !== 'ai-sudoku-solution') {
		throw new Error('Missing or wrong "kind" — expected "ai-sudoku-solution".');
	}
	// Accept both shipped versions:
	//   v1 — original {−1, 0, +1}-only format; alphabet is implicit.
	//   v2 — current format; carries an explicit `alphabet` array.
	const ver = obj.version;
	if (ver !== 1 && ver !== 2) {
		throw new Error(`Unsupported version: ${String(ver)}.`);
	}
	const m = expectDim(obj.m, 'm');
	const n = expectDim(obj.n, 'n');
	const p = expectDim(obj.p, 'p');
	const R = m * n * p;
	if (obj.R !== undefined && obj.R !== R) {
		throw new Error(`R = ${String(obj.R)} disagrees with m·n·p = ${R}.`);
	}
	const alphabet: Alphabet =
		ver === 2 ? expectAlphabet(obj.alphabet) : DEFAULT_ALPHABET;
	const A = expectCube(obj.A, 'A', R, m, n, alphabet);
	const B = expectCube(obj.B, 'B', R, n, p, alphabet);
	const C = expectCube(obj.C, 'C', R, m, p, alphabet);
	return { alphabet, m, n, p, R, A, B, C };
}

function expectDim(v: unknown, name: string): number {
	if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 8) {
		throw new Error(`Field "${name}" must be an integer in [1, 8] (got ${String(v)}).`);
	}
	return v;
}

function expectAlphabet(v: unknown): Alphabet {
	if (!Array.isArray(v)) {
		throw new Error('Field "alphabet" must be an array of numbers.');
	}
	const arr: number[] = [];
	for (let i = 0; i < v.length; i++) {
		const x = v[i];
		if (typeof x !== 'number' || !Number.isFinite(x)) {
			throw new Error(`alphabet[${i}] must be a finite number (got ${String(x)}).`);
		}
		arr.push(x);
		if (i > 0 && !(arr[i] > arr[i - 1])) {
			throw new Error('"alphabet" must be strictly increasing.');
		}
	}
	if (arr.length < 2) {
		throw new Error('"alphabet" must contain at least 2 values.');
	}
	if (!arr.includes(0)) {
		throw new Error('"alphabet" must contain 0.');
	}
	// Prefer the canonical preset instance when the values line up
	// exactly — gives downstream comparators (e.g. preset highlighting
	// in the New Game tab) reference equality for free.
	const preset = matchAlphabet(arr);
	return preset ? preset.values : arr;
}

function expectCube(
	v: unknown,
	name: string,
	pages: number,
	rows: number,
	cols: number,
	alphabet: Alphabet
): CellValue[][][] {
	if (!Array.isArray(v) || v.length !== pages) {
		throw new Error(`Field "${name}" must be an array of ${pages} pages.`);
	}
	const cube: CellValue[][][] = new Array(pages);
	for (let r = 0; r < pages; r++) {
		const page = v[r];
		if (!Array.isArray(page) || page.length !== rows) {
			throw new Error(`"${name}"[${r}] must have ${rows} rows.`);
		}
		const out: CellValue[][] = new Array(rows);
		for (let i = 0; i < rows; i++) {
			const row = page[i];
			if (!Array.isArray(row) || row.length !== cols) {
				throw new Error(`"${name}"[${r}][${i}] must have ${cols} columns.`);
			}
			const outRow: CellValue[] = new Array(cols);
			for (let j = 0; j < cols; j++) {
				const cell = row[j];
				if (typeof cell !== 'number' || !Number.isFinite(cell)) {
					throw new Error(
						`"${name}"[${r}][${i}][${j}] must be a finite number (got ${String(cell)}).`
					);
				}
				if (!isInAlphabet(alphabet, cell)) {
					throw new Error(
						`"${name}"[${r}][${i}][${j}] = ${cell} is not in the alphabet ${
							'{' + alphabet.join(', ') + '}'
						}.`
					);
				}
				outRow[j] = cell;
			}
			out[i] = outRow;
		}
		cube[r] = out;
	}
	return cube;
}

// Re-export the alphabet type so consumers of state.svelte don't have
// to know about the helper module.
export type { Alphabet } from './alphabets';
