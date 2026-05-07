// Lightweight, fire-and-forget usage telemetry. Posts a single event
// every time the player starts a game (new tab, resize, or replay) so
// we can answer questions like "which board sizes are most popular?"
// or "do mobile users actually try ⟨5,5,5⟩?" without bolting on a
// third-party analytics SDK.
//
// Design rules:
//   - Errors are silently swallowed. Telemetry MUST NOT break gameplay.
//   - We use `navigator.sendBeacon` first because it's specifically
//     designed for this case: the request goes out reliably even if the
//     user navigates away in the same tick. Fallback to `fetch` with
//     `keepalive: true` for the few environments without sendBeacon.
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
		// `navigator.sendBeacon` is the right tool: the browser commits
		// to delivering the request and queues it independently of the
		// page's lifecycle (so e.g. a click that *also* navigates away
		// won't drop the event). It returns false if the body was too
		// large for the user agent's queue — in practice our payloads
		// are <100 bytes, so this only flips false on very old browsers.
		if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
			// Beacon needs a Blob to control the Content-Type; otherwise
			// it sends as text/plain, which our handler still parses
			// fine but the type sets a better example for any future
			// API gateway in front of us.
			const blob = new Blob([payload], { type: 'application/json' });
			if (navigator.sendBeacon(ENDPOINT, blob)) return;
		}

		// Fallback: keepalive fetch. `keepalive: true` lets the request
		// outlive the document — same survival guarantee as sendBeacon
		// for our purposes. `void` makes the discarded Promise explicit.
		void fetch(ENDPOINT, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: payload,
			keepalive: true
			// No Authorization header — this endpoint is intentionally
			// public, just like the leaderboard reads. CORS is handled
			// by the Lambda Function URL config.
		}).catch(() => {
			// Telemetry failures are not user-visible. Even logging to
			// console here would just be noise.
		});
	} catch {
		// Defensive: the worst Blob/sendBeacon throw I've seen in the
		// wild is a "SecurityError" inside a sandboxed iframe. Eat it.
	}
}
