// gasGiantMaterial.js
// Portable Three.js gas-giant ShaderMaterial (seamless, DoubleSide, 1D procedural iChannel0 strip).
// No UI. Drop into your project and import/use.
//
// Usage:
//   import { createGasGiantMaterial, updateGasGiant } from "./gasGiantMaterial.js";
//   const { material, uniforms, randomizeStrip } = createGasGiantMaterial({ seed: 123 });
//   const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 192, 192), material);
//   scene.add(mesh);
//   // in your render loop:
//   updateGasGiant(uniforms, camera, clock.getElapsedTime());
//
// Optional: call randomizeStrip() any time to change the predominant color family.

import { THREE } from "../render/device.js";

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

    // internal texture
    stripHeight = 256,

    // deterministic strip option
    seed = 0,
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

  const uniforms = {
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
    uniform int   uOccCount;
    uniform vec3  uOccCenters[24];
    uniform float uOccRadii[24];
    uniform float uEclipseSoftness;
    uniform float uEclipseStrength;

    varying vec3 vWorldPos;
    varying vec3 vWorldNormal;
    varying vec3 vObjPos;

    float hash(float n) { return fract(sin(n) * 123.456789); }

    float noise(in vec3 p){
      vec3 fl = floor(p);
      vec3 fr = fract(p);
      fr = fr * fr * (3.0 - 2.0 * fr);

      float n = fl.x + fl.y * 157.0 + 113.0 * fl.z;
      return mix(
        mix(
          mix(hash(n +   0.0), hash(n +   1.0), fr.x),
          mix(hash(n + 157.0), hash(n + 158.0), fr.x), fr.y
        ),
        mix(
          mix(hash(n + 113.0), hash(n + 114.0), fr.x),
          mix(hash(n + 270.0), hash(n + 271.0), fr.x), fr.y
        ), fr.z
      );
    }

    float fbm3(vec3 p){
      float f = 0.0;
      float a = 0.5;
      for(int i=0;i<5;i++){
        f += a * noise(p);
        p *= 2.02;
        a *= 0.5;
      }
      return f;
    }

    vec3 gradFbm(vec3 p){
      float e = 0.12;
      float fx1 = fbm3(p + vec3(e,0,0));
      float fx0 = fbm3(p - vec3(e,0,0));
      float fy1 = fbm3(p + vec3(0,e,0));
      float fy0 = fbm3(p - vec3(0,e,0));
      float fz1 = fbm3(p + vec3(0,0,e));
      float fz0 = fbm3(p - vec3(0,0,e));
      return vec3(fx1 - fx0, fy1 - fy0, fz1 - fz0) / (2.0 * e);
    }

    vec3 sphereField(vec3 p, float t){
      vec3 g1 = gradFbm(p * 2.0 + vec3(0.0, t*0.4, t*0.2));
      vec3 g2 = gradFbm(p * 4.0 + vec3(t*0.15, 0.0, -t*0.1));
      vec3 f = normalize(g1 + 0.6 * g2);

      // project onto tangent plane (seamless)
      f -= p * dot(p, f);
      return normalize(f + 1e-6);
    }

    vec3 distortSphere(vec3 p){
      const int MAX_IT = 12;
      int it = clamp(distort_iterations, 1, MAX_IT);
      float t = time_scale * iTime;

      for(int i=0;i<MAX_IT;i++){
        if(i >= it) break;
        vec3 f = sphereField(p, t + float(i) * 0.7);
        p = normalize(p + f * (warp_strength / float(it)));
      }
      return p;
    }

    vec3 doMaterial(vec3 pos){
      vec3 p = distortSphere(pos);

      // gas-giant bands mainly from latitude (p.y)
      float bands = p.y * band_scale;

      // turbulence/detail (seamless because it uses 3D p)
      float turb = fbm3(p * 6.0  + vec3(0.0, iTime*0.15, iTime*0.05));
      float fine = fbm3(p * 14.0 + vec3(iTime*0.2, 0.0, -iTime*0.12));

      float y = bands + turb * (2.2 * detail_strength) + fine * (0.8 * detail_strength);

      // 1D strip sample (x=0), y repeated
      vec3 s = 2.5 * texture2D(iChannel0, vec2(0.0, y * tex_scale)).xyz;

      // intensity modulation, similar spirit to original
      float m = 0.55 + 0.45 * fbm3(p * 3.0);
      return s * m;
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
      float eclipseDim = mix(1.0, 0.45, 1.0 - vis);
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

// Call this each frame
export function updateGasGiant(uniforms, camera, timeSeconds) {
  uniforms.iTime.value = timeSeconds;

  // camera forward vector (world)
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  uniforms.cam_forward.value.copy(fwd);
}
