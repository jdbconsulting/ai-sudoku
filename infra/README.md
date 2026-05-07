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
    ├── handler.ts        # entry point: routes POST /scores, GET /scores/top
    ├── sanitize.ts       # username + payload validation (pure)
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
