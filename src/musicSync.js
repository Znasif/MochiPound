import { toB64, fromB64 } from './net.js';

// The song itself stays on the same timeline on both headsets; only the guest's visual/action
// cues are offset. Use the host's beat analysis too, since devices can decode at different rates.
const CHUNK_BYTES = 64 * 1024;
const now = () => performance.now() / 1000;

export function createMusicLead({ net, music, rhythm, song, isLoading = () => false, onPick }) {
  let lastState = '', sentAt = -Infinity, chunkAt = -Infinity;
  const transfers = new Map();
  const playback = () => !music.playing ? 'stopped'
    : (music.paused ?? music.ctx.state !== 'running') ? 'paused' : 'playing';
  net.on('music-pick', (d, peer) => {
    if (peer.role !== 'join' || typeof d.name !== 'string') return;
    const ok = onPick?.(d.name, d.assetId) === true;
    net.send('music-picked', { to: peer.from, request: d.request, name: d.name, ok });
  });
  // followers: the guest and the film camera (?mp=watch); only the guest may pick songs
  const follower = (peer) => peer.role === 'join' || peer.role === 'watch';
  net.on('music-ping', (d, peer) => {
    if (!follower(peer)) return;
    net.send('music-pong', { to: peer.from, request: d.request, id: song()?.id, pos: music.position(), state: playback() });
  });
  net.on('music-get', (d, peer) => {
    const s = song();
    if (!follower(peer) || d.id !== s?.id || !s.bytes) return;
    transfers.set(peer.from, { id: s.id, bytes: new Uint8Array(s.bytes), i: 0 });
  });
  const lead = {
    update() {
      const t = now(), s = song(), state = playback();
      const loading = isLoading();
      const signature = JSON.stringify([s?.id, state, rhythm.every, loading]);
      if (signature !== lastState || t - sentAt >= 1) {
        if (signature !== lastState) console.info(`[music:host] ${state} · ${s?.name ?? 'free play'} · audio ${music.ctx.state}`);
        lastState = signature; sentAt = t;
        net.send('music-state', {
          id: s?.id ?? null, name: s?.name ?? '', kind: s?.kind,
          analysis: s ? music.analysis : null, every: rhythm.every, state, pos: music.position(), loading,
        });
      }
      // One small chunk per frame at most, leaving space for hand/dough messages.
      if (t - chunkAt < 0.03) return;
      for (const [to, transfer] of transfers) {
        if (transfer.id !== s?.id) { transfers.delete(to); continue; }
        const { id, bytes, i } = transfer, n = Math.ceil(bytes.length / CHUNK_BYTES);
        net.send('music-chunk', { to, id, i, n, data: toB64(bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)) });
        if (++transfer.i >= n) transfers.delete(to);
        chunkAt = t;
        break;
      }
    },
  };
  // WebXR can stop requesting frames when the host headset loses visibility. The shared
  // clock and uploaded-song transfers must keep reaching guests without that render loop.
  const heartbeat = setInterval(() => lead.update(), 100);
  heartbeat.unref?.();
  lead.dispose = () => clearInterval(heartbeat);
  return lead;
}

export function createMusicFollow({ net, music, rhythm, canPlay, onStatus, onActive, onPickResult }) {
  let host = null, state = null, receivedAt = -Infinity;
  let loaded = null, loading = null, failed = null, generation = 0;
  let sample = null, roundTrips = [], pingAt = -Infinity, request = 0;
  let transfer = null, transferAt = -Infinity;
  let pickRequest = 0, pendingPick = null;
  const pending = new Map();
  const stop = () => { rhythm.stop(); music.stop(); onActive(false); };
  const hostPosition = () => {
    const s = sample ?? { pos: state.pos, at: receivedAt, state: state.state };
    return s.pos + (s.state === 'playing' ? now() - s.at : 0);
  };
  function ping() {
    if (!host || !state?.id) return;
    pingAt = now();
    pending.set(++request, pingAt);
    for (const [id, at] of pending) if (pingAt - at > 5) pending.delete(id);
    net.send('music-ping', { request });
  }
  function reconcile() {
    if (!state || loaded !== state.id || !loaded) return;
    if (state.state === 'stopped') { if (music.playing || rhythm.active) stop(); return; }
    if (!canPlay()) { music.pause(); return; }
    if (state.state === 'paused') { music.pause(); return; }
    const pos = hostPosition();
    if (!Number.isFinite(pos)) return;
    if (!music.playing || music.ctx.state !== 'running' || Math.abs(music.position() - pos) > 0.06) music.playFrom(pos);
    if (!rhythm.active || rhythm.every !== state.every) { rhythm.start(state.every); onActive(true); }
  }
  async function load(bytes, s, token) {
    try {
      const data = await bytes;
      if (token !== generation) return;
      const analysis = await music.load(data, s.name, s.analysis);
      if (token !== generation || !analysis) return;
      loaded = s.id; loading = null;
      onStatus(`♪ ${s.name} · knead between the host's strikes`);
      ping(); reconcile();
    } catch (err) {
      if (token !== generation) return;
      failed = s.id; loading = null;
      onStatus(`Could not load the host's song: ${err.message}`);
      console.warn('[music] host song failed', err);
    }
  }
  function requestFile() {
    transfer = { chunks: [], count: 0, n: null };
    transferAt = now();
    net.send('music-get', { id: state.id });
  }
  net.on('music-state', (d, peer) => {
    if (peer.role !== 'host') return;
    const changed = host !== peer.from || state?.id !== d.id;
    const wasPlaying = state?.state === 'playing';
    host = peer.from; state = d; receivedAt = now();
    if (pendingPick) {
      if (d.id && d.name === pendingPick.name) pendingPick = null;
      else if (d.loading) pendingPick.loading = true;
      else if (pendingPick.loading) {
        onPickResult?.(false, pendingPick.name); pendingPick = null;
      }
    }
    // Clock samples belong to one song and one playback state only.
    if (changed || wasPlaying !== (d.state === 'playing')) { sample = null; pending.clear(); }
    if (changed) {
      generation++; stop(); loaded = loading = failed = null; transfer = null;
      roundTrips = []; pingAt = -Infinity;
    }
    if (!d.id) { onStatus('Host music: free play'); return; }
    if (loaded !== d.id && loading !== d.id && failed !== d.id) {
      loading = d.id;
      onStatus(`Loading host music: ${d.name}…`);
      if (d.kind === 'file') requestFile();
      else void load(fetch(`/music/${encodeURIComponent(d.name)}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      }), d, generation);
    }
    // Fall back to state snapshots if clock replies stop arriving.
    if (sample && now() - sample.at > 5) sample = null;
    reconcile();
  });
  net.on('music-picked', (d, peer) => {
    if (peer.from !== host || d.to !== net.id || d.request !== pendingPick?.request) return;
    onPickResult?.(d.ok, d.name);
    if (!d.ok) pendingPick = null;
  });
  net.on('music-chunk', (d, peer) => {
    if (peer.from !== host || d.to !== net.id || d.id !== loading || !transfer) return;
    if (!Number.isInteger(d.n) || d.n < 1 || d.n > 2048 || !Number.isInteger(d.i) || d.i < 0 || d.i >= d.n) return;
    if (transfer.n !== null && transfer.n !== d.n) return;
    transfer.n = d.n; transferAt = now();
    if (transfer.chunks[d.i]) return;
    transfer.chunks[d.i] = fromB64(d.data); transfer.count++;
    if (transfer.count !== d.n) return;
    const bytes = new Uint8Array(transfer.chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of transfer.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    transfer = null;
    void load(bytes.buffer, state, generation);
  });
  net.on('music-pong', (d, peer) => {
    if (peer.from !== host || d.to !== net.id || d.id !== state?.id || !pending.has(d.request)) return;
    const t = now(), rtt = t - pending.get(d.request);
    pending.delete(d.request);
    if (!Number.isFinite(d.pos) || d.state !== state.state) return;
    roundTrips.push(rtt); if (roundTrips.length > 8) roundTrips.shift();
    if (rtt > Math.min(...roundTrips) * 1.5 + 0.01) return;
    sample = { pos: d.pos + (d.state === 'playing' ? rtt / 2 : 0), at: t, state: d.state };
    reconcile();
  });
  return {
    get songId() { return state?.id ?? null; },
    get songLoading() { return !!(pendingPick || loading || state?.loading); },
    pickSong(name, assetId) {
      if (!host || now() - receivedAt > 3 || pendingPick || loading || state?.loading) return false;
      pendingPick = { request: ++pickRequest, name, at: now(), loading: false };
      net.send('music-pick', { request: pendingPick.request, name, assetId });
      return true;
    },
    update() {
      if (host && now() - receivedAt > 3) {
        generation++; stop(); host = state = loaded = loading = failed = transfer = sample = null;
        pending.clear(); pendingPick = null; onStatus('Waiting for the host’s music…');
        return;
      }
      if (pendingPick && now() - pendingPick.at > 10) { onPickResult?.(false, pendingPick.name); pendingPick = null; }
      if (!state?.id) return;
      if (transfer && now() - transferAt > 5) requestFile();
      if (state.state === 'playing' && now() - pingAt >= 1.5) ping();
      reconcile();
    },
  };
}
