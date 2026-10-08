/**
 * Phase 68 — F2/F3: the arrangement MIDI export speaks the scheduler's truth.
 *
 * Two confirmed Phase 67 findings meet in `src/utils/exportUtils.ts`:
 *
 * F2 — the writer placed every event on the un-swung step grid (`Math.round(
 *      absoluteStep * TICKS_PER_STEP)`) while live playback and the offline WAV
 *      renderer displace odd steps by the project's groove through the shared
 *      `swingOffsetSecondsForStep()` conversion. A project at full swing
 *      exported a straight MIDI file.
 *
 * F3 — the writer filtered clips and lanes but never the channel, so a muted or
 *      solo-silenced channel still wrote its notes; and it dropped `Note.muted`
 *      events, which no audio path consults, making the file disagree with the
 *      take in the opposite direction.
 *
 * Every assertion below measures both sides: the real scheduler (`playNote` is
 * recorded, everything else is the production engine) and the real bytes the
 * production writer emits.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import { isRackChannelAudible } from './midiMappingRuntime';
import { buildStandardMidiFile } from '../utils/exportUtils';
import type { Channel, MixerTrack, Note, PlaylistClip } from '../types/daw';

const SAMPLE_RATE = 8000;
const BPM = 120;
const STEP_SECONDS = (60 / BPM) / 4;
const TICKS_PER_STEP = 120;
/** Project swing at the Channel Rack slider maximum - displayed as "100 %". */
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

/** Scheduler entry point: `playNote` is recorded with its channel, never synthesised. */
interface ScheduledTrigger {
  channelId: string;
  time: number;
}

let scheduledTriggers: ScheduledTrigger[] = [];

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
  engine.playNote = (channel: Channel, _note: { start?: number }, startTime?: number) => {
    scheduledTriggers.push({ channelId: channel.id, time: startTime ?? Number.NaN });
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
    setTimeSignature: () => undefined,
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
  scheduledTriggers = [];
  realOfflineAudioContext = (globalThis as any).OfflineAudioContext;
  (globalThis as any).OfflineAudioContext = SimAudioContext;
  (globalThis as any).window = { AudioContext: SimAudioContext, OfflineAudioContext: SimAudioContext };
});

afterEach(() => {
  for (const field of SAVED_FIELDS) engine[field] = savedState[field];
  (globalThis as any).OfflineAudioContext = realOfflineAudioContext;
  (globalThis as any).window = undefined;
});

// --- Independent Standard MIDI File reader ---------------------------------
// Deliberately does not share code with the writer: it re-reads the emitted
// bytes so a writer bug cannot be mirrored by the test.

interface DecodedNote {
  tick: number;
  midiChannel: number;
  pitch: number;
  velocity: number;
}

interface DecodedTrack {
  name: string | null;
  notes: DecodedNote[];
}

interface DecodedMidi {
  format: number;
  trackCount: number;
  ticksPerQuarter: number;
  tracks: DecodedTrack[];
}

const readVlq = (bytes: Uint8Array, offset: number): { value: number; next: number } => {
  let value = 0;
  let index = offset;
  for (;;) {
    const byte = bytes[index];
    value = (value << 7) | (byte & 0x7f);
    index += 1;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: index };
};

const decodeMidiFile = (bytes: Uint8Array): DecodedMidi => {
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'MThd', 'missing MThd');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(4);
  const format = view.getUint16(8);
  const trackCount = view.getUint16(10);
  const ticksPerQuarter = view.getUint16(12);

  const tracks: DecodedTrack[] = [];
  let cursor = 8 + headerLength;
  for (let trackIndex = 0; trackIndex < trackCount; trackIndex += 1) {
    assert.equal(String.fromCharCode(...bytes.slice(cursor, cursor + 4)), 'MTrk', 'missing MTrk');
    const length = view.getUint32(cursor + 4);
    const end = cursor + 8 + length;
    let index = cursor + 8;
    let tick = 0;
    let runningStatus: number | null = null;
    const notes: DecodedNote[] = [];
    let name: string | null = null;

    while (index < end) {
      const delta = readVlq(bytes, index);
      tick += delta.value;
      index = delta.next;
      let status = bytes[index];
      if (status < 0x80) {
        assert.ok(runningStatus !== null, 'running status without a prior status byte');
        status = runningStatus;
      } else {
        index += 1;
        if (status < 0xf0) runningStatus = status;
      }

      if (status === 0xff) {
        const metaType = bytes[index];
        index += 1;
        const metaLength = readVlq(bytes, index);
        index = metaLength.next;
        if (metaType === 0x03) {
          name = String.fromCharCode(...bytes.slice(index, index + metaLength.value));
        }
        if (metaType === 0x2f) break;
        index += metaLength.value;
        continue;
      }

      const dataLength = status >= 0xf0 ? 0 : 2;
      const data = Array.from(bytes.slice(index, index + dataLength));
      index += dataLength;
      if ((status & 0xf0) === 0x90 && data[1] > 0) {
        notes.push({ tick, midiChannel: status & 0x0f, pitch: data[0], velocity: data[1] });
      }
    }

    tracks.push({ name, notes });
    cursor = end;
  }

  return { format, trackCount, ticksPerQuarter, tracks };
};

const asBytes = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());

const noteTicks = (decoded: DecodedMidi, trackIndex = 0): number[] =>
  decoded.tracks[trackIndex].notes.map(note => note.tick);

const exportPattern = async (
  channels: Channel[],
  meta: { bpm: number; timeSignature: [number, number]; swing?: number },
  scope: 'pattern' | 'song' = 'pattern',
  clips: PlaylistClip[] = [],
): Promise<DecodedMidi> =>
  decodeMidiFile(await asBytes(
    buildStandardMidiFile(channels, clips, meta, { scope, patternLengthSteps: 16 }),
  ));

// --- Fixtures ---------------------------------------------------------------

const channel = (id: string, overrides: Partial<Channel> = {}): Channel => ({
  id,
  name: id,
  color: '#fff',
  instrumentType: 'minisynth',
  mixerTrackId: 1,
  volume: 1,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: new Array(16).fill(false),
  notes: [],
  synthParams: {} as Channel['synthParams'],
  ...overrides,
});

const stepsAt = (active: number[]): boolean[] => {
  const steps = new Array(16).fill(false);
  for (const index of active) steps[index] = true;
  return steps;
};

const noteAt = (start: number, overrides: Partial<Note> = {}): Note => ({
  id: `note-${start}`,
  pitch: 64,
  start,
  duration: 1,
  velocity: 0.9,
  ...overrides,
});

const patternClip = (
  id: string,
  channelId: string,
  overrides: Partial<PlaylistClip> = {},
): PlaylistClip => ({
  id,
  trackIndex: 0,
  startBar: 0,
  lengthBars: 2,
  type: 'pattern',
  channelId,
  color: '#fff',
  name: id,
  ...overrides,
});

const MIDI_META = { bpm: BPM, timeSignature: [4, 4] as [number, number] };

/** The live groove displacement, in ticks, measured through the real transport. */
const liveSwingTicks = (swing: number, step: number): number => {
  setupLiveGraph();
  const transport = attachFakeTransport();
  audioEngine.setSwing(swing);
  audioEngine.play(
    [channel('ch-live', { steps: stepsAt([step]) })],
    [] as PlaylistClip[],
    'pat',
    'pat-1',
    makeMixerTracks(),
    16,
    [],
  );
  scheduledTriggers = [];
  transport.emitStep(step, 1, step * STEP_SECONDS);
  assert.equal(scheduledTriggers.length, 1, 'the scheduler must trigger the single step hit');
  return Math.round((scheduledTriggers[0].time - step * STEP_SECONDS) / STEP_SECONDS * TICKS_PER_STEP);
};

/** The offline renderer's groove displacement, in ticks, for the same step. */
const offlineSwingTicks = async (swing: number, step: number): Promise<number> => {
  setupLiveGraph();
  audioEngine.setSwing(swing);
  scheduledTriggers = [];
  await audioEngine.renderTimelineOffline(
    [channel('ch-offline', { steps: stepsAt([step]) })],
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
  assert.equal(scheduledTriggers.length, 4, 'a four-bar render loops the pattern four times');
  return Math.round((scheduledTriggers[0].time - step * STEP_SECONDS) / STEP_SECONDS * TICKS_PER_STEP);
};


describe('Phase 68 F2 — the exported file stores the groove playback uses', () => {
  it('keeps every tick exactly where it was when swing is zero', async () => {
    const withoutField = await exportPattern([channel('ch-1', { steps: stepsAt([1]) })], MIDI_META);
    const withZero = await exportPattern([channel('ch-1', { steps: stepsAt([1]) })], { ...MIDI_META, swing: 0 });

    assert.deepEqual(noteTicks(withoutField), [120, 2040, 3960, 5880], 'four pattern-loop passes');
    assert.deepEqual(noteTicks(withZero), noteTicks(withoutField), 'swing = 0 must be bit-identical to today');
  });

  it('moves an off-beat event by exactly the displacement live and offline play', async () => {
    const neutral = await exportPattern([channel('ch-1', { steps: stepsAt([1]) })], MIDI_META);
    const swung = await exportPattern(
      [channel('ch-1', { steps: stepsAt([1]) })],
      { ...MIDI_META, swing: PROJECT_SWING_MAX },
    );

    const liveTicks = liveSwingTicks(PROJECT_SWING_MAX, 1);
    const offlineTicks = await offlineSwingTicks(PROJECT_SWING_MAX, 1);

    assert.equal(liveTicks, 48, 'full swing is 40% of a step: 48 ticks at 120 ticks per step');
    assert.equal(offlineTicks, liveTicks, 'the offline renderer must groove like the take');

    const moved = noteTicks(swung).map((tick, index) => tick - noteTicks(neutral)[index]);
    assert.deepEqual(moved, [liveTicks, liveTicks, liveTicks, liveTicks], 'the file must move by the measured groove');
  });

  it('leaves even steps and their fractional onsets untouched', async () => {
    const straight = channel('ch-even', { steps: stepsAt([0, 4]), notes: [noteAt(4.5)] });
    const neutral = await exportPattern([straight], MIDI_META);
    const swung = await exportPattern([straight], { ...MIDI_META, swing: PROJECT_SWING_MAX });

    assert.deepEqual(noteTicks(neutral), [0, 480, 540, 1920, 2400, 2460, 3840, 4320, 4380, 5760, 6240, 6300]);
    assert.deepEqual(noteTicks(swung), noteTicks(neutral), 'downbeats and their offsets never move');
  });

  it('gives an onset on an odd step its own step groove, at its own fractional position', async () => {
    const neutral = await exportPattern([channel('ch-odd', { notes: [noteAt(5.5)] })], MIDI_META);
    const swung = await exportPattern(
      [channel('ch-odd', { notes: [noteAt(5.5)] })],
      { ...MIDI_META, swing: PROJECT_SWING_MAX },
    );

    assert.deepEqual(noteTicks(neutral), [660, 2580, 4500, 6420]);
    assert.deepEqual(noteTicks(swung), [708, 2628, 4548, 6468], '660 + 48 ticks of groove');
  });

  it('carries the same groove in song scope', async () => {
    const clips = [patternClip('clip-1', 'ch-1')];
    const neutral = await exportPattern([channel('ch-1', { steps: stepsAt([1]) })], MIDI_META, 'song', clips);
    const swung = await exportPattern(
      [channel('ch-1', { steps: stepsAt([1]) })],
      { ...MIDI_META, swing: PROJECT_SWING_MAX },
      'song',
      clips,
    );

    assert.deepEqual(noteTicks(neutral), [120, 2040]);
    assert.deepEqual(noteTicks(swung), [168, 2088]);
  });
});

describe('Phase 68 F3 — channel audibility is one contract', () => {
  it('writes no notes for a muted channel and keeps its track in place', async () => {
    const muted = channel('ch-mute', { steps: stepsAt([1]), mute: true });
    const live = channel('ch-live', { steps: stepsAt([1]) });
    const decoded = await exportPattern([muted, live], MIDI_META);

    assert.equal(decoded.tracks.length, 2, 'the track map must still match the channel list');
    assert.equal(decoded.tracks[0].name, 'ch-mute');
    assert.deepEqual(decoded.tracks[0].notes, [], 'a muted channel must export no note events');
    assert.equal(decoded.tracks[1].notes.length, 4);
    assert.equal(decoded.tracks[1].notes[0].midiChannel, 1, 'no channel may be merged or renumbered');
  });

  it('exports only the soloed channel while any solo is active', async () => {
    const decoded = await exportPattern([
      channel('ch-1', { steps: stepsAt([1]) }),
      channel('ch-2', { steps: stepsAt([1]), solo: true }),
      channel('ch-3', { steps: stepsAt([1]), solo: true }),
    ], MIDI_META);

    assert.deepEqual(decoded.tracks[0].notes, []);
    assert.equal(decoded.tracks[1].notes.length, 4);
    assert.equal(decoded.tracks[2].notes.length, 4);
  });

  it('treats a channel that is both soloed and muted exactly like the predicate does', async () => {
    const channels = [
      channel('ch-1', { steps: stepsAt([1]) }),
      channel('ch-2', { steps: stepsAt([1]), solo: true, mute: true }),
    ];
    const decoded = await exportPattern(channels, MIDI_META);

    assert.deepEqual(decoded.tracks[0].notes, []);
    assert.deepEqual(decoded.tracks[1].notes, []);
    assert.equal(isRackChannelAudible(channels[1], channels), false, 'the canonical predicate agrees');
  });

  it('agrees with the live scheduler on which channels sound', async () => {
    const channels = [
      channel('ch-muted', { steps: stepsAt([1]), mute: true }),
      channel('ch-plain', { steps: stepsAt([1]) }),
      channel('ch-solo', { steps: stepsAt([1]), solo: true }),
    ];

    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.play(channels, [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, []);
    scheduledTriggers = [];
    transport.emitStep(1, 1, STEP_SECONDS);
    const liveChannels = Array.from(new Set(scheduledTriggers.map(trigger => trigger.channelId))).sort();

    const decoded = await exportPattern(channels, MIDI_META);
    const exportedChannels = channels
      .filter((_, index) => decoded.tracks[index].notes.length > 0)
      .map(candidate => candidate.id)
      .sort();
    const audibleChannels = channels
      .filter(candidate => isRackChannelAudible(candidate, channels))
      .map(candidate => candidate.id)
      .sort();

    assert.deepEqual(liveChannels, ['ch-solo'], 'the take only sounds the soloed channel');
    assert.deepEqual(exportedChannels, liveChannels, 'the file must sound exactly what the take sounds');
    assert.deepEqual(audibleChannels, liveChannels, 'and both must be the canonical predicate');
  });

  it('keeps a note the audio scheduler plays, because Note.muted has no audio meaning', async () => {
    const noteMuted = channel('ch-note-muted', { notes: [noteAt(1, { muted: true })] });

    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.play([noteMuted], [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, []);
    scheduledTriggers = [];
    transport.emitStep(1, 1, STEP_SECONDS);
    assert.equal(scheduledTriggers.length, 1, 'the scheduler plays the note');

    const decoded = await exportPattern([noteMuted], MIDI_META);
    assert.equal(decoded.tracks[0].notes.length, 4, 'so the file must contain it, once per loop pass');
    assert.deepEqual(noteTicks(decoded), [120, 2040, 3960, 5880]);
  });
});
