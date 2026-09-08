import { THREE } from "../../render/device.js";
import {
    VOLUME_NOISE_ATLAS_HEIGHT,
    VOLUME_NOISE_ATLAS_WIDTH,
    VOLUME_NOISE_GRID_X,
    VOLUME_NOISE_GRID_Y,
    VOLUME_NOISE_SIZE,
} from "../../render/noiseTextures.js";
import {
    createOceanMaterial,
    evaluateOceanVertexHeightCPU,
    OCEAN_MAX_OCCLUDERS,
} from "./oceanMaterial.js";


function terrainMulberry32(seed) {
    let a = seed >>> 0;
    return function random() {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

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

// Maximum absolute value of the five-octave terrain FBM used below when each
// source octave is in [-1, 1]. This gives airless bodies a guaranteed inner
// occluder sphere for horizon culling without guessing from sampled terrain.
const TERRAIN_FBM_ABS_MAX =
    (0.5 * (1.0 - Math.pow(0.52, 5))) / (1.0 - 0.52);

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
// Patch geometry + vertex biome colors
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

    const out = {
        main: mainIdx,
        mainFlip: _flipIndexTris(mainIdx),
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


////////////////////////////////////////////////////////////////////////////////
// Seam-safe quadtree edges
////////////////////////////////////////////////////////////////////////////////
// Edge order: v-min, v-max, u-min, u-max.
const EDGE_V_MIN = 0;
const EDGE_V_MAX = 1;
const EDGE_U_MIN = 2;
const EDGE_U_MAX = 3;
const EDGE_COUNT = 4;
const EDGE_SOURCE_STRIDE = 9; // position + normal + color
const OCEAN_EDGE_SOURCE_STRIDE = 9; // ocean position + normal + terrain position

// [adjacent face, adjacent edge, along-edge orientation]. The orientation maps
// the source face's absolute edge coordinate to the adjacent face coordinate.
// This table is exact for faceUvToCubeXYZ() above and avoids nearest-face
// searches or allocations at runtime.
const CUBE_FACE_EDGE_ADJACENCY = [
    // +X
    [
        [3, EDGE_U_MAX, -1],
        [2, EDGE_U_MAX, +1],
        [4, EDGE_U_MAX, +1],
        [5, EDGE_U_MIN, +1],
    ],
    // -X
    [
        [3, EDGE_U_MIN, +1],
        [2, EDGE_U_MIN, -1],
        [5, EDGE_U_MAX, +1],
        [4, EDGE_U_MIN, +1],
    ],
    // +Y
    [
        [4, EDGE_V_MAX, +1],
        [5, EDGE_V_MAX, -1],
        [1, EDGE_V_MAX, -1],
        [0, EDGE_V_MAX, +1],
    ],
    // -Y
    [
        [5, EDGE_V_MIN, -1],
        [4, EDGE_V_MIN, +1],
        [1, EDGE_V_MIN, +1],
        [0, EDGE_V_MIN, -1],
    ],
    // +Z
    [
        [3, EDGE_V_MAX, +1],
        [2, EDGE_V_MIN, +1],
        [1, EDGE_U_MAX, +1],
        [0, EDGE_U_MIN, +1],
    ],
    // -Z
    [
        [3, EDGE_V_MIN, -1],
        [2, EDGE_V_MAX, -1],
        [0, EDGE_U_MAX, +1],
        [1, EDGE_U_MIN, +1],
    ],
];

function oppositePatchEdge(edge) {
    switch (edge) {
        case EDGE_V_MIN:
            return EDGE_V_MAX;
        case EDGE_V_MAX:
            return EDGE_V_MIN;
        case EDGE_U_MIN:
            return EDGE_U_MAX;
        default:
            return EDGE_U_MIN;
    }
}

function patchEdgeVertexIndex(edge, t, N) {
    const stride = N + 1;
    switch (edge) {
        case EDGE_V_MIN:
            return t;
        case EDGE_V_MAX:
            return N * stride + t;
        case EDGE_U_MIN:
            return t * stride;
        default:
            return t * stride + N;
    }
}

function patchEdgeAlongCoordinate(node, edge, t01) {
    return edge === EDGE_V_MIN || edge === EDGE_V_MAX
        ? mix(node.u0, node.u1, t01)
        : mix(node.v0, node.v1, t01);
}

function capturePatchEdgeSource(pos, nrm, col, N) {
    const stride = N + 1;
    const out = new Float32Array(EDGE_COUNT * stride * EDGE_SOURCE_STRIDE);
    for (let edge = 0; edge < EDGE_COUNT; edge++) {
        for (let t = 0; t <= N; t++) {
            const vi3 = patchEdgeVertexIndex(edge, t, N) * 3;
            const oi = (edge * stride + t) * EDGE_SOURCE_STRIDE;
            out[oi] = pos[vi3];
            out[oi + 1] = pos[vi3 + 1];
            out[oi + 2] = pos[vi3 + 2];
            out[oi + 3] = nrm[vi3];
            out[oi + 4] = nrm[vi3 + 1];
            out[oi + 5] = nrm[vi3 + 2];
            out[oi + 6] = col[vi3];
            out[oi + 7] = col[vi3 + 1];
            out[oi + 8] = col[vi3 + 2];
        }
    }
    return out;
}

function captureOceanEdgeSourceFromTerrain(terrainPositions, seaLevel, N) {
    const stride = N + 1;
    const out = new Float32Array(
        EDGE_COUNT * stride * OCEAN_EDGE_SOURCE_STRIDE,
    );
    for (let edge = 0; edge < EDGE_COUNT; edge++) {
        for (let t = 0; t <= N; t++) {
            const vi3 = patchEdgeVertexIndex(edge, t, N) * 3;
            const tx = terrainPositions[vi3];
            const ty = terrainPositions[vi3 + 1];
            const tz = terrainPositions[vi3 + 2];
            const inv = 1.0 / Math.max(1e-8, Math.hypot(tx, ty, tz));
            const dx = tx * inv;
            const dy = ty * inv;
            const dz = tz * inv;
            const oi =
                (edge * stride + t) * OCEAN_EDGE_SOURCE_STRIDE;

            out[oi] = dx * seaLevel;
            out[oi + 1] = dy * seaLevel;
            out[oi + 2] = dz * seaLevel;
            out[oi + 3] = dx;
            out[oi + 4] = dy;
            out[oi + 5] = dz;
            // Keep the original terrain triangle edge available even on a
            // completely dry neighbour. Wet fine patches can then stitch both
            // their water surface and coastline mask to the coarser terrain.
            out[oi + 6] = tx;
            out[oi + 7] = ty;
            out[oi + 8] = tz;
        }
    }
    return out;
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
    baseRadius,
    seaLevel,
    heightAmp,
    biome,
}) {
    const N = gridN;
    const vertsPerSide = N + 1;
    const vertCount = vertsPerSide * vertsPerSide;

    const pos2 = new Float32Array(vertCount * 3);
    const nrm2 = new Float32Array(vertCount * 3);
    const col2 = new Float32Array(vertCount * 3);

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

    const use32 = vertCount > 65535;
    const idxSet = getPatchIndexSet(N, use32);
    const flip = faceNeedsFlip(face, N);
    const mainIdx = flip ? idxSet.mainFlip : idxSet.main;

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
    };
}

// Squared distance from the planet origin to a triangle. This is used to
// reject ocean patches that are completely covered by the piecewise-linear
// terrain mesh, rather than creating one water draw for every land patch.
function originTriangleDistanceSq(
    ax,
    ay,
    az,
    bx,
    by,
    bz,
    cx,
    cy,
    cz,
) {
    const abx = bx - ax,
        aby = by - ay,
        abz = bz - az;
    const acx = cx - ax,
        acy = cy - ay,
        acz = cz - az;

    const apx = -ax,
        apy = -ay,
        apz = -az;
    const d1 = abx * apx + aby * apy + abz * apz;
    const d2 = acx * apx + acy * apy + acz * apz;
    if (d1 <= 0 && d2 <= 0) return ax * ax + ay * ay + az * az;

    const bpx = -bx,
        bpy = -by,
        bpz = -bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return bx * bx + by * by + bz * bz;

    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / Math.max(1e-20, d1 - d3);
        const qx = ax + abx * v;
        const qy = ay + aby * v;
        const qz = az + abz * v;
        return qx * qx + qy * qy + qz * qz;
    }

    const cpx = -cx,
        cpy = -cy,
        cpz = -cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz;
    const d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return cx * cx + cy * cy + cz * cz;

    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) {
        const w = d2 / Math.max(1e-20, d2 - d6);
        const qx = ax + acx * w;
        const qy = ay + acy * w;
        const qz = az + acz * w;
        return qx * qx + qy * qy + qz * qz;
    }

    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
        const bcx = cx - bx,
            bcy = cy - by,
            bcz = cz - bz;
        const w =
            (d4 - d3) /
            Math.max(1e-20, d4 - d3 + (d5 - d6));
        const qx = bx + bcx * w;
        const qy = by + bcy * w;
        const qz = bz + bcz * w;
        return qx * qx + qy * qy + qz * qz;
    }

    const denom = 1.0 / Math.max(1e-20, va + vb + vc);
    const v = vb * denom;
    const w = vc * denom;
    const qx = ax + abx * v + acx * w;
    const qy = ay + aby * v + acy * w;
    const qz = az + abz * v + acz * w;
    return qx * qx + qy * qy + qz * qz;
}

function terrainPatchTouchesOcean(
    pos,
    index,
    seaLevel,
    coastMargin = 0.0,
) {
    // Include a small conservative band for precision and for the maximum edge
    // adjustment introduced when this patch stitches to a coarser neighbour.
    const threshold =
        seaLevel +
        Math.max(0.0, coastMargin) +
        Math.max(0.05, seaLevel * 1e-6);
    const thresholdSq = threshold * threshold;
    for (let ii = 0; ii < index.length; ii += 3) {
        const ia = index[ii] * 3;
        const ib = index[ii + 1] * 3;
        const ic = index[ii + 2] * 3;
        if (
            originTriangleDistanceSq(
                pos[ia],
                pos[ia + 1],
                pos[ia + 2],
                pos[ib],
                pos[ib + 1],
                pos[ib + 2],
                pos[ic],
                pos[ic + 1],
                pos[ic + 2],
            ) <= thresholdSq
        ) {
            return true;
        }
    }
    return false;
}

function buildOceanPatchGeometry({
    terrainPositions,
    index,
    seaLevel,
    coastMargin = 0.0,
    force = false,
    maxDisplacement = 0.0,
}) {
    if (
        !force &&
        (!index ||
            !terrainPatchTouchesOcean(
                terrainPositions,
                index,
                seaLevel,
                coastMargin,
            ))
    ) {
        return null;
    }

    const vertCount = terrainPositions.length / 3;
    const pos = new Float32Array(terrainPositions.length);
    const nrm = new Float32Array(terrainPositions.length);
    const terrainPosition = new Float32Array(terrainPositions.length);
    // xyz = first coarse-edge anchor, w = interpolation toward the second.
    // Interior and same-LOD edge vertices use themselves with w = 0.
    const oceanSwayAnchor = new Float32Array(vertCount * 4);

    for (let vi = 0, k = 0; vi < vertCount; vi++, k += 3) {
        const tx = terrainPositions[k];
        const ty = terrainPositions[k + 1];
        const tz = terrainPositions[k + 2];
        const terrainRadius = Math.hypot(tx, ty, tz);
        const inv = 1.0 / Math.max(1e-8, terrainRadius);
        const dx = tx * inv;
        const dy = ty * inv;
        const dz = tz * inv;

        pos[k] = dx * seaLevel;
        pos[k + 1] = dy * seaLevel;
        pos[k + 2] = dz * seaLevel;
        nrm[k] = dx;
        nrm[k + 1] = dy;
        nrm[k + 2] = dz;
        terrainPosition[k] = tx;
        terrainPosition[k + 1] = ty;
        terrainPosition[k + 2] = tz;

        const swayIndex = vi * 4;
        oceanSwayAnchor[swayIndex] = pos[k];
        oceanSwayAnchor[swayIndex + 1] = pos[k + 1];
        oceanSwayAnchor[swayIndex + 2] = pos[k + 2];
        oceanSwayAnchor[swayIndex + 3] = 0.0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geometry.setAttribute(
        "terrainPosition",
        new THREE.BufferAttribute(terrainPosition, 3),
    );
    geometry.setAttribute(
        "oceanSwayAnchor",
        new THREE.BufferAttribute(oceanSwayAnchor, 4),
    );
    if (index) {
        geometry.setIndex(new THREE.BufferAttribute(index, 1));
    }
    geometry.computeBoundingSphere();
    if (geometry.boundingSphere) {
        geometry.boundingSphere.radius += Math.max(0.0, maxDisplacement);
    }
    return geometry;
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
        this.completedHead = 0;
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
        // Publish the id before dispatch so stale-queue filtering is race-free.
        patch._pendingJobId = id;
        this.queue.push({ id, patch, params });
        this._dispatch();
        return id;
    }

    _dispatch() {
        for (const rec of this.workers) {
            if (rec.busy) continue;

            let job = null;
            while (this.queueHead < this.queue.length) {
                const candidate = this.queue[this.queueHead++];
                const patch = candidate?.patch;
                if (
                    patch?._genPending &&
                    (patch._pendingJobId | 0) === (candidate.id | 0)
                ) {
                    job = candidate;
                    break;
                }
            }

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
            if (
                infl?.patch?._genPending &&
                (infl.patch._pendingJobId | 0) === (msg.id | 0)
            ) {
                this.completed.push({
                    patch: infl.patch,
                    jobId: msg.id,
                    data: msg,
                });
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

    pumpCompleted({ maxJobs = 2, budgetMs = 2.0 } = {}) {
        if (this.completedHead >= this.completed.length) return 0;

        const start = performance.now();
        let applied = 0;
        while (this.completedHead < this.completed.length) {
            const item = this.completed[this.completedHead++];
            const patch = item.patch;
            if (
                patch?._genPending &&
                (patch._pendingJobId | 0) === (item.jobId | 0)
            ) {
                patch._applyTerrainWorkerResult?.(item.jobId, item.data);
                applied++;
            }

            if (applied >= maxJobs) break;
            if (performance.now() - start >= budgetMs) break;
        }

        if (
            this.completedHead >= this.completed.length ||
            (this.completedHead > 256 &&
                this.completedHead * 2 > this.completed.length)
        ) {
            this.completed = this.completed.slice(this.completedHead);
            this.completedHead = 0;
        }
        return applied;
    }
}

const TERRAIN_WORKER_COUNT = USE_TERRAIN_WORKERS
    ? Math.min(
          4,
          Math.max(1, ((navigator.hardwareConcurrency || 4) | 0) - 1),
      )
    : 0;
export const terrainPool = TERRAIN_WORKER_COUNT > 0 ? new TerrainWorkerPool(TERRAIN_WORKER_COUNT) : null;

let _nextBodyId = 1;

// Patch node
////////////////////////////////////////////////////////////////////////////////
class PatchNode {
    constructor(body, face, level, u0, v0, u1, v1, parent = null) {
        this.body = body;
        this.face = face;
        this.level = level;
        this.parent = parent;
        this.nodeId = body._nextPatchNodeId++;
        this.u0 = u0;
        this.v0 = v0;
        this.u1 = u1;
        this.v1 = v1;
        this.children = null;
        this.meshMain = null;
        this.meshOcean = null;
        this._genPending = false;
        this._pendingJobId = 0;
        this._forceOceanMesh = false;
        this._splitInProgress = false;
        this._mergeInProgress = false;
        this._balanceVisit = 0;
        this._lodDistanceSq = 0;
        this._edgeGridN = 0;
        this._edgeSource = null;
        this._oceanEdgeSource = null;
        this._edgeNeighborIds = new Int32Array(EDGE_COUNT);
        this._edgeNeighborIds.fill(-1);
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
        const extra = this.body.heightAmp ?? 0;
        this.boundRadius = approxEdgeLen * 0.85 + extra;
    }

    _adoptGeometryBounds(geometry) {
        if (!geometry.boundingSphere) geometry.computeBoundingSphere();
        const sphere = geometry.boundingSphere;
        if (!sphere) return;

        // The old bound added the complete planet height range to every node.
        // At high LOD that made a 30-unit patch look hundreds of units wide,
        // so off-screen and self-occluded patches kept refining. The generated
        // mesh already provides an exact conservative sphere for its triangles.
        this.boundCenter.copy(sphere.center);
        const patchSpan = 2 / (1 << this.level);
        const patchEdge = this.body.baseRadius * patchSpan;
        const stitchPadding = Math.max(
            0.25,
            (patchEdge / Math.max(1, this.body.patchGridN)) * 1.5,
        );
        sphere.radius += stitchPadding;
        this.boundRadius = Math.max(0.001, sphere.radius);
    }


    _captureEdgeSource(pos, nrm, col, N) {
        this._edgeGridN = N | 0;
        this._edgeSource = capturePatchEdgeSource(pos, nrm, col, this._edgeGridN);
        this._edgeNeighborIds.fill(-1);
    }

    _captureOceanEdgeSource(terrainPositions, seaLevel, N) {
        this._oceanEdgeSource = captureOceanEdgeSourceFromTerrain(
            terrainPositions,
            seaLevel,
            N,
        );
        this._edgeNeighborIds.fill(-1);
    }

    _restoreOriginalEdges(pos, nrm, col) {
        const N = this._edgeGridN;
        const stride = N + 1;
        const src = this._edgeSource;
        for (let edge = 0; edge < EDGE_COUNT; edge++) {
            for (let t = 0; t <= N; t++) {
                const vi3 = patchEdgeVertexIndex(edge, t, N) * 3;
                const si = (edge * stride + t) * EDGE_SOURCE_STRIDE;
                pos[vi3] = src[si];
                pos[vi3 + 1] = src[si + 1];
                pos[vi3 + 2] = src[si + 2];
                nrm[vi3] = src[si + 3];
                nrm[vi3 + 1] = src[si + 4];
                nrm[vi3 + 2] = src[si + 5];
                col[vi3] = src[si + 6];
                col[vi3 + 1] = src[si + 7];
                col[vi3 + 2] = src[si + 8];
            }
        }
    }

    _restoreOriginalOceanEdges(pos, nrm, terrainPosition, swayAnchor) {
        const N = this._edgeGridN;
        const stride = N + 1;
        const src = this._oceanEdgeSource;
        if (!src) return;
        for (let edge = 0; edge < EDGE_COUNT; edge++) {
            for (let t = 0; t <= N; t++) {
                const vi = patchEdgeVertexIndex(edge, t, N);
                const vi3 = vi * 3;
                const si =
                    (edge * stride + t) * OCEAN_EDGE_SOURCE_STRIDE;
                pos[vi3] = src[si];
                pos[vi3 + 1] = src[si + 1];
                pos[vi3 + 2] = src[si + 2];
                nrm[vi3] = src[si + 3];
                nrm[vi3 + 1] = src[si + 4];
                nrm[vi3 + 2] = src[si + 5];
                terrainPosition[vi3] = src[si + 6];
                terrainPosition[vi3 + 1] = src[si + 7];
                terrainPosition[vi3 + 2] = src[si + 8];
                const swayIndex = vi * 4;
                swayAnchor[swayIndex] = src[si];
                swayAnchor[swayIndex + 1] = src[si + 1];
                swayAnchor[swayIndex + 2] = src[si + 2];
                swayAnchor[swayIndex + 3] = 0.0;
            }
        }
    }

    _stitchEdgeFromNeighbour(edge, neighbour, pos, nrm, col) {
        if (!neighbour?._edgeSource || neighbour._edgeGridN <= 0) return false;

        const desc = this.body._describeAdjacentEdge(
            this,
            edge,
            this.body._edgeDescriptorScratch,
        );
        if (!desc || desc.face !== neighbour.face) return false;

        const N = this._edgeGridN;
        const neighbourN = neighbour._edgeGridN;
        const neighbourStride = neighbourN + 1;
        const neighbourSource = neighbour._edgeSource;
        const targetEdge = desc.edge;
        const neighbourAlong0 =
            targetEdge === EDGE_V_MIN || targetEdge === EDGE_V_MAX
                ? neighbour.u0
                : neighbour.v0;
        const neighbourAlong1 =
            targetEdge === EDGE_V_MIN || targetEdge === EDGE_V_MAX
                ? neighbour.u1
                : neighbour.v1;
        const neighbourSpan = neighbourAlong1 - neighbourAlong0;
        if (!(neighbourSpan > 0)) return false;

        for (let t = 0; t <= N; t++) {
            const sourceAlong = patchEdgeAlongCoordinate(this, edge, t / N);
            const targetAlong = desc.orientation * sourceAlong;
            let sample =
                ((targetAlong - neighbourAlong0) / neighbourSpan) * neighbourN;
            sample = Math.max(0, Math.min(neighbourN, sample));
            const rounded = Math.round(sample);
            if (Math.abs(sample - rounded) < 1e-5) sample = rounded;

            const i0 = Math.max(0, Math.min(neighbourN, Math.floor(sample)));
            const i1 = Math.min(neighbourN, i0 + 1);
            const alpha = sample - i0;
            const s0 =
                (targetEdge * neighbourStride + i0) * EDGE_SOURCE_STRIDE;
            const s1 =
                (targetEdge * neighbourStride + i1) * EDGE_SOURCE_STRIDE;
            const vi3 = patchEdgeVertexIndex(edge, t, N) * 3;

            pos[vi3] = mix(neighbourSource[s0], neighbourSource[s1], alpha);
            pos[vi3 + 1] = mix(
                neighbourSource[s0 + 1],
                neighbourSource[s1 + 1],
                alpha,
            );
            pos[vi3 + 2] = mix(
                neighbourSource[s0 + 2],
                neighbourSource[s1 + 2],
                alpha,
            );

            let nx = mix(
                neighbourSource[s0 + 3],
                neighbourSource[s1 + 3],
                alpha,
            );
            let ny = mix(
                neighbourSource[s0 + 4],
                neighbourSource[s1 + 4],
                alpha,
            );
            let nz = mix(
                neighbourSource[s0 + 5],
                neighbourSource[s1 + 5],
                alpha,
            );
            const invN = 1.0 / Math.max(1e-8, Math.hypot(nx, ny, nz));
            nrm[vi3] = nx * invN;
            nrm[vi3 + 1] = ny * invN;
            nrm[vi3 + 2] = nz * invN;

            col[vi3] = mix(
                neighbourSource[s0 + 6],
                neighbourSource[s1 + 6],
                alpha,
            );
            col[vi3 + 1] = mix(
                neighbourSource[s0 + 7],
                neighbourSource[s1 + 7],
                alpha,
            );
            col[vi3 + 2] = mix(
                neighbourSource[s0 + 8],
                neighbourSource[s1 + 8],
                alpha,
            );
        }
        return true;
    }

    _stitchOceanEdgeFromNeighbour(
        edge,
        neighbour,
        pos,
        nrm,
        terrainPosition,
        swayAnchor,
    ) {
        if (!neighbour?._oceanEdgeSource || neighbour._edgeGridN <= 0) {
            return false;
        }

        const desc = this.body._describeAdjacentEdge(
            this,
            edge,
            this.body._edgeDescriptorScratch,
        );
        if (!desc || desc.face !== neighbour.face) return false;

        const N = this._edgeGridN;
        const neighbourN = neighbour._edgeGridN;
        const neighbourStride = neighbourN + 1;
        const neighbourSource = neighbour._oceanEdgeSource;
        const targetEdge = desc.edge;
        const neighbourAlong0 =
            targetEdge === EDGE_V_MIN || targetEdge === EDGE_V_MAX
                ? neighbour.u0
                : neighbour.v0;
        const neighbourAlong1 =
            targetEdge === EDGE_V_MIN || targetEdge === EDGE_V_MAX
                ? neighbour.u1
                : neighbour.v1;
        const neighbourSpan = neighbourAlong1 - neighbourAlong0;
        if (!(neighbourSpan > 0)) return false;

        for (let t = 0; t <= N; t++) {
            const sourceAlong = patchEdgeAlongCoordinate(this, edge, t / N);
            const targetAlong = desc.orientation * sourceAlong;
            let sample =
                ((targetAlong - neighbourAlong0) / neighbourSpan) *
                neighbourN;
            sample = Math.max(0, Math.min(neighbourN, sample));
            const rounded = Math.round(sample);
            if (Math.abs(sample - rounded) < 1e-5) sample = rounded;

            const i0 = Math.max(
                0,
                Math.min(neighbourN, Math.floor(sample)),
            );
            const i1 = Math.min(neighbourN, i0 + 1);
            const alpha = sample - i0;
            const s0 =
                (targetEdge * neighbourStride + i0) *
                OCEAN_EDGE_SOURCE_STRIDE;
            const s1 =
                (targetEdge * neighbourStride + i1) *
                OCEAN_EDGE_SOURCE_STRIDE;
            const vi = patchEdgeVertexIndex(edge, t, N);
            const vi3 = vi * 3;

            pos[vi3] = mix(neighbourSource[s0], neighbourSource[s1], alpha);
            pos[vi3 + 1] = mix(
                neighbourSource[s0 + 1],
                neighbourSource[s1 + 1],
                alpha,
            );
            pos[vi3 + 2] = mix(
                neighbourSource[s0 + 2],
                neighbourSource[s1 + 2],
                alpha,
            );

            let nx = mix(
                neighbourSource[s0 + 3],
                neighbourSource[s1 + 3],
                alpha,
            );
            let ny = mix(
                neighbourSource[s0 + 4],
                neighbourSource[s1 + 4],
                alpha,
            );
            let nz = mix(
                neighbourSource[s0 + 5],
                neighbourSource[s1 + 5],
                alpha,
            );
            const invN = 1.0 / Math.max(1e-8, Math.hypot(nx, ny, nz));
            nrm[vi3] = nx * invN;
            nrm[vi3 + 1] = ny * invN;
            nrm[vi3 + 2] = nz * invN;
            terrainPosition[vi3] = mix(
                neighbourSource[s0 + 6],
                neighbourSource[s1 + 6],
                alpha,
            );
            terrainPosition[vi3 + 1] = mix(
                neighbourSource[s0 + 7],
                neighbourSource[s1 + 7],
                alpha,
            );
            terrainPosition[vi3 + 2] = mix(
                neighbourSource[s0 + 8],
                neighbourSource[s1 + 8],
                alpha,
            );

            // Vertex displacement must follow the coarse edge rather than
            // evaluate a new nonlinear wave at the fine midpoint. Store the
            // first coarse anchor and interpolation factor; the shader
            // reconstructs the second anchor from the already-stitched point.
            const swayIndex = vi * 4;
            swayAnchor[swayIndex] = neighbourSource[s0];
            swayAnchor[swayIndex + 1] = neighbourSource[s0 + 1];
            swayAnchor[swayIndex + 2] = neighbourSource[s0 + 2];
            swayAnchor[swayIndex + 3] = alpha;
        }
        return true;
    }

    _applyEdgeLinks(links) {
        if (!this.meshMain || !this._edgeSource) return;
        if (!this.body.edgeStitchingEnabled) links = this.body._emptyEdgeLinks;

        let changed = false;
        for (let edge = 0; edge < EDGE_COUNT; edge++) {
            const id = links[edge]?.nodeId ?? 0;
            if (this._edgeNeighborIds[edge] !== id) {
                changed = true;
                break;
            }
        }
        if (!changed) return;

        const mainAttrs = this.meshMain.geometry.attributes;
        const pos = mainAttrs.position.array;
        const nrm = mainAttrs.normal.array;
        const col = mainAttrs.color.array;
        this._restoreOriginalEdges(pos, nrm, col);

        for (let edge = 0; edge < EDGE_COUNT; edge++) {
            const neighbour = links[edge];
            const stitched = neighbour
                ? this._stitchEdgeFromNeighbour(edge, neighbour, pos, nrm, col)
                : false;
            this._edgeNeighborIds[edge] = stitched ? neighbour.nodeId : 0;
        }

        mainAttrs.position.needsUpdate = true;
        mainAttrs.normal.needsUpdate = true;
        mainAttrs.color.needsUpdate = true;

        if (this.meshOcean && this._oceanEdgeSource) {
            const oceanAttrs = this.meshOcean.geometry.attributes;
            const oceanPos = oceanAttrs.position.array;
            const oceanNrm = oceanAttrs.normal.array;
            const terrainPosition = oceanAttrs.terrainPosition.array;
            const swayAnchor = oceanAttrs.oceanSwayAnchor.array;
            this._restoreOriginalOceanEdges(
                oceanPos,
                oceanNrm,
                terrainPosition,
                swayAnchor,
            );

            for (let edge = 0; edge < EDGE_COUNT; edge++) {
                const neighbour = links[edge];
                if (neighbour) {
                    this._stitchOceanEdgeFromNeighbour(
                        edge,
                        neighbour,
                        oceanPos,
                        oceanNrm,
                        terrainPosition,
                        swayAnchor,
                    );
                }
            }

            oceanAttrs.position.needsUpdate = true;
            oceanAttrs.normal.needsUpdate = true;
            oceanAttrs.terrainPosition.needsUpdate = true;
            oceanAttrs.oceanSwayAnchor.needsUpdate = true;
        }
    }


    _setMeshVisible(visible) {
        if (this.meshMain) this.meshMain.visible = visible;
        if (this.meshOcean) this.meshOcean.visible = visible;
    }

    _syncTransitionVisibility() {
        this._setMeshVisible(this.body._isRenderLeaf(this));
        if (this._splitInProgress && this.hasMesh() && this.children) {
            // A late parent result becomes the temporary authoritative
            // surface until all children are ready. Hide any children that
            // happened to finish first so the two LODs never z-fight.
            for (const child of this.children) child._setMeshVisible(false);
        }
    }


hasMesh() {
    return !!this.meshMain;
}
subtreeHasOceanMesh() {
    if (this.meshOcean) return true;
    if (!this.children) return false;
    for (const child of this.children) {
        if (child.subtreeHasOceanMesh()) return true;
    }
    return false;
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
        if (this.children) return false;

        // Never fan out worker jobs before the current patch can provide
        // complete coverage. This avoids temporary holes and keeps startup
        // generation from racing several LOD levels ahead of the renderer.
        this.ensureMesh();
        if (!this.hasMesh()) return false;

    const um = (this.u0 + this.u1) * 0.5,
        vm = (this.v0 + this.v1) * 0.5;
    const L = this.level + 1,
        f = this.face;

    this.children = [
        new PatchNode(this.body, f, L, this.u0, this.v0, um, vm, this),
        new PatchNode(this.body, f, L, um, this.v0, this.u1, vm, this),
        new PatchNode(this.body, f, L, this.u0, vm, um, this.v1, this),
        new PatchNode(this.body, f, L, um, vm, this.u1, this.v1, this),
    ];

    this._splitInProgress = true;

    // Start generating children, but keep parent mesh until they're ready.
    for (const c of this.children) c.ensureMesh();
    return true;
}

_finalizeSplitIfReady() {
    if (!this._splitInProgress) return;
    if (!this.childrenReady()) return;
    // A neighbouring merge can finish while these worker jobs are pending.
    // Never reveal an L+1 edge beside an active L-1 patch.
    if (this.body._findBalanceSplitCandidate(this)) return;

    // Children are ready; reveal them atomically, then drop the parent.
    for (const child of this.children) child._setMeshVisible(true);
    this.disposeMesh();
    this._splitInProgress = false;
    this.body._markTopologyChanged();
}

requestMerge() {
    if (!this.children) return;

    // Preserve water that was visible in finer children while the coarser
    // parent is regenerated. The parent shader can still discard dry pixels.
    this._forceOceanMesh = this.children.some((c) =>
        c.subtreeHasOceanMesh(),
    );

    // If we still have the parent mesh (e.g. mid-split), we can merge immediately.
    if (this.hasMesh()) {
        this._setMeshVisible(true);
        for (const c of this.children) c.destroy(true);
        this.children = null;
        this._splitInProgress = false;
        this._mergeInProgress = false;
        this._forceOceanMesh = false;
        this.body._markTopologyChanged();
        return;
    }

    this._mergeInProgress = true;

    // Start generating parent, but keep children until parent is ready.
    this.ensureMesh();
}

_finalizeMergeIfReady() {
    if (!this._mergeInProgress) return;
    if (!this.hasMesh()) return;
    // A nearby split can complete while the parent worker job is pending.
    // Keep the children authoritative until exposing this parent is balanced.
    if (!this.body._canMergeBalanced(this)) return;

    // Parent is ready; reveal it atomically, then drop children.
    this._setMeshVisible(true);
    if (this.children) for (const c of this.children) c.destroy(true);
    this.children = null;
    this._mergeInProgress = false;
    this.body._markTopologyChanged();
}

    _createOceanMesh(terrainPositions, index, N) {
        const b = this.body;
        if (!b?.hasOcean || !b.oceanMaterial) {
            this._forceOceanMesh = false;
            return;
        }

        // Store compact ocean/coast edge data for every terrain patch, even a
        // dry one. Otherwise a wet fine patch beside a dry coarse neighbour
        // would have nothing to stitch against at their shared shoreline.
        this._captureOceanEdgeSource(terrainPositions, b.seaLevel, N);

        const foamDepth =
            b.oceanUniforms?.uFoamDepth?.value ?? b.biome.shoreWidth;
        const stitchMargin = Math.max(
            1.0,
            b.oceanSurfaceDisplacement ?? 0.0,
            Math.min(
                foamDepth * 1.1,
                b.normalEpsForLevel(this.level) * 2.5,
            ),
        );
        const geometry = buildOceanPatchGeometry({
            terrainPositions,
            index,
            seaLevel: b.seaLevel,
            coastMargin: stitchMargin,
            force: this._forceOceanMesh,
            maxDisplacement: b.oceanSurfaceDisplacement,
        });
        this._forceOceanMesh = false;
        if (!geometry) return;

        this.meshOcean = new THREE.Mesh(geometry, b.oceanMaterial);
        this.meshOcean.castShadow = false;
        this.meshOcean.receiveShadow = false;
        this.meshOcean.renderOrder = 1;
        b.ocean.add(this.meshOcean);

    }

    ensureMesh() {
        if (this.meshMain) return;
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
            baseRadius: b.baseRadius,
            seaLevel: b.seaLevel,
            heightAmp: b.heightAmp,
            biome: b.biome,
        });

        const terrainMat = b.terrainMat;

        // Main terrain surface: casts + receives shadows
        this.meshMain = new THREE.Mesh(geos.main, terrainMat);
        this.meshMain.castShadow = true;
        this.meshMain.receiveShadow = true;
        b.terrain.add(this.meshMain);
        this._adoptGeometryBounds(geos.main);

        this._createOceanMesh(
            geos.main.attributes.position.array,
            geos.main.index.array,
            b.patchGridN,
        );

        this._captureEdgeSource(
            geos.main.attributes.position.array,
            geos.main.attributes.normal.array,
            geos.main.attributes.color.array,
            b.patchGridN,
        );
        this._syncTransitionVisibility();
        if (b._isRenderLeaf(this)) {
            // Mesh availability is part of the visible topology. Stitch this
            // patch now and defer the one global neighbour refresh to the end
            // of the body's current LOD update.
            b._markTopologyChanged();
            b._refreshSingleNodeStitching(this);
        }
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
        if (this.meshMain) return;

        const b = this.body;
        if (!b) return;

        const N = (msg.gridN | 0);
        const pos2 = msg.pos;
        const nrm2 = msg.nrm;
        const col2 = msg.col;

        const vertsPerSide = N + 1;
        const vertCount = vertsPerSide * vertsPerSide;

        if (!pos2 || !nrm2 || !col2) return;
        if (pos2.length !== vertCount * 3) return;

        const use32 = vertCount > 65535;
        const idxSet = getPatchIndexSet(N, use32);
        const flip = faceNeedsFlip(this.face, N);
        const mainIdx = flip ? idxSet.mainFlip : idxSet.main;

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

        const terrainMat = b.terrainMat;
        this.meshMain = new THREE.Mesh(geoMain, terrainMat);
        this.meshMain.castShadow = true;
        this.meshMain.receiveShadow = true;
        b.terrain.add(this.meshMain);
        this._adoptGeometryBounds(geoMain);

        this._createOceanMesh(pos2, mainIdx, N);

        this._captureEdgeSource(pos2, nrm2, col2, N);
        this._syncTransitionVisibility();
        if (!b.terrainActive) {
            // Inactive bodies do not run updateLOD(). Complete their pending
            // root coarsening as worker results arrive so detailed meshes are
            // actually released while the far sphere is in use.
            b.forceRootsOnly();
            return;
        }
        if (b._isRenderLeaf(this)) {
            // Stitch the new patch immediately; the revision makes existing
            // neighbouring leaves refresh once later in this frame.
            b._markTopologyChanged();
            b._refreshSingleNodeStitching(this);
        }
    }


    disposeMesh() {
        this._genPending = false;
        this._pendingJobId = 0;
        this._forceOceanMesh = false;
        this._edgeGridN = 0;
        this._edgeSource = null;
        this._oceanEdgeSource = null;
        this._edgeNeighborIds.fill(-1);
        if (this.meshMain) {
            this.meshMain.geometry.dispose();
            this.body.terrain.remove(this.meshMain);
            this.meshMain = null;
        }
        if (this.meshOcean) {
            this.meshOcean.geometry.dispose();
            this.body.ocean?.remove(this.meshOcean);
            this.meshOcean = null;
        }
    }
    split() {
        const started = this.requestSplit();
        this._finalizeSplitIfReady();
        return started;
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


        this.terrainShader = null;
        this.terrainUniforms = null;
        this.terrainMat = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            roughness: 0.98,
            metalness: 0.0,
            side: THREE.FrontSide,
        });

        // Eclipse ownership is deliberately left to the shared SuperPointLight
        // patch. That gives terrain the same world-space eclipse visibility as
        // every other standard lit material: PointLight outside the focused cone,
        // SpotLight inside it. Terrain keeps only its body-local cloud attenuation.

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

            shader.uniforms.uPlanetCenterW = { value: new THREE.Vector3() };
            shader.uniforms.uPlanetRadius = { value: this.baseRadius };
            shader.uniforms.uSunPosW = { value: new THREE.Vector3(1, 0, 0) };
            shader.uniforms.uTime = { value: 0.0 };
            shader.uniforms.uCloudNoiseTex = {
                value: this.cfg.cloudNoiseTexture ?? null,
            };
            shader.uniforms.uCloudNoiseAtlasSize = {
                value: new THREE.Vector2(
                    this.cfg.cloudNoiseLayout?.atlasWidth ??
                        VOLUME_NOISE_ATLAS_WIDTH,
                    this.cfg.cloudNoiseLayout?.atlasHeight ??
                        VOLUME_NOISE_ATLAS_HEIGHT,
                ),
            };
            shader.uniforms.uCloudNoiseGrid = {
                value: new THREE.Vector2(
                    this.cfg.cloudNoiseLayout?.gridX ?? VOLUME_NOISE_GRID_X,
                    this.cfg.cloudNoiseLayout?.gridY ?? VOLUME_NOISE_GRID_Y,
                ),
            };
            shader.uniforms.uCloudNoiseSize = {
                value: this.cfg.cloudNoiseLayout?.size ?? VOLUME_NOISE_SIZE,
            };
            shader.uniforms.uCloudBase = { value: this.baseRadius * 0.035 };
            shader.uniforms.uCloudThickness = { value: this.baseRadius * 0.06 };
            shader.uniforms.uCloudCoverage = { value: 0.61 };
            shader.uniforms.uCloudSoftness = { value: 0.20 };
            shader.uniforms.uCloudFreq = { value: 9.0 };
            shader.uniforms.uCloudNoiseOffset = {
                value: (() => {
                    const random = terrainMulberry32(
                        ((this.cfg.seed ?? 1) ^ 0x9e3779b9) >>> 0,
                    );
                    return new THREE.Vector3(
                        random() * 13.0,
                        random() * 13.0,
                        random() * 13.0,
                    );
                })(),
            };
            shader.uniforms.uCloudWindSpeed = { value: 0.025 };
            shader.uniforms.uCloudShadowStrength = {
                // Cloud shadows only exist on bodies that actually own an
                // atmosphere and have clouds. Airless moons/planets defaulted
                // hasClouds to undefined, which previously enabled fake shadows.
                value:
                    this.hasAtmo && this.cfg.hasClouds !== false
                        ? 0.85
                        : 0.0,
            };

            this.terrainShader = shader;
            this.terrainUniforms = shader.uniforms;
            this.terrainMat.userData.shader = shader;

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

uniform vec3 uPlanetCenterW;
uniform float uPlanetRadius;
uniform vec3 uSunPosW;
uniform float uTime;
uniform sampler2D uCloudNoiseTex;
uniform vec2 uCloudNoiseAtlasSize;
uniform vec2 uCloudNoiseGrid;
uniform float uCloudNoiseSize;
uniform float uCloudBase;
uniform float uCloudThickness;
uniform float uCloudCoverage;
uniform float uCloudSoftness;
uniform float uCloudFreq;
uniform vec3 uCloudNoiseOffset;
uniform float uCloudWindSpeed;
uniform float uCloudShadowStrength;

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


vec2 cloudNoiseSliceUv(float slice, vec2 xy){
  float stride = uCloudNoiseSize + 2.0;
  vec2 tile = vec2(
    mod(slice, uCloudNoiseGrid.x),
    floor(slice / uCloudNoiseGrid.x)
  );
  vec2 pixel = tile * stride + vec2(1.5) + fract(xy) * uCloudNoiseSize;
  return pixel / uCloudNoiseAtlasSize;
}

vec4 sampleCloudNoiseLocal(vec3 p){
  vec3 q = fract(p);
  float z = q.z * uCloudNoiseSize;
  float z0 = floor(z);
  float z1 = mod(z0 + 1.0, uCloudNoiseSize);
  float fz = fract(z);
  vec4 a = texture2D(uCloudNoiseTex, cloudNoiseSliceUv(z0, q.xy));
  vec4 b = texture2D(uCloudNoiseTex, cloudNoiseSliceUv(z1, q.xy));
  return mix(a, b, fz);
}

float terrainCloudDensity(vec3 pW){
  if (uCloudShadowStrength <= 0.001 || uCloudThickness <= 0.0) return 0.0;
  vec3 lp = pW - uPlanetCenterW;
  float r = length(lp);
  vec3 dir = lp / max(r, 1e-6);
  float timeShift = uTime * uCloudWindSpeed;
  float cs = cos(timeShift), sn = sin(timeShift);
  vec3 d2 = vec3(dir.x * cs - dir.z * sn, dir.y, dir.x * sn + dir.z * cs);
  float cloudBaseR = uPlanetRadius + uCloudBase;
  float h01 = clamp((r - cloudBaseR) / max(uCloudThickness, 1e-4), 0.0, 1.0);
  vec3 flow1 = vec3(0.37, 0.00, 0.29) * timeShift;
  vec3 heightWarp = vec3(0.0, (h01 - 0.5) * 0.35, 0.0);
  vec3 qBase = d2 * uCloudFreq + flow1 + heightWarp + uCloudNoiseOffset;
  vec4 macroNoise = sampleCloudNoiseLocal(qBase * 0.11);
  float macroShape = macroNoise.r;
  float weather = smoothstep(0.15, 0.85, macroNoise.b);
  float localCoverage = uCloudCoverage + (0.5 - weather) * 0.16;
  float base = smoothstep(
    localCoverage,
    localCoverage + max(uCloudSoftness, 1e-4),
    macroShape
  );
  base = pow(clamp(base, 0.0, 1.0), 1.12);
  float profile = smoothstep(0.0, 0.08, h01) * (1.0 - smoothstep(0.58, 1.0, h01));
  return clamp(base * profile, 0.0, 1.0);
}

float terrainCloudShadow(vec3 pW, vec3 sunDir, vec3 upW){
  if (uCloudShadowStrength <= 0.001 || uCloudThickness <= 0.0) return 1.0;
  float day = smoothstep(0.0, 0.12, dot(upW, sunDir));
  if (day <= 0.0) return 1.0;
  float innerR = uPlanetRadius + uCloudBase;
  float outerR = innerR + uCloudThickness;
  vec3 ro = pW + upW * 1.0;
  vec3 rel = ro - uPlanetCenterW;
  float b = dot(rel, sunDir);
  float cOuter = dot(rel, rel) - outerR * outerR;
  float hOuter = b * b - cOuter;
  if (hOuter <= 0.0) return 1.0;
  float sqrtOuter = sqrt(hOuter);
  float s0 = max(-b - sqrtOuter, 0.0);
  float s1 = -b + sqrtOuter;
  float cInner = dot(rel, rel) - innerR * innerR;
  float hInner = b * b - cInner;
  if (hInner > 0.0) {
    float sqrtInner = sqrt(hInner);
    float innerExit = -b + sqrtInner;
    if (innerExit > s0) s0 = innerExit;
  }
  if (s1 <= s0) return 1.0;

  float optical = 0.0;
  float dt = (s1 - s0) / 4.0;
  for (int i = 0; i < 4; i++) {
    float tRay = s0 + (float(i) + 0.5) * dt;
    vec3 samplePos = ro + sunDir * tRay;
    optical += terrainCloudDensity(samplePos) * (dt / max(uCloudThickness, 1e-4));
  }
  float transmittance = exp(-optical * 2.6);
  return mix(1.0, transmittance, clamp(uCloudShadowStrength, 0.0, 1.0) * day);
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

            shader.fragmentShader = shader.fragmentShader.replace(
                "#include <lights_fragment_end>",
                `#include <lights_fragment_end>
vec3 terrainUpW = normalize(vWorldPos - uPlanetCenterW);
vec3 terrainSunDir = normalize(uSunPosW - vWorldPos);
// Analytic eclipse attenuation is already applied per-light by the shared SPL
// patch. Keep terrain's local cloud shadow as a separate material effect so the
// eclipse is not double-applied inside or outside the focused spotlight cone.
float terrainCloudAtten = terrainCloudShadow(
    vWorldPos,
    terrainSunDir,
    terrainUpW
);
reflectedLight.directDiffuse *= terrainCloudAtten;
reflectedLight.directSpecular *= terrainCloudAtten;`,
            );
        };
        this.terrainMat.needsUpdate = true;

        // Ocean surfaces use the same quadtree leaves, split/merge transitions,
        // horizon coverage and coarse-edge stitching as terrain. The material is
        // shared by every wet patch on this body.
        this.oceanColor = new THREE.Color(cfg.oceanColor ?? 0x0b2a45);
        this.ocean = null;
        this.oceanFarMesh = null;
        this.oceanMaterial = null;
        this.oceanUniforms = null;
        this._oceanOccCenters = null;
        this._oceanOccRadii = null;
        this.oceanSurfaceDisplacement = 0.0;
        this._oceanWaveSampleLocal = new THREE.Vector3();

        if (this.hasOcean) {
            this.ocean = new THREE.Group();
            this.ocean.name = `${cfg.name ?? "planet"}-ocean-patches`;
            this.group.add(this.ocean);

            const oceanSetup = createOceanMaterial(cfg, this.seaLevel);
            this.oceanMaterial = oceanSetup.material;
            this.oceanUniforms = oceanSetup.uniforms;
            this.oceanColor.copy(oceanSetup.color);
            this.oceanSurfaceDisplacement =
                oceanSetup.maxDisplacement ?? 0.0;
            this._oceanOccCenters =
                this.oceanUniforms.uOccCenters.value;
            this._oceanOccRadii =
                this.oceanUniforms.uOccRadii.value;

            if (
                this._oceanOccRadii.length !== OCEAN_MAX_OCCLUDERS ||
                this._oceanOccCenters.length !== OCEAN_MAX_OCCLUDERS * 3
            ) {
                throw new Error("Ocean occluder buffer size mismatch");
            }
        }

        const seabedDepth = cfg.seabedDepth ?? heightAmp * 0.2;
        this.seabedDepth = seabedDepth;

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

        // Terrain behind the planet cannot contribute to the frame. Ocean
        // worlds can use the ocean surface itself; airless worlds use the
        // guaranteed minimum radius of the bounded FBM terrain function.
        this.horizonOccluderRadius = this.hasOcean
            ? Math.max(1.0, this.seaLevel - 0.5)
            : Math.max(
                  1.0,
                  this.baseRadius -
                      this.heightAmp * TERRAIN_FBM_ABS_MAX -
                      0.5,
              );
        this.horizonCullPadding = THREE.MathUtils.degToRad(
            cfg.horizonCullPaddingDeg ?? 0.75,
        );

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
        // The low-detail far sphere is visible across the whole system and is
        // not worth an additional shadow draw. Near terrain patches still cast.
        this.farMesh.castShadow = false;
        this.farMesh.receiveShadow = true;
        this.group.add(this.farMesh);

        // Match the terrain's far-LOD strategy: distant ocean worlds render a
        // single low-poly water surface, while nearby worlds switch to the
        // stitched quadtree patches. Opaque far terrain supplies the exact
        // coastline through the depth buffer, so this remains one water draw.
        if (this.hasOcean && this.oceanMaterial) {
            const farTerrainPositions =
                farGeo.getAttribute("position").array;
            const farOceanGeometry = buildOceanPatchGeometry({
                terrainPositions: farTerrainPositions,
                index: farGeo.index?.array ?? null,
                seaLevel: this.seaLevel,
                force: true,
                maxDisplacement: this.oceanSurfaceDisplacement,
            });
            this.oceanFarMesh = new THREE.Mesh(
                farOceanGeometry,
                this.oceanMaterial,
            );
            this.oceanFarMesh.name = `${cfg.name ?? "planet"}-ocean-far`;
            this.oceanFarMesh.castShadow = false;
            this.oceanFarMesh.receiveShadow = false;
            this.oceanFarMesh.renderOrder = 1;
            this.oceanFarMesh.visible = false;
            this.group.add(this.oceanFarMesh);
        }

        const requestedPatchGridN = Math.max(
            2,
            Math.floor(cfg.patchGridN ?? 12),
        );
        this.patchGridN =
            requestedPatchGridN + (requestedPatchGridN & 1);
        this.maxLevel = cfg.maxLevel ?? 9;
        this.edgeStitchingEnabled = true;
        if (this.patchGridN !== requestedPatchGridN) {
            console.warn(
                `QuadSphereBody: patchGridN=${requestedPatchGridN} is odd; ` +
                    `using ${this.patchGridN} so crack-free LOD stitching remains enabled.`,
            );
        }
        this.splitBudgetPerFrame = cfg.splitBudgetPerFrame ?? 6;
        this.mergeBudgetPerFrame = cfg.mergeBudgetPerFrame ?? 6;
        this.baseSplitFactor = cfg.baseSplitFactor ?? 9.2;
        this.baseMergeFactor = cfg.baseMergeFactor ?? 14.2;
        this.terrainPatchBudget = Math.max(
            6,
            Math.floor(cfg.terrainPatchBudget ?? 256),
        );

        this.activeDist = cfg.activeDist ?? baseRadius * 26.0;
        this.lodDist = cfg.lodDist ?? baseRadius * 18.0;
        this.nodeCullFactor = cfg.nodeCullFactor ?? 2.2;

        this._nextPatchNodeId = 1;
        this._topologyRevision = 1;
        this._edgeRefreshRevision = 0;
        this._balanceVisitToken = 0;
        this._edgeDescriptorScratch = {
            face: 0,
            edge: 0,
            orientation: 1,
            line: 0,
        };
        this._edgeNeighbourScratch = [];
        this._mergeNeighbourScratch = [];
        this._balanceNeighbourScratch = Array.from(
            { length: this.maxLevel + 3 },
            () => [],
        );
        this._renderLeavesScratch = [];
        this._topologyStackScratch = [];
        this._lodOrderScratch = [];
        this._stitchLinksScratch = [null, null, null, null];
        this._emptyEdgeLinks = [null, null, null, null];

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
        this._viewCamLocal = new THREE.Vector3();
        this._viewCamWorld = new THREE.Vector3();
        this._toNodeLocal = new THREE.Vector3();
        this._tmpQ = new THREE.Quaternion();

        // Exact rendered-terrain collision scratch. Vehicle physics can query
        // the triangles that are actually on screen instead of colliding with
        // the smooth analytic FBM between mesh vertices. This matters on steep
        // terrain, where a triangulated LOD patch and the continuous height
        // function can differ visibly by several centimetres/metres.
        this._collisionRay = new THREE.Ray();
        this._collisionRayOrigin = new THREE.Vector3();
        this._collisionRayDir = new THREE.Vector3();
        this._collisionHit = new THREE.Vector3();
        this._collisionA = new THREE.Vector3();
        this._collisionB = new THREE.Vector3();
        this._collisionC = new THREE.Vector3();
        this._collisionEdgeA = new THREE.Vector3();
        this._collisionEdgeB = new THREE.Vector3();
        this._collisionDelta = new THREE.Vector3();
        this._collisionLeavesScratch = [];

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

    _renderLeafCenterDirDot(node, dx, dy, dz) {
        const u = (node.u0 + node.u1) * 0.5;
        const v = (node.v0 + node.v1) * 0.5;
        faceUvToCubeXYZ(node.face, u, v, _tmpCube);
        cubeToCubesphereDirXYZ(
            _tmpCube[0],
            _tmpCube[1],
            _tmpCube[2],
            _tmpDir,
        );
        return _tmpDir[0] * dx + _tmpDir[1] * dy + _tmpDir[2] * dz;
    }

    _findRenderLeafNearDirection(dx, dy, dz) {
        let node = null;
        let bestDot = -Infinity;
        for (let i = 0; i < this.roots.length; i++) {
            const candidate = this.roots[i];
            const d = this._renderLeafCenterDirDot(candidate, dx, dy, dz);
            if (d > bestDot) {
                bestDot = d;
                node = candidate;
            }
        }
        if (!node) return null;

        let lastMeshNode = node.hasMesh() ? node : null;
        while (node.children) {
            // Match the render topology rules: a splitting parent remains the
            // authoritative visible surface until all children are ready.
            if (node._splitInProgress && node.hasMesh()) return node;

            let child = null;
            bestDot = -Infinity;
            for (let i = 0; i < node.children.length; i++) {
                const candidate = node.children[i];
                const d = this._renderLeafCenterDirDot(
                    candidate,
                    dx,
                    dy,
                    dz,
                );
                if (d > bestDot) {
                    bestDot = d;
                    child = candidate;
                }
            }
            if (!child) break;
            node = child;
            if (node.hasMesh()) lastMeshNode = node;
        }
        return node?.hasMesh() ? node : lastMeshNode;
    }

    _rayIntersectsPatchBoundsLocal(origin, direction, node, maxDistance) {
        const cx = node.boundCenter.x - origin.x;
        const cy = node.boundCenter.y - origin.y;
        const cz = node.boundCenter.z - origin.z;
        const along = cx * direction.x + cy * direction.y + cz * direction.z;
        const centerSq = cx * cx + cy * cy + cz * cz;
        const radiusSq = node.boundRadius * node.boundRadius;
        const perpSq = Math.max(0.0, centerSq - along * along);
        if (perpSq > radiusSq) return false;
        const half = Math.sqrt(Math.max(0.0, radiusSq - perpSq));
        return along + half >= 0.0 && along - half <= maxDistance;
    }

    _intersectRenderedPatchRayLocal(
        node,
        origin,
        direction,
        maxDistance,
        outPoint,
        outNormal,
    ) {
        const mesh = node?.meshMain;
        const geometry = mesh?.geometry;
        const position = geometry?.attributes?.position;
        const index = geometry?.index;
        if (!mesh?.visible || !position || !index) return Infinity;
        if (!this._rayIntersectsPatchBoundsLocal(origin, direction, node, maxDistance)) {
            return Infinity;
        }

        const pos = position.array;
        const idx = index.array;
        const ray = this._collisionRay;
        ray.origin.copy(origin);
        ray.direction.copy(direction);

        let bestDistance = Infinity;
        for (let i = 0; i < idx.length; i += 3) {
            const ia = idx[i] * 3;
            const ib = idx[i + 1] * 3;
            const ic = idx[i + 2] * 3;
            this._collisionA.set(pos[ia], pos[ia + 1], pos[ia + 2]);
            this._collisionB.set(pos[ib], pos[ib + 1], pos[ib + 2]);
            this._collisionC.set(pos[ic], pos[ic + 1], pos[ic + 2]);

            const hit = ray.intersectTriangle(
                this._collisionA,
                this._collisionB,
                this._collisionC,
                false,
                this._collisionHit,
            );
            if (!hit) continue;
            this._collisionDelta.copy(hit).sub(origin);
            const distance = this._collisionDelta.dot(direction);
            if (distance < -1e-5 || distance > maxDistance || distance >= bestDistance) {
                continue;
            }

            bestDistance = distance;
            outPoint.copy(hit);
            this._collisionEdgeA.copy(this._collisionB).sub(this._collisionA);
            this._collisionEdgeB.copy(this._collisionC).sub(this._collisionA);
            outNormal.copy(this._collisionEdgeA).cross(this._collisionEdgeB);
            if (outNormal.lengthSq() <= 1e-12) {
                outNormal.copy(outPoint).normalize();
            } else {
                outNormal.normalize();
            }
            // Terrain winding should already face outward, but stitched edge
            // triangles and cube seams are safer if collision enforces it.
            if (outNormal.dot(outPoint) < 0.0) outNormal.negate();
        }
        return bestDistance;
    }

    raycastRenderedTerrainLocal(
        originLocal,
        directionLocal,
        maxDistance,
        outPoint,
        outNormal,
    ) {
        if (!originLocal || !directionLocal || !(maxDistance > 0.0)) return false;
        this._collisionRayOrigin.copy(originLocal);
        this._collisionRayDir.copy(directionLocal);
        if (this._collisionRayDir.lengthSq() <= 1e-12) return false;
        this._collisionRayDir.normalize();

        // Surface rays used by suspension/chassis start very close to the body,
        // so the origin's radial direction reliably identifies the visible
        // quadtree leaf without needing an expensive global mesh search.
        this._collisionDelta.copy(originLocal);
        if (this._collisionDelta.lengthSq() <= 1e-12) return false;
        this._collisionDelta.normalize();
        const primary = this._findRenderLeafNearDirection(
            this._collisionDelta.x,
            this._collisionDelta.y,
            this._collisionDelta.z,
        );

        let best = this._intersectRenderedPatchRayLocal(
            primary,
            this._collisionRayOrigin,
            this._collisionRayDir,
            maxDistance,
            outPoint,
            outNormal,
        );
        if (Number.isFinite(best)) return true;

        // Near cube/patch seams the closest-center traversal can pick the
        // adjacent leaf. Fall back to the small set of rendered leaves whose
        // exact padded bounds intersect the ray, then test their triangles.
        const leaves = this._collectRenderLeaves(this._collisionLeavesScratch);
        for (let i = 0; i < leaves.length; i++) {
            const node = leaves[i];
            if (node === primary) continue;
            if (!this._rayIntersectsPatchBoundsLocal(
                this._collisionRayOrigin,
                this._collisionRayDir,
                node,
                maxDistance,
            )) continue;

            const distance = this._intersectRenderedPatchRayLocal(
                node,
                this._collisionRayOrigin,
                this._collisionRayDir,
                maxDistance,
                this._collisionHit,
                this._collisionEdgeA,
            );
            if (!Number.isFinite(distance) || distance >= best) continue;
            best = distance;
            outPoint.copy(this._collisionHit);
            outNormal.copy(this._collisionEdgeA);
        }
        return Number.isFinite(best);
    }

    sampleRenderedTerrainSurfaceLocal(pointLocal, normalOut, surfaceOut) {
        if (!pointLocal || !normalOut || !surfaceOut) return NaN;
        const rSq = pointLocal.lengthSq();
        if (rSq <= 1e-12) return NaN;

        this._collisionRayDir.copy(pointLocal).multiplyScalar(1.0 / Math.sqrt(rSq));
        const terrainExtent = this.heightAmp * TERRAIN_FBM_ABS_MAX;
        const innerRadius = Math.max(
            0.1,
            this.baseRadius - terrainExtent - Math.max(4.0, this.seabedDepth ?? 0.0),
        );
        const outerRadius = this.baseRadius + terrainExtent + 8.0;
        this._collisionRayOrigin
            .copy(this._collisionRayDir)
            .multiplyScalar(innerRadius);

        if (!this.raycastRenderedTerrainLocal(
            this._collisionRayOrigin,
            this._collisionRayDir,
            Math.max(1.0, outerRadius - innerRadius),
            this._collisionHit,
            normalOut,
        )) {
            return NaN;
        }

        // Use the exact rendered triangle plane, not the radial hit distance.
        // This gives wheel/chassis spheres the same slope and height the player
        // sees while still returning a shortest-plane contact point.
        this._collisionDelta.copy(pointLocal).sub(this._collisionHit);
        const signedDistance = this._collisionDelta.dot(normalOut);
        surfaceOut.copy(pointLocal).addScaledVector(normalOut, -signedDistance);
        return signedDistance;
    }

    oceanSurfaceRadiusAtLocalPoint(localPoint) {
        if (!this.hasOcean || !this.oceanUniforms || !localPoint) {
            return this.seaLevel;
        }

        // Ocean displacement is authored in body-local coordinates. Keeping a
        // local-space sampler lets gameplay physics use the exact same animated
        // wave surface without re-introducing planet translation/spin into a
        // body-local solver such as the rover physics.
        const local = this._oceanWaveSampleLocal.copy(localPoint);
        const lenSq = local.lengthSq();
        if (lenSq <= 1e-12) return this.seaLevel;
        local.multiplyScalar(this.seaLevel / Math.sqrt(lenSq));

        return (
            this.seaLevel +
            evaluateOceanVertexHeightCPU(local, this.oceanUniforms)
        );
    }

    oceanSurfaceRadiusAtWorldPoint(worldPoint) {
        if (!this.hasOcean || !this.oceanUniforms || !worldPoint) {
            return this.seaLevel;
        }

        // World callers are converted once into the same body-local input used
        // by the ocean vertex shader, then delegated to the local sampler above.
        const local = this._oceanWaveSampleLocal.copy(worldPoint);
        this.group.worldToLocal(local);
        return this.oceanSurfaceRadiusAtLocalPoint(local);
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
        if (this.ocean) this.ocean.visible = on;
        if (this.oceanFarMesh) this.oceanFarMesh.visible = !on;
        if (!on) this.forceRootsOnly();
        else {
            this._edgeRefreshRevision = -1;
            for (const r of this.roots) r.ensureMesh();
        }
    }

    setTerrainPatchBudget(value) {
        const next = Math.max(6, Math.floor(Number(value) || 6));
        const previous = this.terrainPatchBudget;
        this.terrainPatchBudget = next;

        // Quality is normally selected before terrain grows. If it is lowered
        // at runtime, collapse once and let the normal prioritized refinement
        // rebuild within the new cap instead of retaining an oversized tree.
        if (
            next < previous &&
            this.roots?.length &&
            this._countTopologyLeaves() > next
        ) {
            this.forceRootsOnly();
        }
    }
    forceRootsOnly() {
        let allRootsReady = true;

        // Build any missing root surfaces first, but keep them hidden while
        // their detailed children remain authoritative. This avoids exposing
        // one coarse cube face beside another face that is still deeply split.
        for (const root of this.roots) {
            if (root._splitInProgress) {
                if (root.hasMesh()) {
                    // The parent is already the visible coverage; cancel the
                    // unfinished split immediately.
                    for (const child of root.children) child.destroy(true);
                    root.children = null;
                    root._splitInProgress = false;
                    root._mergeInProgress = false;
                    root._setMeshVisible(true);
                } else {
                    // Children may currently be the only available coverage.
                    // Keep them until the missing root surface is ready.
                    root._splitInProgress = false;
                    root._mergeInProgress = true;
                }
            } else if (root.children) {
                root._mergeInProgress = true;
            }

            root.ensureMesh();
            if (!root.hasMesh()) allRootsReady = false;
            if (root.children && root.hasMesh()) root._setMeshVisible(false);
        }

        if (allRootsReady) {
            let changed = false;
            for (const root of this.roots) {
                root._setMeshVisible(true);
                if (!root.children) continue;
                for (const child of root.children) child.destroy(true);
                root.children = null;
                root._splitInProgress = false;
                root._mergeInProgress = false;
                changed = true;
            }
            if (changed) this._markTopologyChanged();
        }

        this._refreshEdgeStitchingIfNeeded();
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
    _markTopologyChanged() {
        this._topologyRevision++;
    }

    _countTopologyLeaves() {
        const stack = this._topologyStackScratch;
        stack.length = 0;
        for (let i = 0; i < this.roots.length; i++) stack.push(this.roots[i]);

        let count = 0;
        while (stack.length) {
            const node = stack.pop();
            if (node.children) {
                for (let i = 0; i < node.children.length; i++) {
                    stack.push(node.children[i]);
                }
            } else {
                count++;
            }
        }
        return count;
    }

    _isRenderLeaf(node) {
        if (!node?.hasMesh()) return false;
        for (let p = node.parent; p; p = p.parent) {
            if (p._splitInProgress && p.hasMesh()) return false;
        }
        if (!node.children) return true;
        return node._splitInProgress && node.hasMesh();
    }

    _findRenderLeafAt(face, u, v) {
        let node = this.roots[face | 0];
        if (!node) return null;
        u = Math.max(-1, Math.min(1, u));
        v = Math.max(-1, Math.min(1, v));

        while (node.children) {
            // During a split the parent remains the authoritative coverage
            // until all four children are available. During a merge the
            // children remain authoritative until the parent replaces them.
            if (node._splitInProgress && node.hasMesh()) return node;

            const um = (node.u0 + node.u1) * 0.5;
            const vm = (node.v0 + node.v1) * 0.5;
            const ix = u >= um ? 1 : 0;
            const iy = v >= vm ? 1 : 0;
            node = node.children[ix + iy * 2];
        }
        return node;
    }

    _describeAdjacentEdge(node, edge, out) {
        const boundaryEps = 1e-12;
        let internal = false;
        let line = 0;

        switch (edge) {
            case EDGE_V_MIN:
                internal = node.v0 > -1 + boundaryEps;
                line = node.v0;
                break;
            case EDGE_V_MAX:
                internal = node.v1 < 1 - boundaryEps;
                line = node.v1;
                break;
            case EDGE_U_MIN:
                internal = node.u0 > -1 + boundaryEps;
                line = node.u0;
                break;
            default:
                internal = node.u1 < 1 - boundaryEps;
                line = node.u1;
                break;
        }

        if (internal) {
            out.face = node.face;
            out.edge = oppositePatchEdge(edge);
            out.orientation = 1;
            out.line = line;
            return out;
        }

        const adjacent = CUBE_FACE_EDGE_ADJACENCY[node.face][edge];
        out.face = adjacent[0];
        out.edge = adjacent[1];
        out.orientation = adjacent[2];
        out.line =
            out.edge === EDGE_V_MIN || out.edge === EDGE_U_MIN ? -1 : 1;
        return out;
    }

    _collectRenderNeighbours(node, edge, out) {
        out.length = 0;
        const desc = this._describeAdjacentEdge(
            node,
            edge,
            this._edgeDescriptorScratch,
        );
        const source0 =
            edge === EDGE_V_MIN || edge === EDGE_V_MAX ? node.u0 : node.v0;
        const source1 =
            edge === EDGE_V_MIN || edge === EDGE_V_MAX ? node.u1 : node.v1;
        const target0 = desc.orientation * source0;
        const target1 = desc.orientation * source1;
        const lo = Math.min(target0, target1);
        const hi = Math.max(target0, target1);
        const range = Math.max(1e-12, hi - lo);
        const alongEps = Math.max(1e-9, range * 1e-6);
        const inwardEps = Math.max(1e-9, range * 1e-6);
        let cursor = lo;
        let guard = 0;

        while (cursor < hi - 1e-10 && guard++ < 64) {
            const remaining = hi - cursor;
            const along =
                remaining <= alongEps * 2
                    ? (cursor + hi) * 0.5
                    : cursor + alongEps;
            let u = along;
            let v = along;
            switch (desc.edge) {
                case EDGE_V_MIN:
                    v = desc.line + inwardEps;
                    break;
                case EDGE_V_MAX:
                    v = desc.line - inwardEps;
                    break;
                case EDGE_U_MIN:
                    u = desc.line + inwardEps;
                    break;
                default:
                    u = desc.line - inwardEps;
                    break;
            }

            const neighbour = this._findRenderLeafAt(desc.face, u, v);
            if (!neighbour || neighbour === node) break;
            if (out[out.length - 1] !== neighbour) out.push(neighbour);

            const neighbourHi =
                desc.edge === EDGE_V_MIN || desc.edge === EDGE_V_MAX
                    ? neighbour.u1
                    : neighbour.v1;
            let next = Math.min(hi, neighbourHi);
            if (next <= cursor + 1e-10) {
                next = Math.min(hi, cursor + Math.max(alongEps, range / 1024));
            }
            cursor = next;
        }
        return out;
    }

    _collectRenderLeaves(out) {
        out.length = 0;
        const stack = [...this.roots];
        while (stack.length) {
            const node = stack.pop();
            if (node.children) {
                if (node._splitInProgress && node.hasMesh()) {
                    out.push(node);
                } else {
                    for (let i = 0; i < node.children.length; i++) {
                        stack.push(node.children[i]);
                    }
                }
            } else if (node.hasMesh()) {
                out.push(node);
            }
        }
        return out;
    }

    _refreshSingleNodeStitching(node) {
        if (!this.edgeStitchingEnabled || !this._isRenderLeaf(node)) return;
        const links = this._stitchLinksScratch;
        for (let edge = 0; edge < EDGE_COUNT; edge++) {
            links[edge] = null;
            const neighbours = this._collectRenderNeighbours(
                node,
                edge,
                this._edgeNeighbourScratch,
            );
            // A fine edge maps to exactly one coarse neighbour in a balanced
            // quadtree. Transitional parent coverage keeps the surface closed
            // until that steady-state relationship is available.
            if (
                neighbours.length === 1 &&
                neighbours[0].level === node.level - 1 &&
                neighbours[0].hasMesh() &&
                neighbours[0]._edgeSource
            ) {
                links[edge] = neighbours[0];
            }
        }
        node._applyEdgeLinks(links);
    }

    _refreshEdgeStitchingIfNeeded(force = false) {
        if (!this.edgeStitchingEnabled) return;
        if (!force && this._edgeRefreshRevision === this._topologyRevision) return;

        const leaves = this._collectRenderLeaves(this._renderLeavesScratch);
        for (let i = 0; i < leaves.length; i++) {
            this._refreshSingleNodeStitching(leaves[i]);
        }
        this._edgeRefreshRevision = this._topologyRevision;
    }

    _findBalanceSplitCandidateInner(node, token, depth) {
        if (!node || node._balanceVisit === token) return null;
        node._balanceVisit = token;
        const scratch =
            this._balanceNeighbourScratch[
                Math.min(depth, this._balanceNeighbourScratch.length - 1)
            ];

        for (let edge = 0; edge < EDGE_COUNT; edge++) {
            const neighbours = this._collectRenderNeighbours(node, edge, scratch);
            for (let i = 0; i < neighbours.length; i++) {
                const neighbour = neighbours[i];
                // Splitting node L creates children L+1, so every active
                // neighbour must already be at least level L.
                if (neighbour.level >= node.level) continue;
                const deeper = this._findBalanceSplitCandidateInner(
                    neighbour,
                    token,
                    depth + 1,
                );
                return deeper || neighbour;
            }
        }
        return null;
    }

    _findBalanceSplitCandidate(node) {
        const token = ++this._balanceVisitToken;
        return this._findBalanceSplitCandidateInner(node, token, 0);
    }

    _canMergeBalanced(node) {
        for (let edge = 0; edge < EDGE_COUNT; edge++) {
            const neighbours = this._collectRenderNeighbours(
                node,
                edge,
                this._mergeNeighbourScratch,
            );
            for (let i = 0; i < neighbours.length; i++) {
                // Merging this node exposes level L. Account for a neighbour
                // whose parent is still the authoritative render leaf but whose
                // ready children will shortly become level L+2. Blocking that
                // merge here prevents a budget-capped split from waiting forever
                // for a balance prerequisite that no longer has room to start.
                const neighbour = neighbours[i];
                const futureLevel =
                    neighbour.level + (neighbour._splitInProgress ? 1 : 0);
                if (futureLevel > node.level + 1) return false;
            }
        }
        return true;
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

    _pushLodNodesNearFirst(stack, nodes) {
        const ordered = this._lodOrderScratch;
        ordered.length = 0;

        // Insert far-to-near because the traversal stack pops from the end.
        // This keeps the limited split budget focused around the player rather
        // than whichever cube face happens to appear last in a fixed array.
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const d2 = node.boundCenter.distanceToSquared(this._camLocal);
            node._lodDistanceSq = d2;
            let at = ordered.length;
            while (
                at > 0 &&
                ordered[at - 1]._lodDistanceSq < d2
            ) {
                at--;
            }
            ordered.splice(at, 0, node);
        }
        for (let i = 0; i < ordered.length; i++) stack.push(ordered[i]);
    }
    nodeInFrustum(node) {
        node._tmpWorldCenter
            .copy(node.boundCenter)
            .applyMatrix4(this.group.matrixWorld);
        this._sphereWorld.center.copy(node._tmpWorldCenter);
        this._sphereWorld.radius = node.boundRadius;
        return this._frustum.intersectsSphere(this._sphereWorld);
    }

    nodeVisibleAboveHorizon(node) {
        const occluderRadius = this.horizonOccluderRadius;
        const cameraLocal = this._viewCamLocal;
        const cameraRadius = cameraLocal.length();
        if (!(occluderRadius > 0) || cameraRadius <= occluderRadius + 0.25) {
            return true;
        }

        const toNode = this._toNodeLocal
            .copy(node.boundCenter)
            .sub(cameraLocal);
        const nodeDistance = toNode.length();
        const nodeRadius = Math.max(0.001, node.boundRadius);

        // Near/intersecting bounds are never horizon-culled.
        if (nodeDistance <= nodeRadius + 0.01) return true;

        // First require the node's complete apparent disk to fit inside the
        // planet's apparent disk. Anything touching the limb remains visible.
        const occAngle = Math.asin(
            THREE.MathUtils.clamp(occluderRadius / cameraRadius, 0.0, 0.999999),
        );
        const nodeAngle = Math.asin(
            THREE.MathUtils.clamp(nodeRadius / nodeDistance, 0.0, 0.999999),
        );
        const cosSeparation = THREE.MathUtils.clamp(
            -cameraLocal.dot(toNode) / (cameraRadius * nodeDistance),
            -1.0,
            1.0,
        );
        const separation = Math.acos(cosSeparation);
        if (
            separation + nodeAngle >=
            occAngle - this.horizonCullPadding
        ) {
            return true;
        }

        // The disks overlap, but near-side terrain is in front of the planet.
        // Cull only when the inner sphere is encountered before the nearest
        // point of the patch's conservative bounding sphere.
        const cameraDotDir = cameraLocal.dot(toNode) / nodeDistance;
        const discriminant =
            cameraDotDir * cameraDotDir -
            (cameraRadius * cameraRadius - occluderRadius * occluderRadius);
        if (discriminant <= 0.0) return true;

        const planetNear = -cameraDotDir - Math.sqrt(discriminant);
        const nodeNear = nodeDistance - nodeRadius;
        return planetNear + 0.5 >= nodeNear;
    }

    // LOD distance metrics should be based on the gameplay focus (player),
    // not the camera. The camera is still used for frustum culling.
    updateLOD(focusWorldPos, camera) {
        if (!this.terrainActive) return;

        this._camWorld.copy(focusWorldPos);
        this.group.updateMatrixWorld(true);
        this._invMat.copy(this.group.matrixWorld).invert();
        this._camLocal.copy(focusWorldPos).applyMatrix4(this._invMat);

        camera.updateMatrixWorld(true);
        camera.getWorldPosition(this._viewCamWorld);
        this._viewCamLocal
            .copy(this._viewCamWorld)
            .applyMatrix4(this._invMat);
        this._projView.multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse,
        );
        this._frustum.setFromProjectionMatrix(this._projView);

        let splitBudget = this.splitBudgetPerFrame;
        let mergeBudget = this.mergeBudgetPerFrame;
        let topologyLeaves = this._countTopologyLeaves();
        const stack = [];
        this._pushLodNodesNearFirst(stack, this.roots);

        while (stack.length) {
            const node = stack.pop();
            const inFrustum =
                this.nodeInFrustum(node) &&
                this.nodeVisibleAboveHorizon(node);
            const worth =
                inFrustum && this.nodeWorthTraversing(node, this._camLocal);

            // Outside the useful region, coarsen while preserving the 2:1
            // edge invariant. Coverage is never removed before replacement
            // geometry is ready.
            if (!worth) {
                if (node.children) {
                    if (node._splitInProgress) {
                        if (node.hasMesh()) {
                            for (const child of node.children) child.destroy(true);
                            node.children = null;
                            node._splitInProgress = false;
                        } else {
                            // The children may be the only completed coverage.
                            // Convert the transition into a merge and keep them
                            // visible until the parent surface arrives.
                            node._splitInProgress = false;
                            node._mergeInProgress = true;
                        }
                    }
                    if (node.children) {
                        if (this._canMergeBalanced(node)) {
                            node.merge();
                        } else {
                            this._pushLodNodesNearFirst(stack, node.children);
                        }
                    } else {
                        node.ensureMesh();
                    }
                } else {
                    node.ensureMesh();
                }
                continue;
            }

            if (node.children) {
                const shouldMerge =
                    node.level >= 1 && this.wantMerge(node, this._camLocal);

                if (node._splitInProgress && shouldMerge) {
                    if (node.hasMesh()) {
                        for (const child of node.children) child.destroy(true);
                        node.children = null;
                        node._splitInProgress = false;
                        node.ensureMesh();
                        continue;
                    }
                    node._splitInProgress = false;
                    node._mergeInProgress = true;
                    node.ensureMesh();
                }

                if (node._splitInProgress) {
                    this._pushLodNodesNearFirst(stack, node.children);

                    // Re-check balance at reveal time. A neighbouring merge
                    // may have completed while these children were building.
                    const prerequisite = this._findBalanceSplitCandidate(node);
                    if (prerequisite) {
                        if (
                            splitBudget > 0 &&
                            topologyLeaves + 3 <= this.terrainPatchBudget &&
                            !prerequisite.children &&
                            prerequisite.level < this.maxLevel
                        ) {
                            if (prerequisite.split()) {
                                splitBudget--;
                                topologyLeaves += 3;
                            }
                        }
                    } else {
                        node._finalizeSplitIfReady();
                    }
                    continue;
                }

                if (node._mergeInProgress && !shouldMerge) {
                    node.disposeMesh();
                    node._mergeInProgress = false;
                }

                if (shouldMerge) {
                    if (this._canMergeBalanced(node)) {
                        if (mergeBudget > 0 && !node._mergeInProgress) {
                            node.merge();
                            mergeBudget--;
                        } else if (node._mergeInProgress) {
                            node._finalizeMergeIfReady();
                        }
                    } else {
                        // Keep walking the detailed side so it can naturally
                        // coarsen before this parent is exposed.
                        this._pushLodNodesNearFirst(stack, node.children);
                    }
                } else {
                    this._pushLodNodesNearFirst(stack, node.children);
                }
                continue;
            }

            const shouldSplit =
                splitBudget > 0 &&
                topologyLeaves + 3 <= this.terrainPatchBudget &&
                node.level < this.maxLevel &&
                this.wantSplit(node, this._camLocal);

            if (shouldSplit) {
                const prerequisite = this._findBalanceSplitCandidate(node);
                if (prerequisite) {
                    // Balance outward first. If its children are already being
                    // built, simply wait for that split to become active.
                    if (
                        splitBudget > 0 &&
                        topologyLeaves + 3 <= this.terrainPatchBudget &&
                        !prerequisite.children &&
                        prerequisite.level < this.maxLevel
                    ) {
                        if (prerequisite.split()) {
                            splitBudget--;
                            topologyLeaves += 3;
                        }
                    }
                    node.ensureMesh();
                } else {
                    if (node.split()) {
                        splitBudget--;
                        topologyLeaves += 3;
                    }
                }
            } else {
                node.ensureMesh();
            }
        }

        this._refreshEdgeStitchingIfNeeded();
    }

    destroy() {
        for (const r of this.roots) r.destroy(true);
        if (this.oceanFarMesh) this.oceanFarMesh.geometry.dispose();
        if (this.oceanMaterial) this.oceanMaterial.dispose();
        this.farMesh.geometry.dispose();
        if (this.farMesh.material !== this.terrainMat) this.farMesh.material.dispose();
        this.terrainMat.dispose();
    }
}

////////////////////////////////////////////////////////////////////////////////
