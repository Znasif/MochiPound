// Headless checks for the dough's elasticity/moisture state (src/dough/conditioning.js) and for rhythm
// notes following whoever holds the kine (src/rhythm/rhythm.js). No browser, headset or sound.
//   node --test scripts/test-conditioning.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { CONDITIONING as C, createConditioning, youngsModulusFor } from '../src/dough/conditioning.js';
import { createRhythm } from '../src/rhythm/rhythm.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const judge = (s, action, kind, id) => s.judge({ epoch: s.snapshot().epoch, action, kind, id });
// one turn: the striker's judgment, then the kneader's
const turn = (s, id, strike, knead) => { judge(s, 'strike', strike, id); return judge(s, 'knead', knead, id); };
const pct = (s) => Math.round(s.snapshot().elasticity * 1e6) / 1e4; // elasticity in %

test('stiffness sweeps only Young\'s modulus, stiff to soft', () => {
  assert.equal(youngsModulusFor(0), C.stiffE);
  assert.equal(youngsModulusFor(1), C.softE);
  assert.equal(youngsModulusFor(2), C.softE, 'clamped');
  assert.equal(createConditioning().youngsModulus, C.stiffE, 'fresh rice starts at its stiffest');
});

test('each turn adds the average of its strike and knead: perfect +5, good +1, bad -3 (in %)', () => {
  const s = createConditioning();
  assert.ok(turn(s, 't1', 'perfect', 'perfect')); assert.equal(pct(s), 5, 'both perfect: +5');
  assert.ok(turn(s, 't2', 'perfect', 'good')); assert.equal(pct(s), 8, 'perfect and good: +3');
  assert.ok(turn(s, 't3', 'good', 'miss')); assert.equal(pct(s), 7, 'good and bad: -1');
  assert.ok(turn(s, 't4', 'miss', 'miss')); assert.equal(pct(s), 4, 'both bad: -3');
  assert.ok(turn(s, 't5', 'miss', 'miss') && turn(s, 't6', 'miss', 'miss')); assert.equal(pct(s), 0, 'never below stiff');
  // the knead's judgment can arrive first (it comes over the network from the guest), or turns can interleave
  judge(s, 'knead', 'perfect', 'a'); judge(s, 'strike', 'good', 'b');
  assert.equal(pct(s), 0, 'half turns wait');
  assert.ok(judge(s, 'strike', 'perfect', 'a')); assert.ok(judge(s, 'knead', 'good', 'b'));
  assert.equal(pct(s), 6, 'each completes with its own partner');
  for (let i = 0; i < 30; i++) turn(s, `p${i}`, 'perfect', 'perfect');
  assert.equal(pct(s), 100, 'fully elastic after 20 perfect turns');
});

test('one player\'s judgments alone never change it, and nothing counts twice', () => {
  const s = createConditioning();
  for (let i = 0; i < 100; i++) judge(s, 'strike', 'perfect', `solo${i}`);
  assert.equal(pct(s), 0, 'striking alone, however well');
  assert.ok(s.waiting <= C.turnsKept, 'half turns that never complete are not kept forever');
  assert.ok(!turn(s, 'x', 'perfect', 'nonsense'), 'unknown judgment');
  assert.ok(!judge(s, 'jump', 'perfect', 'x'), 'only strikes and kneads');
  assert.ok(turn(s, 'y', 'perfect', 'perfect'));
  assert.ok(!judge(s, 'knead', 'perfect', 'y') && !turn(s, 'y', 'perfect', 'perfect'), 'a judged turn is not judged again');
  assert.equal(pct(s), 5);
  s.reset();
  assert.ok(!s.judge({ epoch: 0, action: 'strike', kind: 'perfect', id: 'z' }), 'a judgment from the previous batch');
  assert.equal(s.snapshot().elasticity, 0, 'a new batch starts stiff again');
  assert.equal(s.waiting, 0);
});

test('moisture is only colour now: it dries, a dip adds 10%, and elasticity ignores it', () => {
  const s = createConditioning();
  turn(s, 'a', 'perfect', 'perfect');
  s.update(200);
  assert.equal(s.snapshot().moisture, 0, 'it dries out');
  assert.equal(pct(s), 5, 'a dry dough keeps its elasticity');
  assert.ok(turn(s, 'b', 'good', 'good'), 'and still takes rhythm while dry');
  s.water(); near(s.snapshot().moisture, C.waterPerDip, 'a dip');
  assert.equal(C.waterPerDip, 0.1);
  for (let i = 0; i < 20; i++) s.water();
  assert.equal(s.snapshot().moisture, 1, 'never above full');
});

test('a follower takes only newer host state', () => {
  const host = createConditioning(), guest = createConditioning();
  turn(host, 'a', 'perfect', 'good'); host.update(0.1);
  assert.ok(guest.apply(host.snapshot()));
  near(guest.snapshot().elasticity, host.snapshot().elasticity, 'guest matches the host');
  const old = { ...host.snapshot(), revision: host.snapshot().revision - 1, elasticity: 0 };
  assert.ok(!guest.apply(old), 'an older revision is ignored');
  assert.ok(!guest.apply({ ...host.snapshot(), elasticity: NaN }), 'malformed state is ignored');
});

const withDocument = (fn) => {
  const original = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ strokeText() {}, fillText() {} }) }) };
  try { fn(); } finally { if (original === undefined) delete globalThis.document; else globalThis.document = original; }
};
const analysis = { beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], strength: [2, 1, 2, 1, 2, 1, 2, 1], period: 0.5, duration: 4.5, bpm: 120 };
function rig(mode) {
  const listeners = {}, station = { mode, phase: 'pound', on(n, fn) { listeners[n] = fn; }, setRhythm() {} };
  const clock = { t: 0 }, judged = [];
  const r = createRhythm({ scene: new THREE.Scene(), station, music: { analysis, time: () => clock.t } });
  r.on('judge', (j) => judged.push(j));
  return { r, station, clock, judged, emit: (n, d) => listeners[n]?.(d) };
}

test('the striker\'s and the kneader\'s judgments of one turn share its key, across the song\'s loop too', () => withDocument(() => {
  const striker = rig('desktop'), kneader = rig('remote');
  for (const p of [striker, kneader]) { p.clock.t = 0.3; p.r.start(1); p.r.update(0.01); }
  striker.clock.t = 0.5; striker.emit('pound', { by: 'player' });
  kneader.clock.t = 0.75; kneader.emit('turn', { hand: 0 });
  assert.equal(striker.judged[0].turn, 500); assert.equal(kneader.judged[0].turn, 500, 'the knead after the 0.5 s strike');
  // the last knead of each loop wraps past the song's end: it still belongs to the loop's last strike
  for (const p of [striker, kneader]) { p.clock.t = 3.9; p.r.update(0.01); }
  striker.clock.t = 4.0; striker.emit('pound', { by: 'player' });
  kneader.clock.t = 4.4; kneader.r.update(0.01); kneader.clock.t = 4.5; kneader.emit('turn', { hand: 1 });
  assert.equal(striker.judged.at(-1).turn, 4000);
  assert.equal(kneader.judged.at(-1).turn, 4000, 'the wrapped knead at the loop point');
  assert.equal(kneader.judged.at(-1).kind, 'perfect');
  // and they make one turn on the host
  const s = createConditioning();
  for (const j of [striker.judged[0], kneader.judged[0]]) s.judge({ epoch: 0, action: j.action, kind: j.kind, id: `song:${j.turn}` });
  assert.equal(pct(s), 5);
  // a missed note is a judgment too (bad, -3), so a player who doesn't act drags the turn down
  for (let t = 4.6; t <= 5.6; t += 0.1) { striker.clock.t = t; striker.r.update(0.1); }
  assert.ok(striker.judged.some((j) => j.kind === 'miss' && j.turn === 5000), 'the unstruck 5.0 s note is judged bad');
}));

test('rhythm notes follow the kine: strike while holding it here, knead while the other holds it', () => withDocument(() => {
  const { r, station, clock, judged, emit } = rig('remote');
  clock.t = 0.4; r.start(1); r.update(0.01);
  assert.equal(r.kneading, true, 'the other headset holds the kine: kneading notes');
  clock.t = 0.75; r.update(0.01);
  emit('pound', { by: 'remote' });
  assert.equal(judged.length, 0, 'the other headset\'s strike is not this player\'s note');
  emit('turn', { hand: 0 });
  assert.equal(judged.at(-1)?.action, 'knead');
  assert.equal(judged.at(-1)?.kind, 'perfect');
  station.mode = 'desktop'; clock.t = 0.9; r.update(0.01); clock.t = 1;
  assert.equal(r.kneading, false, 'holding it here: strike notes');
  emit('turn', { hand: 0 });
  assert.equal(judged.length, 1, 'a fold is not judged while this player holds the kine');
  emit('pound', { by: 'player', rushed: false });
  assert.equal(judged.at(-1)?.action, 'strike');
  assert.equal(judged.at(-1)?.kind, 'perfect');
  station.mode = 'idle'; clock.t = 1.4; r.update(0.01); clock.t = 1.8; r.update(0.01);
  assert.equal(r.kneading, false, 'the host\'s default is striking');
  assert.equal(judged.length, 2, 'expired notes pass unjudged while nobody holds the kine');
}));
