import * as THREE from 'three';
import { usuShape } from './props.js';
import { usuSdf } from './usuShape.js';

// Exact collision between the mallet (kine) and the solid things around it, which the dough simulation
// doesn't do (it only pushes dough out of tools). Both sides are read from the meshes in src/props.js,
// so the shapes that collide are exactly the shapes you see:
//  - the mortar is an exact solid of revolution: the cross-section its LatheGeometry is made from, the rim
//    RingGeometry (a plate from the body's top to the ring), the iron bands (TorusGeometry, exact tori),
//    the straw mat (CircleGeometry) and the courtyard ground mesh. For a solid of revolution the 3D distance
//    to its surface is the 2D distance in the cross-section, so the mortar's signed distance is exact;
//  - the mallet is its head (CylinderGeometry), bands (TorusGeometry) and tapered handle (CylinderGeometry),
//    each with its exact signed distance;
//  - hands are spheres: the tracked hand's joints ({ center, r }, src/hands.js) or sphere meshes.
// Contact: the deepest point of the mallet's true surface inside the wood or the ground (a coarse scan of
// each surface patch, then refined to ~1e-5 of its size), plus the mortar's convex corners (the rim's
// edges, the base) poking into the mallet, plus the hand spheres. Each contact is resolved until nothing
// overlaps (1 micron, i.e. numerical zero; no clearance is kept): each contact is moved exactly back to
// the surface (the move is bisected on that contact's own distance), so the mallet rests touching. A
// contact pivots the kine about its origin (the hands holding it), so a held mallet stays in the hand and
// swings off the obstacle; a push straight along the handle moves it instead. Motion is marched toward
// each frame's pose in steps no longer than the free space around the mallet allows (and never longer
// than its thinnest part, the handle's radius, near something), so a swing can't pass through.
// Where the deepest point was last time is remembered, so a contact that persists is cheap to follow.
// Kine-local frame (src/props.js): origin at the hands, handle along -Z, head axis +Y.

const EPS = 1e-6; // m: overlap below this counts as touching (numerical zero)

export function createKineContact({ kine, usu, ground = null }) {
  // ---------------- the mortar ----------------
  // its exact shape (src/props.js usuShape) and distance (src/usuShape.js), shared with the dough
  const shape = usuShape(usu);
  const usuInv = new THREE.Matrix4().copy(usu.matrixWorld).invert();
  const poly = shape.poly, nP = poly.length;
  // convex corners of the cross-section (each is a circle on the mortar): checked against the mallet
  const corners = [];
  for (let i = 0; i < nP; i++) {
    const a = poly[(i + nP - 1) % nP], b = poly[i], c = poly[(i + 1) % nP];
    if (b[0] <= 0) continue;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross > 1e-12) corners.push(b);
  }
  const matR = shape.mat ? shape.mat.r : 0, matY = shape.mat ? shape.mat.y : 0;
  let groundY = null;
  if (ground) { ground.updateMatrixWorld(true); groundY = new THREE.Vector3().setFromMatrixPosition(ground.matrixWorld).y; }

  const nb = [0, 0, 0];
  let nearest = 'usu'; // which surface the last sceneSdf call was nearest to
  const stats = { sceneSdf: 0, malletSdf: 0 }; // evaluation counts (the test reports them)
  // signed distance (negative inside) from a world point to the mortar + ground; writes the outward normal
  function sceneSdf(p, n) {
    stats.sceneSdf++;
    nearest = 'usu';
    let sd = usuSdf(shape, p.x, p.y, p.z, n ? nb : undefined);
    if (n) n.set(nb[0], nb[1], nb[2]);
    // ground (with the mat on it; the mortar stands upright on both)
    if (groundY !== null) {
      const rho = Math.hypot(p.x - shape.x, p.z - shape.z);
      const top = rho < matR ? Math.max(groundY, usu.matrixWorld.elements[13] + matY) : groundY;
      const g = p.y - top;
      if (g < sd) { sd = g; nearest = 'ground'; if (n) n.set(0, 1, 0); }
    }
    return sd;
  }

  // ---------------- the mallet ----------------
  kine.updateMatrixWorld(true);
  const parts = [];
  for (const o of kine.children) {
    if (!o.isMesh) continue;
    o.updateMatrix();
    const g = o.geometry, P = g.parameters, m = o.matrix.clone(), inv = o.matrix.clone().invert();
    if (g.type === 'CylinderGeometry') parts.push({ kind: 'cone', h: P.height / 2, r1: P.radiusBottom, r2: P.radiusTop, m, inv });
    else if (g.type === 'TorusGeometry') parts.push({ kind: 'torus', R: P.radius, t: P.tube, m, inv });
  }
  const minRadius = Math.min(...parts.map((p) => (p.kind === 'cone' ? Math.min(p.r1, p.r2) : p.t)));
  // exact signed distances in each part's geometry space
  function partSdf(pt, q) {
    if (pt.kind === 'cone') { // capped cone along Y: radius r1 at y = -h, r2 at y = +h
      const qx = Math.hypot(q.x, q.z), qy = q.y, h = pt.h, r1 = pt.r1, r2 = pt.r2;
      const k2x = r2 - r1, k2y = 2 * h;
      const cax = qx - Math.min(qx, qy < 0 ? r1 : r2), cay = Math.abs(qy) - h;
      const t = Math.min(1, Math.max(0, ((r2 - qx) * k2x + (h - qy) * k2y) / (k2x * k2x + k2y * k2y)));
      const cbx = qx - r2 + k2x * t, cby = qy - h + k2y * t;
      const s = cbx < 0 && cay < 0 ? -1 : 1;
      return s * Math.sqrt(Math.min(cax * cax + cay * cay, cbx * cbx + cby * cby));
    }
    const a = Math.hypot(q.x, q.y) - pt.R; // torus around its Z axis
    return Math.hypot(a, q.z) - pt.t;
  }
  const kp = new THREE.Vector3(), gq = new THREE.Vector3(), iq = new THREE.Quaternion();
  // signed distance from a world point to the mallet posed at (pos, quat)
  function malletSdf(p, pos, quat) {
    stats.malletSdf++;
    iq.copy(quat).invert();
    kp.copy(p).sub(pos).applyQuaternion(iq);
    let sd = Infinity;
    for (const pt of parts) sd = Math.min(sd, partSdf(pt, gq.copy(kp).applyMatrix4(pt.inv)));
    return sd;
  }
  const gp = new THREE.Vector3();
  function malletGrad(p, pos, quat, out) { // numerical gradient of the exact distance
    const e = 1e-5;
    gp.copy(p); gp.x += e; const fx1 = malletSdf(gp, pos, quat); gp.x -= 2 * e; const fx0 = malletSdf(gp, pos, quat); gp.x += e;
    gp.y += e; const fy1 = malletSdf(gp, pos, quat); gp.y -= 2 * e; const fy0 = malletSdf(gp, pos, quat); gp.y += e;
    gp.z += e; const fz1 = malletSdf(gp, pos, quat); gp.z -= 2 * e; const fz0 = malletSdf(gp, pos, quat);
    out.set(fx1 - fx0, fy1 - fy0, fz1 - fz0);
    const l = out.length();
    return l > 1e-12 ? out.multiplyScalar(1 / l) : out.set(0, 1, 0);
  }

  // surface patches of the mallet, in geometry space: point(a, b) for a, b in [0, 1]
  const patches = [];
  for (const pt of parts) {
    if (pt.kind === 'cone') {
      const pieces = Math.max(1, Math.ceil((2 * pt.h) / (4 * Math.max(pt.r1, pt.r2)))); // long handle: several pieces
      for (let k = 0; k < pieces; k++) {
        const t0 = k / pieces, t1 = (k + 1) / pieces;
        patches.push({ part: pt, wrap: true, f: (a, b, o) => { const t = t0 + (t1 - t0) * b, r = pt.r1 + (pt.r2 - pt.r1) * t, th = a * 2 * Math.PI; return o.set(r * Math.cos(th), -pt.h + 2 * pt.h * t, r * Math.sin(th)); } });
      }
      patches.push({ part: pt, wrap: true, f: (a, b, o) => { const th = a * 2 * Math.PI, r = pt.r2 * b; return o.set(r * Math.cos(th), pt.h, r * Math.sin(th)); } });
      patches.push({ part: pt, wrap: true, f: (a, b, o) => { const th = a * 2 * Math.PI, r = pt.r1 * b; return o.set(r * Math.cos(th), -pt.h, r * Math.sin(th)); } });
    } else {
      patches.push({ part: pt, wrap: true, wrapB: true, f: (a, b, o) => { const u = a * 2 * Math.PI, v = b * 2 * Math.PI, rr = pt.R + pt.t * Math.cos(v); return o.set(rr * Math.cos(u), rr * Math.sin(u), pt.t * Math.sin(v)); } });
    }
  }
  // each patch's bounding sphere (kine-local), from its points
  const sp = new THREE.Vector3();
  for (const pa of patches) {
    const c = new THREE.Vector3(), samples = [];
    for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) { pa.f(i / 16, j / 16, sp); sp.applyMatrix4(pa.part.m); samples.push(sp.clone()); c.add(sp); }
    c.multiplyScalar(1 / samples.length);
    let r = 0;
    for (const s of samples) r = Math.max(r, s.distanceTo(c));
    // + the largest gap a 16-step sampling of these surfaces can leave
    const span = pa.part.kind === 'cone' ? Math.max(pa.part.r1, pa.part.r2) : pa.part.R + pa.part.t;
    pa.center = c; pa.radius = r + span * (1 - Math.cos(Math.PI / 16));
  }

  // ---------------- deepest overlap of the mallet posed at (pos, quat) ----------------
  const wp = new THREE.Vector3(), tn = new THREE.Vector3(), pc = new THREE.Vector3(), sc = new THREE.Vector3();
  // the deepest contact: type 'A' = a point of the mallet (body, kine-local) inside the scene; 'B' = a point
  // of the mortar (world) inside the mallet; 'C' = a hand sphere (world centre, radius) inside the mallet
  const hit = { pen: 0, type: null, kind: null, body: new THREE.Vector3(), point: new THREE.Vector3(), r: 0, n: new THREE.Vector3() };
  // every overlapping contact found (one per patch, corner or hand), resolved together
  const pool = Array.from({ length: 64 }, () => ({ pen: 0, type: null, kind: null, body: new THREE.Vector3(), point: new THREE.Vector3(), r: 0, n: new THREE.Vector3() }));
  let nContacts = 0;
  function record(src) {
    if (nContacts >= pool.length) return;
    const c = pool[nContacts++];
    c.pen = src.pen; c.type = src.type; c.kind = src.kind; c.r = src.r;
    c.body.copy(src.body); c.point.copy(src.point); c.n.copy(src.n);
  }
  const cand = { pen: 0, type: null, kind: null, body: new THREE.Vector3(), point: new THREE.Vector3(), r: 0, n: new THREE.Vector3() };
  function worldOf(pa, a, b, pos, quat, out) { return pa.f(a, b, out).applyMatrix4(pa.part.m).applyQuaternion(quat).add(pos); }
  function penAt(pa, a, b, pos, quat) { return -sceneSdf(worldOf(pa, a, b, pos, quat, wp), null); }
  const wrapA = (x) => x - Math.floor(x);
  const clampB = (pa, x) => (pa.wrapB ? x - Math.floor(x) : Math.min(1, Math.max(0, x)));

  // local ascent of the penetration over a patch: numerical gradient, growing / halving steps
  function refine(pa, a, b, pos, quat) {
    let f = penAt(pa, a, b, pos, quat), step = 0.05;
    for (let it = 0; it < 40 && step > 1e-7; it++) {
      const h = 1e-5;
      const ga = (penAt(pa, wrapA(a + h), b, pos, quat) - penAt(pa, wrapA(a - h), b, pos, quat)) / (2 * h);
      const b1 = clampB(pa, b + h), b0 = clampB(pa, b - h);
      const gb = b1 !== b0 ? (penAt(pa, a, b1, pos, quat) - penAt(pa, a, b0, pos, quat)) / (b1 - b0) : 0;
      const gl = Math.hypot(ga, gb);
      if (gl < 1e-12) break;
      let moved = false;
      while (step > 1e-7) {
        const na = wrapA(a + (step * ga) / gl), nb = clampB(pa, b + (step * gb) / gl), nf = penAt(pa, na, nb, pos, quat);
        if (nf > f) { a = na; b = nb; f = nf; moved = true; step *= 1.5; break; }
        step *= 0.5;
      }
      if (!moved) break;
    }
    return { f, a, b };
  }

  function deepest(pos, quat, hands, scan) {
    hit.pen = EPS; hit.type = null; nContacts = 0;
    // (A) the mallet's surface inside the mortar or the ground
    for (const pa of patches) {
      pc.copy(pa.center).applyQuaternion(quat).add(pos);
      if (sceneSdf(pc, null) > pa.radius) { pa.warm = null; continue; } // the whole patch is clear
      let best = null;
      if (pa.warm) best = refine(pa, pa.warm.a, pa.warm.b, pos, quat); // where it was deepest last time
      if (scan || !pa.warm) {
        // a scan of the patch (once per step), so a new contact region is not missed
        const NA = 24, NB = 6;
        let sf = -Infinity, sa = 0, sb = 0;
        for (let i = 0; i < NA; i++) for (let j = 0; j <= NB; j++) { const f = penAt(pa, i / NA, j / NB, pos, quat); if (f > sf) { sf = f; sa = i / NA; sb = j / NB; } }
        if (!best || sf > best.f) { const r2 = refine(pa, sa, sb, pos, quat); if (!best || r2.f > best.f) best = r2; }
      }
      pa.warm = best.f > -pa.radius ? { a: best.a, b: best.b } : null;
      if (best.f > EPS) {
        cand.pen = best.f; cand.type = 'A'; cand.r = 0;
        pa.f(best.a, best.b, cand.body).applyMatrix4(pa.part.m);
        cand.point.copy(cand.body).applyQuaternion(quat).add(pos);
        sceneSdf(cand.point, cand.n); cand.kind = nearest;
        record(cand);
        if (cand.pen > hit.pen) { hit.pen = cand.pen; hit.type = 'A'; hit.kind = cand.kind; hit.r = 0; hit.body.copy(cand.body); hit.point.copy(cand.point); hit.n.copy(cand.n); }
      }
    }
    // (B) the mortar's convex corners (circles) inside the mallet
    for (const cr of corners) {
      let near = false; // quick reject: the corner circle passes no patch's bounding sphere
      for (const pa of patches) {
        sc.copy(pa.center).applyQuaternion(quat).add(pos).applyMatrix4(usuInv);
        if (Math.hypot(Math.hypot(sc.x, sc.z) - cr[0], sc.y - cr[1]) < pa.radius) { near = true; break; }
      }
      if (!near) { cr.warm = null; continue; }
      const circ = (phi, out) => out.set(cr[0] * Math.cos(phi), cr[1], cr[0] * Math.sin(phi)).applyMatrix4(usu.matrixWorld);
      const g = (phi) => -malletSdf(circ(phi, wp), pos, quat);
      let bp = cr.warm ?? 0, bf = cr.warm != null ? g(bp) : -Infinity;
      if (scan || cr.warm == null) for (let i = 0; i < 64; i++) { const phi = (i / 64) * 2 * Math.PI, f = g(phi); if (f > bf) { bf = f; bp = phi; } }
      let st = Math.PI / 64;
      while (st > 1e-8) { const f1 = g(bp + st), f0 = g(bp - st); if (f1 > bf) { bf = f1; bp += st; } else if (f0 > bf) { bf = f0; bp -= st; } else st *= 0.5; }
      cr.warm = bp;
      if (bf > EPS) {
        cand.pen = bf; cand.type = 'B'; cand.r = 0; cand.kind = 'usu'; circ(bp, cand.point);
        malletGrad(cand.point, pos, quat, tn); cand.n.copy(tn).negate(); // move the mallet off the corner
        record(cand);
        if (bf > hit.pen) { hit.pen = bf; hit.type = 'B'; hit.kind = 'usu'; hit.point.copy(cand.point); hit.n.copy(cand.n); }
      }
    }
    // (C) hands (spheres)
    for (const h of hands) {
      const r = sphereOf(h, wp);
      const pen = r - malletSdf(wp, pos, quat);
      if (pen > EPS) {
        cand.pen = pen; cand.type = 'C'; cand.r = r; cand.kind = 'hand'; cand.point.copy(wp);
        malletGrad(wp, pos, quat, tn); cand.n.copy(tn).negate();
        record(cand);
        if (pen > hit.pen) { hit.pen = pen; hit.type = 'C'; hit.r = r; hit.kind = 'hand'; hit.point.copy(wp); hit.n.copy(cand.n); }
      }
    }
    return hit.type ? hit : null;
  }

  // a hand sphere: { center, r } (a tracked joint) or a sphere mesh; writes its centre, returns its radius
  const hsc = new THREE.Vector3();
  function sphereOf(h, out) {
    if (h.center) { out.copy(h.center); return h.r; }
    h.updateMatrixWorld(true);
    out.setFromMatrixPosition(h.matrixWorld);
    return h.geometry.parameters.radius * hsc.setFromMatrixScale(h.matrixWorld).x;
  }

  // the clearance the mallet surely has (0 if it might be touching): how far it can move in one step
  function clearance(pos, quat, hands) {
    let c = Infinity;
    for (const pa of patches) { pc.copy(pa.center).applyQuaternion(quat).add(pos); c = Math.min(c, sceneSdf(pc, null) - pa.radius); }
    for (const h of hands) { const r = sphereOf(h, wp); c = Math.min(c, malletSdf(wp, pos, quat) - r); }
    return Math.max(0, c);
  }

  // ---------------- resolve ----------------
  const tPos = new THREE.Vector3(), tQuat = new THREE.Quaternion(), tScale = new THREE.Vector3();
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion();
  const prevPos = new THREE.Vector3(), prevQuat = new THREE.Quaternion(), prevTarget = new THREE.Vector3();
  const rv = new THREE.Vector3(), rq = new THREE.Quaternion(), ax = new THREE.Vector3(), m4 = new THREE.Matrix4(), inv = new THREE.Matrix4();
  const lastN = new THREE.Vector3(), lastPoint = new THREE.Vector3();
  const ends = [];
  for (const pt of parts) {
    if (pt.kind === 'cone') ends.push(new THREE.Vector3(0, pt.h, 0).applyMatrix4(pt.m), new THREE.Vector3(0, -pt.h, 0).applyMatrix4(pt.m));
    else ends.push(new THREE.Vector3(pt.R + pt.t, 0, 0).applyMatrix4(pt.m));
  }
  const e0 = new THREE.Vector3(), e1 = new THREE.Vector3(), mp = new THREE.Vector3(), mq = new THREE.Quaternion(), cp = new THREE.Vector3();
  let hasPrev = false, inContact = false, lastKind = 'usu';

  // a contact's own distance (>= 0 = clear) with the mallet moved by s: rotated about the grip by s rad
  // around `ax`, or pushed along `dir` by s m
  const dir = new THREE.Vector3(), sumN = new THREE.Vector3(), sumP = new THREE.Vector3();
  function contactDist(c, rotate, s) {
    if (rotate) { rq.setFromAxisAngle(ax, s); mq.copy(rq).multiply(quat); mp.copy(pos); }
    else { mq.copy(quat); mp.copy(pos).addScaledVector(dir, s); }
    if (c.type === 'A') return sceneSdf(cp.copy(c.body).applyQuaternion(mq).add(mp), null);
    if (c.type === 'B') return malletSdf(c.point, mp, mq);
    return malletSdf(c.point, mp, mq) - c.r;
  }
  function allClear(rotate, s) {
    for (let i = 0; i < nContacts; i++) if (contactDist(pool[i], rotate, s) < 0) return false;
    return true;
  }
  // until nothing overlaps. All current contacts are cleared together by one move: their pushes combined
  // (each normal weighted by its depth), applied at their depth-weighted centre, and bisected to the
  // smallest move that clears every one of them, so the mallet ends touching, not hovering.
  function settle(hands) {
    let touched = false;
    for (let it = 0; it < 40; it++) {
      const h = deepest(pos, quat, hands, it === 0);
      if (!h) break;
      touched = true; lastKind = h.kind; lastN.copy(h.n); lastPoint.copy(h.point);
      sumN.set(0, 0, 0); sumP.set(0, 0, 0);
      let w = 0;
      for (let i = 0; i < nContacts; i++) { const c = pool[i]; sumN.addScaledVector(c.n, c.pen); sumP.addScaledVector(c.point, c.pen); w += c.pen; }
      if (sumN.lengthSq() < 1e-24) sumN.copy(h.n); // opposed pushes cancel: fall back on the deepest one
      dir.copy(sumN).normalize();
      sumP.multiplyScalar(1 / w);
      rv.subVectors(sumP, pos);
      ax.crossVectors(rv, dir);
      const lever = rv.length(), sin = lever > 1e-9 ? ax.length() / lever : 0;
      const rotate = sin >= 0.2; // pushing along the handle itself: rotating can't help, move instead
      if (rotate) ax.normalize();
      // bracket the smallest move that clears every contact, then bisect it
      let hi = rotate ? h.pen / (lever * sin) : h.pen;
      for (let k = 0; k < 40 && !allClear(rotate, hi); k++) hi *= 2;
      let lo = 0;
      for (let k = 0; k < 50 && hi - lo > 1e-12; k++) { const mid = 0.5 * (lo + hi); if (allClear(rotate, mid)) hi = mid; else lo = mid; }
      if (rotate) { rq.setFromAxisAngle(ax, hi); quat.premultiply(rq).normalize(); }
      else pos.addScaledVector(dir, hi);
    }
    return touched;
  }
  function farthestMove(fromPos, fromQuat) { // how far any end of any part moves to the target pose
    let d = fromPos.distanceTo(tPos);
    for (const e of ends) d = Math.max(d, e0.copy(e).applyQuaternion(fromQuat).add(fromPos).distanceTo(e1.copy(e).applyQuaternion(tQuat).add(tPos)));
    return d;
  }

  return {
    // Resolves `kine` (posed for this frame) in place. hands: spheres to keep out of ({ center, r } or meshes).
    // Returns { kind: 'usu' | 'ground' | 'hand', speed } when a contact starts while moving, else null.
    resolve(kineObj, hands, dt) {
      kineObj.updateMatrixWorld(true);
      kineObj.matrixWorld.decompose(tPos, tQuat, tScale);
      const handMoved = hasPrev ? tPos.distanceTo(prevTarget) : 0;
      let touched = false;
      if (!hasPrev || handMoved > 0.5) { // picked up, put down, mode change: no sweep
        pos.copy(tPos); quat.copy(tQuat);
        touched = settle(hands);
      } else {
        // march toward this frame's pose in moves no longer than the mallet's thinnest part, settling after
        // each; if something blocks the way the mallet stays on the near side
        pos.copy(prevPos); quat.copy(prevQuat);
        for (let k = 0; k < 64; k++) {
          const left = farthestMove(pos, quat);
          if (left < 1e-7) break;
          // as far as the free space around the mallet surely allows, and at least the thinnest part
          const t = Math.min(1, Math.max(minRadius, clearance(pos, quat, hands)) / left);
          pos.lerp(tPos, t); quat.slerp(tQuat, t);
          const blocked = settle(hands);
          if (blocked) touched = true;
          // held back: a step that had to be corrected and kept less than half its advance can't be followed
          // by better ones (the mallet only creeps along what blocks it)
          if (blocked && left - farthestMove(pos, quat) < 0.5 * t * left) break;
        }
        if (pos.distanceToSquared(tPos) > 1e-12 || 1 - Math.abs(quat.dot(tQuat)) > 1e-12) touched = true; // held back
      }
      let event = null;
      if (touched) {
        m4.compose(pos, quat, tScale);
        if (kineObj.parent) { kineObj.parent.updateMatrixWorld(true); m4.premultiply(inv.copy(kineObj.parent.matrixWorld).invert()); }
        m4.decompose(kineObj.position, kineObj.quaternion, kineObj.scale);
        kineObj.updateMatrixWorld(true);
        if (!inContact && hasPrev) {
          // how fast the contact point was coming at the surface (last frame's resolved pose -> this frame's target)
          const body = lastPoint.clone().sub(pos).applyQuaternion(quat.clone().invert());
          const before = body.clone().applyQuaternion(prevQuat).add(prevPos), after = body.clone().applyQuaternion(tQuat).add(tPos);
          const speed = Math.max(0, -after.sub(before).dot(lastN)) / Math.max(dt, 1e-3);
          if (speed > 0) event = { kind: lastKind, speed };
        }
      }
      inContact = touched;
      prevPos.copy(pos); prevQuat.copy(quat); prevTarget.copy(tPos);
      hasPrev = true;
      return event;
    },
    reset() { hasPrev = false; inContact = false; },
    // exact distances, for tests: to the mortar + ground, and to the mallet as it is posed now
    sceneSdf: (p) => sceneSdf(p, null),
    stats,
    malletSdf: (p) => { kine.updateMatrixWorld(true); kine.matrixWorld.decompose(tPos, tQuat, tScale); return malletSdf(p, tPos, tQuat); },
  };
}
