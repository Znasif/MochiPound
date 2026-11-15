import * as THREE from 'three';
import { MarchingCubes } from 'three/addons/objects/MarchingCubes.js';
import { TIERS, tierOptions, particlesFor, substepsPerFrame, tierForCost } from './mpm-core.js';

// The simulated dough in the scene: a Web Worker steps the MPM simulation (mpm-core.js, ported from
// VR-Doh) and returns a density grid; marching cubes turns it into the surface, as VR-Doh renders its
// clay. The main thread only sends tool poses and draws; it never waits for the simulation.
//
// Speed: on load the worker times a probe and picks the richest quality tier this machine can run in
// real time (full ~2,900 particles on a 2.5 cm grid down to ~720 on 4 cm, all at 4 particles per cell,
// and ~380 for headsets). If play still can't keep up, the next batch steps down a tier. A step never simulates more than maxSubsteps * maxDt, so a slow
// machine gets slow motion, never an unstable dough.

const RADIUS = 0.14;
const BUDGET_MS = 11; // simulation time per 60 Hz frame on the worker's core

export function createDough(scene, { usu, map }) {
  // ---- surface material (shared by every tier's mesh) ----
  const material = new THREE.MeshStandardMaterial({ map, color: 0xf3efe6, roughness: 0.85, metalness: 0 });
  const smooth = { value: 0 };
  // the moisture's colour (2026-11-15, the user's call): white with plenty of water, browner as it dries; applied
  // after the smoothing, so water shows on rough grains and on smooth dough alike
  const DRY = new THREE.Color('#b08458'), WATERED = new THREE.Color(1, 1, 1);
  const tint = { value: WATERED.clone() };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSmooth = smooth;
    shader.uniforms.uTint = tint;
    shader.fragmentShader = 'uniform float uSmooth;\nuniform vec3 uTint;\n' + shader.fragmentShader.replace(
      '#include <map_fragment>',
      '#include <map_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.985, 0.98, 0.965), uSmooth) * uTint;',
    );
  };

  const worker = new Worker(new URL('./mpm.worker.js', import.meta.url), { type: 'module' });
  let opts = null, tierIndex = -1, mc = null, spare = null;
  let busy = false, acc = 0, ready = false;
  let pendingSpawn = null;
  let load = 0; // smoothed (worker time) / (simulated time); above ~1 the dough runs slower than real time
  let cost = 0;  // smoothed ms per particle-substep measured in play (the probe at start can be pessimistic)
  let wet = 0;   // 0..1: the turner's water dip makes the dough slippery; dries over a few strikes
  let youngsModulus = 4000;
  const prev = new Map();
  const fresh = new Set(); // tool ids that (re)appeared since the last step sent
  let wantSnap = false, onSnapshot = null, followTier = false; // multiplayer (requestSnapshot, applySnapshot)
  // film playback (src/film/render.js): no simulation; each frame's dough is a recorded snapshot (showSnapshot)
  let playback = false, shown = null, showLook = null;
  const stats = { count: 0, topY: null, centroid: new THREE.Vector3(), meanVy: 0, maxSpeed: 0, stepMs: 0, time: 0, fresh: 0, tier: '', cohesion: 0 };
  let perfLog = 0;

  // the surface mesh for an n^3 grid of spacing dx from boxMin
  function makeMesh(n, dx, boxMin) {
    const size = n * dx;
    if (mc) { scene.remove(mc); mc.geometry.dispose(); }
    mc = new MarchingCubes(n, material, true, false, 12000);
    mc.name = 'dough';
    mc.isolation = 0.5;
    mc.position.set(boxMin[0] + size / 2, boxMin[1] + size / 2, boxMin[2] + size / 2);
    mc.scale.setScalar(size / 2); // MarchingCubes spans [-1, 1]: grid node i lands at boxMin + i * dx
    mc.castShadow = mc.receiveShadow = true;
    mc.frustumCulled = false;
    mc.visible = false; // shown again by the next grid
    scene.add(mc);
  }
  // the surface from the grid now in mc.field
  function drawField(count) {
    mc.visible = count > 0;
    if (!mc.visible) return;
    mc.normal_cache.fill(0); // normals are cached per cell and only cleared by reset(), which would also wipe our field
    mc.update();
    for (const name of ['position', 'normal', 'uv']) { // upload only the triangles that exist
      const attr = mc.geometry.getAttribute(name);
      if (!attr) continue;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, mc.count * attr.itemSize);
    }
  }
  function setLook(cohesion) {
    // the look follows how much of the dough has actually turned from grains into dough
    stats.cohesion = cohesion ?? 0;
    smooth.value = Math.min(1, Math.max(0, (stats.cohesion - 0.25) / 0.65));
    material.roughness = 0.85 - 0.5 * Math.min(1, stats.cohesion);
  }

  function applyTier(index, reason) {
    tierIndex = index;
    opts = tierOptions(TIERS[index], { usu });
    worker.postMessage({ type: 'init', options: opts });
    const { n, dx, boxMin } = opts, size = n * dx;
    makeMesh(n, dx, boxMin);
    spare = new Float32Array(n * n * n);
    busy = false;
    load = 0;
    cost = 0;
    ready = true;
    stats.tier = TIERS[index].name;
    console.info(`[dough] quality "${TIERS[index].name}": ~${particlesFor(TIERS[index], RADIUS)} particles on a ${Math.round(dx * 1000) / 10} cm grid (${reason})`);
    if (pendingSpawn) { const s = pendingSpawn; pendingSpawn = null; api.spawn(...s); }
  }

  worker.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'calibrated') {
      applyTier(d.tier, `measured ${(d.msPerParticleSubstep * 1000).toFixed(2)} us per particle-substep`);
      return;
    }
    if (d.type !== 'field') return;
    busy = false;
    if (d.snap) onSnapshot?.({ tier: stats.tier, N: d.snap.N, x: new Int16Array(d.snap.x), v: new Int16Array(d.snap.v) });
    const s = d.stats;
    if (!mc || d.field.length !== mc.field.length || s.stale) {
      spare = mc ? new Float32Array(mc.field.length) : null;
      if (shown) { const done = shown; shown = null; done(false); } // a playback frame from before a tier change
      return;
    }
    const old = mc.field;
    mc.field = d.field; // ping-pong: the old grid goes back to the worker on the next step
    spare = old;
    stats.count = s.count; stats.topY = s.topY; stats.meanVy = s.meanVy ?? 0; stats.maxSpeed = s.maxSpeed ?? 0;
    stats.stepMs = s.stepMs; stats.time = s.time ?? 0; stats.fresh++;
    if (s.count) setLook(showLook ?? s.cohesion); // a played-back snapshot carries its host's look
    if (s.count) stats.centroid.set(s.cx, s.cy, s.cz);
    if (s.count && s.simDt > 0) load += 0.1 * (s.stepMs / (s.simDt * 1000) - load);
    if (s.count && s.substeps) { const c = s.stepMs / (s.substeps * s.count); cost = cost ? cost + 0.1 * (c - cost) : c; }
    drawField(s.count);
    if (shown) { const done = shown; shown = null; done(true); }
    if (s.count && (perfLog += 1) % 300 === 0) {
      console.info(`[dough] ${s.count} particles (${stats.tier}), step ${s.stepMs.toFixed(1)} ms for ${(s.simDt * 1000).toFixed(1)} ms simulated, load ${load.toFixed(2)}`);
    }
  };
  worker.onerror = (err) => console.error('[dough] worker error', err.message ?? err);
  // ?dough=<tier name> (full, medium, light, lightest, minimal, tiny) forces a quality tier, e.g. to compare
  // on the headset; otherwise the worker measures this machine and picks one
  const forcedName = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('dough') : null;
  const forced = forcedName ? TIERS.findIndex((t) => t.name === forcedName) : -1;
  if (forced >= 0) applyTier(forced, `forced by ?dough=${forcedName}`);
  else worker.postMessage({ type: 'calibrate', usu, radius: RADIUS });

  const api = {
    get mesh() { return mc; },
    stats,
    spawn(center, radius, velocity = [0, 0, 0]) {
      if (playback) return; // played back: the recorded dough arrives as snapshots
      if (!ready) { pendingSpawn = [center.clone(), radius, velocity]; return; }
      worker.postMessage({ type: 'spawn', center: [center.x, center.y, center.z], radius, velocity });
      stats.count = Math.max(stats.count, 1);
    },
    clear() {
      worker.postMessage({ type: 'clear' });
      stats.count = 0; stats.topY = null;
      if (mc) mc.visible = false;
      // between batches: re-pick the tier from the speed measured in play (up or down; stepping up
      // needs a 30% margin so it doesn't flip-flop)
      if (cost > 0 && tierIndex >= 0 && forced < 0 && !followTier) {
        const want = tierForCost(cost, RADIUS, BUDGET_MS);
        const fitsWithMargin = cost * particlesFor(TIERS[want], RADIUS) * substepsPerFrame(TIERS[want]) <= 0.7 * BUDGET_MS;
        if (want > tierIndex || (want < tierIndex && fitsWithMargin)) {
          applyTier(want, `last batch: ${(cost * 1000).toFixed(2)} us per particle-substep, ${(1 / Math.max(load, 1e-3)).toFixed(2)}x real time`);
        }
      }
    },
    setProgress() { /* the look now follows the simulated cohesion (stats.cohesion) */ },
    // multiplayer, one dough owned by the host (src/sync.js). Host: the particles after the next step, to
    // onSnapshot. Guest: ease this dough toward the host's (its tier first, so the particles correspond).
    requestSnapshot(fn) { wantSnap = true; onSnapshot = fn; },
    applySnapshot(snap, k) {
      followTier = true;
      const want = TIERS.findIndex((t) => t.name === snap.tier);
      if (want >= 0 && want !== tierIndex) applyTier(want, 'the host\'s dough');
      if (!ready) return;
      if (snap.N === 0) return; // the host's batch ended: this headset clears its own dough at the same phase
      worker.postMessage({ type: 'correct', N: snap.N, x: snap.x.buffer, v: snap.v.buffer, k }, [snap.x.buffer, snap.v.buffer]);
      stats.count = Math.max(stats.count, snap.N > 0 ? 1 : 0);
    },
    // the drawn dough's density at a world point (trilinear in the latest grid; 0.5 = its surface, 1 = full)
    densityAt(p) {
      if (!mc?.visible || !opts) return 0;
      const { n, dx, boxMin } = opts, f = mc.field;
      const X = (p.x - boxMin[0]) / dx, Y = (p.y - boxMin[1]) / dx, Z = (p.z - boxMin[2]) / dx;
      const i = Math.floor(X), j = Math.floor(Y), k = Math.floor(Z);
      if (i < 0 || j < 0 || k < 0 || i >= n - 1 || j >= n - 1 || k >= n - 1) return 0;
      const fx = X - i, fy = Y - j, fz = Z - k, n2 = n * n, id = i + j * n + k * n2;
      const c00 = f[id] * (1 - fx) + f[id + 1] * fx, c10 = f[id + n] * (1 - fx) + f[id + n + 1] * fx;
      const c01 = f[id + n2] * (1 - fx) + f[id + n2 + 1] * fx, c11 = f[id + n2 + n] * (1 - fx) + f[id + n2 + n + 1] * fx;
      return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
    },
    get wetness() { return wet; },
    setWetness(w) { wet = Math.min(1, Math.max(0, w)); },
    setYoungsModulus(E) { if (Number.isFinite(E) && E > 0) youngsModulus = E; },
    // 0 (dry: brown) .. 1 (watered: white); colour only
    setMoisture(m) { if (Number.isFinite(m)) tint.value.copy(DRY).lerp(WATERED, Math.min(1, Math.max(0, m))); },
    // tools: [{ id, kind: 'sphere' | 'cylinder', center: Vector3, quat: Quaternion, r, h, tack (0 slides off, 1 sticks), mould (1: a hand, see mpm-core mouldYield) }]
    get playback() { return playback; },
    set playback(v) { playback = !!v; acc = 0; showLook = null; },
    // draw this recorded snapshot { tier, N, x, v (Int16), coh } exactly; resolves once it is drawn
    showSnapshot(snap) {
      if (!snap) return Promise.resolve(false);
      followTier = true;
      const want = TIERS.findIndex((t) => t.name === snap.tier);
      if (want >= 0 && want !== tierIndex) applyTier(want, 'film playback');
      if (!ready) return Promise.resolve(false);
      return new Promise((resolve) => {
        const send = () => {
          if (busy || !spare) { setTimeout(send, 1); return; } // the previous field is still out
          showLook = Number.isFinite(snap.coh) ? snap.coh : null;
          shown = resolve;
          const x = snap.N ? snap.x.slice() : new Int16Array(0), v = snap.N ? snap.v.slice() : new Int16Array(0);
          worker.postMessage({ type: 'show', N: snap.N, x: x.buffer, v: v.buffer, field: spare, axis: { x: usu.x, z: usu.z, r: 0.1 } }, [spare.buffer, x.buffer, v.buffer]);
          spare = null; busy = true;
        };
        send();
      });
    },
    update(dt, tools, progress) {
      if (playback) return; // a film playback draws recorded snapshots instead (showSnapshot)
      acc += dt;
      for (const t of tools) if (t.reset) fresh.add(t.id); // kept until a step actually goes out
      if (!ready || busy || !spare) return;
      // never more than one stable step's worth: a machine that falls behind gets slow motion
      const frameDt = Math.min(acc, opts.maxSubsteps * opts.maxDt);
      acc = 0;
      const msgTools = tools.map((t) => {
        const c1 = [t.center.x, t.center.y, t.center.z];
        const q1 = t.quat ? [t.quat.x, t.quat.y, t.quat.z, t.quat.w] : [0, 0, 0, 1];
        // a tool that just appeared (a hand coming into tracking, a jump) starts still, not swept from where it was last seen
        const last = (!fresh.has(t.id) && prev.get(t.id)) || { c: c1, q: q1 };
        prev.set(t.id, { c: c1, q: q1 });
        return { id: t.id, group: t.group, kind: t.kind, r: t.r, h: t.h ?? 0, tack: t.tack ?? 0, mould: t.mould ?? 0, friction: t.friction ?? 0, c0: last.c, c1, q0: last.q, q1 };
      });
      fresh.clear();
      worker.postMessage({ type: 'step', dt: frameDt, tools: msgTools, progress, wet, youngsModulus, field: spare, axis: { x: usu.x, z: usu.z, r: 0.1 }, snap: wantSnap }, [spare.buffer]);
      wantSnap = false;
      spare = null;
      busy = true;
    },
  };
  return api;
}
