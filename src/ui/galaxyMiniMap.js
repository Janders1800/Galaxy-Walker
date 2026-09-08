// Local system minimap rendered into #galaxyMap canvas.
// Readability-first presentation:
// - remove generic decorative/range circles
// - draw real orbit guides for planets and moons
// - improve body markers/highlights so the current system is easier to parse

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
    const shellEl = canvasEl?.closest?.("#galaxyMapShell")
        ?? document.getElementById("galaxyMapShell");

    let isOn = !!defaultOn;
    let zoom = defaultZoom;

    const _mapV = new THREE.Vector3();
    const _mapDir = new THREE.Vector3();
    const _mapParent = new THREE.Vector3();

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
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function setOn(v) {
        isOn = !!v;
        canvasEl?.classList?.toggle("off", !isOn);
        shellEl?.classList?.toggle("off", !isOn);
    }

    function toggle() {
        setOn(!isOn);
    }

    function setZoom(z) {
        zoom = Math.min(maxZoom, Math.max(minZoom, z));
    }

    function onKeyDown(e) {
        if (e.code === "KeyM") toggle();
        if (e.code === "Equal") setZoom(zoom * 1.12);
        if (e.code === "Minus") setZoom(zoom / 1.12);
    }

    function onResize() {
        resize();
    }

    function drawBodyLabel(name, x, y, emphasized = false) {
        if (!name) return;
        ctx.font = emphasized
            ? "10px ui-monospace, SFMono-Regular, Consolas, monospace"
            : "9px ui-monospace, SFMono-Regular, Consolas, monospace";
        ctx.textBaseline = "middle";
        ctx.fillStyle = emphasized
            ? "rgba(211,252,255,0.92)"
            : "rgba(171,227,235,0.82)";
        ctx.fillText(String(name).toUpperCase(), x + 10, y);
    }

    function draw() {
        if (!isOn || !canvasEl || !ctx) return;

        const bodies = (getBodies?.() ?? []).filter((b) => !isIgnored(b));
        const rect = canvasEl.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        if (w <= 0 || h <= 0) return;

        const cx = w * 0.5;
        const cy = h * 0.5;
        const R = Math.min(w, h) * 0.455;
        const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

        const bodyByGroup = new Map();
        for (const b of bodies) {
            if (b?.group) bodyByGroup.set(b.group, b);
        }

        const bodyInfo = [];
        let maxExtent = 1;
        for (let i = 0; i < bodies.length; i++) {
            const b = bodies[i];
            if (!b?.group?.getWorldPosition) continue;

            b.group.getWorldPosition(_mapV);
            const parentBody = bodyByGroup.get(b.group.parent) ?? null;
            let orbitCenterX = 0;
            let orbitCenterZ = 0;
            let isMoon = false;
            if (parentBody?.group?.getWorldPosition) {
                parentBody.group.getWorldPosition(_mapParent);
                orbitCenterX = _mapParent.x;
                orbitCenterZ = _mapParent.z;
                isMoon = true;
            }

            const orbitDist = b?.cfg?.orbitDist ?? 0;
            const centerRadius = Math.hypot(orbitCenterX, orbitCenterZ);
            const bodyRadius = Math.hypot(_mapV.x, _mapV.z);
            maxExtent = Math.max(maxExtent, bodyRadius + 300);
            if (orbitDist > 0) maxExtent = Math.max(maxExtent, centerRadius + orbitDist + 300);

            bodyInfo.push({
                index: i,
                body: b,
                worldX: _mapV.x,
                worldZ: _mapV.z,
                parentBody,
                orbitCenterX,
                orbitCenterZ,
                orbitDist,
                isMoon,
            });
        }

        maxExtent = maxExtent * 1.05 + 800;
        const scale = (R / maxExtent) * zoom;

        const pwp = getPlayerWorldPos?.();
        const desiredPanX = pwp?.x ?? camera?.position?.x ?? 0;
        const desiredPanZ = pwp?.z ?? camera?.position?.z ?? 0;
        const viewRadius = maxExtent / zoom;
        const minPan = -maxExtent + viewRadius;
        const maxPan = maxExtent - viewRadius;

        let mapPanX = 0;
        let mapPanZ = 0;
        if (minPan < maxPan) {
            mapPanX = clamp(desiredPanX, minPan, maxPan);
            mapPanZ = clamp(desiredPanZ, minPan, maxPan);
        }

        const originX = cx - mapPanX * scale;
        const originY = cy - mapPanZ * scale;

        ctx.clearRect(0, 0, w, h);

        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.clip();

        const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
        bg.addColorStop(0, "rgba(8,33,45,0.94)");
        bg.addColorStop(0.68, "rgba(3,16,24,0.96)");
        bg.addColorStop(1, "rgba(1,7,11,0.99)");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);

        // Simple crosshair through the system origin.
        ctx.save();
        ctx.strokeStyle = "rgba(112,238,255,0.12)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 6]);
        ctx.beginPath();
        ctx.moveTo(0, originY + 0.5);
        ctx.lineTo(w, originY + 0.5);
        ctx.moveTo(originX + 0.5, 0);
        ctx.lineTo(originX + 0.5, h);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // Actual orbit guides only.
        ctx.save();
        ctx.lineWidth = 1;
        for (const info of bodyInfo) {
            if (!(info.orbitDist > 0)) continue;
            const ox = originX + info.orbitCenterX * scale;
            const oy = originY + info.orbitCenterZ * scale;
            const rr = info.orbitDist * scale;
            if (rr < 1.2) continue;
            ctx.strokeStyle = info.isMoon
                ? "rgba(144,216,230,0.22)"
                : "rgba(116,246,255,0.30)";
            ctx.beginPath();
            ctx.arc(ox, oy, rr, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();

        // Star / system center.
        ctx.save();
        ctx.translate(originX, originY);
        const starGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, 18);
        starGlow.addColorStop(0, "rgba(255,232,163,1.0)");
        starGlow.addColorStop(0.45, "rgba(255,205,112,0.96)");
        starGlow.addColorStop(1, "rgba(255,205,112,0.0)");
        ctx.fillStyle = starGlow;
        ctx.beginPath();
        ctx.arc(0, 0, 18, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,214,118,1.0)";
        ctx.beginPath();
        ctx.arc(0, 0, 4.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,214,118,0.34)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, 0, 11.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        const nearInfo = nearestBodyInfo?.(camera?.position) ?? null;
        const nearestIndex = nearInfo?.i ?? -1;

        // Bodies.
        ctx.save();
        for (const info of bodyInfo) {
            const { index, body: b, worldX, worldZ, isMoon } = info;
            const x = originX + worldX * scale;
            const y = originY + worldZ * scale;
            const dx = x - cx;
            const dy = y - cy;
            if (dx * dx + dy * dy > (R + 24) * (R + 24)) continue;

            const baseR = b?.cfg?.baseRadius ?? 1400;
            const markerR = isMoon
                ? THREE.MathUtils.clamp(1.6 + (baseR / 800) * 0.55, 1.8, 3.2)
                : THREE.MathUtils.clamp(2.5 + (baseR / 1400) * 1.1, 2.5, 5.4);
            const isHi = index === nearestIndex;
            const name = b?.cfg?.name ?? `P${index + 1}`;

            ctx.strokeStyle = isMoon
                ? "rgba(221,245,250,0.56)"
                : "rgba(220,247,252,0.42)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(x, y, markerR + 1.2, 0, Math.PI * 2);
            ctx.stroke();

            ctx.fillStyle = hexToCss(b?.cfg?.color ?? 0xffffff);
            ctx.beginPath();
            ctx.arc(x, y, markerR + (isHi ? 0.6 : 0), 0, Math.PI * 2);
            ctx.fill();

            if (isHi) {
                ctx.strokeStyle = isMoon
                    ? "rgba(204,244,255,0.92)"
                    : "rgba(183,251,255,0.96)";
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.arc(x, y, markerR + 5.8, -0.48, Math.PI * 1.75);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(x, y, markerR + 9.0, 0.22, 1.15);
                ctx.stroke();
                drawBodyLabel(name, x, y, true);
            } else if (zoom >= 1.45 || (!isMoon && zoom >= 1.0)) {
                drawBodyLabel(name, x, y, false);
            }
        }
        ctx.restore();

        // Player marker points along the camera's horizontal heading.
        if (pwp) {
            const px = originX + pwp.x * scale;
            const py = originY + pwp.z * scale;
            camera?.getWorldDirection?.(_mapDir);
            const a = Math.atan2(_mapDir.z, _mapDir.x);
            const tip = 8;
            const back = 5;
            const wing = 4;

            ctx.save();
            ctx.translate(px, py);
            ctx.rotate(a);
            ctx.fillStyle = "rgba(120,246,255,0.98)";
            ctx.beginPath();
            ctx.moveTo(tip, 0);
            ctx.lineTo(-back, wing);
            ctx.lineTo(-2, 0);
            ctx.lineTo(-back, -wing);
            ctx.closePath();
            ctx.fill();
            ctx.restore();

            ctx.strokeStyle = "rgba(120,246,255,0.34)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(px, py, 11, 0, Math.PI * 2);
            ctx.stroke();
        }

        ctx.restore();

        // Bezel and bearing ticks.
        ctx.save();
        ctx.translate(cx, cy);
        ctx.lineWidth = 1;
        for (let i = 0; i < 4; i++) {
            const start = i * Math.PI * 0.5 + 0.12;
            ctx.strokeStyle = "rgba(120,246,255,0.42)";
            ctx.beginPath();
            ctx.arc(0, 0, R, start, start + Math.PI * 0.5 - 0.24);
            ctx.stroke();
        }
        for (let i = 0; i < 24; i++) {
            const a = (i / 24) * Math.PI * 2;
            const major = i % 6 === 0;
            const r0 = R - (major ? 8 : 4);
            const r1 = R - 1;
            ctx.strokeStyle = major
                ? "rgba(183,251,255,0.56)"
                : "rgba(120,246,255,0.20)";
            ctx.beginPath();
            ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
            ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
            ctx.stroke();
        }
        ctx.restore();

        ctx.fillStyle = "rgba(176,224,234,0.54)";
        ctx.font = "8px ui-monospace, SFMono-Regular, Consolas, monospace";
        ctx.textAlign = "center";
        ctx.fillText(`RANGE ${(maxExtent / zoom / 1000).toFixed(1)}K`, cx, h - 8);
        ctx.textAlign = "start";
    }

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
