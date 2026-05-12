// Curated leaderboard of named matrix-multiplication algorithms. Most
// entries live in the classical {−1, 0, +1} alphabet (Strassen,
// Laderman, the hand-curated `famous.ts` registry, and the bulk of
// the AlphaTensor release); a curated handful of AlphaTensor rows use
// the wider {−2..+2} alphabet — see `alphatensor.ts` for which sizes.
// Each entry is "applied" to a fresh GameState by calling the
// relevant loader on it, so the high score board doubles as a
// launcher: clicking Play opens a new tab with the boards already
// populated and the alphabet correctly set.

import type { GameState } from './state.svelte';
import { ALPHATENSOR_PRESETS } from './alphatensor';
import { DEFAULT_ALPHABET, type Alphabet } from './alphabets';
import { FAMOUS_ALGORITHMS } from './famous';
import { FLIPGRAPH_PRESETS } from './flipgraph';
import { computeOmega, computeScore } from './tensor';

export type HighScore = {
	author: string;
	year: number;
	sourceUrl: string;
	m: number;
	n: number;
	p: number;
	R: number;
	// Cell alphabet the factor entries live in. Defaults to the
	// classical {−1, 0, +1} when omitted; only the curated wider-
	// alphabet AlphaTensor presets carry a non-default value.
	alphabet: Alphabet;
	// Pre-rated using this game's scoring system. All entries shipped here
	// are exact factorizations (residual = 0), so R_eff = R and omega/score
	// can be precomputed once at module load.
	omega: number;
	score: number;
	// Apply this entry to the given (presumed fresh) GameState. Resizes the
	// board to the entry's <m, n, p> first and overwrites all three boards.
	apply: (game: GameState) => void;
};

function rate(m: number, n: number, p: number, R: number): { omega: number; score: number } {
	const omega = computeOmega(m, n, p, R);
	return { omega, score: computeScore(omega) };
}

const STRASSEN: HighScore = (() => {
	const m = 2,
		n = 2,
		p = 2,
		R = 7;
	return {
		author: 'Strassen',
		year: 1969,
		sourceUrl: 'https://en.wikipedia.org/wiki/Strassen_algorithm',
		m,
		n,
		p,
		R,
		alphabet: DEFAULT_ALPHABET,
		...rate(m, n, p, R),
		apply: (g) => {
			g.resize(m, n, p, { fillNaive: false });
			g.loadStrassen();
		}
	};
})();

const ALPHATENSOR: HighScore[] = ALPHATENSOR_PRESETS.map((at) => ({
	author: 'AlphaTensor',
	year: 2022,
	sourceUrl: 'https://www.nature.com/articles/s41586-022-05172-4',
	m: at.m,
	n: at.n,
	p: at.p,
	R: at.R,
	alphabet: at.alphabet ?? DEFAULT_ALPHABET,
	...rate(at.m, at.n, at.p, at.R),
	apply: (g) => {
		g.loadAlphaTensor(at.m, at.n, at.p);
	}
}));

// Hand-curated classical algorithms from famous.ts. Each registry entry
// already carries author/year/source metadata and a verified factorization,
// so the mapping to a HighScore row is mechanical. Every one of these
// uses the classical {−1, 0, +1} alphabet (see famous.ts).
const FAMOUS: HighScore[] = FAMOUS_ALGORITHMS.map((alg) => ({
	author: alg.author,
	year: alg.year,
	sourceUrl: alg.sourceUrl,
	m: alg.m,
	n: alg.n,
	p: alg.p,
	R: alg.R,
	alphabet: DEFAULT_ALPHABET,
	...rate(alg.m, alg.n, alg.p, alg.R),
	apply: (g) => {
		g.loadFamous(alg.id);
	}
}));

// Flip-graph–discovered algorithms from the Moosbauer-Poole / Kauers-Wood
// lineage. Each paper contributes one or two large factorizations rather
// than a full catalogue, so the preset records carry per-row attribution
// directly and we just map them straight onto HighScore rows.
const FLIPGRAPH: HighScore[] = FLIPGRAPH_PRESETS.map((fg) => ({
	author: fg.author,
	year: fg.year,
	sourceUrl: fg.sourceUrl,
	m: fg.m,
	n: fg.n,
	p: fg.p,
	R: fg.R,
	alphabet: fg.alphabet ?? DEFAULT_ALPHABET,
	...rate(fg.m, fg.n, fg.p, fg.R),
	apply: (g) => {
		g.loadFlipGraph(fg.id);
	}
}));

// Sort by score descending so the leaderboard reads like a real high
// score table — best at the top. The displayed score is rounded, so a
// few entries inevitably tie (e.g. Strassen <2,2,2> R=7 and AlphaTensor
// <4,4,4> R=49 are both ω≈2.807 since 49 = 7²); fall back to the raw
// ω, then to m·n·p, to keep the ordering meaningful and deterministic.
export const HIGH_SCORES: ReadonlyArray<HighScore> = [
	STRASSEN,
	...FAMOUS,
	...ALPHATENSOR,
	...FLIPGRAPH
].sort(
	(a, b) => {
		if (a.score !== b.score) return b.score - a.score;
		if (a.omega !== b.omega) return a.omega - b.omega;
		return a.m * a.n * a.p - b.m * b.n * b.p;
	}
);
