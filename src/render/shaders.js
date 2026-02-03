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
  vec4 c = texture2D(tAtmo, clamp(vUv,0.0,1.0));
  c.rgb = acesToneMap(c.rgb);
  gl_FragColor = linearToOutputTexel(c);
}
`,
  });
  const mesh = new THREE.Mesh(fsTri, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { scene, material, mesh };
}

export function createUnderwaterPost(THREE, fsTri, blueNoiseTex) {
  const scene = new THREE.Scene();

  const tintMat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(0x06131f) },
      uOpacity: { value: 0.0 },
    },
    vertexShader: FULLSCREEN_VS,
    fragmentShader: `precision highp float; varying vec2 vUv; uniform vec3 uColor; uniform float uOpacity;
void main(){ gl_FragColor = vec4(uColor, uOpacity); }`,
  });
  const tintMesh = new THREE.Mesh(fsTri, tintMat);
  tintMesh.frustumCulled = false;
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
  scene.add(particlesMesh);

  return { scene, tintMat, particlesMat, tintMesh, particlesMesh };
}

export function createGodRaysPass(THREE, fsTri, depthTex, cloudTex, samples = 18) {
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
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
  float onScreen =
    step(0.0, s.x) * step(0.0, s.y) * step(s.x, 1.0) * step(s.y, 1.0);

  vec2 delta = (s - uv) * (uDensity / max(uSamples, 1.0));

  float illum = 0.0;
  float decay = 1.0;

  for(float i=0.0; i<128.0; i++){
    if(i >= uSamples) break;
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
uniform vec2  uResolution;
uniform float uVerticalMode;

#define PI 3.141592653589793

float vDrop(vec2 uv,float t)
{
  uv.x = uv.x*128.0;
  float dx = fract(uv.x);
  uv.x = floor(uv.x);
  uv.y *= 0.05;
  float o=sin(uv.x*215.4);
  float s=cos(uv.x*33.1)*.3 +.7;
  float trail = mix(95.0,35.0,s);
  float yv = fract(uv.y + t*s + o) * trail;
  yv = 1.0/max(yv, 1e-4);
  yv = smoothstep(0.0,1.0,yv*yv);
  yv = sin(yv*PI)*(s*5.0);
  float d2 = sin(dx*PI);
  return yv*(d2*d2);
}

void main(){
  float s = clamp(uStrength, 0.0, 1.0);
  float a = clamp(uFade, 0.0, 1.0);
  if (a <= 0.0001) { gl_FragColor = vec4(0.0); return; }

  vec2 fragCoord = vUv * uResolution;
  vec2 p = (fragCoord.xy - 0.5 * uResolution.xy) / max(uResolution.y, 1.0);

  float d = length(p)+0.1;
  p = vec2(atan(p.x, p.y) / PI, 2.5 / max(d, 1e-4));
  if (uVerticalMode > 0.5) p.y *= 0.5;

  float t =  uTime*0.4;

  vec3 col = vec3(1.55,0.65,.225) * vDrop(p,t);
  col += vec3(0.55,0.75,1.225) * vDrop(p,t+0.33);
  col += vec3(0.45,1.15,0.425) * vDrop(p,t+0.66);

  col *= (d*d);
  col *= s;

  gl_FragColor = vec4(col, a);
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
            uniform float uAtmoHeight;
            uniform vec3  uSunPosW;

            uniform sampler2D uBlueNoiseTex;
            uniform vec2      uBlueNoiseSize;

            uniform float uAtmoSteps;
            uniform float uAtmoDensity;
            uniform float uAtmoScaleHeight;
            uniform float uBlueStrength;
            uniform float uSunsetStrength;
            uniform float uNightDarken;
            uniform float uSunGlare;
            uniform float uMinLight;
            uniform float uDayOpacityBoost;

            uniform float uCloudBase;
            uniform float uCloudThickness;
            uniform float uCloudSteps;
            uniform float uCloudDensity;
            uniform float uCloudCoverage;
            uniform float uCloudSoftness;
            uniform float uCloudFreq;
            uniform float uCloudDetailFreq;
            uniform float uCloudWindSpeed;
            uniform float uCloudLightSteps;
            uniform float uCloudShadowStrength;
            uniform float uCloudPhase;

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
				  // (Softer than only smoothing outside the edge; avoids a hard cut.)
				  float w = r * uEclipseSoftness;
				  float edge = smoothstep(r - w, r + w, d);
                  vis = min(vis, edge);
                }
              }

              return mix(1.0, vis, clamp(uEclipseStrength, 0.0, 1.0));
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

            float hash13(vec3 p){
              p = fract(p * 0.1031);
              p += dot(p, p.yzx + 33.33);
              return fract((p.x + p.y) * p.z);
            }

            float valueNoise(vec3 p){
              vec3 i = floor(p);
              vec3 f = fract(p);
              f = f*f*(3.0 - 2.0*f);

              float n000 = hash13(i + vec3(0,0,0));
              float n100 = hash13(i + vec3(1,0,0));
              float n010 = hash13(i + vec3(0,1,0));
              float n110 = hash13(i + vec3(1,1,0));
              float n001 = hash13(i + vec3(0,0,1));
              float n101 = hash13(i + vec3(1,0,1));
              float n011 = hash13(i + vec3(0,1,1));
              float n111 = hash13(i + vec3(1,1,1));

              float x00 = mix(n000, n100, f.x);
              float x10 = mix(n010, n110, f.x);
              float x01 = mix(n001, n101, f.x);
              float x11 = mix(n011, n111, f.x);
              float y0 = mix(x00, x10, f.y);
              float y1 = mix(x01, x11, f.y);
              return mix(y0, y1, f.z);
            }

            float fbm(vec3 p){
              float a = 0.5;
              float s = 0.0;
              float f = 1.0;
              for(int i=0;i<5;i++){
                s += a * valueNoise(p * f);
                f *= 2.02;
                a *= 0.5;
              }
              return s;
            }

            float phaseHG(float mu, float g){
              float gg = g*g;
              return (1.0 - gg) / pow(1.0 + gg - 2.0*g*mu, 1.5);
            }

            float cloudField(vec3 pW){
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

              vec3 qBase   = d2 * uCloudFreq       + flow1 + heightWarp;
              vec3 qDetail = d2 * uCloudDetailFreq + flow2 + heightWarp * 1.7;

              float n = fbm(qBase);

              // Billowy remap (fluffier, less "ghosty").
              // Ridged noise creates puffy cells with crisp cores.
              float ridged = 1.0 - abs(n * 2.0 - 1.0);
              ridged = pow(saturate(ridged), 1.35);

              // Blend raw and ridged noise for big puffs with thicker cores.
              float clump = mix(n, ridged, 0.65);

              float d = clump - uCloudCoverage;
              float base = saturate(d / max(uCloudSoftness, 1e-4));

              // Thicker cores: push mid/high densities up.
              base = pow(base, 1.25);

              float nd = fbm(qDetail + vec3(17.3, 9.1, 33.7));
              float detail = mix(0.55, 1.35, nd);
              detail *= mix(0.90, 1.15, ridged);

              // Thicker vertical profile: keep billows fuller near the top.
              float profile =
                smoothstep(0.0, 0.10, h01) *
                (1.0 - smoothstep(0.82, 1.0, h01));

              return saturate(base * detail * profile);
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

              float stepsC = max(8.0, uCloudSteps);
              float dtC = (s1 - s0) / stepsC;
              float j = jitter;

              for(float i=0.0; i<256.0; i+=1.0){
                if(i >= stepsC) break;

                float t = s0 + (i + 0.5 + j) * dtC;
                vec3 p = roW + rdW * t;

                vec3 upP = normalize(p - uPlanetCenterW);
                // True sun-facing term (-1..1). Use this to gate eclipse effects to the day hemisphere.
                float ndlP = dot(upP, sunDir);
                float dayP = saturate(ndlP * 0.5 + 0.5);
                float nightMask = mix(uMinLight, 1.0, pow(dayP, uNightDarken));

                // Only let eclipses affect the sun-facing hemisphere.
                // Otherwise they incorrectly darken the "night" minimum light.
                float daySideP = smoothstep(0.0, 0.25, ndlP);
                nightMask *= mix(1.0, visGlobal, daySideP);

                float dens = cloudField(p) * uCloudDensity;
                if(dens <= 0.0005) continue;

                float sSteps = max(2.0, uCloudLightSteps);
                float sdt = (uCloudThickness * 1.2) / sSteps;

                float stau = 0.0;
                for(float k=0.0; k<64.0; k+=1.0){
                  if(k >= sSteps) break;
                  float st = (k + 1.0 + j) * sdt;
                  vec3 sp = p + sunDir * st;
                  float sd = cloudField(sp) * uCloudDensity;
                  stau += sd * sdt;
                  if(stau > 6.0) break;
                }
                float shadow = exp(-stau * uCloudShadowStrength);

                float aStep = 1.0 - exp(-dens * dtC);
                float contrib = (1.0 - cloudAlpha) * aStep;

                vec3 lit = vec3(1.0) * shadow;
                lit *= (0.55 + 0.45 * phase);

                float mu = dot(rdW, sunDir);
                lit *= mix(vec3(0.92, 0.96, 1.0), vec3(1.0, 0.92, 0.80), saturate(mu*0.5+0.5));

                lit *= nightMask;

                cloudCol += contrib * lit;
                cloudAlpha += contrib;

                if(cloudAlpha > 0.98) break;
              }
            }

            vec3 cheapClouds(
              vec3 roW, vec3 rdW,
              vec2 tOuter, vec2 tInner,
              float sceneT,
              float jitter,
              vec3 sunDir,
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

              vec3 q1 = d2 * (uCloudFreq * uCheapCloudScale) + flow1;
              vec3 q2 = d2 * (uCloudDetailFreq * 0.35 * uCheapCloudScale) + flow2 + vec3(17.3,9.1,33.7);

              float n1 = valueNoise(q1);
              float n2 = valueNoise(q2);
              float n  = mix(n1, n2, 0.55);

              float edge = 0.25 / max(uCheapCloudSharp, 1e-3);

              float cov = uCloudCoverage - 0.08 * uCheapCloudFarBoost;

              float m = smoothstep(cov, cov + edge, n);
              m = pow(saturate(m), 1.0 / max(uCheapCloudContrast, 1e-3));

              float h = abs(d2.y);
              float prof = smoothstep(0.10, 0.75, 1.0 - h);

              float a = m * prof * uCheapCloudAlpha * (1.0 + uCheapCloudFarBoost);
              // Make distant clouds read as fluffy masses (less transparent).
              a *= 1.35;
              a = min(a, 0.85);

              float ndl = saturate(dot(lp, sunDir) * 0.5 + 0.5);
              float nightMask = mix(uMinLight, 1.0, pow(ndl, uNightDarken));

              float mu = dot(rdW, sunDir);
              float phase = phaseHG(mu, clamp(uCloudPhase, -0.5, 0.95));

              float rim = pow(1.0 - saturate(dot(-rdW, lp)), 2.5) * uCheapCloudRim * (1.0 + 0.65 * uCheapCloudFarBoost);

              vec3 col = vec3(1.0) * (0.35 + 0.65 * ndl) * (0.55 + 0.45 * phase);
              col += rim * vec3(1.0);

              col *= nightMask;

              outA = clamp(a, 0.0, 0.85);
              return col;
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

              // Eclipse visibility is expensive; approximate as constant along the view ray for this pixel.
              float visGlobal = 1.0;
              float atmoR = uPlanetRadius + uAtmoHeight;
              vec2 tAtmo = raySphere(roW, rdW, uPlanetCenterW, atmoR);
              if(tAtmo.x > tAtmo.y) discard;

              vec2 tGround = raySphere(roW, rdW, uPlanetCenterW, uGroundRadius);

              float t0 = max(tAtmo.x, 0.0);
              float t1 = tAtmo.y;

              if(tGround.x <= tGround.y && tGround.x > 0.0){
                t1 = min(t1, tGround.x);
              }

              if(t0 > sceneT) discard;
              t1 = min(t1, sceneT);
              if(t1 <= t0) discard;

              // Sample visibility once at ~35% along the segment (good enough; huge perf win).
              float tVis = mix(t0, t1, 0.35);
              visGlobal = sunVisibility(roW + rdW * tVis, uSunPosW);

              float stepsA = max(8.0, uAtmoSteps);
              float dtA = (t1 - t0) / stepsA;
              float scaleH = max(1e-3, uAtmoHeight * uAtmoScaleHeight);

              vec3 atmoCol = vec3(0.0);
              float atmoAlpha = 0.0;
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

                float vis = visGlobal;
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

              // Allow a denser day side without going fully opaque.
              atmoAlpha = clamp(atmoAlpha, 0.0, 0.72);

              atmoCol *= mix(vec3(1.0), uAtmoTint, 0.85);

              float cloudBaseR = uPlanetRadius + uCloudBase;
              float cloudTopR  = cloudBaseR + uCloudThickness;

              vec2 tOuter = raySphere(roW, rdW, uPlanetCenterW, cloudTopR);
              vec2 tInner = raySphere(roW, rdW, uPlanetCenterW, cloudBaseR);

              vec3 cloudCol = vec3(0.0);
              float cloudAlpha = 0.0;

              bool hitOuter = (tOuter.x <= tOuter.y);

              if(hitOuter){
                if(uUseCheapClouds > 0.5){
                  cloudCol = cheapClouds(roW, rdW, tOuter, tInner, sceneT, jitter, sunDir, cloudAlpha);
                } else {
                  float groundT = 1e9;
                  if(tGround.x <= tGround.y && tGround.x > 0.0) groundT = tGround.x;

                  float mu = dot(rdW, sunDir);
                  float phase = phaseHG(mu, clamp(uCloudPhase, -0.5, 0.95));

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
              cloudAlpha = clamp(cloudAlpha, 0.0, 0.82);
              cloudCol *= mix(vec3(1.0), uCloudTint, 0.65);

              vec3 col = atmoCol;
              float a = atmoAlpha;

              col = mix(col, cloudCol, cloudAlpha);
              a = max(a, cloudAlpha);

              gl_FragColor = vec4(col, a);
            }`;

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
uniform vec3  uRingTint[8];

// Global dust tuning (driven by sliders)
uniform float uOpacity;
uniform float uDensity;
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
  for(int i=0; i<4; i++){
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

float sunVisibility(vec3 pW){
  vec3 rd = normalize(uSunPosW - pW);
  float maxT = length(uSunPosW - pW);
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
				  // (Softer than only smoothing outside the edge; avoids a hard cut.)
				  float w = r * uEclipseSoftness;
				  float edge = smoothstep(r - w, r + w, d);
      vis = min(vis, edge);
    }
  }
  return mix(1.0, vis, clamp(uEclipseStrength, 0.0, 1.0));
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

    // Representative point for eclipse visibility
    float tRep = 0.5*(tEnter+tExit);
    if(abs(rdL.y) > 1e-4){
      float tp = (-roL.y)/rdL.y;
      if(tp > tEnter && tp < tExit) tRep = tp;
    }
    vec3 pWrep = roW + rdW * tRep;
    float vis = sunVisibility(pWrep);
    float eclipseDim = mix(1.0, 0.35, 1.0 - vis);

    // Local march just through the slab; enough steps to feel like volume.
    float steps = 18.0;
    float dt = (tExit - tEnter) / steps;
    float t0m = tEnter + dt * (0.5 + j);

    vec3 tint = uRingTint[r];

    for(float i=0.0; i<32.0; i++){
      if(i >= steps) break;
      float t = t0m + i * dt;
      if(t < tEnter || t > tExit) continue;
      vec3 pW = roW + rdW * t;
      vec3 pL = roL + rdL * t;

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
      float n = fbm(pN);
      float ridged = 1.0 - abs(n*2.0 - 1.0);
      float wisps = smoothstep(0.10, 0.92, pow(ridged, 1.25));

      float d = radial * vertical * (0.30 + 0.95*wisps);
      // Exponential attenuation; tuned for ring scales.
      float aStep = 1.0 - exp(-d * dens * dt * 0.00055);
      aStep = clamp(aStep, 0.0, 0.65);
      if(aStep <= 0.00001) continue;

      vec3 c = tint * (0.85 + 0.35*wisps) * eclipseDim;
      acc += (1.0 - aAcc) * c * aStep;
      aAcc += (1.0 - aAcc) * aStep;
      if(aAcc > 0.985) break;
    }
    if(aAcc > 0.985) break;
  }

  aAcc *= clamp(uOpacity, 0.0, 2.0);
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
				  // (Softer than only smoothing outside the edge; avoids a hard cut.)
				  float w = r * uEclipseSoftness;
				  float edge = smoothstep(r - w, r + w, d);
      vis = min(vis, edge);
    }
  }
  return mix(1.0, vis, clamp(uEclipseStrength, 0.0, 1.0));
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
  return ATMO_FS.replace(
    "gl_FragColor = vec4(col, a);",
    "gl_FragColor = vec4(vec3(cloudAlpha), 1.0);",
  );
}
