import * as THREE from 'three';
import { softSprite } from './textures.js';

// Snow that falls around the viewer, steam from the steamer and the fresh rice, embers off the fire.

export function createSnow(scene, count = 2600) {
  const box = { x: 34, y: 16, z: 34 };
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * box.x;
    pos[i * 3 + 1] = Math.random() * box.y;
    pos[i * 3 + 2] = (Math.random() - 0.5) * box.z;
    seed[i] = Math.random() * 100;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    map: softSprite({ inner: 'rgba(255,255,255,1)', outer: 'rgba(255,255,255,0)' }),
    size: 0.07, transparent: true, depthWrite: false, opacity: 0.9, color: 0xf2f6ff,
  });
  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  scene.add(points);
  const centre = new THREE.Vector3();
  return {
    update(dt, t, viewer) {
      centre.copy(viewer);
      const a = geom.attributes.position.array;
      for (let i = 0; i < count; i++) {
        const k = i * 3;
        a[k + 1] -= dt * (0.55 + (seed[i] % 1) * 0.35);
        a[k] += Math.sin(t * 0.6 + seed[i]) * dt * 0.18;
        a[k + 2] += Math.cos(t * 0.5 + seed[i] * 1.3) * dt * 0.12;
        if (a[k + 1] < 0) a[k + 1] += box.y;
        // keep the flakes in a box around the viewer so the snow never runs out
        const dx = a[k] - centre.x, dz = a[k + 2] - centre.z;
        if (dx > box.x / 2) a[k] -= box.x; else if (dx < -box.x / 2) a[k] += box.x;
        if (dz > box.z / 2) a[k + 2] -= box.z; else if (dz < -box.z / 2) a[k + 2] += box.z;
      }
      geom.attributes.position.needsUpdate = true;
    },
  };
}

// A small pool of soft sprites for steam: emitters spawn puffs that rise, grow and fade.
export function createSteam(scene, max = 90) {
  const tex = softSprite({ inner: 'rgba(255,255,255,0.55)', outer: 'rgba(255,255,255,0)' });
  const puffs = [];
  for (let i = 0; i < max; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0, color: 0xdfe6f0 }));
    s.visible = false;
    scene.add(s);
    puffs.push({ s, life: 0, max: 1, vel: new THREE.Vector3(), size: 0.3 });
  }
  let cursor = 0;
  const emitters = [];
  function spawn(p, spread, size, rise) {
    const puff = puffs[cursor];
    cursor = (cursor + 1) % max;
    puff.s.visible = true;
    puff.s.position.set(p.x + (Math.random() - 0.5) * spread, p.y, p.z + (Math.random() - 0.5) * spread);
    puff.vel.set((Math.random() - 0.5) * 0.12, rise * (0.7 + Math.random() * 0.5), (Math.random() - 0.5) * 0.12);
    puff.life = 0;
    puff.max = 2.2 + Math.random() * 1.6;
    puff.size = size * (0.8 + Math.random() * 0.4);
  }
  return {
    // rate: puffs per second at intensity 1
    addEmitter(position, { rate = 5, spread = 0.4, size = 0.35, rise = 0.45 } = {}) {
      const e = { position: position.clone(), rate, spread, size, rise, intensity: 1, acc: 0 };
      emitters.push(e);
      return e;
    },
    burst(position, n = 14, { spread = 0.5, size = 0.45, rise = 0.7 } = {}) {
      for (let i = 0; i < n; i++) spawn(position, spread, size, rise);
    },
    update(dt) {
      for (const e of emitters) {
        e.acc += dt * e.rate * e.intensity;
        while (e.acc >= 1) { e.acc -= 1; spawn(e.position, e.spread, e.size, e.rise); }
      }
      for (const p of puffs) {
        if (!p.s.visible) continue;
        p.life += dt;
        const k = p.life / p.max;
        if (k >= 1) { p.s.visible = false; continue; }
        p.s.position.addScaledVector(p.vel, dt);
        p.vel.x += Math.sin(p.life * 2 + p.size * 10) * dt * 0.05;
        const sc = p.size * (1 + k * 2.2);
        p.s.scale.set(sc, sc, 1);
        p.s.material.opacity = Math.sin(Math.min(1, k * 1.4) * Math.PI) * 0.33;
      }
    },
  };
}

export function createEmbers(scene, origin, count = 70) {
  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count * 3);
  const life = new Float32Array(count);
  const reset = (i) => {
    pos[i * 3] = origin.x + (Math.random() - 0.5) * 0.4;
    pos[i * 3 + 1] = origin.y + Math.random() * 0.2;
    pos[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.4;
    vel[i * 3] = (Math.random() - 0.5) * 0.3;
    vel[i * 3 + 1] = 0.8 + Math.random() * 1.2;
    vel[i * 3 + 2] = (Math.random() - 0.5) * 0.3;
    life[i] = Math.random() * 2.5;
  };
  for (let i = 0; i < count; i++) reset(i);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geom, new THREE.PointsMaterial({
    color: 0xffa040, size: 0.045, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
    map: softSprite({ inner: 'rgba(255,200,120,1)', outer: 'rgba(255,80,0,0)' }),
  }));
  pts.frustumCulled = false;
  scene.add(pts);
  return {
    update(dt, t) {
      for (let i = 0; i < count; i++) {
        life[i] -= dt;
        if (life[i] <= 0) { reset(i); life[i] = 1.5 + Math.random() * 1.5; }
        pos[i * 3] += (vel[i * 3] + Math.sin(t * 3 + i) * 0.2) * dt;
        pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
        pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      }
      geom.attributes.position.needsUpdate = true;
    },
  };
}
