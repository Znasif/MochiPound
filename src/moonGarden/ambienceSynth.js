// Small deterministic clips for the garden's procedural ambience. No downloads or audio service.
const TAU = Math.PI * 2;
export function seededRandom(seed = 7) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
}

export function noiseData(sampleRate, seconds = 4, seed = 17) {
  const random = seededRandom(seed), length = Math.ceil(sampleRate * seconds);
  const channels = [new Float32Array(length), new Float32Array(length)];
  const edge = Math.max(1, Math.floor(sampleRate * 0.04));
  for (const samples of channels) {
    let low = 0, mid = 0;
    for (let i = 0; i < length; i++) {
      const white = random() * 2 - 1;
      low = low * 0.99 + white * 0.01; mid = mid * 0.85 + white * 0.15;
      // Soft endpoints prevent a click at the loop seam; the independent layers have different offsets.
      const fade = Math.sin(Math.min(1, i / edge, (length - 1 - i) / edge) * Math.PI / 2) ** 2;
      samples[i] = (low * 3 + mid * 0.9 + white * 0.2) * 0.65 * fade;
    }
  }
  return channels;
}

export function bambooData(sampleRate, frequency = 440, seed = 9) {
  const random = seededRandom(seed), samples = new Float32Array(Math.ceil(sampleRate * 1.5));
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate, attack = 1 - Math.exp(-t * 700);
    // Inharmonic wooden bars: a round fundamental, a brief hollow overtone and a soft tap.
    const body = Math.sin(TAU * frequency * t) * Math.exp(-t * 4.5)
      + 0.3 * Math.sin(TAU * frequency * 2.76 * t) * Math.exp(-t * 9)
      + 0.12 * Math.sin(TAU * frequency * 5.4 * t) * Math.exp(-t * 15);
    samples[i] = attack * (body * 0.13 + (random() * 2 - 1) * 0.025 * Math.exp(-t * 95));
  }
  samples[samples.length - 1] = 0;
  return samples;
}

export function dripData(sampleRate, seed = 43) {
  const random = seededRandom(seed), samples = new Float32Array(Math.ceil(sampleRate * 0.32));
  const frequency = 1050 + random() * 350;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate, attack = 1 - Math.exp(-t * 900);
    const phase = TAU * (frequency * t + 85 * (1 - Math.exp(-t * 35)));
    samples[i] = attack * Math.exp(-t * 24) * (0.12 * Math.sin(phase) + 0.015 * (random() * 2 - 1));
  }
  samples[samples.length - 1] = 0;
  return samples;
}
