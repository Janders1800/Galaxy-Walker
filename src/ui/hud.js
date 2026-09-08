// Throttled flight-computer telemetry. DOM nodes are created once and only
// changed when the displayed values differ, keeping the HUD inexpensive.

function makeRow(root, label) {
    const row = document.createElement("div");
    row.className = "telemetryRow";

    const labelEl = document.createElement("span");
    labelEl.className = "telemetryLabel";
    labelEl.textContent = label;

    const valueEl = document.createElement("span");
    valueEl.className = "telemetryValue";

    const stateEl = document.createElement("span");
    stateEl.className = "telemetryState";

    row.append(labelEl, valueEl, stateEl);
    root.append(row);
    return { row, valueEl, stateEl };
}

export function createHudUpdater({ msgEl, intervalMs = 200 } = {}) {
    let nextMs = 0;
    let lastKey = "";
    let rows = null;

    function ensureRows() {
        if (!msgEl) return null;
        if (rows && msgEl.contains(rows.celestial.row)) return rows;

        msgEl.replaceChildren();
        rows = {
            celestial: makeRow(msgEl, "CELESTIAL"),
            navigation: makeRow(msgEl, "MODE"),
            terrain: makeRow(msgEl, "TERRAIN"),
        };
        return rows;
    }

    function setRow(row, value, state, caution = false) {
        row.valueEl.textContent = value;
        row.stateEl.textContent = state;
        row.stateEl.classList.toggle("caution", caution);
    }

    function update({
        now,
        player,
        bodies,
        moons,
        nearestBodyInfo,
        underwater = false,
        depth01 = 0,
        godRaysOn = false,
        blueNoiseReady = false,
        LOD_NEAREST_K = 0,
        ringsCount = 0,
        beltOn = false,
    } = {}) {
        if (!msgEl || now < nextMs) return;

        const safeBodies = bodies ?? [];
        const safeMoons = moons ?? [];
        const near = nearestBodyInfo?.(player?.worldPos) ?? {
            i: -1,
            d: Infinity,
        };
        const nearName =
            near?.i >= 0
                ? (safeBodies[near.i]?.cfg?.name ?? "UNKNOWN")
                : "NONE";
        const activeCount = safeBodies.reduce(
            (sum, body) => sum + (body?.terrainActive ? 1 : 0),
            0,
        );
        const walkBody =
            safeBodies[player?.bodyIndex ?? 0]?.cfg?.name ?? "UNKNOWN";
        const mode = player?.landing
            ? "LANDING"
            : player?.mode === "walk"
              ? "WALK"
              : player?.mode === "drive"
                ? "ROVER"
                : "FLY";
        const navTarget = mode === "WALK" || mode === "ROVER" ? walkBody : nearName;
        const depthPct = Math.round(Math.max(0, Math.min(1, depth01)) * 100);

        const key = [
            safeBodies.length,
            safeMoons.length,
            ringsCount,
            beltOn,
            mode,
            navTarget,
            activeCount,
            underwater,
            depthPct,
            godRaysOn,
            blueNoiseReady,
            LOD_NEAREST_K,
        ].join("|");

        if (key !== lastKey) {
            const ui = ensureRows();
            if (!ui) return;

            setRow(
                ui.celestial,
                `P ${safeBodies.length}  /  M ${safeMoons.length}  /  R ${ringsCount}`,
                beltOn ? "BELT" : "",
                false,
            );
            setRow(ui.navigation, `${mode}  ·  ${navTarget}`, "");
            setRow(
                ui.terrain,
                `${activeCount} ACTIVE`,
                underwater ? `UNDERWATER ${depthPct}%` : "",
                underwater,
            );

            lastKey = key;
        }

        nextMs = now + intervalMs;
    }

    return { update };
}


export function createFlightHudUpdater({ rootEl, THREE, camera } = {}) {
    const ladderEl = rootEl?.querySelector?.("#flightHudLadder") ?? null;
    const speedEl = rootEl?.querySelector?.("#flightHudSpeedValue") ?? null;
    const altitudeEl = rootEl?.querySelector?.("#flightHudAltitudeValue") ?? null;

    if (!rootEl || !THREE || !camera) {
        return { update() {} };
    }

    const centerW = new THREE.Vector3();
    const posL = new THREE.Vector3();
    const dirL = new THREE.Vector3();
    const upW = new THREE.Vector3();
    const forwardW = new THREE.Vector3();
    const camUpW = new THREE.Vector3();
    const rightW = new THREE.Vector3();

    let nextTextMs = 0;
    let lastVisible = false;


    function setVisible(visible) {
        if (visible === lastVisible) return;
        lastVisible = visible;
        rootEl.classList.toggle("on", visible);
        rootEl.setAttribute("aria-hidden", visible ? "false" : "true");
    }

    function fmtDistance(v) {
        if (!Number.isFinite(v)) return "—";
        const a = Math.abs(v);
        if (a < 1000) return `${Math.round(v)} m`;
        if (a < 100000) return `${(v / 1000).toFixed(1)} km`;
        return `${Math.round(v / 1000)} km`;
    }

    function fmtSpeed(v) {
        if (!Number.isFinite(v)) return "—";
        const a = Math.abs(v);
        if (a < 1000) return `${Math.round(v)} m/s`;
        return `${(v / 1000).toFixed(a < 10000 ? 2 : 1)} km/s`;
    }

    function update({
        now = performance.now(),
        player,
        bodies,
        nearestBodyInfo,
        overlayOpen = false,
    } = {}) {
        const visible = !!player && player.mode === "fly" && !overlayOpen;
        setVisible(visible);
        if (!visible) return;

        const speed = player.worldVel?.length?.() ?? 0;
        const near = nearestBodyInfo?.(player.worldPos) ?? { i: -1, d: Infinity };
        const body = near.i >= 0 ? bodies?.[near.i] : null;

        let hasReference = false;
        let altitude = Infinity;
        let pitchDeg = 0;
        let rollDeg = 0;
        let planetCueOpacity = 0;

        if (body?.group && player.worldPos) {
            body.group.updateMatrixWorld(true);
            body.group.getWorldPosition(centerW);
            posL.copy(player.worldPos);
            body.group.worldToLocal(posL);

            const radius = posL.length();
            if (radius > 1e-5) {
                dirL.copy(posL).multiplyScalar(1 / radius);
                let surfaceR = body.cfg?.baseRadius ?? body.baseRadius ?? 0;
                if (typeof body.radiusAtDir === "function") {
                    surfaceR = body.radiusAtDir(dirL.x, dirL.y, dirL.z);
                }
                altitude = radius - surfaceR;

                const refRange = Math.max(5000, Math.max(surfaceR, 1) * 12);
                hasReference = near.d <= refRange;

                if (hasReference) {
                    upW.copy(player.worldPos).sub(centerW).normalize();
                    forwardW.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
                    camUpW.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
                    rightW.crossVectors(forwardW, camUpW).normalize();

                    const RAD2DEG = 180 / Math.PI;
                    pitchDeg = Math.asin(THREE.MathUtils.clamp(forwardW.dot(upW), -1, 1)) * RAD2DEG;
                    rollDeg = Math.atan2(upW.dot(rightW), upW.dot(camUpW)) * RAD2DEG;

                    // Keep the low-altitude aircraft cue, then fade it away as
                    // the player climbs. 1 km actual altitude is the cutoff.
                    const cueFade = THREE.MathUtils.smoothstep(
                        Math.max(0, altitude),
                        700.0,
                        1000.0,
                    );
                    planetCueOpacity = THREE.MathUtils.lerp(1.0, 0.2, cueFade);
                }
            }
        }

        rootEl.classList.toggle("noReference", !hasReference);
        rootEl.style.setProperty(
            "--planet-cue-opacity",
            hasReference ? planetCueOpacity.toFixed(3) : "0",
        );

        if (hasReference && ladderEl) {
            const pitchPx = THREE.MathUtils.clamp(pitchDeg, -45, 45) * 2.2;
            ladderEl.style.transform = `translate(-50%, -50%) translateY(${pitchPx.toFixed(2)}px) rotate(${rollDeg.toFixed(2)}deg)`;
        }


        if (now >= nextTextMs) {
            if (speedEl) {
                // Display-world velocity is intentionally 10x physical scale,
                // matching the simplified flight HUD's distance presentation.
                // Physics, shields, collisions and camera behavior still use the
                // unscaled player.worldVel value.
                speedEl.textContent = fmtSpeed(speed * 10.0);
            }
            if (altitudeEl) {
                // Display-world distances are intentionally 10x physical scale:
                // 1 km actual terrain altitude reads as 10 km on the HUD.
                altitudeEl.textContent = hasReference
                    ? fmtDistance(Math.max(0, altitude) * 10.0)
                    : "—";
            }
            nextTextMs = now + 100;
        }
    }

    return { update };
}
