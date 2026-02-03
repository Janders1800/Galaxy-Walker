// Throttled HUD updater (writes to msgEl at most every intervalMs and only when text changes).

export function createHudUpdater({ msgEl, intervalMs = 200 } = {}) {
    let nextMs = 0;
    let lastText = "";

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
        if (!msgEl) return;
        if (now < nextMs) return;

        const safeBodies = bodies ?? [];
        const safeMoons = moons ?? [];

        const near = nearestBodyInfo?.(player?.worldPos) ?? { i: -1, d: Infinity };
        const nearName = near?.i >= 0 ? (safeBodies[near.i]?.cfg?.name ?? "none") : "none";

        const activeCount = safeBodies.reduce((s, b) => s + (b?.terrainActive ? 1 : 0), 0);

        const line1 = `Planets: ${safeBodies.length} | Moons: ${safeMoons.length} | Rings: ${ringsCount} | Belt: ${beltOn ? "on" : "off"}`;
        const line2 = player?.mode === "walk" 
            ? `Mode: WALK | On: ${safeBodies[player?.bodyIndex ?? 0]?.cfg?.name ?? "planet"}`
            : `Mode: FLY | Nearest: ${nearName}`;
        const line3 = `Terrain active: ${activeCount}` + (underwater ? ` | Underwater ${(depth01*100).toFixed(0)}%` : ``);

        const text = line1 + "\n" + line2 + "\n" + line3;

        if (text !== lastText) {
            msgEl.textContent = text;
            lastText = text;
        }

        nextMs = now + intervalMs;
    }

    return { update };
}
