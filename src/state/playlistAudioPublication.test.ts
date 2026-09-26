import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installSampleBufferPersistence, waitForSampleBufferPersistence } from '../audio/sampleBufferPersistence';
import {
  advancePlaylistAudioProjectGeneration,
  captureCurrentPlaylistAudioPublicationToken,
  isCurrentPlaylistAudioPublication,
} from './playlistAudioPublication';
import { runProjectReplacementAfterBackup } from './projectReplacement';
import { synchronizeBeforeRuntimePublication } from './runtimeStatePublication';
import { DEFAULT_PROJECT } from '../audio/presets';
import type { PlaylistClip, ProjectState } from '../types/daw';

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

const makeState = (playlistClips: typeof DEFAULT_PROJECT.playlistClips) => {
  const state = structuredClone(DEFAULT_PROJECT);
  state.playlistClips = playlistClips;
  return state;
};

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

  return { engine, wait, releasePersistence };
};

/**
 * App.tsx is hook-heavy and the repository has no React component test renderer.
 * The production publication boundary is therefore exercised through the exact
 * handleUpdateClips function body from App.tsx. This remains test-only: no
 * production handler is duplicated or refactored merely to create a seam.
 */
const loadProductionHandleUpdateClips = () => {
  const appSource = readFileSync(
    fileURLToPath(new URL('../App.tsx', import.meta.url)),
    'utf8',
  );
  const match = appSource.match(
    /const handleUpdateClips = \(clips: PlaylistClip\[\]\) => \{([\s\S]*?)\n  \};\n\n  const handleUpdateMarkers/
  );
  if (!match) throw new Error('Could not locate App.handleUpdateClips production boundary');

  return new Function(
    'clips',
    'projectStateRef',
    'audioEngine',
    'waitForSampleBufferPersistence',
    'updatePlaylistProjectState',
    'playlistInteractionActiveRef',
    'commitPlaylistHistory',
    'setSaveError',
    match[1],
  ) as unknown as (
    clips: PlaylistClip[],
    projectStateRef: { current: ProjectState },
    audioEngine: ReturnType<typeof createFakeEngine>,
    waitForSampleBufferPersistence: typeof waitForSampleBufferPersistence,
    updatePlaylistProjectState: (state: ProjectState) => void,
    playlistInteractionActiveRef: { current: boolean },
    commitPlaylistHistory: (state: ProjectState, label: string) => void,
    setSaveError: (error: string) => void,
  ) => void;
};

const invokeProductionHandleUpdateClips = (
  clips: PlaylistClip[],
  projectStateRef: { current: ProjectState },
  engine: ReturnType<typeof createFakeEngine>,
  publish: (state: ProjectState) => void,
  setSaveError: (error: string) => void = () => undefined,
) => {
  const handleUpdateClips = loadProductionHandleUpdateClips();
  handleUpdateClips(
    clips,
    projectStateRef,
    engine,
    waitForSampleBufferPersistence,
    publish,
    { current: false },
    () => undefined,
    setSaveError,
  );
};

const publishThroughRuntimeBoundary = (
  projectStateRef: { current: ProjectState },
  nextState: ProjectState,
  published?: Deferred,
) => {
  const currentState = projectStateRef.current;
  synchronizeBeforeRuntimePublication(
    currentState,
    nextState,
    () => undefined,
    state => {
      projectStateRef.current = state;
      published?.resolve();
      return state;
    },
  );
};

// Production-path regression tests.
test('DROPPED AUDIO + PROJECT REPLACEMENT rejects stale publication through App.handleUpdateClips', async () => {
  const { engine, releasePersistence } = await startBlockedPersistence('dropped-project-audio');
  const projectStateRef = { current: makeState(structuredClone(DEFAULT_PROJECT.playlistClips)) };
  const projectB = makeState(structuredClone(DEFAULT_PROJECT.playlistClips));
  projectB.meta = { ...projectB.meta, name: 'Project B' };
  const staleClip: PlaylistClip = {
    id: 'dropped-project-audio-clip', trackIndex: 0, startBar: 0, lengthBars: 4,
    type: 'audio', audioBufferId: 'dropped-project-audio', audioName: 'Dropped Audio',
    audioWaveform: [0.5], color: '#00ff88', name: 'Dropped Audio'
  };
  let published = false;

  invokeProductionHandleUpdateClips(
    [...projectStateRef.current.playlistClips, staleClip],
    projectStateRef,
    engine,
    state => { published = true; projectStateRef.current = state; },
  );

  await runProjectReplacementAfterBackup(undefined, async () => {
    projectStateRef.current = projectB;
  });
  releasePersistence.resolve();
  await new Promise<void>(resolve => queueMicrotask(resolve));

  assert.equal(published, false);
  assert.equal(projectStateRef.current.meta.name, 'Project B');
  assert.deepEqual(projectStateRef.current.playlistClips, projectB.playlistClips);
  assert.equal(projectStateRef.current.playlistClips.some(clip => clip.id === staleClip.id), false);
});

test('BOUNCE + PROJECT REPLACEMENT rejects stale publication through App.handleUpdateClips', async () => {
  const { engine, releasePersistence } = await startBlockedPersistence('bounced-project-audio');
  const projectStateRef = { current: makeState(structuredClone(DEFAULT_PROJECT.playlistClips)) };
  const projectB = makeState(structuredClone(DEFAULT_PROJECT.playlistClips));
  projectB.meta = { ...projectB.meta, name: 'Project B' };
  const bouncedClip: PlaylistClip = {
    id: 'bounced-project-audio-clip', trackIndex: 0, startBar: 0, lengthBars: 4,
    type: 'audio', audioBufferId: 'bounced-project-audio', audioName: 'Kick [Bounced Stem]',
    audioWaveform: [0.75], color: '#00ff88', name: 'Kick [Stem]'
  };
  let published = false;

  invokeProductionHandleUpdateClips(
    [...projectStateRef.current.playlistClips, bouncedClip],
    projectStateRef,
    engine,
    state => { published = true; projectStateRef.current = state; },
  );

  await runProjectReplacementAfterBackup(undefined, async () => {
    projectStateRef.current = projectB;
  });
  releasePersistence.resolve();
  await new Promise<void>(resolve => queueMicrotask(resolve));

  assert.equal(published, false);
  assert.equal(projectStateRef.current.meta.name, 'Project B');
  assert.deepEqual(projectStateRef.current.playlistClips, projectB.playlistClips);
  assert.equal(projectStateRef.current.playlistClips.some(clip => clip.id === bouncedClip.id), false);
});

test('SAME-PROJECT INTERVENING EDIT survives real App.handleUpdateClips publication boundary', async () => {
  const { engine, releasePersistence } = await startBlockedPersistence('same-project-audio');
  const currentClips = structuredClone(DEFAULT_PROJECT.playlistClips);
  const projectStateRef = { current: makeState(currentClips) };
  const staleClip: PlaylistClip = {
    id: 'same-project-audio-clip', trackIndex: 0, startBar: 0, lengthBars: 4,
    type: 'audio', audioBufferId: 'same-project-audio', audioName: 'Dropped Audio',
    audioWaveform: [0.5], color: '#00ff88', name: 'Dropped Audio'
  };
  let stalePublished = false;

  invokeProductionHandleUpdateClips(
    [...currentClips, staleClip],
    projectStateRef,
    engine,
    state => { stalePublished = true; projectStateRef.current = state; },
  );

  const editedClips = currentClips.map((clip, index) => index === 0
    ? { ...clip, startBar: clip.startBar + 1, name: 'A3' }
    : clip);
  publishThroughRuntimeBoundary(projectStateRef, makeState(editedClips));

  releasePersistence.resolve();
  await new Promise<void>(resolve => queueMicrotask(resolve));

  assert.equal(stalePublished, false);
  assert.deepEqual(projectStateRef.current.playlistClips, editedClips);
});

test('PERSISTENCE FAILURE through App.handleUpdateClips never publishes a playlist clip', async () => {
  const engine = createFakeEngine();
  const persistStarted = deferred();
  const expected = new Error('quota exceeded');
  installSampleBufferPersistence(engine, {
    encode: () => new Blob(['wav']),
    persistAudioClip: async () => { persistStarted.resolve(); throw expected; },
  });
  const projectStateRef = { current: makeState(structuredClone(DEFAULT_PROJECT.playlistClips)) };
  const staleClip: PlaylistClip = {
    id: 'failed-audio-clip', trackIndex: 0, startBar: 0, lengthBars: 4,
    type: 'audio', audioBufferId: 'failed-audio', audioName: 'Failed Audio',
    audioWaveform: [0.5], color: '#00ff88', name: 'Failed Audio'
  };
  let published = false;
  let saveError = '';
  invokeProductionHandleUpdateClips(
    [...projectStateRef.current.playlistClips, staleClip],
    projectStateRef,
    engine,
    state => { published = true; projectStateRef.current = state; },
    error => { saveError = error; },
  );

  engine.setSampleBuffer('failed-audio', {} as AudioBuffer);
  await persistStarted.promise;
  await new Promise<void>(resolve => queueMicrotask(resolve));

  assert.equal(published, false);
  assert.deepEqual(projectStateRef.current.playlistClips, DEFAULT_PROJECT.playlistClips);
  assert.match(saveError, /quota exceeded/);
});

test('NORMAL SUCCESS through App.handleUpdateClips publishes the new audio clip', async () => {
  const { engine, releasePersistence } = await startBlockedPersistence('successful-audio');
  const projectStateRef = { current: makeState(structuredClone(DEFAULT_PROJECT.playlistClips)) };
  const newClip: PlaylistClip = {
    id: 'successful-audio-clip', trackIndex: 0, startBar: 0, lengthBars: 4,
    type: 'audio', audioBufferId: 'successful-audio', audioName: 'Dropped Audio',
    audioWaveform: [0.5], color: '#00ff88', name: 'Dropped Audio'
  };
  const published = deferred();

  invokeProductionHandleUpdateClips(
    [...projectStateRef.current.playlistClips, newClip],
    projectStateRef,
    engine,
    state => { projectStateRef.current = state; published.resolve(); },
  );
  releasePersistence.resolve();
  await published.promise;

  assert.equal(projectStateRef.current.playlistClips.some(clip => clip.id === newClip.id), true);
  assert.equal(projectStateRef.current.playlistClips.length, DEFAULT_PROJECT.playlistClips.length + 1);
});

test('MULTIPLE OPERATIONS: older App.handleUpdateClips publication cannot overwrite newer state', async () => {
  const engine = createFakeEngine();
  const releaseA = deferred();
  const releaseB = deferred();
  const startedA = deferred();
  const startedB = deferred();
  let startCount = 0;
  installSampleBufferPersistence(engine, {
    encode: () => new Blob(['wav']),
    persistAudioClip: async id => {
      startCount += 1;
      if (id === 'operation-a') startedA.resolve();
      if (id === 'operation-b') startedB.resolve();
      await (id === 'operation-a' ? releaseA.promise : releaseB.promise);
    },
  });
  const projectStateRef = { current: makeState(structuredClone(DEFAULT_PROJECT.playlistClips)) };
  const clipA: PlaylistClip = {
    id: 'operation-a-clip', trackIndex: 0, startBar: 0, lengthBars: 4, type: 'audio',
    audioBufferId: 'operation-a', audioName: 'A', audioWaveform: [0.5], color: '#00ff88', name: 'A'
  };
  const clipB: PlaylistClip = {
    id: 'operation-b-clip', trackIndex: 0, startBar: 4, lengthBars: 4, type: 'audio',
    audioBufferId: 'operation-b', audioName: 'B', audioWaveform: [0.5], color: '#00ff88', name: 'B'
  };
  let publishedA = false;
  let publishedB = false;

  engine.setSampleBuffer('operation-a', {} as AudioBuffer);
  engine.setSampleBuffer('operation-b', {} as AudioBuffer);
  invokeProductionHandleUpdateClips([...projectStateRef.current.playlistClips, clipA], projectStateRef, engine, state => {
    publishedA = true;
    publishThroughRuntimeBoundary(projectStateRef, state);
  });
  invokeProductionHandleUpdateClips([...projectStateRef.current.playlistClips, clipB], projectStateRef, engine, state => {
    publishedB = true;
    publishThroughRuntimeBoundary(projectStateRef, state);
  });

  await Promise.all([startedA.promise, startedB.promise]);
  releaseA.resolve();
  while (!publishedA) await Promise.resolve();
  releaseB.resolve();
  await new Promise<void>(resolve => queueMicrotask(resolve));

  assert.equal(startCount, 2);
  assert.equal(publishedA, true);
  assert.equal(publishedB, false);
  assert.equal(projectStateRef.current.playlistClips.some(clip => clip.id === 'operation-a-clip'), true);
  assert.equal(projectStateRef.current.playlistClips.some(clip => clip.id === 'operation-b-clip'), false);
});

// Existing helper-level coverage remains intentionally retained.
test('DROPPED AUDIO helper boundary rejects stale publication', async () => {
  const { wait, releasePersistence } = await startBlockedPersistence('dropped-project-audio-helper');
  let published = false;
  const publication = wait.then(() => { published = true; });
  await runProjectReplacementAfterBackup(undefined, async () => undefined);
  releasePersistence.resolve();
  await assert.rejects(publication, /Stale playlist audio publication rejected/);
  assert.equal(published, false);
});

test('BOUNCE helper boundary rejects stale publication', async () => {
  const { wait, releasePersistence } = await startBlockedPersistence('bounced-project-audio-helper');
  let published = false;
  const publication = wait.then(() => { published = true; });
  await runProjectReplacementAfterBackup(undefined, async () => undefined);
  releasePersistence.resolve();
  await assert.rejects(publication, /Stale playlist audio publication rejected/);
  assert.equal(published, false);
});

test('PERSISTENCE FAILURE helper boundary never publishes a playlist clip', async () => {
  const engine = createFakeEngine();
  const expected = new Error('quota exceeded');
  installSampleBufferPersistence(engine, {
    encode: () => new Blob(['wav']),
    persistAudioClip: async () => { throw expected; },
  });
  engine.setSampleBuffer('failed-audio-helper', {} as AudioBuffer);
  let published = false;
  const publication = waitForSampleBufferPersistence(engine, 'failed-audio-helper').then(() => { published = true; });
  await assert.rejects(publication, expected);
  assert.equal(published, false);
});

test('NORMAL SUCCESS helper boundary publishes when generation and playlist revision are unchanged', async () => {
  const { wait, releasePersistence } = await startBlockedPersistence('successful-audio-helper');
  let published = false;
  const publication = wait.then(() => { published = true; });
  releasePersistence.resolve();
  await publication;
  assert.equal(published, true);
});

test('MULTIPLE helper operations cannot let an older captured revision overwrite a newer publication', async () => {
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
      await (id === 'operation-a-helper' ? releaseA.promise : releaseB.promise);
    },
  });
  engine.setSampleBuffer('operation-a-helper', {} as AudioBuffer);
  engine.setSampleBuffer('operation-b-helper', {} as AudioBuffer);
  const waitA = waitForSampleBufferPersistence(engine, 'operation-a-helper');
  const waitB = waitForSampleBufferPersistence(engine, 'operation-b-helper');
  await startedBoth.promise;
  releaseA.resolve();
  await waitA;
  const beforeClips = structuredClone(DEFAULT_PROJECT.playlistClips);
  const afterClips = structuredClone(beforeClips);
  if (afterClips[0]) afterClips[0] = { ...afterClips[0], name: `${afterClips[0].name} (A)` };
  synchronizeBeforeRuntimePublication(makeState(beforeClips), makeState(afterClips), () => undefined, state => state);
  releaseB.resolve();
  await assert.rejects(waitB, /Stale playlist audio publication rejected/);
});

test('publication tokens change across project generation and playlist revision boundaries', () => {
  const initial = captureCurrentPlaylistAudioPublicationToken();
  assert.equal(isCurrentPlaylistAudioPublication(initial), true);
  const beforeClips = structuredClone(DEFAULT_PROJECT.playlistClips);
  const afterClips = structuredClone(beforeClips);
  if (afterClips[0]) afterClips[0] = { ...afterClips[0], name: `${afterClips[0].name} (edited)` };
  synchronizeBeforeRuntimePublication(makeState(beforeClips), makeState(afterClips), () => undefined, state => state);
  assert.equal(isCurrentPlaylistAudioPublication(initial), false);
  const afterEdit = captureCurrentPlaylistAudioPublicationToken();
  advancePlaylistAudioProjectGeneration();
  assert.equal(isCurrentPlaylistAudioPublication(afterEdit), false);
});
