// Checks src/rhythm/beats.js on synthetic songs with a known beat grid: kick on every beat,
// hi-hat on the off-beats, a quiet sustained chord and some noise. Reports detected BPM and how far
// the detected beats sit from the true ones.
import { analyzeBeats, strikesFromBeats, autoEvery } from '../src/rhythm/beats.js';

const SR = 44100;
function song(bpm, seconds, { start = 0.5, swingNoise = 0.0 } = {}) {
  const n = Math.floor(SR * seconds);
  const x = new Float32Array(n);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) * 2 - 1;
  const beat = 60 / bpm, truth = [];
  for (let t = start; t < seconds - 0.2; t += beat) {
    const tt = t + swingNoise * rnd() * 0.01;
    truth.push(tt);
    const i0 = Math.floor(tt * SR);
    for (let i = 0; i < SR * 0.18 && i0 + i < n; i++) { // kick: falling-pitch sine
      const s = i / SR;
      x[i0 + i] += 0.8 * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-s * 30)) * s) * Math.exp(-s * 18);
    }
    const h0 = Math.floor((tt + beat / 2) * SR); // off-beat hi-hat
    for (let i = 0; i < SR * 0.04 && h0 + i < n; i++) x[h0 + i] += 0.15 * rnd() * Math.exp(-(i / SR) * 90);
  }
  for (let i = 0; i < n; i++) { // pad + noise floor
    const s = i / SR;
    x[i] += 0.05 * (Math.sin(2 * Math.PI * 220 * s) + Math.sin(2 * Math.PI * 277 * s) + Math.sin(2 * Math.PI * 330 * s)) + 0.01 * rnd();
  }
  return { buffer: { sampleRate: SR, numberOfChannels: 1, duration: n / SR, length: n, getChannelData: () => x }, truth };
}

let ok = true;
for (const bpm of [72, 96, 110, 128, 150]) {
  const { buffer, truth } = song(bpm, 40, { swingNoise: 1 });
  const t0 = performance.now();
  const a = analyzeBeats(buffer);
  const ms = performance.now() - t0;
  const errs = a.beats.map((b) => Math.min(...truth.map((t) => Math.abs(t - b))));
  errs.sort((p, q) => p - q);
  const med = errs[Math.floor(errs.length / 2)] * 1000, p90 = errs[Math.floor(errs.length * 0.9)] * 1000;
  const bpmErr = Math.abs(a.bpm - bpm) / bpm;
  const pass = bpmErr < 0.03 && med < 20 && a.beats.length > truth.length * 0.85;
  ok &&= pass;
  const every = autoEvery(a);
  console.log(`${String(bpm).padStart(3)} BPM -> ${a.bpm.toFixed(1)} BPM, ${a.beats.length}/${truth.length} beats, error median ${med.toFixed(1)} ms p90 ${p90.toFixed(1)} ms, strikes every ${every} (${strikesFromBeats(a, every).length}), ${ms.toFixed(0)} ms  ${pass ? 'PASS' : 'FAIL'}`);
}
console.log(ok ? 'all passed' : 'some FAILED');
process.exitCode = ok ? 0 : 1;
