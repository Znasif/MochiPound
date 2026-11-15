import * as THREE from 'three';
import { HAND_VISUAL_SCALE } from './pawVisual.js';

// Tracked hands (WebXR hand input: the Quest's hand tracking, controllers put down). They replace the
// kneeling turner NPC: a real person kneads the dough. Each hand is drawn from its tracked joints (a
// sphere per joint, a tube per bone, at the radii the headset reports), so what you see is what the dough
// and the mallet feel. (three's generic hand mesh came from a CDN with no error handling: a dropped
// download left a tracked hand invisible for the whole session, and it could also end up on the wrong hand
// when the headset reordered its hands.) The colliders, built from the same joints (no sizes assumed):
//  - for the dough: every bone (wrist to each metacarpal, then joint to joint to the tip) as a capped
//    cylinder of its two joints' mean radius. The dough is an elastic blob that sticks only to itself
//    (HAND, 2026-11-15): hands don't stick to it and don't mould it, but grip it by friction: dough a hand
//    presses against moves with it, and is let go the moment the hand eases off (mpm-core.js friction);
//    wet hands, after the bucket, slide. (tack > 0 makes hands sticky, mould > 0 makes their dents stay.)
//  - for the mallet (src/kineContact.js): every joint as a sphere of its radius.
// A headset only tracks the hands of the person wearing it. In multiplayer (src/net.js, src/sync.js) the
// other headset's hands arrive as joints over the network and become two more hand slots here: drawn the
// same way, and colliders in this headset's own dough (each headset simulates its own), so both people
// knead both doughs.

const FINGERS = ['thumb', 'index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'];
const CHAINS = FINGERS.map((f) => (f === 'thumb'
  ? ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip']
  : ['wrist', `${f}-metacarpal`, `${f}-phalanx-proximal`, `${f}-phalanx-intermediate`, `${f}-phalanx-distal`, `${f}-tip`]));
export const BONES = CHAINS.flatMap((c) => c.slice(1).map((b, k) => [c[k], b]));
// the WebXR hand joints in a fixed order, for sending them
export const JOINTS = ['wrist', ...CHAINS.flatMap((c) => c.slice(1))];
const UP = new THREE.Vector3(0, 1, 0);

// ---------- a hand on a controller (2026-11-15, the user's call: the same hand as when kneading, no controller model) ----------
// Drawn exactly as a tracked hand (a sphere per joint, a tube per bone, HAND_VISUAL_SCALE fuller, the same
// ivory). WebXR's grip space is a fist around a rod: -Z along the rod toward the thumb, +Y toward the arm, the
// back of the right hand toward +X (the left's toward -X). With nothing held, the hand holds the controller:
// its fingers wrap the rod, the trigger curls the index finger, the grip button the other three, and touching
// the stick or a face button lowers the thumb onto the top. Holding a mallet, the hand wraps that mallet's own
// handle instead (handleFrame: the thumb toward its head, the fingers sized to its radius), since the mallet
// sits a few cm off the controller's axis. Drawing only, never a collider: the hand holding the kine would
// collide with its own handle, and a free controller hand would count as hands in the bowl.
const CTRL_RADII = {
  wrist: 0.021, 'thumb-metacarpal': 0.02, 'thumb-phalanx-proximal': 0.0136, 'thumb-phalanx-distal': 0.0108, 'thumb-tip': 0.0087,
  metacarpal: 0.021, 'phalanx-proximal': 0.0109, 'phalanx-intermediate': 0.0086, 'phalanx-distal': 0.0076, tip: 0.0067,
};
// per finger: its place along the handle (z), and its length and thickness relative to the index finger
const CTRL_FINGERS = { 'index-finger': [-0.022, 1, 1], 'middle-finger': [-0.003, 1.06, 1.05], 'ring-finger': [0.016, 1, 0.97], 'pinky-finger': [0.033, 0.8, 0.88] };
const CTRL_SEG = [0.0446, 0.0253, 0.022]; // proximal, intermediate, distal bone lengths (m)
const KNUCKLE_ANGLE = -15 * Math.PI / 180; // where the knuckles sit on the wrap circle (+X: the back of the hand)
const CONTROLLER_ROD_R = 0.0195;           // a Quest Touch handle's radius
const FINGER_SKIN = CTRL_RADII['phalanx-proximal'] * HAND_VISUAL_SCALE + 0.001; // a drawn finger's thickness, plus a hair
// the wrist joint in grip space for the controller's own handle (right hand; x is mirrored for the left)
export const CONTROLLER_WRIST = Object.freeze([0.03, 0.08, 0.004]);
// the thumb on the controller's top: resting on the stick / buttons, or lifted off them
const CTRL_THUMB = {
  down: [[0.022, 0.05, -0.022], [0.008, 0.022, -0.042], [-0.014, 0.008, -0.05], [-0.03, -0.002, -0.052]],
  up: [[0.022, 0.05, -0.022], [0.01, 0.026, -0.045], [-0.006, 0.016, -0.06], [-0.018, 0.01, -0.07]],
};
const ctrlBall = new THREE.SphereGeometry(1, 14, 10), ctrlTube = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
// the buttons that pose a controller hand, from a gamepad (xr-standard: 0 trigger, 1 squeeze, 3 stick, 4-5 face)
export function controllerCurl(gamepad) {
  const b = gamepad?.buttons ?? [];
  const r2 = (v) => Math.round((v ?? 0) * 100) / 100;
  return [r2(b[0]?.value), r2(b[1]?.value), [3, 4, 5].some((i) => b[i]?.touched || b[i]?.pressed) ? 1 : 0];
}

// Where a held tool's handle runs, seen from a frame with inverse world matrix `inv` (a controller's grip):
// { position, quaternion, radius } for a hand wrapped around it with the thumb toward the tool's head, or null
// when the tool has no handle mesh ('kine-handle', or 'grip-wrap' where a mallet has one: that's held).
const hm = new THREE.Matrix4(), hp = new THREE.Vector3(), ha = new THREE.Vector3(), hh = new THREE.Vector3(), hs = new THREE.Vector3(), hq = new THREE.Quaternion();
export function handleFrame(tool, inv, out = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), radius: 0 }) {
  if (!tool) return null;
  let handle = null, wrap = null, head = null;
  tool.traverse((o) => {
    if (!o.isMesh) return;
    if (o.name === 'grip-wrap') wrap ??= o; else if (o.name === 'kine-handle') handle ??= o; else if (o.name === 'kine-head') head ??= o;
  });
  const grip = wrap ?? handle, g = grip?.geometry?.parameters;
  if (!g || !(g.height > 0)) return null;
  tool.updateWorldMatrix(true, true);
  hm.multiplyMatrices(inv, grip.matrixWorld).decompose(hp, hq, hs);
  ha.set(0, 1, 0).applyQuaternion(hq); // a cylinder's axis
  if (head) { hh.setFromMatrixPosition(hm.multiplyMatrices(inv, head.matrixWorld)); if (hh.sub(hp).dot(ha) < 0) ha.negate(); }
  // the hand's centre: the point of the axis nearest the frame's origin, kept on the handle
  const half = Math.max(0, g.height * hs.y / 2 - 0.05);
  out.position.copy(hp).addScaledVector(ha, THREE.MathUtils.clamp(-hp.dot(ha), -half, half));
  out.quaternion.setFromUnitVectors(Z_AXIS, ha.negate()); // the hand's -Z (the thumb) toward the head
  out.radius = Math.max(g.radiusTop ?? 0, g.radiusBottom ?? 0) * Math.max(hs.x, hs.z);
  return out;
}

export function createControllerHand({ material } = {}) {
  const mat = material ?? new THREE.MeshStandardMaterial({ color: 0xefdec5, roughness: 0.8, metalness: 0 });
  // group: at the grip (the caller places it); inner: moved onto a held mallet's handle
  const group = new THREE.Group(); group.name = 'controller-hand'; group.visible = false;
  const inner = new THREE.Group(); group.add(inner);
  const balls = new THREE.InstancedMesh(ctrlBall, mat, JOINTS.length), tubes = new THREE.InstancedMesh(ctrlTube, mat, BONES.length);
  for (const m of [balls, tubes]) { m.frustumCulled = false; m.castShadow = true; inner.add(m); }
  const joints = new Map(JOINTS.map((name) => [name, { p: new THREE.Vector3(), r: 0 }]));
  const curl = { index: 0.5, grip: 0.92, thumb: 1, hold: 0 }, d = new THREE.Vector3(), mid = new THREE.Vector3(), qq = new THREE.Quaternion();
  const m4 = new THREE.Matrix4(), sc = new THREE.Vector3(), q0 = new THREE.Quaternion();
  let side = 'right', placed = false, rodR = CONTROLLER_ROD_R;
  function pose() {
    const mx = side === 'left' ? -1 : 1;
    const set = (name, x, y, z, r) => { const j = joints.get(name); j.p.set(mx * x, y, z); j.r = r; };
    // the fingers' wrap circle: their joints lie on it at full curl, just clear of the handle
    const rho = rodR + FINGER_SKIN, shift = (rho - (CONTROLLER_ROD_R + FINGER_SKIN)) * Math.cos(KNUCKLE_ANGLE);
    set('wrist', CONTROLLER_WRIST[0] + shift, CONTROLLER_WRIST[1], CONTROLLER_WRIST[2], CTRL_RADII.wrist);
    for (const [f, [z, len, thick]] of Object.entries(CTRL_FINGERS)) {
      const c = f === 'index-finger' ? curl.index : curl.grip;
      set(`${f}-metacarpal`, 0.03 + shift, 0.062, z * 0.45, CTRL_RADII.metacarpal * thick);
      // full-curl bends for this circle: a chord's central angle, and the turn between successive chords
      const arc = CTRL_SEG.map((L) => 2 * Math.asin(Math.min(1, L * len / (2 * rho))));
      const bend = [arc[0] / 2 - KNUCKLE_ANGLE, (arc[0] + arc[1]) / 2, (arc[1] + arc[2]) / 2];
      let x = rho * Math.cos(KNUCKLE_ANGLE), y = rho * Math.sin(KNUCKLE_ANGLE), phi = 0;
      set(`${f}-phalanx-proximal`, x, y, z, CTRL_RADII['phalanx-proximal'] * thick);
      ['phalanx-intermediate', 'phalanx-distal', 'tip'].forEach((joint, k) => {
        phi += bend[k] * c; // curling from straight down the palm (-Y) toward the palm side
        x -= Math.sin(phi) * CTRL_SEG[k] * len; y -= Math.cos(phi) * CTRL_SEG[k] * len;
        set(`${f}-${joint}`, x, y, z, CTRL_RADII[joint] * thick);
      });
    }
    // the thumb: on the controller's top, or (holding a mallet) wrapped the other way round its handle
    const names = ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'];
    const wrapped = [[0.022 + shift, 0.05, -0.026], [35, -0.031], [100, -0.034], [150, -0.031]];
    names.forEach((name, k) => {
      const a = CTRL_THUMB.up[k], b = CTRL_THUMB.down[k], t = curl.thumb;
      let x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
      if (curl.hold > 0) {
        const w = wrapped[k], rr = rho + 0.004;
        const [wx, wy, wz] = k === 0 ? w : [rr * Math.cos(w[0] * Math.PI / 180), rr * Math.sin(w[0] * Math.PI / 180), w[1]];
        x += (wx - x) * curl.hold; y += (wy - y) * curl.hold; z += (wz - z) * curl.hold;
      }
      set(name, x, y, z, CTRL_RADII[name]);
    });
  }
  function draw() {
    let k = 0;
    for (const j of joints.values()) balls.setMatrixAt(k++, m4.compose(j.p, q0, sc.setScalar(j.r * HAND_VISUAL_SCALE)));
    BONES.forEach(([a, b], i) => {
      const ja = joints.get(a), jb = joints.get(b);
      d.subVectors(jb.p, ja.p); const len = d.length();
      mid.addVectors(ja.p, jb.p).multiplyScalar(0.5); qq.setFromUnitVectors(UP, d.multiplyScalar(1 / Math.max(len, 1e-6)));
      const r = (ja.r + jb.r) / 2 * HAND_VISUAL_SCALE;
      tubes.setMatrixAt(i, m4.compose(mid, qq, sc.set(r, len, r)));
    });
    balls.instanceMatrix.needsUpdate = tubes.instanceMatrix.needsUpdate = true;
  }
  const world = [...joints.keys()].map(() => new THREE.Vector3()), radii = [...joints.keys()].map(() => 0);
  const nq = new THREE.Quaternion(), nv = new THREE.Vector3();
  return {
    object3d: group,
    material: mat,
    get joints() { return joints; },
    // its joints in world space (reused vectors)
    worldPoints() { inner.updateWorldMatrix(true, false); let k = 0; for (const j of joints.values()) inner.localToWorld(world[k++].copy(j.p)); return world; },
    // their drawn radii, in the same order
    radii() { let k = 0; for (const j of joints.values()) radii[k++] = j.r * HAND_VISUAL_SCALE; return radii; },
    // move the drawn hand by a world-space shift (src/handContact.js: out of something solid), until its next update
    nudge(shift) { group.updateWorldMatrix(true, false); group.getWorldQuaternion(nq).invert(); inner.position.add(nv.copy(shift).applyQuaternion(nq)); },
    touching: false,
    // input: a gamepad, or controllerCurl()'s [trigger, squeeze, thumb] (the other player's, over the network).
    // held: handleFrame() of a mallet this hand holds (the hand moves onto its handle), or null
    update(dt, input, hand = side, held = null) {
      const [trigger, squeeze, thumb] = Array.isArray(input) ? input : controllerCurl(input);
      const k = placed && hand === side ? 1 - Math.exp(-dt * 20) : 1; // fingers ease; a new hand is placed at once
      side = hand === 'left' ? 'left' : 'right';
      const hold = held ? 1 : 0;
      curl.index += ((hold ? 1 : 0.5 + 0.5 * (trigger || 0)) - curl.index) * k;
      curl.grip += ((hold ? 1 : 0.92 + 0.08 * (squeeze || 0)) - curl.grip) * k;
      curl.thumb += ((thumb ? 1 : 0) - curl.thumb) * k;
      curl.hold += (hold - curl.hold) * k;
      rodR = held ? Math.max(0.01, held.radius) : CONTROLLER_ROD_R;
      if (held) { inner.position.copy(held.position); inner.quaternion.copy(held.quaternion); }
      else { inner.position.set(0, 0, 0); inner.quaternion.identity(); }
      placed = true;
      pose(); draw();
    },
  };
}

// how hands work the dough: friction 1 = dough pressed against a hand goes with it (no slip); tack 0 =
// it doesn't stick to the hand; mould 0 = it springs back (elastic)
export const HAND = { tack: 0, friction: 1, mould: 0 };
const REMOTE_TIMEOUT = 0.5; // s without news before the other headset's hand counts as gone

// scene: where the drawn hands go (they are posed in world coordinates)
// remoteSets: how many other people's hands arrive (1 on a headset; 2 on the film camera, ?mp=watch,
// which draws both players: set 0 in slots 2, 3 and set 1 in slots 4, 5)
export function createHands(renderer, rig, scene, controllers = [], { remoteSets = 1 } = {}) {
  const dir = new THREE.Vector3();
  const skin = new THREE.MeshStandardMaterial({ color: 0xefdec5, roughness: 0.8, metalness: 0 });
  const otherSkin = new THREE.MeshStandardMaterial({ color: 0xefdec5, roughness: 0.8, metalness: 0 });
  const ballGeo = new THREE.SphereGeometry(1, 14, 10), tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
  const m4 = new THREE.Matrix4(), sc = new THREE.Vector3(), q0 = new THREE.Quaternion();

  // a hand slot: local slots 0, 1 (this headset), remote slots 2, 3 (the other headset)
  function slot(i, remote) {
    // a material of its own, so one wet hand can look wet (src/water.js)
    const material = (remote ? otherSkin : skin).clone();
    const balls = new THREE.InstancedMesh(ballGeo, material, 25), tubes = new THREE.InstancedMesh(tubeGeo, material, BONES.length);
    for (const m of [balls, tubes]) { m.frustumCulled = false; m.castShadow = true; m.visible = false; m.count = 0; scene.add(m); }
    balls.name = tubes.name = `${remote ? 'remote' : 'tracked'}-hand-${i}`;
    return {
      i, remote, material, source: null, tracked: false, fresh: true, handedness: '', seen: -Infinity,
      joints: new Map(), // name -> { center, r }: this frame's tracked joints
      // dough colliders, one per bone (kept, so the dough can follow each one's motion by id)
      bones: BONES.map((_, k) => ({ id: `hand${i}-${k}`, group: `hand${i}`, kind: 'cylinder', center: new THREE.Vector3(), quat: new THREE.Quaternion(), r: 0, h: 0, tack: HAND.tack, friction: HAND.friction, mould: HAND.mould, reset: true })),
      tools: [],   // this frame's dough colliders (bones whose two joints are tracked)
      spheres: [], // this frame's joints { name, center, r } for the mallet
      palm: new THREE.Vector3(), palmSpeed: 0, palmPrev: new THREE.Vector3(),
      balls, tubes,
    };
  }
  const local = [0, 1].map((i) => {
    const h = slot(i, false);
    const group = renderer.xr.getHand(i);
    rig.add(group); // three poses its joints; we read them in world space
    h.group = group;
    // logged (the dev server forwards them to .tmp/dev.log), to tell the headset dropping a hand from a
    // drawing problem
    group.addEventListener('connected', (e) => {
      h.source = e.data?.hand ? e.data : null;
      if (h.source) { h.handedness = h.source.handedness; console.info(`[hands] ${h.handedness} hand tracked`); }
    });
    group.addEventListener('disconnected', () => {
      if (h.source) console.info(`[hands] ${h.handedness} hand lost by the headset`);
      h.source = null;
    });
    return h;
  });
  const remote = Array.from({ length: 2 * remoteSets }, (_, k) => slot(2 + k, true));
  const all = [...local, ...remote];
  // each controller shows a hand (createControllerHand), drawn like the tracked hands
  const controllerHands = controllers.map((controller) => {
    const hand = createControllerHand({ material: skin.clone() }); controller.grip.add(hand.object3d);
    return { controller, hand, held: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), radius: 0 } };
  });
  const inv = new THREE.Matrix4(), probeList = [];
  // solid things hands can't go into (src/handContact.js; setContact)
  let contact = null;
  const contactPts = [], contactRad = [], shift = new THREE.Vector3();

  // build a slot's colliders and drawing from its joints (h.joints)
  function build(h, dt) {
    h.tools.length = 0;
    h.spheres.length = 0;
    for (const [name, j] of h.joints) {
      j.sphere ??= { name, center: j.center, r: 0 };
      j.sphere.r = j.r;
      h.spheres.push(j.sphere);
    }
    for (let k = 0; k < BONES.length; k++) {
      const [a, b] = BONES[k], ja = h.joints.get(a), jb = h.joints.get(b);
      if (!ja || !jb) continue;
      dir.subVectors(jb.center, ja.center);
      const len = dir.length();
      if (len < 1e-6) continue;
      const t = h.bones[k];
      t.center.addVectors(ja.center, jb.center).multiplyScalar(0.5);
      t.quat.setFromUnitVectors(UP, dir.multiplyScalar(1 / len));
      t.h = len / 2;
      t.r = (ja.r + jb.r) / 2;
      t.reset = h.fresh;
      h.tools.push(t);
    }
    // the palm (between the middle finger's metacarpal and knuckle), for slaps on the dough
    const m0 = h.joints.get('middle-finger-metacarpal'), m1 = h.joints.get('middle-finger-phalanx-proximal');
    if (m0 && m1) {
      h.palm.addVectors(m0.center, m1.center).multiplyScalar(0.5);
      h.palmSpeed = h.fresh ? 0 : h.palm.distanceTo(h.palmPrev) / Math.max(dt, 1e-3);
      h.palmPrev.copy(h.palm);
    }
    h.fresh = false;
    // draw it: the joints and bones just computed
    for (let k = 0; k < h.spheres.length; k++) { const s2 = h.spheres[k]; h.balls.setMatrixAt(k, m4.compose(s2.center, q0, sc.setScalar(s2.r * HAND_VISUAL_SCALE))); }
    h.balls.count = h.spheres.length;
    for (let k = 0; k < h.tools.length; k++) { const t = h.tools[k]; h.tubes.setMatrixAt(k, m4.compose(t.center, t.quat, sc.set(t.r * HAND_VISUAL_SCALE, 2 * t.h, t.r * HAND_VISUAL_SCALE))); }
    h.tubes.count = h.tools.length;
    h.balls.instanceMatrix.needsUpdate = h.tubes.instanceMatrix.needsUpdate = true;
    h.balls.visible = h.tubes.visible = true;
  }
  function lose(h) {
    h.tracked = false; h.fresh = true; h.tools.length = 0; h.spheres.length = 0;
    h.balls.visible = h.tubes.visible = false;
  }
  let clock = 0;

  return {
    hands: all,
    exact: false, // the other people's hands placed exactly as given, not eased (src/film/ playback)
    // all tracked joints as spheres, and all bones as dough colliders (this headset's and the other's)
    spheres: [],
    tools: [],
    // this headset's own hands (the other headset's don't move you to the kneading spot)
    get any() { return local.some((h) => h.tracked); },
    get remoteAny() { return remote.some((h) => h.tracked); },
    // the solid things (createHandContact) this headset's hands, and the other person's controller hands, stop at
    setContact(c) { contact = c; },
    get contact() { return contact; },
    // every hand that can be seen, for the bucket's water (src/water.js): its points in world space, whether it
    // is this headset's own (its dips are counted here; the other person's on their own headset), its material
    probes() {
      probeList.length = 0;
      for (const h of all) if (h.tracked) probeList.push({ key: `hand${h.i}`, local: !h.remote, points: h.spheres.map((sp) => sp.center), material: h.material });
      controllerHands.forEach(({ hand }, k) => {
        if (hand.object3d.visible) probeList.push({ key: `controller${k}`, local: true, points: hand.worldPoints(), material: hand.material });
      });
      return probeList;
    },
    // after the rig jumps (teleport), the next frame's motion is not a hand movement
    jumped() { for (const h of local) h.fresh = true; },
    update(dt) {
      clock += dt;
      this.spheres.length = 0;
      this.tools.length = 0;
      for (const h of local) {
        const g = h.group, joints = g.joints ?? {};
        h.tracked = !!h.source && g.visible && !!joints.wrist?.visible;
        if (!h.tracked) { lose(h); continue; }
        g.updateWorldMatrix(true, true);
        for (const k of [...h.joints.keys()]) if (!joints[k]?.visible) h.joints.delete(k);
        for (const name in joints) {
          const j = joints[name];
          if (!j.visible) continue;
          let e = h.joints.get(name);
          if (!e) { e = { center: new THREE.Vector3(), r: 0 }; h.joints.set(name, e); }
          e.center.setFromMatrixPosition(j.matrixWorld); e.r = j.jointRadius ?? 0;
        }
        // out of anything solid (src/handContact.js), before its colliders are built: the dough and the mallet
        // feel the hand where it is drawn
        if (contact) {
          contactPts.length = 0; contactRad.length = 0;
          for (const e of h.joints.values()) { contactPts.push(e.center); contactRad.push(e.r * HAND_VISUAL_SCALE); }
          h.touching = contact.resolve(contactPts, contactRad, shift) > 0;
          if (h.touching) for (const e of h.joints.values()) e.center.add(shift);
        }
        build(h, dt);
      }
      // the other headset's hands arrive ~45 times a second, unevenly: each joint eases toward its latest
      // position every frame, so the hand glides (and pushes the dough smoothly) instead of stepping
      const ease = this.exact ? 1 : 1 - Math.exp(-dt * 25); // exact: a film playback, already on time
      for (const h of remote) {
        if (clock - h.seen > REMOTE_TIMEOUT) { if (h.tracked) lose(h); continue; }
        h.tracked = true;
        for (const e of h.joints.values()) e.center.lerp(e.target, ease);
        build(h, dt);
      }
      for (const h of all) if (h.tracked) { for (const s of h.spheres) this.spheres.push(s); for (const t of h.tools) this.tools.push(t); }
      for (const { controller: c, hand, held } of controllerHands) {
        const show = renderer.xr.isPresenting && !!c.source && !c.source.hand
          && !local.some((h) => h.tracked && h.handedness === c.handedness);
        hand.object3d.visible = show;
        if (!show) continue;
        // the mallet, if the station hung it on this grip: the hand wraps its handle
        const tool = c.grip.children.find((o) => o !== hand.object3d && o.getObjectByName('kine-head'));
        c.grip.updateWorldMatrix(true, false);
        hand.update(dt, c.source.gamepad, c.handedness, tool ? handleFrame(tool, inv.copy(c.grip.matrixWorld).invert(), held) : null);
        if (contact) {
          const depth = contact.resolve(hand.worldPoints(), hand.radii(), shift);
          if (depth > 0) hand.nudge(shift);
          // touching something gives the controller a light tap as the touch begins
          if (depth > 0.002 && !hand.touching) { try { c.source?.gamepad?.hapticActuators?.[0]?.pulse?.(0.25, 25)?.catch?.(() => {}); } catch { /* no haptics */ } }
          hand.touching = depth > 0.002;
        }
      }
    },
    // this headset's hands for sending: per hand, the joints as x, y, z, radius in JOINTS order (NaN = not
    // tracked), or null
    encode() {
      return local.map((h) => {
        if (!h.tracked) return null;
        const a = new Float32Array(JOINTS.length * 4).fill(NaN);
        JOINTS.forEach((name, k) => { const j = h.joints.get(name); if (j) { a[k * 4] = j.center.x; a[k * 4 + 1] = j.center.y; a[k * 4 + 2] = j.center.z; a[k * 4 + 3] = j.r; } });
        return a;
      });
    },
    // the other headset's hands, as encode() made them
    setRemote(arrays, set = 0) {
      for (let s = 0; s < 2; s++) {
        const h = remote[2 * set + s], a = arrays?.[s];
        if (!h) return;
        if (!a) { if (h.tracked) lose(h); h.seen = -Infinity; continue; }
        const back = clock - h.seen > REMOTE_TIMEOUT; // (re)appearing: placed, not glided in
        if (back) h.fresh = true;
        for (const k of [...h.joints.keys()]) h.joints.delete(k);
        JOINTS.forEach((name, k) => {
          if (Number.isNaN(a[k * 4])) return;
          let e = h.jointPool?.get(name);
          if (!e) { e = { center: new THREE.Vector3(), target: new THREE.Vector3(), r: 0, placed: false }; (h.jointPool ??= new Map()).set(name, e); }
          e.target.set(a[k * 4], a[k * 4 + 1], a[k * 4 + 2]); e.r = a[k * 4 + 3];
          if (back || !e.placed) { e.center.copy(e.target); e.placed = true; }
          h.joints.set(name, e);
        });
        h.seen = clock;
      }
    },
  };
}
