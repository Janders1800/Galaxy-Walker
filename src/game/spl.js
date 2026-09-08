import { THREE } from "../render/device.js";

export const SPL_MAX_ECLIPSE_OCCLUDERS = 24;

// SuperPointLight: PointLight + internal SpotLight for focused, high-res shadows
// ============================================================================
export class SuperPointLight extends THREE.PointLight {
  constructor(
    color = 0xffffff,
    intensity = 10,
    distance = 0,
    decay = 2,
    opts = {},
  ) {
    super(color, intensity, distance, decay);

    const {
      // spot defaults
      spotCastShadow = true,
      spotShadowMapSize = 2048,
      spotShadowNear = 50,
      spotShadowFar = 45000, //distance > 0 ? distance : 60,
      spotShadowBias = -0.00001,
      spotShadowNormalBias = 0.01,
      spotFocus = 0.55,
      spotAngleDeg = 16,
      spotPenumbra = 0.35,
      spotIntensityFactor = 0.25,
      spotDirection = new THREE.Vector3(1, -0.55, 0.2),

      // Analytic eclipse mask for the focused spotlight. This is deliberately
      // independent of the spotlight shadow-camera near/far range so distant
      // planets/moons can eclipse both the coarse PointLight path outside the
      // focused cone and the high-detail SpotLight path inside it.
      eclipseSunRadius = 1.0,
      eclipseSoftness = 0.015,
      eclipseStrength = 1.0,
      // Minimum indirect/environment fill retained in totality. Direct solar
      // light still reaches zero; this only prevents standard PBR materials
      // from becoming mathematically black when the HemisphereLight/IBL is
      // attenuated by the same world-space eclipse visibility.
      eclipseAmbientFloor = 0.12,
    } = opts;

    // PointLight cube shadows are intentionally disabled. Astronomical
    // eclipses are analytic, and local crisp shadows are owned by the focused
    // SpotLight below. Keeping this false avoids six coarse cube-shadow renders.
    this.castShadow = false;

    // Internal spotlight for focused shadows
    this.shadowLight = new THREE.SpotLight(
      color,
      intensity * spotIntensityFactor,
      distance,
      THREE.MathUtils.degToRad(spotAngleDeg),
      spotPenumbra,
      decay,
    );
    this.shadowLight.castShadow = !!spotCastShadow;

    if (this.shadowLight.castShadow) {
      this.shadowLight.shadow.mapSize.set(spotShadowMapSize, spotShadowMapSize);
      this.shadowLight.shadow.camera.near = spotShadowNear;
      this.shadowLight.shadow.camera.far = spotShadowFar;
      this.shadowLight.shadow.bias = spotShadowBias;
      this.shadowLight.shadow.normalBias = spotShadowNormalBias;
      this.shadowLight.shadow.focus = spotFocus;
    }

    this.add(this.shadowLight);
    this.add(this.shadowLight.target);

    this._spotIntensityFactor = spotIntensityFactor;

    // Shared eclipse state. Every patched material points at these same vectors
    // and typed arrays, so moving occluders only requires updating this light.
    this.eclipse = {
      sunPosW: new THREE.Vector3(),
      sunRadius: Math.max(0.0, eclipseSunRadius),
      softness: Math.max(0.0001, eclipseSoftness),
      strength: THREE.MathUtils.clamp(eclipseStrength, 0.0, 1.0),
      ambientFloor: THREE.MathUtils.clamp(eclipseAmbientFloor, 0.0, 1.0),
      count: 0,
      centers: new Float32Array(SPL_MAX_ECLIPSE_OCCLUDERS * 3),
      radii: new Float32Array(SPL_MAX_ECLIPSE_OCCLUDERS),
    };

    this.setSpotDirection(spotDirection);
  }

  setSpotDirection(dir) {
    const d = dir.clone();
    if (d.lengthSq() === 0) d.set(0, -1, 0);
    d.normalize();
    this.shadowLight.target.position.copy(d);
    this.shadowLight.target.updateMatrixWorld(true);
  }

  setSpotIntensityFactor(f) {
    this._spotIntensityFactor = f;
    this.syncSpotIntensity();
  }

  syncSpotIntensity() {
    this.shadowLight.color.copy(this.color);
    this.shadowLight.distance = this.distance;
    this.shadowLight.decay = this.decay;
    this.shadowLight.intensity = this.intensity * this._spotIntensityFactor;
  }
}

// ------------------------------------------------------------------------------------------
// Material patch: one shared world-space eclipse answer for the SuperPointLight.
// - Outside the focused cone: eclipse attenuates the PointLight path.
// - Inside the focused cone: PointLight is suppressed and the SpotLight inherits
//   the exact same eclipse visibility, combined with its high-res PCF shadow.
// (WORLD space mask => stable when camera moves)
// ------------------------------------------------------------------------------------------

const _spl_wp = new THREE.Vector3();
const _spl_wt = new THREE.Vector3();
const _spl_wdir = new THREE.Vector3();

// Build the spotlight lighting chunk from the exact vendored Three.js runtime.
// This keeps the SPL eclipse patch tolerant of Three.js revisions whose
// getShadow(...) signature differs (e.g. shadowIntensity was added later).
function makeSPLLightsFragmentBegin() {
  const source = THREE.ShaderChunk?.lights_fragment_begin;
  if (typeof source !== "string" || source.length === 0) return null;

  const spotStart = source.indexOf("#if ( NUM_SPOT_LIGHTS");
  if (spotStart < 0) return null;

  const nextLightSections = [
    "#if ( NUM_SUN_LIGHTS",
    "#if ( NUM_DIR_LIGHTS",
    "#if ( NUM_RECT_AREA_LIGHTS",
  ];
  let spotEnd = source.length;
  for (const marker of nextLightSections) {
    const at = source.indexOf(marker, spotStart + 1);
    if (at >= 0 && at < spotEnd) spotEnd = at;
  }
  if (spotEnd <= spotStart || spotEnd === source.length) return null;

  let spotBlock = source.slice(spotStart, spotEnd);

  // Three's spot loop computes a 0..1 PCF visibility and multiplies the direct
  // light by it. Replace that one expression with min(PCF, eclipseVisibility),
  // so an astronomical eclipse is literally part of the focused SPL shadow
  // factor. If receiveShadow/the local map is unavailable, the local term is
  // 1.0 and the analytic eclipse can still shadow the spotlight.
  const spotShadowMul =
    /directLight\.color\s*\*=\s*([^;]*getShadow\s*\([^;]*\)[^;]*);/;

  if (spotShadowMul.test(spotBlock)) {
    spotBlock = spotBlock.replace(
      spotShadowMul,
      "directLight.color *= min( splSunVisibilityW(), ( $1 ) );",
    );
  } else {
    // Compatibility fallback for an unexpected Three.js chunk layout. This is
    // visually equivalent for the direct spotlight, though it composes by
    // multiplication rather than min() with the local PCF result.
    const reDirect = /RE_Direct\s*\(\s*directLight\s*,/;
    if (!reDirect.test(spotBlock)) return null;
    spotBlock = spotBlock.replace(
      reDirect,
      "directLight.color *= splSunVisibilityW();\n\t\tRE_Direct( directLight,",
    );
  }

  return source.slice(0, spotStart) + spotBlock + source.slice(spotEnd);
}

export function attachSuperPointLightMask(material, superPointLight) {
  if (!material || material.userData?._splMasked) return;

  // Materials normally consume this one shared eclipse path on both sides of
  // the PointLight/SpotLight handoff. A custom material may explicitly opt out
  // only if it already owns an equivalent solar-visibility implementation.
  const hasOwnEclipse = !!material.userData?._splHasOwnEclipse;
  const useEclipse = !hasOwnEclipse && !!superPointLight?.eclipse;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader) => {
    if (prev) prev(shader);

    shader.uniforms.uSPL_spotPosW = {
      value: new THREE.Vector3(),
    };
    shader.uniforms.uSPL_spotDirW = {
      value: new THREE.Vector3(0, -1, 0),
    };
    shader.uniforms.uSPL_cosOuter = { value: 0.0 };
    shader.uniforms.uSPL_cosInner = { value: 0.0 };

    if (useEclipse) {
      // Reference the light's shared state directly. Vector/typed-array changes
      // are therefore visible to all compiled materials without per-material
      // copies every frame.
      shader.uniforms.uSPL_sunPosW = {
        value: superPointLight.eclipse.sunPosW,
      };
      shader.uniforms.uSPL_sunRadius = {
        value: superPointLight.eclipse.sunRadius,
      };
      shader.uniforms.uSPL_occCount = {
        value: superPointLight.eclipse.count,
      };
      shader.uniforms.uSPL_occCenters = {
        value: superPointLight.eclipse.centers,
      };
      shader.uniforms.uSPL_occRadii = {
        value: superPointLight.eclipse.radii,
      };
      shader.uniforms.uSPL_eclipseSoftness = {
        value: superPointLight.eclipse.softness,
      };
      shader.uniforms.uSPL_eclipseStrength = {
        value: superPointLight.eclipse.strength,
      };
      shader.uniforms.uSPL_eclipseAmbientFloor = {
        value: superPointLight.eclipse.ambientFloor,
      };
    }

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>\nvarying vec3 vSPL_worldPos;`,
      )
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>

// Compute stable world position for SPL masking without relying on Three's internal
// worldPosition temp (which is conditionally declared in some shader variants).
vec4 splWorldPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  splWorldPosition = instanceMatrix * splWorldPosition;
#endif
splWorldPosition = modelMatrix * splWorldPosition;
vSPL_worldPos = splWorldPosition.xyz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>\nvarying vec3 vSPL_worldPos;`,
      )
      .replace(
        "#include <lights_pars_begin>",
        `
#define getPointLightInfo getPointLightInfo_original
#include <lights_pars_begin>
#undef getPointLightInfo

uniform vec3 uSPL_spotPosW;
uniform vec3 uSPL_spotDirW;
uniform float uSPL_cosOuter;
uniform float uSPL_cosInner;

float splMaskW() {
  vec3 toFragW = normalize(vSPL_worldPos - uSPL_spotPosW); // light -> fragment
  float cosAng = dot(toFragW, normalize(uSPL_spotDirW));   // light -> target axis
  return smoothstep(uSPL_cosOuter, uSPL_cosInner, cosAng);
}

${
  useEclipse
    ? `
uniform vec3 uSPL_sunPosW;
uniform float uSPL_sunRadius;
uniform int uSPL_occCount;
uniform vec3 uSPL_occCenters[${SPL_MAX_ECLIPSE_OCCLUDERS}];
uniform float uSPL_occRadii[${SPL_MAX_ECLIPSE_OCCLUDERS}];
uniform float uSPL_eclipseSoftness;
uniform float uSPL_eclipseStrength;
uniform float uSPL_eclipseAmbientFloor;

// Finite-disc analytic eclipse. The local high-res spot shadow map handles
// nearby geometry; this term handles astronomical occluders at any distance.
//
// A body is intentionally allowed to remain in the list while the receiver is
// standing on it: the same body must still block the Sun on its night side.
// The surface-shell guard below prevents the numerical self-hit false positive
// on the sun-facing side, then nudges night-side tests just outside the sphere.
float splSunVisibilityComputeW() {
  vec3 baseToSun = uSPL_sunPosW - vSPL_worldPos;
  float baseSunDistance = length(baseToSun);
  if (baseSunDistance <= 1e-5) return 1.0;

  vec3 baseSunDirection = baseToSun / baseSunDistance;
  float visibility = 1.0;

  for (int i = 0; i < ${SPL_MAX_ECLIPSE_OCCLUDERS}; i++) {
    if (i >= uSPL_occCount) break;
    float occR = max(0.0, uSPL_occRadii[i]);
    if (occR <= 0.0) continue;

    vec3 occCenter = uSPL_occCenters[i];
    vec3 receiverW = vSPL_worldPos;
    vec3 fromOcc = receiverW - occCenter;
    float receiverDistance = length(fromOcc);

    // Covers float error and small radius mismatches between the rendered
    // surface and the nominal eclipse sphere without creating a large dead zone.
    float selfSurfaceEpsilon = max(0.5, occR * 0.0002);
    if (receiverDistance <= occR + selfSurfaceEpsilon) {
      vec3 radial = receiverDistance > 1e-5
        ? fromOcc / receiverDistance
        : -baseSunDirection;

      // Same-body sun-facing surface: this sphere is behind the receiver and
      // cannot eclipse it. This is the false-positive guard.
      if (dot(baseSunDirection, radial) > 0.0) continue;

      // Same-body night side: keep the legitimate eclipse, but start the
      // angular test just outside the nominal sphere so t ~= 0/self hits do
      // not destabilize the penumbra calculation.
      receiverW = occCenter + radial * (occR + selfSurfaceEpsilon);
    }

    vec3 toSun = uSPL_sunPosW - receiverW;
    float sunDistance = length(toSun);
    if (sunDistance <= 1e-5) continue;
    vec3 sunDirection = toSun / sunDistance;

    vec3 toOcc = occCenter - receiverW;
    float along = dot(toOcc, sunDirection);
    if (along <= 0.0 || along >= sunDistance) continue;

    float perp = length(toOcc - sunDirection * along);

    // Authoritative hard eclipse core: whenever the centre ray from this
    // fragment to the Sun passes through an occluder, force the focused SPL
    // fully into shadow. This remains important for small moons, whose
    // finite-disc coverage alone can otherwise leave a bright spotlight bubble.
    // The same-body surface guard above still prevents false self-eclipses.
    if (perp <= occR) {
      visibility = 0.0;
      break;
    }

    // Outside the geometric core, retain the finite solar-disc calculation so
    // the eclipse still has a soft analytic penumbra.
    float projSunR = max(
      uSPL_sunRadius * (along / sunDistance),
      occR * max(uSPL_eclipseSoftness, 0.0001)
    );
    float outer = occR + projSunR;
    if (perp >= outer) continue;

    float inner = abs(occR - projSunR);
    float overlap = 1.0 - smoothstep(
      inner,
      max(inner + 1e-4, outer),
      perp
    );
    float maxCoverage = occR >= projSunR
      ? 1.0
      : clamp(
          (occR * occR) / max(1e-5, projSunR * projSunR),
          0.0,
          1.0
        );

    visibility = min(visibility, 1.0 - overlap * maxCoverage);
  }

  return mix(
    1.0,
    visibility,
    clamp(uSPL_eclipseStrength, 0.0, 1.0)
  );
}

// The same visibility is consumed by the PointLight, SpotLight and indirect
// fill paths. Cache it once per fragment so the 24-body loop is not repeated.
float splEclipseCachedW = -1.0;
float splSunVisibilityW() {
  if (splEclipseCachedW < 0.0) {
    splEclipseCachedW = splSunVisibilityComputeW();
  }
  return splEclipseCachedW;
}
`
    : ""
}

// Only override when point lights exist for this material/pass.
#if NUM_POINT_LIGHTS > 0
void getPointLightInfo( const in PointLight pointLight, const in vec3 geometryPosition, out IncidentLight light ) {
  getPointLightInfo_original( pointLight, geometryPosition, light );
  float m = splMaskW();
  // Outside the SPL cone the PointLight owns direct solar lighting, so apply
  // the same analytic eclipse visibility used by the focused SpotLight.
  // Inside the cone the PointLight is removed and the SpotLight takes over.
  ${
    useEclipse
      ? `float pointWeight = 1.0 - m;
  if (pointWeight <= 1e-4) {
    light.color = vec3(0.0);
  } else {
    light.color *= pointWeight * splSunVisibilityW();
  }`
      : `light.color *= (1.0 - m);`
  }
}
#endif
        `,
      );

    if (useEclipse) {
      // Hemisphere/IBL is indirect light, so it bypasses both the PointLight and
      // SpotLight shadow factors. Gate that fill by the same analytic eclipse
      // answer, retaining only a small configurable floor in totality. This is
      // what makes small standard-material receivers (especially asteroids)
      // actually read as eclipsed instead of staying bright from HemisphereLight.
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <lights_fragment_end>",
        `#include <lights_fragment_end>
float splIndirectEclipse = mix(
  clamp(uSPL_eclipseAmbientFloor, 0.0, 1.0),
  1.0,
  splSunVisibilityW()
);
reflectedLight.indirectDiffuse *= splIndirectEclipse;
reflectedLight.indirectSpecular *= splIndirectEclipse;`,
      );

      const splLightsFragmentBegin = makeSPLLightsFragmentBegin();
      if (splLightsFragmentBegin) {
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <lights_fragment_begin>",
          splLightsFragmentBegin,
        );
      } else {
        console.warn(
          "SPL eclipse: could not patch Three.js spotlight shadow chunk; " +
            "analytic eclipse shadow disabled for this material.",
        );
      }
    }

    material.userData._splShader = shader;
  };

  material.userData._splLight = superPointLight;
  material.userData._splMasked = true;
  material.needsUpdate = true;
}

export function updateSuperPointLightMask(
  materialOrArray,
  superPointLight = null,
) {
  const mats = Array.isArray(materialOrArray)
    ? materialOrArray
    : [materialOrArray];

  for (const m of mats) {
    const shader = m?.userData?._splShader;
    const light = superPointLight || m?.userData?._splLight;
    if (!shader || !light?.shadowLight) continue;

    const spot = light.shadowLight;

    light.updateMatrixWorld(true);
    spot.updateMatrixWorld(true);
    spot.target.updateMatrixWorld(true);

    spot.getWorldPosition(_spl_wp);
    shader.uniforms.uSPL_spotPosW.value.copy(_spl_wp);

    spot.target.getWorldPosition(_spl_wt);
    _spl_wdir.copy(_spl_wt).sub(_spl_wp).normalize();
    shader.uniforms.uSPL_spotDirW.value.copy(_spl_wdir);

    const angle = spot.angle;
    shader.uniforms.uSPL_cosOuter.value = Math.cos(angle);
    shader.uniforms.uSPL_cosInner.value = Math.cos(
      angle * (1.0 - spot.penumbra),
    );

    const eclipse = light.eclipse;
    if (eclipse && shader.uniforms.uSPL_sunRadius) {
      shader.uniforms.uSPL_sunRadius.value = eclipse.sunRadius;
      shader.uniforms.uSPL_occCount.value = eclipse.count;
      shader.uniforms.uSPL_eclipseSoftness.value = eclipse.softness;
      shader.uniforms.uSPL_eclipseStrength.value = eclipse.strength;
      if (shader.uniforms.uSPL_eclipseAmbientFloor) {
        shader.uniforms.uSPL_eclipseAmbientFloor.value = eclipse.ambientFloor;
      }
    }
  }
}

export const splMaskedMaterials = [];
function _isLitMaterial(mat) {
  return !!(
    mat &&
    (mat.isMeshStandardMaterial ||
      mat.isMeshPhysicalMaterial ||
      mat.isMeshPhongMaterial ||
      mat.isMeshLambertMaterial ||
      mat.isMeshToonMaterial)
  );
}
export function registerSPLMaterial(mat, light) {
  if (!_isLitMaterial(mat)) return;

  // If a material was already patched before a registry clear (e.g. persistent ship materials),
  // re-add it so the SPL mask uniforms continue to update.
  if (mat.userData?._splMasked) {
    if (light) mat.userData._splLight = light;
    if (!splMaskedMaterials.includes(mat)) splMaskedMaterials.push(mat);
    return;
  }

  attachSuperPointLightMask(mat, light);
  splMaskedMaterials.push(mat);
}
export function registerSPLMaterialsIn(root, light, { skipRoot = null } = {}) {
  if (!root) return;
  root.traverse((obj) => {
    if (!obj || !obj.isMesh) return;
    if (skipRoot && (obj === skipRoot || obj.parent === skipRoot)) return;

    const m = obj.material;
    if (Array.isArray(m)) m.forEach((mm) => registerSPLMaterial(mm, light));
    else registerSPLMaterial(m, light);
  });
}
export function clearSPLMaterialRegistry() {
  splMaskedMaterials.length = 0;
}

// ============================================================================
