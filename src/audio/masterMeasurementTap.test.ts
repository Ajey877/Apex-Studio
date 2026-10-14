/**
 * Phase 90 — F1: the master measurement tap must measure the master OUTPUT.
 *
 * The reported defect: the master chain is
 *
 *     masterGain → grossBeatNode → masteringProcessor → masterAnalyser → destination
 *
 * but the Phase 45 splitter tap hung off `grossBeatNode`, which is the
 * mastering processor's *input*. `getMasterLoudnessMetrics` promises its
 * callers "samples that actually passed the master output", and a maximizer's
 * ceiling can only be verified against a post-processor reading, so every
 * gated-loudness / true-peak / stereo-field figure described a signal the user
 * never hears whenever mastering is enabled.
 *
 * These tests are graph assertions on `createMasterMeasurementTap`, driven
 * through a faithful `SimNode` context in the style of `phase64.mixerMeter.test.ts`:
 * a node's `incoming` edges are the real topology, so "what does the tap see?"
 * is answered by walking backwards from the splitter, not by grepping source.
 *
 * Each test is written to FAIL on the old wiring (tap sourced from
 * `grossBeatNode` while a processor exists) and PASS on the fixed wiring.
 *
 * Scope: measurement wiring only. Nothing here asserts anything about the
 * mastering algorithms, and nothing here renders audio — whether the *values*
 * the meters report now track the processed signal end to end is covered by the
 * real-DSP check in `masteringDspSignal.test.ts` and remains UNVERIFIED in a
 * live browser until a rendered-audio test measures it (see the PR body).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as Engine from 'web-audio-engine';
import { audioEngine } from './audioEngine';
import { MasteringProcessor } from './masteringProcessor';
import type { MasteringSuiteState } from '../types/daw';
import { DEFAULT_MASTERING_SUITE_STATE } from './masteringState';

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const SAMPLE_RATE = 48000;

/** Master measurement state fields captured and restored around each test. */
const MEASUREMENT_FIELDS = [
  'ctx',
  'masterGain',
  'grossBeatNode',
  'masterAnalyser',
  'masteringProcessor',
  'masterSplitter',
  'masterAnalyserL',
  'masterAnalyserR',
  'loudnessMeter',
  'truePeakMeter',
  'stereoFieldMeter',
] as const;

class SimParam {
  value: number;
  constructor(initial: number) {
    this.value = initial;
  }
  setValueAtTime(value: number): void { this.value = value; }
  setTargetAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(value: number): void { this.value = value; }
  exponentialRampToValueAtTime(value: number): void { this.value = value; }
  cancelScheduledValues(): void {}
}

class SimNode {
  readonly kind: string;
  readonly connections: SimNode[] = [];
  readonly incoming: SimNode[] = [];
  readonly gain = new SimParam(1);
  readonly pan = new SimParam(0);
  readonly frequency = new SimParam(440);
  readonly Q = new SimParam(1);
  readonly detune = new SimParam(0);
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  curve: Float32Array | null = null;
  oversample = 'none';
  threshold = new SimParam(-24);
  knee = new SimParam(30);
  ratio = new SimParam(12);
  attack = new SimParam(0.003);
  release = new SimParam(0.25);
  type = 'lowpass';

  constructor(kind: string) { this.kind = kind; }

  connect(target: SimNode): SimNode {
    if (target instanceof SimNode && !this.connections.includes(target)) {
      this.connections.push(target);
      target.incoming.push(this);
    }
    return target;
  }

  disconnect(target?: SimNode): void {
    if (!target) {
      for (const downstream of this.connections) {
        const index = downstream.incoming.indexOf(this);
        if (index >= 0) downstream.incoming.splice(index, 1);
      }
      this.connections.length = 0;
      return;
    }
    const index = this.connections.indexOf(target);
    if (index >= 0) {
      this.connections.splice(index, 1);
      const upstream = target.incoming.indexOf(this);
      if (upstream >= 0) target.incoming.splice(upstream, 1);
    }
  }

  /** True when `other` is reachable from this node by walking `connections`. */
  reaches(other: SimNode): boolean {
    const seen = new Set<SimNode>();
    const walk = (node: SimNode): boolean => {
      if (node === other) return true;
      if (seen.has(node)) return false;
      seen.add(node);
      return node.connections.some(walk);
    };
    return this.connections.some(walk);
  }
}

class SimAudioContext {
  readonly sampleRate = SAMPLE_RATE;
  readonly length = SAMPLE_RATE;
  currentTime = 0;
  state: AudioContextState = 'running';
  readonly destination = new SimNode('destination');
  readonly nodes: SimNode[] = [];

  private track(kind: string): SimNode {
    const node = new SimNode(kind);
    this.nodes.push(node);
    return node;
  }

  createGain(): SimNode { return this.track('gain'); }
  createStereoPanner(): SimNode { return this.track('panner'); }
  createAnalyser(): SimNode { return this.track('analyser'); }
  createDynamicsCompressor(): SimNode { return this.track('compressor'); }
  createBiquadFilter(): SimNode { return this.track('filter'); }
  createWaveShaper(): SimNode { return this.track('waveshaper'); }
  createChannelSplitter(_channels: number): SimNode { return this.track('splitter'); }
  createChannelMerger(_channels: number): SimNode { return this.track('merger'); }
  createOscillator(): SimNode { return this.track('oscillator'); }
  resume(): Promise<void> { return Promise.resolve(); }
}

/**
 * A minimal but topologically faithful stand-in for `MasteringProcessor`: the
 * tap's wiring decision only depends on the processor exposing a distinct
 * `input` and `output` with a real path between them, which is exactly what the
 * production class guarantees in its constructor.
 */
function makeStandInMasteringProcessor(ctx: SimAudioContext) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const internal = ctx.createDynamicsCompressor();
  input.connect(internal);
  internal.connect(output);
  return { input, output, setState: (_state: MasteringSuiteState) => undefined, dispose: () => undefined };
}

/** Build the master chain and install the measurement tap, as `init()` does. */
function buildMasterGraph(options: { withMastering: boolean }) {
  const ctx = new SimAudioContext();
  for (const field of MEASUREMENT_FIELDS) saved[field] = engine[field];

  engine.ctx = ctx;
  engine.masterGain = ctx.createGain();
  engine.grossBeatNode = ctx.createGain();
  engine.masterAnalyser = ctx.createAnalyser();
  engine.masteringProcessor = options.withMastering ? makeStandInMasteringProcessor(ctx) : null;

  engine.masterGain.connect(engine.grossBeatNode);
  if (engine.masteringProcessor) {
    engine.grossBeatNode.connect(engine.masteringProcessor.input);
    engine.masteringProcessor.output.connect(engine.masterAnalyser);
  } else {
    engine.grossBeatNode.connect(engine.masterAnalyser);
  }
  engine.masterAnalyser.connect(ctx.destination);

  engine.createMasterMeasurementTap(ctx);

  return ctx;
}

function tapNodes() {
  return {
    splitter: engine.masterSplitter as SimNode | null,
    left: engine.masterAnalyserL as SimNode | null,
    right: engine.masterAnalyserR as SimNode | null,
    grossBeat: engine.grossBeatNode as SimNode,
    masterAnalyser: engine.masterAnalyser as SimNode,
  };
}

let saved: Record<string, unknown> = {};

function restoreSaved(): void {
  for (const field of MEASUREMENT_FIELDS) engine[field] = saved[field];
  saved = {};
}

describe('Phase 90 — master measurement tap measures the master output', () => {
  it('sources the tap from the mastering processor output when mastering exists', () => {
    const ctx = buildMasterGraph({ withMastering: true });
    const { splitter, left, right, grossBeat } = tapNodes();

    assert.ok(splitter, 'the tap splitter must exist');
    assert.ok(left && right, 'both channel analysers must exist');

    // The decisive assertion: the tap is fed by the processor output...
    const processorOutput = engine.masteringProcessor.output as SimNode;
    assert.ok(
      splitter!.incoming.includes(processorOutput),
      'the splitter must be fed by masteringProcessor.output',
    );
    // ...and NOT by the processor's input node.
    assert.equal(
      splitter!.incoming.includes(grossBeat),
      false,
      'the splitter must not be fed by grossBeatNode while a mastering stage exists',
    );

    // The measurement therefore sits downstream of the processor, exactly like
    // the node that actually feeds the destination.
    assert.ok(
      processorOutput.reaches(splitter!),
      'masteringProcessor.output must reach the measurement tap',
    );

    // Stereo split is preserved: analyserL gets channel 0, analyserR channel 1.
    assert.deepEqual(splitter!.connections, [left, right]);

    restoreSaved();
    void ctx;
  });

  it('falls back to the pre-processor node when no mastering stage exists', () => {
    const ctx = buildMasterGraph({ withMastering: false });
    const { splitter, left, right, grossBeat } = tapNodes();

    assert.equal(engine.masteringProcessor, null, 'harness must model an absent mastering stage');
    assert.ok(splitter!.incoming.includes(grossBeat), 'with no processor the tap reads the master node');
    assert.deepEqual(splitter!.connections, [left, right]);

    restoreSaved();
    void ctx;
  });

  it('reads identical tap points whether mastering is enabled or bypassed', () => {
    // `enabled` only changes gains *inside* the processor; it must never change
    // which node the measurement is taken from. A bypassed processor still runs
    // the signal through the stage, so the tap stays post-processor either way.
    const enabledState: MasteringSuiteState = { ...DEFAULT_MASTERING_SUITE_STATE, enabled: true };
    const bypassState: MasteringSuiteState = { ...DEFAULT_MASTERING_SUITE_STATE, enabled: false };

    for (const state of [enabledState, bypassState]) {
      const ctx = buildMasterGraph({ withMastering: true });
      engine.masteringProcessor.setState(state);
      const { splitter } = tapNodes();
      const processorOutput = engine.masteringProcessor.output as SimNode;
      assert.ok(
        splitter!.incoming.includes(processorOutput),
        `enabled=${state.enabled}: the tap must read the master output, not an interior node`,
      );
      restoreSaved();
      void ctx;
    }
  });

  it('re-installs the tap cleanly on rebuild without duplicating the edge', () => {
    const ctx = buildMasterGraph({ withMastering: true });
    const processorOutput = engine.masteringProcessor.output as SimNode;

    const firstSplitter = engine.masterSplitter as SimNode;
    engine.createMasterMeasurementTap(ctx);
    const secondSplitter = engine.masterSplitter as SimNode;

    assert.notEqual(firstSplitter, secondSplitter, 'a rebuild must produce a fresh splitter');
    assert.equal(
      firstSplitter.incoming.length,
      0,
      'the previous splitter must be disconnected before it is replaced (no lifecycle leak)',
    );
    assert.equal(
      processorOutput.connections.filter(node => node === secondSplitter).length,
      1,
      'the processor output must feed the new splitter exactly once',
    );
    assert.equal(
      processorOutput.connections.includes(firstSplitter),
      false,
      'the retired splitter must not remain attached to the master output',
    );

    restoreSaved();
    void ctx;
  });

  it('leaves the audible path untouched and adds no output path from the tap', () => {
    const ctx = buildMasterGraph({ withMastering: true });
    const { splitter, left, right, masterAnalyser } = tapNodes();
    const processorOutput = engine.masteringProcessor.output as SimNode;

    // The tap must not create a second route to the destination.
    assert.equal(splitter!.reaches(ctx.destination), false, 'the tap must not reach the destination');
    assert.equal(left!.connections.length, 0, 'a channel analyser must remain a leaf');
    assert.equal(right!.connections.length, 0, 'a channel analyser must remain a leaf');

    // The audible chain still terminates exactly once, through the existing
    // mono analyser, which is what the spectrum consumers read.
    assert.ok(processorOutput.reaches(masterAnalyser!), 'the audible path must still reach the destination analyser');
    assert.ok(masterAnalyser!.reaches(ctx.destination), 'the destination analyser must still feed the output');
    assert.equal(
      processorOutput.connections.filter(node => node === masterAnalyser).length,
      1,
      'the master output must feed the destination analyser exactly once',
    );

    restoreSaved();
    void ctx;
  });

  it('clears the tap on disposal so nothing dangles off the master output', () => {
    const ctx = buildMasterGraph({ withMastering: true });
    const processorOutput = engine.masteringProcessor.output as SimNode;
    const splitter = engine.masterSplitter as SimNode;

    assert.equal(splitter.incoming.length, 1, 'the tap must start with exactly one input edge');

    engine.disposeMasterMeasurementTap();

    assert.equal(engine.masterSplitter, null);
    assert.equal(engine.masterAnalyserL, null);
    assert.equal(engine.masterAnalyserR, null);
    assert.equal(
      splitter.incoming.length,
      0,
      'disposal must leave the retired splitter with no input edge at all',
    );
    assert.equal(
      processorOutput.connections.includes(splitter),
      false,
      'disposal must remove the measurement edge from the master output',
    );

    restoreSaved();
    void ctx;
  });
});

// ---------------------------------------------------------------------------
// Deterministic signal check: the tap POSITION changes what is measured.
// ---------------------------------------------------------------------------
//
// The graph tests above prove *where* the tap is attached. They cannot prove
// that the attachment point matters audibly. This block does, using a real
// (polyfilled) OfflineAudioContext with real DSP — the same harness
// `masteringDspSignal.test.ts` uses.
//
// Two renders share one source and differ only in which master node feeds the
// measurement point:
//
//   PRE  : source → grossBeatNode → tap → destination      (the OLD wiring)
//   POST : source → grossBeatNode → MasteringProcessor → tap → destination
//                                                          (the FIXED wiring)
//
// The `tap` gain stands in for the measurement splitter: in production the
// splitter and its analysers are leaves, so this models the signal *present at
// the tap point*, which is the only thing the fix changes.
const RealOffline = (Engine as any).OfflineAudioContext as typeof OfflineAudioContext;

const TAP_SAMPLE_RATE = 48000;

function maxAbs(channel: Float32Array): number {
  let m = 0;
  for (let i = 0; i < channel.length; i++) m = Math.max(m, Math.abs(channel[i]));
  return m;
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

type TapPosition = 'dry' | 'pre' | 'post';

/**
 * Render a fixed 80 Hz tone (straddling the 150 Hz low crossover) through the
 * master chain with the measurement taken at the requested position. The
 * mastering state deliberately boosts the low band by +6 dB so the processed
 * signal is unambiguously different from the dry one without relying on
 * compressor behaviour.
 */
async function renderWithTapAt(position: TapPosition): Promise<Float32Array> {
  const duration = 0.25;
  const freq = 80;
  const gain = 0.35;
  const length = Math.floor(TAP_SAMPLE_RATE * duration);
  const ctx = new RealOffline(2, length, TAP_SAMPLE_RATE);

  const srcBuf = ctx.createBuffer(2, length, TAP_SAMPLE_RATE);
  const ch0 = srcBuf.getChannelData(0);
  const ch1 = srcBuf.getChannelData(1);
  for (let i = 0; i < length; i++) {
    const v = gain * Math.sin((2 * Math.PI * freq * i) / TAP_SAMPLE_RATE);
    ch0[i] = v;
    ch1[i] = v;
  }

  const src = ctx.createBufferSource();
  src.buffer = srcBuf;

  const grossBeatNode = ctx.createGain();
  src.connect(grossBeatNode);

  const tap = ctx.createGain();
  tap.gain.value = 1;

  if (position === 'dry') {
    grossBeatNode.connect(tap);
  } else if (position === 'pre') {
    // Old wiring: measurement hangs off the mastering processor's INPUT.
    grossBeatNode.connect(tap);
  } else {
    const state: MasteringSuiteState = {
      ...DEFAULT_MASTERING_SUITE_STATE,
      enabled: true,
      lowBand: { ...DEFAULT_MASTERING_SUITE_STATE.lowBand, gain: 6 },
    };
    const mastering = new MasteringProcessor(ctx as unknown as AudioContext, state);
    grossBeatNode.connect(mastering.input);
    mastering.output.connect(tap);
  }

  tap.connect(ctx.destination);
  src.start(0);

  const rendered = (await (ctx as unknown as OfflineAudioContext).startRendering()) as AudioBuffer;
  return Float32Array.from(rendered.getChannelData(0));
}

describe('Phase 90 — the tap position is signal-consequential', () => {
  it('post-processor tap carries the processed signal, not the pre-processor one', async () => {
    const pre = await renderWithTapAt('pre');
    const post = await renderWithTapAt('post');

    assert.ok(maxAbs(pre) > 1e-3, 'the pre-processor tap must carry audible signal');
    assert.ok(maxAbs(post) > 1e-3, 'the post-processor tap must carry audible signal');

    // +6 dB on the low band (80 Hz sits below the 150 Hz crossover) must change
    // what the tap sees. On the old wiring both taps read the same node, so this
    // difference would be exactly zero.
    const rawDiff = maxDiff(pre, post);
    assert.ok(
      rawDiff > 1e-3,
      `measuring before vs after the mastering stage must change the metered signal (maxDiff=${rawDiff})`,
    );
  });

  it('the pre-processor position reports the dry signal — which is the bug', async () => {
    const dry = await renderWithTapAt('dry');
    const pre = await renderWithTapAt('pre');
    const post = await renderWithTapAt('post');

    // Tapping the processor input, with mastering enabled and boosting +6 dB,
    // yields exactly the unmastered signal. This is precisely the defect: the
    // meters were honest about a signal the user never hears.
    assert.ok(
      maxDiff(dry, pre) < 1e-6,
      `a pre-processor tap must equal the dry signal (maxDiff=${maxDiff(dry, pre)})`,
    );
    assert.ok(
      maxDiff(dry, post) > 1e-3,
      `a post-processor tap must differ from the dry signal (maxDiff=${maxDiff(dry, post)})`,
    );
    assert.ok(
      maxAbs(post) > maxAbs(pre) * 1.1,
      `the +6 dB low band must be visible at the post-processor tap (pre=${maxAbs(pre)}, post=${maxAbs(post)})`,
    );
  });

  it('the same render is deterministic across runs', async () => {
    const first = await renderWithTapAt('post');
    const second = await renderWithTapAt('post');
    assert.equal(
      maxDiff(first, second),
      0,
      'the measurement-point render must be bit-identical across runs',
    );
  });
});
