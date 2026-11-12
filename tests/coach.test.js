import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COACH_BASE_CADENCE,
  COACH_FOOT_STRIKE,
  COACH_FRAME_COUNT,
  createCoach,
  describeGap,
  drawCoachScene
} from '../agent/lib/coach.js';
import { COACH_FRAMES } from '../agent/lib/coach-frames.js';

function run(coach, fromMs, toMs, counting = true, stepMs = 50) {
  let strikes = 0;
  for (let t = fromMs; t <= toMs; t += stepMs) {
    if (coach.advance(t, counting)) strikes += 1;
  }
  return strikes;
}

test('baked frames: 24 phases, each with three layers of polygons', () => {
  assert.equal(COACH_FRAMES.length, COACH_FRAME_COUNT);
  for (const layers of COACH_FRAMES) {
    assert.equal(layers.length, 3);
    assert.ok(layers[0].length >= 1, 'silhouette present');
    for (const polygons of layers) {
      for (const points of polygons) {
        assert.ok(points.length >= 6 && points.length % 2 === 0);
      }
    }
  }
  assert.ok(COACH_BASE_CADENCE > 150 && COACH_BASE_CADENCE < 170);
});

test('coach: one foot landing per step, so landings per minute equal the cadence', () => {
  for (const cadence of [120, 160, 180, 200, 220]) {
    const coach = createCoach({ cadence });
    coach.advance(0, true);
    const strikes = run(coach, 50, 60000);
    assert.ok(Math.abs(strikes - cadence) <= 1, cadence + ' spm gave ' + strikes + ' landings');
    assert.ok(Math.abs(coach.steps - cadence) < 0.5, 'coach steps ' + coach.steps);
  }
});

test('coach: one full run cycle (24 frames) lasts two steps', () => {
  const coach = createCoach({ cadence: 180 });
  coach.advance(0, false);
  const seen = new Set();
  for (let t = 10; t <= 667; t += 10) {
    coach.advance(t, false);
    seen.add(coach.frame());
  }
  // 120000 / 180 = 667 ms per cycle: nearly every phase is visited.
  assert.ok(seen.size >= 22, 'visited ' + seen.size);
});

test('coach: a cadence change takes effect immediately and keeps the phase', () => {
  const coach = createCoach({ cadence: 160 });
  coach.advance(0, false);
  run(coach, 50, 2000, false);
  const phase = coach.phase;
  coach.setCadence(200);
  assert.equal(coach.phase, phase);
  coach.advance(2050, false);
  const moved = (coach.phase - phase + 1) % 1;
  assert.ok(Math.abs(moved - (50 * 200) / 120000) < 1e-6);
});

test('coach: syncToBeat pulls the landing phase toward the beat', () => {
  const coach = createCoach({ cadence: 180 });
  coach.advance(0, false);
  run(coach, 50, 500, false);
  const error = () => {
    let e = (coach.phase * 2 - COACH_FOOT_STRIKE * 2) % 1;
    if (e < 0) e += 1;
    if (e > 0.5) e -= 1;
    return Math.abs(e);
  };
  const before = error();
  for (let i = 0; i < 6; i += 1) coach.syncToBeat();
  assert.ok(error() <= before * 0.2 + 1e-9, before + ' -> ' + error());
});

test('coach: stalls are capped and only counting time adds steps', () => {
  const coach = createCoach({ cadence: 180 });
  coach.advance(0, true);
  coach.advance(10000, true);
  assert.ok(coach.steps <= (250 * 180) / 60000 + 1e-9, 'a 10 s stall counts at most 250 ms');
  const before = coach.steps;
  coach.advance(10100, false);
  assert.equal(coach.steps, before);
});

test('describeGap words', () => {
  assert.equal(describeGap(0, false), 'coach ready');
  assert.equal(describeGap(1.2, true), 'level with coach');
  assert.equal(describeGap(-4.4, true), 'behind 4 steps');
  assert.equal(describeGap(3, true), 'ahead 3 steps');
});

test('drawCoachScene only uses the basic canvas subset', () => {
  const calls = [];
  const ctx = new Proxy(
    {},
    {
      get(_t, name) {
        return (...args) => calls.push([name, args]);
      },
      set() {
        return true;
      }
    }
  );
  drawCoachScene(ctx, {
    width: 198,
    height: 176,
    scale: 0.86,
    frame: 3,
    now: 1000,
    scroll: 37,
    lastStrikeAt: 950,
    gapSteps: -3,
    running: true
  });
  const names = new Set(calls.map((call) => call[0]));
  for (const used of names) {
    assert.ok(
      ['clearRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill', 'stroke', 'fillText', 'draw', 'flush'].includes(used),
      'unexpected canvas call ' + used
    );
  }
  assert.ok(calls.filter((call) => call[0] === 'fill').length >= 6, 'figure polygons filled');
});
