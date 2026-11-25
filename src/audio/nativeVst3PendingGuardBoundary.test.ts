/**
 * Deterministic boundary tests for the native VST3 pending-deadline guard, driven
 * against the REAL shipped worklet source.
 *
 * Why the real source and not a copy: this turns on exactly one sample of frame
 * arithmetic, and a re-implementation could drift from the shipped loop and prove
 * the wrong thing. `VST3_FX_WORKLET_SOURCE` is evaluated in a sandbox with the four
 * globals the AudioWorklet scope provides - `AudioWorkletProcessor`,
 * `registerProcessor`, `currentFrame` and `Date` - so the class under test is the
 * one that ships.
 *
 * Message semantics: on the audio thread, control-port messages are delivered
 * between rendering quanta, never during a `process()` call. This harness models
 * that exactly - `deliver()` is only ever called between `quantum()` calls - so
 * nothing here depends on an interleaving the real runtime cannot produce, and no
 * ordering is inferred from a wall clock. Every step is a synchronous call made in
 * a known sequence.
 *
 * Frame vocabulary, for reading the assertions:
 *   delayFrames = 2048 (two blocks), blockFrames = 1024, render quantum = 128.
 *   Block s is submitted when input frame (s+1)*1024 has been consumed, which is
 *   output frame (s+1)*1024 - 1, and is first needed at output frame
 *   due(s) = 2048 + s*1024. Because 1024 is a whole number of quanta, a block
 *   always fills on a quantum's LAST sample, and every due frame is a quantum
 *   boundary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { VST3_FX_WORKLET_SOURCE, VST3_FX_BLOCK_FRAMES, VST3_FX_PIPELINE_FRAMES } from './nativeVst3EffectRuntime';

/** Chromium's fixed AudioWorklet render quantum. */
const QUANTUM_FRAMES = 128;
/** Input level fed to every quantum; distinct from anything the helper returns. */
const DRY_LEVEL = 0.1;

interface PostedEvent {
  type?: string;
  event?: string;
  reason?: string;
  [key: string]: unknown;
}

interface Harness {
  /** Render one quantum. Returns the output frame it started at and its output. */
  quantum(): { start: number; output: Float32Array };
  /** Deliver a result exactly as the live port delivers one. Between quanta only. */
  deliver(sequence: number, fill?: number): void;
  /** Every message the worklet has posted, in order. */
  events: PostedEvent[];
  /** The live processor instance, for constructed-state tests. */
  processor: any;
  /** Output frame the next quantum will start at. */
  readonly outputFrame: number;
}

/**
 * Loads the shipped worklet source into a sandbox and returns a driver for it. The
 * sandbox gets its own intrinsics, so samples must be minted inside it for the
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
    get outputFrame() { return outputFrame; },
    quantum() {
      const start = outputFrame;
      context.currentFrame = contextFrame;
      const left = context.__make(QUANTUM_FRAMES);
      const right = context.__make(QUANTUM_FRAMES);
      left.fill(DRY_LEVEL);
      right.fill(DRY_LEVEL);
      const out = [context.__make(QUANTUM_FRAMES), context.__make(QUANTUM_FRAMES)];
      processor.process([[left, right]], [out]);
      drain();
      // Copy out of the sandbox realm for assertions.
      const rendered = new Float32Array(out[0]);
      contextFrame += QUANTUM_FRAMES;
      outputFrame += QUANTUM_FRAMES;
      return { start, output: rendered };
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

const failed = (h: Harness): boolean => h.events.some(entry => entry.type === 'failure');
const all = (h: Harness, event: string): PostedEvent[] => h.events.filter(entry => entry.event === event);
const only = (h: Harness, event: string): PostedEvent => {
  const found = all(h, event);
  assert.equal(found.length, 1, `expected exactly one ${event}, got ${found.length}`);
  return found[0];
};
const resultFor = (h: Harness, sequence: number): PostedEvent => {
  const found = all(h, 'worklet-result').filter(entry => entry.sequence === sequence);
  assert.equal(found.length, 1, `expected exactly one worklet-result for ${sequence}, got ${found.length}`);
  return found[0];
};
/** Arrays built inside the sandbox have its Array prototype; copy before deepEqual. */
const hostArray = (value: unknown): number[] => [...(value as number[])];

/**
 * Renders until block `sequence` has been submitted, answering every earlier block
 * so the run reaches the block under test in a clean state.
 */
function driveUntilSubmitted(h: Harness, sequence: number): void {
  for (let guard = 0; guard < 80; guard++) {
    h.quantum();
    const submitted = all(h, 'worklet-submit').some(entry => entry.sequence === sequence);
    if (submitted) return;
    const previousOutstanding = all(h, 'worklet-submit').some(entry => entry.sequence === sequence - 1)
      && !all(h, 'worklet-result').some(entry => entry.sequence === sequence - 1);
    if (previousOutstanding) h.deliver(sequence - 1, 0.25);
  }
  throw new Error(`sequence ${sequence} was never submitted`);
}

/**
 * Renders until the quantum that ends at `targetOutputFrame` has completed, leaving
 * block `pending` outstanding the whole way. Fails the test if a guard trips early.
 */
function driveToFrameWithPending(h: Harness, targetOutputFrame: number): void {
  for (let guard = 0; guard < 80; guard++) {
    if (h.outputFrame >= targetOutputFrame) return;
    h.quantum();
    assert.equal(failed(h), false,
      `the processor must survive to output frame ${targetOutputFrame} with a block still pending`);
  }
  throw new Error(`never reached output frame ${targetOutputFrame}`);
}

// --- 1. a result delivered before its due frame is accepted ----------------------

test('1. a result delivered before its due frame is accepted and its samples are used', () => {
  const h = loadShippedWorklet();
  driveUntilSubmitted(h, 1);
  assert.equal(h.outputFrame < 3072, true, 'block 1 is submitted well before it is due');

  h.deliver(1, 0.5);
  const result = resultFor(h, 1);
  assert.equal(result.sequence, 1, 'the accepted result is the block that was pending');
  assert.equal(result.accepted, true);
  assert.equal(result.reason, null);
  assert.equal(result.dueOutputFrame, 3072);
  assert.ok((result.receivedOutputFrame as number) < (result.dueOutputFrame as number),
    'it arrived before the frame that needs it');

  // Render through the frames that need block 1 and check its samples come out.
  let renderedDueFrame = false;
  for (let guard = 0; guard < 12 && !failed(h); guard++) {
    const { start, output } = h.quantum();
    if (start === 3072) {
      assert.equal(output[0], 0.5, 'the accepted block supplies the output at its due frame');
      renderedDueFrame = true;
    }
  }
  assert.equal(renderedDueFrame, true);
  assert.equal(failed(h), false, 'an on-time result must not trip either guard');
  assert.equal(all(h, 'pending-deadline-miss').length, 0);
  assert.equal(all(h, 'deadline-miss').length, 0);
});

// --- 2. THE CORRECTION: delivered between callbacks, at the due frame ------------

test('2. a result delivered between process callbacks is accepted at the due frame', () => {
  const h = loadShippedWorklet();
  driveUntilSubmitted(h, 1);

  // Block 1 is outstanding. Render the quantum that ends at its due frame. The old
  // guard failed inside that quantum, on its last sample, at output frame 3071 -
  // one frame before the block was needed.
  driveToFrameWithPending(h, 3072);
  assert.equal(h.outputFrame, 3072);
  assert.equal(all(h, 'pending-deadline-miss').length, 0,
    'the guard must not fire while the pending block is still inside its deadline');

  // process() has returned and the next callback has not started. This is the only
  // point at which the audio thread can deliver a message, and the block is needed
  // at the very first sample of the next callback.
  h.deliver(1, 0.75);
  const result = resultFor(h, 1);
  assert.equal(result.sequence, 1);
  assert.equal(result.accepted, true, 'the result is in time and must be taken');
  assert.equal(result.reason, null);
  assert.equal(result.receivedOutputFrame, 3072);
  assert.equal(result.dueOutputFrame, 3072,
    'it arrived at exactly the frame the block was due - the case the old guard refused');

  // The next callback starts at the due frame and must render the accepted block.
  const { start, output } = h.quantum();
  assert.equal(start, 3072);
  assert.equal(output[0], 0.75, 'the block that was pending supplies the due frame');
  assert.equal(failed(h), false);
  assert.equal(all(h, 'pending-deadline-miss').length, 0);
  assert.equal(all(h, 'deadline-miss').length, 0);
});

test('2b. the deferred hand-off keeps the block sequence and timing exact', () => {
  // The correction lets a completed block wait one sample for its predecessor. That
  // must not reorder, duplicate or renumber anything, and the ordinary path must
  // still hand off on the filling sample so the recorded frames do not move.
  const h = loadShippedWorklet();
  driveUntilSubmitted(h, 1);
  driveToFrameWithPending(h, 3072);

  // Block 2 is complete and waiting: it must not have been submitted yet, because
  // doing so would overwrite the pending request for block 1.
  assert.equal(all(h, 'worklet-submit').some(entry => entry.sequence === 2), false,
    'a completed block must never be handed off over an outstanding request');
  assert.equal(h.processor.pending, 1, 'the pending request is still block 1');
  assert.equal(h.processor.sequence, 2, 'and the sequence counter has not advanced');

  h.deliver(1, 0.75);
  const { start } = h.quantum();
  assert.equal(start, 3072);

  // Now block 2 goes out, once, with the right identity.
  const submits = all(h, 'worklet-submit');
  assert.deepEqual(hostArray(submits.map(entry => entry.sequence as number)), [0, 1, 2],
    'exactly one hand-off per block, in order');
  const deferred = submits[2];
  assert.equal(deferred.sequence, 2);
  assert.equal(deferred.dueOutputFrame, 4096);
  assert.equal(h.processor.pending, 2);

  // Blocks 0 and 1 took the ordinary path, so their frames are unchanged by this
  // correction: submitted on the filling sample, one block before they are due.
  assert.equal(submits[0].submittedOutputFrame, 1024);
  assert.equal(submits[0].dueOutputFrame, 2048);
  assert.equal(submits[1].submittedOutputFrame, 2048);
  assert.equal(submits[1].dueOutputFrame, 3072);
});

// --- 3. a genuinely late result is rejected --------------------------------------

test('3. a result that arrives after the guard has failed is rejected, not accepted', () => {
  const h = loadShippedWorklet();
  driveUntilSubmitted(h, 1);
  // Withhold block 1 entirely: the guard must fail closed at its due frame.
  for (let guard = 0; guard < 40 && !failed(h); guard++) {
    h.quantum();
    if (all(h, 'worklet-submit').some(entry => entry.sequence === 0)
      && !all(h, 'worklet-result').some(entry => entry.sequence === 0)) h.deliver(0, 0.25);
  }
  assert.equal(failed(h), true, 'a block that never arrives must fail the processor');

  // The late result then turns up. It must not be accepted, and it must not revive
  // the processor.
  h.deliver(1, 0.75);
  const result = resultFor(h, 1);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'after-failure');
  // The guard now fails inside the quantum that STARTS at the due frame, and
  // this.outputFrame advances at the end of that callback, so a result arriving
  // afterwards is stamped 3200 rather than the 3072 the old one-frame-early guard
  // produced. The block was still due at 3072; it is simply late.
  assert.equal(result.receivedOutputFrame, 3200);
  assert.equal(result.dueOutputFrame, 3072);
  assert.ok((result.receivedOutputFrame as number) > (result.dueOutputFrame as number),
    'and the evidence shows it arrived after the frame that needed it');
  assert.equal(h.processor.ready.size, 0, 'a rejected result never enters the output queue');

  // And the processor stays failed: later callbacks keep failing closed.
  const { output } = h.quantum();
  assert.equal(failed(h), true);
  assert.equal(output.every(sample => sample === 0), true, 'and keeps outputting silence');
});

test('3b. a result for a sequence that is not pending is refused and changes nothing', () => {
  const h = loadShippedWorklet();
  driveUntilSubmitted(h, 1);
  driveToFrameWithPending(h, 3072);
  assert.equal(h.processor.pending, 1);

  // A duplicate of an already-completed block, and a block from the future. Neither
  // may clear the pending request or let the real one be skipped.
  const seenBefore = all(h, 'worklet-result').length;
  h.deliver(0, 0.9);
  h.deliver(5, 0.9);
  const stale = all(h, 'worklet-result').slice(seenBefore);
  assert.equal(stale.length, 2, 'both mis-delivered results are reported');
  assert.deepEqual(hostArray(stale.map(entry => entry.sequence as number)), [0, 5]);
  for (const entry of stale) {
    assert.equal(entry.accepted, false);
    assert.equal(entry.reason, 'stale-duplicate-or-malformed');
  }
  assert.equal(h.processor.pending, 1, 'the outstanding request is untouched');
  assert.equal(failed(h), false, 'and nothing failed closed over a mis-delivered result');

  // The genuine block is still accepted afterwards.
  h.deliver(1, 0.75);
  assert.equal(resultFor(h, 1).accepted, true);
});

// --- 4. missing at the exact due frame fails closed ------------------------------

test('4. a result missing at the exact due frame fails closed at that frame', () => {
  const h = loadShippedWorklet();
  driveUntilSubmitted(h, 1);
  for (let guard = 0; guard < 40 && !failed(h); guard++) {
    h.quantum();
    if (all(h, 'worklet-submit').some(entry => entry.sequence === 0)
      && !all(h, 'worklet-result').some(entry => entry.sequence === 0)) h.deliver(0, 0.25);
  }

  const miss = only(h, 'pending-deadline-miss');
  assert.equal(miss.pendingSequence, 1);
  assert.equal(miss.sequence, 1);
  assert.equal(miss.nextSequence, 2);
  assert.equal(miss.dueOutputFrame, 3072);
  // The correction, stated in frames: the guard is now evaluated on the frame the
  // block is actually needed at, not one frame earlier.
  assert.equal(miss.outputFrameAtQuantumStart, 3072, 'the quantum that needs the block');
  assert.equal(miss.inputSampleIndex, 0, 'its first sample');
  assert.equal(miss.inputQuantumFrames, QUANTUM_FRAMES);
  assert.equal(miss.currentOutputFrame, 3072, 'the frame being evaluated');
  assert.equal(miss.nextQuantumOutputFrame, 3200);
  assert.equal(miss.currentOutputFrame, miss.dueOutputFrame,
    'the guard now fires AT the due frame');
  assert.equal((miss.dueOutputFrame as number) - (miss.currentOutputFrame as number), 0,
    'framesBeforeDue is zero - it is no longer one frame early');
  // Block 0 rendered its last sample at output frame 3071 and was released there, so
  // by the frame block 1 is due nothing is left in the processed queue. Block 1's dry
  // copy is still held - and is not used.
  assert.deepEqual(hostArray(miss.readySequences), [], 'block 1 really had not arrived');
  assert.deepEqual(hostArray(miss.drySequences), [1], 'its dry copy existed and was not used');

  assert.equal(failed(h), true);
  const reason = h.events.find(entry => entry.type === 'failure')?.reason;
  assert.ok(String(reason).includes('missed its real-time processing deadline'),
    `unexpected failure reason: ${reason}`);
});

// --- 5. no stale or dry PCM is emitted as a substitute ---------------------------

test('5. failing closed emits silence, never the dry or a previous block', () => {
  const h = loadShippedWorklet();
  driveUntilSubmitted(h, 1);
  for (let guard = 0; guard < 40 && !failed(h); guard++) {
    h.quantum();
    if (all(h, 'worklet-submit').some(entry => entry.sequence === 0)
      && !all(h, 'worklet-result').some(entry => entry.sequence === 0)) h.deliver(0, 0.25);
  }
  assert.equal(failed(h), true);

  // The dry copy of block 1 was retained (that is what keeps a dry fallback
  // possible), and block 0's processed samples were real. Neither may be emitted.
  assert.equal(h.processor.dryReady.size, 0, 'fail() clears the dry copies');
  assert.equal(h.processor.ready.size, 0, 'and the processed queue');

  for (let guard = 0; guard < 4; guard++) {
    const { output } = h.quantum();
    assert.equal(output.length, QUANTUM_FRAMES);
    assert.equal(output.every(sample => sample === 0), true,
      `quantum ${guard} after the failure must be silence, not dry (${DRY_LEVEL}) or stale PCM`);
  }
});

// --- 6. the ordinary streaming path is unchanged ---------------------------------

test('6. a long run with prompt results streams without a guard firing', () => {
  const h = loadShippedWorklet();
  const sequences: number[] = [];
  for (let guard = 0; guard < 64 && !failed(h); guard++) {
    h.quantum();
    // Answer the newest outstanding block immediately, i.e. between callbacks.
    const outstanding = all(h, 'worklet-submit')
      .map(entry => entry.sequence as number)
      .filter(sequence => !all(h, 'worklet-result').some(entry => entry.sequence === sequence));
    for (const sequence of outstanding) { h.deliver(sequence, 0.5); sequences.push(sequence); }
  }
  assert.equal(failed(h), false, 'nothing may fail when every result is on time');
  assert.equal(all(h, 'pending-deadline-miss').length, 0);
  assert.equal(all(h, 'deadline-miss').length, 0);
  assert.ok(sequences.length >= 3, `expected several blocks to stream, got ${sequences.length}`);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), 'handed off in order');
  assert.deepEqual(sequences, [...new Set(sequences)], 'and never twice');

  // Every block was submitted exactly one block before it was due.
  for (const submit of all(h, 'worklet-submit')) {
    assert.equal((submit.dueOutputFrame as number) - (submit.submittedOutputFrame as number),
      VST3_FX_BLOCK_FRAMES, `block ${submit.sequence} keeps its one-block budget`);
  }
});

// --- 7. the output-side deadline guard is intact ---------------------------------

test('7. the output-side guard still fires at the exact sample that needs the block', () => {
  const h = loadShippedWorklet();
  driveUntilSubmitted(h, 1);
  h.deliver(1, 0.5);
  for (let guard = 0; guard < 12; guard++) {
    if (h.quantum().start >= 2944) break;
  }
  // Constructed state, labelled as such: the pending guard is satisfied, so this is
  // the only way to reach the output-side guard. The point is to read its own frame
  // reporting and confirm the correction did not disturb it.
  h.processor.ready.delete(1);
  const { start } = h.quantum();
  assert.equal(start, 3072);

  const miss = only(h, 'deadline-miss');
  assert.equal(miss.sequence, 1);
  assert.equal(miss.currentOutputFrame, 3072);
  assert.equal(miss.dueOutputFrame, 3072);
  assert.equal(miss.outputFrameAtQuantumStart, 3072);
  assert.equal(miss.outputSampleIndex, 0, 'evaluated on the very first sample that needs the block');
  assert.equal(miss.outputQuantumFrames, QUANTUM_FRAMES);
  assert.equal(miss.currentOutputFrame, miss.dueOutputFrame, 'at the due frame, never before it');
  assert.equal(failed(h), true);
  assert.equal(all(h, 'pending-deadline-miss').length, 0, 'the two guards are still distinct');
});

test('7b. the pending guard now agrees with the output guard about when a block is late', () => {
  // Both guards are evaluated at the same output frame for the same block. The
  // pending guard runs first because the input loop precedes the output loop, so it
  // is still the one that reports - but it no longer reports a frame early.
  const pending = loadShippedWorklet();
  driveUntilSubmitted(pending, 1);
  for (let guard = 0; guard < 40 && !failed(pending); guard++) {
    pending.quantum();
    if (all(pending, 'worklet-submit').some(entry => entry.sequence === 0)
      && !all(pending, 'worklet-result').some(entry => entry.sequence === 0)) pending.deliver(0, 0.25);
  }
  const pendingMiss = only(pending, 'pending-deadline-miss');

  const output = loadShippedWorklet();
  driveUntilSubmitted(output, 1);
  output.deliver(1, 0.5);
  for (let guard = 0; guard < 12; guard++) {
    if (output.quantum().start >= 2944) break;
  }
  output.processor.ready.delete(1);
  output.quantum();
  const outputMiss = only(output, 'deadline-miss');

  for (const field of ['outputFrameAtQuantumStart', 'currentOutputFrame',
    'dueOutputFrame', 'nextQuantumOutputFrame', 'pendingSequence']) {
    assert.ok(field in pendingMiss, `pending guard must report ${field}`);
    assert.ok(field in outputMiss, `output guard must report ${field}`);
  }
  assert.equal(pendingMiss.dueOutputFrame, outputMiss.dueOutputFrame);
  assert.equal(pendingMiss.currentOutputFrame, outputMiss.currentOutputFrame,
    'both guards now evaluate the same block at the same frame');
});

// --- the arithmetic the correction rests on --------------------------------------

test('8. the delay is exactly two blocks, so the old guard was exactly one frame early', () => {
  // due(s) = delay + s*block. The old guard ran when block s+1 filled, at output
  // frame (s+2)*block - 1, so it led the due frame by delay - 2*block + 1 frames.
  assert.equal(VST3_FX_PIPELINE_FRAMES - 2 * VST3_FX_BLOCK_FRAMES + 1, 1);
  assert.equal(VST3_FX_BLOCK_FRAMES % QUANTUM_FRAMES, 0,
    'a block is a whole number of quanta, so it always fills on a quantum\'s last sample');
  assert.equal(VST3_FX_PIPELINE_FRAMES % QUANTUM_FRAMES, 0,
    'and every due frame is a quantum boundary, so the wait always ends on one');
});
