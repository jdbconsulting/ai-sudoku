// API client for the Lambda-backed leaderboard. Pure functions over
// `fetch` — no Svelte state in here, callers wrap in $state at the
// component layer.
//
// The base URL comes from SvelteKit's compile-time `$env/static/public`
// so it gets baked into the static GitHub Pages build at build time.
// When the env var is unset (e.g. local dev without a Lambda deployed)
// every call resolves to the `disabled` shape so the UI can degrade
// gracefully instead of throwing.

import { env } from '$env/dynamic/public';
import type { GameState } from './state.svelte';

// Read at module load. SvelteKit replaces `$env/dynamic/public.PUBLIC_*`
// at build/runtime depending on adapter; for adapter-static this is
// effectively a build-time substitution from `import.meta.env`, which
// reads `process.env.PUBLIC_API_URL` during `vite build`.
const API_BASE: string = (env.PUBLIC_API_URL ?? '').replace(/\/+$/, '');

export const apiEnabled: boolean = API_BASE.length > 0;

// ---------------------------------------------------------------------------
// Types — must match the Lambda's response shapes (see infra/api/handler.ts).
// ---------------------------------------------------------------------------

export type LeaderboardEntry = {
	id: string;
	username: string;
	m: number;
	n: number;
	p: number;
	R: number;
	Reff: number;
	omega: number;
	score: number;
	solved: boolean;
	submittedAt: string;
};

export type SubmitResult = LeaderboardEntry;

export class LeaderboardError extends Error {
	readonly status: number;
	constructor(message: string, status = 0) {
		super(message);
		this.name = 'LeaderboardError';
		this.status = status;
	}
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export async function fetchTopScores(signal?: AbortSignal): Promise<LeaderboardEntry[]> {
	if (!apiEnabled) return [];
	const res = await fetch(`${API_BASE}/scores/top`, {
		method: 'GET',
		signal,
		headers: { accept: 'application/json' }
	});
	if (!res.ok) {
		throw new LeaderboardError(await readError(res), res.status);
	}
	const body = (await res.json()) as { entries?: LeaderboardEntry[] };
	return body.entries ?? [];
}

export async function submitScore(
	username: string,
	game: GameState,
	signal?: AbortSignal
): Promise<SubmitResult> {
	if (!apiEnabled) {
		throw new LeaderboardError('Leaderboard API is not configured for this build', 0);
	}
	// We send the raw boards as plain JSON arrays of integers. Even at
	// max <8,8,8> this is ~10 KB compressed, well inside fetch limits.
	// The server recomputes the score from scratch — the only thing we
	// don't bother sending is the score itself.
	const payload = {
		username,
		m: game.m,
		n: game.n,
		p: game.p,
		A: Array.from(game.A),
		B: Array.from(game.B),
		C: Array.from(game.C)
	};
	const res = await fetch(`${API_BASE}/scores`, {
		method: 'POST',
		signal,
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify(payload)
	});
	if (!res.ok) {
		throw new LeaderboardError(await readError(res), res.status);
	}
	return (await res.json()) as SubmitResult;
}

async function readError(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: string };
		if (body && typeof body.error === 'string') return body.error;
	} catch {
		// fall through
	}
	return `request failed with status ${res.status}`;
}

// ---------------------------------------------------------------------------
// Username persistence — localStorage. Lives in this module so the
// Game.svelte and HighScoreBoard.svelte components don't have to know
// the storage key, and so a future move to (e.g.) IndexedDB only
// touches one file.
// ---------------------------------------------------------------------------

const USERNAME_KEY = 'ai-sudoku.username';

export function loadStoredUsername(): string {
	if (typeof localStorage === 'undefined') return '';
	try {
		return localStorage.getItem(USERNAME_KEY) ?? '';
	} catch {
		return '';
	}
}

export function saveStoredUsername(username: string): void {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(USERNAME_KEY, username);
	} catch {
		// quota exceeded / private mode — non-fatal
	}
}
