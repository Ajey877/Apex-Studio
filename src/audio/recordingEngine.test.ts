import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingEngine, hasActiveRecordingEngineSession } from './recordingEngine';
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
    const revokedBefore = sessionBlobUrlRegistry.getOwnerCount('blob:recording-engine-test-never-created');
    const emptyRig = createRecordingTestRig();
    const { engine: emptyEngine } = await prepareRig(emptyRig);
    const emptyStart = emptyRig.context.currentTime;
    await emptyEngine.start(emptyStart);
    await assert.rejects(emptyEngine.stop(emptyStart), /no captured audio frames/i);
    assert.equal(emptyEngine.getState(), 'idle');
    assert.equal(sessionBlobUrlRegistry.getOwnerCount('blob:recording-engine-test-never-created'), revokedBefore);

    const persistenceError = new Error('storage unavailable');
    const persistenceErrors: Error[] = [];
    const failedRig = createRecordingTestRig({
      persistAudioClip: async () => { throw persistenceError; },
      onError: error => persistenceErrors.push(error),
    });
    const { engine: failedEngine } = await prepareRig(failedRig);
    await failedEngine.start(failedRig.context.currentTime);
    failedRig.context.advanceToFrame(4096, () => 0.1);
    await assert.rejects(failedEngine.stop(), error => error === persistenceError);
    assert.equal(persistenceErrors[0], persistenceError);
    assert.equal(failedEngine.getState(), 'idle');
    assert.equal(failedRig.stream.tracks[0].stopped, true);
    assert.equal(hasActiveRecordingEngineSession(), false);
  });
});
