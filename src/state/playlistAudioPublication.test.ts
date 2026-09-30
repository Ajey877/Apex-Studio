import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  getSampleBufferPersistenceController,
  installSampleBufferPersistence,
  waitForSampleBufferPersistence,
} from '../audio/sampleBufferPersistence';
import {
  advancePlaylistAudioProjectGeneration,
  captureCurrentPlaylistAudioPublicationToken,
  isCurrentPlaylistAudioPublication,
  isPureAdditivePlaylistClipAppend,
  resolveAdditivePlaylistClipPublication,
} from './playlistAudioPublication';
import { runProjectReplacementAfterBackup } from './projectReplacement';
import { synchronizeBeforeRuntimePublication } from './runtimeStatePublication';
import { DEFAULT_PROJECT } from '../audio/presets';
import type { PlaylistClip, ProjectState } from '../types/daw';

type PersistenceWait = typeof waitForSampleBufferPersistence;
type FakeEngine = ReturnType<typeof createFakeEngine>;

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
 * One engine with several independently blocked asset writes, so tests can
 * choose which concurrent import finishes first.
 */
const createBlockedEngine = (ids: string[]) => {
  const engine = createFakeEngine();
  const gates = new Map<string, Deferred>();
  const started = new Map<string, Deferred>();
  for (const id of ids) {
    gates.set(id, deferred());
    started.set(id, deferred());
  }

  installSampleBufferPersistence(engine, {
    encode: () => new Blob(['wav']),
    persistAudioClip: async (id: string) => {
      started.get(id)?.resolve();
      await (gates.get(id)?.promise ?? Promise.resolve());
    },
  });

  return {
    engine,
    /** Resolves once the asset's storage write has actually begun. */
    waitStarted: (id: string) => started.get(id)!.promise,
    /** Lets the asset's storage write finish. */
    release: (id: string) => gates.get(id)!.resolve(),
  };
};

/**
 * Awaits an actual terminal outcome rather than counting microtask ticks: every
 * persistence write started on this engine has settled, and the following
 * macrotask boundary guarantees that the whole microtask chain hanging off those
 * writes - including `App.handleUpdateClips`' `.then`/`.catch` - has already run.
 * After it returns, a publication that was going to happen has happened.
 */
const awaitPublicationOutcome = async (engine: FakeEngine) => {
  const controller = getSampleBufferPersistenceController(engine);
  if (controller) {
    // `flush()` rejects when a write failed and can return while a sibling write
    // is still in flight, so drain until nothing is pending. The failure itself
    // is asserted by the test that provokes it.
    while (controller.getPendingIds().length > 0) {
      await controller.flush().catch(() => undefined);
    }
  }
  await new Promise<void>(resolve => setTimeout(resolve, 0));
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

  // App.tsx is TypeScript/TSX. The extracted handler is executed by Function(),
  // so remove only the TypeScript syntax present in the production body while
  // leaving the handler logic itself untouched.
  const productionBody = match[1]
    .replace(/\bas\s+string\b/g, '')
    .replace(/\(id\): id is string =>/g, '(id) =>');

  return new Function(
    'clips',
    'projectStateRef',
    'audioEngine',
    'waitForSampleBufferPersistence',
    'updatePlaylistProjectState',
    'playlistInteractionActiveRef',
    'commitPlaylistHistory',
    'setSaveError',
    'isPureAdditivePlaylistClipAppend',
    'resolveAdditivePlaylistClipPublication',
    productionBody,
  ) as unknown as (
    clips: PlaylistClip[],
    projectStateRef: { current: ProjectState },
    audioEngine: FakeEngine,
    waitForSampleBufferPersistence: PersistenceWait,
    updatePlaylistProjectState: (state: ProjectState) => void,
    playlistInteractionActiveRef: { current: boolean },
    commitPlaylistHistory: (state: ProjectState, label: string) => void,
    setSaveError: (error: string) => void,
    isPureAdditivePlaylistClipAppend: <T>(
      previousClips: readonly T[],
      nextClips: readonly T[],
    ) => boolean,
    resolveAdditivePlaylistClipPublication: <T extends { id?: string }>(
      currentClips: readonly T[],
      captureTimeClips: readonly T[],
      capturedClips: readonly T[],
    ) => T[] | null,
  ) => void;
};

interface HandlerOverrides {
  setSaveError?: (error: string) => void;
  commitPlaylistHistory?: (state: ProjectState, label: string) => void;
  playlistInteractionActiveRef?: { current: boolean };
}

const invokeProductionHandleUpdateClips = (
  clips: PlaylistClip[],
  projectStateRef: { current: ProjectState },
  engine: FakeEngine,
  publish: (state: ProjectState) => void,
  overrides: HandlerOverrides = {},
) => {
  loadProductionHandleUpdateClips()(
    clips,
    projectStateRef,
    engine,
    waitForSampleBufferPersistence,
    publish,
    overrides.playlistInteractionActiveRef ?? { current: false },
    overrides.commitPlaylistHistory ?? (() => undefined),
    overrides.setSaveError ?? (() => undefined),
    isPureAdditivePlaylistClipAppend,
    resolveAdditivePlaylistClipPublication,
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

/**
 * Records everything a publication produces, and hands out promises that resolve
 * on the real events (a publication landing, a save error being reported) so no
 * test has to guess how many ticks an async chain will take.
 */
const createPublicationHarness = (
  projectStateRef: { current: ProjectState },
  options: { advanceRevision?: boolean } = {},
) => {
  const advance = options.advanceRevision !== false;
  const publishedStates: ProjectState[] = [];
  const history: { state: ProjectState; label: string }[] = [];
  const saveErrors: string[] = [];
  const waiters: (() => void)[] = [];

  const notify = () => {
    for (const wake of waiters.splice(0)) wake();
  };

  const publish = (state: ProjectState) => {
    if (advance) {
      publishThroughRuntimeBoundary(projectStateRef, state);
    } else {
      projectStateRef.current = state;
    }
    publishedStates.push(state);
    notify();
  };

  return {
    publish,
    publishedStates,
    history,
    saveErrors,
    commitPlaylistHistory: (state: ProjectState, label: string) => {
      history.push({ state, label });
    },
    setSaveError: (error: string) => {
      saveErrors.push(error);
      notify();
    },
    /**
     * Resolves as soon as `count` publications have actually landed. A generous
     * guard is raced in purely so a publication that never arrives fails on the
     * test's own assertion instead of blocking the runner forever; in a healthy
     * run the real event always wins, and nothing counts microtask ticks.
     */
    waitForPublications: (count: number): Promise<void> => {
      const untilReady = async () => {
        while (publishedStates.length < count) {
          await new Promise<void>(resolve => waiters.push(resolve));
        }
      };
      return Promise.race([
        untilReady(),
        new Promise<void>(resolve => setTimeout(resolve, 2_000)),
      ]);
    },
  };
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

const baseClips = () => structuredClone(DEFAULT_PROJECT.playlistClips);

// ---------------------------------------------------------------------------
// Project replacement protection
// ---------------------------------------------------------------------------

test('DROPPED AUDIO + PROJECT REPLACEMENT rejects stale publication at App.handleUpdateClips', async () => {
  const { engine, releasePersistence } = await startBlockedPersistence('dropped-project-audio');
  const projectStateRef = { current: makeState(baseClips()) };
  const projectB = makeState(baseClips());
  projectB.meta = { ...projectB.meta, name: 'Project B' };
  const staleClip = audioClip('dropped-project-audio', 'Dropped Audio');
  const harness = createPublicationHarness(projectStateRef);

  invokeProductionHandleUpdateClips(
    [...projectStateRef.current.playlistClips, staleClip],
    projectStateRef,
    engine,
    harness.publish,
    { setSaveError: harness.setSaveError },
  );

  await runProjectReplacementAfterBackup(undefined, async () => { projectStateRef.current = projectB; });
  releasePersistence.resolve();
  await awaitPublicationOutcome(engine);

  assert.equal(harness.publishedStates.length, 0);
  assert.equal(projectStateRef.current.meta.name, 'Project B');
  assert.deepEqual(projectStateRef.current.playlistClips, projectB.playlistClips);
  assert.match(harness.saveErrors.join('\n'), /Stale playlist audio publication/);
});

test('BOUNCE + PROJECT REPLACEMENT rejects stale publication at App.handleUpdateClips', async () => {
  const { engine, releasePersistence } = await startBlockedPersistence('bounced-project-audio');
  const projectStateRef = { current: makeState(baseClips()) };
  const projectB = makeState(baseClips());
  projectB.meta = { ...projectB.meta, name: 'Project B' };
  const bouncedClip = audioClip('bounced-project-audio', 'Kick [Bounced Stem]');
  const harness = createPublicationHarness(projectStateRef);

  invokeProductionHandleUpdateClips(
    [...projectStateRef.current.playlistClips, bouncedClip],
    projectStateRef,
    engine,
    harness.publish,
    { setSaveError: harness.setSaveError },
  );

  await runProjectReplacementAfterBackup(undefined, async () => { projectStateRef.current = projectB; });
  releasePersistence.resolve();
  await awaitPublicationOutcome(engine);

  assert.equal(harness.publishedStates.length, 0);
  assert.equal(projectStateRef.current.meta.name, 'Project B');
  assert.deepEqual(projectStateRef.current.playlistClips, projectB.playlistClips);
});

test('PROJECT REPLACEMENT while an additive import is pending still rejects it (Phase 44 regression)', async () => {
  const { engine, releasePersistence } = await startBlockedPersistence('pending-additive-import');
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const projectB = makeState(baseClips());
  projectB.meta = { ...projectB.meta, name: 'Project B' };
  const newClip = audioClip('pending-additive-import', 'Pending Import');
  const harness = createPublicationHarness(projectStateRef);

  // A pure append, i.e. exactly the shape that is now allowed to survive a
  // sibling commit. Project replacement must still veto it.
  invokeProductionHandleUpdateClips(
    [...clips, newClip],
    projectStateRef,
    engine,
    harness.publish,
    { setSaveError: harness.setSaveError },
  );

  await runProjectReplacementAfterBackup(undefined, async () => { projectStateRef.current = projectB; });
  releasePersistence.resolve();
  await awaitPublicationOutcome(engine);

  assert.equal(harness.publishedStates.length, 0);
  assert.equal(
    projectStateRef.current.playlistClips.some(clip => clip.id === newClip.id),
    false,
    'a clip from a replaced project must never be published',
  );
  assert.deepEqual(projectStateRef.current.playlistClips, projectB.playlistClips);
});

// ---------------------------------------------------------------------------
// Non-additive / stale protection must stay intact
// ---------------------------------------------------------------------------

test('SAME-PROJECT INTERVENING EDIT survives the real App.handleUpdateClips publication boundary', async () => {
  const { engine, releasePersistence } = await startBlockedPersistence('same-project-audio');
  const currentClips = baseClips();
  const projectStateRef = { current: makeState(currentClips) };
  const staleClip = audioClip('same-project-audio', 'Dropped Audio');
  const harness = createPublicationHarness(projectStateRef);

  invokeProductionHandleUpdateClips(
    [...currentClips, staleClip],
    projectStateRef,
    engine,
    harness.publish,
    { setSaveError: harness.setSaveError },
  );

  const editedClips = currentClips.map((clip, index) => index === 0
    ? { ...clip, startBar: clip.startBar + 1, name: 'A3' }
    : clip);
  publishThroughRuntimeBoundary(projectStateRef, makeState(editedClips));

  releasePersistence.resolve();
  await awaitPublicationOutcome(engine);

  assert.equal(harness.publishedStates.length, 0);
  assert.deepEqual(projectStateRef.current.playlistClips, editedClips);
});

test('NON-ADDITIVE update keeps strict protection when a sibling advances the playlist (Phase 44 regression)', async () => {
  const { engine, waitStarted, release } = createBlockedEngine(['sibling-a', 'conflicting-b']);
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const harness = createPublicationHarness(projectStateRef);
  const clipA = audioClip('sibling-a', 'Sibling A');
  const clipB = { ...audioClip('conflicting-b', 'Conflicting B'), startBar: 4 };
  // Replaces an existing clip *and* appends: not a pure append, so the strict
  // generation + playlist-revision gate must still reject it once A landed.
  const editedExisting = { ...clips[0]!, startBar: clips[0]!.startBar + 1 };
  const conflictingUpdate = [editedExisting, ...clips.slice(1), clipB];

  engine.setSampleBuffer('sibling-a', {} as AudioBuffer);
  engine.setSampleBuffer('conflicting-b', {} as AudioBuffer);

  invokeProductionHandleUpdateClips(
    [...clips, clipA], projectStateRef, engine, harness.publish, { setSaveError: harness.setSaveError },
  );
  invokeProductionHandleUpdateClips(
    conflictingUpdate, projectStateRef, engine, harness.publish, { setSaveError: harness.setSaveError },
  );

  await Promise.all([waitStarted('sibling-a'), waitStarted('conflicting-b')]);
  release('sibling-a');
  await harness.waitForPublications(1);
  release('conflicting-b');
  await awaitPublicationOutcome(engine);

  assert.equal(harness.publishedStates.length, 1, 'only the additive sibling may publish');
  assert.equal(
    projectStateRef.current.playlistClips.some(clip => clip.id === clipB.id),
    false,
    'a non-additive stale update must not merge into the live playlist',
  );
  assert.equal(
    projectStateRef.current.playlistClips.some(clip => clip.id === editedExisting.id && clip.startBar === editedExisting.startBar),
    false,
    'the stale edit must not be applied either',
  );
  assert.match(harness.saveErrors.join('\n'), /Stale playlist audio publication rejected after project or playlist state changed/);
});

test('NON-ADDITIVE update still publishes while nothing else moved the playlist', async () => {
  const { engine, releasePersistence } = await startBlockedPersistence('solo-trim');
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const harness = createPublicationHarness(projectStateRef);
  const trimmed = { ...clips[0]!, lengthBars: 2 };
  const appended = audioClip('solo-trim', 'Imported Clip');
  const edited = [trimmed, ...clips.slice(1), appended];

  invokeProductionHandleUpdateClips(
    edited, projectStateRef, engine, harness.publish, { setSaveError: harness.setSaveError },
  );
  releasePersistence.resolve();
  await harness.waitForPublications(1);

  assert.equal(harness.publishedStates.length, 1);
  assert.deepEqual(projectStateRef.current.playlistClips, edited);
  assert.deepEqual(harness.saveErrors, []);
});

// ---------------------------------------------------------------------------
// Phase 44: concurrent independent additive imports must both publish
// ---------------------------------------------------------------------------

test('CONCURRENT IMPORTS both publish when import A completes first (Phase 44 regression)', async () => {
  const { engine, waitStarted, release } = createBlockedEngine(['import-a', 'import-b']);
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const harness = createPublicationHarness(projectStateRef);
  const clipA = audioClip('import-a', 'Import A');
  const clipB = { ...audioClip('import-b', 'Import B'), startBar: 4 };

  engine.setSampleBuffer('import-a', {} as AudioBuffer);
  engine.setSampleBuffer('import-b', {} as AudioBuffer);

  // Two independent drops, each captured against the same pre-import playlist.
  invokeProductionHandleUpdateClips(
    [...clips, clipA], projectStateRef, engine, harness.publish,
    { commitPlaylistHistory: harness.commitPlaylistHistory, setSaveError: harness.setSaveError },
  );
  invokeProductionHandleUpdateClips(
    [...clips, clipB], projectStateRef, engine, harness.publish,
    { commitPlaylistHistory: harness.commitPlaylistHistory, setSaveError: harness.setSaveError },
  );

  await Promise.all([waitStarted('import-a'), waitStarted('import-b')]);
  release('import-a');
  await harness.waitForPublications(1);
  release('import-b');
  await harness.waitForPublications(2);

  const published = projectStateRef.current.playlistClips;
  assert.deepEqual(harness.saveErrors, [], 'an independent additive import must not be rejected');
  assert.equal(published.length, clips.length + 2);
  assert.deepEqual(published.slice(0, clips.length), clips, 'existing clips stay unchanged and in order');
  assert.equal(published[clips.length], clipA);
  assert.equal(published[clips.length + 1], clipB);
  assert.deepEqual(harness.history.map(entry => entry.label), ['Clip change', 'Clip change']);
  assert.deepEqual(harness.publishedStates.map(state => state.playlistClips.length), [clips.length + 1, clips.length + 2]);
});

test('CONCURRENT IMPORTS both publish when import B completes first (Phase 44 regression)', async () => {
  const { engine, waitStarted, release } = createBlockedEngine(['import-a', 'import-b']);
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const harness = createPublicationHarness(projectStateRef);
  const clipA = audioClip('import-a', 'Import A');
  const clipB = { ...audioClip('import-b', 'Import B'), startBar: 4 };

  engine.setSampleBuffer('import-a', {} as AudioBuffer);
  engine.setSampleBuffer('import-b', {} as AudioBuffer);
  invokeProductionHandleUpdateClips(
    [...clips, clipA], projectStateRef, engine, harness.publish,
    { commitPlaylistHistory: harness.commitPlaylistHistory, setSaveError: harness.setSaveError },
  );
  invokeProductionHandleUpdateClips(
    [...clips, clipB], projectStateRef, engine, harness.publish,
    { commitPlaylistHistory: harness.commitPlaylistHistory, setSaveError: harness.setSaveError },
  );

  await Promise.all([waitStarted('import-a'), waitStarted('import-b')]);
  // Reverse completion order: the second import lands first.
  release('import-b');
  await harness.waitForPublications(1);
  release('import-a');
  await harness.waitForPublications(2);

  const published = projectStateRef.current.playlistClips;
  assert.deepEqual(harness.saveErrors, []);
  assert.equal(published.length, clips.length + 2);
  assert.deepEqual(published.slice(0, clips.length), clips);
  assert.equal(published[clips.length], clipB, 'whichever import commits first keeps its slot');
  assert.equal(published[clips.length + 1], clipA);
});

test('THREE concurrent imports all publish in commit order (Phase 44 regression)', async () => {
  const ids = ['import-a', 'import-b', 'import-c'];
  const { engine, waitStarted, release } = createBlockedEngine(ids);
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const harness = createPublicationHarness(projectStateRef);
  const clipA = audioClip('import-a', 'A');
  const clipB = { ...audioClip('import-b', 'B'), startBar: 4 };
  const clipC = { ...audioClip('import-c', 'C'), startBar: 8 };

  for (const id of ids) engine.setSampleBuffer(id, {} as AudioBuffer);
  for (const clip of [clipA, clipB, clipC]) {
    invokeProductionHandleUpdateClips(
      [...clips, clip], projectStateRef, engine, harness.publish, { commitPlaylistHistory: harness.commitPlaylistHistory },
    );
  }

  await Promise.all(ids.map(id => waitStarted(id)));
  release('import-b');
  await harness.waitForPublications(1);
  release('import-c');
  await harness.waitForPublications(2);
  release('import-a');
  await harness.waitForPublications(3);

  const published = projectStateRef.current.playlistClips;
  assert.equal(published.length, clips.length + 3);
  assert.deepEqual(published.slice(0, clips.length), clips);
  assert.deepEqual(published.slice(clips.length).map(clip => clip.id), ['import-b', 'import-c', 'import-a']);
});

test('CONCURRENT IMPORTS: an already-published clip is never duplicated by the merge', async () => {
  const { engine, waitStarted, release } = createBlockedEngine(['import-a', 'import-b']);
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const harness = createPublicationHarness(projectStateRef);
  const clipA = audioClip('import-a', 'Import A');
  const clipB = { ...audioClip('import-b', 'Import B'), startBar: 4 };

  engine.setSampleBuffer('import-a', {} as AudioBuffer);
  engine.setSampleBuffer('import-b', {} as AudioBuffer);
  invokeProductionHandleUpdateClips(
    [...clips, clipA], projectStateRef, engine, harness.publish, { commitPlaylistHistory: harness.commitPlaylistHistory },
  );
  // B's captured array already carries A because the drop bar re-read the
  // playlist before calling: the merge must not append A a second time.
  invokeProductionHandleUpdateClips(
    [...clips, clipA, clipB], projectStateRef, engine, harness.publish, { commitPlaylistHistory: harness.commitPlaylistHistory },
  );

  await Promise.all([waitStarted('import-a'), waitStarted('import-b')]);
  release('import-a');
  await harness.waitForPublications(1);
  release('import-b');
  await harness.waitForPublications(2);

  const published = projectStateRef.current.playlistClips;
  assert.equal(published.filter(clip => clip.id === clipA.id).length, 1);
  assert.equal(published.length, clips.length + 2);
  assert.deepEqual(published.slice(clips.length).map(clip => clip.id), ['import-a', 'import-b']);
});

// ---------------------------------------------------------------------------
// Deletion safety
// ---------------------------------------------------------------------------

test('DELETED CLIP is never resurrected by a concurrent import (Phase 44 regression)', async () => {
  const { engine, waitStarted, release } = createBlockedEngine(['import-a', 'import-b']);
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const harness = createPublicationHarness(projectStateRef);
  const clipA = audioClip('import-a', 'Import A');
  const clipB = { ...audioClip('import-b', 'Import B'), startBar: 4 };

  engine.setSampleBuffer('import-a', {} as AudioBuffer);
  engine.setSampleBuffer('import-b', {} as AudioBuffer);
  invokeProductionHandleUpdateClips(
    [...clips, clipA], projectStateRef, engine, harness.publish, { commitPlaylistHistory: harness.commitPlaylistHistory },
  );
  invokeProductionHandleUpdateClips(
    [...clips, clipB], projectStateRef, engine, harness.publish, { commitPlaylistHistory: harness.commitPlaylistHistory },
  );

  await Promise.all([waitStarted('import-a'), waitStarted('import-b')]);
  release('import-a');
  await harness.waitForPublications(1);
  assert.equal(projectStateRef.current.playlistClips.some(clip => clip.id === clipA.id), true);

  // The user deletes A's clip from the playlist while B is still in flight.
  publishThroughRuntimeBoundary(projectStateRef, makeState([...clips]));

  release('import-b');
  await harness.waitForPublications(2);

  const published = projectStateRef.current.playlistClips;
  assert.equal(
    published.some(clip => clip.id === clipA.id),
    false,
    'a clip the user deleted must not come back through a pending publication',
  );
  assert.equal(published.some(clip => clip.id === clipB.id), true, 'B must still land');
  assert.deepEqual(published, [...clips, clipB]);
});

test('DELETED pre-existing clip rejects the additive merge instead of resurrecting it', async () => {
  const { engine, waitStarted, release } = createBlockedEngine(['import-a', 'import-b']);
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const harness = createPublicationHarness(projectStateRef);
  const clipA = audioClip('import-a', 'Import A');
  const clipB = { ...audioClip('import-b', 'Import B'), startBar: 4 };

  engine.setSampleBuffer('import-a', {} as AudioBuffer);
  engine.setSampleBuffer('import-b', {} as AudioBuffer);
  invokeProductionHandleUpdateClips(
    [...clips, clipA], projectStateRef, engine, harness.publish, { commitPlaylistHistory: harness.commitPlaylistHistory },
  );
  invokeProductionHandleUpdateClips(
    [...clips, clipB], projectStateRef, engine, harness.publish, { commitPlaylistHistory: harness.commitPlaylistHistory },
  );

  await Promise.all([waitStarted('import-a'), waitStarted('import-b')]);
  release('import-a');
  await harness.waitForPublications(1);
  // Deleting one of the clips the pending import carried forward breaks the
  // additive assumption, so the publication is dropped rather than merged.
  publishThroughRuntimeBoundary(projectStateRef, makeState(clips.slice(1)));
  release('import-b');
  await awaitPublicationOutcome(engine);

  assert.equal(harness.publishedStates.length, 1);
  assert.equal(projectStateRef.current.playlistClips[0], clips[1]);
  assert.equal(projectStateRef.current.playlistClips.some(clip => clip.id === clipB.id), false);
  assert.equal(projectStateRef.current.playlistClips.some(clip => clip.id === clips[0]!.id), false);
});

// ---------------------------------------------------------------------------
// Failure and single-import paths
// ---------------------------------------------------------------------------

test('PERSISTENCE FAILURE through App.handleUpdateClips never publishes a playlist clip', async () => {
  const engine = createFakeEngine();
  const persistStarted = deferred();
  const expected = new Error('quota exceeded');
  installSampleBufferPersistence(engine, {
    encode: () => new Blob(['wav']),
    persistAudioClip: async () => { persistStarted.resolve(); throw expected; },
  });
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const failedClip = audioClip('failed-audio', 'Failed Audio');
  const harness = createPublicationHarness(projectStateRef);

  engine.setSampleBuffer('failed-audio', {} as AudioBuffer);
  invokeProductionHandleUpdateClips(
    [...clips, failedClip], projectStateRef, engine, harness.publish, { setSaveError: harness.setSaveError },
  );

  await persistStarted.promise;
  await awaitPublicationOutcome(engine);

  assert.equal(harness.publishedStates.length, 0);
  assert.deepEqual(projectStateRef.current.playlistClips, DEFAULT_PROJECT.playlistClips);
  assert.equal(harness.saveErrors.length, 1);
  assert.match(harness.saveErrors[0]!, /quota exceeded/);
});

test('PERSISTENCE FAILURE of one import does not block its concurrent sibling', async () => {
  const engine = createFakeEngine();
  const releaseB = deferred();
  const startedB = deferred();
  installSampleBufferPersistence(engine, {
    encode: () => new Blob(['wav']),
    persistAudioClip: async (id: string) => {
      if (id === 'import-a') throw new Error('disk full');
      startedB.resolve();
      await releaseB.promise;
    },
  });
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const harness = createPublicationHarness(projectStateRef);
  const clipA = audioClip('import-a', 'Import A');
  const clipB = { ...audioClip('import-b', 'Import B'), startBar: 4 };

  engine.setSampleBuffer('import-a', {} as AudioBuffer);
  engine.setSampleBuffer('import-b', {} as AudioBuffer);
  invokeProductionHandleUpdateClips(
    [...clips, clipA], projectStateRef, engine, harness.publish,
    { setSaveError: harness.setSaveError, commitPlaylistHistory: harness.commitPlaylistHistory },
  );
  invokeProductionHandleUpdateClips(
    [...clips, clipB], projectStateRef, engine, harness.publish,
    { setSaveError: harness.setSaveError, commitPlaylistHistory: harness.commitPlaylistHistory },
  );

  await startedB.promise;
  releaseB.resolve();
  await harness.waitForPublications(1);
  await awaitPublicationOutcome(engine);

  const published = projectStateRef.current.playlistClips;
  assert.equal(published.some(clip => clip.id === clipB.id), true, 'the healthy import still lands');
  assert.equal(published.some(clip => clip.id === clipA.id), false, 'the failed import never lands');
  assert.equal(harness.publishedStates.length, 1);
  assert.match(harness.saveErrors.join('\n'), /disk full/);
});

test('NORMAL SUCCESS through App.handleUpdateClips publishes the new audio clip', async () => {
  const { engine, releasePersistence } = await startBlockedPersistence('successful-audio');
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const newClip = audioClip('successful-audio', 'Dropped Audio');
  const harness = createPublicationHarness(projectStateRef);

  invokeProductionHandleUpdateClips(
    [...clips, newClip], projectStateRef, engine, harness.publish,
    { setSaveError: harness.setSaveError, commitPlaylistHistory: harness.commitPlaylistHistory },
  );
  releasePersistence.resolve();
  await harness.waitForPublications(1);

  const published = projectStateRef.current.playlistClips;
  assert.equal(published.some(clip => clip.id === newClip.id), true);
  assert.equal(published.length, DEFAULT_PROJECT.playlistClips.length + 1);
  assert.deepEqual(published.slice(0, clips.length), clips, 'a single import leaves existing clips untouched');
  assert.deepEqual(harness.saveErrors, []);
});

// ---------------------------------------------------------------------------
// Undo / redo coherence
// ---------------------------------------------------------------------------

test('UNDO/REDO stays coherent when two concurrent additive imports publish', async () => {
  const { engine, waitStarted, release } = createBlockedEngine(['import-a', 'import-b']);
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const harness = createPublicationHarness(projectStateRef);
  const clipA = audioClip('import-a', 'Import A');
  const clipB = { ...audioClip('import-b', 'Import B'), startBar: 4 };

  engine.setSampleBuffer('import-a', {} as AudioBuffer);
  engine.setSampleBuffer('import-b', {} as AudioBuffer);
  invokeProductionHandleUpdateClips(
    [...clips, clipA], projectStateRef, engine, harness.publish, { commitPlaylistHistory: harness.commitPlaylistHistory },
  );
  invokeProductionHandleUpdateClips(
    [...clips, clipB], projectStateRef, engine, harness.publish, { commitPlaylistHistory: harness.commitPlaylistHistory },
  );

  await Promise.all([waitStarted('import-a'), waitStarted('import-b')]);
  release('import-a');
  await harness.waitForPublications(1);
  release('import-b');
  await harness.waitForPublications(2);

  // Every history entry is exactly the state that reached the runtime boundary,
  // so undo can never restore a playlist the imports did not actually publish.
  assert.deepEqual(harness.history.map(entry => entry.state), harness.publishedStates);
  assert.deepEqual(harness.history.map(entry => entry.state.playlistClips.length), [clips.length + 1, clips.length + 2]);

  const afterImports = projectStateRef.current;

  // Undo the merge: the history entry before the imports is republished.
  const beforeImports = makeState(clips);
  publishThroughRuntimeBoundary(projectStateRef, beforeImports);
  assert.deepEqual(projectStateRef.current.playlistClips, clips);

  // Redo reapplies the merged state without re-running any publication.
  publishThroughRuntimeBoundary(projectStateRef, afterImports);
  assert.equal(projectStateRef.current, afterImports);
  assert.deepEqual(
    projectStateRef.current.playlistClips.map(clip => clip.id),
    [...clips.map(clip => clip.id), 'import-a', 'import-b'],
  );
});

test('UNDO of a sibling import does not block an independent import and cannot resurrect the undone clip', async () => {
  const { engine, waitStarted, release } = createBlockedEngine(['import-a', 'import-b']);
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const harness = createPublicationHarness(projectStateRef);
  const clipA = audioClip('import-a', 'Import A');
  const clipB = { ...audioClip('import-b', 'Import B'), startBar: 4 };

  engine.setSampleBuffer('import-a', {} as AudioBuffer);
  engine.setSampleBuffer('import-b', {} as AudioBuffer);
  invokeProductionHandleUpdateClips(
    [...clips, clipA], projectStateRef, engine, harness.publish, { commitPlaylistHistory: harness.commitPlaylistHistory },
  );
  invokeProductionHandleUpdateClips(
    [...clips, clipB], projectStateRef, engine, harness.publish, { commitPlaylistHistory: harness.commitPlaylistHistory },
  );

  await Promise.all([waitStarted('import-a'), waitStarted('import-b')]);
  release('import-a');
  await harness.waitForPublications(1);

  // Undo A's import while B is still being persisted. The playlist is back on the
  // exact basis B was captured against, so B is still a clean additive import:
  // it lands, and the undone clip must not come back with it.
  publishThroughRuntimeBoundary(projectStateRef, makeState(clips));
  release('import-b');
  await harness.waitForPublications(2);

  const published = projectStateRef.current.playlistClips;
  assert.deepEqual(published, [...clips, clipB]);
  assert.equal(
    published.some(clip => clip.id === clipA.id),
    false,
    'undo must never be undone by a pending publication',
  );
});

test('UNDO that changes the playlist shape rejects the pending import instead of overwriting it', async () => {
  const { engine, waitStarted, release } = createBlockedEngine(['import-a', 'import-b']);
  const clips = baseClips();
  const projectStateRef = { current: makeState(clips) };
  const harness = createPublicationHarness(projectStateRef);
  const clipA = audioClip('import-a', 'Import A');
  const clipB = { ...audioClip('import-b', 'Import B'), startBar: 4 };

  engine.setSampleBuffer('import-a', {} as AudioBuffer);
  engine.setSampleBuffer('import-b', {} as AudioBuffer);
  invokeProductionHandleUpdateClips(
    [...clips, clipA], projectStateRef, engine, harness.publish, { commitPlaylistHistory: harness.commitPlaylistHistory },
  );
  invokeProductionHandleUpdateClips(
    [...clips, clipB], projectStateRef, engine, harness.publish, { commitPlaylistHistory: harness.commitPlaylistHistory },
  );

  await Promise.all([waitStarted('import-a'), waitStarted('import-b')]);
  release('import-a');
  await harness.waitForPublications(1);

  // Undo further back than B's captured basis: B can no longer prove its append
  // is additive, so it is dropped rather than rewriting the newer playlist.
  publishThroughRuntimeBoundary(projectStateRef, makeState(clips.slice(1)));
  release('import-b');
  await awaitPublicationOutcome(engine);

  assert.equal(harness.publishedStates.length, 1);
  assert.deepEqual(projectStateRef.current.playlistClips, clips.slice(1));
  assert.equal(projectStateRef.current.playlistClips.some(clip => clip.id === clipB.id), false);
});

// ---------------------------------------------------------------------------
// Additive classifier / merge behavior
// ---------------------------------------------------------------------------

test('ADDITIVE CLASSIFIER accepts appends and rejects every other shape', () => {
  const clips = baseClips();
  const extra = audioClip('unit-extra', 'Extra');

  assert.equal(isPureAdditivePlaylistClipAppend(clips, [...clips]), true, 'an unchanged playlist is a zero-length append');
  assert.equal(isPureAdditivePlaylistClipAppend(clips, [...clips, extra]), true);
  assert.equal(isPureAdditivePlaylistClipAppend(clips, [...clips, extra, audioClip('unit-extra-2', 'Extra 2')]), true);
  assert.equal(isPureAdditivePlaylistClipAppend(clips, [extra, ...clips]), false, 'prepend is not additive');
  assert.equal(isPureAdditivePlaylistClipAppend(clips, [extra]), false, 'replacement is not additive');
  assert.equal(isPureAdditivePlaylistClipAppend(clips, clips.slice(0, -1)), false, 'removal is not additive');
  assert.equal(
    isPureAdditivePlaylistClipAppend(clips, [{ ...clips[0]!, startBar: 9 }, ...clips.slice(1)]),
    false,
    'an edited existing clip is not additive',
  );
  assert.equal(
    isPureAdditivePlaylistClipAppend(clips, [...clips.slice(1), clips[0]!, extra]),
    false,
    'a reordered clip is not additive',
  );
});

test('ADDITIVE MERGE lands new clips on the live playlist and refuses conflicts', () => {
  const clips = baseClips();
  const clipA = audioClip('merge-a', 'A');
  const clipB = audioClip('merge-b', 'B');
  const captured = [...clips, clipB];

  // Nothing else moved: the captured array is published as-is.
  assert.equal(resolveAdditivePlaylistClipPublication(clips, clips, captured), captured);

  // A sibling appended clipA: only clipB is merged, onto the live playlist.
  const live = [...clips, clipA];
  assert.deepEqual(resolveAdditivePlaylistClipPublication(live, clips, captured), [...clips, clipA, clipB]);
  assert.equal(resolveAdditivePlaylistClipPublication(live, clips, captured)![clips.length], clipA);

  // The clip is already live: the current array comes back untouched (no-op).
  const alreadyLive = [...clips, clipB];
  assert.equal(resolveAdditivePlaylistClipPublication(alreadyLive, clips, captured), alreadyLive);
  assert.equal(resolveAdditivePlaylistClipPublication(live, clips, [...clips, clipA]), live);

  // Captured update is not additive: no merge.
  assert.equal(resolveAdditivePlaylistClipPublication(live, clips, [{ ...clips[0]!, name: 'Edited' }, ...clips.slice(1), clipB]), null);

  // A clip the import carried forward disappeared from the live playlist: no merge.
  assert.equal(resolveAdditivePlaylistClipPublication(clips.slice(0, 1), clips, captured), null);
  assert.equal(resolveAdditivePlaylistClipPublication([], clips, captured), null);
});

test('publication tokens change across project generation and playlist revision boundaries', () => {
  const initial = captureCurrentPlaylistAudioPublicationToken();
  assert.equal(isCurrentPlaylistAudioPublication(initial), true);
  const beforeClips = baseClips();
  const afterClips = baseClips();
  if (afterClips[0]) afterClips[0] = { ...afterClips[0], name: `${afterClips[0].name} (edited)` };
  synchronizeBeforeRuntimePublication(makeState(beforeClips), makeState(afterClips), () => undefined, state => state);
  assert.equal(isCurrentPlaylistAudioPublication(initial), false);
  const afterEdit = captureCurrentPlaylistAudioPublicationToken();
  advancePlaylistAudioProjectGeneration();
  assert.equal(isCurrentPlaylistAudioPublication(afterEdit), false);
});
