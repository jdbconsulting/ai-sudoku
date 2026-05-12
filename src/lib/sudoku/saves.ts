// Browser-local "saved games" store. Lets the player snapshot a
// partially-solved puzzle under a chosen name and resume it later
// from the New Game tab. We use `localStorage` rather than cookies
// because a saved board can run into ~100 KB of JSON (a ⟨6,6,6⟩
// snapshot is on the order of 23k cells) — well past what cookies
// can hold and not something we want to ship on every HTTP request.
//
// Storage layout (all keys live under the `ai-sudoku:` namespace so
// they don't collide with anything else the browser remembers for
// this origin):
//
//   ai-sudoku:saves:index → JSON SaveMeta[]   (newest first)
//   ai-sudoku:save:<name> → JSON SolutionFile (one per saved game)
//
// The index is denormalized — it carries enough metadata (dims,
// score, ω, solved, savedAt) to render the picker list without
// parsing each save's full JSON body. The bodies themselves are
// untouched `SolutionFile` blobs and round-trip through the same
// `loadSolutionJSON` parser the existing file-import path uses, so
// any save written here can also be exported to disk and vice
// versa — no separate schema to keep in lockstep.

import type { SolutionFile } from './state.svelte';

const INDEX_KEY = 'ai-sudoku:saves:index';
const ITEM_PREFIX = 'ai-sudoku:save:';

export type SaveMeta = {
	// User-chosen identifier. Doubles as the localStorage key
	// suffix; uniqueness is enforced by `putSave` (a put with an
	// existing name overwrites the previous body and bumps the
	// row to the top of the list).
	name: string;
	m: number;
	n: number;
	p: number;
	R: number;
	// Headline player-facing stats at save time. None of these are
	// in `SolutionFile` itself (the file just carries the raw
	// boards), so they have to be snapshotted explicitly here for
	// the picker to show "score 14, solved ★" without rebuilding
	// the full GameState off-screen for every row.
	score: number;
	omega: number;
	solved: boolean;
	// ms since epoch. Stored numerically so the picker can sort
	// without re-parsing date strings.
	savedAt: number;
};

// SSR guard. All entry points are idempotent no-ops outside the
// browser so callers don't need their own `typeof window` check.
function isBrowser(): boolean {
	return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function listSaves(): SaveMeta[] {
	if (!isBrowser()) return [];
	try {
		const raw = localStorage.getItem(INDEX_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		// Defensive filter: discard rows that don't look like
		// SaveMeta — keeps a hand-edited (or corrupted) index from
		// poisoning the picker. We intentionally don't *repair*
		// the index here; the next successful `putSave` /
		// `deleteSave` will rewrite a clean version.
		return parsed.filter((s): s is SaveMeta => {
			if (!s || typeof s !== 'object') return false;
			const o = s as Record<string, unknown>;
			return (
				typeof o.name === 'string' &&
				typeof o.m === 'number' &&
				typeof o.n === 'number' &&
				typeof o.p === 'number' &&
				typeof o.savedAt === 'number'
			);
		});
	} catch {
		return [];
	}
}

export function getSave(name: string): SolutionFile | null {
	if (!isBrowser()) return null;
	try {
		const raw = localStorage.getItem(ITEM_PREFIX + name);
		if (!raw) return null;
		return JSON.parse(raw) as SolutionFile;
	} catch {
		return null;
	}
}

export function saveExists(name: string): boolean {
	return listSaves().some((s) => s.name === name);
}

type PutResult = { ok: true } | { ok: false; error: string };

export function putSave(meta: SaveMeta, file: SolutionFile): PutResult {
	if (!isBrowser()) {
		return { ok: false, error: 'Saving requires a browser environment.' };
	}
	// Write the body first so a quota failure leaves the index
	// untouched (preferable to a "ghost" index row pointing at a
	// missing body). The two writes are not atomic, but the worst
	// case is the inverse — index updated, body write succeeded —
	// which is the same as a clean save.
	try {
		localStorage.setItem(ITEM_PREFIX + meta.name, JSON.stringify(file));
	} catch (e) {
		return { ok: false, error: `Could not save: ${(e as Error).message}` };
	}
	const others = listSaves().filter((s) => s.name !== meta.name);
	const next = [meta, ...others];
	try {
		localStorage.setItem(INDEX_KEY, JSON.stringify(next));
	} catch (e) {
		return { ok: false, error: `Index update failed: ${(e as Error).message}` };
	}
	return { ok: true };
}

export function deleteSave(name: string): void {
	if (!isBrowser()) return;
	try {
		localStorage.removeItem(ITEM_PREFIX + name);
	} catch {
		// Removal can't really fail under the standard storage API,
		// but disabled-storage shims sometimes throw — eat it.
	}
	const next = listSaves().filter((s) => s.name !== name);
	try {
		localStorage.setItem(INDEX_KEY, JSON.stringify(next));
	} catch {
		// Same defence — if the index write fails, the row will
		// reappear in the picker on next load, but `getSave` will
		// return null and the row's "Load" button will surface an
		// error there. Strictly better than crashing the page.
	}
}

// Suggest a default save name for a fresh "Save to browser" prompt.
// Format: `<m>×<n>×<p> · score N · 2026-05-12 00:33` (local time).
// The player can edit it freely before confirming.
export function suggestSaveName(m: number, n: number, p: number, score: number): string {
	const stamp = formatLocalStamp(new Date());
	const scoreText = Number.isFinite(score) ? `score ${score}` : 'unscored';
	return `${m}×${n}×${p} · ${scoreText} · ${stamp}`;
}

// Local time formatter for the suggested save name and the picker
// row's "saved at" caption. Browser locale would round-trip badly
// across the export → import path (US vs EU date order), so we use
// a deterministic ISO-ish form: `YYYY-MM-DD HH:MM`.
export function formatLocalStamp(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		` ${pad(d.getHours())}:${pad(d.getMinutes())}`
	);
}
