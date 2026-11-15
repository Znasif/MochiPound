import * as THREE from 'three';
import { toB64, fromB64 } from './net.js';
import { createRabbitAvatar } from './rabbitAvatar.js';
import { controllerCurl } from './hands.js';

// Two headsets in one scene, sharing as little as possible (2026-11-15, the user's choice): each headset
// runs everything itself (the batch, its own dough, the sounds,
// the strike count), so nothing on it waits for the network. What crosses the network (src/net.js):
//   both   'pose'   ~45/s  head pose, tracked hand joints (src/hands.js encode) and the kine while this
//                          headset holds it. Each headset draws the other person's head and hands (eased,
//                          so they glide), and they are colliders in its own dough; a kine held on the other
//                          headset is posed from it here (station mode 'remote'): it pounds this dough too,
//                          and its strikes count and sound here
//   host   'phase'         the batch phase (load, pound, done) on every change and once a second: the guest
//                          plays each phase itself and starts the next when the host does (station.followPhase)
//   guest  'kine-take', 'kine-drop'; host 'kine-grant' {ok}, 'kine-revoked'
//                          one kine, one holder: the host decides who. Either person can hold it (VR grip or
//                          desktop E); whoever doesn't, kneads
//   host   'kine-asset'    stable mallet asset ID on change and once a second, also included in poses
//                          and ownership grants, so late joins and held-tool colliders use the same asset
//   host   'dough'  ~12/s  the host's dough particles (16-bit positions and velocities, ~6 KB on the headset's
//                          tier): the dough is the host's. The guest keeps simulating its own copy, so this
//                          person's hands act on it at once, and eases its particles toward the host's
//                          (dough.applySnapshot), so both see the same lump. Both build the dough the same way
//                          (the guest takes the host's tier), so particle i is the same bit of dough on both
// src/musicSync.js shares the host's music clock and song; the guest cues kneads between host strikes.
// A third page, the film camera (?mp=watch, createWatchSync), only listens: it follows the host like the
// guest and draws both players. Its 'hello' tells the host to send the dough and judgments ('judge').

const POSE_DT = 1 / 45, DOUGH_DT = 1 / 12;
// while the film camera records a take (its 'film-rate', every 0.5 s): poses at 60/s and the dough at 30/s, so
// the offline render has a sample for nearly every frame
const FILM_POSE_DT = 1 / 60, FILM_DOUGH_DT = 1 / 30, FILM_HOLD_MS = 1500;
function filmWatch(net) {
  let until = 0;
  net.on('film-rate', (d, peer) => { if (peer.role === 'watch') until = performance.now() + FILM_HOLD_MS; });
  return () => performance.now() < until;
}
const DOUGH_EASE = 0.35; // share of the way to the host's particles per update (~0.25 s to agree)

function headPose(camera) {
  const p = camera.getWorldPosition(new THREE.Vector3()), q = camera.getWorldQuaternion(new THREE.Quaternion());
  return [...p.toArray(), ...q.toArray()].map((v) => Math.round(v * 1e4) / 1e4);
}
const handsOut = (hands) => hands.encode().map((a) => (a ? toB64(new Uint8Array(a.buffer)) : null));
const handsIn = (list) => list?.map((s) => (s ? new Float32Array(fromB64(s).buffer) : null)) ?? [null, null];

// Keep left/right identity even when hands cross. Free controllers must animate their own arms too.
export function avatarInputs(controllers = [], hands) {
  const effectors = {};
  for (const c of controllers) {
    if (!c.source || c.source.hand || !['left', 'right'].includes(c.handedness) || c.grip.visible === false) continue;
    // curl: [trigger, squeeze, thumb], so the other headset poses this controller hand's fingers too
    effectors[c.handedness] = { pose: headPose(c.grip), kind: 'controller', curl: controllerCurl(c.source.gamepad) };
  }
  for (const h of hands?.hands ?? []) {
    if (h.remote || !h.tracked || !['left', 'right'].includes(h.handedness)) continue;
    const wrist = h.group?.joints?.wrist;
    if (wrist?.visible) effectors[h.handedness] = { pose: headPose(wrist), kind: 'hand', slot: h.i };
  }
  return effectors;
}

// both roles: send this headset's pose (and the kine while this headset holds it), take in the other's
function createPoseLink({ net, hands, camera, scene, station, controllers, onPose }) {
  const avatar = createRabbitAvatar(scene, { variant: net.role === 'host' ? 'indigo' : 'red', hands, kine: () => station.kine });
  let clock = 0, acc = 0;
  const filming = filmWatch(net);
  net.on('pose', (d, peer) => {
    if (peer.role !== (net.role === 'host' ? 'join' : 'host')) return;
    hands.setRemote(handsIn(d.hands)); avatar.set(d.head, clock, d.kine, d.effectors); onPose?.(d, clock, peer);
  });
  return {
    get clock() { return clock; },
    get otherHead() { return avatar.headPosition; }, // the other person's head (world), or null while unseen
    update(dt) {
      clock += dt; acc += dt;
      avatar.update(clock, dt);
      if (acc >= (filming() ? FILM_POSE_DT : POSE_DT)) { acc = 0; net.send('pose', { head: headPose(camera), hands: handsOut(hands), kine: station.heldKineTarget(), assetId: station.kineAssetId, effectors: avatarInputs(controllers, hands) }); }
    },
  };
}

export function createHostSync({ net, station, hands, camera, scene, controllers }) {
  // the guest holding the kine: posed from each 'pose' message; let go if they go quiet for a second
  let kineSeen = -Infinity, phaseAcc = 0, doughAcc = 0, conditionAcc = 0, kineHolder = null;
  const hitReports = new Set();
  // coh: the dough's mean cohesion, its look, which a film playback can't simulate
  const sendDough = (snap) => net.send('dough', { tier: snap.tier, N: snap.N, x: toB64(new Uint8Array(snap.x.buffer)), v: toB64(new Uint8Array(snap.v.buffer)), coh: station.dough.stats.cohesion });
  const filming = filmWatch(net);
  const pose = createPoseLink({
    net, hands, camera, scene, station, controllers,
    onPose(d, now, peer) {
      if (station.mode !== 'remote' || peer.from !== kineHolder || !d.kine) return;
      kineSeen = now;
      // A pose from before a tool change uses the old grip. Wait for the holder to apply the
      // host's asset ID rather than colliding that old pose with a differently shaped mallet.
      if (d.assetId !== station.kineAssetId) return;
      station.setRemoteKine(d.kine);
    },
  });
  const sendAsset = () => net.send('kine-asset', { assetId: station.kineAssetId });
  station.on('kine-asset', sendAsset);
  station.on('phase', (phase) => net.send('phase', { phase }));
  const sendConditioning = () => { if (station.conditioning) net.send('conditioning', station.conditioning); };
  station.on('conditioning', sendConditioning);
  station.on('hand-hit', (event) => net.send('hand-hit', event));
  net.on('rhythm-judgment', (event, peer) => {
    if (peer.role !== 'join') return;
    if (event.action === 'strike' && peer.from !== kineHolder) return;
    station.recordJudgment?.(event);
  });
  net.on('hand-hit-report', (event, peer) => {
    if (peer.role !== 'join' || typeof event.id !== 'string' || event.id.length > 80 || event.epoch !== station.conditioning?.epoch) return;
    const key = `${peer.from}:${event.id}`;
    if (hitReports.has(key)) return;
    hitReports.add(key); if (hitReports.size > 256) hitReports.delete(hitReports.values().next().value);
    station.reportHandHit?.();
  });
  net.on('kine-take', (d, peer) => {
    if (peer.role !== 'join') return;
    if (station.mode !== 'idle') { net.send('kine-grant', { to: peer.from, ok: false }); return; }
    station.setRemoteKine(null); station.setMode('remote'); kineSeen = pose.clock;
    kineHolder = peer.from;
    net.send('kine-grant', { to: peer.from, ok: true, assetId: station.kineAssetId });
    console.info('[mp] the guest took the kine');
  });
  net.on('kine-drop', (d, peer) => { if (station.mode === 'remote' && peer.from === kineHolder) { kineHolder = null; station.setMode('idle'); station.setRemoteKine(null); console.info('[mp] the guest put the kine down'); } });
  return {
    role: 'host',
    get peer() { return net.has('join'); },
    get otherHead() { return pose.otherHead; },
    update(dt) {
      pose.update(dt);
      conditionAcc += dt;
      if (conditionAcc >= 0.2) { conditionAcc = 0; sendConditioning(); }
      if (station.mode === 'remote' && pose.clock - kineSeen > 1) {
        station.setMode('idle'); station.setRemoteKine(null); net.send('kine-revoked', { to: kineHolder }); kineHolder = null;
        console.info('[mp] the guest went quiet: the kine goes back beside the mortar');
      }
      // the phase once a second too, for a guest that just joined or missed a change
      phaseAcc += dt;
      if (phaseAcc >= 1) { phaseAcc = 0; net.send('phase', { phase: station.phase }); sendAsset(); }
      // the dough, while someone has joined
      doughAcc += dt;
      if (doughAcc >= (filming() ? FILM_DOUGH_DT : DOUGH_DT) && (net.has('join') || net.has('watch'))) { doughAcc = 0; station.dough.requestSnapshot(sendDough); }
    },
  };
}

export function createGuestSync({ net, station, hands, camera, scene, controllers }) {
  station.setFollower(true);
  // the host holding the kine (its 'pose' carries it): posed from it here
  let hostKineSeen = -Infinity;
  const pose = createPoseLink({
    net, hands, camera, scene, station, controllers,
    onPose(d, now) {
      if (d.assetId) station.setKineAsset(d.assetId);
      if (!d.kine) return;
      if (station.mode === 'idle') station.setMode('remote');
      if (station.mode === 'remote') { station.setRemoteKine(d.kine); hostKineSeen = now; }
    },
  });
  net.on('kine-asset', (d, peer) => { if (peer.role === 'host') station.setKineAsset(d.assetId); });
  net.on('conditioning', (state, peer) => { if (peer.role === 'host') station.applyConditioning?.(state); });
  net.on('hand-hit', (event, peer) => { if (peer.role === 'host') station.receiveHandHit?.(event); });
  let hitSequence = 0;
  station.on('kine_contact', (contact) => {
    if (contact.kind === 'hand' && station.phase === 'pound') {
      net.send('hand-hit-report', { id: String(++hitSequence), epoch: station.conditioning?.epoch });
    }
  });
  net.on('phase', (m) => station.followPhase(m.phase));
  net.on('dough', (m) => station.dough.applySnapshot({ tier: m.tier, N: m.N, x: new Int16Array(fromB64(m.x).buffer), v: new Int16Array(fromB64(m.v).buffer) }, DOUGH_EASE));
  let onKine = null;
  net.on('kine-grant', (m, peer) => {
    if (peer.role !== 'host' || m.to !== net.id) return;
    if (m.ok && !station.setKineAsset(m.assetId)) { net.send('kine-drop', {}); onKine?.(false); return; }
    onKine?.(m.ok);
  });
  net.on('kine-revoked', (m, peer) => { if (peer.role === 'host' && m.to === net.id) onKine?.(false); });
  return {
    role: 'join',
    get peer() { return net.has('host'); },
    get otherHead() { return pose.otherHead; },
    update(dt) {
      pose.update(dt);
      if (station.mode === 'remote' && pose.clock - hostKineSeen > 0.5) { station.setMode('idle'); station.setRemoteKine(null); }
    },
    // the guest's kine: ask the host; onKine(ok) when it answers (false also when it takes the kine back)
    takeKine() { net.send('kine-take', {}); },
    reportJudgment(event) { net.send('rhythm-judgment', event); }, // the guest's turns count on the host
    dropKine() { net.send('kine-drop', {}); },
    set onKine(fn) { onKine = fn; },
  };
}

// The film camera (?mp=watch): renders the host's world from a free camera and never changes it. It follows
// the host's batch, dough, mallet and meters as the guest does, and draws both players: the host (red) with
// hand slots 2, 3 and the guest (indigo) with 4, 5 (createHands { remoteSets: 2 }). It sends no poses.
// apply(role, type, data) is the one way in, for live messages and for a recorded take played back
// (src/film/render.js); exact turns off the easing, since a played-back take is already smooth and on time.
export function createWatchSync({ net, station, hands, scene }) {
  station.setFollower(true);
  const players = {
    host: { set: 0, avatar: createRabbitAvatar(scene, { variant: 'red', hands, slotBase: 2, kine: () => station.kine }) },
    join: { set: 1, avatar: createRabbitAvatar(scene, { variant: 'indigo', hands, slotBase: 4, kine: () => station.kine }) },
  };
  let clock = 0, kineFrom = null, kineSeen = -Infinity, exact = false;
  const unpackDough = (m) => ({ tier: m.tier, N: m.N, x: new Int16Array(fromB64(m.x).buffer), v: new Int16Array(fromB64(m.v).buffer), coh: m.coh });
  // hands: as sent (base64 per hand), or already decoded (Float32Array per hand, from a recording)
  const decodeHands = (list) => list?.map((h) => (h == null ? null : typeof h === 'string' ? new Float32Array(fromB64(h).buffer) : h)) ?? [null, null];
  function apply(role, type, d) {
    if (type === 'pose') {
      const p = players[role];
      if (!p || !d) return;
      hands.setRemote(decodeHands(d.hands), p.set);
      p.avatar.set(d.head, clock, d.kine, d.effectors);
      if (role === 'host' && d.assetId) station.setKineAsset(d.assetId);
      if (!d.kine || (d.assetId && d.assetId !== station.kineAssetId)) return; // a pose from before a mallet change
      if (station.mode === 'idle') station.setMode('remote');
      if (station.mode === 'remote') { station.setRemoteKine(d.kine); kineFrom = role; kineSeen = clock; }
      return;
    }
    if (role !== 'host') return;
    if (type === 'kine-asset') station.setKineAsset(d.assetId);
    else if (type === 'conditioning') station.applyConditioning?.(d);
    else if (type === 'hand-hit') station.receiveHandHit?.(d);
    else if (type === 'phase') station.followPhase(d.phase);
    else if (type === 'dough') { if (!station.dough.playback) station.dough.applySnapshot(d.x instanceof Int16Array ? d : unpackDough(d), DOUGH_EASE); }
  }
  for (const type of ['pose', 'kine-asset', 'conditioning', 'hand-hit', 'phase', 'dough']) net.on(type, (d, peer) => apply(peer.role, type, d));
  return {
    role: 'watch',
    get peer() { return net.has('host'); },
    get guestHere() { return net.has('join'); },
    get otherHead() { return null; },
    // the players' heads, for the camera's orbit (null while that person isn't seen)
    head(role) { return players[role]?.avatar.headPosition ?? null; },
    apply, unpackDough, decodeHands,
    get exact() { return exact; },
    set exact(v) {
      exact = !!v;
      for (const p of Object.values(players)) p.avatar.exact = exact;
      hands.exact = exact; station.setRemoteExact?.(exact);
    },
    update(dt) {
      clock += dt;
      for (const p of Object.values(players)) p.avatar.update(clock, dt);
      if (station.mode === 'remote' && clock - kineSeen > 0.5) { station.setMode('idle'); station.setRemoteKine(null); kineFrom = null; }
    },
    get kineHolder() { return kineFrom; },
  };
}
