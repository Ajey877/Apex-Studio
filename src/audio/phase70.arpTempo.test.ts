/**
 * Phase 70 — F1: the arpeggiator's Step Rate must follow the project tempo.
 *
 * `ArpeggiatorModal` labels the control "Step Rate (Grid Division)" with
 * musical divisions (1/4 … 1/16t), so the spacing between arp voices is a
 * function of the project tempo. `AudioEngine.playNote` forwards its `bpm`
 * argument to `playArpSequence`, and the modal audition / hardware MIDI input
 * both pass the project tempo — but the sequencer's `triggerCurrentStep` used
 * to call `playNote` without it, so the arp was spaced on `playNote`'s 120 BPM
 * default in live playback and in every offline render.
 *
 * These tests observe the *scheduled voice onsets* through the real scheduler
 * (live transport callback and `renderTimelineOffline`). Only `playSingleVoice`
 * is replaced with a recorder so the scheduling decision — which is the
 * subject — is observable without synthesising instruments; everything else
 * (step grid, arp sequence construction, rate maths, swing, clip windows) is
 * real production code.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import { MidiNoteInputRuntime } from './midiMappingRuntime';
import { createDefaultProjectState } from '../state/projectState';
import type { ArpSettings, Channel, MixerTrack, Note, PlaylistClip, PlaylistTrack } from '../types/daw';

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const SAMPLE_RATE = 8000;

/** 1/16 at `bpm` — the division the default arp rate resolves to. */
const gridSeconds = (bpm: number, division: number): number => (60 / bpm) / division;

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
    if (!target) { this.connections.length = 0; return; }
    const index = this.connections.indexOf(target);
    if (index >= 0) this.connections.splice(index, 1);
  }

  start(when = 0): void { this.startTimes.push(when); }
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
  getChannelData(channel: number): Float32Array { return this.channels[channel] ?? this.channels[0]; }
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
  resume(): Promise<void> { return Promise.resolve(); }
  async startRendering(): Promise<SimAudioBuffer> { return new SimAudioBuffer(2, this.length, this.sampleRate); }
}

interface RecordedVoice { pitch: number; time: number; duration: number; }

let voices: RecordedVoice[] = [];

const makeArpChannel = (overrides: Partial<Channel> = {}, arpOverrides: Partial<ArpSettings> = {}): Channel => {
  const steps = new Array(16).fill(false);
  steps[1] = true;
  return {
    id: 'ch-arp',
    name: 'ARP',
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
    arp: {
      enabled: true,
      mode: 'up',
      rate: '1/16',
      octaves: 2,
      gate: 0.8,
      swing: 0,
      strumMs: 0,
      euclideanSteps: 16,
      euclideanHits: 4,
      euclideanRotate: 0,
      ...arpOverrides,
    },
    ...overrides,
  };
};

const makeMixerTracks = (): MixerTrack[] => [0, 1].map(id => ({
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

const makeLanes = (): PlaylistTrack[] => [{
  id: 1, name: 'Lane 1', color: '#fff', volume: 0.9, pan: 0, mute: false, solo: false,
}];

const patternClip = (channelId: string): PlaylistClip => ({
  id: 'clip-arp',
  trackIndex: 0,
  startBar: 0,
  lengthBars: 2,
  type: 'pattern',
  channelId,
  color: '#ff6e00',
  name: 'ARP Block',
});

const SAVED_FIELDS = [
  'ctx', 'masterGain', 'grossBeatNode', 'masterAnalyser', 'mixerChannels', 'channelPanners',
  'mixerRoutingAdapter', 'mixerRoutingChannelMap', 'activeVoices', 'activeClipSources',
  'playlistLaneMutes', 'isPlaying', 'isOfflineRendering', 'transport', 'swing', 'bpm',
  'activeChannels', 'activeClips', 'activeMixerTracks', 'playbackProjectChannels',
  'playbackProjectMixerTracks', 'activePlayMode', 'activePatternLengthSteps', 'playSingleVoice',
] as const;

const savedState: Record<string, unknown> = {};
let realOfflineAudioContext: unknown;

/** Live graph with a recording `playSingleVoice`; the real scheduler stays intact. */
function setupLiveGraph(bpm: number): SimAudioContext {
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
  engine.swing = 0;
  engine.bpm = bpm;
  engine.playSingleVoice = (
    _channel: Channel,
    note: Note,
    time: number,
  ) => {
    voices.push({ pitch: note.pitch, time, duration: note.duration ?? Number.NaN });
  };
  return ctx;
}

/** Minimal transport double: `play()` installs its scheduler callbacks here. */
function attachFakeTransport(bpm: number) {
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
      bpm, beatsPerBar: 4, stepsPerBeat: 4, mode: 'pat', playing: true,
      positionSeconds: 0, step: 0, bar: 1,
    }),
  };
  return {
    emitStep: (step: number, bar: number, audioTime: number) => callbacks?.onStep?.(step, bar, audioTime),
  };
}

beforeEach(() => {
  for (const field of SAVED_FIELDS) savedState[field] = engine[field];
  voices = [];
  realOfflineAudioContext = (globalThis as any).OfflineAudioContext;
  (globalThis as any).OfflineAudioContext = SimAudioContext;
  (globalThis as any).window = { AudioContext: SimAudioContext, OfflineAudioContext: SimAudioContext };
});

afterEach(() => {
  for (const field of SAVED_FIELDS) engine[field] = savedState[field];
  (globalThis as any).OfflineAudioContext = realOfflineAudioContext;
  (globalThis as any).window = undefined;
});

/** Play one Pattern-Mode step through the real transport callback. */
function emitPatternStep(bpm: number, channel: Channel, step = 1, bar = 1, audioTime = 10): RecordedVoice[] {
  setupLiveGraph(bpm);
  const transport = attachFakeTransport(bpm);
  audioEngine.play([channel], [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, []);
  voices = [];
  transport.emitStep(step, bar, audioTime);
  return voices;
}

/** Play one Song-Mode step through the real transport callback. */
function emitSongStep(bpm: number, channel: Channel, step = 1, bar = 1, audioTime = 10): RecordedVoice[] {
  setupLiveGraph(bpm);
  const transport = attachFakeTransport(bpm);
  const clip = patternClip(channel.id);
  audioEngine.play([channel], [clip], 'song', undefined, makeMixerTracks(), undefined, makeLanes());
  voices = [];
  transport.emitStep(step, bar, audioTime);
  return voices;
}

const gaps = (recorded: RecordedVoice[]): number[] =>
  recorded.slice(1).map((voice, index) => voice.time - recorded[index].time);

const assertSpacing = (recorded: RecordedVoice[], expected: number, label: string): void => {
  assert.ok(recorded.length >= 2, `${label}: expected more than one arp voice, saw ${recorded.length}`);
  for (const gap of gaps(recorded)) {
    assert.ok(
      Math.abs(gap - expected) < 1e-9,
      `${label}: expected ${expected}s between arp voices, saw ${gap}s (voices: ${recorded.map(v => v.time).join(', ')})`,
    );
  }
};

describe('Phase 70 F1 — Pattern Mode arp Step Rate follows the project tempo', () => {
  it('spaces 1/16 arp voices at 60 BPM by 0.25s (not the 120 BPM default)', () => {
    const recorded = emitPatternStep(60, makeArpChannel(), 1, 1, 10);
    assert.equal(recorded.length, 16, 'mode "up" with 2 octaves schedules 16 voices');
    assert.equal(recorded[0].time, 10, 'voice 0 stays on the step boundary');
    assertSpacing(recorded, gridSeconds(60, 4), '60 BPM pattern');
  });

  it('spaces 1/16 arp voices at 120 BPM by 0.125s', () => {
    const recorded = emitPatternStep(120, makeArpChannel(), 1, 1, 10);
    assertSpacing(recorded, gridSeconds(120, 4), '120 BPM pattern');
  });

  it('spaces 1/16 arp voices at 180 BPM by ~0.083333s', () => {
    const recorded = emitPatternStep(180, makeArpChannel(), 1, 1, 10);
    assertSpacing(recorded, gridSeconds(180, 4), '180 BPM pattern');
  });

  it('derives every Step Rate division from the project tempo', () => {
    const cases: Array<[ArpSettings['rate'], number]> = [
      ['1/4', 1],
      ['1/8', 2],
      ['1/16', 4],
      ['1/32', 8],
      ['1/8t', 2 * (3 / 2)],
      ['1/16t', 4 * (3 / 2)],
    ];
    for (const [rate, division] of cases) {
      const channel = makeArpChannel({}, { rate });
      const recorded = emitPatternStep(90, channel, 1, 1, 10);
      assertSpacing(recorded, gridSeconds(90, division), `90 BPM pattern rate ${rate}`);
    }
  });

  it('keeps voice durations in sixteenth-note STEPS, scaled by the gate only', () => {
    // Phase 1B rewrite. This test previously pinned the defect: it asserted
    // `voice.duration === gridSeconds(60, 4) * 0.5`, i.e. SECONDS stored in
    // `Note.duration`. The corrected contract is that `Note.duration` is
    // sixteenth-note steps, so the gate is a proportion of the rate's step
    // length and is tempo-INDEPENDENT — the renderer converts steps→seconds
    // with the project BPM downstream.
    const recorded = emitPatternStep(60, makeArpChannel({}, { gate: 0.5 }), 1, 1, 10);
    // Default rate 1/16 = 1 step; gate 0.5 ⇒ 0.5 steps.
    const expectedSteps = 1 * 0.5;
    for (const voice of recorded) {
      assert.ok(
        Math.abs(voice.duration - expectedSteps) < 1e-9,
        `expected gate-scaled duration ${expectedSteps} steps, saw ${voice.duration}`,
      );
    }
    // The same musical gate must yield the same STEP duration at every tempo:
    // only the derived seconds change. This is the assertion the old seconds-
    // valued expectation could never make.
    for (const bpm of [60, 120, 180]) {
      const atTempo = emitPatternStep(bpm, makeArpChannel({}, { gate: 0.5 }), 1, 1, 10);
      for (const voice of atTempo) {
        assert.ok(
          Math.abs(voice.duration - expectedSteps) < 1e-9,
          `arp Note.duration must stay ${expectedSteps} steps at ${bpm} BPM, saw ${voice.duration}`,
        );
      }
    }
  });
});

describe('Phase 70 F1 — Song Mode arp Step Rate follows the project tempo', () => {
  it('spaces the arp of a playlist pattern clip by the project tempo', () => {
    const channel = makeArpChannel();
    const recorded = emitSongStep(60, channel, 1, 1, 10);
    assert.equal(recorded.length, 16, 'the clip must trigger the same 16 voices');
    assert.equal(recorded[0].time, 10, 'voice 0 stays on the step boundary');
    assertSpacing(recorded, gridSeconds(60, 4), '60 BPM song');
  });
});

describe('Phase 70 F1 — offline renders use the same arp tempo as playback', () => {
  it('renders 1/16 arp voices at the project tempo (60 and 180 BPM)', async () => {
    for (const bpm of [60, 180]) {
      const stepSeconds = (60 / bpm) / 4;

      setupLiveGraph(bpm);
      voices = [];
      await audioEngine.renderTimelineOffline(
        [makeArpChannel()], [] as PlaylistClip[], [] as MixerTrack[], bpm, 4, undefined, false, 'pattern', undefined, 16,
      );
      const offline = [...voices];
      assert.ok(offline.length > 2, `offline render at ${bpm} BPM must schedule arp voices`);

      const onGrid = Math.min(offline[0].time % stepSeconds, stepSeconds - (offline[0].time % stepSeconds));
      assert.ok(onGrid < 1e-9, `the first offline arp voice must sit on the project step grid (saw ${offline[0].time}s, step ${stepSeconds}s)`);
      assertSpacing(offline, gridSeconds(bpm, 4), `offline render at ${bpm} BPM`);

      // The export must place voices exactly where the live take did.
      const live = emitPatternStep(bpm, makeArpChannel(), 1, 1, offline[0].time);
      assertSpacing(live, gridSeconds(bpm, 4), `live pattern at ${bpm} BPM`);
      assert.deepEqual(
        live.map(voice => voice.time),
        offline.slice(0, live.length).map(voice => voice.time),
        `offline and live arp onsets must agree at ${bpm} BPM`,
      );
    }
  });
});

describe('Phase 70 F1 — non-sequencer arp entry points keep passing the project tempo', () => {
  it('keeps the Arpeggiator modal audition on the project tempo', () => {
    setupLiveGraph(60);
    voices = [];
    audioEngine.playNote(
      makeArpChannel(),
      { id: 'audition', pitch: 60, start: 0, duration: 1, velocity: 0.9 },
      5,
      60,
    );
    assert.equal(voices[0].time, 5);
    assertSpacing(voices, gridSeconds(60, 4), 'modal audition at 60 BPM');
  });

  it('keeps hardware MIDI input on the project tempo', () => {
    const channel = makeArpChannel();
    setupLiveGraph(60);
    voices = [];
    const state = {
      ...createDefaultProjectState(),
      meta: { ...createDefaultProjectState().meta, bpm: 60 },
      channels: [channel],
      selectedChannelId: channel.id,
    };
    const runtime = new MidiNoteInputRuntime({
      getProjectState: () => state,
      getSelectedChannelId: () => channel.id,
      playNote: (targetChannel: Channel, note: Note, startTime?: number, bpm?: number, midiChannel?: number) =>
        engine.playNote(targetChannel, note, startTime, bpm, midiChannel),
      stopChannelNote: () => 0,
    });

    runtime.handleMidiEvent({ type: 'noteOn', note: 60, velocity: 0.8, midiChannel: 1 });
    assert.ok(voices.length >= 2, 'MIDI note-on must reach the arp');
    assertSpacing(voices, gridSeconds(60, 4), 'hardware MIDI input at 60 BPM');
  });
});

describe('Phase 70 F1 — arp sequence, euclidean and fallback behaviour stay unchanged', () => {
  it('keeps the ascending chord-tone sequence and the 16-voice cap', () => {
    const recorded = emitPatternStep(120, makeArpChannel(), 1, 1, 10);
    assert.deepEqual(
      recorded.map(voice => voice.pitch),
      [60, 63, 67, 70, 72, 75, 79, 82, 60, 63, 67, 70, 72, 75, 79, 82],
    );
  });

  it('keeps the euclidean hit positions and their voice order', () => {
    const channel = makeArpChannel({}, { mode: 'euclidean', euclideanSteps: 16, euclideanHits: 4, euclideanRotate: 0 });
    const recorded = emitPatternStep(120, channel, 1, 1, 0);
    const step = gridSeconds(120, 4);
    assert.deepEqual(recorded.map(voice => voice.pitch), [60, 63, 67, 70]);
    assert.deepEqual(
      recorded.map(voice => Number((voice.time / step).toFixed(6))),
      [3, 7, 11, 15],
      'E(4,16) must keep firing on the same steps',
    );
  });

  it('keeps the unknown-rate fallback, the octave default and the gate default', () => {
    const unknownRate = emitPatternStep(120, makeArpChannel({}, { rate: 'not-a-rate' as ArpSettings['rate'] }), 1, 1, 0);
    assertSpacing(unknownRate, gridSeconds(120, 4), 'unknown rate falls back to 1/16');

    const singleOctave = emitPatternStep(120, makeArpChannel({}, { octaves: undefined as unknown as number }), 1, 1, 0);
    assert.deepEqual(singleOctave.map(voice => voice.pitch), [60, 63, 67, 70, 60, 63, 67, 70]);

    const defaultGate = emitPatternStep(120, makeArpChannel({}, { gate: undefined as unknown as number }), 1, 1, 0);
    // Phase 1B: the 0.8 default is preserved, but it now scales the rate's STEP
    // length (1/16 = 1 step) rather than its seconds, so the value is a step
    // count: 1 * 0.8 = 0.8 steps.
    assert.ok(
      Math.abs(defaultGate[0].duration - 1 * 0.8) < 1e-9,
      `an unset gate keeps the historic 0.8 default in steps, saw ${defaultGate[0].duration}`,
    );
  });
});
