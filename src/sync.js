import * as THREE from 'three';
import { toB64, fromB64 } from './net.js';

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
//                          one kine, one holder: the host decides who
//   host   'dough'  ~12/s  the host's dough particles (16-bit positions and velocities, ~6 KB on the headset's
//                          tier): the dough is the host's. The guest keeps simulating its own copy, so this
//                          person's hands act on it at once, and eases its particles toward the host's
//                          (dough.applySnapshot), so both see the same lump. Both build the dough the same way
//                          (the guest takes the host's tier), so particle i is the same bit of dough on both
// Either headset can hold the kine (VR or desktop) or knead: whoever holds the kine pounds, and a second kneader
// is placed at the far rim. Music in rhythm mode plays on both headsets: the host leads it and the guest lines its
// own copy up with the host's clock (src/musicSync.js, its own messages).

const POSE_DT = 1 / 45, DOUGH_DT = 1 / 12;
const DOUGH_EASE = 0.35; // share of the way to the host's particles per update (~0.25 s to agree)
const STALE = 2.5; // s without news before the other headset counts as gone

// the other person: a head with a visor where their headset is, and a body down to the ground
function createAvatar(scene) {
  const g = new THREE.Group();
  g.name = 'other-player';
  const skin = new THREE.MeshStandardMaterial({ color: 0xd7b08c, roughness: 0.7 });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 18, 12), skin);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.07, 0.08), new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.3 }));
  visor.position.set(0, 0.01, -0.09); // the headset looks along -Z
  head.add(visor);
  g.add(head);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 1, 12), new THREE.MeshStandardMaterial({ color: 0x5a4a6a, roughness: 0.8 }));
  scene.add(g, body);
  g.visible = body.visible = false;
  let seen = -Infinity;
  const tp = new THREE.Vector3(), tq = new THREE.Quaternion();
  return {
    // where the other person's head is (null while they're not seen)
    get position() { return g.visible ? g.position : null; },
    set(pose, now) {
      if (!pose) return;
      tp.fromArray(pose, 0); tq.fromArray(pose, 3);
      if (now - seen > STALE) { g.position.copy(tp); g.quaternion.copy(tq); } // (re)appearing: no glide in
      seen = now;
    },
    update(now, dt) {
      g.visible = body.visible = now - seen < STALE;
      if (!g.visible) return;
      // eased toward the latest pose (they arrive ~45 a second, unevenly)
      const a = 1 - Math.exp(-dt * 20);
      g.position.lerp(tp, a); g.quaternion.slerp(tq, a);
      // the body hangs below the head, upright, its top 0.25 m under the eyes
      const top = Math.max(0.3, g.position.y - 0.25);
      body.scale.set(1, top, 1);
      body.position.set(g.position.x, top / 2, g.position.z);
    },
  };
}

function headPose(camera) {
  const p = camera.getWorldPosition(new THREE.Vector3()), q = camera.getWorldQuaternion(new THREE.Quaternion());
  return [...p.toArray(), ...q.toArray()].map((v) => Math.round(v * 1e4) / 1e4);
}
const handsOut = (hands) => hands.encode().map((a) => (a ? toB64(new Uint8Array(a.buffer)) : null));
const handsIn = (list) => list?.map((s) => (s ? new Float32Array(fromB64(s).buffer) : null)) ?? [null, null];

// both roles: send this headset's pose (and the kine while this headset holds it), take in the other's
function createPoseLink({ net, hands, camera, scene, station, onPose }) {
  const avatar = createAvatar(scene);
  let clock = 0, acc = 0;
  net.on('pose', (d) => { hands.setRemote(handsIn(d.hands)); avatar.set(d.head, clock); onPose?.(d, clock); });
  return {
    get clock() { return clock; },
    get otherHead() { return avatar.position; },
    update(dt) {
      clock += dt; acc += dt;
      avatar.update(clock, dt);
      if (acc >= POSE_DT) { acc = 0; net.send('pose', { head: headPose(camera), hands: handsOut(hands), kine: station.heldKineTarget() }); }
    },
  };
}

export function createHostSync({ net, station, hands, camera, scene }) {
  // the guest holding the kine: posed from each 'pose' message; let go if they go quiet for a second
  let kineSeen = -Infinity, phaseAcc = 0, doughAcc = 0;
  const sendDough = (snap) => net.send('dough', { tier: snap.tier, N: snap.N, x: toB64(new Uint8Array(snap.x.buffer)), v: toB64(new Uint8Array(snap.v.buffer)) });
  const pose = createPoseLink({
    net, hands, camera, scene, station,
    onPose(d, now) { if (station.mode === 'remote' && d.kine) { station.setRemoteKine(d.kine); kineSeen = now; } },
  });
  station.on('phase', (phase) => net.send('phase', { phase }));
  net.on('kine-take', () => {
    if (station.mode !== 'idle') { net.send('kine-grant', { ok: false }); return; }
    station.setRemoteKine(null); station.setMode('remote'); kineSeen = pose.clock;
    net.send('kine-grant', { ok: true });
    console.info('[mp] the guest took the kine');
  });
  net.on('kine-drop', () => { if (station.mode === 'remote') { station.setMode('idle'); station.setRemoteKine(null); console.info('[mp] the guest put the kine down'); } });
  return {
    role: 'host',
    get peer() { return net.has('join'); },
    get otherHead() { return pose.otherHead; },
    update(dt) {
      pose.update(dt);
      if (station.mode === 'remote' && pose.clock - kineSeen > 1) {
        station.setMode('idle'); station.setRemoteKine(null); net.send('kine-revoked', {});
        console.info('[mp] the guest went quiet: the kine goes back beside the mortar');
      }
      // the phase once a second too, for a guest that just joined or missed a change
      phaseAcc += dt;
      if (phaseAcc >= 1) { phaseAcc = 0; net.send('phase', { phase: station.phase }); }
      // the dough, while someone has joined
      doughAcc += dt;
      if (doughAcc >= DOUGH_DT && net.has('join')) { doughAcc = 0; station.dough.requestSnapshot(sendDough); }
    },
  };
}

export function createGuestSync({ net, station, hands, camera, scene }) {
  station.setFollower(true);
  // the host holding the kine (its 'pose' carries it): posed from it here
  let hostKineSeen = -Infinity;
  const pose = createPoseLink({
    net, hands, camera, scene, station,
    onPose(d, now) {
      if (!d.kine) return;
      if (station.mode === 'idle') station.setMode('remote');
      if (station.mode === 'remote') { station.setRemoteKine(d.kine); hostKineSeen = now; }
    },
  });
  net.on('phase', (m) => station.followPhase(m.phase));
  net.on('dough', (m) => station.dough.applySnapshot({ tier: m.tier, N: m.N, x: new Int16Array(fromB64(m.x).buffer), v: new Int16Array(fromB64(m.v).buffer) }, DOUGH_EASE));
  let onKine = null;
  net.on('kine-grant', (m) => onKine?.(m.ok));
  net.on('kine-revoked', () => onKine?.(false));
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
    dropKine() { net.send('kine-drop', {}); },
    set onKine(fn) { onKine = fn; },
  };
}
