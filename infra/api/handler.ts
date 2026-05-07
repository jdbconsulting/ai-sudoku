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
};

async function submitScore(
	event: LambdaFunctionURLEvent
): Promise<APIGatewayProxyStructuredResultV2> {
	const body = parseBody(event);
	const sub = parseSubmission(body);
	const { m, n, p, A, B, C } = sub;
	const R = m * n * p;

	// Recompute everything from scratch — the client's claimed score is
	// not even read off the request. This is the entire anti-cheat
	// scheme for the v1 leaderboard.
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
				// Stored as Binary (B). Int8Array buffer bytes are bit-
				// identical to the corresponding Uint8Array view (-1 →
				// 0xFF, 0 → 0x00, 1 → 0x01), so reinterpreting is a
				// zero-copy operation. ~1 byte per cell, well under
				// DDB's 400 KB item limit even for max <8,8,8>.
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
		submittedAt
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
			// boards can be up to ~98 KB for <8,8,8> and we don't want
			// 100 of them on the wire just to render a list. Replays
			// fetch the boards on demand via /scores/{id}.
			ProjectionExpression: 'id, username, m, n, p, R, Reff, omega, score, solved, submittedAt'
		})
	);

	const entries: LeaderboardEntry[] = (out.Items ?? []).map((it) => ({
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
	}));

	return json(200, { entries });
}

type FullScore = LeaderboardEntry & {
	A: number[];
	B: number[];
	C: number[];
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

	// DocumentClient unmarshals B-typed attributes back into Uint8Array.
	// Validate lengths defensively in case the stored item predates the
	// boards-stored-on-submit feature.
	const boardA = it.boardA as Uint8Array | undefined;
	const boardB = it.boardB as Uint8Array | undefined;
	const boardC = it.boardC as Uint8Array | undefined;
	if (
		!(boardA instanceof Uint8Array) ||
		!(boardB instanceof Uint8Array) ||
		!(boardC instanceof Uint8Array) ||
		boardA.length !== R * m * n ||
		boardB.length !== R * n * p ||
		boardC.length !== R * m * p
	) {
		return json(410, {
			error: 'this score predates board storage and cannot be replayed'
		});
	}

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
		A: decodeBoardToArray(boardA),
		B: decodeBoardToArray(boardB),
		C: decodeBoardToArray(boardC)
	};
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

// Int8Array → Uint8Array view of the same bytes (zero copy). Cells in
// {-1, 0, 1} encode as bytes {0xFF, 0x00, 0x01} regardless of which view
// you reach through, so reinterpreting is safe and round-trips exactly.
function encodeBoard(arr: Int8Array): Uint8Array {
	return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

// Uint8Array (DDB Binary) → JS array of signed -1 | 0 | 1, suitable for
// JSON. We don't bother with base64 packing: each cell is one byte and
// even max <8,8,8> stays well under any practical wire-size concern.
function decodeBoardToArray(bytes: Uint8Array): number[] {
	const out = new Array<number>(bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i];
		// 0xFF → -1, 0x00 → 0, 0x01 → 1. Anything else got into DDB by
		// some other route and we treat as 0 to keep the response sane.
		out[i] = b === 0xff ? -1 : b === 1 ? 1 : 0;
	}
	return out;
}
