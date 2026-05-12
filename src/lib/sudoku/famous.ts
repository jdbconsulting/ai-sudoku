// Curated registry of named matrix-multiplication algorithms whose factor
// matrices live entirely in {-1, 0, +1}. AlphaTensor's catalogue is shipped
// separately in alphatensor.ts (it's auto-extracted from DeepMind's release
// and lives in a compact string format suited for the ~150 boards). This
// module is for hand-curated classical results that don't fit that pipeline.
//
// Each algorithm is encoded as an array of R rank-1 terms, where each term
// names the (i,j)→coefficient pairs in its A/B/C factor. The format mirrors
// the inline dictionary used by loadStrassen() in tensor.ts so the encoding
// stays readable side-by-side with the original paper formulas.
//
// IMPORTANT: every algorithm registered here is verified against the matmul
// tensor (residual must be exactly zero) at module load. A typo in any
// coefficient throws immediately with a pointer to the offending preset,
// so silent corruption can't leak into the high score board.

import { computeResidual, computeTargetTensor } from './tensor';

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

// Sparse coefficient: [row, col, value]. Value is typically ±1; values
// outside {-1, 0, +1} are rejected by the verifier since the player's grid
// can't represent them.
export type Coeff = readonly [number, number, number];

export type RankTerm = {
	a: ReadonlyArray<Coeff>;
	b: ReadonlyArray<Coeff>;
	c: ReadonlyArray<Coeff>;
};

export type FamousAlgorithm = {
	id: string; // stable URL-safe identifier, used by GameState.loadFamous()
	author: string; // display name (e.g. "Laderman")
	year: number;
	sourceUrl: string;
	m: number;
	n: number;
	p: number;
	R: number; // = terms.length, defended by the verifier
	terms: ReadonlyArray<RankTerm>;
};

// ---------------------------------------------------------------------------
// Laderman 1976 — <3,3,3> in 23 multiplications
// ---------------------------------------------------------------------------
// Source: J. D. Laderman, "A noncommutative algorithm for multiplying (3 × 3)
// matrices using 23 multiplications," Bull. Amer. Math. Soc. 82(1):126-128
// (1976). Coefficients reproduced from the standard 0-indexed C++ form
// widely circulated since (e.g. Hooked's StackOverflow benchmark, 2012).
//
// All A/B factor coefficients are in {-1, 0, +1}; all C-side combiners are
// {0, +1} (no subtractions in the result-recovery formulas).

const LADERMAN_3x3x3: FamousAlgorithm = {
	id: 'laderman-3x3x3',
	author: 'Laderman',
	year: 1976,
	sourceUrl: 'https://www.ams.org/journals/bull/1976-82-01/S0002-9904-1976-13988-2/',
	m: 3,
	n: 3,
	p: 3,
	R: 23,
	terms: [
		// m1 = (a00+a01+a02-a10-a11-a21-a22) * b11  →  c01
		{
			a: [
				[0, 0, 1],
				[0, 1, 1],
				[0, 2, 1],
				[1, 0, -1],
				[1, 1, -1],
				[2, 1, -1],
				[2, 2, -1]
			],
			b: [[1, 1, 1]],
			c: [[0, 1, 1]]
		},
		// m2 = (a00-a10) * (-b01+b11)  →  c10, c11
		{
			a: [
				[0, 0, 1],
				[1, 0, -1]
			],
			b: [
				[0, 1, -1],
				[1, 1, 1]
			],
			c: [
				[1, 0, 1],
				[1, 1, 1]
			]
		},
		// m3 = a11 * (-b00+b01+b10-b11-b12-b20+b22)  →  c10
		{
			a: [[1, 1, 1]],
			b: [
				[0, 0, -1],
				[0, 1, 1],
				[1, 0, 1],
				[1, 1, -1],
				[1, 2, -1],
				[2, 0, -1],
				[2, 2, 1]
			],
			c: [[1, 0, 1]]
		},
		// m4 = (-a00+a10+a11) * (b00-b01+b11)  →  c01, c10, c11
		{
			a: [
				[0, 0, -1],
				[1, 0, 1],
				[1, 1, 1]
			],
			b: [
				[0, 0, 1],
				[0, 1, -1],
				[1, 1, 1]
			],
			c: [
				[0, 1, 1],
				[1, 0, 1],
				[1, 1, 1]
			]
		},
		// m5 = (a10+a11) * (-b00+b01)  →  c01, c11
		{
			a: [
				[1, 0, 1],
				[1, 1, 1]
			],
			b: [
				[0, 0, -1],
				[0, 1, 1]
			],
			c: [
				[0, 1, 1],
				[1, 1, 1]
			]
		},
		// m6 = a00 * b00  →  c00, c01, c02, c10, c11, c20, c22
		{
			a: [[0, 0, 1]],
			b: [[0, 0, 1]],
			c: [
				[0, 0, 1],
				[0, 1, 1],
				[0, 2, 1],
				[1, 0, 1],
				[1, 1, 1],
				[2, 0, 1],
				[2, 2, 1]
			]
		},
		// m7 = (-a00+a20+a21) * (b00-b02+b12)  →  c02, c20, c22
		{
			a: [
				[0, 0, -1],
				[2, 0, 1],
				[2, 1, 1]
			],
			b: [
				[0, 0, 1],
				[0, 2, -1],
				[1, 2, 1]
			],
			c: [
				[0, 2, 1],
				[2, 0, 1],
				[2, 2, 1]
			]
		},
		// m8 = (-a00+a20) * (b02-b12)  →  c20, c22
		{
			a: [
				[0, 0, -1],
				[2, 0, 1]
			],
			b: [
				[0, 2, 1],
				[1, 2, -1]
			],
			c: [
				[2, 0, 1],
				[2, 2, 1]
			]
		},
		// m9 = (a20+a21) * (-b00+b02)  →  c02, c22
		{
			a: [
				[2, 0, 1],
				[2, 1, 1]
			],
			b: [
				[0, 0, -1],
				[0, 2, 1]
			],
			c: [
				[0, 2, 1],
				[2, 2, 1]
			]
		},
		// m10 = (a00+a01+a02-a11-a12-a20-a21) * b12  →  c02
		{
			a: [
				[0, 0, 1],
				[0, 1, 1],
				[0, 2, 1],
				[1, 1, -1],
				[1, 2, -1],
				[2, 0, -1],
				[2, 1, -1]
			],
			b: [[1, 2, 1]],
			c: [[0, 2, 1]]
		},
		// m11 = a21 * (-b00+b02+b10-b11-b12-b20+b21)  →  c20
		{
			a: [[2, 1, 1]],
			b: [
				[0, 0, -1],
				[0, 2, 1],
				[1, 0, 1],
				[1, 1, -1],
				[1, 2, -1],
				[2, 0, -1],
				[2, 1, 1]
			],
			c: [[2, 0, 1]]
		},
		// m12 = (-a02+a21+a22) * (b11+b20-b21)  →  c01, c20, c21
		{
			a: [
				[0, 2, -1],
				[2, 1, 1],
				[2, 2, 1]
			],
			b: [
				[1, 1, 1],
				[2, 0, 1],
				[2, 1, -1]
			],
			c: [
				[0, 1, 1],
				[2, 0, 1],
				[2, 1, 1]
			]
		},
		// m13 = (a02-a22) * (b11-b21)  →  c20, c21
		{
			a: [
				[0, 2, 1],
				[2, 2, -1]
			],
			b: [
				[1, 1, 1],
				[2, 1, -1]
			],
			c: [
				[2, 0, 1],
				[2, 1, 1]
			]
		},
		// m14 = a02 * b20  →  c00, c01, c02, c10, c12, c20, c21
		{
			a: [[0, 2, 1]],
			b: [[2, 0, 1]],
			c: [
				[0, 0, 1],
				[0, 1, 1],
				[0, 2, 1],
				[1, 0, 1],
				[1, 2, 1],
				[2, 0, 1],
				[2, 1, 1]
			]
		},
		// m15 = (a21+a22) * (-b20+b21)  →  c01, c21
		{
			a: [
				[2, 1, 1],
				[2, 2, 1]
			],
			b: [
				[2, 0, -1],
				[2, 1, 1]
			],
			c: [
				[0, 1, 1],
				[2, 1, 1]
			]
		},
		// m16 = (-a02+a11+a12) * (b12+b20-b22)  →  c02, c10, c12
		{
			a: [
				[0, 2, -1],
				[1, 1, 1],
				[1, 2, 1]
			],
			b: [
				[1, 2, 1],
				[2, 0, 1],
				[2, 2, -1]
			],
			c: [
				[0, 2, 1],
				[1, 0, 1],
				[1, 2, 1]
			]
		},
		// m17 = (a02-a12) * (b12-b22)  →  c10, c12
		{
			a: [
				[0, 2, 1],
				[1, 2, -1]
			],
			b: [
				[1, 2, 1],
				[2, 2, -1]
			],
			c: [
				[1, 0, 1],
				[1, 2, 1]
			]
		},
		// m18 = (a11+a12) * (-b20+b22)  →  c02, c12
		{
			a: [
				[1, 1, 1],
				[1, 2, 1]
			],
			b: [
				[2, 0, -1],
				[2, 2, 1]
			],
			c: [
				[0, 2, 1],
				[1, 2, 1]
			]
		},
		// m19 = a01 * b10  →  c00
		{ a: [[0, 1, 1]], b: [[1, 0, 1]], c: [[0, 0, 1]] },
		// m20 = a12 * b21  →  c11
		{ a: [[1, 2, 1]], b: [[2, 1, 1]], c: [[1, 1, 1]] },
		// m21 = a10 * b02  →  c12
		{ a: [[1, 0, 1]], b: [[0, 2, 1]], c: [[1, 2, 1]] },
		// m22 = a20 * b01  →  c21
		{ a: [[2, 0, 1]], b: [[0, 1, 1]], c: [[2, 1, 1]] },
		// m23 = a22 * b22  →  c22
		{ a: [[2, 2, 1]], b: [[2, 2, 1]], c: [[2, 2, 1]] }
	]
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const FAMOUS_ALGORITHMS: ReadonlyArray<FamousAlgorithm> = [LADERMAN_3x3x3];

export function findFamousAlgorithm(id: string): FamousAlgorithm | null {
	return FAMOUS_ALGORITHMS.find((a) => a.id === id) ?? null;
}

// ---------------------------------------------------------------------------
// Build & verify
// ---------------------------------------------------------------------------

// Materialise the spec into the same flat Float32Array layout that
// GameState uses internally. Buffers are sized for the schoolbook
// m·n·p slots; only the first R slots are populated, leaving the
// trailing pages zero-filled so the player sees a "fewer pages used"
// board straight away.
export function buildFactors(alg: FamousAlgorithm): {
	A: Float32Array;
	B: Float32Array;
	C: Float32Array;
} {
	const { m, n, p, R, terms } = alg;
	const slots = m * n * p;
	const A = new Float32Array(slots * m * n);
	const B = new Float32Array(slots * n * p);
	const C = new Float32Array(slots * m * p);
	for (let r = 0; r < R; r++) {
		const t = terms[r];
		for (const [i, j, v] of t.a) A[r * (m * n) + i * n + j] = v;
		for (const [j, l, v] of t.b) B[r * (n * p) + j * p + l] = v;
		for (const [i, l, v] of t.c) C[r * (m * p) + i * p + l] = v;
	}
	return { A, B, C };
}

// Validate a preset by reconstructing the matmul tensor from its rank-1
// outer products and checking the residual is identically zero. Returns
// null on success or a human-readable description of the first mismatch.
export function verifyFamous(alg: FamousAlgorithm): string | null {
	if (alg.terms.length !== alg.R) {
		return `${alg.id}: expected R=${alg.R} terms, got ${alg.terms.length}`;
	}
	const { m, n, p } = alg;
	for (let r = 0; r < alg.R; r++) {
		const t = alg.terms[r];
		for (const [i, j, v] of t.a) {
			if (i < 0 || i >= m || j < 0 || j >= n)
				return `${alg.id}: term ${r + 1} A coord (${i},${j}) out of bounds`;
			if (v !== -1 && v !== 0 && v !== 1)
				return `${alg.id}: term ${r + 1} A value ${v} not in {-1,0,1}`;
		}
		for (const [j, l, v] of t.b) {
			if (j < 0 || j >= n || l < 0 || l >= p)
				return `${alg.id}: term ${r + 1} B coord (${j},${l}) out of bounds`;
			if (v !== -1 && v !== 0 && v !== 1)
				return `${alg.id}: term ${r + 1} B value ${v} not in {-1,0,1}`;
		}
		for (const [i, l, v] of t.c) {
			if (i < 0 || i >= m || l < 0 || l >= p)
				return `${alg.id}: term ${r + 1} C coord (${i},${l}) out of bounds`;
			if (v !== -1 && v !== 0 && v !== 1)
				return `${alg.id}: term ${r + 1} C value ${v} not in {-1,0,1}`;
		}
	}
	const T = computeTargetTensor(m, n, p);
	const { A, B, C } = buildFactors(alg);
	const G = computeResidual({ m, n, p, R: m * n * p }, A, B, C, T);
	for (let i = 0; i < G.length; i++) {
		if (G[i] !== 0) {
			return `${alg.id}: residual not zero at flat index ${i} (value ${G[i]})`;
		}
	}
	return null;
}

// Run the verifier against every registered algorithm at module load. The
// algorithms are tiny (<3,3,3> R=23 means ~700 tensor cells), so the cost
// is negligible — far cheaper than mounting a single Svelte component —
// and the protection against silent corruption is well worth it.
for (const alg of FAMOUS_ALGORITHMS) {
	const err = verifyFamous(alg);
	if (err) throw new Error(`famous.ts self-check failed: ${err}`);
}
