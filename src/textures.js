import * as THREE from 'three';

// Procedural canvas textures, so the scene needs no downloaded art.

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function finish(c, { repeat = [1, 1], srgb = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function gravelTexture() {
  const [c, g] = canvas(512, 512);
  const rnd = seeded(11);
  g.fillStyle = '#6d6a66';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const v = 70 + rnd() * 90;
    const tint = rnd() < 0.15 ? 12 : 0;
    g.fillStyle = `rgb(${v + tint},${v},${v - 6})`;
    const r = 0.8 + rnd() * 2.4;
    g.beginPath();
    g.ellipse(rnd() * 512, rnd() * 512, r, r * (0.6 + rnd() * 0.5), rnd() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  // a dusting of snow, thicker in soft patches
  for (let i = 0; i < 60; i++) {
    const x = rnd() * 512, y = rnd() * 512, r = 30 + rnd() * 70;
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(235,240,248,0.32)');
    grd.addColorStop(1, 'rgba(235,240,248,0)');
    g.fillStyle = grd;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 5000; i++) {
    g.fillStyle = `rgba(240,244,250,${0.25 + rnd() * 0.5})`;
    g.fillRect(rnd() * 512, rnd() * 512, 1.2, 1.2);
  }
  return finish(c, { repeat: [14, 14] });
}

export function stoneTexture() {
  const [c, g] = canvas(256, 256);
  const rnd = seeded(5);
  g.fillStyle = '#8a8680';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2500; i++) {
    const v = 110 + rnd() * 50;
    g.fillStyle = `rgba(${v},${v - 2},${v - 6},0.35)`;
    g.fillRect(rnd() * 256, rnd() * 256, 1 + rnd() * 3, 1 + rnd() * 3);
  }
  for (let i = 0; i < 1500; i++) {
    g.fillStyle = `rgba(245,248,252,${rnd() * 0.35})`;
    g.fillRect(rnd() * 256, rnd() * 256, 1.5, 1.5);
  }
  return finish(c);
}

export function woodTexture({ base = '#8a5a36', dark = '#5e3a20', rings = false, seed = 3 } = {}) {
  const [c, g] = canvas(256, 512);
  const rnd = seeded(seed);
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 70; i++) {
    const x = rnd() * 256;
    g.strokeStyle = dark;
    g.globalAlpha = 0.12 + rnd() * 0.25;
    g.lineWidth = 0.6 + rnd() * 2.2;
    g.beginPath();
    g.moveTo(x, 0);
    for (let y = 0; y <= 512; y += 16) g.lineTo(x + Math.sin(y * 0.02 + i) * (2 + rnd() * 3), y);
    g.stroke();
  }
  g.globalAlpha = 1;
  if (rings) {
    const [c2, g2] = canvas(256, 256);
    g2.fillStyle = '#b48455';
    g2.fillRect(0, 0, 256, 256);
    for (let r = 4; r < 130; r += 3 + rnd() * 4) {
      g2.strokeStyle = `rgba(90,55,30,${0.25 + rnd() * 0.3})`;
      g2.lineWidth = 1 + rnd() * 1.5;
      g2.beginPath();
      g2.arc(128 + rnd() * 2, 128 + rnd() * 2, r, 0, Math.PI * 2);
      g2.stroke();
    }
    return { side: finish(c), top: finish(c2) };
  }
  return finish(c);
}

// Kohaku maku: the red-and-white striped curtain of celebrations.
export function kohakuTexture() {
  const [c, g] = canvas(512, 256);
  const stripes = 8;
  for (let i = 0; i < stripes; i++) {
    g.fillStyle = i % 2 ? '#f4efe6' : '#c8202b';
    g.fillRect((i * 512) / stripes, 0, 512 / stripes + 1, 256);
  }
  g.fillStyle = 'rgba(0,0,0,0.12)';
  g.fillRect(0, 0, 512, 10);
  return finish(c, { repeat: [3, 1] });
}

export function lanternTexture() {
  const [c, g] = canvas(128, 128);
  const grd = g.createLinearGradient(0, 0, 128, 0);
  grd.addColorStop(0, '#d9312b');
  grd.addColorStop(0.5, '#ff6a3d');
  grd.addColorStop(1, '#d9312b');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(80,10,5,0.45)';
  g.lineWidth = 2;
  for (let y = 8; y < 128; y += 10) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(128, y);
    g.stroke();
  }
  g.fillStyle = '#1a1210';
  g.fillRect(0, 0, 128, 10);
  g.fillRect(0, 118, 128, 10);
  return finish(c, { repeat: [1, 1] });
}

export function softSprite({ inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)' } = {}) {
  const [c, g] = canvas(64, 64);
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function skyTexture() {
  const [c, g] = canvas(16, 512);
  const grd = g.createLinearGradient(0, 0, 0, 512);
  grd.addColorStop(0, '#03050c');
  grd.addColorStop(0.45, '#0b1326');
  grd.addColorStop(0.62, '#1d2a44');
  grd.addColorStop(0.7, '#2c3550');
  grd.addColorStop(1, '#141824');
  g.fillStyle = grd;
  g.fillRect(0, 0, 16, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function riceTexture() {
  const [c, g] = canvas(256, 256);
  const rnd = seeded(21);
  g.fillStyle = '#f3efe6';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) {
    const v = 225 + rnd() * 30;
    g.fillStyle = `rgb(${v},${v - 3},${v - 10})`;
    g.strokeStyle = 'rgba(160,150,130,0.35)';
    g.lineWidth = 0.6;
    g.beginPath();
    g.ellipse(rnd() * 256, rnd() * 256, 3.2, 1.6, rnd() * Math.PI, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
  return finish(c, { repeat: [2, 2] });
}
