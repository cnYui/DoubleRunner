import test from 'node:test';
import assert from 'node:assert/strict';
import { RESYNC_BEATS, createMetronome } from '../agent/lib/metronome.js';

function harness() {
  let time = 0;
  let nextId = 1;
  const timers = new Map();
  const beats = [];
  const metronome = createMetronome({
    now: () => time,
    schedule: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: time + ms, fn });
      return id;
    },
    cancel: (id) => timers.delete(id),
    onBeat: (beat) => beats.push({ ...beat, now: time })
  });
  function runDue() {
    let fired = true;
    while (fired) {
      fired = false;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.fn();
          fired = true;
        }
      }
    }
  }
  return {
    metronome,
    beats,
    timers,
    // Advances the clock in small increments so timers fire at their due time.
    advance(ms, step = 1) {
      const end = time + ms;
      while (time < end) {
        time = Math.min(end, time + step);
        runDue();
      }
    },
    // Jumps the clock without firing timers on the way (a stalled runtime).
    jump(ms) {
      time += ms;
      runDue();
    }
  };
}

test('180 bpm fires three beats per second on the ideal clock', () => {
  const h = harness();
  h.metronome.start(180);
  h.advance(3000);
  // Beats at 0, 333.33, ... 3000 -> 10 beats.
  assert.equal(h.beats.length, 10);
  assert.deepEqual(h.beats.slice(0, 4).map((beat) => Math.round(beat.dueAt)), [0, 333, 667, 1000]);
  assert.ok(h.beats.every((beat) => beat.lateMs <= 1));
  const stats = h.metronome.stats();
  assert.ok(Math.abs(stats.achievedRate - 3) < 0.02, 'rate ' + stats.achievedRate);
  assert.equal(h.beats[0].accent, true);
  assert.equal(h.beats[1].accent, false);
  assert.equal(h.beats[4].accent, true);
});

test('a late callback does not shift the following beats', () => {
  const h = harness();
  h.metronome.start(180);
  h.advance(300);
  // The runtime stalls for 120 ms: the second beat fires late ...
  h.jump(120);
  assert.equal(h.beats.length, 2);
  assert.ok(Math.abs(h.beats[1].lateMs - (420 - 1000 / 3)) < 1);
  // ... but the third beat is still due at 666.67 ms.
  h.advance(300);
  assert.equal(h.beats.length, 3);
  assert.ok(Math.abs(h.beats[2].dueAt - 2000 / 3) < 0.01);
  assert.ok(h.beats[2].lateMs <= 1);
});

test('changing the bpm keeps the phase and retunes the interval', () => {
  const h = harness();
  h.metronome.start(120);
  h.advance(1000);
  assert.equal(h.beats.length, 3); // 0, 500, 1000
  h.metronome.setBpm(180);
  assert.equal(h.metronome.intervalMs, 1000 / 3);
  h.advance(1000);
  // Next beats at 1333.33, 1666.67, 2000.
  assert.equal(h.beats.length, 6);
  assert.ok(Math.abs(h.beats[3].dueAt - (1000 + 1000 / 3)) < 0.01);
  assert.ok(Math.abs(h.beats[5].dueAt - 2000) < 0.01);
});

test('stop cancels the pending beat and leaves no timer behind', () => {
  const h = harness();
  h.metronome.start(180);
  h.advance(100);
  h.metronome.stop();
  assert.equal(h.timers.size, 0);
  h.advance(2000);
  assert.equal(h.beats.length, 1);
  assert.equal(h.metronome.running, false);
});

test('a long stall re-anchors instead of firing a burst of catch-up beats', () => {
  const h = harness();
  h.metronome.start(180);
  h.advance(340);
  const before = h.beats.length;
  h.jump((RESYNC_BEATS + 2) * (1000 / 3));
  assert.equal(h.beats.length, before + 1);
  h.advance(1000);
  // After re-anchoring, beats continue at the normal rate from the stall point.
  assert.equal(h.beats.length, before + 1 + 3);
  assert.ok(h.beats[h.beats.length - 1].lateMs <= 1);
});

test('setBpm while stopped only stores the new interval', () => {
  const h = harness();
  h.metronome.setBpm(150);
  assert.equal(h.metronome.running, false);
  assert.equal(h.metronome.intervalMs, 400);
  assert.equal(h.timers.size, 0);
});
