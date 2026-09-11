import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CADENCE_TIMEOUT_MS,
  createCadenceDetector,
  median
} from '../agent/lib/cadence.js';
import { createStrideSignal } from '../agent/lib/demo.js';

const SAMPLE_MS = 1000 / 60;

// Feeds `seconds` of the stride signal into the detector, returning the last
// result and the number of steps detected after `countFrom` ms.
function run(detector, signal, seconds, options = {}) {
  const countFrom = options.countFrom || 0;
  const startAt = options.startAt || 0;
  let t = startAt;
  let last = null;
  let stepsAfter = 0;
  const cadences = [];
  const end = startAt + seconds * 1000;
  while (t <= end) {
    if (options.onTick) options.onTick(t);
    const sample = signal.sample(t);
    last = detector.push(t, sample.x, sample.y, sample.z);
    if (last.step && t >= startAt + countFrom) stepsAfter += 1;
    if (t >= startAt + countFrom) cadences.push(last.cadence);
    t += SAMPLE_MS;
  }
  return { last, stepsAfter, cadences };
}

test('median handles odd, even, and empty input', () => {
  assert.equal(median([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('a 180 spm stride is detected within 3 spm and counts one step per nod', () => {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  const signal = createStrideSignal({ cadence: 180, seed: 7 });
  const result = run(detector, signal, 20, { countFrom: 5000 });
  assert.ok(Math.abs(result.last.cadence - 180) <= 3, 'cadence ' + result.last.cadence);
  // 15 seconds at 3 steps/s = 45 steps; the two-lobed nod must not double count.
  assert.ok(result.stepsAfter >= 43 && result.stepsAfter <= 47, 'steps ' + result.stepsAfter);
  assert.equal(result.last.axis, 0);
});

test('a slow 110 spm walk is detected too', () => {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  const signal = createStrideSignal({ cadence: 110, seed: 3, amplitude: 0.8 });
  const result = run(detector, signal, 20, { countFrom: 6000 });
  assert.ok(Math.abs(result.last.cadence - 110) <= 3, 'cadence ' + result.last.cadence);
});

test('sensor noise without motion produces no steps', () => {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  const signal = createStrideSignal({ cadence: 0, seed: 11, noise: 0.08 });
  const result = run(detector, signal, 15);
  assert.equal(result.last.steps, 0);
  assert.equal(result.last.cadence, 0);
});

test('the detector follows a cadence change within a few seconds', () => {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  const signal = createStrideSignal({ cadence: 160, seed: 5 });
  run(detector, signal, 10);
  signal.setCadence(184);
  const result = run(detector, signal, 8, { startAt: 10000 + SAMPLE_MS, countFrom: 0 });
  assert.ok(Math.abs(result.last.cadence - 184) <= 4, 'cadence ' + result.last.cadence);
});

test('the dominant axis is chosen automatically', () => {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  const signal = createStrideSignal({ cadence: 172, seed: 9, axis: 2 });
  const result = run(detector, signal, 15, { countFrom: 5000 });
  assert.equal(result.last.axis, 2);
  assert.ok(Math.abs(result.last.cadence - 172) <= 3, 'cadence ' + result.last.cadence);
});

test('accelerometer input with a gravity offset works after baseline removal', () => {
  const detector = createCadenceDetector({ source: 'accelerometer' });
  const signal = createStrideSignal({
    cadence: 176,
    seed: 2,
    amplitude: 3.5,
    noise: 0.3,
    axis: 2,
    offset: [0.4, 0.2, 9.81]
  });
  const result = run(detector, signal, 20, { countFrom: 5000 });
  assert.ok(Math.abs(result.last.cadence - 176) <= 3, 'cadence ' + result.last.cadence);
  assert.equal(result.last.axis, 2);
});

test('cadence drops to zero after the runner stops', () => {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  const signal = createStrideSignal({ cadence: 180, seed: 4 });
  run(detector, signal, 10);
  signal.setCadence(0);
  const result = run(detector, signal, (CADENCE_TIMEOUT_MS + 1500) / 1000, {
    startAt: 10000 + SAMPLE_MS
  });
  assert.equal(result.last.cadence, 0);
});

test('a long gap in samples restarts the filters instead of inventing a huge interval', () => {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  const signal = createStrideSignal({ cadence: 180, seed: 6 });
  run(detector, signal, 8);
  const stepsBefore = detector.steps;
  const result = run(detector, signal, 8, { startAt: 20000, countFrom: 4000 });
  assert.ok(Math.abs(result.last.cadence - 180) <= 3, 'cadence ' + result.last.cadence);
  assert.ok(detector.steps > stepsBefore);
  assert.ok(Math.abs(result.last.cadence - 180) <= 3);
});

test('non-numeric readings are treated as zero and reset() clears the state', () => {
  const detector = createCadenceDetector();
  const result = detector.push(0, null, undefined, NaN);
  assert.equal(result.value, 0);
  assert.equal(result.step, false);
  detector.push(16, 1, 0, 0);
  detector.reset();
  assert.equal(detector.steps, 0);
  assert.equal(detector.cadence, 0);
});
