// The rabbit avatar's walk, measured on the real rigged GLB (2026-11-15, after the user found walking "very weird"):
// feet land under the body rather than trailing behind, stay planted while the body leans in, squats or sways,
// stop under the body, and turn with it. node scripts/test-rabbit-gait.mjs
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const load = async () => {
  const bytes = await readFile(new URL('../public/env/characters/Mochi_Player_Rabbit.glb', import.meta.url));
  return (await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).scene;
};
const canonical = (s) => s.replace(/[_.\s]/g, '').toLowerCase();
const DT = 1 / 60, EYE = 1.6;
const yawQ = (yaw, pitch = 0) => new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')).toArray();

async function measure(path) {
  const { createRabbitAvatar } = await import(path);
  const make = async () => {
    const avatar = createRabbitAvatar(new THREE.Scene(), { hands: { hands: [] }, load });
    const model = await avatar.ready;
    let L, R, H, T; model.traverse((o) => { const n = o.isBone && canonical(o.name); if (n === 'footl') L = o; if (n === 'footr') R = o; if (n === 'head') H = o; if (n === 'torso') T = o; });
    const rest = H.getWorldPosition(new THREE.Vector3()).distanceTo(T.getWorldPosition(new THREE.Vector3()));
    let t = 0;
    const step = (x, y, z, yaw = 0, pitch = 0) => { t += DT; avatar.set([x, y, z, ...yawQ(yaw, pitch)], t); avatar.update(t, DT); };
    // how far the head sits from the torso beyond its authored distance (the neck stretching), in cm
    const neck = () => 100 * (H.getWorldPosition(new THREE.Vector3()).distanceTo(T.getWorldPosition(new THREE.Vector3())) / avatar.object3d.children[0].scale.x - rest);
    const feet = () => [L, R].map((b) => b.getWorldPosition(new THREE.Vector3()));
    return { avatar, step, feet, neck, hips: () => avatar.object3d.position.clone() };
  };
  const out = {};
  // A: walk straight ahead (-Z) at 0.8 m/s for 4 s
  {
    const a = await make();
    for (let i = 0; i < 60; i++) a.step(0, EYE, 0);
    let z = 0, trail = 0, n = 0, slide = 0, slides = 0, lifts = 0, prev = a.feet(), wasUp = [false, false], ground = Math.min(...prev.map((p) => p.y));
    for (let i = 0; i < 240; i++) {
      z -= 0.8 * DT; a.step(0, EYE, z);
      const f = a.feet(), h = a.hips();
      if (i > 60) {
        for (let k = 0; k < 2; k++) {
          trail += -(f[k].z - h.z); n++; // + = ahead of the hips along the walk (-Z)
          const up = f[k].y > ground + 0.01;
          if (up && !wasUp[k]) lifts++;
          wasUp[k] = up;
          if (!up) { slide += Math.hypot(f[k].x - prev[k].x, f[k].z - prev[k].z) / DT; slides++; }
        }
      }
      prev = f;
    }
    out['walk: feet ahead of hips (mean, cm; 0 = balanced, - = trailing)'] = (100 * trail / n).toFixed(1);
    out['walk: planted feet sliding (mean, cm/s)'] = (100 * slide / Math.max(1, slides)).toFixed(1);
    out['walk: steps per second'] = (lifts / 3).toFixed(2);
  }
  // B: lean in over the mortar: the head 25 cm forward, 30 cm down and looking down 45 degrees over 0.6 s, held 2 s
  {
    const a = await make();
    for (let i = 0; i < 90; i++) a.step(0, EYE, 0);
    const start = a.feet(); let moved = 0, neck = 0;
    for (let i = 0; i < 36; i++) { const u = (i + 1) / 36, e = u * u * (3 - 2 * u); a.step(0, EYE - 0.3 * e, -0.25 * e, 0, -0.8 * e); moved = Math.max(moved, ...a.feet().map((p, k) => p.distanceTo(start[k]))); }
    for (let i = 0; i < 120; i++) { a.step(0, EYE - 0.3, -0.25, 0, -0.8); moved = Math.max(moved, ...a.feet().map((p, k) => p.distanceTo(start[k]))); neck = Math.max(neck, a.neck()); }
    out['lean in: feet moved (max, cm; 0 = stayed planted)'] = (100 * moved).toFixed(1);
    out['lean in: neck stretched (cm beyond the model\'s)'] = neck.toFixed(1);
  }
  // B2: squat: the head straight down 40 cm, looking ahead, held 2 s
  {
    const a = await make();
    for (let i = 0; i < 90; i++) a.step(0, EYE, 0);
    const start = a.feet(); let moved = 0, neck = 0;
    for (let i = 0; i < 48; i++) { const u = (i + 1) / 48, e = u * u * (3 - 2 * u); a.step(0, EYE - 0.4 * e, 0); moved = Math.max(moved, ...a.feet().map((p, k) => p.distanceTo(start[k]))); }
    for (let i = 0; i < 120; i++) { a.step(0, EYE - 0.4, 0); moved = Math.max(moved, ...a.feet().map((p, k) => p.distanceTo(start[k]))); neck = Math.max(neck, a.neck()); }
    out['squat: feet moved (max, cm)'] = (100 * moved).toFixed(1);
    out['squat: neck stretched (cm)'] = neck.toFixed(1);
  }
  // C: sway while standing: the head +-5 cm side to side at 1 Hz for 3 s
  {
    const a = await make();
    for (let i = 0; i < 90; i++) a.step(0, EYE, 0);
    const start = a.feet(); let moved = 0;
    for (let i = 0; i < 180; i++) { a.step(0.05 * Math.sin(2 * Math.PI * i * DT), EYE, 0); moved = Math.max(moved, ...a.feet().map((p, k) => p.distanceTo(start[k]))); }
    out['sway: feet moved (max, cm)'] = (100 * moved).toFixed(1);
  }
  // D: walk 2 s then stop: where do the feet end, and do they shoot ahead of the body?
  {
    const a = await make();
    for (let i = 0; i < 60; i++) a.step(0, EYE, 0);
    let z = 0;
    for (let i = 0; i < 120; i++) { z -= 0.8 * DT; a.step(0, EYE, z); }
    let ahead = -Infinity;
    for (let i = 0; i < 120; i++) { a.step(0, EYE, z); const h = a.hips(); for (const f of a.feet()) ahead = Math.max(ahead, -(f.z - h.z)); }
    const h = a.hips(), f = a.feet();
    out['stop: a foot ahead of the hips after stopping (max, cm)'] = (100 * ahead).toFixed(1);
    out['stop: feet off-centre 2 s after (cm, along the walk)'] = f.map((p) => (100 * -(p.z - h.z)).toFixed(1)).join(' / ');
  }
  // E: turn on the spot by 90 degrees over 1 s: the feet should turn with the body
  {
    const a = await make();
    for (let i = 0; i < 60; i++) a.step(0, EYE, 0, 0);
    for (let i = 0; i < 60; i++) a.step(0, EYE, 0, (Math.PI / 2) * (i + 1) / 60);
    for (let i = 0; i < 120; i++) a.step(0, EYE, 0, Math.PI / 2);
    const h = a.hips(), f = a.feet();
    // after turning to face -X, the feet should be side by side along Z (the body's left-right)
    out['turn 90: feet spread along the new left-right (cm; ~ hip width)'] = (100 * Math.abs(f[0].z - f[1].z)).toFixed(1);
    out['turn 90: feet spread along the new facing (cm; ~0)'] = (100 * Math.abs(f[0].x - f[1].x)).toFixed(1);
  }
  return out;
}

import assert from 'node:assert/strict';
const m = await measure(process.env.AVATAR_MODULE ?? '../src/rabbitAvatar.js');
for (const [k, v] of Object.entries(m)) console.log(`${k.padEnd(72)} ${v}`);
const num = (k) => Number(String(m[k]).split(' / ')[0]);
assert.ok(num('walk: feet ahead of hips (mean, cm; 0 = balanced, - = trailing)') > -12, 'feet land under the body, not trailing behind it');
assert.ok(num('lean in: feet moved (max, cm; 0 = stayed planted)') < 1, 'leaning in over the mortar keeps the feet planted');
assert.ok(num("lean in: neck stretched (cm beyond the model's)") < 13, 'the torso bends toward the head when leaning in');
assert.ok(num('squat: feet moved (max, cm)') < 1, 'squatting keeps the feet planted');
assert.ok(num('sway: feet moved (max, cm)') < 1, 'swaying in place is not walking');
assert.ok(num('stop: a foot ahead of the hips after stopping (max, cm)') < 8, 'stopping lands the feet under the body, no overshoot');
assert.ok(num('turn 90: feet spread along the new facing (cm; ~0)') < 8, 'turning on the spot turns the feet with the body');
assert.ok(num('walk: steps per second') > 1.5, 'walking takes steps');
console.info('Rabbit gait checks passed: feet under the body, planted while leaning, squatting and swaying, clean stops and turns.');
