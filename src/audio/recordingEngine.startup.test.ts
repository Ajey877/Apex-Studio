import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingEngine } from './recordingEngine';

class StartupTrack {
  stopped = false;
  stop(): void { this.stopped = true; }
}

class StartupStream {
  readonly track = new StartupTrack();
  getTracks(): StartupTrack[] { return [this.track]; }
}

class StartupSource {
  disconnected = false;
  connect(): void {}
  disconnect(): void { this.disconnected = true; }
}

class StartupAnalyser {
  fftSize = 1024;
  smoothingTimeConstant = 0;
  disconnected = false;
  connect(): void {}
  disconnect(): void { this.disconnected = true; }
}

class StartupContext {
  readonly source = new StartupSource();
  readonly analyser = new StartupAnalyser();
  state = 'running';
  createMediaStreamSource(): StartupSource { return this.source; }
  createAnalyser(): StartupAnalyser { return this.analyser; }
}

test('startup failure disconnects locally-created audio nodes before assignment', async () => {
  const stream = new StartupStream();
  const context = new StartupContext();
  const OriginalNavigator = globalThis.navigator;
  const OriginalMediaRecorder = globalThis.MediaRecorder;

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => stream } },
  });
  Object.defineProperty(globalThis, 'MediaRecorder', {
    configurable: true,
    value: class {
      static isTypeSupported(): boolean { return true; }
      constructor() { throw new Error('MediaRecorder construction failed'); }
    },
  });

  try {
    const engine = new RecordingEngine(() => context as unknown as AudioContext);
    await assert.rejects(engine.start(), /MediaRecorder construction failed/);
    assert.equal(context.source.disconnected, true);
    assert.equal(context.analyser.disconnected, true);
    assert.equal(stream.track.stopped, true);
    assert.equal(engine.getState(), 'idle');
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: OriginalNavigator });
    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: OriginalMediaRecorder });
  }
});
