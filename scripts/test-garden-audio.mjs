// Verify actual synthesized samples plus graph, spatial binding, portal fade and start/retry lifecycle.
// The AudioContext graph is a stand-in; this does not claim to verify sound through a headset.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createMoonAmbience } from '../src/moonGarden/ambience.js';
import { noiseData, bambooData, dripData } from '../src/moonGarden/ambienceSynth.js';
import { createAudioPlayback } from '../src/audioPlayback.js';

const rate = 16000;
function checkSamples(data, label) {
  let energy = 0, peak = 0;
  for (const value of data) { assert.ok(Number.isFinite(value)); energy += value * value; peak = Math.max(peak, Math.abs(value)); }
  const rms = Math.sqrt(energy / data.length);
  assert.ok(rms > 0.005 && rms < 0.3, `${label}: audible, bounded sample energy (${rms})`);
  assert.ok(peak < 1 && Math.abs(data[0]) < 1e-7 && Math.abs(data.at(-1)) < 1e-7, `${label}: no clipping or loop-edge step`);
}
const wind = noiseData(rate);
wind.forEach((samples, i) => checkSamples(samples, `wind ${i}`));
assert.notDeepEqual(wind[0], wind[1], 'the wind bed has independent stereo channels');
assert.deepEqual(wind[0], noiseData(rate)[0], 'synthesis is deterministic');
checkSamples(bambooData(rate), 'bamboo'); checkSamples(dripData(rate), 'water drop');
assert.notDeepEqual(bambooData(rate, 392), bambooData(rate, 523.25));

class Param {
  value = 0; targets = [];
  setTargetAtTime(value, at, timeConstant) { this.value = value; this.targets.push({ value, at, timeConstant }); }
}
class Node {
  connections = []; disconnected = false; stopped = false;
  connect(to) { this.connections.push(to); return to; }
  disconnect() { this.disconnected = true; this.connections.length = 0; }
  start(at = 0, offset = 0) { assert.equal(this.started, undefined, 'a source starts only once'); this.started = { at, offset }; }
  stop(at = 0) { this.stopped = true; this.stopAt = at; }
}
const params = (object, names) => { for (const name of names) object[name] = new Param(); return object; };
class Context {
  static instances = [];
  sampleRate = rate; currentTime = 0; state = 'suspended'; destination = new Node(); resumeCalls = 0;
  nodes = []; sources = []; panners = []; gains = []; events = [];
  listener = params({}, ['positionX', 'positionY', 'positionZ', 'forwardX', 'forwardY', 'forwardZ', 'upX', 'upY', 'upZ']);
  constructor() { Context.instances.push(this); }
  node(names = []) { const node = params(new Node(), names); this.nodes.push(node); return node; }
  createGain() { const node = this.node(['gain']); this.gains.push(node); return node; }
  createDynamicsCompressor() { return this.node(['threshold', 'knee', 'ratio', 'attack', 'release']); }
  createBiquadFilter() { return this.node(['frequency', 'Q']); }
  createOscillator() { const node = this.node(['frequency']); this.sources.push(node); return node; }
  createPanner() { const node = this.node(['positionX', 'positionY', 'positionZ']); this.panners.push(node); return node; }
  createBufferSource() { const node = this.node(); this.sources.push(node); return node; }
  createBuffer(channels, length, sampleRate) {
    this.events.push('buffer');
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { duration: length / sampleRate, numberOfChannels: channels, getChannelData: (i) => data[i] };
  }
  resume() { this.events.push('resume'); this.resumeCalls++; this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  advance(seconds) {
    this.currentTime += seconds;
    for (const source of this.sources) if (source.stopAt <= this.currentTime && !source.ended) { source.ended = true; source.onended?.(); }
  }
}
const camera = new THREE.PerspectiveCamera(); camera.position.set(0.9, 1.62, 3.1);
const parent = new THREE.Group(); parent.position.set(2, 0, 1);
const fountain = new THREE.Object3D(), chime = new THREE.Object3D(); parent.add(fountain, chime);
fountain.position.set(1, 0.8, -2); chime.position.set(-2, 2.3, 1);
fountain.userData.audioReady = chime.userData.audioReady = false;
const errors = [];
const ambience = createMoonAmbience({ camera, sources: { fountain, chime }, AudioContextClass: Context, onError: (error) => errors.push(error) });
assert.equal(Context.instances.length, 0, 'no audio context or autoplay before a gesture');
assert.equal(await ambience.start(), true);
const ac = Context.instances[0], master = ac.gains[0];
assert.equal(ac.events[0], 'resume', 'unlock happens before buffers are generated');
assert.equal(ac.sources.length, 3); await ambience.start(); assert.equal(ac.sources.length, 3, 'resume never duplicates ambient loops');
ac.advance(10); ambience.update(1 / 60, { reveal: 0 });
assert.equal(master.gain.value, 0); assert.equal(ac.sources.length, 3, 'the void has no wind or prop events');
ambience.update(1 / 60, { reveal: 0.5 }); assert.equal(master.gain.value, 0.325);
assert.equal(ac.sources.length, 3, 'unloaded props do not make invisible sounds');
fountain.userData.audioReady = chime.userData.audioReady = true;
ac.advance(15); ambience.update(1 / 60, { reveal: 1 });
assert.equal(master.gain.value, 0.65); assert.ok(ac.sources.length >= 6, 'loaded fountain and chime schedule audible events');
assert.ok(master.connections[0].connections.includes(ac.destination), 'the master reaches the output');
const fountainWorld = fountain.getWorldPosition(new THREE.Vector3());
assert.equal(ac.panners[0].positionX.value, fountainWorld.x); assert.equal(ac.panners[0].positionZ.value, fountainWorld.z);
assert.equal(ac.listener.positionY.value, 1.62);
camera.rotation.y = Math.PI / 2; camera.updateMatrixWorld(true); parent.position.x += 1;
ambience.update(1 / 60);
assert.ok(Math.abs(ac.listener.forwardX.value + 1) < 1e-6, 'head rotation changes spatial listening direction');
assert.equal(ac.panners[0].positionX.value, fountainWorld.x + 1, 'sound follows the prop transform');
const count = ac.sources.length;
for (let i = 0; i < 120; i++) ambience.update(1 / 60);
assert.equal(ac.sources.length, count, 'frame updates cannot repeatedly trigger the same chime');
ambience.setVisible(false); assert.equal(ac.state, 'suspended'); assert.equal(await ambience.start(), false);
ambience.setVisible(true); assert.equal(ac.state, 'running'); assert.equal(Context.instances.length, 1);
ambience.update(1 / 60, { active: false }); assert.equal(master.gain.value, 0, 'menu pauses fade ambience away');
ambience.setVolume(0); ac.advance(20); ambience.update(1 / 60);
assert.equal(master.gain.value, 0); assert.equal(ac.sources.length, count, 'muting stops future event scheduling');
ambience.dispose(); assert.equal(ac.state, 'closed');
assert.ok(ac.nodes.every((node) => node.disconnected)); assert.equal(await ambience.start(), false); assert.equal(errors.length, 0);

// Failed station recordings do not block garden ambience. Rejected starts are retried next gesture.
let scene = null, ambientStarts = 0, sceneStarts = 0, successfulStarts = 0, resumeCalls = 0, rejectStart = true, gesture = false;
const failures = [];
const playback = createAudioPlayback({
  getAudio: () => scene, ambience: { start() { assert.ok(gesture); ambientStarts++; } },
  onStarted: () => successfulStarts++,
  onError: (error) => failures.push(error.message),
});
gesture = true; await playback.start(); gesture = false; assert.equal(ambientStarts, 1);
scene = { status: 'silent' }; gesture = true; await playback.start(); gesture = false; assert.equal(ambientStarts, 2);
scene = { status: 'ready', engine: { isPlaying: false, audioContext: { state: 'suspended', resume() { assert.ok(gesture); resumeCalls++; this.state = 'running'; } } },
  start() { assert.ok(gesture); sceneStarts++; if (rejectStart) return Promise.reject(new Error('blocked')); this.engine.isPlaying = true; } };
gesture = true; const failed = playback.start(); gesture = false; assert.equal(await failed, false); assert.equal(sceneStarts, 1);
assert.equal(successfulStarts, 0, 'a failed start must not report ready');
rejectStart = false; gesture = true; const retried = playback.start(); gesture = false; assert.equal(await retried, true); assert.equal(sceneStarts, 2);
assert.equal(successfulStarts, 1, 'a successful retry restores the ready status');
scene.engine.audioContext.state = 'suspended'; gesture = true; await playback.start(); gesture = false;
assert.equal(sceneStarts, 2, 'resuming does not restart an already playing scene'); assert.equal(resumeCalls, 2);
scene.engine.isPlaying = false; gesture = true; await playback.start(); gesture = false; assert.equal(sceneStarts, 3, 'a stopped scene starts again');
assert.deepEqual(failures, ['blocked']);

let finish, starts = 0;
const waiting = createAudioPlayback({ getAudio: () => ({ status: 'silent' }) }); assert.equal(await waiting.start(), false);
const pendingScene = { status: 'ready', start() { starts++; return new Promise((resolve) => { finish = resolve; }); } };
const singleStart = createAudioPlayback({ getAudio: () => pendingScene });
const first = singleStart.start(), second = singleStart.start(); assert.equal(first, second); assert.equal(starts, 1);
finish(); await first;
console.info('Garden audio checks passed: real sample energy, spatial graph, portal/menu fades, visibility, disposal, missing clips and start/retry/resume.');
