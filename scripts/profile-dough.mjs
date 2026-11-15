// Where the dough simulation spends its time: the same drop + strikes, run with parts switched off.
import * as THREE from 'three';
import { DoughSim } from '../src/dough/mpm-core.js';
import { makeUsu, usuShape } from '../src/props.js';
const plain = new THREE.MeshBasicMaterial();
const USU = usuShape(makeUsu({ radius: 0.42, height: 0.7 }, { side: plain, top: plain, band: plain, mat: plain })); // the scene's mortar, at the origin
const q0 = [0, 0, 0, 1];
function run(label, tweak, opts = {}) {
  const sim = new DoughSim({ usu: USU, ...opts });
  tweak?.(sim);
  const field = new Float32Array(sim.n3);
  sim.spawnSphere([0.03, 1.0, -0.02], 0.14, [0, -2, 0]);
  let t = 0, frames = 0, subs = 0;
  const step = (tools = []) => { const t0 = performance.now(); sim.step(1 / 60, tools); sim.writeField(field); t += performance.now() - t0; frames++; };
  for (let i = 0; i < 90; i++) step();
  for (let k = 0; k < 3; k++) {
    const top = sim.writeField(field, { x: 0, z: 0, r: 0.1 }).topY ?? 0.67;
    const bottom = top + 0.16 - 0.06;
    let prev = [0, 1.25, 0];
    for (let i = 0; i <= 47; i++) {
      const y = i <= 11 ? 1.25 - (1.25 - bottom) * (i / 11) ** 2 : i <= 17 ? bottom : bottom + (1.25 - bottom) * ((i - 17) / 30);
      step([{ kind: 'cylinder', r: 0.1, h: 0.16, c0: prev, c1: [0, y, 0], q0, q1: q0 }]);
      prev = [0, y, 0];
    }
  }
  const nsub = Math.min(sim.o.maxSubsteps, Math.ceil((1 / 60) / sim.o.maxDt));
  console.log(`${label.padEnd(34)} ${sim.N} particles, ${nsub} substeps/frame: ${(t / frames).toFixed(2)} ms/frame, ${((1000 * t) / frames / nsub / sim.N).toFixed(3)} us per particle-substep`);
}
run('baseline');
run('no plasticity', (s) => { s.plasticity = () => {}; });
run('no per-particle mortar check', (s) => { s.usuSdf = () => 1e9; });
run('neither', (s) => { s.plasticity = () => {}; s.usuSdf = () => 1e9; });

// per quality tier: cost per 60 Hz frame on this machine, and what a 3.4x slower browser would pick
import { TIERS, tierOptions, particlesFor } from '../src/dough/mpm-core.js';
console.log('--- tiers (budget 9 ms per frame) ---');
for (const tier of TIERS) {
  const sim = new DoughSim(tierOptions(tier, { usu: USU }));
  sim.spawnSphere([0, 0.95, 0], 0.14, [0, -1, 0]);
  for (let i = 0; i < 30; i++) sim.step(1 / 60, []);
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) sim.step(1 / 60, []);
  const ms = (performance.now() - t0) / 60;
  console.log(`${tier.name.padEnd(9)} ${String(sim.N).padStart(4)} particles (predicted ${particlesFor(tier, 0.14)}), ${Math.ceil(1 / 60 / tier.maxDt - 1e-9)} substeps: ${ms.toFixed(2)} ms/frame here, ~${(ms * 3.4).toFixed(1)} ms on a 3.4x slower browser`);
}

// the start-up probe the browser runs (here, on this core)
import { pickTier } from '../src/dough/mpm-core.js';
const picked = pickTier(USU, 0.14, 11);
console.log(`pickTier here: "${TIERS[picked.tier].name}" (${(picked.msPerParticleSubstep * 1000).toFixed(3)} us per particle-substep); a 3.4x slower browser: "${TIERS[pickTier(USU, 0.14, 11 / 3.4).tier].name}"`);
