# `infra/` — Lambda backend for the High Score Board

The frontend stays on GitHub Pages. This folder is a self-contained
[AWS SAM](https://docs.aws.amazon.com/serverless-application-model/)
stack that adds the leaderboard API:

- **Lambda Function URL** (no API Gateway): one Node 22 / TypeScript
  function that handles both `POST /scores` and `GET /scores/top`.
- **DynamoDB single table** (on-demand pricing) with one GSI for the
  ranked leaderboard query.

The Lambda imports `src/lib/sudoku/tensor.ts` from the frontend tree
directly — esbuild bundles it in at build time. So the server uses the
exact same scoring math the client shows, and any board the client
sends is rescored from scratch server-side. The client's claimed score
is never read.

## Cost

At any plausible traffic level for a niche puzzle, **$0/month**:

- Lambda free tier: 1M requests + 400k GB-s/month, **forever**.
- DynamoDB free tier: 25 GB storage, plus 25 RCU/WCU equivalent,
  **forever**.
- Function URLs are free; CloudWatch Logs is free under 5 GB/month.

## Prerequisites

1. **AWS account** with the AWS CLI configured (`aws configure`) — the
   credentials need permission to create Lambda, DynamoDB, IAM roles,
   and CloudFormation stacks.
2. **Node 22+** for the Lambda build.
3. **AWS SAM CLI** —
   <https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html>
   - macOS: `brew tap aws/tap && brew install aws-sam-cli`
   - Linux: see the page above (a `pip install aws-sam-cli` works in a
     pinch).
4. **Docker** is _not_ required because we use the `esbuild` build
   method — SAM runs the bundle locally.

## First-time deploy

From the repo root:

```bash
cd infra/api
npm install              # installs lib-dynamodb (bundled into Lambda) + esbuild
cd ..
sam build                # uses the locally-installed esbuild from infra/api/node_modules
sam deploy --guided      # interactive: name the stack, pick the region (us-west-2)
```

> **Note:** SAM's esbuild build method requires `esbuild` itself to be reachable.
> Per AWS docs, `esbuild` must be listed in `dependencies` (not
> `devDependencies`) — SAM runs `npm install --production` inside its own
> scratch directory during the build, which skips dev deps. Don't move it.
> The final Lambda zip only contains the bundled JS, so esbuild itself is
> never deployed to Lambda; it's only present at build time.

When `sam deploy --guided` finishes it prints a `Outputs` block. Copy
the **`ApiUrl`** value — that's the URL you give to the frontend.

Example:

```
Key                 ApiUrl
Description         Lambda Function URL.
Value               https://abc123xyz.lambda-url.us-west-2.on.aws/
```

## Wiring the frontend

The frontend reads the API URL at **build time** from
`PUBLIC_API_URL`. Set it as a GitHub Actions repository variable
(_not_ a secret — it's a public URL):

> Repo → Settings → Secrets and variables → Actions → **Variables** tab
> → New repository variable
> Name: `PUBLIC_API_URL`
> Value: `https://abc123xyz.lambda-url.us-west-2.on.aws`

The next push to `main` will rebuild and the High Score Board will
start fetching live entries.

For local dev:

```bash
cp .env.example .env
# edit .env, paste the same URL into PUBLIC_API_URL=
npm run dev
```

If `PUBLIC_API_URL` is unset, the leaderboard tab still renders the
**Famous Algorithms** table and the Submit Score button is shown
disabled — the app degrades gracefully.

## Subsequent deploys

```bash
cd infra
sam build && sam deploy   # uses settings cached in samconfig.toml
```

## Tearing it down

```bash
cd infra
sam delete                # removes the Lambda, DDB table, IAM role, stack
```

## API contract

Both endpoints live under the Function URL.

### `POST /scores`

```jsonc
{
	"username": "joel", // 1–20 chars, [A-Za-z0-9 _\-], collapsed whitespace
	"m": 2,
	"n": 2,
	"p": 2, // each in [1, 8]
	"A": [
		/* R·m·n  flat int8 cells in {-1,0,1} */
	],
	"B": [
		/* R·n·p  flat int8 cells in {-1,0,1} */
	],
	"C": [
		/* R·m·p  flat int8 cells in {-1,0,1} */
	]
}
```

Where `R = m·n·p` (fixed, not configurable). Server response:

```jsonc
HTTP/1.1 201 Created
{
  "id": "5c0e6d8c-…",
  "username": "joel",
  "m": 2, "n": 2, "p": 2,
  "R": 8, "Reff": 7,          // R_eff = ranks used + L1 patch cost
  "omega": 2.807,
  "score": 5848,              // server-computed; the only number that ranks
  "solved": true,
  "submittedAt": "2026-05-07T09:42:18.123Z"
}
```

Errors return `400 {"error": "..."}` for validation problems and
`500 {"error": "internal server error"}` for anything else (with the
real stack trace logged to CloudWatch).

### `GET /scores/top`

```jsonc
HTTP/1.1 200 OK
{
  "entries": [
    {
      "id": "...",
      "username": "joel",
      "m": 2, "n": 2, "p": 2,
      "R": 8, "Reff": 7,
      "omega": 2.807,
      "score": 5848,
      "solved": true,
      "submittedAt": "2026-05-07T09:42:18.123Z"
    },
    ...                       // up to 100 entries, sorted score desc
  ]
}
```

### `GET /scores/{id}`

Same shape as the entries above, plus the original boards as flat
arrays (`A`, `B`, `C` of `R·m·n`, `R·n·p`, `R·m·p` cells). Used by the
Play button on the leaderboard so a user can pick up someone else's
submission as a starting point. Returns `410 Gone` on entries submitted
before board storage was added.

### `POST /events/game-started`

Fire-and-forget telemetry. The browser sends one beacon every time the
player starts a game (new tab, resize, or replay) so we can answer
"which board sizes are people actually trying?" without bolting on a
third-party analytics SDK.

```jsonc
{
	"m": 2,
	"n": 2,
	"p": 2,
	"source": "new" | "resize" | "famous" | "replay"
}
```

Server response is `204 No Content`. Validation failures return `400`
but are not surfaced to the user (the call is fired with
`navigator.sendBeacon`, whose response is unreadable by spec). The
server stitches the request envelope onto the row before storing:

| field            | source                                       |
| ---------------- | -------------------------------------------- |
| `ipPrefix`       | `requestContext.http.sourceIp`, anonymised   |
| `userAgent`      | `requestContext.http.userAgent` (raw string) |
| `clientCategory` | UA classified `mobile`/`tablet`/`desktop`/`bot`/`unknown` |
| `clientBrowser`  | `Chrome`/`Firefox`/`Safari`/`Edge`/`Opera`/`Brave` (or unset) |
| `clientOs`       | `Windows`/`macOS`/`Linux`/`iOS`/`Android`/… (or unset) |

**IP anonymisation.** Before writing to DynamoDB the IP is truncated to
the network prefix:

- IPv4 → `/24` (last octet zeroed): `203.0.113.42` → `203.0.113.0`
- IPv6 → `/48` (keep first three hextets): `2001:db8:abc:1::1` → `2001:db8:abc::`

That's enough resolution for rough geographic / ISP-level trends and
abuse triage, without storing identifying personal data. The full IP
never lands in DynamoDB or in our own application logs (CloudWatch may
retain its own request-line logs from the Lambda Function URL — that's
an AWS-side concern; you can disable Function URL access logging if
you want zero-PII end-to-end).

Events live in the same DynamoDB table:

```
pk = "event#game-started"
sk = "<ISO timestamp>#<uuid>"     # uuid de-duplicates sub-ms collisions
```

There is **no TTL** configured on the table. If the events partition
grows uncomfortably large (millions of rows is fine; tens of millions
isn't), enable a TTL once and write a `ttl` attribute (epoch seconds)
on each new event:

```bash
aws dynamodb update-time-to-live \
	--table-name ai-sudoku-scores-prod \
	--time-to-live-specification 'Enabled=true,AttributeName=ttl'
```

(Existing scores have no `ttl` attribute and are unaffected.)

#### Querying the events

The stack lives in `us-west-2`, so every AWS CLI call needs `--region
us-west-2` (or `export AWS_REGION=us-west-2` once per shell). Without
it the CLI defaults to whatever's in `~/.aws/config` and you'll get a
`ResourceNotFoundException` even though the table exists.

Sanity check that the table is where you think it is:

```bash
aws dynamodb list-tables --region us-west-2
# → ai-sudoku-scores-prod
```

DynamoDB Query, newest first (last 50 game-start events):

```bash
aws dynamodb query \
	--region us-west-2 \
	--table-name ai-sudoku-scores-prod \
	--key-condition-expression 'pk = :pk' \
	--expression-attribute-values '{":pk":{"S":"event#game-started"}}' \
	--no-scan-index-forward \
	--limit 50
```

Same query, but flatten DDB's `{S: …, N: …}` envelope into something
your eyeballs can scan — drop `| jq …` to see the raw shape:

```bash
aws dynamodb query \
	--region us-west-2 \
	--table-name ai-sudoku-scores-prod \
	--key-condition-expression 'pk = :pk' \
	--expression-attribute-values '{":pk":{"S":"event#game-started"}}' \
	--no-scan-index-forward --limit 50 \
| jq -r '.Items[] | [.ts.S, .source.S, "\(.m.N)x\(.n.N)x\(.p.N)",
		.clientCategory.S, (.clientBrowser.S // "-"),
		(.clientOs.S // "-"), .ipPrefix.S] | @tsv' \
| column -t -s $'\t'
```

Filter to just one source (`new`/`resize`/`famous`/`replay`) — note
that `source` is a reserved word in DDB expressions, so it has to be
aliased via `--expression-attribute-names`:

```bash
aws dynamodb query \
	--region us-west-2 \
	--table-name ai-sudoku-scores-prod \
	--key-condition-expression 'pk = :pk' \
	--filter-expression '#s = :src' \
	--expression-attribute-names '{"#s":"source"}' \
	--expression-attribute-values \
		'{":pk":{"S":"event#game-started"},":src":{"S":"replay"}}' \
	--no-scan-index-forward --limit 50
```

Filter to a date range — the `sk` starts with the ISO timestamp, so
`begins_with(sk, "2026-05-")` gets one month of data without a scan:

```bash
aws dynamodb query \
	--region us-west-2 \
	--table-name ai-sudoku-scores-prod \
	--key-condition-expression 'pk = :pk AND begins_with(sk, :day)' \
	--expression-attribute-values \
		'{":pk":{"S":"event#game-started"},":day":{"S":"2026-05-07"}}'
```

Total event count (Query is paginated at 1 MB; this drives it through
all pages and just sums):

```bash
aws dynamodb query \
	--region us-west-2 \
	--table-name ai-sudoku-scores-prod \
	--key-condition-expression 'pk = :pk' \
	--expression-attribute-values '{":pk":{"S":"event#game-started"}}' \
	--select COUNT --no-paginate \
| jq '.Count'
```

For deeper analysis, export the partition once and join in
pandas / sqlite:

```bash
aws dynamodb query \
	--region us-west-2 \
	--table-name ai-sudoku-scores-prod \
	--key-condition-expression 'pk = :pk' \
	--expression-attribute-values '{":pk":{"S":"event#game-started"}}' \
	--no-paginate \
> events.json
```

## Anti-cheat (v1)

What the server enforces:

- **Score is recomputed from boards** — the client's claimed score is
  never read.
- **Hard cap on board size** — `max(m, n, p) ≤ 8`. Rejects payloads
  before allocating the residual tensor (which is `O((m·n·p)²)` and
  could otherwise melt the Lambda).
- **Cell alphabet enforced** — every cell must be `-1`, `0`, or `1`.
- **Username normalization** — collapsed whitespace, allow-list charset,
  reserved-name blocklist (Strassen, AlphaTensor, …).

What it deliberately doesn't do (in v1):

- **No identity / impersonation prevention.** Any free username can be
  claimed on each submit. Add per-session signed tokens later if needed.
- **No rate limiting.** Relies on the AWS account-level Lambda
  concurrency cap (1000 by default) and on the leaderboard staying
  small enough that abuse is uninteresting. If submissions spike,
  the cheapest fix is putting CloudFront + AWS WAF in front (~$5/mo
  for the WAF rule) with a rate-based rule keyed on source IP.
- **No custom domain (`api.ai-sudoku.org`).** The raw Function URL
  works fine; a custom domain needs an ACM cert + CloudFront
  distribution wired into Route53. Easy follow-up.

## Layout

```
infra/
├── README.md             # you are here
├── template.yaml         # SAM stack: Lambda + DDB + Function URL
└── api/                  # Lambda CodeUri
    ├── package.json      # lib-dynamodb + esbuild (bundled) + dev deps
    ├── tsconfig.json
    ├── handler.ts        # entry point: routes /scores/* and /events/*
    ├── sanitize.ts       # username + payload + event validation, IP/UA helpers
    └── tensor.ts         # SYMLINK → ../../src/lib/sudoku/tensor.ts
```

### About the `tensor.ts` symlink

SAM's `CopySource` step copies *only* the function's `CodeUri` (i.e.
`infra/api/`) into its build scratch directory before invoking esbuild.
A normal cross-folder relative import (`../../src/lib/sudoku/tensor`)
would resolve to nothing in that sandbox.

The symlink is the simplest fix: it lives inside `infra/api/`, so
`CopySource` includes it, and `shutil.copy2` (which SAM uses) follows
symlinks for files — meaning the actual `tensor.ts` *contents* land in
the scratch dir under the symlink's name. esbuild then resolves
`./tensor` against that file and bundles it in.

**Implications:**

- The frontend and Lambda share one source of truth for scoring math
  (edits to `src/lib/sudoku/tensor.ts` automatically apply to both).
- On Windows native (not WSL), git defaults to disabling symlinks. WSL,
  macOS, and Linux all work out of the box. CI on Linux works fine.
