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

import { parseSubmission, ValidationError } from './sanitize';

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
				submittedAt
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
			Limit: TOP_LIMIT
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
