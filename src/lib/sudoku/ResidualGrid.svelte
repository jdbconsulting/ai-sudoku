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
	// inner is m × p, so total span is (m·m) × (p·p) cells.
	let cellPx = $derived.by(() => {
		const maxDim = Math.max(m * m, p * p);
		if (maxDim <= 8) return 26;
		if (maxDim <= 16) return 18;
		if (maxDim <= 32) return 12;
		if (maxDim <= 64) return 8;
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
		background: oklch(0.86 0.18 95);
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
</style>
