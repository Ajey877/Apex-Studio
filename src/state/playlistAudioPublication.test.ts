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

type PersistenceWait = typeof waitForSampleBufferPersistence;

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
  await persistStarted.promise;
  return { engine, releasePersistence };
};

/**
 * App.tsx is hook-heavy and this repository has no React component test renderer.
 * The test executes the exact current handleUpdateClips function body from App.tsx
 * with controlled production dependencies. This keeps the production handler intact
 * while testing the real publication sequence rather than the Phase 40 helper alone.
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
    'persistenceWait',
    'updatePlaylistProjectState',
    'playlistInteractionActiveRef',
    'commitPlaylistHistory',
    'setSaveError',
    match[1],
  ) as unknown as (
    clips: PlaylistClip[],
    projectStateRef: { current: ProjectState },
    audioEngine: ReturnType<typeof createFakeEngine>,
    persistenceWait: PersistenceWait,
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
  loadProductionHandleUpdateClips()(
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
) => {
  const currentState = projectStateRef.current;
  synchronizeBeforeRuntimePublication(
    currentState,
    nextState,
    () => undefined,
    state => {
      projectStateRef.current = state;
      return state;
    },
  );
};

const audioClip = (id: string, name: string): PlaylistClip => ({
  id,
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'audio',
  audioBufferId: id,
  audioName: name,
  audioWaveform: [0.5],
  color: '#00ff88',
  name,
});

test('DROPPED AUDIO + PROJECT REPLACEMENT rejects stale publication at App.handleUpdateClips', async () => {
  const { engine, releasePersistence } = await startBlockedPersistence('dropped-project-audio');
  const projectStateRef = { current: makeState(structuredClone(DEFAULT_PROJECT.playlistClips)) };
  const projectB = makeState(structuredClone(DEFAULT_PROJECT.playlistClips));
  projectB.meta = { ...projectB.meta, name: 'Project B' };
  const staleClip = audioClip('dropped-project-audio', 'Dropped Audio');
  let published = false;

  invokeProductionHandleUpdateClips([...projectStateRef.current.playlistClips, staleClip], projectStateRef, engine,
    state => { published = true; projectStateRef.current = state; });

  await runProjectReplacementAfterBackup(undefined, async () => { projectStateRef.current = projectB; });
  releasePersistence.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(published, false);
  assert.equal(projectStateRef.current.meta.name, 'Project B');
  assert.deepEqual(projectStateRef.current.playlistClips, projectB.playlistClips);
});

test('BOUNCE + PROJECT REPLACEMENT rejects stale publication at App.handleUpdateClips', async () => {
  const { engine, releasePersistence } = await startBlockedPersistence('bounced-project-audio');
  const projectStateRef = { current: makeState(structuredClone(DEFAULT_PROJECT.playlistClips)) };
  const projectB = makeState(structuredClone(DEFAULT_PROJECT.playlistClips));
  projectB.meta = { ...projectB.meta, name: 'Project B' };
  const bouncedClip = audioClip('bounced-project-audio', 'Kick [Bounced Stem]');
  let published = false;

  invokeProductionHandleUpdateClips([...projectStateRef.current.playlistClips, bouncedClip], projectStateRef, engine,
    state => { published = true; projectStateRef.current = state; });

  await runProjectReplacementAfterBackup(undefined, async () => { projectStateRef.current = projectB; });
  releasePersistence.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(published, false);
  assert.equal(projectStateRef.current.meta.name, 'Project B');
  assert.deepEqual(projectStateRef.current.playlistClips, projectB.playlistClips);
});

test('SAME-PROJECT INTERVENING EDIT survives the real App.handleUpdateClips publication boundary', async () => {
  const { engine, releasePersistence } = await startBlockedPersistence('same-project-audio');
  const currentClips = structuredClone(DEFAULT_PROJECT.playlistClips);
  const projectStateRef = { current: makeState(currentClips) };
  const staleClip = audioClip('same-project-audio', 'Dropped Audio');
  let stalePublished = false;

  invokeProductionHandleUpdateClips([...currentClips, staleClip], projectStateRef, engine,
    state => { stalePublished = true; projectStateRef.current = state; });

  const editedClips = currentClips.map((clip, index) => index === 0
    ? { ...clip, startBar: clip.startBar + 1, name: 'A3' }
    : clip);
  publishThroughRuntimeBoundary(projectStateRef, makeState(editedClips));

  releasePersistence.resolve();
  await Promise.resolve();
  await Promise.resolve();

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
  const failedClip = audioClip('failed-audio', 'Failed Audio');
  let published = false;
  let saveError = '';

  // The production handler waits on an asset that must already be registered.
  engine.setSampleBuffer('failed-audio', {} as AudioBuffer);
  invokeProductionHandleUpdateClips([...projectStateRef.current.playlistClips, failedClip], projectStateRef, engine,
    state => { published = true; projectStateRef.current = state; },
    error => { saveError = error; });

  await persistStarted.promise;
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(published, false);
  assert.deepEqual(projectStateRef.current.playlistClips, DEFAULT_PROJECT.playlistClips);
  assert.match(saveError, /quota exceeded/);
});

test('NORMAL SUCCESS through App.handleUpdateClips publishes the new audio clip', async () => {
  const { engine, releasePersistence } = await startBlockedPersistence('successful-audio');
  const projectStateRef = { current: makeState(structuredClone(DEFAULT_PROJECT.playlistClips)) };
  const newClip = audioClip('successful-audio', 'Dropped Audio');
  const published = deferred();

  invokeProductionHandleUpdateClips([...projectStateRef.current.playlistClips, newClip], projectStateRef, engine,
    state => { projectStateRef.current = state; published.resolve(); });
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
  const clipA = audioClip('operation-a', 'A');
  const clipB = { ...audioClip('operation-b', 'B'), startBar: 4 };
  let publishedA = false;
  let publishedB = false;

  engine.setSampleBuffer('operation-a', {} as AudioBuffer);
  engine.setSampleBuffer('operation-b', {} as AudioBuffer);
  invokeProductionHandleUpdateClips([...projectStateRef.current.playlistClips, clipA], projectStateRef, engine,
    state => { publishedA = true; publishThroughRuntimeBoundary(projectStateRef, state); });
  invokeProductionHandleUpdateClips([...projectStateRef.current.playlistClips, clipB], projectStateRef, engine,
    state => { publishedB = true; publishThroughRuntimeBoundary(projectStateRef, state); });

  await Promise.all([startedA.promise, startedB.promise]);
  releaseA.resolve();
  while (!publishedA) await Promise.resolve();
  releaseB.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(startCount, 2);
  assert.equal(publishedA, true);
  assert.equal(publishedB, false);
  assert.equal(projectStateRef.current.playlistClips.some(clip => clip.id === 'operation-a'), true);
  assert.equal(projectStateRef.current.playlistClips.some(clip => clip.id === 'operation-b'), false);
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
