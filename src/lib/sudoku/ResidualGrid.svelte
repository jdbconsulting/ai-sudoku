<script lang="ts">
	import { untrack } from 'svelte';
	import type { GameState } from './state.svelte';

	let { game }: { game: GameState } = $props();

	let m = $derived(game.m);
	let n = $derived(game.n);
	let p = $derived(game.p);
	// game.residual is reactive (recomputes when game.version bumps), so
	// pulling it through $derived is the only thing the canvas needs to
	// observe — every cycle/setCell/clear/etc triggers a redraw.
	let G = $derived(game.residual);

	// Total cell count = (m·p) × (n·p) × (m·n) = m²·n²·p². At ⟨5,5,5⟩
	// that's 15,625 cells; at the ⟨7,7,7⟩ ceiling it's 117,649. The DOM
	// can't reasonably handle that many elements (the previous
	// implementation projected away (j,k) to keep the cell count
	// manageable, which hid half of Γ's structure). We render the full
	// tensor onto a single 2D canvas via putImageData() instead — one
	// allocation per redraw, raster pixel writes, GPU-accelerated upload
	// on most browsers.

	// === Layout ============================================================
	// The user-facing nesting is "an m×n matrix of (n×p matrices of (m×p
	// matrices))" — outer = A, middle = B, inner = C, ordered so that
	// the matrix the player just edited shows up in the most localized
	// region of the residual:
	//   outer (i, j)  ∈ m × n   — which input cell A[i, j] contributed
	//   middle (k, l) ∈ n × p   — which input cell B[k, l] contributed
	//   inner (s, t)  ∈ m × p   — which produced output cell C[s, t]
	// So a single cell at (i, j, k, l, s, t) is Γ[(i,j), (k,l), (s,t)].
	// What this gets you visually:
	//   * Editing A[i, j, r] only changes Γ[(i,j), *, *] — i.e. one
	//     entire OUTER block lights up (most localized).
	//   * Editing B[k, l, r] changes Γ[*, (k,l), *] — i.e. one
	//     middle cell inside *every* outer block.
	//   * Editing C[s, t, r] changes Γ[*, *, (s,t)] — i.e. one
	//     inner cell inside every middle inside every outer (most
	//     spread out).
	// G's flat index is (a · sb + b) · sc + c where
	//   a = i·n + j   ∈ [0, m·n)
	//   b = k·p + l   ∈ [0, n·p)
	//   c = s·p + t   ∈ [0, m·p)
	// (matches `computeTargetTensor` / `computeResidual` in tensor.ts).

	// Cell size in **natural** (offscreen drawing-buffer) pixels.
	// `blitToOnScreen()` resamples this offscreen buffer onto the
	// on-screen canvas via canvas2d's high-quality `drawImage`
	// (bicubic/Lanczos on Chrome, bilinear elsewhere). The tiers
	// below are sized so that the natural buffer is always
	// roughly 1.5–2× larger than the displayed footprint — that's
	// the sweet spot where the high-quality downsampler has
	// enough source pixels to produce clean anti-aliased cell
	// edges and a uniform gap network. Going much smaller (the
	// previous cellPx=2 for ⟨7,7,7⟩+ tier) put the source at
	// roughly 1:1 with the device pixels, leaving the resampler
	// with no headroom and producing visible stair-stepping.
	// Memory cost peaks at the ⟨7,7,7⟩ ceiling ≈ 1774² × 4 ≈
	// 12.6 MB — fine.
	let cellPx = $derived.by(() => {
		const maxDim = Math.max(m, n, p);
		if (maxDim <= 2) return 16;
		if (maxDim <= 3) return 14;
		if (maxDim <= 4) return 10;
		if (maxDim <= 5) return 8;
		if (maxDim <= 6) return 5;
		if (maxDim <= 7) return 4;
		return 3;
	});

	// Pixel gaps between cells / between blocks at each nesting level.
	// Held constant (not scaled with cellPx) so the hierarchy stays
	// visible even when cells shrink to a couple pixels on big boards.
	const INNER_GAP = 1;
	const MIDDLE_GAP = 2;
	const OUTER_GAP = 4;

	// Background colors for the three nesting levels (slate shades that
	// progressively lighten from outermost wrapper down to the cell
	// gaps within an mn matrix). Stored as raw RGB triples since we
	// write them directly into the ImageData byte buffer.
	const BG = [2, 6, 23] as const; // slate-950 (between np blocks)
	const MIDDLE_BG = [30, 41, 59] as const; // slate-800 (between mn matrices in an np block)
	const INNER_BG = [68, 84, 107] as const; // slate-600 (between cells in an mn matrix)

	// Cell colors keyed by Γ value. Mirrors the legend swatches at the
	// bottom (which use the same RGB tuples in CSS via rgb()). The
	// goal-state yellow is matched to the empty-cell yellow that
	// `Board3D.svelte` paints onto the 3D board: that material is
	// `hueColor(0.55, 0.17, 60)` ≡ `THREE.Color.setHSL(60/360, 0.714,
	// 0.55)` in linear-sRGB working space, which the WebGLRenderer
	// gamma-encodes to sRGB ≈ (240, 240, 131) at framebuffer write
	// (`outputColorSpace = SRGBColorSpace`, `toneMapped: false`).
	// We write that sRGB triple straight into the residual ImageData
	// so a Γ = 0 cell on the heatmap reads as the same yellow as an
	// unpicked cell on the 3D board next to it.
	//
	// With the broader alphabets (half-integer / ±2) the residual can
	// take fractional and |Γ| > 1 integer values, so we bucket by sign
	// and magnitude rather than test for exact ±1. The "fractional"
	// (0 < |Γ| < 1) tier uses a paler tint than the |Γ| == 1 baseline
	// so a player working in a ±½-bearing alphabet can still pick out
	// the half-magnitude errors at a glance.
	function rgbFor(v: number): readonly [number, number, number] {
		if (v === 0) return [240, 240, 131]; // yellow — matches Board3D empty cell
		const abs = v < 0 ? -v : v;
		if (v > 0) {
			if (abs < 1) return [187, 247, 208]; // green-200 (fractional +Γ)
			if (abs === 1) return [74, 222, 128]; // green-400
			return [134, 239, 172]; // green-300 (>+1)
		}
		if (abs < 1) return [254, 202, 202]; // red-200 (fractional −Γ)
		if (abs === 1) return [239, 68, 68]; // red-500
		return [252, 165, 165]; // red-300 (<−1)
	}

	// Per-block dimensions in pixels. Pure derivations from
	// (m, n, p, cellPx) so picking + drawing always agree.
	//   inner  = C grid: m rows × p cols
	//   middle = B grid (of inner blocks): n rows × p cols
	//   outer  = A grid (of middle blocks): m rows × n cols
	let innerW = $derived(p * cellPx + Math.max(0, p - 1) * INNER_GAP);
	let innerH = $derived(m * cellPx + Math.max(0, m - 1) * INNER_GAP);
	let middleW = $derived(p * innerW + Math.max(0, p - 1) * MIDDLE_GAP);
	let middleH = $derived(n * innerH + Math.max(0, n - 1) * MIDDLE_GAP);
	let totalW = $derived(n * middleW + Math.max(0, n - 1) * OUTER_GAP);
	let totalH = $derived(m * middleH + Math.max(0, m - 1) * OUTER_GAP);

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let wrapEl: HTMLDivElement | undefined = $state();

	// Two-stage rendering pipeline:
	//   1. `renderHeatmap()` paints the full `totalW × totalH` natural
	//      pixel buffer of the heatmap into an offscreen canvas via
	//      `putImageData()` — same hierarchy, same per-cell colors as
	//      before.
	//   2. `blitToOnScreen()` sizes the on-screen canvas drawing
	//      buffer to the displayed CSS dimensions × devicePixelRatio
	//      (capped at natural for upscale) and `drawImage`s the
	//      offscreen onto it with `imageSmoothingQuality: 'high'`.
	//
	// The reason we don't just CSS-scale a single natural-size
	// canvas: when a canvas element is itself stretched/shrunk by
	// CSS, the browser applies a fixed (often nearest-neighbour or
	// low-tier bilinear) filter that varies by engine and produces
	// visible aliasing on big games. Doing the resample ourselves
	// via `drawImage` lets us pick the high-quality filter
	// (Lanczos/bicubic on Chrome, bilinear elsewhere) and gives a
	// consistent look across browsers — the heatmap's 1-px gap
	// network blends into clean anti-aliased lines instead of
	// speckled stair-stepping.
	let offCanvas: HTMLCanvasElement | null = null;
	let offCtx: CanvasRenderingContext2D | null = null;

	function ensureOffscreen(w: number, h: number): CanvasRenderingContext2D | null {
		if (!offCanvas) offCanvas = document.createElement('canvas');
		if (offCanvas.width !== w) offCanvas.width = w;
		if (offCanvas.height !== h) offCanvas.height = h;
		if (!offCtx) offCtx = offCanvas.getContext('2d');
		return offCtx;
	}

	// Reusable ImageData object so we don't churn the allocator on
	// every game.cycle. Reallocated only when the canvas natural size
	// changes (m/n/p/cellPx change). We obtain it from
	// `ctx.createImageData()` rather than constructing a Uint8ClampedArray
	// directly because the latter's buffer type union (ArrayBuffer |
	// SharedArrayBuffer) can't be passed to the ImageData constructor.
	let imageData: ImageData | null = null;

	function ensureImageData(ctx: CanvasRenderingContext2D, w: number, h: number): ImageData {
		if (!imageData || imageData.width !== w || imageData.height !== h) {
			imageData = ctx.createImageData(w, h);
		}
		return imageData;
	}

	function fillRectInto(
		data: Uint8ClampedArray,
		stride: number,
		x: number,
		y: number,
		w: number,
		h: number,
		r: number,
		g: number,
		b: number
	) {
		for (let py = 0; py < h; py++) {
			let off = ((y + py) * stride + x) * 4;
			for (let px = 0; px < w; px++) {
				data[off++] = r;
				data[off++] = g;
				data[off++] = b;
				data[off++] = 255;
			}
		}
	}

	function renderHeatmap() {
		const W = totalW;
		const H = totalH;
		if (W === 0 || H === 0) return;

		// Render at natural resolution into the offscreen canvas;
		// `blitToOnScreen()` is responsible for the actual on-screen
		// presentation (sizing + smooth downsampling).
		const ctx = ensureOffscreen(W, H);
		if (!ctx) return;

		const img = ensureImageData(ctx, W, H);
		const data = img.data;

		// 1. Outermost background fills the whole canvas first; the
		//    "between A-blocks" gaps will be the only pixels left
		//    showing this color after the next two passes.
		fillRectInto(data, W, 0, 0, W, H, BG[0], BG[1], BG[2]);

		const sb = n * p;
		const sc = m * p;

		// 2. Outer = A[i, j] block (m rows × n cols). Paint the
		//    middle-block background, then descend.
		for (let i = 0; i < m; i++) {
			for (let j = 0; j < n; j++) {
				const outerX = j * (middleW + OUTER_GAP);
				const outerY = i * (middleH + OUTER_GAP);
				fillRectInto(
					data,
					W,
					outerX,
					outerY,
					middleW,
					middleH,
					MIDDLE_BG[0],
					MIDDLE_BG[1],
					MIDDLE_BG[2]
				);

				// 3. Middle = B[k, l] block (n rows × p cols).
				//    Paint the inner-block background, then descend.
				for (let k = 0; k < n; k++) {
					for (let l = 0; l < p; l++) {
						const middleX = outerX + l * (innerW + MIDDLE_GAP);
						const middleY = outerY + k * (innerH + MIDDLE_GAP);
						fillRectInto(
							data,
							W,
							middleX,
							middleY,
							innerW,
							innerH,
							INNER_BG[0],
							INNER_BG[1],
							INNER_BG[2]
						);

						// 4. Inner = C[s, t] cells (m rows × p cols).
						//    Paint the actual residual value's color
						//    over its cellPx × cellPx square.
						const a = i * n + j;
						const b = k * p + l;
						const ab = (a * sb + b) * sc;
						for (let s = 0; s < m; s++) {
							for (let t = 0; t < p; t++) {
								const cellX = middleX + t * (cellPx + INNER_GAP);
								const cellY = middleY + s * (cellPx + INNER_GAP);
								const c = s * p + t;
								const v = G[ab + c];
								const rgb = rgbFor(v);
								fillRectInto(data, W, cellX, cellY, cellPx, cellPx, rgb[0], rgb[1], rgb[2]);
							}
						}
					}
				}
			}
		}

		ctx.putImageData(img, 0, 0);
		// Push the freshly-rendered offscreen image to the
		// on-screen canvas. When only Γ's values change (cellPx /
		// m / n / p unchanged) the offscreen size doesn't shift,
		// so this is just a re-blit at the current display size.
		blitToOnScreen();
	}

	// Fraction of the wrap interior the heatmap occupies on its
	// fitting axis. Stopping at 0.9 (i.e. a 5% margin on each
	// side) keeps the heatmap's outermost cells from butting hard
	// against the wrap's 1-px border. We need it that aggressive
	// because the wrap's slate-950 background and the heatmap's
	// outermost `BG = [2, 6, 23]` (also slate-950) are pixel-
	// identical, so a tighter margin would visually melt into the
	// outer-block gap network and read as part of the heatmap
	// rather than as breathing room. The other axis already has
	// whatever letterbox/pillar-box margin its aspect mismatch
	// produces; this just guarantees a minimum visual gap on
	// every side regardless of aspect.
	const FIT_SCALE = 0.9;

	// Resample the natural-resolution offscreen heatmap onto the
	// on-screen canvas. The on-screen drawing buffer is sized to
	// the displayed CSS dim × devicePixelRatio so it maps 1:1 to
	// device pixels — no browser-side CSS scaling kicks in, and
	// every visible pixel comes straight from a `drawImage()` call
	// with `imageSmoothingQuality: 'high'`.
	//
	// The previous version had an "upscaling shortcut" that left
	// the buffer at the natural source size whenever
	// `displayed × DPR ≥ natural`, then relied on
	// `image-rendering: pixelated` to scale up to display via
	// CSS. That breaks on Windows / WSL2 (devicePixelRatio is
	// usually 1.25 or 1.5 due to Windows display scaling): for
	// ⟨5,5,5⟩ at natural 656 px and CSS display ~600 px, the
	// target buffer would compute to 900 (`> 656`), the shortcut
	// would fire, the buffer would stay at 656, and the browser
	// would then *CSS-downscale* 656 → 600 with nearest-neighbour
	// — producing exactly the speckled stair-stepping aliasing
	// from the screenshot. Doing the resample ourselves at the
	// device-pixel resolution avoids the browser's CSS scaling
	// path entirely.
	function blitToOnScreen() {
		if (!canvasEl || !wrapEl || !offCanvas) return;
		const wrapW = wrapEl.clientWidth;
		const wrapH = wrapEl.clientHeight;
		if (wrapW === 0 || wrapH === 0) return;
		const W = offCanvas.width;
		const H = offCanvas.height;
		if (W === 0 || H === 0) return;

		// Compute on-screen display dim with letterbox/pillar-box
		// semantics so the natural aspect is preserved. `FIT_SCALE`
		// shrinks the result a tick below "exact fit" so the
		// heatmap doesn't slam into the wrap's border — the saved
		// pixels become a uniform margin around all four edges
		// (added to whatever letterbox margin the cross-axis
		// already has).
		const wrapAspect = wrapW / wrapH;
		const naturalAspect = W / H;
		let dispW: number;
		let dispH: number;
		if (naturalAspect >= wrapAspect) {
			dispW = wrapW * FIT_SCALE;
			dispH = (wrapW / naturalAspect) * FIT_SCALE;
		} else {
			dispH = wrapH * FIT_SCALE;
			dispW = (wrapH * naturalAspect) * FIT_SCALE;
		}

		// Drawing buffer = displayed CSS px × DPR. This is the
		// real device-pixel resolution that hits the screen, so
		// CSS won't scale the canvas after we draw into it.
		const dpr = window.devicePixelRatio || 1;
		const bufW = Math.max(1, Math.round(dispW * dpr));
		const bufH = Math.max(1, Math.round(dispH * dpr));

		if (canvasEl.width !== bufW) canvasEl.width = bufW;
		if (canvasEl.height !== bufH) canvasEl.height = bufH;
		canvasEl.style.width = dispW + 'px';
		canvasEl.style.height = dispH + 'px';

		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;

		// Setting `canvas.width/height` resets the 2d context
		// state, including imageSmoothing — so we have to (re)set
		// it every blit, not just once. The interpolation choice
		// scales with the board size automatically, because the
		// natural-buffer size scales with ⟨m, n, p⟩ while the
		// device-pixel buffer is governed by the wrap geometry:
		//   * Upscaling (`bufW > W`, i.e. each natural pixel maps
		//     to >1 device pixel — small boards like ⟨2,2,2⟩ at
		//     140 px natural blowing up to ~480+ device px). Turn
		//     smoothing OFF so drawImage falls back to nearest-
		//     neighbour. With `imageSmoothingQuality: 'high'` on,
		//     Lanczos/bicubic blurs every strong yellow→slate
		//     cell boundary into a fat anti-aliased halo, which
		//     reads as "smudged" on cells that are already 50+
		//     device pixels wide. Nearest-neighbour keeps the
		//     cell edges razor-crisp; the only cost is sub-pixel
		//     non-uniformity (one row of cells might be 1 device
		//     px wider than its neighbour at non-integer scale),
		//     which is invisible at the cell sizes that trigger
		//     this branch.
		//   * Downscaling (`bufW <= W`, i.e. each device pixel
		//     averages multiple natural pixels — large boards
		//     like ⟨7,7,7⟩+ at 1000+ px natural compressed to
		//     fit the wrap). Turn smoothing ON. Without bicubic
		//     averaging, the 1-px INNER_GAP / 2-px MIDDLE_GAP /
		//     4-px OUTER_GAP network drops random pixels and
		//     produces visible stair-stepping. `'high'` picks
		//     Lanczos/bicubic on Chromium and bilinear elsewhere.
		const isUpscaling = bufW > W;
		ctx.imageSmoothingEnabled = !isUpscaling;
		ctx.imageSmoothingQuality = 'high';
		// We size the buffer to device pixels and draw 1:1 with
		// the screen, so the CSS image-rendering keyword is
		// effectively a no-op — but explicitly setting `auto`
		// makes sure no stray `pixelated` from a previous
		// render mode lingers.
		canvasEl.style.imageRendering = 'auto';

		ctx.drawImage(offCanvas, 0, 0, W, H, 0, 0, bufW, bufH);
	}

	$effect(() => {
		// Reactive deps: residual contents, and the layout dims that
		// determine the offscreen buffer size + pixel positions.
		G;
		m;
		n;
		p;
		cellPx;
		untrack(() => renderHeatmap());
	});

	// Watch for wrap resizes (page resize, half-row layout switching
	// to single-column on mobile, etc.) and re-blit the (already
	// rendered) offscreen heatmap at the new display size. No need
	// to re-run `renderHeatmap` itself — the natural pixel buffer
	// is unchanged, only the on-screen presentation needs updating.
	$effect(() => {
		if (!wrapEl) return;
		const obs = new ResizeObserver(() => blitToOnScreen());
		obs.observe(wrapEl);
		return () => obs.disconnect();
	});

	// === Hover tooltip =====================================================
	// On pointermove we map the mouse position back through the exact
	// inverse of the layout above to recover (s, t, k, l, i, j) and
	// look up the value. Returns null when the cursor lands in any of
	// the three gap levels (so the tooltip hides cleanly when hovering
	// the border between blocks).

	type HoverInfo = {
		s: number;
		t: number;
		k: number;
		l: number;
		i: number;
		j: number;
		v: number;
	};

	let hoverInfo = $state<HoverInfo | null>(null);
	let tooltipPos = $state({ x: 0, y: 0 });

	function pickAt(event: PointerEvent): HoverInfo | null {
		if (!canvasEl || !offCanvas) return null;
		const rect = canvasEl.getBoundingClientRect();
		// Map from CSS px → NATURAL pixel coordinates of the
		// offscreen heatmap. The on-screen canvas drawing buffer
		// may be the downsampled display-pixel size (large games),
		// so using its dimensions would scramble the indices for
		// anything past ⟨5,5,5⟩. The offscreen canvas always has
		// the natural `totalW × totalH` size that the layout math
		// below was designed around.
		const px = (event.clientX - rect.left) * (offCanvas.width / rect.width);
		const py = (event.clientY - rect.top) * (offCanvas.height / rect.height);
		if (px < 0 || py < 0 || px >= offCanvas.width || py >= offCanvas.height) return null;

		// Outer = A[i, j]: m rows × n cols.
		const outerColW = middleW + OUTER_GAP;
		const outerRowH = middleH + OUTER_GAP;
		const j = Math.floor(px / outerColW);
		const i = Math.floor(py / outerRowH);
		if (j >= n || i >= m) return null;
		const xInOuter = px - j * outerColW;
		const yInOuter = py - i * outerRowH;
		if (xInOuter >= middleW || yInOuter >= middleH) return null; // OUTER_GAP

		// Middle = B[k, l]: n rows × p cols.
		const middleColW = innerW + MIDDLE_GAP;
		const middleRowH = innerH + MIDDLE_GAP;
		const l = Math.floor(xInOuter / middleColW);
		const k = Math.floor(yInOuter / middleRowH);
		if (l >= p || k >= n) return null;
		const xInMid = xInOuter - l * middleColW;
		const yInMid = yInOuter - k * middleRowH;
		if (xInMid >= innerW || yInMid >= innerH) return null; // MIDDLE_GAP

		// Inner = C[s, t]: m rows × p cols.
		const cellSpan = cellPx + INNER_GAP;
		const t = Math.floor(xInMid / cellSpan);
		const s = Math.floor(yInMid / cellSpan);
		if (t >= p || s >= m) return null;
		const xInCell = xInMid - t * cellSpan;
		const yInCell = yInMid - s * cellSpan;
		if (xInCell >= cellPx || yInCell >= cellPx) return null; // INNER_GAP

		const sb = n * p;
		const sc = m * p;
		const a = i * n + j;
		const b = k * p + l;
		const c = s * p + t;
		const v = G[(a * sb + b) * sc + c];
		return { s, t, k, l, i, j, v };
	}

	function onPointerMove(event: PointerEvent) {
		hoverInfo = pickAt(event);
		tooltipPos = { x: event.clientX, y: event.clientY };
	}

	function onPointerLeave() {
		hoverInfo = null;
	}

	// Big games render hundreds of thousands of cells; the totalCells
	// derivation feeds both the hint line and the aria label.
	let totalCells = $derived(m * m * n * n * p * p);
	const fmtCount = new Intl.NumberFormat('en-US');
</script>

<div class="wrap">
	<header>
		<h2>Residual <span class="symbol">Γ</span></h2>
	</header>

	<div class="canvas-wrap" bind:this={wrapEl}>
		<canvas
			bind:this={canvasEl}
			onpointermove={onPointerMove}
			onpointerleave={onPointerLeave}
			aria-label={`Residual tensor heatmap, ${fmtCount.format(totalCells)} cells`}
		></canvas>
	</div>

	{#if hoverInfo}
		<!-- Tooltip is `position: fixed` so its coordinates are in
		     viewport space. `pointer-events: none` so the cursor still
		     hits the underlying canvas through the tooltip. -->
		<div
			class="tooltip"
			style:left="{tooltipPos.x + 12}px"
			style:top="{tooltipPos.y + 12}px"
		>
			<span class="idx">
				Γ[<code>({hoverInfo.i},{hoverInfo.j})</code>,<code
					>({hoverInfo.k},{hoverInfo.l})</code
				>,<code>({hoverInfo.s},{hoverInfo.t})</code>]
			</span>
			= <strong class="v" class:nz={hoverInfo.v !== 0}>{hoverInfo.v}</strong>
		</div>
	{/if}

	<div class="legend">
		<span><span class="sw r-zero"></span> Γ = 0 (good)</span>
		<span><span class="sw r-pos"></span> Γ &gt; 0</span>
		<span><span class="sw r-neg"></span> Γ &lt; 0</span>
		<br />
		<p class="hint">
			Goal: every cell yellow. Cell brightness scales with |Γ| — paler shades for fractional errors, deeper for |Γ| &gt; 1.
		</p>
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
		max-width: 70ch;
	}

	.canvas-wrap {
		/* Square viewport sized to match the Board3D
		   `.canvas-container` exactly, so the residual canvas
		   has the same on-screen footprint as the game canvas
		   in the side-by-side layout.

		   Width: subtract the two flanking v-sliders Board3D
		   carries (28px each) plus the canvas-row gap on either
		   side (0.45rem each) from the panel's inner width. The
		   residual panel has no v-sliders of its own, so without
		   this calc the wrap would be ~70px wider than the game
		   canvas. Keeping these constants in lockstep with
		   `Board3D.svelte`'s `.v-slider` width and `.canvas-row`
		   gap keeps the two halves of the row visually aligned.

		   Height: `aspect-ratio: 1 / 1` makes the intrinsic
		   height equal to the (already-matched) width, so the
		   wrap is a square the same size as the game canvas.
		   The pair of `flex: 1 1 auto; min-height: 0` lets the
		   wrap also stretch past its square intrinsic in the
		   rare case the residual panel ends up taller than the
		   square (chrome differences with Board3D), absorbing
		   the slack instead of leaving an empty band.

		   The heatmap inside is sized by `blitToOnScreen()` with
		   letterbox / pillar-box semantics so its natural aspect
		   — which varies wildly with ⟨m, n, p⟩, e.g. 312 × 140
		   at ⟨2,2,3⟩ (short+wide), 124 × 278 at ⟨3,2,2⟩
		   (tall+narrow), square for cubes — always shows fully
		   regardless of the wrap's aspect.

		   No `border-radius` and no `overflow: hidden` here —
		   when both were set the rounded clip path bit into the
		   tensor's corner cells, hiding the (i,j) = (0,0) /
		   (m-1,n-1) entries that the player needs to see. The
		   1-px `border` plays the role the inset box-shadow used
		   to (visible chrome around the heatmap), and using
		   `border-box` sizing keeps the wrap exactly half-page
		   wide regardless of the border. */
		width: calc(100% - 2 * (28px + 0.45rem));
		aspect-ratio: 1 / 1;
		flex: 1 1 auto;
		min-height: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgb(2 6 23);
		border: 1px solid rgb(30 41 59);
		box-sizing: border-box;
	}
	canvas {
		/* CSS width/height are set imperatively in
		   `blitToOnScreen()`: the dimensions are the wrap
		   interior fitted to the heatmap's natural aspect with
		   letterbox/pillar-box on non-cube ⟨m, n, p⟩. The
		   drawing buffer is sized to displayed CSS px × DPR so
		   the browser never does its own CSS-scaling pass —
		   we control the resample with `imageSmoothingQuality:
		   'high'` for clean anti-aliasing on big games. */
		display: block;
		cursor: crosshair;
	}

	.tooltip {
		position: fixed;
		z-index: 70;
		pointer-events: none;
		padding: 0.35rem 0.55rem;
		background: oklch(0.16 0.02 240 / 0.95);
		border: 1px solid rgb(51 65 85);
		border-radius: 6px;
		color: rgb(226 232 240);
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.75rem;
		box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
		backdrop-filter: blur(4px);
		white-space: nowrap;
	}
	.tooltip .idx code {
		color: rgb(125 211 252);
	}
	.tooltip .v {
		color: rgb(125 211 252);
		font-variant-numeric: tabular-nums;
		margin-left: 0.1em;
	}
	.tooltip .v.nz {
		color: oklch(0.85 0.18 50);
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
		width: 100%;
		align-self: stretch;
		box-sizing: border-box;
	}
	.sw {
		display: inline-block;
		width: 12px;
		height: 12px;
		border-radius: 2px;
		margin-right: 0.35em;
		vertical-align: middle;
	}
	/* Match the canvas's rgbFor() exactly so the legend swatches
	   are pixel-identical to what the canvas paints. We collapse
	   the six per-magnitude buckets the canvas uses (paler /
	   baseline / deeper for each sign) down to a single
	   representative swatch per sign — the canvas still paints
	   the full gradient, and the hint line tells the player to
	   read magnitude off brightness. The baseline |Γ| = 1 shade
	   is the representative because it's the densest signal on
	   the classical {−1, 0, +1} alphabet that everyone starts in. */
	.r-zero {
		background: rgb(240 240 131);
	}
	.r-pos {
		background: rgb(74 222 128);
	}
	.r-neg {
		background: rgb(239 68 68);
	}

	@media (max-width: 540px) {
		/* On phones the residual panel flows in normal page order
		   below the Board3D card (the parent grid collapses to a
		   single column at ≤960px). Only the typography is dialled
		   down a notch here so the legend doesn't wrap awkwardly on
		   narrow viewports — sizing/positioning is unchanged from
		   desktop. */
		h2 {
			font-size: 0.85rem;
		}
		.legend {
			padding-top: 0.35rem;
			margin-top: 0;
			gap: 0.2rem 0.7rem;
			font-size: 0.65rem;
		}
		.sw {
			width: 10px;
			height: 10px;
			margin-right: 0.25em;
		}
	}
</style>
