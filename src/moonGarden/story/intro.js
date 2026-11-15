// The intro, ported from the Unity team's `multiplayer` branch (MochiPound, Assets/_Project/World/Scripts):
//   StoryIntro.cs        about 13 s: the view fades in from black while faint stars drift upward around the player
//                        (a hint of coming down into the garden), and four story lines rise in and drift out one
//                        after another on a hanji scroll, world-fixed in front of the head. The Earth stays dark.
//   IntroScroll.cs       the hanji handscroll (Shaders/MR_HanjiScroll.shader; its fibre and cloud textures are drawn
//                        in code, as Unity does): it unrolls from the middle, the lines are written on it, and it
//                        rolls up after the last line (or fades at once on a skip). A small "Skip" hint under it.
//   PassthroughIntro.cs  "Take me to the Moon": in Unity the intro starts in the player's real room (passthrough) and
//                        a round portal opens around the usu onto the garden. Here the VR session is immersive-vr with
//                        no passthrough, so (VR only) the intro starts in a dark starry void with only the usu, the
//                        dough, the kine and the hands, and the same portal opens from the usu onto the garden as the
//                        intro ends (3.5 s; 1.4 s after a skip). Desktop gets the fade from black over the garden.
// It plays when the player first enters (desktop or VR), again when a VR session starts while it is playing (the
// lines must sit in front of the new head), and after every ending (MoonStory.Resetted).
// Skip (after the first 1.5 s, MoonProgress.skipGuardSeconds): E or Space or Enter on desktop, a controller's select
// or squeeze in VR, or an index-thumb pinch held 0.3 s. While the intro plays every use() press is taken by it, so
// nobody picks up the kine mid-story (Unity: MoonProgress.IntroActive). Values are the prefab's (MR_Environment).
import * as THREE from 'three';
import { DotNetRandom, linColor, smoothStep, clamp01, lerp } from '../unity.js';
import { createHalos } from '../halos.js';
import { createHanjiScroll } from './scroll.js';
import * as L from '../../layout.js';

const C = {
  lines: [
    "It's Chuseok, Earth's harvest moon festival…\nbut the Moon never rose.",
    'No wishes. No mochi. No festival.',
    'In the sky garden between Earth and Moon, the Moon Rabbits pick up the mallet.',
    '!Pound the mochi. Light the Moon.',
  ],
  holdTime: 2.2, blackFade: 2.5, wrapAt: 44, scrollOpenTime: 0.75, scrollCloseTime: 0.9,
  swellBrightColor: [1, 0.84, 0.47], instructionSwellScale: 1.2, instructionSwellTime: 1.8, maxRevealTime: 1.6,
  descentStars: 140, descentColor: [0.8, 0.86, 1],
  textDistance: 2.8, textAboveEyes: 0.25,
  skipGuard: 1.5, pinchHold: 0.3,
  // PassthroughIntro (the VR void)
  revealTime: 3.5, skipRevealTime: 1.4, edgeSoftness: 10, rimIntensity: 0.25,
};
// the narration style (prefab): Cinzel SemiBold in dark ink on the paper (MR_IntroInk: a thin warm-brown outline);
// the instruction part is Cinzel Black in moon gold at 120 % (StoryIntro.Emphasise with the instruction style)
const NARRATION = {
  font: 'cinzel', letterHeight: 0.1, color: [0.09, 0.09, 0.15], outlineColor: [0.13, 0.09, 0.06, 0.55],
  characterSpacing: 6, lineSpacing: 28, glowIntensity: 0.16, glow: false, rise: true, pulse: false, breathe: false,
  emphasisColor: [0.98, 0.77, 0.3], emphasisScale: 0.12 / 0.1, emphasisWeight: 900,
};

export async function createIntro(ctx) {
  const { scene, camera, renderer, garden } = ctx;
  if (!garden) return null;
  const textMod = await import('./text.js');
  // the fonts, before anything is measured (at most 4 s; the fallback fonts measure differently but work)
  await Promise.race([textMod.loadStoryFonts(), new Promise((r) => setTimeout(r, 4000))]);
  const sounds = ctx.sounds ?? {};
  const play = (name, ...args) => { try { sounds[name]?.(...args); } catch (err) { console.warn(`[intro] sounds.${name}`, err); } };

  // ---------------- the text and the scroll
  const text = textMod.createStoryText(NARRATION);
  text.object3d.name = 'MR_IntroText';
  scene.add(text.object3d);
  text.brightColor = C.swellBrightColor;
  const scroll = createHanjiScroll(textMod);
  scene.add(scroll.object3d);

  // ---------------- the fade (head-locked, inside of a small sphere, drawn over everything)
  const fadeMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 1, side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
  const fade = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), fadeMat);
  fade.name = 'MR_IntroFade';
  fade.renderOrder = 1000;
  fade.frustumCulled = false;
  fade.visible = false;
  camera.add(fade);
  let fadeA = 0;
  function setFade(a) { fadeA = a; fadeMat.opacity = a; fade.visible = a > 0.002; }

  // ---------------- the descent stars (world-fixed around where the player stands)
  const stars = createHalos(garden.haloTexture, Math.max(1, C.descentStars), 1);
  stars.billboards.name = 'MR_DescentStars';
  stars.billboards.visible = false;
  scene.add(stars.billboards);
  const starColor = linColor(new THREE.Color(), C.descentColor);
  const starPos = new Float32Array(C.descentStars * 3);
  let starAlpha = 0, starsOn = false;
  const head = new THREE.Vector3();
  function spawnStars() {
    camera.getWorldPosition(head);
    const rng = new DotNetRandom(5);
    for (let i = 0; i < C.descentStars; i++) {
      const a = Math.fround(rng.nextDouble()) * Math.PI * 2;
      const r = lerp(2.5, 9, Math.fround(rng.nextDouble()));
      const y = lerp(-4, 7, Math.fround(rng.nextDouble()));
      starPos[i * 3] = head.x + Math.cos(a) * r; starPos[i * 3 + 1] = head.y + y; starPos[i * 3 + 2] = head.z + Math.sin(a) * r;
    }
    starsOn = true;
  }
  function drawStars(dt) {
    if (!starsOn || starAlpha <= 0.001) {
      if (stars.billboards.visible) { stars.begin(); stars.end(); stars.billboards.visible = false; }
      return;
    }
    camera.getWorldPosition(head);
    stars.begin();
    for (let i = 0; i < C.descentStars; i++) {
      let y = starPos[i * 3 + 1] + 0.45 * dt; // slow: a hint of descent, not motion
      if (y > head.y + 7) y -= 11;
      starPos[i * 3 + 1] = y;
      const x = starPos[i * 3], z = starPos[i * 3 + 2];
      const edge = clamp01((head.y + 7 - y) / 2) * clamp01((y - head.y + 4) / 2);
      const d = Math.hypot(x - head.x, y - head.y, z - head.z);
      const tw = 0.7 + 0.3 * Math.sin(clock * 2.3 + i * 1.7);
      const s = d * 0.012 * tw * edge;
      stars.billboard(x, y, z, s, s, starColor, 0.6 * starAlpha);
    }
    stars.end();
    stars.billboards.visible = true;
  }

  // ---------------- the VR void and its portal (PassthroughIntro, without passthrough)
  const portal = createPortal(scene, garden);

  // ---------------- the intro (StoryIntro.Intro as a generator: each yield waits one frame)
  let clock = 0, dt = 0, routine = null, playing = false, skip = false, skipped = false, introStart = -100, guardFrom = -100;
  let instructionShowing = false, played = false, wasPlaying = false;

  function wrap(s) {
    if (s.length <= C.wrapAt || s.includes('\n')) return s; // a line with its own break is kept as written
    const mid = Math.floor(s.length / 2);
    let cut = -1;
    for (let d = 0; d < mid; d++) {
      if (mid + d < s.length && s[mid + d] === ' ') { cut = mid + d; break; }
      if (mid - d > 0 && s[mid - d] === ' ') { cut = mid - d; break; }
    }
    return cut < 0 ? s : s.slice(0, cut) + '\n' + s.slice(cut + 1);
  }
  // "[...]" (or a whole line starting with "!") is the instruction emphasis: { text, from, to } in the wrapped text
  function emphasise(line) {
    const raw = line.startsWith('!') ? `[${line.slice(1)}]` : line;
    const open = raw.indexOf('['), close = raw.indexOf(']');
    const t = wrap(raw.replace(/[[\]]/g, ''));
    if (open < 0 || close < open) return { text: t, from: -1, to: -1, instruction: false };
    return { text: t, from: open, to: close - 1, instruction: true };
  }

  function* intro() {
    playing = true;
    skip = false; skipped = false;
    introStart = clock; guardFrom = clock;
    garden.setEarthLight(0); // story.EarthBrightness = 0: the Earth stays dark until the ending
    setFade(1);
    if (renderer.xr.isPresenting) portal.enterRoom();
    spawnStars();
    yield; // let the head pose settle for a frame
    text.placeInFront(camera, C.textDistance, C.textAboveEyes);
    // one scroll size for the whole intro: the longest line (with the last line's swell)
    let lx = 0, ly = 0;
    for (const l of C.lines) {
      const e = emphasise(l);
      const m = text.measure(e.text, e.from, e.to);
      const k = e.instruction ? C.instructionSwellScale : 1;
      lx = Math.max(lx, m.x * k); ly = Math.max(ly, m.y * k);
    }
    scroll.setup(text.object3d, lx, ly, renderer.xr.isPresenting ? 'Skip' : 'Skip  ·  E');
    scroll.open(C.scrollOpenTime);
    play('playScrollUnroll', scroll.object3d.position, scroll.right, C.scrollOpenTime);

    introStart = clock;
    for (let idx = 0; idx < C.lines.length && !skip; idx++) {
      while (!skip && clock - introStart < 1) yield; // a second of stars before the first line
      if (skip) break;
      const e = emphasise(C.lines[idx]);
      text.maxReveal = C.maxRevealTime;
      text.bouncePeak = C.instructionSwellScale;
      text.bounceTime = C.instructionSwellTime;
      text.setText(e.text, e.from, e.to);
      instructionShowing = e.instruction;
      const at = text.object3d.position, right = scroll.right;
      play('playIntroLine', at, right, idx, e.text.replace(/\n/g, '').length, text.revealDuration);
      if (e.instruction) play('playSwell', at, right, text.emphasisDuration, text.revealDuration);
      text.setAlpha(1); // letters fade in themselves as they rise
      console.info(`[intro] line ${idx + 1}`);
      // reading time counts from when the whole line has risen
      const hold = text.revealDuration + text.emphasisDuration + (e.instruction ? C.holdTime + 0.6 : C.holdTime);
      let t = 0;
      while (!skip && t < hold) { t += dt; yield; }
      if (skip) break;
      text.beginExit();
      t = 0;
      const exit = text.exitDuration;
      while (!skip && t < exit) { t += dt; yield; }
      text.setAlpha(0);
    }

    // the scroll rolls up after the last line; a skip just fades it
    instructionShowing = false;
    if (scroll.active) {
      if (skip) scroll.fade(0.25);
      else {
        scroll.close(C.scrollCloseTime);
        play('playScrollClose', scroll.object3d.position, C.scrollCloseTime);
        let w = 0;
        while (!skip && w < C.scrollCloseTime) { w += dt; yield; }
        if (skip) scroll.fade(0.2);
      }
    }

    // end (or skipped): clear the text at once, fade out whatever else is showing
    if (skip) play('stopTextSounds');
    text.setAlpha(0);
    const a0 = fadeA, s0 = starAlpha;
    for (let a = 0; a < 0.35; a += dt) {
      const k = 1 - a / 0.35;
      setFade(a0 * k);
      starAlpha = s0 * k;
      yield;
    }
    setFade(0);
    starAlpha = 0;
    playing = false;
    routine = null;
    console.info(`[intro] done${skipped ? ' (skipped)' : ''}`);
  }

  function start(reason) {
    if (routine) routine.return?.();
    scroll.hideNow();
    instructionShowing = false;
    play('stopTextSounds');
    text.setAlpha(0);
    playing = false;
    played = true;
    console.info(`[intro] start (reason: ${reason})`);
    routine = intro();
    routine.next(); // its first frame now: the screen is black from this frame on
  }

  function requestSkip() {
    if (!playing || skip) return;
    if (clock - guardFrom < C.skipGuard) return; // no accidental skip from a press carried over from the launch
    skip = true; skipped = true;
    scroll.hideHint();
  }

  // Space / Enter on desktop (E arrives through use())
  addEventListener('keydown', (e) => {
    if (!playing || e.repeat) return;
    if (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') requestSkip();
  });
  renderer.xr.addEventListener('sessionend', () => portal.showGarden());

  // an index-thumb pinch held pinchHold s (this headset's own hands)
  let pinchSince = -1;
  function pinching() {
    for (const h of ctx.hands?.hands ?? []) {
      if (h.remote || !h.tracked) continue;
      const a = h.joints.get('thumb-tip'), b = h.joints.get('index-finger-tip');
      if (a && b && a.center.distanceTo(b.center) < 0.012 + a.r + b.r) return true;
    }
    return false;
  }

  // after every ending, as Unity's MoonStory.Resetted
  const ending = ctx.parts?.find?.((p) => p.name === 'ending');
  ending?.onReset?.(() => start('ending'));

  console.info('[intro] ready: the scroll story plays when you enter');
  return {
    enter(xr) {
      if (!played) start(xr ? 'launch (VR)' : 'launch');
      else if (xr && playing) start('VR session'); // the lines go in front of the new head
    },
    use() {
      if (!playing) return false;
      requestSkip();
      return true; // every press is the intro's while it plays
    },
    update(d, t) {
      dt = d; clock += d;
      if (playing) {
        const guard = clock - guardFrom < C.skipGuard;
        if (!pinching() || guard) pinchSince = -1;
        else if (pinchSince < 0) pinchSince = clock;
        if (pinchSince >= 0 && pinchSince !== Infinity && clock - pinchSince >= C.pinchHold) { pinchSince = Infinity; requestSkip(); }
      }
      if (routine) routine.next();
      // StoryIntro.LateUpdate: the black fade-in and the drifting stars on their own clock while the lines play
      scroll.cloudGlow = instructionShowing ? 0.45 + 1.3 * text.swellNow : 0;
      if (playing && !skip) {
        const k = clock - introStart;
        setFade(1 - smoothStep(0, 1, k / C.blackFade));
        starAlpha = clamp01(k / 1.5) * clamp01((7 - k) / 2);
      }
      text.update(d);
      scroll.update(d);
      drawStars(d);
      // PassthroughIntro.Update: the intro ended or was skipped: the portal opens
      if (!playing && wasPlaying && portal.inRoom) portal.open(skipped ? Math.min(C.revealTime, C.skipRevealTime) : C.revealTime);
      wasPlaying = playing;
      camera.getWorldPosition(head);
      portal.update(d, head);
    },
    get playing() { return playing; },
  };
}

// ======================================================================= the VR void and its portal
// The garden (its root, lights included) is hidden in the void, and two dim lights of the void's own light the
// usu, the dough and the kine. When the portal opens the garden comes back behind a sphere around the head (just
// beyond the usu): outside the portal it draws the void, inside it nothing, with a soft edge and a faint warm rim;
// it doesn't write depth and is depth-tested, so the usu, the dough, the kine and the hands, all nearer than it,
// stay in front. Unity does the same with stencil "keep" bubbles; here the sphere's radius does it.
function createPortal(scene, garden) {
  const lights = new THREE.Group();
  lights.name = 'MR_VoidLights';
  const hemi = new THREE.HemisphereLight(linColor(new THREE.Color(), [0.55, 0.62, 0.85]), linColor(new THREE.Color(), [0.08, 0.07, 0.1]), 0.9);
  const key = new THREE.DirectionalLight(linColor(new THREE.Color(), [0.85, 0.88, 1]), 1.4);
  key.position.set(-1.5, 4, 1.5);
  lights.add(hemi, key, key.target);
  lights.visible = false;
  scene.add(lights);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uHead: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3(0, 0, -1) },
      uRadius: { value: 0 }, uSoft: { value: C.edgeSoftness * Math.PI / 180 }, uRim: { value: 0 },
      uRimColor: { value: linColor(new THREE.Color(), [1, 0.85, 0.6]) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uHead, uDir, uRimColor;
      uniform float uRadius, uSoft, uRim;
      varying vec3 vW;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      void main() {
        vec3 d = normalize(vW - uHead);
        float ang = acos(clamp(dot(d, uDir), -1.0, 1.0));
        float veil = smoothstep(uRadius - uSoft, uRadius, ang);           // 1 = the void, 0 = the garden
        float rim = uRim * exp(-pow((ang - uRadius + uSoft * 0.5) / (uSoft * 0.5), 2.0));
        // the void: a deep night, a touch lighter above, with fixed faint stars
        vec3 col = mix(vec3(0.0015, 0.0018, 0.004), vec3(0.006, 0.008, 0.02), d.y * 0.5 + 0.5);
        vec3 p = d * 160.0, c = floor(p);
        float h = hash(c);
        if (h > 0.975) {
          vec3 o = c + 0.5 + (vec3(hash(c + 7.1), hash(c + 3.3), hash(c + 5.7)) - 0.5) * 0.6;
          float s = 1.0 - smoothstep(0.0, 0.32, length(p - o));
          col += vec3(0.75, 0.8, 1.0) * s * (h - 0.975) * 22.0;
        }
        gl_FragColor = vec4(col * veil + uRimColor * rim, veil);
        #include <colorspace_fragment>
      }`,
    transparent: true, premultipliedAlpha: true, depthWrite: false, side: THREE.BackSide, toneMapped: false,
  });
  mat.fog = false;
  const veil = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  veil.name = 'MR_PortalVeil';
  veil.renderOrder = 5; // after the garden's opaque world, before the glows (10), the scroll and the text (20+)
  veil.frustumCulled = false;
  veil.visible = false;
  scene.add(veil);

  const usu = new THREE.Vector3(L.USU.position[0], L.USU.height + 0.1, L.USU.position[2]);
  let state = 'garden', t0 = 0, openTime = 3.5, now = 0, bg = null;
  function setGardenShown(on) {
    garden.root.visible = on;
    lights.visible = !on;
    if (!on && !bg) { bg = scene.background; scene.background = new THREE.Color(0x000000); }
    if (on && bg) { scene.background = bg; bg = null; }
  }
  function setVeil(open, head) {
    const dist = head.distanceTo(usu);
    veil.position.copy(head);
    veil.scale.setScalar(THREE.MathUtils.clamp(dist + 0.6, 1.2, 4));
    mat.uniforms.uHead.value.copy(head);
    mat.uniforms.uDir.value.subVectors(usu, head).normalize();
    const soft = mat.uniforms.uSoft.value;
    mat.uniforms.uRadius.value = Math.pow(clamp01(open), 1.7) * (Math.PI + soft * 2); // slow at first, around the usu
    mat.uniforms.uRim.value = C.rimIntensity * Math.sin(clamp01(open) * Math.PI);
  }
  return {
    get inRoom() { return state === 'room' || state === 'opening'; },
    enterRoom() {
      if (state === 'room') return;
      setGardenShown(false);
      veil.visible = true; state = 'room';
      console.info('[intro] VR: the void');
    },
    open(time) {
      if (state !== 'room') return;
      setGardenShown(true);
      state = 'opening'; t0 = now; openTime = Math.max(0.2, time);
      console.info(`[intro] VR: the portal opens (${openTime.toFixed(1)} s)`);
    },
    showGarden() { setGardenShown(true); veil.visible = false; state = 'garden'; },
    update(dt, head) {
      now += dt;
      if (state === 'garden') return;
      let open = 0;
      if (state === 'opening') {
        const u = clamp01((now - t0) / openTime);
        open = u * u * (3 - 2 * u);
        if (u >= 1) { this.showGarden(); return; }
      }
      setVeil(open, head);
    },
  };
}
