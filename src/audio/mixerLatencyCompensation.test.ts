import test from 'node:test';
import assert from 'node:assert/strict';
import { computeMixerLatencyCompensation, MAX_MIXER_COMPENSATION_SECONDS } from './mixerLatencyCompensation';
import { MixerRoutingAdapter } from './mixerRoutingAdapter';

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

test('aligns heterogeneous nonzero plugin latencies across serial inserts, routed buses, and aux-send diamonds without double-counting', () => {
  // Track 1: two serial inserts (2048+320) + (2048+512) = 4928 frames -> routed to Master (0) AND aux-sent to Aux Return (4)
  // Track 2: one insert (2048+180) = 2228 frames -> aux-sent to Aux Return (4) AND routed to Bus (3)
  // Bus (3): one insert (2048+250) = 2298 frames -> routed to Master (0)
  // Aux Return (4): one insert (2048+440) = 2488 frames -> routed to Master (0)
  // Track 5: dry track (0 frames) -> routed to Master (0)
  const trackBudgets = new Map<number, number>([
    [0, blockPipeline + 100], // Master itself has 1 insert (2148 frames)
    [1, (blockPipeline + 320) + (blockPipeline + 512)], // 4928
    [2, blockPipeline + 180], // 2228
    [3, blockPipeline + 250], // 2298
    [4, blockPipeline + 440], // 2488
    [5, 0],
  ]);
  const edges = [
    { id: 'route:1', sourceTrackId: 1, targetTrackId: 0 },
    { id: 'aux:1:4', sourceTrackId: 1, targetTrackId: 4 },
    { id: 'route:2', sourceTrackId: 2, targetTrackId: 3 },
    { id: 'aux:2:4', sourceTrackId: 2, targetTrackId: 4 },
    { id: 'route:3', sourceTrackId: 3, targetTrackId: 0 },
    { id: 'route:4', sourceTrackId: 4, targetTrackId: 0 },
    { id: 'route:5', sourceTrackId: 5, targetTrackId: 0 },
  ];
  const result = computeMixerLatencyCompensation([0, 1, 2, 3, 4, 5], edges, id => trackBudgets.get(id) ?? 0);

  // Bus 3 receives Track 2 (2228) -> Bus 3 output = 2228 + 2298 = 4526
  assert.equal(result.directInputDelayFrames.get(3), 2228);
  assert.equal(result.routeDelayFrames.get('route:2'), 0);
  assert.equal(result.outputLatencyFrames.get(3), 4526);

  // Aux Return 4 receives Track 1 (4928) and Track 2 (2228):
  // Track 2's aux send is delayed by 4928 - 2228 = 2700 frames; Track 1's aux send is delayed by 0.
  // Aux Return 4 output = 4928 + 2488 = 7416 frames.
  assert.equal(result.directInputDelayFrames.get(4), 4928);
  assert.equal(result.routeDelayFrames.get('aux:1:4'), 0);
  assert.equal(result.routeDelayFrames.get('aux:2:4'), 2700);
  assert.equal(result.outputLatencyFrames.get(4), 7416);

  // At Master (0), slowest incoming branch is Aux Return 4 at 7416 frames:
  // Track 1 direct route is delayed by 7416 - 4928 = 2488 (matching Aux Return 4's insert exactly — Track 1's own 4928 is NOT double-counted!)
  // Bus 3 route is delayed by 7416 - 4526 = 2890
  // Dry Track 5 route is delayed by 7416 - 0 = 7416
  assert.equal(result.routeDelayFrames.get('route:4'), 0);
  assert.equal(result.routeDelayFrames.get('route:1'), 2488);
  assert.equal(result.routeDelayFrames.get('route:3'), 2890);
  assert.equal(result.routeDelayFrames.get('route:5'), 7416);

  // Every path from any source into Master arrives at exact frame 7416 before Master's own insert:
  assert.equal(result.outputLatencyFrames.get(1)! + result.routeDelayFrames.get('route:1')!, 7416);
  assert.equal(result.outputLatencyFrames.get(1)! + result.routeDelayFrames.get('aux:1:4')! + trackBudgets.get(4)! + result.routeDelayFrames.get('route:4')!, 7416);
  assert.equal(result.outputLatencyFrames.get(2)! + result.routeDelayFrames.get('route:2')! + trackBudgets.get(3)! + result.routeDelayFrames.get('route:3')!, 7416);
  assert.equal(result.outputLatencyFrames.get(2)! + result.routeDelayFrames.get('aux:2:4')! + trackBudgets.get(4)! + result.routeDelayFrames.get('route:4')!, 7416);
  assert.equal(result.outputLatencyFrames.get(5)! + result.routeDelayFrames.get('route:5')!, 7416);
  assert.equal(result.outputLatencyFrames.get(0), 7416 + (blockPipeline + 100));
});

test('MixerRoutingAdapter fails explicitly instead of silently clamping when route compensation exceeds MAX_MIXER_COMPENSATION_SECONDS', () => {
  const sampleRate = 48000;
  const mockContext = {
    sampleRate,
    createDelay(maxSeconds: number) {
      assert.equal(maxSeconds, MAX_MIXER_COMPENSATION_SECONDS);
      return { delayTime: { value: 0 }, connect() {}, disconnect() {} };
    },
  };
  const makeNode = () => ({ context: mockContext, connect() {}, disconnect() {} } as any);
  const nodes = new Map([
    [0, { input: makeNode(), routingInput: makeNode(), output: makeNode() }],
    [1, { input: makeNode(), routingInput: makeNode(), output: makeNode() }],
  ]);
  const adapter = new MixerRoutingAdapter(nodes, 0);
  const excessiveFrames = sampleRate * MAX_MIXER_COMPENSATION_SECONDS + 1;
  assert.throws(
    () => adapter.syncRoutes([{ trackId: 1, targetId: 0 }], new Map([[1, excessiveFrames]])),
    /exceeds the maximum 10 s DelayNode budget/,
  );
});

