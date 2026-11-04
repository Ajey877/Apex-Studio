import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { audioEngine, type MidiEventPayload } from './audioEngine';
import {
  MidiCcMappingRuntime,
  MidiNoteInputRuntime,
  resolveMidiLearnCapture,
} from './midiMappingRuntime';
import { MidiPerformanceRecorder } from './midiRecording';
import { createDefaultProjectState } from '../state/projectState';
import { buildStandardMidiFile } from '../utils/exportUtils';
import { describeExternalMidiExportNotice } from '../components/ExportModal';
import type { Channel, MixerTrack, Note, Pattern, PlaylistClip, ProjectState } from '../types/daw';

const SAMPLE_RATE = 8000;
const BPM = 120; // 1 sixteenth step = 0.125 s = 125 ms

interface SentMidiPacket {
  bytes: number[];
  timestamp?: number;
}

class FakeMidiInputPort {
  readonly id: string;
  readonly name: string;
  readonly manufacturer: string;
  readonly type = 'input' as const;
  state: 'connected' | 'disconnected' = 'connected';
  connection: 'open' | 'closed' = 'open';
  onmidimessage: ((event: { data: Uint8Array }) => void) | null = null;

  constructor(id: string, name = id, manufacturer = 'Arturia') {
    this.id = id;
    this.name = name;
    this.manufacturer = manufacturer;
  }

  emit(bytes: number[]): void {
    this.onmidimessage?.({ data: new Uint8Array(bytes) });
  }
}

class FakeMidiOutputPort {
  readonly id: string;
  readonly name: string;
  readonly manufacturer: string;
  readonly type = 'output' as const;
  state: 'connected' | 'disconnected';
  connection: 'open' | 'closed' | 'pending';
  readonly sent: SentMidiPacket[] = [];
  readonly wireQueue: Array<SentMidiPacket & { cancelledAtPerfMs: number | null }> = [];
  clearCalls = 0;
  openCalls = 0;
  failOpen = false;

  constructor(
    id: string,
    options: {
      name?: string;
      manufacturer?: string;
      state?: 'connected' | 'disconnected';
      connection?: 'open' | 'closed' | 'pending';
      failOpen?: boolean;
    } = {},
  ) {
    this.id = id;
    this.name = options.name ?? id;
    this.manufacturer = options.manufacturer ?? 'Sequential';
    this.state = options.state ?? 'connected';
    this.connection = options.connection ?? 'open';
    this.failOpen = options.failOpen ?? false;
  }

  async open(): Promise<FakeMidiOutputPort> {
    this.openCalls += 1;
    if (this.failOpen) {
      throw new Error(`Hardware port ${this.name} locked by another application`);
    }
    if (this.state === 'connected') {
      this.connection = 'open';
    }
    return this;
  }

  send(data: number[] | Uint8Array, timestamp?: number): void {
    if (this.state !== 'connected' || this.connection !== 'open') {
      throw new Error(`Port ${this.id} not open (${this.state}/${this.connection})`);
    }
    const bytes = Array.from(data);
    this.sent.push({ bytes, timestamp });
    this.wireQueue.push({ bytes, timestamp, cancelledAtPerfMs: null });
  }

  clear(): void {
    this.clearCalls += 1;
    const now = performance.now();
    for (const pkt of this.wireQueue) {
      if (pkt.cancelledAtPerfMs === null && pkt.timestamp !== undefined && pkt.timestamp > now) {
        pkt.cancelledAtPerfMs = now;
      }
    }
  }

  getDeliveredWirePackets(): SentMidiPacket[] {
    return this.wireQueue
      .filter(pkt => pkt.cancelledAtPerfMs === null)
      .map(({ bytes, timestamp }) => ({ bytes, timestamp }));
  }
}

interface FakeMidiAccess {
  inputs: Map<string, FakeMidiInputPort>;
  outputs: Map<string, FakeMidiOutputPort>;
  onstatechange: ((event: { port: FakeMidiInputPort | FakeMidiOutputPort }) => void) | null;
}

class SimAudioParam {
  value: number;
  readonly events: Array<{ type: string; value: number; time: number }> = [];
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
  setTargetAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ type: 'target', value, time });
  }
  cancelScheduledValues(fromTime: number): void {
    for (let i = this.events.length - 1; i >= 0; i -= 1) {
      if (this.events[i].time >= fromTime) this.events.splice(i, 1);
    }
  }
  valueAt(time: number): number {
    if (this.events.length === 0) return this.value;
    let current = this.events[0].value;
    for (const ev of this.events) {
      if (ev.time <= time + 1e-6) current = ev.value;
    }
    return current;
  }
}

class SimNode {
  readonly kind: string;
  readonly ctx: SimAudioContext;
  readonly connections: SimNode[] = [];
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
  connect(dest: SimNode | SimAudioParam): SimNode {
    if (dest instanceof SimNode && !this.connections.includes(dest)) {
      this.connections.push(dest);
    }
    return dest instanceof SimNode ? dest : this;
  }
  disconnect(dest?: SimNode): void {
    if (!dest) {
      this.connections.length = 0;
      return;
    }
    const idx = this.connections.indexOf(dest);
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
  addEventListener(): void {}
  removeEventListener(): void {}
  getFloatTimeDomainData(arr: Float32Array): void {
    arr.fill(0);
  }
  getByteFrequencyData(arr: Uint8Array): void {
    arr.fill(0);
  }
  getByteTimeDomainData(arr: Uint8Array): void {
    arr.fill(128);
  }
}

class SimAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  private readonly chData: Float32Array[];

  constructor(numberOfChannels: number, length: number, sampleRate: number) {
    this.numberOfChannels = numberOfChannels;
    this.length = Math.max(1, length);
    this.sampleRate = sampleRate;
    this.duration = this.length / sampleRate;
    this.chData = Array.from({ length: numberOfChannels }, () => new Float32Array(this.length));
  }
  getChannelData(ch: number): Float32Array {
    return this.chData[ch] ?? this.chData[0];
  }
}

class SimAudioContext {
  static perfBaseMs = 10_000;
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
  }

  getOutputTimestamp(): { contextTime: number; performanceTime: number } {
    if (this.currentTime <= 0) return { contextTime: 0, performanceTime: 0 };
    return {
      contextTime: this.currentTime,
      performanceTime: SimAudioContext.perfBaseMs + this.currentTime * 1000,
    };
  }

  private track(kind: string): SimNode {
    const node = new SimNode(kind, this);
    this.nodes.push(node);
    return node;
  }
  createGain(): SimNode { return this.track('gain'); }
  createStereoPanner(): SimNode { return this.track('panner'); }
  createOscillator(): SimNode { return this.track('oscillator'); }
  createBufferSource(): SimNode { return this.track('bufferSource'); }
  createBiquadFilter(): SimNode { return this.track('filter'); }
  createWaveShaper(): SimNode { return this.track('waveshaper'); }
  createDelay(): SimNode { return this.track('delay'); }
  createConvolver(): SimNode { return this.track('convolver'); }
  createDynamicsCompressor(): SimNode { return this.track('compressor'); }
  createAnalyser(): SimNode { return this.track('analyser'); }
  createPeriodicWave(): Record<string, never> { return {}; }
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    return new SimAudioBuffer(channels, length, sampleRate) as unknown as AudioBuffer;
  }
  resume(): Promise<void> { return Promise.resolve(); }

  private findPaths(start: SimNode): SimNode[][] {
    const results: SimNode[][] = [];
    const visit = (node: SimNode, path: SimNode[], seen: Set<SimNode>) => {
      if (node === this.destination) {
        results.push(path);
        return;
      }
      for (const target of node.connections) {
        if (seen.has(target)) continue;
        seen.add(target);
        visit(target, [...path, target], seen);
        seen.delete(target);
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
      const paths = this.findPaths(source);
      const startSample = Math.max(0, Math.floor(source.startTime * this.sampleRate));
      const endSample = Math.min(
        this.length,
        Number.isFinite(source.stopTime) ? Math.ceil(source.stopTime * this.sampleRate) : this.length,
      );
      if (endSample <= startSample) continue;
      for (const path of paths) {
        for (let i = startSample; i < endSample; i += 1) {
          const sampleTime = i / this.sampleRate;
          let gainMul = 1;
          for (const node of path) {
            if (node.kind === 'gain') gainMul *= Math.max(0, node.gain.valueAt(sampleTime));
          }
          if (gainMul <= 1e-5) continue;
          const s = Math.sin((2 * Math.PI * 220 * i) / this.sampleRate) * gainMul;
          outL[i] += s;
          outR[i] += s;
        }
      }
    }
    return out as unknown as AudioBuffer;
  }
}

function bufferEnergy(buffer: AudioBuffer): number {
  let sum = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
  }
  return sum;
}

const engine = audioEngine as any;
const realWindow = (globalThis as any).window;
const realOfflineAudioContext = (globalThis as any).OfflineAudioContext;
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalPerformanceNow = performance.now.bind(performance);

const SAVED_ENGINE_FIELDS = [
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
  'bpm',
  'midiAccess',
  'midiAccessStatus',
  'midiAccessError',
] as const;

const savedEngineState: Record<string, unknown> = {};
let scheduledTimers = new Map<number, () => void>();
let nextTimerId = 1;
let simulatedPerfMs = 10_000;

function makeMixerTracks(): MixerTrack[] {
  return [
    { id: 0, name: 'Master', color: '#fff', volume: 0.9, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
    { id: 1, name: 'Insert 1', color: '#0ff', volume: 0.9, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
    { id: 2, name: 'Insert 2', color: '#f80', volume: 0.9, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
  ];
}

function makeChannel(id: string, overrides: Partial<Channel> = {}): Channel {
  const base = createDefaultProjectState().channels.find(c => c.instrumentType === 'minisynth') ?? createDefaultProjectState().channels[0];
  return {
    ...base,
    id,
    name: id,
    instrumentType: 'minisynth',
    mixerTrackId: 1,
    volume: 0.85,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps: new Array(16).fill(false),
    notes: [],
    midiOutput: {
      outputDeviceId: null,
      midiChannel: 1,
      mode: 'off',
    },
    ...overrides,
  };
}

function makeNote(pitch: number, start: number, duration: number, velocity = 0.85): Note {
  return {
    id: `note-${pitch}-${start}`,
    pitch,
    start,
    duration,
    velocity,
  };
}

function setupLiveEngine(tracks: MixerTrack[] = makeMixerTracks()): SimAudioContext {
  const ctx = new SimAudioContext(2, SAMPLE_RATE * 4, SAMPLE_RATE);
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
  engine.transport = null;
  audioEngine.setBpm(BPM);
  for (const t of tracks) {
    audioEngine.updateMixerTrack(t);
  }
  return ctx;
}

function advanceClock(ctx: SimAudioContext, deltaSeconds: number, stepSlices = 8): void {
  const dt = deltaSeconds / stepSlices;
  for (let i = 0; i < stepSlices; i += 1) {
    ctx.currentTime += dt;
    simulatedPerfMs = SimAudioContext.perfBaseMs + ctx.currentTime * 1000;
    const callbacks = [...scheduledTimers.entries()];
    scheduledTimers.clear();
    for (const [, cb] of callbacks) {
      cb();
    }
  }
}

async function installMidiAccess(access: FakeMidiAccess): Promise<void> {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { requestMIDIAccess: async () => access } as unknown as Navigator,
  });
  await audioEngine.initMidi();
}

beforeEach(() => {
  simulatedPerfMs = 10_000;
  SimAudioContext.perfBaseMs = 10_000;
  scheduledTimers = new Map();
  nextTimerId = 1;
  for (const field of SAVED_ENGINE_FIELDS) {
    savedEngineState[field] = engine[field];
  }
  engine.midiOutputScheduler.cleanupAll('shutdown');
  engine.midiOutputScheduler.resetDeviceErrors();
  performance.now = () => simulatedPerfMs;
  (globalThis as any).window = {
    ...(realWindow ?? {}),
    AudioContext: SimAudioContext,
    OfflineAudioContext: SimAudioContext,
    setTimeout: (cb: () => void) => {
      const id = nextTimerId++;
      scheduledTimers.set(id, cb);
      return id;
    },
    clearTimeout: (id: number) => {
      scheduledTimers.delete(id);
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  (globalThis as any).OfflineAudioContext = SimAudioContext;
});

afterEach(async () => {
  audioEngine.stop();
  await audioEngine.releaseNativeInstruments();
  engine.midiOutputScheduler.cleanupAll('shutdown');
  performance.now = originalPerformanceNow;
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, 'navigator');
  }
  (globalThis as any).window = realWindow;
  (globalThis as any).OfflineAudioContext = realOfflineAudioContext;
  for (const field of SAVED_ENGINE_FIELDS) {
    engine[field] = savedEngineState[field];
  }
});

describe('AudioEngine External MIDI Output — discovery, usability, playback, modes, cleanup, export, and regressions', () => {
  it('1. discovers separated input/output devices, verifies open() usability, and recovers from denied → granted → revoked → re-granted permission', async () => {
    const input = new FakeMidiInputPort('in-keystep', 'Arturia KeyStep 37', 'Arturia');
    const readyOut = new FakeMidiOutputPort('out-prophet', {
      name: 'Prophet-6 USB',
      manufacturer: 'Sequential',
      connection: 'closed', // Enumerated closed initially until initMidi opens it!
    });
    const lockedOut = new FakeMidiOutputPort('out-locked', {
      name: 'Locked USB MIDI',
      manufacturer: 'Generic',
      connection: 'closed',
      failOpen: true,
    });

    const access: FakeMidiAccess = {
      inputs: new Map([[input.id, input]]),
      outputs: new Map([
        [readyOut.id, readyOut],
        [lockedOut.id, lockedOut],
      ]),
      onstatechange: null,
    };

    await installMidiAccess(access);
    assert.equal(audioEngine.getMidiAccessState().status, 'ready');
    assert.ok(readyOut.openCalls >= 1, 'initMidi opens connected output ports proactively');

    const devices = audioEngine.getConnectedMidiDevices();
    const prophetInfo = devices.find(d => d.id === 'out-prophet');
    const lockedInfo = devices.find(d => d.id === 'out-locked');
    const keystepInfo = devices.find(d => d.id === 'in-keystep');

    assert.ok(keystepInfo && keystepInfo.type === 'input' && keystepInfo.usable === true);
    assert.ok(prophetInfo && prophetInfo.type === 'output' && prophetInfo.usable === true);
    assert.ok(
      lockedInfo && lockedInfo.type === 'output' && lockedInfo.usable === false,
      'port whose open() failed must NOT be reported usable/Ready',
    );
    assert.match(lockedInfo!.statusReason ?? '', /locked/i);

    const denyMidiPermission = async () => {
      const err = new Error('User denied MIDI permission');
      err.name = 'NotAllowedError';
      throw err;
    };
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { requestMIDIAccess: denyMidiPermission } as unknown as Navigator,
    });
    await audioEngine.initMidi();
    assert.equal(audioEngine.getMidiAccessState().status, 'denied', 'OS/browser denial is reported');

    // Re-grant after denial, then revoke and re-grant again. Each grant must
    // rebuild usable output access without substituting or retaining stale state.
    readyOut.connection = 'closed';
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { requestMIDIAccess: async () => access } as unknown as Navigator,
    });
    await audioEngine.initMidi();
    assert.equal(audioEngine.getMidiAccessState().status, 'ready');
    assert.ok(readyOut.openCalls >= 2, 're-grant reopens the configured output');

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { requestMIDIAccess: denyMidiPermission } as unknown as Navigator,
    });
    await audioEngine.initMidi();
    assert.equal(audioEngine.getMidiAccessState().status, 'denied', 'a later permission revocation is reported');

    readyOut.connection = 'closed';
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { requestMIDIAccess: async () => access } as unknown as Navigator,
    });
    await audioEngine.initMidi();
    assert.equal(audioEngine.getMidiAccessState().status, 'ready', 'MIDI output works after a second re-grant');
    assert.ok(readyOut.openCalls >= 3, 'second re-grant reopens the selected output');
  });

  it('2–4. transmits timestamped Note On & Note Off messages from real Pattern and Song playback with exact channels (1–16), velocities, and durations', async () => {
    const ctx = setupLiveEngine();
    const synthOut = new FakeMidiOutputPort('out-synth', { name: 'Moog Sub 37' });
    await installMidiAccess({
      inputs: new Map(),
      outputs: new Map([[synthOut.id, synthOut]]),
      onstatechange: null,
    });

    const ch = makeChannel('ch-sub37', {
      midiOutput: { outputDeviceId: synthOut.id, midiChannel: 10, mode: 'external' },
      notes: [
        makeNote(36, 0, 1, 1.0),   // Step 0, 1 step (125 ms), vel 127, Ch 10 -> 0x99 / 0x89
        makeNote(48, 2, 2, 0.5),   // Step 2, 2 steps (250 ms), vel 64, Ch 10 -> 0x99 / 0x89
      ],
    });
    const tracks = makeMixerTracks();

    // Pattern mode playback through real AudioClockTransport:
    try {
      audioEngine.play([ch], [], 'pat', 'pat-1', tracks, 4);
      advanceClock(ctx, 0.55, 12);
    } finally {
      audioEngine.stop();
      await audioEngine.releaseNativeInstruments();
    }

    const patNoteOns = synthOut.sent.filter(p => p.bytes[0] === 0x99);
    const patNoteOffs = synthOut.sent.filter(p => p.bytes[0] === 0x89);
    assert.ok(patNoteOns.length >= 2, 'transmitted Note Ons on MIDI Channel 10 (0x99)');
    assert.deepEqual(patNoteOns[0].bytes, [0x99, 36, 127]);
    assert.deepEqual(patNoteOns[1].bytes, [0x99, 48, 64]);

    const firstOff = patNoteOffs.find(p => p.bytes[1] === 36)!;
    const secondOff = patNoteOffs.find(p => p.bytes[1] === 48)!;
    assert.ok(firstOff && secondOff);
    assert.ok(Math.abs((firstOff.timestamp! - patNoteOns[0].timestamp!) - 125) < 1e-3, '1 step @ 120 BPM = 125 ms');
    assert.ok(Math.abs((secondOff.timestamp! - patNoteOns[1].timestamp!) - 250) < 1e-3, '2 steps @ 120 BPM = 250 ms');

    // Song mode playback with pattern clip in playlist:
    synthOut.sent.length = 0;
    const songCh = makeChannel('ch-lead', {
      midiOutput: { outputDeviceId: synthOut.id, midiChannel: 4, mode: 'external' },
      notes: [makeNote(60, 0, 2, 0.9)],
    });
    const pattern: Pattern = {
      id: 'pat-1',
      name: 'Pattern 1',
      color: '#00e5ff',
      lengthSteps: 16,
    };
    const clip: PlaylistClip = {
      id: 'clip-1',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 1,
      type: 'pattern',
      patternId: 'pat-1',
      channelId: songCh.id,
      name: 'Pattern 1',
      color: '#00e5ff',
    };

    try {
      audioEngine.play([songCh], [clip], 'song', 'pat-1', tracks, 16, [], [pattern]);
      advanceClock(ctx, 0.5, 10);
    } finally {
      audioEngine.stop();
      await audioEngine.releaseNativeInstruments();
    }

    const songOn = synthOut.sent.find(p => p.bytes[0] === 0x93 && p.bytes[1] === 60);
    const songOff = synthOut.sent.find(p => p.bytes[0] === 0x83 && p.bytes[1] === 60);
    assert.ok(songOn, 'Song mode playlist clip emitted Note On on MIDI Ch 4 (0x93)');
    assert.ok(songOff, 'Song mode playlist clip emitted Note Off on MIDI Ch 4 (0x83)');
    assert.ok(Math.abs((songOff!.timestamp! - songOn!.timestamp!) - 250) < 1e-3);
  });

  it('5. enforces Off vs Mirror vs External-only voice routing in live playback AND offline WAV/stem/MIDI exports', async () => {
    const ctx = setupLiveEngine();
    const outPort = new FakeMidiOutputPort('out-ob6', { name: 'OB-6' });
    await installMidiAccess({
      inputs: new Map(),
      outputs: new Map([[outPort.id, outPort]]),
      onstatechange: null,
    });
    const tracks = makeMixerTracks();

    // Mode 1: OFF -> internal oscillators created, 0 MIDI packets
    const offCh = makeChannel('ch-off', {
      midiOutput: { outputDeviceId: outPort.id, midiChannel: 2, mode: 'off' },
      notes: [makeNote(60, 0, 2, 0.9)],
    });
    const oscBeforeOff = ctx.nodes.filter(n => n.kind === 'oscillator').length;
    audioEngine.playNote(offCh, offCh.notes[0], ctx.currentTime, BPM);
    assert.ok(ctx.nodes.filter(n => n.kind === 'oscillator').length > oscBeforeOff, 'Off mode plays internal synth');
    assert.equal(outPort.sent.length, 0, 'Off mode sends zero external MIDI messages');

    // Mode 2: MIRROR -> internal oscillators created AND external MIDI sent
    const mirrorCh = makeChannel('ch-mirror', {
      midiOutput: { outputDeviceId: outPort.id, midiChannel: 2, mode: 'mirror' },
      notes: [makeNote(64, 0, 2, 0.9)],
    });
    const oscBeforeMirror = ctx.nodes.filter(n => n.kind === 'oscillator').length;
    audioEngine.playNote(mirrorCh, mirrorCh.notes[0], ctx.currentTime, BPM);
    assert.ok(ctx.nodes.filter(n => n.kind === 'oscillator').length > oscBeforeMirror, 'Mirror mode plays internal synth');
    assert.ok(outPort.sent.some(p => p.bytes[0] === 0x91 && p.bytes[1] === 64), 'Mirror mode also sends external MIDI');

    // Mode 3: EXTERNAL ONLY -> ZERO internal oscillators created, external MIDI sent!
    outPort.sent.length = 0;
    const externalCh = makeChannel('ch-external', {
      midiOutput: { outputDeviceId: outPort.id, midiChannel: 7, mode: 'external' },
      notes: [makeNote(67, 0, 2, 0.9)],
    });
    const oscBeforeExternal = ctx.nodes.filter(n => n.kind === 'oscillator').length;
    audioEngine.playNote(externalCh, externalCh.notes[0], ctx.currentTime, BPM);
    assert.equal(
      ctx.nodes.filter(n => n.kind === 'oscillator').length,
      oscBeforeExternal,
      'External-only mode strictly suppresses internal Web Audio voices',
    );
    assert.ok(outPort.sent.some(p => p.bytes[0] === 0x96 && p.bytes[1] === 67), 'External-only mode sends external MIDI on Ch 7');

    // Offline WAV & Stem export truthfulness:
    // - External-only channel renders silence (no fabricated hardware audio, no leaked internal synth)
    // - Zero hardware MIDI messages are emitted during offline renders
    outPort.sent.length = 0;
    const offlineExternalBuf = await audioEngine.renderTimelineOffline(
      [externalCh],
      [],
      tracks,
      BPM,
      1,
      SAMPLE_RATE,
      false,
      'pattern',
      undefined,
      4,
    );
    assert.equal(outPort.sent.length, 0, 'offline WAV render never transmits live hardware MIDI');
    assert.equal(
      bufferEnergy(offlineExternalBuf),
      0,
      'External-only channel produces zero leaked internal synth audio in offline WAV export',
    );

    const stemsResult = await audioEngine.renderProjectStems(
      [externalCh],
      [],
      tracks,
      BPM,
      1,
      16,
      'pattern',
      4,
    );
    assert.equal(outPort.sent.length, 0, 'offline stem export never transmits live hardware MIDI');
    const stemMasterWav = new Uint8Array(await stemsResult.master.arrayBuffer());
    const stemPcm = new Int16Array(stemMasterWav.buffer, 44, Math.floor((stemMasterWav.byteLength - 44) / 2));
    assert.equal(stemPcm.some(v => Math.abs(v) > 0), false, 'External-only stem master stays silent without leaking internal synth');

    // Mirror channel in offline render still renders its internal synth audio cleanly:
    const offlineMirrorBuf = await audioEngine.renderTimelineOffline(
      [mirrorCh],
      [],
      tracks,
      BPM,
      1,
      SAMPLE_RATE,
      false,
      'pattern',
      undefined,
      4,
    );
    assert.ok(bufferEnergy(offlineMirrorBuf) > 0, 'Mirror mode channel still renders its internal synth in offline WAV export');
    assert.equal(outPort.sent.length, 0, 'offline Mirror render also sends zero live MIDI');

    // Standard MIDI (.mid) export preserves musical note data AND writes configured MIDI channel (Ch 7 -> 0x96 / 0x86):
    const midiBlob = buildStandardMidiFile(
      [externalCh],
      [],
      { bpm: BPM, title: 'ExternalSynthTest' } as any,
      { scope: 'pattern', patternLengthSteps: 4 },
    );
    const midiBytes = new Uint8Array(await midiBlob.arrayBuffer());
    let foundCh7NoteOn = false;
    let foundCh7NoteOff = false;
    for (let i = 0; i < midiBytes.length - 2; i += 1) {
      if (midiBytes[i] === 0x96 && midiBytes[i + 1] === 67) foundCh7NoteOn = true;
      if (midiBytes[i] === 0x86 && midiBytes[i + 1] === 67) foundCh7NoteOff = true;
    }
    assert.equal(foundCh7NoteOn, true, '.mid export preserves External-only note on configured MIDI Ch 7');
    assert.equal(foundCh7NoteOff, true, '.mid export preserves Note Off on configured MIDI Ch 7');
    const notice = describeExternalMidiExportNotice([externalCh]);
    assert.ok(notice);
    assert.match(notice!.headline, /not included in offline WAV\/stem exports/i);
  });

  it('6–8. guarantees zero stuck notes across pause, stop, seek, pattern loop wrap, live BPM changes, project replacement, and shutdown', async () => {
    const ctx = setupLiveEngine();
    const outPort = new FakeMidiOutputPort('out-rev2', { name: 'Prophet Rev2' });
    await installMidiAccess({
      inputs: new Map(),
      outputs: new Map([[outPort.id, outPort]]),
      onstatechange: null,
    });
    const tracks = makeMixerTracks();
    const ch = makeChannel('ch-pad', {
      midiOutput: { outputDeviceId: outPort.id, midiChannel: 3, mode: 'external' },
      notes: [makeNote(60, 0, 8, 0.85)], // Long 8-step note (1000 ms @ 120 BPM)
    });

    try {
      // Start take, let 8-step note start sounding on step 0, then PAUSE mid-note:
      audioEngine.play([ch], [], 'pat', 'pat-1', tracks, 8);
      advanceClock(ctx, 0.15, 4);
      assert.equal(audioEngine.getActiveExternalMidiNoteCount(), 1);

      audioEngine.pause();
      assert.equal(audioEngine.getActiveExternalMidiNoteCount(), 0, 'pause cleans up active MIDI notes immediately');
      assert.ok(outPort.clearCalls >= 1, 'pause invokes MIDIOutput.clear()');
      assert.ok(outPort.sent.some(p => p.bytes[0] === 0x82 && p.bytes[1] === 60), 'pause sends explicit Note Off');
      assert.ok(outPort.sent.some(p => p.bytes[0] === 0xb2 && p.bytes[1] === 123 && p.bytes[2] === 0), 'pause sends CC 123 All Notes Off on affected channel');

      // Resume -> SEEK while playing -> cleans up in-flight note and continues from new bar:
      outPort.sent.length = 0;
      audioEngine.play([ch], [], 'pat', 'pat-1', tracks, 16);
      advanceClock(ctx, 0.15, 4);
      assert.equal(audioEngine.getActiveExternalMidiNoteCount(), 1);

      audioEngine.seek(2); // Reposition to bar 2
      assert.ok(
        outPort.sent.some(p => p.bytes[0] === 0x82 && p.bytes[1] === 60),
        'seek cleans up sounding note from old timeline position',
      );

      // Tempo change mid-playback on a multi-step sustained note:
      audioEngine.stop();
      outPort.sent.length = 0;
      audioEngine.setBpm(120);
      const tempoCh = makeChannel('ch-tempo', {
        midiOutput: { outputDeviceId: outPort.id, midiChannel: 1, mode: 'external' },
        notes: [makeNote(72, 0, 4, 0.9)], // 4 steps: 500 ms @ 120 BPM, longer when slowed to 60 BPM!
      });
      audioEngine.play([tempoCh], [], 'pat', 'pat-1', tracks, 16);
      // Advance 1 step (0.125 s) into the 4-step note, then slow BPM 120 -> 60!
      advanceClock(ctx, 0.14, 4);
      const onPacket = outPort.sent.find(p => p.bytes[0] === 0x90 && p.bytes[1] === 72)!;
      assert.ok(onPacket);
      audioEngine.setBpm(60); // Remaining ~3 steps now take ~750 ms instead of ~375 ms!

      // Advance past the old 500 ms 120-BPM deadline (to +0.55 s total): note MUST still be open (no stale Note Off)!
      advanceClock(ctx, 0.41, 8);
      assert.equal(
        outPort.sent.some(p => p.bytes[0] === 0x80 && p.bytes[1] === 72),
        false,
        'no stale Note Off fired at the old 120-BPM deadline after slowing to 60 BPM',
      );

      // Advance through step 3 at 60 BPM so step 4 enters the horizon: Note Off fires at the new 60-BPM grid!
      advanceClock(ctx, 0.45, 8);
      const retimedOff = outPort.sent.find(p => p.bytes[0] === 0x80 && p.bytes[1] === 72);
      assert.ok(retimedOff, 'Note Off emitted on the retimed 60-BPM musical grid');
      assert.ok((retimedOff!.timestamp! - onPacket.timestamp!) > 750, 'sustained duration reflects slowed 60 BPM tempo');
    } finally {
      audioEngine.stop();
      await audioEngine.releaseNativeInstruments();
    }

    // Project replacement panic & application shutdown cleanup:
    outPort.sent.length = 0;
    audioEngine.sendChannelMidiControlChange(ch, 64, 127); // hold sustain pedal
    audioEngine.panicExternalMidi([ch]);
    assert.ok(outPort.sent.some(p => p.bytes[0] === 0xb2 && p.bytes[1] === 64 && p.bytes[2] === 0), 'panic releases CC 64 sustain');
    assert.ok(outPort.sent.some(p => p.bytes[0] === 0xb2 && p.bytes[1] === 123 && p.bytes[2] === 0), 'panic sends CC 123');

    outPort.sent.length = 0;
    audioEngine.playNote(ch, makeNote(60, 0, 2, 0.8), ctx.currentTime, 120, 1); // live held note
    assert.equal(audioEngine.getActiveExternalMidiNoteCount(), 1);
    audioEngine.shutdownMidiOutputs();
    assert.equal(audioEngine.getActiveExternalMidiNoteCount(), 0);
    assert.ok(outPort.sent.some(p => p.bytes[0] === 0x82 && p.bytes[1] === 60), 'shutdown releases held notes');
  });

  it('9. ends Song Mode with a long MIDI note active and cleans the external voice at the arrangement boundary', async () => {
    const ctx = setupLiveEngine();
    const synthOut = new FakeMidiOutputPort('out-song-end', { name: 'Song End Synth' });
    await installMidiAccess({
      inputs: new Map(),
      outputs: new Map([[synthOut.id, synthOut]]),
      onstatechange: null,
    });
    const channel = makeChannel('ch-song-end', {
      midiOutput: { outputDeviceId: synthOut.id, midiChannel: 5, mode: 'external' },
      notes: [makeNote(72, 15, 8, 0.9)], // starts on the final bar step and outlasts the arrangement
    });
    const pattern: Pattern = {
      id: 'pat-song-end',
      name: 'Song End Pattern',
      color: '#00e5ff',
      lengthSteps: 16,
    };
    const clip: PlaylistClip = {
      id: 'clip-song-end',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 1,
      type: 'pattern',
      patternId: pattern.id,
      channelId: channel.id,
      name: pattern.name,
      color: pattern.color,
    };

    try {
      audioEngine.play([channel], [clip], 'song', pattern.id, makeMixerTracks(), 16, [], [pattern]);
      advanceClock(ctx, 2.2, 44); // 1 bar @ 120 BPM ends at 2.0 s
      assert.equal(engine.isPlaying, false, 'transport stops at the actual arrangement end');
      assert.equal(audioEngine.getActiveExternalMidiNoteCount(), 0, 'song-end cleanup removes the active MIDI note');
    } finally {
      audioEngine.stop();
      await audioEngine.releaseNativeInstruments();
    }

    assert.equal(
      synthOut.sent.filter(packet => packet.bytes[0] === 0x94 && packet.bytes[1] === 72).length,
      1,
      'one Note On is sent on MIDI channel 5 for the overhanging final-step note',
    );
    assert.ok(
      synthOut.sent.some(packet => packet.bytes[0] === 0x84 && packet.bytes[1] === 72 && packet.bytes[2] === 0),
      'song-end cleanup emits a route-specific Note Off before the long scheduled release',
    );
  });

  it('11. cleans soloed-away notes and routing-mode changes during playback without leaking later Note Ons', async () => {
    const ctx = setupLiveEngine();
    const sharedOut = new FakeMidiOutputPort('out-solo-mode', { name: 'Solo Mode Synth' });
    const backupOut = new FakeMidiOutputPort('out-solo-backup', { name: 'Unused Backup Synth' });
    await installMidiAccess({
      inputs: new Map(),
      outputs: new Map([[sharedOut.id, sharedOut], [backupOut.id, backupOut]]),
      onstatechange: null,
    });
    const chA = makeChannel('ch-solo-a', {
      midiOutput: { outputDeviceId: sharedOut.id, midiChannel: 1, mode: 'external' },
      notes: [makeNote(60, 0, 4, 0.8), makeNote(61, 3, 1, 0.8)],
    });
    const chB = makeChannel('ch-solo-b', {
      midiOutput: { outputDeviceId: sharedOut.id, midiChannel: 2, mode: 'external' },
      notes: [makeNote(64, 0, 4, 0.8), makeNote(65, 2, 1, 0.8)],
    });

    try {
      audioEngine.play([chA, chB], [], 'pat', 'pat-solo-mode', makeMixerTracks(), 16);
      advanceClock(ctx, 0.13, 10);
      assert.equal(engine.midiOutputScheduler.getActiveNoteCount(chA.id), 1);
      assert.equal(engine.midiOutputScheduler.getActiveNoteCount(chB.id), 1);

      audioEngine.synchronizePlaybackState({ channels: [{ ...chA, solo: true }, chB] });
      assert.equal(engine.midiOutputScheduler.getActiveNoteCount(chA.id), 1, 'soloed channel keeps its active note');
      assert.equal(engine.midiOutputScheduler.getActiveNoteCount(chB.id), 0, 'non-solo channel is cleaned immediately');
      assert.ok(
        sharedOut.sent.some(packet => packet.bytes[0] === 0x81 && packet.bytes[1] === 64 && packet.bytes[2] === 0),
        'solo transition sends Note Off only on the non-solo channel route',
      );

      audioEngine.synchronizePlaybackState({
        channels: [
          { ...chA, solo: true, midiOutput: { outputDeviceId: sharedOut.id, midiChannel: 1, mode: 'off' } },
          chB,
        ],
      });
      assert.equal(engine.midiOutputScheduler.getActiveNoteCount(chA.id), 0, 'switching external routing Off releases its active note');
      assert.ok(
        sharedOut.sent.some(packet => packet.bytes[0] === 0x80 && packet.bytes[1] === 60 && packet.bytes[2] === 0),
        'routing-mode change emits the active note release on its original port/channel',
      );

      audioEngine.synchronizePlaybackState({
        channels: [
          { ...chA, solo: false, midiOutput: { outputDeviceId: sharedOut.id, midiChannel: 1, mode: 'off' } },
          chB,
        ],
      });
      advanceClock(ctx, 0.25, 10); // Channel B's step-2 pitch occurs; channel A's later pitch remains Off.
      assert.ok(sharedOut.sent.some(packet => packet.bytes[0] === 0x91 && packet.bytes[1] === 65),
        'a channel that becomes audible again resumes on its configured MIDI channel');
      assert.equal(sharedOut.sent.some(packet => packet.bytes[0] === 0x90 && packet.bytes[1] === 61), false,
        'the channel switched to Off does not emit a stale/future Note On');
      assert.equal(backupOut.sent.length, 0, 'solo and route edits never substitute the configured output');
    } finally {
      audioEngine.stop();
      await audioEngine.releaseNativeInstruments();
    }
  });

  it('10. handles output device hot-disconnect and reconnect cleanly without silent device substitution', async () => {
    const ctx = setupLiveEngine();
    const primaryOut = new FakeMidiOutputPort('out-primary', { name: 'Primary Synth' });
    const secondaryOut = new FakeMidiOutputPort('out-secondary', { name: 'Backup Synth' });
    const access: FakeMidiAccess = {
      inputs: new Map(),
      outputs: new Map([
        [primaryOut.id, primaryOut],
        [secondaryOut.id, secondaryOut],
      ]),
      onstatechange: null,
    };
    await installMidiAccess(access);

    const ch = makeChannel('ch-hw', {
      midiOutput: { outputDeviceId: primaryOut.id, midiChannel: 1, mode: 'external' },
      notes: Array.from({ length: 8 }, (_, s) => makeNote(60 + s, s, 1, 0.9)),
    });

    let notifications = 0;
    const unsub = audioEngine.subscribeMidiDeviceChanges(() => {
      notifications += 1;
    });

    try {
      audioEngine.play([ch], [], 'pat', 'pat-1', makeMixerTracks(), 4);
      advanceClock(ctx, 0.14, 4); // Step 0 & 1 scheduled on primaryOut
      const countBeforeUnplug = primaryOut.sent.length;
      assert.ok(countBeforeUnplug >= 2);
      audioEngine.sendChannelMidiControlChange(ch, 64, 127); // Sustain is active when the cable disappears.
      const recoveryStartIndex = primaryOut.sent.length;
      assert.ok(primaryOut.sent.some(p => p.bytes[0] === 0xb0 && p.bytes[1] === 64 && p.bytes[2] === 127));

      // Unplug primaryOut mid-playback!
      primaryOut.state = 'disconnected';
      primaryOut.connection = 'closed';
      access.onstatechange?.({ port: primaryOut });

      assert.ok(notifications >= 1, 'UI notified of MIDI output disconnect');
      const disconnectedInfo = audioEngine.getConnectedMidiDevices().find(d => d.id === primaryOut.id);
      assert.equal(disconnectedInfo?.usable, false);
      assert.equal(ch.midiOutput?.outputDeviceId, primaryOut.id, 'channel routing preserves configured outputDeviceId');

      // Advance playback while unplugged: neither primaryOut nor secondaryOut may receive substituted traffic!
      advanceClock(ctx, 0.25, 6);
      assert.equal(secondaryOut.sent.length, 0, 'NEVER silently substitutes another connected MIDI output device');

      // Reconnect primaryOut: port re-opens and resumes transmitting on subsequent steps!
      primaryOut.state = 'connected';
      access.onstatechange?.({ port: primaryOut });
      const reconnectReady = audioEngine.ensureMidiOutputPortOpen(primaryOut.id);
      // Recovery retains sustain uncertainty until the queued pedal-up timestamp
      // has passed; advance this test's deterministic performance clock while
      // the reconnect task is waiting on its safe release time.
      await Promise.resolve();
      advanceClock(ctx, 0.005, 1);
      await reconnectReady;

      const recoveryPackets = primaryOut.sent.slice(recoveryStartIndex);
      assert.ok(
        recoveryPackets.some(p => p.bytes[0] === 0xb0 && p.bytes[1] === 64 && p.bytes[2] === 0),
        'reconnect sends CC64=0 only on the previously sustained channel',
      );
      assert.ok(
        recoveryPackets.some(p => p.bytes[0] === 0x80 && p.bytes[1] === 60 && p.bytes[2] === 0),
        'reconnect sends an explicit Note Off for the active primary-output pitch',
      );
      assert.equal(
        recoveryPackets.some(p => (p.bytes[0] & 0xf0) === 0xb0 && p.bytes[1] === 123),
        false,
        'reconnect does not use channel-wide All Notes Off',
      );
      assert.equal(secondaryOut.sent.length, 0, 'recovery never spills to the backup output');
      assert.equal(audioEngine.getActiveExternalMidiNoteCount(), 0, 'reconnected port inherits no stale scheduler notes');

      const countBeforeResumeSteps = primaryOut.sent.length;
      advanceClock(ctx, 0.3, 6);
      assert.ok(primaryOut.sent.length > countBeforeResumeSteps, 'resumes MIDI transmission cleanly upon reconnect');
    } finally {
      unsub();
      audioEngine.stop();
      await audioEngine.releaseNativeInstruments();
    }
  });

  it('12. preserves existing MIDI input monitoring, live MIDI recording, and MIDI Learn / CC mappings without regression', async () => {
    setupLiveEngine();
    const inputPort = new FakeMidiInputPort('in-launchpad', 'Launchkey Mini');
    const externalOut = new FakeMidiOutputPort('out-minilogue', { name: 'Korg Minilogue XD' });
    const access: FakeMidiAccess = {
      inputs: new Map([[inputPort.id, inputPort]]),
      outputs: new Map([[externalOut.id, externalOut]]),
      onstatechange: null,
    };
    await installMidiAccess(access);

    let state: ProjectState = createDefaultProjectState();
    const firstChId = state.channels[0].id;
    state = {
      ...state,
      selectedChannelId: firstChId,
      channels: state.channels.map((c, idx) =>
        idx === 0
          ? {
              ...c,
              instrumentType: 'minisynth',
              midiOutput: { outputDeviceId: externalOut.id, midiChannel: 2, mode: 'mirror' },
            }
          : c,
      ),
      midiMappings: [{ ccNumber: 74, targetType: 'mixer_vol', targetId: 1, paramName: 'Insert 1 Vol' }],
    };

    const recorder = new MidiPerformanceRecorder();
    recorder.start(
      { channelId: firstChId, patternId: state.selectedPatternId, patternLengthSteps: 16, bpm: BPM },
      { positionSteps: 0 },
    );

    const noteRuntime = new MidiNoteInputRuntime({
      getProjectState: () => state,
      getSelectedChannelId: () => state.selectedChannelId,
      playNote: (ch, note, startTime, bpm, midiCh) => audioEngine.playNote(ch, note, startTime, bpm, midiCh),
      stopChannelNote: (chId, pitch, midiCh) => audioEngine.stopChannelNote(chId, pitch, midiCh),
    });

    const ccRuntime = new MidiCcMappingRuntime({
      getProjectState: () => state,
      applyProjectMutation: updater => {
        state = updater(state);
      },
      applyMasterVolume: () => undefined,
    });

    let learnedMappings = state.midiMappings;
    const listener = (event: MidiEventPayload) => {
      noteRuntime.handleMidiEvent(event);
      if (recorder.isRecording) {
        recorder.handleMidiEvent(event, { positionSteps: event.type === 'noteOn' ? 0 : 2 });
      }
      const ccRes = ccRuntime.handleMidiEvent(event);
      if (ccRes.status === 'unmapped' && ccRes.ccNumber === 64) {
        audioEngine.sendChannelMidiControlChange(
          state.channels[0],
          64,
          Math.round((event.value ?? 0) * 127),
        );
      }
      const capture = resolveMidiLearnCapture(event, learnedMappings, {
        targetType: 'master_vol',
        targetId: 'master',
      });
      if (capture && event.cc === 21) {
        learnedMappings = capture.mappings;
      }
    };

    audioEngine.addMidiListener(listener);
    try {
      // 1. Live MIDI keyboard Note On + Note Off -> monitors internally, mirrors to externalOut Ch 2, AND records note!
      inputPort.emit([0x90, 60, 100]);
      inputPort.emit([0x80, 60, 0]);
      const recordedNotes = recorder.stop({ positionSteps: 4 });
      assert.equal(recordedNotes.length, 1, 'MIDI input recording still captures performed note');
      assert.equal(recordedNotes[0].pitch, 60);
      assert.ok(externalOut.sent.some(p => p.bytes[0] === 0x91 && p.bytes[1] === 60), 'live input mirrors Note On to external synth');
      assert.ok(externalOut.sent.some(p => p.bytes[0] === 0x81 && p.bytes[1] === 60), 'live input mirrors Note Off to external synth');

      // 2. Mapped CC 74 updates Mixer Track 1 volume without forwarding as sustain:
      inputPort.emit([0xb0, 74, 127]);
      const track1 = state.mixerTracks.find(t => t.id === 1)!;
      assert.ok(track1.volume > 1.2, 'existing CC -> mixer fader mapping works identically');

      // 3. Unmapped CC 64 forwards sustain pedal to external synth:
      inputPort.emit([0xb0, 64, 127]);
      assert.ok(externalOut.sent.some(p => p.bytes[0] === 0xb1 && p.bytes[1] === 64 && p.bytes[2] === 127));

      // 4. MIDI Learn capture on CC 21 binds master_vol cleanly:
      inputPort.emit([0xb0, 21, 90]);
      assert.ok(learnedMappings.some(m => m.ccNumber === 21 && m.targetType === 'master_vol'));
    } finally {
      audioEngine.removeMidiListener(listener);
    }
  });

  it('13. cancels pre-queued short Note Offs during fractional same-pitch overlaps in live AudioEngine playback without disturbing sibling channels on the shared port', async () => {
    const ctx = setupLiveEngine();
    const sharedPort = new FakeMidiOutputPort('out-shared-poly', { name: 'Prophet Rev2' });
    await installMidiAccess({
      inputs: new Map(),
      outputs: new Map([[sharedPort.id, sharedPort]]),
      onstatechange: null,
    });

    const leadCh = makeChannel('ch-lead-overlap', {
      midiOutput: { outputDeviceId: sharedPort.id, midiChannel: 1, mode: 'external' },
      notes: [
        makeNote(60, 0, 1, 0.8),
        makeNote(60, 0.5, 1, 0.9),
      ],
    });
    const siblingCh = makeChannel('ch-sibling-shared', {
      midiOutput: { outputDeviceId: sharedPort.id, midiChannel: 3, mode: 'external' },
      notes: [
        makeNote(64, 0, 1, 0.75),
      ],
    });
    const tracks = makeMixerTracks();

    try {
      audioEngine.play([leadCh, siblingCh], [], 'pat', 'pat-1', tracks, 16);
      advanceClock(ctx, 0.35, 8);
    } finally {
      audioEngine.stop();
      await audioEngine.releaseNativeInstruments();
    }

    const delivered = sharedPort.getDeliveredWirePackets();
    const ch1Ons = delivered.filter(p => p.bytes[0] === 0x90 && p.bytes[1] === 60);
    const ch1Offs = delivered.filter(p => p.bytes[0] === 0x80 && p.bytes[1] === 60);
    const ch3Ons = delivered.filter(p => p.bytes[0] === 0x92 && p.bytes[1] === 64);
    const ch3Offs = delivered.filter(p => p.bytes[0] === 0x82 && p.bytes[1] === 64);

    assert.equal(ch1Ons.length, 2, '2 delivered C4 Note Ons on Ch 1');
    assert.equal(ch1Offs.length, 2, '2 delivered C4 Note Offs on Ch 1 (stale 1-step Note Off cancelled)');
    const baseMs = ch1Ons[0].timestamp!;
    assert.ok(Math.abs((ch1Ons[1].timestamp! - baseMs) - 62.5) < 1e-3, 'second C4 Note On at +62.5 ms');
    assert.ok(Math.abs((ch1Offs[0].timestamp! - baseMs) - 62.5) < 1e-3, 'retrigger Note Off at +62.5 ms');
    assert.ok(Math.abs((ch1Offs[1].timestamp! - baseMs) - 187.5) < 1e-3, 'final C4 Note Off at +187.5 ms (not prematurely terminated at +125 ms)');

    assert.equal(ch3Ons.length, 1, 'sibling Ch 3 Note On preserved without duplication');
    assert.equal(ch3Offs.length, 1, 'sibling Ch 3 Note Off preserved without loss');
    assert.ok(Math.abs(ch3Ons[0].timestamp! - baseMs) < 1e-3, 'sibling Ch 3 Note On kept exact step-0 timestamp');
    assert.ok(Math.abs((ch3Offs[0].timestamp! - baseMs) - 125) < 1e-3, 'sibling Ch 3 Note Off kept exact +125 ms timestamp');
  });

  it('14. preserves both attacks and canonical release timing when fractional same-pitch channel.notes are stored in reverse array order during live AudioEngine.play()', async () => {
    const ctx = setupLiveEngine();
    const sharedPort = new FakeMidiOutputPort('out-shared-reverse', { name: 'OB-X8' });
    await installMidiAccess({
      inputs: new Map(),
      outputs: new Map([[sharedPort.id, sharedPort]]),
      onstatechange: null,
    });

    // Stored in REVERSE chronological order inside `leadCh.notes`:
    //   notes[0]: start = 0.8 (+100 ms), duration = 1 (+225 ms), vel = 0.7 (89)
    //   notes[1]: start = 0.5 (+62.5 ms), duration = 1 (+187.5 ms), vel = 0.95 (121)
    const leadCh = makeChannel('ch-lead-reverse', {
      midiOutput: { outputDeviceId: sharedPort.id, midiChannel: 1, mode: 'external' },
      notes: [
        makeNote(60, 0.8, 1, 0.7),
        makeNote(60, 0.5, 1, 0.95),
      ],
    });
    const siblingCh = makeChannel('ch-sibling-c4', {
      midiOutput: { outputDeviceId: sharedPort.id, midiChannel: 3, mode: 'external' },
      notes: [
        makeNote(60, 0.25, 1, 0.8), // same pitch C4 on sibling MIDI Ch 3 (+31.25 ms -> +156.25 ms)
      ],
    });
    const tracks = makeMixerTracks();

    try {
      audioEngine.play([leadCh, siblingCh], [], 'pat', 'pat-1', tracks, 16);
      advanceClock(ctx, 0.4, 10);
      assert.equal(
        engine.midiOutputScheduler.getActiveNoteCount(),
        0,
        'zero active notes after reverse-order playback window completes',
      );
    } finally {
      audioEngine.stop();
      await audioEngine.releaseNativeInstruments();
    }

    const delivered = sharedPort.getDeliveredWirePackets();
    // Filter out post-stop CC 123 cleanup messages to inspect musical note stream
    const ch1Notes = delivered.filter(
      p => (p.bytes[0] === 0x90 || p.bytes[0] === 0x80) && p.bytes[1] === 60 && p.timestamp !== undefined,
    );
    const ch3Notes = delivered.filter(
      p => (p.bytes[0] === 0x92 || p.bytes[0] === 0x82) && p.bytes[1] === 60 && p.timestamp !== undefined,
    );

    assert.equal(ch1Notes.length, 4, 'exact 4 C4 MIDI events delivered on Ch 1 (2 Note Ons, 2 Note Offs)');
    const firstOnMs = ch1Notes[0].timestamp!;
    const step0OriginMs = firstOnMs - 62.5;

    assert.deepEqual(ch1Notes[0].bytes, [0x90, 60, Math.round(0.95 * 127)]);
    assert.deepEqual(ch1Notes[1].bytes, [0x80, 60, 0]);
    assert.deepEqual(ch1Notes[2].bytes, [0x90, 60, Math.round(0.7 * 127)]);
    assert.deepEqual(ch1Notes[3].bytes, [0x80, 60, 0]);

    assert.ok(Math.abs((ch1Notes[0].timestamp! - step0OriginMs) - 62.5) < 1e-3, 'earlier C4 Note On at +62.5 ms');
    assert.ok(Math.abs((ch1Notes[1].timestamp! - step0OriginMs) - 100) < 1e-3, 'retrigger Note Off at +100 ms strictly before Note On');
    assert.ok(Math.abs((ch1Notes[2].timestamp! - step0OriginMs) - 100) < 1e-3, 'later C4 Note On preserved at +100 ms');
    assert.ok(Math.abs((ch1Notes[3].timestamp! - step0OriginMs) - 225) < 1e-3, 'final C4 Note Off at +225 ms (obsolete +187.5 ms Note Off suppressed)');

    assert.equal(ch3Notes.length, 2, 'sibling Ch 3 same-pitch C4 preserved 1:1 on shared port');
    assert.deepEqual(ch3Notes[0].bytes, [0x92, 60, Math.round(0.8 * 127)]);
    assert.deepEqual(ch3Notes[1].bytes, [0x82, 60, 0]);
    assert.ok(Math.abs((ch3Notes[0].timestamp! - step0OriginMs) - 31.25) < 1e-3);
    assert.ok(Math.abs((ch3Notes[1].timestamp! - step0OriginMs) - 156.25) < 1e-3);
  });

  it('15. preserves per-channel release ownership in live AudioEngine playback when a long contributor is muted mid-note while a shorter contributor shares the same port, MIDI channel, and pitch', async () => {
    const ctx = setupLiveEngine();
    const sharedPort = new FakeMidiOutputPort('out-shared-ownership', { name: 'Sequential Take 5' });
    await installMidiAccess({
      inputs: new Map(),
      outputs: new Map([[sharedPort.id, sharedPort]]),
      onstatechange: null,
    });

    const chA = makeChannel('ch-eng-long-a', {
      midiOutput: { outputDeviceId: sharedPort.id, midiChannel: 1, mode: 'external' },
      notes: [
        makeNote(60, 0, 4, 100 / 127), // step 0 -> +500 ms (4 steps)
      ],
    });
    const chB = makeChannel('ch-eng-short-b', {
      midiOutput: { outputDeviceId: sharedPort.id, midiChannel: 1, mode: 'external' },
      notes: [
        makeNote(60, 0.5, 1, 112 / 127), // +62.5 ms -> +187.5 ms (1 step)
      ],
    });
    const siblingCh = makeChannel('ch-eng-sibling-ch2', {
      midiOutput: { outputDeviceId: sharedPort.id, midiChannel: 2, mode: 'external' },
      notes: [
        makeNote(67, 0.5, 2, 96 / 127), // +62.5 ms -> +312.5 ms on MIDI Ch 2
      ],
    });
    const tracks = makeMixerTracks();

    let preStopPackets: Array<{ bytes: number[]; timestamp?: number }> = [];
    try {
      audioEngine.play([chA, chB, siblingCh], [], 'pat', 'pat-1', tracks, 16);
      // Advance 130 ms (step 0 was at +30 ms -> now at step0 + 100 ms: past B's +62.5 ms attack, before B's +187.5 ms release)
      advanceClock(ctx, 0.13, 10);

      audioEngine.synchronizePlaybackState({
        channels: [{ ...chA, mute: true }, chB, siblingCh],
      });

      assert.equal(engine.midiOutputScheduler.getActiveNoteCount(chA.id), 0);
      assert.equal(engine.midiOutputScheduler.getActiveNoteCount(chB.id), 1);
      assert.equal(
        sharedPort.sent.some(p => p.bytes[0] === 0xb0 && p.bytes[1] === 123),
        false,
        'no CC 123 emitted on MIDI Ch 1 while chB still owns an active C4',
      );

      // Advance past 4+ steps (+600 ms total, well past 530 ms, before 16-step pattern wrap at 2000 ms)
      advanceClock(ctx, 0.5, 10);
      assert.equal(
        engine.midiOutputScheduler.getActiveNoteCount(),
        0,
        'zero active notes after chB and siblingCh complete',
      );
      preStopPackets = sharedPort.getDeliveredWirePackets().map(p => ({
        bytes: [...p.bytes],
        timestamp: p.timestamp,
      }));
    } finally {
      audioEngine.stop();
      await audioEngine.releaseNativeInstruments();
    }

    const ch1Notes = preStopPackets.filter(
      p => (p.bytes[0] === 0x90 || p.bytes[0] === 0x80) && p.bytes[1] === 60,
    );
    const ch2Notes = preStopPackets.filter(
      p => (p.bytes[0] === 0x91 || p.bytes[0] === 0x81) && p.bytes[1] === 67,
    );

    assert.equal(ch1Notes.length, 4, 'exact 4 C4 events on Ch 1 (2 Note Ons, 2 Note Offs)');
    const step0OriginMs = ch1Notes[0].timestamp!;
    assert.deepEqual(ch1Notes[0].bytes, [0x90, 60, 100]);
    assert.deepEqual(ch1Notes[1].bytes, [0x80, 60, 0]);
    assert.deepEqual(ch1Notes[2].bytes, [0x90, 60, 112]);
    assert.deepEqual(ch1Notes[3].bytes, [0x80, 60, 0]);
    assert.ok(Math.abs((ch1Notes[1].timestamp! - step0OriginMs) - 62.5) < 1e-3);
    assert.ok(Math.abs((ch1Notes[2].timestamp! - step0OriginMs) - 62.5) < 1e-3);
    assert.ok(
      Math.abs((ch1Notes[3].timestamp! - step0OriginMs) - 187.5) < 1e-3,
      `expected chB Note Off at +187.5 ms (not chA +500 ms), got +${ch1Notes[3].timestamp! - step0OriginMs} ms`,
    );

    assert.equal(ch2Notes.length, 2, 'sibling Ch 2 note preserved 1:1');
    assert.ok(Math.abs((ch2Notes[0].timestamp! - step0OriginMs) - 62.5) < 1e-3);
    assert.ok(Math.abs((ch2Notes[1].timestamp! - step0OriginMs) - 312.5) < 1e-3);
  });

  it('16. closes an unavoidable future Note On promptly in live AudioEngine playback when a short contributor is muted before its onset on a clear-less shared port', async () => {
    const ctx = setupLiveEngine();
    const clearlessPort = new FakeMidiOutputPort('out-clearless-future-cleanup', {
      name: 'Oberheim OB-X8 (No clear)',
    });
    (clearlessPort as { clear?: () => void }).clear = undefined;

    await installMidiAccess({
      inputs: new Map(),
      outputs: new Map([[clearlessPort.id, clearlessPort]]),
      onstatechange: null,
    });

    const chA = makeChannel('ch-eng-noclear-a', {
      midiOutput: { outputDeviceId: clearlessPort.id, midiChannel: 1, mode: 'external' },
      notes: [
        makeNote(60, 0, 4, 100 / 127), // step 0 -> +500 ms (4 steps)
      ],
    });
    const chB = makeChannel('ch-eng-noclear-b', {
      midiOutput: { outputDeviceId: clearlessPort.id, midiChannel: 1, mode: 'external' },
      notes: [
        makeNote(60, 0.5, 0.5, 112 / 127), // +62.5 ms -> +125 ms (0.5 step; unqueued tail while A extends to +500 ms)
      ],
    });
    const siblingSameChE4 = makeChannel('ch-eng-noclear-e4', {
      midiOutput: { outputDeviceId: clearlessPort.id, midiChannel: 1, mode: 'external' },
      notes: [
        makeNote(64, 0.4, 2, 94 / 127), // +50 ms -> +300 ms on MIDI Ch 1
      ],
    });
    const siblingCh2G4 = makeChannel('ch-eng-noclear-g4', {
      midiOutput: { outputDeviceId: clearlessPort.id, midiChannel: 2, mode: 'external' },
      notes: [
        makeNote(67, 0.6, 2, 90 / 127), // +75 ms -> +325 ms on MIDI Ch 2
      ],
    });
    const tracks = makeMixerTracks();

    let preStopPackets: Array<{ bytes: number[]; timestamp?: number }> = [];
    try {
      audioEngine.play([chA, chB, siblingSameChE4, siblingCh2G4], [], 'pat', 'pat-1', tracks, 16);
      // Step 0 triggers at +30 ms look-ahead; advance 60 ms (so now is step0 + 30 ms, strictly before chB's +62.5 ms Note On!)
      advanceClock(ctx, 0.06, 6);

      audioEngine.synchronizePlaybackState({
        channels: [chA, { ...chB, mute: true }, siblingSameChE4, siblingCh2G4],
      });

      assert.equal(engine.midiOutputScheduler.getActiveNoteCount(chB.id), 0);
      assert.equal(
        clearlessPort.sent.some(p => p.bytes[0] === 0xb0 && p.bytes[1] === 123),
        false,
        'no CC 123 emitted on MIDI Ch 1 while chA and siblingSameChE4 own active notes',
      );

      // Advance past +600 ms so all 4 steps complete cleanly before 16-step pattern wrap at 2000 ms
      advanceClock(ctx, 0.6, 12);
      assert.equal(
        engine.midiOutputScheduler.getActiveNoteCount(),
        0,
        'zero active-note records remain after completion',
      );
      preStopPackets = clearlessPort.getDeliveredWirePackets().map(p => ({
        bytes: [...p.bytes],
        timestamp: p.timestamp,
      }));
    } finally {
      audioEngine.stop();
      await audioEngine.releaseNativeInstruments();
    }

    const ch1C4 = preStopPackets.filter(
      p => (p.bytes[0] === 0x90 || p.bytes[0] === 0x80) && p.bytes[1] === 60,
    );
    const ch1E4 = preStopPackets.filter(
      p => (p.bytes[0] === 0x90 || p.bytes[0] === 0x80) && p.bytes[1] === 64,
    );
    const ch2G4 = preStopPackets.filter(
      p => (p.bytes[0] === 0x91 || p.bytes[0] === 0x81) && p.bytes[1] === 67,
    );

    assert.equal(ch1C4.length, 4, 'exact 4 C4 events on MIDI Ch 1 (2 Note Ons, 2 Note Offs)');
    const step0OriginMs = ch1C4[0].timestamp!;
    assert.deepEqual(ch1C4[0].bytes, [0x90, 60, 100]);
    assert.deepEqual(ch1C4[1].bytes, [0x80, 60, 0]);
    assert.deepEqual(ch1C4[2].bytes, [0x90, 60, 112]);
    assert.deepEqual(ch1C4[3].bytes, [0x80, 60, 0]);
    assert.ok(Math.abs((ch1C4[1].timestamp! - step0OriginMs) - 62.5) < 1e-3);
    assert.ok(Math.abs((ch1C4[2].timestamp! - step0OriginMs) - 62.5) < 1e-3);
    assert.ok(
      Math.abs((ch1C4[3].timestamp! - step0OriginMs) - 63.5) < 1e-3,
      `expected deterministic safety Note Off at +63.5 ms (+1 ms after unavoidable +62.5 ms Note On), got +${ch1C4[3].timestamp! - step0OriginMs} ms`,
    );

    assert.equal(ch1E4.length, 2, 'sibling E4 on same MIDI Ch 1 preserved 1:1');
    assert.ok(Math.abs((ch1E4[0].timestamp! - step0OriginMs) - 50) < 1e-3);
    assert.ok(Math.abs((ch1E4[1].timestamp! - step0OriginMs) - 300) < 1e-3);

    assert.equal(ch2G4.length, 2, 'sibling G4 on MIDI Ch 2 preserved 1:1');
    assert.ok(Math.abs((ch2G4[0].timestamp! - step0OriginMs) - 75) < 1e-3);
    assert.ok(Math.abs((ch2G4[1].timestamp! - step0OriginMs) - 325) < 1e-3);
  });
});
