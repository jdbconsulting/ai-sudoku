// Lightweight, fire-and-forget usage telemetry. Posts a single event
// every time the player starts a game (new tab, resize, or replay) so
// we can answer questions like "which board sizes are most popular?"
// or "do mobile users actually try ⟨5,5,5⟩?" without bolting on a
// third-party analytics SDK.
//
// Design rules:
//   - Errors are silently swallowed. Telemetry MUST NOT break gameplay.
//   - We use `fetch` with `keepalive: true` and `credentials: 'omit'`.
//     `keepalive` gives the same "request survives the document"
//     guarantee as `navigator.sendBeacon`. `credentials: 'omit'` is
//     the critical bit: sendBeacon's credentials mode is *fixed at*
//     "include" by spec, so when the API origin sits on a different
//     domain (Lambda Function URL) the browser refuses the response
//     unless the server returns `Access-Control-Allow-Credentials:
//     true` plus a non-wildcard `Access-Control-Allow-Origin`. The
//     leaderboard Lambda intentionally serves `Access-Control-Allow-
//     Origin: *` (no auth, no cookies) and never sets the credentials
//     header, so we must opt out of credentials on the client side
//     instead of bolting it onto the server CORS config.
//   - When PUBLIC_API_URL is unset (local dev / preview deploys without
//     a backend), every call is a no-op.
//   - We never send anything beyond the player's choice of m/n/p and a
//     fixed source enum. The server adds IP-prefix and User-Agent on
//     its end from the request envelope.

import { env } from '$env/dynamic/public';

const API_BASE: string = (env.PUBLIC_API_URL ?? '').replace(/\/+$/, '');
const ENDPOINT = `${API_BASE}/events/game-started`;
const enabled: boolean = API_BASE.length > 0;

export type GameStartedSource = 'new' | 'resize' | 'famous' | 'replay';

export function logGameStarted(
	m: number,
	n: number,
	p: number,
	source: GameStartedSource
): void {
	if (!enabled) return;
	if (typeof window === 'undefined') return; // SSR / prerender

	const payload = JSON.stringify({ m, n, p, source });

	try {
		// `keepalive: true` lets the request outlive the document, so a
		// click that *also* navigates away won't drop the event — same
		// survival guarantee that motivated the previous `sendBeacon`
		// path. `credentials: 'omit'` keeps the request out of the
		// credentialed-CORS code path so the Lambda's wildcard
		// `Access-Control-Allow-Origin: *` is sufficient.
		void fetch(ENDPOINT, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: payload,
			keepalive: true,
			credentials: 'omit',
			mode: 'cors'
			// No Authorization header — this endpoint is intentionally
			// public, just like the leaderboard reads.
		}).catch(() => {
			// Telemetry failures are not user-visible. Even logging to
			// console here would just be noise.
		});
	} catch {
		// Defensive: e.g. a "SecurityError" thrown synchronously by
		// fetch inside a sandboxed iframe. Eat it.
	}
}
