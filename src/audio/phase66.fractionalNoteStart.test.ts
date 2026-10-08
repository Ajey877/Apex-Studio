/**
 * Phase 66 — F1: fractional `Note.start` positions are schedulable.
 *
 * `Note.start` is documented as "in steps (16th notes or fractional steps)"
 * (`types/daw.ts`), and production writers genuinely emit sub-step onsets:
 *
 * - Piano Roll chord stamping adds a per-note strum offset in fractional steps
 *   (`PianoRoll.tsx`, "micro fractional step offset");
 * - "Strum Chords" writes `step + idx * 0.04` (half-step groups, 0.04 steps);
 * - MIDI import quantises onsets to quarter steps
 *   (`midiParser.ts`: `Math.round((tick / ticksPerStep) * 4) / 4`).
 *
 * The live scheduler and the offline renderer both matched notes with an exact
 * comparison (`note.start === currentStep` / `note.start === relStep`), so every
 * fractional onset was persisted, exported to MIDI, drawn in the Piano Roll —
 * and never played. Audio playback and the MIDI representation disagreed.
 *
 * The contract asserted below is the one the rest of the engine already
 * implements for step boundaries: a step boundary is fired once per step at
 * `audioTime`, and an onset that falls inside that step keeps its fractional
 * remainder as a displacement from that boundary (0 for integer onsets, which
 * is why integer notes keep their exact old timing). Swing displaces the
 * boundary itself, so fractional onsets follow the same groove the integer
 * onsets already followed.
 *
 * Harness note: `playNote` is replaced with a recorder so the scheduler's
 * timing decisions are observable without synthesising voices. Everything else
 * (graph construction, loop resolution, swing maths, offline scheduling) is
 * real production code, and the offline case runs through the real
 * `renderTimelineOffline` entry point.
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import { swingOffsetSecondsForStep } from './parameterScaling';
import type { Channel, MixerTrack, Note, PlaylistClip } from '../types/daw';

const SAMPLE_RATE = 8000;
const BPM = 120;
const SECONDS_PER_STEP = (60 / BPM) / 4;

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
    steps: new Array(16).fill(false),
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

interface TriggeredNote {
  pitch: number;
  start: number;
  time: number;
}

/** Scheduler entry point: `playNote` is recorded, never synthesised. */
let triggered: TriggeredNote[] = [];

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
  engine.playNote = (channel: Channel, note: Note, startTime?: number) => {
    triggered.push({
      pitch: note.pitch,
      start: note.start,
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

const makeNote = (id: string, pitch: number, start: number): Note => ({
  id,
  pitch,
  start,
  duration: 1,
  velocity: 0.9,
});

const timeOfPitch = (pitch: number): number | undefined =>
  triggered.find(note => note.pitch === pitch)?.time;

const triggerCount = (pitch: number): number =>
  triggered.filter(note => note.pitch === pitch).length;

/** The fractional onsets the three audited production writers emit. */
const STRUM_NOTES: Note[] = [
  makeNote('n-int', 60, 4),
  makeNote('n-tenth', 64, 4.1),
  makeNote('n-twentieth', 67, 4.2),
];

beforeEach(() => {
  for (const field of SAVED_FIELDS) savedState[field] = engine[field];
  triggered = [];
  realOfflineAudioContext = (globalThis as any).OfflineAudioContext;
  (globalThis as any).OfflineAudioContext = SimAudioContext;
  (globalThis as any).window = { AudioContext: SimAudioContext, OfflineAudioContext: SimAudioContext };
});

afterEach(() => {
  for (const field of SAVED_FIELDS) engine[field] = savedState[field];
  (globalThis as any).OfflineAudioContext = realOfflineAudioContext;
  (globalThis as any).window = undefined;
});

describe('Phase 66 F1 — Pattern Mode schedules fractional note starts', () => {
  it('fires every onset of a strummed chord at its own sub-step position', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.setSwing(0);
    audioEngine.play(
      [makeChannel('ch-frac', { notes: STRUM_NOTES })],
      [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, [],
    );

    transport.emitStep(4, 1, 0.5);

    assert.equal(triggered.length, 3, 'a 3-note strummed chord must sound all three notes, not just the integer one');
    assert.ok(Math.abs(timeOfPitch(60)! - 0.5) < 1e-9, 'the integer onset keeps its exact step time');
    assert.ok(
      Math.abs(timeOfPitch(64)! - (0.5 + 0.1 * SECONDS_PER_STEP)) < 1e-9,
      'the 4.1 onset sounds one tenth of a step after the step-4 boundary',
    );
    assert.ok(
      Math.abs(timeOfPitch(67)! - (0.5 + 0.2 * SECONDS_PER_STEP)) < 1e-9,
      'the 4.2 onset sounds two tenths of a step after the step-4 boundary',
    );
  });

  it('keeps integer onsets byte-identical to the legacy exact-match behaviour', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.setSwing(0);
    audioEngine.play(
      [makeChannel('ch-int', { notes: [makeNote('n-4', 60, 4), makeNote('n-5', 62, 5)] })],
      [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, [],
    );

    transport.emitStep(4, 1, 0.5);
    assert.deepEqual(triggered, [{ pitch: 60, start: 4, time: 0.5 }], 'step 4 triggers only the step-4 note, on the grid');

    triggered = [];
    transport.emitStep(5, 1, 0.625);
    assert.deepEqual(triggered, [{ pitch: 62, start: 5, time: 0.625 }], 'step 5 triggers only the step-5 note, on the grid');
  });

  it('never re-triggers a fractional onset on a later step', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.setSwing(0);
    audioEngine.play(
      [makeChannel('ch-once', { notes: [makeNote('n-4-1', 64, 4.1)] })],
      [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, [],
    );

    for (let step = 0; step < 16; step += 1) {
      transport.emitStep(step, 1, step * SECONDS_PER_STEP);
    }

    assert.equal(triggerCount(64), 1, 'a 4.1 onset belongs to step 4 exactly once');
    assert.ok(Math.abs(timeOfPitch(64)! - (4 * SECONDS_PER_STEP + 0.1 * SECONDS_PER_STEP)) < 1e-9);
  });

  it('assigns an onset to the step it falls on or after, never the next one', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.setSwing(0);
    audioEngine.play(
      [makeChannel('ch-boundary', { notes: [makeNote('n-3-5', 60, 3.5)] })],
      [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, [],
    );

    transport.emitStep(4, 1, 0.5);
    assert.equal(triggerCount(60), 0, 'a 3.5 onset must not drift into step 4');

    transport.emitStep(3, 1, 0.375);
    assert.equal(triggerCount(60), 1);
    assert.ok(Math.abs(timeOfPitch(60)! - (0.375 + 0.5 * SECONDS_PER_STEP)) < 1e-9, 'it sounds half a step after the step-3 boundary');
  });

  it('ignores non-finite and negative onsets instead of scheduling them', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.setSwing(0);
    audioEngine.play(
      [
        makeChannel('ch-guard', {
          notes: [
            makeNote('n-nan', 60, Number.NaN),
            makeNote('n-negative', 62, -1),
            makeNote('n-inf', 64, Number.POSITIVE_INFINITY),
          ],
        }),
      ],
      [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, [],
    );

    for (let step = 0; step < 16; step += 1) {
      transport.emitStep(step, 1, step * SECONDS_PER_STEP);
    }
    assert.deepEqual(triggered, [], 'unusable onsets are never played');
  });

  it('keeps a fractional onset inside the swung boundary of its own step', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.setSwing(0.5);
    audioEngine.play(
      [makeChannel('ch-swing-frac', { notes: [makeNote('n-5-1', 64, 5.1)] })],
      [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, [],
    );

    // The transport reports the unswung grid boundary for the step; the engine
    // adds the groove offset itself, exactly as it does for integer onsets.
    const gridBoundary = 5 * SECONDS_PER_STEP;
    transport.emitStep(5, 1, gridBoundary);
    const swungBoundary = gridBoundary + swingOffsetSecondsForStep(0.5, SECONDS_PER_STEP);

    assert.equal(triggerCount(64), 1);
    assert.ok(
      Math.abs(timeOfPitch(64)! - (swungBoundary + 0.1 * SECONDS_PER_STEP)) < 1e-9,
      'the fractional remainder is measured from the swung boundary, not the unswung grid',
    );
  });
});

describe('Phase 66 F1 — Song Mode schedules fractional note starts', () => {
  const makePatternClip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
    id: 'clip-1',
    trackIndex: 0,
    startBar: 0,
    lengthBars: 2,
    type: 'pattern',
    patternId: 'pat-1',
    channelId: 'ch-frac',
    color: '#ff6e00',
    name: 'Clip 1',
    ...overrides,
  });

  it('plays every fractional onset of a clip at its sub-step position', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.setSwing(0);
    const channel = makeChannel('ch-frac', { notes: STRUM_NOTES });
    audioEngine.play([channel], [makePatternClip()], 'song', 'pat-1', makeMixerTracks(), 16, []);

    transport.emitStep(4, 1, 0.5);

    assert.equal(triggered.length, 3, 'Song Mode must schedule the same onsets Pattern Mode does');
    assert.ok(Math.abs(timeOfPitch(60)! - 0.5) < 1e-9);
    assert.ok(Math.abs(timeOfPitch(64)! - (0.5 + 0.1 * SECONDS_PER_STEP)) < 1e-9);
    assert.ok(Math.abs(timeOfPitch(67)! - (0.5 + 0.2 * SECONDS_PER_STEP)) < 1e-9);
  });

  it('measures the fraction from the clip-trimmed loop step', () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.setSwing(0);
    const channel = makeChannel('ch-trimmed', { notes: [makeNote('n-4-5', 70, 4.5)] });
    audioEngine.play(
      [channel],
      [makePatternClip({ channelId: 'ch-trimmed', offsetSteps: 4 })],
      'song', 'pat-1', makeMixerTracks(), 16, [],
    );

    transport.emitStep(0, 1, 0.25);

    assert.equal(triggerCount(70), 1, 'the offset-trimmed loop reaches the 4.5 onset at its own loop step');
    assert.ok(Math.abs(timeOfPitch(70)! - (0.25 + 0.5 * SECONDS_PER_STEP)) < 1e-9);
  });
});

describe('Phase 66 F1 — the offline renderer schedules the same fractional onsets', () => {
  it('renders every fractional onset of a pattern loop', async () => {
    setupLiveGraph();
    audioEngine.setSwing(0);
    await audioEngine.renderTimelineOffline(
      [makeChannel('ch-frac', { notes: STRUM_NOTES })],
      [] as PlaylistClip[], [] as MixerTrack[], BPM, 1,
      undefined, false, 'pattern', undefined, 16,
    );

    assert.equal(triggered.length, 6, 'two 16-step passes of a 3-note chord = 6 notes');
    assert.ok(Math.abs(timeOfPitch(60)! - 0.5) < 1e-9);
    assert.ok(Math.abs(timeOfPitch(64)! - (0.5 + 0.1 * SECONDS_PER_STEP)) < 1e-9);
    assert.ok(Math.abs(timeOfPitch(67)! - (0.5 + 0.2 * SECONDS_PER_STEP)) < 1e-9);
    assert.ok(Math.abs(triggered[3].time - (0.5 + 2)) < 1e-9, 'the loop repeats one bar later');
    assert.ok(Math.abs(triggered[4].time - (0.5 + 2 + 0.1 * SECONDS_PER_STEP)) < 1e-9);
    assert.ok(Math.abs(triggered[5].time - (0.5 + 2 + 0.2 * SECONDS_PER_STEP)) < 1e-9);
  });

  it('agrees with live playback note for note (audio and MIDI cannot disagree)', async () => {
    audioEngine.setSwing(0);
    setupLiveGraph();
    const transport = attachFakeTransport();
    const channel = makeChannel('ch-agree', { notes: STRUM_NOTES });
    audioEngine.play([channel], [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, []);
    transport.emitStep(4, 1, 0.5);
    const live = triggered.map(note => ({ pitch: note.pitch, time: note.time }));

    setupLiveGraph();
    audioEngine.setSwing(0);
    triggered = [];
    await audioEngine.renderTimelineOffline(
      [makeChannel('ch-agree', { notes: STRUM_NOTES })],
      [] as PlaylistClip[], [] as MixerTrack[], BPM, 1,
      undefined, false, 'pattern', undefined, 16,
    );
    const offline = triggered.slice(0, 3).map(note => ({ pitch: note.pitch, time: note.time }));

    assert.deepEqual(offline, live, 'the offline render must place the same onsets at the same times as the live take');
  });

  it('imports produce quarter-step onsets that all sound (MIDI import granularity)', async () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.setSwing(0);
    const channel = makeChannel('ch-midi', {
      notes: [makeNote('m-1', 60, 4), makeNote('m-2', 63, 4.25), makeNote('m-3', 67, 4.5), makeNote('m-4', 70, 4.75)],
    });
    audioEngine.play([channel], [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, []);

    transport.emitStep(4, 1, 0.5);

    assert.equal(triggered.length, 4, 'all four imported quarter-step onsets must sound');
    for (const [index, pitch] of [60, 63, 67, 70].entries()) {
      assert.ok(
        Math.abs(timeOfPitch(pitch)! - (0.5 + index * 0.25 * SECONDS_PER_STEP)) < 1e-9,
        `pitch ${pitch} keeps its quarter-step offset`,
      );
    }
  });
});

/**
 * The end-to-end parity check F1 must not break: for the same channel, the MIDI
 * file the project exporter writes and the positions the live scheduler plays
 * must describe one performance. The MIDI reader below is deliberately
 * independent of the writer (`utils/exportUtils.ts`).
 */
const readMidiNoteOnTicks = (bytes: Uint8Array): Array<{ pitch: number; tick: number }> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(4);
  const trackCount = view.getUint16(10);
  const found: Array<{ pitch: number; tick: number }> = [];
  let cursor = 8 + headerLength;

  for (let track = 0; track < trackCount; track += 1) {
    const length = view.getUint32(cursor + 4);
    const end = cursor + 8 + length;
    let index = cursor + 8;
    let tick = 0;
    let runningStatus: number | null = null;
    while (index < end) {
      let delta = 0;
      for (;;) {
        const byte = bytes[index++];
        delta = (delta << 7) | (byte & 0x7f);
        if ((byte & 0x80) === 0) break;
      }
      tick += delta;
      let status = bytes[index];
      if (status < 0x80) {
        status = runningStatus ?? 0;
      } else {
        index += 1;
        if (status < 0xf0) runningStatus = status;
      }
      if (status === 0xff) {
        const metaType = bytes[index++];
        let metaLength = 0;
        for (;;) {
          const byte = bytes[index++];
          metaLength = (metaLength << 7) | (byte & 0x7f);
          if ((byte & 0x80) === 0) break;
        }
        if (metaType === 0x2f) break;
        index += metaLength;
        continue;
      }
      const dataLength = status >= 0xf0 ? 0 : 2;
      const data = [bytes[index], bytes[index + 1]];
      index += dataLength;
      if ((status & 0xf0) === 0x90 && data[1] > 0) found.push({ pitch: data[0], tick });
    }
    cursor = end;
  }
  return found;
};

describe('Phase 66 F1 — the MIDI representation and playback describe one performance', () => {
  it('writes every played fractional onset at the tick the take played it', async () => {
    setupLiveGraph();
    const transport = attachFakeTransport();
    audioEngine.setSwing(0);
    audioEngine.play(
      [makeChannel('ch-parity', { notes: STRUM_NOTES })],
      [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, [],
    );
    const stepFourBoundary = 0.5;
    transport.emitStep(4, 1, stepFourBoundary);

    // Absolute musical position: the step-4 boundary plus the played remainder.
    const playedSteps = STRUM_NOTES.map(note => {
      const time = triggered.find(hit => hit.pitch === note.pitch)?.time;
      assert.ok(time !== undefined, `pitch ${note.pitch} was played`);
      return 4 + (time - stepFourBoundary) / SECONDS_PER_STEP;
    });

    const { buildStandardMidiFile } = await import('../utils/exportUtils');
    const blob = buildStandardMidiFile(
      [makeChannel('ch-parity', { notes: STRUM_NOTES })],
      [],
      { bpm: BPM, timeSignature: [4, 4] },
      { scope: 'pattern', patternLengthSteps: 16 },
    );
    const written = readMidiNoteOnTicks(new Uint8Array(await blob.arrayBuffer()))
      .filter(note => note.tick < 16 * 120);

    assert.equal(written.length, 3, 'the first loop pass holds the three onsets');
    for (const [index, note] of STRUM_NOTES.entries()) {
      const writtenNote = written.find(candidate => candidate.pitch === note.pitch);
      assert.ok(writtenNote !== undefined, `pitch ${note.pitch} is in the file`);
      const writtenSteps = writtenNote.tick / 120;
      assert.ok(
        Math.abs(writtenSteps - playedSteps[index]) < 1e-9,
        `pitch ${note.pitch}: MIDI says step ${writtenSteps}, playback says step ${playedSteps[index]}`,
      );
    }
  });
});
