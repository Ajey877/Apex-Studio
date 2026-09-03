import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProjectState } from './projectState';
import { getPersistedAudioClip, deletePersistedAudioClip, deletePersistedProjectState, persistAudioClip } from '../audio/audioPersistence';
import { persistProjectState, restorePersistedProjectState, serializeProjectState } from './projectPersistence';
import type { AudioRecording, PlaylistClip } from '../types/daw';

class FakeRequest<T = unknown> {
  result!: T;
  error: Error | null = null;
  onupgradeneeded: (() => void) | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor(private readonly store: Map<string, unknown>) {}
  objectStore(): FakeObjectStore { return new FakeObjectStore(this.store, this); }
  complete(): void { queueMicrotask(() => this.oncomplete?.()); }
}

class FakeObjectStore {
  constructor(private readonly store: Map<string, unknown>, private readonly tx: FakeTransaction) {}
  put(value: { id: string }): void { this.store.set(value.id, value); this.tx.complete(); }
  get(id: string): FakeRequest { const request = new FakeRequest(); request.result = this.store.get(id); queueMicrotask(() => request.onsuccess?.()); return request; }
  delete(id: string): void { this.store.delete(id); this.tx.complete(); }
}

class FakeDb {
  readonly stores = new Map<string, Map<string, unknown>>([
    ['clips', new Map()],
    ['projects', new Map()]
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

const createRecordingProject = () => {
  const state = createDefaultProjectState();
  const audioBufferId = 'recording-rec-roundtrip';
  const recording: AudioRecording = {
    id: 'rec-roundtrip',
    name: 'Round Trip Take',
    timestamp: 1234,
    durationSeconds: 3.5,
    waveform: [0.1, 0.8, 0.2],
    audioBufferId,
    audioBlob: new Blob(['binary-audio'], { type: 'audio/webm' }),
    audioUrl: 'blob:session-only'
  };
  const clip: PlaylistClip = {
    id: 'rec-clip-roundtrip',
    trackIndex: 1,
    startBar: 4,
    lengthBars: 2,
    type: 'audio',
    audioBufferId,
    audioName: recording.name,
    audioWaveform: recording.waveform,
    audioUnavailable: false,
    color: '#ff6e00',
    name: recording.name
  };
  return {
    state: {
      ...state,
      recordings: [recording],
      playlistClips: [clip]
    },
    recording,
    clip,
    audioBufferId
  };
};

test('project state persistence round trip keeps recording metadata and playlist clip references', async () => {
  const restore = installIndexedDbMock();
  try {
    const { state, recording, clip } = createRecordingProject();
    const serialized = serializeProjectState(state);

    assert.equal(serialized.includes('binary-audio'), false);
    assert.equal(serialized.includes('blob:session-only'), false);

    await persistProjectState(state);
    const restored = await restorePersistedProjectState({
      loadAudioFile: async () => ({ buffer: { duration: 3.5 } as AudioBuffer, peaks: recording.waveform, duration: 3.5 })
    }, createDefaultProjectState());

    assert.equal(restored.restored, true);
    assert.equal(restored.state.recordings[0].id, recording.id);
    assert.equal(restored.state.recordings[0].name, recording.name);
    assert.equal(restored.state.recordings[0].timestamp, recording.timestamp);
    assert.equal(restored.state.recordings[0].durationSeconds, recording.durationSeconds);
    assert.deepEqual(restored.state.recordings[0].waveform, recording.waveform);
    assert.equal(restored.state.recordings[0].audioBufferId, recording.audioBufferId);
    assert.equal(restored.state.playlistClips[0].id, clip.id);
    assert.equal(restored.state.playlistClips[0].audioBufferId, clip.audioBufferId);
    assert.equal(restored.state.playlistClips[0].trackIndex, clip.trackIndex);
    assert.equal(restored.state.playlistClips[0].startBar, clip.startBar);
    assert.equal(restored.state.playlistClips[0].lengthBars, clip.lengthBars);
  } finally {
    await deletePersistedProjectState().catch(() => undefined);
    await deletePersistedAudioClip('recording-rec-roundtrip').catch(() => undefined);
    restore();
  }
});

test('full recording persistence lifecycle stores Blob separately and re-registers it after project recreation', async () => {
  const restore = installIndexedDbMock();
  try {
    const { state, recording, audioBufferId } = createRecordingProject();
    const blob = recording.audioBlob!;
    await persistAudioClip(audioBufferId, blob);
    await persistProjectState(state);

    const registrations: string[] = [];
    const restored = await restorePersistedProjectState({
      loadAudioFile: async (loadedBlob, id) => {
        registrations.push(id);
        assert.equal(await loadedBlob.text(), 'binary-audio');
        return { buffer: { duration: recording.durationSeconds } as AudioBuffer, peaks: recording.waveform, duration: recording.durationSeconds };
      }
    }, createDefaultProjectState());

    assert.equal(restored.restored, true);
    assert.deepEqual(registrations, [audioBufferId]);
    assert.deepEqual(restored.hydratedAudioIds, [audioBufferId]);
    assert.equal(restored.missingAudioIds.length, 0);
    assert.ok(restored.state.recordings[0].audioBlob);
    assert.equal(await getPersistedAudioClip(audioBufferId)?.then(value => value?.text()), 'binary-audio');
    assert.equal(restored.state.playlistClips[0].audioUnavailable, false);
  } finally {
    await deletePersistedProjectState().catch(() => undefined);
    await deletePersistedAudioClip('recording-rec-roundtrip').catch(() => undefined);
    restore();
  }
});

test('missing audio asset does not prevent project restoration and marks the clip unavailable', async () => {
  const restore = installIndexedDbMock();
  try {
    const { state, audioBufferId } = createRecordingProject();
    await persistProjectState(state);

    const restored = await restorePersistedProjectState({
      loadAudioFile: async () => ({ buffer: { duration: 1 } as AudioBuffer, peaks: [], duration: 1 })
    }, createDefaultProjectState());

    assert.equal(restored.restored, true);
    assert.deepEqual(restored.missingAudioIds, [audioBufferId]);
    assert.equal(restored.state.recordings[0].audioBufferId, audioBufferId);
    assert.equal(restored.state.recordings[0].audioBlob, undefined);
    assert.equal(restored.state.playlistClips[0].audioUnavailable, true);
  } finally {
    await deletePersistedProjectState().catch(() => undefined);
    await deletePersistedAudioClip(audioBufferId).catch(() => undefined);
    restore();
  }
});
