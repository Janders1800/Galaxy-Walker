// Shared deterministic texture-backed volume noise.
// Cloud channel packing is informed by SimonDev's Shaders_Clouds1
// (MIT, Copyright (c) 2022 simondevyoutube);
// this implementation is purpose-built for Galaxy Walker's spherical pass.
//
// WebGL1 has no 3D textures, so each volume is stored as a bordered 2D atlas
// of Z slices. Two filtered texture reads provide trilinear 3D sampling. The
// generic volume remains intentionally separate from the cloud volume so that
// improving cloud structure cannot silently change gas giants or ring dust.

export const VOLUME_NOISE_SIZE = 32;
export const VOLUME_NOISE_GRID_X = 8;
export const VOLUME_NOISE_GRID_Y = 4;
export const VOLUME_NOISE_BORDER = 1;
export const VOLUME_NOISE_STRIDE =
  VOLUME_NOISE_SIZE + VOLUME_NOISE_BORDER * 2;
export const VOLUME_NOISE_ATLAS_WIDTH =
  VOLUME_NOISE_GRID_X * VOLUME_NOISE_STRIDE;
export const VOLUME_NOISE_ATLAS_HEIGHT =
  VOLUME_NOISE_GRID_Y * VOLUME_NOISE_STRIDE;

// The cloud alpha channel stores a conservative lower bound on distance to
// possible cloud support. Distances are encoded in volume-voxel units so the
// runtime can convert them to world-space steps for any planet radius.
export const CLOUD_DISTANCE_MAX_CELLS = 4;
export const CLOUD_DISTANCE_REFERENCE_COVERAGE = 0.5;
export const CLOUD_DISTANCE_SUPPORT_BIAS = 0.04;
export const CLOUD_DISTANCE_MIN_COVERAGE =
  CLOUD_DISTANCE_REFERENCE_COVERAGE - CLOUD_DISTANCE_SUPPORT_BIAS;
export const CLOUD_DISTANCE_MARGIN_CELLS = 2.0;

export const VOLUME_NOISE_GLSL = `
uniform sampler2D uVolumeNoiseTex;
uniform vec2 uVolumeNoiseAtlasSize;
uniform vec2 uVolumeNoiseGrid;
uniform float uVolumeNoiseSize;

vec2 volumeNoiseSliceUv(float slice, vec2 xy){
  float stride = uVolumeNoiseSize + 2.0;
  vec2 tile = vec2(
    mod(slice, uVolumeNoiseGrid.x),
    floor(slice / uVolumeNoiseGrid.x)
  );
  // Interior texels start one pixel into each tile. The duplicated border lets
  // linear filtering wrap seamlessly at X/Y slice edges without atlas bleed.
  vec2 pixel = tile * stride + vec2(1.5) + fract(xy) * uVolumeNoiseSize;
  return pixel / uVolumeNoiseAtlasSize;
}

vec4 sampleVolumeNoise(vec3 p){
  vec3 q = fract(p);
  float z = q.z * uVolumeNoiseSize;
  float z0 = floor(z);
  float z1 = mod(z0 + 1.0, uVolumeNoiseSize);
  float fz = fract(z);
  vec4 a = texture2D(uVolumeNoiseTex, volumeNoiseSliceUv(z0, q.xy));
  vec4 b = texture2D(uVolumeNoiseTex, volumeNoiseSliceUv(z1, q.xy));
  return mix(a, b, fz);
}

float sampleVolumeFbm(vec3 p){
  vec4 n = sampleVolumeNoise(p);
  return dot(n, vec4(0.48, 0.27, 0.17, 0.08));
}
`;

// Dedicated cloud-channel layout:
//   R: broad tileable Perlin-Worley cloud shape
//   G: high-frequency Worley erosion/detail
//   B: low-frequency weather/coverage modulation
//   A: conservative lower-bound distance to possible cloud support
//
// Keeping this sampler separate from VOLUME_NOISE_GLSL lets the cloud shader
// evolve without perturbing other effects that use the generic volume atlas.
export const CLOUD_NOISE_GLSL = `
uniform float uCloudNoiseSize;
uniform float uCloudDistanceMaxCells;
uniform float uCloudDistanceMinCoverage;

#ifdef USE_CLOUD_NOISE_3D
uniform highp sampler3D uCloudNoiseTex3D;

vec4 sampleCloudNoise(vec3 p){
  // Match the atlas convention: p=0 addresses voxel 0's centre, not the
  // repeat seam between the last and first voxel.
  vec3 texelCenter = vec3(0.5 / max(uCloudNoiseSize, 1.0));
  return texture(uCloudNoiseTex3D, fract(p) + texelCenter);
}
#else
uniform sampler2D uCloudNoiseTex;
uniform vec2 uCloudNoiseAtlasSize;
uniform vec2 uCloudNoiseGrid;

vec2 cloudNoiseSliceUv(float slice, vec2 xy){
  float stride = uCloudNoiseSize + 2.0;
  vec2 tile = vec2(
    mod(slice, uCloudNoiseGrid.x),
    floor(slice / uCloudNoiseGrid.x)
  );
  vec2 pixel = tile * stride + vec2(1.5) + fract(xy) * uCloudNoiseSize;
  return pixel / uCloudNoiseAtlasSize;
}

vec4 sampleCloudNoise(vec3 p){
  vec3 q = fract(p);
  float z = q.z * uCloudNoiseSize;
  float z0 = floor(z);
  float z1 = mod(z0 + 1.0, uCloudNoiseSize);
  float fz = fract(z);
  vec4 a = texture2D(uCloudNoiseTex, cloudNoiseSliceUv(z0, q.xy));
  vec4 b = texture2D(uCloudNoiseTex, cloudNoiseSliceUv(z1, q.xy));
  return mix(a, b, fz);
}
#endif
`;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blurAxis(src, dst, size, axis) {
  const slice = size * size;
  for (let z = 0; z < size; z++) {
    const zm = z === 0 ? size - 1 : z - 1;
    const zp = z === size - 1 ? 0 : z + 1;
    for (let y = 0; y < size; y++) {
      const ym = y === 0 ? size - 1 : y - 1;
      const yp = y === size - 1 ? 0 : y + 1;
      for (let x = 0; x < size; x++) {
        const xm = x === 0 ? size - 1 : x - 1;
        const xp = x === size - 1 ? 0 : x + 1;
        const i = x + y * size + z * slice;
        let i0;
        let i1;
        if (axis === 0) {
          i0 = xm + y * size + z * slice;
          i1 = xp + y * size + z * slice;
        } else if (axis === 1) {
          i0 = x + ym * size + z * slice;
          i1 = x + yp * size + z * slice;
        } else {
          i0 = x + y * size + zm * slice;
          i1 = x + y * size + zp * slice;
        }
        dst[i] = src[i] * 0.5 + (src[i0] + src[i1]) * 0.25;
      }
    }
  }
}

function makeSmoothedChannel(size, random, passes) {
  const count = size * size * size;
  let a = new Float32Array(count);
  let b = new Float32Array(count);
  for (let i = 0; i < count; i++) a[i] = random();

  for (let pass = 0; pass < passes; pass++) {
    blurAxis(a, b, size, 0);
    [a, b] = [b, a];
    blurAxis(a, b, size, 1);
    [a, b] = [b, a];
    blurAxis(a, b, size, 2);
    [a, b] = [b, a];
  }

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < count; i++) {
    lo = Math.min(lo, a[i]);
    hi = Math.max(hi, a[i]);
  }
  const inv = 1 / Math.max(1e-8, hi - lo);
  for (let i = 0; i < count; i++) {
    const v = (a[i] - lo) * inv;
    a[i] = v * v * (3 - 2 * v);
  }
  return a;
}

function mix32(value) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function hashLattice(x, y, z, seed) {
  let h = seed >>> 0;
  h = mix32(h ^ Math.imul(x | 0, 0x9e3779b1));
  h = mix32(h ^ Math.imul(y | 0, 0x85ebca77));
  h = mix32(h ^ Math.imul(z | 0, 0xc2b2ae3d));
  return h >>> 0;
}

function hashUnit(value) {
  return mix32(value) / 4294967296;
}

function positiveMod(value, modulus) {
  const r = value % modulus;
  return r < 0 ? r + modulus : r;
}

function fade5(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function smooth01(t) {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function gradientDot(hash, x, y, z) {
  // Twelve edge-center gradients. The common 1/sqrt(2) factor is folded into
  // the final 0..1 remap because only relative cloud structure matters here.
  switch (hash % 12) {
    case 0:
      return x + y;
    case 1:
      return -x + y;
    case 2:
      return x - y;
    case 3:
      return -x - y;
    case 4:
      return x + z;
    case 5:
      return -x + z;
    case 6:
      return x - z;
    case 7:
      return -x - z;
    case 8:
      return y + z;
    case 9:
      return -y + z;
    case 10:
      return y - z;
    default:
      return -y - z;
  }
}

function periodicPerlin3(x, y, z, period, seed) {
  const xFloor = Math.floor(x);
  const yFloor = Math.floor(y);
  const zFloor = Math.floor(z);
  const fx = x - xFloor;
  const fy = y - yFloor;
  const fz = z - zFloor;

  const x0 = positiveMod(xFloor, period);
  const y0 = positiveMod(yFloor, period);
  const z0 = positiveMod(zFloor, period);
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const z1 = (z0 + 1) % period;

  const u = fade5(fx);
  const v = fade5(fy);
  const w = fade5(fz);

  const n000 = gradientDot(hashLattice(x0, y0, z0, seed), fx, fy, fz);
  const n100 = gradientDot(hashLattice(x1, y0, z0, seed), fx - 1, fy, fz);
  const n010 = gradientDot(hashLattice(x0, y1, z0, seed), fx, fy - 1, fz);
  const n110 = gradientDot(
    hashLattice(x1, y1, z0, seed),
    fx - 1,
    fy - 1,
    fz,
  );
  const n001 = gradientDot(hashLattice(x0, y0, z1, seed), fx, fy, fz - 1);
  const n101 = gradientDot(
    hashLattice(x1, y0, z1, seed),
    fx - 1,
    fy,
    fz - 1,
  );
  const n011 = gradientDot(
    hashLattice(x0, y1, z1, seed),
    fx,
    fy - 1,
    fz - 1,
  );
  const n111 = gradientDot(
    hashLattice(x1, y1, z1, seed),
    fx - 1,
    fy - 1,
    fz - 1,
  );

  const nx00 = lerp(n000, n100, u);
  const nx10 = lerp(n010, n110, u);
  const nx01 = lerp(n001, n101, u);
  const nx11 = lerp(n011, n111, u);
  const nxy0 = lerp(nx00, nx10, v);
  const nxy1 = lerp(nx01, nx11, v);

  // Empirical scale keeps this gradient set inside a useful 0..1 range.
  return Math.max(-1, Math.min(1, lerp(nxy0, nxy1, w) * 0.70710678));
}

function periodicPerlinFbm(u, v, w, periods, seed) {
  let amplitude = 0.58;
  let total = 0;
  let normalization = 0;
  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    const n = periodicPerlin3(
      u * period,
      v * period,
      w * period,
      period,
      (seed + Math.imul(period, 0x632be5ab)) >>> 0,
    );
    total += (n * 0.5 + 0.5) * amplitude;
    normalization += amplitude;
    amplitude *= 0.5;
  }
  return total / Math.max(1e-8, normalization);
}

function createWorleyFeatures(cells, seed) {
  const points = new Float32Array(cells * cells * cells * 3);
  let dst = 0;
  for (let z = 0; z < cells; z++) {
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const h = hashLattice(x, y, z, seed);
        points[dst++] = hashUnit(h ^ 0x68bc21eb);
        points[dst++] = hashUnit(h ^ 0x02e5be93);
        points[dst++] = hashUnit(h ^ 0x967a889b);
      }
    }
  }
  return points;
}

function periodicWorleyInverted(u, v, w, cells, points) {
  const px = u * cells;
  const py = v * cells;
  const pz = w * cells;
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  const fx = px - ix;
  const fy = py - iy;
  const fz = pz - iz;

  let minDistanceSq = Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    const wz = positiveMod(iz + dz, cells);
    for (let dy = -1; dy <= 1; dy++) {
      const wy = positiveMod(iy + dy, cells);
      for (let dx = -1; dx <= 1; dx++) {
        const wx = positiveMod(ix + dx, cells);
        const src = (wx + wy * cells + wz * cells * cells) * 3;
        const ddx = dx + points[src] - fx;
        const ddy = dy + points[src + 1] - fy;
        const ddz = dz + points[src + 2] - fz;
        const distanceSq = ddx * ddx + ddy * ddy + ddz * ddz;
        if (distanceSq < minDistanceSq) minDistanceSq = distanceSq;
      }
    }
  }

  // Inverted F1: bright near cell features, dark in the gaps. The 1.15 scale
  // keeps useful contrast after hardware trilinear interpolation.
  return 1 - Math.min(1, Math.sqrt(minDistanceSq) / 1.15);
}

function generateConservativeCloudDistance(supportMask, size) {
  const count = size * size * size;
  const result = new Uint8Array(count);

  let supportCount = 0;
  for (let i = 0; i < count; i++) supportCount += supportMask[i] ? 1 : 0;
  if (supportCount === 0 || supportCount === count) return result;

  // We only need exact distances up to the largest value that can survive the
  // safety margin and encoding clamp. Sorting the periodic lattice offsets once
  // makes the first occupied entry the exact Euclidean distance to a support
  // voxel, while avoiding a much larger full-volume distance transform.
  const searchRadius = Math.ceil(
    CLOUD_DISTANCE_MAX_CELLS + CLOUD_DISTANCE_MARGIN_CELLS,
  );
  const offsets = [];
  for (let dz = -searchRadius; dz <= searchRadius; dz++) {
    for (let dy = -searchRadius; dy <= searchRadius; dy++) {
      for (let dx = -searchRadius; dx <= searchRadius; dx++) {
        const distanceSq = dx * dx + dy * dy + dz * dz;
        if (distanceSq === 0) continue;
        if (distanceSq > searchRadius * searchRadius) continue;
        offsets.push({ dx, dy, dz, distanceSq });
      }
    }
  }
  offsets.sort((a, b) => a.distanceSq - b.distanceSq);

  const slice = size * size;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const index = x + y * size + z * slice;
        if (supportMask[index]) continue;

        let nearestCells = Infinity;
        for (let i = 0; i < offsets.length; i++) {
          const o = offsets[i];
          const xx = positiveMod(x + o.dx, size);
          const yy = positiveMod(y + o.dy, size);
          const zz = positiveMod(z + o.dz, size);
          if (!supportMask[xx + yy * size + zz * slice]) continue;
          nearestCells = Math.sqrt(o.distanceSq);
          break;
        }

        // Two voxel cells are removed before encoding. This covers the support
        // transition between grid points, hardware trilinear interpolation of
        // the distance channel, and 8-bit floor quantization. It deliberately
        // trades a little skip distance for stability at wispy cloud edges.
        const safeCells = Number.isFinite(nearestCells)
          ? Math.max(
              0,
              nearestCells - CLOUD_DISTANCE_MARGIN_CELLS,
            )
          : CLOUD_DISTANCE_MAX_CELLS;
        result[index] = Math.floor(
          (Math.min(CLOUD_DISTANCE_MAX_CELLS, safeCells) /
            CLOUD_DISTANCE_MAX_CELLS) *
            255,
        );
      }
    }
  }

  return result;
}

export function generateCloudNoiseVolume(seed = 0x4f1bbcdc) {
  const size = VOLUME_NOISE_SIZE;
  const count = size * size * size;
  const volume = new Uint8Array(count * 4);
  const supportMask = new Uint8Array(count);

  const worley4 = createWorleyFeatures(4, (seed ^ 0x7f4a7c15) >>> 0);
  const worley8 = createWorleyFeatures(8, (seed ^ 0x94d049bb) >>> 0);
  const worley16 = createWorleyFeatures(16, (seed ^ 0x369dea0f) >>> 0);

  let voxel = 0;
  for (let z = 0; z < size; z++) {
    const w = z / size;
    for (let y = 0; y < size; y++) {
      const v = y / size;
      for (let x = 0; x < size; x++, voxel++) {
        const u = x / size;

        const perlin = periodicPerlinFbm(u, v, w, [4, 8, 16], seed);
        const w4 = periodicWorleyInverted(u, v, w, 4, worley4);
        const w8 = periodicWorleyInverted(u, v, w, 8, worley8);
        const w16 = periodicWorleyInverted(u, v, w, 16, worley16);
        const worleyFbm = w4 * 0.625 + w8 * 0.25 + w16 * 0.125;

        // Perlin supplies connected broad masses; inverted Worley rounds those
        // masses into cumulus-like cells. Contrast is baked here so the runtime
        // shader can use one base sample and a simple coverage threshold.
        const macroRaw = perlin * 0.7 + worleyFbm * 0.3;
        const macro = smooth01((macroRaw - 0.3) / 0.4);

        const detailRaw = w8 * 0.65 + w16 * 0.35;
        const detail = smooth01((detailRaw - 0.16) / 0.72);

        const weather = periodicPerlinFbm(
          u,
          v,
          w,
          [2, 4],
          (seed ^ 0xa511e9b3) >>> 0,
        );

        const secondaryPerlin = periodicPerlinFbm(
          u,
          v,
          w,
          [3, 6],
          (seed ^ 0x63d83595) >>> 0,
        );
        const secondaryRaw = secondaryPerlin * 0.76 + w4 * 0.24;
        const secondary = smooth01((secondaryRaw - 0.27) / 0.48);

        // Batch one mixed 18% secondary shape in the shader. Bake that same mix
        // into R so alpha can carry a conservative empty-space distance field
        // without materially changing the broad cloud silhouette.
        const combinedMacro = lerp(macro, secondary, 0.18);
        const dst = voxel * 4;
        const macroByte = Math.round(
          Math.max(0, Math.min(1, combinedMacro)) * 255,
        );
        const detailByte = Math.round(
          Math.max(0, Math.min(1, detail)) * 255,
        );
        const weatherByte = Math.round(
          Math.max(0, Math.min(1, weather)) * 255,
        );
        volume[dst] = macroByte;
        volume[dst + 1] = detailByte;
        volume[dst + 2] = weatherByte;
        volume[dst + 3] = 0;

        // Build support from the exact quantized values the shader receives.
        // The lower coverage threshold expands the possible-cloud region, making
        // the baked distance valid for every runtime coverage >= MIN_COVERAGE.
        const shaderWeather = smooth01(
          (weatherByte / 255 - 0.15) / 0.70,
        );
        const supportThreshold =
          CLOUD_DISTANCE_REFERENCE_COVERAGE +
          (0.5 - shaderWeather) * 0.16 -
          CLOUD_DISTANCE_SUPPORT_BIAS;
        supportMask[voxel] = macroByte / 255 >= supportThreshold ? 1 : 0;
      }
    }
  }

  const safeDistance = generateConservativeCloudDistance(supportMask, size);
  for (let i = 0; i < count; i++) volume[i * 4 + 3] = safeDistance[i];

  return volume;
}

function packRgbaVolumeAtlas(volume, size) {
  const atlas = new Uint8Array(
    VOLUME_NOISE_ATLAS_WIDTH * VOLUME_NOISE_ATLAS_HEIGHT * 4,
  );
  const stride = VOLUME_NOISE_STRIDE;

  for (let z = 0; z < size; z++) {
    const tileX = z % VOLUME_NOISE_GRID_X;
    const tileY = Math.floor(z / VOLUME_NOISE_GRID_X);
    for (let ay = -1; ay <= size; ay++) {
      const sy = (ay + size) % size;
      for (let ax = -1; ax <= size; ax++) {
        const sx = (ax + size) % size;
        const src = (sx + sy * size + z * size * size) * 4;
        const px = tileX * stride + ax + 1;
        const py = tileY * stride + ay + 1;
        const dst = (px + py * VOLUME_NOISE_ATLAS_WIDTH) * 4;
        atlas[dst] = volume[src];
        atlas[dst + 1] = volume[src + 1];
        atlas[dst + 2] = volume[src + 2];
        atlas[dst + 3] = volume[src + 3];
      }
    }
  }

  return atlas;
}

function makeAtlasTexture(THREE, atlas, name, userDataKey, layout) {
  const texture = new THREE.DataTexture(
    atlas,
    VOLUME_NOISE_ATLAS_WIDTH,
    VOLUME_NOISE_ATLAS_HEIGHT,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  texture.name = name;
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  texture.userData[userDataKey] = layout;
  return texture;
}

function makeCloud3DTexture(THREE, volume, size, layout) {
  if (typeof THREE.Data3DTexture !== "function") return null;

  const texture = new THREE.Data3DTexture(volume, size, size, size);
  texture.name = "CloudPerlinWorley3D";
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.internalFormat = "RGBA8";
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  texture.userData.cloudNoiseLayout = layout;
  return texture;
}

function makeLayout() {
  return Object.freeze({
    size: VOLUME_NOISE_SIZE,
    gridX: VOLUME_NOISE_GRID_X,
    gridY: VOLUME_NOISE_GRID_Y,
    atlasWidth: VOLUME_NOISE_ATLAS_WIDTH,
    atlasHeight: VOLUME_NOISE_ATLAS_HEIGHT,
  });
}

export function createVolumeNoiseAtlas(THREE, seed = 0x71c3a9d5) {
  const size = VOLUME_NOISE_SIZE;
  const count = size * size * size;
  const random = mulberry32(seed >>> 0);
  const channels = [
    makeSmoothedChannel(size, random, 8),
    makeSmoothedChannel(size, random, 5),
    makeSmoothedChannel(size, random, 2),
    makeSmoothedChannel(size, random, 6),
  ];

  const volume = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const dst = i * 4;
    for (let c = 0; c < 4; c++) {
      volume[dst + c] = Math.max(
        0,
        Math.min(255, Math.round(channels[c][i] * 255)),
      );
    }
  }

  const layout = makeLayout();
  const atlas = packRgbaVolumeAtlas(volume, size);
  const texture = makeAtlasTexture(
    THREE,
    atlas,
    "SharedVolumeNoiseAtlas",
    "volumeNoiseLayout",
    layout,
  );

  return { texture, layout };
}

export function createCloudNoiseAtlas(
  THREE,
  seed = 0x4f1bbcdc,
  { create3D = false } = {},
) {
  const layout = Object.freeze({
    ...makeLayout(),
    distanceMaxCells: CLOUD_DISTANCE_MAX_CELLS,
    distanceReferenceCoverage: CLOUD_DISTANCE_REFERENCE_COVERAGE,
    distanceSupportBias: CLOUD_DISTANCE_SUPPORT_BIAS,
    distanceMinCoverage: CLOUD_DISTANCE_MIN_COVERAGE,
    distanceMarginCells: CLOUD_DISTANCE_MARGIN_CELLS,
  });
  const volume = generateCloudNoiseVolume(seed >>> 0);
  const atlas = packRgbaVolumeAtlas(volume, layout.size);
  const texture = makeAtlasTexture(
    THREE,
    atlas,
    "CloudPerlinWorleyAtlas",
    "cloudNoiseLayout",
    layout,
  );
  const texture3D = create3D
    ? makeCloud3DTexture(THREE, volume, layout.size, layout)
    : null;

  const channels = Object.freeze({
    r: "combinedPerlinWorleyBase",
    g: "worleyDetail",
    b: "weatherCoverage",
    a: "conservativeEmptyDistance",
  });
  texture.userData.cloudNoiseChannels = channels;
  if (texture3D) texture3D.userData.cloudNoiseChannels = channels;

  return { texture, texture3D, layout, volume };
}

export function makeVolumeNoiseUniforms(THREE, texture, layout) {
  return {
    uVolumeNoiseTex: { value: texture },
    uVolumeNoiseAtlasSize: {
      value: new THREE.Vector2(layout.atlasWidth, layout.atlasHeight),
    },
    uVolumeNoiseGrid: {
      value: new THREE.Vector2(layout.gridX, layout.gridY),
    },
    uVolumeNoiseSize: { value: layout.size },
  };
}

export function makeCloudNoiseUniforms(
  THREE,
  texture,
  layout,
  texture3D = null,
) {
  return {
    uCloudNoiseTex: { value: texture },
    uCloudNoiseTex3D: { value: texture3D },
    uCloudNoiseAtlasSize: {
      value: new THREE.Vector2(layout.atlasWidth, layout.atlasHeight),
    },
    uCloudNoiseGrid: {
      value: new THREE.Vector2(layout.gridX, layout.gridY),
    },
    uCloudNoiseSize: { value: layout.size },
    uCloudDistanceMaxCells: { value: layout.distanceMaxCells },
    uCloudDistanceMinCoverage: { value: layout.distanceMinCoverage },
  };
}
