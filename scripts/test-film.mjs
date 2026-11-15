// Headless checks for the film camera's takes (src/film/): the WebM muxer's file parses back as valid Matroska,
// the timeline interpolates exactly between samples, the clock sync recovers each sender's capture time from
// jittery messages, and a played-back dough snapshot draws the same field as the simulation it came from.
// The browser parts (WebCodecs encoding, the render loop) are not covered here.
//   node --test scripts/test-film.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createWebmMuxer, WEBM_IDS as ID } from '../src/film/webm.js';
import { createTimeline, lerpDough } from '../src/film/timeline.js';
import { createPeerClocks, createRecorder } from '../src/film/recorder.js';
import { DoughSim, TIERS, tierOptions } from '../src/dough/mpm-core.js';
import { makeUsu, usuShape } from '../src/props.js';

// ---- a small EBML reader, to check the muxer's output
function readVint(b, i, keepMarker) {
  const first = b[i];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  assert.ok(len <= 8, `bad vint at ${i}`);
  let v = keepMarker ? first : first & (0xff >> len);
  for (let k = 1; k < len; k++) v = v * 256 + b[i + k];
  return { v, len };
}
function parse(b, start = 0, end = b.length) {
  const out = [];
  for (let i = start; i < end;) {
    const id = readVint(b, i, true), size = readVint(b, i + id.len, false);
    const body = i + id.len + size.len;
    out.push({ id: id.v, at: i, body, size: size.v, end: body + size.v });
    i = body + size.v;
  }
  assert.equal(out.at(-1)?.end ?? start, end, 'elements fill their parent exactly');
  return out;
}
const uint = (b, e) => { let v = 0; for (let i = e.body; i < e.end; i++) v = v * 256 + b[i]; return v; };
const child = (b, e, id) => parse(b, e.body, e.end).find((c) => c.id === id);

test('the WebM muxer writes a well-formed, seekable file', () => {
  const fps = 60, muxer = createWebmMuxer({ width: 1920, height: 1080, codec: 'V_VP9', fps });
  const frames = [];
  for (let i = 0; i < 300; i++) {
    const data = new Uint8Array(50 + (i % 7)).fill(i & 0xff), key = i % 120 === 0;
    frames.push({ data, ms: Math.round((i * 1e6 / fps) / 1000), key });
    muxer.add(data, Math.round(i * 1e6 / fps), key);
  }
  const parts = muxer.finish(), b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { b.set(p, o); o += p.length; }
  const top = parse(b);
  assert.deepEqual(top.map((e) => e.id), [ID.EBML, ID.Segment]);
  assert.equal(new TextDecoder().decode(b.subarray(child(b, top[0], ID.DocType).body, child(b, top[0], ID.DocType).end)), 'webm');
  const seg = top[1], kids = parse(b, seg.body, seg.end);
  assert.deepEqual([...new Set(kids.map((e) => e.id))], [ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues]);
  // the SeekHead's positions land on the elements it names
  for (const seek of parse(b, kids[0].body, kids[0].end)) {
    const sid = child(b, seek, ID.SeekID), spos = child(b, seek, ID.SeekPosition);
    const id = readVint(b, sid.body, true).v, at = seg.body + uint(b, spos);
    assert.equal(readVint(b, at, true).v, id, 'SeekHead points at its element');
  }
  const track = child(b, child(b, kids.find((e) => e.id === ID.Tracks), ID.TrackEntry), ID.Video);
  assert.equal(uint(b, child(b, track, ID.PixelWidth)), 1920); assert.equal(uint(b, child(b, track, ID.PixelHeight)), 1080);
  // every frame comes back, in order, with its timestamp and keyframe flag
  const clusters = kids.filter((e) => e.id === ID.Cluster), back = [];
  for (const c of clusters) {
    const base = uint(b, child(b, c, ID.Timestamp));
    for (const blk of parse(b, c.body, c.end).filter((e) => e.id === ID.SimpleBlock)) {
      const rel = (b[blk.body + 1] << 8 | b[blk.body + 2]) << 16 >> 16;
      back.push({ ms: base + rel, key: !!(b[blk.body + 3] & 0x80), len: blk.size - 4, byte: b[blk.body + 4] });
    }
  }
  assert.equal(back.length, frames.length);
  back.forEach((f, i) => { assert.equal(f.ms, frames[i].ms); assert.equal(f.key, frames[i].key); assert.equal(f.len, frames[i].data.length); assert.equal(f.byte, i & 0xff); });
  assert.equal(clusters.length, 3, 'a cluster per keyframe');
  // the Cues point at the clusters
  const cues = parse(b, kids.at(-1).body, kids.at(-1).end);
  cues.forEach((cp, k) => {
    const pos = uint(b, child(b, child(b, cp, ID.CueTrackPositions), ID.CueClusterPosition));
    assert.equal(seg.body + pos, clusters[k].at, 'cue -> cluster');
    assert.equal(uint(b, child(b, cp, ID.CueTime)), uint(b, child(b, clusters[k], ID.Timestamp)));
  });
  assert.throws(() => createWebmMuxer({ width: 2, height: 2 }).add(new Uint8Array(1), 0, false), /keyframe/);
});

const pose = (t) => [Math.sin(t / 300), 1.6, t / 1000, 0, Math.sin(t / 4000), 0, Math.cos(t / 4000)];
const hand = (t) => { const a = new Float32Array(26 * 4); for (let i = 0; i < a.length; i++) a[i] = i % 4 === 3 ? 0.01 : t / 1000 + i * 0.001; a[8] = NaN; return a; };

test('the timeline interpolates poses, hands, the dough and the camera exactly, and leaves gaps empty', () => {
  const events = [];
  for (let t = 0; t <= 2000; t += 1000 / 45) events.push({ t, role: 'host', type: 'pose', data: { head: pose(t), hands: [hand(t), null], kine: [0, 1, t / 1000, 0, 0, 0, 1], assetId: 'yokogine', effectors: {} } });
  for (let t = 3000; t <= 4000; t += 1000 / 45) events.push({ t, role: 'join', type: 'pose', data: { head: pose(t), hands: [null, null], kine: null, effectors: {} } });
  const x = (k) => Int16Array.from({ length: 30 }, (_, i) => i * 100 + k), v = (k) => new Int16Array(30).fill(k);
  for (let k = 0; k < 4; k++) events.push({ t: k * 100, role: 'host', type: 'dough', data: { tier: 'tiny', N: 10, x: x(k * 30), v: v(k), coh: k / 10 } });
  events.push({ t: 500, role: 'host', type: 'phase', data: { phase: 'done' } }, { t: 1000, role: 'join', type: 'judge', data: { kind: 'good' } });
  const take = { t0: 0, t1: 4000, events: events.sort((a, b) => a.t - b.t),
    camera: [{ t: 0, p: [0, 1, 0], q: [0, 0, 0, 1], fov: 60 }, { t: 1000, p: [1, 1, 0], q: [0, 0, 0, 1], fov: 40 }] };
  const tl = createTimeline(take);
  const p = tl.pose('host', 1234.5), a = Math.floor(1234.5 / (1000 / 45)) * (1000 / 45), u = (1234.5 - a) / (1000 / 45);
  const expected = pose(a)[0] + (pose(a + 1000 / 45)[0] - pose(a)[0]) * u;
  assert.ok(Math.abs(p.head[0] - expected) < 1e-9, 'positions lerp between the two samples around the moment');
  assert.ok(Math.abs(p.head[2] - 1.2345) < 1e-9);
  assert.ok(Math.abs(Math.hypot(...p.head.slice(3)) - 1) < 1e-9, 'rotations stay unit');
  assert.ok(Math.abs(p.kine[2] - 1.2345) < 1e-9, 'the kine too');
  assert.ok(Math.abs(p.hands[0][0] - 1.2345) < 1e-6, 'hand joints lerp');
  assert.ok(Number.isNaN(p.hands[0][8]), 'an untracked joint stays untracked');
  assert.equal(p.hands[1], null);
  assert.equal(tl.pose('host', 2600), null, 'the host gone (no samples within 0.4 s)');
  assert.equal(tl.pose('join', 1000), null, 'the guest not there yet');
  assert.ok(tl.pose('join', 3500), 'the guest later');
  const d = tl.dough(150);
  assert.equal(d.x[0], 45, 'dough particles lerp'); assert.ok(Math.abs(d.coh - 0.15) < 1e-9, 'and its look');
  assert.equal(tl.dough(900), null, 'no dough snapshot near 0.9 s');
  const c = tl.camera(500);
  assert.deepEqual(c.p.map((n) => Math.round(n * 1e9) / 1e9), [0.5, 1, 0]); assert.equal(c.fov, 50);
  assert.equal(tl.camera(9000).fov, 40, 'held at the end');
  assert.deepEqual(tl.between(0, 999).map((e) => e.type), ['phase']);
  assert.deepEqual(tl.between(500, 1000).map((e) => e.type), ['judge'], 'from < t <= to');
  assert.equal(lerpDough({ tier: 'tiny', N: 3, x: x(0), v: v(0) }, { tier: 'tiny', N: 4, x: x(0), v: v(0) }, 0.7).N, 4, 'different particle counts: the nearer sample');
});

test('a take puts each message at its sender\'s capture time, despite clock offsets and network jitter', () => {
  let now = 1000;
  const taps = [], sent = [];
  const net = { id: 'cam', send(type, data) { sent.push({ type, data }); }, tap(fn) { taps.push(fn); } };
  const deliver = (type, data, m) => taps.forEach((fn) => fn(type, data, m));
  const clocks = createPeerClocks(net, { now: () => now, every: 1e9 });
  const hostOffset = 5000; // the host's clock runs 5 s ahead of this page's
  const jitter = (i) => 10 + ((i * 37) % 70); // 10-80 ms one way
  for (let i = 0; i < 20; i++) { // ping, and the host's pong arrives after its uneven network trip
    clocks.ping(); const ping = sent.at(-1).data, out = jitter(i), back = jitter(i + 7);
    now += out; const t1 = now + hostOffset; now += back;
    deliver('clock-pong', { to: 'cam', t0: ping.t0, t1 }, { from: 'host-id', role: 'host' });
    now += 200;
  }
  assert.ok(Math.abs(clocks.offset('host-id') - hostOffset) <= clocks.rtt('host-id') / 2 + 1e-9, `offset ${clocks.offset('host-id')} within half the best round trip`);
  const rec = createRecorder({ net, clocks, now: () => now, decodeHands: (h) => h ?? [null, null], unpackDough: (d) => d, rateEvery: 1e9 });
  rec.start();
  assert.ok(sent.some((m) => m.type === 'film-rate'), 'asks the players for full rates');
  const captured = [];
  for (let i = 0; i < 50; i++) {
    const capture = now; captured.push(capture);
    const delay = jitter(i * 3);
    now += delay; // it arrives late, by an uneven amount
    deliver('pose', { head: pose(i), hands: [null, null] }, { from: 'host-id', role: 'host', at: capture + hostOffset });
    now += 16 - delay > 0 ? 16 - delay : 1;
  }
  deliver('pose', {}, { from: 'other', role: 'watch', at: now }); // another camera: not recorded
  const take = rec.stop();
  const poses = take.events.filter((e) => e.type === 'pose');
  assert.equal(poses.length, 50);
  const worst = Math.max(...poses.map((e, i) => Math.abs(e.t - captured[i])));
  assert.ok(worst <= clocks.rtt('host-id') / 2 + 1e-9, `every sample at its capture time (worst ${worst.toFixed(1)} ms off; arrival was up to 80 ms late)`);
  assert.ok(take.t1 > take.t0);
});

test('a played-back dough snapshot draws the field its simulation drew', () => {
  const plain = new THREE.MeshBasicMaterial();
  const usu = usuShape(makeUsu({ radius: 0.42, height: 0.7 }, { side: plain, top: plain, band: plain, mat: plain }));
  const tier = TIERS.find((t) => t.name === 'tiny');
  const live = new DoughSim(tierOptions(tier, { usu })), shown = new DoughSim(tierOptions(tier, { usu }));
  live.spawnSphere([0.05, 1.06, -0.03], 0.14, [0, -2.2, 0]);
  for (let i = 0; i < 90; i++) live.step(1 / 60, []);
  const axis = { x: 0, z: 0, r: 0.1 }, a = new Float32Array(live.n3), b = new Float32Array(shown.n3);
  live.writeField(a, axis);
  const snap = live.snapshot();
  // the worker's 'show': place the particles exactly, a 10 us step (for each particle's measured density), the field
  shown.correct(snap.N, snap.xq, snap.vq, 1); shown.step(1e-5, []);
  const s = shown.writeField(b, axis);
  assert.equal(s.count, live.N);
  let worst = 0; for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  assert.ok(worst < 0.02, `fields agree (worst density difference ${worst.toFixed(4)})`);
});
