# AI Sudoku

A puzzle game where you discover bilinear matrix-multiplication algorithms by manually decomposing the matmul tensor.

## The puzzle

Matrix multiplication of size `<m, n, p>` (computing `C = A · B` where `A` is `m×n` and `B` is `n×p`) is encoded as a 3-tensor `T` of shape `(m·n) × (n·p) × (m·p)`. A *rank-`R`* algorithm is a decomposition

> `T = Σ_{r=1..R}  u_r ⊗ v_r ⊗ w_r`

where the factors live in `{-1, 0, +1}`. The trivial schoolbook algorithm needs `R = m·n·p` multiplications. Strassen famously found `R = 7` for `<2,2,2>` instead of `8`. AlphaTensor (DeepMind, 2022) discovered new low-rank decompositions over `{-1, 0, 1}` for several sizes.

You're given a single board with three sub-grids — `A`, `B`, and `C` — laid out so the dimensions of an `A · B = C` matrix multiplication line up edge-to-edge:

```
            ┌─ n cols ─┬─ p cols ─┐
            │          │          │
       n    │  empty   │    B     │
       rows │          │ (n × p)  │
            ├──────────┼──────────┤
       m    │    A     │    C     │
       rows │ (m × n)  │ (m × p)  │
            └──────────┴──────────┘
```

The three matrices behind those sub-grids are stacked along a rank axis of length `R`:

- **A** — shape `m × n × R`, each page is `u_r` reshaped
- **B** — shape `n × p × R`, each page is `v_r`
- **C** — shape `m × p × R`, each page is `w_r`

Your job is to set every cell so the **residual tensor** `Γ = T − Σ_r u_r ⊗ v_r ⊗ w_r` is identically zero. The residual is shown unfolded as a 2D matrix below the board.

### Controls

- **Click** a cell to cycle `−1 → 0 → +1 → −1 …`
- **Shift-click** to cycle backwards
- **Right-click** to reset a cell to `0`
- Click the small corner tab on any inactive page (or use the vertical slider on the canvas) to switch which page of the rank-axis is active.

## Scoring

The score is a single number that captures how *fast* the algorithm you've drawn would be if it were used as the recursive base case of an N×N×N matrix multiplication. The pipeline is:

```
  ranksUsed + Σ|Γ|       →   R_eff
  R_eff, m, n, p         →   ω_eff   (asymptotic complexity exponent)
  ω_eff                  →   score   (gamified mapping)
```

Implementation lives in [`src/lib/sudoku/tensor.ts`](src/lib/sudoku/tensor.ts) (`computeOmega`, `computeScore`).

### 1. Effective rank `R_eff`

Each rank slot whose A/B/C page is non-empty counts once (`ranksUsed`). Any leftover error in the residual gets paid for at schoolbook prices — one rank-1 fix per non-zero residual cell:

```
R_eff = ranksUsed + Σ |Γ_ijk|
```

So an unsolved board with everything zero has `R_eff = m·n·p` (the trivial schoolbook cost), and a fully-solved board with `k` rank pages used has `R_eff = k`. Intermediate states fall on the natural trade-off curve between the two.

### 2. Asymptotic exponent `ω_eff`

If you treat your `<m,n,p>` rank-`R` algorithm as the base case of a divide-and-conquer recursion, multiplying N×N×N matrices costs `T(N) = R · T(N/s) + Θ(N²)` with `s = (m·n·p)^(1/3)`. The master theorem gives three regimes:

| condition | T(N) | exponent |
| --- | --- | --- |
| `R > s²` | `Θ(N^{log_s R})` | `log_s R = 3·log(R)/log(m·n·p)` |
| `R = s²` | `Θ(N²·log_s N)` | 2, *but with a polylog factor* |
| `R < s²` | `Θ(N²)` | 2 |

The "naive" exponent `3·log(R)/log(m·n·p)` is correct in regime 1 only. At and below the lower bound `R = (m·n·p)^(2/3)` it pretends the polylog factor is free and awards `ω = 2` to *anything* with `R ≤ (m·n·p)^(2/3)`, which would let `<2,2,2> R=4` and `<8,8,8> R=64` tie despite very different recursion overheads.

To fix that, the score uses

```
ω_eff = max(  3·log(R_eff)/log(m·n·p),
              2 + log( log_s(N_ref) + 1 ) / log(N_ref) )
```

with `N_ref = 2²⁰` (a "real" matmul of ~10⁶ entries). The second term is the **polylog floor** — the effective exponent of `N²·log_s N_ref` evaluated at `N = N_ref`. Taking `max` means:

- For algorithms with `R > (m·n·p)^(2/3)` (Strassen, AlphaTensor, schoolbook, basically everything anyone has ever published), `ω_eff = ω_naive`. Existing leaderboard scores are unchanged.
- For solutions at or below the lower bound, the polylog floor takes over and the score depends on `m·n·p` — bigger cubes have shallower recursions and approach `ω = 2` more closely.

### 3. Score curve

`computeScore(ω)` is a continuous two-regime curve anchored at the schoolbook value `ω = 3`:

| ω       | score        | meaning |
| ------- | ------------ | ------- |
| 2       | +1,000,000   | conjectured asymptotic limit (unreachable in practice — see below) |
| 3       | +1           | schoolbook |
| 3.022   | −12          | one-cell perturbation off naive: gentle slap |
| 4       | −27,777      | well above schoolbook |
| 9       | −1,000,000   | floor |
| > 9     | clamped      | |

The good side is `10^{6·(3−ω)} − 1 + 1` (six decades of exponential reward as ω drops from 3 to 2). The bad side is quadratic in `ω − 3` — small overshoots feel like a slap on the wrist instead of a catastrophe, since players exploring just above schoolbook need gentle gradients.

### Sample scores

A few cube cases at the rank lower bound `R = n²` (where the polylog floor is what's binding):

| `<m,n,p>` | R | ω_eff | score |
| --------- | --- | ----- | ----- |
| `<2,2,2>` | 4   | 2.2196 | 48,118 |
| `<3,3,3>` | 9   | 2.1884 | 74,088 |
| `<4,4,4>` | 16  | 2.1730 | 91,658 |
| `<5,5,5>` | 25  | 2.1633 | 104,829 |
| `<6,6,6>` | 36  | 2.1564 | 115,307 |
| `<7,7,7>` | 49  | 2.1511 | 123,975 |
| `<8,8,8>` | 64  | 2.1469 | 131,347 |

The +1,000,000 ceiling sits at the conjectured limit `ω = 2`, but no recursive base case can hit it exactly — divide-and-conquer's `Θ(N²·log N)` combine cost keeps the *effective* exponent strictly above 2. Bigger `<m,n,p>` recurse more shallowly and approach 1,000,000 more closely.

For comparison, real published algorithms sit firmly in the multiplications-dominated regime, so the polylog floor never binds and they score under `ω_naive`:

| algorithm                | `<m,n,p>` | R   | ω      | score |
| ------------------------ | --------- | --- | ------ | ----- |
| Strassen (1969)          | `<2,2,2>` | 7   | 2.8074 | 14    |
| Laderman (1976)          | `<3,3,3>` | 23  | 2.8540 | 8     |
| AlphaTensor `<2,3,3>`    | `<2,3,3>` | 15  | 2.8108 | 14    |
| AlphaTensor `<4,4,4>`    | `<4,4,4>` | 49  | 2.8074 | 14    |
| AlphaTensor `<5,5,7>`    | `<5,5,7>` | 134 | 2.8449 | 9     |
| Schoolbook               | any       | m·n·p | 3.0000 | 1     |

### Score thresholds

Inverting the score curve, fixed score thresholds correspond to fixed ω cutoffs (independent of `<m,n,p>`):

| score ≥ | ω ≤ |
| --- | --- |
| 50      | 2.7168 |
| 100     | 2.6667 |
| 1,000   | 2.5000 |
| 10,000  | 2.3333 |
| 100,000 | 2.1667 |
| 1,000,000 | 2.0000 (asymptotic) |

What *does* change per problem size is the rank `R` it takes to land at each ω. For cubes `<n,n,n>`, the relation is `ω_naive = log_n(R)`, so `R_threshold ≈ n^ω`. Concrete examples at three scales:

#### Small: `<2,2,2>` — mnp = 8, R ∈ [4, 8], polylog floor ω = 2.2196 (score 48,118)

| target | ω needed | R needed | best integer R | actual ω | actual score |
| --- | --- | --- | --- | --- | --- |
| score ≥ 50      | ≤ 2.7168 | ≤ 6.57 | 6 | 2.5850 | 309 |
| score ≥ 100     | ≤ 2.6667 | ≤ 6.35 | 6 | 2.5850 | 309 |
| score ≥ 1,000   | ≤ 2.5000 | ≤ 5.66 | 5 | 2.3219 | 11,707 |
| score ≥ 10,000  | ≤ 2.3333 | ≤ 5.04 | 5 | 2.3219 | 11,707 |

`<2,2,2>` is *coarse*: the only integer ranks below schoolbook (R=8) are 4–7, so `R=6` clears 50 and 100 (with score 309), `R=5` clears 1k and 10k (with score 11,707), and `R=4` is at the lower bound (score 48,118 from the polylog floor). Strassen's `R=7` only nets score 14 — it doesn't qualify for any prize.

#### Medium: `<6,6,6>` — mnp = 216, R ∈ [36, 216], polylog floor ω = 2.1564 (score 115,307)

| target | ω needed | R needed | best integer R | actual ω | actual score |
| --- | --- | --- | --- | --- | --- |
| score ≥ 50      | ≤ 2.7168 | ≤ 130.05 | 130 | 2.7166 | 50 |
| score ≥ 100     | ≤ 2.6667 | ≤ 118.87 | 118 | 2.6626 | 106 |
| score ≥ 1,000   | ≤ 2.5000 | ≤ 88.18  | 88  | 2.4988 | 1,016 |
| score ≥ 10,000  | ≤ 2.3333 | ≤ 65.42  | 65  | 2.3298 | 10,505 |

`<6,6,6>` has ~180 integer ranks of dynamic range, so the prize tiers map to a smooth gradient: each decade of score corresponds to roughly 30 fewer rank pages used. R=131 just misses 50 (score 47); R=119 just misses 100 (score 99); R=89 just misses 1k (score 931); R=66 just misses 10k (score 9,338).

#### Large: `<65536, 65536, 65536>` — mnp ≈ 2.81 × 10¹⁴, R ∈ [4.29 × 10⁹, 2.81 × 10¹⁴], polylog floor ω = 2.0585 (score 445,679)

| target | ω needed | R needed | actual ω | actual score |
| --- | --- | --- | --- | --- |
| score ≥ 50      | ≤ 2.7168 | ≤ 1.22 × 10¹³ | 2.7168 | 50 |
| score ≥ 100     | ≤ 2.6667 | ≤ 6.98 × 10¹² | 2.6667 | 100 |
| score ≥ 1,000   | ≤ 2.5000 | ≤ 1.10 × 10¹² | 2.5000 | 1,000 |
| score ≥ 10,000  | ≤ 2.3333 | ≤ 1.73 × 10¹¹ | 2.3333 | 10,000 |

At this scale the polylog floor (R = 4.29 × 10⁹) already scores 445,679, so **all four thresholds are blown past trivially** by any solution near the lower bound. The "interesting" prize-tier R window for large problems is enormous: the gap between the lower bound and the score-50 threshold is roughly 2,800×.

#### Takeaway

Fixed absolute-score prizes get *easier* on bigger problems — the polylog floor scales the bottom of the score range upward as `<m,n,p>` grows, so at very large sizes even a barely-better-than-schoolbook algorithm clears every prize. If the prizes need to feel similarly challenging across sizes, tie them to a multiplicative factor below schoolbook (e.g. "first prize: `R ≤ 0.85 · m·n·p`") instead of an absolute score.

### Aim

To beat schoolbook you need `R_eff < m·n·p`. To beat Strassen at `<2,2,2>` you need `R_eff < 7`. Below the lower bound `⌈(m·n·p)^(2/3)⌉` you're in conjectured-impossible territory and the polylog floor takes over the score.

## Stack

- [SvelteKit](https://svelte.dev/docs/kit) with Svelte 5 runes
- Tailwind CSS v4
- `@sveltejs/adapter-static` — fully prerendered static output

## Develop

```sh
npm install
npm run dev
```

## Build static site

```sh
npm run build      # writes static site to ./build
npm run preview
```

The output in `build/` can be deployed as-is to any static host (Netlify, Cloudflare Pages, GitHub Pages, S3, etc.).
