// StorySounds, ported to Web Audio from the Unity team's StorySounds.cs (MochiPound, branch origin/multiplayer,
// Assets/_Project/World/Scripts/StorySounds.cs; levels and toggles from Editor/MR_EnvironmentSettings.asset as
// applied by EnvironmentBuilder.BuildStory). Everything is synthesized, as in that build (no clip is assigned):
// the generators live in soundsSynth.js, this file plays them in 3D.
//
//   playIntroLine     a few hanging chime bars brushed one after another ("chiririn") while a line's letters rise
//   playScrollUnroll  hanji paper rustle as the intro scroll unrolls
//   playScrollClose   the rustle of the roll-up, ending in a soft tap as the roll shuts
//   playSwell         a rubbed singing-bowl tone that blooms with the last line's swell
//   stopTextSounds    stops every text sound still playing or waiting (intro skipped or restarted)
//   playEndingText    a bell chord when the ending text appears              (off: endingTextSound 0)
//   playFireworkFar   10-16 small distant firework crackles from the Earth   (off: endingFirework 0)
//   playFlight / playArrival / playWishes   the mochi's flight whoosh, the arrival sparkle burst, the wish
//                     twinkles, from the Earth's direction                  (off: progressSounds 0, see below)
//   onProgress / onMilestone   MoonProgress's own hooks in Unity (shimmer per step, chord at 25/50/75 %, swell at
//                     full); extras here, off with progressSounds 0, and nothing calls them yet
//   update(dt, t)     counts frames (Unity seeds the random patterns with Time.frameCount)
//   setOptions(patch), options, setVolume(v), dispose()
//
// Positions (`at`) and `right` are THREE.Vector3 (or {x, y, z}) in three.js world metres. `toward` is where a
// Moon / Earth sound comes from: a world point, as in Unity's Directional() (the sound plays directionalDistance
// from the head toward it); a unit vector is taken as a world direction instead.
//
// Unity AudioSource -> Web Audio (one voice = AudioBufferSourceNode -> GainNode -> PannerNode -> master GainNode):
//   spatialBlend 1             -> a PannerNode on every voice (fully 3D, no 2D part)
//   spatialize (HRTF plugin)   -> panningModel 'HRTF' (option panningModel; Unity's Quest player fell back to its
//                                 own 3D panning, since it cannot tell whether the named spatializer is present)
//   rolloffMode Logarithmic,   -> distanceModel 'inverse', refDistance = minDistance, rolloffFactor 1: level 1 inside
//   minDistance 1.5 / 6           minDistance and minDistance / d beyond it, Unity's logarithmic curve. Text sounds
//                                 use 1.5 m; Moon / Earth sounds 6 m (= directionalDistance: full level where they
//                                 are placed, so distance never mutes them)
//   maxDistance 40             -> maxDistance 40 (the spec uses it only for 'linear'; distances here stay under 7 m)
//   volume                     -> the voice's GainNode (textVolume, paperVolume, progressSfxVolume x per-sound gain)
//   pitch                      -> playbackRate (speed and pitch together, as Unity's pitch)
//   PlayDelayed(d)             -> start(currentTime + d)
//   dopplerLevel 0             -> nothing to do (Web Audio has no Doppler)
//   priority, 20-source pool   -> the same 20 voice slots, round robin: a new sound takes the next slot and stops
//                                 whatever was on it (with a 15 ms fade where Unity's Stop() cuts)
//   AudioListener              -> Satie's listener, bound to the camera on the same AudioContext
// The master GainNode (masterVolume, setVolume) is this file's own, so the story's level is set in one place; it goes
// straight to the context's destination (not through Satie's mix bus, so Satie's mixer does not change it).

import * as THREE from 'three';
import { RATE, CLIPS, BAR_HZ, PENTA, FIREWORK_VARIANTS, cascade, fireworkSchedule, clamp, lerp, inverseLerp, roundToInt } from './soundsSynth.js';

export { cascade, fireworkSchedule, barData, paperData, swellToneData, fireworkPopData, BAR_HZ, PENTA, FIREWORK_VARIANTS, PAPER_CLOSE_TAP, SWELL_PEAK } from './soundsSynth.js';

/**
 * The Unity build's settings. Toggles and levels from MR_EnvironmentSettings.asset (as EnvironmentBuilder.BuildStory
 * copies them onto StorySounds); the rest are StorySounds.cs's defaults. Override with ctx.storySoundOptions or
 * setOptions(patch).
 */
export const STORY_SOUND_DEFAULTS = {
  soundsEnabled: true,      // storySounds 1 (the master switch)
  textSounds: true,         // textSounds 1: the intro line chimes (and the ending text, with endingTextSound)
  progressSounds: false,    // progressSounds 0. In Unity this also gates Directional(), so the flight, arrival and
                            // wish sounds are off too; kept that way here
  strikeSound: true,        // strikeSound 1 (the shimmer per progress step, under progressSounds)
  textVolume: 0.11,         // textSoundVolume 0.11
  endingTextSound: false,   // endingTextSound 0
  scrollSounds: true,       // scrollSounds 1
  paperVolume: 0.1,         // StorySounds default
  swellSound: true,         // swellSound 1
  endingFirework: false,    // endingFirework 0 ("off for now (Jihyeon); the sound is kept")
  fireworkVolume: 0.07,     // StorySounds default
  fireworkDelay: 0.3,       // s: far away, heard a moment after the flash
  progressSfxVolume: 0.3,   // progressSfxVolume 0.3
  directionalDistance: 6,   // m from the head toward the Moon / Earth
  voices: 20,               // the ending firework uses up to 16 at once
  barsPerLine: [3, 5],      // bars brushed while a line rises (min, max, by line length)
  barSpread: 0.35,          // m either side of the text
  // Web Audio only
  masterVolume: 1,          // this file's master gain
  panningModel: 'HRTF',     // or 'equalpower' (cheaper)
  maxDistance: 40,
  prewarm: true,            // build the enabled sounds' buffers in idle time after creation
};

const TEXT_MIN_DISTANCE = 1.5;
const UP = new THREE.Vector3(0, 1, 0);
const DEG = Math.PI / 180;

export function createStorySounds(ctx = {}) {
  const o = { ...STORY_SOUND_DEFAULTS, ...(ctx.storySoundOptions ?? {}) };

  // ---------------------------------------------------------------- the audio context (looked up at play time)

  let boundAc = null, master = null;
  const slots = [];
  let next = 0;

  /** Satie's AudioContext, or null (before the first click, or no sound): then every play is skipped quietly. */
  function context() {
    let ac = null;
    try { ac = ctx.audioContext ?? null; } catch { ac = null; }
    if (!ac || typeof ac.createBufferSource !== 'function' || ac.state === 'closed') return null;
    if (ac !== boundAc) {
      // first use, or Satie made a fresh engine (its load is retried with a new context): rebuild the output
      for (const v of slots) if (v) disconnect(v);
      slots.length = 0;
      next = 0;
      try { master?.disconnect(); } catch { /* old context */ }
      master = ac.createGain();
      master.gain.value = o.masterVolume;
      master.connect(ac.destination);
      boundAc = ac;
      console.info(`[story] sounds on ${ac.sampleRate} Hz: ${describe()}`);
    }
    // 'suspended' (a resume in flight) still schedules: the sound plays as the context starts
    return ac.state === 'running' || ac.state === 'suspended' ? ac : null;
  }

  function describe() {
    if (!o.soundsEnabled) return 'all off (soundsEnabled false)';
    const on = [], off = [];
    (o.textSounds ? on : off).push('intro lines');
    (o.scrollSounds ? on : off).push('scroll');
    (o.swellSound ? on : off).push('swell');
    (o.textSounds && o.endingTextSound ? on : off).push('ending text');
    (o.endingFirework ? on : off).push('fireworks');
    (o.progressSounds ? on : off).push('flight/arrival/wishes/progress');
    return `on: ${on.join(', ') || 'none'}; off: ${off.join(', ') || 'none'}`;
  }

  // ---------------------------------------------------------------- buffers (built once each, cached)

  const buffers = new Map(); // name -> AudioBuffer | null (failed)
  const raw = new Map();     // name -> Float32Array, only if this browser lacks the AudioBuffer constructor

  function toBuffer(data, ac) {
    try {
      if (typeof AudioBuffer === 'function') {
        const b = new AudioBuffer({ length: data.length, numberOfChannels: 1, sampleRate: RATE });
        b.copyToChannel(data, 0);
        return b;
      }
    } catch { /* fall through to the context */ }
    if (!ac) return null;
    const b = ac.createBuffer(1, data.length, RATE);
    b.getChannelData(0).set(data);
    return b;
  }

  /** The named clip's AudioBuffer, synthesizing it the first time (prewarm usually got there first). */
  function buffer(name, ac = null) {
    const have = buffers.get(name);
    if (have !== undefined) return have;
    let data = raw.get(name);
    if (!data) {
      const make = CLIPS[name];
      if (!make) return null;
      try { data = make(); }
      catch (err) { console.warn(`[story] sound "${name}" failed to synthesize`, err); buffers.set(name, null); return null; }
    }
    const b = toBuffer(data, ac);
    if (b) { buffers.set(name, b); raw.delete(name); }
    else raw.set(name, data); // no AudioBuffer constructor and no context yet: keep the samples for later
    return b;
  }

  /** The clips the enabled sounds need, in the order the story plays them. */
  function wanted() {
    if (!o.soundsEnabled) return [];
    const w = [];
    if (o.scrollSounds) w.push('paperOpen');
    if (o.textSounds) for (let i = 0; i < BAR_HZ.length; i++) w.push(`bar${i}`);
    if (o.swellSound) w.push('swellTone');
    if (o.scrollSounds) w.push('paperClose');
    if (o.progressSounds) w.push('flight', 'arrival', 'wish');
    if (o.endingFirework) for (let v = 0; v < FIREWORK_VARIANTS; v++) w.push(`pop${v}`);
    if (o.textSounds && o.endingTextSound) w.push('ending');
    if (o.progressSounds && o.strikeSound) w.push('strike');
    if (o.progressSounds) w.push('milestone', 'fullMoon');
    return w;
  }

  // Prewarm: one clip per idle slice (more while the slice has time left), off the frame loop. The synthesis needs
  // no AudioContext, so this runs from creation, normally long before the first click.
  const queue = [];
  let pumping = false, disposed = false;
  const idle = typeof requestIdleCallback === 'function'
    ? (fn) => requestIdleCallback(fn, { timeout: 1000 })
    : (fn) => setTimeout(() => fn(null), 40);
  function pump() {
    if (pumping || disposed || !queue.length) return;
    pumping = true;
    idle((deadline) => {
      pumping = false;
      if (disposed) return;
      do { const name = queue.shift(); if (name) buffer(name, boundAc); }
      while (queue.length && deadline && deadline.timeRemaining() > 8);
      pump();
    });
  }
  function prewarm() {
    if (!o.prewarm) return;
    for (const name of wanted()) if (!buffers.has(name) && !queue.includes(name)) queue.push(name);
    pump();
  }

  // ---------------------------------------------------------------- voices

  function disconnect(v) {
    v.src.onended = null;
    try { v.src.disconnect(); v.gain.disconnect(); v.panner.disconnect(); } catch { /* already */ }
  }

  function stopVoice(v) {
    try {
      const t = v.ac.currentTime, g = v.gain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0, t + 0.015);
      v.src.stop(t + 0.02); // a voice still waiting for its delay never starts
    } catch { disconnect(v); }
  }

  function setParam(p, value) { if (p) p.value = value; }

  /**
   * StorySounds.Play: the next pool slot plays `name` at `at` (world), at `volume` and `pitch`, after `delay` s,
   * full level within `minDistance`. `kind` 'text' marks what stopTextSounds stops.
   */
  function play(name, at, volume, pitch, delay, minDistance, kind) {
    if (!(volume > 0)) return;
    const ac = context();
    if (!ac) return;
    const buf = buffer(name, ac);
    if (!buf) return;
    const n = Math.max(1, Math.round(o.voices) || 1);
    if (next >= n) next = 0;
    const old = slots[next];
    if (old) stopVoice(old);

    const src = ac.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = pitch > 0 ? pitch : 1;
    const gain = ac.createGain();
    gain.gain.value = volume;
    const panner = ac.createPanner();
    panner.panningModel = o.panningModel === 'equalpower' ? 'equalpower' : 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = minDistance;
    panner.maxDistance = Math.max(minDistance, o.maxDistance);
    panner.rolloffFactor = 1;
    const x = at?.x ?? 0, y = at?.y ?? 0, z = at?.z ?? 0;
    if (panner.positionX) { setParam(panner.positionX, x); setParam(panner.positionY, y); setParam(panner.positionZ, z); }
    else panner.setPosition(x, y, z);
    src.connect(gain);
    gain.connect(panner);
    panner.connect(master);

    const v = { ac, src, gain, panner, kind, slot: next };
    slots[next] = v;
    next = (next + 1) % n;
    src.onended = () => { disconnect(v); if (slots[v.slot] === v) slots[v.slot] = null; };
    src.start(ac.currentTime + Math.max(0, delay || 0));
  }

  // ---------------------------------------------------------------- where Moon / Earth sounds come from

  const head = new THREE.Vector3(), dir = new THREE.Vector3(), at = new THREE.Vector3();
  const axis = new THREE.Vector3(), d = new THREE.Vector3(), moonAt = new THREE.Vector3();

  function headPosition() {
    const cam = ctx.camera;
    if (cam?.getWorldPosition) return cam.getWorldPosition(head);
    const l = boundAc?.listener;
    if (l?.positionX) return head.set(l.positionX.value, l.positionY.value, l.positionZ.value);
    return head.set(0, 1.6, 0);
  }

  /** The unit direction from the head toward `toward` (a world point, or a unit world direction). */
  function towardDir(toward) {
    headPosition();
    const tx = toward?.x ?? 0, ty = toward?.y ?? 0, tz = toward?.z ?? 0;
    const len = Math.hypot(tx, ty, tz);
    if (Math.abs(len - 1) < 1e-3) dir.set(tx, ty, tz);
    else dir.set(tx - head.x, ty - head.y, tz - head.z);
    if (dir.lengthSq() > 1e-4) dir.normalize();
    else dir.set(0, 0, -1); // Unity's Vector3.forward (the garden's +Z opening is three's -Z)
    return dir;
  }

  /** StorySounds.Directional: gated by progressSounds as in Unity; full level at directionalDistance. */
  function directional(name, toward, gain, pitch = 1) {
    if (!o.soundsEnabled || !o.progressSounds) return;
    towardDir(toward);
    at.copy(head).addScaledVector(dir, o.directionalDistance);
    play(name, at, o.progressSfxVolume * gain, pitch, 0, o.directionalDistance, 'directional');
  }

  let moonObj;
  function moonPosition() {
    if (moonObj === undefined) moonObj = ctx.scene?.getObjectByName?.('MR_Moon') ?? null;
    if (moonObj) return moonObj.getWorldPosition(moonAt);
    return moonAt.set(0, 60, -130); // Unity's fallback (0, 60, 130) in the garden's flipped frame
  }

  // ---------------------------------------------------------------- frames (Unity's Time.frameCount, for seeds)

  let frame = 0;
  const frameNow = () => (frame > 0 ? frame : Math.floor((globalThis.performance?.now?.() ?? Date.now()) / 13.9));

  // ---------------------------------------------------------------- public API (StorySounds.cs)

  function playCascade(atPos, right, count, duration, delay, seed, gain) {
    const rx = right?.x ?? 0, ry = right?.y ?? 0, rz = right?.z ?? 0;
    for (const b of cascade(count, duration, seed + frameNow())) {
      const s = b.pan * o.barSpread;
      at.set((atPos?.x ?? 0) + rx * s, (atPos?.y ?? 0) + ry * s, (atPos?.z ?? 0) + rz * s);
      play(`bar${b.note}`, at, o.textVolume * gain * b.gain, b.detune, delay + b.time, TEXT_MIN_DISTANCE, 'text');
    }
  }

  /** Brushed chime bars while an intro line rises: riseTime = how long its letters take; 3-5 bars by length. */
  function playIntroLine(atPos, right, lineIndex = 0, letters = 0, riseTime = 0) {
    if (!o.soundsEnabled || !o.textSounds) return;
    const [lo, hi] = o.barsPerLine;
    const n = clamp(roundToInt(lerp(lo, hi, inverseLerp(15, 70, Number(letters) || 0))), lo, hi);
    playCascade(atPos, right, n, Math.max(0.4, (Number(riseTime) || 0) * 0.9), 0, 101 + (lineIndex | 0) * 17, 1);
  }

  /** Soft hanji rustle as the scroll unrolls (about `time` s; the clip is made for 0.7 s). */
  function playScrollUnroll(atPos, right, time = 0.7) {
    if (!o.soundsEnabled || !o.scrollSounds) return;
    play('paperOpen', atPos, o.paperVolume, clamp(0.7 / Math.max(0.2, Number(time) || 0), 0.8, 1.25), 0, TEXT_MIN_DISTANCE, 'text');
  }

  /** The scroll rolling up: a rustle that ends in a soft tap as the roll closes (made for 0.9 s). */
  function playScrollClose(atPos, time = 0.9) {
    if (!o.soundsEnabled || !o.scrollSounds) return;
    play('paperClose', atPos, o.paperVolume, clamp(0.9 / Math.max(0.2, Number(time) || 0), 0.8, 1.25), 0, TEXT_MIN_DISTANCE, 'text');
  }

  /**
   * The last line's swell: a rubbed singing-bowl tone that blooms (peak at SWELL_PEAK, 0.95 s) and fades.
   * swellTime is unused, as in Unity (the tone is made for the default swell); delay = the line's rise time.
   */
  function playSwell(atPos, right, swellTime, delay = 0) {
    if (!o.soundsEnabled || !o.swellSound) return;
    play('swellTone', atPos, o.textVolume, 1, Number(delay) || 0, TEXT_MIN_DISTANCE, 'text');
  }

  /**
   * Distant fireworks from the Earth's direction: 10-16 small dull pops, close together at first, then thinning out
   * over about 2 s, each a little higher or lower, louder or softer and a few degrees off the Earth; heard
   * fireworkDelay after the flash.
   */
  function playFireworkFar(toward) {
    if (!o.soundsEnabled || !o.endingFirework) return;
    towardDir(toward);
    axis.crossVectors(UP, dir);
    const tilted = axis.lengthSq() > 1e-8;
    if (tilted) axis.normalize();
    for (const p of fireworkSchedule(frameNow())) {
      d.copy(dir);
      if (tilted) d.applyAxisAngle(axis, p.tilt * DEG);
      d.applyAxisAngle(UP, p.angle * DEG);
      at.copy(head).addScaledVector(d, o.directionalDistance);
      play(`pop${p.variant}`, at, o.fireworkVolume * p.gain, p.pitch, o.fireworkDelay + p.time, o.directionalDistance, 'firework');
    }
  }

  /** Stops text chimes still playing or waiting (intro skipped or restarted): bars, paper, swell. */
  function stopTextSounds() {
    for (let i = 0; i < slots.length; i++) {
      const v = slots[i];
      if (v && v.kind === 'text') { stopVoice(v); slots[i] = null; }
    }
  }

  function playEndingText(atPos) {
    if (!o.soundsEnabled || !o.textSounds || !o.endingTextSound) return;
    play('ending', atPos, o.textVolume * 1.1, 1, 0, TEXT_MIN_DISTANCE, 'ending');
  }

  const playFlight = (toward) => directional('flight', toward, 0.8);
  const playArrival = (toward) => directional('arrival', toward, 1);
  const playWishes = (toward) => directional('wish', toward, 0.6);

  // MoonProgress hooks (Unity: progress.onChanged / onMilestone). v = progress 0..1, m = milestone 1..4.
  let lastValue = 0;
  function onProgress(v, moon) {
    const up = v > lastValue + 1e-4;
    const before = Math.floor(lastValue * 4 + 1e-4), now = Math.floor(v * 4 + 1e-4);
    lastValue = v;
    if (!up || now > before) return; // a milestone plays its own sound
    if (!o.soundsEnabled || !o.progressSounds || !o.strikeSound) return;
    // shimmer from the Moon, a pentatonic step higher as the Moon fills
    const i = clamp(roundToInt(v * (PENTA.length - 1)), 0, PENTA.length - 1);
    directional('strike', moon ?? moonPosition(), 0.9, PENTA[i] * 0.5 + 0.5);
  }
  function onMilestone(m, moon) {
    if (!o.soundsEnabled || !o.progressSounds) return;
    if (m >= 4) directional('fullMoon', moon ?? moonPosition(), 1.1);
    else directional('milestone', moon ?? moonPosition(), 1, PENTA[clamp(m - 1, 0, 2)]);
  }

  function update() { frame++; }

  function setOptions(patch = {}) {
    Object.assign(o, patch);
    if (master) master.gain.value = o.masterVolume;
    prewarm(); // sounds just switched on get their buffers built
  }

  function dispose() {
    disposed = true;
    queue.length = 0;
    for (const v of slots) if (v) { stopVoice(v); }
    slots.length = 0;
    try { master?.disconnect(); } catch { /* gone */ }
    master = null;
    boundAc = null;
  }

  prewarm();

  return {
    playIntroLine, playScrollUnroll, playScrollClose, playSwell, playFireworkFar, stopTextSounds,
    playEndingText, playFlight, playArrival, playWishes, update,
    onProgress, onMilestone,
    setOptions,
    setVolume: (v) => setOptions({ masterVolume: v }),
    options: o, // live; change it through setOptions so newly enabled sounds get built
    dispose,
  };
}
