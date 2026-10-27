import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { VST3_FX_BLOCK_FRAMES, VST3_FX_PIPELINE_FRAMES, VST3_FX_WORKLET_SOURCE, NativeVst3EffectRuntime } from './nativeVst3EffectRuntime';
import type { FxSlot, MixerTrack } from '../types/daw';
import type { Vst3Bridge, Vst3Effect } from './nativeVst3Types';

function createWorklet() {
  const sandbox: any = {
    currentFrame: 0,
    Float32Array,
    Map,
    Number,
    Array,
    Math,
    AudioWorkletProcessor: class {
      port = {
        onmessage: null as ((event: { data: any }) => void) | null,
        sent: [] as any[],
        postMessage(message: any) { this.sent.push(message); },
      };
    },
    registerProcessor(_name: string, constructor: new (options: any) => any) { sandbox.Processor = constructor; },
  };
  runInNewContext(VST3_FX_WORKLET_SOURCE, sandbox);
  const processor = new sandbox.Processor({ processorOptions: { profileEnabled: true } });
  const next = (withInput = true) => {
    const left = new Float32Array(128), right = new Float32Array(128);
    if (withInput) { left.fill(0.25); right.fill(-0.25); }
    const output = [new Float32Array(128), new Float32Array(128)];
    sandbox.currentFrame = processor.outputFrame;
    processor.process(withInput ? [[left, right]] : [[]], [output]);
    return output;
  };
  const sendResult = (sequence: number, value = 0.5) => {
    const samples = new Float32Array(VST3_FX_BLOCK_FRAMES * 2);
    samples.fill(value);
    processor.port.onmessage!({ data: { type: 'result', sequence, samples } });
  };
  return { processor, next, sendResult };
}

function processMessages(processor: any) {
  return processor.port.sent.filter((message: any) => message?.type === 'process');
}
function profileMessages(processor: any, event: string) {
  return processor.port.sent.filter((message: any) => message?.type === 'profile' && message.event === event);
}

const effect: Vst3Effect = {
  path: 'C:/test/mda-vst3.vst3', classId: '0123456789ABCDEF0123456789ABCDEF', name: 'mda test effect', vendor: 'mda', version: 'test',
  state: { schema: 1, classId: '0123456789ABCDEF0123456789ABCDEF', parameters: [] },
};
const slot: FxSlot = { id: 'fx-test', type: 'vst3', name: effect.name, enabled: true, mix: 1, params: {}, vst3Effect: effect };
const track: MixerTrack = { id: 1, name: 'Test', color: '#fff', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [slot], peakL: 0, peakR: 0 };

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

 test('Mixer worklet accepts a delayed but in-window PCM response and emits the exact scheduled block', () => {
  const { processor, next, sendResult } = createWorklet();
  for (let i = 0; i < VST3_FX_BLOCK_FRAMES / 128; i++) next();
  assert.equal(processMessages(processor).length, 1);
  for (let i = 0; i < 4; i++) next(); // 10.67 ms elapsed; response is still before the 21.33 ms deadline.
  sendResult(0, 0.5);
  let scheduledOutput: Float32Array[] = [];
  for (let i = 0; i < 5; i++) scheduledOutput = next();
  assert.equal(processor.failed, false);
  assert.ok(profileMessages(processor, 'worklet-result').some((message: any) => message.accepted));
  assert.equal(scheduledOutput[0][0], 0.5, 'the accepted PCM arrives at the scheduled output frame, not early or dry');
  assert.ok(processor.outputFrame >= VST3_FX_PIPELINE_FRAMES);
  assert.deepEqual(processMessages(processor).map((message: any) => message.sequence), [0, 1], 'requests remain FIFO and sequence-monotone');
});

test('Mixer worklet rejects stale/out-of-order sequence data without replacing the pending valid response', () => {
  const { processor, next, sendResult } = createWorklet();
  for (let i = 0; i < VST3_FX_BLOCK_FRAMES / 128; i++) next();
  sendResult(1, 9);
  assert.equal(processor.pending, 0);
  assert.ok(profileMessages(processor, 'worklet-result').some((message: any) => message.accepted === false));
  sendResult(0, 0.5);
  for (let i = 0; i < 9; i++) next();
  assert.equal(processor.failed, false);
  assert.ok(profileMessages(processor, 'worklet-result').some((message: any) => message.accepted === true));
  assert.ok(processor.ready.size <= 1);
  assert.ok(processor.dryReady.size <= 2, 'the delayed output pipeline retains at most two bounded dry blocks');
});

test('Mixer worklet bounds a saturated request queue and fails closed instead of replaying stale or dry PCM', () => {
  const { processor, next, sendResult } = createWorklet();
  for (let i = 0; i < VST3_FX_BLOCK_FRAMES / 128; i++) next();
  for (let i = 0; i < VST3_FX_BLOCK_FRAMES / 128; i++) next();
  assert.equal(processor.failed, true);
  assert.equal(processMessages(processor).length, 1, 'one pending block is the hard in-flight bound');
  assert.equal(profileMessages(processor, 'pending-deadline-miss').length, 1);
  sendResult(0, 9); // a late response after fault must not become audible.
  const output = next();
  assert.ok(output[0].every((sample: number) => sample === 0));
  assert.ok(output[1].every((sample: number) => sample === 0));
  assert.ok(processor.ready.size <= 1);
  assert.ok(processor.dryReady.size <= 1);
});

test('Mixer worklet reports an output deadline miss when no matching processed PCM is ready at its due frame', () => {
  const { processor, next } = createWorklet();
  for (let i = 0; i < VST3_FX_BLOCK_FRAMES / 128; i++) next();
  while (processor.outputFrame < VST3_FX_PIPELINE_FRAMES) next(false);
  next(false);
  assert.equal(processor.failed, true);
  assert.equal(profileMessages(processor, 'deadline-miss').length, 1);
  assert.ok(processor.ready.size <= 1);
  assert.ok(processor.dryReady.size <= 1);
});

test('Mixer runtime disposal discards a delayed response, closes its helper, and a fresh take recovers', async () => {
  const originalNode = (globalThis as any).AudioWorkletNode;
  const nodes: any[] = [];
  class FakeAudioWorkletNode {
    port = { onmessage: null as ((event: { data: any }) => void) | null, sent: [] as any[], closed: false,
      postMessage(message: any) { this.sent.push(message); }, close() { this.closed = true; } };
    onprocessorerror: (() => void) | null = null;
    disconnected = false;
    constructor(_context: any, _name: string, _options: any) { nodes.push(this); }
    disconnect() { this.disconnected = true; }
  }
  (globalThis as any).AudioWorkletNode = FakeAudioWorkletNode;
  let session = 0;
  const closed: string[] = [];
  let delayedResolve: ((pcm: Float32Array) => void) | undefined;
  const bridge: Vst3Bridge = {
    paths: async () => [], choosePath: async () => null,
    discover: async () => ({ plugins: [], errors: [] }), discoverEffects: async () => ({ plugins: [], errors: [] }),
    inspect: async () => { throw new Error('unused'); }, inspectEffect: async () => { throw new Error('unused'); },
    describeEffect: async () => ({ parameters: [], controllerAvailable: false }), describe: async () => ({ parameters: [], controllerAvailable: false }),
    parameters: async () => [], open: async () => ({ id: `session-${++session}`, latencySamples: 0 }),
    process: async () => new Float32Array(),
    processAudio: async () => new Promise<Float32Array>(resolve => { delayedResolve = resolve; }),
    close: async id => { closed.push(id); },
  };
  const context: any = { sampleRate: 48000, currentTime: 0, state: 'running', audioWorklet: { addModule: async () => {} } };
  const runtime = new NativeVst3EffectRuntime(() => {}, () => bridge);
  try {
    await runtime.prepareTracks([track], context);
    const firstNode = nodes[0];
    firstNode.port.onmessage!({ data: { type: 'process', sequence: 0, samples: new Float32Array(2048) } });
    await tick();
    assert.ok(delayedResolve, 'one real production-runtime helper request was started');
    const stop = runtime.stop();
    assert.equal(firstNode.port.closed, true);
    assert.equal(firstNode.disconnected, true);
    delayedResolve!(new Float32Array(2048).fill(0.75));
    await stop;
    assert.ok(closed.includes('session-1'));
    assert.equal(firstNode.port.sent.some((message: any) => message.type === 'result'), false, 'disposed runtime cannot post stale PCM');

    (bridge as any).processAudio = async () => new Float32Array(2048).fill(0.25);
    await runtime.prepareTracks([track], context);
    const recoveredNode = nodes[1];
    recoveredNode.port.onmessage!({ data: { type: 'process', sequence: 0, samples: new Float32Array(2048) } });
    await tick(); await tick();
    assert.ok(recoveredNode.port.sent.some((message: any) => message.type === 'result'));
    await runtime.stop();
    assert.ok(closed.includes('session-2'));
  } finally {
    await runtime.stop();
    (globalThis as any).AudioWorkletNode = originalNode;
  }
});
