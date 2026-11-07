import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingCancelledError, RecordingEngine, hasActiveRecordingEngineSession } from './recordingEngine';
import { CountInScheduler, type CountInHost } from './countInScheduler';
import { resolveMeterPulseLayout } from '../music/meterPulse';
import { sessionBlobUrlRegistry } from '../state/sessionBlobUrlRegistry';
import {
  createRecordingTestRig,
  decodeFloatWav,
  type DeterministicCaptureNode,
  type RecordingTestRig,
} from './recordingCaptureTestHarness';

let nextUrl = 0;

const withObjectUrlMock = async <T>(run: () => Promise<T>): Promise<T> => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = () => `blob:recording-engine-test-${++nextUrl}`;
  URL.revokeObjectURL = () => undefined;
  try {
    return await run();
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
};

const prepareRig = async (rig: RecordingTestRig): Promise<{ engine: RecordingEngine; node: DeterministicCaptureNode }> => {
  const engine = new RecordingEngine(() => rig.context as unknown as AudioContext, rig.engineOptions);
  const preparing = engine.prepare();
  const node = await rig.context.captureNodeReady;
  // Prime the same 2048-frame production packet used to verify the worklet and
  // exercise the actual prepare -> sample-stamped pre-roll state transition.
  rig.context.advanceToFrame(2048);
  await preparing;
  return { engine, node };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
};

test('late count-in callback selects the exact impulse frame and emits only the planned WAV window', async () => {
  await withObjectUrlMock(async () => {
    const rig = createRecordingTestRig();
    const { engine, node } = await prepareRig(rig);
    const hostTimers: Array<{ fn: () => void; cleared: boolean }> = [];
    const host: CountInHost = {
      now: () => rig.context.currentTime,
      scheduleClick: () => ({ stop() {}, disconnect() {} }),
      setTimer: fn => {
        const entry = { fn, cleared: false };
        hostTimers.push(entry);
        return entry;
      },
      clearTimer: handle => {
        const entry = hostTimers.find(candidate => candidate === handle);
        if (entry) entry.cleared = true;
      },
    };
    const countIn = new CountInScheduler(host).start({
      bars: 1,
      layout: resolveMeterPulseLayout([4, 4]),
      bpm: 120,
      startBeat: 0,
    });
    const plannedStartFrame = Math.round((rig.context.currentTime + 0.03 + 2) * rig.context.sampleRate);
    const plannedStopFrame = plannedStartFrame + 500;
    const impulses = new Map<number, number>([
      [plannedStartFrame - 1, 0.25], // must not leak into sample zero
      [plannedStartFrame, 0.75],
      [plannedStartFrame + 31, -0.5],
      [plannedStopFrame - 1, 0.9],
      [plannedStopFrame, 0.33], // half-open stop boundary: must be excluded
    ]);

    // Deliberately let the main-thread completion callback arrive more than a
    // second late. The capture worklet has already timestamped all input frames.
    rig.context.advanceToFrame(6144, frame => impulses.get(frame) ?? 0);
    const lateTimer = hostTimers.find(timer => !timer.cleared);
    assert.ok(lateTimer, 'count-in completion timer should be pending');
    lateTimer.fn();
    const result = await countIn;
    assert.equal(Math.round(result.captureTime * rig.context.sampleRate), plannedStartFrame);
    assert.ok(rig.context.currentTime - result.captureTime > 1, 'the synthetic JS delivery is measurably late');

    await engine.start(result.captureTime);
    const take = await engine.stop(plannedStopFrame / rig.context.sampleRate);
    const wav = await decodeFloatWav(take.blob);
    assert.equal(take.captureStartFrame, plannedStartFrame);
    assert.equal(take.captureEndFrame, plannedStopFrame);
    assert.equal(take.sampleRate, rig.context.sampleRate);
    assert.equal(take.capturedFrames, 500);
    assert.equal(take.durationSeconds, 0.5);
    assert.equal(wav.channelCount, 1);
    assert.equal(wav.frameCount, 500);
    assert.equal(wav.samples[0], 0.75);
    assert.equal(wav.samples[31], -0.5);
    assert.equal(wav.samples[499], Math.fround(0.9));
    assert.equal(wav.samples.includes(0.25), false);
    assert.equal(wav.samples.includes(0.33), false);
    assert.equal(engine.getState(), 'idle');
    assert.equal(rig.stream.tracks[0].stopped, true);
    assert.equal(hasActiveRecordingEngineSession(), false);
    sessionBlobUrlRegistry.release(take.url);
  });
});

test('prepare awaits AudioContext resume and retains the shared recording/reconfiguration lock until cleanup', async () => {
  const rig = createRecordingTestRig();
  rig.context.state = 'suspended';
  const { engine } = await prepareRig(rig);
  assert.equal(rig.context.resumeCalls, 1);
  assert.equal(engine.getState(), 'prepared');
  assert.equal(hasActiveRecordingEngineSession(), true);
  await assert.rejects(engine.cancel(), /cancelled/);
  assert.equal(hasActiveRecordingEngineSession(), false);
  assert.equal(rig.stream.tracks[0].stopped, true);
});

test('permission denial reports the device error and releases the capture-session token', async () => {
  const denied = Object.assign(new Error('permission denied'), { name: 'NotAllowedError' });
  const rig = createRecordingTestRig({ getUserMedia: async () => { throw denied; } });
  const engine = new RecordingEngine(() => rig.context as unknown as AudioContext, rig.engineOptions);
  await assert.rejects(engine.prepare(), /Microphone permission denied/i);
  assert.equal(engine.getState(), 'idle');
  assert.equal(hasActiveRecordingEngineSession(), false);
});

test('cancellation during an unabortable permission prompt stops any stream that resolves later', async () => {
  const rig = createRecordingTestRig();
  let resolvePermission!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>(resolve => { resolvePermission = resolve; });
  const options = { ...rig.engineOptions, getUserMedia: () => permission };
  const engine = new RecordingEngine(() => rig.context as unknown as AudioContext, options);
  const preparing = engine.prepare();
  await assert.rejects(engine.cancel(), /cancelled/);
  await assert.rejects(preparing, /cancelled/);
  resolvePermission(rig.stream as unknown as MediaStream);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(rig.stream.tracks[0].stopped, true);
  assert.equal(engine.getState(), 'idle');
  assert.equal(hasActiveRecordingEngineSession(), false);
});

test('unexpected input-track end immediately abandons the aligned take and releases all locks', async () => {
  const errors: Error[] = [];
  const rig = createRecordingTestRig({ onError: error => errors.push(error) });
  const { engine } = await prepareRig(rig);
  const node = rig.context.captureNode!;
  await engine.start(rig.context.currentTime);
  node.commands.length = 0;
  rig.stream.tracks[0].triggerUnexpectedEnd();
  assert.equal(engine.getState(), 'idle');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /ended unexpectedly/i);
  assert.equal(hasActiveRecordingEngineSession(), false);
});

test('pause intervals are excluded from the saved frames without introducing a resume-boundary gap', async () => {
  await withObjectUrlMock(async () => {
    const rig = createRecordingTestRig();
    const { engine } = await prepareRig(rig);
    await engine.start(rig.context.currentTime);
    rig.context.advanceToFrame(4096, frame => frame / 10000);
    engine.pause();
    rig.context.advanceToFrame(5120, frame => frame / 10000);
    engine.resume();
    rig.context.advanceToFrame(6144, frame => frame / 10000);
    assert.equal(engine.getDurationSeconds(), 3.072);
    const take = await engine.stop();
    const wav = await decodeFloatWav(take.blob);
    assert.equal(wav.frameCount, 3072);
    assert.equal(take.durationSeconds, 3.072);
    assert.equal(wav.samples[0], Math.fround(2048 / 10000));
    assert.equal(wav.samples[2048], Math.fround(5120 / 10000));
    sessionBlobUrlRegistry.release(take.url);
  });
});

test('capture refuses an expired pre-roll boundary rather than silently starting late', async () => {
  const rig = createRecordingTestRig();
  const { engine } = await prepareRig(rig);
  rig.context.advanceToFrame(65536);
  await assert.rejects(engine.start(0), /older than the retained microphone pre-roll/i);
  assert.equal(engine.getState(), 'prepared');
  await assert.rejects(engine.cancel(), /cancelled/);
});

test('worklet channel-layout changes during capture reject the take and clean up the input', async () => {
  const errors: Error[] = [];
  const rig = createRecordingTestRig({ onError: error => errors.push(error) });
  const { engine } = await prepareRig(rig);
  await engine.start(rig.context.currentTime);
  rig.context.advanceToFrame(2176, () => 0.2, 2);
  assert.equal(engine.getState(), 'idle');
  assert.match(errors[0]?.message ?? '', /channel layout changed/i);
  assert.equal(rig.stream.tracks[0].stopped, true);
  assert.equal(hasActiveRecordingEngineSession(), false);
});

test('empty captures and persistence failures reject without publishing a URL', async () => {
  await withObjectUrlMock(async () => {
    const urlCallsBefore = nextUrl;
    const emptyRig = createRecordingTestRig();
    const { engine: emptyEngine } = await prepareRig(emptyRig);
    const emptyStart = emptyRig.context.currentTime;
    await emptyEngine.start(emptyStart);
    await assert.rejects(emptyEngine.stop(emptyStart), /no captured audio frames/i);
    assert.equal(emptyEngine.getState(), 'idle');
    assert.equal(nextUrl, urlCallsBefore, 'an empty capture never creates or publishes a Blob URL');

    const persistenceError = new Error('storage unavailable');
    const persistenceErrors: Error[] = [];
    const persistenceUrlCallsBefore = nextUrl;
    const failedRig = createRecordingTestRig({
      persistAudioClip: async () => { throw persistenceError; },
      onError: error => persistenceErrors.push(error),
    });
    const { engine: failedEngine } = await prepareRig(failedRig);
    await failedEngine.start(failedRig.context.currentTime);
    failedRig.context.advanceToFrame(4096, () => 0.1);
    await assert.rejects(failedEngine.stop(), error => error === persistenceError);
    assert.equal(nextUrl, persistenceUrlCallsBefore, 'persistence failure cannot return a publishable URL');
    assert.equal(persistenceErrors[0], persistenceError);
    assert.equal(failedEngine.getState(), 'idle');
    assert.equal(failedRig.stream.tracks[0].stopped, true);
    assert.equal(hasActiveRecordingEngineSession(), false);
  });
});

test('repeated stop calls share one worklet finalization and one persisted recording', async () => {
  await withObjectUrlMock(async () => {
    let persistCalls = 0;
    let persistedBlob: Blob | null = null;
    const rig = createRecordingTestRig({
      persistAudioClip: async (_id, blob) => { persistCalls++; persistedBlob = blob; },
    });
    const { engine, node } = await prepareRig(rig);
    await engine.start(rig.context.currentTime);
    rig.context.advanceToFrame(4096, () => 0.2);

    const firstStop = engine.stop();
    const secondStop = engine.stop();
    assert.strictEqual(firstStop, secondStop, 'all callers observe the same finalization promise');
    assert.equal(node.commands.filter(command => command.direction === 'main-to-processor' && command.type === 'stop').length, 1);
    const result = await firstStop;
    assert.strictEqual(await secondStop, result);
    assert.equal(persistCalls, 1, 'only one asset is persisted');
    assert.equal(result.captureStartFrame, 2048);
    assert.equal(result.captureEndFrame, 4096);
    assert.equal(result.capturedFrames, 2048, 'the final queued sample frames through the exclusive stop are included');
    assert.strictEqual(result.blob, persistedBlob, 'the published take is the Blob registered by persistence');
    const persistedWav = await decodeFloatWav(persistedBlob!);
    assert.equal(persistedWav.sampleRate, rig.context.sampleRate);
    assert.ok(persistedWav.frameCount > 0, 'persistence receives non-empty 32-bit IEEE-float PCM');
    assert.ok(result.waveform.length > 0, 'the returned take includes waveform peaks from decoded PCM');
    assert.ok(result.waveform.some(value => value > 0));
    assert.equal(sessionBlobUrlRegistry.getOwnerCount(result.url), 1, 'the published URL has one explicit owner');
    assert.equal(engine.getState(), 'idle');
    assert.equal(rig.stream.tracks[0].stopped, true);
    assert.equal(hasActiveRecordingEngineSession(), false);
    sessionBlobUrlRegistry.release(result.url);
    assert.equal(sessionBlobUrlRegistry.getOwnerCount(result.url), 0, 'releasing the temporary owner clears registry ownership');
  });
});

test('repeated cancellation during recording is safe and releases the stream and capture lock once', async () => {
  const rig = createRecordingTestRig();
  const { engine } = await prepareRig(rig);
  await engine.start(rig.context.currentTime);
  const firstCancellation = engine.cancel();
  const firstRejected = assert.rejects(firstCancellation, RecordingCancelledError);
  await engine.cancel();
  await firstRejected;
  assert.equal(engine.getState(), 'idle');
  assert.equal(rig.stream.tracks[0].stopped, true);
  assert.equal(hasActiveRecordingEngineSession(), false);
});

test('dispose during preparation aborts safely and stops a permission stream that arrives later', async () => {
  const rig = createRecordingTestRig();
  let resolvePermission!: (stream: MediaStream) => void;
  const permission = new Promise<MediaStream>(resolve => { resolvePermission = resolve; });
  const engine = new RecordingEngine(() => rig.context as unknown as AudioContext, {
    ...rig.engineOptions,
    getUserMedia: () => permission,
  });
  const preparing = engine.prepare();
  await engine.dispose();
  await assert.rejects(preparing, RecordingCancelledError);
  assert.equal(engine.getState(), 'idle');
  assert.equal(hasActiveRecordingEngineSession(), false);

  resolvePermission(rig.stream as unknown as MediaStream);
  await permission;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(rig.stream.tracks[0].stopped, true, 'late getUserMedia completion cannot leak a track');
});

test('dispose during recording cancels capture and cleans up all active resources', async () => {
  const rig = createRecordingTestRig();
  const { engine } = await prepareRig(rig);
  await engine.start(rig.context.currentTime);
  await engine.dispose();
  assert.equal(engine.getState(), 'idle');
  assert.equal(rig.stream.tracks[0].stopped, true);
  assert.equal(hasActiveRecordingEngineSession(), false);
});

test('a throwing onError callback cannot block finalization rejection or cleanup', async () => {
  await withObjectUrlMock(async () => {
    const originalConsoleError = console.error;
    console.error = () => undefined;
    try {
      const persistenceError = new Error('storage unavailable');
      const urlCallsBefore = nextUrl;
      const rig = createRecordingTestRig({
        persistAudioClip: async () => { throw persistenceError; },
        onError: () => { throw new Error('injected onError failure'); },
      });
      const { engine } = await prepareRig(rig);
      await engine.start(rig.context.currentTime);
      rig.context.advanceToFrame(4096, () => 0.1);
      await assert.rejects(engine.stop(), error => error === persistenceError);
      assert.equal(nextUrl, urlCallsBefore, 'a callback exception cannot publish a URL');
      assert.equal(engine.getState(), 'idle');
      assert.equal(rig.stream.tracks[0].stopped, true);
      assert.equal(hasActiveRecordingEngineSession(), false);
    } finally {
      console.error = originalConsoleError;
    }
  });
});

test('cancellation during finalization waits for persisted-asset deletion and never publishes a URL', async () => {
  await withObjectUrlMock(async () => {
    const persisted = new Map<string, Blob>();
    const persistStarted = deferred<{ id: string; blob: Blob }>();
    const allowPersist = deferred<void>();
    const deleteStarted = deferred<string>();
    const allowDelete = deferred<void>();
    const deletedIds: string[] = [];
    const rig = createRecordingTestRig({
      persistAudioClip: async (id, blob) => {
        persistStarted.resolve({ id, blob });
        await allowPersist.promise;
        persisted.set(id, blob);
      },
      deletePersistedAudioClip: async id => {
        deletedIds.push(id);
        deleteStarted.resolve(id);
        await allowDelete.promise;
        persisted.delete(id);
      },
    });
    const { engine } = await prepareRig(rig);
    await engine.start(rig.context.currentTime);
    rig.context.advanceToFrame(4096, () => 0.1);
    const urlCallsBefore = nextUrl;
    const stopping = engine.stop();
    const asset = await persistStarted.promise;
    const stopRejected = assert.rejects(stopping, RecordingCancelledError);
    let cancellationSettled = false;
    const cancellation = engine.cancel();
    const cancellationRejected = assert.rejects(cancellation, RecordingCancelledError).then(() => {
      cancellationSettled = true;
    });

    allowPersist.resolve();
    assert.equal(await deleteStarted.promise, asset.id);
    assert.equal(persisted.get(asset.id), asset.blob, 'the persisted asset exists until deletion is committed');
    assert.equal(cancellationSettled, false, 'cancel does not finish before the orphan is removed');
    assert.equal(nextUrl, urlCallsBefore, 'cancelled finalization never creates a playable URL');

    allowDelete.resolve();
    await Promise.all([stopRejected, cancellationRejected]);
    assert.equal(persisted.has(asset.id), false);
    assert.deepEqual(deletedIds, [asset.id], 'the just-persisted asset is deleted exactly once');
    assert.equal(cancellationSettled, true);
    assert.equal(engine.getState(), 'idle');
    assert.equal(rig.stream.tracks[0].stopped, true);
    assert.equal(hasActiveRecordingEngineSession(), false);
  });
});

test('unexpected AudioWorklet processor failures clean up recording and finalization resources', async () => {
  const errors: Error[] = [];
  const rig = createRecordingTestRig({ onError: error => errors.push(error) });
  const { engine, node } = await prepareRig(rig);
  await engine.start(rig.context.currentTime);
  node.onprocessorerror?.(new Event('processorerror'));
  assert.equal(engine.getState(), 'idle');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /AudioWorklet processor failed/i);
  assert.equal(node.commands.some(command => command.direction === 'main-to-processor' && command.type === 'cancel'), true);
  assert.equal(rig.stream.tracks[0].stopped, true);
  assert.equal(hasActiveRecordingEngineSession(), false);

  const persisted = new Map<string, Blob>();
  const persistStarted = deferred<{ id: string; blob: Blob }>();
  const allowPersistence = deferred<void>();
  const deletedIds: string[] = [];
  const finalizationErrors: Error[] = [];
  const finalizingRig = createRecordingTestRig({
    persistAudioClip: async (id, blob) => {
      persisted.set(id, blob);
      persistStarted.resolve({ id, blob });
      await allowPersistence.promise;
    },
    deletePersistedAudioClip: async id => { deletedIds.push(id); persisted.delete(id); },
    onError: error => finalizationErrors.push(error),
  });
  const { engine: finalizingEngine, node: finalizingNode } = await prepareRig(finalizingRig);
  await finalizingEngine.start(finalizingRig.context.currentTime);
  finalizingRig.context.advanceToFrame(4096, () => 0.1);
  const stopping = finalizingEngine.stop();
  const asset = await persistStarted.promise;
  finalizingNode.onprocessorerror?.(new Event('processorerror'));
  await assert.rejects(stopping, /AudioWorklet processor failed/i);
  assert.equal(finalizationErrors.length, 1);
  assert.equal(finalizingEngine.getState(), 'idle');
  assert.equal(finalizingRig.stream.tracks[0].stopped, true);
  assert.equal(hasActiveRecordingEngineSession(), false);

  allowPersistence.resolve();
  await finalizingEngine.dispose();
  assert.equal(persisted.has(asset.id), false, 'a late persistence completion is deleted after worklet failure');
  assert.deepEqual(deletedIds, [asset.id]);
  assert.equal(hasActiveRecordingEngineSession(), false);
});
