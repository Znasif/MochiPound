// StoryIntro + IntroScroll + PassthroughIntro. immersive-vr has no room passthrough, so the
// garden opens out of a starry void instead. The head never moves as part of the story.
import * as THREE from 'three';
import { createStoryText } from './text.js';
import { createScroll } from './scroll.js';

export const INTRO_LINES = [
  "It's Chuseok, Earth's harvest moon festival…\nbut the Moon never rose.",
  'No wishes. No mochi. No festival.',
  'In the sky garden between Earth and Moon, the Moon Rabbits pick up the mallet.',
  '!Pound the mochi. Light the Moon.',
];
function wrap(text) {
  if (text.length <= 44 || text.includes('\n')) return text;
  const mid = Math.floor(text.length / 2);
  for (let d = 0; d < mid; d++) for (const i of [mid + d, mid - d]) {
    if (text[i] === ' ') return `${text.slice(0, i)}\n${text.slice(i + 1)}`;
  }
  return text;
}

export function createIntro(ctx) {
  const { scene, camera, renderer, garden, sounds, flow } = ctx;
  const text = createStoryText({ halo: false }); scene.add(text.object3d);
  const size = new THREE.Vector2();
  for (const raw of INTRO_LINES) {
    const instruction = raw.startsWith('!'), line = wrap(instruction ? raw.slice(1) : raw);
    const measured = text.measure(line, instruction ? 0 : -1);
    if (instruction) measured.multiplyScalar(1.2);
    size.max(measured);
  }
  const scroll = createScroll({ width: size.x + 0.34, height: size.y + 0.2, overlay: true });
  scene.add(scroll.object3d);
  const hint = createStoryText({ letterHeight: 0.034, color: [0.93, 0.88, 0.76], rise: false, halo: false });
  scroll.object3d.add(hint.object3d); hint.object3d.position.set(0, -size.y / 2 - 0.18, 0.005);
  const veilMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthTest: false, depthWrite: false,
    uniforms: { open: { value: 0 }, black: { value: 1 }, clock: { value: 0 }, centre: { value: new THREE.Vector3(0, 0.8, 0) } },
    vertexShader: /* glsl */ `varying vec3 vWorld;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform float open, black, clock;
      uniform vec3 centre;
      varying vec3 vWorld;
      float hash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.yzx + 33.33); return fract((p.x + p.y) * p.z); }
      void main() {
        vec3 d = normalize(vWorld - cameraPosition);
        float angle = acos(clamp(dot(d, normalize(centre - cameraPosition)), -1.0, 1.0));
        float radius = pow(open, 1.7) * 3.5;
        float cover = 1.0 - smoothstep(radius - 0.1745, radius + 0.1745, angle);
        cover *= step(0.001, open);
        vec3 grid = d * 220.0 + vec3(0.0, -clock * 0.45, 0.0);
        vec3 cell = floor(grid);
        float star = step(0.997, hash(cell)) * pow(max(0.0, 1.0 - length(fract(grid) - 0.5) * 2.0), 3.0);
        float twinkle = 0.7 + 0.3 * sin(clock * 2.3 + hash(cell) * 20.0);
        vec3 sky = vec3(0.003, 0.005, 0.016) + vec3(0.65, 0.76, 1.0) * star * twinkle * 3.0;
        float rim = exp(-pow((angle - radius) / 0.1745, 2.0) * 4.0) * 0.25 * sin(open * 3.14159);
        gl_FragColor = vec4(sky * (1.0 - black) + vec3(1.0, 0.76, 0.4) * rim, 1.0 - cover);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const veil = new THREE.Mesh(new THREE.SphereGeometry(20, 40, 24), veilMat);
  veil.name = 'MR_IntroPortal'; veil.renderOrder = 20; veil.frustumCulled = false; veil.visible = false; scene.add(veil);
  let active = false, started = false, wasXR = false, stage = 'idle', age = 0, total = 0, index = -1, hold = 0, skipped = false;
  let pinchHeld = 0, pinchLatched = false;
  const head = new THREE.Vector3(), right = new THREE.Vector3();

  function sound(name, ...args) { sounds[name]?.(...args); }
  function begin(xr = renderer.xr.isPresenting) {
    started = true; wasXR = xr; active = true; flow.introActive = true;
    ctx.station.setStoryBlocked?.(true);
    stage = 'settle'; age = total = 0; index = -1; skipped = false; pinchHeld = 0; pinchLatched = false;
    sound('stopTextSounds'); text.setAlpha(0); hint.setAlpha(0); scroll.hide();
    garden.setEarthLight(0); veil.visible = true; veilMat.uniforms.open.value = 0; veilMat.uniforms.black.value = 1;
    if (ctx.music.playing) ctx.music.pause();
    console.info('[intro] starting in the starry void');
  }
  function showLine() {
    index++;
    if (index >= INTRO_LINES.length) {
      stage = 'close'; age = 0; text.setAlpha(0); hint.setAlpha(0); scroll.close(0.9);
      sound('playScrollClose', scroll.object3d.position, 0.9); return;
    }
    const raw = INTRO_LINES[index], instruction = raw.startsWith('!');
    const line = wrap(instruction ? raw.slice(1) : raw);
    text.setText(line, instruction ? 0 : -1); text.setAlpha(1);
    hold = text.revealDuration + text.emphasisDuration + (instruction ? 2.8 : 2.2);
    stage = 'line'; age = 0;
    right.set(1, 0, 0).applyQuaternion(text.object3d.quaternion);
    sound('playIntroLine', text.object3d.position, right, index, line.length, text.revealDuration);
    if (instruction) sound('playSwell', text.object3d.position, right, text.emphasisDuration, text.revealDuration);
  }
  function reveal(skip = false) {
    skipped = skip; stage = 'portal'; age = 0; text.setAlpha(0); hint.setAlpha(0);
    if (skip) { scroll.fade(0.25); sound('stopTextSounds'); }
  }
  function skip() { if (!active) return false; if (stage !== 'portal') reveal(true); return true; }
  const onKey = (event) => {
    if (!active || !ctx.entered || renderer.xr.isPresenting || event.repeat || !['Space', 'Enter', 'KeyE'].includes(event.code)) return;
    event.preventDefault(); event.stopImmediatePropagation(); skip();
  };
  addEventListener('keydown', onKey, true);

  function update(dt) {
    if (!active || !ctx.entered) return;
    age += dt; total += dt;
    camera.getWorldPosition(head); veil.position.copy(head);
    veilMat.uniforms.clock.value = total;
    veilMat.uniforms.black.value = 1 - THREE.MathUtils.smoothstep(total, 0, 2.5);
    if (stage === 'settle') {
      text.placeInFront(camera, 2.8, 0.25);
      scroll.object3d.position.copy(text.object3d.position); scroll.object3d.quaternion.copy(text.object3d.quaternion);
      // Keep a long narration readable without changing the metre-calibrated letter animation.
      const scale = Math.min(1, 3.7 / (size.x + 0.34));
      text.object3d.scale.setScalar(scale); scroll.object3d.scale.setScalar(scale);
      hint.setText(wasXR ? 'Select or hold a pinch to skip' : 'Space / Enter / E to skip');
      scroll.open(0.75); right.set(1, 0, 0).applyQuaternion(scroll.object3d.quaternion);
      sound('playScrollUnroll', scroll.object3d.position, right, 0.75);
      stage = 'wait'; age = 0;
    } else if (stage === 'wait' && age >= 1) showLine();
    else if (stage === 'line' && age >= hold) { text.beginExit(); stage = 'exit'; age = 0; }
    else if (stage === 'exit' && age >= text.exitDuration) showLine();
    else if (stage === 'close' && age >= 0.9) reveal();
    else if (stage === 'portal') {
      const t = THREE.MathUtils.clamp(age / (skipped ? 1.4 : 3.5), 0, 1);
      veilMat.uniforms.open.value = t * t * (3 - 2 * t);
      if (t >= 1) {
        active = false; flow.introActive = false; stage = 'idle'; veil.visible = false;
        scroll.hide(); hint.setAlpha(0); garden.setEarthLight(1);
        ctx.station.setStoryBlocked?.(false); ctx.resumeMusic?.();
        console.info(`[intro] ${skipped ? 'skipped; ' : ''}portal open`);
      }
    }
    text.update(dt); hint.update(dt); scroll.update(dt);
    scroll.glow = index === INTRO_LINES.length - 1 ? 0.45 + 1.3 * text.swellNow : 0;
    if (stage !== 'close' && stage !== 'portal' && total > 1) hint.setAlpha(Math.min(0.62, (total - 1) / 1.2));
    if (renderer.xr.isPresenting) {
      const pinching = ctx.hands.hands.some((h) => {
        if (h.remote || !h.tracked) return false;
        const a = h.joints.get('thumb-tip'), b = h.joints.get('index-finger-tip');
        return a && b && a.center.distanceTo(b.center) < 0.025;
      });
      if (!pinching) { pinchHeld = 0; pinchLatched = false; }
      else if (!pinchLatched) { pinchHeld += dt; if (pinchHeld >= 0.35) { pinchLatched = true; skip(); } }
    }
  }
  return {
    enter(xr) { if (!started || (xr && !wasXR)) begin(xr); },
    restart() { begin(); }, use: skip, update,
    get active() { return active; },
    get reveal() { return active ? (stage === 'portal' ? veilMat.uniforms.open.value : 0) : 1; },
    dispose() { removeEventListener('keydown', onKey, true); ctx.station.setStoryBlocked?.(false); text.dispose(); hint.dispose(); scroll.dispose(); veil.removeFromParent(); veil.geometry.dispose(); veilMat.dispose(); },
  };
}
