/**
 * Secret Solar System level builder.
 * Kept isolated so you can tune it without touching the procedural generator.
 *
 * Usage:
 *   buildSolarSecretSystem(env, baseSeed)
 *
 * env must provide:
 *   - constants: NMS_ORBIT_SCALE, NMS_RADIUS_SCALE
 *   - references: sun, galaxyPlayer, bodies, scene, sunLight
 *   - fns: addPlanet, addGasGiant, rebuildPlanetRingsFromBodies,
 *          rebuildAsteroidBelt, addMoonForPlanet,
 *          clearSPLMaterialRegistry, registerSPLMaterialsIn,
 *          startSecretMusic,
 *          setSolarSecretActive(bool),
 *          setCurrentSystemSeed(u32),
 *          setAsteroidBeltSpec(spec)
 */
export function buildSolarSecretSystem(env, baseSeed) {
  const {
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
    setSolarSecretActive,
    setCurrentSystemSeed,
    setAsteroidBeltSpec,
  } = env;

  setSolarSecretActive(true);
  startSecretMusic?.();

  const currentSystemSeed = ((baseSeed ?? 101010) >>> 0);
  setCurrentSystemSeed(currentSystemSeed);

  // Stable "Sun" appearance (less random than procedural systems)
  try {
    sun.material.color.setHex(0xffcc66);
    sun.material.emissive.setHex(0xffaa33);
    sun.material.emissiveIntensity = 2.8;
  } catch {}

  // Update galaxy marker
  try { galaxyPlayer.name = "SOLAR"; } catch {}

  // Planet orbits (AU-ish anchors, then multiplied by NMS orbit scale).
  const ORBITS = {
    mercury: 4000,
    venus: 6000,
    earth: 8500, // used for belt
    mars: 11500,
    jupiter: 17500,
    saturn: 23500,
    uranus: 28500,
    neptune: 33000,
  };

  // Secret-level distance multiplier (tune here).
  const SOLAR_DISTANCE_MUL = 2.0;

  const SOLAR_ORBIT_SCALE = NMS_ORBIT_SCALE * SOLAR_DISTANCE_MUL;

  // Helper for rocky planets
  const addRocky = (cfg) => {
    const seed = (cfg.seed >>> 0);
    addPlanet({
      name: cfg.name,
      seed,
      baseRadius: cfg.baseRadius,
      heightAmp: cfg.heightAmp,
      heightFreq: cfg.heightFreq,
      color: cfg.color,
      oceanColor: cfg.oceanColor ?? cfg.color,
      oceanMurk: cfg.oceanMurk ?? 0.62,
      waveAmp: 2.8,
      waveFreq: 0.013,
      waveSpeed: 0.62,
      seaLevelOffset: cfg.hasOcean ? 0 : -1e9,
      seabedDepth: (cfg.heightAmp ?? 120) * 0.2,
      shoreWidth: 24 * NMS_RADIUS_SCALE,
      snowHeight: (cfg.heightAmp ?? 120) * 0.62,
      snowLat: 0.52,
      deepWater: 0x061a2a,
      shallowWater: 0x1f5568,
      sand: cfg.sand ?? 0xd9c38a,
      grass: cfg.grass ?? 0x2f6b34,
      rock: cfg.rock ?? 0x666666,
      snow: 0xf7fbff,
      orbitDist: cfg.orbitDist,
      orbitSpeed: cfg.orbitSpeed,
      patchGridN: 10,
      maxLevel: 8,
      splitBudgetPerFrame: 6,
      mergeBudgetPerFrame: 6,
      baseSplitFactor: 9.2,
      baseMergeFactor: 14.2,
      farDetail: 2,
      activeDist: cfg.baseRadius * 26.0,
      lodDist: cfg.baseRadius * 18.0,
      nodeCullFactor: 2.2,
      hasOcean: !!cfg.hasOcean,
      hasAtmo: !!cfg.hasAtmo,
      atmoTint: cfg.atmoTint ?? 0x88aaff,
      cloudTint: cfg.cloudTint ?? 0xffffff,
      ringSpec: cfg.ringSpec ?? null,
    });
  };

  // Earth-belt spec replaces the procedural belt for this preset.
  function computeEarthBeltSpec(systemSeed) {
    const seed = ((systemSeed ?? 101010) >>> 0);
    // 1 AU anchor in this game's stylized scale.
    const earthOrbit = ORBITS.earth * NMS_ORBIT_SCALE * SOLAR_DISTANCE_MUL;
    const width = 1200 * NMS_ORBIT_SCALE * SOLAR_DISTANCE_MUL;
    const innerRadius = Math.max(5000, earthOrbit - width * 0.5);
    const outerRadius = earthOrbit + width * 0.5;
    const thickness = 220 + (((seed >>> 21) & 255) / 255) * 180;
    const tilt = 0.03; // near-ecliptic
    const baseColor = 0x6a6a6a;
    return {
      seed,
      innerRadius,
      outerRadius,
      thickness,
      tilt,
      baseColor,
      maxVisibleDist: 52000 * NMS_ORBIT_SCALE * SOLAR_DISTANCE_MUL,
    };
  }

  // Seeds for determinism
  const S = {
    mercury: (currentSystemSeed ^ 0x1001) >>> 0,
    venus: (currentSystemSeed ^ 0x2002) >>> 0,
    mars: (currentSystemSeed ^ 0x3003) >>> 0,
    jupiter: (currentSystemSeed ^ 0x4004) >>> 0,
    saturn: (currentSystemSeed ^ 0x5005) >>> 0,
    uranus: (currentSystemSeed ^ 0x6006) >>> 0,
    neptune: (currentSystemSeed ^ 0x7007) >>> 0,
  };

  // Mercury (no ocean, no atmo)
  addRocky({
    name: "MERCURY",
    seed: S.mercury,
    baseRadius: 850 * NMS_RADIUS_SCALE,
    heightAmp: 150 * NMS_RADIUS_SCALE,
    heightFreq: 2.3,
    color: 0x7e7a74,
    hasOcean: false,
    hasAtmo: false,
    grass: 0x6a6a6a,
    sand: 0x7a7a7a,
    rock: 0x5a5a5a,
    orbitDist: ORBITS.mercury * SOLAR_ORBIT_SCALE,
    orbitSpeed: 0.0065,
  });

  // Venus (thick atmo vibe, no ocean)
  addRocky({
    name: "VENUS",
    seed: S.venus,
    baseRadius: 1200 * NMS_RADIUS_SCALE,
    heightAmp: 170 * NMS_RADIUS_SCALE,
    heightFreq: 1.9,
    color: 0xbfae7d,
    hasOcean: false,
    hasAtmo: true,
    atmoTint: 0xe0c98a,
    cloudTint: 0xfff2cf,
    grass: 0x7a6f5a,
    sand: 0xbfae7d,
    rock: 0x7d7668,
    orbitDist: ORBITS.venus * SOLAR_ORBIT_SCALE,
    orbitSpeed: 0.0050,
  });

  // (Earth + Moon replaced by an asteroid belt at ~1 AU)

  // Mars (thin atmo vibe, no ocean)
  addRocky({
    name: "MARS",
    seed: S.mars,
    baseRadius: 1050 * NMS_RADIUS_SCALE,
    heightAmp: 160 * NMS_RADIUS_SCALE,
    heightFreq: 2.05,
    color: 0x9b5b3a,
    hasOcean: false,
    hasAtmo: true,
    atmoTint: 0xc07a63,
    cloudTint: 0xf2d7cf,
    grass: 0x7a4b3a,
    sand: 0x9b5b3a,
    rock: 0x6a4b3a,
    orbitDist: ORBITS.mars * SOLAR_ORBIT_SCALE,
    orbitSpeed: 0.0040,
  });

  // Gas giants
  addGasGiant({
    type: "gasGiant",
    name: "JUPITER",
    seed: S.jupiter,
    baseRadius: 4400 * NMS_RADIUS_SCALE,
    orbitDist: ORBITS.jupiter * SOLAR_ORBIT_SCALE,
    orbitSpeed: 0.0024,
    patchGridN: 0,
    maxLevel: 0,
    splitBudgetPerFrame: 0,
    mergeBudgetPerFrame: 0,
    farDetail: 0,
    activeDist: 4400 * NMS_RADIUS_SCALE * 34.0,
    lodDist: 4400 * NMS_RADIUS_SCALE * 26.0,
    nodeCullFactor: 0.0,
    hasOcean: false,
    hasAtmo: true,
    hasClouds: false,
    atmoTint: 0xd8b089,
    cloudTint: 0xffffff,
    ringSpec: null,
  });

  // Saturn with rings
  const saturnRingSpec = {
    innerMul: 1.75,
    outerMul: 3.35,
    thickness: 140 * NMS_RADIUS_SCALE,
    yaw: 0.0,
    tilt: 0.08,
    roll: 0.0,
    baseColor: 0xbdb8aa,
  };
  addGasGiant({
    type: "gasGiant",
    name: "SATURN",
    seed: S.saturn,
    baseRadius: 3800 * NMS_RADIUS_SCALE,
    orbitDist: ORBITS.saturn * SOLAR_ORBIT_SCALE,
    orbitSpeed: 0.0019,
    patchGridN: 0,
    maxLevel: 0,
    splitBudgetPerFrame: 0,
    mergeBudgetPerFrame: 0,
    farDetail: 0,
    activeDist: 3800 * NMS_RADIUS_SCALE * 34.0,
    lodDist: 3800 * NMS_RADIUS_SCALE * 26.0,
    nodeCullFactor: 0.0,
    hasOcean: false,
    hasAtmo: true,
    hasClouds: false,
    atmoTint: 0xe6d8b6,
    cloudTint: 0xffffff,
    ringSpec: saturnRingSpec,
  });

  addGasGiant({
    type: "gasGiant",
    name: "URANUS",
    seed: S.uranus,
    baseRadius: 2900 * NMS_RADIUS_SCALE,
    orbitDist: ORBITS.uranus * SOLAR_ORBIT_SCALE,
    orbitSpeed: 0.0015,
    patchGridN: 0,
    maxLevel: 0,
    splitBudgetPerFrame: 0,
    mergeBudgetPerFrame: 0,
    farDetail: 0,
    activeDist: 2900 * NMS_RADIUS_SCALE * 34.0,
    lodDist: 2900 * NMS_RADIUS_SCALE * 26.0,
    nodeCullFactor: 0.0,
    hasOcean: false,
    hasAtmo: true,
    hasClouds: false,
    atmoTint: 0x9ad8db,
    cloudTint: 0xffffff,
    ringSpec: null,
  });

  addGasGiant({
    type: "gasGiant",
    name: "NEPTUNE",
    seed: S.neptune,
    baseRadius: 3000 * NMS_RADIUS_SCALE,
    orbitDist: ORBITS.neptune * SOLAR_ORBIT_SCALE,
    orbitSpeed: 0.0013,
    patchGridN: 0,
    maxLevel: 0,
    splitBudgetPerFrame: 0,
    mergeBudgetPerFrame: 0,
    farDetail: 0,
    activeDist: 3000 * NMS_RADIUS_SCALE * 34.0,
    lodDist: 3000 * NMS_RADIUS_SCALE * 26.0,
    nodeCullFactor: 0.0,
    hasOcean: false,
    hasAtmo: true,
    hasClouds: false,
    atmoTint: 0x5e8fe6,
    cloudTint: 0xffffff,
    ringSpec: null,
  });

  // Planet rings (only Saturn is guaranteed here, but the system supports more)
  rebuildPlanetRingsFromBodies();

  // Earth-belt replaces the main belt for this preset
  setAsteroidBeltSpec(computeEarthBeltSpec(currentSystemSeed));
  rebuildAsteroidBelt({ seed: currentSystemSeed, buildNow: true });

  // Moons (minimal, more "solar"-like; no moons for Mercury/Venus)
  const nameToIndex = new Map();
  for (let i = 0; i < bodies.length; i++) {
    const n = bodies[i]?.cfg?.name;
    if (typeof n === "string") nameToIndex.set(n.toUpperCase(), i);
  }

  const marsI = nameToIndex.get("MARS");
  if (typeof marsI === "number") {
    addMoonForPlanet(marsI, {
      name: "PHOBOS",
      radius: bodies[marsI].cfg.baseRadius * 0.12,
      orbitDist: bodies[marsI].cfg.baseRadius * 3.0 + 260,
      orbitSpeed: 0.22 / (bodies[marsI].cfg.baseRadius * 3.0 + 260),
      color: 0x8a847d,
      phase: 0.2,
    });
    addMoonForPlanet(marsI, {
      name: "DEIMOS",
      radius: bodies[marsI].cfg.baseRadius * 0.09,
      orbitDist: bodies[marsI].cfg.baseRadius * 4.2 + 320,
      orbitSpeed: 0.16 / (bodies[marsI].cfg.baseRadius * 4.2 + 320),
      color: 0x7d776f,
      phase: 3.4,
    });
  }

  const jupI = nameToIndex.get("JUPITER");
  if (typeof jupI === "number") {
    const R = bodies[jupI].cfg.baseRadius;
    const moonsCfg = [
      { name: "IO", r: 0.095, od: 2.9, col: 0xd8b55a, ph: 0.2 },
      { name: "EUROPA", r: 0.088, od: 3.5, col: 0xcfcfcf, ph: 1.4 },
      { name: "GANYMEDE", r: 0.12, od: 4.2, col: 0x9a8f86, ph: 2.7 },
      { name: "CALLISTO", r: 0.11, od: 5.0, col: 0x6f6a63, ph: 4.1 },
    ];
    for (const mc of moonsCfg) {
      const od = R * mc.od + 520;
      addMoonForPlanet(jupI, {
        name: mc.name,
        radius: R * mc.r,
        orbitDist: od,
        orbitSpeed: (0.26 / od),
        color: mc.col,
        phase: mc.ph,
      });
    }
  }

  const satI = nameToIndex.get("SATURN");
  if (typeof satI === "number") {
    const R = bodies[satI].cfg.baseRadius;
    const od = R * 4.0 + 600;
    addMoonForPlanet(satI, {
      name: "TITAN",
      radius: R * 0.12,
      orbitDist: od,
      orbitSpeed: 0.20 / od,
      color: 0xd3b36b,
      phase: 1.1,
    });
  }

  const uraI = nameToIndex.get("URANUS");
  if (typeof uraI === "number") {
    const R = bodies[uraI].cfg.baseRadius;
    addMoonForPlanet(uraI, {
      name: "TITANIA",
      radius: R * 0.095,
      orbitDist: R * 3.4 + 520,
      orbitSpeed: 0.18 / (R * 3.4 + 520),
      color: 0x9a9a9a,
      phase: 2.0,
    });
    addMoonForPlanet(uraI, {
      name: "OBERON",
      radius: R * 0.09,
      orbitDist: R * 4.2 + 560,
      orbitSpeed: 0.15 / (R * 4.2 + 560),
      color: 0x848484,
      phase: 4.3,
    });
  }

  const nepI = nameToIndex.get("NEPTUNE");
  if (typeof nepI === "number") {
    const R = bodies[nepI].cfg.baseRadius;
    const od = R * 3.6 + 560;
    addMoonForPlanet(nepI, {
      name: "TRITON",
      radius: R * 0.11,
      orbitDist: od,
      orbitSpeed: 0.19 / od,
      color: 0xbdbdbd,
      phase: 3.0,
    });
  }

  // Patch lit materials so the PointLight doesn't double-light inside the sun spot cone
  clearSPLMaterialRegistry?.();
  registerSPLMaterialsIn?.(scene, sunLight, { skipRoot: sun });
}
