import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createPlayer } from '../src/player.js';

test('room scale aligns once, preserves physical motion and ignores stick input', () => {
  const originalDocument = globalThis.document, originalListener = globalThis.addEventListener;
  globalThis.addEventListener = () => {};
  globalThis.document = { addEventListener() {} };
  try {
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
    const rays = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
    let pose = null;
    const renderer = { xr: {
      isPresenting: true, getController: (i) => rays[i], getControllerGrip: (i) => grips[i],
      getFrame: () => ({ getViewerPose: () => pose }), getReferenceSpace: () => ({}),
    } };
    const player = createPlayer({
      scene, camera, renderer, dom: { addEventListener() {} },
      getColliders: () => ({ circles: [], boxes: [] }),
    });
    player.enable();
    player.setRoomScale(true);
    rays[0].dispatchEvent({ type: 'connected', data: { handedness: 'left', gamepad: { axes: [0, 0, 0, -1] } } });
    player.beginRoomScale([0, 0, 1.12], [0, 0, 0]);
    const initialRig = player.rig.position.clone();
    player.updateXRPlacement();
    assert.ok(player.rig.position.equals(initialRig), 'wait for valid headset tracking before positioning');

    pose = { transform: { position: new THREE.Vector3(0.3, 1.7, -0.2), orientation: new THREE.Quaternion() } };
    player.updateXRPlacement();
    const head = camera.getWorldPosition(new THREE.Vector3());
    assert.ok(Math.abs(head.x) < 1e-9 && Math.abs(head.z - 1.12) < 1e-9);
    assert.equal(head.y, 1.7, 'use tracked floor height, including the player’s real height');
    assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-9,
      'face the mortar from the new position, rather than the old world spawn');
    const placedRig = player.rig.position.clone(), placedRotation = player.rig.quaternion.clone();

    camera.position.add(new THREE.Vector3(0.8, -0.4, 0.25)); // walk and crouch in the real play area
    player.updateXRPlacement(); player.update(0.1);
    const moved = camera.getWorldPosition(new THREE.Vector3());
    assert.ok(Math.abs(moved.distanceTo(head) - Math.hypot(0.8, 0.4, 0.25)) < 1e-9);
    assert.ok(Math.abs(moved.y - 1.3) < 1e-9);
    assert.ok(player.rig.position.equals(placedRig), 'physical movement and stick deflection do not move the world');
    assert.ok(player.rig.quaternion.equals(placedRotation));

    player.setRoomScale(false); player.update(0.1);
    assert.ok(!player.rig.position.equals(placedRig), 'thumbstick locomotion remains available as an option');

    player.setRoomScale(true); player.beginRoomScale([-0.6, 0, -0.06], [0, 0, 0]); player.updateXRPlacement();
    const guestHead = camera.getWorldPosition(new THREE.Vector3());
    const toMortar = new THREE.Vector3(-guestHead.x, 0, -guestHead.z).normalize();
    assert.ok(camera.getWorldDirection(new THREE.Vector3()).distanceTo(toMortar) < 1e-9,
      'the joining player faces the mortar from the kneading side');
  } finally {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalListener === undefined) delete globalThis.addEventListener; else globalThis.addEventListener = originalListener;
  }
});
