// Headless checks for the hands drawn on controllers (src/hands.js createControllerHand): the same joints and
// bones as a tracked hand, wrapped round the controller's handle, or round a held mallet's own handle, without
// sinking into it; mirrored for the left hand; fingers following the trigger; never a collider.
//   node --test scripts/test-controller-hands.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createHands, createControllerHand, handleFrame, JOINTS } from '../src/hands.js';
import { HAND_VISUAL_SCALE } from '../src/pawVisual.js';
import { MALLETS, makeSongMallet } from '../src/moonGarden/story/mallets.js';

const FINGER_JOINTS = JOINTS.filter((n) => !n.startsWith('thumb') && !n.endsWith('metacarpal') && n !== 'wrist');
const point = (hand, name) => hand.object3d.children[0].localToWorld(hand.joints.get(name).p.clone()); // grip space (grip at the origin)
// distance from p to the line through a along unit d
const toAxis = (p, a, d) => { const v = p.clone().sub(a); return v.sub(d.clone().multiplyScalar(v.dot(d))).length(); };

test('on the controller: the fingers wrap the handle (-Z toward the thumb), not into it', () => {
  const hand = createControllerHand();
  hand.update(1 / 60, [0, 0, 1], 'right'); hand.object3d.updateMatrixWorld(true);
  assert.equal(hand.joints.size, JOINTS.length, 'every tracked-hand joint is drawn');
  const axis = new THREE.Vector3(0, 0, 1), origin = new THREE.Vector3();
  for (const name of FINGER_JOINTS) {
    if (name.startsWith('index')) continue; // the index finger rests on the trigger, half curled
    const j = hand.joints.get(name), d = toAxis(point(hand, name), origin, axis);
    assert.ok(d >= 0.0195 + j.r * HAND_VISUAL_SCALE - 0.002, `${name} clears a 2 cm handle (${(d * 100).toFixed(1)} cm from its axis)`);
    assert.ok(d <= 0.05, `${name} is wrapped round it (${(d * 100).toFixed(1)} cm)`);
  }
  const wrist = point(hand, 'wrist'), knuckle = point(hand, 'middle-finger-phalanx-proximal');
  assert.ok(wrist.y > knuckle.y + 0.05, 'the wrist is toward the arm (+Y)');
  assert.ok(knuckle.x > 0, 'the back of the right hand faces +X');
  assert.ok(point(hand, 'thumb-tip').z < point(hand, 'pinky-finger-tip').z, 'the thumb is at the -Z end');
  const left = createControllerHand();
  left.update(1 / 60, [0, 0, 1], 'left'); left.object3d.updateMatrixWorld(true);
  for (const name of JOINTS) {
    const r = point(hand, name), l = point(left, name);
    assert.ok(Math.abs(l.x + r.x) < 1e-9 && Math.abs(l.y - r.y) < 1e-9 && Math.abs(l.z - r.z) < 1e-9, `${name} is mirrored for the left hand`);
  }
});

test('the trigger curls the index finger', () => {
  const hand = createControllerHand();
  hand.update(1 / 60, [0, 0, 1], 'right');
  const open = toAxis(point(hand, 'index-finger-tip'), new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
  for (let i = 0; i < 60; i++) hand.update(1 / 60, [1, 0, 1], 'right');
  const pulled = toAxis(point(hand, 'index-finger-tip'), new THREE.Vector3(), new THREE.Vector3(0, 0, 1));
  assert.ok(pulled < open - 0.01, `index tip ${(open * 100).toFixed(1)} -> ${(pulled * 100).toFixed(1)} cm from the handle`);
});

test('holding a mallet: the hand wraps that mallet\'s own handle, thumb toward its head', () => {
  const mats = () => ({ wood: new THREE.MeshStandardMaterial(), band: new THREE.MeshStandardMaterial() });
  for (const { id } of MALLETS) {
    const { object3d: tool, options } = makeSongMallet(id, mats());
    const grip = new THREE.Group(); grip.add(tool);
    // where the station hangs it on the grip (station.js setKine: these defaults when the asset has none)
    tool.position.copy(options.grip?.position ?? new THREE.Vector3(0, -0.02, 0.06));
    tool.rotation.copy(options.grip?.rotation ?? new THREE.Euler(-0.35, 0, 0));
    grip.updateMatrixWorld(true);
    const frame = handleFrame(tool, grip.matrixWorld.clone().invert());
    assert.ok(frame, `${id}: has a handle to hold`);
    const hand = createControllerHand(); grip.add(hand.object3d);
    for (let i = 0; i < 30; i++) hand.update(1 / 60, [0, 0, 0], 'right', frame);
    hand.object3d.updateMatrixWorld(true);
    const handle = tool.getObjectByName('grip-wrap') ?? tool.getObjectByName('kine-handle');
    const a = new THREE.Vector3().setFromMatrixPosition(handle.matrixWorld);
    const d = new THREE.Vector3(0, 1, 0).applyQuaternion(handle.getWorldQuaternion(new THREE.Quaternion())).normalize();
    for (const name of FINGER_JOINTS) {
      const j = hand.joints.get(name), dist = toAxis(point(hand, name), a, d);
      assert.ok(dist >= frame.radius + j.r * HAND_VISUAL_SCALE - 0.002, `${id}: ${name} clears the handle (${(dist * 100).toFixed(1)} cm, handle r ${(frame.radius * 100).toFixed(1)})`);
      assert.ok(dist <= frame.radius + 0.03, `${id}: ${name} holds it (${(dist * 100).toFixed(1)} cm)`);
    }
    const head = new THREE.Vector3().setFromMatrixPosition(tool.getObjectByName('kine-head').matrixWorld);
    const centre = hand.object3d.children[0].getWorldPosition(new THREE.Vector3());
    const thumbDir = new THREE.Vector3(0, 0, -1).applyQuaternion(hand.object3d.children[0].getWorldQuaternion(new THREE.Quaternion()));
    assert.ok(thumbDir.dot(head.clone().sub(centre)) > 0, `${id}: the thumb points toward the head`);
    assert.ok(centre.length() < 0.08, `${id}: the hand stays near the controller (${(centre.length() * 100).toFixed(1)} cm off)`);
  }
});

test('the hands on controllers replace the controller models and are never colliders', () => {
  const grip = new THREE.Group(), ray = new THREE.Group();
  const controller = { grip, ray, handedness: 'right', source: { handedness: 'right', hand: null, gamepad: { buttons: [{ value: 0 }, { value: 0 }] } } };
  const renderer = { xr: { getHand: () => new THREE.Group(), isPresenting: true } };
  const hands = createHands(renderer, new THREE.Group(), new THREE.Scene(), [controller]);
  hands.update(1 / 60);
  const drawn = grip.children.find((o) => o.name === 'controller-hand');
  assert.ok(drawn?.visible, 'a hand is shown on the controller');
  assert.equal(grip.children.length, 1, 'and nothing else (no controller model)');
  assert.equal(hands.tools.length + hands.spheres.length, 0, 'it is no collider for the dough or the mallet');
  renderer.xr.isPresenting = false; hands.update(1 / 60);
  assert.equal(drawn.visible, false, 'hidden outside VR');
});
