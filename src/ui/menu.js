// src/ui/menu.js
// Main menu overlay (Begin / Quality / Sound / Controls)

const LS_KEY_QUALITY = "gw_quality";
const LS_KEY_MUTED = "gw_muted";

// NOTE: the world seed is intentionally NOT persisted between executions.

// Ring dust sliders (planet rings)
const LS_RINGDUST = {
  opacity: "gw_ringDust_opacity",
  fade: "gw_ringDust_fade",
  brightness: "gw_ringDust_brightness",
  noiseScale: "gw_ringDust_noiseScale",
  windSpeed: "gw_ringDust_windSpeed",
  eclipseSoftness: "gw_ringDust_eclipseSoftness",
  eclipseStrength: "gw_ringDust_eclipseStrength",
};

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

// --- Seed helpers (non-persisted) ---
function fnv1a32(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function parseSeed(raw) {
  const s = (raw ?? "").trim();
  if (!s) return null;
  // Accept decimal and 0x-prefixed hex. Otherwise hash the string.
  if (/^0x[0-9a-f]+$/i.test(s)) return (parseInt(s, 16) >>> 0);
  if (/^[0-9]+$/.test(s)) return (parseInt(s, 10) >>> 0);
  return fnv1a32(s);
}

function randomSeed32() {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] >>> 0;
  } catch {
    return ((Date.now() ^ ((Math.random() * 0xffffffff) | 0)) >>> 0);
  }
}

export function getSavedRingDustParams() {
  const d = {
    opacity: 0.65,
    fade: 0.10,
    brightness: 1.85,
    noiseScale: 0.00012,
    windSpeed: 0.035,
    eclipseSoftness: 0.015,
    eclipseStrength: 1.0,
  };
  try {
    const f = (k, def) => {
      const v = parseFloat(localStorage.getItem(k) || "");
      return Number.isFinite(v) ? v : def;
    };
    d.opacity = clamp(f(LS_RINGDUST.opacity, d.opacity), 0, 1.5);
    d.fade = clamp(f(LS_RINGDUST.fade, d.fade), 0.02, 0.40);
    d.brightness = clamp(f(LS_RINGDUST.brightness, d.brightness), 0, 4);
    d.noiseScale = clamp(f(LS_RINGDUST.noiseScale, d.noiseScale), 0.00003, 0.00035);
    d.windSpeed = clamp(f(LS_RINGDUST.windSpeed, d.windSpeed), 0, 0.15);
    d.eclipseSoftness = clamp(f(LS_RINGDUST.eclipseSoftness, d.eclipseSoftness), 0.005, 0.06);
    d.eclipseStrength = clamp(f(LS_RINGDUST.eclipseStrength, d.eclipseStrength), 0, 1);
  } catch {}
  return d;
}

function saveRingDustParams(p) {
  try {
    localStorage.setItem(LS_RINGDUST.opacity, String(p.opacity));
    localStorage.setItem(LS_RINGDUST.fade, String(p.fade));
    localStorage.setItem(LS_RINGDUST.brightness, String(p.brightness));
    localStorage.setItem(LS_RINGDUST.noiseScale, String(p.noiseScale));
    localStorage.setItem(LS_RINGDUST.windSpeed, String(p.windSpeed));
    localStorage.setItem(LS_RINGDUST.eclipseSoftness, String(p.eclipseSoftness));
    localStorage.setItem(LS_RINGDUST.eclipseStrength, String(p.eclipseStrength));
  } catch {}
}

let _ringDustApplier = null;
export function setMenuRingDustApplier(fn) {
  _ringDustApplier = (typeof fn === "function") ? fn : null;
}

let _audioProvider = null;
// Provide audio API after boot so in-game toggles apply immediately.
export function setMenuAudioProvider(fn) {
  _audioProvider = (typeof fn === 'function') ? fn : null;
}

function safeGet(id) {
  return /** @type {HTMLElement|null} */ (document.getElementById(id));
}

function clampQualityValue(v) {
  // Keep in sync with the options in index.html and core/config.js.
  const allowed = new Set(["Potato", "Laptop", "Descktop", "Desktop", "GamingPC", "NASA"]);
  return allowed.has(v) ? v : null;
}

export function applySavedMenuSettings({ world, playerCtrl } = {}) {
  // Quality: set the select value BEFORE createWorld() reads it.
  try {
    const savedQ = clampQualityValue(localStorage.getItem(LS_KEY_QUALITY) || "");
    const sel = /** @type {HTMLSelectElement|null} */ (safeGet("qualitySelect"));
    if (sel && savedQ) {
      sel.value = savedQ === "Desktop" ? "Descktop" : savedQ;
    }
  } catch {}

  // Muted: can be applied after playerController exists.
  try {
    const muted = localStorage.getItem(LS_KEY_MUTED) === "1";
    if (playerCtrl?.audio?.setMuted) playerCtrl.audio.setMuted(muted);
  } catch {}

  // Ring dust sliders: set persisted values into the UI inputs (if present)
  // and optionally apply to the world.
  try {
    const p = getSavedRingDustParams();
    const setV = (id, v) => {
      const el = /** @type {HTMLInputElement|null} */ (safeGet(id));
      if (el) el.value = String(v);
    };
    setV("ringDustOpacity", p.opacity);
    setV("ringDustFade", p.fade);
    setV("ringDustBrightness", p.brightness);
    setV("ringDustNoiseScale", p.noiseScale);
    setV("ringDustWindSpeed", p.windSpeed);
    setV("ringDustEclipseSoftness", p.eclipseSoftness);
    setV("ringDustEclipseStrength", p.eclipseStrength);
    try { world?.setRingDustParams?.(p); } catch {}
  } catch {}

  // Optional: let the world know on boot if needed.
  try {
    if (world?.setMuted) world.setMuted(localStorage.getItem(LS_KEY_MUTED) === "1");
  } catch {}
}

function isMutedLS() {
  try { return localStorage.getItem(LS_KEY_MUTED) === "1"; } catch { return false; }
}

function setMutedLS(m) {
  try { localStorage.setItem(LS_KEY_MUTED, m ? "1" : "0"); } catch {}
}

export function initMainMenu({ onStart } = {}) {
  const splash = safeGet("splashOverlay");
  const splashLogo = /** @type {HTMLImageElement|null} */ (safeGet("splashLogo"));

  const menu = safeGet("mainMenu");
  const startBtn = /** @type {HTMLButtonElement|null} */ (safeGet("startBtn"));
  const soundBtn = /** @type {HTMLButtonElement|null} */ (safeGet("soundToggleBtn"));
  const controlsBtn = /** @type {HTMLButtonElement|null} */ (safeGet("controlsBtn"));
  const controls = safeGet("controlsOverlay");
  const controlsClose = /** @type {HTMLButtonElement|null} */ (safeGet("controlsClose"));
  const qualitySel = /** @type {HTMLSelectElement|null} */ (safeGet("qualitySelect"));
  const seedInput = /** @type {HTMLInputElement|null} */ (safeGet("seedInput"));
  const loading = safeGet("loadingOverlay");

  const menuPanel = /** @type {HTMLElement|null} */ (safeGet("menuPanel"));
  const optionsBtn = /** @type {HTMLButtonElement|null} */ (safeGet("optionsBtn"));
  const extrasBtn = /** @type {HTMLButtonElement|null} */ (safeGet("extrasBtn"));
  const optionsBackBtn = /** @type {HTMLButtonElement|null} */ (safeGet("optionsBackBtn"));

  const showMenu = () => {
    if (menu) menu.classList.remove("off");
  };
  const hideMenu = () => {
    if (menu) menu.classList.add("off");
  };

  // ---- Splash sequence (MassiveEngine.png) ----
  // Start with menu hidden; show it after splash fades out.
  if (menu) menu.classList.add("off");

  const endSplash = () => {
    try { splash?.classList.add("off"); } catch {}
    showMenu();
  };

  if (splash && splashLogo) {
    // Ensure we always proceed, even if the image fails to load.
    const fallbackTimer = window.setTimeout(() => {
      if (!splash.classList.contains("off")) endSplash();
    }, 2800);

    splashLogo.addEventListener(
      "animationend",
      () => {
        window.clearTimeout(fallbackTimer);
        endSplash();
      },
      { once: true }
    );
    splashLogo.addEventListener(
      "error",
      () => {
        window.clearTimeout(fallbackTimer);
        endSplash();
      },
      { once: true }
    );
  } else {
    // No splash markup; show the menu immediately.
    endSplash();
  }

  // If the menu markup is missing, fail gracefully.
  if (!menu || !startBtn || !soundBtn || !controlsBtn || !controls || !controlsClose) {
    document.body.classList.remove("prestart");
    try { onStart?.(); } catch {}
    return { openOptionsInGame: () => {}, closeOptionsInGame: () => {} };
  }

  // ---- Quality ----
  if (qualitySel) {
    const saveQuality = () => {
      try {
        const v = clampQualityValue(qualitySel.value);
        if (v) localStorage.setItem(LS_KEY_QUALITY, v);
      } catch {}
    };
    qualitySel.addEventListener("change", saveQuality);
    saveQuality();
  }

  // ---- Sound (localStorage-driven; applied to audio on boot) ----
  function renderSoundButton() {
    const muted = isMutedLS();
    soundBtn.textContent = muted ? "Off" : "On";
    soundBtn.setAttribute("aria-pressed", muted ? "true" : "false");
  }
  renderSoundButton();

  soundBtn.addEventListener("click", () => {
    const audioNow = _audioProvider ? _audioProvider() : null;
    setMutedLS(!isMutedLS());
    try { audioNow?.setMuted?.(isMutedLS()); } catch {}
    renderSoundButton();
  });

	  // ---- Options pane (in-panel) ----
const openOptions = () => {
  if (menuPanel) menuPanel.classList.add("optionsOpen");
  qualitySel?.focus?.();
};
const closeOptions = () => {
  if (menuPanel) menuPanel.classList.remove("optionsOpen");
  optionsBtn?.focus?.();
};

function openOptionsInGame() {
  if (!menu || !menuPanel) return;
  // Show the same options UI, but without returning to the main menu.
  menu.classList.remove('off');
  menu.classList.add('ingame');
  menuPanel.classList.add('optionsOpen');
  try { document.exitPointerLock?.(); } catch {}
  if (optionsBackBtn) optionsBackBtn.textContent = 'Resume';
  qualitySel?.focus?.();
}
function closeOptionsInGame() {
  if (!menu || !menuPanel) return;
  menuPanel.classList.remove('optionsOpen');
  menu.classList.remove('ingame');
  menu.classList.add('off');
  if (optionsBackBtn) optionsBackBtn.textContent = 'Back';
}

optionsBtn?.addEventListener("click", openOptions);
optionsBackBtn?.addEventListener('click', () => {
  if (menu?.classList.contains('ingame')) closeOptionsInGame();
  else closeOptions();
});

// ---- Controls overlay ----
  const openControls = () => {
    controls.classList.remove("off");
    controlsClose.focus?.();
  };
  const closeControls = () => {
    controls.classList.add("off");
    controlsBtn.focus?.();
  };
  controlsBtn.addEventListener("click", openControls);
  extrasBtn?.addEventListener("click", openControls);

  controlsClose.addEventListener("click", closeControls);
  controls.addEventListener("click", (e) => {
    if (e.target === controls) closeControls();
  });
  window.addEventListener("keydown", (e) => {
    if (e.code === "Escape" && !controls.classList.contains("off")) closeControls();
    if (e.code === 'Escape' && menuPanel && menuPanel.classList.contains('optionsOpen')) {
      if (menu?.classList.contains('ingame')) closeOptionsInGame();
      else closeOptions();
    }
  });

  // ---- Begin -> Loading -> Game ----
  let started = false;

  const showLoading = () => {
    try { loading?.classList.remove("off"); } catch {}
  };
  const hideLoading = () => {
    try { loading?.classList.add("off"); } catch {}
  };

  const doStart = () => {
    if (started) return;
    started = true;

    // Hide menu, reveal HUD (behind the loading overlay).
    hideMenu();
    document.body.classList.remove("prestart");

    showLoading();

    // Resolve the seed once at start.
    // - If the field is filled, use it.
    // - Otherwise generate one.
    // - Always reflect the in-use seed back into the UI.
    //
    // Secret seed: typing "Solar" loads a special preset system.
    const rawSeed = (seedInput?.value ?? "").trim();
    const isSolarSecret = rawSeed.toLowerCase() === "solar";

    let usedSeed = null;
    let preset = null;
    try {
      usedSeed = parseSeed(rawSeed);
      if (usedSeed == null) usedSeed = randomSeed32();
    } catch {
      usedSeed = randomSeed32();
    }

    if (isSolarSecret) {
      preset = "solar_secret";
      // Keep the magic word in the UI.
      if (seedInput) seedInput.value = "Solar";
    } else {
      if (seedInput) seedInput.value = String(usedSeed >>> 0);
    }

    // Let the browser paint the loading overlay first.
    requestAnimationFrame(async () => {
      try {
        await onStart?.({ seed: usedSeed >>> 0, preset });
      } catch (err) {
        // If boot fails, bring the menu back so the user isn't stuck.
        console.error(err);
        started = false;
        hideLoading();
        showMenu();
        return;
      }

      // Give the renderer a frame or two, then fade loading out.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          hideLoading();
        });
      });
    });
  };

  startBtn.addEventListener("click", doStart);
  window.addEventListener("keydown", (e) => {
    if (e.code === "Enter" && !controls.classList.contains("off")) return;
    if (e.code === "Enter" && menuPanel && menuPanel.classList.contains("optionsOpen")) return;
    if (e.code === "Enter" && !started) doStart();
  });

  return { openOptionsInGame, closeOptionsInGame };
}
