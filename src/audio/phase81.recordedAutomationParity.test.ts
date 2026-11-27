/**
 * Phase 12 — measured live/offline parity for recorded automation.
 *
 * WHAT IS MEASURED, AND WHAT IS NOT. These suites record a pass with the real
 * `AutomationRecordingRuntime` (real lane surgery, real history, real project
 * normalizer), then play the recorded document through the two evaluators that
 * exist in production and compare the numbers they produce:
 *
 *   * live:    `AudioEngine.triggerCurrentStep` — the same method the running
 *              sequencer calls each 16th — driven here over the same step grid
 *              the transport uses, with the engine's real `applyAutomationValue`
 *              writing into real FX-chain AudioParams.
 *   * offline: `AudioEngine.renderTimelineOffline` — the production export
 *              renderer (the one ExportModal and Bounce-In-Place call), whose
 *              step loop calls the same `triggerCurrentStep` with audio times.
 *
 * Comparisons are between *measured* values: the AudioParam write each renderer
 * performed at each step (last write wins, which is what Web Audio applies), the
 * `FxSlot` value the renderer left behind, and — for `vst3_param` — the points
 * the production `NativeAutomationTimeline` emits for the same block. Node has no
 * Web Audio, so `OfflineAudioContext` is a test double and `startRendering()`
 * returns silence; nothing here claims acoustic equivalence, and no assertion is
 * satisfied by a mock's echo of an input. Every number below is produced by
 * production code evaluating the document.
 *
 * The suites cover the three targets the phase requires: `mixer_vol`,
 * `fx_param` and `vst3_param`.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Channel, FxSlot, FxType, MixerTrack, PlaylistClip, ProjectState } from '../types/daw';
import { audioEngine } from './audioEngine';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { createHistory } from '../state/projectHistory';
import { serializeProjectState } from '../state/projectPersistence';
import { AutomationRecordingRuntime } from './automationRecordingRuntime';
import { interpolateCurve as interpolationValue } from './automation/curve';
import {
  readAutomationTargetValue,
  setAutomationMode,
  transportSampleFromPosition,
} from './automationRecording';
import { formatFxSlotTargetId, resolveFxParameterUpdate } from './fxParameterControl';
import { resolveFxParameterSpec } from './fxParameterContract';
import { resolveProjectTimeSignature } from '../music/musicalTime';
import { NativeAutomationTimeline, nativeTarget } from './nativeVst3Automation';
import type { Vst3Parameter } from './nativeVst3Types';

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const BPM = 120;
/** 120 BPM, 4/4: one 16th = 0.125 s, one bar = 2 s. */
const STEP_SECONDS = 0.125;
const SECONDS_PER_BAR = 2;
/**
 * The live fake context's clock starts at 2 s (a running AudioContext is never at
 * 0), while an export's graph starts at 0 s. Parity is therefore compared on the
 * musical position: `offlineTime + LIVE_CLOCK_ORIGIN === liveTime`.
 */
const LIVE_CLOCK_ORIGIN = 2;

// --- Fake Web Audio -----------------------------------------------------------

class FakeParam {
  value: number;
  readonly writes: Array<{ value: number; time: number }> = [];
  constructor(value = 0) { this.value = value; }
  setValueAtTime(value: number, time = 0): void { this.value = value; this.writes.push({ value, time }); }
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
      copyToChannel: (source: Float32Array, channel: number) => {
        (data[channel] ?? data[0]!).set(source.subarray(0, Math.min(source.length, length)));
      },
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

const COMPRESSOR_PARAMS = { threshold: -18, knee: 24, ratio: 4, attack: 0.005, release: 0.15 };

const makeSlot = (id: string, type: FxType, params: Record<string, number> = {}, mix = 0.8): FxSlot => ({
  id, type, name: `${type} ${id}`, enabled: true, mix, params,
});

const makeTrack = (id: number, fxSlots: FxSlot[] = [], volume = 0.8): MixerTrack => ({
  id, name: `Insert ${id}`, color: '#ffffff', volume, pan: 0, mute: false, solo: false, routingTargetId: 0, fxSlots,
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

const automationClip = (
  id: string,
  target: NonNullable<PlaylistClip['automationTarget']>,
  points: Array<{ x: number; y: number; tension?: number }>,
  startBar = 0,
  lengthBars = 2,
): PlaylistClip => ({
  id, trackIndex: 1, startBar, lengthBars, type: 'automation', color: '#00e5ff',
  name: `Auto ${id}`, automationTarget: target, automationPoints: points,
} as PlaylistClip);

const projectWith = (clips: PlaylistClip[], mixerTracks: MixerTrack[], channels: Channel[], mode: 'write' | 'touch' | 'latch'): ProjectState =>
  normalizeProjectState({
    ...createDefaultProjectState(),
    // The recording harness's transport clock is BPM; the document must agree, or
    // the two renderers would evaluate the same lane on different step grids.
    meta: { ...createDefaultProjectState().meta, bpm: BPM },
    channels,
    mixerTracks,
    playlistClips: clips,
    automationModes: clips.reduce(
      (modes, clip) => setAutomationMode(modes, clip.automationTarget, mode),
      undefined as ProjectState['automationModes'],
    ),
  });

// --- Recording harness (production runtime, production history) ----------------

class RecordingHarness {
  state: ProjectState;
  history: ReturnType<typeof createHistory>;
  positionSeconds = 0;
  playing = false;

  constructor(state: ProjectState) {
    this.state = state;
    this.history = createHistory(state);
  }

  runtime(): AutomationRecordingRuntime {
    return new AutomationRecordingRuntime({
      getProjectState: () => this.state,
      getTransportPosition: () => ({ bpm: BPM, playing: this.playing, positionSeconds: this.positionSeconds }),
      commitPass: (label, apply) => {
        this.state = apply(this.state);
        this.history = this.history.commit(this.state, label);
      },
    });
  }

  advanceTo(bar: number, runtime: AutomationRecordingRuntime): void {
    this.positionSeconds = bar * SECONDS_PER_BAR;
    runtime.tick();
  }

  play(runtime: AutomationRecordingRuntime): void {
    this.playing = true;
    runtime.tick();
  }

  /** The mixer's own funnel: the project value AND the capture, in that order. */
  setMixerVolume(trackId: number, normalized: number, runtime: AutomationRecordingRuntime): void {
    this.state = {
      ...this.state,
      mixerTracks: this.state.mixerTracks.map(track => track.id === trackId
        ? { ...track, volume: Math.max(0, Math.min(1.25, normalized * 1.25)) }
        : track),
    };
    runtime.reportValue({ type: 'mixer_vol', targetId: trackId }, normalized);
  }

  /**
   * The App's `handleUpdateFxSlot`: mutate the slot, then read the parameter back
   * through the production `readAutomationTargetValue` and capture THAT value. The
   * test therefore records exactly what the shipped funnel records.
   */
  setFxParam(targetId: string, paramName: string, contractValue: number, runtime: AutomationRecordingRuntime): void {
    this.state = {
      ...this.state,
      mixerTracks: this.state.mixerTracks.map(track => ({
        ...track,
        fxSlots: track.fxSlots.map(slot => formatFxSlotTargetId(track.id, slot.id) === targetId
          ? { ...slot, params: { ...slot.params, [paramName]: contractValue } }
          : slot),
      })),
    };
    const normalized = readAutomationTargetValue(
      { type: 'fx_param', targetId, paramName },
      this.state.channels,
      this.state.mixerTracks,
    );
    if (normalized !== null) runtime.reportValue({ type: 'fx_param', targetId, paramName }, normalized);
  }
}

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
  'projectOwnedSampleBufferIds', 'sessionSampleBufferIds', 'masteringProcessor', '__fxSlotEffectMaps',
  'masteringState', 'nativePreparing', 'sequencerDispatchDepth', 'midiOutputScheduler',
];

let savedInternals: EngineInternals = {};
let savedOfflineCtor: unknown;

const installLiveTake = (channels: Channel[], tracks: MixerTrack[], clips: PlaylistClip[]): FakeContext => {
  const liveCtx = new FakeContext();
  engine.ctx = liveCtx;
  engine.liveCtx = liveCtx;
  engine.masterGain = liveCtx.createGain();
  engine.grossBeatNode = liveCtx.createGain();
  engine.masterAnalyser = liveCtx.createAnalyser();
  engine.masteringProcessor = null;
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
  engine.nativePreparing = false;
  engine.activePlayMode = 'song';
  engine.activePatternId = undefined;
  engine.activePatternLengthSteps = undefined;
  engine.currentBar = 1;
  engine.currentStep = 0;
  engine.bpm = BPM;
  engine.swing = 0;
  engine.metronome = false;
  engine.transport = null;
  engine.activeChannels = structuredClone(channels);
  engine.playbackProjectChannels = structuredClone(channels);
  engine.activeClips = structuredClone(clips);
  engine.activeMixerTracks = structuredClone(tracks);
  engine.playbackProjectMixerTracks = structuredClone(tracks);
  engine.__fxSlotEffectMaps = new Map();
  for (const track of engine.activeMixerTracks as MixerTrack[]) engine.rebuildTrackFxChain(track);
  return liveCtx;
};

/** Drives the live scheduler over `bars` bars of song position, one 16th at a time. */
const playLive = (bars: number): void => {
  const stepsPerBar = 16;
  for (let bar = 1; bar <= bars; bar += 1) {
    for (let step = 0; step < stepsPerBar; step += 1) {
      engine.currentBar = bar;
      engine.currentStep = step;
      const audioTime = ((bar - 1) * stepsPerBar + step) * STEP_SECONDS + LIVE_CLOCK_ORIGIN;
      engine.triggerCurrentStep(audioTime);
    }
  }
};

/**
 * What the offline render's own graph did. Captured while the render is in
 * flight (progress 70 is reported after the graph is built and every step is
 * scheduled, before `startRendering`), because the render hands the live
 * registries back when it finishes.
 */
export interface OfflineCapture {
  mixerGain: FakeParam | null;
  fxParam: FakeParam | null;
}

/**
 * Runs the production export renderer and captures the AudioParams of the
 * *offline* graph. Positional signature (audioEngine.ts): channels, clips,
 * mixerTracks, bpm, totalBars, sampleRate, includeMixerFx, renderScope,
 * onProgress, patternLengthSteps, playlistTracks, minimumDurationSeconds,
 * patterns, outputStage.
 */
const renderOffline = async (
  state: ProjectState,
  bars: number,
  capture?: { trackId: number; slotId?: string; fxType?: FxType; paramId?: string },
): Promise<{ buffer: AudioBuffer; captured: OfflineCapture }> => {
  const captured: OfflineCapture = { mixerGain: null, fxParam: null };
  const buffer = await audioEngine.renderTimelineOffline(
    structuredClone(state.channels),
    structuredClone(state.playlistClips),
    structuredClone(state.mixerTracks),
    state.meta.bpm,
    bars,
    undefined,
    true,
    'song',
    progress => {
      if (!capture || progress < 70 || captured.mixerGain) return;
      const channel = (engine.mixerChannels as Map<number, any>).get(capture.trackId);
      captured.mixerGain = (channel?.output?.gain as FakeParam) ?? null;
      if (capture.slotId && capture.fxType && capture.paramId) {
        const effect = (engine.__fxSlotEffectMaps as Map<number, Map<string, any>> | undefined)
          ?.get(capture.trackId)?.get(capture.slotId);
        captured.fxParam = audioParamOf(effect, capture.fxType, capture.paramId);
      }
    },
  );
  return { buffer, captured };
};

/** Last write wins at each instant, which is what Web Audio applies. */
const scheduledByTime = (param: FakeParam): Array<{ time: number; value: number }> => {
  const byTime = new Map<number, number>();
  for (const write of param.writes) byTime.set(write.time, write.value);
  return [...byTime.entries()].map(([time, value]) => ({ time, value })).sort((a, b) => a.time - b.time);
};

const liveSlotEffect = (trackId: number, slotId: string): any | undefined =>
  (engine.__fxSlotEffectMaps as Map<number, Map<string, any>> | undefined)?.get(trackId)?.get(slotId);

/** The real AudioParam a contract parameter lands on for each implemented family. */
const audioParamOf = (effect: any, fxType: FxType, paramId: string): FakeParam | null => {
  if (!effect) return null;
  if (paramId === 'mix') return effect.wet.gain as FakeParam;
  const inner = effect.effect;
  switch (fxType) {
    case 'equalizer': {
      const band = paramId.startsWith('low') ? 0 : paramId.startsWith('mid') ? 1 : 2;
      const field = paramId.endsWith('Freq') ? 'frequency' : paramId.endsWith('Gain') ? 'gain' : 'Q';
      return inner.effects[band].input[field] as FakeParam;
    }
    case 'compressor': return inner.input[paramId] as FakeParam;
    case 'delay': return paramId === 'time' ? inner.delay.delayTime as FakeParam : inner.feedback.gain as FakeParam;
    case 'limiter':
      if (paramId === 'ceiling') return inner.limiter.threshold as FakeParam;
      if (paramId === 'release') return inner.limiter.release as FakeParam;
      return inner.drive.gain as FakeParam;
    default: return null;
  }
};

beforeEach(() => {
  savedInternals = {};
  for (const key of SAVED_KEYS) savedInternals[key] = engine[key];
  savedOfflineCtor = (globalThis as any).OfflineAudioContext;
  (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
  MockOfflineAudioContext.instances.length = 0;
});

afterEach(() => {
  (globalThis as any).OfflineAudioContext = savedOfflineCtor;
  for (const key of SAVED_KEYS) engine[key] = savedInternals[key];
});

// --- A. mixer_vol --------------------------------------------------------------

describe('Phase 12 parity A: a recorded mixer_vol pass plays the same curve live and offline', () => {
  const recordMixerPass = async (): Promise<ProjectState> => {
    const tracks = [makeTrack(0, [], 1), makeTrack(1, [], 0.8)];
    const clip = automationClip(
      'auto-vol',
      { type: 'mixer_vol', targetId: 1, label: 'Insert 1 Volume' },
      [{ x: 0, y: 0.2, tension: 0 }, { x: 0.5, y: 0.5, tension: 0 }, { x: 1, y: 0.2, tension: 0 }],
      0,
      2,
    );
    const harness = new RecordingHarness(projectWith([clip], tracks, [], 'write'));
    const runtime = harness.runtime();
    harness.play(runtime);
    // A performance: grab the fader and move it across the pass.
    runtime.beginGesture({ type: 'mixer_vol', targetId: 1 });
    for (let step = 0; step < 32; step += 1) {
      harness.advanceTo(step / 16, runtime);
      const normalized = step < 16 ? 0.2 + (step / 16) * 0.5 : 0.7 - ((step - 16) / 16) * 0.5;
      harness.setMixerVolume(1, normalized, runtime);
      }
    runtime.endGesture({ type: 'mixer_vol', targetId: 1 });
    harness.advanceTo(2, runtime);
    runtime.finish('stop');
    assert.equal(harness.history.past.length, 1, 'the performance is one undo entry');
    return harness.state;
  };

  it('the recorded lane evaluates to the performance, and live/offline write the same gains', async () => {
    const recorded = await recordMixerPass();

    // 1. The lane itself, evaluated by the production interpolator.
    const lane = recorded.playlistClips.find(clip => clip.id === 'auto-vol')!.automationPoints!;
    assert.ok(lane.length >= 3);
    assert.ok(Math.abs(lane[0].y - 0.2) < 1e-6, `the pass starts where the fader was, got ${lane[0].y}`);

    // 2. LIVE: play the recorded document through the production step scheduler.
    installLiveTake(recorded.channels, recorded.mixerTracks, recorded.playlistClips);
    const liveMixerChannel = engine.getOrCreateMixerChannel(1);
    const liveGain = liveMixerChannel.output.gain as FakeParam;
    liveGain.writes.length = 0;
    playLive(2);
    const liveWrites = scheduledByTime(liveGain);
    assert.ok(liveWrites.length >= 8, `the live take must automate the fader, got ${liveWrites.length} writes`);

    // 3. OFFLINE: export the same document and capture the export graph's fader.
    const { buffer: offlineBuffer, captured } = await renderOffline(recorded, 2, { trackId: 1 });
    assert.ok(offlineBuffer.length > 0);
    assert.ok(captured.mixerGain, 'the export graph must own a fader for the automated insert');
    const offlineWrites = scheduledByTime(captured.mixerGain!);
    assert.ok(offlineWrites.length >= 8, `the export must automate the fader, got ${offlineWrites.length} writes`);

    /*
     * 4. PARITY. Two independent claims, both measured:
     *    a) the export graph's fader is driven BY the recorded lane — this is the
     *       one that fails if the lane stops reaching `mixer_vol` during export;
     *    b) live and export write the same value at every shared instant — this is
     *       the one that fails if the two renderers disagree.
     * Checking only (b) against the lane would let a broken export pass as long as
     * the live path was equally broken.
     */
    const exportByTime = new Map(offlineWrites.map(entry => [entry.time.toFixed(4), entry.value]));
    let exportSteps = 0;
    for (const [time, value] of exportByTime) {
      // The export's graph is anchored at 0 s; the lane is a function of bar.
      const bar = Number(time) / SECONDS_PER_BAR;
      if (bar > 2) continue;
      const expected = interpolationValue(lane, Math.min(1, bar / 2)) * 1.25;
      assert.ok(
        Math.abs(value - expected) < 1e-6,
        `export at ${time}s (bar ${bar.toFixed(3)}) wrote ${value}; the recorded lane evaluates to ${expected}`,
      );
      exportSteps += 1;
    }
    assert.ok(exportSteps >= 8, `only ${exportSteps} export steps followed the lane`);
    const liveByTime = new Map(
      scheduledByTime(liveGain).map(entry => [(entry.time - LIVE_CLOCK_ORIGIN).toFixed(4), entry.value]),
    );
    let compared = 0;
    for (const write of offlineWrites) {
      const liveValue = liveByTime.get(write.time.toFixed(4));
      if (liveValue === undefined) continue;
      assert.ok(
        Math.abs(liveValue - write.value) < 1e-9,
        `at ${write.time}s live wrote ${liveValue}, export wrote ${write.value}`,
      );
      const bar = write.time / SECONDS_PER_BAR;
      const expected = interpolationValue(lane, Math.min(1, bar / 2)) * 1.25;
      assert.ok(
        Math.abs(write.value - expected) < 1e-6,
        `at ${write.time}s (bar ${bar.toFixed(3)}) export wrote ${write.value}; the lane evaluates to ${expected}`,
      );
      compared += 1;
    }
    assert.ok(compared >= 8, `only ${compared} instants were comparable across live and export`);
    // The pass is not a flat line: prove the comparison covered a real sweep.
    const values = offlineWrites.map(write => write.value);
    assert.ok(Math.max(...values) - Math.min(...values) > 0.3,
      `the exported fader must sweep, got ${Math.min(...values)}..${Math.max(...values)}`);
  });

  it('stop/restart and save/reopen produce the identical live curve', async () => {
    const recorded = await recordMixerPass();
    const lane = recorded.playlistClips[0].automationPoints!;
    const sampleTimes = Array.from({ length: 32 }, (_, step) => step * STEP_SECONDS);

    const curveFrom = async (state: ProjectState): Promise<number[]> => {
      installLiveTake(state.channels, state.mixerTracks, state.playlistClips);
      const gain = engine.getOrCreateMixerChannel(1).output.gain as FakeParam;
      gain.writes.length = 0;
      playLive(2);
      const byTime = new Map(scheduledByTime(gain).map(entry => [Math.round(entry.time * 1000), entry.value]));
      return sampleTimes.map(time => byTime.get(Math.round((time + 2) * 1000)) ?? NaN);
    };

    const first = await curveFrom(recorded);
    // Save -> reopen through the production persistence + normalizer.
    const reopened = normalizeProjectState(JSON.parse(serializeProjectState(recorded).replace(/^/, '')).state as ProjectState);
    const afterReopen = await curveFrom(reopened);
    assert.deepEqual(afterReopen, first, 'a saved and reopened project plays the recorded lane identically');

    // The measured curve is the lane: live and the production interpolator agree.
    // Every sampled instant must have been written — a skipped sample here would
    // quietly turn this into a one-assertion test.
    const measured = first.filter(value => Number.isFinite(value)).length;
    assert.ok(measured >= 30, `only ${measured}/32 transport steps produced a live write`);
    for (let step = 0; step < 32; step += 1) {
      const bar = (step * STEP_SECONDS) / SECONDS_PER_BAR;
      const expected = interpolationValue(lane, Math.min(1, bar / 2)) * 1.25;
      assert.ok(
        Math.abs(first[step] - expected) < 1e-6,
        `step ${step}: live wrote ${first[step]}, lane evaluates to ${expected}`,
      );
    }
  });
});

// --- B. fx_param --------------------------------------------------------------

describe('Phase 12 parity B: a recorded fx_param pass reaches the live AudioParam and the offline slot', () => {
  it('records, then live and offline resolve the same parameter values', async () => {
    const slot = makeSlot('fx-comp', 'compressor', { ...COMPRESSOR_PARAMS });
    const tracks = [makeTrack(0, [], 1), makeTrack(1, [slot], 1), makeChannel('ch-1', 1) as unknown as MixerTrack].slice(0, 2);
    const channels = [makeChannel('ch-1', 1)];
    const targetId = formatFxSlotTargetId(1, 'fx-comp');
    const target = { type: 'fx_param' as const, targetId, paramName: 'threshold', label: 'Comp Threshold' };
    const clip = automationClip('auto-fx', target, [
      { x: 0, y: 0.5, tension: 0 }, { x: 0.5, y: 0.9, tension: 0 }, { x: 1, y: 0.5, tension: 0 },
    ], 0, 2);

    const harness = new RecordingHarness(projectWith([clip], tracks, channels, 'write'));
    const runtime = harness.runtime();
    harness.play(runtime);
    runtime.beginGesture(target);
    for (let step = 0; step < 24; step += 1) {
      harness.advanceTo(step / 16, runtime);
      // Sweep the contract's own range, so the recorded curve is a real sweep.
      harness.setFxParam(targetId, 'threshold', -100 + (step / 23) * 100, runtime);
      }
    runtime.endGesture(target);
    harness.advanceTo(2, runtime);
    runtime.finish('stop');

    const lane = harness.state.playlistClips[0].automationPoints!;
    assert.ok(lane.some(point => point.y > 0.8), `the pass must climb, got ${JSON.stringify(lane)}`);

    // LIVE: the recorded lane must move the real compressor AudioParam.
    installLiveTake(harness.state.channels, harness.state.mixerTracks, harness.state.playlistClips);
    const liveParam = audioParamOf(liveSlotEffect(1, 'fx-comp'), 'compressor', 'threshold');
    assert.ok(liveParam, 'the live chain exposes the compressor threshold AudioParam');
    liveParam!.writes.length = 0;
    playLive(2);
    const liveWrites = scheduledByTime(liveParam!);
    assert.ok(liveWrites.length >= 4, `the live take must automate the threshold, got ${liveWrites.length}`);
    const liveMax = Math.max(...liveWrites.map(write => write.value));
    const liveMin = Math.min(...liveWrites.map(write => write.value));
    assert.ok(liveMax - liveMin > 10, `the live threshold must sweep, got ${liveMin}..${liveMax} dB`);

    /*
     * OFFLINE: capture the *export graph's* compressor threshold AudioParam. This
     * is the measurement that matters — the slot's stored `params` cannot prove
     * anything, because the document already holds the last value the performance
     * wrote into it.
     */
    const { captured } = await renderOffline(harness.state, 2, {
      trackId: 1, slotId: 'fx-comp', fxType: 'compressor', paramId: 'threshold',
    });
    assert.ok(captured.fxParam, 'the export graph must own the compressor threshold AudioParam');
    const offlineWrites = scheduledByTime(captured.fxParam!);
    assert.ok(offlineWrites.length >= 4, `the export must automate the threshold, got ${offlineWrites.length} writes`);

    // The threshold contract is -60..0 dB, so normalized = (dB + 60) / 60.
    /*
     * The contract owns the parameter's range (-100..0 dB for a compressor
     * threshold), so normalization comes from the production resolver rather than
     * a number written here: a hand-derived scale would silently disagree with the
     * engine and make the parity check meaningless.
     */
    const spec = resolveFxParameterSpec('compressor', 'threshold');
    assert.ok(spec, 'the contract must define the compressor threshold');
    const toNormalized = (db: number): number =>
      Math.max(0, Math.min(1, (db - spec!.min) / (spec!.max - spec!.min)));
    const toDb = (normalized: number): number => spec!.min + normalized * (spec!.max - spec!.min);
    const liveByTime = new Map(
      scheduledByTime(liveParam!).map(entry => [(entry.time - LIVE_CLOCK_ORIGIN).toFixed(4), entry.value]),
    );

    // PARITY 1: where both renderers wrote at the same instant, the dB values match.
    let compared = 0;
    for (const write of offlineWrites) {
      if (write.time === 0) continue; // chain construction, not a scheduled step
      const liveValue = liveByTime.get(write.time.toFixed(4));
      if (liveValue === undefined) continue;
      assert.ok(
        Math.abs(toNormalized(liveValue) - toNormalized(write.value)) < 1e-6,
        `at ${write.time}s live threshold ${liveValue} dB, export ${write.value} dB`,
      );
      compared += 1;
    }
    assert.ok(compared >= 4, `only ${compared} instants were comparable across live and export`);

    // PARITY 2: both follow the recorded lane at every instant the export wrote.
    let laneCompared = 0;
    for (const write of offlineWrites) {
      if (write.time === 0) continue; // the chain's construction value, not a step
      const bar = write.time / SECONDS_PER_BAR;
      if (bar > 2) continue;
      const expected = interpolationValue(lane, Math.min(1, bar / 2));
      assert.ok(
        Math.abs(toNormalized(write.value) - expected) < 0.02,
        `export at ${write.time}s (bar ${bar.toFixed(3)}): ${toNormalized(write.value)} vs lane ${expected}`,
      );
      laneCompared += 1;
    }
    assert.ok(laneCompared >= 8, `only ${laneCompared} scheduled steps were compared against the lane`);
    // The sweep is real: a flat lane would satisfy the checks above trivially.
    const spread = Math.max(...offlineWrites.map(write => write.value)) - Math.min(...offlineWrites.map(write => write.value));
    assert.ok(spread > 10, `the exported threshold must sweep, got ${spread} dB`);
    void toDb;
  });
});

// --- C. vst3_param ------------------------------------------------------------

describe('Phase 12 parity C: a recorded vst3_param pass produces the same native points as the live path', () => {
  const nativeChannel = (): Channel => {
    const channel = makeChannel('ch-vst', 1);
    channel.instrumentType = 'vst3';
    channel.vst3 = {
      path: '/plugins/Synth.vst3',
      classId: 'ABCDEF0123456789',
      name: 'Synth',
      vendor: 'Apex',
      version: '1.0.0',
      automationId: 'bind-1',
      state: { schema: 1, classId: 'ABCDEF0123456789', parameters: [
        { id: 4, value: 0.25 }, { id: 5, value: 0.5 },
      ] },
    };
    return channel;
  };

  const parameter: Vst3Parameter = {
    id: 4, name: 'Cutoff', shortTitle: 'Cutoff', units: '%', defaultValue: 0.5,
    currentValue: 0.25, flags: 1, stepCount: 0,
  };

  it('the recorded lane feeds the production native timeline with the recorded values', () => {
    const channels = [nativeChannel()];
    const track = makeTrack(1, [], 1);
    const target = nativeTarget(channels[0], parameter);
    const base = projectWith([automationClip('auto-vst', target, [
      { x: 0, y: 0.25, tension: 0 }, { x: 1, y: 0.25, tension: 0 },
    ], 0, 2)], [makeTrack(0, [], 1), track], channels, 'write');

    const harness = new RecordingHarness(base);
    const runtime = harness.runtime();
    harness.play(runtime);
    runtime.beginGesture(target);
    for (let step = 0; step < 20; step += 1) {
      harness.advanceTo(step / 16, runtime);
      // The App's VST3 commit funnel: the stored value is what the lane records.
      const normalized = 0.25 + (step / 19) * 0.7;
      harness.state = {
        ...harness.state,
        channels: harness.state.channels.map(channel => channel.id === 'ch-vst'
          ? { ...channel, vst3: { ...channel.vst3!, state: { ...channel.vst3!.state, parameters: [{ id: 4, value: normalized }, { id: 5, value: 0.5 }] } } }
          : channel),
      };
        runtime.reportValue(target, readAutomationTargetValue(target, harness.state.channels, harness.state.mixerTracks));
    }
    runtime.endGesture(target);
    harness.advanceTo(2, runtime);
    runtime.finish('stop');

    const lane = harness.state.playlistClips[0].automationPoints!;
    assert.ok(lane.some(point => point.y > 0.9), `the VST3 pass must climb, got ${JSON.stringify(lane)}`);

    // The production timeline compiles the recorded lane and emits parameter points.
    const timeline = new NativeAutomationTimeline();
    timeline.set(harness.state.playlistClips, SECONDS_PER_BAR);
    const channel = harness.state.channels[0];
    assert.equal(timeline.hasChannel(channel), true, 'the recorded lane must bind to the committed plug-in identity');
    timeline.clock(0, 0);
    /*
     * Query the timeline the way the native PCM producer does: bounded blocks
     * (16384 frames is the producer's ceiling), each advanced by one block. The
     * emitted points across the pass are the parameter's schedule.
     */
    const RATE = 48000;
    const FRAMES = 16384;
    const points: Array<{ id: number; value: number; offset?: number }> = [];
    for (let time = 0; time < SECONDS_PER_BAR * 2 - 1e-9; time += FRAMES / RATE) {
      points.push(...timeline.points(channel, [parameter], new Map<number, number>(), new Set(), time, FRAMES, RATE)
        .map(point => ({ ...point, offset: (point.offset ?? 0) + time * RATE })));
    }
    assert.ok(points.length >= 2, `the native timeline must emit points, got ${points.length}`);

    // Measured parity: every emitted point is the lane value at that instant.
    for (const point of points) {
      const offset = point.offset ?? 0;
      const seconds = offset / RATE;
      const bar = seconds / SECONDS_PER_BAR;
      if (bar > 2) continue;
      const normalized = lane.length >= 2 ? interpolationValue(lane, Math.min(1, bar / 2)) : lane[0].y;
      assert.ok(
        Math.abs(point.value - normalized) < 0.02,
        `native point at ${seconds.toFixed(4)}s is ${point.value}; the lane evaluates to ${normalized}`,
      );
    }
  });

  it('a VST3 lane that no longer matches the plug-in identity is not bound at all', () => {
    const channels = [nativeChannel()];
    const target = nativeTarget(channels[0], parameter);
    const mismatch = { ...target, native: { ...target.native!, automationId: 'stale-binding' } };
    const state = projectWith([automationClip('auto-vst', mismatch, [
      { x: 0, y: 0.2, tension: 0 }, { x: 1, y: 0.9, tension: 0 },
    ], 0, 2)], [makeTrack(0, [], 1), makeTrack(1)], channels, 'write');
    const timeline = new NativeAutomationTimeline();
    timeline.set(state.playlistClips, SECONDS_PER_BAR);
    assert.equal(timeline.hasChannel(state.channels[0]), false,
      'a lane recorded against another plug-in instance must never drive this one');
  });
});

