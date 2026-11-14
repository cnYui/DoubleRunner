// Head-mounted gait scenarios for the cadence detector.
//
// A runner's head nods on every step (step rate) and swings left and right
// once per stride (half the step rate). These scenarios fail on a detector
// that counts peaks on a single axis: with the left-right swing as the
// strongest signal it reports half the cadence (see docs/cadence-detection.md
// for the before / after numbers).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCadenceDetector } from '../agent/lib/cadence.js';
import { createHeadSignal, createRandom } from '../agent/lib/demo.js';
import { createCombEstimator } from '../agent/lib/spectrum.js';

const SAMPLE_MS = 1000 / 60;

function runHead(detector, signal, seconds, options = {}) {
  const jitter = options.jitter || 0;
  const drop = options.drop || 0;
  const random = createRandom(options.randomSeed || 99);
  const countFrom = options.countFrom === undefined ? 10000 : options.countFrom;
  let t = options.startAt || 0;
  const end = t + seconds * 1000;
  let stepsAfter = 0;
  let last = null;
  const cadences = [];
  while (t <= end) {
    const sample = signal.sample(t);
    last = detector.push(t, sample.x, sample.y, sample.z);
    if (t >= countFrom) {
      if (last.step) stepsAfter += 1;
      cadences.push(last.cadence);
    }
    t += SAMPLE_MS + (jitter ? (random() - 0.5) * 2 * jitter : 0);
    if (drop && random() < drop) t += SAMPLE_MS;
  }
  return { last, stepsAfter, cadences, endT: t };
}

function within(cadences, truth, tolerance) {
  const ok = cadences.filter((value) => Math.abs(value - truth) <= tolerance).length;
  return ok / cadences.length;
}

function assertSteps(result, cadence, seconds, tolerance = 0.06) {
  const expected = (cadence / 60) * seconds;
  const ratio = result.stepsAfter / expected;
  assert.ok(
    Math.abs(ratio - 1) <= tolerance,
    'steps ' + result.stepsAfter + ' vs ' + expected.toFixed(0)
  );
}

test('left-right swing as the strongest signal still reads 180, not 90', () => {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  detector.setExpected(180);
  const signal = createHeadSignal({
    cadence: 180,
    pitch: 0.12,
    lateral: 0.5,
    seed: 2,
    turnEveryMs: 6000
  });
  const result = runHead(detector, signal, 50);
  assert.ok(within(result.cadences, 180, 5) > 0.85, 'share in tolerance');
  assertSteps(result, 180, 40);
  assert.equal(result.last.mode, 'stride', 'steps are counted on the left-right lobes');
});

test('a step-rate nod as the strongest signal is counted per peak', () => {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  const signal = createHeadSignal({
    cadence: 176,
    pitch: 0.6,
    lateral: 0.1,
    seed: 3,
    turnEveryMs: 6000
  });
  const result = runHead(detector, signal, 50);
  assert.ok(within(result.cadences, 176, 5) > 0.85);
  assertSteps(result, 176, 40);
  assert.equal(result.last.mode, 'step');
});

test('the sensor mounting does not matter: random rotations all read the cadence', () => {
  for (let seed = 1; seed <= 6; seed += 1) {
    const r = createRandom(seed * 17);
    const mount = [r() * 6.28, (r() - 0.5) * 3.1, r() * 6.28];
    const cadence = 168 + seed * 2;
    const detector = createCadenceDetector({ source: 'gyroscope' });
    detector.setExpected(175);
    const signal = createHeadSignal({
      cadence,
      pitch: 0.15,
      lateral: 0.45,
      seed: 20 + seed,
      mount,
      turnEveryMs: 7000
    });
    const result = runHead(detector, signal, 45);
    assert.ok(within(result.cadences, cadence, 6) > 0.8, 'mount ' + seed);
    assertSteps(result, cadence, 35, 0.08);
  }
});

test('large deliberate head turns do not derail the cadence', () => {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  const signal = createHeadSignal({
    cadence: 180,
    pitch: 0.25,
    lateral: 0.35,
    seed: 36,
    turnEveryMs: 3000,
    turnRate: 1.6
  });
  const result = runHead(detector, signal, 50);
  assert.ok(within(result.cadences, 180, 6) > 0.8);
  assertSteps(result, 180, 40, 0.1);
});

test('uneven left and right lobes do not bias the cadence', () => {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  const signal = createHeadSignal({
    cadence: 176,
    pitch: 0.2,
    lateral: 0.45,
    asymmetry: 0.12,
    seed: 5,
    turnEveryMs: 7000
  });
  const result = runHead(detector, signal, 50);
  assert.ok(within(result.cadences, 176, 5) > 0.85);
});

test('weak signals and jittery, lossy timestamps are still measured', () => {
  const weak = createCadenceDetector({ source: 'gyroscope' });
  const weakResult = runHead(
    weak,
    createHeadSignal({ cadence: 165, pitch: 0.15, lateral: 0.12, noise: 0.06, seed: 6 }),
    45
  );
  assert.ok(within(weakResult.cadences, 165, 5) > 0.85, 'weak');

  const rough = createCadenceDetector({ source: 'gyroscope' });
  const roughResult = runHead(
    rough,
    createHeadSignal({ cadence: 180, pitch: 0.3, lateral: 0.35, seed: 7, turnEveryMs: 8000 }),
    45,
    { jitter: 5, drop: 0.05 }
  );
  assert.ok(within(roughResult.cadences, 180, 6) > 0.8, 'jitter and drops');
});

test('swiping the target from 180 to 175 to 170 is followed within a few seconds', () => {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  detector.setExpected(180);
  const signal = createHeadSignal({ cadence: 180, pitch: 0.3, lateral: 0.4, seed: 8, wobble: 0 });
  let r = runHead(detector, signal, 20, { countFrom: 0 });
  assert.ok(Math.abs(r.last.cadence - 180) <= 3, 'at 180: ' + r.last.cadence);
  signal.setCadence(175);
  r = runHead(detector, signal, 12, { startAt: r.endT, countFrom: 0 });
  assert.ok(Math.abs(r.last.cadence - 175) <= 3, 'at 175: ' + r.last.cadence);
  signal.setCadence(170);
  r = runHead(detector, signal, 12, { startAt: r.endT, countFrom: 0 });
  assert.ok(Math.abs(r.last.cadence - 170) <= 3, 'at 170: ' + r.last.cadence);
});

test('a brisk walk stays a walk, and walking into a run re-locks to the run', () => {
  const walk = createCadenceDetector({ source: 'gyroscope' });
  walk.setExpected(170);
  const walkResult = runHead(
    walk,
    createHeadSignal({ cadence: 110, pitch: 0.4, lateral: 0.08, seed: 33 }),
    40
  );
  assert.ok(within(walkResult.cadences, 110, 4) > 0.9, 'walk is not read as 220');

  const detector = createCadenceDetector({ source: 'gyroscope' });
  detector.setExpected(180);
  const signal = createHeadSignal({ cadence: 110, pitch: 0.4, lateral: 0.3, seed: 34, wobble: 0 });
  let r = runHead(detector, signal, 20, { countFrom: 0 });
  assert.ok(Math.abs(r.last.cadence - 110) <= 4, 'walking: ' + r.last.cadence);
  signal.setCadence(180);
  r = runHead(detector, signal, 14, { startAt: r.endT, countFrom: 0 });
  assert.ok(Math.abs(r.last.cadence - 180) <= 4, 'running: ' + r.last.cadence);
});

test('the target cadence only chooses the octave and never pulls the measurement', () => {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  detector.setExpected(185);
  const signal = createHeadSignal({ cadence: 160, pitch: 0.4, lateral: 0.3, seed: 41, wobble: 0 });
  const result = runHead(detector, signal, 30, { countFrom: 0 });
  assert.ok(Math.abs(result.last.cadence - 160) <= 3, 'cadence ' + result.last.cadence);
});

test('stopping drops the cadence to zero although the spectrum window is full of running', () => {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  const signal = createHeadSignal({ cadence: 180, pitch: 0.4, lateral: 0.3, seed: 35 });
  let r = runHead(detector, signal, 25, { countFrom: 0 });
  assert.ok(r.last.cadence > 170);
  signal.setCadence(0);
  r = runHead(detector, signal, 12, { startAt: r.endT, countFrom: 0 });
  assert.equal(r.last.cadence, 0);
});

test('the comb estimator reads a pure stride tone as half the step rate', () => {
  const comb = createCombEstimator();
  assert.equal(comb.estimate(), null, 'no estimate before the window has data');
  // A left-right swing at 1.5 Hz on one axis: 180 steps/min, never 90 or 360.
  for (let t = 0; t <= 8000; t += 1000 / 60) {
    comb.push(t, 0, 0.6 * Math.sin((2 * Math.PI * 1.5 * t) / 1000), 0);
  }
  const est = comb.estimate({ center: 170, sigma: 45 });
  assert.ok(Math.abs(est.cadence - 180) <= 2, 'cadence ' + est.cadence);
  assert.ok(est.fStride[1] > 0.8, 'stride tone on the sway axis');
  assert.ok(est.share > 0.8);
});
