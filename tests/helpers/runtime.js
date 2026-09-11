// Fake AIUI runtime globals for page tests: Gyroscope / Accelerometer
// (Generic-Sensor style), Sound, localStorage, and the wx canvas context.

class FakeSensor {
  constructor(options, registry, kind) {
    this.kind = kind;
    this.options = options;
    this.listeners = {};
    this.x = null;
    this.y = null;
    this.z = null;
    this.timestamp = null;
    this.activated = false;
    this.hasReading = false;
    this.started = 0;
    this.stopped = 0;
    registry.push(this);
  }
  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== handler);
  }
  dispatch(type, event) {
    for (const handler of this.listeners[type] || []) handler(event || {});
  }
  start() {
    this.started += 1;
    this.activated = true;
    this.dispatch('activate', { sessionId: this.started });
  }
  stop() {
    this.stopped += 1;
    this.activated = false;
  }
  emit(x, y, z, timestamp) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.timestamp = timestamp;
    this.hasReading = true;
    this.dispatch('reading', { x, y, z, timestamp });
  }
  fail(error, message) {
    this.activated = false;
    this.dispatch('error', { error, message });
  }
}

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

export function installRuntime(options = {}) {
  const calls = { gyroscopes: [], accelerometers: [], sounds: [], plays: [], canvasContexts: 0 };
  const storage = new Map();
  if (options.gyroscope !== false) {
    defineGlobal(
      'Gyroscope',
      class Gyroscope extends FakeSensor {
        constructor(sensorOptions) {
          super(sensorOptions, calls.gyroscopes, 'gyroscope');
        }
      }
    );
  }
  if (options.accelerometer !== false) {
    defineGlobal(
      'Accelerometer',
      class Accelerometer extends FakeSensor {
        constructor(sensorOptions) {
          super(sensorOptions, calls.accelerometers, 'accelerometer');
        }
      }
    );
  }
  if (options.sound !== false) {
    defineGlobal(
      'Sound',
      class Sound {
        constructor(src) {
          this.src = src;
          this.volume = 1;
          this.destroyed = 0;
          calls.sounds.push(this);
        }
        play() {
          calls.plays.push({ src: this.src, at: Date.now() });
        }
        stop() {}
        destroy() {
          this.destroyed += 1;
        }
      }
    );
  }
  defineGlobal('localStorage', {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
    clear() {
      storage.clear();
    }
  });
  const contextCalls = [];
  const context = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'calls') return contextCalls;
        return (...args) => {
          contextCalls.push([property, args]);
        };
      },
      set() {
        return true;
      }
    }
  );
  globalThis.__wx = {
    getWindowInfo() {
      return { windowWidth: 480, windowHeight: 352 };
    },
    createCanvasContext() {
      calls.canvasContexts += 1;
      return context;
    }
  };
  return { calls, storage, context: { calls: contextCalls } };
}

export function uninstallRuntime() {
  for (const name of ['Gyroscope', 'Accelerometer', 'Sound', 'localStorage']) {
    if (Object.prototype.hasOwnProperty.call(globalThis, name)) delete globalThis[name];
  }
  delete globalThis.__wx;
}
