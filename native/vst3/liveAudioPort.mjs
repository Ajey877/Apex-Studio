const BLOCK_FRAMES = 1024;
const BLOCK_SAMPLES = BLOCK_FRAMES * 2;

function send(port, message, transfer) {
  if (!port) return;
  try {
    if (transfer?.length) port.postMessage(message, transfer);
    else port.postMessage(message);
  } catch {
    /* the peer may already have closed */
  }
}

function listen(port, onMessage, onClose) {
  if (typeof port.addEventListener === 'function') {
    port.addEventListener('message', event => onMessage(event.data, event));
    port.addEventListener('close', () => onClose());
    if (typeof port.start === 'function') port.start();
    return;
  }
  if (typeof port.on === 'function') {
    port.on('message', event => onMessage(event.data, event));
    port.on('close', () => onClose());
    if (typeof port.start === 'function') port.start();
    return;
  }
  port.onmessage = event => onMessage(event.data, event);
  if ('onclose' in port) port.onclose = () => onClose();
  if (typeof port.start === 'function') port.start();
}

export function createLiveAudioPortSession({
  sessionId, owner, trackId, slotId, processAudio, onFatal = undefined,
}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) throw new Error('Invalid live audio session');
  if (typeof owner !== 'string' || owner.length === 0) throw new Error('Invalid live audio owner');
  if (!Number.isInteger(trackId) || typeof slotId !== 'string' || slotId.length === 0 || slotId.length > 128) {
    throw new Error('Invalid live audio identity');
  }
  if (typeof processAudio !== 'function') throw new Error('Live audio processor missing');
  let port = null;
  let stopping = false;
  let disposed = false;
  let busy = false;
  let tail = Promise.resolve();
  let pending = 0;
  const attach = nextPort => {
    if (disposed) throw new Error('Live audio session is closed');
    if (port) throw new Error('Live audio port already bound');
    if (!nextPort) throw new Error('Live audio port missing');
    port = nextPort;
    listen(port, message => { void handleMessage(message); }, () => {
      stopping = true;
      disposed = true;
      port = null;
    });
    send(port, { type: 'bound', sessionId, trackId, slotId });
  };
  const handleMessage = async message => {
    if (!message || message.type !== 'process') {
      if (message?.type === 'close') void dispose('dispose');
      return;
    }
    const sequence = message.sequence;
    if (stopping || disposed) {
      send(port, { type: 'cancelled', sequence, reason: 'explicit-stop' });
      return;
    }
    if (!Number.isInteger(sequence) || sequence < 0 ||
        !(message.samples instanceof Float32Array) || message.samples.length !== BLOCK_SAMPLES ||
        message.samples.some(sample => !Number.isFinite(sample))) {
      const error = new Error('Invalid native-effect live-port request.');
      onFatal?.(error);
      send(port, { type: 'error', sequence, reason: error.message });
      return;
    }
    pending++;
    const operation = tail.then(async () => {
      if (stopping || disposed) {
        send(port, { type: 'cancelled', sequence, reason: 'explicit-stop' });
        return;
      }
      if (busy) throw new Error('Concurrent VST3 effect processing request rejected');
      busy = true;
      try {
        const samples = await processAudio({ sessionId, sequence, samples: message.samples, timing: message.timing });
        if (stopping || disposed) {
          send(port, { type: 'cancelled', sequence, reason: 'explicit-stop' });
          return;
        }
        if (!(samples instanceof Float32Array) || samples.length !== BLOCK_SAMPLES || samples.some(sample => !Number.isFinite(sample))) {
          throw new Error('Native effect returned malformed or non-finite PCM.');
        }
        send(port, { type: 'result', sequence, samples });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (stopping || disposed) {
          send(port, { type: 'cancelled', sequence, reason: 'explicit-stop', error: reason });
          return;
        }
        onFatal?.(error instanceof Error ? error : new Error(reason));
        send(port, { type: 'error', sequence, reason });
      } finally {
        busy = false;
      }
    });
    tail = operation.catch(() => {}).finally(() => { pending = Math.max(0, pending - 1); });
  };
  const dispose = async (_reason = 'dispose') => {
    stopping = true;
    await tail.catch(() => {});
    disposed = true;
    try { port?.close(); } catch { /* already closed */ }
    port = null;
  };
  return {
    sessionId, owner, trackId, slotId, attach, dispose,
    get pending() { return pending; },
    get stopping() { return stopping; },
    get disposed() { return disposed; },
    get busy() { return busy; },
  };
}

export const LIVE_AUDIO_BLOCK_FRAMES = BLOCK_FRAMES;
