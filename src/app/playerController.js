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
    chaseLag: 14.0, // higher = snappier
    camPos: new THREE.Vector3(),
  };

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

        model.traverse((o) => {
          if (o.isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
          }
        });

        // Patch ship materials so SuperPointLight does not double-illuminate them
        if (sunLight) registerSPLMaterialsIn(model, sunLight);

        root.add(model);

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
  const ROLL_ACCEL = 4.5;
  const ROLL_DAMP = 3.0;
  const ROLL_MAX = 2.6;

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
    vA: new THREE.Vector3(),
    vB: new THREE.Vector3(),
    vC: new THREE.Vector3(),
    vD: new THREE.Vector3(),
    vE: new THREE.Vector3(),
    dq: new THREE.Quaternion(),
    mLook: new THREE.Matrix4(),
    qLook: new THREE.Quaternion(),
    sunPosW: new THREE.Vector3(),
    sunAimW: new THREE.Vector3(),
    sunRight: new THREE.Vector3(),
    sunUp: new THREE.Vector3(),
    sunFwd: new THREE.Vector3(),
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
    if (!playerShip?.loaded || !playerShip.root) return;
    // Keep the ship visible during warp as well. (The warp controller may
    // temporarily lock input or change camera behavior, but the player model
    // should remain rendered throughout the effect.) Never show during the
    // full galaxy overlay.
    const warping = !!warpCtrl?.warp?.active;
    playerShip.root.visible =
      !isGalaxyOpen() && (player.mode === "fly" || warping);

    // Reset chase camera accumulator when leaving fly mode.
    if (player.mode !== "fly") playerShip.camPos.set(0, 0, 0);
  }

  function syncPlayerShipTransform() {
    if (!playerShip?.loaded || !playerShip.root) return;
    playerShip.root.position.copy(player.worldPos);
    playerShip.root.quaternion.copy(flyQuat);
    playerShip.root.updateMatrixWorld(true);
  }

  function updateFlyCamera(dt) {
    // Default: camera sits at the player position.
    if (!shipChaseActive()) {
      camera.position.copy(player.worldPos);
      camera.quaternion.copy(flyQuat);
      camera.updateMatrixWorld(true);
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

    camera.position.copy(playerShip.camPos);
    camera.quaternion.copy(flyQuat);
    camera.updateMatrixWorld(true);
  }

  // Called after a warp rebuild completes: move the player to a deterministic position
  // near the new system's star without snapping the camera unexpectedly.
  function placePlayerNearNewStar(target) {
    if (!sun) return;

    // keep flying (warp already requires fly mode)
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

    // Update optional ship model + camera.
    syncPlayerShipVisibility();
    syncPlayerShipTransform();
    // No dt in this scope; snap camera for the new spawn.
    updateFlyCamera(0);
  }

  function nearestBodyInfo(worldPos) {
    let bestI = -1,
      bestD = Infinity;
    for (let i = 0; i < bodies.length; i++) {
      const bb = bodies[i];
      const ud = bb?.group?.userData;
      if (ud?.ignoreMiniMap || ud?.ignoreMinimap || ud?.isAsteroidBelt)
        continue;
      const bPos = bb.group.getWorldPosition(tmp.vA.set(0, 0, 0));
      const d = worldPos.distanceTo(bPos);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    return { i: bestI, d: bestD };
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

    tmp.vA.copy(player.worldPos).sub(fb.prevPos);
    tmp.vA.applyQuaternion(tmp.dq);
    player.worldPos.copy(fb.currPos).add(tmp.vA);

    player.worldVel.applyQuaternion(tmp.dq);
  }

  function respawn() {
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
  }

  function toggleNoclip() {
    player.noclip = !player.noclip;

    if (player.noclip && player.mode !== "fly") {
      player.mode = "fly";
      player.followIndex = -1;
      player.worldVel.set(0, 0, 0);
      player.worldPos.copy(camera.position);
      flyQuat.copy(camera.quaternion);
      roll = 0;
      rollVel = 0;
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

    player.followIndex = -1;
    msg.textContent = "Takeoff! (Press L to land nearest.)";
  }

  function doLand() {
    if (player.mode !== "fly") return;
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
    const dirW = toPlayer.normalize();

    b.group.getWorldQuaternion(tmp.worldQuat);
    const invQ = tmp.worldQuat.clone().invert();
    const dirL = tmp.vC.copy(dirW).applyQuaternion(invQ).normalize();

    const surfaceR = b.radiusAtDir(dirL.x, dirL.y, dirL.z);
    const maxLand = surfaceR + player.height + 120.0;
    if (dist > maxLand) {
      msg.textContent = `Too far to land. Get closer to ${b.cfg.name ?? "planet"}.`;
      return;
    }

    player.mode = "walk";
    roll = 0;
    rollVel = 0;
    player.followIndex = -1;
    player.bodyIndex = near.i;
    player.dirLocal.copy(dirL);
    player.radialOffset = Math.max(0, dist - (surfaceR + player.height));
    player.radialVel = 0;
    player.onGround = player.radialOffset <= 0.001;
    player.worldVel.set(0, 0, 0);
    msg.textContent = `Landed on ${b.cfg.name ?? "planet"}.`;
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
    if (e.code === "KeyF") doTakeoff();
    if (e.code === "KeyL") doLand();
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

    const spd = sprintHeld ? player.walkSprint : player.walkSpeed;

    tmp.moveDirL
      .set(0, 0, 0)
      .addScaledVector(tmp.forwardMoveL, my)
      .addScaledVector(tmp.rightMoveL, mx);

    const moveMag = Math.min(1.0, tmp.moveDirL.length());
    if (moveMag > 1e-6) {
      tmp.moveDirL.multiplyScalar(1 / moveMag);
      const surfaceR = b.radiusAtDir(upL.x, upL.y, upL.z);
      const ang = (spd * moveMag * dt) / Math.max(surfaceR, 1.0);
      tmp.axisL.copy(tmp.moveDirL).cross(upL).normalize();
      player.dirLocal
        .applyQuaternion(tmp.qYaw.setFromAxisAngle(tmp.axisL, ang))
        .normalize();
    }

    const g = 11.5;
    if (
      (keys.has("Space") || (gp?.active && gp.buttons?.a)) &&
      player.onGround
    ) {
      player.radialVel = 7.5;
      player.onGround = false;
    }
    player.radialVel -= g * dt;
    player.radialOffset += player.radialVel * dt;

    if (player.radialOffset < 0) {
      player.radialOffset = 0;
      player.radialVel = 0;
      player.onGround = true;
    }

    const surfaceR = b.radiusAtDir(
      player.dirLocal.x,
      player.dirLocal.y,
      player.dirLocal.z,
    );
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

    // Ensure ship model (if present) stays hidden while walking.
    syncPlayerShipVisibility();
  }

  function updateFly(dt) {
    const gp = input.gamepad;
    // Keep the ship in the nearest body's co-moving frame when close.
    // This should work even if noclip is enabled (noclip should only
    // affect collision, not whether we inherit nearby body motion).
    const near = nearestBodyInfo(player.worldPos);
    applyFlyFollow(near.i);
    if (input.pointerLocked || gp?.active) {
      const { dx, dy } = input.consumeMouseDelta();
      const sens = 0.0022;
      const yawDelta = -dx * sens;
      const pitchDelta = -dy * sens;

      const fwd = tmp.lookForwardW
        .set(0, 0, -1)
        .applyQuaternion(flyQuat)
        .normalize();
      const up = tmp.lookUpW.set(0, 1, 0).applyQuaternion(flyQuat).normalize();
      const right = tmp.lookRightW.copy(fwd).cross(up).normalize();

      tmp.qYaw.setFromAxisAngle(up, yawDelta);
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
    player.worldPos.addScaledVector(player.worldVel, dt);

    updateFlyEngineSound(dt, thrust01, boost);

    if (!player.noclip) flyCollideNearestBody();

    // Update optional ship model + camera.
    syncPlayerShipVisibility();
    syncPlayerShipTransform();
    updateFlyCamera(dt);
  }

  function initialSpawn() {
    const b = bodies[0];
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
    canWarp: () => player?.mode === "fly", // only allow warping in fly mode
    getWarpDirection,
    onWarpStart: (target) => {
      msg.textContent = `Warping to ${target?.name ?? "unknown"}…`;
      // release pointer lock so the overlay feels clean
      if (document.pointerLockElement) document.exitPointerLock();
      input.resetMouse();
      // ensure we are in a safe state
      player.followIndex = -1;
      player.worldVel.set(0, 0, 0);
      // player.worldPos is the canonical ship/player position.
      // If the camera is offset (chase cam), do NOT pull worldPos from it.
      if (!shipChaseActive()) player.worldPos.copy(camera.position);
      flyQuat.copy(camera.quaternion);
      roll = 0;
      rollVel = 0;
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
    updateWalk,
    updateFly,
    stopFlyEngineAudio,
  };
}
