// One source of truth for where things are, in metres, +Y up, three.js frame (the camera starts
// facing -Z, toward the mortar). The scene builders and the Satie manifest both read these numbers,
// so the sound hosts always sit on the meshes they belong to.
//
// Since 2026-11-15 there are two worlds (src/worlds.js): the shrine courtyard (src/world.js) and the
// Moon garden ported from the Unity team's environment (src/moonGarden.js: a moonlit clearing on a
// floating island, the mortar at its centre, the Moon and the Earth over the bamboo toward -Z). The
// station's numbers here hold in both; the courtyard's further down are read by src/world.js and by
// src/manifest.js (the Satie contract of the courtyard soundscape).

// desktop start in the Moon garden (each world's build() returns its own spawn; main.js teleports there)
export const SPAWN = { position: [0.9, 0, 3.1], yaw: Math.atan2(0.9, 3.1) }; // src/moonGarden.js spawn: facing the mortar
export const EYE_HEIGHT = 1.62;

// The pounding station.
export const USU = { position: [0, 0, 0], radius: 0.42, height: 0.7 }; // wooden mortar (keyaki stump)
export const MOCHI_TOP_Y = 0.8; // top of the dough dome when it rests in the mortar's bowl
export const POUNDER_SPOT = [0, 0, 1.12]; // where whoever holds the kine stands, facing -Z
// where the kine stands when nobody holds it: head-down on the ground east of the mortar (src/station.js)
export const KINE_REST = [0.78, 0, 0.18];
export const KINE_PIVOT_STRIKE = [0, 0.95, 0.85]; // hands at the moment of contact (handle level)
export const KINE_PIVOT_RAISED = [0, 1.62, 0.78]; // hands at the top of the lift
export const KINE_LENGTH = 0.85; // hands to head centre
export const TURNER_SPOT = [-0.78, 0, -0.08]; // the kneading person (aitori) on the mortar's west side, facing +X (a real person's tracked hands since 2026-11-14); the Satie fixture 'turner'
// where a VR player kneading with tracked hands is put when their hands appear: standing at the rim on the
// same west side (away from the pounder and the mallet's swing), the head 0.6 m from the axis so the
// dough is within arm's reach by leaning in (from the old kneeling spot, 0.78 m, a standing person can't reach it)
export const KNEAD_SPOT = [-0.6, 0, -0.06];
// a second kneader (two headsets, the other person already at KNEAD_SPOT): the north rim, across from
// the pounder and out of the mallet's swing, the head as far from the axis
export const KNEAD_SPOT_FAR = [0, 0, -0.6];
export const OKE = { position: [-0.95, 0, 0.35], radius: 0.2, height: 0.26, stand: 0.3 }; // hand-water bucket on a low stand, at the turner's left hand

// ---- the shrine courtyard (src/world.js, and src/manifest.js for the Satie contract) ----
export const COURTYARD = { halfX: 19, zMin: -16, zMax: 21 };
export const PATH = { halfWidth: 1.1, zMin: -0.6, zMax: 18.5 }; // flagstone path from the gate
export const POUNDER_ASIDE = [1.75, 0, 1.55]; // where the NPC pounder waited while the player pounded
export const KAMADO = { position: [3.3, 0, -1.4], size: [1.1, 0.85, 0.9] }; // clay wood stove
export const SEIRO = { position: [3.3, 0.85, -1.4], size: [0.62, 0.66, 0.62] }; // 3 stacked steamer boxes

export const TABLE = { position: [-3.3, 0, -1.5], size: [1.9, 0.78, 0.8] }; // finished mochi
export const STALL = { position: [0, 0, -3.6], width: 11, height: 2.6, depth: 4.2 }; // kohaku-curtained backdrop

export const TAKIBI = { position: [-6.5, 0, 4.2], radius: 0.55 }; // bonfire in an iron basket

export const SHRINE = { position: [0, 0, -12], size: [13, 8, 7.5] }; // the hall (haiden), north
export const SHORO = { position: [-12, 0, -5], size: [4, 5.4, 4] }; // open bell pavilion
export const BONSHO = { position: [-12, 2.7, -5], radius: 0.55, height: 1.5 }; // the bronze bell
export const TORII = { position: [0, 0, 18.2], span: 4.6, height: 4.6 };
export const TORO = [[-2.3, 0, 6.5], [2.3, 0, 6.5], [-2.3, 0, 13], [2.3, 0, 13]]; // stone lanterns

export const TREES = [
  [-16, -13], [-11, -14.5], [11, -14.5], [16, -13], [-17, -4], [17, -3.5], [-17.5, 5], [17, 6],
  [-16.5, 13], [16.5, 13.5], [-8, 19], [8, 19.5], [-13, 18], [13, 17.5], [17.5, -9], [-17.5, -9.5],
];

// The ground under a point, as the courtyard soundscape names it (its footsteps are muted in the Moon
// garden, src/main.js; the names stay valid for the Satie contract).
export function surfaceAt(x, z) {
  if (Math.abs(x) <= PATH.halfWidth && z >= PATH.zMin && z <= PATH.zMax) return 'flagstone';
  return 'gravel';
}

export const POUNDING = {
  strikesPerBatch: 22, // strikes to turn steamed rice into smooth mochi
  npcBeatS: 1.45, // the NPC pair's rhythm: one strike, one turn
  goodIntervalS: [0.8, 2.2], // player strikes inside this gap after the last count as a good rhythm
  takeRadius: 2.4, // how close the player must be to take the kine
};
