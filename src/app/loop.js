import { THREE } from "../render/device.js";
import { createMainLoop } from "../render/renderer.js";
import { resizeWarpOverlay } from "../render/shaders.js";
import { renderWarpOverlay } from "../game/warp.js";
import { updateSuperPointLightMask, splMaskedMaterials } from "../game/spl.js";
import { createHudUpdater } from "../ui/hud.js";
import { updateGasGiant } from "../game/gasGiantMaterial.js";


export function startGameLoop(world, playerCtrl) {
  const renderer = world.renderer;
  const scene = world.scene;
  const camera = world.camera;
  const bodies = world.bodies;
  const moons = world.moons ?? [];
  const sky = world.sky;
  const sun = world.sun;

  const {
    copyScene,
    copyMat,
    atmoCopyScene,
    atmoCopyMat,
    atmoScene,
    ringDustPass,
    godRayScene,
    godRayMat,
    postScene,
    tintMat,
    particlesMat,
    occluderCenters,
    occluderRadii,
  } = world;

  // Fullscreen/post scenes render through an ortho camera.
  // (This used to be a local in the old monolithic main.js.)
  const screenCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const _tmpFogColor = new THREE.Color();

  const input = playerCtrl.input;
  const keys = playerCtrl.keys;
  const player = playerCtrl.player;
  const tmp = playerCtrl.tmp;
  const warpCtrl = playerCtrl.warpCtrl;
  const warpOverlay = playerCtrl.warpOverlay;
  const playerShip = playerCtrl.playerShip;

  // Reusable helper object for building eclipse occluder lists for ring dust.
  // (fillOccludersForBody expects a pass-like object with mat.uniforms + body)
  const _dustOccPass = {
    body: null,
    mat: {
      uniforms: {
        uPlanetCenterW: { value: new THREE.Vector3() },
        uSunPosW: { value: new THREE.Vector3() },
      },
    },
  };

  const _ringCenterW = new THREE.Vector3();
  const _ringInv = new THREE.Matrix4();
  const _camPosL = new THREE.Vector3();

  // Render targets / passes can be rebuilt on resize or dynamic scaling.
  let rt = world.rt;
  let atmoRT = world.atmoRT;
  let cloudRT = world.cloudRT;
  let atmoPasses = world.atmoPasses;

  // Local accumulators (used only by the loop).
  let _shadowAccum = 0.0;
  let _splMaskAccum = 0.0;

  // FPS UI: show true rAF frame pacing (not the clamped sim dt)
  let _fpsLastNow = performance.now();
  let _fpsMin = Infinity;
  let _fpsUiNext = 0;

  // Number of nearest planets that get full patch LOD (matches original index.html behavior)
  const LOD_NEAREST_K = 1;

  // Layers
  // Player ship is rendered on its own layer so it can be drawn on top of fullscreen effects (warp overlay).
  const PLAYER_SHIP_LAYER = world.PLAYER_SHIP_LAYER ?? 1;

  // HUD (throttled + diffed)
  // world.msg is the #msg element created in world.js
  const hud = createHudUpdater({ msgEl: world.msg, intervalMs: 200 });

            const mainLoop = createMainLoop({
                fpsCap: 60,
                maxDt: 0.033,
                step: (dt, t, now) => {
                    // refresh handles that may be rebuilt by quality/resize
                    rt = world.rt;
                    atmoRT = world.atmoRT;
                    cloudRT = world.cloudRT;
                    atmoPasses = world.atmoPasses;

                    // Update FPS display from real frame pacing (independent of clamped sim dt)
                    const frameMs = Math.max(1, now - _fpsLastNow);
                    _fpsLastNow = now;
                    const fpsInst = 1000 / frameMs;
                    _fpsMin = Math.min(_fpsMin, fpsInst);
                    if (world.fpsEl && now >= _fpsUiNext) {
                        const minFps = Number.isFinite(_fpsMin) ? _fpsMin : fpsInst;
                        world.fpsEl.textContent = `FPS: ${fpsInst.toFixed(1)} (min ${minFps.toFixed(1)})`;
                        _fpsMin = Infinity;
                        _fpsUiNext = now + 250;
                    }


                // Poll gamepad once per frame (adds right-stick look into the existing mouse-delta path).
                input.update?.(dt);

                // Gamepad one-shot actions (mapped to existing gameplay functions).
                const gp = input.gamepad;
                if (gp?.active) {
                    // Start: toggle galaxy map (disabled during warp).
                    if (gp.pressed?.start && !warpCtrl?.warp?.active) {
                        if (playerCtrl.isGalaxyOpen()) playerCtrl.galaxyOverlayUI?.close?.();
                        else playerCtrl.galaxyOverlayUI?.open?.();
                    }

                    // Back: respawn
                    if (gp.pressed?.back) playerCtrl.respawn();

                    // B: noclip toggle
                    if (gp.pressed?.b) playerCtrl.toggleNoclip();

                    // Y: context action (takeoff in walk, land in fly)
                    if (gp.pressed?.y && !playerCtrl.isGalaxyOpen() && !warpCtrl?.isMovementLocked?.()) {
                        if (player.mode === "walk") playerCtrl.doTakeoff();
                        else if (player.mode === "fly") playerCtrl.doLand();
                    }
                }

                // Prevent large right-stick look accumulation while input is intentionally ignored.
                if (playerCtrl.isGalaxyOpen() || warpCtrl?.isMovementLocked?.()) {
                    input.resetMouse?.();
                }

                world.terrainPool?.pumpCompleted();

                // Terrain meshes are applied here from worker results.

                // Warp sequencing
                warpCtrl.update(dt, t);

                // While warping, dispose + rebuild the star system incrementally so the
                // warp tunnel never freezes.
                world.tickSystemTransition();

                sky.position.copy(camera.position);
                sky.material.uniforms.uTime.value = t;

                for (const b of bodies) b.beginFrameCapture();
                for (const b of bodies) b.updateOrbit(dt);

                // Sun position for everything
                sun.getWorldPosition(tmp.sunPosW);
                for (const b of bodies) b.endFrameCapture();

                if (!playerCtrl.isGalaxyOpen() && !warpCtrl.isMovementLocked()) {
                    if (player.mode === "walk") playerCtrl.updateWalk(dt);
                    else playerCtrl.updateFly(dt);
                }

                // If we left fly mode, fade out the engine hum (but never interrupt warp audio).
                if (player.mode !== "fly" && !warpCtrl?.warp?.active) {
                    playerCtrl.stopFlyEngineAudio();
                }
                // Update sun SpotLight aiming
                tmp.sunAimW.copy(player?.worldPos ?? camera.position);
                world.updateSunSuperPointLight(tmp.sunPosW, tmp.sunAimW, dt, tmp);
                _splMaskAccum += dt;
                if (_splMaskAccum >= world.SPL_MASK_INTERVAL) {
                    _splMaskAccum = 0.0;
                    updateSuperPointLightMask(splMaskedMaterials, world.sunLight);
                }

                // ocean shader uniforms
                for (const b of bodies) {
                    const sh = b.ocean?.material?.userData?.shader;
                    if (!sh) continue;
                    sh.uniforms.uTime.value = t;
                    const centerW = b.group.getWorldPosition(
                        tmp.vA.set(0, 0, 0),
                    );
                    sh.uniforms.uPlanetCenterW.value.copy(centerW);
                    sh.uniforms.uSunPosW.value.copy(tmp.sunPosW);

                    // Feed eclipse occluders to oceans (per-body buffers)
                    if (
                        sh.uniforms.uOccCount &&
                        b._oceanOccCenters &&
                        b._oceanOccRadii
                    ) {
                        const nOcc = world.fillOccludersForBody(
                            { body: b, mat: { uniforms: sh.uniforms } },
                            b._oceanOccCenters,
                            b._oceanOccRadii,
                            tmp,
                        );
                        sh.uniforms.uOccCount.value = nOcc;
                        sh.uniforms.uOccCenters.value = b._oceanOccCenters;
                        sh.uniforms.uOccRadii.value = b._oceanOccRadii;
                    }
                }

                // gas giant shader uniforms (time/camera + eclipse occluders)
                for (const b of bodies) {
                    if (!b?.isGasGiant || !b.uniforms) continue;

                    updateGasGiant(b.uniforms, camera, t);

                    const centerW = b.group.getWorldPosition(
                        tmp.vA.set(0, 0, 0),
                    );
                    b.uniforms.uPlanetCenterW.value.copy(centerW);
                    b.uniforms.uSunPosW.value.copy(tmp.sunPosW);

                    // Feed star direction + tint into the shader (matches the example's naming)
                    const sunDir = tmp.vB
                        .copy(tmp.sunPosW)
                        .sub(centerW)
                        .normalize();
                    b.uniforms.pos_star.value.copy(sunDir);
                    const sc = sun.material?.color;
                    if (sc) b.uniforms.col_star.value.set(sc.r, sc.g, sc.b);

                    if (b._gasOccCenters && b._gasOccRadii) {
                        const nOcc = world.fillOccludersForBody(
                            { body: b, mat: { uniforms: b.uniforms } },
                            b._gasOccCenters,
                            b._gasOccRadii,
                            tmp,
                        );
                        b.uniforms.uOccCount.value = nOcc;
                        b.uniforms.uOccCenters.value = b._gasOccCenters;
                        b.uniforms.uOccRadii.value = b._gasOccRadii;
                    }
                }

                // LOD selection + culling
                // Use the player position as the focus for distance-based LOD so patches
                // generate around the player (camera may be offset/rotating in walk mode).
                const camPos = camera.position;
                const focusPos = player?.worldPos ?? camPos;

                // Asteroid belt: cheap per-batch distance culling (instanced meshes)
                world.asteroidBelt?.update?.(focusPos, t);
                // Planet rings (mini belts) - distance culled per-ring.
                const rings = world.planetRings;
                if (rings && rings.length) {
                    for (let i = 0; i < rings.length; i++) {
                        rings[i]?.update?.(focusPos, t);
                    }
                }

                const order = bodies
                    .map((b, i) => {
                        const c = b.group.getWorldPosition(tmp.vB.set(0, 0, 0));
                        return { b, i, d: c.distanceTo(focusPos) };
                    })
                    .sort((a, b) => a.d - b.d);

                for (let idx = 0; idx < order.length; idx++) {
                    const b = order[idx].b;
                    const d = order[idx].d;

                    if (d > b.activeDist) {
                        b.setTerrainActive(false);
                        continue;
                    }
                    b.setTerrainActive(true);

                    if (idx >= LOD_NEAREST_K || d > b.lodDist) {
                        b.forceRootsOnly();
                        continue;
                    }
                    b.updateLOD(focusPos, camera);
                }

                // Underwater detection (uses sunPosW now)
                let underwater = false;
                let depth01 = 0.0;

                tintMat.uniforms.uOpacity.value = 0.0;
                particlesMat.uniforms.uOpacity.value = 0.0;

                const nearCam = playerCtrl.nearestBodyInfo(camera.position);

                if (nearCam.i >= 0) {
                    const b = bodies[nearCam.i];
                    const center = b.group.getWorldPosition(
                        tmp.vA.set(0, 0, 0),
                    );
                    const dist = camera.position.distanceTo(center);

                    if (b.ocean && dist < b.seaLevel) {
                        underwater = true;

                        const depth = b.seaLevel - dist;
                        const UNDERWATER_VIS_RANGE = 20.0;
                        depth01 = THREE.MathUtils.clamp(
                            depth / UNDERWATER_VIS_RANGE,
                            0,
                            1,
                        );

                        const upP = tmp.vB
                            .copy(camera.position)
                            .sub(center)
                            .normalize();
                        const sunDir = tmp.vC
                            .copy(tmp.sunPosW)
                            .sub(center)
                            .normalize();
                        // True sun-facing term (-1..1). Use this to gate eclipse effects to the day hemisphere.
                        const ndl = upP.dot(sunDir);
                        const day = THREE.MathUtils.clamp(
                            ndl * 0.5 + 0.5,
                            0,
                            1,
                        );

                        const NIGHT_DARKEN = 3.2;
                        const MIN_LIGHT = 0.02;
                        let nightMask = THREE.MathUtils.lerp(
                            MIN_LIGHT,
                            1.0,
                            Math.pow(day, NIGHT_DARKEN),
                        );

                        // Eclipse dim (matches atmosphere behavior)
                        const vis = world.sunVisibilityCPU(
                            camera.position,
                            tmp.sunPosW,
                            b,
                            tmp,
                            0.015,
                            1.0,
                        );
                        const eclipseDim = THREE.MathUtils.lerp(
                            1.0,
                            0.45,
                            1.0 - vis,
                        );

                        // Only let eclipses affect the sun-facing hemisphere.
                        // Otherwise they incorrectly darken the "night" minimum light.
                        // Gate by N·L so eclipses never darken the night hemisphere.
                        const daySide = THREE.MathUtils.smoothstep(ndl, 0.0, 0.25);
                        const eclipseDimDay = THREE.MathUtils.lerp(1.0, eclipseDim, daySide);

                        nightMask *= eclipseDimDay;
                        const dayE = THREE.MathUtils.clamp(day * eclipseDimDay, 0, 1);

                        const oceanCol = b.ocean.material.color;

                        scene.fog.color
                            .copy(oceanCol)
                            .multiplyScalar(0.45 * nightMask);
                        scene.fog.density =
                            (0.05 + depth01 * 0.02) *
                            (0.85 + 0.35 * (1.0 - dayE));

                        tintMat.uniforms.uColor.value
                            .copy(oceanCol)
                            .multiplyScalar(0.35 * nightMask);
                        tintMat.uniforms.uOpacity.value =
                            (0.16 + depth01 * 0.28) *
                            (0.7 + 0.3 * (1.0 - dayE));

                        const pulse = 0.5 + 0.5 * Math.sin(t * 1.4);
                        particlesMat.uniforms.uColor.value
                            .copy(oceanCol)
                            .multiplyScalar(0.28 * nightMask);
                        particlesMat.uniforms.uOpacity.value =
                            (0.05 + depth01 * 0.22) *
                            (0.7 + 0.3 * pulse) *
                            (0.75 + 0.25 * (1.0 - dayE));
                    }
                }

                // Gas giant atmosphere: ramp fog as you descend (thick, hard to see).
                let inGasAtmo = false;
                if (!underwater && nearCam.i >= 0) {
                    const b = bodies[nearCam.i];
                    if (b?.isGasGiant) {
                        const center = b.group.getWorldPosition(tmp.vA.set(0, 0, 0));
                        const dist = camera.position.distanceTo(center);
                        const baseR = b.cfg?.baseRadius ?? b.baseRadius ?? 3200;
                        const atmoH = baseR * 0.33;
                        const atmoR = baseR + atmoH;

                        if (dist < atmoR) {
                            inGasAtmo = true;
                            const tIn = THREE.MathUtils.clamp(
                                (atmoR - dist) / Math.max(1e-6, atmoH),
                                0,
                                1,
                            );
                            const tFog = tIn * tIn * (3.0 - 2.0 * tIn);

                            // Day/night + eclipse gating (mirrors underwater logic)
                            const upP = tmp.vB
                                .copy(camera.position)
                                .sub(center)
                                .normalize();
                            const sunDir = tmp.vC
                                .copy(tmp.sunPosW)
                                .sub(center)
                                .normalize();
                            const ndl = upP.dot(sunDir);
                            const day = THREE.MathUtils.clamp(
                                ndl * 0.5 + 0.5,
                                0,
                                1,
                            );
                            const NIGHT_DARKEN = 3.2;
                            const MIN_LIGHT = 0.02;
                            let nightMask = THREE.MathUtils.lerp(
                                MIN_LIGHT,
                                1.0,
                                Math.pow(day, NIGHT_DARKEN),
                            );
                            const vis = world.sunVisibilityCPU(
                                camera.position,
                                tmp.sunPosW,
                                b,
                                tmp,
                                0.015,
                                1.0,
                            );
                            const eclipseDim = THREE.MathUtils.lerp(
                                1.0,
                                0.45,
                                1.0 - vis,
                            );
                            const daySide = THREE.MathUtils.smoothstep(ndl, 0.0, 0.25);
                            const eclipseDimDay = THREE.MathUtils.lerp(1.0, eclipseDim, daySide);
                            nightMask *= eclipseDimDay;

                            _tmpFogColor.setHex(b.cfg?.atmoTint ?? 0x6aa8ff);
                            scene.fog.color
                                .copy(_tmpFogColor)
                                .multiplyScalar(0.55 * nightMask);

                            // Dense Exp2 fog: by the time you reach the sphere, visibility is extremely low.
                            const maxDens = 0.22;
                            scene.fog.density = THREE.MathUtils.lerp(
                                0.000012,
                                maxDens,
                                tFog,
                            );
                        }
                    }
                }

                if (!underwater && !inGasAtmo) {
                    scene.fog.color.set(0x000000);
                    scene.fog.density = 0.000012;
                }

                camera.updateMatrixWorld(true);

                // Sun glow distance scaling
                {
                    const d = camera.position.distanceTo(tmp.sunPosW);

                    const base = world.SUN_RADIUS * 8.0;
                    const extra = THREE.MathUtils.clamp(
                        d * 0.035,
                        0,
                        world.SUN_RADIUS * 30.0,
                    );

                    world.sunGlow.scale.setScalar(base + extra);

                    world.sunGlow.material.opacity = THREE.MathUtils.clamp(
                        1.15 - d * 0.0000015,
                        0.45,
                        1.15,
                    );
                }

                // ============================================================
                // Update planet ring dust (clouds-tech mesh shader)
                // - feeds time, blue-noise, and eclipse occluders each frame
                // ============================================================
                {
                    const bnTex = world.getBlueNoiseTex
                        ? world.getBlueNoiseTex()
                        : world.blueNoiseTex;
                    const bnW = bnTex?.image?.width ?? 256;
                    const bnH = bnTex?.image?.height ?? 256;

                    const rings = world.planetRings ?? [];
                    for (let ri = 0; ri < rings.length; ri++) {
                        const r = rings[ri];
                        if (!r || !r.dustMats || !r.dustMats.length) continue;

                        // Camera position in ring-dust local space (needed for volumetric integration).
                        // We use the dust mesh's world matrix so the shader raymarch aligns with
                        // the squished torus volume regardless of planet motion/tilt.
                        let hasCamL = false;
                        if (r.dustMesh && r.dustMesh.matrixWorld) {
                            _ringInv.copy(r.dustMesh.matrixWorld).invert();
                            _camPosL.copy(camera.position).applyMatrix4(_ringInv);
                            hasCamL = true;
                        }

                        // Need the owning body to build the eclipse occluder list.
                        const owner = r.body;
                        if (!owner || !owner.group?.getWorldPosition) continue;
                        owner.group.getWorldPosition(_ringCenterW);

                        // Fill the ring's per-material occluder buffers.
                        _dustOccPass.body = owner;
                        _dustOccPass.mat.uniforms.uPlanetCenterW.value.copy(_ringCenterW);
                        _dustOccPass.mat.uniforms.uSunPosW.value.copy(tmp.sunPosW);

                        const nOcc = world.fillOccludersForBody(
                            _dustOccPass,
                            r.dustOccCenters,
                            r.dustOccRadii,
                            tmp,
                        );

                        // Push common uniforms to all dust layers.
                        for (let mi = 0; mi < r.dustMats.length; mi++) {
                            const m = r.dustMats[mi];
                            if (!m?.uniforms) continue;
                            m.uniforms.uTime.value = t;
                            m.uniforms.uBlueNoiseTex.value = bnTex;
                            m.uniforms.uBlueNoiseSize.value.set(bnW, bnH);
                            m.uniforms.uSunPosW.value.copy(tmp.sunPosW);
                            m.uniforms.uOccCount.value = nOcc;
                            if (hasCamL && m.uniforms.uCamPosL) {
                                m.uniforms.uCamPosL.value.copy(_camPosL);
                            }
                            // centers/radii are already bound to r.dustOccCenters/r.dustOccRadii
                        }
                    }
                }

                // =======================
                // 1) Render scene into rt
                // =======================
                renderer.setRenderTarget(rt);
                renderer.setClearColor(0x000000, 1.0);
                renderer.clear(true, true, true);

                // Shadows
                // Throttle shadow-map renders to a stable cadence.
                // NOTE: Use a "remainder" accumulator (subtract interval) instead of
                // resetting to 0 to avoid jittery update spacing (which can read as flicker).
                const _shadowInterval = world.SHADOW_INTERVAL ?? 0.0;
                if (renderer.shadowMap.autoUpdate || _shadowInterval <= 0.0) {
                    _shadowAccum = 0.0;
                    renderer.shadowMap.needsUpdate = true;
                } else {
                    _shadowAccum += dt;
                    if (_shadowAccum >= _shadowInterval) {
                        _shadowAccum -= _shadowInterval;
                        renderer.shadowMap.needsUpdate = true;
                    } else {
                        renderer.shadowMap.needsUpdate = false;
                    }
                }
                renderer.render(scene, camera);

                // =======================
                // 2) Copy rt -> screen
                // =======================
                renderer.setRenderTarget(null);
                renderer.setClearColor(0x000000, 1.0);
                renderer.clear(true, true, true);
                renderer.clearDepth();

                copyMat.uniforms.tColor.value = rt.texture;
                renderer.render(copyScene, screenCam);

                // ============================================================
                // Atmosphere/Clouds into atmoRT + cloud mask into cloudRT
                // ============================================================
                const logDepthFC = 2.0 / Math.log2(camera.far + 1.0);

                renderer.setRenderTarget(atmoRT);
                renderer.setClearColor(0x000000, 0.0);
                renderer.clear(true, false, false);

                renderer.setRenderTarget(cloudRT);
                renderer.setClearColor(0x000000, 1.0);
                renderer.clear(true, false, false);

                const sorted = atmoPasses
                    .map((pass) => {
                        pass.body.group.getWorldPosition(pass._centerW);
                        const camD = camera.position.distanceTo(pass._centerW);
                        const cloudTopR =
                            pass.uniforms.uPlanetRadius.value +
                            pass.uniforms.uCloudBase.value +
                            pass.uniforms.uCloudThickness.value;
                        const nearApprox = camD - cloudTopR;
                        return {
                            pass,
                            centerW: pass._centerW,
                            nearApprox,
                            camD,
                        };
                    })
                    .sort((a, b) => b.nearApprox - a.nearApprox);

                let closestPass = null;
                let closestScore = Infinity;
                for (const it of sorted) {
                    const p = it.pass;
                    const baseR = p.uniforms.uPlanetRadius.value;
                    const cloudTopR =
                        baseR +
                        p.uniforms.uCloudBase.value +
                        p.uniforms.uCloudThickness.value;
                    const score = it.camD - cloudTopR;
                    if (score < closestScore) {
                        closestScore = score;
                        closestPass = p;
                    }
                }

                for (const p of atmoPasses) {
                    p.atmoMesh.visible = false;
                    p.maskMesh.visible = false;
                }

                // Render atmo passes back-to-front
                for (const item of sorted) {
                    const pass = item.pass;

                    // Skip full-screen atmo for tiny far planets (big GPU win)
                    const atmoR =
                        pass.uniforms.uPlanetRadius.value +
                        pass.uniforms.uAtmoHeight.value;
                    const pxR =
                        (atmoR / Math.max(1e-6, item.camD)) *
                        (innerHeight * 0.5) /
                        Math.tan(
                            THREE.MathUtils.degToRad(camera.fov * 0.5),
                        );
                    if (pass !== closestPass && pxR < 12.0) continue;

                    pass.uniforms.uPlanetCenterW.value.copy(item.centerW);
                    pass.uniforms.uSunPosW.value.copy(tmp.sunPosW);
                    pass.uniforms.uInvViewMatrix.value.copy(camera.matrixWorld);
                    pass.uniforms.uInvProjMatrix.value.copy(
                        camera.projectionMatrixInverse,
                    );

                    const nOcc = world.fillOccludersForBody(
                        pass,
                        occluderCenters,
                        occluderRadii,
                        tmp,
                    );
                    pass.uniforms.uOccCount.value = nOcc;
                    pass.uniforms.uOccCenters.value = occluderCenters;
                    pass.uniforms.uOccRadii.value = occluderRadii;

                    pass.uniforms.uDepthTex.value = rt.depthTexture;
                    pass.uniforms.uLogDepthFC.value = logDepthFC;
                    pass.uniforms.uTime.value = t;

                    const bnTex = world.getBlueNoiseTex
                        ? world.getBlueNoiseTex()
                        : world.blueNoiseTex;
                    pass.uniforms.uBlueNoiseTex.value = bnTex;
                    pass.uniforms.uBlueNoiseSize.value.set(
                        bnTex?.image?.width ?? 256,
                        bnTex?.image?.height ?? 256,
                    );

                    pass.uniforms.uUseCheapClouds.value =
                        pass === closestPass ? 0.0 : 1.0;

                    const far = THREE.MathUtils.clamp(
                        (item.nearApprox - 2500.0) / 14000.0,
                        0,
                        1,
                    );
                    pass.uniforms.uCheapCloudFarBoost.value =
                        pass === closestPass ? 0.0 : 0.25 + 1.35 * far;
                    pass.uniforms.uCheapCloudContrast.value =
                        pass === closestPass ? 1.0 : 1.15 + 0.85 * far;

                    renderer.setRenderTarget(atmoRT);
                    pass.atmoMesh.visible = true;
                    renderer.render(atmoScene, screenCam);
                    pass.atmoMesh.visible = false;
                }

                // ============================================================
                // Ring dust / stardust (atmosphere-style screen-space pass)
                // - Small rings: planetRings (mini asteroid belts)
                // - Big belt: main asteroid belt (uses the same stardust shader)
                // ============================================================
                const hasPlanetRings = !!(world.planetRings && world.planetRings.length);
                const hasAsteroidBelt = !!(world.asteroidBelt?.group && world.asteroidBelt.group.visible !== false);
                if (ringDustPass && (hasPlanetRings || hasAsteroidBelt)) {
                    const u = ringDustPass.uniforms;
                    // Camera/depth setup
                    u.uInvViewMatrix.value.copy(camera.matrixWorld);
                    u.uInvProjMatrix.value.copy(camera.projectionMatrixInverse);
                    u.uDepthTex.value = rt.depthTexture;
                    u.uLogDepthFC.value = logDepthFC;
                    u.uTime.value = t;
                    if (u.uSunPosW?.value) u.uSunPosW.value.copy(tmp.sunPosW);

                    const bnTex = world.getBlueNoiseTex
                        ? world.getBlueNoiseTex()
                        : world.blueNoiseTex;
                    u.uBlueNoiseTex.value = bnTex;
                    u.uBlueNoiseSize.value.set(
                        bnTex?.image?.width ?? 256,
                        bnTex?.image?.height ?? 256,
                    );

                    // Ring dust sliders: bake brightness into per-ring tint
                    const rdp = world.getRingDustParams ? world.getRingDustParams() : null;
                    const bright = Math.max(0.0, rdp?.brightness ?? 1.0);

                    // Fill ring arrays (cap to shader max)
                    let ringCount = 0;
                    const rings = world.planetRings || [];
                    for (let i = 0; i < rings.length && ringCount < 8; i++) {
                        const ring = rings[i];
                        if (!ring?.group) continue;
                        if (ring.group.visible === false) continue;

                        _ringInv.copy(ring.group.matrixWorld).invert();
                        u.uRingInvMatrix.value[ringCount].copy(_ringInv);

                        const p = ring.params || {};
                        u.uRingInner.value[ringCount] =
                            typeof p.innerRadius === "number" ? p.innerRadius : 1800.0;
                        u.uRingOuter.value[ringCount] =
                            typeof p.outerRadius === "number" ? p.outerRadius : 2600.0;
                        u.uRingHalfHeight.value[ringCount] =
                            typeof p.thickness === "number" ? p.thickness * 0.5 : 40.0;

                        // Color tint (matches asteroid ring color)
                        const c = tmp.colA || (tmp.colA = new THREE.Color());
                        c.setHex(p.baseColor ?? 0x777777);
                        const tv = u.uRingTint.value[ringCount];
                        tv.set(c.r * bright, c.g * bright, c.b * bright);

                        ringCount++;
                    }

                    // Add the main asteroid belt as another "ring" so it uses the same
                    // stardust shader + parameters as the small planet rings.
                    if (hasAsteroidBelt && ringCount < 8) {
                        const belt = world.asteroidBelt;
                        _ringInv.copy(belt.group.matrixWorld).invert();
                        u.uRingInvMatrix.value[ringCount].copy(_ringInv);

                        const p = belt.params || {};
                        u.uRingInner.value[ringCount] =
                            typeof p.innerRadius === "number" ? p.innerRadius : 12000.0;
                        u.uRingOuter.value[ringCount] =
                            typeof p.outerRadius === "number" ? p.outerRadius : 14000.0;
                        u.uRingHalfHeight.value[ringCount] =
                            typeof p.thickness === "number" ? p.thickness * 0.5 : 280.0;

                        // Belt dust tint: keep the old bluish-gray so it reads clearly.
                        const c = tmp.colA || (tmp.colA = new THREE.Color());
                        c.setHex(0x92a7bb);
                        const tv = u.uRingTint.value[ringCount];
                        tv.set(c.r * bright, c.g * bright, c.b * bright);

                        ringCount++;
                    }

                    u.uRingCount.value = ringCount;

                    // Occluders: include all bodies (planets + moons) so rings can be eclipsed.
                    // (Most important: planet casting shadow on its ring.)
                    const MAX_OCC = 24;
                    let nOcc = 0;
                    const centers = occluderCenters;
                    const radii = occluderRadii;
                    for (let i = 0; i < bodies.length && nOcc < MAX_OCC; i++) {
                        const b = bodies[i];
                        if (!b?.group) continue;
                        b.group.getWorldPosition(tmp.vA);
                        centers[nOcc * 3 + 0] = tmp.vA.x;
                        centers[nOcc * 3 + 1] = tmp.vA.y;
                        centers[nOcc * 3 + 2] = tmp.vA.z;

                        const sl = b?.seaLevel;
                        const br = b?.cfg?.baseRadius ?? b?.baseRadius;
                        const r = typeof sl === "number" && sl > 0 ? sl : typeof br === "number" ? br : 1400;
                        radii[nOcc] = r;
                        nOcc++;
                    }
                    u.uOccCount.value = nOcc;
                    u.uOccCenters.value = centers;
                    u.uOccRadii.value = radii;

                    if (ringCount > 0) {
                        renderer.setRenderTarget(atmoRT);
                        ringDustPass.mesh.visible = true;
                        renderer.render(atmoScene, screenCam);
                        ringDustPass.mesh.visible = false;
                    }
                }

                // Cloud mask only for closestPass
                if (closestPass) {
                    renderer.setRenderTarget(cloudRT);
                    closestPass.maskMesh.visible = true;
                    renderer.render(atmoScene, screenCam);
                    closestPass.maskMesh.visible = false;
                }

                // Overlay atmoRT -> screen
                renderer.setRenderTarget(null);
                renderer.clearDepth();
                atmoCopyMat.uniforms.tAtmo.value = atmoRT.texture;
                renderer.render(atmoCopyScene, screenCam);

                // ============================================================
                // God Rays (screen-space)
                // ============================================================
                const sunScreen = tmp.vA.copy(tmp.sunPosW).project(camera);
                godRayMat.uniforms.uSunScreen.value.set(
                    sunScreen.x * 0.5 + 0.5,
                    sunScreen.y * 0.5 + 0.5,
                );
                godRayMat.uniforms.tDepth.value = rt.depthTexture;
                godRayMat.uniforms.tCloud.value = cloudRT.texture;

                const camFwd = tmp.vC
                    .set(0, 0, -1)
                    .applyQuaternion(camera.quaternion)
                    .normalize();
                const toSun = tmp.vB
                    .copy(tmp.sunPosW)
                    .sub(camera.position)
                    .normalize();
                const sunInFront = camFwd.dot(toSun) > 0.0;

                if (sunInFront && sunScreen.z > 0.0 && !underwater) {
                    const sx = sunScreen.x * 0.5 + 0.5;
                    const sy = sunScreen.y * 0.5 + 0.5;

                    const dx = sx - 0.5,
                        dy = sy - 0.5;
                    const centerFade = Math.max(
                        0,
                        1.0 - Math.sqrt(dx * dx + dy * dy) * 1.35,
                    );

                    const facing = THREE.MathUtils.clamp(
                        camFwd.dot(toSun),
                        0,
                        1,
                    );
                    godRayMat.uniforms.uIntensity.value =
                        0.08 * centerFade * centerFade * facing;
                    godRayMat.uniforms.uSunScreen.value.set(sx, sy);
                } else {
                    godRayMat.uniforms.uIntensity.value = 0.0;
                }

                if (godRayMat.uniforms.uIntensity.value > 0.0) {
                    renderer.clearDepth();
                    renderer.render(godRayScene, screenCam);
                }

                // ============================================================
                // Underwater POST overlays LAST
                // ============================================================
                if (
                    tintMat.uniforms.uOpacity.value > 0.0 ||
                    particlesMat.uniforms.uOpacity.value > 0.0
                ) {
                    particlesMat.uniforms.uTime.value = t;
                    const bnTex2 = world.getBlueNoiseTex
                        ? world.getBlueNoiseTex()
                        : world.blueNoiseTex;
                    particlesMat.uniforms.uNoiseTex.value = bnTex2;
                    particlesMat.uniforms.uNoiseSize.value.set(
                        bnTex2?.image?.width ?? 256,
                        bnTex2?.image?.height ?? 256,
                    );
                    renderer.clearDepth();
                    renderer.render(postScene, screenCam);
                }

                // Warp overlay on top of everything
                const warpOverlayVisible = warpCtrl.isOverlayVisible();
                renderWarpOverlay(renderer, warpOverlay, warpOverlayVisible);

                // The warp overlay is a fullscreen post effect that can fully cover
                // the scene (alpha = 1). Re-render the ship on top so it stays visible
                // throughout the warp sequence.
                if (warpOverlayVisible && playerShip?.loaded && playerShip.root?.visible) {
                    const oldMask = camera.layers.mask;
                    camera.layers.set(PLAYER_SHIP_LAYER);
                    renderer.clearDepth();
                    renderer.render(scene, camera);
                    camera.layers.mask = oldMask;
                }

				// HUD (throttled + diffed)
				const blueNoiseReady = world.getBlueNoiseReady
					? world.getBlueNoiseReady()
					: (world.blueNoiseReady ?? false);
                hud.update({
                    now,
                    player,
                    bodies,
                    moons,
                    nearestBodyInfo: playerCtrl.nearestBodyInfo,
                    underwater,
                    depth01,
                    godRaysOn: godRayMat.uniforms.uIntensity.value > 0.0,
                    blueNoiseReady,
                    LOD_NEAREST_K,
                    ringsCount: world.planetRings ? world.planetRings.length : 0,
                    beltOn: !!world.asteroidBelt,
                });

                playerCtrl.galaxyMiniMapUI?.draw?.();
                playerCtrl.galaxyOverlayUI?.draw?.();
                },
                onFpsUpdate: (fps, fpsEma) => {
                    // Keep values available for debugging/telemetry without overriding the FPS UI.
                    world._fpsLast = fps;
                    world._fpsEma = fpsEma;
                },
                dynamicQuality: {
                    enabled: true,
                    targetFps: 58,
                    deadband: 6,
                    minScale: 0.6,
                    maxScale: 1.0,
                    adjustEveryMs: 800,
                    initialScale: 1.0,
                    onScale: (s) => world.applyDynamicScale(s),
                },
            });

addEventListener("resize", () => {
                camera.aspect = innerWidth / innerHeight;
                camera.updateProjectionMatrix();
                renderer.setSize(innerWidth, innerHeight);

                world.rebuildRenderTargets();
                resizeWarpOverlay(warpOverlay.warpMat, innerWidth, innerHeight);
            });

	            // First-time spawn sets an initial safe position; respawn resets mode/state without moving.
	            playerCtrl.initialSpawn?.();
	            playerCtrl.respawn();
            mainLoop.start();
}
