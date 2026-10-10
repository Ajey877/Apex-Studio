// Apex Studio — spike (EXPERIMENTAL). Dedicated Worker used by the CSP matrix:
// does WebAssembly compile in a Worker under a given policy? Receives the bytes
// by message, replies { ok } or { ok:false, name, message }. Self-contained.
self.onmessage = async event => {
  try {
    const { instance } = await WebAssembly.instantiate(event.data, {});
    self.postMessage({ ok: true, abi: instance.exports.abi_version() });
  } catch (err) {
    self.postMessage({ ok: false, name: err && err.name, message: String(err && err.message) });
  }
};
