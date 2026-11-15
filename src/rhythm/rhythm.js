import * as THREE from 'three';
import * as L from '../layout.js';
import { strikesFromBeats, autoEvery } from './beats.js';

// Rhythm mode. The song's beats become strike notes. For each note a glowing ring shrinks onto the
// mortar's rim and meets it exactly on the strike; the rim pulses on every beat. Player strikes are
// judged against the nearest note by when you hear it. While nobody holds the kine (station mode
// 'idle'; the NPC pounder that played the song is gone since 2026-11-15) the notes pass unjudged.
// Notes only exist while there is dough to pound; the rice loading and the finished batch are rests.

const LEAD_S = 1.6;           // how long a ring takes to close in
const WINDOW = { perfect: 0.06, good: 0.13, catch: 0.25 }; // seconds either side of the note
const RIM_R = L.USU.radius * 0.84, RING_START_R = 1.0;

export function createRhythm({ scene, station, music }) {
  const listeners = {};
  const emit = (n, d) => { for (const fn of listeners[n] ?? []) fn(d); };
  const st = {
    active: false, strikes: [], beats: [], dur: 0, every: 1,
    notes: new Map(), // key -> { t, ring, judged, shown }
    score: 0, combo: 0, maxCombo: 0, counts: { perfect: 0, good: 0, miss: 0 },
    recent: [], // recent signed errors (s) for the calibration readout
    lastBeat: -Infinity,
  };

  // ---- visuals: the rim glow and a pool of approach rings ----
  const y = () => (station.dough?.stats?.topY ?? L.MOCHI_TOP_Y) + 0.01;
  const rimMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const rim = new THREE.Mesh(new THREE.TorusGeometry(1, 0.012, 8, 64), rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.set(L.USU.position[0], L.USU.height + 0.012, L.USU.position[2]);
  rim.scale.setScalar(RIM_R);
  rim.visible = false;
  scene.add(rim);
  const ringGeom = new THREE.TorusGeometry(1, 0.01, 6, 64);
  const pool = [];
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(ringGeom, new THREE.MeshBasicMaterial({ color: 0xfff1d6, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    m.rotation.x = Math.PI / 2;
    m.visible = false;
    scene.add(m);
    pool.push(m);
  }
  const takeRing = () => pool.find((m) => !m.visible) ?? null;
  const flash = { t: 0, color: new THREE.Color(0xffd9a0) };

  // ---- floating judgment text (works in VR, where there is no HTML HUD) ----
  const popups = [];
  function popup(text, color) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.font = '700 72px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 10; g.strokeStyle = 'rgba(0,0,0,0.65)';
    g.strokeText(text, 256, 64);
    g.fillStyle = color; g.fillText(text, 256, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    s.scale.set(0.5, 0.125, 1);
    s.position.set(L.USU.position[0] + 0.3, y() + 0.35, L.USU.position[2] + 0.25);
    s.renderOrder = 10;
    scene.add(s);
    popups.push({ s, t: 0 });
    while (popups.length > 4) { const old = popups.shift(); disposePopup(old); }
  }
  function disposePopup(p) { p.s.removeFromParent(); p.s.material.map.dispose(); p.s.material.dispose(); }

  // ---- note bookkeeping (strike times repeat every loop of the song) ----
  function strikeAt(loopIndex, i) { return st.strikes[i] + loopIndex * st.dur; }
  function forEachStrike(from, to, fn) {
    if (!st.strikes.length || !(st.dur > 0)) return;
    const k0 = Math.max(0, Math.floor(from / st.dur)), k1 = Math.floor(to / st.dur);
    for (let k = k0; k <= k1; k++) for (let i = 0; i < st.strikes.length; i++) {
      const t = strikeAt(k, i);
      if (t >= from && t <= to) fn(t, `${k}:${i}`);
    }
  }
  function nextStrike(after) {
    let best = Infinity;
    forEachStrike(after, after + Math.max(4, st.dur), (t) => { if (t > after && t < best) best = t; });
    return best;
  }
  function prevStrike(before) {
    let best = -Infinity;
    forEachStrike(Math.max(0, before - 4), before, (t) => { if (t <= before && t > best) best = t; });
    return best;
  }
  function lastBeatBefore(t) {
    if (!st.beats.length) return -Infinity;
    const k = Math.floor(t / st.dur), local = t - k * st.dur;
    let b = -Infinity;
    for (const x of st.beats) if (x <= local) b = x; else break;
    return b === -Infinity ? -Infinity : b + k * st.dur;
  }

  function judge(note, err, rushed) {
    note.judged = true;
    const a = Math.abs(err);
    let kind = 'miss';
    if (!rushed && a <= WINDOW.perfect) kind = 'perfect';
    else if (!rushed && a <= WINDOW.good) kind = 'good';
    st.counts[kind]++;
    if (kind === 'miss') st.combo = 0; else st.combo++;
    st.maxCombo = Math.max(st.maxCombo, st.combo);
    const mult = Math.min(4, 1 + Math.floor(st.combo / 8));
    st.score += (kind === 'perfect' ? 100 : kind === 'good' ? 50 : 0) * mult;
    if (!rushed && a <= WINDOW.catch) { st.recent.push(err); if (st.recent.length > 12) st.recent.shift(); }
    const label = rushed ? 'Ouch! Hands!' : kind === 'perfect' ? 'Perfect' : kind === 'good' ? (err < 0 ? 'Good · early' : 'Good · late') : err < 0 ? 'Early' : 'Late';
    const color = kind === 'perfect' ? '#ffd76a' : kind === 'good' ? '#9be37a' : '#ff7a6a';
    flash.t = 1; flash.color.set(color);
    popup(label, color);
    emit('judge', { kind, err, rushed, label, combo: st.combo, score: st.score });
    return kind;
  }

  // a player strike (the station's pound event)
  station.on('pound', ({ by, rushed }) => {
    if (!st.active) return;
    const t = music.time();
    let best = null, bestErr = Infinity;
    for (const note of st.notes.values()) {
      if (note.judged) continue;
      const e = t - note.t;
      if (Math.abs(e) < Math.abs(bestErr)) { bestErr = e; best = note; }
    }
    if (best && Math.abs(bestErr) <= WINDOW.catch) judge(best, bestErr, rushed);
    else { // a strike nowhere near a note breaks the combo
      st.combo = 0;
      popup(rushed ? 'Ouch! Hands!' : 'Off-beat', '#ff7a6a');
      emit('judge', { kind: 'offbeat', err: 0, rushed, label: 'Off-beat', combo: 0, score: st.score });
    }
  });

  // What the station asks while rhythm mode runs.
  const provider = {
    time: () => music.time(),
    nextStrike, prevStrike,
  };

  function clearNotes() {
    for (const n of st.notes.values()) if (n.ring) n.ring.visible = false;
    st.notes.clear();
  }

  return {
    get active() { return st.active; },
    get score() { return st.score; },
    get combo() { return st.combo; },
    get mult() { return Math.min(4, 1 + Math.floor(st.combo / 8)); },
    get counts() { return st.counts; },
    get maxCombo() { return st.maxCombo; },
    get every() { return st.every; },
    get meanErrMs() { return st.recent.length ? (1000 * st.recent.reduce((a, b) => a + b, 0)) / st.recent.length : null; },
    on(n, fn) { (listeners[n] ??= []).push(fn); },
    // every: 'auto' | 1 | 2
    start(every = 'auto') {
      const a = music.analysis;
      if (!a) return false;
      st.every = every === 'auto' ? autoEvery(a) : Number(every);
      st.strikes = strikesFromBeats(a, st.every);
      st.beats = a.beats.slice();
      st.dur = a.duration;
      st.score = 0; st.combo = 0; st.maxCombo = 0; st.counts = { perfect: 0, good: 0, miss: 0 }; st.recent = [];
      clearNotes();
      st.active = true;
      rim.visible = true;
      station.setRhythm(provider);
      return true;
    },
    stop() {
      st.active = false;
      clearNotes();
      rim.visible = false;
      station.setRhythm(null);
    },
    update(dt) {
      for (let i = popups.length - 1; i >= 0; i--) {
        const p = popups[i];
        p.t += dt;
        p.s.position.y += dt * 0.12;
        p.s.material.opacity = Math.max(0, 1 - p.t / 0.9);
        if (p.t > 0.9) { disposePopup(p); popups.splice(i, 1); }
      }
      if (!st.active) return;
      const now = music.time();
      if (!Number.isFinite(now)) return;
      const pounding = station.phase === 'pound';
      const playerHasKine = station.mode !== 'idle'; // nobody holds it: notes pass unjudged (no NPC plays them any more)

      // new notes entering the approach window (only while there is dough to pound)
      if (pounding) {
        forEachStrike(now, now + LEAD_S, (t, key) => {
          if (st.notes.has(key)) return;
          st.notes.set(key, { t, ring: takeRing(), judged: false, unheld: !playerHasKine });
        });
      }
      // rings close in; unhit notes become misses; finished notes leave
      const ringY = y();
      for (const [key, note] of st.notes) {
        const left = note.t - now;
        if (!pounding && left > 0) { if (note.ring) note.ring.visible = false; st.notes.delete(key); continue; }
        if (!note.judged && left < -WINDOW.catch) {
          if (playerHasKine && !note.unheld) judge(note, WINDOW.catch, false);
          else note.judged = true;
        }
        if (left < -0.35) { if (note.ring) note.ring.visible = false; st.notes.delete(key); continue; }
        if (note.ring) {
          const k = Math.max(0, left / LEAD_S);
          note.ring.visible = true;
          note.ring.scale.setScalar(RIM_R + (RING_START_R - RIM_R) * k);
          note.ring.position.set(L.USU.position[0], ringY, L.USU.position[2]);
          note.ring.material.opacity = note.judged ? Math.max(0, 0.9 + left * 3) : Math.min(0.9, (1 - k) * 1.4);
          note.ring.material.color.set(left > 0 ? 0xfff1d6 : 0xffd76a);
        }
      }
      // rim: a soft pulse on every beat, a coloured flash on each judgment
      const b = lastBeatBefore(now);
      const pulse = Number.isFinite(b) ? Math.exp(-(now - b) * 7) : 0;
      flash.t = Math.max(0, flash.t - dt * 3);
      rimMat.color.setRGB(1, 0.85, 0.63).lerp(flash.color, flash.t);
      rimMat.opacity = 0.15 + 0.45 * pulse + 0.5 * flash.t;
    },
  };
}
