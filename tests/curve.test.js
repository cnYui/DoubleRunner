import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSampleBuffer,
  drawLiveCurve,
  drawRecordChart,
  formatSeconds,
  green
} from '../agent/lib/curve.js';

function recordingContext(options = {}) {
  const calls = [];
  const ctx = {
    calls,
    lineWidth: 1,
    strokeStyle: '',
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: ''
  };
  for (const name of [
    'clearRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'fill', 'arc', 'closePath',
    'fillText', 'fillRect'
  ]) {
    ctx[name] = (...args) => calls.push([name, args]);
  }
  if (options.wx) ctx.flush = () => calls.push(['flush', []]);
  if (options.dash) ctx.setLineDash = (pattern) => calls.push(['setLineDash', [pattern]]);
  return ctx;
}

test('the sample buffer keeps only the time window', () => {
  const buffer = createSampleBuffer(1000);
  for (let t = 0; t <= 2500; t += 100) buffer.push({ t, value: 0, threshold: 0, step: false });
  assert.equal(buffer.length, 11);
  assert.equal(buffer.samples[0].t, 1500);
  buffer.clear();
  assert.equal(buffer.length, 0);
});

test('the live curve stays inside the canvas and marks every step', () => {
  const ctx = recordingContext({ wx: true, dash: true });
  const samples = [];
  for (let t = 0; t <= 6000; t += 50) {
    samples.push({ t, value: 2 * Math.sin(t / 100), threshold: 0.4, step: t % 1000 === 0 });
  }
  drawLiveCurve(ctx, {
    width: 446,
    height: 150,
    now: 6000,
    spanMs: 6000,
    samples,
    amplitude: 1, // values exceed the amplitude and must be clamped
    threshold: 0.4,
    beatAt: 5950,
    running: true,
    label: 'GYRO 60Hz',
    sublabel: '6s'
  });
  const points = ctx.calls.filter(([name]) => name === 'moveTo' || name === 'lineTo');
  assert.ok(points.length > 100);
  for (const [, [x, y]] of points) {
    assert.ok(x >= -2 && x <= 446, 'x ' + x);
    assert.ok(y >= 0 && y <= 150, 'y ' + y);
  }
  const arcs = ctx.calls.filter(([name]) => name === 'arc');
  // 7 step markers + current value + beat ring.
  assert.equal(arcs.length, 9);
  const fills = ctx.calls.filter(([name]) => name === 'fill');
  assert.equal(fills.length, 9); // the beat ring flashes (filled) right after a beat
  assert.deepEqual(ctx.calls[ctx.calls.length - 1], ['flush', []]);
  assert.ok(ctx.calls.some(([name, args]) => name === 'fillText' && args[0] === 'GYRO 60Hz'));
  assert.ok(ctx.calls.some(([name]) => name === 'setLineDash'));
});

test('the live curve works without optional context features and with no samples', () => {
  const ctx = recordingContext();
  drawLiveCurve(ctx, {
    width: 446,
    height: 150,
    now: 1000,
    spanMs: 6000,
    samples: [],
    amplitude: 0,
    threshold: 0,
    beatAt: 0,
    running: false
  });
  assert.ok(ctx.calls.some(([name]) => name === 'clearRect'));
  assert.ok(!ctx.calls.some(([name]) => name === 'flush'));
  const strokes = ctx.calls.filter(([name]) => name === 'stroke');
  assert.equal(strokes.length, 2); // baseline + idle beat ring
});

test('the record chart draws the cadence series, the target guide, and time labels', () => {
  const ctx = recordingContext({ wx: true, dash: true });
  const series = [];
  for (let second = 0; second < 90; second += 1) series.push([second, 170 + (second % 7), 3]);
  drawRecordChart(ctx, {
    width: 446,
    height: 150,
    series,
    targetCadence: 180,
    totalSeconds: 90,
    label: 'cadence'
  });
  const points = ctx.calls.filter(([name]) => name === 'moveTo' || name === 'lineTo');
  for (const [, [x, y]] of points) {
    assert.ok(x >= 30 && x <= 438, 'x ' + x);
    assert.ok(y >= 18 && y <= 134, 'y ' + y);
  }
  const texts = ctx.calls.filter(([name]) => name === 'fillText').map(([, args]) => args[0]);
  assert.ok(texts.includes('0:00'));
  assert.ok(texts.includes('1:30'));
  assert.ok(texts.includes('180'));
  assert.ok(texts.includes('cadence'));
  assert.ok(ctx.calls.some(([name, args]) => name === 'setLineDash' && args[0].length === 2));
  assert.deepEqual(ctx.calls[ctx.calls.length - 1], ['flush', []]);
});

test('an empty record chart still draws axes', () => {
  const ctx = recordingContext();
  drawRecordChart(ctx, { width: 446, height: 150, series: [], targetCadence: 180 });
  assert.ok(ctx.calls.filter(([name]) => name === 'stroke').length >= 2);
});

test('helpers', () => {
  assert.equal(formatSeconds(0), '0:00');
  assert.equal(formatSeconds(95), '1:35');
  assert.equal(green(0.5), 'rgba(64,255,94,0.5)');
});
