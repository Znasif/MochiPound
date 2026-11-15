// Sampling a recorded take (src/film/recorder.js) at any moment: the two samples around it, positions lerped,
// rotations slerped, hand joints and dough particles lerped; and the one-off messages (phase, judgments, ...)
// between two moments, in order. Plain data in and out, so it runs and is tested without a browser.

const GAP_MS = 400; // samples further apart than this aren't bridged (a person or a dough appeared or left)

function lerpPose(a, b, u) { // [x, y, z, qx, qy, qz, qw]
  if (!a || !b) return (u < 0.5 ? a : b) ?? a ?? b ?? null;
  const out = new Array(7);
  for (let i = 0; i < 3; i++) out[i] = a[i] + (b[i] - a[i]) * u;
  // slerp the quaternions, the short way round
  let [ax, ay, az, aw] = [a[3], a[4], a[5], a[6]], [bx, by, bz, bw] = [b[3], b[4], b[5], b[6]];
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; dot = -dot; }
  let ka = 1 - u, kb = u;
  if (dot < 0.9995) { const th = Math.acos(Math.min(1, dot)), s = Math.sin(th); ka = Math.sin((1 - u) * th) / s; kb = Math.sin(u * th) / s; }
  const q = [ax * ka + bx * kb, ay * ka + by * kb, az * ka + bz * kb, aw * ka + bw * kb], n = Math.hypot(...q) || 1;
  for (let i = 0; i < 4; i++) out[3 + i] = q[i] / n;
  return out;
}
// a hand's joints (x, y, z, r per joint; NaN = not tracked): lerped where both samples have the joint
function lerpHand(a, b, u) {
  if (!a || !b) return (u < 0.5 ? a : b) ?? null;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Number.isNaN(a[i]) || Number.isNaN(b[i]) ? (u < 0.5 ? a[i] : b[i]) : a[i] + (b[i] - a[i]) * u;
  return out;
}
function lerpEffectors(a = {}, b = {}, u) {
  const out = {};
  for (const side of ['left', 'right']) {
    const ea = a[side], eb = b[side];
    if (!ea || !eb || ea.kind !== eb.kind) { const e = (u < 0.5 ? ea : eb) ?? ea ?? eb; if (e) out[side] = e; continue; }
    const near = u < 0.5 ? ea : eb;
    out[side] = { ...near, pose: lerpPose(ea.pose, eb.pose, u) };
    if (Array.isArray(ea.curl) && Array.isArray(eb.curl)) out[side].curl = ea.curl.map((c, i) => c + ((eb.curl[i] ?? c) - c) * u);
  }
  return out;
}
export function lerpPoseMessage(a, b, u) {
  const near = u < 0.5 ? a : b;
  return {
    head: lerpPose(a.head, b.head, u),
    hands: [0, 1].map((i) => lerpHand(a.hands?.[i] ?? null, b.hands?.[i] ?? null, u)),
    kine: a.kine && b.kine && a.assetId === b.assetId ? lerpPose(a.kine, b.kine, u) : near.kine ?? null,
    assetId: near.assetId,
    effectors: lerpEffectors(a.effectors, b.effectors, u),
  };
}
export function lerpDough(a, b, u) {
  if (!a || !b || a.tier !== b.tier || a.N !== b.N || !a.N) return (u < 0.5 ? a : b) ?? a ?? b ?? null;
  const x = new Int16Array(a.x.length), v = new Int16Array(a.v.length);
  for (let i = 0; i < x.length; i++) x[i] = Math.round(a.x[i] + (b.x[i] - a.x[i]) * u);
  for (let i = 0; i < v.length; i++) v[i] = Math.round(a.v[i] + (b.v[i] - a.v[i]) * u);
  const coh = Number.isFinite(a.coh) && Number.isFinite(b.coh) ? a.coh + (b.coh - a.coh) * u : a.coh ?? b.coh;
  return { tier: a.tier, N: a.N, x, v, coh };
}

// the last index with list[i].t <= t (-1 if none)
function before(list, t) {
  let lo = 0, hi = list.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (list[m].t <= t) { k = m; lo = m + 1; } else hi = m - 1; }
  return k;
}
// the samples around t and how far between them; null when t is beyond GAP_MS of every sample
function around(list, t) {
  if (!list?.length) return null;
  const k = before(list, t);
  const a = list[k], b = list[k + 1];
  if (a && b && b.t - a.t <= GAP_MS) return { a, b, u: (t - a.t) / Math.max(1e-6, b.t - a.t) };
  const nearest = !a ? b : !b ? a : t - a.t <= b.t - t ? a : b;
  return Math.abs(nearest.t - t) <= GAP_MS ? { a: nearest, b: nearest, u: 0 } : null;
}

export function createTimeline(take) {
  const streams = new Map(); // 'host:pose', 'join:pose', 'host:dough'
  const moments = [];
  for (const e of take.events) {
    if (e.type === 'pose' || e.type === 'dough') {
      const key = `${e.role}:${e.type}`;
      if (!streams.has(key)) streams.set(key, []);
      streams.get(key).push(e);
    } else moments.push(e);
  }
  for (const list of [...streams.values(), moments]) list.sort((a, b) => a.t - b.t);
  const camera = [...(take.camera ?? [])].sort((a, b) => a.t - b.t);
  return {
    t0: take.t0, t1: take.t1,
    get seconds() { return (take.t1 - take.t0) / 1000; },
    // a player's pose at t (ms), as a 'pose' message with decoded hands; null if they weren't there
    pose(role, t) {
      const s = around(streams.get(`${role}:pose`), t);
      return s ? lerpPoseMessage(s.a.data, s.b.data, s.u) : null;
    },
    // the host's dough at t: { tier, N, x, v, coh }, or null
    dough(t) {
      const s = around(streams.get('host:dough'), t);
      return s ? lerpDough(s.a.data, s.b.data, s.u) : null;
    },
    // the camera at t: { p, q, fov }, held at the ends
    camera(t) {
      if (!camera.length) return null;
      const k = before(camera, t);
      if (k < 0) return camera[0];
      const a = camera[k], b = camera[k + 1];
      if (!b) return a;
      const u = (t - a.t) / Math.max(1e-6, b.t - a.t), pq = lerpPose([...a.p, ...a.q], [...b.p, ...b.q], u);
      return { p: pq.slice(0, 3), q: pq.slice(3), fov: a.fov + (b.fov - a.fov) * u };
    },
    // the one-off messages with from < t <= to, in order
    between(from, to) {
      const out = [];
      for (let k = before(moments, from) + 1; k < moments.length && moments[k].t <= to; k++) out.push(moments[k]);
      return out;
    },
  };
}
