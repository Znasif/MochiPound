// IntroScroll, ported from the Unity team's `multiplayer` branch (MochiPound,
// Assets/_Project/World/Scripts/IntroScroll.cs, Shaders/MR_HanjiScroll.shader): the hanji (Korean mulberry paper)
// handscroll. Warm cream paper, half see-through, fine fibres and faint blotches, softly torn edges, thin rolled curls
// along the top and bottom, a paper roll at each moving end while it unrolls / rolls up, and gold auspicious-cloud
// motifs in the four corners. It unrolls from the middle, rolls up again (or fades at once), and has a small hint
// line under it. The fibre and cloud textures are drawn in code once (512² and 256²), as Unity does.
// Used by the intro (the story lines are written on it) and the song scrolls (one per song).
// createHanjiScroll(textMod, opts) -> { object3d, setup(pose, w, h, hint), open(t), close(t), fade(t), hideHint(),
//   hideNow(), update(dt), cloudGlow (set), right, active, alpha, size, paper }; opts override DEFAULTS.
import * as THREE from 'three';
import { DotNetRandom, linColor, smoothStep, clamp01, lerp } from '../unity.js';

// IntroScroll's inspector defaults; opacity is MR_EnvironmentSettings.introScrollOpacity
const DEFAULTS = {
  padding: [0.17, 0.1], margin: 0.05, opacity: 0.62, hintColor: [0.93, 0.88, 0.76], hintAlpha: 0.62, hintDelay: 1,
  hintLetterHeight: 0.045, hintGap: 0.075,
};

// ======================================================================= IntroScroll + MoonRabbit/HanjiScroll
export function createHanjiScroll(textMod, opts = {}) {
  const SCROLL = { ...DEFAULTS, ...opts };
  const group = new THREE.Group();
  group.name = 'MR_IntroScroll';
  group.visible = false;
  const { fiber, cloud } = scrollTextures();
  const lin = (c) => linColor(new THREE.Color(), c);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uFiber: { value: fiber }, uCloud: { value: cloud },
      uPaper: { value: lin([0.97, 0.93, 0.82]) }, uOpacity: { value: SCROLL.opacity }, uGold: { value: lin([0.86, 0.66, 0.3]) },
      uCloudGlow: { value: 0 }, uCloudSize: { value: 0.13 }, uCurl: { value: 0.012 }, uRoll: { value: 0.022 }, uTorn: { value: 0.012 },
      uSize: { value: new THREE.Vector4(1.6, 0.4, 1.7, 0.5) }, uUnroll: { value: 0 }, uAlpha: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uFiber, uCloud;
      uniform vec3 uPaper, uGold;
      uniform float uOpacity, uCloudGlow, uCloudSize, uCurl, uRoll, uTorn, uUnroll, uAlpha;
      uniform vec4 uSize;
      varying vec2 vUv;
      void main() {
        vec2 p = (vUv - 0.5) * uSize.zw;                     // metres from the centre (x right, y up)
        float u = clamp(uUnroll, 0.0, 1.0);
        float hwFull = uSize.x * 0.5, hh = uSize.y * 0.5;
        float roll = mix(uRoll, uRoll * 0.3, u);              // the roll thins as the paper comes off it
        float hw = max(hwFull * u, roll);                     // paper edge (also the roll's centre line)
        float ax = abs(p.x), ay = abs(p.y);
        // paper: fibres, blotches, softly torn edges
        vec3 f = texture2D(uFiber, p * 1.6).rgb;
        float tear = (texture2D(uFiber, vec2(p.x * 3.1, p.y * 3.1 + 0.37)).b - 0.5) * uTorn;
        float dEdge = min(hw - ax, hh - ay) + tear;
        float paperMask = smoothstep(0.0, 0.004 + uTorn * 0.4, dEdge);
        vec3 col = uPaper * (0.93 + 0.1 * f.r) - f.g * 0.05;
        float a = uOpacity * (0.88 + 0.24 * f.r) * paperMask;
        // thin rolled curls along the top and bottom
        float tc = clamp((ay - (hh - uCurl)) / uCurl, 0.0, 1.0);
        float inCurl = step(hh - uCurl, ay) * step(ay, hh + uCurl * 0.25) * step(ax, hw);
        float shade = sin(tc * 3.14159);
        col = mix(col, uPaper * (0.62 + 0.3 * shade), inCurl);
        a = mix(a, 0.9 * step(ax, hw - 0.002), inCurl);
        // the roll at each moving end (a slim rod when fully open)
        float tr = (ax - (hw - roll)) / (2.0 * roll);
        float inRoll = step(0.0, tr) * step(tr, 1.0) * step(ay, hh + uCurl * 0.25);
        float rs = sin(clamp(tr, 0.0, 1.0) * 3.14159);
        vec3 rollCol = uPaper * (0.55 + 0.4 * rs) * (0.95 + 0.08 * f.r);
        col = mix(col, rollCol, inRoll);
        a = mix(a, 0.95, inRoll);
        // gold auspicious clouds in the four corners, once the paper is (nearly) open
        float cs = min(uCloudSize, uSize.y * 0.42);
        float inset = roll * 2.0 + 0.012;
        vec2 cuv = vec2((ax - (hw - inset - cs)) / cs, (ay - (hh - uCurl - 0.008 - cs)) / cs);
        float cl = 0.0;
        if (cuv.x >= 0.0 && cuv.x <= 1.0 && cuv.y >= 0.0 && cuv.y <= 1.0) cl = texture2D(uCloud, cuv).r;
        cl *= smoothstep(0.82, 1.0, u) * (1.0 - inRoll);
        vec3 gold = uGold * (0.85 + 0.6 * uCloudGlow);
        col = mix(col, gold, cl * 0.9);
        a = max(a, cl * 0.92 * paperMask);
        gl_FragColor = vec4(clamp(col, 0.0, 1.0), clamp(a, 0.0, 1.0) * uAlpha);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  });
  mat.fog = false;
  const paper = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  paper.name = 'Paper';
  paper.position.z = -0.035; // just behind the letters
  paper.renderOrder = 20;
  group.add(paper);
  const hint = textMod.createStoryText({
    font: 'cinzel', letterHeight: SCROLL.hintLetterHeight, color: SCROLL.hintColor, outlineColor: [0.08, 0.07, 0.12, 0.85],
    characterSpacing: 8, rise: false, glow: false,
  });
  hint.object3d.name = 'SkipHint';
  group.add(hint.object3d);

  let w = 1.6, h = 0.4, unroll = 0, alpha = 0, from = 0, to = 0, t0 = -100, dur = 1, now = 0;
  let fading = false, fadeFrom = 0, hintOn = false, hintStart = -100, active = false;
  const right = new THREE.Vector3(1, 0, 0);
  function apply() {
    const m = SCROLL.margin;
    mat.uniforms.uSize.value.set(w, h, w + m * 2, h + m * 2);
    mat.uniforms.uUnroll.value = unroll;
    mat.uniforms.uAlpha.value = alpha;
    paper.visible = alpha > 0.002;
  }
  function hideHint() { hintOn = false; hint.setAlpha(0); }
  function hideNow() { hideHint(); unroll = 0; alpha = 0; fading = false; t0 = -100; active = false; group.visible = false; apply(); }
  function animate(a, b, time) { fading = false; from = a; to = b; t0 = now; dur = Math.max(0.05, time); }
  return {
    object3d: group,
    get right() { return right; },
    get active() { return active; },
    get alpha() { return alpha; },
    get size() { return { x: w, y: h }; },
    paper,
    set cloudGlow(v) { mat.uniforms.uCloudGlow.value = v; },
    // where the text is, sized for the longest line (m), rolled up and hidden
    setup(textObject, lx, ly, hintText) {
      group.position.copy(textObject.position);
      group.quaternion.copy(textObject.quaternion);
      group.updateMatrixWorld(true);
      right.set(1, 0, 0).applyQuaternion(group.quaternion);
      w = lx + SCROLL.padding[0] * 2; h = ly + SCROLL.padding[1] * 2;
      paper.scale.set(w + SCROLL.margin * 2, h + SCROLL.margin * 2, 1);
      if (hintText) hint.setText(hintText);
      hint.setAlpha(0);
      hint.object3d.position.set(0, -(h * 0.5 + SCROLL.hintGap), 0);
      unroll = 0; alpha = 0; from = to = 0; t0 = -100; hintOn = false; fading = false;
      active = true; group.visible = true;
      apply();
    },
    open(time) { alpha = 1; animate(unroll, 1, time); hintStart = now + SCROLL.hintDelay; hintOn = true; },
    close(time) { hideHint(); animate(unroll, 0, time); },
    fade(time) { hideHint(); fadeFrom = alpha; fading = true; t0 = now; dur = Math.max(0.05, time); },
    hideHint, hideNow,
    update(dt) {
      now += dt;
      if (!active) return;
      const k = clamp01((now - t0) / dur), e = k * k * (3 - 2 * k);
      if (fading) { alpha = fadeFrom * (1 - e); if (k >= 1) { hideNow(); return; } }
      else if (t0 > -50) { unroll = from + (to - from) * e; if (k >= 1 && to <= 0) { hideNow(); return; } }
      if (hintOn && now >= hintStart) {
        const ht = now - hintStart;
        const ha = smoothStep(0, 1, ht / 0.8) * (0.85 + 0.15 * Math.cos(ht * Math.PI * 2 / 3)); // fades in, then breathes
        hint.setAlpha(SCROLL.hintAlpha * ha * alpha);
      }
      hint.update(dt);
      apply();
    },
  };
}

// IntroScroll.MakeFibers (512², R fibres, G blotches, B edge noise; tileable) and MakeCloud (256², one corner's cloud)
let scrollTex = null;
function scrollTextures() {
  if (scrollTex) return scrollTex;
  const fiber = makeFibers(512, 7), cloud = makeCloud(256);
  scrollTex = { fiber, cloud };
  return scrollTex;
}
function dataTexture(px, n, repeat) {
  const t = new THREE.DataTexture(px, n, n, THREE.RGBAFormat);
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 2;
  t.needsUpdate = true;
  return t;
}
function periodicNoise(n, cells, seed, amp, add) {
  const rng = new DotNetRandom(seed);
  const lat = new Float32Array(cells * cells);
  for (let i = 0; i < lat.length; i++) lat[i] = Math.fround(rng.nextDouble());
  const o = add ?? new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const fx = x / n * cells, fy = y / n * cells;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      let tx = fx - x0, ty = fy - y0;
      tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
      const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
      const a = lat[y0 * cells + x0] + (lat[y0 * cells + x1] - lat[y0 * cells + x0]) * tx;
      const b = lat[y1 * cells + x0] + (lat[y1 * cells + x1] - lat[y1 * cells + x0]) * tx;
      o[y * n + x] += (a + (b - a) * ty) * amp;
    }
  }
  return o;
}
function makeFibers(n, seed) {
  const rng = new DotNetRandom(seed);
  const r = () => Math.fround(rng.nextDouble());
  const fib = new Float32Array(n * n);
  for (let f = 0; f < 900; f++) {
    let x = r() * n, y = r() * n;
    let ang = (r() - 0.5) * (rng.nextDouble() < 0.8 ? 0.8 : 3.1);
    const len = 12 + r() * 60, bend = (r() - 0.5) * 0.04;
    const w = 0.25 + r() * 0.75;
    for (let s = 0; s < len; s += 0.5) {
      ang += bend;
      x += Math.cos(ang) * 0.5; y += Math.sin(ang) * 0.5;
      const ix = ((Math.trunc(x) % n) + n) % n, iy = ((Math.trunc(y) % n) + n) % n;
      fib[iy * n + ix] = Math.max(fib[iy * n + ix], w);
    }
  }
  const blotch = periodicNoise(n, 6, seed + 1, 0.6, periodicNoise(n, 14, seed + 2, 0.4, null));
  const edge = periodicNoise(n, 24, seed + 3, 0.65, periodicNoise(n, 64, seed + 4, 0.35, null));
  const px = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const x = i % n, row = i - x;
    const f = fib[i] * 0.6 + (fib[row + (x + 1) % n] + fib[row + (x + n - 1) % n]) * 0.2;
    px[i * 4] = Math.trunc(clamp01(f) * 255);
    px[i * 4 + 1] = Math.trunc(clamp01(blotch[i]) * 255);
    px[i * 4 + 2] = Math.trunc(clamp01(edge[i]) * 255);
    px[i * 4 + 3] = 255;
  }
  return dataTexture(px, n, true);
}
function makeCloud(n) {
  const px = new Float32Array(n * n);
  const th = 0.028;
  function stamp(cx0, cy0, w) {
    const r = Math.ceil((w + 0.01) * n);
    const cx = Math.trunc(cx0 * n), cy = Math.trunc(cy0 * n);
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const d = Math.hypot((x + 0.5) / n - cx0, (y + 0.5) / n - cy0);
        const v = 1 - smoothStep(w * 0.55, w, d); // as Unity wrote it: Mathf.SmoothStep(from, to, t) eases from..to by t = d
        if (v > px[y * n + x]) px[y * n + x] = v;
      }
    }
  }
  function spiral(cx, cy, r0, a0, turns, dir, w0) {
    const steps = Math.trunc(turns * 160);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, a = a0 + dir * t * turns * Math.PI * 2, rr = r0 * lerp(1, 0.18, t);
      stamp(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, w0 * lerp(1, 0.6, t));
    }
  }
  function curve(a, b, c, w0, w1) {
    for (let i = 0; i <= 200; i++) {
      const t = i / 200;
      const px0 = lerp(lerp(a[0], b[0], t), lerp(b[0], c[0], t), t), py0 = lerp(lerp(a[1], b[1], t), lerp(b[1], c[1], t), t);
      stamp(px0, py0, lerp(w0, w1, t));
    }
  }
  spiral(0.62, 0.6, 0.27, Math.PI * 1.5, 1.35, 1, th);
  spiral(0.3, 0.36, 0.16, Math.PI * 0.2, 1.2, -1, th * 0.85);
  curve([0.62, 0.33], [0.42, 0.12], [0.04, 0.1], th * 0.9, th * 0.3);
  curve([0.35, 0.6], [0.2, 0.82], [0.04, 0.8], th * 0.7, th * 0.25);
  const out = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) { const b = Math.trunc(clamp01(px[i]) * 255); out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = out[i * 4 + 3] = b; }
  return dataTexture(out, n, false);
}
