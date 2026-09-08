import { THREE } from "../render/device.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { createInput } from "../core/input.js";
import {
  makeChargeUI,
  makeChargeSound,
  makeWarpController,
} from "../game/warp.js";
import { createWarpOverlay, resizeWarpOverlay } from "../render/shaders.js";
import { createGalaxyOverlay } from "../ui/galaxyOverlay.js";
import { registerSPLMaterialsIn } from "../game/spl.js";
import { createGalaxyMiniMap } from "../ui/galaxyMiniMap.js";
import { mulberry32 } from "../core/galaxy.js";


const WING_TRAIL_VERTEX = `
attribute float aTrailAlpha;
attribute float aTrailEdge;
attribute float aTrailLight;
varying float vTrailAlpha;
varying float vTrailEdge;
varying float vTrailLight;

void main() {
  vTrailAlpha = aTrailAlpha;
  vTrailEdge = aTrailEdge;
  vTrailLight = aTrailLight;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const WING_TRAIL_FRAGMENT = `
uniform vec3 uTrailColor;
varying float vTrailAlpha;
varying float vTrailEdge;
varying float vTrailLight;

void main() {
  float softEdge = 1.0 - smoothstep(0.25, 1.0, abs(vTrailEdge));
  float light = clamp(vTrailLight, 0.0, 1.0);
  float alpha = vTrailAlpha * softEdge * mix(0.08, 1.0, light);
  if (alpha <= 0.002) discard;
  vec3 color = uTrailColor * mix(0.025, 1.0, light);
  gl_FragColor = vec4(color, alpha);
}
`;

function createWingTrailRibbon(THREE, maxSegments = 480) {
  const vertexCount = maxSegments * 6;
  const positions = new Float32Array(vertexCount * 3);
  const alphas = new Float32Array(vertexCount);
  const edges = new Float32Array(vertexCount);
  const lights = new Float32Array(vertexCount);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "aTrailAlpha",
    new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "aTrailEdge",
    new THREE.BufferAttribute(edges, 1).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "aTrailLight",
    new THREE.BufferAttribute(lights, 1).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    name: "PlayerWingtipAirTrail",
    vertexShader: WING_TRAIL_VERTEX,
    fragmentShader: WING_TRAIL_FRAGMENT,
    uniforms: {
      uTrailColor: { value: new THREE.Color(0xc9f4ff) },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "PlayerWingtipAirTrail";
  mesh.frustumCulled = false;
  mesh.renderOrder = 3;
  mesh.visible = false;

  return {
    mesh,
    geometry,
    positions,
    alphas,
    edges,
    lights,
    streaks: [],
    currentStreak: null,
    totalSegments: 0,
    nextStreakId: 1,
    maxSegments,
    lastPoint: new THREE.Vector3(),
    lastValid: false,
  };
}

const ATMOSPHERIC_SHIELD_VERTEX = `
varying vec3 vNormalL;
varying vec3 vPosL;
varying vec3 vViewNormal;
varying vec3 vViewDir;

void main() {
  vNormalL = normalize(normal);
  vPosL = position;

  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewNormal = normalize(normalMatrix * normal);
  vViewDir = normalize(-mvPosition.xyz);

  gl_Position = projectionMatrix * mvPosition;
}
`;

const ATMOSPHERIC_SHIELD_FRAGMENT = `
uniform vec3 uVelocityDirL;
uniform float uStrength;
uniform float uSpeed01;
uniform float uFullEnvelope;
uniform float uTime;

varying vec3 vNormalL;
varying vec3 vPosL;
varying vec3 vViewNormal;
varying vec3 vViewDir;

float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

void main() {
  if (uStrength <= 0.001) discard;

  vec3 nL = normalize(vNormalL);
  vec3 velDir = normalize(uVelocityDirL);
  float facing = dot(nL, velDir);

  // Only the leading/shoulder region takes the atmospheric load. Side-slip and
  // vertical motion naturally move the shield hotspot to the appropriate side.
  float leading = smoothstep(-0.18, 0.76, facing);
  leading = pow(leading, 1.45);

  // Thin bow-shock concentration around the transition into the loaded region.
  float shockCoord = (facing - 0.38) * 4.4;
  float shockBand = exp(-shockCoord * shockCoord);
  float nose = pow(max(facing, 0.0), 7.0);

  // Use the absolute view-normal angle so front and back faces of the
  // double-sided shell have the same rim response.
  float rim = pow(
    1.0 - clamp(abs(dot(normalize(vViewNormal), normalize(vViewDir))), 0.0, 1.0),
    2.0
  );

  float flowA = 0.5 + 0.5 * sin(
    dot(vPosL, vec3(8.7, 5.1, 11.3)) + uTime * (4.0 + 8.0 * uSpeed01)
  );
  float flowB = 0.5 + 0.5 * sin(
    dot(vPosL.zxy, vec3(13.0, 7.3, 4.6)) - uTime * (6.0 + 11.0 * uSpeed01)
  );
  float grain = hash31(
    floor(vPosL * 19.0) + vec3(floor(uTime * 7.0))
  );
  float plasma = 0.72 + 0.14 * flowA + 0.10 * flowB + 0.04 * grain;

  float field =
    leading * (0.16 + 0.34 * rim) +
    shockBand * (0.11 + 0.24 * rim) +
    nose * (0.10 + 0.16 * uSpeed01);

  // Underwater and inside a gas giant the shield is an environmental pressure
  // envelope rather than a directional bow shock, so energize the full shell.
  float fullEnvelope = clamp(uFullEnvelope, 0.0, 1.0);
  float envelopeField = 0.26 + 0.34 * rim + 0.08 * plasma;
  field = mix(field, envelopeField, fullEnvelope);

  float alpha = clamp(uStrength * field * plasma, 0.0, 0.78);
  if (alpha <= 0.002) discard;

  vec3 cool = vec3(0.07, 0.58, 1.00);
  vec3 hot = vec3(0.82, 0.96, 1.00);
  vec3 color = mix(cool, hot, clamp(uSpeed01 * 0.82 + nose * 0.35, 0.0, 1.0));
  color += vec3(0.22, 0.34, 0.48) * shockBand * rim * uSpeed01;

  gl_FragColor = vec4(color, alpha);
}
`;

function createAtmosphericShieldMesh(THREE, model) {
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());

  // Give the shield a modest stand-off distance around the authored hull.
  const sx = Math.max(2.5, size.x * 0.62 + 0.75);
  const sy = Math.max(1.8, size.y * 0.68 + 0.65);
  const sz = Math.max(3.0, size.z * 0.60 + 1.05);

  const geometry = new THREE.SphereGeometry(1.0, 32, 18);
  const uniforms = {
    uVelocityDirL: { value: new THREE.Vector3(0, 0, -1) },
    uStrength: { value: 0.0 },
    uSpeed01: { value: 0.0 },
    uFullEnvelope: { value: 0.0 },
    uTime: { value: 0.0 },
  };
  const material = new THREE.ShaderMaterial({
    name: "PlayerAtmosphericShield",
    vertexShader: ATMOSPHERIC_SHIELD_VERTEX,
    fragmentShader: ATMOSPHERIC_SHIELD_FRAGMENT,
    uniforms,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "PlayerAtmosphericShield";
  mesh.position.copy(center);
  mesh.scale.set(sx, sy, sz);
  mesh.frustumCulled = true;
  mesh.renderOrder = 6;
  mesh.visible = false;
  return { mesh, uniforms };
}

const ROVER_WHEEL_TRACK_HALF = 2.80;

function createSurfaceRover(THREE) {
  const root = new THREE.Group();
  root.name = "PlayerSurfaceRover";

  const armorMat = new THREE.MeshStandardMaterial({
    name: "RoverArmor",
    color: 0x586671,
    roughness: 0.56,
    metalness: 0.52,
  });
  const darkArmorMat = new THREE.MeshStandardMaterial({
    name: "RoverDarkArmor",
    color: 0x222a30,
    roughness: 0.64,
    metalness: 0.58,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    name: "RoverGlass",
    color: 0x183443,
    roughness: 0.16,
    metalness: 0.24,
  });
  const tireMat = new THREE.MeshStandardMaterial({
    name: "RoverTires",
    color: 0x151719,
    roughness: 0.96,
    metalness: 0.08,
  });
  const hubMat = new THREE.MeshStandardMaterial({
    name: "RoverWheelHubs",
    color: 0x78858d,
    roughness: 0.42,
    metalness: 0.72,
  });

  const addBox = (name, size, pos, mat, bevelScale = null) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), mat);
    mesh.name = name;
    mesh.position.set(...pos);
    if (bevelScale) mesh.scale.set(...bevelScale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };

  // Low, broad six-wheeled armored rover silhouette. It is intentionally an
  // original procedural design rather than a copy of any specific game asset.
  addBox("RoverLowerHull", [4.6, 0.68, 6.8], [0, 0.92, 0.0], darkArmorMat);
  addBox("RoverUpperHull", [3.95, 0.68, 5.25], [0, 1.48, -0.15], armorMat);
  addBox("RoverNose", [3.35, 0.54, 1.65], [0, 1.25, -3.15], armorMat);
  addBox("RoverCabin", [3.0, 0.66, 2.35], [0, 1.95, -0.55], armorMat);
  const canopy = addBox(
    "RoverCanopy",
    [2.5, 0.34, 1.35],
    [0, 2.24, -0.95],
    glassMat,
  );
  canopy.rotation.x = -0.08;

  // Compact dorsal sensor/turret shape for a recognisable sci-fi APC profile.
  // The turret has independent yaw + barrel-pitch pivots so it can track the
  // free rover camera without steering or rotating the chassis itself.
  addBox("RoverTurretBase", [1.65, 0.24, 1.7], [0, 2.43, 0.75], darkArmorMat);

  const turretYaw = new THREE.Group();
  turretYaw.name = "RoverTurretYaw";
  turretYaw.position.set(0, 2.66, 0.72);
  root.add(turretYaw);

  const turret = new THREE.Mesh(
    new THREE.CylinderGeometry(0.66, 0.82, 0.42, 12),
    armorMat,
  );
  turret.name = "RoverTurret";
  turret.castShadow = true;
  turret.receiveShadow = true;
  turretYaw.add(turret);

  // Pitch around the breech rather than the barrel centre so the weapon stays
  // visually attached to the turret while aiming up/down.
  const turretPitch = new THREE.Group();
  turretPitch.name = "RoverTurretPitch";
  turretPitch.position.set(0, 0.11, -0.12);
  turretYaw.add(turretPitch);

  const sensor = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.16, 1.7, 10),
    darkArmorMat,
  );
  sensor.name = "RoverSensorBarrel";
  sensor.rotation.x = Math.PI * 0.5;
  sensor.position.set(0, 0, -0.85);
  sensor.castShadow = true;
  sensor.receiveShadow = true;
  turretPitch.add(sensor);

  const wheels = [];
  const wheelPivots = [];
  const wheelZ = [-2.35, 0.0, 2.35];
  for (const z of wheelZ) {
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.name = `RoverWheelPivot_${side < 0 ? "L" : "R"}_${z}`;
      pivot.position.set(side * ROVER_WHEEL_TRACK_HALF, 0.72, z);
      root.add(pivot);

      const tireGeometry = new THREE.CylinderGeometry(0.88, 0.88, 0.68, 20, 1);
      tireGeometry.rotateZ(Math.PI * 0.5);
      const tire = new THREE.Mesh(tireGeometry, tireMat);
      tire.name = "RoverWheel";
      tire.castShadow = true;
      tire.receiveShadow = true;
      pivot.add(tire);

      const hubGeometry = new THREE.CylinderGeometry(0.39, 0.39, 0.72, 16, 1);
      hubGeometry.rotateZ(Math.PI * 0.5);
      const hub = new THREE.Mesh(hubGeometry, hubMat);
      hub.name = "RoverWheelHub";
      hub.castShadow = true;
      hub.receiveShadow = true;
      pivot.add(hub);

      wheels.push({ tire, hub });
      wheelPivots.push({ pivot, side, z });
    }
  }

  // Small side fenders visually tie the wheel pairs into the chassis.
  for (const side of [-1, 1]) {
    addBox(
      `RoverFender_${side < 0 ? "L" : "R"}`,
      [0.28, 0.5, 5.8],
      [side * 2.08, 1.14, 0.0],
      darkArmorMat,
    );
  }

  root.visible = false;
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  return { root, wheels, wheelPivots, turretYaw, turretPitch };
}


const ROVER_DUST_VERTEX = `
attribute float aAlpha;
attribute float aSize;
varying float vAlpha;

void main() {
  vAlpha = aAlpha;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aSize * (300.0 / max(1.0, -mvPosition.z));
}
`;

const ROVER_DUST_FRAGMENT = `
uniform vec3 uColor;
uniform float uLight;
varying float vAlpha;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 >= 1.0) discard;
  float soft = 1.0 - smoothstep(0.18, 1.0, r2);
  float alpha = vAlpha * soft;
  if (alpha <= 0.003) discard;
  gl_FragColor = vec4(uColor * uLight, alpha);
}
`;

function createRoverDustSystem(THREE, maxParticles = 260) {
  const positions = new Float32Array(maxParticles * 3);
  const alphas = new Float32Array(maxParticles);
  const sizes = new Float32Array(maxParticles);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "aAlpha",
    new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "aSize",
    new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage),
  );

  const material = new THREE.ShaderMaterial({
    name: "RoverTerrainDust",
    vertexShader: ROVER_DUST_VERTEX,
    fragmentShader: ROVER_DUST_FRAGMENT,
    uniforms: {
      uColor: { value: new THREE.Color(0xb9a88f) },
      uLight: { value: 1.0 },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
  });

  const points = new THREE.Points(geometry, material);
  points.name = "RoverTerrainDust";
  points.frustumCulled = false;
  points.renderOrder = 2;
  points.visible = false;

  const particles = Array.from({ length: maxParticles }, () => ({
    active: false,
    posL: new THREE.Vector3(),
    velL: new THREE.Vector3(),
    age: 0.0,
    life: 1.0,
    size: 1.0,
    alpha: 0.0,
  }));

  return {
    points,
    geometry,
    positions,
    alphas,
    sizes,
    particles,
    nextIndex: 0,
    activeCount: 0,
  };
}

const SURFACE_WATER_FX_VERTEX = `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute float aAlpha;
attribute float aSize;
varying float vAlpha;

void main() {
  vAlpha = aAlpha;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aSize * (320.0 / max(1.0, -mvPosition.z));
  #include <logdepthbuf_vertex>
}
`;

const SURFACE_WATER_FX_FRAGMENT = `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uColor;
uniform float uLight;
varying float vAlpha;

void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 >= 1.0) discard;
  float core = 1.0 - smoothstep(0.0, 0.85, r2);
  float rim = smoothstep(0.18, 1.0, r2);
  float alpha = vAlpha * (core * 0.9 + rim * 0.18);
  if (alpha <= 0.003) discard;
  vec3 col = mix(uColor * 0.88, vec3(1.0), rim * 0.22);
  gl_FragColor = vec4(col * uLight, alpha);
  #include <logdepthbuf_fragment>
}
`;

function createSurfaceWaterFxSystem(THREE, maxParticles = 560) {
  const positions = new Float32Array(maxParticles * 3);
  const alphas = new Float32Array(maxParticles);
  const sizes = new Float32Array(maxParticles);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "aAlpha",
    new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "aSize",
    new THREE.BufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage),
  );

  const material = new THREE.ShaderMaterial({
    name: "SurfaceWaterFX",
    vertexShader: SURFACE_WATER_FX_VERTEX,
    fragmentShader: SURFACE_WATER_FX_FRAGMENT,
    uniforms: {
      uColor: { value: new THREE.Color(0xb9e7f3) },
      uLight: { value: 1.0 },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
  });

  const points = new THREE.Points(geometry, material);
  points.name = "SurfaceWaterFX";
  points.frustumCulled = false;
  points.renderOrder = 2;
  points.visible = false;

  const particles = Array.from({ length: maxParticles }, () => ({
    active: false,
    posL: new THREE.Vector3(),
    velL: new THREE.Vector3(),
    age: 0.0,
    life: 1.0,
    size: 1.0,
    alpha: 0.0,
    drag: 1.0,
    gravity: 4.0,
  }));

  return {
    points,
    geometry,
    positions,
    alphas,
    sizes,
    particles,
    nextIndex: 0,
    activeCount: 0,
  };
}


const SURFACE_WATER_SHEET_VERTEX = `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec2 aUv;
attribute float aAlpha;
attribute float aMode;
varying vec2 vUv;
varying float vAlpha;
varying float vMode;

void main() {
  vUv = aUv;
  vAlpha = aAlpha;
  vMode = aMode;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <logdepthbuf_vertex>
}
`;

const SURFACE_WATER_SHEET_FRAGMENT = `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uFoamColor;
uniform vec3 uRippleColor;
uniform float uLight;
varying vec2 vUv;
varying float vAlpha;
varying float vMode;

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float mode = step(0.5, vMode);
  float rr = length(p);
  float rippleBand = smoothstep(0.70, 0.56, rr) - smoothstep(0.90, 0.76, rr);
  rippleBand = max(rippleBand, 0.0);
  float rippleCenter = (1.0 - smoothstep(0.0, 0.34, rr)) * 0.12;
  float rippleShape = rippleBand + rippleCenter;

  vec2 foamP = vec2(p.x * 0.7, p.y);
  float foamBody = 1.0 - smoothstep(0.0, 1.0, dot(foamP, foamP));
  float foamRim = smoothstep(0.28, 0.96, 1.0 - dot(foamP, foamP));
  float foamShape = foamBody * (0.55 + 0.45 * foamRim);
  foamShape *= 0.82 + 0.18 * sin((p.x + p.y) * 9.0);
  foamShape = max(foamShape, 0.0);

  float shape = mix(foamShape, rippleShape, mode);
  float alpha = vAlpha * shape;
  if (alpha <= 0.003) discard;
  vec3 color = mix(uFoamColor, uRippleColor, mode);
  gl_FragColor = vec4(color * uLight, alpha);
  #include <logdepthbuf_fragment>
}
`;

function createSurfaceWaterSheetSystem(THREE, maxSheets = 240) {
  const vertexCount = maxSheets * 6;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const alphas = new Float32Array(vertexCount);
  const modes = new Float32Array(vertexCount);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "aUv",
    new THREE.BufferAttribute(uvs, 2),
  );
  geometry.setAttribute(
    "aAlpha",
    new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "aMode",
    new THREE.BufferAttribute(modes, 1).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setDrawRange(0, 0);

  const uvPattern = [0,0, 1,0, 1,1, 0,0, 1,1, 0,1];
  for (let i = 0; i < maxSheets; i++) {
    uvs.set(uvPattern, i * 12);
  }

  const material = new THREE.ShaderMaterial({
    name: "SurfaceWaterSheets",
    vertexShader: SURFACE_WATER_SHEET_VERTEX,
    fragmentShader: SURFACE_WATER_SHEET_FRAGMENT,
    uniforms: {
      uFoamColor: { value: new THREE.Color(0xdff9ff) },
      uRippleColor: { value: new THREE.Color(0x9fe5f0) },
      uLight: { value: 1.0 },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "SurfaceWaterSheets";
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.visible = false;

  const sheets = Array.from({ length: maxSheets }, () => ({
    active: false,
    posL: new THREE.Vector3(),
    velL: new THREE.Vector3(),
    normalL: new THREE.Vector3(0, 1, 0),
    tangentL: new THREE.Vector3(1, 0, 0),
    bitangentL: new THREE.Vector3(0, 0, 1),
    age: 0.0,
    life: 1.0,
    alpha: 0.0,
    mode: 0.0,
    sizeX0: 1.0,
    sizeY0: 1.0,
    sizeX1: 2.0,
    sizeY1: 2.0,
    spin: 0.0,
  }));

  return {
    mesh,
    geometry,
    positions,
    uvs,
    alphas,
    modes,
    sheets,
    nextIndex: 0,
    activeCount: 0,
    maxSheets,
  };
}

const ROVER_SKID_MARK_VERTEX = `
#include <common>
#include <logdepthbuf_pars_vertex>

attribute float aAlpha;
varying float vAlpha;

void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
`;

const ROVER_SKID_MARK_FRAGMENT = `
#include <common>
#include <logdepthbuf_pars_fragment>

uniform vec3 uColor;
varying float vAlpha;

void main() {
  float alpha = clamp(vAlpha, 0.0, 0.96);
  if (alpha <= 0.002) discard;
  gl_FragColor = vec4(uColor, alpha);
  #include <logdepthbuf_fragment>
}
`;

function createRoverSkidMarkSystem(THREE, maxSegments = 1800) {
  // Six non-indexed vertices per rectangular tire stamp. A fixed-size circular
  // buffer avoids allocations/rebuilds while skidding; once full, new tire
  // marks simply replace the oldest slots.
  const vertexCount = maxSegments * 6;
  const positions = new Float32Array(vertexCount * 3);
  const alphas = new Float32Array(vertexCount);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute(
    "aAlpha",
    new THREE.BufferAttribute(alphas, 1).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setDrawRange(0, 0);

  const material = new THREE.ShaderMaterial({
    name: "RoverSkidMarks",
    vertexShader: ROVER_SKID_MARK_VERTEX,
    fragmentShader: ROVER_SKID_MARK_FRAGMENT,
    uniforms: {
      // Dark rubber deposit. The shader stays tone-map independent so the marks
      // remain readable across bright and dim terrain without glowing.
      uColor: { value: new THREE.Color(0x17120f) },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1.0,
    polygonOffsetUnits: -2.0,
    toneMapped: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "RoverSkidMarks";
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.visible = false;

  return {
    mesh,
    geometry,
    positions,
    alphas,
    maxSegments,
    nextSegment: 0,
    segmentCount: 0,
  };
}


export function createPlayerController(world) {
  const {
    renderer,
    scene,
    camera,
    PLAYER_SHIP_LAYER,
    msg,
    crosshair,
    bodies,
    rebuildSystemForWarp,
    sunLight,
    sun,
    SUN_RADIUS,
  } = world;

  const playerShip = {
    root: null,
    model: null,
    loaded: false,
    // Simple chase camera so the ship is visible while flying.
    chaseEnabled: true,
    chaseDist: 14.0,
    chaseUp: 5.0,
    chaseSide: 0.0,
    chaseLag: 20.0, // higher = snappier
    camPos: new THREE.Vector3(),
    // Deliberately simple flight collider. Asteroids use approximate spheres,
    // so this does not need to match the GLB hull exactly.
    collisionRadius: 3.0,
    // Chase-camera terrain collider. This is swept from the ship to the desired
    // camera point so the camera cannot tunnel through hills/mountains.
    cameraCollisionRadius: 0.8,
    cameraCollisionSkin: 0.12,
    // Smoothly fade the ship out when terrain collision pushes the chase camera
    // very close to it, so the hull cannot fill/block the view.
    fadeNear: 3.5,
    fadeFar: 8.0,
    fadeFactor: 1.0,
    fadeMaterials: [],
    atmosphericShield: null,
    atmosphericShieldUniforms: null,
    atmosphericShieldStrength: 0.0,
    atmosphericShieldTime: 0.0,
    // Final root-local wingtip emitter positions, tuned visually against the ship.
    wingTipLeftL: new THREE.Vector3(-2.95, 0.40, 4.95),
    wingTipRightL: new THREE.Vector3(2.95, 0.40, 4.45),
    // Trails render in their own foreground scene. Each streak stores samples
    // in its atmospheric body's local frame, then rebuilds world-space ribbon
    // geometry every frame so the condensation follows the body's orbit/spin.
    wingTrailScene: new THREE.Scene(),
    wingTrailLeft: null,
    wingTrailRight: null,
    wingTrailTime: 0.0,
    // Reused eclipse buffers for trail lighting. The candidate list comes from
    // the same world helper used by atmosphere/ocean/terrain/ring rendering.
    wingTrailOccCenters: new Float32Array((world.MAX_OCCLUDERS ?? 24) * 3),
    wingTrailOccRadii: new Float32Array(world.MAX_OCCLUDERS ?? 24),
    wingTrailOccPass: {
      body: null,
      mat: {
        uniforms: {
          uPlanetCenterW: { value: new THREE.Vector3() },
          uSunPosW: { value: new THREE.Vector3() },
        },
      },
    },
    // Completed streaks hold briefly, then retract from their oldest end.
    // This makes trails disappear by shrinking through their stored path
    // instead of having every segment fade away at nearly the same moment.
    wingTrailLife: 3.0,
    wingTrailFadeDelay: 0.6,
    wingTrailGrowDuration: 0.48,
    waterFxAccumulator: 0.0,
    waterImmersion: 0.0,
  };

  const roverModel = createSurfaceRover(THREE);
  const roverDust = createRoverDustSystem(THREE);
  // Water interaction is a foreground presentation effect just like the
  // atmospheric shield and wingtip trails. Particle geometry remains in each
  // host body's local coordinates, while this dedicated scene is rendered only
  // after ocean/atmosphere/underwater compositing has finished.
  const surfaceWaterFxScene = new THREE.Scene();
  surfaceWaterFxScene.name = "SurfaceWaterFXForeground";
  const surfaceWaterFxByBody = new Map();
  const surfaceWaterSheetFxByBody = new Map();
  const ROVER_PHYSICS_DT = 1.0 / 60.0;
  const ROVER_MAX_SUBSTEPS = 5;
  const ROVER_MASS = 3600.0;
  const ROVER_INERTIA = new THREE.Vector3(17400.0, 21600.0, 9600.0);
  const ROVER_WHEEL_RADIUS = 0.88;
  const ROVER_SUSPENSION_MOUNT_Y = 1.50;
  const ROVER_SUSPENSION_REST = 1.20;
  const ROVER_SUSPENSION_MIN = 0.25;
  const ROVER_SUSPENSION_MAX = 1.72;
  const ROVER_CHASSIS_COLLIDERS = [
    { name: "bellyCenter", offset: new THREE.Vector3(0.0, 0.60, 0.0), radius: 0.40 },
    { name: "bellyFront", offset: new THREE.Vector3(0.0, 0.62, -1.9), radius: 0.42 },
    { name: "bellyRear", offset: new THREE.Vector3(0.0, 0.62, 1.9), radius: 0.42 },
    { name: "frontBumper", offset: new THREE.Vector3(0.0, 1.10, -3.62), radius: 0.56 },
    { name: "rearBumper", offset: new THREE.Vector3(0.0, 0.94, 3.42), radius: 0.52 },
    { name: "leftRail", offset: new THREE.Vector3(-1.94, 0.78, 0.0), radius: 0.43 },
    { name: "rightRail", offset: new THREE.Vector3(1.94, 0.78, 0.0), radius: 0.43 },
  ];
  // Distributed float volumes keep water interaction physical without making
  // the six suspension wheels into buoyancy points. These live in the same
  // stationary host-body local frame as the rest of rover physics.
  const ROVER_BUOYANCY_PROBES = [
    new THREE.Vector3(-1.65, 0.82, -2.45),
    new THREE.Vector3(1.65, 0.82, -2.45),
    new THREE.Vector3(-1.85, 0.72, 0.0),
    new THREE.Vector3(1.85, 0.72, 0.0),
    new THREE.Vector3(-1.55, 0.76, 2.35),
    new THREE.Vector3(1.55, 0.76, 2.35),
  ];

  const playerVehicle = {
    root: roverModel.root,
    wheels: roverModel.wheels,
    wheelPivots: roverModel.wheelPivots,
    turretYaw: roverModel.turretYaw,
    turretPitch: roverModel.turretPitch,
    dust: roverDust,
    // Skid geometry is stored per host body and parented directly under that
    // body's group. Marks therefore remain fixed to the terrain while the
    // planet/moon translates, rotates, or orbits in world space.
    skidMarksByBody: new Map(),
    deployed: false,
    bodyIndex: 0,

    // Physics is deliberately solved in the host body's LOCAL frame. The host
    // planet/moon is therefore stationary to the solver: orbital translation,
    // spin, and parent-body motion never leak into rover velocities. Rendering
    // alone converts this local rigid-body transform back to world space.
    positionL: new THREE.Vector3(),
    orientationL: new THREE.Quaternion(),
    linearVelocityL: new THREE.Vector3(),
    angularVelocityL: new THREE.Vector3(),
    forceL: new THREE.Vector3(),
    torqueL: new THREE.Vector3(),
    mass: ROVER_MASS,
    invMass: 1.0 / ROVER_MASS,
    inertia: ROVER_INERTIA.clone(),
    invInertia: new THREE.Vector3(
      1.0 / ROVER_INERTIA.x,
      1.0 / ROVER_INERTIA.y,
      1.0 / ROVER_INERTIA.z,
    ),
    gravity: 11.5,
    physicsDt: ROVER_PHYSICS_DT,
    physicsAccumulator: 0.0,
    maxSubsteps: ROVER_MAX_SUBSTEPS,

    // Compatibility/telemetry fields. They are derived from the rigid-body
    // state rather than driving it.
    dirLocal: new THREE.Vector3(0, 1, 0),
    yaw: 0.0,
    speed: 0.0,
    onGround: true,
    contactCount: 0,

    wheelRadius: ROVER_WHEEL_RADIUS,
    steeringInput: 0.0,
    steeringAngle: 0.0,
    throttleInput: 0.0,
    boostInput: false,
    skidStrength: 0.0,
    peakSlip: 0.0,
    impactStrength: 0.0,
    feedbackTime: 0.0,
    jumpRequested: false,
    jumpWasDown: false,

    suspension: roverModel.wheelPivots.map((wheelInfo) => ({
      side: wheelInfo.side,
      z: wheelInfo.z,
      pivot: wheelInfo.pivot,
      mountLocal: new THREE.Vector3(
        wheelInfo.side * ROVER_WHEEL_TRACK_HALF,
        ROVER_SUSPENSION_MOUNT_Y,
        wheelInfo.z,
      ),
      springLength: ROVER_SUSPENSION_REST,
      restLength: ROVER_SUSPENSION_REST,
      minLength: ROVER_SUSPENSION_MIN,
      maxLength: ROVER_SUSPENSION_MAX,
      contact: false,
      normalLoad: 0.0,
      steerAngle: 0.0,
      longitudinalSpeed: 0.0,
      lateralSpeed: 0.0,
      wheelCenterL: new THREE.Vector3(),
      contactPointL: new THREE.Vector3(),
      surfaceNormalL: new THREE.Vector3(0, 1, 0),
      spinAngle: 0.0,
      angularSpeed: 0.0,
      surfaceSpeed: 0.0,
      slipRatio: 0.0,
      slipAngle: 0.0,
      slipAmount: 0.0,
      longitudinalForce: 0.0,
      lateralForce: 0.0,
      waterDepth: 0.0,
      waterSubmersion: 0.0,
      sprayAccumulator: 0.0,
      dustAccumulator: 0.0,
      skidMarkActive: false,
      skidMarkBodyIndex: -1,
      skidMarkLastPointL: new THREE.Vector3(),
      skidMarkLastNormalL: new THREE.Vector3(0, 1, 0),
    })),

    // Simple terrain-contact spheres protect the actual chassis when the
    // suspension bottoms out or a bumper hits a steep slope. These are solved
    // in the same stationary host-body local frame as the wheel suspension.
    chassisContacts: ROVER_CHASSIS_COLLIDERS.map((c) => ({
      name: c.name,
      offset: c.offset.clone(),
      radius: c.radius,
      touching: false,
      penetration: 0.0,
      centerL: new THREE.Vector3(),
      contactPointL: new THREE.Vector3(),
      surfaceNormalL: new THREE.Vector3(0, 1, 0),
    })),
    chassisContactCount: 0,
    buoyancyProbes: ROVER_BUOYANCY_PROBES.map((offset) => ({
      offset: offset.clone(),
      pointL: new THREE.Vector3(),
      depth: 0.0,
      submersion: 0.0,
    })),
    waterSubmersion: 0.0,
    inWater: false,
    waterFxAccumulator: 0.0,
    airborneTime: 0.0,
    landingImpact: 0.0,
    landingKick: 0.0,

    // Free rover-camera frame captured when entering the vehicle. Neither the
    // chassis nor the rover's changing radial horizon is allowed to rotate
    // these vectors afterward; only explicit look input changes camForwardL.
    camForwardL: new THREE.Vector3(0, 0, -1),
    camUpL: new THREE.Vector3(0, 1, 0),
    camPitch: THREE.MathUtils.degToRad(13),
    camDist: 13.5,
    camUp: 4.2,
    camLag: 13.0,
    camPos: new THREE.Vector3(),
    // Reuse the fly-mode proximity fade behavior for the rover when terrain
    // collision pushes its free-orbit camera close to the chassis. This only
    // affects vehicle presentation; it never changes the free camera frame.
    cameraCollisionRadius: 0.8,
    cameraCollisionSkin: 0.12,
    fadeNear: 3.5,
    fadeFar: 8.0,
    fadeFactor: 1.0,
    fadeMaterials: [],
  };
  scene.add(playerVehicle.root);
  if (sunLight) registerSPLMaterialsIn(playerVehicle.root, sunLight);

  // The rover is procedural and owns its materials, but several meshes share
  // the same material object. Record each unique material exactly once so the
  // near-camera fade can restore the authored opaque/transparent state cleanly.
  {
    const seen = new Set();
    playerVehicle.root.traverse((o) => {
      if (!o?.isMesh) return;
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of materials) {
        if (!mat || seen.has(mat)) continue;
        seen.add(mat);
        playerVehicle.fadeMaterials.push({
          material: mat,
          opacity: Number.isFinite(mat.opacity) ? mat.opacity : 1.0,
          transparent: !!mat.transparent,
          depthWrite: mat.depthWrite !== false,
        });
      }
    });
  }

  (function loadPlayerShip() {
    const loader = new GLTFLoader();
    // Model by yanix.
    // https://sketchfab.com/3d-models/space-ship-356a3acb00164c698d657146caa5ebf3
    loader.load(
      "./assets/space_ship.glb",
      (gltf) => {
        // IMPORTANT: the ship's world orientation is overwritten every
        // frame from `flyQuat`. So any model alignment MUST live on a
        // child (the GLTF scene), not on the root transform.
        const root = new THREE.Object3D();
        root.name = "PlayerShipRoot";
        playerShip.root = root;

        const model = gltf.scene;
        model.name = "PlayerShipModel";
        playerShip.model = model;

        // Keep it simple: user can edit scale/rotation here if needed.
        const PLAYER_SHIP_SCALE = 1.0;
        model.scale.setScalar(PLAYER_SHIP_SCALE);

        // Orientation fix: many GLB ships are authored facing +X,
        // while this game treats -Z as forward.
        // Apply yaw on the *model* so `flyQuat` can't overwrite it.
        // Try -90° first: a lot of GLB ships are authored facing +X.
        // +X rotated -90° about Y becomes -Z (this game's forward).
        // If your model is different, tweak to Math.PI*0.5 or Math.PI.
        const PLAYER_SHIP_YAW = -Math.PI * 0.5;
        model.rotation.y = PLAYER_SHIP_YAW;

        // Keep ship materials private to this model so camera-distance fading
        // cannot alter a material shared elsewhere by the GLTF/runtime.
        const materialClones = new Map();
        const fadeMaterialSet = new Set();
        model.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = true;
          o.receiveShadow = true;

          const cloneMaterial = (src) => {
            if (!src) return src;
            let clone = materialClones.get(src);
            if (!clone) {
              clone = src.clone();
              materialClones.set(src, clone);
            }
            if (!fadeMaterialSet.has(clone)) {
              fadeMaterialSet.add(clone);
              playerShip.fadeMaterials.push({
                material: clone,
                opacity: Number.isFinite(clone.opacity) ? clone.opacity : 1.0,
                transparent: !!clone.transparent,
                depthWrite: clone.depthWrite !== false,
              });
            }
            return clone;
          };

          if (Array.isArray(o.material)) {
            o.material = o.material.map(cloneMaterial);
          } else {
            o.material = cloneMaterial(o.material);
          }
        });

        // Patch ship materials so SuperPointLight does not double-illuminate them
        if (sunLight) registerSPLMaterialsIn(model, sunLight);

        root.add(model);

        // Trail samples retain their emitted path as the ship turns, but each
        // streak is anchored to its atmospheric body rather than PlayerShipRoot.
        // The dedicated foreground scene keeps ordinary ocean/atmosphere post
        // passes from compositing over the condensation.
        playerShip.wingTrailLeft = createWingTrailRibbon(THREE);
        playerShip.wingTrailRight = createWingTrailRibbon(THREE);
        playerShip.wingTrailScene.add(playerShip.wingTrailLeft.mesh);
        playerShip.wingTrailScene.add(playerShip.wingTrailRight.mesh);

        // Velocity-reactive atmospheric shield. The shell stays completely
        // disabled in vacuum/at low speed and only lights the part of the field
        // that is actually facing the relative wind.
        const shield = createAtmosphericShieldMesh(THREE, model);
        playerShip.atmosphericShield = shield.mesh;
        playerShip.atmosphericShieldUniforms = shield.uniforms;
        root.add(shield.mesh);

        // Put the entire ship on its own layer so we can (optionally)
        // re-render it on top of fullscreen effects like warp.
        root.traverse((o) => o.layers.set(PLAYER_SHIP_LAYER));

        root.visible = false; // shown in fly mode
        scene.add(root);
        playerShip.loaded = true;
        console.log("Loaded player ship: space_ship.glb");
      },
      undefined,
      (err) => {
        // Silent-ish: game still runs fine without a ship model.
        console.warn("Could not load ./space_ship.glb (optional).", err);
      },
    );
  })();

  const input = createInput(renderer.domElement, {
    crosshairEl: crosshair,
    msgEl: msg,
  });
  const keys = input.keys;

  let yaw = 0,
    pitch = 0,
    roll = 0;
  let rollVel = 0;
  let autoBank = 0.0;
  const ROLL_ACCEL = 4.5;
  const ROLL_DAMP = 3.0;
  const ROLL_MAX = 2.6;
  const PLANET_FLIGHT_ASSIST_FULL_ALT = 600.0;
  const PLANET_FLIGHT_ASSIST_MAX_ALT = 1000.0;
  const PLANET_AUTO_BANK_MAX = THREE.MathUtils.degToRad(32.0);

  const flyQuat = new THREE.Quaternion();

  ////////////////////////////////////////////////////////////////////////////////
  // Player + helpers
  ////////////////////////////////////////////////////////////////////////////////
  const tmp = {
    qYaw: new THREE.Quaternion(),
    qPitch: new THREE.Quaternion(),
    refAxis: new THREE.Vector3(),
    eastL: new THREE.Vector3(),
    northL: new THREE.Vector3(),
    forwardYawL: new THREE.Vector3(),
    rightYawL: new THREE.Vector3(),
    camForwardL: new THREE.Vector3(),
    camUpL: new THREE.Vector3(),
    forwardMoveL: new THREE.Vector3(),
    rightMoveL: new THREE.Vector3(),
    moveDirL: new THREE.Vector3(),
    axisL: new THREE.Vector3(),
    playerPosL: new THREE.Vector3(),
    playerPosW: new THREE.Vector3(),
    eyePosW: new THREE.Vector3(),
    worldQuat: new THREE.Quaternion(),
    camForwardW: new THREE.Vector3(),
    camUpW: new THREE.Vector3(),
    lookForwardW: new THREE.Vector3(),
    lookRightW: new THREE.Vector3(),
    lookUpW: new THREE.Vector3(),
    planetUpW: new THREE.Vector3(),
    horizonRightW: new THREE.Vector3(),
    horizonUpW: new THREE.Vector3(),
    bankedUpW: new THREE.Vector3(),
    vA: new THREE.Vector3(),
    vB: new THREE.Vector3(),
    vC: new THREE.Vector3(),
    vD: new THREE.Vector3(),
    vE: new THREE.Vector3(),
    vF: new THREE.Vector3(),
    dq: new THREE.Quaternion(),
    mLook: new THREE.Matrix4(),
    qLook: new THREE.Quaternion(),
    qBank: new THREE.Quaternion(),
    sunPosW: new THREE.Vector3(),
    sunAimW: new THREE.Vector3(),
    sunRight: new THREE.Vector3(),
    sunUp: new THREE.Vector3(),
    sunFwd: new THREE.Vector3(),
    collisionStartW: new THREE.Vector3(),
    collisionMotionStartW: new THREE.Vector3(),
    collisionMotionEndW: new THREE.Vector3(),
    collisionDeltaW: new THREE.Vector3(),
    collisionContactW: new THREE.Vector3(),
    collisionRemainingW: new THREE.Vector3(),
    cameraCastStartW: new THREE.Vector3(),
    cameraCastEndW: new THREE.Vector3(),
    cameraCastDirW: new THREE.Vector3(),
    cameraCastSampleW: new THREE.Vector3(),
    cameraCastSampleL: new THREE.Vector3(),
    cameraCastCenterW: new THREE.Vector3(),
    cameraCastInvQ: new THREE.Quaternion(),
    shieldCenterW: new THREE.Vector3(),
    shieldVelocityDirL: new THREE.Vector3(),
    shieldInvQ: new THREE.Quaternion(),
    gasShakeRightW: new THREE.Vector3(),
    gasShakeUpW: new THREE.Vector3(),
    gasShakeForwardW: new THREE.Vector3(),
    gasShakeQ1: new THREE.Quaternion(),
    gasShakeQ2: new THREE.Quaternion(),
    trailPrevQuat: new THREE.Quaternion(),
    trailTipLeftW: new THREE.Vector3(),
    trailTipRightW: new THREE.Vector3(),
    trailTipLocal: new THREE.Vector3(),
    trailBodyCenterW: new THREE.Vector3(),
    trailSunW: new THREE.Vector3(),
    trailSunDirW: new THREE.Vector3(),
    trailToSunW: new THREE.Vector3(),
    trailNormalW: new THREE.Vector3(),
    trailMidW: new THREE.Vector3(),
    trailDirW: new THREE.Vector3(),
    trailViewW: new THREE.Vector3(),
    trailSideW: new THREE.Vector3(),
    trailStartW: new THREE.Vector3(),
    trailEndW: new THREE.Vector3(),
    trailA0: new THREE.Vector3(),
    trailA1: new THREE.Vector3(),
    trailB0: new THREE.Vector3(),
    trailB1: new THREE.Vector3(),
    vehicleUpL: new THREE.Vector3(),
    vehicleForwardL: new THREE.Vector3(),
    vehicleRightL: new THREE.Vector3(),
    vehicleForwardW: new THREE.Vector3(),
    vehicleRightW: new THREE.Vector3(),
    vehicleUpW: new THREE.Vector3(),
    vehicleBackwardW: new THREE.Vector3(),
    vehicleExitDirL: new THREE.Vector3(),
    vehicleBasis: new THREE.Matrix4(),
    vehicleWorldQuat: new THREE.Quaternion(),
    vehicleBodyWorldQuat: new THREE.Quaternion(),
    vehicleBodyInvQuat: new THREE.Quaternion(),
    vehiclePhysicsUpL: new THREE.Vector3(),
    vehiclePhysicsDownL: new THREE.Vector3(),
    vehiclePhysicsForwardL: new THREE.Vector3(),
    vehiclePhysicsRightL: new THREE.Vector3(),
    vehicleMountL: new THREE.Vector3(),
    vehicleProbeL: new THREE.Vector3(),
    vehicleProbeA: new THREE.Vector3(),
    vehicleProbeB: new THREE.Vector3(),
    vehicleNormalL: new THREE.Vector3(),
    vehiclePointVelL: new THREE.Vector3(),
    vehicleLeverL: new THREE.Vector3(),
    vehicleForceTmpL: new THREE.Vector3(),
    vehicleTorqueTmpL: new THREE.Vector3(),
    vehicleTorqueBody: new THREE.Vector3(),
    vehicleAlphaBody: new THREE.Vector3(),
    vehicleAlphaL: new THREE.Vector3(),
    vehicleWheelForwardL: new THREE.Vector3(),
    vehicleWheelRightL: new THREE.Vector3(),
    vehicleRadialUpL: new THREE.Vector3(),
    vehicleDQ: new THREE.Quaternion(),
    vehicleInvOrientationL: new THREE.Quaternion(),
    vehicleSteerQ: new THREE.Quaternion(),
    vehicleTurretAimL: new THREE.Vector3(0, 0, -1),
    vehicleDustBodyCenterW: new THREE.Vector3(),
    vehicleDustSunW: new THREE.Vector3(),
    vehicleDustPosW: new THREE.Vector3(),
    vehicleDustNormalW: new THREE.Vector3(),
    vehicleDustSunDirW: new THREE.Vector3(),
    vehicleSkidDirL: new THREE.Vector3(),
    vehicleSkidNormalL: new THREE.Vector3(),
    vehicleSkidSideA: new THREE.Vector3(),
    vehicleSkidSideB: new THREE.Vector3(),
    vehicleSkidP0: new THREE.Vector3(),
    vehicleSkidP1: new THREE.Vector3(),
    vehicleSkidP2: new THREE.Vector3(),
    vehicleSkidP3: new THREE.Vector3(),
    waterFxPointL: new THREE.Vector3(),
    waterFxPointW: new THREE.Vector3(),
    waterFxNormalL: new THREE.Vector3(),
    waterFxNormalW: new THREE.Vector3(),
    waterFxForwardL: new THREE.Vector3(),
    waterFxRightL: new THREE.Vector3(),
    waterFxVelL: new THREE.Vector3(),
    waterFxCenterW: new THREE.Vector3(),
    waterFxSunW: new THREE.Vector3(),
    waterFxSunDirW: new THREE.Vector3(),
    waterSampleLocal: new THREE.Vector3(),
    waterSampleWorld: new THREE.Vector3(),
    waterUpLocal: new THREE.Vector3(),
    waterUpWorld: new THREE.Vector3(),
    waterCenterWorld: new THREE.Vector3(),
    waterPointVelocity: new THREE.Vector3(),
    waterForce: new THREE.Vector3(),
  };

  const player = {
    mode: "walk",
    bodyIndex: 0,
    dirLocal: new THREE.Vector3(0, 1, 0),
    height: 1.7,
    radialVel: 0.0,
    radialOffset: 0.0,
    onGround: true,
    worldPos: new THREE.Vector3(0, 0, 0),
    worldVel: new THREE.Vector3(0, 0, 0),
    walkSpeed: 3.8,
    walkSprint: 6.8,
    flyAccel: 28.0,
    flyBoostAccel: 300.0,
    flyDamp: 0.992,
    followIndex: -1,
    followPosL: new THREE.Vector3(0, 0, 0),
    followVelL: new THREE.Vector3(0, 0, 0),
    noclip: false,
    landing: false,
    inWater: false,
    swimming: false,
    waterDepth: 0.0,
    waterFxAccumulator: 0.0,
    wasInWater: false,
  };

  const landingUI = document.getElementById("landingUI");
  const gasGiantWarningUI = document.getElementById("gasGiantWarning");
  function setLandingSequenceVisible(visible) {
    if (!landingUI) return;
    landingUI.classList.toggle("on", !!visible);
    landingUI.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  function setGasGiantWarningVisible(visible) {
    if (!gasGiantWarningUI) return;
    gasGiantWarningUI.classList.toggle("on", !!visible);
    gasGiantWarningUI.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  const gasGiantEnvironment = {
    body: null,
    density: 0.0,
    inAtmosphere: false,
    insideBody: false,
  };
  let gasGiantShakeTime = 0.0;
  let gasGiantShakeStrength = 0.0;
  const gasGiantShakeNoise = {
    low: new THREE.Vector3(),
    lowTarget: new THREE.Vector3(),
    high: new THREE.Vector3(),
    highTarget: new THREE.Vector3(),
    impulse: new THREE.Vector3(),
    nextLowChange: 0.0,
    nextHighChange: 0.0,
    nextImpulse: 0.0,
  };

  const landing = {
    active: false,
    bodyIndex: -1,
    elapsed: 0.0,
    duration: 1.5,
    startRadius: 0.0,
    targetRadius: 0.0,
    walkYaw: 0.0,
    cameraHandoffCaptured: false,
    dirLocal: new THREE.Vector3(),
    startQuat: new THREE.Quaternion(),
    targetLocalQuat: new THREE.Quaternion(),
    cameraHandoffStart: new THREE.Vector3(),
  };

  // Assigned later (after makeWarpController is created). Declared here so
  // helper functions can safely reference it without TDZ issues.
  let warpCtrl = null;

  // UI handles (declared up-front so helpers can reference them safely)
  let galaxyOverlayUI = null;
  let galaxyMiniMapUI = null;

  // Galaxy UI (full overlay + minimap)
  const isGalaxyOpen = () => galaxyOverlayUI?.isOpen?.() ?? false;

  galaxyOverlayUI = createGalaxyOverlay({
    THREE,
    input,
    msgEl: msg,
    // Keep the overlay centered on the current system in galaxy-space.
    // world.galaxyPlayer is updated during warp/system transitions.
    galaxyPlayer: world.galaxyPlayer,
    getWarpCtrl: () => warpCtrl,
    getPlayer: () => player,
  });

  galaxyMiniMapUI = createGalaxyMiniMap({
    THREE,
    camera,
    getBodies: () => bodies,
    nearestBodyInfo: (wp) => nearestBodyInfo(wp),
    getPlayerWorldPos: () => player?.worldPos,
  });

  ////////////////////////////////////////////////////////////////////////////////
  // Ship model sync + fly camera helper
  // - player.worldPos is ALWAYS the ship/player position.
  // - camera may be offset behind the ship in fly mode (chase cam).
  ////////////////////////////////////////////////////////////////////////////////
  function shipChaseActive() {
    return (
      playerShip?.loaded && playerShip?.chaseEnabled && player?.mode === "fly"
    );
  }

  function syncPlayerShipVisibility() {
    if (player.mode !== "fly") setGasGiantWarningVisible(false);
    if (!playerShip?.loaded || !playerShip.root) return;
    // Keep the ship visible during warp as well. (The warp controller may
    // temporarily lock input or change camera behavior, but the player model
    // should remain rendered throughout the effect.) Never show during the
    // full galaxy overlay.
    const warping = !!warpCtrl?.warp?.active;
    playerShip.root.visible =
      !isGalaxyOpen() && (player.mode === "fly" || warping);

    // Reset chase camera accumulator when leaving fly mode.
    if (player.mode !== "fly") {
      playerShip.camPos.set(0, 0, 0);
      if (playerShip.atmosphericShield) playerShip.atmosphericShield.visible = false;
      clearWingTrails();
    }
  }

  function updatePlayerShipCameraFade() {
    if (!playerShip?.loaded || !playerShip.root || !playerShip.fadeMaterials.length)
      return;

    const nearD = Math.max(0.0, Number(playerShip.fadeNear) || 3.5);
    const farD = Math.max(nearD + 0.01, Number(playerShip.fadeFar) || 8.0);
    const dist = camera.position.distanceTo(player.worldPos);
    const t = THREE.MathUtils.clamp((dist - nearD) / (farD - nearD), 0.0, 1.0);
    // Cubic smoothstep keeps both ends derivative-free, avoiding a visible pop
    // when the camera collision system moves in/out of the fade range.
    const fade = t * t * (3.0 - 2.0 * t);
    const fullyOpaque = t >= 1.0;

    // Do not epsilon-skip the transition back to fully opaque. Previously a
    // fadeFactor such as 0.999 could be considered "close enough" to 1.0 and
    // leave the ship material permanently in Three.js' transparent render path.
    if (
      Math.abs(fade - playerShip.fadeFactor) < 0.002 &&
      !(fullyOpaque && playerShip.fadeFactor < 1.0)
    ) {
      return;
    }
    playerShip.fadeFactor = fullyOpaque ? 1.0 : fade;

    for (const rec of playerShip.fadeMaterials) {
      const mat = rec.material;
      if (!mat) continue;

      if (fullyOpaque) {
        // Restore the exact authored opaque/material state. This puts ordinary
        // opaque hull materials back on the normal opaque renderer/shader path
        // instead of keeping them as transparent materials with opacity 1.
        mat.opacity = rec.opacity;
        const transparencyChanged = mat.transparent !== rec.transparent;
        mat.transparent = rec.transparent;
        mat.depthWrite = rec.depthWrite;
        if (transparencyChanged) mat.needsUpdate = true;
        continue;
      }

      mat.opacity = rec.opacity * fade;
      if (!mat.transparent) {
        mat.transparent = true;
        mat.needsUpdate = true;
      }
      // While fading, do not let an almost-transparent hull write depth and
      // occlude terrain/space behind it.
      mat.depthWrite = false;
    }
  }

  function setSurfaceVehicleFadeFactor(fadeValue) {
    if (!playerVehicle?.fadeMaterials?.length) return;

    const fade = THREE.MathUtils.clamp(Number(fadeValue) || 0.0, 0.0, 1.0);
    const fullyOpaque = fade >= 0.999999;
    if (
      Math.abs(fade - playerVehicle.fadeFactor) < 0.002 &&
      !(fullyOpaque && playerVehicle.fadeFactor < 1.0)
    ) {
      return;
    }
    playerVehicle.fadeFactor = fullyOpaque ? 1.0 : fade;

    for (const rec of playerVehicle.fadeMaterials) {
      const mat = rec.material;
      if (!mat) continue;

      if (fullyOpaque) {
        mat.opacity = rec.opacity;
        const transparencyChanged = mat.transparent !== rec.transparent;
        mat.transparent = rec.transparent;
        mat.depthWrite = rec.depthWrite;
        if (transparencyChanged) mat.needsUpdate = true;
        continue;
      }

      mat.opacity = rec.opacity * fade;
      if (!mat.transparent) {
        mat.transparent = true;
        mat.needsUpdate = true;
      }
      mat.depthWrite = false;
    }
  }

  function updateSurfaceVehicleCameraFade() {
    if (!playerVehicle?.deployed || !playerVehicle.root) {
      setSurfaceVehicleFadeFactor(1.0);
      return;
    }

    const nearD = Math.max(0.0, Number(playerVehicle.fadeNear) || 3.5);
    const farD = Math.max(nearD + 0.01, Number(playerVehicle.fadeFar) || 8.0);
    const dist = camera.position.distanceTo(playerVehicle.root.position);
    const t = THREE.MathUtils.clamp((dist - nearD) / (farD - nearD), 0.0, 1.0);
    const fade = t * t * (3.0 - 2.0 * t);
    setSurfaceVehicleFadeFactor(t >= 1.0 ? 1.0 : fade);
  }

  function sampleGasGiantEnvironment(near = null) {
    gasGiantEnvironment.body = null;
    gasGiantEnvironment.density = 0.0;
    gasGiantEnvironment.inAtmosphere = false;
    gasGiantEnvironment.insideBody = false;

    if (player.mode !== "fly") return gasGiantEnvironment;

    const nearest = near ?? nearestBodyInfo(player.worldPos);
    if (nearest?.i < 0) return gasGiantEnvironment;
    const body = bodies[nearest.i];
    if (!body?.isGasGiant || !body?.group || body.hasAtmo === false) {
      return gasGiantEnvironment;
    }

    const baseR = body.cfg?.baseRadius ?? body.baseRadius ?? 0.0;
    if (!(baseR > 0.0)) return gasGiantEnvironment;

    body.group.getWorldPosition(tmp.shieldCenterW);
    const dist = player.worldPos.distanceTo(tmp.shieldCenterW);
    const atmoH = Math.max(1.0, baseR * 0.33);
    const atmoR = baseR + atmoH;
    if (dist >= atmoR) return gasGiantEnvironment;

    let density = THREE.MathUtils.clamp((atmoR - dist) / atmoH, 0.0, 1.0);
    density = density * density * (3.0 - 2.0 * density);

    gasGiantEnvironment.body = body;
    gasGiantEnvironment.density = density;
    gasGiantEnvironment.inAtmosphere = true;
    gasGiantEnvironment.insideBody = dist < baseR;
    return gasGiantEnvironment;
  }

  function applyGasGiantCameraShake(dt, env) {
    gasGiantShakeTime += Math.max(0.0, dt);

    const speed = player.worldVel.length();
    const speed01 = THREE.MathUtils.smoothstep(speed, 18.0, 240.0);
    let target = 0.0;
    if (env?.inAtmosphere) {
      target = env.density * (0.38 + 0.92 * speed01);
      if (env.insideBody) target = Math.max(target, 0.94);
    }
    target = THREE.MathUtils.clamp(target, 0.0, 1.0);

    const response = target > gasGiantShakeStrength ? 7.0 : 9.0;
    const k = 1.0 - Math.exp(-response * Math.max(0.0, dt));
    gasGiantShakeStrength = THREE.MathUtils.lerp(
      gasGiantShakeStrength,
      target,
      k,
    );

    setGasGiantWarningVisible(!!env?.insideBody);
    if (gasGiantShakeStrength < 0.002 || !shipChaseActive()) return;

    const t = gasGiantShakeTime;
    const randSigned = () => Math.random() * 2.0 - 1.0;

    // Two independently retargeted bands of smooth random motion replace the
    // old fixed-frequency sine stack. Retarget intervals are randomized too, so
    // the turbulence has no short recognizable loop.
    if (t >= gasGiantShakeNoise.nextLowChange) {
      gasGiantShakeNoise.lowTarget.set(
        randSigned(),
        randSigned(),
        randSigned(),
      );
      gasGiantShakeNoise.nextLowChange = t + 0.28 + Math.random() * 0.52;
    }
    if (t >= gasGiantShakeNoise.nextHighChange) {
      gasGiantShakeNoise.highTarget.set(
        randSigned(),
        randSigned(),
        randSigned(),
      );
      gasGiantShakeNoise.nextHighChange = t + 0.055 + Math.random() * 0.13;
    }

    const lowK = 1.0 - Math.exp(-5.5 * Math.max(0.0, dt));
    const highK = 1.0 - Math.exp(-18.0 * Math.max(0.0, dt));
    gasGiantShakeNoise.low.lerp(gasGiantShakeNoise.lowTarget, lowK);
    gasGiantShakeNoise.high.lerp(gasGiantShakeNoise.highTarget, highK);

    // Add occasional asymmetric gusts/impacts. Their direction, magnitude, and
    // spacing are randomized, then exponentially decay instead of oscillating.
    if (t >= gasGiantShakeNoise.nextImpulse) {
      const impulseScale = 0.35 + Math.random() * 0.85;
      gasGiantShakeNoise.impulse.set(
        randSigned() * impulseScale,
        randSigned() * impulseScale,
        randSigned() * impulseScale * 0.7,
      );
      gasGiantShakeNoise.nextImpulse = t + 0.30 + Math.random() * 1.15;
    }
    gasGiantShakeNoise.impulse.multiplyScalar(
      Math.exp(-7.5 * Math.max(0.0, dt)),
    );

    const nX = THREE.MathUtils.clamp(
      gasGiantShakeNoise.low.x * 0.62 +
        gasGiantShakeNoise.high.x * 0.34 +
        gasGiantShakeNoise.impulse.x * 0.58,
      -1.35,
      1.35,
    );
    const nY = THREE.MathUtils.clamp(
      gasGiantShakeNoise.low.y * 0.58 +
        gasGiantShakeNoise.high.y * 0.38 +
        gasGiantShakeNoise.impulse.y * 0.62,
      -1.35,
      1.35,
    );
    const nR = THREE.MathUtils.clamp(
      gasGiantShakeNoise.low.z * 0.55 +
        gasGiantShakeNoise.high.z * 0.32 +
        gasGiantShakeNoise.impulse.z * 0.48,
      -1.20,
      1.20,
    );

    tmp.gasShakeRightW.set(1, 0, 0).applyQuaternion(camera.quaternion).normalize();
    tmp.gasShakeUpW.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
    tmp.gasShakeForwardW.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();

    // Deliberately violent gas-giant turbulence. This remains a render-only
    // offset after the stable chase/collision solution, so the stronger motion
    // does not feed back into camera physics.
    const posAmp = 1.15 * gasGiantShakeStrength;
    camera.position.addScaledVector(tmp.gasShakeRightW, nX * posAmp);
    camera.position.addScaledVector(tmp.gasShakeUpW, nY * posAmp * 0.92);
    camera.position.addScaledVector(tmp.gasShakeForwardW, nR * posAmp * 0.46);

    const rotAmp = 0.036 * gasGiantShakeStrength;
    tmp.gasShakeQ1.setFromAxisAngle(tmp.gasShakeUpW, nX * rotAmp * 0.88);
    tmp.gasShakeQ2.setFromAxisAngle(tmp.gasShakeRightW, nY * rotAmp);
    camera.quaternion.premultiply(tmp.gasShakeQ1).premultiply(tmp.gasShakeQ2).normalize();
    camera.updateMatrixWorld(true);
  }

  function updateAtmosphericShield(dt, near = null) {
    const mesh = playerShip.atmosphericShield;
    const uniforms = playerShip.atmosphericShieldUniforms;
    if (!mesh || !uniforms || !playerShip.loaded) return;

    playerShip.atmosphericShieldTime += Math.max(0.0, dt);
    uniforms.uTime.value = playerShip.atmosphericShieldTime;

    let desiredStrength = 0.0;
    let speed01 = 0.0;
    let fullEnvelope = 0.0;
    const speed = player.worldVel.length();

    if (player.mode === "fly") {
      const nearest = near ?? nearestBodyInfo(player.worldPos);
      if (nearest?.i >= 0) {
        const b = bodies[nearest.i];
        if (b?.group) {
          b.group.getWorldPosition(tmp.shieldCenterW);
          const dist = player.worldPos.distanceTo(tmp.shieldCenterW);
          const baseR = b.cfg?.baseRadius ?? b.baseRadius ?? 0.0;

          // Full environmental envelope while submerged. Use the same animated
          // wave surface radius as the underwater renderer so the shield switches
          // at the visible water surface instead of mean sea level.
          let underwater = false;
          if (b.hasOcean) {
            const surfaceR = Math.max(
              0.0,
              b.oceanSurfaceRadiusAtWorldPoint?.(player.worldPos) ?? b.seaLevel,
            );
            underwater = surfaceR > 0.0 && dist < surfaceR;
          }

          // Gas giants are intentionally fly-through bodies. Once the ship is
          // inside the visible giant sphere, keep the whole pressure shield live
          // regardless of airspeed.
          const insideGasGiant =
            b.isGasGiant === true && baseR > 0.0 && dist < baseR;

          if (underwater || insideGasGiant) {
            fullEnvelope = 1.0;
            desiredStrength = 1.0;
            speed01 = 1.0;
          } else if (
            b.isGasGiant === true &&
            b.hasAtmo !== false &&
            speed > 1.0
          ) {
            const atmoH = Math.max(1.0, baseR * 0.33);
            const atmoR = baseR + atmoH;

            if (baseR > 0.0 && dist < atmoR) {
              let density = THREE.MathUtils.clamp(
                (atmoR - dist) / atmoH,
                0.0,
                1.0,
              );
              // Smooth the crude radial atmosphere approximation so the visual
              // does not snap on at the atmospheric boundary.
              density = density * density * (3.0 - 2.0 * density);

              speed01 = THREE.MathUtils.smoothstep(speed, 22.0, 260.0);
              const dynamicPressure = density * Math.pow(speed / 120.0, 2.0);
              desiredStrength =
                (1.0 - Math.exp(-dynamicPressure * 1.45)) *
                THREE.MathUtils.smoothstep(speed, 16.0, 38.0);
            }
          }

          // If terrain collision has forced the camera into the hull, the ship
          // fades out; keep the shield from replacing it as a new view blocker.
          desiredStrength *= playerShip.fadeFactor;

          if (speed > 1e-4) {
            tmp.shieldVelocityDirL
              .copy(player.worldVel)
              .multiplyScalar(1.0 / speed);
            tmp.shieldInvQ.copy(flyQuat).invert();
            tmp.shieldVelocityDirL
              .applyQuaternion(tmp.shieldInvQ)
              .normalize();
            uniforms.uVelocityDirL.value.copy(tmp.shieldVelocityDirL);
          }
        }
      }
    }

    const response = desiredStrength > playerShip.atmosphericShieldStrength
      ? (fullEnvelope > 0.5 ? 12.0 : 7.0)
      : 10.0;
    const k = 1.0 - Math.exp(-response * Math.max(0.0, dt));
    playerShip.atmosphericShieldStrength = THREE.MathUtils.lerp(
      playerShip.atmosphericShieldStrength,
      THREE.MathUtils.clamp(desiredStrength, 0.0, 1.0),
      k,
    );

    uniforms.uStrength.value = playerShip.atmosphericShieldStrength;
    uniforms.uSpeed01.value = speed01;
    uniforms.uFullEnvelope.value = fullEnvelope;
    mesh.visible =
      playerShip.root?.visible === true &&
      playerShip.atmosphericShieldStrength > 0.004;
  }

  function sampleWingTrailAtmosphere(near = null) {
    if (player.mode !== "fly") return null;
    const nearest = near ?? nearestBodyInfo(player.worldPos);
    if (nearest?.i < 0) return null;
    const b = bodies[nearest.i];
    if (!b?.group || b.hasAtmo === false) return null;

    b.group.getWorldPosition(tmp.shieldCenterW);
    const dist = player.worldPos.distanceTo(tmp.shieldCenterW);
    const baseR = b.cfg?.baseRadius ?? b.baseRadius ?? 0.0;
    if (!(baseR > 0.0)) return null;

    // No air contrails while submerged; the pressure shield owns that regime.
    if (b.hasOcean) {
      const surfaceR = Math.max(
        0.0,
        b.oceanSurfaceRadiusAtWorldPoint?.(player.worldPos) ?? b.seaLevel,
      );
      if (surfaceR > 0.0 && dist < surfaceR) return null;
    }

    const atmoH = Math.max(1.0, baseR * 0.33);
    const atmoR = baseR + atmoH;
    if (dist >= atmoR) return null;
    let density = THREE.MathUtils.clamp((atmoR - dist) / atmoH, 0.0, 1.0);
    density = density * density * (3.0 - 2.0 * density);
    return { body: b, density };
  }

  function clearWingTrails() {
    for (const trail of [playerShip.wingTrailLeft, playerShip.wingTrailRight]) {
      if (!trail) continue;
      trail.streaks.length = 0;
      trail.currentStreak = null;
      trail.totalSegments = 0;
      trail.lastValid = false;
      trail.geometry.setDrawRange(0, 0);
      trail.mesh.visible = false;
    }
  }

  function dropOldestWingTrailSegment(trail) {
    while (trail.streaks.length) {
      const streak = trail.streaks[0];
      if (streak.segments.length) {
        streak.segments.shift();
        trail.totalSegments = Math.max(0, trail.totalSegments - 1);
        if (!streak.segments.length && streak !== trail.currentStreak) {
          trail.streaks.shift();
        }
        return;
      }
      if (streak === trail.currentStreak) return;
      trail.streaks.shift();
    }
  }

  function fillWingTrailEclipseOccluders(body, bodyCenterW, sunW) {
    if (!body || typeof world.fillOccludersForBody !== "function") return 0;
    const pass = playerShip.wingTrailOccPass;
    pass.body = body;
    pass.mat.uniforms.uPlanetCenterW.value.copy(bodyCenterW);
    pass.mat.uniforms.uSunPosW.value.copy(sunW);
    return world.fillOccludersForBody(
      pass,
      playerShip.wingTrailOccCenters,
      playerShip.wingTrailOccRadii,
      tmp,
    );
  }

  function wingTrailSunVisibility(pW, sunW, occCount) {
    if (!(occCount > 0)) return 1.0;

    tmp.trailToSunW.copy(sunW).sub(pW);
    const sunDistance = tmp.trailToSunW.length();
    if (sunDistance <= 1e-6) return 1.0;
    tmp.trailToSunW.multiplyScalar(1.0 / sunDistance);

    const centers = playerShip.wingTrailOccCenters;
    const radii = playerShip.wingTrailOccRadii;
    let visibility = 1.0;

    for (let i = 0; i < occCount; i++) {
      const i3 = i * 3;
      const dx = centers[i3] - pW.x;
      const dy = centers[i3 + 1] - pW.y;
      const dz = centers[i3 + 2] - pW.z;
      const along =
        dx * tmp.trailToSunW.x +
        dy * tmp.trailToSunW.y +
        dz * tmp.trailToSunW.z;
      if (along <= 0.0 || along >= sunDistance) continue;

      const px = dx - tmp.trailToSunW.x * along;
      const py = dy - tmp.trailToSunW.y * along;
      const pz = dz - tmp.trailToSunW.z * along;
      const perp = Math.sqrt(px * px + py * py + pz * pz);
      const occR = Math.max(0.0, radii[i]);
      if (occR <= 0.0) continue;

      // Same hard geometric core as the SPL/CPU eclipse path.
      if (perp <= occR) return 0.0;

      const projectedSunRadius = Math.max(
        (world.SUN_RADIUS ?? 1350.0) * (along / sunDistance),
        occR * 0.015,
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

      visibility = Math.min(
        visibility,
        1.0 - overlap * maxCoverage,
      );
      if (visibility <= 0.001) return 0.0;
    }

    return THREE.MathUtils.clamp(visibility, 0.0, 1.0);
  }

  function updateWingTrailRibbon(
    trail,
    tipW,
    emitStrength,
    dt,
    anchorBody,
    sunW,
  ) {
    if (!trail) return;
    const now = playerShip.wingTrailTime;
    const life = Math.max(0.2, playerShip.wingTrailLife);
    const hold = Math.min(
      Math.max(0.0, playerShip.wingTrailFadeDelay ?? 0.0),
      life * 0.8,
    );
    const shrinkDuration = Math.max(0.05, life - hold);
    const growDuration = Math.max(
      0.03,
      playerShip.wingTrailGrowDuration ?? 0.48,
    );
    const anchorGroup = anchorBody?.group ?? null;
    const emitting = emitStrength > 0.025 && !!anchorGroup;

    if (
      trail.currentStreak &&
      (!emitting || trail.currentStreak.anchor !== anchorGroup)
    ) {
      trail.currentStreak.endedAt = now;
      trail.currentStreak = null;
      trail.lastValid = false;
    }

    if (emitting) {
      // Store samples in the current atmospheric body's local frame. Rebuilding
      // them into world space below makes old condensation follow orbit/spin.
      tmp.trailTipLocal.copy(tipW);
      anchorGroup.worldToLocal(tmp.trailTipLocal);

      if (!trail.currentStreak) {
        trail.currentStreak = {
          id: trail.nextStreakId++,
          startedAt: now,
          endedAt: null,
          totalLength: 0.0,
          body: anchorBody,
          anchor: anchorGroup,
          segments: [],
        };
        trail.streaks.push(trail.currentStreak);
        trail.lastPoint.copy(tmp.trailTipLocal);
        trail.lastValid = true;
      } else if (trail.lastValid) {
        const segLength = trail.lastPoint.distanceTo(tmp.trailTipLocal);
        if (segLength > 1e-5) {
          while (trail.totalSegments >= trail.maxSegments) {
            const before = trail.totalSegments;
            dropOldestWingTrailSegment(trail);
            if (trail.totalSegments >= before) break;
          }

          if (trail.totalSegments < trail.maxSegments) {
            const streak = trail.currentStreak;
            const startDistance = streak.totalLength;
            const endDistance = startDistance + segLength;
            streak.segments.push({
              a: trail.lastPoint.clone(),
              b: tmp.trailTipLocal.clone(),
              born: now,
              strength: emitStrength,
              startDistance,
              endDistance,
              length: segLength,
            });
            streak.totalLength = endDistance;
            trail.totalSegments++;
          }
        }
        trail.lastPoint.copy(tmp.trailTipLocal);
      } else {
        trail.lastPoint.copy(tmp.trailTipLocal);
        trail.lastValid = true;
      }
    } else {
      trail.lastValid = false;
    }

    // A finished turn stays readable for a short hold, then the ribbon's
    // oldest endpoint walks forward along the stored path. Culling happens
    // only after that geometric retraction is complete.
    while (trail.streaks.length) {
      const streak = trail.streaks[0];
      if (streak.endedAt == null) break;
      if (now - streak.endedAt <= hold + shrinkDuration) break;
      trail.totalSegments = Math.max(
        0,
        trail.totalSegments - streak.segments.length,
      );
      trail.streaks.shift();
    }

    let vertex = 0;
    const writeVertex = (p, alpha, edge, light) => {
      const i3 = vertex * 3;
      trail.positions[i3] = p.x;
      trail.positions[i3 + 1] = p.y;
      trail.positions[i3 + 2] = p.z;
      trail.alphas[vertex] = alpha;
      trail.edges[vertex] = edge;
      trail.lights[vertex] = light;
      vertex++;
    };

    const sunLevel = THREE.MathUtils.clamp(
      (sunLight?.intensity ?? 14.0) / 14.0,
      0.0,
      1.0,
    );

    for (const streak of trail.streaks) {
      if (
        !streak.anchor ||
        !streak.segments.length ||
        streak.totalLength <= 1e-5
      ) continue;
      streak.anchor.updateWorldMatrix(true, false);
      tmp.trailBodyCenterW.setFromMatrixPosition(streak.anchor.matrixWorld);
      const trailOccCount = fillWingTrailEclipseOccluders(
        streak.body,
        tmp.trailBodyCenterW,
        sunW,
      );

      let shrink01 = 0.0;
      if (streak.endedAt != null) {
        shrink01 = THREE.MathUtils.clamp(
          (now - streak.endedAt - hold) / shrinkDuration,
          0.0,
          1.0,
        );
      }

      // The streak itself has a birth animation: it starts as a short piece
      // at the newest wingtip sample, then its oldest endpoint grows backward
      // through the stored flight path. This makes trail length visibly build
      // instead of exposing the whole accumulated ribbon immediately.
      const streakAge = Math.max(0.0, now - streak.startedAt);
      const grow01 = THREE.MathUtils.clamp(
        streakAge / growDuration,
        0.0,
        1.0,
      );
      const growEase = grow01 * grow01 * (3.0 - 2.0 * grow01);
      const growCutDistance = streak.totalLength * (1.0 - growEase);

      // Smoothstep keeps the first and last moments of the contraction soft.
      // Once emission ends, the oldest endpoint advances toward the newest
      // sample until the visible ribbon has geometrically shrunk to nothing.
      const shrinkEase = shrink01 * shrink01 * (3.0 - 2.0 * shrink01);
      const shrinkCutDistance = streak.totalLength * shrinkEase;
      const cutDistance = Math.max(growCutDistance, shrinkCutDistance);
      const shrinkAlpha = 1.0 - 0.35 * shrinkEase;
      const growAlpha = 0.25 + 0.75 * growEase;

      for (const seg of streak.segments) {
        if (vertex + 6 > trail.maxSegments * 6) break;
        if (seg.endDistance <= cutDistance + 1e-5) continue;

        const age = Math.max(0.0, now - seg.born);
        const age01 = THREE.MathUtils.clamp(age / life, 0.0, 1.0);

        const startFrac = THREE.MathUtils.clamp(
          (cutDistance - seg.startDistance) / Math.max(1e-5, seg.length),
          0.0,
          1.0,
        );

        tmp.trailStartW
          .copy(seg.a)
          .lerp(seg.b, startFrac)
          .applyMatrix4(streak.anchor.matrixWorld);
        tmp.trailEndW.copy(seg.b).applyMatrix4(streak.anchor.matrixWorld);
        tmp.trailDirW.copy(tmp.trailEndW).sub(tmp.trailStartW);
        if (tmp.trailDirW.lengthSq() < 1e-8) continue;
        tmp.trailDirW.normalize();

        tmp.trailMidW
          .copy(tmp.trailStartW)
          .add(tmp.trailEndW)
          .multiplyScalar(0.5);
        tmp.trailViewW.copy(camera.position).sub(tmp.trailMidW).normalize();
        tmp.trailSideW.copy(tmp.trailDirW).cross(tmp.trailViewW);
        if (tmp.trailSideW.lengthSq() < 1e-7) {
          tmp.trailSideW.set(1, 0, 0).applyQuaternion(camera.quaternion);
        }
        tmp.trailSideW.normalize();

        // Fresh condensation is tight at the tip and diffuses as it ages.
        const halfWidth = 0.055 + age01 * 0.22;
        tmp.trailA0
          .copy(tmp.trailStartW)
          .addScaledVector(tmp.trailSideW, -halfWidth);
        tmp.trailA1
          .copy(tmp.trailStartW)
          .addScaledVector(tmp.trailSideW, halfWidth);
        tmp.trailB0
          .copy(tmp.trailEndW)
          .addScaledVector(tmp.trailSideW, -halfWidth);
        tmp.trailB1
          .copy(tmp.trailEndW)
          .addScaledVector(tmp.trailSideW, halfWidth);

        // Approximate direct sunlight against the current planet/moon normal.
        // The foreground pass does not receive ordinary scene lighting, so the
        // ribbon carries an explicit day/night factor instead of glowing on the
        // dark hemisphere. A soft terminator avoids a hard lighting seam.
        tmp.trailNormalW
          .copy(tmp.trailMidW)
          .sub(tmp.trailBodyCenterW)
          .normalize();
        tmp.trailSunDirW.copy(sunW).sub(tmp.trailMidW).normalize();
        const sunFacing = tmp.trailNormalW.dot(tmp.trailSunDirW);
        const eclipseVisibility = wingTrailSunVisibility(
          tmp.trailMidW,
          sunW,
          trailOccCount,
        );
        const daylight =
          THREE.MathUtils.smoothstep(sunFacing, -0.03, 0.15) *
          sunLevel *
          eclipseVisibility;

        // Keep most of the streak's opacity while it retracts. The visible
        // length now communicates the lifetime; alpha only softens the finish.
        const alpha = Math.min(
          0.72,
          seg.strength * 0.68 * growAlpha * shrinkAlpha,
        );
        if (alpha <= 0.002) continue;

        writeVertex(tmp.trailA0, alpha, -1.0, daylight);
        writeVertex(tmp.trailA1, alpha, 1.0, daylight);
        writeVertex(tmp.trailB0, alpha, -1.0, daylight);
        writeVertex(tmp.trailB0, alpha, -1.0, daylight);
        writeVertex(tmp.trailA1, alpha, 1.0, daylight);
        writeVertex(tmp.trailB1, alpha, 1.0, daylight);
      }
    }

    trail.geometry.attributes.position.needsUpdate = true;
    trail.geometry.attributes.aTrailAlpha.needsUpdate = true;
    trail.geometry.attributes.aTrailEdge.needsUpdate = true;
    trail.geometry.attributes.aTrailLight.needsUpdate = true;
    trail.geometry.setDrawRange(0, vertex);
    trail.mesh.visible = vertex > 0;
  }

  function updateWingTrails(dt, near, turnRate) {
    playerShip.wingTrailTime += Math.max(0.0, dt);
    if (!playerShip.loaded || !playerShip.root) return;

    let strength = 0.0;
    let trailBody = null;
    if (!warpCtrl?.warp?.active && !landing.active && !isGalaxyOpen()) {
      const atmosphere = sampleWingTrailAtmosphere(near);
      trailBody = atmosphere?.body ?? null;
      const density = atmosphere?.density ?? 0.0;
      const speed = player.worldVel.length();
      // Keep these maneuver-driven rather than permanent contrails, but let
      // them begin earlier so moderate-speed banking produces a visible cue.
      // Physical values are intentionally unscaled by the HUD's 10x.
      const speed01 = THREE.MathUtils.smoothstep(speed, 35.0, 120.0);
      const turn01 = THREE.MathUtils.smoothstep(turnRate, 0.28, 0.95);
      strength = THREE.MathUtils.clamp(density * speed01 * turn01, 0.0, 1.0);
    }

    sun.getWorldPosition(tmp.trailSunW);
    playerShip.root.localToWorld(
      tmp.trailTipLeftW.copy(playerShip.wingTipLeftL),
    );
    playerShip.root.localToWorld(
      tmp.trailTipRightW.copy(playerShip.wingTipRightL),
    );
    updateWingTrailRibbon(
      playerShip.wingTrailLeft,
      tmp.trailTipLeftW,
      strength,
      dt,
      trailBody,
      tmp.trailSunW,
    );
    updateWingTrailRibbon(
      playerShip.wingTrailRight,
      tmp.trailTipRightW,
      strength,
      dt,
      trailBody,
      tmp.trailSunW,
    );
  }

  function syncPlayerShipTransform() {
    if (!playerShip?.loaded || !playerShip.root) return;
    playerShip.root.position.copy(player.worldPos);
    playerShip.root.quaternion.copy(flyQuat);
    playerShip.root.updateMatrixWorld(true);
  }

  function constrainCameraPositionToTerrain(
    body,
    startW,
    cameraPosW,
    radius = 0.8,
    skin = 0.12,
  ) {
    if (!body?.group || body?.collidable === false || typeof body?.sdf !== "function") {
      return false;
    }

    const safeRadius = Math.max(0.1, Number(radius) || 0.8);
    const safeSkin = Math.max(0.02, Number(skin) || 0.12);
    const castStartW = tmp.cameraCastStartW.copy(startW);
    const endW = tmp.cameraCastEndW.copy(cameraPosW);
    const dirW = tmp.cameraCastDirW.subVectors(endW, castStartW);
    const castLength = dirW.length();
    if (castLength < 1e-5) return false;
    dirW.multiplyScalar(1.0 / castLength);

    body.group.updateMatrixWorld(true);
    body.group.getWorldPosition(tmp.cameraCastCenterW);
    body.group.getWorldQuaternion(tmp.worldQuat);
    tmp.cameraCastInvQ.copy(tmp.worldQuat).invert();

    const clearanceAt = (distanceAlongCast) => {
      tmp.cameraCastSampleW
        .copy(castStartW)
        .addScaledVector(dirW, distanceAlongCast);
      tmp.cameraCastSampleL
        .copy(tmp.cameraCastSampleW)
        .sub(tmp.cameraCastCenterW)
        .applyQuaternion(tmp.cameraCastInvQ);
      return (
        body.sdf(
          tmp.cameraCastSampleL.x,
          tmp.cameraCastSampleL.y,
          tmp.cameraCastSampleL.z,
        ) - safeRadius
      );
    };

    // This is the exact chase-camera terrain sweep used by fly mode: capped
    // sphere tracing against the body's radial SDF, followed by a binary search
    // for the last safe camera position. Keeping this shared prevents rover and
    // ship camera collision behavior from drifting apart again.
    let safeD = 0.0;
    let testD = 0.0;
    const startClearance = clearanceAt(0.0);
    if (startClearance <= safeSkin) return false;

    for (let i = 0; i < 48 && testD < castLength; i++) {
      const clearance = clearanceAt(testD);
      if (clearance <= safeSkin) {
        let lo = safeD;
        let hi = testD;
        for (let refine = 0; refine < 8; refine++) {
          const mid = (lo + hi) * 0.5;
          if (clearanceAt(mid) > safeSkin) lo = mid;
          else hi = mid;
        }
        cameraPosW.copy(castStartW).addScaledVector(dirW, lo);
        return true;
      }

      safeD = testD;
      const step = THREE.MathUtils.clamp(
        (clearance - safeSkin) * 0.65,
        0.08,
        0.75,
      );
      testD = Math.min(castLength, testD + step);
    }

    if (clearanceAt(castLength) <= safeSkin) {
      let lo = safeD;
      let hi = castLength;
      for (let refine = 0; refine < 8; refine++) {
        const mid = (lo + hi) * 0.5;
        if (clearanceAt(mid) > safeSkin) lo = mid;
        else hi = mid;
      }
      cameraPosW.copy(castStartW).addScaledVector(dirW, lo);
      return true;
    }
    return false;
  }

  function constrainChaseCameraToTerrain() {
    if (player.noclip || !shipChaseActive()) return;

    const near = nearestBodyInfo(player.worldPos);
    if (near.i < 0) return;
    const body = bodies[near.i];
    if (body?.collidable === false || typeof body?.sdf !== "function") return;

    // The chase camera only spans a few metres, so the body nearest the ship is
    // also the only terrain body that can intersect the cast. Avoid evaluating
    // the procedural SDF at all when the ship is clearly far from its surface.
    const baseR = Number(body.baseRadius ?? body.cfg?.baseRadius ?? 0.0);
    const heightAmp = Math.abs(
      Number(body.heightAmp ?? body.cfg?.heightAmp ?? body.cfg?.terrainHeight ?? 0.0),
    );
    const castReach = playerShip.chaseDist + playerShip.chaseUp + 12.0;
    if (baseR > 0.0 && near.d > baseR + heightAmp * 2.0 + castReach) return;

    constrainCameraPositionToTerrain(
      body,
      player.worldPos,
      playerShip.camPos,
      playerShip.cameraCollisionRadius,
      playerShip.cameraCollisionSkin,
    );
  }

  function updateFlyCamera(dt) {
    // Default: camera sits at the player position.
    if (!shipChaseActive()) {
      camera.position.copy(player.worldPos);
      camera.quaternion.copy(flyQuat);
      camera.updateMatrixWorld(true);
      updatePlayerShipCameraFade();
      return;
    }

    // Simple chase camera so the ship is visible.
    const desired = tmp.vD
      .set(playerShip.chaseSide, playerShip.chaseUp, playerShip.chaseDist)
      .applyQuaternion(flyQuat)
      .add(player.worldPos);

    if (playerShip.camPos.lengthSq() === 0) {
      // First frame after enabling: snap.
      playerShip.camPos.copy(desired);
    } else {
      const a = 1.0 - Math.exp(-playerShip.chaseLag * Math.max(0.0, dt));
      playerShip.camPos.lerp(desired, a);
    }

    constrainChaseCameraToTerrain();

    camera.position.copy(playerShip.camPos);
    camera.quaternion.copy(flyQuat);
    camera.updateMatrixWorld(true);
    updatePlayerShipCameraFade();
  }

  // Called after a warp rebuild completes: move the player to a deterministic position
  // near the new system's star while translating the camera by the exact same
  // displacement. This preserves the *current* chase offset instead of leaving
  // the camera accumulator behind in the old system and making it catch up.
  function placePlayerNearNewStar(target) {
    if (!sun) return;

    // A parked surface vehicle belongs to the old star system. Do not leave a
    // stale rover floating at coordinates that no longer correspond to a body
    // after the procedural system rebuild.
    despawnSurfaceVehicle();
    clearSurfaceWaterFx();

    // Preserve the camera's current world-space offset from the ship before the
    // teleport. During chase lag this can differ from the configured ideal
    // offset, and keeping that exact value makes the transition seamless.
    const cameraOffsetW = tmp.vC.copy(camera.position).sub(player.worldPos);

    // keep flying (warp already requires fly mode)
    landing.active = false;
    player.landing = false;
    setLandingSequenceVisible(false);
    player.mode = "fly";
    player.followIndex = -1;
    player.worldVel.set(0, 0, 0);

    // deterministic spawn direction from seed
    const rnd = mulberry32(((target?.seed ?? 101010) >>> 0) ^ 0x9e3779b9);
    const a = rnd() * Math.PI * 2;
    const y = 0.1 + rnd() * 0.2;

    const sunW = sun.getWorldPosition(tmp.vA.set(0, 0, 0));
    const spawnDir = tmp.vB.set(Math.cos(a), y, Math.sin(a)).normalize();

    // place inside first orbit but safely away from the sun mesh
    const dist = Math.max((SUN_RADIUS ?? 450) * 7.0, 3200);
    player.worldPos.copy(sunW).addScaledVector(spawnDir, dist);

    // Teleport the camera with the ship, preserving its exact pre-warp offset.
    camera.position.copy(player.worldPos).add(cameraOffsetW);
    if (shipChaseActive()) {
      // Keep the chase accumulator synchronized with the teleported camera so
      // the next update continues smoothly instead of lerping from the old system.
      playerShip.camPos.copy(camera.position);
    }
    camera.updateMatrixWorld(true);

    // Update optional ship model after both transforms are in their new system.
    syncPlayerShipVisibility();
    syncPlayerShipTransform();
  }

  function nearestBodyInfo(worldPos) {
    // Surface ownership is a two-stage query. First shortlist by distance to a
    // body's nominal surface (cheap), then evaluate the actual procedural
    // terrain/ocean radius only for the closest few candidates. `radiusAtDir`
    // is FBM-based, so doing the exact query for every moon/planet several
    // times per frame would be unnecessarily expensive.
    let c0 = -1, c1 = -1, c2 = -1, c3 = -1;
    let s0 = Infinity, s1 = Infinity, s2 = Infinity, s3 = Infinity;
    let d0 = Infinity, d1 = Infinity, d2 = Infinity, d3 = Infinity;

    const insertCandidate = (i, coarseSurfaceD, centerD) => {
      if (coarseSurfaceD < s0) {
        c3 = c2; s3 = s2; d3 = d2;
        c2 = c1; s2 = s1; d2 = d1;
        c1 = c0; s1 = s0; d1 = d0;
        c0 = i; s0 = coarseSurfaceD; d0 = centerD;
      } else if (coarseSurfaceD < s1) {
        c3 = c2; s3 = s2; d3 = d2;
        c2 = c1; s2 = s1; d2 = d1;
        c1 = i; s1 = coarseSurfaceD; d1 = centerD;
      } else if (coarseSurfaceD < s2) {
        c3 = c2; s3 = s2; d3 = d2;
        c2 = i; s2 = coarseSurfaceD; d2 = centerD;
      } else if (coarseSurfaceD < s3) {
        c3 = i; s3 = coarseSurfaceD; d3 = centerD;
      }
    };

    for (let i = 0; i < bodies.length; i++) {
      const bb = bodies[i];
      const ud = bb?.group?.userData;
      if (
        !bb?.group ||
        ud?.ignoreMiniMap ||
        ud?.ignoreMinimap ||
        ud?.isAsteroidBelt
      ) {
        continue;
      }

      const centerW = bb.group.getWorldPosition(tmp.vA.set(0, 0, 0));
      const centerD = worldPos.distanceTo(centerW);
      let nominalR = Number(bb?.cfg?.baseRadius ?? bb?.baseRadius ?? 0.0);
      const seaLevel = Number(bb?.seaLevel);
      if (bb?.hasOcean && Number.isFinite(seaLevel) && seaLevel > 0.0) {
        nominalR = Math.max(nominalR, seaLevel);
      }
      if (!Number.isFinite(nominalR) || nominalR < 0.0) nominalR = 0.0;

      insertCandidate(i, Math.abs(centerD - nominalR), centerD);
    }

    let bestI = -1;
    let bestCenterD = Infinity;
    let bestSurfaceD = Infinity;
    let bestAltitude = Infinity;
    const candidateIndices = [c0, c1, c2, c3];
    const candidateCenterD = [d0, d1, d2, d3];

    for (let k = 0; k < candidateIndices.length; k++) {
      const i = candidateIndices[k];
      if (i < 0) continue;
      const bb = bodies[i];
      const centerD = candidateCenterD[k];

      bb.group.updateMatrixWorld(true);
      tmp.vB.copy(worldPos);
      bb.group.worldToLocal(tmp.vB);
      const localR = tmp.vB.length();

      let surfaceR = Number(bb?.cfg?.baseRadius ?? bb?.baseRadius ?? 0.0);
      if (localR > 1e-6 && typeof bb.radiusAtDir === "function") {
        tmp.vC.copy(tmp.vB).multiplyScalar(1.0 / localR);
        surfaceR = bb.radiusAtDir(tmp.vC.x, tmp.vC.y, tmp.vC.z);
      }

      // Water is also a surface. Use the live displaced ocean radius when that
      // CPU mirror is available, but keep terrain islands that rise above it.
      if (bb?.hasOcean) {
        let oceanR = Number(bb?.seaLevel);
        if (typeof bb.oceanSurfaceRadiusAtWorldPoint === "function") {
          oceanR = bb.oceanSurfaceRadiusAtWorldPoint(worldPos);
        }
        if (Number.isFinite(oceanR) && oceanR > 0.0) {
          surfaceR = Math.max(surfaceR, oceanR);
        }
      }

      if (!Number.isFinite(surfaceR) || surfaceR <= 0.0) {
        surfaceR = Math.max(0.0, Number(bb?.baseRadius ?? 0.0));
      }

      const altitude = localR - surfaceR;
      const surfaceD = Math.abs(altitude);
      if (
        surfaceD < bestSurfaceD - 1e-6 ||
        (Math.abs(surfaceD - bestSurfaceD) <= 1e-6 && centerD < bestCenterD)
      ) {
        bestI = i;
        bestCenterD = centerD;
        bestSurfaceD = surfaceD;
        bestAltitude = altitude;
      }
    }

    // Preserve `d` as centre distance for existing range/culling users. Body
    // selection itself is now based on `surfaceD`.
    return {
      i: bestI,
      d: bestCenterD,
      centerD: bestCenterD,
      surfaceD: bestSurfaceD,
      altitude: bestAltitude,
    };
  }

  function pushOutOfTerrainWalk(
    body,
    posL,
    dirL,
    clearance = 0.8,
    maxIter = 6,
  ) {
    const sdf = body.sdf;
    for (let i = 0; i < maxIter; i++) {
      const d = sdf(posL.x, posL.y, posL.z);
      if (d >= clearance) break;
      posL.addScaledVector(dirL, clearance - d);
    }
  }


  function buildSurfaceVehicleOrientation(upL, headingYaw, outQ) {
    tmp.vehicleUpL.copy(upL).normalize();
    tmp.refAxis.set(0, 1, 0);
    if (Math.abs(tmp.vehicleUpL.dot(tmp.refAxis)) > 0.92) {
      tmp.refAxis.set(1, 0, 0);
    }

    tmp.eastL.copy(tmp.refAxis).cross(tmp.vehicleUpL).normalize();
    tmp.northL.copy(tmp.vehicleUpL).cross(tmp.eastL).normalize();
    tmp.qYaw.setFromAxisAngle(tmp.vehicleUpL, headingYaw);
    tmp.vehicleForwardL
      .copy(tmp.northL)
      .applyQuaternion(tmp.qYaw)
      .normalize();
    tmp.vehicleRightL
      .copy(tmp.eastL)
      .applyQuaternion(tmp.qYaw)
      .normalize();
    tmp.vehicleBackwardW.copy(tmp.vehicleForwardL).multiplyScalar(-1.0);
    tmp.vehicleBasis.makeBasis(
      tmp.vehicleRightL,
      tmp.vehicleUpL,
      tmp.vehicleBackwardW,
    );
    return outQ.setFromRotationMatrix(tmp.vehicleBasis).normalize();
  }

  function deriveSurfaceVehicleLocalFrame() {
    tmp.vehicleUpL
      .set(0, 1, 0)
      .applyQuaternion(playerVehicle.orientationL)
      .normalize();
    tmp.vehicleForwardL
      .set(0, 0, -1)
      .applyQuaternion(playerVehicle.orientationL)
      .normalize();
    tmp.vehicleRightL
      .set(1, 0, 0)
      .applyQuaternion(playerVehicle.orientationL)
      .normalize();

    tmp.vehicleRadialUpL.copy(playerVehicle.positionL);
    if (tmp.vehicleRadialUpL.lengthSq() < 1e-8) {
      tmp.vehicleRadialUpL.copy(tmp.vehicleUpL);
    } else {
      tmp.vehicleRadialUpL.normalize();
    }
    playerVehicle.dirLocal.copy(tmp.vehicleRadialUpL);
    playerVehicle.speed = playerVehicle.linearVelocityL.dot(
      tmp.vehicleForwardL,
    );

    // Keep a heading value for walk-mode handoff/HUD compatibility. Pitch and
    // roll are intentionally discarded here; those now belong to rigid-body
    // orientation instead of being reconstructed from the terrain tangent.
    tmp.refAxis.set(0, 1, 0);
    if (Math.abs(tmp.vehicleRadialUpL.dot(tmp.refAxis)) > 0.92) {
      tmp.refAxis.set(1, 0, 0);
    }
    tmp.eastL.copy(tmp.refAxis).cross(tmp.vehicleRadialUpL).normalize();
    tmp.northL.copy(tmp.vehicleRadialUpL).cross(tmp.eastL).normalize();
    tmp.vehiclePhysicsForwardL
      .copy(tmp.vehicleForwardL)
      .addScaledVector(
        tmp.vehicleRadialUpL,
        -tmp.vehicleForwardL.dot(tmp.vehicleRadialUpL),
      );
    if (tmp.vehiclePhysicsForwardL.lengthSq() > 1e-8) {
      tmp.vehiclePhysicsForwardL.normalize();
      playerVehicle.yaw = Math.atan2(
        tmp.vehiclePhysicsForwardL.dot(tmp.eastL),
        tmp.vehiclePhysicsForwardL.dot(tmp.northL),
      );
    }
    return tmp.vehicleRadialUpL;
  }

  function resetSurfaceVehicleSuspensionVisuals() {
    for (const wheel of playerVehicle.suspension) {
      wheel.springLength = wheel.restLength;
      wheel.contact = false;
      wheel.normalLoad = 0.0;
      wheel.steerAngle = 0.0;
      wheel.longitudinalSpeed = 0.0;
      wheel.lateralSpeed = 0.0;
      wheel.spinAngle = 0.0;
      wheel.angularSpeed = 0.0;
      wheel.surfaceSpeed = 0.0;
      wheel.slipRatio = 0.0;
      wheel.slipAngle = 0.0;
      wheel.slipAmount = 0.0;
      wheel.longitudinalForce = 0.0;
      wheel.lateralForce = 0.0;
      wheel.dustAccumulator = 0.0;
      wheel.skidMarkActive = false;
      wheel.skidMarkBodyIndex = -1;
      wheel.pivot.position.y =
        ROVER_SUSPENSION_MOUNT_Y - wheel.springLength;
      wheel.pivot.rotation.y = 0.0;
    }
    for (const contact of playerVehicle.chassisContacts) {
      contact.touching = false;
      contact.penetration = 0.0;
    }
    playerVehicle.steeringAngle = 0.0;
    playerVehicle.skidStrength = 0.0;
    playerVehicle.peakSlip = 0.0;
    playerVehicle.impactStrength = 0.0;
    playerVehicle.feedbackTime = 0.0;
    playerVehicle.chassisContactCount = 0;
    playerVehicle.airborneTime = 0.0;
    playerVehicle.landingImpact = 0.0;
    playerVehicle.landingKick = 0.0;
  }

  function clearSurfaceVehicleDust() {
    const dust = playerVehicle.dust;
    if (!dust) return;
    for (let i = 0; i < dust.particles.length; i++) {
      dust.particles[i].active = false;
      dust.alphas[i] = 0.0;
      dust.sizes[i] = 0.0;
    }
    dust.activeCount = 0;
    dust.nextIndex = 0;
    dust.points.visible = false;
    dust.geometry.attributes.position.needsUpdate = true;
    dust.geometry.attributes.aAlpha.needsUpdate = true;
    dust.geometry.attributes.aSize.needsUpdate = true;
  }

  function attachSurfaceVehicleDustToBody(body) {
    const dust = playerVehicle.dust;
    if (!dust?.points || !body?.group) return;
    if (dust.points.parent !== body.group) {
      body.group.add(dust.points);
    }
    dust.points.position.set(0, 0, 0);
    dust.points.quaternion.identity();
    dust.points.scale.set(1, 1, 1);
  }

  function emitSurfaceVehicleDust(pointL, normalL, baseVelL, strength = 1.0, count = 1) {
    const dust = playerVehicle.dust;
    if (!dust || strength <= 0.001) return;
    const s = THREE.MathUtils.clamp(strength, 0.0, 1.5);

    for (let n = 0; n < count; n++) {
      const i = dust.nextIndex;
      dust.nextIndex = (dust.nextIndex + 1) % dust.particles.length;
      const particle = dust.particles[i];
      if (!particle.active) {
        dust.activeCount = Math.min(
          dust.particles.length,
          dust.activeCount + 1,
        );
      }
      particle.active = true;
      particle.age = 0.0;
      particle.life = THREE.MathUtils.lerp(0.48, 1.15, Math.random()) *
        THREE.MathUtils.lerp(0.82, 1.15, Math.min(1.0, s));
      particle.size = THREE.MathUtils.lerp(0.34, 0.86, Math.random()) *
        THREE.MathUtils.lerp(0.75, 1.45, Math.min(1.0, s));
      particle.alpha = THREE.MathUtils.lerp(0.16, 0.34, Math.random()) *
        THREE.MathUtils.clamp(0.45 + s * 0.7, 0.0, 1.0);
      particle.posL
        .copy(pointL)
        .addScaledVector(normalL, 0.05 + Math.random() * 0.12);

      tmp.vA.set(
        Math.random() * 2.0 - 1.0,
        Math.random() * 2.0 - 1.0,
        Math.random() * 2.0 - 1.0,
      );
      tmp.vA.addScaledVector(normalL, -tmp.vA.dot(normalL));
      if (tmp.vA.lengthSq() < 1e-6) tmp.vA.set(1, 0, 0);
      else tmp.vA.normalize();

      particle.velL
        .copy(baseVelL)
        .multiplyScalar(0.10 + Math.random() * 0.07)
        .addScaledVector(normalL, 0.55 + Math.random() * (1.7 + s * 1.4))
        .addScaledVector(tmp.vA, (Math.random() * 2.0 - 1.0) * (1.2 + s * 1.8));
    }
  }

  function updateSurfaceVehicleDust(dt) {
    const dust = playerVehicle.dust;
    if (!dust) return;
    if (dust.activeCount <= 0) {
      dust.points.visible = false;
      return;
    }

    // Dust is a custom shader, so give it the same basic direct-light logic as
    // the aerodynamic trails instead of letting particles glow on the night
    // side. A single rover-local sample is sufficient because the cloud is tiny
    // relative to the host body; eclipses use the shared renderer occluder set.
    const body = bodies[playerVehicle.bodyIndex];
    if (body?.group && sun) {
      body.group.getWorldPosition(tmp.vehicleDustBodyCenterW);
      sun.getWorldPosition(tmp.vehicleDustSunW);
      tmp.vehicleDustPosW.copy(playerVehicle.positionL);
      body.group.localToWorld(tmp.vehicleDustPosW);
      body.group.getWorldQuaternion(tmp.worldQuat);
      tmp.vehicleDustNormalW
        .copy(playerVehicle.positionL)
        .normalize()
        .applyQuaternion(tmp.worldQuat)
        .normalize();
      tmp.vehicleDustSunDirW
        .copy(tmp.vehicleDustSunW)
        .sub(tmp.vehicleDustPosW)
        .normalize();
      const dayLight = THREE.MathUtils.smoothstep(
        tmp.vehicleDustNormalW.dot(tmp.vehicleDustSunDirW),
        -0.08,
        0.18,
      );
      const occCount = fillWingTrailEclipseOccluders(
        body,
        tmp.vehicleDustBodyCenterW,
        tmp.vehicleDustSunW,
      );
      const eclipse = wingTrailSunVisibility(
        tmp.vehicleDustPosW,
        tmp.vehicleDustSunW,
        occCount,
      );
      dust.points.material.uniforms.uLight.value =
        0.055 + 0.945 * dayLight * eclipse;
    } else {
      dust.points.material.uniforms.uLight.value = 0.35;
    }

    let activeCount = 0;
    const drag = Math.exp(-1.65 * dt);

    for (let i = 0; i < dust.particles.length; i++) {
      const particle = dust.particles[i];
      if (!particle.active) {
        dust.alphas[i] = 0.0;
        dust.sizes[i] = 0.0;
        continue;
      }

      particle.age += dt;
      if (particle.age >= particle.life) {
        particle.active = false;
        dust.alphas[i] = 0.0;
        dust.sizes[i] = 0.0;
        continue;
      }

      tmp.vA.copy(particle.posL);
      const r = tmp.vA.length();
      if (r > 1e-5) {
        particle.velL.addScaledVector(tmp.vA, (-2.6 * dt) / r);
      }
      particle.velL.multiplyScalar(drag);
      particle.posL.addScaledVector(particle.velL, dt);

      const age01 = particle.age / particle.life;
      const fadeIn = THREE.MathUtils.smoothstep(age01, 0.0, 0.12);
      const fadeOut = 1.0 - THREE.MathUtils.smoothstep(age01, 0.38, 1.0);
      const i3 = i * 3;
      dust.positions[i3] = particle.posL.x;
      dust.positions[i3 + 1] = particle.posL.y;
      dust.positions[i3 + 2] = particle.posL.z;
      dust.alphas[i] = particle.alpha * fadeIn * fadeOut;
      dust.sizes[i] = particle.size * (1.0 + age01 * 2.2);
      activeCount++;
    }

    dust.activeCount = activeCount;
    dust.points.visible = activeCount > 0;
    dust.geometry.attributes.position.needsUpdate = true;
    dust.geometry.attributes.aAlpha.needsUpdate = true;
    dust.geometry.attributes.aSize.needsUpdate = true;
  }

  function getSurfaceWaterSheetSystem(body) {
    if (!body?.group) return null;
    let system = surfaceWaterSheetFxByBody.get(body);
    if (!system) {
      system = createSurfaceWaterSheetSystem(THREE);
      surfaceWaterSheetFxByBody.set(body, system);
      surfaceWaterFxScene.add(system.mesh);
    } else if (system.mesh.parent !== surfaceWaterFxScene) {
      surfaceWaterFxScene.add(system.mesh);
    }
    return system;
  }

  function applyBodyTransformToWaterFxObject(body, object3d) {
    if (!body?.group || !object3d) return;
    body.group.updateMatrixWorld(true);
    body.group.matrixWorld.decompose(
      object3d.position,
      object3d.quaternion,
      object3d.scale,
    );
    object3d.updateMatrixWorld(true);
  }

  function sampleWaterFxLight(body, samplePosL) {
    if (!(body?.group && sun && samplePosL)) return 0.30;
    body.group.getWorldPosition(tmp.waterFxCenterW);
    sun.getWorldPosition(tmp.waterFxSunW);
    tmp.waterFxPointW.copy(samplePosL);
    body.group.localToWorld(tmp.waterFxPointW);
    body.group.getWorldQuaternion(tmp.worldQuat);
    tmp.waterFxNormalW
      .copy(samplePosL)
      .normalize()
      .applyQuaternion(tmp.worldQuat)
      .normalize();
    tmp.waterFxSunDirW
      .copy(tmp.waterFxSunW)
      .sub(tmp.waterFxPointW)
      .normalize();
    const dayLight = THREE.MathUtils.smoothstep(
      tmp.waterFxNormalW.dot(tmp.waterFxSunDirW),
      -0.08,
      0.18,
    );
    const occCount = fillWingTrailEclipseOccluders(
      body,
      tmp.waterFxCenterW,
      tmp.waterFxSunW,
    );
    const eclipse = wingTrailSunVisibility(
      tmp.waterFxPointW,
      tmp.waterFxSunW,
      occCount,
    );
    return 0.07 + 0.93 * dayLight * eclipse;
  }

  function getSurfaceWaterFxSystem(body) {
    if (!body?.group) return null;
    let system = surfaceWaterFxByBody.get(body);
    if (!system) {
      system = createSurfaceWaterFxSystem(THREE);
      surfaceWaterFxByBody.set(body, system);
      surfaceWaterFxScene.add(system.points);
    } else if (system.points.parent !== surfaceWaterFxScene) {
      surfaceWaterFxScene.add(system.points);
    }
    return system;
  }

  function clearSurfaceWaterFx() {
    for (const system of surfaceWaterFxByBody.values()) {
      if (!system) continue;
      system.points?.removeFromParent?.();
      system.geometry?.dispose?.();
      system.points?.material?.dispose?.();
    }
    for (const system of surfaceWaterSheetFxByBody.values()) {
      if (!system) continue;
      system.mesh?.removeFromParent?.();
      system.geometry?.dispose?.();
      system.mesh?.material?.dispose?.();
    }
    surfaceWaterFxByBody.clear();
    surfaceWaterSheetFxByBody.clear();
    player.waterFxAccumulator = 0.0;
    playerShip.waterFxAccumulator = 0.0;
    player.wasInWater = false;
  }

  function emitSurfaceWaterFx(
    body,
    pointL,
    normalL,
    baseVelL,
    strength = 1.0,
    count = 1,
    options = {},
  ) {
    const system = getSurfaceWaterFxSystem(body);
    if (!system || strength <= 0.001 || !pointL || !normalL) return;

    const s = THREE.MathUtils.clamp(strength, 0.0, 2.0);
    const inherit = options.inherit ?? 0.12;
    const upward = options.upward ?? 0.7;
    const spread = options.spread ?? 0.8;
    const tangential = options.tangential ?? 1.0;
    const lifeMul = options.lifeMul ?? 1.0;
    const sizeMul = options.sizeMul ?? 1.0;
    const alphaMul = options.alphaMul ?? 1.0;
    const gravity = options.gravity ?? 4.2;
    const drag = options.drag ?? 2.3;

    for (let n = 0; n < count; n++) {
      const i = system.nextIndex;
      system.nextIndex = (system.nextIndex + 1) % system.particles.length;
      const particle = system.particles[i];
      if (!particle.active) {
        system.activeCount = Math.min(system.particles.length, system.activeCount + 1);
      }
      particle.active = true;
      particle.age = 0.0;
      particle.life =
        THREE.MathUtils.lerp(0.28, 0.92, Math.random()) *
        THREE.MathUtils.lerp(0.82, 1.22, Math.min(1.0, s)) *
        lifeMul;
      particle.size =
        THREE.MathUtils.lerp(0.30, 1.05, Math.random()) *
        THREE.MathUtils.lerp(0.72, 1.28, Math.min(1.0, s)) *
        sizeMul;
      particle.alpha =
        THREE.MathUtils.lerp(0.18, 0.42, Math.random()) *
        THREE.MathUtils.clamp(0.40 + s * 0.65, 0.0, 1.0) *
        alphaMul;
      particle.drag = drag;
      particle.gravity = gravity;
      particle.posL.copy(pointL).addScaledVector(normalL, 0.03 + Math.random() * 0.08);

      tmp.vA.set(
        Math.random() * 2.0 - 1.0,
        Math.random() * 2.0 - 1.0,
        Math.random() * 2.0 - 1.0,
      );
      tmp.vA.addScaledVector(normalL, -tmp.vA.dot(normalL));
      if (tmp.vA.lengthSq() < 1e-6) tmp.vA.set(1, 0, 0);
      else tmp.vA.normalize();

      tmp.vB.set(
        Math.random() * 2.0 - 1.0,
        Math.random() * 2.0 - 1.0,
        Math.random() * 2.0 - 1.0,
      );
      tmp.vB.addScaledVector(normalL, -tmp.vB.dot(normalL));
      if (tmp.vB.lengthSq() < 1e-6) tmp.vB.copy(tmp.vA).cross(normalL);
      if (tmp.vB.lengthSq() > 1e-6) tmp.vB.normalize();

      particle.velL
        .copy(baseVelL)
        .multiplyScalar(inherit)
        .addScaledVector(normalL, upward + Math.random() * (0.95 + s * 1.55))
        .addScaledVector(tmp.vA, (Math.random() * 2.0 - 1.0) * (spread + s * tangential))
        .addScaledVector(tmp.vB, (Math.random() * 2.0 - 1.0) * spread * 0.45);
    }
  }

  function emitSurfaceWaterSheet(
    body,
    pointL,
    normalL,
    tangentL,
    bitangentL,
    strength = 1.0,
    mode = "foam",
    options = {},
  ) {
    const system = getSurfaceWaterSheetSystem(body);
    if (!system || strength <= 0.001 || !pointL || !normalL) return;
    const s = THREE.MathUtils.clamp(strength, 0.0, 2.0);
    const i = system.nextIndex;
    system.nextIndex = (system.nextIndex + 1) % system.sheets.length;
    const sheet = system.sheets[i];
    if (!sheet.active) {
      system.activeCount = Math.min(system.sheets.length, system.activeCount + 1);
    }
    sheet.active = true;
    sheet.age = 0.0;
    sheet.life = (options.life ?? THREE.MathUtils.lerp(0.45, 1.25, Math.random())) * THREE.MathUtils.lerp(0.9, 1.1, Math.min(1.0, s));
    sheet.alpha = (options.alpha ?? 0.55) * THREE.MathUtils.clamp(0.45 + s * 0.55, 0.0, 1.0);
    sheet.mode = mode === "ripple" ? 1.0 : 0.0;
    sheet.sizeX0 = options.sizeX0 ?? (mode === "ripple" ? 0.55 : 0.85);
    sheet.sizeY0 = options.sizeY0 ?? (mode === "ripple" ? 0.55 : 0.55);
    sheet.sizeX1 = options.sizeX1 ?? (mode === "ripple" ? 3.8 : 2.6);
    sheet.sizeY1 = options.sizeY1 ?? (mode === "ripple" ? 3.8 : 1.25);
    sheet.spin = options.spin ?? ((Math.random() * 2.0 - 1.0) * 0.65);
    sheet.posL.copy(pointL).addScaledVector(normalL, options.lift ?? 0.065);
    sheet.normalL.copy(normalL).normalize();
    sheet.tangentL.copy(tangentL ?? tmp.eastL).addScaledVector(sheet.normalL, -sheet.normalL.dot(tangentL ?? tmp.eastL));
    if (sheet.tangentL.lengthSq() < 1e-6) {
      sheet.tangentL.copy(tmp.vA.set(1, 0, 0)).addScaledVector(sheet.normalL, -sheet.normalL.x);
      if (sheet.tangentL.lengthSq() < 1e-6) sheet.tangentL.set(0, 0, 1);
    }
    sheet.tangentL.normalize();
    if (bitangentL) {
      sheet.bitangentL.copy(bitangentL).addScaledVector(sheet.normalL, -sheet.normalL.dot(bitangentL));
      if (sheet.bitangentL.lengthSq() < 1e-6) sheet.bitangentL.crossVectors(sheet.normalL, sheet.tangentL);
      else sheet.bitangentL.normalize();
    } else {
      sheet.bitangentL.crossVectors(sheet.normalL, sheet.tangentL).normalize();
    }
    sheet.velL.copy(options.velL ?? tmp.vB.set(0, 0, 0));
  }

  function updateSurfaceWaterSheetFx(dt) {
    if (surfaceWaterSheetFxByBody.size <= 0) return;

    for (const [body, system] of surfaceWaterSheetFxByBody.entries()) {
      if (!system) continue;
      applyBodyTransformToWaterFxObject(body, system.mesh);

      if (system.activeCount <= 0) {
        system.mesh.visible = false;
        system.geometry.setDrawRange(0, 0);
        continue;
      }

      let samplePosL = null;
      let activeCount = 0;
      for (let i = 0; i < system.sheets.length; i++) {
        const sheet = system.sheets[i];
        const baseV = i * 18;
        const baseUv = i * 12;
        if (!sheet.active) {
          for (let k = 0; k < 6; k++) {
            const a = i * 6 + k;
            system.alphas[a] = 0.0;
            system.modes[a] = 0.0;
          }
          continue;
        }

        sheet.age += dt;
        if (sheet.age >= sheet.life) {
          sheet.active = false;
          for (let k = 0; k < 6; k++) {
            const a = i * 6 + k;
            system.alphas[a] = 0.0;
            system.modes[a] = 0.0;
          }
          continue;
        }

        if (!samplePosL) samplePosL = sheet.posL;

        if (sheet.spin !== 0.0) {
          tmp.qYaw.setFromAxisAngle(sheet.normalL, sheet.spin * dt);
          sheet.tangentL.applyQuaternion(tmp.qYaw).normalize();
          sheet.bitangentL.applyQuaternion(tmp.qYaw).normalize();
        }

        sheet.posL.addScaledVector(sheet.velL, dt);
        const oceanR = oceanSurfaceRadiusAtLocal(body, sheet.posL);
        if (Number.isFinite(oceanR) && oceanR > 0.0) {
          sheet.normalL.copy(sheet.posL).normalize();
          sheet.posL.copy(sheet.normalL).multiplyScalar(oceanR + 0.065);
          sheet.tangentL.addScaledVector(sheet.normalL, -sheet.normalL.dot(sheet.tangentL));
          if (sheet.tangentL.lengthSq() < 1e-6) sheet.tangentL.set(1, 0, 0).addScaledVector(sheet.normalL, -sheet.normalL.x).normalize();
          else sheet.tangentL.normalize();
          sheet.bitangentL.crossVectors(sheet.normalL, sheet.tangentL).normalize();
        }

        const age01 = sheet.age / sheet.life;
        const fadeIn = THREE.MathUtils.smoothstep(age01, 0.0, sheet.mode > 0.5 ? 0.08 : 0.12);
        const fadeOut = 1.0 - THREE.MathUtils.smoothstep(age01, sheet.mode > 0.5 ? 0.55 : 0.42, 1.0);
        const alpha = sheet.alpha * fadeIn * fadeOut;
        const sizeX = THREE.MathUtils.lerp(sheet.sizeX0, sheet.sizeX1, age01);
        const sizeY = THREE.MathUtils.lerp(sheet.sizeY0, sheet.sizeY1, age01);

        tmp.vA.copy(sheet.tangentL).multiplyScalar(sizeX);
        tmp.vB.copy(sheet.bitangentL).multiplyScalar(sizeY);
        tmp.vC.copy(sheet.posL).sub(tmp.vA).sub(tmp.vB);
        tmp.vD.copy(sheet.posL).add(tmp.vA).sub(tmp.vB);
        tmp.vE.copy(sheet.posL).add(tmp.vA).add(tmp.vB);
        tmp.vF.copy(sheet.posL).sub(tmp.vA).add(tmp.vB);

        const verts = [tmp.vC, tmp.vD, tmp.vE, tmp.vC, tmp.vE, tmp.vF];
        for (let k = 0; k < 6; k++) {
          const v = verts[k];
          const pIdx = baseV + k * 3;
          system.positions[pIdx] = v.x;
          system.positions[pIdx + 1] = v.y;
          system.positions[pIdx + 2] = v.z;
          const a = i * 6 + k;
          system.alphas[a] = alpha;
          system.modes[a] = sheet.mode;
        }
        activeCount++;
      }

      system.activeCount = activeCount;
      system.mesh.visible = activeCount > 0;
      system.geometry.setDrawRange(0, system.sheets.length * 6);
      system.geometry.attributes.position.needsUpdate = true;
      system.geometry.attributes.aAlpha.needsUpdate = true;
      system.geometry.attributes.aMode.needsUpdate = true;
      system.mesh.material.uniforms.uLight.value = samplePosL ? sampleWaterFxLight(body, samplePosL) : 0.28;
    }
  }

  function updateSurfaceWaterFx(dt) {
    if (surfaceWaterFxByBody.size <= 0 && surfaceWaterSheetFxByBody.size <= 0) return;

    for (const [body, system] of surfaceWaterFxByBody.entries()) {
      if (!system) continue;

      // Geometry is authored in body-local coordinates, but the Points object
      // lives in a standalone foreground scene. Mirror the body's current world
      // transform here so old spray/wake particles ride planet/moon orbit + spin
      // exactly as they did when parented under body.group.
      applyBodyTransformToWaterFxObject(body, system.points);

      if (system.activeCount <= 0) {
        system.points.visible = false;
        continue;
      }

      let samplePosL = null;
      for (const particle of system.particles) {
        if (particle.active) {
          samplePosL = particle.posL;
          break;
        }
      }
      system.points.material.uniforms.uLight.value = samplePosL
        ? sampleWaterFxLight(body, samplePosL)
        : 0.28;

      let activeCount = 0;
      for (let i = 0; i < system.particles.length; i++) {
        const particle = system.particles[i];
        if (!particle.active) {
          system.alphas[i] = 0.0;
          system.sizes[i] = 0.0;
          continue;
        }

        particle.age += dt;
        if (particle.age >= particle.life) {
          particle.active = false;
          system.alphas[i] = 0.0;
          system.sizes[i] = 0.0;
          continue;
        }

        tmp.vA.copy(particle.posL);
        const r = tmp.vA.length();
        if (r > 1e-5) {
          particle.velL.addScaledVector(tmp.vA, (-particle.gravity * dt) / r);
        }
        particle.velL.multiplyScalar(Math.exp(-particle.drag * dt));
        particle.posL.addScaledVector(particle.velL, dt);

        const age01 = particle.age / particle.life;
        const fadeIn = THREE.MathUtils.smoothstep(age01, 0.0, 0.10);
        const fadeOut = 1.0 - THREE.MathUtils.smoothstep(age01, 0.42, 1.0);
        const i3 = i * 3;
        system.positions[i3] = particle.posL.x;
        system.positions[i3 + 1] = particle.posL.y;
        system.positions[i3 + 2] = particle.posL.z;
        system.alphas[i] = particle.alpha * fadeIn * fadeOut;
        system.sizes[i] = particle.size * (1.0 + age01 * 1.9);
        activeCount++;
      }

      system.activeCount = activeCount;
      system.points.visible = activeCount > 0;
      system.geometry.attributes.position.needsUpdate = true;
      system.geometry.attributes.aAlpha.needsUpdate = true;
      system.geometry.attributes.aSize.needsUpdate = true;
    }

    updateSurfaceWaterSheetFx(dt);
  }

  function emitFootWaterEffects(
    body,
    dt,
    moveMag,
    moveSpeed,
    swimming,
    verticalInput,
    feetWaterDepth,
    oceanR,
    surfaceR,
  ) {
    if (!body?.hasOcean || !Number.isFinite(oceanR) || oceanR <= 0.0) {
      player.waterFxAccumulator = 0.0;
      player.wasInWater = false;
      return;
    }

    const inWaterNow = player.inWater;
    if (inWaterNow && !player.wasInWater) {
      tmp.waterFxPointL.copy(player.dirLocal).multiplyScalar(Math.max(oceanR, surfaceR + 0.02));
      tmp.waterFxVelL.copy(tmp.moveDirL).multiplyScalar(moveSpeed * Math.max(0.3, moveMag));
      emitSurfaceWaterFx(
        body,
        tmp.waterFxPointL,
        player.dirLocal,
        tmp.waterFxVelL,
        0.55 + Math.min(0.65, Math.abs(player.radialVel) * 0.08),
        8,
        {
          upward: 0.9,
          spread: 0.8,
          tangential: 1.3,
          lifeMul: 0.85,
          sizeMul: 0.95,
          alphaMul: 1.0,
          gravity: 4.7,
          drag: 2.0,
        },
      );
      emitSurfaceWaterSheet(
        body,
        tmp.waterFxPointL,
        player.dirLocal,
        tmp.rightMoveL.lengthSq() > 1e-8 ? tmp.rightMoveL : tmp.eastL,
        tmp.moveDirL.lengthSq() > 1e-8 ? tmp.moveDirL : tmp.northL,
        0.72,
        "ripple",
        { sizeX0: 0.35, sizeY0: 0.35, sizeX1: 2.2, sizeY1: 2.2, life: 0.95, alpha: 0.48 }
      );
    }
    player.wasInWater = inWaterNow;

    if (!inWaterNow) {
      player.waterFxAccumulator = Math.max(0.0, player.waterFxAccumulator - dt * 3.0);
      return;
    }

    const moving = moveMag > 0.08;
    const active = swimming
      ? (moving || Math.abs(verticalInput) > 0.08)
      : (moving && feetWaterDepth > 0.035);
    if (!active) {
      player.waterFxAccumulator = Math.max(0.0, player.waterFxAccumulator - dt * 2.0);
      return;
    }

    const emitStrength = swimming
      ? THREE.MathUtils.clamp(0.22 + moveSpeed * 0.08 + Math.abs(verticalInput) * 0.25, 0.0, 1.0)
      : THREE.MathUtils.clamp(0.18 + moveSpeed * 0.12 + feetWaterDepth * 1.6, 0.0, 1.0);
    player.waterFxAccumulator += dt * (swimming ? (5.5 + emitStrength * 8.0) : (6.5 + emitStrength * 10.0));

    while (player.waterFxAccumulator >= 1.0) {
      tmp.waterFxVelL.copy(tmp.moveDirL).multiplyScalar(moveSpeed * Math.max(0.25, moveMag));
      if (swimming) {
        tmp.waterFxPointL.copy(player.dirLocal).multiplyScalar(Math.max(oceanR - 0.06, surfaceR + player.height * 0.55));
        emitSurfaceWaterFx(
          body,
          tmp.waterFxPointL,
          player.dirLocal,
          tmp.waterFxVelL,
          emitStrength,
          2,
          {
            upward: 0.45,
            spread: 0.55,
            tangential: 1.0,
            lifeMul: 0.62,
            sizeMul: 0.72,
            alphaMul: 0.72,
            gravity: 3.2,
            drag: 2.35,
          },
        );
        emitSurfaceWaterSheet(
          body,
          tmp.waterFxPointL,
          player.dirLocal,
          tmp.moveDirL.lengthSq() > 1e-8 ? tmp.moveDirL : tmp.eastL,
          tmp.rightMoveL.lengthSq() > 1e-8 ? tmp.rightMoveL : tmp.northL,
          emitStrength,
          "ripple",
          { sizeX0: 0.22, sizeY0: 0.22, sizeX1: 1.35, sizeY1: 1.35, life: 0.58, alpha: 0.22 }
        );
      } else {
        const side = (Math.floor(player.waterFxAccumulator * 10.0) % 2 === 0) ? -1.0 : 1.0;
        tmp.waterFxRightL.copy(tmp.rightMoveL);
        if (tmp.waterFxRightL.lengthSq() < 1e-8) tmp.waterFxRightL.copy(tmp.eastL);
        tmp.waterFxPointL.copy(player.dirLocal).multiplyScalar(Math.max(oceanR, surfaceR + 0.02));
        tmp.waterFxPointL.addScaledVector(tmp.waterFxRightL, side * 0.18);
        emitSurfaceWaterFx(
          body,
          tmp.waterFxPointL,
          player.dirLocal,
          tmp.waterFxVelL,
          emitStrength,
          2,
          {
            upward: 0.75,
            spread: 0.7,
            tangential: 1.25,
            lifeMul: 0.55,
            sizeMul: 0.70,
            alphaMul: 0.82,
            gravity: 4.8,
            drag: 2.1,
          },
        );
        emitSurfaceWaterSheet(
          body,
          tmp.waterFxPointL,
          player.dirLocal,
          tmp.moveDirL.lengthSq() > 1e-8 ? tmp.moveDirL : tmp.eastL,
          tmp.waterFxRightL,
          emitStrength,
          "foam",
          { sizeX0: 0.28, sizeY0: 0.18, sizeX1: 0.95, sizeY1: 0.42, life: 0.45, alpha: 0.34,
            velL: tmp.vA.copy(tmp.moveDirL).multiplyScalar(moveSpeed * 0.08) }
        );
      }
      player.waterFxAccumulator -= 1.0;
    }
  }

  function emitShipWaterEffects(dt, body, immersion, forwardW, rightW) {
    if (!body?.hasOcean || immersion <= 0.0 || !body.group) {
      playerShip.waterFxAccumulator = 0.0;
      playerShip.waterImmersion = 0.0;
      return;
    }

    const shipSpeed = player.worldVel.length();
    const speed01 = THREE.MathUtils.smoothstep(shipSpeed, 1.5, 26.0);
    const surface01 = THREE.MathUtils.smoothstep(immersion, 0.02, 0.75);
    const emitStrength = THREE.MathUtils.clamp(speed01 * (0.22 + surface01 * 0.95), 0.0, 1.35);

    if (immersion > playerShip.waterImmersion + 0.08 && shipSpeed > 2.5) {
      body.group.worldToLocal(tmp.waterFxPointL.copy(player.worldPos));
      tmp.waterFxNormalL.copy(tmp.waterFxPointL).normalize();
      const oceanR = oceanSurfaceRadiusAtLocal(body, tmp.waterFxPointL);
      if (Number.isFinite(oceanR)) {
        tmp.waterFxPointL.copy(tmp.waterFxNormalL).multiplyScalar(oceanR);
        tmp.vehicleBodyInvQuat.copy(body.group.getWorldQuaternion(tmp.worldQuat)).invert();
        tmp.waterFxVelL.copy(player.worldVel).applyQuaternion(tmp.vehicleBodyInvQuat);
        emitSurfaceWaterFx(body, tmp.waterFxPointL, tmp.waterFxNormalL, tmp.waterFxVelL, 0.95, 14, {
          upward: 1.25,
          spread: 1.1,
          tangential: 1.4,
          lifeMul: 1.05,
          sizeMul: 1.1,
          alphaMul: 1.0,
          gravity: 4.3,
          drag: 1.8,
        });
        emitSurfaceWaterSheet(
          body,
          tmp.waterFxPointL,
          tmp.waterFxNormalL,
          tmp.eastL,
          tmp.northL,
          0.98,
          "ripple",
          { sizeX0: 0.7, sizeY0: 0.7, sizeX1: 5.8, sizeY1: 5.8, life: 1.15, alpha: 0.5 }
        );
      }
    }
    playerShip.waterImmersion = immersion;

    if (emitStrength <= 0.04) {
      playerShip.waterFxAccumulator = Math.max(0.0, playerShip.waterFxAccumulator - dt * 2.0);
      return;
    }

    tmp.vehicleBodyInvQuat.copy(body.group.getWorldQuaternion(tmp.worldQuat)).invert();
    tmp.waterFxForwardL.copy(forwardW).applyQuaternion(tmp.vehicleBodyInvQuat);
    tmp.waterFxRightL.copy(rightW).applyQuaternion(tmp.vehicleBodyInvQuat);
    body.group.worldToLocal(tmp.waterFxPointL.copy(player.worldPos));
    tmp.waterFxNormalL.copy(tmp.waterFxPointL);
    if (tmp.waterFxNormalL.lengthSq() < 1e-8) tmp.waterFxNormalL.set(0, 1, 0);
    else tmp.waterFxNormalL.normalize();
    tmp.waterFxForwardL.addScaledVector(tmp.waterFxNormalL, -tmp.waterFxForwardL.dot(tmp.waterFxNormalL));
    tmp.waterFxRightL.addScaledVector(tmp.waterFxNormalL, -tmp.waterFxRightL.dot(tmp.waterFxNormalL));
    if (tmp.waterFxForwardL.lengthSq() < 1e-8) tmp.waterFxForwardL.copy(tmp.eastL);
    else tmp.waterFxForwardL.normalize();
    if (tmp.waterFxRightL.lengthSq() < 1e-8) tmp.waterFxRightL.copy(tmp.waterFxForwardL).cross(tmp.waterFxNormalL).normalize();
    else tmp.waterFxRightL.normalize();
    const oceanR = oceanSurfaceRadiusAtLocal(body, tmp.waterFxPointL);
    if (!Number.isFinite(oceanR)) return;
    tmp.waterFxVelL.copy(player.worldVel).applyQuaternion(tmp.vehicleBodyInvQuat);
    const baseRate = 4.0 + emitStrength * 10.0;
    playerShip.waterFxAccumulator += dt * baseRate;
    while (playerShip.waterFxAccumulator >= 1.0) {
      for (const side of [-1.0, 1.0]) {
        const bow = 1.65;
        const beam = 1.65;
        tmp.vA.copy(tmp.waterFxNormalL).multiplyScalar(oceanR)
          .addScaledVector(tmp.waterFxForwardL, bow)
          .addScaledVector(tmp.waterFxRightL, side * beam);
        emitSurfaceWaterFx(body, tmp.vA, tmp.waterFxNormalL, tmp.waterFxVelL, emitStrength, 2, {
          upward: 0.9,
          spread: 1.0,
          tangential: 1.5,
          lifeMul: 0.9,
          sizeMul: 0.92,
          alphaMul: 0.86,
          gravity: 3.8,
          drag: 1.55,
        });
        emitSurfaceWaterSheet(
          body,
          tmp.vA,
          tmp.waterFxNormalL,
          tmp.waterFxForwardL,
          tmp.waterFxRightL,
          emitStrength,
          "foam",
          { sizeX0: 0.85, sizeY0: 0.32, sizeX1: 2.6, sizeY1: 0.78, life: 0.72, alpha: 0.34,
            velL: tmp.vC.copy(tmp.waterFxVelL).multiplyScalar(0.08) }
        );
      }
      tmp.vB.copy(tmp.waterFxNormalL).multiplyScalar(oceanR)
        .addScaledVector(tmp.waterFxForwardL, -2.4);
      emitSurfaceWaterFx(body, tmp.vB, tmp.waterFxNormalL, tmp.waterFxVelL, emitStrength * 0.82, 2, {
        upward: 0.28,
        spread: 0.82,
        tangential: 1.25,
        lifeMul: 1.15,
        sizeMul: 1.0,
        alphaMul: 0.68,
        gravity: 2.1,
        drag: 1.2,
      });
      emitSurfaceWaterSheet(
        body,
        tmp.vB,
        tmp.waterFxNormalL,
        tmp.waterFxForwardL,
        tmp.waterFxRightL,
        emitStrength * 0.88,
        "ripple",
        { sizeX0: 0.55, sizeY0: 0.26, sizeX1: 3.2, sizeY1: 0.85, life: 0.98, alpha: 0.22,
          velL: tmp.vD.copy(tmp.waterFxVelL).multiplyScalar(0.05) }
      );
      playerShip.waterFxAccumulator -= 1.0;
    }
  }

  function getSurfaceVehicleBodyVelocityAtPoint(pointL, out) {
    return out
      .copy(playerVehicle.angularVelocityL)
      .cross(tmp.vehicleLeverL.copy(pointL).sub(playerVehicle.positionL))
      .add(playerVehicle.linearVelocityL);
  }

  function emitSurfaceVehicleWaterEffects(body, dt) {
    if (!body?.hasOcean) return;
    for (const wheel of playerVehicle.suspension) {
      if (!wheel.contact || wheel.waterSubmersion <= 0.03) {
        wheel.sprayAccumulator = Math.max(0.0, (wheel.sprayAccumulator ?? 0.0) - dt * 2.0);
        continue;
      }
      const wheelGroundSpeed = Math.hypot(wheel.longitudinalSpeed, wheel.lateralSpeed);
      const speed01 = THREE.MathUtils.smoothstep(wheelGroundSpeed, 0.9, 13.0);
      const emitStrength = THREE.MathUtils.clamp(
        speed01 * (0.15 + wheel.waterSubmersion * 1.05),
        0.0,
        1.15,
      );
      if (emitStrength <= 0.035) {
        wheel.sprayAccumulator = Math.max(0.0, (wheel.sprayAccumulator ?? 0.0) - dt * 2.0);
        continue;
      }
      wheel.sprayAccumulator = (wheel.sprayAccumulator ?? 0.0) + dt * (3.5 + emitStrength * 12.0);
      getSurfaceVehicleBodyVelocityAtPoint(wheel.contactPointL, tmp.waterFxVelL);
      while (wheel.sprayAccumulator >= 1.0) {
        emitSurfaceWaterFx(body, wheel.contactPointL, wheel.surfaceNormalL, tmp.waterFxVelL, emitStrength, 1, {
          upward: 0.72,
          spread: 0.72,
          tangential: 1.1,
          lifeMul: 0.65,
          sizeMul: 0.75,
          alphaMul: 0.78,
          gravity: 4.4,
          drag: 1.9,
        });
        emitSurfaceWaterSheet(
          body,
          wheel.contactPointL,
          wheel.surfaceNormalL,
          wheel.forwardDirL,
          wheel.rightDirL,
          emitStrength,
          "foam",
          { sizeX0: 0.36, sizeY0: 0.18, sizeX1: 1.1, sizeY1: 0.42, life: 0.42, alpha: 0.28,
            velL: tmp.vA.copy(tmp.waterFxVelL).multiplyScalar(0.06) }
        );
        wheel.sprayAccumulator -= 1.0;
      }
    }

    if (playerVehicle.inWater && playerVehicle.waterSubmersion > 0.04) {
      const bodySpeed = playerVehicle.linearVelocityL.length();
      const emitStrength = THREE.MathUtils.clamp(
        THREE.MathUtils.smoothstep(bodySpeed, 1.2, 16.0) *
          (0.20 + playerVehicle.waterSubmersion * 0.9),
        0.0,
        1.0,
      );
      if (emitStrength > 0.05) {
        playerVehicle.waterFxAccumulator = (playerVehicle.waterFxAccumulator ?? 0.0) + dt * (2.0 + emitStrength * 6.0);
        while (playerVehicle.waterFxAccumulator >= 1.0) {
          tmp.waterFxPointL.set(0.0, 0.42, -2.8)
            .applyQuaternion(playerVehicle.orientationL)
            .add(playerVehicle.positionL);
          tmp.waterFxNormalL.copy(tmp.waterFxPointL).normalize();
          tmp.waterFxVelL.copy(playerVehicle.linearVelocityL);
          emitSurfaceWaterFx(body, tmp.waterFxPointL, tmp.waterFxNormalL, tmp.waterFxVelL, emitStrength, 2, {
            upward: 0.62,
            spread: 0.82,
            tangential: 1.25,
            lifeMul: 0.72,
            sizeMul: 0.82,
            alphaMul: 0.74,
            gravity: 3.9,
            drag: 1.7,
          });
          emitSurfaceWaterSheet(
            body,
            tmp.waterFxPointL,
            tmp.waterFxNormalL,
            tmp.vehicleForwardL,
            tmp.vehicleRightL,
            emitStrength,
            "foam",
            { sizeX0: 0.65, sizeY0: 0.28, sizeX1: 1.9, sizeY1: 0.72, life: 0.6, alpha: 0.26,
              velL: tmp.vB.copy(tmp.waterFxVelL).multiplyScalar(0.05) }
          );
          playerVehicle.waterFxAccumulator -= 1.0;
        }
      } else {
        playerVehicle.waterFxAccumulator = Math.max(0.0, (playerVehicle.waterFxAccumulator ?? 0.0) - dt * 2.0);
      }
    }
  }

  function getSurfaceVehicleSkidMarkSystem(body) {
    if (!body?.group) return null;
    let system = playerVehicle.skidMarksByBody.get(body);
    if (!system) {
      system = createRoverSkidMarkSystem(THREE);
      playerVehicle.skidMarksByBody.set(body, system);
      body.group.add(system.mesh);
    } else if (system.mesh.parent !== body.group) {
      body.group.add(system.mesh);
    }
    system.mesh.position.set(0, 0, 0);
    system.mesh.quaternion.identity();
    system.mesh.scale.set(1, 1, 1);
    return system;
  }

  function clearSurfaceVehicleSkidMarks() {
    for (const system of playerVehicle.skidMarksByBody.values()) {
      if (!system) continue;
      system.mesh?.removeFromParent?.();
      system.geometry?.dispose?.();
      system.mesh?.material?.dispose?.();
    }
    playerVehicle.skidMarksByBody.clear();
    for (const wheel of playerVehicle.suspension) {
      wheel.skidMarkActive = false;
      wheel.skidMarkBodyIndex = -1;
    }
  }

  function writeSurfaceVehicleSkidVertex(system, vertex, p, alpha) {
    const i3 = vertex * 3;
    system.positions[i3] = p.x;
    system.positions[i3 + 1] = p.y;
    system.positions[i3 + 2] = p.z;
    system.alphas[vertex] = alpha;
  }

  function emitSurfaceVehicleSkidSegment(
    body,
    fromPointL,
    fromNormalL,
    toPointL,
    toNormalL,
    strength,
  ) {
    const system = getSurfaceVehicleSkidMarkSystem(body);
    if (!system) return;

    tmp.vehicleSkidDirL.copy(toPointL).sub(fromPointL);
    const segmentLength = tmp.vehicleSkidDirL.length();
    if (!(segmentLength > 0.035) || segmentLength > 2.8) return;
    tmp.vehicleSkidDirL.multiplyScalar(1.0 / segmentLength);

    tmp.vehicleSkidNormalL.copy(fromNormalL).add(toNormalL);
    if (tmp.vehicleSkidNormalL.lengthSq() < 1e-8) {
      tmp.vehicleSkidNormalL.copy(toNormalL);
    }
    tmp.vehicleSkidNormalL.normalize();

    // A visible rubber strip is slightly narrower than the 0.68 m tire mesh.
    // Each endpoint uses its own terrain normal so the quad follows rendered
    // triangle slope changes rather than floating on one averaged plane.
    const halfWidth = 0.245;
    const surfaceLift = 0.035;

    tmp.vehicleSkidSideA
      .copy(tmp.vehicleSkidDirL)
      .cross(fromNormalL);
    if (tmp.vehicleSkidSideA.lengthSq() < 1e-8) {
      tmp.vehicleSkidSideA
        .copy(tmp.vehicleSkidDirL)
        .cross(tmp.vehicleSkidNormalL);
    }
    if (tmp.vehicleSkidSideA.lengthSq() < 1e-8) return;
    tmp.vehicleSkidSideA.normalize();

    tmp.vehicleSkidSideB
      .copy(tmp.vehicleSkidDirL)
      .cross(toNormalL);
    if (tmp.vehicleSkidSideB.lengthSq() < 1e-8) {
      tmp.vehicleSkidSideB.copy(tmp.vehicleSkidSideA);
    } else {
      tmp.vehicleSkidSideB.normalize();
      if (tmp.vehicleSkidSideB.dot(tmp.vehicleSkidSideA) < 0.0) {
        tmp.vehicleSkidSideB.multiplyScalar(-1.0);
      }
    }

    tmp.vehicleSkidP0
      .copy(fromPointL)
      .addScaledVector(fromNormalL, surfaceLift)
      .addScaledVector(tmp.vehicleSkidSideA, halfWidth);
    tmp.vehicleSkidP1
      .copy(fromPointL)
      .addScaledVector(fromNormalL, surfaceLift)
      .addScaledVector(tmp.vehicleSkidSideA, -halfWidth);
    tmp.vehicleSkidP2
      .copy(toPointL)
      .addScaledVector(toNormalL, surfaceLift)
      .addScaledVector(tmp.vehicleSkidSideB, halfWidth);
    tmp.vehicleSkidP3
      .copy(toPointL)
      .addScaledVector(toNormalL, surfaceLift)
      .addScaledVector(tmp.vehicleSkidSideB, -halfWidth);

    const alpha = THREE.MathUtils.clamp(
      0.30 + THREE.MathUtils.clamp(strength, 0.0, 1.2) * 0.38,
      0.30,
      0.72,
    );
    const slot = system.nextSegment;
    const base = slot * 6;
    writeSurfaceVehicleSkidVertex(system, base, tmp.vehicleSkidP0, alpha);
    writeSurfaceVehicleSkidVertex(system, base + 1, tmp.vehicleSkidP1, alpha);
    writeSurfaceVehicleSkidVertex(system, base + 2, tmp.vehicleSkidP2, alpha);
    writeSurfaceVehicleSkidVertex(system, base + 3, tmp.vehicleSkidP2, alpha);
    writeSurfaceVehicleSkidVertex(system, base + 4, tmp.vehicleSkidP1, alpha);
    writeSurfaceVehicleSkidVertex(system, base + 5, tmp.vehicleSkidP3, alpha);

    system.nextSegment = (slot + 1) % system.maxSegments;
    system.segmentCount = Math.min(system.maxSegments, system.segmentCount + 1);
    system.geometry.setDrawRange(0, system.segmentCount * 6);
    system.geometry.attributes.position.needsUpdate = true;
    system.geometry.attributes.aAlpha.needsUpdate = true;
    system.mesh.visible = system.segmentCount > 0;
  }

  function updateSurfaceVehicleWheelSkidMark(body, wheel, markStrength) {
    const wheelGroundSpeed = Math.hypot(
      wheel.longitudinalSpeed,
      wheel.lateralSpeed,
    );
    const active =
      !!body?.group &&
      wheel.contact &&
      wheelGroundSpeed > 1.8 &&
      markStrength > 0.12;

    if (!active) {
      wheel.skidMarkActive = false;
      return;
    }

    if (
      !wheel.skidMarkActive ||
      wheel.skidMarkBodyIndex !== playerVehicle.bodyIndex
    ) {
      wheel.skidMarkActive = true;
      wheel.skidMarkBodyIndex = playerVehicle.bodyIndex;
      wheel.skidMarkLastPointL.copy(wheel.contactPointL);
      wheel.skidMarkLastNormalL.copy(wheel.surfaceNormalL);
      return;
    }

    const travel = wheel.skidMarkLastPointL.distanceTo(wheel.contactPointL);
    if (travel > 2.8) {
      // Teleport/jump/contact discontinuity: restart instead of drawing a bridge.
      wheel.skidMarkLastPointL.copy(wheel.contactPointL);
      wheel.skidMarkLastNormalL.copy(wheel.surfaceNormalL);
      return;
    }
    if (travel < 0.045) return;

    emitSurfaceVehicleSkidSegment(
      body,
      wheel.skidMarkLastPointL,
      wheel.skidMarkLastNormalL,
      wheel.contactPointL,
      wheel.surfaceNormalL,
      markStrength,
    );
    wheel.skidMarkLastPointL.copy(wheel.contactPointL);
    wheel.skidMarkLastNormalL.copy(wheel.surfaceNormalL);
  }

  function syncSurfaceVehicleTransform() {
    if (!playerVehicle.deployed) {
      playerVehicle.root.visible = false;
      return false;
    }

    const b = bodies[playerVehicle.bodyIndex];
    if (!b?.group || b?.collidable === false) {
      playerVehicle.deployed = false;
      playerVehicle.root.visible = false;
      return false;
    }

    deriveSurfaceVehicleLocalFrame();
    b.group.updateMatrixWorld(true);
    tmp.playerPosW.copy(playerVehicle.positionL).applyMatrix4(b.group.matrixWorld);
    b.group.getWorldQuaternion(tmp.vehicleBodyWorldQuat);
    tmp.vehicleWorldQuat
      .copy(tmp.vehicleBodyWorldQuat)
      .multiply(playerVehicle.orientationL)
      .normalize();

    tmp.vehicleForwardW
      .copy(tmp.vehicleForwardL)
      .applyQuaternion(tmp.vehicleBodyWorldQuat)
      .normalize();
    tmp.vehicleRightW
      .copy(tmp.vehicleRightL)
      .applyQuaternion(tmp.vehicleBodyWorldQuat)
      .normalize();
    tmp.vehicleUpW
      .copy(tmp.vehicleUpL)
      .applyQuaternion(tmp.vehicleBodyWorldQuat)
      .normalize();

    playerVehicle.root.position.copy(tmp.playerPosW);
    playerVehicle.root.quaternion.copy(tmp.vehicleWorldQuat);
    playerVehicle.root.visible = true;
    playerVehicle.root.updateMatrixWorld(true);

    for (let i = 0; i < playerVehicle.suspension.length; i++) {
      const suspension = playerVehicle.suspension[i];
      suspension.pivot.position.y =
        ROVER_SUSPENSION_MOUNT_Y - suspension.springLength;
      suspension.pivot.rotation.y = suspension.steerAngle;
    }

    if (player.mode === "drive") {
      player.worldPos.copy(tmp.playerPosW);
      // Deliberately expose rover velocity RELATIVE TO THE HOST BODY. We rotate
      // local velocity into world orientation for HUD/camera consumers, but do
      // not add the host planet's orbital or spin velocity.
      player.worldVel
        .copy(playerVehicle.linearVelocityL)
        .applyQuaternion(tmp.vehicleBodyWorldQuat);
      player.bodyIndex = playerVehicle.bodyIndex;
      player.inWater = playerVehicle.inWater;
      player.swimming = false;
      const roverCenterWaterDepth = sampleOceanDepthLocal(
        b,
        playerVehicle.positionL,
        tmp.waterUpLocal,
      );
      player.waterDepth = Number.isFinite(roverCenterWaterDepth)
        ? Math.max(0.0, roverCenterWaterDepth)
        : 0.0;
    }
    return true;
  }

  function oceanSurfaceRadiusAtLocal(body, pointL) {
    if (!body?.hasOcean) return -Infinity;

    let surfaceR = Number(body.seaLevel);
    if (typeof body.oceanSurfaceRadiusAtLocalPoint === "function") {
      const r = body.oceanSurfaceRadiusAtLocalPoint(pointL);
      if (Number.isFinite(r)) surfaceR = r;
    } else if (typeof body.oceanSurfaceRadiusAtWorldPoint === "function") {
      body.group?.updateMatrixWorld?.(true);
      tmp.waterSampleWorld.copy(pointL).applyMatrix4(body.group.matrixWorld);
      const r = body.oceanSurfaceRadiusAtWorldPoint(tmp.waterSampleWorld);
      if (Number.isFinite(r)) surfaceR = r;
    }

    return Number.isFinite(surfaceR) ? surfaceR : -Infinity;
  }

  function sampleOceanDepthLocal(body, pointL, normalOut = null) {
    if (!body?.hasOcean || !pointL) return -Infinity;
    const radius = pointL.length();
    if (radius <= 1e-8) return -Infinity;
    const surfaceR = oceanSurfaceRadiusAtLocal(body, pointL);
    if (!Number.isFinite(surfaceR)) return -Infinity;
    if (normalOut) normalOut.copy(pointL).multiplyScalar(1.0 / radius);
    return surfaceR - radius;
  }

  function sampleOceanDepthWorld(body, worldPoint, normalOut = null) {
    if (!body?.hasOcean || !body.group || !worldPoint) return -Infinity;
    body.group.getWorldPosition(tmp.waterCenterWorld);
    tmp.waterUpWorld.copy(worldPoint).sub(tmp.waterCenterWorld);
    const radius = tmp.waterUpWorld.length();
    if (radius <= 1e-8) return -Infinity;
    if (normalOut) normalOut.copy(tmp.waterUpWorld).multiplyScalar(1.0 / radius);

    let surfaceR = Number(body.seaLevel);
    if (typeof body.oceanSurfaceRadiusAtWorldPoint === "function") {
      const r = body.oceanSurfaceRadiusAtWorldPoint(worldPoint);
      if (Number.isFinite(r)) surfaceR = r;
    }
    if (!Number.isFinite(surfaceR)) return -Infinity;
    return surfaceR - radius;
  }

  function sampleSurfaceVehicleTerrain(body, pointL, normalOut, surfaceOut = null) {
    // Prefer the triangles that are ACTUALLY being rendered. The terrain mesh
    // samples the continuous FBM at patch vertices and linearly interpolates
    // between them; LOD edge stitching can move those vertices again. On a
    // steep slope that visible triangle plane can differ noticeably from the
    // smooth analytic height function even though both originate from the same
    // radiusAtDir(). Vehicle contacts therefore use the rendered surface as the
    // authoritative collision surface whenever the current patch is available.
    if (
      surfaceOut &&
      typeof body?.sampleRenderedTerrainSurfaceLocal === "function"
    ) {
      const renderedDistance = body.sampleRenderedTerrainSurfaceLocal(
        pointL,
        normalOut,
        surfaceOut,
      );
      if (Number.isFinite(renderedDistance)) return renderedDistance;
    }

    // Fallback for the brief period while a terrain patch is still generating:
    // Planet terrain exposes F(p) = |p| - radiusAtDir(normalize(p)). That is an
    // excellent implicit surface, but F itself is NOT a Euclidean signed
    // distance once the terrain is sloped. Convert it to a first-order metric
    // distance using F / |grad(F)|.
    const eps = Math.max(0.11, playerVehicle.wheelRadius * 0.14);
    const px = pointL.x;
    const py = pointL.y;
    const pz = pointL.z;
    const f0 = body.sdf(px, py, pz);
    const inv2e = 1.0 / (2.0 * eps);
    const gx =
      (body.sdf(px + eps, py, pz) - body.sdf(px - eps, py, pz)) * inv2e;
    const gy =
      (body.sdf(px, py + eps, pz) - body.sdf(px, py - eps, pz)) * inv2e;
    const gz =
      (body.sdf(px, py, pz + eps) - body.sdf(px, py, pz - eps)) * inv2e;
    let gradLen = Math.hypot(gx, gy, gz);

    if (!(gradLen > 1e-6)) {
      normalOut.copy(pointL);
      if (normalOut.lengthSq() < 1e-10) normalOut.set(0, 1, 0);
      normalOut.normalize();
      gradLen = 1.0;
    } else {
      normalOut.set(gx / gradLen, gy / gradLen, gz / gradLen);
    }

    let signedDistance = f0 / gradLen;
    if (surfaceOut) {
      // Newton-project toward the actual procedural surface, then re-sample the
      // gradient at that projected point. Tire forces need the SURFACE normal,
      // not merely the gradient at a wheel center almost a metre above it.
      surfaceOut.copy(pointL).addScaledVector(normalOut, -signedDistance);
      let sx = surfaceOut.x;
      let sy = surfaceOut.y;
      let sz = surfaceOut.z;
      let residual = body.sdf(sx, sy, sz);
      surfaceOut.addScaledVector(normalOut, -residual / gradLen);

      sx = surfaceOut.x;
      sy = surfaceOut.y;
      sz = surfaceOut.z;
      const sgx =
        (body.sdf(sx + eps, sy, sz) - body.sdf(sx - eps, sy, sz)) * inv2e;
      const sgy =
        (body.sdf(sx, sy + eps, sz) - body.sdf(sx, sy - eps, sz)) * inv2e;
      const sgz =
        (body.sdf(sx, sy, sz + eps) - body.sdf(sx, sy, sz - eps)) * inv2e;
      const surfaceGradLen = Math.hypot(sgx, sgy, sgz);
      if (surfaceGradLen > 1e-6) {
        normalOut.set(
          sgx / surfaceGradLen,
          sgy / surfaceGradLen,
          sgz / surfaceGradLen,
        );
        residual = body.sdf(sx, sy, sz);
        surfaceOut.addScaledVector(
          normalOut,
          -residual / surfaceGradLen,
        );
      }

      // With a projected surface point available, use its actual separation
      // from the query point as the final signed metric. This is more accurate
      // for the chassis spheres than the first-order F/|grad(F)| estimate.
      const sign = f0 < 0.0 ? -1.0 : 1.0;
      signedDistance = sign * pointL.distanceTo(surfaceOut);
    }
    return signedDistance;
  }

  function probeSurfaceVehicleSuspension(body, wheel) {
    tmp.vehiclePhysicsDownL
      .set(0, -1, 0)
      .applyQuaternion(playerVehicle.orientationL)
      .normalize();
    tmp.vehicleMountL
      .copy(wheel.mountLocal)
      .applyQuaternion(playerVehicle.orientationL)
      .add(playerVehicle.positionL);

    const down = tmp.vehiclePhysicsDownL;
    const mount = tmp.vehicleMountL;
    const radius = playerVehicle.wheelRadius;

    // Normal path: collide the suspension directly with the currently visible
    // terrain triangle. A single ray gives the exact rendered plane; offset the
    // wheel centre by radius / cos(slope) along the suspension axis so the tire
    // sphere touches that plane without relying on the smooth FBM between mesh
    // vertices. This is both more accurate and cheaper than repeatedly sampling
    // the analytic surface through the suspension stroke.
    if (typeof body?.raycastRenderedTerrainLocal === "function") {
      const rayLength = wheel.maxLength + radius * 4.0 + 1.0;
      if (
        body.raycastRenderedTerrainLocal(
          mount,
          down,
          rayLength,
          wheel.contactPointL,
          wheel.surfaceNormalL,
        )
      ) {
        tmp.vehicleProbeL.copy(wheel.contactPointL).sub(mount);
        const hitDistance = tmp.vehicleProbeL.dot(down);
        const approach = -down.dot(wheel.surfaceNormalL);
        if (hitDistance >= -0.02 && approach > 0.10) {
          const centerLength = hitDistance - radius / approach;
          if (centerLength <= wheel.maxLength + 0.045) {
            wheel.springLength = THREE.MathUtils.clamp(
              centerLength,
              wheel.minLength,
              wheel.maxLength,
            );
            wheel.wheelCenterL
              .copy(mount)
              .addScaledVector(down, wheel.springLength);
            // Nearest point on the exact rendered triangle plane. This is the
            // point where tire forces should act, rather than the radial/ray hit.
            wheel.contactPointL
              .copy(wheel.wheelCenterL)
              .addScaledVector(wheel.surfaceNormalL, -radius);
            wheel.contact = true;
            return true;
          }
        }
      }
    }

    // Fallback while a visible LOD patch is still being generated. Evaluate
    // clearance using the slope-corrected metric distance to the analytic
    // implicit terrain so the rover still has continuous support during LOD work.
    const clearanceAt = (distance) => {
      tmp.vehicleProbeL.copy(mount).addScaledVector(down, distance);
      return (
        sampleSurfaceVehicleTerrain(
          body,
          tmp.vehicleProbeL,
          tmp.vehicleNormalL,
        ) - radius
      );
    };

    let lo = wheel.minLength;
    let cLo = clearanceAt(lo);
    let hit = cLo <= 0.0;
    let hi = lo;

    if (!hit) {
      // Terrain is star-shaped but the suspension ray is not necessarily radial,
      // so scan the allowed stroke and take the FIRST contact. Six coarse slices
      // plus binary refinement is stable at the fixed 60 Hz step and avoids the
      // old false "no ground" result on sloped terrain.
      const samples = 8;
      const span = wheel.maxLength - wheel.minLength;
      for (let i = 1; i <= samples; i++) {
        hi = wheel.minLength + (span * i) / samples;
        const cHi = clearanceAt(hi);
        if (cHi <= 0.0) {
          hit = true;
          break;
        }
        lo = hi;
        cLo = cHi;
      }
    }

    if (!hit) {
      wheel.contact = false;
      wheel.normalLoad = 0.0;
      wheel.springLength = wheel.maxLength;
      wheel.wheelCenterL
        .copy(mount)
        .addScaledVector(down, wheel.springLength);
      return false;
    }

    if (hi <= lo) hi = lo;
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) * 0.5;
      if (clearanceAt(mid) > 0.0) lo = mid;
      else hi = mid;
    }

    wheel.springLength = THREE.MathUtils.clamp(
      hi,
      wheel.minLength,
      wheel.maxLength,
    );
    wheel.wheelCenterL
      .copy(mount)
      .addScaledVector(down, wheel.springLength);

    // Final sample returns both the true local terrain normal and a projected
    // point on the same analytic surface used by the rendered quadsphere.
    let finalDistance = sampleSurfaceVehicleTerrain(
      body,
      wheel.wheelCenterL,
      wheel.surfaceNormalL,
      wheel.contactPointL,
    );

    // One geometric correction makes the wheel sphere actually sit one radius
    // from that projected surface. The coarse/binary probe uses first-order
    // metric distance for speed; this final correction removes the remaining
    // slope error without turning every scan sample into an expensive projection.
    const approach = -down.dot(wheel.surfaceNormalL);
    if (approach > 0.12) {
      const correction = THREE.MathUtils.clamp(
        (finalDistance - radius) / approach,
        -0.30,
        0.30,
      );
      if (Math.abs(correction) > 1e-4) {
        wheel.springLength = THREE.MathUtils.clamp(
          wheel.springLength + correction,
          wheel.minLength,
          wheel.maxLength,
        );
        wheel.wheelCenterL
          .copy(mount)
          .addScaledVector(down, wheel.springLength);
        finalDistance = sampleSurfaceVehicleTerrain(
          body,
          wheel.wheelCenterL,
          wheel.surfaceNormalL,
          wheel.contactPointL,
        );
      }
    }

    wheel.contact = finalDistance <= radius + 0.035;
    if (!wheel.contact) {
      wheel.normalLoad = 0.0;
      return false;
    }
    return true;
  }

  function applySurfaceVehicleForce(forceL, pointL) {
    playerVehicle.forceL.add(forceL);
    tmp.vehicleLeverL.copy(pointL).sub(playerVehicle.positionL);
    tmp.vehicleTorqueTmpL.copy(tmp.vehicleLeverL).cross(forceL);
    playerVehicle.torqueL.add(tmp.vehicleTorqueTmpL);
  }

  function applySurfaceVehicleWaterForces(body, dt) {
    if (!body?.hasOcean || !playerVehicle.buoyancyProbes?.length) {
      playerVehicle.waterSubmersion = 0.0;
      playerVehicle.inWater = false;
      return 0.0;
    }

    // Six distributed float volumes give the rover pitch/roll response in water
    // without changing the rigid-body reference frame or suspension contacts.
    // The water surface is sampled from the same animated CPU wave function as
    // the ocean vertex shader, in host-body local coordinates.
    const probeCount = playerVehicle.buoyancyProbes.length;
    const fullProbeBuoyancy =
      (playerVehicle.mass * playerVehicle.gravity * 1.58) / probeCount;
    const buoyancyDepth = 1.34;
    const linearDrag = 2450.0;
    const normalDamping = 3300.0;
    let submersionSum = 0.0;

    for (const probe of playerVehicle.buoyancyProbes) {
      probe.pointL
        .copy(probe.offset)
        .applyQuaternion(playerVehicle.orientationL)
        .add(playerVehicle.positionL);

      const depth = sampleOceanDepthLocal(
        body,
        probe.pointL,
        tmp.waterUpLocal,
      );
      probe.depth = Number.isFinite(depth) ? depth : -Infinity;
      const submersion = Number.isFinite(depth)
        ? THREE.MathUtils.clamp((depth + 0.10) / buoyancyDepth, 0.0, 1.0)
        : 0.0;
      probe.submersion = submersion;
      if (submersion <= 0.0) continue;
      submersionSum += submersion;

      tmp.vehicleLeverL.copy(probe.pointL).sub(playerVehicle.positionL);
      tmp.waterPointVelocity
        .copy(playerVehicle.angularVelocityL)
        .cross(tmp.vehicleLeverL)
        .add(playerVehicle.linearVelocityL);

      const normalSpeed = tmp.waterPointVelocity.dot(tmp.waterUpLocal);
      const buoyancy = fullProbeBuoyancy * submersion;
      const damp = -normalSpeed * normalDamping * submersion;

      tmp.waterForce
        .copy(tmp.waterUpLocal)
        .multiplyScalar(buoyancy + damp)
        .addScaledVector(
          tmp.waterPointVelocity,
          -linearDrag * submersion,
        );
      applySurfaceVehicleForce(tmp.waterForce, probe.pointL);
    }

    const averageSubmersion = submersionSum / probeCount;
    playerVehicle.waterSubmersion = averageSubmersion;
    playerVehicle.inWater = averageSubmersion > 0.015;

    if (averageSubmersion > 0.0) {
      // Rotational drag is intentionally applied directly to angular velocity:
      // water rapidly damps the violent high-frequency spin that point drag can
      // otherwise leave after a splash, while still allowing the chassis to bob.
      playerVehicle.angularVelocityL.multiplyScalar(
        Math.exp(-2.15 * averageSubmersion * dt),
      );
    }
    return averageSubmersion;
  }

  function solveSurfaceVehicleChassisContacts(body) {
    const skin = 0.055;
    const contactK = 155000.0;
    const contactDamping = 26000.0;
    const maxContactForce = 190000.0;
    let count = 0;

    for (const contact of playerVehicle.chassisContacts) {
      contact.centerL
        .copy(contact.offset)
        .applyQuaternion(playerVehicle.orientationL)
        .add(playerVehicle.positionL);

      const signedClearance =
        sampleSurfaceVehicleTerrain(
          body,
          contact.centerL,
          contact.surfaceNormalL,
          contact.contactPointL,
        ) - contact.radius;
      const penetration = skin - signedClearance;
      if (penetration <= 0.0) {
        contact.touching = false;
        contact.penetration = 0.0;
        continue;
      }

      // surfaceNormalL/contactPointL now come from the same slope-aware metric
      // query used by suspension, so chassis and tires cannot disagree about
      // where a steep procedural surface actually is.

      tmp.vehicleLeverL
        .copy(contact.contactPointL)
        .sub(playerVehicle.positionL);
      tmp.vehiclePointVelL
        .copy(playerVehicle.angularVelocityL)
        .cross(tmp.vehicleLeverL)
        .add(playerVehicle.linearVelocityL);

      let normalSpeed = tmp.vehiclePointVelL.dot(contact.surfaceNormalL);
      const impactClosingSpeed = Math.max(0.0, -normalSpeed);

      // A velocity-level collision impulse prevents a fast bumper/belly hit
      // from tunnelling deeply before the softer penetration spring can react.
      // Effective mass includes the contact lever arm and diagonal chassis
      // inertia, so off-centre impacts create angular response naturally.
      if (normalSpeed < -0.35) {
        tmp.vehicleTorqueTmpL
          .copy(tmp.vehicleLeverL)
          .cross(contact.surfaceNormalL);
        tmp.vehicleInvOrientationL.copy(playerVehicle.orientationL).invert();
        tmp.vehicleTorqueBody
          .copy(tmp.vehicleTorqueTmpL)
          .applyQuaternion(tmp.vehicleInvOrientationL);
        tmp.vehicleAlphaBody.set(
          tmp.vehicleTorqueBody.x * playerVehicle.invInertia.x,
          tmp.vehicleTorqueBody.y * playerVehicle.invInertia.y,
          tmp.vehicleTorqueBody.z * playerVehicle.invInertia.z,
        );
        tmp.vehicleAlphaL
          .copy(tmp.vehicleAlphaBody)
          .applyQuaternion(playerVehicle.orientationL);
        const rotationalTerm = contact.surfaceNormalL.dot(
          tmp.vehicleForceTmpL
            .copy(tmp.vehicleAlphaL)
            .cross(tmp.vehicleLeverL),
        );
        const denom = Math.max(
          1e-7,
          playerVehicle.invMass + rotationalTerm,
        );
        const restitution = 0.06;
        const impulse = THREE.MathUtils.clamp(
          (-(1.0 + restitution) * normalSpeed) / denom,
          0.0,
          90000.0,
        );
        playerVehicle.linearVelocityL.addScaledVector(
          contact.surfaceNormalL,
          impulse * playerVehicle.invMass,
        );
        playerVehicle.angularVelocityL.addScaledVector(
          tmp.vehicleAlphaL,
          impulse,
        );

        // Re-evaluate the remaining closing speed after the impulse so the
        // penetration damper does not double-count the same impact energy.
        tmp.vehiclePointVelL
          .copy(playerVehicle.angularVelocityL)
          .cross(tmp.vehicleLeverL)
          .add(playerVehicle.linearVelocityL);
        normalSpeed = tmp.vehiclePointVelL.dot(contact.surfaceNormalL);

        const impact01 = THREE.MathUtils.smoothstep(
          impactClosingSpeed,
          2.5,
          18.0,
        );
        if (impact01 > 0.01) {
          playerVehicle.impactStrength = Math.max(
            playerVehicle.impactStrength,
            impact01,
          );
          playerVehicle.landingKick = Math.max(
            playerVehicle.landingKick,
            impact01 * 0.28,
          );
          emitSurfaceVehicleDust(
            contact.contactPointL,
            contact.surfaceNormalL,
            tmp.vehiclePointVelL,
            0.55 + impact01 * 0.95,
            2 + Math.ceil(impact01 * 7.0),
          );
        }
      }

      const dampingForce = Math.max(0.0, -normalSpeed) * contactDamping;
      const forceMagnitude = THREE.MathUtils.clamp(
        penetration * contactK + dampingForce,
        0.0,
        maxContactForce,
      );

      tmp.vehicleForceTmpL
        .copy(contact.surfaceNormalL)
        .multiplyScalar(forceMagnitude);
      applySurfaceVehicleForce(tmp.vehicleForceTmpL, contact.contactPointL);

      // Limited chassis scrape friction. Tires still own normal driving grip;
      // this only keeps a belly/bumper contact from sliding frictionlessly
      // across rock after a bottom-out or crash.
      const tangentialSpeedSq = tmp.vehiclePointVelL
        .addScaledVector(
          contact.surfaceNormalL,
          -tmp.vehiclePointVelL.dot(contact.surfaceNormalL),
        )
        .lengthSq();
      if (tangentialSpeedSq > 1e-6) {
        const tangentialSpeed = Math.sqrt(tangentialSpeedSq);
        const scrapeForce = Math.min(
          tangentialSpeed * 5200.0,
          forceMagnitude * 0.62,
        );
        tmp.vehicleForceTmpL
          .copy(tmp.vehiclePointVelL)
          .multiplyScalar(-scrapeForce / tangentialSpeed);
        applySurfaceVehicleForce(tmp.vehicleForceTmpL, contact.contactPointL);
      }

      contact.touching = true;
      contact.penetration = penetration;
      count++;
    }

    playerVehicle.chassisContactCount = count;
    return count;
  }

  function applySurfaceVehicleAntiRoll() {
    // Each consecutive L/R pair is one axle because createSurfaceRover builds
    // wheels in [left,right] order for front, middle, then rear. The anti-roll
    // bar transfers suspension force across an axle instead of directly
    // imposing an orientation on the chassis.
    const antiRollK = 18500.0;
    const maxAntiRollForce = 12500.0;
    tmp.vehiclePhysicsUpL
      .set(0, 1, 0)
      .applyQuaternion(playerVehicle.orientationL)
      .normalize();

    for (let i = 0; i + 1 < playerVehicle.suspension.length; i += 2) {
      const left = playerVehicle.suspension[i];
      const right = playerVehicle.suspension[i + 1];
      if (!left.contact || !right.contact) continue;

      const leftCompression = Math.max(0.0, left.restLength - left.springLength);
      const rightCompression = Math.max(
        0.0,
        right.restLength - right.springLength,
      );
      const transfer = THREE.MathUtils.clamp(
        (leftCompression - rightCompression) * antiRollK,
        -maxAntiRollForce,
        maxAntiRollForce,
      );
      if (Math.abs(transfer) < 1.0) continue;

      tmp.vehicleForceTmpL
        .copy(tmp.vehiclePhysicsUpL)
        .multiplyScalar(transfer);
      applySurfaceVehicleForce(tmp.vehicleForceTmpL, left.contactPointL);
      tmp.vehicleForceTmpL.multiplyScalar(-1.0);
      applySurfaceVehicleForce(tmp.vehicleForceTmpL, right.contactPointL);

      // Feed the transferred load into the next tire-force limit as well. This
      // is not a full tire model, but it keeps grip changes consistent with the
      // physical load transfer produced by the bar.
      left.normalLoad = Math.max(0.0, left.normalLoad + transfer);
      right.normalLoad = Math.max(0.0, right.normalLoad - transfer);
    }
  }

  function sampleSurfaceVehicleInput() {
    const gp = input.gamepad;
    let throttle = 0.0;
    let steer = 0.0;
    if (keys.has("KeyW")) throttle += 1.0;
    if (keys.has("KeyS")) throttle -= 1.0;
    if (keys.has("KeyA")) steer += 1.0;
    if (keys.has("KeyD")) steer -= 1.0;
    if (gp?.active) {
      throttle += THREE.MathUtils.clamp(-gp.ly, -1.0, 1.0);
      steer += THREE.MathUtils.clamp(-gp.lx, -1.0, 1.0);
    }
    playerVehicle.throttleInput = THREE.MathUtils.clamp(
      throttle,
      -1.0,
      1.0,
    );
    playerVehicle.steeringInput = THREE.MathUtils.clamp(steer, -1.0, 1.0);
    playerVehicle.boostInput =
      keys.has("ShiftLeft") ||
      keys.has("ShiftRight") ||
      (gp?.active && (gp.buttons?.ls || gp.buttons?.lb));

    const jumpDown = keys.has("Space") || (gp?.active && gp.buttons?.a);
    if (jumpDown && !playerVehicle.jumpWasDown) {
      playerVehicle.jumpRequested = true;
    }
    playerVehicle.jumpWasDown = jumpDown;
  }

  function updateSurfaceVehicleWheelVisuals() {
    for (let i = 0; i < playerVehicle.wheels.length; i++) {
      const wheelMesh = playerVehicle.wheels[i];
      const wheel = playerVehicle.suspension[i];
      const spin = wheel?.spinAngle ?? 0.0;
      wheelMesh.tire.rotation.x = spin;
      wheelMesh.hub.rotation.x = spin;
    }
  }

  function stepSurfaceVehiclePhysics(dt, parkingBrake = false) {
    const body = bodies[playerVehicle.bodyIndex];
    if (!body?.group || typeof body.sdf !== "function") return false;

    const positionLength = playerVehicle.positionL.length();
    if (positionLength < 1.0) return false;

    playerVehicle.forceL.set(0, 0, 0);
    playerVehicle.torqueL.set(0, 0, 0);

    // Constant gameplay gravity, solved in the stationary planet-local frame.
    tmp.vehicleRadialUpL
      .copy(playerVehicle.positionL)
      .multiplyScalar(1.0 / positionLength);
    playerVehicle.forceL.addScaledVector(
      tmp.vehicleRadialUpL,
      -playerVehicle.mass * playerVehicle.gravity,
    );
    // Capture the incoming radial speed before suspension/chassis impulses
    // modify velocity. This is used only for landing feedback/telemetry.
    const preContactDownSpeed = Math.max(
      0.0,
      -playerVehicle.linearVelocityL.dot(tmp.vehicleRadialUpL),
    );

    tmp.vehiclePhysicsUpL
      .set(0, 1, 0)
      .applyQuaternion(playerVehicle.orientationL)
      .normalize();
    tmp.vehiclePhysicsForwardL
      .set(0, 0, -1)
      .applyQuaternion(playerVehicle.orientationL)
      .normalize();

    applySurfaceVehicleWaterForces(body, dt);

    const forwardSpeed = playerVehicle.linearVelocityL.dot(
      tmp.vehiclePhysicsForwardL,
    );
    const maxForward = playerVehicle.boostInput ? 72.0 : 44.0;
    const maxReverse = 19.0;
    const throttle = parkingBrake ? 0.0 : playerVehicle.throttleInput;
    const steerInput = parkingBrake ? 0.0 : playerVehicle.steeringInput;

    // Speed-sensitive steering keeps the rover agile while crawling without
    // allowing a full-lock input at highway speed to create an instant spin.
    const steerSpeed01 = THREE.MathUtils.smoothstep(
      Math.abs(forwardSpeed),
      7.0,
      58.0,
    );
    const maxSteerAngle = THREE.MathUtils.lerp(0.48, 0.19, steerSpeed01);
    const targetSteerAngle = steerInput * maxSteerAngle;
    playerVehicle.steeringAngle = THREE.MathUtils.lerp(
      playerVehicle.steeringAngle,
      targetSteerAngle,
      1.0 - Math.exp(-10.5 * dt),
    );
    const frontSteer = playerVehicle.steeringAngle;

    let driveLimiter = 1.0;
    if (throttle > 0.0 && forwardSpeed > maxForward * 0.78) {
      driveLimiter = 1.0 - THREE.MathUtils.smoothstep(
        forwardSpeed,
        maxForward * 0.78,
        maxForward,
      );
    } else if (throttle < 0.0 && forwardSpeed < -maxReverse * 0.72) {
      driveLimiter = 1.0 - THREE.MathUtils.smoothstep(
        -forwardSpeed,
        maxReverse * 0.72,
        maxReverse,
      );
    }

    const springK = 50000.0;
    const springDamping = 8400.0;
    const maxSpringForce = 39000.0;
    const engineForcePerWheel = playerVehicle.boostInput ? 10200.0 : 7600.0;
    const wheelEquivalentMass = 82.0;
    const baseTireMu = parkingBrake ? 2.10 : 1.85;
    const longSlipPeak = 0.13;
    const lateralSlipPeak = 0.115;
    const nominalWheelLoad =
      (playerVehicle.mass * playerVehicle.gravity) /
      Math.max(1, playerVehicle.suspension.length);
    playerVehicle.skidStrength = 0.0;
    playerVehicle.peakSlip = 0.0;
    playerVehicle.impactStrength *= Math.exp(-5.5 * dt);
    let contacts = 0;

    // Pass 1: suspension contact + vertical spring/damper loads. Tire forces
    // are delayed until after the anti-roll bar transfers load across each axle.
    for (const wheel of playerVehicle.suspension) {
      wheel.steerAngle = wheel.z < -1.0 ? frontSteer : 0.0;
      if (!probeSurfaceVehicleSuspension(body, wheel)) {
        wheel.normalLoad = 0.0;
        wheel.longitudinalSpeed = 0.0;
        wheel.lateralSpeed = 0.0;
        wheel.slipRatio = 0.0;
        wheel.slipAngle = 0.0;
        wheel.slipAmount = 0.0;
        wheel.longitudinalForce = 0.0;
        wheel.lateralForce = 0.0;
        wheel.waterDepth = 0.0;
        wheel.waterSubmersion = 0.0;
        wheel.sprayAccumulator = Math.max(0.0, (wheel.sprayAccumulator ?? 0.0) - dt * 2.0);
        wheel.dustAccumulator = Math.max(0.0, wheel.dustAccumulator - dt * 2.0);
        wheel.skidMarkActive = false;
        continue;
      }
      contacts++;

      tmp.vehicleLeverL
        .copy(wheel.contactPointL)
        .sub(playerVehicle.positionL);
      tmp.vehiclePointVelL
        .copy(playerVehicle.angularVelocityL)
        .cross(tmp.vehicleLeverL)
        .add(playerVehicle.linearVelocityL);

      tmp.vehiclePhysicsDownL
        .set(0, -1, 0)
        .applyQuaternion(playerVehicle.orientationL)
        .normalize();
      const compression = wheel.restLength - wheel.springLength;
      const compressionRate = tmp.vehiclePointVelL.dot(
        tmp.vehiclePhysicsDownL,
      );
      const springForce = THREE.MathUtils.clamp(
        compression * springK + compressionRate * springDamping,
        0.0,
        maxSpringForce,
      );
      wheel.normalLoad = springForce;

      if (springForce > 0.0) {
        tmp.vehicleForceTmpL
          .copy(tmp.vehiclePhysicsDownL)
          .multiplyScalar(-springForce);
        applySurfaceVehicleForce(tmp.vehicleForceTmpL, wheel.contactPointL);
      }
    }

    applySurfaceVehicleAntiRoll();

    // Pass 2: tire forces from actual wheel slip. Wheel circumferential speed
    // is a physical state, so throttle/braking first change wheel speed and the
    // resulting longitudinal slip is what pushes the chassis. Lateral force is
    // driven by slip angle with a soft saturation/falloff rather than an abrupt
    // clamp, which makes breakaway and recovery progressive.
    for (const wheel of playerVehicle.suspension) {
      if (!wheel.contact) continue;

      tmp.vehicleLeverL
        .copy(wheel.contactPointL)
        .sub(playerVehicle.positionL);
      tmp.vehiclePointVelL
        .copy(playerVehicle.angularVelocityL)
        .cross(tmp.vehicleLeverL)
        .add(playerVehicle.linearVelocityL);

      tmp.vehicleSteerQ.setFromAxisAngle(
        tmp.vehicleUpL.set(0, 1, 0),
        wheel.steerAngle,
      );
      tmp.vehicleWheelForwardL
        .set(0, 0, -1)
        .applyQuaternion(tmp.vehicleSteerQ)
        .applyQuaternion(playerVehicle.orientationL);
      tmp.vehicleWheelForwardL.addScaledVector(
        wheel.surfaceNormalL,
        -tmp.vehicleWheelForwardL.dot(wheel.surfaceNormalL),
      );
      if (tmp.vehicleWheelForwardL.lengthSq() < 1e-8) continue;
      tmp.vehicleWheelForwardL.normalize();
      tmp.vehicleWheelRightL
        .copy(tmp.vehicleWheelForwardL)
        .cross(wheel.surfaceNormalL)
        .normalize();

      wheel.longitudinalSpeed = tmp.vehiclePointVelL.dot(
        tmp.vehicleWheelForwardL,
      );
      wheel.lateralSpeed = tmp.vehiclePointVelL.dot(tmp.vehicleWheelRightL);

      const longRefSpeed = Math.max(4.0, Math.abs(wheel.longitudinalSpeed));
      const slipSpeed = wheel.surfaceSpeed - wheel.longitudinalSpeed;
      wheel.slipRatio = slipSpeed / longRefSpeed;
      wheel.slipAngle = Math.atan2(
        wheel.lateralSpeed,
        Math.max(3.0, Math.abs(wheel.longitudinalSpeed)),
      );

      const normalizedLongSlip = Math.abs(wheel.slipRatio) / longSlipPeak;
      const normalizedLatSlip = Math.abs(wheel.slipAngle) / lateralSlipPeak;
      const combinedSlip = Math.hypot(normalizedLongSlip, normalizedLatSlip);

      const wheelWaterDepth = sampleOceanDepthLocal(
        body,
        wheel.contactPointL,
        tmp.waterUpLocal,
      );
      wheel.waterDepth = Number.isFinite(wheelWaterDepth)
        ? Math.max(0.0, wheelWaterDepth)
        : 0.0;
      wheel.waterSubmersion = Number.isFinite(wheelWaterDepth)
        ? THREE.MathUtils.clamp(
            (wheelWaterDepth + playerVehicle.wheelRadius * 0.12) /
              (playerVehicle.wheelRadius * 1.55),
            0.0,
            1.0,
          )
        : 0.0;
      const tireMu = baseTireMu * THREE.MathUtils.lerp(
        1.0,
        0.68,
        wheel.waterSubmersion,
      );

      // Once a tire is well beyond its peak slip, shed a modest amount of grip
      // instead of keeping an unrealistically flat friction plateau forever.
      const postPeakFade = 1.0 - 0.12 * THREE.MathUtils.smoothstep(
        combinedSlip,
        1.0,
        3.2,
      );
      const maxTireForce = Math.max(
        250.0,
        wheel.normalLoad * tireMu * postPeakFade,
      );

      let longitudinalForce =
        maxTireForce * Math.tanh(wheel.slipRatio / longSlipPeak);
      let lateralForce =
        -maxTireForce * Math.tanh(wheel.slipAngle / lateralSlipPeak);

      // Small rolling resistance remains a chassis force rather than fake drag
      // on the whole vehicle, so each loaded contact contributes independently.
      const rollingStiffness = parkingBrake ? 360.0 : 78.0;
      longitudinalForce += THREE.MathUtils.clamp(
        -wheel.longitudinalSpeed * rollingStiffness,
        -maxTireForce * 0.32,
        maxTireForce * 0.32,
      );

      // Combined-slip friction ellipse. Acceleration, braking and cornering all
      // compete for the same contact patch instead of being independently maxed.
      const tireForceMag = Math.hypot(longitudinalForce, lateralForce);
      if (tireForceMag > maxTireForce && tireForceMag > 1e-5) {
        const scale = maxTireForce / tireForceMag;
        longitudinalForce *= scale;
        lateralForce *= scale;
      }

      wheel.longitudinalForce = longitudinalForce;
      wheel.lateralForce = lateralForce;
      wheel.slipAmount = THREE.MathUtils.clamp(combinedSlip, 0.0, 4.0);
      playerVehicle.peakSlip = Math.max(
        playerVehicle.peakSlip,
        wheel.slipAmount,
      );

      tmp.vehicleForceTmpL
        .copy(tmp.vehicleWheelForwardL)
        .multiplyScalar(longitudinalForce)
        .addScaledVector(tmp.vehicleWheelRightL, lateralForce);
      applySurfaceVehicleForce(tmp.vehicleForceTmpL, wheel.contactPointL);

      // Drivetrain/wheel rotational state. surfaceSpeed is the tire tread speed
      // in the wheel-forward direction; tire force reacts back against it.
      let driveForceEquivalent =
        throttle * engineForcePerWheel * driveLimiter;
      if (parkingBrake) {
        driveForceEquivalent += THREE.MathUtils.clamp(
          -wheel.surfaceSpeed * 920.0,
          -22000.0,
          22000.0,
        );
      } else if (Math.abs(throttle) < 0.03) {
        driveForceEquivalent += THREE.MathUtils.clamp(
          -wheel.surfaceSpeed * 95.0,
          -3400.0,
          3400.0,
        );
      }
      wheel.surfaceSpeed +=
        ((driveForceEquivalent - longitudinalForce) / wheelEquivalentMass) * dt;
      wheel.surfaceSpeed = THREE.MathUtils.clamp(
        wheel.surfaceSpeed,
        -95.0,
        115.0,
      );
      if (wheel.waterSubmersion > 0.0) {
        wheel.surfaceSpeed *= Math.exp(-0.48 * wheel.waterSubmersion * dt);
      }

      const load01 = THREE.MathUtils.clamp(
        wheel.normalLoad / Math.max(1.0, nominalWheelLoad),
        0.0,
        1.8,
      );
      const speed01 = THREE.MathUtils.smoothstep(
        Math.abs(wheel.longitudinalSpeed),
        3.0,
        18.0,
      );
      const slipDust = THREE.MathUtils.smoothstep(
        wheel.slipAmount,
        0.32,
        1.18,
      );
      const dryFactor = 1.0 - wheel.waterSubmersion;
      const dustStrength = parkingBrake
        ? 0.0
        : THREE.MathUtils.clamp(
            speed01 * load01 * (0.10 + slipDust * 0.95) * dryFactor,
            0.0,
            1.25,
          );
      playerVehicle.skidStrength = Math.max(
        playerVehicle.skidStrength,
        slipDust * speed01 * Math.min(1.0, load01),
      );

      // Persistent tire marks come from the same physical slip/load state as
      // dust and camera feedback. Parking/idle damping never paints the ground.
      const skidMarkSpeed01 = THREE.MathUtils.smoothstep(
        Math.hypot(wheel.longitudinalSpeed, wheel.lateralSpeed),
        1.6,
        10.0,
      );
      const skidMarkSlip01 = THREE.MathUtils.smoothstep(
        wheel.slipAmount,
        0.55,
        1.45,
      );
      const skidMarkStrength = parkingBrake
        ? 0.0
        : THREE.MathUtils.clamp(
            skidMarkSlip01 *
              skidMarkSpeed01 *
              Math.min(1.2, load01) *
              dryFactor,
            0.0,
            1.2,
          );
      updateSurfaceVehicleWheelSkidMark(body, wheel, skidMarkStrength);

      if (dustStrength > 0.035) {
        wheel.dustAccumulator += dt * (2.2 + dustStrength * 18.0);
        while (wheel.dustAccumulator >= 1.0) {
          emitSurfaceVehicleDust(
            wheel.contactPointL,
            wheel.surfaceNormalL,
            tmp.vehiclePointVelL,
            dustStrength,
            1,
          );
          wheel.dustAccumulator -= 1.0;
        }
      } else {
        wheel.dustAccumulator = Math.max(
          0.0,
          wheel.dustAccumulator - dt * 1.5,
        );
      }
    }

    emitSurfaceVehicleWaterEffects(body, dt);

    // Chassis contacts are separate from suspension so bottoming out, cresting
    // a ridge, or striking a steep slope can physically push/rotate the rover.
    const chassisContacts = solveSurfaceVehicleChassisContacts(body);

    playerVehicle.contactCount = contacts;
    playerVehicle.onGround = contacts > 0 || chassisContacts > 0;

    // Landing response is derived from actual rigid-body contact transition,
    // not a scripted animation. A hard touchdown produces a short camera kick
    // while the suspension/chassis impulses remain responsible for the motion.
    playerVehicle.landingImpact *= Math.exp(-4.0 * dt);
    if (playerVehicle.onGround) {
      if (playerVehicle.airborneTime > 0.075 && preContactDownSpeed > 1.5) {
        const impact = THREE.MathUtils.clamp(
          (preContactDownSpeed - 1.5) / 17.0,
          0.0,
          1.0,
        );
        playerVehicle.landingImpact = Math.max(
          playerVehicle.landingImpact,
          impact,
        );
        playerVehicle.landingKick = Math.max(
          playerVehicle.landingKick,
          impact * 0.68,
        );
        playerVehicle.impactStrength = Math.max(
          playerVehicle.impactStrength,
          impact,
        );
        if (impact > 0.05) {
          for (const wheel of playerVehicle.suspension) {
            if (!wheel.contact) continue;
            tmp.vehicleLeverL
              .copy(wheel.contactPointL)
              .sub(playerVehicle.positionL);
            tmp.vehiclePointVelL
              .copy(playerVehicle.angularVelocityL)
              .cross(tmp.vehicleLeverL)
              .add(playerVehicle.linearVelocityL);
            emitSurfaceVehicleDust(
              wheel.contactPointL,
              wheel.surfaceNormalL,
              tmp.vehiclePointVelL,
              0.45 + impact * 0.9,
              1 + Math.ceil(impact * 2.0),
            );
          }
        }
      }
      playerVehicle.airborneTime = 0.0;
    } else {
      playerVehicle.airborneTime += dt;
    }

    // Airborne wheel dynamics continue to respond to drivetrain torque even
    // without a contact patch. Grounded wheel surfaceSpeed was already updated
    // by the tire reaction above. Visual spin is a direct readout of that state.
    for (const wheel of playerVehicle.suspension) {
      if (!wheel.contact) {
        let driveForceEquivalent =
          throttle * engineForcePerWheel * driveLimiter;
        if (parkingBrake) {
          driveForceEquivalent += THREE.MathUtils.clamp(
            -wheel.surfaceSpeed * 920.0,
            -22000.0,
            22000.0,
          );
        } else if (Math.abs(throttle) < 0.03) {
          driveForceEquivalent += THREE.MathUtils.clamp(
            -wheel.surfaceSpeed * 70.0,
            -2600.0,
            2600.0,
          );
        }
        wheel.surfaceSpeed +=
          (driveForceEquivalent / wheelEquivalentMass) * dt;
        wheel.surfaceSpeed *= Math.exp(-0.08 * dt);
        wheel.surfaceSpeed = THREE.MathUtils.clamp(
          wheel.surfaceSpeed,
          -95.0,
          115.0,
        );
      }

      wheel.angularSpeed =
        -wheel.surfaceSpeed / Math.max(0.1, playerVehicle.wheelRadius);
      wheel.spinAngle += wheel.angularSpeed * dt;
      if (Math.abs(wheel.spinAngle) > Math.PI * 2048.0) {
        wheel.spinAngle %= Math.PI * 2.0;
      }
    }

    if (
      !parkingBrake &&
      playerVehicle.jumpRequested &&
      contacts >= 2
    ) {
      // Real velocity impulse: once airborne, gravity and angular momentum own
      // the trajectory; there is no separate vertical-offset animation anymore.
      playerVehicle.linearVelocityL.addScaledVector(
        tmp.vehicleRadialUpL,
        9.4,
      );
      playerVehicle.jumpRequested = false;
    }

    // Mild aerodynamic/body drag keeps long coasts bounded without replacing
    // tire friction. It is intentionally much weaker than wheel forces.
    tmp.vehicleForceTmpL
      .copy(playerVehicle.linearVelocityL)
      .multiplyScalar(-125.0);
    playerVehicle.forceL.add(tmp.vehicleForceTmpL);

    playerVehicle.linearVelocityL.addScaledVector(
      playerVehicle.forceL,
      playerVehicle.invMass * dt,
    );

    // Torque is accumulated in planet-local coordinates. Apply diagonal inertia
    // in chassis-local coordinates, then rotate angular acceleration back.
    tmp.vehicleInvOrientationL.copy(playerVehicle.orientationL).invert();
    tmp.vehicleTorqueBody
      .copy(playerVehicle.torqueL)
      .applyQuaternion(tmp.vehicleInvOrientationL);
    tmp.vehicleAlphaBody.set(
      tmp.vehicleTorqueBody.x * playerVehicle.invInertia.x,
      tmp.vehicleTorqueBody.y * playerVehicle.invInertia.y,
      tmp.vehicleTorqueBody.z * playerVehicle.invInertia.z,
    );
    tmp.vehicleAlphaL
      .copy(tmp.vehicleAlphaBody)
      .applyQuaternion(playerVehicle.orientationL);
    playerVehicle.angularVelocityL.addScaledVector(tmp.vehicleAlphaL, dt);

    // Stable exponential damping at the fixed 60 Hz step.
    playerVehicle.linearVelocityL.multiplyScalar(Math.exp(-0.055 * dt));
    playerVehicle.angularVelocityL.multiplyScalar(Math.exp(-1.05 * dt));
    const angularSpeed = playerVehicle.angularVelocityL.length();
    if (angularSpeed > 5.5) {
      playerVehicle.angularVelocityL.multiplyScalar(5.5 / angularSpeed);
    }

    playerVehicle.positionL.addScaledVector(playerVehicle.linearVelocityL, dt);

    const omega = playerVehicle.angularVelocityL.length();
    if (omega > 1e-7) {
      tmp.vehicleDQ.setFromAxisAngle(
        tmp.vehicleAlphaL
          .copy(playerVehicle.angularVelocityL)
          .multiplyScalar(1.0 / omega),
        omega * dt,
      );
      // angularVelocityL is expressed in the planet-local/world side of the
      // rigid body, so the incremental rotation premultiplies orientationL.
      playerVehicle.orientationL
        .premultiply(tmp.vehicleDQ)
        .normalize();
    }

    // Emergency sanity clamps only; ordinary speed is controlled by tire force
    // and the engine limiter rather than direct kinematic clamping.
    const linearSpeed = playerVehicle.linearVelocityL.length();
    if (linearSpeed > 130.0) {
      playerVehicle.linearVelocityL.multiplyScalar(130.0 / linearSpeed);
    }

    deriveSurfaceVehicleLocalFrame();
    return true;
  }

  function runSurfaceVehicleFixedSteps(frameDt, parkingBrake = false) {
    const clampedFrameDt = THREE.MathUtils.clamp(frameDt, 0.0, 0.1);
    playerVehicle.physicsAccumulator += clampedFrameDt;
    let steps = 0;
    while (
      playerVehicle.physicsAccumulator >= playerVehicle.physicsDt &&
      steps < playerVehicle.maxSubsteps
    ) {
      if (!stepSurfaceVehiclePhysics(playerVehicle.physicsDt, parkingBrake)) {
        return false;
      }
      updateSurfaceVehicleDust(playerVehicle.physicsDt);
      playerVehicle.physicsAccumulator -= playerVehicle.physicsDt;
      steps++;
    }

    // Drop excessive backlog after a severe hitch instead of allowing a fixed-
    // step catch-up spiral. Normal 60 Hz operation executes exactly one step.
    if (
      steps >= playerVehicle.maxSubsteps &&
      playerVehicle.physicsAccumulator >= playerVehicle.physicsDt
    ) {
      playerVehicle.physicsAccumulator %= playerVehicle.physicsDt;
    }
    return true;
  }

  function constrainVehicleCameraToTerrain(body, upW = tmp.vehicleUpW) {
    if (!body?.group || !playerVehicle?.deployed) return;

    // Keep the rover's camera system completely independent. It computes and
    // lags playerVehicle.camPos first; this function only applies the exact same
    // terrain sweep used by fly mode to that already-chosen position.
    tmp.cameraCastStartW
      .copy(playerVehicle.root.position)
      .addScaledVector(upW, 1.6);
    constrainCameraPositionToTerrain(
      body,
      tmp.cameraCastStartW,
      playerVehicle.camPos,
      playerVehicle.cameraCollisionRadius,
      playerVehicle.cameraCollisionSkin,
    );
  }

  function updateSurfaceVehicleTurretAim(cameraForwardBodyL) {
    if (!playerVehicle?.turretYaw || !playerVehicle?.turretPitch) return;

    // cameraForwardBodyL lives in the host body's local frame. Convert it into
    // rover-chassis local space so the turret tracks only the free camera aim,
    // independent of planet motion and the rover's current rigid-body attitude.
    tmp.vehicleTurretAimL.copy(cameraForwardBodyL).normalize();
    tmp.vehicleInvOrientationL.copy(playerVehicle.orientationL).invert();
    tmp.vehicleTurretAimL
      .applyQuaternion(tmp.vehicleInvOrientationL)
      .normalize();

    const horizontal = Math.hypot(
      tmp.vehicleTurretAimL.x,
      tmp.vehicleTurretAimL.z,
    );

    // At exact straight-up/down views yaw is undefined, so preserve the last
    // yaw instead of snapping to an arbitrary heading.
    if (horizontal > 1e-5) {
      playerVehicle.turretYaw.rotation.y = Math.atan2(
        -tmp.vehicleTurretAimL.x,
        -tmp.vehicleTurretAimL.z,
      );
    }
    playerVehicle.turretPitch.rotation.x = Math.atan2(
      tmp.vehicleTurretAimL.y,
      Math.max(1e-7, horizontal),
    );
  }

  function updateSurfaceVehicleCamera(dt) {
    const b = bodies[playerVehicle.bodyIndex];
    if (!b?.group) return;

    // Remove host-body motion BEFORE applying chase lag. Rover physics lives in
    // the planet/moon's stationary local frame, so orbital translation and spin
    // are presentation transforms only and must not become apparent camera lag.
    // Use the current rover local point with both prev/curr body transforms to
    // isolate exactly the host-induced displacement, excluding rover motion.
    if (
      playerVehicle.camPos.lengthSq() > 1e-12 &&
      b.prevPos && b.currPos && b.prevQuat && b.currQuat
    ) {
      tmp.vC
        .copy(playerVehicle.positionL)
        .applyQuaternion(b.prevQuat)
        .add(b.prevPos);
      tmp.vD
        .copy(playerVehicle.positionL)
        .applyQuaternion(b.currQuat)
        .add(b.currPos);
      playerVehicle.camPos.add(tmp.vD.sub(tmp.vC));
    }

    // Keep the free-look heading inertial with respect to the host body's spin:
    // counter-rotate only the stored forward heading by the body's prev->curr
    // rotation. The camera UP axis is intentionally different: it is rebuilt
    // from the rover-to-body-center radial every frame so the horizon stays
    // naturally upright to the current planet/moon surface, as before.
    if (b.prevQuat && b.currQuat) {
      tmp.dq.copy(b.currQuat).multiply(tmp.qYaw.copy(b.prevQuat).invert());
      tmp.qPitch.copy(tmp.dq).invert();
      playerVehicle.camForwardL.applyQuaternion(tmp.qPitch).normalize();
    }

    playerVehicle.camUpL.copy(playerVehicle.positionL);
    if (playerVehicle.camUpL.lengthSq() < 1e-10) {
      playerVehicle.camUpL.set(0, 1, 0);
    } else {
      playerVehicle.camUpL.normalize();
    }

    // Preserve the current free-look yaw as much as possible while adapting to
    // the changing radial horizon. This removes only the component that points
    // into/out of the planet; steering/chassis orientation still cannot recenter
    // the camera.
    playerVehicle.camForwardL.addScaledVector(
      playerVehicle.camUpL,
      -playerVehicle.camForwardL.dot(playerVehicle.camUpL),
    );
    if (playerVehicle.camForwardL.lengthSq() < 1e-8) {
      tmp.refAxis.set(0, 1, 0);
      if (Math.abs(playerVehicle.camUpL.dot(tmp.refAxis)) > 0.92) {
        tmp.refAxis.set(1, 0, 0);
      }
      playerVehicle.camForwardL
        .copy(tmp.refAxis)
        .cross(playerVehicle.camUpL)
        .normalize();
    } else {
      playerVehicle.camForwardL.normalize();
    }

    // Free yaw remains driven only by explicit look input. Planet/moon motion
    // cannot create chase lag or yaw, but radial up follows the body center.
    const gp = input.gamepad;
    if (input.pointerLocked || gp?.active) {
      const { dx, dy } = input.consumeMouseDelta();
      const sens = 0.0022;
      playerVehicle.camForwardL
        .applyAxisAngle(playerVehicle.camUpL, -dx * sens)
        .normalize();
      // Rover vertical look is intentionally inverted: mouse/stick down raises
      // the orbit camera, mouse/stick up lowers it.
      playerVehicle.camPitch = THREE.MathUtils.clamp(
        playerVehicle.camPitch + dy * sens,
        -Math.PI * 0.5,
        Math.PI * 0.5,
      );
    }

    b.group.getWorldQuaternion(tmp.vehicleBodyWorldQuat);
    tmp.vA
      .copy(playerVehicle.camForwardL)
      .applyQuaternion(tmp.vehicleBodyWorldQuat)
      .normalize();
    tmp.vE
      .copy(playerVehicle.camUpL)
      .applyQuaternion(tmp.vehicleBodyWorldQuat)
      .normalize();

    const cp = Math.cos(playerVehicle.camPitch);
    const sp = Math.sin(playerVehicle.camPitch);

    // Camera position orbits around the rover, but camera ORIENTATION is no
    // longer derived with lookAt(). These two orthonormal vectors are the
    // complete free-look frame and depend only on stored look input.
    tmp.lookForwardW
      .copy(tmp.vA)
      .multiplyScalar(cp)
      .addScaledVector(tmp.vE, -sp)
      .normalize();

    // Build the exact same aim direction in host-body local space and feed it
    // to the turret. This keeps turret tracking perfectly aligned with the
    // camera even though the camera itself is fully independent of the rover.
    tmp.vehicleTurretAimL
      .copy(playerVehicle.camForwardL)
      .multiplyScalar(cp)
      .addScaledVector(playerVehicle.camUpL, -sp)
      .normalize();
    updateSurfaceVehicleTurretAim(tmp.vehicleTurretAimL);

    tmp.camUpW
      .copy(tmp.vA)
      .multiplyScalar(sp)
      .addScaledVector(tmp.vE, cp)
      .normalize();

    // Position stays opposite the free-look direction so the normal view still
    // starts as a useful third-person orbit. Terrain correction and positional
    // chase lag are allowed to move the camera, but they never rotate it.
    tmp.vB.copy(tmp.lookForwardW).negate();

    playerVehicle.landingKick *= Math.exp(-8.5 * Math.max(0.0, dt));
    playerVehicle.feedbackTime += Math.max(0.0, dt);
    const desired = tmp.vC
      .copy(playerVehicle.root.position)
      .addScaledVector(
        tmp.vE,
        playerVehicle.camUp - playerVehicle.landingKick,
      )
      .addScaledVector(tmp.vB, playerVehicle.camDist);

    // Feedback is driven by the physics state, not scripted key presses: hard
    // chassis hits give a short jolt and sustained high tire slip adds a very
    // small lateral vibration that makes a slide readable without destabilising
    // the chase camera.
    const impactShake = playerVehicle.impactStrength * 0.18;
    const skidShake = playerVehicle.skidStrength * 0.045;
    if (impactShake + skidShake > 0.001) {
      const t = playerVehicle.feedbackTime;
      tmp.vD.copy(tmp.vA).cross(tmp.vE).normalize();
      desired
        .addScaledVector(
          tmp.vD,
          Math.sin(t * 53.0) * (impactShake + skidShake),
        )
        .addScaledVector(
          tmp.vE,
          Math.sin(t * 71.0 + 1.3) * (impactShake * 0.55 + skidShake * 0.22),
        );
    }
    if (playerVehicle.camPos.lengthSq() === 0.0) {
      playerVehicle.camPos.copy(desired);
    } else {
      const k = 1.0 - Math.exp(-playerVehicle.camLag * Math.max(0.0, dt));
      playerVehicle.camPos.lerp(desired, k);
    }

    // Match fly mode: collision is applied to the camera's ACTUAL lagged
    // position, not to the ideal target before chase smoothing. This prevents
    // the lag accumulator itself from carrying the camera through terrain.
    constrainVehicleCameraToTerrain(b, tmp.vE);
    camera.position.copy(playerVehicle.camPos);

    // True free camera rotation: do NOT call camera.lookAt(). Chassis motion,
    // steering, planet curvature, chase lag and terrain camera collision can
    // move the camera but are never allowed to rewrite its orientation.
    tmp.vD.set(0, 0, 0);
    tmp.mLook.lookAt(tmp.vD, tmp.lookForwardW, tmp.camUpW);
    camera.quaternion.setFromRotationMatrix(tmp.mLook);
    camera.up.copy(tmp.camUpW);
    camera.updateMatrixWorld(true);
    updateSurfaceVehicleCameraFade();
  }

  function despawnSurfaceVehicle() {
    setSurfaceVehicleFadeFactor(1.0);
    playerVehicle.deployed = false;
    clearSurfaceVehicleDust();
    clearSurfaceVehicleSkidMarks();
    playerVehicle.root.visible = false;
    playerVehicle.linearVelocityL.set(0, 0, 0);
    playerVehicle.angularVelocityL.set(0, 0, 0);
    playerVehicle.forceL.set(0, 0, 0);
    playerVehicle.torqueL.set(0, 0, 0);
    playerVehicle.physicsAccumulator = 0.0;
    playerVehicle.speed = 0.0;
    playerVehicle.onGround = true;
    playerVehicle.contactCount = 0;
    playerVehicle.waterSubmersion = 0.0;
    playerVehicle.inWater = false;
    playerVehicle.jumpRequested = false;
    playerVehicle.jumpWasDown = false;
    playerVehicle.camPos.set(0, 0, 0);
    resetSurfaceVehicleSuspensionVisuals();
  }

  function enterSurfaceVehicle() {
    if (player.mode !== "walk") {
      msg.textContent =
        player.mode === "drive"
          ? "Already driving."
          : "Land before deploying the surface rover.";
      return false;
    }

    const b = bodies[player.bodyIndex];
    if (!b?.group || b?.canLand === false || b?.collidable === false) {
      msg.textContent = "The rover can only be deployed on a solid surface.";
      return false;
    }

    playerVehicle.deployed = true;
    playerVehicle.bodyIndex = player.bodyIndex;
    clearSurfaceVehicleDust();
    attachSurfaceVehicleDustToBody(b);
    playerVehicle.dirLocal.copy(player.dirLocal).normalize();
    playerVehicle.yaw = yaw;

    // Spawn the chassis in the host body's local frame. A small root clearance
    // preloads the suspension once gravity starts acting at 60 Hz.
    const surfaceR = b.radiusAtDir(
      playerVehicle.dirLocal.x,
      playerVehicle.dirLocal.y,
      playerVehicle.dirLocal.z,
    );
    const playerCurrentRadius =
      surfaceR + player.height + Math.max(0.0, player.radialOffset);
    const roverSpawnRadius = player.swimming
      ? Math.max(surfaceR + 0.28, playerCurrentRadius - 0.75)
      : surfaceR + 0.28;
    playerVehicle.positionL
      .copy(playerVehicle.dirLocal)
      .multiplyScalar(roverSpawnRadius);
    buildSurfaceVehicleOrientation(
      playerVehicle.dirLocal,
      playerVehicle.yaw,
      playerVehicle.orientationL,
    );
    playerVehicle.linearVelocityL.set(0, 0, 0);
    playerVehicle.angularVelocityL.set(0, 0, 0);
    playerVehicle.forceL.set(0, 0, 0);
    playerVehicle.torqueL.set(0, 0, 0);
    playerVehicle.physicsAccumulator = 0.0;
    playerVehicle.steeringInput = 0.0;
    playerVehicle.throttleInput = 0.0;
    playerVehicle.boostInput = false;
    playerVehicle.jumpRequested = false;
    playerVehicle.jumpWasDown = false;
    playerVehicle.camUpL.copy(playerVehicle.dirLocal).normalize();
    playerVehicle.camForwardL
      .set(0, 0, -1)
      .applyQuaternion(playerVehicle.orientationL)
      .addScaledVector(
        playerVehicle.camUpL,
        -playerVehicle.camForwardL.dot(playerVehicle.camUpL),
      );
    if (playerVehicle.camForwardL.lengthSq() < 1e-8) {
      tmp.refAxis.set(0, 1, 0);
      if (Math.abs(playerVehicle.camUpL.dot(tmp.refAxis)) > 0.92) {
        tmp.refAxis.set(1, 0, 0);
      }
      playerVehicle.camForwardL
        .copy(tmp.refAxis)
        .cross(playerVehicle.camUpL)
        .normalize();
    } else {
      playerVehicle.camForwardL.normalize();
    }
    playerVehicle.camPitch = THREE.MathUtils.degToRad(13);
    playerVehicle.camPos.set(0, 0, 0);
    setSurfaceVehicleFadeFactor(1.0);
    resetSurfaceVehicleSuspensionVisuals();

    player.mode = "drive";
    player.followIndex = -1;
    player.worldVel.set(0, 0, 0);
    player.radialOffset = 0.0;
    player.radialVel = 0.0;
    syncPlayerShipVisibility();
    syncSurfaceVehicleTransform();
    updateSurfaceVehicleCamera(0.0);
    input.resetMouse?.();
    msg.textContent =
      "Surface rover physics online (60 Hz). WASD drive, Shift boost, Space jump jets, V exit.";
    return true;
  }

  function exitSurfaceVehicle() {
    if (player.mode !== "drive" || !playerVehicle.deployed) return false;
    const b = bodies[playerVehicle.bodyIndex];
    if (!b?.group) {
      despawnSurfaceVehicle();
      player.mode = "walk";
      return false;
    }

    deriveSurfaceVehicleLocalFrame();
    const upL = tmp.vehicleRadialUpL;
    const surfaceR = Math.max(
      1.0,
      b.radiusAtDir(upL.x, upL.y, upL.z),
    );
    tmp.vehicleRightL
      .set(1, 0, 0)
      .applyQuaternion(playerVehicle.orientationL)
      .addScaledVector(
        upL,
        -tmp.vehicleRightL.dot(upL),
      );
    if (tmp.vehicleRightL.lengthSq() < 1e-8) {
      tmp.vehicleRightL.copy(tmp.eastL);
    } else {
      tmp.vehicleRightL.normalize();
    }
    tmp.axisL.copy(upL).cross(tmp.vehicleRightL).normalize();
    tmp.vehicleExitDirL
      .copy(upL)
      .applyQuaternion(
        tmp.qYaw.setFromAxisAngle(tmp.axisL, 3.4 / surfaceR),
      )
      .normalize();

    player.mode = "walk";
    player.bodyIndex = playerVehicle.bodyIndex;
    player.dirLocal.copy(tmp.vehicleExitDirL);
    if (playerVehicle.inWater) {
      const exitSurfaceR = Math.max(
        1.0,
        b.radiusAtDir(
          player.dirLocal.x,
          player.dirLocal.y,
          player.dirLocal.z,
        ),
      );
      const desiredPlayerRadius = Math.max(
        exitSurfaceR + player.height,
        playerVehicle.positionL.length() + 0.35,
      );
      player.radialOffset = Math.max(
        0.0,
        desiredPlayerRadius - exitSurfaceR - player.height,
      );
      player.onGround = false;
    } else {
      player.radialOffset = 0.0;
      player.onGround = true;
    }
    player.radialVel = 0.0;
    player.worldVel.set(0, 0, 0);
    player.followIndex = -1;
    yaw = playerVehicle.yaw;
    pitch = 0.0;

    // Parking brake: remove residual rigid-body motion but keep the exact local
    // pose. The rover will continue to be simulated while parked, with strong
    // tire damping, so it can settle without inheriting planet motion.
    playerVehicle.linearVelocityL.set(0, 0, 0);
    playerVehicle.angularVelocityL.set(0, 0, 0);
    playerVehicle.physicsAccumulator = 0.0;
    playerVehicle.throttleInput = 0.0;
    playerVehicle.steeringInput = 0.0;
    playerVehicle.boostInput = false;
    playerVehicle.jumpRequested = false;
    playerVehicle.jumpWasDown = false;
    playerVehicle.camPos.set(0, 0, 0);
    setSurfaceVehicleFadeFactor(1.0);
    input.resetMouse?.();
    syncSurfaceVehicleTransform();
    syncPlayerShipVisibility();
    msg.textContent = "Rover parked. Press V to deploy/enter again.";
    return true;
  }

  function toggleSurfaceVehicle() {
    if (isGalaxyOpen() || warpCtrl?.isMovementLocked?.()) return;
    if (player.mode === "drive") exitSurfaceVehicle();
    else enterSurfaceVehicle();
  }

  function updateSurfaceVehicleAnchor(dt = 0.0) {
    if (!playerVehicle.deployed) return;
    // A parked rover still runs the SAME local-frame 60 Hz rigid-body solver,
    // just with a strong parking brake. This lets suspension settle while the
    // planet orbits/spins underneath the render transform without injecting
    // celestial movement into physics.
    if (player.mode !== "drive") {
      setSurfaceVehicleFadeFactor(1.0);
      runSurfaceVehicleFixedSteps(dt, true);
      updateSurfaceVehicleWheelVisuals(dt);
    }
    syncSurfaceVehicleTransform();
  }

  function updateDrive(dt) {
    if (!playerVehicle.deployed) {
      player.mode = "walk";
      updateSurfaceWaterFx(dt);
      return;
    }

    sampleSurfaceVehicleInput();
    if (!runSurfaceVehicleFixedSteps(dt, false)) {
      despawnSurfaceVehicle();
      player.mode = "walk";
      updateSurfaceWaterFx(dt);
      return;
    }

    syncSurfaceVehicleTransform();
    updateSurfaceVehicleWheelVisuals(dt);
    updateSurfaceVehicleCamera(dt);
    updateSurfaceWaterFx(dt);
    syncPlayerShipVisibility();
  }

  function flyCollideNearestBody() {
    const near = nearestBodyInfo(player.worldPos);
    if (near.i < 0) return;
    const b = bodies[near.i];
    if (b?.collidable === false) return;

    const centerW = b.group.getWorldPosition(tmp.vA.set(0, 0, 0));
    const toP = tmp.vB.copy(player.worldPos).sub(centerW);
    const dist = toP.length();
    if (dist < 1e-6) return;

    const dirW = toP.multiplyScalar(1 / dist);
    b.group.getWorldQuaternion(tmp.worldQuat);

    const invQ = b._tmpQ.copy(tmp.worldQuat).invert();
    const dirL = tmp.vC.copy(dirW).applyQuaternion(invQ).normalize();

    const surfaceR = b.radiusAtDir(dirL.x, dirL.y, dirL.z);
    const playerRadius = player.height * 0.6;
    const margin = 0.15;
    const minDist = surfaceR + playerRadius + margin;

    if (dist < minDist) {
      player.worldPos.addScaledVector(dirW, minDist - dist);
      const vn = player.worldVel.dot(dirW);
      if (vn < 0) player.worldVel.addScaledVector(dirW, -vn);
    }
  }

  // One reusable hit record shared by the main belt and all planetary rings.
  // Each belt only overwrites it when it finds an earlier swept-sphere hit.
  const asteroidHit = {
    t: 1.000001,
    penetration: 0.0,
    startedInside: false,
    normal: new THREE.Vector3(),
    belt: null,
    segmentIndex: -1,
    instanceIndex: -1,
  };

  function findNearestAsteroidHit(startW, endW, radius) {
    asteroidHit.t = 1.000001;
    asteroidHit.penetration = 0.0;
    asteroidHit.startedInside = false;
    asteroidHit.belt = null;
    asteroidHit.segmentIndex = -1;
    asteroidHit.instanceIndex = -1;

    world.asteroidBelt?.sweepSphere?.(startW, endW, radius, asteroidHit);

    const rings = world.planetRings;
    if (rings?.length) {
      for (let i = 0; i < rings.length; i++) {
        rings[i]?.sweepSphere?.(startW, endW, radius, asteroidHit);
      }
    }

    return asteroidHit.t <= 1.0;
  }

  function flyCollideAsteroids(startWorldPos) {
    const shipRadius = Math.max(
      player.height * 0.6,
      Number(playerShip.collisionRadius) || 3.0,
    );
    const skin = 0.08;
    const restitution = 0.12;

    const motionStart = tmp.collisionMotionStartW.copy(startWorldPos);
    const motionEnd = tmp.collisionMotionEndW.copy(player.worldPos);

    // Two contacts are enough to handle corners between adjacent proxy spheres
    // without turning collision into an iterative physics solver.
    for (let contactIndex = 0; contactIndex < 2; contactIndex++) {
      if (!findNearestAsteroidHit(motionStart, motionEnd, shipRadius)) break;

      const hitT = THREE.MathUtils.clamp(asteroidHit.t, 0.0, 1.0);
      const delta = tmp.collisionDeltaW.subVectors(motionEnd, motionStart);
      const contact = tmp.collisionContactW
        .copy(motionStart)
        .addScaledVector(delta, hitT);

      // Starting overlaps can happen after a quality rebuild or a moving
      // planetary ring. Push out by the measured penetration; ordinary sweep
      // hits only need a tiny skin to avoid immediately re-hitting the sphere.
      const pushDistance =
        (asteroidHit.startedInside ? asteroidHit.penetration : 0.0) + skin;
      contact.addScaledVector(asteroidHit.normal, pushDistance);

      const remaining = tmp.collisionRemainingW
        .copy(delta)
        .multiplyScalar(1.0 - hitT);
      const remainingIntoSurface = remaining.dot(asteroidHit.normal);
      if (remainingIntoSurface < 0.0) {
        remaining.addScaledVector(
          asteroidHit.normal,
          -remainingIntoSurface,
        );
      }

      // Remove inward velocity and retain a small, readable impact bounce.
      const normalSpeed = player.worldVel.dot(asteroidHit.normal);
      if (normalSpeed < 0.0) {
        player.worldVel.addScaledVector(
          asteroidHit.normal,
          -(1.0 + restitution) * normalSpeed,
        );
      }

      motionStart.copy(contact);
      motionEnd.copy(contact).add(remaining);
    }

    player.worldPos.copy(motionEnd);
  }

  function applyFlyFollow(nearIdx) {
    if (nearIdx < 0) {
      player.followIndex = -1;
      return;
    }
    const b = bodies[nearIdx];
    const followDist = (b.cfg.baseRadius ?? 1500) * 8.0 + 900.0;
    const releaseDist = followDist * 1.45;
    const dToCenter = player.worldPos.distanceTo(b.currPos);

    if (player.followIndex === -1) {
      if (dToCenter < followDist) player.followIndex = nearIdx;
      else return;
    } else {
      if (player.followIndex !== nearIdx) {
        if (dToCenter < followDist * 0.65) player.followIndex = nearIdx;
      }
      const fb = bodies[player.followIndex];
      const dRel = player.worldPos.distanceTo(fb.currPos);
      if (dRel > releaseDist) {
        player.followIndex = -1;
        return;
      }
    }

    const fb = bodies[player.followIndex];
    tmp.dq.copy(fb.currQuat).multiply(tmp.qYaw.copy(fb.prevQuat).invert());

    // Save the pre-follow craft position so we can isolate the displacement
    // caused ONLY by the host body's orbit/spin. The chase accumulator receives
    // that displacement immediately instead of feeding it through chase lag.
    // Importantly, we do NOT rotate the camera offset itself: planet rotation
    // moves the craft's world position, but must not swing the chase view.
    tmp.vB.copy(player.worldPos);

    tmp.vA.copy(player.worldPos).sub(fb.prevPos);
    tmp.vA.applyQuaternion(tmp.dq);
    player.worldPos.copy(fb.currPos).add(tmp.vA);

    if (playerShip.camPos.lengthSq() > 1e-12) {
      tmp.vC.copy(player.worldPos).sub(tmp.vB);
      playerShip.camPos.add(tmp.vC);
    }

    player.worldVel.applyQuaternion(tmp.dq);
  }

  function respawn() {
    despawnSurfaceVehicle();
    clearSurfaceWaterFx();
    landing.active = false;
    player.landing = false;
    setLandingSequenceVisible(false);
    player.mode = "walk";
    player.followIndex = -1;
    player.bodyIndex = 0;
    player.dirLocal.set(0, 1, 0);
    player.radialVel = 0;
    player.radialOffset = 0;
    player.onGround = true;
    player.worldVel.set(0, 0, 0);
    yaw = 0;
    pitch = 0;
    msg.textContent = "Respawned. Click to lock pointer.";
    flyQuat.identity();
    roll = 0;
    rollVel = 0;
    autoBank = 0.0;
  }

  function toggleNoclip() {
    if (player.mode === "drive") exitSurfaceVehicle();
    player.noclip = !player.noclip;
    if (landing.active) {
      landing.active = false;
      player.landing = false;
      setLandingSequenceVisible(false);
    }

    if (player.noclip && player.mode !== "fly") {
      player.mode = "fly";
      player.followIndex = -1;
      player.worldVel.set(0, 0, 0);
      player.worldPos.copy(camera.position);
      flyQuat.copy(camera.quaternion);
      roll = 0;
      rollVel = 0;
      autoBank = 0.0;
    }

    msg.textContent = player.noclip
      ? "NOCLIP: ON (KeyI to toggle)"
      : "NOCLIP: OFF (KeyI to toggle)";
  }

  function doTakeoff() {
    if (player.mode !== "walk") return;
    const b = bodies[player.bodyIndex];
    b.group.updateMatrixWorld(true);

    const surfaceR = b.radiusAtDir(
      player.dirLocal.x,
      player.dirLocal.y,
      player.dirLocal.z,
    );
    const r = surfaceR + player.height + player.radialOffset;
    tmp.playerPosL.copy(player.dirLocal).multiplyScalar(r);
    pushOutOfTerrainWalk(b, tmp.playerPosL, player.dirLocal, 1.2);

    player.worldPos.copy(tmp.playerPosL).applyMatrix4(b.group.matrixWorld);
    player.worldVel.set(0, 0, 0);
    player.mode = "fly";
    flyQuat.copy(camera.quaternion);
    roll = 0;
    rollVel = 0;
    autoBank = 0.0;

    player.followIndex = -1;
    msg.textContent = "Takeoff! (Press L to land nearest.)";
  }

  function doLand() {
    if (player.mode !== "fly" || landing.active) return;
    const near = nearestBodyInfo(player.worldPos);
    if (near.i < 0) return;
    const b = bodies[near.i];

    if (b?.canLand === false || b?.collidable === false) {
      msg.textContent = `Can't land on ${b.cfg?.name ?? "that body"}.`;
      return;
    }

    const bodyPos = b.group.getWorldPosition(tmp.vA.set(0, 0, 0));
    const toPlayer = tmp.vB.copy(player.worldPos).sub(bodyPos);
    const dist = toPlayer.length();
    if (dist < 1e-6) return;
    const dirW = toPlayer.multiplyScalar(1.0 / dist);

    b.group.getWorldQuaternion(tmp.worldQuat);
    const invQ = tmp.cameraCastInvQ.copy(tmp.worldQuat).invert();
    const dirL = tmp.vC.copy(dirW).applyQuaternion(invQ).normalize();

    const surfaceR = b.radiusAtDir(dirL.x, dirL.y, dirL.z);
    tmp.waterSampleLocal.copy(dirL).multiplyScalar(Math.max(1.0, surfaceR));
    const oceanR = oceanSurfaceRadiusAtLocal(b, tmp.waterSampleLocal);
    if (Number.isFinite(oceanR) && oceanR - surfaceR > 0.65) {
      msg.textContent = `Water is too deep for landing gear on ${b.cfg?.name ?? "this body"}. Descend manually to float or submerge.`;
      return;
    }
    const targetRadius = surfaceR + player.height;
    const maxLand = targetRadius + 120.0;
    if (dist > maxLand) {
      msg.textContent = `Too far to land. Get closer to ${b.cfg.name ?? "planet"}.`;
      return;
    }

    // Preserve the current heading, but project it onto the local terrain
    // tangent so the ship visibly levels itself during the descent.
    const forwardW = tmp.lookForwardW
      .set(0, 0, -1)
      .applyQuaternion(flyQuat)
      .normalize();
    const forwardL = tmp.forwardMoveL.copy(forwardW).applyQuaternion(invQ);
    forwardL.addScaledVector(dirL, -forwardL.dot(dirL));

    if (forwardL.lengthSq() < 1e-8) {
      tmp.refAxis.set(0, 1, 0);
      if (Math.abs(dirL.dot(tmp.refAxis)) > 0.92) tmp.refAxis.set(1, 0, 0);
      tmp.eastL.copy(tmp.refAxis).cross(dirL).normalize();
      forwardL.copy(dirL).cross(tmp.eastL).normalize();
    } else {
      forwardL.normalize();
    }

    // Build a local orientation whose -Z axis points along the tangent heading
    // and whose +Y axis follows the terrain normal.
    tmp.mLook.lookAt(
      tmp.vD.set(0, 0, 0),
      tmp.vE.copy(forwardL),
      dirL,
    );
    landing.targetLocalQuat.setFromRotationMatrix(tmp.mLook).normalize();

    // Compute the equivalent walking yaw so the first walking frame exactly
    // matches the final landing heading instead of snapping to an old yaw.
    tmp.refAxis.set(0, 1, 0);
    if (Math.abs(dirL.dot(tmp.refAxis)) > 0.92) tmp.refAxis.set(1, 0, 0);
    tmp.eastL.copy(tmp.refAxis).cross(dirL).normalize();
    tmp.northL.copy(dirL).cross(tmp.eastL).normalize();
    landing.walkYaw = -Math.atan2(
      forwardL.dot(tmp.eastL),
      forwardL.dot(tmp.northL),
    );

    landing.active = true;
    player.landing = true;
    setLandingSequenceVisible(true);
    landing.bodyIndex = near.i;
    landing.elapsed = 0.0;
    landing.startRadius = dist;
    landing.targetRadius = targetRadius;
    landing.duration = THREE.MathUtils.clamp(
      1.25 + Math.max(0.0, dist - targetRadius) * 0.008,
      1.25,
      2.2,
    );
    landing.dirLocal.copy(dirL);
    landing.startQuat.copy(flyQuat);
    landing.cameraHandoffCaptured = false;

    player.followIndex = -1;
    player.worldVel.set(0, 0, 0);
    roll = 0;
    rollVel = 0;
    autoBank = 0.0;
    input.resetMouse?.();
    msg.textContent = `Landing on ${b.cfg?.name ?? "planet"}…`;
  }

  function updateLanding(dt) {
    if (!landing.active) return false;
    const b = bodies[landing.bodyIndex];
    if (!b || b?.canLand === false || b?.collidable === false) {
      landing.active = false;
      player.landing = false;
      setLandingSequenceVisible(false);
      msg.textContent = "Landing aborted.";
      return false;
    }

    landing.elapsed += Math.max(0.0, dt);
    const t = THREE.MathUtils.clamp(
      landing.elapsed / Math.max(0.001, landing.duration),
      0.0,
      1.0,
    );
    // Quintic smootherstep gives a controlled approach and a soft touchdown.
    const settle = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);

    b.group.updateMatrixWorld(true);
    b.group.getWorldQuaternion(tmp.worldQuat);

    const radius = THREE.MathUtils.lerp(
      landing.startRadius,
      landing.targetRadius,
      settle,
    );
    tmp.playerPosL.copy(landing.dirLocal).multiplyScalar(radius);
    player.worldPos.copy(tmp.playerPosL).applyMatrix4(b.group.matrixWorld);
    player.worldVel.set(0, 0, 0);

    // Level the ship progressively to the local terrain tangent while the body
    // itself continues rotating/orbiting under the landing sequence.
    tmp.qLook.copy(tmp.worldQuat).multiply(landing.targetLocalQuat).normalize();
    const orientT = THREE.MathUtils.clamp(t / 0.82, 0.0, 1.0);
    const orientEase = orientT * orientT * (3.0 - 2.0 * orientT);
    flyQuat.copy(landing.startQuat).slerp(tmp.qLook, orientEase).normalize();

    syncPlayerShipVisibility();
    syncPlayerShipTransform();

    // Keep the regular chase view for most of the descent, then move the camera
    // into the walking eye position during the final part of touchdown. The ship
    // proximity fade naturally clears the hull as the camera moves through it.
    const handoffStart = 0.62;
    if (t < handoffStart) {
      updateFlyCamera(dt);
    } else {
      if (!landing.cameraHandoffCaptured) {
        landing.cameraHandoffStart.copy(camera.position);
        landing.cameraHandoffCaptured = true;
      }

      const h0 = THREE.MathUtils.clamp(
        (t - handoffStart) / (1.0 - handoffStart),
        0.0,
        1.0,
      );
      const h = h0 * h0 * (3.0 - 2.0 * h0);
      const upW = tmp.camUpW
        .copy(landing.dirLocal)
        .applyQuaternion(tmp.worldQuat)
        .normalize();
      const walkEye = tmp.eyePosW
        .copy(player.worldPos)
        .addScaledVector(upW, 0.2);

      camera.position.lerpVectors(landing.cameraHandoffStart, walkEye, h);
      camera.quaternion.copy(flyQuat);
      camera.up.copy(upW);
      camera.updateMatrixWorld(true);
      playerShip.camPos.copy(camera.position);
      updatePlayerShipCameraFade();
    }

    // Let the engine hum wind down during the automated descent.
    updateFlyEngineSound(dt, 0.12 * (1.0 - settle), false);

    if (t < 1.0) return true;

    // Complete the handoff only after the ship and camera are already settled.
    landing.active = false;
    player.landing = false;
    setLandingSequenceVisible(false);
    player.mode = "walk";
    player.bodyIndex = landing.bodyIndex;
    player.dirLocal.copy(landing.dirLocal);
    player.radialOffset = 0.0;
    player.radialVel = 0.0;
    player.onGround = true;
    player.followIndex = -1;
    player.worldVel.set(0, 0, 0);
    yaw = landing.walkYaw;
    pitch = 0.0;
    roll = 0.0;
    rollVel = 0.0;
    input.resetMouse?.();
    syncPlayerShipVisibility();
    msg.textContent = `Landed on ${b.cfg?.name ?? "planet"}.`;
    return true;
  }

  // Cheat: noclip toggle (KeyI)
  // - Forces fly mode
  // - Disables planet-follow + collision push-out while enabled
  addEventListener("keydown", (e) => {
    if (e.code !== "KeyI") return;
    toggleNoclip();
  });
  addEventListener("keydown", (e) => {
    if (e.code === "KeyR") respawn();
  });

  addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.code === "KeyF") doTakeoff();
    if (e.code === "KeyL") doLand();
    if (e.code === "KeyV") toggleSurfaceVehicle();
  });

  function updateWalk(dt) {
    const b = bodies[player.bodyIndex];
    const upL = tmp.vA.copy(player.dirLocal).normalize();
    const gp = input.gamepad;
    if (input.pointerLocked || gp?.active) {
      const { dx, dy } = input.consumeMouseDelta();
      const sens = 0.0022;
      yaw -= dx * sens;
      pitch -= dy * sens;
      pitch = THREE.MathUtils.clamp(pitch, -1.45, 1.45);
    }

    tmp.refAxis.set(0, 1, 0);
    if (Math.abs(upL.dot(tmp.refAxis)) > 0.92) tmp.refAxis.set(1, 0, 0);

    tmp.eastL.copy(tmp.refAxis).cross(upL).normalize();
    tmp.northL.copy(upL).cross(tmp.eastL).normalize();

    tmp.qYaw.setFromAxisAngle(upL, yaw);
    tmp.forwardYawL.copy(tmp.northL).applyQuaternion(tmp.qYaw).normalize();
    tmp.rightYawL.copy(tmp.eastL).applyQuaternion(tmp.qYaw).normalize();

    tmp.qPitch.setFromAxisAngle(tmp.rightYawL, pitch);
    tmp.camForwardL
      .copy(tmp.forwardYawL)
      .applyQuaternion(tmp.qPitch)
      .normalize();
    tmp.camUpL.copy(tmp.rightYawL).cross(tmp.camForwardL).normalize();

    tmp.forwardMoveL
      .copy(tmp.camForwardL)
      .addScaledVector(upL, -tmp.camForwardL.dot(upL));
    if (tmp.forwardMoveL.lengthSq() < 1e-10)
      tmp.forwardMoveL.copy(tmp.forwardYawL);
    else tmp.forwardMoveL.normalize();

    tmp.rightMoveL.copy(upL).cross(tmp.forwardMoveL).normalize();

    let mx = 0,
      my = 0;
    if (keys.has("KeyW")) my -= 1;
    if (keys.has("KeyS")) my += 1;
    if (keys.has("KeyA")) mx -= 1;
    if (keys.has("KeyD")) mx += 1;

    // Gamepad left stick (standard mapping)
    // - Y is negative when pushing forward, matching our "W" direction.
    if (gp?.active) {
      mx += gp.lx;
      my += gp.ly;
    }

    const sprintHeld =
      keys.has("ShiftLeft") ||
      keys.has("ShiftRight") ||
      (gp?.active && (gp.buttons?.ls || gp.buttons?.lb));

    // Water movement is sampled against the live displaced ocean surface, not
    // mean sea level. Shallow water behaves as wading; once the water reaches
    // the upper body the same walk controller transitions into a buoyant swim.
    const terrainR0 = b.radiusAtDir(upL.x, upL.y, upL.z);
    tmp.waterSampleLocal
      .copy(upL)
      .multiplyScalar(Math.max(1.0, terrainR0));
    const oceanR0 = oceanSurfaceRadiusAtLocal(b, tmp.waterSampleLocal);
    const waterColumn0 = Number.isFinite(oceanR0)
      ? Math.max(0.0, oceanR0 - terrainR0)
      : 0.0;
    const playerRadius0 = terrainR0 + player.height + player.radialOffset;
    const swimmingBeforeMove =
      b?.hasOcean === true &&
      waterColumn0 > player.height * 0.80 &&
      oceanR0 > playerRadius0 - 0.45;
    const wade01 = THREE.MathUtils.clamp(
      waterColumn0 / Math.max(0.25, player.height),
      0.0,
      1.0,
    );
    const baseWalkSpeed = sprintHeld ? player.walkSprint : player.walkSpeed;
    const spd = swimmingBeforeMove
      ? (sprintHeld ? 4.25 : 2.75)
      : baseWalkSpeed * THREE.MathUtils.lerp(1.0, 0.52, wade01);

    tmp.moveDirL
      .set(0, 0, 0)
      .addScaledVector(tmp.forwardMoveL, my)
      .addScaledVector(tmp.rightMoveL, mx);

    const moveMag = Math.min(1.0, tmp.moveDirL.length());
    if (moveMag > 1e-6) {
      tmp.moveDirL.multiplyScalar(1 / moveMag);
      const motionR = swimmingBeforeMove
        ? Math.max(terrainR0 + player.height + player.radialOffset, 1.0)
        : Math.max(terrainR0, 1.0);
      const ang = (spd * moveMag * dt) / motionR;
      tmp.axisL.copy(tmp.moveDirL).cross(upL).normalize();
      player.dirLocal
        .applyQuaternion(tmp.qYaw.setFromAxisAngle(tmp.axisL, ang))
        .normalize();
    }

    const surfaceR = b.radiusAtDir(
      player.dirLocal.x,
      player.dirLocal.y,
      player.dirLocal.z,
    );
    tmp.waterSampleLocal
      .copy(player.dirLocal)
      .multiplyScalar(Math.max(1.0, surfaceR));
    const oceanR = oceanSurfaceRadiusAtLocal(b, tmp.waterSampleLocal);
    const waterColumn = Number.isFinite(oceanR)
      ? Math.max(0.0, oceanR - surfaceR)
      : 0.0;
    const currentRadius = surfaceR + player.height + player.radialOffset;
    const feetRadius = surfaceR + player.radialOffset;
    const waterAtFeet = Number.isFinite(oceanR) ? oceanR - feetRadius : -Infinity;
    const swimming =
      b?.hasOcean === true &&
      waterColumn > player.height * 0.80 &&
      oceanR > currentRadius - 0.45;

    player.waterDepth = Number.isFinite(waterAtFeet)
      ? Math.max(0.0, waterAtFeet)
      : 0.0;
    player.inWater = player.waterDepth > 0.02;
    player.swimming = swimming;

    const g = 11.5;
    const jumpOrSwimUp = keys.has("Space") || (gp?.active && gp.buttons?.a);
    const swimDown =
      keys.has("ControlLeft") ||
      keys.has("ControlRight") ||
      (gp?.active && (gp.lt ?? 0) > 0.1);

    if (swimming) {
      const verticalInput =
        (jumpOrSwimUp ? 1.0 : 0.0) -
        (swimDown ? 1.0 : 0.0) +
        (gp?.active ? (gp.rt ?? 0.0) : 0.0);
      const targetRadius = oceanR + 0.08;
      const surfaceError = targetRadius - currentRadius;
      const buoyancyAccel = THREE.MathUtils.clamp(
        surfaceError * 5.8 - player.radialVel * 2.5,
        -8.5,
        16.0,
      );
      const manual01 = Math.min(1.0, Math.abs(verticalInput));
      player.radialVel +=
        (buoyancyAccel * (1.0 - manual01 * 0.65) + verticalInput * 12.5) * dt;
      player.radialVel *= Math.exp(-1.75 * dt);
      player.radialOffset += player.radialVel * dt;
      if (player.radialOffset < 0.0) {
        player.radialOffset = 0.0;
        if (player.radialVel < 0.0) player.radialVel = 0.0;
      }
      player.onGround = false;
    } else {
      if (jumpOrSwimUp && player.onGround) {
        const jumpScale = THREE.MathUtils.lerp(1.0, 0.68, wade01);
        player.radialVel = 7.5 * jumpScale;
        player.onGround = false;
      }
      player.radialVel -= g * dt;
      if (player.inWater) player.radialVel *= Math.exp(-1.2 * dt);
      player.radialOffset += player.radialVel * dt;

      if (player.radialOffset < 0) {
        player.radialOffset = 0;
        player.radialVel = 0;
        player.onGround = true;
      }
    }

    const r = surfaceR + player.height + player.radialOffset;
    tmp.playerPosL.copy(player.dirLocal).multiplyScalar(r);
    pushOutOfTerrainWalk(b, tmp.playerPosL, player.dirLocal, 1.2);

    b.group.updateMatrixWorld(true);
    tmp.playerPosW.copy(tmp.playerPosL).applyMatrix4(b.group.matrixWorld);

    b.group.getWorldQuaternion(tmp.worldQuat);
    tmp.camForwardW
      .copy(tmp.camForwardL)
      .applyQuaternion(tmp.worldQuat)
      .normalize();
    tmp.camUpW.copy(tmp.camUpL).applyQuaternion(tmp.worldQuat).normalize();

    tmp.eyePosW.copy(tmp.playerPosW).addScaledVector(tmp.camUpW, 0.2);
    camera.position.copy(tmp.eyePosW);
    camera.up.copy(tmp.camUpW);
    camera.lookAt(tmp.vB.copy(tmp.eyePosW).add(tmp.camForwardW));

    player.worldPos.copy(tmp.playerPosW);

    emitFootWaterEffects(
      b,
      dt,
      moveMag,
      spd,
      swimming,
      (jumpOrSwimUp ? 1.0 : 0.0) - (swimDown ? 1.0 : 0.0),
      player.waterDepth,
      oceanR,
      surfaceR,
    );
    updateSurfaceWaterFx(dt);

    // Ensure ship model (if present) stays hidden while walking.
    syncPlayerShipVisibility();
  }

  function getPlanetFlightAssist(near) {
    if (near?.i < 0) return 0.0;
    const b = bodies[near.i];
    // Keep airless bodies and deep space on the original six-axis handling.
    if (!b?.group || b.hasAtmo === false || b?.collidable === false) return 0.0;

    const centerW = b.group.getWorldPosition(tmp.vA.set(0, 0, 0));
    tmp.planetUpW.copy(player.worldPos).sub(centerW);
    const dist = tmp.planetUpW.length();
    if (dist < 1e-6) return 0.0;
    tmp.planetUpW.multiplyScalar(1.0 / dist);

    b.group.getWorldQuaternion(tmp.worldQuat);
    tmp.cameraCastInvQ.copy(tmp.worldQuat).invert();
    tmp.vB.copy(tmp.planetUpW).applyQuaternion(tmp.cameraCastInvQ).normalize();
    const surfaceR = b.radiusAtDir(tmp.vB.x, tmp.vB.y, tmp.vB.z);
    const altitude = dist - surfaceR;
    if (altitude >= PLANET_FLIGHT_ASSIST_MAX_ALT) return 0.0;

    return 1.0 - THREE.MathUtils.smoothstep(
      altitude,
      PLANET_FLIGHT_ASSIST_FULL_ALT,
      PLANET_FLIGHT_ASSIST_MAX_ALT,
    );
  }

  function applyPlanetFlightAttitudeAssist(dt, assist, yawDelta, manualRollInput) {
    if (assist <= 1e-4) {
      autoBank *= Math.exp(-5.0 * dt);
      return;
    }

    const fwd = tmp.lookForwardW
      .set(0, 0, -1)
      .applyQuaternion(flyQuat)
      .normalize();

    // Build the local horizon while preserving the pilot's current pitch.
    tmp.horizonRightW.copy(fwd).cross(tmp.planetUpW);
    if (tmp.horizonRightW.lengthSq() < 1e-7) return;
    tmp.horizonRightW.normalize();
    tmp.horizonUpW.copy(tmp.horizonRightW).cross(fwd).normalize();

    // Mouse yaw becomes a coordinated bank command near a planet. The clamp
    // keeps fast mouse flicks from snapping the ship to an extreme roll angle.
    const yawRate = dt > 1e-4 ? yawDelta / dt : 0.0;
    const desiredBank = THREE.MathUtils.clamp(
      yawRate * -0.34,
      -PLANET_AUTO_BANK_MAX,
      PLANET_AUTO_BANK_MAX,
    ) * assist;
    const bankK = 1.0 - Math.exp(-7.0 * dt);
    autoBank = THREE.MathUtils.lerp(autoBank, desiredBank, bankK);

    // Q/E still works as manual roll. While held, greatly reduce auto-leveling
    // so the assist doesn't fight the pilot.
    const manualFactor = Math.abs(manualRollInput) > 0.01 ? 0.12 : 1.0;
    tmp.qBank.setFromAxisAngle(fwd, autoBank);
    tmp.bankedUpW.copy(tmp.horizonUpW).applyQuaternion(tmp.qBank).normalize();

    tmp.mLook.lookAt(
      tmp.vC.set(0, 0, 0),
      tmp.vD.copy(fwd),
      tmp.bankedUpW,
    );
    tmp.qLook.setFromRotationMatrix(tmp.mLook).normalize();

    const levelK =
      1.0 - Math.exp(-3.2 * assist * manualFactor * Math.max(0.0, dt));
    flyQuat.slerp(tmp.qLook, levelK).normalize();
  }

  function applyShipWaterInteraction(dt, near) {
    if (player.mode !== "fly" || near?.i < 0) {
      player.inWater = false;
      player.swimming = false;
      player.waterDepth = 0.0;
      return 0.0;
    }
    player.swimming = false;
    const body = bodies[near.i];
    if (!body?.hasOcean) {
      player.inWater = false;
      player.waterDepth = 0.0;
      return 0.0;
    }

    const centerDepth = sampleOceanDepthWorld(
      body,
      player.worldPos,
      tmp.waterUpWorld,
    );
    if (!Number.isFinite(centerDepth)) {
      player.inWater = false;
      player.waterDepth = 0.0;
      return 0.0;
    }

    const radius = Math.max(0.5, playerShip.collisionRadius ?? 3.0);
    const immersion = THREE.MathUtils.clamp(
      (centerDepth + radius) / (radius * 2.0),
      0.0,
      1.0,
    );
    player.inWater = immersion > 0.01;
    player.waterDepth = Math.max(0.0, centerDepth);
    if (immersion <= 0.0) return 0.0;

    // Flight remains pilot-controlled underwater, but water removes momentum
    // much more aggressively than air. Split velocity into radial/tangential
    // components so the hull can still rise naturally instead of simply being
    // multiplied toward zero in every direction.
    const radialSpeed = player.worldVel.dot(tmp.waterUpWorld);
    tmp.waterPointVelocity
      .copy(player.worldVel)
      .addScaledVector(tmp.waterUpWorld, -radialSpeed)
      .multiplyScalar(Math.exp(-4.4 * immersion * dt));

    let dampedRadialSpeed =
      radialSpeed * Math.exp(-2.8 * immersion * dt);
    if (centerDepth > 0.0) {
      const surfaceAccel = THREE.MathUtils.clamp(
        centerDepth * 7.5 - radialSpeed * 2.2,
        -9.0,
        28.0,
      );
      dampedRadialSpeed += surfaceAccel * immersion * dt;
    }

    player.worldVel
      .copy(tmp.waterPointVelocity)
      .addScaledVector(tmp.waterUpWorld, dampedRadialSpeed);
    return immersion;
  }

  function updateFly(dt) {
    if (landing.active) {
      updateLanding(dt);
      const landingNear = nearestBodyInfo(player.worldPos);
      updateAtmosphericShield(dt, landingNear);
      updateWingTrails(dt, landingNear, 0.0);
      applyGasGiantCameraShake(dt, sampleGasGiantEnvironment(landingNear));
      updateSurfaceWaterFx(dt);
      return;
    }

    const gp = input.gamepad;
    // Keep the ship in the nearest body's co-moving frame when close.
    // This should work even if noclip is enabled (noclip should only
    // affect collision, not whether we inherit nearby body motion).
    const near = nearestBodyInfo(player.worldPos);
    applyFlyFollow(near.i);
    const planetAssist = getPlanetFlightAssist(near);
    tmp.trailPrevQuat.copy(flyQuat);
    let frameYawDelta = 0.0;
    if (input.pointerLocked || gp?.active) {
      const { dx, dy } = input.consumeMouseDelta();
      const sens = 0.0022;
      const yawDelta = -dx * sens;
      const pitchDelta = -dy * sens;
      frameYawDelta = yawDelta;

      const fwd = tmp.lookForwardW
        .set(0, 0, -1)
        .applyQuaternion(flyQuat)
        .normalize();
      const shipUp = tmp.lookUpW
        .set(0, 1, 0)
        .applyQuaternion(flyQuat)
        .normalize();
      // Near a planet, left/right steering references local gravity instead of
      // the ship's rolled-up vector. This keeps turns aligned to the horizon.
      const yawUp = tmp.vE
        .copy(shipUp)
        .lerp(tmp.planetUpW, planetAssist * 0.9)
        .normalize();
      const right = tmp.lookRightW.copy(fwd).cross(yawUp).normalize();

      tmp.qYaw.setFromAxisAngle(yawUp, yawDelta);
      tmp.qPitch.setFromAxisAngle(right, pitchDelta);

      flyQuat.premultiply(tmp.qYaw);
      flyQuat.premultiply(tmp.qPitch);
      flyQuat.normalize();
    }

    let rIn = 0;
    if (keys.has("KeyQ")) rIn -= 1;
    if (keys.has("KeyE")) rIn += 1;

    // Gamepad bumpers for roll
    if (gp?.active) {
      if (gp.buttons?.lb) rIn -= 1;
      if (gp.buttons?.rb) rIn += 1;
    }

    rollVel += rIn * ROLL_ACCEL * dt;
    rollVel = THREE.MathUtils.clamp(rollVel, -ROLL_MAX, ROLL_MAX);
    rollVel *= Math.exp(-ROLL_DAMP * dt);

    if (Math.abs(rollVel) > 1e-5) {
      const fwd = tmp.lookForwardW
        .set(0, 0, -1)
        .applyQuaternion(flyQuat)
        .normalize();
      tmp.dq.setFromAxisAngle(fwd, rollVel * dt);
      flyQuat.premultiply(tmp.dq);
      flyQuat.normalize();
    }

    applyPlanetFlightAttitudeAssist(
      dt,
      planetAssist,
      frameYawDelta,
      rIn,
    );

    const orientationDot = THREE.MathUtils.clamp(
      Math.abs(tmp.trailPrevQuat.dot(flyQuat)),
      0.0,
      1.0,
    );
    const turnRate = dt > 1e-4
      ? (2.0 * Math.acos(orientationDot)) / dt
      : 0.0;

    const forwardW = tmp.lookForwardW
      .set(0, 0, -1)
      .applyQuaternion(flyQuat)
      .normalize();
    const upW = tmp.lookUpW.set(0, 1, 0).applyQuaternion(flyQuat).normalize();
    const rightW = tmp.lookRightW.copy(forwardW).cross(upW).normalize();

    let ax = 0,
      ay = 0,
      az = 0;
    if (keys.has("KeyW")) az += 1;
    if (keys.has("KeyS")) az -= 1;
    if (keys.has("KeyD")) ax += 1;
    if (keys.has("KeyA")) ax -= 1;
    if (keys.has("Space")) ay += 1;
    if (keys.has("ControlLeft") || keys.has("ControlRight")) ay -= 1;

    // Gamepad left stick + triggers (standard mapping)
    // - Forward on stick is negative Y, so az adds -ly.
    // - Triggers become vertical thrust (rt up, lt down).
    if (gp?.active) {
      ax += gp.lx;
      az += -gp.ly;
      ay += (gp.rt || 0) - (gp.lt || 0);
    }

    const boost =
      keys.has("ShiftLeft") ||
      keys.has("ShiftRight") ||
      (gp?.active && gp.buttons?.ls);
    const accel = boost ? player.flyBoostAccel : player.flyAccel;

    const thrust01 = Math.min(1.0, Math.hypot(ax, ay, az) / 1.7320508075688772);

    tmp.vA
      .set(0, 0, 0)
      .addScaledVector(forwardW, az)
      .addScaledVector(rightW, ax)
      .addScaledVector(upW, ay);

    if (tmp.vA.lengthSq() > 0) tmp.vA.normalize();

    player.worldVel.addScaledVector(tmp.vA, accel * dt);
    player.worldVel.multiplyScalar(Math.pow(player.flyDamp, dt * 60));
    const shipWaterImmersion = applyShipWaterInteraction(dt, near);
    tmp.collisionStartW.copy(player.worldPos);
    player.worldPos.addScaledVector(player.worldVel, dt);

    updateFlyEngineSound(dt, thrust01, boost);

    if (!player.noclip) {
      flyCollideAsteroids(tmp.collisionStartW);
      flyCollideNearestBody();
    }

    // Update optional ship model + camera.
    syncPlayerShipVisibility();
    syncPlayerShipTransform();
    if (near.i >= 0) {
      emitShipWaterEffects(dt, bodies[near.i], shipWaterImmersion, forwardW, rightW);
    }
    updateWingTrails(dt, near, turnRate);
    updateFlyCamera(dt);
    updateSurfaceWaterFx(dt);
    const gasEnv = sampleGasGiantEnvironment(near);
    applyGasGiantCameraShake(dt, gasEnv);
    updateAtmosphericShield(dt, near);
  }

  function initialSpawn() {
    despawnSurfaceVehicle();
    clearSurfaceWaterFx();
    const b = bodies[0];
    landing.active = false;
    player.landing = false;
    setLandingSequenceVisible(false);
    player.mode = "walk";
    player.followIndex = -1;
    player.bodyIndex = 0;
    player.dirLocal.set(0, 1, 0);

    const surfaceR = b.radiusAtDir(
      player.dirLocal.x,
      player.dirLocal.y,
      player.dirLocal.z,
    );
    const r = surfaceR + player.height;
    tmp.playerPosL.copy(player.dirLocal).multiplyScalar(r);
    pushOutOfTerrainWalk(b, tmp.playerPosL, player.dirLocal, 1.2);

    b.group.updateMatrixWorld(true);
    tmp.playerPosW.copy(tmp.playerPosL).applyMatrix4(b.group.matrixWorld);

    player.worldPos.copy(tmp.playerPosW);
    player.worldVel.set(0, 0, 0);
    yaw = 0;
    pitch = 0;

    flyQuat.identity();
    roll = 0;
    rollVel = 0;
    autoBank = 0.0;
  }

  // ============================================================================
  // Warp controller (triggered from FULL galaxy map double-click)
  // ============================================================================
  const chargeUI = makeChargeUI(document.getElementById("chargeUI"));
  const chargeSound = makeChargeSound();

  // Reuse the warp-charge synth as a continuous "engine/motor" hum in fly mode.
  // Warp takes ownership while active; otherwise we drive it from flight throttle/speed.
  let flyEngineP = 0.0; // smoothed 0..1

  function updateFlyEngineSound(dt, thrust01, boost) {
    // If warp is active, the warp controller drives this sound.
    if (warpCtrl?.warp?.active) return;

    // Only run in fly mode; otherwise fade out.
    if (player.mode !== "fly") {
      flyEngineP = 0.0;
      chargeSound?.stop?.();
      return;
    }

    const spd = player.worldVel.length();

    // Map speed to 0..1 with a soft knee (works across wide ranges).
    const vScale = boost ? 160.0 : 80.0;
    const speed01 = 1.0 - Math.exp(-spd / vScale);

    // Mix speed + thrust + a little boost punch.
    const desired = Math.min(
      1.0,
      Math.max(speed01, thrust01 * 0.55, boost ? 0.35 : 0.0),
    );

    // dt-stable smoothing
    const a = 1.0 - Math.exp(-6.0 * Math.max(0.0, dt));
    flyEngineP += (desired - flyEngineP) * a;

    // Keep it subtle compared to full warp charge (0.10..~0.65)
    chargeSound.ensureAudio?.();
    chargeSound.start?.();
    chargeSound.update?.(0.1 + 0.55 * flyEngineP);
  }

  // Resume audio on first user gesture (required by browsers)
  window.addEventListener(
    "pointerdown",
    async () => {
      chargeSound.ensureAudio();
      await chargeSound.resume();
    },
    { once: false },
  );
  const warpOverlay = createWarpOverlay(THREE, innerWidth, innerHeight);
  resizeWarpOverlay(warpOverlay.warpMat, innerWidth, innerHeight);

  function getWarpDirection(target) {
    // direction is derived from the chosen galaxy target
    return tmp.vA
      .set(target?.x ?? 0, (target?.y ?? 0) * 0.6, -1.25)
      .normalize();
  }

  warpCtrl = makeWarpController({
    THREE,
    warpMat: warpOverlay.warpMat,
    chargeUI,
    chargeSound,
    canWarp: () => player?.mode === "fly" && !landing.active,
    getWarpDirection,
    onWarpStart: (target) => {
      despawnSurfaceVehicle();
      msg.textContent = `Warping to ${target?.name ?? "unknown"}…`;
      // release pointer lock so the overlay feels clean
      if (document.pointerLockElement) document.exitPointerLock();
      input.resetMouse();
      // ensure we are in a safe state
      player.followIndex = -1;
      player.worldVel.set(0, 0, 0);
      setGasGiantWarningVisible(false);
      gasGiantShakeStrength = 0.0;
      // player.worldPos is the canonical ship/player position.
      // If the camera is offset (chase cam), do NOT pull worldPos from it.
      if (!shipChaseActive()) player.worldPos.copy(camera.position);
      flyQuat.copy(camera.quaternion);
      roll = 0;
      rollVel = 0;
      autoBank = 0.0;
    },
    onWarpRebuildSystem: (target) => {
      rebuildSystemForWarp(target);
    },
    onWarpArrive: (target) => {
      msg.textContent = `Arrived at ${target?.name ?? "unknown"} (seed ${target?.seed ?? "?"}).`;
      input.resetMouse();
    },

    addVelocityForward: (dirW, accel, dt) =>
      player.worldVel.addScaledVector(dirW, accel * dt),
    dampVelocity: (damp, dt) =>
      player.worldVel.multiplyScalar(Math.pow(damp, dt * 60)),

    integratePosition: (dt) => {
      // Move using the same collision push-out as normal fly mode
      player.worldPos.addScaledVector(player.worldVel, dt);
      if (!player.noclip) flyCollideNearestBody();
      syncPlayerShipVisibility();
      syncPlayerShipTransform();
      updateFlyCamera(dt);
    },

    interpolateLookAt: (p01, dirW, dt) => {
      // Build a camera quaternion that looks along dirW, then ease toward it.
      tmp.mLook.lookAt(
        player.worldPos,
        tmp.vC.copy(player.worldPos).add(dirW),
        tmp.vB.set(0, 1, 0),
      );
      tmp.qLook.setFromRotationMatrix(tmp.mLook);

      // dt-stable easing; stronger as the charge completes
      const base = 1.0 - Math.pow(0.02, dt * 60);
      const k = THREE.MathUtils.clamp(base * (0.15 + 0.85 * p01), 0, 1);
      flyQuat.slerp(tmp.qLook, k);
      flyQuat.normalize();
    },
  });
  // Warp overlay is resized in the unified resize handler below.

  // Cross-module helpers
  function stopFlyEngineAudio() {
    try {
      flyEngineP = 0.0;
    } catch (_) {}
    chargeSound?.stop?.();
  }

  // Expose a small audio API for UI (mute toggle, etc.)
  const audio = {
    setMuted: (m) => chargeSound?.setMuted?.(!!m),
    isMuted: () => !!chargeSound?.isMuted?.(),
    toggleMuted: () => {
      const next = !audio.isMuted();
      audio.setMuted(next);
      return next;
    },
  };

  return {
    input,
    keys,
    audio,
    player,
    flyQuat,
    tmp,
    playerShip,
    playerVehicle,
    surfaceWaterFxScene,
    warpCtrl,
    warpOverlay,
    galaxyOverlayUI,
    galaxyMiniMapUI,
    isGalaxyOpen,
    nearestBodyInfo,
    initialSpawn,
    placePlayerNearNewStar,
    respawn,
    toggleNoclip,
    doTakeoff,
    doLand,
    toggleSurfaceVehicle,
    updateSurfaceVehicleAnchor,
    updateLanding,
    updateWalk,
    updateDrive,
    updateFly,
    stopFlyEngineAudio,
  };
}
