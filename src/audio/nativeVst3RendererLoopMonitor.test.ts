import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RENDERER_LOOP_HEARTBEAT_INTERVAL_MS, RENDERER_LOOP_STALL_SAMPLE_LIMIT,
  applyNativeVst3RendererLoopHeartbeat, correlateNativeVst3RendererLoopArrival,
  createNativeVst3RendererLoopState, estimateIpcClockOffset, estimateIpcDirectionalDelay,
  getNativeVst3RendererLoopMonitorSnapshot, resetNativeVst3MixerEffectSmokeTiming,
  selectLongTasksOverlapping, selectRendererLoopStallsNear,
  startNativeVst3RendererLoopMonitor, stopNativeVst3RendererLoopMonitor,
  tickNativeVst3RendererLoopMonitorForTest,
} from './nativeVst3EffectRuntime';

test('renderer loop heartbeat aggregation uses renderer timestamps, not context frames', () => {
  const state = createNativeVst3RendererLoopState(1000, 3);
  const onTime = applyNativeVst3RendererLoopHeartbeat(state, 1003, 1100928);
  assert.equal(onTime.driftMs, 0);
  assert.equal(onTime.gapMs, 3);
  assert.equal(onTime.contextFrame, 1100928);
  assert.equal(state.delaysOver4ms, 0);
  const late = applyNativeVst3RendererLoopHeartbeat(state, 1016, 1101568);
  assert.equal(late.expectedAtMs, 1006);
  assert.equal(late.driftMs, 10);
  assert.equal(late.gapMs, 13);
  assert.equal(late.contextFrame, 1101568);
  assert.equal(state.maxDriftMs, 10);
  assert.equal(state.maxGapMs, 13);
  assert.equal(state.delaysOver4ms, 1);
  assert.equal(state.delaysOver8ms, 1);
  assert.equal(state.stalls.length, 1);
  assert.equal(state.heartbeatCount, 2);
  assert.notEqual(late.driftMs, late.contextFrame, 'AudioContext frames are not treated as renderer wall-clock timestamps');
});

test('renderer loop stall samples stay bounded', () => {
  const state = createNativeVst3RendererLoopState(0, 3);
  for (let index = 0; index < RENDERER_LOOP_STALL_SAMPLE_LIMIT + 20; index++) {
    applyNativeVst3RendererLoopHeartbeat(state, 3 + index * 20, index);
  }
  assert.equal(state.stalls.length, RENDERER_LOOP_STALL_SAMPLE_LIMIT);
  assert.ok(state.heartbeatCount > RENDERER_LOOP_STALL_SAMPLE_LIMIT);
  assert.ok(state.delaysOver4ms > RENDERER_LOOP_STALL_SAMPLE_LIMIT);
});

test('correlation selects stalls near arrival without using context frames as times', () => {
  const stalls = [
    { expectedAtMs: 80, actualAtMs: 92, driftMs: 12, gapMs: 15, contextFrame: 1100928 },
    { expectedAtMs: 180, actualAtMs: 190, driftMs: 10, gapMs: 13, contextFrame: 1101568 },
  ];
  const near = selectRendererLoopStallsNear(stalls, 100);
  assert.deepEqual(near.map(sample => sample.actualAtMs), [92]);
  const correlated = correlateNativeVst3RendererLoopArrival(
    { last: stalls[0], stalls, maxDriftMs: 12, heartbeatCount: 4 },
    100,
    { precedingHeartbeatDriftMs: 12, precedingHeartbeatGapMs: 15, precedingHeartbeatAtMs: 92, precedingHeartbeatContextFrame: 1100928 },
  );
  assert.equal(correlated.precedingHeartbeatDriftMs, 12);
  assert.equal(correlated.precedingHeartbeatContextFrame, 1100928);
  assert.equal(correlated.maxDriftInWindowMs, 12);
  assert.equal(correlated.stallCountInWindow, 1);
});

test('renderer loop monitor starts and stops with the smoke capture lifecycle', () => {
  const original = (globalThis as any).desktopApp;
  const context: any = { currentTime: 1, sampleRate: 48000 };
  try {
    (globalThis as any).desktopApp = undefined;
    startNativeVst3RendererLoopMonitor(context);
    assert.equal(getNativeVst3RendererLoopMonitorSnapshot(), null);
    (globalThis as any).desktopApp = { smokeTest: true };
    resetNativeVst3MixerEffectSmokeTiming();
    startNativeVst3RendererLoopMonitor(context);
    const live = getNativeVst3RendererLoopMonitorSnapshot();
    assert.ok(live);
    assert.equal(live.intervalMs, RENDERER_LOOP_HEARTBEAT_INTERVAL_MS);
    assert.equal(live.stoppedAtMs, null);
    const sample = tickNativeVst3RendererLoopMonitorForTest(live.startedAtMs + 11, 48000);
    assert.ok(sample.driftMs >= 8);
    assert.equal(sample.contextFrame, 48000);
    const stopped = stopNativeVst3RendererLoopMonitor();
    assert.ok(stopped);
    assert.ok(Number.isFinite(stopped.stoppedAtMs));
    assert.equal(stopped.heartbeatCount, 1);
    assert.equal(stopped.stalls.length, 1);
    assert.equal(getNativeVst3RendererLoopMonitorSnapshot(), null);
  } finally {
    stopNativeVst3RendererLoopMonitor();
    (globalThis as any).desktopApp = original;
  }
});

test('renderer loop stalls recorded before a later capture window remain available', () => {
  const original = (globalThis as any).desktopApp;
  const context: any = { currentTime: 0.5, sampleRate: 48000 };
  try {
    (globalThis as any).desktopApp = { smokeTest: true };
    resetNativeVst3MixerEffectSmokeTiming();
    startNativeVst3RendererLoopMonitor(context);
    const live = getNativeVst3RendererLoopMonitorSnapshot()!;
    tickNativeVst3RendererLoopMonitorForTest(live.startedAtMs + 12, 24000);
    const captureWindowStart = live.startedAtMs + 500;
    const stopped = stopNativeVst3RendererLoopMonitor()!;
    assert.equal(stopped.stalls.length, 1);
    assert.ok(stopped.stalls[0]!.actualAtMs < captureWindowStart);
    assert.equal(selectRendererLoopStallsNear(stopped.stalls, stopped.stalls[0]!.actualAtMs).length, 1);
  } finally {
    stopNativeVst3RendererLoopMonitor();
    (globalThis as any).desktopApp = original;
  }
});

test('long-task overlap uses timestamps, not context frames', () => {
  const tasks = [
    { startAtMs: 90, durationMs: 20 },
    { startAtMs: 400, durationMs: 329 },
  ];
  const near = selectLongTasksOverlapping(tasks, 100, 123);
  assert.deepEqual(near.map(task => task.startAtMs), [90]);
  assert.equal(selectLongTasksOverlapping(tasks, Number.NaN, 123).length, 0);
});

test('clock offset uses the lowest-RTT sample and reports uncertainty', () => {
  const offset = estimateIpcClockOffset([
    { preloadSentAtMs: 0, mainReceivedAtMs: 20, mainReplyAtMs: 21, preloadReceivedAtMs: 40 },
    { preloadSentAtMs: 100, mainReceivedAtMs: 100.4, mainReplyAtMs: 100.5, preloadReceivedAtMs: 101 },
    { preloadSentAtMs: 200, mainReceivedAtMs: Number.NaN, mainReplyAtMs: 201, preloadReceivedAtMs: 202 },
  ]);
  assert.equal(offset.sampleCount, 2);
  assert.equal(offset.rejectedSampleCount, 1);
  assert.ok(Math.abs((offset.minRttMs ?? 0) - 0.9) < 1e-9);
  assert.ok(Math.abs((offset.offsetMainMinusPreloadMs ?? 0) - 0) < 0.5);
  assert.ok((offset.uncertaintyMs ?? 99) < 1);
  assert.equal(offset.inconclusive, false);
});

test('missing or inverted clock samples are rejected as inconclusive', () => {
  const missing = estimateIpcClockOffset([]);
  assert.equal(missing.inconclusive, true);
  assert.equal(missing.reason, 'no-valid-samples');
  const inverted = estimateIpcClockOffset([
    { preloadSentAtMs: 0, mainReceivedAtMs: 1, mainReplyAtMs: 10, preloadReceivedAtMs: 2 },
  ]);
  assert.equal(inverted.sampleCount, 0);
  assert.equal(inverted.inconclusive, true);
});

test('directional IPC delay stays inconclusive when uncertainty is too large', () => {
  const tight = estimateIpcDirectionalDelay({
    invokeStartedAt: 0, responseReceivedAt: 23.3,
    ipcReceivedAtMainMs: 20, ipcReplyAtMainMs: 22.83,
    offsetMainMinusPreloadMs: 0, uncertaintyMs: 0.4,
  });
  assert.equal(tight.inconclusive, false);
  assert.ok(Math.abs((tight.requestLegMs ?? 0) - 20) < 1e-9);
  assert.ok(Math.abs((tight.responseLegMs ?? 0) - 0.47) < 1e-9);
  const loose = estimateIpcDirectionalDelay({
    invokeStartedAt: 0, responseReceivedAt: 23.3,
    ipcReceivedAtMainMs: 20, ipcReplyAtMainMs: 22.83,
    offsetMainMinusPreloadMs: 0, uncertaintyMs: 8,
  });
  assert.equal(loose.inconclusive, true);
  assert.equal(loose.reason, 'uncertainty-exceeds-4ms');
  const missing = estimateIpcDirectionalDelay({ invokeStartedAt: 0, responseReceivedAt: 23.3 });
  assert.equal(missing.inconclusive, true);
  assert.equal(missing.reason, 'missing-timestamps-or-offset');
});
