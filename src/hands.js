import * as THREE from 'three';
import { HAND_VISUAL_SCALE, createControllerPaw } from './pawVisual.js';

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
// how hands work the dough: friction 1 = dough pressed against a hand goes with it (no slip); tack 0 =
// it doesn't stick to the hand; mould 0 = it springs back (elastic)
export const HAND = { tack: 0, friction: 1, mould: 0 };
const REMOTE_TIMEOUT = 0.5; // s without news before the other headset's hand counts as gone

// scene: where the drawn hands go (they are posed in world coordinates)
export function createHands(renderer, rig, scene, controllers = []) {
  const dir = new THREE.Vector3();
  const skin = new THREE.MeshStandardMaterial({ color: 0xefdec5, roughness: 0.8, metalness: 0 });
  const otherSkin = new THREE.MeshStandardMaterial({ color: 0xefdec5, roughness: 0.8, metalness: 0 });
  const ballGeo = new THREE.SphereGeometry(1, 14, 10), tubeGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
  const m4 = new THREE.Matrix4(), sc = new THREE.Vector3(), q0 = new THREE.Quaternion();

  // a hand slot: local slots 0, 1 (this headset), remote slots 2, 3 (the other headset)
  function slot(i, remote) {
    const balls = new THREE.InstancedMesh(ballGeo, remote ? otherSkin : skin, 25), tubes = new THREE.InstancedMesh(tubeGeo, remote ? otherSkin : skin, BONES.length);
    for (const m of [balls, tubes]) { m.frustumCulled = false; m.castShadow = true; m.visible = false; m.count = 0; scene.add(m); }
    balls.name = tubes.name = `${remote ? 'remote' : 'tracked'}-hand-${i}`;
    return {
      i, remote, source: null, tracked: false, fresh: true, handedness: '', seen: -Infinity,
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
  const remote = [2, 3].map((i) => slot(i, true));
  const all = [...local, ...remote];
  const controllerPaws = controllers.map((controller) => {
    const mesh = createControllerPaw('left'); controller.grip.add(mesh);
    return { controller, mesh };
  });

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
    // all tracked joints as spheres, and all bones as dough colliders (this headset's and the other's)
    spheres: [],
    tools: [],
    // this headset's own hands (the other headset's don't move you to the kneading spot)
    get any() { return local.some((h) => h.tracked); },
    get remoteAny() { return remote.some((h) => h.tracked); },
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
        build(h, dt);
      }
      // the other headset's hands arrive ~45 times a second, unevenly: each joint eases toward its latest
      // position every frame, so the hand glides (and pushes the dough smoothly) instead of stepping
      const ease = 1 - Math.exp(-dt * 25);
      for (const h of remote) {
        if (clock - h.seen > REMOTE_TIMEOUT) { if (h.tracked) lose(h); continue; }
        h.tracked = true;
        for (const e of h.joints.values()) e.center.lerp(e.target, ease);
        build(h, dt);
      }
      for (const h of all) if (h.tracked) { for (const s of h.spheres) this.spheres.push(s); for (const t of h.tools) this.tools.push(t); }
      for (const { controller: c, mesh } of controllerPaws) {
        mesh.visible = renderer.xr.isPresenting && !!c.source && !c.source.hand
          && !local.some((h) => h.tracked && h.handedness === c.handedness);
        mesh.scale.x = HAND_VISUAL_SCALE * (c.handedness === 'right' ? -1 : 1);
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
    setRemote(arrays) {
      for (let s = 0; s < 2; s++) {
        const h = remote[s], a = arrays?.[s];
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
