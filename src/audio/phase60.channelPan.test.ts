/**
 * Phase 60 — Channel Rack Per-Channel Pan (`Channel.pan`) Production Audio Parity.
 *
 * Verifies that `Channel.pan` (-1..+1) reaches the real Web Audio graph and
 * produces audible stereo panning across all 24 production `InstrumentType`s,
 * live playback, offline export (`renderTimelineOffline`), `channel_pan`
 * automation, MIDI CC `channel_pan`, and channel-affiliated audio clips, while
 * preserving independent `Note.pan`, `DrumPad.pan`, and `MixerTrack.pan`.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { audioEngine } from './audioEngine';
import { MidiCcMappingRuntime } from './midiMappingRuntime';
import { createHistory } from '../state/projectHistory';
import { updateChannelInProjectState, updateMixerTrackInProjectState } from '../state/projectMutations';
import { serializeProjectState } from '../state/projectPersistence';
import { createDefaultProjectState, deleteChannelFromProjectState, normalizeProjectState } from '../state/projectState';
import type { Channel, InstrumentType, MixerTrack, Note, PlaylistClip, ProjectState } from '../types/daw';

const SAMPLE_RATE = 8000;
const BPM = 120;

const ALL_INSTRUMENT_TYPES: readonly InstrumentType[] = [
  'minisynth',
  'fmsynth',
  'drumpad',
  'wavetable',
  'sampler',
  'grand_piano',
  'rhodes_epiano',
  'hammond_organ',
  'harpsichord',
  'nylon_guitar',
  'strings_ensemble',
  'pizzicato_strings',
  'cinematic_brass',
  'acid_303',
  'reese_bass',
  'sub_808',
  'slap_bass',
  'supersaw_lead',
  'ambient_pad',
  'vox_choir',
  'marimba_bell',
  'fm_bell',
  'chiptune_8bit',
  'independent_pluck',
] as const;

class FakeAudioParam {
  value: number;
  readonly events: Array<{ type: string; value: number; time: number; timeConstant?: number }> = [];

  constructor(defaultValue = 0) {
    this.value = defaultValue;
  }

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'setValueAtTime', value, time });
  }

  setTargetAtTime(value: number, time: number, timeConstant = 0.02): void {
    this.value = value;
    this.events.push({ type: 'setTargetAtTime', value, time, timeConstant });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'linearRampToValueAtTime', value, time });
  }

  exponentialRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'exponentialRampToValueAtTime', value, time });
  }

  cancelScheduledValues(_time: number): void {}

  valueAt(time: number): number {
    let current = this.events.length > 0 ? this.events[0].value : this.value;
    for (const event of this.events) {
      if (event.time <= time + 1e-9) {
        current = event.value;
      } else {
        break;
      }
    }
    return current;
  }
}

type FakeNodeKind =
  | 'destination'
  | 'gain'
  | 'panner'
  | 'filter'
  | 'analyser'
  | 'bufferSource'
  | 'oscillator';

class FakeAudioBuffer {
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
    fill?: (channel: number, index: number) => number,
  ) {
    this.duration = length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, (_, ch) => {
      const data = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        data[i] = fill ? fill(ch, i) : 0;
      }
      return data;
    });
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel] ?? this.channels[0];
  }

  copyToChannel(source: Float32Array, channel: number): void {
    this.channels[channel]?.set(source.subarray(0, this.length));
  }
}

class FakeNode {
  readonly connections: FakeNode[] = [];
  readonly gain = new FakeAudioParam(1);
  readonly pan = new FakeAudioParam(0);
  readonly frequency = new FakeAudioParam(440);
  readonly detune = new FakeAudioParam(0);
  readonly playbackRate = new FakeAudioParam(1);
  readonly Q = new FakeAudioParam(1);
  type = 'sine';
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  fftSize = 256;
  smoothingTimeConstant = 0.8;
  onended: (() => void) | null = null;
  startTime: number | null = null;
  startOffset = 0;
  startDuration: number | undefined;
  stopTime: number | undefined;
  startCalls = 0;
  stopCalls = 0;
  disconnectCalls = 0;

  constructor(
    readonly context: FakeAudioContext,
    readonly kind: FakeNodeKind,
  ) {}

  connect(destination: unknown): unknown {
    if (destination instanceof FakeNode) {
      this.connections.push(destination);
    }
    return destination;
  }

  disconnect(): void {
    this.disconnectCalls += 1;
    this.connections.length = 0;
  }

  start(time = 0, offset = 0, duration?: number): void {
    this.startCalls += 1;
    this.startTime = time;
    this.startOffset = offset;
    this.startDuration = duration;
  }

  stop(time?: number): void {
    this.stopCalls += 1;
    this.stopTime = time ?? this.context.currentTime;
  }

  addEventListener(_type: string, _listener: () => void): void {}
  getByteTimeDomainData(array: Uint8Array): void { array.fill(128); }
  getByteFrequencyData(array: Uint8Array): void { array.fill(0); }
  getFloatTimeDomainData(array: Float32Array): void { array.fill(0); }
}

/**
 * Deterministic Web Audio graph evaluator implementing the W3C Web Audio API
 * StereoPannerNode stereo/mono panning law so series panners (e.g. DrumPad.pan
 * -> Channel.pan -> MixerTrack.pan) compose accurately.
 */
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];

  readonly destination: FakeNode;
  readonly nodes: FakeNode[] = [];
  currentTime = 0;
  state: AudioContextState = 'running';

  constructor(
    readonly numberOfChannels = 2,
    readonly length = SAMPLE_RATE,
    readonly sampleRate = SAMPLE_RATE,
  ) {
    this.destination = new FakeNode(this, 'destination');
    this.nodes.push(this.destination);
    FakeAudioContext.instances.push(this);
  }

  private createNode(kind: FakeNodeKind): FakeNode {
    const node = new FakeNode(this, kind);
    this.nodes.push(node);
    return node;
  }

  createGain(): FakeNode { return this.createNode('gain'); }
  createStereoPanner(): FakeNode { return this.createNode('panner'); }
  createBiquadFilter(): FakeNode { return this.createNode('filter'); }
  createAnalyser(): FakeNode { return this.createNode('analyser'); }
  createBufferSource(): FakeNode { return this.createNode('bufferSource'); }
  createOscillator(): FakeNode { return this.createNode('oscillator'); }
  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
  async resume(): Promise<void> { this.state = 'running'; }

  renderWindow(durationSeconds = 0.25, startSeconds = 0): FakeAudioBuffer {
    const frameCount = Math.max(1, Math.floor(durationSeconds * this.sampleRate));
    const output = new FakeAudioBuffer(2, frameCount, this.sampleRate);
    const left = output.getChannelData(0);
    const right = output.getChannelData(1);
    const sources = this.nodes.filter(
      node => node.kind === 'oscillator' || node.kind === 'bufferSource',
    );

    for (let i = 0; i < frameCount; i++) {
      const time = startSeconds + i / this.sampleRate;
      let sampleL = 0;
      let sampleR = 0;

      for (const source of sources) {
        if (!this.isSourceConnectedToAudioOutput(source)) continue;
        const val = this.evaluateSource(source, time);
        if (val === 0) continue;
        // Mono source enters its first downstream node with equal L/R signal;
        // W3C StereoPannerNode pans mono/equal-stereo signals via cos/sin.
        const emitted = this.propagate(source, val, val, true, time, new Set<FakeNode>());
        sampleL += emitted.left;
        sampleR += emitted.right;
      }

      left[i] = sampleL;
      right[i] = sampleR;
    }

    return output;
  }

  async startRendering(): Promise<FakeAudioBuffer> {
    const durationSeconds = this.length / this.sampleRate;
    return this.renderWindow(durationSeconds, 0);
  }

  private isSourceConnectedToAudioOutput(source: FakeNode): boolean {
    // Exclude modulation oscillators (LFOs/FM modulators) connected strictly to AudioParams.
    return source.connections.length > 0;
  }

  private evaluateSource(source: FakeNode, time: number): number {
    if (source.startTime === null || time < source.startTime) return 0;
    if (source.stopTime !== undefined && time >= source.stopTime) return 0;
    const elapsed = time - source.startTime;
    if (source.startDuration !== undefined && elapsed >= source.startDuration) return 0;

    if (source.kind === 'oscillator') {
      const freq = Math.max(0, source.frequency.valueAt(time));
      const detune = source.detune.valueAt(time);
      const effectiveFreq = freq * Math.pow(2, detune / 1200);
      const phase = (elapsed * effectiveFreq) % 1;
      switch (source.type) {
        case 'square': return phase < 0.5 ? 1 : -1;
        case 'sawtooth': return 2 * phase - 1;
        case 'triangle': return 1 - 4 * Math.abs(Math.round(phase) - phase);
        default: return Math.sin(phase * Math.PI * 2);
      }
    }

    const buffer = source.buffer;
    if (!buffer || buffer.length === 0) return 0;
    const rate = Math.abs(source.playbackRate.valueAt(time)) || 1;
    const index = Math.floor((source.startOffset + elapsed * rate) * buffer.sampleRate) % buffer.length;
    if (index < 0 || index >= buffer.length) return 0;
    return buffer.getChannelData(0)[index] || 0;
  }

  private propagate(
    node: FakeNode,
    inL: number,
    inR: number,
    isMonoSignal: boolean,
    time: number,
    visited: Set<FakeNode>,
  ): { left: number; right: number } {
    if (visited.has(node)) return { left: 0, right: 0 };
    const nextVisited = new Set(visited);
    nextVisited.add(node);

    let l = inL;
    let r = inR;
    let mono = isMonoSignal;

    if (node.kind === 'gain') {
      const g = node.gain.valueAt(time);
      l *= g;
      r *= g;
    } else if (node.kind === 'panner') {
      const pan = Math.max(-1, Math.min(1, node.pan.valueAt(time)));
      if (mono) {
        const x = (pan + 1) / 2;
        const angle = x * (Math.PI / 2);
        const signal = l;
        l = signal * Math.cos(angle);
        r = signal * Math.sin(angle);
        mono = false;
      } else if (pan <= 0) {
        const x = pan + 1;
        const angle = x * (Math.PI / 2);
        const nextL = l + r * Math.cos(angle);
        const nextR = r * Math.sin(angle);
        l = nextL;
        r = nextR;
      } else {
        const x = pan;
        const angle = x * (Math.PI / 2);
        const nextL = l * Math.cos(angle);
        const nextR = r + l * Math.sin(angle);
        l = nextL;
        r = nextR;
      }
    }

    if (node.kind === 'destination') {
      return { left: l, right: r };
    }

    let outL = 0;
    let outR = 0;
    for (const target of node.connections) {
      const res = this.propagate(target, l, r, mono, time, nextVisited);
      outL += res.left;
      outR += res.right;
    }
    return { left: outL, right: outR };
  }
}

const channelEnergy = (buffer: AudioBuffer | FakeAudioBuffer, channelIndex: number): number => {
  const data = buffer.getChannelData(channelIndex);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
  }
  return sum;
};

const makeSampleBuffer = (durationSeconds = 0.25): FakeAudioBuffer =>
  new FakeAudioBuffer(
    1,
    Math.max(16, Math.floor(SAMPLE_RATE * durationSeconds)),
    SAMPLE_RATE,
    (_ch, i) => Math.sin((i / SAMPLE_RATE) * 220 * Math.PI * 2) * 0.8 + 0.2,
  );

const makeMixerTracks = (track1Pan = 0, track2Pan = 0): MixerTrack[] => [
  {
    id: 0,
    name: 'Master',
    color: '#ffffff',
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    stereoWidth: 1,
    fxSlots: [],
    peakL: 0,
    peakR: 0,
  },
  {
    id: 1,
    name: 'Insert 1',
    color: '#00e5ff',
    volume: 1,
    pan: track1Pan,
    mute: false,
    solo: false,
    stereoWidth: 1,
    fxSlots: [],
    peakL: 0,
    peakR: 0,
    routingTargetId: 0,
  },
  {
    id: 2,
    name: 'Insert 2',
    color: '#ff6e00',
    volume: 1,
    pan: track2Pan,
    mute: false,
    solo: false,
    stereoWidth: 1,
    fxSlots: [],
    peakL: 0,
    peakR: 0,
    routingTargetId: 0,
  },
];

const makeChannel = (
  instrumentType: InstrumentType,
  pan: number,
  overrides: Partial<Channel> = {},
): Channel => {
  const base: Channel = {
    id: `ch-${instrumentType}`,
    name: instrumentType,
    color: '#00e5ff',
    instrumentType,
    mixerTrackId: 1,
    volume: 0.9,
    pan,
    pitch: 0,
    mute: false,
    solo: false,
    steps: [true, ...new Array(15).fill(false)],
    notes: [],
    synthParams: audioEngine.getDefaultSynthParams(),
    ...overrides,
  };

  if (instrumentType === 'sampler' && !overrides.customSample && !overrides.sampleZones) {
    base.customSample = {
      id: 'phase60-sample',
      name: 'Phase 60 Sample',
      duration: 0.25,
      sampleRate: SAMPLE_RATE,
      channels: 1,
      waveformPeaks: [0.5],
      rootPitch: 60,
    };
  }

  if (instrumentType === 'drumpad' && !overrides.drumPads) {
    base.drumPads = [
      {
        id: 'pad-kick',
        note: 36,
        name: 'Kick',
        sampleId: 'phase60-sample',
        volume: 1,
        pan: 0,
        tuneSemitones: 0,
        trimStart: 0,
        trimEnd: 1,
        reverse: false,
        loop: false,
        chokeGroup: 0,
      },
    ];
  }

  return base;
};

const makeNote = (pitch = 60, overrides: Partial<Note> = {}): Note => ({
  id: `note-${pitch}`,
  pitch,
  start: 0,
  duration: 1,
  velocity: 0.9,
  ...overrides,
});

type EngineAny = Record<string, any>;
const engine = audioEngine as unknown as EngineAny;
const savedEngineState: Record<string, unknown> = {};
const SAVED_FIELDS = [
  'ctx',
  'liveCtx',
  'transport',
  'isPlaying',
  'playbackGeneration',
  'isOfflineRendering',
  'offlineRenderLeaseHeld',
  'offlineRenderOperationDepth',
  'masterGain',
  'masterAnalyser',
  'grossBeatNode',
  'mixerChannels',
  'channelPanners',
  'mixerRoutingAdapter',
  'mixerRoutingChannelMap',
  'impulseResponses',
  'activeVoices',
  'activeDrumPadVoices',
  'activeClipSources',
  'activeClipSourceLanes',
  'playlistLaneMutes',
  'activeChannels',
  'activeClips',
  'activeMixerTracks',
  'playbackProjectChannels',
  'playbackProjectMixerTracks',
  'activePlayMode',
  'activePatternId',
  'activePatternLengthSteps',
  'currentStep',
  'currentBar',
  'bpm',
  'swing',
  'metronome',
  'sampleBuffers',
  'projectOwnedSampleBufferIds',
  'sessionSampleBufferIds',
];

const realWindow = (globalThis as any).window;
const realOfflineAudioContext = (globalThis as any).OfflineAudioContext;

const setupLiveGraph = (tracks: MixerTrack[] = makeMixerTracks()): FakeAudioContext => {
  const ctx = new FakeAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
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
  for (const track of tracks) {
    audioEngine.updateMixerTrack(track);
  }
  return ctx;
};

beforeEach(() => {
  FakeAudioContext.instances = [];
  for (const field of SAVED_FIELDS) {
    savedEngineState[field] = engine[field];
  }
  engine.isOfflineRendering = false;
  engine.offlineRenderLeaseHeld = false;
  engine.offlineRenderOperationDepth = 0;
  engine.isPlaying = false;
  engine.transport = null;
  engine.activeVoices = new Map();
  engine.activeDrumPadVoices = new Map();
  engine.activeClipSources = new Set();
  engine.activeClipSourceLanes = new Map();
  engine.playlistLaneMutes = new Set();
  engine.sampleBuffers = new Map([['phase60-sample', makeSampleBuffer()]]);
  engine.projectOwnedSampleBufferIds = new Set();
  engine.sessionSampleBufferIds = new Set(['phase60-sample']);

  (globalThis as any).OfflineAudioContext = FakeAudioContext;
  (globalThis as any).window = {
    AudioContext: FakeAudioContext,
    OfflineAudioContext: FakeAudioContext,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
});

afterEach(() => {
  for (const field of SAVED_FIELDS) {
    engine[field] = savedEngineState[field];
  }
  (globalThis as any).window = realWindow;
  (globalThis as any).OfflineAudioContext = realOfflineAudioContext;
});

describe('Phase 60 — Shared Channel-Pan Boundary & Mixer Independence', () => {
  it('routes Channel.pan = -1, 0, +1 to the production audio graph and pans live audio left, center, and right', () => {
    for (const [pan, label] of [
      [-1, 'hard left'],
      [0, 'center'],
      [1, 'hard right'],
    ] as const) {
      const ctx = setupLiveGraph();
      const channel = makeChannel('minisynth', pan);
      audioEngine.playSingleVoice(channel, makeNote(60), 0);

      const rendered = ctx.renderWindow(0.15, 0);
      const energyL = channelEnergy(rendered, 0);
      const energyR = channelEnergy(rendered, 1);

      if (pan === -1) {
        assert.ok(energyL > 0, `${label}: expected non-zero left energy`);
        assert.ok(energyR < 1e-9, `${label}: expected silent right channel, got ${energyR}`);
      } else if (pan === 0) {
        assert.ok(energyL > 0, `${label}: expected non-zero left energy`);
        assert.ok(Math.abs(energyL - energyR) < 1e-6, `${label}: expected equal L/R energy (${energyL} vs ${energyR})`);
      } else {
        assert.ok(energyR > 0, `${label}: expected non-zero right energy`);
        assert.ok(energyL < 1e-9, `${label}: expected silent left channel, got ${energyL}`);
      }
    }
  });

  it('updates the runtime channel panner when Channel.pan changes during active playback without restarting', () => {
    const ctx = setupLiveGraph();
    const channel = makeChannel('minisynth', -1, { id: 'ch-live-sync' });
    const tracks = makeMixerTracks(0);

    engine.transport = {
      setBpm: () => undefined,
      setMode: () => undefined,
      setPatternLoopSteps: () => undefined,
      setTimeSignature: () => undefined,
      setSongEndSteps: () => undefined,
      setCallbacks: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      pause: () => undefined,
      seek: () => undefined,
      getState: () => ({
        bpm: 120,
        beatsPerBar: 4,
        stepsPerBeat: 4,
        mode: 'pat' as const,
        playing: true,
        positionSeconds: 0,
        step: 0,
        bar: 1,
      }),
    };

    audioEngine.play([channel], [], 'pat', undefined, tracks);
    audioEngine.playSingleVoice(engine.activeChannels[0], makeNote(60, { duration: 4 }), 0);

    const beforeEdit = ctx.renderWindow(0.05, 0);
    assert.ok(channelEnergy(beforeEdit, 0) > 0);
    assert.ok(channelEnergy(beforeEdit, 1) < 1e-9, 'initially hard left');

    // Edit Channel.pan to hard right while playback is active (no Stop/Play).
    ctx.currentTime = 0.05;
    const editedChannel = { ...channel, pan: 1 };
    audioEngine.synchronizePlaybackState({ channels: [editedChannel] });

    const afterEdit = ctx.renderWindow(0.05, 0.06);
    assert.ok(channelEnergy(afterEdit, 1) > 0, 'in-flight voice shifts to right channel after live pan edit');
    assert.ok(channelEnergy(afterEdit, 0) < 1e-9, 'left channel is now silent after live pan edit to +1');
  });

  it('keeps Channel.pan and MixerTrack.pan independent in state, undo history, and the audio graph', () => {
    // 1. Channel.pan = -1, MixerTrack.pan = 0 -> left
    {
      const ctx = setupLiveGraph(makeMixerTracks(0));
      const ch = makeChannel('minisynth', -1);
      audioEngine.playSingleVoice(ch, makeNote(60), 0);
      const buf = ctx.renderWindow(0.1, 0);
      assert.ok(channelEnergy(buf, 0) > 0 && channelEnergy(buf, 1) < 1e-9);
      const mixerPanner = engine.mixerChannels.get(1).panner as FakeNode;
      assert.equal(mixerPanner.pan.value, 0, 'Channel.pan must not mutate MixerTrack.pan');
    }

    // 2. Channel.pan = +1, MixerTrack.pan = 0 -> right
    {
      const ctx = setupLiveGraph(makeMixerTracks(0));
      const ch = makeChannel('minisynth', 1);
      audioEngine.playSingleVoice(ch, makeNote(60), 0);
      const buf = ctx.renderWindow(0.1, 0);
      assert.ok(channelEnergy(buf, 1) > 0 && channelEnergy(buf, 0) < 1e-9);
    }

    // 3. Channel.pan = 0, MixerTrack.pan = -1 -> left
    {
      const ctx = setupLiveGraph(makeMixerTracks(-1));
      const ch = makeChannel('minisynth', 0);
      audioEngine.playSingleVoice(ch, makeNote(60), 0);
      const buf = ctx.renderWindow(0.1, 0);
      assert.ok(channelEnergy(buf, 0) > 0 && channelEnergy(buf, 1) < 1e-9);
    }

    // 4. Channel.pan = 0, MixerTrack.pan = +1 -> right
    {
      const ctx = setupLiveGraph(makeMixerTracks(1));
      const ch = makeChannel('minisynth', 0);
      audioEngine.playSingleVoice(ch, makeNote(60), 0);
      const buf = ctx.renderWindow(0.1, 0);
      assert.ok(channelEnergy(buf, 1) > 0 && channelEnergy(buf, 0) < 1e-9);
    }

    // 5. Coexistence: Channel.pan = -0.5 and MixerTrack.pan = +0.5 remain distinct panners
    {
      setupLiveGraph(makeMixerTracks(0.5));
      const ch = makeChannel('minisynth', -0.5);
      audioEngine.playSingleVoice(ch, makeNote(60), 0);
      const mixerPanner = engine.mixerChannels.get(1).panner as FakeNode;
      const channelPanner = audioEngine.getChannelPanner(ch.id) as unknown as FakeNode;
      assert.ok(channelPanner, 'channel panner exists');
      assert.notEqual(channelPanner, mixerPanner, 'channel panner and mixer panner are distinct nodes');
      assert.equal(channelPanner.pan.value, -0.5);
      assert.equal(mixerPanner.pan.value, 0.5);
    }

    // 6. Undoing Channel.pan does not undo MixerTrack.pan, and persistence preserves both
    const initial = createDefaultProjectState();
    let history = createHistory(initial);
    const withMixerPan = updateMixerTrackInProjectState(history.present, 1, { pan: 0.65 });
    history = history.commit(withMixerPan, 'Change mixer pan');
    const withChannelPan = updateChannelInProjectState(history.present, 'ch-1', { pan: -0.75 });
    history = history.commit(withChannelPan, 'Change channel pan');

    const serialized = serializeProjectState(history.present);
    const parsedEnvelope = JSON.parse(serialized) as { state: unknown };
    const reloaded = normalizeProjectState(parsedEnvelope.state);
    assert.equal(reloaded.channels.find(c => c.id === 'ch-1')?.pan, -0.75);
    assert.equal(reloaded.mixerTracks.find(t => t.id === 1)?.pan, 0.65);

    history = history.undo();
    assert.equal(history.present.channels.find(c => c.id === 'ch-1')?.pan, 0);
    assert.equal(history.present.mixerTracks.find(t => t.id === 1)?.pan, 0.65);
  });
});

describe('Phase 60 — All 24 Production InstrumentTypes Live & Offline Parity', () => {
  it('applies Channel.pan across all 24 production InstrumentTypes in live playback and cleans up voices', () => {
    for (const instrumentType of ALL_INSTRUMENT_TYPES) {
      for (const pan of [-0.85, 0.85] as const) {
        const ctx = setupLiveGraph();
        const channel = makeChannel(instrumentType, pan, { id: `live-${instrumentType}` });
        const pitch = instrumentType === 'drumpad' ? 36 : 60;

        audioEngine.playSingleVoice(channel, makeNote(pitch), 0);
        assert.equal(engine.activeVoices.size, 1, `${instrumentType} should register 1 active voice`);

        const rendered = ctx.renderWindow(0.12, 0);
        const energyL = channelEnergy(rendered, 0);
        const energyR = channelEnergy(rendered, 1);

        if (pan < 0) {
          assert.ok(
            energyL > energyR * 4,
            `${instrumentType} live pan=${pan}: expected L (${energyL}) > 4x R (${energyR})`,
          );
        } else {
          assert.ok(
            energyR > energyL * 4,
            `${instrumentType} live pan=${pan}: expected R (${energyR}) > 4x L (${energyL})`,
          );
        }

        // Verify natural voice completion removes activeVoices entry
        const sourcesWithEnded = ctx.nodes.filter(
          n => (n.kind === 'oscillator' || n.kind === 'bufferSource') && n.onended !== null,
        );
        for (const src of sourcesWithEnded) {
          src.onended?.();
        }
        assert.equal(engine.activeVoices.size, 0, `${instrumentType} should clean up activeVoices on natural completion`);
      }
    }
  });

  it('applies Channel.pan across all 24 production InstrumentTypes in offline export (renderTimelineOffline)', async () => {
    for (const instrumentType of ALL_INSTRUMENT_TYPES) {
      const leftChannel = makeChannel(instrumentType, -1, { id: `off-L-${instrumentType}` });
      const centerChannel = makeChannel(instrumentType, 0, { id: `off-C-${instrumentType}` });
      const rightChannel = makeChannel(instrumentType, 1, { id: `off-R-${instrumentType}` });
      const tracks = makeMixerTracks(0);

      const leftBuffer = await audioEngine.renderTimelineOffline(
        [leftChannel],
        [],
        tracks,
        BPM,
        1,
        SAMPLE_RATE,
        false,
        'pattern',
        undefined,
        16,
        undefined,
        0.25,
      );
      const centerBuffer = await audioEngine.renderTimelineOffline(
        [centerChannel],
        [],
        tracks,
        BPM,
        1,
        SAMPLE_RATE,
        false,
        'pattern',
        undefined,
        16,
        undefined,
        0.25,
      );
      const rightBuffer = await audioEngine.renderTimelineOffline(
        [rightChannel],
        [],
        tracks,
        BPM,
        1,
        SAMPLE_RATE,
        false,
        'pattern',
        undefined,
        16,
        undefined,
        0.25,
      );

      const leftL = channelEnergy(leftBuffer, 0);
      const leftR = channelEnergy(leftBuffer, 1);
      assert.ok(leftL > 0, `${instrumentType} offline pan=-1 must produce left energy`);
      assert.ok(leftR < 1e-9, `${instrumentType} offline pan=-1 must silence right channel (got ${leftR})`);

      const centerL = channelEnergy(centerBuffer, 0);
      const centerR = channelEnergy(centerBuffer, 1);
      assert.ok(centerL > 0, `${instrumentType} offline pan=0 must produce energy`);
      assert.ok(Math.abs(centerL - centerR) < 1e-6, `${instrumentType} offline pan=0 must balance L and R`);

      const rightL = channelEnergy(rightBuffer, 0);
      const rightR = channelEnergy(rightBuffer, 1);
      assert.ok(rightR > 0, `${instrumentType} offline pan=+1 must produce right energy`);
      assert.ok(rightL < 1e-9, `${instrumentType} offline pan=+1 must silence left channel (got ${rightL})`);
    }
  });

  it('applies Channel.pan when sampler falls back to subtractive synthesis (missing sample)', () => {
    const ctx = setupLiveGraph();
    const fallbackSampler = makeChannel('sampler', -1, {
      id: 'ch-sampler-fallback',
      customSample: undefined,
      sampleZones: [],
    });

    audioEngine.playSingleVoice(fallbackSampler, makeNote(60), 0);
    const rendered = ctx.renderWindow(0.12, 0);
    assert.ok(channelEnergy(rendered, 0) > 0);
    assert.ok(channelEnergy(rendered, 1) < 1e-9);
  });
});

describe('Phase 60 — Independent Pluck & Per-Note Pan Override', () => {
  it('does not double-pan independent_pluck when note.pan is absent', () => {
    const ctx = setupLiveGraph();
    const channel = makeChannel('independent_pluck', -0.5, { id: 'ch-pluck-single-pan' });
    audioEngine.playSingleVoice(channel, makeNote(60), 0);

    // Count active panners with non-zero pan in the graph: only the single channel panner should have -0.5.
    const activeNonZeroPanners = ctx.nodes.filter(
      node => node.kind === 'panner' && Math.abs(node.pan.valueAt(0)) > 1e-6,
    );
    assert.equal(activeNonZeroPanners.length, 1, 'exactly one panner should apply Channel.pan = -0.5');
    assert.equal(activeNonZeroPanners[0].pan.valueAt(0), -0.5);
  });

  it('allows Note.pan to override Channel.pan without double panning or mutating the channel panner', () => {
    for (const instrumentType of ['independent_pluck', 'minisynth'] as const) {
      const ctx = setupLiveGraph();
      const channel = makeChannel(instrumentType, -1, { id: `ch-note-override-${instrumentType}` });

      // Trigger a note with explicit note.pan = +1 on a channel whose Channel.pan = -1
      audioEngine.playSingleVoice(channel, makeNote(60, { pan: 1 }), 0);

      const rendered = ctx.renderWindow(0.12, 0);
      assert.ok(
        channelEnergy(rendered, 1) > 0,
        `${instrumentType}: note.pan = +1 must route energy to the right channel despite Channel.pan = -1`,
      );
      assert.ok(
        channelEnergy(rendered, 0) < 1e-9,
        `${instrumentType}: note.pan = +1 must silence left channel without double panning from Channel.pan = -1`,
      );
    }
  });
});

describe('Phase 60 — DrumPad.pan + Channel.pan Semantics', () => {
  it('composes DrumPad.pan and Channel.pan cleanly and preserves Channel.pan on unsampled legacy drum fallback', () => {
    // 1. Channel pan center (0) + Pad pan left (-1) -> left
    {
      const ctx = setupLiveGraph();
      const ch = makeChannel('drumpad', 0, {
        drumPads: [{
          id: 'p1', note: 36, name: 'Kick', sampleId: 'phase60-sample',
          volume: 1, pan: -1, tuneSemitones: 0, trimStart: 0, trimEnd: 1, reverse: false, loop: false, chokeGroup: 0,
        }],
      });
      audioEngine.playSingleVoice(ch, makeNote(36), 0);
      const rendered = ctx.renderWindow(0.1, 0);
      assert.ok(channelEnergy(rendered, 0) > 0 && channelEnergy(rendered, 1) < 1e-9);
    }

    // 2. Channel pan left (-1) + Pad pan center (0) -> left
    {
      const ctx = setupLiveGraph();
      const ch = makeChannel('drumpad', -1, {
        drumPads: [{
          id: 'p1', note: 36, name: 'Kick', sampleId: 'phase60-sample',
          volume: 1, pan: 0, tuneSemitones: 0, trimStart: 0, trimEnd: 1, reverse: false, loop: false, chokeGroup: 0,
        }],
      });
      audioEngine.playSingleVoice(ch, makeNote(36), 0);
      const rendered = ctx.renderWindow(0.1, 0);
      assert.ok(channelEnergy(rendered, 0) > 0 && channelEnergy(rendered, 1) < 1e-9);
    }

    // 3. Channel pan right (+0.6) + Pad pan right (+0.6) -> strongly right
    {
      const ctx = setupLiveGraph();
      const ch = makeChannel('drumpad', 0.6, {
        drumPads: [{
          id: 'p1', note: 36, name: 'Kick', sampleId: 'phase60-sample',
          volume: 1, pan: 0.6, tuneSemitones: 0, trimStart: 0, trimEnd: 1, reverse: false, loop: false, chokeGroup: 0,
        }],
      });
      audioEngine.playSingleVoice(ch, makeNote(36), 0);
      const rendered = ctx.renderWindow(0.1, 0);
      assert.ok(channelEnergy(rendered, 1) > channelEnergy(rendered, 0) * 10);
    }

    // 4. Unsampled drum pad fallback (legacyDrum) obeys Channel.pan
    {
      const ctx = setupLiveGraph();
      const ch = makeChannel('drumpad', 1, { drumPads: [] });
      audioEngine.playSingleVoice(ch, makeNote(36), 0);
      const rendered = ctx.renderWindow(0.1, 0);
      assert.ok(channelEnergy(rendered, 1) > 0 && channelEnergy(rendered, 0) < 1e-9);
    }
  });
});

describe('Phase 60 — Channel-Affiliated Audio Clips, Automation, MIDI & Multi-Voice Lifecycle', () => {
  it('applies Channel.pan to channel-affiliated audio clips while keeping unassociated clips on mixer insert pan', async () => {
    const channelLeft = makeChannel('sampler', -1, { id: 'ch-audio-clip', steps: new Array(16).fill(false) });
    const affiliatedClip: PlaylistClip = {
      id: 'clip-affiliated',
      name: 'Affiliated Clip',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 1,
      type: 'audio',
      channelId: channelLeft.id,
      audioBufferId: 'phase60-sample',
      color: '#00e5ff',
    };

    const rendered = await audioEngine.renderTimelineOffline(
      [channelLeft],
      [affiliatedClip],
      makeMixerTracks(0),
      BPM,
      1,
      SAMPLE_RATE,
      false,
      'song',
      undefined,
      undefined,
      undefined,
      0.25,
    );

    assert.ok(channelEnergy(rendered, 0) > 0, 'affiliated audio clip with Channel.pan=-1 has left energy');
    assert.ok(channelEnergy(rendered, 1) < 1e-9, 'affiliated audio clip with Channel.pan=-1 is silent on right');
  });

  it('routes channel_pan automation to the real channel panner AudioParam in live and offline paths and resets cleanly', async () => {
    const ctx = setupLiveGraph();
    const projectChannel = makeChannel('minisynth', 0, { id: 'ch-auto-pan' });
    const activeChannels = [structuredClone(projectChannel)];
    const activeTracks = makeMixerTracks(0);

    engine.activeChannels = activeChannels;
    engine.playbackProjectChannels = [structuredClone(projectChannel)];
    engine.activeMixerTracks = activeTracks;
    engine.playbackProjectMixerTracks = structuredClone(activeTracks);

    // Trigger voice so channel panner is in the graph
    audioEngine.playSingleVoice(activeChannels[0], makeNote(60, { duration: 4 }), 0);
    const channelPanner = audioEngine.getChannelPanner(projectChannel.id) as unknown as FakeNode;
    assert.ok(channelPanner, 'channel panner must exist');
    assert.equal(channelPanner.pan.value, 0);

    // Sweep automation: normalized 0 -> pan -1, 0.5 -> pan 0, 1.0 -> pan +1
    audioEngine.applyAutomationValue({ type: 'channel_pan', targetId: projectChannel.id }, 0, activeChannels, activeTracks, 0.05);
    assert.equal(activeChannels[0].pan, -1);
    assert.equal(channelPanner.pan.value, -1, 'channel_pan automation at 0 must set AudioParam to -1');

    audioEngine.applyAutomationValue({ type: 'channel_pan', targetId: projectChannel.id }, 0.5, activeChannels, activeTracks, 0.1);
    assert.equal(activeChannels[0].pan, 0);
    assert.equal(channelPanner.pan.value, 0, 'channel_pan automation at 0.5 must set AudioParam to 0');

    audioEngine.applyAutomationValue({ type: 'channel_pan', targetId: projectChannel.id }, 1, activeChannels, activeTracks, 0.15);
    assert.equal(activeChannels[0].pan, 1);
    assert.equal(channelPanner.pan.value, 1, 'channel_pan automation at 1.0 must set AudioParam to +1');
    assert.equal(projectChannel.pan, 0, 'persistent project channel pan must not be mutated by automation');

    // Resetting the automation target restores project Channel.pan (0) on both state and AudioParam
    ctx.currentTime = 0.2;
    engine.resetActiveAutomationTarget({ type: 'channel_pan', targetId: projectChannel.id });
    assert.equal(activeChannels[0].pan, 0);
    assert.equal(channelPanner.pan.value, 0, 'resetActiveAutomationTarget must restore AudioParam to project Channel.pan');

    // Offline song render with channel_pan automation clip (hard right)
    const patternClip: PlaylistClip = {
      id: 'pat-clip',
      name: 'Pattern',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 1,
      type: 'pattern',
      channelId: projectChannel.id,
      color: '#00e5ff',
    };
    const autoClip: PlaylistClip = {
      id: 'auto-clip',
      name: 'Pan Right',
      trackIndex: 1,
      startBar: 0,
      lengthBars: 1,
      type: 'automation',
      color: '#ff6e00',
      automationTarget: { type: 'channel_pan', targetId: projectChannel.id },
      automationPoints: [
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ],
    };

    const offlineBuffer = await audioEngine.renderTimelineOffline(
      [projectChannel],
      [patternClip, autoClip],
      makeMixerTracks(0),
      BPM,
      1,
      SAMPLE_RATE,
      false,
      'song',
      undefined,
      undefined,
      undefined,
      0.25,
    );
    assert.ok(channelEnergy(offlineBuffer, 1) > 0, 'offline channel_pan automation at y=1 produces right energy');
    assert.ok(channelEnergy(offlineBuffer, 0) < 1e-9, 'offline channel_pan automation at y=1 silences left channel');
  });

  it('routes MIDI CC channel_pan changes through project mutation and runtime synchronization to the channel panner', () => {
    setupLiveGraph();
    let state: ProjectState = createDefaultProjectState();
    state = {
      ...state,
      midiMappings: [
        { ccNumber: 10, targetType: 'channel_pan', targetId: 'ch-1', paramName: 'Channel 1 Pan' },
      ],
    };

    // Start with ch-1 panner in graph
    audioEngine.updateChannel(state.channels[0]);
    const pannerBefore = audioEngine.getChannelPanner('ch-1') as unknown as FakeNode;
    assert.ok(pannerBefore);
    assert.equal(pannerBefore.pan.value, 0);

    const midiRuntime = new MidiCcMappingRuntime({
      getProjectState: () => state,
      applyProjectMutation: (updater) => {
        state = updater(state);
        state.channels.forEach(ch => audioEngine.updateChannel(ch));
      },
      applyMasterVolume: () => undefined,
    });

    // Send CC 10 with value 0 (hard left -> -1)
    const resLeft = midiRuntime.handleMidiEvent({ type: 'cc', cc: 10, value: 0 });
    assert.equal(resLeft.status, 'applied');
    assert.equal(state.channels[0].pan, -1);
    assert.equal((audioEngine.getChannelPanner('ch-1') as unknown as FakeNode).pan.value, -1);

    // Send CC 10 with value 1 (hard right -> +1)
    const resRight = midiRuntime.handleMidiEvent({ type: 'cc', cc: 10, value: 1 });
    assert.equal(resRight.status, 'applied');
    assert.equal(state.channels[0].pan, 1);
    assert.equal((audioEngine.getChannelPanner('ch-1') as unknown as FakeNode).pan.value, 1);
  });

  it('reuses one channel panner across polyphonic notes, isolates channels sharing a mixer insert, and cleans up on channel removal', () => {
    const ctx = setupLiveGraph();
    const chA = makeChannel('minisynth', -1, { id: 'ch-shared-A', mixerTrackId: 1 });
    const chB = makeChannel('fmsynth', 1, { id: 'ch-shared-B', mixerTrackId: 1 });

    // Polyphonic notes on chA reuse the same channel panner
    audioEngine.playSingleVoice(chA, makeNote(60), 0);
    audioEngine.playSingleVoice(chA, makeNote(64), 0);
    assert.equal(engine.activeVoices.size, 2);
    const pannerA = audioEngine.getChannelPanner(chA.id) as unknown as FakeNode;
    assert.ok(pannerA);

    // Second channel on the same mixerTrackId (1) gets its own independent channel panner
    audioEngine.playSingleVoice(chB, makeNote(67), 0);
    const pannerB = audioEngine.getChannelPanner(chB.id) as unknown as FakeNode;
    assert.ok(pannerB);
    assert.notEqual(pannerA, pannerB);
    assert.equal(pannerA.pan.value, -1);
    assert.equal(pannerB.pan.value, 1);

    // Both channel panners feed mixer track 1's input
    const mixer1Input = engine.mixerChannels.get(1).input;
    assert.ok(pannerA.connections.includes(mixer1Input));
    assert.ok(pannerB.connections.includes(mixer1Input));

    // Both channels contribute to L and R respectively
    const rendered = ctx.renderWindow(0.1, 0);
    assert.ok(channelEnergy(rendered, 0) > 0, 'chA (-1) contributes to L');
    assert.ok(channelEnergy(rendered, 1) > 0, 'chB (+1) contributes to R');

    // Removing chA cleans up its panner without affecting chB
    audioEngine.stopChannelVoices(chA.id);
    audioEngine.removeChannelPanner(chA.id);
    assert.equal(audioEngine.getChannelPanner(chA.id), undefined);
    assert.ok(pannerA.disconnectCalls >= 1);
    assert.equal(audioEngine.getChannelPanner(chB.id), pannerB);
  });
});
