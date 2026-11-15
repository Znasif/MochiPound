// Port of MochiPound's MeshBuilder.cs / Icosphere (Assets/_Project/World/Editor): flat-shaded low-poly meshes
// with one triangle list per sub-mesh (material). Every triangle takes a "facing" hint and is wound so that
// cross(b - a, c - a) points that way: Unity's front side (clockwise on screen in its left-handed frame). The
// meshes are drawn under a node scaled (1, 1, -1), where three flips the front face, so they render as in Unity.
// Vectors are [x, y, z] arrays in Unity coordinates. Vertex colours and UVs (unused by these materials) are left out.
import * as THREE from 'three';

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.sqrt(dot(a, a));
export function norm(a) { const l = len(a); return l > 1e-5 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; }
export const scale3 = (a, s) => [a[0] * s[0], a[1] * s[1], a[2] * s[2]];
const UP = [0, 1, 0], RIGHT = [1, 0, 0];

const _q = new THREE.Quaternion(), _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vs = new THREE.Vector3();

export class MeshBuilder {
  constructor(subCount = 1) {
    this.subs = [];
    for (let i = 0; i < subCount; i++) this.subs.push({ p: [], n: [] });
  }

  tri(a, b, c, facing, s = 0) {
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
    let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const sq = nx * nx + ny * ny + nz * nz;
    if (sq < 1e-14) return;
    if (nx * facing[0] + ny * facing[1] + nz * facing[2] < 0) { const t = b; b = c; c = t; nx = -nx; ny = -ny; nz = -nz; }
    const l = Math.sqrt(sq);
    nx /= l; ny /= l; nz /= l;
    const { p, n } = this.subs[s];
    p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    n.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  }

  quad(a, b, c, d, facing, s = 0) { this.tri(a, b, c, facing, s); this.tri(a, c, d, facing, s); }

  twoSided(a, b, c, s = 0) {
    const n = cross(sub(b, a), sub(c, a));
    this.tri(a, b, c, n, s);
    this.tri(a, b, c, mul(n, -1), s);
  }

  // tapered cylinder from p0 to p1 (flat facets)
  frustum(p0, p1, r0, r1, sides, s = 0, capBottom = true, capTop = true, angleOffset = 0) {
    const axis = sub(p1, p0);
    if (dot(axis, axis) < 1e-10) return;
    const up = norm(axis);
    const side = norm(cross(up, Math.abs(up[1]) < 0.95 ? UP : RIGHT));
    const fwd = cross(side, up);
    const bottom = [], top = [], radial = [];
    for (let i = 0; i < sides; i++) {
      const a = angleOffset + i * Math.PI * 2 / sides;
      const r = add(mul(side, Math.cos(a)), mul(fwd, Math.sin(a)));
      radial.push(r);
      bottom.push(add(p0, mul(r, r0)));
      top.push(add(p1, mul(r, r1)));
    }
    const down = mul(up, -1);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      const outward = norm(add(radial[i], radial[j]));
      this.quad(bottom[i], top[i], top[j], bottom[j], outward, s);
      if (capBottom && r0 > 0) this.tri(p0, bottom[i], bottom[j], down, s);
      if (capTop && r1 > 0) this.tri(p1, top[i], top[j], up, s);
    }
  }

  // one continuous tube along a polyline, ring frame carried along by parallel transport
  tube(points, radii, sides, s = 0, capBottom = true, capTop = true, angleOffset = 0) {
    const n = points.length;
    if (n < 2) return;
    const rings = [];
    let prevTan = norm(sub(points[1], points[0]));
    let side = norm(cross(prevTan, Math.abs(prevTan[1]) < 0.95 ? UP : RIGHT));
    for (let k = 0; k < n; k++) {
      let tan = k === 0 ? sub(points[1], points[0])
        : k === n - 1 ? sub(points[n - 1], points[n - 2])
          : add(norm(sub(points[k + 1], points[k])), norm(sub(points[k], points[k - 1])));
      tan = dot(tan, tan) < 1e-10 ? prevTan : norm(tan);
      // Quaternion.FromToRotation(prevTan, tan) * side, then ProjectOnPlane(side, tan).normalized
      _q.setFromUnitVectors(_va.set(prevTan[0], prevTan[1], prevTan[2]), _vb.set(tan[0], tan[1], tan[2]));
      _vs.set(side[0], side[1], side[2]).applyQuaternion(_q);
      side = [_vs.x, _vs.y, _vs.z];
      const tt = dot(tan, tan);
      side = norm(tt < 1e-12 ? side : sub(side, mul(tan, dot(side, tan) / tt)));
      const fwd = cross(side, tan);
      prevTan = tan;
      const ring = [];
      for (let i = 0; i < sides; i++) {
        const a = angleOffset + i * Math.PI * 2 / sides;
        ring.push(add(points[k], mul(add(mul(side, Math.cos(a)), mul(fwd, Math.sin(a))), radii[k])));
      }
      rings.push(ring);
    }
    for (let k = 0; k < n - 1; k++) {
      const axisMid = mul(add(points[k], points[k + 1]), 0.5);
      for (let i = 0; i < sides; i++) {
        const j = (i + 1) % sides;
        const c = mul(add(add(rings[k][i], rings[k][j]), add(rings[k + 1][i], rings[k + 1][j])), 0.25);
        this.quad(rings[k][i], rings[k + 1][i], rings[k + 1][j], rings[k][j], sub(c, axisMid), s);
      }
    }
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      if (capBottom && radii[0] > 0) this.tri(points[0], rings[0][i], rings[0][j], sub(points[0], points[1]), s);
      if (capTop && radii[n - 1] > 0) this.tri(points[n - 1], rings[n - 1][i], rings[n - 1][j], sub(points[n - 1], points[n - 2]), s);
    }
  }

  // flat-shaded noisy blob: one System.Random draw per icosphere vertex (rocks, canopy, mounds)
  blob(center, scale, subdivisions, noise, random, s = 0) {
    const { pts, tris } = icosphere(subdivisions);
    const p = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const jitter = Math.fround(1 + Math.fround(Math.fround(Math.fround(random.nextDouble()) * 2) - 1) * noise);
      p[i] = add(center, scale3(mul(pts[i], jitter), scale));
    }
    for (let t = 0; t < tris.length; t += 3) {
      const a = p[tris[t]], b = p[tris[t + 1]], c = p[tris[t + 2]];
      this.tri(a, b, c, sub(mul(add(add(a, b), c), 1 / 3), center), s);
    }
  }

  triangleCount() { return this.subs.reduce((n, s) => n + s.p.length / 9, 0); }

  // one BufferGeometry per sub-mesh (null when it is empty)
  geometries() {
    return this.subs.map(({ p, n }) => {
      if (!p.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
      g.computeBoundingSphere();
      return g;
    });
  }
}

// Icosphere.Build: unit icosphere, shared vertices, the same midpoint order as the C# (so Blob's draws land on
// the same vertices). Cached per level; callers never modify the arrays.
const icoCache = new Map();
export function icosphere(subdivisions) {
  if (icoCache.has(subdivisions)) return icoCache.get(subdivisions);
  const t = (1 + Math.sqrt(5)) / 2;
  let points = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map(norm);
  let tris = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map(), next = [];
    const mid = (a, b) => {
      const key = a < b ? a * 100000 + b : b * 100000 + a;
      if (cache.has(key)) return cache.get(key);
      points.push(norm(mul(add(points[a], points[b]), 0.5)));
      cache.set(key, points.length - 1);
      return points.length - 1;
    };
    for (let i = 0; i < tris.length; i += 3) {
      const a = tris[i], b = tris[i + 1], c = tris[i + 2];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push(a, ab, ca, b, bc, ab, c, ca, bc, ab, bc, ca);
    }
    tris = next;
  }
  const r = { pts: points, tris };
  icoCache.set(subdivisions, r);
  return r;
}

// Icosphere.SmoothSphere: smooth unit sphere, triangles turned to face outward, per-vertex colours from
// colorAt(p) (raw values: Unity passes vertex colours to the shader unconverted, and so does three)
export function smoothSphere(subdivisions, colorAt) {
  const { pts, tris: src } = icosphere(subdivisions);
  const tris = src.slice();
  for (let i = 0; i < tris.length; i += 3) {
    const a = pts[tris[i]], b = pts[tris[i + 1]], c = pts[tris[i + 2]];
    if (dot(cross(sub(b, a), sub(c, a)), add(add(a, b), c)) < 0) { const t = tris[i + 1]; tris[i + 1] = tris[i + 2]; tris[i + 2] = t; }
  }
  const pos = new Float32Array(pts.length * 3), col = new Float32Array(pts.length * 3);
  pts.forEach((p, i) => {
    pos.set(p, i * 3);
    col.set(colorAt(p), i * 3);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(pos.slice(), 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(tris);
  g.computeBoundingSphere();
  return g;
}
