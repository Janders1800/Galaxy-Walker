// gasGiantMaterial.js
// Portable Three.js gas-giant ShaderMaterial (seamless, DoubleSide, 1D procedural iChannel0 strip).
// No UI. Drop into your project and import/use.
//
// Usage:
//   import { createGasGiantMaterial, updateGasGiant } from "./gasGiantMaterial.js";
//   const { material, uniforms, randomizeStrip } = createGasGiantMaterial({ seed: 123 });
//   const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), material);
//   scene.add(mesh);
//   // in your render loop:
//   updateGasGiant(uniforms, camera, clock.getElapsedTime());
//
// Optional: call randomizeStrip() any time to change the predominant color family.

import { THREE } from "../render/device.js";
import {
  VOLUME_NOISE_GLSL,
  createVolumeNoiseAtlas,
  makeVolumeNoiseUniforms,
} from "../render/noiseTextures.js";

// Deterministic RNG (so gas-giant strip can be stable per-seed)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createGasGiantMaterial(options = {}) {
  const {
    // core look
    bandScale = 18.0,
    warpStrength = 0.10,
    detailStrength = 0.55,

    // original-ish knobs
    distortIterations = 6,
    texScale = 0.025,
    timeScale = 0.20,

    // lighting params (kept from your original naming)
    colStar = new THREE.Vector3(1.0, 0.7, 0.5),
    posStar = new THREE.Vector3(0.0, 9.0, 30.0),
    sunRadius = 1350.0,
    eclipseAmbientFloor = 0.12,

    // internal texture
    stripHeight = 256,

    // deterministic strip option
    seed = 0,

    // Shared texture-backed 3D noise. The world supplies one atlas to every
    // volumetric material; standalone callers receive a deterministic fallback.
    volumeNoiseTexture = null,
    volumeNoiseLayout = null,
  } = options;

  const rand = mulberry32((seed ?? 0) >>> 0);

  function makeChannel0Strip(height = 256) {
    // Seamless (tileable) vertical strip: width=1, height=H
    // Predominant hue random, not rainbow; tileable in Y.
    const baseHue = rand();
    const sat = 0.55 + rand() * 0.25;
    const val = 0.55 + rand() * 0.25;
    const TAU = Math.PI * 2;

    function hsvToRgb(h, s, v) {
      const i = Math.floor(h * 6);
      const f = h * 6 - i;
      const p = v * (1 - s);
      const q = v * (1 - f * s);
      const t = v * (1 - (1 - f) * s);
      const m = i % 6;
      if (m === 0) return [v, t, p];
      if (m === 1) return [q, v, p];
      if (m === 2) return [p, v, t];
      if (m === 3) return [p, q, v];
      if (m === 4) return [t, p, v];
      return [v, p, q];
    }

    function loopDist(t, c) {
      let d = Math.abs(t - c);
      d = Math.min(d, 1 - d);
      return d;
    }

    const data = new Uint8Array(height * 4);
    for (let y = 0; y < height; y++) {
      const t = y / height; // [0..1) tileable

      const hueJitter =
        Math.sin(TAU * (t * 2.0 + 0.13)) * 0.01 +
        Math.sin(TAU * (t * 5.0 + 0.37)) * 0.005;
      const h = (baseHue + hueJitter + 1) % 1;

      const base = 0.55 + 0.25 * Math.sin(TAU * (t + 0.18));
      const b1 = Math.exp(-Math.pow(loopDist(t, 0.30) / 0.07, 2.0)) * 0.25;
      const b2 = Math.exp(-Math.pow(loopDist(t, 0.58) / 0.05, 2.0)) * 0.35;
      const b3 = Math.exp(-Math.pow(loopDist(t, 0.83) / 0.04, 2.0)) * 0.20;

      const v2 = Math.min(1, val * base + b1 + b2 + b3);
      const s2 = Math.min(
        1,
        sat * (0.90 + 0.10 * Math.sin(TAU * (t * 1.0 + 0.41))),
      );

      const [R, G, B] = hsvToRgb(h, s2, v2);

      data[y * 4 + 0] = Math.floor(R * 255);
      data[y * 4 + 1] = Math.floor(G * 255);
      data[y * 4 + 2] = Math.floor(B * 255);
      data[y * 4 + 3] = 255;
    }

    const tex = new THREE.DataTexture(data, 1, height, THREE.RGBAFormat);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  const volumeNoise =
    volumeNoiseTexture && volumeNoiseLayout
      ? { texture: volumeNoiseTexture, layout: volumeNoiseLayout }
      : createVolumeNoiseAtlas(THREE, ((seed ?? 0) ^ 0x6a09e667) >>> 0);

  const uniforms = {
    ...makeVolumeNoiseUniforms(THREE, volumeNoise.texture, volumeNoise.layout),
    iTime: { value: 0.0 },
    iChannel0: { value: makeChannel0Strip(stripHeight) },

    // original-ish knobs
    distort_iterations: { value: distortIterations },
    tex_scale: { value: texScale },
    time_scale: { value: timeScale },

    // lighting-ish names preserved
    col_star: { value: colStar.clone() },
    pos_star: { value: posStar.clone() },
    cam_forward: { value: new THREE.Vector3(0, 0, -1) },

    // gas giant controls
    band_scale: { value: bandScale },
    warp_strength: { value: warpStrength },
    detail_strength: { value: detailStrength },

    // eclipse (shared system)
    uPlanetCenterW: { value: new THREE.Vector3() },
    uSunPosW: { value: new THREE.Vector3() },
    uSunRadius: { value: Math.max(0.0, sunRadius) },
    uEclipseAmbientFloor: {
      value: THREE.MathUtils.clamp(eclipseAmbientFloor, 0.0, 1.0),
    },
    uOccCount: { value: 0 },
    uOccCenters: { value: new Float32Array(24 * 3) },
    uOccRadii: { value: new Float32Array(24) },
    uEclipseSoftness: { value: 0.015 },
    uEclipseStrength: { value: 1.0 },
  };

  const vertexShader = `
    #include <common>
    #include <logdepthbuf_pars_vertex>

    varying vec3 vWorldPos;
    varying vec3 vWorldNormal;
    varying vec3 vObjPos;

    void main(){
      vObjPos = position;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPos = wp.xyz;
      vWorldNormal = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * wp;

      // Writes logarithmic depth when renderer.logarithmicDepthBuffer is enabled.
      #include <logdepthbuf_vertex>
    }
  `;

  const fragmentShader = `
    #include <common>
    #include <logdepthbuf_pars_fragment>

    precision highp float;

    uniform float iTime;
    uniform sampler2D iChannel0;

    uniform int distort_iterations;
    uniform float tex_scale;
    uniform float time_scale;

    uniform vec3 col_star;
    uniform vec3 pos_star;
    uniform vec3 cam_forward;

    uniform float band_scale;
    uniform float warp_strength;
    uniform float detail_strength;

    // Eclipse uniforms (ONLY addition)
    uniform vec3 uPlanetCenterW;
    uniform vec3 uSunPosW;
    uniform float uSunRadius;
    uniform float uEclipseAmbientFloor;
    uniform int   uOccCount;
    uniform vec3  uOccCenters[24];
    uniform float uOccRadii[24];
    uniform float uEclipseSoftness;
    uniform float uEclipseStrength;

    varying vec3 vWorldPos;
    varying vec3 vWorldNormal;
    varying vec3 vObjPos;

    ${VOLUME_NOISE_GLSL}

    vec3 distortSphere(vec3 p){
      float t = time_scale * iTime;
      vec4 macroNoise = sampleVolumeNoise(
        p * 0.31 + vec3(t * 0.013, -t * 0.009, t * 0.017)
      );
      vec3 warp = macroNoise.rgb * 2.0 - 1.0;
      warp -= p * dot(p, warp);
      return normalize(p + warp * warp_strength * 0.42);
    }

    vec3 doMaterial(vec3 pos){
      vec3 p = distortSphere(pos);
      float t = time_scale * iTime;

      vec4 macroNoise = sampleVolumeNoise(
        p * 0.47 + vec3(-t * 0.011, t * 0.007, t * 0.015)
      );
      vec4 detailNoise = sampleVolumeNoise(
        p * 1.23 + vec3(t * 0.019, -t * 0.013, t * 0.009)
      );

      float turbulence = dot(macroNoise, vec4(0.48, 0.27, 0.17, 0.08));
      float fine = mix(detailNoise.b, detailNoise.a, 0.45);
      float bands = p.y * band_scale;
      float y = bands +
        (turbulence - 0.5) * (2.6 * detail_strength) +
        (fine - 0.5) * (0.9 * detail_strength);

      vec3 strip = 2.5 * texture2D(iChannel0, vec2(0.0, y * tex_scale)).xyz;
      float modulation = 0.62 + 0.42 * mix(macroNoise.g, detailNoise.r, 0.35);
      return strip * modulation;
    }

    vec3 doLighting(in vec3 n, in vec3 c, in vec3 rd, in vec3 rdc){
      vec3  l   = normalize(pos_star + 2.0 * (pos_star - dot(pos_star, rdc) * rdc));
      float ndl = dot(n, l);
      float ndr = dot(n, -rd);
      float ldr = dot(l, rd);
      float f   = max(ndl, 0.0) + 0.002;
      float g   = ldr * smoothstep(0.0, 0.1, ndr) * pow(1.0 - ndr, 10.0);
      return clamp(f * c + g * col_star, 0.0, 1.0);
    }

    // Eclipse helpers (ONLY addition)
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
      vec3 toSun = sunPosW - pW;
      float sunDistance = length(toSun);
      if(sunDistance <= 1e-5) return 1.0;
      vec3 sunDirection = toSun / sunDistance;
      float visibility = 1.0;

      for(int i=0; i<24; i++){
        if(i >= uOccCount) break;
        float occR = max(0.0, uOccRadii[i]);
        if(occR <= 0.0) continue;

        vec3 toOcc = uOccCenters[i] - pW;
        float along = dot(toOcc, sunDirection);
        if(along <= 0.0 || along >= sunDistance) continue;

        float perp = length(toOcc - sunDirection * along);
        if(perp <= occR){
          visibility = 0.0;
          break;
        }

        float projectedSunRadius = max(
          uSunRadius * (along / sunDistance),
          occR * max(uEclipseSoftness, 0.0001)
        );
        float outer = occR + projectedSunRadius;
        if(perp >= outer) continue;

        float inner = abs(occR - projectedSunRadius);
        float overlap = 1.0 - smoothstep(
          inner,
          max(inner + 1e-4, outer),
          perp
        );
        float maxCoverage = occR >= projectedSunRadius
          ? 1.0
          : clamp(
              (occR * occR) / max(1e-5, projectedSunRadius * projectedSunRadius),
              0.0,
              1.0
            );

        visibility = min(visibility, 1.0 - overlap * maxCoverage);
      }

      return mix(1.0, visibility, clamp(uEclipseStrength, 0.0, 1.0));
    }

    void main(){
      // Ensures this material participates correctly in depth testing with
      // logarithmic depth buffer enabled (no visual change, just depth).
      #include <logdepthbuf_fragment>

      vec3 pos = normalize(vObjPos);

      // DoubleSide lighting fix
      vec3 nor = normalize(vWorldNormal);
      if(!gl_FrontFacing) nor = -nor;

      vec3 rd  = normalize(vWorldPos - cameraPosition);
      vec3 rdc = normalize(cam_forward);

      vec3 c = doMaterial(pos);
      c = doLighting(nor, c, rd, rdc);

      // Eclipse dimming (ONLY addition)
      float vis = sunVisibility(vWorldPos, uSunPosW);
      // Direct gas-giant illumination now follows the same eclipse visibility
      // as solid materials. Retain only the same small indirect/scattered fill
      // floor used by the unified SPL path instead of the old 45% totality glow.
      float eclipseDim = mix(
        clamp(uEclipseAmbientFloor, 0.0, 1.0),
        1.0,
        vis
      );
      vec3 upP = normalize(vWorldPos - uPlanetCenterW);
      vec3 sunDir = normalize(uSunPosW - uPlanetCenterW);
      float ndl0 = dot(upP, sunDir);
      float daySide = smoothstep(0.0, 0.25, ndl0);
      c *= mix(1.0, eclipseDim, daySide);

      c = pow(c, vec3(0.4545));
      gl_FragColor = vec4(c, 1.0);
    }
  `;

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    side: THREE.DoubleSide,
  });

  // Force fully-opaque rendering.
  // (Even with alpha=1.0 in the shader, any accidental transparency/sorting can make a large DoubleSide sphere
  // look "see-through". These flags keep it in the opaque pass.)
  material.transparent = false;
  material.opacity = 1.0;
  material.depthTest = true;
  material.depthWrite = true;
  material.alphaTest = 0.0;
  material.blending = THREE.NormalBlending;

  function randomizeStrip() {
    uniforms.iChannel0.value = makeChannel0Strip(stripHeight);
    uniforms.iChannel0.value.needsUpdate = true;
  }

  return { material, uniforms, randomizeStrip };
}

const _cameraForward = new THREE.Vector3();

// Call this each frame
export function updateGasGiant(uniforms, camera, timeSeconds) {
  uniforms.iTime.value = timeSeconds;
  camera.getWorldDirection(_cameraForward);
  uniforms.cam_forward.value.copy(_cameraForward);
}
