/**
 * Phase 81 — real FX parameter automation through the production audio engine.
 *
 * Everything here drives the shipped `audioEngine` singleton: the live FX chain
 * hardening is installed on it exactly the way `src/main.tsx` does at boot, the
 * chain is built by the production `rebuildTrackFxChain`, and the assertions
 * read the *real* AudioParam objects on the *real* AudioEffect instances
 * (`DynamicsCompressorEffect`, `DelayEffect`, `LimiterEffect`, the EQ's three
 * `BiquadFilterEffect`s, and the `WetDryEffect` wrapper). A parameter that only
 * changed project state, or only changed a UI copy, fails these tests.
 *
 * A fake AudioContext stands in for Web Audio (Node has none). It records every
 * `setValueAtTime` so the tests can prove both the value and that the write went
 * through the AudioParam rather than through a rebuild. Acoustic output parity
 * is not claimed here; the live/offline *evaluation* parity test at the bottom
 * is the strongest invariant this environment can prove, and it is stated as
 * such.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Channel, FxSlot, FxType, MixerTrack, PlaylistClip } from '../types/daw';
import { audioEngine } from './audioEngine';
import { installLiveFxChainHardening, getLiveFxSlotEffect } from './liveFxChainHardening';
import { FX_PARAMETER_FAMILIES, resolveFxParameterSpec } from './fxParameterContract';
import { formatFxSlotTargetId } from './fxParameterControl';

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

// --- Fake Web Audio -----------------------------------------------------------

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
    this.value = value;
    this.writes.push({ value, time });
  }
  setTargetAtTime(value: number, time = 0): void {
    this.value = value;
    this.writes.push({ value, time });
  }
  exponentialRampToValueAtTime(value: number, time = 0): void {
    this.value = value;
    this.writes.push({ value, time });
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
  readonly connections: unknown[] = [];
  connect(target?: unknown): void {
    this.connections.push(target);
  }
  disconnect(): void {
    this.connections.length = 0;
  }
  start(): void {}
  stop(): void {}
  getFloatTimeDomainData(): void {}
}

class FakeContext {
  currentTime = 1.25;
  sampleRate = 48000;
  readonly destination = new FakeNode();
  readonly created: FakeNode[] = [];
  private make(): FakeNode {
    const node = new FakeNode();
    this.created.push(node);
    return node;
  }
  createGain(): FakeNode { return this.make(); }
  createDelay(_max?: number): FakeNode { return this.make(); }
  createBiquadFilter(): FakeNode { return this.make(); }
  createDynamicsCompressor(): FakeNode { return this.make(); }
  createConvolver(): FakeNode { return this.make(); }
  createWaveShaper(): FakeNode { return this.make(); }
  createOscillator(): FakeNode { return this.make(); }
  createConstantSource(): FakeNode { return this.make(); }
  createStereoPanner(): FakeNode { return this.make(); }
  createAnalyser(): FakeNode { return this.make(); }
  createBufferSource(): FakeNode { return this.make(); }
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

class MockOfflineAudioContext extends FakeContext {
  currentTime = 0;
  readonly length: number;
  constructor(_channels: number, length: number, sampleRate: number) {
    super();
    this.length = length;
    this.sampleRate = sampleRate;
  }
  async startRendering(): Promise<AudioBuffer> {
    return this.createBuffer(2, Math.max(1, this.length), this.sampleRate);
  }
}

// --- Fixtures -----------------------------------------------------------------

const makeSlot = (id: string, type: FxType, params: Record<string, number> = {}, mix = 0.8): FxSlot => ({
  id,
  type,
  name: `${type} ${id}`,
  enabled: true,
  mix,
  params,
});

const makeTrack = (id: number, fxSlots: FxSlot[], name = `Insert ${id}`): MixerTrack => ({
  id,
  name,
  color: '#ffffff',
  volume: 1,
  pan: 0,
  mute: false,
  solo: false,
  routingTargetId: 0,
  fxSlots,
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
    filterCutoff: 3500,
    filterResonance: 1,
    filterType: 'lowpass',
    filterEnvAmount: 0,
    attack: 0.01,
    decay: 0.15,
    sustain: 0.6,
    release: 0.2,
    unisonVoices: 1,
    osc2Mix: 0.65,
  },
} as Channel);

const makeAutomationClip = (
  id: string,
  target: NonNullable<PlaylistClip['automationTarget']>,
  points: Array<{ x: number; y: number }>,
  startBar = 0,
  lengthBars = 4,
): PlaylistClip => ({
  id,
  trackIndex: 0,
  startBar,
  lengthBars,
  type: 'automation',
  color: '#00e5ff',
  name: id,
  automationTarget: target,
  automationPoints: points.map(point => ({ ...point, tension: 0 })),
});

/** The five implemented families, one slot each, on their own mixer insert. */
const buildFixture = () => {
  const tracks = [
    makeTrack(1, [makeSlot('fx-eq', 'equalizer', { lowFreq: 120, lowGain: 0, lowQ: 0.9, midFreq: 1200, midGain: 0, midQ: 1.2, highFreq: 6500, highGain: 0, highQ: 0.8 })]),
    makeTrack(2, [makeSlot('fx-comp', 'compressor', { threshold: -18, knee: 24, ratio: 4, attack: 0.005, release: 0.15 })]),
    makeTrack(3, [makeSlot('fx-delay', 'delay', { time: 0.35, feedback: 0.45 })]),
    makeTrack(4, [makeSlot('fx-lim', 'limiter', { ceiling: -0.3, release: 0.08, drive: 0 })]),
    makeTrack(5, [makeSlot('fx-verb', 'reverb', {}, 0.5)]),
  ];
  return { tracks, channels: [makeChannel('ch-1', 1)] };
};

/** Reads the real AudioParam a contract parameter lands on for each family. */
const readAudioParam = (fxType: FxType, paramId: string, slotId: string, trackId: number): FakeParam | null => {
  const wetDry = getLiveFxSlotEffect(engine, trackId, slotId) as any;
  if (!wetDry) return null;
  const inner = wetDry.effect;
  if (paramId === 'mix') return wetDry.wet.gain as FakeParam;
  switch (fxType) {
    case 'equalizer': {
      const band = paramId.startsWith('low') ? 0 : paramId.startsWith('mid') ? 1 : 2;
      const filter = inner.effects[band];
      const field = paramId.endsWith('Freq') ? 'frequency' : paramId.endsWith('Gain') ? 'gain' : 'Q';
      return filter.input[field] as FakeParam;
    }
    case 'compressor':
      return inner.input[paramId] as FakeParam;
    case 'delay':
      return paramId === 'time'
        ? (inner.delay.delayTime as FakeParam)
        : (inner.feedback.gain as FakeParam);
    case 'limiter':
      if (paramId === 'ceiling') return inner.limiter.threshold as FakeParam;
      if (paramId === 'release') return inner.limiter.release as FakeParam;
      return inner.drive.gain as FakeParam; // drive is stored as linear gain
    default:
      return null;
  }
};

/** The AudioParam value a contract value must produce (limiter drive is dB -> linear). */
const expectedAudioParamValue = (fxType: FxType, paramId: string, contractValue: number): number =>
  fxType === 'limiter' && paramId === 'drive' ? Math.pow(10, contractValue / 20) : contractValue;

const applyFxParam = (
  trackId: number,
  slotId: string,
  paramId: string,
  normalized: number,
  mixerTracks: MixerTrack[],
  channels: Channel[] = [],
): void => {
  engine.applyAutomationValue(
    { type: 'fx_param', targetId: formatFxSlotTargetId(trackId, slotId), paramName: paramId },
    normalized,
    channels,
    mixerTracks,
    engine.ctx.currentTime,
  );
};

const SAVED_KEYS = [
  'ctx', 'masterGain', 'masterAnalyser', 'grossBeatNode', 'mixerChannels', 'channelPanners',
  'activeChannels', 'activeClips', 'activeMixerTracks', 'playbackProjectChannels',
  'playbackProjectMixerTracks', 'isPlaying', 'isOfflineRendering', 'currentBar', 'currentStep',
  'activePlayMode', 'bpm', 'metronome', 'playlistLaneMutes', 'mixerRoutingAdapter',
  'mixerRoutingChannelMap', 'impulseResponses', 'activeVoices', 'activeVoiceChannelVolumes',
  'activeDrumPadVoices', 'activeClipSources', 'activeClipSourceLanes', 'activeClipSourceChannels',
  'activeClipChannelVolumes', 'offlineRenderLeaseHeld', 'swing',
];

let savedInternals: EngineInternals = {};
let savedOfflineCtor: unknown;
let liveCtx: FakeContext;
let hardeningInstalled = false;

const installHardeningOnce = (): void => {
  if (hardeningInstalled) return;
  installLiveFxChainHardening(audioEngine as any);
  hardeningInstalled = true;
};

beforeEach(() => {
  savedInternals = {};
  for (const key of SAVED_KEYS) savedInternals[key] = engine[key];
  savedOfflineCtor = (globalThis as any).OfflineAudioContext;
  (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;

  liveCtx = new FakeContext();
  engine.ctx = liveCtx;
  engine.masterGain = liveCtx.createGain();
  engine.grossBeatNode = liveCtx.createGain();
  engine.masterAnalyser = liveCtx.createAnalyser();
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
  engine.swing = 0;
  engine.activeChannels = [];
  engine.activeClips = [];
  engine.activeMixerTracks = [];
  engine.playbackProjectChannels = [];
  engine.playbackProjectMixerTracks = [];
  installHardeningOnce();
});

afterEach(() => {
  (globalThis as any).OfflineAudioContext = savedOfflineCtor;
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
});

/** Builds the live chain for a set of tracks and installs them as the running take. */
const startTake = (tracks: MixerTrack[], channels: Channel[] = []) => {
  engine.activeMixerTracks = structuredClone(tracks);
  engine.playbackProjectMixerTracks = structuredClone(tracks);
  engine.activeChannels = structuredClone(channels);
  engine.playbackProjectChannels = structuredClone(channels);
  for (const track of engine.activeMixerTracks) {
    engine.rebuildTrackFxChain(track);
  }
};

const allContractParams = (): Array<{ fxType: FxType; paramId: string }> => {
  const pairs: Array<{ fxType: FxType; paramId: string }> = [];
  for (const [fxType, family] of Object.entries(FX_PARAMETER_FAMILIES)) {
    if (!family) continue;
    for (const spec of family.parameters) pairs.push({ fxType: fxType as FxType, paramId: spec.id });
  }
  return pairs;
};

const SLOT_BY_TYPE: Record<string, { trackId: number; slotId: string }> = {
  equalizer: { trackId: 1, slotId: 'fx-eq' },
  compressor: { trackId: 2, slotId: 'fx-comp' },
  delay: { trackId: 3, slotId: 'fx-delay' },
  limiter: { trackId: 4, slotId: 'fx-lim' },
};

describe('Phase 81: automation reaches the real AudioParam for every contract parameter', () => {
  it('drives every parameter of every implemented family through the live chain', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);

    let checked = 0;
    for (const { fxType, paramId } of allContractParams()) {
      const where = SLOT_BY_TYPE[fxType];
      assert.ok(where, `fixture must own a slot for ${fxType}`);
      const spec = resolveFxParameterSpec(fxType, paramId)!;
      const param = readAudioParam(fxType, paramId, where.slotId, where.trackId);
      assert.ok(param, `${fxType}.${paramId} must have a live AudioParam`);

      applyFxParam(where.trackId, where.slotId, paramId, 0.75, engine.activeMixerTracks, engine.activeChannels);

      const expectedContract = spec.min + 0.75 * (spec.max - spec.min);
      const activeSlot = engine.activeMixerTracks
        .find((track: MixerTrack) => track.id === where.trackId)!
        .fxSlots.find((slot: FxSlot) => slot.id === where.slotId)!;
      assert.ok(
        Math.abs(Number(activeSlot.params[paramId]) - expectedContract) < 1e-9,
        `${fxType}.${paramId} must be written into the take's slot.params (got ${activeSlot.params[paramId]}, want ${expectedContract})`,
      );
      assert.ok(
        Math.abs(param.value - expectedAudioParamValue(fxType, paramId, expectedContract)) < 1e-9,
        `${fxType}.${paramId} AudioParam must be ${expectedContract} (got ${param.value})`,
      );
      assert.ok(param.writes.length > 0, `${fxType}.${paramId} must be written through setValueAtTime`);
      checked += 1;
    }
    assert.equal(checked, allContractParams().length);
  });

  it('drives the per-slot wet/dry mix for every family, including the convolver reverb', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);

    for (const track of engine.activeMixerTracks as MixerTrack[]) {
      for (const slot of track.fxSlots) {
        applyFxParam(track.id, slot.id, 'mix', 0.25, engine.activeMixerTracks, engine.activeChannels);
        assert.equal(slot.mix, 0.25, `${slot.id} slot.mix must follow the automation`);
        const wet = readAudioParam(slot.type, 'mix', slot.id, track.id);
        assert.ok(wet, `${slot.id} must have a live wet gain`);
        assert.ok(Math.abs(wet!.value - 0.25) < 1e-9, `${slot.id} wet gain must be 0.25, got ${wet!.value}`);
      }
    }
  });

  it('sweeps each parameter across its real range at 0, 0.5 and 1', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);

    for (const { fxType, paramId } of allContractParams()) {
      const where = SLOT_BY_TYPE[fxType];
      if (!where) continue;
      const spec = resolveFxParameterSpec(fxType, paramId)!;
      const param = readAudioParam(fxType, paramId, where.slotId, where.trackId)!;
      for (const normalized of [0, 0.5, 1]) {
        applyFxParam(where.trackId, where.slotId, paramId, normalized, engine.activeMixerTracks, engine.activeChannels);
        const expected = spec.min + normalized * (spec.max - spec.min);
        assert.ok(
          Math.abs(param.value - expectedAudioParamValue(fxType, paramId, expected)) < 1e-9,
          `${fxType}.${paramId} at ${normalized} must be ${expected}, got ${param.value}`,
        );
      }
      // The parameter's native range is not 0..1 for almost every entry, which
      // is the property that makes a pass-through conversion a silent bug.
      if (spec.min !== 0 || spec.max !== 1) {
        applyFxParam(where.trackId, where.slotId, paramId, 0.5, engine.activeMixerTracks, engine.activeChannels);
        assert.notEqual(param.value, 0.5, `${fxType}.${paramId} must not pass 0.5 through unchanged`);
      }
    }
  });

  it('preserves the contract `time` -> engine `delayTime` mapping', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);
    const delay = getLiveFxSlotEffect(engine, 3, 'fx-delay') as any;
    assert.equal(delay.effect.name, 'Delay');

    applyFxParam(3, 'fx-delay', 'time', 1, engine.activeMixerTracks, engine.activeChannels);
    assert.ok(Math.abs(delay.effect.delay.delayTime.value - 10) < 1e-9, 'full-scale automation is 10 s on the DelayNode');

    applyFxParam(3, 'fx-delay', 'time', 0, engine.activeMixerTracks, engine.activeChannels);
    assert.equal(delay.effect.delay.delayTime.value, 0);

    applyFxParam(3, 'fx-delay', 'feedback', 1, engine.activeMixerTracks, engine.activeChannels);
    assert.ok(
      delay.effect.feedback.gain.value < 0.99,
      `feedback must stay below the DelayEffect's hard 0.99 bound, got ${delay.effect.feedback.gain.value}`,
    );
    assert.ok(Math.abs(delay.effect.feedback.gain.value - 0.989) < 1e-9);

    const slot = engine.activeMixerTracks.find((t: MixerTrack) => t.id === 3)!.fxSlots[0]!;
    assert.ok('time' in slot.params, 'the slot keeps the contract id `time`, not the AudioParam name');
    assert.equal('delayTime' in slot.params, false);
  });

  it('clamps out-of-range normalized values and defaults non-finite ones instead of writing NaN', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);
    const param = readAudioParam('compressor', 'threshold', 'fx-comp', 2)!;

    applyFxParam(2, 'fx-comp', 'threshold', 5, engine.activeMixerTracks, engine.activeChannels);
    assert.equal(param.value, 0, 'above full scale saturates at the contract max');
    assert.equal(engine.activeMixerTracks.find((t: MixerTrack) => t.id === 2)!.fxSlots[0]!.params.threshold, 0);

    applyFxParam(2, 'fx-comp', 'threshold', -5, engine.activeMixerTracks, engine.activeChannels);
    assert.equal(param.value, -100);

    applyFxParam(2, 'fx-comp', 'threshold', Number.NaN, engine.activeMixerTracks, engine.activeChannels);
    assert.equal(param.value, -18, 'a non-finite lane value lands on the contract default');
    assert.equal(
      engine.activeMixerTracks.find((t: MixerTrack) => t.id === 2)!.fxSlots[0]!.params.threshold,
      -18,
    );

    applyFxParam(2, 'fx-comp', 'threshold', Number.POSITIVE_INFINITY, engine.activeMixerTracks, engine.activeChannels);
    assert.equal(param.value, -18);
  });

  it('leaves everything untouched for an unknown parameter id', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);
    const before = structuredClone(engine.activeMixerTracks);
    const threshold = readAudioParam('compressor', 'threshold', 'fx-comp', 2)!;
    const writesBefore = threshold.writes.length;

    for (const paramId of ['notARealParam', 'delayTime', '', '  ']) {
      assert.doesNotThrow(() =>
        applyFxParam(2, 'fx-comp', paramId, 0.5, engine.activeMixerTracks, engine.activeChannels));
    }
    assert.deepEqual(engine.activeMixerTracks, before);
    assert.equal(threshold.writes.length, writesBefore, 'no AudioParam write for a rejected parameter');
  });

  it('fails safe for a missing track, a deleted slot and a stale reference', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);
    const before = structuredClone(engine.activeMixerTracks);
    const threshold = readAudioParam('compressor', 'threshold', 'fx-comp', 2)!;
    const writesBefore = threshold.writes.length;

    assert.doesNotThrow(() => engine.applyAutomationValue(
      { type: 'fx_param', targetId: '99/fx-comp', paramName: 'threshold' }, 0.5, [], engine.activeMixerTracks, 1));
    assert.doesNotThrow(() => engine.applyAutomationValue(
      { type: 'fx_param', targetId: '2/fx-deleted', paramName: 'threshold' }, 0.5, [], engine.activeMixerTracks, 1));
    assert.doesNotThrow(() => engine.applyAutomationValue(
      { type: 'fx_param', targetId: '', paramName: 'threshold' }, 0.5, [], engine.activeMixerTracks, 1));
    assert.doesNotThrow(() => engine.applyAutomationValue(
      { type: 'fx_param', targetId: 'broken/id', paramName: 'threshold' }, 0.5, [], engine.activeMixerTracks, 1));

    assert.deepEqual(engine.activeMixerTracks, before);
    assert.equal(threshold.writes.length, writesBefore);
  });

  it('cannot be redirected onto a different insert by a reused slot id', () => {
    // Track 2's compressor slot is deleted and track 4 grows a slot with the
    // same id. A pinned composite target must go nowhere rather than drive the
    // limiter.
    const tracks = [
      makeTrack(2, [makeSlot('shared', 'compressor', { threshold: -18 })]),
      makeTrack(4, [makeSlot('other', 'limiter', { ceiling: -0.3 })]),
    ];
    startTake(tracks);
    const limiterCeiling = readAudioParam('limiter', 'ceiling', 'other', 4)!;
    const ceilingWrites = limiterCeiling.writes.length;

    // Delete the compressor slot from the take, then re-add the id on track 4.
    engine.activeMixerTracks = [
      makeTrack(2, []),
      makeTrack(4, [makeSlot('other', 'limiter', { ceiling: -0.3 }), makeSlot('shared', 'limiter', { ceiling: -6 })]),
    ];
    for (const track of engine.activeMixerTracks) engine.rebuildTrackFxChain(track);

    engine.applyAutomationValue(
      { type: 'fx_param', targetId: '2/shared', paramName: 'ceiling' }, 1, [], engine.activeMixerTracks, 1);

    assert.equal(limiterCeiling.writes.length, ceilingWrites, 'the unrelated limiter must not be touched');
    const track4 = engine.activeMixerTracks.find((t: MixerTrack) => t.id === 4)!;
    assert.equal(track4.fxSlots[0]!.params.ceiling, -0.3);
    assert.equal(track4.fxSlots[1]!.params.ceiling, -6, 'the reused slot id on the wrong track is not addressed');
  });

  it('never mutates an unrelated track, slot or parameter', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);

    applyFxParam(2, 'fx-comp', 'threshold', 1, engine.activeMixerTracks, engine.activeChannels);

    const tracks = engine.activeMixerTracks as MixerTrack[];
    const compressor = tracks.find(t => t.id === 2)!.fxSlots[0]!;
    assert.equal(compressor.params.threshold, 0);
    assert.equal(compressor.params.ratio, 4, 'a sibling parameter is untouched');
    assert.equal(compressor.params.knee, 24);
    assert.equal(compressor.mix, 0.8, 'the slot mix is untouched');

    const eq = tracks.find(t => t.id === 1)!.fxSlots[0]!;
    assert.deepEqual(eq.params, {
      lowFreq: 120, lowGain: 0, lowQ: 0.9, midFreq: 1200, midGain: 0, midQ: 1.2,
      highFreq: 6500, highGain: 0, highQ: 0.8,
    });
    const eqLowFreq = readAudioParam('equalizer', 'lowFreq', 'fx-eq', 1)!;
    assert.equal(eqLowFreq.value, 120, 'a different insert keeps its AudioParam');

    const delay = tracks.find(t => t.id === 3)!.fxSlots[0]!;
    assert.deepEqual(delay.params, { time: 0.35, feedback: 0.45 });
  });

  it('keeps manual parameter editing working before and after automation', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);

    // Manual edit through the Phase 80 public API.
    assert.equal(engine.setFxSlotParameter(2, 'fx-comp', 'threshold', -30), true);
    assert.equal(readAudioParam('compressor', 'threshold', 'fx-comp', 2)!.value, -30);

    // Automation takes over.
    applyFxParam(2, 'fx-comp', 'threshold', 1, engine.activeMixerTracks, engine.activeChannels);
    assert.equal(readAudioParam('compressor', 'threshold', 'fx-comp', 2)!.value, 0);

    // The user can still edit the parameter by hand afterwards.
    assert.equal(engine.setFxSlotParameter(2, 'fx-comp', 'threshold', -12), true);
    assert.equal(readAudioParam('compressor', 'threshold', 'fx-comp', 2)!.value, -12);
  });

  it('keeps the legacy fx_mix target working unchanged', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);

    engine.applyAutomationValue(
      { type: 'fx_mix', targetId: 5, paramName: 'fx-verb' }, 0.25, [], engine.activeMixerTracks, 1);
    const slot = engine.activeMixerTracks.find((t: MixerTrack) => t.id === 5)!.fxSlots[0]!;
    assert.equal(slot.mix, 0.25);
    assert.ok(Math.abs(readAudioParam('reverb', 'mix', 'fx-verb', 5)!.value - 0.25) < 1e-9);
  });
});

describe('Phase 81: automation is evaluated continuously during playback', () => {
  it('re-evaluates the lane on every scheduled step, not only when the user edits', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);
    const clip = makeAutomationClip(
      'auto-comp-threshold',
      { type: 'fx_param', targetId: '2/fx-comp', paramName: 'threshold' },
      [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      0,
      4,
    );
    engine.activeClips = [clip];
    engine.currentBar = 1;

    const param = readAudioParam('compressor', 'threshold', 'fx-comp', 2)!;
    const observed: number[] = [];
    // A 4-bar lane starting at bar 0 reaches relX 1 at global step 64.
    for (let step = 0; step <= 64; step += 8) {
      engine.currentBar = Math.floor(step / 16) + 1;
      engine.currentStep = step % 16;
      engine.triggerCurrentStep(step * 0.125);
      observed.push(param.value);
    }

    assert.equal(observed.length, 9);
    assert.ok(Math.abs(observed[0]! - -100) < 1e-9, `first step is the lane minimum, got ${observed[0]}`);
    assert.ok(Math.abs(observed[observed.length - 1]! - 0) < 1e-9, 'last step is the lane maximum');
    for (let index = 1; index < observed.length; index += 1) {
      assert.ok(
        observed[index]! > observed[index - 1]!,
        `threshold must rise monotonically across steps (${observed.join(', ')})`,
      );
    }
    const slot = engine.activeMixerTracks.find((t: MixerTrack) => t.id === 2)!.fxSlots[0]!;
    assert.equal(slot.params.threshold, observed[observed.length - 1]);
  });

  it('evaluates a lane for a slot on a different insert without disturbing the first', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);
    engine.activeClips = [
      makeAutomationClip('auto-eq', { type: 'fx_param', targetId: '1/fx-eq', paramName: 'midFreq' },
        [{ x: 0, y: 0 }, { x: 1, y: 1 }], 0, 2),
      makeAutomationClip('auto-delay', { type: 'fx_param', targetId: '3/fx-delay', paramName: 'time' },
        [{ x: 0, y: 1 }, { x: 1, y: 0 }], 0, 2),
    ];

    // barIdx = currentBar - 1, so currentBar 3 is totalBar 2 == the end of a
    // 2-bar clip that starts at bar 0: relX 1 -> y 1 for the EQ, y 0 for delay.
    engine.currentBar = 3;
    engine.currentStep = 0;
    engine.triggerCurrentStep(2);

    const midFreq = readAudioParam('equalizer', 'midFreq', 'fx-eq', 1)!;
    const delayTime = readAudioParam('delay', 'time', 'fx-delay', 3)!;
    assert.ok(Math.abs(midFreq.value - 20000) < 1e-9, `EQ mid frequency at full scale, got ${midFreq.value}`);
    assert.equal(delayTime.value, 0, 'the delay lane runs in the opposite direction');
  });

  it('re-bases the lane on a seek so no pre-seek value stays latched', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);
    engine.activeClips = [
      makeAutomationClip('auto-comp', { type: 'fx_param', targetId: '2/fx-comp', paramName: 'ratio' },
        [{ x: 0, y: 0 }, { x: 1, y: 1 }], 0, 4),
    ];
    const param = readAudioParam('compressor', 'ratio', 'fx-comp', 2)!;

    engine.currentBar = 1;
    engine.currentStep = 0;
    engine.triggerCurrentStep(0);
    assert.equal(param.value, 1, 'ratio at the lane start is the contract minimum');

    // Seek to bar 3 of a 4-bar clip (relX 0.5) -> ratio 10.5.
    const secondsPerBar = 16 * (60 / engine.bpm) / 4;
    engine.rebaseAutomationAtPosition(2 * secondsPerBar);
    assert.ok(Math.abs(param.value - 10.5) < 1e-9, `seek must apply the lane value at the new position, got ${param.value}`);
  });

  it('muted and lane-muted automation clips do not drive the parameter', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);
    const clip = makeAutomationClip('auto-muted', { type: 'fx_param', targetId: '2/fx-comp', paramName: 'threshold' },
      [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 4);
    clip.mute = true;
    engine.activeClips = [clip];
    const param = readAudioParam('compressor', 'threshold', 'fx-comp', 2)!;
    const writes = param.writes.length;

    engine.currentBar = 2;
    engine.currentStep = 0;
    engine.triggerCurrentStep(1);
    assert.equal(param.writes.length, writes, 'a muted clip must not write the AudioParam');
    assert.equal(param.value, -18, 'the value stays at the chain-build value');
  });
});

describe('Phase 81: lifecycle — stop, restart, clip deletion and project replacement', () => {
  it('restores the project baseline when the automation clip is deleted mid-take', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);
    const clip = makeAutomationClip('auto-comp', { type: 'fx_param', targetId: '2/fx-comp', paramName: 'threshold' },
      [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 4);
    engine.activeClips = [clip];

    engine.currentBar = 2;
    engine.currentStep = 0;
    engine.triggerCurrentStep(1);
    const param = readAudioParam('compressor', 'threshold', 'fx-comp', 2)!;
    assert.equal(param.value, 0, 'full-scale automation drives the threshold to 0 dB');

    // Deleting the clip publishes a new clip list; the target must be reset.
    engine.synchronizePlaybackState({ clips: [] });
    assert.equal(param.value, -18, 'the take falls back to the project value, not the latched one');
    const slot = engine.activeMixerTracks.find((t: MixerTrack) => t.id === 2)!.fxSlots[0]!;
    assert.equal(slot.params.threshold, -18);
  });

  it('restores the contract default when the project never stored the parameter', () => {
    const tracks = [makeTrack(2, [makeSlot('fx-comp', 'compressor', {})])];
    startTake(tracks);
    const clip = makeAutomationClip('auto-knee', { type: 'fx_param', targetId: '2/fx-comp', paramName: 'knee' },
      [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 4);
    engine.activeClips = [clip];
    engine.currentBar = 2;
    engine.currentStep = 0;
    engine.triggerCurrentStep(1);

    const knee = readAudioParam('compressor', 'knee', 'fx-comp', 2)!;
    assert.equal(knee.value, 40);
    engine.synchronizePlaybackState({ clips: [] });
    assert.equal(knee.value, 24, 'the reset lands on the contract default');
  });

  it('restores the slot mix when an fx_param mix lane is deleted', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);
    engine.activeClips = [
      makeAutomationClip('auto-mix', { type: 'fx_param', targetId: '5/fx-verb', paramName: 'mix' },
        [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 4),
    ];
    engine.currentBar = 2;
    engine.currentStep = 0;
    engine.triggerCurrentStep(1);
    const wet = readAudioParam('reverb', 'mix', 'fx-verb', 5)!;
    assert.equal(wet.value, 1);

    engine.synchronizePlaybackState({ clips: [] });
    assert.equal(wet.value, 0.5, 'the project mix is restored');
    assert.equal(engine.activeMixerTracks.find((t: MixerTrack) => t.id === 5)!.fxSlots[0]!.mix, 0.5);
  });

  it('a restarted take reads the project values, so no automated value survives stop + play', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);
    applyFxParam(2, 'fx-comp', 'threshold', 1, engine.activeMixerTracks, engine.activeChannels);
    assert.equal(readAudioParam('compressor', 'threshold', 'fx-comp', 2)!.value, 0);

    // A new take clones the project document, exactly like `play()` does.
    startTake(fixture.tracks, fixture.channels);
    const rebuilt = readAudioParam('compressor', 'threshold', 'fx-comp', 2)!;
    assert.equal(rebuilt.value, -18, 'the restarted chain is built from the project, not the latched take value');
  });

  it('a project replacement re-points the lane at the new document and never at the old slot', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);
    engine.activeClips = [
      makeAutomationClip('auto-comp', { type: 'fx_param', targetId: '2/fx-comp', paramName: 'threshold' },
        [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }], 0, 4),
    ];

    // The replacement project has no track 2 at all.
    const replacement = [makeTrack(7, [makeSlot('fx-comp', 'compressor', { threshold: -40 })])];
    engine.synchronizePlaybackState({ mixerTracks: replacement });

    engine.currentBar = 2;
    engine.currentStep = 0;
    engine.triggerCurrentStep(1);

    const replacementSlot = engine.activeMixerTracks.find((t: MixerTrack) => t.id === 7)?.fxSlots[0];
    assert.ok(replacementSlot, 'the replacement track is the running take');
    assert.equal(replacementSlot!.params.threshold, -40, 'the stale lane must not write the new document');
  });

  it('an in-flight project edit to the same slot reaches the live AudioParam without a rebuild', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);
    const param = readAudioParam('compressor', 'threshold', 'fx-comp', 2)!;

    const edited = structuredClone(fixture.tracks) as MixerTrack[];
    edited.find(t => t.id === 2)!.fxSlots[0]!.params.threshold = -55;
    engine.synchronizePlaybackState({ mixerTracks: edited });

    assert.equal(param.value, -55, 'the Phase 80 live bridge still applies manual edits mid-take');
  });

  it('deleting the FX slot the lane targets makes the lane a safe no-op', () => {
    const fixture = buildFixture();
    startTake(fixture.tracks, fixture.channels);
    engine.activeClips = [
      makeAutomationClip('auto-comp', { type: 'fx_param', targetId: '2/fx-comp', paramName: 'threshold' },
        [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 4),
    ];

    const withoutSlot = structuredClone(fixture.tracks) as MixerTrack[];
    withoutSlot.find(t => t.id === 2)!.fxSlots = [];
    engine.activeMixerTracks = withoutSlot;
    engine.playbackProjectMixerTracks = structuredClone(withoutSlot);

    assert.doesNotThrow(() => {
      engine.currentBar = 2;
      engine.currentStep = 0;
      engine.triggerCurrentStep(1);
    });
    assert.deepEqual(engine.activeMixerTracks.find((t: MixerTrack) => t.id === 2)!.fxSlots, []);
  });
});

describe('Phase 81: live and offline paths share the same parameter semantics', () => {
  /**
   * The strongest invariant this environment can prove: the *evaluation* is
   * identical. Both paths run the same `triggerCurrentStep` ->
   * `applyAutomationValue` -> `fxParameterControl` -> live registry chain, so
   * for the same clip and the same bar/step they produce the same contract
   * value on the same slot. Byte-identical audio output additionally depends on
   * the offline context's own AudioParam scheduling and is not asserted here.
   */
  const collectEvaluation = (mode: 'live' | 'offline') => {
    const applied: Array<{ targetId: string; paramName: string; value: number }> = [];
    const original = engine.applyAutomationValue;
    engine.applyAutomationValue = (target: any, value: number, ...rest: unknown[]) => {
      if (target?.type === 'fx_param') {
        applied.push({ targetId: String(target.targetId), paramName: String(target.paramName), value });
      }
      return (original as any).call(engine, target, value, ...rest);
    };
    return {
      applied,
      restore: () => {
        engine.applyAutomationValue = original;
      },
      mode,
    };
  };

  it('the offline renderer evaluates an fx_param lane to the same values as live playback', async () => {
    const fixture = buildFixture();
    const clip = makeAutomationClip('auto-comp', { type: 'fx_param', targetId: '2/fx-comp', paramName: 'threshold' },
      [{ x: 0, y: 0 }, { x: 1, y: 1 }], 0, 2);

    // --- live evaluation ---
    startTake(fixture.tracks, fixture.channels);
    engine.activeClips = [structuredClone(clip)];
    const live = collectEvaluation('live');
    for (let step = 0; step < 32; step += 1) {
      engine.currentBar = Math.floor(step / 16) + 1;
      engine.currentStep = step % 16;
      engine.triggerCurrentStep(step * 0.125);
    }
    live.restore();

    // --- offline evaluation through the production renderer ---
    engine.isPlaying = false;
    const offline = collectEvaluation('offline');
    await audioEngine.renderTimelineOffline(
      structuredClone(fixture.channels),
      [structuredClone(clip)],
      structuredClone(fixture.tracks),
      120,
      2,
      undefined,
      true,
      'song',
      undefined,
      undefined,
    );
    offline.restore();

    assert.ok(live.applied.length > 0, 'the live scheduler evaluated the lane');
    assert.ok(offline.applied.length > 0, 'the offline scheduler evaluated the lane');
    assert.deepEqual(
      offline.applied.map(entry => entry.value),
      live.applied.map(entry => entry.value),
      'the same clip at the same steps must produce the same normalized values in both paths',
    );
    for (const entry of offline.applied) {
      assert.equal(entry.targetId, '2/fx-comp');
      assert.equal(entry.paramName, 'threshold');
    }
  });

  it('the offline renderer writes the same contract value into the offline chain as the live take', async () => {
    const fixture = buildFixture();
    const clip = makeAutomationClip('auto-delay', { type: 'fx_param', targetId: '3/fx-delay', paramName: 'time' },
      [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 1);

    startTake(fixture.tracks, fixture.channels);
    engine.activeClips = [structuredClone(clip)];
    engine.currentBar = 1;
    engine.currentStep = 0;
    engine.triggerCurrentStep(0);
    const liveDelayTime = readAudioParam('delay', 'time', 'fx-delay', 3)!.value;
    assert.ok(Math.abs(liveDelayTime - 10) < 1e-9, 'live full-scale delay time is 10 s');

    const liveEffect = getLiveFxSlotEffect(engine, 3, 'fx-delay');
    assert.ok(liveEffect, 'the live chain must exist before the render');

    // The offline chain is captured while the render is still in flight: since
    // the Phase 81 export-isolation correction an offline render registers in
    // its own slot index, so after the render the registry names the live chain
    // again. Reading the offline chain post-render would silently read the live
    // one and this test would stop testing what it claims.
    let offlineEffect: unknown;
    engine.isPlaying = false;
    await audioEngine.renderTimelineOffline(
      structuredClone(fixture.channels),
      [structuredClone(clip)],
      structuredClone(fixture.tracks),
      120,
      1,
      undefined,
      true,
      'song',
      (progress) => {
        if (progress >= 70) offlineEffect = getLiveFxSlotEffect(engine, 3, 'fx-delay');
      },
      undefined,
    );

    assert.ok(offlineEffect, 'the offline render must build the delay chain');
    assert.notEqual(offlineEffect, liveEffect, 'the offline chain is its own instance');
    const offlineDelayTime = ((offlineEffect as any).effect.delay.delayTime as { value: number }).value;
    assert.ok(
      Math.abs(offlineDelayTime - liveDelayTime) < 1e-9,
      `offline (${offlineDelayTime}) and live (${liveDelayTime}) must agree on the contract value`,
    );

    // And the live chain is still the one the registry hands out afterwards,
    // with the value the live take set — the render wrote nothing into it.
    assert.equal(getLiveFxSlotEffect(engine, 3, 'fx-delay'), liveEffect);
    assert.ok(Math.abs(readAudioParam('delay', 'time', 'fx-delay', 3)!.value - liveDelayTime) < 1e-9);
  });
});
