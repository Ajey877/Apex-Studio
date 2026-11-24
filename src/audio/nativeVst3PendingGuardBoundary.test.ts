/**
 * Deterministic reproduction of the native pending-deadline guard's frame
 * boundary, driven against the REAL shipped worklet source.
 *
 * Why the real source and not a copy: this investigation turns on exactly one
 * sample of frame arithmetic, and a re-implementation could drift from the shipped
 * loop and prove the wrong thing. `VST3_FX_WORKLET_SOURCE` is evaluated in a
 * sandbox with the four globals the AudioWorklet scope provides -
 * `AudioWorkletProcessor`, `registerProcessor`, `currentFrame` and `Date` - so the
 * class under test is the one that ships.
 *
 * What it establishes:
 *   - the exact frames the pending guard reports, and what each one means;
 *   - that the guard fires exactly one output frame before the pending block's due
 *     frame, because the pipeline delay is exactly two blocks;
 *   - that a result delivered after the guard fired but before the next quantum is
 *     rejected, even though the block was not needed until that next quantum;
 *   - how that compares with the output-side guard, which is evaluated at the exact
 *     output sample that needs the block.
 *
 * Event ordering here is established by CALL ORDER, not by timestamps: every step
 * is a synchronous call the test makes in a known sequence, so nothing is inferred
 * from a wall clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { VST3_FX_WORKLET_SOURCE, VST3_FX_BLOCK_FRAMES, VST3_FX_PIPELINE_FRAMES } from './nativeVst3EffectRuntime';

/** Chromium's fixed AudioWorklet render quantum. */
const QUANTUM_FRAMES = 128;

interface PostedEvent {
  type?: string;
  event?: string;
  reason?: string;
  [key: string]: unknown;
}

interface Harness {
  /** Render one quantum. Returns the output frame it started at. */
  quantum(): number;
  /** Deliver a result exactly as the live port delivers one. */
  deliver(sequence: number, fill?: number): void;
  /** Every message the worklet has posted, in order. */
  events: PostedEvent[];
  /** The live processor instance, for constructed-state tests. */
  processor: any;
  /** The last quantum's rendered output, channel 0. */
  lastOutput: Float32Array | null;
}

/**
 * Loads the shipped worklet source into a sandbox and returns a driver for it.
 * The sandbox gets its own intrinsics, so samples must be minted inside it for the
 * worklet's `instanceof Float32Array` check to pass.
 */
function loadShippedWorklet(): Harness {
  const context: any = { Date, console };
  vm.createContext(context);
  vm.runInContext(`
    globalThis.__sent = [];
    globalThis.__controlPort = {
      onmessage: null,
      postMessage: function (message) { globalThis.__sent.push(message); },
    };
    globalThis.__livePort = {
      onmessage: null,
      postMessage: function () {},
      close: function () {},
    };
    globalThis.AudioWorkletProcessor = class AudioWorkletProcessor {
      constructor() { this.port = globalThis.__controlPort; }
    };
    globalThis.registerProcessor = function (name, ctor) { globalThis.__Processor = ctor; };
    globalThis.currentFrame = 0;
    globalThis.__make = function (n) { return new Float32Array(n); };
  `, context);
  vm.runInContext(VST3_FX_WORKLET_SOURCE, context);

  const Processor = context.__Processor;
  assert.ok(Processor, 'the shipped source must register a processor');
  const processor = new Processor({ processorOptions: { profileEnabled: true } });
  // Bind the live port the way the runtime does, so results travel the same path.
  context.__controlPort.onmessage({ data: { type: 'live-port' }, ports: [context.__livePort] });

  const events: PostedEvent[] = [];
  const drain = () => {
    while (context.__sent.length > 0) {
      const message = context.__sent.shift();
      if (message.type === 'profile') events.push(message);
      else if (message.type === 'failure') events.push({ type: 'failure', reason: message.reason });
      else if (message.type === 'process') events.push({ type: 'process', sequence: message.sequence });
    }
  };
  drain();

  let contextFrame = 0;
  let outputFrame = 0;
  const harness: Harness = {
    events,
    processor,
    lastOutput: null,
    quantum() {
      const startedAt = outputFrame;
      context.currentFrame = contextFrame;
      const left = context.__make(QUANTUM_FRAMES);
      const right = context.__make(QUANTUM_FRAMES);
      for (let i = 0; i < QUANTUM_FRAMES; i++) { left[i] = 0.1; right[i] = 0.1; }
      const out = [context.__make(QUANTUM_FRAMES), context.__make(QUANTUM_FRAMES)];
      processor.process([[left, right]], [out]);
      drain();
      // Mirror the harness's own Float32Array out of the sandbox for assertions.
      harness.lastOutput = new Float32Array(out[0]);
      contextFrame += QUANTUM_FRAMES;
      outputFrame += QUANTUM_FRAMES;
      return startedAt;
    },
    deliver(sequence, fill = 0.5) {
      const samples = context.__make(VST3_FX_BLOCK_FRAMES * 2);
      samples.fill(fill);
      context.__livePort.onmessage({ data: { type: 'result', sequence, samples } });
      drain();
    },
  };
  return harness;
}

const only = (h: Harness, event: string): PostedEvent => {
  const found = h.events.filter(entry => entry.event === event);
  assert.equal(found.length, 1, `expected exactly one ${event}, got ${found.length}`);
  return found[0];
};

/** The worklet-result event for one sequence. */
const resultFor = (h: Harness, sequence: number): PostedEvent => {
  const found = h.events.filter(entry => entry.event === 'worklet-result' && entry.sequence === sequence);
  assert.equal(found.length, 1, `expected exactly one worklet-result for ${sequence}, got ${found.length}`);
  return found[0];
};

/**
 * Copies an array out of the sandbox realm. Arrays the worklet builds have the
 * sandbox's Array prototype, so a strict deepEqual against a host array fails on
 * identity even when the contents are identical.
 */
const hostArray = (value: unknown): number[] => [...(value as number[])];

const failed = (h: Harness): boolean => h.events.some(entry => entry.type === 'failure');

/**
 * Drives until `sequence` has been submitted, answering every earlier block so the
 * run reaches the block under test in a clean state.
 */
function driveUntilSubmitted(h: Harness, sequence: number): void {
  for (let guard = 0; guard < 80; guard++) {
    h.quantum();
    const pendingSubmit = h.events.find(entry => entry.event === 'worklet-submit'
      && entry.sequence === sequence);
    if (pendingSubmit) return;
    // Answer the previous block so it is not the one that trips the guard.
    const previous = h.events.find(entry => entry.event === 'worklet-submit'
      && entry.sequence === sequence - 1
      && !h.events.some(r => r.event === 'worklet-result' && r.sequence === sequence - 1));
    if (previous) h.deliver(sequence - 1);
  }
  throw new Error(`sequence ${sequence} was never submitted`);
}

test('the shipped worklet reports the pending guard one output frame before the due frame', () => {
  const h = loadShippedWorklet();
  driveUntilSubmitted(h, 1);
  // Sequence 1 is now outstanding. Withhold it and let the next block fill.
  for (let guard = 0; guard < 20 && !failed(h); guard++) h.quantum();

  const miss = only(h, 'pending-deadline-miss');
  assert.equal(miss.pendingSequence, 1);
  assert.equal(miss.sequence, 1);
  assert.equal(miss.nextSequence, 2);

  // The quantum the guard was evaluated inside.
  assert.equal(miss.outputFrameAtQuantumStart, 2944);
  assert.equal(miss.inputQuantumFrames, QUANTUM_FRAMES);
  // The 1024-frame block fills on the LAST sample of the quantum, which is the
  // whole reason the quantum-start frame and the evaluation frame differ.
  assert.equal(miss.inputSampleIndex, QUANTUM_FRAMES - 1);
  assert.equal(miss.currentOutputFrame, 3071,
    'currentOutputFrame is the frame being evaluated, not the quantum start');
  assert.equal(miss.nextQuantumOutputFrame, 3072);
  assert.equal(miss.dueOutputFrame, 3072);

  // The invariant this investigation is about.
  assert.equal(miss.currentOutputFrame, (miss.dueOutputFrame as number) - 1,
    'the pending guard fires exactly one output frame before the block is due');
  assert.equal(miss.nextQuantumOutputFrame, miss.dueOutputFrame,
    'the pending block is first needed at the first sample of the NEXT quantum');
  assert.deepEqual(hostArray(miss.readySequences), [0]);
  assert.deepEqual(hostArray(miss.drySequences), [0, 1]);
});

test('one frame early is arithmetic, not luck: the delay is exactly two blocks', () => {
  // due(s) = delay + s*block. The guard for a pending block s fires when block s+1
  // fills, at output frame (s+2)*block - 1. The gap is therefore delay - 2*block + 1
  // frames, which is exactly 1 when the pipeline delay is two blocks.
  const gap = VST3_FX_PIPELINE_FRAMES - 2 * VST3_FX_BLOCK_FRAMES + 1;
  assert.equal(gap, 1);
  assert.equal(VST3_FX_BLOCK_FRAMES % QUANTUM_FRAMES, 0,
    'the block is a whole number of quanta, so the fill always lands on the last sample');
});

test('a result delivered between quanta is rejected although the block was not needed yet', () => {
  const h = loadShippedWorklet();
  driveUntilSubmitted(h, 1);
  // Step 1-2: the block is pending and the current quantum completes.
  for (let guard = 0; guard < 20 && !failed(h); guard++) h.quantum();
  const miss = only(h, 'pending-deadline-miss');
  // Step 3-4: the guard has been evaluated and process() has returned.
  assert.equal(failed(h), true, 'the guard failed the processor inside that quantum');

  // The quantum that just ran rendered output frames 2944..3071. Every one of those
  // needs source frames 896..1023, i.e. block 0 - which had already arrived. Not
  // one rendered frame needed block 1.
  const renderedStart = miss.outputFrameAtQuantumStart as number;
  const renderedEnd = (miss.nextQuantumOutputFrame as number) - 1;
  for (let frame = renderedStart; frame <= renderedEnd; frame++) {
    const sourceFrame = frame - VST3_FX_PIPELINE_FRAMES;
    assert.equal(Math.floor(sourceFrame / VST3_FX_BLOCK_FRAMES), 0,
      `frame ${frame} needs block 0, so block 1 was not required yet`);
  }

  // Step 5: the result arrives before the next quantum.
  h.deliver(1);
  const result = resultFor(h, 1);
  assert.equal(result.sequence, 1);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'after-failure',
    'rejected only because failure had already latched');
  assert.equal(result.receivedOutputFrame, 3072);
  assert.equal(result.dueOutputFrame, 3072,
    'it arrived at exactly the frame the block was due');

  // Step 6: the next quantum would have started at the due frame, with the samples
  // now available. That is the frame the block was needed at, and it never ran.
  assert.equal(miss.nextQuantumOutputFrame, result.receivedOutputFrame);
});

test('a result delivered before the due frame is accepted and its samples are used', () => {
  const h = loadShippedWorklet();
  driveUntilSubmitted(h, 1);
  h.deliver(1, 0.5);
  const result = resultFor(h, 1);
  assert.equal(result.accepted, true);
  assert.equal(result.reason, null);

  // Render through the frames that need block 1 and check its samples come out.
  for (let guard = 0; guard < 12; guard++) {
    const startedAt = h.quantum();
    if (failed(h)) break;
    if (startedAt === 3072) {
      assert.equal(h.lastOutput?.[0], 0.5,
        'the accepted block supplies the output at its due frame');
    }
  }
  assert.equal(failed(h), false, 'an on-time result must not trip either guard');
  assert.equal(h.events.some(entry => entry.event === 'pending-deadline-miss'), false);
  assert.equal(h.events.some(entry => entry.event === 'deadline-miss'), false);
});

test('the pending guard always preempts the output-side guard by one frame', () => {
  // Withhold a result for a long run: if the output-side guard could ever win, it
  // would fire at the exact due frame. It never does.
  const h = loadShippedWorklet();
  driveUntilSubmitted(h, 1);
  for (let guard = 0; guard < 40 && !failed(h); guard++) h.quantum();
  assert.equal(h.events.filter(entry => entry.event === 'pending-deadline-miss').length, 1);
  assert.equal(h.events.some(entry => entry.event === 'deadline-miss'), false,
    'the output-side guard never gets the chance: the pending guard fires first');
});

test('the output-side guard fires at the exact sample that needs the block', () => {
  const h = loadShippedWorklet();
  driveUntilSubmitted(h, 1);
  h.deliver(1, 0.5);
  // Render up to the quantum that starts at the due frame, then construct the state
  // the output-side guard exists for: the block is not in `ready` when its first
  // sample is about to be rendered. This is a constructed state, labelled as such -
  // the point is to read the guard's own frame reporting, not to claim it occurs.
  for (let guard = 0; guard < 12; guard++) {
    if (h.quantum() >= 2944) break;
  }
  h.processor.ready.delete(1);
  h.quantum();

  const miss = only(h, 'deadline-miss');
  assert.equal(miss.sequence, 1);
  assert.equal(miss.currentOutputFrame, 3072);
  assert.equal(miss.dueOutputFrame, 3072);
  assert.equal(miss.outputFrameAtQuantumStart, 3072);
  assert.equal(miss.outputSampleIndex, 0,
    'evaluated on the very first sample that needs the block');
  assert.equal(miss.outputQuantumFrames, QUANTUM_FRAMES);
  assert.equal(miss.currentOutputFrame, miss.dueOutputFrame,
    'the output-side guard fires AT the due frame, never before it');
});

test('both guards report the same frame vocabulary so they can be compared', () => {
  const pending = loadShippedWorklet();
  driveUntilSubmitted(pending, 1);
  for (let guard = 0; guard < 20 && !failed(pending); guard++) pending.quantum();
  const pendingMiss = only(pending, 'pending-deadline-miss');

  const output = loadShippedWorklet();
  driveUntilSubmitted(output, 1);
  output.deliver(1, 0.5);
  for (let guard = 0; guard < 12; guard++) {
    if (output.quantum() >= 2944) break;
  }
  output.processor.ready.delete(1);
  output.quantum();
  const outputMiss = only(output, 'deadline-miss');

  for (const field of ['outputFrameAtQuantumStart', 'currentOutputFrame',
    'dueOutputFrame', 'nextQuantumOutputFrame', 'pendingSequence']) {
    assert.ok(field in pendingMiss, `pending guard must report ${field}`);
    assert.ok(field in outputMiss, `output guard must report ${field}`);
  }
  // The distinction, in one comparison: same due frame, different evaluation frame.
  assert.equal(pendingMiss.dueOutputFrame, outputMiss.dueOutputFrame);
  assert.equal((outputMiss.currentOutputFrame as number) - (pendingMiss.currentOutputFrame as number), 1,
    'the pending guard evaluates one frame earlier than the output guard');
});
