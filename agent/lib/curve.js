// Live gyroscope curve and the end-of-run cadence chart, drawn on the
// monochrome-green canvas. The drawing functions only call the basic
// CanvasRenderingContext2D subset (paths, arcs, rects, text) so they work
// with both the Web-style and the wx-style context; every optional call
// (setLineDash) is feature-checked.

export const GREEN = '#40ff5e';

export function green(alpha) {
  return 'rgba(64,255,94,' + alpha + ')';
}

// Time span of samples, oldest first.
export function createSampleBuffer(spanMs) {
  const samples = [];
  return {
    samples,
    push(sample) {
      samples.push(sample);
      const oldest = sample.t - spanMs;
      let drop = 0;
      while (drop < samples.length && samples[drop].t < oldest) drop += 1;
      if (drop) samples.splice(0, drop);
    },
    clear() {
      samples.length = 0;
    },
    get length() {
      return samples.length;
    }
  };
}

function dashed(ctx, pattern) {
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash(pattern);
}

function solid(ctx) {
  if (typeof ctx.setLineDash === 'function') ctx.setLineDash([]);
}

function flush(ctx) {
  if (typeof ctx.flush === 'function') ctx.flush();
  else if (typeof ctx.draw === 'function') ctx.draw();
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

// options: width, height, now, spanMs, samples, amplitude, beatAt, label,
// sublabel, threshold, running.
export function drawLiveCurve(ctx, options) {
  const width = options.width;
  const height = options.height;
  const now = options.now;
  const spanMs = options.spanMs;
  const samples = options.samples;
  const amplitude = Math.max(1e-6, options.amplitude);
  const mid = height / 2;
  const half = height / 2 - 10;
  const scaleX = width / spanMs;
  const yOf = (value) => mid - Math.max(-1, Math.min(1, value / amplitude)) * half;
  const xOf = (t) => width - (now - t) * scaleX;

  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 1;

  // Baseline and the step threshold guide.
  ctx.strokeStyle = green(0.24);
  line(ctx, 0, mid, width, mid);
  if (typeof options.threshold === 'number' && options.threshold > 0) {
    ctx.strokeStyle = green(0.18);
    dashed(ctx, [3, 4]);
    line(ctx, 0, yOf(options.threshold), width, yOf(options.threshold));
    solid(ctx);
  }

  // Signal.
  if (samples.length > 1) {
    ctx.strokeStyle = green(options.running ? 0.8 : 0.56);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      const x = xOf(sample.t);
      if (x < -2) continue;
      const y = yOf(sample.value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    if (started) ctx.stroke();
    ctx.lineWidth = 1;

    // Detected steps: full-luminance markers on the curve plus a tick at the
    // top edge so a step still reads when the curve is dense.
    ctx.fillStyle = GREEN;
    ctx.strokeStyle = green(0.48);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      if (!sample.step) continue;
      const x = xOf(sample.t);
      if (x < 0) continue;
      const y = yOf(sample.value);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
      line(ctx, x, 2, x, 8);
    }

    // Current value marker.
    const last = samples[samples.length - 1];
    ctx.fillStyle = GREEN;
    ctx.beginPath();
    ctx.arc(Math.min(width - 2, xOf(last.t)), yOf(last.value), 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Beat indicator: a ring at the top-right that fills on every metronome beat.
  const ringX = width - 12;
  const ringY = 12;
  const sinceBeat = typeof options.beatAt === 'number' ? now - options.beatAt : -1;
  const flash = sinceBeat >= 0 && sinceBeat < 110;
  ctx.beginPath();
  ctx.arc(ringX, ringY, 5, 0, Math.PI * 2);
  if (flash) {
    ctx.fillStyle = GREEN;
    ctx.fill();
  } else {
    ctx.strokeStyle = green(options.running ? 0.48 : 0.24);
    ctx.stroke();
  }

  // Labels in caption/mono typography.
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = green(0.48);
  if (options.label) ctx.fillText(options.label, 6, 5);
  if (options.sublabel) {
    ctx.textAlign = 'right';
    ctx.fillText(options.sublabel, width - 24, 5);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  flush(ctx);
}

export function formatSeconds(totalSeconds) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes + ':' + String(rest).padStart(2, '0');
}

// series: [[second, cadence, steps], ...] aggregated per active second.
export function drawRecordChart(ctx, options) {
  const width = options.width;
  const height = options.height;
  const series = options.series || [];
  const target = options.targetCadence;
  const left = 30;
  const top = 18;
  const bottom = height - 16;
  const plotWidth = width - left - 8;
  const plotHeight = bottom - top;
  const lastSecond = series.length ? series[series.length - 1][0] + 1 : 1;
  const totalSeconds = Math.max(1, options.totalSeconds || lastSecond);
  const cadences = series.map((point) => point[1]).filter((value) => value > 0);
  let low = target - 20;
  let high = target + 20;
  for (let index = 0; index < cadences.length; index += 1) {
    if (cadences[index] < low) low = cadences[index];
    if (cadences[index] > high) high = cadences[index];
  }
  low = Math.floor(low / 10) * 10;
  high = Math.ceil(high / 10) * 10;
  if (high <= low) high = low + 20;
  const yOf = (cadence) => bottom - ((cadence - low) / (high - low)) * plotHeight;
  const xOf = (second) => left + (second / totalSeconds) * plotWidth;

  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 1;
  ctx.font = '10px monospace';
  ctx.fillStyle = green(0.48);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';

  // Axes and a sparse grid.
  ctx.strokeStyle = green(0.24);
  line(ctx, left, top, left, bottom);
  line(ctx, left, bottom, width - 8, bottom);
  const gridStep = high - low > 80 ? 40 : 20;
  for (let cadence = low; cadence <= high; cadence += gridStep) {
    const y = yOf(cadence);
    ctx.strokeStyle = green(0.12);
    line(ctx, left, y, width - 8, y);
    ctx.fillText(String(cadence), left - 4, y);
  }

  // Target cadence guide.
  if (target > 0 && target >= low && target <= high) {
    ctx.strokeStyle = green(0.48);
    dashed(ctx, [4, 4]);
    line(ctx, left, yOf(target), width - 8, yOf(target));
    solid(ctx);
  }

  // Cadence area (12%) and line (72%).
  const points = series.filter((point) => point[1] > 0);
  if (points.length > 1) {
    ctx.beginPath();
    ctx.moveTo(xOf(points[0][0]), bottom);
    for (let index = 0; index < points.length; index += 1) {
      ctx.lineTo(xOf(points[index][0]), yOf(points[index][1]));
    }
    ctx.lineTo(xOf(points[points.length - 1][0]), bottom);
    ctx.closePath();
    ctx.fillStyle = green(0.12);
    ctx.fill();

    ctx.strokeStyle = green(0.72);
    ctx.beginPath();
    for (let index = 0; index < points.length; index += 1) {
      const x = xOf(points[index][0]);
      const y = yOf(points[index][1]);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Time labels along the bottom.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = green(0.48);
  ctx.fillText('0:00', left, bottom + 3);
  ctx.textAlign = 'right';
  ctx.fillText(formatSeconds(totalSeconds), width - 8, bottom + 3);
  ctx.textAlign = 'left';
  if (options.label) ctx.fillText(options.label, left + 4, 3);
  ctx.textBaseline = 'alphabetic';
  flush(ctx);
}
