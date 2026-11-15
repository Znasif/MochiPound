// State/geometry regression checks. No renderer, dough worker, audio synthesis or screenshots.
// Canvas metrics are a stand-in: this does not verify fonts, shaders or headset appearance.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createMoonStory } from '../src/moonGarden/story/index.js';
import { createStoryText } from '../src/moonGarden/story/text.js';
import { MALLETS, makeSongMallet } from '../src/moonGarden/story/mallets.js';
import { makeKine } from '../src/props.js';
import { createSongScrolls } from '../src/moonGarden/story/songScrolls.js';

const keyHandlers = new Set();
globalThis.addEventListener = (type, handler) => { if (type === 'keydown') keyHandlers.add(handler); };
globalThis.removeEventListener = (type, handler) => keyHandlers.delete(handler);
globalThis.FontFace = class { async load() { return this; } };
globalThis.document = {
  fonts: { add() {} },
  createElement(tag) {
    assert.equal(tag, 'canvas');
    return { width: 0, height: 0, getContext: () => ({
      fillText() {}, measureText: (s) => ({ width: Array.from(s).length * 52, actualBoundingBoxAscent: 70 }),
    }) };
  },
};

const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
camera.position.set(0.9, 1.62, 3.1); scene.add(camera);
const unity = new THREE.Group(); unity.scale.z = -1; scene.add(unity);
const earthLight = { bright: 1, pulse: 0, city: 0 };
const earthU = new THREE.Vector3(-80, 85, 100);
const garden = {
  unity, haloTexture: new THREE.Texture(), earthLight,
  earth: { position: new THREE.Vector3(-80, 85, -100), positionU: earthU, radius: 8 },
  moon: { positionU: new THREE.Vector3(0, 70, 150) },
  setEarthLight(v, pulse = 0, city = 0) { Object.assign(earthLight, { bright: v, pulse, city }); },
  setViewer() {}, toUnity(v, out = new THREE.Vector3()) { return out.set(v.x, v.y, -v.z); },
};
const wood = new THREE.MeshStandardMaterial(), band = new THREE.MeshStandardMaterial();
let ending, blocked = false, swapped = null, selectionCount = 0, canPick = true, songLoading = false;
const station = {
  kine: makeKine(0.85, { wood, band }), phase: 'pound', mode: 'idle',
  setEnding(value) { ending = value; },
  setStoryBlocked(value) { blocked = value; },
  setKine(value, opts) { this.kine = value; swapped = { value, opts }; },
  setKineAsset(id) { const asset = makeSongMallet(id, { wood, band }); this.setKine(asset.object3d, asset.options); return true; },
};
let resumed = 0;
const music = { playing: false, name: '', setVolume() {}, pause() {}, stop() { this.playing = false; } };
const songs = ['Skrillex_-_Bangarang_feat._Sirah_(mp3.pm).mp3', 'Imagine_Dragons_-_Believer_rus_lyrics_(mp3.pm).mp3', 'PSY - Gangnam Style.mp3'];
const ctx = {
  scene, camera, station, garden, music, rhythm: { stop() {} }, renderer: { xr: { isPresenting: false } },
  hands: { hands: [] }, toast() {}, songs: () => songs,
  storySoundOptions: { soundsEnabled: false, prewarm: false },
  selectSong() { selectionCount++; return canPick; },
  resumeMusic() { resumed++; },
  entered: true, audioContext: null,
  get songLoading() { return songLoading; },
};
const story = await createMoonStory(ctx);
assert.ok(ending, 'ending must be attached');
const tick = (seconds) => { for (let i = 0; i < Math.ceil(seconds * 60); i++) story.update(1 / 60, i / 60); };
const scrolls = () => scene.children.filter((o) => o.name.startsWith('Song scroll:'));

story.enter(false);
assert.equal(story.blocked, true); assert.equal(blocked, true); assert.equal(earthLight.bright, 0);
tick(2);
assert.equal(scrolls().length, 3, 'the song list may arrive after story attachment');
assert.ok(scrolls().every((o) => !o.visible), 'choices wait until after the intro');
let consumed = false;
for (const handler of keyHandlers) handler({ code: 'Space', repeat: false, preventDefault() {}, stopImmediatePropagation() { consumed = true; } });
assert.ok(consumed, 'skip must intercept the strike key');
tick(1.6);
assert.equal(story.blocked, false); assert.equal(blocked, false); assert.equal(earthLight.bright, 1); assert.equal(resumed, 1);
tick(2);
assert.ok(scrolls().every((o) => o.visible && Math.hypot(o.position.x, o.position.z) >= 1.6));
story.enter(false);
assert.equal(story.blocked, false, 'resuming desktop must not replay the intro');

// Looking at a distant scroll cannot consume E; looking at one in range swaps its mallet.
const target = scrolls()[0]; camera.position.copy(target.position).add(new THREE.Vector3(0, 0, 3)); camera.lookAt(target.position); camera.updateMatrixWorld(true);
assert.equal(story.use(null), false);
camera.position.z -= 1.5; camera.lookAt(target.position); camera.updateMatrixWorld(true);
canPick = false; assert.equal(story.use(null), true); assert.equal(swapped, null, 'rejected selection cannot swap tools');
canPick = true; assert.equal(story.use(null), true); assert.equal(swapped.value.name, 'tteokme'); assert.equal(selectionCount, 2);

// Scrolls stay visible while loading and playing; pending loads cannot send extra selections.
songLoading = true; tick(3); assert.ok(scrolls().every((o) => o.visible));
const selectionsBeforeLoading = selectionCount;
assert.equal(story.use(null), false); assert.equal(selectionCount, selectionsBeforeLoading);
songLoading = false; tick(2); assert.ok(scrolls().every((o) => o.visible));
music.playing = true; music.name = songs[0]; tick(1);
assert.ok(scrolls().every((o) => o.visible), 'playback does not hide the in-world song choices');
assert.equal(story.use(null), true, 'a different song can be chosen during playback');
music.playing = false;

// Guests can choose while the host holds the mallet, including with tracked hands. Selecting
// must leave the host-held mallet alone and must not grant control of the shared audio lifecycle.
{
  const guestScene = new THREE.Scene(), guestCamera = new THREE.PerspectiveCamera();
  guestCamera.position.set(-0.6, 1.62, -0.06); guestScene.add(guestCamera);
  let guestLoading = false, guestChoices = 0;
  const guestMusic = { playing: false, name: '', setVolume() { throw new Error('guest cannot fade shared music'); }, stop() { throw new Error('guest cannot stop shared music'); } };
  const guestStation = { kine: makeKine(0.85, { wood, band }), phase: 'pound', mode: 'remote', setKineAsset() { throw new Error('guest requests a change through the host'); } };
  const guestHands = [];
  const guestScrolls = createSongScrolls({
    ...ctx, scene: guestScene, camera: guestCamera, station: guestStation, music: guestMusic,
    renderer: { xr: { isPresenting: true } }, hands: { hands: guestHands }, sounds: {},
    flow: { introActive: false, ending: { active: false } }, canChooseSong: true, musicAuthority: false,
    get songLoading() { return guestLoading; },
    selectSong(name) { assert.ok(songs.includes(name)); guestChoices++; guestLoading = true; return true; },
  });
  const guestTick = (seconds) => { for (let i = 0; i < Math.ceil(seconds * 60); i++) guestScrolls.update(1 / 60); };
  guestTick(2);
  const choices = guestScene.children.filter((o) => o.name.startsWith('Song scroll:'));
  assert.ok(choices.every((o) => o.visible));
  const grip = new THREE.Group(); grip.position.copy(choices[0].position); grip.updateMatrixWorld(true);
  assert.equal(guestScrolls.use({ grip }), true); assert.equal(guestChoices, 1);
  guestTick(1); assert.ok(choices.every((o) => o.visible));
  assert.equal(guestScrolls.use({ grip }), false); // host still loading
  guestLoading = false; guestMusic.playing = true; guestMusic.name = songs[0]; guestTick(1);
  const pinch = (remote) => ({ remote, tracked: true, joints: new Map([
    ['thumb-tip', { center: choices[1].position.clone() }],
    ['index-finger-tip', { center: choices[1].position.clone().add(new THREE.Vector3(0.01, 0, 0)) }],
  ]) });
  guestHands.push(pinch(true)); guestTick(0.1); assert.equal(guestChoices, 1, 'remote hands cannot select local scrolls');
  guestHands.push(pinch(false)); guestTick(0.1); assert.equal(guestChoices, 2);
  guestLoading = false; guestTick(1); assert.equal(guestChoices, 2, 'holding a pinch does not repeatedly change songs');
  guestStation.phase = 'done'; guestTick(2); // guest follows the host's stop; it does not run its own fade
  assert.equal(guestMusic.playing, true);
}

// End a batch before any prior ending update and follow it through to the replayed intro.
station.phase = 'done'; ending.begin(new THREE.Vector3(0, 0.9, 0));
const orb = unity.getObjectByName('MR_MochiOrb');
assert.ok(orb.visible && Number.isFinite(orb.scale.x) && orb.scale.x < 1, 'first-frame orb size uses the current camera');
assert.equal(ending.done, false); tick(6);
assert.ok(earthLight.pulse > 0 && earthLight.city > 0, 'arrival lights up the Earth');
tick(9);
assert.equal(ending.done, true); assert.equal(story.blocked, true, 'ending reset restarts the intro');
assert.equal(earthLight.bright, 0, 'ending reset fade must yield the Earth to the new intro');
assert.equal(story.use(null), true); tick(1.6);
assert.equal(earthLight.bright, 1); tick(2);
assert.equal(earthLight.bright, 1, 'the old fade cannot dim the newly revealed Earth');

// A full unskipped VR intro completes, too. An existing held pinch needs 0.35 seconds to skip.
ctx.renderer.xr.isPresenting = true; story.enter(true); assert.equal(story.blocked, true);
tick(40); assert.equal(story.blocked, false);
ending.begin(new THREE.Vector3(0, 0.9, 0)); tick(15); assert.equal(story.blocked, true);
ctx.hands.hands.push({ tracked: true, remote: false, joints: new Map([
  ['thumb-tip', { center: new THREE.Vector3() }], ['index-finger-tip', { center: new THREE.Vector3(0.01, 0, 0) }],
]) });
tick(0.2); assert.equal(story.blocked, true); tick(1.8); assert.equal(story.blocked, false);

// All mallets expose the real cylinder the dough collides with; the desktop face reaches the same height.
for (const type of MALLETS) {
  const { object3d, options } = makeSongMallet(type.id, { wood, band });
  assert.equal(object3d.userData.assetId, type.id); assert.equal(options.assetId, type.id);
  const head = object3d.getObjectByName('kine-head');
  assert.equal(head.parent, object3d); assert.equal(head.geometry.type, 'CylinderGeometry');
  assert.ok(object3d.children.every((m) => ['CylinderGeometry', 'TorusGeometry'].includes(m.geometry.type)));
  if (options.pose) {
    options.pose(object3d, 0, 0.95); object3d.updateMatrixWorld(true);
    const face = head.localToWorld(new THREE.Vector3(0, -head.geometry.parameters.height / 2, 0));
    assert.ok(Math.abs(face.y - 0.79) < 1e-6 && Math.hypot(face.x, face.z) < 1e-6, `${type.label} face reaches the dough`);
  }
}

const text = createStoryText(); text.setText('A line\nwith emphasis', 7); text.setAlpha(1); text.update(1);
assert.ok(text.revealDuration <= 1.6); assert.ok(text.object3d.children[0].geometry.getAttribute('position').count > 0);
text.beginExit(); text.update(text.exitDuration); text.dispose();
console.info('Moon story checks passed: intro, skip keys/pinch, scroll selection/failure, mallets, ending/reset and Earth ownership.');
