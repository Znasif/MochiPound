// Rhythm-mode music on both headsets (2026-11-15, the user asked for it; before, only the host heard it).
// The host is the music's authority and clock; the joining headset plays the same song from its own copy, lined
// up with the host's. Messages (through src/net.js, alongside src/sync.js's):
//   host  'music'       {name, src: 'list' | 'file', density, state: 'playing' | 'paused' | 'stopped', pos}
//                       on every change (checked each frame) and once a second while a guest is there
//   guest 'music-ping'  {id, t0}  ->  host 'music-pong' {id, t0, pos, playing}   (every ~1.5 s while it plays)
//   guest 'music-get'   {name}    ->  host 'music-chunk' {name, i, n, data (base64)}   a song the host picked from
//                       a file, in ~192 KB pieces ~20 ms apart (so the pose messages aren't starved)
//   guest 'music-pick'  {name}    the guest picked a song (a song scroll, src/moonGarden/story/): the host plays it
// Songs from public/music/ the guest fetches from the dev server itself. pos is the song time being heard
// (music.position(), output latency included, without either player's own timing calibration).
// The clock: over the last 8 pongs, those whose round trip is within 1.5 x the fastest + 10 ms; the host's
// position now = pos + rtt / 2 at receipt, plus the time since. Without a pong for 5 s the state message's pos plus
// the last one-way estimate (30 ms at first). The guest re-lines its music up (music.playFrom) when it is more
// than 45 ms off, at most once a second. Strikes are judged on each headset by its own rhythm, so scores may
// differ slightly. Not yet tried with two headsets.
import { toB64, fromB64 } from './net.js';

const CHUNK = 192 * 1024, CHUNK_GAP_MS = 20;
const PING_EVERY = 1.5, PONGS = 8, PONG_STALE = 5, DRIFT = 0.045, RESYNC_EVERY = 1;

const stateOf = (music) => (!music.playing ? 'stopped' : music.ctx.state === 'running' ? 'playing' : 'paused');

// host: { update(dt) }. song() -> { name, src, bytes? } of the loaded song (null for none), density() -> the pace,
// onPick(name) when the guest picks one.
export function createMusicLead({ net, music, song, density, onPick }) {
  let sig = '', acc = 0, streaming = null;
  function message() {
    const s = song();
    const state = s && music.name === s.name ? stateOf(music) : 'stopped';
    return { name: s?.name ?? null, src: s?.src ?? 'list', density: density(), state, pos: music.position() };
  }
  net.on('music-ping', (m) => net.send('music-pong', { id: m.id, t0: m.t0, pos: music.position(), playing: stateOf(music) === 'playing' }));
  net.on('music-pick', (m) => { if (m?.name) { console.info(`[mp] the guest picked ${m.name}`); onPick(m.name); } });
  net.on('music-get', (m) => {
    const s = song();
    if (!m?.name || !s || s.name !== m.name || !s.bytes) return;
    if (streaming) streaming.cancelled = true;
    const job = (streaming = { cancelled: false });
    const bytes = new Uint8Array(s.bytes), n = Math.ceil(bytes.length / CHUNK);
    console.info(`[mp] sending ${m.name} to the guest (${(bytes.length / 1e6).toFixed(1)} MB, ${n} pieces)`);
    let i = 0;
    const next = () => {
      if (job.cancelled || i >= n) return;
      net.send('music-chunk', { name: m.name, i, n, data: toB64(bytes.subarray(i * CHUNK, (i + 1) * CHUNK)) });
      i++;
      setTimeout(next, CHUNK_GAP_MS);
    };
    next();
  });
  return {
    update(dt) {
      const m = message();
      const s = `${m.name}|${m.src}|${m.density}|${m.state}`;
      acc += dt;
      if (s !== sig || (acc >= 1 && net.has('join'))) { sig = s; acc = 0; net.send('music', m); }
    },
  };
}

// guest: { update(dt), kick(), get hostSong }. canPlay() -> may music start here (the player has entered, which
// unlocked audio); load(name, read) -> Promise<bool> (main.js's loadSong); start(density) starts the rhythm game
// over music already playing; stop() stops both.
export function createMusicFollow({ net, music, canPlay, load, start, stop }) {
  let host = null, hostAt = 0; // the last 'music' message and when it arrived (performance.now ms)
  let loaded = null, loading = null, started = false, lastResync = -Infinity, clock = 0, pingAcc = PING_EVERY, pingId = 0;
  const failed = new Set();
  const pongs = []; // { rtt, pos, at }
  let oneWay = 0.03;
  let chunks = null; // { name, n, parts[] }

  net.on('music', (m) => { host = m; hostAt = performance.now(); want(); });
  net.on('music-pong', (m) => {
    const now = performance.now(), rtt = (now - m.t0) / 1000;
    if (!(rtt >= 0 && rtt < 3) || m.pos == null || !m.playing) return;
    pongs.push({ rtt, pos: m.pos, at: now });
    if (pongs.length > PONGS) pongs.shift();
  });
  net.on('music-chunk', (m) => {
    if (!chunks || m.name !== chunks.name) return;
    chunks.parts[m.i] = fromB64(m.data);
    chunks.got++;
    if (chunks.got < m.n) return;
    const total = chunks.parts.reduce((a, p) => a + p.length, 0), buf = new Uint8Array(total);
    let o = 0;
    for (const p of chunks.parts) { buf.set(p, o); o += p.length; }
    const name = chunks.name;
    chunks = null;
    finishLoad(name, load(name, () => Promise.resolve(buf.buffer)));
  });

  function finishLoad(name, p) {
    loading = name;
    Promise.resolve(p).then((ok) => {
      if (loading !== name) return;
      loading = null;
      if (ok) { loaded = name; started = false; console.info(`[mp] the host's song is ready here: ${name}`); }
      else { failed.add(name); console.warn(`[mp] could not load the host's song ${name}`); }
    });
  }
  // a new song on the host: fetch it (public/music/) or ask the host for its bytes (a file)
  function want() {
    const name = host?.name;
    if (!name || name === loaded || name === loading || failed.has(name)) return;
    if (host.src === 'file') {
      if (chunks?.name === name) return;
      chunks = { name, parts: [], got: 0 };
      loading = name;
      net.send('music-get', { name });
      console.info(`[mp] asking the host for ${name}`);
    } else {
      finishLoad(name, load(name, () => fetch(`/music/${encodeURIComponent(name)}`).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })));
    }
  }

  // the host's song position now (null if unknown)
  function hostPos() {
    if (!host || host.state !== 'playing') return null;
    const now = performance.now();
    const last = pongs[pongs.length - 1];
    if (last && (now - last.at) / 1000 < PONG_STALE) {
      const min = Math.min(...pongs.map((p) => p.rtt));
      const good = pongs.filter((p) => p.rtt <= 1.5 * min + 0.01);
      const p = good[good.length - 1] ?? last;
      oneWay = p.rtt / 2;
      return p.pos + p.rtt / 2 + (now - p.at) / 1000;
    }
    return host.pos == null ? null : host.pos + oneWay + (now - hostAt) / 1000;
  }

  function reconcile() {
    const name = host?.name, state = host?.state ?? 'stopped';
    const ready = !!name && music.analysis && music.name === name && loaded === name;
    if (state === 'stopped' || !name) { if (music.playing || started) { stop(); started = false; } return; }
    if (!ready || !canPlay()) return;
    if (state === 'paused') { if (music.playing) music.pause(); return; }
    // playing on the host
    if (!music.playing) {
      const p = hostPos();
      if (p == null) return;
      music.playFrom(p);
      lastResync = clock;
      if (!started) { start(host.density); started = true; console.info(`[mp] playing the host's music: ${name}`); }
      return;
    }
    if (music.ctx.state !== 'running') music.resume();
    if (clock - lastResync >= RESYNC_EVERY && pongs.length) {
      const p = hostPos(), here = music.position();
      if (p != null && here != null && Math.abs(here - p) > DRIFT) {
        console.info(`[mp] music ${Math.round((here - p) * 1000)} ms off the host's: lined up again`);
        music.playFrom(p);
      }
      lastResync = clock;
    }
  }

  return {
    get hostSong() { return host?.name ?? null; },
    kick() { want(); reconcile(); },
    update(dt) {
      clock += dt;
      if (host?.state === 'playing') {
        pingAcc += dt;
        if (pingAcc >= PING_EVERY) { pingAcc = 0; net.send('music-ping', { id: ++pingId, t0: performance.now() }); }
      } else pingAcc = PING_EVERY; // ping at once when it starts
      reconcile();
    },
  };
}
