// Drift-corrected beat scheduler. Every beat is scheduled from the anchor
// time plus index * interval, never from the previous timer callback, so a
// late callback does not shift the following beats. All clock and timer
// access is injected so tests can run it on a fake clock.

export const STATS_WINDOW = 12;
export const RESYNC_BEATS = 4;

export function createMetronome(deps) {
  const now = deps.now;
  const schedule = deps.schedule;
  const cancel = deps.cancel;
  const onBeat = deps.onBeat;
  let running = false;
  let bpm = 0;
  let intervalMs = 0;
  let anchorAt = 0;
  let index = 0;
  let timer = null;
  let beats = 0;
  let maxLateMs = 0;
  let lateSumMs = 0;
  const firedAt = [];

  function clearTimer() {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  }

  function scheduleNext() {
    const dueAt = anchorAt + index * intervalMs;
    // Integer delays only: the Ink runtime's timers are not guaranteed to
    // accept fractional milliseconds.
    timer = schedule(fire, Math.max(0, Math.round(dueAt - now())));
  }

  function fire() {
    timer = null;
    if (!running) return;
    const at = now();
    const dueAt = anchorAt + index * intervalMs;
    const lateMs = Math.max(0, at - dueAt);
    beats += 1;
    lateSumMs += lateMs;
    if (lateMs > maxLateMs) maxLateMs = lateMs;
    firedAt.push(at);
    if (firedAt.length > STATS_WINDOW) firedAt.shift();
    const beatIndex = index;
    if (lateMs > intervalMs * RESYNC_BEATS) {
      // The runtime stalled (hidden page, heavy work): re-anchor instead of
      // firing a burst of catch-up beats.
      anchorAt = at;
      index = 0;
    }
    index += 1;
    onBeat({ index: beatIndex, dueAt, at, lateMs, accent: beatIndex % 4 === 0 });
    if (running) scheduleNext();
  }

  return {
    start(bpmValue, startAt) {
      clearTimer();
      bpm = bpmValue;
      intervalMs = 60000 / bpmValue;
      anchorAt = startAt === undefined ? now() : startAt;
      index = 0;
      running = true;
      scheduleNext();
    },
    setBpm(bpmValue) {
      if (bpmValue === bpm) return;
      bpm = bpmValue;
      const nextInterval = 60000 / bpmValue;
      if (running) {
        // Keep the phase: the next beat lands one new interval after the last
        // scheduled one.
        const lastDueAt = anchorAt + (index - 1) * intervalMs;
        anchorAt = lastDueAt + nextInterval;
        index = 0;
        intervalMs = nextInterval;
        clearTimer();
        scheduleNext();
      } else {
        intervalMs = nextInterval;
      }
    },
    stop() {
      running = false;
      clearTimer();
    },
    get running() {
      return running;
    },
    get bpm() {
      return bpm;
    },
    get intervalMs() {
      return intervalMs;
    },
    stats() {
      let achievedRate = 0;
      let meanIntervalMs = 0;
      if (firedAt.length >= 2) {
        const span = firedAt[firedAt.length - 1] - firedAt[0];
        if (span > 0) {
          achievedRate = ((firedAt.length - 1) * 1000) / span;
          meanIntervalMs = span / (firedAt.length - 1);
        }
      }
      return {
        bpm,
        beats,
        achievedRate,
        meanIntervalMs,
        maxLateMs,
        meanLateMs: beats ? lateSumMs / beats : 0
      };
    }
  };
}
