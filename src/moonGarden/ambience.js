// A local soundscape for this garden: broad wind/leaf rustle, water at the fountain and hollow
// bamboo chimes at the hanging prop. Its own unlocked context keeps it working if Satie clips fail.
import * as THREE from 'three';
import { noiseData, bambooData, dripData, seededRandom } from './ambienceSynth.js';

const CHIMES = [329.63, 392, 440, 523.25, 587.33];
export function createMoonAmbience({ camera, sources = {},
  AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext,
  onError = (error) => console.warn('[ambience]', error.message), random = seededRandom(71) } = {}) {
  let context = null, master = null, windGain = null, waterGain = null, fountain = null, chime = null;
  let started = false, disposed = false, visible = true, announced = false, gainTarget = -1, waterTarget = -1, volume = 0.65;
  let nextChime = 0, nextDrip = 0, noise = null, drip = null;
  const nodes = new Set(), loops = new Set(), voices = new Set(), chimeBuffers = new Map();
  const position = new THREE.Vector3(), forward = new THREE.Vector3(), up = new THREE.Vector3(), orientation = new THREE.Quaternion();
  const keep = (node) => { nodes.add(node); return node; };
  const ready = (object) => object && object.userData?.audioReady !== false;
  const param = (node, name, value) => { if (node?.[name]) node[name].value = value; };

  function audioBuffer(channels) {
    const data = Array.isArray(channels) ? channels : [channels];
    const buffer = context.createBuffer(data.length, data[0].length, context.sampleRate);
    data.forEach((samples, i) => buffer.getChannelData(i).set(samples));
    return buffer;
  }
  function filter(type, frequency, Q = 0.7) {
    const f = keep(context.createBiquadFilter()); f.type = type; f.frequency.value = frequency; f.Q.value = Q; return f;
  }
  function panner(refDistance) {
    const p = keep(context.createPanner()); p.panningModel = 'HRTF'; p.distanceModel = 'inverse';
    p.refDistance = refDistance; p.rolloffFactor = 0.7; p.maxDistance = 50; p.connect(master); return p;
  }
  function updatePosition(node, object) {
    if (!node || !object) return;
    object.getWorldPosition(position);
    if (node.positionX) { param(node, 'positionX', position.x); param(node, 'positionY', position.y); param(node, 'positionZ', position.z); }
    else node.setPosition(position.x, position.y, position.z);
  }
  function loop(output, offset) {
    const source = keep(context.createBufferSource()); source.buffer = noise; source.loop = true;
    source.connect(output); source.start(context.currentTime, offset); loops.add(source); return source;
  }
  function setup() {
    master = keep(context.createGain()); master.gain.value = 0;
    const limiter = keep(context.createDynamicsCompressor());
    limiter.threshold.value = -16; limiter.knee.value = 12; limiter.ratio.value = 3;
    limiter.attack.value = 0.01; limiter.release.value = 0.25;
    master.connect(limiter); limiter.connect(context.destination);
    noise = audioBuffer(noiseData(context.sampleRate));
    windGain = keep(context.createGain()); windGain.gain.value = 0.11;
    const windLow = filter('lowpass', 1800), windHigh = filter('highpass', 75);
    windLow.connect(windHigh); windHigh.connect(windGain); windGain.connect(master); loop(windLow, 0.17);
    const sway = keep(context.createOscillator()), swayGain = keep(context.createGain());
    sway.frequency.value = 0.065; swayGain.gain.value = 0.032;
    sway.connect(swayGain); swayGain.connect(windGain.gain); sway.start(); loops.add(sway);

    fountain = panner(1.5); chime = panner(1.8);
    waterGain = keep(context.createGain()); waterGain.gain.value = 0;
    const waterHigh = filter('highpass', 550), waterLow = filter('lowpass', 6500);
    waterHigh.connect(waterLow); waterLow.connect(waterGain); waterGain.connect(fountain); loop(waterHigh, 2.31);
    drip = audioBuffer(dripData(context.sampleRate));
    nextChime = context.currentTime + 2.5; nextDrip = context.currentTime + 1.3;
    updatePosition(fountain, sources.fountain); updatePosition(chime, sources.chime);
  }
  function oneShot(buffer, output, when, level = 1) {
    const source = context.createBufferSource(), gain = context.createGain();
    source.buffer = buffer; gain.gain.value = level; source.connect(gain); gain.connect(output);
    const voice = { source, gain }; voices.add(voice);
    source.onended = () => { source.disconnect(); gain.disconnect(); voices.delete(voice); };
    source.start(when); source.stop(when + buffer.duration + 0.01);
  }
  function start() {
    if (disposed || !visible) return Promise.resolve(false);
    try {
      if (!context) {
        if (!AudioContextClass) throw new Error('Web Audio is unavailable in this browser');
        context = new AudioContextClass({ latencyHint: 'interactive' });
      }
      // Call resume inside Play / Enter VR, before creating buffers or awaiting anything.
      const resumed = context.state === 'running' ? Promise.resolve() : context.resume();
      if (!master) setup();
      started = true;
      return Promise.resolve(resumed).then(() => {
        if (!announced) { announced = true; console.info('[ambience] ready: garden wind, fountain and bamboo chimes'); }
        return true;
      }).catch((error) => { onError(error); return false; });
    } catch (error) { onError(error); return Promise.resolve(false); }
  }
  function setVisible(value) {
    visible = !!value;
    if (!context || !started || disposed) return;
    const operation = visible ? context.resume() : context.suspend();
    Promise.resolve(operation).catch(onError);
  }
  function update(dt, { active = true, reveal = 1 } = {}) {
    if (!started || disposed || !master) return;
    const target = active && visible ? volume * THREE.MathUtils.clamp(reveal, 0, 1) : 0;
    if (Math.abs(target - gainTarget) > 0.001) {
      master.gain.setTargetAtTime(target, context.currentTime, target > gainTarget ? 1.1 : 0.3); gainTarget = target;
    }
    if (context.state !== 'running') return;
    camera.getWorldPosition(position); camera.getWorldQuaternion(orientation);
    forward.set(0, 0, -1).applyQuaternion(orientation); up.set(0, 1, 0).applyQuaternion(orientation);
    const listener = context.listener;
    if (listener.positionX) {
      for (const [name, value] of Object.entries({ positionX: position.x, positionY: position.y, positionZ: position.z,
        forwardX: forward.x, forwardY: forward.y, forwardZ: forward.z, upX: up.x, upY: up.y, upZ: up.z })) param(listener, name, value);
    } else { listener.setPosition(position.x, position.y, position.z); listener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z); }
    updatePosition(fountain, sources.fountain); updatePosition(chime, sources.chime);
    const water = ready(sources.fountain) ? 0.32 : 0;
    if (water !== waterTarget) { waterGain.gain.setTargetAtTime(water, context.currentTime, 0.6); waterTarget = water; }
    if (target < 0.01) return;
    const now = context.currentTime;
    if (now >= nextDrip) {
      nextDrip = now + 1.4 + random() * 2.5;
      if (ready(sources.fountain)) oneShot(drip, fountain, now + 0.03, 0.6 + random() * 0.25);
    }
    if (now >= nextChime) {
      nextChime = now + 5 + random() * 7;
      if (ready(sources.chime)) {
        const first = Math.floor(random() * CHIMES.length), count = random() < 0.4 ? 3 : 2;
        for (let i = 0; i < count; i++) {
          const note = (first + i * 2) % CHIMES.length;
          if (!chimeBuffers.has(note)) chimeBuffers.set(note, audioBuffer(bambooData(context.sampleRate, CHIMES[note], note + 9)));
          oneShot(chimeBuffers.get(note), chime, now + 0.03 + i * 0.22, 0.65 + random() * 0.25);
        }
      }
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const source of loops) { try { source.stop(); } catch { /* already stopped */ } }
    for (const voice of voices) { try { voice.source.stop(); } catch { /* already stopped */ } voice.source.disconnect(); voice.gain.disconnect(); }
    for (const node of nodes) node.disconnect();
    loops.clear(); voices.clear(); nodes.clear(); chimeBuffers.clear();
    if (context?.state !== 'closed') Promise.resolve(context?.close()).catch(onError);
  }
  return {
    start, update, setVisible, dispose,
    setVolume(value) { volume = THREE.MathUtils.clamp(Number(value) || 0, 0, 1); },
    get audioContext() { return context; },
    get running() { return started && context?.state === 'running'; },
  };
}
