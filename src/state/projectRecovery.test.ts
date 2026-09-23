import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import {
  deletePersistedProjectState,
  getPersistedProjectStateRecord,
  persistProjectStateRecord
} from '../audio/audioPersistence';
import { persistProjectState, restorePersistedProjectState } from './projectPersistence';

const installIndexedDbMock = () => {
  const db = new FakeDb();
  const previous = globalThis.indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open: () => {
    const request = new FakeRequest<FakeDb>();
    request.result = db;
    queueMicrotask(() => request.onupgradeneeded?.());
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } } });
  return () => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: previous });
};

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
  getAllKeys(): FakeRequest { const request = new FakeRequest(); request.result = [...this.store.keys()]; queueMicrotask(() => request.onsuccess?.()); return request; }
}
class FakeDb {
  readonly stores = new Map<string, Map<string, unknown>>([['clips', new Map()], ['projects', new Map()]]);
  readonly objectStoreNames = { contains: (name: string) => this.stores.has(name) };
  createObjectStore(name: string): void { if (!this.stores.has(name)) this.stores.set(name, new Map()); }
  transaction(name: string): FakeTransaction {
    const store = this.stores.get(name);
    if (!store) throw new Error(`Missing fake object store: ${name}`);
    return new FakeTransaction(store);
  }
  close(): void {}
}

test('corrupt active project is recovered from the last-known-good snapshot and replaced', async () => {
  const restore = installIndexedDbMock();
  try {
    const state = createDefaultProjectState();
    await persistProjectState(state);
    await persistProjectStateRecord('{ definitely-not-json');

    const restored = await restorePersistedProjectState(
      { loadAudioFile: async () => ({ buffer: { duration: 1 } as AudioBuffer, peaks: [], duration: 1 }) },
      createDefaultProjectState()
    );

    assert.equal(restored.restored, true);
    assert.equal(restored.recovered, true);
    assert.equal(restored.state.meta.name, state.meta.name);
    const active = await getPersistedProjectStateRecord();
    assert.ok(active);
    assert.doesNotThrow(() => JSON.parse(active!));
  } finally {
    await deletePersistedProjectState().catch(() => undefined);
    restore();
  }
});

test('optional persistence fields reject malformed structures instead of propagating bad JSON', () => {
  const state = createDefaultProjectState();
  assert.throws(() => normalizeProjectState({ ...state, markers: { bad: true } }), /markers must be an array/);
  assert.throws(() => normalizeProjectState({ ...state, connectedMidiDevices: [{ id: 'x', name: 'x', state: 'connected', type: 'bad' }] }), /connected MIDI devices contains malformed entries/);
  assert.throws(() => normalizeProjectState({ ...state, macroKnobs: [{ id: 'x', name: 'x', value: 'bad', color: '#fff', mappings: [] }] }), /macro knobs contains malformed entries/);
  assert.throws(() => normalizeProjectState({ ...state, vocalTuner: { enabled: true } }), /vocal tuner settings are malformed/);
});
