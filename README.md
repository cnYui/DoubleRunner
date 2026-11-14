# DoubleRunner

**Coach version (0.2.0):** a 3D pace coach now runs in front of you. The coach is the side-on mannequin of the CC0 Quaternius Universal Animation Library (`Jog_Fwd_Loop`), rendered once in Blender and baked into 24 phases of three-level green polygons (`agent/lib/coach-frames.js`, 70 KB, no video or bitmap shipped). Its run cycle is played at the target cadence (a cycle is two steps, so playback speed = cadence / 160.7), a foot lands exactly on every metronome beat, the ground streams past at the coach's pace, and a `YOU` marker sits behind or ahead of the coach by the difference between your detected steps and the coach's steps. Swipe to change the target and the coach changes tempo at once. The glasses show your cadence (gyroscope), the coach cadence, and the coach animation. Rebuild the frames with `blender -b -P tools/render_coach.py -- <UAL1_Standard.glb> <frames_dir>` then `python tools/build_coach.py <frames_dir> agent/lib/coach-frames.js`.

A running-cadence companion for Rokid Glasses (AIUI 0.17.0, single-green display). While you run in the glasses, the page charts the last 6 seconds of head-mounted gyroscope motion, detects every step and your current cadence from that curve, and plays a metronome at the target cadence (default 180). Every run is saved as a record; when you finish, the page draws the cadence chart for the whole run plus the share of time spent on target.

## Canvas and proportions

| Layer | Size | Source |
| --- | --- | --- |
| Optical canvas (the whole display area) | 480 x 640 px, 3:4 portrait | The `.device-screen` of AIUI Studio 1.1.0's device simulation, matching the official optical design guide |
| AIUI page viewport (where the Page actually renders) | 480 x 352 px, 15:11 landscape | The Studio effect-preview canvas (it reports `480 x 352 px` after you tap "enter"), matching the reference canvas in the single-green design spec shipped with 0.17 |
| Safe area | 16 px left/right, 12 px top/bottom, 448 px of content width | Design spec |
| Inline card in the conversation flow | 448 x 150 px | Studio's `/debug` card (`wx.getWindowInfo()` returns 448 x 150 in `onLoad`) |

The page is laid out for 480 x 352: a status row (20 px), a 448 x 152 curve frame, four metrics (cadence in 44 px figures, target cadence, achieved beat rate, step count), and one hint line at the bottom. Below 240 px of height (the inline card) only the state, cadence, target, and hint survive. Every colour is `#40ff5e` at 100 / 72 / 48 / 24 / 12 % luminance; structural lines are 1 px, controls have 4 px corners, panels 6 px, and no fill covers more than 12 %.

## The page

```text
DOUBLERUNNER · CADENCE                [RUNNING]  12:34
┌──────────────────────────────────────────────┐
│ GYRO 60Hz · rad/s                       6s  ◉ │  ← last 6 s of gyroscope angular velocity; detected steps
│        ╭╮    ╭╮    ╭╮    ╭╮    ╭╮    ╭╮        │     are marked with a dot and a tick along the top edge.
│  ─────╯╰───╯╰────╯╰───╯╰───╯╰───╯╰───────  │     The dashed line is the adaptive threshold; ◉ is the
└──────────────────────────────────────────────┘     beat dot (lit for 110 ms per beat).
176           180             3.0          2180
spm · cadence  target · -4 slow  beats / sec  steps
Click: pause  ·  Swipe: target cadence +/-5
```

| State | Click | Swipe forward | Swipe back |
| --- | --- | --- | --- |
| READY | start the run | target +5 | target -5 |
| RUNNING | pause | target +5 (the metronome changes tempo live) | target -5 |
| PAUSED | resume | target +5 | **finish and save** |
| DONE (cadence chart for the run, average cadence, share on target, elapsed, steps) | get ready for the next run | — | — |

The Back key is left to the host. Leaving the page while running pauses automatically; an unfinished run with steps is saved silently on unload.

## Cadence detection

`lib/cadence.js` and `lib/spectrum.js`, pure functions, replayable in Node. A runner's head moves at two rhythms: it nods or bounces on **every step** (step rate), and it swings **left and right once per two steps** (stride rate, half the step rate). Which one is stronger depends on the runner and on how the glasses sit, and deliberate head turns add large irregular motion. A single-axis peak counter (the first version) reports half the cadence whenever the left-right swing is the strongest signal, so the detector works in two stages:

1. **Comb spectrum on all three axes.** Every axis is band-passed (about 1 to 4 Hz) and resampled to 30 Hz. For each candidate cadence (100 to 230 spm) the estimator measures how much of the motion energy sits at its step tone and at its stride tone, **the stride tone (left-right swing) weighted double**. The sensor axes are never named, so any mounting works. The target cadence only picks between octaves until the detector has locked on; it never pulls the measurement.
2. **Step counting in the time domain** on the axis and tone the spectrum says carry the gait: positive peaks of a step tone, or the lobes of **both polarities** of a stride tone (one lobe per step). Step intervals (trimmed mean, robust to uneven left / right steps) refine the spectral cadence while they agree within 10 %.

A change of more than 12 % (walking into a run) re-locks within a few seconds; stopping clears the cadence after 2.5 s. Details, the before / after error table, the dataset search, and the limits are in [docs/cadence-detection.md](docs/cadence-detection.md). When the gyroscope is unavailable the same detector runs on the accelerometer. `tests/cadence.test.js` and `tests/head-cadence.test.js` verify it against the synthetic signals from `lib/demo.js`; `node tools/cadence_bench.mjs` prints the error table.

## Metronome and haptics

**AIUI 0.17 / 0.18 has no vibration API**: the `yodaos-project/AIUI` repository has no vibrate or haptic entry in its documentation, samples, or `wx.*` compatibility list, and `navigator.vibrate` does not exist in the Studio 1.1.0 runtime either (the page logs `vibrate=no` at startup). "Buzz at 180 spm" is therefore not buildable, so the beat is:

- Audible: `Sound` (the local short sound effect documented in 0.17) plays `assets/tick.wav` (1200 Hz, 35 ms), with `tick-accent.wav` (1800 Hz, 45 ms) on every fourth beat; if `Sound` is missing it falls back to a synthesised `AudioContext` tone, and if neither exists only the visuals remain.
- Visual: the dot in the top-right corner of the curve frame lights for 110 ms per beat, and "beats / sec" shows the achieved rate over the last 12 beats.

Scheduling lives in `lib/metronome.js`: each beat's due time is computed from the anchor plus the beat index rather than accumulated from the previous callback, so a late callback cannot drift. 180 spm = one beat per 333 ms = 3 beats per second, and `tests/metronome.test.js` verifies 10 beats in 3 seconds on an ideal clock plus no drift under late delivery. Because the Studio host does not deliver `setTimeout` reliably, the page also polls the metronome from its frame loop and UI refresh, so the beat keeps up as long as the page renders.

## Importing into AIUI Studio

The AIUI project root is the `agent/` subdirectory (it is what contains `app.json`), not the repository root:

```text
Repository: https://github.com/cnYui/DoubleRunner
Ref: main
AIUI project directory: agent
```

In Studio use "New agent" > "GitHub import" with `https://github.com/cnYui/DoubleRunner/tree/main/agent`, then "Upload to cloud" from the project's "..." menu, then send `/debug simulate the glasses device running the current page pages/run/index` in the chat box and tap "enter" on the card. Re-importing the same URL updates the project in place.

## Measured in Studio 1.1.0 (2026-09-11)

- Lifecycle: `onTargetChanged(undefined -> _current)` then `onLoad` (`wx.getWindowInfo()` = 448 x 150) then `onShow`; after "enter" the canvas moves into the 480 x 352 effect preview.
- Temple input: click = `GlobalHook` + `Enter` (the page acts exactly once); swipe forward / back = `GlobalHook` + `ArrowUp` / `ArrowDown`.
- **The web host has no IMU**: `Gyroscope` and `Accelerometer` both construct, but `start()` immediately reports `error: Host capability gyroscope.start is not configured on Web host` (the accelerometer likewise). The page falls back to the demo signal by design: the state chip reads `· DEMO`, the curve frame is labelled `DEMO signal`, and the notice line says "No sensor · showing demo signal". Real gyroscope readings can only be verified on the glasses.
- `Sound` works (system log `Web audio playback started`), `AudioContext` does not exist, `navigator.vibrate` does not exist, `localStorage` works, and the canvas context comes from `wx.createCanvasContext`.
- Timer behaviour for the beat and the demo signal: see `CLAUDE.md` (the `diag` log line, once every 5 seconds).

## Not verified

- On real glasses: gyroscope readings, cadence accuracy, beat audio and the stability of 3 beats per second, optics, key order, performance. A simulator result is not a device result.
- Voice routing ("start a run", "cadence 175" to `targetCadence`): a draft agent does not register its schema, so this needs Studio or a device to verify.

## Layout

```text
agent/                     AIUI Studio import root (AIUI 0.17.0)
  AGENTS.md                agent identity, voice routing rules, capability boundaries
  app.json                 pages: run
  pages/run/index.ink      the run page (curve, cadence, metronome, records)
  lib/cadence.js           cadence detection (band-pass, spectral lock, step / stride lobe counting)
  lib/spectrum.js          comb-spectrum cadence estimator over three axes (stride tone weighted double)
  lib/metronome.js         drift-free beat scheduler
  lib/curve.js             canvas drawing for the live curve and the post-run chart
  lib/records.js           per-second aggregation, record summaries, localStorage (newest 20)
  lib/demo.js              synthetic running signal (tests and demo mode)
  lib/temple.js            temple input de-duplication
  assets/tick*.wav         beat sounds (generated by tools/make_ticks.py)
  aiui-audit-claims.json   audit claims
tests/                     Node tests (never shipped to Studio or into the package)
tools/                     build_audit.py (audit matrix), make_ticks.py (sounds)
docs/aiui-audit.md         UX / capability audit matrix (no signing authority here, so every layer is BLOCKED)
docs/presentation.html     product presentation deck (open in a browser)
```

## Development

```bash
npm test
npm run validate
npm run audit
```

Node 20+ and Python 3 are required. `tests/page.test.js` loads the `<script setup>` block of the `.ink` file as a real module and drives the whole state machine with fake Gyroscope, Sound, localStorage, and wx objects; those fakes live only in `tests/` and never reach Studio or the package.
