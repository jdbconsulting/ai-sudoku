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
	// Strict-increasing list including 0; the values cells of A/B/C
	// were restricted to. Validated against a hard ceiling on size
	// and magnitude so a crafted payload can't bypass alphabet
	// validation by claiming an alphabet with thousands of entries.
	alphabet: number[];
	// Float32Arrays (rather than Int8Arrays as in the {−1,0,1}-only
	// era) so the half-integer / ±2 alphabets can flow through the
	// same code path. Every supported alphabet value is a small
	// dyadic rational that round-trips through f32 without loss.
	A: Float32Array;
	B: Float32Array;
	C: Float32Array;
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

// Convert a JSON array of cell values into a typed Float32Array,
// validating length and that every entry is in the claimed alphabet.
// Cells outside the alphabet would let a clever submitter "cheat" by
// encoding extra information in single cells (the score formula doesn't
// anticipate them and the residual could be driven to zero in ways the
// player-facing search wouldn't allow). Storing as Float32 keeps the
// math in lock-step with the frontend's Float32 boards — every
// supported alphabet value is a small dyadic rational that round-trips
// through f32 without rounding.
function asBoard(
	name: string,
	raw: unknown,
	expectedLen: number,
	alphabet: number[]
): Float32Array {
	if (!Array.isArray(raw)) {
		throw new ValidationError(`${name} must be an array`);
	}
	if (raw.length !== expectedLen) {
		throw new ValidationError(
			`${name} has wrong length: expected ${expectedLen}, got ${raw.length}`
		);
	}
	const out = new Float32Array(expectedLen);
	for (let i = 0; i < expectedLen; i++) {
		const v = raw[i];
		if (typeof v !== 'number' || !Number.isFinite(v)) {
			throw new ValidationError(
				`${name}[${i}] must be a finite number (got ${JSON.stringify(v)})`
			);
		}
		if (!alphabet.includes(v)) {
			throw new ValidationError(
				`${name}[${i}] = ${v} is not in the declared alphabet`
			);
		}
		out[i] = v;
	}
	return out;
}

// Maximum allowed alphabet length. Capped low so a payload can't
// claim an absurd alphabet with thousands of values just to slip cells
// through the per-cell `includes` check. The shipped frontend
// alphabets max out at 7 entries; doubling that as a ceiling leaves
// room for future experimental additions without being a vector for
// abuse.
const MAX_ALPHABET = 16;

// Cap individual alphabet values so a submitter can't claim an
// alphabet containing 10²⁰ and use it to construct a tiny-rank
// "algorithm" that scores enormously well in the residual-magnitude
// metric. Real factor entries in published matmul algorithms (Strassen,
// Bini, AlphaTensor, Smirnov, half-integer ε-border-rank constructions)
// all live comfortably inside [-2, +2] for the alphabets we ship; this
// ceiling matches that and rejects anything noticeably out of band.
const MAX_ALPHABET_VALUE = 2;

function asAlphabet(raw: unknown): number[] {
	if (raw === undefined) {
		// Pre-feature clients (and the SDK's resize-to-default path)
		// don't send an alphabet field. Fall back to the historical
		// {−1, 0, +1} default so existing automation keeps working.
		return [-1, 0, 1];
	}
	if (!Array.isArray(raw)) {
		throw new ValidationError('alphabet must be an array of numbers');
	}
	if (raw.length < 2 || raw.length > MAX_ALPHABET) {
		throw new ValidationError(
			`alphabet must have between 2 and ${MAX_ALPHABET} values (got ${raw.length})`
		);
	}
	const arr: number[] = [];
	for (let i = 0; i < raw.length; i++) {
		const v = raw[i];
		if (typeof v !== 'number' || !Number.isFinite(v)) {
			throw new ValidationError(`alphabet[${i}] must be a finite number`);
		}
		if (Math.abs(v) > MAX_ALPHABET_VALUE) {
			throw new ValidationError(
				`alphabet[${i}] = ${v} exceeds the |v| ≤ ${MAX_ALPHABET_VALUE} bound`
			);
		}
		arr.push(v);
		if (i > 0 && !(arr[i] > arr[i - 1])) {
			throw new ValidationError('alphabet must be strictly increasing');
		}
	}
	if (!arr.includes(0)) {
		throw new ValidationError('alphabet must contain 0');
	}
	return arr;
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
	const alphabet = asAlphabet(obj.alphabet);
	// R is fixed to m·n·p in the game (the player lowers the *effective*
	// rank by leaving pages blank). We don't accept a client-supplied R —
	// any value would either match this or be a bug.
	const R = m * n * p;
	const A = asBoard('A', obj.A, R * m * n, alphabet);
	const B = asBoard('B', obj.B, R * n * p, alphabet);
	const C = asBoard('C', obj.C, R * m * p, alphabet);
	return { username, m, n, p, alphabet, A, B, C };
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
