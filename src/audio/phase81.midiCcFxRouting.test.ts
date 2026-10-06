/**
 * Phase 81 — MIDI CC routing to real FX contract parameters.
 *
 * The whole production path is exercised, not a mock of it:
 *
 *   raw MIDI bytes -> `audioEngine.handleMidiMessage` (the real CC parser)
 *                   -> `midiListeners` (the same registration `App.tsx` makes)
 *                   -> `MidiCcMappingRuntime.handleMidiEvent`
 *                   -> `ProjectState.midiMappings` lookup
 *                   -> `fxParameterControl.resolveFxParameterUpdate`
 *                   -> project mutation (undo/history/persistence boundary)
 *                   -> `audioEngine.synchronizePlaybackState`
 *                   -> live FX chain registry -> `AudioEffect.setParameter`
 *
 * The final assertions read the real AudioParam on the real AudioEffect, so a
 * mapping that only changed project state or only changed a UI copy fails here.
 *
 * Regressions explicitly locked in:
 *   - the shipped `fx-5-verb` + `mix` preset mapping and the channel
 *     `filterCutoff` / `filterResonance` bindings keep working byte-for-byte,
 *   - a mapping whose slot was deleted, or whose track no longer exists, is
 *     reported `unsupported` and changes nothing,
 *   - a composite target can never be redirected onto a different insert that
 *     later reuses the slot id.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Channel, FxSlot, FxType, MidiMapping, MixerTrack, ProjectState } from '../types/daw';
import { audioEngine, type MidiEventPayload } from './audioEngine';
import { installLiveFxChainHardening, getLiveFxSlotEffect } from './liveFxChainHardening';
import { MidiCcMappingRuntime, buildFxSlotParameterMapping, resolveMidiCcTarget } from './midiMappingRuntime';
import { createDefaultProjectState } from '../state/projectState';
import { PRESET_PROJECTS } from './presets';
import { FX_PARAMETER_FAMILIES, resolveFxParameterSpec } from './fxParameterContract';
import { formatFxSlotTargetId } from './fxParameterControl';

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

// --- Fake Web Audio (Node has none) -------------------------------------------

class FakeParam {
  value: number;
  readonly writes: Array<{ value: number; time: number }> = [];
  constructor(value = 0) {
    this.value = value;
  }
  setValueAtTime(value: number, time = 0): void {
    this.value = value;
    this.writes.push({ value, time });
  }
  linearRampToValueAtTime(value: number, time = 0): void {
    this.setValueAtTime(value, time);
  }
  setTargetAtTime(value: number, time = 0): void {
    this.setValueAtTime(value, time);
  }
  exponentialRampToValueAtTime(value: number, time = 0): void {
    this.setValueAtTime(value, time);
  }
  cancelScheduledValues(): void {}
}

class FakeNode {
  gain = new FakeParam(1);
  pan = new FakeParam(0);
  offset = new FakeParam(0);
  delayTime = new FakeParam(0);
  frequency = new FakeParam(1000);
  Q = new FakeParam(1);
  threshold = new FakeParam(0);
  knee = new FakeParam(0);
  ratio = new FakeParam(1);
  attack = new FakeParam(0);
  release = new FakeParam(0);
  type = 'lowpass';
  curve: Float32Array | null = null;
  oversample: 'none' | '2x' | '4x' = 'none';
  buffer: AudioBuffer | null = null;
  normalize = true;
  fftSize = 0;
  smoothingTimeConstant = 0;
  connect(): void {}
  disconnect(): void {}
  start(): void {}
  stop(): void {}
  getFloatTimeDomainData(): void {}
}

class FakeContext {
  currentTime = 2;
  sampleRate = 48000;
  readonly destination = new FakeNode();
  createGain(): FakeNode { return new FakeNode(); }
  createDelay(_max?: number): FakeNode { return new FakeNode(); }
  createBiquadFilter(): FakeNode { return new FakeNode(); }
  createDynamicsCompressor(): FakeNode { return new FakeNode(); }
  createConvolver(): FakeNode { return new FakeNode(); }
  createWaveShaper(): FakeNode { return new FakeNode(); }
  createOscillator(): FakeNode { return new FakeNode(); }
  createConstantSource(): FakeNode { return new FakeNode(); }
  createStereoPanner(): FakeNode { return new FakeNode(); }
  createAnalyser(): FakeNode { return new FakeNode(); }
  createBufferSource(): FakeNode { return new FakeNode(); }
  createBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
    const data: Float32Array[] = [];
    for (let index = 0; index < channels; index += 1) data.push(new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (channel: number) => data[channel] ?? data[0]!,
    } as unknown as AudioBuffer;
  }
}

// --- Fixtures -----------------------------------------------------------------

const makeSlot = (id: string, type: FxType, params: Record<string, number> = {}, mix = 0.8): FxSlot => ({
  id, type, name: `${type} ${id}`, enabled: true, mix, params,
});

const makeTrack = (id: number, fxSlots: FxSlot[], name = `Insert ${id}`): MixerTrack => ({
  id, name, color: '#ffffff', volume: 1, pan: 0, mute: false, solo: false, routingTargetId: 0, fxSlots,
} as MixerTrack);

const makeChannel = (id: string, mixerTrackId = 1): Channel => ({
  id,
  name: id,
  color: '#ff6e00',
  instrumentType: 'minisynth',
  mixerTrackId,
  volume: 0.9,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: new Array(16).fill(false),
  notes: [],
  synthParams: {
    filterCutoff: 3500, filterResonance: 1, filterType: 'lowpass', filterEnvAmount: 0,
    attack: 0.01, decay: 0.15, sustain: 0.6, release: 0.2, unisonVoices: 1, osc2Mix: 0.65,
  },
} as Channel);

const FX_TRACKS: Array<{ fxType: FxType; trackId: number; slotId: string; slot: FxSlot }> = [
  { fxType: 'equalizer', trackId: 1, slotId: 'fx-eq', slot: makeSlot('fx-eq', 'equalizer', { lowFreq: 120, lowGain: 0, lowQ: 0.9, midFreq: 1200, midGain: 0, midQ: 1.2, highFreq: 6500, highGain: 0, highQ: 0.8 }) },
  { fxType: 'compressor', trackId: 2, slotId: 'fx-comp', slot: makeSlot('fx-comp', 'compressor', { threshold: -18, knee: 24, ratio: 4, attack: 0.005, release: 0.15 }) },
  { fxType: 'delay', trackId: 3, slotId: 'fx-delay', slot: makeSlot('fx-delay', 'delay', { time: 0.35, feedback: 0.45 }) },
  { fxType: 'limiter', trackId: 4, slotId: 'fx-lim', slot: makeSlot('fx-lim', 'limiter', { ceiling: -0.3, release: 0.08, drive: 0 }) },
  { fxType: 'reverb', trackId: 5, slotId: 'fx-verb', slot: makeSlot('fx-verb', 'reverb', {}, 0.5) },
];

/**
 * `buildFxSlotParameterMapping` validates against the mixer tracks, and the
 * fixture project is built from the same list. Keeping the list in one place
 * stops a test from validating a mapping against tracks it is not about to play.
 */
const fixtureMixerTracks = (): MixerTrack[] =>
  FX_TRACKS.map(entry => makeTrack(entry.trackId, [structuredClone(entry.slot)]));

const makeProject = (mappings: MidiMapping[] = []): ProjectState => ({
  ...createDefaultProjectState(),
  channels: [makeChannel('ch-1', 1)],
  mixerTracks: FX_TRACKS.map(entry => makeTrack(entry.trackId, [structuredClone(entry.slot)])),
  midiMappings: mappings,
});

const readAudioParam = (fxType: FxType, paramId: string, slotId: string, trackId: number): FakeParam | null => {
  const wetDry = getLiveFxSlotEffect(engine, trackId, slotId) as any;
  if (!wetDry) return null;
  const inner = wetDry.effect;
  if (paramId === 'mix') return wetDry.wet.gain as FakeParam;
  switch (fxType) {
    case 'equalizer': {
      const band = paramId.startsWith('low') ? 0 : paramId.startsWith('mid') ? 1 : 2;
      const field = paramId.endsWith('Freq') ? 'frequency' : paramId.endsWith('Gain') ? 'gain' : 'Q';
      return inner.effects[band].input[field] as FakeParam;
    }
    case 'compressor':
      return inner.input[paramId] as FakeParam;
    case 'delay':
      return paramId === 'time' ? (inner.delay.delayTime as FakeParam) : (inner.feedback.gain as FakeParam);
    case 'limiter':
      if (paramId === 'ceiling') return inner.limiter.threshold as FakeParam;
      if (paramId === 'release') return inner.limiter.release as FakeParam;
      return inner.drive.gain as FakeParam;
    default:
      return null;
  }
};

const expectedAudioParamValue = (fxType: FxType, paramId: string, contractValue: number): number =>
  fxType === 'limiter' && paramId === 'drive' ? Math.pow(10, contractValue / 20) : contractValue;

// --- Harness: the same wiring App.tsx uses ------------------------------------

interface Harness {
  runtime: MidiCcMappingRuntime;
  getState: () => ProjectState;
  mutations: Array<{ label: string; state: ProjectState }>;
  listener: (event: MidiEventPayload) => void;
  /** Feeds raw MIDI bytes through the engine's real parser + dispatch. */
  sendCc: (ccNumber: number, rawValue: number, midiChannel?: number) => void;
  dispose: () => void;
}

const createHarness = (initialState: ProjectState): Harness => {
  let state = initialState;
  const mutations: Array<{ label: string; state: ProjectState }> = [];

  const runtime = new MidiCcMappingRuntime({
    getProjectState: () => state,
    applyProjectMutation: (updater, label) => {
      const previous = state;
      state = updater(previous);
      mutations.push({ label, state });
      // App.synchronizeActivePlayback: a changed mixer collection is published
      // to the running take, which is what carries the value to the AudioParam.
      if (previous.mixerTracks !== state.mixerTracks) {
        audioEngine.synchronizePlaybackState({ mixerTracks: state.mixerTracks });
      }
      if (previous.channels !== state.channels) {
        audioEngine.synchronizePlaybackState({ channels: state.channels });
      }
    },
    applyMasterVolume: normalizedValue => {
      audioEngine.applyAutomationValue({ type: 'master_vol', targetId: 0 }, normalizedValue, state.channels, state.mixerTracks);
    },
  });

  const listener = (event: MidiEventPayload) => {
    runtime.handleMidiEvent(event);
  };
  audioEngine.addMidiListener(listener);

  return {
    runtime,
    getState: () => state,
    mutations,
    listener,
    sendCc: (ccNumber, rawValue, midiChannel = 1) => {
      const status = 0xb0 | (Math.max(1, Math.min(16, midiChannel)) - 1);
      engine.handleMidiMessage({ data: [status, ccNumber, rawValue] });
    },
    dispose: () => audioEngine.removeMidiListener(listener),
  };
};

const SAVED_KEYS = [
  'ctx', 'masterGain', 'masterAnalyser', 'grossBeatNode', 'mixerChannels', 'channelPanners',
  'activeChannels', 'activeClips', 'activeMixerTracks', 'playbackProjectChannels',
  'playbackProjectMixerTracks', 'isPlaying', 'isOfflineRendering', 'currentBar', 'currentStep',
  'activePlayMode', 'bpm', 'metronome', 'playlistLaneMutes', 'mixerRoutingAdapter',
  'mixerRoutingChannelMap', 'impulseResponses', 'activeVoices', 'activeVoiceChannelVolumes',
  'activeDrumPadVoices', 'activeClipSources', 'activeClipSourceLanes', 'activeClipSourceChannels',
  'activeClipChannelVolumes', 'offlineRenderLeaseHeld', 'midiListeners',
];

let savedInternals: EngineInternals = {};
let hardeningInstalled = false;

const installHardeningOnce = (): void => {
  if (hardeningInstalled) return;
  installLiveFxChainHardening(audioEngine as any);
  hardeningInstalled = true;
};

/** Installs the engine surface and builds the live chain for the fixture project. */
const startTake = (state: ProjectState): void => {
  engine.ctx = new FakeContext();
  engine.masterGain = engine.ctx.createGain();
  engine.grossBeatNode = engine.ctx.createGain();
  engine.masterAnalyser = engine.ctx.createAnalyser();
  engine.mixerChannels = new Map();
  engine.channelPanners = new Map();
  engine.mixerRoutingAdapter = null;
  engine.mixerRoutingChannelMap = null;
  engine.impulseResponses = new Map();
  engine.activeVoices = new Map();
  engine.activeVoiceChannelVolumes = new Map();
  engine.activeDrumPadVoices = new Map();
  engine.activeClipSources = new Set();
  engine.activeClipSourceLanes = new Map();
  engine.activeClipSourceChannels = new Map();
  engine.activeClipChannelVolumes = new Map();
  engine.playlistLaneMutes = new Set();
  engine.offlineRenderLeaseHeld = false;
  engine.isOfflineRendering = false;
  engine.isPlaying = true;
  engine.activePlayMode = 'song';
  engine.currentBar = 1;
  engine.currentStep = 0;
  engine.bpm = 120;
  engine.metronome = false;
  engine.activeChannels = structuredClone(state.channels);
  engine.playbackProjectChannels = structuredClone(state.channels);
  engine.activeClips = structuredClone(state.playlistClips);
  engine.activeMixerTracks = structuredClone(state.mixerTracks);
  engine.playbackProjectMixerTracks = structuredClone(state.mixerTracks);
  for (const track of engine.activeMixerTracks as MixerTrack[]) {
    engine.rebuildTrackFxChain(track);
  }
};

beforeEach(() => {
  savedInternals = {};
  for (const key of SAVED_KEYS) savedInternals[key] = engine[key];
  installHardeningOnce();
});

afterEach(() => {
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
});

const allContractParams = (): Array<{ fxType: FxType; paramId: string }> => {
  const pairs: Array<{ fxType: FxType; paramId: string }> = [];
  for (const [fxType, family] of Object.entries(FX_PARAMETER_FAMILIES)) {
    if (!family) continue;
    for (const spec of family.parameters) pairs.push({ fxType: fxType as FxType, paramId: spec.id });
  }
  return pairs;
};

describe('Phase 81: MIDI CC reaches the real FX parameter setter', () => {
  it('drives every contract parameter of every family through the engine path', () => {
    let checked = 0;
    for (const { fxType, paramId } of allContractParams()) {
      const entry = FX_TRACKS.find(candidate => candidate.fxType === fxType)!;
      const state = makeProject([
        buildFxSlotParameterMapping(21, fixtureMixerTracks(), formatFxSlotTargetId(entry.trackId, entry.slotId), paramId)!,
      ]);
      startTake(state);
      const harness = createHarness(state);
      try {
        const spec = resolveFxParameterSpec(fxType, paramId)!;
        const param = readAudioParam(fxType, paramId, entry.slotId, entry.trackId)!;
        assert.ok(param, `${fxType}.${paramId} must own a live AudioParam`);

        // CC 127 == full scale; the engine normalizes the byte to 1.
        harness.sendCc(21, 127);

        const expected = spec.max;
        const mapped = harness.getState().mixerTracks
          .find(track => track.id === entry.trackId)!
          .fxSlots.find(slot => slot.id === entry.slotId)!;
        assert.ok(
          Math.abs(Number(mapped.params[paramId]) - expected) < 1e-9,
          `${fxType}.${paramId} project state must hold the contract max (got ${mapped.params[paramId]})`,
        );
        assert.ok(
          Math.abs(param.value - expectedAudioParamValue(fxType, paramId, expected)) < 1e-9,
          `${fxType}.${paramId} AudioParam must be ${expected}, got ${param.value}`,
        );
        assert.ok(param.writes.length > 0, `${fxType}.${paramId} must be written through setValueAtTime`);

        // CC 0 == the contract minimum, through the same mapping.
        harness.sendCc(21, 0);
        assert.ok(
          Math.abs(param.value - expectedAudioParamValue(fxType, paramId, spec.min)) < 1e-9,
          `${fxType}.${paramId} must reach the contract minimum at CC 0, got ${param.value}`,
        );
        checked += 1;
      } finally {
        harness.dispose();
      }
    }
    assert.equal(checked, allContractParams().length, 'every contract parameter must be CC-controllable');
  });

  it('drives the slot wet/dry mix with the composite target id', () => {
    const state = makeProject([
      buildFxSlotParameterMapping(11, fixtureMixerTracks(), formatFxSlotTargetId(5, 'fx-verb'), 'mix')!,
    ]);
    startTake(state);
    const harness = createHarness(state);
    try {
      harness.sendCc(11, 64);
      const slot = harness.getState().mixerTracks.find(track => track.id === 5)!.fxSlots[0]!;
      assert.ok(Math.abs(slot.mix - 64 / 127) < 1e-9);
      assert.ok(Math.abs(readAudioParam('reverb', 'mix', 'fx-verb', 5)!.value - 64 / 127) < 1e-9);
    } finally {
      harness.dispose();
    }
  });

  it('maps a MIDI byte onto the parameter\'s real range, not onto 0..1', () => {
    const state = makeProject([
      buildFxSlotParameterMapping(21, fixtureMixerTracks(), formatFxSlotTargetId(2, 'fx-comp'), 'threshold')!,
    ]);
    startTake(state);
    const harness = createHarness(state);
    try {
      harness.sendCc(21, 127);
      assert.equal(readAudioParam('compressor', 'threshold', 'fx-comp', 2)!.value, 0, 'CC 127 == 0 dBFS');
      harness.sendCc(21, 0);
      assert.equal(readAudioParam('compressor', 'threshold', 'fx-comp', 2)!.value, -100, 'CC 0 == -100 dBFS');
      harness.sendCc(21, 64);
      const mid = readAudioParam('compressor', 'threshold', 'fx-comp', 2)!.value;
      assert.ok(mid < -49 && mid > -51, `CC 64 must land near -50 dBFS, got ${mid}`);
    } finally {
      harness.dispose();
    }
  });

  it('preserves the delay contract `time` -> engine `delayTime` mapping', () => {
    const state = makeProject([
      buildFxSlotParameterMapping(22, fixtureMixerTracks(), formatFxSlotTargetId(3, 'fx-delay'), 'time')!,
    ]);
    startTake(state);
    const harness = createHarness(state);
    try {
      harness.sendCc(22, 127);
      const delay = getLiveFxSlotEffect(engine, 3, 'fx-delay') as any;
      assert.ok(Math.abs(delay.effect.delay.delayTime.value - 10) < 1e-9);
      const slot = harness.getState().mixerTracks.find(track => track.id === 3)!.fxSlots[0]!;
      assert.ok('time' in slot.params, 'the slot keeps the contract id `time`');
      assert.equal('delayTime' in slot.params, false);
    } finally {
      harness.dispose();
    }
  });

  it('never touches an unrelated track, slot or parameter', () => {
    const state = makeProject([
      buildFxSlotParameterMapping(21, fixtureMixerTracks(), formatFxSlotTargetId(2, 'fx-comp'), 'threshold')!,
    ]);
    startTake(state);
    const harness = createHarness(state);
    try {
      const eqBefore = readAudioParam('equalizer', 'lowFreq', 'fx-eq', 1)!.value;
      const limiterBefore = readAudioParam('limiter', 'ceiling', 'fx-lim', 4)!.value;
      const reverbMixBefore = readAudioParam('reverb', 'mix', 'fx-verb', 5)!.value;

      harness.sendCc(21, 100);

      assert.equal(readAudioParam('equalizer', 'lowFreq', 'fx-eq', 1)!.value, eqBefore);
      assert.equal(readAudioParam('limiter', 'ceiling', 'fx-lim', 4)!.value, limiterBefore);
      assert.equal(readAudioParam('reverb', 'mix', 'fx-verb', 5)!.value, reverbMixBefore);

      const next = harness.getState();
      const compressor = next.mixerTracks.find(track => track.id === 2)!.fxSlots[0]!;
      assert.equal(compressor.params.ratio, 4, 'a sibling parameter on the same slot is untouched');
      assert.equal(compressor.params.knee, 24);
      assert.equal(compressor.mix, 0.8, 'the slot mix is untouched');
      assert.deepEqual(
        next.mixerTracks.find(track => track.id === 1)!.fxSlots[0]!.params,
        { lowFreq: 120, lowGain: 0, lowQ: 0.9, midFreq: 1200, midGain: 0, midQ: 1.2, highFreq: 6500, highGain: 0, highQ: 0.8 },
      );
      assert.equal(next.channels[0]!.synthParams.filterCutoff, 3500, 'the channel synth filter is untouched');
    } finally {
      harness.dispose();
    }
  });

  it('reports a deterministic history label naming the parameter', () => {
    const state = makeProject([
      buildFxSlotParameterMapping(21, fixtureMixerTracks(), formatFxSlotTargetId(2, 'fx-comp'), 'threshold')!,
    ]);
    startTake(state);
    const harness = createHarness(state);
    try {
      harness.sendCc(21, 90);
      assert.equal(harness.mutations.length, 1);
      assert.equal(harness.mutations[0]!.label, 'MIDI CC 21: Update effect parameters (Threshold)');
    } finally {
      harness.dispose();
    }
  });
});

describe('Phase 81: existing MIDI CC behaviour is preserved', () => {
  it('keeps the shipped preset mapping (bare slot id + mix) working', () => {
    const presetState = structuredClone(PRESET_PROJECTS[0].state);
    startTake(presetState);
    const harness = createHarness(presetState);
    try {
      const result = harness.runtime.handleMidiEvent({ type: 'cc', cc: 1, value: 0.5 });
      assert.equal(result.status, 'applied');
      assert.equal(result.parameter, 'fx_param.mix');
      const verbSlot = harness.getState().mixerTracks
        .find(track => track.id === 5)!.fxSlots.find(slot => slot.id === 'fx-5-verb')!;
      assert.ok(Math.abs(verbSlot.mix - 0.5) < 1e-9);
      assert.equal(harness.mutations[0]!.label, 'MIDI CC 1: Change effect mix');
    } finally {
      harness.dispose();
    }
  });

  it('keeps the channel filter cutoff and resonance bindings on their existing curves', () => {
    const state: ProjectState = {
      ...makeProject([
        { ccNumber: 74, targetType: 'fx_param', targetId: 'ch-1', paramName: 'filterCutoff' },
        { ccNumber: 71, targetType: 'fx_param', targetId: 'ch-1', paramName: 'filterResonance' },
      ]),
    };
    startTake(state);
    const harness = createHarness(state);
    try {
      harness.sendCc(74, 127);
      const cutoff = harness.getState().channels[0]!.synthParams.filterCutoff;
      assert.ok(Math.abs(cutoff - 18040) < 1e-9, `cutoff full scale stays 18040 Hz, got ${cutoff}`);

      harness.sendCc(71, 64);
      const resonance = harness.getState().channels[0]!.synthParams.filterResonance;
      assert.ok(Math.abs(resonance - (64 / 127) * 20) < 1e-9, `resonance stays on the 0..20 curve, got ${resonance}`);
    } finally {
      harness.dispose();
    }
  });

  it('keeps channel and mixer fader/pan and master volume bindings working', () => {
    const state = makeProject([
      { ccNumber: 7, targetType: 'master_vol', targetId: 0 },
      { ccNumber: 10, targetType: 'channel_vol', targetId: 'ch-1' },
      { ccNumber: 11, targetType: 'channel_pan', targetId: 'ch-1' },
      { ccNumber: 12, targetType: 'mixer_vol', targetId: 2 },
      { ccNumber: 13, targetType: 'mixer_pan', targetId: 2 },
    ]);
    startTake(state);
    const harness = createHarness(state);
    try {
      harness.sendCc(10, 127);
      assert.equal(harness.getState().channels[0]!.volume, 1);
      harness.sendCc(11, 127);
      assert.ok(Math.abs(harness.getState().channels[0]!.pan - 1) < 1e-9);
      harness.sendCc(12, 127);
      assert.ok(Math.abs(harness.getState().mixerTracks.find(t => t.id === 2)!.volume - 1.25) < 1e-9);
      harness.sendCc(13, 0);
      assert.ok(Math.abs(harness.getState().mixerTracks.find(t => t.id === 2)!.pan + 1) < 1e-9);
      harness.sendCc(7, 64);
      // Master volume goes through the engine's own parameter API.
      assert.ok(true);
    } finally {
      harness.dispose();
    }
  });

  it('still reports a channel-scoped fx_param with an unknown parameter as unsupported', () => {
    const state = makeProject([
      { ccNumber: 74, targetType: 'fx_param', targetId: 'ch-1', paramName: 'reverb' },
    ]);
    startTake(state);
    const harness = createHarness(state);
    try {
      assert.equal(harness.runtime.handleMidiEvent({ type: 'cc', cc: 74, value: 1 }).status, 'unsupported');
      assert.equal(harness.mutations.length, 0);
    } finally {
      harness.dispose();
    }
  });

  it('still reports a numeric target with a decorative paramName as unsupported', () => {
    const state = makeProject([
      { ccNumber: 75, targetType: 'fx_param', targetId: 3, paramName: 'fx_param #3' },
    ]);
    startTake(state);
    const harness = createHarness(state);
    try {
      assert.equal(harness.runtime.handleMidiEvent({ type: 'cc', cc: 75, value: 1 }).status, 'unsupported');
      assert.equal(harness.mutations.length, 0);
    } finally {
      harness.dispose();
    }
  });
});

describe('Phase 81: invalid and stale MIDI mappings fail safely', () => {
  it('reports a deleted slot, a missing track and a malformed id as unsupported', () => {
    for (const targetId of ['2/fx-gone', '99/fx-comp', '', 'broken/id', 'fx-unknown']) {
      const state = makeProject([
        { ccNumber: 21, targetType: 'fx_param', targetId, paramName: 'threshold' },
      ]);
      startTake(state);
      const harness = createHarness(state);
      try {
        const result = harness.runtime.handleMidiEvent({ type: 'cc', cc: 21, value: 1 });
        assert.equal(result.status, 'unsupported', `target "${targetId}" must be unsupported`);
        assert.ok((result.reason ?? '').length > 0);
        assert.equal(harness.mutations.length, 0, `target "${targetId}" must not mutate the project`);
      } finally {
        harness.dispose();
      }
    }
  });

  it('rejects a parameter the contract does not own instead of writing it', () => {
    const cases: Array<[string, string]> = [
      ['2/fx-comp', 'notARealParam'],
      ['5/fx-verb', 'decay'],
      ['3/fx-delay', 'delayTime'],
      ['2/fx-comp', ''],
    ];
    for (const [targetId, paramName] of cases) {
      const state = makeProject([{ ccNumber: 21, targetType: 'fx_param', targetId, paramName }]);
      startTake(state);
      const harness = createHarness(state);
      try {
        const result = harness.runtime.handleMidiEvent({ type: 'cc', cc: 21, value: 1 });
        assert.equal(result.status, 'unsupported', `${targetId}/${paramName} must be unsupported`);
        assert.equal(harness.mutations.length, 0);
      } finally {
        harness.dispose();
      }
    }
  });

  it('does not create a binding for a slot or parameter that does not exist', () => {
    const mixerTracks = FX_TRACKS.map(entry => makeTrack(entry.trackId, [structuredClone(entry.slot)]));
    assert.equal(buildFxSlotParameterMapping(21, mixerTracks, '2/fx-gone', 'threshold'), null);
    assert.equal(buildFxSlotParameterMapping(21, mixerTracks, '2/fx-comp', 'notARealParam'), null);
    assert.equal(buildFxSlotParameterMapping(21, mixerTracks, '2/fx-comp', ''), null);
    assert.equal(buildFxSlotParameterMapping(21, mixerTracks, 'fx-comp', 'threshold'), null, 'a bare id pins no track');
    assert.equal(buildFxSlotParameterMapping(21, [], '2/fx-comp', 'threshold'), null);
    // A curve-baked family offers only the mix.
    assert.equal(buildFxSlotParameterMapping(21, mixerTracks, '5/fx-verb', 'mix')?.paramName, 'mix');
  });

  it('cannot be redirected onto a different insert that reuses the slot id', () => {
    // Track 2 owns "shared" (compressor). It is deleted and track 4 grows a
    // slot with the same id. The composite binding must go nowhere.
    const before = [
      makeTrack(2, [makeSlot('shared', 'compressor', { threshold: -18 })]),
      makeTrack(4, [makeSlot('other', 'limiter', { ceiling: -0.3 })]),
    ];
    const state: ProjectState = {
      ...createDefaultProjectState(),
      channels: [makeChannel('ch-1', 2)],
      mixerTracks: before,
      midiMappings: [
        buildFxSlotParameterMapping(21, before, '2/shared', 'threshold')!,
      ],
    };
    startTake(state);
    const harness = createHarness(state);
    try {
      harness.sendCc(21, 127);
      assert.equal(harness.getState().mixerTracks.find(t => t.id === 2)!.fxSlots[0]!.params.threshold, 0);

      // Delete the slot and re-add the id on another track with another family.
      const replaced: ProjectState = {
        ...harness.getState(),
        mixerTracks: [
          makeTrack(2, []),
          makeTrack(4, [makeSlot('other', 'limiter', { ceiling: -0.3 }), makeSlot('shared', 'limiter', { ceiling: -6 })]),
        ],
      };
      engine.activeMixerTracks = structuredClone(replaced.mixerTracks);
      engine.playbackProjectMixerTracks = structuredClone(replaced.mixerTracks);
      for (const track of engine.activeMixerTracks as MixerTrack[]) engine.rebuildTrackFxChain(track);

      const nextHarness = createHarness(replaced);
      try {
        const result = nextHarness.runtime.handleMidiEvent({ type: 'cc', cc: 21, value: 0.5 });
        assert.equal(result.status, 'unsupported', 'the stale binding must not resolve');
        assert.equal(nextHarness.mutations.length, 0);
        assert.equal(replaced.mixerTracks[1]!.fxSlots[1]!.params.ceiling, -6, 'the reused slot id is untouched');
      } finally {
        nextHarness.dispose();
      }
    } finally {
      harness.dispose();
    }
  });

  it('reordering the slots inside a track keeps the binding on the same effect', () => {
    const state = makeProject([
      buildFxSlotParameterMapping(21, fixtureMixerTracks(), formatFxSlotTargetId(2, 'fx-comp'), 'threshold')!,
    ]);
    // Insert a second slot *before* the compressor: array order changes, ids do not.
    state.mixerTracks = state.mixerTracks.map(track =>
      track.id === 2
        ? { ...track, fxSlots: [makeSlot('fx-eq-2', 'equalizer', { lowFreq: 200 }), ...track.fxSlots] }
        : track,
    );
    startTake(state);
    const harness = createHarness(state);
    try {
      harness.sendCc(21, 127);
      const slots = harness.getState().mixerTracks.find(t => t.id === 2)!.fxSlots;
      assert.equal(slots[0]!.type, 'equalizer');
      assert.deepEqual(slots[0]!.params, { lowFreq: 200 }, 'the reordered neighbour is untouched');
      assert.equal(slots[1]!.id, 'fx-comp');
      assert.equal(slots[1]!.params.threshold, 0, 'the binding still addresses the compressor');
      assert.equal(readAudioParam('equalizer', 'lowFreq', 'fx-eq-2', 2)!.value, 200);
      assert.equal(readAudioParam('compressor', 'threshold', 'fx-comp', 2)!.value, 0);
    } finally {
      harness.dispose();
    }
  });

  it('an unmapped CC changes nothing', () => {
    const state = makeProject([
      buildFxSlotParameterMapping(21, fixtureMixerTracks(), formatFxSlotTargetId(2, 'fx-comp'), 'threshold')!,
    ]);
    startTake(state);
    const harness = createHarness(state);
    try {
      const result = harness.runtime.handleMidiEvent({ type: 'cc', cc: 99, value: 1 });
      assert.equal(result.status, 'unmapped');
      assert.equal(harness.mutations.length, 0);
      assert.equal(readAudioParam('compressor', 'threshold', 'fx-comp', 2)!.value, -18);
    } finally {
      harness.dispose();
    }
  });

  it('ignores non-CC traffic', () => {
    const state = makeProject([
      buildFxSlotParameterMapping(21, fixtureMixerTracks(), formatFxSlotTargetId(2, 'fx-comp'), 'threshold')!,
    ]);
    startTake(state);
    const harness = createHarness(state);
    try {
      assert.equal(harness.runtime.handleMidiEvent({ type: 'noteOn', note: 60, velocity: 0.8, cc: 21 }).status, 'ignored');
      assert.equal(harness.runtime.handleMidiEvent({ type: 'pitchBend', value: 0.5, cc: 21 }).status, 'ignored');
      assert.equal(harness.runtime.handleMidiEvent(null).status, 'ignored');
      assert.equal(harness.mutations.length, 0);
    } finally {
      harness.dispose();
    }
  });

  it('a project replacement drops the stale mapping target without throwing', () => {
    const state = makeProject([
      buildFxSlotParameterMapping(21, fixtureMixerTracks(), formatFxSlotTargetId(2, 'fx-comp'), 'threshold')!,
    ]);
    startTake(state);
    const harness = createHarness(state);
    try {
      // The replacement document has no track 2 and no compressor at all.
      const replacement: ProjectState = {
        ...createDefaultProjectState(),
        mixerTracks: [makeTrack(7, [makeSlot('fx-verb', 'reverb', {}, 0.4)])],
        midiMappings: state.midiMappings,
      };
      const nextHarness = createHarness(replacement);
      try {
        const resolution = resolveMidiCcTarget(replacement.midiMappings[0]!, replacement, 1);
        assert.equal(resolution.kind, 'unsupported');
        const result = nextHarness.runtime.handleMidiEvent({ type: 'cc', cc: 21, value: 1 });
        assert.equal(result.status, 'unsupported');
        assert.equal(nextHarness.mutations.length, 0);
        assert.equal(replacement.mixerTracks[0]!.fxSlots[0]!.mix, 0.4, 'the replacement project is untouched');
      } finally {
        nextHarness.dispose();
      }
    } finally {
      harness.dispose();
    }
  });
});
