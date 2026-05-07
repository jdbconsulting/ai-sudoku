// Username + submission validation. Pure, no I/O — keeps the handler
// thin and the rules easy to audit/test in one place.

// Reserved names that would mislead the leaderboard if a player claimed
// them. Matched case-insensitively after sanitization. Not a moderation
// system — that's not what this is — just a small list to keep the
// "Famous Algorithms" players from being impersonated on row one.
const RESERVED_NAMES = new Set([
	'strassen',
	'alphatensor',
	'alpha tensor',
	'deepmind',
	'deep mind',
	'admin',
	'administrator',
	'system',
	'root',
	'moderator',
	'mod',
	'aisudoku',
	'ai sudoku',
	'ai-sudoku'
]);

const USERNAME_MAX = 20;
const USERNAME_MIN = 1;

// Allow-list charset: ASCII letters, digits, space, dash, underscore.
// Conservative on purpose — anything fancier is a future feature, not
// something to debug at 2am because of a Unicode normalization bug.
const USERNAME_CHARS = /^[A-Za-z0-9 _-]+$/;

export function sanitizeUsername(raw: unknown): string {
	if (typeof raw !== 'string') {
		throw new ValidationError('username must be a string');
	}
	// Strip surrounding whitespace, collapse internal runs of spaces so
	// "joel    smith" and "joel smith" can't sit at adjacent leaderboard
	// rows pretending to be different people.
	const collapsed = raw.trim().replace(/\s+/g, ' ');
	if (collapsed.length < USERNAME_MIN) {
		throw new ValidationError('username must not be empty');
	}
	if (collapsed.length > USERNAME_MAX) {
		throw new ValidationError(`username must be at most ${USERNAME_MAX} characters`);
	}
	if (!USERNAME_CHARS.test(collapsed)) {
		throw new ValidationError(
			'username may only contain letters, digits, spaces, hyphens, and underscores'
		);
	}
	if (RESERVED_NAMES.has(collapsed.toLowerCase())) {
		throw new ValidationError(`"${collapsed}" is a reserved name; please choose another`);
	}
	return collapsed;
}

// Hard ceiling on board dimensions. The frontend already enforces
// max 8 in the size dropdown; this is the server-side guard so a
// crafted payload can't make us allocate gigabytes for the residual
// tensor (which is O((m·n·p)²) and would melt the Lambda).
const MAX_DIM = 8;
const MIN_DIM = 1;

export type SubmissionPayload = {
	username: string;
	m: number;
	n: number;
	p: number;
	A: Int8Array;
	B: Int8Array;
	C: Int8Array;
};

export class ValidationError extends Error {
	readonly statusCode = 400;
	constructor(message: string) {
		super(message);
		this.name = 'ValidationError';
	}
}

function asDim(name: string, raw: unknown): number {
	if (typeof raw !== 'number' || !Number.isInteger(raw)) {
		throw new ValidationError(`${name} must be an integer`);
	}
	if (raw < MIN_DIM || raw > MAX_DIM) {
		throw new ValidationError(`${name} must be between ${MIN_DIM} and ${MAX_DIM}`);
	}
	return raw;
}

// Convert a JSON array of cell values into a typed Int8Array, validating
// length and that every entry is one of {-1, 0, 1}. Cells outside that
// alphabet would let a clever submitter "cheat" by encoding extra
// information in single cells, which the score formula doesn't anticipate.
function asBoard(name: string, raw: unknown, expectedLen: number): Int8Array {
	if (!Array.isArray(raw)) {
		throw new ValidationError(`${name} must be an array`);
	}
	if (raw.length !== expectedLen) {
		throw new ValidationError(
			`${name} has wrong length: expected ${expectedLen}, got ${raw.length}`
		);
	}
	const out = new Int8Array(expectedLen);
	for (let i = 0; i < expectedLen; i++) {
		const v = raw[i];
		if (v !== -1 && v !== 0 && v !== 1) {
			throw new ValidationError(`${name}[${i}] must be -1, 0, or 1 (got ${JSON.stringify(v)})`);
		}
		out[i] = v;
	}
	return out;
}

export function parseSubmission(body: unknown): SubmissionPayload {
	if (typeof body !== 'object' || body === null) {
		throw new ValidationError('request body must be a JSON object');
	}
	const obj = body as Record<string, unknown>;
	const username = sanitizeUsername(obj.username);
	const m = asDim('m', obj.m);
	const n = asDim('n', obj.n);
	const p = asDim('p', obj.p);
	// R is fixed to m·n·p in the game (the player lowers the *effective*
	// rank by leaving pages blank). We don't accept a client-supplied R —
	// any value would either match this or be a bug.
	const R = m * n * p;
	const A = asBoard('A', obj.A, R * m * n);
	const B = asBoard('B', obj.B, R * n * p);
	const C = asBoard('C', obj.C, R * m * p);
	return { username, m, n, p, A, B, C };
}

// ---------------------------------------------------------------------------
// Usage events
// ---------------------------------------------------------------------------

// Closed set of user actions that produce a "new game" event. Keeping it
// finite (rather than free-form text) makes the analytics queries trivial
// and prevents a misbehaving client from polluting our event stream with
// arbitrary strings.
const GAME_STARTED_SOURCES = new Set([
	'new', // user clicked "+" to open a fresh tab
	'resize', // user clicked "Apply size" or a size preset
	'famous', // user replayed a "Famous Algorithms" entry
	'replay' // user replayed a row from the live High Score Board
] as const);

export type GameStartedSource = 'new' | 'resize' | 'famous' | 'replay';

export type GameStartedEvent = {
	m: number;
	n: number;
	p: number;
	source: GameStartedSource;
};

export function parseGameStartedEvent(body: unknown): GameStartedEvent {
	if (typeof body !== 'object' || body === null) {
		throw new ValidationError('request body must be a JSON object');
	}
	const obj = body as Record<string, unknown>;
	const m = asDim('m', obj.m);
	const n = asDim('n', obj.n);
	const p = asDim('p', obj.p);
	const source = obj.source;
	if (typeof source !== 'string' || !GAME_STARTED_SOURCES.has(source as GameStartedSource)) {
		throw new ValidationError(
			`source must be one of: ${[...GAME_STARTED_SOURCES].join(', ')}`
		);
	}
	return { m, n, p, source: source as GameStartedSource };
}

// Anonymize a client IP to roughly the network prefix:
//   - IPv4 → /24 (drop the host octet): "1.2.3.42"  → "1.2.3.0"
//   - IPv6 → /48 (keep the routing prefix): "2001:db8:abc:1::1" → "2001:db8:abc::"
// This is the GDPR-friendly default — enough resolution to spot regional
// trends and obvious abuse, not enough to identify an individual.
export function truncateIp(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const ip = raw.trim();
	if (ip.length === 0) return undefined;

	if (ip.includes(':')) {
		const groups = expandIpv6(ip);
		if (!groups) return undefined;
		return `${groups[0]}:${groups[1]}:${groups[2]}::`;
	}

	const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
	if (!m) return undefined;
	return `${m[1]}.${m[2]}.${m[3]}.0`;
}

// Expand a possibly-shorthand IPv6 address ("2001:db8::1") to its 8
// hextet groups. Returns null if the input doesn't look like IPv6.
function expandIpv6(ip: string): string[] | null {
	const dcolon = ip.indexOf('::');
	let groups: string[];
	if (dcolon === -1) {
		groups = ip.split(':');
		if (groups.length !== 8) return null;
	} else {
		const leftStr = ip.slice(0, dcolon);
		const rightStr = ip.slice(dcolon + 2);
		const left = leftStr.length === 0 ? [] : leftStr.split(':');
		const right = rightStr.length === 0 ? [] : rightStr.split(':');
		const missing = 8 - left.length - right.length;
		if (missing < 0) return null;
		groups = [...left, ...new Array(missing).fill('0'), ...right];
	}
	return groups.map((g) => {
		// Strip leading zeros for canonical form, but keep "0" as "0".
		if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return '0';
		const trimmed = g.toLowerCase().replace(/^0+(?=.)/, '');
		return trimmed;
	});
}

export type ClientCategory = 'mobile' | 'tablet' | 'desktop' | 'bot' | 'unknown';

export type ClassifiedClient = {
	category: ClientCategory;
	browser?: string;
	os?: string;
};

// Lightweight User-Agent parser. We deliberately avoid pulling in
// `ua-parser-js` (~30 KB unminified for a feature we use once per
// request) — the device-class buckets we report are coarse enough that
// a handful of regex hits beats any maintenance liability.
export function classifyUserAgent(ua: string | undefined): ClassifiedClient {
	if (!ua) return { category: 'unknown' };

	// Bots first — they often masquerade as mobile or desktop UAs, but
	// the substring is reliable enough that we'd rather mis-bucket a
	// real user as a bot once than count GoogleBot as "mobile".
	if (/bot|crawler|spider|crawl|slurp|mediapartners|googlebot|bingbot|duckduck|yandex|ahrefs|semrush|facebookexternalhit/i.test(ua)) {
		return { category: 'bot', browser: undefined, os: undefined };
	}

	const browser = detectBrowser(ua);
	const os = detectOs(ua);

	// Tablets need to be checked BEFORE the generic mobile branch — an
	// iPad UA contains "Safari" but not "Mobile", and Android tablets
	// are explicitly the Android UA *without* the "Mobile" suffix.
	if (/ipad|tablet|playbook|kindle/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua))) {
		return { category: 'tablet', browser, os };
	}

	if (/iphone|ipod|android.*mobile|windows phone|blackberry|opera mini|mobile/i.test(ua)) {
		return { category: 'mobile', browser, os };
	}

	return { category: 'desktop', browser, os };
}

function detectBrowser(ua: string): string | undefined {
	// Order matters: Edge/Opera/Brave include "Chrome" in their UA, and
	// Chrome includes "Safari", so check the more specific ones first.
	if (/edg\//i.test(ua)) return 'Edge';
	if (/opr\/|opera/i.test(ua)) return 'Opera';
	if (/brave/i.test(ua)) return 'Brave';
	if (/firefox/i.test(ua)) return 'Firefox';
	if (/chrome/i.test(ua)) return 'Chrome';
	if (/safari/i.test(ua)) return 'Safari';
	return undefined;
}

function detectOs(ua: string): string | undefined {
	if (/windows nt/i.test(ua)) return 'Windows';
	if (/mac os x/i.test(ua)) return 'macOS';
	if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
	if (/android/i.test(ua)) return 'Android';
	if (/cros/i.test(ua)) return 'ChromeOS';
	if (/linux/i.test(ua)) return 'Linux';
	return undefined;
}
