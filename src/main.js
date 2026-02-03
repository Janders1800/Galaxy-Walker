// src/main.js — app entrypoint

import { createWorld } from "./app/world.js";
import { createPlayerController } from "./app/playerController.js";
import { startGameLoop } from "./app/loop.js";
import { applySavedMenuSettings, getSavedRingDustParams, initMainMenu, setMenuAudioProvider, setMenuRingDustApplier } from "./ui/menu.js";

// Apply persisted UI settings (quality) before createWorld() reads the select.
applySavedMenuSettings();

let booted = false;

const menuApi = initMainMenu({
  onStart: async ({ seed, preset } = {}) => {
    if (booted) return;
    booted = true;

    const world = createWorld({ seed, preset });
    const playerCtrl = createPlayerController(world);

	    // Wire ring-dust sliders -> live update planet ring dust uniforms.
	    try { setMenuRingDustApplier((p) => world?.setRingDustParams?.(p)); } catch {}
	    try { world?.setRingDustParams?.(getSavedRingDustParams()); } catch {}

    // Allow in-game menu toggles to apply immediately.
    // Provide a composite audio API so the mute toggle affects both the ship/warp synth
    // and any world-level music (e.g. the Solar secret level track).
    try {
      setMenuAudioProvider(() => ({
        setMuted: (m) => {
          try { playerCtrl?.audio?.setMuted?.(!!m); } catch {}
          try { world?.setMuted?.(!!m); } catch {}
        },
        isMuted: () => {
          try {
            const pm = playerCtrl?.audio?.isMuted?.();
            if (typeof pm === "boolean") return pm;
          } catch {}
          try { return !!world?.isMuted?.(); } catch {}
          return false;
        },
        toggleMuted: () => {
          let cur = false;
          try {
            const pm = playerCtrl?.audio?.isMuted?.();
            if (typeof pm === "boolean") cur = pm;
          } catch {}
          try { if (!cur) cur = !!world?.isMuted?.(); } catch {}
          const next = !cur;
          try { playerCtrl?.audio?.setMuted?.(next); } catch {}
          try { world?.setMuted?.(next); } catch {}
          return next;
        },
      }));
    } catch {}

    // HUD Options button opens the same options pane used by the main menu.
    try {
      const btn = document.getElementById('hudOptionsBtn');
      btn?.addEventListener('click', () => menuApi?.openOptionsInGame?.());
    } catch {}

    // Apply persisted mute state now that player controller exists.
    applySavedMenuSettings({ world, playerCtrl });

    // Let the world module request a post-warp spawn without importing player code.
    world.setOnPlacePlayerNearNewStar?.(playerCtrl.placePlayerNearNewStar);

    startGameLoop(world, playerCtrl);

    // The minimap canvas can initialize at 0x0 while hidden; force a resize once the
    // game has rendered at least one frame.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    try {
      playerCtrl?.galaxyMiniMapUI?.resize?.();
    } catch {}
  },
});