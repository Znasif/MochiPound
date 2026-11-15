// The worlds the pounding station can stand in (2026-11-15, the user's "Worlds" menu). The start menu's
// Worlds panel (src/menu.js) lists them and reloads the page with ?world=<id>; main.js builds the chosen
// one before the station, since the station's mallet contact reads the world's 'ground' mesh once.
//
// This file imports nothing heavy: menu.js reads the names from it, and each world's code is loaded by a
// dynamic import inside its build(), so a world whose module is broken or still being written never stops
// the page, the menu or the other worlds (main.js falls back to DEFAULT_WORLD if a build fails).
// A world that isn't `ready` is shown in the menu as coming soon, and can still be opened by URL for work
// on it (?world=<id>).
//
// build(scene, renderer, { steam }) resolves to:
//   colliders    { circles, boxes } that the player can't walk through, and optionally rect
//                { minX, maxX, minZ, maxZ } to keep the player inside (src/player.js)
//   update(dt, elapsed, head)        every frame; head = the player's head position (THREE.Vector3)
//   setProgress(p)                   optional: the batch's progress 0..1, eased (main.js shownProgress)
//   spawn        { position, yaw }   where the player starts
//   enterLabel   the Play button's text once the sound has loaded
//   sound        { hosts, muted, mixGroups } for the Satie soundscape, which is still the shrine
//                courtyard's (src/manifest.js): `hosts` binds its world fixtures (seiro, kamado, takibi,
//                bonsho) to meshes (main.js puts an empty marker where a world has none), `muted` lists
//                source ids to silence, `mixGroups` the world's groups in the dev mixer
//   onSound      set by main.js to (host, event) => audio.hostEvent(host, event), for world sounds
// Each world sets its own lights, sky and fog; main.js sets ACES tone mapping (exposure 1.05) and a
// FogExp2(0x101828, 0.03) before building, and a world may override them.

export const WORLDS = [
  {
    id: 'shrine',
    name: 'Shrine courtyard',
    blurb: 'Snow falling on a shrine on New Year’s Eve: the torii gate, stone lanterns, the temple bell and a bonfire.',
    ready: true,
    async build(scene, renderer, { steam }) {
      const [THREE, L, { buildWorld }, { createSnow, createEmbers }] = await Promise.all([
        import('three'), import('./layout.js'), import('./world.js'), import('./effects.js'),
      ]);
      const w = buildWorld(scene);
      const snow = createSnow(scene);
      const embers = createEmbers(scene, new THREE.Vector3(L.TAKIBI.position[0], 0.9, L.TAKIBI.position[2]));
      // the steamer on the stove keeps steaming (it's scenery now: the rice drops into the mortar by itself)
      const seiroTop = new THREE.Vector3(L.SEIRO.position[0], L.SEIRO.position[1] + L.SEIRO.size[1] + 0.2, L.SEIRO.position[2]);
      steam.addEmitter(seiroTop, { rate: 5, spread: 0.35, size: 0.3, rise: 0.5 }).intensity = 1;
      // inside the courtyard's walls (src/player.js clamps to colliders.rect; the gate side reaches 3 m past them)
      w.colliders.rect = { minX: -L.COURTYARD.halfX + 0.5, maxX: L.COURTYARD.halfX - 0.5, minZ: L.COURTYARD.zMin + 0.5, maxZ: L.COURTYARD.zMax + 3.5 };
      const world = {
        root: w.root,
        colliders: w.colliders,
        spawn: { position: [0, 0, 10.5], yaw: 0 }, // on the path inside the gate, facing the mortar
        enterLabel: 'Enter the courtyard',
        sound: {
          hosts: w.hosts, // the stove, steamer, bonfire and bell meshes
          muted: [],
          mixGroups: [
            { id: 'rice', label: 'Steamer & rice', sourceIds: ['steamer_open', 'rice_drop'] },
            { id: 'fires', label: 'Fires & steam', sourceIds: ['stove_fire', 'pot_bubbling', 'steamer_hiss', 'bonfire'] },
            { id: 'bell', label: 'Temple bell', sourceIds: ['bell_toll'] },
            { id: 'steps', label: 'Footsteps', sourceIds: ['footsteps'] },
          ],
        },
        onSound: null,
        update(dt, elapsed, head) {
          w.update(dt, elapsed);
          if (head) snow.update(dt, elapsed, head);
          embers.update(dt, elapsed);
        },
      };
      w.bell.onToll = () => world.onSound?.('bonsho', 'bell_toll');
      return world;
    },
  },
  {
    // The Moon garden (src/moonGarden.js, the immerse-a8 session's port of the Unity team's environment),
    // ready since 2026-11-15 (it loaded in the user's browser with no errors; not yet seen on the headset).
    // This entry is main.js's Moon garden wiring as it stood on 2026-11-15, moved here unchanged.
    id: 'moon',
    name: 'Moon garden',
    blurb: 'A moonlit clearing on a floating island, the Moon and the Earth over the bamboo.',
    ready: true,
    async build(scene, renderer) {
      const { buildMoonGarden } = await import('./moonGarden.js');
      const g = buildMoonGarden(scene, renderer); // sets its own tone mapping, sky, fog and lights
      return {
        root: g.root,
        colliders: g.colliders,
        spawn: g.spawn,
        enterLabel: 'Enter the garden',
        // only the station's sounds play here (pound, turn, dip, rice_drop): the courtyard's ambience and
        // footsteps are muted, and its fixtures are bound to empty markers where they stood
        sound: {
          hosts: {},
          muted: ['stove_fire', 'pot_bubbling', 'steamer_hiss', 'bonfire', 'steamer_open', 'bell_toll', 'footsteps'],
          mixGroups: [{ id: 'rice', label: 'Rice', sourceIds: ['rice_drop'] }],
        },
        onSound: null,
        update: (dt, elapsed) => g.update(dt, elapsed),
        setProgress: (p) => g.setProgress(p),
        garden: g,
        // the story layer ported from the Unity multiplayer branch (src/moonGarden/story/): main.js calls this
        // once the station, player, music and rhythm exist
        // (ctx is extended through its prototype, not spread: its getters, audioContext and entered, must stay live)
        attach: async (ctx) => (await import('./moonGarden/story/index.js')).createMoonStory(Object.assign(Object.create(ctx), { garden: g })),
      };
    },
  },
];

export const DEFAULT_WORLD = 'moon'; // the user's pick, 2026-11-15 (the shrine courtyard is one pick away in Worlds)

export const worldById = (id) => WORLDS.find((w) => w.id === id);

// ?world=<id> (any listed world, ready or not), else the default
export function worldFromUrl() {
  return worldById(new URLSearchParams(location.search).get('world')) ?? worldById(DEFAULT_WORLD);
}
