import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import * as L from './layout.js';
import { worldFromUrl, worldById, DEFAULT_WORLD } from './worlds.js';
import { createStation } from './station.js';
import { createSteam } from './effects.js';
import { createPlayer } from './player.js';
import { createHands } from './hands.js';
import { TIERS, particlesFor } from './dough/mpm-core.js';
import { createNet, roleFromUrl } from './net.js';
import { createHostSync, createGuestSync } from './sync.js';
import { loadAudio } from './audio.js';
import { createAudioPlayback } from './audioPlayback.js';
import { createMusic } from './rhythm/music.js';
import { createRhythm } from './rhythm/rhythm.js';
import { createMusicLead, createMusicFollow } from './musicSync.js';
import { createDoughMeters } from './dough/meters.js';

// ---------- renderer, scene, camera ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFoveation(1);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x101828, 0.03);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 400);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- the world (src/worlds.js: picked in the start menu's Worlds panel, ?world=<id>) ----------
// It sets its own sky, fog and lights. The station (usu, kine, dough, bucket) stands at its centre and is
// built after it (the mallet's contact reads the world's 'ground' mesh). A world that fails to build falls
// back to the default one, so a world still being written never stops the page.
const steam = createSteam(scene);
let world;
{
  const chosen = worldFromUrl();
  try {
    world = await chosen.build(scene, renderer, { steam });
    world.id = chosen.id; world.name = chosen.name;
  } catch (err) {
    // fall back to the shrine courtyard (the default is the Moon garden since 2026-11-15, the user's pick; the
    // courtyard is the plainest world), or to the default if the courtyard itself failed
    const def = worldById(chosen.id === 'shrine' ? DEFAULT_WORLD : 'shrine');
    if (!def || def.id === chosen.id) throw err;
    console.error(`[world] ${chosen.name} failed to build; opening the ${def.name} instead`, err);
    world = await def.build(scene, renderer, { steam });
    world.id = def.id; world.name = def.name;
    const sel = document.getElementById('world'), note = document.getElementById('world-note');
    if (sel) sel.value = def.id;
    if (note) note.textContent = `${chosen.name} failed to load (${err.message}), so this is the ${def.name}.`;
  }
  console.info(`[world] ${world.name}`);
}
const station = createStation(scene);
const doughMeters = createDoughMeters(scene, station);

const doughTop = new THREE.Vector3(0, L.MOCHI_TOP_Y + 0.05, 0);
const doughSteam = steam.addEmitter(doughTop, { rate: 4, spread: 0.25, size: 0.22, rise: 0.4 });
doughSteam.intensity = 0;

const staticCircles = [...world.colliders.circles, ...station.colliders.circles];
const colliders = { circles: staticCircles, boxes: world.colliders.boxes, rect: world.colliders.rect };
const player = createPlayer({
  scene, camera, renderer, dom: renderer.domElement,
  getColliders: () => {
    colliders.circles = staticCircles.concat(station.colliders.dynamic.filter(Boolean));
    return colliders;
  },
});
if (world.spawn) player.teleport(world.spawn.position[0], world.spawn.position[2], world.spawn.yaw); // player.js starts at L.SPAWN
// tracked hands (src/hands.js): the kneading person's own hands, drawn and colliding with dough and kine
const hands = createHands(renderer, player.rig, scene, player.controllers);
station.setHands(hands);

// two headsets (src/net.js, src/sync.js): 'host' runs everything and sends it out, 'join' draws the host's
// scene and kneads its dough with tracked hands; 'solo' is one headset alone
const mpRole = roleFromUrl();
const net = createNet(mpRole);
const sync = mpRole === 'host' ? createHostSync({ net, station, hands, camera, scene, controllers: player.controllers })
  : mpRole === 'join' ? createGuestSync({ net, station, hands, camera, scene, controllers: player.controllers }) : null;
const guest = mpRole === 'join';

// ---------- UI ----------
const $ = (id) => document.getElementById(id);
const vrMovement = $('vr-movement');
try { vrMovement.value = localStorage.getItem('mochi.vrMovement') === 'room' ? 'room' : 'sticks'; } catch { /* storage unavailable */ }
player.setRoomScale(vrMovement.value === 'room');
vrMovement.addEventListener('change', () => {
  player.setRoomScale(vrMovement.value === 'room');
  try { localStorage.setItem('mochi.vrMovement', vrMovement.value); } catch { /* storage unavailable */ }
});
const ui = {
  quality: $('dough-quality'), qualityNote: $('dough-quality-note'), mp: $('mp-role'), mpNote: $('mp-note'),
  overlay: $('overlay'), start: $('start'), sound: $('sound'), hud: $('hud'), prompt: $('prompt'),
  progress: $('progress'), batch: $('batch'), toast: $('toast'), reticle: $('reticle'), vrSlot: $('vr-slot'),
  rhud: $('rhud'), rSong: $('rsong'), rScore: $('rscore'), rMult: $('rmult'), rCombo: $('rcombo'), rCal: $('rcal'),
};
// dough quality: automatic (dough.js times this device and picks the richest tier that keeps up; the
// Quest browser gets 'tiny') or forced with ?dough=<tier>, which this menu sets (the page reloads, since
// the simulation grid is built at load)
{
  const forced = new URLSearchParams(location.search).get('dough') ?? '';
  for (const t of TIERS) {
    const o = document.createElement('option');
    o.value = t.name;
    o.textContent = `Dough: ${t.name} (~${particlesFor(t, 0.14).toLocaleString()} particles, ${(t.dx * 100).toFixed(1)} cm grid)`;
    ui.quality.appendChild(o);
  }
  ui.quality.value = TIERS.some((t) => t.name === forced) ? forced : '';
  // multiplayer role: the same reload with ?mp=<role>
  ui.mp.value = new URLSearchParams(location.search).get('mp') ?? 'solo';
  if (!['solo', 'host', 'join'].includes(ui.mp.value)) ui.mp.value = 'solo';
  ui.mp.addEventListener('change', () => {
    const url = new URL(location.href);
    if (ui.mp.value !== 'solo') url.searchParams.set('mp', ui.mp.value); else url.searchParams.delete('mp');
    location.replace(url.href);
  });
  ui.quality.addEventListener('change', () => {
    const url = new URL(location.href);
    if (ui.quality.value) url.searchParams.set('dough', ui.quality.value); else url.searchParams.delete('dough');
    location.replace(url.href);
  });
}
let toastTimer = 0;
function toast(text, s = 2.2) { ui.toast.textContent = text; ui.toast.classList.add('on'); toastTimer = s; }

// ---------- sound ----------
// The Satie soundscape is still the shrine courtyard's. Each world says which of its fixtures it has
// (world.sound.hosts: the shrine courtyard has the stove, steamer, bonfire and bell) and which sources to
// mute (the Moon garden replaces the courtyard's ambience with its own wind, fountain and chimes).
// A fixture a world doesn't have, and the two NPCs (gone from the station in both worlds), are bound to
// empty markers where they stood, so the contract stays fully bound.
const marker = (name, pos) => { const o = new THREE.Object3D(); o.name = `${name}-marker`; o.position.set(...pos); scene.add(o); return o; };
const fixture = (name, pos) => ({ object: world.sound?.hosts?.[name] ?? marker(name, pos) });
const hosts = {
  usu: { object: station.usu },
  oke: { object: station.oke },
  seiro: fixture('seiro', L.SEIRO.position),
  kamado: fixture('kamado', L.KAMADO.position),
  takibi: fixture('takibi', L.TAKIBI.position),
  bonsho: fixture('bonsho', L.BONSHO.position),
  pounder: { object: marker('pounder', L.POUNDER_SPOT) },
  turner: { object: station.kneelSpot }, // the kneading person's spot (the turner NPC is gone)
  helper: { object: marker('helper', L.KAMADO.position) },
  player: { object: player.body, anchor: 'origin' },
};
let audio = null;
let credit = null;
let mixer = null;
const ambience = world.sound?.createAmbience?.({ camera }) ?? null;
const soundPlayback = createAudioPlayback({ getAudio: () => audio, ambience,
  onStarted: () => { ui.sound.textContent = 'Sound by Satie: ready (spatial, follows your head).'; },
  onError: (error) => {
    console.warn('[audio] could not start; the next Play / Enter VR will retry', error);
    ui.sound.textContent = `Sound could not start: ${error.message}. Press Play or Enter VR to retry.`;
  },
});
world.onSound = (host, event) => audio?.hostEvent(host, event); // the world's own moments (the shrine's bell)
const audioReady = loadAudio({ hosts, camera, xr: false, onRetry: (n) => { ui.sound.textContent = `Loading sound… (a download dropped; retry ${n})`; } }).then((a) => {
  audio = a;
  const mute = world.sound?.muted ?? [];
  if (a.status === 'ready' && mute.length) {
    const engine = a.engine, muted = [];
    engine.scriptStatements.forEach((st, i) => { if (mute.includes(st.sourceId)) { engine.setStatementVolume(i, 0); muted.push(st.sourceId); } });
    console.info(`[satie] ${world.name}: muted the courtyard's ${muted.join(', ') || '(none found)'}`);
  }
  if (a.status === 'ready') {
    ui.sound.textContent = 'Sound by Satie: ready (spatial, follows your head).';
  } else {
    ui.sound.textContent = ambience ? 'Garden ambience ready; station recordings are unavailable.' : 'Sound has not been generated yet, so the scene is silent. Realize the Satie takes into public/satie/.';
    ui.sound.classList.toggle('silent', !ambience);
  }
  if (player.enabled || renderer.xr.isPresenting) void soundPlayback.start();
  return a;
}).catch((err) => {
  console.error('[satie] load failed', err);
  ui.sound.textContent = `Station sound failed to load: ${err.message}. ${ambience ? 'Garden ambience remains available.' : 'Running silent.'} Check this device's internet connection, then reload.`;
  ui.sound.classList.toggle('silent', !ambience);
  audio = { status: 'silent', start: async () => {}, update() {}, hostEvent() {}, setHostSurface() {}, event() {}, step() {}, signal() {}, signalTarget() {}, state() {} };
  return audio;
});
audioReady.finally(() => { ui.start.disabled = false; ui.start.textContent = world.enterLabel ?? 'Enter'; });

// The "Sound by Satie" credit on the start and pause screens; in development it opens the mixer.
import('satie-runtime/badge').then(({ badge }) => {
  credit = badge({ dev: import.meta.env.DEV, ready: audioReady, onOpen: () => mixer?.open() });
  credit.intro();
}).catch((err) => console.warn('[satie] badge unavailable', err));

audioReady.then((a) => {
  if (!import.meta.env.DEV || a.status !== 'ready') return;
  import('satie-runtime/three').then(({ mountMixer }) => {
    mixer = mountMixer(a.scene, {
      scene, camera, renderer, script: '/satie/scene.satie', samples: '/satie/samples.json', collapsed: true,
      look: player.look, teleport: (x, z, yaw) => player.teleport(x, z, yaw),
      context: () => a.scene.authoringContext(),
      onOpenChange: (open) => credit?.setPanelOpen(open),
      capture: false, // no session recordings are posted anywhere unless the developer turns this on
      levelFaders: true, // faders edit each source's `spl` (dB at 1 m) and keep its automation
      mixGroups: [
        { id: 'pounding', label: 'Pounding', sourceIds: ['pound', 'turn', 'dip'] },
        ...(world.sound?.mixGroups ?? []),
      ],
    });
  }).catch((err) => console.warn('[satie] mixer unavailable', err));
});

function enter() {
  void soundPlayback.start(); // unlock both contexts synchronously inside the user gesture
  ui.overlay.classList.add('hidden');
  ui.hud.classList.remove('hidden');
  ui.reticle.classList.remove('hidden');
  credit?.hide();
  player.enable();
  story?.enter?.(false);
  startMusic();
  if (!renderer.xr.isPresenting) renderer.domElement.requestPointerLock?.()?.catch?.(() => {}); // a promise in current Chrome (rejects outside a user gesture)
}
ui.start.addEventListener('click', enter);
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== renderer.domElement && player.enabled && !renderer.xr.isPresenting) {
    ui.overlay.classList.remove('hidden');
    ui.start.textContent = 'Resume';
    ui.reticle.classList.add('hidden');
    if (rhythm.active && mpRole !== 'host') music.pause();
    credit?.rest();
  }
});

// hand tracking: the person kneading uses their own hands (controllers put down)
const vrButton = VRButton.createButton(renderer, { optionalFeatures: ['hand-tracking'] });
ui.vrSlot.appendChild(vrButton);
vrButton.addEventListener('click', () => {
  void soundPlayback.start();
  startMusic();
}, true);

renderer.xr.addEventListener('sessionstart', () => {
  void soundPlayback.start();
  handsGoneFor = Infinity;
  player.beginRoomScale(guest ? L.KNEAD_SPOT : L.POUNDER_SPOT, L.USU.position);
  story?.enter?.(true);
  if (station.mode === 'desktop') {
    if (guest && guestHolds) { guestHolds = false; kineHand = null; sync.dropKine(); }
    station.setMode('idle'); player.unlock();
  }
  ui.overlay.classList.add('hidden');
  ui.hud.classList.add('hidden');
  credit?.hide();
  player.enable();
  const session = renderer.xr.getSession();
  session?.addEventListener('visibilitychange', () => {
    const ctx = audio?.engine?.audioContext;
    const hidden = session.visibilityState === 'hidden';
    ambience?.setVisible(!hidden && !document.hidden);
    if (ctx) { if (hidden) void ctx.suspend(); else void ctx.resume(); }
    if (rhythm.active) {
      if (hidden) { if (mpRole !== 'host') music.pause(); }
      else music.resume();
    }
  });
});
renderer.xr.addEventListener('sessionend', () => {
  ambience?.setVisible(!document.hidden);
  if (station.mode === 'vr') station.setMode('idle');
  audio?.engine?.audioContext?.resume();
  ui.hud.classList.remove('hidden');
});
document.addEventListener('visibilitychange', () => {
  const visible = !document.hidden && (!renderer.xr.isPresenting || renderer.xr.getSession()?.visibilityState !== 'hidden');
  ambience?.setVisible(visible);
  if (visible && player.enabled) void soundPlayback.start();
});

// ---------- rhythm mode ----------
const music = createMusic({ keepAlive: mpRole === 'host' });
const rhythm = createRhythm({ scene, station, music, kneading: guest });
// Either player chooses an in-world song scroll. The host loads and starts the shared song;
// solo pauses in the menu, while a host keeps the shared clock going.
let songChosen = false, entered = false;
let songNames = [];
let selectedSong = null, songVersion = 0;
let hostMusicStatus = 'Waiting for the host’s music…';
const musicSync = mpRole === 'host' ? createMusicLead({
  net, music, rhythm, song: () => selectedSong, isLoading: () => songLoading,
  onPick(name, assetId) {
    if (songLoading || story?.blocked || station.phase === 'done') return false;
    return selectListedSong(name, assetId);
  },
})
  : guest ? createMusicFollow({
    net, music, rhythm,
    canPlay: () => entered && ui.overlay.classList.contains('hidden')
      && (!world.attach || (story?.started && !story.blocked))
      && (!renderer.xr.isPresenting || renderer.xr.getSession()?.visibilityState !== 'hidden'),
    onStatus(text) { hostMusicStatus = text; },
    onActive(active) { ui.rhud.classList.toggle('hidden', !active); },
    onPickResult(ok) { if (!ok) toast('Song selection was not accepted. Try again when the host is ready.', 2.5); },
  }) : null;
rhythm.on('judge', ({ kind, action, noteKey }) => {
  if (!['perfect', 'good'].includes(kind) || !noteKey) return;
  const songId = guest ? musicSync.songId : selectedSong?.id;
  const event = { kind, action, id: `${songId}:${noteKey}`, epoch: station.conditioning.epoch };
  if (guest) sync.reportSuccessfulAction(event); else station.recordSuccessfulAction(event);
});
function stopMusic() {
  if (rhythm.active) rhythm.stop();
  music.stop();
  ui.rhud.classList.add('hidden');
}
// called inside the enter click (a user gesture), and when a song finishes loading after entering
function startMusic() {
  entered = true;
  if (!music.playing || !story?.blocked) music.unlock();
  if (world.attach && (!story?.started || story.blocked)) return;
  if (guest) { musicSync.update(); return; }
  if (!songChosen || !music.analysis) return; // still finding the beat: starts when it's done
  if (rhythm.active) { music.resume(); return; }
  music.start();
  rhythm.start();
  ui.rhud.classList.remove('hidden');
}
let loadId = 0, songLoading = false;
async function loadSong(read, label, kind = 'list') {
  const id = ++loadId;
  songLoading = true;
  stopMusic();
  selectedSong = null;
  songChosen = true;
  toast(`Finding the beat in ${label}…`);
  try {
    const bytes = await read();
    if (id !== loadId) return;
    // decodeAudioData detaches its input: keep file bytes for players who join later.
    const sharedBytes = kind === 'file' ? bytes.slice(0) : null;
    await music.load(bytes, label);
    if (id !== loadId) return;
    selectedSong = { id: `${net.id}:${++songVersion}`, name: label, kind, bytes: sharedBytes };
    if (entered && player.enabled) startMusic();
  } catch (err) {
    if (id !== loadId) return;
    console.warn('[rhythm] song failed', err);
    songChosen = false;
    toast(`Could not use ${label}: ${err.message}`, 4);
  } finally {
    if (id === loadId) songLoading = false;
  }
}
fetch('/music/index.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])).then((songs) => {
  songNames = songs.filter((name) => typeof name === 'string');
}).catch(() => {});
function selectListedSong(name, assetId) {
  if (songLoading || !songNames.includes(name)) return false;
  if (assetId && !station.setKineAsset(assetId)) return false;
  void loadSong(() => fetch(`/music/${encodeURIComponent(name)}`).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.arrayBuffer();
  }), name);
  return true;
}

// ---------- the world's story layer (the Moon garden's: intro scroll, song scrolls and mallets, ending, story sounds) ----------
// world.attach(ctx), if the world has one, runs once everything exists. It loads its own code (dynamic imports)
// and resolves to { enter(xr), update(dt, elapsed) }. If it fails, that's logged and the game goes on without it.
let story = null;
if (world.attach) {
  const ctx = {
    scene, renderer, camera, player, station, hands, music, rhythm, toast,
    resumeMusic: startMusic,
    canChooseSong: true,
    musicAuthority: !guest,
    get songLoading() { return guest ? musicSync.songLoading : songLoading; },
    clearSong() {
      if (guest) return;
      loadId++; songLoading = false; songChosen = false; selectedSong = null; stopMusic();
    },
    equipMallet(controller) {
      if (guest || station.mode === 'remote') return;
      if (controller) {
        station.setMode('vr'); station.attachToGrip(controller.grip); kineHand = controller;
        if (!player.roomScale) player.placeHeadAt(L.POUNDER_SPOT[0], L.POUNDER_SPOT[2] + 0.12);
        player.haptic(controller, 0.4, 40);
      } else takeDesktopKine();
    },
    // A guest's scroll asks the host; both follow the host's resulting song and clock.
    selectSong(name, assetId) {
      if (guest) return musicSync.pickSong(name, assetId);
      return selectListedSong(name, assetId);
    },
    songs: () => songNames,
    get audioContext() { return audio?.engine?.audioContext ?? ambience?.audioContext ?? null; },
    get entered() { return player.enabled && (renderer.xr.isPresenting || ui.overlay.classList.contains('hidden')); },
  };
  world.attach(ctx).then((s) => {
    story = s;
    if (player.enabled) story?.enter?.(renderer.xr.isPresenting);
    console.info('[story] ready');
  })
    .catch((err) => console.error('[story] failed to start; playing without it', err));
}
addEventListener('keydown', (e) => {
  if (!rhythm.active || e.repeat) return;
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    const ms = music.nudge(e.code === 'BracketLeft' ? -10 : 10);
    const avg = rhythm.meanErrMs;
    toast(`Timing offset ${ms > 0 ? '+' : ''}${ms} ms${avg == null ? '' : ` · your hits ~${Math.abs(Math.round(avg))} ms ${avg < 0 ? 'early' : 'late'}`}`, 1.6);
  }
});

// ---------- interaction ----------
const nearMortar = () => Math.hypot(player.head.x - L.USU.position[0], player.head.z - L.USU.position[2]) < L.POUNDING.takeRadius;
// Either headset can hold the kine (host, guest or solo; desktop E or VR grip). On the guest a take asks
// the host first (sync.takeKine -> sync.onKine below); the host and solo take it at once.
function takeDesktopKine() {
  station.setMode('desktop');
  player.lockAt([L.POUNDER_SPOT[0], 0, L.POUNDER_SPOT[2] + 0.02], 0, -0.62);
}
player.on('use', () => {
  if (story?.use?.(null)) return; // the story took the press (e.g. a song scroll you're looking at)
  if (renderer.xr.isPresenting) return;
  if (station.mode === 'remote') { toast('The other headset is holding the kine.', 1.6); return; }
  if (station.mode === 'desktop') {
    if (guest) { guestHolds = false; kineHand = null; sync.dropKine(); }
    station.setMode('idle');
    player.unlock();
    player.teleport(L.POUNDER_SPOT[0] + 0.9, L.POUNDER_SPOT[2] + 1.1, 0.4);
  } else if (nearMortar()) {
    if (!guest) takeDesktopKine();
    else if (!wantKine) { wantKine = { desktop: true }; wantSince = elapsed; sync.takeKine(); }
  }
});
player.on('strike', () => { if (station.mode === 'desktop') station.desktopSwing(); });
let kineHand = null;
// the guest's kine (multiplayer): asked of the host, which hands it over if nobody holds it; then it is
// held here exactly as on the host (VR mode: strikes are felt and counted on this headset at once)
// wantKine: the pending ask, a VR controller or { desktop: true } for the E key
let wantKine = null, wantSince = 0, guestHolds = false;
function guestDropKine() {
  if (station.mode === 'desktop') player.unlock();
  station.setMode('idle'); guestHolds = false; kineHand = null;
}
if (guest) {
  sync.onKine = (ok) => {
    if (ok && !guestHolds && wantKine && (wantKine.desktop ? !renderer.xr.isPresenting : renderer.xr.isPresenting)) {
      if (wantKine.desktop) takeDesktopKine();
      else {
        station.setMode('vr');
        station.attachToGrip(wantKine.grip);
        kineHand = wantKine;
        if (!player.roomScale) player.placeHeadAt(L.POUNDER_SPOT[0], L.POUNDER_SPOT[2] + 0.12);
        player.haptic(kineHand, 0.4, 40);
      }
      guestHolds = true;
    } else if (ok && !guestHolds) {
      sync.dropKine(); // granted after the ask timed out, or after switching between desktop and VR: give it back
    } else if (!ok) {
      if (wantKine?.desktop) toast('The other headset is holding the kine.', 1.6);
      else if (wantKine) player.haptic(wantKine, 0.2, 20); // someone else holds it
      if (guestHolds) {                                     // the host took it back
        guestDropKine();
        if (!renderer.xr.isPresenting) toast('The kine went back to the mortar.', 1.6);
      }
    }
    wantKine = null;
  };
}
player.on('xrselect', (c) => {
  if (story?.use?.(c)) return; // the story took the press (e.g. a song scroll within reach of this controller)
  if (guest) {
    if (guestHolds) { guestDropKine(); sync.dropKine(); }
    else if (station.mode === 'remote') player.haptic(c, 0.2, 20); // the host is holding it
    else if (nearMortar()) { wantKine = c; wantSince = elapsed; sync.takeKine(); }
    return;
  }
  if (station.mode === 'remote') { player.haptic(c, 0.2, 20); return; } // the other headset is holding it
  if (station.mode === 'vr') {
    station.setMode('idle');
    kineHand = null;
  } else if (nearMortar()) {
    station.setMode('vr');
    station.attachToGrip(c.grip);
    kineHand = c;
    if (!player.roomScale) player.placeHeadAt(L.POUNDER_SPOT[0], L.POUNDER_SPOT[2] + 0.12);
    player.haptic(c, 0.4, 40);
  }
});
player.on('step', ({ surface }) => {
  // one surface map on the player host, set before the event fires (the voice is `at player`)
  audio?.setHostSurface('player', surface);
  audio?.hostEvent('player', 'step');
});

// ---------- the station's moments -> sound and steam ----------
let batches = 0;
station.on('pound', ({ by, rushed }) => {
  audio?.hostEvent('usu', 'pound');
  doughSteam.intensity = Math.max(doughSteam.intensity, 0.5 * (1 - station.progress));
  if (!rushed && (by === 'player' || by === 'remote') && kineHand) player.haptic(kineHand, 0.75, 70);
});
// the mallet knocked the mortar, the ground or the turner's hand (src/kineContact.js): felt in the controller
station.on('kine_contact', ({ kind, speed }) => {
  if (kind !== 'hand' && kineHand) player.haptic(kineHand, Math.min(1, 0.35 + 0.15 * speed), 50);
});
station.on('hand-hit', () => {
  rhythm.penalizeHandHit(); player.warnHandHit();
  toast('Hands hit! −500 · combo lost', 2.5);
});
station.on('progress', (p) => audio?.signal('mochi_progress', p)); // after the pound that changed it
station.on('turn', () => audio?.hostEvent('usu', 'turn'));
station.on('dip', () => audio?.hostEvent('oke', 'dip'));
station.on('rice_drop', () => {
  audio?.hostEvent('usu', 'rice_drop');
  steam.burst(doughTop, 16, { spread: 0.3, size: 0.32, rise: 0.7 });
  doughSteam.intensity = 1;
});
station.on('rhythm', ({ rushed }) => {
  if (rushed) toast('Careful: hands were in the bowl!', 1.6);
});
station.on('batch_done', () => {
  batches++;
  toast(batches === 1 ? 'The mochi is ready!' : `Batch ${batches} done!`);
});

// ---------- frame loop (one loop, XR included) ----------
const timer = new THREE.Timer();
timer.connect(document); // ignores the gap while the tab is hidden
let elapsed = 0;
let promptText = '';
let qualityShown = null;
let mpShown = null;
if (guest) {
  ui.quality.disabled = true;
}
let handsGoneFor = Infinity; // s since hands were last tracked (VR)
let shownProgress = 0; // the world's progress effects (the Moon garden's) ease toward the batch's (the Moon wanes over a few s when a new batch starts)
renderer.setAnimationLoop((time) => {
  timer.update(time);
  const dt = Math.min(timer.getDelta(), 0.05);
  elapsed += dt;
  const xr = renderer.xr.isPresenting;
  player.updateXRPlacement();

  shownProgress += (station.progress - shownProgress) * (1 - Math.exp(-dt * 1.2));
  world.setProgress?.(shownProgress);
  world.update(dt, elapsed, player.head);
  story?.update?.(dt, elapsed);
  hands.update(dt);
  // whenever hands appear (after at least a second without them: a switch from controllers, not a tracking
  // blink), unless this person holds the kine: put them at the kneading spot facing the dough, so it is
  // right in front of them and within reach (there are no thumbsticks with hands). Not if they're already
  // standing there.
  if (!hands.any) handsGoneFor += dt;
  else {
    if (xr && !player.roomScale && handsGoneFor > 1 && !(guest ? guestHolds : station.mode === 'vr')) {
      // the other person already kneading at the west rim: this one goes to the north rim instead
      const other = sync?.otherHead;
      const spot = other && Math.hypot(other.x - L.KNEAD_SPOT[0], other.z - L.KNEAD_SPOT[2]) < 0.45 ? L.KNEAD_SPOT_FAR : L.KNEAD_SPOT;
      const there = Math.hypot(player.head.x - spot[0], player.head.z - spot[2]) < 0.25;
      if (!there) {
        player.placeHeadAt(spot[0], spot[2], L.USU.position);
        hands.jumped();
        console.info(`[hands] tracked: moved to the ${spot === L.KNEAD_SPOT ? '' : 'far '}kneading spot, facing the dough`);
      }
    }
    handsGoneFor = 0;
  }
  if (guest && wantKine && elapsed - wantSince > 1.5) { // no answer from the host
    if (wantKine.desktop) toast('The host did not answer; try again.', 1.8); else player.haptic(wantKine, 0.2, 20);
    wantKine = null;
  }
  station.update(dt, elapsed);
  sync?.update(dt);
  musicSync?.update();
  if (xr) station.updateVR(dt);
  rhythm.update(dt);
  doughMeters.update(player.enabled && !story?.blocked);

  doughSteam.intensity = Math.max(0, doughSteam.intensity - dt * 0.03);

  player.update(dt);
  steam.update(dt);

  audio?.update(camera);
  ambience?.update(dt, {
    active: player.enabled && (xr || ui.overlay.classList.contains('hidden')),
    reveal: story?.reveal ?? 1,
  });

  // HUD
  if (!xr) {
    ui.progress.style.width = `${Math.round(station.progress * 100)}%`;
    ui.batch.textContent = `batch ${batches + 1}`;
    let text = '';
    if (rhythm.active) {
      const songLabel = `♪ ${music.name} · ${rhythm.kneading ? 'Knead' : 'Strike'}`;
      if (ui.rSong.textContent !== songLabel) ui.rSong.textContent = songLabel;
      ui.rScore.textContent = rhythm.score.toLocaleString();
      ui.rMult.textContent = `×${rhythm.mult}`;
      ui.rCombo.textContent = `combo ${rhythm.combo}`;
      const avg = rhythm.meanErrMs;
      ui.rCal.textContent = avg == null ? '' : `${Math.abs(Math.round(avg))} ms ${avg < 0 ? 'early' : 'late'}`;
    }
    if (station.mode === 'desktop' && rhythm.active) {
      text = station.phase === 'pound' ? 'Strike as the ring meets the rim · [ ] timing · E hand back' : 'Fresh rice coming: a rest in the song…';
    } else if (station.mode === 'desktop') {
      text = station.phase === 'load' ? 'Fresh rice is coming…'
        : station.handsIn ? 'Wait: hands in the bowl…'
          : 'Click or Space to strike · E to hand the kine back';
    } else if (rhythm.active && rhythm.kneading && station.mode === 'remote') {
      text = station.phase === 'pound' ? 'Knead as the ring meets the rim, between the other player’s strikes · [ ] timing' : 'Fresh rice coming: a rest in the song…';
    } else if (nearMortar()) {
      text = station.mode === 'remote' ? 'The other player is holding the kine'
        : guest && wantKine ? 'Asking the host for the kine…' : 'Press E to take the kine (mallet)';
    }
    if (text !== promptText) { ui.prompt.textContent = text; promptText = text; }
    if (toastTimer > 0) { toastTimer -= dt; if (toastTimer <= 0) ui.toast.classList.remove('on'); }
  }

  // who is connected, next to the multiplayer menu
  {
    const t = !sync ? '' : !net.available ? 'needs the dev server (npm run dev)'
      : sync.role === 'host' ? (sync.peer ? 'the other headset has joined' : 'waiting for the other headset to join…')
        : (sync.peer ? `connected to the host · ${hostMusicStatus}` : 'waiting for the host…');
    if (t !== mpShown) { mpShown = t; ui.mpNote.textContent = t; }
  }
  // which dough tier is running, next to the menu
  if (station.dough.stats.tier !== qualityShown) {
    qualityShown = station.dough.stats.tier;
    ui.qualityNote.textContent = !qualityShown ? '' : guest ? `running ${qualityShown} (the host's dough)` : ui.quality.value
      ? `running ${qualityShown} (chosen; richer tiers can run in slow motion on the Quest)`
      : `running ${qualityShown} (picked for this device)`;
  }

  renderer.render(scene, camera);
});

// For quick inspection from the devtools console.
Object.assign(window, { mochi: { scene, station, player, world, music, rhythm, get audio() { return audio; } } });
