// Deterministic stride signal for tests and for the on-screen demo mode that
// replaces a missing or failing sensor. It imitates what a head-mounted
// gyroscope sees while running: a pitch nod on every step (the fundamental
// plus a softer second harmonic), a roll sway once per stride (half the step
// frequency), and a little sensor noise.

const TWO_PI = Math.PI * 2;

export function createRandom(seed = 1) {
  let state = seed >>> 0;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function rotationMatrix(angles) {
  const [a, b, c] = angles;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  const cc = Math.cos(c);
  const sc = Math.sin(c);
  // Z(a) * Y(b) * X(c): any fixed mounting of the sensor on the frame.
  return [
    [ca * cb, ca * sb * sc - sa * cc, ca * sb * cc + sa * sc],
    [sa * cb, sa * sb * sc + ca * cc, sa * sb * cc - ca * sc],
    [-sb, cb * sc, cb * cc]
  ];
}

// A more realistic head-mounted angular-velocity model, used by the tests to
// stress the cadence detector. Body frame: x = left-right axis (pitch rate),
// y = vertical axis (yaw rate), z = front-back axis (roll rate).
//   * every step: a pitch nod at the step rate (plus a second harmonic),
//   * every stride (two steps): a roll and yaw sway, i.e. the head swinging
//     left and right once per two steps,
//   * occasional deliberate head turns (large, slow yaw bursts),
//   * stride-to-stride timing variation and uneven left / right lobes,
//   * sensor noise, and an arbitrary mounting rotation of the sensor.
export function createHeadSignal(options = {}) {
  const random = createRandom(options.seed === undefined ? 1 : options.seed);
  const pitch = options.pitch === undefined ? 0.5 : options.pitch;
  const lateral = options.lateral === undefined ? 0.35 : options.lateral;
  const noise = options.noise === undefined ? 0.05 : options.noise;
  const asymmetry = options.asymmetry || 0;
  const wobble = options.wobble === undefined ? 0.015 : options.wobble;
  const turnEveryMs = options.turnEveryMs || 0;
  const turnRate = options.turnRate === undefined ? 1 : options.turnRate;
  const matrix = rotationMatrix(options.mount || [0, 0, 0]);
  const wobblePhases = [random() * TWO_PI, random() * TWO_PI];
  let cadence = options.cadence === undefined ? 180 : options.cadence;
  let phase = 0;
  let lastT = null;
  let turn = null;
  let nextTurnAt = turnEveryMs ? turnEveryMs * (0.5 + random()) : Infinity;

  function gaussianish() {
    return (random() + random() + random() - 1.5) * 2 * noise;
  }

  return {
    setCadence(value) {
      cadence = value;
    },
    get cadence() {
      return cadence;
    },
    sample(tMs) {
      if (lastT !== null && cadence > 0) {
        const slow =
          1 +
          wobble *
            (Math.sin(tMs / 4700 + wobblePhases[0]) + 0.6 * Math.sin(tMs / 1900 + wobblePhases[1]));
        // Stride rate in Hz is cadence / 120.
        phase += (TWO_PI * cadence * slow * (tMs - lastT)) / 120000;
      }
      lastT = tMs;
      if (tMs >= nextTurnAt) {
        turn = {
          start: tMs,
          duration: 500 + random() * 600,
          yaw: (random() < 0.5 ? -1 : 1) * turnRate * (0.6 + 0.8 * random()),
          pitch: (random() - 0.5) * turnRate * 0.5
        };
        nextTurnAt = tMs + turnEveryMs * (0.5 + random());
      }
      let turnYaw = 0;
      let turnPitch = 0;
      if (turn) {
        const progress = (tMs - turn.start) / turn.duration;
        if (progress >= 1) {
          turn = null;
        } else {
          const bump = 0.5 - 0.5 * Math.cos(TWO_PI * progress);
          turnYaw = turn.yaw * bump;
          turnPitch = turn.pitch * bump;
        }
      }
      const theta = phase + asymmetry * (1 - Math.cos(phase));
      const stepPhase = 2 * theta;
      const body = [0, 0, 0];
      if (cadence > 0) {
        body[0] = pitch * (Math.sin(stepPhase) + 0.35 * Math.sin(2 * stepPhase + 0.6));
        body[1] = 0.6 * lateral * Math.sin(theta + 1.2);
        body[2] = lateral * Math.sin(theta + 0.4);
      }
      body[0] += turnPitch + gaussianish();
      body[1] += turnYaw + gaussianish();
      body[2] += gaussianish();
      const out = [0, 0, 0];
      for (let row = 0; row < 3; row += 1) {
        out[row] =
          matrix[row][0] * body[0] + matrix[row][1] * body[1] + matrix[row][2] * body[2];
      }
      return { x: out[0], y: out[1], z: out[2] };
    }
  };
}

export function createStrideSignal(options = {}) {
  const random = createRandom(options.seed === undefined ? 1 : options.seed);
  const amplitude = options.amplitude === undefined ? 1.2 : options.amplitude;
  const noise = options.noise === undefined ? 0.08 : options.noise;
  const axis = options.axis === undefined ? 0 : options.axis;
  const offset = options.offset || [0, 0, 0];
  let cadence = options.cadence === undefined ? 180 : options.cadence;
  let phase = 0;
  let lastT = null;

  function gaussianish() {
    return (random() + random() + random() - 1.5) * 2 * noise;
  }

  return {
    setCadence(value) {
      cadence = value;
    },
    get cadence() {
      return cadence;
    },
    // Returns {x, y, z} for the sample at time tMs (milliseconds, increasing).
    sample(tMs) {
      if (lastT !== null && cadence > 0) {
        phase += (TWO_PI * cadence * (tMs - lastT)) / 60000;
        if (phase > 1e6) phase -= Math.floor(phase / TWO_PI) * TWO_PI;
      }
      lastT = tMs;
      const nod =
        cadence > 0
          ? amplitude * Math.sin(phase) + 0.35 * amplitude * Math.sin(2 * phase + 0.6)
          : 0;
      const sway = cadence > 0 ? 0.15 * amplitude * Math.sin(phase / 2) : 0;
      const values = [0, 0, 0];
      values[axis] = nod + gaussianish();
      values[(axis + 1) % 3] = sway + gaussianish();
      values[(axis + 2) % 3] = gaussianish();
      return {
        x: values[0] + offset[0],
        y: values[1] + offset[1],
        z: values[2] + offset[2]
      };
    }
  };
}
