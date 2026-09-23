/**
 * Phase 8A — MVP release blocker regression coverage.
 *
 * 1. Real React TypeScript safety stays wired up (types installed + compile-time guard).
 * 2. Dropped / bounced playlist audio registered through the engine is persisted and rehydrates.
 * 3. Imported Sample Manager audio is persisted under the sample id.
 * 4. Replacing a project with work requires confirmation, writes a restorable backup,
 *    honours the retention limit and never lets reconciliation purge backed-up audio.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { audioEngine } from './audioEngine';
import {
  PROJECT_BACKUP_ID_PREFIX,
  deletePersistedAudioClip,
  deletePersistedProjectState,
  getPersistedAudioClip,
  listPersistedAudioClipIds,
  listProjectBackupRecords,
  persistAudioClip,
  type StoredProjectBackup
} from './audioPersistence';
import { commitAfterSampleBufferPersistence, encodeSampleBufferForStorage, installSampleBufferPersistence } from './sampleBufferPersistence';
import { importSampleFile } from './sampleImport';
import { PRESET_PROJECTS } from './presets';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { createHistory, sanitizeProjectSnapshot } from '../state/projectHistory';
import {
  getAudioIdsForProject,
  getAudioIdsFromStoredBackup,
  hydrateProjectAudio,
  persistProjectState,
  reconcilePersistedAudio,
  saveAndReconcileProjectState,
  serializeProjectState
} from '../state/projectPersistence';
import {
  MAX_PROJECT_BACKUPS,
  ProjectBackupError,
  backupProjectBeforeReplacement,
  createProjectBackupRecord,
  deleteProjectBackup,
  getAudioIdsReferencedByBackups,
  listProjectBackups,
  restoreProjectBackupState,
  type ProjectBackupStorage
} from '../state/projectBackup';
import { getProjectFingerprint, isPristineProject, planProjectReplacement, runProjectReplacementAfterBackup } from '../state/projectReplacement';
import type { AudioRecording, Channel, PlaylistClip, ProjectState } from '../types/daw';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

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
  get(id: string): FakeRequest {
    const request = new FakeRequest();
    request.result = this.store.get(id);
    queueMicrotask(() => request.onsuccess?.());
    return request;
  }
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
  return {
    db,
    restore: () => Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: previous })
  };
};

class MockAudioBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
    fill?: (channel: number, index: number) => number
  ) {
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, (_, channel) => {
      const data = new Float32Array(length);
      if (fill) for (let i = 0; i < length; i++) data[i] = fill(channel, i);
      return data;
    });
  }

  getChannelData(channel: number): Float32Array { return this.channels[channel]; }
  copyToChannel(source: Float32Array, channel: number): void { this.channels[channel].set(source.subarray(0, this.length)); }
  copyFromChannel(destination: Float32Array, channel: number): void { destination.set(this.channels[channel].subarray(0, destination.length)); }
}

const asAudioBuffer = (buffer: MockAudioBuffer): AudioBuffer => buffer as unknown as AudioBuffer;

class MockOfflineAudioContext {
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {}
  createBuffer(channels: number, length: number, sampleRate: number): MockAudioBuffer {
    return new MockAudioBuffer(channels, length, sampleRate);
  }
}

const createFakeEngine = () => {
  const sampleBuffers = new Map<string, AudioBuffer>();
  const loadCalls: Array<{ id: string; blob: Blob }> = [];
  return {
    sampleBuffers,
    loadCalls,
    setSampleBuffer(id: string, buffer: AudioBuffer): void { sampleBuffers.set(id, buffer); },
    getSampleBuffer(id: string): AudioBuffer | undefined { return sampleBuffers.get(id); },
    async loadAudioFile(file: File | Blob, id: string) {
      loadCalls.push({ id, blob: file });
      const buffer = asAudioBuffer(new MockAudioBuffer(2, 4410, 44100));
      sampleBuffers.set(id, buffer);
      return { buffer, peaks: [0.5, 0.25], duration: buffer.duration };
    }
  };
};

const createMemoryBackupStorage = (): ProjectBackupStorage & { records: Map<string, StoredProjectBackup> } => {
  const records = new Map<string, StoredProjectBackup>();
  return {
    records,
    async persistProjectBackupRecord(record) { records.set(record.id, { ...record }); },
    async listProjectBackupRecords() { return [...records.values()].map(record => ({ ...record })); },
    async deleteProjectBackupRecord(id) { records.delete(id); }
  };
};

interface ParsedWav {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  samples: Float32Array;
}

const parseFloatWav = async (blob: Blob): Promise<ParsedWav> => {
  const view = new DataView(await blob.arrayBuffer());
  const tag = (offset: number) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(12), 'fmt ');
  assert.equal(tag(36), 'data');
  const dataLength = view.getUint32(40, true);
  const samples = new Float32Array(dataLength / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getFloat32(44 + i * 4, true);
  return {
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    samples
  };
};

const audioClip = (id: string, audioBufferId: string, name = id): PlaylistClip => ({
  id,
  trackIndex: 1,
  startBar: 0,
  lengthBars: 4,
  type: 'audio',
  audioBufferId,
  audioName: name,
  audioWaveform: [0.2, 0.8],
  color: '#00ff88',
  name
});

/** A project that clearly contains user work referencing every kind of audio asset. */
const createWorkingProject = (): { state: ProjectState; audioIds: { recording: string; dropped: string; bounced: string; sample: string } } => {
  const base = createDefaultProjectState();
  const recording: AudioRecording = {
    id: 'take-1',
    name: 'Vocal Take',
    timestamp: 1000,
    durationSeconds: 2,
    waveform: [0.1, 0.9],
    audioBufferId: 'recording-take-1',
    audioBlob: new Blob(['recorded-bytes'], { type: 'audio/webm' }),
    audioUrl: 'blob:session-only'
  };
  const sampleChannel: Channel = {
    ...base.channels[0],
    id: 'ch-sample',
    name: 'Sampler',
    mixerTrackId: 3,
    customSample: {
      id: 'sample-42',
      name: 'Imported Hit',
      duration: 0.5,
      sampleRate: 44100,
      channels: 1,
      waveformPeaks: [0.4],
      blob: new Blob(['sample-bytes'], { type: 'audio/wav' })
    }
  };
  const state: ProjectState = {
    ...base,
    meta: { ...base.meta, name: 'My Working Song' },
    channels: [...base.channels, sampleChannel],
    recordings: [recording],
    playlistClips: [
      audioClip('rec-clip', 'recording-take-1', 'Vocal Take'),
      audioClip('drop-clip', 'dropped-sample-1700000000000', 'loop.wav'),
      audioClip('bounce-clip', 'bounced-clip-1700000000001', 'Kick [Stem]')
    ]
  };
  return {
    state,
    audioIds: { recording: 'recording-take-1', dropped: 'dropped-sample-1700000000000', bounced: 'bounced-clip-1700000000001', sample: 'sample-42' }
  };
};

const withTimeout = async <T>(promise: Promise<T>, ms = 5000): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms); });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// 1. Real React TypeScript safety
// ---------------------------------------------------------------------------

describe('Phase 8A: real React TypeScript safety', () => {
  test('React type packages are declared and resolvable so tsc checks JSX, hooks and props', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
    assert.ok(pkg.devDependencies?.['@types/react'], '@types/react must be a devDependency');
    assert.ok(pkg.devDependencies?.['@types/react-dom'], '@types/react-dom must be a devDependency');

    const reactTypes = require('@types/react/package.json') as { version: string };
    const reactDomTypes = require('@types/react-dom/package.json') as { version: string };
    const react = require('react/package.json') as { version: string };
    assert.equal(reactTypes.version.split('.')[0], react.version.split('.')[0], '@types/react major must match react');
    assert.equal(reactDomTypes.version.split('.')[0], react.version.split('.')[0], '@types/react-dom major must match react');
  });

  test('the compile-time guard is present and only passes when React types are real', () => {
    const guard = readFileSync(path.join(repoRoot, 'src', 'types', 'reactTypeSafety.typecheck.tsx'), 'utf8');
    // Each @ts-expect-error only stays "used" while React exposes real types; `any` would make tsc fail.
    assert.equal((guard.match(/^\s*\/\/ @ts-expect-error/gm) || []).length, 2);
    assert.match(guard, /useState\(0\)/);
    assert.match(guard, /<GuardComponent \/>/);

    const tsconfig = JSON.parse(readFileSync(path.join(repoRoot, 'tsconfig.json'), 'utf8')) as { compilerOptions: { jsx: string } };
    assert.equal(tsconfig.compilerOptions.jsx, 'react-jsx');
  });
});

// ---------------------------------------------------------------------------
// 2. Dropped / bounced playlist audio persistence
// ---------------------------------------------------------------------------

describe('Phase 8A: dropped and bounced playlist audio persists across reloads', () => {
  test('setSampleBuffer registers in memory first, persists a lossless WAV under the same id, and hydration restores the clip', async () => {
    const { restore } = installIndexedDbMock();
    try {
      const engine = createFakeEngine();
      const controller = installSampleBufferPersistence(engine);
      const droppedId = 'dropped-sample-1700000000000';
      const buffer = new MockAudioBuffer(2, 256, 48000, (channel, index) => (channel === 0 ? Math.sin(index / 7) : -index / 512));

      engine.setSampleBuffer(droppedId, asAudioBuffer(buffer));
      assert.equal(engine.getSampleBuffer(droppedId), asAudioBuffer(buffer), 'in-memory registration must be synchronous');
      assert.deepEqual(controller.getPendingIds(), [droppedId]);

      await withTimeout(controller.flush());
      assert.deepEqual(controller.getPendingIds(), []);

      const persisted = await getPersistedAudioClip(droppedId);
      assert.ok(persisted, 'the dropped audio must be written to persistent storage');
      assert.equal(persisted.type, 'audio/wav');
      assert.equal(persisted.size, 44 + 256 * 2 * 4);

      const wav = await parseFloatWav(persisted);
      assert.equal(wav.format, 3, '32-bit float WAV keeps the AudioBuffer data lossless');
      assert.equal(wav.bitsPerSample, 32);
      assert.equal(wav.channels, 2);
      assert.equal(wav.sampleRate, 48000);
      for (let i = 0; i < 256; i++) {
        assert.equal(wav.samples[i * 2], buffer.getChannelData(0)[i]);
        assert.equal(wav.samples[i * 2 + 1], buffer.getChannelData(1)[i]);
      }

      // Reload: a fresh engine has nothing in memory, hydration must bring the clip back from storage.
      const reloadedEngine = createFakeEngine();
      const project: ProjectState = { ...createDefaultProjectState(), playlistClips: [audioClip('drop-clip', droppedId, 'loop.wav')] };
      const hydrated = await hydrateProjectAudio(project, reloadedEngine);
      assert.deepEqual(hydrated.hydratedAudioIds, [droppedId]);
      assert.deepEqual(hydrated.missingAudioIds, []);
      assert.equal(hydrated.state.playlistClips[0].audioUnavailable, false);
      assert.equal(reloadedEngine.loadCalls.length, 1);
      assert.equal(reloadedEngine.loadCalls[0].id, droppedId);
      assert.equal(reloadedEngine.loadCalls[0].blob.size, persisted.size);
      assert.ok(reloadedEngine.getSampleBuffer(droppedId));
    } finally {
      await deletePersistedAudioClip('dropped-sample-1700000000000').catch(() => undefined);
      restore();
    }
  });

  test('bounced stems persist through the caller registration while the engine-internal alias stays session-only', async () => {
    const persistedIds: string[] = [];
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { OfflineAudioContext: MockOfflineAudioContext };
    try {
      const controller = installSampleBufferPersistence(audioEngine, {
        persistAudioClip: async (id) => { persistedIds.push(id); }
      });
      const channel = createDefaultProjectState().channels[0];

      // Same sequence as PlaylistArranger.handleBounceTrack.
      const { buffer, waveform } = await audioEngine.bounceChannelToAudioClip(channel, 130, 1);
      const bounceClipId = 'bounced-clip-1700000000001';
      audioEngine.setSampleBuffer(bounceClipId, buffer);
      await withTimeout(controller.flush());

      assert.equal(waveform.length, 32);
      assert.equal(audioEngine.getSampleBuffer(bounceClipId), buffer);
      assert.deepEqual(persistedIds, [bounceClipId], 'only the clip asset id is persisted');

      const internalAliases = audioEngine.getSampleBufferIds().filter(id => id.startsWith(`bounced-${channel.id}-`));
      assert.equal(internalAliases.length, 1, 'the engine still keeps its session-only alias');
      assert.ok(!persistedIds.includes(internalAliases[0]));
    } finally {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
  });

  test('playlist clip references wait for pending persistence before committing', async () => {
    const engine = createFakeEngine();
    let releasePersistence!: () => void;
    let persistenceStarted!: () => void;
    const started = new Promise<void>(resolve => { persistenceStarted = resolve; });
    const persistenceFinished = new Promise<void>(resolve => { releasePersistence = resolve; });
    installSampleBufferPersistence(engine, {
      persistAudioClip: async () => {
        persistenceStarted();
        await persistenceFinished;
      }
    });

    const references: string[] = [];
    const droppedId = 'dropped-sample-pending';
    engine.setSampleBuffer(droppedId, asAudioBuffer(new MockAudioBuffer(1, 16, 44100)));
    const commit = commitAfterSampleBufferPersistence(engine, droppedId, () => references.push(droppedId));
    assert.deepEqual(references, [], 'the dropped clip reference must not be committed while persistence is pending');

    await started;
    assert.deepEqual(references, []);
    releasePersistence();
    await commit;
    assert.deepEqual(references, [droppedId], 'the reference may commit after persistence succeeds');
  });

  test('dropped and bounced clip references are not committed when persistence fails', async () => {
    for (const id of ['dropped-sample-failure', 'bounced-clip-failure']) {
      const engine = createFakeEngine();
      installSampleBufferPersistence(engine, {
        persistAudioClip: async () => { throw new Error(`persist failed for ${id}`); }
      });
      const references: string[] = [];
      engine.setSampleBuffer(id, asAudioBuffer(new MockAudioBuffer(1, 16, 44100)));

      await assert.rejects(
        commitAfterSampleBufferPersistence(engine, id, () => references.push(id)),
        new RegExp(`persist failed for ${id}`)
      );
      assert.deepEqual(references, [], `${id} must not become a project clip reference after persistence failure`);
    }
  });

  test('a storage failure never breaks in-session playback registration', async () => {
    const engine = createFakeEngine();
    const errors: Array<{ id: string; error: unknown }> = [];
    const controller = installSampleBufferPersistence(engine, {
      persistAudioClip: async () => { throw new Error('QuotaExceededError'); },
      onError: (id, error) => errors.push({ id, error })
    });
    const buffer = asAudioBuffer(new MockAudioBuffer(1, 16, 44100, () => 0.5));

    engine.setSampleBuffer('dropped-sample-2', buffer);
    assert.equal(engine.getSampleBuffer('dropped-sample-2'), buffer);
    await assert.rejects(withTimeout(controller.flush()), /QuotaExceededError/);

    assert.equal(errors.length, 1);
    assert.equal(errors[0].id, 'dropped-sample-2');
    assert.match(String((errors[0].error as Error).message), /QuotaExceededError/);
  });

  test('installation is idempotent and honours the session-only filter', async () => {
    const engine = createFakeEngine();
    const persistedIds: string[] = [];
    const first = installSampleBufferPersistence(engine, {
      persistAudioClip: async (id) => { persistedIds.push(id); },
      shouldPersist: (id) => !id.startsWith('preview-')
    });
    const second = installSampleBufferPersistence(engine);
    assert.equal(first, second, 'a second install must not wrap setSampleBuffer twice');

    const buffer = asAudioBuffer(new MockAudioBuffer(1, 8, 44100));
    engine.setSampleBuffer('preview-1', buffer);
    engine.setSampleBuffer('dropped-sample-3', buffer);
    await withTimeout(first.flush());

    assert.deepEqual(persistedIds, ['dropped-sample-3']);
    assert.ok(engine.getSampleBuffer('preview-1'));
  });

  test('encodeSampleBufferForStorage produces a decodable float WAV for mono buffers too', async () => {
    const buffer = new MockAudioBuffer(1, 10, 22050, (_, index) => index / 10);
    const wav = await parseFloatWav(encodeSampleBufferForStorage(asAudioBuffer(buffer)));
    assert.equal(wav.channels, 1);
    assert.equal(wav.sampleRate, 22050);
    assert.deepEqual([...wav.samples], [...buffer.getChannelData(0)]);
  });
});

// ---------------------------------------------------------------------------
// 3. Imported sample persistence
// ---------------------------------------------------------------------------

describe('Phase 8A: Sample Manager imports persist the original file', () => {
  test('a decoded import is stored under the sample id referenced by channel.customSample', async () => {
    const { restore } = installIndexedDbMock();
    try {
      const engine = createFakeEngine();
      const file = new File(['imported-sample-bytes'], 'Vinyl Kick.wav', { type: 'audio/wav' });
      const { sample, persisted } = await importSampleFile(file, { engine, now: 1700000000123 });

      assert.equal(persisted, true);
      assert.equal(sample.id, 'sample-1700000000123');
      assert.equal(sample.name, 'Vinyl Kick');
      assert.equal(sample.channels, 2);
      assert.equal(sample.sampleRate, 44100);
      assert.deepEqual(sample.waveformPeaks, [0.5, 0.25]);
      assert.equal(engine.loadCalls[0].id, sample.id);

      const stored = await getPersistedAudioClip(sample.id);
      assert.ok(stored);
      assert.equal(await stored.text(), 'imported-sample-bytes', 'the original bytes are persisted, not a re-encode');
      assert.equal(stored.type, 'audio/wav');

      // The project references the sample through the channel, so hydration restores it after a reload.
      const base = createDefaultProjectState();
      const project: ProjectState = { ...base, channels: [{ ...base.channels[0], customSample: sample }] };
      assert.deepEqual(getAudioIdsForProject(project), [sample.id]);
      const reloaded = createFakeEngine();
      const hydrated = await hydrateProjectAudio(project, reloaded);
      assert.deepEqual(hydrated.hydratedAudioIds, [sample.id]);
      assert.equal(await reloaded.loadCalls[0].blob.text(), 'imported-sample-bytes');
    } finally {
      await deletePersistedAudioClip('sample-1700000000123').catch(() => undefined);
      restore();
    }
  });

  test('an undecodable file is never persisted and a storage failure keeps the in-session sample usable', async () => {
    const persistCalls: string[] = [];
    await assert.rejects(
      importSampleFile(new Blob(['garbage']), {
        engine: { loadAudioFile: async () => { throw new Error('Unable to decode audio data'); } },
        persistAudioClip: async (id) => { persistCalls.push(id); }
      }),
      /Unable to decode audio data/
    );
    assert.deepEqual(persistCalls, []);

    const engine = createFakeEngine();
    const reported: string[] = [];
    const { sample, persisted } = await importSampleFile(new File(['x'], 'clap.mp3'), {
      engine,
      id: 'sample-fixed',
      persistAudioClip: async () => { throw new Error('IndexedDB is not available in this environment'); },
      onPersistError: (id) => reported.push(id)
    });
    assert.equal(persisted, false);
    assert.equal(sample, null, 'a failed persistence result cannot be attached to a project');
    assert.deepEqual(reported, ['sample-fixed']);
    assert.ok(engine.getSampleBuffer('sample-fixed'), 'the sample still plays for the current session');

    const unchangedProject = createDefaultProjectState();
    const projectAfterFailedImport: ProjectState = {
      ...unchangedProject,
      channels: unchangedProject.channels.map(channel =>
        persisted && sample ? { ...channel, customSample: sample } : channel
      )
    };
    assert.equal(projectAfterFailedImport.channels[0].customSample, undefined, 'failed imported audio must not create a customSample project reference');
  });
});

// ---------------------------------------------------------------------------
// 4. Destructive project replacement: confirmation policy + backup
// ---------------------------------------------------------------------------

describe('Phase 8A: project replacement requires confirmation and keeps a backup', () => {
  test('backup errors expose retry/cancel only; there is no replace-without-backup path', () => {
    const modal = readFileSync(path.join(repoRoot, 'src', 'components', 'ProjectReplaceConfirmModal.tsx'), 'utf8');
    const app = readFileSync(path.join(repoRoot, 'src', 'App.tsx'), 'utf8');
    assert.doesNotMatch(modal, /Replace Without Backup|onConfirmWithoutBackup/);
    assert.match(modal, /Retry the backup or keep the current project/);
    assert.doesNotMatch(app, /onConfirmWithoutBackup|confirmPendingReplacement\(false\)/);
  });

  test('backup failure blocks stop, hydration, reconciliation, and replacement; cancel is safe; retry succeeds', async () => {
    const currentProject = { name: 'current project' };
    const incomingProject = { name: 'incoming project' };
    let activeProject = currentProject;
    let shouldFailBackup = true;
    const calls: string[] = [];
    const replace = async () => {
      calls.push('handleStop');
      calls.push('hydrate incoming project');
      calls.push('reconcile/delete audio');
      activeProject = incomingProject;
    };
    const attemptReplacement = () => runProjectReplacementAfterBackup(
      async () => {
        calls.push('backup');
        if (shouldFailBackup) throw new ProjectBackupError('Project backup failed: storage unavailable');
      },
      replace
    );

    await assert.rejects(attemptReplacement, ProjectBackupError);
    assert.deepEqual(calls, ['backup'], 'backup failure must stop before any destructive replacement work');
    assert.equal(activeProject, currentProject, 'backup failure must leave the current project active');

    // Cancelling the failed confirmation performs no replacement work.
    calls.length = 0;
    assert.equal(activeProject, currentProject);
    assert.deepEqual(calls, [], 'cancellation leaves the current project unchanged');

    shouldFailBackup = false;
    await attemptReplacement();
    assert.deepEqual(calls, ['backup', 'handleStop', 'hydrate incoming project', 'reconcile/delete audio']);
    assert.equal(activeProject, incomingProject, 'retry after a successful backup permits replacement');
  });

  test('pristine templates are replaced without confirmation, projects with work are not', () => {
    const blank = createDefaultProjectState();
    const incoming = structuredClone(PRESET_PROJECTS[0].state);

    const blankPlan = planProjectReplacement(blank, incoming, { source: 'studio-demo' });
    assert.equal(blankPlan.requiresConfirmation, false);
    assert.equal(blankPlan.shouldBackup, false);
    assert.equal(blankPlan.reason, 'pristine-current');
    assert.equal(blankPlan.source, 'studio-demo');
    assert.equal(blankPlan.incomingName, PRESET_PROJECTS[0].state.meta.name);

    // An untouched demo stays pristine even after a persistence round trip and UI selection changes.
    const demo = structuredClone(PRESET_PROJECTS[1].state);
    const roundTripped = normalizeProjectState(JSON.parse(serializeProjectState(normalizeProjectState(demo))).state);
    const reselected: ProjectState = {
      ...roundTripped,
      selectedPatternId: roundTripped.patterns[roundTripped.patterns.length - 1].id,
      selectedMixerTrackId: 2,
      meta: { ...roundTripped.meta, updated: Date.now(), created: 1 }
    };
    assert.equal(isPristineProject(reselected), true);
    assert.equal(planProjectReplacement(reselected, blank, { source: 'new-session' }).requiresConfirmation, false);

    // Real work: a note in a channel.
    const edited: ProjectState = {
      ...roundTripped,
      channels: roundTripped.channels.map((channel, index) => index === 0
        ? { ...channel, notes: [...channel.notes, { id: 'n1', pitch: 60, start: 0, duration: 1, velocity: 0.9 }] }
        : channel)
    };
    const editedPlan = planProjectReplacement(edited, incoming, { source: 'manifest-import' });
    assert.equal(editedPlan.requiresConfirmation, true);
    assert.equal(editedPlan.shouldBackup, true);
    assert.equal(editedPlan.reason, 'current-has-work');
    assert.equal(editedPlan.currentName, roundTripped.meta.name);

    // Renaming alone is user work worth protecting as well.
    const renamed: ProjectState = { ...blank, meta: { ...blank.meta, name: 'Late Night Idea' } };
    assert.equal(planProjectReplacement(renamed, incoming).requiresConfirmation, true);
    assert.equal(planProjectReplacement(renamed, incoming).source, 'unknown');

    // Fingerprints ignore volatile ids/timestamps but not content.
    assert.equal(getProjectFingerprint(blank), getProjectFingerprint(createDefaultProjectState()));
    assert.notEqual(getProjectFingerprint(blank), getProjectFingerprint(renamed));
  });

  test('a backup is a restorable, blob-free snapshot with useful summary data', async () => {
    const storage = createMemoryBackupStorage();
    const { state, audioIds } = createWorkingProject();

    const { record, removedIds } = await backupProjectBeforeReplacement(state, { storage, now: 1700000005000, reason: 'replace' });
    assert.deepEqual(removedIds, []);
    assert.ok(record.id.startsWith(PROJECT_BACKUP_ID_PREFIX));
    assert.equal(record.name, 'My Working Song');
    assert.equal(record.reason, 'replace');
    assert.equal(record.createdAt, 1700000005000);
    assert.equal(record.stateJson.includes('recorded-bytes'), false, 'binary audio is never serialized');
    assert.equal(record.stateJson.includes('blob:session-only'), false, 'session URLs are never serialized');
    assert.equal(record.stateJson.includes('sample-bytes'), false);

    const summaries = await listProjectBackups(storage);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].id, record.id);
    assert.equal(summaries[0].channelCount, 3);
    assert.equal(summaries[0].clipCount, 3);
    assert.equal(summaries[0].recordingCount, 1);
    assert.deepEqual([...summaries[0].audioIds].sort(), Object.values(audioIds).sort());

    const restored = await restoreProjectBackupState(record.id, storage);
    assert.ok(restored);
    assert.deepEqual(sanitizeProjectSnapshot(restored), sanitizeProjectSnapshot(state));
    assert.equal(restored.recordings[0].audioBufferId, audioIds.recording);
    assert.equal(restored.channels[2].customSample?.id, audioIds.sample);

    assert.equal(await restoreProjectBackupState(`${PROJECT_BACKUP_ID_PREFIX}missing`, storage), null);
    await deleteProjectBackup(record.id, storage);
    assert.deepEqual(await listProjectBackups(storage), []);
  });

  test('only the newest backups are retained', async () => {
    const storage = createMemoryBackupStorage();
    const { state } = createWorkingProject();
    const results = [];
    for (let i = 0; i < MAX_PROJECT_BACKUPS + 2; i++) {
      results.push(await backupProjectBeforeReplacement({ ...state, meta: { ...state.meta, name: `Song ${i}` } }, { storage, now: 1700000000000 + i * 1000 }));
    }

    const retained = await listProjectBackups(storage);
    assert.equal(retained.length, MAX_PROJECT_BACKUPS);
    assert.deepEqual(retained.map(backup => backup.name), ['Song 6', 'Song 5', 'Song 4', 'Song 3', 'Song 2']);
    assert.deepEqual(results[MAX_PROJECT_BACKUPS].removedIds, [results[0].record.id]);
    assert.deepEqual(results[MAX_PROJECT_BACKUPS + 1].removedIds, [results[1].record.id]);

    // A smaller explicit limit is honoured too.
    await backupProjectBeforeReplacement(state, { storage, now: 1700000100000, maxBackups: 2 });
    assert.equal((await listProjectBackups(storage)).length, 2);
  });

  test('a failed backup surfaces as ProjectBackupError and leaves existing backups untouched', async () => {
    const storage = createMemoryBackupStorage();
    const { state } = createWorkingProject();
    const existing = await backupProjectBeforeReplacement(state, { storage, now: 1 });

    const failing: ProjectBackupStorage = {
      ...storage,
      persistProjectBackupRecord: async () => { throw new Error('QuotaExceededError'); }
    };
    await assert.rejects(
      backupProjectBeforeReplacement(state, { storage: failing, now: 2 }),
      (error: unknown) => error instanceof ProjectBackupError && /QuotaExceededError/.test(error.message)
    );
    assert.deepEqual((await listProjectBackups(storage)).map(backup => backup.id), [existing.record.id]);

    assert.throws(() => createProjectBackupRecord(state, { id: 'not-a-backup-id' }), ProjectBackupError);
  });

  test('replacing a project keeps its audio in storage while a backup references it, and releases it once the backup is gone', async () => {
    const { restore } = installIndexedDbMock();
    const { state, audioIds } = createWorkingProject();
    const ids = Object.values(audioIds);
    try {
      for (const id of ids) await persistAudioClip(id, new Blob([`audio:${id}`], { type: 'audio/wav' }));
      await persistProjectState(state);

      // Step 1: the confirm dialog's "Back Up & Replace" path.
      const { record } = await backupProjectBeforeReplacement(state, { now: 1700000009000 });
      const storedBackups = await listProjectBackupRecords();
      assert.deepEqual(storedBackups.map(backup => backup.id), [record.id]);
      assert.deepEqual([...await getAudioIdsReferencedByBackups()].sort(), [...ids].sort());

      // Step 2: the incoming project is loaded, history is reset, and the load performs a reconciling save.
      const incoming = normalizeProjectState(structuredClone(PRESET_PROJECTS[0].state));
      const reconciled = await saveAndReconcileProjectState(incoming, { reconcileAudio: true, history: createHistory(incoming) });
      assert.ok(reconciled);
      assert.deepEqual(reconciled.removedIds, [], 'audio referenced only by the backup must survive the replacement');
      assert.deepEqual([...reconciled.preservedIds].sort(), [...ids].sort());
      for (const id of ids) {
        const blob = await getPersistedAudioClip(id);
        assert.ok(blob, `${id} must still be restorable`);
        assert.equal(await blob.text(), `audio:${id}`);
      }

      // Step 3: restoring the backup brings the full project (with audio) back.
      const restoredState = await restoreProjectBackupState(record.id);
      assert.ok(restoredState);
      const engine = createFakeEngine();
      const hydrated = await hydrateProjectAudio(restoredState, engine);
      assert.deepEqual([...hydrated.hydratedAudioIds].sort(), [...ids].sort());
      assert.deepEqual(hydrated.missingAudioIds, []);
      assert.ok(hydrated.state.playlistClips.every(clip => clip.audioUnavailable === false));

      // Step 4: once the backup is deleted the orphaned audio is reclaimed by the next reconcile.
      await deleteProjectBackup(record.id);
      const afterDelete = await reconcilePersistedAudio(incoming, { history: createHistory(incoming) });
      assert.deepEqual([...afterDelete.removedIds].sort(), [...ids].sort());
      assert.deepEqual(await listPersistedAudioClipIds(), []);
    } finally {
      for (const id of ids) await deletePersistedAudioClip(id).catch(() => undefined);
      for (const backup of await listProjectBackupRecords().catch(() => [] as StoredProjectBackup[])) await deleteProjectBackup(backup.id).catch(() => undefined);
      await deletePersistedProjectState().catch(() => undefined);
      restore();
    }
  });

  test('reconciliation refuses to delete anything when the backups cannot be enumerated', async () => {
    const { restore } = installIndexedDbMock();
    try {
      await persistAudioClip('orphan-1', new Blob(['orphan'], { type: 'audio/wav' }));
      const blank = createDefaultProjectState();

      const result = await saveAndReconcileProjectState(blank, {
        reconcileAudio: true,
        storage: {
          listPersistedAudioClipIds,
          deletePersistedAudioClip,
          listProjectBackupRecords: async () => { throw new Error('Backup store unavailable'); }
        }
      });
      assert.equal(result, null, 'the save succeeds but reconciliation is aborted');
      assert.ok(await getPersistedAudioClip('orphan-1'), 'nothing may be deleted when backup references are unknown');

      // Corrupt backup documents contribute no references but do not block reconciliation either.
      assert.deepEqual(getAudioIdsFromStoredBackup({ stateJson: '{not json' }), []);
      assert.deepEqual(getAudioIdsFromStoredBackup({ stateJson: 'null' }), []);
      assert.deepEqual(
        getAudioIdsFromStoredBackup({ stateJson: JSON.stringify({ persistenceVersion: 1, state: { playlistClips: [audioClip('c', 'dropped-sample-9')] } }) }),
        ['dropped-sample-9']
      );
    } finally {
      await deletePersistedAudioClip('orphan-1').catch(() => undefined);
      await deletePersistedProjectState().catch(() => undefined);
      restore();
    }
  });
});
