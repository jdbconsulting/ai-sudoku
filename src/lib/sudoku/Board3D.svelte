<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import * as THREE from 'three';
	import type { Board, CellValue, GameState } from './state.svelte';
	import { formatGlyph } from './alphabets';

	type Props = { game: GameState };
	let { game }: Props = $props();

	// Per-region hues. The three matrices used to be drawn on three
	// separate canvases that each carried their own hue across the
	// header, slider tracks, frame, and tab. They're now rendered as
	// one combined page (B top-right, A bottom-left, C bottom-right)
	// so each hue is scoped to the cells & frame of its sub-grid only.
	const HUE_A = 230; // blue
	const HUE_B = 340; // pink
	const HUE_C = 45; // amber
	// Neutral hue for shared chrome (page background tint, tab, sliders).
	// Picked between A's blue and the slate page background so it reads
	// as "the page" rather than belonging to any one sub-grid.
	const HUE_NEUTRAL = 220;

	type RegionId = Board; // 'A' | 'B' | 'C'

	type Region = {
		id: RegionId;
		hue: number;
		// Top-left corner of the region in the combined-page grid (in
		// global row/col indices). Cells of the region occupy
		// rows [rowStart, rowStart+rows) × cols [colStart, colStart+cols).
		rowStart: number;
		colStart: number;
		rows: number;
		cols: number;
	};

	// === Per-board 3D layout knobs ==========================================
	// `tightGap` is the spacing between consecutive non-active pages.
	// `clearance` is the symmetric gap carved out in front of and behind
	// the active page, so the focused page is always isolated from its
	// neighbours regardless of how tight the rest of the stack is packed.
	const DEFAULT_TIGHT_GAP = 0.32;
	const DEFAULT_CLEARANCE = 5;
	let tightGap = $state(DEFAULT_TIGHT_GAP);
	let clearance = $state(DEFAULT_CLEARANCE);

	// === Zoom ===============================================================
	// User-controlled camera distance, written by the right-hand vertical
	// slider on the canvas. Range is 0–100 with 50 reproducing the
	// auto-fit distance computed by fitCameraToStack(); we map the slider
	// log-linearly so each 25-unit step doubles or halves the factor.
	// The slider is rendered with `direction: rtl` (see the .v-slider CSS
	// below) so the min end sits at the bottom and the fill grows upward
	// like a fuel gauge. We invert the slider→factor mapping accordingly,
	// so a higher slider value means a *smaller* camera-distance factor
	// (more zoomed in, biggest active page) — i.e. dragging the thumb up
	// zooms in, dragging down zooms out, and the colored fill represents
	// "how much zoom-in is dialled in".
	//   slider 0   → factor 4.00× (bottom; farthest, whole stack visible)
	//   slider 50  → factor 1.00× (default auto-fit)
	//   slider 100 → factor 0.25× (top; closest, biggest active page)
	let zoom = $state(50);

	function zoomFactor(z: number): number {
		return Math.pow(2, (50 - z) / 25);
	}

	function applyZoom() {
		if (!camera) return;
		camera.position.z = baseDist * zoomFactor(zoom);
		camera.updateProjectionMatrix();
	}

	// === Reactive views into game state =====================================

	let R = $derived(game.R);
	let m = $derived(game.m);
	let n = $derived(game.n);
	let p = $derived(game.p);

	// Combined-page layout. The three matrices are arranged as (with
	// `GAP_CELLS` blank cells of separation between neighbouring regions
	// so the sub-grids read as three distinct objects sharing one page):
	//
	//                ┌─ n cols ─┐  GAP  ┌─ p cols ─┐
	//                │          │       │          │
	//             n  │  empty   │       │    B     │
	//             rows          │       │ (n × p)  │
	//                └──────────┘       └──────────┘
	//                       GAP rows of vertical space
	//                ┌──────────┐       ┌──────────┐
	//             m  │    A     │       │    C     │
	//             rows (m × n)  │       │ (m × p)  │
	//                └──────────┘       └──────────┘
	//
	// This matches the screenshot in the design doc: B's columns line
	// up with C's columns (both p), and A's rows line up with C's rows
	// (both m). The empty top-left is n × n.
	const GAP_CELLS = 1;
	let totalRows = $derived(n + GAP_CELLS + m);
	let totalCols = $derived(n + GAP_CELLS + p);

	let regions = $derived<Region[]>([
		{ id: 'B', hue: HUE_B, rowStart: 0, colStart: n + GAP_CELLS, rows: n, cols: p },
		{ id: 'A', hue: HUE_A, rowStart: n + GAP_CELLS, colStart: 0, rows: m, cols: n },
		{
			id: 'C',
			hue: HUE_C,
			rowStart: n + GAP_CELLS,
			colStart: n + GAP_CELLS,
			rows: m,
			cols: p
		}
	]);

	let activePage = $derived(game.page);

	function setActive(r: number) {
		game.page = r;
	}

	// === Constants ==========================================================

	const SIZE = 360;
	const CELL_W = 1;
	const CELL_GAP = 0.06;
	const PAGE_PAD = 0.4;
	// Padding inside each region's sub-frame, between the frame border
	// and the outer cells of that region. Smaller than PAGE_PAD because
	// each region is already inset inside the overall page bounding box.
	const REGION_PAD = 0.22;
	const STEP = CELL_W + CELL_GAP;

	// === Three.js handles ===================================================

	let containerEl: HTMLDivElement;
	let canvasEl: HTMLCanvasElement;
	let renderer: THREE.WebGLRenderer | undefined;
	let scene: THREE.Scene | undefined;
	let camera: THREE.PerspectiveCamera | undefined;
	let stackGroup: THREE.Group | undefined;
	const raycaster = new THREE.Raycaster();
	const pointer = new THREE.Vector2();
	let frameId = 0;

	// Cell textures keyed by numeric value. With the original {−1, 0, +1}
	// alphabet this was just a `texPos` / `texNeg` pair, but the half-
	// integer and ±2 alphabets need their own "+½", "−½", "+2", "−2"
	// glyph textures too. We materialise each one lazily on first
	// reference and dispose the whole map on unmount. The empty (0)
	// value is intentionally NOT cached here — it renders as a tinted
	// material without a glyph texture and so doesn't need a canvas.
	const cellTextures: Map<number, THREE.CanvasTexture> = new Map();

	function getCellTexture(value: CellValue): THREE.CanvasTexture | undefined {
		if (value === 0) return undefined;
		const cached = cellTextures.get(value);
		if (cached) return cached;
		// Positive cells get the green glyph palette, negatives the red one.
		// Glyphs come from the alphabet helper so "+½" / "−2" line up with
		// every other place these numbers are printed (alphabet picker
		// label, residual tooltip, solution-file JSON).
		const positive = value > 0;
		const bg = positive ? '#4ade80' : '#ef4444';
		const fg = positive ? '#0c1226' : '#fff5f1';
		const glyph = formatGlyph(value);
		const tex = makeCellTexture(bg, glyph, fg);
		cellTextures.set(value, tex);
		return tex;
	}

	// Mesh registry. One entry per page; within each page we track the
	// shared chrome (background, tab) plus per-region frame & cell
	// meshes. Top-left empty quadrant has no meshes.
	type PageMeshes = {
		group: THREE.Group;
		bg: THREE.Mesh;
		tab: THREE.Mesh;
		regions: Record<RegionId, { frame: THREE.Mesh; cells: THREE.Mesh[][] }>;
	};
	let pages: PageMeshes[] = [];

	// Snapshot of dimensions used to build the current scene; we rebuild
	// when these change.
	let snapR = -1;
	let snapM = -1;
	let snapN = -1;
	let snapP = -1;

	// === Color helpers ======================================================
	function hueColor(L: number, C: number, h: number): THREE.Color {
		const s = Math.min(1, C * 4.2);
		return new THREE.Color().setHSL((((h % 360) + 360) % 360) / 360, s, L);
	}

	function makeCellTexture(bg: string, glyph: string, glyphColor: string): THREE.CanvasTexture {
		const c = document.createElement('canvas');
		c.width = c.height = 128;
		const ctx = c.getContext('2d')!;
		ctx.fillStyle = bg;
		ctx.fillRect(0, 0, 128, 128);
		if (glyph) {
			// Shrink the font for longer glyph strings ("−½", "+2") so
			// the full label still fits inside the cell quad. The
			// original ±1 glyphs were single characters so a fixed
			// 96px size was fine; the half-integer / ±2 alphabets push
			// us to 2-character labels that would otherwise spill out
			// of the texture's safe area.
			const fontPx = glyph.length <= 1 ? 96 : 72;
			ctx.font = `bold ${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
			ctx.fillStyle = glyphColor;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(glyph, 64, 70);
		}
		const tex = new THREE.CanvasTexture(c);
		tex.minFilter = THREE.LinearMipmapLinearFilter;
		tex.magFilter = THREE.LinearFilter;
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.anisotropy = 4;
		return tex;
	}

	function makeCellMaterial(value: CellValue): THREE.MeshBasicMaterial {
		// All cell materials start out as ACTIVE-style: fully opaque with
		// depthWrite=true so the active page's cells z-occlude the cells of
		// any inactive pages behind it. updateActiveStyles() flips inactive
		// pages to transparent/dim each frame the active changes.
		// DoubleSide on every cell means both front and back render with the
		// same texture (glyphs appear mirrored from behind, which is the
		// natural geometry) and the raycaster intersects either face — so
		// clicks land on cells regardless of which side faces the camera.
		if (value !== 0) {
			return new THREE.MeshBasicMaterial({
				color: 0xffffff,
				map: getCellTexture(value),
				transparent: false,
				opacity: 1,
				depthWrite: true,
				side: THREE.DoubleSide,
				toneMapped: false
			});
		}
		// Empty (unpicked) cells share a single yellow across all three
		// regions — a neutral "neither + nor −" state that contrasts
		// with the green/red glyph textures and is distinct from each
		// region's hue.  updateActiveStyles() still dims this on
		// inactive pages.
		return new THREE.MeshBasicMaterial({
			color: hueColor(0.55, 0.17, 60),
			transparent: false,
			opacity: 1,
			depthWrite: true,
			side: THREE.DoubleSide,
			toneMapped: false
		});
	}

	// Frame: a thin border (no opaque fill) that outlines a rectangle
	// of width × height centred on the origin so you can see where a
	// region lives in 3D without an overlay obscuring the cells.
	function makeFrameMesh(
		width: number,
		height: number,
		mat: THREE.MeshBasicMaterial
	): THREE.Mesh {
		const T = 0.05; // border thickness
		const outer = new THREE.Shape();
		outer.moveTo(-(width / 2 + T), -(height / 2 + T));
		outer.lineTo(width / 2 + T, -(height / 2 + T));
		outer.lineTo(width / 2 + T, height / 2 + T);
		outer.lineTo(-(width / 2 + T), height / 2 + T);
		outer.closePath();
		const hole = new THREE.Path();
		hole.moveTo(-width / 2, -height / 2);
		hole.lineTo(width / 2, -height / 2);
		hole.lineTo(width / 2, height / 2);
		hole.lineTo(-width / 2, height / 2);
		hole.closePath();
		outer.holes.push(hole);
		const geom = new THREE.ShapeGeometry(outer);
		return new THREE.Mesh(geom, mat);
	}

	function disposeMesh(mesh: THREE.Mesh) {
		mesh.geometry.dispose();
		const mat = mesh.material as THREE.Material | THREE.Material[];
		if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
		else mat.dispose();
	}

	function clearScene() {
		if (!stackGroup) return;
		stackGroup.traverse((obj) => {
			if (obj instanceof THREE.Mesh) disposeMesh(obj);
		});
		while (stackGroup.children.length > 0) {
			stackGroup.remove(stackGroup.children[0]);
		}
		pages = [];
		snapR = snapM = snapN = snapP = -1;
	}

	// Cell centre in the combined-page local coords. Row/col are global
	// indices into the (n+m) × (n+p) combined grid.
	function cellCentreX(col: number, totalColsLocal: number): number {
		return (col - (totalColsLocal - 1) / 2) * STEP;
	}
	function cellCentreY(row: number, totalRowsLocal: number): number {
		return -(row - (totalRowsLocal - 1) / 2) * STEP;
	}

	// === Page Z layout ======================================================
	// Pages are stacked in fixed order: page 0 closest to camera, page R-1
	// farthest. Active page is anchored at z=0 so the focused page is always
	// at the centre of the view; the front and back sets shift away in z.
	function pageZForActive(r: number, active: number, tightGap: number, clearance: number): number {
		if (r === active) return 0;
		if (r < active) {
			// In front of active. Distance in pages from active.
			const k = active - r; // 1..active
			return clearance + (k - 1) * tightGap;
		} else {
			const k = r - active; // 1..R-1-active
			return -(clearance + (k - 1) * tightGap);
		}
	}

	function relayoutPagesZ() {
		if (!pages.length) return;
		const ap = activePage;
		const tg = tightGap;
		const cl = clearance;
		for (let r = 0; r < pages.length; r++) {
			pages[r].group.position.z = pageZForActive(r, ap, tg, cl);
		}
	}

	function buildScene() {
		if (!stackGroup) return;
		clearScene();

		const Rv = R;
		const M = m;
		const N = n;
		const P = p;
		snapR = Rv;
		snapM = M;
		snapN = N;
		snapP = P;

		const TR = N + GAP_CELLS + M;
		const TC = N + GAP_CELLS + P;
		const pageW = TC * STEP + PAGE_PAD * 2;
		const pageH = TR * STEP + PAGE_PAD * 2;

		const localRegions: Region[] = [
			{ id: 'B', hue: HUE_B, rowStart: 0, colStart: N + GAP_CELLS, rows: N, cols: P },
			{ id: 'A', hue: HUE_A, rowStart: N + GAP_CELLS, colStart: 0, rows: M, cols: N },
			{
				id: 'C',
				hue: HUE_C,
				rowStart: N + GAP_CELLS,
				colStart: N + GAP_CELLS,
				rows: M,
				cols: P
			}
		];

		// L-shaped page-fill geometry. The combined board is laid out
		// with B in the top-right, A in the bottom-left, C in the
		// bottom-right and the top-left N × N quadrant intentionally
		// empty (it has no semantic meaning in the A·B = C product).
		// Earlier we used a full pageW × pageH PlaneGeometry here,
		// which painted a faint 6%-opacity bg into that empty
		// quadrant for every inactive page in the stack — visible on
		// screen as "lightly opaque squares" piling up in the
		// top-left corner. Cutting the empty quadrant out of the
		// fill leaves it cleanly void on every page.
		//
		// `cutX` / `cutY` mark the inside-corner of the L (in page-
		// local centred coords). They sit at the right edge of cell
		// column N-1 and the bottom edge of cell row N-1 respectively
		// — i.e. flush with the rightmost / bottommost cell of the
		// empty quadrant, so the GAP cells separating the empty
		// quadrant from B (vertical strip at col N) and A (horizontal
		// strip at row N) keep their bg fill and the page still reads
		// as one connected surface.
		const cutX = (N - 1 - (TC - 1) / 2) * STEP + CELL_W / 2;
		const cutY = -((N - 1 - (TR - 1) / 2) * STEP) - CELL_W / 2;
		const left = -pageW / 2;
		const right = pageW / 2;
		const top = pageH / 2;
		const bottom = -pageH / 2;
		const bgShape = new THREE.Shape();
		// CCW winding so ShapeGeometry's triangulation faces +z; with
		// THREE.DoubleSide on the material it doesn't really matter,
		// but keeping the convention right avoids surprises if anyone
		// later switches to single-sided.
		bgShape.moveTo(left, cutY);
		bgShape.lineTo(left, bottom);
		bgShape.lineTo(right, bottom);
		bgShape.lineTo(right, top);
		bgShape.lineTo(cutX, top);
		bgShape.lineTo(cutX, cutY);
		bgShape.lineTo(left, cutY);

		for (let r = 0; r < Rv; r++) {
			const pg = new THREE.Group();
			pg.position.z = pageZForActive(r, activePage, tightGap, clearance);

			// Very faint page fill — defines the combined page as one
			// coherent surface (B, A, C frames + the gap strips
			// between them) so the three sub-regions don't read as
			// disjoint rectangles floating in space. Opacity stays
			// low enough that even a front-side inactive page can't
			// occlude the active. See the L-shape comment above for
			// why this isn't a plain rectangle.
			const bgGeom = new THREE.ShapeGeometry(bgShape);
			const bgMat = new THREE.MeshBasicMaterial({
				color: hueColor(0.18, 0.06, HUE_NEUTRAL),
				transparent: true,
				opacity: 0.0,
				depthWrite: false,
				side: THREE.DoubleSide,
				toneMapped: false
			});
			const bg = new THREE.Mesh(bgGeom, bgMat);
			bg.position.z = -0.02;
			bg.userData = { type: 'bg', pageIndex: r };
			pg.add(bg);

			// One sub-frame and one grid of cells per matrix region.
			const regionMeshes = {} as PageMeshes['regions'];
			for (const region of localRegions) {
				const subW = (region.cols - 1) * STEP + CELL_W + REGION_PAD * 2;
				const subH = (region.rows - 1) * STEP + CELL_W + REGION_PAD * 2;
				const subCx =
					(((region.colStart + (region.cols - 1) / 2) - (TC - 1) / 2)) * STEP;
				const subCy =
					-(((region.rowStart + (region.rows - 1) / 2) - (TR - 1) / 2)) * STEP;

				const frameMat = new THREE.MeshBasicMaterial({
					color: hueColor(0.5, 0.12, region.hue),
					transparent: true,
					opacity: 0.6,
					depthWrite: false,
					side: THREE.DoubleSide,
					toneMapped: false
				});
				const frame = makeFrameMesh(subW, subH, frameMat);
				frame.position.set(subCx, subCy, -0.01);
				frame.userData = { type: 'frame', pageIndex: r, region: region.id };
				pg.add(frame);

				const cells: THREE.Mesh[][] = [];
				for (let row = 0; row < region.rows; row++) {
					const rowMeshes: THREE.Mesh[] = [];
					for (let col = 0; col < region.cols; col++) {
						const value = game.getCell(region.id, r, row, col);
						const geom = new THREE.PlaneGeometry(CELL_W, CELL_W);
						const mat = makeCellMaterial(value);
						const mesh = new THREE.Mesh(geom, mat);
						const gRow = region.rowStart + row;
						const gCol = region.colStart + col;
						mesh.position.x = cellCentreX(gCol, TC);
						mesh.position.y = cellCentreY(gRow, TR);
						mesh.position.z = 0;
						mesh.userData = {
							type: 'cell',
							pageIndex: r,
							region: region.id,
							row,
							col
						};
						pg.add(mesh);
						rowMeshes.push(mesh);
					}
					cells.push(rowMeshes);
				}
				regionMeshes[region.id] = { frame, cells };
			}

			// Tab — small bevelled box at the bottom-right corner of the
			// combined page. The variable page spacing already separates
			// tabs visually in screen space when the active page shifts.
			const tabGeom = new THREE.BoxGeometry(0.55, 0.55, 0.18);
			const tabMat = new THREE.MeshBasicMaterial({
				color: hueColor(0.4, 0.12, HUE_NEUTRAL),
				transparent: true,
				opacity: 0.95,
				depthWrite: false,
				toneMapped: false
			});
			const tab = new THREE.Mesh(tabGeom, tabMat);
			tab.position.x = pageW / 2 + 0.45;
			tab.position.y = -pageH / 2 + 0.45;
			tab.position.z = 0.1;
			tab.userData = { type: 'tab', pageIndex: r };
			pg.add(tab);

			stackGroup.add(pg);
			pages.push({ group: pg, bg, tab, regions: regionMeshes });
		}

		fitCameraToStack(pageW, pageH, Rv);
		updateActiveStyles();
	}

	let baseDist = 18;
	let cachedPageW = 1;
	let cachedPageH = 1;

	// Fraction of the viewport the active page should occupy when viewed
	// straight on (zero rotation). The default isometric tilt projects the
	// page slightly smaller than this footprint, leaving a comfortable
	// margin around the edges.
	const PAGE_FILL = 0.9;
	// Asymmetric padding to the right of the page where the tab box lives
	// (`tab.position.x = pageW / 2 + 0.45`, half-width 0.275). We bake it
	// into the effective width so the tab never falls off canvas.
	const TAB_EXTRA_W = 1.5;

	function fitCameraToStack(pageW: number, pageH: number, Rv: number) {
		if (!camera) return;
		cachedPageW = pageW;
		cachedPageH = pageH;

		// Worst-case stack depth — only used to extend the far-clip plane so
		// back pages aren't culled. It does NOT drive the camera fit: R =
		// m·n·p grows as O(N³) for ⟨N,N,N⟩, and including depth in the fit
		// would shrink each cell on the active page to the third power of
		// the board size.
		const tg = tightGap;
		const cl = clearance;
		const interiorTight = Math.max(0, Rv - 3) * tg;
		const stackD = Rv <= 1 ? 0 : Rv === 2 ? cl : interiorTight + cl * 2;

		// Solve for the camera distance that fits both the page width and
		// height inside `PAGE_FILL` of the viewport when viewed straight on.
		// The tallest dimension wins, so non-square boards (m ≠ n, etc.)
		// never spill off canvas — the other axis just gets extra margin.
		const effW = pageW + TAB_EXTRA_W;
		const effH = pageH;
		const fovHalf = (camera.fov * Math.PI) / 360;
		const tanFovHalf = Math.tan(fovHalf);
		const aspect = camera.aspect || 1;
		const dForH = effH / (2 * PAGE_FILL * tanFovHalf);
		const dForW = effW / (2 * PAGE_FILL * tanFovHalf * aspect);
		const d = Math.max(dForH, dForW);

		baseDist = d;
		camera.near = 0.1;
		// Far plane is sized for the worst-case zoom-out (factor 4×) at
		// the back-most page, so the renderer never culls a page even
		// when the user drags the zoom slider all the way down.
		camera.far = d * 4 + stackD * 2 + 30;
		camera.position.x = 0;
		camera.position.y = 0;
		applyZoom();
	}

	function refreshAllCells() {
		if (!pages.length || pages.length !== snapR) return;
		for (let r = 0; r < pages.length; r++) {
			for (const region of regions) {
				const grid = pages[r].regions[region.id];
				if (!grid) continue;
				for (let row = 0; row < grid.cells.length; row++) {
					for (let col = 0; col < grid.cells[row].length; col++) {
						const mesh = grid.cells[row][col];
						const value = game.getCell(region.id, r, row, col);
						(mesh.material as THREE.MeshBasicMaterial).dispose();
						mesh.material = makeCellMaterial(value);
					}
				}
			}
		}
		updateActiveStyles();
	}

	function updateActiveStyles() {
		if (!pages.length) return;
		const ap = activePage;
		for (let r = 0; r < pages.length; r++) {
			const isActive = r === ap;
			// Active page: cells are opaque + depthWrite true, so they
			// punch a clean hole through the back of the stack — back-side
			// inactive pages don't bleed through. Inactive pages: cells
			// rendered as transparent + depthWrite false at "slightly
			// dimmer" 0.4 opacity, so they're clearly visible context.
			// The big gap around the active page guarantees inactive pages
			// don't visually crowd the active one.
			const cellOp = isActive ? 1.0 : 0.4;
			const frameOp = isActive ? 1.0 : 0.55;
			const bgOp = isActive ? 0.0 : 0.06;

			(pages[r].bg.material as THREE.MeshBasicMaterial).opacity = bgOp;

			for (const region of regions) {
				const grid = pages[r].regions[region.id];
				if (!grid) continue;
				const frameMat = grid.frame.material as THREE.MeshBasicMaterial;
				frameMat.opacity = frameOp;
				frameMat.color.copy(
					isActive ? hueColor(0.85, 0.18, region.hue) : hueColor(0.55, 0.12, region.hue)
				);
				for (let row = 0; row < grid.cells.length; row++) {
					for (let col = 0; col < grid.cells[row].length; col++) {
						const mat = grid.cells[row][col].material as THREE.MeshBasicMaterial;
						mat.opacity = cellOp;
						mat.transparent = !isActive;
						mat.depthWrite = isActive;
						mat.needsUpdate = true;
					}
				}
			}

			const tabMat = pages[r].tab.material as THREE.MeshBasicMaterial;
			tabMat.opacity = isActive ? 1.0 : 0.8;
			tabMat.color.copy(
				isActive ? hueColor(0.85, 0.18, HUE_NEUTRAL) : hueColor(0.4, 0.12, HUE_NEUTRAL)
			);
			pages[r].tab.scale.setScalar(isActive ? 1.25 : 0.85);
		}
	}

	// === Picking ============================================================
	// Tabs are the ONLY way to switch pages from the 3D view. The active
	// page's cells are pickable for cycling values. Frames and inactive
	// cells are intentionally not pickable so a misclick on a neighbouring
	// page never steals focus from the active one.
	function getCellInteractables(): THREE.Object3D[] {
		const ap = activePage;
		const arr: THREE.Object3D[] = [];
		const page = pages[ap];
		if (!page) return arr;
		for (const region of regions) {
			const grid = page.regions[region.id];
			if (!grid) continue;
			for (const row of grid.cells) for (const cell of row) arr.push(cell);
		}
		return arr;
	}

	function getAllInteractables(): THREE.Object3D[] {
		const arr: THREE.Object3D[] = [];
		// Tabs always pickable.
		for (const p of pages) arr.push(p.tab);
		// Cells of the active page only.
		for (const cell of getCellInteractables()) arr.push(cell);
		return arr;
	}

	function setPointerFromEvent(event: MouseEvent) {
		const rect = canvasEl.getBoundingClientRect();
		pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
		pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
	}

	function pickAt(event: MouseEvent, objs: THREE.Object3D[]): THREE.Intersection | null {
		if (!camera) return null;
		setPointerFromEvent(event);
		raycaster.setFromCamera(pointer, camera);
		const hits = raycaster.intersectObjects(objs, false);
		return hits.length ? hits[0] : null;
	}

	// Click action — picks tabs or cells on the active page. Called from
	// `onPointerUp` when the left button was released without enough motion
	// to count as a rotation drag.
	function handleClick(event: PointerEvent) {
		const hit = pickAt(event, getAllInteractables());
		if (!hit) return;
		const data = hit.object.userData as {
			type: string;
			pageIndex: number;
			region?: RegionId;
			row?: number;
			col?: number;
		};
		if (data.type === 'tab') {
			setActive(data.pageIndex);
		} else if (data.type === 'cell' && data.region) {
			const dir = event.shiftKey ? -1 : 1;
			game.cycle(data.region, data.pageIndex, data.row!, data.col!, dir);
		}
	}

	function resetCellAt(event: MouseEvent) {
		// Right-click reset only ever targets cells on the active page.
		const hit = pickAt(event, getCellInteractables());
		if (!hit) return;
		const data = hit.object.userData as {
			type: string;
			pageIndex: number;
			region?: RegionId;
			row?: number;
			col?: number;
		};
		if (data.type === 'cell' && data.region) {
			game.setCell(data.region, data.pageIndex, data.row!, data.col!, 0);
		}
	}

	// === Rotation drag + momentum ===========================================
	// The default orientation is a deeper isometric tilt than the previous
	// 30°/30°: the top of each page leans 40° toward the camera and a
	// complementary 40° yaw reveals the depth of the rank-page stack. The
	// steeper angle makes the inter-page Z spacing read more strongly at
	// the default view so it's obvious there's a stack to thumb through.
	//
	// Rotation is permanently constrained to the world X-Y plane (orbit-
	// camera semantics, no roll). Drag input feeds two angles — pitch
	// around world X, yaw around world Y — and userQuat is rebuilt from
	// `Euler(pitch, yaw, 0, 'XYZ')` every frame the orientation is
	// touched. The rotation axis therefore always lies in the world X-Y
	// plane and the stack never picks up Z-axis roll: horizontal drag
	// spins the stack like a turntable, vertical drag tips it forward/
	// back, but the stack's "up" never tilts left/right relative to the
	// camera's up.
	//
	// Pitch is intentionally NOT clamped — the user can somersault the
	// stack past ±90° to see its back face. The Euler XYZ gimbal
	// singularity at pitch = ±π/2 (body-Y aligns with world Z, so a
	// horizontal drag right then reads mathematically as a roll of the
	// camera view) is acceptable because the user drags through that
	// single pitch value in a few frames; the visual quirk disappears
	// the moment pitch leaves ±π/2.
	const DEFAULT_TILT_RAD = (40 * Math.PI) / 180;
	let lockedPitch = $state(DEFAULT_TILT_RAD);
	let lockedYaw = $state(-DEFAULT_TILT_RAD);
	const _eulerHelper = new THREE.Euler(0, 0, 0, 'XYZ');
	// userQuat is mutated in place by applyLockedRotation (called from the
	// drag handler and the momentum integrator) and then read by `animate`
	// to drive `stackGroup.quaternion`. It is intentionally NOT a $state —
	// the reactive driver for the reset button is `rotationAtDefault`
	// below, which we flip whenever the orientation diverges from the
	// default.
	const userQuat = new THREE.Quaternion().setFromEuler(
		_eulerHelper.set(DEFAULT_TILT_RAD, -DEFAULT_TILT_RAD, 0, 'XYZ')
	);
	let rotationAtDefault = $state(true);

	function applyLockedRotation() {
		_eulerHelper.set(lockedPitch, lockedYaw, 0, 'XYZ');
		userQuat.setFromEuler(_eulerHelper);
	}

	// Angular velocity in (pitchRate, yawRate, 0) form (rad/sec). Set by
	// `commitMomentum` from the smoothed pointer-pixel velocity at release
	// and integrated into lockedPitch / lockedYaw each frame so a flick
	// coasts smoothly to a stop.
	const angVel = new THREE.Vector3();

	let dragging = false;
	let dragStart = { x: 0, y: 0 };
	let dragLast = { x: 0, y: 0 };
	let dragMoved = 0;
	const DRAG_THRESHOLD_PX = 5;
	const ROT_SENSITIVITY = 0.008;

	let velPxX = 0;
	let velPxY = 0;
	let lastMoveT = 0;
	const VEL_SMOOTH = 0.35;
	const RELEASE_GRACE_MS = 90;

	export function resetView() {
		lockedPitch = DEFAULT_TILT_RAD;
		lockedYaw = -DEFAULT_TILT_RAD;
		applyLockedRotation();
		angVel.set(0, 0, 0);
		rotationAtDefault = true;
		zoom = 50;
		tightGap = DEFAULT_TIGHT_GAP;
		clearance = DEFAULT_CLEARANCE;
	}

	let wheelAccum = 0;
	const WHEEL_STEP_THRESHOLD = 40;

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		if (!R) return;
		wheelAccum += event.deltaY;
		if (Math.abs(wheelAccum) < WHEEL_STEP_THRESHOLD) return;
		// Wheel direction is mapped to the *visual* motion of the
		// page-slider thumb: scrolling up moves the thumb up (toward
		// higher page indices, since the slider is rendered bottom-up
		// with `direction: rtl`), and scrolling down moves it down.
		// Browsers report a downward scroll as `deltaY > 0`, so a
		// positive accumulator corresponds to "page index decreases".
		const dir = wheelAccum > 0 ? -1 : 1;
		wheelAccum = 0;
		const next = Math.max(0, Math.min(R - 1, activePage + dir));
		if (next !== activePage) setActive(next);
	}

	function trackVelocity(dx: number, dy: number) {
		const now = performance.now();
		const dt = Math.max(1, now - lastMoveT);
		const instX = dx / dt;
		const instY = dy / dt;
		velPxX = velPxX * (1 - VEL_SMOOTH) + instX * VEL_SMOOTH;
		velPxY = velPxY * (1 - VEL_SMOOTH) + instY * VEL_SMOOTH;
		lastMoveT = now;
	}

	function commitMomentum() {
		const now = performance.now();
		const idle = now - lastMoveT;
		if (idle > RELEASE_GRACE_MS) {
			angVel.set(0, 0, 0);
			return;
		}
		angVel.set(velPxY * 1000 * ROT_SENSITIVITY, velPxX * 1000 * ROT_SENSITIVITY, 0);
	}

	function onPointerDown(event: PointerEvent) {
		if (event.button !== 0) return;
		dragging = true;
		dragStart = { x: event.clientX, y: event.clientY };
		dragLast = { x: event.clientX, y: event.clientY };
		dragMoved = 0;
		angVel.set(0, 0, 0);
		velPxX = velPxY = 0;
		lastMoveT = performance.now();
		canvasEl.setPointerCapture(event.pointerId);
	}

	function onPointerMove(event: PointerEvent) {
		if (dragging) {
			const dx = event.clientX - dragLast.x;
			const dy = event.clientY - dragLast.y;
			dragLast = { x: event.clientX, y: event.clientY };
			dragMoved +=
				Math.abs(event.clientX - dragStart.x) + Math.abs(event.clientY - dragStart.y);
			if (dragMoved > DRAG_THRESHOLD_PX) {
				if (dx !== 0 || dy !== 0) {
					lockedYaw += dx * ROT_SENSITIVITY;
					lockedPitch += dy * ROT_SENSITIVITY;
					applyLockedRotation();
					rotationAtDefault = false;
				}
				canvasEl.style.cursor = 'grabbing';
				trackVelocity(dx, dy);
			}
			return;
		}
		if (!camera) return;
		setPointerFromEvent(event);
		raycaster.setFromCamera(pointer, camera);
		const hits = raycaster.intersectObjects(getAllInteractables(), false);
		canvasEl.style.cursor = hits.length ? 'pointer' : 'grab';
	}

	function onPointerUp(event: PointerEvent) {
		if (event.button !== 0 || !dragging) return;
		dragging = false;
		canvasEl.releasePointerCapture(event.pointerId);
		if (dragMoved <= DRAG_THRESHOLD_PX) {
			handleClick(event);
			angVel.set(0, 0, 0);
		} else {
			commitMomentum();
		}
		canvasEl.style.cursor = 'grab';
	}

	function onPointerCancel() {
		dragging = false;
		angVel.set(0, 0, 0);
	}

	function onContextMenu(event: MouseEvent) {
		event.preventDefault();
		resetCellAt(event);
	}

	// === Animation ==========================================================
	let lastFrameT = typeof performance !== 'undefined' ? performance.now() : 0;
	function animate() {
		const now = performance.now();
		const dt = Math.min(0.06, (now - lastFrameT) / 1000);
		lastFrameT = now;

		if (angVel.x !== 0 || angVel.y !== 0) {
			lockedPitch += angVel.x * dt;
			lockedYaw += angVel.y * dt;
			applyLockedRotation();
			if (rotationAtDefault) rotationAtDefault = false;
		}

		if (stackGroup) {
			stackGroup.quaternion.copy(userQuat);
		}
		if (renderer && scene && camera) renderer.render(scene, camera);
		frameId = requestAnimationFrame(animate);
	}

	// === Lifecycle ==========================================================
	let resizeObs: ResizeObserver | undefined;
	onMount(() => {
		renderer = new THREE.WebGLRenderer({
			canvas: canvasEl,
			antialias: true,
			alpha: true,
			premultipliedAlpha: false
		});
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.outputColorSpace = THREE.SRGBColorSpace;

		scene = new THREE.Scene();
		stackGroup = new THREE.Group();
		scene.add(stackGroup);

		camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
		camera.position.set(0, 0, 18);
		camera.lookAt(0, 0, 0);

		// Cell textures are materialised lazily by `getCellTexture()` as
		// the scene encounters non-zero values; nothing to pre-warm here.

		resize();
		buildScene();
		lastFrameT = performance.now();
		animate();

		window.addEventListener('resize', resize);
		resizeObs = new ResizeObserver(() => resize());
		resizeObs.observe(containerEl);
	});

	function resize() {
		if (!renderer || !camera || !canvasEl || !containerEl) return;
		const w = containerEl.clientWidth || SIZE;
		const h = containerEl.clientHeight || SIZE;
		if (w === 0 || h === 0) return;
		renderer.setSize(w, h, false);
		canvasEl.style.width = w + 'px';
		canvasEl.style.height = h + 'px';
		camera.aspect = w / h;
		fitCameraToStack(cachedPageW, cachedPageH, R);
	}

	onDestroy(() => {
		cancelAnimationFrame(frameId);
		window.removeEventListener('resize', resize);
		resizeObs?.disconnect();
		clearScene();
		for (const tex of cellTextures.values()) tex.dispose();
		cellTextures.clear();
		if (renderer) renderer.dispose();
	});

	// === Reactivity =========================================================
	$effect(() => {
		const r = R;
		const M = m;
		const N = n;
		const P = p;
		if (!stackGroup) return;
		if (r !== snapR || M !== snapM || N !== snapN || P !== snapP) {
			untrack(() => buildScene());
		}
	});

	$effect(() => {
		game.version;
		untrack(() => refreshAllCells());
	});

	$effect(() => {
		const _ap = activePage;
		untrack(() => {
			relayoutPagesZ();
			updateActiveStyles();
		});
	});

	$effect(() => {
		tightGap;
		clearance;
		untrack(() => {
			relayoutPagesZ();
			fitCameraToStack(cachedPageW, cachedPageH, R);
		});
	});

	$effect(() => {
		zoom;
		untrack(() => applyZoom());
	});
</script>

<div class="board-wrap" style:--hue={HUE_NEUTRAL}>
	<!-- Horizontal page-spacing slider. Drag right to spread consecutive
	     pages further apart along the camera axis; drag left to compact
	     them. Width matches the canvas so the control reads as belonging
	     to the board. -->
	<label class="h-slider-row">
		<input
			type="range"
			class="h-slider"
			min="0.04"
			max="1.4"
			step="0.01"
			bind:value={tightGap}
			aria-label="Page spacing"
			title="Page spacing — drag right to spread consecutive pages further apart, left to pack them tighter"
		/>
	</label>
	<div class="canvas-row">
		<!-- Vertical page picker. The slider is rendered bottom-up
		     (see `.v-slider { direction: rtl }`): bottom of the
		     slider = page 0 (closest to the camera), top of the
		     slider = page R-1 (farthest). The colored fill grows
		     from the bottom up, representing how deep into the
		     stack you've advanced. Tied one-way to activePage so
		     external page changes (tab clicks, wheel, page-spacing
		     slider edits) keep it in sync. -->
		<input
			type="range"
			class="v-slider page-slider"
			min="0"
			max={Math.max(0, R - 1)}
			step="1"
			value={activePage}
			oninput={(e) => setActive(Number((e.currentTarget as HTMLInputElement).value))}
			aria-label="Active page"
			aria-valuetext={`Page ${activePage + 1} of ${R}`}
			title={`Active page ${activePage + 1} of ${R}`}
		/>
		<div class="canvas-container" bind:this={containerEl}>
			<canvas
				bind:this={canvasEl}
				oncontextmenu={onContextMenu}
				onpointerdown={onPointerDown}
				onpointermove={onPointerMove}
				onpointerup={onPointerUp}
				onpointercancel={onPointerCancel}
				onwheel={onWheel}
				onpointerleave={() => {
					canvasEl.style.cursor = 'default';
				}}
				aria-label={`Combined A/B/C board, 3D rank-page stack. Active page ${activePage + 1} of ${R}.`}
			></canvas>
			{#if !rotationAtDefault || zoom !== 50 || tightGap !== DEFAULT_TIGHT_GAP || clearance !== DEFAULT_CLEARANCE}
				<button
					type="button"
					class="reset-view"
					onclick={resetView}
					title="Reset view orientation"
				>
					⟲ Reset view
				</button>
			{/if}
			<!-- Always-visible badge in the bottom-left of the canvas
			     showing which page (rank-1 outer-product layer) is
			     currently active. Pure read-out — page selection
			     happens via the vertical slider, mouse wheel, etc. -->
			{#if R > 0}
				<div
					class="page-indicator"
					aria-hidden="true"
					title={`Active page ${activePage + 1} of ${R}`}
				>
					{activePage + 1} / {R}
				</div>
			{/if}
		</div>
		<!-- Vertical zoom slider. Same bottom-up fill direction as
		     the page picker: bottom = slider value 0 = factor 4×
		     (zoomed out, all pages visible); middle = factor 1×
		     (auto-fit, the default); top = slider value 100 =
		     factor 0.25× (zoomed in, biggest active page). The
		     colored fill represents "how much zoom-in is dialled
		     in", growing upward from the bottom as you drag the
		     thumb up to magnify. -->
		<input
			type="range"
			class="v-slider zoom-slider"
			min="0"
			max="100"
			step="1"
			value={zoom}
			oninput={(e) => (zoom = Number((e.currentTarget as HTMLInputElement).value))}
			aria-label="Zoom"
			aria-valuetext={`${(zoomFactor(zoom) * 100).toFixed(0)}% of auto-fit distance`}
			title={`Zoom (${zoomFactor(zoom).toFixed(2)}×; drag up to zoom in, down to zoom out)`}
		/>
	</div>
	<!-- Horizontal active-page-clearance slider. Drag right to widen
	     the symmetric gap carved out in front of and behind the active
	     page (so it stays visible even when the consecutive-page
	     spacing is packed tight); drag left to close the gap. -->
	<label class="h-slider-row">
		<input
			type="range"
			class="h-slider"
			min="0.2"
			max="10"
			step="0.05"
			bind:value={clearance}
			aria-label="Active page clearance"
			title="Active-page clearance — symmetric gap carved out in front of and behind the active page"
		/>
	</label>
</div>

<style>
	.board-wrap {
		/* Fill the parent panel (Game.svelte's .boards.panel) so the
		   canvas + slider rails stretch out edge-to-edge instead of
		   shrinking to their content's intrinsic width. */
		width: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
	}
	.canvas-row {
		--hue: 220;
		display: flex;
		align-items: stretch;
		gap: 0.45rem;
		width: 100%;
		justify-content: center;
	}
	.v-slider {
		display: block;
		margin: 0;
		padding: 0;
		width: 28px;
		align-self: stretch;
		height: auto;
		/* Standards-track vertical orientation. With the default
		   `direction: ltr` this would put the slider's min at the
		   top and max at the bottom, so the colored "accent-color"
		   fill would grow from the top down — visually weird,
		   since it reads as the slider being "drained from the
		   top". `direction: rtl` reverses the inline axis so min
		   sits at the bottom and max at the top, and the fill now
		   grows from the bottom up like a fuel gauge or
		   thermometer. The page-slider's value mapping (page 0 at
		   bottom, page R-1 at top) and the inverted zoomFactor()
		   together keep the on-screen meaning intuitive — "more
		   fill = further into the stack" on the page slider, and
		   "more fill = more zoomed in" on the zoom slider. */
		writing-mode: vertical-lr;
		direction: rtl;
		accent-color: oklch(0.7 0.18 var(--hue));
		touch-action: none;
		cursor: ns-resize;
		background: transparent;
	}
	.v-slider:focus-visible {
		outline: 2px solid oklch(0.7 0.18 var(--hue));
		outline-offset: 2px;
		border-radius: 4px;
	}

	.h-slider-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		/* The 28px (v-slider width) + 0.45rem (canvas-row gap) on
		   each side aligns the horizontal slider rail with the
		   canvas's left/right edges (the v-sliders sit outside it
		   in .canvas-row). No max-width — the rail tracks the
		   canvas, which is now governed by the parent panel. */
		width: calc(100% - 2 * (28px + 0.45rem));
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.7rem;
		color: rgb(148 163 184);
	}
	.h-slider {
		flex: 1 1 auto;
		min-width: 0;
		accent-color: oklch(0.7 0.18 var(--hue));
		cursor: ew-resize;
		touch-action: pan-y;
	}
	.h-slider:focus-visible {
		outline: 2px solid oklch(0.7 0.18 var(--hue));
		outline-offset: 2px;
		border-radius: 4px;
	}
	.canvas-container {
		/* Fill whatever width the parent .board-wrap (in turn
		   governed by Game.svelte's .boards.panel) gives us — the
		   panel is 1/2 page wide and itself capped by the page's
		   max-width, so a hard cap here would just leave dead
		   space inside the panel on wide viewports. */
		width: 100%;
		min-width: 240px;
		aspect-ratio: 1 / 1;
		border-radius: 14px;
		background: radial-gradient(
			ellipse at center,
			oklch(0.16 0.06 var(--hue) / 0.45),
			transparent 75%
		);
		border: 1px solid oklch(0.4 0.07 var(--hue) / 0.55);
		box-shadow:
			0 0 0 1px oklch(0.18 0.03 240 / 0.8) inset,
			0 8px 28px oklch(0.06 0.03 240 / 0.45),
			0 0 22px oklch(0.55 0.14 var(--hue) / 0.18);
		position: relative;
	}
	canvas {
		display: block;
		cursor: grab;
		touch-action: none;
	}
	.reset-view {
		position: absolute;
		top: 8px;
		right: 8px;
		padding: 0.3rem 0.55rem;
		font-size: 0.72rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: oklch(0.18 0.03 240 / 0.85);
		color: rgb(226 232 240);
		border: 1px solid oklch(0.4 0.06 var(--hue) / 0.6);
		border-radius: 6px;
		cursor: pointer;
		backdrop-filter: blur(4px);
	}
	.reset-view:hover {
		background: oklch(0.28 0.05 var(--hue) / 0.9);
		border-color: oklch(0.6 0.14 var(--hue));
	}
	.page-indicator {
		position: absolute;
		bottom: 8px;
		left: 8px;
		padding: 0.3rem 0.55rem;
		font-size: 0.72rem;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-variant-numeric: tabular-nums;
		background: oklch(0.18 0.03 240 / 0.85);
		color: rgb(226 232 240);
		border: 1px solid oklch(0.4 0.06 var(--hue) / 0.6);
		border-radius: 6px;
		backdrop-filter: blur(4px);
		pointer-events: none;
		user-select: none;
	}

	@media (max-width: 540px) {
		.canvas-container {
			min-width: 0;
			overflow: hidden;
		}
		canvas {
			max-width: 100%;
			height: auto;
		}
	}
</style>
