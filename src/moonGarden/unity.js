// Unity/.NET maths the Moon garden builder (MochiPound, Assets/_Project/World/Editor/EnvironmentBuilder.cs)
// relies on, ported exactly so the seeded layout (bamboo, tree, stones, rocks) comes out as in Unity:
//  - System.Random(seed): Knuth's subtractive generator (.NET Framework / Mono / .NET Net5CompatSeedImpl);
//  - the builder's Rng wrapper (float Value, Range, Int);
//  - Mathf.PerlinNoise (Ken Perlin's improved noise in 2D, normalised (n + 0.69) / 1.483). Checked by hand
//    against the prefab: Noise3((3.5, 0, 0.4), 0.9, 3) = 0.69834 gives the paper lantern stand's baked
//    y = 0.0033762418 exactly;
//  - Noise3, Hash01 (float32: Hash01 amplifies 1-ulp differences, so the stalk positions feeding it are
//    computed with float32 rounding at every step, as C# float code does);
//  - Mathf helpers in float32, GammaToLinearSpace, Quaternion.LookRotation / Euler, Mathf.SmoothDamp.
// Everything here works in Unity's own (left-handed, +Z forward) coordinates; the scene puts the result under
// a node scaled (1, 1, -1).
import * as THREE from 'three';

export const f = Math.fround;

// ---------------------------------------------------------------- System.Random
const MBIG = 2147483647, MSEED = 161803398;
export class DotNetRandom {
  constructor(seed) {
    const a = new Int32Array(56);
    const subtraction = seed === -2147483648 ? 2147483647 : Math.abs(seed);
    let mj = MSEED - subtraction, mk = 1;
    a[55] = mj;
    for (let i = 1; i < 55; i++) {
      const ii = (21 * i) % 55;
      a[ii] = mk;
      mk = mj - mk;
      if (mk < 0) mk += MBIG;
      mj = a[ii];
    }
    for (let k = 1; k < 5; k++) {
      for (let i = 1; i < 56; i++) {
        a[i] -= a[1 + ((i + 30) % 55)];
        if (a[i] < 0) a[i] += MBIG;
      }
    }
    this.a = a;
    this.inext = 0;
    this.inextp = 21;
  }
  internalSample() {
    let n = this.inext, p = this.inextp;
    if (++n >= 56) n = 1;
    if (++p >= 56) p = 1;
    let r = this.a[n] - this.a[p];
    if (r === MBIG) r--;
    if (r < 0) r += MBIG;
    this.a[n] = r;
    this.inext = n;
    this.inextp = p;
    return r;
  }
  sample() { return this.internalSample() * (1.0 / MBIG); }
  nextDouble() { return this.sample(); }
  next(min, max) { return Math.trunc(this.sample() * (max - min)) + min; } // range <= int.MaxValue branch
}

// EnvironmentBuilder.Rng
export class Rng {
  constructor(seed) { this.raw = new DotNetRandom(seed); }
  get value() { return f(this.raw.nextDouble()); }
  range(a, b) { const fa = f(a), fb = f(b), v = this.value; return f(fa + f(f(fb - fa) * v)); }
  int(min, max) { return this.raw.next(min, max); }
}

// ---------------------------------------------------------------- Mathf (float32)
export const PI32 = f(Math.PI);
export const DEG2RAD = f(f(PI32 * 2) / 360);
export const RAD2DEG = f(1 / DEG2RAD);
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerpF = (a, b, t) => f(a + f(f(b - a) * clamp01(t)));
export const inverseLerpF = (a, b, v) => (a !== b ? clamp01(f(f(v - a) / f(b - a))) : 0);
export function smoothStepF(from, to, t) {
  t = clamp01(t);
  t = f(f(f(f(-2 * t) * t) * t) + f(f(3 * t) * t));
  return f(f(to * t) + f(from * f(1 - t)));
}
export const repeatF = (t, len) => clamp(f(t - f(f(Math.floor(f(t / len))) * len)), 0, len);
export function deltaAngleF(cur, tgt) { let d = repeatF(f(tgt - cur), 360); if (d > 180) d = f(d - 360); return d; }
export const sinF = (x) => f(Math.sin(x));
export const cosF = (x) => f(Math.cos(x));
export const sqrtF = (x) => f(Math.sqrt(x));
// Math.Round / Mathf.RoundToInt: round half to even
export function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
// plain double versions for geometry that only has to look right
export const lerp = (a, b, t) => a + (b - a) * clamp01(t);
export const inverseLerp = (a, b, v) => (a !== b ? clamp01((v - a) / (b - a)) : 0);
export function smoothStep(from, to, t) { t = clamp01(t); t = -2 * t * t * t + 3 * t * t; return to * t + from * (1 - t); }
export function deltaAngle(cur, tgt) {
  let d = tgt - cur;
  d = clamp(d - Math.floor(d / 360) * 360, 0, 360);
  return d > 180 ? d - 360 : d;
}
export function ramp(v, a, b) { const t = clamp01((v - a) / Math.max(1e-4, b - a)); return t * t * (3 - 2 * t); }

// Unity GammaToLinearSpace (used for every colour Unity converts in linear colour space: material and
// light colours, ambient, fog, skybox tint). Above 1 (HDR emission) it is a plain 2.2 power.
export function g2l(v) {
  if (v <= 0.04045) return v / 12.92;
  if (v < 1) return Math.pow((v + 0.055) / 1.055, 2.4);
  return Math.pow(v, 2.2);
}
// THREE.Color (linear working space) from a Unity gamma-space colour [r, g, b] times k (k applied in gamma space,
// as Unity scripts multiply Colors before Unity linearises them)
export function linColor(out, c, k = 1) {
  return out.setRGB(g2l(c[0] * k), g2l(c[1] * k), g2l(c[2] * k), THREE.LinearSRGBColorSpace);
}
export const hex = (rgb) => [((rgb >> 16) & 255) / 255, ((rgb >> 8) & 255) / 255, (rgb & 255) / 255];
export const lerpColor = (a, b, t) => { t = clamp01(t); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; };
export const mulColor = (c, k) => [c[0] * k, c[1] * k, c[2] * k];

// ---------------------------------------------------------------- Mathf.PerlinNoise
const PERM = [151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23,
  190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168,
  68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244,
  102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173,
  186, 3, 64, 52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223,
  183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232,
  178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192,
  214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128,
  195, 78, 66, 215, 61, 156, 180];
const P = new Uint8Array(512);
for (let i = 0; i < 512; i++) P[i] = PERM[i & 255];
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const plerp = (t, a, b) => a + t * (b - a);
function grad2(h, x, y) {
  h &= 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : 0;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}
export function perlinNoise(x, y) {
  const fx = Math.floor(x), fy = Math.floor(y);
  const X = fx & 255, Y = fy & 255;
  x -= fx; y -= fy;
  const u = fade(x), v = fade(y);
  const A = P[X] + Y, AA = P[A], AB = P[A + 1], B = P[X + 1] + Y, BA = P[B], BB = P[B + 1];
  const res = plerp(v, plerp(u, grad2(P[AA], x, y), grad2(P[BA], x - 1, y)), plerp(u, grad2(P[AB], x, y - 1), grad2(P[BB], x - 1, y - 1)));
  return (res + 0.69) / (0.793 + 0.69);
}
// EnvironmentBuilder.Noise3
export function noise3(x, y, z, freq, seed) {
  const o = seed * 7.31 + 50;
  x = x * freq + o; y = y * freq + o; z = z * freq + o;
  const n = (perlinNoise(x, y) + perlinNoise(y, z) + perlinNoise(z, x)) / 3;
  return clamp01(0.5 + (n - 0.5) * 1.8);
}
// EnvironmentBuilder.Hash01, float32
const H1 = f(12.9898), H2 = f(78.233), H3 = f(43758.5453);
export function hash01(x, z) {
  const v = f(sinF(f(f(x * H1) + f(z * H2))) * H3);
  return f(v - Math.floor(v));
}

// ---------------------------------------------------------------- directions and rotations (Unity numbers)
// MoonRabbitEnvironmentSettings.Azimuth: 0 = +Z, 90 = +X (float32)
export function azimuthF(deg) { const a = f(deg * DEG2RAD); return [sinF(a), 0, cosF(a)]; }
export function azimuth(deg) { const a = deg * Math.PI / 180; return [Math.sin(a), 0, Math.cos(a)]; }
export function skyDirection(az, el) {
  const e = el * Math.PI / 180, d = azimuth(az), c = Math.cos(e);
  return [d[0] * c, Math.sin(e), d[2] * c];
}
// Quaternion.Euler(x, y, z) in degrees: z, then x, then y (three's 'YXZ' order gives the same numbers)
const _e = new THREE.Euler();
export function eulerQ(x, y, z, out = new THREE.Quaternion()) {
  return out.setFromEuler(_e.set(x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180, 'YXZ'));
}
// Quaternion.LookRotation(forward) with up = +Y
const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
export function lookRotation(fwd, out = new THREE.Quaternion()) {
  _z.set(fwd[0], fwd[1], fwd[2]).normalize();
  _x.crossVectors(UP, _z);
  if (_x.lengthSq() < 1e-12) _x.set(1, 0, 0);
  _x.normalize();
  _y.crossVectors(_z, _x);
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

// Mathf.SmoothDamp; state = { v } holds the velocity
export function smoothDamp(current, target, state, smoothTime, dt) {
  if (dt <= 0) return current;
  smoothTime = Math.max(0.0001, smoothTime);
  const omega = 2 / smoothTime, x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target, originalTo = target;
  target = current - change;
  const temp = (state.v + omega * change) * dt;
  state.v = (state.v - omega * temp) * exp;
  let out = target + (change + temp) * exp;
  if (originalTo - current > 0 === out > originalTo) { out = originalTo; state.v = (out - originalTo) / dt; }
  return out;
}
