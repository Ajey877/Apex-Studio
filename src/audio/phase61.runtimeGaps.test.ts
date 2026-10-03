import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import * as midiMappingRuntimeModule from './midiMappingRuntime';
import { resolveMidiCcTarget, MidiCcMappingRuntime } from './midiMappingRuntime';
import * as midiLearnModalModule from '../components/MidiLearnModal';
import * as midiControllerModalModule from '../components/MidiControllerModal';
import { createDefaultProjectState } from '../state/projectState';
import { createHistory } from '../state/projectHistory';
import { updateChannelInProjectState } from '../state/projectMutations';
import type {
  Channel,
  MixerTrack,
  Note,
  PlaylistClip,
  PlaylistTrack,
} from '../types/daw';

const SAMPLE_RATE = 8000;
const BPM = 120;

type ParamEvent =
  | { type: 'set'; value: number; time: number }
  | { type: 'linear'; value: number; time: number }
  | { type: 'exp'; value: number; time: number }
  | { type: 'target'; value: number; time: number; timeConstant: number };

class SimAudioParam {
  value: number;
  readonly events: ParamEvent[] = [];

  constructor(initialValue: number) {
    this.value = initialValue;
  }

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'set', value, time });
  }

  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'linear', value, time });
  }

  exponentialRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'exp', value, time });
  }

  setTargetAtTime(value: number, time: number, timeConstant: number): void {
    this.value = value;
    this.events.push({ type: 'target', value, time, timeConstant });
  }

  cancelScheduledValues(fromTime: number): void {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].time >= fromTime) {
        this.events.splice(i, 1);
      }
    }
  }

  valueAt(time: number): number {
    if (this.events.length === 0) return this.value;
    let current = this.events[0].value;
    for (const ev of this.events) {
      if (ev.time <= time + 1e-6) {
        current = ev.value;
      }
    }
    return current;
  }
}

class SimNode {
  readonly kind: string;
  readonly ctx: SimAudioContext;
  readonly connections: SimNode[] = [];
  disconnectCalls = 0;

  readonly gain = new SimAudioParam(1);
  readonly pan = new SimAudioParam(0);
  readonly frequency = new SimAudioParam(440);
  readonly detune = new SimAudioParam(0);
  readonly Q = new SimAudioParam(1);
  readonly playbackRate = new SimAudioParam(1);
  readonly delayTime = new SimAudioParam(0);
  readonly threshold = new SimAudioParam(-24);
  readonly knee = new SimAudioParam(30);
  readonly ratio = new SimAudioParam(12);
  readonly attack = new SimAudioParam(0.003);
  readonly release = new SimAudioParam(0.25);

  type = 'sawtooth';
  buffer: AudioBuffer | null = null;
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
  fftSize = 256;
  smoothingTimeConstant = 0.8;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;

  started = false;
  stopped = false;
  startTime = 0;
  stopTime = Infinity;

  constructor(kind: string, ctx: SimAudioContext) {
    this.kind = kind;
    this.ctx = ctx;
  }

  connect(destination: SimNode | SimAudioParam): SimNode {
    if (destination instanceof SimNode && !this.connections.includes(destination)) {
      this.connections.push(destination);
    }
    return destination instanceof SimNode ? destination : this;
  }

  disconnect(destination?: SimNode): void {
    this.disconnectCalls += 1;
    if (!destination) {
      this.connections.length = 0;
      return;
    }
    const idx = this.connections.indexOf(destination);
    if (idx >= 0) this.connections.splice(idx, 1);
  }

  start(when = 0): void {
    this.started = true;
    this.startTime = when;
  }

  stop(when = 0): void {
    this.stopped = true;
    this.stopTime = when;
  }

  setPeriodicWave(): void {}
  addEventListener(_event: string, _listener: () => void): void {}
  removeEventListener(_event: string, _listener: () => void): void {}
  getFloatTimeDomainData(array: Float32Array): void {
    array.fill(0);
  }
  getByteFrequencyData(array: Uint8Array): void {
    array.fill(0);
  }
  getByteTimeDomainData(array: Uint8Array): void {
    array.fill(128);
  }
}

class SimAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  private readonly channels: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = Math.max(1, length);
    this.sampleRate = sampleRate;
    this.duration = this.length / sampleRate;
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(this.length));
  }

  getChannelData(channel: number): Float32Array {
    return this.channels[channel] ?? this.channels[0];
  }
}

class SimAudioContext {
  static instances: SimAudioContext[] = [];

  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  readonly destination: SimNode;
  readonly nodes: SimNode[] = [];
  currentTime = 0;
  state: AudioContextState = 'running';

  constructor(numberOfChannels = 2, length = SAMPLE_RATE, sampleRate = SAMPLE_RATE) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    this.destination = new SimNode('destination', this);
    SimAudioContext.instances.push(this);
  }

  private track(kind: string): SimNode {
    const node = new SimNode(kind, this);
    this.nodes.push(node);
    return node;
  }

  createGain(): SimNode {
    return this.track('gain');
  }
  createStereoPanner(): SimNode {
    return this.track('panner');
  }
  createOscillator(): SimNode {
    return this.track('oscillator');
  }
  createBufferSource(): SimNode {
    return this.track('bufferSource');
  }
  createBiquadFilter(): SimNode {
    return this.track('filter');
  }
  createWaveShaper(): SimNode {
    return this.track('waveshaper');
  }
  createDelay(): SimNode {
    return this.track('delay');
  }
  createConvolver(): SimNode {
    return this.track('convolver');
  }
  createDynamicsCompressor(): SimNode {
    return this.track('compressor');
  }
  createAnalyser(): SimNode {
    return this.track('analyser');
  }
  createPeriodicWave(): Record<string, never> {
    return {};
  }
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    return new SimAudioBuffer(channels, length, sampleRate) as unknown as AudioBuffer;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }

  renderWindow(durationSeconds = 0.15, atTime = this.currentTime): AudioBuffer {
    const frames = Math.max(16, Math.floor(durationSeconds * this.sampleRate));
    const out = new SimAudioBuffer(2, frames, this.sampleRate);
    const outL = out.getChannelData(0);
    const outR = out.getChannelData(1);

    const sources = this.nodes.filter(
      n => (n.kind === 'oscillator' || n.kind === 'bufferSource') && n.started && n.connections.length > 0,
    );

    for (const source of sources) {
      if (atTime + durationSeconds <= source.startTime || atTime >= source.stopTime) continue;
      const paths = this.findPathsToDestination(source);
      for (const path of paths) {
        let gainMultiplier = 1;
        let totalPan = 0;

        for (const node of path) {
          if (node.kind === 'gain') {
            gainMultiplier *= Math.max(0, node.gain.valueAt(atTime));
          } else if (node.kind === 'panner') {
            totalPan = Math.max(-1, Math.min(1, totalPan + node.pan.valueAt(atTime)));
          }
        }

        if (gainMultiplier <= 1e-5) continue;
        const angle = ((totalPan + 1) * Math.PI) / 4;
        const panL = Math.cos(angle);
        const panR = Math.sin(angle);

        for (let i = 0; i < frames; i++) {
          const sample = Math.sin((2 * Math.PI * 220 * i) / this.sampleRate) * gainMultiplier;
          outL[i] += sample * panL;
          outR[i] += sample * panR;
        }
      }
    }

    return out as unknown as AudioBuffer;
  }

  private findPathsToDestination(start: SimNode): SimNode[][] {
    const results: SimNode[][] = [];
    const visit = (node: SimNode, path: SimNode[], visited: Set<SimNode>) => {
      if (node === this.destination) {
        results.push(path);
        return;
      }
      for (const target of node.connections) {
        if (visited.has(target)) continue;
        visited.add(target);
        visit(target, [...path, target], visited);
        visited.delete(target);
      }
    };
    visit(start, [start], new Set([start]));
    return results;
  }

  async startRendering(): Promise<AudioBuffer> {
    const out = new SimAudioBuffer(2, this.length, this.sampleRate);
    const outL = out.getChannelData(0);
    const outR = out.getChannelData(1);

    const sources = this.nodes.filter(
      n => (n.kind === 'oscillator' || n.kind === 'bufferSource') && n.started && n.connections.length > 0,
    );

    for (const source of sources) {
      const paths = this.findPathsToDestination(source);
      const startSample = Math.max(0, Math.floor(source.startTime * this.sampleRate));
      const endSample = Math.min(
        this.length,
        Number.isFinite(source.stopTime)
          ? Math.ceil(source.stopTime * this.sampleRate)
          : this.length,
      );
      if (endSample <= startSample) continue;

      for (const path of paths) {
        for (let i = startSample; i < endSample; i++) {
          const sampleTime = i / this.sampleRate;
          let gainMultiplier = 1;
          let totalPan = 0;
          for (const node of path) {
            if (node.kind === 'gain') {
              gainMultiplier *= Math.max(0, node.gain.valueAt(sampleTime));
            } else if (node.kind === 'panner') {
              totalPan = Math.max(-1, Math.min(1, totalPan + node.pan.valueAt(sampleTime)));
            }
          }
          if (gainMultiplier <= 1e-5) continue;
          const angle = ((totalPan + 1) * Math.PI) / 4;
          const panL = Math.cos(angle);
          const panR = Math.sin(angle);
          const sample = Math.sin((2 * Math.PI * 220 * i) / this.sampleRate) * gainMultiplier;
          outL[i] += sample * panL;
          outR[i] += sample * panR;
        }
      }
    }

    return out as unknown as AudioBuffer;
  }
}

function bufferEnergy(buffer: AudioBuffer, channelIndex?: number): number {
  if (typeof channelIndex === 'number') {
    const data = buffer.getChannelData(channelIndex);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    return sum;
  }
  let total = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    total += bufferEnergy(buffer, ch);
  }
  return total;
}

function makeNote(pitch = 60, overrides: Partial<Note> = {}): Note {
  return {
    id: `note-${pitch}`,
    pitch,
    start: 0,
    duration: 4,
    velocity: 0.9,
    ...overrides,
  };
}

function makeChannel(id: string, overrides: Partial<Channel> = {}): Channel {
  return {
    id,
    name: id,
    instrumentType: 'minisynth',
    color: '#00e5ff',
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    steps: [true, ...new Array(15).fill(false)],
    notes: [],
    synthParams: {
      ...audioEngine.getDefaultSynthParams(),
      osc1Type: 'sawtooth',
      osc2Type: 'square',
      osc2Detune: 10,
      filterCutoff: 4000,
      filterResonance: 1,
      attack: 0.01,
      decay: 0.1,
      sustain: 0.8,
      release: 0.2,
    },
    mixerTrackId: 1,
    pitch: 0,
    ...overrides,
  };
}

function makeMixerTracks(): MixerTrack[] {
  return [
    {
      id: 0,
      name: 'Master',
      color: '#ffffff',
      volume: 0.9,
      pan: 0,
      mute: false,
      solo: false,
      stereoWidth: 1,
      peakL: 0,
      peakR: 0,
      fxSlots: [],
    },
    {
      id: 1,
      name: 'Insert 1',
      color: '#00e5ff',
      volume: 0.9,
      pan: 0,
      mute: false,
      solo: false,
      stereoWidth: 1,
      peakL: 0,
      peakR: 0,
      fxSlots: [],
    },
    {
      id: 2,
      name: 'Insert 2',
      color: '#ff6e00',
      volume: 0.9,
      pan: 0,
      mute: false,
      solo: false,
      stereoWidth: 1,
      peakL: 0,
      peakR: 0,
      fxSlots: [],
    },
  ];
}

const engine = audioEngine as any;
const realWindow = (globalThis as any).window;
const realOfflineAudioContext = (globalThis as any).OfflineAudioContext;

const SAVED_FIELDS = [
  'ctx',
  'masterGain',
  'masterLimiter',
  'analyser',
  'mixerChannels',
  'channelPanners',
  'mixerRoutingAdapter',
  'mixerRoutingChannelMap',
  'sampleBuffers',
  'impulseResponses',
  'activeVoices',
  'activeDrumPadChokeVoices',
  'activeChannels',
  'activeClips',
  'activeMixerTracks',
  'playbackProjectChannels',
  'playbackProjectMixerTracks',
  'playlistLaneMutes',
  'activeClipSources',
  'activeClipSourceLanes',
  'isPlaying',
  'isOfflineRendering',
  'transport',
  'currentStep',
  'currentBar',
  'activePlayMode',
] as const;

const savedState: Record<string, unknown> = {};

function setupLiveGraph(tracks: MixerTrack[] = makeMixerTracks()): SimAudioContext {
  const ctx = new SimAudioContext(2, SAMPLE_RATE, SAMPLE_RATE);
  engine.ctx = ctx;
  engine.masterGain = ctx.createGain();
  engine.masterLimiter = ctx.createDynamicsCompressor();
  engine.analyser = ctx.createAnalyser();
  engine.masterGain.connect(engine.masterLimiter);
  engine.masterLimiter.connect(engine.analyser);
  engine.analyser.connect(ctx.destination);
  engine.mixerChannels = new Map();
  engine.channelPanners = new Map();
  engine.mixerRoutingAdapter = null;
  engine.mixerRoutingChannelMap = null;
  engine.activeVoices = new Map();
  engine.activeDrumPadChokeVoices = new Map();
  engine.activeClipSources = new Set();
  engine.activeClipSourceLanes = new Map();
  engine.playlistLaneMutes = new Set();
  engine.isOfflineRendering = false;
  engine.isPlaying = false;

  for (const track of tracks) {
    audioEngine.updateMixerTrack(track);
  }

  const filled = new SimAudioBuffer(2, Math.floor(SAMPLE_RATE * 2), SAMPLE_RATE);
  for (let ch = 0; ch < 2; ch++) {
    const data = filled.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
    }
  }
  engine.sampleBuffers.set('sample-clip-1', filled as unknown as AudioBuffer);
  engine.sampleBuffers.set('sample-clip-2', filled as unknown as AudioBuffer);

  return ctx;
}

function attachFakeTransport(mode: 'pat' | 'song' = 'pat', initialPositionSeconds = 0) {
  let pos = initialPositionSeconds;
  engine.transport = {
    setBpm: () => undefined,
    setMode: () => undefined,
    setPatternLoopSteps: () => undefined,
    setSongEndSteps: () => undefined,
    setCallbacks: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    pause: () => undefined,
    seek: () => undefined,
    getState: () => ({
      bpm: BPM,
      beatsPerBar: 4,
      stepsPerBeat: 4,
      mode,
      playing: true,
      positionSeconds: pos,
      step: 0,
      bar: 1,
    }),
  };
  return {
    setPositionSeconds: (next: number) => {
      pos = next;
    },
  };
}

beforeEach(() => {
  SimAudioContext.instances = [];
  for (const field of SAVED_FIELDS) {
    savedState[field] = engine[field];
  }
  engine.sampleBuffers = new Map();
  engine.impulseResponses = new Map();
  (globalThis as any).window = {
    ...(realWindow ?? {}),
    AudioContext: SimAudioContext,
    OfflineAudioContext: SimAudioContext,
  };
  (globalThis as any).OfflineAudioContext = SimAudioContext;
});

afterEach(() => {
  for (const field of SAVED_FIELDS) {
    engine[field] = savedState[field];
  }
  (globalThis as any).window = realWindow;
  (globalThis as any).OfflineAudioContext = realOfflineAudioContext;
});

describe('Phase 61 Priority 1 — Channel Solo (Live, Offline, Stems, Shared Mixer Track, Mid-Take, Undo/Redo)', () => {
  it('silences non-soloed channels in live Pattern Mode, supports multiple solos and mute+solo combinations, and isolates channels sharing a MixerTrack', () => {
    const ctx = setupLiveGraph();
    attachFakeTransport('pat');

    // ch1 and ch2 share MixerTrack 1; ch3 is on MixerTrack 2
    const ch1 = makeChannel('ch-1', { solo: true, mute: false, mixerTrackId: 1, pan: -1 });
    const ch2 = makeChannel('ch-2', { solo: false, mute: false, mixerTrackId: 1, pan: 1 });
    const ch3 = makeChannel('ch-3', { solo: false, mute: false, mixerTrackId: 2, pan: 1 });

    audioEngine.play([ch1, ch2, ch3], [], 'pat', undefined, makeMixerTracks());
    engine.currentBar = 1;
    engine.currentStep = 0;
    engine.triggerCurrentStep(0);

    // Only ch1 (hard left) should trigger a voice; ch2 and ch3 must be silent
    assert.equal(engine.activeVoices.size, 1, 'only soloed ch-1 should spawn an active voice');
    const singleSoloBuf = ctx.renderWindow(0.1, 0);
    assert.ok(bufferEnergy(singleSoloBuf, 0) > 0, 'soloed ch-1 (left) produces energy');
    assert.ok(bufferEnergy(singleSoloBuf, 1) < 1e-9, 'non-soloed ch-2 and ch-3 (right) must be silent');
    assert.equal(engine.mixerChannels.get(1).output.gain.value > 0, true, 'shared MixerTrack 1 must remain unmuted');

    // Multiple solos: ch1 (left) and ch2 (right) both soloed -> both play
    const ctxMulti = setupLiveGraph();
    attachFakeTransport('pat');
    audioEngine.play(
      [
        { ...ch1, solo: true },
        { ...ch2, solo: true },
        { ...ch3, solo: false },
      ],
      [],
      'pat',
      undefined,
      makeMixerTracks(),
    );
    engine.currentBar = 1;
    engine.currentStep = 0;
    engine.triggerCurrentStep(0);
    assert.equal(engine.activeVoices.size, 2, 'both soloed channels ch-1 and ch-2 should trigger voices');
    const multiSoloBuf = ctxMulti.renderWindow(0.1, 0);
    assert.ok(bufferEnergy(multiSoloBuf, 0) > 0, 'ch-1 (left) audible');
    assert.ok(bufferEnergy(multiSoloBuf, 1) > 0, 'ch-2 (right) audible');

    // Mute + Solo combination: ch1 has solo: true AND mute: true -> all channels silent
    setupLiveGraph();
    attachFakeTransport('pat');
    audioEngine.play(
      [
        { ...ch1, solo: true, mute: true },
        { ...ch2, solo: false, mute: false },
      ],
      [],
      'pat',
      undefined,
      makeMixerTracks(),
    );
    engine.currentBar = 1;
    engine.currentStep = 0;
    engine.triggerCurrentStep(0);
    assert.equal(engine.activeVoices.size, 0, 'soloed+muted channel is silent while still solo-silencing non-soloed channels');
  });

  it('immediately stops sustaining voices and channel-affiliated audio clips on non-soloed channels when solo is toggled or undone/redone mid-take', () => {
    const ctx = setupLiveGraph();
    const transport = attachFakeTransport('song', 0);

    const ch1 = makeChannel('ch-1', { solo: false, mute: false, pan: -1 });
    const ch2 = makeChannel('ch-2', { solo: false, mute: false, pan: 1 });
    const patClip1: PlaylistClip = {
      id: 'pat-1',
      name: 'Pat 1',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 2,
      type: 'pattern',
      channelId: ch1.id,
      color: '#00e5ff',
    };
    const audioClip2: PlaylistClip = {
      id: 'aud-2',
      name: 'Audio 2',
      trackIndex: 1,
      startBar: 0,
      lengthBars: 2,
      type: 'audio',
      channelId: ch2.id,
      audioBufferId: 'sample-clip-2',
      color: '#ff6e00',
    };

    let state = createDefaultProjectState();
    state = { ...state, channels: [ch1, ch2], playlistClips: [patClip1, audioClip2] };
    let history = createHistory(state);

    audioEngine.play(state.channels, state.playlistClips, 'song', undefined, makeMixerTracks());
    engine.currentBar = 1;
    engine.currentStep = 0;
    engine.triggerCurrentStep(0);

    // Both ch1 synth voice and ch2 audio clip are active initially
    assert.equal(engine.activeVoices.size, 1, 'ch1 synth voice is active');
    assert.equal(engine.activeClipSources.size, 1, 'ch2 channel-affiliated audio clip is active');

    // Toggle Solo on ch1 during playback
    const soloedState = updateChannelInProjectState(history.present, ch1.id, { solo: true });
    history = history.commit(soloedState, 'Solo ch-1');
    audioEngine.synchronizePlaybackState({ channels: history.present.channels });

    // ch2's active audio clip must be stopped immediately while ch1's voice stays active
    assert.equal(engine.activeVoices.size, 1, 'soloed ch1 voice remains active');
    assert.equal(engine.activeClipSources.size, 0, 'non-soloed ch2 audio clip source must stop immediately on solo');

    // Undo Solo on ch1 mid-take at positionSeconds = 0.5 -> ch2 becomes audible again and its spanning audio clip retriggers
    ctx.currentTime = 0.5;
    transport.setPositionSeconds(0.5);
    history = history.undo();
    audioEngine.synchronizePlaybackState({ channels: history.present.channels });
    assert.equal(engine.activeClipSources.size, 1, 'undoing solo mid-take retriggers spanning audio clip on ch2');

    // Redo Solo on ch1 mid-take -> ch2 audio clip stops again
    history = history.redo();
    audioEngine.synchronizePlaybackState({ channels: history.present.channels });
    assert.equal(engine.activeClipSources.size, 0, 'redoing solo mid-take stops ch2 audio clip again');
  });

  it('enforces Channel.solo in offline WAV export (renderTimelineOffline) and stem export (renderProjectStems)', async () => {
    setupLiveGraph();
    const ch1 = makeChannel('ch-solo', { solo: true, mute: false, pan: -1, mixerTrackId: 1 });
    const ch2 = makeChannel('ch-unsolo', { solo: false, mute: false, pan: 1, mixerTrackId: 2 });

    const offlineBuffer = await audioEngine.renderTimelineOffline(
      [ch1, ch2],
      [],
      makeMixerTracks(),
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

    assert.ok(bufferEnergy(offlineBuffer, 0) > 0, 'offline export renders soloed channel (left)');
    assert.ok(bufferEnergy(offlineBuffer, 1) < 1e-9, 'offline export silences non-soloed channel (right)');

    // Stem export: ch1 stem has audio, ch2 stem is silent
    const patClip1: PlaylistClip = {
      id: 'stem-pat-1',
      name: 'Stem 1',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 1,
      type: 'pattern',
      channelId: ch1.id,
      color: '#00e5ff',
    };
    const patClip2: PlaylistClip = {
      id: 'stem-pat-2',
      name: 'Stem 2',
      trackIndex: 1,
      startBar: 0,
      lengthBars: 1,
      type: 'pattern',
      channelId: ch2.id,
      color: '#ff6e00',
    };

    SimAudioContext.instances = [];
    await audioEngine.renderProjectStems(
      [ch1, ch2],
      [patClip1, patClip2],
      makeMixerTracks(),
      BPM,
      1,
      24,
    );

    // Instances: [0] = master, [1] = ch1 stem, [2] = ch2 stem
    assert.ok(SimAudioContext.instances.length >= 3, 'master + 2 channel stems rendered');
    const ch1StemCtx = SimAudioContext.instances[1];
    const ch2StemCtx = SimAudioContext.instances[2];
    const ch1Oscs = ch1StemCtx.nodes.filter(n => n.kind === 'oscillator' && n.started);
    const ch2Oscs = ch2StemCtx.nodes.filter(n => n.kind === 'oscillator' && n.started);
    assert.ok(ch1Oscs.length > 0, 'soloed channel stem triggers oscillator voices');
    assert.equal(ch2Oscs.length, 0, 'non-soloed channel stem must not trigger voices when another channel is soloed');
  });
});

describe('Phase 61 Priority 2 — Channel-Affiliated Audio Clip Mute', () => {
  it('silences channel-affiliated audio clips when Channel.mute is true in live playback, mid-take mute, offline WAV export, and stem export', async () => {
    const ctx = setupLiveGraph();
    const transport = attachFakeTransport('song', 0);

    const mutedChannel = makeChannel('ch-audio-muted', { mute: true, solo: false, pan: -1 });
    const audioClip: PlaylistClip = {
      id: 'clip-aff-audio',
      name: 'Affiliated Audio',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 1,
      type: 'audio',
      channelId: mutedChannel.id,
      audioBufferId: 'sample-clip-1',
      color: '#00e5ff',
    };

    // 1. Live Song Mode playback with Channel.mute = true -> clip must not start
    audioEngine.play([mutedChannel], [audioClip], 'song', undefined, makeMixerTracks());
    engine.currentBar = 1;
    engine.currentStep = 0;
    engine.triggerCurrentStep(0);
    assert.equal(engine.activeClipSources.size, 0, 'muted channel must not start channel-affiliated audio clip');

    // 2. Unmute channel mid-take -> spanning clip retriggers; mute again -> stops immediately
    ctx.currentTime = 0.5;
    transport.setPositionSeconds(0.5);
    audioEngine.synchronizePlaybackState({ channels: [{ ...mutedChannel, mute: false }] });
    assert.equal(engine.activeClipSources.size, 1, 'unmuting channel mid-take retriggers spanning affiliated audio clip');

    audioEngine.synchronizePlaybackState({ channels: [{ ...mutedChannel, mute: true }] });
    assert.equal(engine.activeClipSources.size, 0, 'muting channel mid-take stops active affiliated audio clip immediately');

    // 3. Offline WAV export with Channel.mute = true -> silent
    const offlineBuf = await audioEngine.renderTimelineOffline(
      [mutedChannel],
      [audioClip],
      makeMixerTracks(),
      BPM,
      1,
      SAMPLE_RATE,
      false,
      'song',
      undefined,
      undefined,
      undefined,
      0.1,
    );
    assert.ok(bufferEnergy(offlineBuf) < 1e-9, 'offline export with muted channel must silence channel-affiliated audio clip');

    // 4. Stem export with Channel.mute = true -> stem context starts 0 buffer sources
    SimAudioContext.instances = [];
    await audioEngine.renderProjectStems(
      [mutedChannel],
      [audioClip],
      makeMixerTracks(),
      BPM,
      1,
      24,
    );
    const stemCtx = SimAudioContext.instances[1];
    const startedSources = stemCtx.nodes.filter(n => n.kind === 'bufferSource' && n.started);
    assert.equal(startedSources.length, 0, 'stem export for muted channel must not start channel-affiliated audio clip');
  });
});

describe('Phase 61 Priority 3 — Hardware Web MIDI noteOn/noteOff Through Production MIDI Path', () => {
  it('routes raw Web MIDI noteOn and noteOff messages through handleMidiMessage to trigger and stop instrument voices on the active channel', () => {
    setupLiveGraph();
    const state = createDefaultProjectState();
    let selectedChannelId = state.channels[0].id;

    const MidiNoteInputRuntime = (midiMappingRuntimeModule as any).MidiNoteInputRuntime;
    assert.equal(typeof MidiNoteInputRuntime, 'function', 'MidiNoteInputRuntime must be exported by midiMappingRuntime');

    const noteRuntime = new MidiNoteInputRuntime({
      getProjectState: () => state,
      getSelectedChannelId: () => selectedChannelId,
      playNote: (ch: Channel, note: Note, startTime?: number, bpm?: number) =>
        audioEngine.playNote(ch, note, startTime, bpm),
      stopChannelNote: (channelId: string, pitch: number) =>
        (audioEngine as any).stopChannelNote(channelId, pitch),
    });

    const listener = (event: any) => noteRuntime.handleMidiEvent(event);
    audioEngine.addMidiListener(listener);

    try {
      // Send raw Web MIDI Note On (status 0x90 = ch 1 noteOn, pitch 60, velocity 100)
      engine.handleMidiMessage({ data: new Uint8Array([0x90, 60, 100]) });
      assert.equal(engine.activeVoices.size, 1, 'hardware MIDI noteOn must trigger an active voice on selected channel');

      // Switch selectedChannelId while key 60 is still held, then send Note Off (0x80, 60, 0)
      selectedChannelId = state.channels[1].id;
      engine.handleMidiMessage({ data: new Uint8Array([0x80, 60, 0]) });
      assert.equal(engine.activeVoices.size, 0, 'hardware MIDI noteOff must stop the held voice on the channel that started it');

      // Running-status Note On with velocity 0 (0x90, 64, 0) also stops held voice
      engine.handleMidiMessage({ data: new Uint8Array([0x90, 64, 110]) });
      assert.equal(engine.activeVoices.size, 1, 'noteOn on pitch 64 starts voice');
      engine.handleMidiMessage({ data: new Uint8Array([0x90, 64, 0]) });
      assert.equal(engine.activeVoices.size, 0, 'noteOn with velocity 0 stops held voice');

      // Hardware MIDI noteOn on a muted or solo-silenced channel must not trigger a voice
      state.channels[1].mute = true;
      engine.handleMidiMessage({ data: new Uint8Array([0x90, 67, 100]) });
      assert.equal(engine.activeVoices.size, 0, 'muted channel must not trigger voice from hardware MIDI noteOn');
    } finally {
      audioEngine.removeMidiListener(listener);
    }
  });
});

describe('Phase 61 Priority 4 — Fix Broken MIDI Learn Bindings (Finding 5)', () => {
  it('produces valid supported MidiMapping bindings from MidiLearnModal and MidiControllerModal helpers', () => {
    const state = createDefaultProjectState();

    // 1. MidiLearnModal helpers: fx_param (Filter Cutoff) must resolve to a channel id and paramName 'filterCutoff'
    const buildMidiLearnMapping = (midiLearnModalModule as any).buildMidiLearnMapping;
    assert.equal(typeof buildMidiLearnMapping, 'function', 'buildMidiLearnMapping must be exported from MidiLearnModal');

    // Even if previous selectedTargetId was 0 (from master_vol), switching to fx_param normalizes to ch-1 + filterCutoff
    const cutoffMapping = buildMidiLearnMapping(
      74,
      'fx_param',
      0,
      state.channels,
      state.mixerTracks,
    );
    const cutoffResolution = resolveMidiCcTarget(cutoffMapping, state);
    assert.equal(cutoffResolution.status, 'supported', 'MidiLearnModal Filter Cutoff mapping must be supported by resolveMidiCcTarget');

    // 2. MidiControllerModal Quick Arm targets: all 4 quick-arm buttons must resolve as supported
    const buildQuickArmTargets = (midiControllerModalModule as any).buildQuickArmTargets;
    assert.equal(typeof buildQuickArmTargets, 'function', 'buildQuickArmTargets must be exported from MidiControllerModal');

    const quickTargets = buildQuickArmTargets(state.channels[0], state.mixerTracks);
    assert.equal(quickTargets.length, 4, 'MidiControllerModal exposes 4 quick-arm targets');
    for (const target of quickTargets) {
      const mapping = { ...target, ccNumber: 21 };
      const resolved = resolveMidiCcTarget(mapping, state);
      assert.equal(
        resolved.status,
        'supported',
        `Quick-arm target (${target.targetType}:${String(target.targetId)}:${String(target.paramName)}) must be supported`,
      );
    }
  });
});

describe('Phase 61 Priority 5 — channel_vol Automation Reaches Sustaining Voices & Affiliated Audio Clips', () => {
  it('modulates sustaining voices and channel-affiliated audio clips in real time during live and offline channel_vol automation without double-scaling', async () => {
    const ctx = setupLiveGraph();
    const channel = makeChannel('ch-vol-auto', {
      volume: 0.8,
      pan: 0,
      synthParams: {
        ...audioEngine.getDefaultSynthParams(),
        osc1Type: 'sawtooth',
        osc2Type: 'square',
        osc2Detune: 10,
        filterCutoff: 4000,
        filterResonance: 1,
        attack: 0.005,
        decay: 0.01,
        sustain: 1,
        release: 0.2,
      },
    });
    const activeChannels = [structuredClone(channel)];
    const activeTracks = makeMixerTracks();

    engine.activeChannels = activeChannels;
    engine.playbackProjectChannels = [structuredClone(channel)];
    engine.activeMixerTracks = activeTracks;
    engine.playbackProjectMixerTracks = structuredClone(activeTracks);

    // Start a sustaining synth voice at t=0
    audioEngine.playSingleVoice(activeChannels[0], makeNote(60, { duration: 4 }), 0);
    const initialBuf = ctx.renderWindow(0.05, 0.02);
    const initialEnergy = bufferEnergy(initialBuf);
    assert.ok(initialEnergy > 0, 'sustaining voice produces audio at initial volume 0.8');

    // Automate channel_vol to 0 at t=0.05 -> sustaining voice must become silent immediately
    ctx.currentTime = 0.05;
    audioEngine.applyAutomationValue({ type: 'channel_vol', targetId: channel.id }, 0, activeChannels, activeTracks, 0.05);
    const mutedAutoBuf = ctx.renderWindow(0.05, 0.06);
    assert.ok(bufferEnergy(mutedAutoBuf) < 1e-9, 'channel_vol automation at 0 must silence in-flight sustaining voice');

    // Reset automation target -> sustaining voice returns to initial volume 0.8
    ctx.currentTime = 0.12;
    engine.resetActiveAutomationTarget({ type: 'channel_vol', targetId: channel.id });
    const restoredBuf = ctx.renderWindow(0.05, 0.13);
    assert.ok(Math.abs(bufferEnergy(restoredBuf) - initialEnergy) < initialEnergy * 0.05, 'resetting channel_vol restores initial voice energy');

    // Offline Song render: channel-affiliated audio clip + channel_vol automation at y=0 -> silent
    const audioClip: PlaylistClip = {
      id: 'clip-vol-auto',
      name: 'Audio Vol Auto',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 1,
      type: 'audio',
      channelId: channel.id,
      audioBufferId: 'sample-clip-1',
      color: '#00e5ff',
    };
    const volZeroAutoClip: PlaylistClip = {
      id: 'auto-vol-zero',
      name: 'Vol Zero',
      trackIndex: 1,
      startBar: 0,
      lengthBars: 1,
      type: 'automation',
      color: '#ff6e00',
      automationTarget: { type: 'channel_vol', targetId: channel.id },
      automationPoints: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
    };

    const offlineSilent = await audioEngine.renderTimelineOffline(
      [channel],
      [audioClip, volZeroAutoClip],
      makeMixerTracks(),
      BPM,
      1,
      SAMPLE_RATE,
      false,
      'song',
      undefined,
      undefined,
      undefined,
      0.1,
    );
    assert.ok(bufferEnergy(offlineSilent) < 1e-9, 'offline channel_vol automation at y=0 silences channel-affiliated audio clip');
  });
});

describe('Phase 63 — MIDI channel-aware voice ownership', () => {
  function attachMidiRuntime() {
    const channel = makeChannel('ch-midi-channel-aware');
    const state = {
      ...createDefaultProjectState(),
      channels: [channel],
      selectedChannelId: channel.id,
    };
    const MidiNoteInputRuntime = (midiMappingRuntimeModule as any).MidiNoteInputRuntime;
    const runtime = new MidiNoteInputRuntime({
      getProjectState: () => state,
      getSelectedChannelId: () => channel.id,
      playNote: (
        targetChannel: Channel,
        note: Note,
        startTime?: number,
        bpm?: number,
        midiChannel?: number,
      ) => (audioEngine as any).playNote(targetChannel, note, startTime, bpm, midiChannel),
      stopChannelNote: (channelId: string, pitch: number, midiChannel?: number) =>
        (audioEngine as any).stopChannelNote(channelId, pitch, midiChannel),
    });
    const listener = (event: any) => runtime.handleMidiEvent(event);
    audioEngine.addMidiListener(listener);
    return { runtime, listener };
  }

  function sendRawMidi(status: number, pitch: number, velocity: number) {
    engine.handleMidiMessage({ data: new Uint8Array([status, pitch, velocity]) });
  }

  it('releases only the originating channel voice and preserves velocity-zero note-off', () => {
    setupLiveGraph();
    const previousVoiceChannelVolumes = engine.activeVoiceChannelVolumes;
    engine.activeVoiceChannelVolumes = new Map();
    const { runtime, listener } = attachMidiRuntime();

    try {
      sendRawMidi(0x90, 60, 100); // MIDI channel 1, noteOn
      sendRawMidi(0x91, 60, 100); // MIDI channel 2, same pitch
      assert.equal(engine.activeVoices.size, 2, 'both channel-specific voices should be active');
      assert.equal((runtime as any).heldNotes.size, 2, 'both MIDI channel/pitch pairs should be held');

      sendRawMidi(0x80, 60, 0); // MIDI channel 1, noteOff
      assert.equal(engine.activeVoices.size, 1, 'channel 2 voice must remain active after channel 1 noteOff');
      assert.equal((runtime as any).heldNotes.size, 1, 'channel 2 note must remain held');

      sendRawMidi(0x81, 60, 0); // MIDI channel 2, noteOff
      assert.equal(engine.activeVoices.size, 0, 'channel 2 noteOff must release its remaining voice');
      assert.equal((runtime as any).heldNotes.size, 0, 'all channel-specific held-note state must clear');

      sendRawMidi(0x90, 60, 100);
      assert.equal(engine.activeVoices.size, 1, 'a subsequent single-channel noteOn still starts a voice');
      sendRawMidi(0x90, 60, 0); // velocity-zero noteOn == noteOff
      assert.equal(engine.activeVoices.size, 0, 'velocity-zero noteOn must release the held voice');
      assert.equal((runtime as any).heldNotes.size, 0, 'velocity-zero release clears held-note state');
    } finally {
      runtime.releaseAllNotes();
      audioEngine.removeMidiListener(listener);
      engine.activeVoiceChannelVolumes = previousVoiceChannelVolumes;
    }
  });

  it('survives rapid overlapping same-pitch channel bursts and preserves polyphonic release', () => {
    setupLiveGraph();
    const previousVoiceChannelVolumes = engine.activeVoiceChannelVolumes;
    engine.activeVoiceChannelVolumes = new Map();
    const { runtime, listener } = attachMidiRuntime();

    try {
      for (let i = 0; i < 64; i++) {
        const pitch = 60 + (i % 4);
        sendRawMidi(0x90, pitch, 100);
        sendRawMidi(0x91, pitch, 96);
        assert.equal(engine.activeVoices.size, 2, `burst ${i}: both channel voices start`);
        sendRawMidi(0x80, pitch, 0);
        assert.equal(engine.activeVoices.size, 1, `burst ${i}: channel 2 voice survives channel 1 noteOff`);
        sendRawMidi(0x91, pitch, 0);
        assert.equal(engine.activeVoices.size, 0, `burst ${i}: channel 2 velocity-zero noteOff clears the final voice`);
        assert.equal((runtime as any).heldNotes.size, 0, `burst ${i}: held-note state is empty`);
      }

      for (let pitch = 48; pitch < 60; pitch++) sendRawMidi(0x90, pitch, 100);
      assert.equal(engine.activeVoices.size, 12, 'single-channel polyphonic note-ons remain independent');
      for (let pitch = 48; pitch < 60; pitch++) sendRawMidi(0x80, pitch, 0);
      assert.equal(engine.activeVoices.size, 0, 'polyphonic note-offs release every voice');
      assert.equal(engine.activeVoiceChannelVolumes.size, 0, 'voice trim bookkeeping is fully cleaned');
    } finally {
      runtime.releaseAllNotes();
      audioEngine.removeMidiListener(listener);
      engine.activeVoiceChannelVolumes = previousVoiceChannelVolumes;
    }
  });
});

describe('Phase 61 Priority 6 — Muted Playlist Lane Automation Parity', () => {
  it('skips automation clips on muted playlist lanes in live playback, seek rebase, and offline WAV export', async () => {
    setupLiveGraph();
    const channel = makeChannel('ch-lane-auto', { volume: 0.8, pan: 0 });
    const patClip: PlaylistClip = {
      id: 'pat-lane-0',
      name: 'Pattern Lane 0',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 1,
      type: 'pattern',
      channelId: channel.id,
      color: '#00e5ff',
    };
    // Automation clip on Lane 1 that would pan hard right (y=1 -> +1) if not lane-muted
    const mutedLaneAutoClip: PlaylistClip = {
      id: 'auto-lane-1',
      name: 'Muted Lane Pan Right',
      trackIndex: 1,
      startBar: 0,
      lengthBars: 1,
      type: 'automation',
      color: '#ff6e00',
      automationTarget: { type: 'channel_pan', targetId: channel.id },
      automationPoints: [
        { x: 0, y: 1 },
        { x: 1, y: 1 },
      ],
    };
    const playlistTracks: PlaylistTrack[] = [
      { id: 0, name: 'Lane 1', color: '#00e5ff', volume: 1, pan: 0, mute: false, solo: false },
      { id: 1, name: 'Lane 2 (Muted)', color: '#ff6e00', volume: 1, pan: 0, mute: true, solo: false },
    ];

    const offlineBuf = await audioEngine.renderTimelineOffline(
      [channel],
      [patClip, mutedLaneAutoClip],
      makeMixerTracks(),
      BPM,
      1,
      SAMPLE_RATE,
      false,
      'song',
      undefined,
      undefined,
      playlistTracks,
      0.1,
    );

    // Since Lane 1 is muted, channel_pan automation must NOT pan hard right; L and R must remain balanced (pan=0)
    const energyL = bufferEnergy(offlineBuf, 0);
    const energyR = bufferEnergy(offlineBuf, 1);
    assert.ok(energyL > 0 && energyR > 0, 'center-panned channel produces energy on both L and R when automation lane is muted');
    assert.ok(Math.abs(energyL - energyR) < 1e-6, 'muted playlist lane automation clip must not pan the channel');

    // Live mid-take lane mute resets the automation target back to project baseline (pan=0)
    setupLiveGraph();
    const transport = attachFakeTransport('song', 0.5);
    const unmutedTracks: PlaylistTrack[] = [
      { id: 0, name: 'Lane 1', color: '#00e5ff', volume: 1, pan: 0, mute: false, solo: false },
      { id: 1, name: 'Lane 2', color: '#ff6e00', volume: 1, pan: 0, mute: false, solo: false },
    ];
    audioEngine.play([channel], [patClip, mutedLaneAutoClip], 'song', undefined, makeMixerTracks(), undefined, unmutedTracks);
    engine.currentBar = 1;
    engine.currentStep = 0;
    engine.triggerCurrentStep(0);
    assert.equal(engine.activeChannels[0].pan, 1, 'unmuted automation lane sets activeChannel.pan to +1');

    // Mute Lane 1 mid-take -> activeChannel.pan resets to project baseline (0)
    audioEngine.synchronizePlaybackState({ playlistTracks });
    assert.equal(engine.activeChannels[0].pan, 0, 'muting automation lane mid-take resets activeChannel.pan to project baseline 0');

    // Unmute Lane 1 mid-take -> rebases automation at current playhead (pan=+1)
    transport.setPositionSeconds(0.5);
    audioEngine.synchronizePlaybackState({ playlistTracks: unmutedTracks });
    assert.equal(engine.activeChannels[0].pan, 1, 'unmuting automation lane mid-take rebases automation at current position');
  });

  it('prunes stale channelPanners and mixerChannels when starting a new take after channels/tracks were removed', () => {
    setupLiveGraph();
    attachFakeTransport('pat', 0);

    const chA = makeChannel('ch-prune-a', { mixerTrackId: 1 });
    const chB = makeChannel('ch-prune-b', { mixerTrackId: 2 });
    audioEngine.updateChannel(chA);
    audioEngine.updateChannel(chB);
    assert.ok(audioEngine.getChannelPanner(chA.id), 'chA panner created');
    assert.ok(audioEngine.getChannelPanner(chB.id), 'chB panner created');
    assert.equal(engine.mixerChannels.has(2), true, 'mixer track 2 exists');

    // Start take with only chA and only Master + Track 1 -> chB panner and Track 2 mixer channel are pruned
    const reducedTracks = makeMixerTracks().filter(t => t.id !== 2);
    audioEngine.play([chA], [], 'pat', undefined, reducedTracks);
    assert.equal(audioEngine.getChannelPanner(chB.id), undefined, 'stale chB panner pruned');
    assert.equal(engine.mixerChannels.has(2), false, 'stale mixer track 2 pruned');
  });
});
