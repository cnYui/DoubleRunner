// Comb-spectrum cadence estimator for a head-worn gyroscope or accelerometer.
//
// Running puts two periodic components into a head signal:
//   * the step rate f = cadence / 60: the nod / bounce at every footfall,
//   * the stride rate f / 2: the head swinging left and right once per two
//     steps (roll and yaw sway). It alternates sides, so it is the signature
//     that a random bump or a deliberate head turn does not have.
// For every candidate cadence the estimator measures how much of the motion
// energy sits at those two tones, on all three axes at once. The sensor axes
// are never named, so any mounting of the sensor works. The stride tone is
// weighted higher than the step tone (STRIDE_WEIGHT): left-right sway is the
// steadier cue on a real run. Candidates stay between MIN_CADENCE and
// MAX_CADENCE; a stride tone of a real cadence is always below 2 Hz and a
// step tone above 1.6 Hz, so the two cannot be confused inside that range
// as long as a prior picks the octave.
//
// The estimator is pure: samples carry their own timestamps (they may be
// jittery), and are resampled onto a 30 Hz grid before a windowed DFT.

export const MIN_CADENCE = 100;
export const MAX_CADENCE = 230;
export const STRIDE_WEIGHT = 2;
export const STEP_WEIGHT = 1;

const GRID_MS = 1000 / 30;
const WINDOW = 192; // 6.4 s
const MIN_SAMPLES = 120; // 4 s before the first estimate
const CANDIDATE_STEP = 2; // spm between grid candidates
const TWO_PI = Math.PI * 2;
const RESET_GAP_MS = 1000;

// Above this cadence the stride weight fades to the step weight. A tone at
// 1.8 Hz is either a 220 spm stride tone or a 110 spm walking step tone, and
// walking is far more common than a 220 spm sprint; a weight of 2 there would
// turn every brisk walk into a 220 spm run.
export const STRIDE_WEIGHT_FADE_FROM = 190;
export const STRIDE_WEIGHT_FADE_TO = 200;

export function strideWeightAt(cadence, strideWeight, stepWeight = STEP_WEIGHT) {
  if (cadence <= STRIDE_WEIGHT_FADE_FROM) return strideWeight;
  if (cadence >= STRIDE_WEIGHT_FADE_TO) return stepWeight;
  const k = (cadence - STRIDE_WEIGHT_FADE_FROM) / (STRIDE_WEIGHT_FADE_TO - STRIDE_WEIGHT_FADE_FROM);
  return strideWeight + k * (stepWeight - strideWeight);
}

function buildTables() {
  const count = Math.round((MAX_CADENCE - MIN_CADENCE) / CANDIDATE_STEP) + 1;
  const tables = [];
  for (let k = 0; k < count; k += 1) {
    const cadence = MIN_CADENCE + k * CANDIDATE_STEP;
    const stepFreq = cadence / 60;
    const strideFreq = cadence / 120;
    const entry = {
      cadence,
      stepCos: new Array(WINDOW),
      stepSin: new Array(WINDOW),
      strideCos: new Array(WINDOW),
      strideSin: new Array(WINDOW)
    };
    for (let i = 0; i < WINDOW; i += 1) {
      const seconds = (i * GRID_MS) / 1000;
      entry.stepCos[i] = Math.cos(TWO_PI * stepFreq * seconds);
      entry.stepSin[i] = Math.sin(TWO_PI * stepFreq * seconds);
      entry.strideCos[i] = Math.cos(TWO_PI * strideFreq * seconds);
      entry.strideSin[i] = Math.sin(TWO_PI * strideFreq * seconds);
    }
    tables.push(entry);
  }
  return tables;
}

function hannWindow(n) {
  const w = new Array(n);
  for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / (n - 1));
  return w;
}

export function createCombEstimator(options = {}) {
  const strideWeight = options.strideWeight === undefined ? STRIDE_WEIGHT : options.strideWeight;
  const stepWeight = options.stepWeight === undefined ? STEP_WEIGHT : options.stepWeight;
  let tables = null;
  let hann = null;
  let hannLength = 0;
  const win = [[], [], []];
  let prev = null;
  let nextGrid = 0;

  function clear() {
    win[0].length = 0;
    win[1].length = 0;
    win[2].length = 0;
    prev = null;
  }

  function writeGrid(a, b, alpha) {
    for (let axis = 0; axis < 3; axis += 1) {
      win[axis].push(a[axis] + alpha * (b[axis] - a[axis]));
      if (win[axis].length > WINDOW) win[axis].shift();
    }
  }

  function push(t, x, y, z) {
    const cur = { t, v: [x, y, z] };
    if (prev === null || t - prev.t > RESET_GAP_MS || t < prev.t) {
      clear();
      prev = cur;
      nextGrid = t;
      writeGrid(cur.v, cur.v, 0);
      nextGrid += GRID_MS;
      return;
    }
    while (nextGrid <= t) {
      const span = t - prev.t;
      const alpha = span > 0 ? (nextGrid - prev.t) / span : 1;
      writeGrid(prev.v, cur.v, alpha);
      nextGrid += GRID_MS;
    }
    prev = cur;
  }

  // Fraction of the window's total energy sitting at one tone (1 = a pure tone).
  function toneFraction(data, n, freq, total, gain) {
    let re = 0;
    let im = 0;
    const omega = (TWO_PI * freq * GRID_MS) / 1000;
    for (let i = 0; i < n; i += 1) {
      re += data[i] * Math.cos(omega * i);
      im += data[i] * Math.sin(omega * i);
    }
    return ((re * re + im * im) * gain) / total;
  }

  // prior: {center, sigma, highPenalty} picks between octaves (highPenalty
  // discounts candidates above 200 spm); the final frequency is refined on the
  // raw score, so the prior does not bias the estimate.
  function estimate(prior, altPrior) {
    const n = win[0].length;
    if (n < MIN_SAMPLES) return null;
    if (!tables) tables = buildTables();
    if (hannLength !== n) {
      hann = hannWindow(n);
      hannLength = n;
    }
    let sumW = 0;
    let sumW2 = 0;
    for (let i = 0; i < n; i += 1) {
      sumW += hann[i];
      sumW2 += hann[i] * hann[i];
    }
    const gain = (2 * sumW2) / (sumW * sumW);

    const data = [];
    let total = 0;
    for (let axis = 0; axis < 3; axis += 1) {
      const row = new Array(n);
      let mean = 0;
      for (let i = 0; i < n; i += 1) mean += win[axis][i];
      mean /= n;
      for (let i = 0; i < n; i += 1) {
        row[i] = (win[axis][i] - mean) * hann[i];
        total += row[i] * row[i];
      }
      data.push(row);
    }
    if (total < 1e-9) return null;
    const rms = Math.sqrt(total / sumW2);

    const count = tables.length;
    const score = new Array(count);
    let scoreSum = 0;
    for (let k = 0; k < count; k += 1) {
      const table = tables[k];
      let stepPower = 0;
      let stridePower = 0;
      for (let axis = 0; axis < 3; axis += 1) {
        const row = data[axis];
        let sc = 0;
        let ss = 0;
        let hc = 0;
        let hs = 0;
        for (let i = 0; i < n; i += 1) {
          const v = row[i];
          sc += v * table.stepCos[i];
          ss += v * table.stepSin[i];
          hc += v * table.strideCos[i];
          hs += v * table.strideSin[i];
        }
        stepPower += sc * sc + ss * ss;
        stridePower += hc * hc + hs * hs;
      }
      const weightStride = strideWeightAt(table.cadence, strideWeight, stepWeight);
      score[k] = ((stepWeight * stepPower + weightStride * stridePower) * gain) / total;
      scoreSum += score[k];
    }

    function pick(prior) {
      let best = 0;
      let bestScore = -1;
      for (let k = 0; k < count; k += 1) {
        let weight = 1;
        if (prior && prior.center > 0) {
          const z = (tables[k].cadence - prior.center) / (prior.sigma || 40);
          weight = Math.exp(-0.5 * z * z);
          if (prior.highPenalty && tables[k].cadence > STRIDE_WEIGHT_FADE_TO) {
            weight *= prior.highPenalty;
          }
        }
        if (score[k] * weight > bestScore) {
          bestScore = score[k] * weight;
          best = k;
        }
      }
      return best;
    }

    // Parabolic refinement on the raw score, then per-axis evidence at the
    // refined cadence.
    function describe(best) {
      let cadence = tables[best].cadence;
      if (best > 0 && best < count - 1) {
        const left = score[best - 1];
        const mid = score[best];
        const right = score[best + 1];
        const denominator = left - 2 * mid + right;
        if (denominator < 0) {
          const offset = (0.5 * (left - right)) / denominator;
          cadence += Math.max(-1, Math.min(1, offset)) * CANDIDATE_STEP;
        }
      }
      const fStep = [0, 0, 0];
      const fStride = [0, 0, 0];
      let share = 0;
      for (let axis = 0; axis < 3; axis += 1) {
        fStep[axis] = toneFraction(data[axis], n, cadence / 60, total, gain);
        fStride[axis] = toneFraction(data[axis], n, cadence / 120, total, gain);
        share += fStep[axis] + fStride[axis];
      }
      const meanScore = scoreSum / count;
      return {
        cadence,
        share,
        score: score[best],
        prominence: meanScore > 0 ? score[best] / meanScore : 0,
        fStep,
        fStride,
        rms
      };
    }

    const primary = describe(pick(prior));
    if (altPrior) {
      const altIndex = pick(altPrior);
      const alt = describe(altIndex);
      // Only report a real alternative: another peak, not the same one.
      if (Math.abs(alt.cadence - primary.cadence) > 0.12 * primary.cadence) {
        primary.alt = alt;
        primary.altRatio = primary.score > 0 ? alt.score / primary.score : Infinity;
      }
    }
    return primary;
  }

  return {
    push,
    estimate,
    reset: clear,
    get size() {
      return win[0].length;
    }
  };
}
