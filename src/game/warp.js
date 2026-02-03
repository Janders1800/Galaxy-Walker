// Warp overlay (fullscreen post effect) — V-Drop tunnel style
// https://www.shadertoy.com/view/wsKXRK
// ============================================================================
export function createWarpOverlayLegacy(THREE, width, height) {
    const warpScene = new THREE.Scene();
    const warpCam = new THREE.OrthographicCamera(
        -1,
        1,
        1,
        -1,
        0,
        1,
    );

    const warpMat = new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: false,
        uniforms: {
            uTime: { value: 0 },
            uStrength: { value: 0 },
            uFade: { value: 0 },
            uResolution: {
                value: new THREE.Vector2(width, height),
            },
            uVerticalMode: { value: 0.0 },
        },
        vertexShader: `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`,
        fragmentShader: `
precision highp float;
varying vec2 vUv;

uniform float uTime;
uniform float uStrength;
uniform float uFade;
uniform vec2  uResolution;
uniform float uVerticalMode;

#define PI 3.141592653589793

float vDrop(vec2 uv,float t)
{
  uv.x = uv.x*128.0;
  float dx = fract(uv.x);
  uv.x = floor(uv.x);
  uv.y *= 0.05;
  float o=sin(uv.x*215.4);
  float s=cos(uv.x*33.1)*.3 +.7;
  float trail = mix(95.0,35.0,s);
  float yv = fract(uv.y + t*s + o) * trail;
  yv = 1.0/max(yv, 1e-4);
  yv = smoothstep(0.0,1.0,yv*yv);
  yv = sin(yv*PI)*(s*5.0);
  float d2 = sin(dx*PI);
  return yv*(d2*d2);
}

void main(){
  float s = clamp(uStrength, 0.0, 1.0);
  float a = clamp(uFade, 0.0, 1.0);
  if (a <= 0.0001) { gl_FragColor = vec4(0.0); return; }

  vec2 fragCoord = vUv * uResolution;
  vec2 p = (fragCoord.xy - 0.5 * uResolution.xy) / max(uResolution.y, 1.0);

  float d = length(p)+0.1;
  p = vec2(atan(p.x, p.y) / PI, 2.5 / max(d, 1e-4));
  if (uVerticalMode > 0.5) p.y *= 0.5;

  float t =  uTime*0.4;

  vec3 col = vec3(1.55,0.65,.225) * vDrop(p,t);
  col += vec3(0.55,0.75,1.225) * vDrop(p,t+0.33);
  col += vec3(0.45,1.15,0.425) * vDrop(p,t+0.66);

  col *= (d*d);
  col *= s;

  gl_FragColor = vec4(col, a);
}
`,
    });

    const warpQuad = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        warpMat,
    );
    warpQuad.frustumCulled = false;
    warpScene.add(warpQuad);

    return { warpScene, warpCam, warpMat };
}

export function resizeWarpOverlayLegacy(warpMat, w, h) {
    warpMat.uniforms.uResolution.value.set(w, h);
}

export function makeChargeUI(chargeUIEl) {
    const el = chargeUIEl;

    // Fixed-length bar that fills outward from the center.
    // Keep this even so the center is between two characters.
    const BAR_LEN = 28;
    const HALF = BAR_LEN / 2;

    function makeCenterFillBar(progress01) {
        const p = Math.max(0, Math.min(1, progress01));

        // Fill symmetrically; keep the fill even for nice centering.
        let filled = Math.round(p * BAR_LEN);
        if (filled % 2 === 1) filled -= 1;
        filled = Math.max(0, Math.min(BAR_LEN, filled));

        const side = filled / 2;
        const pad = HALF - side;
        return (
            " ".repeat(pad) +
            "|".repeat(side) +
            "|".repeat(side) +
            " ".repeat(pad)
        );
    }

    function setCharging(progress01) {
        const bar = makeCenterFillBar(progress01);
        el.textContent = `CHARGING\n[${bar}]`;
        el.classList.add("on");
    }

    function setCountdown(secondsLeft) {
        // Countdown replaces the "CHARGING" line, but the bar stays visible.
        // Display format: seconds:hundredths (e.g., 300:00 for 5 minutes).
        const remainingHund = Math.max(0, Math.ceil(secondsLeft * 100));
        const secs = Math.floor(remainingHund / 100);
        const hund = remainingHund % 100;

        const sStr = secs.toString().padStart(2, "0");
        const hStr = hund.toString().padStart(2, "0");

        const inside = "|".repeat(BAR_LEN);
        el.textContent = `${sStr}:${hStr}\n[${inside}]`;
        el.classList.add("on");
    }

    function hide() {
        el.classList.remove("on");
    }

    return { setCharging, setCountdown, hide };
}

// ============================================================================
// Warp CHARGE sound + countdown beeps
// ============================================================================
export function makeChargeSound() {
    let audioCtx = null;
    let chargeSnd = null;
    let muted = false;
    let masterGainSaved = 0.9;

    function applyMuteState() {
        if (!chargeSnd?.master) return;
        // Preserve the last non-zero gain so unmute feels consistent.
        if (!muted) {
            chargeSnd.master.gain.value = masterGainSaved;
        } else {
            // Save only if currently non-zero.
            const g = chargeSnd.master.gain.value;
            if (g > 0.0001) masterGainSaved = g;
            chargeSnd.master.gain.value = 0.0;
        }
    }

    function ensureAudio() {
        if (audioCtx) return;
        audioCtx = new (
            window.AudioContext || window.webkitAudioContext
        )();

        function makeImpulse(seconds = 1.2, decay = 3.0) {
            const rate = audioCtx.sampleRate;
            const len = Math.floor(rate * seconds);
            const buf = audioCtx.createBuffer(2, len, rate);
            for (let ch = 0; ch < 2; ch++) {
                const d = buf.getChannelData(ch);
                for (let i = 0; i < len; i++) {
                    const t = i / len;
                    d[i] =
                        (Math.random() * 2 - 1) *
                        Math.pow(1 - t, decay);
                }
            }
            return buf;
        }

        const convolver = audioCtx.createConvolver();
        convolver.buffer = makeImpulse();

        const wet = audioCtx.createGain();
        wet.gain.value = 0.0;
        const dry = audioCtx.createGain();
        dry.gain.value = 1.0;

        const master = audioCtx.createGain();
        master.gain.value = masterGainSaved;

        dry.connect(master);
        convolver.connect(wet);
        wet.connect(master);
        master.connect(audioCtx.destination);

        chargeSnd = {
            convolver,
            wet,
            dry,
            master,
            osc: null,
            sub: null,
            noise: null,
            noiseGain: null,
            subGain: null,
            filter: null,
            outGain: null,
            lfo: null,
            lfoGain: null,
            active: false,
        };

        applyMuteState();
    }

    function resume() {
        ensureAudio();
        if (audioCtx && audioCtx.state !== "running")
            return audioCtx.resume().catch(() => {});
    }

    function start() {
        ensureAudio();
        if (!chargeSnd || chargeSnd.active) return;

        const now = audioCtx.currentTime;

        const outGain = audioCtx.createGain();
        outGain.gain.value = 0.0;
        outGain.connect(chargeSnd.dry);
        outGain.connect(chargeSnd.convolver);

        const filter = audioCtx.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 160;
        filter.Q.value = 0.35;
        filter.connect(outGain);

        const osc = audioCtx.createOscillator();
        osc.type = "triangle";
        osc.frequency.value = 55;

        const oscGain = audioCtx.createGain();
        oscGain.gain.value = 0.12;
        osc.connect(oscGain);
        oscGain.connect(filter);

        const sub = audioCtx.createOscillator();
        sub.type = "sine";
        sub.frequency.value = 32;

        const subGain = audioCtx.createGain();
        subGain.gain.value = 0.0;
        sub.connect(subGain);
        subGain.connect(filter);

        const noiseBuf = audioCtx.createBuffer(
            1,
            audioCtx.sampleRate * 2,
            audioCtx.sampleRate,
        );
        const nd = noiseBuf.getChannelData(0);
        for (let i = 0; i < nd.length; i++)
            nd[i] = Math.random() * 2 - 1;

        const noise = audioCtx.createBufferSource();
        noise.buffer = noiseBuf;
        noise.loop = true;

        const noiseGain = audioCtx.createGain();
        noiseGain.gain.value = 0.0;
        noise.connect(noiseGain);
        noiseGain.connect(filter);

        const lfo = audioCtx.createOscillator();
        lfo.type = "sine";
        lfo.frequency.value = 2.0;

        const lfoGain = audioCtx.createGain();
        lfoGain.gain.value = 0.0;
        lfo.connect(lfoGain);
        lfoGain.connect(outGain.gain);

        osc.start(now);
        sub.start(now);
        noise.start(now);
        lfo.start(now);

        chargeSnd.osc = osc;
        chargeSnd.sub = sub;
        chargeSnd.noise = noise;
        chargeSnd.noiseGain = noiseGain;
        chargeSnd.subGain = subGain;
        chargeSnd.filter = filter;
        chargeSnd.outGain = outGain;
        chargeSnd.lfo = lfo;
        chargeSnd.lfoGain = lfoGain;
        chargeSnd.active = true;

        outGain.gain.setValueAtTime(0.0, now);
        outGain.gain.linearRampToValueAtTime(0.05, now + 0.08);

        chargeSnd.wet.gain.setValueAtTime(0.2, now);
    }

    function update(p01) {
        if (!chargeSnd || !chargeSnd.active) return;

        const now = audioCtx.currentTime;
        const k = Math.pow(Math.max(0, Math.min(1, p01)), 1.35);

        chargeSnd.filter.frequency.setTargetAtTime(
            160 + 1700 * k,
            now,
            0.06,
        );
        chargeSnd.osc.frequency.setTargetAtTime(
            55 + 55 * k,
            now,
            0.06,
        );

        chargeSnd.subGain.gain.setTargetAtTime(
            0.03 + 0.18 * k,
            now,
            0.08,
        );
        chargeSnd.noiseGain.gain.setTargetAtTime(
            0.1 + 0.15 * k,
            now,
            0.08,
        );

        chargeSnd.outGain.gain.setTargetAtTime(
            0.05 + 0.22 * k,
            now,
            0.08,
        );

        chargeSnd.lfoGain.gain.setTargetAtTime(
            0.02 + 0.08 * k,
            now,
            0.12,
        );
        chargeSnd.lfo.frequency.setTargetAtTime(
            2.0 + 2.5 * k,
            now,
            0.15,
        );

        chargeSnd.wet.gain.setTargetAtTime(
            0.25 + 0.3 * k,
            now,
            0.15,
        );
    }

    function stop() {
        if (!chargeSnd || !chargeSnd.active) return;

        const now = audioCtx.currentTime;

        chargeSnd.outGain.gain.cancelScheduledValues(now);
        chargeSnd.outGain.gain.setValueAtTime(
            chargeSnd.outGain.gain.value,
            now,
        );
        chargeSnd.outGain.gain.linearRampToValueAtTime(
            0.0,
            now + 0.1,
        );

        try {
            chargeSnd.osc.stop(now + 0.12);
        } catch {}
        try {
            chargeSnd.sub.stop(now + 0.12);
        } catch {}
        try {
            chargeSnd.noise.stop(now + 0.12);
        } catch {}
        try {
            chargeSnd.lfo.stop(now + 0.12);
        } catch {}

        setTimeout(() => {
            chargeSnd.osc = null;
            chargeSnd.sub = null;
            chargeSnd.noise = null;
            chargeSnd.active = false;
        }, 200);
    }

    // Short "UI beep" helpers for countdown ticks
    function _beep({
        freq = 880,
        dur = 0.08,
        vol = 0.22,
        type = "sine",
    } = {}) {
        ensureAudio();
        const now = audioCtx.currentTime;

        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        const hp = audioCtx.createBiquadFilter();

        osc.type = type;
        osc.frequency.setValueAtTime(freq, now);

        hp.type = "highpass";
        hp.frequency.value = 260;

        // Fast envelope
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(vol, now + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

        osc.connect(hp);
        hp.connect(g);
        g.connect(
            chargeSnd ? chargeSnd.master : audioCtx.destination,
        );

        osc.start(now);
        osc.stop(now + dur + 0.02);
    }

    // Before beepTick changed over time but
    // too lazy to change the function calls
    function beepTick() {
        // Countdown beep — fixed parameters per request
        _beep({ freq: 300, dur: 0.6, vol: 5.0, type: "sine" });
    }

    function beepFinal() {
        // Final beep — same parameters as countdown beeps
        _beep({ freq: 300, dur: 0.6, vol: 5.0, type: "sine" });
    }

    return {
        ensureAudio,
        resume,
        start,
        update,
        stop,
        beepTick,
        beepFinal,
        setMuted(m) {
            muted = !!m;
            applyMuteState();
        },
        isMuted() {
            return muted;
        },
    };
}

export function renderWarpOverlay(renderer, warpOverlay, shouldDraw) {
    if (!shouldDraw) return;
    const oldAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(warpOverlay.warpScene, warpOverlay.warpCam);
    renderer.autoClear = oldAuto;
}

export function makeWarpController({
    THREE,
    warpMat,
    chargeUI,
    chargeSound,
    canWarp = () => true,
    getWarpDirection = () => new THREE.Vector3(0, 0, -1),
    onWarpStart,
    onWarpRebuildSystem,
    onWarpArrive,

    addVelocityForward, // (dirW, accel, dt) => void
    dampVelocity, // (damp, dt) => void  (frame-rate independent via pow)
    integratePosition, // (dt) => void
    interpolateLookAt, // (p01, dirW, dt) => void
}) {
    const warp = {
        active: false,
        phase: "idle", // idle | charge | countdown | travel | out | reveal
        target: null,

        chargeT: 0,
        countdownT: 0,
        travelT: 0,
        outT: 0,
        revealT: 0,

        // Timings
        chargeDur: 15.0,
        countdownDur: 5.99,
        travelDur: 15.0,
        outDur: 1.2,
        revealDur: 0.25,

        dirW: new THREE.Vector3(0, 0, -1),
        didRebuild: false,
        _lastBeepSec: 6,
    };

    function start(target) {
        if (warp.active) return false;
        if (!canWarp()) return false;

        warp.active = true;
        warp.target = target;
        warp.phase = "charge";
        warp.chargeT = 0;
        warp.countdownT = 0;
        warp.travelT = 0;
        warp.outT = 0;
        warp.revealT = 0;
        warp.didRebuild = false;

        warp.dirW.copy(getWarpDirection(target)).normalize();

        warpMat.uniforms.uStrength.value = 0.0;
        warpMat.uniforms.uFade.value = 0.0;

        onWarpStart?.(target);
        chargeUI.setCharging(0);
        if (chargeSound) {
            chargeSound.ensureAudio?.();
            chargeSound.resume?.();
            chargeSound.start?.();
        }
        warp._lastBeepSec = 6;
        return true;
    }

    function update(dt, timeSeconds) {
        warpMat.uniforms.uTime.value = timeSeconds;
        if (!warp.active) return;

        if (warp.phase === "charge") {
            warp.chargeT += dt;
            const p01 = THREE.MathUtils.clamp(
                warp.chargeT / warp.chargeDur,
                0,
                1,
            );
            chargeUI.setCharging(p01);
            if (chargeSound) chargeSound.update?.(p01);

            warpMat.uniforms.uStrength.value = 0.0;
            warpMat.uniforms.uFade.value = 0.0;

            // Acceleration ramp up hard near the end
            if (addVelocityForward)
                addVelocityForward(
                    warp.dirW,
                    THREE.MathUtils.lerp(250.0, 5200.0, p01 * p01),
                    dt,
                );
            if (dampVelocity) dampVelocity(0.992, dt);

            // Interpolated look-at while charging
            if (interpolateLookAt)
                interpolateLookAt(p01, warp.dirW, dt);

            if (integratePosition) integratePosition(dt);

            if (p01 >= 1.0) {
                warp.phase = "countdown";
                warp.countdownT = 0;
                warp._lastBeepSec = 6;
                chargeSound?.beepFinal?.();
            }
        } else if (warp.phase === "countdown") {
            warp.countdownT += dt;

            if (chargeSound) chargeSound.update?.(1.0);
            const timeLeft = warp.countdownDur - warp.countdownT;
            chargeUI.setCountdown(timeLeft);

            // Countdown beeps
            const sec = Math.ceil(timeLeft);
            if (sec !== warp._lastBeepSec) {
                warp._lastBeepSec = sec;
                if (sec <= 5 && sec >= 1) {
                    const urgency = (6 - sec) / 5; // 0..1
                    chargeSound?.beepTick?.(urgency);
                }
            }
            warpMat.uniforms.uStrength.value = 0.0;
            warpMat.uniforms.uFade.value = 0.0;

            // Keep the camera eased toward the warp vector
            if (interpolateLookAt)
                interpolateLookAt(1.0, warp.dirW, dt);
            if (dampVelocity) dampVelocity(0.992, dt);
            if (integratePosition) integratePosition(dt);

            if (warp.countdownT >= warp.countdownDur) {
                //chargeSound?.beepFinal?.();
                chargeSound?.stop?.();

                warp.phase = "travel";
                warp.travelT = 0;
                chargeUI.hide();
                warpMat.uniforms.uStrength.value = 0.0;
                warpMat.uniforms.uFade.value = 0.0;

                // Hide minimap during warp
                document
                    .getElementById("galaxyMap")
                    ?.classList.add("warpHide");
            }
        } else if (warp.phase === "travel") {
            warp.travelT += dt;

            // Ramp the overlay in quickly
            const ramp = THREE.MathUtils.clamp(
                warp.travelT / 0.35,
                0,
                1,
            );
            warpMat.uniforms.uStrength.value = ramp;
            warpMat.uniforms.uFade.value = 1.0;

            if (addVelocityForward)
                addVelocityForward(warp.dirW, 45.0, dt);
            if (dampVelocity) dampVelocity(0.996, dt);
            if (interpolateLookAt)
                interpolateLookAt(1.0, warp.dirW, dt);
            if (integratePosition) integratePosition(dt);

            // Rebuild while tunnel is fully active (after ramp reaches 1)
            if (!warp.didRebuild && ramp >= 1.0) {
                onWarpRebuildSystem?.(warp.target);
                warp.didRebuild = true;
            }

            if (warp.travelT >= warp.travelDur) {
                onWarpArrive?.(warp.target);
                warp.phase = "out";
                warp.outT = 0;
                warpMat.uniforms.uStrength.value = 1.0;
                warpMat.uniforms.uFade.value = 1.0;
            }
        } else if (warp.phase === "out") {
            warp.outT += dt;
            const k = THREE.MathUtils.clamp(
                warp.outT / warp.outDur,
                0,
                1,
            );
            const s = 1.0 - THREE.MathUtils.smoothstep(k, 0.0, 1.0);

            warpMat.uniforms.uStrength.value = s;
            warpMat.uniforms.uFade.value = 1.0;

            if (integratePosition) integratePosition(dt);

            if (k >= 1.0) {
                // Hold black for a beat, then fade back in cleanly to avoid camera-angle pops
                warp.phase = "reveal";
                warp.revealT = 0;
                warpMat.uniforms.uStrength.value = 0.0;
                warpMat.uniforms.uFade.value = 1.0;
            }
        } else if (warp.phase === "reveal") {
            warp.revealT += dt;
            const k = THREE.MathUtils.clamp(
                warp.revealT / warp.revealDur,
                0,
                1,
            );
            const a = 1.0 - THREE.MathUtils.smoothstep(k, 0.0, 1.0);

            // Fade from black back to the scene with no tunnel visible
            warpMat.uniforms.uStrength.value = 0.0;
            warpMat.uniforms.uFade.value = a;

            if (k >= 1.0) {
                warp.active = false;
                warp.phase = "idle";
                // Restore minimap after warp
                document
                    .getElementById("galaxyMap")
                    ?.classList.remove("warpHide");
                warp.target = null;
                warpMat.uniforms.uStrength.value = 0.0;
                warpMat.uniforms.uFade.value = 0.0;
            }
        }
    }

    function isOverlayVisible() {
        return (
            warp.active &&
            (warp.phase === "travel" ||
                warp.phase === "out" ||
                warp.phase === "reveal")
        );
    }

    function isMovementLocked() {
        return warp.active;
    }

    return {
        warp,
        start,
        update,
        isOverlayVisible,
        isMovementLocked,
    };
}

////////////////////////////////////////////////////////////////////////////////
