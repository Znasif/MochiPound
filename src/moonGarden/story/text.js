// StoryText, ported from the Unity team's `multiplayer` branch (MochiPound, Assets/_Project/World/Scripts/StoryText.cs):
// a world-space story line for VR, placed once in front of the head (never head-locked). Its letters rise in one
// by one along a soft arc, an emphasised part swells and brightens once the line has risen, and the letters drift
// out like incense smoke. TextMesh Pro is replaced by a glyph atlas drawn once per line into a canvas (one cell per
// letter, so each letter is its own quad and moves on its own, as StoryText does with TMP's vertices):
//   R = the letter's outline, G = its fill, B = a soft blurred glow (glow styles only); the shader colours them.
// Fonts: public/env/fonts (Cinzel SemiBold and Black, Baloo 2 Bold, all OFL), loaded once as FontFaces.
//
// createStoryText(style) -> { object3d, setText(text, emphasisFrom = -1, emphasisTo = Infinity), measure(text,
//   emphasisFrom, emphasisTo) -> { x, y } (m), placeInFront(camera, distance, above), setAlpha(a), beginExit(),
//   update(dt), dispose(), revealDuration, emphasisDuration, exitDuration, swellNow, and the knobs maxReveal,
//   bouncePeak, bounceTime, brightColor }.
// style: { font: 'cinzel' | 'baloo', letterHeight (m, capital height), color, outlineColor ([r, g, b, a]),
//   characterSpacing and lineSpacing (TMP units: 1/100 em), glowColor, glowIntensity, glow (blurred glow behind
//   the letters; default: glowIntensity > 0.3), rise, pulse, breathe, emphasisColor, emphasisScale (size of the
//   emphasised part, TMP's <size>), emphasisWeight }. Colours are Unity's (gamma space) and are linearised.
import * as THREE from 'three';
import { linColor } from '../unity.js';

const BASE = (import.meta.env?.BASE_URL ?? '/') + 'env/fonts/';
const FAMILY = { cinzel: 'MR Cinzel', baloo: 'MR Baloo 2' };
const FALLBACK = { cinzel: '"Cinzel", "Trajan Pro", Georgia, serif', baloo: '"Baloo 2", "Trebuchet MS", Verdana, sans-serif' };
const BASE_WEIGHT = { cinzel: 600, baloo: 700 };

// ---------------- fonts (once per page)
let fontsPromise = null;
export function loadStoryFonts() {
  if (fontsPromise) return fontsPromise;
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return (fontsPromise = Promise.resolve(false));
  const faces = [
    new FontFace(FAMILY.cinzel, `url(${BASE}Cinzel/Cinzel-SemiBold.ttf)`, { weight: '600' }),
    new FontFace(FAMILY.cinzel, `url(${BASE}Cinzel/Cinzel-Black.ttf)`, { weight: '900' }),
    new FontFace(FAMILY.baloo, `url(${BASE}Baloo2/Baloo2-Bold.ttf)`, { weight: '700' }),
  ];
  fontsPromise = Promise.all(faces.map((f) => f.load().then((ff) => { document.fonts.add(ff); return true; })
    .catch((err) => { console.warn('[story] font failed to load', f.family, err?.message); return false; })))
    .then((ok) => ok.every(Boolean));
  return fontsPromise;
}

const PX_PER_DM = 80;     // canvas pixels per em of a regular letter per 0.1 m capital (a 0.1 m capital at 2.8 m is ~40 px on a Quest 3)
const ATLAS_W = 2048;
const lin = (c) => linColor(new THREE.Color(), c);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const isSpace = (ch) => ch === ' ' || ch === '\n' || ch === '\t' || ch === ' ';

export function createStoryText(style = {}) {
  void loadStoryFonts(); // usually loaded already (the intro waits for them)
  const S = {
    font: 'cinzel', letterHeight: 0.1, color: [0.97, 0.95, 0.9], outlineColor: [0.08, 0.07, 0.12, 0.85],
    characterSpacing: 0, lineSpacing: 0, glowColor: [1, 0.74, 0.45], glowIntensity: 0.14,
    rise: true, pulse: false, breathe: false, emphasisColor: [1, 0.824, 0.478], emphasisScale: 1.2, emphasisWeight: 900,
    ...style,
  };
  const fontKey = FAMILY[S.font] ? S.font : 'cinzel';
  const glowOn = S.glow ?? S.glowIntensity > 0.3;
  const PX = Math.round(Math.min(200, Math.max(80, PX_PER_DM * S.letterHeight / 0.1)));

  // ---------------- StoryText's knobs (its inspector defaults)
  const K = {
    letterDelay: 0.035, wordPause: 0.07, maxReveal: 1.8, riseTime: 0.7, riseDistance: 0.2, riseSide: 0.06,
    riseScale: 0.85, riseTilt: 12, exitTime: 0.8, exitRise: 0.1, exitStagger: 0.012,
    bouncePeak: 1.2, bounceTime: 1.8, breatheAmount: 0.025, breathePeriod: 2.8,
  };
  const bright = lin([1, 248 / 255, 225 / 255]);
  const baseCol = lin(S.color), emphCol = lin(S.emphasisColor);
  const outline = new THREE.Vector4(...lin(S.outlineColor.slice(0, 3)).toArray(), S.outlineColor[3] ?? 1);

  // ---------------- drawing objects
  const group = new THREE.Group();
  group.name = 'MR_StoryText';
  group.visible = false;
  const node = new THREE.Group(); // the whole-line swell scales this, from the line's centre
  group.add(node);
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W; canvas.height = 64;
  const g2 = canvas.getContext('2d');
  let tex = null;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null },
      uOutline: { value: outline },
      uGlowColor: { value: lin(S.glowColor) },
      uGlow: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 color;
      varying vec2 vUv;
      varying vec4 vCol;
      void main() {
        vUv = uv;
        vCol = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec4 uOutline;
      uniform vec3 uGlowColor;
      uniform float uGlow;
      varying vec2 vUv;
      varying vec4 vCol;
      void main() {
        vec3 t = texture2D(map, vUv).rgb;
        float cov = clamp(t.r + t.g, 0.0, 1.0);
        vec3 col = mix(uOutline.rgb, vCol.rgb, t.g / max(cov, 1e-3));
        float a = clamp(t.g + t.r * uOutline.a, 0.0, 1.0) * vCol.a;
        // premultiplied: the glow adds light around the letters
        gl_FragColor = vec4(col * a + uGlowColor * (t.b * uGlow * vCol.a), a);
        #include <colorspace_fragment>
      }`,
    transparent: true, premultipliedAlpha: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  mat.fog = false;
  let geom = new THREE.BufferGeometry();
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = 'Letters';
  mesh.frustumCulled = false;
  mesh.renderOrder = 22;
  node.add(mesh);

  // ---------------- state (Unity's Time.time is `now`, advanced by update)
  let now = 0, alpha = 0, revealStart = -100, pulseStart = -100, exitStart = -100, appearStart = -100;
  let revealing = false, exiting = false, swellNow = 0, pulseFrom = -1, revealDuration = 0;
  let glyphs = [], charStart = new Float32Array(0), metresPerPx = 0.001, size = { x: 0, y: 0 };
  let pos = null, col = null;

  // ---------------- layout
  const fontCss = (weight, px) => `${weight} ${px}px "${FAMILY[fontKey]}", ${FALLBACK[fontKey]}`;
  const advCache = new Map();
  function measureChar(ch, weight, px) {
    const key = `${weight}|${px}|${ch}`;
    let m = advCache.get(key);
    if (!m) {
      g2.font = fontCss(weight, px);
      const t = g2.measureText(ch);
      m = { adv: t.width, l: t.actualBoundingBoxLeft ?? 0, r: t.actualBoundingBoxRight ?? t.width };
      advCache.set(key, m);
    }
    return m;
  }
  function fontBox(weight, px) {
    g2.font = fontCss(weight, px);
    const t = g2.measureText('Hg');
    const asc = t.fontBoundingBoxAscent ?? px * 0.95, desc = t.fontBoundingBoxDescent ?? px * 0.3;
    const cap = g2.measureText('H').actualBoundingBoxAscent || px * 0.7;
    return { asc, desc, cap };
  }
  // the glyphs of `text` in canvas pixels (y up, baseline-relative per line), centred on the block's middle
  function layout(text, from, to) {
    const base = fontBox(BASE_WEIGHT[fontKey], PX);
    metresPerPx = S.letterHeight / base.cap;
    const lines = String(text ?? '').split('\n');
    const out = [];
    const lineInfo = [];
    let index = 0, width = 0, height = 0;
    for (let li = 0; li < lines.length; li++) {
      const row = [];
      let x = 0, maxPx = PX;
      for (const ch of lines[li]) {
        const emph = from >= 0 && index >= from && index < to;
        const px = emph ? Math.round(PX * S.emphasisScale) : PX;
        const weight = emph ? S.emphasisWeight : BASE_WEIGHT[fontKey];
        const m = measureChar(ch, weight, px);
        row.push({ ch, index, emph, px, weight, x, adv: m.adv, l: m.l, r: m.r, visible: !isSpace(ch) });
        x += m.adv + (S.characterSpacing / 100) * px;
        if (emph) maxPx = Math.max(maxPx, px);
        index++;
      }
      if (row.length) x -= (S.characterSpacing / 100) * row[row.length - 1].px;
      const fb = fontBox(BASE_WEIGHT[fontKey], maxPx);
      const lh = fb.asc + fb.desc + (S.lineSpacing / 100) * maxPx;
      lineInfo.push({ row, w: x, lh, asc: fb.asc, desc: fb.desc });
      width = Math.max(width, x);
      height += li ? lh : fb.asc + fb.desc;
      out.push(...row);
      if (li < lines.length - 1) out.push({ ch: '\n', index: index++, visible: false });
    }
    // baselines: the first line's top at +height/2
    let top = height / 2;
    for (let li = 0; li < lineInfo.length; li++) {
      const L = lineInfo[li];
      if (li) top -= L.lh - (L.asc + L.desc);
      const baseline = top - L.asc;
      for (const gl of L.row) { gl.x += -L.w / 2; gl.baseline = baseline; }
      top -= L.asc + L.desc;
    }
    return { glyphs: out, w: width, h: height, cap: base.cap };
  }

  // one atlas cell per visible letter; the quads in metres (node-local, x right, y up)
  function build(text, from, to) {
    const lay = layout(text, from, to);
    glyphs = lay.glyphs;
    const pad = Math.ceil(PX * (glowOn ? 0.5 : 0.12));
    let cx = 0, cy = 0, rowH = 0;
    for (const gl of glyphs) {
      if (!gl.visible) continue;
      const fb = fontBox(gl.weight, gl.px);
      gl.left = Math.min(0, -gl.l);
      gl.right = Math.max(gl.adv, gl.r);
      gl.cw = Math.ceil(gl.right - gl.left + pad * 2);
      gl.ch2 = Math.ceil(fb.asc + fb.desc + pad * 2);
      gl.asc = fb.asc;
      if (cx + gl.cw > ATLAS_W) { cx = 0; cy += rowH; rowH = 0; }
      gl.ax = cx; gl.ay = cy;
      cx += gl.cw; rowH = Math.max(rowH, gl.ch2);
    }
    const H = Math.max(64, Math.ceil((cy + rowH) / 64) * 64);
    if (canvas.height !== H) { canvas.height = H; if (tex) { tex.dispose(); tex = null; } }
    g2.setTransform(1, 0, 0, 1, 0, 0);
    g2.globalCompositeOperation = 'source-over';
    g2.fillStyle = '#000';
    g2.fillRect(0, 0, ATLAS_W, H);
    g2.textBaseline = 'alphabetic';
    g2.textAlign = 'left';
    g2.lineJoin = 'round';
    for (const gl of glyphs) {
      if (!gl.visible) continue;
      const bx = gl.ax + pad - gl.left, by = gl.ay + pad + gl.asc;
      g2.save();
      g2.beginPath(); g2.rect(gl.ax, gl.ay, gl.cw, gl.ch2); g2.clip();
      g2.font = fontCss(gl.weight, gl.px);
      if (glowOn) {
        g2.shadowColor = '#0000ff'; g2.fillStyle = '#0000ff';
        g2.shadowBlur = gl.px * 0.35; g2.fillText(gl.ch, bx, by);
        g2.shadowBlur = gl.px * 0.14; g2.fillText(gl.ch, bx, by);
        g2.shadowBlur = 0; g2.shadowColor = 'transparent';
      }
      g2.strokeStyle = '#ff0000'; g2.lineWidth = gl.px * 0.1;
      g2.strokeText(gl.ch, bx, by);
      g2.fillStyle = '#00ff00';
      g2.fillText(gl.ch, bx, by);
      g2.restore();
    }
    if (!tex) {
      tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.NoColorSpace;
      tex.anisotropy = 4;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      mat.uniforms.map.value = tex;
    }
    tex.needsUpdate = true;

    // the quads
    const vis = glyphs.filter((gl) => gl.visible);
    const n = vis.length, s = metresPerPx;
    geom.dispose();
    geom = new THREE.BufferGeometry();
    pos = new Float32Array(n * 12);
    col = new Float32Array(n * 16);
    const uv = new Float32Array(n * 8), idx = new Uint32Array(n * 6);
    vis.forEach((gl, k) => {
      const x0 = (gl.x + gl.left - pad) * s, x1 = x0 + gl.cw * s;
      const y1 = (gl.baseline + gl.asc + pad) * s, y0 = y1 - gl.ch2 * s;
      gl.q = [x0, y0, x1, y1];
      gl.cx = (gl.x + gl.adv / 2) * s; gl.cy = (gl.baseline + lay.cap * 0.5 * (gl.px / PX)) * s;
      const u0 = gl.ax / ATLAS_W, u1 = (gl.ax + gl.cw) / ATLAS_W, v1 = 1 - gl.ay / H, v0 = 1 - (gl.ay + gl.ch2) / H;
      uv.set([u0, v0, u1, v0, u1, v1, u0, v1], k * 8);
      idx.set([k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3], k * 6);
      gl.c = gl.emph ? emphCol : baseCol;
    });
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
    mesh.geometry = geom;
    size = { x: lay.w * s, y: lay.h * s };
    return vis;
  }

  // start time of each character (steady rhythm, a pause at spaces), kept within maxReveal
  function computeLetterTimes() {
    const n = glyphs.length;
    charStart = new Float32Array(n);
    let spaces = 0, letters = 0;
    for (const gl of glyphs) { if (isSpace(gl.ch)) spaces++; else letters++; }
    const budget = Math.max(0.2, K.maxReveal - K.riseTime - spaces * K.wordPause);
    const delay = Math.min(K.letterDelay, Math.max(0.012, budget / Math.max(1, letters)));
    let t = 0;
    for (let i = 0; i < n; i++) { charStart[i] = t; t += isSpace(glyphs[i].ch) ? K.wordPause : delay; }
    revealDuration = (n > 0 ? charStart[n - 1] : 0) + K.riseTime;
  }

  const wholeLine = () => S.pulse || pulseFrom === 0;
  function swellCurve(since, dur) {
    if (since < 0 || since >= dur || pulseStart < -50) return 0;
    const s = Math.sin(since / dur * Math.PI);
    return s * s;
  }
  function emphasisScale(since, swell) {
    if (!wholeLine() || since < 0 || pulseStart < -50) return 1;
    if (since < K.bounceTime) return 1 + (K.bouncePeak - 1) * swell;
    const b = (since - K.bounceTime) / K.breathePeriod;
    return 1 + K.breatheAmount * Math.sin(b * Math.PI * 2) * clamp01(b * 2);
  }

  // per-letter position (rise along a curve, drift-out) and alpha, written into the quads
  function writeVertices() {
    if (!pos) return;
    let anyMoving = false, k = 0;
    for (let i = 0; i < glyphs.length; i++) {
      const gl = glyphs[i];
      if (!gl.visible) continue;
      let ox = 0, oy = 0, scale = 1, tilt = 0, fade = 1, br = 0;
      if (revealing) {
        const t = clamp01((now - revealStart - charStart[i]) / K.riseTime);
        if (t < 1) anyMoving = true;
        const e = 1 - Math.pow(1 - t, 3), r = 1 - e;
        ox = -r * r * K.riseSide; oy = -r * K.riseDistance;
        scale = K.riseScale + (1 - K.riseScale) * e;
        tilt = r * K.riseTilt;
        fade = smooth(0, 1, t * 1.5);
      }
      if (pulseFrom >= 0 && gl.emph && swellNow > 0) {
        if (pulseFrom > 0) scale *= 1 + 0.12 * swellNow; // part of a line: only those words swell
        br = 0.45 * swellNow;
      }
      if (exiting) {
        const t = clamp01((now - exitStart - i * K.exitStagger) / K.exitTime), e = t * t;
        ox += Math.sin(i * 1.7) * 0.015 * e; oy += K.exitRise * e;
        scale *= 1 + 0.08 * e;
        tilt += Math.sin(i * 2.3) * 8 * e;
        fade *= 1 - smooth(0, 1, t);
      }
      const [x0, y0, x1, y1] = gl.q, cx = gl.cx, cy = gl.cy;
      const a = tilt * Math.PI / 180, ca = Math.cos(a) * scale, sa = Math.sin(a) * scale;
      const corners = [x0, y0, x1, y0, x1, y1, x0, y1];
      for (let v = 0; v < 4; v++) {
        const dx = corners[v * 2] - cx, dy = corners[v * 2 + 1] - cy;
        pos[k * 12 + v * 3] = cx + dx * ca - dy * sa + ox;
        pos[k * 12 + v * 3 + 1] = cy + dx * sa + dy * ca + oy;
        pos[k * 12 + v * 3 + 2] = 0;
      }
      const c = gl.c, A = alpha * fade;
      const r = c.r + (bright.r - c.r) * br, g = c.g + (bright.g - c.g) * br, b = c.b + (bright.b - c.b) * br;
      for (let v = 0; v < 4; v++) col.set([r, g, b, A], k * 16 + v * 4);
      k++;
    }
    if (revealing && !anyMoving) revealing = false;
    geom.attributes.position.needsUpdate = true;
    geom.attributes.color.needsUpdate = true;
  }

  function refresh() {
    const pu = now - pulseStart;
    const swell = swellCurve(pu, wholeLine() ? K.bounceTime : 0.9);
    swellNow = swell;
    let glowK = 1 + (pulseFrom >= 0 ? 0.6 : 1.5) * swell;
    if (S.breathe) {
      const ap = now - appearStart;
      const flash = ap >= 0 ? Math.exp(-ap * 1.6) * clamp01(ap / 0.25) : 0;
      glowK *= 1 + 0.18 * Math.sin(ap * Math.PI) + 1.6 * flash;
    }
    node.scale.setScalar(emphasisScale(pu, swell));
    mat.uniforms.uGlow.value = glowOn ? Math.min(2, S.glowIntensity * 1.6 * glowK) : 0;
    writeVertices();
    group.visible = alpha > 0.001 || revealing;
  }

  const head = new THREE.Vector3(), fwd = new THREE.Vector3();
  const api = {
    object3d: group,
    get revealDuration() { return S.rise ? revealDuration : 0; },
    get emphasisDuration() { return wholeLine() ? K.bounceTime : 0; },
    get exitDuration() { return K.exitTime + K.exitStagger * glyphs.length; },
    get swellNow() { return swellNow; },
    get size() { return size; },
    get maxReveal() { return K.maxReveal; }, set maxReveal(v) { K.maxReveal = v; },
    get bouncePeak() { return K.bouncePeak; }, set bouncePeak(v) { K.bouncePeak = v; },
    get bounceTime() { return K.bounceTime; }, set bounceTime(v) { K.bounceTime = v; },
    set brightColor(c) { bright.copy(lin(c)); },
    /** Laid-out size (m) of a line at this style, without showing it. */
    measure(text, from = -1, to = Infinity) {
      const lay = layout(text, from, to);
      return { x: lay.w * metresPerPx, y: lay.h * metresPerPx };
    },
    /** Sets the line; characters from..to (indices in the string, newlines counted) are the emphasis: bolder, in
     *  the emphasis colour and size, and they swell and brighten once the line has risen. */
    setText(text, from = -1, to = Infinity) {
      pulseFrom = from;
      build(text, from, to);
      revealStart = now; appearStart = now;
      revealing = !!S.rise; exiting = false;
      computeLetterTimes();
      pulseStart = S.pulse || pulseFrom >= 0 ? now + revealDuration : -100;
      refresh();
    },
    /** distance ahead of the head's yaw, `above` over eye height, facing the head */
    placeInFront(camera, distance, above = 0) {
      camera.getWorldPosition(head);
      camera.getWorldDirection(fwd);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
      fwd.normalize();
      group.position.copy(head).addScaledVector(fwd, distance);
      group.position.y += above;
      group.lookAt(head); // +z (the letters' front) toward the head
      group.updateMatrixWorld(true);
    },
    setAlpha(a) { alpha = clamp01(a); refresh(); },
    beginExit() { exiting = true; exitStart = now; },
    update(dt) { now += dt; if (alpha > 0.001 || revealing) refresh(); },
    dispose() {
      group.removeFromParent();
      geom.dispose(); mat.dispose(); tex?.dispose();
    },
  };
  return api;
}
