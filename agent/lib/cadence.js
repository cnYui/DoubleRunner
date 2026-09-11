// Step and cadence detection from a three-axis inertial signal.
//
// The default source is the glasses' gyroscope (angular velocity, rad/s); the
// accelerometer (m/s²) and the demo stride generator use the same detector
// with a different noise floor. Everything here is pure and deterministic:
// every call carries its own timestamp, nothing reads the clock or the
// runtime, so the detector can be replayed in unit tests.
//
// Pipeline per sample:
//   1. remove the slow baseline of each axis (first-order high-pass),
//   2. pick the axis with the largest recent variance (with hysteresis),
//   3. smooth that axis (first-order low-pass),
//   4. accept a local maximum above an adaptive threshold as one step, but
//      only after the signal dipped below the baseline since the last step
//      ("armed"), which keeps the two lobes of one head nod from counting
//      twice,
//   5. cadence = 60000 / median of the last few step intervals.

export const MIN_STEP_INTERVAL_MS = 250; // 240 steps/min ceiling
export const MAX_STEP_INTERVAL_MS = 1500; // 40 steps/min floor: a longer gap is a stop
export const CADENCE_TIMEOUT_MS = 2500; // no step for this long -> cadence 0
export const INTERVAL_WINDOW = 8; // step intervals kept for the median
export const RESET_GAP_MS = 4000; // a sample gap this long restarts the filters

export const SOURCE_PROFILES = {
  gyroscope: { minThreshold: 0.35, unit: 'rad/s' },
  accelerometer: { minThreshold: 1.2, unit: 'm/s2' },
  demo: { minThreshold: 0.35, unit: 'rad/s' }
};

function finiteOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function emaAlpha(dtMs, tauMs) {
  if (!(dtMs > 0)) return 1;
  return 1 - Math.exp(-dtMs / tauMs);
}

export function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function createCadenceDetector(options = {}) {
  const profile = SOURCE_PROFILES[options.source] || SOURCE_PROFILES.gyroscope;
  const minThreshold =
    typeof options.minThreshold === 'number' ? options.minThreshold : profile.minThreshold;
  const baselineTauMs = options.baselineTauMs || 800;
  const smoothTauMs = options.smoothTauMs || 40;
  const rmsTauMs = options.rmsTauMs || 2000;
  const axisTauMs = options.axisTauMs || 1500;
  const thresholdRatio = options.thresholdRatio || 0.9;

  const state = {
    lastT: null,
    baseline: [0, 0, 0],
    variance: [0, 0, 0],
    axis: 0,
    smooth: 0,
    rms: 0,
    prev: 0,
    prevT: null,
    rising: false,
    armed: true,
    lastStepT: null,
    intervals: [],
    steps: 0,
    rawCadence: 0,
    cadence: 0
  };

  function resetMotion() {
    state.baseline = [0, 0, 0];
    state.variance = [0, 0, 0];
    state.smooth = 0;
    state.rms = 0;
    state.prev = 0;
    state.prevT = null;
    state.rising = false;
    state.armed = true;
    state.lastStepT = null;
    state.intervals = [];
    state.rawCadence = 0;
    state.cadence = 0;
  }

  function updateCadence() {
    if (!state.intervals.length) {
      state.rawCadence = 0;
      state.cadence = 0;
      return;
    }
    const raw = 60000 / median(state.intervals);
    state.rawCadence = raw;
    state.cadence = state.cadence === 0 ? raw : state.cadence + 0.35 * (raw - state.cadence);
  }

  function push(t, x, y, z) {
    const sample = [finiteOrZero(x), finiteOrZero(y), finiteOrZero(z)];
    const dt = state.lastT === null ? 0 : Math.max(0, t - state.lastT);
    if (state.lastT !== null && dt > RESET_GAP_MS) resetMotion();
    state.lastT = t;

    const alphaBaseline = emaAlpha(dt, baselineTauMs);
    const alphaVariance = emaAlpha(dt, axisTauMs);
    const highPassed = [0, 0, 0];
    for (let index = 0; index < 3; index += 1) {
      state.baseline[index] += alphaBaseline * (sample[index] - state.baseline[index]);
      highPassed[index] = sample[index] - state.baseline[index];
      const power = highPassed[index] * highPassed[index];
      state.variance[index] += alphaVariance * (power - state.variance[index]);
    }
    let best = state.axis;
    for (let index = 0; index < 3; index += 1) {
      if (state.variance[index] > state.variance[best] * 1.3) best = index;
    }
    state.axis = best;

    const alphaSmooth = emaAlpha(dt, smoothTauMs);
    state.smooth += alphaSmooth * (highPassed[state.axis] - state.smooth);
    const value = state.smooth;
    const alphaRms = emaAlpha(dt, rmsTauMs);
    const meanSquare = state.rms * state.rms + alphaRms * (value * value - state.rms * state.rms);
    state.rms = Math.sqrt(Math.max(0, meanSquare));
    const threshold = Math.max(minThreshold, state.rms * thresholdRatio);

    if (value < 0) state.armed = true;

    let step = false;
    let stepT = null;
    if (state.prevT !== null) {
      if (value > state.prev) {
        state.rising = true;
      } else if (value < state.prev && state.rising) {
        state.rising = false;
        const peakT = state.prevT;
        const peakValue = state.prev;
        if (state.armed && peakValue >= threshold) {
          const gap = state.lastStepT === null ? Infinity : peakT - state.lastStepT;
          if (gap >= MIN_STEP_INTERVAL_MS) {
            step = true;
            stepT = peakT;
            state.armed = false;
            if (gap <= MAX_STEP_INTERVAL_MS) {
              state.intervals.push(gap);
              if (state.intervals.length > INTERVAL_WINDOW) state.intervals.shift();
            } else {
              state.intervals = [];
              state.cadence = 0;
            }
            state.lastStepT = peakT;
            state.steps += 1;
            updateCadence();
          }
        }
      }
    }
    state.prev = value;
    state.prevT = t;

    if (
      state.lastStepT !== null &&
      t - state.lastStepT > CADENCE_TIMEOUT_MS &&
      state.cadence !== 0
    ) {
      state.intervals = [];
      state.rawCadence = 0;
      state.cadence = 0;
    }

    return {
      t,
      value,
      threshold,
      step,
      stepT,
      cadence: Math.round(state.cadence),
      rawCadence: Math.round(state.rawCadence),
      steps: state.steps,
      axis: state.axis,
      unit: profile.unit
    };
  }

  return {
    push,
    reset() {
      state.lastT = null;
      state.steps = 0;
      resetMotion();
    },
    get cadence() {
      return Math.round(state.cadence);
    },
    get steps() {
      return state.steps;
    },
    get axis() {
      return state.axis;
    },
    get unit() {
      return profile.unit;
    }
  };
}
