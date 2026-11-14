// Step and cadence detection from a three-axis inertial signal.
//
// The default source is the glasses' gyroscope (angular velocity, rad/s); the
// accelerometer (m/s²) and the demo stride generator use the same detector
// with a different noise floor. Everything here is pure and deterministic:
// every call carries its own timestamp, nothing reads the clock or the
// runtime, so the detector can be replayed in unit tests.
//
// Why two stages: a runner's head moves at two rhythms. Every step it nods or
// bounces (step rate), and every two steps it swings once left and right
// (stride rate, half the step rate). Which of them dominates depends on the
// runner and on how the glasses sit, and head turns add large irregular
// motion on top. Counting peaks on one axis, as the first version did, reports
// half the cadence whenever the left-right swing is the strongest signal.
//
//   1. Band-pass every axis (about 1 to 4 Hz) and feed a comb-spectrum
//      estimator (spectrum.js) that scores each candidate cadence by how much
//      of the motion energy of all three axes sits at its step tone and at its
//      stride tone, the stride tone weighted double. That gives a cadence that
//      is robust to head turns, mounting, and which tone dominates, and tells
//      which axis and which tone carry the steps.
//   2. Count steps in the time domain on that axis: the peaks of a step tone,
//      or the lobes of both polarities of a stride tone (one lobe per step).
//      Step intervals refine the spectral cadence while the two agree.
//
// Until the spectrum has enough data (about 4 s) the detector falls back to
// counting positive peaks on the strongest axis.

import { createCombEstimator, STRIDE_WEIGHT, strideWeightAt } from './spectrum.js';

export const MIN_STEP_INTERVAL_MS = 250; // 240 steps/min ceiling
export const MAX_STEP_INTERVAL_MS = 1500; // 40 steps/min floor: a longer gap is a stop
export const CADENCE_TIMEOUT_MS = 2500; // no step for this long -> cadence 0
export const INTERVAL_WINDOW = 8; // step intervals kept for the mean
export const RESET_GAP_MS = 4000; // a sample gap this long restarts the filters
export const SPECTRUM_UPDATE_MS = 400;
export const LOCK_SHARE = 0.2; // share of motion energy on the gait tones to lock on
export const LOCK_SHARE_WEAK = 0.1; // ... or this much with a clear spectral peak
export const LOCK_PROMINENCE = 4;
export const UNLOCK_SHARE = 0.08;
export const UNLOCK_AFTER_MS = 3000;
export const ALT_RATIO = 1.4; // another peak this much stronger than the locked one ...
export const ALT_VOTES = 3; // ... for this many updates takes over
export const DEFAULT_EXPECTED_CADENCE = 170;

export const SOURCE_PROFILES = {
  gyroscope: { minThreshold: 0.12, unit: 'rad/s' },
  accelerometer: { minThreshold: 1.2, unit: 'm/s2' },
  demo: { minThreshold: 0.12, unit: 'rad/s' }
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

// Mean of the intervals that agree with the median. The mean (not the median)
// keeps uneven left / right steps from biasing the cadence.
export function trimmedMean(values) {
  if (!values.length) return 0;
  if (values.length < 3) return values.reduce((sum, v) => sum + v, 0) / values.length;
  const centre = median(values);
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (value >= 0.65 * centre && value <= 1.5 * centre) {
      sum += value;
      count += 1;
    }
  }
  return count ? sum / count : centre;
}

// Finds local maxima of a stream. A peak counts only after the stream dipped
// below zero since the last accepted peak ("armed"), so the two bumps of one
// lobe never count twice.
function createPeakFinder() {
  let prev = 0;
  let prevT = null;
  let rising = false;
  let armed = true;
  return {
    push(t, value, threshold) {
      if (value < 0) armed = true;
      let peak = null;
      if (prevT !== null) {
        if (value > prev) {
          rising = true;
        } else if (value < prev && rising) {
          rising = false;
          if (armed && prev >= threshold) peak = { t: prevT, value: prev };
        }
      }
      prev = value;
      prevT = t;
      return peak;
    },
    disarm() {
      armed = false;
    },
    reset() {
      prev = 0;
      prevT = null;
      rising = false;
      armed = true;
    }
  };
}

export function createCadenceDetector(options = {}) {
  const profile = SOURCE_PROFILES[options.source] || SOURCE_PROFILES.gyroscope;
  const minThreshold =
    typeof options.minThreshold === 'number' ? options.minThreshold : profile.minThreshold;
  const highPassTauMs = options.highPassTauMs || 200;
  const smoothTauMs = options.smoothTauMs || 40;
  const rmsTauMs = options.rmsTauMs || 2000;
  const axisTauMs = options.axisTauMs || 1500;
  const thresholdRatio = options.thresholdRatio || 0.9;
  const lockedRatio = options.lockedRatio || 0.7;
  const strideWeight = options.strideWeight === undefined ? STRIDE_WEIGHT : options.strideWeight;

  const comb = createCombEstimator({ strideWeight });
  const positive = createPeakFinder();
  const negative = createPeakFinder();

  const state = {
    lastT: null,
    baseline1: null,
    baseline2: [0, 0, 0],
    smooth: [0, 0, 0],
    variance: [0, 0, 0],
    rms: [0, 0, 0],
    axis: 0,
    mode: 'step', // 'step' counts positive peaks; 'stride' counts both polarities
    lastStepT: null,
    intervals: [],
    steps: 0,
    rawCadence: 0,
    cadence: 0,
    expected: DEFAULT_EXPECTED_CADENCE,
    lastEstimateT: null,
    locked: false,
    lockVotes: 0,
    altVotes: 0,
    lostSince: null,
    jump: false,
    spectralCadence: 0,
    share: 0
  };

  function resetMotion() {
    state.baseline1 = null;
    state.baseline2 = [0, 0, 0];
    state.smooth = [0, 0, 0];
    state.variance = [0, 0, 0];
    state.rms = [0, 0, 0];
    state.mode = 'step';
    state.lastStepT = null;
    state.intervals = [];
    state.rawCadence = 0;
    state.cadence = 0;
    state.lastEstimateT = null;
    state.locked = false;
    state.lockVotes = 0;
    state.altVotes = 0;
    state.lostSince = null;
    state.jump = false;
    state.spectralCadence = 0;
    state.share = 0;
    positive.reset();
    negative.reset();
    comb.reset();
  }

  function intervalCadence() {
    if (!state.intervals.length) return 0;
    return 60000 / trimmedMean(state.intervals);
  }

  // Cadence shown: the spectral cadence while locked, refined by the step
  // intervals as long as the two agree within 10 %.
  function updateCadence() {
    let raw = intervalCadence();
    if (state.locked && state.spectralCadence > 0) {
      const spectral = state.spectralCadence;
      raw = raw > 0 && Math.abs(raw - spectral) <= 0.1 * spectral ? raw : spectral;
    } else if (state.intervals.length < 3) {
      // Too few intervals to trust before the spectrum has locked.
      raw = 0;
    }
    if (!(raw > 0)) {
      state.rawCadence = 0;
      state.cadence = 0;
      return;
    }
    state.rawCadence = raw;
    if (state.cadence === 0 || state.jump) {
      state.cadence = raw;
      state.jump = false;
    } else {
      state.cadence += 0.35 * (raw - state.cadence);
    }
  }

  function evidence(est, axis, mode) {
    return mode === 'step'
      ? est.fStep[axis]
      : strideWeightAt(est.cadence, strideWeight) * est.fStride[axis];
  }

  function refreshSpectrum(t) {
    const highPenalty = state.expected >= 200 ? 1 : 0.5;
    const prior = state.locked
      ? { center: state.spectralCadence, sigma: 25 }
      : { center: state.expected, sigma: 45, highPenalty };
    // While locked, also watch a wide-prior peak: walking into a run moves the
    // cadence far outside the narrow prior of the current lock.
    const altPrior = state.locked ? { center: state.expected, sigma: 60, highPenalty } : null;
    let est = comb.estimate(prior, altPrior);
    if (!est) return;
    if (state.locked && est.alt && est.altRatio >= ALT_RATIO) {
      state.altVotes += 1;
      if (state.altVotes >= ALT_VOTES) {
        est = est.alt;
        state.altVotes = 0;
        state.spectralCadence = est.cadence;
        state.jump = true;
        state.lostSince = null;
        state.intervals = [];
        positive.reset();
        negative.reset();
      }
    } else {
      state.altVotes = 0;
    }
    const strong =
      est.share >= LOCK_SHARE ||
      (est.share >= LOCK_SHARE_WEAK && est.prominence >= LOCK_PROMINENCE);
    if (!state.locked) {
      state.lockVotes = strong ? state.lockVotes + 1 : 0;
      if (state.lockVotes >= 2) {
        state.locked = true;
        state.jump = true;
        state.lostSince = null;
        state.spectralCadence = est.cadence;
      }
    } else if (est.share >= UNLOCK_SHARE) {
      state.lostSince = null;
      state.spectralCadence += 0.5 * (est.cadence - state.spectralCadence);
    } else if (state.lostSince === null) {
      state.lostSince = t;
    } else if (t - state.lostSince > UNLOCK_AFTER_MS) {
      state.locked = false;
      state.lockVotes = 0;
      state.spectralCadence = 0;
    }
    state.share = est.share;
    if (!state.locked) return;

    // Move to the axis and tone that carry the gait best (with hysteresis).
    const current = evidence(est, state.axis, state.mode);
    let bestAxis = state.axis;
    let bestMode = state.mode;
    let bestValue = current;
    for (let axis = 0; axis < 3; axis += 1) {
      for (const mode of ['step', 'stride']) {
        const value = evidence(est, axis, mode);
        if (value > bestValue * 1.3 && value > bestValue) {
          bestValue = value;
          bestAxis = axis;
          bestMode = mode;
        }
      }
    }
    if (bestAxis !== state.axis || bestMode !== state.mode) {
      state.axis = bestAxis;
      state.mode = bestMode;
      // Intervals counted on the other tone would pollute the average.
      state.intervals = [];
      positive.reset();
      negative.reset();
    }
    updateCadence();
  }

  function accept(peak, finder) {
    const expectedInterval =
      state.locked && state.spectralCadence > 0 ? 60000 / state.spectralCadence : 0;
    const gate = Math.max(MIN_STEP_INTERVAL_MS, 0.6 * expectedInterval);
    const gap = state.lastStepT === null ? Infinity : peak.t - state.lastStepT;
    if (gap < gate) return false;
    finder.disarm();
    if (gap <= MAX_STEP_INTERVAL_MS) {
      // A gap of about two steps means one was missed: count the step but do
      // not let the long interval into the average.
      const missed = expectedInterval > 0 && gap > 1.6 * expectedInterval;
      if (!missed) {
        state.intervals.push(gap);
        if (state.intervals.length > INTERVAL_WINDOW) state.intervals.shift();
      }
    } else {
      state.intervals = [];
      state.cadence = 0;
    }
    state.lastStepT = peak.t;
    state.steps += 1;
    updateCadence();
    return true;
  }

  function push(t, x, y, z) {
    const sample = [finiteOrZero(x), finiteOrZero(y), finiteOrZero(z)];
    const dt = state.lastT === null ? 0 : Math.max(0, t - state.lastT);
    if (state.lastT !== null && dt > RESET_GAP_MS) resetMotion();
    state.lastT = t;
    if (state.baseline1 === null) state.baseline1 = sample.slice();

    // Band-pass: two cascaded first-order high-passes, one low-pass.
    const alphaHigh = emaAlpha(dt, highPassTauMs);
    const alphaSmooth = emaAlpha(dt, smoothTauMs);
    const alphaVariance = emaAlpha(dt, axisTauMs);
    const alphaRms = emaAlpha(dt, rmsTauMs);
    const band = [0, 0, 0];
    for (let index = 0; index < 3; index += 1) {
      state.baseline1[index] += alphaHigh * (sample[index] - state.baseline1[index]);
      const stage1 = sample[index] - state.baseline1[index];
      state.baseline2[index] += alphaHigh * (stage1 - state.baseline2[index]);
      const stage2 = stage1 - state.baseline2[index];
      state.smooth[index] += alphaSmooth * (stage2 - state.smooth[index]);
      band[index] = state.smooth[index];
      state.variance[index] += alphaVariance * (band[index] * band[index] - state.variance[index]);
      const meanSquare =
        state.rms[index] * state.rms[index] +
        alphaRms * (band[index] * band[index] - state.rms[index] * state.rms[index]);
      state.rms[index] = Math.sqrt(Math.max(0, meanSquare));
    }
    comb.push(t, band[0], band[1], band[2]);

    // Before the spectrum locks: strongest axis by variance, with hysteresis.
    if (!state.locked) {
      let best = state.axis;
      for (let index = 0; index < 3; index += 1) {
        if (state.variance[index] > state.variance[best] * 1.3) best = index;
      }
      if (best !== state.axis) {
        state.axis = best;
        positive.reset();
        negative.reset();
      }
      state.mode = 'step';
    }

    const value = band[state.axis];
    const ratio = state.locked ? lockedRatio : thresholdRatio;
    const floor = state.locked ? 0.4 * minThreshold : minThreshold;
    const threshold = Math.max(floor, state.rms[state.axis] * ratio);

    let step = false;
    let stepT = null;
    const peak = positive.push(t, value, threshold);
    const trough = negative.push(t, -value, threshold);
    if (peak && accept(peak, positive)) {
      step = true;
      stepT = peak.t;
    } else if (trough && state.mode === 'stride' && accept(trough, negative)) {
      step = true;
      stepT = trough.t;
    }

    if (state.lastEstimateT === null || t - state.lastEstimateT >= SPECTRUM_UPDATE_MS) {
      state.lastEstimateT = t;
      refreshSpectrum(t);
    }

    if (
      state.lastStepT !== null &&
      t - state.lastStepT > CADENCE_TIMEOUT_MS &&
      (state.cadence !== 0 || state.locked)
    ) {
      // The runner stopped: forget the spectrum too, or its window (6 s of
      // old running) would lock again straight away.
      state.intervals = [];
      state.rawCadence = 0;
      state.cadence = 0;
      state.locked = false;
      state.lockVotes = 0;
      state.spectralCadence = 0;
      comb.reset();
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
      mode: state.mode,
      locked: state.locked,
      share: state.share,
      unit: profile.unit
    };
  }

  return {
    push,
    reset() {
      state.lastT = null;
      state.steps = 0;
      state.axis = 0;
      resetMotion();
    },
    // The target cadence only chooses between octaves while the spectrum is not
    // locked; the estimate itself never moves towards it.
    setExpected(cadence) {
      if (typeof cadence === 'number' && Number.isFinite(cadence) && cadence > 0) {
        state.expected = cadence;
      }
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
    get mode() {
      return state.mode;
    },
    get locked() {
      return state.locked;
    },
    get unit() {
      return profile.unit;
    }
  };
}
