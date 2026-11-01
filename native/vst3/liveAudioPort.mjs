export const LIVE_AUDIO_BLOCK_FRAMES = 1024;
const LIVE_AUDIO_SAMPLES = LIVE_AUDIO_BLOCK_FRAMES * 2;

function hasFinitePlanarStereo(samples) {
  if (!(samples instanceof Float32Array) || samples.length !== LIVE_AUDIO_SAMPLES) return false;
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) return false;
  }
  return true;
}

function attachPortListeners(port, onMessage, onClose) {
  const deliver = event => {
    const data = event && typeof event === 'object' && Object.prototype.hasOwnProperty.call(event, 'data')
      ? event.data : event;
    onMessage(data);
  };
  const closed = () => onClose();
  // Electron MessagePortMain and Node worker_threads MessagePort are EventEmitters;
  // prefer .on('message') so MessagePortMain delivers worklet blocks in packaged Electron.
  if (typeof port.on === 'function') {
    port.on('message', deliver);
    port.on('close', closed);
    if (typeof port.start === 'function') port.start();
    return () => {
      if (typeof port.off === 'function') {
        port.off('message', deliver);
        port.off('close', closed);
      } else if (typeof port.removeListener === 'function') {
        port.removeListener('message', deliver);
        port.removeListener('close', closed);
      }
    };
  }
  if (typeof port.addEventListener === 'function') {
    port.addEventListener('message', deliver);
    port.addEventListener('close', closed);
    if (typeof port.start === 'function') port.start();
    return () => {
      if (typeof port.removeEventListener === 'function') {
        port.removeEventListener('message', deliver);
        port.removeEventListener('close', closed);
      }
    };
  }
  port.onmessage = deliver;
  if ('onclose' in port) port.onclose = closed;
  if (typeof port.start === 'function') port.start();
  return () => {
    port.onmessage = null;
    if ('onclose' in port) port.onclose = null;
  };
}

/**
 * Main-process live PCM pump for one opened VST3 Mixer effect session. The
 * renderer negotiates/binds this MessagePort during preparation; steady-state
 * 1024-frame stereo blocks then travel AudioWorklet <-> main Vst3Service
 * without waiting on the renderer UI thread.
 */
export function createLiveAudioPortSession({
  sessionId,
  owner,
  trackId,
  slotId,
  processAudio,
  onFatal = undefined,
  onStop = undefined,
}) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 128) {
    throw new Error('Invalid live audio session');
  }
  if (typeof owner !== 'string' || owner.length === 0) throw new Error('Invalid live audio owner');
  if (!Number.isInteger(trackId) || typeof slotId !== 'string' || slotId.length === 0 || slotId.length > 128) {
    throw new Error('Invalid live audio identity');
  }
  if (typeof processAudio !== 'function') throw new Error('Invalid live audio processor');

  let port = null;
  let detachListeners = null;
  let stopping = false;
  let disposed = false;
  let busy = false;
  let stopReason = 'explicit-stop';
  let stopNotified = false;
  let pendingCount = 0;
  let tail = Promise.resolve();

  const post = message => {
    if (!port || disposed) return;
    try { port.postMessage(message); } catch { /* peer port may already be closed */ }
  };

  const notifyCancelled = (sequence, errorMessage = undefined) => {
    if (!Number.isInteger(sequence) || sequence < 0) return;
    post({
      type: 'cancelled',
      sequence,
      reason: stopReason,
      ...(errorMessage === undefined ? {} : { error: errorMessage }),
    });
  };

  const stop = (reason = 'explicit-stop') => {
    if (disposed) return;
    if (!stopping) {
      stopping = true;
      stopReason = String(reason || 'explicit-stop');
    }
    if (!stopNotified) {
      stopNotified = true;
      try { onStop?.(stopReason); } catch { /* close-path callback owns its own cleanup */ }
    }
  };

  const dispose = async (reason = 'dispose') => {
    stop(reason);
    const current = port;
    const detach = detachListeners;
    try { await tail; } catch { /* errors are reported on the port before teardown */ }
    disposed = true;
    port = null;
    detachListeners = null;
    try { detach?.(); } catch { /* ignore */ }
    if (current) {
      try { current.close(); } catch { /* already closed */ }
    }
  };

  const handleMessage = message => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'close') {
      void dispose('dispose');
      return;
    }
    if (message.type !== 'process') return;
    const sequence = message.sequence;
    if (disposed || stopping) {
      notifyCancelled(sequence);
      return;
    }
    if (!Number.isInteger(sequence) || sequence < 0 || !hasFinitePlanarStereo(message.samples)) {
      const error = new Error('Invalid native-effect live-port request.');
      post({ type: 'error', sequence: Number.isInteger(sequence) ? sequence : null, reason: error.message });
      stop('protocol-error');
      onFatal?.(error);
      void dispose('protocol-error');
      return;
    }
    if (busy || pendingCount > 0) {
      const error = new Error('Overlapping VST3 effect live-port request rejected.');
      post({ type: 'error', sequence, reason: error.message });
      stop('protocol-error');
      onFatal?.(error);
      void dispose('protocol-error');
      return;
    }
    const samples = new Float32Array(message.samples);
    const timing = message.timing && typeof message.timing === 'object' ? message.timing : undefined;
    busy = true;
    pendingCount++;
    const run = tail.then(async () => {
      try {
        if (disposed || stopping) {
          notifyCancelled(sequence);
          return;
        }
        let output;
        try {
          output = await processAudio({ sessionId, owner, trackId, slotId, sequence, samples, timing });
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          if (disposed || stopping) {
            notifyCancelled(sequence, failure.message);
            return;
          }
          post({ type: 'error', sequence, reason: failure.message });
          stop('native-error');
          onFatal?.(failure);
          return;
        }
        if (disposed || stopping) {
          notifyCancelled(sequence);
          return;
        }
        if (!hasFinitePlanarStereo(output)) {
          const failure = new Error('Native effect returned malformed or non-finite PCM.');
          post({ type: 'error', sequence, reason: failure.message });
          stop('malformed-output');
          onFatal?.(failure);
          return;
        }
        post({ type: 'result', sequence, samples: output });
      } finally {
        busy = false;
      }
    });
    tail = run.catch(() => {}).finally(() => { pendingCount = Math.max(0, pendingCount - 1); });
  };

  return {
    get sessionId() { return sessionId; },
    get owner() { return owner; },
    get stopping() { return stopping; },
    get disposed() { return disposed; },
    get busy() { return busy; },
    get pending() { return pendingCount; },
    attach(nextPort) {
      if (disposed) throw new Error('Live audio session is closed');
      if (port || stopping) throw new Error('Live audio port already bound');
      if (!nextPort || typeof nextPort.postMessage !== 'function') throw new Error('Live audio port missing');
      port = nextPort;
      detachListeners = attachPortListeners(port, handleMessage, () => {
        stopping = true;
        disposed = true;
        port = null;
        detachListeners = null;
      });
      post({ type: 'bound', sessionId, trackId, slotId });
    },
    stop,
    dispose,
  };
}
