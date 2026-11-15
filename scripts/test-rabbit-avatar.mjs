// Parse the actual multiplayer assets and verify tracked head/limbs, crouching, timeout and fallback.
// No renderer, screenshots, server, network access or physics simulation.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createRabbitAvatar } from '../src/rabbitAvatar.js';
import { avatarInputs } from '../src/sync.js';
import { CONTROLLER_WRIST } from '../src/hands.js';
// a controller's pose is its grip, the middle of the drawn hand's fist: the forearm ends at that hand's wrist
const wristOf = (pose, side) => new THREE.Vector3(CONTROLLER_WRIST[0] * (side === 'left' ? -1 : 1), CONTROLLER_WRIST[1], CONTROLLER_WRIST[2])
  .applyQuaternion(new THREE.Quaternion().fromArray(pose, 3).normalize()).add(new THREE.Vector3().fromArray(pose));

const canonical = (s) => s.replace(/[_.\s]/g, '').toLowerCase();
function bone(model, name) {
  let found;
  model.traverse((o) => { if (o.isBone && canonical(o.name) === canonical(name)) found = o; });
  assert.ok(found, `missing bone ${name}`); return found;
}
const load = async (variant) => {
  const file = variant === 'red' ? 'Mochi_Player_Rabbit_Red.glb' : 'Mochi_Player_Rabbit.glb';
  const bytes = await readFile(new URL(`../public/env/characters/${file}`, import.meta.url));
  return (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
};
const point = (o) => o.getWorldPosition(new THREE.Vector3());
for (const variant of ['indigo', 'red']) {
  const scene = new THREE.Scene(), hands = { hands: [] };
  const avatar = createRabbitAvatar(scene, { variant, hands, load });
  const model = await avatar.ready;
  assert.ok(model, `${variant} GLB must load`);
  const head = bone(model, 'head'), upper = bone(model, 'UpperArm.L'), lower = bone(model, 'Forearm.L'), end = bone(model, 'Hand.L');
  const position = new THREE.Vector3(0.4, 1.62, 2);
  const orientation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.3, 0.5, 0, 'YXZ'));
  const pose = [...position.toArray(), ...orientation.toArray()];
  avatar.set(pose, 0); avatar.update(0, 1 / 60);
  assert.ok(avatar.object3d.visible);
  const eye = head.localToWorld(new THREE.Vector3(0, 0.16, 0.2));
  assert.ok(eye.distanceTo(position) < 1e-5, `${variant}: the bunny's eyes follow the headset`);
  const a = point(upper).distanceTo(point(lower)), b = point(lower).distanceTo(point(end));
  const shoulder = point(upper), target = shoulder.clone().add(new THREE.Vector3(-0.12, -0.25, -0.12));
  hands.hands.push({ remote: true, tracked: true, handedness: 'left', joints: new Map([['wrist', { center: target }]]) });
  avatar.update(1 / 60, 1 / 60);
  assert.ok(point(end).distanceTo(target) < 1e-4, `${variant}: wrist IK reaches the tracked hand`);
  assert.ok(Math.abs(point(upper).distanceTo(point(lower)) - a) < 1e-5);
  assert.ok(Math.abs(point(lower).distanceTo(point(end)) - b) < 1e-5);
  // Controllers also drive two independent arms, with separate wrist rotations.
  hands.hands.length = 0;
  const rightUpper = bone(model, 'UpperArm.R'), rightHand = bone(model, 'Hand.R');
  const leftTarget = point(upper).add(new THREE.Vector3(-0.1, -0.25, -0.1));
  const rightTarget = point(rightUpper).add(new THREE.Vector3(0.1, -0.25, -0.1));
  const inputs = {
    left: { kind: 'controller', pose: [...leftTarget.toArray(), 0, 0, 0, 1] },
    right: { kind: 'controller', pose: [...rightTarget.toArray(), 0, 0, 0, 1] },
  };
  avatar.set(pose, 0.02, null, inputs); avatar.update(0.02, 1 / 60);
  const leftBefore = point(end);
  assert.ok(point(rightHand).distanceTo(wristOf(inputs.right.pose, 'right')) < 1e-4, 'the right forearm ends at the controller hand\'s wrist');
  inputs.right.pose[1] += 0.08;
  const wristRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.5);
  inputs.right.pose.splice(3, 4, ...wristRotation.toArray());
  for (let i = 0; i < 40; i++) { avatar.set(pose, 0.03 + i / 60, null, inputs); avatar.update(0.03 + i / 60, 1 / 60); }
  assert.ok(point(end).distanceTo(leftBefore) < 1e-5, 'moving the right arm leaves the left arm fixed');
  assert.ok(point(rightHand).distanceTo(wristOf(inputs.right.pose, 'right')) < 1e-4, 'right hand independently reaches its new target, turned wrist included');

  // Looking around does not immediately rotate the torso. The eyes still track the full head pose.
  const torsoYaw = avatar.object3d.rotation.y;
  const turned = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.8, 0.15, 'YXZ'));
  const turnedPose = [...position.toArray(), ...turned.toArray()];
  avatar.set(turnedPose, 0.8); avatar.update(0.8, 1);
  assert.ok(Math.abs(avatar.object3d.rotation.y - torsoYaw) < 1e-5, 'neck turns independently of the torso');
  assert.ok(head.localToWorld(new THREE.Vector3(0, 0.16, 0.2)).distanceTo(position) < 1e-5);

  // Identical world travel arrives for room-scale walking and stick movement; both animate the feet.
  let highest = -Infinity, lowest = Infinity;
  const leftFoot = bone(model, 'Foot.L');
  for (let i = 1; i <= 120; i++) {
    const movingPose = pose.slice(); movingPose[2] -= i / 75;
    avatar.set(movingPose, 2 + i / 60); avatar.update(2 + i / 60, 1 / 60);
    const y = point(leftFoot).y; highest = Math.max(highest, y); lowest = Math.min(lowest, y);
  }
  assert.ok(avatar.walking && highest - lowest > 0.04, 'travel produces alternating lifted steps');
  const jumped = pose.slice(); jumped[0] += 10;
  avatar.set(jumped, 4.1); avatar.update(4.1, 1 / 60);
  assert.equal(avatar.walking, false, 'teleports reset the gait instead of playing a sprint');
  const scale = avatar.object3d.children[0].scale.x;
  const crouched = pose.slice(); crouched[1] = 1.1;
  avatar.set(crouched, 4.2); avatar.update(4.2, 1);
  assert.equal(avatar.object3d.children[0].scale.x, scale, 'crouching preserves body proportions');
  model.traverse((o) => { assert.ok(o.matrixWorld.elements.every(Number.isFinite), `${o.name} has a finite transform`); });
  avatar.update(7, 1 / 60); assert.equal(avatar.object3d.visible, false, 'stale avatars disappear');
  avatar.set([NaN, ...pose.slice(1)], 8); avatar.update(8, 1 / 60); assert.equal(avatar.object3d.visible, false);
  avatar.set(pose, 9); avatar.update(9, 1 / 60); assert.ok(avatar.object3d.visible);
}

const controller = (side, x) => {
  const grip = new THREE.Group(); grip.position.set(x, 1, 0); grip.updateMatrixWorld(true);
  return { handedness: side, source: {}, grip };
};
const encoded = avatarInputs([controller('left', 0.3), controller('right', -0.3)], { hands: [] });
assert.equal(encoded.left.pose[0], 0.3); assert.equal(encoded.right.pose[0], -0.3, 'crossing controllers preserves handedness');

const fallback = createRabbitAvatar(new THREE.Scene(), { load: async () => { throw new Error('missing GLB'); } });
assert.equal(await fallback.ready, null);
fallback.set([0, 1.6, 0, 0, 0, 0, 1], 0); fallback.update(0, 1 / 60);
assert.ok(fallback.object3d.visible && fallback.object3d.children[0].children[0].visible);
console.info('Rabbit avatar checks passed: both GLBs, independent head/arms/wrists, walking, crouch, teleport, reconnect and load failure.');
