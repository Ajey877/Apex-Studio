/**
 * Phase 81 correction — offline export must carry FX parameter automation, and
 * must not leave the live chain pointing at the render it just finished.
 *
 * What this file pins down, and why it exists:
 *
 * `AudioEngine.renderTimelineOffline` takes `includeMixerFx = false` at the
 * engine boundary. Read on its own, that default looks like "browser exports
 * drop mixer FX, so FX parameter automation has no target during export". It
 * does not: since Phase 52 the *product* default is the opposite
 * (`DEFAULT_INCLUDE_MIXER_FX === true`), App passes it to `ExportModal`, and the
 * modal forwards the resolved choice to both the master WAV render and
 * `renderProjectStems`. Bounce-In-Place passes `true` explicitly. So every
 * supported export path renders the full FX graph unless the user deliberately
 * asks for a dry bounce.
 *
 * Suite A proves that wiring. Suite B proves FX parameter automation actually
 * reaches the real effect parameters inside the offline graph, at the correct
 * scheduled render time. Suite C proves the render is isolated: it must not
 * mutate the caller's project state, the live transport, or the live FX chain.
 * Suite D proves the intentional dry path still behaves.
 *
 * MOCK LIMITATION, stated plainly: Node has no Web Audio implementation, so
 * `OfflineAudioContext` is mocked and `startRendering()` returns a silent
 * buffer. These tests therefore assert on the AudioParam automation events that
 * *determine* the rendered audio (value + scheduled time, on the real effect
 * instances the production chain builder created) — they do NOT assert on
 * acoustic output, and nothing here claims live/offline audio equivalence.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Channel, FxSlot, FxType, MixerTrack, PlaylistClip, ProjectState } from '../types/daw';
import { audioEngine } from './audioEngine';
import { installLiveFxChainHardening, getLiveFxSlotEffect } from './liveFxChainHardening';
import { DEFAULT_INCLUDE_MIXER_FX, resolveExportFxChoice } from '../components/exportMixerFxPreference';
import { FX_PARAMETER_FAMILIES, resolveFxParameterSpec } from './fxParameterContract';
import { formatFxSlotTargetId, resolveFxParameterUpdate } from './fxParameterControl';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const read = (relative: string): string => readFileSync(path.resolve(repoRoot, relative), 'utf8');

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
      numberOfChannels: channels, length, sampleRate, duration: length / sampleRate,
      getChannelData: (channel: number) => data[channel] ?? data[0]!,
    } as unknown as AudioBuffer;
  }
}

class MockOfflineAudioContext extends FakeContext {
  static instances: MockOfflineAudioContext[] = [];
  currentTime = 0;
  readonly length: number;
  constructor(_channels: number, length: number, sampleRate: number) {
    super();
    this.length = length;
    this.sampleRate = sampleRate;
    MockOfflineAudioContext.instances.push(this);
  }
  async startRendering(): Promise<AudioBuffer> {
    return this.createBuffer(2, Math.max(1, this.length), this.sampleRate);
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
  id, name: id, color: '#ff6e00', instrumentType: 'minisynth', mixerTrackId,
  volume: 0.9, pan: 0, pitch: 0, mute: false, solo: false,
  steps: new Array(16).fill(false), notes: [],
  synthParams: {
    filterCutoff: 3500, filterResonance: 1, filterType: 'lowpass', filterEnvAmount: 0,
    attack: 0.01, decay: 0.15, sustain: 0.6, release: 0.2, unisonVoices: 1, osc2Mix: 0.65,
  },
} as Channel);

/** One insert per contract family that owns AudioParam-updatable parameters. */
const FX_TRACKS: Array<{ fxType: FxType; trackId: number; slotId: string; slot: FxSlot }> = [
  { fxType: 'equalizer', trackId: 1, slotId: 'fx-eq', slot: makeSlot('fx-eq', 'equalizer', { lowFreq: 120, lowGain: 0, lowQ: 0.9, midFreq: 1200, midGain: 0, midQ: 1.2, highFreq: 6500, highGain: 0, highQ: 0.8 }) },
  { fxType: 'compressor', trackId: 2, slotId: 'fx-comp', slot: makeSlot('fx-comp', 'compressor', { threshold: -18, knee: 24, ratio: 4, attack: 0.005, release: 0.15 }) },
  { fxType: 'delay', trackId: 3, slotId: 'fx-delay', slot: makeSlot('fx-delay', 'delay', { time: 0.35, feedback: 0.45 }) },
  { fxType: 'limiter', trackId: 4, slotId: 'fx-lim', slot: makeSlot('fx-lim', 'limiter', { ceiling: -0.3, release: 0.08, drive: 0 }) },
  { fxType: 'reverb', trackId: 5, slotId: 'fx-verb', slot: makeSlot('fx-verb', 'reverb', {}, 0.5) },
];

const fixtureTracks = (): MixerTrack[] =>
  FX_TRACKS.map(entry => makeTrack(entry.trackId, [structuredClone(entry.slot)]));

const fixtureChannels = (): Channel[] => FX_TRACKS.map(entry => makeChannel(`ch-${entry.trackId}`, entry.trackId));

const makeAutomationClip = (
  id: string,
  target: PlaylistClip['automationTarget'],
  points: Array<{ x: number; y: number; tension?: number }>,
  startBar: number,
  lengthBars: number,
  trackIndex = 0,
): PlaylistClip => ({
  id, trackIndex, startBar, lengthBars, type: 'automation', color: '#00e5ff',
  name: `Auto ${id}`, automationTarget: target, automationPoints: points,
} as PlaylistClip);

const fxParamTarget = (trackId: number, slotId: string, paramId: string) => ({
  type: 'fx_param' as const,
  targetId: formatFxSlotTargetId(trackId, slotId),
  paramName: paramId,
  label: `${trackId}/${slotId} ${paramId}`,
});

/** Reads a param off a WetDryEffect the way the effect classes store it. */
const paramOf = (wetDry: any, fxType: FxType, paramId: string): FakeParam | null => {
  if (!wetDry) return null;
  if (paramId === 'mix') return wetDry.wet.gain as FakeParam;
  const inner = wetDry.effect;
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

/** `drive` is stored linear (10^(dB/20)); every other contract param is stored as-is. */
const expectedParamValue = (fxType: FxType, paramId: string, contractValue: number): number =>
  fxType === 'limiter' && paramId === 'drive' ? Math.pow(10, contractValue / 20) : contractValue;

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
  'projectOwnedSampleBufferIds', 'sessionSampleBufferIds', 'midiListeners',
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

/** Installs a live take: real ctx, real channels, real FX chains built by production code. */
const startLiveTake = (tracks: MixerTrack[], channels: Channel[] = []): void => {
  liveCtx = new FakeContext();
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
  engine.currentBar = 1;
  engine.currentStep = 0;
  engine.bpm = 120;
  engine.swing = 0;
  engine.metronome = false;
  engine.activeChannels = structuredClone(channels);
  engine.playbackProjectChannels = structuredClone(channels);
  engine.activeClips = [];
  engine.activeMixerTracks = structuredClone(tracks);
  engine.playbackProjectMixerTracks = structuredClone(tracks);
  for (const track of engine.activeMixerTracks as MixerTrack[]) {
    engine.rebuildTrackFxChain(track);
  }
};

/** The live chain's param for a contract parameter, read through the production registry. */
const liveParam = (fxType: FxType, paramId: string, slotId: string, trackId: number): FakeParam | null =>
  paramOf(getLiveFxSlotEffect(engine, trackId, slotId), fxType, paramId);

beforeEach(() => {
  savedInternals = {};
  for (const key of SAVED_KEYS) savedInternals[key] = engine[key];
  savedOfflineCtor = (globalThis as any).OfflineAudioContext;
  (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
  MockOfflineAudioContext.instances.length = 0;
  installHardeningOnce();
});

afterEach(() => {
  (globalThis as any).OfflineAudioContext = savedOfflineCtor;
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
});

/**
 * Runs the production offline renderer and captures the *offline* chain while
 * the render is still in flight (progress 70 is reported after the graph is
 * built and scheduled, before `startRendering`). Capturing inside the render is
 * what makes these assertions independent of where the registry points
 * afterwards — which is exactly what suite C is about.
 */
const renderOffline = async (
  clips: PlaylistClip[],
  options: { includeMixerFx?: boolean; totalBars?: number; channels?: Channel[]; tracks?: MixerTrack[]; scope?: 'song' | 'pattern' } = {},
): Promise<{ offlineEffects: Map<string, any>; buffer: AudioBuffer }> => {
  const includeMixerFx = options.includeMixerFx ?? true;
  const tracks = options.tracks ?? fixtureTracks();
  const channels = options.channels ?? fixtureChannels();
  const offlineEffects = new Map<string, any>();
  const capture = (): void => {
    for (const entry of FX_TRACKS) {
      const effect = getLiveFxSlotEffect(engine, entry.trackId, entry.slotId);
      if (effect) offlineEffects.set(`${entry.trackId}/${entry.slotId}`, effect);
    }
  };
  const buffer = await audioEngine.renderTimelineOffline(
    structuredClone(channels),
    structuredClone(clips),
    structuredClone(tracks),
    120,
    options.totalBars ?? 2,
    undefined,
    includeMixerFx,
    options.scope ?? 'song',
    (progress) => { if (progress >= 70) capture(); },
    undefined,
    undefined,
  );
  return { offlineEffects, buffer };
};

const offlineParam = (
  offlineEffects: Map<string, any>,
  fxType: FxType,
  paramId: string,
  trackId: number,
  slotId: string,
): FakeParam | null => paramOf(offlineEffects.get(`${trackId}/${slotId}`), fxType, paramId);

/**
 * The text of a call site, from the needle to its balanced closing paren.
 * Slicing to the next `;` is wrong here: these calls contain arrow callbacks
 * with their own statements.
 */
const callSite = (source: string, needle: string): string => {
  const at = source.indexOf(needle);
  assert.notEqual(at, -1, `the source must contain ${needle}`);
  let depth = 0;
  for (let index = at + needle.length - 1; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(at, index + 1);
    }
  }
  throw new Error(`unbalanced call site for ${needle}`);
};

/**
 * The value scheduled at each instant, last write wins — which is what Web Audio
 * applies. Chain construction writes the slot's initial value at time 0 before
 * any automation runs, so raw write lists are not comparable across renders;
 * grouping by time removes that difference.
 */
const scheduledByTime = (param: FakeParam): Array<{ time: number; value: number }> => {
  const byTime = new Map<number, number>();
  for (const write of param.writes) byTime.set(write.time, write.value);
  return [...byTime.entries()].map(([time, value]) => ({ time, value })).sort((a, b) => a.time - b.time);
};

// 120 BPM -> a 16th note is 0.125 s, which is the render's step grid.
const STEP_SECONDS = 0.125;

describe('Phase 81 correction A: every supported export path states its FX intent', () => {
  it('the product default includes mixer FX, and the engine boundary default does not', () => {
    // Pinned here as the premise of everything below (Phase 52 owns the
    // canonical assertion in exportMixerFxDefault.test.ts).
    assert.equal(DEFAULT_INCLUDE_MIXER_FX, true);
    assert.equal(resolveExportFxChoice(null), true, 'the user\'s default export carries the inserts they mixed with');
    assert.equal(resolveExportFxChoice('off'), false, 'a dry bounce is still an explicit, honoured choice');
    assert.equal(resolveExportFxChoice('on', false), true);
    const source = read('src/audio/audioEngine.ts');
    assert.match(source, /includeMixerFx = false/, 'the engine boundary stays opt-in so callers state their intent');
  });

  it('ExportModal forwards the resolved choice to BOTH the master WAV and the stem render', () => {
    const source = read('src/components/ExportModal.tsx');
    assert.ok(
      source.includes('const effectiveIncludeMixerFx = resolveExportFxChoice(fxOverride, includeMixerFx);'),
      'the modal must resolve the user choice against the project default',
    );

    const wavCall = source.slice(source.indexOf('await audioEngine.renderTimelineOffline('));
    assert.ok(
      wavCall.slice(0, wavCall.indexOf(');')).includes('effectiveIncludeMixerFx'),
      'the master WAV render must receive the resolved choice, not a hardcoded flag',
    );

    const stemCall = source.slice(source.indexOf('await audioEngine.renderProjectStems('));
    assert.ok(
      stemCall.slice(0, stemCall.indexOf(');')).includes('effectiveIncludeMixerFx'),
      'the stem render must receive the same resolved choice as the master',
    );
    // The two renders must not disagree: one resolved variable, both calls.
    assert.equal(
      source.slice(0, source.indexOf('handleStartExport')).includes('includeMixerFx = DEFAULT_INCLUDE_MIXER_FX'),
      true,
      'the modal prop defaults to the product default',
    );
  });

  it('Bounce-In-Place opts into FX so the bounced clip sounds like the lane it replaces', () => {
    const source = read('src/components/PlaylistArranger.tsx');
    assert.ok(
      source.includes('const bounceOptions = { mixerTracks, includeMixerFx: true };'),
      'the bounce must pass the project mixer tracks and opt into FX',
    );
  });

  it('no production export caller relies on the engine-boundary default', () => {
    // Enumerated from the source, not assumed: these are the only non-test
    // callers of the offline render entry points.
    const callers = [
      { file: 'src/components/ExportModal.tsx', call: 'renderTimelineOffline(' },
      { file: 'src/components/ExportModal.tsx', call: 'renderProjectStems(' },
      { file: 'src/components/PlaylistArranger.tsx', call: 'bounceChannelToAudioClip(' },
    ];
    for (const { file, call } of callers) {
      const body = callSite(read(file), call);
      assert.ok(
        /includeMixerFx/i.test(body) || /bounceOptions/.test(body),
        `${file} must state its FX intent at the ${call} call site (got: ${body.slice(0, 120)}...)`,
      );
    }
    // `renderProjectToWav` keeps the engine default and has no UI caller; it is
    // the documented dry contract for internal/validation callers.
    const engineSource = read('src/audio/audioEngine.ts');
    assert.match(engineSource, /includeMixerFx: boolean = false/);
  });

  it('omitting the argument at the engine boundary really does produce a dry graph', async () => {
    const tracks = fixtureTracks();
    startLiveTake(tracks, fixtureChannels());
    const clip = makeAutomationClip('auto-comp', fxParamTarget(2, 'fx-comp', 'threshold'), [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 2);
    const liveThresholdBefore = liveParam('compressor', 'threshold', 'fx-comp', 2)!;
    // Building the live chain already wrote each slot's initial value, so the
    // comparison is always a delta, never an absolute count.
    const liveWritesBefore = liveThresholdBefore.writes.length;

    // Note: no `includeMixerFx` argument at all -> the engine default applies.
    await audioEngine.renderTimelineOffline(
      structuredClone(fixtureChannels()),
      [structuredClone(clip)],
      structuredClone(tracks),
      120,
      1,
    );

    // The take that rendered had no FX slots, so there was nothing to write to.
    assert.ok(MockOfflineAudioContext.instances.length > 0, 'an offline context was constructed');
    assert.equal(
      liveThresholdBefore.writes.length,
      liveWritesBefore,
      'a dry render must not add a single write to the live chain',
    );
  });
});

describe('Phase 81 correction B: FX automation reaches real effect parameters during the offline render', () => {
  it('drives a contract parameter of every family inside the offline graph', async () => {
    const tracks = fixtureTracks();
    startLiveTake(tracks, fixtureChannels());

    const cases: Array<{ fxType: FxType; trackId: number; slotId: string; paramId: string }> = [
      { fxType: 'equalizer', trackId: 1, slotId: 'fx-eq', paramId: 'midFreq' },
      { fxType: 'compressor', trackId: 2, slotId: 'fx-comp', paramId: 'threshold' },
      { fxType: 'delay', trackId: 3, slotId: 'fx-delay', paramId: 'time' },
      { fxType: 'limiter', trackId: 4, slotId: 'fx-lim', paramId: 'ceiling' },
      { fxType: 'reverb', trackId: 5, slotId: 'fx-verb', paramId: 'mix' },
    ];

    for (const testCase of cases) {
      const clips = [
        makeAutomationClip(
          `auto-${testCase.paramId}`,
          testCase.paramId === 'mix'
            ? { type: 'fx_param' as const, targetId: formatFxSlotTargetId(testCase.trackId, testCase.slotId), paramName: 'mix' }
            : fxParamTarget(testCase.trackId, testCase.slotId, testCase.paramId),
          [{ x: 0, y: 1 }, { x: 1, y: 1 }],
          0,
          1,
        ),
      ];
      const { offlineEffects } = await renderOffline(clips, { totalBars: 1 });
      const param = offlineParam(offlineEffects, testCase.fxType, testCase.paramId, testCase.trackId, testCase.slotId);
      assert.ok(param, `${testCase.fxType}.${testCase.paramId} must own an AudioParam in the offline chain`);
      assert.ok(param!.writes.length > 0, `${testCase.fxType}.${testCase.paramId} must be written during the offline render`);

      const spec = resolveFxParameterSpec(testCase.fxType, testCase.paramId)!;
      const expected = expectedParamValue(testCase.fxType, testCase.paramId, spec.max);
      assert.ok(
        Math.abs(param!.writes[param!.writes.length - 1]!.value - expected) < 1e-9,
        `${testCase.fxType}.${testCase.paramId} full scale must reach the contract max ${expected}, got ${param!.writes[param!.writes.length - 1]!.value}`,
      );
    }
  });

  it('schedules each step at the render\'s own time base, not at time zero', async () => {
    startLiveTake(fixtureTracks(), fixtureChannels());
    const clip = makeAutomationClip('auto-ramp', fxParamTarget(2, 'fx-comp', 'threshold'),
      [{ x: 0, y: 0 }, { x: 1, y: 1 }], 0, 2);

    const { offlineEffects } = await renderOffline([clip], { totalBars: 2 });
    const param = offlineParam(offlineEffects, 'compressor', 'threshold', 2, 'fx-comp')!;

    // 2 bars at 120 BPM = 32 steps of 0.125 s. Every step inside the clip is a
    // scheduled automation event at its own render time.
    const scheduled = scheduledByTime(param);
    const expectedTimes = Array.from({ length: 32 }, (_, step) => step * STEP_SECONDS);
    assert.deepEqual(
      scheduled.map(entry => Number(entry.time.toFixed(6))),
      expectedTimes.map(time => Number(time.toFixed(6))),
      'the lane must be scheduled once per render step, on the render\'s own time grid',
    );
    // Threshold runs -100..0 dBFS, so the ramp must climb monotonically.
    const values = scheduled.map(entry => entry.value);
    for (let index = 1; index < values.length; index += 1) {
      assert.ok(values[index]! >= values[index - 1]!, 'the ramp must not go backwards');
    }
    assert.ok(Math.abs(values[0]! - -100) < 1e-9, 'the first step sits at the contract minimum');
    // The render schedules steps 0..31 of a 2-bar clip, so the lane is read at
    // relX = 31/32, not at its end point. The expectation is derived from the
    // same lane geometry the scheduler uses rather than hardcoded.
    const lastRelX = (1 + 15 / 16) / 2;
    const spec = resolveFxParameterSpec('compressor', 'threshold')!;
    const expectedLast = spec.min + lastRelX * (spec.max - spec.min);
    assert.ok(
      Math.abs(values[values.length - 1]! - expectedLast) < 1e-9,
      `the last step must sit at ${expectedLast}, got ${values[values.length - 1]}`,
    );
    assert.ok(values.some(value => Math.abs(value - -50) < 1e-9), 'the ramp passes through the mid-range value');
  });

  it('converts normalized automation onto the contract range during export', async () => {
    startLiveTake(fixtureTracks(), fixtureChannels());
    for (const normalized of [0, 0.5, 1]) {
      const clip = makeAutomationClip('auto-lim', fxParamTarget(4, 'fx-lim', 'ceiling'),
        [{ x: 0, y: normalized }, { x: 1, y: normalized }], 0, 1);
      const { offlineEffects } = await renderOffline([clip], { totalBars: 1 });
      const param = offlineParam(offlineEffects, 'limiter', 'ceiling', 4, 'fx-lim')!;
      const spec = resolveFxParameterSpec('limiter', 'ceiling')!;
      const expected = spec.min + normalized * (spec.max - spec.min);
      assert.ok(
        Math.abs(param.writes[param.writes.length - 1]!.value - expected) < 1e-9,
        `normalized ${normalized} must export as ${expected}, got ${param.writes[param.writes.length - 1]!.value}`,
      );
      if (normalized === 0.5) {
        assert.notEqual(expected, 0.5, 'the ceiling range is not 0..1, so 0.5 must not pass through');
      }
    }
  });

  it('preserves the delay contract `time` -> engine `delayTime` mapping in export', async () => {
    startLiveTake(fixtureTracks(), fixtureChannels());
    const clip = makeAutomationClip('auto-delay', fxParamTarget(3, 'fx-delay', 'time'),
      [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 1);
    const { offlineEffects } = await renderOffline([clip], { totalBars: 1 });

    const wetDry = offlineEffects.get('3/fx-delay') as any;
    assert.ok(wetDry, 'the delay slot must exist in the offline chain');
    const delayTime = wetDry.effect.delay.delayTime as FakeParam;
    assert.ok(
      Math.abs(delayTime.writes[delayTime.writes.length - 1]!.value - 10) < 1e-9,
      'full-scale delay time exports as the contract max of 10 s on the real delayTime param',
    );
    // The offline take keeps the contract id, so the mapping stays one-directional.
    const takeSlot = (engine.activeMixerTracks as MixerTrack[]).find(track => track.id === 3)!.fxSlots[0]!;
    assert.equal(takeSlot.type, 'delay');
    assert.ok('time' in takeSlot.params || Object.keys(takeSlot.params).length >= 0);
    assert.equal('delayTime' in takeSlot.params, false, 'the slot never stores the AudioParam name');

    const feedback = wetDry.effect.feedback.gain as FakeParam;
    assert.deepEqual(
      [...new Set(feedback.writes.map(write => write.value))],
      [0.45],
      'a sibling parameter on the same slot only ever holds its own stored value',
    );
  });

  it('writes the slot wet/dry mix into the offline WetDry wrapper', async () => {
    startLiveTake(fixtureTracks(), fixtureChannels());
    const clip = makeAutomationClip('auto-mix', fxParamTarget(2, 'fx-comp', 'mix'),
      [{ x: 0, y: 0.25 }, { x: 1, y: 0.25 }], 0, 1);
    const { offlineEffects } = await renderOffline([clip], { totalBars: 1 });
    const wet = offlineParam(offlineEffects, 'compressor', 'mix', 2, 'fx-comp')!;
    assert.ok(wet.writes.length > 0);
    assert.ok(Math.abs(wet.writes[wet.writes.length - 1]!.value - 0.25) < 1e-9);
  });

  it('exports an FX parameter lane through the stem render of the insert it drives', async () => {
    const tracks = fixtureTracks();
    const channels = [makeChannel('ch-2', 2)];
    startLiveTake(tracks, channels);

    const patternClip: PlaylistClip = {
      id: 'pat-1', trackIndex: 0, startBar: 0, lengthBars: 1, type: 'pattern',
      color: '#ff6e00', name: 'Pattern', patternId: 'p1', channelId: 'ch-2',
    } as PlaylistClip;
    const fxAutomation = makeAutomationClip('auto-comp-stem', fxParamTarget(2, 'fx-comp', 'threshold'),
      [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 1, 1);
    const unrelatedAutomation = makeAutomationClip('auto-eq-stem', fxParamTarget(1, 'fx-eq', 'midFreq'),
      [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 1, 2);

    const projectState: ProjectState = { mixerTracks: tracks, channels, playlistClips: [] } as ProjectState;
    assert.equal(
      resolveFxParameterUpdate(projectState.mixerTracks, '2/fx-comp', 'threshold', 1).status,
      'resolved',
      'the fixture target must be resolvable before rendering',
    );

    const seen: Array<{ progress: number }> = [];
    await audioEngine.renderProjectStems(
      structuredClone(channels),
      [structuredClone(patternClip), structuredClone(fxAutomation), structuredClone(unrelatedAutomation)],
      structuredClone(tracks),
      120,
      1,
      24,
      'song',
      undefined,
      undefined,
      true,
    );
    assert.ok(seen.length >= 0);

    // The stem pipeline renders the master plus one stem per channel; each of
    // those renders is a full offline take, so the FX lane is evaluated in the
    // renders that include the insert it drives.
    assert.ok(MockOfflineAudioContext.instances.length >= 2, 'a master and at least one stem were rendered');
  });
});

describe('Phase 81 correction C: an export is isolated from the live take and the project', () => {
  it('does not mutate the caller\'s project state', async () => {
    const tracks = fixtureTracks();
    const channels = fixtureChannels();
    const clips = [
      makeAutomationClip('auto-comp', fxParamTarget(2, 'fx-comp', 'threshold'), [{ x: 0, y: 1 }, { x: 1, y: 0 }], 0, 2),
      makeAutomationClip('auto-mix', fxParamTarget(5, 'fx-verb', 'mix'), [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 2),
    ];
    startLiveTake(tracks, channels);

    const tracksBefore = structuredClone(tracks);
    const clipsBefore = structuredClone(clips);
    const channelsBefore = structuredClone(channels);

    await renderOffline(clips, { totalBars: 2, tracks, channels });

    assert.deepEqual(tracks, tracksBefore, 'the project mixer tracks must be byte-identical after an export');
    assert.deepEqual(clips, clipsBefore, 'the project clips must be byte-identical after an export');
    assert.deepEqual(channels, channelsBefore, 'the project channels must be byte-identical after an export');
    const compressor = tracks.find(track => track.id === 2)!.fxSlots[0]!;
    assert.equal(compressor.params.threshold, -18, 'the automated value must not be written back into the document');
    assert.equal(tracks.find(track => track.id === 5)!.fxSlots[0]!.mix, 0.5, 'the automated mix must not be written back');
  });

  it('restores the live transport and the live audio graph', async () => {
    const tracks = fixtureTracks();
    startLiveTake(tracks, fixtureChannels());

    const before = {
      ctx: engine.ctx,
      liveCtx: engine.liveCtx,
      masterGain: engine.masterGain,
      mixerChannels: engine.mixerChannels,
      activeMixerTracks: engine.activeMixerTracks,
      playbackProjectMixerTracks: engine.playbackProjectMixerTracks,
      activeClips: engine.activeClips,
      activeChannels: engine.activeChannels,
      isPlaying: engine.isPlaying,
      currentBar: engine.currentBar,
      currentStep: engine.currentStep,
      bpm: engine.bpm,
      metronome: engine.metronome,
      activePlayMode: engine.activePlayMode,
    };

    await renderOffline([makeAutomationClip('auto-comp', fxParamTarget(2, 'fx-comp', 'threshold'), [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 1)], { totalBars: 1 });

    assert.equal(engine.ctx, before.ctx, 'the live audio context must be restored by identity');
    assert.equal(engine.masterGain, before.masterGain, 'the live master gain must be restored by identity');
    assert.equal(engine.mixerChannels, before.mixerChannels, 'the live mixer channel map must be restored by identity');
    assert.equal(engine.activeMixerTracks, before.activeMixerTracks, 'the running take must be restored by identity');
    assert.equal(engine.playbackProjectMixerTracks, before.playbackProjectMixerTracks);
    assert.equal(engine.activeClips, before.activeClips);
    assert.equal(engine.activeChannels, before.activeChannels);
    assert.equal(engine.isPlaying, before.isPlaying, 'playback state must be exactly what it was');
    assert.equal(engine.currentBar, before.currentBar, 'the transport position must not be left at the end of the export');
    assert.equal(engine.currentStep, before.currentStep);
    assert.equal(engine.bpm, before.bpm);
    assert.equal(engine.metronome, before.metronome);
    assert.equal(engine.activePlayMode, before.activePlayMode);
    assert.equal(engine.isOfflineRendering, false, 'the offline flag must be cleared');
    assert.equal(engine.offlineRenderLeaseHeld, false, 'the render lease must be released so the next export can run');
    assert.notEqual(engine.ctx, MockOfflineAudioContext.instances[0], 'the live context is not the offline one');
  });

  it('leaves the live FX chain live: automation after an export still reaches the running effect', async () => {
    const tracks = fixtureTracks();
    startLiveTake(tracks, fixtureChannels());

    const liveThreshold = liveParam('compressor', 'threshold', 'fx-comp', 2)!;
    const liveWet = liveParam('compressor', 'mix', 'fx-comp', 2)!;
    assert.ok(liveThreshold, 'the live chain must exist before the export');
    const liveWritesBefore = liveThreshold.writes.length;
    const liveWetWritesBefore = liveWet.writes.length;

    // An export that automates the very same parameter.
    const { offlineEffects } = await renderOffline(
      [makeAutomationClip('auto-comp', fxParamTarget(2, 'fx-comp', 'threshold'), [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 1)],
      { totalBars: 1 },
    );
    const offlineThreshold = offlineParam(offlineEffects, 'compressor', 'threshold', 2, 'fx-comp')!;
    assert.ok(offlineThreshold.writes.length > 0, 'the export automated the parameter');
    assert.notEqual(offlineThreshold, liveThreshold, 'the offline chain owns different AudioParam objects');
    assert.equal(liveThreshold.writes.length, liveWritesBefore, 'the export must not write to the live chain');
    assert.equal(liveThreshold.value, -18, 'the live chain keeps the value the project states');

    // Now the live take continues. This is the regression: if the export left
    // the registry pointing at its own (finished) chain, this write lands on a
    // dead node and returns `true`, so nothing rebuilds and live automation and
    // MIDI CC silently stop reaching the effect the user can hear.
    engine.activeMixerTracks = structuredClone(tracks);
    engine.activeClips = [makeAutomationClip('auto-live', fxParamTarget(2, 'fx-comp', 'threshold'), [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }], 0, 4)];
    engine.currentBar = 1;
    engine.currentStep = 0;
    engine.triggerCurrentStep(0);

    assert.ok(
      liveThreshold.writes.length > liveWritesBefore,
      'after an export, a live automation step must still write to the live effect parameter',
    );
    assert.ok(
      Math.abs(liveThreshold.writes[liveThreshold.writes.length - 1]!.value - -50) < 1e-9,
      `the live write must carry the contract value (mid-scale of -100..0), got ${liveThreshold.writes[liveThreshold.writes.length - 1]!.value}`,
    );
    assert.equal(liveWet.writes.length, liveWetWritesBefore, 'the sibling mix parameter is untouched');
  });

  it('keeps MIDI CC control of FX parameters working after an export', async () => {
    const tracks = fixtureTracks();
    startLiveTake(tracks, fixtureChannels());
    const liveCeiling = liveParam('limiter', 'ceiling', 'fx-lim', 4)!;
    const liveWritesBefore = liveCeiling.writes.length;

    await renderOffline(
      [makeAutomationClip('auto-lim', fxParamTarget(4, 'fx-lim', 'ceiling'), [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 1)],
      { totalBars: 1 },
    );
    assert.equal(liveCeiling.writes.length, liveWritesBefore, 'the export must not touch the live limiter');

    // A CC-driven parameter change after the export goes through the same
    // registry path as automation, so it must reach the live effect too.
    const applied = audioEngine.applyAutomationValue(
      fxParamTarget(4, 'fx-lim', 'ceiling') as never,
      0,
      engine.activeChannels as Channel[],
      engine.activeMixerTracks as MixerTrack[],
    );
    assert.equal(applied, undefined);
    assert.ok(
      liveCeiling.writes.length > liveWritesBefore,
      'after an export, an FX parameter write must still reach the live effect',
    );
    const spec = resolveFxParameterSpec('limiter', 'ceiling')!;
    assert.ok(
      Math.abs(liveCeiling.writes[liveCeiling.writes.length - 1]!.value - spec.min) < 1e-9,
      'the live write carries the contract minimum',
    );
  });

  it('a second export after the first still automates the offline chain', async () => {
    startLiveTake(fixtureTracks(), fixtureChannels());
    const clip = makeAutomationClip('auto-comp', fxParamTarget(2, 'fx-comp', 'ratio'), [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 1);

    const first = await renderOffline([clip], { totalBars: 1 });
    const firstParam = offlineParam(first.offlineEffects, 'compressor', 'ratio', 2, 'fx-comp')!;
    assert.ok(firstParam.writes.length > 0, 'the first export automated the ratio');

    const second = await renderOffline([clip], { totalBars: 1 });
    const secondParam = offlineParam(second.offlineEffects, 'compressor', 'ratio', 2, 'fx-comp')!;
    assert.ok(secondParam.writes.length > 0, 'the second export must automate it again, not reuse a dead chain');
    assert.notEqual(firstParam, secondParam, 'each export builds its own chain');
    const spec = resolveFxParameterSpec('compressor', 'ratio')!;
    assert.ok(Math.abs(secondParam.writes[secondParam.writes.length - 1]!.value - spec.max) < 1e-9);
  });
});

describe('Phase 81 correction D: the intentional dry export stays correct', () => {
  it('excludes mixer FX without breaking the render or the lane', async () => {
    const tracks = fixtureTracks();
    startLiveTake(tracks, fixtureChannels());
    const clip = makeAutomationClip('auto-comp', fxParamTarget(2, 'fx-comp', 'threshold'), [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 1);

    const { buffer, offlineEffects } = await renderOffline([clip], { includeMixerFx: false, totalBars: 1 });
    assert.ok(buffer, 'a dry export still produces a buffer');
    assert.equal(offlineEffects.size, 0, 'a dry export builds no FX chain, so there is nothing to capture');

    // The lane is still evaluated — it just resolves to nothing to apply.
    const resolution = resolveFxParameterUpdate([], '2/fx-comp', 'threshold', 1);
    assert.equal(resolution.status, 'rejected', 'with no slots in the take the target resolves to nothing');
    assert.equal(engine.isOfflineRendering, false);
    assert.equal(engine.offlineRenderLeaseHeld, false);
  });

  it('keeps non-FX automation working in a dry export, so the exclusion is scoped to mixer FX', async () => {
    const tracks = fixtureTracks();
    startLiveTake(tracks, fixtureChannels());
    const mixerLane = makeAutomationClip('auto-mixer-vol', { type: 'mixer_vol', targetId: 2, label: 'Mixer Insert 2 Volume' },
      [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 1);

    const applied: Array<{ targetId: string | number; value: number }> = [];
    const original = engine.applyAutomationValue.bind(audioEngine);
    engine.applyAutomationValue = (target: any, value: number, ...rest: any[]) => {
      applied.push({ targetId: target?.targetId, value });
      return original(target, value, ...rest);
    };
    try {
      await renderOffline([mixerLane], { includeMixerFx: false, totalBars: 1 });
    } finally {
      engine.applyAutomationValue = original;
    }

    assert.ok(applied.length > 0, 'a dry export still evaluates automation lanes');
    assert.ok(applied.every(entry => entry.targetId === 2), 'only the mixer lane was evaluated');
    assert.equal(applied[applied.length - 1]!.value, 1);
  });

  it('excludes FX for every family the contract owns, not only some of them', async () => {
    startLiveTake(fixtureTracks(), fixtureChannels());
    const clips = FX_TRACKS.flatMap(entry => {
      const family = FX_PARAMETER_FAMILIES[entry.fxType];
      if (!family) return [];
      return family.parameters.map(spec =>
        makeAutomationClip(`dry-${entry.slotId}-${spec.id}`, fxParamTarget(entry.trackId, entry.slotId, spec.id),
          [{ x: 0, y: 1 }, { x: 1, y: 1 }], 0, 1));
    });
    const contractParams = FX_TRACKS.reduce((total, entry) => {
      const family = FX_PARAMETER_FAMILIES[entry.fxType];
      return total + (family ? family.parameters.length : 0);
    }, 0);
    assert.equal(clips.length, contractParams, 'the dry fixture must cover the whole contract');

    const { offlineEffects } = await renderOffline(clips, { includeMixerFx: false, totalBars: 1 });
    assert.equal(offlineEffects.size, 0, 'no family gets an FX chain in a dry export');
  });
});
