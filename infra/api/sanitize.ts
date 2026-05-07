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
