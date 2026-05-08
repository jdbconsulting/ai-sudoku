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

export type CellValue = -1 | 0 | 1;
export type Board = 'A' | 'B' | 'C';

const NEXT: Record<number, CellValue> = { [-1]: 0, 0: 1, 1: -1 };

export class GameState {
	m = $state(2);
	n = $state(2);
	p = $state(2);

	// Active page index per board (0..R-1).
	pageA = $state(0);
	pageB = $state(0);
	pageC = $state(0);

	// Boards stored as flat Int8Arrays. We track changes via a version counter
	// because typed arrays aren't deeply tracked by Svelte's reactivity.
	A: Int8Array = $state(new Int8Array(0));
	B: Int8Array = $state(new Int8Array(0));
	C: Int8Array = $state(new Int8Array(0));
	version = $state(0);
	T: Int8Array = new Int8Array(0);

	// Per-board 3D viewing controls (page spacing & active-page clearance)
	// now live as local $state inside each Board3D component, so each
	// board can be tuned independently without dragging the other two
	// along. Nothing on the game-mechanics side reads those values, so
	// they don't belong here on GameState.

	constructor(m = 2, n = 2, p = 2) {
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
		this.A = new Int8Array(R * m * n);
		this.B = new Int8Array(R * n * p);
		this.C = new Int8Array(R * m * p);
		this.T = computeTargetTensor(m, n, p);
		this.pageA = 0;
		this.pageB = 0;
		this.pageC = 0;
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
		A: ReadonlyArray<number> | Int8Array,
		B: ReadonlyArray<number> | Int8Array,
		C: ReadonlyArray<number> | Int8Array
	): void {
		const R = m * n * p;
		if (A.length !== R * m * n) throw new Error(`A length ${A.length} ≠ ${R * m * n}`);
		if (B.length !== R * n * p) throw new Error(`B length ${B.length} ≠ ${R * n * p}`);
		if (C.length !== R * m * p) throw new Error(`C length ${C.length} ≠ ${R * m * p}`);
		this.resize(m, n, p, { fillNaive: false });
		this.A.set(A as Int8Array);
		this.B.set(B as Int8Array);
		this.C.set(C as Int8Array);
		this.version++;
	}

	randomize(density = 0.45) {
		const fill = (arr: Int8Array) => {
			for (let i = 0; i < arr.length; i++) {
				if (Math.random() < density) {
					arr[i] = Math.random() < 0.5 ? -1 : 1;
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
		const cols = board === 'A' ? this.n : board === 'B' ? this.p : this.p;
		const rows = board === 'A' ? this.m : board === 'B' ? this.n : this.m;
		const pageSize = rows * cols;
		const idx = page * pageSize + row * cols + col;
		const cur = arr[idx] as CellValue;
		const next = dir > 0 ? NEXT[cur] : ((((cur + 2 + 1) % 3) - 1) as CellValue);
		arr[idx] = next;
		this.version++;
	}

	setCell(board: Board, page: number, row: number, col: number, value: CellValue) {
		const arr = board === 'A' ? this.A : board === 'B' ? this.B : this.C;
		const cols = board === 'A' ? this.n : board === 'B' ? this.p : this.p;
		const rows = board === 'A' ? this.m : board === 'B' ? this.n : this.m;
		const pageSize = rows * cols;
		arr[page * pageSize + row * cols + col] = value;
		this.version++;
	}

	getCell(board: Board, page: number, row: number, col: number): CellValue {
		const arr = board === 'A' ? this.A : board === 'B' ? this.B : this.C;
		const cols = board === 'A' ? this.n : board === 'B' ? this.p : this.p;
		const rows = board === 'A' ? this.m : board === 'B' ? this.n : this.m;
		return arr[page * rows * cols + row * cols + col] as CellValue;
	}

	// === Serialization =====================================================
	// JSON shape (version 1):
	//   {
	//     "kind": "ai-sudoku-solution",
	//     "version": 1,
	//     "m": <int>, "n": <int>, "p": <int>,
	//     "R": <int>,                    // = m*n*p, denormalized for sanity-check
	//     "A": [[[...m×n...]] × R],      // R pages, each m×n, values in {-1,0,1}
	//     "B": [[[...n×p...]] × R],
	//     "C": [[[...m×p...]] × R]
	//   }
	toSolutionJSON(): SolutionFile {
		return {
			kind: 'ai-sudoku-solution',
			version: 1,
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

	// L1 norm of the residual. This is the number of additional naive ±1
	// rank-1 terms it would cost to patch every error in Γ — since cells are
	// in {-1, 0, 1}, each unit of |Γ| at one position needs exactly one
	// extra single-cell A·B·C term to cancel it.
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
	version: 1;
	m: number;
	n: number;
	p: number;
	R: number;
	A: CellValue[][][];
	B: CellValue[][][];
	C: CellValue[][][];
};

function pagesToNested(
	flat: Int8Array,
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
				row[j] = flat[r * rows * cols + i * cols + j] as CellValue;
			}
			page[i] = row;
		}
		out[r] = page;
	}
	return out;
}

function nestedToPages(
	nested: CellValue[][][],
	dest: Int8Array,
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

function parseSolutionFile(data: unknown): SolutionFile {
	if (!data || typeof data !== 'object') throw new Error('Solution must be a JSON object.');
	const obj = data as Record<string, unknown>;
	if (obj.kind !== 'ai-sudoku-solution') {
		throw new Error('Missing or wrong "kind" — expected "ai-sudoku-solution".');
	}
	if (obj.version !== 1) throw new Error(`Unsupported version: ${String(obj.version)}.`);
	const m = expectDim(obj.m, 'm');
	const n = expectDim(obj.n, 'n');
	const p = expectDim(obj.p, 'p');
	const R = m * n * p;
	if (obj.R !== undefined && obj.R !== R) {
		throw new Error(`R = ${String(obj.R)} disagrees with m·n·p = ${R}.`);
	}
	const A = expectCube(obj.A, 'A', R, m, n);
	const B = expectCube(obj.B, 'B', R, n, p);
	const C = expectCube(obj.C, 'C', R, m, p);
	return { kind: 'ai-sudoku-solution', version: 1, m, n, p, R, A, B, C };
}

function expectDim(v: unknown, name: string): number {
	if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 8) {
		throw new Error(`Field "${name}" must be an integer in [1, 8] (got ${String(v)}).`);
	}
	return v;
}

function expectCube(
	v: unknown,
	name: string,
	pages: number,
	rows: number,
	cols: number
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
				if (cell !== -1 && cell !== 0 && cell !== 1) {
					throw new Error(`"${name}"[${r}][${i}][${j}] must be -1, 0, or 1 (got ${String(cell)}).`);
				}
				outRow[j] = cell;
			}
			out[i] = outRow;
		}
		cube[r] = out;
	}
	return cube;
}
