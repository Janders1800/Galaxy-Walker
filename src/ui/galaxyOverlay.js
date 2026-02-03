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
    }

    regen();

    function resize() {
        if (!canvasEl || !ctx) return;
        const dpr = Math.max(1, devicePixelRatio || 1);
        canvasEl.width = Math.floor(innerWidth * dpr);
        canvasEl.height = Math.floor(innerHeight * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

    function draw() {
        if (!isOpen || !ctx) return;

        const w = innerWidth;
        const h = innerHeight;
        const cx = w * 0.5;
        const cy = h * 0.5;

        // background
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "rgba(0,0,0,1)";
        ctx.fillRect(0, 0, w, h);

        // vignette
        const R = Math.min(w, h) * 0.55;
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
        grad.addColorStop(0.0, "rgba(0,0,0,0.0)");
        grad.addColorStop(1.0, "rgba(0,0,0,0.6)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        // Subtle galaxy background glow that scales with the galaxy
        {
            const upp = galaxyUnitsPerPixel();
            const coreX = cx + (0 - gPanX) / upp;
            const coreY = cy + (0 - gPanZ) / upp;

            // Convert galaxy-space radius -> screen-space pixels
            let Rpx = HAZE_RADIUS_UNITS / upp;

            // Clamp so it doesn't get ridiculous when very zoomed in/out
            Rpx = Math.max(
                Math.min(w, h) * 0.35,
                Math.min(Rpx, Math.max(w, h) * 2.2),
            );

            const g = ctx.createRadialGradient(coreX, coreY, 0, coreX, coreY, Rpx);
            g.addColorStop(0.0, "rgba(80,160,255,0.10)");
            g.addColorStop(0.22, "rgba(60,130,255,0.06)");
            g.addColorStop(0.6, "rgba(40, 90,220,0.03)");
            g.addColorStop(1.0, "rgba(0,0,0,0.00)");

            ctx.save();
            ctx.globalCompositeOperation = "screen";
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            ctx.restore();
        }

        const upp = galaxyUnitsPerPixel();
        const halfW = w * 0.5 * upp;
        const halfH = h * 0.5 * upp;

        const minX = gPanX - halfW;
        const maxX = gPanX + halfW;
        const minZ = gPanZ - halfH;
        const maxZ = gPanZ + halfH;

        // grid cells visible
        const ix0 = Math.floor(minX / CELL);
        const ix1 = Math.floor(maxX / CELL);
        const iz0 = Math.floor(minZ / CELL);
        const iz1 = Math.floor(maxZ / CELL);

        // draw stars (cap count for perf)
        ctx.save();
        ctx.globalCompositeOperation = "lighter";

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

                    const base = 1.0 + (1.0 - s.mag) * 2.4;
                    const rad = Math.max(
                        0.6,
                        Math.min(3.4, base * (0.55 + 0.45 * Math.sqrt(gZoom))),
                    );
                    const alpha = 0.1 + (1.0 - s.mag) * 0.7;

                    ctx.fillStyle = s.col + alpha.toFixed(3) + ")";
                    ctx.beginPath();
                    ctx.arc(px, py, rad, 0, Math.PI * 2);
                    ctx.fill();

                    if (++drawn >= MAX_DRAW) break;
                }
                if (drawn >= MAX_DRAW) break;
            }
            if (drawn >= MAX_DRAW) break;
        }

        ctx.restore();

        // galactic core (0,0)
        {
            const gx = cx + (0 - gPanX) / upp;
            const gy = cy + (0 - gPanZ) / upp;
            ctx.fillStyle = "rgba(255,220,180,0.7)";
            ctx.beginPath();
            ctx.arc(gx, gy, 4.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "rgba(255,220,180,0.25)";
            ctx.beginPath();
            ctx.arc(gx, gy, 22, 0, Math.PI * 2);
            ctx.stroke();
        }

        // player marker (world XZ as proxy)
        {
            const pxw = galaxyPlayer.x;
            const pzw = galaxyPlayer.z;
            const px = cx + (pxw - gPanX) / upp;
            const py = cy + (pzw - gPanZ) / upp;

            ctx.fillStyle = "rgba(120,220,255,0.95)";
            ctx.beginPath();
            ctx.arc(px, py, 4.0, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "rgba(120,220,255,0.25)";
            ctx.beginPath();
            ctx.arc(px, py, 16.0, 0, Math.PI * 2);
            ctx.stroke();
        }

        // selected star highlight
        if (gSelected >= 0) {
            const s = galaxyStars[gSelected];
            const sx = cx + (s.x - gPanX) / upp;
            const sy = cy + (s.z - gPanZ) / upp;

            ctx.strokeStyle = "rgba(255,255,255,0.85)";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(sx, sy, 18, 0, Math.PI * 2);
            ctx.stroke();
            ctx.lineWidth = 1;

            ctx.fillStyle = "rgba(255,255,255,0.85)";
            ctx.font = "13px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
            ctx.fillText(`Selected: #${gSelected}`, sx + 22, sy + 4);
        }

        // corner stats
        ctx.fillStyle = "rgba(255,255,255,0.65)";
        ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx.fillText(
            `Stars: ${STAR_COUNT.toLocaleString()} | Zoom: ${gZoom.toFixed(2)}x`,
            12,
            h - 16,
        );
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
    }

    function onWheel(e) {
        if (!isOpen) return;
        e.preventDefault();
        const zoomFactor = Math.pow(1.12, -Math.sign(e.deltaY));
        gZoom = Math.min(40.0, Math.max(0.08, gZoom * zoomFactor));
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
                        lastClickStar = -1;
                        lastClickTime = 0;
                        return;
                    }
                } catch {
                    return;
                }

                const started = warpCtrl.start(targetDesc);
                if (started) {
                    lastClickStar = -1;
                    lastClickTime = 0;
                    close();
                }
            } else {
                // No warp system in this build — just center the map on the selected star.
                gPanX = s.x;
                gPanZ = s.z;
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
