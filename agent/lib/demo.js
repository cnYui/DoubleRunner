// Deterministic stride signal for tests and for the on-screen demo mode that
// replaces a missing or failing sensor. It imitates what a head-mounted
// gyroscope sees while running: a pitch nod on every step (the fundamental
// plus a softer second harmonic), a roll sway once per stride (half the step
// frequency), and a little sensor noise.

const TWO_PI = Math.PI * 2;

export function createRandom(seed = 1) {
  let state = seed >>> 0;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function createStrideSignal(options = {}) {
  const random = createRandom(options.seed === undefined ? 1 : options.seed);
  const amplitude = options.amplitude === undefined ? 1.2 : options.amplitude;
  const noise = options.noise === undefined ? 0.08 : options.noise;
  const axis = options.axis === undefined ? 0 : options.axis;
  const offset = options.offset || [0, 0, 0];
  let cadence = options.cadence === undefined ? 180 : options.cadence;
  let phase = 0;
  let lastT = null;

  function gaussianish() {
    return (random() + random() + random() - 1.5) * 2 * noise;
  }

  return {
    setCadence(value) {
      cadence = value;
    },
    get cadence() {
      return cadence;
    },
    // Returns {x, y, z} for the sample at time tMs (milliseconds, increasing).
    sample(tMs) {
      if (lastT !== null && cadence > 0) {
        phase += (TWO_PI * cadence * (tMs - lastT)) / 60000;
        if (phase > 1e6) phase -= Math.floor(phase / TWO_PI) * TWO_PI;
      }
      lastT = tMs;
      const nod =
        cadence > 0
          ? amplitude * Math.sin(phase) + 0.35 * amplitude * Math.sin(2 * phase + 0.6)
          : 0;
      const sway = cadence > 0 ? 0.15 * amplitude * Math.sin(phase / 2) : 0;
      const values = [0, 0, 0];
      values[axis] = nod + gaussianish();
      values[(axis + 1) % 3] = sway + gaussianish();
      values[(axis + 2) % 3] = gaussianish();
      return {
        x: values[0] + offset[0],
        y: values[1] + offset[1],
        z: values[2] + offset[2]
      };
    }
  };
}
