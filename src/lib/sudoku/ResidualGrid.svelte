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
	//
	// Heatmap geometry (`chooseLayout`) depends only on ⟨m,n,p⟩, the **wrap**
	// CSS size, and **devicePixelRatio** — never on hard-coded puzzle tiers.
	// Among layouts that fit with integer NN upscale, we prefer **larger**
	// outerGap, then middleGap, then innerGap, then cellPx (lexicographic).

	const FIT_SCALE = 0.9;
	/** Min device pixels along one edge of an inner cell after integer blit scale k (cellPx × k). */
	const MIN_INNER_DEVICE_PX = 2;
	const MAX_CELL_PX_SEARCH = 24;

	type HeatmapLayout = {
		cellPx: number;
		innerGap: number;
		middleGap: number;
		outerGap: number;
		innerW: number;
		innerH: number;
		middleW: number;
		middleH: number;
		totalW: number;
		totalH: number;
	};

	function computeDimensions(
		m: number,
		n: number,
		p: number,
		cellPx: number,
		innerGap: number,
		middleGap: number,
		outerGap: number
	): Omit<HeatmapLayout, 'cellPx' | 'innerGap' | 'middleGap' | 'outerGap'> {
		const innerW = p * cellPx + Math.max(0, p - 1) * innerGap;
		const innerH = m * cellPx + Math.max(0, m - 1) * innerGap;
		const middleW = p * innerW + Math.max(0, p - 1) * middleGap;
		const middleH = n * innerH + Math.max(0, n - 1) * middleGap;
		const totalW = n * middleW + Math.max(0, n - 1) * outerGap;
		const totalH = m * middleH + Math.max(0, m - 1) * outerGap;
		return { innerW, innerH, middleW, middleH, totalW, totalH };
	}

	// Same letterbox math as `blitToOnScreen` — must stay in sync.
	function fitTargetBuffer(
		wrapW: number,
		wrapH: number,
		dpr: number,
		natW: number,
		natH: number
	): { tw: number; th: number } {
		const wrapAspect = wrapW / wrapH;
		const naturalAspect = natW / natH;
		let dispW: number;
		let dispH: number;
		if (naturalAspect >= wrapAspect) {
			dispW = wrapW * FIT_SCALE;
			dispH = (wrapW / naturalAspect) * FIT_SCALE;
		} else {
			dispH = wrapH * FIT_SCALE;
			dispW = (wrapH * naturalAspect) * FIT_SCALE;
		}
		return {
			tw: Math.max(1, Math.round(dispW * dpr)),
			th: Math.max(1, Math.round(dispH * dpr))
		};
	}

	/** Lexicographic order for layout preference: outerGap → middleGap → innerGap → cellPx (larger first). */
	function lexGreater(a: [number, number, number, number], b: [number, number, number, number]): boolean {
		for (let i = 0; i < 4; i++) {
			if (a[i] !== b[i]) return a[i] > b[i];
		}
		return false;
	}

	/** How far we search in gap space — driven only by canvas (device px, short side after FIT). */
	function gapSearchBounds(wrapW: number, wrapH: number, dpr: number) {
		const shortDev = Math.min(wrapW, wrapH) * dpr * FIT_SCALE;
		const maxOuter = Math.min(10, Math.max(0, Math.floor(shortDev / 48)));
		const maxMiddle = Math.min(8, Math.max(0, Math.floor(shortDev / 64)));
		const maxInnerGap = 2;
		return { maxOuter, maxMiddle, maxInnerGap };
	}

	function fallbackLayoutDims(m: number, n: number, p: number): HeatmapLayout {
		const cellPx = 8;
		const innerGap = 1;
		const middleGap = 2;
		const outerGap = 4;
		return {
			cellPx,
			innerGap,
			middleGap,
			outerGap,
			...computeDimensions(m, n, p, cellPx, innerGap, middleGap, outerGap)
		};
	}

	/**
	 * Picks (outerGap, middleGap, innerGap, cellPx) using only m,n,p, wrap size, and DPR.
	 * Feasible layouts must allow integer blit upscale (k ≥ 1) and cellPx × k ≥ MIN_INNER_DEVICE_PX.
	 * Among those, maximize lexicographically (outerGap, middleGap, innerGap, cellPx).
	 */
	function chooseLayout(
		m: number,
		n: number,
		p: number,
		wrapW: number,
		wrapH: number
	): HeatmapLayout {
		if (typeof window === 'undefined' || wrapW <= 0 || wrapH <= 0) {
			return fallbackLayoutDims(m, n, p);
		}

		const dpr = window.devicePixelRatio || 1;
		const { maxOuter, maxMiddle, maxInnerGap } = gapSearchBounds(wrapW, wrapH, dpr);

		let best: HeatmapLayout | null = null;
		let bestLex: [number, number, number, number] = [-1, -1, -1, -1];

		for (let outerGap = maxOuter; outerGap >= 0; outerGap--) {
			for (let middleGap = maxMiddle; middleGap >= 0; middleGap--) {
				for (let innerGap = maxInnerGap; innerGap >= 0; innerGap--) {
					for (let cellPx = MAX_CELL_PX_SEARCH; cellPx >= 1; cellPx--) {
						const dims = computeDimensions(m, n, p, cellPx, innerGap, middleGap, outerGap);
						const { tw, th } = fitTargetBuffer(wrapW, wrapH, dpr, dims.totalW, dims.totalH);
						const kFit = Math.min(tw / dims.totalW, th / dims.totalH);
						if (kFit < 1) continue;
						const k = Math.floor(kFit);
						if (cellPx * k < MIN_INNER_DEVICE_PX) continue;
						const lex: [number, number, number, number] = [
							outerGap,
							middleGap,
							innerGap,
							cellPx
						];
						if (lexGreater(lex, bestLex)) {
							bestLex = lex;
							best = { cellPx, innerGap, middleGap, outerGap, ...dims };
						}
					}
				}
			}
		}

		if (best) return best;

		let bestMetric = -1;
		let best2: HeatmapLayout | null = null;
		let bestLex2: [number, number, number, number] = [-1, -1, -1, -1];

		for (let outerGap = maxOuter; outerGap >= 0; outerGap--) {
			for (let middleGap = maxMiddle; middleGap >= 0; middleGap--) {
				for (let innerGap = maxInnerGap; innerGap >= 0; innerGap--) {
					for (let cellPx = MAX_CELL_PX_SEARCH; cellPx >= 1; cellPx--) {
						const dims = computeDimensions(m, n, p, cellPx, innerGap, middleGap, outerGap);
						const { tw, th } = fitTargetBuffer(wrapW, wrapH, dpr, dims.totalW, dims.totalH);
						const kFit = Math.min(tw / dims.totalW, th / dims.totalH);
						const metric = cellPx * kFit;
						const lex: [number, number, number, number] = [
							outerGap,
							middleGap,
							innerGap,
							cellPx
						];
						if (
							metric > bestMetric ||
							(metric === bestMetric && lexGreater(lex, bestLex2))
						) {
							bestMetric = metric;
							bestLex2 = lex;
							best2 = { cellPx, innerGap, middleGap, outerGap, ...dims };
						}
					}
				}
			}
		}

		return best2 ?? fallbackLayoutDims(m, n, p);
	}

	// Wrap size (CSS px) — drives `chooseLayout`. ResizeObserver keeps this
	// synced so cellPx / gaps react to panel size and DPR changes.
	let wrapCssW = $state(0);
	let wrapCssH = $state(0);
	// Bumped on `window.resize` so layout re-reads DPR when the OS zoom / monitor changes.
	let displayMetricsRev = $state(0);

	let layout = $derived.by(() => {
		displayMetricsRev;
		return chooseLayout(m, n, p, wrapCssW, wrapCssH);
	});

	let cellPx = $derived(layout.cellPx);
	let innerGap = $derived(layout.innerGap);
	let innerW = $derived(layout.innerW);
	let innerH = $derived(layout.innerH);
	let middleW = $derived(layout.middleW);
	let middleH = $derived(layout.middleH);
	let totalW = $derived(layout.totalW);
	let totalH = $derived(layout.totalH);
	/** Aliased in render/pick for readability — same as `layout.middleGap` / `outerGap`. */
	let MIDDLE_GAP = $derived(layout.middleGap);
	let OUTER_GAP = $derived(layout.outerGap);

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

	// Block dimensions come from `layout` (cellPx, innerGap, MIDDLE_GAP, OUTER_GAP).

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let wrapEl: HTMLDivElement | undefined = $state();

	// Two-stage rendering pipeline:
	//   1. `renderHeatmap()` paints the full `totalW × totalH` natural
	//      pixel buffer via `putImageData()` — same hierarchy as the
	//      layout derivations (`innerGap`, cellPx, etc.).
	//   2. `blitToOnScreen()` maps that buffer to device pixels with
	//      **only** integer uniform scale factors (when upscaling) and
	//      `imageSmoothingEnabled = false` always, so the smallest
	//      feature is one sharp pixel — no bilinear or bicubic blur.
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
		// `blitToOnScreen()` is responsible for presentation (integer
		// scale + nearest-neighbour blit to device pixels).
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
								const cellX = middleX + t * (cellPx + innerGap);
								const cellY = middleY + s * (cellPx + innerGap);
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

	// `FIT_SCALE` lives at top of script — shared with `fitTargetBuffer`
	// and `chooseLayout` so layout search matches the blit exactly.

	// Map the natural-resolution offscreen heatmap onto the on-screen
	// canvas. The backing store matches device pixels (no CSS scaling).
	// Upscaling: integer k with buf = k×(W,H). Downscale: FIT target
	// dimensions. `imageSmoothingEnabled` stays false — nearest-neighbour
	// only. Historically we avoided CSS-scaling the canvas element because
	// OS-scale factors (e.g. Windows 125%) produced inconsistent filters;
	// explicit `drawImage` sizing keeps that under our control.
	function blitToOnScreen() {
		if (!canvasEl || !wrapEl || !offCanvas) return;
		const wrapW = wrapEl.clientWidth;
		const wrapH = wrapEl.clientHeight;
		if (wrapW === 0 || wrapH === 0) return;
		const W = offCanvas.width;
		const H = offCanvas.height;
		if (W === 0 || H === 0) return;

		const dpr = window.devicePixelRatio || 1;
		const { tw: targetBufW, th: targetBufH } = fitTargetBuffer(wrapW, wrapH, dpr, W, H);

		// Integer upscale keeps every natural pixel (including middle /
		// outer gutters) a uniform k×k block. Downscale uses the FIT target
		// size with nearest-neighbour only (no bilinear / bicubic).
		const kFit = Math.min(targetBufW / W, targetBufH / H);
		let bufW: number;
		let bufH: number;
		if (kFit >= 1) {
			const k = Math.max(1, Math.floor(kFit));
			bufW = W * k;
			bufH = H * k;
		} else {
			bufW = targetBufW;
			bufH = targetBufH;
		}

		if (canvasEl.width !== bufW) canvasEl.width = bufW;
		if (canvasEl.height !== bufH) canvasEl.height = bufH;
		canvasEl.style.width = bufW / dpr + 'px';
		canvasEl.style.height = bufH / dpr + 'px';

		const ctx = canvasEl.getContext('2d');
		if (!ctx) return;

		// `canvas.width` / `height` assignment resets context state.
		ctx.imageSmoothingEnabled = false;
		ctx.imageSmoothingQuality = 'low';
		// We size the buffer to device pixels and draw 1:1 with
		// the screen, so the CSS image-rendering keyword is
		// effectively a no-op — but explicitly setting `auto`
		// makes sure no stray `pixelated` from a previous
		// render mode lingers.
		canvasEl.style.imageRendering = 'auto';

		ctx.drawImage(offCanvas, 0, 0, W, H, 0, 0, bufW, bufH);
	}

	$effect(() => {
		// Reactive deps: residual contents, layout (canvas-aware), wrap footprint.
		G;
		m;
		n;
		p;
		layout;
		wrapCssW;
		wrapCssH;
		displayMetricsRev;
		untrack(() => renderHeatmap());
	});

	$effect(() => {
		if (!wrapEl) return;
		const syncWrap = () => {
			wrapCssW = wrapEl!.clientWidth;
			wrapCssH = wrapEl!.clientHeight;
		};
		syncWrap();
		const obs = new ResizeObserver(() => syncWrap());
		obs.observe(wrapEl);
		const onResize = () => {
			displayMetricsRev++;
			syncWrap();
		};
		window.addEventListener('resize', onResize);
		return () => {
			obs.disconnect();
			window.removeEventListener('resize', onResize);
		};
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
		const cellSpan = cellPx + innerGap;
		const t = Math.floor(xInMid / cellSpan);
		const s = Math.floor(yInMid / cellSpan);
		if (t >= p || s >= m) return null;
		const xInCell = xInMid - t * cellSpan;
		const yInCell = yInMid - s * cellSpan;
		if (xInCell >= cellPx || yInCell >= cellPx) return null; // inner gutter

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
		<span><span class="sw r-pos"></span> Γ &gt; 0 (bad)</span>
		<span><span class="sw r-neg"></span> Γ &lt; 0 (bad)</span>
		<br />
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
