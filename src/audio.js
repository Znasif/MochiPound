import { SatieScene } from 'satie-runtime/three';
import { SatieEngine } from 'satie-runtime';

// Satie glue. Loads public/satie/scene.satie + samples.json (+ the scene contract), binds every
// host the manifest declares to its three.js object, and puts the listener on the camera.
// If the takes have not been realized yet (no samples.json), the scene runs silent and says so;
// nothing here ever generates audio or talks to Satie's servers apart from loading the clips.

const SCRIPT = '/satie/scene.satie';
const SAMPLES = '/satie/samples.json';
const CONTRACT = '/satie/scene.contract.json';

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`${url} is not JSON (not generated yet?)`); }
}

function silent(reason) {
  const noop = () => {};
  return {
    status: 'silent', reason, engine: null,
    start: async () => {}, update: noop, hostEvent: noop, setHostSurface: noop, event: noop, step: noop,
    signal: noop, signalTarget: noop, state: noop, bindWarnings: [],
  };
}

export async function loadAudio({ hosts, camera, xr, onRetry = null }) {
  let contract;
  try {
    contract = await fetchJson(CONTRACT);
    await fetchJson(SAMPLES);
    const s = await fetch(SCRIPT, { cache: 'no-cache' });
    if (!s.ok || (await s.text()).trim().length === 0) throw new Error(`${SCRIPT} missing`);
  } catch (err) {
    console.info('[satie] running silent:', err.message);
    return silent(err.message);
  }

  // The clips come over the network, most of them from Satie's storage on the web, and one dropped
  // download fails the whole load (the Quest saw "Failed to fetch" on about 1 page load in 5). So a
  // network failure is retried a few times, each with a fresh engine (the runtime disposes a failed
  // scene); clips that did arrive come from the browser's cache the next time.
  const ATTEMPTS = 4;
  let audio = null;
  for (let attempt = 1; ; attempt++) {
    const engine = new SatieEngine({ loopVoiceBudget: { maxRealVoices: xr ? 16 : 32, silenceThresholdDb: -60, hysteresisDb: 3 } });
    try {
      audio = await SatieScene.load(SCRIPT, SAMPLES, { contract, seed: 7, engine });
      break;
    } catch (err) {
      try { engine.dispose?.(); } catch { /* already gone with the scene */ }
      const network = err instanceof TypeError || /Failed to fetch|NetworkError|Load failed|HTTP 5\d\d/.test(err.message ?? '');
      if (!network || attempt >= ATTEMPTS) throw err;
      console.warn(`[satie] load attempt ${attempt} failed (${err.message}); retrying`);
      onRetry?.(attempt, err);
      await new Promise((r) => setTimeout(r, 700 * attempt));
    }
  }

  for (const [id, { object, anchor }] of Object.entries(hosts)) {
    try { audio.bind(id, object, anchor ? { anchor } : undefined); }
    catch (err) { console.warn(`[satie] could not bind host "${id}":`, err.message); }
  }
  audio.bindListener(camera);
  if (audio.bindWarnings?.length) console.warn('[satie] bind warnings:', audio.bindWarnings);

  // Calls into the runtime fail loudly on undeclared names; log each problem once and keep playing.
  const seen = new Set();
  const guard = (label, fn) => (...args) => {
    try { return fn(...args); }
    catch (err) {
      const key = `${label}:${args[0]}:${args[1] ?? ''}`;
      if (!seen.has(key)) { seen.add(key); console.warn(`[satie] ${label}(${args.slice(0, 2).join(', ')}) failed:`, err.message); }
      return false;
    }
  };
  return {
    status: 'ready', reason: null, engine: audio.engine, scene: audio,
    start: () => audio.start(),
    update: (cam) => audio.update(cam),
    hostEvent: guard('hostEvent', (id, name, opts) => audio.hostEvent(id, name, opts)),
    setHostSurface: guard('setHostSurface', (id, surface) => audio.setHostSurface(id, surface)),
    event: guard('event', (name, at, text) => audio.event(name, at, text)),
    step: guard('step', (surface) => audio.step(surface)),
    signal: guard('signal', (name, v) => audio.signal(name, v)),
    signalTarget: guard('signalTarget', (name, v, o) => audio.signalTarget(name, v, o)),
    state: guard('state', (name, iso) => audio.state(name, iso)),
    bindWarnings: audio.bindWarnings ?? [],
  };
}
