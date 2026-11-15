// IntroScroll / MR_HanjiScroll: translucent hanji, torn edges, shaded rolls and gold cloud corners.
import * as THREE from 'three';

let fibers;
function fiberTexture() {
  if (fibers) return fibers;
  const n = 128, pixels = new Uint8Array(n * n * 4);
  let seed = 7;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < n * n; i++) {
    pixels[i * 4] = 80 + random() * 75; pixels[i * 4 + 1] = random() * 110;
    pixels[i * 4 + 2] = random() * 255; pixels[i * 4 + 3] = 255;
  }
  for (let f = 0; f < 450; f++) {
    let x = random() * n, y = random() * n;
    const slope = (random() - 0.5) * 0.3, length = 3 + random() * 22;
    for (let t = 0; t < length; t++) {
      pixels[(((Math.floor(y) + n) % n) * n + Math.floor(x) % n) * 4] = 210;
      x++; y += slope;
    }
  }
  fibers = new THREE.DataTexture(pixels, n, n);
  fibers.wrapS = fibers.wrapT = THREE.RepeatWrapping;
  fibers.magFilter = fibers.minFilter = THREE.LinearFilter; fibers.needsUpdate = true;
  return fibers;
}

export function createScroll({ width = 1.6, height = 0.4, opacity = 0.62, overlay = false } = {}) {
  const object3d = new THREE.Group(); object3d.name = 'MR_HanjiScroll'; object3d.visible = false;
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, depthTest: !overlay, side: THREE.DoubleSide,
    uniforms: {
      fibers: { value: fiberTexture() }, size: { value: new THREE.Vector2(width, height) },
      unroll: { value: 0 }, alpha: { value: 0 }, opacity: { value: opacity }, cloudGlow: { value: 0 },
    },
    vertexShader: /* glsl */ `varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D fibers;
      uniform vec2 size;
      uniform float unroll, alpha, opacity, cloudGlow;
      varying vec2 vUv;
      void main() {
        vec2 p = (vUv - 0.5) * (size + 0.1);
        float roll = mix(0.022, 0.0066, unroll);
        float hw = max(size.x * 0.5 * unroll, roll), hh = size.y * 0.5;
        vec2 ap = abs(p);
        vec3 f = texture2D(fibers, p * 1.6).rgb;
        float tear = (texture2D(fibers, p * 3.1 + vec2(0.0, 0.37)).b - 0.5) * 0.012;
        float mask = smoothstep(0.0, 0.0088, min(hw - ap.x, hh - ap.y) + tear);
        vec3 paper = vec3(0.97, 0.93, 0.82);
        vec3 col = paper * (0.93 + 0.1 * f.r) - f.g * 0.05;
        float a = opacity * (0.88 + 0.24 * f.r) * mask;
        float curl = step(hh - 0.012, ap.y) * step(ap.y, hh + 0.003) * step(ap.x, hw);
        col = mix(col, paper * (0.62 + 0.3 * sin(clamp((ap.y - hh + 0.012) / 0.012, 0.0, 1.0) * 3.14159)), curl);
        a = mix(a, 0.9, curl);
        float tr = (ap.x - hw + roll) / (2.0 * roll);
        float inRoll = step(0.0, tr) * step(tr, 1.0) * step(ap.y, hh + 0.003);
        col = mix(col, paper * (0.55 + 0.4 * sin(clamp(tr, 0.0, 1.0) * 3.14159)), inRoll);
        a = mix(a, 0.95, inRoll);
        float cs = min(0.13, size.y * 0.42);
        vec2 c = (ap - vec2(hw - roll * 2.0 - 0.012 - cs, hh - 0.02 - cs)) / cs;
        float d = min(abs(length(c - vec2(0.3, 0.35)) - 0.22), abs(length(c - vec2(0.62, 0.43)) - 0.3));
        float cloud = (1.0 - smoothstep(0.015, 0.055, d)) * step(0.0, c.x) * step(c.x, 1.0) * step(0.0, c.y) * step(c.y, 1.0);
        cloud *= smoothstep(0.82, 1.0, unroll) * (1.0 - inRoll) * mask;
        col = mix(col, vec3(0.86, 0.66, 0.3) * (0.85 + 0.6 * cloudGlow), cloud * 0.9);
        gl_FragColor = vec4(col, max(a, cloud * 0.92) * alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width + 0.1, height + 0.1), material);
  mesh.renderOrder = overlay ? 30 : 12; object3d.add(mesh);
  let amount = 0, alpha = 0, from = 0, target = 0, age = 0, duration = 1, fading = false, fadeFrom = 0;
  const animate = (to, time) => { from = amount; target = to; age = 0; duration = Math.max(0.05, time); fading = false; };
  return {
    object3d,
    open(time = 0.75) { alpha = 1; object3d.visible = true; animate(1, time); },
    close(time = 0.9) { animate(0, time); },
    fade(time = 0.25) { fading = true; age = 0; duration = time; fadeFrom = alpha; },
    hide() { alpha = 0; amount = 0; object3d.visible = false; },
    set glow(v) { material.uniforms.cloudGlow.value = v; },
    get amount() { return amount; },
    get alpha() { return alpha; },
    update(dt) {
      if (!object3d.visible) return;
      age += dt;
      const t = THREE.MathUtils.clamp(age / duration, 0, 1), e = t * t * (3 - 2 * t);
      if (fading) alpha = fadeFrom * (1 - e); else amount = THREE.MathUtils.lerp(from, target, e);
      material.uniforms.unroll.value = amount; material.uniforms.alpha.value = alpha;
      if (t >= 1 && (alpha <= 0 || amount <= 0)) object3d.visible = false;
    },
    dispose() { object3d.removeFromParent(); mesh.geometry.dispose(); material.dispose(); },
  };
}
