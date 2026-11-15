// Shared gameplay state: the dough's elasticity and moisture (the host owns it; the guest and film camera
// follow its snapshots). Softness changes exactly one material parameter: Young's modulus E.
//
// Elasticity comes only from rhythm (the user's rules, 2026-11-15): each player's on-beat actions are judged as
// usual (each keeps their own score), and every turn of the batch (one strike and the knead after it) adds the
// average of the two players' points to the elasticity, in percent: perfect +5, good +1, bad (a miss) -3.
// A turn counts once both its strike and its knead have been judged; one without its partner (one person
// playing alone, or free play with no song) changes nothing.
//
// Moisture is the dough's colour (more water, whiter; less, browner). It dries steadily and each dip in the
// water bucket adds 10%. It doesn't touch elasticity.
//
// The batch is done when elasticity AND moisture are both above 95% (`ready`); the strike count doesn't end it.
export const CONDITIONING = Object.freeze({
  stiffE: 8000, softE: 1200,
  initialMoisture: 0.7, dryingPerSecond: 0.012, waterPerDip: 0.1,
  points: Object.freeze({ perfect: 5, good: 1, miss: -3 }), // elasticity % per judgment; a turn adds its pair's average
  turnsKept: 64, // turns waiting for their partner judgment (a solo player's never arrive)
  // the batch is done (the mochi flies to the Earth) when both are above these: elasticity AND moisture
  doneElasticity: 0.95, doneMoisture: 0.95,
});
const clamp = (x) => Math.max(0, Math.min(1, x));
export const youngsModulusFor = (elasticity) => CONDITIONING.stiffE
  + (CONDITIONING.softE - CONDITIONING.stiffE) * clamp(elasticity);

export function createConditioning() {
  let epoch = 0, revision = 0, elasticity = 0, moisture = CONDITIONING.initialMoisture;
  const judged = new Set(); // `${action}:${turn id}`: each player's judgment counts once
  const turns = new Map();  // turn id -> { strike?, knead? } points, until both are in
  return {
    snapshot: () => ({ epoch, revision, elasticity, moisture }),
    get youngsModulus() { return youngsModulusFor(elasticity); },
    get waiting() { return turns.size; },
    // both above their marks (strictly: more than 95%), never just one
    // (a hair of tolerance: turns move it by whole percents, and 19 of 5% sum to 0.9500000000000002 in floats)
    get ready() { return elasticity > CONDITIONING.doneElasticity + 1e-9 && moisture > CONDITIONING.doneMoisture + 1e-9; },
    reset() { epoch++; revision = 0; elasticity = 0; moisture = CONDITIONING.initialMoisture; judged.clear(); turns.clear(); },
    update(dt) {
      if (!(dt > 0) || !Number.isFinite(dt)) return;
      moisture = clamp(moisture - dt * CONDITIONING.dryingPerSecond);
      revision++;
    },
    water() { moisture = clamp(moisture + CONDITIONING.waterPerDip); revision++; },
    // both full (station.js DEMO_ONE_STRIKE: one strike finishes a batch, for debugging and demo videos)
    fill() { elasticity = 1; moisture = 1; revision++; },
    // one rhythm judgment { epoch, action: 'strike' | 'knead', kind: 'perfect' | 'good' | 'miss', id: the turn };
    // true when it completed its turn (the elasticity changed)
    judge({ epoch: batch, action, id, kind } = {}) {
      if (batch !== epoch || !['strike', 'knead'].includes(action) || !Object.hasOwn(CONDITIONING.points, kind)
        || typeof id !== 'string' || id.length > 256) return false;
      const key = `${action}:${id}`;
      if (judged.has(key)) return false;
      judged.add(key);
      if (judged.size > 4 * CONDITIONING.turnsKept) judged.delete(judged.values().next().value);
      const turn = turns.get(id) ?? {};
      turn[action] = CONDITIONING.points[kind];
      if (turn.strike === undefined || turn.knead === undefined) {
        turns.set(id, turn);
        if (turns.size > CONDITIONING.turnsKept) turns.delete(turns.keys().next().value);
        return false;
      }
      turns.delete(id);
      elasticity = clamp(elasticity + (turn.strike + turn.knead) / 2 / 100); revision++;
      return true;
    },
    apply(s) {
      if (!s || !Number.isInteger(s.epoch) || !Number.isInteger(s.revision) || s.epoch < epoch
        || (s.epoch === epoch && s.revision < revision) || !Number.isFinite(s.elasticity) || !Number.isFinite(s.moisture)) return false;
      epoch = s.epoch; revision = s.revision; elasticity = clamp(s.elasticity); moisture = clamp(s.moisture);
      return true;
    },
  };
}
