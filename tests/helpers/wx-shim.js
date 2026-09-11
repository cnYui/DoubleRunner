// Stand-in for the runtime's `wx` module. Tests assign `globalThis.__wx`
// before loading a page; every property read is delegated at access time.
const shim = {};
for (const key of ['getWindowInfo', 'createCanvasContext', 'navigateTo', 'exitMiniProgram']) {
  Object.defineProperty(shim, key, {
    enumerable: true,
    get() {
      return (globalThis.__wx || {})[key];
    }
  });
}
export default shim;
