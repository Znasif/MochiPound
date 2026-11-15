// Headless checks for the film camera (?mp=watch): it follows the host's world and draws both players
// without changing anything, its rings take the players' judgments, and its free camera glides, flies,
// orbits and zooms. No browser, GPU or network.
//   node --test scripts/test-film-camera.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createHostSync, createGuestSync, createWatchSync } from '../src/sync.js';
import { createHands, JOINTS } from '../src/hands.js';
import { createRhythm, JUDGMENT_COLORS } from '../src/rhythm/rhythm.js';
import { createSpectatorCam } from '../src/spectatorCam.js';

function network() {
  const queue = [], peers = [], sent = [];
  const make = (role, id) => {
    const listeners = {};
    const net = {
      role, id,
      on(type, fn) { (listeners[type] ??= []).push(fn); },
      has(other) { return peers.some((p) => p.net.role === other && p.net !== net); },
      send(type, data) {
        sent.push({ from: id, role, type, data });
        for (const peer of peers) if (peer.net !== net) queue.push({ peer, type, data, from: { role, from: id } });
      },
    };
    peers.push({ net, listeners });
    return net;
  };
  const flush = () => { while (queue.length) { const m = queue.shift(); for (const fn of m.peer.listeners[m.type] ?? []) fn(m.data, m.from); } };
  return { make, flush, sent };
}
function station() {
  const events = {};
  return {
    mode: 'idle', phase: 'pound', kineAssetId: 'yokogine', remotePose: null, pose: [0.2, 1.1, 0.3, 0, 0, 0, 1],
    follower: false, phases: [], snapshots: 0, requested: 0,
    on(type, fn) { (events[type] ??= []).push(fn); },
    setKineAsset(id) { this.kineAssetId = id; return true; },
    setMode(mode) { this.mode = mode; }, setFollower(f) { this.follower = f; }, followPhase(p) { this.phases.push(p); },
    setRemoteKine(p) { this.remotePose = p; },
    heldKineTarget() { return ['vr', 'desktop'].includes(this.mode) ? this.pose : null; },
    dough: { requestSnapshot(fn) { this.owner.requested++; }, applySnapshot() { this.owner.snapshots++; } },
    init() { this.dough.owner = this; return this; },
  };
}
const fakeHands = () => ({ hands: [], encode: () => [null, null], sets: [], setRemote(arrays, set = 0) { this.sets.push(set); } });

test('the film camera follows the host and draws both players, sending nothing that changes the game', () => {
  const { make, flush, sent } = network();
  const hostStation = station().init(), guestStation = station().init(), watchStation = station().init();
  const io = (net, st, hands) => ({ net, station: st, hands, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), controllers: [] });
  const host = createHostSync(io(make('host', 'h'), hostStation, fakeHands()));
  const watchHands = fakeHands();
  const watch = createWatchSync({ net: make('watch', 'w'), station: watchStation, hands: watchHands, scene: new THREE.Scene() });
  assert.equal(watchStation.follower, true, 'the camera follows the host\'s batch');

  host.update(1.05); flush(); // the host repeats its phase once a second
  assert.ok(hostStation.requested > 0, 'the host sends its dough to a camera even with no guest');
  assert.ok(watchStation.phases.includes('pound'), 'the camera takes the host\'s phase');

  hostStation.setMode('desktop'); host.update(0.03); flush();
  assert.equal(watchStation.mode, 'remote');
  assert.deepEqual(watchStation.remotePose, hostStation.pose, 'the host\'s mallet is drawn where it holds it');
  assert.ok(watchHands.sets.includes(0), 'host hands go to the first remote set');

  const guest = createGuestSync(io(make('join', 'g'), guestStation, fakeHands()));
  hostStation.setMode('idle'); guestStation.pose = [0.4, 1.2, 0.1, 0, 0, 0, 1];
  watch.update(0.6); // the host's mallet poses stopped: put down here too
  assert.equal(watchStation.mode, 'idle');
  guestStation.setMode('vr'); guest.update(0.03); flush();
  assert.ok(watchHands.sets.includes(1), 'guest hands go to the second remote set');
  assert.deepEqual(watchStation.remotePose, guestStation.pose, 'the guest\'s mallet is drawn too');
  assert.equal(watch.kineHolder, 'join');

  watch.update(0.03); flush();
  assert.ok(!sent.some((m) => m.from === 'w'), 'the camera sends nothing (its net\'s hello is the only sign of it)');
});

test('remote hand sets: the camera keeps the host\'s and the guest\'s hands apart', () => {
  const renderer = { xr: { getHand: () => new THREE.Group(), isPresenting: false } };
  const hands = createHands(renderer, new THREE.Group(), new THREE.Scene(), [], { remoteSets: 2 });
  const hand = (dx) => { const a = new Float32Array(JOINTS.length * 4); JOINTS.forEach((_, k) => { a[k * 4] = dx + k * 0.004; a[k * 4 + 1] = 0.8; a[k * 4 + 2] = k * 0.003; a[k * 4 + 3] = 0.008; }); return a; };
  hands.setRemote([hand(0), null], 0);
  hands.setRemote([hand(0.5), hand(0.7)], 1);
  hands.update(1 / 60);
  const tracked = hands.hands.filter((h) => h.tracked).map((h) => h.i);
  assert.deepEqual(tracked, [2, 4, 5]);
  assert.ok(hands.tools.length > 0, 'both players\' hands are colliders in the camera\'s dough copy');
  assert.equal(hands.any, false, 'none of them are the camera\'s own');
});

test('the camera\'s rings take the players\' judgments and never judge on their own', () => {
  const original = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ strokeText() {}, fillText() {} }) }) };
  try {
    const listeners = {}, scene = new THREE.Scene();
    const st = { mode: 'remote', phase: 'pound', on(n, fn) { listeners[n] = fn; }, setRhythm() {} };
    const analysis = { beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], strength: [2, 1, 2, 1, 2, 1, 2, 1], period: 0.5, duration: 4.5, bpm: 120 };
    let t = 0.4;
    const r = createRhythm({ scene, station: st, music: { analysis, time: () => t }, watch: true });
    let judged = 0; r.on('judge', () => judged++);
    r.start(1); r.update(0.01);
    assert.equal(r.kneading, false, 'strike rings, whoever holds the kine');
    t = 0.5; listeners.pound({ by: 'remote' }); listeners.turn?.({ hand: 2 });
    assert.equal(judged, 0, 'nothing is judged on the camera');
    r.showJudgment({ kind: 'good', label: 'Average · late', action: 'strike', noteKey: '0:0' });
    t = 0.55; r.update(0.01);
    const hex = (kind) => new THREE.Color(JUDGMENT_COLORS[kind]).getHexString();
    const coloured = scene.children.filter((m) => m.isMesh && m.visible && m.material.color.getHexString() === hex('good'));
    assert.ok(coloured.length >= 1, 'the matching ring turns yellow');
    t = 1.3; r.update(0.01); // 0.3 s past the 1.0 note, where a headset would have expired it: the camera still waits
    r.showJudgment({ kind: 'perfect', label: 'Good', action: 'strike', noteKey: '0:1' });
    t = 1.32; r.update(0.01);
    assert.ok(scene.children.some((m) => m.isMesh && m.visible && m.material.color.getHexString() === hex('perfect')), 'a late-arriving judgment still turns its ring green');
    r.showJudgment({ kind: 'nonsense' }); r.showJudgment(null ?? undefined); // ignored or shown as a miss, never a throw
  } finally {
    if (original === undefined) delete globalThis.document; else globalThis.document = original;
  }
});

test('the free camera glides to shots, flies, orbits and zooms', () => {
  const saved = { document: globalThis.document, add: globalThis.addEventListener };
  const win = {}, doc = {};
  globalThis.addEventListener = (type, fn) => { (win[type] ??= []).push(fn); };
  globalThis.document = {
    createElement: () => ({ style: {}, textContent: '' }), body: { append() {} }, pointerLockElement: null,
    addEventListener: (type, fn) => { (doc[type] ??= []).push(fn); },
  };
  const key = (type, code, extra = {}) => { for (const fn of win[type] ?? []) fn({ code, repeat: false, shiftKey: false, preventDefault() {}, ...extra }); };
  try {
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 400);
    const hostHead = new THREE.Vector3(0, 1.6, 1.12);
    const calls = [];
    const takes = { status: '', busy: false, toggle() { calls.push('toggle'); }, render() { calls.push('render'); }, discard() { calls.push('discard'); }, cancel() { calls.push('cancel'); } };
    const cam = createSpectatorCam({ camera, scene, takes, dom: { addEventListener() {}, width: 1280, height: 720 }, targets: { host: () => hostHead, join: () => null } });
    const run = (s) => { for (let i = 0; i < Math.round(s * 60); i++) cam.update(1 / 60); camera.updateMatrixWorld(true); };
    const looksAt = (p) => new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).dot(p.clone().sub(camera.position).normalize());
    cam.enable(); run(0.1);
    assert.equal(camera.parent, scene, 'the camera is off the player\'s rig');
    const mortar = new THREE.Vector3(0, 0.75, 0);
    assert.ok(looksAt(mortar) > 0.99, 'it starts on the wide shot, framed on the mortar');

    key('keydown', 'Digit4'); run(3.5);
    assert.ok(camera.position.distanceTo(new THREE.Vector3(0.05, 2.3, 0.35)) < 1e-3, 'glides to the top-down shot');
    assert.ok(looksAt(new THREE.Vector3(0, 0.72, 0)) > 0.99, 'looking down into the bowl');
    key('keydown', 'Digit1', { shiftKey: true }); run(1 / 60);
    assert.ok(camera.position.distanceTo(new THREE.Vector3(2.4, 1.8, 2.6)) < 1e-3, 'Shift cuts straight to a shot');

    const before = camera.position.clone();
    key('keydown', 'KeyW'); run(1); key('keyup', 'KeyW');
    const moved = camera.position.clone().sub(before);
    assert.ok(moved.length() > 0.6 && Math.abs(moved.y) < 1e-6, `W flies level toward the view (${moved.length().toFixed(2)} m)`);
    run(1);
    const coasted = camera.position.clone();
    run(0.5);
    assert.ok(camera.position.distanceTo(coasted) < 0.01, 'and eases to a stop');

    key('keydown', 'KeyO'); run(0.5);
    const radius = camera.position.distanceTo(mortar);
    key('keydown', 'KeyT'); const at = camera.position.clone(); run(2);
    assert.ok(Math.abs(camera.position.distanceTo(mortar) - radius) < 0.02, 'the turntable keeps its distance');
    assert.ok(camera.position.distanceTo(at) > 0.2, 'and turns around the mortar');
    assert.ok(looksAt(mortar) > 0.99, 'looking at it');
    key('keydown', 'KeyO'); run(2);
    assert.ok(looksAt(hostHead) > 0.99, 'O orbits the host next');
    key('keydown', 'KeyO'); // the guest isn't there: back to free flight
    key('keydown', 'KeyT');

    const fov = camera.fov;
    key('keydown', 'KeyZ'); run(1); key('keyup', 'KeyZ'); run(1);
    assert.ok(camera.fov < fov - 10, 'Z zooms in');
    key('keydown', 'KeyR'); key('keydown', 'Enter'); key('keydown', 'Backspace');
    assert.deepEqual(calls, ['toggle', 'render', 'discard'], 'R records a take, Enter renders it, Backspace discards it');
    key('keydown', 'Escape'); assert.equal(calls.length, 3, 'Esc cancels only a running render');
    takes.busy = true; key('keydown', 'Escape'); assert.equal(calls.at(-1), 'cancel');
  } finally {
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    if (saved.add === undefined) delete globalThis.addEventListener; else globalThis.addEventListener = saved.add;
  }
});
