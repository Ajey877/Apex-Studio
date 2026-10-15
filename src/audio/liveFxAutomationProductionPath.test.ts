/**
 * Audio Integrity Fix 5 — live FX automation through the *production* path.
 *
 * PR #230 unified the FX-chain factory and gave `AudioEngine` its own native
 * slot-effect registry (`__fxSlotEffectMaps`, populated by the engine's
 * `rebuildTrackFxChain`), which is why `src/main.tsx` no longer installs the
 * `installLiveFxChainHardening` monkey patch at boot.
 *
 * The live-apply paths that carry an automated value to the *running* chain
 * (`applyAutomationValue`, `resetActiveAutomationTarget` and the playback
 * fast path in `synchronizePlaybackState`) still read the legacy
 * `__liveFxChainRegistry`, which production never installs any more. Every
 * other FX suite installs the patch itself, so the gap was invisible: a
 * passing test suite and a silent insert in the shipped app.
 *
 * This suite therefore deliberately does NOT install the patch. It drives the
 * shipped `audioEngine` singleton with the exact boot configuration of the
 * app, builds the chain with the production `rebuildTrackFxChain`, and reads
 * the *real* AudioParam objects off the *real* AudioEffect instances.
 *
 * Scope note (Fix 5 verification): the four families named by the audit —
 * chorus, distortion, bitcrusher, tape saturation — bake their own parameter
 * into a curve/LFO at chain construction. They have no contract entry, no
 * automation target and no live setter, and this suite pins that their
 * persisted params are still real DSP inputs at build time. Their one
 * automatable parameter — the slot wet/dry mix — is covered here like every
 * other family's.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Channel, FxSlot, FxType, MixerTrack, PlaylistClip } from '../types/daw';
import { audioEngine } from './audioEngine';
import {
  FX_PARAMETER_FAMILIES,
  isFxParamLiveUpdatable,
  resolveFxAudioParam,
  resolveFxParameterSpec,
} from './fxParameterContract';
import { formatFxSlotTargetId, listFxParameterOptions, resolveFxParameterUpdate } from './fxParameterControl';
import { isFxParamLiveUpdatableByName } from './fxLiveSync';
import type { AudioEffect } from './effects/AudioEffect';

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
  linearRampToValueAtTime(value: number, time = 0): void { this.setValueAtTime(value, time); }
  setTargetAtTime(value: number, time = 0): void { this.setValueAtTime(value, time); }
  exponentialRampToValueAtTime(value: number, time = 0): void { this.setValueAtTime(value, time); }
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

/** Every production FX family, so the mix path is covered for all nine. */
const ALL_FAMILIES: readonly FxType[] = [
  'equalizer', 'reverb', 'delay', 'distortion', 'compressor', 'chorus', 'bitcrusher', 'limiter', 'tape_saturation',
];

/** The four families named by the artifact audit. */
const AUDITED_FAMILIES: readonly FxType[] = ['chorus', 'distortion', 'bitcrusher', 'tape_saturation'];

const FAMILY_PARAMS: Record<string, Record<string, number>> = {
  equalizer: { lowFreq: 120, lowGain: 0, lowQ: 0.9, midFreq: 1200, midGain: 0, midQ: 1.2, highFreq: 6500, highGain: 0, highQ: 0.8 },
  compressor: { threshold: -18, knee: 24, ratio: 4, attack: 0.005, release: 0.15 },
  delay: { time: 0.35, feedback: 0.45 },
  limiter: { ceiling: -0.3, release: 0.08, drive: 0 },
};

const makeSlot = (id: string, type: FxType, params: Record<string, number> = {}, mix = 0.8, enabled = true): FxSlot => ({
  id,
  type,
  name: `${type} ${id}`,
  enabled,
  mix,
  params,
});

const makeTrack = (id: number, fxSlots: FxSlot[]): MixerTrack => ({
  id,
  name: `Insert ${id}`,
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

/** One insert per contract family that owns AudioParam-updatable parameters. */
const CONTRACT_FIXTURE: Array<{ fxType: FxType; trackId: number; slotId: string }> = [
  { fxType: 'equalizer', trackId: 1, slotId: 'fx-eq' },
  { fxType: 'compressor', trackId: 2, slotId: 'fx-comp' },
  { fxType: 'delay', trackId: 3, slotId: 'fx-delay' },
  { fxType: 'limiter', trackId: 4, slotId: 'fx-lim' },
];

const contractFixtureTracks = (): MixerTrack[] =>
  CONTRACT_FIXTURE.map(entry => makeTrack(entry.trackId, [makeSlot(entry.slotId, entry.fxType, { ...FAMILY_PARAMS[entry.fxType] })]));

// --- Engine harness -----------------------------------------------------------

const SAVED_KEYS = [
  'ctx', 'liveCtx', 'masterGain', 'masterAnalyser', 'grossBeatNode', 'mixerChannels', 'channelPanners',
  'activeChannels', 'activeClips', 'activeMixerTracks', 'playbackProjectChannels',
  'playbackProjectMixerTracks', 'isPlaying', 'isOfflineRendering', 'currentBar', 'currentStep',
  'activePlayMode', 'activePatternId', 'activePatternLengthSteps', 'bpm', 'swing', 'metronome',
  'playlistLaneMutes', 'mixerRoutingAdapter', 'mixerRoutingChannelMap', 'impulseResponses',
  'activeVoices', 'activeVoiceChannelVolumes', 'activeDrumPadVoices', 'activeClipSources',
  'activeClipSourceLanes', 'activeClipSourceChannels', 'activeClipChannelVolumes',
  'offlineRenderLeaseHeld', 'offlineRenderOperationDepth', 'transport', 'sampleBuffers',
  'projectOwnedSampleBufferIds', 'sessionSampleBufferIds', 'masteringProcessor',
  '__fxSlotEffectMaps',
];

let savedInternals: EngineInternals = {};
let savedOfflineCtor: unknown;

/**
 * Installs a live take built by the production chain (`rebuildTrackFxChain`).
 * No hardening patch is installed anywhere in this file — that is the point.
 */
const startLiveTake = (tracks: MixerTrack[], channels: Channel[] = []): void => {
  const liveCtx = new FakeContext();
  engine.ctx = liveCtx;
  engine.liveCtx = liveCtx;
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
  engine.sampleBuffers = new Map();
  engine.offlineRenderLeaseHeld = false;
  engine.offlineRenderOperationDepth = 0;
  engine.isOfflineRendering = false;
  engine.isPlaying = true;
  engine.activePlayMode = 'song';
  engine.activePatternId = undefined;
  engine.activePatternLengthSteps = undefined;
  engine.currentBar = 1;
  engine.currentStep = 0;
  engine.bpm = 120;
  engine.swing = 0;
  engine.metronome = false;
  engine.transport = null;
  engine.activeChannels = structuredClone(channels);
  engine.playbackProjectChannels = structuredClone(channels);
  engine.activeClips = [];
  engine.activeMixerTracks = structuredClone(tracks);
  engine.playbackProjectMixerTracks = structuredClone(tracks);
  for (const track of engine.activeMixerTracks as MixerTrack[]) {
    engine.rebuildTrackFxChain(track);
  }
};

/** The effect the *production* registry names for a live slot. */
const liveSlotEffect = (trackId: number, slotId: string): any | undefined =>
  (engine.__fxSlotEffectMaps as Map<number, Map<string, AudioEffect>> | undefined)?.get(trackId)?.get(slotId);

const activeSlot = (trackId: number, slotId: string): FxSlot | undefined =>
  (engine.activeMixerTracks as MixerTrack[]).find(track => track.id === trackId)?.fxSlots.find(slot => slot.id === slotId);

const applyFxMix = (trackId: number, slotId: string, normalized: number): void => {
  engine.applyAutomationValue(
    { type: 'fx_mix', targetId: trackId, paramName: slotId },
    normalized,
    engine.activeChannels,
    engine.activeMixerTracks,
    engine.ctx.currentTime,
  );
};

const applyFxParam = (trackId: number, slotId: string, paramId: string, normalized: number): void => {
  engine.applyAutomationValue(
    { type: 'fx_param', targetId: formatFxSlotTargetId(trackId, slotId), paramName: paramId },
    normalized,
    engine.activeChannels,
    engine.activeMixerTracks,
    engine.ctx.currentTime,
  );
};

/** The real AudioParam a contract parameter lands on for each implemented family. */
const readAudioParam = (effect: any, fxType: FxType, paramId: string): FakeParam | null => {
  if (!effect) return null;
  if (paramId === 'mix') return effect.wet.gain as FakeParam;
  const inner = effect.effect;
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
      return paramId === 'time' ? (inner.delay.delayTime as FakeParam) : (inner.feedback.gain as FakeParam);
    case 'limiter':
      if (paramId === 'ceiling') return inner.limiter.threshold as FakeParam;
      if (paramId === 'release') return inner.limiter.release as FakeParam;
      return inner.drive.gain as FakeParam;
    default:
      return null;
  }
};

/** `drive` is stored as a linear gain (10^(dB/20)); every other contract param is stored as-is. */
const expectedAudioParamValue = (fxType: FxType, paramId: string, contractValue: number): number =>
  fxType === 'limiter' && paramId === 'drive' ? Math.pow(10, contractValue / 20) : contractValue;

beforeEach(() => {
  savedInternals = {};
  for (const key of SAVED_KEYS) savedInternals[key] = engine[key];
  savedOfflineCtor = (globalThis as any).OfflineAudioContext;
  (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
  engine.__fxSlotEffectMaps = new Map();
});

afterEach(() => {
  (globalThis as any).OfflineAudioContext = savedOfflineCtor;
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
});

// --- The defect ---------------------------------------------------------------

describe('Fix 5 A: automated FX values reach the running chain in the production boot configuration', () => {
  it('drives the wet/dry mix of every family, including chorus, distortion, bitcrusher and tape saturation', () => {
    let checked = 0;
    ALL_FAMILIES.forEach((fxType, index) => {
      const trackId = index + 1;
      const slot = makeSlot(`fx-${fxType}`, fxType, { ...(FAMILY_PARAMS[fxType] ?? {}) }, 0.8);
      startLiveTake([makeTrack(trackId, [slot])]);

      const effect = liveSlotEffect(trackId, slot.id);
      assert.ok(effect, `${fxType}: the production chain must register a live slot effect`);
      assert.equal((effect as any).wet.gain.value, 0.8, `${fxType}: the chain must start at the slot's declared mix`);

      applyFxMix(trackId, slot.id, 0.25);

      assert.equal(activeSlot(trackId, slot.id)!.mix, 0.25, `${fxType}: the take's slot.mix must follow the automation`);
      assert.equal(
        (effect as any).wet.gain.value,
        0.25,
        `${fxType}: the automated mix must reach the running WetDry wet gain (got ${(effect as any).wet.gain.value})`,
      );
      assert.equal((effect as any).dry.gain.value, 0.75, `${fxType}: the dry gain must mirror the automated mix`);
      checked += 1;
    });
    assert.equal(checked, ALL_FAMILIES.length);
  });

  it('drives every contract parameter of the implemented families through the running chain', () => {
    startLiveTake(contractFixtureTracks(), [makeChannel('ch-1', 1)]);
    let checked = 0;

    for (const { fxType, trackId, slotId } of CONTRACT_FIXTURE) {
      const family = FX_PARAMETER_FAMILIES[fxType]!;
      for (const spec of family.parameters) {
        const effect = liveSlotEffect(trackId, slotId);
        assert.ok(effect, `${fxType}: the production chain must register a live slot effect`);
        const param = readAudioParam(effect, fxType, spec.id);
        assert.ok(param, `${fxType}.${spec.id} must have a live AudioParam`);

        applyFxParam(trackId, slotId, spec.id, 0.75);

        const expectedContract = spec.min + 0.75 * (spec.max - spec.min);
        assert.ok(
          Math.abs(Number(activeSlot(trackId, slotId)!.params[spec.id]) - expectedContract) < 1e-9,
          `${fxType}.${spec.id} must be written into the take's slot.params`,
        );
        assert.ok(
          Math.abs(param!.value - expectedAudioParamValue(fxType, spec.id, expectedContract)) < 1e-9,
          `${fxType}.${spec.id} must reach the running AudioParam (got ${param!.value}, want ${expectedContract})`,
        );
        checked += 1;
      }
    }
    assert.ok(checked >= 13, `every contract parameter must be exercised (checked ${checked})`);
  });

  it('the automated value is written through the AudioParam, never through a chain rebuild', () => {
    const tracks = contractFixtureTracks();
    startLiveTake(tracks, [makeChannel('ch-1', 1)]);
    const effectBefore = liveSlotEffect(2, 'fx-comp');
    const threshold = readAudioParam(effectBefore, 'compressor', 'threshold')!;
    const writesBefore = threshold.writes.length;

    applyFxParam(2, 'fx-comp', 'threshold', 0.1);

    assert.equal(liveSlotEffect(2, 'fx-comp'), effectBefore, 'the running chain must not be rebuilt');
    assert.ok(threshold.writes.length > writesBefore, 'the value must be scheduled on the AudioParam');
  });
});

// --- The audited four families ------------------------------------------------

describe('Fix 5 B: chorus, distortion, bitcrusher and tape saturation', () => {
  it('expose no contract parameter beyond the wet/dry mix — their curve/LFO params are unsupported, not faked', () => {
    for (const fxType of AUDITED_FAMILIES) {
      assert.equal(FX_PARAMETER_FAMILIES[fxType], null, `${fxType} must have no contract entry`);

      for (const paramId of ['drive', 'bits', 'rate', 'depth', 'delay', 'warmth', 'flutter']) {
        assert.equal(resolveFxAudioParam(fxType, paramId), null, `${fxType}.${paramId} must resolve to no AudioParam`);
        assert.equal(resolveFxParameterSpec(fxType, paramId), null, `${fxType}.${paramId} must not be in the contract`);
        assert.equal(isFxParamLiveUpdatable(fxType, paramId), false, `${fxType}.${paramId} must not claim live update`);
        assert.equal(isFxParamLiveUpdatableByName(fxType, paramId), false, `${fxType}.${paramId} must not claim a live setter`);
      }

      const options = listFxParameterOptions([makeTrack(1, [makeSlot(`fx-${fxType}`, fxType)])], { trackId: 1, slotId: `fx-${fxType}` });
      assert.deepEqual(options.map(option => option.paramId), ['mix'], `${fxType} must offer the mix and nothing else`);

      const resolution = resolveFxParameterUpdate(
        [makeTrack(1, [makeSlot(`fx-${fxType}`, fxType)])],
        formatFxSlotTargetId(1, `fx-${fxType}`),
        'drive',
        0.5,
      );
      assert.equal(resolution.status, 'rejected', `${fxType}: an out-of-contract param id must be rejected`);
    }
  });

  it('consumes their persisted params for real at chain construction (and only then)', () => {
    const build = (params: Record<string, number>): any => {
      const slot = makeSlot('fx-audit', 'chorus', params);
      startLiveTake([makeTrack(1, [slot])]);
      return liveSlotEffect(1, 'fx-audit');
    };

    // chorus: rate -> LFO frequency, depth -> modulation gain.
    const slow = build({ rate: 1.2, depth: 0.003, delay: 0.02 });
    const fast = build({ rate: 8, depth: 0.01, delay: 0.02 });
    assert.equal(slow.effect.lfo.frequency.value, 1.2, 'chorus rate must reach the LFO at construction');
    assert.equal(fast.effect.lfo.frequency.value, 8, 'a persisted chorus rate must reach the LFO on the next build');
    assert.equal(slow.effect.depth.gain.value, 0.003, 'chorus depth must reach the modulation gain');
    assert.equal(fast.effect.depth.gain.value, 0.01, 'a persisted chorus depth must reach the modulation gain');

    // distortion / bitcrusher: `drive` / `bits` shape the waveshaper curve.
    const curveOf = (fxType: FxType, params: Record<string, number>): number[] => {
      const slot = makeSlot('fx-audit', fxType, params);
      startLiveTake([makeTrack(1, [slot])]);
      const curve = (liveSlotEffect(1, 'fx-audit') as any).effect.nodes[0].curve as Float32Array;
      return Array.from(curve);
    };
    assert.notDeepEqual(
      curveOf('distortion', { drive: 10 }),
      curveOf('distortion', { drive: 80 }),
      'distortion drive must shape the waveshaper curve',
    );
    assert.notDeepEqual(
      curveOf('bitcrusher', { bits: 4 }),
      curveOf('bitcrusher', { bits: 12 }),
      'bitcrusher bits must shape the waveshaper curve',
    );

    // tape saturation: warmth -> low-pass cutoff, flutter -> modulated delay depth.
    const tape = (params: Record<string, number>): any => {
      const slot = makeSlot('fx-audit', 'tape_saturation', params);
      startLiveTake([makeTrack(1, [slot])]);
      return liveSlotEffect(1, 'fx-audit');
    };
    const cold = tape({ drive: 20, warmth: 0.2, flutter: 0.0005 });
    const warm = tape({ drive: 20, warmth: 0.9, flutter: 0.003 });
    assert.equal(cold.effect.nodes[0].frequency.value, 16000 - 0.2 * 4000, 'tape warmth must set the low-pass cutoff');
    assert.equal(warm.effect.nodes[0].frequency.value, 16000 - 0.9 * 4000, 'a persisted warmth must set the cutoff on the next build');
    assert.equal(cold.effect.nodes[3].gain.value, 0.0005, 'tape flutter must set the modulation depth');
    assert.equal(warm.effect.nodes[3].gain.value, 0.003, 'a persisted flutter must set the modulation depth');
  });

  it('leaves those curve/LFO params untouched when an automation lane names one', () => {
    const slot = makeSlot('fx-audit', 'chorus', { rate: 1.2, depth: 0.003, delay: 0.02 });
    startLiveTake([makeTrack(1, [slot])]);
    const effect = liveSlotEffect(1, 'fx-audit');
    const rateBefore = effect.effect.lfo.frequency.writes.length;

    assert.doesNotThrow(() => applyFxParam(1, 'fx-audit', 'rate', 1));
    assert.equal(effect.effect.lfo.frequency.value, 1.2, 'an unsupported param id must not move the LFO');
    assert.equal(effect.effect.lfo.frequency.writes.length, rateBefore, 'an unsupported param id must not touch the AudioParam');
    assert.equal((activeSlot(1, 'fx-audit')!.params as Record<string, number>).rate, 1.2, 'an unsupported param id must not be written into the take');
  });

  it('keeps a disabled slot off the chain and makes automation for it a safe no-op', () => {
    const slot = makeSlot('fx-audit', 'tape_saturation', { drive: 35, warmth: 0.8, flutter: 0.001 }, 0.8, false);
    startLiveTake([makeTrack(1, [slot])]);
    assert.equal(liveSlotEffect(1, 'fx-audit'), undefined, 'a bypassed slot must not be on the running chain');

    assert.doesNotThrow(() => applyFxMix(1, 'fx-audit', 0.5));
    assert.doesNotThrow(() => applyFxParam(1, 'fx-audit', 'drive', 0.5));

    engine.activeMixerTracks[0].fxSlots[0].enabled = true;
    engine.rebuildTrackFxChain(engine.activeMixerTracks[0]);
    assert.ok(liveSlotEffect(1, 'fx-audit'), 're-enabling the slot must put it back on the chain');
  });
});

// --- The post-export hand-back -------------------------------------------------

describe('Fix 5 C: an offline export must hand the live chain back to the engine', () => {
  it('an automation lane reaches the offline chain while the render is running', async () => {
    const tracks = contractFixtureTracks();
    const channels = [makeChannel('ch-1', 1)];
    startLiveTake(tracks, channels);

    const clip = {
      id: 'auto-gain',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 1,
      type: 'automation',
      color: '#00e5ff',
      name: 'Auto Gain',
      automationTarget: {
        type: 'fx_param',
        targetId: formatFxSlotTargetId(1, 'fx-eq'),
        paramName: 'lowGain',
      },
      automationPoints: [{ x: 0, y: 1, tension: 0 }, { x: 1, y: 1, tension: 0 }],
    } as unknown as PlaylistClip;

    let offlineEffect: any;
    await audioEngine.renderTimelineOffline(
      structuredClone(channels),
      [clip],
      structuredClone(tracks),
      120,
      1,
      undefined,
      true,
      'song',
      (progress) => {
        if (progress >= 70 && !offlineEffect) offlineEffect = liveSlotEffect(1, 'fx-eq');
      },
    );

    assert.ok(offlineEffect, 'the render must have built the insert chain');
    const offlineGain = readAudioParam(offlineEffect, 'equalizer', 'lowGain')!;
    const automated = offlineGain.writes.some(write => Math.abs(write.value - 18) < 1e-9);
    assert.ok(automated, 'the lane value (max gain 18 dB) must reach the rendered AudioParam');
  });

  it('names the live chain again once the render is done, so live automation keeps sounding', async () => {
    const tracks = contractFixtureTracks();
    const channels = [makeChannel('ch-1', 1)];
    startLiveTake(tracks, channels);

    const liveEffectBefore = liveSlotEffect(1, 'fx-eq');
    assert.ok(liveEffectBefore, 'the live chain must exist before the export');
    const liveGain = readAudioParam(liveEffectBefore, 'equalizer', 'lowGain')!;
    const writesBefore = liveGain.writes.length;

    await audioEngine.renderTimelineOffline(
      structuredClone(channels),
      [] as PlaylistClip[],
      structuredClone(tracks),
      120,
      1,
      undefined,
      true,
    );

    assert.equal(
      liveSlotEffect(1, 'fx-eq'),
      liveEffectBefore,
      'after the export the registry must name the live chain again, not the finished render',
    );

    applyFxParam(1, 'fx-eq', 'lowGain', 0.75);
    assert.ok(liveGain.writes.length > writesBefore, 'live automation after an export must still reach the live AudioParam');
  });
});
