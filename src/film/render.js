// Renders a recorded take (src/film/recorder.js) offline into a video file: frame by frame at a fixed rate, each
// frame showing every player, the mallet, the dough and the camera exactly where they were at that instant
// (src/film/timeline.js), nothing eased, nothing waiting for the network. A slow frame only makes the render take
// longer: the video's timing comes from the frame count, not the clock. Encoded with WebCodecs (VP9, or VP8)
// into WebM (src/film/webm.js), downloaded when done. Video only; the music is the host's, for an editor.
import * as THREE from 'three';
import { createRhythm } from '../rhythm/rhythm.js';
import { createTimeline } from './timeline.js';
import { createWebmMuxer } from './webm.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function pickCodec(width, height, fps) {
  if (typeof VideoEncoder !== 'function') return null;
  const big = width * height * fps > 1920 * 1080 * 60;
  const bitrate = Math.round(24e6 * (width * height * fps) / (1920 * 1080 * 60));
  for (const [codec, webm] of [[big ? 'vp09.00.51.08' : 'vp09.00.41.08', 'V_VP9'], ['vp8', 'V_VP8']]) {
    const config = { codec, width, height, bitrate, framerate: fps, latencyMode: 'quality', bitrateMode: 'variable' };
    try { const s = await VideoEncoder.isConfigSupported(config); if (s.supported) return { config: s.config ?? config, webm }; } catch { /* next */ }
  }
  return null;
}

// the take's music, replayed: its song time at each frame from the host's 'music-state' messages, which drive a
// rhythm of its own (the camera's watch rings, coloured by the recorded judgments)
function createReplayMusic(scene, station) {
  const music = { analysis: null, time: () => songT };
  const rhythm = createRhythm({ scene, station, music, watch: true });
  let state = null, at = 0, songT = 0, started = null;
  return {
    rhythm,
    apply(d, t) { state = d; at = t; },
    update(t, dt) {
      if (state && state.state !== 'stopped' && state.analysis && Number.isFinite(state.pos)) {
        songT = state.pos + (state.state === 'playing' ? (t - at) / 1000 : 0);
        const key = `${state.id}:${state.every}`;
        if (started !== key) { music.analysis = state.analysis; rhythm.start(state.every); started = key; }
      } else if (started) { rhythm.stop(); started = null; }
      rhythm.update(dt);
    },
    stop() { rhythm.stop(); started = null; },
  };
}

// deps: renderer, scene, camera, station, sync (createWatchSync), net, frame(dt) (main.js's per-frame update
// without its live-only parts), pause() / resume() (main.js: the live loop, music and rings)
export async function renderTake(take, deps, { width = 1920, height = 1080, fps = 60, onProgress, signal } = {}) {
  const { renderer, scene, camera, station, sync, net, frame, pause, resume } = deps;
  const codec = await pickCodec(width, height, fps);
  if (!codec) throw new Error('this browser cannot encode video (WebCodecs VP9/VP8): use Chrome or Edge');
  const tl = createTimeline(take);
  const total = Math.max(1, Math.floor(tl.seconds * fps)), dt = 1 / fps;
  const muxer = createWebmMuxer({ width, height, codec: codec.webm, fps });
  let failed = null;
  const encoder = new VideoEncoder({
    output: (chunk) => { const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); muxer.add(data, chunk.timestamp, chunk.type === 'key'); },
    error: (e) => { failed = e; },
  });
  encoder.configure(codec.config);

  // ---- take the page over: live messages muted, the live loop and music paused, poses exact, dough played back
  const saved = { ratio: renderer.getPixelRatio(), size: renderer.getSize(new THREE.Vector2()), aspect: camera.aspect, fov: camera.fov,
    p: camera.position.clone(), q: camera.quaternion.clone() };
  net.muted = true; pause(); sync.exact = true; station.dough.playback = true;
  renderer.setPixelRatio(1); renderer.setSize(width, height, false);
  camera.aspect = width / height; camera.updateProjectionMatrix();
  const replay = createReplayMusic(scene, station);
  const started = performance.now();
  try {
    let prev = -Infinity;
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw new DOMException('render cancelled', 'AbortError');
      if (failed) throw failed;
      const t = tl.t0 + (i * 1000) / fps;
      // the one-off messages since the last frame (before the take: only the state they leave, not old news)
      for (const e of tl.between(prev, t)) {
        if (e.t < tl.t0 && (e.type === 'judge' || e.type === 'hand-hit')) continue;
        if (e.type === 'judge') replay.rhythm.showJudgment(e.data);
        else if (e.type === 'music-state') replay.apply(e.data, e.t);
        else sync.apply(e.role, e.type, e.data);
      }
      prev = t;
      for (const role of ['host', 'join']) { const p = tl.pose(role, t); if (p) sync.apply(role, 'pose', p); }
      const c = tl.camera(t);
      if (c) {
        camera.position.fromArray(c.p); camera.quaternion.fromArray(c.q);
        if (Math.abs(camera.fov - c.fov) > 1e-4) camera.fov = c.fov;
      }
      camera.aspect = width / height; camera.updateProjectionMatrix();
      frame(dt);
      replay.update(t, dt);
      const dough = tl.dough(t);
      if (dough) await station.dough.showSnapshot(dough);
      renderer.render(scene, camera);
      const vf = new VideoFrame(renderer.domElement, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(vf, { keyFrame: i % (fps * 2) === 0 });
      vf.close();
      while (encoder.encodeQueueSize > 6) await sleep(1);
      if (i % 3 === 0 || i === total - 1) {
        onProgress?.({ frame: i + 1, total, rate: (i + 1) / Math.max(1e-3, (performance.now() - started) / 1000) });
        await sleep(0); // let the page breathe (the progress, Esc)
      }
    }
    await encoder.flush();
    if (failed) throw failed;
    const blob = new Blob(muxer.finish(), { type: 'video/webm' });
    return { blob, frames: total, fps, width, height, codec: codec.webm, seconds: (performance.now() - started) / 1000 };
  } finally {
    try { encoder.close(); } catch { /* already closed */ }
    replay.stop();
    station.dough.playback = false; sync.exact = false;
    renderer.setPixelRatio(saved.ratio); renderer.setSize(saved.size.x, saved.size.y, false);
    camera.aspect = saved.aspect; camera.fov = saved.fov; camera.position.copy(saved.p); camera.quaternion.copy(saved.q); camera.updateProjectionMatrix();
    net.muted = false; resume();
  }
}

export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
