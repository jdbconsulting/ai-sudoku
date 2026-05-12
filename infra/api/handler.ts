import { randomUUID } from 'node:crypto';

import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

// The Lambda imports the EXACT same scoring module the frontend uses.
// `./tensor` here is a SYMLINK to ../../src/lib/sudoku/tensor.ts — kept in
// sync automatically. esbuild bundles it in at build time (see
// template.yaml's BuildMethod). The symlink lives inside infra/api/ so
// SAM's CopySource step (which only copies the function's CodeUri to its
// scratch dir) can dereference and include it. This is the whole
// anti-cheat strategy: server and client agree byte-for-byte on what a
// board is worth, and the server's number wins.
import {
	computeOmega,
	computeResidual,
	computeScore,
	computeTargetTensor,
	ranksUsed,
	sumAbs
} from './tensor';

import {
	classifyUserAgent,
	parseGameStartedEvent,
	parseSubmission,
	truncateIp,
	ValidationError
} from './sanitize';

const TABLE_NAME = requireEnv('TABLE_NAME');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
	marshallOptions: {
		// Skip undefined-valued attributes instead of erroring; lets us
		// build items with conditional fields without ceremony.
		removeUndefinedValues: true
	}
});

const LEADERBOARD_PK = 'global';
const TOP_LIMIT = 100;

export const handler = async (
	event: LambdaFunctionURLEvent
): Promise<APIGatewayProxyStructuredResultV2> => {
	const method = event.requestContext.http.method;
	const path = event.rawPath;

	// CORS is handled entirely by the Lambda Function URL configuration
	// (see template.yaml). Setting headers here too would produce
	// duplicate Access-Control-Allow-Origin values and the browser
	// rejects the response. Likewise the Function URL handles OPTIONS
	// preflights itself — they never reach this handler.
	try {
		if (method === 'GET' && path === '/scores/top') return await getTopScores();
		if (method === 'POST' && path === '/scores') return await submitScore(event);

		// /scores/{id} — fetch full record (including boards) so the
		// frontend can replay a submission. Only matches a UUID-shaped
		// segment so a typo can't cause a wide DDB scan.
		const idMatch = path.match(/^\/scores\/([0-9a-f-]{36})$/i);
		if (method === 'GET' && idMatch) return await getScoreById(idMatch[1]);

		// Fire-and-forget usage telemetry. The browser sends one of these
		// every time the player starts a game (new tab / resize / replay)
		// so we can answer "which board sizes are people actually trying?"
		// in CloudWatch later.
		if (method === 'POST' && path === '/events/game-started') {
			return await recordGameStarted(event);
		}

		return json(404, { error: `not found: ${method} ${path}` });
	} catch (err) {
		if (err instanceof ValidationError) {
			return json(err.statusCode, { error: err.message });
		}
		// Don't leak internals. Log the full error (CloudWatch picks it
		// up via the runtime's stderr capture) and respond with a generic
		// 500 — the structured log entry is what gets debugged.
		console.error('unhandled error', err);
		return json(500, { error: 'internal server error' });
	}
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

type SubmitResponse = {
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
	alphabet: number[];
};

async function submitScore(
	event: LambdaFunctionURLEvent
): Promise<APIGatewayProxyStructuredResultV2> {
	const body = parseBody(event);
	const sub = parseSubmission(body);
	const { m, n, p, alphabet, A, B, C } = sub;
	const R = m * n * p;

	// Recompute everything from scratch — the client's claimed score is
	// not even read off the request. This is the entire anti-cheat
	// scheme for the v1 leaderboard. The alphabet is validated up front
	// (cells must be in it) but doesn't appear in the score formula
	// itself: that depends purely on the residual and the rank tally.
	const T = computeTargetTensor(m, n, p);
	const residual = computeResidual({ m, n, p, R }, A, B, C, T);
	const used = ranksUsed({ m, n, p, R }, A, B, C);
	const fixCost = sumAbs(residual);
	const Reff = used + fixCost;
	const omega = computeOmega(m, n, p, Reff);
	const score = computeScore(omega);
	const solved = fixCost === 0;

	const id = randomUUID();
	const submittedAt = new Date().toISOString();

	await ddb.send(
		new PutCommand({
			TableName: TABLE_NAME,
			Item: {
				pk: `score#${id}`,
				sk: submittedAt,
				gsi1pk: LEADERBOARD_PK,
				// DynamoDB sort keys are ascending; Query with
				// ScanIndexForward=false reverses, giving us "highest
				// first" for free.
				gsi1sk: score,
				id,
				username: sub.username,
				m,
				n,
				p,
				R,
				Reff,
				omega,
				score,
				solved,
				submittedAt,
				alphabet,
				// Stored as Binary (B). Each cell is 4 bytes (little-
				// endian Float32) so half-integer / ±2 alphabets
				// round-trip exactly. Capped well under DDB's 400 KB
				// item limit: at max ⟨8,8,8⟩ R=512 we ship ≈ 393 KB of
				// board bytes plus a few hundred bytes of metadata.
				// Rows written before this change (Int8 boards, 1 B
				// per cell) are still readable on the GET path — see
				// `getScoreById`.
				boardFormat: 'float32-le',
				boardA: encodeBoard(A),
				boardB: encodeBoard(B),
				boardC: encodeBoard(C)
			}
		})
	);

	const response: SubmitResponse = {
		id,
		username: sub.username,
		m,
		n,
		p,
		R,
		Reff,
		omega,
		score,
		solved,
		submittedAt,
		alphabet
	};
	return json(201, response);
}

type LeaderboardEntry = {
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
	// Cell alphabet the row was authored in. Optional in the response
	// shape so the frontend can default rows that predate the alphabet
	// feature back to {−1, 0, +1}.
	alphabet?: number[];
};

async function getTopScores(): Promise<APIGatewayProxyStructuredResultV2> {
	const out = await ddb.send(
		new QueryCommand({
			TableName: TABLE_NAME,
			IndexName: 'byScore',
			KeyConditionExpression: 'gsi1pk = :pk',
			ExpressionAttributeValues: { ':pk': LEADERBOARD_PK },
			ScanIndexForward: false,
			Limit: TOP_LIMIT,
			// Pull only the metadata we render in the leaderboard table —
			// boards can be up to ~400 KB for ⟨8,8,8⟩ and we don't
			// want 100 of them on the wire just to render a list.
			// Replays fetch the boards on demand via /scores/{id}.
			// `alphabet` is included so the UI can show a per-row
			// hint that an entry was authored in a non-default world.
			ProjectionExpression:
				'id, username, m, n, p, R, Reff, omega, score, solved, submittedAt, alphabet'
		})
	);

	const entries: LeaderboardEntry[] = (out.Items ?? []).map((it) => {
		const row: LeaderboardEntry = {
			id: String(it.id),
			username: String(it.username),
			m: Number(it.m),
			n: Number(it.n),
			p: Number(it.p),
			R: Number(it.R),
			Reff: Number(it.Reff),
			omega: Number(it.omega),
			score: Number(it.score),
			solved: Boolean(it.solved),
			submittedAt: String(it.submittedAt)
		};
		const alpha = asAlphabetField(it.alphabet);
		if (alpha) row.alphabet = alpha;
		return row;
	});

	return json(200, { entries });
}

// Defensive accessor for the alphabet attribute coming back out of
// DynamoDB. DocumentClient unmarshals the attribute either as a JS
// `number[]` (N-List) or `Set<number>` (NS). We accept both and
// degrade gracefully to `undefined` when the field is missing or
// malformed, so a corrupt row can't take down the leaderboard query.
function asAlphabetField(raw: unknown): number[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (Array.isArray(raw)) {
		const out: number[] = [];
		for (const v of raw) {
			if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
			else return undefined;
		}
		return out.length > 0 ? out : undefined;
	}
	if (raw instanceof Set) {
		const arr: number[] = [];
		for (const v of raw) {
			if (typeof v === 'number' && Number.isFinite(v)) arr.push(v);
		}
		arr.sort((a, b) => a - b);
		return arr.length > 0 ? arr : undefined;
	}
	return undefined;
}

type FullScore = LeaderboardEntry & {
	A: number[];
	B: number[];
	C: number[];
	// Inherited from LeaderboardEntry; redeclared here only to make the
	// rendered handler signature obvious — the wire payload includes
	// the alphabet field for every row written after the alphabet
	// feature shipped, omitted (and defaulted client-side) for older
	// rows.
	alphabet?: number[];
};

async function getScoreById(id: string): Promise<APIGatewayProxyStructuredResultV2> {
	// We Query the base table by the partition key alone — there's
	// exactly one item per id (the SK is the submission timestamp,
	// which is unknown but irrelevant). Cheaper than maintaining a
	// second GSI just for id lookups.
	const out = await ddb.send(
		new QueryCommand({
			TableName: TABLE_NAME,
			KeyConditionExpression: 'pk = :pk',
			ExpressionAttributeValues: { ':pk': `score#${id}` },
			Limit: 1
		})
	);

	const it = out.Items?.[0];
	if (!it) return json(404, { error: `score not found: ${id}` });

	const m = Number(it.m);
	const n = Number(it.n);
	const p = Number(it.p);
	const R = Number(it.R);

	const boardA = it.boardA as Uint8Array | undefined;
	const boardB = it.boardB as Uint8Array | undefined;
	const boardC = it.boardC as Uint8Array | undefined;
	if (
		!(boardA instanceof Uint8Array) ||
		!(boardB instanceof Uint8Array) ||
		!(boardC instanceof Uint8Array)
	) {
		return json(410, {
			error: 'this score predates board storage and cannot be replayed'
		});
	}

	// Two on-disk encodings live in DynamoDB:
	//   * 'int8'        — historical, 1 byte/cell, values in {-1, 0, +1}.
	//     Used for every row written before the alphabet feature shipped.
	//   * 'float32-le'  — current default, 4 bytes/cell little-endian.
	//     Used for every row submitted since the alphabet feature.
	// We pick the decoder based on the explicit `boardFormat` attribute
	// when present, falling back to "whichever length matches" so the
	// pre-feature rows (no `boardFormat` field) keep replaying. Anything
	// that doesn't match either expected length is dropped behind the
	// same 410 the no-board-stored case already used — corruption is
	// rare and the player is better served by a clear error than a
	// silently bogus replay.
	const fmtAttr = it.boardFormat;
	const cellsA = R * m * n;
	const cellsB = R * n * p;
	const cellsC = R * m * p;
	let A: number[];
	let B: number[];
	let C: number[];
	const fmt =
		typeof fmtAttr === 'string'
			? fmtAttr
			: boardA.length === cellsA * 4
				? 'float32-le'
				: boardA.length === cellsA
					? 'int8'
					: 'unknown';
	if (
		fmt === 'float32-le' &&
		boardA.length === cellsA * 4 &&
		boardB.length === cellsB * 4 &&
		boardC.length === cellsC * 4
	) {
		A = decodeFloat32Board(boardA, cellsA);
		B = decodeFloat32Board(boardB, cellsB);
		C = decodeFloat32Board(boardC, cellsC);
	} else if (
		fmt === 'int8' &&
		boardA.length === cellsA &&
		boardB.length === cellsB &&
		boardC.length === cellsC
	) {
		A = decodeInt8BoardToArray(boardA);
		B = decodeInt8BoardToArray(boardB);
		C = decodeInt8BoardToArray(boardC);
	} else {
		return json(410, {
			error: 'this score predates board storage and cannot be replayed'
		});
	}

	const alphabet = asAlphabetField(it.alphabet);
	const response: FullScore = {
		id: String(it.id),
		username: String(it.username),
		m,
		n,
		p,
		R,
		Reff: Number(it.Reff),
		omega: Number(it.omega),
		score: Number(it.score),
		solved: Boolean(it.solved),
		submittedAt: String(it.submittedAt),
		A,
		B,
		C
	};
	if (alphabet) response.alphabet = alphabet;
	return json(200, response);
}

// Telemetry endpoint. Records *one row per game-start* so we can later
// see which board sizes / device classes / rough geographies actually
// engage with the puzzle. The browser fires this with sendBeacon, so:
//   - The reply body is empty and the status is 204 No Content (sendBeacon
//     ignores both anyway, but lighter responses keep CloudWatch logs short).
//   - We never throw the validation error back to the user — analytics
//     misses are silent. They're already counted as 4xx in CloudWatch
//     metrics if you ever need to investigate a misbehaving client.
//   - IP is anonymized to /24 (IPv4) or /48 (IPv6) before storage. The
//     full IP never lands in DynamoDB or in our logs.
async function recordGameStarted(
	event: LambdaFunctionURLEvent
): Promise<APIGatewayProxyStructuredResultV2> {
	let parsed;
	try {
		parsed = parseGameStartedEvent(parseBody(event));
	} catch (err) {
		// Surface validation failures with a 4xx so a buggy client shows up
		// in metrics, but don't bubble out of the handler — analytics MUST
		// NOT be able to break the API. The catch in `handler` would do
		// the same; this is just explicit.
		if (err instanceof ValidationError) return json(err.statusCode, { error: err.message });
		throw err;
	}

	const { m, n, p, source } = parsed;
	const http = event.requestContext.http;
	const ipPrefix = truncateIp(http.sourceIp);
	const userAgent = http.userAgent;
	const client = classifyUserAgent(userAgent);

	const ts = new Date().toISOString();
	// `randomUUID()` makes the SK unique even if two requests land in the
	// same millisecond (sub-ms timestamps in JS aren't dependable).
	const sk = `${ts}#${randomUUID()}`;

	await ddb.send(
		new PutCommand({
			TableName: TABLE_NAME,
			Item: {
				// Single partition for all game-start events. Fine at our
				// traffic; if it ever gets hot, shard by hour bucket and
				// scatter-gather in the read path.
				pk: 'event#game-started',
				sk,
				ts,
				source,
				m,
				n,
				p,
				// Truncated IP. Stored as a string for human-readable
				// CloudWatch / DDB browsing. Marshalled as undefined
				// (and so dropped from the item) when the request came
				// over a transport that didn't surface a sourceIp.
				ipPrefix,
				userAgent,
				clientCategory: client.category,
				clientBrowser: client.browser,
				clientOs: client.os
			}
		})
	);

	return { statusCode: 204, headers: {}, body: '' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBody(event: LambdaFunctionURLEvent): unknown {
	if (!event.body) throw new ValidationError('request body is required');
	const text = event.isBase64Encoded
		? Buffer.from(event.body, 'base64').toString('utf-8')
		: event.body;
	try {
		return JSON.parse(text);
	} catch {
		throw new ValidationError('request body must be valid JSON');
	}
}

function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
	return {
		statusCode,
		headers: { 'content-type': 'application/json; charset=utf-8' },
		body: JSON.stringify(body)
	};
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`missing required env var: ${name}`);
	return v;
}

// Float32Array → Uint8Array view of the same bytes (zero copy). Each
// cell occupies 4 bytes of little-endian IEEE-754 float; every value
// in the supported alphabets is a small dyadic rational that round-
// trips through Float32 without rounding, so the on-disk bytes
// unambiguously recover the original cell.
function encodeBoard(arr: Float32Array): Uint8Array {
	return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

// Uint8Array (DDB Binary, written as Float32 little-endian) → JS array
// of numbers. Lambda runs on x86-64 / arm64 hosts which are both
// little-endian, so reinterpreting the bytes through a Float32Array
// view is correct without a manual byte swap. Defensive: a non-finite
// value (NaN / ±Inf) gets clamped to 0 so a corrupted byte can't
// surface as a JSON `null` and crash the client decoder.
function decodeFloat32Board(bytes: Uint8Array, expectedCells: number): number[] {
	// Need an aligned 4-byte boundary for the Float32Array view; the
	// DDB-returned Uint8Array starts at offset 0 of its own buffer in
	// every observed runtime, but copy via Float32Array constructor in
	// case the underlying slab starts mid-word.
	const aligned = new Float32Array(
		bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
	);
	const out = new Array<number>(expectedCells);
	for (let i = 0; i < expectedCells; i++) {
		const v = aligned[i];
		out[i] = Number.isFinite(v) ? v : 0;
	}
	return out;
}

// Legacy decoder for rows written before the alphabet feature: each
// cell is one signed byte, values in {-1, 0, +1}. 0xFF → -1, 0x00 → 0,
// 0x01 → 1; anything else got into DDB by some other route and we
// treat as 0 to keep the response sane.
function decodeInt8BoardToArray(bytes: Uint8Array): number[] {
	const out = new Array<number>(bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i];
		out[i] = b === 0xff ? -1 : b === 1 ? 1 : 0;
	}
	return out;
}
