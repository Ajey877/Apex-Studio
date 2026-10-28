import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMixerLatencyCompensation } from './mixerLatencyCompensation';

const blockPipeline = 2048;

test('aligns zero, one, and two insert tracks at the master without shifting the effect paths', () => {
  const result = computeMixerLatencyCompensation([0, 1, 2], [
    { id: 'route-1', sourceTrackId: 1, targetTrackId: 0 },
    { id: 'route-2', sourceTrackId: 2, targetTrackId: 0 },
  ], trackId => trackId === 1 ? blockPipeline * 2 : trackId === 2 ? blockPipeline : 0);

  assert.equal(result.outputLatencyFrames.get(1), blockPipeline * 2);
  assert.equal(result.outputLatencyFrames.get(2), blockPipeline);
  assert.equal(result.outputLatencyFrames.get(0), blockPipeline * 2);
  assert.equal(result.directInputDelayFrames.get(0), blockPipeline * 2);
  assert.equal(result.routeDelayFrames.get('route-1'), 0);
  assert.equal(result.routeDelayFrames.get('route-2'), blockPipeline);

  const arrivalsAtMaster = [
    result.outputLatencyFrames.get(1)! + result.routeDelayFrames.get('route-1')!,
    result.outputLatencyFrames.get(2)! + result.routeDelayFrames.get('route-2')!,
  ];
  assert.deepEqual(arrivalsAtMaster, [blockPipeline * 2, blockPipeline * 2]);
});

test('composes compensation across nested buses and aligns direct bus input with routed children', () => {
  const result = computeMixerLatencyCompensation([0, 1, 2, 3], [
    { id: 'track-1-to-bus', sourceTrackId: 1, targetTrackId: 3 },
    { id: 'track-2-to-bus', sourceTrackId: 2, targetTrackId: 3 },
    { id: 'bus-to-master', sourceTrackId: 3, targetTrackId: 0 },
  ], trackId => trackId === 1 ? blockPipeline : trackId === 3 ? blockPipeline : 0);

  assert.equal(result.routeDelayFrames.get('track-1-to-bus'), 0);
  assert.equal(result.directInputDelayFrames.get(3), blockPipeline, 'the bus direct input is aligned with its one-insert child');
  assert.equal(result.routeDelayFrames.get('track-2-to-bus'), blockPipeline);
  assert.equal(result.outputLatencyFrames.get(3), blockPipeline * 2);
  assert.equal(result.routeDelayFrames.get('bus-to-master'), 0);
  assert.equal(result.outputLatencyFrames.get(0), blockPipeline * 2);
});

test('recomputes compensation when bypass/removal changes the active pipeline budget', () => {
  const routes = [
    { id: 'route-1', sourceTrackId: 1, targetTrackId: 0 },
    { id: 'route-2', sourceTrackId: 2, targetTrackId: 0 },
  ];
  const oneBypassedButPresent = computeMixerLatencyCompensation([0, 1, 2], routes,
    trackId => trackId === 1 ? blockPipeline * 2 : 0);
  assert.equal(oneBypassedButPresent.routeDelayFrames.get('route-2'), blockPipeline * 2);

  const removed = computeMixerLatencyCompensation([0, 1, 2], routes, () => 0);
  assert.equal(removed.routeDelayFrames.get('route-2'), 0);
  assert.equal(removed.routeDelayFrames.get('route-1'), 0);
});

test('rejects cycles and malformed frame budgets rather than installing an invalid graph', () => {
  assert.throws(() => computeMixerLatencyCompensation([0, 1, 2], [
    { id: '1-to-2', sourceTrackId: 1, targetTrackId: 2 },
    { id: '2-to-1', sourceTrackId: 2, targetTrackId: 1 },
  ], () => 0), /acyclic/);
  assert.throws(() => computeMixerLatencyCompensation([0], [], () => -1), /invalid native pipeline/);
});
