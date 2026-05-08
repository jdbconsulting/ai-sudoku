<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import * as THREE from 'three';
	import type { Board, CellValue, GameState } from './state.svelte';

	type Props = { game: GameState; board: Board; title: string; hue: number };
	let { game, board, title, hue }: Props = $props();

	// Static board roster used by the mobile-only navigation row in the
	// header. Hues mirror the per-board hue prop Game.svelte sets when
	// rendering each Board3D (A=230 blue, B=340 pink, C=45 amber); if
	// those ever change, update this list to match.
	const NAV_BOARDS: { board: Board; title: string; hue: number }[] = [
		{ board: 'A', title: 'A', hue: 230 },
		{ board: 'B', title: 'B', hue: 340 },
		{ board: 'C', title: 'C', hue: 45 }
	];

	function scrollToBoard(e: Event, target: Board) {
		// Smooth-scroll to the sibling Board3D's wrap. preventDefault on
		// the anchor click so the browser doesn't append a `#board-X`
		// fragment to the URL or break smooth-scroll into a hard jump.
		e.preventDefault();
		const el = document.getElementById(`board-${target}`);
		el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}

	// === Per-board 3D layout knobs ==========================================
	// `tightGap` is the spacing between consecutive non-active pages.
	// `clearance` is the symmetric gap carved out in front of and behind
	// the active page, so the focused page is always isolated from its
	// neighbours regardless of how tight the rest of the stack is packed.
	// These used to be shared across all three boards via GameState; they
	// now live per-Board3D so each board's stack can be tuned alone via
	// the horizontal sliders above and below its canvas.
	const DEFAULT_TIGHT_GAP = 0.32;
	const DEFAULT_CLEARANCE = 5;
	let tightGap = $state(DEFAULT_TIGHT_GAP);
	let clearance = $state(DEFAULT_CLEARANCE);

	// === Zoom ===============================================================
	// User-controlled camera distance, written by the right-hand vertical
	// slider on each board. Range is 0–100 with 50 reproducing the
	// auto-fit distance computed by fitCameraToStack(); we map the slider
	// log-linearly so each 25-unit step doubles or halves the factor.
	//   slider 0   → factor 0.25× (closest, biggest active page)
	//   slider 50  → factor 1.00× (default auto-fit)
	//   slider 100 → factor 4.00× (farthest, whole stack visible)
	let zoom = $state(50);

	function zoomFactor(z: number): number {
		return Math.pow(2, (z - 50) / 25);
	}

	function applyZoom() {
		if (!camera) return;
		camera.position.z = baseDist * zoomFactor(zoom);
		camera.updateProjectionMatrix();
	}

	// === Reactive views into game state =====================================

	let R = $derived(game.R);
	let rows = $derived(board === 'A' ? game.m : board === 'B' ? game.n : game.m);
	let cols = $derived(board === 'A' ? game.n : board === 'B' ? game.p : game.p);
	let activePage = $derived(
		board === 'A' ? game.pageA : board === 'B' ? game.pageB : game.pageC
	);

	function setActive(r: number) {
		if (board === 'A') game.pageA = r;
		else if (board === 'B') game.pageB = r;
		else game.pageC = r;
	}

	// === Constants ==========================================================

	const SIZE = 360;
	const CELL_W = 1;
	const CELL_GAP = 0.06;
	const PAGE_PAD = 0.4;

	// Inter-page Z spacing: the active page is always split out with a
	// `clearance` gap on both sides so it stays visible even when the
	// consecutive page spacing (`tightGap`) is packed very tight.


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

	let texPos: THREE.CanvasTexture | undefined;
	let texNeg: THREE.CanvasTexture | undefined;

	// Mesh registry
	let pageGroups: THREE.Group[] = [];
	let pageFrames: THREE.Mesh[] = [];
	let pageBgs: THREE.Mesh[] = [];
	let cellMeshes: THREE.Mesh[][][] = [];
	let tabMeshes: THREE.Mesh[] = [];

	// Snapshot of dimensions used to build the current scene; we rebuild when
	// these change.
	let snapR = -1;
	let snapRows = -1;
	let snapCols = -1;

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
			ctx.font = 'bold 96px ui-monospace, SFMono-Regular, Menlo, monospace';
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
		if (value === 1) {
			return new THREE.MeshBasicMaterial({
				color: 0xffffff,
				map: texPos,
				transparent: false,
				opacity: 1,
				depthWrite: true,
				side: THREE.DoubleSide,
				toneMapped: false
			});
		}
		if (value === -1) {
			return new THREE.MeshBasicMaterial({
				color: 0xffffff,
				map: texNeg,
				transparent: false,
				opacity: 1,
				depthWrite: true,
				side: THREE.DoubleSide,
				toneMapped: false
			});
		}
		// Empty (unpicked) cells share a single yellow across all three
		// boards — a neutral "neither + nor −" state that contrasts with
		// the green/red glyph textures and is distinct from each board's
		// own hue. updateActiveStyles() still dims this on inactive pages.
		return new THREE.MeshBasicMaterial({
			color: hueColor(0.55, 0.17, 60),
			transparent: false,
			opacity: 1,
			depthWrite: true,
			side: THREE.DoubleSide,
			toneMapped: false
		});
	}

	// Frame: a thin border (no opaque fill) that outlines each page so you can
	// see where the page lives in 3D without an overlay obscuring the cells.
	function makeFrameMesh(pageW: number, pageH: number, mat: THREE.MeshBasicMaterial): THREE.Mesh {
		const T = 0.05; // border thickness
		const outer = new THREE.Shape();
		outer.moveTo(-(pageW / 2 + T), -(pageH / 2 + T));
		outer.lineTo(pageW / 2 + T, -(pageH / 2 + T));
		outer.lineTo(pageW / 2 + T, pageH / 2 + T);
		outer.lineTo(-(pageW / 2 + T), pageH / 2 + T);
		outer.closePath();
		const hole = new THREE.Path();
		hole.moveTo(-pageW / 2, -pageH / 2);
		hole.lineTo(pageW / 2, -pageH / 2);
		hole.lineTo(pageW / 2, pageH / 2);
		hole.lineTo(-pageW / 2, pageH / 2);
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
		pageGroups = [];
		pageFrames = [];
		pageBgs = [];
		cellMeshes = [];
		tabMeshes = [];
		snapR = snapRows = snapCols = -1;
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
		if (!pageGroups.length) return;
		const ap = activePage;
		const tg = tightGap;
		const cl = clearance;
		for (let r = 0; r < pageGroups.length; r++) {
			pageGroups[r].position.z = pageZForActive(r, ap, tg, cl);
		}
	}

	function buildScene() {
		if (!stackGroup) return;
		clearScene();

		const Rv = R;
		const ROWS = rows;
		const COLS = cols;
		snapR = Rv;
		snapRows = ROWS;
		snapCols = COLS;

		const pageW = COLS * (CELL_W + CELL_GAP) + PAGE_PAD * 2;
		const pageH = ROWS * (CELL_W + CELL_GAP) + PAGE_PAD * 2;

		for (let r = 0; r < Rv; r++) {
			const pg = new THREE.Group();
			pg.position.z = pageZForActive(r, activePage, tightGap, clearance);

			// Very faint page fill — defines each page as one coherent surface
			// so the stack doesn't read as 7 disjoint borders. Stays low enough
			// that even a front-side inactive page doesn't occlude the active.
			const bgGeom = new THREE.PlaneGeometry(pageW, pageH);
			const bgMat = new THREE.MeshBasicMaterial({
				color: hueColor(0.18, 0.06, hue),
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
			pageBgs.push(bg);

			// Border frame outlining each page.
			const frameMat = new THREE.MeshBasicMaterial({
				color: hueColor(0.5, 0.12, hue),
				transparent: true,
				opacity: 0.55,
				depthWrite: false,
				side: THREE.DoubleSide,
				toneMapped: false
			});
			const frame = makeFrameMesh(pageW, pageH, frameMat);
			frame.position.z = -0.01;
			frame.userData = { type: 'frame', pageIndex: r };
			pg.add(frame);
			pageFrames.push(frame);

			cellMeshes.push([]);
			for (let row = 0; row < ROWS; row++) {
				cellMeshes[r].push([]);
				for (let col = 0; col < COLS; col++) {
					const value = game.getCell(board, r, row, col);
					const geom = new THREE.PlaneGeometry(CELL_W, CELL_W);
					const mat = makeCellMaterial(value);
					const mesh = new THREE.Mesh(geom, mat);
					mesh.position.x = (col - (COLS - 1) / 2) * (CELL_W + CELL_GAP);
					mesh.position.y = -(row - (ROWS - 1) / 2) * (CELL_W + CELL_GAP);
					mesh.position.z = 0;
					mesh.userData = { type: 'cell', pageIndex: r, row, col };
					pg.add(mesh);
					cellMeshes[r][row].push(mesh);
				}
			}

			// Tab — small bevelled box at the bottom-right corner. All tabs sit
			// at the same local position; the variable page spacing already
			// separates them visually in screen space when the active page
			// shifts.
			const tabGeom = new THREE.BoxGeometry(0.55, 0.55, 0.18);
			const tabMat = new THREE.MeshBasicMaterial({
				color: hueColor(0.4, 0.12, hue),
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
			tabMeshes.push(tab);

			stackGroup.add(pg);
			pageGroups.push(pg);
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
		const stackD =
			Rv <= 1
				? 0
				: Rv === 2
					? cl
					: interiorTight + cl * 2;

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
		if (!cellMeshes.length || cellMeshes.length !== snapR) return;
		for (let r = 0; r < cellMeshes.length; r++) {
			for (let row = 0; row < cellMeshes[r].length; row++) {
				for (let col = 0; col < cellMeshes[r][row].length; col++) {
					const mesh = cellMeshes[r][row][col];
					const value = game.getCell(board, r, row, col);
					(mesh.material as THREE.MeshBasicMaterial).dispose();
					mesh.material = makeCellMaterial(value);
				}
			}
		}
		updateActiveStyles();
	}

	function updateActiveStyles() {
		if (!pageGroups.length) return;
		const ap = activePage;
		for (let r = 0; r < pageGroups.length; r++) {
			const isActive = r === ap;
			// Active page: cells are opaque + depthWrite true, so they
			// punch a clean hole through the back of the stack — back-side
			// inactive pages don't bleed through. Inactive pages: cells
			// rendered as transparent + depthWrite false at "slightly
			// dimmer" 0.4 opacity, so they're clearly visible context.
			// The big gap around the active page guarantees inactive pages
			// don't visually crowd the active one.
			const cellOp = isActive ? 1.0 : 0.4;
			const frameOp = isActive ? 1.0 : 0.5;
			const bgOp = isActive ? 0.0 : 0.08;

			const frameMat = pageFrames[r].material as THREE.MeshBasicMaterial;
			frameMat.opacity = frameOp;
			frameMat.color.copy(
				isActive ? hueColor(0.85, 0.18, hue) : hueColor(0.55, 0.12, hue)
			);

			(pageBgs[r].material as THREE.MeshBasicMaterial).opacity = bgOp;

			for (let row = 0; row < cellMeshes[r].length; row++) {
				for (let col = 0; col < cellMeshes[r][row].length; col++) {
					const m = cellMeshes[r][row][col].material as THREE.MeshBasicMaterial;
					m.opacity = cellOp;
					// Active = opaque, z-write; inactive = transparent, no z-write.
					m.transparent = !isActive;
					m.depthWrite = isActive;
					m.needsUpdate = true;
				}
			}

			const tabMat = tabMeshes[r].material as THREE.MeshBasicMaterial;
			tabMat.opacity = isActive ? 1.0 : 0.8;
			tabMat.color.copy(
				isActive ? hueColor(0.85, 0.18, hue) : hueColor(0.4, 0.12, hue)
			);
			tabMeshes[r].scale.setScalar(isActive ? 1.25 : 0.85);
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
		if (cellMeshes[ap]) {
			for (const row of cellMeshes[ap]) for (const cell of row) arr.push(cell);
		}
		return arr;
	}

	function getAllInteractables(): THREE.Object3D[] {
		const arr: THREE.Object3D[] = [];
		// Tabs always pickable.
		for (const t of tabMeshes) arr.push(t);
		// Cells of the active page only.
		const ap = activePage;
		if (cellMeshes[ap]) {
			for (const row of cellMeshes[ap]) for (const cell of row) arr.push(cell);
		}
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
			row?: number;
			col?: number;
		};
		if (data.type === 'tab') {
			setActive(data.pageIndex);
		} else if (data.type === 'cell') {
			const dir = event.shiftKey ? -1 : 1;
			game.cycle(board, data.pageIndex, data.row!, data.col!, dir);
		}
	}

	function resetCellAt(event: MouseEvent) {
		// Right-click reset only ever targets cells on the active page.
		const hit = pickAt(event, getCellInteractables());
		if (!hit) return;
		const data = hit.object.userData as {
			type: string;
			pageIndex: number;
			row?: number;
			col?: number;
		};
		if (data.type === 'cell') {
			game.setCell(board, data.pageIndex, data.row!, data.col!, 0);
		}
	}

	// === Rotation drag + momentum ===========================================
	// Orientation is stored as a unit quaternion so the user can spin the
	// stack freely in any direction without hitting a pole — the previous
	// Euler-based scheme clamped the X axis just shy of ±π/2 to avoid
	// gimbal lock, which meant horizontal flicks could "spin over the
	// top" but vertical flicks could not. The quaternion approach also
	// makes rotations compose correctly under pre-multiplication, so a
	// drag in any screen direction always rotates around an axis lying
	// in the screen plane (true trackball/arcball feel) regardless of
	// how the stack is currently oriented.
	//
	// The default orientation is an isometric-style view from above: the
	// top of each page tilts toward the camera and a complementary yaw
	// reveals the depth of the rank-page stack at roughly 30°/30°. We
	// build the default quaternion from that exact Euler triple so the
	// initial framing is identical to the old implementation.
	const DEFAULT_QUAT = new THREE.Quaternion().setFromEuler(
		new THREE.Euler(Math.PI / 6, -Math.PI / 6, 0, 'XYZ')
	);
	// userQuat is mutated in place each frame by both the drag handler
	// and the momentum integrator. It is intentionally NOT a $state — the
	// reactive driver for the reset button is `rotationAtDefault` below,
	// which we flip whenever the orientation diverges from the default.
	const userQuat = DEFAULT_QUAT.clone();
	// Reactive flag: true exactly when no drag/flick has happened since
	// the last reset. Becomes false on first drag delta or when momentum
	// is being integrated; flipped back to true by resetView().
	let rotationAtDefault = $state(true);

	// Pre-allocated scratch objects so the per-frame integrator and the
	// pointermove handler don't churn the allocator.
	const _qDelta = new THREE.Quaternion();
	const _axis = new THREE.Vector3();
	// Angular velocity stored as ω·axis (rad/sec). Magnitude = angular
	// speed; direction = axis of rotation in world space. Lives in world
	// coordinates so flicks always rotate around screen-plane axes.
	const angVel = new THREE.Vector3();

	let dragging = false;
	let dragStart = { x: 0, y: 0 };
	let dragLast = { x: 0, y: 0 };
	let dragMoved = 0;
	const DRAG_THRESHOLD_PX = 5;
	const ROT_SENSITIVITY = 0.008;

	// Smoothed per-axis pixel velocity in px/ms. Sampled during drag so we
	// can hand off the motion as angular momentum on release.
	let velPxX = 0;
	let velPxY = 0;
	let lastMoveT = 0;
	const VEL_SMOOTH = 0.35; // 0..1, higher = more responsive
	const RELEASE_GRACE_MS = 90; // mouse must have moved within this window for momentum

	export function resetView() {
		userQuat.copy(DEFAULT_QUAT);
		angVel.set(0, 0, 0);
		rotationAtDefault = true;
		zoom = 50;
		tightGap = DEFAULT_TIGHT_GAP;
		clearance = DEFAULT_CLEARANCE;
	}

	// Wheel = page stepper. We accumulate `deltaY` until it crosses a
	// threshold so a single mouse-wheel "click" steps once and a trackpad
	// flick doesn't tear through the stack at one page per event.
	let wheelAccum = 0;
	const WHEEL_STEP_THRESHOLD = 40;

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		if (!R) return;
		wheelAccum += event.deltaY;
		if (Math.abs(wheelAccum) < WHEEL_STEP_THRESHOLD) return;
		const dir = wheelAccum > 0 ? 1 : -1;
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
			// Mouse went still before release — no spin.
			angVel.set(0, 0, 0);
			return;
		}
		// Convert smoothed px/ms → rad/sec around world-space axes that
		// lie in the screen plane. Horizontal pixel velocity becomes a
		// yaw around world +Y; vertical pixel velocity becomes a pitch
		// around world +X. The sensitivity factor matches the direct
		// drag conversion below so a flick continues seamlessly from
		// the last drag delta.
		angVel.set(velPxY * 1000 * ROT_SENSITIVITY, velPxX * 1000 * ROT_SENSITIVITY, 0);
	}

	function onPointerDown(event: PointerEvent) {
		// Left button starts a potential rotation drag. If the pointer goes
		// up before crossing DRAG_THRESHOLD_PX, we treat it as a click
		// instead (tab switch / cycle cell value). Right button is reserved
		// for the contextmenu cell-reset action and is ignored here.
		if (event.button !== 0) return;
		dragging = true;
		dragStart = { x: event.clientX, y: event.clientY };
		dragLast = { x: event.clientX, y: event.clientY };
		dragMoved = 0;
		// Stop any in-progress spin so the drag tracks the cursor 1:1.
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
			dragMoved += Math.abs(event.clientX - dragStart.x) + Math.abs(event.clientY - dragStart.y);
			if (dragMoved > DRAG_THRESHOLD_PX) {
				// Trackball rotation. Build a single delta quaternion for
				// this drag step whose axis lies in the screen plane and
				// is perpendicular to the drag vector, then *pre-*multiply
				// it onto userQuat. Pre-multiplying applies the rotation
				// in world space (around screen-aligned axes) rather than
				// in the stack's local frame, which is the trick that
				// lets a horizontal flick keep working even after the
				// stack has been pitched all the way "over the top".
				//
				// Axis derivation: the camera looks down -Z, so screen
				// +X = world +X and screen +Y = world -Y (because dy in
				// browser coords grows downward). The drag vector in
				// world coords is therefore (dx, -dy, 0), and the
				// trackball axis is +Z × drag = (dy, dx, 0) (un-norm).
				// For a pure horizontal drag this is +Y (yaw), and for
				// a pure vertical drag this is +X (pitch) — matching
				// the direction of the original Euler scheme exactly,
				// while combinations now sweep a continuous family of
				// in-screen-plane axes.
				const lenSq = dx * dx + dy * dy;
				if (lenSq > 0) {
					const len = Math.sqrt(lenSq);
					_axis.set(dy / len, dx / len, 0);
					_qDelta.setFromAxisAngle(_axis, len * ROT_SENSITIVITY);
					userQuat.premultiply(_qDelta);
					rotationAtDefault = false;
				}
				canvasEl.style.cursor = 'grabbing';
				trackVelocity(dx, dy);
			}
			return;
		}
		// Hover feedback: pointer over interactables, grab elsewhere.
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
			// Short press without drag → click action.
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
		// Right-click resets the hovered cell on the active page. Suppress
		// the native menu either way so right-click never surfaces a menu
		// over the canvas.
		event.preventDefault();
		resetCellAt(event);
	}

	// === Animation ==========================================================
	let lastFrameT = typeof performance !== 'undefined' ? performance.now() : 0;
	function animate() {
		const now = performance.now();
		const dt = Math.min(0.06, (now - lastFrameT) / 1000);
		lastFrameT = now;

		// Apply angular momentum every frame. There is no friction — the
		// stack keeps spinning until the user grabs it again. With the
		// quaternion representation there are no clamps on either axis:
		// vertical flicks can sail "over the top" and horizontal flicks
		// continue to wrap freely, in any combination. We integrate by
		// constructing a delta quaternion from the current ω·axis vector
		// and pre-multiplying it onto the orientation, mirroring the
		// world-space convention used during direct drag.
		const speed = angVel.length();
		if (speed > 0) {
			_axis.copy(angVel).divideScalar(speed);
			_qDelta.setFromAxisAngle(_axis, speed * dt);
			userQuat.premultiply(_qDelta);
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

		texPos = makeCellTexture('#4ade80', '+', '#0c1226');
		texNeg = makeCellTexture('#ef4444', '−', '#fff5f1');

		resize();
		buildScene();
		lastFrameT = performance.now();
		animate();

		window.addEventListener('resize', resize);
		// The container is now fluid; track its size directly so the WebGL
		// canvas follows layout changes that don't trigger a window resize.
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
		// Re-solve for the camera distance whenever the canvas aspect
		// changes, so the active page keeps occupying the target fraction
		// of the viewport regardless of viewport size or shape.
		fitCameraToStack(cachedPageW, cachedPageH, R);
	}

	onDestroy(() => {
		cancelAnimationFrame(frameId);
		window.removeEventListener('resize', resize);
		resizeObs?.disconnect();
		clearScene();
		if (texPos) texPos.dispose();
		if (texNeg) texNeg.dispose();
		if (renderer) renderer.dispose();
	});

	// === Reactivity =========================================================
	$effect(() => {
		const r = R;
		const ro = rows;
		const co = cols;
		if (!stackGroup) return;
		if (r !== snapR || ro !== snapRows || co !== snapCols) {
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

	// The horizontal sliders above and below this board's canvas drive
	// consecutive-page spacing and the gap carved around the active
	// page; both change the worst-case stack depth so we relayout and
	// refit the camera each time either updates.
	$effect(() => {
		tightGap;
		clearance;
		untrack(() => {
			relayoutPagesZ();
			// Refit so a much wider stack still fits on screen at zoom=1.
			fitCameraToStack(cachedPageW, cachedPageH, R);
		});
	});

	// Drives the camera's z-position from the user's zoom slider.
	// applyZoom() multiplies baseDist (the auto-fit distance) by the
	// log-mapped slider factor, so changing the slider is decoupled from
	// any board-geometry refits — and zoom level is preserved across
	// resizes, m/n/p changes, and page-spacing slider edits.
	$effect(() => {
		zoom;
		untrack(() => applyZoom());
	});
</script>

<div class="board-wrap" id={`board-${board}`} style:--hue={hue}>
	<div class="board-header">
		<!-- 1×3 navigation row of board labels. The active board's letter
		     is rendered as the heading; the other two are anchor links
		     that smooth-scroll to that board's wrap. On desktop the
		     non-active letters are display:none, so the header looks
		     unchanged there. -->
		<div class="title-row">
			{#each NAV_BOARDS as nb (nb.board)}
				{#if nb.board === board}
					<h3 class="title self" style:color={`oklch(0.78 0.18 ${nb.hue})`}>
						{nb.title}
					</h3>
				{:else}
					<a
						class="title other"
						href={`#board-${nb.board}`}
						onclick={(e) => scrollToBoard(e, nb.board)}
						style:color={`oklch(0.78 0.18 ${nb.hue})`}
						aria-label={`Jump to board ${nb.title}`}
						title={`Jump to board ${nb.title}`}
					>
						{nb.title}
					</a>
				{/if}
			{/each}
		</div>
	</div>
	<!-- Horizontal page-spacing slider, one per board. Drag right to
	     spread consecutive pages further apart along the camera axis;
	     drag left to compact them. Width matches the canvas so the
	     control reads as belonging to its board. The visible text label
	     is intentionally absent — the slider's position above the
	     canvas plus the title/aria-label tooltip carry the meaning. -->
	<label class="h-slider-row">
		<input
			type="range"
			class="h-slider"
			min="0.04"
			max="1.4"
			step="0.01"
			bind:value={tightGap}
			aria-label={`Page spacing for board ${title}`}
			title={`Page spacing for board ${title} — drag right to spread consecutive pages further apart, left to pack them tighter`}
		/>
	</label>
	<div class="canvas-row">
		<!-- Vertical page picker. Top of the slider = page 0 (closest to
		     the camera), bottom = page R-1 (farthest). Tied one-way to
		     activePage so external page changes (tab clicks, wheel,
		     page-spacing slider edits) keep it in sync. Available on
		     both desktop and mobile. -->
		<input
			type="range"
			class="v-slider page-slider"
			min="0"
			max={Math.max(0, R - 1)}
			step="1"
			value={activePage}
			oninput={(e) => setActive(Number((e.currentTarget as HTMLInputElement).value))}
			aria-label={`Active page on board ${title}`}
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
				aria-label={`Board ${title}, 3D rank-page stack. Active page ${activePage + 1} of ${R}.`}
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
		</div>
		<!-- Vertical zoom slider, mirrored on the right of the canvas.
		     Top = factor 0.25× (zoomed in, biggest active page); middle
		     = factor 1× (auto-fit, the default); bottom = factor 4×
		     (zoomed out, all pages visible). Available on both desktop
		     and mobile. -->
		<input
			type="range"
			class="v-slider zoom-slider"
			min="0"
			max="100"
			step="1"
			value={zoom}
			oninput={(e) => (zoom = Number((e.currentTarget as HTMLInputElement).value))}
			aria-label={`Zoom for board ${title}`}
			aria-valuetext={`${(zoomFactor(zoom) * 100).toFixed(0)}% of auto-fit distance`}
			title={`Zoom (${zoomFactor(zoom).toFixed(2)}×; drag up to zoom in, down to zoom out)`}
		/>
	</div>
	<!-- Horizontal active-page-clearance slider, one per board. Drag
	     right to widen the symmetric gap carved out in front of and
	     behind the active page (so it stays visible even when the
	     consecutive-page spacing is packed tight); drag left to close
	     the gap. Visible text label is intentionally absent — the
	     slider's position below the canvas plus the title/aria-label
	     tooltip carry the meaning. -->
	<label class="h-slider-row">
		<input
			type="range"
			class="h-slider"
			min="0.2"
			max="10"
			step="0.05"
			bind:value={clearance}
			aria-label={`Active page clearance for board ${title}`}
			title={`Active-page clearance for board ${title} — symmetric gap carved out in front of and behind the active page`}
		/>
	</label>
</div>

<style>
	.board-wrap {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5rem;
	}
	.board-header {
		display: flex;
		flex-direction: column;
		align-items: center;
		line-height: 1.1;
	}
	.title-row {
		display: flex;
		align-items: baseline;
		gap: 0.6rem;
	}
	.title {
		font-size: 1.4rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-shadow: 0 0 18px color-mix(in oklch, currentColor 60%, transparent);
		margin: 0;
	}
	.title.other {
		/* Hidden on desktop — the active title alone is enough there.
		   Revealed on mobile by the `(max-width: 540px)` block below as
		   a smaller, link-styled jump-to-board control. */
		display: none;
		text-decoration: none;
	}
	.canvas-row {
		/* `--hue` is set inline per board (A=blue/230, B=pink/340,
		   C=amber/45) and read by both the canvas-container chrome and
		   the page/zoom sliders' accent-color, so each slider matches
		   the board it belongs to. */
		--hue: 220;
		display: flex;
		align-items: stretch;
		gap: 0.45rem;
		width: 100%;
		justify-content: center;
	}
	/* Shared vertical slider styling used by both the page-picker on
	   the left and the zoom slider on the right. Visible at every
	   viewport size — desktop and mobile both. */
	.v-slider {
		display: block;
		margin: 0;
		padding: 0;
		width: 28px;
		/* Stretch to the canvas height. The row is `align-items:
		   stretch`, but a vertical <input> still needs an explicit
		   height: 100% in some engines for the track to fill. */
		align-self: stretch;
		height: auto;
		/* Standards-track vertical orientation. Most modern engines
		   (Chromium ≥111, Firefox, Safari ≥17.4) honour this;
		   `appearance: slider-vertical` is the legacy WebKit fallback
		   for older Safari/iOS. */
		writing-mode: vertical-lr;
		-webkit-appearance: slider-vertical;
		appearance: slider-vertical;
		accent-color: oklch(0.7 0.18 var(--hue));
		/* Prevent the page from scrolling while the user drags the
		   slider thumb on a touchscreen. */
		touch-action: none;
		cursor: ns-resize;
		background: transparent;
	}
	.v-slider:focus-visible {
		outline: 2px solid oklch(0.7 0.18 var(--hue));
		outline-offset: 2px;
		border-radius: 4px;
	}

	/* Horizontal "Page spacing" / "Clearance" sliders that sit above
	   and below this board's canvas. Width is sized to match the
	   canvas — the canvas-row reserves 2 × (28px slider + 0.45rem gap)
	   for the vertical sliders, so we subtract the same here. The
	   max-width caps the slider once the canvas itself caps at 580px
	   on wide viewports, keeping the two visually flush even when the
	   board-wrap is wider than the active canvas+sliders block. */
	.h-slider-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: calc(100% - 2 * (28px + 0.45rem));
		max-width: 580px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.7rem;
		color: rgb(148 163 184);
	}
	.h-slider {
		flex: 1 1 auto;
		min-width: 0;
		accent-color: oklch(0.7 0.18 var(--hue));
		cursor: ew-resize;
		/* Allow vertical page scrolling on touch even if the user's
		   finger lands on the slider track — only horizontal drags
		   should be captured by the input. */
		touch-action: pan-y;
	}
	.h-slider:focus-visible {
		outline: 2px solid oklch(0.7 0.18 var(--hue));
		outline-offset: 2px;
		border-radius: 4px;
	}
	.canvas-container {
		width: 100%;
		max-width: 580px;
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

	@media (max-width: 540px) {
		/* Drop the desktop min-width on phones. With page + card padding
		   the available column on a 320–375px viewport can be narrower
		   than 240px, which would otherwise force the square canvas to
		   overflow and trigger horizontal scrolling. The aspect-ratio
		   rule still keeps the canvas square at whatever width fits. */
		.canvas-container {
			min-width: 0;
			/* Belt-and-suspenders: clip anything inside that briefly
			   exceeds the container before THREE's resize handler runs
			   so the boards card never gets pushed off-screen. */
			overflow: hidden;
		}

		/* Mobile-only "1×3 jump table" in each board's header — the
		   active board's letter remains the heading, the other two
		   become anchor links to the corresponding boards' wraps. Each
		   link wears its destination board's hue so users can build a
		   colour-to-board mental map. */
		.title-row {
			display: grid;
			grid-template-columns: repeat(3, minmax(1.6rem, auto));
			gap: 1.1rem;
			justify-content: center;
			align-items: baseline;
		}
		.title.other {
			display: inline-block;
			font-size: 1.05rem;
			font-weight: 600;
			letter-spacing: 0.06em;
			opacity: 0.55;
			text-align: center;
			text-decoration: underline;
			text-decoration-thickness: 1px;
			text-underline-offset: 4px;
			cursor: pointer;
			transition:
				opacity 120ms ease,
				text-decoration-thickness 120ms ease;
		}
		.title.other:hover,
		.title.other:focus-visible {
			opacity: 1;
			text-decoration-thickness: 2px;
		}
		.title.other:focus-visible {
			outline: 2px solid currentColor;
			outline-offset: 4px;
			border-radius: 4px;
		}

		/* The canvas element starts at the HTML5 default 300×150 before
		   our onMount resize() runs. On a narrow viewport that default
		   would temporarily exceed its parent and inflate the grid
		   track. Cap it at 100% width so the canvas stays inside its
		   container even during that one-frame initial flash. */
		canvas {
			max-width: 100%;
			height: auto;
		}
	}
</style>
