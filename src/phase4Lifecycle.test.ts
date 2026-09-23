import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audio/audioEngine';
import { createDefaultProjectState } from './state/projectState';
import { createHistory } from './state/projectHistory';
import {
  deletePersistedAudioClip,
  deletePersistedProjectState,
  persistAudioClip,
} from './audio/audioPersistence';
import {
  hydrateProjectAudio,
  persistProjectState,
  restorePersistedProjectState,
} from './state/projectPersistence';
import type { MixerTrack, PlaylistClip, ProjectState } from './types/daw';

class MockAudioParam {
  value = 1;
  events: Array<{ type: string; value: number; time: number }> = [];

  constructor(defaultValue = 1) {
    this.value = defaultValue;
  }

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'setValueAtTime', value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'linearRampToValueAtTime', value, time });
  }

  exponentialRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'exponentialRampToValueAtTime', value, time });
  }

  setTargetAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'setTargetAtTime', value, time });
  }

  cancelScheduledValues(time: number): void {
    this.events = this.events.filter(event => event.time < time);
  }
}

class MockAudioNode {
  connect(target: unknown): unknown { return target; }
  disconnect(): void {}
  // Real AudioNode implements EventTarget; the transport controls clip
  // sources through 'ended' listeners.
  addEventListener(): void {}
}

class MockGainNode extends MockAudioNode {
  gain = new MockAudioParam();
}

class MockStereoPannerNode extends MockAudioNode {
  pan = new MockAudioParam();
}

class MockAnalyserNode extends MockAudioNode {
  fftSize = 512;
  smoothingTimeConstant = 0.8;
}

class MockBiquadFilterNode extends MockAudioNode {
  type = 'lowpass';
  frequency = new MockAudioParam();
  Q = new MockAudioParam();
  gain = new MockAudioParam();
}

class MockDelayNode extends MockAudioNode {
  delayTime = new MockAudioParam(0);
}

class MockConvolverNode extends MockAudioNode {
  buffer: any = null;
  normalize = true;
}

class MockWaveShaperNode extends MockAudioNode {
  curve: Float32Array | null = null;
  oversample = 'none';
}

class MockDynamicsCompressorNode extends MockAudioNode {
  threshold = new MockAudioParam(-24);
  knee = new MockAudioParam(30);
  ratio = new MockAudioParam(12);
  attack = new MockAudioParam(0.003);
  release = new MockAudioParam(0.25);
  reduction = 0;
}

class MockBufferSourceNode extends MockAudioNode {
  buffer: any = null;
  playbackRate = new MockAudioParam();
  detune = new MockAudioParam();
  startCalls: Array<{ when: number; offset: number; duration: number }> = [];

  start(when = 0, offset = 0, duration = 0): void {
    this.startCalls.push({ when, offset, duration });
  }

  stop(): void {}
}

class MockAudioBuffer {
  readonly numberOfChannels = 2;
  readonly sampleRate = 44100;
  readonly length: number;
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(length = 44100, amplitude = 0.25) {
    this.length = length;
    this.duration = length / this.sampleRate;
    this.channels = [new Float32Array(length), new Float32Array(length)];
    for (let i = 0; i < length; i += 1) {
      const sample = Math.sin((2 * Math.PI * 220 * i) / this.sampleRate) * amplitude;
      this.channels[0][i] = sample;
      this.channels[1][i] = sample;
    }
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel];
  }
}

class MockOfflineAudioContext {
  readonly destination = new MockAudioNode();
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels = 2;
  currentTime = 0;

  constructor(_channels: number, length: number, sampleRate: number) {
    this.length = length;
    this.sampleRate = sampleRate;
  }

  createGain(): MockGainNode { return new MockGainNode(); }
  createStereoPanner(): MockStereoPannerNode { return new MockStereoPannerNode(); }
  createAnalyser(): MockAnalyserNode { return new MockAnalyserNode(); }
  createBiquadFilter(): MockBiquadFilterNode { return new MockBiquadFilterNode(); }
  createBufferSource(): MockBufferSourceNode { return new MockBufferSourceNode(); }
  createOscillator(): any { return { connect: () => undefined, start: () => undefined, stop: () => undefined, frequency: new MockAudioParam(), detune: new MockAudioParam(), type: 'sine' }; }
  createDelay(): MockDelayNode { return new MockDelayNode(); }
  createConvolver(): MockConvolverNode { return new MockConvolverNode(); }
  createWaveShaper(): MockWaveShaperNode { return new MockWaveShaperNode(); }
  createDynamicsCompressor(): MockDynamicsCompressorNode { return new MockDynamicsCompressorNode(); }
  createBuffer(channels: number, length: number, sampleRate: number): MockAudioBuffer {
    return new MockAudioBuffer(Math.max(1, Math.min(length, sampleRate)), 0);
  }

  async startRendering(): Promise<MockAudioBuffer> {
    return new MockAudioBuffer(this.length, 0.25);
  }
}

class FakeRequest<T = unknown> {
  result!: T;
  onupgradeneeded: (() => void) | null = null;
  onsuccess: (() => void) | null = null;
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  constructor(private readonly store: Map<string, unknown>) {}
  objectStore(): FakeObjectStore { return new FakeObjectStore(this.store, this); }
  complete(): void { queueMicrotask(() => this.oncomplete?.()); }
}

class FakeObjectStore {
  constructor(private readonly store: Map<string, unknown>, private readonly tx: FakeTransaction) {}
  put(value: { id: string }): void { this.store.set(value.id, value); this.tx.complete(); }
  get(id: string): FakeRequest { const request = new FakeRequest(); request.result = this.store.get(id); queueMicrotask(() => request.onsuccess?.()); return request; }
  delete(id: string): void { this.store.delete(id); this.tx.complete(); }
  getAllKeys(): FakeRequest { const request = new FakeRequest(); request.result = [...this.store.keys()]; queueMicrotask(() => request.onsuccess?.()); return request; }
}

class FakeDb {
  readonly stores = new Map<string, Map<string, unknown>>([
    ['clips', new Map()],
    ['projects', new Map()],
  ]);
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createObjectStore(name: string): void { if (!this.stores.has(name)) this.stores.set(name, new Map()); }
  transaction(name: string): FakeTransaction {
    const store = this.stores.get(name);
    if (!store) throw new Error(`Missing fake object store: ${name}`);
    return new FakeTransaction(store);
  }
  close(): void {}
}

const installIndexedDbMock = () => {
  const db = new FakeDb();
  const previous = globalThis.indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: {
      open: () => {
        const request = new FakeRequest<FakeDb>();
        request.result = db;
        queueMicrotask(() => request.onupgradeneeded?.());
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    },
  });
  return () => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: previous });
};

const createLifecycleProject = () => {
  const state = createDefaultProjectState();
  const audioBufferId = 'phase4-lifecycle-audio';
  const clip: PlaylistClip = {
    id: 'phase4-audio-clip',
    trackIndex: 1,
    startBar: 0,
    lengthBars: 1,
    type: 'audio',
    audioBufferId,
    audioName: 'Lifecycle Audio',
    audioWaveform: [0.2, 0.6, 0.3],
    audioUnavailable: false,
    color: '#ff6e00',
    name: 'Lifecycle Audio',
  };
  const project: ProjectState = {
    ...state,
    meta: { ...state.meta, name: 'Phase 4 Lifecycle Test', bpm: 120 },
    playlistClips: [clip],
  };
  const mixerTracks: MixerTrack[] = project.mixerTracks.map(track => ({ ...track, fxSlots: [...track.fxSlots] }));
  return { project, audioBufferId, clip, mixerTracks };
};

let previousOfflineAudioContext: unknown;
let restoreIndexedDb: (() => void) | undefined;

beforeEach(() => {
  previousOfflineAudioContext = (globalThis as any).OfflineAudioContext;
  (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
  restoreIndexedDb = installIndexedDbMock();
});

afterEach(async () => {
  await deletePersistedProjectState().catch(() => undefined);
  await deletePersistedAudioClip('phase4-lifecycle-audio').catch(() => undefined);
  restoreIndexedDb?.();
  (globalThis as any).OfflineAudioContext = previousOfflineAudioContext;
  audioEngine.stop();
});

test('Phase 4.1 full lifecycle survives save/reload/hydration, undo/redo, and WAV export', async () => {
  const { project, audioBufferId, clip, mixerTracks } = createLifecycleProject();
  const sourceBlob = new Blob(['phase4-audio-data'], { type: 'audio/wav' });

  // CREATE + COMPOSE + ARRANGE
  const composed = {
    ...project,
    channels: project.channels.map(channel => ({
      ...channel,
      notes: [{ id: 'phase4-note', pitch: 60, start: 0, duration: 2, velocity: 0.9 }],
    })),
  };
  const history = createHistory(project).commit(composed, 'Compose test note');
  assert.equal(history.canUndo, true);
  assert.equal(history.present.channels[0].notes.length, 1);
  assert.equal(history.present.playlistClips[0].id, clip.id);

  // SAVE: binary audio is persisted separately from project state.
  await persistAudioClip(audioBufferId, sourceBlob);
  await persistProjectState(composed);

  // REOPEN + RESTORE: reconstruct project state and hydrate its audio reference.
  const restored = await restorePersistedProjectState({
    loadAudioFile: async (blob, id) => {
      assert.equal(id, audioBufferId);
      assert.equal(await blob.text(), 'phase4-audio-data');
      return { buffer: new MockAudioBuffer(44100, 0.25) as unknown as AudioBuffer, peaks: [0.2, 0.6, 0.3], duration: 1 };
    },
  }, createDefaultProjectState());

  assert.equal(restored.restored, true);
  assert.equal(restored.state.meta.name, 'Phase 4 Lifecycle Test');
  assert.equal(restored.state.channels[0].notes[0].pitch, 60);
  assert.equal(restored.state.playlistClips[0].audioUnavailable, false);
  assert.deepEqual(restored.missingAudioIds, []);

  // CONTINUE EDITING + UNDO/REDO after reload.
  const hydratedHistory = createHistory(restored.state);
  const edited = {
    ...restored.state,
    meta: { ...restored.state.meta, bpm: 128 },
  };
  const editedHistory = hydratedHistory.commit(edited, 'Change tempo');
  assert.equal(editedHistory.present.meta.bpm, 128);
  const undone = editedHistory.undo();
  assert.equal(undone.present.meta.bpm, 120);
  const redone = undone.redo();
  assert.equal(redone.present.meta.bpm, 128);

  // MIX/EXPORT: register the restored audio asset in the real engine and render WAV.
  audioEngine.setSampleBuffer(audioBufferId, new MockAudioBuffer(44100, 0.25) as unknown as AudioBuffer);
  const wav = await audioEngine.renderProjectToWav(
    redone.present.channels,
    redone.present.playlistClips,
    redone.present.meta.bpm,
    1,
    24,
    mixerTracks,
  );

  assert.ok(wav instanceof Blob);
  assert.ok(wav.size > 44, `Expected a non-empty WAV payload, got ${wav.size} bytes`);
  const bytes = new Uint8Array(await wav.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), 'WAVE');
  assert.equal(String.fromCharCode(...bytes.slice(36, 40)), 'data');

  // The WAV contains a real PCM/float payload, not only a header.
  const dataBytes = bytes.length - 44;
  assert.ok(dataBytes > 1000, `Expected rendered audio data, got ${dataBytes} bytes`);
});


test('Phase 11C persistence round trip survives a second edit/save/reopen and still exports', async () => {
  const { project, audioBufferId, clip } = createLifecycleProject();
  const sourceBlob = new Blob(['phase11c-audio-data'], { type: 'audio/wav' });

  const firstEdit: ProjectState = {
    ...project,
    meta: { ...project.meta, name: 'Phase 11C Round Trip', bpm: 122 },
    channels: project.channels.map((channel, index) =>
      index === 0
        ? { ...channel, notes: [{ id: 'phase11c-note', pitch: 64, start: 0, duration: 2, velocity: 0.8 }] }
        : channel
    ),
    mixerTracks: project.mixerTracks.map(track =>
      track.id === 1 ? { ...track, volume: 0.72, pan: -0.25, mute: false, solo: false } : track
    ),
    playlistClips: [{ ...clip, startBar: 2, lengthBars: 2 }],
  };

  await persistAudioClip(audioBufferId, sourceBlob);
  await persistProjectState(firstEdit);

  const firstReopen = await restorePersistedProjectState({
    loadAudioFile: async (blob, id) => {
      assert.equal(id, audioBufferId);
      assert.equal(await blob.text(), 'phase11c-audio-data');
      return { buffer: new MockAudioBuffer(44100, 0.25) as unknown as AudioBuffer, peaks: [0.2, 0.6, 0.3], duration: 1 };
    },
  }, createDefaultProjectState());

  assert.equal(firstReopen.restored, true);
  assert.equal(firstReopen.recovered, false);
  assert.deepEqual(firstReopen.missingAudioIds, []);
  assert.equal(firstReopen.state.meta.bpm, 122);
  assert.equal(firstReopen.state.channels[0].notes[0].pitch, 64);
  assert.equal(firstReopen.state.mixerTracks.find(track => track.id === 1)?.volume, 0.72);
  assert.equal(firstReopen.state.mixerTracks.find(track => track.id === 1)?.pan, -0.25);
  assert.equal(firstReopen.state.playlistClips[0].startBar, 2);

  // EDIT AFTER REOPEN, then save again. This catches a stale-state regression
  // where the first hydration succeeds but the second durable write loses data.
  const secondEdit: ProjectState = {
    ...firstReopen.state,
    meta: { ...firstReopen.state.meta, bpm: 128 },
    mixerTracks: firstReopen.state.mixerTracks.map(track =>
      track.id === 1 ? { ...track, volume: 0.61, pan: 0.2 } : track
    ),
    playlistClips: firstReopen.state.playlistClips.map(item => ({ ...item, startBar: 3 })),
  };
  await persistProjectState(secondEdit);

  const secondReopen = await restorePersistedProjectState({
    loadAudioFile: async (blob, id) => {
      assert.equal(id, audioBufferId);
      assert.equal(await blob.text(), 'phase11c-audio-data');
      return { buffer: new MockAudioBuffer(44100, 0.25) as unknown as AudioBuffer, peaks: [0.2, 0.6, 0.3], duration: 1 };
    },
  }, createDefaultProjectState());

  assert.equal(secondReopen.restored, true);
  assert.equal(secondReopen.recovered, false);
  assert.deepEqual(secondReopen.missingAudioIds, []);
  assert.equal(secondReopen.state.meta.bpm, 128);
  assert.equal(secondReopen.state.mixerTracks.find(track => track.id === 1)?.volume, 0.61);
  assert.equal(secondReopen.state.mixerTracks.find(track => track.id === 1)?.pan, 0.2);
  assert.equal(secondReopen.state.playlistClips[0].startBar, 3);
  assert.equal(secondReopen.state.playlistClips[0].audioUnavailable, false);

  // The state that survived two save/reopen cycles must still be renderable.
  audioEngine.setSampleBuffer(audioBufferId, new MockAudioBuffer(44100, 0.25) as unknown as AudioBuffer);
  const wav = await audioEngine.renderProjectToWav(
    secondReopen.state.channels,
    secondReopen.state.playlistClips,
    secondReopen.state.meta.bpm,
    1,
    24,
    secondReopen.state.mixerTracks,
  );

  assert.ok(wav instanceof Blob);
  assert.ok(wav.size > 44);
  const bytes = new Uint8Array(await wav.arrayBuffer());
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), 'WAVE');
  assert.equal(String.fromCharCode(...bytes.slice(36, 40)), 'data');
  assert.ok(bytes.length - 44 > 1000);
});
