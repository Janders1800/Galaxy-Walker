// src/game/asteroidBelt.js
// Chunked / batched asteroid belt using InstancedMesh.
// Each angular segment is its own InstancedMesh so frustum + distance culling work per-batch.

import { THREE } from "../render/device.js";
import { mulberry32 } from "../core/galaxy.js";
import { registerSPLMaterial } from "./spl.js";
import { RING_DUST_VS, RING_DUST_FS } from "../render/shaders.js";

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function pointSegmentDistanceSq(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const lenSq = dx * dx + dy * dy + dz * dz;

  let t = 0.0;
  if (lenSq > 1e-12) {
    t =
      ((point.x - start.x) * dx +
        (point.y - start.y) * dy +
        (point.z - start.z) * dz) /
      lenSq;
    t = Math.max(0.0, Math.min(1.0, t));
  }

  const px = start.x + dx * t - point.x;
  const py = start.y + dy * t - point.y;
  const pz = start.z + dz * t - point.z;
  return px * px + py * py + pz * pz;
}

/**
 * Creates a batched asteroid belt.
 *
 * - Asteroids are distributed in a ring between innerRadius..outerRadius.
 * - The ring is split into `segments` angular batches, each an InstancedMesh.
 * - Call belt.update(focusPos) each frame for cheap distance-based culling.
 * - For warp rebuilds, you can build segment-by-segment using buildSegment/buildNext.
 */
export function createAsteroidBelt({
  seed = 12345,
  innerRadius = 12000,
  outerRadius = 14000,
  thickness = 280,
  segments = 24,
  asteroidsTotal = 5000,
  tilt = 0.12,
  maxVisibleDist = 32000,
  baseColor = 0x8a8a8a,
  // When true, preserve hue from baseColor (useful for colorful planet rings).
  // When false, rocks are forced into a neutral moon-rock palette.
  keepBaseColor = false,
  // Optional: SuperPointLight used to patch materials so point lights are masked
  // inside the SPL spot cone (prevents double illumination).
  superPointLight = null,
  // Rock mesh smoothness (Icosahedron subdivision level). Higher => smoother shading.
  // This is shared across all instances, so increasing it is usually cheap.
  rockDetail = 2,
  // Cheap collision uses one approximate sphere per asteroid. The proxy is
  // generated alongside the instance matrix, so runtime queries never need to
  // decode matrices or raycast the rendered geometry.
  collisionEnabled = true,
  collisionRadiusScale = 0.78,
  // Optional volumetric-ish cosmic dust band (cheap shader on a large cylinder shell).
  // Pass a noise texture (e.g., world.blueNoiseTex) for nicer breakup.
  // Mesh-based dust volume was replaced by a screen-space, atmosphere-style pass (world.beltDustPass).
  // Keep this off by default to avoid "invisible" dust confusion.
  cosmicDust = false,
  noiseTex = null,
  dustColor = null,
  // Dust visibility (kept soft with falloffs; this is the main knob).
  dustVolumeOpacity = 0.65,
  dustEdgeFade = 900.0,
  dustHeightMult = 8.0,
  // A faint ring can help the belt read as a continuous "band" when rocks are tiny,
  // but it can also show polygonal edges at huge scales. Keep it off by default
  // now that we have the atmosphere-style belt dust pass.
  dustRing = false,
  dustOpacity = 0.12,
  dustInnerFade = 0.15,
  // When dustRing is enabled, stack multiple ring sheets with small Y offsets
  // to fake volumetric thickness (prevents the "paper-thin" look edge-on).
  dustLayers = 1,
  // Total span (in world units) across which dust layers are distributed along the belt normal.
  // If 0, a small span derived from `thickness` is used.
  dustLayerSpan = 0.0,
  // Ring-dust shader knobs (clouds-tech). These affect the dustRing mesh shader.
  dustBrightness = 1.85,
  dustNoiseScale = 0.00012,
  dustWindSpeed = 0.035,
  dustEclipseSoftness = 0.015,
  dustEclipseStrength = 1.0,
  buildNow = true,
} = {}) {
  const group = new THREE.Group();
  group.name = "AsteroidBelt";
  // Tag so UI/minimap/picking systems can ignore the belt cheaply.
  group.userData.isAsteroidBelt = true;
  group.userData.ignoreMiniMap = true;
  group.userData.ignoreMinimap = true;

  // Deterministic RNG base seed (shared across geometry + segment streams).
  const seed0 = (seed >>> 0) || 1;

  // Build a single shared "rock" mesh. We keep InstancedMesh batching, but make the
  // base geometry more rugged so silhouettes don't read like spheres.
  function _fract(x) {
    return x - Math.floor(x);
  }

  // Deterministic hash in [0,1).
  function _hash3(x, y, z, s) {
    const t = x * 127.1 + y * 311.7 + z * 74.7 + s * 19.19;
    return _fract(Math.sin(t) * 43758.5453123);
  }

  // Weld duplicate vertices so computeVertexNormals produces smooth shading (no faceting).
  // Polyhedron geometries can be non-indexed, which makes normals per-face.
  function weldVertices(geom, tol = 1e-5) {
    const posAttr = geom.attributes.position;
    const a = posAttr.array;
    const inv = 1.0 / tol;
    const map = new Map();
    const newPos = [];
    const index = [];

    for (let i = 0; i < a.length; i += 3) {
      const x = a[i + 0];
      const y = a[i + 1];
      const z = a[i + 2];
      const k = `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;
      let idx = map.get(k);
      if (idx === undefined) {
        idx = (newPos.length / 3) | 0;
        newPos.push(x, y, z);
        map.set(k, idx);
      }
      index.push(idx);
    }

    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
    g2.setIndex(index);
    return g2;
  }

  function makeRuggedRockGeometry(detail, seedForGeom) {
    const g = new THREE.IcosahedronGeometry(1, Math.max(0, detail | 0));
    const pos = g.attributes.position;
    const a = pos.array;

    // Displace vertices along their radial direction using a ridged multi-frequency hash.
    // This gives "rocky" silhouettes without requiring per-instance vertex work.
    const s0 = (seedForGeom >>> 0) || 1;
    const f1 = 2.7;
    const f2 = 6.1;
    const f3 = 12.7;
    const amp1 = 0.22;
    const amp2 = 0.11;
    const amp3 = 0.05;

    for (let i = 0; i < a.length; i += 3) {
      let x = a[i + 0];
      let y = a[i + 1];
      let z = a[i + 2];
      const len = Math.hypot(x, y, z) || 1;
      const nx = x / len;
      const ny = y / len;
      const nz = z / len;

      const n1 = _hash3(nx * f1, ny * f1, nz * f1, s0);
      const n2 = _hash3(nx * f2 + 31.0, ny * f2 + 17.0, nz * f2 + 7.0, s0 ^ 0x9e3779b9);
      const n3 = _hash3(nx * f3 - 11.0, ny * f3 + 23.0, nz * f3 - 5.0, s0 ^ 0x85ebca6b);

      // Signed displacement.
      let disp = (n1 - 0.5) * 2.0 * amp1;
      disp += (n2 - 0.5) * 2.0 * amp2;
      disp += (n3 - 0.5) * 2.0 * amp3;

      // Ridged bumps (always positive) to create sharper rockiness.
      const r2 = 1.0 - Math.abs(n2 * 2.0 - 1.0);
      disp += r2 * r2 * 0.12;

      // Clamp so we never collapse the mesh.
      disp = Math.max(-0.45, Math.min(0.55, disp));

      const r = 1.0 + disp;
      a[i + 0] = nx * r;
      a[i + 1] = ny * r;
      a[i + 2] = nz * r;
    }

    pos.needsUpdate = true;

    // Ensure we have shared vertices for smooth shading
    const welded = weldVertices(g, 1e-5);
    welded.computeVertexNormals();
    welded.computeBoundingSphere();
    welded.computeBoundingBox();
    return welded;
  }

  // Shared rock geometry; visual variety comes from per-instance scaling + rotation.
  // Detail 0 is intentionally allowed for low presets—the previous minimum of 2
  // made the Potato setting process far more triangles than requested.
  const geom = makeRuggedRockGeometry(
    Math.max(0, Math.min(3, rockDetail | 0)),
    seed0 ^ 0x13579bdf,
  );
  const geomCollisionRadius = Math.max(
    1e-3,
    geom.boundingSphere?.radius ?? 1.0,
  );
  const colliderScale = Math.max(
    0.1,
    Math.min(1.25, Number(collisionRadiusScale) || 0.78),
  );
  let maxCollisionRadius = 0.0;

  // Terrain-like rock material:
  // - MeshStandardMaterial like planet/moon terrains
  // - per-instance colors provide variety (like terrain vertex colors)
  // - micro-variation in the shader for "grain"
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    // IMPORTANT:
    // This is InstancedMesh + instanceColor (per-instance), NOT per-vertex colors.
    // Enabling vertexColors without a geometry 'color' attribute makes diffuseColor go black.
    vertexColors: false,
    roughness: 0.98,
    metalness: 0.0,
    side: THREE.FrontSide,
    flatShading: false,
  });

  // Micro-variation (same idea as terrain material, but instancing-aware world position).
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>\nvarying vec3 vWorldPos;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <worldpos_vertex>",
      `#include <worldpos_vertex>\n\n// Instancing-aware world position for micro-variation\nvec4 gwWorldPosition = vec4( transformed, 1.0 );\n#ifdef USE_INSTANCING\n  gwWorldPosition = instanceMatrix * gwWorldPosition;\n#endif\ngwWorldPosition = modelMatrix * gwWorldPosition;\nvWorldPos = gwWorldPosition.xyz;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <common>",
      `#include <common>\nvarying vec3 vWorldPos;\nfloat hash13(vec3 p){p=fract(p*0.1031);p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);} `,
    );
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <color_fragment>",
      `#include <color_fragment>\nfloat n = hash13(vWorldPos * 0.015);\ndiffuseColor.rgb *= (0.90 + 0.20 * n);`,
    );
  };
  mat.needsUpdate = true;

  // Patch material for SuperPointLight masking (prevents double illumination)
  if (superPointLight) {
    try {
      registerSPLMaterial(mat, superPointLight);
    } catch (e) {
      // ignore
    }
  }

  // Base rock palette.
// - Default: neutral moon-rock range (grayscale + warm/cool bias).
// - keepBaseColor: preserve hue from baseColor (great for colorful planet rings),
//   but slightly desaturate so it still reads as rock.
const rockBase = new THREE.Color(baseColor);
let rockTone = rockBase.clone();

if (!keepBaseColor) {
  const g = (rockTone.r + rockTone.g + rockTone.b) / 3;
  rockTone.setRGB(g, g, g);
  // Classic warm/cool rock bias around neutral.
  var rockWarm = rockTone.clone().lerp(new THREE.Color(0x6a6055), 0.55);
  var rockCool = rockTone.clone().lerp(new THREE.Color(0x4e5a66), 0.55);
} else {
  const hsl = { h: 0, s: 0, l: 0 };
  rockTone.getHSL(hsl);
  const s = Math.max(0.0, Math.min(1.0, hsl.s * 0.65));
  const l = Math.max(0.0, Math.min(1.0, hsl.l * 0.95 + 0.03));
  rockTone.setHSL(hsl.h, s, l);

  const clamp01 = (x) => Math.max(0.0, Math.min(1.0, x));
  rockWarm = new THREE.Color().setHSL(
    (hsl.h + 0.025) % 1.0,
    clamp01(s * 0.85 + 0.05),
    clamp01(l * 1.06)
  );
  rockCool = new THREE.Color().setHSL(
    (hsl.h - 0.025 + 1.0) % 1.0,
    clamp01(s * 0.55),
    clamp01(l * 0.93)
  );
}

  // Optional: dust ring (very cheap) for visual continuity.
  // Rendered as an unlit shader with *per-fragment* radial fade.
  // (Previously used per-vertex alpha which can reveal triangle boundaries and looks like
  // "inconsistent normals" when opacity is higher.)
  let dustMesh = null;
  let dustRingGeom = null;

  // If dustRing is enabled, we expose the dust materials + occluder buffers
  // so the main loop can feed time / blue-noise / eclipse occluders each frame.
  let dustMats = null;
  let dustOccCenters = null;
  let dustOccRadii = null;
  // Be strict: only enable when a real boolean true is passed.
  // This prevents accidental enabling via truthy strings like "false".
  if (dustRing === true) {
    const midR = (innerRadius + outerRadius) * 0.5;
    // "Physical" tube radius is the ring half-width. We render a slightly *fatter* torus shell
    // so the shader can fade to zero *before* the geometry silhouette, giving soft top/bottom
    // transitions like atmospheric clouds.
    const tubeR = Math.max(1.0, (outerRadius - innerRadius) * 0.5);
    const tubeRMesh = tubeR * 1.6;
    const torGeom = new THREE.TorusGeometry(midR, tubeRMesh, 18, 256);
    // Squish along local Z so after rotating the mesh to XZ, the thickness is along world Y.
    const DUST_SQUISH = 0.22;
    torGeom.scale(1, 1, DUST_SQUISH);
    dustRingGeom = torGeom;

    // Per-ring occluder buffers (24 spheres max, matching the atmo/clouds pass).
    dustOccCenters = new Float32Array(24 * 3);
    dustOccRadii = new Float32Array(24);

    const baseCol = (dustColor ? new THREE.Color(dustColor) : rockTone.clone());
    const ringMat = new THREE.ShaderMaterial({
      transparent: true,
      // Additive reads more like airy dust than alpha blending and avoids
      // darkening the background.
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      uniforms: {
        // Visual
        uColor: { value: baseCol.clone().multiplyScalar(Math.max(0.0, dustBrightness)) },
        uOpacity: { value: dustOpacity },
        uInner: { value: innerRadius },
        uOuter: { value: outerRadius },
        uFade: { value: Math.max(0.001, dustInnerFade) },

        // Volume params (local space)
        uMajorR: { value: midR },
        uTubeR: { value: tubeR },
        uSquishZ: { value: DUST_SQUISH },
        uCamPosL: { value: new THREE.Vector3() },
        uDensity: { value: 14.0 },
        uSteps: { value: 28.0 },

        // Clouds-style breakup
        uBlueNoiseTex: { value: null },
        uBlueNoiseSize: { value: new THREE.Vector2(256, 256) },
        uTime: { value: 0.0 },
        // World-space frequency (smaller => larger wisps)
        uNoiseScale: { value: dustNoiseScale },
        uWindSpeed: { value: dustWindSpeed },

        // Eclipse mask (copied from atmo/clouds)
        uOccCount: { value: 0 },
        uOccCenters: { value: dustOccCenters },
        uOccRadii: { value: dustOccRadii },
        uEclipseSoftness: { value: dustEclipseSoftness },
        uEclipseStrength: { value: dustEclipseStrength },
        uSunPosW: { value: new THREE.Vector3() },
        uSunRadius: { value: 1350.0 },
      },
      vertexShader: RING_DUST_VS,
      fragmentShader: RING_DUST_FS,
    });
    // Store original tint so brightness sliders can re-apply without losing the base color.
    ringMat.userData.baseColor = baseCol;
    ringMat.userData.brightness = Math.max(0.0, dustBrightness);

    // Single squished torus mesh (no stacking) as requested.
    const dust = new THREE.Mesh(torGeom, ringMat);
    dust.name = "AsteroidDustRing";
    // Align torus (authored in XY) into the ring plane (XZ).
    dust.rotation.x = -Math.PI / 2;
    dust.frustumCulled = false;
    dust.renderOrder = 1;

    dustMesh = dust;
    dustMats = [ringMat];
    group.add(dust);
  }

  // Optional: cosmic dust volume (soft, animated, additive).
  // IMPORTANT: this must have *radial thickness* in its geometry; a single cylinder at outerRadius
  // has constant r and would fade to zero in the shader. We use a torus volume instead.
  let dustVolumeMesh = null;
  let _fallbackNoiseTex = null;
  // NOTE: Mesh-based dust volume is deprecated in favor of the screen-space belt dust pass.
  // It is intentionally disabled to avoid rendering a large "capsule/torus" volume in the scene.
  if (false) {
    const h = Math.max(1.0, thickness * dustHeightMult);
    // Ensure we always have a noise texture so the shader stays simple and portable.
    let noise = noiseTex;
    if (!noise) {
      const sz = 64;
      const data = new Uint8Array(sz * sz * 4);
      const rnd = mulberry32(((seed >>> 0) ^ 0x6d2b79f5) >>> 0);
      for (let i = 0; i < sz * sz; i++) {
        const v = (rnd() * 255) | 0;
        const o = i * 4;
        data[o + 0] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = 255;
      }
      _fallbackNoiseTex = new THREE.DataTexture(data, sz, sz);
      _fallbackNoiseTex.wrapS = THREE.RepeatWrapping;
      _fallbackNoiseTex.wrapT = THREE.RepeatWrapping;
      _fallbackNoiseTex.needsUpdate = true;
      noise = _fallbackNoiseTex;
    }

    const midR = (innerRadius + outerRadius) * 0.5;
    const bandR = Math.max(10.0, (outerRadius - innerRadius) * 0.5);
    // Torus lies in XZ plane; its tube gives us real radial thickness.
    const torGeom = new THREE.TorusGeometry(midR, bandR, 16, 256);
    // Stretch/flatten in Y to control belt thickness.
    const yScale = h / Math.max(1.0, bandR * 2.0);
    torGeom.scale(1, yScale, 1);

    // Slightly brighter, gently bluish dust reads better against space while still feeling "cosmic".
    const col = dustColor
      ? new THREE.Color(dustColor)
      : rockBase.clone().lerp(new THREE.Color(0x4f6a8a), 0.40).multiplyScalar(2.2);

    const cylMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0.0 },
        uColor: { value: col },
        uOpacity: { value: dustVolumeOpacity },
        uMid: { value: midR },
        uBand: { value: bandR },
        uEdge: { value: Math.max(1.0, dustEdgeFade) },
        // Use exponential vertical fade; the geometry is a surface, so smoothstep to 0 at the max Y
        // can accidentally make it invisible. This keeps the whole band softly present.
        uInvH: { value: 1.0 / Math.max(1.0, h) },
        uNoiseTex: { value: noise },
        uNoiseScale: { value: 0.00014 },
        // Much looser fade than the batched instance culling; we want the dust to remain
        // visible even when the belt is far, while still avoiding infinite fill-rate.
        uFar: { value: maxVisibleDist * 5.0 },
        uFar2: { value: maxVisibleDist * 10.0 },
      },
      vertexShader: `
        varying vec3 vPosL;
        varying vec3 vPosW;
        void main(){
          vPosL = position;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vPosW = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        precision highp float;
        varying vec3 vPosL;
        varying vec3 vPosW;
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uMid;
        uniform float uBand;
        uniform float uEdge;
        uniform float uInvH;
        uniform sampler2D uNoiseTex;
        uniform float uNoiseScale;
        uniform float uFar;
        uniform float uFar2;

        float hash12(vec2 p){
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main(){
          // Local space: cylinder is centered at belt origin, y is "up" from belt plane.
          float r = length(vPosL.xz);

          // Soft radial band around the torus centerline.
          float dr = abs(r - uMid);
          float radial = 1.0 - smoothstep(max(1.0, uBand - uEdge), uBand, dr);

          // Soft vertical fade (exponential so it never "hard zeros" on the surface).
          float vy = abs(vPosL.y);
          float vertical = exp(-vy * uInvH * 1.35);

          // Distance fade to keep fill-rate under control.
          float camD = distance(cameraPosition, vPosW);
          float distFade = 1.0 - smoothstep(uFar, uFar2, camD);

          // Noise breakup (fallback to cheap hash if no texture).
          vec2 nUV = fract((vPosW.xz * uNoiseScale) + vec2(uTime * 0.012, uTime * 0.009));
          float n = texture2D(uNoiseTex, nUV).r;
          n = mix(n, hash12(nUV * 2048.0), 0.35);

          float wisps = smoothstep(0.06, 0.88, n);
          // Boosted presence; still soft thanks to radial/vertical fades.
          float a = uOpacity * radial * vertical * distFade * (0.45 + 0.85 * wisps);
          if (a < 0.0002) discard;
          gl_FragColor = vec4(uColor * (0.65 + 0.35 * n), a);
        }
      `,
    });

    dustVolumeMesh = new THREE.Mesh(torGeom, cylMat);
    dustVolumeMesh.name = "AsteroidDustVolume";
    dustVolumeMesh.renderOrder = 2;
    // TorusGeometry is generated in the XY plane (axis along Z) in Three.js.
    // Our belt lives in the XZ plane, so rotate the dust volume to match the belt plane.
    dustVolumeMesh.rotation.x = -Math.PI / 2;
    // It's huge and camera can be inside it; don't let frustum culling hide it.
    dustVolumeMesh.frustumCulled = false;
    group.add(dustVolumeMesh);
  }

  // Precompute per-segment count.
  const perSeg = Math.max(1, Math.floor(asteroidsTotal / Math.max(1, segments)));
  const remainder = Math.max(0, asteroidsTotal - perSeg * segments);

  const meshes = new Array(segments);
  const segInfo = new Array(segments);

  const dummy = new THREE.Object3D();
  const axis = new THREE.Vector3();

  // Deterministic RNG; we derive a unique stream per segment.

  // Mild tilt around X so the belt isn't perfectly flat.
  group.rotation.x = tilt;

  for (let s = 0; s < segments; s++) {
    const count = perSeg + (s < remainder ? 1 : 0);
    const mesh = new THREE.InstancedMesh(geom, mat, count);
    mesh.name = `AsteroidBatch-${s}`;
    mesh.userData.isAsteroidBelt = true;
    mesh.userData.ignoreMiniMap = true;
    mesh.userData.ignoreMinimap = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    // The mesh stays hidden until all instance matrices and aggregate bounds
    // have been built. Frustum culling is enabled after that calculation.
    mesh.visible = false;
    mesh.frustumCulled = false;
    meshes[s] = mesh;
    group.add(mesh);

    // Per-instance rock variation (tinted like moon terrains, not neon/green).
    const colors = new Float32Array(count * 3);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);

    const a0 = (s / segments) * Math.PI * 2;
    const a1 = ((s + 1) / segments) * Math.PI * 2;
    // Segment center (in belt local space; y=0 because belt is around XZ plane)
    const amid = (a0 + a1) * 0.5;
    const rmid = (innerRadius + outerRadius) * 0.5;
    const cx = Math.cos(amid) * rmid;
    const cz = Math.sin(amid) * rmid;
    segInfo[s] = {
      a0,
      a1,
      center: new THREE.Vector3(cx, 0, cz),
      // x, y, z, radius for each rendered instance. This is substantially
      // cheaper to query than getMatrixAt() and remains compact (16 bytes/rock).
      colliders: new Float32Array(count * 4),
      collisionCenter: new THREE.Vector3(cx, 0, cz),
      collisionRadius: 0.0,
      built: false,
    };
  }

  function buildSegment(s) {
    const info = segInfo[s];
    if (!info || info.built) return false;

    const mesh = meshes[s];
    const count = mesh.count;

    const rnd = mulberry32((seed0 ^ (s * 0x9e3779b9)) >>> 0);
    const colliders = info.colliders;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < count; i++) {
      // Angle within the segment
      const a = lerp(info.a0, info.a1, rnd());
      // Radius biased slightly toward the middle so the belt reads denser
      const rT = rnd();
      const r = lerp(innerRadius, outerRadius, 0.25 + 0.5 * rT);

      // Position
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const y = (rnd() - 0.5) * thickness;

      // Size: many small, few large
      const u = rnd();
      // Bigger sizes so the belt is visible at typical orbit distances.
      const size = lerp(6.0, 55.0, Math.pow(u, 2.35));
      const squash = lerp(0.6, 1.35, rnd());

      dummy.position.set(x, y, z);

      // Random rotation
      axis.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();
      dummy.quaternion.setFromAxisAngle(axis, rnd() * Math.PI * 2);

      // Non-uniform scaling gives more variety from a single base shape
      const stretchZ = lerp(0.65, 1.25, rnd());
      dummy.scale.set(size, size * squash, size * stretchZ);

      // Approximate sphere around the irregular, non-uniformly scaled mesh.
      // A slight shrink keeps the simple proxy from feeling larger than the
      // visible rock while still catching the bulk of the silhouette.
      const collisionRadius =
        geomCollisionRadius *
        Math.max(dummy.scale.x, dummy.scale.y, dummy.scale.z) *
        colliderScale;
      const ci = i * 4;
      colliders[ci + 0] = x;
      colliders[ci + 1] = y;
      colliders[ci + 2] = z;
      colliders[ci + 3] = collisionRadius;

      minX = Math.min(minX, x - collisionRadius);
      minY = Math.min(minY, y - collisionRadius);
      minZ = Math.min(minZ, z - collisionRadius);
      maxX = Math.max(maxX, x + collisionRadius);
      maxY = Math.max(maxY, y + collisionRadius);
      maxZ = Math.max(maxZ, z + collisionRadius);
      maxCollisionRadius = Math.max(maxCollisionRadius, collisionRadius);

      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // Terrain-like color variation: choose warm/cool/neutral rock and vary brightness slightly.
      const pick = rnd();
      const bright = 0.75 + 0.25 * rnd();
      let c = rockBase;
      if (pick < 0.34) c = rockWarm;
      else if (pick < 0.68) c = rockCool;
      mesh.instanceColor.setXYZ(i, c.r * bright, c.g * bright, c.b * bright);
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    if (count > 0 && Number.isFinite(minX)) {
      const center = info.collisionCenter;
      center.set(
        (minX + maxX) * 0.5,
        (minY + maxY) * 0.5,
        (minZ + maxZ) * 0.5,
      );
      const hx = (maxX - minX) * 0.5;
      const hy = (maxY - minY) * 0.5;
      const hz = (maxZ - minZ) * 0.5;
      info.collisionRadius = Math.hypot(hx, hy, hz);
    }

    // Let Three compute an aggregate bound for this batch. Older Three builds
    // without InstancedMesh bounds keep the safe distance-culling fallback.
    let hasAggregateBounds = false;
    try {
      if (typeof mesh.computeBoundingSphere === "function") {
        mesh.computeBoundingSphere();
        mesh.computeBoundingBox?.();
        hasAggregateBounds = !!mesh.boundingSphere;
      }
    } catch (e) {
      hasAggregateBounds = false;
    }

    info.built = true;
    mesh.frustumCulled = hasAggregateBounds;
    mesh.visible = true;
    return true;
  }

  function buildAll() {
    for (let s = 0; s < segments; s++) buildSegment(s);
  }

  let _builtCursor = 0;
  function buildNext() {
    while (_builtCursor < segments) {
      const s = _builtCursor++;
      if (buildSegment(s)) return true;
    }
    return false;
  }

  // Scratch objects for allocation-free swept-sphere collision queries.
  const _collisionInvWorld = new THREE.Matrix4();
  const _collisionStartL = new THREE.Vector3();
  const _collisionEndL = new THREE.Vector3();
  const _collisionDeltaL = new THREE.Vector3();
  const _collisionNormalL = new THREE.Vector3();
  const _collisionNormalW = new THREE.Vector3();

  /**
   * Finds the earliest collision between a moving world-space sphere and this
   * belt's asteroid proxies. `outHit.t` may already contain a hit from another
   * belt; this method only replaces it when it finds an earlier one.
   *
   * Broad phase:
   *  1. annulus + height slab rejection;
   *  2. one swept-sphere test against each angular batch bound;
   *  3. exact swept sphere-vs-sphere only for nearby batch instances.
   */
  function sweepSphere(startW, endW, sphereRadius, outHit) {
    if (
      !collisionEnabled ||
      !startW ||
      !endW ||
      !outHit ||
      maxCollisionRadius <= 0.0
    ) {
      return false;
    }

    if (typeof group.updateWorldMatrix === "function") {
      group.updateWorldMatrix(true, false);
    } else {
      group.updateMatrixWorld(true);
    }

    _collisionInvWorld.copy(group.matrixWorld).invert();
    _collisionStartL.copy(startW).applyMatrix4(_collisionInvWorld);
    _collisionEndL.copy(endW).applyMatrix4(_collisionInvWorld);
    _collisionDeltaL.subVectors(_collisionEndL, _collisionStartL);

    // Convert the world-space query radius conservatively to local space.
    const me = group.matrixWorld.elements;
    const sx = Math.hypot(me[0], me[1], me[2]);
    const sy = Math.hypot(me[4], me[5], me[6]);
    const sz = Math.hypot(me[8], me[9], me[10]);
    const minWorldScale = Math.max(1e-6, Math.min(sx, sy, sz));
    const sphereRadiusL =
      Math.max(0.0, Number(sphereRadius) || 0.0) / minWorldScale;

    // Very cheap whole-belt rejection against its annular slab.
    const broadExpand = sphereRadiusL + maxCollisionRadius;
    const slabHalfHeight = thickness * 0.5 + broadExpand;
    if (
      Math.min(_collisionStartL.y, _collisionEndL.y) > slabHalfHeight ||
      Math.max(_collisionStartL.y, _collisionEndL.y) < -slabHalfHeight
    ) {
      return false;
    }

    const dxz = _collisionEndL.x - _collisionStartL.x;
    const dzx = _collisionEndL.z - _collisionStartL.z;
    const xzLenSq = dxz * dxz + dzx * dzx;
    let closestT = 0.0;
    if (xzLenSq > 1e-12) {
      closestT =
        -(_collisionStartL.x * dxz + _collisionStartL.z * dzx) /
        xzLenSq;
      closestT = Math.max(0.0, Math.min(1.0, closestT));
    }
    const closestX = _collisionStartL.x + dxz * closestT;
    const closestZ = _collisionStartL.z + dzx * closestT;
    const minRadialSq = closestX * closestX + closestZ * closestZ;
    const startRadialSq =
      _collisionStartL.x * _collisionStartL.x +
      _collisionStartL.z * _collisionStartL.z;
    const endRadialSq =
      _collisionEndL.x * _collisionEndL.x +
      _collisionEndL.z * _collisionEndL.z;
    const maxRadialSq = Math.max(startRadialSq, endRadialSq);
    const broadInner = Math.max(0.0, innerRadius - broadExpand);
    const broadOuter = outerRadius + broadExpand;
    if (
      maxRadialSq < broadInner * broadInner ||
      minRadialSq > broadOuter * broadOuter
    ) {
      return false;
    }

    const motionSq = _collisionDeltaL.lengthSq();
    let bestT = Number.isFinite(outHit.t) ? outHit.t : 1.000001;
    let bestPenetration = Number.isFinite(outHit.penetration)
      ? outHit.penetration
      : 0.0;
    let changed = false;

    for (let s = 0; s < segments; s++) {
      const info = segInfo[s];
      if (!info?.built || info.collisionRadius <= 0.0) continue;

      const batchRadius = info.collisionRadius + sphereRadiusL;
      if (
        pointSegmentDistanceSq(
          info.collisionCenter,
          _collisionStartL,
          _collisionEndL,
        ) >
        batchRadius * batchRadius
      ) {
        continue;
      }

      const colliders = info.colliders;
      for (let i = 0; i < colliders.length; i += 4) {
        const cx = colliders[i + 0];
        const cy = colliders[i + 1];
        const cz = colliders[i + 2];
        const combinedRadius = colliders[i + 3] + sphereRadiusL;

        const mx = _collisionStartL.x - cx;
        const my = _collisionStartL.y - cy;
        const mz = _collisionStartL.z - cz;
        const startDistSq = mx * mx + my * my + mz * mz;
        const c = startDistSq - combinedRadius * combinedRadius;

        let hitT = 0.0;
        let penetrationL = 0.0;
        const startedInside = c <= 0.0;

        if (startedInside) {
          penetrationL =
            combinedRadius - Math.sqrt(Math.max(0.0, startDistSq));
        } else {
          if (motionSq <= 1e-12) continue;
          const b =
            mx * _collisionDeltaL.x +
            my * _collisionDeltaL.y +
            mz * _collisionDeltaL.z;
          if (b >= 0.0) continue;

          const discriminant = b * b - motionSq * c;
          if (discriminant < 0.0) continue;

          hitT = (-b - Math.sqrt(discriminant)) / motionSq;
          if (hitT < 0.0 || hitT > 1.0) continue;
        }

        const penetrationW = penetrationL * minWorldScale;
        const isEarlier = hitT < bestT - 1e-7;
        const isDeeperAtSameTime =
          Math.abs(hitT - bestT) <= 1e-7 &&
          penetrationW > bestPenetration + 1e-6;
        if (!isEarlier && !isDeeperAtSameTime) continue;

        if (startedInside) {
          _collisionNormalL.set(mx, my, mz);
        } else {
          _collisionNormalL.set(
            _collisionStartL.x + _collisionDeltaL.x * hitT - cx,
            _collisionStartL.y + _collisionDeltaL.y * hitT - cy,
            _collisionStartL.z + _collisionDeltaL.z * hitT - cz,
          );
        }

        if (_collisionNormalL.lengthSq() <= 1e-12) {
          if (motionSq > 1e-12) {
            _collisionNormalL.copy(_collisionDeltaL).multiplyScalar(-1.0);
          } else {
            _collisionNormalL.set(0, 1, 0);
          }
        }
        _collisionNormalL.normalize();
        _collisionNormalW
          .copy(_collisionNormalL)
          .transformDirection(group.matrixWorld);

        if (!outHit.normal) outHit.normal = new THREE.Vector3();
        outHit.t = hitT;
        outHit.penetration = penetrationW;
        outHit.startedInside = startedInside;
        outHit.normal.copy(_collisionNormalW);
        outHit.belt = belt;
        outHit.segmentIndex = s;
        outHit.instanceIndex = i >> 2;

        bestT = hitT;
        bestPenetration = penetrationW;
        changed = true;
      }
    }

    return changed;
  }

  function update(focusPos, t = 0.0) {
    if (!focusPos) return;
    // Quick distance culling: hide batches that are far from the player.
    // (Frustum culling still applies, but this prevents distant batches from costing anything.)
    const fx = focusPos.x;
    const fz = focusPos.z;
    const maxD2 = maxVisibleDist * maxVisibleDist;
    for (let s = 0; s < segments; s++) {
      const info = segInfo[s];
      const c = info.center;
      const dx = fx - c.x;
      const dz = fz - c.z;
      const d2 = dx * dx + dz * dz;
      meshes[s].visible = info.built && d2 <= maxD2;
    }

    // Animate dust volume subtly.
    if (dustVolumeMesh?.material?.uniforms?.uTime) {
      dustVolumeMesh.material.uniforms.uTime.value = t;
      // Match visibility to the belt (roughly).
      dustVolumeMesh.visible = true;
    }
  }

  function dispose() {
    for (const m of meshes) {
      group.remove(m);
      m?.dispose?.();
    }
    if (dustMesh) {
      group.remove(dustMesh);
      // dustMesh is a Group of layers; dispose children materials.
      if (dustMesh.children && dustMesh.children.length) {
        for (const ch of dustMesh.children) {
          ch?.material?.dispose?.();
        }
      } else {
        dustMesh.material?.dispose?.();
      }
      // Shared geometry for all layers.
      dustRingGeom?.dispose?.();
      dustRingGeom = null;
      dustMesh = null;
    }
    if (dustVolumeMesh) {
      group.remove(dustVolumeMesh);
      dustVolumeMesh.geometry?.dispose?.();
      dustVolumeMesh.material?.dispose?.();
      dustVolumeMesh = null;
    }
    if (_fallbackNoiseTex) {
      _fallbackNoiseTex.dispose?.();
      _fallbackNoiseTex = null;
    }
    geom.dispose?.();
    mat.dispose?.();
  }

  const belt = {
    group,
    meshes,
    segInfo,
    dustMesh,
    dustMats,
    dustOccCenters,
    dustOccRadii,
    dustVolumeMesh,
    params: {
      seed,
      innerRadius,
      outerRadius,
      thickness,
      segments,
      asteroidsTotal,
      tilt,
      maxVisibleDist,
      baseColor,
      cosmicDust,
      dustRing,
      dustOpacity,
      collisionEnabled,
      collisionRadiusScale: colliderScale,
    },
    buildSegment,
    buildAll,
    buildNext,
    sweepSphere,
    update,
    dispose,
  };

  if (buildNow) belt.buildAll();
  return belt;
}

// -----------------------------------------------------------------------------
// Planet rings ("mini belts")
// - Reuses the same batched InstancedMesh approach as the main belt.
// - The ring is authored in the planet's local space (centered at planet origin).
// - Culling is based on player distance to the planet, not per-segment centers.
//   (Per-segment culling uses belt-local centers vs world focus and doesn't work
//    once the ring is parented under a translated planet.)
// -----------------------------------------------------------------------------

export function createPlanetRing({
  superPointLight = null,
  seed = 1,
  planetGroup,
  planetRadius = 1400,
  // Ring sizing relative to planet radius
  innerMul = 1.85,
  outerMul = 2.85,
  thickness = 80,
  // Orientation: yaw spins the ring around the planet axis; tilt/roll give variety
  yaw = 0.0,
  tilt = 0.0,
  roll = 0.0,
  // Batching / density
  segments = 12,
  asteroidsTotal = 3500,
  maxVisibleDist = 26000,
  baseColor = 0x6a6a6a,
  rockDetail = 2,
  noiseTex = null,
  // Dust knobs (clouds-tech shader)
  dustOpacity = 0.65,
  dustInnerFade = 0.10,
  dustBrightness = 1.85,
  dustNoiseScale = 0.00012,
  dustWindSpeed = 0.035,
  dustEclipseSoftness = 0.015,
  dustEclipseStrength = 1.0,
  buildNow = true,
} = {}) {
  // Create a mini belt centered at the planet origin.
  const ring = createAsteroidBelt({
    superPointLight,
    seed,
    innerRadius: Math.max(planetRadius * 1.1, planetRadius * innerMul),
    outerRadius: Math.max(planetRadius * 1.25, planetRadius * outerMul),
    thickness: Math.max(10, thickness),
    segments: Math.max(6, segments | 0),
    asteroidsTotal: Math.max(16, asteroidsTotal | 0),
    tilt: 0.0, // we'll apply full orientation below
    maxVisibleDist,
    baseColor,
    keepBaseColor: true,
    dustColor: baseColor,
    rockDetail,
    noiseTex,
    cosmicDust: false,
    // Planet ring dust is rendered as a depth-aware *post-process* volume pass
    // (world.ringDustPass), so keep the mesh-based dustRing off for rings.
    dustRing: false,
    buildNow,
  });

  ring.group.name = "PlanetRing";
  ring.group.userData.isPlanetRing = true;
  ring.group.userData.ignoreMiniMap = true;
  ring.group.userData.ignoreMinimap = true;

  // Orientation: match the planet's local space.
  ring.group.rotation.set(tilt, yaw, roll);

  // Parent under planet so it follows orbit/tilt.
  if (planetGroup?.add) planetGroup.add(ring.group);

  // Override update: cull as a whole by distance to planet.
  const tmpPlanetW = new THREE.Vector3();
  ring.update = (focusPos, t = 0.0) => {
    if (!focusPos || !planetGroup?.getWorldPosition) return;
    planetGroup.getWorldPosition(tmpPlanetW);
    const dx = focusPos.x - tmpPlanetW.x;
    const dy = focusPos.y - tmpPlanetW.y;
    const dz = focusPos.z - tmpPlanetW.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    const maxD2 = maxVisibleDist * maxVisibleDist;
    ring.group.visible = d2 <= maxD2;
    // Keep built segment meshes enabled when close enough; frustum culling then
    // rejects the angular batches outside the camera view.
    if (ring.group.visible) {
      for (let i = 0; i < ring.meshes.length; i++) {
        ring.meshes[i].visible = !!ring.segInfo[i]?.built;
      }
    }
    // (No dust mesh/volume for rings.)
  };

  return ring;
}
