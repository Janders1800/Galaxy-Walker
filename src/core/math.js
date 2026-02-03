// src/core/math.js
export function hash3s(x, y, z, seed) {
  let h = (x | 0) ^ seed;
  h = Math.imul(h ^ (y | 0), 0x9e3779b1);
  h = Math.imul(h ^ (z | 0), 0x85ebca77);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const lerp = (a, b, t) => a + (b - a) * t;

export function valueNoise3Seeded(px, py, pz, seed) {
  const x0 = Math.floor(px), y0 = Math.floor(py), z0 = Math.floor(pz);
  const x1 = x0 + 1, y1 = y0 + 1, z1 = z0 + 1;
  const tx = smoothstep(px - x0), ty = smoothstep(py - y0), tz = smoothstep(pz - z0);

  const c000 = hash3s(x0, y0, z0, seed);
  const c100 = hash3s(x1, y0, z0, seed);
  const c010 = hash3s(x0, y1, z0, seed);
  const c110 = hash3s(x1, y1, z0, seed);
  const c001 = hash3s(x0, y0, z1, seed);
  const c101 = hash3s(x1, y0, z1, seed);
  const c011 = hash3s(x0, y1, z1, seed);
  const c111 = hash3s(x1, y1, z1, seed);

  const x00 = lerp(c000, c100, tx);
  const x10 = lerp(c010, c110, tx);
  const x01 = lerp(c001, c101, tx);
  const x11 = lerp(c011, c111, tx);

  const y0v = lerp(x00, x10, ty);
  const y1v = lerp(x01, x11, ty);
  return lerp(y0v, y1v, tz) * 2 - 1;
}

export function fbm3Seeded(px, py, pz, seed, octaves = 5, lacunarity = 2.0, gain = 0.5) {
  let amp = 0.5;
  let freq = 1.0;
  let sum = 0.0;
  let norm = 0.0;

  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise3Seeded(px * freq, py * freq, pz * freq, seed + i * 1013);
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / Math.max(1e-8, norm);
}
