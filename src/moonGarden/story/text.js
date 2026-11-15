// StoryText.cs: one shared font atlas and one draw per line. Letter animation runs on the GPU.
import * as THREE from 'three';

const PX = 96, CELL = 144, COLS = 16;
const CHARS = [...new Set(Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).concat(['…', '’', '‘', '—', '·']))];
const atlases = new Map();
let fontsReady;
export function loadStoryFonts() {
  return fontsReady ??= Promise.all([
    ['MoonCinzel', 'Cinzel/Cinzel-SemiBold.ttf', '600'], ['MoonCinzel', 'Cinzel/Cinzel-Black.ttf', '900'],
    ['MoonBaloo', 'Baloo2/Baloo2-Bold.ttf', '700'],
  ].map(async ([family, file, weight]) => {
    try {
      const face = new FontFace(family, `url("${import.meta.env?.BASE_URL ?? '/'}env/fonts/${file}")`, { weight });
      document.fonts.add(await face.load());
    } catch (err) { console.warn(`[story] font ${file}: using system fallback`, err.message); }
  }));
}

function atlasFor(font) {
  if (atlases.has(font)) return atlases.get(font);
  const family = font === 'baloo' ? 'MoonBaloo, sans-serif' : 'MoonCinzel, serif';
  const canvas = document.createElement('canvas');
  canvas.width = COLS * CELL;
  canvas.height = THREE.MathUtils.ceilPowerOfTwo(Math.ceil(CHARS.length * 2 / COLS) * CELL);
  const g = canvas.getContext('2d'), glyphs = new Map();
  g.fillStyle = '#fff'; g.textBaseline = 'alphabetic';
  let cap = PX * 0.7;
  for (let weight = 0; weight < 2; weight++) {
    g.font = `${font === 'baloo' ? 700 : weight ? 900 : 600} ${PX}px ${family}`;
    cap = g.measureText('H').actualBoundingBoxAscent || cap;
    CHARS.forEach((ch, i) => {
      const k = weight * CHARS.length + i, x = (k % COLS) * CELL, y = Math.floor(k / COLS) * CELL;
      g.fillText(ch, x + 24, y + 110);
      glyphs.set(`${weight}:${ch}`, { x, y, advance: g.measureText(ch).width });
    });
  }
  const texture = new THREE.CanvasTexture(canvas);
  const atlas = { texture, glyphs, cap, width: canvas.width, height: canvas.height };
  atlases.set(font, atlas);
  return atlas;
}

export function createStoryText({ font = 'cinzel', letterHeight = 0.1, color = [0.97, 0.95, 0.9],
  glowColor = [1, 0.76, 0.4], glowIntensity = 0.16, characterSpacing = 6, lineSpacing = 28,
  rise = true, pulse = false, breathe = false, halo = true, maxReveal = 1.6,
  bouncePeak = 1.2, bounceTime = 1.8 } = {}) {
  const atlas = atlasFor(font), unit = letterHeight / atlas.cap;
  const group = new THREE.Group(); group.name = 'MR_StoryText'; group.visible = false;
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    uniforms: {
      map: { value: atlas.texture }, texel: { value: new THREE.Vector2(1 / atlas.width, 1 / atlas.height) },
      ink: { value: new THREE.Color().setRGB(...color, THREE.SRGBColorSpace) },
      gold: { value: new THREE.Color().setRGB(...glowColor, THREE.SRGBColorSpace) },
      alpha: { value: 0 }, clock: { value: 0 }, exitAt: { value: -1 }, reveal: { value: 0 },
      hasRise: { value: rise ? 1 : 0 }, emphasis: { value: -1 }, peak: { value: bouncePeak },
      swellTime: { value: bounceTime }, breathe: { value: breathe ? 1 : 0 }, glowAmount: { value: glowIntensity * (halo ? 1.5 : 1) },
    },
    vertexShader: /* glsl */ `
      attribute vec2 centre;
      attribute float delay, letter;
      uniform float clock, exitAt, reveal, hasRise, emphasis, peak, swellTime;
      varying vec2 vUv;
      varying float vFade, vGold, vSwell;
      void main() {
        float t = clamp((clock - delay) / 0.7, 0.0, 1.0);
        float r = hasRise * pow(1.0 - t, 3.0);
        float age = clock - reveal;
        float swell = age >= 0.0 && age < swellTime ? pow(sin(age / swellTime * 3.14159265), 2.0) : 0.0;
        float whole = emphasis == 0.0 ? 1.0 : 0.0;
        float emph = emphasis >= 0.0 && letter >= emphasis ? 1.0 : 0.0;
        float breath = age > swellTime ? 0.025 * sin((age - swellTime) * 2.244) * min(1.0, (age - swellTime) / 1.4) : 0.0;
        float size = (1.0 - 0.15 * r) * (1.0 + 0.12 * swell * emph * (1.0 - whole));
        float e = exitAt >= 0.0 ? clamp((clock - exitAt - letter * 0.012) / 0.8, 0.0, 1.0) : 0.0;
        float tilt = r * 0.20944 + sin(letter * 2.3) * 0.1396 * e * e;
        vec2 p = (position.xy - centre) * size * (1.0 + 0.08 * e * e);
        p = mat2(cos(tilt), sin(tilt), -sin(tilt), cos(tilt)) * p + centre;
        p += vec2(-r * r * 0.06 + sin(letter * 1.7) * 0.015 * e * e, -r * 0.2 + 0.1 * e * e);
        p *= 1.0 + whole * ((peak - 1.0) * swell + breath);
        vUv = uv; vGold = emph; vSwell = swell;
        vFade = mix(1.0, smoothstep(0.0, 1.0, t * 1.5), hasRise) * (1.0 - smoothstep(0.0, 1.0, e));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, position.z, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec2 texel;
      uniform vec3 ink, gold;
      uniform float alpha, glowAmount, clock, breathe;
      varying vec2 vUv;
      varying float vFade, vGold, vSwell;
      void main() {
        float a = texture2D(map, vUv).a;
        float edge = texture2D(map, vUv + texel * vec2(2.0, 0.0)).a + texture2D(map, vUv - texel * vec2(2.0, 0.0)).a
          + texture2D(map, vUv + texel * vec2(0.0, 2.0)).a + texture2D(map, vUv - texel * vec2(0.0, 2.0)).a;
        float flash = exp(-clock * 1.6) * min(1.0, clock / 0.25);
        float g = glowAmount * (1.0 + 0.6 * vSwell + breathe * (0.18 * sin(clock * 3.14159) + 1.6 * flash));
        vec3 c = mix(ink, gold, vGold * 0.85);
        c = mix(c, vec3(1.0, 0.84, 0.47), vGold * vSwell * 0.45);
        c = mix(vec3(0.035, 0.024, 0.045) + gold * g * 0.3, c, a);
        gl_FragColor = vec4(c, max(a, min(1.0, edge) * 0.65) * alpha * vFade);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.frustumCulled = false; mesh.renderOrder = 32; group.add(mesh);
  const head = new THREE.Vector3(), forward = new THREE.Vector3();
  let age = 0, revealDuration = 0, exitDuration = 0.8, emphasisFrom = -1;

  function layout(text, from) {
    let index = 0;
    const rows = text.split('\n').map((line) => {
      const row = Array.from(line).map((ch) => {
        const i = index++, emphasized = from >= 0 && i >= from;
        const glyph = atlas.glyphs.get(`${emphasized ? 1 : 0}:${ch}`) ?? atlas.glyphs.get('0:?');
        return { ch, i, glyph, scale: emphasized ? 1.2 : 1 };
      });
      index++; return row;
    });
    const spacing = PX * characterSpacing / 100;
    const widths = rows.map((row) => Math.max(0, row.reduce((w, c) => w + c.glyph.advance * c.scale + spacing, 0) - spacing));
    return { rows, widths, spacing, width: Math.max(0, ...widths) * unit, height: (rows.length * PX * (1 + lineSpacing / 100) - PX * 0.28) * unit };
  }

  function setText(value, from = -1) {
    const text = String(value ?? ''); emphasisFrom = pulse && from < 0 ? 0 : from;
    const l = layout(text, emphasisFrom), n = Array.from(text).length;
    const rawTimes = []; let raw = 0;
    for (const ch of text) { rawTimes.push(raw); raw += /\s/.test(ch) ? 0.07 : 0.035; }
    const timeScale = raw > 0 ? Math.min(1, Math.max(0, maxReveal - 0.7) / raw) : 0;
    revealDuration = rise && n ? (rawTimes.at(-1) ?? 0) * timeScale + 0.7 : 0;
    exitDuration = 0.8 + n * 0.012;
    const positions = [], uvs = [], centres = [], delays = [], indices = [], letters = [];
    l.rows.forEach((row, rowIndex) => {
      let x = -l.widths[rowIndex] / 2;
      const baseline = ((l.rows.length - 1) / 2 - rowIndex) * PX * (1 + lineSpacing / 100) - atlas.cap / 2;
      for (const c of row) {
        const { glyph: g, scale } = c;
        if (!/\s/.test(c.ch)) {
          const left = (x - 24 * scale) * unit, bottom = (baseline - 34 * scale) * unit, size = CELL * scale * unit;
          const base = positions.length / 3, cx = (x + g.advance * scale / 2) * unit, cy = (baseline + atlas.cap * scale / 2) * unit;
          for (const [dx, dy] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
            positions.push(left + dx * size, bottom + dy * size, 0);
            uvs.push((g.x + dx * CELL) / atlas.width, 1 - (g.y + (1 - dy) * CELL) / atlas.height);
            centres.push(cx, cy); delays.push((rawTimes[c.i] ?? 0) * timeScale); letters.push(c.i);
          }
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
        x += g.advance * scale + l.spacing;
      }
    });
    const geometry = new THREE.BufferGeometry();
    for (const [name, data, itemSize] of [['position', positions, 3], ['uv', uvs, 2], ['centre', centres, 2], ['delay', delays, 1], ['letter', letters, 1]]) {
      geometry.setAttribute(name, new THREE.Float32BufferAttribute(data, itemSize));
    }
    geometry.setIndex(indices); mesh.geometry.dispose(); mesh.geometry = geometry;
    age = 0; material.uniforms.clock.value = 0; material.uniforms.exitAt.value = -1;
    material.uniforms.reveal.value = revealDuration; material.uniforms.emphasis.value = emphasisFrom;
  }

  return {
    object3d: group, setText,
    measure(value, from = -1) { const { width, height } = layout(String(value), from); return new THREE.Vector2(width, height); },
    get revealDuration() { return revealDuration; },
    get emphasisDuration() { return emphasisFrom === 0 ? bounceTime : 0; },
    get exitDuration() { return exitDuration; },
    get swellNow() { const t = age - revealDuration; return emphasisFrom >= 0 && t >= 0 && t < bounceTime ? Math.sin(t / bounceTime * Math.PI) ** 2 : 0; },
    placeInFront(camera, distance, above = 0) {
      camera.getWorldPosition(head); camera.getWorldDirection(forward); forward.y = 0;
      if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
      group.position.copy(head).addScaledVector(forward.normalize(), distance); group.position.y += above;
      group.lookAt(head); group.updateMatrixWorld(true);
    },
    setAlpha(a) { material.uniforms.alpha.value = THREE.MathUtils.clamp(a, 0, 1); group.visible = a > 0.001; },
    beginExit() { material.uniforms.exitAt.value = age; },
    update(dt) { age += dt; material.uniforms.clock.value = age; },
    dispose() { group.removeFromParent(); mesh.geometry.dispose(); material.dispose(); },
  };
}
