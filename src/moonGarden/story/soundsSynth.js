// Pure synthesis for the story sounds: a port of the generators in the Unity team's StorySounds.cs
// (MochiPound, branch origin/multiplayer, Assets/_Project/World/Scripts/StorySounds.cs). No DOM and no Web Audio:
// each generator returns mono samples (Float32Array) at RATE, and sounds.js turns them into AudioBuffers.
//
// The numbers follow the C# exactly, including its random streams: DotNetRandom (from ../unity.js, the port the
// garden's layout uses, checked against the Unity prefab) is .NET's System.Random, so the same seed gives the same
// paper grain, firework crackle and chime cascade as in Unity; Unity's Mathf.Lerp clamps, SmoothStep(from, to, t)
// eases between two values (not GLSL's edge pair) and RoundToInt rounds half to even, as there.
// The only change is speed, for the Quest: constant-frequency partials use a rotating phasor and their
// exponential envelopes a running product, instead of Math.sin / Math.exp per sample (same samples to ~1e-12).

import { DotNetRandom, clamp, clamp01, lerp, inverseLerp, smoothStep, roundHalfEven } from '../unity.js';

export { clamp, lerp, inverseLerp };
/** Mathf.RoundToInt (half to even). */
export const roundToInt = roundHalfEven;

export const RATE = 48000; // as in Unity; Web Audio resamples if the context runs at another rate

const TWO_PI = 2 * Math.PI;
/** (int)(seconds * Rate) with C#'s float arithmetic, for the echo taps and comb delays. */
const samples = (sec) => Math.trunc(Math.fround(Math.fround(sec) * RATE));

/** Mono's String.GetHashCode (h = 31 h + c): the seed Unity's Sparkles() takes from the clip's name. */
function monoHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

// ------------------------------------------------------------------ DSP building blocks

/**
 * d[off + i] += amp * attack(t) * exp(-t / tau) * sin(2 pi f t + ph), t = i / RATE, for i < len.
 * attack: (1 - exp(-t / ta)) when ta > 0, else a raised-cosine ramp over the first rc seconds when rc > 0, else 1.
 * A rotating phasor and a running product: no sin / exp per sample.
 */
function addSine(d, off, len, f, ph, amp, tau, ta = 0, rc = 0) {
  const w = TWO_PI * f / RATE, cw = Math.cos(w), sw = Math.sin(w);
  const kd = tau > 0 && Number.isFinite(tau) ? Math.exp(-1 / (tau * RATE)) : 1;
  const ka = ta > 0 ? Math.exp(-1 / (ta * RATE)) : 0;
  const nrc = rc * RATE;
  const end = Math.min(len, d.length - off);
  let re = Math.cos(ph), im = Math.sin(ph), e = amp, q = 1;
  for (let i = 0; i < end; i++) {
    let g = e;
    if (ta > 0) { g *= 1 - q; q *= ka; }
    else if (i < nrc) g *= 0.5 - 0.5 * Math.cos(Math.PI * i / nrc);
    d[off + i] += g * im;
    const r = re * cw - im * sw;
    im = re * sw + im * cw;
    re = r;
    e *= kd;
  }
}

function noise(n, rng) {
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = rng.nextDouble() * 2 - 1;
  return d;
}

/** Second-order band-pass (RBJ), in place. */
function bandPass(x, f, q) {
  const w = TWO_PI * f / RATE, al = Math.sin(w) / (2 * q), c = Math.cos(w);
  const a0 = 1 + al, b0 = al / a0, b2 = -al / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y;
  }
}

/** Second-order low-pass (RBJ), in place. */
function lowPass(x, f, q = 0.707) {
  const w = TWO_PI * f / RATE, al = Math.sin(w) / (2 * q), c = Math.cos(w);
  const a0 = 1 + al, b0 = (1 - c) / 2 / a0, b1 = (1 - c) / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y; x[i] = y;
  }
}

function peakOf(d) {
  let m = 0;
  for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > m) m = v; }
  return m;
}

/** Normalize to `peak`, with 20 ms fades at both ends. */
function normalize(d, peak) {
  const m = peakOf(d);
  if (m > 1e-6) { const k = peak / m; for (let i = 0; i < d.length; i++) d[i] *= k; }
  const f = Math.min(d.length, Math.trunc(RATE / 50));
  for (let i = 0; i < f; i++) { d[i] *= i / f; d[d.length - 1 - i] *= i / f; }
}

/** Faint reverb-like tail (a few early echoes), normalized to a gentle peak, last 50 ms faded. Returns a copy. */
function tail(d, peak) {
  const o = new Float32Array(d);
  const taps = [0.037, 0.053, 0.079, 0.113, 0.161], g = [0.22, 0.18, 0.14, 0.11, 0.08];
  for (let t = 0; t < taps.length; t++) {
    const L = samples(taps[t]);
    for (let i = L; i < o.length; i++) o[i] += d[i - L] * g[t];
  }
  const m = peakOf(o);
  if (m > 1e-6) { const k = peak / m; for (let i = 0; i < o.length; i++) o[i] *= k; }
  const f = Math.min(o.length, Math.trunc(RATE / 20));
  for (let i = 0; i < f; i++) o[o.length - 1 - i] *= i / f;
  return o;
}

// ------------------------------------------------------------------ text chimes (brushed hanging bars)

/** Pentatonic steps (major): each progress step a little higher. */
export const PENTA = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3, 2, 9 / 4, 5 / 2, 3];
/** Hanging chime bars: a major pentatonic from G6 up (fundamentals ~1.6-3.5 kHz). */
export const BAR_HZ = [1567.98, 1760, 1975.53, 2349.32, 2637.02, 3135.96, 3520];
// free-free bar / tubular chime partials (inharmonic) and their levels
const BAR_RATIO = [1, 2.76, 5.40, 8.93];
const BAR_AMP = [1, 0.42, 0.2, 0.09];

/**
 * One brushed bar: tubular partials, a 10 ms raised-cosine attack (no click), long decay (1.5-3 s, higher bars
 * shorter), a slightly detuned twin of the fundamental for the slow shimmer, then the faint early-echo tail.
 */
export function barData(index) {
  const f0 = BAR_HZ[index];
  const decay = lerp(2.8, 1.6, index / (BAR_HZ.length - 1));
  const n = Math.trunc((decay * 1.25 + 0.3) * RATE);
  const d = new Float32Array(n);
  for (let k = 0; k < BAR_RATIO.length; k++) {
    const f = f0 * BAR_RATIO[k];
    if (f > 17000) continue;
    const tau = decay / (1 + 1.3 * k), ph = k * 0.9 + index;
    addSine(d, 0, n, f, ph, BAR_AMP[k], tau, 0, 0.010);
    if (k === 0) addSine(d, 0, n, f * 1.0021, 1.7, 0.35 * BAR_AMP[0], tau, 0, 0.010); // slow beating shimmer
  }
  return tail(d, 0.5);
}

/**
 * A brush across the bars: `count` bars over `duration` s, a little uneven in time, wandering up and down the
 * pentatonic scale without repeating a bar, each a little louder or softer.
 * Returns [{ time (s), note (bar index), gain, pan (-1..1), detune (pitch factor) }].
 */
export function cascade(count, duration, seed) {
  const rng = new DotNetRandom(seed), list = [];
  let note = 1 + rng.next(0, BAR_HZ.length - 3), dir = rng.next(0, 2) === 0 ? 1 : -1;
  for (let i = 0; i < count; i++) {
    const u = count > 1 ? i / (count - 1) : 0;
    const t = 0.04 + duration * Math.pow(u, 0.9) * 0.88 + (rng.nextDouble() - 0.5) * 0.08;
    list.push({
      time: Math.max(0, t),
      note,
      gain: lerp(0.55, 1, rng.nextDouble()) * (1 - 0.25 * u),
      pan: rng.nextDouble() * 2 - 1,
      detune: 1 + (rng.nextDouble() - 0.5) * 0.008,
    });
    // next bar: one or two steps on, turning at the ends (and sometimes on its own), never the same bar
    const step = rng.nextDouble() < 0.7 ? 1 : 2;
    if (rng.nextDouble() < 0.25) dir = -dir;
    let nn = note + dir * step;
    if (nn < 0 || nn >= BAR_HZ.length) { dir = -dir; nn = note + dir * step; }
    note = clamp(nn, 0, BAR_HZ.length - 1);
  }
  return list;
}

// ------------------------------------------------------------------ hanji paper, swell tone

/** Time of the closing tap in the roll-up sound (s). */
export const PAPER_CLOSE_TAP = 0.86;
/** Time of the loudest point of the swell tone (s). */
export const SWELL_PEAK = 0.95;

/**
 * Hanji paper: soft friction "srrr" (band-passed noise whose grain wobbles like a sheet sliding off a roll) with
 * small crinkle grains; `close` adds a soft tap at PAPER_CLOSE_TAP as the roll shuts.
 */
export function paperData(length, close, seed) {
  const rng = new DotNetRandom(seed);
  const n = Math.trunc((length + (close ? 0.35 : 0.25)) * RATE);
  const fr = noise(n, rng);
  bandPass(fr, close ? 2100 : 2600, 0.6);
  const lowRub = noise(n, rng);
  bandPass(lowRub, 700, 0.8);
  // friction envelope: swell in, carry, ease out; a slow random wobble for the paper's grain.
  // Kept exactly as Unity plays it: Mathf.SmoothStep(0.7, 1.05, u) is a value eased from 0.7 to 1.05 (not GLSL's
  // edge pair), so the rustle starts at 0.3, falls to 0 near u = 0.76 and ends on a quiet inverted -0.05 tail.
  let wob = 0, wobT = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE, u = clamp01(t / length);
    const env = smoothStep(0, 1, clamp01(t / 0.08)) * (1 - smoothStep(0.7, 1.05, u));
    if (i % 480 === 0) wobT = 0.55 + 0.45 * rng.nextDouble();
    wob += (wobT - wob) * 0.004;
    fr[i] = (fr[i] * 0.8 + lowRub[i] * 0.35) * env * wob;
  }
  // crinkle grains: tiny bright crackles, denser in the middle of the movement
  const grains = Math.trunc(length * 46);
  for (let g = 0; g < grains; g++) {
    const t0 = length * Math.pow(rng.nextDouble(), 0.9) * 0.95;
    const s0 = Math.trunc(t0 * RATE), len = Math.trunc((0.0015 + 0.004 * rng.nextDouble()) * RATE);
    const a = (0.25 + 0.75 * rng.nextDouble()) * 0.22; // grains sit inside the rustle, not on top
    const f = 3000 + 4000 * rng.nextDouble();
    for (let i = 0; i < len && s0 + i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos(TWO_PI * i / len); // Hann: no hard click
      fr[s0 + i] += a * w * (rng.nextDouble() * 2 - 1) * 0.6 + a * w * 0.4 * Math.sin(TWO_PI * f * i / RATE);
    }
  }
  if (close) {
    // the roll closing: a soft low "tuk" (a damped thump and a little paper slap)
    const s0 = Math.trunc(PAPER_CLOSE_TAP * RATE);
    const slap = noise(Math.trunc(0.05 * RATE), rng);
    lowPass(slap, 1400);
    const m = Math.trunc(0.25 * RATE);
    for (let i = 0; s0 + i < n && i < m; i++) {
      const t = i / RATE;
      const env = (1 - Math.exp(-t / 0.002)) * Math.exp(-t / 0.045);
      const thump = Math.sin(TWO_PI * (150 - 40 * clamp01(t / 0.08)) * t) * env * 1.4;
      const sl = i < slap.length ? slap[i] * Math.exp(-t / 0.012) * 2.2 : 0;
      fr[s0 + i] += thump + sl;
    }
  }
  for (let i = 0; i < n; i++) fr[i] = Math.tanh(fr[i] * 2.5); // gentle limiter: body up, spikes down
  normalize(fr, 0.55);
  return fr;
}

/**
 * "Jiiiing~": a rubbed singing bowl / wet glass rim. A clear tone (few partials) that blooms up to SWELL_PEAK and
 * fades, rising a touch in pitch, with the bowl's slow beating.
 */
export function swellToneData() {
  const len = 3.4, f0 = 1174.66; // D6, in the chime's pentatonic
  const n = Math.trunc(len * RATE), d = new Float32Array(n);
  let ph1 = 0, ph2 = 0, ph3 = 0, ph4 = 0;
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    // bloom: slow rise to the peak, then a long soft fade
    const rise = smoothStep(0, 1, clamp01(t / SWELL_PEAK));
    const env = rise * (t > SWELL_PEAK ? Math.exp(-(t - SWELL_PEAK) / 0.75) : 1);
    const f = f0 * (1 + 0.012 * smoothStep(0, 1, clamp01(t / 1.6))); // glides up a touch
    ph1 += TWO_PI * f / RATE;
    ph2 += TWO_PI * (f + 1.6) / RATE; // slow beating like a bowl
    ph3 += TWO_PI * f * 2 / RATE;
    ph4 += TWO_PI * f * 2.92 / RATE;  // faint bowl overtone
    const rub = 1 + 0.04 * Math.sin(TWO_PI * 5.2 * t); // the finger going round
    d[i] = env * rub * (Math.sin(ph1) * 0.62 + Math.sin(ph2) * 0.38 + Math.sin(ph3) * 0.1 * rise + Math.sin(ph4) * 0.035);
  }
  return tail(d, 0.5);
}

// ------------------------------------------------------------------ distant fireworks

/** Many variants: no snap pattern repeats audibly. */
export const FIREWORK_VARIANTS = 12;

/**
 * The pops' rhythm: 3-5 close together in the first ~0.3 s, the rest thinning out to ~2.3 s.
 * Returns [{ time (s), variant, gain, pitch, angle (yaw offset, deg), tilt (pitch offset, deg) }].
 */
export function fireworkSchedule(seed) {
  const rng = new DotNetRandom(seed);
  const count = 10 + rng.next(0, 7), dense = 3 + rng.next(0, 3);
  const list = [];
  for (let i = 0; i < count; i++) {
    let t;
    if (i < dense) t = 0.02 + 0.3 * i / dense + rng.nextDouble() * 0.05;
    else {
      const u = (i - dense + 1) / (count - dense);
      t = 0.35 + 1.95 * Math.pow(u, 1.5) + (rng.nextDouble() - 0.5) * 0.12;
    }
    list.push({
      time: Math.max(0, t),
      variant: rng.next(0, FIREWORK_VARIANTS),
      gain: lerp(0.45, 1, rng.nextDouble()) * (1 - 0.35 * clamp01(t / 2.3)),
      pitch: lerp(0.85, 1.2, rng.nextDouble()),
      angle: (rng.nextDouble() * 2 - 1) * 7,
      tilt: (rng.nextDouble() * 2 - 1) * 4,
    });
  }
  return list;
}

/**
 * One small distant firework crackle: 3-8 snaps at irregular (Poisson) intervals, each with its own random band
 * (800 Hz-8 kHz, random Q), length (2-40 ms), decay and a fine flutter; a noise "sizzle" after them; a faint low air
 * "whum" and a wide, soft far-away tail. Nothing repeats a fixed frequency.
 */
export function fireworkPopData(seed) {
  const rng = new DotNetRandom(seed * 7919 + 13), R = () => rng.nextDouble();
  const n = Math.trunc(1.4 * RATE), d = new Float32Array(n);
  // snaps: Poisson-like gaps (exponential, mean ~18 ms), the first one the strongest
  const snaps = 3 + rng.next(0, 6);
  let t0 = 0;
  for (let c = 0; c < snaps; c++) {
    if (c > 0) t0 += -Math.log(Math.max(1e-4, R())) * 0.018;
    const dur = Math.exp(lerp(Math.log(0.002), Math.log(0.04), R())); // 2-40 ms, log-uniform
    const fc = Math.exp(lerp(Math.log(800), Math.log(8000), R()));    // 0.8-8 kHz
    const s0 = Math.trunc(t0 * RATE), m = Math.trunc(dur * 2.5 * RATE) + 8;
    const nz = noise(m, rng);
    bandPass(nz, fc, lerp(0.5, 2, R()));
    if (R() < 0.5) bandPass(nz, fc * lerp(0.7, 1.4, R()), 0.7); // some snaps a little purer
    const g = (c === 0 ? 1 : lerp(0.3, 0.95, R())) * Math.exp(-t0 / 0.25);
    const att = lerp(0.0002, 0.0012, R()), tau = dur * lerp(0.25, 0.6, R());
    let fl = 0;
    for (let i = 0; i < m && s0 + i < n; i++) {
      const t = i / RATE;
      fl += ((R() * 2 - 1) - fl) * 0.08; // fine, irregular flutter
      const env = (1 - Math.exp(-t / att)) * Math.exp(-t / tau) * (1 + 0.45 * fl);
      d[s0 + i] += g * env * nz[i] * 2.2;
    }
  }
  // sizzle: sparse tiny noise grains thinning out over 60-250 ms (no tones)
  const sz = lerp(0.06, 0.25, R());
  const hiss = noise(n, rng);
  bandPass(hiss, lerp(2500, 6500, R()), 0.6);
  let grain = 0;
  const sEnd = Math.min(n, Math.trunc((t0 + sz * 3) * RATE));
  for (let i = 0; i < sEnd; i++) {
    if (R() < 0.004) grain = lerp(0.3, 1, R()); // a new grain now and then
    grain *= 0.996;
    d[i] += hiss[i] * grain * 0.18 * Math.exp(-(i / RATE) / sz);
  }
  // a faint low air "whum" (distance), very small
  const low = noise(n, rng);
  lowPass(low, 140);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    d[i] += low[i] * 0.45 * (1 - Math.exp(-t / 0.01)) * Math.exp(-t / 0.18);
  }
  // wide, soft far-away tail: combs at irregular delays + one all-pass to smear the echoes
  const wet = new Float32Array(n), cb = new Float32Array(n);
  for (const sec of [0.0311, 0.0419, 0.0533, 0.0677, 0.0791]) {
    const L = samples(sec);
    for (let i = 0; i < n; i++) cb[i] = d[i] + (i >= L ? cb[i - L] * 0.72 : 0);
    for (let i = 0; i < n; i++) wet[i] += cb[i] * 0.2;
  }
  const ap = samples(0.0051), apb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = wet[i] + (i >= ap ? apb[i - ap] * 0.6 : 0);
    apb[i] = x;
    wet[i] = (i >= ap ? apb[i - ap] : 0) - 0.6 * x;
  }
  lowPass(wet, 6000); // air softens the tail a little (the snaps stay bright)
  for (let i = 0; i < n; i++) d[i] = d[i] * 0.8 + wet[i] * 0.4;
  // gentle limiter so the short snaps carry about the same loudness at the same volume
  const mx = peakOf(d);
  if (mx > 1e-6) for (let i = 0; i < n; i++) d[i] = Math.tanh(d[i] / mx * 1.6);
  normalize(d, 0.6);
  return d;
}

// ------------------------------------------------------------------ bells, swells, whoosh, sparkles

/** Bell partials [[Hz, level], ...]: fast attack, higher partials fade sooner, early-echo tail (peak 0.7). */
export function bellData(length, decay, partials) {
  const n = Math.trunc(length * RATE), d = new Float32Array(n);
  partials.forEach(([f, a], k) => addSine(d, 0, n, f, k * 1.3, a, decay / (1 + 0.5 * k) / 2.2, 0.006));
  return tail(d, 0.7);
}

/** A chord that blooms upward (each partial 60 ms after the last), holds, fades (peak 0.65). */
export function swellChordData(length, rise, decay, partials) {
  const n = Math.trunc(length * RATE), d = new Float32Array(n);
  partials.forEach(([f, a], k) => {
    const delay = k * 0.06;
    for (let i = Math.ceil(delay * RATE); i < n; i++) {
      const t = i / RATE - delay;
      if (t < 0) continue;
      const up = smoothStep(0, 1, clamp01(t / rise));
      const env = up * Math.exp(-Math.max(0, t - rise) / decay * 1.5);
      const vib = 1 + 0.002 * Math.sin(TWO_PI * 5 * t);
      d[i] += a * env * Math.sin(TWO_PI * f * vib * t);
    }
  });
  return tail(d, 0.65);
}

/** Pings: `count` tiny bells between `from` and `to` s, fLo..fHi Hz, each with a 2.7x overtone. */
function sparkleData(length, count, from, to, fLo, fHi, pingDecay, seed) {
  const n = Math.trunc(length * RATE), d = new Float32Array(n);
  const rng = new DotNetRandom(seed);
  for (let p = 0; p < count; p++) {
    const t0 = lerp(from, to, Math.pow(rng.nextDouble(), 0.8));
    const f = lerp(fLo, fHi, rng.nextDouble());
    const a = lerp(0.3, 1, rng.nextDouble()) * (1 - 0.5 * (t0 - from) / Math.max(0.01, to - from));
    const s0 = Math.trunc(t0 * RATE), len = Math.min(n - s0, Math.trunc(pingDecay * 3 * RATE));
    if (len <= 0) continue;
    addSine(d, s0, len, f, 0, a, pingDecay / 2, 0.003);
    addSine(d, s0, len, f * 2.7, 0, 0.3 * a, pingDecay / 2, 0.003);
  }
  return d;
}

export const sparklesData = (name, length, count, from, to, fLo, fHi, pingDecay) =>
  tail(sparkleData(length, count, from, to, fLo, fHi, pingDecay, monoHash(name)), 0.6);

/** The flight: a low-passed noise swish that opens and closes, with a sparkle trail on top (peak 0.5). */
export function whooshData(length) {
  const n = Math.trunc(length * RATE), d = new Float32Array(n);
  const rng = new DotNetRandom(3);
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const env = Math.sin(Math.PI * Math.pow(t, 0.7)) * (1 - t * 0.3);
    const cutoff = lerp(0.02, 0.12, Math.sin(Math.PI * t)); // the swish opens and closes
    lp += (rng.nextDouble() * 2 - 1 - lp) * cutoff;
    d[i] = lp * env * 2.5;
  }
  const s = sparkleData(length, 14, 0.25, length * 0.95, 1800, 3000, 0.3, 11);
  for (let i = 0; i < n; i++) d[i] += s[i] * 0.35;
  return tail(d, 0.5);
}

// ------------------------------------------------------------------ the clips, by name (StorySounds.Synthesize)

/**
 * Every synthesized clip StorySounds plays, as a builder. sounds.js builds each once, when it is first wanted.
 * Unity also makes synIntro and synInstruction, but nothing plays them while no clip is assigned (the intro uses the
 * bars and the swell tone), so they are left out.
 */
export const CLIPS = {
  paperOpen: () => paperData(0.7, false, 21),   // MR_PaperUnroll
  paperClose: () => paperData(0.9, true, 37),   // MR_PaperRollUp
  swellTone: swellToneData,                     // MR_SwellTone
  ending: () => bellData(2.6, 2.0, [[523.25, 0.8], [659.25, 0.7], [783.99, 0.7], [1046.5, 0.45], [2093, 0.12]]),
  strike: () => bellData(1.0, 0.8, [[1318.5, 0.8], [1975.5, 0.45], [2637, 0.25]]),
  milestone: () => bellData(2.0, 1.5, [[1046.5, 0.8], [1318.5, 0.7], [1568, 0.6], [2093, 0.35]]),
  fullMoon: () => swellChordData(2.6, 0.9, 1.4, [[523.25, 0.7], [659.25, 0.6], [783.99, 0.6], [1046.5, 0.5], [1568, 0.25], [2093, 0.15]]),
  flight: () => whooshData(3.4),
  arrival: () => sparklesData('MR_ArrivalBurst', 2.2, 28, 0.05, 1.1, 1400, 3200, 0.35),
  wish: () => sparklesData('MR_WishTwinkles', 3.5, 18, 0.1, 3.2, 1600, 2800, 0.5),
};
for (let i = 0; i < BAR_HZ.length; i++) CLIPS[`bar${i}`] = () => barData(i);           // MR_ChimeBar_i
for (let v = 0; v < FIREWORK_VARIANTS; v++) CLIPS[`pop${v}`] = () => fireworkPopData(v); // MR_FireworkPop_v
