// Math for the matrix-multiplication tensor decomposition game.
//
// For matrix multiplication of size <m, n, p>:
//   C_{i,l} = sum_j A_{i,j} * B_{j,l}
// the matmul tensor T has shape (m*n) x (n*p) x (m*p) with entries
//   T[(i,j), (k,l), (s,t)] = 1   iff   i == s AND j == k AND l == t
//   T[...]                       = 0   otherwise
// A rank-R decomposition writes T = sum_{r=1..R} u_r (x) v_r (x) w_r where
// the outer-product factors are reshaped into matrices:
//   u_r is reshaped as Board A page r (m x n)
//   v_r is reshaped as Board B page r (n x p)
//   w_r is reshaped as Board C page r (m x p)
// Cells live in {-1, 0, 1}.

export type Mnp = { m: number; n: number; p: number; R: number };

// Lower bound for the achievable rank: ceil((m*n*p)^(2/3)).
// Upper bound: trivial m*n*p multiplications.
export function rankBounds(m: number, n: number, p: number): { min: number; max: number } {
	const product = m * n * p;
	const min = Math.max(1, Math.ceil(Math.pow(product, 2 / 3)));
	const max = product;
	return { min, max };
}

export function sizeA(m: number, n: number) {
	return m * n;
}
export function sizeB(n: number, p: number) {
	return n * p;
}
export function sizeC(m: number, p: number) {
	return m * p;
}

// Flat index helpers. All boards are stored as a flat Int8Array of length R * page,
// laid out [page0, page1, ..., page_{R-1}], each page row-major.
export function flatA(m: number, n: number, r: number, i: number, j: number) {
	return r * m * n + i * n + j;
}
export function flatB(n: number, p: number, r: number, j: number, k: number) {
	return r * n * p + j * p + k;
}
export function flatC(m: number, p: number, r: number, i: number, k: number) {
	return r * m * p + i * p + k;
}

// Build the target matmul tensor T as a flat Int8Array of length (m*n)*(n*p)*(m*p).
// Layout: T[((a * (n*p)) + b) * (m*p) + c]
//   a in [0, m*n) decoded as (i, j)
//   b in [0, n*p) decoded as (k, l)
//   c in [0, m*p) decoded as (s, t)
export function computeTargetTensor(m: number, n: number, p: number): Int8Array {
	const sa = m * n;
	const sb = n * p;
	const sc = m * p;
	const T = new Int8Array(sa * sb * sc);
	for (let i = 0; i < m; i++) {
		for (let j = 0; j < n; j++) {
			for (let l = 0; l < p; l++) {
				// non-zero positions: i == s, j == k, l == t
				const a = i * n + j;
				const b = j * p + l;
				const c = i * p + l;
				T[(a * sb + b) * sc + c] = 1;
			}
		}
	}
	return T;
}

// Compute the residual tensor Γ = T - sum_r flat(A_r) (x) flat(B_r) (x) flat(C_r).
// The "ideal" answer makes Γ identically zero.
export function computeResidual(
	mnp: Mnp,
	A: Int8Array,
	B: Int8Array,
	C: Int8Array,
	T: Int8Array
): Int32Array {
	const { m, n, p, R } = mnp;
	const sa = m * n;
	const sb = n * p;
	const sc = m * p;
	const total = sa * sb * sc;
	const G = new Int32Array(total);
	for (let i = 0; i < total; i++) G[i] = T[i];

	for (let r = 0; r < R; r++) {
		const aOff = r * sa;
		const bOff = r * sb;
		const cOff = r * sc;
		for (let a = 0; a < sa; a++) {
			const ua = A[aOff + a];
			if (ua === 0) continue;
			for (let b = 0; b < sb; b++) {
				const vb = B[bOff + b];
				if (vb === 0) continue;
				const ab = ua * vb;
				const baseAB = (a * sb + b) * sc;
				for (let c = 0; c < sc; c++) {
					const wc = C[cOff + c];
					if (wc === 0) continue;
					G[baseAB + c] -= ab * wc;
				}
			}
		}
	}
	return G;
}

export function countNonzero(G: Int32Array): number {
	let n = 0;
	for (let i = 0; i < G.length; i++) if (G[i] !== 0) n++;
	return n;
}

export function maxAbs(G: Int32Array): number {
	let m = 0;
	for (let i = 0; i < G.length; i++) {
		const v = G[i] < 0 ? -G[i] : G[i];
		if (v > m) m = v;
	}
	return m;
}

// L1 norm of the residual: Σ |Γ_i|. This is the number of naive ±1·±1·±1
// rank-1 terms a player would have to append to the decomposition to drive
// the residual to zero (since cells live in {-1, 0, 1}, each unit of error
// at a single position requires one such patch term).
export function sumAbs(G: Int32Array): number {
	let s = 0;
	for (let i = 0; i < G.length; i++) {
		s += G[i] < 0 ? -G[i] : G[i];
	}
	return s;
}

// Number of independent ranks used (a rank slot is "used" when any of its
// A/B/C pages contains a non-zero element).
export function ranksUsed(mnp: Mnp, A: Int8Array, B: Int8Array, C: Int8Array): number {
	const { m, n, p, R } = mnp;
	const sa = m * n;
	const sb = n * p;
	const sc = m * p;
	let used = 0;
	for (let r = 0; r < R; r++) {
		let any = false;
		for (let a = 0; a < sa; a++) if (A[r * sa + a] !== 0) { any = true; break; }
		if (!any) for (let b = 0; b < sb; b++) if (B[r * sb + b] !== 0) { any = true; break; }
		if (!any) for (let c = 0; c < sc; c++) if (C[r * sc + c] !== 0) { any = true; break; }
		if (any) used++;
	}
	return used;
}

// Pre-load the trivial standard algorithm: rank slot indexed by (i, j, l)
// computes the contribution A_{i,j} * B_{j,l} -> C_{i,l}. Returns null if R is
// too small to fit the full m*n*p ranks.
export function loadStandardAlgorithm(mnp: Mnp): { A: Int8Array; B: Int8Array; C: Int8Array } | null {
	const { m, n, p, R } = mnp;
	if (R < m * n * p) return null;
	const A = new Int8Array(R * m * n);
	const B = new Int8Array(R * n * p);
	const C = new Int8Array(R * m * p);
	let r = 0;
	for (let i = 0; i < m; i++) {
		for (let j = 0; j < n; j++) {
			for (let l = 0; l < p; l++) {
				A[r * m * n + i * n + j] = 1;
				B[r * n * p + j * p + l] = 1;
				C[r * m * p + i * p + l] = 1;
				r++;
			}
		}
	}
	return { A, B, C };
}

// === Scoring helpers =======================================================
// Pulled out as pure functions so non-game contexts (e.g. the high score
// board, which rates pre-baked algorithms without a live GameState) can use
// the exact same formulas.

// Reference matrix size for the polylog correction below — a "real"
// matmul we'd actually care about (~10⁶ entries). The polylog factor's
// magnitude depends weakly on this; 2²⁰ gives a sane balance.
const N_REF = 1 << 20;

// Asymptotic complexity exponent ω for the player's <m,n,p> R_eff algorithm
// when used as the base case of a divide-and-conquer N×N×N matmul.
// Solving the recurrence T(N) = R · T(N/s) + Θ(N²) with s = (m·n·p)^(1/3):
//   • R > s²  →  T(N) = Θ(N^{log_s R})           — multiplications dominate
//   • R = s²  →  T(N) = Θ(N²·log_s N)            — boundary, polylog matters
//   • R < s²  →  T(N) = Θ(N²)                    — additions dominate
// The naive formula 3·log(R)/log(m·n·p) is the exponent in case 1 only;
// at and below the lower bound it pretends the polylog factor is free and
// awards ω = 2 to anything with R ≤ (m·n·p)^(2/3). We instead take the
// max of that exponent and the "polylog floor" — the effective exponent
// of N²·log_s(N_REF) at N = N_REF — so that finite recursion overhead
// shows up where it actually binds (R ≤ s²) without disturbing real
// algorithms (Strassen, AlphaTensor, schoolbook all have R > s²).
// The degenerate <1,1,1> case has nothing to recurse into, so we fall back
// to the schoolbook value of 3.
export function computeOmega(m: number, n: number, p: number, effectiveRank: number): number {
	const mnp = m * n * p;
	if (mnp <= 1 || effectiveRank < 1) return 3;
	const omegaNaive = (3 * Math.log(effectiveRank)) / Math.log(mnp);
	const s = Math.pow(mnp, 1 / 3);
	const depth = Math.log(N_REF) / Math.log(s);
	const polylogFloor = 2 + Math.log(depth + 1) / Math.log(N_REF);
	return Math.max(omegaNaive, polylogFloor);
}

// Gamified score derived from ω. Two-regime curve joined continuously at
// ω = 3 (the schoolbook anchor):
//   ω = 2     → +1,000,000   exponential reward (asymptotic wins compound
//   ω = 3     →        +1    multiplicatively when recursed at scale)
//   ω = 3.022 →       −12    quadratic penalty: a one-cell perturbation
//   ω = 4     →   −27,777    off the naive baseline registers softly,
//   ω = 9     → −1,000,000   while a really bad board hits the floor.
//   ω > 9     → clamped
// Quadratic on the bad side keeps small overshoots from feeling like a
// catastrophe — the player is usually exploring just above schoolbook.
export function computeScore(omega: number): number {
	if (!Number.isFinite(omega)) return 0;
	if (omega <= 3) {
		// 6 decades over a 1-unit window: ω=3 → 1, ω=2 → 10^6.
		const exp = Math.min(6, 6 * (3 - omega));
		const magnitude = Math.pow(10, exp) - 1;
		return Math.round(magnitude) + 1;
	}
	const overshoot = Math.min(6, omega - 3);
	const loss = (overshoot / 6) ** 2 * 1_000_001;
	return Math.round(Math.max(-1_000_000, 1 - loss));
}

// Strassen's rank-7 algorithm for <2, 2, 2>. Returns null when not applicable.
export function loadStrassen(mnp: Mnp): { A: Int8Array; B: Int8Array; C: Int8Array } | null {
	const { m, n, p, R } = mnp;
	if (m !== 2 || n !== 2 || p !== 2 || R < 7) return null;
	// Index helpers for 2x2: pos(i,j) = i*2 + j
	const pos = (i: number, j: number) => i * 2 + j;
	const A = new Int8Array(R * 4);
	const B = new Int8Array(R * 4);
	const C = new Int8Array(R * 4);

	// Strassen products M1..M7. (a_ij, b_ij, contributing c_ij as a sum/diff.)
	// M1 = (a11+a22)(b11+b22) -> +c11, +c22
	// M2 = (a21+a22) b11      -> +c21, -c22
	// M3 = a11(b12-b22)       -> +c12, +c22
	// M4 = a22(b21-b11)       -> +c11, +c21
	// M5 = (a11+a12) b22      -> -c11, +c12
	// M6 = (a21-a11)(b11+b12) -> +c22
	// M7 = (a12-a22)(b21+b22) -> +c11
	const products: Array<[Record<string, number>, Record<string, number>, Record<string, number>]> = [
		// [aTerms, bTerms, cTerms] keyed by "i,j" -> coefficient
		[{ '0,0': 1, '1,1': 1 }, { '0,0': 1, '1,1': 1 }, { '0,0': 1, '1,1': 1 }],
		[{ '1,0': 1, '1,1': 1 }, { '0,0': 1 }, { '1,0': 1, '1,1': -1 }],
		[{ '0,0': 1 }, { '0,1': 1, '1,1': -1 }, { '0,1': 1, '1,1': 1 }],
		[{ '1,1': 1 }, { '1,0': 1, '0,0': -1 }, { '0,0': 1, '1,0': 1 }],
		[{ '0,0': 1, '0,1': 1 }, { '1,1': 1 }, { '0,0': -1, '0,1': 1 }],
		[{ '1,0': 1, '0,0': -1 }, { '0,0': 1, '0,1': 1 }, { '1,1': 1 }],
		[{ '0,1': 1, '1,1': -1 }, { '1,0': 1, '1,1': 1 }, { '0,0': 1 }]
	];

	for (let r = 0; r < 7; r++) {
		const [aT, bT, cT] = products[r];
		for (const k in aT) {
			const [i, j] = k.split(',').map(Number);
			A[r * 4 + pos(i, j)] = aT[k];
		}
		for (const k in bT) {
			const [i, j] = k.split(',').map(Number);
			B[r * 4 + pos(i, j)] = bT[k];
		}
		for (const k in cT) {
			const [i, j] = k.split(',').map(Number);
			C[r * 4 + pos(i, j)] = cT[k];
		}
	}
	return { A, B, C };
}
