// Beat tracking for any song, in the browser, on the decoded AudioBuffer.
//  1. Onset strength every 10 ms: rises in low-band energy (drums, bass) plus rises in high-band
//     energy (snares, claps, plucks), with the local average removed.
//  2. Tempo: autocorrelation of that curve over 60-190 BPM, weighted toward ~110 BPM so the
//     tracker prefers the pulse people tap rather than half or double of it.
//  3. Beats: dynamic programming over the onset curve (D. Ellis, "Beat Tracking by Dynamic
//     Programming", 2007; the method librosa.beat.beat_track uses): beats sit on strong onsets
//     while keeping close to the tempo, so it follows small tempo drift.
// Returns beat times in seconds plus the onset strength at each beat.

const HOP_S = 0.01;

export function analyzeBeats(buffer, { minBpm = 60, maxBpm = 190, preferBpm = 110 } = {}) {
  const sr = buffer.sampleRate;
  const c0 = buffer.getChannelData(0);
  const c1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const SUB = 8;
  const block = Math.max(1, Math.round((sr * HOP_S) / SUB));
  const hop = block * SUB;  // samples per analysis frame, an exact number of blocks
  const hopS = hop / sr;    // seconds per frame (use this, not HOP_S, for times and lags)
  const frames = Math.floor(c0.length / hop);
  if (frames < 200) throw new Error('song too short to find a beat');

  // ---- 1. onset strength ----
  // Band energies in small blocks (hop/8), then a Hann-weighted 20 ms window every 10 ms: steady
  // tones read as steady (plain back-to-back frames ripple with the tone's phase and fake a beat).
  const nBlocks = Math.floor(c0.length / block);
  const aLow = Math.exp((-2 * Math.PI * 180) / sr); // one-pole low-pass at ~180 Hz
  let low = 0;
  const bLow = new Float32Array(nBlocks), bHigh = new Float32Array(nBlocks);
  for (let k = 0, j = 0; k < nBlocks; k++) {
    let sl = 0, sh = 0;
    for (let i = 0; i < block; i++, j++) {
      const x = c1 ? 0.5 * (c0[j] + c1[j]) : c0[j];
      low = (1 - aLow) * x + aLow * low;
      const high = x - low;
      sl += low * low; sh += high * high;
    }
    bLow[k] = sl; bHigh[k] = sh;
  }
  const win = new Float32Array(2 * SUB);
  for (let i = 0; i < win.length; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / win.length);
  const eLow = new Float32Array(frames), eHigh = new Float32Array(frames);
  let mLow = 0, mHigh = 0;
  for (let f = 0; f < frames; f++) {
    let sl = 0, sh = 0;
    const k0 = f * SUB - SUB;
    for (let i = 0; i < win.length; i++) {
      const k = k0 + i;
      if (k < 0 || k >= nBlocks) continue;
      sl += win[i] * bLow[k]; sh += win[i] * bHigh[k];
    }
    eLow[f] = sl; eHigh[f] = sh; mLow += sl; mHigh += sh;
  }
  // log with a floor (1% of the mean energy) so quiet passages don't flicker
  const fLow = 0.01 * (mLow / frames) + 1e-12, fHigh = 0.01 * (mHigh / frames) + 1e-12;
  for (let f = 0; f < frames; f++) { eLow[f] = Math.log(eLow[f] + fLow); eHigh[f] = Math.log(eHigh[f] + fHigh); }
  // a rise counts only above the higher of the two previous frames
  const onset = new Float32Array(frames);
  for (let f = 2; f < frames; f++) {
    onset[f] = Math.max(0, eLow[f] - Math.max(eLow[f - 1], eLow[f - 2]))
      + 0.6 * Math.max(0, eHigh[f] - Math.max(eHigh[f - 1], eHigh[f - 2]));
  }
  // tempo is read from the raw curve with only its overall mean removed (a short moving-average
  // subtraction would plant a fake periodicity at its own window length)
  let rawSum = 0;
  for (let f = 0; f < frames; f++) rawSum += onset[f];
  const rawMean = rawSum / frames;
  const centred = new Float32Array(frames);
  for (let f = 0; f < frames; f++) centred[f] = onset[f] - rawMean;
  // for placing beats: remove a slow (3 s) local mean, keep the positive part, normalise
  const W = 150;
  const prefix = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) prefix[f + 1] = prefix[f] + onset[f];
  const strengthCurve = new Float32Array(frames);
  let sum = 0, sum2 = 0;
  for (let f = 0; f < frames; f++) {
    const a = Math.max(0, f - W), b = Math.min(frames, f + W + 1);
    const v = Math.max(0, onset[f] - (prefix[b] - prefix[a]) / (b - a));
    strengthCurve[f] = v; sum += v; sum2 += v * v;
  }
  const mean = sum / frames;
  const std = Math.sqrt(Math.max(1e-12, sum2 / frames - mean * mean));
  for (let f = 0; f < frames; f++) onset[f] = strengthCurve[f] / std;

  // ---- 2. tempo by autocorrelation ----
  const lagMin = Math.max(2, Math.floor(60 / maxBpm / hopS));
  const lagMax = Math.min(frames - 1, Math.ceil(60 / minBpm / hopS));
  const ac = new Float64Array(lagMax + 2);
  for (let lag = lagMin - 1; lag <= lagMax + 1; lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += centred[f] * centred[f - lag];
    ac[lag] = s / (frames - lag);
  }
  let best = lagMin, bestScore = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    const bpm = 60 / (lag * hopS);
    const prior = Math.exp(-0.5 * (Math.log2(bpm / preferBpm) / 0.9) ** 2);
    const score = ac[lag] * prior;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  // parabolic refinement of the peak
  const y0 = ac[best - 1], y1 = ac[best], y2 = ac[best + 1];
  const denom = y0 - 2 * y1 + y2;
  const period = best + (Math.abs(denom) > 1e-12 ? (0.5 * (y0 - y2)) / denom : 0); // in frames
  const bpm = 60 / (period * hopS);

  // ---- 3. beats by dynamic programming ----
  const tight = 100;
  const score = new Float64Array(frames), back = new Int32Array(frames).fill(-1);
  const lo = Math.round(period / 2), hi = Math.round(period * 2);
  for (let t = 0; t < frames; t++) {
    let bestPrev = -1, bestVal = 0;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const pen = Math.log((t - tau) / period);
      const v = score[tau] - tight * pen * pen;
      if (bestPrev < 0 || v > bestVal) { bestVal = v; bestPrev = tau; }
    }
    score[t] = onset[t] + (bestPrev >= 0 ? Math.max(0, bestVal) : 0);
    back[t] = bestPrev >= 0 && bestVal > 0 ? bestPrev : -1;
  }
  // end on the best-scoring frame in the last period, then walk back
  let end = frames - 1;
  for (let t = Math.max(0, frames - Math.round(period)); t < frames; t++) if (score[t] > score[end]) end = t;
  const beatFrames = [];
  for (let t = end; t >= 0; t = back[t]) { beatFrames.push(t); if (back[t] < 0) break; }
  beatFrames.reverse();

  // drop weak beats at the very start and end (silence or fades)
  const strength = beatFrames.map((f) => {
    let s = 0;
    for (let k = Math.max(0, f - 2); k <= Math.min(frames - 1, f + 2); k++) s = Math.max(s, onset[k]);
    return s;
  });
  const sorted = [...strength].sort((a, b) => a - b);
  const floor = 0.15 * (sorted[Math.floor(sorted.length / 2)] ?? 0);
  let a = 0, b = beatFrames.length - 1;
  while (a < b && strength[a] < floor) a++;
  while (b > a && strength[b] < floor) b--;
  const beats = [], beatStrength = [];
  for (let i = a; i <= b; i++) { beats.push(beatFrames[i] * hopS); beatStrength.push(strength[i]); }
  return { bpm, period: period * hopS, beats, strength: beatStrength, duration: buffer.duration };
}

// Strike times from the beats: every beat, or every other beat on the stronger half.
export function strikesFromBeats(analysis, every) {
  const { beats, strength } = analysis;
  if (every <= 1) return beats.slice();
  let even = 0, odd = 0;
  strength.forEach((s, i) => { if (i % 2) odd += s; else even += s; });
  const phase = odd > even ? 1 : 0;
  return beats.filter((_, i) => i % 2 === phase);
}

// A comfortable mallet pace: every beat unless that is faster than one strike per 0.75 s.
export function autoEvery(analysis) {
  return analysis.period < 0.75 ? 2 : 1;
}
