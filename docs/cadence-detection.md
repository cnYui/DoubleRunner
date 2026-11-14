# Cadence detection from the glasses IMU

Why the first version was inaccurate, how the new one works, how it was tested, and what is still not proven.

## The problem

A runner's head moves at two rhythms:

- **Step rate** (cadence / 60 Hz): a nod or bounce on every footfall.
- **Stride rate** (cadence / 120 Hz): the head swings left and right once per two steps (roll and yaw sway). It alternates sides, which a random bump or a deliberate head turn does not.

The first detector took the single axis with the most variance and counted positive peaks. When the left-right swing was the strongest signal it counted one peak per stride, i.e. **half the cadence** (about 90 for a 180 spm runner), and its fixed 0.35 rad/s floor ignored weak signals completely.

## The new detector

1. **Comb spectrum on all three axes** (`agent/lib/spectrum.js`). Each axis is band-passed (about 1 to 4 Hz), resampled to 30 Hz, and a Hann-windowed DFT over the last 6.4 s scores every candidate cadence (100 to 230 spm, 2 spm grid, parabolic refinement) by the energy at its step tone and at its stride tone. **The stride tone, the left-right swing, counts double.** Axes are never named, so any sensor mounting works.
2. **Octave choice.** A tone at 1.8 Hz is either a 220 spm stride tone or a 110 spm walking step tone. The stride weight therefore fades to 1 above 190 spm, and the prior (the target cadence, then the current lock) discounts candidates above 200 spm unless the target is that high. The target only chooses between octaves; the final cadence is refined on the raw score and is never pulled towards it.
3. **Step counting** (`agent/lib/cadence.js`) on the axis and tone the spectrum selects (30 % hysteresis): positive peaks of a step tone, or lobes of both polarities of a stride tone. A step closer than 0.6 x the expected interval is ignored; a missed step is counted but its double interval stays out of the average.
4. **Cadence shown** = the spectral cadence, refined by the trimmed mean of the last 8 step intervals while the two agree within 10 %. The mean (not the median) keeps uneven left / right steps from biasing the result.
5. **Lock and re-lock.** The detector locks when 20 % of the motion energy is on the gait tones (or 10 % with a clear peak), unlocks after 3 s below 8 %, re-locks when a wide-prior peak is 1.4x stronger for three updates (walking into a run), and forgets the spectrum when the runner stops.

The page passes the target cadence to the detector on start and on every swipe (`setExpected`).

## Before / after on simulated head gait

`node tools/cadence_bench.mjs [cadence module]` replays 60 s scenarios from `createHeadSignal` (`agent/lib/demo.js`): pitch nod at the step rate, roll / yaw sway at the stride rate, head turns, timing variation, uneven lobes, noise, an arbitrary sensor mounting. Error is the reported cadence minus the true one after the first 10 s; steps/true is the detected step count over the true count.

| scenario | old: median error | new: median error | new: within 3 spm | steps/true old → new |
|---|---|---|---|---|
| clean 180, no timing wobble | 1 | 0 | 100 % | 0.82 → 1.00 |
| left-right swing only, 168 | **84** | 1 | 97 % | 0.47 → 1.00 |
| left-right swing dominant 180 + head turns | **90** | 2 | 79 % | 0.45 → 0.99 |
| nod dominant 180 + head turns | 0 | 2 | 86 % | 1.00 → 1.00 |
| uneven left / right lobes 176 | **87** | 2 | 79 % | 0.41 → 1.00 |
| weak signal 165 | **165 (no reading)** | 2 | 88 % | 0.00 → 1.00 |
| jittery timestamps + 5 % dropped samples | **180 (no reading)** | 3 | 73 % | 0.13 → 1.00 |
| heavy head turns every 3 s | **180 (no reading)** | 2 | 70 % | 0.10 → 0.93 |
| swipe 180 → 175 → 170 | **87** | 2 | 70 % | 0.49 → 1.02 |
| walking 110 | 3 | 1 | 100 % | 0.82 → 0.99 |
| walking 110, then running 180 | **180** | 2 | 84 % | 0.10 → 0.89 |
| six random sensor mountings, left-right dominant | 86 to 171 | 2 to 3 | 59 to 85 % | 0.20 to 0.47 → 0.97 to 1.00 |

The "within 3 spm" figure is limited by the simulated stride-to-stride variation (the model wobbles +-1.5 % on purpose); with the wobble off it is 97 to 100 %.

## Open datasets

No public dataset of **head-mounted IMU running with step labels** turned up in a search (2026-11-14). Closest leads, none downloaded or used:

- [HelmetPoser](https://arxiv.org/abs/2409.05006): helmet-mounted IMU, ten participants, ground-truth head pose; data at lqiutong.github.io/HelmetPoser.github.io. Built for head-pose estimation; whether running is included and whether steps are labelled is not stated.
- [Open-Set Recognition of Human Activities from Head-Mounted Inertial Sensor](https://doi.org/10.3390/s26031079): head-mounted activity recognition, dataset availability not checked.
- [Earable IMU-Based Indoor Positioning](https://zenodo.org/records/20594004): four earable IMUs at 60 Hz, walking only.
- [Nymeria](https://www.projectaria.com/datasets/nymeria/): Project Aria glasses IMU with full-body motion capture; gated, CC BY-NC 4.0, activity mix unchecked.
- Method reference: [real-time gait event detection from a single head-mounted IMU with adaptive frequency oscillators](https://www.researchgate.net/publication/371515946_Real-Time_Gait_Event_Detection_with_Adaptive_Frequency_Oscillators_from_a_Single_Head-Mounted_IMU) (F1 above 92 %, data availability unchecked).

## What is not proven

- Every number above comes from **simulated** head motion built from gait biomechanics, not from recorded runs. The model's amplitudes, phase relationships, and the ratio of nod to sway are assumptions; the detector does not depend on which axis carries what, but it does depend on the gait showing up as step-rate or stride-rate tones inside the 1 to 4 Hz band.
- The Rokid Glasses gyroscope axis orientation, real noise floor, and real sample timing have not been measured on a run. The detector floors (0.12 rad/s, 0.4x when locked) are conservative guesses.
- Next step to close this: record 60 s of raw gyroscope while running at a known cadence (treadmill or a metronome app in the ear), replay it through `createCadenceDetector` in Node, and tune the thresholds on it.
