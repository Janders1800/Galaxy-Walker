// src/core/input.js
// Pointer-lock + keyboard/mouse + gamepad input handling.

export function createInput(targetEl, { crosshairEl = null, msgEl = null } = {}) {
  if (!targetEl) throw new Error("createInput: targetEl is required");

  const keys = new Set();
  let pointerLocked = false;
  let mouseDX = 0;
  let mouseDY = 0;

  // ------------------------------------------------------------
  // Gamepad state (polled).
  // Notes:
  // - We do NOT synthesize keyboard events. The game reads this state directly.
  // - We accumulate right-stick look into mouseDX/mouseDY so existing look code works.
  // ------------------------------------------------------------
  const gp = {
    active: false,
    index: -1,
    id: "",
    mapping: "",
    lx: 0,
    ly: 0,
    rx: 0,
    ry: 0,
    lt: 0,
    rt: 0,
    buttons: {
      a: false,
      b: false,
      x: false,
      y: false,
      lb: false,
      rb: false,
      back: false,
      start: false,
      ls: false,
      rs: false,
      du: false,
      dd: false,
      dl: false,
      dr: false,
    },
    pressed: {
      a: false,
      b: false,
      x: false,
      y: false,
      lb: false,
      rb: false,
      back: false,
      start: false,
      ls: false,
      rs: false,
      du: false,
      dd: false,
      dl: false,
      dr: false,
    },
  };

  // Previous button values for edge detection.
  let _gpPrev = null;

  const GP_DEADZONE = 0.16;
  const GP_LOOK_PIXELS_PER_SEC = 900; // fed into existing mouse-based look (scaled by dt)
  const GP_TRIGGER_DEADZONE = 0.08;

  function _dz(v, dz = GP_DEADZONE) {
    const av = Math.abs(v);
    if (av <= dz) return 0;
    const s = (av - dz) / (1 - dz);
    return Math.sign(v) * Math.min(1, Math.max(0, s));
  }

  function _b(btn) {
    // GamepadButton | number
    if (btn == null) return 0;
    if (typeof btn === "number") return btn;
    return btn.pressed ? 1 : 0;
  }

  function _v(btn) {
    if (btn == null) return 0;
    if (typeof btn === "number") return btn;
    return typeof btn.value === "number" ? btn.value : (btn.pressed ? 1 : 0);
  }

  function _pickGamepadIndex() {
    const pads = navigator.getGamepads?.() || [];
    // Prefer an existing index if it still exists.
    if (gp.index >= 0 && pads[gp.index]) return gp.index;
    // Otherwise pick the first non-null pad.
    for (let i = 0; i < pads.length; i++) {
      if (pads[i]) return i;
    }
    return -1;
  }

  function _readButtons(pad) {
    // Standard mapping indices (https://w3c.github.io/gamepad/)
    const b = pad.buttons || [];
    return {
      a: !!_b(b[0]),
      b: !!_b(b[1]),
      x: !!_b(b[2]),
      y: !!_b(b[3]),
      lb: !!_b(b[4]),
      rb: !!_b(b[5]),
      back: !!_b(b[8]),
      start: !!_b(b[9]),
      ls: !!_b(b[10]),
      rs: !!_b(b[11]),
      du: !!_b(b[12]),
      dd: !!_b(b[13]),
      dl: !!_b(b[14]),
      dr: !!_b(b[15]),
    };
  }

  function _edgePressed(nowButtons, prevButtons) {
    const out = {};
    for (const k of Object.keys(nowButtons)) {
      out[k] = !!nowButtons[k] && !(prevButtons?.[k] ?? false);
    }
    return out;
  }

  function setHudLockedState(locked) {
    if (crosshairEl) crosshairEl.classList.toggle("on", locked);
    if (msgEl) msgEl.textContent = locked ? "Pointer locked." : "Click to lock pointer.";
  }

  const onPointerDown = () => {
    try { targetEl.focus?.(); } catch {}
    try { targetEl.requestPointerLock?.(); } catch {}
  };

  const onPointerLockChange = () => {
    pointerLocked = document.pointerLockElement === targetEl;
    setHudLockedState(pointerLocked);
    if (!pointerLocked) {
      mouseDX = 0;
      mouseDY = 0;
    }
  };

  const onMouseMove = (e) => {
    if (!pointerLocked) return;
    mouseDX += e.movementX || 0;
    mouseDY += e.movementY || 0;
  };

  const onKeyDown = (e) => {
    keys.add(e.code);
  };

  const onKeyUp = (e) => {
    keys.delete(e.code);
  };

  const onGamepadConnected = (e) => {
    // Just hint that a pad exists; actual selection happens in update().
    if (gp.index < 0) gp.index = e.gamepad?.index ?? gp.index;
  };

  const onGamepadDisconnected = (e) => {
    if (gp.index === (e.gamepad?.index ?? -999)) {
      gp.index = -1;
      gp.active = false;
      gp.id = "";
      gp.mapping = "";
      _gpPrev = null;
    }
  };

  targetEl.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  document.addEventListener("mousemove", onMouseMove);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("gamepadconnected", onGamepadConnected);
  window.addEventListener("gamepaddisconnected", onGamepadDisconnected);

  return {
    keys,
    gamepad: gp,
    get pointerLocked() {
      return pointerLocked;
    },
    /**
     * Poll the Gamepad API once per frame.
     * - Updates `input.gamepad` (axes/buttons)
     * - Accumulates right-stick look into the existing mouse delta accumulator
     */
    update(dt = 0) {
      const idx = _pickGamepadIndex();
      if (idx < 0) {
        gp.active = false;
        gp.index = -1;
        gp.id = "";
        gp.mapping = "";
        gp.lx = gp.ly = gp.rx = gp.ry = 0;
        gp.lt = gp.rt = 0;
        // Clear pressed edges
        for (const k of Object.keys(gp.pressed)) gp.pressed[k] = false;
        _gpPrev = null;
        return;
      }

      const pad = (navigator.getGamepads?.() || [])[idx];
      if (!pad) {
        gp.active = false;
        gp.index = -1;
        _gpPrev = null;
        return;
      }

      gp.active = true;
      gp.index = idx;
      gp.id = pad.id || "";
      gp.mapping = pad.mapping || "";

      const ax = pad.axes || [];
      gp.lx = _dz(ax[0] ?? 0);
      gp.ly = _dz(ax[1] ?? 0);
      gp.rx = _dz(ax[2] ?? 0);
      gp.ry = _dz(ax[3] ?? 0);

      // Triggers (standard mapping 6/7 as axes-like values)
      const b = pad.buttons || [];
      gp.lt = Math.max(0, _v(b[6]));
      gp.rt = Math.max(0, _v(b[7]));
      if (gp.lt < GP_TRIGGER_DEADZONE) gp.lt = 0;
      if (gp.rt < GP_TRIGGER_DEADZONE) gp.rt = 0;

      const nowButtons = _readButtons(pad);
      const prevButtons = _gpPrev || nowButtons;
      gp.pressed = _edgePressed(nowButtons, prevButtons);
      gp.buttons = nowButtons;
      _gpPrev = { ...nowButtons };

      // Right stick look -> mouse-like deltas (so existing look code works).
      if (dt > 0) {
        mouseDX += gp.rx * GP_LOOK_PIXELS_PER_SEC * dt;
        mouseDY += gp.ry * GP_LOOK_PIXELS_PER_SEC * dt;
      }
    },
    consumeMouseDelta() {
      const dx = mouseDX;
      const dy = mouseDY;
      mouseDX = 0;
      mouseDY = 0;
      return { dx, dy };
    },
    resetMouse() {
      mouseDX = 0;
      mouseDY = 0;
    },
    destroy() {
      targetEl.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      document.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("gamepadconnected", onGamepadConnected);
      window.removeEventListener("gamepaddisconnected", onGamepadDisconnected);
      keys.clear();
      pointerLocked = false;
      mouseDX = mouseDY = 0;
      setHudLockedState(false);
    },
  };
}
