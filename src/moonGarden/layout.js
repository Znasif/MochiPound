// EnvironmentBuilder.BuildPrefab ported as pure data: the meshes (BufferGeometry per material), instance
// transforms and points of the Moon garden, in Unity coordinates, drawing from one System.Random(seed) in
// exactly the order the C# does: ground (no draws) -> island underside -> floating rocks -> bamboo variants ->
// bamboo placement -> bamboo bases -> cassia tree -> stone lantern -> stepping stones. (The C# then builds the
// usu pedestal and the sky texture from the same stream; both are left out: the pedestal is the team's usu
// stand, and the sky is the PNG Unity generated.) No rendering objects here, so a node script can import it.
import * as THREE from 'three';
import { S } from './settings.js';
import {
  f, Rng, DotNetRandom, DEG2RAD, RAD2DEG, clamp01, lerp, inverseLerp, smoothStep, lerpF, inverseLerpF, smoothStepF,
  deltaAngle, deltaAngleF, sinF, cosF, sqrtF, roundHalfEven, noise3, hash01, azimuth, azimuthF, skyDirection,
  eulerQ, lookRotation, lerpColor, mulColor, hex,
} from './unity.js';
import { MeshBuilder, smoothSphere, add, sub, mul, norm, cross, len, dot } from './meshBuilder.js';

const UP = [0, 1, 0], DOWN = [0, -1, 0];

// ---------------------------------------------------------------- ground profile
const OFFS = [0, 0.6, 1.5, 3, 5, 8, 12, 16, 22];
const LIFT = [0, -0.01, 0.01, 0.05, 0.09, 0.12, 0.16, 0.22, 0.28];
const BUMP = [0.004, 0.04, 0.09, 0.16, 0.22, 0.3, 0.4, 0.5, 0.55];

// EnvironmentBuilder.IslandEdge: island radius toward (x, z)
export function islandEdge(x, z) {
  let dx = 0, dz = 1;
  const sq = x * x + z * z;
  if (sq > 1e-6) { const m = Math.sqrt(sq); dx = x / m; dz = z / m; }
  const n = (noise3(dx * 2.2, 0, dz * 2.2, 1, 23) - 0.5) * 2 + (noise3(dx * 5, 0, dz * 5, 1, 31) - 0.5) * 0.6;
  return S.islandRadius * (1 + S.islandEdgeNoise * n);
}

// EnvironmentBuilder.GroundHeight (floating island), Unity coordinates
export function groundHeightU(x, z) {
  const R = S.clearingRadius;
  const r = Math.sqrt(x * x + z * z);
  if (r <= R) return lerp(0.015, 0, r / R) + (noise3(x, 0, z, 0.9, 3) - 0.5) * 0.008;
  const d = r - R;
  let k = 0;
  while (k < OFFS.length - 2 && d > OFFS[k + 1]) k++;
  const t = clamp01(inverseLerp(OFFS[k], OFFS[k + 1], d));
  const lift = lerp(LIFT[k], LIFT[k + 1], t), bump = lerp(BUMP[k], BUMP[k + 1], t);
  const noise = (noise3(x, 0, z, 0.22, 11) - 0.5) * 2 + (noise3(x, 0, z, 0.8, 5) - 0.5) * 0.6;
  const h = lift + noise * bump;
  const edge = islandEdge(x, z);
  return lerp(h, h - 0.35, smoothStep(0, 1, inverseLerp(edge - 1.8, edge, r)));
}

// EnvironmentBuilder.RandomDir (float32: its accept/reject decides how many draws it takes)
function randomDir(rng, minY, maxY) {
  const lo = f(minY), hi = f(maxY);
  for (let i = 0; i < 64; i++) {
    const x = rng.range(-1, 1), y = rng.range(-1, 1), z = rng.range(-1, 1);
    const m = sqrtF(f(f(f(x * x) + f(y * y)) + f(z * z)));
    if (m < f(0.05) || m > 1) continue;
    const vy = f(y / m);
    if (vy >= lo && vy <= hi) return [f(x / m), vy, f(z / m)];
  }
  return [0, 1, 0];
}

// ---------------------------------------------------------------- ground and island
function buildGround(rng, out) {
  const mb = new MeshBuilder(2); // 0 clearing, 1 forest floor
  const n = Math.max(36, S.clearingSides), R = S.clearingRadius, outer = S.islandRadius;
  let radii = [0, R * 0.5, R];
  for (const o of OFFS) if (o > 0) radii.push(R + o);
  radii = radii.filter((rr) => !(rr > outer - 0.5));
  const last = radii[radii.length - 1];
  for (let rr = last + 4; rr < outer - 1; rr += 4) radii.push(rr);
  radii.push(outer - 0.9, outer - 0.3);
  radii.push(Math.max(last + 1, outer));

  const rings = radii.map((r0, k) => {
    const ring = [];
    const offset = (k % 2) * 0.5;
    for (let i = 0; i < n; i++) {
      const a = (i + offset) / n * Math.PI * 2;
      let rk = r0;
      if (rk > R) rk = lerp(rk, rk * islandEdge(Math.sin(a), Math.cos(a)) / S.islandRadius, inverseLerp(R, S.islandRadius, rk));
      const x = Math.sin(a) * rk, z = Math.cos(a) * rk;
      ring.push([x, groundHeightU(x, z), z]);
    }
    return ring;
  });
  const centre = [0, groundHeightU(0, 0), 0];
  for (let k = 0; k < radii.length - 1; k++) {
    const s = radii[k + 1] <= R + 0.001 ? 0 : 1;
    const a = rings[k], b = rings[k + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (k === 0) { mb.tri(centre, b[i], b[j], UP, s); continue; }
      if (k % 2 === 1) { mb.tri(a[i], b[i], b[j], UP, s); mb.tri(a[i], b[j], a[j], UP, s); }
      else { mb.tri(a[i], b[i], a[j], UP, s); mb.tri(a[j], b[i], b[j], UP, s); }
    }
  }
  out.ground = mb;
  out.islandEdgeRing = rings[rings.length - 1];
  buildIslandUnderside(rng, out);
}

function buildIslandUnderside(rng, out) {
  const edge = out.islandEdgeRing, n = edge.length;
  const mb = new MeshBuilder(2); // 0 earth band, 1 rock
  const D = Math.max(3, S.islandDepth);
  const depth = [0, 0.55, 1.6, 3.2, 5.0, 7.0, 9.0, 1];
  const scale = [1, 0.97, 0.86, 0.68, 0.5, 0.32, 0.15, 0];
  depth[depth.length - 1] = D;
  for (let k = 1; k < depth.length - 1; k++) depth[k] *= D / 11;
  const rings = [];
  for (let k = 0; k < depth.length; k++) {
    const ring = [];
    for (let i = 0; i < n; i++) {
      const e = edge[i];
      if (k === 0) { ring.push(e); continue; }
      const jag = k < depth.length - 1 ? (noise3(e[0] * 0.35, k, e[2] * 0.35, 1, 41) - 0.5) * 0.28 : 0;
      const sc = scale[k] * (1 + jag);
      const y = e[1] - depth[k] + (rng.value - 0.5) * 0.6 * Math.min(1, k / 2);
      ring.push([e[0] * sc, y, e[2] * sc]);
    }
    rings.push(ring);
  }
  const tip = [0, -D - 1.5, 0], L = depth.length - 1;
  for (let k = 0; k < L; k++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, s = k === 0 ? 0 : 1;
      const a = rings[k][i], b = rings[k][j];
      const c = k + 1 === L ? tip : rings[k + 1][j];
      const d = k + 1 === L ? tip : rings[k + 1][i];
      const outward = add(norm([a[0] + b[0], 0, a[2] + b[2]]), mul(DOWN, 0.6));
      mb.tri(a, b, c, outward, s);
      if (k + 1 < L) mb.tri(a, c, d, outward, s);
    }
  }
  out.underside = mb;

  // small rocks drifting below and around the island
  const rb = new MeshBuilder(1);
  for (let i = 0; i < S.floatingRocks; i++) {
    let az = rng.range(0, 360);
    if (Math.abs(deltaAngle(az, S.moonAzimuth)) < 25) az += 50;
    const r = rng.range(S.islandRadius + 6, S.islandRadius + 26);
    const size = rng.range(0.8, 2.6);
    const c = add(mul(azimuth(az), r), mul(UP, rng.range(-14, -3)));
    rb.blob(c, [size, size * 0.8, size], 1, 0.3, rng.raw, 0);
    rb.blob(add(c, mul(DOWN, size * 0.7)), [size * 0.6, size * 0.9, size * 0.6], 1, 0.3, rng.raw, 0);
  }
  out.floatingRocks = rb;
}

// ---------------------------------------------------------------- bamboo
function bambooVariant(rng, index) {
  const mb = new MeshBuilder(2); // 0 stalk, 1 leaves
  const h = lerp(S.bambooHeight[0], S.bambooHeight[1], (index + 0.5) / Math.max(1, S.bambooVariants));
  const r = rng.range(S.bambooStalkRadius[0], S.bambooStalkRadius[1]);
  const segs = Math.max(3, roundHalfEven(h / Math.max(0.2, S.bambooSegmentLength)));
  const bendMag = rng.range(0.1, 0.35);
  const bend = bendMag * (rng.value < 0.5 ? -1 : 1);
  const P = (t) => [bend * t * t, h * t, 0];
  const Rad = (t) => r * lerp(1, 0.6, t);
  for (let k = 0; k < segs; k++) {
    const t0 = k / segs, t1 = (k + 1) / segs;
    const p0 = P(t0), p1 = P(t1), dir = norm(sub(p1, p0));
    mb.frustum(p0, p1, Rad(t0), Rad(t1), 6, 0, false, false, k * 0.3);
    if (k < segs - 1) mb.frustum(sub(p1, mul(dir, 0.025)), add(p1, mul(dir, 0.025)), Rad(t1) * 1.2, Rad(t1) * 1.2, 6, 0, true, true, k * 0.3);
    else mb.frustum(p1, add(p1, mul(dir, 0.04)), Rad(t1), 0, 6, 0, false, false);
  }
  // leaf clusters on short twigs, upper half only
  let left = Math.max(0, S.leavesPerStalk);
  while (left > 0) {
    const t = roundHalfEven(f(rng.range(0.45, 0.97) * segs)) / segs;
    const b = P(Math.min(1, Math.max(1 / segs, t)));
    const az = rng.range(0, f(Math.PI * 2));
    const outDir = [Math.cos(az), 0, Math.sin(az)];
    const twigDir = norm(add(outDir, mul(UP, rng.range(0.3, 0.8))));
    const tip = add(b, mul(twigDir, rng.range(0.25, 0.45)));
    mb.frustum(b, tip, 0.008, 0.005, 3, 0, false, false);
    const here = Math.min(left, rng.int(3, 6));
    left -= here;
    for (let l = 0; l < here; l++) {
      const spread = rng.range(-55, 55) * Math.PI / 180;
      const droop = rng.range(15, 55) * Math.PI / 180;
      // Quaternion.AngleAxis(spread, up) * outDir
      const horiz = [outDir[0] * Math.cos(spread) + outDir[2] * Math.sin(spread), 0, -outDir[0] * Math.sin(spread) + outDir[2] * Math.cos(spread)];
      const ld = norm(add(mul(horiz, Math.cos(droop)), mul(DOWN, Math.sin(droop))));
      const ln = rng.range(0.26, 0.42), w = ln * 0.16;
      let side = cross(ld, UP);
      side = dot(side, side) < 1e-4 ? [1, 0, 0] : norm(side);
      const mid = add(tip, mul(ld, ln * 0.4));
      const end = add(add(tip, mul(ld, ln)), mul(DOWN, ln * 0.12));
      mb.twoSided(tip, add(mid, mul(side, w)), end, 1);
      mb.twoSided(tip, end, sub(mid, mul(side, w)), 1);
    }
  }
  return { mb, radius: r, height: h };
}

const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _qt = new THREE.Quaternion(), _qy = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3();

function buildBamboo(rng, out) {
  const V = Math.min(8, Math.max(1, S.bambooVariants));
  const variants = [];
  for (let v = 0; v < V; v++) variants.push(bambooVariant(rng, v));

  const inner = f(S.bambooInnerRadius), outer = f(Math.max(inner + f(0.5), S.bambooOuterRadius));
  const midR = f(f(inner + outer) * f(0.5));
  const bias = f(S.bambooInnerBias), openW = f(f(S.openingWidth) * f(0.5)), jit = f(0.6);
  const crowd = f(f(0.22) * f(0.22));
  const placed = [], clumps = [], stalks = [];
  let made = 0, guard = 0, skippedBack = 0;
  const inOpening = (azDeg) => Math.abs(deltaAngleF(azDeg, S.openingDirection)) < openW;
  const eye = S.playerPosition;
  while (made < S.bambooCount && guard++ < S.bambooCount * 60) {
    const az = rng.range(0, 360);
    if (inOpening(az)) continue;
    const rr = lerpF(inner, outer, f(Math.pow(rng.value, bias)));
    const dirA = azimuthF(az);
    const cx = f(dirA[0] * rr), cz = f(dirA[2] * rr);
    const inClump = rng.int(2, 6);
    const clumpStalks = [];
    for (let j = 0; j < inClump && made < S.bambooCount; j++) {
      const px = f(cx + rng.range(-jit, jit)), pz = f(cz + rng.range(-jit, jit));
      const pr = sqrtF(f(f(px * px) + f(pz * pz)));
      if (pr < inner || pr > f(outer + f(0.5))) continue;
      if (inOpening(f(f(Math.atan2(px, pz)) * RAD2DEG))) continue;
      let crowded = false;
      for (const q of placed) {
        const dx = f(q[0] - px), dz = f(q[1] - pz);
        if (f(f(dx * dx) + f(dz * dz)) < crowd) { crowded = true; break; }
      }
      if (crowded) continue;
      placed.push([px, pz]);

      const rl = Math.sqrt(px * px + pz * pz), radial = [px / rl, 0, pz / rl];
      const lean = (S.outwardLean + rng.range(-2, 3)) * Math.PI / 180;
      _a.set(0, 1, 0);
      _b.set(radial[0] * Math.tan(lean), 1, radial[2] * Math.tan(lean)).normalize();
      _qt.setFromUnitVectors(_a, _b);
      const yaw = rng.range(0, 360);
      eulerQ(0, yaw, 0, _qy);
      const rot = _qt.clone().multiply(_qy);
      const sc = rng.range(0.85, 1.15);
      const py = groundHeightU(px, pz);
      const vi = rng.int(0, V);
      // behind the player (away from the Moon): some stalks left out; same draws, so the rest keeps its layout
      const back = Math.abs(deltaAngleF(f(f(Math.atan2(px, pz)) * RAD2DEG), f(S.moonAzimuth + 180)));
      const thin = f(f(S.bambooBackThinning) * f(1 - smoothStepF(0, 1, inverseLerpF(60, 95, back))));
      if (thin > 0 && hash01(f(f(px * f(1.7)) + f(3.1)), f(f(pz * f(1.7)) + f(3.1))) < thin) { made++; skippedBack++; continue; }
      clumpStalks.push([px, py, pz]);
      let sx = sc, sy = sc;
      if (S.earthViewClear) {
        // toward the Earth: younger, lower bamboo so the view (and the ending's flight) stays open
        const dx = px - eye[0], dz = pz - eye[2];
        const off = Math.abs(deltaAngle(Math.atan2(dx, dz) * 180 / Math.PI, S.earthAzimuth));
        const w = 1 - smoothStep(0, 1, inverseLerp(S.earthViewHalfWidth, S.earthViewHalfWidth + S.earthViewFalloff, off));
        if (w > 0) {
          const hh = lerp(S.bambooHeight[0], S.bambooHeight[1], (vi + 0.5) / V) * sc;
          const allowed = S.earthViewEyeHeight + Math.hypot(dx, dz) * Math.tan(S.earthViewMaxElevation * Math.PI / 180);
          const k = lerp(1, Math.min(1, Math.max(0.25, allowed / hh)) * lerp(0.85, 1, hash01(px, pz)), w);
          sx = sc * Math.sqrt(k); sy = sc * k;
        }
      }
      const m = new THREE.Matrix4().compose(_p.set(px, py - S.bambooSink, pz), rot, _s.set(sx, sy, sx));
      stalks.push({ variant: vi, near: pr < midR, matrix: m, x: px, z: pz, radius: variants[vi].radius * sx });
      made++;
    }
    if (clumpStalks.length) clumps.push(clumpStalks);
  }
  out.bambooVariants = variants;
  out.stalks = stalks;
  out.bambooSkipped = skippedBack;
  buildBambooBases(rng, clumps, out);
}

// a low earth mound under every clump, dry leaf litter and a few pebbles around it
function buildBambooBases(rng, clumps, out) {
  const mb = new MeshBuilder(3); // 0 earth, 1 litter, 2 stone
  for (const clump of clumps) {
    let cx = 0, cz = 0;
    for (const p of clump) { cx += p[0]; cz += p[2]; }
    cx /= clump.length; cz /= clump.length;
    let spread = 0;
    for (const p of clump) spread = Math.max(spread, Math.hypot(p[0] - cx, p[2] - cz));
    const rad = spread + rng.range(0.3, 0.45);
    const gy = groundHeightU(cx, cz);
    const sy = rng.range(0.13, 0.18), sz = rad * rng.range(0.8, 1);
    mb.blob([cx, gy - 0.05, cz], [rad, sy, sz], 1, 0.25, rng.raw, 0);
    const leaves = clump.length * 5;
    for (let i = 0; i < leaves; i++) {
      const a = rng.range(0, f(Math.PI * 2));
      const d = rad * rng.range(0.75, 1.6);
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      const q = [x, groundHeightU(x, z) + 0.012, z];
      const yaw = rng.range(0, 360) * Math.PI / 180, ln = rng.range(0.14, 0.24);
      const dir = [Math.sin(yaw), 0, Math.cos(yaw)];
      const side = mul(cross(UP, dir), ln * 0.18);
      const back = sub(q, mul(dir, ln * 0.5)), front = add(q, mul(dir, ln * 0.5));
      mb.twoSided(back, add(add(q, side), [0, 0.01, 0]), front, 1);
      mb.twoSided(back, front, add(sub(q, side), [0, 0.01, 0]), 1);
    }
    const pebbles = rng.int(1, 4);
    for (let i = 0; i < pebbles; i++) {
      const a = rng.range(0, f(Math.PI * 2));
      const d = rad * rng.range(0.85, 1.25);
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      const s = rng.range(0.05, 0.12);
      const sz2 = s * rng.range(0.7, 1);
      mb.blob([x, groundHeightU(x, z) + s * 0.15, z], [s, s * 0.55, sz2], 0, 0.2, rng.raw, 2);
    }
  }
  out.bambooBases = mb;
  out.clumpCount = clumps.length;
}

// ---------------------------------------------------------------- cassia tree
function buildTree(rng, out) {
  const mb = new MeshBuilder(3); // 0 trunk, 1 canopy, 2 gold
  const H = S.treeHeight, R = S.canopyRadius;
  const T = (t) => [Math.sin(t * 2.2) * 0.18, H * 0.62 * t, Math.sin(t * 1.3) * 0.08];
  const tp = [], tr = [];
  for (let k = 0; k < 9; k++) { const t = k / 8; tp.push(T(t)); tr.push(lerp(0.2, 0.09, t)); }
  tp.push(add(T(1), mul(norm(sub(T(1), T(0.9))), 0.35))); tr.push(0.07);
  mb.tube(tp, tr, 8, 0, true, false);
  for (let i = 0; i < 5; i++) { // root flare
    const d = azimuth(i * 72 + rng.range(-15, 15));
    mb.tube([add(mul(d, 0.02), mul(UP, 0.38)), add(mul(d, 0.2), mul(UP, 0.14)), add(mul(d, 0.48), mul(DOWN, 0.03))], [0.09, 0.06, 0.025], 5, 0, false, true);
  }
  const c = add(T(1), mul(UP, R * 0.55));
  for (let i = 0; i < 3; i++) { // branches
    const tb = rng.range(0.6, 0.95);
    const start = T(tb);
    const dir = norm(add(mul(azimuth(i * 120 + rng.range(-30, 30)), 0.8), UP));
    const end = add(start, mul(dir, R * 0.75));
    const mid = add(mul(add(start, end), 0.5), mul(DOWN, 0.06));
    const r0 = lerp(0.2, 0.09, tb) * 0.75;
    mb.tube([sub(start, mul(dir, 0.04)), mid, end], [r0, lerp(r0, 0.035, 0.5), 0.035], 6, 0, false, true);
  }
  mb.blob(c, mul([1, 0.8, 1], R * 0.78), 1, 0.12, rng.raw, 1);
  for (let i = 0; i < Math.max(0, S.canopyBlobs - 1); i++) {
    const d = randomDir(rng, -0.3, 0.8);
    const pos = add(c, [d[0] * R * 0.7, d[1] * R * 0.45, d[2] * R * 0.7]);
    const r = R * rng.range(0.38, 0.55);
    mb.blob(pos, [r, r * 0.85, r], 1, 0.15, rng.raw, i % 3 === 0 ? 2 : 1);
  }
  const blossoms = [];
  for (let i = 0; i < S.blossomCount; i++) {
    const d = randomDir(rng, -0.2, 1);
    const p = add(c, [d[0] * R * 1.05, d[1] * R * 0.85, d[2] * R * 1.05]);
    const s = rng.range(0.05, 0.09);
    mb.blob(p, [s, s, s], 0, 0.1, rng.raw, 2);
    blossoms.push(p);
  }
  const yaw = rng.range(0, 360);
  const q = eulerQ(0, yaw, 0);
  const pos = new THREE.Vector3(...S.treePosition);
  out.tree = {
    mb, position: pos, quaternion: q, yaw,
    blossoms: blossoms.map((b) => new THREE.Vector3(...b).applyQuaternion(q).add(pos)),
  };
}

// ---------------------------------------------------------------- stone lanterns
function buildLanterns(rng, out) {
  const mb = new MeshBuilder(2); // 0 stone, 1 glowing light box
  const u = (y) => [0, y, 0];
  mb.frustum(u(0), u(0.12), 0.26, 0.22, 6, 0);
  mb.frustum(u(0.12), u(0.6), 0.085, 0.075, 6, 0);
  mb.frustum(u(0.6), u(0.7), 0.2, 0.24, 6, 0);
  for (let i = 0; i < 4; i++) {
    const d = mul(azimuth(45 + 90 * i), 0.13);
    mb.frustum(add(d, u(0.7)), add(d, u(0.92)), 0.028, 0.028, 4, 0, false, false);
  }
  mb.frustum(u(0.72), u(0.9), 0.1, 0.1, 4, 1, true, true, Math.PI / 4);
  mb.frustum(u(0.92), u(1.08), 0.36, 0.06, 6, 0);
  mb.blob(u(1.14), [0.06, 0.06, 0.06], 0, 0.05, rng.raw, 0);
  out.lanternMesh = mb;
  out.lanterns = S.lanternPositions.map((p) => {
    const q = new THREE.Quaternion();
    const to = [-p[0], 0, -p[2]]; // toward the mortar (at the origin)
    if (to[0] * to[0] + to[2] * to[2] > 1e-4) lookRotation(to, q);
    return { position: new THREE.Vector3(...p), quaternion: q, light: new THREE.Vector3(p[0], p[1] + 0.81, p[2]) };
  });
}

// ---------------------------------------------------------------- stepping stones
function buildStones(rng, out) {
  const dirP = azimuth(S.stonePathDirection);
  const pathEnd = islandEdge(dirP[0], dirP[2]) - 1.1;
  const count = Math.max(S.stoneCount, roundHalfEven(f((pathEnd - S.stonePathStart) / 0.95)));
  const mb = new MeshBuilder(1);
  const points = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const r = lerp(S.stonePathStart, pathEnd, t);
    const az = S.stonePathDirection + Math.sin(t * Math.PI * 2) * 10;
    const d = azimuth(az);
    const x = d[0] * r + rng.range(-0.1, 0.1), z = d[2] * r + rng.range(-0.1, 0.1);
    const size = rng.range(0.3, 0.45) * lerp(1, 0.8, t);
    const y = groundHeightU(x, z);
    const sz = size * rng.range(0.75, 1);
    mb.blob([x, y, z], [size, size * 0.22, sz], 1, 0.15, rng.raw, 0);
    points.push({ x, y: y + size * 0.22, z, size });
  }
  out.stones = mb;
  out.stonePoints = points;
  out.pathEnd = pathEnd;
}

// ---------------------------------------------------------------- Moon and Earth meshes (their own Rng(seed + 17))
function buildCelestial(out) {
  const crng = new Rng(S.seed + 17);
  const craters = [];
  for (let i = 0; i < 18; i++) { const dir = randomDir(crng, -1, 1); craters.push({ dir, size: crng.range(0.06, 0.2) }); }
  const moonBase = lerpColor(S.mochi, S.moonlight, 0.5), maria = mulColor(S.moonlight, 0.74);
  const mix = (a, b, t) => lerpColor(a, b, t);
  out.moonGeometry = smoothSphere(3, (p) => {
    const nn = noise3(p[0], p[1], p[2], 1.6, 11);
    let c = mix(moonBase, maria, smoothStep(0, 1, inverseLerp(0.52, 0.62, nn)));
    for (const { dir, size } of craters) {
      const cosA = Math.min(1, Math.max(-1, dot(p, dir) / Math.sqrt(dot(p, p) * dot(dir, dir))));
      const d = Math.acos(cosA);
      if (d < size) c = mix(c, maria, 0.35 * (1 - d / size));
    }
    return c;
  });
  const sand = [0.79, 0.7, 0.49];
  out.earthGeometry = smoothSphere(3, (p) => {
    const nn = noise3(p[0], p[1], p[2], 1.8, 3);
    let c = mix(S.earthOcean, mulColor(S.earthOcean, 0.75), inverseLerp(0.5, 0.3, nn));
    if (nn > 0.53) c = nn < 0.555 ? sand : S.earthLand;
    if (Math.abs(p[1]) > 0.84) c = [1, 1, 1];
    const cloud = noise3(p[0], p[1], p[2], 3.3, 7);
    if (cloud > 0.6) c = mix(c, [1, 1, 1], inverseLerp(0.6, 0.72, cloud) * 0.75);
    return c;
  });
  const moonDir = skyDirection(S.moonAzimuth, S.moonElevation);
  const earthDir = skyDirection(S.earthAzimuth, S.earthElevation);
  out.moon = { dir: moonDir, position: new THREE.Vector3(...mul(moonDir, S.moonDistance)), quaternion: lookRotation(mul(moonDir, -1)), scale: S.moonRadius };
  const tilt = eulerQ(-20, 0, 23);
  const az90 = azimuth(S.earthAzimuth + 90);
  out.earth = {
    dir: earthDir,
    position: new THREE.Vector3(...mul(earthDir, S.earthDistance)),
    quaternion: lookRotation(mul(earthDir, -1)).multiply(tilt),
    scale: S.earthRadius,
    glowQuaternion: tilt.clone().invert(),
    lightDir: norm(add(mul(earthDir, -0.6), mul(az90, 0.8))),
  };
}

// ---------------------------------------------------------------- team props (tzhu235): where Unity puts them
function propPlacements(out) {
  const gh = groundHeightU;
  const face = (x, z) => lookRotation(x * x + z * z > 1e-4 ? [-x, 0, -z] : [0, 0, 1]);
  const place = (name, x, y, z, yaw, onGround) => {
    const py = onGround ? y + gh(x, z) : y;
    return { name, position: new THREE.Vector3(x, py, z), quaternion: yaw === null ? face(x, z) : eulerQ(0, yaw, 0) };
  };
  const pathDir = azimuth(S.stonePathDirection);
  const side = norm(cross(UP, pathDir));
  const sign = sub(mul(pathDir, S.stonePathStart - 0.3), mul(side, 0.95));
  const fly = [-5.6, 1.3, 2.6];
  const T = S.treePosition;
  out.props = {
    lanternStand: place('01_Paper_Lanterns', 3.5, 0, 0.4, null, true),
    chime: place('03_Bamboo_Wind_Chime', T[0] - 1.0, T[1] + S.treeHeight * 0.79, T[2] - 1.6, 0, false),
    bench: place('04_Bench_With_Basket', -3.1, 0, -1.9, null, true),
    sign: place('05_Moon_Rabbit_Sign', sign[0], 0, sign[2], null, true),
    fountain: place('Bamboo_Fountain', 3.0, 0, -2.6, null, true),
    mossy: place('06_Mossy_Stones_And_Leaves', -4.7, 0, -0.9, 30, true),
    fireflies: place('Firefly_Swarm', fly[0], fly[1] + gh(fly[0], fly[2]), fly[2], 0, false),
  };
}

// SkyMist puffs: its own System.Random(9) (angle deg, radius, height, size, phase)
function skyMist(out) {
  const r = new DotNetRandom(9);
  const radius = [S.islandRadius - 2, S.islandRadius + 16], height = [-9, -1.5], size = [7, 15];
  const puffs = [];
  for (let i = 0; i < S.skyMistPuffs; i++) {
    const a = f(r.nextDouble()) * 360;
    const rr = lerp(radius[0], radius[1], f(r.nextDouble()));
    const hh = lerp(height[0], height[1], f(r.nextDouble()));
    const ss = lerp(size[0], size[1], f(r.nextDouble()));
    puffs.push({ angle: a, radius: rr, height: hh, size: ss, phase: f(r.nextDouble()) * 10 });
  }
  out.mist = puffs;
}

export function buildLayout() {
  const rng = new Rng(S.seed);
  const out = { gh0: groundHeightU(0, 0) };
  buildGround(rng, out);
  buildBamboo(rng, out);
  buildTree(rng, out);
  buildLanterns(rng, out);
  buildStones(rng, out);
  buildCelestial(out);
  propPlacements(out);
  skyMist(out);
  return out;
}

export { hex };
