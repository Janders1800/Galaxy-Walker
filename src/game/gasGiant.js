import { THREE } from "../render/device.js";
import { createGasGiantMaterial } from "./gasGiantMaterial.js";

// Simple collision-less gas giant body:
// - Opaque DoubleSide sphere
// - No terrain, no ocean
// - Has atmosphere pass (cloudless via cfg.hasClouds=false)
export class GasGiantBody {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.bodyId = -1;
    this.group = new THREE.Group();

    this.phase = cfg.phase ?? Math.random() * Math.PI * 2;
    this.spinSpeed = (Math.PI * 2) / (cfg.dayLength ?? 2800);

    this.baseRadius = cfg.baseRadius ?? 3200;
    this.heightAmp = 0;

    // Flags used by other systems
    this.hasOcean = false;
    this.hasAtmo = cfg.hasAtmo !== false;
    this.collidable = false;
    this.canLand = false;
    this.isGasGiant = true;
    this.seaLevel = -1e9;

    // LOD hooks expected by the main loop
    this.activeDist = cfg.activeDist ?? this.baseRadius * 40.0;
    this.lodDist = cfg.lodDist ?? this.baseRadius * 30.0;

    // Main visual mesh
    const widthSegments = cfg.widthSegments ?? cfg.segments ?? 96;
    const heightSegments =
      cfg.heightSegments ?? Math.max(24, Math.round(widthSegments * 0.5));
    const geo = new THREE.SphereGeometry(
      this.baseRadius,
      widthSegments,
      heightSegments,
    );
    const { material, uniforms, randomizeStrip } = createGasGiantMaterial({
      seed: (cfg.seed ?? 0) >>> 0,
      volumeNoiseTexture: cfg.volumeNoiseTexture ?? null,
      volumeNoiseLayout: cfg.volumeNoiseLayout ?? null,
    });
    this.material = material;
    this.uniforms = uniforms;
    this.randomizeStrip = randomizeStrip;

    this.mesh = new THREE.Mesh(geo, material);
    // Render from both outside and inside (gas giants are meant to be fly-through).
    // Set explicitly on the Mesh material as well, to avoid any side overrides.
    this.mesh.material.side = THREE.DoubleSide;
    this.mesh.material.needsUpdate = true;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.group.add(this.mesh);

    // Per-body eclipse occluder buffers (avoid shared-array races)
    this._gasOccCenters = new Float32Array(24 * 3);
    this._gasOccRadii = new Float32Array(24);

    // Orbit capture for fly follow
    this.prevPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();
    this.currPos = new THREE.Vector3();
    this.currQuat = new THREE.Quaternion();

    this._tmpQ = new THREE.Quaternion();
    this._worldScale = new THREE.Vector3(1, 1, 1);
    this._transformCacheReady = false;
  }

  destroy() {
    try {
      if (this.mesh) {
        this.mesh.geometry?.dispose?.();
        this.mesh.material?.dispose?.();
      }
    } catch (e) {
      // ignore
    }
  }

  beginFrameCapture() {
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
  }
  endFrameCapture(matrixWorldReady = false) {
    if (!matrixWorldReady) this.group.updateMatrixWorld(true);
    const hadCache = this._transformCacheReady;
    this.group.matrixWorld.decompose(
      this.currPos,
      this.currQuat,
      this._worldScale,
    );
    if (!hadCache) {
      this.prevPos.copy(this.currPos);
      this.prevQuat.copy(this.currQuat);
    }
    this._transformCacheReady = true;
  }

  updateOrbit(dt) {
    if (!this.cfg.orbitDist) return;
    this.phase += dt * (this.cfg.orbitSpeed ?? 0.004);
    const x = Math.cos(this.phase) * this.cfg.orbitDist;
    const z = Math.sin(this.phase) * this.cfg.orbitDist;
    this.group.position.set(x, 0, z);
    this.group.rotation.y += this.spinSpeed * dt;
  }

  // APIs expected by the terrain LOD loop (no-ops)
  setTerrainActive(on) {
    this.group.visible = !!on;
  }
  forceRootsOnly() {}
  updateLOD() {}

  // Minimal radius API (even though collision/landing is disabled)
  radiusAtDir() {
    return this.baseRadius;
  }
}
