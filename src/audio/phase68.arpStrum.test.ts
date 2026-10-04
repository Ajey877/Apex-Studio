/**
 * Phase 68 — F1: the Arpeggiator's "Strum Micro-Delay" reaches voice scheduling.
 *
 * The Arpeggiator modal ships a real, persisted 0-50 ms "Strum Micro-Delay"
 * control (`ArpeggiatorModal.tsx:200-209`, saved into `Channel.arp.strumMs`),
 * but `playArpSequence` scheduled every voice on the arpeggiator's own rate grid
 * and never read the value, so the slider could not move a single onset.
 *
 * These tests drive the production scheduling path — `audioEngine.playNote()`
 * resolves `channel.arp.enabled` and calls `playArpSequence()` — and assert the
 * *times* the voices are scheduled at. Everything between the call and the
 * scheduled voice (mode/rate resolution, chord voicing, gate length, the
 * euclidean branch) is the real engine; only `playSingleVoice` is replaced with
 * a recorder so no audio graph is needed.
 *
 * Harness note: the simulated `AudioContext` and the fake transport mirror
 * `phase64.swing.test.ts`, the suite the live/offline swing contract uses.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import type { ArpSettings, Channel, MixerTrack, PlaylistClip } from '../types/daw';

const SAMPLE_RATE = 8000;
const BPM = 120;
const STEP_SECONDS = (60 / BPM) / 4;

/** `sequence.length * 2` capped at 16: two octaves of the four chord tones. */
const VOICE_COUNT = 16;

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
  'playbackProjectMixerTracks', 'activePlayMode', 'activePatternLengthSteps', 'playNote', 'playSingleVoice',
] as const;

const savedState: Record<string, unknown> = {};
let realOfflineAudioContext: unknown;

/** One scheduled arpeggiator voice; `playSingleVoice` is recorded, never synthesised. */
interface ScheduledVoice {
  channelId: string;
  pitch: number;
  time: number;
}

let scheduledVoices: ScheduledVoice[] = [];

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
  engine.playSingleVoice = (channel: Channel, note: { pitch?: number }, startTime?: number) => {
    scheduledVoices.push({
      channelId: channel.id,
      pitch: note.pitch ?? Number.NaN,
      time: startTime ?? Number.NaN,
    });
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
  scheduledVoices = [];
  realOfflineAudioContext = (globalThis as any).OfflineAudioContext;
  (globalThis as any).OfflineAudioContext = SimAudioContext;
  (globalThis as any).window = { AudioContext: SimAudioContext, OfflineAudioContext: SimAudioContext };
});

afterEach(() => {
  for (const field of SAVED_FIELDS) engine[field] = savedState[field];
  (globalThis as any).OfflineAudioContext = realOfflineAudioContext;
  (globalThis as any).window = undefined;
});

const ARP_BASE: ArpSettings = {
  enabled: true,
  mode: 'up',
  rate: '1/16',
  octaves: 2,
  gate: 0.85,
  swing: 0,
  strumMs: 0,
  euclideanSteps: 16,
  euclideanHits: 4,
  euclideanRotate: 0,
};

const makeArpChannel = (
  strumMs: number,
  arpOverrides: Partial<ArpSettings> = {},
  channelOverrides: Partial<Channel> = {},
): Channel =>
  makeChannel('ch-arp', {
    steps: new Array(16).fill(false),
    notes: [],
    arp: { ...ARP_BASE, strumMs, ...arpOverrides },
    ...channelOverrides,
  });

const stepsAt = (active: number[], length = 16): boolean[] => {
  const steps = new Array(length).fill(false);
  for (const index of active) steps[index] = true;
  return steps;
};

/** Schedules one arpeggiated note through the real `playNote` entry point. */
const scheduleVoices = (
  strumMs: number,
  arpOverrides: Partial<ArpSettings> = {},
  channelOverrides: Partial<Channel> = {},
  startTime = 10,
): number[] => {
  setupLiveGraph();
  scheduledVoices = [];
  audioEngine.playNote(
    makeArpChannel(strumMs, arpOverrides, channelOverrides),
    { id: 'note-1', pitch: 60, start: 0, duration: 2, velocity: 0.9 },
    startTime,
    BPM,
  );
  return scheduledVoices.map(voice => voice.time);
};

const gridTimes = (startTime: number): number[] =>
  Array.from({ length: VOICE_COUNT }, (_, index) => startTime + index * STEP_SECONDS);

describe('Phase 68 F1 — the strum delay reaches the scheduled voices', () => {
  it('keeps the historic rate grid at strumMs = 0', () => {
    // The slider's zero position must not move a single onset: this is the
    // schedule the engine produced before the control had a reader.
    const times = scheduleVoices(0);
    assert.equal(times.length, VOICE_COUNT, 'one voice per sequence position');
    assert.deepEqual(times, gridTimes(10));
  });

  it('delays every successive voice by the configured micro-delay', () => {
    const times = scheduleVoices(50);
    assert.equal(times.length, VOICE_COUNT);
    assert.equal(times[0], 10, 'the first voice is never delayed');
    for (let index = 1; index < times.length; index += 1) {
      const gap = times[index] - times[index - 1];
      assert.ok(
        Math.abs(gap - (STEP_SECONDS + 0.05)) < 1e-9,
        `voice ${index} must follow the previous one by one rate step plus 50 ms, measured ${gap}s`,
      );
    }
  });

  it('changes the schedule when the user changes the slider', () => {
    const none = scheduleVoices(0);
    const some = scheduleVoices(15);
    const max = scheduleVoices(50);

    assert.notDeepEqual(some, none, '15 ms must not schedule like 0 ms');
    assert.notDeepEqual(max, some, '50 ms must not schedule like 15 ms');
    assert.ok(Math.abs((some[1] - none[1]) - 0.015) < 1e-9, '15 ms per voice');
    assert.ok(Math.abs((max[1] - none[1]) - 0.05) < 1e-9, '50 ms per voice');
  });

  it('sanitises a corrupt strum value instead of scheduling voices into the future', () => {
    const none = scheduleVoices(0);
    assert.deepEqual(scheduleVoices(-100), none, 'a negative delay is silent');
    assert.deepEqual(scheduleVoices(Number.NaN), none, 'a non-finite delay is silent');
    assert.deepEqual(scheduleVoices(5000), scheduleVoices(50), 'out-of-range input saturates at the slider maximum');
  });

  it('carries the delay through the euclidean branch as well', () => {
    const euclidean = { mode: 'euclidean' as const };
    const none = scheduleVoices(0, euclidean);
    const max = scheduleVoices(50, euclidean);

    assert.equal(none.length, 4, 'E(4, 16) fires four hits per pass');
    const hitGap = 4 * STEP_SECONDS;
    // The euclidean bucket generator places E(4,16) on steps 3, 7, 11 and 15.
    assert.deepEqual(none, [10 + 3 * STEP_SECONDS, 10 + 7 * STEP_SECONDS, 10 + 11 * STEP_SECONDS, 10 + 15 * STEP_SECONDS]);
    for (let index = 1; index < max.length; index += 1) {
      assert.ok(
        Math.abs((max[index] - max[index - 1]) - (hitGap + 0.05)) < 1e-9,
        `euclidean hit ${index} must carry the same micro-delay`,
      );
    }
  });

  it('gives the offline renderer the same arpeggiator output as live playback', async () => {
    const renderVoices = async (strumMs: number): Promise<number[]> => {
      setupLiveGraph();
      scheduledVoices = [];
      await audioEngine.renderTimelineOffline(
        [makeArpChannel(strumMs, {}, { steps: stepsAt([1]) })],
        [] as PlaylistClip[],
        [] as MixerTrack[],
        BPM,
        4,
        undefined,
        false,
        'pattern',
        undefined,
        16,
      );
      return scheduledVoices.map(voice => voice.time);
    };

    const live = scheduleVoices(50, {}, { steps: stepsAt([1]) });
    const offline = await renderVoices(50);

    assert.equal(offline.length, VOICE_COUNT * 4, 'a four-bar render loops the pattern four times');
    // The render starts at its own zero, so compare the voice-to-voice shape:
    // the first pass of the offline render must match live playback exactly.
    const firstPass = offline.slice(0, VOICE_COUNT);
    const liveShape = live.map(time => time - live[0]);
    const offlineShape = firstPass.map(time => time - firstPass[0]);
    assert.equal(offlineShape.length, liveShape.length);
    liveShape.forEach((liveDelta, index) => {
      // Summation order differs between the two schedulers, so compare the
      // musical offsets with the same tolerance the swing suite uses.
      assert.ok(
        Math.abs(offlineShape[index] - liveDelta) < 1e-9,
        `voice ${index}: live ${liveDelta}s vs offline ${offlineShape[index]}s`,
      );
    });
  });
});
