import * as THREE from 'three';
import * as L from './layout.js';
import {
  gravelTexture, stoneTexture, woodTexture, kohakuTexture, lanternTexture, softSprite, skyTexture,
} from './textures.js';

// The courtyard around the pounding station: ground, path, gate, shrine hall, bell pavilion, the
// kohaku-curtained stall, the clay stove with its steamer stack, the bonfire, trees and lights.
// Station props (mortar, mallet, people) live in station.js; snow and steam in effects.js.

const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);

function add(parent, geom, mat, pos = [0, 0, 0], { name, cast = false, receive = false, rot } = {}) {
  const m = new THREE.Mesh(geom, mat);
  m.position.set(pos[0], pos[1], pos[2]);
  if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
  if (name) m.name = name;
  m.castShadow = cast;
  m.receiveShadow = receive;
  parent.add(m);
  return m;
}

export function buildWorld(scene) {
  const root = new THREE.Group();
  root.name = 'world';
  scene.add(root);
  const colliders = { circles: [], boxes: [] };
  const animated = [];

  // ---------- materials ----------
  const mats = {
    gravel: new THREE.MeshLambertMaterial({ map: gravelTexture() }),
    stone: new THREE.MeshLambertMaterial({ map: stoneTexture(), color: 0xb9b4ac }),
    vermilion: new THREE.MeshLambertMaterial({ color: 0xc23a1e }),
    blackLacquer: new THREE.MeshLambertMaterial({ color: 0x1c1513 }),
    darkWood: new THREE.MeshLambertMaterial({ map: woodTexture({ base: '#4a3020', dark: '#24150c', seed: 7 }) }),
    wood: new THREE.MeshLambertMaterial({ map: woodTexture({ base: '#9a6c43', dark: '#5f3e22', seed: 9 }) }),
    plaster: new THREE.MeshLambertMaterial({ color: 0xe9e2d2 }),
    roof: new THREE.MeshLambertMaterial({ color: 0x2b2f36 }),
    snow: new THREE.MeshLambertMaterial({ color: 0xeef2f8 }),
    clay: new THREE.MeshLambertMaterial({ color: 0x9a6a4c }),
    soot: new THREE.MeshBasicMaterial({ color: 0x0a0605 }),
    iron: new THREE.MeshLambertMaterial({ color: 0x2a2624 }),
    cedar: new THREE.MeshLambertMaterial({ color: 0x1f3a2c }),
    bark: new THREE.MeshLambertMaterial({ color: 0x3b2a20 }),
    bronze: new THREE.MeshStandardMaterial({ color: 0x3f5a4a, metalness: 0.7, roughness: 0.45 }),
    rope: new THREE.MeshLambertMaterial({ color: 0xcdb98a }),
    paper: new THREE.MeshBasicMaterial({ color: 0xffffff }),
    cloth: new THREE.MeshLambertMaterial({ color: 0x23324f }),
    tent: new THREE.MeshLambertMaterial({ color: 0xf2efe8, side: THREE.DoubleSide }),
  };

  // ---------- sky, moon, stars ----------
  const sky = add(root, new THREE.SphereGeometry(220, 32, 16),
    new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false, depthWrite: false }));
  sky.renderOrder = -10;
  const moon = new THREE.Sprite(new THREE.SpriteMaterial({
    map: softSprite({ inner: 'rgba(235,240,255,1)', outer: 'rgba(160,180,230,0)' }), fog: false, depthWrite: false,
  }));
  moon.position.set(-60, 85, -140);
  moon.scale.set(22, 22, 1);
  root.add(moon);
  {
    const n = 900, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * Math.PI * 2, v = 0.08 + Math.random() * 0.9;
      const r = 200;
      pos[i * 3] = Math.cos(u) * Math.cos(v * 1.4) * r;
      pos[i * 3 + 1] = Math.sin(v * 1.4) * r;
      pos[i * 3 + 2] = Math.sin(u) * Math.cos(v * 1.4) * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    root.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xcfd8ff, size: 0.9, fog: false, sizeAttenuation: false, transparent: true, opacity: 0.75 })));
  }

  // ---------- ground and path ----------
  const ground = add(root, new THREE.PlaneGeometry(90, 90), mats.gravel, [0, 0, 2], { name: 'ground', receive: true, rot: [-Math.PI / 2, 0, 0] });
  ground.userData.occludes = false;
  {
    // Irregular flagstones, two per row, slightly offset.
    const slab = new THREE.BoxGeometry(1, 0.06, 1);
    const count = 2 * Math.ceil((L.PATH.zMax - L.PATH.zMin) / 0.95);
    const inst = new THREE.InstancedMesh(slab, mats.stone, count);
    inst.name = 'path';
    inst.receiveShadow = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    let k = 0;
    for (let z = L.PATH.zMin + 0.45; z < L.PATH.zMax && k < count; z += 0.95) {
      const split = (Math.random() - 0.5) * 0.4;
      for (const side of [-1, 1]) {
        const w = L.PATH.halfWidth + (side < 0 ? split : -split) - 0.06;
        const cx = side < 0 ? -L.PATH.halfWidth + w / 2 + 0.03 : L.PATH.halfWidth - w / 2 - 0.03;
        p.set(cx, 0.03, z + (Math.random() - 0.5) * 0.06);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() - 0.5) * 0.05);
        s.set(w, 1, 0.86 + Math.random() * 0.05);
        inst.setMatrixAt(k++, m.compose(p, q, s));
      }
    }
    inst.count = k;
    root.add(inst);
  }

  // ---------- low courtyard wall (tamagaki) with a gap at the gate ----------
  {
    const h = 1.1, t = 0.35;
    const { halfX, zMin, zMax } = L.COURTYARD;
    const segs = [
      [[-halfX, zMin], [halfX, zMin]],
      [[-halfX, zMin], [-halfX, zMax]],
      [[halfX, zMin], [halfX, zMax]],
      [[-halfX, zMax], [-2.6, zMax]],
      [[2.6, zMax], [halfX, zMax]],
    ];
    for (const [[x1, z1], [x2, z2]] of segs) {
      const len = Math.hypot(x2 - x1, z2 - z1);
      const horiz = Math.abs(z2 - z1) < 1e-6;
      const geom = new THREE.BoxGeometry(horiz ? len : t, h, horiz ? t : len);
      add(root, geom, mats.plaster, [(x1 + x2) / 2, h / 2, (z1 + z2) / 2], { receive: true });
      add(root, new THREE.BoxGeometry(horiz ? len + 0.3 : t + 0.3, 0.12, horiz ? t + 0.3 : len + 0.3), mats.roof, [(x1 + x2) / 2, h + 0.06, (z1 + z2) / 2]);
      add(root, new THREE.BoxGeometry(horiz ? len + 0.3 : t + 0.34, 0.04, horiz ? t + 0.34 : len + 0.3), mats.snow, [(x1 + x2) / 2, h + 0.14, (z1 + z2) / 2]);
    }
  }

  // ---------- torii gate ----------
  {
    const { position: [tx, , tz], span, height } = L.TORII;
    const g = new THREE.Group();
    g.position.set(tx, 0, tz);
    root.add(g);
    for (const sx of [-1, 1]) {
      add(g, new THREE.CylinderGeometry(0.2, 0.24, height, 16), mats.vermilion, [sx * span / 2, height / 2, 0], { cast: true });
      add(g, new THREE.CylinderGeometry(0.28, 0.28, 0.35, 16), mats.blackLacquer, [sx * span / 2, 0.17, 0]);
      colliders.circles.push({ x: tx + sx * span / 2, z: tz, r: 0.35 });
    }
    add(g, new THREE.BoxGeometry(span + 0.9, 0.24, 0.32), mats.vermilion, [0, height - 0.75, 0]); // nuki
    add(g, new THREE.BoxGeometry(span + 1.8, 0.3, 0.46), mats.blackLacquer, [0, height + 0.05, 0]); // kasagi
    add(g, new THREE.BoxGeometry(span + 1.4, 0.26, 0.38), mats.vermilion, [0, height - 0.22, 0]);
    add(g, new THREE.BoxGeometry(span + 1.84, 0.05, 0.5), mats.snow, [0, height + 0.22, 0]);
  }

  // ---------- stone lanterns along the path ----------
  const toroGlow = new THREE.MeshBasicMaterial({ color: 0xffb36b });
  for (const [x, , z] of L.TORO) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    root.add(g);
    add(g, new THREE.CylinderGeometry(0.32, 0.4, 0.25, 6), mats.stone, [0, 0.12, 0], { cast: true });
    add(g, new THREE.CylinderGeometry(0.12, 0.14, 0.8, 8), mats.stone, [0, 0.65, 0], { cast: true });
    add(g, new THREE.BoxGeometry(0.5, 0.12, 0.5), mats.stone, [0, 1.1, 0]);
    add(g, new THREE.BoxGeometry(0.36, 0.34, 0.36), mats.stone, [0, 1.33, 0]);
    add(g, new THREE.BoxGeometry(0.22, 0.2, 0.38), toroGlow, [0, 1.33, 0]);
    add(g, new THREE.BoxGeometry(0.38, 0.2, 0.22), toroGlow, [0, 1.33, 0]);
    add(g, new THREE.ConeGeometry(0.5, 0.32, 6), mats.stone, [0, 1.66, 0]);
    add(g, new THREE.ConeGeometry(0.46, 0.12, 6), mats.snow, [0, 1.78, 0]);
    add(g, new THREE.SphereGeometry(0.07, 8, 6), mats.stone, [0, 1.86, 0]);
    colliders.circles.push({ x, z, r: 0.45 });
  }

  // ---------- shrine hall (haiden) ----------
  {
    const { position: [sx, , sz], size: [w, h, d] } = L.SHRINE;
    const g = new THREE.Group();
    g.position.set(sx, 0, sz);
    g.name = 'shrine_hall';
    root.add(g);
    add(g, new THREE.BoxGeometry(w + 1.2, 0.9, d + 1.2), mats.stone, [0, 0.45, 0], { receive: true });
    // steps
    for (let i = 0; i < 4; i++) add(g, new THREE.BoxGeometry(4, 0.22, 0.4), mats.stone, [0, 0.11 + i * 0.2, d / 2 + 1.6 - i * 0.35]);
    add(g, new THREE.BoxGeometry(w, 0.15, d), mats.darkWood, [0, 0.98, 0]);
    // walls with white panels between dark posts
    add(g, new THREE.BoxGeometry(w - 1.2, 3.1, d - 1.4), mats.plaster, [0, 2.6, -0.3]);
    for (let i = 0; i <= 6; i++) {
      const x = -w / 2 + 0.6 + (i * (w - 1.2)) / 6;
      add(g, new THREE.CylinderGeometry(0.16, 0.16, 3.4, 10), mats.vermilion, [x, 2.7, d / 2 - 0.35], { cast: true });
      add(g, new THREE.CylinderGeometry(0.16, 0.16, 3.4, 10), mats.vermilion, [x, 2.7, -d / 2 + 0.35]);
    }
    // front lattice doors (glowing warmly from within)
    const shoji = new THREE.MeshBasicMaterial({ color: 0xffd9a0 });
    for (let i = 0; i < 4; i++) add(g, new THREE.PlaneGeometry(1.7, 2.3), shoji, [-3 + i * 2, 2.25, d / 2 - 0.99]);
    // roof: two sloped planes with a deep overhang, ridge and snow
    const roofW = w + 3.2, roofD = d / 2 + 1.8, pitch = 0.5;
    for (const side of [-1, 1]) {
      const r = add(g, new THREE.BoxGeometry(roofW, 0.28, roofD / Math.cos(pitch)), mats.roof, [0, 5.05, side * roofD / 2], { cast: true });
      r.rotation.x = side * pitch;
      const s = add(g, new THREE.BoxGeometry(roofW - 0.2, 0.06, roofD / Math.cos(pitch) - 0.2), mats.snow, [0, 5.22, side * roofD / 2]);
      s.rotation.x = side * pitch;
    }
    add(g, new THREE.BoxGeometry(roofW + 0.4, 0.45, 0.5), mats.roof, [0, 5.95, 0]);
    // shimenawa rope with paper streamers over the entrance
    const curve = new THREE.CatmullRomCurve3([V([-3.4, 4.0, d / 2 - 0.25]), V([0, 3.45, d / 2 - 0.05]), V([3.4, 4.0, d / 2 - 0.25])]);
    add(g, new THREE.TubeGeometry(curve, 40, 0.16, 10), mats.rope, [0, 0, 0]);
    for (let i = 0; i < 5; i++) {
      const p = curve.getPoint(0.12 + i * 0.19);
      const shide = add(g, new THREE.PlaneGeometry(0.16, 0.5), mats.paper, [p.x, p.y - 0.4, p.z + 0.12]);
      shide.rotation.z = (i % 2 ? 1 : -1) * 0.08;
    }
    // offering box
    add(g, new THREE.BoxGeometry(1.6, 0.6, 0.7), mats.darkWood, [0, 1.35, d / 2 + 0.2]);
    colliders.boxes.push({ minX: sx - (w + 1.2) / 2, maxX: sx + (w + 1.2) / 2, minZ: sz - (d + 1.2) / 2, maxZ: sz + (d + 1.2) / 2 + 1.7 });
  }

  // ---------- bell pavilion (shoro) with the bronze bell and its striker log ----------
  const bell = {};
  {
    const { position: [bx, , bz], size: [w, h, d] } = L.SHORO;
    const g = new THREE.Group();
    g.position.set(bx, 0, bz);
    g.name = 'shoro';
    root.add(g);
    add(g, new THREE.BoxGeometry(w + 0.6, 0.6, d + 0.6), mats.stone, [0, 0.3, 0], { receive: true });
    for (const [px, pz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      add(g, new THREE.CylinderGeometry(0.15, 0.17, h - 0.6, 10), mats.vermilion, [px * (w / 2 - 0.25), 0.6 + (h - 0.6) / 2, pz * (d / 2 - 0.25)], { cast: true });
    }
    add(g, new THREE.BoxGeometry(w + 0.2, 0.25, 0.25), mats.darkWood, [0, h - 0.1, 0]);
    const roof = add(g, new THREE.ConeGeometry(Math.hypot(w, d) / 2 + 1.0, 1.6, 4), mats.roof, [0, h + 0.75, 0], { cast: true });
    roof.rotation.y = Math.PI / 4;
    const roofSnow = add(g, new THREE.ConeGeometry(Math.hypot(w, d) / 2 + 0.7, 1.2, 4), mats.snow, [0, h + 0.95, 0]);
    roofSnow.rotation.y = Math.PI / 4;
    // bonsho: a lathe of the bell's profile, hung from the beam (world position = L.BONSHO.position)
    const prof = [];
    const H = L.BONSHO.height, R = L.BONSHO.radius;
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      prof.push(new THREE.Vector2(R * (0.78 + 0.22 * Math.pow(t, 3)) + (i === 12 ? 0.04 : 0), H / 2 - t * H));
    }
    prof.unshift(new THREE.Vector2(0.0, H / 2 + 0.12));
    prof.splice(1, 0, new THREE.Vector2(R * 0.6, H / 2 + 0.08));
    const bonsho = add(g, new THREE.LatheGeometry(prof, 32), mats.bronze, [0, L.BONSHO.position[1], 0], { name: 'bonsho', cast: true });
    bonsho.material.side = THREE.DoubleSide;
    add(g, new THREE.CylinderGeometry(0.03, 0.03, h - 0.1 - (L.BONSHO.position[1] + H / 2 + 0.12)), mats.iron, [0, (h - 0.1 + L.BONSHO.position[1] + H / 2 + 0.12) / 2, 0]);
    // the striker log (shumoku), hung on two ropes, swings toward the bell along +X
    const strikerPivot = new THREE.Group();
    strikerPivot.position.set(0.6, h - 0.25, 0);
    g.add(strikerPivot);
    const ropeLen = h - 0.25 - (L.BONSHO.position[1] - 0.25);
    for (const oz of [-0.25, 0.25]) add(strikerPivot, new THREE.CylinderGeometry(0.012, 0.012, ropeLen, 4), mats.rope, [0, -ropeLen / 2, oz]);
    const log = add(strikerPivot, new THREE.CylinderGeometry(0.11, 0.11, 1.5, 12), mats.wood, [0.62, -ropeLen, 0], { cast: true }); // at rest its near end just touches the bell
    log.rotation.z = Math.PI / 2;
    Object.assign(bell, { mesh: bonsho, strikerPivot, phase: 'idle', t: 0, next: 14, wobble: 0, onToll: null });
    colliders.boxes.push({ minX: bx - (w + 0.6) / 2, maxX: bx + (w + 0.6) / 2, minZ: bz - (d + 0.6) / 2, maxZ: bz + (d + 0.6) / 2 });
  }

  // ---------- the stall: kohaku curtains, canopy, lantern strings ----------
  const lanterns = [];
  {
    const { position: [px, , pz], width, height, depth } = L.STALL;
    const g = new THREE.Group();
    g.position.set(px, 0, pz);
    g.name = 'stall';
    root.add(g);
    const kohaku = new THREE.MeshLambertMaterial({ map: kohakuTexture(), side: THREE.DoubleSide });
    const pleated = (w, h, folds) => {
      const geom = new THREE.PlaneGeometry(w, h, folds * 4, 1);
      const pos = geom.attributes.position;
      for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin((pos.getX(i) / w) * folds * Math.PI * 2) * 0.05);
      geom.computeVertexNormals();
      return geom;
    };
    const back = add(g, pleated(width, height - 0.2, 26), kohaku, [0, (height - 0.2) / 2 + 0.05, -depth / 2], { receive: true });
    back.userData.occludes = false;
    for (const s of [-1, 1]) {
      const side = add(g, pleated(depth, height - 0.2, 10), kohaku, [s * width / 2, (height - 0.2) / 2 + 0.05, 0], { receive: true });
      side.rotation.y = Math.PI / 2;
    }
    for (const [x, z] of [[-width / 2, -depth / 2], [width / 2, -depth / 2], [-width / 2, depth / 2], [width / 2, depth / 2]]) {
      add(g, new THREE.CylinderGeometry(0.06, 0.06, height + 0.4, 8), mats.wood, [x, (height + 0.4) / 2, z], { cast: true });
    }
    const canopy = add(g, new THREE.PlaneGeometry(width + 0.4, depth + 0.4), mats.tent, [0, height + 0.42, 0]);
    canopy.rotation.x = -Math.PI / 2 + 0.06;
    add(g, new THREE.PlaneGeometry(width + 0.4, depth + 0.4), mats.snow, [0, height + 0.45, 0]).rotation.x = -Math.PI / 2 + 0.06;
    colliders.boxes.push({ minX: px - width / 2 - 0.1, maxX: px + width / 2 + 0.1, minZ: pz - depth / 2 - 0.15, maxZ: pz - depth / 2 + 0.15 });
    for (const s of [-1, 1]) colliders.boxes.push({ minX: px + s * width / 2 - 0.15, maxX: px + s * width / 2 + 0.15, minZ: pz - depth / 2, maxZ: pz + depth / 2 });

    // red paper lanterns along the canopy front and on strings across the courtyard
    const lanternGeom = new THREE.SphereGeometry(0.2, 16, 10);
    lanternGeom.scale(1, 1.35, 1);
    const lanternMat = new THREE.MeshBasicMaterial({ map: lanternTexture(), color: 0xffffff });
    const capMat = new THREE.MeshBasicMaterial({ color: 0x140c0a });
    const hang = (x, y, z, parent = root) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, z);
      parent.add(pivot);
      add(pivot, new THREE.CylinderGeometry(0.005, 0.005, 0.18, 3), capMat, [0, -0.09, 0]);
      add(pivot, lanternGeom, lanternMat, [0, -0.45, 0]);
      add(pivot, new THREE.CylinderGeometry(0.12, 0.12, 0.05, 12), capMat, [0, -0.19, 0]);
      add(pivot, new THREE.CylinderGeometry(0.12, 0.12, 0.05, 12), capMat, [0, -0.72, 0]);
      lanterns.push({ pivot, phase: Math.random() * 10 });
    };
    for (let i = 0; i < 9; i++) hang(-width / 2 + 0.6 + i * ((width - 1.2) / 8), height + 0.35, depth / 2 + 0.05, g);
    // two strings from the canopy front corners out to tall poles near the path
    const lineMat = new THREE.LineBasicMaterial({ color: 0x2b1d14 });
    for (const s of [-1, 1]) {
      const poleX = s * 3.1, poleZ = 6.2;
      add(root, new THREE.CylinderGeometry(0.06, 0.07, 4.2, 8), mats.wood, [poleX, 2.1, poleZ], { cast: true });
      colliders.circles.push({ x: poleX, z: poleZ, r: 0.2 });
      const a = V([px + s * width / 2, height + 0.4, pz + depth / 2]);
      const b = V([poleX, 4.1, poleZ]);
      const mid = a.clone().lerp(b, 0.5);
      mid.y -= 0.55;
      const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
      const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(24));
      root.add(new THREE.Line(geo, lineMat));
      for (let i = 1; i < 8; i++) {
        const p = curve.getPoint(i / 8);
        hang(p.x, p.y, p.z);
      }
    }
  }

  // ---------- table for finished mochi ----------
  const tableTop = new THREE.Group();
  {
    const { position: [x, , z], size: [w, h, d] } = L.TABLE;
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.name = 'table';
    root.add(g);
    add(g, new THREE.BoxGeometry(w, 0.06, d), mats.wood, [0, h, 0], { cast: true, receive: true });
    add(g, new THREE.BoxGeometry(w + 0.02, 0.4, d + 0.02), new THREE.MeshLambertMaterial({ color: 0xc8202b }), [0, h - 0.22, 0]);
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(g, new THREE.BoxGeometry(0.06, h, 0.06), mats.darkWood, [lx * (w / 2 - 0.06), h / 2, lz * (d / 2 - 0.06)]);
    // bowls of kinako (roasted soy flour) and anko (red bean paste)
    const bowl = new THREE.CylinderGeometry(0.17, 0.11, 0.1, 18);
    add(g, bowl, new THREE.MeshLambertMaterial({ color: 0x2a1a14 }), [-0.6, h + 0.08, 0.1]);
    add(g, new THREE.CylinderGeometry(0.15, 0.15, 0.02, 18), new THREE.MeshLambertMaterial({ color: 0xd8b26a }), [-0.6, h + 0.13, 0.1]);
    add(g, bowl, new THREE.MeshLambertMaterial({ color: 0x2a1a14 }), [-0.15, h + 0.08, 0.15]);
    add(g, new THREE.CylinderGeometry(0.15, 0.15, 0.02, 18), new THREE.MeshLambertMaterial({ color: 0x4a1d1a }), [-0.15, h + 0.13, 0.15]);
    tableTop.position.set(0.35, h + 0.03, 0);
    g.add(tableTop);
    colliders.boxes.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
  }

  // ---------- kamado (clay stove) with the seiro steamer stack ----------
  const flames = [];
  const flameMat = (c) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  const makeFire = (parent, pos, scale = 1) => {
    const f = new THREE.Group();
    f.position.set(pos[0], pos[1], pos[2]);
    parent.add(f);
    const cols = [0xff5a1a, 0xff8c2a, 0xffc04a];
    for (let i = 0; i < 7; i++) {
      const c = add(f, new THREE.ConeGeometry(0.12 * scale, 0.5 * scale, 8, 1, true), flameMat(cols[i % 3]),
        [(Math.random() - 0.5) * 0.25 * scale, 0.22 * scale, (Math.random() - 0.5) * 0.25 * scale]);
      flames.push({ mesh: c, phase: Math.random() * 10, base: 0.6 + Math.random() * 0.6 });
    }
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: softSprite({ inner: 'rgba(255,150,60,0.9)', outer: 'rgba(255,90,20,0)' }), blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.set(1.6 * scale, 1.6 * scale, 1);
    glow.position.y = 0.3 * scale;
    f.add(glow);
    return f;
  };
  const seiroBoxes = [];
  let seiroLid;
  {
    const { position: [x, , z], size: [w, h, d] } = L.KAMADO;
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.name = 'kamado';
    root.add(g);
    add(g, new THREE.BoxGeometry(w, h, d), mats.clay, [0, h / 2, 0], { cast: true, receive: true });
    add(g, new THREE.BoxGeometry(w + 0.08, 0.08, d + 0.08), mats.clay, [0, h, 0]);
    add(g, new THREE.BoxGeometry(0.42, 0.36, 0.05), mats.soot, [0, 0.24, d / 2 + 0.005]); // firebox mouth facing +Z
    makeFire(g, [0, 0.07, d / 2 - 0.12], 0.75);
    add(g, new THREE.CylinderGeometry(0.33, 0.3, 0.12, 20), mats.iron, [0, h + 0.06, 0]); // pot rim under the steamer
    add(g, new THREE.BoxGeometry(0.12, 0.6, 0.12), mats.clay, [-w / 2 + 0.12, h + 0.3, -d / 2 + 0.12]); // little chimney
    // three square steamer boxes (seiro) with the lid on top
    const sw = L.SEIRO.size[0], bh = L.SEIRO.size[1] / 3;
    const seiroMat = new THREE.MeshLambertMaterial({ map: woodTexture({ base: '#c9a26a', dark: '#8a6a3c', seed: 13 }) });
    const seiroRoot = new THREE.Group();
    seiroRoot.name = 'seiro';
    seiroRoot.position.set(0, h + 0.12, 0);
    g.add(seiroRoot);
    for (let i = 0; i < 3; i++) {
      const b = new THREE.Group();
      b.position.y = i * bh + bh / 2;
      seiroRoot.add(b);
      add(b, new THREE.BoxGeometry(sw, bh - 0.01, sw), seiroMat, [0, 0, 0], { cast: true });
      add(b, new THREE.BoxGeometry(sw + 0.02, 0.025, sw + 0.02), mats.darkWood, [0, bh / 2 - 0.02, 0]);
      seiroBoxes.push(b);
    }
    seiroLid = add(seiroRoot, new THREE.BoxGeometry(sw + 0.04, 0.05, sw + 0.04), seiroMat, [0, 3 * bh + 0.025, 0]);
    // a small woodpile beside it
    for (let i = 0; i < 6; i++) {
      const log = add(g, new THREE.CylinderGeometry(0.06, 0.06, 0.6, 7), mats.bark, [w / 2 + 0.35, 0.07 + Math.floor(i / 3) * 0.12, -0.2 + (i % 3) * 0.14]);
      log.rotation.x = Math.PI / 2;
    }
    colliders.boxes.push({ minX: x - w / 2 - 0.1, maxX: x + w / 2 + 0.6, minZ: z - d / 2 - 0.1, maxZ: z + d / 2 + 0.1 });
  }

  // ---------- takibi (bonfire in an iron basket) ----------
  {
    const [x, , z] = L.TAKIBI.position;
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.name = 'takibi';
    root.add(g);
    add(g, new THREE.TorusGeometry(0.5, 0.025, 6, 24), mats.iron, [0, 0.55, 0], { rot: [Math.PI / 2, 0, 0] });
    add(g, new THREE.TorusGeometry(0.35, 0.025, 6, 24), mats.iron, [0, 0.25, 0], { rot: [Math.PI / 2, 0, 0] });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const bar = add(g, new THREE.CylinderGeometry(0.02, 0.02, 0.6, 4), mats.iron, [Math.cos(a) * 0.43, 0.38, Math.sin(a) * 0.43]);
      bar.rotation.set(Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25);
    }
    for (let i = 0; i < 3; i++) add(g, new THREE.CylinderGeometry(0.025, 0.025, 0.5, 4), mats.iron, [Math.cos(i * 2.1) * 0.3, 0.12, Math.sin(i * 2.1) * 0.3]);
    for (let i = 0; i < 5; i++) {
      const log = add(g, new THREE.CylinderGeometry(0.06, 0.07, 0.7, 7), mats.bark, [0, 0.42 + (i % 2) * 0.06, 0]);
      log.rotation.set(Math.PI / 2 - 0.3, (i / 5) * Math.PI, 0);
    }
    makeFire(g, [0, 0.42, 0], 1.6);
    colliders.circles.push({ x, z, r: 0.85 });
  }

  // ---------- cedar trees with snow ----------
  for (const [x, z] of L.TREES) {
    const g = new THREE.Group();
    const s = 0.85 + Math.random() * 0.5;
    g.position.set(x, 0, z);
    g.scale.setScalar(s);
    root.add(g);
    add(g, new THREE.CylinderGeometry(0.22, 0.32, 3.2, 8), mats.bark, [0, 1.6, 0], { cast: true });
    for (let i = 0; i < 4; i++) {
      const r = 2.1 - i * 0.42, y = 2.6 + i * 1.35;
      add(g, new THREE.ConeGeometry(r, 2.1, 9), mats.cedar, [0, y, 0], { cast: true });
      add(g, new THREE.ConeGeometry(r * 0.72, 0.8, 9), mats.snow, [0, y + 0.55, 0]);
    }
    g.traverse((o) => { o.userData.occludes = false; });
    colliders.circles.push({ x, z, r: 0.5 * s });
  }

  // ---------- lights ----------
  const hemi = new THREE.HemisphereLight(0x5a6c9a, 0x2a1d16, 0.55);
  root.add(hemi);
  const moonLight = new THREE.DirectionalLight(0x9fb3ff, 0.35);
  moonLight.position.set(-30, 50, -40);
  root.add(moonLight);
  const stallSpot = new THREE.SpotLight(0xffc489, 26, 16, 0.75, 0.6, 1.6);
  stallSpot.position.set(0.6, 4.6, 2.6);
  stallSpot.target.position.set(0, 0.6, 0);
  stallSpot.castShadow = true;
  stallSpot.shadow.mapSize.set(1024, 1024);
  stallSpot.shadow.bias = -0.0005;
  stallSpot.shadow.camera.near = 1;
  stallSpot.shadow.camera.far = 12;
  root.add(stallSpot, stallSpot.target);
  const fireLight = new THREE.PointLight(0xff7a2e, 14, 12, 1.7);
  fireLight.position.set(L.TAKIBI.position[0], 1.0, L.TAKIBI.position[2]);
  root.add(fireLight);
  const stoveLight = new THREE.PointLight(0xff8a3a, 4, 5, 1.8);
  stoveLight.position.set(L.KAMADO.position[0], 0.35, L.KAMADO.position[2] + 0.75);
  root.add(stoveLight);
  const shrineLight = new THREE.PointLight(0xffc27a, 10, 14, 1.6);
  shrineLight.position.set(0, 3.2, L.SHRINE.position[2] + L.SHRINE.size[2] / 2 + 1.5);
  root.add(shrineLight);

  // ---------- per-frame ----------
  function update(dt, t) {
    for (const f of flames) {
      const k = f.base * (0.75 + 0.35 * Math.sin(t * 13 + f.phase) * Math.sin(t * 7.3 + f.phase * 2));
      f.mesh.scale.set(1 - k * 0.15, k + 0.4, 1 - k * 0.15);
    }
    const flick = 0.85 + 0.15 * Math.sin(t * 17) * Math.sin(t * 5.3 + 1.2) + (Math.random() - 0.5) * 0.12;
    fireLight.intensity = 14 * flick;
    stoveLight.intensity = 4 * (0.8 + 0.2 * Math.sin(t * 11.3) + (Math.random() - 0.5) * 0.1);
    for (const l of lanterns) {
      l.pivot.rotation.z = Math.sin(t * 0.9 + l.phase) * 0.05;
      l.pivot.rotation.x = Math.sin(t * 0.7 + l.phase * 1.3) * 0.04;
    }
    updateBell(dt);
  }

  // The bell: every 45-75 s the striker log is drawn back and let go; it meets the bell, the bell
  // sways a little, and the log rebounds. `onToll` fires at the moment of contact.
  function updateBell(dt) {
    const b = bell;
    b.t += dt;
    if (b.phase === 'idle' && b.t >= b.next) { b.phase = 'pull'; b.t = 0; }
    if (b.phase === 'pull') {
      b.strikerPivot.rotation.z = 0.55 * smooth(Math.min(1, b.t / 1.6)); // draw back (away from the bell, +X)
      if (b.t >= 1.9) { b.phase = 'swing'; b.t = 0; }
    } else if (b.phase === 'swing') {
      const k = Math.min(1, b.t / 0.32);
      b.strikerPivot.rotation.z = 0.55 * (1 - k * k);
      if (k >= 1) {
        b.phase = 'rebound'; b.t = 0; b.wobble = 1;
        if (b.onToll) b.onToll();
      }
    } else if (b.phase === 'rebound') {
      b.strikerPivot.rotation.z = 0.22 * Math.sin(Math.min(1, b.t / 2.2) * Math.PI) * Math.exp(-b.t * 0.6);
      if (b.t >= 3) { b.phase = 'idle'; b.t = 0; b.next = 45 + Math.random() * 30; b.strikerPivot.rotation.z = 0; }
    }
    if (b.wobble > 0.001) {
      b.wobble *= Math.exp(-dt * 0.35);
      b.mesh.rotation.z = Math.sin(performance.now() * 0.0042) * 0.018 * b.wobble;
    }
  }

  return {
    root, colliders, update, bell, seiroBoxes, seiroLid, tableTop,
    hosts: {
      kamado: root.getObjectByName('kamado'),
      seiro: root.getObjectByName('seiro'),
      takibi: root.getObjectByName('takibi'),
      bonsho: root.getObjectByName('bonsho'),
    },
    stallSpot,
  };
}

function smooth(x) { return x * x * (3 - 2 * x); }
