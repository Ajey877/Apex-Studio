import test from 'node:test';
import assert from 'node:assert/strict';
import { getPersistedAudioClip, hydrateAudioClip, persistAudioClip, deletePersistedAudioClip } from './audioPersistence';

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
  readonly objectStoreNames = { contains: (name: string) => name === 'clips' };
  readonly store = new Map<string, unknown>();
  createObjectStore(): void {}
  transaction(): FakeTransaction { return new FakeTransaction(this.store); }
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

test('recorded audio persists, reload lookup finds it, and hydration loads the same asset ID', async () => {
  const restore = installIndexedDbMock();
  try {
    const id = 'recording-roundtrip-test';
    const original = new Blob(['recorded-audio'], { type: 'audio/webm' });
    await persistAudioClip(id, original);

    const persisted = await getPersistedAudioClip(id);
    assert.ok(persisted);
    assert.equal(await persisted.text(), 'recorded-audio');
    assert.equal(persisted.type, 'audio/webm');

    const loaded: Array<{ id: string; blob: Blob }> = [];
    const didHydrate = await hydrateAudioClip({
      loadAudioFile: async (blob, bufferId) => {
        loaded.push({ id: bufferId, blob });
        return { buffer: {} as AudioBuffer };
      },
    }, id);

    assert.equal(didHydrate, true);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, id);
    assert.equal(await loaded[0].blob.text(), 'recorded-audio');
  } finally {
    await deletePersistedAudioClip('recording-roundtrip-test').catch(() => undefined);
    restore();
  }
});

test('hydration reports missing persisted audio without throwing', async () => {
  const restore = installIndexedDbMock();
  try {
    assert.equal(await hydrateAudioClip({ loadAudioFile: async () => ({}) }, 'missing-recording'), false);
  } finally {
    restore();
  }
});
