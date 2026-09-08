// Fullscreen galaxy overlay (full-canvas map + star picking + double-click warp)
// Extracted from src/main.js to keep the entrypoint small.

import { createGalaxyField, galaxyGridKey } from "../core/galaxy.js";

export function createGalaxyOverlay({
    THREE,
    input,
    msgEl = null,
    galaxyPlayer = { x: 0, z: 0, name: "SOL-000" },
    getWarpCtrl = () => null,
    getPlayer = () => null,
    overlayEl = document.getElementById("galaxyOverlay"),
    canvasEl = document.getElementById("galaxyFull"),
    // Galaxy params (map space)
    GALAXY_RADIUS = 2500000,
    GALAXY_SEED = 133742069,
    STAR_COUNT = 2000,
    CELL = 25000,
    GALAXY_DOUBLE_SPIRAL = true,
    GALAXY_ARMS = 4,
    ARM_TIGHTNESS = 1.3,
    ARM_WIDTH = 1.3,
    CORE_BIAS = -0.5,
    BULGE_FRACTION = 0.175,
    BULGE_RADIUS = 0.2,
    BULGE_FLATTEN = 0.55,
    BULGE_ROT = 0.35,
} = {}) {
    if (!overlayEl || !canvasEl) {
        console.warn("Galaxy overlay elements not found (#galaxyOverlay / #galaxyFull)");
    }

    const ctx = canvasEl?.getContext?.("2d", { alpha: false }) ?? null;
    const targetStatusEl = document.getElementById("galaxyTargetStatus");
    const warpStatusEl = document.getElementById("galaxyWarpStatus");

    let isOpen = false;

    // Subtle background glow that scales with the galaxy
    const HAZE_RADIUS_UNITS = GALAXY_RADIUS * 3.0;

    // Camera controls
    let gPanX = 0;
    let gPanZ = 0;
    let gZoom = 1.0;
    let gSelected = -1;

    // State for mouse drag
    let dragging = false;
    let lastMX = 0;
    let lastMY = 0;

    // Star field + spatial grid (generated in core/galaxy.js)
    let galaxyStars = [];
    let gGrid = new Map();

    // The catalog is rasterized into one offscreen surface instead of issuing
    // thousands of Canvas2D path/fill calls every animation frame. OffscreenCanvas
    // keeps this out of the DOM where supported; the fallback is still only one
    // hidden canvas, never one element per star.
    const starLayer = typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(1, 1)
        : document.createElement("canvas");
    const starCtx = starLayer.getContext("2d", { alpha: true });
    let starLayerDirty = true;
    let starLayerDrawn = 0;
    let starLayerDpr = 1;

    function invalidateStarLayer() {
        starLayerDirty = true;
    }

    function regen() {
        const field = createGalaxyField({
            seed: GALAXY_SEED,
            radius: GALAXY_RADIUS,
            starCount: STAR_COUNT,
            cell: CELL,
            doubleSpiral: GALAXY_DOUBLE_SPIRAL,
            arms: GALAXY_ARMS,
            armTightness: ARM_TIGHTNESS,
            armWidth: ARM_WIDTH,
            coreBias: CORE_BIAS,
            bulgeFraction: BULGE_FRACTION,
            bulgeRadius: BULGE_RADIUS,
            bulgeFlatten: BULGE_FLATTEN,
            bulgeRot: BULGE_ROT,
        });
        galaxyStars = field.stars;
        gGrid = field.grid;
        invalidateStarLayer();
    }

    regen();

    function resize() {
        if (!canvasEl || !ctx) return;
        const dpr = Math.max(1, devicePixelRatio || 1);
        canvasEl.width = Math.floor(innerWidth * dpr);
        canvasEl.height = Math.floor(innerHeight * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (starCtx) {
            starLayerDpr = dpr;
            starLayer.width = canvasEl.width;
            starLayer.height = canvasEl.height;
            starCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            invalidateStarLayer();
        }
    }

    function open() {
        if (!overlayEl) return;
        isOpen = true;
        overlayEl.classList.remove("off");
        resize();

        // Leave pointer lock so mouse works for the map
        if (document.pointerLockElement) document.exitPointerLock();
        input?.resetMouse?.();

        // Start centered on current system
        gPanX = galaxyPlayer.x;
        gPanZ = galaxyPlayer.z;
        invalidateStarLayer();
        if (gSelected < 0) {
            if (targetStatusEl) targetStatusEl.textContent = "No target selected";
            if (warpStatusEl) warpStatusEl.textContent = "Select a star";
        }
    }

    function close() {
        if (!overlayEl) return;
        isOpen = false;
        overlayEl.classList.add("off");
        dragging = false;
    }

    function toggle() {
        if (isOpen) close();
        else open();
    }

    function galaxyUnitsPerPixel() {
        const base = GALAXY_RADIUS / (Math.min(innerWidth, innerHeight) * 0.6);
        return base / gZoom;
    }

    function renderStarLayer({
        w,
        h,
        cx,
        cy,
        upp,
        minX,
        maxX,
        minZ,
        maxZ,
    }) {
        if (!starCtx) return 0;

        // Width/height assignment resets the transform, so restore DPR before
        // drawing in CSS-pixel coordinates.
        starCtx.setTransform(starLayerDpr, 0, 0, starLayerDpr, 0, 0);
        starCtx.clearRect(0, 0, w, h);
        starCtx.save();
        starCtx.globalCompositeOperation = "lighter";

        const ix0 = Math.floor(minX / CELL);
        const ix1 = Math.floor(maxX / CELL);
        const iz0 = Math.floor(minZ / CELL);
        const iz1 = Math.floor(maxZ / CELL);
        const MAX_DRAW = 30000;
        let drawn = 0;

        for (let iz = iz0; iz <= iz1; iz++) {
            for (let ix = ix0; ix <= ix1; ix++) {
                const arr = gGrid.get(galaxyGridKey(ix, iz));
                if (!arr) continue;

                for (let k = 0; k < arr.length; k++) {
                    const s = galaxyStars[arr[k]];
                    if (s.x < minX || s.x > maxX || s.z < minZ || s.z > maxZ) continue;

                    const px = cx + (s.x - gPanX) / upp;
                    const py = cy + (s.z - gPanZ) / upp;
                    const base = 0.9 + (1.0 - s.mag) * 2.25;
                    const rad = Math.max(
                        0.55,
                        Math.min(3.2, base * (0.55 + 0.45 * Math.sqrt(gZoom))),
                    );
                    const alpha = 0.12 + (1.0 - s.mag) * 0.72;

                    starCtx.fillStyle = s.col + alpha.toFixed(3) + ")";
                    starCtx.beginPath();
                    starCtx.arc(px, py, rad, 0, Math.PI * 2);
                    starCtx.fill();

                    if (++drawn >= MAX_DRAW) break;
                }
                if (drawn >= MAX_DRAW) break;
            }
            if (drawn >= MAX_DRAW) break;
        }

        starCtx.restore();
        starLayerDrawn = drawn;
        starLayerDirty = false;
        return drawn;
    }

    function draw() {
        if (!isOpen || !ctx) return;

        const w = innerWidth;
        const h = innerHeight;
        const cx = w * 0.5;
        const cy = h * 0.5;

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "rgb(0,4,7)";
        ctx.fillRect(0, 0, w, h);

        const upp = galaxyUnitsPerPixel();
        const halfW = w * 0.5 * upp;
        const halfH = h * 0.5 * upp;
        const minX = gPanX - halfW;
        const maxX = gPanX + halfW;
        const minZ = gPanZ - halfH;
        const maxZ = gPanZ + halfH;

        // Low-cost navigation grid with adaptive spacing.
        let gridStep = CELL;
        while (gridStep / upp < 72) gridStep *= 2;
        while (gridStep > CELL && gridStep / upp > 180) gridStep *= 0.5;

        ctx.save();
        ctx.lineWidth = 1;
        ctx.font = "8px ui-monospace, SFMono-Regular, Consolas, monospace";
        ctx.fillStyle = "rgba(120,246,255,0.24)";
        ctx.textBaseline = "top";

        let gxLine = Math.floor(minX / gridStep) * gridStep;
        for (let guard = 0; gxLine <= maxX && guard < 80; guard++, gxLine += gridStep) {
            const x = cx + (gxLine - gPanX) / upp;
            const major = Math.round(gxLine / gridStep) % 4 === 0;
            ctx.strokeStyle = major
                ? "rgba(120,246,255,0.085)"
                : "rgba(120,246,255,0.038)";
            ctx.beginPath();
            ctx.moveTo(x + 0.5, 0);
            ctx.lineTo(x + 0.5, h);
            ctx.stroke();
            if (major && x > 72 && x < w - 72) {
                ctx.fillText(`${Math.round(gxLine / 1000)}K`, x + 4, h - 30);
            }
        }

        let gzLine = Math.floor(minZ / gridStep) * gridStep;
        for (let guard = 0; gzLine <= maxZ && guard < 80; guard++, gzLine += gridStep) {
            const y = cy + (gzLine - gPanZ) / upp;
            const major = Math.round(gzLine / gridStep) % 4 === 0;
            ctx.strokeStyle = major
                ? "rgba(120,246,255,0.085)"
                : "rgba(120,246,255,0.038)";
            ctx.beginPath();
            ctx.moveTo(0, y + 0.5);
            ctx.lineTo(w, y + 0.5);
            ctx.stroke();
        }
        ctx.restore();

        // Galaxy-scaled core haze.
        {
            const coreX = cx + (0 - gPanX) / upp;
            const coreY = cy + (0 - gPanZ) / upp;
            let Rpx = HAZE_RADIUS_UNITS / upp;
            Rpx = Math.max(
                Math.min(w, h) * 0.35,
                Math.min(Rpx, Math.max(w, h) * 2.2),
            );

            const g = ctx.createRadialGradient(coreX, coreY, 0, coreX, coreY, Rpx);
            g.addColorStop(0.0, "rgba(84,172,255,0.105)");
            g.addColorStop(0.22, "rgba(54,125,236,0.062)");
            g.addColorStop(0.62, "rgba(25,72,170,0.025)");
            g.addColorStop(1.0, "rgba(0,0,0,0)");
            ctx.save();
            ctx.globalCompositeOperation = "screen";
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }

        // Star catalog: one cached raster blit per frame. The expensive star
        // paths are rebuilt only when pan/zoom/resize/catalog state changes.
        if (starLayerDirty) {
            renderStarLayer({ w, h, cx, cy, upp, minX, maxX, minZ, maxZ });
        }
        const drawn = starLayerDrawn;
        if (starCtx && starLayer.width > 0 && starLayer.height > 0) {
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            ctx.drawImage(starLayer, 0, 0, starLayer.width, starLayer.height, 0, 0, w, h);
            ctx.restore();
        }

        // Galactic core marker.
        {
            const gx = cx + (0 - gPanX) / upp;
            const gy = cy + (0 - gPanZ) / upp;
            ctx.fillStyle = "rgba(255,208,132,0.82)";
            ctx.beginPath();
            ctx.arc(gx, gy, 4.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "rgba(255,208,132,0.28)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(gx, gy, 18, -0.35, 0.35);
            ctx.arc(gx, gy, 18, Math.PI - 0.35, Math.PI + 0.35);
            ctx.stroke();
        }

        // Current-system marker.
        {
            const px = cx + (galaxyPlayer.x - gPanX) / upp;
            const py = cy + (galaxyPlayer.z - gPanZ) / upp;
            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(Math.PI * 0.25);
            ctx.fillStyle = "rgba(120,246,255,0.98)";
            ctx.fillRect(-3.5, -3.5, 7, 7);
            ctx.strokeStyle = "rgba(120,246,255,0.34)";
            ctx.strokeRect(-10.5, -10.5, 21, 21);
            ctx.restore();
        }

        // Selected-star targeting brackets.
        if (gSelected >= 0) {
            const s = galaxyStars[gSelected];
            const sx = cx + (s.x - gPanX) / upp;
            const sy = cy + (s.z - gPanZ) / upp;
            const r = 19;
            const arm = 7;

            ctx.strokeStyle = "rgba(183,251,255,0.92)";
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(sx - r, sy - r + arm);
            ctx.lineTo(sx - r, sy - r);
            ctx.lineTo(sx - r + arm, sy - r);
            ctx.moveTo(sx + r - arm, sy - r);
            ctx.lineTo(sx + r, sy - r);
            ctx.lineTo(sx + r, sy - r + arm);
            ctx.moveTo(sx + r, sy + r - arm);
            ctx.lineTo(sx + r, sy + r);
            ctx.lineTo(sx + r - arm, sy + r);
            ctx.moveTo(sx - r + arm, sy + r);
            ctx.lineTo(sx - r, sy + r);
            ctx.lineTo(sx - r, sy + r - arm);
            ctx.stroke();

            ctx.fillStyle = "rgba(183,251,255,0.88)";
            ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
            ctx.fillText(`STAR-${String(gSelected).padStart(3, "0")}`, sx + 27, sy + 4);
        }

        // Instrument readouts at canvas level.
        ctx.fillStyle = "rgba(176,224,234,0.52)";
        ctx.font = "9px ui-monospace, SFMono-Regular, Consolas, monospace";
        ctx.fillText(
            `CATALOG ${STAR_COUNT.toLocaleString()} // VISIBLE ${drawn.toLocaleString()} // RANGE ${gZoom.toFixed(2)}X`,
            18,
            h - 18,
        );

        const scalePx = 120;
        const scaleUnits = scalePx * upp;
        ctx.strokeStyle = "rgba(120,246,255,0.42)";
        ctx.beginPath();
        ctx.moveTo(w - 158, h - 20.5);
        ctx.lineTo(w - 38, h - 20.5);
        ctx.moveTo(w - 158, h - 25);
        ctx.lineTo(w - 158, h - 16);
        ctx.moveTo(w - 38, h - 25);
        ctx.lineTo(w - 38, h - 16);
        ctx.stroke();
        ctx.fillStyle = "rgba(183,251,255,0.62)";
        ctx.textAlign = "center";
        ctx.fillText(`${Math.max(1, Math.round(scaleUnits / 1000))}K LY`, w - 98, h - 34);
        ctx.textAlign = "start";

        // Edge vignette keeps the map legible without a CSS backdrop filter.
        const vignetteR = Math.max(w, h) * 0.72;
        const vignette = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.22, cx, cy, vignetteR);
        vignette.addColorStop(0, "rgba(0,0,0,0)");
        vignette.addColorStop(1, "rgba(0,0,0,0.58)");
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, w, h);
    }

    // Input listeners
    function onKeyDown(e) {
        if (e.code === "KeyG") {
            toggle();
        }
        if (isOpen && e.code === "Escape") close();
        if (isOpen && e.code === "Enter") {
            // center on player
            gPanX = galaxyPlayer.x;
            gPanZ = galaxyPlayer.z;
            invalidateStarLayer();
        }
    }

    function onResize() {
        if (isOpen) resize();
    }

    function onMouseDown(e) {
        if (!isOpen) return;
        dragging = true;
        lastMX = e.clientX;
        lastMY = e.clientY;
    }

    function onMouseUp() {
        dragging = false;
    }

    function onMouseMove(e) {
        if (!isOpen || !dragging) return;

        const dx = e.clientX - lastMX;
        const dy = e.clientY - lastMY;
        lastMX = e.clientX;
        lastMY = e.clientY;

        const upp = galaxyUnitsPerPixel();
        gPanX -= dx * upp;
        gPanZ -= dy * upp;
        invalidateStarLayer();
    }

    function onWheel(e) {
        if (!isOpen) return;
        e.preventDefault();
        const zoomFactor = Math.pow(1.12, -Math.sign(e.deltaY));
        gZoom = Math.min(40.0, Math.max(0.08, gZoom * zoomFactor));
        invalidateStarLayer();
    }

    // Double-click handling
    let lastClickStar = -1;
    let lastClickTime = 0;
    const DOUBLE_CLICK_MS = 350;

    function onClick(e) {
        if (!isOpen) return;

        const mx = e.clientX;
        const my = e.clientY;
        const upp = galaxyUnitsPerPixel();
        const gx = gPanX + (mx - innerWidth * 0.5) * upp;
        const gz = gPanZ + (my - innerHeight * 0.5) * upp;

        // search nearby cells only
        const ix = Math.floor(gx / CELL);
        const iz = Math.floor(gz / CELL);

        let best = -1;
        let bestD2 = Infinity;

        for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
                const arr = gGrid.get(galaxyGridKey(ix + dx, iz + dz));
                if (!arr) continue;
                for (const id of arr) {
                    const s = galaxyStars[id];
                    const dxg = s.x - gx;
                    const dzg = s.z - gz;
                    const d2 = dxg * dxg + dzg * dzg;
                    if (d2 < bestD2) {
                        bestD2 = d2;
                        best = id;
                    }
                }
            }
        }

        // only select if reasonably close on screen
        const maxPick = (15 * upp) ** 2;

        // miss -> reset the "double click armed" state
        if (!(best >= 0 && bestD2 <= maxPick)) {
            lastClickStar = -1;
            lastClickTime = 0;
            return;
        }

        // select the star
        gSelected = best;
        if (targetStatusEl) {
            targetStatusEl.textContent = `STAR-${String(best).padStart(3, "0")} selected`;
        }
        if (warpStatusEl) {
            warpStatusEl.textContent = "Double-click to warp";
        }

        // double click on the SAME star
        const now = performance.now();
        if (best === lastClickStar && now - lastClickTime <= DOUBLE_CLICK_MS) {
            const s = galaxyStars[best];

            const nx = s.x / GALAXY_RADIUS;
            const ny = s.z / GALAXY_RADIUS;

            const targetDesc = {
                name: `STAR-${String(best).padStart(3, "0")}`,
                seed: (GALAXY_SEED ^ (best * 2654435761)) >>> 0,
                x: nx,
                y: ny,
                gx: s.x,
                gz: s.z,
            };

            const warpCtrl = getWarpCtrl?.();
            const player = getPlayer?.();

            if (warpCtrl?.start) {
                // Warp is only allowed in fly mode.
                try {
                    if (player?.mode !== "fly") {
                        if (warpStatusEl) {
                            warpStatusEl.textContent = "Take off before warping";
                        }
                        lastClickStar = -1;
                        lastClickTime = 0;
                        return;
                    }
                } catch {
                    return;
                }

                const started = warpCtrl.start(targetDesc);
                if (started) {
                    if (targetStatusEl) targetStatusEl.textContent = `${targetDesc.name} locked`;
                    if (warpStatusEl) warpStatusEl.textContent = "Warping";
                    lastClickStar = -1;
                    lastClickTime = 0;
                    close();
                }
            } else {
                // No warp system in this build — just center the map on the selected star.
                gPanX = s.x;
                gPanZ = s.z;
                invalidateStarLayer();
                if (msgEl) {
                    msgEl.textContent = `Selected ${targetDesc.name} (warp not enabled in this build).`;
                }
                lastClickStar = -1;
                lastClickTime = 0;
            }
            return;
        }

        // arm for the next click
        lastClickStar = best;
        lastClickTime = now;
    }

    // Wire events
    addEventListener("keydown", onKeyDown);
    addEventListener("resize", onResize);

    canvasEl?.addEventListener?.("mousedown", onMouseDown);
    addEventListener("mouseup", onMouseUp);
    addEventListener("mousemove", onMouseMove);
    canvasEl?.addEventListener?.("wheel", onWheel, { passive: false });
    canvasEl?.addEventListener?.("click", onClick);

    return {
        open,
        close,
        toggle,
        isOpen: () => isOpen,
        draw,
        resize,
        regen,
    };
}
