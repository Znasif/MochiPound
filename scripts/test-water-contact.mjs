// Headless checks for the water bucket (src/water.js) and hands against solid things (src/handContact.js).
//   node --test scripts/test-water-contact.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createBucketWater } from '../src/water.js';
import { createHandContact } from '../src/handContact.js';
import { createControllerHand } from '../src/hands.js';
import { makeUsu, usuShape } from '../src/props.js';
import * as L from '../src/layout.js';
import { CONDITIONING, createConditioning } from '../src/dough/conditioning.js';

const v = (x, y, z) => new THREE.Vector3(x, y, z);

test('a dip is a hand clearly under the water, once, however it jitters at the surface', () => {
  const parent = new THREE.Group(), surface = new THREE.Mesh(new THREE.CircleGeometry(0.2, 8), new THREE.MeshStandardMaterial());
  const centre = v(0, 0.5, 0), water = createBucketWater({ parent, centre, radius: 0.2, bottom: 0.3, surface, random: () => 0.5 });
  assert.ok(surface.material.transparent, 'the surface is see-through');
  const material = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  const hand = (y, x = 0) => [{ key: 'hand0', local: true, material, points: [v(x, y, 0), v(x + 0.02, y + 0.03, 0)] }];
  const run = (y, s = 0.1, x) => { let dips = []; for (let t = 0; t < s; t += 1 / 60) dips = dips.concat(water.update(1 / 60, hand(y, x))); return dips; };
  assert.equal(run(0.6).length, 0, 'above the water');
  const first = run(0.47);
  assert.equal(first.length, 1, 'into the water: one dip');
  assert.equal(first[0].local, true); assert.ok(Math.abs(first[0].at.y - 0.5) < 1e-9, 'at the surface');
  let jitter = 0;
  for (let i = 0; i < 120; i++) jitter += water.update(1 / 60, hand(0.5 + 0.006 * Math.sin(i))).length;
  assert.equal(jitter, 0, 'a hand hovering at the surface (tracking jitter) never dips again');
  run(0.6, 0.2); assert.equal(run(0.47).length, 0, 'out and back in within 0.5 s: still the same dip');
  run(0.6, 0.6); assert.equal(run(0.47).length, 1, 'out for longer: a new dip');
  run(0.6, 0.7);
  assert.ok(material.roughness < 0.5, `a hand just out of the water looks wet (roughness ${material.roughness.toFixed(2)})`);
  run(0.6, 7);
  assert.ok(Math.abs(material.roughness - 0.8) < 1e-6, 'and dry again a few seconds later');
  assert.equal(run(0.1, 0.5).length, 0, 'under the bucket is not in the water');
  assert.equal(run(0.47, 0.2, 0.5).length, 0, 'beside the bucket neither');
  const other = createBucketWater({ parent, centre, radius: 0.2, bottom: 0.3 });
  const theirs = [{ key: 'hand2', local: false, points: [v(0, 0.6, 0)] }];
  other.update(1 / 60, theirs); theirs[0].points[0].y = 0.47;
  assert.equal(other.update(1 / 60, theirs)[0].local, false, 'the other person\'s dip is marked as theirs (their headset counts it)');
});

test('each dip adds 10% moisture, and moisture only colours the dough', () => {
  const s = createConditioning(), before = s.snapshot();
  s.water();
  assert.ok(Math.abs(s.snapshot().moisture - before.moisture - CONDITIONING.waterPerDip) < 1e-9);
  assert.equal(CONDITIONING.waterPerDip, 0.1);
  assert.equal(s.youngsModulus, createConditioning().youngsModulus, 'water leaves the stiffness alone');
  s.fill(); assert.equal(s.ready, true, 'the demo fill finishes a batch');
});

const plain = new THREE.MeshBasicMaterial();
const usu = usuShape(makeUsu({ radius: L.USU.radius, height: L.USU.height }, { side: plain, top: plain, band: plain, mat: plain }));
const contact = createHandContact({ usu, oke: L.OKE, groundY: 0 });

test('hands stop at the mortar, the ground and the bucket, as one piece', () => {
  const out = v(0, 0, 0);
  const bowlFloor = usu.poly[usu.poly.length - 1][1];
  // a fingertip 2 cm into the bowl's floor, the rest of the hand above it
  const hand = [v(0.02, bowlFloor - 0.02, 0), v(0.02, bowlFloor + 0.05, 0.03), v(0.04, bowlFloor + 0.09, 0.02)];
  const depth = contact.resolve(hand, 0.01, out);
  assert.ok(depth > 0.02 && out.y > 0.02, `lifted out of the wood (${(out.y * 100).toFixed(1)} cm)`);
  for (const p of hand) assert.ok(contact.sdf(p.x + out.x, p.y + out.y, p.z + out.z) >= 0.01 - 1e-6, 'every joint clear of the wood');
  // into the outside of the mortar's wall
  const side = [v(L.USU.radius - 0.03, 0.35, 0)];
  contact.resolve(side, 0.01, out);
  assert.ok(contact.sdf(side[0].x + out.x, side[0].y + out.y, side[0].z + out.z) >= 0.01 - 1e-6 && out.x > 0, 'pushed out of the side');
  // into the ground
  contact.resolve([v(2, -0.03, 2)], 0.01, out);
  assert.ok(Math.abs(out.y - 0.04) < 0.002, `up out of the ground (${out.y.toFixed(3)})`);
  // the bucket: its wall and stand are solid, its water isn't
  const [ox, , oz] = L.OKE.position, top = L.OKE.stand + L.OKE.height;
  contact.resolve([v(ox, top - 0.08, oz)], 0.01, out);
  assert.equal(out.length(), 0, 'a hand in the water is free');
  contact.resolve([v(ox + L.OKE.radius * 0.97, top - 0.05, oz)], 0.01, out);
  assert.ok(out.length() > 0.005, 'the tub wall is solid');
  contact.resolve([v(ox + 0.05, L.OKE.stand - 0.05, oz)], 0.01, out);
  assert.ok(out.length() > 0.04, 'the stand is solid');
  // nothing touched: no shift
  assert.equal(contact.resolve([v(3, 1, 3)], 0.01, out), 0); assert.equal(out.length(), 0);
  // a hand deep in the wood (a real hand where there is no real mortar) is never left half sunk: cleared, or let through
  for (const deep of [v(0.1, 0.2, 0.1), v(0.3, 0.35, 0), v(0, 0.5, 0.05)]) {
    contact.resolve([deep], 0.01, out);
    const after = contact.sdf(deep.x + out.x, deep.y + out.y, deep.z + out.z);
    assert.ok(out.length() === 0 || after >= 0.01 - 0.002, `deep at ${deep.toArray()}: cleared (${after.toFixed(3)}) or let through`);
  }
});

test('a controller\'s hand is nudged out of the wood where it is drawn', () => {
  const grip = new THREE.Group(); grip.position.set(L.USU.radius - 0.02, L.USU.height - 0.01, 0); grip.rotation.set(0.4, 0.9, 0); grip.updateMatrixWorld(true);
  const hand = createControllerHand(); grip.add(hand.object3d);
  hand.update(1 / 60, [0, 0, 1], 'right');
  const before = hand.worldPoints().map((p) => p.clone());
  const out = v(0, 0, 0), depth = contact.resolve(hand.worldPoints(), hand.radii(), out);
  assert.ok(depth > 0, 'held at the rim, part of it is in the wood');
  hand.nudge(out);
  const after = hand.worldPoints();
  after.forEach((p, k) => assert.ok(p.distanceTo(before[k].clone().add(out)) < 1e-9, 'moved as one piece by the shift'));
  after.forEach((p, k) => assert.ok(contact.sdf(p.x, p.y, p.z) >= hand.radii()[k] - 1e-4, 'and clear of the wood'));
});
