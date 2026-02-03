// src/render/torusFogShader.js
// Volumetric torus fog (screen-space, depth-limited raymarch)
// Designed to mimic the planet atmosphere post pipeline, but with a torus SDF density field.

export const TORUS_FOG_FS = `
precision highp float;
varying vec2 vUv;

uniform mat4 uInvViewMatrix;
uniform mat4 uInvProjMatrix;
uniform sampler2D uDepthTex;
uniform float uLogDepthFC;

uniform sampler2D uBlueNoiseTex;
uniform vec2 uBlueNoiseSize;

uniform int uTorusCount;
uniform vec4 uTorusA[8]; // center.xyz, majorR
uniform vec4 uTorusB[8]; // axis.xyz, minorR
uniform vec4 uTorusC[8]; // color.rgb, density
uniform vec4 uTorusD[8]; // softness, shellPow, noiseMul, unused

uniform float uSteps;
uniform float uGlobalDensity;
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

vec3 safeOrtho(vec3 n){
  return normalize(abs(n.y) < 0.99 ? cross(vec3(0.0,1.0,0.0), n) : cross(vec3(1.0,0.0,0.0), n));
}

float torusSDF(vec3 pW, vec3 cW, vec3 axisW, float R, float r){
  vec3 up = normalize(axisW);
  vec3 t = safeOrtho(up);
  vec3 b = cross(up, t);
  vec3 d = pW - cW;
  vec3 pL = vec3(dot(d,t), dot(d,up), dot(d,b));
  vec2 q = vec2(length(pL.xz) - R, pL.y);
  return length(q) - r;
}

float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main(){
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

  vec2 tile = max(uBlueNoiseSize, vec2(1.0));
  vec2 bnUv = fract(gl_FragCoord.xy / tile);
  float bn = texture2D(uBlueNoiseTex, bnUv).r;
  float jitter = bn - 0.5;

  float steps = max(8.0, uSteps);
  float dt = tMax / steps;
  float t0 = max(0.0, dt * jitter);

  vec3 acc = vec3(0.0);
  float aAcc = 0.0;

  for(float i=0.0; i<96.0; i++){
    if(i >= steps) break;
    float t = t0 + (i + 0.5) * dt;
    if(t > tMax) break;

    vec3 pW = roW + rdW * t;

    vec2 nUv = fract(pW.xz * uNoiseScale + vec2(uTime*0.02, -uTime*0.015));
    float n = texture2D(uBlueNoiseTex, nUv).r;
    n = mix(n, hash12(nUv * 2048.0), 0.35);
    float wisps = smoothstep(0.15, 0.95, n);

    vec3 colStep = vec3(0.0);
    float densSum = 0.0;

    for(int k=0; k<8; k++){
      if(k >= uTorusCount) break;
      vec3 cW = uTorusA[k].xyz;
      float R  = uTorusA[k].w;
      vec3 axisW = uTorusB[k].xyz;
      float r = uTorusB[k].w;
      vec3 cCol = uTorusC[k].rgb;
      float dMul = uTorusC[k].w;
      float soft = max(1.0, uTorusD[k].x);
      float shellPow = max(0.5, uTorusD[k].y);
      float noiseMul = uTorusD[k].z;

      float sdf = torusSDF(pW, cW, axisW, R, r);
      float inside = 1.0 - smoothstep(0.0, soft, sdf);
      float shell = 1.0 - saturate((-sdf) / max(r, 1e-3));
      shell = pow(shell, shellPow);
      float density = inside * mix(0.35, 1.0, shell);
      density *= (0.55 + 0.75 * mix(1.0, wisps, noiseMul));
      density *= dMul;

      if(density <= 0.00005) continue;
      densSum += density;
      colStep += cCol * density;
    }

    if(densSum <= 0.00005) continue;
    colStep /= densSum;

    float aStep = 1.0 - exp(-densSum * uGlobalDensity * dt * 0.00045);
    aStep = clamp(aStep, 0.0, 0.75);

    acc += (1.0 - aAcc) * colStep * aStep;
    aAcc += (1.0 - aAcc) * aStep;
    if(aAcc > 0.985) break;
  }

  if(aAcc < 0.001) discard;
  gl_FragColor = vec4(acc, clamp(aAcc, 0.0, 0.95));
}
`;

vec3 safeOrtho(vec3 n){
  // Pick a vector not parallel to n
  vec3 a = (abs(n.y) < 0.99) ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  return normalize(cross(a, n));
}

float torusSDF(vec3 pW, vec3 cW, vec3 axisW, float R, float r){
  vec3 up = normalize(axisW);
  vec3 t = safeOrtho(up);
  vec3 b = cross(up, t);
  vec3 d = pW - cW;
  // Local frame where 'up' is local Y, and torus lies in local XZ plane.
  vec3 pL = vec3(dot(d, t), dot(d, up), dot(d, b));
  vec2 q = vec2(length(pL.xz) - R, pL.y);
  return length(q) - r;
}

float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
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

  // Per-pixel blue-noise jitter
  vec2 tile = max(uBlueNoiseSize, vec2(1.0));
  vec2 bnUv = fract(gl_FragCoord.xy / tile);
  float bn = texture2D(uBlueNoiseTex, bnUv).r;
  float jitter = bn - 0.5;

  float steps = max(8.0, uSteps);
  float dt = tMax / steps;
  float t0 = max(0.0, dt * jitter);

  vec3 acc = vec3(0.0);
  float aAcc = 0.0;

  for(float i=0.0; i<96.0; i++){
    if(i >= steps) break;
    float t = t0 + (i + 0.5) * dt;
    if(t > tMax) break;

    vec3 pW = roW + rdW * t;

    // World-locked breakup
    vec2 nUv = fract(pW.xz * uNoiseScale + vec2(uTime*0.02, -uTime*0.015));
    float n = texture2D(uBlueNoiseTex, nUv).r;
    n = mix(n, hash12(nUv * 2048.0), 0.35);
    float wisps = smoothstep(0.15, 0.95, n);

    vec3 colStep = vec3(0.0);
    float densSum = 0.0;

    for(int k=0; k<8; k++){
      if(k >= uTorusCount) break;

      vec3 cW = uTorusA[k].xyz;
      float R  = uTorusA[k].w;
      vec3 axisW = uTorusB[k].xyz;
      float r = uTorusB[k].w;

      vec3 cCol = uTorusC[k].rgb;
      float dMul = uTorusC[k].w;

      float soft = max(1.0, uTorusD[k].x);
      float shellPow = max(0.5, uTorusD[k].y);
      float noiseMul = uTorusD[k].z;

      float sdf = torusSDF(pW, cW, axisW, R, r);

      // Solid volume with soft boundary (outside)
      float inside = 1.0 - smoothstep(0.0, soft, sdf);

      // Bias density toward the boundary so it reads as fog, not a solid donut
      float shell = 1.0 - saturate((-sdf) / max(r, 1e-3)); // 1 at surface, 0 deep inside
      shell = pow(shell, shellPow);

      float density = inside * mix(0.35, 1.0, shell);
      density *= (0.55 + 0.75 * mix(1.0, wisps, noiseMul));
      density *= dMul;

      if(density <= 0.00005) continue;
      densSum += density;
      colStep += cCol * density;
    }

    if(densSum <= 0.00005) continue;
    colStep /= densSum;

    // Density -> alpha
    float aStep = 1.0 - exp(-densSum * uGlobalDensity * dt * 0.00045);
    aStep = clamp(aStep, 0.0, 0.75);

    acc += (1.0 - aAcc) * colStep * aStep;
    aAcc += (1.0 - aAcc) * aStep;

    if(aAcc > 0.985) break;
  }

  if(aAcc < 0.001) discard;
  gl_FragColor = vec4(acc, clamp(aAcc, 0.0, 0.95));
}
`;
