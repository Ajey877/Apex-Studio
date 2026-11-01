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

test('two VST3 inserts in one Mixer chain process cascaded stereo PCM in exact slot order without cross-instance contamination or lost blocks', async () => {
  const { MessageChannel } = await import('node:worker_threads');
  const { createLiveAudioPortSession } = await import('../../native/vst3/liveAudioPort.mjs');

  function createLiveBoundWorklet() {
    const sandbox: any = {
      currentFrame: 0, Float32Array, Map, Number, Array, Math, String,
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
    const processor = new sandbox.Processor({ processorOptions: { profileEnabled: true, requireLivePort: true } });
    return { processor, sandbox };
  }

  const stage1 = createLiveBoundWorklet();
  const stage2 = createLiveBoundWorklet();
  const ch1 = new MessageChannel();
  const ch2 = new MessageChannel();

  // Adapt worker_threads MessagePort for worklet sandbox (onmessage property)
  // and enforce Electron/Chromium's cross-process MessagePortMain contract:
  // ArrayBuffer transfer lists across OS processes are forbidden.
  const wrapWorkletSidePort = (port: any) => {
    const wrapper: any = {
      onmessage: null as ((event: { data: any }) => void) | null,
      postMessage: (msg: any, transfer?: any[]) => {
        assert.equal(transfer, undefined, 'cross-process livePort.postMessage must not pass an ArrayBuffer transfer list');
        port.postMessage(msg);
      },
      close: () => port.close(),
    };
    port.on('message', (data: any) => wrapper.onmessage?.({ data }));
    port.start();
    return wrapper;
  };

  const stage1Inputs: Float32Array[] = [];
  const stage2Inputs: Float32Array[] = [];
  const processAudio = async ({ sessionId, samples }: { sessionId: string; samples: Float32Array }) => {
    const frames = VST3_FX_BLOCK_FRAMES;
    const out = new Float32Array(samples.length);
    if (sessionId === 'insert-1') {
      stage1Inputs.push(samples.slice());
      for (let i = 0; i < frames; i++) {
        out[i] = samples[i]! * 2;
        out[frames + i] = samples[frames + i]! * 0.5;
      }
    } else {
      stage2Inputs.push(samples.slice());
      for (let i = 0; i < frames; i++) {
        out[i] = samples[i]! + 0.1;
        out[frames + i] = samples[frames + i]! - 0.05;
      }
    }
    return out;
  };

  const live1 = createLiveAudioPortSession({
    sessionId: 'insert-1', owner: 'owner-1', trackId: 1, slotId: 'slot-1', processAudio,
  });
  const live2 = createLiveAudioPortSession({
    sessionId: 'insert-2', owner: 'owner-1', trackId: 1, slotId: 'slot-2', processAudio,
  });
  stage1.processor.port.onmessage!({ data: { type: 'live-port' }, ports: [wrapWorkletSidePort(ch1.port2)] });
  stage2.processor.port.onmessage!({ data: { type: 'live-port' }, ports: [wrapWorkletSidePort(ch2.port2)] });
  live1.attach(ch1.port1);
  live2.attach(ch2.port1);
  await new Promise(resolve => setTimeout(resolve, 10));

  try {
    const capturedCascadedLeft: number[] = [];
    const capturedCascadedRight: number[] = [];
    // Run 8 blocks (8192 frames = 64 render quanta of 128 frames)
    for (let q = 0; q < 64; q++) {
      const frame = q * 128;
      stage1.sandbox.currentFrame = frame;
      stage2.sandbox.currentFrame = frame;
      const inL = new Float32Array(128).fill(0.2);
      const inR = new Float32Array(128).fill(-0.4);
      const mid = [new Float32Array(128), new Float32Array(128)];
      const finalOut = [new Float32Array(128), new Float32Array(128)];
      stage1.processor.process([[inL, inR]], [mid]);
      stage2.processor.process([[mid[0], mid[1]]], [finalOut]);
      for (let i = 0; i < 128; i++) {
        capturedCascadedLeft.push(finalOut[0]![i]!);
        capturedCascadedRight.push(finalOut[1]![i]!);
      }
      if ((q + 1) % 8 === 0) await new Promise(resolve => setTimeout(resolve, 10));
    }

    assert.equal(stage1.processor.failed, false);
    assert.equal(stage2.processor.failed, false);
    assert.equal(stage1Inputs.length, 8);
    assert.equal(stage2Inputs.length, 8);
    // Stage 1 receives dry input (0.2, -0.4) from block 0
    assert.ok(Math.abs(stage1Inputs[0]![0]! - 0.2) < 1e-6);
    assert.ok(Math.abs(stage1Inputs[0]![VST3_FX_BLOCK_FRAMES]! - -0.4) < 1e-6);
    // Stage 2 receives 2 blocks of pipeline delay (0, 0), then Stage 1's processed output (0.4, -0.2)
    assert.equal(stage2Inputs[0]![0], 0);
    assert.equal(stage2Inputs[1]![0], 0);
    assert.ok(Math.abs(stage2Inputs[2]![0]! - 0.4) < 1e-6);
    assert.ok(Math.abs(stage2Inputs[2]![VST3_FX_BLOCK_FRAMES]! - -0.2) < 1e-6);
    // Cascaded output after 2 * 2048 = 4096 frames equals Stage 2(Stage 1(dry)) = (0.5, -0.25)
    for (let f = VST3_FX_PIPELINE_FRAMES * 2; f < capturedCascadedLeft.length; f++) {
      assert.ok(Math.abs(capturedCascadedLeft[f]! - 0.5) < 1e-6, `left sample at frame ${f}`);
      assert.ok(Math.abs(capturedCascadedRight[f]! - -0.25) < 1e-6, `right sample at frame ${f}`);
    }
  } finally {
    await live1.dispose();
    await live2.dispose();
    ch1.port2.close();
    ch2.port2.close();
  }
});

test('prepareTracks flushes saved parameter overlays before live-port bind and cancels cleanly on concurrent stop/replacement without leaking sessions', async () => {
  const originalNode = (globalThis as any).AudioWorkletNode;
  class FakeLiveWorkletNode {
    port = {
      onmessage: null as ((event: { data: any }) => void) | null,
      postMessage: (message: any) => {
        if (message?.type === 'live-port') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'live-bound' } }));
        if (message?.type === 'stop') queueMicrotask(() => this.port.onmessage?.({ data: { type: 'stop-ack', sequence: null, reason: message.reason } }));
      },
      close() {},
    };
    onprocessorerror: (() => void) | null = null;
    disconnect() {}
  }
  (globalThis as any).AudioWorkletNode = FakeLiveWorkletNode;

  const events: string[] = [];
  const openSessions = new Set<string>();
  let seq = 0;
  const holdOpens: Array<() => void> = [];
  let blockNextOpen = false;
  const flushHoldOpens = () => { while (holdOpens.length) holdOpens.shift()!(); };

  const effectA: Vst3Effect = {
    ...effect, classId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    state: { schema: 1, classId: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', parameters: [{ id: 0, value: 0.8 }, { id: 9, value: 1 }] },
  };
  const effectB: Vst3Effect = {
    ...effect, classId: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    state: { schema: 1, classId: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', parameters: [{ id: 4, value: 0.25 }] },
  };
  const twoInsertTrack: MixerTrack = {
    ...track,
    fxSlots: [
      { ...slot, id: 'slot-1', vst3Effect: effectA },
      { ...slot, id: 'slot-2', vst3Effect: effectB },
    ],
  };

  const bridge: Vst3Bridge = {
    paths: async () => [], choosePath: async () => null,
    discover: async () => ({ plugins: [], errors: [] }), discoverEffects: async () => ({ plugins: [], errors: [] }),
    inspect: async () => { throw new Error('unused'); }, inspectEffect: async () => { throw new Error('unused'); },
    describeEffect: async () => ({ parameters: [], controllerAvailable: false }), describe: async () => ({ parameters: [], controllerAvailable: false }),
    open: async () => {
      const id = `live-${++seq}`;
      openSessions.add(id);
      events.push(`open:${id}`);
      if (blockNextOpen) await new Promise<void>(resolve => { holdOpens.push(resolve); });
      return { id, latencySamples: 0 };
    },
    parameters: async (id, changes) => {
      events.push(`params:${id}:${changes.map(c => `${c.id}=${c.value}`).join(',')}`);
      return [];
    },
    bindLiveAudioPort: async id => {
      events.push(`bind:${id}`);
      return { postMessage() {}, close() {} } as any;
    },
    unbindLiveAudioPort: async id => { events.push(`unbind:${id}`); },
    process: async () => new Float32Array(),
    processAudio: async () => new Float32Array(VST3_FX_BLOCK_FRAMES * 2),
    close: async id => { openSessions.delete(id); events.push(`close:${id}`); },
  };

  const context: any = { sampleRate: 48000, currentTime: 0, state: 'running', audioWorklet: { addModule: async () => {} } };
  const runtime = new NativeVst3EffectRuntime(() => {}, () => bridge);
  try {
    await runtime.prepareTracks([twoInsertTrack], context);
    assert.equal(openSessions.size, 2);
    // For each session, parameters must flush before bindLiveAudioPort
    for (const id of ['live-1', 'live-2']) {
      const openIdx = events.indexOf(`open:${id}`);
      const paramIdx = events.findIndex(e => e.startsWith(`params:${id}:`));
      const bindIdx = events.indexOf(`bind:${id}`);
      assert.ok(openIdx >= 0 && paramIdx > openIdx && bindIdx > paramIdx, `expected open -> params -> bind for ${id}, got ${events.join(' -> ')}`);
    }
    await runtime.stop();
    assert.equal(openSessions.size, 0);
    for (const id of ['live-1', 'live-2']) {
      assert.ok(events.indexOf(`unbind:${id}`) < events.indexOf(`close:${id}`), `unbind precedes close for ${id}`);
    }

    // Concurrent stop() during in-flight prepareTracks must close newly opened sessions without leaking
    blockNextOpen = true;
    const pendingPrepare = runtime.prepareTracks([twoInsertTrack], context);
    await tick(); await tick();
    const stopPromise = runtime.stop();
    flushHoldOpens();
    await assert.rejects(pendingPrepare, /cancelled/i);
    await stopPromise;
    assert.equal(openSessions.size, 0, 'no leaked native helper sessions after concurrent stop during prepare');
  } finally {
    blockNextOpen = false;
    flushHoldOpens();
    await runtime.stop();
    (globalThis as any).AudioWorkletNode = originalNode;
  }
});

