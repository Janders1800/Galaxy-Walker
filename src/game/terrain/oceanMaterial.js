import { THREE } from "../../render/device.js";

export const OCEAN_MAX_OCCLUDERS = 24;

// Wave construction adapted from "Very fast procedural ocean" by afl_ext
// (ShaderToy MdXyzX, MIT). The original shader raymarches a planar heightfield.
// Here the same dragged exponential-octave family is evaluated analytically on
// the stitched spherical ocean mesh, so it keeps the reference character
// without adding a second raymarch or reopening LOD seams.
const OCEAN_VERTEX_SHADER = /* glsl */ `
#include <common>

attribute vec3 terrainPosition;
// xyz stores the first coarse-edge anchor. w stores the interpolation factor
// toward the second anchor. For ordinary vertices w is zero and xyz equals
// position. On a 2:1 stitched edge the second anchor can be reconstructed from
// position, so the fine edge follows the exact displaced coarse triangle edge.
attribute vec4 oceanSwayAnchor;

uniform float uTime;
uniform float uWaveAmp;
uniform float uWaveFreq;
uniform float uWaveSpeed;
uniform float uWaveChoppiness;
uniform float uWaveDrag;
uniform float uVertexWaveIterations;
uniform float uVertexSway;
uniform vec3 uWaveOffset;
uniform mat3 uWorldNormalMatrix;

varying vec3 vOceanPosObj;
varying vec3 vWorldPos;
varying vec3 vBaseNormalW;
varying vec3 vTerrainPosObj;
varying float vWaveHeight;

#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>

vec3 octaveDirectionVertex(float iteration) {
  return normalize(vec3(
    sin(iteration),
    cos(iteration * 0.917 + 1.731),
    sin(iteration * 1.371 + 2.417)
  ));
}

float oceanVertexHeight(vec3 basePosition) {
  vec3 samplePosition = (basePosition + uWaveOffset) * uWaveFreq;
  float weightedHeight = 0.0;
  float weightSum = 0.0;

  float iteration = 0.0;
  float phase = 6.0;
  float speed = 2.0;
  float weight = 1.0;
  float octaveCount = clamp(uVertexWaveIterations, 4.0, 10.0);

  for (int i = 0; i < 16; i++) {
    if (float(i) >= octaveCount) break;

    vec3 direction = octaveDirectionVertex(iteration);
    float x = dot(direction, samplePosition) * phase +
      uTime * uWaveSpeed * speed;
    float wave = exp(sin(x) - 1.0);
    float derivative = wave * cos(x);

    samplePosition += direction * (-derivative) * weight *
      uWaveDrag * uWaveChoppiness;
    weightedHeight += wave * weight;
    weightSum += weight;

    iteration += 12.0;
    weight *= 0.8;
    phase *= 1.18;
    speed *= 1.07;
  }

  // Mean of exp(sin(x) - 1). Centering it keeps sea level stable while the
  // original ShaderToy-shaped wave family sways both above and below it.
  const float WAVE_MEAN = 0.4657596;
  float centered = weightedHeight / max(weightSum, 1e-5) - WAVE_MEAN;
  return centered * uWaveAmp * uVertexSway * 1.85;
}

vec3 displacedOceanPosition(vec3 basePosition) {
  return basePosition + normalize(basePosition) * oceanVertexHeight(basePosition);
}

void main() {
  vOceanPosObj = position;
  vTerrainPosObj = terrainPosition;
  vBaseNormalW = normalize(uWorldNormalMatrix * normal);

  float stitchMix = clamp(oceanSwayAnchor.w, 0.0, 1.0);
  vec3 anchorA = oceanSwayAnchor.xyz;
  vec3 displacedPosition = displacedOceanPosition(anchorA);

  // Balanced ocean LOD only needs half-step interpolation here. Reconstructing
  // the second coarse anchor avoids another three-float vertex attribute while
  // keeping the displaced fine edge exactly collinear with the coarse edge.
  if (stitchMix > 1e-5) {
    vec3 anchorB =
      (position - anchorA * (1.0 - stitchMix)) / stitchMix;
    displacedPosition = mix(
      displacedPosition,
      displacedOceanPosition(anchorB),
      stitchMix
    );
  }

  // Interpolated animated surface displacement is also used by the fragment
  // shader's shoreline model, so breaker foam follows visible crests/troughs
  // instead of a flat mean-sea-level contour.
  vWaveHeight = length(displacedPosition) - length(position);

  vec4 worldPosition = modelMatrix * vec4(displacedPosition, 1.0);
  vWorldPos = worldPosition.xyz;

  vec4 mvPosition = viewMatrix * worldPosition;
  gl_Position = projectionMatrix * mvPosition;

  #include <logdepthbuf_vertex>
  #include <fog_vertex>
}
`;

// CPU mirror of oceanVertexHeight() above. Underwater activation uses this
// exact displaced surface instead of the mean sea-level sphere, so camera
// transitions stay synchronized with visible wave crests and troughs.
export function evaluateOceanVertexHeightCPU(basePosition, uniforms) {
  if (!basePosition || !uniforms) return 0.0;

  const waveOffset = uniforms.uWaveOffset?.value;
  const waveFreq = uniforms.uWaveFreq?.value ?? 0.012;
  const waveSpeed = uniforms.uWaveSpeed?.value ?? 0.54;
  const waveChoppiness = uniforms.uWaveChoppiness?.value ?? 0.92;
  const waveDrag = uniforms.uWaveDrag?.value ?? 0.048;
  const waveAmp = uniforms.uWaveAmp?.value ?? 2.2;
  const vertexSway = uniforms.uVertexSway?.value ?? 1.0;
  const time = uniforms.uTime?.value ?? 0.0;
  const octaveCount = Math.max(
    4.0,
    Math.min(10.0, uniforms.uVertexWaveIterations?.value ?? 8.0),
  );

  let px = (basePosition.x + (waveOffset?.x ?? 0.0)) * waveFreq;
  let py = (basePosition.y + (waveOffset?.y ?? 0.0)) * waveFreq;
  let pz = (basePosition.z + (waveOffset?.z ?? 0.0)) * waveFreq;

  let weightedHeight = 0.0;
  let weightSum = 0.0;
  let iteration = 0.0;
  let phase = 6.0;
  let speed = 2.0;
  let weight = 1.0;

  for (let i = 0; i < 16 && i < octaveCount; i++) {
    let dx = Math.sin(iteration);
    let dy = Math.cos(iteration * 0.917 + 1.731);
    let dz = Math.sin(iteration * 1.371 + 2.417);
    const invLen = 1.0 / Math.max(1e-12, Math.hypot(dx, dy, dz));
    dx *= invLen;
    dy *= invLen;
    dz *= invLen;

    const x = (dx * px + dy * py + dz * pz) * phase +
      time * waveSpeed * speed;
    const wave = Math.exp(Math.sin(x) - 1.0);
    const derivative = wave * Math.cos(x);
    const drag = -derivative * weight * waveDrag * waveChoppiness;

    px += dx * drag;
    py += dy * drag;
    pz += dz * drag;
    weightedHeight += wave * weight;
    weightSum += weight;

    iteration += 12.0;
    weight *= 0.8;
    phase *= 1.18;
    speed *= 1.07;
  }

  const WAVE_MEAN = 0.4657596;
  const centered = weightedHeight / Math.max(weightSum, 1e-5) - WAVE_MEAN;
  return centered * waveAmp * vertexSway * 1.85;
}

const OCEAN_FRAGMENT_SHADER = /* glsl */ `
uniform float uTime;
uniform float uWaveAmp;
uniform float uWaveFreq;
uniform float uWaveSpeed;
uniform float uWaveChoppiness;
uniform float uWaveDrag;
uniform float uWaveIterations;
uniform vec3 uWaveOffset;
uniform float uMurk;
uniform float uRoughness;
uniform float uShallowDepth;
uniform float uFoamDepth;
uniform float uShallowOpacity;
uniform float uDeepOpacity;
uniform float uSeaLevel;
uniform float uCameraInsideOcean;

uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uFoamColor;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;
uniform vec3 uSunColor;
uniform float uSunIntensity;

uniform vec3 uPlanetCenterW;
uniform vec3 uSunPosW;
uniform float uSunRadius;
uniform mat3 uWorldNormalMatrix;

uniform int uOccCount;
uniform vec3 uOccCenters[${OCEAN_MAX_OCCLUDERS}];
uniform float uOccRadii[${OCEAN_MAX_OCCLUDERS}];
uniform float uEclipseSoftness;
uniform float uEclipseStrength;
uniform float uEclipseSpecularPower;

varying vec3 vOceanPosObj;
varying vec3 vWorldPos;
varying vec3 vBaseNormalW;
varying vec3 vTerrainPosObj;
varying float vWaveHeight;

#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>

// Approximate overlap of the finite solar disc and each spherical occluder.
// The old point-sun test only affected direct specular and was almost invisible
// through the reflected sky. This version gives partial/total eclipses a soft,
// spatially varying umbra and is applied to all sun-driven ocean terms.
float sunVisibility(vec3 pW, vec3 sunPosW) {
  vec3 toSun = sunPosW - pW;
  float sunDistance = length(toSun);
  if (sunDistance <= 1e-5) return 1.0;
  vec3 sunDirection = toSun / sunDistance;

  float visibility = 1.0;

  for (int i = 0; i < ${OCEAN_MAX_OCCLUDERS}; i++) {
    if (i >= uOccCount) break;

    vec3 toOccluder = uOccCenters[i] - pW;
    float alongRay = dot(toOccluder, sunDirection);
    if (alongRay <= 0.0 || alongRay >= sunDistance) continue;

    float perpendicularDistance = length(toOccluder - sunDirection * alongRay);
    float occluderRadius = max(0.0, uOccRadii[i]);
    if (occluderRadius <= 0.0) continue;

    // Shared eclipse semantics: centre-ray intersection is the hard core that
    // agrees with the coarse point-light shadow. The finite solar disc below
    // only controls the penumbra outside that geometric silhouette.
    if (perpendicularDistance <= occluderRadius) {
      visibility = 0.0;
      break;
    }

    // Radius of the solar disc projected onto the occluder's depth plane.
    // uEclipseSoftness supplies a conservative minimum penumbra for tiny or
    // extremely distant projected suns.
    float projectedSunRadius = max(
      uSunRadius * (alongRay / sunDistance),
      occluderRadius * max(uEclipseSoftness, 0.0001)
    );

    float outerContact = occluderRadius + projectedSunRadius;
    if (perpendicularDistance >= outerContact) continue;

    float innerContact = abs(occluderRadius - projectedSunRadius);
    float overlap = 1.0 - smoothstep(
      innerContact,
      max(innerContact + 1e-4, outerContact),
      perpendicularDistance
    );

    // A smaller occluder cannot hide more than its projected area fraction.
    float maximumCoverage = occluderRadius >= projectedSunRadius
      ? 1.0
      : clamp(
          (occluderRadius * occluderRadius) /
          max(1e-5, projectedSunRadius * projectedSunRadius),
          0.0,
          1.0
        );

    visibility = min(visibility, 1.0 - overlap * maximumCoverage);
  }

  return mix(1.0, visibility, clamp(uEclipseStrength, 0.0, 1.0));
}

vec3 octaveDirection(float iteration) {
  // Three-dimensional plane-wave directions keep the field continuous over
  // the whole sphere; there is no longitude seam or polar tangent singularity.
  return normalize(vec3(
    sin(iteration),
    cos(iteration * 0.917 + 1.731),
    sin(iteration * 1.371 + 2.417)
  ));
}

void oceanWaveField(
  vec3 position,
  vec3 up,
  float detailFade,
  out vec3 waveNormal,
  out float crest,
  out float slopeAmount
) {
  // MdXyzX starts at phase 6, grows frequency by 1.18, speed by 1.07,
  // decays weight by 0.8 and drags the sampling position by the derivative.
  vec3 samplePosition = (position + uWaveOffset) * uWaveFreq;
  vec3 gradient = vec3(0.0);
  float weightedHeight = 0.0;
  float weightSum = 0.0;

  float iteration = 0.0;
  float phase = 6.0;
  float speed = 2.0;
  float weight = 1.0;
  float octaveCount = clamp(mix(6.0, uWaveIterations, detailFade), 4.0, 16.0);

  for (int i = 0; i < 16; i++) {
    if (float(i) >= octaveCount) break;

    vec3 direction = octaveDirection(iteration);
    float x = dot(direction, samplePosition) * phase +
      uTime * uWaveSpeed * speed;

    float wave = exp(sin(x) - 1.0);
    float derivative = wave * cos(x);

    samplePosition += direction * (-derivative) * weight *
      uWaveDrag * uWaveChoppiness;

    weightedHeight += wave * weight;
    gradient += direction * (derivative * phase) * weight;
    weightSum += weight;

    iteration += 12.0;
    weight *= 0.8;
    phase *= 1.18;
    speed *= 1.07;
  }

  float inverseWeight = 1.0 / max(weightSum, 1e-5);
  crest = weightedHeight * inverseWeight;

  // Convert the dimensionless field derivative to object-space slope. The
  // analytic derivative replaces the reference shader's three 48-octave
  // height evaluations, keeping the look affordable on multiple planets.
  gradient *= inverseWeight * uWaveAmp * uWaveFreq;
  gradient -= up * dot(gradient, up);
  gradient *= (4.0 + 2.2 * uWaveChoppiness);

  slopeAmount = length(gradient);
  waveNormal = normalize(up - gradient);
}

vec3 fresnelSchlick(float cosine, vec3 F0) {
  float f = pow(1.0 - clamp(cosine, 0.0, 1.0), 5.0);
  return F0 + (1.0 - F0) * f;
}

float foamPattern(vec3 p, float t) {
  float a = sin(dot(p, vec3(0.73, 0.19, -0.66)) * uWaveFreq * 3.7 + t * 1.9);
  float b = sin(dot(p, vec3(-0.21, 0.91, 0.35)) * uWaveFreq * 6.1 - t * 2.6);
  float c = sin(dot(p, vec3(0.48, -0.57, 0.67)) * uWaveFreq * 10.7 + t * 3.4);
  return smoothstep(-0.35, 0.78, a * 0.52 + b * 0.31 + c * 0.17);
}

vec3 reflectedAtmosphere(
  vec3 reflectionDirection,
  vec3 up,
  float day,
  float eclipse,
  float sunPower
) {
  float elevation = clamp(dot(reflectionDirection, up), -0.08, 1.0);
  float skyT = pow(clamp(elevation, 0.0, 1.0), 0.38);

  vec3 daySky = mix(uSkyHorizon, uSkyZenith, skyT);
  float horizonGlow = pow(1.0 - clamp(elevation, 0.0, 1.0), 4.0);
  daySky += uSkyHorizon * horizonGlow * 0.18;

  // Facets tilted below the local horizon should not keep reflecting the bright
  // horizon band. Let them fall back toward deep-water colour; this creates
  // the dark trough/bright ridge contrast of the reference ocean.
  float visibleSky = smoothstep(-0.025, 0.075, elevation);
  daySky = mix(uDeepColor * 0.18, daySky * 0.66, visibleSky);

  vec3 nightSky = mix(
    vec3(0.0012, 0.0022, 0.0060),
    uDeepColor * 0.15,
    clamp(elevation * 0.5 + 0.5, 0.0, 1.0)
  );

  // Treat the daylight sky as a sun-driven reflection. During totality it must
  // collapse to the dark environment instead of leaving a broad bright lobe
  // that can be mistaken for uneclipsed specular.
  float visibleSun = clamp(
    day * eclipse * min(max(sunPower, 0.0), 1.0),
    0.0,
    1.0
  );
  float skyVisibility = visibleSun * visibleSun;
  float skyEnergy = 0.58 + 0.42 * clamp(sunPower, 0.0, 3.0);
  return mix(nightSky, daySky * skyEnergy, skyVisibility);
}

vec3 directSolarSpecular(
  vec3 reflectionDirection,
  vec3 sunDirection,
  float surfaceSunVisibility,
  float sunPower,
  float roughness
) {
  float reflectedSun = max(dot(reflectionDirection, sunDirection), 0.0);
  float solarHaze = pow(reflectedSun, 8.0) * 0.11;
  float solarExponent = mix(150.0, 560.0, 1.0 - roughness);
  float solarDisc = pow(reflectedSun, solarExponent) *
    mix(12.0, 42.0, 1.0 - roughness);

  // A linear HDR multiplier can still tone-map to white during a deep partial
  // eclipse. Suppress the broad haze quadratically and the saturated disc with
  // a configurable steeper response so the glint visibly tracks obscuration.
  float visibleFraction = clamp(surfaceSunVisibility, 0.0, 1.0);
  float hazeVisibility = visibleFraction * visibleFraction;
  float discVisibility = pow(
    visibleFraction,
    max(1.0, uEclipseSpecularPower)
  );

  return uSunColor *
    (solarHaze * hazeVisibility + solarDisc * discVisibility) *
    max(sunPower, 0.0);
}

void main() {
  // Double-sided transparent shells otherwise blend the far hemisphere through
  // the near one. That leaked an uneclipsed far-side glint and foam into the
  // visible surface. Render only the camera-facing shell: front faces outside,
  // back faces while underwater.
  bool cameraInsideOcean = uCameraInsideOcean > 0.5;
  if ((cameraInsideOcean && gl_FrontFacing) ||
      (!cameraInsideOcean && !gl_FrontFacing)) {
    discard;
  }

  #include <logdepthbuf_fragment>

  // Interpolating the complete terrain position gives the shader a useful
  // shallow-water/foam estimate. Visibility itself is decided by the opaque
  // terrain depth buffer, which is exact for the currently rendered terrain
  // LOD and avoids shoreline holes on coarse triangles.
  float signedWaterDepth = uSeaLevel - length(vTerrainPosObj);

  vec3 upObj = normalize(vOceanPosObj);
  vec3 upW = normalize(vWorldPos - uPlanetCenterW);
  vec3 V = normalize(cameraPosition - vWorldPos);

  float viewDistance = length(cameraPosition - vWorldPos);
  float planetScale = max(1.0, length(vOceanPosObj));
  float detailFade = 1.0 - smoothstep(
    planetScale * 0.75,
    planetScale * 6.0,
    viewDistance
  );

  float crest = 0.0;
  float slopeAmount = 0.0;
  vec3 waveNormalObj = upObj;
  oceanWaveField(
    vOceanPosObj,
    upObj,
    detailFade,
    waveNormalObj,
    crest,
    slopeAmount
  );

  vec3 N = normalize(uWorldNormalMatrix * waveNormalObj);
  vec3 geometricN = normalize(vBaseNormalW);
  // Flatten high-frequency normals with distance, matching the reference
  // shader's stable horizon treatment while retaining the stitched base normal.
  float normalStrength = mix(0.46, 0.96, detailFade);
  N = normalize(mix(geometricN, N, normalStrength));

  // The ocean is rendered from both sides. Flip the shading normal on the
  // underside so underwater reflections and Fresnel use the surface facing the
  // camera instead of an outward normal pointing away from it.
  if (!gl_FrontFacing) {
    N = -N;
    geometricN = -geometricN;
  }

  vec3 L = normalize(uSunPosW - vWorldPos);
  vec3 planetSunDirection = normalize(uSunPosW - uPlanetCenterW);

  float NoV = max(dot(N, V), 0.001);
  // Use the geometric surface normal for transmission closure. Wave normals
  // should shape reflections, but must not punch tiny transparent windows into
  // an otherwise edge-on ocean silhouette.
  float geometricNoV = max(dot(geometricN, V), 0.001);
  float NoL = max(dot(N, L), 0.0);
  float dayFacing = dot(upW, planetSunDirection);
  float day = smoothstep(-0.16, 0.18, dayFacing);
  float sunPower = clamp(uSunIntensity, 0.0, 3.0);

  float eclipse = 1.0;
  if (day > 0.001 && sunPower > 0.001) {
    eclipse = sunVisibility(vWorldPos + upW * 0.25, uSunPosW);
  }

  // Apply eclipse only to the illuminated hemisphere, but apply it to the
  // reflected atmosphere, transmission, foam and solar glints—not just one
  // specular term—so the moving shadow is unmistakable on water.
  float localEclipse = mix(1.0, eclipse, day);
  float surfaceSunVisibility = clamp(day * eclipse, 0.0, 1.0);
  float directVisibility = surfaceSunVisibility * sunPower;

  // Shore depth follows the animated surface. A crest raises the local water
  // column over the terrain; a trough lowers it. This keeps colour, opacity and
  // foam synchronized with the actual displaced mesh instead of sea level.
  float signedSurfaceDepth = signedWaterDepth + vWaveHeight;
  float waterDepth = max(signedSurfaceDepth, 0.0);
  float shallowScale = max(1e-4, uShallowDepth);
  float depth01 = clamp(waterDepth / shallowScale, 0.0, 1.0);
  float deepT = smoothstep(0.0, 1.0, depth01);

  // Push very shallow water toward a brighter turquoise/sediment colour, then
  // transition naturally back into the authored shallow/deep ocean palette.
  float coastTint = 1.0 - smoothstep(
    0.0,
    max(1e-4, uFoamDepth * 1.8),
    waterDepth
  );
  vec3 littoralColor = mix(uShallowColor, uFoamColor, 0.12);
  vec3 waterColor = mix(uShallowColor, uDeepColor, deepT);
  waterColor = mix(waterColor, littoralColor, coastTint * 0.42);

  float grazingPath = 1.0 / max(0.14, NoV);
  // Use physical-ish water-column depth rather than only the binary shallow/deep
  // blend. This makes the seabed read clearly in the first few metres and lose
  // contrast progressively as the coast falls away.
  float opticalDepth = clamp(waterDepth / shallowScale, 0.0, 3.0);
  float absorption = exp(-uMurk * opticalDepth * grazingPath * 0.82);

  // Dark, saturated body color under a bright reflected sky is the defining
  // visual balance of MdXyzX. Keep enough shallow transmission for coastlines.
  vec3 transmitted = waterColor * mix(0.28, 0.92, absorption);
  transmitted *= 0.20 + 0.34 * directVisibility * NoL;
  transmitted += littoralColor *
    (0.050 + 0.085 * day) *
    (1.0 - deepT) *
    (0.55 + 0.45 * coastTint);

  float subsurface = pow(max(dot(V, -L), 0.0), 3.0) *
    (1.0 - deepT) * (0.25 + 0.75 * crest);
  transmitted += uShallowColor * subsurface * directVisibility * 0.32;
  transmitted *= mix(0.32, 1.0, localEclipse);

  float roughness = clamp(
    uRoughness + slopeAmount * 0.045,
    0.045,
    0.29
  );

  vec3 reflectionDirection = reflect(-V, N);
  vec3 reflectedSky = reflectedAtmosphere(
    reflectionDirection,
    upW,
    day,
    eclipse,
    sunPower
  );
  vec3 solarSpecular = directSolarSpecular(
    reflectionDirection,
    L,
    surfaceSunVisibility,
    sunPower,
    roughness
  );

  vec3 F = fresnelSchlick(NoV, vec3(0.04));
  float fresnel = clamp((F.r + F.g + F.b) / 3.0, 0.0, 1.0);
  float reflectionWeight = clamp(fresnel * 1.18, 0.04, 0.985);

  float foamDepth = max(1e-4, uFoamDepth);
  float shoreline = 1.0 - smoothstep(0.0, foamDepth * 1.05, waterDepth);
  shoreline *= smoothstep(-foamDepth * 0.12, foamDepth * 0.08, signedSurfaceDepth);

  float foam = 0.0;
  if (shoreline > 0.001) {
    float pattern = foamPattern(vOceanPosObj, uTime * uWaveSpeed);
    float shoreCoord = clamp(waterDepth / foamDepth, 0.0, 1.0);

    // Breaker fronts sweep shoreward/outward instead of forming one static white
    // contour. Spatial phase breaks synchronization around the planet while the
    // local water-depth coordinate keeps the bands glued to the coastline.
    float spatialPhase = dot(
      normalize(vOceanPosObj),
      normalize(vec3(0.71, -0.39, 0.58))
    ) * 31.0 + pattern * 3.1;
    float sweep = 0.5 + 0.5 * sin(
      uTime * uWaveSpeed * 1.35 + spatialPhase
    );
    float breakerCenter = mix(0.12, 0.62, sweep);
    float breakerDelta = (shoreCoord - breakerCenter) * 10.5;
    float breaker = exp(-breakerDelta * breakerDelta);

    float wash = pow(max(0.0, 1.0 - shoreCoord), 1.65) *
      (0.32 + 0.68 * pattern);
    foam += shoreline * (0.045 + pattern * 0.16);
    foam += shoreline * breaker * (0.14 + pattern * 0.20);
    foam += shoreline * wash * 0.10;
  }

  float whitecap =
    smoothstep(0.57, 0.79, crest) *
    smoothstep(0.15, 0.58, slopeAmount) *
    detailFade;
  foam = clamp(foam + whitecap * 0.18, 0.0, 0.78);

  vec3 color = transmitted * (1.0 - reflectionWeight * 0.58);
  color += reflectedSky * reflectionWeight * 1.42;
  // Keep the direct solar lobe separate from ambient sky reflection so eclipse
  // visibility cannot be lost inside an already-bright reflected sky value.
  color += solarSpecular * reflectionWeight * 1.42;

  vec3 eclipseTint = vec3(0.48, 0.60, 0.78);
  color *= mix(eclipseTint, vec3(1.0), localEclipse);

  // Shore foam and whitecaps are sunlight-scattering features. Gate both their
  // colour and their coverage by the same finite-disc eclipse visibility as the
  // solar reflection. There is deliberately no white/emissive floor in totality
  // or on the night side.
  float foamSunVisibility = clamp(
    surfaceSunVisibility * min(sunPower, 1.0) *
      smoothstep(0.0, 0.38, NoL),
    0.0,
    1.0
  );
  float foamEnergy = foamSunVisibility *
    (0.58 + 0.42 * clamp(sunPower, 0.0, 2.4));
  vec3 foamLight = uFoamColor * foamEnergy;
  float visibleFoam = foam * foamSunVisibility;
  color = mix(color, foamLight, visibleFoam);

  // Very shallow water is deliberately clearer so the seabed reads through the
  // littoral zone. Opacity builds with actual water-column depth, while foam and
  // Fresnel still close the surface toward breakers and glancing views.
  float edgeClarity = 1.0 - smoothstep(
    0.0,
    max(1e-4, uFoamDepth * 1.25),
    waterDepth
  );
  float shallowEdgeOpacity = max(0.18, uShallowOpacity * 0.62);
  float shallowOpacity = mix(uShallowOpacity, shallowEdgeOpacity, edgeClarity);
  float alpha = mix(shallowOpacity, uDeepOpacity, deepT);
  alpha = mix(alpha, 0.955, clamp(fresnel * 0.90, 0.0, 1.0));
  alpha = mix(alpha, 0.965, visibleFoam);

  // From above the water, transparency is a shoreline effect only. Once the
  // local water column leaves the littoral band, close the surface to a true
  // opaque result. This prevents the already-rendered seabed, sun and other HDR
  // scene content from bleeding through a deep ocean merely because the water
  // material uses alpha blending. Keep the underwater side unchanged so the
  // water/air interface still reads naturally from below.
  if (!cameraInsideOcean) {
    // Keep any true transparency confined to the immediate shoreline. The
    // previous littoral band extended several metres into the water, which was
    // still enough for bright HDR content and deep terrain silhouettes to leak
    // through at low viewing angles. Above water, start nearly opaque and close
    // to exact alpha=1 within only a few metres of local water-column depth.
    alpha = max(alpha, 0.94);

    float deepOpaqueStart = max(0.35, uFoamDepth * 0.12);
    float deepOpaqueEnd = max(deepOpaqueStart + 0.35, uFoamDepth * 0.30);
    float deepWaterClosure = smoothstep(
      deepOpaqueStart,
      deepOpaqueEnd,
      waterDepth
    );
    alpha = mix(alpha, 1.0, deepWaterClosure);
  }

  // At a grazing view the optical path through water becomes enormous and the
  // surface must stop behaving like translucent glass. Close transmission to a
  // true opaque result before the horizon. This also prevents an HDR sun disc
  // behind the water from leaking through a nominal 0.995 alpha value.
  float grazingOpaque = 1.0 - smoothstep(0.14, 0.34, geometricNoV);
  alpha = mix(alpha, 1.0, grazingOpaque);

  gl_FragColor = vec4(max(color, vec3(0.0)), clamp(alpha, 0.0, 1.0));

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

function colorFrom(value, fallback) {
  return new THREE.Color(value ?? fallback);
}

export function createOceanMaterial(cfg, seaLevel) {
  const baseColor = colorFrom(cfg.oceanColor, 0x0b2a45);
  const deepColor = colorFrom(cfg.oceanDeepColor, baseColor).multiplyScalar(0.48);
  const shallowColor = colorFrom(cfg.oceanShallowColor, baseColor)
    .lerp(new THREE.Color(0x2a8394), 0.42)
    .multiplyScalar(1.08);
  const atmoColor = colorFrom(cfg.atmoTint, 0x6aa8ff);

  const seed = (cfg.seed ?? 0) >>> 0;
  const seedUnit = (salt) => {
    let x = (seed ^ salt) >>> 0;
    x ^= x >>> 16;
    x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15;
    x = Math.imul(x, 0x846ca68b);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  };

  const waveAmp = cfg.waveAmp ?? 2.2;
  const vertexSway = cfg.oceanVertexSway ?? 1.0;
  // exp(sin(x)-1) is bounded in [e^-2, 1]. The centered 1.85x form in the
  // vertex shader stays within approximately one waveAmp in either direction.
  const maxDisplacement = Math.abs(waveAmp * vertexSway) * 1.05;

  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),

    uTime: { value: 0 },
    uWaveAmp: { value: waveAmp },
    uVertexSway: { value: vertexSway },
    uWaveFreq: { value: cfg.waveFreq ?? 0.012 },
    uWaveSpeed: { value: cfg.waveSpeed ?? 0.54 },
    uWaveChoppiness: { value: cfg.waveChoppiness ?? 0.92 },
    uWaveDrag: { value: cfg.oceanWaveDrag ?? 0.048 },
    uWaveIterations: { value: cfg.oceanWaveIterations ?? 14.0 },
    uVertexWaveIterations: {
      value: cfg.oceanVertexWaveIterations ?? 8.0,
    },
    uWaveOffset: {
      value: new THREE.Vector3(
        (seedUnit(0x68bc21eb) - 0.5) * 24000.0,
        (seedUnit(0x02e5be93) - 0.5) * 24000.0,
        (seedUnit(0x967a889b) - 0.5) * 24000.0,
      ),
    },
    uMurk: { value: cfg.oceanMurk ?? 0.58 },
    uRoughness: { value: cfg.oceanRoughness ?? 0.09 },
    uShallowDepth: {
      value: cfg.oceanShallowDepth ?? Math.max(8.0, (cfg.shoreWidth ?? 20) * 2.4),
    },
    uFoamDepth: {
      value: cfg.oceanFoamDepth ?? Math.max(2.2, (cfg.shoreWidth ?? 20) * 0.55),
    },
    uShallowOpacity: { value: cfg.oceanShallowOpacity ?? 0.54 },
    uDeepOpacity: { value: cfg.oceanDeepOpacity ?? 0.88 },
    uSeaLevel: { value: seaLevel },
    uCameraInsideOcean: { value: 0.0 },

    uDeepColor: { value: deepColor },
    uShallowColor: { value: shallowColor },
    uFoamColor: { value: colorFrom(cfg.oceanFoamColor, 0xd9f2f2) },
    uSkyHorizon: {
      value: atmoColor.clone().lerp(new THREE.Color(0xd6efff), 0.42).multiplyScalar(0.68),
    },
    uSkyZenith: {
      value: atmoColor.clone().lerp(new THREE.Color(0x16345f), 0.58).multiplyScalar(0.48),
    },
    uSunColor: { value: new THREE.Color(0xffffff) },
    uSunIntensity: { value: 1.0 },

    uPlanetCenterW: { value: new THREE.Vector3() },
    uSunPosW: { value: new THREE.Vector3() },
    uSunRadius: { value: cfg.sunRadius ?? 1350.0 },
    uWorldNormalMatrix: { value: new THREE.Matrix3() },

    uOccCount: { value: 0 },
    uOccCenters: { value: new Float32Array(OCEAN_MAX_OCCLUDERS * 3) },
    uOccRadii: { value: new Float32Array(OCEAN_MAX_OCCLUDERS) },
    uEclipseSoftness: { value: cfg.oceanEclipseSoftness ?? 0.015 },
    uEclipseStrength: { value: cfg.oceanEclipseStrength ?? 1.0 },
    uEclipseSpecularPower: {
      value: cfg.oceanEclipseSpecularPower ?? 4.0,
    },
  };

  const material = new THREE.ShaderMaterial({
    name: "PlanetOceanMaterial",
    uniforms,
    vertexShader: OCEAN_VERTEX_SHADER,
    fragmentShader: OCEAN_FRAGMENT_SHADER,
    transparent: true,
    depthTest: true,
    depthWrite: true,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    fog: true,
    toneMapped: true,
  });

  // Transparent DoubleSide materials are otherwise rendered as two separate
  // back/front passes by recent Three.js releases. A spherical ocean only needs
  // culling disabled; one pass is sufficient and avoids doubling every water
  // draw call.
  material.forceSinglePass = true;

  // Compatibility/debug handles used elsewhere in the game.
  material.color = baseColor;
  material.userData.shader = { uniforms };
  material.userData.seaLevel = seaLevel;
  material.userData.maxVertexDisplacement = maxDisplacement;

  return {
    material,
    uniforms,
    color: baseColor,
    maxDisplacement,
  };
}
