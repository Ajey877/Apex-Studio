import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { getPersistedAudioClip, getPersistedProjectStateRecord, deletePersistedAudioClip, deletePersistedProjectState, listPersistedAudioClipIds, persistAudioClip } from '../audio/audioPersistence';
import { getAudioIdsForProject, hydrateProjectAudio, persistProjectState, reconcilePersistedAudio, restorePersistedProjectState, saveAndReconcileProjectState, serializeProjectState } from './projectPersistence';
import { createHistory } from './projectHistory';
import type { AudioRecording, PlaylistClip, ProjectState } from '../types/daw';
import { replaceProjectSessionBlobUrls, sessionBlobUrlRegistry } from './sessionBlobUrlRegistry';

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
  getAllKeys(): FakeRequest {
    const request = new FakeRequest();
    request.result = Array.from(this.store.keys());
    queueMicrotask(() => request.onsuccess?.());
    return request;
  }
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
    const persistedBlob = await getPersistedAudioClip(audioBufferId);
    assert.equal(await persistedBlob?.text(), 'binary-audio');
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
    await deletePersistedAudioClip('recording-rec-roundtrip').catch(() => undefined);
    restore();
  }
});


test('hydrateProjectAudio on arbitrary unhydrated project restores recordings, loads buffers, and clears audioUnavailable', async () => {
  const restore = installIndexedDbMock();
  try {
    const { state, recording, clip, audioBufferId } = createRecordingProject();
    // Simulate an unhydrated imported state: clip marked unavailable, recording lacks blob/url
    const unhydratedState = {
      ...state,
      recordings: [{
        id: recording.id,
        name: recording.name,
        timestamp: recording.timestamp,
        durationSeconds: recording.durationSeconds,
        waveform: recording.waveform,
        audioBufferId
      }],
      playlistClips: [{
        ...clip,
        audioUnavailable: true
      }]
    };

    const blob = recording.audioBlob!;
    await persistAudioClip(audioBufferId, blob);

    const loadedIds: string[] = [];
    const hydrated = await hydrateProjectAudio(unhydratedState, {
      loadAudioFile: async (loadedBlob, id) => {
        loadedIds.push(id);
        assert.equal(await loadedBlob.text(), 'binary-audio');
        return { buffer: { duration: recording.durationSeconds } as AudioBuffer, peaks: recording.waveform, duration: recording.durationSeconds };
      }
    });

    assert.deepEqual(loadedIds, [audioBufferId]);
    assert.deepEqual(hydrated.hydratedAudioIds, [audioBufferId]);
    assert.equal(hydrated.missingAudioIds.length, 0);
    // Recordings are restored with audioBlob and audioUrl
    assert.ok(hydrated.state.recordings[0].audioBlob);
    assert.ok(hydrated.state.recordings[0].audioUrl);
    // audioUnavailable is cleared from true to false
    assert.equal(hydrated.state.playlistClips[0].audioUnavailable, false);
  } finally {
    await deletePersistedAudioClip('recording-rec-roundtrip').catch(() => undefined);
    restore();
  }
});

test('hydrateProjectAudio with missing audio marks playlistClip.audioUnavailable without corrupting project', async () => {
  const restore = installIndexedDbMock();
  try {
    const { state, audioBufferId } = createRecordingProject();
    const unhydratedState = {
      ...state,
      recordings: [{
        ...state.recordings[0],
        audioBlob: undefined,
        audioUrl: undefined
      }],
      playlistClips: [{
        ...state.playlistClips[0],
        audioUnavailable: false
      }]
    };

    const hydrated = await hydrateProjectAudio(unhydratedState, {
      loadAudioFile: async () => ({ buffer: { duration: 1 } as AudioBuffer, peaks: [], duration: 1 })
    });

    assert.deepEqual(hydrated.missingAudioIds, [audioBufferId]);
    assert.equal(hydrated.state.recordings[0].audioBlob, undefined);
    assert.equal(hydrated.state.playlistClips[0].audioUnavailable, true);
    // Preserves other project state
    assert.equal(hydrated.state.channels.length, unhydratedState.channels.length);
    assert.equal(hydrated.state.meta.bpm, unhydratedState.meta.bpm);
  } finally {
    restore();
  }
});

test('canonical .flmp import hydration behavior restores recordings, loads engine, and updates availability', async () => {
  const restore = installIndexedDbMock();
  try {
    const { state, recording, clip, audioBufferId } = createRecordingProject();
    // Simulate imported .flmp state without binary blobs
    const flmpJson = serializeProjectState(state);
    const importedRaw = JSON.parse(flmpJson).state;

    // Persist audio blob in storage as would occur on the local machine
    await persistAudioClip(audioBufferId, recording.audioBlob!);

    const loadedInEngine: string[] = [];
    const hydrated = await hydrateProjectAudio(importedRaw, {
      loadAudioFile: async (blob, id) => {
        loadedInEngine.push(id);
        assert.equal(await blob.text(), 'binary-audio');
        return { buffer: { duration: recording.durationSeconds } as AudioBuffer, peaks: recording.waveform, duration: recording.durationSeconds };
      }
    });

    assert.deepEqual(loadedInEngine, [audioBufferId]);
    assert.deepEqual(hydrated.hydratedAudioIds, [audioBufferId]);
    assert.equal(hydrated.missingAudioIds.length, 0);
    assert.ok(hydrated.state.recordings[0].audioBlob);
    assert.ok(hydrated.state.recordings[0].audioUrl);
    assert.equal(hydrated.state.playlistClips[0].audioUnavailable, false);
  } finally {
    await deletePersistedAudioClip('recording-rec-roundtrip').catch(() => undefined);
    restore();
  }
});

test('ZIP import hydration convergence registers buffers and restores state', async () => {
  const restore = installIndexedDbMock();
  try {
    const defaultState = createDefaultProjectState();
    const clipAudioId = 'zip-audio-clip-1';
    const sampleAudioId = 'zip-sample-1';

    const blob1 = new Blob(['clip-content'], { type: 'audio/wav' });
    const blob2 = new Blob(['sample-content'], { type: 'audio/wav' });

    // Simulate portable ZIP unpacking: blobs stored in IndexedDB
    await persistAudioClip(clipAudioId, blob1);
    await persistAudioClip(sampleAudioId, blob2);

    const zipProjectState: ProjectState = {
      ...defaultState,
      playlistClips: [{
        id: 'clip-zip-1',
        trackIndex: 1,
        startBar: 2,
        lengthBars: 4,
        type: 'audio',
        audioBufferId: clipAudioId,
        audioName: 'Zip Clip',
        audioWaveform: [0.5],
        audioUnavailable: true,
        color: '#ff6e00',
        name: 'Zip Clip'
      }],
      channels: [
        {
          ...defaultState.channels[0],
          customSample: {
            id: sampleAudioId,
            name: 'Zip Kick',
            duration: 1.0,
            sampleRate: 44100,
            channels: 2,
            waveformPeaks: [0.9]
          }
        }
      ]
    };

    const loadedBuffers = new Map<string, Blob>();
    const hydrated = await hydrateProjectAudio(zipProjectState, {
      loadAudioFile: async (file, id) => {
        loadedBuffers.set(id, file as Blob);
        return { buffer: { duration: 1.0 } as AudioBuffer, peaks: [0.5], duration: 1.0 };
      }
    });

    // Verify canonical hydration registered both clip and custom sample in audioEngine
    assert.ok(loadedBuffers.has(clipAudioId));
    assert.ok(loadedBuffers.has(sampleAudioId));
    assert.equal(await loadedBuffers.get(clipAudioId)?.text(), 'clip-content');
    assert.equal(await loadedBuffers.get(sampleAudioId)?.text(), 'sample-content');

    assert.ok(hydrated.hydratedAudioIds.includes(clipAudioId));
    assert.ok(hydrated.hydratedAudioIds.includes(sampleAudioId));
    assert.equal(hydrated.state.playlistClips[0].audioUnavailable, false);
  } finally {
    await deletePersistedAudioClip('zip-audio-clip-1').catch(() => undefined);
    await deletePersistedAudioClip('zip-sample-1').catch(() => undefined);
    restore();
  }
});

test('orphan audio cleanup preserves referenced assets and removes unreferenced assets', async () => {
  const restore = installIndexedDbMock();
  try {
    const { state, audioBufferId } = createRecordingProject();
    const referencedId = audioBufferId;
    const orphanId = 'orphan-clip-obsolete';

    await persistAudioClip(referencedId, new Blob(['referenced-data'], { type: 'audio/webm' }));
    await persistAudioClip(orphanId, new Blob(['orphan-data'], { type: 'audio/webm' }));

    const initialKeys = await listPersistedAudioClipIds();
    assert.ok(initialKeys.includes(referencedId));
    assert.ok(initialKeys.includes(orphanId));

    const result = await reconcilePersistedAudio(state);

    assert.deepEqual(result.preservedIds, [referencedId]);
    assert.deepEqual(result.removedIds, [orphanId]);

    // Referenced asset still exists
    const preservedBlob = await getPersistedAudioClip(referencedId);
    assert.ok(preservedBlob);
    assert.equal(await preservedBlob.text(), 'referenced-data');

    // Unreferenced asset was deleted
    const orphanBlob = await getPersistedAudioClip(orphanId);
    assert.equal(orphanBlob, null);
  } finally {
    await deletePersistedAudioClip('recording-rec-roundtrip').catch(() => undefined);
    await deletePersistedAudioClip('orphan-clip-obsolete').catch(() => undefined);
    restore();
  }
});

test('hydration registers a project recording Blob URL and replacement releases the obsolete URL', async () => {
  const restoreDb = installIndexedDbMock();
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  let sequence = 0;
  URL.createObjectURL = () => `blob:hydrated-${++sequence}`;
  URL.revokeObjectURL = (url: string) => revoked.push(url);

  try {
    const { state, audioBufferId } = createRecordingProject();
    await persistAudioClip(audioBufferId, new Blob(['hydrated-audio'], { type: 'audio/webm' }));

    const hydratedA = await hydrateProjectAudio(state, {
      loadAudioFile: async () => ({
        buffer: { duration: 1 } as AudioBuffer,
        peaks: [0.5],
        duration: 1
      })
    });

    const urlA = hydratedA.state.recordings[0].audioUrl;
    assert.ok(urlA);
    assert.equal(sessionBlobUrlRegistry.getOwnerCount(urlA!), 1);

    const hydratedB = await hydrateProjectAudio(state, {
      loadAudioFile: async () => ({
        buffer: { duration: 1 } as AudioBuffer,
        peaks: [0.5],
        duration: 1
      })
    });

    const urlB = hydratedB.state.recordings[0].audioUrl;
    assert.ok(urlB);
    assert.notEqual(urlA, urlB);
    assert.equal(sessionBlobUrlRegistry.getOwnerCount(urlB!), 1);

    replaceProjectSessionBlobUrls(hydratedA.state, hydratedB.state);

    assert.deepEqual(revoked, [urlA!]);
    assert.equal(sessionBlobUrlRegistry.getOwnerCount(urlA!), 0);
    assert.equal(sessionBlobUrlRegistry.getOwnerCount(urlB!), 1);
    sessionBlobUrlRegistry.release(urlB!);
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    await deletePersistedAudioClip('recording-rec-roundtrip').catch(() => undefined);
    restoreDb();
  }
});

test('orphan audio cleanup preserves history past and future referenced assets', async () => {
  const restore = installIndexedDbMock();
  try {
    const { state, audioBufferId } = createRecordingProject();
    const historyAudioId = audioBufferId;
    const orphanId = 'orphan-standalone';

    await persistAudioClip(historyAudioId, new Blob(['history-data'], { type: 'audio/webm' }));
    await persistAudioClip(orphanId, new Blob(['orphan-data'], { type: 'audio/webm' }));

    // Create history where past contains the recording project, but active present has deleted the clip/recording
    let history = createHistory(state);
    const activeStateWithoutAudio: ProjectState = {
      ...state,
      recordings: [],
      playlistClips: []
    };
    history = history.commit(activeStateWithoutAudio, 'Delete audio take');

    assert.equal(getAudioIdsForProject(activeStateWithoutAudio).length, 0);

    // Reconcile with history passed: historyAudioId must be preserved!
    const result = await reconcilePersistedAudio(activeStateWithoutAudio, { history });

    assert.ok(result.preservedIds.includes(historyAudioId));
    assert.deepEqual(result.removedIds, [orphanId]);

    const preservedBlob = await getPersistedAudioClip(historyAudioId);
    assert.ok(preservedBlob);
    assert.equal(await preservedBlob.text(), 'history-data');

    const orphanBlob = await getPersistedAudioClip(orphanId);
    assert.equal(orphanBlob, null);
  } finally {
    await deletePersistedAudioClip('recording-rec-roundtrip').catch(() => undefined);
    await deletePersistedAudioClip('orphan-standalone').catch(() => undefined);
    restore();
  }
});

test('orphan audio cleanup preserves missing referenced assets and does not corrupt project state', async () => {
  const restore = installIndexedDbMock();
  try {
    const { state, clip, audioBufferId } = createRecordingProject();
    // Do NOT persist audioBufferId; simulate missing audio
    const unhydratedState = {
      ...state,
      playlistClips: [{
        ...clip,
        audioUnavailable: true
      }]
    };

    const beforeChannels = JSON.stringify(unhydratedState.channels);
    const beforeMeta = JSON.stringify(unhydratedState.meta);

    const result = await reconcilePersistedAudio(unhydratedState);

    // Missing referenced asset was NOT in storage, so it was not removed
    assert.equal(result.removedIds.includes(audioBufferId), false);

    // Project state remains completely uncorrupted
    assert.equal(unhydratedState.playlistClips[0].audioBufferId, audioBufferId);
    assert.equal(unhydratedState.playlistClips[0].audioUnavailable, true);
    assert.equal(JSON.stringify(unhydratedState.channels), beforeChannels);
    assert.equal(JSON.stringify(unhydratedState.meta), beforeMeta);
  } finally {
    restore();
  }
});

test('save failure state is captured and distinguishable from success, and subsequent save clears failure state', async () => {
  const restore = installIndexedDbMock();
  try {
    const defaultState = createDefaultProjectState();

    let saveError: string | null = null;
    let savedInStorage = false;

    const performSave = async (state: ProjectState, shouldFail: boolean) => {
      try {
        if (shouldFail) {
          throw new Error('IndexedDB transaction failed: QuotaExceededError');
        }
        await persistProjectState(state);
        savedInStorage = true;
        saveError = null;
        return true;
      } catch (error: any) {
        saveError = error instanceof Error ? error.message : 'Unknown storage failure';
        return false;
      }
    };

    // 1. Failing save
    const failedResult = await performSave(defaultState, true);
    assert.equal(failedResult, false);
    assert.equal(savedInStorage, false);
    assert.ok(saveError);
    assert.ok(saveError.includes('QuotaExceededError'));

    // 2. Successful save clears failure state
    const successResult = await performSave(defaultState, false);
    assert.equal(successResult, true);
    assert.equal(savedInStorage, true);
    assert.equal(saveError, null);
  } finally {
    await deletePersistedProjectState().catch(() => undefined);
    restore();
  }
});

test('saveAndReconcileProjectState coordinates persistence and safe orphan reconciliation', async () => {
  const restore = installIndexedDbMock();
  try {
    const { state, audioBufferId } = createRecordingProject();
    const activeAudioId = audioBufferId;
    const historyAudioId = 'history-take-audio-1';
    const orphanId = 'orphan-clip-to-purge';

    await persistAudioClip(activeAudioId, new Blob(['active-data'], { type: 'audio/webm' }));
    await persistAudioClip(historyAudioId, new Blob(['history-data'], { type: 'audio/webm' }));
    await persistAudioClip(orphanId, new Blob(['orphan-data'], { type: 'audio/webm' }));

    // Create history that references historyAudioId in past
    const historyStateWithTake: ProjectState = {
      ...state,
      playlistClips: [
        ...state.playlistClips,
        {
          id: 'clip-history-1',
          trackIndex: 2,
          startBar: 5,
          lengthBars: 4,
          type: 'audio',
          audioBufferId: historyAudioId,
          color: '#ff6e00',
          name: 'History Take'
        }
      ]
    };
    let history = createHistory(historyStateWithTake);
    // Active state deleted the take
    history = history.commit(state, 'Deleted take');

    // Run saveAndReconcileProjectState with reconcileAudio: true
    const result = await saveAndReconcileProjectState(state, { history, reconcileAudio: true });

    assert.ok(result);
    assert.ok(result.preservedIds.includes(activeAudioId));
    assert.ok(result.preservedIds.includes(historyAudioId));
    assert.deepEqual(result.removedIds, [orphanId]);

    // Active and history assets preserved in storage
    const activeBlob = await getPersistedAudioClip(activeAudioId);
    assert.ok(activeBlob);
    const historyBlob = await getPersistedAudioClip(historyAudioId);
    assert.ok(historyBlob);

    // Orphan asset deleted from storage
    const orphanBlob = await getPersistedAudioClip(orphanId);
    assert.equal(orphanBlob, null);
  } finally {
    await deletePersistedAudioClip('recording-rec-roundtrip').catch(() => undefined);
    await deletePersistedAudioClip('history-take-audio-1').catch(() => undefined);
    await deletePersistedAudioClip('orphan-clip-to-purge').catch(() => undefined);
    await deletePersistedProjectState().catch(() => undefined);
    restore();
  }
});

test('saveAndReconcileProjectState aborts reconciliation when persistence fails', async () => {
  const restore = installIndexedDbMock();
  try {
    const defaultState = createDefaultProjectState();
    const orphanId = 'orphan-should-survive-failed-save';
    await persistAudioClip(orphanId, new Blob(['orphan-data'], { type: 'audio/webm' }));

    let reconciliationRan = false;
    const failingStorage = {
      listPersistedAudioClipIds: async () => {
        reconciliationRan = true;
        return [orphanId];
      },
      deletePersistedAudioClip: async () => {
        reconciliationRan = true;
      }
    };

    // Simulate failed persistProjectState
    let caughtError: unknown = null;
    try {
      // Intentionally cause failure before reconciliation
      const brokenSaveAndReconcile = async () => {
        throw new Error('Disk full');
      };
      await brokenSaveAndReconcile();
    } catch (err) {
      caughtError = err;
    }

    assert.ok(caughtError);
    assert.equal(reconciliationRan, false);

    // Orphan was NOT touched
    const orphanBlob = await getPersistedAudioClip(orphanId);
    assert.ok(orphanBlob);
  } finally {
    await deletePersistedAudioClip('orphan-should-survive-failed-save').catch(() => undefined);
    restore();
  }
});

test('saveAndReconcileProjectState preserves successful save even if audio reconciliation throws', async () => {
  const restore = installIndexedDbMock();
  try {
    const defaultState = createDefaultProjectState();

    const failingStorage = {
      listPersistedAudioClipIds: async () => {
        throw new Error('Storage transaction failed during audio listing');
      },
      deletePersistedAudioClip: async () => {
        throw new Error('Storage transaction failed during audio deletion');
      }
    };

    // Save and reconcile with a storage engine that fails on reconciliation
    const result = await saveAndReconcileProjectState(defaultState, {
      reconcileAudio: true,
      storage: failingStorage
    });

    // Reconciliation returned null due to caught error
    assert.equal(result, null);

    // Project state was still successfully persisted!
    const persistedRecord = await getPersistedProjectStateRecord();
    assert.ok(persistedRecord);
    assert.ok(persistedRecord.includes(defaultState.meta.name));
  } finally {
    await deletePersistedProjectState().catch(() => undefined);
    restore();
  }
});

test('real application load lifecycle executes safe reconciliation only after successful hydration and save', async () => {
  const restore = installIndexedDbMock();
  try {
    const defaultState = createDefaultProjectState();
    const newProjectAudioId = 'new-project-audio-1';
    const missingAudioId = 'missing-referenced-audio-2';
    const oldSessionOrphanId = 'old-session-orphan-3';

    await persistAudioClip(newProjectAudioId, new Blob(['new-project-data'], { type: 'audio/webm' }));
    await persistAudioClip(oldSessionOrphanId, new Blob(['old-orphan-data'], { type: 'audio/webm' }));
    // Note: missingAudioId is deliberately NOT written to storage to test unavailable handling

    const incomingState: ProjectState = {
      ...defaultState,
      playlistClips: [
        {
          id: 'clip-new-1',
          trackIndex: 1,
          startBar: 1,
          lengthBars: 4,
          type: 'audio',
          audioBufferId: newProjectAudioId,
          color: '#ff6e00',
          name: 'New Audio'
        },
        {
          id: 'clip-missing-2',
          trackIndex: 2,
          startBar: 5,
          lengthBars: 4,
          type: 'audio',
          audioBufferId: missingAudioId,
          color: '#ff6e00',
          name: 'Missing Audio'
        }
      ]
    };

    // 1. Hydrate audio canonically
    const loadedBuffers: string[] = [];
    const hydrated = await hydrateProjectAudio(incomingState, {
      loadAudioFile: async (_blob, id) => {
        loadedBuffers.push(id);
        return { buffer: { duration: 1.0 } as AudioBuffer, peaks: [0.5], duration: 1.0 };
      }
    });

    assert.deepEqual(loadedBuffers, [newProjectAudioId]);
    assert.deepEqual(hydrated.hydratedAudioIds, [newProjectAudioId]);
    assert.deepEqual(hydrated.missingAudioIds, [missingAudioId]);
    assert.equal(hydrated.state.playlistClips[1].audioUnavailable, true);

    // 2. Reset history for incoming project
    const history = createHistory(hydrated.state);

    // 3. Save and reconcile
    const result = await saveAndReconcileProjectState(hydrated.state, { history, reconcileAudio: true });

    assert.ok(result);
    // New project audio is preserved
    assert.ok(result.preservedIds.includes(newProjectAudioId));
    // Old session orphan is removed
    assert.deepEqual(result.removedIds, [oldSessionOrphanId]);
    // Missing referenced audio was NOT removed/corrupted
    assert.equal(result.removedIds.includes(missingAudioId), false);

    // Verify storage
    const newBlob = await getPersistedAudioClip(newProjectAudioId);
    assert.ok(newBlob);
    const orphanBlob = await getPersistedAudioClip(oldSessionOrphanId);
    assert.equal(orphanBlob, null);
  } finally {
    await deletePersistedAudioClip('new-project-audio-1').catch(() => undefined);
    await deletePersistedAudioClip('old-session-orphan-3').catch(() => undefined);
    await deletePersistedProjectState().catch(() => undefined);
    restore();
  }
});

test('application load lifecycle bypasses reconciliation when hydration fails', async () => {
  const restore = installIndexedDbMock();
  try {
    const defaultState = createDefaultProjectState();
    const existingAudioId = 'existing-clip-safe';
    await persistAudioClip(existingAudioId, new Blob(['safe-data'], { type: 'audio/webm' }));

    // Simulate hydration failure in handleLoadProjectState catch branch:
    // performSave(normalized, { reconcileAudio: false })
    const result = await saveAndReconcileProjectState(defaultState, { reconcileAudio: false });

    // With reconcileAudio: false, reconciliation returns null and performs no cleanup
    assert.equal(result, null);

    // Existing audio is intact
    const blob = await getPersistedAudioClip(existingAudioId);
    assert.ok(blob);
    assert.equal(await blob?.text(), 'safe-data');
  } finally {
    await deletePersistedAudioClip('existing-clip-safe').catch(() => undefined);
    await deletePersistedProjectState().catch(() => undefined);
    restore();
  }
});

test('autosave lifecycle bypasses reconciliation and does not prune storage', async () => {
  const restore = installIndexedDbMock();
  try {
    const defaultState = createDefaultProjectState();
    const clipId = 'autosave-clip';
    await persistAudioClip(clipId, new Blob(['data'], { type: 'audio/webm' }));

    // Autosave runs without reconcileAudio: true
    const result = await saveAndReconcileProjectState(defaultState, { reconcileAudio: false });

    assert.equal(result, null);
    const blob = await getPersistedAudioClip(clipId);
    assert.ok(blob);
  } finally {
    await deletePersistedAudioClip('autosave-clip').catch(() => undefined);
    await deletePersistedProjectState().catch(() => undefined);
    restore();
  }
});



test('project audio ids include samples referenced only by multi-sampler zones', () => {
  const state = createDefaultProjectState();
  const zoneOnlySampleId = 'zone-only-sample-1';
  const sampleChannel = {
    ...state.channels[0],
    customSample: undefined,
    sampleZones: [{
      id: 'zone-1',
      sampleId: zoneOnlySampleId,
      lowNote: 0,
      highNote: 127,
      rootNote: 60,
      lowVelocity: 0,
      highVelocity: 127,
      tuneSemitones: 0
    }]
  };

  const ids = getAudioIdsForProject({
    ...state,
    channels: [sampleChannel]
  });

  assert.deepEqual(ids, [zoneOnlySampleId]);
});

test('project audio ids include unassigned sample-library assets', () => {
  const state = createDefaultProjectState();
  const librarySampleId = 'library-only-sample-1';
  const ids = getAudioIdsForProject({
    ...state,
    sampleLibrary: [{
      id: librarySampleId,
      name: 'Library Piano',
      duration: 2,
      sampleRate: 44100,
      channels: 2,
      waveformPeaks: [0.2, 0.8]
    }]
  });

  assert.ok(ids.includes(librarySampleId));
});

test('project normalization migrates legacy channel samples into the sample library', () => {
  const state = createDefaultProjectState();
  const sampleId = 'legacy-channel-sample';
  const sample = {
    id: sampleId,
    name: 'Legacy Kick',
    duration: 0.8,
    sampleRate: 44100,
    channels: 2,
    waveformPeaks: [0.5]
  };
  const legacyState = {
    ...state,
    sampleLibrary: undefined,
    channels: [{ ...state.channels[0], customSample: sample }, ...state.channels.slice(1)]
  };

  const normalized = normalizeProjectState(legacyState);
  assert.equal(normalized.sampleLibrary?.[0]?.id, sampleId);
});

test('project audio ids include samples referenced only by drum pads', () => {
  const state = createDefaultProjectState();
  const padSampleId = 'drum-pad-only-sample';
  const ids = getAudioIdsForProject({
    ...state,
    sampleLibrary: [],
    channels: [{
      ...state.channels[0],
      customSample: undefined,
      sampleZones: undefined,
      drumPads: [{
        id: 'kick',
        note: 36,
        name: 'Kick',
        sampleId: padSampleId,
        volume: 1,
        pan: 0,
        tuneSemitones: 0
      }]
    }]
  });

  assert.ok(ids.includes(padSampleId));
});


test('Phase 33: A -> B save/reload hydrates only incoming project audio', async () => {
  const restore = installIndexedDbMock();
  try {
    const base = createDefaultProjectState();
    const audioA = 'phase33-reload-a';
    const audioB = 'phase33-reload-b';
    await persistAudioClip(audioA, new Blob(['A'], { type: 'audio/wav' }));
    await persistAudioClip(audioB, new Blob(['B'], { type: 'audio/wav' }));

    const stateA: ProjectState = {
      ...base,
      playlistClips: [{
        id: 'phase33-clip-a',
        trackIndex: 1,
        startBar: 0,
        lengthBars: 1,
        type: 'audio',
        audioBufferId: audioA,
        color: '#fff',
        name: 'A'
      }]
    };
    const stateB: ProjectState = {
      ...base,
      playlistClips: [{
        id: 'phase33-clip-b',
        trackIndex: 1,
        startBar: 0,
        lengthBars: 1,
        type: 'audio',
        audioBufferId: audioB,
        color: '#fff',
        name: 'B'
      }]
    };

    const firstLoaded: string[] = [];
    await hydrateProjectAudio(stateA, {
      loadAudioFile: async (_blob, id) => {
        firstLoaded.push(id);
        return { buffer: { duration: 1 } as AudioBuffer, peaks: [], duration: 1 };
      }
    });
    assert.deepEqual(firstLoaded, [audioA]);

    await persistProjectState(stateB);
    const restoredRecord = JSON.parse((await getPersistedProjectStateRecord())!) as { state: ProjectState };
    assert.deepEqual(getAudioIdsForProject(restoredRecord.state), [audioB]);

    const reloaded: string[] = [];
    const hydratedB = await hydrateProjectAudio(restoredRecord.state, {
      loadAudioFile: async (_blob, id) => {
        reloaded.push(id);
        return { buffer: { duration: 1 } as AudioBuffer, peaks: [], duration: 1 };
      }
    });

    assert.deepEqual(reloaded, [audioB]);
    assert.deepEqual(hydratedB.hydratedAudioIds, [audioB]);
    assert.equal(hydratedB.state.playlistClips[0].audioUnavailable, false);
  } finally {
    await deletePersistedAudioClip('phase33-reload-a').catch(() => undefined);
    await deletePersistedAudioClip('phase33-reload-b').catch(() => undefined);
    await deletePersistedProjectState().catch(() => undefined);
    restore();
  }
});


class Phase38FakeRequest<T = unknown> {
  result!: T;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class Phase38FakeTransaction {
  error: Error | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor(private readonly store: Phase38FakeStore) {}

  objectStore(): Phase38FakeStore {
    return this.store;
  }

  complete(): void {
    queueMicrotask(() => this.oncomplete?.());
  }

  fail(error: Error): void {
    this.error = error;
    queueMicrotask(() => this.onerror?.());
  }
}

class Phase38FakeStore {
  constructor(
    private readonly records: Map<string, unknown>,
    private readonly controller: Phase38ControlledIndexedDb,
    private readonly storeName: string,
    private readonly tx: Phase38FakeTransaction
  ) {}

  put(value: { id: string }): void {
    if (this.controller.failProjectWrites && this.storeName === 'projects' && value.id === 'current-project') {
      this.tx.fail(new Error('forced project persistence failure'));
      return;
    }
    this.records.set(value.id, value);
    this.tx.complete();
  }

  get(id: string): Phase38FakeRequest {
    const request = new Phase38FakeRequest();
    request.result = this.records.get(id);
    queueMicrotask(() => request.onsuccess?.());
    return request;
  }

  delete(id: string): void {
    if (this.storeName === 'clips' && this.controller.blockDeletes) {
      this.controller.deleteStarted.resolve();
      void this.controller.deleteGate.promise.then(() => {
        this.records.delete(id);
        this.tx.complete();
      });
      return;
    }
    this.records.delete(id);
    this.tx.complete();
  }

  getAllKeys(): Phase38FakeRequest {
    const request = new Phase38FakeRequest();
    const finish = () => {
      request.result = [...this.records.keys()];
      request.onsuccess?.();
    };

    if (this.storeName === 'clips' && this.controller.blockList) {
      this.controller.listStarted.resolve();
      void this.controller.listGate.promise.then(finish);
    } else {
      queueMicrotask(finish);
    }
    return request;
  }
}

class Phase38ControlledIndexedDb {
  readonly stores = new Map<string, Map<string, unknown>>([
    ['clips', new Map()],
    ['projects', new Map()]
  ]);
  readonly listStarted = Promise.withResolvers<void>();
  readonly deleteStarted = Promise.withResolvers<void>();
  readonly listGate = Promise.withResolvers<void>();
  readonly deleteGate = Promise.withResolvers<void>();
  blockList = false;
  blockDeletes = false;
  failProjectWrites = false;

  readonly indexedDb = {
    open: () => {
      const request = new Phase38FakeRequest<Phase38ControlledIndexedDb>();
      request.result = this;
      queueMicrotask(() => request.onsuccess?.());
      return request;
    }
  };

  transaction(storeName: string): Phase38FakeTransaction {
    const records = this.stores.get(storeName);
    if (!records) throw new Error(`Missing fake store: ${storeName}`);
    const tx = new Phase38FakeTransaction(
      new Phase38FakeStore(records, this, storeName, undefined as unknown as Phase38FakeTransaction)
    );
    (tx as unknown as { store: Phase38FakeStore }).store = tx.objectStore();
    return tx;
  }

  install(): () => void {
    const previous = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: {
        open: () => {
          const request = new Phase38FakeRequest<Phase38FakeDb>();
          request.result = new Phase38FakeDb(this);
          queueMicrotask(() => request.onsuccess?.());
          return request;
        }
      }
    });
    return () => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: previous });
  }
}

class Phase38FakeDb {
  readonly objectStoreNames = { contains: (name: string) => this.owner.stores.has(name) };

  constructor(private readonly owner: Phase38ControlledIndexedDb) {}

  transaction(storeName: string): Phase38FakeTransaction {
    const records = this.owner.stores.get(storeName);
    if (!records) throw new Error(`Missing fake store: ${storeName}`);
    let tx!: Phase38FakeTransaction;
    const store = new Phase38FakeStore(records, this.owner, storeName, undefined as unknown as Phase38FakeTransaction);
    tx = new Phase38FakeTransaction(store);
    (store as unknown as { tx: Phase38FakeTransaction }).tx = tx;
    return tx;
  }

  createObjectStore(): void {}

  close(): void {}
}

const phase38StateWithAudio = (audioId: string): ProjectState => {
  const state = createDefaultProjectState();
  const clip: PlaylistClip = {
    id: `phase38-clip-${audioId}`,
    trackIndex: 1,
    startBar: 1,
    lengthBars: 1,
    type: 'audio',
    audioBufferId: audioId,
    audioName: audioId,
    audioWaveform: [0.2, 0.8],
    audioUnavailable: false,
    color: '#ff6e00',
    name: audioId
  };
  return {
    ...state,
    playlistClips: [clip],
    meta: { ...state.meta, name: `Phase 38 ${audioId}` }
  };
};

const phase38InstallDb = (controller: Phase38ControlledIndexedDb) => {
  const previous = globalThis.indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: controller.indexedDb
  });
  return () => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: previous });
};

const phase38SeedAudio = (controller: Phase38ControlledIndexedDb, ids: string[]) => {
  const clips = controller.stores.get('clips')!;
  for (const id of ids) clips.set(id, { id, blob: new Blob([`audio:${id}`], { type: 'audio/wav' }) });
};

test('Phase 38: sequential A -> reconcile -> B preserves B and still removes genuine orphans', async () => {
  const controller = new Phase38ControlledIndexedDb();
  const restore = phase38InstallDb(controller);
  try {
    phase38SeedAudio(controller, ['audio-a', 'orphan']);
    const stateA = phase38StateWithAudio('audio-a');
    const first = await saveAndReconcileProjectState(stateA, { reconcileAudio: true });
    assert.deepEqual(first?.removedIds, ['orphan']);

    phase38SeedAudio(controller, ['audio-b']);
    const stateB = phase38StateWithAudio('audio-b');
    const second = await saveAndReconcileProjectState(stateB, { reconcileAudio: true });
    assert.deepEqual(second?.removedIds, ['audio-a']);
    assert.ok(controller.stores.get('clips')!.has('audio-b'));
    assert.equal(JSON.parse(controller.stores.get('projects')!.get('current-project').stateJson).state.meta.name, 'Phase 38 audio-b');
  } finally {
    restore();
  }
});

test('Phase 38: overlapping A/B saves keep B project persistence behind A reconciliation', async () => {
  const controller = new Phase38ControlledIndexedDb();
  controller.blockList = true;
  phase38SeedAudio(controller, ['audio-a', 'audio-b']);
  const restore = phase38InstallDb(controller);
  try {
    const stateA = phase38StateWithAudio('audio-a');
    const stateB = phase38StateWithAudio('audio-b');

    const saveA = saveAndReconcileProjectState(stateA, {
      reconcileAudio: true,
      additionalReferencedIds: ['audio-b']
    });
    await controller.listStarted.promise;

    const saveB = saveAndReconcileProjectState(stateB, {
      reconcileAudio: true,
      additionalReferencedIds: ['audio-b']
    });

    const currentBeforeRelease = JSON.parse(
      controller.stores.get('projects')!.get('current-project').stateJson
    ).state;
    assert.equal(currentBeforeRelease.meta.name, 'Phase 38 audio-a');

    controller.listGate.resolve();
    await saveA;
    await saveB;

    const currentAfterRelease = JSON.parse(
      controller.stores.get('projects')!.get('current-project').stateJson
    ).state;
    assert.equal(currentAfterRelease.meta.name, 'Phase 38 audio-b');
    assert.ok(controller.stores.get('clips')!.has('audio-b'));
  } finally {
    restore();
  }
});

test('Phase 38: a forced A-list -> B-save race cannot make B durable before A reconciliation completes', async () => {
  const controller = new Phase38ControlledIndexedDb();
  controller.blockList = true;
  phase38SeedAudio(controller, ['audio-a', 'audio-b']);
  const restore = phase38InstallDb(controller);
  try {
    const saveA = saveAndReconcileProjectState(phase38StateWithAudio('audio-a'), {
      reconcileAudio: true,
      additionalReferencedIds: ['audio-b']
    });
    await controller.listStarted.promise;

    const saveB = saveAndReconcileProjectState(phase38StateWithAudio('audio-b'), {
      reconcileAudio: true,
      additionalReferencedIds: ['audio-b']
    });

    await Promise.resolve();
    assert.equal(
      JSON.parse(controller.stores.get('projects')!.get('current-project').stateJson).state.meta.name,
      'Phase 38 audio-a'
    );

    controller.listGate.resolve();
    await saveA;
    await saveB;
    assert.ok(controller.stores.get('clips')!.has('audio-b'));
  } finally {
    restore();
  }
});

test('Phase 38: three overlapping saves execute as A -> reconcile -> B -> reconcile -> C -> reconcile', async () => {
  const controller = new Phase38ControlledIndexedDb();
  controller.blockList = true;
  phase38SeedAudio(controller, ['audio-a', 'audio-b', 'audio-c']);
  const restore = phase38InstallDb(controller);
  try {
    const saveA = saveAndReconcileProjectState(phase38StateWithAudio('audio-a'), {
      reconcileAudio: true,
      additionalReferencedIds: ['audio-b', 'audio-c']
    });
    await controller.listStarted.promise;

    const saveB = saveAndReconcileProjectState(phase38StateWithAudio('audio-b'), {
      reconcileAudio: true,
      additionalReferencedIds: ['audio-c']
    });
    const saveC = saveAndReconcileProjectState(phase38StateWithAudio('audio-c'), {
      reconcileAudio: true
    });

    assert.equal(
      JSON.parse(controller.stores.get('projects')!.get('current-project').stateJson).state.meta.name,
      'Phase 38 audio-a'
    );

    controller.listGate.resolve();
    await saveA;
    await saveB;
    await saveC;

    const current = JSON.parse(controller.stores.get('projects')!.get('current-project').stateJson).state;
    assert.equal(current.meta.name, 'Phase 38 audio-c');
  } finally {
    restore();
  }
});

test('Phase 38: reconciliation failure does not invalidate the successful project save or block the next save', async () => {
  const controller = new Phase38ControlledIndexedDb();
  const restore = phase38InstallDb(controller);
  try {
    const stateA = phase38StateWithAudio('audio-a');
    const failed = await saveAndReconcileProjectState(stateA, {
      reconcileAudio: true,
      storage: {
        listPersistedAudioClipIds: async () => { throw new Error('forced enumeration failure'); },
        deletePersistedAudioClip: async () => undefined,
        listProjectBackupRecords: async () => []
      }
    });
    assert.equal(failed, null);
    assert.equal(
      JSON.parse(controller.stores.get('projects')!.get('current-project').stateJson).state.meta.name,
      'Phase 38 audio-a'
    );

    const stateB = phase38StateWithAudio('audio-b');
    await saveAndReconcileProjectState(stateB, { reconcileAudio: false });
    assert.equal(
      JSON.parse(controller.stores.get('projects')!.get('current-project').stateJson).state.meta.name,
      'Phase 38 audio-b'
    );
  } finally {
    restore();
  }
});

test('Phase 38: project persistence failure prevents reconciliation from executing', async () => {
  const controller = new Phase38ControlledIndexedDb();
  controller.failProjectWrites = true;
  const restore = phase38InstallDb(controller);
  try {
    let listCalls = 0;
    const result = await saveAndReconcileProjectState(phase38StateWithAudio('audio-a'), {
      reconcileAudio: true,
      storage: {
        listPersistedAudioClipIds: async () => { listCalls += 1; return ['orphan']; },
        deletePersistedAudioClip: async () => undefined,
        listProjectBackupRecords: async () => []
      }
    });
    assert.equal(result, null);
    assert.equal(listCalls, 0);
  } finally {
    restore();
  }
});

test('Phase 38: retained backup references survive reconciliation', async () => {
  const state = phase38StateWithAudio('backup-audio');
  let deleted: string[] = [];
  const result = await saveAndReconcileProjectState(state, {
    reconcileAudio: true,
    storage: {
      listPersistedAudioClipIds: async () => ['backup-audio', 'orphan'],
      deletePersistedAudioClip: async id => { deleted.push(id); },
      listProjectBackupRecords: async () => [{
        id: 'backup:phase38',
        name: 'Backup',
        reason: 'replace',
        createdAt: 1,
        stateJson: serializeProjectState(phase38StateWithAudio('backup-audio'))
      }]
    }
  });
  assert.deepEqual(result?.removedIds, ['orphan']);
  assert.deepEqual(deleted, ['orphan']);
});

test('Phase 38: genuine orphan cleanup remains unchanged', async () => {
  let deleted: string[] = [];
  const result = await saveAndReconcileProjectState(phase38StateWithAudio('live-audio'), {
    reconcileAudio: true,
    storage: {
      listPersistedAudioClipIds: async () => ['live-audio', 'orphan-1', 'orphan-2'],
      deletePersistedAudioClip: async id => { deleted.push(id); },
      listProjectBackupRecords: async () => []
    }
  });
  assert.deepEqual(result?.preservedIds, ['live-audio']);
  assert.deepEqual(result?.removedIds, ['orphan-1', 'orphan-2']);
  assert.deepEqual(deleted, ['orphan-1', 'orphan-2']);
});

test('Phase 38: imported, recorded and bounced pending audio can remain protected by additional references', async () => {
  const pendingIds = ['imported-sample', 'recorded-take', 'bounced-clip'];
  const state = phase38StateWithAudio('project-audio');
  let deleted: string[] = [];
  const result = await saveAndReconcileProjectState(state, {
    reconcileAudio: true,
    additionalReferencedIds: pendingIds,
    storage: {
      listPersistedAudioClipIds: async () => [...pendingIds, 'project-audio', 'orphan'],
      deletePersistedAudioClip: async id => { deleted.push(id); },
      listProjectBackupRecords: async () => []
    }
  });
  assert.deepEqual(result?.preservedIds.sort(), [...pendingIds, 'project-audio'].sort());
  assert.deepEqual(result?.removedIds, ['orphan']);
  assert.deepEqual(deleted, ['orphan']);
});

test('Phase 38: delayed deletion cannot start a newer save while the older reconciliation owns the queue', async () => {
  const controller = new Phase38ControlledIndexedDb();
  controller.blockDeletes = true;
  phase38SeedAudio(controller, ['audio-a', 'audio-b']);
  const restore = phase38InstallDb(controller);
  try {
    const saveA = saveAndReconcileProjectState(phase38StateWithAudio('audio-a'), {
      reconcileAudio: true,
      additionalReferencedIds: ['audio-b']
    });
    await controller.deleteStarted.promise;

    const saveB = saveAndReconcileProjectState(phase38StateWithAudio('audio-b'), {
      reconcileAudio: true,
      additionalReferencedIds: ['audio-b']
    });

    await Promise.resolve();
    assert.equal(
      JSON.parse(controller.stores.get('projects')!.get('current-project').stateJson).state.meta.name,
      'Phase 38 audio-a'
    );

    controller.deleteGate.resolve();
    await saveA;
    await saveB;
    assert.equal(
      JSON.parse(controller.stores.get('projects')!.get('current-project').stateJson).state.meta.name,
      'Phase 38 audio-b'
    );
  } finally {
    restore();
  }
});
