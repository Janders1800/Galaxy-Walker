import { THREE } from "../render/device.js";

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
      // This don't really matter but whatever
      // point shadow defaults
      pointCastShadow = true,
      pointShadowMapSize = 256,
      pointShadowNear = 50,
      pointShadowFar = 45000, //distance > 0 ? distance : 60,
      pointShadowBias = -0.01,
      pointShadowNormalBias = 0.0001,

      // spot defaults
      spotCastShadow = true,
      spotShadowMapSize = 2048,
      spotShadowNear = 50,
      spotShadowFar = 45000, //distance > 0 ? distance : 60,
      spotShadowBias = -0.01,
      spotShadowNormalBias = 0.0001,
      spotFocus = 0.55,
      spotAngleDeg = 16,
      spotPenumbra = 0.35,
      spotIntensityFactor = 0.25,
      spotDirection = new THREE.Vector3(1, -0.55, 0.2),
    } = opts;

    // PointLight shadows (usually low-res)
    this.castShadow = !!pointCastShadow;
    if (this.castShadow) {
      this.shadow.mapSize.set(pointShadowMapSize, pointShadowMapSize);
      this.shadow.camera.near = pointShadowNear;
      this.shadow.camera.far = pointShadowFar;
      this.shadow.bias = pointShadowBias;
      this.shadow.normalBias = pointShadowNormalBias;
    }

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
// Material patch: kill PointLight contribution inside the SuperPointLight spotlight cone
// (WORLD space mask => stable when camera moves)
// ------------------------------------------------------------------------------------------

const _spl_wp = new THREE.Vector3();
const _spl_wt = new THREE.Vector3();
const _spl_wdir = new THREE.Vector3();

export function attachSuperPointLightMask(material, superPointLight) {
  if (!material || material.userData?._splMasked) return;

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

// Only override when point lights exist for this material/pass.
#if NUM_POINT_LIGHTS > 0
void getPointLightInfo( const in PointLight pointLight, const in vec3 geometryPosition, out IncidentLight light ) {
  getPointLightInfo_original( pointLight, geometryPosition, light );
  float m = splMaskW();
  light.color *= (1.0 - m); // inside cone => kill point light contribution
}
#endif
        `,
      );

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
