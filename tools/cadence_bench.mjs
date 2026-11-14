// Replays simulated head-gait scenarios through a cadence detector and prints
// the error table used in docs/cadence-detection.md.
//
// Usage: node tools/cadence_bench.mjs [path to a cadence module]
//   (default agent/lib/cadence.js; to compare with an older detector, save it
//   from git history, e.g. git show <commit>:agent/lib/cadence.js > /tmp/old.js)
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const modPath = path.resolve(process.argv[2] || path.join(here, '../agent/lib/cadence.js'));
const { createCadenceDetector } = await import(pathToFileURL(modPath).href);
const { createHeadSignal, createRandom } = await import(
  pathToFileURL(path.join(here, '../agent/lib/demo.js')).href
);

const SAMPLE_MS = 1000 / 60;

function runScenario(spec) {
  const detector = createCadenceDetector({ source: 'gyroscope' });
  if (detector.setExpected) detector.setExpected(spec.expected || 180);
  const signal = createHeadSignal(spec.signal);
  const rnd = createRandom(99);
  const seconds = spec.seconds || 60;
  const schedule = spec.schedule || [];
  let t = 0;
  let steps = 0;
  let trueSteps = 0;
  let trueClock = 0;
  const errors = [];
  let within3 = 0;
  let counted = 0;
  const end = seconds * 1000;
  while (t <= end) {
    for (const [at, cadence] of schedule) {
      if (t >= at && signal.cadence !== cadence && !schedule.done?.[at]) {
        signal.setCadence(cadence);
        (schedule.done ||= {})[at] = true;
      }
    }
    const s = signal.sample(t);
    const r = detector.push(t, s.x, s.y, s.z);
    if (r.step && t >= 10000) steps += 1;
    if (t >= 10000) {
      const truth = signal.cadence;
      const err = r.cadence - truth;
      errors.push(Math.abs(err));
      counted += 1;
      if (Math.abs(err) <= 3) within3 += 1;
    }
    let dt = SAMPLE_MS;
    if (spec.jitter) dt += (rnd() - 0.5) * 2 * spec.jitter;
    t += dt;
    if (spec.drop && rnd() < spec.drop) t += SAMPLE_MS;
  }
  const truthCadence = signal.cadence;
  const expectedSteps = ((truthCadence / 60) * (seconds - 10));
  errors.sort((a, b) => a - b);
  return {
    medianErr: errors[errors.length >> 1],
    p90Err: errors[Math.floor(errors.length * 0.9)],
    within3: within3 / counted,
    stepsRatio: steps / expectedSteps,
    last: detector.cadence
  };
}

const scenarios = [
  [
    'precision: clean 180, no timing wobble',
    { signal: { cadence: 180, pitch: 0.5, lateral: 0.3, seed: 31, wobble: 0 } }
  ],
  [
    'precision: lateral-only 168, no wobble',
    { signal: { cadence: 168, pitch: 0.02, lateral: 0.4, seed: 32, wobble: 0 }, expected: 175 }
  ],
  [
    'walk 110 (nod + weak sway), target 170',
    { signal: { cadence: 110, pitch: 0.4, lateral: 0.08, seed: 33 }, expected: 170 }
  ],
  [
    'walk 110 then run 180 at 20 s',
    {
      signal: { cadence: 110, pitch: 0.4, lateral: 0.3, seed: 34 },
      schedule: [[20000, 180]],
      seconds: 60
    }
  ],
  [
    'run 180 then stop at 30 s',
    {
      signal: { cadence: 180, pitch: 0.4, lateral: 0.3, seed: 35 },
      schedule: [[30000, 0]],
      seconds: 60
    }
  ],
  [
    'heavy head turns (every 3 s, 1.6 rad/s) 180',
    { signal: { cadence: 180, pitch: 0.25, lateral: 0.35, seed: 36, turnEveryMs: 3000, turnRate: 1.6 } }
  ],
  ['balanced clean 180', { signal: { cadence: 180, pitch: 0.5, lateral: 0.3, seed: 1 } }],
  [
    'lateral dominant 180 + head turns',
    { signal: { cadence: 180, pitch: 0.12, lateral: 0.5, seed: 2, turnEveryMs: 6000, turnRate: 1 } }
  ],
  [
    'vertical dominant 180 + head turns',
    { signal: { cadence: 180, pitch: 0.6, lateral: 0.1, seed: 3, turnEveryMs: 6000, turnRate: 1 } }
  ],
  [
    'lateral only 172 (almost no nod)',
    { signal: { cadence: 172, pitch: 0.03, lateral: 0.45, seed: 4, noise: 0.06 } }
  ],
  [
    'asymmetric lobes 176',
    { signal: { cadence: 176, pitch: 0.2, lateral: 0.45, asymmetry: 0.12, seed: 5, turnEveryMs: 7000 } }
  ],
  [
    'weak signal 165, noise 0.06',
    { signal: { cadence: 165, pitch: 0.15, lateral: 0.12, noise: 0.06, seed: 6 } }
  ],
  [
    'jittery timestamps + drops 180',
    {
      signal: { cadence: 180, pitch: 0.3, lateral: 0.35, seed: 7, turnEveryMs: 8000 },
      jitter: 5,
      drop: 0.05
    }
  ],
  [
    'swipe 180 -> 175 -> 170',
    {
      signal: { cadence: 180, pitch: 0.3, lateral: 0.4, seed: 8 },
      schedule: [
        [25000, 175],
        [40000, 170]
      ],
      seconds: 60
    }
  ]
];

// Random sensor mounting on top of the lateral-dominant scenario.
for (let seed = 1; seed <= 6; seed += 1) {
  const r = createRandom(seed * 17);
  const mount = [r() * 6.28, (r() - 0.5) * 3.1, r() * 6.28];
  scenarios.push([
    'random mount #' + seed + ' (lateral-dominant)',
    {
      signal: {
        cadence: 170 + seed,
        pitch: 0.15,
        lateral: 0.45,
        seed: 20 + seed,
        mount,
        turnEveryMs: 7000
      }
    }
  ]);
}

const rows = [];
for (const [name, spec] of scenarios) {
  spec.schedule && (spec.schedule.done = {});
  const r = runScenario(spec);
  rows.push({ name, ...r });
}
const pad = (s, n) => String(s).padEnd(n);
console.log(
  pad('scenario', 42) + pad('medErr', 8) + pad('p90Err', 8) + pad('in±3', 8) + pad('steps/true', 11)
);
for (const r of rows) {
  console.log(
    pad(r.name, 42) +
      pad(r.medianErr.toFixed(1), 8) +
      pad(r.p90Err.toFixed(1), 8) +
      pad((r.within3 * 100).toFixed(0) + '%', 8) +
      pad(r.stepsRatio.toFixed(2), 11)
  );
}
