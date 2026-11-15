// Shared gameplay state. Softness changes exactly one material parameter: Young's modulus E.
export const CONDITIONING = Object.freeze({
  stiffE: 8000, softE: 1200,
  initialMoisture: 0.7, moistureThreshold: 0.3,
  dryingPerSecond: 0.012, dryElasticityLossPerSecond: 0.018,
  elasticityPerSuccess: 0.025, waterPerDip: 0.4,
});
const clamp = (x) => Math.max(0, Math.min(1, x));
export const youngsModulusFor = (elasticity) => CONDITIONING.stiffE
  + (CONDITIONING.softE - CONDITIONING.stiffE) * clamp(elasticity);

export function createConditioning() {
  let epoch = 0, revision = 0, elasticity = 0, moisture = CONDITIONING.initialMoisture;
  const rewarded = new Set();
  return {
    snapshot: () => ({ epoch, revision, elasticity, moisture }),
    get youngsModulus() { return youngsModulusFor(elasticity); },
    reset() { epoch++; revision = 0; elasticity = 0; moisture = CONDITIONING.initialMoisture; rewarded.clear(); },
    update(dt) {
      if (!(dt > 0) || !Number.isFinite(dt)) return;
      // Only time actually spent below the threshold dries the dough back toward stiff.
      const moistSeconds = Math.max(0, (moisture - CONDITIONING.moistureThreshold) / CONDITIONING.dryingPerSecond);
      const drySeconds = Math.max(0, dt - moistSeconds);
      moisture = clamp(moisture - dt * CONDITIONING.dryingPerSecond);
      elasticity = clamp(elasticity - drySeconds * CONDITIONING.dryElasticityLossPerSecond);
      revision++;
    },
    water() { moisture = clamp(moisture + CONDITIONING.waterPerDip); revision++; },
    reward({ epoch: batch, action, id, kind }) {
      if (batch !== epoch || !['strike', 'knead'].includes(action) || !['perfect', 'good'].includes(kind)
        || typeof id !== 'string' || id.length > 256) return false;
      const key = `${action}:${id}`;
      if (rewarded.has(key)) return false;
      rewarded.add(key);
      if (moisture < CONDITIONING.moistureThreshold) return false;
      elasticity = clamp(elasticity + CONDITIONING.elasticityPerSuccess); revision++;
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
