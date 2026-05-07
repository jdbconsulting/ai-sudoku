// Curated leaderboard of named matrix-multiplication algorithms over
// {-1, 0, +1}. Each entry is "applied" to a fresh GameState by calling
// the relevant loader on it, so the high score board doubles as a
// launcher: clicking Play opens a new tab with the boards already
// populated.

import type { GameState } from './state.svelte';
import { ALPHATENSOR_PRESETS } from './alphatensor';
import { computeOmega, computeScore } from './tensor';

export type HighScore = {
	author: string;
	year: number;
	sourceUrl: string;
	m: number;
	n: number;
	p: number;
	R: number;
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
	...rate(at.m, at.n, at.p, at.R),
	apply: (g) => {
		g.loadAlphaTensor(at.m, at.n, at.p);
	}
}));

// Sort by score descending so the leaderboard reads like a real high
// score table — best at the top. The displayed score is rounded, so a
// few entries inevitably tie (e.g. Strassen <2,2,2> R=7 and AlphaTensor
// <4,4,4> R=49 are both ω≈2.807 since 49 = 7²); fall back to the raw
// ω, then to m·n·p, to keep the ordering meaningful and deterministic.
export const HIGH_SCORES: ReadonlyArray<HighScore> = [STRASSEN, ...ALPHATENSOR].sort((a, b) => {
	if (a.score !== b.score) return b.score - a.score;
	if (a.omega !== b.omega) return a.omega - b.omega;
	return a.m * a.n * a.p - b.m * b.n * b.p;
});
