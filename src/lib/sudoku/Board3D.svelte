<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import * as THREE from 'three';
	import type { Board, CellValue, GameState } from './state.svelte';

	type Props = { game: GameState; board: Board; title: string; hue: number };
	let { game, board, title, hue }: Props = $props();

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
	// `game.clearance` gap on both sides so it stays visible even when the
	// consecutive page spacing (`game.tightGap`) is packed very tight.


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
		return new THREE.MeshBasicMaterial({
			color: hueColor(0.22, 0.05, hue),
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
		const tg = game.tightGap;
		const cl = game.clearance;
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
			pg.position.z = pageZForActive(r, activePage, game.tightGap, game.clearance);

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
		const tg = game.tightGap;
		const cl = game.clearance;
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
		camera.far = d * 4 + stackD * 2 + 30;
		camera.position.set(0, 0, d);
		camera.updateProjectionMatrix();
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
			// dimmer" 0.7 opacity, so they're clearly visible context.
			// The big gap around the active page guarantees inactive pages
			// don't visually crowd the active one.
			const cellOp = isActive ? 1.0 : 0.7;
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
	// Default orientation is an isometric-style view from above: the top of
	// each page tilts toward the camera (positive X rotation) so we look
	// down on the stack, and a complementary Y rotation reveals the depth
	// of the rank-page stack at roughly a 30°/30° isometric angle.
	const DEFAULT_ROT_X = Math.PI / 6;
	const DEFAULT_ROT_Y = -Math.PI / 6;
	let userRotX = $state(DEFAULT_ROT_X);
	let userRotY = $state(DEFAULT_ROT_Y);
	let userRotZ = $state(0);

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

	// Active angular momentum (rad/sec). Frictionless: once a flick imparts
	// momentum, the stack keeps spinning until the user grabs it again
	// (onPointerDown zeroes both axes) or, on the X axis, until the
	// rotation clamp is hit.
	let angVelX = 0;
	let angVelY = 0;

	export function resetView() {
		userRotX = DEFAULT_ROT_X;
		userRotY = DEFAULT_ROT_Y;
		userRotZ = 0;
		angVelX = 0;
		angVelY = 0;
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
			angVelX = 0;
			angVelY = 0;
			return;
		}
		// Convert px/ms → rad/sec via the same sensitivity we use for direct drag.
		angVelY = velPxX * 1000 * ROT_SENSITIVITY;
		angVelX = velPxY * 1000 * ROT_SENSITIVITY;
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
		angVelX = 0;
		angVelY = 0;
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
				userRotY += dx * ROT_SENSITIVITY;
				userRotX += dy * ROT_SENSITIVITY;
				userRotX = Math.max(-Math.PI / 2.05, Math.min(Math.PI / 2.05, userRotX));
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
			angVelX = 0;
			angVelY = 0;
		} else {
			commitMomentum();
		}
		canvasEl.style.cursor = 'grab';
	}

	function onPointerCancel() {
		dragging = false;
		angVelX = 0;
		angVelY = 0;
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
		// stack keeps spinning until the user grabs it again. Y rotation
		// has no clamp (it wraps freely); X rotation is clamped just shy
		// of ±π/2 to prevent flipping upside down. When X hits the clamp
		// we zero its velocity so it doesn't waste compute pressing into
		// the wall every frame; Y velocity is left intact so a diagonal
		// flick continues spinning purely horizontally afterwards.
		if (angVelX !== 0 || angVelY !== 0) {
			userRotX += angVelX * dt;
			userRotY += angVelY * dt;
			const xMin = -Math.PI / 2.05;
			const xMax = Math.PI / 2.05;
			if (userRotX <= xMin) {
				userRotX = xMin;
				angVelX = 0;
			} else if (userRotX >= xMax) {
				userRotX = xMax;
				angVelX = 0;
			}
		}

		if (stackGroup) {
			stackGroup.rotation.x = userRotX;
			stackGroup.rotation.y = userRotY;
			stackGroup.rotation.z = userRotZ;
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

	// Sliders in the page header drive consecutive-page spacing and the gap
	// carved around the active page; both change the worst-case stack depth
	// so we relayout and refit the camera each time either updates.
	$effect(() => {
		game.tightGap;
		game.clearance;
		untrack(() => {
			relayoutPagesZ();
			// Refit so a much wider stack still fits on screen at zoom=1.
			fitCameraToStack(cachedPageW, cachedPageH, R);
		});
	});
</script>

<div class="board-wrap">
	<div class="board-header">
		<h3 class="title" style:color={`oklch(0.78 0.18 ${hue})`}>{title}</h3>
		<div class="dims">
			<span>{rows}</span>×<span>{cols}</span>×<span class="rdim">{R}</span>
		</div>
	</div>
	<div class="canvas-container" bind:this={containerEl} style:--hue={hue}>
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
		{#if userRotX !== DEFAULT_ROT_X || userRotY !== DEFAULT_ROT_Y || userRotZ !== 0}
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
	.title {
		font-size: 1.4rem;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-shadow: 0 0 18px color-mix(in oklch, currentColor 60%, transparent);
	}
	.dims {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 0.72rem;
		color: rgb(148 163 184);
	}
	.rdim {
		color: rgb(248 250 252);
		font-weight: 600;
	}
	.canvas-container {
		--hue: 220;
		width: 100%;
		max-width: 520px;
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
		}
	}
</style>
