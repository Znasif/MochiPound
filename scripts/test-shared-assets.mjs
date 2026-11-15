import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createHostSync, createGuestSync } from '../src/sync.js';
import { MALLETS, makeSongMallet } from '../src/moonGarden/story/mallets.js';

test('each stable mallet ID builds matching geometry and grip options on separate clients', () => {
  const materials = () => ({ wood: new THREE.MeshStandardMaterial(), band: new THREE.MeshStandardMaterial() });
  for (const { id } of MALLETS) {
    const a = makeSongMallet(id, materials()), b = makeSongMallet(id, materials());
    assert.notEqual(a.object3d, b.object3d);
    assert.equal(a.object3d.userData.assetId, id);
    assert.equal(b.options.assetId, id);
    assert.deepEqual(a.object3d.children.map((m) => m.geometry.parameters), b.object3d.children.map((m) => m.geometry.parameters));
    assert.deepEqual(a.options.grip?.position.toArray(), b.options.grip?.position.toArray());
    assert.deepEqual(a.options.grip?.rotation.toArray(), b.options.grip?.rotation.toArray());
  }
  assert.throws(() => makeSongMallet('unknown-prop', materials()), /Unknown mallet asset/);
});

test('shared mallet IDs follow changes, held poses, late joins, ownership and drop independently of music', () => {
  const queue = [], peers = [], sent = [];
  const makeNet = (role, id) => {
    const listeners = {};
    const net = {
      role, id,
      on(type, fn) { (listeners[type] ??= []).push(fn); },
      has(otherRole) { return peers.some((p) => p.net.role === otherRole && p.net !== net); },
      send(type, data) {
        sent.push({ from: id, type, data });
        for (const peer of peers) if (peer.net !== net) queue.push({ peer, type, data, from: { role, from: id } });
      },
    };
    peers.push({ net, listeners }); return net;
  };
  const flush = () => {
    while (queue.length) {
      const m = queue.shift();
      for (const fn of m.peer.listeners[m.type] ?? []) fn(m.data, m.from);
    }
  };
  const station = () => {
    const events = {};
    return {
      mode: 'idle', phase: 'pound', kineAssetId: 'yokogine', remotePose: null,
      pose: [0.2, 1.1, 0.3, 0, 0, 0, 1],
      on(type, fn) { (events[type] ??= []).push(fn); },
      setKineAsset(id) {
        if (!MALLETS.some((m) => m.id === id)) return false;
        if (this.kineAssetId === id) return true;
        this.kineAssetId = id;
        for (const fn of events['kine-asset'] ?? []) fn({ assetId: id });
        return true;
      },
      setMode(mode) { this.mode = mode; }, setFollower() {}, followPhase() {},
      setRemoteKine(p) { this.remotePose = p; },
      heldKineTarget() { return ['vr', 'desktop'].includes(this.mode) ? this.pose : null; },
      dough: { requestSnapshot() {}, applySnapshot() {} },
    };
  };
  const inputs = (net, st) => ({
    net, station: st, scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
    hands: { hands: [], encode: () => [null, null], setRemote() {} },
  });
  const hostNet = makeNet('host', 'host'), guestNet = makeNet('join', 'guest');
  const hostStation = station(), guestStation = station();
  const host = createHostSync(inputs(hostNet, hostStation)), guest = createGuestSync(inputs(guestNet, guestStation));

  hostStation.setKineAsset('tteokme'); flush();
  assert.equal(guestStation.kineAssetId, 'tteokme', 'asset changes arrive even while the tool rests and no song plays');
  hostStation.setMode('desktop'); host.update(0.03); flush();
  assert.equal(guestStation.mode, 'remote');
  assert.deepEqual(guestStation.remotePose, hostStation.pose);
  assert.equal(sent.find((m) => m.type === 'pose').data.assetId, 'tteokme');

  const lateNet = makeNet('join', 'late'), lateStation = station();
  const late = createGuestSync(inputs(lateNet, lateStation));
  host.update(0.03); flush();
  assert.equal(lateStation.kineAssetId, 'tteokme', 'late joins learn the actual held asset without inferring it from music');
  assert.deepEqual(lateStation.remotePose, hostStation.pose);

  hostStation.setMode('idle'); guest.update(0.6); late.update(0.6); flush();
  let grants = 0, lateGrants = 0;
  guest.onKine = (ok) => { if (ok) { grants++; guestStation.setMode('vr'); } };
  late.onKine = () => { lateGrants++; };
  guest.takeKine(); flush();
  assert.equal(grants, 1); assert.equal(lateGrants, 0, 'ownership grants target the player who requested the object');
  guest.update(0.03); flush();
  assert.deepEqual(hostStation.remotePose, guestStation.pose);

  const previousPose = hostStation.remotePose;
  guestStation.pose = [0.3, 1.3, -0.1, 0, 0, 0, 1]; guest.update(0.03); // old-asset pose in flight
  hostStation.setKineAsset('pestle'); flush();
  assert.equal(hostStation.kineAssetId, 'pestle'); assert.equal(guestStation.kineAssetId, 'pestle');
  assert.equal(hostStation.remotePose, previousPose, 'do not apply a stale pose with the previous asset’s grip');
  guest.update(0.03); flush(); assert.deepEqual(hostStation.remotePose, guestStation.pose);

  lateStation.setMode('vr'); lateStation.pose = [99, 99, 99, 0, 0, 0, 1]; late.update(0.03); flush();
  assert.deepEqual(hostStation.remotePose, guestStation.pose, 'a different player cannot move the held object');
  late.dropKine(); flush(); assert.equal(hostStation.mode, 'remote', 'only the owner can drop the object');
  guestStation.setMode('idle'); guest.dropKine(); flush(); assert.equal(hostStation.mode, 'idle');
  assert.equal(hostStation.kineAssetId, 'pestle');
  host.update(1.1); flush(); assert.equal(lateStation.kineAssetId, 'pestle');
  assert.equal(guestStation.setKineAsset('missing-model'), false);
  assert.equal(guestStation.kineAssetId, 'pestle');
});
