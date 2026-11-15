// The film camera's takes (2026-11-15, the user asked for latency-free video, even if not rendered in real time).
//
// Live, every message reaches the camera a network delay late, unevenly, and the camera eases toward it. So a
// take records instead: each world message at the moment its sender captured it (the sender's clock, net.js `at`,
// moved onto this page's clock by createPeerClocks), plus this camera's own path. Afterwards src/film/render.js
// replays it frame by frame at a fixed rate, interpolating between the samples around each frame, with nothing
// eased and nothing waiting for the network.
//
// A take: { t0, t1 (ms, this page's performance.now()), events: [{ t, role, type, data }] sorted by t,
//           camera: [{ t, p: [x, y, z], q: [x, y, z, w], fov }] }

// Each other page's clock against this one, from clock pings (net.js answers them on every page): the offset
// with the shortest round trip over the last `window` ms (its error is at most half that round trip).
export function createPeerClocks(net, { every = 500, window = 20000, now = () => performance.now() } = {}) {
  const peers = new Map(); // peer id -> [{ rtt, offset, at }]
  net.tap((type, d, m) => {
    if (type !== 'clock-pong' || d?.to !== net.id || !Number.isFinite(d.t0) || !Number.isFinite(d.t1)) return;
    const t2 = now(), rtt = t2 - d.t0;
    if (!(rtt >= 0 && rtt < 2000)) return;
    const list = peers.get(m.from) ?? [];
    list.push({ rtt, offset: d.t1 - (d.t0 + t2) / 2, at: t2 });
    while (list.length && t2 - list[0].at > window) list.shift();
    peers.set(m.from, list);
  });
  const ping = () => net.send('clock-ping', { t0: now() });
  const timer = setInterval(ping, every);
  timer.unref?.();
  ping();
  const best = (id) => { const list = peers.get(id); if (!list?.length) return null; let b = list[0]; for (const s of list) if (s.rtt < b.rtt) b = s; return b; };
  return {
    // ms to subtract from that peer's clock to get this page's; null until it has answered a ping
    offset(id) { return best(id)?.offset ?? null; },
    rtt(id) { return best(id)?.rtt ?? null; },
    toLocal(id, at) { const o = best(id)?.offset; return o == null || !Number.isFinite(at) ? null : at - o; },
    ping,
    dispose() { clearInterval(timer); },
  };
}

const KEPT = new Set(['pose', 'dough', 'phase', 'kine-asset', 'conditioning', 'hand-hit', 'judge', 'music-state']);
// the latest of these is copied into a take as it starts, so its first frame has a world to show
const LATEST = new Set(['pose', 'dough', 'phase', 'kine-asset', 'conditioning', 'music-state']);

// decodeHands / unpackDough: sync.js's (base64 -> typed arrays, done once per message, not per frame)
export function createRecorder({ net, clocks, decodeHands, unpackDough, now = () => performance.now(), rateEvery = 500 }) {
  const latest = new Map(); // `${role}:${type}` -> { t, role, type, raw }
  let take = null, rateTimer = null;
  const pack = (type, d) => (type === 'pose' ? { ...d, hands: decodeHands(d.hands) } : type === 'dough' ? unpackDough(d) : d);
  net.tap((type, d, m) => {
    if (!KEPT.has(type) || (m.role !== 'host' && m.role !== 'join')) return;
    const t = clocks.toLocal(m.from, m.at) ?? now(); // not synced yet: its arrival
    if (LATEST.has(type)) latest.set(`${m.role}:${type}`, { t, role: m.role, type, raw: d });
    if (take) take.events.push({ t, role: m.role, type, data: pack(type, d) });
  });
  return {
    get recording() { return !!take; },
    get seconds() { return take ? (now() - take.t0) / 1000 : 0; },
    start() {
      if (take) return;
      take = { t0: now(), t1: null, events: [...latest.values()].map((e) => ({ t: e.t, role: e.role, type: e.type, data: pack(e.type, e.raw) })), camera: [] };
      // the players send poses at 60/s and the host its dough at 30/s while a take records (sync.js)
      net.send('film-rate', {});
      rateTimer = setInterval(() => net.send('film-rate', {}), rateEvery);
      rateTimer.unref?.();
    },
    // this camera's pose, every live frame of the take
    camera(cam) {
      if (!take) return;
      take.camera.push({ t: now(), p: cam.position.toArray(), q: cam.quaternion.toArray(), fov: cam.fov });
    },
    stop() {
      if (!take) return null;
      clearInterval(rateTimer);
      const done = take; take = null;
      done.t1 = now();
      done.events.sort((a, b) => a.t - b.t);
      return done;
    },
  };
}
