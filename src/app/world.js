import { THREE, createRenderer } from "../render/device.js";
import { QUALITY_PRESETS, getPreset } from "../core/config.js";
import {
  createFullscreenTri,
  createCopyPass,
  createAtmoCopyPass,
  createTextureCompositePass,
  createUnderwaterPost,
  createGodRaysPass,
  ATMO_VS,
  ATMO_FS,
  BELT_DUST_FS,
  RING_DUST_POST_FS,
  makeCloudMaskFS,
} from "../render/shaders.js";

import {
  SuperPointLight,
  attachSuperPointLightMask,
  updateSuperPointLightMask,
  registerSPLMaterial,
  registerSPLMaterialsIn,
  clearSPLMaterialRegistry,
  splMaskedMaterials,
} from "../game/spl.js";

import {
  createVolumeNoiseAtlas,
  makeVolumeNoiseUniforms,
  createCloudNoiseAtlas,
  makeCloudNoiseUniforms,
  VOLUME_NOISE_SIZE,
} from "../render/noiseTextures.js";

import { QuadSphereBody, terrainPool } from "../game/terrain/quadsphere.js";
import { createAsteroidBelt, createPlanetRing } from "../game/asteroidBelt.js";
import { GasGiantBody } from "../game/gasGiant.js";
import { buildSolarSecretSystem as buildSolarSecretSystemLevel } from "../game/levels/solarSecret.js";

export function createWorld({ seed, preset } = {}) {
  const world = {};

  const initialSeed = (seed ?? 101010) >>> 0;
  const initialPreset = preset ?? null;

  ////////////////////////////////////////////////////////////////////////////////
  // Secret level music (Solar preset only)
  // - Plays ./assets/WelcomeHome.mp3 on loop ONLY while the solar_secret system is active.
  // - Respects the global mute toggle via world.setMuted().
  ////////////////////////////////////////////////////////////////////////////////
  let _secretMusic = null;
  let _secretMusicGestureHooked = false;
  let _muted = false;
  let _solarSecretActive = false;
  world.isSolarSecretActive = () => _solarSecretActive;

  function ensureSecretMusic() {
    if (_secretMusic) return _secretMusic;
    try {
      const a = new Audio("./assets/WelcomeHome.mp3");
      a.loop = true;
      a.preload = "auto";
      a.volume = 0.75;
      a.muted = _muted;
      _secretMusic = a;
    } catch (e) {
      // If audio fails to initialize, keep the game running.
      _secretMusic = null;
    }
    return _secretMusic;
  }

  function startSecretMusic() {
    const a = ensureSecretMusic();
    if (!a) return;
    a.muted = _muted;
    // Try immediately; some browsers require a user gesture, so also hook pointerdown.
    try {
      a.play?.();
    } catch {}
    if (!_secretMusicGestureHooked) {
      _secretMusicGestureHooked = true;
      window.addEventListener(
        "pointerdown",
        () => {
          try {
            a.muted = _muted;
            a.play?.();
          } catch {}
        },
        { once: true },
      );
    }
  }

  function stopSecretMusic() {
    const a = _secretMusic;
    if (!a) return;
    try {
      a.pause?.();
    } catch {}
    try {
      a.currentTime = 0;
    } catch {}
  }

  world.setMuted = (m) => {
    _muted = !!m;
    try {
      if (_secretMusic) _secretMusic.muted = _muted;
    } catch {}
  };
  world.isMuted = () => _muted;

  // THREE setup
  ////////////////////////////////////////////////////////////////////////////////
  const renderer = createRenderer({
    antialias: false,
    logarithmicDepthBuffer: true,
  });

  // Set initial size; pixel ratio is clamped by quality preset (below)
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.000012);

  // Layers
  // 0 = world (default)
  // 1 = player ship (re-rendered on top during warp)
  const PLAYER_SHIP_LAYER = 1;

  const camera = new THREE.PerspectiveCamera(
    75,
    innerWidth / innerHeight,
    0.05,
    260000,
  );
  scene.add(camera);

  // Render both world + ship by default.
  camera.layers.enable(PLAYER_SHIP_LAYER);

  // Lights
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x04070c, 0.25);
  scene.add(hemi);

  const msg = document.getElementById("msg");
  const crosshair = document.getElementById("crosshair");

  const fpsEl = document.getElementById("fps");

  const qualitySel = document.getElementById("qualitySelect");

  let currentQuality =
    qualitySel && QUALITY_PRESETS[qualitySel.value]
      ? qualitySel.value
      : "Descktop";
  let QUALITY_SPOT_SHADOW = QUALITY_PRESETS[currentQuality].spotShadow;
  let QUALITY_ATMO_SCALE = QUALITY_PRESETS[currentQuality].atmoScale;
  let QUALITY_CLOUD_SCALE = QUALITY_PRESETS[currentQuality].cloudScale;
  let QUALITY_GODRAY_ENABLED = QUALITY_PRESETS[currentQuality].godRays !== false;
  let QUALITY_GODRAY_SAMPLES = QUALITY_PRESETS[currentQuality].godRaySamples;
  let QUALITY_GODRAY_SCALE = QUALITY_PRESETS[currentQuality].godRayScale ?? 0.5;
  let QUALITY_GODRAY_INTENSITY = QUALITY_PRESETS[currentQuality].godRayIntensity ?? 0.08;
  let QUALITY_GODRAY_DENSITY = QUALITY_PRESETS[currentQuality].godRayDensity ?? 0.7;
  let QUALITY_GODRAY_DECAY = QUALITY_PRESETS[currentQuality].godRayDecay ?? 0.92;
  let QUALITY_GODRAY_WEIGHT = QUALITY_PRESETS[currentQuality].godRayWeight ?? 0.18;
  let QUALITY_ATMO_STEPS = QUALITY_PRESETS[currentQuality].atmoSteps;
  let QUALITY_CLOUD_STEPS = QUALITY_PRESETS[currentQuality].cloudSteps;
  let QUALITY_CLOUD_LIGHT_STEPS =
    QUALITY_PRESETS[currentQuality].cloudLightSteps;
  let QUALITY_RING_DUST_STEPS =
    QUALITY_PRESETS[currentQuality].ringDustSteps;
  // Dynamic resolution + step scaling (FPS-driven)
  let dynScale = 1.0;
  let dynAtmoSteps = QUALITY_ATMO_STEPS;
  let dynCloudSteps = QUALITY_CLOUD_STEPS;
  let dynCloudLightSteps = QUALITY_CLOUD_LIGHT_STEPS;
  let dynGodraySamples = QUALITY_GODRAY_SAMPLES;
  let dynRingDustSteps = QUALITY_RING_DUST_STEPS;

  // Expensive fullscreen volumetrics render offscreen and are upsampled.
  const RING_DUST_SCALE = 0.5;

  let _splMaskAccum = 0.0;
  let SPL_MASK_INTERVAL = 1.0 / 30.0; // throttle uniform updates

  // Galaxy location of the CURRENT system (separate from local world coords)
  const galaxyPlayer = { x: 0, z: 0, name: "SOL-000" };

  // UI controllers (kept out of main.js)
  let galaxyOverlayUI = null;
  let galaxyMiniMapUI = null;

  // (Galaxy UI extracted into src/ui/*)

  function makeRadialGlowTexture(size = 256) {
    const c = document.createElement("canvas");
    c.width = c.height = size;
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(
      size * 0.5,
      size * 0.5,
      size * 0.0,
      size * 0.5,
      size * 0.5,
      size * 0.5,
    );
    g.addColorStop(0.0, "rgba(255,255,255,1.00)");
    g.addColorStop(0.15, "rgba(255,235,200,0.85)");
    g.addColorStop(0.35, "rgba(255,190,120,0.35)");
    g.addColorStop(1.0, "rgba(0,0,0,0.00)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    return tex;
  }

  // Sun + system root
  const system = new THREE.Group();
  scene.add(system);

  // ============================================================================
  // Fun scale mode ("No Man's Sky"-ish)
  // - Scales planets/moons/sun/orbits together so the whole system feels bigger.
  // - Kept as a simple constant so it's easy to remove/tweak.
  // ============================================================================
  const NMS_SCALE = 3.0;
  const NMS_RADIUS_SCALE = NMS_SCALE;
  const NMS_ORBIT_SCALE = NMS_SCALE;
  const NMS_SUN_SCALE = NMS_SCALE;

  const SUN_RADIUS = 450 * NMS_SUN_SCALE;
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_RADIUS, 40, 20),
    new THREE.MeshStandardMaterial({
      color: 0xffcc66,
      emissive: 0xffaa33,
      emissiveIntensity: 10.0,
      roughness: 0.58,
      fog: false,
    }),
  );
  system.add(sun);

  // Sun glow
  const sunGlowTex = makeRadialGlowTexture(256);
  const sunGlow = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: sunGlowTex,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      opacity: 1.8,
      color: 0xffe8b5,
      fog: false,
    }),
  );
  sunGlow.renderOrder = -10;
  sunGlow.scale.setScalar(SUN_RADIUS * 13.0);
  sun.add(sunGlow);

  const corona = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_RADIUS * 1.24, 48, 24),
    new THREE.MeshBasicMaterial({
      color: 0xffd38a,
      transparent: true,
      opacity: 0.38,
      fog: false,
      side: THREE.BackSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  corona.renderOrder = -9;
  sun.add(corona);

  ////////////////////////////////////////////////////////////////////////////////
  // SUN LIGHT: SuperPointLight (unshadowed PointLight + focused SpotLight shadows)
  // - PointLight: omnidirectional direct sunlight; cube shadows are disabled
  // - Internal SpotLight: high-res local shadows aimed at the camera
  //   Spot cone + depth window form a local ~300 m shadow bubble.
  ////////////////////////////////////////////////////////////////////////////////

  // Direct solar irradiance used by lit world materials. This is deliberately
  // expressed as the actual PointLight/SpotLight intensity rather than the old
  // six-face cube-light total, so future tuning is predictable. The focused
  // spotlight replaces (rather than adds to) the point-light contribution in
  // its cone through the SuperPointLight material mask.
  const SUN_SURFACE_LIGHT_INTENSITY = 14.0;

  const sunLight = new SuperPointLight(
    0xffffff,
    SUN_SURFACE_LIGHT_INTENSITY,
    260000,
    0.0,
    {
      // spot shadows (sharp)
      spotCastShadow: true,
      spotShadowMapSize: QUALITY_SPOT_SHADOW,
      // These are replaced every frame with a tight camera-centered depth
      // window. Keep reasonable fallback values for the first frame.
      spotShadowNear: 0.1,
      spotShadowFar: 600.0,
      spotShadowBias: -0.00001,
      spotShadowNormalBias: 0.01,
      spotFocus: 1.0,
      spotAngleDeg: 45, // overridden dynamically
      spotPenumbra: 0.15,
      spotIntensityFactor: 1.0,
      spotDirection: new THREE.Vector3(0, 0, 1),

      // Astronomical eclipse masking is analytic in the material shader, so it
      // remains valid even though the high-detail spot shadow camera only spans
      // the local d +/- 300 m depth window.
      eclipseSunRadius: SUN_RADIUS,
      eclipseSoftness: 0.015,
      eclipseStrength: 1.0,
      eclipseAmbientFloor: 0.12,
    },
  );
  system.add(sunLight);

  function getShadowBiasParams() {
    return {
      spotBias: sunLight.shadowLight?.shadow?.bias ?? 0.0,
      spotNormalBias: sunLight.shadowLight?.shadow?.normalBias ?? 0.0,
    };
  }

  function setShadowBiasParams(params = {}) {
    const spotShadow = sunLight.shadowLight?.shadow;
    if (Number.isFinite(params.spotBias) && spotShadow) {
      spotShadow.bias = params.spotBias;
    }
    if (Number.isFinite(params.spotNormalBias) && spotShadow) {
      spotShadow.normalBias = params.spotNormalBias;
    }
  }

  function applySpotShadowState({ disposeMaps = true, rebuildMaps = false } = {}) {
    // PointLight cube shadows are permanently disabled. Only the focused
    // SpotLight owns rasterized solar shadows.
    sunLight.castShadow = false;
    if (disposeMaps && sunLight.shadow?.map) {
      sunLight.shadow.map.dispose();
      sunLight.shadow.map = null;
    }

    const wantSpot = (QUALITY_SPOT_SHADOW | 0) > 0;
    if (sunLight.shadowLight) {
      sunLight.shadowLight.castShadow = wantSpot;
      if (sunLight.shadowLight.shadow) {
        if (wantSpot) {
          sunLight.shadowLight.shadow.mapSize.set(
            QUALITY_SPOT_SHADOW,
            QUALITY_SPOT_SHADOW,
          );
          if (rebuildMaps && sunLight.shadowLight.shadow.map) {
            sunLight.shadowLight.shadow.map.dispose();
            sunLight.shadowLight.shadow.map = null;
          }
        } else if (disposeMaps && sunLight.shadowLight.shadow.map) {
          sunLight.shadowLight.shadow.map.dispose();
          sunLight.shadowLight.shadow.map = null;
        }
      }
    }

    renderer.shadowMap.needsUpdate = true;
  }

  applySpotShadowState({ disposeMaps: true });

  // Toggle with P
  const sunLightToggle = { on: true, saved: sunLight.intensity };
  addEventListener("keydown", (e) => {
    if (e.code !== "KeyP") return;
    if (sunLightToggle.on) {
      sunLightToggle.saved = sunLight.intensity;
      sunLight.intensity = 0;
      sunLight.syncSpotIntensity();
      sunLightToggle.on = false;
    } else {
      sunLight.intensity = sunLightToggle.saved;
      sunLight.syncSpotIntensity();
      sunLightToggle.on = true;
    }
  });

  const SPL_SHADOW_BUBBLE_RADIUS = 300.0;
  let _splAngle = null;
  function updateSunSuperPointLight(sunPosW, cameraPosW, dt, tmp) {
    sunLight.position.copy(sunPosW);

    const spot = sunLight.shadowLight;

    // Aim the focused shadow cone at the camera. The shadow map only needs to
    // cover the local gameplay bubble, not tens of kilometres between the sun
    // and the player.
    tmp.vA.copy(cameraPosW);
    sunLight.worldToLocal(tmp.vA);
    spot.target.position.copy(tmp.vA);

    // Keep matrices current so shadow pass uses latest target/frustum
    sunLight.updateMatrixWorld(true);
    spot.updateMatrixWorld(true);
    spot.target.updateMatrixWorld(true);

    // Auto half-angle: radius = tan(angle) * distance => angle = atan(radius / distance)
    const d = Math.max(0.001, sunPosW.distanceTo(cameraPosW));
    const desiredRadius = SPL_SHADOW_BUBBLE_RADIUS;
    const maxA = THREE.MathUtils.degToRad(89.0);
    const minA = THREE.MathUtils.degToRad(0.05);
    const targetA = THREE.MathUtils.clamp(
      Math.atan(desiredRadius / d),
      minA,
      maxA,
    );

    // Smooth to avoid pops
    if (_splAngle === null) _splAngle = targetA;
    const alpha = 1.0 - Math.exp(-12.0 * Math.max(0.0, dt));
    _splAngle += (targetA - _splAngle) * alpha;

    // Tight depth window centered on the camera. Perspective shadow precision
    // depends heavily on near/far ratio; d +/- 300 m gives the focused map a
    // local ~600 m deep bubble instead of wasting precision on 50..45000 m.
    const shadowNear = Math.max(0.1, d - SPL_SHADOW_BUBBLE_RADIUS);
    const shadowFar = Math.max(shadowNear + 1.0, d + SPL_SHADOW_BUBBLE_RADIUS);
    const shadowCam = spot.shadow.camera;

    let spotProjectionDirty = false;
    if (Math.abs(spot.angle - _splAngle) > 1e-5) {
      spot.angle = _splAngle;
      spotProjectionDirty = true;
    }
    if (
      Math.abs(shadowCam.near - shadowNear) > 0.05 ||
      Math.abs(shadowCam.far - shadowFar) > 0.05
    ) {
      shadowCam.near = shadowNear;
      shadowCam.far = shadowFar;
      spotProjectionDirty = true;
    }
    if (spotProjectionDirty) shadowCam.updateProjectionMatrix();

    // Keep one analytic world-space occluder set for the PointLight/SpotLight
    // handoff. Unlike either shadow map, this list is not clipped by the focused
    // shadowCam.near/shadowCam.far window.
    updateSuperPointEclipseOccluders(sunPosW, cameraPosW, tmp);
  }

  ////////////////////////////////////////////////////////////////////////////////
  // Fullscreen tri + RT (log depth) + copy pass
  ////////////////////////////////////////////////////////////////////////////////
  const fsTri = createFullscreenTri(THREE);

  const screenCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  function makeRT(w, h) {
    const rtt = new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: true,
      stencilBuffer: false,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
    });

    rtt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    rtt.texture.generateMipmaps = false;

    rtt.depthTexture = new THREE.DepthTexture(w, h);
    rtt.depthTexture.format = THREE.DepthFormat;
    rtt.depthTexture.type = THREE.UnsignedIntType;

    return rtt;
  }

  function makeColorRT(w, h) {
    const rtt = new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: false,
      stencilBuffer: false,
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
    });

    rtt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    rtt.texture.minFilter = THREE.LinearFilter;
    rtt.texture.magFilter = THREE.LinearFilter;
    rtt.texture.generateMipmaps = false;

    return rtt;
  }

  // The underwater pass samples the fully composed, tone-mapped frame. An
  // RGBA8 target is sufficient here and avoids another full-resolution
  // half-float allocation while the player is submerged.
  function makeUnderwaterRT(w, h) {
    const rtt = new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: false,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
    });

    rtt.texture.colorSpace = THREE.LinearSRGBColorSpace;
    rtt.texture.minFilter = THREE.LinearFilter;
    rtt.texture.magFilter = THREE.LinearFilter;
    rtt.texture.generateMipmaps = false;

    return rtt;
  }

  function makeMaskRT(w, h) {
    const useR8 =
      renderer.capabilities.isWebGL2 &&
      typeof THREE.RedFormat !== "undefined";
    const rtt = new THREE.WebGLRenderTarget(w, h, {
      depthBuffer: false,
      stencilBuffer: false,
      type: THREE.UnsignedByteType,
      format: useR8 ? THREE.RedFormat : THREE.RGBAFormat,
    });

    // Cloud masks are scalar linear data. R8 avoids the bandwidth and storage
    // cost of the old RGBA16F target; WebGL1 keeps a safe RGBA8 fallback.
    if (useR8) rtt.texture.internalFormat = "R8";
    rtt.texture.colorSpace = THREE.NoColorSpace;
    rtt.texture.minFilter = THREE.LinearFilter;
    rtt.texture.magFilter = THREE.LinearFilter;
    rtt.texture.generateMipmaps = false;

    return rtt;
  }

  const _drawingBufferSize = new THREE.Vector2();
  renderer.getDrawingBufferSize(_drawingBufferSize);

  let rt = makeRT(innerWidth, innerHeight);
  let atmoRT = makeColorRT(
    Math.max(1, Math.floor(innerWidth * QUALITY_ATMO_SCALE)),
    Math.max(1, Math.floor(innerHeight * QUALITY_ATMO_SCALE)),
  );
  let cloudRT = makeMaskRT(
    Math.max(1, Math.floor(innerWidth * QUALITY_CLOUD_SCALE)),
    Math.max(1, Math.floor(innerHeight * QUALITY_CLOUD_SCALE)),
  );

  let ringDustRT = makeColorRT(
    Math.max(1, Math.floor(atmoRT.width * RING_DUST_SCALE)),
    Math.max(1, Math.floor(atmoRT.height * RING_DUST_SCALE)),
  );
  ringDustRT.texture.colorSpace = THREE.NoColorSpace;

  let godRayRT = makeColorRT(
    Math.max(1, Math.floor(_drawingBufferSize.x * QUALITY_GODRAY_SCALE)),
    Math.max(1, Math.floor(_drawingBufferSize.y * QUALITY_GODRAY_SCALE)),
  );
  godRayRT.texture.colorSpace = THREE.NoColorSpace;

  let underwaterRT = makeUnderwaterRT(rt.width, rt.height);

  // rt -> screen copy
  const { scene: copyScene, material: copyMat } = createCopyPass(
    THREE,
    fsTri,
    rt.texture,
    0.25,
  );

  // atmo overlay blit
  const { scene: atmoCopyScene, material: atmoCopyMat } = createAtmoCopyPass(
    THREE,
    fsTri,
    atmoRT.texture,
    0.25,
  );

  // Low-resolution volumetric passes are composited once after upsampling.
  const {
    scene: ringDustCompositeScene,
    material: ringDustCompositeMat,
  } = createTextureCompositePass(
    THREE,
    fsTri,
    ringDustRT.texture,
    THREE.NormalBlending,
  );
  const {
    scene: godRayCompositeScene,
    material: godRayCompositeMat,
  } = createTextureCompositePass(
    THREE,
    fsTri,
    godRayRT.texture,
    THREE.AdditiveBlending,
  );

  ////////////////////////////////////////////////////////////////////////////////
  // Galaxy sky dome (procedural)
  ////////////////////////////////////////////////////////////////////////////////
  function makeGalaxySkyDome(THREE) {
    const geo = new THREE.SphereGeometry(9000, 64, 32);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthTest: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0.0 },
        uBrightness: { value: 1.1 },
        uStarDensity: { value: 1.2 },
        uGalaxyStrength: { value: 1.15 },
        uBandStrength: { value: 1.35 },
        uBandTilt: { value: 0.45 },
      },
      vertexShader: `
varying vec3 vDirW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDirW = normalize(wp.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
      fragmentShader: `
precision highp float;
varying vec3 vDirW;

uniform float uTime;
uniform float uBrightness;
uniform float uStarDensity;
uniform float uGalaxyStrength;
uniform float uBandStrength;
uniform float uBandTilt;

float hash(vec3 p){
  p = fract(p * 0.3183099 + vec3(0.1,0.2,0.3));
  p *= 17.0;
  return fract(p.x*p.y*p.z*(p.x+p.y*p.z));
}
float noise(vec3 p){
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f*f*(3.0-2.0*f);

  float n000 = hash(i+vec3(0,0,0));
  float n100 = hash(i+vec3(1,0,0));
  float n010 = hash(i+vec3(0,1,0));
  float n110 = hash(i+vec3(1,1,0));
  float n001 = hash(i+vec3(0,0,1));
  float n101 = hash(i+vec3(1,0,1));
  float n011 = hash(i+vec3(0,1,1));
  float n111 = hash(i+vec3(1,1,1));

  float x00 = mix(n000,n100,f.x);
  float x10 = mix(n010,n110,f.x);
  float x01 = mix(n001,n101,f.x);
  float x11 = mix(n011,n111,f.x);

  float y0 = mix(x00,x10,f.y);
  float y1 = mix(x01,x11,f.y);
  return mix(y0,y1,f.z);
}
float fbm(vec3 p){
  float s=0.0, a=0.5;
  for(int i=0;i<5;i++){
    s += a*noise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return s;
}
vec3 rotX(vec3 v, float a){
  float s=sin(a), c=cos(a);
  return vec3(v.x, c*v.y - s*v.z, s*v.y + c*v.z);
}

void main() {
  vec3 d = normalize(vDirW);
  vec3 p = d * 180.0;

  float n  = noise(p * 2.3 + 19.0);
  float n2 = noise(p * 5.7 + 71.0);

  float stars = smoothstep(0.985, 1.0, n) * 1.2;
  stars += smoothstep(0.992, 1.0, n2) * 0.9;
  stars *= uStarDensity;

  float tw = 0.75 + 0.25*sin(uTime*2.0 + hash(p)*6.2831);
  stars *= tw;

  float tint = hash(p + 3.1);
  vec3 starCol = mix(vec3(0.75,0.85,1.0), vec3(1.0,0.9,0.8), tint);

  vec3 bt = rotX(d, uBandTilt);
  float band = 1.0 - abs(bt.y);
  band = pow(band, 6.0);
  float dust = fbm(bt*8.0 + vec3(0.0, uTime*0.01, 0.0));
  float bandMask = band * (0.45 + 0.75*dust);
  bandMask *= uBandStrength;

  float g1 = fbm(d*3.0 + vec3(20.0,0.0,0.0));
  float g2 = fbm(d*6.0 + vec3(-7.0,11.0,0.0));
  float gal = smoothstep(0.62, 0.95, g1) * 0.6 + smoothstep(0.68, 0.98, g2) * 0.45;
  gal *= uGalaxyStrength;

  vec3 bandCol = vec3(0.65, 0.75, 1.0);
  vec3 nebCol  = vec3(0.85, 0.55, 1.0);

  vec3 col = vec3(0.0);
  col += starCol * stars * 1.25;
  col += bandCol * bandMask * 0.45;
  col += nebCol * gal * 0.20;
  col += vec3(0.01, 0.012, 0.02);

  float vign = 0.75 + 0.25 * (d.y*0.5 + 0.5);
  col *= vign;

  col *= uBrightness;
  gl_FragColor = vec4(col, 1.0);
}`,
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -9999;
    return mesh;
  }
  const sky = makeGalaxySkyDome(THREE);
  scene.add(sky);

  ////////////////////////////////////////////////////////////////////////////////
  // Blue-noise texture + fallback
  ////////////////////////////////////////////////////////////////////////////////
  function makeFallbackNoiseTexture(size = 256) {
    const data = new Uint8Array(size * size * 4);
    for (let i = 0; i < size * size; i++) {
      const v = (Math.random() * 256) | 0;
      data[i * 4 + 0] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.needsUpdate = true;
    tex.colorSpace = THREE.NoColorSpace;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = false;
    tex.flipY = false;
    return tex;
  }
  let blueNoiseTex = makeFallbackNoiseTexture(256);
  let blueNoiseReady = false;
  // Expose blue-noise to other modules; keep it live even if the texture is replaced after async load.
  world.getBlueNoiseTex = () => blueNoiseTex;
  world.getBlueNoiseReady = () => blueNoiseReady;
  world.blueNoiseTex = blueNoiseTex;
  world.blueNoiseReady = blueNoiseReady;
  const BLUE_NOISE_URL =
    "https://raw.githubusercontent.com/Calinou/free-blue-noise-textures/master/256_256/HDR_RGBA_0.png";
  new THREE.TextureLoader().load(
    BLUE_NOISE_URL,
    (t) => {
      t.colorSpace = THREE.NoColorSpace;
      t.minFilter = THREE.NearestFilter;
      t.magFilter = THREE.NearestFilter;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.generateMipmaps = false;
      t.flipY = false;
      blueNoiseTex.dispose();
      blueNoiseTex = t;
      blueNoiseReady = true;
      world.blueNoiseTex = blueNoiseTex;
      world.blueNoiseReady = blueNoiseReady;
    },
    undefined,
    () => {
      blueNoiseReady = true;
      world.blueNoiseReady = blueNoiseReady;
    },
  );

  // One shared deterministic 3D-noise atlas for all volumetric materials.
  // This keeps the texture-backed cloud/ring/gas-giant shaders cheap without
  // allocating a separate atlas per body.
  const { texture: volumeNoiseTex, layout: volumeNoiseLayout } =
    createVolumeNoiseAtlas(THREE, (initialSeed ^ 0x71c3a9d5) >>> 0);
  const volumeNoiseUniforms = () =>
    makeVolumeNoiseUniforms(THREE, volumeNoiseTex, volumeNoiseLayout);
  world.volumeNoiseTex = volumeNoiseTex;
  world.volumeNoiseLayout = volumeNoiseLayout;

  // Clouds use their own channel-packed Perlin-Worley volume. WebGL2 gets a
  // native sampler3D path (one hardware-trilinear lookup); WebGL1 retains the
  // proven bordered 2D atlas path (two filtered lookups). `?cloudNoise=atlas`
  // is an explicit troubleshooting fallback without changing saved settings.
  let forceCloudAtlas = false;
  try {
    forceCloudAtlas =
      new URLSearchParams(window.location.search).get("cloudNoise") === "atlas";
  } catch {}

  let cloud3DCapable = false;
  if (
    !forceCloudAtlas &&
    renderer.capabilities.isWebGL2 &&
    typeof THREE.Data3DTexture === "function"
  ) {
    try {
      const gl = renderer.getContext();
      const max3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) || 0;
      cloud3DCapable = max3D >= VOLUME_NOISE_SIZE;
    } catch {
      cloud3DCapable = false;
    }
  }

  const {
    texture: cloudNoiseTex,
    texture3D: generatedCloudNoiseTex3D,
    layout: cloudNoiseLayout,
  } = createCloudNoiseAtlas(THREE, (initialSeed ^ 0x4f1bbcdc) >>> 0, {
    create3D: cloud3DCapable,
  });
  const cloudNoiseTex3D = generatedCloudNoiseTex3D || null;
  const useCloudNoise3D = cloud3DCapable && !!cloudNoiseTex3D;
  const cloudNoiseUniforms = () =>
    makeCloudNoiseUniforms(
      THREE,
      cloudNoiseTex,
      cloudNoiseLayout,
      cloudNoiseTex3D,
    );
  const cloudShaderDefines = useCloudNoise3D
    ? Object.freeze({ USE_CLOUD_NOISE_3D: 1 })
    : null;
  world.cloudNoiseTex = cloudNoiseTex;
  world.cloudNoiseTex3D = cloudNoiseTex3D;
  world.cloudNoiseLayout = cloudNoiseLayout;
  world.cloudNoiseMode = useCloudNoise3D ? "3d" : "atlas";

  ////////////////////////////////////////////////////////////////////////////////
  // Underwater post overlays
  const {
    scene: postScene,
    tintMat,
    particlesMat,
  } = createUnderwaterPost(
    THREE,
    fsTri,
    blueNoiseTex,
    underwaterRT.texture,
    rt.depthTexture,
  );

  ////////////////////////////////////////////////////////////////////////////////
  // God Rays pass (cloud-occluded)
  const { scene: godRayScene, material: godRayMat } = createGodRaysPass(
    THREE,
    fsTri,
    rt.depthTexture,
    cloudRT.texture,
    QUALITY_GODRAY_SAMPLES,
  );

  ////////////////////////////////////////////////////////////////////////////////
  // Create planets
  ////////////////////////////////////////////////////////////////////////////////
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seededHsl(seed, s, l) {
    const r = mulberry32(seed);
    const h = r();
    return new THREE.Color().setHSL(h, s, l).getHex();
  }

  const bodies = [];

  function makeColor(seed) {
    const r = ((seed * 16807) % 255) / 255;
    const g = ((seed * 48271) % 255) / 255;
    const b = ((seed * 69621) % 255) / 255;
    return new THREE.Color()
      .setRGB(0.35 + 0.55 * r, 0.35 + 0.55 * g, 0.35 + 0.55 * b)
      .getHex();
  }

  function makeOceanColor(seed) {
    const r = mulberry32(seed ^ 0x51f15e);
    // Keep ocean absorption in a believable blue/teal family. Per-planet
    // variation comes from hue, saturation, atmosphere reflection and murk,
    // rather than arbitrary red/yellow base colors.
    const hue = 0.50 + r() * 0.085;
    const saturation = 0.56 + r() * 0.22;
    const lightness = 0.18 + r() * 0.1;
    return new THREE.Color()
      .setHSL(hue, saturation, lightness)
      .getHex();
  }

  function makeOceanParams(seed) {
    const r = mulberry32(seed ^ 0x0ceaa11);
    return {
      oceanMurk: 0.46 + r() * 0.18,
      waveAmp: 1.8 + r() * 1.0,
      // The MdXyzX wave family starts with an internal phase multiplier of 6,
      // so these values produce a broad swell near 75-100 world units with
      // progressively smaller dragged octaves layered over it.
      waveFreq: 0.0105 + r() * 0.0035,
      waveSpeed: 0.42 + r() * 0.26,
      waveChoppiness: 0.90 + r() * 0.25,
      oceanWaveDrag: 0.044 + r() * 0.008,
      oceanWaveIterations: 14.0,
      oceanRoughness: 0.065 + r() * 0.040,
      oceanShallowOpacity: 0.52 + r() * 0.10,
      oceanDeepOpacity: 0.87 + r() * 0.06,
    };
  }

  ////////////////////////////////////////////////////////////////////////////////
  // Planet size archetypes (real-world-inspired) to increase size variety.
  // - Rocky planets pick from: Mercury, Earth, Kepler-22b
  // - Gas giants pick from: Neptune, Saturn, Jupiter
  // - Moons / dwarf planets pick from: Pluto, The Moon, Callisto
  // All values are in "pre-NMS scale" units and multiplied by NMS_RADIUS_SCALE later.
  const TERRESTRIAL_SIZE_UNITS = [850, 1350, 2400]; // Mercury, Earth, Kepler-22b
  const GAS_GIANT_SIZE_UNITS = [3000, 3800, 4400]; // Neptune, Saturn, Jupiter
  const MOON_DWARF_SIZE_UNITS = [260, 365, 510]; // Pluto, Moon, Callisto (Earth~1350)

  function pickFromArray(seed, arr, jitter = 0.12) {
    const r = mulberry32(seed ^ 0x9e3779b9);
    const idx = Math.min(arr.length - 1, Math.floor(r() * arr.length));
    const j = 1.0 - jitter + r() * (jitter * 2.0);
    return arr[idx] * j;
  }

  function addPlanet(cfg) {
    const p = new QuadSphereBody({
      ...cfg,
      terrainPatchBudget:
        cfg.terrainPatchBudget ?? getPreset(currentQuality).terrainPatchBudget,
      cloudNoiseTexture: cloudNoiseTex,
      cloudNoiseLayout,
    });
    // Terrain patches can stream in after the system finalizes; patch the shared material now
    // so it always uses the SuperPointLight mask (prevents double lighting from point+spot).
    try {
      for (const material of p.terrainMaterials ?? [p.terrainMat]) {
        registerSPLMaterial(material, sunLight);
      }
    } catch (e) {
      // ignore
    }
    system.add(p.group);
    p.index = bodies.length;
    bodies.push(p);
    return p;
  }

  function addGasGiant(cfg) {
    const p = new GasGiantBody({
      ...cfg,
      volumeNoiseTexture: volumeNoiseTex,
      volumeNoiseLayout,
    });
    system.add(p.group);
    p.index = bodies.length;
    bodies.push(p);
    return p;
  }

  ////////////////////////////////////////////////////////////////////////////////
  // MOONS: mini-planets (generated terrain + player latch) BUT no atmospheres, no oceans
  ////////////////////////////////////////////////////////////////////////////////

  const moons = [];

  ////////////////////////////////////////////////////////////////////////////////
  // ASTEROID BELT: batched InstancedMesh segments (built per-system)
  ////////////////////////////////////////////////////////////////////////////////

  let asteroidBelt = null;
  let asteroidBeltSpec = null; // saved layout (so quality changes can rebuild density)

  ////////////////////////////////////////////////////////////////////////////////
  // PLANET RINGS: small "mini belts" parented to some planets
  ////////////////////////////////////////////////////////////////////////////////

  const planetRings = [];

  // Ring-dust settings (tweakable via sliders in the Options menu).
  // These are applied to all planet rings and also used when building new rings.
  let ringDustParams = {
    opacity: 0.65,
    fade: 0.1,
    brightness: 1.85,
    noiseScale: 0.00012,
    windSpeed: 0.035,
    eclipseSoftness: 0.015,
    eclipseStrength: 1.0,
  };

  function applyRingDustParamsToRing(ring) {
    if (!ring || !ring.dustMats || !ring.dustMats.length) return;
    for (let i = 0; i < ring.dustMats.length; i++) {
      const m = ring.dustMats[i];
      const u = m?.uniforms;
      if (!u) continue;
      if (u.uOpacity) u.uOpacity.value = ringDustParams.opacity;
      if (u.uFade) u.uFade.value = Math.max(0.001, ringDustParams.fade);
      if (u.uNoiseScale) u.uNoiseScale.value = ringDustParams.noiseScale;
      if (u.uWindSpeed) u.uWindSpeed.value = ringDustParams.windSpeed;
      if (u.uEclipseSoftness)
        u.uEclipseSoftness.value = ringDustParams.eclipseSoftness;
      if (u.uEclipseStrength)
        u.uEclipseStrength.value = ringDustParams.eclipseStrength;
      // Brightness: re-apply while preserving the base tint.
      if (u.uColor && m.userData?.baseColor) {
        u.uColor.value
          .copy(m.userData.baseColor)
          .multiplyScalar(Math.max(0.0, ringDustParams.brightness));
        m.userData.brightness = ringDustParams.brightness;
      }
    }
  }

  function setRingDustParams(p = {}) {
    ringDustParams = {
      ...ringDustParams,
      ...p,
    };
    // Apply to post-process ring dust pass immediately.
    try {
      if (ringDustPass?.uniforms) {
        const u = ringDustPass.uniforms;
        if (u.uOpacity) u.uOpacity.value = ringDustParams.opacity;
        if (u.uFade) u.uFade.value = Math.max(0.001, ringDustParams.fade);
        if (u.uNoiseScale) u.uNoiseScale.value = ringDustParams.noiseScale;
        if (u.uWindSpeed) u.uWindSpeed.value = ringDustParams.windSpeed;
        if (u.uEclipseSoftness)
          u.uEclipseSoftness.value = ringDustParams.eclipseSoftness;
        if (u.uEclipseStrength)
          u.uEclipseStrength.value = ringDustParams.eclipseStrength;
      }
    } catch (e) {
      // ignore
    }
    // Legacy mesh-ring dust (no longer used for planet rings) kept for safety.
    for (let i = 0; i < planetRings.length; i++) {
      applyRingDustParamsToRing(planetRings[i]);
    }
  }

  function asteroidCountForQuality(q) {
    switch (q) {
      case "Potato":
        return 2000;
      case "Laptop":
        return 6000;
      case "Descktop":
      case "Desktop":
        return 15000;
      case "GamingPC":
        return 18000;
      case "NASA":
        return 24000;
      default:
        return 15000;
    }
  }

  function ringAsteroidCountForQuality(q) {
    // Planet rings are smaller than the system belt.
    // Keep these numbers modest; rings can exist on multiple planets.
    switch (q) {
      case "Potato":
        return 300;
      case "Laptop":
        return 700;
      case "Descktop":
      case "Desktop":
        return 1400;
      case "GamingPC":
        return 1800;
      case "NASA":
        return 2400;
      default:
        return 1400;
    }
  }

  function asteroidRockDetailForQuality(q) {
    switch (q) {
      case "Potato":
        return 0;
      case "Laptop":
      case "Descktop":
      case "Desktop":
        return 1;
      case "GamingPC":
      case "NASA":
        return 2;
      default:
        return 1;
    }
  }

  function computeRingSpecForPlanet(seed, baseRadius, index) {
    const s = (seed ?? 1) >>> 0;
    const R = Math.max(200, baseRadius ?? 1400);
    const rnd = mulberry32((s ^ 0x72a1d33b ^ (index * 0x9e3779b9)) >>> 0);

    // Larger planets are more likely to have rings.
    const sizeT = THREE.MathUtils.clamp((R - 1200) / 800, 0.0, 1.0);
    const chance = 0.12 + 0.3 * sizeT;
    if (rnd() >= chance) return null;

    // Ring radii relative to planet radius.
    const innerMul = 1.65 + rnd() * 0.85;
    const widthMul = 0.35 + rnd() * 0.95;
    const outerMul = innerMul + widthMul;

    // Thin ring plane, with slight thickness for volumetric feel.
    const thickness = Math.max(18, R * (0.025 + rnd() * 0.045));

    // Orientation variety.
    const yaw = rnd() * Math.PI * 2;
    const tilt = (rnd() * 2 - 1) * 0.28;
    const roll = (rnd() * 2 - 1) * 0.12;

    // Ring palette: varied (icy, dusty, rusty, etc.) and slightly desaturated
    // so it still reads as rocky material. Dust is tinted from the same base.
    const h = ((s >>> 9) & 255) / 255;
    const sat = 0.18 + (((s >>> 17) & 255) / 255) * 0.32;
    const lit = 0.34 + (((s >>> 25) & 255) / 255) * 0.26;
    const c = new THREE.Color().setHSL(h, sat, lit);
    c.lerp(new THREE.Color(0x777777), 0.35);
    const baseColor = c.getHex();

    return { innerMul, outerMul, thickness, yaw, tilt, roll, baseColor };
  }

  function disposePlanetRings() {
    while (planetRings.length) {
      const r = planetRings.pop();
      if (!r) continue;
      try {
        if (r.group?.parent) r.group.parent.remove(r.group);
        r.dispose?.();
      } catch (e) {
        console.warn("planet ring dispose failed:", e);
      }
    }
  }

  function buildPlanetRingForBody(p, index) {
    if (!p?.group || !p?.cfg) return null;
    const spec = p.cfg.ringSpec;
    if (!spec) return null;

    const total = ringAsteroidCountForQuality(currentQuality);
    const segments = Math.max(6, Math.min(16, Math.round(total / 180)));
    const rockDetail = asteroidRockDetailForQuality(currentQuality);

    const ring = createPlanetRing({
      superPointLight: sunLight,
      seed: ((p.cfg.seed ?? 1) ^ 0x52b7e11d) >>> 0,
      planetGroup: p.group,
      planetRadius: p.cfg.baseRadius ?? 1400,
      innerMul: spec.innerMul,
      outerMul: spec.outerMul,
      thickness: spec.thickness,
      yaw: spec.yaw,
      tilt: spec.tilt,
      roll: spec.roll,
      segments,
      asteroidsTotal: total,
      // Let the ring be visible from orbit distances, but cull when far.
      maxVisibleDist: Math.max(22000, (p.cfg.baseRadius ?? 1400) * 160 + 12000),
      baseColor: spec.baseColor,
      // Ring dust knobs (tweakable via Options sliders)
      dustOpacity: ringDustParams.opacity,
      dustInnerFade: ringDustParams.fade,
      dustBrightness: ringDustParams.brightness,
      dustNoiseScale: ringDustParams.noiseScale,
      dustWindSpeed: ringDustParams.windSpeed,
      dustEclipseSoftness: ringDustParams.eclipseSoftness,
      dustEclipseStrength: ringDustParams.eclipseStrength,
      rockDetail,
      noiseTex: blueNoiseTex,
      buildNow: true,
    });

    // Link the ring to its owning body so systems (e.g. eclipse masks)
    // can build occluder lists relative to the correct origin.
    ring.body = p;

    // Patch ring materials so the SPL doesn't double-illuminate (point + spot)
    try {
      registerSPLMaterialsIn(ring.group, sunLight);
    } catch (e) {
      // ignore
    }

    planetRings.push(ring);
    return ring;
  }

  function rebuildPlanetRingsFromBodies() {
    disposePlanetRings();
    for (let i = 0; i < bodies.length; i++) {
      buildPlanetRingForBody(bodies[i], i);
    }
  }

  function computeAsteroidBeltSpec(systemSeed) {
    const seed = (systemSeed ?? 101010) >>> 0;
    // Place belt roughly between planet 3 and 4 (baseOrbit + 2.5*orbitStep), with small seeded variation.
    const center =
      baseOrbit + orbitStep * 2.5 + (((seed >>> 7) & 1023) - 512) * 0.55;
    const width = 2400 + (((seed >>> 17) & 1023) - 512) * 0.6;
    const innerRadius = Math.max(5000, center - width * 0.5);
    const outerRadius = center + width * 0.5;
    const thickness = 260 + (((seed >>> 21) & 255) / 255) * 320;
    const tilt = 0.07 + (((seed >>> 3) & 255) / 255) * 0.22;
    // Keep asteroids in the same neutral/rocky range as moons (avoid green tints).
    const baseColor = 0x545454 + ((seed >>> 2) & 31) * 0x010101;

    return {
      seed,
      innerRadius,
      outerRadius,
      thickness,
      tilt,
      baseColor,
      // Procedural belts keep their original visibility budget.
      maxVisibleDist: 52000 * NMS_ORBIT_SCALE,
    };
  }

  function rebuildAsteroidBelt({ seed, buildNow = true } = {}) {
    const sysSeed = (seed ?? currentSystemSeed ?? 101010) >>> 0;
    const spec = asteroidBeltSpec ?? computeAsteroidBeltSpec(sysSeed);
    asteroidBeltSpec = spec;

    // dispose old
    if (asteroidBelt) {
      try {
        if (asteroidBelt.group?.parent)
          asteroidBelt.group.parent.remove(asteroidBelt.group);
        asteroidBelt.dispose?.();
      } catch (e) {
        console.warn("asteroidBelt dispose failed:", e);
      }
      asteroidBelt = null;
      world.asteroidBelt = null;
    }

    const total = asteroidCountForQuality(currentQuality);
    const segments = Math.max(12, Math.min(32, Math.round(total / 500)));

    const rockDetail = asteroidRockDetailForQuality(currentQuality);

    asteroidBelt = createAsteroidBelt({
      superPointLight: sunLight,
      ...spec,
      noiseTex: blueNoiseTex,
      // Use the atmosphere-style belt dust pass (screen-space).
      // Disable the old mesh-based dust volume to avoid confusion.
      cosmicDust: false,
      // Also disable the cheap geometry ring; it can show polygon edges at huge scales.
      dustRing: false,
      rockDetail,
      dustOpacity: 0.12,
      segments,
      asteroidsTotal: total,
      buildNow,
    });
    system.add(asteroidBelt.group);
    // Patch all lit materials inside the belt so the SuperPointLight doesn't
    // double-illuminate them (point + spot).
    try {
      registerSPLMaterialsIn(asteroidBelt.group, sunLight);
    } catch (e) {
      // ignore
    }
    world.asteroidBelt = asteroidBelt;
    return asteroidBelt;
  }

  function addMoonForPlanet(parentIndex, cfg = {}) {
    const parent = bodies[parentIndex];
    if (!parent) return null;

    const parentR = parent.baseRadius ?? parent.cfg?.baseRadius ?? 1400;

    const rr = mulberry32(
      (((parent.cfg?.seed ?? 101010) ^ (parentIndex * 99991) ^ 0xa5a5a5a5) >>>
        0) |
        0,
    );

    // Default moon sizing uses real-world-inspired dwarf/moon archetypes.
    // Keep moons meaningfully smaller than their parent, with a safety clamp.
    const _pickedMoonR =
      pickFromArray(
        (parent.cfg?.seed ?? 101010) ^ (parentIndex * 1337) ^ 0x55aa33cc,
        MOON_DWARF_SIZE_UNITS,
        0.1,
      ) * NMS_RADIUS_SCALE;

    const radius =
      cfg.radius ??
      Math.min(parentR * 0.45, Math.max(120 * NMS_RADIUS_SCALE, _pickedMoonR));

    const orbitDist =
      cfg.orbitDist ??
      parentR * (2.2 + 2.6 * rr()) + radius * (3.8 + 1.2 * rr());

    const orbitSpeed = cfg.orbitSpeed ?? 0.22 / orbitDist;
    const phase = cfg.phase ?? rr() * Math.PI * 2;

    const seedBase = (parent.cfg?.seed ?? 101010) | 0;
    const seed =
      ((seedBase ^ ((radius * 1000) | 0) ^ ((orbitDist * 10) | 0)) >>> 0) | 0;

    const moonCfg = {
      name: cfg.name ?? "MOON",
      seed,
      baseRadius: radius,

      // terrain
      heightAmp: cfg.heightAmp ?? Math.max(8.0, radius * 0.1),
      heightFreq: cfg.heightFreq ?? 2.0 + 2.0 * Math.random(),
      color: cfg.color ?? 0xb9b9b9,

      // IMPORTANT: moons have NO ocean and NO atmo
      hasOcean: false,
      hasAtmo: false,
      seaLevelOffset: -1e9,

      // LOD tuning for small bodies
      patchGridN: cfg.patchGridN ?? 10,
      maxLevel: cfg.maxLevel ?? 7,
      splitBudgetPerFrame: cfg.splitBudgetPerFrame ?? 4,
      mergeBudgetPerFrame: cfg.mergeBudgetPerFrame ?? 4,
      baseSplitFactor: cfg.baseSplitFactor ?? 9.2,
      baseMergeFactor: cfg.baseMergeFactor ?? 14.2,
      farDetail: cfg.farDetail ?? 2,
      activeDist: cfg.activeDist ?? radius * 30.0,
      lodDist: cfg.lodDist ?? radius * 22.0,
      nodeCullFactor: cfg.nodeCullFactor ?? 2.2,

      // orbit around the parent (we parent the group to the planet group)
      orbitDist,
      orbitSpeed,
      phase,
      // force a rocky/gray palette
      grass: 0x6a6a6a, // was green
      sand: 0x707070,
      rock: 0x5a5a5a,
      snow: 0x9a9a9a,

      rockStart: 0.0,
      rockSpan: 1e9,
    };

    const moon = new QuadSphereBody({
      ...moonCfg,
      terrainPatchBudget:
        cfg.terrainPatchBudget ?? getPreset(currentQuality).terrainPatchBudget,
      cloudNoiseTexture: cloudNoiseTex,
      cloudNoiseLayout,
    });

    // Same as planets: ensure the shared terrain material is SPL-masked even if patches
    // stream in after finalization.
    try {
      for (const material of moon.terrainMaterials ?? [moon.terrainMat]) {
        registerSPLMaterial(material, sunLight);
      }
    } catch (e) {
      // ignore
    }

    // Parent under the planet so orbit is local to the planet
    parent.group.add(moon.group);

    moon.index = bodies.length;
    bodies.push(moon);
    moons.push(moon);

    return moon;
  }

  // Moons are updated via the same bodies loop
  function updateMoons(dt) {}

  // Orbits scaled to match the "NMS" feel.
  const baseOrbit = 6800 * NMS_ORBIT_SCALE;
  const orbitStep = 3600 * NMS_ORBIT_SCALE;

  let currentSystemSeed = 101010;

  // ============================================================================
  // Async-friendly system transition (warp rebuild)
  // - Never blocks a frame: clears and rebuilds the system in small per-frame steps.
  // - Keeps the warp overlay animating smoothly while old content is disposed and
  //   the new star system is constructed.
  // ============================================================================

  let _systemTransition = null;
  // Hook: set by main.js to allow the player controller to decide how/where to spawn after a warp.
  let _onPlacePlayerNearNewStar = null;

  function setOnPlacePlayerNearNewStar(fn) {
    _onPlacePlayerNearNewStar = typeof fn === "function" ? fn : null;
  }

  function _disposeObjectTree(root) {
    if (!root) return;
    try {
      root.traverse?.((obj) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          if (Array.isArray(obj.material))
            obj.material.forEach((mm) => mm.dispose?.());
          else obj.material.dispose?.();
        }
      });
    } catch (e) {
      // best-effort; never allow disposal to kill the frame
      console.warn("disposeObjectTree failed:", e);
    }
  }

  function _makePlanetConfigs(baseSeed) {
    const seed0 = (baseSeed ?? 101010) >>> 0;
    const out = [];
    const planetCount = 8;
    const gasGiantIndex = 2 + ((seed0 >>> 0) % Math.max(1, planetCount - 2));
    for (let i = 0; i < planetCount; i++) {
      const seed = (seed0 + i * 99991) >>> 0;
      if (i === gasGiantIndex) {
        const baseRadius =
          pickFromArray(seed, GAS_GIANT_SIZE_UNITS, 0.1) * NMS_RADIUS_SCALE;
        const atmoTint = seededHsl(seed ^ 0x13579b, 0.62, 0.58);
        out.push({
          type: "gasGiant",
          name: `GASGIANT-${String(i + 1).padStart(2, "0")}`,
          seed,
          baseRadius,
          orbitDist: baseOrbit + i * orbitStep + ((seed % 500) - 250),
          orbitSpeed: 0.004 + 1.0 / ((baseOrbit + i * orbitStep) * 1.8),
          patchGridN: 0,
          maxLevel: 0,
          splitBudgetPerFrame: 0,
          mergeBudgetPerFrame: 0,
          farDetail: 0,
          activeDist: baseRadius * 34.0,
          lodDist: baseRadius * 26.0,
          nodeCullFactor: 0.0,
          hasOcean: false,
          hasAtmo: true,
          hasClouds: false,
          atmoTint,
          cloudTint: 0xffffff,
          ringSpec: null,
        });
        continue;
      }
      const baseRadius =
        pickFromArray(seed, TERRESTRIAL_SIZE_UNITS, 0.12) * NMS_RADIUS_SCALE;
      const heightAmp = (120 + ((seed >> 9) % 150)) * NMS_RADIUS_SCALE;
      const heightFreq = 1.6 + (((seed >> 5) % 100) / 100) * 1.2;
      const color = makeColor(seed);
      const oceanColor = makeOceanColor(seed ^ 0xabcdef);
      const oceanParams = makeOceanParams(seed);
      const atmoTint = seededHsl(seed ^ 0x13579b, 0.7, 0.55);
      const cloudTint = seededHsl(seed ^ 0x2468ac, 0.08, 0.97);

      out.push({
        name: `PLANET-${String(i + 1).padStart(2, "0")}`,
        seed,
        baseRadius,
        heightAmp,
        heightFreq,
        color,
        oceanColor,
        ...oceanParams,
        seaLevelOffset: 0,
        seabedDepth: heightAmp * 0.2,
        shoreWidth: 24 * NMS_RADIUS_SCALE,
        snowHeight: heightAmp * 0.62,
        snowLat: 0.52,
        deepWater: 0x061a2a,
        shallowWater: 0x1f5568,
        sand: 0xd9c38a,
        grass: 0x2f6b34,
        rock: 0x666666,
        snow: 0xf7fbff,
        orbitDist: baseOrbit + i * orbitStep + ((seed % 500) - 250),
        orbitSpeed: 0.004 + 1.0 / ((baseOrbit + i * orbitStep) * 1.8),
        patchGridN: 10,
        maxLevel: 8,
        splitBudgetPerFrame: 6,
        mergeBudgetPerFrame: 6,
        baseSplitFactor: 9.2,
        baseMergeFactor: 14.2,
        farDetail: 2,
        activeDist: baseRadius * 26.0,
        lodDist: baseRadius * 18.0,
        nodeCullFactor: 2.2,
        atmoTint,
        cloudTint,
        // Optional planet rings (mini asteroid belts).
        ringSpec: computeRingSpecForPlanet(seed, baseRadius, i),
      });
    }
    return out;
  }

  function beginSystemTransitionForWarp(targetDesc) {
    const seed = ((targetDesc?.seed ?? 101010) >>> 0) >>> 0;
    _systemTransition = {
      active: true,
      stage: "clear", // clear | build | done
      target: targetDesc,
      seed,

      // build state
      didSun: false,
      planetCfgs: null,
      planetI: 0,

      // asteroid belt build (segment-by-segment)
      belt: null,
      beltStarted: false,

      moonPlanetI: 0,
      moonK: 0,
      moonCountForPlanet: 0,
      moonPlanetCount: 0,

      atmoBodies: null,
      atmoI: 0,

      didFinalize: false,
    };
  }

  function isSystemTransitionActive() {
    return !!_systemTransition?.active;
  }

  function tickSystemTransition() {
    const tr = _systemTransition;
    if (!tr || !tr.active) return;

    // Big-ops budget per frame (keep it conservative so warp never stutters)
    let ops = 0;
    const MAX_OPS = 1;

    while (ops < MAX_OPS && tr.active) {
      if (tr.stage === "clear") {
        // Asteroid belt (single grouped object)
        if (asteroidBelt) {
          try {
            if (asteroidBelt.group?.parent)
              asteroidBelt.group.parent.remove(asteroidBelt.group);
            asteroidBelt.dispose?.();
          } catch (e) {
            console.warn("asteroidBelt dispose failed:", e);
          }
          asteroidBelt = null;
          asteroidBeltSpec = null;
          world.asteroidBelt = null;
          ops++;
          continue;
        }

        // Planet rings (mini belts) - dispose before planets.
        if (planetRings.length) {
          const r = planetRings.pop();
          if (r) {
            try {
              if (r.group?.parent) r.group.parent.remove(r.group);
              r.dispose?.();
            } catch (e) {
              console.warn("planet ring dispose failed:", e);
            }
          }
          ops++;
          continue;
        }

        // Moons first (they're parented to planets)
        if (moons.length) {
          const m = moons.pop();
          if (m?.group?.parent) m.group.parent.remove(m.group);
          _disposeObjectTree(m?.group);
          ops++;
          continue;
        }

        // Atmosphere passes
        if (atmoPasses && atmoPasses.length) {
          const p = atmoPasses.pop();
          if (p) {
            atmoScene.remove(p.atmoMesh);
            atmoScene.remove(p.maskMesh);
            p.atmoMesh?.material?.dispose?.();
            p.maskMesh?.material?.dispose?.();
          }
          ops++;
          continue;
        }

        // Planets (and any remaining bodies)
        if (bodies.length) {
          const b = bodies.pop();
          if (b?.group) system.remove(b.group);
          // destroy cancels pending terrain jobs via PatchNode.disposeMesh
          b?.destroy?.();
          ops++;
          continue;
        }

        // Fully cleared
        moons.length = 0;
        planetRings.length = 0;
        bodies.length = 0;
        atmoPasses.length = 0;
        clearSPLMaterialRegistry();

        tr.stage = "build";
        tr.didSun = false;
        tr.planetCfgs = null;
        tr.planetI = 0;
        tr.belt = null;
        tr.beltStarted = false;
        tr.moonPlanetI = 0;
        tr.moonK = 0;
        tr.moonCountForPlanet = 0;
        tr.moonPlanetCount = 0;
        tr.atmoBodies = null;
        tr.atmoI = 0;
        tr.didFinalize = false;
        continue;
      }

      if (tr.stage === "build") {
        // Sun tint variation (subtle) - mirrors buildSystemFromSeed
        if (!tr.didSun) {
          currentSystemSeed = tr.seed;
          const tint = seededHsl(currentSystemSeed ^ 0x5a17c3, 0.55, 0.62);
          sun.material.color.setHex(tint);
          sun.material.emissive.setHex(tint);
          sun.material.emissiveIntensity =
            8.0 + ((currentSystemSeed & 255) / 255) * 4.0;
          tr.didSun = true;
          ops++;
          continue;
        }

        // Planets: build one per frame
        if (!tr.planetCfgs) tr.planetCfgs = _makePlanetConfigs(tr.seed);
        if (tr.planetI < tr.planetCfgs.length) {
          const cfg = tr.planetCfgs[tr.planetI++];
          const p =
            cfg?.type === "gasGiant" ? addGasGiant(cfg) : addPlanet(cfg);
          // Optional planet rings: build alongside planet creation.
          buildPlanetRingForBody(p, (p?.index ?? bodies.length - 1) | 0);
          ops++;
          continue;
        }

        // Asteroid belt: build batches segment-by-segment (keeps warp smooth)
        if (!tr.beltStarted) {
          currentSystemSeed = tr.seed;
          const spec = computeAsteroidBeltSpec(tr.seed);
          asteroidBeltSpec = spec;

          const total = asteroidCountForQuality(currentQuality);
          const segments = Math.max(
            12,
            Math.min(32, Math.round(total / 500)),
          );

          const rockDetail = asteroidRockDetailForQuality(currentQuality);

          tr.belt = createAsteroidBelt({
            superPointLight: sunLight,
            ...spec,
            noiseTex: blueNoiseTex,
            cosmicDust: false,
            dustRing: false,
            dustOpacity: 0.12,
            rockDetail,
            segments,
            asteroidsTotal: total,
            buildNow: false,
          });
          system.add(tr.belt.group);
          // Patch belt materials so the SPL doesn't double-illuminate (point + spot)
          try {
            registerSPLMaterialsIn(tr.belt.group, sunLight);
          } catch (e) {
            // ignore
          }
          asteroidBelt = tr.belt;
          world.asteroidBelt = asteroidBelt;
          tr.beltStarted = true;
          ops++;
          continue;
        }
        if (tr.belt && tr.belt.buildNext()) {
          ops++;
          continue;
        }

        // Moons: build one moon per frame (mirrors buildSystemFromSeed)
        if (tr.moonPlanetCount === 0) {
          tr.moonPlanetCount = bodies.length; // snapshot
          tr.moonPlanetI = 0;
          tr.moonK = 0;
          tr.moonCountForPlanet = 0;
        }
        if (tr.moonPlanetI < tr.moonPlanetCount) {
          const p = bodies[tr.moonPlanetI];
          if (!p) {
            tr.moonPlanetI++;
            tr.moonK = 0;
            tr.moonCountForPlanet = 0;
            continue;
          }
          if (tr.moonCountForPlanet === 0) {
            tr.moonCountForPlanet = 1 + ((p.cfg?.seed ?? 1) % 3);
            tr.moonK = 0;
          }

          if (tr.moonK < tr.moonCountForPlanet) {
            const R = p.cfg.baseRadius ?? 1400;
            const k = tr.moonK;
            addMoonForPlanet(tr.moonPlanetI, {
              radius: R * (0.1 + 0.04 * k),
              orbitDist: R * (2.8 + 0.9 * k) + 350,
              orbitSpeed: (0.35 + 0.12 * k) / (R * (2.8 + 0.9 * k) + 350),
              color: k % 2 === 0 ? 0xbdbdbd : 0x8f8f8f,
              phase: (k / Math.max(1, tr.moonCountForPlanet)) * Math.PI * 2,
            });
            tr.moonK++;
            ops++;
            continue;
          }

          // next planet
          tr.moonPlanetI++;
          tr.moonK = 0;
          tr.moonCountForPlanet = 0;
          continue;
        }

        // Atmospheres: build one pass per frame
        if (!tr.atmoBodies) {
          tr.atmoBodies = bodies.filter((b) => b.hasAtmo !== false);
          atmoPasses.length = 0;
          tr.atmoI = 0;
        }
        if (tr.atmoI < tr.atmoBodies.length) {
          atmoPasses.push(makeAtmoPassForBody(tr.atmoBodies[tr.atmoI++]));
          ops++;
          continue;
        }

        // Finalize once
        if (!tr.didFinalize) {
          applyQualityToAtmoPasses();
          clearSPLMaterialRegistry();
          registerSPLMaterialsIn(scene, sunLight, { skipRoot: sun });

          // Update galaxy-location marker
          const targetDesc = tr.target;
          if (targetDesc) {
            if (typeof targetDesc.gx === "number")
              galaxyPlayer.x = targetDesc.gx;
            if (typeof targetDesc.gz === "number")
              galaxyPlayer.z = targetDesc.gz;
            if (targetDesc.name) galaxyPlayer.name = targetDesc.name;
          }

          // Spawn close to the star (delegated to player controller)
          _onPlacePlayerNearNewStar?.(tr.target);

          tr.didFinalize = true;
          tr.stage = "done";
          ops++;
          continue;
        }
      }

      if (tr.stage === "done") {
        tr.active = false;
        _systemTransition = null;
        return;
      }

      // safety: if we end up here, break to avoid a spin
      break;
    }
  }

  function clearCurrentSystem() {
    // asteroid belt
    if (asteroidBelt) {
      try {
        if (asteroidBelt.group?.parent)
          asteroidBelt.group.parent.remove(asteroidBelt.group);
        asteroidBelt.dispose?.();
      } catch (e) {
        console.warn("asteroidBelt dispose failed:", e);
      }
      asteroidBelt = null;
      asteroidBeltSpec = null;
      world.asteroidBelt = null;
    }

    // planet rings
    disposePlanetRings();

    // moons first (they're parented to planets)
    for (const m of moons) {
      if (m.group?.parent) m.group.parent.remove(m.group);
      m.group?.traverse?.((obj) => {
        if (obj.geometry) obj.geometry.dispose?.();
        if (obj.material) {
          if (Array.isArray(obj.material))
            obj.material.forEach((mm) => mm.dispose?.());
          else obj.material.dispose?.();
        }
      });
    }
    moons.length = 0;

    // atmosphere passes
    if (atmoPasses && atmoPasses.length) {
      for (const p of atmoPasses) {
        atmoScene.remove(p.atmoMesh);
        atmoScene.remove(p.maskMesh);
        p.atmoMesh?.material?.dispose?.();
        p.maskMesh?.material?.dispose?.();
      }
    }
    atmoPasses.length = 0;

    // planets
    for (const b of bodies) {
      system.remove(b.group);
      b.destroy?.();
    }
    bodies.length = 0;
    clearSPLMaterialRegistry();
  }

  function buildSystemFromSeed(baseSeed) {
    _solarSecretActive = false;
    stopSecretMusic();

    currentSystemSeed = (baseSeed ?? 101010) >>> 0;

    // Sun tint variation (subtle)
    {
      const tint = seededHsl(currentSystemSeed ^ 0x5a17c3, 0.55, 0.62);
      sun.material.color.setHex(tint);
      sun.material.emissive.setHex(tint);
      sun.material.emissiveIntensity =
        8.0 + ((currentSystemSeed & 255) / 255) * 4.0;
    }

    // Planets
    const planetCount = 8;
    // Guarantee at least one gas giant per system (never planet 0 or 1 so the player can always spawn/land).
    const gasGiantIndex =
      2 + ((currentSystemSeed >>> 0) % Math.max(1, planetCount - 2));
    for (let i = 0; i < planetCount; i++) {
      const seed = (currentSystemSeed + i * 99991) >>> 0;
      // Gas giant variant (opaque collision-less sphere + cloudless atmosphere)
      if (i === gasGiantIndex) {
        const baseRadius =
          pickFromArray(seed, GAS_GIANT_SIZE_UNITS, 0.1) * NMS_RADIUS_SCALE;
        const atmoTint = seededHsl(seed ^ 0x13579b, 0.62, 0.58);
        addGasGiant({
          type: "gasGiant",
          name: `GASGIANT-${String(i + 1).padStart(2, "0")}`,
          seed,
          baseRadius,
          orbitDist: baseOrbit + i * orbitStep + ((seed % 500) - 250),
          orbitSpeed: 0.004 + 1.0 / ((baseOrbit + i * orbitStep) * 1.8),
          patchGridN: 0,
          maxLevel: 0,
          splitBudgetPerFrame: 0,
          mergeBudgetPerFrame: 0,
          farDetail: 0,
          activeDist: baseRadius * 34.0,
          lodDist: baseRadius * 26.0,
          nodeCullFactor: 0.0,
          hasOcean: false,
          hasAtmo: true,
          hasClouds: false,
          atmoTint,
          cloudTint: 0xffffff,
          ringSpec: null,
        });
        continue;
      }

      // Default rocky/ocean planet
      {
        const baseRadius =
          pickFromArray(seed, TERRESTRIAL_SIZE_UNITS, 0.12) * NMS_RADIUS_SCALE;
        const heightAmp = (120 + ((seed >> 9) % 150)) * NMS_RADIUS_SCALE;
        const heightFreq = 1.6 + (((seed >> 5) % 100) / 100) * 1.2;
        const color = makeColor(seed);
        const oceanColor = makeOceanColor(seed ^ 0xabcdef);
        const oceanParams = makeOceanParams(seed);

        const atmoTint = seededHsl(seed ^ 0x13579b, 0.7, 0.55);
        const cloudTint = seededHsl(seed ^ 0x2468ac, 0.08, 0.97);

        addPlanet({
          name: `PLANET-${String(i + 1).padStart(2, "0")}`,
          seed,
          baseRadius,
          heightAmp,
          heightFreq,
          color,
          oceanColor,
          ...oceanParams,
          seaLevelOffset: 0,
          seabedDepth: heightAmp * 0.2,
          shoreWidth: 24 * NMS_RADIUS_SCALE,
          snowHeight: heightAmp * 0.62,
          snowLat: 0.52,
          deepWater: 0x061a2a,
          shallowWater: 0x1f5568,
          sand: 0xd9c38a,
          grass: 0x2f6b34,
          rock: 0x666666,
          snow: 0xf7fbff,
          orbitDist: baseOrbit + i * orbitStep + ((seed % 500) - 250),
          orbitSpeed: 0.004 + 1.0 / ((baseOrbit + i * orbitStep) * 1.8),
          patchGridN: 10,
          maxLevel: 8,
          splitBudgetPerFrame: 6,
          mergeBudgetPerFrame: 6,
          baseSplitFactor: 9.2,
          baseMergeFactor: 14.2,
          farDetail: 2,
          activeDist: baseRadius * 26.0,
          lodDist: baseRadius * 18.0,
          nodeCullFactor: 2.2,
          atmoTint,
          cloudTint,
          // Optional planet rings (mini asteroid belts).
          ringSpec: computeRingSpecForPlanet(seed, baseRadius, i),
        });
      }
    }

    // Planet rings (mini belts) - build after planets exist.
    rebuildPlanetRingsFromBodies();

    // Asteroid belt (batched instancing)
    rebuildAsteroidBelt({ seed: currentSystemSeed, buildNow: true });

    // Moons
    const planetBodyCount = bodies.length; // snapshot before adding moons (moons push into bodies)
    for (let i = 0; i < planetBodyCount; i++) {
      const p = bodies[i];
      const R = p.cfg.baseRadius ?? 1400;
      const count = 1 + ((p.cfg.seed ?? 1) % 3); // 1..3

      for (let k = 0; k < count; k++) {
        addMoonForPlanet(i, {
          radius: R * (0.1 + 0.04 * k),
          orbitDist: R * (2.8 + 0.9 * k) + 350,
          orbitSpeed: (0.35 + 0.12 * k) / (R * (2.8 + 0.9 * k) + 350),
          color: k % 2 === 0 ? 0xbdbdbd : 0x8f8f8f,
          phase: (k / Math.max(1, count)) * Math.PI * 2,
        });
      }
    }

    // Patch lit materials so the PointLight doesn't double-light inside the sun spot cone
    clearSPLMaterialRegistry();
    registerSPLMaterialsIn(scene, sunLight, { skipRoot: sun });
  }

  // ============================================================================
  // Secret preset: "Solar" seed
  // - Roughly mirrors our Solar System (stylized to the game's scale)
  // - Earth + Moon are replaced by an asteroid belt at ~1 AU
  // ============================================================================

  function buildSolarSecretSystem(baseSeed) {
    // NOTE: Secret level logic lives in src/game/levels/solarSecret.js
    // so you can tune it without touching procedural generation.
    buildSolarSecretSystemLevel(
      {
        NMS_ORBIT_SCALE,
        NMS_RADIUS_SCALE,
        sun,
        galaxyPlayer,
        bodies,
        scene,
        sunLight,
        addPlanet,
        addGasGiant,
        rebuildPlanetRingsFromBodies,
        rebuildAsteroidBelt,
        addMoonForPlanet,
        clearSPLMaterialRegistry,
        registerSPLMaterialsIn,
        startSecretMusic,
        setSolarSecretActive: (v) => {
          _solarSecretActive = !!v;
        },
        setCurrentSystemSeed: (v) => {
          currentSystemSeed = (v ?? 0) >>> 0;
        },
        setAsteroidBeltSpec: (spec) => {
          asteroidBeltSpec = spec;
        },
      },
      baseSeed,
    );
  }

  function rebuildSystemForWarp(targetDesc) {
    // IMPORTANT: do not block the frame here.
    // During warp we keep the tunnel animating while we dispose and rebuild
    // the system over multiple frames.
    beginSystemTransitionForWarp(targetDesc);
  }

  // initial system
  if (initialPreset === "solar_secret") {
    buildSolarSecretSystem(initialSeed);
  } else {
    buildSystemFromSeed(initialSeed);
  }

  // Expose for UI/debug
  world.getCurrentSystemPreset = () => initialPreset;

  // Expose for UI/debug (e.g. to reflect the in-use seed).
  world.getCurrentSystemSeed = () => (currentSystemSeed ?? 0) >>> 0;

  ////////////////////////////////////////////////////////////////////////////////
  // Atmosphere + Clouds overlay (atmoRT) + cloud mask (cloudRT)
  // (atmoRT) + cloud mask (cloudRT)
  ////////////////////////////////////////////////////////////////////////////////
  const atmoScene = new THREE.Scene();
  const atmoVS = ATMO_VS;
  const atmoFS = ATMO_FS;
  const cloudMaskFS = makeCloudMaskFS();

  const MAX_OCCLUDERS = 24;
  const occluderCenters = new Float32Array(MAX_OCCLUDERS * 3);
  const occluderRadii = new Float32Array(MAX_OCCLUDERS);

  // Shared eclipse helpers (CPU side) for things that aren’t in the atmo shader
  // (e.g. underwater fog / post tint). Mirrors the GLSL in atmoFS.
  // Maximum absolute displacement of the 5-octave terrain FBM used by
  // QuadSphereBody (amp starts at 0.5 and uses gain 0.52). Keep this in sync
  // with TERRAIN_FBM_ABS_MAX in terrain/quadsphere.js.
  const ECLIPSE_TERRAIN_FBM_ABS_MAX =
    (0.5 * (1.0 - Math.pow(0.52, 5))) / (1.0 - 0.52);

  function bodyRadiusForEclipse(b) {
    const sl = b?.seaLevel;
    const br = b?.cfg?.baseRadius ?? b?.baseRadius;
    const baseRadius =
      typeof br === "number" && isFinite(br) && br > 0 ? br : 1400;

    // Airless moons use a negative sea-level sentinel, so using baseRadius alone
    // made their analytic SPL silhouette smaller than the actual displaced
    // terrain mesh. Expand moon occluders to the guaranteed outer terrain
    // envelope so the hard eclipse core agrees with the coarse shadow caster.
    if (moons.includes(b)) {
      const ha = Math.abs(Number(b?.heightAmp ?? b?.cfg?.heightAmp ?? 0.0));
      return baseRadius + ha * ECLIPSE_TERRAIN_FBM_ABS_MAX;
    }

    if (typeof sl === "number" && sl > 0) return sl;
    return baseRadius;
  }

  // Reused candidate records avoid allocating one object per body every frame.
  // The sort is relative to the centre of the focused shadow bubble, so if a
  // generated system ever exceeds the shader cap, bodies capable of eclipsing
  // this local region win over irrelevant distant bodies.
  const splEclipseCandidates = [];
  function updateSuperPointEclipseOccluders(sunPosW, focusPosW, tmp) {
    const eclipse = sunLight.eclipse;
    if (!eclipse) return;

    eclipse.sunPosW.copy(sunPosW);
    eclipse.sunRadius = SUN_RADIUS;

    const toSun = tmp.vB.copy(sunPosW).sub(focusPosW);
    const sunDistance = toSun.length();
    if (sunDistance <= 1e-6) {
      eclipse.count = 0;
      eclipse.radii.fill(0);
      return;
    }
    toSun.multiplyScalar(1.0 / sunDistance);

    let candidateCount = 0;
    for (let i = 0; i < bodies.length; i++) {
      const body = bodies[i];
      if (!body?.group) continue;

      const center = body.group.getWorldPosition(tmp.vA.set(0, 0, 0));
      const radius = bodyRadiusForEclipse(body);

      const dx = center.x - focusPosW.x;
      const dy = center.y - focusPosW.y;
      const dz = center.z - focusPosW.z;
      const along = dx * toSun.x + dy * toSun.y + dz * toSun.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      const perp = Math.sqrt(Math.max(0.0, distSq - along * along));
      const potentiallyBetween =
        along > -SPL_SHADOW_BUBBLE_RADIUS &&
        along < sunDistance + SPL_SHADOW_BUBBLE_RADIUS;

      // Include the finite solar disc and the whole local shadow bubble when
      // ranking relevance. Expand the along-range by the bubble depth as well:
      // an occluder just behind the camera can still lie between the sun and a
      // fragment at the back edge of the focused 600 m depth slab.
      const projectedAlong = THREE.MathUtils.clamp(along, 0.0, sunDistance);
      const projectedSunRadius = SUN_RADIUS * (projectedAlong / sunDistance);
      const influenceRadius =
        radius + projectedSunRadius + SPL_SHADOW_BUBBLE_RADIUS;
      const miss = Math.max(0.0, perp - influenceRadius);

      // This occluder set now feeds both sides of the PointLight/SpotLight
      // handoff, not just the 600 m spot shadow bubble. Do not hard-cull bodies
      // merely because their penumbra misses that local bubble: a fragment just
      // outside the focused cone still needs the same world-space eclipse answer.
      // The shader cap is handled by relevance sorting instead.
      const score =
        (potentiallyBetween ? 0.0 : 1000.0) +
        miss / Math.max(influenceRadius, 1e-5) +
        perp / Math.max(influenceRadius, 1e-5) +
        0.001 * (perp / Math.max(radius, 1e-5));

      let candidate = splEclipseCandidates[candidateCount];
      if (!candidate) {
        candidate = { x: 0, y: 0, z: 0, r: 0, score: 0 };
        splEclipseCandidates[candidateCount] = candidate;
      }
      candidate.x = center.x;
      candidate.y = center.y;
      candidate.z = center.z;
      candidate.r = radius;
      candidate.score = score;
      candidateCount++;
    }

    splEclipseCandidates.length = candidateCount;
    splEclipseCandidates.sort((a, b) => a.score - b.score);

    const maxCount = eclipse.radii.length;
    const n = Math.min(candidateCount, maxCount);
    eclipse.count = n;
    for (let i = 0; i < n; i++) {
      const candidate = splEclipseCandidates[i];
      const j = i * 3;
      eclipse.centers[j] = candidate.x;
      eclipse.centers[j + 1] = candidate.y;
      eclipse.centers[j + 2] = candidate.z;
      eclipse.radii[i] = candidate.r;
    }
    for (let i = n; i < maxCount; i++) eclipse.radii[i] = 0.0;
  }

  function raySphereHitCPU(ro, rd, c, r) {
    const ocx = ro.x - c.x;
    const ocy = ro.y - c.y;
    const ocz = ro.z - c.z;
    const b = ocx * rd.x + ocy * rd.y + ocz * rd.z;
    const c0 = ocx * ocx + ocy * ocy + ocz * ocz - r * r;
    let h = b * b - c0;
    if (h < 0) return 1e9;
    h = Math.sqrt(h);
    const t0 = -b - h;
    const t1 = -b + h;
    if (t0 > 0) return t0;
    if (t1 > 0) return t1;
    return 1e9;
  }

  function sunVisibilityCPU(pW, sunPosW, ignoreBody, tmp, softness, strength) {
    const toSun = tmp.vD.copy(sunPosW).sub(pW);
    const sunDistance = toSun.length();
    if (sunDistance <= 1e-6) return 1.0;
    const sunDirection = toSun.multiplyScalar(1.0 / sunDistance);

    let visibility = 1.0;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b || b === ignoreBody) continue;

      const c = b.group.getWorldPosition(tmp.vE.set(0, 0, 0));
      const occR = bodyRadiusForEclipse(b);
      const toOccX = c.x - pW.x;
      const toOccY = c.y - pW.y;
      const toOccZ = c.z - pW.z;
      const along =
        toOccX * sunDirection.x +
        toOccY * sunDirection.y +
        toOccZ * sunDirection.z;
      if (along <= 0.0 || along >= sunDistance) continue;

      const dx = toOccX - sunDirection.x * along;
      const dy = toOccY - sunDirection.y * along;
      const dz = toOccZ - sunDirection.z * along;
      const perp = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // Match the shared SPL shadow semantics: the centre ray is a hard
      // point-source core, while the finite solar disc supplies the penumbra.
      if (perp <= occR) {
        visibility = 0.0;
        break;
      }

      const projectedSunRadius = Math.max(
        SUN_RADIUS * (along / sunDistance),
        occR * Math.max(softness, 0.0001),
      );
      const outer = occR + projectedSunRadius;
      if (perp >= outer) continue;

      const inner = Math.abs(occR - projectedSunRadius);
      const overlap =
        1.0 -
        THREE.MathUtils.smoothstep(
          perp,
          inner,
          Math.max(inner + 1e-4, outer),
        );
      const maxCoverage =
        occR >= projectedSunRadius
          ? 1.0
          : THREE.MathUtils.clamp(
              (occR * occR) /
                Math.max(1e-5, projectedSunRadius * projectedSunRadius),
              0.0,
              1.0,
            );

      visibility = Math.min(visibility, 1.0 - overlap * maxCoverage);
    }

    return THREE.MathUtils.lerp(
      1.0,
      visibility,
      THREE.MathUtils.clamp(strength, 0.0, 1.0),
    );
  }

  // If some eclipses don't work, probably it went over the cap and got ignored
  function fillOccludersForBody(pass, outCenters, outRadii, tmp) {
    // Allow relevance sorting
    // using uniforms if available.
    const originW = pass?.mat?.uniforms?.uPlanetCenterW?.value;
    const sunPosW = pass?.mat?.uniforms?.uSunPosW?.value;

    // Use the same eclipse sphere definition as the shared SPL path, including
    // the conservative displaced-terrain envelope for airless moons.
    function bodyRadius(b) {
      return bodyRadiusForEclipse(b);
    }

    // If we can't get origin/sun, just fill sequentially (still with correct radii).
    const canSort =
      originW &&
      sunPosW &&
      typeof originW.x === "number" &&
      typeof sunPosW.x === "number";

    let rd = null,
      maxT = 0;
    if (canSort) {
      rd = tmp.vB.copy(sunPosW).sub(originW);
      maxT = rd.length();
      if (maxT > 1e-6) rd.multiplyScalar(1.0 / maxT);
      else rd = null;
    }

    // Build candidate occluders from `bodies` only.
    const cand = [];
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      if (!b || b === pass.body) continue;

      const c = b.group.getWorldPosition(tmp.vA.set(0, 0, 0));
      const r = bodyRadius(b);

      let score = i; // stable fallback ordering
      if (rd) {
        const dx = c.x - originW.x;
        const dy = c.y - originW.y;
        const dz = c.z - originW.z;

        const along = dx * rd.x + dy * rd.y + dz * rd.z; // projection on sun ray
        const v2 = dx * dx + dy * dy + dz * dz;
        const perp2 = Math.max(0, v2 - along * along);
        const perp = Math.sqrt(perp2);

        const between = along > 0.0 && along < maxT;

        // smaller = more relevant
        score = (between ? 0.0 : 1000.0) + perp / (r + 1e-6);
      }

      cand.push({ x: c.x, y: c.y, z: c.z, r, score });
    }

    if (rd) cand.sort((a, b) => a.score - b.score);

    const n = Math.min(outRadii?.length ?? MAX_OCCLUDERS, cand.length);
    for (let i = 0; i < n; i++) {
      const o = cand[i];
      outCenters[i * 3 + 0] = o.x;
      outCenters[i * 3 + 1] = o.y;
      outCenters[i * 3 + 2] = o.z;
      outRadii[i] = o.r;
    }

    return n;
  }

  function makeAtmoPassForBody(body) {
    const baseR = body.cfg.baseRadius;
    // Ocean vertices now sway within a conservative radial envelope. Use the
    // lowest possible trough as the atmospheric ground bound. Above water, scene
    // depth terminates at the displaced surface; underwater, the transparent
    // ocean stops writing depth and the shader starts at mean sea level instead.
    const oceanDisplacement = body?.oceanSurfaceDisplacement ?? 0.0;
    const groundR = body?.hasOcean
      ? Math.max(1.0, (body.seaLevel ?? baseR) - oceanDisplacement)
      : baseR;

    const u = {
      ...cloudNoiseUniforms(),
      // Explicitly select the stable combined atmosphere+cloud path. The
      // regression build split these into temporally blended screen-space
      // histories; this pass renders the current camera view in one draw.
      uRenderMode: { value: 0.0 },
      uInvViewMatrix: { value: new THREE.Matrix4() },
      uInvProjMatrix: { value: new THREE.Matrix4() },
      uDepthTex: { value: rt.depthTexture },
      uLogDepthFC: { value: 1.0 },

      uPlanetCenterW: { value: new THREE.Vector3() },
      uPlanetRadius: { value: baseR },
      uGroundRadius: { value: groundR },
      // Mean sea-level radius. A negative value marks an atmosphere with no
      // ocean. When the camera is submerged, the atmosphere shader begins its
      // integration just outside this surface instead of treating the water
      // column as air.
      uOceanRadius: {
        value: body?.hasOcean ? (body.seaLevel ?? baseR) : -1.0,
      },
      uAtmoHeight: { value: baseR * 0.33 },
      uSunPosW: { value: new THREE.Vector3() },
      uSunRadius: { value: SUN_RADIUS },
      // The opaque scene sun is intentionally veiled by dense daylight air.
      // Reconstruct a bright, eclipse-aware disc and halo in the atmosphere
      // pass so the star still punches through when viewed from the surface.
      uSurfaceSunDiscIntensity: {
        value: body.cfg.surfaceSunDiscIntensity ?? 18.0,
      },
      uSurfaceSunHaloIntensity: {
        value: body.cfg.surfaceSunHaloIntensity ?? 3.2,
      },

      uBlueNoiseTex: { value: blueNoiseTex },
      uBlueNoiseSize: { value: new THREE.Vector2(256, 256) },

      uAtmoSteps: { value: QUALITY_ATMO_STEPS },
      uAtmoDensity: { value: 0.24 },
      uAtmoScaleHeight: { value: 0.1 },
      uBlueStrength: { value: 0.4 },
      uSunsetStrength: { value: 0.45 },
      uSunGlare: { value: 0.02 },
      uNightDarken: { value: 3.2 },
      uMinLight: { value: 0.005 },
      // Day side should read less transparent than the rim.
      uDayOpacityBoost: { value: 2.1 },
      // Keep the host terrain readable while allowing sunlit air to strongly
      // veil unrelated background bodies. At 0.94 only about 6% of a distant
      // body remains before atmospheric colour and tone mapping are applied.
      uDaySurfaceOpacity: {
        value: body.cfg.atmoDaySurfaceOpacity ?? 0.84,
      },
      uDayBackgroundOpacity: {
        value: body.cfg.atmoDayBackgroundOpacity ?? 0.94,
      },

      uCloudBase: { value: baseR * 0.035 },
      uCloudThickness: { value: baseR * 0.06 },
      uCloudSteps: { value: QUALITY_CLOUD_STEPS },
      // The reference demo uses 0.5 density. Optical scales below make that
      // value portable across different planet and moon radii.
      uCloudDensity: { value: 0.50 },
      uCloudExtinctionScale: { value: 2.8 },
      uCloudLightExtinctionScale: { value: 2.5 },
      uCloudAmbientStrength: { value: 0.12 },
      uCloudCoverage: { value: 0.61 },
      uCloudSoftness: { value: 0.20 },
      // Approximate the repo's ~2.5 broad and ~10 detail cycles across a mass.
      uCloudFreq: { value: 9.0 },
      uCloudDetailFreq: { value: 64.0 },
      uCloudNoiseOffset: {
        value: (() => {
          const random = mulberry32(
            ((body?.cfg?.seed ?? 1) ^ 0x9e3779b9) >>> 0,
          );
          return new THREE.Vector3(
            random() * 13.0,
            random() * 13.0,
            random() * 13.0,
          );
        })(),
      },
      uCloudWindSpeed: { value: 0.025 },
      uCloudLightSteps: { value: QUALITY_CLOUD_LIGHT_STEPS },
      uCloudShadowStrength: { value: 0.85 },
      uCloudPhase: { value: 0.30 },
      // Updated every frame from projected cloud size and the active quality
      // step budget. Zero means base shape only; one enables full erosion detail.
      uCloudDetailLod: { value: 1.0 },
      uCloudMultiScatterStrength: { value: 0.20 },
      uCloudPowderStrength: { value: 0.44 },
      // One keeps conservative empty-space skipping enabled. Setting this to
      // zero restores fixed-step marching for visual A/B diagnostics.
      uCloudSkipStrength: { value: 1.0 },

      uUseCheapClouds: { value: 0.0 },
      uCheapCloudAlpha: { value: 0.26 },
      uCheapCloudScale: { value: 1.0 },
      uCheapCloudSharp: { value: 1.35 },
      uCheapCloudRim: { value: 0.52 },
      uCheapCloudFarBoost: { value: 0.0 },
      uCheapCloudContrast: { value: 1.0 },

      uAtmoTint: {
        value: new THREE.Color(body.cfg.atmoTint ?? 0x6aa8ff),
      },
      uCloudTint: {
        value: new THREE.Color(body.cfg.cloudTint ?? 0xffffff),
      },

      uTime: { value: 0.0 },

      uOccCount: { value: 0 },
      uOccCenters: { value: occluderCenters },
      uOccRadii: { value: occluderRadii },
      uEclipseSoftness: { value: 0.015 },
      uEclipseStrength: { value: 1.0 },
    };

    // Cloudless atmospheres (gas giants): leave the atmo shading but disable all cloud contribution.
    if (body?.isGasGiant || body?.cfg?.hasClouds === false) {
      u.uCloudDensity.value = 0.0;
      u.uCloudCoverage.value = 0.0;
      u.uCloudShadowStrength.value = 0.0;
      u.uUseCheapClouds.value = 0.0;
      u.uCheapCloudAlpha.value = 0.0;
    }

    const atmoMat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NormalBlending,
      defines: cloudShaderDefines ? { ...cloudShaderDefines } : undefined,
      uniforms: u,
      vertexShader: atmoVS,
      fragmentShader: atmoFS,
    });
    const atmoMesh = new THREE.Mesh(fsTri, atmoMat);
    atmoMesh.frustumCulled = false;
    atmoMesh.visible = false;
    atmoScene.add(atmoMesh);

    const maskMat = new THREE.ShaderMaterial({
      transparent: false,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      defines: cloudShaderDefines ? { ...cloudShaderDefines } : undefined,
      uniforms: u,
      vertexShader: atmoVS,
      fragmentShader: cloudMaskFS,
    });
    const maskMesh = new THREE.Mesh(fsTri, maskMat);
    maskMesh.frustumCulled = false;
    maskMesh.visible = false;
    atmoScene.add(maskMesh);

    return {
      body,
      atmoMesh,
      maskMesh,
      uniforms: u,
      _centerW: new THREE.Vector3(),
    };
  }
  let atmoPasses = bodies
    .filter((b) => b.hasAtmo !== false)
    .map(makeAtmoPassForBody);

  ////////////////////////////////////////////////////////////////////////////////
  // Asteroid belt dust (screen-space, atmosphere-style shader)
  ////////////////////////////////////////////////////////////////////////////////
  const beltDustUniforms = {
    uInvViewMatrix: { value: new THREE.Matrix4() },
    uInvProjMatrix: { value: new THREE.Matrix4() },
    uDepthTex: { value: rt.depthTexture },
    uLogDepthFC: { value: 1.0 },

    uBlueNoiseTex: { value: blueNoiseTex },
    uBlueNoiseSize: { value: new THREE.Vector2(256, 256) },

    uBeltInvMatrix: { value: new THREE.Matrix4() },
    uInnerR: { value: 12000.0 },
    uOuterR: { value: 14000.0 },
    uHalfHeight: { value: 280.0 },

    // Brighter bluish-gray so the dust band reads clearly over space.
    uDustTint: { value: new THREE.Color(0x92a7bb) },
    // Main visibility knob (cranked up by default).
    uDustDensity: { value: 24.0 },
    // More steps reduces banding when density is higher.
    uDustSteps: { value: 36.0 },
    uMaxDist: { value: 120000.0 },
    uNoiseScale: { value: 0.0035 },
    uTime: { value: 0.0 },
  };

  const beltDustMat = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms: beltDustUniforms,
    vertexShader: atmoVS,
    fragmentShader: BELT_DUST_FS,
  });
  const beltDustMesh = new THREE.Mesh(fsTri, beltDustMat);
  beltDustMesh.frustumCulled = false;
  beltDustMesh.visible = false;
  atmoScene.add(beltDustMesh);

  const beltDustPass = { mesh: beltDustMesh, uniforms: beltDustUniforms };

  ////////////////////////////////////////////////////////////////////////////////
  // Planet ring dust (screen-space, atmosphere-style post-process)
  ////////////////////////////////////////////////////////////////////////////////
  const _ringInvArr = Array.from({ length: 8 }, () => new THREE.Matrix4());
  const _ringInnerArr = new Float32Array(8);
  const _ringOuterArr = new Float32Array(8);
  const _ringHalfHArr = new Float32Array(8);
  const _ringSplitEnabledArr = new Float32Array(8);
  const _ringOwnerAtmoEnabledArr = new Float32Array(8);
  const _ringOwnerAtmoRadiusArr = new Float32Array(8);
  const _ringGlobalAtmoSplitArr = new Float32Array(8);
  const _ringOwnerCenterArr = Array.from(
    { length: 8 },
    () => new THREE.Vector3(),
  );
  const _ringGlobalAtmoCenterArr = Array.from(
    { length: 8 },
    () => new THREE.Vector3(),
  );
  const _ringGlobalAtmoRadiusArr = new Float32Array(8);
  const _ringTintArr = Array.from(
    { length: 8 },
    () => new THREE.Vector3(1, 1, 1),
  );

  const ringDustUniforms = {
    ...volumeNoiseUniforms(),
    uInvViewMatrix: { value: new THREE.Matrix4() },
    uInvProjMatrix: { value: new THREE.Matrix4() },
    uDepthTex: { value: rt.depthTexture },
    uLogDepthFC: { value: 1.0 },

    uBlueNoiseTex: { value: blueNoiseTex },
    uBlueNoiseSize: { value: new THREE.Vector2(256, 256) },

    uTime: { value: 0.0 },
    uMaxDist: { value: 140000.0 },

    uRingCount: { value: 0 },
    uRingInvMatrix: { value: _ringInvArr },
    uRingInner: { value: _ringInnerArr },
    uRingOuter: { value: _ringOuterArr },
    uRingHalfHeight: { value: _ringHalfHArr },
    // Planet rings are split around their centre plane so rear sections can be
    // composited below atmosphere and near sections above it. The system belt
    // remains unsplit and uses the established front layer.
    uRingSplitEnabled: { value: _ringSplitEnabledArr },
    // Owner-atmosphere data lets the shader decide front/back using the actual
    // view-ray entry into the atmosphere rather than a centre plane.
    uRingOwnerAtmoEnabled: { value: _ringOwnerAtmoEnabledArr },
    uRingOwnerAtmoRadius: { value: _ringOwnerAtmoRadiusArr },
    uRingOwnerCenterW: { value: _ringOwnerCenterArr },
    // System-scale asteroid dust has no single owner. It is split against the
    // actual atmospheric spheres it can pass behind in screen space.
    uRingGlobalAtmoSplit: { value: _ringGlobalAtmoSplitArr },
    uGlobalAtmoCount: { value: 0 },
    uGlobalAtmoCenterW: { value: _ringGlobalAtmoCenterArr },
    uGlobalAtmoRadius: { value: _ringGlobalAtmoRadiusArr },
    uLayerMode: { value: 0.0 },
    uRingTint: { value: _ringTintArr },

    // Global tuning (sliders)
    uOpacity: { value: ringDustParams.opacity },
    uDensity: { value: 34.0 },
    uSteps: { value: dynRingDustSteps },
    uFade: { value: ringDustParams.fade },
    uNoiseScale: { value: ringDustParams.noiseScale },
    uWindSpeed: { value: ringDustParams.windSpeed },

    // Eclipse
    uOccCount: { value: 0 },
    uOccCenters: { value: occluderCenters },
    uOccRadii: { value: occluderRadii },
    uEclipseSoftness: { value: ringDustParams.eclipseSoftness },
    uEclipseStrength: { value: ringDustParams.eclipseStrength },
    uSunPosW: { value: new THREE.Vector3() },
    uSunRadius: { value: SUN_RADIUS },
  };

  const ringDustMat = new THREE.ShaderMaterial({
    transparent: false,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    toneMapped: false,
    uniforms: ringDustUniforms,
    vertexShader: atmoVS,
    fragmentShader: RING_DUST_POST_FS,
  });
  const ringDustMesh = new THREE.Mesh(fsTri, ringDustMat);
  ringDustMesh.frustumCulled = false;
  ringDustMesh.visible = false;
  atmoScene.add(ringDustMesh);

  const ringDustPass = {
    mesh: ringDustMesh,
    uniforms: ringDustUniforms,
  };

  function applyQualityToAtmoPasses() {
    for (const p of atmoPasses) {
      if (!p || !p.uniforms) continue;
      p.uniforms.uAtmoSteps.value = dynAtmoSteps;
      p.uniforms.uCloudSteps.value = dynCloudSteps;
      p.uniforms.uCloudLightSteps.value = dynCloudLightSteps;
    }
    if (ringDustPass?.uniforms?.uSteps) {
      ringDustPass.uniforms.uSteps.value = dynRingDustSteps;
    }
  }

  function rebuildRenderTargets() {
    // Main scene RT (dynamic resolution)
    const w = Math.max(1, Math.floor(innerWidth * dynScale));
    const h = Math.max(1, Math.floor(innerHeight * dynScale));

    if (!rt || rt.width !== w || rt.height !== h) {
      if (rt) rt.dispose();
      rt = makeRT(w, h);
      if (copyMat) copyMat.uniforms.tColor.value = rt.texture;

      // Any pass that samples depth needs updated depthTexture
      for (const pass of atmoPasses) {
        if (pass?.uniforms?.uDepthTex)
          pass.uniforms.uDepthTex.value = rt.depthTexture;
      }
      if (beltDustPass?.uniforms?.uDepthTex) {
        beltDustPass.uniforms.uDepthTex.value = rt.depthTexture;
      }
      if (ringDustPass?.uniforms?.uDepthTex) {
        ringDustPass.uniforms.uDepthTex.value = rt.depthTexture;
      }
      if (godRayMat?.uniforms?.tDepth)
        godRayMat.uniforms.tDepth.value = rt.depthTexture;
      if (tintMat?.uniforms?.tDepth)
        tintMat.uniforms.tDepth.value = rt.depthTexture;
    }

    // Atmosphere + cloud buffers (also scaled dynamically)
    const aw = Math.max(
      1,
      Math.floor(innerWidth * QUALITY_ATMO_SCALE * dynScale),
    );
    const ah = Math.max(
      1,
      Math.floor(innerHeight * QUALITY_ATMO_SCALE * dynScale),
    );
    if (!atmoRT || atmoRT.width !== aw || atmoRT.height !== ah) {
      if (atmoRT) atmoRT.dispose();
      atmoRT = makeColorRT(aw, ah);
      if (atmoCopyMat) atmoCopyMat.uniforms.tAtmo.value = atmoRT.texture;
    }

    const rw = Math.max(1, Math.floor(aw * RING_DUST_SCALE));
    const rh = Math.max(1, Math.floor(ah * RING_DUST_SCALE));
    if (!ringDustRT || ringDustRT.width !== rw || ringDustRT.height !== rh) {
      if (ringDustRT) ringDustRT.dispose();
      ringDustRT = makeColorRT(rw, rh);
      ringDustRT.texture.colorSpace = THREE.NoColorSpace;
      if (ringDustCompositeMat?.uniforms?.tTexture) {
        ringDustCompositeMat.uniforms.tTexture.value = ringDustRT.texture;
      }
    }

    const cw = Math.max(
      1,
      Math.floor(innerWidth * QUALITY_CLOUD_SCALE * dynScale),
    );
    const ch = Math.max(
      1,
      Math.floor(innerHeight * QUALITY_CLOUD_SCALE * dynScale),
    );
    if (!cloudRT || cloudRT.width !== cw || cloudRT.height !== ch) {
      if (cloudRT) cloudRT.dispose();
      cloudRT = makeMaskRT(cw, ch);
      if (godRayMat?.uniforms?.tCloud)
        godRayMat.uniforms.tCloud.value = cloudRT.texture;
    }

    renderer.getDrawingBufferSize(_drawingBufferSize);
    const gw = Math.max(
      1,
      Math.floor(_drawingBufferSize.x * QUALITY_GODRAY_SCALE * dynScale),
    );
    const gh = Math.max(
      1,
      Math.floor(_drawingBufferSize.y * QUALITY_GODRAY_SCALE * dynScale),
    );
    if (!godRayRT || godRayRT.width !== gw || godRayRT.height !== gh) {
      if (godRayRT) godRayRT.dispose();
      godRayRT = makeColorRT(gw, gh);
      godRayRT.texture.colorSpace = THREE.NoColorSpace;
      if (godRayCompositeMat?.uniforms?.tTexture) {
        godRayCompositeMat.uniforms.tTexture.value = godRayRT.texture;
      }
    }

    // Match the main dynamic-resolution target. The final pass is upsampled
    // once to the display, just like the normal scene copy.
    const uw = w;
    const uh = h;
    if (!underwaterRT || underwaterRT.width !== uw || underwaterRT.height !== uh) {
      if (underwaterRT) underwaterRT.dispose();
      underwaterRT = makeUnderwaterRT(uw, uh);
      if (tintMat?.uniforms?.tScene) {
        tintMat.uniforms.tScene.value = underwaterRT.texture;
      }
    }
    if (tintMat?.uniforms?.uResolution) {
      tintMat.uniforms.uResolution.value.set(uw, uh);
    }

    // Dynamic sample counts
    if (godRayMat?.uniforms?.uSamples) {
      godRayMat.uniforms.uSamples.value = dynGodraySamples;
    }
    if (ringDustPass?.uniforms?.uSteps) {
      ringDustPass.uniforms.uSteps.value = dynRingDustSteps;
    }
    // keep exported references fresh for other modules
    world.rt = rt;
    world.atmoRT = atmoRT;
    world.cloudRT = cloudRT;
    world.ringDustRT = ringDustRT;
    world.godRayRT = godRayRT;
    world.underwaterRT = underwaterRT;
  }

  function applyQualityPreset(name) {
    const key = name === "Desktop" ? "Descktop" : name;
    const preset = getPreset(key);
    currentQuality = QUALITY_PRESETS[key] ? key : "Descktop";
    if (qualitySel) qualitySel.value = currentQuality;

    QUALITY_SPOT_SHADOW = preset.spotShadow;
    QUALITY_ATMO_SCALE = preset.atmoScale;
    QUALITY_CLOUD_SCALE = preset.cloudScale;
    QUALITY_GODRAY_ENABLED = preset.godRays !== false;
    QUALITY_GODRAY_SAMPLES = preset.godRaySamples;
    QUALITY_GODRAY_SCALE = preset.godRayScale ?? 0.5;
    QUALITY_GODRAY_INTENSITY = preset.godRayIntensity ?? 0.08;
    QUALITY_GODRAY_DENSITY = preset.godRayDensity ?? 0.7;
    QUALITY_GODRAY_DECAY = preset.godRayDecay ?? 0.92;
    QUALITY_GODRAY_WEIGHT = preset.godRayWeight ?? 0.18;
    QUALITY_ATMO_STEPS = preset.atmoSteps;
    QUALITY_CLOUD_STEPS = preset.cloudSteps;
    QUALITY_CLOUD_LIGHT_STEPS = preset.cloudLightSteps;
    QUALITY_RING_DUST_STEPS = preset.ringDustSteps ?? 8;

    // Pixel ratio clamp (huge perf win on 4K/retina)
    const prMax = preset.pixelRatioMax ?? devicePixelRatio;
    renderer.setPixelRatio(Math.min(devicePixelRatio, prMax));

    // Apply the focused SpotLight shadow resolution from the quality preset.
    applySpotShadowState({ rebuildMaps: true });
    // Reset dynamic scalers to the preset baseline
    dynScale = 1.0;
    dynAtmoSteps = QUALITY_ATMO_STEPS;
    dynCloudSteps = QUALITY_CLOUD_STEPS;
    dynCloudLightSteps = QUALITY_CLOUD_LIGHT_STEPS;
    dynGodraySamples = QUALITY_GODRAY_SAMPLES;
    dynRingDustSteps = QUALITY_RING_DUST_STEPS;

    if (godRayMat?.uniforms) {
      godRayMat.uniforms.uSamples.value = dynGodraySamples;
      godRayMat.uniforms.uDensity.value = QUALITY_GODRAY_DENSITY;
      godRayMat.uniforms.uDecay.value = QUALITY_GODRAY_DECAY;
      godRayMat.uniforms.uWeight.value = QUALITY_GODRAY_WEIGHT;
      if (!QUALITY_GODRAY_ENABLED) godRayMat.uniforms.uIntensity.value = 0.0;
    }
    world.godRaysEnabled = QUALITY_GODRAY_ENABLED;
    world.godRayIntensity = QUALITY_GODRAY_INTENSITY;

    applyQualityToAtmoPasses();
    rebuildRenderTargets();

    // Rebuild asteroid belt density for the new preset (keep layout constant)
    if (asteroidBelt && !isSystemTransitionActive()) {
      rebuildAsteroidBelt({ seed: currentSystemSeed, buildNow: true });
    }

    // Rebuild planet rings density for the new preset.
    if (!isSystemTransitionActive()) {
      rebuildPlanetRingsFromBodies();
    }

    for (const body of bodies) {
      body.setTerrainPatchBudget?.(preset.terrainPatchBudget);
    }

    // keep exported quality fields in sync
    world.currentQuality = currentQuality;
    world.SPL_MASK_INTERVAL = SPL_MASK_INTERVAL;
  }

  if (qualitySel) {
    qualitySel.addEventListener("change", () =>
      applyQualityPreset(qualitySel.value),
    );
  }
  applyQualityPreset(currentQuality);

  ////////////////////////////////////////////////////////////////////////////////
  // Input (pointer lock + keys + mouse look)
  ////////////////////////////////////////////////////////////////////////////////

  function scaledSampleCount(base, minimum, multiplier) {
    const maxCount = Math.max(1, Math.floor(base ?? 1));
    const minCount = Math.min(
      maxCount,
      Math.max(1, Math.floor(minimum ?? 1)),
    );
    return Math.min(
      maxCount,
      Math.max(minCount, Math.floor(maxCount * multiplier)),
    );
  }

  function applyDynamicScale(scale) {
    // Scale render targets only (canvas pixel ratio stays quality-preset clamped).
    dynScale = THREE.MathUtils.clamp(scale, 0.6, 1.0);
    world.dynScale = dynScale;

    // Shave samples when scaling down, but never exceed the selected preset.
    const stepMul = THREE.MathUtils.clamp(0.55 + 0.45 * dynScale, 0.55, 1.0);
    dynAtmoSteps = scaledSampleCount(QUALITY_ATMO_STEPS, 8, stepMul);
    dynCloudSteps = scaledSampleCount(QUALITY_CLOUD_STEPS, 4, stepMul);
    dynCloudLightSteps = scaledSampleCount(
      QUALITY_CLOUD_LIGHT_STEPS,
      2,
      stepMul,
    );
    dynGodraySamples = scaledSampleCount(
      QUALITY_GODRAY_SAMPLES,
      6,
      stepMul,
    );
    dynRingDustSteps = scaledSampleCount(
      QUALITY_RING_DUST_STEPS,
      6,
      stepMul,
    );

    applyQualityToAtmoPasses();
    rebuildRenderTargets();
  }

  // Export a compact API for the rest of the app.
  // (Most state lives in closure; these refs are the ones used across modules.)
  Object.assign(world, {
    THREE,
    renderer,
    scene,
    camera,
    PLAYER_SHIP_LAYER,
    msg,
    crosshair,
    fpsEl,
    qualitySel,
    terrainPool,
    sky,
    bodies,
    asteroidBelt,
    planetRings,
    setRingDustParams,
    getRingDustParams: () => ({ ...ringDustParams }),
    setShadowBiasParams,
    getShadowBiasParams,
    // separate list for HUD + moon-specific behaviors (moons are also included in `bodies`)
    moons,
    sun,
    worldSun: sun,
    sunLight,
    sunGlow,
    SUN_RADIUS,

    // render targets / passes
    fsTri,
    rt,
    atmoRT,
    cloudRT,
    ringDustRT,
    godRayRT,
    underwaterRT,
    copyScene,
    copyMat,
    atmoCopyScene,
    atmoCopyMat,
    ringDustCompositeScene,
    ringDustCompositeMat,
    godRayCompositeScene,
    godRayCompositeMat,
    atmoScene,
    atmoPasses,
    beltDustPass,
    ringDustPass,
    godRayScene,
    godRayMat,
    postScene,
    tintMat,
    particlesMat,
    volumeNoiseTex,
    volumeNoiseLayout,
    cloudNoiseTex,
    cloudNoiseTex3D,
    cloudNoiseLayout,
    cloudNoiseMode: useCloudNoise3D ? "3d" : "atlas",

    // eclipse buffers + helpers
    MAX_OCCLUDERS,
    occluderCenters,
    occluderRadii,
    fillOccludersForBody,
    sunVisibilityCPU,
    getEclipseBodyRadius: bodyRadiusForEclipse,

    // system/quality hooks
    rebuildRenderTargets,
    applyQualityPreset,
    applyDynamicScale,
    rebuildSystemForWarp,
    tickSystemTransition,

    // wiring hook
    setOnPlacePlayerNearNewStar,

    // galaxy marker (updated during warp transitions)
    galaxyPlayer,

    // light helper
    updateSunSuperPointLight,

    // dynamic fields (kept current by applyQualityPreset / applyDynamicScale)
    currentQuality,
    dynScale,
    SPL_MASK_INTERVAL,
  });

  return world;
}
