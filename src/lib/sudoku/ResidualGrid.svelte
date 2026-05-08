<script lang="ts">
	import type { GameState } from './state.svelte';

	let { game }: { game: GameState } = $props();

	let m = $derived(game.m);
	let n = $derived(game.n);
	let p = $derived(game.p);

	// New layout: an m × p outer array, each cell of which is an m × p matrix.
	// Outer position (s, t) = which produced output of C the algorithm wrote to.
	// Inner position (i, l) = which ideal output cell C[i, l] is being read.
	// Each cell value is Σ_{j, k} Γ[(i,j),(k,l),(s,t)] — i.e. we project away
	// the (j, k) inner sum indices. For a valid bilinear algorithm Γ ≡ 0, so
	// the projection is also zero everywhere. For n = 1 the projection is
	// lossless; for n > 1 it shows how output (s,t) is wired across (i,l).
	let blocks = $derived.by(() => {
		const G = game.residual;
		const sb = n * p;
		const sc = m * p;
		const out: Int32Array[] = [];
		for (let s = 0; s < m; s++) {
			for (let t = 0; t < p; t++) {
				const block = new Int32Array(m * p);
				const c = s * p + t;
				for (let i = 0; i < m; i++) {
					for (let l = 0; l < p; l++) {
						let sum = 0;
						for (let j = 0; j < n; j++) {
							for (let k = 0; k < n; k++) {
								const a = i * n + j;
								const b = k * p + l;
								sum += G[(a * sb + b) * sc + c];
							}
						}
						block[i * p + l] = sum;
					}
				}
				out.push(block);
			}
		}
		return out;
	});

	// Cell pixel size scales down for big layouts. Outer matrix is m × p,
	// inner is m × p, so total span is (m·m) × (p·p) cells. Breakpoints
	// are perfect squares so the buckets align with whole board side
	// lengths: ≤4 = ⟨2,2,2⟩-class, ≤9 = ⟨3,3,3⟩, ≤16 = ⟨4,4,4⟩, ≤25 =
	// ⟨5,5,5⟩, and so on. Tuned to keep the rendered matrix readable
	// on desktop while still fitting inside the bottom-pinned residual
	// panel on mobile (capped at 44dvh in the media query below); keep
	// these two numbers in sync if either is retuned.
	let cellPx = $derived.by(() => {
		const maxDim = Math.max(m * m, p * p);
		if (maxDim <= 4) return 24;
		if (maxDim <= 9) return 16;
		if (maxDim <= 16) return 10;
		if (maxDim <= 25) return 9;
		if (maxDim <= 36) return 6;
		if (maxDim <= 49) return 4;
		if (maxDim <= 64) return 4;
		return 4;
	});

	function classFor(v: number): string {
		if (v === 0) return 'r-zero';
		if (v === 1) return 'r-pos1';
		if (v === -1) return 'r-neg1';
		if (v > 1) return 'r-posN';
		return 'r-negN';
	}

	function tooltipFor(blockIdx: number, innerIdx: number, v: number): string {
		const s = Math.floor(blockIdx / p);
		const t = blockIdx % p;
		const i = Math.floor(innerIdx / p);
		const l = innerIdx % p;
		const tag = n === 1
			? `Γ[(${i},0),(0,${l}),(${s},${t})]`
			: `Σⱼₖ Γ[(${i},j),(k,${l}),(${s},${t})]`;
		return `${tag} = ${v}`;
	}
</script>

<div class="wrap">
	<header>
		<h2>Residual <span class="symbol">Γ</span></h2>
		<p class="hint">
			{m} × {p} array of {m} × {p} blocks.
			Outer&nbsp;<code>(s,t)</code> = produced output C[s,t]; inner&nbsp;<code>(i,l)</code> = ideal
			output C[i,l]. Goal: every cell zero.
		</p>
	</header>

	<div
		class="outer"
		style:grid-template-columns={`repeat(${p}, auto)`}
		style:--cell={`${cellPx}px`}
		style:--inner-rows={m}
		style:--inner-cols={p}
	>
		{#each blocks as block, blockIdx (blockIdx)}
			<div
				class="inner"
				style:grid-template-columns={`repeat(${p}, var(--cell))`}
			>
				{#each block as v, innerIdx (innerIdx)}
					<span
						class={'rcell ' + classFor(v)}
						title={tooltipFor(blockIdx, innerIdx, v)}
						aria-label={tooltipFor(blockIdx, innerIdx, v)}
					></span>
				{/each}
			</div>
		{/each}
	</div>

	<div class="legend">
		<span><span class="sw r-zero"></span> Γ = 0 (good)</span>
		<span><span class="sw r-pos1"></span> Γ = +1</span>
		<span><span class="sw r-neg1"></span> Γ = −1</span>
		<span><span class="sw r-posN"></span> Γ &gt; +1</span>
		<span><span class="sw r-negN"></span> Γ &lt; −1</span>
	</div>
</div>

<style>
	.wrap {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
		align-items: center;
		padding: 1.5rem;
		border: 1px solid rgb(51 65 85);
		border-radius: 14px;
		background: radial-gradient(
			circle at top,
			oklch(0.18 0.02 240 / 0.6),
			oklch(0.12 0.02 240 / 0.6)
		);
	}
	header {
		text-align: center;
	}
	h2 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
		color: rgb(226 232 240);
	}
	h2 .symbol {
		color: rgb(250 204 21);
		font-style: italic;
		margin: 0 0.15em;
	}
	.hint {
		margin: 0.25rem 0 0;
		font-size: 0.78rem;
		color: rgb(148 163 184);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		max-width: 60ch;
	}
	.hint code {
		color: rgb(125 211 252);
	}

	.outer {
		display: grid;
		gap: 6px;
		padding: 8px;
		background: rgb(2 6 23);
		border-radius: 8px;
		max-width: 100%;
		overflow: auto;
		box-shadow: inset 0 0 0 1px rgb(30 41 59);
	}
	.inner {
		display: grid;
		gap: 1px;
		padding: 2px;
		background: oklch(0.22 0.02 240);
		border-radius: 4px;
		box-shadow: inset 0 0 0 1px oklch(0.32 0.04 240);
	}
	.rcell {
		width: var(--cell);
		height: var(--cell);
		display: block;
		border-radius: 1px;
	}
	.r-zero {
		/* Same yellow as the empty-cell colour on the active page in the
		   3D boards. The boards build that colour via THREE.js setHSL() in
		   linear-sRGB space (hue 60°, s≈0.71, l=0.55), which the renderer
		   then gamma-encodes to roughly sRGB #f0f084 — i.e. oklch ≈ this. */
		background: oklch(0.93 0.13 108);
	}
	.r-pos1 {
		background: oklch(0.7 0.18 145);
	}
	.r-neg1 {
		background: oklch(0.65 0.22 25);
	}
	.r-posN {
		background: oklch(0.85 0.22 145);
		box-shadow: inset 0 0 0 1px oklch(0.95 0.18 145);
	}
	.r-negN {
		background: oklch(0.85 0.22 25);
		box-shadow: inset 0 0 0 1px oklch(0.95 0.18 25);
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.6rem 1.1rem;
		justify-content: center;
		align-items: center;
		margin-top: 0.5rem;
		padding-top: 0.6rem;
		border-top: 1px solid rgb(30 41 59);
		font-size: 0.75rem;
		color: rgb(148 163 184);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		max-width: 60ch;
	}
	.sw {
		display: inline-block;
		width: 12px;
		height: 12px;
		border-radius: 2px;
		margin-right: 0.35em;
		vertical-align: middle;
	}
	.legend .r-posN,
	.legend .r-negN {
		box-shadow: inset 0 0 0 1px oklch(0.95 0.18 145);
	}
	.legend .r-negN {
		box-shadow: inset 0 0 0 1px oklch(0.95 0.18 25);
	}

	@media (max-width: 540px) {
		/* Pin the entire residual panel (header + matrix + legend) to
		   the bottom of the viewport, stacked just above the fixed
		   mobile score bar in Game.svelte. The score bar's effective
		   height is ≈ 2.85rem (0.55rem padding × 2 + ≈1.75rem for the
		   1.25rem value glyph at line-height 1.4) plus any iOS
		   home-indicator inset. We bake that offset into the `bottom`
		   here so the residual always sits flush above the score
		   readout regardless of how far the page has scrolled. z-index
		   59 keeps the panel above page content but below the score
		   bar (z 60), so any half-pixel rounding overlap resolves with
		   the score on top.

		   `max-height` caps the panel to 44dvh of the viewport; if the
		   matrix is taller than that on big games (e.g. ⟨5,5,5⟩ →
		   25×25 cells), the .outer grid scrolls internally instead of
		   pushing the legend off the screen. */
		.wrap {
			position: fixed;
			left: 0;
			right: 0;
			bottom: calc(2.85rem + env(safe-area-inset-bottom, 0px));
			z-index: 59;
			width: 100%;
			max-width: none;
			max-height: 44dvh;
			padding: 0.5rem 0.6rem;
			gap: 0.35rem;
			border: 0;
			border-top: 1px solid rgb(51 65 85);
			border-bottom: 1px solid rgb(51 65 85);
			border-radius: 0;
			background: oklch(0.14 0.02 240 / 0.92);
			backdrop-filter: blur(8px);
			box-shadow: 0 -6px 18px rgba(0, 0, 0, 0.45);
		}
		/* Compact the header: shrink the title and drop the long
		   explanatory hint so all the available height goes to the
		   matrix itself. */
		h2 {
			font-size: 0.85rem;
		}
		.hint {
			display: none;
		}
		/* Let the matrix consume the remaining vertical space and
		   scroll internally when the rendered grid is larger than
		   what fits. `min-height: 0` is required so a flex child
		   with `overflow: auto` actually shrinks below its content
		   size; without it, browsers refuse to clip and the panel
		   overflows the cap. */
		.outer {
			flex: 1 1 auto;
			min-height: 0;
			max-width: 100%;
		}
		.legend {
			padding-top: 0.35rem;
			margin-top: 0;
			gap: 0.2rem 0.7rem;
			font-size: 0.65rem;
		}
		.legend .sw {
			width: 10px;
			height: 10px;
			margin-right: 0.25em;
		}
	}
</style>
