import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingEngine } from './recordingEngine';

class FakeTrack {
  stopped = false;
  stop(): void { this.stopped = true; }
}

class FakeStream {
  readonly track = new FakeTrack();
  getTracks(): FakeTrack[] { return [this.track]; }
}

class FakeSource {
  disconnected = false;
  connect(): void {}
  disconnect(): void { this.disconnected = true; }
}

class FakeAnalyser {
  fftSize = 1024;
  smoothingTimeConstant = 0;
  disconnected = false;
  connect(): void {}
  disconnect(): void { this.disconnected = true; }
  getByteTimeDomainData(data: Uint8Array): void { data.fill(128); }
}

class FakeAudioContext {
  state = 'running';
  readonly decoded = {
    numberOfChannels: 1,
    length: 4,
    duration: 0.1,
    sampleRate: 44100,
    getChannelData: () => new Float32Array([0, 0.5, -0.25, 0.1]),
    copyFromChannel: () => {},
    copyToChannel: () => {},
  } as unknown as AudioBuffer;
  async resume(): Promise<void> {}
  createMediaStreamSource(): FakeSource { return new FakeSource(); }
  createAnalyser(): FakeAnalyser { return new FakeAnalyser(); }
  async decodeAudioData(): Promise<AudioBuffer> { return this.decoded; }
}

class FakeMediaRecorder {
  static isTypeSupported(): boolean { return true; }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void | Promise<void>) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly stream: FakeStream) {}
  start(): void { this.state = 'recording'; }
  pause(): void { this.state = 'recording'; }
  resume(): void { this.state = 'recording'; }
  stop(): void {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['recorded'], { type: 'audio/webm' }) });
        this.ondataavailable?.({ data: new Blob(['-tail'], { type: 'audio/webm' }) });
      void this.onstop?.();
    });
  }
  fail(): void { this.onerror?.(); }
}

const installBrowserMocks = () => {
  const stream = new FakeStream();
  const recorderInstances: FakeMediaRecorder[] = [];
  const OriginalMediaRecorder = globalThis.MediaRecorder;
  const OriginalNavigator = globalThis.navigator;
  const OriginalCreateObjectURL = URL.createObjectURL;

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => stream } },
  });
  Object.defineProperty(globalThis, 'MediaRecorder', {
    configurable: true,
    value: class extends FakeMediaRecorder {
      constructor(input: FakeStream) {
        super(input);
        recorderInstances.push(this);
      }
    },
  });
  URL.createObjectURL = () => 'blob:recording-test';

  return {
    stream,
    recorderInstances,
    restore: () => {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: OriginalNavigator });
      Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: OriginalMediaRecorder });
      URL.createObjectURL = OriginalCreateObjectURL;
    },
  };
};

const createContext = (): AudioContext => new FakeAudioContext() as unknown as AudioContext;

test('recording stop decodes the Blob for waveform generation and releases capture resources', async () => {
  const mocks = installBrowserMocks();
  try {
    const engine = new RecordingEngine(createContext, { waveformSamples: 32, persistAudioClip: async () => {} });
    await engine.start();
    const result = await engine.stop();

    assert.equal(result.blob.size > 0, true);
    assert.equal(result.mimeType, 'audio/webm');
    assert.equal(result.waveform.length, 32);
    assert.ok(result.waveform.some(value => value > 0));
    assert.equal(engine.getState(), 'idle');
    assert.equal(mocks.stream.track.stopped, true);
  } finally {
    mocks.restore();
  }
});

test('cancel always stops the microphone and returns the engine to idle', async () => {
  const mocks = installBrowserMocks();
  try {
    const engine = new RecordingEngine(createContext);
    await engine.start();
    await assert.rejects(engine.cancel(), /cancelled/);
    assert.equal(engine.getState(), 'idle');
    assert.equal(mocks.stream.track.stopped, true);
  } finally {
    mocks.restore();
  }
});

test('persistence failure rejects stop, does not return a recording, and still cleans up', async () => {
  const mocks = installBrowserMocks();
  try {
    const persistenceError = new Error('storage unavailable');
    const errors: Error[] = [];
    const engine = new RecordingEngine(createContext, {
      persistAudioClip: async () => { throw persistenceError; },
      onError: error => errors.push(error)
    });
    await engine.start();

    await assert.rejects(engine.stop(), error => error === persistenceError);
    assert.equal(errors[0], persistenceError);
    assert.equal(engine.getState(), 'idle');
    assert.equal(mocks.stream.track.stopped, true);
  } finally {
    mocks.restore();
  }
});

test('a throwing onError callback cannot prevent stop from rejecting', async () => {
  const mocks = installBrowserMocks();
  try {
    const engine = new RecordingEngine(createContext, {
      persistAudioClip: async () => { throw new Error('storage unavailable'); },
      onError: () => { throw new Error('callback failed'); }
    });
    await engine.start();

    await assert.rejects(engine.stop(), /storage unavailable/);
    assert.equal(engine.getState(), 'idle');
  } finally {
    mocks.restore();
  }
});

test('repeated stop shares finalization and queued chunks are included', async () => {
  const mocks = installBrowserMocks();
  try {
    const engine = new RecordingEngine(createContext, { persistAudioClip: async () => {} });
    await engine.start();
    const firstStop = engine.stop();
    const secondStop = engine.stop();
    assert.equal(firstStop, secondStop);
    const result = await firstStop;
    assert.equal(await result.blob.text(), 'recorded-tail');
  } finally {
    mocks.restore();
  }
});

test('dispose during recording and repeated cancellation settle without duplicate cleanup', async () => {
  const mocks = installBrowserMocks();
  try {
    const engine = new RecordingEngine(createContext, { persistAudioClip: async () => {} });
    await engine.start();
    const firstCancel = engine.cancel();
    const secondCancel = engine.cancel();
    await assert.rejects(firstCancel, /cancelled/);
    await assert.rejects(secondCancel, /cancelled/);
    await engine.dispose();
    assert.equal(engine.getState(), 'idle');
    assert.equal(mocks.stream.track.stopped, true);
  } finally {
    mocks.restore();
  }
});

test('recorder error during finalization rejects and cleans up', async () => {
  const mocks = installBrowserMocks();
  try {
    const engine = new RecordingEngine(createContext, { persistAudioClip: async () => {} });
    await engine.start();
    const stopping = engine.stop();
    mocks.recorderInstances[0].fail();
    await assert.rejects(stopping, /Audio recording failed/);
    assert.equal(engine.getState(), 'idle');
    assert.equal(mocks.stream.track.stopped, true);
  } finally {
    mocks.restore();
  }
});

test('MediaRecorder errors immediately clean up capture resources', async () => {
  const mocks = installBrowserMocks();
  try {
    const engine = new RecordingEngine(createContext);
    await engine.start();
    mocks.recorderInstances[0].fail();
    assert.equal(engine.getState(), 'idle');
    assert.equal(mocks.stream.track.stopped, true);
  } finally {
    mocks.restore();
  }
});
