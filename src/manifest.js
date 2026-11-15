import * as L from './layout.js';

// The Satie scene manifest (satie.scene/v1 `scene`), built from the same layout numbers the
// meshes use. scripts/write-contract.mjs writes it to public/satie/scene.contract.json for the
// runtime; the same object is what satie_inspect_scene receives.

const r3 = (a) => a.map((v) => Math.round(v * 1000) / 1000);

export function buildManifest() {
  const seiroCentre = [L.SEIRO.position[0], L.KAMADO.size[1] + 0.12 + L.SEIRO.size[1] / 2, L.SEIRO.position[2]];
  return {
    engine: 'threejs',
    unitsPerMeter: 1,
    listener: 'first_person',
    player: 'player',
    environment: {
      setting: "A Shinto shrine courtyard on New Year's Eve: a mochitsuki (rice-pounding) stall in front of the shrine hall",
      time: 'Night, about 23:00',
      weather: 'Light snow falling, cold still air, barely any wind',
      ground: 'Gravel with a thin dusting of fresh snow; a flagstone path from the gate (south) to the stall',
      enclosure: 'Open air inside a low 1.1 m plaster wall (38 x 37 m), a ring of tall cedars around it, the wooden shrine hall 12 m north of the mortar',
      notes: 'The heart of the scene is the wooden mortar (usu) at the origin: a pounder swings a heavy wooden mallet (kine) into steamed glutinous rice while a kneeling turner folds the dough between strikes. A red-and-white curtained stall (fabric, 11 m wide, 2.6 m tall) stands 3.6 m behind it. A bonfire burns 8 m to the south-west. There is no audience: only the three workers at the station. Paper lanterns, stone lanterns and snow are silent.',
    },
    objects: [
      { id: 'usu', label: 'mortar (usu)', position: r3([0, L.USU.height / 2, 0]), sizeM: r3([L.USU.radius * 2, L.USU.height, L.USU.radius * 2]), material: 'wood (heavy keyaki stump, bowl carved in the top)', motion: 'static', role: 'pounding mortar', notes: 'Every strike, fold and rice drop happens here. The dough rests in the bowl, its top at 0.8 m.' },
      { id: 'oke', label: 'hand-water bucket', position: r3([L.OKE.position[0], L.OKE.stand + L.OKE.height / 2, L.OKE.position[2]]), sizeM: r3([L.OKE.radius * 2, L.OKE.height, L.OKE.radius * 2]), material: 'wood, filled with water', motion: 'static', notes: 'On a 0.3 m wooden stand at the turner\'s left. The turner wets their hand in it every third fold.' },
      { id: 'seiro', label: 'rice steamer stack', position: r3(seiroCentre), sizeM: r3([L.SEIRO.size[0], L.SEIRO.size[1] + 0.05, L.SEIRO.size[2]]), material: 'wooden steamer boxes over a pot of boiling water', motion: 'static', notes: 'Steam rises from it all the time. Once per batch the helper lifts the top box off and carries it to the mortar.' },
      { id: 'kamado', label: 'clay stove', position: r3([L.KAMADO.position[0], L.KAMADO.size[1] / 2, L.KAMADO.position[2]]), sizeM: r3(L.KAMADO.size), material: 'clay', motion: 'static', notes: 'A wood fire burns in its firebox; the mouth faces +Z, toward the path. A pot of water boils under the steamer.' },
      { id: 'takibi', label: 'bonfire', position: r3([L.TAKIBI.position[0], 0.5, L.TAKIBI.position[2]]), radiusM: L.TAKIBI.radius, sizeM: [1.1, 1.0, 1.1], material: 'iron basket of burning split logs', motion: 'static', notes: 'Open flames, embers rising.' },
      { id: 'bonsho', label: 'temple bell', position: r3(L.BONSHO.position), sizeM: r3([L.BONSHO.radius * 2, L.BONSHO.height + 0.15, L.BONSHO.radius * 2]), material: 'bronze', motion: 'static', notes: 'A large bonsho in an open pavilion, rung by a swinging log every 45-75 s.' },
      { id: 'pounder', label: 'pounder', motion: 'moves', material: 'person', notes: 'Swings the kine. Steps aside (to about [1.75, 0, 1.55]) while the player pounds. Their strikes sound as `pound` at the mortar.' },
      { id: 'turner', label: 'turner', position: r3([L.TURNER_SPOT[0], 0.5, L.TURNER_SPOT[2]]), motion: 'static', material: 'person, kneeling', notes: 'Kneels at the mortar and folds the dough with wet hands between strikes.' },
      { id: 'helper', label: 'rice carrier', motion: 'moves', material: 'person', notes: 'Walks between the stove and the mortar carrying the steamer box.' },
      { id: 'player', label: 'you', motion: 'moves', material: 'person', notes: 'First person; in VR the headset. Holds the kine when they take a turn.' },
      // silent geometry that shapes what is heard
      { id: 'shrine_hall', label: 'shrine hall', position: r3([L.SHRINE.position[0], 3, L.SHRINE.position[2]]), sizeM: r3([L.SHRINE.size[0] + 1.2, 6.2, L.SHRINE.size[2] + 1.2]), material: 'wood and plaster on a stone platform', motion: 'static', notes: 'Silent; a large reflecting/occluding mass to the north.' },
      { id: 'stall', label: 'kohaku curtain stall', position: r3([L.STALL.position[0], L.STALL.height / 2, L.STALL.position[2] - L.STALL.depth / 2]), sizeM: r3([L.STALL.width, L.STALL.height, 0.1]), material: 'fabric curtain', motion: 'static', occludes: false, notes: 'Silent; a curtain directly behind the mortar.' },
      { id: 'table', label: 'mochi table', position: r3([L.TABLE.position[0], L.TABLE.size[1] / 2, L.TABLE.position[2]]), sizeM: r3(L.TABLE.size), material: 'wood', motion: 'static', notes: 'Silent; finished mochi land here.' },
      { id: 'shoro', label: 'bell pavilion', position: r3([L.SHORO.position[0], 0.3, L.SHORO.position[2]]), sizeM: r3([L.SHORO.size[0] + 0.6, 0.6, L.SHORO.size[2] + 0.6]), material: 'stone base, open wooden posts', motion: 'static', occludes: false, notes: 'Silent; open on all sides.' },
    ],
    regions: [
      { id: 'courtyard', label: 'courtyard', bounds: { polygon: [[-L.COURTYARD.halfX, L.COURTYARD.zMin], [L.COURTYARD.halfX, L.COURTYARD.zMin], [L.COURTYARD.halfX, L.COURTYARD.zMax], [-L.COURTYARD.halfX, L.COURTYARD.zMax]], y: [0, 6] }, notes: 'Gravel with a dusting of snow (layout.js surfaceAt).' },
      { id: 'path', label: 'flagstone path', bounds: { polygon: [[-L.PATH.halfWidth, L.PATH.zMin], [L.PATH.halfWidth, L.PATH.zMin], [L.PATH.halfWidth, L.PATH.zMax], [-L.PATH.halfWidth, L.PATH.zMax]], y: [0, 3] }, notes: 'Flagstone (layout.js surfaceAt).' },
      { id: 'station', label: 'at the mortar', bounds: { box: { position: [0, 1, 0], sizeM: [L.POUNDING.takeRadius * 2, 2, L.POUNDING.takeRadius * 2] } }, notes: 'Within 2.4 m of the mortar the player can take the kine (main.js nearMortar).' },
    ],
    events: [
      { name: 'pound', description: "The kine's head meets the dough in the mortar, on the exact frame of contact (the NPC's or desktop player's swing, or a real VR controller swing into the bowl). Its sound follows mochi_progress: near 0 it is freshly steamed rice grains being crushed, a dull wet grainy thud through the heavy wooden mortar; toward 1 it is smooth elastic dough, a deep round slightly hollow wooden thump with a sticky slap. About one strike every 1.45 s when the NPC pair works; the player may be faster or slower." },
      { name: 'turn', description: 'The kneeling turner folds and flips the dough with wet hands between strikes: a soft wet slap and squelch of dough on dough, palms patting. Once after every strike, about 0.5 s later.' },
      { name: 'dip', description: 'The turner dips a hand in the water bucket: a small splash and drip. Every third fold.' },
      { name: 'steamer_open', description: 'The helper lifts the top steamer box off the stack: a gust of escaping steam and a light knock of the wooden box. Once per batch (about every 40 s).' },
      { name: 'rice_drop', description: 'The helper tips the box of freshly steamed glutinous rice into the mortar: a soft heavy plop of about 2 kg of hot sticky rice onto wood. Once per batch.' },
      { name: 'bell_toll', description: 'The temple bell is struck by its hanging log: one deep bronze toll with a long decaying hum, 15-25 s, 13 m from the mortar. Every 45-75 s.' },
      { name: 'step', by: 'player', surfaces: ['gravel', 'flagstone'], description: "The player's footsteps: one per 0.72 m of collision-resolved travel (a distance fallback; there are no animated feet). The gravel has a thin dusting of fresh snow." },
    ],
    signals: [
      { name: 'mochi_progress', min: 0, max: 1, unit: 'normalized', description: 'How smooth the dough in the mortar is: 0 = rice just dropped in, 1 = finished mochi. Published right after each pound, so a pound reads the value before its own strike. Back to 0 on rice_drop.' },
    ],
    behaviorContract: {
      version: 'satie.behaviors/v1',
      listener: { host: 'player', offsetM: [0, 0.72, 0], maxErrorM: 0.6 },
      inventory: [
        { host: 'usu', discovery: { kind: 'host-code', references: ['src/station.js createStation(): st.phase load|pound|done', 'src/station.js contact() emits pound', 'src/station.js turnerAct() emits turn', 'src/station.js updateLoad() emits rice_drop'] },
          states: [
            { name: 'load', group: 'batch', behaviors: ['rice_drop'] },
            { name: 'pound', group: 'batch', behaviors: ['pound', 'turn'] },
            { name: 'done', group: 'batch', behaviors: [], silentReason: 'The finished mochi is carried to the table; nothing touches the mortar until the next rice drop.' },
          ] },
        { host: 'oke', discovery: { kind: 'host-code', references: ['src/station.js turnerAct(): dip on every third fold'] },
          states: [{ name: 'still', behaviors: ['dip'], silentReason: 'Silent water between dips.' }] },
        { host: 'seiro', discovery: { kind: 'host-code', references: ['src/station.js updateLoad() step 0 emits steamer_open', 'src/main.js seiroSteam emitter (always steaming)'] },
          states: [{ name: 'steaming', behaviors: ['steamer_hiss', 'steamer_open'] }] },
        { host: 'kamado', discovery: { kind: 'host-code', references: ['src/world.js makeFire() in the kamado firebox (always burning)'] },
          states: [{ name: 'burning', behaviors: ['stove_fire'] }] },
        { host: 'takibi', discovery: { kind: 'host-code', references: ['src/world.js takibi makeFire() (always burning)'] },
          states: [{ name: 'burning', behaviors: ['bonfire'] }] },
        { host: 'bonsho', discovery: { kind: 'host-code', references: ['src/world.js updateBell(): idle|pull|swing|rebound, onToll at contact'] },
          states: [{ name: 'hanging', behaviors: ['bell_toll'], silentReason: 'Silent between tolls; each toll decays on its own.' }] },
        { host: 'player', discovery: { kind: 'host-code', references: ['src/player.js update(): stride counter emits step', 'src/main.js player.on(use) / xrselect: take the kine'] },
          states: [
            { name: 'walking', group: 'locomotion', behaviors: ['footsteps'] },
            { name: 'pounding', group: 'locomotion', behaviors: [], silentReason: 'Locked at the mortar; their strikes are the pound event at the usu.' },
          ] },
        { host: 'pounder', discovery: { kind: 'host-code', references: ['src/station.js update(): pounder walks aside when st.mode != npc'] },
          states: [{ name: 'working', behaviors: [], silentReason: 'Their strikes sound as pound at the usu; no vocal sounds.' }] },
        { host: 'turner', discovery: { kind: 'host-code', references: ['src/station.js turnerAct()'] },
          states: [{ name: 'working', behaviors: [], silentReason: 'Their folds and dips sound at the usu and the bucket.' }] },
        { host: 'helper', discovery: { kind: 'host-code', references: ['src/station.js updateLoad()'] },
          states: [{ name: 'working', behaviors: [], silentReason: 'Their moments sound as steamer_open at the steamer and rice_drop at the usu; footsteps not modelled.' }] },
      ],
      behaviors: [
        { id: 'pound', host: 'usu', sourceIds: ['pound'], kind: 'impact', authority: 'animation-contact', event: 'pound', signals: ['mochi_progress'], sourceRole: 'isolated-impact', spatial: { kind: 'point', nearM: 1, farM: 12, minDropDb: 10 }, maxLatencyMs: 60, minDistinctTakes: 4 },
        { id: 'turn', host: 'usu', sourceIds: ['turn'], kind: 'impact', authority: 'animation-contact', event: 'turn', sourceRole: 'isolated-impact', spatial: { kind: 'point', nearM: 1, farM: 10, minDropDb: 10 }, maxLatencyMs: 80, minDistinctTakes: 3 },
        { id: 'dip', host: 'oke', sourceIds: ['dip'], kind: 'impact', authority: 'animation-contact', event: 'dip', sourceRole: 'isolated-impact', spatial: { kind: 'point', nearM: 1, farM: 8, minDropDb: 10 }, maxLatencyMs: 100 },
        { id: 'steamer_open', host: 'seiro', sourceIds: ['steamer_open'], kind: 'state', authority: 'state-transition', event: 'steamer_open', sourceRole: 'isolated-impact', spatial: { kind: 'point', nearM: 1, farM: 12, minDropDb: 10 }, maxLatencyMs: 120 },
        { id: 'rice_drop', host: 'usu', sourceIds: ['rice_drop'], kind: 'impact', authority: 'animation-contact', event: 'rice_drop', sourceRole: 'isolated-impact', spatial: { kind: 'point', nearM: 1, farM: 12, minDropDb: 10 }, maxLatencyMs: 80 },
        { id: 'bell_toll', host: 'bonsho', sourceIds: ['bell_toll'], kind: 'impact', authority: 'animation-contact', event: 'bell_toll', sourceRole: 'isolated-impact', spatial: { kind: 'point', nearM: 3, farM: 30, minDropDb: 6 }, maxLatencyMs: 80 },
        { id: 'footsteps', host: 'player', sourceIds: ['footsteps'], kind: 'contact', authority: 'distance-fallback', event: 'step', sourceRole: 'isolated-contact', maxLatencyMs: 80, minDistinctTakes: 6 },
        { id: 'stove_fire', host: 'kamado', sourceIds: ['stove_fire'], kind: 'continuous', authority: 'game-state', sourceRole: 'stationary-texture', spatial: { kind: 'point', nearM: 1, farM: 10, minDropDb: 10 } },
        { id: 'steamer_hiss', host: 'seiro', sourceIds: ['steamer_hiss'], kind: 'continuous', authority: 'game-state', sourceRole: 'stationary-texture', spatial: { kind: 'point', nearM: 1, farM: 8, minDropDb: 10 } },
        { id: 'bonfire', host: 'takibi', sourceIds: ['bonfire'], kind: 'continuous', authority: 'game-state', sourceRole: 'stationary-texture', spatial: { kind: 'area', nearM: 1.5, farM: 20, minDropDb: 12 } },
      ],
    },
  };
}

export function buildContract(revision = 'mochi-1') {
  return {
    version: 'satie.scene/v1',
    revision,
    coordinates: { units: 'metres', frame: 'threejs', handedness: 'right', up: '+Y', cameraForward: '-Z' },
    scene: buildManifest(),
  };
}
