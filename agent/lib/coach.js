// The pace coach: a 3D mannequin seen from behind, running away from you at the target cadence.
//
// The pictures come from the CC0 Quaternius Universal Animation Library
// (Jog_Fwd_Loop), rendered once in Blender and baked into vector layers
// (lib/coach-frames.js, built by tools/build_coach.py). This module only
// decides which of the 24 phases to show: the run cycle is two steps long, so
// at `cadence` steps per minute one cycle lasts 120000 / cadence ms and the
// playback speed is simply cadence / COACH_BASE_CADENCE.

import {
  COACH_BASE_CADENCE,
  COACH_FOOT_STRIKE,
  COACH_FRAMES,
  COACH_FRAME_COUNT,
  COACH_HEIGHT,
  COACH_WIDTH
} from './coach-frames.js';

export { COACH_BASE_CADENCE, COACH_FOOT_STRIKE, COACH_FRAME_COUNT, COACH_HEIGHT, COACH_WIDTH };

const LAYER_ALPHA = [0.34, 0.62, 1];
// Ground texture scrolls this many pixels per step so the coach reads as
// moving forward; one step is about one metre.
const PX_PER_STEP = 20;
const MAX_ADVANCE_MS = 250;

function green(alpha) {
  return 'rgba(64,255,94,' + alpha + ')';
}

function wrap01(value) {
  return value - Math.floor(value);
}

export function createCoach(options) {
  const opts = options || {};
  let cadence = opts.cadence || 180;
  let phase = 0;
  let lastAt = null;
  let steps = 0;
  let scroll = 0;
  let lastStrikeAt = -1e9;

  return {
    setCadence(value) {
      cadence = value;
    },
    get cadence() {
      return cadence;
    },
    get phase() {
      return phase;
    },
    // Steps the coach has taken since the last `resetSteps()`; counted only
    // while `counting` is true so the "gap" is measured over the same time
    // as the runner's own step count.
    get steps() {
      return steps;
    },
    resetSteps() {
      steps = 0;
    },
    get scroll() {
      return scroll;
    },
    get lastStrikeAt() {
      return lastStrikeAt;
    },
    // Moves the animation to `now`. Returns true when a foot landed in this
    // interval.
    advance(now, counting) {
      if (lastAt === null) {
        lastAt = now;
        return false;
      }
      const dt = Math.max(0, Math.min(MAX_ADVANCE_MS, now - lastAt));
      lastAt = now;
      if (dt === 0) return false;
      const before = phase;
      const stepsDone = (dt * cadence) / 60000;
      phase = wrap01(phase + stepsDone / 2);
      scroll = (scroll + stepsDone * PX_PER_STEP) % 1000000;
      if (counting) steps += stepsDone;
      // A foot lands at COACH_FOOT_STRIKE and again half a cycle later.
      const a = before * 2 - COACH_FOOT_STRIKE * 2;
      const b = a + stepsDone;
      if (Math.floor(b) !== Math.floor(a)) {
        lastStrikeAt = now;
        return true;
      }
      return false;
    },
    // Pulls the animation so a foot lands on the metronome beat. Called on
    // every beat while running; moves half of the error each time, so a
    // phase that is a little off converges within a few beats without a jump.
    syncToBeat() {
      let err = wrap01(phase * 2 - COACH_FOOT_STRIKE * 2);
      if (err > 0.5) err -= 1;
      phase = wrap01(phase - (err / 2) * 0.5);
    },
    frame() {
      return Math.floor(phase * COACH_FRAME_COUNT) % COACH_FRAME_COUNT;
    },
    reset() {
      phase = 0;
      lastAt = null;
      steps = 0;
      scroll = 0;
      lastStrikeAt = -1e9;
    }
  };
}

// One of the 24 baked frames, drawn as three nested polygons layers of
// increasing brightness. x/y are the top-left corner, `scale` the zoom.
export function drawCoachFigure(ctx, frameIndex, x, y, scale) {
  const layers = COACH_FRAMES[frameIndex];
  for (let layer = 0; layer < layers.length; layer += 1) {
    ctx.fillStyle = green(LAYER_ALPHA[layer]);
    const polygons = layers[layer];
    for (let index = 0; index < polygons.length; index += 1) {
      const points = polygons[index];
      ctx.beginPath();
      ctx.moveTo(x + points[0] * scale, y + points[1] * scale);
      for (let point = 2; point < points.length; point += 2) {
        ctx.lineTo(x + points[point] * scale, y + points[point + 1] * scale);
      }
      ctx.closePath();
      ctx.fill();
    }
  }
}

function flush(ctx) {
  if (typeof ctx.flush === 'function') ctx.flush();
  else if (typeof ctx.draw === 'function') ctx.draw();
}

// options: width, height, frame, now, scroll, lastStrikeAt, gapSteps,
// running, scale. The coach is seen from behind: the floor streams towards
// the viewer, and the coach looks smaller (further ahead) when you are
// behind it and larger (closer) when you are ahead.
export function drawCoachScene(ctx, options) {
  const width = options.width;
  const height = options.height;
  const gap = Math.max(-8, Math.min(8, options.gapSteps || 0));
  const scale = (options.scale || 1) * (1 + gap * 0.015);
  const footY = height - 22;
  const horizonY = Math.round(height * 0.2);
  const figureW = COACH_WIDTH * scale;
  const figureH = COACH_HEIGHT * scale;
  const centerX = width / 2;
  const figureX = Math.round(centerX - figureW / 2);
  const figureY = Math.round(footY - figureH + 2);

  ctx.clearRect(0, 0, width, height);
  ctx.lineWidth = 1;

  // Floor: two edges converging on the horizon plus cross lines that move
  // towards the viewer at the coach's pace.
  const sinceStrike = options.now - options.lastStrikeAt;
  const flash = options.running && sinceStrike >= 0 && sinceStrike < 110;
  ctx.strokeStyle = green(0.3);
  ctx.beginPath();
  ctx.moveTo(centerX, horizonY);
  ctx.lineTo(0, height);
  ctx.moveTo(centerX, horizonY);
  ctx.lineTo(width, height);
  ctx.stroke();
  const rows = 7;
  const offset = (options.scroll / 72) % 1;
  ctx.strokeStyle = green(0.22);
  ctx.beginPath();
  for (let row = 0; row < rows; row += 1) {
    const t = (row + offset) / rows;
    const y = horizonY + (height - horizonY) * t * t;
    const half = (centerX * (y - horizonY)) / (height - horizonY);
    ctx.moveTo(centerX - half, Math.round(y) + 0.5);
    ctx.lineTo(centerX + half, Math.round(y) + 0.5);
  }
  ctx.stroke();

  // Soft contact shadow under the feet; it brightens when a foot lands.
  ctx.fillStyle = green(flash ? 0.5 : 0.2);
  const sw = figureW * 0.42;
  ctx.beginPath();
  ctx.moveTo(centerX - sw, footY + 2);
  ctx.lineTo(centerX - sw * 0.6, footY - 2);
  ctx.lineTo(centerX + sw * 0.6, footY - 2);
  ctx.lineTo(centerX + sw, footY + 2);
  ctx.lineTo(centerX + sw * 0.6, footY + 6);
  ctx.lineTo(centerX - sw * 0.6, footY + 6);
  ctx.closePath();
  ctx.fill();

  drawCoachFigure(ctx, options.frame, figureX, figureY, scale);
  flush(ctx);
}

export function describeGap(gapSteps, running) {
  if (!running) return 'coach ready';
  const rounded = Math.round(gapSteps);
  if (Math.abs(rounded) < 2) return 'level with coach';
  return rounded < 0 ? 'behind ' + Math.abs(rounded) + ' steps' : 'ahead ' + rounded + ' steps';
}
