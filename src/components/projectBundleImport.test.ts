/**
 * Phase 6B (issue #56) — Portable ZIP bundle IMPORT regression tests.
 *
 * Defect proven and fixed here: `ProjectBundleZipModal.handleImportZip` used
 * to persist every manifest-declared audio entry into IndexedDB *while*
 * unpacking — before the project-replacement confirmation and without any
 * validation. Consequences on current-main code (reproduced byte-for-byte):
 *   1. A stale/hostile archive reusing an audio id from the CURRENT project
 *      permanently overwrote the locally stored bytes — even when the user
 *      cancelled the import ("Import cancelled — the current project was kept
 *      unchanged." was a lie: the audio underneath it had been replaced).
 *   2. Duplicate ids in `audioFiles` silently last-wins-ed.
 *   3. Empty payloads no-oped in `persistAudioClip` but were counted as
 *      "restored" in the status message.
 *   4. Truncated payloads (declared size ≠ actual bytes), missing payload
 *      entries and arbitrary/unsafe archive paths were accepted blindly.
 *   5. A mid-loop failure left the store half-written with no project loaded.
 *
 * The fix introduces `planBundleAudioImport`: an all-or-nothing validation
 * pass (manifest shape → duplicate ids/paths → path safety → payload presence
 * → byte-length vs declared size → conflict check against the real storage
 * layer) that must fully succeed before the modal writes anything. These
 * tests run the REAL production primitives end to end: `JSZip` archive
 * generation/loading, `collectBundleAudioAssets` + `buildBundleAudioAssetPath`
 * (export side), `normalizeProjectState` + `getAudioIdsForProject`
 * (reference side) and `persistAudioClip`/`getPersistedAudioClip` against the
 * in-memory IndexedDB fake (storage side). Every rejection test asserts the
 * store is byte-for-byte untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { getPersistedAudioClip, persistAudioClip } from '../audio/audioPersistence';
import { getAudioIdsForProject } from '../state/projectPersistence';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import type { ProjectState } from '../types/daw';
import { collectBundleAudioAssets } from './projectBundleAudioAssets';
import { BundleImportError, planBundleAudioImport } from './projectBundleImport';
import type { BundleAudioImportPlan, BundleImportFailure } from './projectBundleImport';

// --- in-memory IndexedDB fake (same harness as src/audio/audioPersistence.test.ts) ---
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
  return {
    db,
    restore: () => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: previous }),
  };
};

// --- deterministic fixtures ---
const deterministicBytes = (seed: number, length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  let state = (seed >>> 0) || 1;
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    bytes[i] = state & 0xff;
  }
  return bytes;
};

const FIXTURE_IDS = ['audio-plc-1', 'audio-sample-1', 'audio-rec-1'] as const;

/** Project state referencing audio from a playlist clip, a channel sample and a recording. */
const buildFixtureState = (): ProjectState => {
  const state = createDefaultProjectState();
  return {
    ...state,
    playlistClips: [
      ...state.playlistClips,
      {
        id: 'plc-1',
        trackIndex: 0,
        startBar: 1,
        lengthBars: 4,
        type: 'audio',
        color: '#ff6e00',
        name: 'Recorded Take',
        audioBufferId: 'audio-plc-1',
      },
    ],
    channels: state.channels.map((ch, idx) => (idx === 0
      ? {
        ...ch,
        customSample: {
          id: 'audio-sample-1',
          name: 'Custom Sample',
          duration: 1.5,
          sampleRate: 44100,
          channels: 1,
          waveformPeaks: [0, 0.5, 1, 0.5, 0],
        },
      }
      : ch)),
    recordings: [
      ...state.recordings,
      {
        id: 'rec-1',
        name: 'Vox Take 1',
        timestamp: 1700000000000,
        durationSeconds: 2.5,
        waveform: [0, 0.25, 0.75, 0],
        audioBufferId: 'audio-rec-1',
        // Stripped from the portable manifest by the JSON replacer (same as production);
        // the id reference must survive instead.
        audioBlob: new Blob([deterministicBytes(99, 64)], { type: 'audio/webm' }),
      },
    ],
  };
};

/** Byte-identical to the modal's `buildPortableManifest`. */
const buildPortableManifest = (state: ProjectState): string => JSON.stringify(state, (key, value) => {
  if (key === 'audioBlob' || key === 'blob') return undefined;
  return value;
}, 2);

interface BundleAudioFileEntry { id: string; path: string; mimeType: string; size: number }

/** Mirrors the modal's export path using the production collect/path primitives. */
const exportBundleZip = async (state: ProjectState, includeSamples: boolean): Promise<Uint8Array> => {
  const zip = new JSZip();
  zip.file('project_manifest.json', buildPortableManifest(state));
  const audioFiles: BundleAudioFileEntry[] = [];
  if (includeSamples) {
    const audioFolder = zip.folder('audio');
    assert.ok(audioFolder);
    const assets = await collectBundleAudioAssets(getAudioIdsForProject(state), getPersistedAudioClip);
    for (const asset of assets) {
      audioFolder.file(asset.path.slice('audio/'.length), asset.blob);
      audioFiles.push({ id: asset.id, path: asset.path, mimeType: asset.mimeType, size: asset.size });
    }
  }
  zip.file('bundle_manifest.json', JSON.stringify({
    format: 'apex-studio-project-bundle',
    formatVersion: 2,
    projectVersion: state.meta.version,
    audioFiles,
    generatedAt: '2026-10-22T00:00:00.000Z',
  }, null, 2));
  return zip.generateAsync({ type: 'uint8array' });
};

/** Mirrors the modal's post-plan write loop exactly. */
const applyImportPlan = async (plan: BundleAudioImportPlan): Promise<number> => {
  let restoredAudioCount = 0;
  for (const audioFile of plan.assetsToPersist) {
    const typedBlob = audioFile.blob.type ? audioFile.blob : new Blob([audioFile.blob], { type: audioFile.mimeType || 'application/octet-stream' });
    await persistAudioClip(audioFile.id, typedBlob);
    restoredAudioCount += 1;
  }
  return restoredAudioCount + plan.alreadyStoredIds.length;
};

/** Lightweight store stand-in for rejection tests (no IndexedDB needed). */
const createMemoryStore = (initial: Record<string, Uint8Array> = {}) => {
  const store = new Map<string, Uint8Array>(Object.entries(initial));
  return {
    store,
    snapshot: () => new Map(store),
    readStoredAudio: async (id: string): Promise<Blob | null> => {
      const bytes = store.get(id);
      return bytes ? new Blob([bytes], { type: 'audio/wav' }) : null;
    },
  };
};

/** Builds + reloads a crafted archive (real JSZip round trip, like a downloaded file). */
const buildCraftedArchive = async (audioFiles: unknown, entries: Record<string, Uint8Array> = {}): Promise<JSZip> => {
  const zip = new JSZip();
  zip.file('project_manifest.json', buildPortableManifest(createDefaultProjectState()));
  for (const [path, bytes] of Object.entries(entries)) zip.file(path, bytes);
  zip.file('bundle_manifest.json', JSON.stringify({
    format: 'apex-studio-project-bundle',
    formatVersion: 2,
    audioFiles,
  }));
  return JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
};

const readBundleManifest = async (zip: JSZip): Promise<{ format?: string; formatVersion?: number; audioFiles?: unknown }> => {
  const file = zip.file('bundle_manifest.json');
  assert.ok(file);
  return JSON.parse(await file.async('string')) as { format?: string; formatVersion?: number; audioFiles?: unknown };
};

const expectBundleImportError = async (
  run: () => Promise<unknown>,
  failure: BundleImportFailure,
  audioId?: string,
): Promise<void> => {
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof BundleImportError, `expected BundleImportError, got ${String(err)}`);
    assert.equal(err.failure, failure);
    if (audioId !== undefined) assert.equal(err.audioId, audioId);
    assert.match(err.message, /^Import failed — /);
    return true;
  });
};

const storedBytes = async (id: string): Promise<Uint8Array> => {
  const blob = await getPersistedAudioClip(id);
  assert.ok(blob, `expected stored audio for ${id}`);
  return new Uint8Array(await blob.arrayBuffer());
};

test('ZIP round trip: export → import restores every referenced asset byte-for-byte into the real storage layer', async () => {
  const { restore } = installIndexedDbMock();
  try {
    const originals = new Map<string, { bytes: Uint8Array; mimeType: string }>([
      ['audio-plc-1', { bytes: deterministicBytes(1, 4096), mimeType: 'audio/wav' }],
      ['audio-sample-1', { bytes: deterministicBytes(2, 1024), mimeType: 'audio/wav' }],
      ['audio-rec-1', { bytes: deterministicBytes(3, 2048), mimeType: 'audio/webm' }],
    ]);
    const state = buildFixtureState();
    for (const [id, { bytes, mimeType }] of originals) {
      await persistAudioClip(id, new Blob([bytes], { type: mimeType }));
    }

    const zipBytes = await exportBundleZip(state, true);
    const zip = await JSZip.loadAsync(zipBytes);

    // Export-side truth: manifest lists all three assets; project manifest carries no blob payloads.
    const bundleManifest = await readBundleManifest(zip);
    assert.equal(bundleManifest.format, 'apex-studio-project-bundle');
    assert.equal(bundleManifest.formatVersion, 2);
    const audioFiles = bundleManifest.audioFiles as BundleAudioFileEntry[];
    assert.equal(audioFiles.length, 3);
    const manifestText = await zip.file('project_manifest.json')!.async('string');
    assert.ok(!manifestText.includes('audioBlob'));
    const loadedState = normalizeProjectState(JSON.parse(manifestText));

    // Fresh machine: empty store, then plan + write exactly like the modal.
    restore();
    const fresh = installIndexedDbMock();
    try {
      assert.equal((await getPersistedAudioClip('audio-plc-1')), null);
      const plan = await planBundleAudioImport(audioFiles, zip, getPersistedAudioClip);
      assert.equal(plan.alreadyStoredIds.length, 0);
      assert.deepEqual(plan.assetsToPersist.map((a) => a.id).sort(), [...FIXTURE_IDS].sort());
      const restoredCount = await applyImportPlan(plan);
      assert.equal(restoredCount, 3);

      // References restored: the loaded state's audio ids are exactly what got persisted.
      assert.deepEqual([...getAudioIdsForProject(loadedState)].sort(), [...FIXTURE_IDS].sort());
      // Bytes restored byte-for-byte, with mime types preserved.
      for (const [id, { bytes, mimeType }] of originals) {
        assert.deepEqual(await storedBytes(id), bytes);
        const blob = await getPersistedAudioClip(id);
        assert.equal(blob?.type, mimeType);
      }
    } finally {
      fresh.restore();
    }
  } finally {
    restore();
  }
});

test('includeSamples disabled: manifest-only archive imports zero assets truthfully and stays compatible', async () => {
  const { restore } = installIndexedDbMock();
  try {
    const state = buildFixtureState();
    await persistAudioClip('audio-plc-1', new Blob([deterministicBytes(1, 512)], { type: 'audio/wav' }));
    const zip = await JSZip.loadAsync(await exportBundleZip(state, false));

    // No audio payloads packaged anywhere in the archive.
    assert.deepEqual(Object.keys(zip.files).filter((p) => p.startsWith('audio/')), []);
    const bundleManifest = await readBundleManifest(zip);
    assert.deepEqual(bundleManifest.audioFiles, []);

    restore();
    const fresh = installIndexedDbMock();
    try {
      const loadedState = normalizeProjectState(JSON.parse(await zip.file('project_manifest.json')!.async('string')));
      const plan = await planBundleAudioImport(bundleManifest.audioFiles, zip, getPersistedAudioClip);
      assert.deepEqual(plan.assetsToPersist, []);
      assert.deepEqual(plan.alreadyStoredIds, []);
      // Truthful count: zero restored, project still loads; missing assets surface via hydration flags.
      assert.equal(await applyImportPlan(plan), 0);
      assert.deepEqual(getAudioIdsForProject(loadedState).sort(), [...FIXTURE_IDS].sort());
      assert.equal(await getPersistedAudioClip('audio-plc-1'), null);
    } finally {
      fresh.restore();
    }
  } finally {
    restore();
  }
});

test('regression (repro #1): colliding id with different bytes rejects the whole import — a cancelled import can no longer corrupt stored audio', async () => {
  const ORIGINAL = deterministicBytes(7, 256);
  const EVIL = deterministicBytes(666, 128);
  const memory = createMemoryStore({ 'audio-rec-1': ORIGINAL, 'unrelated-asset': deterministicBytes(8, 64) });
  const before = memory.snapshot();

  // Stale/hostile bundle: reuses a CURRENT project asset id with different bytes,
  // plus one genuinely new asset. Old code persisted BOTH before the user could
  // cancel; the plan must reject everything instead.
  const zip = await buildCraftedArchive(
    [
      { id: 'audio-rec-1', path: 'audio/1_evil.bin', mimeType: 'audio/wav', size: EVIL.length },
      { id: 'brand-new', path: 'audio/2_new.bin', mimeType: 'audio/wav', size: 32 },
    ],
    { 'audio/1_evil.bin': EVIL, 'audio/2_new.bin': deterministicBytes(9, 32) },
  );

  const audioFiles = (await readBundleManifest(zip)).audioFiles;
  await expectBundleImportError(
    () => planBundleAudioImport(audioFiles, zip, memory.readStoredAudio),
    'conflicting-stored-audio',
    'audio-rec-1',
  );
  // All-or-nothing: neither the overwrite NOR the new asset was written.
  assert.deepEqual(memory.store, before);
  assert.deepEqual(memory.store.get('audio-rec-1'), ORIGINAL);
  assert.equal(memory.store.has('brand-new'), false);
});

test('re-importing the identical bundle is idempotent: byte-identical assets are recognized and never rewritten', async () => {
  const BYTES = deterministicBytes(11, 300);
  const memory = createMemoryStore({ 'a-1': BYTES });
  const before = memory.snapshot();
  const zip = await buildCraftedArchive(
    [{ id: 'a-1', path: 'audio/1_a-1.bin', mimeType: 'audio/wav', size: BYTES.length }],
    { 'audio/1_a-1.bin': BYTES },
  );
  const audioFiles = (await readBundleManifest(zip)).audioFiles;
  const plan = await planBundleAudioImport(audioFiles, zip, memory.readStoredAudio);
  assert.deepEqual(plan.assetsToPersist, []);
  assert.deepEqual(plan.alreadyStoredIds, ['a-1']);
  assert.equal(await applyImportPlan(plan), 1); // reported as restored without a rewrite
  assert.deepEqual(memory.store, before);
});

test('duplicate audio ids in the manifest reject before any write (old code silently last-wins-ed)', async () => {
  const memory = createMemoryStore();
  const bytes = deterministicBytes(12, 16);
  const other = deterministicBytes(13, 16);
  const zip = await buildCraftedArchive(
    [
      { id: 'dup-id', path: 'audio/1_dup.bin', mimeType: 'audio/wav', size: bytes.length },
      { id: 'dup-id', path: 'audio/2_dup.bin', mimeType: 'audio/wav', size: other.length },
    ],
    { 'audio/1_dup.bin': bytes, 'audio/2_dup.bin': other },
  );
  const audioFiles = (await readBundleManifest(zip)).audioFiles;
  await expectBundleImportError(
    () => planBundleAudioImport(audioFiles, zip, memory.readStoredAudio),
    'duplicate-audio-id',
    'dup-id',
  );
  assert.equal(memory.store.size, 0);
});

test('duplicate archive paths reject before any write', async () => {
  const memory = createMemoryStore();
  const bytes = deterministicBytes(14, 24);
  const zip = await buildCraftedArchive(
    [
      { id: 'id-a', path: 'audio/1_shared.bin', mimeType: 'audio/wav', size: bytes.length },
      { id: 'id-b', path: 'audio/1_shared.bin', mimeType: 'audio/wav', size: bytes.length },
    ],
    { 'audio/1_shared.bin': bytes },
  );
  const audioFiles = (await readBundleManifest(zip)).audioFiles;
  await expectBundleImportError(
    () => planBundleAudioImport(audioFiles, zip, memory.readStoredAudio),
    'duplicate-audio-path',
    'id-b',
  );
  assert.equal(memory.store.size, 0);
});

test('unsafe archive paths reject before any payload is read or written (path traversal / escaping the audio folder)', async () => {
  const unsafePaths = [
    '../evil.bin',
    '/etc/passwd',
    'audio/../evil.bin',
    'audio/..',
    'audio/.',
    'patterns/pat.json',
    'audio/sub\\evil.bin',
    'audio/bad\u0000char.bin',
    'audiox/1_a.bin',
  ];
  for (const unsafePath of unsafePaths) {
    const memory = createMemoryStore({ 'keep-me': deterministicBytes(15, 8) });
    const before = memory.snapshot();
    const zip = await buildCraftedArchive(
      [{ id: 'evil-id', path: unsafePath, mimeType: 'audio/wav', size: 2 }],
      { [unsafePath]: new Uint8Array([9, 9]) },
    );
    const audioFiles = (await readBundleManifest(zip)).audioFiles;
    await expectBundleImportError(
      () => planBundleAudioImport(audioFiles, zip, memory.readStoredAudio),
      'unsafe-audio-path',
      'evil-id',
    );
    assert.deepEqual(memory.store, before, `store must be untouched for unsafe path ${JSON.stringify(unsafePath)}`);
  }
});

test('a declared payload missing from the archive rejects the whole import', async () => {
  const memory = createMemoryStore();
  const zip = await buildCraftedArchive(
    [{ id: 'ghost', path: 'audio/1_ghost.bin', mimeType: 'audio/wav', size: 10 }],
    {}, // no payload packaged
  );
  const audioFiles = (await readBundleManifest(zip)).audioFiles;
  await expectBundleImportError(
    () => planBundleAudioImport(audioFiles, zip, memory.readStoredAudio),
    'missing-audio-payload',
    'ghost',
  );
  assert.equal(memory.store.size, 0);
});

test('truncated or padded payloads (declared size ≠ actual bytes) reject before any write', async () => {
  const actual = deterministicBytes(16, 12);
  for (const declaredSize of [4096, 4]) {
    const memory = createMemoryStore();
    const zip = await buildCraftedArchive(
      [{ id: 'trunc', path: 'audio/1_trunc.bin', mimeType: 'audio/wav', size: declaredSize }],
      { 'audio/1_trunc.bin': actual },
    );
    const audioFiles = (await readBundleManifest(zip)).audioFiles;
    await expectBundleImportError(
      () => planBundleAudioImport(audioFiles, zip, memory.readStoredAudio),
      'payload-size-mismatch',
      'trunc',
    );
    assert.equal(memory.store.size, 0);
  }
});

test('empty payloads reject instead of silently counting as restored (old code lied in the status message)', async () => {
  // (a) declared size 0 → invalid entry.
  const memoryA = createMemoryStore();
  const zipA = await buildCraftedArchive(
    [{ id: 'empty-a', path: 'audio/1_empty.bin', mimeType: 'audio/wav', size: 0 }],
    { 'audio/1_empty.bin': new Uint8Array(0) },
  );
  const audioFilesA = (await readBundleManifest(zipA)).audioFiles;
  await expectBundleImportError(
    () => planBundleAudioImport(audioFilesA, zipA, memoryA.readStoredAudio),
    'invalid-audio-entry',
    'empty-a',
  );
  assert.equal(memoryA.store.size, 0);

  // (b) declared size ≥ 1 but archive entry is empty → empty payload.
  const memoryB = createMemoryStore();
  const zipB = await buildCraftedArchive(
    [{ id: 'empty-b', path: 'audio/1_empty.bin', mimeType: 'audio/wav', size: 8 }],
    { 'audio/1_empty.bin': new Uint8Array(0) },
  );
  const audioFilesB = (await readBundleManifest(zipB)).audioFiles;
  await expectBundleImportError(
    () => planBundleAudioImport(audioFilesB, zipB, memoryB.readStoredAudio),
    'empty-audio-payload',
    'empty-b',
  );
  assert.equal(memoryB.store.size, 0);
});

test('malformed manifest entries reject with typed failures and zero writes', async () => {
  const goodBytes = deterministicBytes(17, 8);
  const cases: Array<{ audioFiles: unknown; failure: BundleImportFailure; label: string }> = [
    { audioFiles: 'not-an-array', failure: 'malformed-audio-manifest', label: 'audioFiles not an array' },
    { audioFiles: [null], failure: 'invalid-audio-entry', label: 'null entry' },
    { audioFiles: [{ path: 'audio/1_x.bin', mimeType: 'audio/wav', size: 8 }], failure: 'invalid-audio-entry', label: 'missing id' },
    { audioFiles: [{ id: '  ', path: 'audio/1_x.bin', mimeType: 'audio/wav', size: 8 }], failure: 'invalid-audio-entry', label: 'blank id' },
    { audioFiles: [{ id: 'x', mimeType: 'audio/wav', size: 8 }], failure: 'invalid-audio-entry', label: 'missing path' },
    { audioFiles: [{ id: 'x', path: 'audio/1_x.bin', mimeType: 'audio/wav' }], failure: 'invalid-audio-entry', label: 'missing size' },
    { audioFiles: [{ id: 'x', path: 'audio/1_x.bin', mimeType: 'audio/wav', size: 3.5 }], failure: 'invalid-audio-entry', label: 'fractional size' },
    { audioFiles: [{ id: 'x', path: 'audio/1_x.bin', mimeType: 'audio/wav', size: '8' }], failure: 'invalid-audio-entry', label: 'string size' },
    { audioFiles: [{ id: 'x', path: 'audio/1_x.bin', mimeType: 'audio/wav', size: NaN }], failure: 'invalid-audio-entry', label: 'NaN size' },
    { audioFiles: [{ id: 'x', path: 'audio/1_x.bin', mimeType: 'audio/wav', size: -1 }], failure: 'invalid-audio-entry', label: 'negative size' },
  ];
  for (const { audioFiles, failure, label } of cases) {
    const memory = createMemoryStore();
    const zip = await buildCraftedArchive(audioFiles, { 'audio/1_x.bin': goodBytes });
    await expectBundleImportError(
      () => planBundleAudioImport(audioFiles, zip, memory.readStoredAudio),
      failure,
    );
    assert.equal(memory.store.size, 0, `store must be empty for case: ${label}`);
  }
});

test('unreadable local storage rejects safely without writing anything', async () => {
  const zip = await buildCraftedArchive(
    [{ id: 'blocked', path: 'audio/1_blocked.bin', mimeType: 'audio/wav', size: 4 }],
    { 'audio/1_blocked.bin': deterministicBytes(18, 4) },
  );
  const audioFiles = (await readBundleManifest(zip)).audioFiles;
  await expectBundleImportError(
    () => planBundleAudioImport(audioFiles, zip, async () => { throw new Error('IndexedDB unavailable'); }),
    'stored-audio-unreadable',
    'blocked',
  );
});
