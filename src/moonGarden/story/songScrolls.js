// SongScrolls + SongScrollHints: song choices on floating hanji, with their mallets above them.
import * as THREE from 'three';
import { createScroll } from './scroll.js';
import { createStoryText } from './text.js';
import { MALLETS, makeSongMallet, malletPreview } from './mallets.js';

export function prettySong(file) {
  return file.replace(/\.[^.]+$/, '').replaceAll('_', ' ').replace(/\s*\(.*$/, '')
    .replace(/^.*?\s-\s/, '').replace(/\s+(feat\.?|rus)\b.*$/i, '').trim();
}

export function createSongScrolls(ctx) {
  const { scene, camera, renderer, station, music, rhythm, sounds, flow } = ctx;
  const mats = {
    wood: station.kine.getObjectByName('kine-head').material,
    band: new THREE.MeshStandardMaterial({ color: 0xbda477, roughness: 0.8 }),
    log: new THREE.MeshStandardMaterial({ color: 0x795034, roughness: 0.9 }),
    wrap: new THREE.MeshStandardMaterial({ color: 0xd78894, roughness: 0.9 }),
  };
  const mallets = MALLETS.map((type) => ({ ...type, ...makeSongMallet(type.id, mats) }));
  const slots = [], known = new Set();
  const head = new THREE.Vector3(), direction = new THREE.Vector3(), delta = new THREE.Vector3(), grip = new THREE.Vector3();
  let clock = 0, pollAt = 0, idleFor = 0, offered = false;
  let musicWasPlaying = false;
  const pinched = new Set();

  function addSongs() {
    for (const file of ctx.songs()) {
      if (known.has(file)) continue;
      known.add(file);
      const tool = mallets.find((m) => file.toLowerCase().includes(m.match)) ?? mallets[slots.length % mallets.length];
      const paper = createScroll({ width: 0.6, height: 0.28 });
      paper.object3d.name = `Song scroll: ${prettySong(file)}`; scene.add(paper.object3d);
      const title = createStoryText({ letterHeight: 0.044, characterSpacing: 2, rise: false, halo: false });
      title.setText(prettySong(file));
      title.object3d.scale.setScalar(Math.min(1, 0.52 / Math.max(0.01, title.measure(prettySong(file)).x)));
      title.object3d.position.set(0, 0.025, 0.006);
      const label = createStoryText({ letterHeight: 0.027, characterSpacing: 2, rise: false, halo: false, color: [1, 0.824, 0.478] });
      label.setText(tool.label); label.object3d.position.set(0, -0.062, 0.006);
      const hint = createStoryText({ letterHeight: 0.025, rise: false, halo: false });
      hint.object3d.position.set(0, -0.23, 0.006);
      const preview = malletPreview(tool.object3d); preview.position.y = 0.34;
      paper.object3d.add(title.object3d, label.object3d, hint.object3d, preview);
      slots.push({ file, tool, paper, title, label, hint, preview, glow: 0 });
      // Re-layout a late-arriving song list on the next offer.
      if (offered) closeAll();
    }
    slots.sort((a, b) => mallets.indexOf(a.tool) - mallets.indexOf(b.tool));
  }
  function closeAll() {
    if (offered && slots.length) sounds.playScrollClose?.(slots[0].paper.object3d.position, 0.6);
    for (const slot of slots) slot.paper.close(0.6);
    offered = false; idleFor = 0;
  }
  function offer() {
    camera.getWorldPosition(head);
    slots.forEach((slot, i) => {
      // Two metres from the usu: the walking/kneading area within 1.6 m remains clear.
      const row = Math.floor(i / 5), count = Math.min(5, slots.length - row * 5), col = i % 5;
      slot.paper.object3d.position.set((col - (count - 1) / 2) * 0.75, 1.35 + row * 0.68, 2.0);
      slot.paper.object3d.lookAt(head.x, slot.paper.object3d.position.y, head.z);
      slot.paper.open(0.7);
      slot.hint.setText(renderer.xr.isPresenting ? 'Reach + select / pinch' : 'Look here + E');
    });
    offered = true;
    if (slots.length) sounds.playScrollUnroll?.(slots[0].paper.object3d.position, new THREE.Vector3(1, 0, 0), 0.7);
  }
  function candidate(controller) {
    camera.getWorldPosition(head); camera.getWorldDirection(direction);
    if (controller) controller.grip.getWorldPosition(grip);
    let best = null, bestScore = Infinity;
    for (const slot of slots) {
      if (slot.paper.amount < 0.75) continue;
      const p = slot.paper.object3d.position;
      let score;
      if (controller) {
        score = grip.distanceTo(p);
        if (score > 0.5) continue;
      } else {
        delta.subVectors(p, head);
        const distance = delta.length(), along = delta.dot(direction);
        if (distance > 2.5 || along <= 0) continue;
        score = delta.addScaledVector(direction, -along).length();
        if (score > 0.32) continue;
      }
      if (score < bestScore) { best = slot; bestScore = score; }
    }
    return best;
  }
  const canUse = () => ctx.entered && !flow.introActive && !flow.ending?.active && offered && !ctx.songLoading;
  function choose(slot, controller, equip = true) {
    if (!slot) return false;
    if (!ctx.selectSong(slot.file, slot.tool.id)) { ctx.toast?.('This song is not available to choose here.', 2); return true; }
    if (ctx.musicAuthority !== false && station.mode !== 'remote') {
      station.setKineAsset(slot.tool.id);
      if (equip) ctx.equipMallet?.(controller);
    }
    ctx.toast?.(ctx.musicAuthority === false ? `Song requested: ${prettySong(slot.file)}` : `${prettySong(slot.file)} · ${slot.tool.label}`, 2.4);
    console.info(`[song scrolls] ${slot.file} -> ${slot.tool.label}`);
    return true;
  }
  function use(controller) { return canUse() ? choose(candidate(controller), controller) : false; }
  function update(dt) {
    clock += dt;
    if (clock >= pollAt) { pollAt = clock + 1; addSongs(); }
    if (!ctx.entered) return;
    const ending = station.phase === 'done' || flow.ending?.active;
    if (ending && music.playing && ctx.musicAuthority !== false) {
      // Match the Unity bridge's bow-out. Finish the fade before the orb's flight starts.
      music.setVolume(Math.max(0, 0.8 * (1 - Math.min(1, (clock - endingAt) / 1.2))));
      if (clock - endingAt >= 1.2) { rhythm.stop(); music.stop(); ctx.clearSong?.(); music.setVolume(0.8); }
    }
    if (!ending) endingAt = clock;
    // A shared selection uses the same song -> mallet mapping as a local scroll.
    if (ctx.musicAuthority !== false && music.playing && (!musicWasPlaying || currentName !== music.name)) {
      currentName = music.name;
      const tool = mallets.find((m) => music.name.toLowerCase().includes(m.match));
      if (tool) station.setKineAsset(tool.id);
    }
    musicWasPlaying = music.playing;
    const ready = ctx.canChooseSong !== false && !flow.introActive && !ending;
    if (ready && !offered) { idleFor += dt; if (idleFor >= 0.8 && slots.length) offer(); }
    else if (!ready && offered) closeAll();
    if (!ready) idleFor = 0;
    const hovered = offered ? candidate(null) : null;
    for (const slot of slots) {
      slot.paper.update(dt);
      if (!slot.paper.object3d.visible) continue;
      const selected = music.playing && music.name === slot.file;
      slot.glow += ((slot === hovered ? 1 : selected ? 0.65 : 0) - slot.glow) * Math.min(1, dt * 5);
      slot.paper.glow = 0.2 + 1.1 * slot.glow;
      const alpha = slot.paper.alpha * THREE.MathUtils.smoothstep(slot.paper.amount, 0.55, 1);
      slot.title.setAlpha(alpha); slot.label.setAlpha(alpha * 0.9); slot.hint.setAlpha(alpha * 0.65);
      slot.title.update(dt); slot.label.update(dt); slot.hint.update(dt);
      slot.preview.visible = alpha > 0.05; slot.preview.rotation.y = -0.5 + Math.sin(clock * 0.8) * 0.18;
      slot.preview.position.y = 0.34 + Math.sin(clock * 1.6) * 0.012;
    }
    // The kneading player has put their controllers down. Local hand pinches select the same
    // scrolls without equipping a controller-held mallet or interpreting the other player's hands.
    if (renderer.xr.isPresenting) for (const hand of ctx.hands?.hands ?? []) {
      if (hand.remote) continue;
      const thumb = hand.joints?.get('thumb-tip'), index = hand.joints?.get('index-finger-tip');
      const down = hand.tracked && thumb && index && thumb.center.distanceTo(index.center) < 0.025;
      if (!down) { pinched.delete(hand); continue; }
      if (pinched.has(hand)) continue;
      pinched.add(hand);
      if (!canUse()) continue;
      const centre = thumb.center.clone().add(index.center).multiplyScalar(0.5);
      const slot = candidate({ grip: { getWorldPosition: (out) => out.copy(centre) } });
      choose(slot, null, false);
    }
  }
  let endingAt = 0, currentName = '';
  return { update, use, get offering() { return offered; } };
}
