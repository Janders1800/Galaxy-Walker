import { THREE } from "../../render/device.js";

////////////////////////////////////////////////////////////////////////////////
// Terrain texture set (optional). If textures are missing, terrain falls back
// to the existing vertex-color biome shading.
//
// Expected files (place in ./assets/):
//   grass.png, rock.png, sand.png, snow.png
////////////////////////////////////////////////////////////////////////////////

let _terrainTexSet = null;

function _loadTerrainTex(url) {
    const t = new THREE.TextureLoader().load(
        url,
        undefined,
        undefined,
        () => {
            /* ignore load error; we'll fall back to vertex colors */
        },
    );
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.flipY = false;
    // Albedo textures
    t.colorSpace = THREE.SRGBColorSpace;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    return t;
}

function getTerrainTexSet() {
    if (_terrainTexSet) return _terrainTexSet;
    // Use import-relative URLs so this works under any dev server base.
    const grassURL = new URL("../../../assets/grass.png", import.meta.url);
    const rockURL = new URL("../../../assets/rock.png", import.meta.url);
    const sandURL = new URL("../../../assets/sand.png", import.meta.url);
    const snowURL = new URL("../../../assets/snow.png", import.meta.url);
    _terrainTexSet = {
        grass: _loadTerrainTex(grassURL.href),
        rock: _loadTerrainTex(rockURL.href),
        sand: _loadTerrainTex(sandURL.href),
        snow: _loadTerrainTex(snowURL.href),
    };
    return _terrainTexSet;
}

// Seeded noise + FBM
////////////////////////////////////////////////////////////////////////////////
function hash3s(x, y, z, seed) {
    let h = (x | 0) ^ seed;
    h = Math.imul(h ^ (y | 0), 0x9e3779b1);
    h = Math.imul(h ^ (z | 0), 0x85ebca77);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
}
const smoothstep = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

function valueNoise3Seeded(px, py, pz, seed) {
    const x0 = Math.floor(px),
        y0 = Math.floor(py),
        z0 = Math.floor(pz);
    const x1 = x0 + 1,
        y1 = y0 + 1,
        z1 = z0 + 1;
    const tx = smoothstep(px - x0),
        ty = smoothstep(py - y0),
        tz = smoothstep(pz - z0);

    const c000 = hash3s(x0, y0, z0, seed),
        c100 = hash3s(x1, y0, z0, seed);
    const c010 = hash3s(x0, y1, z0, seed),
        c110 = hash3s(x1, y1, z0, seed);
    const c001 = hash3s(x0, y0, z1, seed),
        c101 = hash3s(x1, y0, z1, seed);
    const c011 = hash3s(x0, y1, z1, seed),
        c111 = hash3s(x1, y1, z1, seed);

    const x00 = lerp(c000, c100, tx),
        x10 = lerp(c010, c110, tx);
    const x01 = lerp(c001, c101, tx),
        x11 = lerp(c011, c111, tx);
    const y0v = lerp(x00, x10, ty),
        y1v = lerp(x01, x11, ty);
    return lerp(y0v, y1v, tz) * 2 - 1;
}

function fbm3Seeded(
    px,
    py,
    pz,
    seed,
    oct = 5,
    lac = 2.0,
    gain = 0.5,
) {
    let amp = 0.5,
        freq = 1.0,
        sum = 0.0;
    for (let i = 0; i < oct; i++) {
        sum +=
            amp *
            valueNoise3Seeded(
                px * freq,
                py * freq,
                pz * freq,
                seed + i * 1013,
            );
        freq *= lac;
        amp *= gain;
    }
    return sum;
}

////////////////////////////////////////////////////////////////////////////////
// Cube face mapping + cubesphere correction
////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////
// Cube face mapping + cubesphere correction (allocation-free)
////////////////////////////////////////////////////////////////////
const _tmpCube = new Float32Array(3);
const _tmpDir = new Float32Array(3);
const _tmpNrm = new Float32Array(3);

function faceUvToCubeXYZ(face, u, v, out) {
    switch (face) {
        case 0: // +X
            out[0] = 1;
            out[1] = v;
            out[2] = -u;
            break;
        case 1: // -X
            out[0] = -1;
            out[1] = v;
            out[2] = u;
            break;
        case 2: // +Y
            out[0] = u;
            out[1] = 1;
            out[2] = -v;
            break;
        case 3: // -Y
            out[0] = u;
            out[1] = -1;
            out[2] = v;
            break;
        case 4: // +Z
            out[0] = u;
            out[1] = v;
            out[2] = 1;
            break;
        case 5: // -Z
            out[0] = -u;
            out[1] = v;
            out[2] = -1;
            break;
        default:
            out[0] = 0;
            out[1] = 1;
            out[2] = 0;
            break;
    }
    return out;
}

function cubeToCubesphereDirXYZ(x, y, z, out) {
    const x2 = x * x,
        y2 = y * y,
        z2 = z * z;
    const sx = x * Math.sqrt(1 - y2 / 2 - z2 / 2 + (y2 * z2) / 3);
    const sy = y * Math.sqrt(1 - z2 / 2 - x2 / 2 + (z2 * x2) / 3);
    const sz = z * Math.sqrt(1 - x2 / 2 - y2 / 2 + (x2 * y2) / 3);
    const inv = 1 / Math.hypot(sx, sy, sz);
    out[0] = sx * inv;
    out[1] = sy * inv;
    out[2] = sz * inv;
    return out;
}

////////////////////////////////////////////////////////////////////////////////
            // SDF + normal
////////////////////////////////////////////////////////////////////////////////
function makePlanetSdf(radiusAtDir) {
    return (px, py, pz) => {
        const r = Math.hypot(px, py, pz);
        if (r < 1e-6) return -radiusAtDir(0, 1, 0);
        const inv = 1 / r;
        const dx = px * inv,
            dy = py * inv,
            dz = pz * inv;
        return r - radiusAtDir(dx, dy, dz);
    };
}
function sdfNormalXYZ(sdf, px, py, pz, eps, out) {
    const dx = sdf(px + eps, py, pz) - sdf(px - eps, py, pz);
    const dy = sdf(px, py + eps, pz) - sdf(px, py - eps, pz);
    const dz = sdf(px, py, pz + eps) - sdf(px, py, pz - eps);
    let nx = dx,
        ny = dy,
        nz = dz;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-8) {
        out[0] = 0;
        out[1] = 1;
        out[2] = 0;
        return out;
    }
    const inv = 1 / len;
    out[0] = nx * inv;
    out[1] = ny * inv;
    out[2] = nz * inv;
    return out;
}

////////////////////////////////////////////////////////////////////////////////
// Outward winding fix
// Gotta find a better solution
////////////////////////////////////////////////////////////////////////////////
function fixWindingOutward(index, pos) {
    for (let i = 0; i < index.length; i += 3) {
        const ia = index[i],
            ib = index[i + 1],
            ic = index[i + 2];
        const ax = pos[ia * 3],
            ay = pos[ia * 3 + 1],
            az = pos[ia * 3 + 2];
        const bx = pos[ib * 3],
            by = pos[ib * 3 + 1],
            bz = pos[ib * 3 + 2];
        const cx = pos[ic * 3],
            cy = pos[ic * 3 + 1],
            cz = pos[ic * 3 + 2];
        const abx = bx - ax,
            aby = by - ay,
            abz = bz - az;
        const acx = cx - ax,
            acy = cy - ay,
            acz = cz - az;
        const nx = aby * acz - abz * acy;
        const ny = abz * acx - abx * acz;
        const nz = abx * acy - aby * acx;
        const mx = (ax + bx + cx) / 3,
            my = (ay + by + cy) / 3,
            mz = (az + bz + cz) / 3;
        if (nx * mx + ny * my + nz * mz < 0) {
            index[i + 1] = ic;
            index[i + 2] = ib;
        }
    }
}

////////////////////////////////////////////////////////////////////////////////
// Patch geometry + skirts + vertex biome colors
////////////////////////////////////////////////////////////////////////////////
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth01 = (t) => t * t * (3 - 2 * t);
const smoothstep01 = (a, b, x) =>
    smooth01(clamp01((x - a) / (b - a)));
const mix = (a, b, t) => a + (b - a) * t;

// Shared patch index cache (no per-patch index building).
const _patchIndexCache = new Map(); // key: `${N}|${use32?1:0}`
function _flipIndexTris(src) {
    const dst = new src.constructor(src.length);
    dst.set(src);
    for (let i = 0; i < dst.length; i += 3) {
        const b = dst[i + 1];
        dst[i + 1] = dst[i + 2];
        dst[i + 2] = b;
    }
    return dst;
}
function getPatchIndexSet(N, use32) {
    const key = `${N}|${use32 ? 1 : 0}`;
    const cached = _patchIndexCache.get(key);
    if (cached) return cached;

    const vertsPerSide = N + 1;
    const vertCount = vertsPerSide * vertsPerSide;
    const edgeVerts = 4 * vertsPerSide;
    const totalVerts = vertCount + edgeVerts;

    const IndexArray = use32 ? Uint32Array : Uint16Array;

    const quadCount = N * N;
    const mainIdx = new IndexArray(quadCount * 6);
    let ii = 0;
    for (let j = 0; j < N; j++) {
        const row0 = j * vertsPerSide;
        const row1 = (j + 1) * vertsPerSide;
        for (let i = 0; i < N; i++) {
            const a = row0 + i,
                b = row0 + i + 1,
                c = row1 + i,
                d = row1 + i + 1;
            // Same pattern as original (fixed outward via per-face flip).
            mainIdx[ii++] = a;
            mainIdx[ii++] = c;
            mainIdx[ii++] = b;
            mainIdx[ii++] = b;
            mainIdx[ii++] = c;
            mainIdx[ii++] = d;
        }
    }

    const skirtBase = vertCount;
    const topOff = skirtBase;
    const bottomOff = topOff + vertsPerSide;
    const leftOff = bottomOff + vertsPerSide;
    const rightOff = leftOff + vertsPerSide;

    const skirtTriCount = 4 * N * 2;
    const skirtIdx = new IndexArray(skirtTriCount * 3);
    let si = 0;
    function addSkirtStrip(baseGet, skirtGet) {
        for (let t = 0; t < N; t++) {
            const b0 = baseGet(t),
                b1 = baseGet(t + 1);
            const s0 = skirtGet(t),
                s1 = skirtGet(t + 1);
            skirtIdx[si++] = b0;
            skirtIdx[si++] = s0;
            skirtIdx[si++] = b1;
            skirtIdx[si++] = b1;
            skirtIdx[si++] = s0;
            skirtIdx[si++] = s1;
        }
    }
    addSkirtStrip(
        (t) => 0 * vertsPerSide + t,
        (t) => topOff + t,
    );
    addSkirtStrip(
        (t) => N * vertsPerSide + t,
        (t) => bottomOff + t,
    );
    addSkirtStrip(
        (t) => t * vertsPerSide + 0,
        (t) => leftOff + t,
    );
    addSkirtStrip(
        (t) => t * vertsPerSide + N,
        (t) => rightOff + t,
    );

    const out = {
        main: mainIdx,
        skirt: skirtIdx,
        mainFlip: _flipIndexTris(mainIdx),
        skirtFlip: _flipIndexTris(skirtIdx),
        totalVerts,
    };
    _patchIndexCache.set(key, out);
    return out;
}

// Per-face winding decision cache (computed once per face and gridN).
const _faceFlipCache = new Map(); // key N -> Int8Array(6) values: -1 unknown, 0 no flip, 1 flip
function faceNeedsFlip(face, N) {
    let arr = _faceFlipCache.get(N);
    if (!arr) {
        arr = new Int8Array(6);
        arr.fill(-1);
        _faceFlipCache.set(N, arr);
    }
    if (arr[face] !== -1) return arr[face] === 1;

    // Test first triangle on a unit sphere for the root patch [-1..1].
    const du = 2 / N;
    const dv = 2 / N;

    const axu = -1 + du * 0,
        axv = -1 + dv * 0;
    const bxu = -1 + du * 1,
        bxv = -1 + dv * 0;
    const cxu = -1 + du * 0,
        cxv = -1 + dv * 1;

    faceUvToCubeXYZ(face, axu, axv, _tmpCube);
    cubeToCubesphereDirXYZ(_tmpCube[0], _tmpCube[1], _tmpCube[2], _tmpDir);
    const ax = _tmpDir[0],
        ay = _tmpDir[1],
        az = _tmpDir[2];

    faceUvToCubeXYZ(face, cxu, cxv, _tmpCube);
    cubeToCubesphereDirXYZ(_tmpCube[0], _tmpCube[1], _tmpCube[2], _tmpDir);
    const cx = _tmpDir[0],
        cy = _tmpDir[1],
        cz = _tmpDir[2];

    faceUvToCubeXYZ(face, bxu, bxv, _tmpCube);
    cubeToCubesphereDirXYZ(_tmpCube[0], _tmpCube[1], _tmpCube[2], _tmpDir);
    const bx = _tmpDir[0],
        by = _tmpDir[1],
        bz = _tmpDir[2];

    // Triangle uses original order (a, c, b).
    const abx = cx - ax,
        aby = cy - ay,
        abz = cz - az;
    const acx = bx - ax,
        acy = by - ay,
        acz = bz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const mx = (ax + bx + cx) / 3;
    const my = (ay + by + cy) / 3;
    const mz = (az + bz + cz) / 3;

    const flip = nx * mx + ny * my + nz * mz < 0;
    arr[face] = flip ? 1 : 0;
    return flip;
}

function buildPatchGeometry({
    face,
    u0,
    v0,
    u1,
    v1,
    gridN,
    radiusAtDir,
    sdf,
    normalEps,
    skirtDepth,
    baseRadius,
    seaLevel,
    heightAmp,
    biome,
}) {
    const N = gridN;
    const vertsPerSide = N + 1;
    const vertCount = vertsPerSide * vertsPerSide;

    const edgeVerts = 4 * vertsPerSide;
    const skirtBase = vertCount;
    const totalVerts = vertCount + edgeVerts;

    const pos2 = new Float32Array(totalVerts * 3);
    const nrm2 = new Float32Array(totalVerts * 3);
    const col2 = new Float32Array(totalVerts * 3);

    const C = biome;
    const deepW = C.deepWater,
        shallowW = C.shallowWater,
        sand = C.sand,
        grass = C.grass,
        rock = C.rock,
        snow = C.snow;

    // Fill base grid vertices directly into pos2/nrm2/col2 (no intermediate buffers).
    let k = 0;
    const du = (u1 - u0) / N;
    const dv = (v1 - v0) / N;

    for (let j = 0; j <= N; j++) {
        const v = v0 + dv * j;
        for (let i = 0; i <= N; i++) {
            const u = u0 + du * i;

            faceUvToCubeXYZ(face, u, v, _tmpCube);
            cubeToCubesphereDirXYZ(
                _tmpCube[0],
                _tmpCube[1],
                _tmpCube[2],
                _tmpDir,
            );
            const dx = _tmpDir[0],
                dy = _tmpDir[1],
                dz = _tmpDir[2];

            const r = radiusAtDir(dx, dy, dz);
            const px = dx * r,
                py = dy * r,
                pz = dz * r;

            pos2[k] = px;
            pos2[k + 1] = py;
            pos2[k + 2] = pz;

            // Smooth normals a bit by blending the SDF normal with the radial direction.
            // This keeps fine height noise from producing harsh faceting, especially at low patch densities.
            sdfNormalXYZ(sdf, px, py, pz, normalEps, _tmpNrm);
            {
                const s = 0.35; // 0 = pure SDF, 1 = pure sphere normal
                let nx = _tmpNrm[0] * (1.0 - s) + dx * s;
                let ny = _tmpNrm[1] * (1.0 - s) + dy * s;
                let nz = _tmpNrm[2] * (1.0 - s) + dz * s;
                const inv = 1.0 / Math.max(1e-8, Math.hypot(nx, ny, nz));
                nrm2[k] = nx * inv;
                nrm2[k + 1] = ny * inv;
                nrm2[k + 2] = nz * inv;
            }

            const height = r - baseRadius;
            const lat = Math.abs(dy);
            const shoreW = C.shoreWidth;
            const aboveSea = r - seaLevel;

            const waterMask =
                1.0 - smoothstep01(-shoreW, +shoreW, aboveSea);

            const shallowT = smoothstep01(
                -shoreW * 1.0,
                -shoreW * 0.15,
                aboveSea,
            );
            const wR = mix(deepW.r, shallowW.r, shallowT);
            const wG = mix(deepW.g, shallowW.g, shallowT);
            const wB = mix(deepW.b, shallowW.b, shallowT);

            const sandT =
                1.0 - smoothstep01(0.0, shoreW * 1.2, aboveSea);
            let lR = mix(grass.r, sand.r, sandT);
            let lG = mix(grass.g, sand.g, sandT);
            let lB = mix(grass.b, sand.b, sandT);

            const rockStart = C.rockStart ?? heightAmp * 0.35;
            const rockEnd =
                rockStart + (C.rockSpan ?? heightAmp * 0.55);
            const rockT = smoothstep01(rockStart, rockEnd, height);
            lR = mix(lR, rock.r, rockT);
            lG = mix(lG, rock.g, rockT);
            lB = mix(lB, rock.b, rockT);

            const snowH = C.snowHeight;
            const snowByHeight = smoothstep01(
                snowH,
                snowH + heightAmp * 0.25,
                height,
            );
            const snowByLat = smoothstep01(C.snowLat, 1.0, lat);
            const snowMask = clamp01(
                snowByHeight * (0.35 + 0.65 * snowByLat),
            );
            lR = mix(lR, snow.r, snowMask);
            lG = mix(lG, snow.g, snowMask);
            lB = mix(lB, snow.b, snowMask);

            col2[k] = mix(lR, wR, waterMask);
            col2[k + 1] = mix(lG, wG, waterMask);
            col2[k + 2] = mix(lB, wB, waterMask);

            k += 3;
        }
    }

    // skirts
    function copySkirtEdge(getIndexFn, outOffsetVert) {
        for (let t = 0; t <= N; t++) {
            const baseIndex = getIndexFn(t);
            const bi3 = baseIndex * 3;
            const oi3 = (outOffsetVert + t) * 3;

            const nx = nrm2[bi3],
                ny = nrm2[bi3 + 1],
                nz = nrm2[bi3 + 2];

            pos2[oi3] = pos2[bi3] - nx * skirtDepth;
            pos2[oi3 + 1] = pos2[bi3 + 1] - ny * skirtDepth;
            pos2[oi3 + 2] = pos2[bi3 + 2] - nz * skirtDepth;

            nrm2[oi3] = nx;
            nrm2[oi3 + 1] = ny;
            nrm2[oi3 + 2] = nz;

            col2[oi3] = col2[bi3];
            col2[oi3 + 1] = col2[bi3 + 1];
            col2[oi3 + 2] = col2[bi3 + 2];
        }
    }

    const topOff = skirtBase;
    const bottomOff = topOff + vertsPerSide;
    const leftOff = bottomOff + vertsPerSide;
    const rightOff = leftOff + vertsPerSide;

    copySkirtEdge((t) => 0 * vertsPerSide + t, topOff);
    copySkirtEdge((t) => N * vertsPerSide + t, bottomOff);
    copySkirtEdge((t) => t * vertsPerSide + 0, leftOff);
    copySkirtEdge((t) => t * vertsPerSide + N, rightOff);

    const use32 = totalVerts > 65535;
    const idxSet = getPatchIndexSet(N, use32);
    const flip = faceNeedsFlip(face, N);
    const mainIdx = flip ? idxSet.mainFlip : idxSet.main;
    const skirtIdx = flip ? idxSet.skirtFlip : idxSet.skirt;

    const makeGeo = (idx) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute(
            "position",
            new THREE.BufferAttribute(pos2, 3),
        );
        geo.setAttribute(
            "normal",
            new THREE.BufferAttribute(nrm2, 3),
        );
        geo.setAttribute(
            "color",
            new THREE.BufferAttribute(col2, 3),
        );
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.computeBoundingSphere();
        return geo;
    };

    return {
        main: makeGeo(mainIdx),
        skirt: makeGeo(skirtIdx),
    };
}

////////////////////////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////////////////////////
// Terrain workers (simple thread pool for patch generation)
////////////////////////////////////////////////////////////////////////////////
const USE_TERRAIN_WORKERS = true;

class TerrainWorkerPool {
    constructor(workerCount) {
        this.workerCount = workerCount | 0;
        this.workers = [];
        this.queue = [];
        this.queueHead = 0;
        this.inFlight = new Map(); // jobId -> { patch, face, gridN }
        this.completed = []; // { patch, jobId, data }
        this.nextJobId = 1;

        this._bodies = new Map(); // bodyId -> { bodyCfg, biome }

        for (let i = 0; i < this.workerCount; i++) {
            const w = new Worker(
                new URL("../../workers/terrainWorker.js", import.meta.url),
                { type: "module" },
            );
            const rec = { w, busy: false };
            w.onmessage = (e) => this._onMessage(rec, e);
            w.onerror = (e) => {
                console.error("TerrainWorker error:", e?.message || e);
                rec.busy = false;
            };
            this.workers.push(rec);
        }
    }

    initBody(bodyId, bodyCfg, biome) {
        this._bodies.set(bodyId | 0, { bodyCfg, biome });
        for (const rec of this.workers) {
            rec.w.postMessage({ type: "initBody", bodyId: bodyId | 0, bodyCfg, biome });
        }
    }

    request(patch, params) {
        const id = this.nextJobId++;
        this.queue.push({ id, patch, params });
        this._dispatch();
        return id;
    }

    _dispatch() {
        for (const rec of this.workers) {
            if (rec.busy) continue;
            const job = this.queue[this.queueHead];
            if (job) this.queueHead++;
            // Periodically compact the queue to avoid unbounded growth.
            if (this.queueHead > 1024 && this.queueHead * 2 > this.queue.length) {
                this.queue = this.queue.slice(this.queueHead);
                this.queueHead = 0;
            }
            if (!job) return;

            rec.busy = true;
            this.inFlight.set(job.id, { patch: job.patch });

            // Worker expects: { type:"build", id, params }
            rec.w.postMessage({ type: "build", id: job.id, params: job.params });
        }
    }

    _onMessage(rec, e) {
        const msg = e.data;
        if (!msg || !msg.type) return;

        if (msg.type === "result") {
            const infl = this.inFlight.get(msg.id);
            this.inFlight.delete(msg.id);
            rec.busy = false;
            if (infl && infl.patch) {
                this.completed.push({ patch: infl.patch, jobId: msg.id, data: msg });
            }
            this._dispatch();
            return;
        }

        if (msg.type === "error") {
            console.error("TerrainWorker job error:", msg.error);
            const infl = this.inFlight.get(msg.id);
            this.inFlight.delete(msg.id);
            rec.busy = false;
            if (infl && infl.patch) infl.patch._terrainWorkerFail?.(msg.id);
            this._dispatch();
            return;
        }
    }

    pumpCompleted() {
        if (this.completed.length === 0) return;
        const list = this.completed;
        this.completed = [];
        for (const item of list) {
            item.patch?._applyTerrainWorkerResult?.(item.jobId, item.data);
        }
    }
}

const TERRAIN_WORKER_COUNT = USE_TERRAIN_WORKERS
    ? Math.max(1, ((navigator.hardwareConcurrency || 4) | 0) - 1)
    : 0;
export const terrainPool = TERRAIN_WORKER_COUNT > 0 ? new TerrainWorkerPool(TERRAIN_WORKER_COUNT) : null;

let _nextBodyId = 1;

// Patch node
////////////////////////////////////////////////////////////////////////////////
class PatchNode {
    constructor(body, face, level, u0, v0, u1, v1) {
        this.body = body;
        this.face = face;
        this.level = level;
        this.u0 = u0;
        this.v0 = v0;
        this.u1 = u1;
        this.v1 = v1;
        this.children = null;
        this.meshMain = null;
        this.meshSkirt = null;
        this._genPending = false;
        this._pendingJobId = 0;
        this._splitInProgress = false;
        this._mergeInProgress = false;
        this.boundCenter = new THREE.Vector3();
        this.boundRadius = 1;
        this._tmpWorldCenter = new THREE.Vector3();
        this.computeBounds();
    }
    centerLocal(out) {
        const u = (this.u0 + this.u1) * 0.5;
        const v = (this.v0 + this.v1) * 0.5;
        faceUvToCubeXYZ(this.face, u, v, _tmpCube);
        cubeToCubesphereDirXYZ(
            _tmpCube[0],
            _tmpCube[1],
            _tmpCube[2],
            _tmpDir,
        );
        const r = this.body.radiusAtDir(_tmpDir[0], _tmpDir[1], _tmpDir[2]);
        out.set(_tmpDir[0] * r, _tmpDir[1] * r, _tmpDir[2] * r);
        return out;
    }
    computeBounds() {
        this.centerLocal(this.boundCenter);
        const baseR = this.body.cfg.baseRadius ?? 1400;
        const patchSpan = 2 / (1 << this.level);
        const approxEdgeLen = baseR * patchSpan;
        const extra =
            (this.body.heightAmp ?? 0) +
            this.body.skirtDepthForLevel(this.level);
        this.boundRadius = approxEdgeLen * 0.85 + extra;
    }


hasMesh() {
    return !!(this.meshMain && this.meshSkirt);
}
childrenReady() {
    return !!(
        this.children &&
        this.children.length === 4 &&
        this.children.every((c) => c.hasMesh())
    );
}

// Async-safe split/merge transitions:
// - split: keep parent mesh until all children are ready, then drop parent.
// - merge: keep children until parent mesh is ready, then drop children.
requestSplit() {
        if (this.children) return;

        // Ensure we have some coverage while children are generating.
        this.ensureMesh();
    const um = (this.u0 + this.u1) * 0.5,
        vm = (this.v0 + this.v1) * 0.5;
    const L = this.level + 1,
        f = this.face;

    this.children = [
        new PatchNode(this.body, f, L, this.u0, this.v0, um, vm),
        new PatchNode(this.body, f, L, um, this.v0, this.u1, vm),
        new PatchNode(this.body, f, L, this.u0, vm, um, this.v1),
        new PatchNode(this.body, f, L, um, vm, this.u1, this.v1),
    ];

    this._splitInProgress = true;

    // Start generating children, but keep parent mesh until they're ready.
    for (const c of this.children) c.ensureMesh();
}

_finalizeSplitIfReady() {
    if (!this._splitInProgress) return;
    if (!this.childrenReady()) return;

    // Children are ready; now it is safe to drop the parent mesh.
    this.disposeMesh();
    this._splitInProgress = false;
}

requestMerge() {
    if (!this.children) return;

    // If we still have the parent mesh (e.g. mid-split), we can merge immediately.
    if (this.hasMesh()) {
        for (const c of this.children) c.destroy(true);
        this.children = null;
        this._splitInProgress = false;
        this._mergeInProgress = false;
        return;
    }

    this._mergeInProgress = true;

    // Start generating parent, but keep children until parent is ready.
    this.ensureMesh();
}

_finalizeMergeIfReady() {
    if (!this._mergeInProgress) return;
    if (!this.hasMesh()) return;

    // Parent is ready; now it is safe to drop children.
    if (this.children) for (const c of this.children) c.destroy(true);
    this.children = null;
    this._mergeInProgress = false;
}

    ensureMesh() {
        if (this.meshMain || this.meshSkirt) return;
        if (this._genPending) return;

        const b = this.body;

        // Worker path: build typed arrays off the main thread, then apply them in the main loop.
        if (terrainPool && b?.bodyId) {
            this._genPending = true;
            this._pendingJobId = terrainPool.request(this, {
                bodyId: b.bodyId | 0,
                face: this.face | 0,
                u0: this.u0,
                v0: this.v0,
                u1: this.u1,
                v1: this.v1,
                gridN: b.patchGridN | 0,
                normalEps: b.normalEpsForLevel(this.level),
                skirtDepth: b.skirtDepthForLevel(this.level),
            });
            return;
        }

        // Synchronous fallback (original code path)
        const geos = buildPatchGeometry({
            face: this.face,
            u0: this.u0,
            v0: this.v0,
            u1: this.u1,
            v1: this.v1,
            gridN: b.patchGridN,
            radiusAtDir: b.radiusAtDir,
            sdf: b.sdf,
            normalEps: b.normalEpsForLevel(this.level),
            skirtDepth: b.skirtDepthForLevel(this.level),
            baseRadius: b.baseRadius,
            seaLevel: b.seaLevel,
            heightAmp: b.heightAmp,
            biome: b.biome,
        });

        // Main terrain surface: casts + receives shadows
        this.meshMain = new THREE.Mesh(geos.main, b.terrainMat);
        this.meshMain.castShadow = true;
        this.meshMain.receiveShadow = true;
        b.terrain.add(this.meshMain);

        // Skirts: render to hide cracks, but DO NOT cast shadows (prevents shadow pollution)
        this.meshSkirt = new THREE.Mesh(geos.skirt, b.terrainMat);
        this.meshSkirt.castShadow = false;
        this.meshSkirt.receiveShadow = true;
        b.terrain.add(this.meshSkirt);
    }

    _terrainWorkerFail(jobId) {
        if ((jobId | 0) !== (this._pendingJobId | 0)) return;
        this._pendingJobId = 0;
        this._genPending = false;
    }

    _applyTerrainWorkerResult(jobId, msg) {
        if ((jobId | 0) !== (this._pendingJobId | 0)) return;

        this._pendingJobId = 0;
        this._genPending = false;

        // Patch may have been destroyed while the worker was running.
        if (this.meshMain || this.meshSkirt) return;

        const b = this.body;
        if (!b) return;

        const N = (msg.gridN | 0);
        const pos2 = msg.pos;
        const nrm2 = msg.nrm;
        const col2 = msg.col;

        const vertsPerSide = N + 1;
        const vertCount = vertsPerSide * vertsPerSide;
        const edgeVerts = 4 * vertsPerSide;
        const totalVerts = vertCount + edgeVerts;

        if (!pos2 || !nrm2 || !col2) return;
        if (pos2.length !== totalVerts * 3) return;

        const use32 = totalVerts > 65535;
        const idxSet = getPatchIndexSet(N, use32);
        const flip = faceNeedsFlip(this.face, N);
        const mainIdx = flip ? idxSet.mainFlip : idxSet.main;
        const skirtIdx = flip ? idxSet.skirtFlip : idxSet.skirt;

        const makeGeo = (idx) => {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute(
                "position",
                new THREE.BufferAttribute(pos2, 3),
            );
            geo.setAttribute(
                "normal",
                new THREE.BufferAttribute(nrm2, 3),
            );
            geo.setAttribute(
                "color",
                new THREE.BufferAttribute(col2, 3),
            );
            geo.setIndex(new THREE.BufferAttribute(idx, 1));
            geo.computeBoundingSphere();
            return geo;
        };

        const geoMain = makeGeo(mainIdx);
        const geoSkirt = makeGeo(skirtIdx);

        this.meshMain = new THREE.Mesh(geoMain, b.terrainMat);
        this.meshMain.castShadow = true;
        this.meshMain.receiveShadow = true;
        b.terrain.add(this.meshMain);

        this.meshSkirt = new THREE.Mesh(geoSkirt, b.terrainMat);
        this.meshSkirt.castShadow = false;
        this.meshSkirt.receiveShadow = true;
        b.terrain.add(this.meshSkirt);
    }


    disposeMesh() {
        this._genPending = false;
        this._pendingJobId = 0;
        if (this.meshMain) {
            this.meshMain.geometry.dispose();
            this.body.terrain.remove(this.meshMain);
            this.meshMain = null;
        }
        if (this.meshSkirt) {
            this.meshSkirt.geometry.dispose();
            this.body.terrain.remove(this.meshSkirt);
            this.meshSkirt = null;
        }
    }
    split() {
        this.requestSplit();
        this._finalizeSplitIfReady();
    }
    merge() {
        this.requestMerge();
        this._finalizeMergeIfReady();
    }
    destroy(recursive = false) {
        this._splitInProgress = false;
        this._mergeInProgress = false;
        if (recursive && this.children)
            for (const c of this.children) c.destroy(true);
        this.children = null;
        this.disposeMesh();
    }
}

////////////////////////////////////////////////////////////////////////////////
// QuadSphere body
////////////////////////////////////////////////////////////////////////////////
export class QuadSphereBody {
    constructor(cfg) {
        this.cfg = cfg;
        this.bodyId = _nextBodyId++;
        this.group = new THREE.Group();

        this.phase = cfg.phase ?? Math.random() * Math.PI * 2;
        this.spinSpeed = (Math.PI * 2) / (cfg.dayLength ?? 1400);

        this.terrain = new THREE.Group();
        this.group.add(this.terrain);

        const seed = (cfg.seed ?? 101010) | 0;
        const baseRadius = cfg.baseRadius ?? 1400;
        const heightAmp = cfg.heightAmp ?? 170;
        const heightFreq = cfg.heightFreq ?? 2.0;

        this.baseRadius = baseRadius;
        this.heightAmp = heightAmp;

        this.seaLevelOffset = cfg.seaLevelOffset ?? 0;

        // Optional features (moons can disable ocean/atmosphere)
        this.hasOcean = cfg.hasOcean !== false; // default true
        this.hasAtmo = cfg.hasAtmo !== false; // default true

        this.seaLevel = this.hasOcean
            ? baseRadius + this.seaLevelOffset
            : -1e9; // effectively "no ocean"

        this.biome = {
            seaLevel: this.seaLevel,
            shoreWidth: cfg.shoreWidth ?? 20.0,
            snowHeight: cfg.snowHeight ?? heightAmp * 0.55,
            snowLat: cfg.snowLat ?? 0.55,
            rockStart: cfg.rockStart ?? heightAmp * 0.35,
            rockSpan: cfg.rockSpan ?? heightAmp * 0.55,
            deepWater: new THREE.Color(cfg.deepWater ?? 0x061a2a),
            shallowWater: new THREE.Color(
                cfg.shallowWater ?? 0x1f5568,
            ),
            sand: new THREE.Color(cfg.sand ?? 0xd9c38a),
            grass: new THREE.Color(cfg.grass ?? 0x2f6b34),
            rock: new THREE.Color(cfg.rock ?? 0x666666),
            snow: new THREE.Color(cfg.snow ?? 0xf7fbff),
        };

        // Send the minimal, cloneable terrain config to worker threads once per body.
        if (terrainPool) {
            const C = this.biome;
            const biomeSend = {
                seaLevel: this.seaLevel,
                shoreWidth: C.shoreWidth,
                snowHeight: C.snowHeight,
                snowLat: C.snowLat,
                rockStart: C.rockStart,
                rockSpan: C.rockSpan,
                deepWater: { r: C.deepWater.r, g: C.deepWater.g, b: C.deepWater.b },
                shallowWater: { r: C.shallowWater.r, g: C.shallowWater.g, b: C.shallowWater.b },
                sand: { r: C.sand.r, g: C.sand.g, b: C.sand.b },
                grass: { r: C.grass.r, g: C.grass.g, b: C.grass.b },
                rock: { r: C.rock.r, g: C.rock.g, b: C.rock.b },
                snow: { r: C.snow.r, g: C.snow.g, b: C.snow.b },
            };
            const cfgSend = {
                seed: (cfg.seed ?? 101010) | 0,
                baseRadius: this.baseRadius,
                heightAmp: this.heightAmp,
                heightFreq: cfg.heightFreq ?? 2.0,
                seaLevel: this.seaLevel,
                seabedDepth: (cfg.seabedDepth ?? this.heightAmp * 0.2),
            };
            terrainPool.initBody(this.bodyId, cfgSend, biomeSend);
        }


        this.terrainMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            roughness: 0.98,
            metalness: 0.0,
            side: THREE.FrontSide,
        });

        // Triplanar stochastic texture detail (optional) + micro-variation.
        // If the textures are not present in ./assets, the terrain will still render
        // using the existing vertex-color biome shading (texture contribution will
        // simply be very dark/neutral until the textures load).
        const texSet = getTerrainTexSet();
        this.terrainMat.onBeforeCompile = (shader) => {
            // ---- uniforms ----
            shader.uniforms.uTexGrass = { value: texSet.grass };
            shader.uniforms.uTexRock = { value: texSet.rock };
            shader.uniforms.uTexSand = { value: texSet.sand };
            shader.uniforms.uTexSnow = { value: texSet.snow };

            // Texture scale in "planet local" units; tune per-planet if desired.
            shader.uniforms.uTriScale = { value: this.cfg.triTexScale ?? 0.02 };
            // How much the stochastic offsets perturb the UVs (0..1-ish).
            shader.uniforms.uStochAmp = { value: this.cfg.triStochAmp ?? 0.35 };
            // Texture detail strength (0 = pure biome vertex colors, 1 = full texture modulation).
            shader.uniforms.uBiomeTint = { value: this.cfg.triBiomeTint ?? 1.0 };

            // Biome thresholds (match worker shading so texture blends follow the same rules)
            shader.uniforms.uBaseRadius = { value: this.baseRadius };
            shader.uniforms.uSeaLevel = { value: this.seaLevel };
            shader.uniforms.uHeightAmp = { value: this.heightAmp };
            shader.uniforms.uShoreWidth = { value: this.biome.shoreWidth };
            shader.uniforms.uRockStart = { value: this.biome.rockStart };
            shader.uniforms.uRockEnd = {
                value:
                    (this.biome.rockStart ?? this.heightAmp * 0.35) +
                    (this.biome.rockSpan ?? this.heightAmp * 0.55),
            };
            shader.uniforms.uSnowHeight = { value: this.biome.snowHeight };
            shader.uniforms.uSnowLat = { value: this.biome.snowLat };

            // ---- varyings ----
            shader.vertexShader = shader.vertexShader.replace(
                "#include <common>",
                `#include <common>\nvarying vec3 vPosObj;\nvarying vec3 vNrmObj;\nvarying vec3 vWorldPos;`,
            );
            shader.vertexShader = shader.vertexShader.replace(
                "#include <begin_vertex>",
                `#include <begin_vertex>\nvPosObj = position;\nvNrmObj = normal;\nvWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;`,
            );

            shader.fragmentShader = shader.fragmentShader.replace(
                "#include <common>",
                `#include <common>
varying vec3 vPosObj;
varying vec3 vNrmObj;
varying vec3 vWorldPos;

uniform sampler2D uTexGrass;
uniform sampler2D uTexRock;
uniform sampler2D uTexSand;
uniform sampler2D uTexSnow;
uniform float uTriScale;
uniform float uStochAmp;
uniform float uBiomeTint;

uniform float uBaseRadius;
uniform float uSeaLevel;
uniform float uHeightAmp;
uniform float uShoreWidth;
uniform float uRockStart;
uniform float uRockEnd;
uniform float uSnowHeight;
uniform float uSnowLat;

float clamp01(float x){ return clamp(x, 0.0, 1.0); }
float smooth01(float t){ return t*t*(3.0 - 2.0*t); }
float smoothstep01(float a, float b, float x){ return smooth01(clamp01((x - a) / (b - a))); }

float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p){
  float n = hash12(p);
  return vec2(n, hash12(p + n + 19.19));
}
// existing micro-variation
float hash13(vec3 p){p=fract(p*0.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);} 

// Stochastic texture sampling (seamless across cells):
// random per-cell offsets blended bilinearly.
vec4 stochSample(sampler2D tex, vec2 uv){
  vec2 i = floor(uv);
  vec2 f = fract(uv);
  vec2 u = f*f*(3.0 - 2.0*f);

  // Offsets in [-0.5..0.5], scaled by amplitude
  vec2 o00 = (hash22(i + vec2(0.0,0.0)) - 0.5) * uStochAmp;
  vec2 o10 = (hash22(i + vec2(1.0,0.0)) - 0.5) * uStochAmp;
  vec2 o01 = (hash22(i + vec2(0.0,1.0)) - 0.5) * uStochAmp;
  vec2 o11 = (hash22(i + vec2(1.0,1.0)) - 0.5) * uStochAmp;

  vec4 c00 = texture2D(tex, uv + o00);
  vec4 c10 = texture2D(tex, uv + o10);
  vec4 c01 = texture2D(tex, uv + o01);
  vec4 c11 = texture2D(tex, uv + o11);
  return mix(mix(c00, c10, u.x), mix(c01, c11, u.x), u.y);
}

vec3 triplanarStoch(sampler2D tex, vec3 p, vec3 n){
  vec3 an = abs(n);
  vec3 w = pow(an, vec3(8.0));
  w /= max(1e-5, (w.x + w.y + w.z));

  vec2 uvX = p.zy * uTriScale; // X axis projection
  vec2 uvY = p.xz * uTriScale; // Y axis projection
  vec2 uvZ = p.xy * uTriScale; // Z axis projection

  vec3 cx = stochSample(tex, uvX).rgb;
  vec3 cy = stochSample(tex, uvY).rgb;
  vec3 cz = stochSample(tex, uvZ).rgb;
  return cx * w.x + cy * w.y + cz * w.z;
}
`,
            );

            // Inject after vertex-color biome is applied.
            shader.fragmentShader = shader.fragmentShader.replace(
                "#include <color_fragment>",
                `#include <color_fragment>
// --- triplanar stochastic detail ---
vec3 baseTint = diffuseColor.rgb;

// Compute the same biome masks as the worker so we pick the right texture family.
float r = length(vPosObj);
float height = r - uBaseRadius;
vec3 dir = normalize(vPosObj);
float lat = abs(dir.y);
float aboveSea = r - uSeaLevel;

float shoreW = uShoreWidth;
float waterMask = 1.0 - smoothstep01(-shoreW, +shoreW, aboveSea);

float sandT = 1.0 - smoothstep01(0.0, shoreW * 1.2, aboveSea);
float rockT = smoothstep01(uRockStart, uRockEnd, height);
float snowByHeight = smoothstep01(uSnowHeight, uSnowHeight + uHeightAmp * 0.25, height);
float snowByLat = smoothstep01(uSnowLat, 1.0, lat);
float snowMask = clamp01(snowByHeight * (0.35 + 0.65 * snowByLat));

vec3 nObj = normalize(vNrmObj);
vec3 tGrass = triplanarStoch(uTexGrass, vPosObj, nObj);
vec3 tSand  = triplanarStoch(uTexSand,  vPosObj, nObj);
vec3 tRock  = triplanarStoch(uTexRock,  vPosObj, nObj);
vec3 tSnow  = triplanarStoch(uTexSnow,  vPosObj, nObj);

// Match the worker's mixing order.
vec3 landTex = mix(tGrass, tSand, sandT);
landTex = mix(landTex, tRock, rockT);
landTex = mix(landTex, tSnow, snowMask);

	// Textures are authored to be tinted by the biome/random colors.
	// Keep biome hue *predominant*: use the texture mostly as luminance/detail modulation.
	float texLum = dot(landTex, vec3(0.299, 0.587, 0.114));
	float detail = mix(0.70, 1.30, texLum); // 0.70..1.30

	// Aggressively boost biome/random tint saturation + brightness.
	float tintLum = dot(baseTint, vec3(0.333333));
	vec3 tint = clamp(mix(vec3(tintLum), baseTint, 2.8) * 1.55, 0.0, 1.0);

	// uBiomeTint acts as "detail strength": 0 = pure vertex color, 1 = full texture modulation.
	vec3 landCol = tint * mix(vec3(1.0), vec3(detail), uBiomeTint);

// Keep underwater/shore coloring as-is (vertex colors), since ocean surface is separate.
diffuseColor.rgb = mix(landCol, baseTint, waterMask);

// micro-variation (keeps the old subtle breakup)
float n = hash13(vWorldPos * 0.015);
diffuseColor.rgb *= (0.92 + 0.16 * n);
`,
            );
        };
        this.terrainMat.needsUpdate = true;

        // ocean waves material
        const oceanMat = new THREE.MeshPhysicalMaterial({
            color: cfg.oceanColor ?? 0x0b2a45,
            roughness: 0.05,
            metalness: 0.0,
            transmission: 0.06,
            thickness: 0.6,
            transparent: true,
            opacity: 0.84,
            side: THREE.DoubleSide,
        });

        // Per-ocean occluder buffers (can’t be shared across bodies like atmo passes).
        // Matches the atmosphere eclipse cap (24).
        this._oceanOccCenters = new Float32Array(24 * 3);
        this._oceanOccRadii = new Float32Array(24);

        oceanMat.onBeforeCompile = (shader) => {
            shader.uniforms.uTime = { value: 0 };
            shader.uniforms.uWaveAmp = {
                value: cfg.waveAmp ?? 2.6,
            };
            shader.uniforms.uWaveFreq = {
                value: cfg.waveFreq ?? 0.014,
            };
            shader.uniforms.uWaveSpeed = {
                value: cfg.waveSpeed ?? 0.65,
            };
            shader.uniforms.uMurk = {
                value: cfg.oceanMurk ?? 0.55,
            };

            shader.uniforms.uPlanetCenterW = {
                value: new THREE.Vector3(),
            };
            shader.uniforms.uSunPosW = {
                value: new THREE.Vector3(),
            };
            shader.uniforms.uNightDarken = { value: 3.2 };
            shader.uniforms.uMinLight = { value: 0.02 };

            // Eclipse occluders (same interface as atmospheres)
            shader.uniforms.uOccCount = { value: 0 };
            shader.uniforms.uOccCenters = {
                value: this._oceanOccCenters,
            };
            shader.uniforms.uOccRadii = {
                value: this._oceanOccRadii,
            };
            shader.uniforms.uEclipseSoftness = { value: 0.015 };
            shader.uniforms.uEclipseStrength = { value: 1.0 };

            shader.vertexShader = shader.vertexShader.replace(
                "#include <common>",
                `#include <common>
uniform float uTime;
uniform float uWaveAmp;
uniform float uWaveFreq;
uniform float uWaveSpeed;

varying vec3 vWorldPos;
varying vec3 vWavyNormal;

float waveFn(vec3 p){
  float t = uTime * uWaveSpeed;
  float w1 = sin((p.x + p.z) * uWaveFreq + t);
  float w2 = sin((p.x*0.7 - p.z*1.3) * (uWaveFreq*1.7) + t*1.35);
  float w3 = sin((p.x*1.9 + p.z*0.6) * (uWaveFreq*2.3) + t*1.9);
  return (w1*0.55 + w2*0.30 + w3*0.15);
}`,
            );

            shader.vertexShader = shader.vertexShader.replace(
                "#include <begin_vertex>",
                `#include <begin_vertex>
vec3 wp0 = (modelMatrix * vec4(position, 1.0)).xyz;
float h = waveFn(wp0);

transformed += normalize(position) * (h * uWaveAmp);

vec3 wp = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWorldPos = wp;

vec3 dx = vec3(1.0, 0.0, 0.0);
vec3 dz = vec3(0.0, 0.0, 1.0);
float hx = waveFn(wp + dx*35.0) - waveFn(wp - dx*35.0);
float hz = waveFn(wp + dz*35.0) - waveFn(wp - dz*35.0);

vec3 n = normalize(normalMatrix * normal);
vWavyNormal = normalize(n + vec3(-hx, 0.0, -hz) * 0.18);`,
            );

            shader.fragmentShader = shader.fragmentShader.replace(
                "#include <common>",
                `#include <common>
	uniform float uTime;
	uniform float uMurk;

	uniform vec3 uPlanetCenterW;
	uniform vec3 uSunPosW;
		uniform float uNightDarken;
		uniform float uMinLight;

	uniform int   uOccCount;
	uniform vec3  uOccCenters[24];
	uniform float uOccRadii[24];
	uniform float uEclipseSoftness;
	uniform float uEclipseStrength;

		float gNightMask;
		float gEclipseDim;

	float raySphereHit(vec3 ro, vec3 rd, vec3 c, float r){
	  vec3 oc = ro - c;
	  float b = dot(oc, rd);
	  float c0 = dot(oc, oc) - r*r;
	  float h = b*b - c0;
	  if(h < 0.0) return 1e9;
	  h = sqrt(h);
	  float t0 = -b - h;
	  float t1 = -b + h;
	  if(t0 > 0.0) return t0;
	  if(t1 > 0.0) return t1;
	  return 1e9;
	}

	float sunVisibility(vec3 pW, vec3 sunPosW){
	  vec3 rd = normalize(sunPosW - pW);
	  float maxT = length(sunPosW - pW);
	  float vis = 1.0;
	  for(int i=0; i<24; i++){
	    if(i >= uOccCount) break;
	    float tHit = raySphereHit(pW, rd, uOccCenters[i], uOccRadii[i]);
	    if(tHit < maxT){
	      vec3 oc = pW - uOccCenters[i];
	      float b = dot(oc, rd);
	      float d2 = dot(oc, oc) - b*b;
	      float d = sqrt(max(d2, 0.0));
	      float r = uOccRadii[i];
	      // Soft penumbra: transition on both sides of the geometric edge.
	      float w = r * uEclipseSoftness;
	      float edge = smoothstep(r - w, r + w, d);
	      vis = min(vis, edge);
	    }
	  }
	  return mix(1.0, vis, clamp(uEclipseStrength, 0.0, 1.0));
	}

	varying vec3 vWorldPos;
	varying vec3 vWavyNormal;`,
            );

            shader.fragmentShader = shader.fragmentShader.replace(
                "#include <color_fragment>",
                `#include <color_fragment>
	vec3 sunDir = normalize(uSunPosW - uPlanetCenterW);
	vec3 upP = normalize(vWorldPos - uPlanetCenterW);
	// True sun-facing term (-1..1). Use this to gate eclipse effects to the day hemisphere.
	float ndl = dot(upP, sunDir);
	float day = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
	float nightMask = mix(uMinLight, 1.0, pow(day, uNightDarken));

	// Eclipse dim (matches atmosphere behavior)
	float vis = sunVisibility(vWorldPos, uSunPosW);
	float eclipseDim = mix(1.0, 0.45, 1.0 - vis);

	// Only apply eclipse dimming to the sun-facing hemisphere.
	// (Otherwise it incorrectly darkens the already-dark night side.)
	// IMPORTANT: gate by N·L so the eclipse never affects the night hemisphere.
	float daySide = smoothstep(0.0, 0.25, ndl);
	float eclipseDimDay = mix(1.0, eclipseDim, daySide);

	nightMask *= eclipseDimDay;
	// Keep the direct-light eclipse dim separate (direct light is already ~0 at night).
	gEclipseDim = eclipseDim;

	gNightMask = nightMask;
	diffuseColor.rgb *= nightMask;`,
            );

            shader.fragmentShader = shader.fragmentShader.replace(
                "#include <lights_fragment_begin>",
                `#include <lights_fragment_begin>
	vec3 V = normalize(cameraPosition - vWorldPos);
	float fres = pow(1.0 - max(dot(normalize(vWavyNormal), V), 0.0), 3.0);

	vec3 murkCol = vec3(0.03, 0.10, 0.14);
	diffuseColor.rgb = mix(diffuseColor.rgb, murkCol, uMurk);
	// Keep the rim/glint from blowing out at night or during eclipses
	diffuseColor.rgb += fres * 0.16 * gNightMask;`,
            );

            // Dim direct sunlight on the ocean during eclipses (affects specular too).
            shader.fragmentShader = shader.fragmentShader.replace(
                "#include <lights_fragment_end>",
                `#include <lights_fragment_end>
	reflectedLight.directDiffuse *= gEclipseDim;
	reflectedLight.directSpecular *= gEclipseDim;`,
            );

            oceanMat.userData.shader = shader;
        };

        if (this.hasOcean) {
            this.ocean = new THREE.Mesh(
                new THREE.SphereGeometry(this.seaLevel, 72, 36),
                oceanMat,
            );
            this.ocean.receiveShadow = true;
            this.ocean.castShadow = false;
            this.group.add(this.ocean);
        } else {
            this.ocean = null;
        }

        const seabedDepth = cfg.seabedDepth ?? heightAmp * 0.2;

        this.radiusAtDir = (dx, dy, dz) => {
            const h = fbm3Seeded(
                dx * heightFreq,
                dy * heightFreq,
                dz * heightFreq,
                seed + 17,
                5,
                2.1,
                0.52,
            );
            const raw = baseRadius + heightAmp * h;
            return Math.max(raw, this.seaLevel - seabedDepth);
        };

        this.sdf = makePlanetSdf(this.radiusAtDir);

        // Far mesh (cheap LOD): low-poly displaced + vertex biome colors.
        // This prevents distant moons from looking like flat grey spheres.
        const farGeo = new THREE.IcosahedronGeometry(
            baseRadius,
            cfg.farDetail ?? 2,
        );
        {
            const posAttr = farGeo.getAttribute("position");
            const pos = posAttr.array;
            const col = new Float32Array(posAttr.count * 3);

            const C = this.biome;
            const deepW = C.deepWater,
                shallowW = C.shallowWater,
                sand = C.sand,
                grass = C.grass,
                rock = C.rock,
                snow = C.snow;

            for (let vi = 0; vi < posAttr.count; vi++) {
                const i3 = vi * 3;
                let dx = pos[i3],
                    dy = pos[i3 + 1],
                    dz = pos[i3 + 2];
                const invLen =
                    1.0 / Math.max(1e-8, Math.hypot(dx, dy, dz));
                dx *= invLen;
                dy *= invLen;
                dz *= invLen;

                const r = this.radiusAtDir(dx, dy, dz);
                pos[i3] = dx * r;
                pos[i3 + 1] = dy * r;
                pos[i3 + 2] = dz * r;

                const height = r - baseRadius;
                const lat = Math.abs(dy);
                const shoreW = C.shoreWidth;
                const aboveSea = r - this.seaLevel;

                const waterMask =
                    1.0 - smoothstep01(-shoreW, +shoreW, aboveSea);

                const shallowT = smoothstep01(
                    -shoreW * 1.0,
                    -shoreW * 0.15,
                    aboveSea,
                );
                let wR = mix(deepW.r, shallowW.r, shallowT);
                let wG = mix(deepW.g, shallowW.g, shallowT);
                let wB = mix(deepW.b, shallowW.b, shallowT);

                const sandT =
                    1.0 - smoothstep01(0.0, shoreW * 1.2, aboveSea);
                let lR = mix(grass.r, sand.r, sandT);
                let lG = mix(grass.g, sand.g, sandT);
                let lB = mix(grass.b, sand.b, sandT);

                const rockStart = C.rockStart ?? heightAmp * 0.35;
                const rockEnd =
                    rockStart + (C.rockSpan ?? heightAmp * 0.55);
                const rockT = smoothstep01(
                    rockStart,
                    rockEnd,
                    height,
                );
                lR = mix(lR, rock.r, rockT);
                lG = mix(lG, rock.g, rockT);
                lB = mix(lB, rock.b, rockT);

                const snowH = C.snowHeight;
                const snowByHeight = smoothstep01(
                    snowH,
                    snowH + heightAmp * 0.25,
                    height,
                );
                const snowByLat = smoothstep01(C.snowLat, 1.0, lat);
                const snowMask = clamp01(
                    snowByHeight * (0.35 + 0.65 * snowByLat),
                );
                lR = mix(lR, snow.r, snowMask);
                lG = mix(lG, snow.g, snowMask);
                lB = mix(lB, snow.b, snowMask);

                col[i3] = mix(lR, wR, waterMask);
                col[i3 + 1] = mix(lG, wG, waterMask);
                col[i3 + 2] = mix(lB, wB, waterMask);
            }

            farGeo.setAttribute(
                "color",
                new THREE.BufferAttribute(col, 3),
            );
            farGeo.computeVertexNormals();
            posAttr.needsUpdate = true;
        }

        this.farMesh = new THREE.Mesh(
            farGeo,
            this.terrainMat,
        );
        this.farMesh.castShadow = true;
        this.farMesh.receiveShadow = true;
        this.group.add(this.farMesh);

        this.patchGridN = cfg.patchGridN ?? 12;
        this.maxLevel = cfg.maxLevel ?? 9;
        this.splitBudgetPerFrame = cfg.splitBudgetPerFrame ?? 6;
        this.mergeBudgetPerFrame = cfg.mergeBudgetPerFrame ?? 6;
        this.baseSplitFactor = cfg.baseSplitFactor ?? 9.2;
        this.baseMergeFactor = cfg.baseMergeFactor ?? 14.2;

        this.activeDist = cfg.activeDist ?? baseRadius * 26.0;
        this.lodDist = cfg.lodDist ?? baseRadius * 18.0;
        this.nodeCullFactor = cfg.nodeCullFactor ?? 2.2;

        this.roots = [];
        for (let f = 0; f < 6; f++)
            this.roots.push(
                new PatchNode(this, f, 0, -1, -1, 1, 1),
            );

        this._frustum = new THREE.Frustum();
        this._projView = new THREE.Matrix4();
        this._sphereWorld = new THREE.Sphere(
            new THREE.Vector3(),
            1,
        );

        this._tmpCenter = new THREE.Vector3();
        this._invMat = new THREE.Matrix4();
        this._camLocal = new THREE.Vector3();
        this._camWorld = new THREE.Vector3();
        this._tmpQ = new THREE.Quaternion();

        this.terrainActive = true;
        this.terrain.visible = true;
        this.farMesh.visible = false;
        for (const r of this.roots) r.ensureMesh();

        this.prevPos = new THREE.Vector3();
        this.prevQuat = new THREE.Quaternion();
        this.currPos = new THREE.Vector3();
        this.currQuat = new THREE.Quaternion();
        this.prevPos.copy(this.group.position);
        this.currPos.copy(this.group.position);
        this.prevQuat.copy(this.group.quaternion);
        this.currQuat.copy(this.group.quaternion);

        this.index = -1; // filled by addPlanet()
    }

    beginFrameCapture() {
        this.group.updateMatrixWorld(true);
        this.group.getWorldPosition(this.prevPos);
        this.group.getWorldQuaternion(this.prevQuat);
    }
    endFrameCapture() {
        this.group.updateMatrixWorld(true);
        this.group.getWorldPosition(this.currPos);
        this.group.getWorldQuaternion(this.currQuat);
    }

    updateOrbit(dt) {
        if (!this.cfg.orbitDist) return;
        this.phase += dt * (this.cfg.orbitSpeed ?? 0.006);
        const x = Math.cos(this.phase) * this.cfg.orbitDist;
        const z = Math.sin(this.phase) * this.cfg.orbitDist;
        this.group.position.set(x, 0, z);
        this.group.rotation.y += this.spinSpeed * dt;
    }

    setTerrainActive(on) {
        if (this.terrainActive === on) return;
        this.terrainActive = on;
        this.terrain.visible = on;
        this.farMesh.visible = !on;
        if (!on) this.forceRootsOnly();
        else for (const r of this.roots) r.ensureMesh();
    }
    forceRootsOnly() {
        for (const r of this.roots) {
            if (r.children) r.merge();
            r.ensureMesh();
        }
    }

    normalEpsForLevel(level) {
        const baseR = this.cfg.baseRadius ?? 1400;
        const patchSpan = 2 / (1 << level);
        const approxEdgeLen = baseR * patchSpan;
        return Math.max(
            0.55,
            (approxEdgeLen / this.patchGridN) * 0.33,
        );
    }
    skirtDepthForLevel(level) {
        const baseR = this.cfg.baseRadius ?? 1400;
        const patchSpan = 2 / (1 << level);
        const approxEdgeLen = baseR * patchSpan;
        return THREE.MathUtils.clamp(
            approxEdgeLen * 0.085,
            6.0,
            140.0,
        );
    }

    wantSplit(node, cameraLocal) {
        const baseR = this.cfg.baseRadius ?? 1400;
        const patchSpan = 2 / (1 << node.level);
        const approxEdgeLen = baseR * patchSpan;
        node.centerLocal(this._tmpCenter);
        const d = this._tmpCenter.distanceTo(cameraLocal);
        return d < approxEdgeLen * this.baseSplitFactor;
    }
    wantMerge(node, cameraLocal) {
        const baseR = this.cfg.baseRadius ?? 1400;
        const patchSpan = 2 / (1 << node.level);
        const approxEdgeLen = baseR * patchSpan;
        node.centerLocal(this._tmpCenter);
        const d = this._tmpCenter.distanceTo(cameraLocal);
        return d > approxEdgeLen * this.baseMergeFactor;
    }
    nodeWorthTraversing(node, cameraLocal) {
        const baseR = this.cfg.baseRadius ?? 1400;
        const patchSpan = 2 / (1 << node.level);
        const approxEdgeLen = baseR * patchSpan;
        node.centerLocal(this._tmpCenter);
        const d = this._tmpCenter.distanceTo(cameraLocal);
        return (
            d <
            approxEdgeLen *
                (this.baseMergeFactor * this.nodeCullFactor)
        );
    }
    nodeInFrustum(node) {
        node._tmpWorldCenter
            .copy(node.boundCenter)
            .applyMatrix4(this.group.matrixWorld);
        this._sphereWorld.center.copy(node._tmpWorldCenter);
        this._sphereWorld.radius = node.boundRadius;
        return this._frustum.intersectsSphere(this._sphereWorld);
    }

    // LOD distance metrics should be based on the gameplay focus (player),
    // not the camera. The camera is still used for frustum culling.
    updateLOD(focusWorldPos, camera) {
        if (!this.terrainActive) return;

        this._camWorld.copy(focusWorldPos);
        this.group.updateMatrixWorld(true);
        this._invMat.copy(this.group.matrixWorld).invert();
        this._camLocal
            .copy(focusWorldPos)
            .applyMatrix4(this._invMat);

        camera.updateMatrixWorld(true);
        this._projView.multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse,
        );
        this._frustum.setFromProjectionMatrix(this._projView);

        let splitBudget = this.splitBudgetPerFrame;
        let mergeBudget = this.mergeBudgetPerFrame;

        
const stack = [...this.roots];
while (stack.length) {
    const n = stack.pop();

    const inFrustum = this.nodeInFrustum(n);
    const worth = inFrustum && this.nodeWorthTraversing(n, this._camLocal);

    // If not worth processing in detail, prefer coarser nodes,
    // but never delete coverage until replacements are ready.
    if (!worth) {
        if (n.children) {
// If we were mid-split, cancel it and keep the parent mesh.
if (n._splitInProgress) {
    for (const c of n.children) c.destroy(true);
    n.children = null;
    n._splitInProgress = false;
}
n.merge(); // async-safe merge (keeps children until parent is ready)
        } else {
n.ensureMesh();
        }
        continue;
    }

    if (n.children) {
        const shouldMerge = n.level >= 1 && this.wantMerge(n, this._camLocal);

        // If we were mid-split but now we want to merge, cancel split first
        // so we don't drop the parent mesh and create holes.
        if (n._splitInProgress && shouldMerge) {
for (const c of n.children) c.destroy(true);
n.children = null;
n._splitInProgress = false;
n.ensureMesh();
continue;
        }

        // While splitting, keep traversing children and only drop the parent
        // once all children are ready.
        if (n._splitInProgress) {
for (const c of n.children) stack.push(c);
n._finalizeSplitIfReady();
continue;
        }

        // If a merge was in progress but we no longer want it, cancel it
        // so we don't delete children when the parent mesh arrives.
        if (n._mergeInProgress && !shouldMerge) {
n.disposeMesh(); // clears any pending parent job and removes parent mesh if created
n._mergeInProgress = false;
        }

        // If merging is desired, request it (budgeted) and keep children until ready.
        if (shouldMerge) {
if (mergeBudget > 0 && !n._mergeInProgress) {
    n.merge();
    mergeBudget--;
} else if (n._mergeInProgress) {
    // Let the merge finish even if we ran out of budget.
    n._finalizeMergeIfReady();
}
// Don't traverse children while trying to merge.
        } else {
for (const c of n.children) stack.push(c);
        }
    } else {
        if (
splitBudget > 0 &&
n.level < this.maxLevel &&
this.wantSplit(n, this._camLocal)
        ) {
n.split(); // async-safe split (keeps parent until children are ready)
splitBudget--;
        } else {
n.ensureMesh();
        }
    }
}
    }

    destroy() {
        for (const r of this.roots) r.destroy(true);
        if (this.ocean) {
            this.ocean.geometry.dispose();
            this.ocean.material.dispose();
        }
        this.farMesh.geometry.dispose();
        if (this.farMesh.material !== this.terrainMat) this.farMesh.material.dispose();
        this.terrainMat.dispose();
    }
}

////////////////////////////////////////////////////////////////////////////////
