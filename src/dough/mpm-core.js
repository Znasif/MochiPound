// Elastoplastic dough with MLS-MPM, ported to JavaScript from VR-Doh
// (Luo, Cui, Luo, Chu, Li, "VR-Doh: Hands-on 3D Modeling in Virtual Reality", ACM TOG / SIGGRAPH 2025;
// https://github.com/Simulation-Intelligence/VR-Doh, Apache-2.0). Source kernels, all in
// scripts/mpm3D_gaussian_part.kernel.py, in the order Mpm3DMarching.cs runs them each substep:
//   substep_reset_grid -> substep_p2g_multi (F update + Neo-Hookean stress) -> substep_update_grid_v_lerp
//   (gravity, damping, "standard MPM boundary" against tool SDFs, sticky box walls, CFL clamp)
//   -> substep_g2p -> substep_apply_plasticity (von Mises return mapping on log strain),
// plus substep_adjust_particle (particles inside a tool are pushed to its surface and take its velocity).
// VR-Doh runs this on the GPU in a unit cube, ~1-2 ms of simulated time per rendered frame; here it
// runs on the CPU in metres and in real time, so the grid, particle count and constants are retuned
// (see DEFAULTS). Changes from the original are marked "port:".
//
// Material (2026-11-14 rework, after the user found the dough too runny and breaking into pieces):
// always one cohesive dough. Neo-Hookean elasticity with mochi's measured softness (shear modulus
// ~1.4 kPa; fresh mochi measures 0.3-3 kPa) and nearly incompressible, plus Herschel-Bulkley
// viscoplasticity: below the yield stress it is an elastic solid, above it it flows at
// ((stress - yield) / flowK)^(1/flowN), shear-thinning like wheat dough (exponent 0.2-0.3). Its own
// weight, just over the yield, only lets it creep; a mallet strike, far over it, makes it flow at once.
// Two deliberately non-physical parts follow the Unity team's native solver (MochiPound unity6-upgrade,
// MochiSolver.compute): tack (a dry mallet pressed into the dough bonds to it; while it pulls away the
// dough within pullReach follows it with a falloff, drawing a tent, and the bond lets go after tackTime
// of pulling) and stray braking (particles left in sparse dough are slowed and drawn back to the lump,
// so torn-off specks rejoin instead of flying around).
//
// The mortar is the exact shape drawn in the scene (src/usuShape.js, read from the meshes in src/props.js,
// the same one the mallet collides with). Each particle stands for a cube of dough around it, and the
// surface dough.js draws (density 0.5) runs along the outside of those cubes, so particle centres are
// kept half a cube's width (rp) from the wood: the drawn dough then meets the wood instead of sinking
// into it (by 1.6 cm on the headset's tier when the centres were allowed onto the wood).
//
// Plain JS with no three.js, so it runs in a Web Worker and in Node tests.
import { usuSdf as shapeSdf } from '../usuShape.js';

export const DEFAULTS = {
  n: 36, dx: 0.025, boxMin: [-0.45, 0.42, -0.45], // 0.9 m box around the mortar's bowl
  ppc: 4,              // particles per cell when spawning (VR-Doh scene: 8)
  rho: 1100,           // kg/m^3, dough (VR-Doh: 1000)
  E: 4e3,              // Pa, Young's modulus: shear modulus E / 2(1 + nu) ~ 1.4 kPa (fresh mochi: 0.3-3 kPa)
  nu: 0.4,             // nearly incompressible: mochi keeps its volume (VR-Doh's default: 0.3)
  // viscoplastic flow (Herschel-Bulkley), on |dev tau| (Kirchhoff stress, Pa)
  yieldStress: [800, 550], // Pa, from just-steamed rice (stiff, lumpy) to kneaded mochi (smooth, flowing); a
                       // 10 cm mound's own weight is near this, so it holds its shape and creeps
  flowK: 300,          // Pa s^n, consistency
  flowN: 0.3,          // flow exponent: < 1 is shear-thinning (wheat dough measures 0.2-0.3)
  damping: 6,          // 1/s, grid velocity damping (VR-Doh: 200 with 1 ms frames)
  gravity: -9.8,
  maxDt: 3.6e-3,       // s, 0.4 cell per elastic wave crossing for this E, nu and dx (c ~ 2.8 m/s)
  maxSubsteps: 8,      // a step never simulates more than maxSubsteps * maxDt; a slow machine gets slow motion
  cfl: 0.5,            // VR-Doh allowed_cfl
  bound: 3,            // sticky wall cells (VR-Doh bound)
  maxParticles: 9000,
  // kneading: how worked each particle is (0 = just-steamed rice, 1 = smooth mochi). It sets the yield
  // stress, the tack and the look; the dough is cohesive throughout (no loose-grain phase any more)
  workToDough: 4.0,    // accumulated fast plastic shear that makes a particle fully kneaded (many strikes)
  baseCohesion: 0.15,  // where a fresh particle starts
  workRateFloor: 3,    // 1/s: plastic shear slower than this (creeping under gravity) doesn't knead
  // tack (not physical; the Unity team's recipe): a dry tool pressed into the dough bonds to it. While it
  // pulls away, dough within pullReach follows with velocity tool velocity * (1 - d / pullReach), drawing
  // the lump up into a tent; after tackTime of pulling every bond lets go together and the tent falls back
  tackTime: 0.15,      // s, dry mallet on kneaded mochi (less on fresh rice, none when wet)
  pullReach: 0.08,     // m
  pullGain: 0.8,       // share of the follow velocity the dough takes per 3 ms
  // stray specks: particles in sparse dough (squeezed out, torn off) are braked toward the lump's
  // motion and drawn back to it, so they rejoin instead of flying around
  strayDensity: 0.35,  // fraction of a full cell below which a particle counts as stray
  strayDrag: 30,       // 1/s
  strayPull: 6,        // m/s^2 toward the lump's centre (2 left specks torn off by VR swings lying around)
  // speed limits (the Unity team's maxToolSpeed / maxDoughSpeed): a hard manual hit (a 0.05 s desktop swing,
  // a fast VR swing) gave the dough the mallet's full speed and threw pieces off it
  maxToolSpeed: 5,     // m/s: the most velocity a tool hands to the dough it touches
  maxDoughSpeed: 2.5,  // m/s: no particle moves faster than this relative to the lump as a whole
  // one body (2026-11-15: the user never wants the dough to come apart into blobs, only stretch and fold).
  // MPM particles hold together only through grid nodes they share, so dough stretched thinner than about
  // a cell came apart for good on the headset's coarse grid. Particles closer than linkReach x their
  // lattice spacing are linked. A link that stretches past that is dropped only if its two particles are
  // still joined through short links within linkDepth hops (so the dough can still flow and rearrange);
  // otherwise it is a tether and is held at that length: the dough stretches by drawing more of itself
  // into the strand, and never tears. Dough that touches itself links up, so a fold sticks.
  linkReach: 1.5,      // x the particle lattice spacing: the face and edge neighbours of the spawn lattice
  linkDepth: 8,        // hops (8 x linkReach spans the whole lump)
  // thin dough is drawn thicker: a particle in sparse dough (a stretched strand or sheet: measured density
  // under thinDensity) is splatted up to thinBoost times as heavily, so a strand the links hold together is
  // drawn as a strand instead of vanishing into beads (the surface is drawn at density 0.5)
  thinDensity: 0.42,   // a single sheet of particles measures ~0.35 here, dense dough ~1
  thinBoost: 4,        // enough for a single-file strand at the link reach to show
  // crowding (the Unity team's crowdStiffness, MochiSolver.compute): particles pushed onto a tool's or the
  // wood's surface are moved without their deformation knowing, so a mallet squashing dough onto the bowl
  // floor packed it 2-5x denser than rest while J still read ~1, and it stayed packed. Packed dough is
  // drawn larger than it is (into the wood) and looks shrunk. Measured density above crowdStart pushes back
  // with crowdStiffness * c * (1 + 4c), c = min(1, density - crowdStart), the team's curve
  // hands mould the dough like clay (tools with `mould` 1, src/hands.js). Elsewhere the dough yields only
  // past ~0.2-0.3 strain (so the mound holds up under its own weight), which a gentle press never reaches,
  // so a hand's dent sprang back. Dough within pullReach of a moulding tool that touches the dough stays
  // plastic for mouldHold after, yielding
  // at mouldYield of its yield stress with no flow-rate limit: a shape pressed in by hand stays. And while
  // that tool's tack bond holds, the dough in contact with it moves with it in every direction (no slip),
  // and the dough within pullReach follows it with the tack falloff (except dough it presses toward), so
  // it can be dragged, smeared, squeezed and lifted; the bond ages only while the tool pulls straight away
  mouldYield: 0.15,    // 120 Pa just-steamed, 80 Pa kneaded: yield strain ~3-4%, clay-like
  mouldHold: 0.1,      // s
  stickSlack: 0.1,     // x rp: numerical slack on "touching" for the stick (particles pushed out sit at 0)
  // friction (tools with `friction`, the tracked hands since 2026-11-15, when the user wanted an elastic blob
  // that sticks only to itself): dough a hand presses against (touching it at the start of the step and
  // pushing into it) moves with the hand, by friction x (1 - wet) of the way; dough the hand moves away
  // from is let go at once. So a hand can push, roll and squeeze the dough without it slipping out from
  // under the palm, and without the dough sticking to it; wet hands slide
  crowdStart: 1.15,    // rest density = 1 (the team's value)
  crowdStiffness: 2e3, // Pa; the team's 20 kPa is for their solver's step. Here the steepest response (9x this
                       // per unit density) stays ~2x the dough's elastic lambda + 2 mu (8.6 kPa), within the
                       // step's limit (0.4 cell per elastic wave crossing allows ~6x)
};

const I = Math.floor;

// Quality tiers, picked per machine by a short timing probe (mpm.worker.js 'calibrate'): the same
// dough volume on a coarser grid. Box size stays 0.9 m. Four particles per cell everywhere but the last:
// with two, a strike that flattened the dough thinner than about a cell left particles out of touch
// with each other and the dough fell apart into blobs (MPM's numerical fracture).
// Steps are 0.4 of a cell per elastic wave crossing (c ~ 2.8 m/s): as large as stays stable, because on
// the Quest browser every substep counts (fewer substeps there kept the dough out of slow motion).
export const TIERS = [
  { name: 'full', dx: 0.025, ppc: 4, maxDt: 3.6e-3 },     // ~2,940 particles for the 14 cm ball, 5 substeps per 60 Hz frame
  { name: 'medium', dx: 0.028, ppc: 4, maxDt: 4.0e-3 },   // ~2,090, 5
  { name: 'light', dx: 0.031, ppc: 4, maxDt: 4.4e-3 },    // ~1,540, 4
  { name: 'lightest', dx: 0.035, ppc: 4, maxDt: 5.0e-3 }, // ~1,070, 4
  { name: 'minimal', dx: 0.04, ppc: 4, maxDt: 5.7e-3 },   // ~720, 3
  { name: 'tiny', dx: 0.045, ppc: 3, maxDt: 6.4e-3 },     // ~380, 3; what the Quest browser runs
];
export const substepsPerFrame = (tier) => Math.ceil(1 / 60 / tier.maxDt - 1e-9);
// richest tier whose predicted cost per 60 Hz frame fits the budget, given a measured cost
export function tierForCost(msPerParticleSubstep, radius, budgetMs) {
  for (let i = 0; i < TIERS.length; i++) {
    if (msPerParticleSubstep * particlesFor(TIERS[i], radius) * substepsPerFrame(TIERS[i]) <= budgetMs) return i;
  }
  return TIERS.length - 1;
}
export function tierOptions(tier, extra = {}) {
  const n = Math.round(0.9 / tier.dx);
  return { ...DEFAULTS, ...extra, n, dx: tier.dx, ppc: tier.ppc, maxDt: tier.maxDt, tier: tier.name };
}
// Time a probe dough (warmed up so the JIT has compiled the hot loops), then pick the richest tier
// whose predicted simulation cost per 60 Hz frame fits `budgetMs`. Runs in the worker at start.
export function pickTier(usu, radius, budgetMs = 11, now = () => performance.now()) {
  const probe = new DoughSim(tierOptions(TIERS[1], { usu }));
  probe.spawnSphere([usu.x, usu.top + 0.02, usu.z], radius, [0, -0.5, 0]); // in the bowl: contact and plasticity count
  const dt = TIERS[1].maxDt;
  for (let i = 0; i < 12; i++) probe.substep(dt);
  const t0 = now();
  let k = 0;
  while (k < 40 && now() - t0 < 150) { probe.substep(dt); k++; }
  const msPerParticleSubstep = (now() - t0) / (k * probe.N);
  return { tier: tierForCost(msPerParticleSubstep, radius, budgetMs), msPerParticleSubstep };
}

// particles a sphere of `radius` gets at this tier (spawnSphere's lattice)
export function particlesFor(tier, radius) {
  return Math.round(((4 / 3) * Math.PI * radius ** 3 / tier.dx ** 3) * tier.ppc);
}

export class DoughSim {
  constructor(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.o = o;
    this.n = o.n; this.dx = o.dx; this.inv = 1 / o.dx;
    this.min = o.boxMin.slice();
    this.max = this.min.map((m) => m + o.n * o.dx);
    this.n2 = o.n * o.n; this.n3 = this.n2 * o.n;
    this.vol = o.dx ** 3 / o.ppc;
    this.mass = o.rho * this.vol;
    this.mu = o.E / (2 * (1 + o.nu));
    this.la = (o.E * o.nu) / ((1 + o.nu) * (1 - 2 * o.nu));
    const P = o.maxParticles;
    this.x = new Float64Array(P * 3); this.v = new Float64Array(P * 3);
    this.C = new Float64Array(P * 9); this.F = new Float64Array(P * 9);
    this.work = new Float32Array(P); // accumulated plastic strain: how much each particle has been worked
    this.dens = new Float32Array(P); // density at the particle measured in the last G2P (1 = rest), for crowding
    this.mouldT = new Float32Array(P); // s left of being mouldable (touched by a hand)
    this.gv = new Float64Array(this.n3 * 3); this.gm = new Float64Array(this.n3);
    this.N = 0;
    this.progress = 0;
    this.usu = o.usu ?? null; // the mortar's exact shape (src/usuShape.js), or none
    this.rp = 0.5 * Math.cbrt(this.vol); // half the side of the cube of dough each particle stands for
    this.solidSdf = new Float32Array(this.n3);
    this.solidN = new Float32Array(this.n3 * 3);
    this.bakeSolid();
    this.tools = [];
    this.groups = []; // tools grouped for a shared bounding check (setTools); empty until the first step
    // links (one body, see DEFAULTS.linkReach): pairs a < b in linkA/linkB, their keys in linkSet; tethers
    // are the links holding the dough together that are stretched past the reach
    this.linkR = o.linkReach * Math.cbrt(this.vol);
    this.linkA = new Int32Array(1024); this.linkB = new Int32Array(1024); this.nLinks = 0;
    this.linkSet = new Set();
    this.tethers = new Int32Array(256); this.nTethers = 0;
    this.bonds = new Map(); // tool id -> its tack bond { left (s), released, touching, n (tool -> dough) }, kept across steps
    this.parity = 0;
    this.checkDt = 0;
    this.cohFloor = 0; // every particle is at least this kneaded (rises with the batch's progress)
    this.wet = 0;      // 0..1, set by the turner's water dip; takes the tack away
    this.tackNow = 0;  // tack seconds for a fully sticky tool this step
    this.pullDt = 0;   // share of the follow velocity per substep
    this.meanCohesion = o.baseCohesion; // refreshed by writeField each step
    this.centre = [0, 0, 0]; // the lump's centre and mean velocity, refreshed by writeField (stray pull-back)
    this.meanV = [0, 0, 0];
    this.active = [0, 0, 0, 0, 0, 0];
    this.time = 0;
  }

  // ---------- the mortar (exact, src/usuShape.js) ----------
  // signed distance from the wood (m); writes the outward normal into n if given
  usuSdf(px, py, pz, n) { return this.usu ? shapeSdf(this.usu, px, py, pz, n) : 1e9; }
  // exact distance and normal at every grid node, for the grid's wood boundary and a cheap filter
  bakeSolid() {
    const { n, dx, min } = this;
    const nrm = [0, 0, 0];
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const id = i + j * n + k * this.n2;
      this.solidSdf[id] = this.usuSdf(min[0] + i * dx, min[1] + j * dx, min[2] + k * dx, nrm);
      this.solidN[id * 3] = nrm[0]; this.solidN[id * 3 + 1] = nrm[1]; this.solidN[id * 3 + 2] = nrm[2];
    }
  }

  // ---------- particles ----------
  clear() { this.N = 0; this.meanCohesion = this.o.baseCohesion; this.bonds.clear(); this.nLinks = 0; this.linkSet.clear(); this.nTethers = 0; }
  // how kneaded a particle is: 0 just-steamed rice .. 1 smooth mochi
  cohesionOf(p) { const o = this.o; return Math.min(1, Math.max(this.cohFloor, o.baseCohesion, this.work[p] / o.workToDough)); }
  spawnSphere(center, radius, velocity = [0, 0, 0]) {
    if (this.N === 0) { this.centre = center.slice(); this.meanV = velocity.slice(); }
    const s = this.dx / Math.cbrt(this.o.ppc);
    const lo = this.min.map((m) => m + (this.o.bound + 0.5) * this.dx), hi = this.max.map((m) => m - (this.o.bound + 0.5) * this.dx);
    let seed = 1234567;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) - 0.5;
    for (let gz = -radius; gz <= radius; gz += s) for (let gy = -radius; gy <= radius; gy += s) for (let gx = -radius; gx <= radius; gx += s) {
      const ox = gx + rnd() * s * 0.6, oy = gy + rnd() * s * 0.6, oz = gz + rnd() * s * 0.6;
      if (ox * ox + oy * oy + oz * oz > radius * radius || this.N >= this.o.maxParticles) continue;
      const p = this.N++;
      this.x[p * 3] = Math.min(hi[0], Math.max(lo[0], center[0] + ox));
      this.x[p * 3 + 1] = Math.min(hi[1], Math.max(lo[1], center[1] + oy));
      this.x[p * 3 + 2] = Math.min(hi[2], Math.max(lo[2], center[2] + oz));
      this.v[p * 3] = velocity[0]; this.v[p * 3 + 1] = velocity[1]; this.v[p * 3 + 2] = velocity[2];
      this.C.fill(0, p * 9, p * 9 + 9);
      this.work[p] = 0;
      this.dens[p] = 0;
      this.mouldT[p] = 0;
      const F = this.F; F.fill(0, p * 9, p * 9 + 9); F[p * 9] = F[p * 9 + 4] = F[p * 9 + 8] = 1;
    }
  }

  // ---------- tools: kinematic SDF shapes with velocities ----------
  // tool: { id, kind: 'sphere' | 'cylinder', r, h (cylinder half-height), c0, c1 (centres at the start and
  // end of the step), q0, q1 (quaternions xyzw; cylinder axis = local Y), tack (0 slides off, 1 sticks;
  // default: the mallet sticks, hands don't) } — interpolated through the substeps.
  setTools(tools, T) {
    this.tools = tools.map((t, q) => {
      const lin = [(t.c1[0] - t.c0[0]) / T, (t.c1[1] - t.c0[1]) / T, (t.c1[2] - t.c0[2]) / T];
      let w = [0, 0, 0];
      if (t.kind === 'cylinder') w = angularVelocity(t.q0, t.q1, T);
      const id = t.id ?? q;
      let bond = this.bonds.get(id);
      if (!bond) { bond = { left: 0, released: true, touching: false, n: [0, -1, 0], press: 0, pull: 0 }; this.bonds.set(id, bond); }
      return {
        ...t, id, tack: t.tack ?? (t.kind === 'cylinder' ? 1 : 0), mould: t.mould ?? 0, friction: t.friction ?? 0, bond, pulling: false, touchN: 0, nAcc: [0, 0, 0],
        lin, w, c: t.c0.slice(), R: new Float64Array(9), reach: t.kind === 'cylinder' ? Math.sqrt(t.r * t.r + t.h * t.h) : t.r,
      };
    });
    // tools that share a `group` (one hand's bones) are skipped together when a point is far from all of
    // them: one bounding sphere per group (posed each substep) instead of a check per bone
    const byKey = new Map();
    this.groups = [];
    for (const t of this.tools) {
      const key = t.group ?? `\u0000${t.id}`;
      let g = byKey.get(key);
      if (!g) { g = { tools: [], c: [0, 0, 0], r: 0 }; byKey.set(key, g); this.groups.push(g); }
      g.tools.push(t);
    }
  }
  poseTools(s) {
    for (const t of this.tools) {
      t.c[0] = t.c0[0] + (t.c1[0] - t.c0[0]) * s; t.c[1] = t.c0[1] + (t.c1[1] - t.c0[1]) * s; t.c[2] = t.c0[2] + (t.c1[2] - t.c0[2]) * s;
      if (t.kind === 'cylinder') quatToMat(nlerp(t.q0, t.q1, s), t.R);
    }
    for (const g of this.groups) {
      const c = g.c, ts = g.tools;
      c[0] = 0; c[1] = 0; c[2] = 0;
      for (const t of ts) { c[0] += t.c[0]; c[1] += t.c[1]; c[2] += t.c[2]; }
      c[0] /= ts.length; c[1] /= ts.length; c[2] /= ts.length;
      let r = 0;
      for (const t of ts) r = Math.max(r, Math.hypot(t.c[0] - c[0], t.c[1] - c[1], t.c[2] - c[2]) + t.reach);
      g.r = r;
    }
  }
  // signed distance, outward normal and velocity of tool t at (px, py, pz); returns d, writes out[0..5].
  // The distance is to the tool made rp thicker: particle centres stay rp off a tool as off the wood, so
  // the drawn dough meets the tool's surface instead of swallowing it, and a finger thinner than a grid
  // cell still reaches the grid nodes around it
  toolSdf(t, px, py, pz, out) {
    const dx = px - t.c[0], dy = py - t.c[1], dz = pz - t.c[2];
    let d, nx, ny, nz;
    if (t.kind === 'sphere') {
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
      d = l - t.r; nx = dx / l; ny = dy / l; nz = dz / l;
    } else {
      const R = t.R; // columns are the local axes
      const lx = R[0] * dx + R[3] * dy + R[6] * dz, ly = R[1] * dx + R[4] * dy + R[7] * dz, lz = R[2] * dx + R[5] * dy + R[8] * dz;
      const rad = Math.sqrt(lx * lx + lz * lz) || 1e-9;
      const er = rad - t.r, ea = Math.abs(ly) - t.h, sy = ly >= 0 ? 1 : -1;
      let ax, ay, az;
      if (er > 0 || ea > 0) {
        const pr = Math.max(er, 0), pa = Math.max(ea, 0);
        d = Math.sqrt(pr * pr + pa * pa);
        ax = (lx / rad) * pr; ay = sy * pa; az = (lz / rad) * pr;
        const l = Math.sqrt(ax * ax + ay * ay + az * az) || 1; ax /= l; ay /= l; az /= l;
      } else if (er > ea) { d = er; ax = lx / rad; ay = 0; az = lz / rad; }
      else { d = ea; ax = 0; ay = sy; az = 0; }
      nx = R[0] * ax + R[1] * ay + R[2] * az; ny = R[3] * ax + R[4] * ay + R[5] * az; nz = R[6] * ax + R[7] * ay + R[8] * az;
    }
    out[0] = nx; out[1] = ny; out[2] = nz;
    const w = t.w; // v = lin + w x (p - c)
    let vx = t.lin[0] + w[1] * dz - w[2] * dy, vy = t.lin[1] + w[2] * dx - w[0] * dz, vz = t.lin[2] + w[0] * dy - w[1] * dx;
    const sp = Math.sqrt(vx * vx + vy * vy + vz * vz), cap = this.o.maxToolSpeed;
    if (sp > cap) { const k = cap / sp; vx *= k; vy *= k; vz *= k; } // a hard hit still moves the dough, without spraying it
    out[3] = vx; out[4] = vy; out[5] = vz;
    return d - this.rp;
  }

  // ---------- one rendered frame of simulated time ----------
  step(frameDt, tools = []) {
    if (frameDt <= 0) return;
    const o = this.o;
    const nsub = Math.min(o.maxSubsteps, Math.max(1, Math.ceil(frameDt / o.maxDt)));
    const dt = frameDt / nsub;
    this.lastSubsteps = nsub;
    this.setTools(tools, frameDt);
    { const u = Math.min(1, Math.max(0, (this.progress - 0.35) / 0.65)); this.cohFloor = u * u * (3 - 2 * u); }
    // tack: kneaded, dry dough is the tackiest; the water from the turner's dip takes it away
    const wet = Math.min(1, Math.max(0, this.wet)), coh = Math.min(1, Math.max(0, this.meanCohesion));
    this.tackNow = o.tackTime * (1 - wet) * (0.4 + 0.6 * coh);
    this.pullDt = 1 - Math.pow(1 - o.pullGain, dt / 0.003); // independent of the step size
    for (let s = 0; s < nsub; s++) {
      this.poseTools((s + 1) / nsub);
      if (this.N > 0) this.substep(dt);
    }
    if (this.N > 1) this.relink();
    this.time += frameDt;
  }

  substep(dt) {
    this.parity ^= 1;
    this.checkDt = 2 * dt; // plasticity visits each particle every other substep
    const { n, n2, dx, inv, min, x, v, C, F, gv, gm, mass, vol, mu, la, rp } = this;
    const N = this.N, o = this.o;
    // active node range (particles' stencils), so empty grid is never touched
    let i0 = n, j0 = n, k0 = n, i1 = 0, j1 = 0, k1 = 0;
    for (let p = 0; p < N; p++) {
      const bi = I((x[p * 3] - min[0]) * inv - 0.5), bj = I((x[p * 3 + 1] - min[1]) * inv - 0.5), bk = I((x[p * 3 + 2] - min[2]) * inv - 0.5);
      if (bi < i0) i0 = bi; if (bj < j0) j0 = bj; if (bk < k0) k0 = bk;
      if (bi + 2 > i1) i1 = bi + 2; if (bj + 2 > j1) j1 = bj + 2; if (bk + 2 > k1) k1 = bk + 2;
    }
    this.active[0] = i0; this.active[1] = i1; this.active[2] = j0; this.active[3] = j1; this.active[4] = k0; this.active[5] = k1;
    // reset grid (active range)
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) {
      const row = j * n + k * n2;
      gm.fill(0, row + i0, row + i1 + 1);
      gv.fill(0, (row + i0) * 3, (row + i1 + 1) * 3);
    }

    // ---- P2G (substep_p2g_multi, Neo-Hookean) ----
    const kStress = -dt * vol * 4 * inv * inv;
    const dens = this.dens, crowdStart = o.crowdStart, crowdK = o.crowdStiffness, mouldT = this.mouldT;
    const wx = [0, 0, 0], wy = [0, 0, 0], wz = [0, 0, 0];
    for (let p = 0; p < N; p++) {
      const p3 = p * 3, p9 = p * 9;
      const Xx = (x[p3] - min[0]) * inv, Xy = (x[p3 + 1] - min[1]) * inv, Xz = (x[p3 + 2] - min[2]) * inv;
      const bi = I(Xx - 0.5), bj = I(Xy - 0.5), bk = I(Xz - 0.5);
      const fx = Xx - bi, fy = Xy - bj, fz = Xz - bk;
      { const a = 1.5 - fx, b = fx - 1, c = fx - 0.5; wx[0] = 0.5 * a * a; wx[1] = 0.75 - b * b; wx[2] = 0.5 * c * c; }
      { const a = 1.5 - fy, b = fy - 1, c = fy - 0.5; wy[0] = 0.5 * a * a; wy[1] = 0.75 - b * b; wy[2] = 0.5 * c * c; }
      { const a = 1.5 - fz, b = fz - 1, c = fz - 0.5; wz[0] = 0.5 * a * a; wz[1] = 0.75 - b * b; wz[2] = 0.5 * c * c; }
      // F <- (I + dt C) F
      const c00 = C[p9], c01 = C[p9 + 1], c02 = C[p9 + 2], c10 = C[p9 + 3], c11 = C[p9 + 4], c12 = C[p9 + 5], c20 = C[p9 + 6], c21 = C[p9 + 7], c22 = C[p9 + 8];
      const f00 = F[p9], f01 = F[p9 + 1], f02 = F[p9 + 2], f10 = F[p9 + 3], f11 = F[p9 + 4], f12 = F[p9 + 5], f20 = F[p9 + 6], f21 = F[p9 + 7], f22 = F[p9 + 8];
      const a00 = f00 + dt * (c00 * f00 + c01 * f10 + c02 * f20), a01 = f01 + dt * (c00 * f01 + c01 * f11 + c02 * f21), a02 = f02 + dt * (c00 * f02 + c01 * f12 + c02 * f22);
      const a10 = f10 + dt * (c10 * f00 + c11 * f10 + c12 * f20), a11 = f11 + dt * (c10 * f01 + c11 * f11 + c12 * f21), a12 = f12 + dt * (c10 * f02 + c11 * f12 + c12 * f22);
      const a20 = f20 + dt * (c20 * f00 + c21 * f10 + c22 * f20), a21 = f21 + dt * (c20 * f01 + c21 * f11 + c22 * f21), a22 = f22 + dt * (c20 * f02 + c21 * f12 + c22 * f22);
      F[p9] = a00; F[p9 + 1] = a01; F[p9 + 2] = a02; F[p9 + 3] = a10; F[p9 + 4] = a11; F[p9 + 5] = a12; F[p9 + 6] = a20; F[p9 + 7] = a21; F[p9 + 8] = a22;
      // Kirchhoff stress tau = mu (F F^T - I) + la log(J) I
      let J = a00 * (a11 * a22 - a12 * a21) - a01 * (a10 * a22 - a12 * a20) + a02 * (a10 * a21 - a11 * a20);
      if (J < 1e-4) J = 1e-4; // port: guard log(J) against inverted particles
      // volumetric part: elastic (la log J) less the crowding pressure from the measured density
      const cr = Math.min(1, Math.max(0, dens[p] - crowdStart));
      const lj = la * Math.log(J) - crowdK * cr * (1 + 4 * cr);
      const b00 = a00 * a00 + a01 * a01 + a02 * a02, b01 = a00 * a10 + a01 * a11 + a02 * a12, b02 = a00 * a20 + a01 * a21 + a02 * a22;
      const b11 = a10 * a10 + a11 * a11 + a12 * a12, b12 = a10 * a20 + a11 * a21 + a12 * a22, b22 = a20 * a20 + a21 * a21 + a22 * a22;
      const s00 = kStress * (mu * (b00 - 1) + lj), s11 = kStress * (mu * (b11 - 1) + lj), s22 = kStress * (mu * (b22 - 1) + lj);
      const s01 = kStress * mu * b01, s02 = kStress * mu * b02, s12 = kStress * mu * b12;
      // affine = stress + m C
      const A00 = s00 + mass * c00, A01 = s01 + mass * c01, A02 = s02 + mass * c02;
      const A10 = s01 + mass * c10, A11 = s11 + mass * c11, A12 = s12 + mass * c12;
      const A20 = s02 + mass * c20, A21 = s12 + mass * c21, A22 = s22 + mass * c22;
      const mvx = mass * v[p3], mvy = mass * v[p3 + 1], mvz = mass * v[p3 + 2];
      for (let c = 0; c < 3; c++) {
        const dz = (c - fz) * dx, wzc = wz[c];
        for (let b = 0; b < 3; b++) {
          const dy = (b - fy) * dx, wyz = wy[b] * wzc;
          const row = (bj + b) * n + (bk + c) * n2 + bi;
          for (let a = 0; a < 3; a++) {
            const dxp = (a - fx) * dx, w = wx[a] * wyz, id = row + a, i3 = id * 3;
            gv[i3] += w * (mvx + A00 * dxp + A01 * dy + A02 * dz);
            gv[i3 + 1] += w * (mvy + A10 * dxp + A11 * dy + A12 * dz);
            gv[i3 + 2] += w * (mvz + A20 * dxp + A21 * dy + A22 * dz);
            gm[id] += w * mass;
          }
        }
      }
    }

    // ---- grid update (substep_update_grid_v_lerp with use_standard_mpm_boundary, sticky walls) ----
    const damp = Math.exp(-o.damping * dt), g = o.gravity * dt;
    const vAllowed = (dx * o.cfl) / dt, bound = o.bound;
    const tn = [0, 0, 0, 0, 0, 0];
    const tools = this.tools, groups = this.groups;
    const touchBand = 0.5 * dx, reachPull = o.pullReach;
    // port (new): tack. Each tool's bond: pressing into the dough (or resting on it) renews it, pulling
    // away uses it up; while it lasts the dough within pullReach follows the tool
    for (const t of tools) {
      const b = t.bond, n = b.n;
      const vn = t.lin[0] * n[0] + t.lin[1] * n[1] + t.lin[2] * n[2]; // + = moving into the dough
      t.pulling = false;
      if (t.tack <= 0 || this.tackNow <= 0) { b.left = 0; b.released = true; }
      else if (t.mould > 0) {
        // a hand: the bond holds while the hand presses on its dough (more of the particles touching it
        // pushed against it than pulled away from it, last substep) and runs down while it only pulls
        // or touches nothing. (A hand pressed into the dough touches it on every side, so the mallet's
        // single contact direction below can't tell pressing from pulling.)
        if (b.press > 0 && b.press >= b.pull) { b.left = this.tackNow * t.tack; b.released = false; }
        else if (!b.released && b.left > 0) { b.left -= dt; if (b.left <= 0) b.released = true; }
      } else if (b.touching && vn > -0.05) { b.left = this.tackNow * t.tack; b.released = false; }
      else if (!b.released && b.left > 0) {
        if (vn < -0.05) { b.left -= dt; if (b.left <= 0) b.released = true; }
        t.pulling = !b.released;
      }
      // a moulding tool (a hand) holds the dough while its bond lasts, whichever way it moves
      t.holding = t.mould > 0 && !b.released && b.left > 0;
      b.press = 0; b.pull = 0; // counted again in this substep's G2P
      t.touchN = 0; t.nAcc[0] = 0; t.nAcc[1] = 0; t.nAcc[2] = 0;
    }
    let followed = 0; // grid nodes following a tool this substep (this.followed, for tests)
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const id = i + j * n + k * n2, m = gm[id];
      if (m <= 0) continue;
      const i3 = id * 3;
      let vx = gv[i3] / m, vy = gv[i3 + 1] / m + g, vz = gv[i3 + 2] / m;
      vx *= damp; vy *= damp; vz *= damp;
      // the mortar (static): moving into the wood -> take its velocity (zero). The wood seen by particle
      // centres is rp thicker (see the push-out in G2P), so the boundary sits there too
      if (this.solidSdf[id] < rp) {
        const nx = this.solidN[i3], ny = this.solidN[i3 + 1], nz = this.solidN[i3 + 2];
        if (vx * nx + vy * ny + vz * nz <= 0) { vx = 0; vy = 0; vz = 0; }
      }
      // moving tools
      if (tools.length) {
        const px = min[0] + i * dx, py = min[1] + j * dx, pz = min[2] + k * dx;
        for (const g of groups) {
          const gx = px - g.c[0], gy = py - g.c[1], gz = pz - g.c[2], gr = g.r + rp + Math.max(reachPull, touchBand);
          if (gx * gx + gy * gy + gz * gz > gr * gr) continue;
          for (const t of g.tools) {
          const ddx = px - t.c[0], ddy = py - t.c[1], ddz = pz - t.c[2];
          // the (rp-thicker) distance is at least |p - c| - reach - rp: farther than the touch band (or, while
          // pulling, the pull reach) the tool can't affect this node
          const far = t.reach + rp + (t.pulling ? reachPull : touchBand);
          if (ddx * ddx + ddy * ddy + ddz * ddz > far * far) continue;
          const d = this.toolSdf(t, px, py, pz, tn);
          if (d < touchBand) { t.touchN++; t.nAcc[0] += tn[0]; t.nAcc[1] += tn[1]; t.nAcc[2] += tn[2]; }
          const rx = vx - tn[3], ry = vy - tn[4], rz = vz - tn[5];
          const rn = rx * tn[0] + ry * tn[1] + rz * tn[2];
          if (d < 0 && rn <= 0) { vx = tn[3]; vy = tn[4]; vz = tn[5]; }
          // the mallet's bonded dough follows it as it recedes (a hand's hold acts on the particles, in G2P)
          else if (t.pulling && d < reachPull) {
            followed++;
            // bonded dough follows the receding tool, less the farther it is: a tent, not a torn-off skin
            const f = 1 - Math.max(0, d) / reachPull, kp = this.pullDt;
            vx += kp * (f * tn[3] - vx); vy += kp * (f * tn[4] - vy); vz += kp * (f * tn[5] - vz);
          }
        }
        }
      }
      // sticky box walls
      if ((i < bound && vx < 0) || (i > n - bound && vx > 0) || (j < bound && vy < 0) || (j > n - bound && vy > 0) || (k < bound && vz < 0) || (k > n - bound && vz > 0)) { vx = 0; vy = 0; vz = 0; }
      gv[i3] = Math.min(vAllowed, Math.max(-vAllowed, vx));
      gv[i3 + 1] = Math.min(vAllowed, Math.max(-vAllowed, vy));
      gv[i3 + 2] = Math.min(vAllowed, Math.max(-vAllowed, vz));
    }

    this.followed = followed;
    for (const t of tools) { // where the dough is, seen from each tool (sets up next substep's tack)
      const b = t.bond;
      b.touching = t.touchN > 0;
      if (b.touching) {
        const l = Math.hypot(t.nAcc[0], t.nAcc[1], t.nAcc[2]);
        if (l > 1e-9) { b.n = [t.nAcc[0] / l, t.nAcc[1] / l, t.nAcc[2] / l]; }
      }
    }

    // ---- G2P (substep_g2p) + push-out (substep_adjust_particle) + plasticity ----
    const kC = 4 * inv * inv;
    // stray specks: sparse particles are braked toward the lump's motion and drawn back to it (not near a
    // pulling tool, whose tent tip is meant to be thin)
    const fullMass = mass * o.ppc, kDrag = 1 - Math.exp(-o.strayDrag * dt), pullV = o.strayPull * dt;
    const ce = this.centre, mv = this.meanV;
    const pullers = tools.filter((t) => t.pulling || t.holding);
    const sticky = tools.filter((t) => t.holding);
    const stickyGroups = groups.filter((g) => g.tools.some((t) => t.holding));
    const gripGroups = groups.filter((g) => g.tools.some((t) => t.friction > 0));
    const grip = Math.min(1, gripGroups.length ? Math.max(...gripGroups.flatMap((g) => g.tools.map((t) => t.friction ?? 0))) : 0) * (1 - Math.min(1, Math.max(0, this.wet)));
    let stuck = 0; // particles riding with a hand this substep (this.stuck, for tests)
    const lo = [min[0] + 2 * dx, min[1] + 2 * dx, min[2] + 2 * dx], hi = [this.max[0] - 2 * dx, this.max[1] - 2 * dx, this.max[2] - 2 * dx];
    const sn = [0, 0, 0];
    for (let p = 0; p < N; p++) {
      const p3 = p * 3, p9 = p * 9;
      const Xx = (x[p3] - min[0]) * inv, Xy = (x[p3 + 1] - min[1]) * inv, Xz = (x[p3 + 2] - min[2]) * inv;
      const bi = I(Xx - 0.5), bj = I(Xy - 0.5), bk = I(Xz - 0.5);
      const fx = Xx - bi, fy = Xy - bj, fz = Xz - bk;
      { const a = 1.5 - fx, b = fx - 1, c = fx - 0.5; wx[0] = 0.5 * a * a; wx[1] = 0.75 - b * b; wx[2] = 0.5 * c * c; }
      { const a = 1.5 - fy, b = fy - 1, c = fy - 0.5; wy[0] = 0.5 * a * a; wy[1] = 0.75 - b * b; wy[2] = 0.5 * c * c; }
      { const a = 1.5 - fz, b = fz - 1, c = fz - 0.5; wz[0] = 0.5 * a * a; wz[1] = 0.75 - b * b; wz[2] = 0.5 * c * c; }
      let nvx = 0, nvy = 0, nvz = 0, n00 = 0, n01 = 0, n02 = 0, n10 = 0, n11 = 0, n12 = 0, n20 = 0, n21 = 0, n22 = 0, dens = 0;
      for (let c = 0; c < 3; c++) {
        const dz = (c - fz) * dx, wzc = wz[c];
        for (let b = 0; b < 3; b++) {
          const dy = (b - fy) * dx, wyz = wy[b] * wzc;
          const row = (bj + b) * n + (bk + c) * n2 + bi;
          for (let a = 0; a < 3; a++) {
            const dxp = (a - fx) * dx, w = wx[a] * wyz, i3 = (row + a) * 3;
            const gx = gv[i3], gy = gv[i3 + 1], gz = gv[i3 + 2];
            nvx += w * gx; nvy += w * gy; nvz += w * gz;
            dens += w * gm[row + a];
            const kw = kC * w;
            n00 += kw * gx * dxp; n01 += kw * gx * dy; n02 += kw * gx * dz;
            n10 += kw * gy * dxp; n11 += kw * gy * dy; n12 += kw * gy * dz;
            n20 += kw * gz * dxp; n21 += kw * gz * dy; n22 += kw * gz * dz;
          }
        }
      }
      C[p9] = n00; C[p9 + 1] = n01; C[p9 + 2] = n02; C[p9 + 3] = n10; C[p9 + 4] = n11; C[p9 + 5] = n12; C[p9 + 6] = n20; C[p9 + 7] = n21; C[p9 + 8] = n22;
      this.dens[p] = dens / fullMass;
      if (dens < o.strayDensity * fullMass) {
        let nearPull = false;
        for (const t of pullers) {
          const ex = x[p3] - t.c[0], ey = x[p3 + 1] - t.c[1], ez = x[p3 + 2] - t.c[2], rr = t.reach + o.pullReach + dx;
          if (ex * ex + ey * ey + ez * ez < rr * rr) { nearPull = true; break; }
        }
        if (!nearPull) {
          nvx += (mv[0] - nvx) * kDrag; nvy += (mv[1] - nvy) * kDrag; nvz += (mv[2] - nvz) * kDrag;
          const ex = ce[0] - x[p3], ey = ce[1] - x[p3 + 1], ez = ce[2] - x[p3 + 2], el = Math.hypot(ex, ey, ez);
          if (el > 1e-6) { nvx += (pullV * ex) / el; nvy += (pullV * ey) / el; nvz += (pullV * ez) / el; }
        }
      }
      { // nothing flies off the lump: speed relative to the lump's own motion is capped
        const rx = nvx - mv[0], ry = nvy - mv[1], rz = nvz - mv[2], rs = rx * rx + ry * ry + rz * rz, cap = o.maxDoughSpeed;
        if (rs > cap * cap) { const k = cap / Math.sqrt(rs); nvx = mv[0] + rx * k; nvy = mv[1] + ry * k; nvz = mv[2] + rz * k; }
      }
      let px = x[p3] + dt * nvx, py = x[p3 + 1] + dt * nvy, pz = x[p3 + 2] + dt * nvz;
      // held by a hand (a moulding tool whose bond holds). On a coarse grid the few nodes near a finger
      // can't carry the dough (each particle averages 27 nodes reaching 1.5 cells away, most of them not
      // following), so the hand acts on the particles directly, from where they were at the start of this
      // step: a particle touching it then (its distance d + dt * (v . n) within stickSlack) rides with it;
      // one within pullReach follows it with the tack falloff, except where the hand presses toward it
      // (dough is never pushed from a distance). The nearest-to-the-hand effect wins.
      if (sticky.length) {
        let best = 0, sx = 0, sy = 0, sz = 0, bt = null, bn0 = 0, bn1 = 0, bn2 = 0;
        const ox = x[p3], oy = x[p3 + 1], oz = x[p3 + 2], slack = o.stickSlack * rp;
        for (const g of stickyGroups) {
          const gx = ox - g.c[0], gy = oy - g.c[1], gz = oz - g.c[2], gr = g.r + rp + reachPull;
          if (gx * gx + gy * gy + gz * gz > gr * gr) continue;
          for (const t of g.tools) {
          if (!t.holding) continue;
          const ddx = ox - t.c[0], ddy = oy - t.c[1], ddz = oz - t.c[2], dc = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
          const lb = dc - t.reach - rp; // a lower bound on this tool's distance
          if (lb >= reachPull || (best > 0 && 1 - Math.max(0, lb) / reachPull <= best)) continue; // can't hold it more than the best so far
          const d = this.toolSdf(t, ox, oy, oz, tn);
          if (d >= reachPull) continue;
          const vn = tn[3] * tn[0] + tn[4] * tn[1] + tn[5] * tn[2]; // > 0: the hand moves toward this dough
          const f = d + dt * vn < slack ? 1 : vn > 0 ? 0 : 1 - Math.max(0, d) / reachPull;
          if (f > best) { best = f; sx = tn[3]; sy = tn[4]; sz = tn[5]; bt = t; bn0 = tn[0]; bn1 = tn[1]; bn2 = tn[2]; }
          if (best >= 1) break; // touching: nothing holds it more
          }
          if (best >= 1) break;
        }
        if (best >= 1) {
          // touching: would this dough, left to itself, push into the hand or come away from it?
          const rn = (nvx - sx) * bn0 + (nvy - sy) * bn1 + (nvz - sz) * bn2;
          if (rn < 0) bt.bond.press++; else if (rn > 0) bt.bond.pull++;
          nvx = sx; nvy = sy; nvz = sz; stuck++;
        }
        else if (best > 0) { const kp = this.pullDt; nvx += kp * (best * sx - nvx); nvy += kp * (best * sy - nvy); nvz += kp * (best * sz - nvz); }
        if (best > 0) { px = ox + dt * nvx; py = oy + dt * nvy; pz = oz + dt * nvz; }
      }
      // friction: dough pressed against a hand goes with it (see DEFAULTS.friction); acts on the particles,
      // like the hold above, because the coarse grid can't carry it
      if (gripGroups.length && grip > 0) {
        let best = Infinity, sx = 0, sy = 0, sz = 0;
        const ox = x[p3], oy = x[p3 + 1], oz = x[p3 + 2], slack = o.stickSlack * rp;
        for (const g of gripGroups) {
          const gx = ox - g.c[0], gy = oy - g.c[1], gz = oz - g.c[2], gr = g.r + rp + slack + dx;
          if (gx * gx + gy * gy + gz * gz > gr * gr) continue;
          for (const t of g.tools) {
            if (!(t.friction > 0)) continue;
            const ddx = ox - t.c[0], ddy = oy - t.c[1], ddz = oz - t.c[2], rr = t.reach + rp + slack + dx;
            if (ddx * ddx + ddy * ddy + ddz * ddz > rr * rr) continue;
            const d = this.toolSdf(t, ox, oy, oz, tn);
            const before = d + dt * (tn[3] * tn[0] + tn[4] * tn[1] + tn[5] * tn[2]); // its distance at the step's start
            if (before >= slack || before >= best) continue;
            if ((nvx - tn[3]) * tn[0] + (nvy - tn[4]) * tn[1] + (nvz - tn[5]) * tn[2] >= 0) continue; // not pressed against it
            best = before; sx = tn[3]; sy = tn[4]; sz = tn[5];
          }
        }
        if (best < Infinity) {
          nvx += grip * (sx - nvx); nvy += grip * (sy - nvy); nvz += grip * (sz - nvz);
          px = ox + dt * nvx; py = oy + dt * nvy; pz = oz + dt * nvz;
        }
      }
      // substep_adjust_particle: inside a tool -> onto its surface, with its velocity
      for (const g of groups) {
        const gx = px - g.c[0], gy = py - g.c[1], gz = pz - g.c[2], gr = g.r + rp + dx;
        if (gx * gx + gy * gy + gz * gz > gr * gr) continue;
        for (const t of g.tools) {
        const ddx = px - t.c[0], ddy = py - t.c[1], ddz = pz - t.c[2];
        // pushes need d < 0 (|p - c| < reach + rp); a hand also makes dough mouldable a cell around it
        const bound = t.reach + rp + (t.mould > 0 && t.bond.touching ? dx : 0);
        if (ddx * ddx + ddy * ddy + ddz * ddz > bound * bound) continue;
        const d = this.toolSdf(t, px, py, pz, tn);
        if (d < 0) { px -= d * tn[0]; py -= d * tn[1]; pz -= d * tn[2]; nvx = tn[3]; nvy = tn[4]; nvz = tn[5]; t.bond.press++; }
        // a hand in the dough makes the dough around it (within pullReach) mouldable for a moment
        if (t.mould > 0 && t.bond.touching && d < o.pullReach) mouldT[p] = o.mouldHold;
        }
      }
      if (mouldT[p] > 0) mouldT[p] -= dt;
      // port: also keep the dough out of the mortar's wood (VR-Doh relies on the grid boundary alone): the
      // particle's centre rp from the wood, so the cube of dough it stands for touches the wood but isn't in
      // it. Filter: the distance is 1-Lipschitz, so the nearest node's exact value less the distance to that
      // node is a lower bound; only a particle that may be closer than rp gets the exact evaluation. A move
      // off one face of the bowl can land closer than rp to the next, hence a few rounds.
      {
        let ni = Math.round((px - min[0]) * inv), nj = Math.round((py - min[1]) * inv), nk = Math.round((pz - min[2]) * inv);
        ni = ni < 0 ? 0 : ni >= n ? n - 1 : ni; nj = nj < 0 ? 0 : nj >= n ? n - 1 : nj; nk = nk < 0 ? 0 : nk >= n ? n - 1 : nk;
        const ox = px - min[0] - ni * dx, oy = py - min[1] - nj * dx, oz = pz - min[2] - nk * dx;
        if (this.solidSdf[ni + nj * n + nk * n2] - Math.sqrt(ox * ox + oy * oy + oz * oz) < rp) {
          for (let it = 0; it < 3; it++) {
            const ds = this.usuSdf(px, py, pz, sn) - rp;
            if (ds >= 0) break;
            px -= ds * sn[0]; py -= ds * sn[1]; pz -= ds * sn[2];
            const vn = nvx * sn[0] + nvy * sn[1] + nvz * sn[2];
            if (vn < 0) { nvx -= vn * sn[0]; nvy -= vn * sn[1]; nvz -= vn * sn[2]; }
          }
        }
      }
      x[p3] = Math.min(hi[0], Math.max(lo[0], px)); x[p3 + 1] = Math.min(hi[1], Math.max(lo[1], py)); x[p3 + 2] = Math.min(hi[2], Math.max(lo[2], pz));
      v[p3] = nvx; v[p3 + 1] = nvy; v[p3 + 2] = nvz;
      // port (speed): each particle's plastic return mapping runs every other substep (alternating halves)
      if (((p + this.parity) & 1) === 0) this.plasticity(p, p9);
    }
    this.stuck = stuck;
    // one body: a tether never stretches past the link reach, and its two particles don't move apart along
    // it (a taut strand passes the pull on to the dough behind it, which then flows into the strand)
    if (this.nTethers) {
      const T = this.tethers, R = this.linkR;
      for (let k = 0; k < this.nTethers; k++) {
        const a = T[k * 2] * 3, b = T[k * 2 + 1] * 3;
        const ex = x[b] - x[a], ey = x[b + 1] - x[a + 1], ez = x[b + 2] - x[a + 2], L = Math.sqrt(ex * ex + ey * ey + ez * ez);
        if (L <= R) continue;
        const nx = ex / L, ny = ey / L, nz = ez / L, c = 0.5 * (L - R);
        x[a] += c * nx; x[a + 1] += c * ny; x[a + 2] += c * nz;
        x[b] -= c * nx; x[b + 1] -= c * ny; x[b + 2] -= c * nz;
        const rv = (v[b] - v[a]) * nx + (v[b + 1] - v[a + 1]) * ny + (v[b + 2] - v[a + 2]) * nz;
        if (rv > 0) { const h = 0.5 * rv; v[a] += h * nx; v[a + 1] += h * ny; v[a + 2] += h * nz; v[b] -= h * nx; v[b + 1] -= h * ny; v[b + 2] -= h * nz; }
      }
    }
  }

  // substep_apply_plasticity, reworked into viscoplasticity (Herschel-Bulkley) on the Hencky strain
  // eps (log of the singular values of F). The deviatoric Kirchhoff stress is about 2 mu |dev eps|; above
  // the yield stress sy the excess relaxes at the plastic rate ((2 mu excess - ...) / flowK)^(1/flowN),
  // never past the yield surface in one step. sy goes from just-steamed (stiff) to kneaded (softer) with
  // the particle's cohesion. Volume is untouched (plastic flow is deviatoric), so the dough never comes
  // apart in tension: it is cohesive throughout.
  // Instead of U Z V^T we use F_new = F V diag(exp(eps_new - eps)) V^T (the same matrix), so only the
  // eigen-decomposition of F^T F is needed, and only for particles that actually yield.
  plasticity(p, p9) {
    const F = this.F, o = this.o, mu2 = 2 * this.mu;
    const coh = this.cohesionOf(p);
    const moulded = this.mouldT[p] > 0; // a hand is shaping it (see mouldYield)
    const sy = (o.yieldStress[0] + (o.yieldStress[1] - o.yieldStress[0]) * coh) * (moulded ? o.mouldYield : 1);
    const yieldStrain = sy / mu2;
    const f00 = F[p9], f01 = F[p9 + 1], f02 = F[p9 + 2], f10 = F[p9 + 3], f11 = F[p9 + 4], f12 = F[p9 + 5], f20 = F[p9 + 6], f21 = F[p9 + 7], f22 = F[p9 + 8];
    const m00 = f00 * f00 + f10 * f10 + f20 * f20, m01 = f00 * f01 + f10 * f11 + f20 * f21, m02 = f00 * f02 + f10 * f12 + f20 * f22;
    const m11 = f01 * f01 + f11 * f11 + f21 * f21, m12 = f01 * f02 + f11 * f12 + f21 * f22, m22 = f02 * f02 + f12 * f12 + f22 * f22;
    // port (speed): cheap pre-check. F^T F = exp(2 eps): its deviatoric norm / mean ~ 2 |dev eps|.
    // Clearly inside the yield surface -> nothing to do.
    {
      const t3 = (m00 + m11 + m22) / 3, d0 = m00 - t3, d1 = m11 - t3, d2 = m22 - t3;
      const approx = (0.5 * Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2 + 2 * (m01 * m01 + m02 * m02 + m12 * m12))) / Math.max(t3, 1e-6);
      if (approx < 0.6 * yieldStrain) return;
    }
    // exact: eigen-decomposition of F^T F
    const V = JV, lam = JL;
    jacobiEigen(m00, m01, m02, m11, m12, m22, V, lam);
    const q0 = 0.5 * Math.log(Math.max(lam[0], 1e-12)), q1 = 0.5 * Math.log(Math.max(lam[1], 1e-12)), q2 = 0.5 * Math.log(Math.max(lam[2], 1e-12));
    const t3 = (q0 + q1 + q2) / 3;
    const d0 = q0 - t3, d1 = q1 - t3, d2 = q2 - t3;
    const dn = Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
    const excess = dn - yieldStrain;
    if (excess <= 0) return;
    // Herschel-Bulkley flow: excess stress 2 mu * excess drives plastic shear at (excess stress / K)^(1/n);
    // shear-thinning, so a strike (large excess) flows at once and gravity (small excess) only creeps
    const rate = Math.pow((mu2 * excess) / o.flowK, 1 / o.flowN);
    const dg = moulded ? excess : Math.min(excess, rate * this.checkDt);
    if (dg <= 0) return;
    // kneading: only fast plastic flow (strikes, folds) works the dough; slow creep doesn't count
    this.work[p] += Math.max(0, dg - o.workRateFloor * this.checkDt);
    const shrink = -dg / dn; // dev eps -> dev eps * (1 - dg / dn)
    const sc0 = Math.exp(d0 * shrink), sc1 = Math.exp(d1 * shrink), sc2 = Math.exp(d2 * shrink);
    // M = V diag(sc) V^T ; F <- F M
    const M00 = V[0] * V[0] * sc0 + V[1] * V[1] * sc1 + V[2] * V[2] * sc2;
    const M01 = V[0] * V[3] * sc0 + V[1] * V[4] * sc1 + V[2] * V[5] * sc2;
    const M02 = V[0] * V[6] * sc0 + V[1] * V[7] * sc1 + V[2] * V[8] * sc2;
    const M11 = V[3] * V[3] * sc0 + V[4] * V[4] * sc1 + V[5] * V[5] * sc2;
    const M12 = V[3] * V[6] * sc0 + V[4] * V[7] * sc1 + V[5] * V[8] * sc2;
    const M22 = V[6] * V[6] * sc0 + V[7] * V[7] * sc1 + V[8] * V[8] * sc2;
    F[p9] = f00 * M00 + f01 * M01 + f02 * M02; F[p9 + 1] = f00 * M01 + f01 * M11 + f02 * M12; F[p9 + 2] = f00 * M02 + f01 * M12 + f02 * M22;
    F[p9 + 3] = f10 * M00 + f11 * M01 + f12 * M02; F[p9 + 4] = f10 * M01 + f11 * M11 + f12 * M12; F[p9 + 5] = f10 * M02 + f11 * M12 + f12 * M22;
    F[p9 + 6] = f20 * M00 + f21 * M01 + f22 * M02; F[p9 + 7] = f20 * M01 + f21 * M11 + f22 * M12; F[p9 + 8] = f20 * M02 + f21 * M12 + f22 * M22;
  }

  // ---------- multiplayer: one dough, owned by the host (src/sync.js) ----------
  // The particles as 16-bit numbers: positions across the box (14 um steps), velocities within +-8 m/s.
  snapshot() {
    const N = this.N, size = this.n * this.dx, x = this.x, v = this.v, min = this.min;
    const xq = new Int16Array(N * 3), vq = new Int16Array(N * 3);
    for (let i = 0; i < N * 3; i++) {
      xq[i] = Math.round(Math.min(1, Math.max(0, (x[i] - min[i % 3]) / size)) * 65535) - 32768;
      vq[i] = Math.round(Math.min(1, Math.max(-1, v[i] / 8)) * 32767);
    }
    return { N, xq, vq };
  }
  // The host's particles, on the guest: eased toward them by `k` (0..1); with a different count (joined
  // mid-batch, spawned differently) they replace this dough. Both headsets build the dough the same way
  // (same tier, same spawn), so particle i is the same bit of dough on both.
  correct(N, xq, vq, k) {
    const size = this.n * this.dx, x = this.x, v = this.v, min = this.min;
    if (N !== this.N) {
      if (N > this.o.maxParticles) return;
      this.clear();
      this.N = N;
      for (let p = 0; p < N; p++) {
        this.C.fill(0, p * 9, p * 9 + 9);
        const F = this.F; F.fill(0, p * 9, p * 9 + 9); F[p * 9] = F[p * 9 + 4] = F[p * 9 + 8] = 1;
        this.work[p] = 0; this.dens[p] = 1; this.mouldT[p] = 0;
      }
      k = 1;
    }
    for (let i = 0; i < N * 3; i++) {
      const hx = min[i % 3] + ((xq[i] + 32768) / 65535) * size, hv = (vq[i] / 32767) * 8;
      x[i] += k * (hx - x[i]);
      v[i] += k * (hv - v[i]);
    }
  }

  // Once per frame: link particles that came within the reach (folds stick), drop stretched links whose
  // particles are still joined through short ones, and keep the rest as tethers (DEFAULTS.linkReach).
  relink() {
    const N = this.N, x = this.x, R = this.linkR, R2 = R * R, o = this.o;
    // particles into cells of size R (counting sort)
    const K = Math.ceil((this.n * this.dx) / R) + 2, min = this.min;
    if (!this._cellStart || this._cellStart.length < K * K * K + 1) this._cellStart = new Int32Array(K * K * K + 1);
    if (!this._cellOf || this._cellOf.length < N) { this._cellOf = new Int32Array(this.o.maxParticles); this._cellIdx = new Int32Array(this.o.maxParticles); }
    const start = this._cellStart, cellOf = this._cellOf, idx = this._cellIdx;
    start.fill(0, 0, K * K * K + 1);
    const cl = (v) => (v < 0 ? 0 : v >= K ? K - 1 : v);
    for (let p = 0; p < N; p++) {
      const c = cl(Math.floor((x[p * 3] - min[0]) / R) + 1) + cl(Math.floor((x[p * 3 + 1] - min[1]) / R) + 1) * K + cl(Math.floor((x[p * 3 + 2] - min[2]) / R) + 1) * K * K;
      cellOf[p] = c; start[c + 1]++;
    }
    for (let c = 0; c < K * K * K; c++) start[c + 1] += start[c];
    const fill = this._fill && this._fill.length >= K * K * K ? this._fill : (this._fill = new Int32Array(K * K * K));
    fill.set(start.subarray(0, K * K * K));
    for (let p = 0; p < N; p++) idx[fill[cellOf[p]]++] = p;
    // new links: pairs within the reach not linked yet
    const set = this.linkSet, maxP = this.o.maxParticles;
    for (let p = 0; p < N; p++) {
      const c = cellOf[p], cx = c % K, cy = Math.floor(c / K) % K, cz = Math.floor(c / (K * K));
      for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dxc = -1; dxc <= 1; dxc++) {
        const qx = cx + dxc, qy = cy + dy, qz = cz + dz;
        if (qx < 0 || qy < 0 || qz < 0 || qx >= K || qy >= K || qz >= K) continue;
        const qc = qx + qy * K + qz * K * K;
        for (let i = start[qc]; i < start[qc + 1]; i++) {
          const q = idx[i];
          if (q <= p) continue;
          const ex = x[q * 3] - x[p * 3], ey = x[q * 3 + 1] - x[p * 3 + 1], ez = x[q * 3 + 2] - x[p * 3 + 2];
          if (ex * ex + ey * ey + ez * ez >= R2) continue;
          const key = p * maxP + q;
          if (set.has(key)) continue;
          set.add(key);
          if (this.nLinks >= this.linkA.length) { const na = new Int32Array(this.linkA.length * 2), nb = new Int32Array(this.linkB.length * 2); na.set(this.linkA); nb.set(this.linkB); this.linkA = na; this.linkB = nb; }
          this.linkA[this.nLinks] = p; this.linkB[this.nLinks] = q; this.nLinks++;
        }
      }
    }
    // short links as adjacency (CSR), for the "still joined some other way?" search
    const A = this.linkA, B = this.linkB, nL = this.nLinks;
    if (!this._deg || this._deg.length < N + 1) { this._deg = new Int32Array(this.o.maxParticles + 1); this._mark = new Int32Array(this.o.maxParticles); this._queue = new Int32Array(this.o.maxParticles); this._hop = new Int32Array(this.o.maxParticles); this._stamp = 0; }
    const deg = this._deg, isLong = this._long && this._long.length >= nL ? this._long : (this._long = new Uint8Array(Math.max(nL, 1024) * 2));
    deg.fill(0, 0, N + 1);
    for (let k = 0; k < nL; k++) {
      const a = A[k] * 3, b = B[k] * 3, ex = x[b] - x[a], ey = x[b + 1] - x[a + 1], ez = x[b + 2] - x[a + 2];
      isLong[k] = ex * ex + ey * ey + ez * ez > R2 ? 1 : 0;
      if (!isLong[k]) { deg[A[k] + 1]++; deg[B[k] + 1]++; }
    }
    for (let p = 0; p < N; p++) deg[p + 1] += deg[p];
    const adjLen = deg[N];
    if (!this._adj || this._adj.length < adjLen) this._adj = new Int32Array(Math.max(adjLen, 1024) * 2);
    const adj = this._adj, put = this._queue; // put: a scratch cursor per particle (queue reused below)
    for (let p = 0; p < N; p++) put[p] = deg[p];
    for (let k = 0; k < nL; k++) if (!isLong[k]) { adj[put[A[k]]++] = B[k]; adj[put[B[k]]++] = A[k]; }
    // long links: drop the ones whose particles are joined through short links within linkDepth hops
    const mark = this._mark, queue = this._queue, hop = this._hop, depth = o.linkDepth;
    let w = 0, nT = 0;
    for (let k = 0; k < nL; k++) {
      const a = A[k], b = B[k];
      let keep = true, tether = false;
      if (isLong[k]) {
        const stamp = ++this._stamp;
        let head = 0, tail = 0, found = false;
        queue[tail++] = a; mark[a] = stamp; hop[a] = 0;
        while (head < tail && !found) {
          const u = queue[head++];
          if (hop[u] >= depth) continue;
          for (let i = deg[u]; i < deg[u + 1]; i++) {
            const nb = adj[i];
            if (mark[nb] === stamp) continue;
            if (nb === b) { found = true; break; }
            mark[nb] = stamp; hop[nb] = hop[u] + 1; queue[tail++] = nb;
          }
        }
        if (found) keep = false; else tether = true;
      }
      if (!keep) { set.delete(a * maxP + b); continue; }
      A[w] = a; B[w] = b; w++;
      if (tether) {
        if (nT * 2 + 2 > this.tethers.length) { const nt = new Int32Array(this.tethers.length * 2); nt.set(this.tethers); this.tethers = nt; }
        this.tethers[nT * 2] = a; this.tethers[nT * 2 + 1] = b; nT++;
      }
    }
    this.nLinks = w; this.nTethers = nT;
  }

  // Density on the grid nodes for marching cubes (substep_p2marching + normalize_m), 1 = full dough.
  // Also returns a few numbers the scene needs. `field` is n^3, x fastest (three's MarchingCubes order).
  writeField(field, axis = { x: 0, z: 0, r: 0.13 }) {
    const { n, n2, dx, inv, min, x, v, gm } = this;
    field.fill(0);
    const stats = { count: this.N, topY: null, cx: 0, cy: 0, cz: 0, meanVy: 0, maxSpeed: 0, time: this.time, cohesion: 0 };
    if (this.N === 0) return stats;
    gm.fill(0);
    const wx = [0, 0, 0], wy = [0, 0, 0], wz = [0, 0, 0];
    let top = -1e9, mvx = 0, mvz = 0;
    for (let p = 0; p < this.N; p++) {
      const p3 = p * 3;
      const px = x[p3], py = x[p3 + 1], pz = x[p3 + 2];
      // thin dough (a strand, a sheet) is drawn thicker, so it shows as one piece (DEFAULTS.thinDensity)
      const boost = Math.min(this.o.thinBoost, Math.max(1, this.o.thinDensity / Math.max(1e-6, this.dens[p])));
      stats.cx += px; stats.cy += py; stats.cz += pz; stats.meanVy += v[p3 + 1];
      mvx += v[p3]; mvz += v[p3 + 2];
      stats.cohesion += this.cohesionOf(p);
      const sp = v[p3] * v[p3] + v[p3 + 1] * v[p3 + 1] + v[p3 + 2] * v[p3 + 2];
      if (sp > stats.maxSpeed) stats.maxSpeed = sp;
      if (py > top && (px - axis.x) ** 2 + (pz - axis.z) ** 2 < axis.r * axis.r) top = py;
      const Xx = (px - min[0]) * inv, Xy = (py - min[1]) * inv, Xz = (pz - min[2]) * inv;
      const bi = I(Xx - 0.5), bj = I(Xy - 0.5), bk = I(Xz - 0.5);
      const fx = Xx - bi, fy = Xy - bj, fz = Xz - bk;
      { const a = 1.5 - fx, b = fx - 1, c = fx - 0.5; wx[0] = 0.5 * a * a; wx[1] = 0.75 - b * b; wx[2] = 0.5 * c * c; }
      { const a = 1.5 - fy, b = fy - 1, c = fy - 0.5; wy[0] = 0.5 * a * a; wy[1] = 0.75 - b * b; wy[2] = 0.5 * c * c; }
      { const a = 1.5 - fz, b = fz - 1, c = fz - 0.5; wz[0] = 0.5 * a * a; wz[1] = 0.75 - b * b; wz[2] = 0.5 * c * c; }
      for (let c = 0; c < 3; c++) for (let b = 0; b < 3; b++) {
        const row = (bj + b) * n + (bk + c) * n2 + bi, wyz = wy[b] * wz[c];
        for (let a = 0; a < 3; a++) gm[row + a] += wx[a] * wyz * boost;
      }
    }
    // thin dough between linked particles: along each link with a sparse end, extra samples every half
    // lattice spacing, weighted like its ends, so a held-together strand is drawn as a tube, not beads
    {
      const A = this.linkA, B = this.linkB, dens = this.dens, o = this.o, half = 0.5 * Math.cbrt(this.vol);
      for (let k = 0; k < this.nLinks; k++) {
        const a = A[k], b = B[k];
        if (a >= this.N || b >= this.N || (dens[a] >= o.thinDensity && dens[b] >= o.thinDensity)) continue;
        const a3 = a * 3, b3 = b * 3, ex = x[b3] - x[a3], ey = x[b3 + 1] - x[a3 + 1], ez = x[b3 + 2] - x[a3 + 2];
        const L = Math.sqrt(ex * ex + ey * ey + ez * ez), m = Math.max(1, Math.ceil(L / half) - 1);
        const ba = Math.min(o.thinBoost, Math.max(1, o.thinDensity / Math.max(1e-6, dens[a]))), bb = Math.min(o.thinBoost, Math.max(1, o.thinDensity / Math.max(1e-6, dens[b])));
        const wgt = (0.5 * (ba + bb) * (L / (m + 1))) / (2 * half); // its ends' weight per lattice spacing of strand
        for (let g = 1; g <= m; g++) {
          const t = g / (m + 1), sx = x[a3] + ex * t, sy = x[a3 + 1] + ey * t, sz = x[a3 + 2] + ez * t;
          const Xx = (sx - min[0]) * inv, Xy = (sy - min[1]) * inv, Xz = (sz - min[2]) * inv;
          const bi = I(Xx - 0.5), bj = I(Xy - 0.5), bk = I(Xz - 0.5);
          if (bi < 0 || bj < 0 || bk < 0 || bi > n - 3 || bj > n - 3 || bk > n - 3) continue;
          const fx = Xx - bi, fy = Xy - bj, fz = Xz - bk;
          { const p0 = 1.5 - fx, p1 = fx - 1, p2 = fx - 0.5; wx[0] = 0.5 * p0 * p0; wx[1] = 0.75 - p1 * p1; wx[2] = 0.5 * p2 * p2; }
          { const p0 = 1.5 - fy, p1 = fy - 1, p2 = fy - 0.5; wy[0] = 0.5 * p0 * p0; wy[1] = 0.75 - p1 * p1; wy[2] = 0.5 * p2 * p2; }
          { const p0 = 1.5 - fz, p1 = fz - 1, p2 = fz - 0.5; wz[0] = 0.5 * p0 * p0; wz[1] = 0.75 - p1 * p1; wz[2] = 0.5 * p2 * p2; }
          for (let c = 0; c < 3; c++) for (let bb2 = 0; bb2 < 3; bb2++) {
            const row = (bj + bb2) * n + (bk + c) * n2 + bi, wyz = wy[bb2] * wz[c] * wgt;
            for (let aa = 0; aa < 3; aa++) gm[row + aa] += wx[aa] * wyz;
          }
        }
      }
    }
    const full = this.o.ppc; // particles per cell at rest = density 1
    for (let i = 0; i < this.n3; i++) field[i] = gm[i] / full;
    stats.cx /= this.N; stats.cy /= this.N; stats.cz /= this.N; stats.meanVy /= this.N; stats.cohesion /= this.N;
    this.meanCohesion = stats.cohesion;
    this.centre = [stats.cx, stats.cy, stats.cz];
    this.meanV = [mvx / this.N, stats.meanVy, mvz / this.N];
    stats.maxSpeed = Math.sqrt(stats.maxSpeed);
    stats.topY = top > -1e8 ? top + dx * 0.5 : null; // particle centres sit about half a cell under the surface
    return stats;
  }
}

// ---------- small linear-algebra helpers (no allocation per call) ----------
const EIG = [0, 0, 0];
const JV = new Float64Array(9), JL = new Float64Array(3);

// eigenvalues of a symmetric 3x3 (Smith 1961)
function symEigenvalues(a00, a01, a02, a11, a12, a22, out) {
  const p1 = a01 * a01 + a02 * a02 + a12 * a12;
  if (p1 < 1e-18) { out[0] = a00; out[1] = a11; out[2] = a22; return; }
  const q = (a00 + a11 + a22) / 3;
  const b00 = a00 - q, b11 = a11 - q, b22 = a22 - q;
  const p2 = b00 * b00 + b11 * b11 + b22 * b22 + 2 * p1;
  const p = Math.sqrt(p2 / 6);
  const det = b00 * (b11 * b22 - a12 * a12) - a01 * (a01 * b22 - a12 * a02) + a02 * (a01 * a12 - b11 * a02);
  let r = det / (2 * p * p * p);
  r = r < -1 ? -1 : r > 1 ? 1 : r;
  const phi = Math.acos(r) / 3;
  out[0] = q + 2 * p * Math.cos(phi);
  out[2] = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  out[1] = 3 * q - out[0] - out[2];
}

// cyclic Jacobi for a symmetric 3x3 (Numerical Recipes rotation): V row-major with eigenvectors in
// its columns, lam the matching eigenvalues
const JA = new Float64Array(9);
const PAIRS = [0, 1, 0, 2, 1, 2];
function jacobiEigen(a00, a01, a02, a11, a12, a22, V, lam) {
  const A = JA;
  A[0] = a00; A[1] = a01; A[2] = a02; A[3] = a01; A[4] = a11; A[5] = a12; A[6] = a02; A[7] = a12; A[8] = a22;
  V.fill(0); V[0] = V[4] = V[8] = 1;
  for (let sweep = 0; sweep < 8; sweep++) {
    if (A[1] * A[1] + A[2] * A[2] + A[5] * A[5] < 1e-24) break;
    for (let e = 0; e < 6; e += 2) {
      const p = PAIRS[e], q = PAIRS[e + 1];
      const apq = A[p * 3 + q];
      if (Math.abs(apq) < 1e-20) continue;
      const theta = (A[q * 3 + q] - A[p * 3 + p]) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { // A <- A P
        const akp = A[k * 3 + p], akq = A[k * 3 + q];
        A[k * 3 + p] = c * akp - s * akq; A[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) { // A <- P^T A
        const apk = A[p * 3 + k], aqk = A[q * 3 + k];
        A[p * 3 + k] = c * apk - s * aqk; A[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) { // V <- V P
        const vkp = V[k * 3 + p], vkq = V[k * 3 + q];
        V[k * 3 + p] = c * vkp - s * vkq; V[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  lam[0] = A[0]; lam[1] = A[4]; lam[2] = A[8];
}

function nlerp(a, b, s) {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  if (a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
  const x = a[0] + (bx - a[0]) * s, y = a[1] + (by - a[1]) * s, z = a[2] + (bz - a[2]) * s, w = a[3] + (bw - a[3]) * s;
  const l = Math.sqrt(x * x + y * y + z * z + w * w) || 1;
  return [x / l, y / l, z / l, w / l];
}
// rotation matrix, row-major, columns = local axes in world
function quatToMat(q, R) {
  const [x, y, z, w] = q;
  R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - z * w); R[2] = 2 * (x * z + y * w);
  R[3] = 2 * (x * y + z * w); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - x * w);
  R[6] = 2 * (x * z - y * w); R[7] = 2 * (y * z + x * w); R[8] = 1 - 2 * (x * x + y * y);
}
// world angular velocity taking q0 to q1 in time T
function angularVelocity(q0, q1, T) {
  // dq = q1 * conj(q0)
  const [ax, ay, az, aw] = [-q0[0], -q0[1], -q0[2], q0[3]];
  const [bx, by, bz, bw] = q1;
  let x = bw * ax + bx * aw + by * az - bz * ay;
  let y = bw * ay - bx * az + by * aw + bz * ax;
  let z = bw * az + bx * ay - by * ax + bz * aw;
  let w = bw * aw - bx * ax - by * ay - bz * az;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-9) return [0, 0, 0];
  const ang = 2 * Math.atan2(s, w);
  const k = ang / (s * T);
  return [x * k, y * k, z * k];
}
