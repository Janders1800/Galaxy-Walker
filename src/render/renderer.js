// src/render/renderer.js
// Frame scheduler + FPS tracking + optional dynamic quality scaling.

export function createMainLoop({
  step,
  fpsCap = 60,
  maxDt = 0.033,
  onFpsUpdate = null,
  dynamicQuality = null,
}) {
  if (typeof step !== "function") throw new Error("createMainLoop: step(dt,t,now) required");

  const frameMs = 1000 / Math.max(1, fpsCap);
  let nextFrameTime = performance.now();
  // Two clocks:
  // - lastFrameTime: real wall-clock delta between animation frames (FPS should reflect this)
  // - lastSimTime:   simulation delta (may be clamped via maxDt to keep sim stable)
  let lastFrameTime = performance.now();
  let lastSimTime = performance.now();
  let running = false;
  let rafId = 0;

  // FPS sampling
  let fpsFrames = 0;
  let fpsLast = performance.now();
  let fpsEma = 60;

  // Dynamic quality scaler (resolution/sample counts) — totally optional.
  const dyn = dynamicQuality && dynamicQuality.enabled !== false
    ? {
        target: dynamicQuality.targetFps ?? fpsCap,
        deadband: dynamicQuality.deadband ?? 8,
        minScale: dynamicQuality.minScale ?? 0.6,
        maxScale: dynamicQuality.maxScale ?? 1.0,
        adjustEveryMs: dynamicQuality.adjustEveryMs ?? 900,
        onScale: dynamicQuality.onScale,
        scale: dynamicQuality.initialScale ?? 1.0,
        lastAdjust: performance.now(),
        emaAlpha: dynamicQuality.emaAlpha ?? 0.08,
      }
    : null;

  function maybeAdjustQuality(now) {
    if (!dyn || typeof dyn.onScale !== "function") return;
    if (now - dyn.lastAdjust < dyn.adjustEveryMs) return;
    dyn.lastAdjust = now;

    const err = fpsEma - dyn.target;
    if (Math.abs(err) < dyn.deadband) return;

    // If we're under target -> reduce scale; if well above -> increase slowly.
    let s = dyn.scale;
    if (err < 0) s *= 0.90; else s *= 1.04;
    s = Math.min(dyn.maxScale, Math.max(dyn.minScale, s));

    if (Math.abs(s - dyn.scale) >= 0.02) {
      dyn.scale = s;
      dyn.onScale(s);
    }
  }

  function tick(now) {
    if (!running) return;

    if (now < nextFrameTime) {
      rafId = requestAnimationFrame(tick);
      return;
    }

    // Real frame delta (do NOT clamp; used for FPS and any frame-rate-driven logic)
    const realDt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    // Simulation delta (may be clamped to prevent tunneling / unstable integration)
    let dt = (now - lastSimTime) / 1000;
    lastSimTime = now;
    if (dt > maxDt) dt = maxDt;

    const t = now * 0.001;
    step(dt, t, now);

    // FPS
    fpsFrames++;
    if (now - fpsLast >= 250) {
      // Use wall-clock time so FPS can drop below 30 even if sim dt is clamped.
      const elapsedMs = Math.max(1, now - fpsLast);
      const fps = (fpsFrames * 1000) / elapsedMs;
      fpsFrames = 0;
      fpsLast = now;

      // EMA for stability
      if (dyn) {
        fpsEma = fpsEma + (fps - fpsEma) * dyn.emaAlpha;
        maybeAdjustQuality(now);
      }

      if (onFpsUpdate) onFpsUpdate(fps, fpsEma);
    }

    nextFrameTime += frameMs;
    if (now - nextFrameTime > 250) nextFrameTime = now;

    rafId = requestAnimationFrame(tick);
  }

  return {
    start() {
      if (running) return;
      running = true;
      nextFrameTime = performance.now();
      lastFrameTime = performance.now();
      lastSimTime = performance.now();
      fpsFrames = 0;
      fpsLast = performance.now();
      rafId = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    },
    get running() {
      return running;
    },
    get qualityScale() {
      return dyn ? dyn.scale : 1.0;
    },
  };
}
