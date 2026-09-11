import test from 'node:test';
import assert from 'node:assert/strict';
import { createPage, keyEvent, loadPageDefinition, sleep } from './helpers/load-page.js';
import { installRuntime, uninstallRuntime } from './helpers/runtime.js';
import { createStrideSignal } from '../agent/lib/demo.js';
import { STORAGE_KEY } from '../agent/lib/records.js';

const PAGE = 'agent/pages/run/index.ink';
const SAMPLE_MS = 1000 / 60;

// Every page created in a test is unloaded in its `finally`, so a failing
// assertion cannot leave intervals or sensors running.
const created = [];

function trackedPage(definition) {
  const page = createPage(definition);
  created.push(page);
  return page;
}

function unloadAll() {
  while (created.length) {
    const page = created.pop();
    try {
      page.onUnload();
    } catch (_error) {
      // Already unloaded by the test itself.
    }
  }
}

// A page on a virtual clock: `page._now()` returns `clock.time`, and
// `feed()` pushes stride samples through the fake gyroscope.
function virtualPage(definition, runtime, query) {
  const page = trackedPage(definition);
  const clock = { time: 1_000_000 };
  page._now = () => clock.time;
  page.onLoad(query);
  return {
    page,
    clock,
    sensor: () => runtime.calls.gyroscopes[runtime.calls.gyroscopes.length - 1],
    feed(signal, seconds, kind = 'gyroscope') {
      const sensors = kind === 'gyroscope' ? runtime.calls.gyroscopes : runtime.calls.accelerometers;
      const sensor = sensors[sensors.length - 1];
      const end = clock.time + seconds * 1000;
      while (clock.time < end) {
        clock.time += SAMPLE_MS;
        const sample = signal.sample(clock.time);
        sensor.emit(sample.x, sample.y, sample.z, clock.time);
      }
    },
    tap() {
      page.onKeyUp(keyEvent('GlobalHook'));
      page.onKeyDown(keyEvent('Enter'));
      page.onKeyUp(keyEvent('Enter'));
    },
    swipe(code) {
      page.onKeyUp(keyEvent('GlobalHook'));
      page.onKeyDown(keyEvent(code));
      page.onKeyUp(keyEvent(code));
    }
  };
}

test('page: load, show, run, detect cadence, pause, adjust target, finish, save', async () => {
  const runtime = installRuntime();
  try {
    const definition = await loadPageDefinition(PAGE);
    const v = virtualPage(definition, runtime, { targetCadence: 175 });
    const page = v.page;
    assert.equal(page.data.targetCadence, 175);
    assert.equal(page.data.state, 'idle');
    assert.equal(runtime.calls.gyroscopes.length, 1);
    assert.equal(v.sensor().started, 0, 'the sensor waits for onShow');
    assert.equal(runtime.calls.sounds.length, 2);

    page.onShow();
    assert.equal(v.sensor().started, 1);
    assert.equal(v.sensor().options.frequency, 60);

    // Tap: GlobalHook then Enter is one action.
    v.tap();
    assert.equal(page.data.state, 'running');
    assert.equal(page._metronome.running, true);
    assert.equal(page._metronome.bpm, 175);

    const signal = createStrideSignal({ cadence: 180, seed: 21 });
    v.feed(signal, 12);
    page._refreshUi(true);
    const cadence = Number(page.data.cadenceText);
    assert.ok(Math.abs(cadence - 180) <= 3, 'cadence ' + page.data.cadenceText);
    const steps = Number(page.data.stepsText);
    assert.ok(steps >= 32 && steps <= 37, 'steps ' + page.data.stepsText);
    assert.equal(page.data.clock, '00:12');
    assert.ok(page.data.targetLabel.includes('偏快'), page.data.targetLabel);
    assert.ok(page._buffer.length > 300, 'curve buffer holds the last six seconds');

    // Swipe forward: target +5 and the running metronome retunes.
    v.swipe('ArrowUp');
    assert.equal(page.data.targetCadence, 180);
    assert.equal(page._metronome.bpm, 180);
    page._refreshUi(true);
    assert.ok(page.data.targetLabel.includes('与目标一致'), page.data.targetLabel);

    // Tap: pause. The metronome stops, the sensor keeps previewing.
    v.tap();
    assert.equal(page.data.state, 'paused');
    assert.equal(page._metronome.running, false);
    assert.equal(v.sensor().stopped, 0);

    // Swipe back while paused: finish and save.
    v.clock.time += 500;
    v.swipe('ArrowDown');
    assert.equal(page.data.state, 'finished');
    assert.equal(page.data.stepsLabel, '步数 · 已保存');
    const saved = JSON.parse(runtime.storage.get(STORAGE_KEY));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].steps, steps);
    assert.equal(saved[0].targetCadence, 180);
    assert.ok(Math.abs(saved[0].avgCadence - 180) <= 4, 'avg ' + saved[0].avgCadence);
    assert.ok(saved[0].series.length >= 11, 'series ' + saved[0].series.length);
    assert.equal(saved[0].source, 'gyroscope');
    assert.equal(page.data.cadenceText, String(saved[0].avgCadence));

    // Tap after finishing: back to idle with the last record shown.
    v.tap();
    assert.equal(page.data.state, 'idle');
    assert.ok(page.data.lastRecordText.startsWith('上次 '), page.data.lastRecordText);
    assert.equal(page.data.stepsText, '0');

    page.onUnload();
    assert.equal(v.sensor().stopped, 1);
    assert.equal(runtime.calls.sounds[0].destroyed, 1);
  } finally {
    unloadAll();
    uninstallRuntime();
  }
});

test('page: hide pauses a run and releases the sensor; show resumes the preview', async () => {
  const runtime = installRuntime();
  try {
    const definition = await loadPageDefinition(PAGE);
    const v = virtualPage(definition, runtime, {});
    const page = v.page;
    page.onShow();
    v.tap();
    const signal = createStrideSignal({ cadence: 176, seed: 8 });
    v.feed(signal, 5);
    page.onHide();
    assert.equal(page.data.state, 'paused');
    assert.equal(page._metronome.running, false);
    assert.equal(v.sensor().stopped, 1);
    assert.equal(page._frameTimer, null);
    assert.equal(page._uiTimer, null);
    // Keys are ignored while hidden.
    v.tap();
    assert.equal(page.data.state, 'paused');
    page.onShow();
    assert.equal(v.sensor().started, 2);
    assert.equal(page.data.state, 'paused');
    // Unloading a paused run with steps saves it silently.
    page.onUnload();
    const saved = JSON.parse(runtime.storage.get(STORAGE_KEY));
    assert.equal(saved.length, 1);
    assert.ok(saved[0].steps > 10);
  } finally {
    unloadAll();
    uninstallRuntime();
  }
});

test('page: a gyroscope error falls back to the accelerometer, then to the demo signal', async () => {
  const runtime = installRuntime();
  try {
    const definition = await loadPageDefinition(PAGE);
    const v = virtualPage(definition, runtime, {});
    const page = v.page;
    page.onShow();
    v.sensor().fail('NotReadableError', 'no gyroscope backend');
    assert.equal(runtime.calls.accelerometers.length, 1);
    assert.equal(runtime.calls.accelerometers[0].started, 1);
    assert.equal(page._source, 'accelerometer');
    assert.equal(page.data.notice, '陀螺仪不可用，改用加速度计');
    runtime.calls.accelerometers[0].fail('NotReadableError', 'no accelerometer either');
    assert.equal(page._source, 'demo');
    assert.ok(page.data.stateLabel.includes('演示'));
    assert.notEqual(page._demoTimer, null);
    page.onUnload();
    assert.equal(page._demoTimer, null);
  } finally {
    unloadAll();
    uninstallRuntime();
  }
});

test('page: without any sensor the demo signal drives the curve and steps', async () => {
  const runtime = installRuntime({ gyroscope: false, accelerometer: false });
  try {
    const definition = await loadPageDefinition(PAGE);
    const page = trackedPage(definition);
    page.onLoad({ targetCadence: 170 });
    page.onShow();
    assert.equal(page._source, 'demo');
    page.onKeyUp(keyEvent('Enter'));
    assert.equal(page.data.state, 'running');
    await sleep(1500);
    page._refreshUi(true);
    assert.ok(page._buffer.length > 40, 'demo samples arrive on the real timer');
    assert.ok(Number(page.data.stepsText) >= 2, 'steps ' + page.data.stepsText);
    page.onUnload();
    const saved = JSON.parse(runtime.storage.get(STORAGE_KEY));
    assert.equal(saved[0].source, 'demo');
  } finally {
    unloadAll();
    uninstallRuntime();
  }
});

test('page: demo requested from the query wins over an available sensor', async () => {
  const runtime = installRuntime();
  try {
    const definition = await loadPageDefinition(PAGE);
    const v = virtualPage(definition, runtime, { demo: true, targetCadence: '185' });
    v.page.onShow();
    assert.equal(v.page._source, 'demo');
    assert.equal(v.page.data.targetCadence, 185);
    assert.equal(v.sensor().started, 0);
    v.page.onUnload();
  } finally {
    unloadAll();
    uninstallRuntime();
  }
});

test('page: the metronome ticks the Sound at about three beats per second', async () => {
  const runtime = installRuntime();
  try {
    const definition = await loadPageDefinition(PAGE);
    const page = trackedPage(definition);
    page.onLoad({ targetCadence: 180 });
    page.onShow();
    page.onKeyUp(keyEvent('Enter'));
    await sleep(1100);
    page.onKeyUp(keyEvent('Enter'));
    const plays = runtime.calls.plays.length;
    assert.ok(plays >= 3 && plays <= 5, 'plays ' + plays);
    assert.equal(runtime.calls.plays[0].src, '/assets/tick-accent.wav');
    assert.equal(runtime.calls.plays[1].src, '/assets/tick.wav');
    const stats = page._metronome.stats();
    assert.ok(stats.achievedRate > 2.5 && stats.achievedRate < 3.5, 'rate ' + stats.achievedRate);
    await sleep(400);
    assert.equal(runtime.calls.plays.length, plays, 'no beats after pausing');
    page.onUnload();
  } finally {
    unloadAll();
    uninstallRuntime();
  }
});

test('page: malformed queries fall back to the defaults and out-of-range targets clamp', async () => {
  const runtime = installRuntime();
  try {
    const definition = await loadPageDefinition(PAGE);
    for (const query of [undefined, null, 'x', [], { targetCadence: 'abc' }]) {
      const page = trackedPage(definition);
      page.onLoad(query);
      assert.equal(page.data.targetCadence, 180);
      page.onUnload();
    }
    const high = trackedPage(definition);
    high.onLoad({ targetCadence: 999 });
    assert.equal(high.data.targetCadence, 220);
    high.onUnload();
    const low = trackedPage(definition);
    low.onLoad({ targetCadence: 12 });
    assert.equal(low.data.targetCadence, 120);
    // Swipes clamp at the limits and never leave the page in a broken state.
    low.onShow();
    low.onKeyUp(keyEvent('ArrowDown'));
    assert.equal(low.data.targetCadence, 120);
    low.onKeyUp(keyEvent('ArrowUp'));
    assert.equal(low.data.targetCadence, 125);
    low.onUnload();
  } finally {
    unloadAll();
    uninstallRuntime();
  }
});

test('page: the canvas is drawn through the wx context when no element API exists', async () => {
  const runtime = installRuntime();
  try {
    const definition = await loadPageDefinition(PAGE);
    const page = trackedPage(definition);
    page.onLoad({});
    page.onShow();
    page._frame();
    assert.equal(page._ctxVia, 'wx.createCanvasContext');
    assert.ok(runtime.context.calls.some(([name]) => name === 'clearRect'));
    assert.ok(runtime.context.calls.some(([name]) => name === 'flush'));
    page.onUnload();
  } finally {
    unloadAll();
    uninstallRuntime();
  }
});
