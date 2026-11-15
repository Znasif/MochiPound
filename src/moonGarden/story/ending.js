// MoonStory's ending, ported from the Unity team's `multiplayer` branch (MochiPound,
// Assets/_Project/World/Scripts/MoonStory.cs: Ending(), EarthGlowPulse(), DrawTrail(), DrawEarthLights(),
// DrawWishes(), OrbLook(), EnsureOrb(); the orb is Shaders/MR_MochiOrb.shader with MR_MochiOrb.mat's values, the
// glows MR_Glow.shader on MR_Halo.png). Values are the prefab's (MR_Environment.prefab, MoonStory).
//
// When the batch is done the station calls begin(from) (1.2 s after the last strike, the simulated dough cleared;
// `from` is its centre) and waits for `done` before the next batch:
//   rise    1.2 s   the mochi (a soft warm-white ball) rises 0.5 m out of the usu, leaving a sparkling trail
//   flight  3.6 s   a long curve out over the garden and up into the Earth (sounds.playFlight); it shrinks and
//                   melts into light as it arrives
//   arrival         the Earth swells with light (0.6 s; a dark Earth wakes up), sparks burst far out from it and a
//                   wide soft flare (3.6 s), then it settles to a warm glow and its 36 city lights come on one
//                   after another over 2.5 s (sounds.playArrival, playFireworkFar)
//   wishes  3.2 s   from 0.8 s after the arrival, 30 warm wish lights rise from the Earth toward the Moon over 7 s
//                   (sounds.playWishes); the text follows once they are on their way
//   text            "Happy Chuseok, Earth!" 2.8 m in front of the head at eye level, fading in over 1.2 s, held
//                   until 12 s after the last strike (at least 3 s), fading out over its last second
//                   (sounds.playEndingText)
//   reset           done: the station starts the next batch (its progress 0 dims the garden again); the Earth's
//                   glow and city lights fade out over 1.5 s and its brightness returns to what it was before the
//                   ending; the wish lights finish rising
// Unity's moonFollowsProgress is 1 (the settings asset), so the Moon is the garden's (setProgress) throughout.
// Everything is drawn in Unity's frame under garden.unity, as MoonStory computed it. Per frame: one instanced draw
// of camera-facing glows (trail, burst, flare, wishes, the orb's halo; the city lights are the garden's), the
// orb during the flight, the text while it shows; nothing is allocated.
import * as THREE from 'three';
import { createHalos } from '../halos.js';
import { linColor, lerp, smoothStep, clamp01 } from '../unity.js';
import { createEndingText } from './endingText.js';

const C = {
  orbRadius: 0.085, orbMinAngularRadius: 0.022, riseTime: 1.2, flyTime: 3.6, trailLength: 48, trailLife: 0.9,
  endingDuration: 12, wishCount: 30, wishRiseTime: 7, wishWait: 3.2, burstLife: 3.6, burstCount: 64,
  endingText: 'Happy Chuseok, Earth!', textDistance: 2.8, endingAboveEyes: 0,
  // the station's wait between the last strike (Unity's t0, OnComplete) and begin()
  stationDelay: 1.2,
};
const GOLDEN = 2.399963;
const UP = new THREE.Vector3(0, 1, 0);

export async function createEnding(ctx) {
  const { station, garden, camera, scene } = ctx;
  if (!station?.setEnding || !garden?.unity || !garden.earth) return null;
  const sounds = ctx.sounds ?? {};
  const textMod = await import('./text.js').catch((err) => { console.warn('[ending] text.js unavailable, using the canvas text', err?.message); return null; });

  // ---------------- drawing: the orb (MoonRabbit/MochiOrb) and one instanced glow draw (MoonRabbit/Glow)
  let haloTex = garden.haloTexture;
  if (!haloTex) {
    haloTex = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}env/MR_Halo.png`);
    haloTex.colorSpace = THREE.SRGBColorSpace;
  }
  const glows = createHalos(haloTex, 160, 1);
  glows.billboards.name = 'MR_EndingGlows';
  glows.billboards.visible = false;
  garden.unity.add(glows.billboards);

  const orbMat = createOrbMaterial();
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.5, 24, 16), orbMat); // Unity's built-in sphere: diameter 1
  orb.name = 'MR_MochiOrb';
  orb.visible = false;
  orb.renderOrder = 5;
  garden.unity.add(orb);

  const col = (c) => linColor(new THREE.Color(), c);
  const orbGlowColor = col([1, 0.93, 0.8]), trailColor = col([1, 0.86, 0.62]), flareColor = col([1, 0.9, 0.7]), wishColor = col([1, 0.74, 0.42]);

  // ---------------- state (Unity frame unless named ...W)
  const earthU = garden.earth.positionU, moonU = garden.moon?.positionU ?? earthU.clone().add(new THREE.Vector3(0, 40, 0));
  const R = garden.earth.radius;
  const camW = new THREE.Vector3(), camU = new THREE.Vector3();
  const start = new THREE.Vector3(), risen = new THREE.Vector3(), c1 = new THREE.Vector3(), c2 = new THREE.Vector3(), to = new THREE.Vector3();
  const pos = new THREE.Vector3(), tmp = new THREE.Vector3();
  const toCam = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(), goal = new THREE.Vector3(), p0 = new THREE.Vector3();
  const trailPos = new Float32Array(C.trailLength * 3), trailTime = new Float32Array(C.trailLength);
  let trailHead = 0, trailCount = 0, trailUntil = -1;
  let clock = 0, burstStart = -10, wishStart = -100;
  let running = false, done = true, stage = 'idle', st = 0, t0 = 0, shown = 0, hold = 0, orbR = 0;
  // the Earth: brightness (EarthBrightness), pulse (EarthPulse), city (cityOn); written to the garden while owned
  // (fresh: a step that started this frame has already run its first body, as a Unity coroutine does)
  const earth = { b0: 1, bright: 1, pulse: 0, city: 0, owner: false, fresh: false, swell: 0, swellA: 0, loopT: 0, fading: false, fadeA: 0, fromB: 1, fromP: 0, fromC: 0, wB: NaN, wP: NaN, wC: NaN };
  const resetFns = [];
  let text = null, textAlpha = 0;

  // ---------------- the text (text.js's StoryText, else the canvas stand-in)
  function ensureText() {
    if (text) return;
    const style = {
      font: 'baloo', letterHeight: 0.28, color: [1, 0.96, 0.88], halo: false,
      // the rest of MoonStory.endingStyle, for a text.js that reads them
      characterSpacing: 2, glowColor: [1, 0.76, 0.4], glowIntensity: 0.6, rise: false, breathe: true, pulse: false,
    };
    try {
      const t = textMod?.createStoryText?.(style);
      if (t && t.object3d && typeof t.setText === 'function' && typeof t.setAlpha === 'function' && typeof t.placeInFront === 'function') text = t;
    } catch (err) { console.warn('[ending] createStoryText failed, using the canvas text', err); }
    if (!text) text = createEndingText(style);
    if (!text.object3d.parent) scene.add(text.object3d);
    text.setAlpha(0);
  }

  // ---------------- helpers
  function pushTrail(p) {
    const i = trailHead * 3;
    trailPos[i] = p.x; trailPos[i + 1] = p.y; trailPos[i + 2] = p.z;
    trailTime[trailHead] = clock;
    trailHead = (trailHead + 1) % C.trailLength;
    trailCount = Math.min(trailCount + 1, C.trailLength);
  }
  // the orb keeps at least a small angular size as it flies away
  function orbLook(grow, shrink) {
    const dist = camU.distanceTo(pos);
    orbR = Math.max(C.orbRadius * grow, dist * C.orbMinAngularRadius) * shrink;
    orb.position.copy(pos);
    orb.scale.setScalar(orbR * 2);
  }
  function bezier(a, b, c, d, t, out) {
    const u = 1 - t, k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
    return out.set(a.x * k0 + b.x * k1 + c.x * k2 + d.x * k3, a.y * k0 + b.y * k1 + c.y * k2 + d.y * k3, a.z * k0 + b.z * k1 + c.z * k2 + d.z * k3);
  }
  const earthW = () => garden.earth.position.clone(); // for the sounds (one-off calls)
  function play(name, at) { try { sounds[name]?.(at); } catch (err) { console.warn(`[ending] sounds.${name}`, err); } }
  // the view basis on the Earth: toward the viewer, its right (Unity's Cross(up, toCam)) and up
  function earthBasis(c) {
    toCam.subVectors(camU, c).normalize();
    right.crossVectors(UP, toCam).normalize();
    up.crossVectors(toCam, right);
  }

  // ---------------- the sequence (MoonStory.Ending)
  function begin(from) {
    camera.getWorldPosition(camW);
    garden.toUnity(camW, camU);
    running = true; done = false; stage = 'rise'; st = 0;
    t0 = clock - C.stationDelay;
    garden.toUnity(from, start).y += 0.02;
    risen.copy(start).y += 0.5;
    trailCount = 0; trailHead = 0; trailUntil = Infinity;
    earth.fading = false; earth.swell = 0; earth.owner = false;
    earth.b0 = garden.earthLight?.bright ?? 1; // what the intro left (dark, or the built look)
    orbMat.uniforms.uGlow.value = 0.06;
    pos.copy(start);
    orbLook(0.75, 1);
    orb.visible = true;
    ensureText();
    draw();
  }

  function riseBody() {
    const u = clamp01(st / C.riseTime), e = 1 - (1 - u) * (1 - u);
    pos.lerpVectors(start, risen, e).y += 0.015 * Math.sin(u * Math.PI * 2);
    orbLook(lerp(0.75, 1, e), 1);
    pushTrail(pos);
  }
  function enterFly() {
    stage = 'fly'; st = 0;
    play('playFlight', earthW());
    to.subVectors(earthU, risen);
    tmp.set(to.x, 0, to.z).normalize(); // flat
    c1.copy(risen).addScaledVector(UP, 2.2).addScaledVector(tmp, 4);
    c2.copy(earthU).addScaledVector(to, -0.4).addScaledVector(UP, -15);
  }
  function flyBody() {
    const u = clamp01(st / C.flyTime), e = u * u * (3 - 2 * u);
    bezier(risen, c1, c2, earthU, e, pos);
    orbLook(1, lerp(1, 0.3, e * e * e));
    orbMat.uniforms.uGlow.value = lerp(0.06, 0.8, e * e); // melts into light as it reaches the Earth
    pushTrail(pos);
  }
  function arrive() {
    orb.visible = false;
    trailUntil = clock + 1;
    play('playArrival', earthW());
    play('playFireworkFar', earthW());
    burstStart = clock;
    // EarthGlowPulse: a soft swell (no white flash), the dark Earth wakes up, then a warm glow and the city lights
    earth.owner = true; earth.fresh = true; earth.swell = 1; earth.swellA = 0; earth.fading = false; earth.wB = NaN;
    swellBody();
    // no afterEarthLit step in the Unity build: the wishes, and the text once they are on their way
    wishStart = clock + 0.8;
    play('playWishes', earthW());
    stage = 'wishes'; st = 0;
  }
  function showText() {
    stage = 'text';
    ensureText();
    try {
      text.placeInFront(camera, C.textDistance, C.endingAboveEyes);
      text.setText(C.endingText);
      play('playEndingText', text.object3d.getWorldPosition(new THREE.Vector3()));
    } catch (err) { console.warn('[ending] text', err); }
    shown = clock;
    hold = Math.max(3, C.endingDuration - (shown - t0));
    setTextAlpha(0); // the fade-in starts from 0 this frame
  }
  function setTextAlpha(a) {
    textAlpha = a;
    try { text?.setAlpha(a); } catch (err) { /* logged once by the story layer */ }
  }
  function finish() {
    // reset for the next batch
    setTextAlpha(0);
    running = false; stage = 'idle'; done = true;
    earth.swell = 0; // InEnding is off: EarthGlowPulse ends
    earth.fading = true; earth.fresh = true; earth.fadeA = 0; earth.fromB = earth.bright; earth.fromP = earth.pulse; earth.fromC = earth.city;
    fadeBody();
    console.info('[ending] story reset (reason: ending)');
    for (const fn of resetFns) { try { fn(); } catch (err) { console.error('[ending] onReset', err); } }
  }

  function step(dt) {
    if (stage === 'rise') {
      if (st < C.riseTime) { st += dt; riseBody(); return; }
      enterFly();
    }
    if (stage === 'fly') {
      if (st < C.flyTime) { st += dt; flyBody(); return; }
      arrive();
      return;
    }
    if (stage === 'wishes') {
      st += dt;
      if (st < C.wishWait) return;
      showText();
      return;
    }
    if (stage === 'text') {
      const a = clock - shown;
      if (a < hold) setTextAlpha(clamp01(a / 1.2) * clamp01((hold - a) / 1));
      else finish();
    }
  }

  // ---------------- the Earth (EarthGlowPulse, then the Fade()s of the reset)
  function swellBody() {
    if (earth.swell === 1) {
      if (earth.swellA < 0.6) {
        earth.pulse = smoothStep(0, 1, earth.swellA / 0.6);
        earth.bright = lerp(earth.b0, 1, earth.swellA / 0.6);
        return;
      }
      earth.bright = 1; earth.swell = 2; earth.loopT = 0;
    }
  }
  function fadeBody() {
    const k = earth.fadeA / 1.5;
    earth.city = smoothStep(earth.fromC, 0, k);
    earth.pulse = smoothStep(earth.fromP, 0, k);
    earth.bright = smoothStep(earth.fromB, earth.b0, k);
  }
  function earthStep(dt) {
    const fresh = earth.fresh;
    earth.fresh = false;
    if (earth.swell === 1 && !fresh) { earth.swellA += dt; swellBody(); }
    if (earth.swell === 2) {
      earth.loopT += dt;
      earth.pulse = lerp(0.45, 1, Math.exp(-earth.loopT * 0.9)) + 0.05 * Math.sin(earth.loopT * 2.2);
      earth.city = clamp01(earth.loopT / 2.5);
    }
    if (earth.fading && !fresh) {
      earth.fadeA += dt;
      if (earth.fadeA < 1.5) fadeBody();
      else { earth.city = 0; earth.pulse = 0; earth.bright = earth.b0; earth.fading = false; }
    }
    if (!earth.owner) return;
    // after the reset, someone else setting the Earth (an intro restarting) makes it theirs again; during the
    // ending the ending's sequence wins
    const L = garden.earthLight;
    if (L && !running && !Number.isNaN(earth.wB) && (L.bright !== earth.wB || L.pulse !== earth.wP || L.city !== earth.wC)) {
      earth.owner = false; earth.fading = false; earth.wB = NaN;
      return;
    }
    garden.setEarthLight(earth.bright, earth.pulse, earth.city);
    if (L) { earth.wB = L.bright; earth.wP = L.pulse; earth.wC = L.city; }
    if (!earth.fading && !running) { earth.owner = false; earth.wB = NaN; }
  }

  // ---------------- the glows (DrawTrail, the burst of DrawEarthLights, DrawWishes, the orb's halo)
  function draw() {
    glows.begin();
    if (orb.visible) glows.billboard(pos.x, pos.y, pos.z, orbR * 4.4, orbR * 4.4, orbGlowColor, 0.18);
    if (trailCount > 0 && clock <= trailUntil) {
      for (let i = 0; i < trailCount; i++) {
        const idx = (trailHead - 1 - i + C.trailLength) % C.trailLength;
        const life = clamp01(1 - (clock - trailTime[idx]) / C.trailLife);
        if (life <= 0) continue;
        const x = trailPos[idx * 3], y = trailPos[idx * 3 + 1], z = trailPos[idx * 3 + 2];
        const dist = Math.hypot(camU.x - x, camU.y - y, camU.z - z);
        const tw = 0.75 + 0.25 * Math.sin(clock * 23 + idx * 1.7); // sparkle
        const s = Math.max(0.05, dist * 0.012) * life * tw;
        glows.billboard(x, y, z, s, s, trailColor, 0.8);
      }
    }
    const age = clock - burstStart;
    if (age < C.burstLife) {
      // arrival burst: sparks fly far out from the Earth, slowing as they go, and fade slowly; a wide soft flare
      earthBasis(earthU);
      const u = age / C.burstLife, life = 1 - u, spread = 1 - life * life * life;
      const si = 1.9 * Math.pow(life, 0.6), ss = R * 1.15 * Math.pow(life, 0.45), droop = R * 0.8 * u * u;
      for (let i = 0; i < C.burstCount; i++) {
        const ang = i * GOLDEN, reach = 0.55 + 0.45 * ((i * 37) % 11) / 10, rr = R * (1.1 + 7.5 * spread * reach);
        const ca = Math.cos(ang) * rr, sa = Math.sin(ang) * rr;
        const tw = 0.65 + 0.35 * Math.sin(clock * 17 + i * 1.3);
        glows.billboard(earthU.x + right.x * ca + up.x * sa + toCam.x * R, earthU.y + right.y * ca + up.y * sa + toCam.y * R - droop,
          earthU.z + right.z * ca + up.z * sa + toCam.z * R, ss * tw, ss * tw, trailColor, si);
      }
      const flare = clamp01(age / 0.25) * Math.pow(life, 0.9), fs = R * (6 + 10 * spread);
      glows.billboard(earthU.x + toCam.x * R * 1.2, earthU.y + toCam.y * R * 1.2, earthU.z + toCam.z * R * 1.2, fs, fs, flareColor, 0.9 * flare);
    }
    const wt = clock - wishStart, wEnd = C.wishRiseTime + 2.5;
    if (wt >= 0 && wt <= wEnd) {
      // wishes: each leaves a point on the Earth's disc a little after the previous one, drifting up and toward
      // the Moon, spreading out like lanterns on the wind
      earthBasis(earthU);
      const n = C.wishCount;
      for (let i = 0; i < n; i++) {
        const ti = wt - 1.6 * i / n;
        if (ti <= 0) continue;
        const u = clamp01(ti / C.wishRiseTime);
        const ang = i * GOLDEN, rr = Math.sqrt((i + 0.5) / n) * 0.9 * R;
        p0.copy(earthU).addScaledVector(right, Math.cos(ang) * rr).addScaledVector(up, Math.sin(ang) * rr).addScaledVector(toCam, R);
        goal.lerpVectors(earthU, moonU, 0.55).addScaledVector(UP, 18 + 10 * Math.sin(i * 1.3)).addScaledVector(right, ((i % 7) - 3) * 4);
        const ease = 1 - (1 - u) * (1 - u);
        tmp.lerpVectors(p0, goal, ease).addScaledVector(right, Math.sin(ti * 1.1 + i) * 0.8);
        const d = camU.distanceTo(tmp);
        const fade = clamp01(ti / 0.6) * clamp01((wEnd - ti - 1.6 * i / n) / 1.5);
        const tw = 0.75 + 0.25 * Math.sin(clock * 4.1 + i * 2.7), s = d * 0.026 * fade * tw;
        glows.billboard(tmp.x, tmp.y, tmp.z, s, s, wishColor, 2.0);
      }
    }
    glows.end();
    glows.billboards.visible = glows.billboards.count > 0;
  }

  // ---------------- per frame
  function update(dt) {
    clock += dt;
    const idle = !running && !earth.owner && !earth.fading && textAlpha <= 0 && clock > trailUntil && clock - burstStart >= C.burstLife && clock - wishStart > C.wishRiseTime + 2.5;
    if (idle) {
      if (glows.billboards.visible) { glows.begin(); glows.end(); glows.billboards.visible = false; }
      return;
    }
    camera.getWorldPosition(camW);
    garden.toUnity(camW, camU);
    garden.setViewer?.(camW);
    if (running) step(dt);
    earthStep(dt);
    draw();
    if (text && (stage === 'text' || textAlpha > 0)) { try { text.update?.(dt); } catch (err) { /* ignore */ } }
  }

  station.setEnding({ begin, get done() { return done; } });
  console.info('[ending] ready: the mochi flies to the Earth at the end of each batch');
  return {
    update,
    get active() { return running; },
    // after the ending's reset (Unity's MoonStory.Resetted: the intro restarts from there)
    onReset(fn) { if (typeof fn === 'function') resetFns.push(fn); },
  };
}

// MoonRabbit/MochiOrb: a soft warm-white ball, fog-free, lit from above with a gentle rim (gamma-space material
// colours linearised, as Unity does in linear colour space).
function createOrbMaterial() {
  const lin = (c) => linColor(new THREE.Color(), c);
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: lin([0.85, 0.8, 0.74]) },
      uShade: { value: lin([0.32, 0.28, 0.3]) },
      uRimColor: { value: lin([1, 0.9, 0.72]) },
      uRimPower: { value: 2.5 },
      uGlow: { value: 0.06 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN;
      varying vec3 vW;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor, uShade, uRimColor;
      uniform float uRimPower, uGlow;
      varying vec3 vN;
      varying vec3 vW;
      void main() {
        vec3 n = normalize(vN);
        vec3 v = normalize(cameraPosition - vW);
        float up = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 c = mix(uShade, uColor, up);
        float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), uRimPower);
        c = c * 0.82 + uRimColor * rim * 0.45 + uColor * uGlow;
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    fog: false,
  });
}
