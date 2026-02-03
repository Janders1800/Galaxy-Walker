// Local system minimap (orbit rings + bodies) rendered into #galaxyMap canvas.
// Extracted from src/main.js to keep the entrypoint smaller.

export function createGalaxyMiniMap({
    THREE,
    camera,
    getBodies = () => [],
    nearestBodyInfo = () => ({ i: -1, d: Infinity }),
    getPlayerWorldPos = () => null,
    canvasEl = document.getElementById("galaxyMap"),
    defaultOn = true,
    defaultZoom = 1.0,
    minZoom = 0.35,
    maxZoom = 6.0,
} = {}) {
    if (!canvasEl) {
        console.warn("Galaxy minimap canvas not found (#galaxyMap)");
    }

    const ctx = canvasEl?.getContext?.("2d", { alpha: true }) ?? null;

    let isOn = !!defaultOn;
    let zoom = defaultZoom;

    const _mapV = new THREE.Vector3();

    // Allow callers to pass extra scene objects (like asteroid belts) without
    // breaking or slowing the minimap. Anything tagged with userData.ignoreMiniMap
    // (or ignoreMinimap) will be skipped.
    function isIgnored(b) {
        const g = b?.group;
        const ud = g?.userData || b?.userData;
        return !!(ud?.ignoreMiniMap || ud?.ignoreMinimap || ud?.isAsteroidBelt);
    }

    function hexToCss(hex) {
        const c = new THREE.Color(hex ?? 0xffffff);
        const r = (c.r * 255) | 0;
        const g = (c.g * 255) | 0;
        const b = (c.b * 255) | 0;
        return `rgb(${r},${g},${b})`;
    }

    function resize() {
        if (!canvasEl || !ctx) return;
        const dpr = Math.max(1, devicePixelRatio || 1);
        const rect = canvasEl.getBoundingClientRect();
        canvasEl.width = Math.floor(rect.width * dpr);
        canvasEl.height = Math.floor(rect.height * dpr);
        // Draw in CSS pixels.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function setOn(v) {
        isOn = !!v;
        canvasEl?.classList?.toggle("off", !isOn);
    }

    function toggle() {
        setOn(!isOn);
    }

    function setZoom(z) {
        zoom = Math.min(maxZoom, Math.max(minZoom, z));
    }

    function onKeyDown(e) {
        if (e.code === "KeyM") {
            toggle();
        }
        // '+' is usually 'Equal' without shift on US layouts; keep the original behavior.
        if (e.code === "Equal") setZoom(zoom * 1.12);
        if (e.code === "Minus") setZoom(zoom / 1.12);
    }

    function onResize() {
        resize();
    }

    function draw() {
        if (!isOn || !canvasEl || !ctx) return;

        const bodies = getBodies?.() ?? [];
        const rect = canvasEl.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        if (w <= 0 || h <= 0) return;

        const cx = w * 0.5;
        const cy = h * 0.5;
        const R = Math.min(w, h) * 0.46;

        // Find max orbit distance.
        let maxOrbit = 1;
        for (const b of bodies) {
            if (isIgnored(b)) continue;
            const od = b?.cfg?.orbitDist ?? 0;
            if (od > maxOrbit) maxOrbit = od;
        }
        maxOrbit = maxOrbit * 1.06 + 1200;
        const scale = (R / maxOrbit) * zoom;

        // Minimap follow + clamp to map bounds
        const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

        const pwp = getPlayerWorldPos?.();
        const desiredPanX = pwp?.x ?? camera?.position?.x ?? 0;
        const desiredPanZ = pwp?.z ?? camera?.position?.z ?? 0;

        // Visible radius in world units. At zoom=1 this == maxOrbit.
        const viewRadius = maxOrbit / zoom;

        const minPan = -maxOrbit + viewRadius;
        const maxPan = maxOrbit - viewRadius;

        let mapPanX = 0;
        let mapPanZ = 0;
        if (minPan < maxPan) {
            mapPanX = clamp(desiredPanX, minPan, maxPan);
            mapPanZ = clamp(desiredPanZ, minPan, maxPan);
        }

        const originX = cx - mapPanX * scale;
        const originY = cy - mapPanZ * scale;

        ctx.clearRect(0, 0, w, h);

        // Soft vignette
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.05);
        g.addColorStop(0.0, "rgba(0,0,0,0.00)");
        g.addColorStop(1.0, "rgba(0,0,0,0.55)");
        ctx.fillStyle = "rgba(0,0,0,0.22)";
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);

        // Clip rings/bodies to the minimap circle
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.clip();

        // Grid-ish range rings
        ctx.save();
        ctx.translate(originX, originY);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.07)";
        const step = 2000;
        const rings = Math.floor(maxOrbit / step);
        for (let i = 1; i <= rings; i++) {
            const rr = i * step * scale;
            ctx.beginPath();
            ctx.arc(0, 0, rr, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();

        // Orbit rings
        ctx.save();
        ctx.translate(originX, originY);
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        for (const b of bodies) {
            if (isIgnored(b)) continue;
            const od = b?.cfg?.orbitDist ?? 0;
            if (od <= 0) continue;
            const rr = od * scale;
            ctx.beginPath();
            ctx.arc(0, 0, rr, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();

        // Star at origin
        ctx.save();
        ctx.translate(originX, originY);
        ctx.fillStyle = "rgba(255, 210, 140, 0.95)";
        ctx.beginPath();
        ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255, 210, 140, 0.22)";
        ctx.beginPath();
        ctx.arc(0, 0, 16, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // End minimap clip
        ctx.restore();

        // Bodies + labels
        ctx.save();
        ctx.font = "11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx.textBaseline = "middle";

        const nearInfo = nearestBodyInfo?.(camera?.position) ?? null;
        const nearestIndex = nearInfo?.i ?? -1;

        for (let i = 0; i < bodies.length; i++) {
            const b = bodies[i];
            if (isIgnored(b)) continue;
            if (!b?.group?.getWorldPosition) continue;
            b.group.getWorldPosition(_mapV);

            const x = originX + _mapV.x * scale;
            const y = originY + _mapV.z * scale;
            if (x < -40 || x > w + 40 || y < -40 || y > h + 40) continue;

            const baseR = b?.cfg?.baseRadius ?? 1400;
            const dot = THREE.MathUtils.clamp(2.2 + (baseR / 1400) * 1.2, 2.0, 4.2);

            const isHi = i === nearestIndex;
            const name = b?.cfg?.name ?? `P${i + 1}`;

            ctx.beginPath();
            ctx.fillStyle = hexToCss(b?.cfg?.color ?? 0xffffff);
            ctx.arc(x, y, dot + (isHi ? 1.6 : 0.0), 0, Math.PI * 2);
            ctx.fill();

            if (isHi) {
                ctx.fillStyle = "rgba(255,255,255,0.85)";
                ctx.fillText(name, x + 8, y);
            }
        }

        // Player marker
        if (pwp) {
            const px = originX + pwp.x * scale;
            const py = originY + pwp.z * scale;
            ctx.fillStyle = "rgba(120,220,255,0.95)";
            ctx.beginPath();
            ctx.arc(px, py, 3.0, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = "rgba(120,220,255,0.25)";
            ctx.beginPath();
            ctx.arc(px, py, 10.0, 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.restore();

        // Frame ring
        ctx.save();
        ctx.strokeStyle = "rgba(255,255,255,0.14)";
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    // Init
    resize();
    setOn(isOn);

    addEventListener("keydown", onKeyDown);
    addEventListener("resize", onResize);

    return {
        draw,
        resize,
        isOn: () => isOn,
        setOn,
        toggle,
        getZoom: () => zoom,
        setZoom,
        dispose: () => {
            removeEventListener("keydown", onKeyDown);
            removeEventListener("resize", onResize);
        },
    };
}
