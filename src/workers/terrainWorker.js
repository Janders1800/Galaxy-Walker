// src/workers/terrainWorker.js
// WebWorker: builds terrain patch vertex buffers off the main thread.
// This implementation mirrors the synchronous terrain generation in src/main.js.

const _bodies = new Map(); // bodyId -> { bodyCfg, biome }

const smoothstep = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smooth01 = (t) => t * t * (3 - 2 * t);
const smoothstep01 = (a, b, x) => smooth01(clamp01((x - a) / (b - a)));
const mix = (a, b, t) => a + (b - a) * t;

function hash3s(x, y, z, seed) {
                let h = (x | 0) ^ seed;
                h = Math.imul(h ^ (y | 0), 0x9e3779b1);
                h = Math.imul(h ^ (z | 0), 0x85ebca77);
                h ^= h >>> 16;
                return (h >>> 0) / 4294967295;
            }

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

function radiusAtDir(dx, dy, dz, cfg) {
  const h = fbm3Seeded(
    dx * cfg.heightFreq,
    dy * cfg.heightFreq,
    dz * cfg.heightFreq,
    (cfg.seed + 17) | 0,
    5,
    2.1,
    0.52,
  );
  const raw = cfg.baseRadius + cfg.heightAmp * h;
  return Math.max(raw, cfg.seaLevel - cfg.seabedDepth);
}

const _tmpCube = new Float32Array(3);
const _tmpDir = new Float32Array(3);
const _tmpNrm = new Float32Array(3);

function buildPatchBuffers(p, bodyCfg, biome) {
  const face = p.face | 0;
  const u0 = +p.u0, v0 = +p.v0, u1 = +p.u1, v1 = +p.v1;
  const gridN = p.gridN | 0;
  const normalEps = +p.normalEps;
  const skirtDepth = +p.skirtDepth;

  const N = gridN;
  const vertsPerSide = N + 1;
  const vertCount = vertsPerSide * vertsPerSide;

  const edgeVerts = 4 * vertsPerSide;
  const skirtBase = vertCount;
  const totalVerts = vertCount + edgeVerts;

  const pos2 = new Float32Array(totalVerts * 3);
  const nrm2 = new Float32Array(totalVerts * 3);
  const col2 = new Float32Array(totalVerts * 3);

  const baseRadius = bodyCfg.baseRadius;
  const seaLevel = bodyCfg.seaLevel;
  const heightAmp = bodyCfg.heightAmp;

  const C = biome;
  const deepW = C.deepWater,
    shallowW = C.shallowWater,
    sand = C.sand,
    grass = C.grass,
    rock = C.rock,
    snow = C.snow;

  const radiusAtDirFn = (dx, dy, dz) => radiusAtDir(dx, dy, dz, bodyCfg);
  const sdf = makePlanetSdf(radiusAtDirFn);

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

                        const r = radiusAtDirFn(dx, dy, dz);
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

  return { pos: pos2, nrm: nrm2, col: col2, gridN };
}

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg) return;

  if (msg.type === "initBody") {
    const bodyId = (msg.bodyId | 0);
    if (!bodyId) return;
    _bodies.set(bodyId, { bodyCfg: msg.bodyCfg, biome: msg.biome });
    return;
  }

  if (msg.type !== "build") return;

  const { id, params } = msg;
  try {
    const body = _bodies.get(params.bodyId | 0);
    if (!body) throw new Error("TerrainWorker: missing body config for bodyId=" + (params.bodyId | 0));
    const geo = buildPatchBuffers(params, body.bodyCfg, body.biome);
    self.postMessage(
      { type: "result", id, pos: geo.pos, nrm: geo.nrm, col: geo.col, gridN: geo.gridN },
      [geo.pos.buffer, geo.nrm.buffer, geo.col.buffer],
    );
  } catch (err) {
    self.postMessage({ type: "error", id, error: String(err && err.stack ? err.stack : err) });
  }
};
