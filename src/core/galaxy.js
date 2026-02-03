// src/core/galaxy.js
// Shared galaxy starfield generation + spatial grid helpers.
// (Used by the fullscreen galaxy overlay; safe place for future galaxy-sim logic.)

/** Deterministic PRNG (fast, good-enough for visuals). */
export function mulberry32(seed) {
    let a = seed | 0;
    return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Stable grid key for (ix, iz). Uses 16-bit packing; collisions are extremely unlikely
 * for the typical visible ranges used in the overlay.
 */
export function galaxyGridKey(ix, iz) {
    return (ix << 16) ^ (iz & 0xffff);
}

/**
 * Generate a 2D galaxy star field in XZ-plane.
 * Returns both the stars and a spatial grid (cell -> indices) for fast picking/drawing.
 */
export function createGalaxyField({
    seed = 133742069,
    radius = 2500000,
    starCount = 2000,
    cell = 25000,
    doubleSpiral = true,
    arms = 4,
    armTightness = 1.3,
    armWidth = 1.3,
    coreBias = -0.5,
    bulgeFraction = 0.175,
    bulgeRadius = 0.2,
    bulgeFlatten = 0.55,
    bulgeRot = 0.35,
} = {}) {
    const stars = [];
    const grid = new Map();
    const rnd = mulberry32(seed >>> 0);

    for (let i = 0; i < starCount; i++) {
        let x, z;

        const inBulge = rnd() < bulgeFraction;

        if (inBulge) {
            // Elliptical Gaussian-ish bulge.
            const u1 = Math.max(1e-6, rnd());
            const u2 = rnd();
            const theta = u2 * Math.PI * 2;

            // "Gaussian" radius via sqrt(-ln(u)).
            const rr = Math.sqrt(-Math.log(u1)) * (radius * bulgeRadius);

            // ellipse axes
            const bx = Math.cos(theta) * rr;
            const bz = Math.sin(theta) * rr * bulgeFlatten;

            // rotate ellipse
            const cs = Math.cos(bulgeRot);
            const sn = Math.sin(bulgeRot);
            x = bx * cs - bz * sn;
            z = bx * sn + bz * cs;
        } else if (doubleSpiral) {
            // Spiral arms.
            const u = rnd();
            const r = Math.sqrt(Math.pow(u, 1.0 - coreBias)) * radius;

            const armIndex = (rnd() * arms) | 0;
            const armBase = (armIndex / arms) * Math.PI * 2;
            const spiralAngle =
                armBase + (r / radius) * armTightness * Math.PI * 2;

            const spread =
                (rnd() - 0.5) * armWidth * (0.35 + 0.65 * (r / radius));
            const a = spiralAngle + spread;

            x = Math.cos(a) * r;
            z = Math.sin(a) * r;

            // Extra clumping along arms.
            const clump = (rnd() - 0.5) * (radius * 0.01);
            x += clump * Math.cos(a * 3.0 + 10.0);
            z += clump * Math.sin(a * 3.0 + 10.0);
        } else {
            // Disk fallback.
            const u = rnd();
            const r = Math.sqrt(Math.pow(u, 1.0 - coreBias)) * radius;
            const a = rnd() * Math.PI * 2;
            x = Math.cos(a) * r;
            z = Math.sin(a) * r;
        }

        // Thin disk fuzz (applies to arms + bulge).
        const jitter = (rnd() - 0.5) * (radius * 0.012);
        x += jitter;
        z += jitter;

        // Spectral-ish color.
        const t = rnd();
        let col = "rgba(255,255,255,";
        if (t < 0.08) col = "rgba(170,200,255,";
        else if (t < 0.25) col = "rgba(210,230,255,";
        else if (t < 0.7) col = "rgba(255,245,230,";
        else col = "rgba(255,210,170,";

        // Brightness: few bright, many dim.
        const mag = Math.pow(rnd(), 3.2);

        const idx = stars.length;
        stars.push({ x, z, col, mag });

        // Spatial grid insert.
        const ix = Math.floor(x / cell);
        const iz = Math.floor(z / cell);
        const k = galaxyGridKey(ix, iz);
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push(idx);
    }

    return {
        stars,
        grid,
        cell,
        seed,
        radius,
        starCount,
    };
}
