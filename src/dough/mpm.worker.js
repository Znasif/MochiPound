// Runs the dough simulation off the main thread. Messages in: calibrate, init, spawn, clear, step, correct, show.
// 'show' (the film camera's playback, src/film/): no simulation, the particles placed exactly as recorded and
// their field returned, as a step's would be.
// Out: 'calibrated' (the quality tier this machine can run in real time) and one 'field' per step
// (the density grid for marching cubes, handed back and forth so no buffer is allocated per frame).
// Multiplayer: a step with `snap` also returns the particles (host); 'correct' eases this dough toward
// the host's particles (guest).
import { DoughSim, pickTier } from './mpm-core.js';

let sim = null;
const BUDGET_MS = 11; // simulation time per 60 Hz frame on the worker's own core, with some slack

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'calibrate') {
    self.postMessage({ type: 'calibrated', ...pickTier(m.usu, m.radius, BUDGET_MS) });
  } else if (m.type === 'init') {
    sim = new DoughSim(m.options);
  } else if (!sim) {
    if (m.type === 'step' || m.type === 'show') self.postMessage({ type: 'field', field: m.field, stats: { count: 0, topY: null, stepMs: 0, time: 0 } }, [m.field.buffer]);
  } else if (m.type === 'spawn') {
    sim.spawnSphere(m.center, m.radius, m.velocity);
  } else if (m.type === 'clear') {
    sim.clear();
  } else if (m.type === 'correct') {
    sim.correct(m.N, new Int16Array(m.x), new Int16Array(m.v), m.k);
  } else if (m.type === 'show') {
    // placed exactly, then a 10 us step (it moves nothing visibly) so each particle's measured density, which the
    // drawing of thin strands reads, is the snapshot's own: the field then matches the host's to ~1e-4
    if (m.N > 0) { sim.correct(m.N, new Int16Array(m.x), new Int16Array(m.v), 1); sim.step(1e-5, []); } else sim.clear();
    const stats = m.field.length !== sim.n3 ? { count: sim.N, stale: true, topY: null } : sim.writeField(m.field, m.axis);
    stats.stepMs = 0; stats.simDt = 0; stats.substeps = 0; stats.n = sim.n;
    self.postMessage({ type: 'field', field: m.field, stats }, [m.field.buffer]);
  } else if (m.type === 'step') {
    const t0 = performance.now();
    sim.progress = m.progress ?? 0;
    sim.wet = m.wet ?? 0;
    if (m.youngsModulus !== undefined) sim.setYoungsModulus(m.youngsModulus);
    sim.step(m.dt, m.tools ?? []);
    // a grid buffer from before a quality change has the wrong size: say so instead of writing it
    const stats = m.field.length !== sim.n3 ? { count: sim.N, stale: true, topY: null } : sim.writeField(m.field, m.axis);
    stats.stepMs = performance.now() - t0;
    stats.simDt = sim.lastSimDt; // simulated seconds actually covered by the stable timestep
    stats.substeps = sim.lastSubsteps ?? 0;
    stats.n = sim.n;
    if (m.snap) {
      const snap = sim.snapshot();
      self.postMessage({ type: 'field', field: m.field, stats, snap: { N: snap.N, x: snap.xq.buffer, v: snap.vq.buffer } }, [m.field.buffer, snap.xq.buffer, snap.vq.buffer]);
      return;
    }
    self.postMessage({ type: 'field', field: m.field, stats }, [m.field.buffer]);
  }
};
