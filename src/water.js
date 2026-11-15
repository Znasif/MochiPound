import * as THREE from 'three';

// The hand-water bucket's water (2026-11-15, the user: water wasn't modelled properly). Water does one thing to
// the dough, its colour (moisture, src/dough/conditioning.js; a dip adds 10%). This is the water itself:
//  - a dip: a hand going clearly under the surface (1.5 cm) inside the tub, after being clearly out of it
//    (every point 1 cm above) for at least 0.5 s. So tracking jitter at the surface is never a dip, and a
//    hand under the bucket isn't in it. Tracked hands and the hands drawn on controllers alike.
//  - the surface: translucent; a dip splashes and ripples, a hand moving in the water ripples
//  - a wet hand: glossier and a little darker for a few seconds after it leaves the water, dripping
// update(dt, probes) takes hands.probes() and returns this frame's dips: [{ key, local, at }]. Only the dips of
// a headset's own hands count toward the moisture (each person's own headset counts theirs).
const ENTER = 0.015, EXIT = 0.01, COOLDOWN = 0.5, WET_TIME = 6;
const RIPPLES = 12, DROPS = 64, GRAVITY = 9.8;

export function createBucketWater({ parent, centre, radius, bottom, surface = null, random = Math.random }) {
  const surfaceY = centre.y;
  if (surface) {
    surface.material = new THREE.MeshStandardMaterial({ color: 0x3a7088, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.78, depthWrite: false });
    surface.renderOrder = 2;
  }
  // ---- ripples: thin rings on the surface that widen and fade
  const ringGeo = new THREE.RingGeometry(0.86, 1, 40);
  const ripples = Array.from({ length: RIPPLES }, () => {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xd8eef6, transparent: true, opacity: 0, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.visible = false; m.renderOrder = 3; m.name = 'water-ripple';
    parent.add(m);
    return { m, age: 0, life: 0, max: 0 };
  });
  let nextRipple = 0;
  function ripple(x, z, size = 1) {
    const r = ripples[nextRipple]; nextRipple = (nextRipple + 1) % RIPPLES;
    const d = Math.hypot(x - centre.x, z - centre.z);
    r.m.position.set(x, surfaceY + 0.002, z); r.age = 0; r.life = 0.9; r.max = Math.max(0.02, Math.min(0.12 * size, radius - d + 0.03));
    r.m.visible = true;
  }
  // ---- drops: splashes and drips
  const dropMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 6, 4), new THREE.MeshStandardMaterial({ color: 0xbfe2ef, roughness: 0.05, transparent: true, opacity: 0.85 }), DROPS);
  dropMesh.name = 'water-drops'; dropMesh.frustumCulled = false; dropMesh.count = 0;
  parent.add(dropMesh);
  const drops = Array.from({ length: DROPS }, () => ({ p: new THREE.Vector3(), v: new THREE.Vector3(), r: 0, life: 0 }));
  let nextDrop = 0;
  function drop(p, vx, vy, vz, r = 0.004) {
    const d = drops[nextDrop]; nextDrop = (nextDrop + 1) % DROPS;
    d.p.copy(p); d.v.set(vx, vy, vz); d.r = r; d.life = 1.2;
  }
  function splash(p) {
    for (let k = 0; k < 10; k++) {
      const a = random() * Math.PI * 2, s = 0.15 + random() * 0.35;
      drop(p, Math.cos(a) * s, 0.7 + random() * 0.8, Math.sin(a) * s, 0.003 + random() * 0.003);
    }
  }
  // ---- per hand
  const hands = new Map(); // probe key -> { in, outAt, wet, last: Vector3, rippleAt, dripAt }
  const low = new THREE.Vector3(), m4 = new THREE.Matrix4(), q0 = new THREE.Quaternion(), sc = new THREE.Vector3();
  let clock = 0;
  const inTub = (p) => Math.hypot(p.x - centre.x, p.z - centre.z) < radius - 0.005 && p.y > bottom;
  function look(material, wet) {
    if (!material) return;
    const base = (material.userData.dry ??= { color: material.color.clone(), roughness: material.roughness });
    material.roughness = base.roughness + (0.28 - base.roughness) * wet;
    material.color.copy(base.color).multiplyScalar(1 - 0.12 * wet);
  }
  return {
    get surfaceY() { return surfaceY; },
    // this frame's dips: [{ key, local, at (Vector3) }]
    update(dt, probes = []) {
      clock += dt;
      const dips = [], seen = new Set();
      for (const probe of probes) {
        seen.add(probe.key);
        let s = hands.get(probe.key);
        if (!s) { s = { in: false, outAt: -Infinity, wet: 0, last: new THREE.Vector3(), rippleAt: 0, dripAt: 0, moved: 0 }; hands.set(probe.key, s); }
        // the hand's lowest point under the surface, and whether any of it is near the surface at all
        let deepest = null, near = false;
        for (const p of probe.points) {
          if (!inTub(p)) continue;
          if (p.y < surfaceY + EXIT) near = true;
          if (p.y < surfaceY - ENTER && (!deepest || p.y < deepest.y)) deepest = p;
        }
        if (!s.in && deepest) {
          s.in = true;
          low.set(deepest.x, surfaceY, deepest.z);
          if (clock - s.outAt >= COOLDOWN) {
            dips.push({ key: probe.key, local: probe.local, at: low.clone() });
            splash(low); ripple(low.x, low.z, 1); ripple(low.x, low.z, 0.6);
          } else ripple(low.x, low.z, 0.5);
          s.last.copy(low);
        } else if (s.in && !near) { s.in = false; s.outAt = clock; s.wet = 1; }
        if (s.in) {
          s.wet = 1;
          // a hand moving in the water ripples it
          const p = deepest ?? s.last;
          s.moved += Math.hypot(p.x - s.last.x, p.z - s.last.z);
          if (s.moved > 0.04 && clock - s.rippleAt > 0.15) { ripple(p.x, p.z, 0.7); s.rippleAt = clock; s.moved = 0; }
          s.last.set(p.x, surfaceY, p.z);
        } else if (s.wet > 0) {
          s.wet = Math.max(0, s.wet - dt / WET_TIME);
          // a wet hand drips from its lowest point, less as it dries
          if (s.wet > 0.25 && clock - s.dripAt > 0.22 + 0.6 * (1 - s.wet) + 0.2 * random()) {
            let lowest = null; for (const p of probe.points) if (!lowest || p.y < lowest.y) lowest = p;
            if (lowest) drop(lowest, 0, -0.05, 0, 0.0035);
            s.dripAt = clock;
          }
        }
        look(probe.material, s.wet);
      }
      // hands no longer seen: forget them (a dry start when they come back)
      for (const key of hands.keys()) if (!seen.has(key)) hands.delete(key);
      // ripples widen and fade
      for (const r of ripples) {
        if (!r.m.visible) continue;
        r.age += dt;
        const u = r.age / r.life;
        if (u >= 1) { r.m.visible = false; continue; }
        r.m.scale.setScalar(0.01 + r.max * (1 - (1 - u) * (1 - u)));
        r.m.material.opacity = 0.55 * (1 - u);
      }
      // drops fall; one that lands in the bucket ripples it
      let n = 0;
      for (const d of drops) {
        if (d.life <= 0) continue;
        d.life -= dt; d.v.y -= GRAVITY * dt; d.p.addScaledVector(d.v, dt);
        if (d.p.y < surfaceY && d.v.y < 0 && Math.hypot(d.p.x - centre.x, d.p.z - centre.z) < radius) { if (d.r > 0.003) ripple(d.p.x, d.p.z, 0.25); d.life = 0; continue; }
        if (d.p.y < 0) { d.life = 0; continue; }
        dropMesh.setMatrixAt(n++, m4.compose(d.p, q0, sc.setScalar(d.r)));
      }
      dropMesh.count = n;
      if (n) dropMesh.instanceMatrix.needsUpdate = true;
      return dips;
    },
    get wetHands() { return [...hands.entries()].filter(([, s]) => s.wet > 0).map(([k]) => k); },
  };
}
