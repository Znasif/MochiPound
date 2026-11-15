// Song choice by scroll, ported from the Unity team's `multiplayer` branch (MochiPound, Assets/MochiRhythm/Scripts):
//   SongScrolls.cs   when the story is idle (intro over, no ending playing) and no song plays, one small hanji
//                    scroll per song unrolls, titled with the song and, underneath, the mallet it holds. Picking a
//                    scroll turns it into that mallet in the hand and starts the song; the other scrolls roll up.
//                    When the song ends (or the batch's ending starts) the mallet is put down, shrinks away, the
//                    team's own kine comes back, and the scrolls return once the story is idle again.
//   Mallets.cs       the mallets, after real pounding tools, all in the kine's frame (here: the hands at the origin,
//                    the head's striking face at its local -Y), sized x1.6 to this scene's kine (Unity's kine is
//                    r 0.06 / L 0.2, three.js's r 0.1 / L 0.32):
//                      Tteokme (떡메, Bangarang)       the Korean tteok mallet, a heavy rough log head on a thick handle
//                      Yokogine (横杵, Believer)       the Japanese T mallet: the station's own kine (props.js makeKine)
//                      Jeolgut-gongi (절굿공이, Gangnam) the Moon Rabbit's pestle, a long rod held in the middle and
//                                                      driven straight down (its own desktop swing, grip and rest)
//   SongScrollHints  a small silhouette of each mallet floats above its scroll (Unity's ghost-hand pinch
//                    demonstration needs the team's ghost hand and is not ported).
//   RhythmStoryBridge  only "the song bows out when the ending starts": the batch's progress here still comes from the
//                    strikes (station.js), not from the rhythm score.
// Differences from Unity, on purpose: the scrolls stand on an arc 0.85 m from the usu's axis (clear of a 1.6 m
// zone around it, so they are never in the mallet's way), facing the player; and the kine stays usable for free
// play without a scroll (Unity hides it until a scroll is picked).
// Picking: desktop E while looking at a scroll (within 3.5 m); VR select or squeeze with the controller within
// 0.16 m of a scroll, or pointing at one within 2.5 m. The pick goes through use() and returns true.
// The joining headset (multiplayer) doesn't get scrolls: the host's headset plays the music.
import * as THREE from 'three';
import * as L from '../../layout.js';
import { woodTexture } from '../../textures.js';
import { createHanjiScroll } from './scroll.js';
import { clamp01 } from '../unity.js';

const C = {
  paper: [0.22, 0.1], padding: [0.025, 0.02], margin: 0.03, arcRadius: 0.85, height: 1.22, spacing: 0.29,
  openTime: 0.7, closeTime: 0.6, morphTime: 0.35, returnTime: 0.45, offerDelay: 0.8,
  titleHeight: 0.022, labelHeight: 0.016, silhouette: 0.17,
  pickReach: 0.16, pointReach: 2.5, lookReach: 3.5, lookAngle: 0.12,
};
const S16 = 1.6; // Unity metres -> this scene's kine scale

export async function createSongScrolls(ctx) {
  const { scene, camera, station, music, player } = ctx;
  if (!station?.setKine || !ctx.selectSong) return null;
  if (ctx.multiplayer === 'join') { console.info('[song scrolls] off on the joining headset (the host picks the music)'); return null; }
  const textMod = await import('./text.js');
  await Promise.race([textMod.loadStoryFonts(), new Promise((r) => setTimeout(r, 4000))]);
  const sounds = ctx.sounds ?? {};
  const play = (name, ...args) => { try { sounds[name]?.(...args); } catch (err) { console.warn(`[song scrolls] sounds.${name}`, err); } };

  // ---------------- the mallets
  const mats = malletMaterials();
  const MALLETS = [
    { name: 'Tteokme', match: 'bangarang', build: () => buildTteokme(mats), opts: () => ({}) },
    { name: 'Yokogine', match: 'believer', build: null, opts: () => ({}) },
    { name: 'Jeolgut-gongi', match: 'gangnam', build: () => buildPestle(mats), opts: pestleOpts },
  ];
  let yokogine = null; // the station's own kine, kept from the first swap
  const built = new Map();
  function malletGroup(m) {
    if (!m.build) return yokogine;
    if (!built.has(m)) built.set(m, m.build());
    return built.get(m);
  }
  let current = MALLETS[1];
  function apply(m) {
    if (m === current) return;
    const next = m.build ? malletGroup(m) : yokogine;
    if (!next) return;
    const prev = station.setKine(next, m.opts());
    if (!yokogine) yokogine = prev;
    current = m;
    console.info(`[song scrolls] mallet: ${m.name}`);
  }

  // ---------------- songs -> slots ("Skrillex_-_Bangarang_feat._Sirah_(mp3.pm).mp3" -> "Bangarang")
  function pretty(file) {
    let s = file.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
    let p = s.indexOf('('); if (p > 0) s = s.slice(0, p);
    p = s.indexOf(' - '); if (p >= 0) s = s.slice(p + 3);
    p = s.indexOf(' feat'); if (p > 0) s = s.slice(0, p);
    p = s.indexOf(' rus '); if (p > 0) s = s.slice(0, p);
    return s.trim();
  }
  let slots = [];
  function buildSlots(songs) {
    for (const s of slots) { s.scroll.hideNow(); s.root.removeFromParent(); }
    slots = [];
    const used = new Set();
    const list = songs.map((file) => {
      const n = file.toLowerCase();
      const m = MALLETS.find((x) => !used.has(x) && n.includes(x.match));
      if (m) used.add(m);
      return { file, mallet: m };
    });
    let next = 0;
    for (const s of list) {
      if (s.mallet) continue;
      const free = MALLETS.find((x) => !used.has(x));
      if (free) { used.add(free); s.mallet = free; } else s.mallet = MALLETS[next++ % MALLETS.length];
    }
    list.sort((a, b) => MALLETS.indexOf(a.mallet) - MALLETS.indexOf(b.mallet)); // heaviest on the left
    for (const s of list) {
      const root = new THREE.Group();
      root.name = `Song scroll ${pretty(s.file)}`;
      const scroll = createHanjiScroll(textMod, {
        padding: C.padding, margin: C.margin, hintDelay: 0.35, hintLetterHeight: C.labelHeight, hintGap: 0.03,
        hintColor: [0.93, 0.88, 0.76], hintAlpha: 0.8,
      });
      root.add(scroll.object3d);
      // the title, in the intro's ink, smaller if it is wider than the paper
      const title = textMod.createStoryText({
        font: 'cinzel', letterHeight: C.titleHeight, color: [0.09, 0.09, 0.15], outlineColor: [0.13, 0.09, 0.06, 0.45],
        characterSpacing: 4, rise: false, glow: false,
      });
      const label = pretty(s.file);
      const w = title.measure(label).x;
      const fit = w > C.paper[0] * 0.92 ? C.paper[0] * 0.92 / w : 1;
      title.object3d.scale.setScalar(fit);
      title.setText(label);
      title.setAlpha(0);
      scroll.object3d.add(title.object3d);
      // the mallet's silhouette above the scroll
      const sil = silhouette(s.mallet.build ? malletGroup(s.mallet) : yokogineShape(), C.silhouette);
      sil.position.set(0, (C.paper[1] + C.padding[1] * 2) / 2 + 0.035 + C.silhouette * 0.3, -0.01);
      scroll.object3d.add(sil);
      scene.add(root);
      slots.push({ ...s, root, scroll, title, sil, glow: 0, openedAt: -1, titleA: 0 });
    }
    console.info(`[song scrolls] ${slots.length} songs -> ${slots.map((s) => `${pretty(s.file)} = ${s.mallet.name}`).join(', ')}`);
  }
  // the yokogine's silhouette before the station's own kine has been seen (its shape, from props.js's numbers)
  function yokogineShape() {
    const g = new THREE.Group();
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, L.KINE_LENGTH + 0.12, 16), mats.handle);
    handle.rotation.x = Math.PI / 2; handle.position.z = -(L.KINE_LENGTH + 0.12) / 2 + 0.1;
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.32, 24), mats.head);
    head.position.z = -L.KINE_LENGTH;
    g.add(handle, head);
    return g;
  }

  // ---------------- state (SongScrolls.State)
  let state = 'hidden', stateSince = 0, idleSince = -1, now = 0, songStarted = false, pickedFile = null, holdSince = 0;
  let songsKey = '';
  const parts = () => ctx.parts ?? [];
  const intro = () => parts().find((p) => p.name === 'intro');
  const ending = () => parts().find((p) => p.name === 'ending');
  const storyIdle = () => !intro()?.playing && !ending()?.active;

  const head = new THREE.Vector3(), tmp = new THREE.Vector3(), fwd = new THREE.Vector3(), pose = new THREE.Object3D();
  function offer() {
    camera.getWorldPosition(head);
    const usu = new THREE.Vector3(L.USU.position[0], 0, L.USU.position[2]);
    tmp.set(head.x - usu.x, 0, head.z - usu.z);
    if (tmp.lengthSq() < 1e-4) tmp.set(0, 0, 1);
    const base = Math.atan2(tmp.x, tmp.z), dA = C.spacing / C.arcRadius;
    slots.forEach((s, i) => {
      const a = base + (i - (slots.length - 1) / 2) * dA;
      pose.position.set(usu.x + Math.sin(a) * C.arcRadius, C.height, usu.z + Math.cos(a) * C.arcRadius);
      fwd.set(head.x, pose.position.y, head.z);
      if (fwd.distanceToSquared(pose.position) < 0.04) fwd.copy(pose.position).add(tmp);
      pose.lookAt(fwd); // the paper's front toward the player
      s.scroll.setup(pose, C.paper[0], C.paper[1], s.mallet.name);
      s.scroll.object3d.position.set(0, 0, 0); s.scroll.object3d.quaternion.identity();
      s.root.position.copy(pose.position); s.root.quaternion.copy(pose.quaternion);
      s.scroll.open(C.openTime);
      s.scroll.cloudGlow = 0.2;
      s.openedAt = now;
      s.enabled = true;
    });
    if (slots.length) play('playScrollUnroll', tmp.set(usu.x, C.height, usu.z), new THREE.Vector3(1, 0, 0), C.openTime);
    state = 'offering'; stateSince = now;
    console.info('[song scrolls] offered');
  }
  function closeAll(except) {
    for (const s of slots) {
      s.enabled = false;
      if (s === except || !s.scroll.active) continue;
      s.scroll.close(C.closeTime);
      s.openedAt = -1;
    }
    play('playScrollClose', new THREE.Vector3(L.USU.position[0], C.height, L.USU.position[2]), C.closeTime);
  }

  // ---------------- picking
  const ray = new THREE.Ray(), segA = new THREE.Vector3(), segB = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  function segment(s) {
    s.root.getWorldQuaternion(quat);
    tmp.set(1, 0, 0).applyQuaternion(quat).multiplyScalar(C.paper[0] / 2);
    segA.copy(s.root.position).sub(tmp); segB.copy(s.root.position).add(tmp);
  }
  function nearestTo(point) {
    let best = null, bd = Infinity;
    for (const s of slots) {
      if (!s.enabled) continue;
      segment(s);
      const d = new THREE.Line3(segA, segB).closestPointToPoint(point, true, p).distanceTo(point);
      if (d < bd) { bd = d; best = s; }
    }
    return { slot: best, d: bd };
  }
  function pointedAt(origin, dir, reach, angle) {
    let best = null, bd = Infinity;
    ray.set(origin, dir);
    for (const s of slots) {
      if (!s.enabled) continue;
      segment(s);
      const d2 = ray.distanceSqToSegment(segA, segB, q, p);
      const along = q.distanceTo(origin);
      if (along > reach) continue;
      const tol = Math.max(C.paper[1] * 0.75, along * angle);
      if (d2 < tol * tol && d2 < bd) { bd = d2; best = s; }
    }
    return best;
  }
  function lookTarget() {
    camera.getWorldPosition(head); camera.getWorldDirection(fwd);
    return pointedAt(head, fwd, C.lookReach, C.lookAngle);
  }
  function controllerTarget(c) {
    if (c.grip) {
      c.grip.getWorldPosition(tmp);
      const n = nearestTo(tmp);
      if (n.slot && n.d < C.pickReach) return n.slot;
    }
    if (c.ray) {
      c.ray.getWorldPosition(tmp); c.ray.getWorldQuaternion(quat);
      fwd.set(0, 0, -1).applyQuaternion(quat);
      return pointedAt(tmp.clone(), fwd.clone(), C.pointReach, 0.06);
    }
    return null;
  }

  function pick(s, c) {
    if (state !== 'offering') return;
    closeAll(s);
    s.scroll.fade(0.2);
    s.openedAt = -1;
    apply(s.mallet);
    const took = ctx.takeKine ? ctx.takeKine(c ?? null) : false; // the mallet in the hand (VR) or at the pounder spot (desktop)
    morphFrom = now;
    play('playScrollUnroll', s.root.position, new THREE.Vector3(1, 0, 0), C.morphTime);
    songStarted = false; pickedFile = s.file; holdSince = now;
    state = 'holding'; stateSince = now;
    console.info(`[song scrolls] picked: ${s.file} with the ${s.mallet.name}${took ? '' : ' (the kine was not taken)'}`);
    if (!ctx.selectSong(s.file)) console.warn('[song scrolls] the song is not listed', s.file);
  }

  // the mallet grows into the hand (EaseOutBack over morphTime), and shrinks away when it is put down
  let morphFrom = -100, kineScaleNow = 1;
  function kineObject() { return current.build ? malletGroup(current) : yokogine; }
  function setKineScale(k) {
    const g = kineObject();
    if (!g || Math.abs(k - kineScaleNow) < 1e-4) { kineScaleNow = k; return; }
    kineScaleNow = k;
    for (const ch of g.children) ch.scale.setScalar(Math.max(0.001, k));
    // the children are scaled around the kine's origin (the hands), positions too
    for (const ch of g.children) {
      ch.userData.basePos ??= ch.position.clone();
      ch.position.copy(ch.userData.basePos).multiplyScalar(Math.max(0.001, k));
    }
  }
  function easeOutBack(t) { const c = 1.6, u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; }

  function beginReturn() {
    ctx.dropKine?.();
    state = 'returning'; stateSince = now;
  }
  function finishReturn() {
    setKineScale(1);
    apply(MALLETS[1]); // the team's own kine while nobody holds a mallet
    idleSince = -1; pickedFile = null;
    state = 'hidden';
  }

  // ---------------- per frame
  function update(dt) {
    now += dt;
    const names = ctx.songs?.() ?? [];
    const key = names.join('|');
    if (key !== songsKey && state === 'hidden') { songsKey = key; if (names.length) buildSlots(names); }
    if (!ctx.entered) { idleSince = -1; }
    switch (state) {
      case 'hidden': {
        const ready = slots.length && ctx.entered && storyIdle() && !music.playing && !ctx.rhythm?.active;
        if (!ready) { idleSince = -1; break; }
        if (idleSince < 0) idleSince = now;
        if (now - idleSince >= C.offerDelay) offer();
        break;
      }
      case 'offering':
        if (!storyIdle() || music.playing) { closeAll(null); state = 'hidden'; }
        break;
      case 'holding': {
        if (music.playing) songStarted = true;
        const failed = !songStarted && now - holdSince > 20; // still finding the beat after 20 s: give up
        if (ending()?.active && music.playing) ctx.stopMusic?.(); // the song bows out when the ending starts
        if ((songStarted && !music.playing) || failed) {
          if (failed) console.warn('[song scrolls] the song did not start', pickedFile);
          beginReturn();
        }
        break;
      }
      case 'returning': {
        const k = clamp01((now - stateSince) / C.returnTime);
        setKineScale(1 - k * k);
        if (k >= 1) finishReturn();
        break;
      }
    }
    if (state === 'holding') setKineScale(easeOutBack(clamp01((now - morphFrom) / C.morphTime)));

    // hover: the looked-at scroll (desktop) or the one a controller is near or pointing at (VR) glows and grows
    let hover = null;
    if (state === 'offering') {
      if (ctx.renderer.xr.isPresenting) {
        for (const c of player.controllers ?? []) { if (c.source && !c.source.hand) hover ??= controllerTarget(c); }
      } else hover = lookTarget();
    }
    for (const s of slots) {
      s.scroll.update(dt);
      if (!s.scroll.active) { s.title.setAlpha(0); setSilhouette(s.sil, 0); continue; }
      const open = s.openedAt >= 0;
      s.titleA = open ? clamp01((now - s.openedAt - C.openTime * 0.6) / 0.4) : Math.max(0, s.titleA - dt * 4);
      s.title.setAlpha(s.titleA);
      s.title.update(dt);
      const want = s.enabled && s === hover ? 1 : 0;
      s.glow += Math.sign(want - s.glow) * Math.min(Math.abs(want - s.glow), dt * 5);
      s.scroll.cloudGlow = 0.2 + 1.1 * s.glow;
      s.root.scale.setScalar(1 + 0.07 * s.glow);
      s.sil.rotation.y += dt * 0.6;
      setSilhouette(s.sil, s.titleA * (0.55 + 0.45 * s.glow));
    }
  }

  console.info('[song scrolls] ready');
  return {
    update,
    use(c) {
      if (state !== 'offering') return false;
      const s = c ? controllerTarget(c) : lookTarget();
      if (!s) return false;
      pick(s, c);
      return true;
    },
    get offering() { return state === 'offering'; },
  };
}

// ---------------- materials (MR_KineHandle, MR_KineHead, MR_SkinRabbitPink, MR_UsuWood, MR_UsuEndGrain stand-ins)
function malletMaterials() {
  const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.75, ...o });
  return {
    handle: std({ map: woodTexture({ base: '#b88a5a', dark: '#7a5432', seed: 17 }), roughness: 0.7 }),
    head: std({ map: woodTexture({ base: '#c49a68', dark: '#8a6240', seed: 23 }) }),
    pink: std({ color: 0xe9a6ae, roughness: 0.85 }),
    log: std({ map: woodTexture({ base: '#6b4a32', dark: '#3e2818', seed: 41 }), roughness: 0.9 }),
    endGrain: std({ map: woodTexture({ base: '#a98058', dark: '#6f4a2c', rings: true, seed: 43 }), roughness: 0.85 }),
    hoop: std({ color: 0x9c7a52, roughness: 0.8 }),
  };
}

// a cylinder along Y (its end caps in their own material) or along a direction, as a direct child (kineContact
// collides direct-child CylinderGeometry / TorusGeometry meshes exactly)
function cyl(rTop, rBottom, h, mats, name) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, 32), mats);
  if (name) m.name = name;
  m.castShadow = true;
  return m;
}

// Tteokme: a log head (end grain on both faces, two lighter hoops near the ends) on a thick straight handle with a
// pink grip wrap near its end. Same frame as the yokogine (hands at the origin, handle along -Z, head at
// z = -KINE_LENGTH), so the station's default swing, grip and rest fit it.
function buildTteokme(mats) {
  const R = 0.075 * S16, Lh = 0.26 * S16, hr = 0.021 * S16, len = L.KINE_LENGTH;
  const g = new THREE.Group();
  g.name = 'kine (tteokme)';
  const head = cyl(R, R, Lh, [mats.log, mats.endGrain, mats.endGrain], 'kine-head');
  head.position.z = -len;
  g.add(head);
  for (const y of [-Lh / 2 + 0.02 * S16 + 0.02, Lh / 2 - 0.02 * S16 - 0.02]) {
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(R + 0.003, 0.009, 10, 48), mats.hoop);
    hoop.name = 'kine-band';
    hoop.rotation.x = Math.PI / 2;
    hoop.position.set(0, y, -len);
    g.add(hoop);
  }
  // the handle: from the head's side out past the hands
  const z0 = -len + R * 0.6, z1 = 0.1, hl = z1 - z0;
  const handle = cyl(hr, hr * 1.1, hl, mats.handle, 'kine-handle');
  handle.rotation.x = Math.PI / 2; // +Y -> +Z: the top (radiusTop) at the hands' end
  handle.position.z = (z0 + z1) / 2;
  g.add(handle);
  const wl = 0.13 * S16;
  const wrap = cyl(hr * 1.15, hr * 1.18, wl, mats.pink, 'kine-wrap');
  wrap.rotation.x = Math.PI / 2;
  wrap.position.z = z1 - 0.02 * S16 - wl / 2;
  g.add(wrap);
  return g;
}

// Jeolgut-gongi: a long rod with a thick end at each end, held in the middle (the hands at the origin, the rod along
// Y, the striking end below at -Y). Unity's profile (Mallets.cs MalletMeshes.Pestle) x1.6, as stacked cylinders.
const P = { R: 0.045 * S16, L: 0.17 * S16, f: 0.014 * S16, w: 0.024 * S16, gripA: 0.22 * S16, gripB: 0.48 * S16, hand: 0.34 * S16 };
P.top = P.gripB + 0.17 * S16;
function buildPestle(mats) {
  const { R, L: Lh, w, gripA, gripB, hand, top } = P;
  const g = new THREE.Group();
  g.name = 'kine (jeolgut-gongi)';
  const put = (m, y0, y1) => { m.position.y = (y0 + y1) / 2 - hand; g.add(m); return m; };
  put(cyl(R, R, Lh, [mats.head, mats.endGrain, mats.endGrain], 'kine-head'), 0, Lh);
  put(cyl(w * 1.15, R, gripA - (Lh - 0.02), mats.head), Lh - 0.02, gripA);
  put(cyl(w, w, gripB - gripA, mats.head, 'kine-handle'), gripA, gripB);
  put(cyl(R * 0.95, w * 1.15, 0.05 * S16, mats.head), gripB, gripB + 0.05 * S16);
  put(cyl(R * 0.95, R * 0.95, top - gripB - 0.05 * S16, [mats.head, mats.endGrain, mats.head]), gripB + 0.05 * S16, top);
  put(cyl(w + 0.005, w + 0.005, 0.12 * S16, mats.pink, 'kine-wrap'), hand - 0.06 * S16, hand + 0.06 * S16);
  return g;
}
// its own hold, desktop swing and rest: driven straight down over the bowl, standing upright beside the mortar
function pestleOpts() {
  const below = P.hand; // hands to the striking face
  return {
    grip: { position: new THREE.Vector3(0, 0, 0.01), rotation: new THREE.Euler(-Math.PI / 2 + 0.2, 0, 0) },
    pose(kine, lift, strikeY) {
      // strikeY is the yokogine's hand height at contact (the dough's top + 8 cm); the face goes 8 cm into the dough
      const faceY = strikeY - 0.16;
      const e = lift * lift * (3 - 2 * lift);
      kine.position.set(L.USU.position[0], faceY + below + e * 0.45, L.USU.position[2] + 0.04 + e * 0.08);
      kine.rotation.set(-0.12 * e, 0, 0);
    },
    rest(kine) {
      kine.position.set(L.KINE_REST[0], below + 0.003, L.KINE_REST[2]);
      kine.rotation.set(0, 0, 0);
    },
  };
}

// a see-through copy of a mallet, scaled to fit `size`, for above its scroll
function silhouette(src, size) {
  const g = new THREE.Group();
  const copy = src.clone(true);
  const mat = new THREE.MeshBasicMaterial({ color: 0xffe2a8, transparent: true, opacity: 0, depthWrite: false, fog: false });
  copy.traverse((o) => { if (o.isMesh) { o.material = mat; o.castShadow = false; } });
  copy.position.set(0, 0, 0); copy.rotation.set(0, 0, 0); copy.scale.set(1, 1, 1);
  for (const ch of copy.children) { ch.scale.setScalar(1); if (ch.userData.basePos) ch.position.copy(ch.userData.basePos); }
  const box = new THREE.Box3().setFromObject(copy), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const k = size / Math.max(1e-3, s.x, s.y, s.z);
  copy.position.copy(c).multiplyScalar(-k);
  copy.scale.setScalar(k);
  g.add(copy);
  g.userData.mat = mat;
  g.renderOrder = 23;
  g.visible = false;
  return g;
}
function setSilhouette(g, a) {
  g.userData.mat.opacity = 0.55 * a;
  g.visible = a > 0.01;
}
