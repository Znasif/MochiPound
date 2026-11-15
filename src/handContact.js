import { usuSdf } from './usuShape.js';

// Hands against solid things (2026-11-15, the user: contacts between all kinds of objects and hands). A hand that
// went into something solid is moved out of it as one piece, by the smallest shift that clears every joint at
// the size it is drawn. The solids: the mortar (its exact shape, src/usuShape.js), the ground, and the water
// bucket's tub wall, bottom and stand. The dough is soft (it deforms around hands, src/dough/), and the mallet
// already yields to hands (src/kineContact.js, which is also what counts a hit on a hand), so neither is here.
// A tracked hand is moved where it is drawn and where the dough and the mallet feel it (what you see is what
// they feel); a controller's hand, drawn only, where it is drawn.

const EPS = 0.001, ITER = 6, MAX_SHIFT = 0.3;

// signed distance to a 2D box [x0, x1] x [y0, y1] (negative inside)
function box2(x, y, x0, x1, y0, y1) {
  const dx = Math.max(x0 - x, x - x1), dy = Math.max(y0 - y, y - y1);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}
function box3(x, y, z, c, e) {
  const dx = Math.abs(x - c[0]) - e[0], dy = Math.abs(y - c[1]) - e[1], dz = Math.abs(z - c[2]) - e[2];
  return Math.min(Math.max(dx, dy, dz), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0));
}

// usu: usuShape(usu) (props.js); oke: L.OKE { position, radius, height, stand }; groundY: the floor's height
export function createHandContact({ usu = null, oke = null, groundY = 0, wall = 0.012 } = {}) {
  const n = [0, 0, 0];
  const [ox, , oz] = oke?.position ?? [0, 0, 0];
  // the whole static scene's signed distance at a point (the nearest solid)
  function sdf(x, y, z) {
    let d = y - groundY;
    if (usu) d = Math.min(d, usuSdf(usu, x, y, z));
    if (oke) {
      const rho = Math.hypot(x - ox, z - oz), y0 = oke.stand, h = oke.height;
      const u = Math.min(1, Math.max(0, (y - y0) / h)), rOut = oke.radius * (0.88 + 0.12 * u);
      d = Math.min(d,
        box2(rho, y, rOut - wall, rOut, y0, y0 + h), // the tub's wall (open at the top: the water is not solid)
        box2(rho, y, 0, oke.radius * 0.88, y0, y0 + 0.02), // its bottom
        box3(x, y, z, [ox, y0 / 2, oz], [oke.radius * 1.15, y0 / 2, oke.radius * 1.15])); // the stand
    }
    return d;
  }
  function normal(x, y, z, out) {
    const e = 5e-4;
    out[0] = sdf(x + e, y, z) - sdf(x - e, y, z);
    out[1] = sdf(x, y + e, z) - sdf(x, y - e, z);
    out[2] = sdf(x, y, z + e) - sdf(x, y, z - e);
    const l = Math.hypot(out[0], out[1], out[2]) || 1;
    out[0] /= l; out[1] /= l; out[2] /= l;
    return out;
  }
  return {
    sdf,
    // points: [{ x, y, z }] (Vector3s), radii: their drawn radius each (or one number); out: a Vector3 for the
    // shift that clears them all (0 when nothing is touched). Returns the deepest overlap it cleared (m), 0 if none.
    resolve(points, radii, out) {
      out.set(0, 0, 0);
      let first = 0;
      for (let it = 0; it < ITER; it++) {
        let worst = 0, wk = -1;
        for (let k = 0; k < points.length; k++) {
          const p = points[k], r = typeof radii === 'number' ? radii : radii[k];
          const d = sdf(p.x + out.x, p.y + out.y, p.z + out.z) - r;
          if (d < worst) { worst = d; wk = k; }
        }
        if (wk < 0) break;
        if (it === 0) first = -worst;
        const p = points[wk];
        normal(p.x + out.x, p.y + out.y, p.z + out.z, n);
        out.x -= (worst - EPS) * n[0]; out.y -= (worst - EPS) * n[1]; out.z -= (worst - EPS) * n[2];
      }
      // a hand that went far into a solid (there is no real mortar to stop a real hand), or one wedged where no
      // short push clears it (deep in the mortar's foot, which stands on the ground), is let through whole rather
      // than drawn a long way off or half sunk
      let left = 0;
      for (let k = 0; k < points.length; k++) {
        const p = points[k], r = typeof radii === 'number' ? radii : radii[k];
        left = Math.min(left, sdf(p.x + out.x, p.y + out.y, p.z + out.z) - r);
      }
      if (out.length() > MAX_SHIFT || left < -0.002) { out.set(0, 0, 0); return 0; }
      return first;
    },
  };
}
