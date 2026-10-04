/**
 * Phase 64 — F1: Swing unit contract.
 *
 * `ProjectMetadata.swing` is a 0..1 fraction owned by the project document
 * (`types/daw.ts`), the Channel Rack slider tops out at 0.5 and labels that
 * value "100 %" (`ChannelRack.tsx`), and `AudioEngine` historically read the
 * value as if it were already 0..100 — a 100x under-scaling that made the swing
 * control inaudible (0.25 ms instead of 25 ms of displacement at 120 BPM).
 *
 * These tests assert the *behavioural magnitude* of the groove offset through
 * the real scheduler entry points: the live transport callback and the offline
 * timeline renderer. A source-shape assertion cannot catch a unit bug.
 *
 * Harness note: `playNote` is replaced with a recorder so the scheduler's
 * scheduling decisions are observable without synthesising voices. Everything
 * else (graph construction, mute/solo gating, loop resolution, swing maths) is
 * real production code.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import { swingOffsetSecondsForStep } from './parameterScaling';
import type { Channel, MixerTrack, PlaylistClip } from '../types/daw';

const SAMPLE_RATE = 8000;
const BPM = 120;
const SECONDS_PER_STEP = (60 / BPM) / 4;

/** Project swing at the Channel Rack slider maximum — displayed as "100 %". */
const PROJECT_SWING_MAX = 0.5;

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

class SimParam {
  value: number;
  constructor(initial: number) {
    this.value = initial;
  }
  setValueAtTime(value: number): void {
    this.value = value;
  }
  setTargetAtTime(value: number): void {
    this.value = value;
  }
  linearRampToValueAtTime(value: number): void {
    this.value = value;
  }
  exponentialRampToValueAtTime(value: number): void {
    this.value = value;
  }
  cancelScheduledValues(): void {}
}

class SimNode {
  readonly connections: SimNode[] = [];
  readonly gain = new SimParam(1);
  readonly pan = new SimParam(0);
  readonly frequency = new SimParam(440);
  readonly detune = new SimParam(0);
  readonly Q = new SimParam(1);
  readonly startTimes: number[] = [];

  constructor(readonly kind: string) {}

  connect(target: SimNode): SimNode {
    if (target instanceof SimNode && !this.connections.includes(target)) {
      this.connections.push(target);
    }
    return target;
  }

  disconnect(target?: SimNode): void {
    if (!target) {
      this.connections.length = 0;
      return;
    }
    const index = this.connections.indexOf(target);
    if (index >= 0) this.connections.splice(index, 1);
  }

  start(when = 0): void {
    this.startTimes.push(when);
  }
  stop(): void {}
  setPeriodicWave(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

class SimAudioBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(channel: number): Float32Array {
    return this.channels[channel] ?? this.channels[0];
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
  createOscillator(): SimNode { return this.track('oscillator'); }
  createBiquadFilter(): SimNode { return this.track('filter'); }
  createBuffer(channels: number, length: number, sampleRate: number): SimAudioBuffer {
    return new SimAudioBuffer(channels, length, sampleRate);
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  async startRendering(): Promise<SimAudioBuffer> {
    return new SimAudioBuffer(2, this.length, this.sampleRate);
  }
}

function makeChannel(id: string, overrides: Partial<Channel> = {}): Channel {
  const steps = new Array(16).fill(false);
  steps[1] = true;
  return {
    id,
    name: id,
    color: '#00e5ff',
    instrumentType: 'minisynth',
    volume: 0.8,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps,
    notes: [],
    synthParams: audioEngine.getDefaultSynthParams(),
    mixerTrackId: 1,
    ...overrides,
  };
}

function makeMixerTracks(): MixerTrack[] {
  return [0, 1].map(id => ({
    id,
    name: id === 0 ? 'Master' : 'Insert 1',
    color: '#fff',
    volume: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1,
    peakL: 0,
    peakR: 0,
    fxSlots: [],
  }));
}

const SAVED_FIELDS = [
  'ctx', 'masterGain', 'grossBeatNode', 'masterAnalyser', 'mixerChannels', 'channelPanners',
  'mixerRoutingAdapter', 'mixerRoutingChannelMap', 'activeVoices', 'activeClipSources',
  'playlistLaneMutes', 'isPlaying', 'isOfflineRendering', 'transport', 'swing', 'bpm',
  'activeChannels', 'activeClips', 'activeMixerTracks', 'playbackProjectChannels',
  'playbackProjectMixerTracks', 'activePlayMode', 'activePatternLengthSteps', 'playNote',
] as const;

const savedState: Record<string, unknown> = {};
let realOfflineAudioContext: unknown;

/** Scheduler entry point: `playNote` is recorded, never synthesised. */
let noteStarts: number[] = [];

function setupLiveGraph(): SimAudioContext {
  const ctx = new SimAudioContext();
  engine.ctx = ctx;
  engine.masterGain = ctx.createGain();
  engine.grossBeatNode = ctx.createGain();
  engine.masterAnalyser = ctx.createAnalyser();
  engine.masterGain.connect(engine.grossBeatNode);
  engine.grossBeatNode.connect(engine.masterAnalyser);
  engine.masterAnalyser.connect(ctx.destination);
  engine.mixerChannels = new Map();
  engine.channelPanners = new Map();
  engine.mixerRoutingAdapter = null;
  engine.mixerRoutingChannelMap = null;
  engine.activeVoices = new Map();
  engine.activeClipSources = new Set();
  engine.playlistLaneMutes = new Set();
  engine.isPlaying = false;
  engine.isOfflineRendering = false;
  engine.bpm = BPM;
  engine.playNote = (channel: Channel, note: { start?: number }, startTime?: number) => {
    noteStarts.push(startTime ?? Number.NaN);
  };
  return ctx;
}

/** Minimal transport double: `play()` installs its scheduler callbacks here. */
function attachFakeTransport() {
  let callbacks: { onStep?: (step: number, bar: number, audioTime: number) => void } | null = null;
  engine.transport = {
    setBpm: () => undefined,
    setMode: () => undefined,
    setPatternLoopSteps: () => undefined,
    setSongEndSteps: () => undefined,
    setCallbacks: (next: typeof callbacks) => { callbacks = next; },
    start: () => undefined,
    stop: () => undefined,
    pause: () => undefined,
    seek: () => undefined,
    getState: () => ({
      bpm: BPM, beatsPerBar: 4, stepsPerBeat: 4, mode: 'pat', playing: true,
      positionSeconds: 0, step: 0, bar: 1,
    }),
  };
  return {
    emitStep: (step: number, bar: number, audioTime: number) => callbacks?.onStep?.(step, bar, audioTime),
  };
}

beforeEach(() => {
  for (const field of SAVED_FIELDS) savedState[field] = engine[field];
  noteStarts = [];
  realOfflineAudioContext = (globalThis as any).OfflineAudioContext;
  (globalThis as any).OfflineAudioContext = SimAudioContext;
  (globalThis as any).window = { AudioContext: SimAudioContext, OfflineAudioContext: SimAudioContext };
});

afterEach(() => {
  for (const field of SAVED_FIELDS) engine[field] = savedState[field];
  (globalThis as any).OfflineAudioContext = realOfflineAudioContext;
  (globalThis as any).window = undefined;
});

const channel = makeChannel('ch-swing');

describe('Phase 64 F1 — swing magnitude reaches the live scheduler', () => {
  it('displaces an off-beat 16th by 40% of a step at the slider maximum', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();

    // Neutral take first, exactly as App.tsx wires `meta.swing` into the engine.
    audioEngine.setSwing(0);
    audioEngine.play([channel], [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, []);
    noteStarts = [];
    transport.emitStep(1, 1, 10);
    assert.equal(noteStarts.length, 1, 'step 1 must trigger exactly one voice');
    const neutralStart = noteStarts[0];

    // Same take with the project's maximum swing ("100 %" in the Channel Rack).
    audioEngine.setSwing(PROJECT_SWING_MAX);
    audioEngine.play([channel], [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, []);
    noteStarts = [];
    transport.emitStep(1, 1, 10);
    assert.equal(noteStarts.length, 1);
    const swungStart = noteStarts[0];

    const displacement = swungStart - neutralStart;
    assert.ok(
      Math.abs(displacement - 0.4 * SECONDS_PER_STEP) < 1e-9,
      `expected ${0.4 * SECONDS_PER_STEP}s of swing displacement, measured ${displacement}s`,
    );
  });

  it('leaves even steps on the grid at every swing setting', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.setSwing(PROJECT_SWING_MAX);
    audioEngine.play(
      [makeChannel('ch-swing', { steps: [true, ...new Array(15).fill(false)] })],
      [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, [],
    );
    noteStarts = [];
    transport.emitStep(0, 1, 4);
    assert.deepEqual(noteStarts, [4], 'downbeats are never swung');
  });

  it('clamps and sanitises the project swing value', () => {
    setupLiveGraph();
    audioEngine.setSwing(Number.NaN);
    assert.equal(engine.swing, 0, 'non-finite swing is silent');
    audioEngine.setSwing(-1);
    assert.equal(engine.swing, 0);
    audioEngine.setSwing(50);
    assert.equal(engine.swing, PROJECT_SWING_MAX, 'out-of-range swing saturates at full scale');
  });
});

describe('Phase 64 F1 — swing magnitude reaches the offline renderer', () => {
  it('applies the identical displacement when rendering the pattern loop', async () => {
    const renderStepOneStart = async (swing: number): Promise<number> => {
      setupLiveGraph();
      audioEngine.setSwing(swing);
      noteStarts = [];
      await audioEngine.renderTimelineOffline(
        [channel], [] as PlaylistClip[], [] as MixerTrack[], BPM, 4,
        undefined, false, 'pattern', undefined, 16,
      );
      assert.equal(noteStarts.length, 4, 'a 4-bar loop repeats the 16-step pattern 4 times');
      return noteStarts[0];
    };

    const neutral = await renderStepOneStart(0);
    const swung = await renderStepOneStart(PROJECT_SWING_MAX);
    const displacement = swung - neutral;
    assert.ok(
      Math.abs(displacement - 0.4 * SECONDS_PER_STEP) < 1e-9,
      `offline render must swing by the same amount, measured ${displacement}s`,
    );
  });

  it('keeps live and offline in exact agreement at the same swing value', async () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.setSwing(PROJECT_SWING_MAX);
    audioEngine.play([channel], [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, []);
    noteStarts = [];
    // Step 1's grid position, exactly as the transport would report it.
    transport.emitStep(1, 1, SECONDS_PER_STEP);
    const liveOffset = noteStarts[0];

    setupLiveGraph();
    audioEngine.setSwing(PROJECT_SWING_MAX);
    noteStarts = [];
    await audioEngine.renderTimelineOffline(
      [channel], [] as PlaylistClip[], [] as MixerTrack[], BPM, 4,
      undefined, false, 'pattern', undefined, 16,
    );
    const offlineOffset = noteStarts[0];

    assert.ok(
      Math.abs(liveOffset - offlineOffset) < 1e-9,
      `live ${liveOffset}s and offline ${offlineOffset}s must agree`,
    );
  });
});

describe('Phase 64 F1 — one shared swing conversion', () => {
  it('derives the offset from the project fraction, not a raw 0..100 value', () => {
    assert.equal(swingOffsetSecondsForStep(0, SECONDS_PER_STEP), 0);
    assert.equal(
      swingOffsetSecondsForStep(PROJECT_SWING_MAX, SECONDS_PER_STEP),
      0.4 * SECONDS_PER_STEP,
    );
    assert.equal(
      swingOffsetSecondsForStep(PROJECT_SWING_MAX / 2, SECONDS_PER_STEP),
      0.2 * SECONDS_PER_STEP,
    );
    // The Channel Rack readout labels 0..0.5 as 0..100 %; a value beyond full
    // scale saturates instead of over-swinging.
    assert.equal(
      swingOffsetSecondsForStep(1, SECONDS_PER_STEP),
      0.4 * SECONDS_PER_STEP,
    );
    assert.equal(swingOffsetSecondsForStep(Number.NaN, SECONDS_PER_STEP), 0);
  });
});
