import * as THREE from 'three';
import * as L from '../layout.js';
import { CONDITIONING } from './conditioning.js';

// One small billboard texture: readable from either side of the mortar and in both VR eyes.
export function createDoughMeters(scene, station) {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 208;
  const ctx = canvas.getContext('2d'), texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.name = 'dough-elasticity-moisture'; sprite.scale.set(0.88, 0.286, 1);
  sprite.position.set(L.USU.position[0], L.USU.height + 0.85, L.USU.position[2] - 0.35);
  sprite.visible = false; scene.add(sprite);
  let last = '';
  return {
    object3d: sprite,
    update(visible) {
      sprite.visible = visible && station.phase === 'pound';
      if (!sprite.visible) return;
      const s = station.conditioning, e = Math.round(s.elasticity * 100), m = Math.round(s.moisture * 100);
      const dry = s.moisture < CONDITIONING.moistureThreshold, key = `${e}:${m}:${dry}`;
      if (last === key) return; last = key;
      ctx.clearRect(0, 0, 640, 208); ctx.fillStyle = 'rgba(12,20,30,0.88)'; ctx.fillRect(0, 0, 640, 208);
      const bar = (label, pct, y, color) => {
        ctx.font = '600 25px system-ui'; ctx.textBaseline = 'top'; ctx.fillStyle = '#fff4df';
        ctx.fillText(`${label}  ${pct}%`, 24, y);
        ctx.fillStyle = '#344454'; ctx.fillRect(24, y + 34, 592, 21);
        ctx.fillStyle = color; ctx.fillRect(24, y + 34, 592 * pct / 100, 21);
      };
      bar('ELASTICITY', e, 18, '#71df94');
      bar('MOISTURE', m, 92, dry ? '#ff5555' : '#67cdf1');
      const minX = 24 + 592 * CONDITIONING.moistureThreshold;
      ctx.fillStyle = '#ffd45a'; ctx.fillRect(minX - 2, 123, 4, 27);
      ctx.font = '600 19px system-ui'; ctx.fillStyle = dry ? '#ff8880' : '#c9d9dc';
      ctx.fillText(dry ? 'DRY — dip hands in the water bucket' : 'Keep moisture above the yellow mark', 24, 170);
      texture.needsUpdate = true;
    },
  };
}
