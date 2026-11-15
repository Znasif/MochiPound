// Smoke test for the ported MPM dough (src/dough/mpm-core.js), no browser needed:
// drop the dough into the mortar's bowl, let it settle, strike it three times with the mallet head,
// fold it with a hand. Checks for NaNs and escaped particles, and prints timing per 60 Hz frame.
// The mortar is the scene's own (src/props.js, at the origin), and "in wood" reports how far the
// surface dough.js would draw (three's MarchingCubes on the same grid) reaches into its wood.
import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { DoughSim, TIERS, tierOptions, pickTier } from '../src/dough/mpm-core.js';
import { makeUsu, usuShape } from '../src/props.js';
import { usuSdf } from '../src/usuShape.js';

const plain = new THREE.MeshBasicMaterial();
const USU = usuShape(makeUsu({ radius: 0.42, height: 0.7 }, { side: plain, top: plain, band: plain, mat: plain }));
const FLOOR = USU.poly[USU.poly.length - 1][1]; // the bowl's lowest point (on the axis)
// the lowest the head (vertical, radius 0.1, half-height 0.16) can go with its face off-centre by `off`
// before it touches the wood, as kineContact allows: the bowl rises outward, so the face's far edge binds
function headLow(off = 0) {
  let lo = FLOOR, hi = USU.top;
  for (let k = 0; k < 60; k++) { const m = 0.5 * (lo + hi); if (usuSdf(USU, off + 0.1, m, 0) >= 0) hi = m; else lo = m; }
  return hi + 0.16;
}
// the start-up timing probe the browser's worker runs first (it calls substep without step: a crash here
// leaves the scene with no dough at all)
{ const pick = pickTier(USU, 0.14, 11); console.log(`start-up probe: picks "${TIERS[pick.tier].name}" here (${(pick.msPerParticleSubstep * 1000).toFixed(2)} us per particle-substep)`); }
// optional quality tier by name: node scripts/test-dough.mjs tiny
const tier = TIERS.find((t) => t.name === process.argv[2]);
let sim = new DoughSim(tier ? tierOptions(tier, { usu: USU }) : { usu: USU });
if (tier) console.log(`tier: ${tier.name}`);
const field = new Float32Array(sim.n3);
const FRAME = 1 / 60;
const ISO = 0.5; // dough.js draws the surface at this density (mc.isolation)
const q0 = [0, 0, 0, 1];
let frames = 0, worst = 0, total = 0;

function frame(tools = [], label = '') {
  const t0 = performance.now();
  sim.step(FRAME, tools);
  const s = sim.writeField(field, { x: 0, z: 0, r: 0.1 });
  shape(s);
  const ms = performance.now() - t0;
  frames++; total += ms; worst = Math.max(worst, ms);
  for (let i = 0; i < sim.N * 3; i++) if (!Number.isFinite(sim.x[i])) throw new Error(`NaN in positions at frame ${frames} (${label})`);
  return s;
}
// height at the centre (highest particle within 4 cm of the axis) and spread (95th percentile radius)
function shape(s) {
  let ct = -1, r = [];
  for (let p = 0; p < sim.N; p++) {
    const x = sim.x[p * 3], y = sim.x[p * 3 + 1], z = sim.x[p * 3 + 2], d = Math.hypot(x, z);
    if (d < 0.04 && y > ct) ct = y;
    r.push(d);
  }
  r.sort((a, b) => a - b);
  s.centreTop = ct; s.spread = r[Math.floor(r.length * 0.95)] ?? 0;
}
// separate blobs: particles binned into cells of one grid spacing, joined across touching cells
// (26-neighbourhood, i.e. within the MPM kernel's reach). Returns the count and the largest blob's share.
function pieces() {
  const cell = new Map(), key = (i, j, k) => (i * 1024 + j) * 1024 + k;
  for (let p = 0; p < sim.N; p++) {
    const k = key(Math.floor((sim.x[p * 3] + 2) / sim.dx), Math.floor((sim.x[p * 3 + 1] + 2) / sim.dx), Math.floor((sim.x[p * 3 + 2] + 2) / sim.dx));
    cell.set(k, (cell.get(k) ?? 0) + 1);
  }
  const seen = new Set(), sizes = [];
  for (const start of cell.keys()) {
    if (seen.has(start)) continue;
    let count = 0; const stack = [start]; seen.add(start);
    while (stack.length) {
      const c = stack.pop(); count += cell.get(c);
      const i = Math.floor(c / 1048576), j = Math.floor(c / 1024) % 1024, k = c % 1024;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
        const nk = key(i + a, j + b, k + d);
        if (cell.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
      }
    }
    sizes.push(count);
  }
  sizes.sort((a, b) => b - a);
  return { count: sizes.length, largest: sizes[0] / Math.max(1, sim.N) };
}
// separate blobs in the drawn surface: field nodes at or above the renderer's isolation level, joined
// across touching nodes (26-neighbourhood). This is what the player sees, even when the particles are
// still within reach of each other.
function visiblePieces(fld, iso = ISO) {
  const n = sim.n, n2 = n * n, seen = new Uint8Array(fld.length);
  let count = 0, largest = 0, total = 0;
  for (let id = 0; id < fld.length; id++) {
    if (fld[id] < iso || seen[id]) continue;
    count++;
    let size = 0; const stack = [id]; seen[id] = 1;
    while (stack.length) {
      const c = stack.pop(); size++;
      const i = c % n, j = Math.floor(c / n) % n, k = Math.floor(c / n2);
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let d = -1; d <= 1; d++) {
        const ii = i + a, jj = j + b, kk = k + d;
        if (ii < 0 || jj < 0 || kk < 0 || ii >= n || jj >= n || kk >= n) continue;
        const nid = ii + jj * n + kk * n2;
        if (!seen[nid] && fld[nid] >= iso) { seen[nid] = 1; stack.push(nid); }
      }
    }
    largest = Math.max(largest, size); total += size;
  }
  return { count, largest: largest / Math.max(1, total) };
}
// how far the drawn surface reaches into the wood: deepest vertex, and the share of its vertices more
// than 5 mm in (they're hidden by the wood, so the dough looks sunk into the bowl by that much)
const mcs = new Map();
function inWood(h, f) {
  let mc = mcs.get(h.n);
  if (!mc) {
    mc = new MarchingCubes(h.n, plain, true, false, 12000);
    mc.isolation = ISO;
    const size = h.n * h.dx;
    mc.position.set(h.min[0] + size / 2, h.min[1] + size / 2, h.min[2] + size / 2);
    mc.scale.setScalar(size / 2);
    mcs.set(h.n, mc);
  }
  mc.field = f; mc.normal_cache.fill(0); mc.update();
  const a = mc.positionArray, ps = mc.position, sc = mc.scale.x;
  let deepest = 0, over = 0;
  for (let i = 0; i < mc.count; i++) {
    const d = -usuSdf(USU, ps.x + a[i * 3] * sc, ps.y + a[i * 3 + 1] * sc, ps.z + a[i * 3 + 2] * sc);
    if (d > deepest) deepest = d;
    if (d > 0.005) over++;
  }
  return { deepest, share: over / Math.max(1, mc.count) };
}
const woodText = (w) => `in wood ${(w.deepest * 100).toFixed(1)} cm (${(w.share * 100).toFixed(0)}% > 5 mm)`;
function report(label, s) {
  const pc = pieces(), vp = visiblePieces(field);
  console.log(`${label.padEnd(26)} t=${s.time.toFixed(2)}s  top=${s.topY?.toFixed(3)}  centreTop=${s.centreTop.toFixed(3)}  spread=${s.spread.toFixed(3)}  cohesion=${s.cohesion.toFixed(2)}${s.pull != null ? `  pulled up to ${s.pull.toFixed(3)}` : ''}  maxSpeed=${s.maxSpeed.toFixed(2)}  pieces=${pc.count} (largest ${(pc.largest * 100).toFixed(0)}%)  drawn=${vp.count} (largest ${(vp.largest * 100).toFixed(0)}%)  ${woodText(inWood(sim, field))}`);
}

sim.spawnSphere([0.05, 1.06, -0.03], 0.14, [0, -2.2, 0]);
console.log(`particles: ${sim.N}`);
let s;
let landed = null;
for (let i = 0; i < 120; i++) {
  s = frame([], 'drop');
  if (landed === null && i > 3 && s.meanVy > -0.3) landed = s.time;
}
report('after drop + settle (2 s)', s);
console.log(`landed (meanVy > -0.3) at t=${landed?.toFixed(2)}s`);
// slump: does the mound hold its shape while it just sits?
{
  const h0 = s.centreTop, w0 = s.spread;
  for (let i = 0; i < 360; i++) s = frame([], 'rest');
  report('after resting 6 s more', s);
  console.log(`slump over 6 s: centre height ${((h0 - s.centreTop) * 100).toFixed(1)} cm lower, spread ${((s.spread - w0) * 100).toFixed(1)} cm wider`);
}
const restTop = s.topY;

// three strikes: the head (r 0.1, half-height 0.16, axis vertical) comes down onto the dough and back up
for (let k = 0; k < 3; k++) {
  const top = s.topY;
  const bottomCentre = Math.max(top + 0.16 - 0.08, headLow()); // head centre at the deepest point (as the scene poses it; the wood stops it)
  const path = [];
  for (let i = 0; i <= 11; i++) path.push(1.25 - (1.25 - bottomCentre) * (i / 11) ** 2); // ~0.18 s accelerating down
  for (let i = 0; i < 6; i++) path.push(bottomCentre); // rest
  for (let i = 1; i <= 30; i++) path.push(bottomCentre + (1.25 - bottomCentre) * (i / 30)); // lift
  let prev = [0, path[0], 0], pull = 0, i = 0;
  for (const y of path) {
    const now = [0, y, 0];
    s = frame([{ kind: 'cylinder', r: 0.1, h: 0.16, c0: prev, c1: now, q0, q1: q0 }], `strike ${k + 1}`);
    if (i++ > 17) for (let p = 0; p < sim.N; p++) if (Math.hypot(sim.x[p * 3], sim.x[p * 3 + 2]) < 0.12) pull = Math.max(pull, sim.x[p * 3 + 1]); // lift phase only
    prev = now;
  }
  s.pull = pull;
  sim.progress = Math.min(1, sim.progress + 1 / 22);
  report(`after strike ${k + 1}${sim.wet ? ' (wet)' : ''}`, s);
  if (k === 1) sim.wet = 1; // the turner dips before the third strike: compare the pull
}

// one fold: a hand sweeps in from the side, presses and pulls back
{
  const pts = [];
  for (let i = 0; i <= 20; i++) { const u = i / 20; pts.push([-0.35 + 0.3 * u, s.topY - 0.02, -0.05]); }
  for (let i = 0; i <= 20; i++) { const u = i / 20; pts.push([-0.05 - 0.3 * u, s.topY + 0.1 * u, -0.05]); }
  let prev = pts[0];
  for (const p of pts) { s = frame([{ kind: 'sphere', r: 0.045, c0: prev, c1: p, q0, q1: q0 }], 'fold'); prev = p; }
  report('after a fold', s);
}
for (let i = 0; i < 60; i++) s = frame([], 'settle');
report('settled again (1 s)', s);

// stickiness: tag the dough touching the mallet face at the bottom of the strike, then see how far
// it is dragged up as the mallet lifts (early grains vs late dough, dry vs wet)
function stickStrike(label, prog, wet) {
  sim.progress = prog; sim.wet = wet;
  for (let f = 0; f < 20; f++) s = frame([], 'settle');
  const top = s.topY ?? 0.65, bottom = Math.max(top + 0.16 - 0.08, headLow()), face = bottom - 0.16;
  let prev = [0, 1.25, 0], tagged = null, base = 0, lift = 0;
  for (let f = 0; f <= 47; f++) {
    const y = f <= 11 ? 1.25 - (1.25 - bottom) * (f / 11) ** 2 : f <= 17 ? bottom : bottom + (1.25 - bottom) * ((f - 17) / 30);
    s = frame([{ kind: 'cylinder', r: 0.1, h: 0.16, c0: prev, c1: [0, y, 0], q0, q1: q0 }], label);
    prev = [0, y, 0];
    if (f === 17) {
      tagged = [];
      for (let p = 0; p < sim.N; p++) if (Math.hypot(sim.x[p * 3], sim.x[p * 3 + 2]) < 0.08 && sim.x[p * 3 + 1] > face - 0.03 && sim.x[p * 3 + 1] < face + 0.01) tagged.push(p);
      base = tagged.reduce((a, p) => a + sim.x[p * 3 + 1], 0) / Math.max(1, tagged.length);
    } else if (tagged?.length) {
      const m = tagged.reduce((a, p) => a + sim.x[p * 3 + 1], 0) / tagged.length;
      lift = Math.max(lift, m - base);
    }
  }
  for (let f = 0; f < 30; f++) s = frame([], 'settle');
  console.log(`${('stick: ' + label).padEnd(26)} cohesion=${s.cohesion.toFixed(2)}  ${tagged?.length ?? 0} particles under the face dragged up ${(lift * 100).toFixed(1)} cm, crater floor now ${s.centreTop.toFixed(3)}`);
}
stickStrike('early, dry', 0.0, 0);
stickStrike('late, dry', 0.9, 0);
stickStrike('late, wet', 0.9, 1);

// hard manual hits: a 0.05 s swing (the desktop swing in rhythm mode, or a fast VR swing) at ~10 m/s.
// Run on fresh dough twice: without and with the tool and dough speed limits, the head driven down until
// it touches the wood (kineContact's exact collision stops it there), `gap` above that.
function hardHits(label, extra, gap) {
  const h = new DoughSim(tier ? tierOptions(tier, { usu: USU, ...extra }) : { usu: USU, ...extra });
  const f = new Float32Array(h.n3);
  h.spawnSphere([0.05, 1.06, -0.03], 0.14, [0, -2.2, 0]);
  let st = null;
  for (let i = 0; i < 120; i++) { h.step(FRAME, []); st = h.writeField(f, { x: 0, z: 0, r: 0.1 }); }
  const bottom = headLow() + gap; // head centre at the deepest point
  let fastest = 0, deepest = 0;
  for (let k = 0; k < 3; k++) {
    const path = [1.25, 1.25 - (1.25 - bottom) / 3, 1.25 - (2 * (1.25 - bottom)) / 3, bottom]; // 3 frames down
    for (let i = 0; i < 6; i++) path.push(bottom);
    for (let i = 1; i <= 15; i++) path.push(bottom + (1.25 - bottom) * (i / 15));
    for (let i = 0; i < 20; i++) path.push(1.25);
    let prev = [0, path[0], 0];
    for (const y of path) {
      h.step(FRAME, [{ kind: 'cylinder', r: 0.1, h: 0.16, c0: prev, c1: [0, y, 0], q0, q1: q0 }]);
      st = h.writeField(f, { x: 0, z: 0, r: 0.1 });
      fastest = Math.max(fastest, st.maxSpeed);
      deepest = Math.max(deepest, inWood(h, f).deepest);
      prev = [0, y, 0];
    }
  }
  const saved = sim;
  sim = h; const pc = pieces(), vp = visiblePieces(f); sim = saved;
  console.log(`${('hard hits: ' + label).padEnd(26)} pieces=${pc.count} (largest ${(pc.largest * 100).toFixed(0)}%)  drawn=${vp.count} (largest ${(vp.largest * 100).toFixed(0)}%)  fastest dough ${fastest.toFixed(1)} m/s  drawn surface in wood at worst ${(deepest * 100).toFixed(1)} cm`);
}
// VR-like swings, as on the Quest: the head tilted along the swing, coming in at an angle, off centre,
// and sweeping sideways through the dough; `slow` < 1 is a device that can't keep up (the dough steps
// less simulated time than the mallet moved in, as dough.js caps each step)
function vrSwings(label, slow) {
  const h = new DoughSim(tier ? tierOptions(tier, { usu: USU }) : { usu: USU });
  const f = new Float32Array(h.n3);
  h.spawnSphere([0.05, 1.06, -0.03], 0.14, [0, -2.2, 0]);
  for (let i = 0; i < 120; i++) { h.step(FRAME, []); h.writeField(f, { x: 0, z: 0, r: 0.1 }); }
  const tilt = (deg) => { const a = (deg * Math.PI) / 360; return [0, 0, Math.sin(a), Math.cos(a)]; }; // about z
  const run = (path) => {
    let prev = path[0];
    for (const p of path) { step(FRAME * slow, [{ kind: 'cylinder', r: 0.1, h: 0.16, c0: prev.c, c1: p.c, q0: prev.q, q1: p.q }]); prev = p; }
  };
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const seg = (a, b, frames, qa, qb) => Array.from({ length: frames + 1 }, (_, i) => ({ c: lerp3(a, b, i / frames), q: i / frames < 0.5 ? qa : qb }));
  const low = headLow(); // the head touching the bowl's floor
  const out = [];
  let deepest = 0;
  const step = (dt, tools) => { h.step(dt, tools); h.writeField(f, { x: 0, z: 0, r: 0.1 }); deepest = Math.max(deepest, inWood(h, f).deepest); };
  // 1. angled swing from up and to the side, head tilted 35 deg, down to the deepest allowed point in 4 frames
  run([...seg([0.55, 1.15, 0], [0.08, low + 0.02, 0], 4, tilt(-35), tilt(-15)), ...seg([0.08, low + 0.02, 0], [0.08, low + 0.02, 0], 6, tilt(-15), tilt(-15)), ...seg([0.08, low + 0.02, 0], [0.5, 1.2, 0], 15, tilt(-15), tilt(-35))]);
  out.push(['angled', visible(h, f)]);
  // 2. off-centre strike next to the bowl wall
  run([...seg([0.17, 1.2, 0.05], [0.17, low + 0.05, 0.05], 3, tilt(0), tilt(0)), ...seg([0.17, low + 0.05, 0.05], [0.17, low + 0.05, 0.05], 6, tilt(0), tilt(0)), ...seg([0.17, low + 0.05, 0.05], [0.17, 1.2, 0.05], 15, tilt(0), tilt(0))]);
  out.push(['near the wall', visible(h, f)]);
  // 3. sideways sweep through the middle of the dough and back (~3.5 m/s)
  const mid = low + 0.05;
  run([...seg([-0.25, mid, 0], [0.25, mid, 0], 9, tilt(10), tilt(10)), ...seg([0.25, mid, 0], [-0.25, mid, 0], 9, tilt(-10), tilt(-10)), ...seg([-0.25, mid, 0], [-0.25, 1.2, 0], 15, tilt(0), tilt(0))]);
  out.push(['sideways sweep', visible(h, f)]);
  for (let i = 0; i < 60; i++) step(FRAME * slow, []);
  out.push(['1 s later', visible(h, f)]);
  console.log(`${('VR swings: ' + label).padEnd(26)} ` + out.map(([k, v]) => `${k}: ${v}`).join('  ') + `  drawn surface in wood at worst ${(deepest * 100).toFixed(1)} cm`);
}
function visible(h, f) {
  const saved = sim; sim = h; const pc = pieces(), vp = visiblePieces(f); sim = saved;
  return `pieces ${pc.count}, drawn ${vp.count} (${(vp.largest * 100).toFixed(0)}%)`;
}
vrSwings('real time', 1);
vrSwings('Quest slow motion', 0.6);
hardHits('no speed limits', { maxToolSpeed: 1e9, maxDoughSpeed: 1e9 }, 0);
hardHits('speed limits', {}, 0);

let escaped = 0;
for (let p = 0; p < sim.N; p++) { const y = sim.x[p * 3 + 1]; if (y < 0.5) escaped++; }
const filled = field.reduce((a, v) => a + (v > 0.5 ? 1 : 0), 0);
let inside = 0, worstCube = 0;
for (let p = 0; p < sim.N; p++) { const d = sim.rp - usuSdf(USU, sim.x[p * 3], sim.x[p * 3 + 1], sim.x[p * 3 + 2]); if (d > 1e-4) inside++; worstCube = Math.max(worstCube, d); }
console.log(`rest top ${restTop?.toFixed(3)} -> final top ${s.topY?.toFixed(3)} (rim at ${USU.top.toFixed(3)}, bowl bottom ${FLOOR.toFixed(3)})`);
console.log(`particles below the bowl bottom: ${escaped} of ${sim.N}; field cells above the surface level: ${filled}`);
console.log(`particles whose cube of dough (half-width ${(sim.rp * 100).toFixed(2)} cm) reaches into the wood by > 0.1 mm: ${inside} (deepest ${(Math.max(0, worstCube) * 1000).toFixed(2)} mm)`);
console.log(`${frames} frames of 1/60 s: mean ${(total / frames).toFixed(1)} ms, worst ${worst.toFixed(1)} ms per frame (one CPU core)`);
