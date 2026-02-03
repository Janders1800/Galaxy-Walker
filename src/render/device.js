// src/render/device.js
import * as THREE from "three";

export function createRenderer({
  antialias = false,
  logarithmicDepthBuffer = true,
} = {}) {
  const renderer = new THREE.WebGLRenderer({
    antialias,
    logarithmicDepthBuffer,
    powerPreference: "high-performance",
  });

  renderer.outputColorSpace = THREE.SRGBColorSpace;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // We manage shadow updates manually for perf
  renderer.shadowMap.autoUpdate = false;

  renderer.autoClear = false;
  renderer.autoClearColor = false;
  renderer.autoClearDepth = false;
  renderer.autoClearStencil = false;

  renderer.toneMapping = THREE.NoToneMapping;
  renderer.toneMappingExposure = 1.0;

  renderer.domElement.style.display = "block";
  renderer.domElement.tabIndex = 0;

  return renderer;
}

export { THREE };
