/**
 * Phase 1B — end-to-end note-duration / gate architecture.
 *
 * Written BEFORE the implementation and observed RED on baseline f7315f77.
 *
 * What the pre-Phase-1B code did:
 *
 *   const duration = (note.duration || 2) * 0.4;   // seconds, BPM never read
 *
 * so the audible gate was identical at 60, 120 and 240 BPM. These tests drive
 * the REAL instrument renderers and the REAL scheduling path and assert the
 * gate is inversely proportional to tempo.
 *
 * Probing method: every renderer schedules its final node stop / release ramp
 * at `time + gate + TAIL`, where TAIL is a per-instrument DSP constant that is
 * itself tempo-independent. Comparing the maximum scheduled time across two
 * tempos therefore cancels the tail exactly and recovers the gate difference
 * without hard-coding any tail:
 *
 *   maxTime(60) - maxTime(120) = gate(60) - gate(120) = gate(60) / 2
 *
 * so gate(60) = 2 * (maxTime(60) - maxTime(120)).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Channel, InstrumentType, MixerTrack, Note, PlaylistClip } from '../types/daw';
import { createInstrumentRegistry, type InstrumentVoiceRenderer } from './instrumentRegistry';
import {
  GATE_CHARACTER,
  resolveGateSeconds,
  type GateSeconds,
} from './noteGate';
import {
  renderSubtractiveSynthVoice,
} from './instruments/subtractiveSynth';
import {
  renderAcid303Voice,
  renderReeseBassVoice,
  render808SubVoice,
  renderSupersawVoice,
  renderAmbientPadVoice,
  renderVoxChoirVoice,
  renderChiptuneVoice,
} from './instruments/legacySynth';
import {
  renderGrandPianoVoice,
  renderRhodesVoice,
  renderOrganVoice,
  renderPluckedGuitarVoice,
  renderStringsVoice,
  renderBrassVoice,
} from './instruments/legacyAcoustic';
import { renderIndependentPluckVoice } from './instruments/independentPluck';
import { audioEngine } from './audioEngine';
import { createDefaultProjectState } from '../state/projectState';
import { polyphonicBlobAuditionNote } from '../components/PolyphonicEditorModal';
import type { PolyphonicBlob } from '../types/daw';

// ---------------------------------------------------------------------------
// Recording fake Web Audio graph
// ---------------------------------------------------------------------------

const scheduledTimes: number[] = [];
const record = (time: number): void => {
  if (typeof time === 'number' && Number.isFinite(time)) scheduledTimes.push(time);
};

class RecParam {
  value = 1;
  setValueAtTime(_v: number, t: number) { record(t); return this; }
  linearRampToValueAtTime(_v: number, t: number) { record(t); return this; }
  exponentialRampToValueAtTime(_v: number, t: number) { record(t); return this; }
  setTargetAtTime(_v: number, t: number) { record(t); return this; }
  setValueCurveAtTime(_v: number[], t: number) { record(t); return this; }
  cancelScheduledValues() { return this; }
}

class RecNode {
  readonly gain = new RecParam();
  readonly pan = new RecParam();
  readonly frequency = new RecParam();
  readonly detune = new RecParam();
  readonly Q = new RecParam();
  readonly playbackRate = new RecParam();
  readonly delayTime = new RecParam();
  readonly threshold = new RecParam();
  readonly knee = new RecParam();
  readonly ratio = new RecParam();
  readonly attack = new RecParam();
  readonly release = new RecParam();
  type = '';
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  connect(target: unknown) { return target; }
  disconnect() {}
  start(t = 0) { record(t); }
  stop(t = 0) { record(t); }
  setPeriodicWave() {}
  addEventListener() {}
  removeEventListener() {}
}

class RecordingContext {
  readonly sampleRate = 44100;
  readonly currentTime = 0;
  readonly destination = new RecNode();
  createGain() { return new RecNode(); }
  createOscillator() { return new RecNode(); }
  createBiquadFilter() { return new RecNode(); }
  createStereoPanner() { return new RecNode(); }
  createBufferSource() { return new RecNode(); }
  createDelay() { return new RecNode(); }
  createConvolver() { return new RecNode(); }
  createDynamicsCompressor() { return new RecNode(); }
  createWaveShaper() { return new RecNode(); }
  createAnalyser() { return new RecNode(); }
  createBuffer(_c: number, length: number, sampleRate: number) {
    return { duration: length / sampleRate, getChannelData: () => new Float32Array(length) };
  }
}

// ---------------------------------------------------------------------------
// Every production renderer that derives a gate from Note.duration
// ---------------------------------------------------------------------------

interface GateCase {
  instrumentType: InstrumentType;
  render: InstrumentVoiceRenderer;
  character: number;
  fallbackSteps: number;
}

/** character / fallback mirror the production wiring in audioEngine.ts. */
const GATE_CASES: GateCase[] = [
  { instrumentType: 'minisynth', render: renderSubtractiveSynthVoice, character: GATE_CHARACTER.neutral, fallbackSteps: 1 },
  { instrumentType: 'wavetable', render: renderSubtractiveSynthVoice, character: GATE_CHARACTER.neutral, fallbackSteps: 1 },
  { instrumentType: 'acid_303', render: renderAcid303Voice, character: GATE_CHARACTER.neutral, fallbackSteps: 1 },
  { instrumentType: 'chiptune_8bit', render: renderChiptuneVoice, character: GATE_CHARACTER.percussive, fallbackSteps: 1 },
  { instrumentType: 'reese_bass', render: renderReeseBassVoice, character: GATE_CHARACTER.firm, fallbackSteps: 2 },
  { instrumentType: 'slap_bass', render: renderReeseBassVoice, character: GATE_CHARACTER.firm, fallbackSteps: 2 },
  { instrumentType: 'supersaw_lead', render: renderSupersawVoice, character: GATE_CHARACTER.firm, fallbackSteps: 2 },
  { instrumentType: 'sub_808', render: render808SubVoice, character: GATE_CHARACTER.broad, fallbackSteps: 2 },
  { instrumentType: 'vox_choir', render: renderVoxChoirVoice, character: GATE_CHARACTER.sustained, fallbackSteps: 2 },
  { instrumentType: 'ambient_pad', render: renderAmbientPadVoice, character: GATE_CHARACTER.pad, fallbackSteps: 2 },
  { instrumentType: 'grand_piano', render: renderGrandPianoVoice, character: GATE_CHARACTER.broad, fallbackSteps: 2 },
  { instrumentType: 'rhodes_epiano', render: renderRhodesVoice, character: GATE_CHARACTER.sustained, fallbackSteps: 2 },
  { instrumentType: 'hammond_organ', render: renderOrganVoice, character: GATE_CHARACTER.sustained, fallbackSteps: 1.5 },
  { instrumentType: 'nylon_guitar', render: renderPluckedGuitarVoice, character: GATE_CHARACTER.broad, fallbackSteps: 2 },
  { instrumentType: 'harpsichord', render: renderPluckedGuitarVoice, character: GATE_CHARACTER.broad, fallbackSteps: 2 },
  { instrumentType: 'strings_ensemble', render: renderStringsVoice, character: GATE_CHARACTER.broad, fallbackSteps: 2 },
  { instrumentType: 'cinematic_brass', render: renderBrassVoice, character: GATE_CHARACTER.sustained, fallbackSteps: 2 },
  { instrumentType: 'independent_pluck', render: renderIndependentPluckVoice, character: GATE_CHARACTER.percussive, fallbackSteps: 1 },
];

/**
 * 4 steps = one beat. Chosen so `independent_pluck`'s pre-existing [0.05, 1.5]s
 * clamp (a DEFERRED audit item, deliberately untouched) never engages at the
 * tempos under test: 4 steps * 0.25s * 0.8 = 0.8s at 60 BPM.
 */
const STEPS = 4;

const makeChannel = (instrumentType: InstrumentType): Channel => ({
  ...createDefaultProjectState().channels[0],
  id: 'gate-ch',
  instrumentType,
  mixerTrackId: 1,
  volume: 0.8,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: [],
  notes: [],
  synthParams: audioEngine.getDefaultSynthParams(),
});

/** Maximum time any node or AudioParam was scheduled at, for one render. */
const maxScheduledTime = (kase: GateCase, note: Note, bpm: number): number => {
  scheduledTimes.length = 0;
  const ctx = new RecordingContext();
  kase.render({
    channel: makeChannel(kase.instrumentType),
    note,
    time: 0,
    destination: ctx.destination as unknown as AudioNode,
    audioContext: ctx as unknown as BaseAudioContext,
    voiceId: 'gate-voice',
    bpm,
    getSampleBuffer: () => undefined,
  });
  assert.ok(scheduledTimes.length > 0, `${kase.instrumentType}: renderer scheduled nothing`);
  return Math.max(...scheduledTimes);
};

const note = (duration: number): Note => ({ id: 'n', pitch: 60, start: 0, duration, velocity: 0.8 });

/**
 * Recovers the absolute 60 BPM gate from two measurements, cancelling the
 * instrument's constant release tail (see file header).
 */
const gateAt60 = (kase: GateCase, duration = STEPS): GateSeconds => {
  const m60 = maxScheduledTime(kase, note(duration), 60);
  const m120 = maxScheduledTime(kase, note(duration), 120);
  return 2 * (m60 - m120);
};

// ---------------------------------------------------------------------------

describe('Phase 1B A — the audible gate scales inversely with BPM', () => {
  for (const kase of GATE_CASES) {
    it(`${kase.instrumentType}: gate(120) ≈ gate(60) * 0.5 and gate(240) ≈ gate(60) * 0.25`, () => {
      const m60 = maxScheduledTime(kase, note(STEPS), 60);
      const m120 = maxScheduledTime(kase, note(STEPS), 120);
      const m240 = maxScheduledTime(kase, note(STEPS), 240);

      const d1 = m60 - m120; // = gate60 - gate120 = gate60 / 2
      const d2 = m120 - m240; // = gate120 - gate240 = gate60 / 4

      assert.ok(d1 > 0, `${kase.instrumentType}: gate must shrink as tempo rises (d1=${d1})`);
      assert.ok(
        Math.abs(d1 - 2 * d2) < 1e-9,
        `${kase.instrumentType}: gate is not inversely proportional to BPM (d1=${d1}, d2=${d2})`,
      );

      const expected60 = resolveGateSeconds(STEPS, 60, { characterFactor: kase.character });
      assert.ok(
        Math.abs(2 * d1 - expected60) < 1e-9,
        `${kase.instrumentType}: expected a 60 BPM gate of ${expected60}s, derived ${2 * d1}s`,
      );
    });
  }

  it('keeps the stored Note.duration identical at every tempo', () => {
    // The gate changes; the musical data does not. Nothing in this phase may
    // rewrite persisted step values.
    for (const kase of GATE_CASES) {
      const sample = note(STEPS);
      maxScheduledTime(kase, sample, 60);
      assert.equal(sample.duration, STEPS, `${kase.instrumentType} mutated Note.duration`);
      maxScheduledTime(kase, sample, 240);
      assert.equal(sample.duration, STEPS, `${kase.instrumentType} mutated Note.duration`);
    }
  });

  it('scales fractional durations correctly', () => {
    for (const kase of GATE_CASES) {
      const derived = gateAt60(kase, 1.5);
      const expected = resolveGateSeconds(1.5, 60, { characterFactor: kase.character });
      assert.ok(
        Math.abs(derived - expected) < 1e-9,
        `${kase.instrumentType}: fractional gate ${derived} != ${expected}`,
      );
    }
  });
});

describe('Phase 1B B — instrument character survives the tempo conversion', () => {
  it('preserves the relative character between every renderer family', () => {
    const neutral = gateAt60(GATE_CASES[0]);
    const ratios: Record<string, number> = {};
    for (const kase of GATE_CASES) {
      ratios[kase.instrumentType] = gateAt60(kase) / neutral;
    }

    // Ratios must match the documented character factors, not all be 1.
    assert.ok(Math.abs(ratios.grand_piano - 1.6) < 1e-6, `grand_piano ratio ${ratios.grand_piano}`);
    assert.ok(Math.abs(ratios.ambient_pad - 1.8) < 1e-6, `ambient_pad ratio ${ratios.ambient_pad}`);
    assert.ok(Math.abs(ratios.sub_808 - 1.6) < 1e-6, `sub_808 ratio ${ratios.sub_808}`);
    assert.ok(Math.abs(ratios.chiptune_8bit - 0.8) < 1e-6, `chiptune ratio ${ratios.chiptune_8bit}`);
    assert.ok(Math.abs(ratios.reese_bass - 1.2) < 1e-6, `reese_bass ratio ${ratios.reese_bass}`);
    assert.ok(Math.abs(ratios.cinematic_brass - 1.4) < 1e-6, `brass ratio ${ratios.cinematic_brass}`);

    const distinct = new Set(Object.values(ratios).map(r => r.toFixed(6)));
    assert.ok(distinct.size >= 6, `expected at least 6 distinct characters, saw ${distinct.size}`);
  });

  it('keeps character constant as tempo changes (character is not a second tempo term)', () => {
    const grandPiano = GATE_CASES.find(c => c.instrumentType === 'grand_piano')!;
    const minisynth = GATE_CASES.find(c => c.instrumentType === 'minisynth')!;
    const ratioAt = (bpm: number): number => {
      const a = maxScheduledTime(grandPiano, note(STEPS), bpm) - maxScheduledTime(grandPiano, note(STEPS), bpm * 2);
      const b = maxScheduledTime(minisynth, note(STEPS), bpm) - maxScheduledTime(minisynth, note(STEPS), bpm * 2);
      return a / b;
    };
    for (const bpm of [30, 60, 120]) {
      assert.ok(Math.abs(ratioAt(bpm) - 1.6) < 1e-6, `character drifted at ${bpm} BPM: ${ratioAt(bpm)}`);
    }
  });

  it('reproduces the legacy sound exactly at the 60 BPM calibration point', () => {
    // Character was derived as legacyMultiplier / 0.25, so at 60 BPM the new
    // gate equals the old step * multiplier product for every instrument.
    const legacyMultiplier: Record<string, number> = {
      chiptune_8bit: 0.2, independent_pluck: 0.2,
      minisynth: 0.25, wavetable: 0.25, acid_303: 0.25,
      reese_bass: 0.3, slap_bass: 0.3, supersaw_lead: 0.3,
      rhodes_epiano: 0.35, hammond_organ: 0.35, vox_choir: 0.35, cinematic_brass: 0.35,
      grand_piano: 0.4, nylon_guitar: 0.4, harpsichord: 0.4, strings_ensemble: 0.4, sub_808: 0.4,
      ambient_pad: 0.45,
    };
    for (const kase of GATE_CASES) {
      const derived = gateAt60(kase, STEPS);
      const legacy = STEPS * legacyMultiplier[kase.instrumentType];
      assert.ok(
        Math.abs(derived - legacy) < 1e-9,
        `${kase.instrumentType}: ${derived} != legacy ${legacy} at 60 BPM`,
      );
    }
  });

  it('applies each instrument’s historic fallback when the duration is unusable', () => {
    for (const kase of GATE_CASES) {
      const derived = gateAt60(kase, 0);
      const expected = resolveGateSeconds(kase.fallbackSteps, 60, { characterFactor: kase.character });
      assert.ok(
        Math.abs(derived - expected) < 1e-9,
        `${kase.instrumentType}: fallback gate ${derived} != ${expected}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Live / offline parity through the real engine
// ---------------------------------------------------------------------------

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

interface CapturedGate {
  instrumentType: InstrumentType;
  duration: number;
  bpm: number;
}

class SimParam {
  value = 1;
  setValueAtTime() { return this; }
  linearRampToValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  setTargetAtTime() { return this; }
  cancelScheduledValues() { return this; }
}

class SimNode {
  readonly gain = new SimParam();
  readonly pan = new SimParam();
  readonly frequency = new SimParam();
  readonly detune = new SimParam();
  readonly Q = new SimParam();
  readonly playbackRate = new SimParam();
  type = '';
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  onended: (() => void) | null = null;
  connect(target: unknown) { return target; }
  disconnect() {}
  start() {}
  stop() {}
  setPeriodicWave() {}
  addEventListener() {}
  removeEventListener() {}
}

class SimAudioContext {
  readonly sampleRate = 8000;
  readonly length = 8000;
  currentTime = 0;
  state: AudioContextState = 'running';
  readonly destination = new SimNode();
  createGain() { return new SimNode(); }
  createOscillator() { return new SimNode(); }
  createBiquadFilter() { return new SimNode(); }
  createStereoPanner() { return new SimNode(); }
  createBufferSource() { return new SimNode(); }
  createAnalyser() { return new SimNode(); }
  createDynamicsCompressor() { return new SimNode(); }
  createWaveShaper() { return new SimNode(); }
  createDelay() { return new SimNode(); }
  createConvolver() { return new SimNode(); }
  createBuffer(_c: number, length: number, sampleRate: number) {
    return { duration: length / sampleRate, length, sampleRate, numberOfChannels: _c, getChannelData: () => new Float32Array(length) };
  }
  resume() { return Promise.resolve(); }
  async startRendering() {
    return {
      numberOfChannels: 2,
      length: this.length,
      sampleRate: this.sampleRate,
      duration: this.length / this.sampleRate,
      getChannelData: () => new Float32Array(this.length),
    };
  }
}

const SAVED_FIELDS = [
  'ctx', 'masterGain', 'grossBeatNode', 'masterAnalyser', 'mixerChannels', 'channelPanners',
  'mixerRoutingAdapter', 'mixerRoutingChannelMap', 'activeVoices', 'activeClipSources',
  'playlistLaneMutes', 'isPlaying', 'isOfflineRendering', 'transport', 'swing', 'bpm',
  'activeChannels', 'activeClips', 'activeMixerTracks', 'playbackProjectChannels',
  'playbackProjectMixerTracks', 'activePlayMode', 'activePatternLengthSteps',
  'instrumentRegistry', 'sampleBuffers', 'projectOwnedSampleBufferIds', 'sessionSampleBufferIds',
] as const;

const savedState: Record<string, unknown> = {};
let realOfflineAudioContext: unknown;
let captured: CapturedGate[] = [];

const installCapturingRegistry = (): void => {
  const wrap = (instrumentType: InstrumentType, inner: InstrumentVoiceRenderer): InstrumentVoiceRenderer =>
    (context) => {
      captured.push({
        instrumentType,
        duration: (context as unknown as { note: Note }).note.duration,
        bpm: (context as unknown as { bpm: number }).bpm,
      });
      return { stop: () => undefined };
    };

  const real = engine.instrumentRegistry;
  const renderers: Partial<Record<InstrumentType, InstrumentVoiceRenderer>> = {};
  for (const kase of GATE_CASES) {
    if (!renderers[kase.instrumentType]) {
      renderers[kase.instrumentType] = wrap(kase.instrumentType, real.get(kase.instrumentType));
    }
  }
  engine.instrumentRegistry = createInstrumentRegistry(renderers, wrap('minisynth', real.get('minisynth')));
};

const setupEngineGraph = (bpm: number): SimAudioContext => {
  const ctx = new SimAudioContext();
  engine.ctx = ctx;
  engine.masterGain = ctx.createGain();
  engine.grossBeatNode = ctx.createGain();
  engine.masterAnalyser = ctx.createAnalyser();
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
  engine.sampleBuffers = new Map();
  engine.projectOwnedSampleBufferIds = new Set();
  engine.sessionSampleBufferIds = new Set();
  return ctx;
};

const makeMixerTracks = (): MixerTrack[] => [0, 1].map(id => ({
  id, name: id === 0 ? 'Master' : 'Insert 1', color: '#fff', volume: 0.9, pan: 0,
  mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0,
}));

const parityChannel = (instrumentType: InstrumentType): Channel => ({
  ...makeChannel(instrumentType),
  notes: [{ id: 'p1', pitch: 60, start: 0, duration: 2, velocity: 0.9 }],
});

describe('Phase 1B D — live and offline production paths agree on gate semantics', () => {
  beforeEach(() => {
    for (const field of SAVED_FIELDS) savedState[field] = engine[field];
    captured = [];
    realOfflineAudioContext = (globalThis as any).OfflineAudioContext;
    (globalThis as any).OfflineAudioContext = SimAudioContext;
    (globalThis as any).window = { AudioContext: SimAudioContext, OfflineAudioContext: SimAudioContext };
  });

  afterEach(() => {
    for (const field of SAVED_FIELDS) engine[field] = savedState[field];
    (globalThis as any).OfflineAudioContext = realOfflineAudioContext;
    (globalThis as any).window = undefined;
  });

  for (const bpm of [60, 120, 240]) {
    it(`supplies the same (Note.duration, bpm) gate inputs live and offline at ${bpm} BPM`, async () => {
      const instrumentType: InstrumentType = 'minisynth';
      const channel = parityChannel(instrumentType);

      // --- LIVE: drive one step of the real Pattern-Mode scheduler.
      setupEngineGraph(bpm);
      installCapturingRegistry();
      let callbacks: { onStep?: (step: number, bar: number, t: number) => void } | null = null;
      engine.transport = {
        setBpm: () => undefined, setMode: () => undefined, setPatternLoopSteps: () => undefined,
        setTimeSignature: () => undefined,
        setSongEndSteps: () => undefined,
        setCallbacks: (next: typeof callbacks) => { callbacks = next; },
        start: () => undefined, stop: () => undefined, pause: () => undefined, seek: () => undefined,
        getState: () => ({ bpm, beatsPerBar: 4, stepsPerBeat: 4, mode: 'pat', playing: true, positionSeconds: 0, step: 0, bar: 1 }),
      };
      audioEngine.play([channel], [] as PlaylistClip[], 'pat', 'pat-1', makeMixerTracks(), 16, []);
      captured = [];
      callbacks?.onStep?.(0, 1, 0);
      const live = [...captured];

      // --- OFFLINE: the production export renderer.
      // `minimumDurationSeconds` is 0 so the render covers exactly one bar; the
      // 4 s default would loop the pattern several times at fast tempos and
      // merely repeat the same voice rather than exercise a different path.
      setupEngineGraph(bpm);
      installCapturingRegistry();
      captured = [];
      await audioEngine.renderTimelineOffline(
        [channel], [] as PlaylistClip[], makeMixerTracks(), bpm, 1, undefined, false, 'pattern', undefined, 16,
        undefined, 0,
      );
      const offline = [...captured];

      assert.ok(live.length > 0, 'live path scheduled no voices');
      assert.ok(offline.length > 0, 'offline path scheduled no voices');

      // `resolveGateSeconds` is pure (proven in noteGate.test.ts), so identical
      // inputs ⇒ identical gate seconds. Every voice in both paths must carry
      // the same (Note.duration, bpm); the offline render may repeat the loop,
      // so compare content rather than array length.
      for (const entry of [...live, ...offline]) {
        assert.equal(entry.duration, 2, 'Note.duration must stay in steps');
        assert.equal(entry.bpm, bpm, `renderer must receive the project BPM, saw ${entry.bpm}`);
      }
      assert.deepEqual(offline[0], live[0], `live/offline gate inputs diverged at ${bpm} BPM`);
      assert.deepEqual(
        [...new Set(offline.map(e => `${e.instrumentType}|${e.duration}|${e.bpm}`))],
        [`minisynth|2|${bpm}`],
        `offline produced inconsistent gate inputs at ${bpm} BPM`,
      );
    });
  }

  it('passes the project BPM, never the 120 default or the 128 engine default', () => {
    for (const bpm of [96, 128]) {
      setupEngineGraph(bpm);
      installCapturingRegistry();
      captured = [];
      audioEngine.playNote(parityChannel('grand_piano'), note(2), 0, bpm);
      assert.ok(captured.length > 0, 'playNote scheduled no voice');
      for (const entry of captured) {
        assert.equal(entry.bpm, bpm, `expected project BPM ${bpm}, saw ${entry.bpm}`);
      }
    }
  });
});

describe('Phase 1B E — Polyphonic Editor preview uses steps, not beats', () => {
  it('passes durationSteps straight through to the steps-based Note.duration', () => {
    const blob: PolyphonicBlob = {
      id: 'blob-x', originalPitch: 60, targetPitch: 64, startStep: 0, durationSteps: 4,
      amplitude: 0.9, formantShift: 0, pitchDriftAmount: 0, vibratoDepth: 0, color: '#fff',
    };
    const auditionNote = polyphonicBlobAuditionNote(blob);
    assert.equal(
      auditionNote.duration,
      4,
      'durationSteps/4 was the defect: both fields are sixteenth-note steps, so ' +
      'no conversion is allowed (a 4-step blob was auditioning as a 1-beat note)',
    );
  });

  it('keeps the preview gate proportional to the blob length', () => {
    const gateFor = (durationSteps: number): number => {
      const blob: PolyphonicBlob = {
        id: 'b', originalPitch: 60, targetPitch: 60, startStep: 0, durationSteps,
        amplitude: 1, formantShift: 0, pitchDriftAmount: 0, vibratoDepth: 0, color: '#fff',
      };
      return polyphonicBlobAuditionNote(blob).duration;
    };
    assert.equal(gateFor(8) / gateFor(4), 2);
    assert.equal(gateFor(4) / gateFor(2), 2);
    assert.equal(gateFor(1), 1);
  });
});
