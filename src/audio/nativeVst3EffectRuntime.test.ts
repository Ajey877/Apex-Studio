import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { VST3_FX_BLOCK_FRAMES, VST3_FX_PIPELINE_FRAMES, VST3_FX_WORKLET_SOURCE, NativeVst3EffectRuntime } from './nativeVst3EffectRuntime';
import { createLiveAudioPortSession } from '../../native/vst3/liveAudioPort.mjs';
import type { FxSlot, MixerTrack } from '../types/daw';
import type { Vst3Bridge, Vst3Effect, Vst3ParameterChange } from './nativeVst3Types';

function createWorklet(processorOptions: Record<string, unknown> = { profileEnabled: true }) {
  const sandbox: any = {
    currentFrame: 0,
    Float32Array,
    Map,
    Number,
    Array,
    Math,
    AudioWorkletProcessor: class {
      port = {
        onmessage: null as ((event: { data: any; ports?: any[] }) => void) | null,
        sent: [] as any[],
        postMessage(message: any) { this.sent.push(message); },
      };
    },
    registerProcessor(_name: string, constructor: new (options: any) => any) { sandbox.Processor = constructor; },
  };
  runInNewContext(VST3_FX_WORKLET_SOURCE, sandbox);
  const processor = new sandbox.Processor({ processorOptions });
  let contextFrame = 0;
  const next = (withInput = true) => {
    const left = new Float32Array(128), right = new Float32Array(128);
    if (withInput) { left.fill(0.25); right.fill(-0.25); }
    const output = [new Float32Array(128), new Float32Array(128)];
    sandbox.currentFrame = contextFrame;
    contextFrame += 128;
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
const waitFor = async (predicate: () => boolean, attempts = 40) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('timed out waiting for runtime condition');
};

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

test('a prepared bypass keeps its fixed pipeline delay and emits the matching dry block', () => {
  const { processor, next, sendResult } = createWorklet();
  for (let i = 0; i < VST3_FX_BLOCK_FRAMES / 128; i++) next();
  processor.port.onmessage!({ data: { type: 'bypass', value: true } });
  sendResult(0, 0.75);
  let output: Float32Array[] = [];
  for (let i = 0; i < VST3_FX_BLOCK_FRAMES / 128 + 1; i++) output = next();
  assert.equal(processor.failed, false);
  assert.equal(output[0][0], 0.25);
  assert.equal(output[1][0], -0.25);
  assert.equal(profileMessages(processor, 'worklet-result').at(-1)?.dueOutputFrame, VST3_FX_PIPELINE_FRAMES);
  assert.equal(processor.outputFrame, VST3_FX_PIPELINE_FRAMES + 128);
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

test('Mixer worklet does not consume its fixed pipeline delay before the first input is connected', () => {
  const { processor, next } = createWorklet();
  for (let i = 0; i < 24; i++) next(false);
  assert.equal(processor.outputFrame, 0);
  assert.equal(processor.nodeStartContextFrame, null);
  assert.equal(processMessages(processor).length, 0);
  for (let i = 0; i < VST3_FX_BLOCK_FRAMES / 128; i++) next();
  assert.equal(processor.failed, false);
  assert.equal(processor.nodeStartContextFrame, 24 * 128);
  assert.equal(processor.outputFrame, VST3_FX_BLOCK_FRAMES);
  assert.equal(processMessages(processor).length, 1);
});

test('Mixer worklet processes absent input as zero PCM after startup to preserve block sequencing', () => {
  const { processor, next, sendResult } = createWorklet();
  for (let i = 0; i < VST3_FX_BLOCK_FRAMES / 128; i++) next();
  sendResult(0);
  for (let i = 0; i < VST3_FX_BLOCK_FRAMES / 128; i++) next(false);
  assert.equal(processor.failed, false);
  assert.deepEqual(processMessages(processor).map((message: any) => message.sequence), [0, 1]);
  assert.equal(processor.pending, 1);
  assert.equal(processor.outputFrame, VST3_FX_PIPELINE_FRAMES);
});

test('Mixer worklet reports an output deadline miss when no matching processed PCM is ready at its due frame', () => {
  const { processor, next } = createWorklet();
  for (let i = 0; i < VST3_FX_BLOCK_FRAMES / 128; i++) next();
  // Simulate the output cursor reaching the scheduled due frame before a result arrives.
  processor.outputFrame = VST3_FX_PIPELINE_FRAMES;
  next(false);
  assert.equal(processor.failed, true);
  assert.equal(profileMessages(processor, 'deadline-miss').length, 1);
  assert.ok(processor.ready.size <= 1);
  assert.ok(processor.dryReady.size <= 1);
});

test('Mixer worklet explicitly acknowledges and fences its pending sequence when stop arrives', () => {
  const { processor, next } = createWorklet();
  for (let i = 0; i < VST3_FX_BLOCK_FRAMES / 128; i++) next();
  assert.deepEqual(processMessages(processor).map((message: any) => message.sequence), [0]);
  processor.port.onmessage!({ data: { type: 'stop', reason: 'explicit-stop' } });
  const ack = processor.port.sent.at(-1);
  assert.equal(ack.type, 'stop-ack');
  assert.equal(ack.sequence, 0);
  assert.equal(ack.reason, 'explicit-stop');
  const before = processMessages(processor).length;
  for (let i = 0; i < 24; i++) next();
  assert.equal(processMessages(processor).length, before, 'stopped worklet cannot submit later blocks');
});

test('Mixer runtime disposal discards a delayed response, closes its helper, and a fresh take recovers', async () => {
  const originalNode = (globalThis as any).AudioWorkletNode;
  const nodes: any[] = [];
  class FakeAudioWorkletNode {
    port = { onmessage: null as ((event: { data: any }) => void) | null, sent: [] as any[], closed: false,
      stopSequence: null as number | null,
      postMessage: (message: any) => {
        this.port.sent.push(message);
        if (message?.type === 'stop') queueMicrotask(() => this.port.onmessage?.({ data: {
          type: 'stop-ack', sequence: this.port.stopSequence, reason: message.reason,
        } }));
      }, close() { this.closed = true; } };
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
    firstNode.port.stopSequence = 0;
    const stop = runtime.stop();
    await tick();
    assert.ok(firstNode.port.sent.some((message: any) => message.type === 'stop'));
    assert.equal(firstNode.port.closed, true, 'port closes after the worklet acknowledges stop');
    delayedResolve!(new Float32Array(2048).fill(0.75));
    await stop;
    assert.equal(firstNode.port.closed, true);
    assert.equal(firstNode.disconnected, true);
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


test('stop acknowledges an in-flight block per effect; late session replies cannot contaminate restarted instances', async () => {
  const originalNode = (globalThis as any).AudioWorkletNode;
  const nodes: any[] = [];
  class FakeAudioWorkletNode {
    port = { onmessage: null as ((event: { data: any }) => void) | null, sent: [] as any[], closed: false,
      stopSequence: null as number | null,
      postMessage: (message: any) => {
        this.port.sent.push(message);
        if (message?.type === 'stop') queueMicrotask(() => this.port.onmessage?.({ data: {
          type: 'stop-ack', sequence: this.port.stopSequence, reason: message.reason,
        } }));
      }, close() { this.closed = true; } };
    onprocessorerror: (() => void) | null = null;
    disconnected = false;
    constructor(_context: any, _name: string, _options: any) { nodes.push(this); }
    disconnect() { this.disconnected = true; }
  }
  (globalThis as any).AudioWorkletNode = FakeAudioWorkletNode;
  let nextSession = 0;
  const closed: string[] = [];
  const pending = new Map<string, (pcm: Float32Array) => void>();
  const bridge: Vst3Bridge = {
    paths: async () => [], choosePath: async () => null,
    discover: async () => ({ plugins: [], errors: [] }), discoverEffects: async () => ({ plugins: [], errors: [] }),
    inspect: async () => { throw new Error('unused'); }, inspectEffect: async () => { throw new Error('unused'); },
    describeEffect: async () => ({ parameters: [], controllerAvailable: false }), describe: async () => ({ parameters: [], controllerAvailable: false }),
    parameters: async () => [], open: async () => ({ id: `session-${++nextSession}`, latencySamples: 0 }),
    process: async () => new Float32Array(),
    processAudio: async (id: string) => {
      if (id === 'session-1' || id === 'session-2') return new Promise<Float32Array>(resolve => { pending.set(id, resolve); });
      return new Float32Array(VST3_FX_BLOCK_FRAMES * 2).fill(id === 'session-3' ? 0.3 : 0.4);
    },
    close: async id => { closed.push(id); },
  };
  const secondTrack: MixerTrack = { ...track, id: 2, name: 'Second', fxSlots: [{ ...slot, id: 'fx-second' }] };
  const context: any = { sampleRate: 48000, currentTime: 0, state: 'running', audioWorklet: { addModule: async () => {} } };
  const runtime = new NativeVst3EffectRuntime(() => {}, () => bridge);
  try {
    await runtime.prepareTracks([track, secondTrack], context);
    const [oldA, oldB] = nodes;
    oldA.port.stopSequence = 0; oldB.port.stopSequence = 0;
    oldA.port.onmessage!({ data: { type: 'process', sequence: 0, samples: new Float32Array(VST3_FX_BLOCK_FRAMES * 2) } });
    await tick();
    assert.equal(pending.size, 1, 'first effect reached its in-flight service request');
    const stopping = runtime.stop();
    // Simulate the process message already queued behind worklet-submit when
    // stop starts. The stop handshake must drain/classify it before closing the
    // MessagePort instead of silently dropping it before main IPC.
    oldB.port.onmessage!({ data: { type: 'process', sequence: 0, samples: new Float32Array(VST3_FX_BLOCK_FRAMES * 2) } });
    await tick();
    assert.equal(pending.size, 1, 'queued second-effect request is cancelled before native IPC');
    assert.deepEqual(closed.sort(), ['session-1', 'session-2']);
    assert.deepEqual([oldA, oldB].map(node => node.port.sent.some((message: any) => message.type === 'stop')), [true, true]);
    pending.get('session-1')!(new Float32Array(VST3_FX_BLOCK_FRAMES * 2).fill(0.9));
    await stopping;
    assert.ok([oldA, oldB].every(node => node.port.closed && node.disconnected));
    assert.ok([oldA, oldB].every(node => !node.port.sent.some((message: any) => message.type === 'result')),
      'late results from the explicitly stopped sessions never reach a worklet');

    await runtime.prepareTracks([track, secondTrack], context);
    const [freshA, freshB] = nodes.slice(2);
    for (const node of [freshA, freshB]) node.port.onmessage!({
      data: { type: 'process', sequence: 0, samples: new Float32Array(VST3_FX_BLOCK_FRAMES * 2) },
    });
    await tick(); await tick();
    const resultA = freshA.port.sent.find((message: any) => message.type === 'result');
    const resultB = freshB.port.sent.find((message: any) => message.type === 'result');
    assert.ok(Math.abs(resultA.samples[0] - 0.3) < 1e-6, 'the first restarted effect received only its own session PCM');
    assert.ok(Math.abs(resultB.samples[0] - 0.4) < 1e-6, 'the second restarted effect received only its own session PCM');
    assert.ok(closed.every(id => id === 'session-1' || id === 'session-2'));
    await runtime.stop();
    assert.deepEqual(closed.sort(), ['session-1', 'session-2', 'session-3', 'session-4']);
  } finally {
    await runtime.stop();
    (globalThis as any).AudioWorkletNode = originalNode;
  }
});

test('Mixer worklet sends process blocks on a bound live port instead of the control port', () => {
  const { processor, next } = createWorklet({ profileEnabled: true, requireLivePort: true });
  const livePort = {
    sent: [] as any[],
    closed: false,
    onmessage: null as ((event: { data: any }) => void) | null,
    postMessage(message: any) { this.sent.push(message); },
    close() { this.closed = true; },
  };
  processor.port.onmessage!({ data: { type: 'live-port' }, ports: [livePort] });
  for (let i = 0; i < VST3_FX_BLOCK_FRAMES / 128; i++) next();
  assert.equal(processMessages(processor).length, 0, 'control port must not carry live PCM after bind');
  assert.deepEqual(livePort.sent.map((message: any) => message.type), ['process']);
  assert.equal(livePort.sent[0].sequence, 0);
  const samples = new Float32Array(VST3_FX_BLOCK_FRAMES * 2).fill(0.5);
  livePort.onmessage!({ data: { type: 'result', sequence: 0, samples } });
  assert.ok(profileMessages(processor, 'worklet-result').some((message: any) => message.accepted === true));
  processor.port.onmessage!({ data: { type: 'stop', reason: 'explicit-stop' } });
  assert.equal(livePort.closed, true);
});

test('Mixer worklet fails closed when a live port is required but never bound', () => {
  const { processor, next } = createWorklet({ profileEnabled: true, requireLivePort: true });
  for (let i = 0; i < VST3_FX_BLOCK_FRAMES / 128; i++) next();
  assert.equal(processor.failed, true);
  assert.equal(processMessages(processor).length, 0);
});

test('Mixer runtime binds a dedicated live audio port and ignores renderer control-port PCM', async () => {
  const originalNode = (globalThis as any).AudioWorkletNode;
  const nodes: any[] = [];
  const binds: Array<{ sessionId: string; trackId: number; slotId: string; port: MessagePort }> = [];
  class FakeAudioWorkletNode {
    port = { onmessage: null as ((event: { data: any }) => void) | null, sent: [] as any[], closed: false,
      postMessage: (message: any) => {
        this.port.sent.push(message);
        if (message?.type === 'live-port') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'live-bound' } }));
        if (message?.type === 'stop') queueMicrotask(() => this.port.onmessage?.({ data: {
          type: 'stop-ack', sequence: null, reason: message.reason,
        } }));
      }, close() { this.closed = true; } };
    onprocessorerror: (() => void) | null = null;
    disconnected = false;
    constructor() { nodes.push(this); }
    disconnect() { this.disconnected = true; }
  }
  (globalThis as any).AudioWorkletNode = FakeAudioWorkletNode;
  let processAudioCalls = 0;
  const fatals: string[] = [];
  const bridge: Vst3Bridge = {
    paths: async () => [], choosePath: async () => null,
    discover: async () => ({ plugins: [], errors: [] }), discoverEffects: async () => ({ plugins: [], errors: [] }),
    inspect: async () => { throw new Error('unused'); }, inspectEffect: async () => { throw new Error('unused'); },
    describeEffect: async () => ({ parameters: [], controllerAvailable: false }), describe: async () => ({ parameters: [], controllerAvailable: false }),
    parameters: async () => [], open: async () => ({ id: 'session-live', latencySamples: 0 }),
    process: async () => new Float32Array(),
    processAudio: async () => { processAudioCalls++; return new Float32Array(VST3_FX_BLOCK_FRAMES * 2); },
    close: async () => {},
    bindLiveAudioPort: (sessionId, trackId, slotId) => {
      const { port1 } = new MessageChannel();
      binds.push({ sessionId, trackId, slotId, port: port1 });
      return port1;
    },
    unbindLiveAudioPort: async () => {},
  };
  const context: any = { sampleRate: 48000, currentTime: 0, state: 'running', audioWorklet: { addModule: async () => {} } };
  const runtime = new NativeVst3EffectRuntime((_track, _slot, message) => { fatals.push(message); }, () => bridge);
  try {
    await runtime.prepareTracks([track], context);
    assert.equal(binds.length, 1);
    assert.equal(binds[0].sessionId, 'session-live');
    assert.equal(binds[0].trackId, 1);
    assert.equal(binds[0].slotId, 'fx-test');
    assert.ok(nodes[0].port.sent.some((message: any) => message.type === 'live-port'));
    nodes[0].port.onmessage!({ data: { type: 'process', sequence: 0, samples: new Float32Array(VST3_FX_BLOCK_FRAMES * 2) } });
    await tick();
    assert.equal(processAudioCalls, 0, 'bound live path must not invoke renderer processAudio');
    assert.ok(fatals.some(message => /control port after live audio bind/.test(message)));
  } finally {
    await runtime.stop();
    (globalThis as any).AudioWorkletNode = originalNode;
  }
});

test('Mixer runtime starts native session close before a blocked live-port process is released', async () => {
  const originalNode = (globalThis as any).AudioWorkletNode;
  const nodes: any[] = [];
  class FakeAudioWorkletNode {
    port = { onmessage: null as ((event: { data: any }) => void) | null, sent: [] as any[], closed: false,
      postMessage: (message: any) => {
        this.port.sent.push(message);
        if (message?.type === 'live-port') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'live-bound' } }));
        if (message?.type === 'stop') queueMicrotask(() => this.port.onmessage?.({ data: {
          type: 'stop-ack', sequence: 0, reason: message.reason,
        } }));
      }, close() { this.closed = true; } };
    onprocessorerror: (() => void) | null = null;
    disconnected = false;
    constructor() { nodes.push(this); }
    disconnect() { this.disconnected = true; }
  }
  (globalThis as any).AudioWorkletNode = FakeAudioWorkletNode;
  let releaseProcess: (() => void) | undefined;
  const processGate = new Promise<void>(resolve => { releaseProcess = resolve; });
  const events: string[] = [];
  const liveMessages: any[] = [];
  const closed: string[] = [];
  let live: ReturnType<typeof createLiveAudioPortSession> | undefined;
  let workletEnd: MessagePort | undefined;
  const pcm = () => new Float32Array(VST3_FX_BLOCK_FRAMES * 2).fill(0.25);
  const bridge: Vst3Bridge = {
    paths: async () => [], choosePath: async () => null,
    discover: async () => ({ plugins: [], errors: [] }), discoverEffects: async () => ({ plugins: [], errors: [] }),
    inspect: async () => { throw new Error('unused'); }, inspectEffect: async () => { throw new Error('unused'); },
    describeEffect: async () => ({ parameters: [], controllerAvailable: false }), describe: async () => ({ parameters: [], controllerAvailable: false }),
    parameters: async () => [], open: async () => ({ id: 'session-live', latencySamples: 0 }),
    process: async () => new Float32Array(),
    processAudio: async () => { throw new Error('renderer processAudio must not run after live bind'); },
    close: async id => {
      events.push('close');
      closed.push(id);
      void live?.dispose();
    },
    bindLiveAudioPort: (sessionId, trackId, slotId) => {
      const channel = new MessageChannel();
      live = createLiveAudioPortSession({
        sessionId, owner: 'owner-1', trackId, slotId,
        processAudio: async ({ samples }) => {
          events.push('process-entered');
          await processGate;
          events.push('process-released');
          return samples;
        },
      });
      channel.port1.onmessage = event => liveMessages.push(event.data);
      live.attach(channel.port2);
      workletEnd = channel.port1;
      const handshake = new MessageChannel();
      return handshake.port1;
    },
    unbindLiveAudioPort: async () => {
      events.push('unbind-start');
      live?.stop();
      events.push('unbind-end');
    },
  };
  const context: any = { sampleRate: 48000, currentTime: 0, state: 'running', audioWorklet: { addModule: async () => {} } };
  const runtime = new NativeVst3EffectRuntime(() => {}, () => bridge);
  try {
    await runtime.prepareTracks([track], context);
    workletEnd!.postMessage({ type: 'process', sequence: 0, samples: pcm() });
    await waitFor(() => events.includes('process-entered'));
    const stopping = runtime.stop();
    await waitFor(() => events.includes('close'));
    assert.ok(!events.includes('process-released'), 'native close/abort must start while the live-port process is still blocked');
    assert.deepEqual(events.filter(event => event === 'unbind-start' || event === 'unbind-end' || event === 'close'),
      ['unbind-start', 'unbind-end', 'close']);
    releaseProcess!();
    await stopping;
    await tick(); await tick();
    assert.ok(nodes[0].port.sent.some((message: any) => message.type === 'stop'));
    assert.equal(nodes[0].port.closed, true);
    assert.equal(nodes[0].disconnected, true);
    assert.deepEqual(closed, ['session-live']);
    assert.equal(live?.disposed, true);
    assert.equal(live?.pending, 0);
    assert.ok(liveMessages.some(message => message.type === 'cancelled' && message.sequence === 0));
    assert.equal(liveMessages.some(message => message.type === 'result'), false);
    assert.equal(nodes[0].port.sent.some((message: any) => message.type === 'result'), false,
      'late live-port PCM must not be accepted after stop');
  } finally {
    await runtime.stop();
    (globalThis as any).AudioWorkletNode = originalNode;
  }
});

test('production prepare applies saved parameter overlay before live-port bind without a smoke flag', async () => {
  const originalNode = (globalThis as any).AudioWorkletNode;
  const originalDesktop = (globalThis as any).desktopApp;
  delete (globalThis as any).desktopApp;
  const nodes: any[] = [];
  class FakeAudioWorkletNode {
    port = { onmessage: null as ((event: { data: any }) => void) | null, sent: [] as any[], closed: false,
      postMessage: (message: any) => {
        this.port.sent.push(message);
        if (message?.type === 'live-port') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'live-bound' } }));
        if (message?.type === 'stop') queueMicrotask(() => this.port.onmessage?.({ data: {
          type: 'stop-ack', sequence: null, reason: message.reason,
        } }));
      }, close() { this.closed = true; } };
    onprocessorerror: (() => void) | null = null;
    disconnected = false;
    constructor() { nodes.push(this); }
    disconnect() { this.disconnected = true; }
  }
  (globalThis as any).AudioWorkletNode = FakeAudioWorkletNode;
  const overlay = [{ id: 0, value: 0.8 }, { id: 6, value: 0.5 }];
  const overlayTrack: MixerTrack = { ...track, fxSlots: [{ ...slot, vst3Effect: { ...effect, state: { ...effect.state, parameters: overlay } } }] };
  const order: string[] = [];
  const applied: Vst3ParameterChange[][] = [];
  const binds: string[] = [];
  const closed: string[] = [];
  const bridge: Vst3Bridge = {
    paths: async () => [], choosePath: async () => null,
    discover: async () => ({ plugins: [], errors: [] }), discoverEffects: async () => ({ plugins: [], errors: [] }),
    inspect: async () => { throw new Error('unused'); }, inspectEffect: async () => { throw new Error('unused'); },
    describeEffect: async () => ({ parameters: [], controllerAvailable: false }), describe: async () => ({ parameters: [], controllerAvailable: false }),
    parameters: async (id, changes) => {
      order.push('parameters');
      assert.equal(id, 'session-live');
      applied.push(changes);
      return [];
    },
    open: async () => { order.push('open'); return { id: 'session-live', latencySamples: 0 }; },
    process: async () => new Float32Array(),
    processAudio: async () => { throw new Error('renderer processAudio must not run after live bind'); },
    close: async id => { closed.push(id); },
    bindLiveAudioPort: (sessionId, trackId, slotId) => {
      order.push('bind');
      binds.push(`${sessionId}:${trackId}:${slotId}`);
      const { port1 } = new MessageChannel();
      return port1;
    },
    unbindLiveAudioPort: async () => {},
  };
  const context: any = { sampleRate: 48000, currentTime: 0, state: 'running', audioWorklet: { addModule: async () => {} } };
  const runtime = new NativeVst3EffectRuntime(() => {}, () => bridge);
  try {
    await runtime.prepareTracks([overlayTrack], context);
    assert.deepEqual(order, ['open', 'parameters', 'bind']);
    assert.deepEqual(applied, [overlay]);
    assert.deepEqual(binds, ['session-live:1:fx-test']);
    assert.ok(nodes[0].port.sent.some((message: any) => message.type === 'live-port'));
  } finally {
    await runtime.stop();
    assert.ok(closed.includes('session-live'));
    (globalThis as any).AudioWorkletNode = originalNode;
    if (originalDesktop === undefined) delete (globalThis as any).desktopApp;
    else (globalThis as any).desktopApp = originalDesktop;
  }
});

test('rejected saved-parameter initialization closes the session without binding a live port', async () => {
  const originalNode = (globalThis as any).AudioWorkletNode;
  const originalDesktop = (globalThis as any).desktopApp;
  delete (globalThis as any).desktopApp;
  const nodes: any[] = [];
  class FakeAudioWorkletNode {
    port = { onmessage: null as ((event: { data: any }) => void) | null, sent: [] as any[], closed: false,
      postMessage: (message: any) => {
        this.port.sent.push(message);
        if (message?.type === 'live-port') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'live-bound' } }));
        if (message?.type === 'stop') queueMicrotask(() => this.port.onmessage?.({ data: {
          type: 'stop-ack', sequence: null, reason: message.reason,
        } }));
      }, close() { this.closed = true; } };
    onprocessorerror: (() => void) | null = null;
    disconnected = false;
    constructor() { nodes.push(this); }
    disconnect() { this.disconnected = true; }
  }
  (globalThis as any).AudioWorkletNode = FakeAudioWorkletNode;
  const overlayTrack: MixerTrack = { ...track, fxSlots: [{ ...slot, vst3Effect: { ...effect, state: { ...effect.state, parameters: [{ id: 0, value: 0.8 }] } } }] };
  const binds: string[] = [];
  const closed: string[] = [];
  const bridge: Vst3Bridge = {
    paths: async () => [], choosePath: async () => null,
    discover: async () => ({ plugins: [], errors: [] }), discoverEffects: async () => ({ plugins: [], errors: [] }),
    inspect: async () => { throw new Error('unused'); }, inspectEffect: async () => { throw new Error('unused'); },
    describeEffect: async () => ({ parameters: [], controllerAvailable: false }), describe: async () => ({ parameters: [], controllerAvailable: false }),
    parameters: async () => { throw new Error('Controller rejected parameter'); },
    open: async () => ({ id: 'session-reject', latencySamples: 0 }),
    process: async () => new Float32Array(),
    processAudio: async () => { throw new Error('must not process after rejected initialization'); },
    close: async id => { closed.push(id); },
    bindLiveAudioPort: (sessionId) => {
      binds.push(sessionId);
      const { port1 } = new MessageChannel();
      return port1;
    },
    unbindLiveAudioPort: async () => { throw new Error('unbind must not run when bind never started'); },
  };
  const context: any = { sampleRate: 48000, currentTime: 0, state: 'running', audioWorklet: { addModule: async () => {} } };
  const runtime = new NativeVst3EffectRuntime(() => {}, () => bridge);
  try {
    await assert.rejects(runtime.prepareTracks([overlayTrack], context), /Controller rejected parameter/);
    assert.deepEqual(binds, []);
    assert.ok(closed.includes('session-reject'));
    assert.equal(runtime.isPrepared(1, slot.id, context, overlayTrack.fxSlots[0]!.vst3Effect), false);
    assert.ok(nodes[0].port.closed);
    assert.equal(nodes[0].disconnected, true);
    assert.equal(nodes[0].port.sent.some((message: any) => message.type === 'live-port'), false);
  } finally {
    await runtime.stop();
    (globalThis as any).AudioWorkletNode = originalNode;
    if (originalDesktop === undefined) delete (globalThis as any).desktopApp;
    else (globalThis as any).desktopApp = originalDesktop;
  }
});
