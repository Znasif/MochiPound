import * as THREE from 'three';
import * as L from './layout.js';
import { woodTexture, riceTexture } from './textures.js';
import { createDough } from './dough/dough.js';
import { createKineContact } from './kineContact.js';
import { makeUsu, usuShape } from './props.js';
import { MALLETS, makeSongMallet } from './moonGarden/story/mallets.js';
import { createConditioning } from './dough/conditioning.js';

// The pounding station: the usu, the kine, the dough and the hand-water bucket, nothing else (2026-11-15,
// the user's call when the Moon garden replaced the shrine courtyard: no NPC pounder, no rice carrier,
// no stove, steamer or table).
//
// A batch: fresh rice appears above the mortar and drops into it (rice_drop). Then whoever holds the kine
// strikes (pound) and a real person kneads between strikes with their tracked hands (src/hands.js): a palm
// slapping into the dough is a fold (turn), a hand in the bucket wets it (dip). After
// POUNDING.strikesPerBatch strikes the dough is smooth mochi (batch_done); it rises out of the mortar and
// floats away toward the Moon, and the next batch starts.
//
// Who swings the kine: the desktop player (click / Space), the VR player (a real downward swing of the
// controller), or the other headset (multiplayer, mode 'remote'). Nobody holding it is mode 'idle': it
// stands head-down beside the mortar. Every sound moment is emitted with `on(name, fn)` at the frame the
// physical contact happens, never on a separate timer.
//
// The dough itself is simulated (dough/: MLS-MPM elastoplastic clay ported from VR-Doh). The mallet
// head and the tracked hands' bones are colliders in it, and the mallet swings down to the dough's real
// surface. The old dome mesh (`mochi`) is only a stand-in while the fresh rice falls in and while the
// finished mochi floats away.

const RAISED = 1.95; // kine angle at the top of the lift (radians, handle swung up and back)
const RICE_FROM_Y = 1.75; // fresh rice appears this high above the mortar's axis and drops in
// the finished mochi floats off toward the Moon: azimuth 0, 24 degrees up (src/moonGarden.js; three.js -Z)
const FLOAT_DIR = new THREE.Vector3(0, Math.sin(24 * Math.PI / 180), -Math.cos(24 * Math.PI / 180));
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const lerp = THREE.MathUtils.lerp;
const ease = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

export function createStation(scene) {
  let hands = null; // tracked hands (src/hands.js), set by setHands
  const listeners = {};
  const emit = (name, data) => { for (const fn of listeners[name] ?? []) fn(data); };
  const conditioning = createConditioning();
  // multiplayer guest (src/sync.js): runs everything itself, but starts each batch phase when the host does
  let follower = false, hostPhase = null, hostPhaseAt = 0;
  const root = new THREE.Group();
  root.name = 'station';
  scene.add(root);

  // ---------- usu (mortar) ----------
  // built in src/props.js; the mallet's collisions (src/kineContact.js) are read from these same meshes
  const usuWood = woodTexture({ base: '#7a4a2a', dark: '#4a2a16', rings: true, seed: 4 });
  const usu = makeUsu({ radius: L.USU.radius, height: L.USU.height }, {
    side: new THREE.MeshStandardMaterial({ map: usuWood.side, roughness: 0.8, side: THREE.DoubleSide }),
    top: new THREE.MeshStandardMaterial({ map: usuWood.top, roughness: 0.75 }),
    band: new THREE.MeshStandardMaterial({ color: 0x2a2018, metalness: 0.5, roughness: 0.5 }),
    mat: new THREE.MeshLambertMaterial({ color: 0xb8a070 }),
  });
  usu.position.set(...L.USU.position);
  root.add(usu);

  // ---------- the dough: grainy rice that becomes smooth, glossy mochi ----------
  const mochi = new THREE.Group();
  mochi.name = 'mochi';
  root.add(mochi);
  const doughGeom = new THREE.SphereGeometry(0.25, 40, 24);
  const basePos = doughGeom.attributes.position.array.slice();
  const lumps = new Float32Array(basePos.length / 3);
  for (let i = 0; i < lumps.length; i++) lumps[i] = Math.random();
  const riceMat = new THREE.MeshStandardMaterial({ map: riceTexture(), roughness: 0.9, color: 0xf1ece0 });
  const smoothMat = new THREE.MeshStandardMaterial({ color: 0xfbfaf5, roughness: 0.32, transparent: true, opacity: 0 });
  const riceMesh = new THREE.Mesh(doughGeom, riceMat);
  const smoothMesh = new THREE.Mesh(doughGeom, smoothMat);
  smoothMesh.scale.setScalar(1.004);
  riceMesh.castShadow = true;
  mochi.add(riceMesh, smoothMesh);
  const doughRest = new THREE.Vector3(0, L.MOCHI_TOP_Y - 0.25 * 0.55, 0);
  mochi.position.copy(doughRest);
  mochi.scale.set(1, 0.55, 1);
  mochi.visible = false;

  const remoteQ = new THREE.Quaternion();
  // the simulated dough (MPM, in a worker) inside the mortar's carved bowl
  // (its mortar is the exact one drawn above, read back from the meshes, as the mallet's collision is)
  const dough = createDough(scene, { usu: usuShape(usu), map: riceMat.map });
  // Conditioning sweeps exactly one material parameter, Young's modulus (the user's call, 2026-11-15).
  // Moisture is a gameplay meter: it only decides whether elasticity is gained or lost. The dough's
  // wetness (tack and hand friction) stays the bucket dip's, as before: a dip wets it, strikes work it in.
  function applyMaterialState() {
    dough.setYoungsModulus(conditioning.youngsModulus);
  }
  applyMaterialState();
  const DOUGH_RADIUS = 0.14; // ~11 L of steamed rice
  const DOUGH_SPAWN_Y = 1.06; // the stand-in becomes simulated dough once it falls inside the simulation box
  const doughTop = () => dough.stats.topY ?? L.MOCHI_TOP_Y;
  const headCenter = new THREE.Vector3(), headQuat = new THREE.Quaternion();
  // the dry mallet is tacky (the dough tents up behind it), its size read from its mesh below; the
  // tracked hands' bones (tack 0) are added every frame
  const doughTools = [{ id: 'kine', kind: 'cylinder', center: headCenter, quat: headQuat, r: 0, h: 0, tack: 1 }];
  const frameTools = [];

  function shapeDough(progress) {
    const amp = 0.05 * Math.pow(1 - progress, 1.4);
    const a = doughGeom.attributes.position.array;
    for (let i = 0, v = 0; i < a.length; i += 3, v++) {
      const x = basePos[i], y = basePos[i + 1], z = basePos[i + 2];
      const n = Math.sin(x * 37 + lumps[v] * 6) * Math.sin(z * 41 + y * 23) * 0.5 + (lumps[v] - 0.5) * 0.8;
      const k = 1 + (n * amp) / 0.25;
      a[i] = x * k; a[i + 1] = y * k; a[i + 2] = z * k;
    }
    doughGeom.attributes.position.needsUpdate = true;
    doughGeom.computeVertexNormals();
    smoothMat.opacity = ease(clamp01((progress - 0.15) / 0.75));
    riceMat.roughness = lerp(0.9, 0.55, progress);
  }

  // ---------- kine (mallet) ----------
  const kineWood = new THREE.MeshStandardMaterial({ map: woodTexture({ base: '#b88a5a', dark: '#7a5432', seed: 17 }), roughness: 0.7 });
  const assetMaterials = {
    wood: kineWood,
    band: new THREE.MeshStandardMaterial({ color: 0xbda477, roughness: 0.8 }),
    log: new THREE.MeshStandardMaterial({ color: 0x795034, roughness: 0.9 }),
    wrap: new THREE.MeshStandardMaterial({ color: 0xd78894, roughness: 0.9 }),
  };
  const initialAsset = makeSongMallet('yokogine', assetMaterials);
  let kine = initialAsset.object3d, kineAssetId = 'yokogine';
  const kineAssets = new Map([[kineAssetId, initialAsset]]);
  // the current mallet's head (the dough feels it as this cylinder; its bottom cap is the striking face), its
  // hold in a VR hand, and optional custom poses (setKine: the Moon garden's song scrolls swap mallets)
  let kineHead = kine.getObjectByName('kine-head');
  const gripPos = new THREE.Vector3(0, -0.02, 0.06), gripRot = new THREE.Euler(-0.35, 0, 0);
  let customPose = null, customRest = null;
  root.add(kine);
  // the dough feels the head as the cylinder it is drawn as
  {
    const hp = kine.getObjectByName('kine-head').geometry.parameters;
    doughTools[0].r = hp.radiusTop; doughTools[0].h = hp.height / 2;
  }
  const kineHeadBottom = new THREE.Vector3(0, -doughTools[0].h, -L.KINE_LENGTH); // the striking face, kine-local (setKine recomputes it)
  // exact collisions of the kine with the mortar, the ground and the tracked hands (src/kineContact.js),
  // read from the meshes themselves
  const groundMesh = scene.getObjectByName('ground');
  let kineContact = createKineContact({ kine, usu, ground: groundMesh });
  // where hands count as "in the bowl" (a strike then is "rushed"): over the mortar's top, from its rim plate's
  // outer edge inward, up to one mallet-head height above it
  const shape = usuShape(usu);
  const rimR = Math.max(...shape.poly.filter((q) => q[1] >= Math.max(...shape.poly.map((p) => p[1])) - 1e-9).map((q) => q[0]));
  let zoneTop = shape.top + 2 * doughTools[0].h;
  const inZone = (p) => Math.hypot(p.x - shape.x, p.z - shape.z) < rimR && p.y < zoneTop;
  const pivotStrike = v3(L.KINE_PIVOT_STRIKE), pivotRaised = v3(L.KINE_PIVOT_RAISED);
  let kineLift = 0.45; // 0 = head on the dough, 1 = fully raised
  function poseKine(lift) {
    kineLift = lift;
    if (customPose) { customPose(kine, lift, THREE.MathUtils.clamp(doughTop() + 0.16 - 0.08, 0.73, L.KINE_PIVOT_STRIKE[1])); return; }
    // at the bottom of the swing the head presses 8 cm into the dough under it (its first contact);
    // the handle stays above the rim
    pivotStrike.y = THREE.MathUtils.clamp(doughTop() + 0.16 - 0.08, 0.73, L.KINE_PIVOT_STRIKE[1]);
    kine.position.lerpVectors(pivotStrike, pivotRaised, ease(clamp01(lift)));
    kine.rotation.set(lift * RAISED, 0, 0);
  }
  // nobody holds it: it stands head-down on the ground beside the mortar (east side, clear of the kneader
  // on the west and of the pounder's spot), the head on its side and the handle straight up. The pose is
  // the kine's pivot (the hands) above the head centre by KINE_LENGTH; the head's lowest point on the ground.
  function restPose() { // every idle frame, so a hand that bumps it lets it fall back into place
    if (customRest) { customRest(kine); return; }
    kine.position.set(L.KINE_REST[0], L.KINE_LENGTH + doughTools[0].r + 0.003, L.KINE_REST[2]);
    kine.rotation.set(-Math.PI / 2, 0, 0);
  }
  function poseRest() { // putting it down
    kineLift = 1; // a desktop player who takes it starts from the top of the swing
    restPose();
    kineContact.reset(); // no sweep from the hands to here
  }
  poseRest();

  // Swap the mallet (the Moon garden's song scrolls, src/moonGarden/story/). `next` is a Group posed like the
  // kine: its direct children are CylinderGeometry / TorusGeometry meshes (kineContact collides exactly those,
  // anything else is only drawn) and one CylinderGeometry named 'kine-head', which the dough feels as that
  // cylinder; the bottom cap of the head (its local -Y) is the striking face. opts:
  //   grip { position, rotation }: how a VR hand holds it (grip space; default the yokogine's)
  //   pose(kine, lift, strikeY): the desktop swing, lift 0 (head on the dough) .. 1 (raised); default the yokogine's
  //   rest(kine): where it stands when nobody holds it; default head-down beside the mortar (yokogine-shaped)
  // Returns the mallet it replaced (so the caller can dispose or keep it).
  function setKine(next, opts = {}) {
    const prev = kine, parent = prev.parent ?? root;
    next.position.copy(prev.position); next.quaternion.copy(prev.quaternion);
    parent.add(next); prev.removeFromParent();
    kine = next;
    kineAssetId = opts.assetId ?? next.userData.assetId ?? null;
    kine.userData.assetId = kineAssetId;
    kineHead = next.getObjectByName('kine-head');
    const P = kineHead.geometry.parameters;
    doughTools[0].r = Math.max(P.radiusTop, P.radiusBottom); doughTools[0].h = P.height / 2;
    zoneTop = shape.top + P.height;
    kineHead.updateMatrix();
    kineHeadBottom.set(0, -P.height / 2, 0).applyMatrix4(kineHead.matrix); // the face's centre, kine-local
    gripPos.copy(opts.grip?.position ?? new THREE.Vector3(0, -0.02, 0.06));
    gripRot.copy(opts.grip?.rotation ?? new THREE.Euler(-0.35, 0, 0));
    customPose = opts.pose ?? null; customRest = opts.rest ?? null;
    kineContact = createKineContact({ kine, usu, ground: groundMesh });
    if (st.vr.grip) { kine.position.copy(gripPos); kine.rotation.copy(gripRot); }
    else if (st.mode === 'idle') restPose();
    else poseKine(kineLift);
    st.swing = null; st.vr.ready = false;
    if (st.mode === 'remote') { st.remoteKine = null; st._remoteEased = false; }
    kineContact.reset();
    emit('kine-asset', { assetId: kineAssetId });
    return prev;
  }

  // Stable catalog IDs cross the network; meshes, materials, grips and colliders are built locally.
  function setKineAsset(assetId) {
    if (!MALLETS.some((m) => m.id === assetId)) return false;
    if (kineAssetId === assetId) return true;
    let asset = kineAssets.get(assetId);
    if (!asset) { asset = makeSongMallet(assetId, assetMaterials); kineAssets.set(assetId, asset); }
    setKine(asset.object3d, asset.options);
    return true;
  }

  // An ending (the Moon garden's: the mochi flies to the Earth, src/moonGarden/story/) takes over the done
  // phase from the plain float-away: { begin(from: Vector3), done: boolean }. begin is called once the dough
  // is lifted out (1.2 s after the last strike), with the dough's centre; the next batch waits for done.
  let ending = null, storyBlocked = false;

  // ---------- oke (hand-water bucket) ----------
  const oke = new THREE.Group();
  oke.name = 'oke';
  oke.position.set(...L.OKE.position);
  root.add(oke);
  {
    const { radius: r, height: h, stand } = L.OKE;
    const standMesh = new THREE.Mesh(new THREE.BoxGeometry(r * 2.3, stand, r * 2.3), new THREE.MeshLambertMaterial({ map: woodTexture({ base: '#6a4a2c', dark: '#3a2616', seed: 29 }) }));
    standMesh.position.y = stand / 2;
    standMesh.castShadow = standMesh.receiveShadow = true;
    oke.add(standMesh);
    const tubGroup = new THREE.Group();
    tubGroup.position.y = stand;
    oke.add(tubGroup);
    const tub = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.88, h, 18, 1, true), new THREE.MeshLambertMaterial({ map: woodTexture({ base: '#c8a06a', dark: '#8a6a40', seed: 23 }), side: THREE.DoubleSide }));
    tub.position.y = h / 2;
    tubGroup.add(tub);
    const bottom = new THREE.Mesh(new THREE.CircleGeometry(r * 0.88, 18), new THREE.MeshLambertMaterial({ color: 0x6a4a2a }));
    bottom.rotation.x = -Math.PI / 2;
    bottom.position.y = 0.01;
    tubGroup.add(bottom);
    for (const y of [0.05, h - 0.05]) {
      const hoop = new THREE.Mesh(new THREE.TorusGeometry(r * (y > 0.1 ? 1.0 : 0.9) + 0.005, 0.008, 5, 18), new THREE.MeshLambertMaterial({ color: 0x1e3a2a }));
      hoop.rotation.x = Math.PI / 2;
      hoop.position.y = y;
      tubGroup.add(hoop);
    }
    const water = new THREE.Mesh(new THREE.CircleGeometry(r * 0.97, 18), new THREE.MeshStandardMaterial({ color: 0x24384a, roughness: 0.1, metalness: 0.2 }));
    water.rotation.x = -Math.PI / 2;
    water.position.y = h - 0.06;
    tubGroup.add(water);
  }
  const okeWater = v3(L.OKE.position).add(new THREE.Vector3(0, L.OKE.stand + L.OKE.height - 0.06, 0));

  // ---------- spots ----------
  // where the kneading person stands (the old turner NPC's spot); also the Satie fixture host 'turner'
  const kneelSpot = new THREE.Object3D();
  kneelSpot.name = 'turner';
  kneelSpot.position.set(...L.TURNER_SPOT);
  root.add(kneelSpot);

  const colliders = {
    circles: [
      { x: L.USU.position[0], z: L.USU.position[2], r: L.USU.radius + 0.12 },
      { x: L.OKE.position[0], z: L.OKE.position[2], r: L.OKE.radius + 0.1 },
    ],
    dynamic: [], // nothing moves at the station any more (main.js still concatenates it)
  };

  // ---------- batch state ----------
  const st = {
    phase: 'load', t: 0, step: 0,
    progress: 0, strikes: 0,
    mode: 'idle', // 'idle' (nobody holds the kine) | 'desktop' | 'vr' | 'remote' (the other headset)
    lastStrikeAt: -10, clock: 0,
    handsIn: false, // a tracked hand is in the bowl
    slap: [{ inside: false }, { inside: false }], dipping: false, // per-hand dough contact, hand in the bucket
    swing: null, // desktop swing { t, from }
    vr: { grip: null, armed: true, prevHead: new THREE.Vector3(), vel: 0, ready: false },
    _fall: null, _land: null, _dropped: false, _lifted: false, _liftFrom: null,
    rhythm: null, // rhythm mode (rhythm/rhythm.js); with nobody to play it, notes only sound when someone strikes
  };
  const tmp = new THREE.Vector3();
  const riceFrom = new THREE.Vector3(L.USU.position[0], RICE_FROM_Y, L.USU.position[2]);
  let lastHandHit = -Infinity, handHitSequence = 0;
  const receivedHits = new Set();

  function recordSuccessfulAction(event) {
    if (follower || storyBlocked || st.phase !== 'pound' || !conditioning.reward(event)) return false;
    applyMaterialState(); emit('conditioning', conditioning.snapshot());
    return true;
  }
  function freePlaySuccess(action) {
    recordSuccessfulAction({ action, epoch: conditioning.snapshot().epoch, id: `physical:${Math.floor(st.clock * 10)}`, kind: 'good' });
  }
  function reportHandHit() {
    if (follower || storyBlocked || st.phase !== 'pound' || st.mode === 'idle' || st.clock - lastHandHit < 0.65) return;
    lastHandHit = st.clock;
    emit('hand-hit', { id: `${conditioning.snapshot().epoch}:${++handHitSequence}`, epoch: conditioning.snapshot().epoch });
  }

  // ---------- strike handling (shared by desktop, VR and the other headset) ----------
  function contact(by, strength = 1) {
    if (storyBlocked || st.phase !== 'pound') return;
    const interval = st.clock - st.lastStrikeAt;
    const rushed = st.handsIn;
    st.lastStrikeAt = st.clock;
    // fire first, then move the signal the strike changes (the event reads the signal as it fires)
    emit('pound', { by, strength, rushed, interval, progress: st.progress });
    dough.setWetness(dough.wetness * 0.6); // the water from the last dip is worked in
    if (!st.rhythm && !rushed) freePlaySuccess('strike');
    st.strikes += rushed ? 0.5 : 1;
    st.progress = clamp01(st.strikes / L.POUNDING.strikesPerBatch);
    shapeDough(st.progress);
    dough.setProgress(st.progress);
    emit('progress', st.progress);
    {
      const [lo, hi] = L.POUNDING.goodIntervalS;
      emit('rhythm', { good: !rushed && interval >= lo && interval <= hi, rushed, interval });
    }
    if (st.progress >= 1 && !follower) { st.phase = 'done'; st.t = 0; st.step = 0; emit('batch_done'); emit('phase', 'done'); }
  }

  // ---------- the kneading hands: in the bowl, slapping the dough, dipping in the bucket ----------
  const okeR = L.OKE.radius * 0.97; // the water's surface disc (drawn below)
  function updateHands() {
    st.handsIn = false;
    if (!hands) return;
    for (const sp of hands.spheres) if (inZone(sp.center)) { st.handsIn = true; break; }
    // a palm coming into the dough fast is a fold or a slap (the turner's 'turn' sound). Thresholds are
    // for the sound only: into the drawn surface (density 0.5) at 0.3 m/s or more; out again below 0.25
    for (const h of hands.hands) {
      const sl = (st.slap[h.i] ??= { inside: false });
      if (!h.tracked) { sl.inside = false; continue; }
      const d = dough.densityAt(h.palm);
      if (!sl.inside && d >= 0.5) {
        sl.inside = true;
        if (h.palmSpeed >= 0.3 && st.phase === 'pound' && !storyBlocked) {
          emit('turn', { hand: h.i, speed: h.palmSpeed });
          if (!st.rhythm) freePlaySuccess('knead');
        }
      } else if (sl.inside && d < 0.25) sl.inside = false;
    }
    // a hand in the bucket's water wets the hands, and the dough they work (dip)
    let wet = false;
    for (const sp of hands.spheres) {
      if (Math.hypot(sp.center.x - okeWater.x, sp.center.z - okeWater.z) < okeR && sp.center.y < okeWater.y) { wet = true; break; }
    }
    if (wet && !st.dipping) {
      emit('dip');
      dough.setWetness(1);
      if (!follower && st.phase === 'pound') { conditioning.water(); applyMaterialState(); emit('conditioning', conditioning.snapshot()); }
    }
    st.dipping = wet;
  }

  // ---------- per-frame ----------
  function update(dt, t) {
    st.clock += dt;
    if (follower) followHost();
    st.t += dt;
    updateHands();
    if (st.phase === 'load') updateLoad(dt);
    else if (st.phase === 'pound') updatePound(dt);
    else if (st.phase === 'done') updateDone(dt);
    if (!follower && !storyBlocked && st.phase === 'pound') { conditioning.update(dt); applyMaterialState(); }

    // the kine against the mortar, the ground and the tracked hands' joints; in VR it starts from where
    // the controller holds it each frame, so a blocked swing springs back to the hand once clear
    if (st.mode === 'idle') restPose();
    else if (st.vr.grip) { kine.position.copy(gripPos); kine.rotation.copy(gripRot); }
    // the other headset holds it (multiplayer): posed where that person's hand holds it
    else if (st.mode === 'remote' && st.remoteKine) {
      // eased toward the latest pose from the network (~45 a second, uneven), so it glides instead of stepping
      tmp.fromArray(st.remoteKine, 0); remoteQ.fromArray(st.remoteKine, 3);
      if (!st._remoteEased) { kine.position.copy(tmp); kine.quaternion.copy(remoteQ); st._remoteEased = true; }
      else { const a = 1 - Math.exp(-dt * 25); kine.position.lerp(tmp, a); kine.quaternion.slerp(remoteQ, a); }
    }
    const knock = kineContact.resolve(kine, hands ? hands.spheres : [], dt);
    if (knock) { if (knock.kind === 'hand') reportHandHit(); emit('kine_contact', knock); }
    if (st.mode === 'remote' && st.remoteKine && st.phase === 'pound') swingStrike(dt, 'remote');

    feedDough(dt);
  }

  // colliders for the dough: the mallet head (wherever it is: the NPC's hands, a player's, the other
  // headset's) and all the tracked hands' bones (this headset's and the other's)
  function feedDough(dt) {
    kine.updateMatrixWorld(true);
    kineHead.getWorldPosition(headCenter);
    kineHead.getWorldQuaternion(headQuat);
    frameTools.length = 0;
    frameTools.push(doughTools[0]);
    if (hands) for (const t of hands.tools) frameTools.push(t);
    dough.update(dt, frameTools, st.progress);
  }

  function updatePound(dt) {
    if (st.mode === 'desktop') updateDesktopSwing(dt);
  }

  function updateDesktopSwing(dt) {
    const s = st.swing;
    if (!s) { poseKine(Math.min(1, kineLift + dt * 2.2)); return; }
    s.t += dt;
    if (s.stage === 'down') {
      const k = clamp01(s.t / (st.rhythm ? 0.05 : 0.16));
      poseKine(s.from * (1 - k * k));
      if (k >= 1) { s.stage = 'rest'; s.t = 0; contact('player', 1); }
    } else if (s.stage === 'rest') {
      poseKine(0);
      if (s.t > 0.1) { st.swing = null; }
    }
  }

  // ---------- load: fresh rice appears above the mortar and drops in ----------
  function updateLoad(dt) {
    const T = st.t;
    if (st.mode === 'desktop') poseKine(Math.min(1, kineLift + dt * 2));
    if (st.step === 0) {
      // a breath after the last batch, then the rice gathers above the mortar
      if (T >= 0.6) {
        st.step = 1; st.t = 0;
        mochi.visible = true;
        st.progress = 0; st.strikes = 0;
        shapeDough(0);
        dough.setProgress(0);
        mochi.position.copy(riceFrom);
        mochi.scale.setScalar(0.001);
      }
    } else if (st.step === 1) {
      // it swells into a lump of steamed rice and hangs there a moment
      const k = ease(clamp01(T / 0.45));
      mochi.scale.set(0.8 * k + 0.001, 0.5 * k + 0.001, 0.8 * k + 0.001);
      mochi.position.copy(riceFrom);
      if (T >= 0.65) { st.step = 2; st.t = 0; st._fall = 0; mochi.scale.set(0.8, 0.5, 0.8); }
    } else if (st.step === 2) {
      // it falls straight in; inside the simulation box it hands over to the real dough at the same speed
      if (mochi.visible && st._fall !== null) {
        st._fall += dt;
        mochi.position.copy(riceFrom);
        mochi.position.y -= 4.9 * st._fall * st._fall;
        if (mochi.position.y <= DOUGH_SPAWN_Y) {
          const at = mochi.position.clone().setY(DOUGH_SPAWN_Y);
          dough.setWetness(0); applyMaterialState();
          // a guest whose dough the host's already arrived in (the host got here first) doesn't add a second
          if (!(follower && dough.stats.count > 0)) dough.spawn(at, DOUGH_RADIUS, [0, -9.8 * st._fall, 0]);
          mochi.visible = false;
          st._fall = null;
          st._land = { t: 0, from: dough.stats.fresh, fell: false };
        }
      }
      if (st._land) {
        // rice_drop when the simulated dough actually lands in the bowl (its mean fall speed collapses)
        const L2 = st._land, s2 = dough.stats;
        L2.t += dt;
        if (s2.fresh > L2.from + 1 && s2.count > 0) {
          if (s2.meanVy < -0.8) L2.fell = true;
          if ((L2.fell && s2.meanVy > -0.3) || L2.t > 1.2) {
            st._land = null;
            st._dropped = true;
            emit('rice_drop', v3(L.USU.position).setY(doughTop()));
            emit('progress', 0);
          }
        } else if (L2.t > 1.5) { st._land = null; st._dropped = true; emit('rice_drop', v3(L.USU.position).setY(L.MOCHI_TOP_Y)); emit('progress', 0); }
      }
      if (st._dropped && T >= 0.3 && (!follower || hostPhase === 'pound')) { enterPound(); if (!follower) emit('phase', 'pound'); }
    }
  }

  // ---------- done: the finished mochi rises out of the mortar and floats away toward the Moon ----------
  function updateDone(dt) {
    const T = st.t;
    if (st.mode === 'desktop') poseKine(Math.min(1, kineLift + dt * 2));
    if (T > 1.2 && !st._lifted) {
      // the stand-in takes over from the simulated dough (or the ending does)
      st._lifted = true;
      st._liftFrom = dough.stats.count ? dough.stats.centroid.clone() : doughRest.clone();
      dough.clear();
      if (ending) { st._ending = ending; ending.begin(st._liftFrom.clone()); }
      else {
        shapeDough(1);
        mochi.visible = true;
        mochi.position.copy(st._liftFrom);
      }
    }
    if (st._ending) {
      if (st._ending.done && (!follower || hostPhase === 'load')) { st._ending = null; enterLoad(); if (!follower) emit('phase', 'load'); }
      return;
    }
    if (st._lifted && mochi.visible) {
      const k = clamp01((T - 1.2) / 2.4);
      // up out of the bowl first, then away along the Moon's direction, shrinking into the sky
      mochi.position.copy(st._liftFrom).addScaledVector(FLOAT_DIR, ease(k) * 4);
      mochi.position.y += Math.sin(Math.min(1, k * 2) * Math.PI * 0.5) * 0.5;
      const sc = 0.7 * (1 - ease(clamp01((k - 0.3) / 0.7))) + 0.001;
      mochi.scale.set(sc, 0.55 * sc, sc);
      if (k >= 1) mochi.visible = false;
    }
    if (T >= 4.2 && (!follower || hostPhase === 'load')) { enterLoad(); if (!follower) emit('phase', 'load'); }
  }

  // ---------- player control ----------
  function setMode(mode) {
    if (mode === 'remote') { st.vr.armed = true; st.vr.ready = false; }
    if (mode === st.mode) return;
    if (st.vr.grip && mode !== 'vr') detachFromGrip();
    st.mode = mode;
    st.swing = null;
    if (mode === 'idle') poseRest();
  }
  function desktopSwing() {
    if (storyBlocked || st.mode !== 'desktop' || st.phase !== 'pound' || st.swing) return false;
    if (kineLift < 0.55) return false; // still lifting from the last strike
    st.swing = { t: 0, from: kineLift, stage: 'down' };
    return true;
  }
  // VR: the kine rides in the right hand; a real downward swing onto the dough is a strike.
  function attachToGrip(grip) {
    st.vr.grip = grip;
    grip.add(kine);
    kine.position.copy(gripPos);
    kine.rotation.copy(gripRot);
    st.vr.armed = true;
    st.vr.ready = false;
  }
  function detachFromGrip() {
    root.add(kine);
    st.vr.grip = null;
    poseKine(1);
  }
  const headWorld = new THREE.Vector3();
  function updateVR(dt) {
    if (st.mode !== 'vr' || !st.vr.grip) return null;
    return swingStrike(dt, 'player');
  }
  // a real downward swing of a held kine onto the dough is a strike (this headset's hand, or the other's)
  function swingStrike(dt, by) {
    kine.updateMatrixWorld(true);
    kine.localToWorld(headWorld.copy(kineHeadBottom));
    const vy = st.vr.ready ? (headWorld.y - st.vr.prevHead.y) / Math.max(dt, 1e-3) : 0;
    st.vr.prevHead.copy(headWorld);
    st.vr.ready = true;
    const horiz = Math.hypot(headWorld.x - L.USU.position[0], headWorld.z - L.USU.position[2]);
    let hit = null;
    if (st.vr.armed && horiz < L.USU.radius * 0.85 && headWorld.y < doughTop() + 0.02 && vy < -1.1) {
      st.vr.armed = false;
      const strength = clamp01((-vy - 1.1) / 3.5) * 0.6 + 0.4;
      hit = strength;
      contact(by, strength);
    }
    if (!st.vr.armed && headWorld.y > doughTop() + 0.25) st.vr.armed = true;
    return hit;
  }

  // ---------- multiplayer: the host is the clock for the batch phases (src/sync.js) ----------
  const r4 = (v) => Math.round(v * 1e4) / 1e4;
  function enterLoad() {
    if (!follower) { conditioning.reset(); applyMaterialState(); emit('conditioning', conditioning.snapshot()); }
    st.phase = 'load'; st.t = 0; st.step = 0; st._fall = null; st._land = null; st._dropped = false; st._lifted = false; st._ending = null;
  }
  function enterPound() {
    st.phase = 'pound'; st.t = 0; st.step = 0;
    st.lastStrikeAt = st.clock;
  }
  // a follower that has to jump to the host's phase (it joined mid-batch, or fell well behind): tidy up
  // what the phase it leaves was doing
  function jumpTo(phase) {
    if (st.phase === 'load') {
      mochi.visible = false; st._fall = null; st._land = null;
      if (phase !== 'load' && dough.stats.count === 0) { // the rice it would have dropped
        dough.setWetness(0); applyMaterialState();
        dough.spawn(doughRest.clone().setY(DOUGH_SPAWN_Y), DOUGH_RADIUS, [0, 0, 0]);
        st.progress = 0; st.strikes = 0; shapeDough(0); dough.setProgress(0);
      }
    } else if (st.phase === 'done' && phase !== 'done') {
      if (dough.stats.count) dough.clear();
      mochi.visible = false;
    }
    if (phase === 'load') enterLoad();
    else if (phase === 'pound') enterPound();
    else if (phase === 'done') { st.phase = 'done'; st.t = 0; st.step = 0; emit('batch_done'); }
    console.info(`[mp] caught up with the host: ${phase}`);
  }
  // the follower's phase against the host's: the next phase waits for this headset's own natural end
  // (it started the phase a moment after the host); more than 1.5 s behind, or out of step, it jumps.
  // Pounding ends when the host's batch does, whatever this headset counted.
  const NEXT = { load: 'pound', pound: 'done', done: 'load' };
  function followHost() {
    if (!hostPhase || hostPhase === st.phase) return;
    if (hostPhase === NEXT[st.phase] && st.phase !== 'pound' && st.clock - hostPhaseAt < 1.5) return;
    jumpTo(hostPhase);
  }

  shapeDough(0);
  return {
    root, usu, oke, mochi, kneelSpot, colliders, dough,
    setHands(h) { hands = h; },
    on(name, fn) { (listeners[name] ??= []).push(fn); },
    // multiplayer (src/sync.js). Guest: start each batch phase when the host does (the host emits 'phase').
    setFollower(v) { follower = v; },
    get conditioning() { return conditioning.snapshot(); },
    recordSuccessfulAction,
    applyConditioning(state) { if (follower && conditioning.apply(state)) applyMaterialState(); },
    reportHandHit,
    receiveHandHit(event) {
      if (!follower || !event || typeof event.id !== 'string' || event.epoch < conditioning.snapshot().epoch || receivedHits.has(event.id)) return;
      receivedHits.add(event.id);
      if (receivedHits.size > 256) receivedHits.delete(receivedHits.values().next().value);
      emit('hand-hit', event);
    },
    followPhase(phase) { if (phase !== hostPhase) { hostPhase = phase; hostPhaseAt = st.clock; } },
    // the kine held in the other headset's hand (its pose, or null), and where this headset holds it (to send)
    setRemoteKine(pose) { st.remoteKine = pose; if (!pose) st._remoteEased = false; },
    heldKineTarget() {
      if (st.mode === 'desktop') { kine.updateMatrixWorld(true); const p = kine.getWorldPosition(new THREE.Vector3()), q = kine.getWorldQuaternion(new THREE.Quaternion()); return [...p.toArray(), ...q.toArray()].map(r4); }
      if (!st.vr.grip) return null;
      st.vr.grip.updateMatrixWorld(true);
      const m = new THREE.Matrix4().compose(gripPos, new THREE.Quaternion().setFromEuler(gripRot), new THREE.Vector3(1, 1, 1));
      m.premultiply(st.vr.grip.matrixWorld);
      const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      m.decompose(p, q, sc);
      return [...p.toArray(), ...q.toArray()].map(r4);
    },
    update(dt, t) { update(dt, t); },
    updateVR,
    setMode, desktopSwing, attachToGrip, detachFromGrip,
    setKine, // swap the mallet (see setKine above)
    setKineAsset,
    get kineAssetId() { return kineAssetId; },
    setEnding(e) { ending = e; }, // an ending for the done phase (see above), or null for the float-away
    setStoryBlocked(v) { storyBlocked = !!v; if (v) { st.swing = null; st.vr.ready = false; } },
    get kine() { return kine; },
    // rhythm mode: { time(), nextStrike(t), prevStrike(t) } or null
    setRhythm(provider) {
      st.rhythm = provider;
    },
    get mode() { return st.mode; },
    get phase() { return st.phase; },
    get progress() { return st.progress; },
    get handsIn() { return st.handsIn; },
    get kineLift() { return kineLift; },
  };
}
