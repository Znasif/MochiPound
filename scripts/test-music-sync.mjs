import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import * as THREE from 'three';
import { createMusicLead, createMusicFollow } from '../src/musicSync.js';
import { strikesFromBeats, kneadsFromStrikes } from '../src/rhythm/beats.js';
import { createRhythm } from '../src/rhythm/rhythm.js';
import { createMusic } from '../src/rhythm/music.js';

const analysis = { beats: [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4], strength: [2, 1, 2, 1, 2, 1, 2, 1], period: 0.5, duration: 4.5, bpm: 120 };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('kneading alternates halfway between host strikes, at either pace and across the loop', () => {
  for (const every of [1, 2]) {
    const strikes = strikesFromBeats(analysis, every);
    const kneads = kneadsFromStrikes(strikes, analysis.duration);
    for (let i = 0; i < strikes.length; i++) {
      const next = strikes[i + 1] ?? strikes[0] + analysis.duration;
      assert.ok(kneads.includes(((strikes[i] + next) / 2) % analysis.duration));
    }
    assert.ok(kneads.every((t) => !strikes.includes(t)));
  }
  assert.deepEqual(kneadsFromStrikes([], 4), []);
  assert.deepEqual(kneadsFromStrikes([0.1, 0.8], 1), [0.45, 0.9500000000000001]);
});

test('host music follows late joins, guest entry, pause/resume, drift, files, song changes and disconnects', async () => {
  let time = 0;
  const clock = mock.method(performance, 'now', () => time * 1000);
  const fetches = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url) => {
    fetches.push(url);
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  });
  const queue = [], peers = [];
  const makeNet = (role) => {
    const callbacks = new Map();
    const net = {
      id: role, role,
      on(type, fn) { callbacks.set(type, fn); },
      send(type, data) {
        for (const other of peers) if (other.net !== net) queue.push({ at: time + 0.02, other, type, data, peer: { from: net.id, role } });
      },
    };
    peers.push({ net, callbacks });
    return net;
  };
  const makeMusic = () => {
    let pos = 0, at = 0;
    return {
      ctx: { state: 'running' }, playing: false, analysis: null, name: '', starts: 0, loads: [],
      position() { return this.playing ? pos + (this.ctx.state === 'running' ? time - at : 0) : null; },
      playFrom(p) { this.starts++; this.playing = true; pos = p; at = time; this.ctx.state = 'running'; },
      async load(bytes, name, a) { this.loads.push({ name, bytes: new Uint8Array(bytes), analysis: a }); this.analysis = a; this.name = name; return a; },
      pause() { if (this.ctx.state === 'running') { pos = this.position(); this.ctx.state = 'suspended'; } },
      stop() { this.playing = false; },
    };
  };
  const hostNet = makeNet('host'), guestNet = makeNet('join');
  const hostMusic = makeMusic(), guestMusic = makeMusic();
  const hostRhythm = { every: 2 }, guestRhythm = {
    active: false, every: 1,
    start(every) { this.active = true; this.every = every; }, stop() { this.active = false; },
  };
  let song = { id: 'first', name: 'First song.mp3', kind: 'list' }, canPlay = false, active = false, status = '';
  hostMusic.analysis = analysis;
  hostMusic.playFrom(17.2); // a guest arriving while a song is already playing
  let choosing = false, picks = 0;
  const lead = createMusicLead({
    net: hostNet, music: hostMusic, rhythm: hostRhythm, song: () => song, isLoading: () => choosing,
    onPick(name) {
      if (choosing || name !== 'Requested.mp3') return false;
      choosing = true; picks++; return true;
    },
  });
  const follow = createMusicFollow({
    net: guestNet, music: guestMusic, rhythm: guestRhythm, canPlay: () => canPlay,
    onActive: (v) => { active = v; }, onStatus: (v) => { status = v; },
  });
  const advance = async (seconds, hostPresent = true) => {
    for (let i = 0; i < Math.ceil(seconds / 0.01); i++) {
      time += 0.01;
      if (hostPresent) lead.update();
      for (let j = queue.length - 1; j >= 0; j--) {
        if (queue[j].at > time) continue;
        const m = queue.splice(j, 1)[0];
        m.other.callbacks.get(m.type)?.(m.data, m.peer);
      }
      follow.update();
      await settle();
    }
  };
  try {
    await advance(0.5);
    assert.equal(guestMusic.loads.length, 1);
    assert.deepEqual(guestMusic.analysis, analysis);
    assert.equal(guestMusic.playing, false, 'wait for a user gesture on the joining device');
    canPlay = true;
    await advance(2);
    assert.equal(active, true);
    assert.equal(guestRhythm.every, 2);
    assert.ok(Math.abs(hostMusic.position() - guestMusic.position()) < 0.04);
    assert.match(status, /First song/);

    assert.equal(follow.pickSong('Requested.mp3'), true, 'guest may choose an in-world scroll while a song plays');
    assert.equal(follow.songLoading, true);
    assert.equal(follow.pickSong('Requested.mp3'), false, 'one request at a time');
    await advance(0.2);
    assert.equal(picks, 1);
    assert.equal(follow.songLoading, true, 'wait while the host loads the requested song');
    song = { id: 'requested', name: 'Requested.mp3', kind: 'list' };
    choosing = false; hostMusic.playFrom(0);
    await advance(0.4);
    assert.equal(guestMusic.name, 'Requested.mp3');
    assert.equal(follow.songLoading, false);
    assert.ok(Math.abs(hostMusic.position() - guestMusic.position()) < 0.04);
    assert.equal(follow.pickSong('Missing.mp3'), true);
    await advance(0.2);
    assert.equal(follow.songLoading, false, 'a rejected request releases the guest’s scroll controls');
    assert.equal(picks, 1);

    hostMusic.pause();
    await advance(0.5);
    assert.equal(guestMusic.ctx.state, 'suspended');
    const paused = guestMusic.position();
    await advance(0.5);
    assert.equal(guestMusic.position(), paused);
    hostMusic.playFrom(32);
    await advance(0.5);
    assert.equal(guestMusic.ctx.state, 'running');
    assert.ok(Math.abs(hostMusic.position() - guestMusic.position()) < 0.04);

    guestMusic.playFrom(1); // simulate a device clock discontinuity
    await advance(0.1);
    assert.ok(Math.abs(hostMusic.position() - guestMusic.position()) < 0.04);
    canPlay = false;
    await advance(0.2);
    assert.equal(guestMusic.ctx.state, 'suspended');
    canPlay = true;
    await advance(0.2);
    assert.ok(Math.abs(hostMusic.position() - guestMusic.position()) < 0.04);

    const bytes = Uint8Array.from({ length: 150_000 }, (_, i) => i % 251);
    song = { id: 'upload', name: 'Uploaded.wav', kind: 'file', bytes: bytes.buffer };
    hostMusic.playFrom(0); hostRhythm.every = 1;
    await advance(1);
    assert.equal(guestMusic.name, song.name);
    assert.deepEqual(guestMusic.loads.at(-1).bytes, bytes);
    assert.equal(fetches.length, 2, 'uploaded songs come from the host, not public/music');
    assert.equal(guestRhythm.every, 1);
    assert.ok(Math.abs(hostMusic.position() - guestMusic.position()) < 0.04);

    song = { ...song, id: 'upload-again', bytes: new Uint8Array([9, 8, 7]).buffer };
    await advance(0.5);
    assert.deepEqual(guestMusic.loads.at(-1).bytes, new Uint8Array([9, 8, 7]), 'a same-named replacement is still a new song');

    song = null; hostMusic.stop();
    await advance(0.2);
    assert.equal(active, false);
    assert.equal(guestMusic.playing, false);
    song = { id: 'next', name: 'Next.mp3', kind: 'list' }; hostMusic.playFrom(7);
    await advance(0.5);
    assert.equal(active, true);
    await advance(3.5, false);
    assert.equal(active, false);
    assert.equal(guestMusic.playing, false);
    await advance(1);
    assert.equal(guestMusic.name, 'Next.mp3');
    assert.equal(active, true, 'reconnect follows the current host again');
  } finally { lead.dispose(); clock.mock.restore(); fetchMock.mock.restore(); }
});

test('host audio interruption and stopped VR frames keep the shared music clock alive', async () => {
  let time = 0, heartbeat;
  const clock = mock.method(performance, 'now', () => time * 1000);
  const interval = mock.method(globalThis, 'setInterval', (fn) => { heartbeat = fn; return { unref() {} }; });
  const clear = mock.method(globalThis, 'clearInterval', () => {});
  const original = globalThis.AudioContext;
  class AudioContext extends EventTarget {
    state = 'running'; currentTime = 10;
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    createBufferSource() { return { connect() {}, disconnect() {}, start() {}, stop() {} }; }
    async decodeAudioData() { return { duration: analysis.duration }; }
    async suspend() { this.state = 'suspended'; this.dispatchEvent(new Event('statechange')); }
    async resume() { this.state = 'running'; this.dispatchEvent(new Event('statechange')); }
  }
  globalThis.AudioContext = AudioContext;
  let lead;
  try {
    const music = createMusic({ keepAlive: true });
    await music.load(new ArrayBuffer(0), 'Host song', analysis);
    music.start(12); music.ctx.currentTime += 1;
    const before = music.position(), messages = [];
    lead = createMusicLead({
      net: { on() {}, send(type, d) { if (type === 'music-state') messages.push(d); } },
      music, rhythm: { every: 2 }, song: () => ({ id: 'song', name: music.name, kind: 'list' }),
    });
    await music.ctx.suspend(); // Quest temporarily suspends audio when the host headset is removed
    for (let i = 0; i < 6; i++) { time++; heartbeat(); } // no render-loop updates at all
    assert.equal(music.paused, false);
    assert.equal(music.position(), before + 6);
    assert.equal(messages.length, 6);
    assert.ok(messages.every((m) => m.state === 'playing'));
    assert.equal(messages.at(-1).pos, before + 6);
    await music.ctx.resume();
    assert.ok(Math.abs(music.position() - before - 6) < 1e-9, 'host seeks to the continuing shared timeline on return');

    music.pause();
    const pausedAt = music.position(); time += 5; heartbeat();
    assert.equal(music.position(), pausedAt, 'an explicit pause still freezes the clock');
    assert.equal(messages.at(-1).state, 'paused');

    const solo = createMusic();
    await solo.load(new ArrayBuffer(0), 'Solo song', analysis); solo.start();
    await solo.ctx.suspend(); const soloAt = solo.position(); time += 5;
    assert.equal(solo.position(), soloAt, 'solo retains its existing pause behavior');
  } finally {
    lead?.dispose(); clock.mock.restore(); interval.mock.restore(); clear.mock.restore();
    if (original === undefined) delete globalThis.AudioContext; else globalThis.AudioContext = original;
  }
});

test('guest judges local folds on alternating cues; host judges only local strikes', () => {
  const original = globalThis.document;
  globalThis.document = { createElement: () => ({ getContext: () => ({ strokeText() {}, fillText() {} }) }) };
  const station = (mode) => {
    const listeners = {};
    return {
      mode, phase: 'pound',
      on(name, fn) { listeners[name] = fn; },
      emit(name, d) { listeners[name]?.(d); },
      setRhythm() {},
    };
  };
  let t = 0.75;
  const music = { analysis, time: () => t };
  try {
    const guestStation = station('remote'), guestScene = new THREE.Scene();
    const guest = createRhythm({ scene: guestScene, station: guestStation, music, kneading: true });
    guest.start(2); guest.update(0.01);
    assert.equal(guestScene.children.filter((m) => m.isMesh && m.visible).length, 3, 'rim and two separate upcoming knead rings');
    t = 1;
    guestStation.emit('pound', { by: 'remote' });
    assert.equal(guest.score, 0);
    guestStation.emit('turn', { hand: 2 });
    assert.equal(guest.score, 0, 'remote hands do not judge guest notes');
    guestStation.emit('turn', { hand: 0 });
    assert.equal(guest.counts.perfect, 1);
    guestStation.emit('turn', { hand: 1 });
    assert.equal(guest.combo, 1, 'two palms entering together count as one fold');
    t = 1.75; guest.update(0.01); t = 2;
    guestStation.emit('turn', { hand: 1 });
    assert.equal(guest.counts.perfect, 2);
    assert.equal(guest.combo, 2);

    const hostStation = station('desktop');
    const host = createRhythm({ scene: new THREE.Scene(), station: hostStation, music });
    t = 0.4; host.start(2); host.update(0.01); t = 0.5;
    hostStation.emit('pound', { by: 'remote' });
    assert.equal(host.score, 0);
    hostStation.emit('pound', { by: 'player', rushed: false });
    assert.equal(host.counts.perfect, 1);
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});
