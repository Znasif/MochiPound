// Headless checks for the dough's elasticity/moisture state (src/dough/conditioning.js) and for rhythm
// notes following whoever holds the kine (src/rhythm/rhythm.js). No browser, headset or sound.
//   node --test scripts/test-conditioning.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { CONDITIONING as C, createConditioning, youngsModulusFor } from '../src/dough/conditioning.js';
import { createRhythm } from '../src/rhythm/rhythm.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);
const success = (s, id, extra = {}) => s.reward({ epoch: s.snapshot().epoch, action: 'strike', kind: 'good', id, ...extra });

test('stiffness sweeps only Young\'s modulus, stiff to soft', () => {
  assert.equal(youngsModulusFor(0), C.stiffE);
  assert.equal(youngsModulusFor(1), C.softE);
  assert.equal(youngsModulusFor(2), C.softE, 'clamped');
  const s = createConditioning();
  assert.equal(s.youngsModulus, C.stiffE, 'fresh rice starts at its stiffest');
});

test('each successful action softens it once; misses, repeats and old batches do not', () => {
  const s = createConditioning();
  assert.ok(success(s, 'a'));
  near(s.snapshot().elasticity, C.elasticityPerSuccess, 'one success');
  assert.ok(!success(s, 'a'), 'the same note is not rewarded twice');
  assert.ok(!success(s, 'b', { kind: 'miss' }), 'a miss earns nothing');
  assert.ok(!success(s, 'c', { action: 'jump' }), 'only strikes and kneads');
  assert.ok(s.reward({ epoch: s.snapshot().epoch, action: 'knead', kind: 'perfect', id: 'a' }), 'a knead on the same note id is its own action');
  const before = s.snapshot().elasticity;
  s.reset();
  assert.ok(!s.reward({ epoch: 0, action: 'strike', kind: 'good', id: 'z' }), 'an action from the previous batch');
  assert.equal(s.snapshot().elasticity, 0, 'a new batch starts stiff again');
  assert.ok(before > 0);
});

test('moisture dries; below the mark successes stop and elasticity drains; water restores it', () => {
  const s = createConditioning();
  for (let i = 0; i < 10; i++) success(s, `n${i}`);
  near(s.snapshot().elasticity, 10 * C.elasticityPerSuccess, 'ten successes');
  const toMark = (C.initialMoisture - C.moistureThreshold) / C.dryingPerSecond;
  s.update(toMark - 1);
  near(s.snapshot().elasticity, 10 * C.elasticityPerSuccess, 'above the mark nothing is lost');
  s.update(3); // 1 s above the mark, 2 s below it
  near(s.snapshot().elasticity, 10 * C.elasticityPerSuccess - 2 * C.dryElasticityLossPerSecond, 'only the time below the mark drains');
  assert.ok(s.snapshot().moisture < C.moistureThreshold);
  assert.ok(!success(s, 'dry'), 'no reward while dry');
  s.water();
  assert.ok(s.snapshot().moisture >= C.moistureThreshold, 'a dip brings it back above the mark');
  assert.ok(success(s, 'wet'), 'rewards resume after a dip');
});

test('a follower takes only newer host state', () => {
  const host = createConditioning(), guest = createConditioning();
  success(host, 'a'); host.update(0.1);
  assert.ok(guest.apply(host.snapshot()));
  near(guest.snapshot().elasticity, host.snapshot().elasticity, 'guest matches the host');
  const old = { ...host.snapshot(), revision: host.snapshot().revision - 1, elasticity: 0 };
  assert.ok(!guest.apply(old), 'an older revision is ignored');
  assert.ok(!guest.apply({ ...host.snapshot(), elasticity: NaN }), 'malformed state is ignored');
});

test('rhythm notes follow the kine: strike while holding it here, knead while the other holds it', () => {
  const original = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ strokeText() {}, fillText() {} }) }) };
  try {
    const listeners = {};
    const station = { mode: 'remote', phase: 'pound', on(n, fn) { listeners[n] = fn; }, setRhythm() {} };
    const emit = (n, d) => listeners[n]?.(d);
    const analysis = { beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], strength: [2, 1, 2, 1, 2, 1, 2, 1], period: 0.5, duration: 4.5, bpm: 120 };
    let t = 0.4;
    const music = { analysis, time: () => t };
    const judged = [];
    // the host, while the guest holds the kine: it kneads
    const r = createRhythm({ scene: new THREE.Scene(), station, music });
    r.on('judge', (j) => judged.push(j));
    r.start(1); r.update(0.01);
    assert.equal(r.kneading, true, 'the other headset holds the kine: kneading notes');
    t = 0.75; r.update(0.01); // kneads sit halfway between strikes (0.5, 1)
    emit('pound', { by: 'remote' });
    assert.equal(judged.length, 0, 'the other headset\'s strike is not this player\'s note');
    emit('turn', { hand: 0 });
    assert.equal(judged.at(-1)?.action, 'knead');
    assert.equal(judged.at(-1)?.kind, 'perfect');
    // the kine comes back to this headset
    station.mode = 'desktop'; t = 0.9; r.update(0.01); t = 1;
    assert.equal(r.kneading, false, 'holding it here: strike notes');
    emit('turn', { hand: 0 });
    assert.equal(judged.length, 1, 'a fold is not judged while this player holds the kine');
    emit('pound', { by: 'player', rushed: false });
    assert.equal(judged.at(-1)?.action, 'strike');
    assert.equal(judged.at(-1)?.kind, 'perfect');
    // nobody holds it: this headset's default role, notes unjudged
    station.mode = 'idle'; t = 1.4; r.update(0.01); t = 1.8; r.update(0.01); // the 1.5 note has expired
    assert.equal(r.kneading, false, 'the host\'s default is striking');
    assert.equal(judged.length, 2, 'expired notes pass unjudged while nobody holds the kine');
  } finally {
    if (original === undefined) delete globalThis.document; else globalThis.document = original;
  }
});
