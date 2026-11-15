import { analyzeBeats } from './beats.js';

// The song: decoded once, beat-tracked, played on a loop through Web Audio. `time()` is the song
// time you are hearing right now (output latency included, via getOutputTimestamp), counted
// continuously across loops, plus a calibration offset the player can nudge with [ and ].

const CAL_KEY = 'mochi.rhythm.calibrationMs';

export function createMusic() {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const gain = ctx.createGain();
  gain.gain.value = 0.8;
  gain.connect(ctx.destination);
  let buffer = null, analysis = null, name = '';
  let source = null, startAt = 0, playing = false;
  let calibrationMs = 0;
  try { calibrationMs = Number(localStorage.getItem(CAL_KEY)) || 0; } catch { /* storage unavailable */ }

  // audio time currently reaching the speakers
  function heardContextTime() {
    // paused (suspended): the audio clock stands still, so must we
    if (ctx.state !== 'running') return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime > 0 && ts.performanceTime > 0) {
        return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      }
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  function stopSource() {
    if (source) { try { source.stop(); } catch { /* already stopped */ } source.disconnect(); source = null; }
    playing = false;
  }
  // start the looping source at context time T, with song time 0 heard at context time `zero`
  function play(T, zero) {
    stopSource();
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    startAt = zero;
    const d = buffer.duration;
    source.start(T, (((T - zero) % d) + d) % d);
    playing = true;
  }

  return {
    ctx,
    get analysis() { return analysis; },
    get name() { return name; },
    get playing() { return playing; },
    get duration() { return buffer?.duration ?? 0; },
    get calibrationMs() { return calibrationMs; },
    async load(arrayBuffer, label) {
      const decoded = await ctx.decodeAudioData(arrayBuffer);
      const a = analyzeBeats(decoded);
      if (a.beats.length < 8) throw new Error('could not find a steady beat in this song');
      buffer = decoded; analysis = a; name = label;
      return a;
    },
    // inside a click (a user gesture): lets a song that finishes loading later start without one
    unlock() { void ctx.resume(); },
    // call inside a click or key handler (a user gesture) so the context may start. `at`: the song time
    // to start from (s, continuous across loops; 0 = the top)
    start(at = 0) {
      if (!buffer) return false;
      void ctx.resume();
      const T = ctx.currentTime + 0.25;
      play(T, T - at);
      return true;
    },
    // play so that the song time heard right now would be `pos` (the first sound comes out a moment later,
    // at the matching point): how a joining headset lines its music up with the host's (src/musicSync.js)
    playFrom(pos) {
      if (!buffer) return false;
      void ctx.resume();
      play(ctx.currentTime + 0.1, heardContextTime() - pos);
      return true;
    },
    // the song time being heard (s), without the player's timing calibration; null when not playing
    position() { return playing ? heardContextTime() - startAt : null; },
    stop() { stopSource(); },
    pause() { if (playing) void ctx.suspend(); },
    resume() { if (playing) void ctx.resume(); },
    // song time being heard, seconds since the song started, continuous across loops
    time() {
      if (!playing) return -Infinity;
      return heardContextTime() - startAt + calibrationMs / 1000;
    },
    nudge(ms) {
      calibrationMs = Math.max(-300, Math.min(300, calibrationMs + ms));
      try { localStorage.setItem(CAL_KEY, String(calibrationMs)); } catch { /* storage unavailable */ }
      return calibrationMs;
    },
    setVolume(v) { gain.gain.value = v; },
  };
}
