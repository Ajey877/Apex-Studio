import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  backupProjectBeforeReplacement,
  ProjectBackupError,
  type ProjectBackupStorage,
} from '../state/projectBackup';
import {
  getPersistedAudioClip,
  getPersistedProjectRecoverySnapshotRecord,
  getPersistedProjectStateRecord,
  listProjectBackupRecords,
  ProjectBundleCommitCancelledError,
  type StoredProjectBackup,
} from '../audio/audioPersistence';
import { createDefaultProjectState } from '../state/projectState';
import {
  persistProjectBundleImport,
  persistProjectState,
  ProjectBundleAudioConflictError,
  restorePersistedProjectState,
} from '../state/projectPersistence';
import { runProjectReplacementAfterBackupAndCommit } from '../state/projectReplacement';
import {
  BundleImportError,
  getRecognizedBundleAudioFiles,
  planBundleAudioImport,
  runBundleImportCommit,
  type BundleAudioImportPlan,
  type PlannedBundleAudioAsset,
} from './projectBundleImport';
import type { ProjectState } from '../types/daw';

class FakeRequest<T = unknown> {
  result!: T;
  error: Error | null = null;
  onupgradeneeded: (() => void) | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

const namedError = (name: string, message: string): Error => Object.assign(new Error(message), { name });

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(nextResolve => { resolve = nextResolve; });
  return { promise, resolve };
};

class AtomicFakeTransaction {
  error: Error | null = null;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  private readonly stagedStores: Map<string, Map<string, unknown>>;
  private pendingRequests = 0;
  private aborted = false;
  private finished = false;
  private heldForTest = false;

  constructor(
    private readonly owner: AtomicFakeIndexedDB,
    readonly storeNames: string[],
    readonly mode: IDBTransactionMode,
  ) {
    this.stagedStores = new Map(storeNames.map(name => [name, new Map(owner.stores.get(name) ?? [])]));
  }

  objectStore(name: string): AtomicFakeObjectStore {
    const records = this.stagedStores.get(name);
    if (!records) throw new Error(`Object store ${name} is not part of this transaction`);
    return new AtomicFakeObjectStore(records, this.owner, name, this);
  }

  request<T>(operation: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.pendingRequests += 1;
    queueMicrotask(() => {
      if (this.aborted) {
        this.pendingRequests -= 1;
        return;
      }
      try {
        request.result = operation();
        request.onsuccess?.();
      } catch (error) {
        request.error = error instanceof Error ? error : new Error(String(error));
        request.onerror?.();
        this.abort(request.error);
      } finally {
        this.pendingRequests -= 1;
        this.maybeFinish();
      }
    });
    return request;
  }

  abort(error?: Error): void {
    if (this.aborted || this.finished) return;
    this.aborted = true;
    this.error = error ?? namedError('AbortError', 'Transaction aborted');
    queueMicrotask(() => this.onabort?.());
  }

  releaseHeld(): void {
    if (!this.heldForTest || this.aborted || this.finished) return;
    this.finish();
  }

  private maybeFinish(): void {
    if (this.aborted || this.finished || this.pendingRequests !== 0) return;
    const isBundleTransaction = this.storeNames.includes('clips') && this.storeNames.includes('projects');
    if (isBundleTransaction && this.owner.holdNextBundleTransaction && !this.heldForTest) {
      this.heldForTest = true;
      this.owner.holdNextBundleTransaction = false;
      this.owner.heldBundleTransaction = this;
      this.owner.bundleTransactionReady.resolve();
      return;
    }
    this.finish();
  }

  private finish(): void {
    if (this.aborted || this.finished) return;
    this.finished = true;
    if (this.mode === 'readwrite') {
      for (const [name, staged] of this.stagedStores) {
        const target = this.owner.stores.get(name)!;
        target.clear();
        for (const [key, value] of staged) target.set(key, value);
      }
    }
    queueMicrotask(() => this.oncomplete?.());
  }
}

class AtomicFakeObjectStore {
  constructor(
    private readonly records: Map<string, unknown>,
    private readonly owner: AtomicFakeIndexedDB,
    private readonly storeName: string,
    private readonly tx: AtomicFakeTransaction,
  ) {}

  add(value: { id: string }): FakeRequest {
    const addNumber = this.storeName === 'clips' ? ++this.owner.assetAddCount : 0;
    return this.tx.request(() => {
      if (this.records.has(value.id)) throw namedError('ConstraintError', `Key ${value.id} already exists`);
      if (this.owner.failAssetAddAt === addNumber) throw namedError('QuotaExceededError', 'Forced Nth asset write failure');
      this.records.set(value.id, value);
      return value.id;
    });
  }

  put(value: { id: string }): FakeRequest {
    return this.tx.request(() => {
      if (this.owner.failProjectPutId === value.id && this.storeName === 'projects') {
        throw namedError('UnknownError', `Forced project record failure for ${value.id}`);
      }
      this.records.set(value.id, value);
      return value.id;
    });
  }

  get(id: string): FakeRequest {
    return this.tx.request(() => this.records.get(id));
  }

  getAllKeys(): FakeRequest {
    return this.tx.request(() => [...this.records.keys()]);
  }

  delete(id: string): FakeRequest {
    return this.tx.request(() => this.records.delete(id));
  }
}

class AtomicFakeDatabase {
  readonly objectStoreNames: { contains: (name: string) => boolean };

  constructor(private readonly owner: AtomicFakeIndexedDB) {
    this.objectStoreNames = { contains: name => owner.stores.has(name) };
  }

  createObjectStore(name: string): void {
    if (!this.owner.stores.has(name)) this.owner.stores.set(name, new Map());
  }

  transaction(storeNames: string | string[], mode: IDBTransactionMode = 'readonly'): AtomicFakeTransaction {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const isBundleTransaction = names.includes('clips') && names.includes('projects') && mode === 'readwrite';
    if (isBundleTransaction && this.owner.beforeNextBundleTransaction) {
      const before = this.owner.beforeNextBundleTransaction;
      this.owner.beforeNextBundleTransaction = null;
      before();
    }
    return new AtomicFakeTransaction(this.owner, names, mode);
  }

  close(): void {}
}

class AtomicFakeIndexedDB {
  readonly stores = new Map<string, Map<string, unknown>>([
    ['clips', new Map()],
    ['projects', new Map()],
  ]);
  readonly bundleTransactionReady = deferred<void>();
  assetAddCount = 0;
  failAssetAddAt: number | null = null;
  failProjectPutId: string | null = null;
  holdNextBundleTransaction = false;
  heldBundleTransaction: AtomicFakeTransaction | null = null;
  beforeNextBundleTransaction: (() => void) | null = null;

  readonly indexedDb = {
    open: () => {
      const request = new FakeRequest<AtomicFakeDatabase>();
      request.result = new AtomicFakeDatabase(this);
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

const installIndexedDb = (database = new AtomicFakeIndexedDB()) => {
  const previous = globalThis.indexedDB;
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: database.indexedDb });
  return {
    database,
    restore: () => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: previous }),
  };
};

const projectState = (name: string, audioIds: string[] = []): ProjectState => {
  const base = createDefaultProjectState();
  return {
    ...base,
    meta: { ...base.meta, name },
    playlistClips: audioIds.map((audioId, index) => ({
      id: `zip-clip-${index}-${audioId}`,
      trackIndex: 0,
      startBar: index + 1,
      lengthBars: 1,
      type: 'audio' as const,
      audioBufferId: audioId,
      audioName: audioId,
      audioWaveform: [0.1, 0.8],
      audioUnavailable: false,
      color: '#ff6e00',
      name: audioId,
    })),
  };
};

interface ZipAudioAsset {
  id: string;
  bytes: Uint8Array;
  mimeType?: string;
}

const makeZip = async (state: ProjectState, assets: ZipAudioAsset[]): Promise<JSZip> => {
  const zip = new JSZip();
  zip.file('project_manifest.json', JSON.stringify(state));
  const audioFiles = assets.map((asset, index) => {
    const path = `audio/${index + 1}_${asset.id}.bin`;
    zip.file(path, asset.bytes);
    return { id: asset.id, path, size: asset.bytes.length, mimeType: asset.mimeType ?? 'audio/wav' };
  });
  zip.file('bundle_manifest.json', JSON.stringify({
    format: 'apex-studio-project-bundle',
    formatVersion: 2,
    audioFiles,
  }));
  return JSZip.loadAsync(await zip.generateAsync({ type: 'uint8array' }));
};

const planZip = async (zip: JSZip): Promise<{ state: ProjectState; plan: BundleAudioImportPlan }> => {
  const projectFile = zip.file('project_manifest.json');
  assert.ok(projectFile);
  const state = JSON.parse(await projectFile.async('string')) as ProjectState;
  const manifestFile = zip.file('bundle_manifest.json');
  assert.ok(manifestFile);
  const manifest: unknown = JSON.parse(await manifestFile.async('string'));
  const entries = getRecognizedBundleAudioFiles(manifest);
  return { state, plan: await planBundleAudioImport(entries, zip, getPersistedAudioClip) };
};

const existingProjectRecords = async () => ({
  current: await getPersistedProjectStateRecord(),
  recovery: await getPersistedProjectRecoverySnapshotRecord(),
});

const storedBytes = async (id: string): Promise<Uint8Array> => {
  const blob = await getPersistedAudioClip(id);
  assert.ok(blob, `expected persisted audio ${id}`);
  return new Uint8Array(await blob.arrayBuffer());
};

const planAssets = (assets: PlannedBundleAudioAsset[]) => assets.map(({ id, blob, mimeType }) => ({ id, blob, mimeType }));

const commitPlan = (state: ProjectState, plan: BundleAudioImportPlan, signal?: AbortSignal) =>
  persistProjectBundleImport(state, planAssets(plan.assetsToPersist), { signal });

const bytes = (seed: number, length: number): Uint8Array => {
  const result = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) result[index] = (seed * 31 + index * 17) % 251;
  return result;
};

test('A — pre-acceptance cancellation skips backup, atomic commit, and publication', async () => {
  let backupCalls = 0;
  let commitCalls = 0;
  let publicationCalls = 0;
  const outcome = await runProjectReplacementAfterBackupAndCommit(
    false,
    async () => { backupCalls += 1; },
    async () => { commitCalls += 1; },
    async () => { publicationCalls += 1; },
  );
  assert.deepEqual(outcome, { committed: false });
  assert.deepEqual([backupCalls, commitCalls, publicationCalls], [0, 0, 0]);
});

test('B — failed outgoing backup preserves current/recovery records and prevents commit', async () => {
  const { restore } = installIndexedDb();
  try {
    const current = projectState('Outgoing project');
    await persistProjectState(current);
    const originalBytes = bytes(1, 16);
    const oldBlob = new Blob([originalBytes], { type: 'audio/wav' });
    await persistProjectBundleImport(current, [{ id: 'outgoing-audio', blob: oldBlob, mimeType: 'audio/wav' }]);
    const before = await existingProjectRecords();
    let commitCalls = 0;
    let publishCalls = 0;
    const failingStorage: ProjectBackupStorage = {
      persistProjectBackupRecord: async () => { throw new Error('forced backup storage failure'); },
      listProjectBackupRecords: async () => [],
      deleteProjectBackupRecord: async () => undefined,
    };

    await assert.rejects(
      runProjectReplacementAfterBackupAndCommit(
        true,
        () => backupProjectBeforeReplacement(current, { storage: failingStorage }),
        async () => { commitCalls += 1; },
        async () => { publishCalls += 1; },
      ),
      ProjectBackupError,
    );
    assert.deepEqual(await existingProjectRecords(), before);
    assert.deepEqual(await storedBytes('outgoing-audio'), originalBytes);
    assert.deepEqual([commitCalls, publishCalls], [0, 0]);
  } finally {
    restore();
  }
});

test('C — an Nth audio add failure rolls back the whole multi-store transaction', async () => {
  const { database, restore } = installIndexedDb();
  try {
    const current = projectState('Old active project');
    await persistProjectState(current);
    const before = await existingProjectRecords();
    const incoming = projectState('Incoming project', ['incoming-audio-one', 'incoming-audio-two']);
    const zip = await makeZip(incoming, [
      { id: 'incoming-audio-one', bytes: bytes(2, 32) },
      { id: 'incoming-audio-two', bytes: bytes(3, 48) },
    ]);
    const { plan } = await planZip(zip);
    database.failAssetAddAt = 2;

    await assert.rejects(
      runBundleImportCommit(plan, {
        accepted: true,
        persist: assets => persistProjectBundleImport(incoming, planAssets(assets)),
      }),
      /Forced Nth asset write failure/,
    );
    assert.deepEqual(await existingProjectRecords(), before);
    assert.equal(await getPersistedAudioClip('incoming-audio-one'), null);
    assert.equal(await getPersistedAudioClip('incoming-audio-two'), null);
  } finally {
    restore();
  }
});

test('D — failure writing either project record rolls back imported audio and the other record', async () => {
  const { database, restore } = installIndexedDb();
  try {
    const current = projectState('Old project');
    await persistProjectState(current);
    const before = await existingProjectRecords();
    const incoming = projectState('Project record failure', ['project-write-audio']);
    const zip = await makeZip(incoming, [{ id: 'project-write-audio', bytes: bytes(4, 24) }]);
    const { plan } = await planZip(zip);
    database.failProjectPutId = 'recovery-snapshot';

    await assert.rejects(
      runBundleImportCommit(plan, {
        accepted: true,
        persist: assets => persistProjectBundleImport(incoming, planAssets(assets)),
      }),
      /Forced project record failure/,
    );
    assert.deepEqual(await existingProjectRecords(), before);
    assert.equal(await getPersistedAudioClip('project-write-audio'), null);
  } finally {
    restore();
  }
});

test('E — real JSZip import backs up, commits, then reloads the same usable audio id', async () => {
  const { restore } = installIndexedDb();
  try {
    const outgoing = projectState('Outgoing project');
    await persistProjectState(outgoing);
    const incomingBytes = bytes(5, 96);
    const incoming = projectState('Imported ZIP project', ['zip-roundtrip-audio']);
    const zip = await makeZip(incoming, [{ id: 'zip-roundtrip-audio', bytes: incomingBytes, mimeType: 'audio/wav' }]);
    const { state: importedState, plan } = await planZip(zip);
    const order: string[] = [];
    let backupRecord: StoredProjectBackup | undefined;
    let reloadedAudioId = '';
    let reloadedAudioBytes: Uint8Array | null = null;

    const outcome = await runProjectReplacementAfterBackupAndCommit(
      true,
      async () => {
        const backedUp = await backupProjectBeforeReplacement(outgoing);
        backupRecord = backedUp.record;
        order.push('backup');
      },
      async () => {
        assert.ok((await listProjectBackupRecords()).some(record => record.id === backupRecord?.id));
        order.push('atomic-commit');
        await runBundleImportCommit(plan, {
          accepted: true,
          persist: assets => persistProjectBundleImport(importedState, planAssets(assets)),
        });
      },
      async () => {
        order.push('reload');
        const restored = await restorePersistedProjectState({
          loadAudioFile: async (blob, id) => {
            reloadedAudioId = id;
            reloadedAudioBytes = new Uint8Array(await blob.arrayBuffer());
            return { buffer: { duration: 1 } as AudioBuffer, peaks: [0.5], duration: 1 };
          },
        }, createDefaultProjectState());
        assert.equal(restored.restored, true);
        assert.deepEqual(restored.hydratedAudioIds, ['zip-roundtrip-audio']);
        return restored;
      },
    );

    assert.equal(outcome.committed, true);
    assert.equal(outcome.value.state.meta.name, 'Imported ZIP project');
    assert.deepEqual(order, ['backup', 'atomic-commit', 'reload']);
    assert.equal(reloadedAudioId, 'zip-roundtrip-audio');
    assert.deepEqual(reloadedAudioBytes, incomingBytes);
    assert.deepEqual(await storedBytes('zip-roundtrip-audio'), incomingBytes);
    const recovery = JSON.parse((await getPersistedProjectRecoverySnapshotRecord())!) as { state: ProjectState };
    assert.equal(recovery.state.meta.name, 'Imported ZIP project');
  } finally {
    restore();
  }
});

test('F — a racing different-byte ID collision aborts without overwriting bytes or project records', async () => {
  const { database, restore } = installIndexedDb();
  try {
    const current = projectState('Current project');
    await persistProjectState(current);
    const before = await existingProjectRecords();
    const incomingBytes = bytes(6, 32);
    const racedBytes = bytes(76, 32);
    const incoming = projectState('Incoming project', ['raced-id', 'brand-new-id']);
    const zip = await makeZip(incoming, [
      { id: 'raced-id', bytes: incomingBytes },
      { id: 'brand-new-id', bytes: bytes(7, 32) },
    ]);
    const { plan } = await planZip(zip);
    database.beforeNextBundleTransaction = () => {
      database.stores.get('clips')!.set('raced-id', {
        id: 'raced-id', blob: new Blob([racedBytes], { type: 'audio/wav' }), mimeType: 'audio/wav', createdAt: 7,
      });
    };

    await assert.rejects(
      runBundleImportCommit(plan, {
        accepted: true,
        persist: assets => persistProjectBundleImport(incoming, planAssets(assets)),
      }),
      ProjectBundleAudioConflictError,
    );
    assert.deepEqual(await existingProjectRecords(), before);
    assert.deepEqual(await storedBytes('raced-id'), racedBytes);
    assert.equal(await getPersistedAudioClip('brand-new-id'), null);
  } finally {
    restore();
  }
});

test('F — identical racing bytes are compared outside the abort and never rewritten', async () => {
  const { database, restore } = installIndexedDb();
  try {
    const incomingBytes = bytes(8, 40);
    const incoming = projectState('Identical race import', ['identical-race-id']);
    const zip = await makeZip(incoming, [{ id: 'identical-race-id', bytes: incomingBytes }]);
    const { plan } = await planZip(zip);
    database.beforeNextBundleTransaction = () => {
      database.stores.get('clips')!.set('identical-race-id', {
        id: 'identical-race-id', blob: new Blob([incomingBytes], { type: 'audio/wav' }), mimeType: 'audio/wav', createdAt: 1,
      });
    };

    const result = await runProjectReplacementAfterBackupAndCommit(
      true,
      undefined,
      () => runBundleImportCommit(plan, {
        accepted: true,
        persist: assets => persistProjectBundleImport(incoming, planAssets(assets)),
      }),
      async () => 'published',
    );
    assert.equal(result.committed, true);
    assert.equal(result.value, 'published');
    const storedRecord = database.stores.get('clips')!.get('identical-race-id') as { createdAt: number };
    assert.equal(storedRecord.createdAt, 1, 'the byte-identical racing record must not be rewritten');
    assert.equal(JSON.parse((await getPersistedProjectStateRecord())!).state.meta.name, 'Identical race import');
  } finally {
    restore();
  }
});

test('G — cancellation during preparation or an active IDB transaction cannot commit', async () => {
  const { database, restore } = installIndexedDb();
  try {
    const current = projectState('Current project');
    await persistProjectState(current);
    const before = await existingProjectRecords();
    const incoming = projectState('Cancelled import', ['cancelled-audio']);
    const zip = await makeZip(incoming, [{ id: 'cancelled-audio', bytes: bytes(9, 24) }]);
    const { plan } = await planZip(zip);
    const controller = new AbortController();
    const prepareStarted = deferred<void>();
    const releasePrepare = deferred<void>();
    let commitCalls = 0;

    const preparing = runBundleImportCommit(plan, {
      accepted: true,
      signal: controller.signal,
      prepare: async () => {
        prepareStarted.resolve();
        await releasePrepare.promise;
      },
      persist: async assets => {
        commitCalls += 1;
        await persistProjectBundleImport(incoming, planAssets(assets), { signal: controller.signal });
      },
    });
    await prepareStarted.promise;
    controller.abort();
    releasePrepare.resolve();
    await assert.rejects(preparing, ProjectBundleCommitCancelledError);
    assert.equal(commitCalls, 0);
    assert.deepEqual(await existingProjectRecords(), before);
    assert.equal(await getPersistedAudioClip('cancelled-audio'), null);

    await assert.rejects(
      runBundleImportCommit(plan, {
        accepted: true,
        isCurrent: () => false,
        persist: async () => { commitCalls += 1; },
      }),
      ProjectBundleCommitCancelledError,
    );
    assert.equal(commitCalls, 0);

    const transactionController = new AbortController();
    database.holdNextBundleTransaction = true;
    const inTransaction = runBundleImportCommit(plan, {
      accepted: true,
      signal: transactionController.signal,
      persist: assets => persistProjectBundleImport(incoming, planAssets(assets), { signal: transactionController.signal }),
    });
    await database.bundleTransactionReady.promise;
    transactionController.abort();
    await assert.rejects(inTransaction, ProjectBundleCommitCancelledError);
    assert.deepEqual(await existingProjectRecords(), before);
    assert.equal(await getPersistedAudioClip('cancelled-audio'), null);
  } finally {
    restore();
  }
});

test('I — a queued outgoing-project save cannot overwrite a completed ZIP transaction', async () => {
  const { database, restore } = installIndexedDb();
  try {
    const outgoing = projectState('Outgoing project');
    await persistProjectState(outgoing);
    const incoming = projectState('Committed ZIP project');
    const audioBlob = new Blob([bytes(12, 24)], { type: 'audio/wav' });
    let saveGenerationCurrent = true;

    database.holdNextBundleTransaction = true;
    const commit = persistProjectBundleImport(
      incoming,
      [{ id: 'queued-import-audio', blob: audioBlob, mimeType: 'audio/wav' }],
      { onCommitted: () => { saveGenerationCurrent = false; } },
    );
    await database.bundleTransactionReady.promise;

    const staleSave = persistProjectState(outgoing, { shouldPersist: () => saveGenerationCurrent });
    assert.ok(database.heldBundleTransaction);
    database.heldBundleTransaction!.releaseHeld();
    await Promise.all([commit, staleSave]);

    assert.equal(JSON.parse((await getPersistedProjectStateRecord())!).state.meta.name, 'Committed ZIP project');
    assert.equal(JSON.parse((await getPersistedProjectRecoverySnapshotRecord())!).state.meta.name, 'Committed ZIP project');
    assert.deepEqual(await storedBytes('queued-import-audio'), new Uint8Array(await audioBlob.arrayBuffer()));
  } finally {
    restore();
  }
});

test('H — recognized manifests are strict; an intentional empty audioFiles list is valid', async () => {
  for (const malformed of [undefined, null, 'not-an-array', {}]) {
    assert.throws(
      () => getRecognizedBundleAudioFiles({ format: 'apex-studio-project-bundle', audioFiles: malformed }),
      (error: unknown) => error instanceof BundleImportError && error.failure === 'malformed-audio-manifest',
    );
  }
  assert.deepEqual(getRecognizedBundleAudioFiles({ format: 'apex-studio-project-bundle', audioFiles: [] }), []);
  assert.deepEqual(getRecognizedBundleAudioFiles({ format: 'unknown-legacy-format', audioFiles: 'ignored' }), []);

  const { restore } = installIndexedDb();
  try {
    await persistProjectState(projectState('Old project'));
    const incoming = projectState('Manifest-only ZIP');
    const zip = await makeZip(incoming, []);
    const { plan } = await planZip(zip);
    assert.deepEqual(plan.assetsToPersist, []);
    assert.deepEqual(plan.alreadyStoredIds, []);
    assert.deepEqual(plan.validatedAssets, []);

    const result = await runProjectReplacementAfterBackupAndCommit(
      true,
      undefined,
      () => runBundleImportCommit(plan, {
        accepted: true,
        persist: assets => commitPlan(incoming, { ...plan, assetsToPersist: assets }),
      }),
      async () => 'published',
    );
    assert.equal(result.committed, true);
    assert.equal(result.value, 'published');
    assert.equal(JSON.parse((await getPersistedProjectStateRecord())!).state.meta.name, 'Manifest-only ZIP');
  } finally {
    restore();
  }
});
