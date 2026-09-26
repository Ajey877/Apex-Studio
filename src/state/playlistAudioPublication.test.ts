import assert from 'node:assert/strict';
import test from 'node:test';
import { installSampleBufferPersistence, waitForSampleBufferPersistence } from '../audio/sampleBufferPersistence';
import {
  advancePlaylistAudioProjectGeneration,
  captureCurrentPlaylistAudioPublicationToken,
  isCurrentPlaylistAudioPublication,
} from './playlistAudioPublication';
import { runProjectReplacementAfterBackup } from './projectReplacement';
import { synchronizeBeforeRuntimePublication } from './runtimeStatePublication';
import { DEFAULT_PROJECT } from '../audio/presets';
import type { ProjectState } from '../types/daw';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

const deferred = (): Deferred => {
  let resolve!: Deferred['resolve'];
  let reject!: Deferred['reject'];
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = rej;
  });
  return { promise, resolve, reject };
};

const createFakeEngine = () => {
  const buffers = new Map<string, AudioBuffer>();
  return {
    setSampleBuffer(id: string, buffer: AudioBuffer) {
      buffers.set(id, buffer);
    },
    buffers,
  };
};

const makeState = (playlistClips: ProjectState['playlistClips']): ProjectState => ({
  ...DEFAULT_PROJECT,
  playlistClips,
});

const startBlockedPersistence = async (id: string) => {
  const engine = createFakeEngine();
  const persistStarted = deferred();
  const releasePersistence = deferred();

  installSampleBufferPersistence(engine, {
    encode: () => new Blob(['wav'], { type: 'audio/wav' }),
    persistAudioClip: async () => {
      persistStarted.resolve();
      await releasePersistence.promise;
    },
  });

  engine.setSampleBuffer(id, {} as AudioBuffer);
  const wait = waitForSampleBufferPersistence(engine, id);
  await persistStarted.promise;

  return { wait, releasePersistence };
};

test('DROPPED AUDIO + PROJECT REPLACEMENT rejects stale publication', async () => {
  const { wait, releasePersistence } = await startBlockedPersistence('dropped-project-audio');
  let published = false;

  const publication = wait.then(() => {
    published = true;
  });

  await runProjectReplacementAfterBackup(undefined, async () => undefined);
  releasePersistence.resolve();

  await assert.rejects(publication, /Stale playlist audio publication rejected/);
  assert.equal(published, false);
});

test('BOUNCE + PROJECT REPLACEMENT rejects stale publication', async () => {
  const { wait, releasePersistence } = await startBlockedPersistence('bounced-project-audio');
  let published = false;

  const publication = wait.then(() => {
    published = true;
  });

  await runProjectReplacementAfterBackup(undefined, async () => undefined);
  releasePersistence.resolve();

  await assert.rejects(publication, /Stale playlist audio publication rejected/);
  assert.equal(published, false);
});

test('SAME-PROJECT INTERVENING EDIT rejects stale captured playlist state', async () => {
  const { wait, releasePersistence } = await startBlockedPersistence('same-project-audio');
  let published = false;
  const currentClips = [...DEFAULT_PROJECT.playlistClips];
  const editedClips = currentClips.map((clip, index) => index === 0 ? { ...clip, startBar: clip.startBar + 1 } : clip);

  const publication = wait.then(() => {
    published = true;
  });

  const current = makeState(currentClips);
  const edited = makeState(editedClips);
  synchronizeBeforeRuntimePublication(
    current,
    edited,
    () => undefined,
    state => state,
  );

  releasePersistence.resolve();

  await assert.rejects(publication, /Stale playlist audio publication rejected/);
  assert.deepEqual(edited.playlistClips, editedClips);
  assert.equal(published, false);
});

test('PERSISTENCE FAILURE never publishes a playlist clip', async () => {
  const engine = createFakeEngine();
  const expected = new Error('quota exceeded');

  installSampleBufferPersistence(engine, {
    encode: () => new Blob(['wav']),
    persistAudioClip: async () => {
      throw expected;
    },
  });

  engine.setSampleBuffer('failed-audio', {} as AudioBuffer);
  let published = false;
  const publication = waitForSampleBufferPersistence(engine, 'failed-audio').then(() => {
    published = true;
  });

  await assert.rejects(publication, expected);
  assert.equal(published, false);
});

test('NORMAL SUCCESS publishes when generation and playlist revision are unchanged', async () => {
  const { wait, releasePersistence } = await startBlockedPersistence('successful-audio');
  let published = false;

  const publication = wait.then(() => {
    published = true;
  });
  releasePersistence.resolve();

  await publication;
  assert.equal(published, true);
});

test('MULTIPLE OPERATIONS cannot let an older captured revision overwrite a newer publication', async () => {
  const engine = createFakeEngine();
  const releaseA = deferred();
  const releaseB = deferred();
  let started = 0;
  const startedBoth = deferred();

  installSampleBufferPersistence(engine, {
    encode: () => new Blob(['wav']),
    persistAudioClip: async id => {
      started += 1;
      if (started === 2) startedBoth.resolve();
      await (id === 'operation-a' ? releaseA.promise : releaseB.promise);
    },
  });

  engine.setSampleBuffer('operation-a', {} as AudioBuffer);
  engine.setSampleBuffer('operation-b', {} as AudioBuffer);
  const waitA = waitForSampleBufferPersistence(engine, 'operation-a');
  const waitB = waitForSampleBufferPersistence(engine, 'operation-b');
  await startedBoth.promise;

  releaseA.resolve();
  await waitA;

  // Operation A is now the newer committed playlist state. A's publication
  // advances the same revision used by the stale-publication guard.
  const before = makeState([...DEFAULT_PROJECT.playlistClips]);
  const after = makeState([...DEFAULT_PROJECT.playlistClips, {
    ...DEFAULT_PROJECT.playlistClips[0],
    id: `phase40-operation-a-${Date.now()}`,
  }]);
  synchronizeBeforeRuntimePublication(before, after, () => undefined, state => state);

  releaseB.resolve();
  await assert.rejects(waitB, /Stale playlist audio publication rejected/);
});

test('publication tokens change across project generation and playlist revision boundaries', () => {
  const initial = captureCurrentPlaylistAudioPublicationToken();
  assert.equal(isCurrentPlaylistAudioPublication(initial), true);

  synchronizeBeforeRuntimePublication(
    makeState([...DEFAULT_PROJECT.playlistClips]),
    makeState([...DEFAULT_PROJECT.playlistClips, {
      ...DEFAULT_PROJECT.playlistClips[0],
      id: `phase40-token-${Date.now()}`,
    }]),
    () => undefined,
    state => state,
  );
  assert.equal(isCurrentPlaylistAudioPublication(initial), false);

  const afterEdit = captureCurrentPlaylistAudioPublicationToken();
  advancePlaylistAudioProjectGeneration();
  assert.equal(isCurrentPlaylistAudioPublication(afterEdit), false);
});
