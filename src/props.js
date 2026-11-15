import * as THREE from 'three';

// The mortar (usu) and the mallet (kine) as meshes. station.js shows these, and the collision shapes
// in src/kineContact.js and the dough's mortar (usuShape below) are read back from them (their geometry
// parameters and transforms), so what you see is exactly what collides. Round surfaces use enough segments that the drawn facets stay within a
// fraction of a millimetre of the true surfaces the collision uses.

// usu: { radius, height }; mats: { side, top, band, mat }
export function makeUsu({ radius: R, height: H }, mats) {
  const usu = new THREE.Group();
  usu.name = 'usu';
  const prof = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    prof.push(new THREE.Vector2(R * (0.92 + 0.08 * Math.sin(t * Math.PI)), t * H));
  }
  // the bowl carved into the top
  prof.push(new THREE.Vector2(R * 0.78, H));
  for (let i = 1; i <= 6; i++) {
    const t = i / 6;
    prof.push(new THREE.Vector2(R * 0.78 * Math.cos((t * Math.PI) / 2), H - 0.16 * Math.sin((t * Math.PI) / 2)));
  }
  const body = new THREE.Mesh(new THREE.LatheGeometry(prof, 192), mats.side);
  body.name = 'usu-body';
  body.castShadow = body.receiveShadow = true;
  usu.add(body);
  const rim = new THREE.Mesh(new THREE.RingGeometry(R * 0.78, R * 0.99, 192), mats.top);
  rim.name = 'usu-rim';
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = H + 0.001;
  usu.add(rim);
  for (const y of [0.12, H - 0.1]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(R * 0.97 + 0.01, 0.012, 16, 192), mats.band);
    band.name = 'usu-band';
    band.rotation.x = Math.PI / 2;
    band.position.y = y;
    usu.add(band);
  }
  // a straw mat under it
  const mat = new THREE.Mesh(new THREE.CircleGeometry(0.85, 96), mats.mat);
  mat.name = 'usu-mat';
  mat.rotation.x = -Math.PI / 2;
  mat.position.y = 0.005;
  mat.receiveShadow = true;
  usu.add(mat);
  return usu;
}

// The mortar's exact shape as plain data (for usuSdf in src/usuShape.js), read back from the meshes
// makeUsu built: the LatheGeometry's cross-section, the rim RingGeometry (a plate from the body's top out
// to the ring's outer edge) and the iron bands (TorusGeometry). Inside the group the parts are offset
// along the axis only, as makeUsu places them.
export function usuShape(usu) {
  usu.updateWorldMatrix(true, true);
  let lathe = null, ring = null, mat = null;
  const bands = [];
  usu.traverse((o) => {
    if (!o.isMesh) return;
    const t = o.geometry.type;
    if (t === 'LatheGeometry') lathe = o;
    else if (t === 'RingGeometry') ring = o;
    else if (t === 'TorusGeometry') bands.push({ R: o.geometry.parameters.radius, tube: o.geometry.parameters.tube, y: o.position.y });
    else if (t === 'CircleGeometry') mat = o;
  });
  // cross-section (rho, y), counter-clockwise; it starts on the axis at the bottom and ends on the axis at
  // the bowl's centre, so the closing edge runs along the axis (not a surface). cos(pi / 2) is 6e-17 in
  // floating point, not 0, so a point within round-off of the axis is put on it (otherwise the axis
  // counts as a surface and the distance inside the wood near it is wrong)
  const pts = lathe.geometry.parameters.points.map((p) => [Math.abs(p.x) < 1e-9 ? 0 : p.x, p.y + lathe.position.y]);
  if (ring) {
    const rin = ring.geometry.parameters.innerRadius, rout = ring.geometry.parameters.outerRadius, ry = ring.position.y;
    const k = pts.findIndex((p, i) => i > 0 && Math.abs(p[0] - rin) < 1e-9);
    if (k > 0 && ry > pts[k][1]) pts.splice(k, 0, [rout, pts[k][1]], [rout, ry], [rin, ry]);
  }
  const poly = pts[0][0] === 0 ? pts : [[0, pts[0][1]], ...pts];
  const surface = poly.map((a, i) => { const b = poly[(i + 1) % poly.length]; return !(a[0] === 0 && b[0] === 0); });
  const top = new THREE.Vector3(0, Math.max(...poly.map((p) => p[1])), 0).applyMatrix4(usu.matrixWorld);
  return {
    m: Array.from(usu.matrixWorld.elements), inv: Array.from(usu.matrixWorld.clone().invert().elements),
    poly, surface, bands, x: top.x, z: top.z, top: top.y,
    mat: mat ? { r: mat.geometry.parameters.radius, y: mat.position.y } : null,
  };
}

// Kine-local frame: origin at the hands, handle along -Z, head centre at (0, 0, -length), head axis +Y.
// mats: { wood, band }
export function makeKine(length, mats) {
  const kine = new THREE.Group();
  kine.name = 'kine';
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, length + 0.12, 48), mats.wood);
  handle.name = 'kine-handle';
  handle.rotation.x = Math.PI / 2;
  handle.position.z = -(length + 0.12) / 2 + 0.1;
  handle.castShadow = true;
  kine.add(handle);
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.32, 96), mats.wood);
  head.name = 'kine-head';
  head.position.z = -length;
  head.castShadow = true;
  kine.add(head);
  for (const y of [-0.13, 0.13]) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.101, 0.008, 12, 96), mats.band);
    band.name = 'kine-band';
    band.rotation.x = Math.PI / 2;
    band.position.set(0, y, -length);
    kine.add(band);
  }
  return kine;
}
