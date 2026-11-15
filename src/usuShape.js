// The mortar's exact signed distance, in plain JS (no three.js), so the mallet's collision
// (src/kineContact.js) and the dough simulation in its Web Worker (src/dough/mpm-core.js) use one
// function on one shape. The shape is read back from the meshes by usuShape() in src/props.js:
//   m, inv:  the mortar's world matrix and its inverse (column-major 4x4, rigid)
//   poly:    its cross-section [[rho, y], ...], counter-clockwise, in its own frame
//   surface: per edge of poly (poly[i] -> poly[i + 1]), false for the edge along the axis, which is not a surface
//   bands:   the iron bands [{ R, tube, y }] (tori around the axis)
//   x, z, top: where its axis is and its highest point, in world coordinates
//   mat:     the straw mat under it { r, y }, or null
// The mortar is a solid of revolution, so the 3D distance to its surface is the 2D distance to the
// cross-section's outline: exact, not an approximation.

// Signed distance (m, negative inside the wood) from the world point (px, py, pz). If `n` is given,
// the outward unit normal (world) is written to n[0..2].
export function usuSdf(s, px, py, pz, n) {
  const e = s.inv;
  const lx = e[0] * px + e[4] * py + e[8] * pz + e[12];
  const y = e[1] * px + e[5] * py + e[9] * pz + e[13];
  const lz = e[2] * px + e[6] * py + e[10] * pz + e[14];
  const rho = Math.sqrt(lx * lx + lz * lz);
  const poly = s.poly, surface = s.surface, nP = poly.length;
  let inside = false, best = Infinity, qx = 0, qy = 0, ex = 0, ey = 1;
  for (let i = 0; i < nP; i++) {
    const a = poly[i], b = poly[i + 1 === nP ? 0 : i + 1];
    const ax = a[0], ay = a[1], bx = b[0], by = b[1];
    if ((ay > y) !== (by > y) && rho < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside; // crossing number
    if (!surface[i]) continue;
    const abx = bx - ax, aby = by - ay;
    const t = Math.min(1, Math.max(0, ((rho - ax) * abx + (y - ay) * aby) / (abx * abx + aby * aby || 1)));
    const cx = ax + abx * t, cy = ay + aby * t, d = (rho - cx) * (rho - cx) + (y - cy) * (y - cy);
    if (d < best) { best = d; qx = cx; qy = cy; const l = Math.sqrt(abx * abx + aby * aby) || 1; ex = aby / l; ey = -abx / l; }
  }
  const dist = Math.sqrt(best);
  let sd = inside ? -dist : dist, gr, gy;
  if (dist > 1e-12) { gr = (rho - qx) / sd; gy = (y - qy) / sd; } else { gr = ex; gy = ey; } // (p - q) / sd points outward
  for (const bd of s.bands) {
    const dr = rho - bd.R, dy = y - bd.y, l = Math.sqrt(dr * dr + dy * dy), sb = l - bd.tube;
    if (sb < sd) { sd = sb; gr = l > 1e-12 ? dr / l : 1; gy = l > 1e-12 ? dy / l : 0; }
  }
  if (n) {
    const ux = rho > 1e-12 ? lx / rho : 1, uz = rho > 1e-12 ? lz / rho : 0;
    const nx = gr * ux, nz = gr * uz, m = s.m;
    n[0] = m[0] * nx + m[4] * gy + m[8] * nz;
    n[1] = m[1] * nx + m[5] * gy + m[9] * nz;
    n[2] = m[2] * nx + m[6] * gy + m[10] * nz;
  }
  return sd;
}
