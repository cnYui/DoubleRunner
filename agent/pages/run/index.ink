<script def>
{
  "navigationBarTitleText": "跑伴",
  "description": "跑步辅助：显示眼镜陀螺仪的步态曲线、检测当前步频，并按目标步频播放节拍提示。用户说“开始跑步”“陪我跑步”“步频 180”“把步频改成 170”等时调用；把目标步频换算成整数 targetCadence 传入。",
  "schema": {
    "data": {
      "type": "object",
      "properties": {
        "targetCadence": {
          "type": "integer",
          "minimum": 120,
          "maximum": 220,
          "default": 180,
          "description": "目标步频（每分钟步数）。用户没有指定时用 180。"
        },
        "demo": {
          "type": "boolean",
          "default": false,
          "description": "调试用：用合成的跑步信号代替传感器。只有用户明确要求演示或模拟信号时才为 true。"
        }
      }
    }
  }
}
</script>

<script setup>
import wx from 'wx';
import { createCadenceDetector } from '../../lib/cadence.js';
import { createStrideSignal } from '../../lib/demo.js';
import { createMetronome } from '../../lib/metronome.js';
import { createSampleBuffer, drawLiveCurve, drawRecordChart } from '../../lib/curve.js';
import {
  createSession,
  noteSecond,
  finishSession,
  loadRecords,
  saveRecord,
  formatDuration,
  formatRecordLine,
  normalizeOffsetMinutes
} from '../../lib/records.js';
import { createTempleInput } from '../../lib/temple.js';

const BUILD = '2026-09-11.1';
const DEFAULT_TARGET = 180;
const MIN_TARGET = 120;
const MAX_TARGET = 220;
const TARGET_STEP = 5;
const SENSOR_FREQUENCY = 60;
const WINDOW_MS = 6000;
const CANVAS_WIDTH = 446;
const CANVAS_HEIGHT = 150;
const FRAME_MS = 50;
const UI_MS = 200;
const DEMO_SAMPLE_MS = Math.round(1000 / SENSOR_FREQUENCY);
// When no sensor can be used, fall back to the clearly labelled demo signal so
// the curve and the detector can still be exercised (Studio has no IMU
// controls). Set to false for a release build that should stay metronome-only
// without a sensor.
const DEMO_WHEN_UNAVAILABLE = true;

const STATE_LABELS = {
  idle: '待命',
  running: '跑步中',
  paused: '已暂停',
  finished: '已结束'
};

const HINTS = {
  idle: '单击 开始跑步 · 前后滑动 调整目标步频',
  running: '单击 暂停 · 前后滑动 调整目标步频',
  paused: '单击 继续 · 向后滑动 结束并保存',
  finished: '单击 准备下一次跑步'
};

const SOURCE_LABELS = {
  gyroscope: 'GYRO',
  accelerometer: 'ACCEL',
  demo: 'DEMO 演示信号',
  none: '无传感器'
};

const SENSOR_NAMES = {
  gyroscope: '陀螺仪',
  accelerometer: '加速度计'
};

function log(message) {
  console.log('[doublerunner] ' + message);
}

function clampTarget(value) {
  return Math.max(MIN_TARGET, Math.min(MAX_TARGET, Math.round(value)));
}

function normalizeQuery(query) {
  const input = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
  let target = DEFAULT_TARGET;
  const raw = input.targetCadence;
  const numeric = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof numeric === 'number' && Number.isFinite(numeric)) target = numeric;
  return {
    targetCadence: clampTarget(target),
    demo: input.demo === true || input.demo === 'true'
  };
}

function describeDelta(cadence, target) {
  if (!cadence) return '等待步伐';
  const delta = cadence - target;
  if (Math.abs(delta) <= 3) return '与目标一致';
  return delta > 0 ? '+' + delta + ' 偏快' : delta + ' 偏慢';
}

export default {
  data: {
    state: 'idle',
    stateLabel: STATE_LABELS.idle,
    clock: '00:00',
    cadenceText: '--',
    mainLabel: 'spm 当前步频',
    targetCadence: DEFAULT_TARGET,
    targetText: String(DEFAULT_TARGET),
    targetLabel: '目标步频 · 等待步伐',
    beatRateText: '--',
    beatLabel: '节拍 次/秒',
    stepsText: '0',
    stepsLabel: '步数',
    hint: HINTS.idle,
    notice: '',
    lastRecordText: ''
  },

  onLoad(query) {
    const input = normalizeQuery(query);
    this._id = Math.random().toString(36).slice(2, 7);
    this._visible = false;
    this._phase = 'idle';
    this._target = input.targetCadence;
    this._demoRequested = input.demo;
    this._source = 'none';
    this._sourceActive = false;
    this._sensor = null;
    this._sensorKind = '';
    this._sensorRunning = false;
    this._failedKinds = {};
    this._readings = 0;
    this._detector = createCadenceDetector({ source: 'gyroscope' });
    this._buffer = createSampleBuffer(WINDOW_MS);
    this._scale = 0.6;
    this._latest = null;
    this._runSteps = 0;
    this._activeMs = 0;
    this._runStartedAt = 0;
    this._session = null;
    this._secondIndex = -1;
    this._secondSteps = 0;
    this._lastBeatAt = 0;
    this._record = null;
    this._recordDrawn = false;
    this._frameTimer = null;
    this._uiTimer = null;
    this._demoTimer = null;
    this._demoSignal = null;
    this._ctxCache = null;
    this._ctxVia = '';
    this._uiSnapshot = '';
    this._notice = '';
    this._demoTicks = 0;
    this._frames = 0;
    this._uiTicks = 0;
    this._input = createTempleInput({
      now: () => this._now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (id) => clearTimeout(id),
      onLoneGlobalHook: () => this._primary()
    });
    this._metronome = createMetronome({
      now: () => this._now(),
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (id) => clearTimeout(id),
      onBeat: (beat) => this._onBeat(beat)
    });
    this._audio = this._createAudio();
    this._vibrate = this._detectVibrate();
    this._storage = typeof localStorage !== 'undefined' ? localStorage : null;
    const records = loadRecords(this._storage);
    this.setData({
      targetCadence: this._target,
      targetText: String(this._target),
      lastRecordText: records.length ? '上次 ' + formatRecordLine(records[0], this._offsetMinutes()) : ''
    });
    this._createSensor();
    log(
      'run onLoad ' + this._id + ' build=' + BUILD + ' query=' + JSON.stringify(query) +
      ' target=' + this._target + ' demo=' + this._demoRequested + ' win=' + this._viewportInfo() +
      ' gyro=' + typeof Gyroscope + ' accel=' + typeof Accelerometer + ' sound=' + typeof Sound +
      ' audioctx=' + typeof AudioContext + ' vibrate=' + this._vibrate + ' audio=' + this._audio +
      ' storage=' + (this._storage ? 'yes' : 'no') + ' records=' + records.length +
      ' raf=' + typeof requestAnimationFrame + ' sensor=' + (this._sensorKind || 'none')
    );
  },

  onShow() {
    this._visible = true;
    log('run onShow ' + this._id + ' phase=' + this._phase);
    this._recordDrawn = false;
    this._startFrames();
    this._startUi();
    if (this._phase !== 'finished') this._startSource();
  },

  onHide() {
    log('run onHide ' + this._id + ' phase=' + this._phase);
    if (this._phase === 'running') this._pauseRun('hide');
    this._visible = false;
    this._stopSource();
    this._stopFrames();
    this._stopUi();
    this._input.dispose();
  },

  onUnload() {
    log('run onUnload ' + this._id + ' phase=' + this._phase + ' steps=' + this._runSteps);
    if (this._phase === 'running' || this._phase === 'paused') {
      if (this._runSteps > 0) this._finishRun(true);
      else this._metronome.stop();
    }
    this._visible = false;
    this._stopSource();
    this._stopFrames();
    this._stopUi();
    this._input.dispose();
    this._disposeAudio();
    this._disposeSensor();
  },

  onTargetChanged(target, previousTarget) {
    log('run onTargetChanged ' + previousTarget + ' -> ' + target);
  },

  onKeyDown(event) {
    if (!event || !this._visible) return;
    if (
      event.code === 'Enter' || event.code === 'Backspace' ||
      event.code === 'ArrowUp' || event.code === 'ArrowDown'
    ) {
      this._input.gestureKeyDown();
    }
  },

  onKeyUp(event) {
    if (!event) return;
    log('keyup ' + event.code + ' phase=' + this._phase + ' visible=' + this._visible);
    if (!this._visible) return;
    if (event.code === 'GlobalHook') {
      this._input.globalHookUp();
      return;
    }
    let owned = false;
    if (event.code === 'Enter') {
      this._input.gestureKeyUp();
      owned = this._primary();
    } else if (event.code === 'ArrowUp') {
      this._input.gestureKeyUp();
      owned = this._swipe(1);
    } else if (event.code === 'ArrowDown') {
      this._input.gestureKeyUp();
      owned = this._swipe(-1);
    } else if (event.code === 'Backspace') {
      // Back stays with the host (close / return); onHide and onUnload save
      // the run and release the sensor, timers, and audio.
      this._input.gestureKeyUp();
    }
    if (owned && typeof event.preventDefault === 'function') event.preventDefault();
  },

  // Single tap: start / pause / resume / back to idle. Returns true when owned.
  _primary() {
    if (this._phase === 'idle') this._startRun();
    else if (this._phase === 'running') this._pauseRun('tap');
    else if (this._phase === 'paused') this._resumeRun();
    else if (this._phase === 'finished') this._resetToIdle();
    return true;
  },

  // Swipe forward is +1 (ArrowUp), swipe back is -1 (ArrowDown).
  _swipe(direction) {
    if (this._phase === 'finished') return false;
    if (this._phase === 'paused' && direction < 0) {
      this._finishRun(false);
      return true;
    }
    const next = clampTarget(this._target + direction * TARGET_STEP);
    if (next === this._target) return true;
    this._target = next;
    if (this._session) this._session.targetCadence = next;
    if (this._metronome.running) this._metronome.setBpm(next);
    log('target -> ' + next);
    this.setData({ targetCadence: next, targetText: String(next) });
    this._refreshUi(true);
    return true;
  },

  _startRun() {
    const now = this._now();
    this._phase = 'running';
    this._runStartedAt = now;
    this._runSteps = 0;
    this._activeMs = 0;
    this._secondIndex = -1;
    this._secondSteps = 0;
    this._record = null;
    this._session = createSession({
      startedAt: now,
      targetCadence: this._target,
      source: this._source === 'none' ? 'none' : this._source
    });
    this._startSource();
    this._metronome.start(this._target, now);
    this._resumeAudio();
    log('run start target=' + this._target + ' source=' + this._source);
    this._applyPhase();
  },

  _pauseRun(reason) {
    if (this._phase !== 'running') return;
    const now = this._now();
    this._activeMs += Math.max(0, now - this._runStartedAt);
    this._flushSecond();
    this._metronome.stop();
    this._phase = 'paused';
    log('run pause reason=' + reason + ' activeMs=' + Math.round(this._activeMs) + ' steps=' + this._runSteps);
    this._applyPhase();
  },

  _resumeRun() {
    if (this._phase !== 'paused') return;
    const now = this._now();
    this._runStartedAt = now;
    this._phase = 'running';
    this._startSource();
    this._metronome.start(this._target, now);
    this._resumeAudio();
    log('run resume');
    this._applyPhase();
  },

  _finishRun(silent) {
    if (this._phase !== 'running' && this._phase !== 'paused') return;
    const now = this._now();
    if (this._phase === 'running') this._activeMs += Math.max(0, now - this._runStartedAt);
    this._flushSecond();
    this._metronome.stop();
    const session = this._session || createSession({
      startedAt: now,
      targetCadence: this._target,
      source: this._source
    });
    this._record = finishSession(session, {
      endedAt: now,
      activeMs: this._activeMs,
      steps: this._runSteps
    });
    this._session = null;
    saveRecord(this._storage, this._record);
    const stats = this._metronome.stats();
    log(
      'run finish silent=' + silent + ' activeMs=' + this._record.activeMs + ' steps=' +
      this._record.steps + ' avg=' + this._record.avgCadence + ' inTarget=' +
      Math.round(this._record.inTargetRatio * 100) + '% beats=' + stats.beats + ' rate=' +
      stats.achievedRate.toFixed(2) + '/s maxLate=' + Math.round(stats.maxLateMs) + 'ms'
    );
    this._phase = 'finished';
    this._recordDrawn = false;
    if (!silent) this._applyPhase();
  },

  _resetToIdle() {
    this._phase = 'idle';
    this._runSteps = 0;
    this._activeMs = 0;
    this._secondIndex = -1;
    this._secondSteps = 0;
    this._session = null;
    const records = loadRecords(this._storage);
    this.setData({
      lastRecordText: records.length ? '上次 ' + formatRecordLine(records[0], this._offsetMinutes()) : ''
    });
    this._startSource();
    this._applyPhase();
  },

  _applyPhase() {
    const phase = this._phase;
    const patch = {
      state: phase,
      stateLabel: STATE_LABELS[phase] + (this._source === 'demo' ? ' · 演示' : ''),
      hint: HINTS[phase]
    };
    if (phase === 'finished' && this._record) {
      const record = this._record;
      patch.cadenceText = record.avgCadence ? String(record.avgCadence) : '--';
      patch.mainLabel = 'spm 平均步频';
      patch.targetText = String(record.targetCadence);
      patch.targetLabel = '目标 · 达标 ' + Math.round(record.inTargetRatio * 100) + '%';
      patch.beatRateText = formatDuration(record.activeMs);
      patch.beatLabel = '用时';
      patch.stepsText = String(record.steps);
      patch.stepsLabel = '步数 · 已保存';
      patch.clock = formatDuration(record.activeMs);
    } else {
      patch.mainLabel = 'spm 当前步频';
      patch.beatLabel = '节拍 次/秒';
      patch.stepsLabel = '步数';
      patch.targetText = String(this._target);
    }
    this.setData(patch);
    this._uiSnapshot = '';
    this._refreshUi(true);
  },

  // ---- sensor source -----------------------------------------------------

  _createSensor() {
    const candidates = [
      ['gyroscope', typeof Gyroscope === 'function' ? Gyroscope : null],
      ['accelerometer', typeof Accelerometer === 'function' ? Accelerometer : null]
    ];
    for (let index = 0; index < candidates.length; index += 1) {
      const kind = candidates[index][0];
      const Ctor = candidates[index][1];
      if (!Ctor || this._failedKinds[kind]) continue;
      try {
        const sensor = new Ctor({ frequency: SENSOR_FREQUENCY });
        this._bindSensor(sensor, kind);
        this._sensor = sensor;
        this._sensorKind = kind;
        this._source = kind;
        this._detector = createCadenceDetector({ source: kind });
        this._buffer.clear();
        this._scale = 0.6;
        return true;
      } catch (error) {
        this._failedKinds[kind] = true;
        log('sensor create failed ' + kind + ': ' + String(error));
      }
    }
    this._sensor = null;
    this._sensorKind = '';
    return false;
  },

  _bindSensor(sensor, kind) {
    sensor.addEventListener('activate', (event) => {
      log('sensor activate ' + kind + ' session=' + (event && event.sessionId));
    });
    sensor.addEventListener('reading', () => {
      if (this._sensor !== sensor) return;
      this._readings += 1;
      if (this._readings === 1 || this._readings % 600 === 0) {
        log(
          'reading #' + this._readings + ' ' + kind + ' x=' + this._fmt(sensor.x) + ' y=' +
          this._fmt(sensor.y) + ' z=' + this._fmt(sensor.z) + ' ts=' + sensor.timestamp +
          ' cadence=' + (this._latest ? this._latest.cadence : 0)
        );
      }
      this._ingest(this._now(), sensor.x, sensor.y, sensor.z);
    });
    sensor.addEventListener('error', (event) => {
      if (this._sensor !== sensor) return;
      const message = event && event.message ? (event.error || 'error') + ': ' + event.message :
        String((event && event.error) || 'unknown sensor error');
      this._onSensorError(kind, message);
    });
  },

  _onSensorError(kind, message) {
    log('sensor error ' + kind + ': ' + message);
    this._failedKinds[kind] = true;
    this._disposeSensor();
    const wasActive = this._sourceActive;
    this._sourceActive = false;
    if (this._createSensor()) {
      this._notice = SENSOR_NAMES[kind] + '不可用，改用' + SENSOR_NAMES[this._sensorKind];
      this.setData({ notice: this._notice });
      if (wasActive) this._startSource();
      return;
    }
    this._source = 'none';
    if (wasActive) this._startSource();
  },

  _disposeSensor() {
    const sensor = this._sensor;
    const running = this._sensorRunning;
    this._sensor = null;
    this._sensorKind = '';
    this._sensorRunning = false;
    if (!sensor || !running) return;
    try {
      sensor.stop();
    } catch (_error) {
      // Already stopped or unavailable.
    }
  },

  _startSource() {
    if (this._sourceActive || !this._visible) return;
    this._sourceActive = true;
    if (this._demoRequested) {
      this._startDemo('requested');
      return;
    }
    if (!this._sensor) this._createSensor();
    if (this._sensor) {
      try {
        this._sensor.start();
        this._sensorRunning = true;
        this._source = this._sensorKind;
        this.setData({ notice: this._notice || '' });
        log('sensor start ' + this._sensorKind + ' ' + SENSOR_FREQUENCY + 'Hz');
        return;
      } catch (error) {
        this._failedKinds[this._sensorKind] = true;
        log('sensor start failed ' + this._sensorKind + ': ' + String(error));
        this._disposeSensor();
      }
    }
    if (DEMO_WHEN_UNAVAILABLE) {
      this._startDemo('sensor unavailable');
    } else {
      this._source = 'none';
      this.setData({ notice: '传感器不可用 · 仅节拍提示' });
    }
  },

  _stopSource() {
    if (!this._sourceActive) return;
    this._sourceActive = false;
    this._stopDemo();
    if (this._sensor && this._sensorRunning) {
      this._sensorRunning = false;
      try {
        this._sensor.stop();
        log('sensor stop ' + this._sensorKind);
      } catch (error) {
        log('sensor stop failed: ' + String(error));
      }
    }
  },

  _startDemo(reason) {
    this._stopDemo();
    this._source = 'demo';
    this._detector = createCadenceDetector({ source: 'demo' });
    this._buffer.clear();
    this._scale = 0.6;
    this._demoSignal = createStrideSignal({
      cadence: this._target - 6,
      seed: Math.floor(this._now() % 100000)
    });
    this._demoStartedAt = this._now();
    this._demoTimer = setInterval(() => this._demoTick(), DEMO_SAMPLE_MS);
    this.setData({
      notice: reason === 'requested' ? '演示信号：合成的跑步动作，不是传感器数据' : '传感器不可用 · 显示演示信号'
    });
    log('demo start reason=' + reason);
    this._applyPhase();
  },

  _demoTick() {
    if (!this._demoSignal) return;
    this._demoTicks += 1;
    const now = this._now();
    // The synthetic runner drifts around the target so the delta readout
    // and the metronome comparison have something to show.
    const drift = 8 * Math.sin((now - this._demoStartedAt) / 15000);
    this._demoSignal.setCadence(this._phase === 'running' ? this._target - 4 + drift : 0);
    const sample = this._demoSignal.sample(now);
    this._ingest(now, sample.x, sample.y, sample.z);
  },

  _stopDemo() {
    if (this._demoTimer !== null) {
      clearInterval(this._demoTimer);
      this._demoTimer = null;
    }
    this._demoSignal = null;
  },

  _ingest(t, x, y, z) {
    const result = this._detector.push(t, x, y, z);
    this._buffer.push({ t: result.t, value: result.value, threshold: result.threshold, step: result.step });
    const magnitude = Math.abs(result.value);
    this._scale = Math.max(this._scale * 0.985, magnitude, result.threshold * 1.4, 0.2);
    this._latest = result;
    if (this._phase !== 'running') return;
    if (result.step) {
      this._runSteps += 1;
      this._secondSteps += 1;
    }
    const second = Math.floor((this._activeMs + (t - this._runStartedAt)) / 1000);
    if (second !== this._secondIndex) {
      this._flushSecond();
      this._secondIndex = second;
      this._secondSteps = 0;
    }
  },

  _flushSecond() {
    if (this._secondIndex < 0 || !this._session) return;
    noteSecond(this._session, {
      second: this._secondIndex,
      cadence: this._latest ? this._latest.cadence : 0,
      steps: this._secondSteps
    });
  },

  // ---- metronome and audio ----------------------------------------------

  _onBeat(beat) {
    this._lastBeatAt = beat.at;
    this._playTick(beat.accent);
    if (beat.index === 1 || (beat.index > 0 && beat.index % 30 === 0)) {
      const stats = this._metronome.stats();
      log(
        'beat #' + beat.index + ' bpm=' + stats.bpm + ' late=' + Math.round(beat.lateMs) +
        'ms rate=' + stats.achievedRate.toFixed(2) + '/s meanInterval=' +
        Math.round(stats.meanIntervalMs) + 'ms maxLate=' + Math.round(stats.maxLateMs) + 'ms'
      );
    }
  },

  _createAudio() {
    if (typeof Sound === 'function') {
      try {
        this._tick = new Sound('/assets/tick.wav');
        this._accentTick = new Sound('/assets/tick-accent.wav');
        this._tick.volume = 0.9;
        this._accentTick.volume = 1;
        return 'sound';
      } catch (error) {
        log('Sound unavailable: ' + String(error));
        this._tick = null;
        this._accentTick = null;
      }
    }
    if (typeof AudioContext === 'function') {
      try {
        this._audioContext = new AudioContext();
        return 'audiocontext';
      } catch (error) {
        log('AudioContext unavailable: ' + String(error));
        this._audioContext = null;
      }
    }
    return 'none';
  },

  _resumeAudio() {
    const context = this._audioContext;
    if (context && typeof context.resume === 'function') {
      try {
        const result = context.resume();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (_error) {
        // Stays suspended; the visual beat still works.
      }
    }
  },

  _playTick(accent) {
    try {
      if (this._tick) {
        (accent && this._accentTick ? this._accentTick : this._tick).play();
      } else if (this._audioContext) {
        const context = this._audioContext;
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.frequency.value = accent ? 1800 : 1200;
        gain.gain.value = 0.4;
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start();
        oscillator.stop(context.currentTime + 0.04);
      }
    } catch (error) {
      if (!this._tickErrorLogged) {
        this._tickErrorLogged = true;
        log('tick failed: ' + String(error));
      }
    }
    if (this._vibrate === 'yes') {
      try {
        navigator.vibrate(accent ? 45 : 30);
      } catch (_error) {
        this._vibrate = 'failed';
      }
    }
  },

  _detectVibrate() {
    // Not an AIUI API: probed only so the Studio log states whether the
    // runtime exposes a vibration entry point at all.
    try {
      return typeof navigator !== 'undefined' && navigator && typeof navigator.vibrate === 'function' ? 'yes' : 'no';
    } catch (_error) {
      return 'no';
    }
  },

  _disposeAudio() {
    for (const key of ['_tick', '_accentTick']) {
      const sound = this[key];
      this[key] = null;
      if (sound && typeof sound.destroy === 'function') {
        try {
          sound.destroy();
        } catch (_error) {
          // Already released.
        }
      }
    }
    const context = this._audioContext;
    this._audioContext = null;
    if (context && typeof context.close === 'function') {
      try {
        const result = context.close();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch (_error) {
        // Already closed.
      }
    }
  },

  // ---- rendering ----------------------------------------------------------

  _startFrames() {
    if (this._frameTimer !== null) return;
    this._frameTimer = setInterval(() => this._frame(), FRAME_MS);
  },

  _stopFrames() {
    if (this._frameTimer === null) return;
    clearInterval(this._frameTimer);
    this._frameTimer = null;
  },

  _frame() {
    if (!this._visible) return;
    this._frames += 1;
    const ctx = this._ctx();
    if (!ctx) return;
    try {
      if (this._phase === 'finished' && this._record) {
        if (this._recordDrawn) return;
        this._recordDrawn = true;
        drawRecordChart(ctx, {
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
          series: this._record.series,
          targetCadence: this._record.targetCadence,
          totalSeconds: Math.max(1, Math.ceil(this._record.activeMs / 1000)),
          label: '本次步频 spm · 虚线为目标'
        });
        return;
      }
      const now = this._now();
      drawLiveCurve(ctx, {
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        now,
        spanMs: WINDOW_MS,
        samples: this._buffer.samples,
        amplitude: this._scale,
        threshold: this._latest ? this._latest.threshold : 0,
        beatAt: this._lastBeatAt,
        running: this._phase === 'running',
        label: SOURCE_LABELS[this._source] + ' ' + SENSOR_FREQUENCY + 'Hz · ' + (this._latest ? this._latest.unit : ''),
        sublabel: (WINDOW_MS / 1000) + 's'
      });
    } catch (error) {
      if (!this._frameErrorLogged) {
        this._frameErrorLogged = true;
        log('frame failed via ' + this._ctxVia + ': ' + String(error));
      }
    }
  },

  _ctx() {
    if (this._ctxCache) return this._ctxCache;
    let ctx = null;
    let via = '';
    try {
      const element = typeof this.querySelector === 'function' ? this.querySelector('#curve') : null;
      if (element && typeof element.getContext === 'function') {
        ctx = element.getContext('2d');
        via = 'querySelector';
      }
    } catch (_error) {
      ctx = null;
    }
    if (!ctx) {
      try {
        const component = typeof this.selectComponent === 'function' ? this.selectComponent('#curve') : null;
        if (component && typeof component.getContext === 'function') {
          ctx = component.getContext('2d');
          via = 'selectComponent';
        }
      } catch (_error) {
        ctx = null;
      }
    }
    if (!ctx) {
      try {
        if (wx && typeof wx.createCanvasContext === 'function') {
          ctx = wx.createCanvasContext('curve', this);
          via = 'wx.createCanvasContext';
        }
      } catch (_error) {
        ctx = null;
      }
    }
    if (ctx) {
      this._ctxCache = ctx;
      this._ctxVia = via;
      log('canvas context via ' + via);
    } else if (!this._ctxMissingLogged) {
      this._ctxMissingLogged = true;
      log('canvas context unavailable');
    }
    return ctx;
  },

  _startUi() {
    if (this._uiTimer !== null) return;
    this._uiTimer = setInterval(() => this._refreshUi(false), UI_MS);
  },

  _stopUi() {
    if (this._uiTimer === null) return;
    clearInterval(this._uiTimer);
    this._uiTimer = null;
  },

  _refreshUi(force) {
    this._uiTicks += 1;
    if (this._uiTicks % 25 === 0) this._logDiagnostics();
    if (this._phase === 'finished') return;
    const now = this._now();
    const elapsed = this._activeMs + (this._phase === 'running' ? now - this._runStartedAt : 0);
    const cadence = this._latest ? this._latest.cadence : 0;
    const stats = this._metronome.stats();
    const patch = {
      clock: formatDuration(elapsed),
      cadenceText: cadence ? String(cadence) : '--',
      targetLabel: '目标步频 · ' + describeDelta(cadence, this._target),
      beatRateText: this._metronome.running && stats.achievedRate ? stats.achievedRate.toFixed(1) : '--',
      stepsText: String(this._runSteps)
    };
    const snapshot = JSON.stringify(patch);
    if (!force && snapshot === this._uiSnapshot) return;
    this._uiSnapshot = snapshot;
    this.setData(patch);
  },

  // ---- helpers ------------------------------------------------------------

  // Runtime timer diagnostics (every ~5 s): how the host actually delivers
  // the demo interval, the frame interval, the UI interval, and the beats.
  _logDiagnostics() {
    const samples = this._buffer.samples;
    const first = samples.length ? samples[0] : null;
    const last = samples.length ? samples[samples.length - 1] : null;
    const stats = this._metronome.stats();
    log(
      'diag phase=' + this._phase + ' source=' + this._source + ' samples=' + samples.length +
      ' span=' + (first && last ? Math.round(last.t - first.t) : 0) + 'ms lastAge=' +
      (last ? Math.round(this._now() - last.t) : -1) + 'ms demoTicks=' + this._demoTicks +
      ' readings=' + this._readings + ' frames=' + this._frames + ' ui=' + this._uiTicks +
      ' beats=' + stats.beats + ' rate=' + stats.achievedRate.toFixed(2) + ' maxLate=' +
      Math.round(stats.maxLateMs) + 'ms cadence=' + (this._latest ? this._latest.cadence : 0) +
      ' scale=' + this._scale.toFixed(3) + ' ctx=' + this._ctxVia
    );
  },

  _now() {
    return Date.now();
  },

  _fmt(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : String(value);
  },

  _offsetMinutes() {
    try {
      return normalizeOffsetMinutes(new Date().getTimezoneOffset());
    } catch (_error) {
      return 0;
    }
  },

  _viewportInfo() {
    try {
      if (wx && typeof wx.getWindowInfo === 'function') {
        const info = wx.getWindowInfo();
        return info ? info.windowWidth + 'x' + info.windowHeight : 'none';
      }
    } catch (_error) {
      return 'error';
    }
    return 'n/a';
  }
};
</script>

<page class="shell">
  <view class="top">
    <text class="brand">跑伴 · 步频节拍</text>
    <view class="top-right">
      <text class="chip chip-{{state}}">{{stateLabel}}</text>
      <text class="clock">{{clock}}</text>
    </view>
  </view>
  <view class="curve-frame">
    <canvas id="curve" canvas-id="curve" width="446" height="150" class="curve"></canvas>
  </view>
  <view class="metrics">
    <view class="metric metric-main">
      <text class="value-lg">{{cadenceText}}</text>
      <text class="unit">{{mainLabel}}</text>
    </view>
    <view class="metric">
      <text class="value">{{targetText}}</text>
      <text class="unit">{{targetLabel}}</text>
    </view>
    <view class="metric metric-beat">
      <text class="value">{{beatRateText}}</text>
      <text class="unit">{{beatLabel}}</text>
    </view>
    <view class="metric metric-steps">
      <text class="value">{{stepsText}}</text>
      <text class="unit">{{stepsLabel}}</text>
    </view>
  </view>
  <text class="notice" ink:if="{{notice}}">{{notice}}</text>
  <text class="record-line" ink:if="{{lastRecordText}}">{{lastRecordText}}</text>
  <text class="hint">{{hint}}</text>
</page>

<style>
.shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  padding: 12px 16px;
  box-sizing: border-box;
  color: rgba(64, 255, 94, 0.72);
  background-color: #000000;
}

.top {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  height: 20px;
}

.top-right {
  display: flex;
  flex-direction: row;
  align-items: center;
}

.brand {
  font-size: 11px;
  line-height: 14px;
  letter-spacing: 1px;
  color: rgba(64, 255, 94, 0.48);
}

.chip {
  padding: 2px 6px;
  margin-right: 10px;
  font-size: 11px;
  line-height: 14px;
  border: 1px solid rgba(64, 255, 94, 0.48);
  border-radius: 4px;
  color: rgba(64, 255, 94, 0.72);
}

.chip-running {
  border: 1px solid rgba(64, 255, 94, 0.72);
  color: #40ff5e;
  background-color: rgba(64, 255, 94, 0.12);
}

.chip-paused {
  border: 1px dashed rgba(64, 255, 94, 0.72);
}

.chip-finished {
  border: 1px solid #40ff5e;
  color: #40ff5e;
}

.clock {
  font-family: monospace;
  font-size: 13px;
  line-height: 16px;
  color: rgba(64, 255, 94, 0.72);
}

.curve-frame {
  width: 448px;
  height: 152px;
  margin-top: 8px;
  border: 1px solid rgba(64, 255, 94, 0.24);
  border-radius: 2px;
  box-sizing: border-box;
  overflow: hidden;
}

.curve {
  width: 446px;
  height: 150px;
}

.metrics {
  display: flex;
  flex-direction: row;
  align-items: flex-end;
  margin-top: 10px;
}

.metric {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.metric-main {
  flex: 1.3;
}

.value-lg {
  font-family: monospace;
  font-size: 44px;
  line-height: 46px;
  color: #40ff5e;
}

.value {
  font-family: monospace;
  font-size: 22px;
  line-height: 26px;
  color: rgba(64, 255, 94, 0.72);
}

.unit {
  margin-top: 2px;
  font-size: 10px;
  line-height: 13px;
  letter-spacing: 1px;
  color: rgba(64, 255, 94, 0.48);
}

.notice,
.record-line {
  margin-top: 6px;
  padding-left: 6px;
  font-size: 11px;
  line-height: 14px;
  border-left: 1px solid rgba(64, 255, 94, 0.48);
  color: rgba(64, 255, 94, 0.72);
}

.record-line {
  color: rgba(64, 255, 94, 0.48);
}

.hint {
  margin-top: auto;
  font-size: 11px;
  line-height: 14px;
  color: rgba(64, 255, 94, 0.48);
}

@media (target: _current) {
  .shell {
    padding: 10px 14px;
  }
}

@media (target: _blank) {
  .shell {
    padding: 12px 16px;
  }
}

/* Inline card in the conversation flow (about 448 x 150): keep the state,
   the cadence, the target, and the hint; drop the curve and the extras. */
@media (max-height: 240px) {
  .shell {
    padding: 6px 12px;
  }
  .brand,
  .curve-frame,
  .metric-beat,
  .metric-steps,
  .notice,
  .record-line {
    display: none;
  }
  .metrics {
    margin-top: 4px;
  }
  .value-lg {
    font-size: 34px;
    line-height: 36px;
  }
  .value {
    font-size: 18px;
    line-height: 22px;
  }
}
</style>
