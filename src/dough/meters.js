import * as THREE from 'three';
import * as L from '../layout.js';

// The elasticity and moisture bars (2026-11-15; made subtler at the user's request): a small translucent strip
// behind the mortar, two thin bars with tiny labels, no panel. The water bar is the dough's own colour (white
// when watered, browner as it dries). One billboard texture: readable from either side and in both VR eyes.
const DRY = [176, 132, 88], WATERED = [244, 241, 234]; // sRGB, as the dough's tint (src/dough/dough.js)
const waterColour = (m) => `rgba(${DRY.map((d, i) => Math.round(d + (WATERED[i] - d) * m)).join(',')},0.9)`;
const W = 512, H = 96;
export function createDoughMeters(scene, station) {
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d'), texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.8, depthWrite: false }));
  sprite.name = 'dough-elasticity-moisture'; sprite.scale.set(0.34, 0.34 * H / W, 1);
  sprite.position.set(L.USU.position[0], L.USU.height + 0.55, L.USU.position[2] - 0.38);
  sprite.visible = false; scene.add(sprite);
  let last = '';
  const round = (x, y, w, h) => { const r = h / 2; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); ctx.fill(); };
  return {
    object3d: sprite,
    update(visible) {
      sprite.visible = visible && station.phase === 'pound';
      if (!sprite.visible) return;
      const s = station.conditioning, e = Math.round(s.elasticity * 100), m = Math.round(s.moisture * 100);
      const key = `${e}:${m}`;
      if (last === key) return; last = key;
      ctx.clearRect(0, 0, W, H);
      const x0 = 112, bw = W - x0 - 16;
      const bar = (label, pct, y, color) => {
        ctx.font = '500 22px system-ui, sans-serif'; ctx.textBaseline = 'middle'; ctx.textAlign = 'right';
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.strokeText(label, x0 - 14, y);
        ctx.fillStyle = 'rgba(255,244,223,0.85)'; ctx.fillText(label, x0 - 14, y);
        ctx.fillStyle = 'rgba(20,28,40,0.35)'; round(x0, y - 6, bw, 12);
        ctx.fillStyle = color; if (pct > 0) round(x0, y - 6, Math.max(12, bw * pct / 100), 12);
      };
      bar('elastic', e, 28, 'rgba(140,224,168,0.85)');
      bar('water', m, 66, waterColour(s.moisture));
      texture.needsUpdate = true;
    },
  };
}
