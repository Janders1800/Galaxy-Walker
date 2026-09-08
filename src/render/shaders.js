import { CLOUD_NOISE_GLSL, VOLUME_NOISE_GLSL } from "./noiseTextures.js";

// src/render/shaders.js
// Centralized shader sources + small factory helpers for full-screen passes.

export const FULLSCREEN_VS = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position,1.0); }`;

// Fullscreen triangle (fewer verts than quad, no edge seam issues).
export function createFullscreenTri(THREE) {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  g.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2),
  );
  return g;
}

export function createCopyPass(THREE, fsTri, texture, exposure = 0.25) {
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    uniforms: {
      tColor: { value: texture },
      uExposure: { value: exposure },
    },
    vertexShader: FULLSCREEN_VS,
    fragmentShader: `
precision highp float;
uniform sampler2D tColor;
uniform float uExposure;
varying vec2 vUv;

vec3 acesToneMap(vec3 x){
  x *= uExposure;
  return clamp((x * (2.51*x + 0.03)) / (x * (2.43*x + 0.59) + 0.14), 0.0, 1.0);
}

void main(){
  vec3 col = texture2D(tColor, clamp(vUv,0.0,1.0)).rgb; // linear
  col = acesToneMap(col);
  gl_FragColor = linearToOutputTexel(vec4(col, 1.0));
}
`,
  });
  const mesh = new THREE.Mesh(fsTri, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { scene, material, mesh };
}

export function createAtmoCopyPass(THREE, fsTri, texture, exposure = 0.25) {
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
    uniforms: {
      tAtmo: { value: texture },
      uExposure: { value: exposure },
    },
    vertexShader: FULLSCREEN_VS,
    fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform sampler2D tAtmo;
uniform float uExposure;

vec3 acesToneMap(vec3 x){
  x *= uExposure;
  return clamp((x * (2.51*x + 0.03)) / (x * (2.43*x + 0.59) + 0.14), 0.0, 1.0);
}

void main(){
  // Normal blending into the transparent atmosphere target stores RGB in
  // premultiplied form. Recover straight HDR colour before tone mapping; the
  // final NormalBlending operation then applies alpha exactly once.
  vec4 c = texture2D(tAtmo, clamp(vUv,0.0,1.0));
  if(c.a <= 1e-6) discard;
  vec3 straightColor = c.rgb / max(c.a, 1e-6);
  straightColor = acesToneMap(straightColor);
  gl_FragColor = linearToOutputTexel(vec4(straightColor, c.a));
}
`,
  });
  const mesh = new THREE.Mesh(fsTri, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { scene, material, mesh };
}

// Upsamples a low-resolution RGBA render target into the current target.
// The source pass renders with NoBlending; the intended blend is applied once,
// here, rather than once into the low-res target and again during upsampling.
export function createTextureCompositePass(
  THREE,
  fsTri,
  texture,
  blending = THREE.NormalBlending,
) {
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending,
    toneMapped: false,
    uniforms: {
      tTexture: { value: texture },
    },
    vertexShader: FULLSCREEN_VS,
    fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform sampler2D tTexture;

void main(){
  gl_FragColor = texture2D(tTexture, clamp(vUv, 0.0, 1.0));
}
`,
  });
  const mesh = new THREE.Mesh(fsTri, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { scene, material, mesh };
}

// Composes all HDR layers in linear space and tone maps exactly once. Cloud and
// ring histories are interpolated here, avoiding extra full-screen blits.
export function createFinalCompositePass(
  THREE,
  fsTri,
  {
    sceneTexture = null,
    atmosphereTexture = null,
    cloudPrevTexture = null,
    cloudCurrentTexture = null,
    ringPrevTexture = null,
    ringCurrentTexture = null,
    godRaysTexture = null,
    blueNoiseTexture = null,
  } = {},
  exposure = 0.25,
) {
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    transparent: false,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    uniforms: {
      tScene: { value: sceneTexture },
      tAtmosphere: { value: atmosphereTexture },
      tCloudPrev: { value: cloudPrevTexture },
      tCloudCurrent: { value: cloudCurrentTexture },
      tRingPrev: { value: ringPrevTexture },
      tRingCurrent: { value: ringCurrentTexture },
      tGodRays: { value: godRaysTexture },
      tBlueNoise: { value: blueNoiseTexture },
      uExposure: { value: exposure },
      uCloudBlend: { value: 1.0 },
      uRingBlend: { value: 1.0 },
      uHasAtmosphere: { value: 0.0 },
      uHasClouds: { value: 0.0 },
      uHasRingDust: { value: 0.0 },
      uHasGodRays: { value: 0.0 },
      uUnderwaterColor: { value: new THREE.Color(0x06131f) },
      uUnderwaterOpacity: { value: 0.0 },
      uParticleColor: { value: new THREE.Color(0x0a2430) },
      uParticleOpacity: { value: 0.0 },
      uBlueNoiseSize: { value: new THREE.Vector2(256, 256) },
      uTime: { value: 0.0 },
    },
    vertexShader: FULLSCREEN_VS,
    fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tAtmosphere;
uniform sampler2D tCloudPrev;
uniform sampler2D tCloudCurrent;
uniform sampler2D tRingPrev;
uniform sampler2D tRingCurrent;
uniform sampler2D tGodRays;
uniform sampler2D tBlueNoise;
uniform float uExposure;
uniform float uCloudBlend;
uniform float uRingBlend;
uniform float uHasAtmosphere;
uniform float uHasClouds;
uniform float uHasRingDust;
uniform float uHasGodRays;
uniform vec3 uUnderwaterColor;
uniform float uUnderwaterOpacity;
uniform vec3 uParticleColor;
uniform float uParticleOpacity;
uniform vec2 uBlueNoiseSize;
uniform float uTime;

vec3 acesToneMap(vec3 x){
  x *= uExposure;
  return clamp((x * (2.51*x + 0.03)) / (x * (2.43*x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 overPremultiplied(vec3 background, vec4 layer){
  return layer.rgb + background * (1.0 - clamp(layer.a, 0.0, 1.0));
}

void main(){
  vec2 uv = clamp(vUv, 0.0, 1.0);
  vec3 hdr = texture2D(tScene, uv).rgb;

  if(uHasAtmosphere > 0.5){
    hdr = overPremultiplied(hdr, texture2D(tAtmosphere, uv));
  }
  if(uHasClouds > 0.5){
    vec4 cloud = mix(
      texture2D(tCloudPrev, uv),
      texture2D(tCloudCurrent, uv),
      clamp(uCloudBlend, 0.0, 1.0)
    );
    hdr = overPremultiplied(hdr, cloud);
  }
  if(uHasRingDust > 0.5){
    vec4 ring = mix(
      texture2D(tRingPrev, uv),
      texture2D(tRingCurrent, uv),
      clamp(uRingBlend, 0.0, 1.0)
    );
    hdr = overPremultiplied(hdr, ring);
  }
  if(uHasGodRays > 0.5){
    hdr += texture2D(tGodRays, uv).rgb;
  }

  vec3 color = acesToneMap(hdr);
  color = mix(color, uUnderwaterColor, clamp(uUnderwaterOpacity, 0.0, 1.0));

  if(uParticleOpacity > 0.0001){
    vec2 tile = max(uBlueNoiseSize, vec2(1.0));
    vec2 noiseUv = fract(
      (gl_FragCoord.xy + vec2(uTime * 60.0, uTime * 35.0)) / tile
    );
    float n = texture2D(tBlueNoise, noiseUv).r;
    float speck = smoothstep(0.78, 0.95, n) *
      (0.65 + 0.35 * sin(uTime * 1.7));
    float alpha = speck * uParticleOpacity;
    color = mix(color, uParticleColor * (0.55 + 0.45 * n), alpha);
  }

  gl_FragColor = linearToOutputTexel(vec4(color, 1.0));
}
`,
  });
  const mesh = new THREE.Mesh(fsTri, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { scene, material, mesh };
}

export function createUnderwaterPost(
  THREE,
  fsTri,
  blueNoiseTex,
  sceneTexture = null,
  depthTexture = null,
) {
  const scene = new THREE.Scene();

  // The old underwater pass was only a translucent colour wash. It could not
  // refract the finished frame, and the sky dome ignored scene fog entirely.
  // This pass samples the fully composed frame from an offscreen target, then
  // applies water-path-dependent refraction, blur, absorption and in-scatter.
  const tintMat = new THREE.ShaderMaterial({
    transparent: false,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    uniforms: {
      tScene: { value: sceneTexture },
      tDepth: { value: depthTexture },
      uNoiseTex: { value: blueNoiseTex },
      uNoiseSize: { value: new THREE.Vector2(256, 256) },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uInvProjMatrix: { value: new THREE.Matrix4() },
      uInvViewMatrix: { value: new THREE.Matrix4() },
      uCameraPosW: { value: new THREE.Vector3() },
      uOceanCenterW: { value: new THREE.Vector3() },
      uOceanRadius: { value: 1.0 },
      uCameraDepth: { value: 0.0 },
      uLogDepthFC: { value: 1.0 },
      uColor: { value: new THREE.Color(0x06131f) },
      uLightFactor: { value: 1.0 },
      uOpacity: { value: 0.0 },
      uTime: { value: 0.0 },
    },
    vertexShader: FULLSCREEN_VS,
    fragmentShader: `
precision highp float;
varying vec2 vUv;

uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D uNoiseTex;
uniform vec2 uNoiseSize;
uniform vec2 uResolution;
uniform mat4 uInvProjMatrix;
uniform mat4 uInvViewMatrix;
uniform vec3 uCameraPosW;
uniform vec3 uOceanCenterW;
uniform float uOceanRadius;
uniform float uCameraDepth;
uniform float uLogDepthFC;
uniform vec3 uColor;
uniform float uLightFactor;
uniform float uOpacity;
uniform float uTime;

vec2 raySphere(vec3 ro, vec3 rd, vec3 center, float radius){
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - radius * radius;
  float h = b * b - c;
  if(h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

float sceneDistanceFromLogDepth(vec2 uv, vec3 rdV){
  float d = texture2D(tDepth, clamp(uv, 0.0, 1.0)).r;
  if(d >= 0.999999) return 1e9;

  float log2v = (d * 2.0) / max(uLogDepthFC, 1e-8);
  float vFragDepth = exp2(log2v);
  float viewZ = -(vFragDepth - 1.0);
  float t = viewZ / min(rdV.z, -1e-6);
  return t > 0.0 ? t : 1e9;
}

vec3 sampleBlurredFrame(vec2 uv, vec2 blurDir, float blurRadius){
  vec2 texel = 1.0 / max(uResolution, vec2(1.0));
  vec2 o = blurDir * texel * blurRadius;
  vec3 c = texture2D(tScene, clamp(uv, 0.001, 0.999)).rgb * 0.56;
  c += texture2D(tScene, clamp(uv + o, 0.001, 0.999)).rgb * 0.22;
  c += texture2D(tScene, clamp(uv - o, 0.001, 0.999)).rgb * 0.22;
  return c;
}

void main(){
  vec2 uv = clamp(vUv, 0.0, 1.0);

  vec4 farV = uInvProjMatrix * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 rdV = normalize(farV.xyz / max(abs(farV.w), 1e-6));
  vec3 rdW = normalize((uInvViewMatrix * vec4(rdV, 0.0)).xyz);

  vec2 oceanHit = raySphere(
    uCameraPosW,
    rdW,
    uOceanCenterW,
    max(uOceanRadius, 1e-4)
  );
  float exitDistance = max(oceanHit.y, 0.0);
  float sceneDistance = sceneDistanceFromLogDepth(uv, rdV);
  float waterPath = min(exitDistance, sceneDistance);

  // Defensive fallback for the frame in which the camera crosses the mean
  // ocean radius. The pass is only submitted while the camera is underwater.
  if(!(waterPath > 0.0) || waterPath > 1e8){
    waterPath = max(uCameraDepth, 0.05);
  }

  vec3 exitPosition = uCameraPosW + rdW * exitDistance;
  vec3 surfaceNormal = normalize(exitPosition - uOceanCenterW);
  float surfaceCosine = clamp(abs(dot(rdW, surfaceNormal)), 0.0, 1.0);
  float grazing = pow(1.0 - surfaceCosine, 1.35);

  // If opaque scene depth lies beyond the water exit, this ray is looking
  // through the water/air interface at atmosphere or sky. Give that interface
  // a minimum optical thickness so shallow water never looks like clean glass.
  float throughSurface = step(
    exitDistance + max(0.15, exitDistance * 0.0015),
    sceneDistance
  );

  float depthN = 1.0 - exp(-max(uCameraDepth, 0.0) / 12.0);

  // Keep the existing depth-dependent refraction response, but double the
  // optical visibility distance so underwater fog and colour absorption are
  // half as aggressive. Separating the two ranges avoids weakening the wave
  // distortion and blur that make the view read as submerged.
  float refractionRange = mix(38.0, 7.5, depthN);
  float visibilityRange = refractionRange * 2.0;
  float interfacePath = throughSurface * (
    mix(5.0, 9.0, depthN) + grazing * 15.0
  );
  float effectivePath = min(
    waterPath + interfacePath,
    visibilityRange * 12.0
  );
  float pathN = 1.0 - exp(-effectivePath / max(refractionRange, 1e-4));

  vec2 aspect = vec2(
    max(uResolution.x / max(uResolution.y, 1.0), 1e-4),
    1.0
  );
  vec2 p = (uv - 0.5) * aspect;

  vec2 tile = max(uNoiseSize, vec2(1.0));
  vec2 noiseUv = fract(
    (gl_FragCoord.xy + vec2(uTime * 31.0, -uTime * 23.0)) / tile
  );
  float micro = texture2D(uNoiseTex, noiseUv).r - 0.5;

  float w0 = sin(p.y * 31.0 + uTime * 1.55 + sin(p.x * 13.0 - uTime * 0.72));
  float w1 = cos(p.x * 27.0 - uTime * 1.18 + sin(p.y * 17.0 + uTime * 0.61));
  float w2 = sin((p.x + p.y) * 19.0 + uTime * 0.83);
  vec2 flow = vec2(w0 + 0.34 * w2, w1 - 0.29 * w2);
  flow += micro * vec2(0.32, -0.24);

  float distortion = mix(0.0017, 0.0065, depthN);
  distortion *= (0.46 + 0.54 * pathN);
  distortion *= 1.0 + throughSurface * grazing * 0.85;
  vec2 distortedUv = clamp(uv + flow * distortion, 0.002, 0.998);

  vec2 blurDir = normalize(flow + vec2(0.0001, -0.0001));
  float blurRadius = mix(0.55, 2.35, depthN) * (0.35 + 0.65 * pathN);
  vec3 source = sampleBlurredFrame(distortedUv, blurDir, blurRadius);

  // Beer-Lambert absorption: red disappears fastest, blue survives longest.
  // The visibility range falls sharply with camera depth, so both the surface
  // and nearby terrain become progressively harder to see while descending.
  float turbidity = mix(0.82, 1.75, depthN);
  vec3 extinction = vec3(2.35, 1.12, 0.62) *
    (effectivePath / max(visibilityRange, 1e-4)) * turbidity;
  vec3 transmittance = exp(-extinction);

  float light = clamp(uLightFactor, 0.0, 1.0);
  vec3 scatterColor = uColor * mix(0.18, 0.78, light);
  scatterColor += vec3(0.002, 0.010, 0.018) * (1.0 - light);

  vec3 waterColor = source * transmittance +
    scatterColor * (vec3(1.0) - transmittance);

  float veil = 1.0 - exp(
    -effectivePath / max(visibilityRange * 0.72, 1e-4)
  );
  waterColor = mix(
    waterColor,
    scatterColor,
    veil * mix(0.16, 0.46, depthN)
  );

  // Looking through the interface receives a little extra forward scatter,
  // which prevents a crisp, high-contrast sky boundary below the surface.
  waterColor = mix(
    waterColor,
    scatterColor,
    throughSurface * (0.04 + 0.09 * grazing) * (0.45 + 0.55 * depthN)
  );

  vec3 original = texture2D(tScene, uv).rgb;
  vec3 color = mix(original, waterColor, clamp(uOpacity, 0.0, 1.0));
  gl_FragColor = linearToOutputTexel(vec4(max(color, 0.0), 1.0));
}
`,
  });
  const tintMesh = new THREE.Mesh(fsTri, tintMat);
  tintMesh.frustumCulled = false;
  tintMesh.renderOrder = 0;
  scene.add(tintMesh);

  const particlesMat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(0x0a2430) },
      uOpacity: { value: 0.0 },
      uTime: { value: 0.0 },
      uNoiseTex: { value: blueNoiseTex },
      uNoiseSize: { value: new THREE.Vector2(256, 256) },
    },
    vertexShader: FULLSCREEN_VS,
    fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
uniform sampler2D uNoiseTex;
uniform vec2 uNoiseSize;
void main(){
  vec2 tile = max(uNoiseSize, vec2(1.0));
  vec2 uvn = fract((gl_FragCoord.xy + vec2(uTime*60.0, uTime*35.0)) / tile);
  float n = texture2D(uNoiseTex, uvn).r;
  float speck = smoothstep(0.78, 0.95, n) * (0.65 + 0.35*sin(uTime*1.7));
  float v = speck * uOpacity;
  gl_FragColor = vec4(uColor * (0.55 + 0.45*n), v);
}
`,
  });
  const particlesMesh = new THREE.Mesh(fsTri, particlesMat);
  particlesMesh.frustumCulled = false;
  particlesMesh.renderOrder = 1;
  scene.add(particlesMesh);

  return { scene, tintMat, particlesMat, tintMesh, particlesMesh };
}

export function createGodRaysPass(THREE, fsTri, depthTex, cloudTex, samples = 8) {
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    transparent: false,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    uniforms: {
      tDepth: { value: depthTex },
      tCloud: { value: cloudTex },
      uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
      uLightColor: { value: new THREE.Color(1.0, 0.95, 0.85) },
      uIntensity: { value: 0.0 },
      uWeight: { value: 0.18 },
      uSamples: { value: samples },
      uDecay: { value: 0.92 },
      uDensity: { value: 0.7 },
    },
    vertexShader: FULLSCREEN_VS,
    fragmentShader: `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDepth;
uniform sampler2D tCloud;
uniform vec2 uSunScreen;
uniform vec3 uLightColor;
uniform float uIntensity;
uniform float uDecay;
uniform float uDensity;
uniform float uWeight;
uniform float uSamples;

float depthAt(vec2 uv){ return texture2D(tDepth, uv).r; }
float cloudAt(vec2 uv){ return texture2D(tCloud, uv).r; }

void main(){
  vec2 uv = vUv;
  vec2 s = uSunScreen;
  float sampleCount = clamp(floor(uSamples + 0.5), 1.0, 24.0);
  float onScreen =
    step(0.0, s.x) * step(0.0, s.y) * step(s.x, 1.0) * step(s.y, 1.0);

  vec2 delta = (s - uv) * (uDensity / sampleCount);

  float illum = 0.0;
  float decay = 1.0;

  for(float i=0.0; i<24.0; i++){
    if(i >= sampleCount) break;
    uv += delta;

    float d = depthAt(uv);
    float occluded = step(d, 0.99999);

    float cloud = cloudAt(uv);
    float trans = 1.0 - cloud;

    illum += (1.0 - occluded) * trans * decay * uWeight;
    decay *= uDecay;
  }

  vec3 col = illum * uLightColor * uIntensity * onScreen;
  gl_FragColor = vec4(col, illum * onScreen);
}
`,
  });
  const mesh = new THREE.Mesh(fsTri, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { scene, material, mesh };
}

export function createWarpOverlay(THREE, width, height) {
  const warpScene = new THREE.Scene();
  const warpCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const warpMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: 0 },
      uFade: { value: 0 },
      uFlash: { value: 0 },
      uResolution: { value: new THREE.Vector2(width, height) },
      uVerticalMode: { value: 0.0 },
    },
    vertexShader: `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`,
    fragmentShader: `
precision highp float;
varying vec2 vUv;

uniform float uTime;
uniform float uStrength;
uniform float uFade;
uniform float uFlash;
uniform vec2  uResolution;
uniform float uVerticalMode;

#define PI 3.14159265358979323846
#define TAU 6.28318530717958647692

float hash11(float p){
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float tunnelLayer(
  vec2 p,
  float time,
  float strength,
  float cells,
  float speed,
  float seed,
  float maxStretch
){
  float r = max(length(p), 0.018);
  float ang = atan(p.y, p.x) / TAU + 0.5;

  // A very small depth-dependent twist prevents the tunnel from reading as a
  // static set of spokes without making the camera feel like it is rolling.
  ang += 0.010 * sin(time * 0.42 + log(r + 0.04) * 4.2 + seed * 2.7);
  ang = fract(ang);

  float sector = ang * cells;
  float sid = floor(sector);
  float lane = fract(sector) - 0.5;

  // 1/r behaves like forward perspective: cells accelerate outward from the
  // vanishing point while their radial trails lengthen as warp strength rises.
  float depth = 0.245 / r + time * speed + seed * 9.17;
  float zid = floor(depth);
  float phase = fract(depth);

  float rnd = hash11(sid * 19.73 + zid * 47.11 + seed * 113.7);
  float laneCenter = (rnd - 0.5) * 0.62;
  float widthRnd = hash11(sid * 7.31 + zid * 13.91 + seed * 71.3);
  float laneWidth = mix(0.010, 0.033, widthRnd);
  float line = 1.0 - smoothstep(
    laneWidth,
    laneWidth * 3.1,
    abs(lane - laneCenter)
  );

  float stretch = mix(0.045, maxStretch, strength);
  float trail = exp(-phase / max(stretch, 0.001));
  float head = exp(-phase / 0.020);
  float sparkle = mix(
    0.45,
    2.1,
    pow(hash11(sid * 91.7 + zid * 17.9 + seed * 29.1), 3.0)
  );

  float radialMask = smoothstep(0.025, 0.11, r)
                   * (1.0 - smoothstep(1.02, 1.55, r));
  float perspectiveGain = 1.0 / (0.62 + r * 1.15);

  return line
       * (trail * 0.72 + head * 1.65)
       * sparkle
       * radialMask
       * perspectiveGain;
}

void main(){
  float s = clamp(uStrength, 0.0, 1.0);
  float a = clamp(uFade, 0.0, 1.0);
  float flash = clamp(uFlash, 0.0, 1.0);
  if (a <= 0.0001 && flash <= 0.0001) {
    gl_FragColor = vec4(0.0);
    return;
  }

  vec2 fragCoord = vUv * uResolution;
  vec2 p = (fragCoord - 0.5 * uResolution) / max(uResolution.y, 1.0);
  if (uVerticalMode > 0.5) p.y *= 0.72;

  float r = length(p);
  float t = uTime;

  // Three independent depth layers give the tunnel actual parallax instead of
  // the old flat RGB stripe pattern.
  float l0 = tunnelLayer(p, t, s, 118.0, 0.88, 0.17, 0.34);
  float l1 = tunnelLayer(p, t, s, 83.0,  0.57, 1.91, 0.27);
  float l2 = tunnelLayer(p, t, s, 151.0, 1.16, 4.73, 0.40);

  vec3 col = vec3(0.0015, 0.0035, 0.0110);
  col += l0 * vec3(0.42, 0.78, 1.70);
  col += l1 * vec3(0.72, 0.36, 1.42);
  col += l2 * vec3(0.72, 1.18, 1.72);

  // Soft luminous depth bands add structure between the discrete streaks.
  float depthBands = 0.5 + 0.5 * cos(
    log(r + 0.055) * 18.0 - t * (5.5 + 4.5 * s)
  );
  depthBands = pow(depthBands, 6.0);
  float bandMask = smoothstep(0.06, 0.28, r)
                 * (1.0 - smoothstep(0.92, 1.42, r));
  col += vec3(0.025, 0.075, 0.18) * depthBands * bandMask * (0.2 + 0.8 * s);

  // Bright vanishing point and forward-scattering haze sell speed without
  // flattening the whole image into white.
  float core = exp(-r * mix(18.0, 8.0, s));
  float halo = exp(-r * mix(6.5, 3.1, s));
  col += vec3(0.75, 0.92, 1.35) * core * (0.22 + 1.25 * s);
  col += vec3(0.045, 0.13, 0.34) * halo * s;

  // Entry/exit compression ring. During entry it expands out from the center;
  // during the controller's strength ramp-down it naturally contracts again.
  float ringProgress = smoothstep(0.035, 0.72, s);
  float ringRadius = mix(0.025, 1.10, ringProgress);
  float shock = exp(-abs(r - ringRadius) * 38.0);
  float shockGate = smoothstep(0.015, 0.16, s)
                  * (1.0 - smoothstep(0.78, 1.0, s));
  col += shock * shockGate * vec3(0.50, 0.78, 1.42) * 1.35;

  // Mild blue/violet edge energy gives a lens-like warp envelope.
  float edge = smoothstep(0.38, 1.16, r)
             * (1.0 - smoothstep(1.16, 1.52, r));
  float edgePulse = 0.72 + 0.28 * sin(t * 3.7 + r * 15.0);
  col += vec3(0.035, 0.055, 0.16) * edge * edgePulse * s;

  // Strength drives the tunnel itself. uFade intentionally remains the final
  // alpha because the warp controller uses it to hold black during system swap.
  col *= s;

  // Filmic-ish compression keeps the layered highlights bright without harsh
  // clipping when multiple streak layers overlap.
  col = vec3(1.0) - exp(-col * 1.35);

  // Entry/exit flash is composited inside this same fullscreen pass so it
  // cannot expose a frame between transition phases. At flash=1 the entire
  // viewport is opaque white regardless of the tunnel/base fade underneath.
  col = mix(col, vec3(1.0), flash);
  gl_FragColor = vec4(col, max(a, flash));
}
`,
  });

  const warpQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), warpMat);
  warpQuad.frustumCulled = false;
  warpScene.add(warpQuad);

  return { warpScene, warpCam, warpMat };
}

export function resizeWarpOverlay(warpMat, w, h) {
  warpMat.uniforms.uResolution.value.set(w, h);
}

// Atmosphere + clouds (shared by per-planet passes)
export const ATMO_VS = `varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position,1.0); }`;
export const ATMO_FS = `
            precision highp float;
            varying vec2 vUv;

            uniform mat4 uInvViewMatrix;
            uniform mat4 uInvProjMatrix;

            uniform sampler2D uDepthTex;
            uniform float uLogDepthFC;

            uniform vec3  uPlanetCenterW;
            uniform float uPlanetRadius;
            // Inner cutoff radius for atmosphere raymarch.
            // For ocean planets with vertex-displaced waves, this should be slightly
            // smaller than the nominal radius so the atmosphere integrates down to
            // the *deformed* water surface (avoids "missing atmo" in wave troughs).
            uniform float uGroundRadius;
            // Mean ocean radius, or a negative value when this body has no ocean.
            // The ocean colour pass remains visible underwater, but does not write
            // depth there; this lets us integrate the real air/cloud segment above
            // the water surface instead of stopping at the transparent water mesh.
            uniform float uOceanRadius;
            uniform float uAtmoHeight;
            uniform vec3  uSunPosW;
            uniform float uSunRadius;
            uniform float uSurfaceSunDiscIntensity;
            uniform float uSurfaceSunHaloIntensity;

            uniform sampler2D uBlueNoiseTex;
            uniform vec2      uBlueNoiseSize;

            ${CLOUD_NOISE_GLSL}

            uniform float uAtmoSteps;
            uniform float uAtmoDensity;
            uniform float uAtmoScaleHeight;
            uniform float uBlueStrength;
            uniform float uSunsetStrength;
            uniform float uNightDarken;
            uniform float uSunGlare;
            uniform float uMinLight;
            uniform float uDayOpacityBoost;
            // Dense-day opacity targets over the host planet and over
            // background space/other bodies. They are reached only when the
            // raymarch finds enough real optical depth, keeping the outer edge
            // smooth and transparent.
            uniform float uDaySurfaceOpacity;
            uniform float uDayBackgroundOpacity;

            uniform float uCloudBase;
            uniform float uCloudThickness;
            uniform float uCloudSteps;
            uniform float uCloudDensity;
            // Normalize optical transport by cloud-layer thickness. Without
            // this, the same density becomes an opaque decal on larger planets.
            uniform float uCloudExtinctionScale;
            uniform float uCloudLightExtinctionScale;
            uniform float uCloudAmbientStrength;
            uniform float uCloudCoverage;
            uniform float uCloudSoftness;
            uniform float uCloudFreq;
            uniform float uCloudDetailFreq;
            uniform vec3 uCloudNoiseOffset;
            uniform float uCloudWindSpeed;
            uniform float uCloudLightSteps;
            uniform float uCloudShadowStrength;
            uniform float uCloudPhase;
            uniform float uCloudDetailLod;
            uniform float uCloudMultiScatterStrength;
            uniform float uCloudPowderStrength;
            uniform float uCloudSkipStrength;

            uniform float uUseCheapClouds;
            uniform float uCheapCloudAlpha;
            uniform float uCheapCloudScale;
            uniform float uCheapCloudSharp;
            uniform float uCheapCloudRim;
            uniform float uCheapCloudFarBoost;
            uniform float uCheapCloudContrast;

            uniform vec3 uAtmoTint;
            uniform vec3 uCloudTint;

            uniform int   uOccCount;
            uniform vec3  uOccCenters[24];
            uniform float uOccRadii[24];
            uniform float uEclipseSoftness;
            uniform float uEclipseStrength;

            uniform float uTime;
            // 0 = combined (legacy), 1 = atmosphere only, 2 = clouds only.
            uniform float uRenderMode;

            float saturate(float x){ return clamp(x, 0.0, 1.0); }

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

            vec2 eclipseVisibilityPair(vec3 pW, vec3 sunPosW){
              vec3 toSun = sunPosW - pW;
              float sunDistance = length(toSun);
              if(sunDistance <= 1e-5) return vec2(1.0);
              vec3 sunDirection = toSun / sunDistance;

              // x = cloud visibility. y = atmosphere visibility.
              // Both now use the legacy pre-SPL-unification soft silhouette
              // in this shared atmosphere/cloud shader. Other receivers in the
              // unified eclipse system keep their current hard-core +
              // finite-disc behavior.
              float cloudVisibility = 1.0;
              float atmoVisibility = 1.0;

              for(int i=0; i<24; i++){
                if(i >= uOccCount) break;
                float occR = max(0.0, uOccRadii[i]);
                if(occR <= 0.0) continue;

                vec3 toOcc = uOccCenters[i] - pW;
                float along = dot(toOcc, sunDirection);
                if(along <= 0.0 || along >= sunDistance) continue;

                float perp = length(toOcc - sunDirection * along);
                float physicalSunRadius = uSunRadius * (along / sunDistance);

                // Legacy pre-SPL-unification eclipse edge used by the old
                // atmosphere/cloud shader: a simple two-sided smoothstep
                // around the occluder silhouette with w = radius * softness.
                // With the historical default uEclipseSoftness = 0.015 this is
                // a 1.5% radius feather on each side of the geometric edge.
                // Apply that legacy softness to both atmosphere scattering and
                // clouds in this shader. Other receivers elsewhere keep the
                // unified hard-core + finite-disc behavior.
                float legacyFeather = max(occR * uEclipseSoftness, 1e-4);
                float legacyOccVisibility = smoothstep(
                  occR - legacyFeather,
                  occR + legacyFeather,
                  perp
                );
                cloudVisibility = min(cloudVisibility, legacyOccVisibility);
                atmoVisibility = min(atmoVisibility, legacyOccVisibility);
              }

              float eclipseStrength = clamp(uEclipseStrength, 0.0, 1.0);
              return vec2(
                mix(1.0, cloudVisibility, eclipseStrength),
                mix(1.0, atmoVisibility, eclipseStrength)
              );
            }

            vec2 raySphere(vec3 ro, vec3 rd, vec3 c, float r){
              vec3 oc = ro - c;
              float b = dot(oc, rd);
              float c0 = dot(oc, oc) - r*r;
              float h = b*b - c0;
              if(h < 0.0) return vec2(1e9, -1e9);
              h = sqrt(h);
              return vec2(-b - h, -b + h);
            }

            float sceneDistanceFromLogDepth(vec2 uv, vec3 rdV){
              float d = texture2D(uDepthTex, uv).r;
              if(d >= 0.999999) return 1e9;

              float log2_v = (d * 2.0) / max(uLogDepthFC, 1e-8);
              float vFragDepth = exp2(log2_v);
              float viewZ = -(vFragDepth - 1.0);
              float t = viewZ / rdV.z;
              if(!(t > 0.0)) return 1e9;
              return t;
            }

            float blueJitter(){
              vec2 pix = gl_FragCoord.xy;
              vec2 tile = max(uBlueNoiseSize, vec2(1.0));
              vec2 uvn = fract(pix / tile);
              float n = texture2D(uBlueNoiseTex, uvn).r;
              return n - 0.5;
            }

            float phaseHG(float mu, float g){
              float gg = g*g;
              return (1.0 - gg) / pow(max(1e-4, 1.0 + gg - 2.0*g*mu), 1.5);
            }

            // A small backward lobe keeps cloud edges readable when the sun is
            // behind the camera, while the stronger forward lobe preserves
            // silver linings and bright back-lighting.
            float dualPhaseHG(float mu, float g){
              float forwardG = clamp(g, 0.0, 0.92);
              float backwardG = -min(0.28, max(0.10, forwardG * 0.55));
              return mix(
                phaseHG(mu, backwardG),
                phaseHG(mu, forwardG),
                0.70
              );
            }

            // Cheap multiple-scattering approximation. It reuses the one light
            // optical-depth march; no additional volume samples are required.
            vec3 multipleScatterApprox(float opticalDepth, float mu, float g){
              float attenuation = 1.0;
              float contribution = 1.0;
              float phaseScale = 1.0;
              vec3 luminance = vec3(0.0);

              for(int octave=0; octave<3; octave++){
                float p = dualPhaseHG(mu, g * phaseScale);
                vec3 beers = exp(
                  -opticalDepth * max(0.01, uCloudShadowStrength) *
                  attenuation * vec3(0.78, 0.88, 1.0)
                );
                luminance += contribution * p * beers;
                attenuation *= 0.35;
                contribution *= 0.38;
                phaseScale *= 0.55;
              }
              return luminance;
            }

            float cloudSafeWorldDistance(
              vec4 macroNoise,
              float radius
            ){
              // The baked support map is conservative only while the global
              // coverage is at or above the minimum encoded by the generator.
              if(uCloudCoverage < uCloudDistanceMinCoverage) return 0.0;

              float safeCells = macroNoise.a * uCloudDistanceMaxCells;
              if(safeCells <= 0.0) return 0.0;

              float safeNoiseDistance = safeCells / max(uCloudNoiseSize, 1.0);

              // Upper bound on how quickly the broad cloud lookup coordinate can
              // move along any world-space ray. Direction changes at <= 1/r and
              // the vertical warp changes at <= 0.35/cloudThickness. Dividing a
              // conservative texture-space distance by this upper bound produces
              // a conservative world-space skip distance.
              float angularRate = abs(uCloudFreq) / max(
                radius,
                max(1.0, uPlanetRadius * 0.5)
              );
              float verticalRate = 0.35 / max(uCloudThickness, 1e-4);
              float coordinateRate = 0.11 * (angularRate + verticalRate);
              return safeNoiseDistance / max(coordinateRate, 1e-6);
            }

            vec2 cloudFieldLodData(vec3 pW, float requestedDetail){
              vec3 lp = pW - uPlanetCenterW;
              float r = length(lp);
              vec3 dir = lp / max(r, 1e-6);

              float t = uTime * uCloudWindSpeed;

              float cs = cos(t), sn = sin(t);
              vec3 d2 = vec3(dir.x*cs - dir.z*sn, dir.y, dir.x*sn + dir.z*cs);

              float cloudBaseR = uPlanetRadius + uCloudBase;
              float h01 = saturate((r - cloudBaseR) / max(uCloudThickness, 1e-4));

              vec3 flow1 = vec3(0.37, 0.00, 0.29) * t;
              vec3 flow2 = vec3(-0.21, 0.00, 0.41) * (t * 1.35);

              vec3 heightWarp = vec3(0.0, (h01 - 0.5) * 0.35, 0.0);

              vec3 qBase = d2 * uCloudFreq + flow1 + heightWarp +
                uCloudNoiseOffset;
              vec3 qDetail = d2 * uCloudDetailFreq + flow2 + heightWarp * 1.7 +
                uCloudNoiseOffset * 1.37;

              // R already contains the same broad + secondary mix used by batch
              // one. A now contains the conservative distance to possible cloud
              // support, so the broad silhouette remains effectively unchanged.
              vec4 macroNoise = sampleCloudNoise(qBase * 0.11);
              float macroShape = macroNoise.r;
              float weather = smoothstep(0.15, 0.85, macroNoise.b);
              float localCoverage = uCloudCoverage + (0.5 - weather) * 0.16;
              float base = smoothstep(
                localCoverage,
                localCoverage + max(uCloudSoftness, 1e-4),
                macroShape
              );
              base = pow(saturate(base), 1.12);

              float safeWorldDistance = 0.0;
              if(base <= 0.0005){
                safeWorldDistance = cloudSafeWorldDistance(macroNoise, r);
              }

              // Fine Worley erosion is skipped entirely for empty samples and
              // distant/low-quality clouds. The light march calls this function
              // with requestedDetail=0, halving its volume-texture cost.
              float detailLod = saturate(requestedDetail);
              if(base > 0.0005 && detailLod > 0.001){
                vec4 detailNoise = sampleCloudNoise(
                  qDetail * 0.07 + vec3(0.173, 0.091, 0.337)
                );
                float erosionNoise = mix(detailNoise.g, detailNoise.r, 0.18);
                float erosion = (1.0 - erosionNoise) * 0.22 * detailLod;
                erosion *= (1.0 - 0.42 * base);
                base = saturate(
                  (base - erosion) / max(1e-3, 1.0 - erosion)
                );

                float billow = mix(0.82, 1.18, detailNoise.r);
                base *= mix(1.0, billow, 0.38 * detailLod);
              }

              // Flatter cloud base and a long rounded upper falloff, matching
              // the reference demo's cumulus silhouette more closely.
              float profile =
                smoothstep(0.0, 0.08, h01) *
                (1.0 - smoothstep(0.58, 1.0, h01));

              return vec2(saturate(base * profile), safeWorldDistance);
            }

            void marchCloudSegment(
              in vec3 roW, in vec3 rdW,
              in float s0, in float s1,
              in float sceneT,
              in float jitter,
              in vec3 sunDir,
              in float phase,
              in float visGlobal,
              inout vec3 cloudCol,
              inout float cloudAlpha
            ){
              if(s0 > sceneT) return;
              s1 = min(s1, sceneT);
              if(s1 <= s0) return;

              float stepsC = max(4.0, uCloudSteps);
              float dtC = (s1 - s0) / stepsC;
              float normalizedDtC = dtC / max(uCloudThickness, 1e-4);
              // The reference uses many more steps. Keep enough spatial dither
              // to hide bands without turning our lower-step pass into grain.
              float j = jitter * 0.70;
              float mu = dot(rdW, sunDir);
              float phaseG = clamp(uCloudPhase, 0.0, 0.92);
              float skipStrength = saturate(uCloudSkipStrength);
              float t = s0 + (0.5 + j) * dtC;

              // The fixed upper bound is intentionally above every quality
              // preset. Empty-space jumps only reduce the executed iterations;
              // occupied regions retain the original nominal sampling interval.
              for(int i=0; i<64; i++){
                if(t >= s1) break;

                vec3 p = roW + rdW * t;
                vec2 cloudSample = cloudFieldLodData(p, uCloudDetailLod);
                float dens = cloudSample.x * uCloudDensity;
                if(dens <= 0.0005){
                  float safeAdvance = cloudSample.y * 0.80 * skipStrength;
                  // Advance only by whole nominal steps. The remaining samples
                  // stay on the exact fixed-march grid, so enabling skipping
                  // cannot introduce a different integration phase or shimmer.
                  float wholeSteps = max(1.0, floor(safeAdvance / dtC));
                  t += wholeSteps * dtC;
                  continue;
                }

                vec3 upP = normalize(p - uPlanetCenterW);
                // True sun-facing term (-1..1). Use this to gate eclipse effects to the day hemisphere.
                float ndlP = dot(upP, sunDir);
                float dayP = saturate(ndlP * 0.5 + 0.5);
                float nightMask = mix(uMinLight, 1.0, pow(dayP, uNightDarken));

                // Only let eclipses affect the sun-facing hemisphere.
                // Otherwise they incorrectly darken the "night" minimum light.
                float daySideP = smoothstep(0.0, 0.25, ndlP);
                nightMask *= mix(1.0, visGlobal, daySideP);

                float sSteps = max(2.0, uCloudLightSteps);
                float lightDistance = uCloudThickness * 1.2;
                float sdt = lightDistance / sSteps;

                float stau = 0.0;
                for(float k=0.0; k<64.0; k+=1.0){
                  if(k >= sSteps) break;
                  float st = (k + 1.0 + j) * sdt;
                  vec3 sp = p + sunDir * st;
                  // Keep the short 2-6 sample light march fixed. The distance
                  // field rarely produced a useful jump this close to occupied
                  // cloud, so branching here cost more than it saved in tests.
                  float sd = cloudFieldLodData(sp, 0.0).x * uCloudDensity;
                  float normalizedSdt = sdt / max(uCloudThickness, 1e-4);
                  stau += sd * normalizedSdt * uCloudLightExtinctionScale;
                  if(stau > 6.0) break;
                }
                float shadow = exp(-stau * uCloudShadowStrength);

                float sampleOpticalDepth =
                  dens * normalizedDtC * uCloudExtinctionScale;
                float aStep = 1.0 - exp(-sampleOpticalDepth);
                float contrib = (1.0 - cloudAlpha) * aStep;

                vec3 lit = vec3(max(0.0, uCloudAmbientStrength));
                lit += vec3(shadow * (0.34 + 0.66 * phase));
                lit += multipleScatterApprox(stau, mu, phaseG) *
                  max(0.0, uCloudMultiScatterStrength);

                // The powder term brightens optically thick billow edges without
                // another march. A tiny cool bounce prevents dense interiors from
                // collapsing to featureless black.
                float powder = 1.0 - exp(
                  -(sampleOpticalDepth + stau * 0.35) * 1.6
                );
                float sunFacing = saturate(mu * 0.5 + 0.5);
                lit *= 1.0 + powder * max(0.0, uCloudPowderStrength) *
                  (0.35 + 0.65 * sunFacing);
                lit += vec3(0.035, 0.050, 0.075) * powder * (1.0 - shadow);

                lit *= mix(
                  vec3(0.92, 0.96, 1.0),
                  vec3(1.0, 0.92, 0.80),
                  sunFacing
                );
                lit = min(lit, vec3(6.0));
                lit *= nightMask;

                cloudCol += contrib * lit;
                cloudAlpha += contrib;
                t += dtC;

                if(cloudAlpha > 0.98) break;
              }
            }

            vec3 cheapClouds(
              vec3 roW, vec3 rdW,
              vec2 tOuter, vec2 tInner,
              float sceneT,
              float jitter,
              vec3 sunDir,
              float visGlobal,
              out float outA
            ){
              outA = 0.0;

              float outerEnter = max(tOuter.x, 0.0);
              float outerExit  = max(tOuter.y, 0.0);
              if(outerEnter > outerExit) return vec3(0.0);

              float t0 = outerEnter;
              float t1 = min(outerExit, sceneT);
              if(t1 <= t0) return vec3(0.0);

              float tPick = mix(t0, t1, 0.35 + 0.15 * jitter);
              vec3 pW = roW + rdW * tPick;

              vec3 lp = normalize(pW - uPlanetCenterW);

              float t = uTime * uCloudWindSpeed;

              float cs = cos(t), sn = sin(t);
              vec3 d2 = vec3(lp.x*cs - lp.z*sn, lp.y, lp.x*sn + lp.z*cs);

              vec3 flow1 = vec3(0.37, 0.00, 0.29) * t;
              vec3 flow2 = vec3(-0.21, 0.00, 0.41) * (t * 1.35);

              vec3 q1 = d2 * (uCloudFreq * uCheapCloudScale) + flow1 +
                uCloudNoiseOffset;
              vec3 q2 = d2 * (uCloudDetailFreq * 0.35 * uCheapCloudScale) +
                flow2 + uCloudNoiseOffset * 1.37 + vec3(17.3,9.1,33.7);

              vec4 macroNoise = sampleCloudNoise(q1 * 0.12);
              float n = macroNoise.r;
              float weather = smoothstep(0.15, 0.85, macroNoise.b);

              float edge = 0.25 / max(uCheapCloudSharp, 1e-3);
              float cov = uCloudCoverage - 0.08 * uCheapCloudFarBoost;
              cov += (0.5 - weather) * 0.14;

              float m = smoothstep(cov, cov + edge, n);

              // Far planets normally execute only the macro sample. A small
              // amount of erosion fades in only when the projected cloud layer
              // is large enough to resolve it.
              float detailLod = min(saturate(uCloudDetailLod), 0.45);
              if(m > 0.0005 && detailLod > 0.001){
                vec4 detailNoise = sampleCloudNoise(q2 * 0.08);
                float erosion = (1.0 - detailNoise.g) * 0.24 * detailLod;
                m = saturate((m - erosion) / max(1e-3, 1.0 - erosion));
              }

              m = pow(saturate(m), 1.0 / max(uCheapCloudContrast, 1e-3));

              float h = abs(d2.y);
              float prof = smoothstep(0.10, 0.75, 1.0 - h);

              float a = m * prof * uCheapCloudAlpha * (1.0 + uCheapCloudFarBoost);
              // Make distant clouds read as fluffy masses (less transparent).
              a *= 1.35;
              a = min(a, 0.85);

              float ndlSigned = dot(lp, sunDir);
              float ndl = saturate(ndlSigned * 0.5 + 0.5);
              float nightMask = mix(uMinLight, 1.0, pow(ndl, uNightDarken));
              float daySide = smoothstep(0.0, 0.25, ndlSigned);
              // Match the volumetric path: eclipses only dim the sun-facing
              // hemisphere, not the minimum night-side fill light.
              nightMask *= mix(1.0, visGlobal, daySide);

              float mu = dot(rdW, sunDir);
              float phase = dualPhaseHG(mu, clamp(uCloudPhase, 0.0, 0.92));

              float rim = pow(1.0 - saturate(dot(-rdW, lp)), 2.5) * uCheapCloudRim * (1.0 + 0.65 * uCheapCloudFarBoost);

              float powder = 1.0 - exp(-m * 2.0);
              vec3 col = vec3(1.0) * (0.35 + 0.65 * ndl) *
                (0.55 + 0.45 * phase);
              col *= 1.0 + powder * max(0.0, uCloudPowderStrength) * 0.55;
              col += rim * vec3(1.0);

              col *= nightMask;

              outA = clamp(a, 0.0, 0.85);
              // Keep both cloud paths in premultiplied form so the shared
              // output/composite code can recover straight color consistently.
              return col * outA;
            }

            void main(){
              vec2 uv = clamp(vUv, 0.0, 1.0);
              vec2 ndc = uv * 2.0 - 1.0;

              vec4 farV4 = uInvProjMatrix * vec4(ndc, 1.0, 1.0);
              vec3 farV = farV4.xyz / farV4.w;
              vec3 rdV = normalize(farV);

              vec3 roW = (uInvViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
              vec3 farW = (uInvViewMatrix * vec4(farV, 1.0)).xyz;
              vec3 rdW = normalize(farW - roW);

              float sceneT = sceneDistanceFromLogDepth(uv, rdV);

              vec3 sunDir = normalize(uSunPosW - uPlanetCenterW);
              float jitter = blueJitter();

              // Eclipse visibility is expensive; approximate as constant along
              // the view ray for this pixel. Clouds keep the renderer's normal
              // hard-core eclipse; atmosphere scattering uses the soft pair.
              float visGlobal = 1.0;
              float visAtmoGlobal = 1.0;
              float atmoR = uPlanetRadius + uAtmoHeight;
              vec2 tAtmo = raySphere(roW, rdW, uPlanetCenterW, atmoR);
              if(tAtmo.x > tAtmo.y) discard;

              vec2 tGround = raySphere(roW, rdW, uPlanetCenterW, uGroundRadius);

              float t0 = max(tAtmo.x, 0.0);
              float t1 = tAtmo.y;

              // The water material deliberately stops writing depth while the
              // camera is submerged. Begin the local atmosphere at the outward
              // sea-surface intersection, so the water column is not integrated
              // as dense air and the atmosphere/clouds beyond the surface remain
              // visible through the water. Downward rays still terminate on the
              // opaque seabed before reaching this start distance and are rejected
              // by the ordinary scene-depth test below.
              float cameraBodyRadius = length(roW - uPlanetCenterW);
              float cameraUnderwater =
                step(0.0, uOceanRadius) *
                (1.0 - step(uOceanRadius, cameraBodyRadius));
              if(cameraUnderwater > 0.5){
                vec2 tOcean = raySphere(
                  roW,
                  rdW,
                  uPlanetCenterW,
                  uOceanRadius
                );
                if(tOcean.x <= tOcean.y && tOcean.y > 0.0){
                  float surfaceEpsilon = max(0.02, uAtmoHeight * 1e-6);
                  t0 = max(t0, tOcean.y + surfaceEpsilon);
                }
              }

              if(tGround.x <= tGround.y && tGround.x > 0.0){
                t1 = min(t1, tGround.x);
              }

              if(t0 > sceneT) discard;
              t1 = min(t1, sceneT);
              if(t1 <= t0) discard;

              // Sample visibility once at ~35% along the segment (good enough; huge perf win).
              float tVis = mix(t0, t1, 0.35);
              vec3 visibilityPointW = roW + rdW * tVis;
              vec2 eclipseVisibility = eclipseVisibilityPair(
                visibilityPointW,
                uSunPosW
              );
              visGlobal = eclipseVisibility.x;
              visAtmoGlobal = eclipseVisibility.y;

              vec3 visibilityUp = normalize(visibilityPointW - uPlanetCenterW);
              float visibilityNdl = dot(visibilityUp, sunDir);
              float brightSide = smoothstep(0.08, 0.72, visibilityNdl);
              // During an eclipse the atmospheric veil should dim with the sun
              // rather than remaining an opaque daylight-blue sheet. A small
              // residual keeps real air from becoming perfectly transparent.
              brightSide *= mix(0.18, 1.0, visAtmoGlobal);

              // Identify whether the opaque scene depth belongs to this planet.
              // Background stars, moons and planets lie outside the local
              // atmosphere and receive the stronger daylight extinction below.
              float localScene = 0.0;
              if(sceneT < 5e8){
                vec3 scenePointW = roW + rdW * sceneT;
                float sceneRadius = length(scenePointW - uPlanetCenterW);
                float localMargin = max(2.0, uAtmoHeight * 0.025);
                localScene = 1.0 - step(atmoR + localMargin, sceneRadius);
              }
              vec3 atmoCol = vec3(0.0);
              float atmoAlpha = 0.0;

              if(uRenderMode < 1.5){
                float stepsA = max(8.0, uAtmoSteps);
                float dtA = (t1 - t0) / stepsA;
                float scaleH = max(1e-3, uAtmoHeight * uAtmoScaleHeight);
                float optical = 0.0;

              for(float i = 0.0; i < 256.0; i += 1.0){
                if(i >= stepsA) break;

                float t = t0 + (i + 0.5 + jitter) * dtA;
                vec3 p = roW + rdW * t;

                float r = length(p - uPlanetCenterW);
                float h = max(0.0, r - uPlanetRadius);

                vec3 up = (p - uPlanetCenterW) / max(r, 1e-6);
                // True sun-facing term (-1..1). Use this to gate eclipse effects to the day hemisphere.
                float ndl = dot(up, sunDir);
                float day = saturate(ndl * 0.5 + 0.5);
                float lightMask = mix(uMinLight, 1.0, pow(day, uNightDarken));

                // Only let eclipses affect the sun-facing hemisphere.
                // This prevents eclipses from dimming the "night" minimum light.
                // IMPORTANT: gate by N·L so the eclipse never affects the night hemisphere.
                float daySide = smoothstep(0.0, 0.25, ndl);

                float vis = visAtmoGlobal;
                float visDay = mix(1.0, vis, daySide);
                float localLight = lightMask * visDay;

                float dayBoost = mix(1.0, uDayOpacityBoost, smoothstep(0.15, 0.95, day));

                float dens = exp(-h / scaleH) * uAtmoDensity * dayBoost;

                float eclipseDim = mix(1.0, 0.45, 1.0 - vis);
                dens *= mix(1.0, eclipseDim, daySide);

                float term = abs(day - 0.5) * 2.0;
                float sunsetBand = 1.0 - smoothstep(0.10, 0.62, term);
                sunsetBand *= sunsetBand;

                vec3 blueCol = vec3(0.18, 0.55, 1.25) * uBlueStrength;
                vec3 redCol  = vec3(1.00, 0.30, 0.10) * uSunsetStrength;
                vec3 scatCol = mix(blueCol, redCol, sunsetBand);

                optical += dens * dtA * 0.6;
                float trans = exp(-optical * 0.06);

                float mu = dot(rdW, sunDir);
                float glare = pow(saturate(mu), 32.0) * uSunGlare;
                vec3 glareCol = vec3(0.55, 0.72, 0.98);

                atmoCol += scatCol * dens * dtA * trans * localLight;
                atmoCol += glare   * dens * dtA * glareCol * localLight;

                float aStep = 1.0 - exp(-dens * dtA * 0.06);

                // Day-side opacity boost: reuse uDayOpacityBoost ...
                float dayA = smoothstep(0.12, 0.95, day);
                float alphaBoost = mix(0.70, 1.05, dayA);
                alphaBoost *= mix(1.0, uDayOpacityBoost, dayA);
                atmoAlpha += (1.0 - atmoAlpha) * aStep * alphaBoost;

                if(atmoAlpha > 0.70) break;
              }

              float pathLen = (t1 - t0) / max(uAtmoHeight, 1e-6);
              float edgeSoft = smoothstep(0.0, 1.0, saturate(pathLen * 0.65));
              atmoAlpha *= edgeSoft;
              atmoCol *= edgeSoft;
              atmoCol *= mix(vec3(1.0), uAtmoTint, 0.85);

              // Increase extinction only where the raymarch found meaningful
              // atmospheric density. The previous implementation derived a
              // near-opaque veil from geometric path length alone; long rays
              // through the very thin outer shell then became an almost black
              // disc against space.
              float naturalAlpha = clamp(atmoAlpha, 0.0, 0.72);
              float backgroundPath = smoothstep(0.08, 0.70, pathLen);
              float daylightOpacity = clamp(
                mix(
                  uDayBackgroundOpacity,
                  uDaySurfaceOpacity,
                  localScene
                ),
                0.0,
                0.985
              );

              // Smoothly approach the requested daylight opacity as real
              // optical depth builds. Zero-density edge pixels remain exactly
              // transparent, so the outer atmosphere cannot form a hard mask.
              float densitySupport = smoothstep(0.025, 0.20, naturalAlpha);
              float densityDrivenOpacity = mix(
                naturalAlpha,
                daylightOpacity,
                densitySupport
              );
              float daylightWeight = brightSide * backgroundPath;
              atmoAlpha = mix(
                naturalAlpha,
                max(naturalAlpha, densityDrivenOpacity),
                daylightWeight
              );

              float alphaCap = mix(0.72, daylightOpacity, brightSide);
              float finalAlpha = clamp(atmoAlpha, 0.0, alphaCap);

              // Extra extinction also needs a daylight scattering source. Blend
              // the added opacity in premultiplied terms so a dense atmosphere
              // becomes its tint instead of an opaque black silhouette.
              float addedDayAlpha = max(0.0, finalAlpha - naturalAlpha);
              if(addedDayAlpha > 1e-5){
                vec3 daylightVeilColor = mix(
                  vec3(0.08, 0.25, 0.65),
                  uAtmoTint,
                  0.78
                );
                daylightVeilColor *= mix(0.55, 0.90, brightSide);
                atmoCol = (
                  atmoCol * naturalAlpha +
                  daylightVeilColor * addedDayAlpha
                ) / max(finalAlpha, 1e-5);
              }
              atmoAlpha = finalAlpha;

              // The scene sun is rendered before this atmosphere layer. Dense
              // daylight extinction correctly hides most background bodies, but
              // it also mutes the star itself. Reconstruct only the solar disc
              // and its local halo while the camera is inside this atmosphere.
              // Foreground depth, the host planet and eclipse occluders still
              // block it, so this does not make unrelated bodies shine through.
              float cameraRadius = length(roW - uPlanetCenterW);
              float insideAtmosphere = 1.0 - smoothstep(
                atmoR - uAtmoHeight * 0.04,
                atmoR + uAtmoHeight * 0.04,
                cameraRadius
              );

              // The inside/outside value is constant across this body pass,
              // so this branch cheaply removes all solar-disc work in space.
              if(insideAtmosphere > 1e-5){
                vec3 cameraToSun = uSunPosW - roW;
                float cameraSunDistance = max(length(cameraToSun), 1e-4);
                vec3 cameraSunDirection = cameraToSun / cameraSunDistance;
                float sunMu = clamp(dot(rdW, cameraSunDirection), -1.0, 1.0);

                // Small-angle angular separation. This avoids acos() over the
                // entire fullscreen pass while remaining accurate at stellar
                // angular sizes.
                float angularDistance = sqrt(max(0.0, 2.0 * (1.0 - sunMu)));
                float angularRadius = clamp(
                  uSunRadius / cameraSunDistance,
                  0.00035,
                  0.25
                );
                float angularRatio = angularDistance / angularRadius;
                float solarDisc = 1.0 - smoothstep(0.88, 1.12, angularRatio);
                float solarHalo = 1.0 - smoothstep(1.0, 10.0, angularRatio);
                solarHalo *= solarHalo;

                // sceneT contains the opaque sun sphere itself. Allow that depth,
                // but reject any substantially nearer terrain, moon or planet.
                float sunAlongRay = dot(cameraToSun, rdW);
                float sunDepthVisible = step(
                  sunAlongRay - uSunRadius * 1.45,
                  sceneT
                );
                float skyRay = 1.0 - localScene;
                float solarVisibility = insideAtmosphere * skyRay *
                  sunDepthVisible * clamp(visAtmoGlobal, 0.0, 1.0);

                if(solarVisibility > 1e-5 && (solarDisc > 1e-5 || solarHalo > 1e-5)){
                  float discVisibility = solarVisibility * solarVisibility;
                  float haloVisibility = solarVisibility;
                  float solarLayerAlpha = clamp(
                    solarDisc * 0.975 * discVisibility +
                    solarHalo * 0.24 * haloVisibility,
                    0.0,
                    0.985
                  );
                  vec3 solarLayerColor = vec3(1.0, 0.86, 0.64) * (
                    solarDisc * uSurfaceSunDiscIntensity * discVisibility +
                    solarHalo * uSurfaceSunHaloIntensity * haloVisibility
                  );

                  // Straight-alpha "over" composition inside the atmosphere
                  // layer. The outer render-target blend then applies this alpha
                  // exactly once, and clouds below can still cover the result.
                  float combinedAlpha = solarLayerAlpha +
                    atmoAlpha * (1.0 - solarLayerAlpha);
                  vec3 combinedPremultiplied =
                    solarLayerColor * solarLayerAlpha +
                    atmoCol * atmoAlpha * (1.0 - solarLayerAlpha);
                  atmoCol = combinedPremultiplied / max(combinedAlpha, 1e-5);
                  atmoAlpha = combinedAlpha;
                }
              }
              }

              float cloudBaseR = uPlanetRadius + uCloudBase;
              float cloudTopR  = cloudBaseR + uCloudThickness;

              vec2 tOuter = raySphere(roW, rdW, uPlanetCenterW, cloudTopR);
              vec2 tInner = raySphere(roW, rdW, uPlanetCenterW, cloudBaseR);

              vec3 cloudCol = vec3(0.0);
              float cloudAlpha = 0.0;

              bool hitOuter = (tOuter.x <= tOuter.y);

              if(hitOuter && (uRenderMode < 0.5 || uRenderMode > 1.5)){
                if(uUseCheapClouds > 0.5){
                  cloudCol = cheapClouds(roW, rdW, tOuter, tInner, sceneT, jitter, sunDir, visGlobal, cloudAlpha);
                } else {
                  float groundT = 1e9;
                  if(tGround.x <= tGround.y && tGround.x > 0.0) groundT = tGround.x;

                  float mu = dot(rdW, sunDir);
                  float phase = dualPhaseHG(mu, clamp(uCloudPhase, 0.0, 0.92));

                  bool hitInner = (tInner.x <= tInner.y);
                  float outerEnter = max(tOuter.x, 0.0);
                  float outerExit  = max(tOuter.y, 0.0);

                  if(hitInner){
                    float innerEnter = max(tInner.x, 0.0);
                    float innerExit  = max(tInner.y, 0.0);

                    float a0 = outerEnter;
                    float a1 = min(innerEnter, outerExit);
                    a1 = min(a1, groundT);
                    marchCloudSegment(roW, rdW, a0, a1, sceneT, jitter, sunDir, phase, visGlobal, cloudCol, cloudAlpha);

                    float b0 = innerExit;
                    float b1 = outerExit;
                    b1 = min(b1, groundT);
                    marchCloudSegment(roW, rdW, b0, b1, sceneT, jitter, sunDir, phase, visGlobal, cloudCol, cloudAlpha);

                  } else {
                    float s0 = outerEnter;
                    float s1 = min(outerExit, groundT);
                    marchCloudSegment(roW, rdW, s0, s1, sceneT, jitter, sunDir, phase, visGlobal, cloudCol, cloudAlpha);
                  }
                }
              }

              // Allow thicker, fluffier clouds (previous cap made them look wispy/ghost-like).
              cloudAlpha = clamp(cloudAlpha, 0.0, 0.92);
              cloudCol *= mix(vec3(1.0), uCloudTint, 0.65);

              vec3 cloudStraight = cloudAlpha > 0.0001
                ? cloudCol / cloudAlpha
                : vec3(0.0);

              if(uRenderMode > 1.5){
                if(cloudAlpha < 0.001) discard;
                gl_FragColor = vec4(cloudStraight, cloudAlpha);
                return;
              }

              if(uRenderMode > 0.5){
                gl_FragColor = vec4(atmoCol, atmoAlpha);
                return;
              }

              vec3 col = mix(atmoCol, cloudStraight, cloudAlpha);
              float a = max(atmoAlpha, cloudAlpha);
              gl_FragColor = vec4(col, a);
            }`;

// Compile-time variants let the driver eliminate the unused half of the large
// atmosphere/cloud shader instead of retaining both paths behind a uniform.
function makeStaticAtmoModeFS(mode) {
  return ATMO_FS.replace(
    "uniform float uRenderMode;",
    `const float uRenderMode = ${Number(mode).toFixed(1)};`,
  );
}

export function makeAtmosphereOnlyFS() {
  return makeStaticAtmoModeFS(1);
}

export function makeCloudColorFS() {
  return makeStaticAtmoModeFS(2);
}

// Screen-space "dust" for the asteroid belt.
// Uses the same reconstruction + depth-limited raymarch style as ATMO_FS, but the density function
// is a soft ring volume in the belt's local space.
export const BELT_DUST_FS = `
precision highp float;
varying vec2 vUv;

uniform mat4 uInvViewMatrix;
uniform mat4 uInvProjMatrix;
uniform sampler2D uDepthTex;
uniform float uLogDepthFC;

uniform sampler2D uBlueNoiseTex;
uniform vec2 uBlueNoiseSize;

// World->belt local
uniform mat4 uBeltInvMatrix;
uniform float uInnerR;
uniform float uOuterR;
uniform float uHalfHeight;

uniform vec3  uDustTint;
uniform float uDustDensity;
uniform float uDustSteps;
uniform float uMaxDist;
uniform float uNoiseScale;
uniform float uTime;

float saturate(float x){ return clamp(x, 0.0, 1.0); }

float sceneDistanceFromLogDepth(vec2 uv, vec3 rdV){
  float d = texture2D(uDepthTex, uv).r;
  if(d >= 0.999999) return 1e9;
  float log2_v = (d * 2.0) / max(uLogDepthFC, 1e-8);
  float vFragDepth = exp2(log2_v);
  float viewZ = -(vFragDepth - 1.0);
  float t = viewZ / rdV.z;
  if(!(t > 0.0)) return 1e9;
  return t;
}

float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Density of a soft belt volume in belt-local coordinates.
float beltDensity(vec3 pL, float n){
  float r = length(pL.xz);
  // Soft edges: fades in from innerR, fades out to outerR.
  float edge = max(1.0, (uOuterR - uInnerR) * 0.08);
  float a0 = smoothstep(uInnerR, uInnerR + edge, r);
  float a1 = 1.0 - smoothstep(uOuterR - edge, uOuterR, r);
  float radial = a0 * a1;

  // Vertical falloff (soft)
  float vy = abs(pL.y);
  float vertical = exp(-vy / max(1.0, uHalfHeight) * 2.2);

  // Wispy breakup
  float wisps = smoothstep(0.18, 0.92, n);

  return radial * vertical * (0.35 + 0.90 * wisps);
}

void main(){
  // Reconstruct view ray
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 clip = vec4(ndc, 1.0, 1.0);
  vec4 vpos = uInvProjMatrix * clip;
  vpos.xyz /= max(1e-6, vpos.w);
  vec3 rdV = normalize(vpos.xyz);
  vec3 roW = (uInvViewMatrix * vec4(0.0,0.0,0.0,1.0)).xyz;
  vec3 rdW = normalize((uInvViewMatrix * vec4(rdV, 0.0)).xyz);

  float sceneT = sceneDistanceFromLogDepth(vUv, rdV);
  float tMax = min(sceneT, uMaxDist);
  if(tMax <= 0.0) discard;

  // Blue-noise jitter to reduce banding (match the atmosphere shader).
  // IMPORTANT: Use gl_FragCoord so the noise is *per-pixel*.
  vec2 pix = gl_FragCoord.xy;
  vec2 tile = max(uBlueNoiseSize, vec2(1.0));
  vec2 bnUv = fract(pix / tile);
  float bn = texture2D(uBlueNoiseTex, bnUv).r;
  float jitter = bn - 0.5;

  float steps = max(6.0, uDustSteps);
  float dt = tMax / steps;
  float t0 = max(0.0, dt * jitter);

  vec3 acc = vec3(0.0);
  float aAcc = 0.0;

  for(float i=0.0; i<64.0; i++){
    if(i >= steps) break;
    float t = t0 + (i + 0.5) * dt;
    if(t > tMax) break;

    vec3 pW = roW + rdW * t;
    vec3 pL = (uBeltInvMatrix * vec4(pW, 1.0)).xyz;

    // 2D noise (world locked) for breakup
    vec2 nUv = fract(pL.xz * uNoiseScale + vec2(uTime*0.01, -uTime*0.008));
    float n = texture2D(uBlueNoiseTex, nUv).r;
    n = mix(n, hash12(nUv * 2048.0), 0.35);

    float d = beltDensity(pL, n);
    if(d <= 0.0001) continue;

    // Convert density to alpha with exponential attenuation.
    // Stronger default scaling so the dust reads without requiring huge uniform values.
    float aStep = 1.0 - exp(-d * uDustDensity * dt * 0.00035);
    aStep = clamp(aStep, 0.0, 0.65);

    vec3 c = uDustTint * (0.75 + 0.35 * n);
    acc += (1.0 - aAcc) * c * aStep;
    aAcc += (1.0 - aAcc) * aStep;
    if(aAcc > 0.98) break;
  }

  if(aAcc < 0.0008) discard;
  gl_FragColor = vec4(acc, clamp(aAcc, 0.0, 0.95));
}
`;

// ---------------------------------------------------------------------------
// Planet ring dust (post-process)
// ---------------------------------------------------------------------------
// Depth-aware screen-space volumetric dust for planet rings.
// - Bright everywhere (no night-side)
// - Keeps eclipse mask via occluder spheres (like atmosphere/clouds)
// - Provides true volume + soft top/bottom edges (unlike a torus surface)

export const RING_DUST_POST_FS = `
precision highp float;
varying vec2 vUv;

uniform mat4 uInvViewMatrix;
uniform mat4 uInvProjMatrix;
uniform sampler2D uDepthTex;
uniform float uLogDepthFC;

uniform sampler2D uBlueNoiseTex;
uniform vec2 uBlueNoiseSize;

${VOLUME_NOISE_GLSL}

uniform float uTime;
uniform float uMaxDist;

// Rings (world -> ring local transforms)
// Ring-local space is authored so the ring plane is XZ and thickness is Y.
// Volume is: innerR <= length(xz) <= outerR AND abs(y) <= halfHeight.
uniform int   uRingCount;
uniform mat4  uRingInvMatrix[8];
uniform float uRingInner[8];
uniform float uRingOuter[8];
uniform float uRingHalfHeight[8];
uniform float uRingSplitEnabled[8];
uniform float uRingOwnerAtmoEnabled[8];
uniform float uRingOwnerAtmoRadius[8];
uniform vec3  uRingOwnerCenterW[8];
uniform float uRingGlobalAtmoSplit[8];
uniform int   uGlobalAtmoCount;
uniform vec3  uGlobalAtmoCenterW[8];
uniform float uGlobalAtmoRadius[8];
// -1 = rear sections only, 0 = complete ring, +1 = front sections only.
uniform float uLayerMode;
uniform vec3  uRingTint[8];

// Global dust tuning (driven by sliders)
uniform float uOpacity;
uniform float uDensity;
uniform float uSteps;
uniform float uFade;       // 0..1-ish, controls edge softness
uniform float uNoiseScale;
uniform float uWindSpeed;

// Eclipse (occluder spheres)
uniform int   uOccCount;
uniform vec3  uOccCenters[24];
uniform float uOccRadii[24];
uniform float uEclipseSoftness;
uniform float uEclipseStrength;
uniform vec3  uSunPosW;
uniform float uSunRadius;

float saturate(float x){ return clamp(x, 0.0, 1.0); }

float sceneDistanceFromLogDepth(vec2 uv, vec3 rdV){
  float d = texture2D(uDepthTex, uv).r;
  if(d >= 0.999999) return 1e9;
  float log2_v = (d * 2.0) / max(uLogDepthFC, 1e-8);
  float vFragDepth = exp2(log2_v);
  float viewZ = -(vFragDepth - 1.0);
  float t = viewZ / rdV.z;
  if(!(t > 0.0)) return 1e9;
  return t;
}

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


vec2 rayCylinderXZ(vec3 ro, vec3 rd, float r){
  float a = dot(rd.xz, rd.xz);
  float c = dot(ro.xz, ro.xz) - r * r;
  if(a < 1e-6){
    return c <= 0.0 ? vec2(-1e9, 1e9) : vec2(1e9, -1e9);
  }
  float b = 2.0 * dot(ro.xz, rd.xz);
  float h = b * b - 4.0 * a * c;
  if(h < 0.0) return vec2(1e9, -1e9);
  float root = sqrt(h);
  float inv = 0.5 / a;
  return vec2((-b - root) * inv, (-b + root) * inv);
}

float sunVisibility(vec3 pW){
  vec3 toSun = uSunPosW - pW;
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

float blueJitter(){
  vec2 sz = max(uBlueNoiseSize, vec2(1.0));
  vec2 uv = fract(gl_FragCoord.xy / sz);
  return texture2D(uBlueNoiseTex, uv).r;
}

void main(){
  // Reconstruct view ray
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 clip = vec4(ndc, 1.0, 1.0);
  vec4 vpos = uInvProjMatrix * clip;
  vpos.xyz /= max(1e-6, vpos.w);
  vec3 rdV = normalize(vpos.xyz);
  vec3 roW = (uInvViewMatrix * vec4(0.0,0.0,0.0,1.0)).xyz;
  vec3 rdW = normalize((uInvViewMatrix * vec4(rdV, 0.0)).xyz);

  float sceneT = sceneDistanceFromLogDepth(vUv, rdV);
  float tMax = min(sceneT, uMaxDist);
  if(tMax <= 0.0) discard;

  float j = blueJitter() - 0.5;

  vec3 acc = vec3(0.0);
  float aAcc = 0.0;

  float fade = clamp(uFade, 0.005, 0.6);
  float dens = max(0.0, uDensity);

  // Accumulate rings front-to-back along the view ray.
  for(int r=0; r<8; r++){
    if(r >= uRingCount) break;

    // Transform ray to ring local
    mat4 invM = uRingInvMatrix[r];
    vec3 roL = (invM * vec4(roW, 1.0)).xyz;
    vec3 rdL = normalize((invM * vec4(rdW, 0.0)).xyz);

    bool splitRing = uRingSplitEnabled[r] > 0.5;
    float cameraRadiusL = length(roL);
    bool canSplitRing = splitRing && cameraRadiusL > 1e-5;
    // Unowned volumes such as the system asteroid belt remain in the front
    // layer only. At the exact ring centre the split plane is undefined, so the
    // complete ring also falls back to the front layer rather than drawing twice.
    if(uLayerMode < -0.5 && !canSplitRing) continue;
    vec3 splitNormalL = canSplitRing
      ? roL / cameraRadiusL
      : vec3(0.0);

    float innerR = uRingInner[r];
    float outerR = uRingOuter[r];
    float hh = max(1.0, uRingHalfHeight[r]);

    // Y slab intersection (abs(y) <= hh)
    float tEnter = 0.0;
    float tExit  = tMax;
    if(abs(rdL.y) > 1e-4){
      float t0 = (-hh - roL.y) / rdL.y;
      float t1 = ( hh - roL.y) / rdL.y;
      tEnter = min(t0, t1);
      tExit  = max(t0, t1);
    } else {
      if(abs(roL.y) > hh) continue;
    }

    tEnter = max(tEnter, 0.0);
    tExit  = min(tExit,  tMax);
    if(tExit <= tEnter) continue;

    // Restrict the march to the actual annulus volume, not just the vertical
    // slab. The old slab-only march could miss the radial band entirely on long
    // inside/outside views, leaving holes when looking along the ring plane.
    vec2 outerHit = rayCylinderXZ(roL, rdL, outerR);
    float outerEnter = max(tEnter, outerHit.x);
    float outerExit = min(tExit, outerHit.y);
    if(outerExit <= outerEnter) continue;

    float seg0Start = outerEnter;
    float seg0End = outerExit;
    float seg1Start = 1.0;
    float seg1End = 0.0;

    if(innerR > 0.0){
      vec2 innerHit = rayCylinderXZ(roL, rdL, innerR);
      if(innerHit.x <= innerHit.y){
        float cutStart = max(outerEnter, innerHit.x);
        float cutEnd = min(outerExit, innerHit.y);
        if(cutEnd > cutStart){
          seg0End = cutStart;
          seg1Start = cutEnd;
          seg1End = outerExit;
        }
      }
    }

    float baseSteps = clamp(floor(uSteps + 0.5), 6.0, 10.0);
    float baseSpan = max(outerExit - outerEnter, 1e-4);
    vec3 tint = uRingTint[r];

    for(int segIdx = 0; segIdx < 2; segIdx++){
      float segStart = segIdx == 0 ? seg0Start : seg1Start;
      float segEnd = segIdx == 0 ? seg0End : seg1End;
      if(segEnd <= segStart) continue;

      float segSteps = clamp(
        ceil(baseSteps * ((segEnd - segStart) / baseSpan)),
        2.0,
        10.0
      );
      float dt = (segEnd - segStart) / segSteps;
      float t0m = segStart + dt * (0.5 + j);

      for(float i=0.0; i<10.0; i++){
        if(i >= segSteps) break;
        float t = t0m + i * dt;
        if(t < segStart || t > segEnd) continue;
        vec3 pW = roW + rdW * t;
        vec3 pL = roL + rdL * t;

      if(canSplitRing){
        bool frontSection = dot(pL, splitNormalL) >= 0.0;

        // A camera-facing half is not necessarily in front of the atmosphere
        // at this pixel. Classify against the actual near intersection of the
        // owner's atmospheric sphere. This fixes exterior views where a near
        // ring segment was still behind the atmospheric limb but was composited
        // on top of it by the old centre-plane split.
        if(uRingOwnerAtmoEnabled[r] > 0.5){
          vec3 ocA = roW - uRingOwnerCenterW[r];
          float bA = dot(ocA, rdW);
          float cA = dot(ocA, ocA) -
            uRingOwnerAtmoRadius[r] * uRingOwnerAtmoRadius[r];
          float hA = bA*bA - cA;
          if(hA >= 0.0){
            float rootA = sqrt(hA);
            float tNearA = -bA - rootA;
            float tFarA = -bA + rootA;
            if(tNearA > 0.0){
              frontSection = t < tNearA;
            } else if(tFarA > 0.0){
              // Camera is inside this atmosphere. Keep ring dust in the front
              // layer; the enclosing atmosphere is deliberately drawn last.
              frontSection = true;
            }
          }
        } else if(uRingGlobalAtmoSplit[r] > 0.5){
          // A system belt may cross the projection of several planets. Dust is
          // rear-layer only after the ray has completely traversed an exterior
          // atmosphere. Dust before or physically inside the sphere remains in
          // the front layer, matching the planet-ring rule requested by the game.
          frontSection = true;
          for(int aIdx = 0; aIdx < 8; aIdx++){
            if(aIdx >= uGlobalAtmoCount) break;
            float atmoR = uGlobalAtmoRadius[aIdx];
            if(atmoR <= 0.0) continue;
            vec3 ocA = roW - uGlobalAtmoCenterW[aIdx];
            float bA = dot(ocA, rdW);
            float cA = dot(ocA, ocA) - atmoR * atmoR;
            float hA = bA*bA - cA;
            if(hA < 0.0) continue;
            float rootA = sqrt(hA);
            float tNearA = -bA - rootA;
            float tFarA = -bA + rootA;
            // If the camera is inside this atmosphere it is composited last,
            // so do not force system dust behind it here.
            if(tNearA <= 0.0 && tFarA > 0.0) continue;
            if(tNearA > 0.0 && t > tFarA){
              frontSection = false;
              break;
            }
          }
        }

        if(uLayerMode < -0.5 && frontSection) continue;
        if(uLayerMode >  0.5 && !frontSection) continue;
      }

      float rr = length(pL.xz);
      // Radial soft edges
      float w = max(1.0, (outerR - innerR) * (0.05 + 0.5*fade));
      float radial = smoothstep(innerR, innerR + w, rr) * (1.0 - smoothstep(outerR - w, outerR, rr));
      if(radial <= 0.0001) continue;

      // Vertical soft edges (top/bottom)
      float vy = abs(pL.y);
      float vh = max(1.0, hh * (0.30 + 1.10*fade));
      float vertical = 1.0 - smoothstep(hh - vh, hh, vy);
      if(vertical <= 0.0001) continue;

      // Cloud-like breakup (world space)
      float tt = uTime * uWindSpeed;
      vec3 pN = pW * uNoiseScale + vec3(tt*0.37, tt*0.11, tt*0.29);
      float n = sampleVolumeFbm(pN);
      float ridged = 1.0 - abs(n*2.0 - 1.0);
      float wisps = smoothstep(0.10, 0.92, pow(ridged, 1.25));

      float d = radial * vertical * (0.30 + 0.95*wisps);
      // Exponential attenuation; tuned for ring scales.
      float aStep = 1.0 - exp(-d * dens * dt * 0.00055);
      aStep = clamp(aStep, 0.0, 0.65);
      if(aStep <= 0.00001) continue;

      float sampleVis = sunVisibility(pW);
      // Keep a little scattered fill in totality, but let the owning planet's
      // shadow follow the exact dust position instead of one slab midpoint.
      float eclipseDim = mix(0.35, 1.0, sampleVis);
      vec3 c = tint * (0.85 + 0.35*wisps) * eclipseDim;
      acc += (1.0 - aAcc) * c * aStep;
      aAcc += (1.0 - aAcc) * aStep;
        if(aAcc > 0.985) break;
      }
      if(aAcc > 0.985) break;
    }
    if(aAcc > 0.985) break;
  }

  float opacity = clamp(uOpacity, 0.0, 2.0);
  acc *= opacity;
  aAcc *= opacity;
  if(aAcc < 0.0008) discard;
  gl_FragColor = vec4(acc, clamp(aAcc, 0.0, 0.95));
}
`;

// ---------------------------------------------------------------------------
// Planet ring dust ("clouds technique")
//
// This is used for planet rings (mini asteroid belts). It intentionally copies
// the *noise + eclipse* approach from the atmosphere/clouds shader, but removes
// the night-side dimming so the dust stays bright.
//
// NOTE: This is a mesh shader (rendered on stacked RingGeometry sheets), not a
// full-screen pass.
// ---------------------------------------------------------------------------

export const RING_DUST_VS = `
varying vec3 vPosL;
varying vec3 vPosW;

void main(){
  vPosL = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const RING_DUST_FS = `
precision highp float;

// Three.js provides modelMatrix as a built-in uniform, but it is only
// available in this fragment shader if we declare it explicitly.
uniform mat4 modelMatrix;

varying vec3 vPosL;
varying vec3 vPosW;

uniform vec3  uColor;
uniform float uOpacity;
uniform float uInner;
uniform float uOuter;
uniform float uFade;

// Torus volume params (local space)
uniform float uMajorR;   // mid radius
uniform float uTubeR;    // tube radius (unsquished)
uniform float uSquishZ;  // geometry Z scale applied in JS (<= 1.0)
uniform vec3  uCamPosL;  // camera position in torus-local space
uniform float uDensity;  // volume density multiplier
uniform float uSteps;    // raymarch steps (float)

uniform sampler2D uBlueNoiseTex;
uniform vec2 uBlueNoiseSize;
uniform float uTime;
uniform float uNoiseScale;
uniform float uWindSpeed;

uniform int   uOccCount;
uniform vec3  uOccCenters[24];
uniform float uOccRadii[24];
uniform float uEclipseSoftness;
uniform float uEclipseStrength;
uniform vec3  uSunPosW;
uniform float uSunRadius;

float saturate(float x){ return clamp(x, 0.0, 1.0); }

// Deterministic hash/noise (same family as the atmo/clouds pass).
float hash13(vec3 p){
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float valueNoise(vec3 p){
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f*f*(3.0-2.0*f);
  float n000 = hash13(i + vec3(0.0,0.0,0.0));
  float n100 = hash13(i + vec3(1.0,0.0,0.0));
  float n010 = hash13(i + vec3(0.0,1.0,0.0));
  float n110 = hash13(i + vec3(1.0,1.0,0.0));
  float n001 = hash13(i + vec3(0.0,0.0,1.0));
  float n101 = hash13(i + vec3(1.0,0.0,1.0));
  float n011 = hash13(i + vec3(0.0,1.0,1.0));
  float n111 = hash13(i + vec3(1.0,1.0,1.0));
  float n00 = mix(n000, n100, f.x);
  float n10 = mix(n010, n110, f.x);
  float n01 = mix(n001, n101, f.x);
  float n11 = mix(n011, n111, f.x);
  float n0 = mix(n00, n10, f.y);
  float n1 = mix(n01, n11, f.y);
  return mix(n0, n1, f.z);
}

float fbm(vec3 p){
  float a = 0.55;
  float s = 0.0;
  for(int i=0; i<5; i++){
    s += a * valueNoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return s;
}

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

float blueJitter(){
  vec2 sz = max(uBlueNoiseSize, vec2(1.0));
  vec2 uv = fract(gl_FragCoord.xy / sz);
  return texture2D(uBlueNoiseTex, uv).r;
}

void main(){
  // ------------------------------------------------------------
  // Volumetric ring dust (clouds technique)
  // ------------------------------------------------------------
  // We keep a single *squished torus mesh* for cheap rasterization,
  // but we integrate density through the torus volume (tiny raymarch)
  // so it feels like cloud volume rather than a paper-thin surface.
  // Night-side is removed (always bright), but eclipse masking stays.

  // View ray in local space.
  vec3 roL = uCamPosL;
  vec3 rdL = normalize(vPosL - roL);

  // Signed distance to an *unsquished* torus volume.
  // Because the geometry is scaled in Z by uSquishZ, we undo that scale
  // for the SDF eval so top/bottom edges fade naturally.
  float tubeR = max(1e-4, uTubeR);
  float squish = max(1e-4, uSquishZ);

  // Integrate through a slab around the surface point.
  float tCenter = dot(vPosL - roL, rdL);
  float tRange  = tubeR * 2.4;
  float t0 = tCenter - tRange;
  float t1 = tCenter + tRange;

  float steps = clamp(uSteps, 8.0, 64.0);
  float dt = (t1 - t0) / steps;
  float j = blueJitter();
  float tRay = t0 + dt * j;

  vec3 acc = vec3(0.0);
  float aAcc = 0.0;

  // Eclipse mask (apply once per fragment; good enough and cheaper).
  float vis = sunVisibility(vPosW, uSunPosW);
  float eclipseDim = mix(1.0, 0.35, 1.0 - vis);

  for (int i = 0; i < 64; i++) {
    if (float(i) >= steps) break;

    vec3 pL = roL + rdL * tRay;
    vec3 pU = vec3(pL.x, pL.y, pL.z / squish);

    // Radial profile (soft inner/outer transition like clouds)
    float rr = length(pU.xy);
    float x = abs(rr - uMajorR) / tubeR; // 0 = center of band, 1 = edge
    float s = clamp(uFade, 0.02, 0.98);
    float radial = 1.0 - smoothstep(1.0 - s, 1.0, x);
    if (radial <= 0.00001) {
      tRay += dt;
      continue;
    }

    // Torus SDF (volume)
    vec2 q = vec2(length(pU.xy) - uMajorR, pU.z);
    float sdf = length(q) - tubeR;
    // Density falls off smoothly outside the volume.
    float vol = exp(-max(sdf, 0.0) * max(sdf, 0.0) * (6.0 / (tubeR * tubeR)));

    // Cloud-like breakup in world space (animated wind)
    vec3 pW = (modelMatrix * vec4(pL, 1.0)).xyz;
    float tt = uTime * uWindSpeed;
    vec3 pN = pW * uNoiseScale + vec3(tt * 0.37, tt * 0.11, tt * 0.29);
    float n = fbm(pN);
    float ridged = 1.0 - abs(n * 2.0 - 1.0);
    float wisps = smoothstep(0.10, 0.92, pow(ridged, 1.25));

    float d = radial * vol * wisps;
    float aStep = 1.0 - exp(-d * uDensity * dt);
    aStep = clamp(aStep, 0.0, 0.55);

    vec3 col = uColor * (0.92 + 0.18 * n);
    col *= eclipseDim;

    acc += (1.0 - aAcc) * col * aStep;
    aAcc += (1.0 - aAcc) * aStep;
    if (aAcc > 0.985) break;

    tRay += dt;
  }

  float outA = clamp(uOpacity * aAcc, 0.0, 0.88);
  if (outA < 0.002) discard;
  gl_FragColor = vec4(acc, outA);
}`;

export function makeCloudMaskFS() {
  // Density-only mask for the closest body's god-ray occlusion. This avoids
  // repeating atmosphere scattering, eclipse tests and nested cloud-light
  // marches just to recover cloud alpha.
  return `
precision highp float;
varying vec2 vUv;

uniform mat4 uInvViewMatrix;
uniform mat4 uInvProjMatrix;
uniform sampler2D uDepthTex;
uniform float uLogDepthFC;
uniform vec3 uPlanetCenterW;
uniform float uPlanetRadius;
uniform float uGroundRadius;
uniform float uCloudBase;
uniform float uCloudThickness;
uniform float uCloudSteps;
uniform float uCloudDensity;
uniform float uCloudExtinctionScale;
uniform float uCloudSkipStrength;
uniform float uCloudCoverage;
uniform float uCloudSoftness;
uniform float uCloudFreq;
uniform float uCloudDetailFreq;
uniform vec3 uCloudNoiseOffset;
uniform float uCloudWindSpeed;
uniform float uTime;
uniform sampler2D uBlueNoiseTex;
uniform vec2 uBlueNoiseSize;

${CLOUD_NOISE_GLSL}

float saturate(float x){ return clamp(x, 0.0, 1.0); }

vec2 raySphere(vec3 ro, vec3 rd, vec3 c, float r){
  vec3 oc = ro - c;
  float b = dot(oc, rd);
  float c0 = dot(oc, oc) - r * r;
  float h = b * b - c0;
  if(h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

float sceneDistanceFromLogDepth(vec2 uv, vec3 rdV){
  float d = texture2D(uDepthTex, uv).r;
  if(d >= 0.999999) return 1e9;
  float log2v = (d * 2.0) / max(uLogDepthFC, 1e-8);
  float viewZ = -(exp2(log2v) - 1.0);
  float t = viewZ / rdV.z;
  return t > 0.0 ? t : 1e9;
}

float blueJitter(){
  vec2 tile = max(uBlueNoiseSize, vec2(1.0));
  return texture2D(uBlueNoiseTex, fract(gl_FragCoord.xy / tile)).r - 0.5;
}

float cloudSafeWorldDistance(
  vec4 macroNoise,
  float radius
){
  if(uCloudCoverage < uCloudDistanceMinCoverage) return 0.0;
  float safeCells = macroNoise.a * uCloudDistanceMaxCells;
  if(safeCells <= 0.0) return 0.0;

  float safeNoiseDistance = safeCells / max(uCloudNoiseSize, 1.0);
  float angularRate = abs(uCloudFreq) / max(
    radius,
    max(1.0, uPlanetRadius * 0.5)
  );
  float verticalRate = 0.35 / max(uCloudThickness, 1e-4);
  float coordinateRate = 0.11 * (angularRate + verticalRate);
  return safeNoiseDistance / max(coordinateRate, 1e-6);
}

vec2 cloudDensityDataAt(vec3 pW){
  vec3 lp = pW - uPlanetCenterW;
  float r = length(lp);
  vec3 dir = lp / max(r, 1e-6);
  float cloudBaseR = uPlanetRadius + uCloudBase;
  float h01 = saturate((r - cloudBaseR) / max(uCloudThickness, 1e-4));

  float wind = uTime * uCloudWindSpeed;
  float cs = cos(wind);
  float sn = sin(wind);
  vec3 flowDir = vec3(
    dir.x * cs - dir.z * sn,
    dir.y,
    dir.x * sn + dir.z * cs
  );
  vec3 heightWarp = vec3(0.0, (h01 - 0.5) * 0.35, 0.0);
  vec3 baseP = flowDir * uCloudFreq +
    vec3(0.37, 0.0, 0.29) * wind + heightWarp + uCloudNoiseOffset;

  // The god-ray mask deliberately uses only broad structure. This is cheaper
  // and slightly conservative because visible-cloud detail only erodes edges.
  vec4 macroNoise = sampleCloudNoise(baseP * 0.11);
  float macroShape = macroNoise.r;
  float weather = smoothstep(0.15, 0.85, macroNoise.b);
  float localCoverage = uCloudCoverage + (0.5 - weather) * 0.16;
  float edge = max(uCloudSoftness, 1e-4);
  float base = smoothstep(localCoverage, localCoverage + edge, macroShape);
  float profile =
    smoothstep(0.0, 0.08, h01) *
    (1.0 - smoothstep(0.58, 1.0, h01));

  float safeWorldDistance = 0.0;
  if(base <= 0.0005){
    safeWorldDistance = cloudSafeWorldDistance(macroNoise, r);
  }

  float density = saturate(base * profile) * max(0.0, uCloudDensity);
  return vec2(density, safeWorldDistance);
}

void marchMaskSegment(
  vec3 roW,
  vec3 rdW,
  float s0,
  float s1,
  float sceneT,
  float jitter,
  inout float alpha
){
  s0 = max(s0, 0.0);
  s1 = min(s1, sceneT);
  if(s1 <= s0) return;

  // The god-ray mask can be lower fidelity than the visible cloud pass.
  float steps = clamp(floor(uCloudSteps * 0.5 + 0.5), 3.0, 8.0);
  float dt = (s1 - s0) / steps;
  float normalizedDt = dt / max(uCloudThickness, 1e-4);
  float skipStrength = saturate(uCloudSkipStrength);
  float t = s0 + (0.5 + jitter * 0.70) * dt;

  for(int i = 0; i < 16; i++){
    if(t >= s1) break;
    vec2 cloudSample = cloudDensityDataAt(roW + rdW * t);
    float density = cloudSample.x;
    if(density <= 0.0005){
      float safeAdvance = cloudSample.y * 0.80 * skipStrength;
      float wholeSteps = max(1.0, floor(safeAdvance / dt));
      t += wholeSteps * dt;
      continue;
    }

    float aStep = 1.0 - exp(
      -density * normalizedDt * uCloudExtinctionScale
    );
    alpha += (1.0 - alpha) * aStep;
    t += dt;
    if(alpha > 0.96) break;
  }
}

void main(){
  if(uCloudDensity <= 0.0 || uCloudThickness <= 0.0) discard;

  vec2 uv = clamp(vUv, 0.0, 1.0);
  vec2 ndc = uv * 2.0 - 1.0;
  vec4 farV4 = uInvProjMatrix * vec4(ndc, 1.0, 1.0);
  vec3 farV = farV4.xyz / farV4.w;
  vec3 rdV = normalize(farV);
  vec3 roW = (uInvViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vec3 rdW = normalize((uInvViewMatrix * vec4(rdV, 0.0)).xyz);
  float sceneT = sceneDistanceFromLogDepth(uv, rdV);

  float cloudBaseR = uPlanetRadius + uCloudBase;
  float cloudTopR = cloudBaseR + uCloudThickness;
  vec2 outerHit = raySphere(roW, rdW, uPlanetCenterW, cloudTopR);
  if(outerHit.x > outerHit.y) discard;

  vec2 innerHit = raySphere(roW, rdW, uPlanetCenterW, cloudBaseR);
  vec2 groundHit = raySphere(roW, rdW, uPlanetCenterW, uGroundRadius);
  float groundT = 1e9;
  if(groundHit.x <= groundHit.y && groundHit.x > 0.0) groundT = groundHit.x;

  float jitter = blueJitter();
  float alpha = 0.0;
  float outerEnter = max(outerHit.x, 0.0);
  float outerExit = min(outerHit.y, groundT);

  if(innerHit.x <= innerHit.y){
    marchMaskSegment(
      roW,
      rdW,
      outerEnter,
      min(innerHit.x, outerExit),
      sceneT,
      jitter,
      alpha
    );
    marchMaskSegment(
      roW,
      rdW,
      max(innerHit.y, outerEnter),
      outerExit,
      sceneT,
      jitter,
      alpha
    );
  } else {
    marchMaskSegment(
      roW,
      rdW,
      outerEnter,
      outerExit,
      sceneT,
      jitter,
      alpha
    );
  }

  alpha = clamp(alpha, 0.0, 0.82);
  if(alpha < 0.001) discard;
  gl_FragColor = vec4(alpha, 0.0, 0.0, 1.0);
}`;
}
