/**
 * Phase 1J — meter editing through the authoritative project state:
 * rejection of unsupported meters, the bar-anchored clip policy, undo/redo,
 * save → reload, and project replacement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import {
  UnsupportedMeterEditError,
  getMetaUpdateLabel,
  getTimeSignatureEditLabel,
  isContinuousMetaUpdate,
  setProjectTimeSignatureInProjectState,
  setSevenEightGroupingInProjectState,
  updateProjectMetadataInProjectState,
} from './projectMutations';
import { createHistory } from './projectHistory';
import { persistProjectState, restorePersistedProjectState, serializeProjectState } from './projectPersistence';
import { deletePersistedProjectState } from '../audio/audioPersistence';
import { resynchronizeLiveEngineFromProjectState, type LiveEngineResynchronizationPort } from './liveEngineResynchronization';
import { resolveProjectTimeSignature } from '../music/musicalTime';
import { resolveSevenEightGrouping } from '../music/meterPulse';
import type { PlaylistClip, ProjectState } from '../types/daw';

// --- minimal IndexedDB mock (same shape as projectPersistence.test.ts) ------
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
  get(id: string): FakeRequest { const r = new FakeRequest(); r.result = this.store.get(id); queueMicrotask(() => r.onsuccess?.()); return r; }
  delete(id: string): void { this.store.delete(id); this.tx.complete(); }
  getAll(): FakeRequest { const r = new FakeRequest(); r.result = Array.from(this.store.values()); queueMicrotask(() => r.onsuccess?.()); return r; }
  getAllKeys(): FakeRequest { const r = new FakeRequest(); r.result = Array.from(this.store.keys()); queueMicrotask(() => r.onsuccess?.()); return r; }
}
class FakeDb {
  readonly stores = new Map<string, Map<string, unknown>>();
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createObjectStore(name: string): void { if (!this.stores.has(name)) this.stores.set(name, new Map()); }
  transaction(name: string): FakeTransaction {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    return new FakeTransaction(this.stores.get(name)!);
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

// --- fixtures ---------------------------------------------------------------
const withClips = (): ProjectState => {
  const state = createDefaultProjectState();
  const clips: PlaylistClip[] = [
    { id: 'c-pattern', trackIndex: 0, startBar: 5, lengthBars: 2, type: 'pattern', patternId: state.patterns[0]?.id, name: 'P', color: '#fff' } as PlaylistClip,
    { id: 'c-audio', trackIndex: 1, startBar: 2.5, lengthBars: 3, type: 'audio', audioBufferId: 'buf-1', name: 'A', color: '#fff' } as PlaylistClip,
  ];
  state.playlistClips = clips;
  state.channels[0].notes = [{ id: 'n1', pitch: 60, start: 13, duration: 3, velocity: 0.8 }];
  return normalizeProjectState(state);
};

const snapshotMusicalData = (state: ProjectState) => JSON.stringify({
  clips: state.playlistClips,
  patterns: state.patterns,
  notes: state.channels.map(channel => [channel.id, channel.notes, channel.steps]),
  markers: state.markers,
  totalBars: state.totalBars,
});

// --- selector-facing mutation contract --------------------------------------
test('every supported meter is accepted and stored as a fresh [n, d] tuple', () => {
  for (const meter of [[4, 4], [3, 4], [6, 8], [7, 8]] as const) {
    const base = withClips();
    base.meta.timeSignature = meter[0] === 4 ? [3, 4] : [4, 4];
    const next = setProjectTimeSignatureInProjectState(base, meter);
    assert.deepEqual(next.meta.timeSignature, [meter[0], meter[1]]);
    assert.notEqual(next.meta.timeSignature, meter, 'the stored tuple must not alias the caller array');
    assert.deepEqual(resolveProjectTimeSignature(next.meta), meter);
  }
});

test('unsupported meters are rejected and never reach the document', () => {
  const base = withClips();
  for (const bad of [[5, 4], [7, 4], [2, 4], [12, 8], [0, 4], [4, 3], [4.5, 4], 'seven-eight', null, undefined, [7, 8, 1]]) {
    assert.throws(() => setProjectTimeSignatureInProjectState(base, bad), UnsupportedMeterEditError, `${JSON.stringify(bad)} must be rejected`);
  }
  // The generic meta path is guarded too: no caller can bypass the selector.
  assert.throws(() => updateProjectMetadataInProjectState(base, { timeSignature: [5, 4] }), UnsupportedMeterEditError);
  assert.throws(() => updateProjectMetadataInProjectState(base, { sevenEightGrouping: '4+3' as never }), UnsupportedMeterEditError);
  assert.deepEqual(base.meta.timeSignature, [4, 4], 'the source state is untouched');
});

test('selecting the active meter returns the same state object (no history entry)', () => {
  const base = withClips();
  assert.equal(setProjectTimeSignatureInProjectState(base, [4, 4]), base);
  const seven = setProjectTimeSignatureInProjectState(base, [7, 8]);
  assert.equal(setProjectTimeSignatureInProjectState(seven, [7, 8]), seven);
});

test('7/8 grouping accepts only 2+2+3, 3+2+2 and 2+3+2', () => {
  const base = setProjectTimeSignatureInProjectState(withClips(), [7, 8]);
  for (const grouping of ['2+2+3', '3+2+2', '2+3+2'] as const) {
    const next = setSevenEightGroupingInProjectState(base, grouping);
    assert.equal(resolveSevenEightGrouping(next.meta), grouping);
  }
  for (const bad of ['4+3', '2+2+2+1', '', 7, null]) {
    assert.throws(() => setSevenEightGroupingInProjectState(base, bad), UnsupportedMeterEditError);
  }
  const g = setSevenEightGroupingInProjectState(base, '3+2+2');
  assert.equal(setSevenEightGroupingInProjectState(g, '3+2+2'), g);
});

test('meter edits are discrete history steps with truthful labels', () => {
  assert.equal(isContinuousMetaUpdate({ timeSignature: [7, 8] }), false);
  assert.equal(isContinuousMetaUpdate({ sevenEightGrouping: '3+2+2' }), false);
  assert.equal(getMetaUpdateLabel({ timeSignature: [7, 8] }), 'Change time signature');
  assert.equal(getMetaUpdateLabel({ sevenEightGrouping: '3+2+2' }), 'Change 7/8 accent grouping');
  assert.equal(getTimeSignatureEditLabel([7, 8]), 'Change time signature to 7/8');
});

// --- clip policy ------------------------------------------------------------
test('bar-anchored policy: a meter change never rewrites clip, pattern or note positions', () => {
  const base = withClips();
  const before = snapshotMusicalData(base);
  let state = base;
  for (const meter of [[7, 8], [3, 4], [6, 8], [4, 4], [7, 8]] as const) {
    state = setProjectTimeSignatureInProjectState(state, meter);
    assert.equal(snapshotMusicalData(state), before, `${meter.join('/')} must not move stored musical data`);
    assert.equal(state.playlistClips, base.playlistClips, 'clip collection identity is preserved (no playlist republish)');
    assert.equal(state.patterns, base.patterns);
  }
  // Clip at bar 5 is still at bar 5; only its time in seconds follows the bar size.
  assert.equal(state.playlistClips.find(c => c.id === 'c-pattern')!.startBar, 5);
  assert.equal(state.playlistClips.find(c => c.id === 'c-audio')!.startBar, 2.5);
});

// --- undo / redo ------------------------------------------------------------
test('undo and redo restore the meter and grouping exactly, leaving clips intact', () => {
  const base = withClips();
  const musical = snapshotMusicalData(base);
  let history = createHistory(base);
  const seven = setProjectTimeSignatureInProjectState(history.present, [7, 8]);
  history = history.commit(seven, getTimeSignatureEditLabel([7, 8]));
  const grouped = setSevenEightGroupingInProjectState(history.present, '3+2+2');
  history = history.commit(grouped, 'Change 7/8 accent grouping');
  const waltz = setProjectTimeSignatureInProjectState(history.present, [3, 4]);
  history = history.commit(waltz, getTimeSignatureEditLabel([3, 4]));

  assert.deepEqual(history.present.meta.timeSignature, [3, 4]);
  assert.equal(history.past.length, 3);
  assert.equal(history.past[2].label, 'Change time signature to 3/4');

  history = history.undo();
  assert.deepEqual(history.present.meta.timeSignature, [7, 8]);
  assert.equal(history.present.meta.sevenEightGrouping, '3+2+2');
  history = history.undo();
  assert.deepEqual(history.present.meta.timeSignature, [7, 8]);
  assert.equal(resolveSevenEightGrouping(history.present.meta), '2+2+3');
  history = history.undo();
  assert.deepEqual(history.present.meta.timeSignature, [4, 4]);
  assert.equal(history.canUndo, false);
  assert.equal(snapshotMusicalData(history.present), musical);

  history = history.redo().redo().redo();
  assert.deepEqual(history.present.meta.timeSignature, [3, 4]);
  assert.equal(history.present.meta.sevenEightGrouping, '3+2+2', 'grouping is kept while another meter is active');
  assert.equal(snapshotMusicalData(history.present), musical);
});

test('re-selecting the current meter does not create a history entry', () => {
  const history = createHistory(withClips());
  const same = setProjectTimeSignatureInProjectState(history.present, [4, 4]);
  assert.equal(history.commit(same, 'Change time signature to 4/4'), history);
});

// --- persistence ------------------------------------------------------------
test('serialize → normalize keeps the meter and grouping without a persistence-version bump', () => {
  const state = setSevenEightGroupingInProjectState(setProjectTimeSignatureInProjectState(withClips(), [7, 8]), '2+3+2');
  const parsed = JSON.parse(serializeProjectState(state)) as { persistenceVersion: number; state: ProjectState };
  assert.equal(parsed.persistenceVersion, 1, 'Phase 1J adds an optional field only — no migration');
  const reloaded = normalizeProjectState(parsed.state);
  assert.deepEqual(reloaded.meta.timeSignature, [7, 8]);
  assert.equal(reloaded.meta.sevenEightGrouping, '2+3+2');
  assert.equal(snapshotMusicalData(reloaded), snapshotMusicalData(state));
});

test('a pre-Phase-1J document (no grouping) loads as 2+2+3; an unsupported stored meter stays stored but plays 4/4', () => {
  const legacy = JSON.parse(serializeProjectState(createDefaultProjectState())).state as ProjectState;
  legacy.meta.timeSignature = [7, 8];
  delete (legacy.meta as Partial<ProjectState['meta']>).sevenEightGrouping;
  const loaded = normalizeProjectState(legacy);
  assert.equal(loaded.meta.sevenEightGrouping, undefined, 'load does not invent/write a grouping');
  assert.equal(resolveSevenEightGrouping(loaded.meta), '2+2+3');

  const odd = JSON.parse(serializeProjectState(createDefaultProjectState())).state as ProjectState;
  odd.meta.timeSignature = [5, 4];
  const oddLoaded = normalizeProjectState(odd);
  assert.deepEqual(oddLoaded.meta.timeSignature, [5, 4], 'stored data is never silently rewritten on load');
  assert.deepEqual(resolveProjectTimeSignature(oddLoaded.meta), [4, 4]);
  // …and replacing it through the selector path works.
  assert.deepEqual(setProjectTimeSignatureInProjectState(oddLoaded, [3, 4]).meta.timeSignature, [3, 4]);
});

test('save → reload through IndexedDB persistence preserves the selected meter and grouping', async () => {
  const restore = installIndexedDbMock();
  try {
    const state = setSevenEightGroupingInProjectState(setProjectTimeSignatureInProjectState(withClips(), [7, 8]), '3+2+2');
    await persistProjectState(state);
    const restored = await restorePersistedProjectState({ loadAudioFile: async () => null as never }, createDefaultProjectState());
    assert.equal(restored.restored, true);
    assert.deepEqual(restored.state.meta.timeSignature, [7, 8]);
    assert.equal(restored.state.meta.sevenEightGrouping, '3+2+2');
    assert.equal(restored.state.playlistClips.find(c => c.id === 'c-pattern')!.startBar, 5);

    // Change and save again: the latest meter wins.
    await persistProjectState(setProjectTimeSignatureInProjectState(restored.state, [6, 8]));
    const again = await restorePersistedProjectState({ loadAudioFile: async () => null as never }, createDefaultProjectState());
    assert.deepEqual(again.state.meta.timeSignature, [6, 8]);
  } finally {
    await deletePersistedProjectState().catch(() => undefined);
    restore();
  }
});

// --- replacement / engine publication ---------------------------------------
const makePort = () => {
  const calls: Array<[string, unknown]> = [];
  const port: LiveEngineResynchronizationPort = {
    setBpm: v => calls.push(['bpm', v]),
    setTimeSignature: v => calls.push(['meter', v]),
    setSevenEightGrouping: v => calls.push(['grouping', v]),
    setSwing: () => undefined,
    setMetronome: v => calls.push(['metronome', v]),
    setGrossBeatState: () => undefined,
    setMasterVolume: () => undefined,
    isPlaybackActive: () => false,
    synchronizePlaybackState: () => undefined,
    updateMixerTrack: () => undefined,
    updateChannel: () => undefined,
    getChannelPanner: () => null,
  };
  return { port, calls };
};

test('project replacement publishes the incoming meter and grouping (not the previous project\'s)', () => {
  const previous = setSevenEightGroupingInProjectState(setProjectTimeSignatureInProjectState(withClips(), [7, 8]), '3+2+2');
  const incomingRaw = JSON.parse(serializeProjectState(setProjectTimeSignatureInProjectState(createDefaultProjectState(), [3, 4]))).state;
  const incoming = normalizeProjectState(incomingRaw);
  assert.notDeepEqual(incoming.meta.timeSignature, previous.meta.timeSignature);

  const { port, calls } = makePort();
  resynchronizeLiveEngineFromProjectState(port, incoming, { metronome: true });
  assert.deepEqual(calls.find(([k]) => k === 'meter')?.[1], [3, 4]);
  assert.equal(calls.find(([k]) => k === 'grouping')?.[1], undefined, 'incoming project has no grouping → engine resolves the default');

  const { port: port2, calls: calls2 } = makePort();
  resynchronizeLiveEngineFromProjectState(port2, previous, { metronome: false });
  assert.deepEqual(calls2.find(([k]) => k === 'meter')?.[1], [7, 8]);
  assert.equal(calls2.find(([k]) => k === 'grouping')?.[1], '3+2+2');
});
