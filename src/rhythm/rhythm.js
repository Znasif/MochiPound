import * as THREE from 'three';
import * as L from '../layout.js';
import { strikesFromBeats, kneadsFromStrikes, autoEvery } from './beats.js';

// Rhythm mode. The song's beats become strike notes. For each note a glowing ring shrinks onto the
// mortar's rim and meets it exactly on the strike (or the guest's intervening fold); the rim pulses
// on that player's action beat. Player actions are
// judged against the nearest note by when you hear it. While nobody holds the kine (station mode
// 'idle'; the NPC pounder that played the song is gone since 2026-11-15) the notes pass unjudged.
// Whose notes they are follows the kine, since either headset can hold it: holding it here (desktop or
// vr) gives strike notes; while the other headset holds it (remote) kneading notes, halfway between its
// strikes; while nobody holds it, this headset's usual role (`kneading`: the guest's).
// Notes only exist while there is dough to pound; the rice loading and the finished batch are rests.

const LEAD_S = 1.6;           // how long a ring takes to close in
const WINDOW = { perfect: 0.06, good: 0.13, catch: 0.25 }; // seconds either side of the note
const RIM_R = L.USU.radius * 0.84, RING_START_R = 1.0;
export const JUDGMENT_COLORS = Object.freeze({ perfect: '#65e287', good: '#ffd45a', miss: '#ff4d4d' });
export const HAND_HIT_PENALTY = 500;

// watch: the film camera (?mp=watch): strike rings only, never judged here; the players' judgments arrive
// over the network (showJudgment) and colour the matching ring (both build the same note keys)
export function createRhythm({ scene, station, music, kneading = false, watch = false }) {
  const listeners = {};
  const emit = (n, d) => { for (const fn of listeners[n] ?? []) fn(d); };
  const st = {
    active: false, strikes: [], beats: [], dur: 0, every: 1,
    notes: new Map(), // key -> { t, ring, judged, shown }
    score: 0, combo: 0, maxCombo: 0, counts: { perfect: 0, good: 0, miss: 0 },
    recent: [], // recent signed errors (s) for the calibration readout
    lastBeat: -Infinity,
    lastKnead: -Infinity,
    role: kneading ? 'knead' : 'strike', strikeTimes: [], kneadTimes: [],
  };
  const holdingHere = () => station.mode === 'desktop' || station.mode === 'vr';
  const roleNow = () => (watch ? 'strike' : holdingHere() ? 'strike' : station.mode === 'remote' ? 'knead' : kneading ? 'knead' : 'strike');
  // the kine changed hands: this headset's notes become the other action's
  function syncRole() {
    const role = roleNow();
    if (role === st.role) return;
    st.role = role;
    st.strikes = role === 'knead' ? st.kneadTimes : st.strikeTimes;
    st.beats = st.strikes.slice();
    st.lastKnead = -Infinity;
    clearNotes();
  }

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
  const takeRing = () => {
    const ring = pool.find((m) => !m.visible) ?? null;
    if (ring) ring.visible = true; // reserve it before the next note is allocated this frame
    return ring;
  };
  const flash = { t: 0, color: new THREE.Color(0xffd9a0) };
  const hazardLight = new THREE.PointLight(0xff1717, 0, 3, 2);
  hazardLight.name = 'hand-hit-warning'; hazardLight.position.set(...L.USU.position); hazardLight.position.y = L.USU.height + 0.65;
  scene.add(hazardLight);
  let hazardTime = 0;

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

  // the turn a note belongs to (one strike and the knead after it): its strike's song time, in ms. Kneads sit
  // between strikes, so a knead's turn is the strike before it. Every page builds the same strike times.
  function strikeBefore(t) {
    const times = st.strikeTimes;
    if (!times.length || !(st.dur > 0)) return t;
    const k = Math.floor(t / st.dur), local = t - k * st.dur;
    let best = -Infinity;
    for (const x of times) if (x <= local + 1e-6 && x > best) best = x;
    return best === -Infinity ? Math.max(...times) + (k - 1) * st.dur : best + k * st.dur;
  }
  const turnOf = (note) => Math.round(1000 * (st.role === 'knead' ? strikeBefore(note.t) : note.t));
  function judge(note, err, rushed, expired = false) {
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
    // the user's terms (2026-11-15): perfect (green), good (yellow), bad (red)
    const label = rushed ? 'Bad · hands!' : kind === 'perfect' ? 'Perfect' : kind === 'good' ? (err < 0 ? 'Good · early' : 'Good · late') : expired ? 'Bad · missed' : err < 0 ? 'Bad · early' : 'Bad · late';
    const color = JUDGMENT_COLORS[kind];
    note.result = kind; note.judgedAt = music.time();
    if (note.ring) note.ring.material.color.set(color);
    flash.t = 1; flash.color.set(color);
    popup(label, color);
    emit('judge', { kind, err, rushed, label, combo: st.combo, score: st.score, noteKey: note.key, action: st.role, turn: turnOf(note) });
    return kind;
  }

  // Judge only this player's action. Remote mallet/hand contacts still affect the shared dough,
  // but must not consume this player's notes (remote hands use slots 2 and 3).
  const onAction = (action) => ({ by, rushed = false, hand }) => {
    if (!st.active) return;
    syncRole(); // the kine may have changed hands since the last frame
    if (st.role !== action) return;
    const knead = action === 'knead';
    if (knead ? hand !== 0 && hand !== 1 : by !== 'player') return;
    const t = music.time();
    // Both palms can enter the dough together; that is one fold, not an extra off-beat hit.
    if (knead) { if (t - st.lastKnead < 0.1) return; st.lastKnead = t; }
    let best = null, bestErr = Infinity;
    for (const note of st.notes.values()) {
      if (note.judged) continue;
      const e = t - note.t;
      if (Math.abs(e) < Math.abs(bestErr)) { bestErr = e; best = note; }
    }
    if (best && Math.abs(bestErr) <= WINDOW.catch) judge(best, bestErr, rushed);
    else { // a strike nowhere near a note breaks the combo
      st.combo = 0;
      flash.t = 1; flash.color.set(JUDGMENT_COLORS.miss);
      popup(rushed ? 'Bad · hands!' : 'Off-beat', JUDGMENT_COLORS.miss);
      emit('judge', { kind: 'offbeat', err: 0, rushed, label: 'Off-beat', combo: 0, score: st.score });
    }
  };
  station.on('pound', onAction('strike'));
  station.on('turn', onAction('knead'));

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
    get kneading() { return st.role === 'knead'; },
    get meanErrMs() { return st.recent.length ? (1000 * st.recent.reduce((a, b) => a + b, 0)) / st.recent.length : null; },
    on(n, fn) { (listeners[n] ??= []).push(fn); },
    // the film camera: a player's judgment ({ kind, label, action, noteKey } from their 'judge')
    showJudgment({ kind, label, action, noteKey } = {}) {
      if (!watch || typeof kind !== 'string') return;
      const result = JUDGMENT_COLORS[kind] ? kind : 'miss', color = JUDGMENT_COLORS[result];
      const note = action === 'strike' && typeof noteKey === 'string' ? st.notes.get(noteKey) : null;
      if (note && !note.result) {
        note.judged = true; note.result = result; note.judgedAt = music.time();
        if (note.ring) note.ring.material.color.set(color);
      }
      flash.t = 1; flash.color.set(color);
      if (typeof label === 'string' && label) popup(label.slice(0, 24), color);
    },
    penalizeHandHit() {
      st.score -= HAND_HIT_PENALTY; st.combo = 0; st.counts.miss++;
      hazardTime = 0.9; flash.t = 1; flash.color.set(JUDGMENT_COLORS.miss);
      const now = music.time();
      for (const note of st.notes.values()) if (!note.judged && Math.abs(note.t - now) <= WINDOW.catch) {
        note.judged = true; note.result = 'miss'; note.judgedAt = now;
        if (note.ring) note.ring.material.color.set(JUDGMENT_COLORS.miss);
      }
      popup(`Hands! −${HAND_HIT_PENALTY}`, JUDGMENT_COLORS.miss);
      emit('penalty', { score: st.score, points: HAND_HIT_PENALTY });
    },
    // every: 'auto' | 1 | 2
    start(every = 'auto') {
      const a = music.analysis;
      if (!a) return false;
      st.every = every === 'auto' ? autoEvery(a) : Number(every);
      st.strikeTimes = strikesFromBeats(a, st.every);
      st.kneadTimes = kneadsFromStrikes(st.strikeTimes, a.duration);
      st.role = roleNow();
      st.strikes = st.role === 'knead' ? st.kneadTimes : st.strikeTimes;
      st.beats = st.strikes.slice();
      st.dur = a.duration;
      st.score = 0; st.combo = 0; st.maxCombo = 0; st.counts = { perfect: 0, good: 0, miss: 0 }; st.recent = [];
      st.lastKnead = -Infinity;
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
      hazardTime = Math.max(0, hazardTime - dt);
      hazardLight.intensity = 12 * (hazardTime / 0.9) * (0.65 + 0.35 * Math.abs(Math.sin(hazardTime * 24)));
      for (let i = popups.length - 1; i >= 0; i--) {
        const p = popups[i];
        p.t += dt;
        p.s.position.y += dt * 0.12;
        p.s.material.opacity = Math.max(0, 1 - p.t / 0.9);
        if (p.t > 0.9) { disposePopup(p); popups.splice(i, 1); }
      }
      if (!st.active) {
        rim.visible = hazardTime > 0;
        if (rim.visible) { rimMat.color.set(JUDGMENT_COLORS.miss); rimMat.opacity = hazardTime / 0.9; }
        return;
      }
      const now = music.time();
      if (!Number.isFinite(now)) return;
      syncRole();
      const pounding = station.phase === 'pound';
      const playerHasKine = !watch && (st.role === 'knead' ? station.mode === 'remote' : holdingHere());
      const linger = watch ? 0.6 : 0.35; // the camera waits a little longer for a judgment to arrive

      // new notes entering the approach window (only while there is dough to pound)
      if (pounding) {
        forEachStrike(now, now + LEAD_S, (t, key) => {
          if (st.notes.has(key)) return;
          st.notes.set(key, { t, key, ring: takeRing(), judged: false, unheld: !playerHasKine });
        });
      }
      // rings close in; unhit notes become misses; finished notes leave
      const ringY = y();
      for (const [key, note] of st.notes) {
        const left = note.t - now;
        if (!pounding && left > 0 && !note.judged) { if (note.ring) note.ring.visible = false; st.notes.delete(key); continue; }
        if (!note.judged && left < -(watch ? linger : WINDOW.catch)) {
          if (playerHasKine && !note.unheld) judge(note, WINDOW.catch, false, true);
          else note.judged = true;
        }
        const resultAge = note.result ? now - note.judgedAt : null;
        if (resultAge !== null ? resultAge > 0.65 : left < -linger) { if (note.ring) note.ring.visible = false; st.notes.delete(key); continue; }
        if (note.ring) {
          const k = Math.max(0, left / LEAD_S);
          note.ring.visible = true;
          note.ring.scale.setScalar(note.result ? RIM_R : RIM_R + (RING_START_R - RIM_R) * k);
          note.ring.position.set(L.USU.position[0], ringY, L.USU.position[2]);
          note.ring.material.opacity = note.result ? 0.9 * Math.max(0, 1 - resultAge / 0.65) : Math.min(0.9, (1 - k) * 1.4);
          note.ring.material.color.set(note.result ? JUDGMENT_COLORS[note.result] : 0xfff1d6);
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
