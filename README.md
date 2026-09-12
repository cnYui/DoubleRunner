# DoubleRunner

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

`lib/cadence.js`, pure functions, replayable in Node:

1. Remove the slow drift from each axis (first-order high-pass, tau = 0.8 s);
2. Take the axis with the largest recent variance (30 % hysteresis, so the head-pitch axis usually wins), signed;
3. Smooth with a first-order low-pass (tau = 40 ms);
4. A local maximum above the adaptive threshold (`max(0.35 rad/s, 0.9 x RMS)`) is a step, but only once the signal has returned below the baseline since the previous step ("armed"), so the two lobes of one nod are not counted twice; steps must be 250 to 1500 ms apart;
5. Cadence = 60000 / the median of the last 8 step intervals, then smoothed by 35 %; it returns to zero after 2.5 s without a step.

When the gyroscope is unavailable the same detector runs on the accelerometer (threshold 1.2 m/s², gravity removed by the high-pass). `tests/cadence.test.js` verifies it against the synthetic signal from `lib/demo.js`: 180 / 172 / 110 spm within 3 spm, noise produces no steps, a 160 to 184 change is tracked within seconds, and stopping returns the reading to zero.

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
  lib/cadence.js           cadence detection (high-pass, axis pick, low-pass, adaptive-threshold peaks)
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
