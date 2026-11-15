// Checks src/kineContact.js without a browser, on the real meshes (src/props.js): the mallet posed into the
// bowl floor, the bowl wall, the ground, a hand, across the rim, and swung fast into the wall must end with
// no overlap and, where it is pushed against something, no gap either.
// The checks are independent of the collision's own search: they sample the mallet's true surfaces densely
// and every vertex of the mortar's meshes, and evaluate the exact distances.
import * as THREE from 'three';
import { createKineContact } from '../src/kineContact.js';
import { makeUsu, makeKine } from '../src/props.js';

const LEN = 0.85;
const plain = new THREE.MeshBasicMaterial();
const scene = new THREE.Scene();
const usu = makeUsu({ radius: 0.42, height: 0.7 }, { side: plain, top: plain, band: plain, mat: plain });
scene.add(usu);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), plain);
ground.name = 'ground'; ground.rotation.x = -Math.PI / 2;
scene.add(ground);
scene.updateMatrixWorld(true);

let ok = true;
function check(name, cond, detail) { ok &&= cond; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(28)} ${detail}`); }

// a kine whose head centre is at `head` and whose handle points from the head toward `hands`
function pose(kine, hands, head) {
  kine.position.copy(hands);
  const back = new THREE.Vector3().subVectors(hands, head).normalize(); // local +Z
  kine.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), back.clone().negate(), new THREE.Vector3(0, 1, 0)));
  kine.updateMatrixWorld(true);
}
function newKine() {
  const k = makeKine(LEN, { wood: plain, band: plain });
  scene.add(k);
  return { k, c: createKineContact({ kine: k, usu, ground }) };
}

// dense samples of the mallet's true surfaces (world), from its meshes' geometry parameters
function malletSamples(kine) {
  kine.updateMatrixWorld(true);
  const out = [], v = new THREE.Vector3();
  for (const o of kine.children) {
    const g = o.geometry, P = g.parameters;
    if (g.type === 'CylinderGeometry') {
      const h = P.height / 2;
      for (let i = 0; i < 256; i++) {
        const th = (i / 256) * 2 * Math.PI;
        for (let j = 0, nj = Math.ceil(P.height / 0.002); j <= nj; j++) { const t = j / nj, r = P.radiusBottom + (P.radiusTop - P.radiusBottom) * t; out.push(v.set(r * Math.cos(th), -h + 2 * h * t, r * Math.sin(th)).applyMatrix4(o.matrixWorld).clone()); }
        for (let j = 0; j <= 16; j++) for (const [y, rr] of [[h, P.radiusTop], [-h, P.radiusBottom]]) { const r = (rr * j) / 16; out.push(v.set(r * Math.cos(th), y, r * Math.sin(th)).applyMatrix4(o.matrixWorld).clone()); }
      }
    } else if (g.type === 'TorusGeometry') {
      for (let i = 0; i < 256; i++) for (let j = 0; j < 32; j++) {
        const u = (i / 256) * 2 * Math.PI, w = (j / 32) * 2 * Math.PI, rr = P.radius + P.tube * Math.cos(w);
        out.push(v.set(rr * Math.cos(u), rr * Math.sin(u), P.tube * Math.sin(w)).applyMatrix4(o.matrixWorld).clone());
      }
    }
  }
  return out;
}
// every vertex of the mortar's meshes (they lie exactly on its surfaces)
const usuVerts = [];
usu.traverse((o) => {
  if (!o.isMesh || o.geometry.type === 'CircleGeometry') return;
  const a = o.geometry.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < a.count; i++) usuVerts.push(v.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld).clone());
});
// overlap (> 0 = interpenetrating, m) and the smallest gap between the mallet and the scene
function measure(kine, contact, hands = []) {
  let overlap = -Infinity, gap = Infinity;
  for (const p of malletSamples(kine)) {
    const d = contact.sceneSdf(p);
    overlap = Math.max(overlap, -d); gap = Math.min(gap, d);
    for (const h of hands) { const c = new THREE.Vector3().setFromMatrixPosition(h.matrixWorld), r = h.geometry.parameters.radius * h.scale.x, dh = p.distanceTo(c) - r; overlap = Math.max(overlap, -dh); gap = Math.min(gap, dh); }
  }
  for (const v of usuVerts) { const d = contact.malletSdf(v); overlap = Math.max(overlap, -d); gap = Math.min(gap, d); }
  return { overlap, gap };
}
const mm = (x) => `${(x * 1000).toFixed(3)} mm`;
const head = (k) => k.localToWorld(new THREE.Vector3(0, 0, -LEN));

{ // head driven 15 cm below the bowl floor, hands high enough that the handle clears the rim
  const { k, c } = newKine();
  pose(k, new THREE.Vector3(0, 0.95, 0.85), new THREE.Vector3(0, 0.55, 0)); c.resolve(k, [], 1 / 60);
  const m = measure(k, c);
  check('head into the bowl floor', m.overlap <= 1e-5 && m.gap <= 5e-4, `overlap ${mm(Math.max(0, m.overlap))}, resting gap ${mm(m.gap)}`);
}
{ // head pushed sideways into the bowl wall from inside
  const { k, c } = newKine();
  pose(k, new THREE.Vector3(1.0, 0.9, 0), new THREE.Vector3(0.3, 0.7, 0)); c.resolve(k, [], 1 / 60);
  const m = measure(k, c);
  check('head into the bowl wall', m.overlap <= 1e-5 && m.gap <= 5e-4, `overlap ${mm(Math.max(0, m.overlap))}, resting gap ${mm(m.gap)}`);
}
{ // head swung down into the ground beside the mortar
  const { k, c } = newKine();
  pose(k, new THREE.Vector3(1.0, 0.5, 1.0), new THREE.Vector3(1.0, -0.05, 0.15)); c.resolve(k, [], 1 / 60);
  const m = measure(k, c);
  check('head into the ground', m.overlap <= 1e-5 && m.gap <= 5e-4, `overlap ${mm(Math.max(0, m.overlap))}, resting gap ${mm(m.gap)}`);
}
{ // head brought down onto a hand resting on the dough (a sphere mesh like people.js's hands)
  const { k, c } = newKine();
  const hand = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), plain);
  hand.scale.setScalar(0.045); hand.position.set(0, 0.66, 0); scene.add(hand); hand.updateMatrixWorld(true);
  pose(k, new THREE.Vector3(0, 0.95, 0.85), new THREE.Vector3(0, 0.78, 0)); c.resolve(k, [hand], 1 / 60);
  pose(k, new THREE.Vector3(0, 0.9, 0.85), new THREE.Vector3(0, 0.7, 0)); c.resolve(k, [hand], 1 / 60);
  const m = measure(k, c, [hand]);
  check('head onto a hand', m.overlap <= 1e-5 && m.gap <= 5e-4, `overlap ${mm(Math.max(0, m.overlap))}, resting gap ${mm(m.gap)}`);
  scene.remove(hand);
}
{ // hands below the rim: the handle has to lie across the rim (the kine pivots up on it)
  const { k, c } = newKine();
  pose(k, new THREE.Vector3(0, 0.66, 0.85), new THREE.Vector3(0, 0.62, 0)); c.resolve(k, [], 1 / 60);
  const m = measure(k, c);
  check('handle across the rim', m.overlap <= 1e-5 && m.gap <= 5e-4, `overlap ${mm(Math.max(0, m.overlap))}, resting gap ${mm(m.gap)}`);
}
{ // a fast swing (~10 m/s over 4 frames) sideways into the mortar's body, well below the rim
  const { k, c } = newKine();
  for (let f = 0; f <= 4; f++) { const x = 1.6 - 0.7 * (f / 4); pose(k, new THREE.Vector3(x, 0.45, 0), new THREE.Vector3(x - 0.85, 0.4, 0)); c.resolve(k, [], 1 / 60); }
  const m = measure(k, c), h = head(k);
  check('fast swing into the wall', m.overlap <= 1e-5 && h.x > 0.3, `overlap ${mm(Math.max(0, m.overlap))}, head stopped outside at x=${h.x.toFixed(4)} m, gap ${mm(m.gap)}`);
}
{ // the same swing with the head's top above the rim may ride up over it into the bowl
  const { k, c } = newKine();
  for (let f = 0; f <= 4; f++) { const x = 1.45 - 0.6 * (f / 4); pose(k, new THREE.Vector3(x, 0.9, 0), new THREE.Vector3(x - 0.85, 0.8, 0)); c.resolve(k, [], 1 / 60); }
  const m = measure(k, c);
  check('swing over the rim', m.overlap <= 1e-5, `overlap ${mm(Math.max(0, m.overlap))}, head at x=${head(k).x.toFixed(4)} m`);
}
{ // cost of one frame with the head pressed into the bowl (what a strike costs per frame)
  const { k, c } = newKine();
  pose(k, new THREE.Vector3(0, 0.95, 0.85), new THREE.Vector3(0, 0.6, 0)); c.resolve(k, [], 1 / 60);
  const t0 = performance.now(); c.stats.sceneSdf = 0; c.stats.malletSdf = 0;
  for (let i = 0; i < 20; i++) { pose(k, new THREE.Vector3(0, 0.95 - 0.002 * (i % 2), 0.85), new THREE.Vector3(0, 0.6 - 0.002 * (i % 2), 0)); c.resolve(k, [], 1 / 60); }
  console.log(`time per frame in contact: ${((performance.now() - t0) / 20).toFixed(2)} ms (one juno2 core); per frame ${Math.round(c.stats.sceneSdf / 20)} mortar and ${Math.round(c.stats.malletSdf / 20)} mallet distance evaluations`);
  // and a frame where the mallet is up in the air
  pose(k, new THREE.Vector3(0, 1.5, 0.85), new THREE.Vector3(0, 1.3, 0)); c.resolve(k, [], 1 / 60);
  const t1 = performance.now();
  for (let i = 0; i < 200; i++) { pose(k, new THREE.Vector3(0, 1.5 - 0.002 * (i % 2), 0.85), new THREE.Vector3(0, 1.3, 0)); c.resolve(k, [], 1 / 60); }
  console.log(`time per frame in the air: ${((performance.now() - t1) / 200).toFixed(3)} ms`);
}
console.log(ok ? 'all passed' : 'some FAILED');
process.exitCode = ok ? 0 : 1;
