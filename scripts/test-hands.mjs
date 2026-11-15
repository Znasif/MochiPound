// Headless test of tracked hands working the dough (src/hands.js colliders in src/dough/mpm-core.js):
// a synthetic hand (the WebXR joint set, adult proportions; the test's own fixture) built into the same
// bone colliders hands.js makes, run through:
//   press    palm down 4 cm into the top, hold, lift: does the dough spring back (elastic) or keep the dent, does it
//            follow the lifting palm (sticky) or stay (not sticky)?
//   drag     palm pressed into the top and moved 10 cm sideways: does the dough go with it?
//   squeeze  two hands from both sides, squeeze, lift 12 cm: is dough carried up (friction or tack), and dropped?
//   wet      the press with wet hands (after the bucket): no pull, no grip
// Usage: node scripts/test-hands.mjs [tier]   (default tiny, the Quest's)
// BEFORE_CORE=<path to an older mpm-core.js> also runs that core with the old hand settings (tack 0).
import * as THREE from 'three';
import * as Core from '../src/dough/mpm-core.js';
import { BONES, HAND } from '../src/hands.js';
import { makeUsu, usuShape } from '../src/props.js';

const plain = new THREE.MeshBasicMaterial();
const USU = usuShape(makeUsu({ radius: 0.42, height: 0.7 }, { side: plain, top: plain, band: plain, mat: plain }));
const FRAME = 1 / 60;
const tierName = process.argv[2] ?? 'tiny';
// tuning knobs: HAND_TACK=<n> overrides hands.js's tack; CORE_OPTS='{"mouldHold":0}' overrides dough options
const EXTRA = process.env.CORE_OPTS ? JSON.parse(process.env.CORE_OPTS) : {};

// right hand, local frame: fingers along +X, palm facing -Y, thumb toward +Z; joint centres (m) and radii
const TEMPLATE = (() => {
  const j = { wrist: [0, 0, 0, 0.02] };
  const fingers = [['index-finger', 0.025, 0.085], ['middle-finger', 0.005, 0.09], ['ring-finger', -0.015, 0.085], ['pinky-finger', -0.033, 0.075]];
  for (const [f, z, k] of fingers) {
    j[`${f}-metacarpal`] = [0.02, 0, z * 0.5, 0.012];
    j[`${f}-phalanx-proximal`] = [k, 0, z, 0.011];
    j[`${f}-phalanx-intermediate`] = [k + 0.045, 0, z, 0.009];
    j[`${f}-phalanx-distal`] = [k + 0.072, 0, z, 0.008];
    j[`${f}-tip`] = [k + 0.094, 0, z, 0.007];
  }
  Object.assign(j, { 'thumb-metacarpal': [0.02, -0.005, 0.03, 0.015], 'thumb-phalanx-proximal': [0.05, -0.01, 0.06, 0.011], 'thumb-phalanx-distal': [0.08, -0.012, 0.075, 0.009], 'thumb-tip': [0.105, -0.013, 0.085, 0.008] });
  return j;
})();
const UP = new THREE.Vector3(0, 1, 0);
// the hand's bone colliders (as hands.js builds them) for the hand at `pos` (the palm's centre) with rotation `quat`
function bones(id, pos, quat, props) {
  const palm = new THREE.Vector3(0.055, 0, 0); // template palm centre (between metacarpals and knuckles)
  const P = {}, R = {};
  for (const [name, [x, y, z, r]] of Object.entries(TEMPLATE)) { P[name] = new THREE.Vector3(x, y, z).sub(palm).applyQuaternion(quat).add(pos); R[name] = r; }
  return BONES.map(([a, b], k) => {
    const d = new THREE.Vector3().subVectors(P[b], P[a]), len = d.length();
    const q = new THREE.Quaternion().setFromUnitVectors(UP, d.multiplyScalar(1 / len));
    const c = new THREE.Vector3().addVectors(P[a], P[b]).multiplyScalar(0.5);
    return { id: `${id}-${k}`, group: id, kind: 'cylinder', r: (R[a] + R[b]) / 2, h: len / 2, c: c.toArray(), q: [q.x, q.y, q.z, q.w], ...props };
  });
}
const palmDown = new THREE.Quaternion(); // template already faces down
const palmToward = (side) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), side * Math.PI / 2); // palm facing -+Z

function makeRun(core, label, props) {
  const tier = core.TIERS.find((t) => t.name === tierName);
  const sim = new core.DoughSim(core.tierOptions(tier, { usu: USU, ...(core === Core ? EXTRA : {}) }));
  sim.spawnSphere([0.0, 1.0, 0.0], 0.14, [0, -2, 0]);
  const field = new Float32Array(sim.n3);
  let prev = new Map();
  const step = (hands = []) => {
    const tools = [];
    for (const h of hands) for (const b of bones(h.id, h.pos, h.quat, props)) {
      const last = prev.get(b.id) ?? b;
      tools.push({ id: b.id, group: b.group, kind: b.kind, r: b.r, h: b.h, tack: b.tack, mould: b.mould, friction: b.friction, c0: last.c, c1: b.c, q0: last.q, q1: b.q });
    }
    prev = new Map(hands.flatMap((h) => bones(h.id, h.pos, h.quat, props)).map((b) => [b.id, b]));
    const t0 = performance.now();
    sim.step(FRAME, tools);
    const st = sim.writeField(field, { x: 0, z: 0, r: 0.1 });
    if (tools.length) { handMs += performance.now() - t0; handFrames++; }
    return st;
  };
  const near = (r) => { let top = -1, n = 0, cx = 0; for (let p = 0; p < sim.N; p++) { const x = sim.x[p * 3], y = sim.x[p * 3 + 1], z = sim.x[p * 3 + 2]; if (Math.hypot(x, z) < r) top = Math.max(top, y); cx += x; n++; } return { top, cx: cx / n }; };
  // the drawn surface's height at (x, z): scanning the density field (what dough.js draws) down from the top
  const surfaceY = (x, z) => {
    const { n, dx, min } = sim, X = (x - min[0]) / dx, Z = (z - min[2]) / dx, i = Math.floor(X), k = Math.floor(Z), fx = X - i, fz = Z - k;
    const at = (j) => { const f = (ii, kk) => field[ii + j * n + kk * n * n]; return (f(i, k) * (1 - fx) + f(i + 1, k) * fx) * (1 - fz) + (f(i, k + 1) * (1 - fx) + f(i + 1, k + 1) * fx) * fz; };
    for (let j = n - 2; j > 0; j--) { const a = at(j), b = at(j - 1); if (a < 0.5 && b >= 0.5) return min[1] + (j - (0.5 - a) / (b - a)) * dx; }
    return null;
  };
  return { sim, step, near, label, surfaceY };
}
function settle(run, s = 2) { for (let i = 0; i < s * 60; i++) run.step(); }
const lerp3 = (a, b, t) => new THREE.Vector3().lerpVectors(a, b, t);
// particles under a palm-down hand at `c`: within `r` horizontally and `depth` below the palm centre
function under(sim, c, r, depth) {
  const out = [];
  for (let p = 0; p < sim.N; p++) { const x = sim.x[p * 3], y = sim.x[p * 3 + 1], z = sim.x[p * 3 + 2]; if (Math.hypot(x - c.x, z - c.z) < r && y < c.y && y > c.y - depth) out.push(p); }
  return out;
}
// separate blobs: particles binned into grid cells, joined across touching cells (the kernel's reach)
function pieces(sim) {
  const cell = new Map(), key = (i, j, k) => (i * 1024 + j) * 1024 + k;
  for (let p = 0; p < sim.N; p++) { const k = key(Math.floor((sim.x[p * 3] + 2) / sim.dx), Math.floor((sim.x[p * 3 + 1] + 2) / sim.dx), Math.floor((sim.x[p * 3 + 2] + 2) / sim.dx)); cell.set(k, (cell.get(k) ?? 0) + 1); }
  const seen = new Set(), sizes = [];
  for (const start of cell.keys()) {
    if (seen.has(start)) continue;
    let count = 0; const stack = [start]; seen.add(start);
    while (stack.length) {
      const c = stack.pop(); count += cell.get(c);
      const i = Math.floor(c / 1048576), j = Math.floor(c / 1024) % 1024, k = c % 1024;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) { const nk = key(i + a, j + b, k + d); if (cell.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); } }
    }
    sizes.push(count);
  }
  sizes.sort((a, b) => b - a);
  return `${sizes.length} piece${sizes.length > 1 ? 's' : ''}${sizes.length > 1 ? ` (largest ${Math.round((100 * sizes[0]) / sim.N)}%)` : ''}`;
}
const meanY = (sim, ps) => ps.reduce((a, p) => a + sim.x[p * 3 + 1], 0) / Math.max(1, ps.length);
const meanX = (sim, ps) => ps.reduce((a, p) => a + sim.x[p * 3], 0) / Math.max(1, ps.length);

function press(core, label, props, wet = 0) {
  const run = makeRun(core, label, props);
  settle(run);
  run.sim.wet = wet;
  run.step();
  const top0 = run.surfaceY(0, 0); // the drawn surface under the palm's centre
  const above = new THREE.Vector3(0, top0 + 0.15, 0), down = new THREE.Vector3(0, top0 - 0.04 + 0.012, 0); // palm skin 4 cm under the top
  let pull = 0, tagged = [], base = 0;
  const path = [];
  for (let i = 0; i <= 24; i++) path.push(lerp3(above, down, i / 24)); // 0.4 s down
  for (let i = 0; i < 18; i++) path.push(down); // hold 0.3 s
  const liftFrom = path.length;
  for (let i = 1; i <= 30; i++) path.push(lerp3(down, above, i / 30)); // 0.5 s up
  path.forEach((p, i) => {
    run.step([{ id: 'R', pos: p, quat: palmDown }]);
    if (i === liftFrom - 1) { // the dough right under the palm at the end of the hold
      tagged = under(run.sim, down, 0.06, 0.012 + 0.03);
      base = meanY(run.sim, tagged);
      if (process.env.DEBUG) {
        const rel = [];
        for (let q = 0; q < run.sim.N; q++) { const x = run.sim.x[q * 3], y = run.sim.x[q * 3 + 1], z = run.sim.x[q * 3 + 2]; if (Math.hypot(x - down.x, z - down.z) < 0.06) rel.push(Math.round((y - down.y) * 1000)); }
        rel.sort((a, b) => b - a);
        console.log(`   debug press (wet ${wet}): palm centre y ${down.y.toFixed(3)}; particles within 6 cm horizontally, mm above(+)/below(-) the palm centre: ${rel.slice(0, 30).join(' ')}`);
      }
    }
    if (i >= liftFrom && tagged.length) pull = Math.max(pull, meanY(run.sim, tagged) - base);
  });
  let atHold = 0;
  for (let i = 0; i < 60; i++) run.step();
  const after = run.surfaceY(0, 0);
  return `surface under the palm's centre ${((after - top0) * 100).toFixed(1)} cm from where it was (pressed to -4); the ${tagged.length} particles under the palm followed it up ${(pull * 100).toFixed(1)} cm; ${pieces(run.sim)}`;
}
function drag(core, label, props) {
  const run = makeRun(core, label, props);
  settle(run);
  const top0 = run.near(0.06).top + run.sim.rp;
  const a = new THREE.Vector3(-0.05, top0 - 0.02 + 0.012, 0), b = new THREE.Vector3(0.05, top0 - 0.02 + 0.012, 0);
  for (let i = 0; i <= 12; i++) run.step([{ id: 'R', pos: lerp3(a.clone().setY(top0 + 0.1), a, i / 12), quat: palmDown }]);
  const tagged = under(run.sim, a, 0.06, 0.012 + 0.03), x0 = meanX(run.sim, tagged);
  for (let i = 1; i <= 30; i++) run.step([{ id: 'R', pos: lerp3(a, b, i / 30), quat: palmDown }]);
  const moved = meanX(run.sim, tagged) - x0;
  for (let i = 1; i <= 20; i++) run.step([{ id: 'R', pos: lerp3(b, b.clone().setY(top0 + 0.15), i / 20), quat: palmDown }]);
  for (let i = 0; i < 60; i++) run.step();
  return `the ${tagged.length} particles under the palm moved ${(moved * 100).toFixed(1)} cm with its 10 cm drag (${((meanX(run.sim, tagged) - x0) * 100).toFixed(1)} cm 1 s after it lifted off); ${pieces(run.sim)}`;
}
function squeeze(core, label, props) {
  const run = makeRun(core, label, props);
  settle(run);
  const top0 = run.near(0.06).top + run.sim.rp;
  // each hand's palm skin starts at the dough's side (found from the particles at mid-height) and squeezes 2 cm in
  let side = 0;
  for (let p = 0; p < run.sim.N; p++) if (Math.abs(run.sim.x[p * 3 + 1] - (top0 - 0.05)) < 0.03) side = Math.max(side, Math.abs(run.sim.x[p * 3 + 2]));
  side += run.sim.rp;
  const y = top0 - 0.05;
  const hand = (sgn, zs, dy) => ({ id: sgn > 0 ? 'L' : 'R', pos: new THREE.Vector3(0, y + dy, sgn * (zs + 0.012)), quat: palmToward(sgn) });
  for (let i = 0; i <= 15; i++) { const zs = side + 0.06 - (0.06 + 0.02) * (i / 15); run.step([hand(1, zs, 0), hand(-1, zs, 0)]); } // in and squeeze
  if (process.env.DEBUG) console.log(`   debug squeeze after closing: bonds touching ${[...run.sim.bonds.values()].filter((v) => v.touching).length} of ${run.sim.bonds.size}, holding ${[...run.sim.bonds.values()].filter((v) => !v.released).length}`);
  const y0 = Float64Array.from({ length: run.sim.N }, (_, p) => run.sim.x[p * 3 + 1]);
  const risen = () => { let k = 0; for (let p = 0; p < run.sim.N; p++) if (run.sim.x[p * 3 + 1] > y0[p] + 0.06) k++; return k; };
  for (let i = 1; i <= 36; i++) {
    run.step([hand(1, side - 0.02, 0.12 * i / 36), hand(-1, side - 0.02, 0.12 * i / 36)]); // lift 12 cm in 0.6 s
    if (process.env.DEBUG && i % 6 === 0) {
      let rise = 0, nearHands = 0;
      for (let p = 0; p < run.sim.N; p++) { rise = Math.max(rise, run.sim.x[p * 3 + 1] - y0[p]); if (Math.abs(Math.abs(run.sim.x[p * 3 + 2]) - (side - 0.02)) < 0.04 && Math.abs(run.sim.x[p * 3 + 1] - (y + 0.12 * i / 36)) < 0.05) nearHands++; }
      console.log(`   debug lift frame ${i}: stuck ${run.sim.stuck}, nodes following ${run.sim.followed}, highest rise ${(rise * 100).toFixed(1)} cm, particles beside the hands ${nearHands}`);
    }
  }
  const carried = risen();
  if (process.env.DEBUG) {
    const r = Array.from({ length: run.sim.N }, (_, p) => run.sim.x[p * 3 + 1] - y0[p]).sort((a, b) => b - a);
    console.log(`   debug rises after the lift (cm): ${r.slice(0, 20).map((v) => (v * 100).toFixed(1)).join(' ')}`);
  }
  if (process.env.DEBUG) {
    const b = [...run.sim.bonds.entries()].filter(([, v]) => !v.released);
    console.log(`   debug squeeze: side ${side.toFixed(3)}, top0 ${top0.toFixed(3)}, rp ${run.sim.rp.toFixed(4)}, bonds holding ${b.length} of ${run.sim.bonds.size}, touching ${[...run.sim.bonds.values()].filter((v) => v.touching).length}, tackNow ${run.sim.tackNow.toFixed(3)}`);
  }
  for (let i = 0; i < 18; i++) run.step([hand(1, side - 0.02, 0.12), hand(-1, side - 0.02, 0.12)]); // hold up there 0.3 s
  const held = risen();
  for (let i = 1; i <= 15; i++) run.step([hand(1, side + 0.1 * i / 15, 0.12), hand(-1, side + 0.1 * i / 15, 0.12)]); // open the hands
  for (let i = 0; i < 90; i++) run.step();
  const left = risen();
  const pct = (k) => `${((100 * k) / run.sim.N).toFixed(0)}%`;
  return `dough raised 6 cm+ by the 12 cm lift: ${pct(carried)} at its end, ${pct(held)} after holding 0.3 s, ${pct(left)} 1.5 s after the hands open; ${pieces(run.sim)}`;
}

let handMs = 0, handFrames = 0; // simulation cost of frames with hands in play (all runs)
const t0 = performance.now();
const runs = [['now', Core, { tack: Number(process.env.HAND_TACK ?? HAND.tack), friction: Number(process.env.HAND_FRICTION ?? HAND.friction), mould: Number(process.env.HAND_MOULD ?? HAND.mould) }]];
if (process.env.HAND_TACK || process.env.HAND_FRICTION || process.env.HAND_MOULD || process.env.CORE_OPTS) console.log(`tuning: ${JSON.stringify(runs[0][2])}, ${JSON.stringify(EXTRA)}`);
if (process.env.BEFORE_CORE) runs.unshift(['before', await import(new URL(process.env.BEFORE_CORE, `file://${process.cwd()}/`).href), { tack: 0, mould: 0 }]);
console.log(`tier ${tierName}; hand colliders: ${BONES.length} bones per hand`);
for (const [label, core, props] of runs) {
  console.log(`${label.padEnd(7)} press:   ${press(core, label, props)}`);
  console.log(`${label.padEnd(7)} drag:    ${drag(core, label, props)}`);
  console.log(`${label.padEnd(7)} squeeze: ${squeeze(core, label, props)}`);
  console.log(`${label.padEnd(7)} wet:     ${press(core, label, props, 1)}`);
}
console.log(`took ${((performance.now() - t0) / 1000).toFixed(1)} s; frames with hands: ${(handMs / Math.max(1, handFrames)).toFixed(2)} ms each on one core (${handFrames} frames)`);
