import { THREE } from "../render/device.js";
import { createMainLoop } from "../render/renderer.js";
import { resizeWarpOverlay } from "../render/shaders.js";
import { renderWarpOverlay } from "../game/warp.js";
import { updateSuperPointLightMask, splMaskedMaterials } from "../game/spl.js";
import { createFlightHudUpdater, createHudUpdater } from "../ui/hud.js";
import { updateGasGiant } from "../game/gasGiantMaterial.js";


export function startGameLoop(world, playerCtrl) {
  const renderer = world.renderer;
  const scene = world.scene;
  const camera = world.camera;
  const bodies = world.bodies;
  const moons = world.moons ?? [];
  const sky = world.sky;
  const sun = world.sun;
  const sunLight = world.sunLight;

  const {
    copyScene,
    copyMat,
    atmoCopyScene,
    atmoCopyMat,
    ringDustCompositeScene,
    ringDustCompositeMat,
    godRayCompositeScene,
    godRayCompositeMat,
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
  const surfaceWaterFxScene = playerCtrl.surfaceWaterFxScene;

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


  // Conservative projected bounds for fullscreen volumetric passes. Three.js
  // keeps scissor state across render targets, so every bounded pass explicitly
  // disables it again before returning to a full-screen stage.
  const _viewCenter = new THREE.Vector3();
  const _angleBoundsX = new THREE.Vector2();
  const _angleBoundsY = new THREE.Vector2();
  const _sphereScissor = { x: 0, y: 0, width: 0, height: 0 };
  const _cloudScissor = { x: 0, y: 0, width: 0, height: 0 };
  const _ringItemBackScissor = { x: 0, y: 0, width: 0, height: 0 };
  const _ringItemFrontScissor = { x: 0, y: 0, width: 0, height: 0 };
  const _ringBackScissor = { x: 0, y: 0, width: 0, height: 0 };
  const _ringFrontScissor = { x: 0, y: 0, width: 0, height: 0 };
  const _ringCompositeScissor = { x: 0, y: 0, width: 0, height: 0 };
  const _ringSegmentCenter = new THREE.Vector3();
  const _ringSegmentWorld = new THREE.Vector3();
  const _underwaterCenterW = new THREE.Vector3();

  function resetScissor(rect) {
    rect.x = 0;
    rect.y = 0;
    rect.width = 0;
    rect.height = 0;
    return rect;
  }

  function scissorHasArea(rect) {
    return rect.width > 0 && rect.height > 0;
  }

  function unionScissor(out, rect) {
    if (!scissorHasArea(rect)) return out;
    if (!scissorHasArea(out)) {
      out.x = rect.x;
      out.y = rect.y;
      out.width = rect.width;
      out.height = rect.height;
      return out;
    }
    const x0 = Math.min(out.x, rect.x);
    const y0 = Math.min(out.y, rect.y);
    const x1 = Math.max(out.x + out.width, rect.x + rect.width);
    const y1 = Math.max(out.y + out.height, rect.y + rect.height);
    out.x = x0;
    out.y = y0;
    out.width = x1 - x0;
    out.height = y1 - y0;
    return out;
  }

  // WebGLRenderer.setScissor() uses logical canvas pixels and applies the
  // renderer DPR internally. Our bounds are already expressed in render-target
  // pixels, so using setScissor() directly on an offscreen target shifts and
  // stretches the rectangle whenever DPR != 1. Store the rectangle on the
  // render target instead; setRenderTarget() applies it in framebuffer pixels.
  function applyTargetScissor(target, rect) {
    if (target?.scissor?.set) {
      target.scissor.set(rect.x, rect.y, rect.width, rect.height);
      target.scissorTest = true;
      // Rebinding the same target is intentional: Three.js copies the target's
      // viewport/scissor state to WebGL on every setRenderTarget() call.
      renderer.setRenderTarget(target);
      return;
    }

    // Compatibility fallback for unusual/older renderer targets. Convert the
    // framebuffer-pixel rectangle back to logical pixels before Three.js
    // applies DPR internally.
    const dpr = Math.max(1e-6, renderer.getPixelRatio?.() ?? 1);
    const scale = target ? 1.0 / dpr : 1.0;
    renderer.setScissor(
      rect.x * scale,
      rect.y * scale,
      rect.width * scale,
      rect.height * scale,
    );
    renderer.setScissorTest(true);
  }

  function disableTargetScissor(target) {
    if (target && "scissorTest" in target) target.scissorTest = false;
    renderer.setScissorTest(false);
  }

  function clippedSphereAngleRange(
    axisOffset,
    forwardOffset,
    radius,
    halfFov,
    out,
  ) {
    const planeDistance = Math.hypot(axisOffset, forwardOffset);
    if (planeDistance <= radius) {
      out.set(-halfFov, halfFov);
      return true;
    }

    const centerAngle = Math.atan2(axisOffset, forwardOffset);
    const halfAngle = Math.asin(
      THREE.MathUtils.clamp(radius / planeDistance, 0, 0.999999),
    );
    let clippedLo = Infinity;
    let clippedHi = -Infinity;
    for (let wrap = -1; wrap <= 1; wrap++) {
      const shift = wrap * Math.PI * 2;
      const lo = Math.max(
        -halfFov,
        centerAngle - halfAngle + shift,
      );
      const hi = Math.min(
        halfFov,
        centerAngle + halfAngle + shift,
      );
      if (hi <= lo) continue;
      clippedLo = Math.min(clippedLo, lo);
      clippedHi = Math.max(clippedHi, hi);
    }

    if (!(clippedHi > clippedLo)) return false;
    out.set(clippedLo, clippedHi);
    return true;
  }

  function projectedSphereScissor(centerW, radiusW, target, out) {
    resetScissor(out);
    if (!target || !(radiusW > 0)) return false;

    _viewCenter.copy(centerW).applyMatrix4(camera.matrixWorldInverse);
    const distance = _viewCenter.length();
    if (distance <= radiusW * 1.001) {
      out.width = target.width;
      out.height = target.height;
      return true;
    }
    const halfFovY = THREE.MathUtils.degToRad(camera.fov * 0.5);
    const tanHalfFovY = Math.tan(halfFovY);
    const halfFovX = Math.atan(tanHalfFovY * camera.aspect);
    const forwardOffset = -_viewCenter.z;

    // Perspective bounds become numerically fragile when a volume crosses the
    // camera plane. In that case the effect can occupy disconnected screen
    // regions, so a single rectangle is not a safe representation. Rendering
    // the full target is both correct and usually no more expensive than a
    // near-full scissor for a volume this close.
    if (forwardOffset <= radiusW * 1.05) {
      out.width = target.width;
      out.height = target.height;
      return true;
    }

    if (
      !clippedSphereAngleRange(
        _viewCenter.x,
        forwardOffset,
        radiusW,
        halfFovX,
        _angleBoundsX,
      ) ||
      !clippedSphereAngleRange(
        _viewCenter.y,
        forwardOffset,
        radiusW,
        halfFovY,
        _angleBoundsY,
      )
    ) {
      return false;
    }

    const xDenom = tanHalfFovY * camera.aspect;
    const ndcX0 = THREE.MathUtils.clamp(
      Math.tan(_angleBoundsX.x) / xDenom,
      -1,
      1,
    );
    const ndcX1 = THREE.MathUtils.clamp(
      Math.tan(_angleBoundsX.y) / xDenom,
      -1,
      1,
    );
    const ndcY0 = THREE.MathUtils.clamp(
      Math.tan(_angleBoundsY.x) / tanHalfFovY,
      -1,
      1,
    );
    const ndcY1 = THREE.MathUtils.clamp(
      Math.tan(_angleBoundsY.y) / tanHalfFovY,
      -1,
      1,
    );

    const margin = 12;
    const x0 = Math.max(
      0,
      Math.floor((ndcX0 * 0.5 + 0.5) * target.width) - margin,
    );
    const x1 = Math.min(
      target.width,
      Math.ceil((ndcX1 * 0.5 + 0.5) * target.width) + margin,
    );
    const y0 = Math.max(
      0,
      Math.floor((ndcY0 * 0.5 + 0.5) * target.height) - margin,
    );
    const y1 = Math.min(
      target.height,
      Math.ceil((ndcY1 * 0.5 + 0.5) * target.height) + margin,
    );

    if (x1 <= x0 || y1 <= y0) return false;

    const width = x1 - x0;
    const height = y1 - y0;
    // Large bounds gain little from scissoring and are the most visible when a
    // conservative projection is a few pixels short. Prefer correctness.
    if (width >= target.width * 0.8 || height >= target.height * 0.8) {
      out.x = 0;
      out.y = 0;
      out.width = target.width;
      out.height = target.height;
      return true;
    }

    out.x = x0;
    out.y = y0;
    out.width = width;
    out.height = height;
    return true;
  }

  function maxWorldScale(matrixWorld) {
    const e = matrixWorld.elements;
    return Math.max(
      Math.hypot(e[0], e[1], e[2]),
      Math.hypot(e[4], e[5], e[6]),
      Math.hypot(e[8], e[9], e[10]),
    );
  }

  function projectedRingLayerScissors(
    group,
    segmentInfo,
    innerRadius,
    outerRadius,
    halfHeight,
    splitAroundCenter,
    target,
    outBack,
    outFront,
  ) {
    resetScissor(outBack);
    resetScissor(outFront);
    if (!group || !target || !(outerRadius > innerRadius)) return false;

    if (typeof group.updateWorldMatrix === "function") {
      group.updateWorldMatrix(true, false);
    } else {
      group.updateMatrixWorld(true);
    }
    const hasAuthoredSegments =
      Array.isArray(segmentInfo) && segmentInfo.length > 0;
    const segmentCount = hasAuthoredSegments
      ? segmentInfo.length
      : outerRadius > 6000
        ? 24
        : 16;
    const fallbackSegmentAngle = (Math.PI * 2) / segmentCount;
    const midRadius = (innerRadius + outerRadius) * 0.5;
    const worldScale = maxWorldScale(group.matrixWorld);

    // Planet rings already expose angular batches. Use those same sections to
    // build separate conservative bounds for the far and near halves. The
    // shader performs the exact per-sample split, while these section bounds
    // keep the two passes from degenerating into two full-ring rectangles.
    let canSplit = !!splitAroundCenter;
    if (canSplit) {
      _ringInv.copy(group.matrixWorld).invert();
      _camPosL.copy(camera.position).applyMatrix4(_ringInv);
      const cameraDistanceL = _camPosL.length();
      if (cameraDistanceL > 1e-5) {
        _camPosL.multiplyScalar(1.0 / cameraDistanceL);
      } else {
        // At the exact ring centre there is no stable front/back plane. Keep
        // the complete ring in the front layer so it is rendered once.
        canSplit = false;
      }
    }

    for (let i = 0; i < segmentCount; i++) {
      let halfAngle = fallbackSegmentAngle * 0.5;
      const authored = hasAuthoredSegments ? segmentInfo[i] : null;
      if (authored?.center) {
        _ringSegmentCenter.copy(authored.center);
        if (
          Number.isFinite(authored.a0) &&
          Number.isFinite(authored.a1)
        ) {
          const span = Math.abs(authored.a1 - authored.a0);
          if (span > 1e-6) halfAngle = Math.min(Math.PI, span * 0.5);
        }
      } else {
        const a = (i + 0.5) * fallbackSegmentAngle;
        _ringSegmentCenter.set(
          Math.cos(a) * midRadius,
          0,
          Math.sin(a) * midRadius,
        );
      }

      const cosHalf = Math.cos(halfAngle);
      const innerD2 =
        innerRadius * innerRadius +
        midRadius * midRadius -
        2 * innerRadius * midRadius * cosHalf;
      const outerD2 =
        outerRadius * outerRadius +
        midRadius * midRadius -
        2 * outerRadius * midRadius * cosHalf;
      const localBoundRadius =
        Math.sqrt(
          Math.max(innerD2, outerD2) + halfHeight * halfHeight,
        ) *
          1.18 +
        2.0;
      const worldBoundRadius = localBoundRadius * worldScale;

      _ringSegmentWorld
        .copy(_ringSegmentCenter)
        .applyMatrix4(group.matrixWorld);
      if (
        projectedSphereScissor(
          _ringSegmentWorld,
          worldBoundRadius,
          target,
          _sphereScissor,
        )
      ) {
        if (!canSplit) {
          unionScissor(outFront, _sphereScissor);
          continue;
        }

        const signedCenterDistance = _ringSegmentCenter.dot(_camPosL);
        // A section intersecting the centre plane is conservatively present in
        // both scissor rectangles. The fragment shader assigns every actual
        // sample to exactly one side, so there is no double contribution.
        if (signedCenterDistance - localBoundRadius <= 0.0) {
          unionScissor(outBack, _sphereScissor);
        }
        if (signedCenterDistance + localBoundRadius >= 0.0) {
          unionScissor(outFront, _sphereScissor);
        }
      }
    }
    return scissorHasArea(outBack) || scissorHasArea(outFront);
  }

  function scaleScissor(src, srcTarget, dstTarget, out) {
    resetScissor(out);
    if (!scissorHasArea(src) || !srcTarget || !dstTarget) return false;
    const sx = dstTarget.width / srcTarget.width;
    const sy = dstTarget.height / srcTarget.height;
    const x0 = Math.max(0, Math.floor(src.x * sx) - 2);
    const y0 = Math.max(0, Math.floor(src.y * sy) - 2);
    const x1 = Math.min(
      dstTarget.width,
      Math.ceil((src.x + src.width) * sx) + 2,
    );
    const y1 = Math.min(
      dstTarget.height,
      Math.ceil((src.y + src.height) * sy) + 2,
    );
    if (x1 <= x0 || y1 <= y0) return false;
    out.x = x0;
    out.y = y0;
    out.width = x1 - x0;
    out.height = y1 - y0;
    return true;
  }

  // Render targets / passes can be rebuilt on resize or dynamic scaling.
  let rt = world.rt;
  let atmoRT = world.atmoRT;
  let cloudRT = world.cloudRT;
  let ringDustRT = world.ringDustRT;
  let godRayRT = world.godRayRT;
  let underwaterRT = world.underwaterRT;
  let atmoPasses = world.atmoPasses;
  const _enclosingAtmospheres = [];

  function renderAtmosphereItem(item, closestPass, logDepthFC, timeSeconds) {
    const pass = item.pass;

    // Skip full-screen atmo for tiny far planets (big GPU win).
    const atmoR =
      pass.uniforms.uPlanetRadius.value +
      pass.uniforms.uAtmoHeight.value;
    const pxR =
      (atmoR / Math.max(1e-6, item.camD)) *
      (innerHeight * 0.5) /
      Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    if (pass !== closestPass && pxR < 12.0) return false;
    if (
      !projectedSphereScissor(
        item.centerW,
        atmoR,
        atmoRT,
        _sphereScissor,
      )
    ) {
      return false;
    }

    pass.uniforms.uPlanetCenterW.value.copy(item.centerW);
    pass.uniforms.uSunPosW.value.copy(tmp.sunPosW);
    if (pass.uniforms.uSunRadius) {
      pass.uniforms.uSunRadius.value = world.SUN_RADIUS;
    }
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
    pass.uniforms.uTime.value = timeSeconds;

    const bnTex = world.getBlueNoiseTex
      ? world.getBlueNoiseTex()
      : world.blueNoiseTex;
    pass.uniforms.uBlueNoiseTex.value = bnTex;
    pass.uniforms.uBlueNoiseSize.value.set(
      bnTex?.image?.width ?? 256,
      bnTex?.image?.height ?? 256,
    );

    const far = THREE.MathUtils.clamp(
      (item.nearApprox - 2500.0) / 14000.0,
      0,
      1,
    );
    pass.uniforms.uCheapCloudFarBoost.value =
      pass === closestPass ? 0.0 : 0.12 + 0.48 * far;
    pass.uniforms.uCheapCloudContrast.value =
      pass === closestPass ? 1.0 : 1.0 + 0.22 * far;

    // Fine Worley erosion is worthwhile only when the cloud layer resolves
    // to enough pixels in the actual atmosphere target. The current cloud
    // step budget also acts as a quality cap.
    const cloudTopR =
      pass.uniforms.uPlanetRadius.value +
      pass.uniforms.uCloudBase.value +
      pass.uniforms.uCloudThickness.value;
    const cloudPxR =
      (cloudTopR / Math.max(1e-6, item.camD)) *
      (atmoRT.height * 0.5) /
      Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));

    // Use the flat approximation only when it is too small to expose its
    // lack of volume. Large secondary planets keep the full marcher.
    pass.uniforms.uUseCheapClouds.value =
      pass !== closestPass && cloudPxR < 72.0 ? 1.0 : 0.0;
    const detailBySize = THREE.MathUtils.clamp(
      (cloudPxR - 28.0) / 180.0,
      0.0,
      1.0,
    );
    const detailByQuality = THREE.MathUtils.clamp(
      (pass.uniforms.uCloudSteps.value - 5.0) / 7.0,
      0.0,
      1.0,
    );
    const detailCap = pass === closestPass ? 1.0 : 0.35;
    let cloudDetailLod = Math.min(
      detailBySize,
      detailByQuality,
      detailCap,
    );
    if (cloudDetailLod < 0.08) cloudDetailLod = 0.0;
    pass.uniforms.uCloudDetailLod.value = cloudDetailLod;

    applyTargetScissor(atmoRT, _sphereScissor);
    pass.atmoMesh.visible = true;
    renderer.render(atmoScene, screenCam);
    pass.atmoMesh.visible = false;
    return true;
  }

  function prepareRingDust(logDepthFC, timeSeconds) {
    resetScissor(_ringBackScissor);
    resetScissor(_ringFrontScissor);

    const hasPlanetRings = !!(
      world.planetRings && world.planetRings.length
    );
    const hasAsteroidBelt = !!(
      world.asteroidBelt?.group &&
      world.asteroidBelt.group.visible !== false
    );
    if (
      !ringDustPass ||
      !ringDustRT ||
      (!hasPlanetRings && !hasAsteroidBelt)
    ) {
      if (ringDustPass?.uniforms?.uRingCount) {
        ringDustPass.uniforms.uRingCount.value = 0;
      }
      return 0;
    }

    const u = ringDustPass.uniforms;
    u.uInvViewMatrix.value.copy(camera.matrixWorld);
    u.uInvProjMatrix.value.copy(camera.projectionMatrixInverse);
    u.uDepthTex.value = rt.depthTexture;
    u.uLogDepthFC.value = logDepthFC;
    u.uTime.value = timeSeconds;
    if (u.uSunPosW?.value) u.uSunPosW.value.copy(tmp.sunPosW);
    if (u.uRingSplitEnabled?.value?.fill) {
      u.uRingSplitEnabled.value.fill(0);
    }
    if (u.uRingOwnerAtmoEnabled?.value?.fill) {
      u.uRingOwnerAtmoEnabled.value.fill(0);
    }
    if (u.uRingGlobalAtmoSplit?.value?.fill) {
      u.uRingGlobalAtmoSplit.value.fill(0);
    }

    // Build the current atmospheric-sphere list once for system-scale dust.
    // These are the same bodies rendered by the atmosphere pass.
    if (u.uGlobalAtmoCount && u.uGlobalAtmoCenterW && u.uGlobalAtmoRadius) {
      let globalAtmoCount = 0;
      for (
        let i = 0;
        i < atmoPasses.length && globalAtmoCount < 8;
        i++
      ) {
        const body = atmoPasses[i]?.body;
        if (!body?.group || body.hasAtmo === false) continue;
        body.group.getWorldPosition(tmp.vB);
        u.uGlobalAtmoCenterW.value[globalAtmoCount].copy(tmp.vB);
        const baseR = body.cfg?.baseRadius ?? body.baseRadius ?? 0.0;
        u.uGlobalAtmoRadius.value[globalAtmoCount] = baseR * 1.33;
        globalAtmoCount++;
      }
      u.uGlobalAtmoCount.value = globalAtmoCount;
    }

    const bnTex = world.getBlueNoiseTex
      ? world.getBlueNoiseTex()
      : world.blueNoiseTex;
    u.uBlueNoiseTex.value = bnTex;
    u.uBlueNoiseSize.value.set(
      bnTex?.image?.width ?? 256,
      bnTex?.image?.height ?? 256,
    );

    const rdp = world.getRingDustParams
      ? world.getRingDustParams()
      : null;
    const bright = Math.max(0.0, rdp?.brightness ?? 1.0);

    let ringCount = 0;
    const rings = world.planetRings || [];
    for (let i = 0; i < rings.length && ringCount < 8; i++) {
      const ring = rings[i];
      if (!ring?.group || ring.group.visible === false) continue;

      const params = ring.params || {};
      const innerRadius =
        typeof params.innerRadius === "number"
          ? params.innerRadius
          : 1800.0;
      const outerRadius =
        typeof params.outerRadius === "number"
          ? params.outerRadius
          : 2600.0;
      const halfHeight =
        typeof params.thickness === "number"
          ? params.thickness * 0.5
          : 40.0;

      if (
        !projectedRingLayerScissors(
          ring.group,
          ring.segInfo,
          innerRadius,
          outerRadius,
          halfHeight,
          true,
          ringDustRT,
          _ringItemBackScissor,
          _ringItemFrontScissor,
        )
      ) {
        continue;
      }
      // The exact front/back decision is made per sample against the owner's
      // atmosphere sphere. A centre-plane section can straddle that boundary,
      // so conservatively allow every authored section in either low-res layer.
      // The shader discards samples belonging to the opposite layer.
      unionScissor(_ringBackScissor, _ringItemBackScissor);
      unionScissor(_ringBackScissor, _ringItemFrontScissor);
      unionScissor(_ringFrontScissor, _ringItemBackScissor);
      unionScissor(_ringFrontScissor, _ringItemFrontScissor);

      _ringInv.copy(ring.group.matrixWorld).invert();
      u.uRingInvMatrix.value[ringCount].copy(_ringInv);
      u.uRingInner.value[ringCount] = innerRadius;
      u.uRingOuter.value[ringCount] = outerRadius;
      u.uRingHalfHeight.value[ringCount] = halfHeight;
      u.uRingSplitEnabled.value[ringCount] = 1.0;

      const owner = ring.body;
      if (owner?.group && u.uRingOwnerAtmoEnabled) {
        owner.group.getWorldPosition(tmp.vB);
        u.uRingOwnerCenterW.value[ringCount].copy(tmp.vB);
        const ownerBaseR = owner.cfg?.baseRadius ?? owner.baseRadius ?? 0.0;
        // Matches makeAtmoPassForBody(): atmosphere top is baseR + 0.33*baseR.
        u.uRingOwnerAtmoRadius.value[ringCount] = ownerBaseR * 1.33;
        u.uRingOwnerAtmoEnabled.value[ringCount] = ownerBaseR > 0.0 ? 1.0 : 0.0;
      }

      const color = tmp.colA || (tmp.colA = new THREE.Color());
      color.setHex(params.baseColor ?? 0x777777);
      const tint = u.uRingTint.value[ringCount];
      tint.set(
        color.r * bright,
        color.g * bright,
        color.b * bright,
      );
      ringCount++;
    }

    // The main asteroid belt has no single owner, but its dust can pass behind
    // any planetary atmosphere. Use the same per-sample near/far classification
    // as planet rings, evaluated against all active atmospheric spheres.
    if (hasAsteroidBelt && ringCount < 8) {
      const belt = world.asteroidBelt;
      const params = belt.params || {};
      const innerRadius =
        typeof params.innerRadius === "number"
          ? params.innerRadius
          : 12000.0;
      const outerRadius =
        typeof params.outerRadius === "number"
          ? params.outerRadius
          : 14000.0;
      const halfHeight =
        typeof params.thickness === "number"
          ? params.thickness * 0.5
          : 280.0;

      if (
        projectedRingLayerScissors(
          belt.group,
          belt.segInfo,
          innerRadius,
          outerRadius,
          halfHeight,
          true,
          ringDustRT,
          _ringItemBackScissor,
          _ringItemFrontScissor,
        )
      ) {
        // Centre-plane bounds are only a cheap angular subdivision here. The
        // shader does the exact atmosphere-depth classification, so every
        // section is conservatively available to both compositing layers.
        unionScissor(_ringBackScissor, _ringItemBackScissor);
        unionScissor(_ringBackScissor, _ringItemFrontScissor);
        unionScissor(_ringFrontScissor, _ringItemBackScissor);
        unionScissor(_ringFrontScissor, _ringItemFrontScissor);
        _ringInv.copy(belt.group.matrixWorld).invert();
        u.uRingInvMatrix.value[ringCount].copy(_ringInv);
        u.uRingInner.value[ringCount] = innerRadius;
        u.uRingOuter.value[ringCount] = outerRadius;
        u.uRingHalfHeight.value[ringCount] = halfHeight;
        u.uRingSplitEnabled.value[ringCount] = 1.0;
        if (u.uRingGlobalAtmoSplit) {
          u.uRingGlobalAtmoSplit.value[ringCount] = 1.0;
        }

        const color = tmp.colA || (tmp.colA = new THREE.Color());
        color.setHex(0x92a7bb);
        const tint = u.uRingTint.value[ringCount];
        tint.set(
          color.r * bright,
          color.g * bright,
          color.b * bright,
        );
        ringCount++;
      }
    }

    u.uRingCount.value = ringCount;
    if (
      ringCount <= 0 ||
      (!scissorHasArea(_ringBackScissor) &&
        !scissorHasArea(_ringFrontScissor))
    ) {
      return 0;
    }

    // Build eclipse candidates once; both depth layers use the same bodies.
    const MAX_OCC = 24;
    let nOcc = 0;
    const centers = occluderCenters;
    const radii = occluderRadii;
    for (let i = 0; i < bodies.length && nOcc < MAX_OCC; i++) {
      const body = bodies[i];
      if (!body?.group) continue;
      body.group.getWorldPosition(tmp.vA);
      centers[nOcc * 3 + 0] = tmp.vA.x;
      centers[nOcc * 3 + 1] = tmp.vA.y;
      centers[nOcc * 3 + 2] = tmp.vA.z;

      radii[nOcc] = world.getEclipseBodyRadius
        ? world.getEclipseBodyRadius(body)
        : 1400;
      nOcc++;
    }
    u.uOccCount.value = nOcc;
    u.uOccCenters.value = centers;
    u.uOccRadii.value = radii;
    if (u.uSunRadius) u.uSunRadius.value = world.SUN_RADIUS;
    return ringCount;
  }

  function renderAndCompositeRingDustLayer(
    ringCount,
    layerMode,
    layerScissor,
  ) {
    if (
      ringCount <= 0 ||
      !scissorHasArea(layerScissor) ||
      !ringDustPass ||
      !ringDustRT ||
      !ringDustCompositeScene
    ) {
      return false;
    }

    const u = ringDustPass.uniforms;
    u.uLayerMode.value = layerMode;

    disableTargetScissor(ringDustRT);
    renderer.setRenderTarget(ringDustRT);
    renderer.setClearColor(0x000000, 0.0);
    renderer.clear(true, false, false);
    applyTargetScissor(ringDustRT, layerScissor);
    ringDustPass.mesh.visible = true;
    renderer.render(atmoScene, screenCam);
    ringDustPass.mesh.visible = false;
    disableTargetScissor(ringDustRT);

    renderer.setRenderTarget(atmoRT);
    ringDustCompositeMat.uniforms.tTexture.value = ringDustRT.texture;
    if (
      scaleScissor(
        layerScissor,
        ringDustRT,
        atmoRT,
        _ringCompositeScissor,
      )
    ) {
      applyTargetScissor(atmoRT, _ringCompositeScissor);
      renderer.render(ringDustCompositeScene, screenCam);
      disableTargetScissor(atmoRT);
      return true;
    }
    return false;
  }

  // Local accumulators (used only by the loop).
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

  // The atmospheric shield is presented after world post-processing. Before
  // drawing it, this depth-only material can stamp the opaque ship hull into
  // the default framebuffer so the additive shell still respects hull depth.
  const playerShieldDepthMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true,
    depthTest: true,
    side: THREE.DoubleSide,
  });

  // HUD (throttled + diffed). Keep telemetry separate from transient messages
  // such as landing, pointer-lock and warp notifications.
  const hudTelemetryEl =
    document.getElementById("hudTelemetry") ?? world.msg;
  const hud = createHudUpdater({ msgEl: hudTelemetryEl, intervalMs: 200 });
  const flightHud = createFlightHudUpdater({
    rootEl: document.getElementById("flightHud"),
    THREE,
    camera,
  });

            const mainLoop = createMainLoop({
                fpsCap: 60,
                maxDt: 0.033,
                step: (dt, t, now) => {
                    // refresh handles that may be rebuilt by quality/resize
                    rt = world.rt;
                    atmoRT = world.atmoRT;
                    cloudRT = world.cloudRT;
                    ringDustRT = world.ringDustRT;
                    godRayRT = world.godRayRT;
                    underwaterRT = world.underwaterRT;
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

                world.terrainPool?.pumpCompleted({
                    maxJobs: 2,
                    budgetMs: 2.0,
                });

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

                // Advance ocean wave time before any gameplay water query.
                // Ship/rover/swimmer physics and the later ocean render must sample
                // the same animated crest/trough for this frame.
                for (const b of bodies) {
                    if (b.oceanUniforms?.uTime) b.oceanUniforms.uTime.value = t;
                }

                // Parked surface vehicles remain anchored to their host body
                // even while the player is walking/flying elsewhere nearby.
                playerCtrl.updateSurfaceVehicleAnchor?.(dt);

                if (!playerCtrl.isGalaxyOpen() && !warpCtrl.isMovementLocked()) {
                    if (player.mode === "walk") playerCtrl.updateWalk(dt);
                    else if (player.mode === "drive") playerCtrl.updateDrive(dt);
                    else playerCtrl.updateFly(dt);
                }

                // If we left fly mode, fade out the engine hum (but never interrupt warp audio).
                if (player.mode !== "fly" && !warpCtrl?.warp?.active) {
                    playerCtrl.stopFlyEngineAudio();
                }
                // Update the camera-centered focused solar shadow bubble.
                tmp.sunAimW.copy(camera.position);
                world.updateSunSuperPointLight(tmp.sunPosW, tmp.sunAimW, dt, tmp);
                _splMaskAccum += dt;
                if (_splMaskAccum >= world.SPL_MASK_INTERVAL) {
                    _splMaskAccum = 0.0;
                    updateSuperPointLightMask(splMaskedMaterials, world.sunLight);
                }

                // ocean shader uniforms
                for (const b of bodies) {
                    const uniforms = b.oceanUniforms;
                    if (!uniforms) continue;
                    uniforms.uTime.value = t;
                    const centerW = b.group.getWorldPosition(
                        tmp.vA.set(0, 0, 0),
                    );
                    uniforms.uPlanetCenterW.value.copy(centerW);
                    if (uniforms.uCameraInsideOcean) {
                        // Match the animated vertex-displaced ocean surface at
                        // the camera direction. This keeps the material's inside
                        // state synchronized with visible crests and troughs.
                        const seaRadius = Math.max(
                            0,
                            b.oceanSurfaceRadiusAtWorldPoint?.(camera.position) ??
                                b.seaLevel ??
                                b.cfg?.baseRadius ??
                                b.baseRadius ??
                                0,
                        );
                        const cameraInsideOcean =
                            camera.position.distanceToSquared(centerW) <
                            seaRadius * seaRadius;
                        uniforms.uCameraInsideOcean.value = cameraInsideOcean
                            ? 1.0
                            : 0.0;

                        // Outside the ocean, writing the water depth gives the
                        // atmosphere pass the exact animated surface intersection.
                        // Underwater, however, that same depth incorrectly stops
                        // the atmosphere at the water and removes all air/clouds
                        // beyond it. Keep the transparent inner water surface in
                        // the colour buffer, but leave the opaque terrain/sky depth
                        // available to the atmosphere while the camera is submerged.
                        if (b.oceanMaterial) {
                            b.oceanMaterial.depthWrite = !cameraInsideOcean;
                        }
                    }
                    uniforms.uSunPosW.value.copy(tmp.sunPosW);
                    if (uniforms.uSunRadius) {
                        uniforms.uSunRadius.value = world.SUN_RADIUS;
                    }
                    uniforms.uWorldNormalMatrix.value.getNormalMatrix(
                        b.group.matrixWorld,
                    );
                    uniforms.uSunColor.value.copy(sunLight.color);
                    uniforms.uSunIntensity.value = THREE.MathUtils.clamp(
                        sunLight.intensity / 3.0,
                        0.0,
                        3.0,
                    );

                    // Feed eclipse occluders to oceans (per-body buffers)
                    if (
                        uniforms.uOccCount &&
                        b._oceanOccCenters &&
                        b._oceanOccRadii
                    ) {
                        const nOcc = world.fillOccludersForBody(
                            { body: b, mat: { uniforms } },
                            b._oceanOccCenters,
                            b._oceanOccRadii,
                            tmp,
                        );
                        uniforms.uOccCount.value = nOcc;
                        uniforms.uOccCenters.value = b._oceanOccCenters;
                        uniforms.uOccRadii.value = b._oceanOccRadii;
                    }
                }

                // terrain shader uniforms (eclipse + cloud shadows)
                for (const b of bodies) {
                    const uniforms = b.terrainUniforms;
                    if (!uniforms) continue;
                    const centerW = b.group.getWorldPosition(
                        tmp.vA.set(0, 0, 0),
                    );
                    if (uniforms.uTime) uniforms.uTime.value = t;
                    if (uniforms.uPlanetCenterW) {
                        uniforms.uPlanetCenterW.value.copy(centerW);
                    }
                    if (uniforms.uSunPosW) {
                        uniforms.uSunPosW.value.copy(tmp.sunPosW);
                    }
                    if (
                        uniforms.uCloudNoiseTex &&
                        !uniforms.uCloudNoiseTex.value &&
                        world.cloudNoiseTex
                    ) {
                        uniforms.uCloudNoiseTex.value = world.cloudNoiseTex;
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
                    if (b.uniforms.uSunRadius) {
                        b.uniforms.uSunRadius.value = world.SUN_RADIUS;
                    }
                    if (b.uniforms.uEclipseAmbientFloor) {
                        b.uniforms.uEclipseAmbientFloor.value =
                            sunLight.eclipse?.ambientFloor ?? 0.12;
                    }

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
                let underwaterDepth = 0.0;
                let underwaterLight = 1.0;
                let underwaterRadius = 1.0;

                tintMat.uniforms.uOpacity.value = 0.0;
                particlesMat.uniforms.uOpacity.value = 0.0;

                const nearCam = playerCtrl.nearestBodyInfo(camera.position);

                if (nearCam.i >= 0) {
                    const b = bodies[nearCam.i];
                    const center = b.group.getWorldPosition(
                        tmp.vA.set(0, 0, 0),
                    );
                    const dist = camera.position.distanceTo(center);

                    if (b.hasOcean) {
                        const surfaceRadius = Math.max(
                            0,
                            b.oceanSurfaceRadiusAtWorldPoint?.(camera.position) ??
                                b.seaLevel,
                        );
                        if (dist < surfaceRadius) {

                        underwater = true;

                        const depth = surfaceRadius - dist;
                        underwaterDepth = depth;
                        underwaterRadius = surfaceRadius;
                        _underwaterCenterW.copy(center);
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
                            sunLight.eclipse?.ambientFloor ?? 0.12,
                            1.0,
                            vis,
                        );

                        // Only let eclipses affect the sun-facing hemisphere.
                        // Otherwise they incorrectly darken the "night" minimum light.
                        // Gate by N·L so eclipses never darken the night hemisphere.
                        const daySide = THREE.MathUtils.smoothstep(ndl, 0.0, 0.25);
                        const eclipseDimDay = THREE.MathUtils.lerp(1.0, eclipseDim, daySide);

                        nightMask *= eclipseDimDay;
                        const dayE = THREE.MathUtils.clamp(day * eclipseDimDay, 0, 1);

                        const oceanCol = b.oceanColor;

                        scene.fog.color
                            .copy(oceanCol)
                            .multiplyScalar(0.45 * nightMask);
                        scene.fog.density =
                            (0.05 + depth01 * 0.02) *
                            (0.85 + 0.35 * (1.0 - dayE));

                        underwaterLight = nightMask;
                        tintMat.uniforms.uColor.value.copy(oceanCol);
                        // Fade in quickly as the camera crosses the animated wave surface,
                        // then let the shader's physical water-path calculation
                        // control visibility with depth and view direction.
                        tintMat.uniforms.uOpacity.value = THREE.MathUtils.clamp(
                            0.65 + depth * 0.35,
                            0.65,
                            1.0,
                        );
                        if (tintMat.uniforms.uLightFactor) {
                            tintMat.uniforms.uLightFactor.value = nightMask;
                        }
                        if (tintMat.uniforms.uCameraDepth) {
                            tintMat.uniforms.uCameraDepth.value = depth;
                        }
                        if (tintMat.uniforms.uOceanRadius) {
                            tintMat.uniforms.uOceanRadius.value = surfaceRadius;
                        }
                        if (tintMat.uniforms.uOceanCenterW) {
                            tintMat.uniforms.uOceanCenterW.value.copy(center);
                        }

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
                                sunLight.eclipse?.ambientFloor ?? 0.12,
                                1.0,
                                vis,
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

                    const base = world.SUN_RADIUS * 13.0;
                    const extra = THREE.MathUtils.clamp(
                        d * 0.040,
                        0,
                        world.SUN_RADIUS * 38.0,
                    );

                    world.sunGlow.scale.setScalar(base + extra);

                    world.sunGlow.material.opacity = THREE.MathUtils.clamp(
                        2.25 - d * 0.0000025,
                        0.85,
                        2.25,
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
                            if (m.uniforms.uSunRadius) {
                                m.uniforms.uSunRadius.value = world.SUN_RADIUS;
                            }
                            m.uniforms.uOccCount.value = nOcc;
                            if (hasCamL && m.uniforms.uCamPosL) {
                                m.uniforms.uCamPosL.value.copy(_camPosL);
                            }
                            // centers/radii are already bound to r.dustOccCenters/r.dustOccRadii
                        }
                    }
                }

                // While submerged, compose the complete world/atmosphere frame
                // offscreen so the final underwater pass can refract and absorb
                // every layer, including sky, clouds and ring dust.
                const presentationTarget =
                    underwater && underwaterRT ? underwaterRT : null;

                // =======================
                // 1) Render scene into rt
                // =======================
                renderer.setRenderTarget(rt);
                renderer.setClearColor(0x000000, 1.0);
                renderer.clear(true, true, true);

                // Player atmospheric effects are foreground effects. The shield
                // is temporarily hidden here; wing trails already live in their
                // own scene and therefore never enter this world render target.
                const shieldForegroundVisible =
                    playerShip?.atmosphericShield?.visible === true &&
                    playerShip?.root?.visible === true;
                const trailForegroundVisible =
                    playerShip?.wingTrailScene &&
                    (playerShip?.wingTrailLeft?.mesh?.visible === true ||
                        playerShip?.wingTrailRight?.mesh?.visible === true);
                const waterFxForegroundVisible =
                    surfaceWaterFxScene?.children?.some?.(
                        (child) => child?.visible === true,
                    ) === true;
                if (shieldForegroundVisible) {
                    playerShip.atmosphericShield.visible = false;
                }
                renderer.render(scene, camera);
                if (shieldForegroundVisible) {
                    playerShip.atmosphericShield.visible = true;
                }

                // ============================================
                // 2) Copy rt -> presentation target or screen
                // ============================================
                renderer.setRenderTarget(presentationTarget);
                renderer.setClearColor(0x000000, 1.0);
                renderer.clear(true, true, true);
                renderer.clearDepth();

                copyMat.uniforms.tColor.value = rt.texture;
                renderer.render(copyScene, screenCam);

                // ============================================================
                // Atmosphere/Clouds into atmoRT + cloud mask into cloudRT
                // ============================================================
                const logDepthFC = 2.0 / Math.log2(camera.far + 1.0);

                disableTargetScissor(atmoRT);
                disableTargetScissor(cloudRT);
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

                // Planet-ring dust is split using the ring's existing angular
                // sections plus an exact shader-side centre-plane test:
                //   rear sections -> atmosphere -> front/over-planet sections.
                // The main asteroid belt keeps its established front-layer order.
                const preparedRingCount = prepareRingDust(logDepthFC, t);

                // Rear ring sections sit below atmospheric extinction and haze.
                renderAndCompositeRingDustLayer(
                    preparedRingCount,
                    -1.0,
                    _ringBackScissor,
                );

                // Preserve the surface-view rule from the previous fix: an
                // atmosphere containing the camera remains the final local veil.
                // All other atmospheres are placed between rear and front ring
                // sections, which gives the classic back-ring / planet / front-ring
                // composition when viewed from space.
                _enclosingAtmospheres.length = 0;
                for (const item of sorted) {
                    const pass = item.pass;
                    const atmoR =
                        pass.uniforms.uPlanetRadius.value +
                        pass.uniforms.uAtmoHeight.value;
                    if (item.camD < atmoR) {
                        _enclosingAtmospheres.push(item);
                        continue;
                    }
                    renderAtmosphereItem(item, closestPass, logDepthFC, t);
                }
                disableTargetScissor(atmoRT);

                // Near ring sections, including portions projected across the
                // planet disc, must sit above the owner's atmosphere.
                renderAndCompositeRingDustLayer(
                    preparedRingCount,
                    1.0,
                    _ringFrontScissor,
                );

                // When the camera is inside an atmosphere, that local air still
                // veils every external ring section, including the near half.
                if (_enclosingAtmospheres.length > 0) {
                    for (const item of _enclosingAtmospheres) {
                        renderAtmosphereItem(item, closestPass, logDepthFC, t);
                    }
                    disableTargetScissor(atmoRT);
                }

                // Density-only cloud mask for the closest body. This runs after
                // deferred local atmospheres so the shared uniforms always
                // describe the current camera frame.
                if (
                    closestPass &&
                    closestPass.uniforms.uCloudDensity.value > 0.0
                ) {
                    const cloudTopRadius =
                        closestPass.uniforms.uPlanetRadius.value +
                        closestPass.uniforms.uCloudBase.value +
                        closestPass.uniforms.uCloudThickness.value;
                    if (
                        projectedSphereScissor(
                            closestPass._centerW,
                            cloudTopRadius,
                            cloudRT,
                            _cloudScissor,
                        )
                    ) {
                        applyTargetScissor(cloudRT, _cloudScissor);
                        closestPass.maskMesh.visible = true;
                        renderer.render(atmoScene, screenCam);
                        closestPass.maskMesh.visible = false;
                        disableTargetScissor(cloudRT);
                    }
                }

                // Overlay atmoRT into the same presentation target.
                disableTargetScissor(atmoRT);
                renderer.setRenderTarget(presentationTarget);
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

                if (
                    world.godRaysEnabled !== false &&
                    sunInFront &&
                    sunScreen.z > 0.0 &&
                    !underwater
                ) {
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
                        (world.godRayIntensity ?? 0.08) *
                        centerFade *
                        centerFade *
                        facing;
                    godRayMat.uniforms.uSunScreen.value.set(sx, sy);
                } else {
                    godRayMat.uniforms.uIntensity.value = 0.0;
                }

                if (godRayMat.uniforms.uIntensity.value > 0.0 && godRayRT) {
                    renderer.setRenderTarget(godRayRT);
                    renderer.setClearColor(0x000000, 0.0);
                    renderer.clear(true, false, false);
                    renderer.render(godRayScene, screenCam);

                    renderer.setRenderTarget(presentationTarget);
                    renderer.clearDepth();
                    godRayCompositeMat.uniforms.tTexture.value = godRayRT.texture;
                    renderer.render(godRayCompositeScene, screenCam);
                }

                // ============================================================
                // Underwater refraction / absorption pass
                // ============================================================
                if (
                    underwater &&
                    underwaterRT &&
                    tintMat.uniforms.uOpacity.value > 0.0
                ) {
                    const bnTex2 = world.getBlueNoiseTex
                        ? world.getBlueNoiseTex()
                        : world.blueNoiseTex;

                    tintMat.uniforms.tScene.value = underwaterRT.texture;
                    tintMat.uniforms.tDepth.value = rt.depthTexture;
                    tintMat.uniforms.uTime.value = t;
                    tintMat.uniforms.uResolution.value.set(
                        underwaterRT.width,
                        underwaterRT.height,
                    );
                    tintMat.uniforms.uInvProjMatrix.value.copy(
                        camera.projectionMatrixInverse,
                    );
                    tintMat.uniforms.uInvViewMatrix.value.copy(camera.matrixWorld);
                    tintMat.uniforms.uCameraPosW.value.copy(camera.position);
                    tintMat.uniforms.uOceanCenterW.value.copy(
                        _underwaterCenterW,
                    );
                    tintMat.uniforms.uOceanRadius.value = underwaterRadius;
                    tintMat.uniforms.uCameraDepth.value = underwaterDepth;
                    tintMat.uniforms.uLightFactor.value = underwaterLight;
                    tintMat.uniforms.uLogDepthFC.value = logDepthFC;
                    tintMat.uniforms.uNoiseTex.value = bnTex2;
                    tintMat.uniforms.uNoiseSize.value.set(
                        bnTex2?.image?.width ?? 256,
                        bnTex2?.image?.height ?? 256,
                    );

                    particlesMat.uniforms.uTime.value = t;
                    particlesMat.uniforms.uNoiseTex.value = bnTex2;
                    particlesMat.uniforms.uNoiseSize.value.set(
                        bnTex2?.image?.width ?? 256,
                        bnTex2?.image?.height ?? 256,
                    );

                    renderer.setRenderTarget(null);
                    renderer.setClearColor(0x000000, 1.0);
                    renderer.clear(true, true, false);
                    renderer.render(postScene, screenCam);
                }

                // Present player atmospheric effects after all ordinary world
                // post-processing so ocean/atmosphere/god-rays/underwater passes
                // cannot composite over either the wingtip condensation or the
                // shield. Stamp the opaque hull into depth first so both effects
                // can still respect the visible ship body.
                if (
                    shieldForegroundVisible ||
                    trailForegroundVisible ||
                    waterFxForegroundVisible
                ) {
                    renderer.setRenderTarget(null);
                    const oldLayerMask = camera.layers.mask;
                    const oldOverrideMaterial = scene.overrideMaterial;
                    const modelWasVisible = playerShip.model?.visible ?? false;
                    const shieldWasVisible =
                        playerShip.atmosphericShield?.visible ?? false;

                    renderer.clearDepth();

                    if (modelWasVisible && (playerShip.fadeFactor ?? 1.0) >= 0.98) {
                        camera.layers.set(PLAYER_SHIP_LAYER);
                        if (playerShip.atmosphericShield) {
                            playerShip.atmosphericShield.visible = false;
                        }
                        scene.overrideMaterial = playerShieldDepthMat;
                        renderer.render(scene, camera);
                        scene.overrideMaterial = oldOverrideMaterial;
                        if (playerShip.atmosphericShield) {
                            playerShip.atmosphericShield.visible = shieldWasVisible;
                        }
                    }

                    if (trailForegroundVisible) {
                        // Trail meshes use the default layer inside a dedicated
                        // scene; their body-local samples were rebuilt into current
                        // world-space ribbon vertices during the player update.
                        camera.layers.set(0);
                        renderer.render(playerShip.wingTrailScene, camera);
                    }

                    if (waterFxForegroundVisible) {
                        // Splash/spray/wake particles are also a foreground effect.
                        // Their point geometry remains body-local, while each Points
                        // object's transform mirrors its planet/moon's current world
                        // transform. Rendering here prevents ocean/atmosphere/post
                        // passes from compositing over the water interaction itself.
                        camera.layers.set(0);
                        renderer.render(surfaceWaterFxScene, camera);
                    }

                    if (shieldForegroundVisible) {
                        camera.layers.set(PLAYER_SHIP_LAYER);
                        if (playerShip.model) playerShip.model.visible = false;
                        scene.overrideMaterial = oldOverrideMaterial;
                        renderer.render(scene, camera);
                        if (playerShip.model) playerShip.model.visible = modelWasVisible;
                    }

                    if (playerShip.atmosphericShield) {
                        playerShip.atmosphericShield.visible = shieldWasVisible;
                    }
                    scene.overrideMaterial = oldOverrideMaterial;
                    camera.layers.mask = oldLayerMask;
                }

                // Warp overlay on top of everything
                const warpOverlayVisible = warpCtrl.isOverlayVisible();
                renderWarpOverlay(renderer, warpOverlay, warpOverlayVisible);

                // The warp overlay is a fullscreen post effect that can fully cover
                // the scene (alpha = 1). Re-render the ship on top so it stays visible
                // throughout the warp sequence.
                if (
                    warpOverlayVisible &&
                    !warpCtrl.isFlashActive?.() &&
                    playerShip?.loaded &&
                    playerShip.root?.visible
                ) {
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
                flightHud.update({
                    now,
                    player,
                    bodies,
                    nearestBodyInfo: playerCtrl.nearestBodyInfo,
                    overlayOpen: playerCtrl.isGalaxyOpen?.() ?? false,
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
