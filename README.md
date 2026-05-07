# AI Sudoku

A puzzle game where you discover bilinear matrix-multiplication algorithms by manually decomposing the matmul tensor.

## The puzzle

Matrix multiplication of size `<m, n, p>` (computing `C = A · B` where `A` is `m×n` and `B` is `n×p`) is encoded as a 3-tensor `T` of shape `(m·n) × (n·p) × (m·p)`. A *rank-`R`* algorithm is a decomposition

> `T = Σ_{r=1..R}  u_r ⊗ v_r ⊗ w_r`

where the factors live in `{-1, 0, +1}`. The trivial schoolbook algorithm needs `R = m·n·p` multiplications. Strassen famously found `R = 7` for `<2,2,2>` instead of `8`. AlphaTensor (DeepMind, 2022) discovered new low-rank decompositions over `{-1, 0, 1}` for several sizes.

You're given three boards:

- **A** — shape `m × n × R`, each page is `u_r` reshaped
- **B** — shape `n × p × R`, each page is `v_r`
- **C** — shape `m × p × R`, each page is `w_r`

Your job is to set every cell so the **residual tensor** `Γ = T − Σ_r u_r ⊗ v_r ⊗ w_r` is identically zero. The residual is shown unfolded as a 2D matrix below the boards.

### Scoring

- Lower residual non-zeros = closer to a valid algorithm.
- Once `Γ = 0`, you score on the rank actually used (lower is better) scaled by problem size (`m·n·p`).
- Aim for `R` between the cube-root lower bound `⌈(m·n·p)^(2/3)⌉` and the trivial upper bound `m·n·p`.

### Controls

- **Click** a cell to cycle `−1 → 0 → +1 → −1 …`
- **Shift-click** to cycle backwards
- **Right-click** to reset a cell to `0`
- Click a numbered tab on a board's stack (or the strip below) to switch which page of the rank-axis is active.

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
