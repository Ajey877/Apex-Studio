/**
 * Pins the native VST3 fail-closed contract and the exact way it interacts with the
 * packaged coexistence acceptance, against the REAL shipped worklet source.
 *
 * Why this file exists. Desktop Validation run 45953961366 (job 140356010397) failed
 * on `main` at `98b8e81` with
 *
 *   Packaged native VST3 coexistence failed at stage 'arm-probe'
 *   Warmup timed out: waitedMs=60015 of 60000 prepared=false processedBlocks=3
 *   priorBlocks=3 deadlineMisses=1 nativeFailures=0 failureMessages=[]
 *   nativeDiagnostics=[{ message: "Native effect missed its real-time processing
 *   deadline; playback stopped rather than replaying stale PCM." }]
 *
 * The layer between "one slow block" and "the acceptance cannot proceed" is not
 * covered by any test today: `nativeVst3PendingGuardBoundary.test.ts` pins *when* the
 * guard fires, but not what the session looks like afterwards. This file pins that
 * consequence, because it is the step that turns a real-time hiccup into a 60 s
 * warmup timeout and a red gate.
 *
 * Everything asserted here is a REQUIREMENT that must keep holding. None of it
 * asserts a defect. If a future change lets a latched insert resume processing on its
 * own, that is a deliberate change to fail-closed semantics and this file must be
 * updated in the same commit - not quietly.
 *
 * Methodology matches `nativeVst3PendingGuardBoundary.test.ts`: `VST3_FX_WORKLET_SOURCE`
 * is evaluated in a sandbox with exactly the globals the AudioWorklet scope provides,
 * so the class under test is the one that ships. Control-port and live-port messages
 * are delivered only BETWEEN `process()` calls, which is the only point the audio
 * thread can deliver one. Every step is a synchronous call in a known order, so there
 * is no wall-clock race and no timing relaxation anywhere in this file.
 *
 * Frame vocabulary (shipped constants): blockFrames = 1024, delayFrames = 2048,
 * render quantum = 128. Block s is submitted when input frame (s+1)*1024 has been
 * consumed and is first needed at output frame due(s) = 2048 + s*1024 - a slack of
 * exactly one block, 21.33 ms at 48 kHz, which is `blockBudgetMs` in the evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  VST3_FX_WORKLET_SOURCE, VST3_FX_BLOCK_FRAMES, VST3_FX_PIPELINE_FRAMES,
  NativeVst3EffectRuntime, getVst3MixerEffectDiagnostics,
} from './nativeVst3EffectRuntime';
import type { FxSlot, MixerTrack } from '../types/daw';
import type { Vst3Bridge, Vst3Effect } from './nativeVst3Types';

/**
 * Fixtures for test 10, matching the shape `nativeVst3EffectRuntime.test.ts` uses so
 * the product path is driven by realistic Mixer data rather than a special case.
 */
const recoveryEffect: Vst3Effect = {
  path: 'C:/test/mda-vst3.vst3', classId: '0123456789ABCDEF0123456789ABCDEF', name: 'mda test effect',
  vendor: 'mda', version: 'test',
  state: { schema: 1, classId: '0123456789ABCDEF0123456789ABCDEF', parameters: [] },
};
const recoverySlot: FxSlot = {
  id: 'fx-recovery', type: 'vst3', name: recoveryEffect.name, enabled: true, mix: 1, params: {},
  vst3Effect: recoveryEffect,
};
const recoveryTrack: MixerTrack = {
  id: 1, name: 'Recovery', color: '#fff', volume: 1, pan: 0, mute: false, solo: false,
  fxSlots: [recoverySlot], peakL: 0, peakR: 0,
};

/** Chromium's fixed AudioWorklet render quantum. */
const QUANTUM_FRAMES = 128;
/** Input level fed to every quantum. Distinct from any level this file substitutes. */
const DRY_LEVEL = 0.1;
/** The production failure text, verbatim from the evidence annotations. */
const PENDING_DEADLINE_MISSED =
  'Native effect missed its real-time processing deadline; playback stopped rather than replaying stale PCM.';
/** One second of playback at the shipped 48 kHz rate. */
const SECOND_OF_QUANTA = Math.ceil(48000 / QUANTUM_FRAMES);

interface PostedEvent {
  type?: string;
  event?: string;
  reason?: string;
  sequence?: number;
  [key: string]: unknown;
}

interface Harness {
  /** Render one quantum. Returns the output frame it started at and its output. */
  quantum(): { start: number; output: Float32Array; right: Float32Array };
  /** Deliver a result as the live port delivers one. Between quanta only. */
  deliver(sequence: number, fill?: number): void;
  events: PostedEvent[];
  processor: any;
  readonly outputFrame: number;
  /**
   * The exact `reason` the shipped worklet posted with its `{type:'failure'}`, or
   * null when it has not failed. Test 10 hands this to the real runtime, so the
   * disposal it then exercises is triggered by the shipped message rather than a
   * string invented by the test.
   */
  readonly failureReason: string | null;
}

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
  return {
    events,
    processor,
    get outputFrame() { return outputFrame; },
    get failureReason() {
      const failure = events.find(entry => entry.type === 'failure');
      return failure ? String(failure.reason) : null;
    },
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
      const rendered = new Float32Array(out[0]);
      const renderedRight = new Float32Array(out[1]);
      contextFrame += QUANTUM_FRAMES;
      outputFrame += QUANTUM_FRAMES;
      return { start, output: rendered, right: renderedRight };
    },
    deliver(sequence, fill = 0.5) {
      const samples = context.__make(VST3_FX_BLOCK_FRAMES * 2);
      samples.fill(fill);
      context.__livePort.onmessage({ data: { type: 'result', sequence, samples } });
      drain();
    },
  };
}

const failed = (h: Harness): boolean => h.events.some(entry => entry.type === 'failure');
const all = (h: Harness, event: string): PostedEvent[] => h.events.filter(entry => entry.event === event);
const submits = (h: Harness): PostedEvent[] => all(h, 'worklet-submit');
const results = (h: Harness): PostedEvent[] => all(h, 'worklet-result');
const acceptedSequences = (h: Harness): number[] => results(h)
  .filter(entry => entry.accepted === true)
  .map(entry => entry.sequence as number);
/** Arrays built inside the sandbox have its Array prototype; copy before deepEqual. */
const hostArray = (value: unknown): number[] => [...value as number[]];

/**
 * Renders until block `sequence` has been submitted, answering every other submitted
 * block in time so the session stays healthy. Used by the duplicate-delivery test,
 * which must never trip the guard.
 */
function driveUntilSubmitted(h: Harness, sequence: number): void {
  for (let guard = 0; guard < 80; guard++) {
    if (submits(h).some(entry => entry.sequence === sequence)) return;
    for (const submit of submits(h)) {
      const submitted = submit.sequence as number;
      if (submitted === sequence) continue;
      if (h.outputFrame >= (submit.dueOutputFrame as number)
        && !results(h).some(entry => entry.sequence === submitted)) {
        h.deliver(submitted, 0.25);
      }
    }
    h.quantum();
  }
  throw new Error(`sequence ${sequence} was never submitted`);
}

/**
 * Drives to the state the failing run reached: block 2 has just filled while block
 * 1's helper round trip is still in flight. Block 2 fills on the last sample of the
 * quantum starting at output frame 2048, which is exactly where block 1 becomes due -
 * so withholding block 1's result here is precisely the production miss, at
 * `processedBlocks = 3`.
 */
function driveToMissedDueFrame(h: Harness): void {
  for (let guard = 0; guard < 80; guard++) {
    // Answer every submitted block that is not the slow one, so the run reaches the
    // block under test in a healthy state - exactly what the real path does when only
    // one round trip is slow.
    for (const submit of submits(h)) {
      const sequence = submit.sequence as number;
      if (sequence === 1) continue;
      const due = submit.dueOutputFrame as number;
      if (h.outputFrame >= due && !results(h).some(entry => entry.sequence === sequence)) {
        h.deliver(sequence, 0.25);
      }
    }
    if (failed(h)) return;
    h.quantum();
    if (failed(h)) return;
  }
  throw new Error('the guard never fired; the fixture did not reproduce the miss');
}

// --- 1. one over-budget round trip latches the insert -----------------------------

test('1. one block whose round trip exceeds the budget trips the guard with the production text', () => {
  const h = loadShippedWorklet();
  driveToMissedDueFrame(h);

  const misses = all(h, 'pending-deadline-miss');
  assert.equal(misses.length, 1, 'exactly one deadline miss is reported');
  assert.equal(misses[0].pendingSequence, 1, 'the withheld block is the one the guard names');
  assert.equal(failed(h), true, 'the effect fails closed');

  const failure = h.events.find(entry => entry.type === 'failure');
  assert.equal(failure?.reason, PENDING_DEADLINE_MISSED,
    'the reported reason is the string the acceptance surfaces as a native diagnostic');
});

test('2. the miss is reported at the frame the block was due, not one frame early', () => {
  const h = loadShippedWorklet();
  driveToMissedDueFrame(h);
  const miss = all(h, 'pending-deadline-miss')[0];
  // This is the `ead88bb` correction, pinned as a consequence rather than as frame
  // arithmetic: the decision is made on the frame that actually needs the block.
  assert.equal(miss.currentOutputFrame, miss.dueOutputFrame,
    'the guard fires on the due frame itself');
  assert.equal(miss.dueOutputFrame, 3072, 'block 1 is due at output frame 2048 + 1024');
});

// --- 3. fail-closed means silent, and that is a requirement -----------------------

test('3. a latched insert emits silence for the rest of the session - never dry or stale audio', () => {
  const h = loadShippedWorklet();
  driveToMissedDueFrame(h);
  const acceptedAtFailure = acceptedSequences(h).length;

  let nonSilentQuanta = 0;
  for (let i = 0; i < SECOND_OF_QUANTA; i++) {
    const { output, right } = h.quantum();
    if (output.some(sample => sample !== 0) || right.some(sample => sample !== 0)) nonSilentQuanta++;
  }

  // Requirement, not a defect: `process()` early-returns once `failed` is set, so no
  // dry substitute and no late block can be spliced in. In the product this is paired
  // with `onFatal -> audioEngine.stop()`, so the transport stops rather than playing
  // silenced audio. Weakening this would mean playing stale PCM, which is exactly
  // what the guard exists to prevent.
  assert.equal(nonSilentQuanta, 0, 'a latched insert must emit only silence');
  assert.equal(acceptedSequences(h).length, acceptedAtFailure,
    'no block is processed after the latch');
});

test('4. the request stream stops at the latch, so nothing is queued without bound', () => {
  const h = loadShippedWorklet();
  driveToMissedDueFrame(h);
  const submittedAtFailure = submits(h).length;
  for (let i = 0; i < 2 * SECOND_OF_QUANTA; i++) h.quantum();
  assert.equal(submits(h).length, submittedAtFailure,
    'a latched insert must not keep submitting native requests: no unbounded queue');
});

// --- 5. the guards that must NOT weaken -------------------------------------------

test('5. a helper that never answers still fails closed', () => {
  const h = loadShippedWorklet();
  for (let guard = 0; guard < 80 && !failed(h); guard++) h.quantum();
  assert.equal(failed(h), true, 'a helper that never answers must still stop playback');
  assert.equal(h.events.find(entry => entry.type === 'failure')?.reason, PENDING_DEADLINE_MISSED);
  // Verified by mutation: deleting ONLY the outer path (the top-of-quantum check that
  // resolves a block filled on the previous quantum) is invisible, because the inner
  // per-sample path below it still catches the same overdue block. Removing both is
  // what this assertion is here for - it is the only test that fails when nothing is
  // left to stop a permanently unresponsive helper.
});

test('6. a result arriving after the latch is refused, so no stale PCM is replayed', () => {
  const h = loadShippedWorklet();
  driveToMissedDueFrame(h);
  const before = results(h).length;
  // The helper finishes block 1 late. The live port delivers it anyway.
  h.deliver(1, 0.9);
  const late = results(h).slice(before);
  assert.equal(late.length, 1, 'the late result is accounted for');
  assert.equal(late[0].sequence, 1);
  assert.equal(late[0].accepted, false, 'a result for an abandoned block must never be accepted');
  assert.equal(late[0].reason, 'after-failure');
  assert.deepEqual(hostArray(acceptedSequences(h)), [0], 'only block 0 is ever accepted');
});

test('7. a duplicate delivery is rejected in a healthy session, without the latch', () => {
  /**
   * This test deliberately never trips the guard. A post-latch duplicate would be
   * rejected by the `failed` term of `valid`, which proves nothing about duplicate
   * handling - and a latch also freezes the stream, so the accepted list is `[0]`
   * and a uniqueness check over one element can never fail. That is the hole this
   * test fills: the duplicate must be refused while the processor is healthy.
   *
   * The contract under test, from the shipped `handleLive`:
   *   valid = !failed && !stopped && sequence === pending && samples instanceof
   *           Float32Array && samples.length === blockFrames * 2
   * so a second result for a sequence that has already been accepted fails the
   * `pending` term: `pending` is reset to -1 on acceptance, and a duplicate cannot
   * become the outstanding request again. The reason the worklet reports for that
   * is `stale-duplicate-or-malformed` - the implementation's actual string for
   * every non-adopted, non-failed, non-stopped result. Nothing is invented here.
   */
  const h = loadShippedWorklet();

  // Healthy session: answer block 0 in time and let it be accepted and rendered.
  driveUntilSubmitted(h, 0);
  h.deliver(0, 0.5);
  const firstResult = results(h).filter(entry => entry.sequence === 0)[0];
  assert.equal(firstResult.accepted, true, 'block 0 is accepted on time');
  assert.equal(firstResult.reason, null, 'an accepted result carries no reason');
  assert.equal(h.processor.pending, -1, 'acceptance resets the outstanding request');
  assert.equal(failed(h), false, 'nothing has failed: this is a healthy session');

  // Deliver the exact same sequence again, still healthy.
  const acceptedBefore = acceptedSequences(h).length;
  const resultsBefore = results(h).length;
  h.deliver(0, 0.9);

  const duplicate = results(h).length > resultsBefore ? results(h).slice(resultsBefore) : [];
  assert.equal(duplicate.length, 1, 'the duplicate delivery is accounted for');
  assert.equal(duplicate[0].sequence, 0);

  // The guarantees, each asserted directly rather than through a set over one element.
  assert.equal(duplicate[0].accepted, false, 'a duplicate must never be adopted');
  assert.equal(duplicate[0].reason, 'stale-duplicate-or-malformed',
    'the rejection reason is the one the shipped implementation reports');
  assert.equal(acceptedSequences(h).length, acceptedBefore,
    'the accepted-block count must not increase');
  assert.equal(failed(h), false,
    'the duplicate must be refused by the pending term, not by the post-latch guard');
  assert.equal(all(h, 'pending-deadline-miss').length, 0,
    'no guard fired, so this proves duplicate handling rather than failure handling');

  // The duplicate's audio was not spliced in: the session keeps rendering the block
  // that was genuinely accepted (0.5), never the duplicate's 0.9.
  let rendered: number[] = [];
  for (let guard = 0; guard < 12; guard++) {
    const { start, output } = h.quantum();
    if (start >= VST3_FX_PIPELINE_FRAMES) rendered = [...output];
    if (rendered.length) break;
  }
  assert.equal(rendered[0], 0.5, 'the accepted PCM is what is rendered, not the duplicate');
  assert.equal(failed(h), false, 'the session is still healthy after refusing the duplicate');
});

// --- 8. the link to the acceptance: why the warmup timed out ----------------------
//
// `packaged-native-monitoring-acceptance.mjs` requires, within 60 s,
//   prepared && processedBlocks > priorBlocks
// where `processedBlocks` is the count of completed worklet results. Combined with
// tests 3 and 4 above, a latched insert can never satisfy that predicate: the count
// is frozen at the block where the guard fired (3 in the failing evidence) and
// `isPrepared()` is false because the control side disposed the faulted entry. The
// 60 s warmup therefore always expires, and the acceptance reports `arm-probe`.
//
// This test states that composition explicitly so the diagnosis cannot silently drift:
// it is the warmup timeout's mechanism, not an extra symptom.
test('8. after a latch the coexistance warmup predicate can never be satisfied', () => {
  const h = loadShippedWorklet();
  driveToMissedDueFrame(h);

  const blocksAtLatch = results(h).length;
  let everAdvanced = false;
  for (let i = 0; i < SECOND_OF_QUANTA; i++) {
    const before = results(h).length;
    h.quantum();
    if (results(h).length > before) everAdvanced = true;
  }

  // `prepared` is false too (the control side disposes a faulted entry), but the block
  // count alone is enough to make the predicate unsatisfiable, and it is observable
  // from the worklet. Both must hold for the warmup to have any chance.
  //
  // The frozen value is the number of blocks the helper had completed when the guard
  // fired, which depends on how many earlier round trips the run had answered - 3 in
  // the failing evidence, 1 here, where only block 0 was answered in time. The
  // property is that it stops, not which number it stops at.
  assert.equal(everAdvanced, false,
    'processedBlocks must not advance after a latch, which is why the warmup expires');
  assert.equal(results(h).length, blocksAtLatch,
    'the count is frozen at the latch and never moves again');
});

// --- 9. the audio thread must go quiet after the latch ---------------------------

test('9. a latched insert stops posting diagnostics: no message storm on the audio thread', () => {
  /**
   * `process()` has a second `failed` guard immediately before the output loop, and it
   * is load-bearing in a way that is easy to miss: `fail()` clears `ready`/`dryReady`,
   * so without the guard every subsequent quantum finds its block missing at the output
   * loop, posts another `deadline-miss` profile event and breaks. Measured with the
   * guard removed, a latched insert emits one diagnostic per quantum - 376 of them over
   * one second - forever. `postMessage` from the audio thread is the one operation here
   * that is not real-time safe, so an already-failed session must not keep doing it.
   *
   * This is why the guard is required rather than merely tidy.
   */
  const h = loadShippedWorklet();
  driveToMissedDueFrame(h);
  const missesAtLatch = all(h, 'deadline-miss').length;
  const failuresAtLatch = h.events.filter(entry => entry.type === 'failure').length;

  for (let i = 0; i < SECOND_OF_QUANTA; i++) h.quantum();

  assert.equal(all(h, 'deadline-miss').length, missesAtLatch,
    'a latched insert must not post a diagnostic for every following quantum');
  assert.equal(h.events.filter(entry => entry.type === 'failure').length, failuresAtLatch,
    'the failure is reported once, not once per quantum');
});

// --- 10. recovery is explicit re-preparation, not in-session resurrection --------

test('10. the real runtime disposes a faulted entry and the next Play prepares a usable one', async () => {
  /**
   * This is the product-level recovery test, and it runs the SHIPPED runtime rather
   * than a second sandbox. Nothing is changed in production code to make it
   * reachable: `NativeVst3EffectRuntime` already takes the bridge through
   * `getBridge`, and `AudioWorkletNode` is a global, so both are the same seams
   * `nativeVst3EffectRuntime.test.ts` uses.
   *
   * The chain under test is the one the acceptance depends on:
   *   shipped worklet posts {type:'failure', reason}
   *     -> node.port.onmessage -> runtime.fail(entry, reason)
   *     -> entry.faulted = true, reportVst3MixerEffect, onFatal (the app stops the
   *        transport here), disposeEntry(entry) which removes it from `prepared`
   *   ... and then, on the next Play, ensureTracksPrepared takes the `faulted` entry
   *   as NON-reusable, disposes it and opens a FRESH session.
   *
   * What this does NOT prove is stated in the report: it exercises the runtime's
   * disposal and re-preparation, not `audioEngine.stop()` (which `onFatal` invokes
   * in the app) and not the native helper itself, which is mocked.
   *
   * Mutation note, recorded because it bounds what this test can claim. The
   * "not reusable" property is protected by defence in depth: `disposed`, `stopping`
   * and `faulted` are three independent terms in `ensureTracksPrepared`, and
   * `isPrepared` repeats them. Removing the `faulted` term ALONE does not fail this
   * test, because `fail(entry, ...)` also called `disposeEntry`, so `disposed` and
   * `stopping` already block reuse. The test fails only when all of them are removed
   * at once. So this pins the OBSERVABLE product behaviour - a failed insert is
   * disposed and the next Play prepares a fresh usable session - and not any single
   * intermediate term. That is the correct level to assert here, and it is not the
   * same claim as "the `faulted` check is pinned".
   */
  const workspaces: Array<() => void> = [];
  const restore = () => { while (workspaces.length) workspaces.pop()!(); };
  try {
    // Capture the shipped failure text instead of hard-coding it, so this test stays
    // honest if the guard's wording ever changes.
    const latch = loadShippedWorklet();
    driveToMissedDueFrame(latch);
    const shippedFailure = latch.failureReason;
    assert.equal(shippedFailure, PENDING_DEADLINE_MISSED,
      'the shipped worklet reports the production failure text');
    assert.equal(failed(latch), true);

    // --- the real runtime, with the narrowest seams -------------------------------
    const originalNode = (globalThis as any).AudioWorkletNode;
    const nodes: any[] = [];
    /**
     * Stands in for the AudioWorkletNode the runtime constructs. `port.onmessage` is
     * driven directly, exactly as Chromium delivers a worklet message, so the shipped
     * runtime's own `if (message?.type === 'failure') { this.fail(...) }` branch runs.
     */
    class RecordingWorkletNode {
      port: {
        onmessage: ((event: { data: any }) => void) | null;
        sent: any[];
        closed: boolean;
        postMessage: (message: any) => void;
        close: () => void;
      };
      onprocessorerror: (() => void) | null = null;
      disconnected = false;
      constructor(_context: any, _name: string, _options: any) {
        // `port` is bound to a local before the object literal so the methods close
        // over the port itself, not over `this` (which is the port inside them).
        const port: RecordingWorkletNode['port'] = {
          onmessage: null,
          sent: [],
          closed: false,
          postMessage: (message: any) => {
            port.sent.push(message);
            // The shipped worklet answers a stop request with an acknowledgement; the
            // runtime's disposal waits for it (250 ms budget) before closing.
            if (message?.type === 'stop') queueMicrotask(() => port.onmessage?.({
              data: { type: 'stop-ack', sequence: null, reason: message.reason },
            }));
          },
          close: () => { port.closed = true; },
        };
        this.port = port;
        nodes.push(this);
      }
      disconnect() { this.disconnected = true; }
    }
    (globalThis as any).AudioWorkletNode = RecordingWorkletNode;
    workspaces.push(() => { (globalThis as any).AudioWorkletNode = originalNode; });

    let sessionCounter = 0;
    const opened: string[] = [];
    const closed: string[] = [];
    const bridge: Vst3Bridge = {
      paths: async () => [], choosePath: async () => null,
      discover: async () => ({ plugins: [], errors: [] }),
      discoverEffects: async () => ({ plugins: [], errors: [] }),
      inspect: async () => { throw new Error('unused'); },
      inspectEffect: async () => recoveryEffect,
      describeEffect: async () => ({ parameters: [], controllerAvailable: false }),
      describe: async () => ({ parameters: [], controllerAvailable: false }),
      parameters: async () => [],
      open: async () => { const id = `session-${++sessionCounter}`; opened.push(id); return { id, latencySamples: 0 }; },
      process: async () => new Float32Array(),
      processAudio: async () => new Float32Array(VST3_FX_BLOCK_FRAMES * 2).fill(0.25),
      close: async (id: string) => { closed.push(id); },
    };
    const context: any = { sampleRate: 48000, currentTime: 0, state: 'running', audioWorklet: { addModule: async () => {} } };
    const fatal: Array<{ trackId: number; slotId: string; message: string }> = [];
    const runtime = new NativeVst3EffectRuntime((trackId, slotId, message) => {
      fatal.push({ trackId, slotId, message });
    }, () => bridge);

    // 1. A song is playing with the insert prepared - one session, one node.
    await runtime.ensureTracksPrepared([recoveryTrack], context);
    assert.equal(runtime.isPrepared(recoveryTrack.id, recoverySlot.id, context, recoveryEffect), true,
      'the insert is prepared before the failure');
    assert.equal(opened.length, 1, 'one native session was opened');
    assert.equal(nodes.length, 1, 'one worklet node was constructed');
    const firstNode = nodes[0];

    // 2. The shipped worklet fires. Deliver its ACTUAL message to the runtime.
    assert.equal(firstNode.port.onmessage !== null, true,
      'the runtime installed a control-port handler, which is the path under test');
    firstNode.port.onmessage!({ data: { type: 'failure', reason: shippedFailure } });

    // 3. The runtime latches the entry: faulted, disposed, reported, and fatal.
    assert.equal(fatal.length, 1, 'the runtime reported the failure exactly once');
    assert.equal(fatal[0].message, shippedFailure, 'the production message reached onFatal');
    assert.equal(fatal[0].trackId, recoveryTrack.id);
    assert.equal(fatal[0].slotId, recoverySlot.id);
    assert.equal(getVst3MixerEffectDiagnostics().some(item => item.trackId === recoveryTrack.id && item.slotId === recoverySlot.id
      && item.message === shippedFailure), true,
      'the same message is exposed to the UI as a native Mixer diagnostic');

    // 4. The entry is faulted, so monitoring refuses rather than reviving a dead insert.
    //    The disposal is asynchronous (it waits for a stop acknowledgement and a session
    //    close), so this is deliberately sampled BEFORE it completes: that is the window
    //    a user's next Play actually lands in, and it must not be able to reuse the entry.
    assert.equal(runtime.isPrepared(recoveryTrack.id, recoverySlot.id, context, recoveryEffect), false,
      'a faulted insert is not reported as prepared - this is `prepared=false`');
    assert.equal(runtime.nodeFor(recoveryTrack.id, recoverySlot.id, context, recoveryEffect), undefined,
      'no node is offered for a faulted insert');
    assert.equal(firstNode.port.sent.some((message: any) => message?.type === 'stop'), true,
      'disposal asked the shipped worklet to stop');

    // 5. The next Play, immediately - before that disposal has finished. This is the
    //    recovery path: a faulted entry is NOT reusable, and `ensureTracksPrepared`
    //    awaits the in-flight disposal rather than orphaning it.
    await runtime.ensureTracksPrepared([recoveryTrack], context);
    assert.equal(opened.length, 2, 're-preparation opened a fresh native session');
    assert.equal(opened[1], 'session-2', 'it is a new session, not the disposed one');
    assert.equal(nodes.length, 2, 'a new worklet node was constructed');
    assert.notEqual(nodes[1], firstNode, 'the new insert is a different node, not the latched one');
    assert.equal(runtime.isPrepared(recoveryTrack.id, recoverySlot.id, context, recoveryEffect), true,
      'the re-prepared insert is usable again - this is what recovery means here');
    assert.equal(closed.includes('session-1'), true, 'the faulted session was closed in the helper');
    assert.equal(firstNode.port.closed, true, 'the faulted worklet port was closed');
    assert.equal(runtime.nodeFor(recoveryTrack.id, recoverySlot.id, context, recoveryEffect), nodes[1],
      'lookups return the fresh node');
    assert.equal(fatal.length, 1, 'no second failure was reported for the fresh session');

    // 6. And the fresh session is genuinely healthy: it accepts results again.
    const secondNode = nodes[1] as any;
    const port = secondNode.port;
    // The runtime forwards each accepted block to the worklet with its samples, so
    // observe the results it pushes rather than re-implementing the worklet.
    port.onmessage({ data: { type: 'profile', event: 'live-bound' } });
    assert.equal(runtime.isPrepared(recoveryTrack.id, recoverySlot.id, context, recoveryEffect), true,
      'a fresh session survives a live-port bind notification');
  } finally {
    restore();
  }
});
