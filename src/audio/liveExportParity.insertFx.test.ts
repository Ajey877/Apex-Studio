/**
 * Live ↔ export parity — a deterministic instrument with a delay insert.
 *
 * The same project state (one minisynth channel on mixer track 1 with one
 * feedback-delay insert on that track) is rendered two ways:
 *
 *   • LIVE — a fresh `OfflineAudioContext` is wired the way the live engine
 *     wires itself (`updateMixerTrack` / `syncMixerRouting`) and the transport's
 *     per-step entry point `triggerCurrentStep` is driven step by step.
 *   • EXPORT — the production `renderTimelineOffline`.
 *
 * Both paths build the delay through `rebuildTrackFxChain` → `createEffect`,
 * so this suite guards the per-path state and scheduling around that shared
 * factory (bpm, mixer routing, mastering processor, step grid, FX registry),
 * not the delay DSP itself.
 *
 * ── Fidelity limits (read before relying on this suite) ───────────────────
 * - NOT REALTIME. The live reference is a non-realtime simulation on an
 *   `OfflineAudioContext`. It does not exercise the transport clock, the
 *   `onStep` scheduler, or a realtime `AudioContext`, so it proves nothing
 *   about hardware real-time parity.
 * - web-audio-engine is a pure-JS Web Audio polyfill, not a browser. Its
 *   `ConvolverNode` is a pass-through (`lib/impl/dsp/ConvolverNode.js` copies
 *   its input to its output), so reverb cannot be validated here. Reverb is
 *   covered by `browser-tests/liveExportReverbEnvelope.spec.ts` in real Chromium.
 * - Mastering is disabled on both paths. The `MasteringProcessor` is still
 *   constructed on both paths, as production does; only its DSP is bypassed.
 *
 * ── Tolerance ─────────────────────────────────────────────────────────────
 * PARITY_TOLERANCE = 1e-6 (≈ −120 dBFS). The bound is not a claim of sample
 * identity across paths; it only leaves room for float32 summation-order
 * differences. Measured on this harness: live vs export and live vs live are
 * bit-identical once both paths carry the same bpm. A bpm mismatch between
 * the paths (a live reference that had not set `bpm`, found during development)
 * gave max |Δ| 1.1e-4, and a halved export bpm (scratch mutation M3) gave
 * 8.2e-5. Both are above the bound, so the bound catches this class of drift.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as RealWebAudio from 'web-audio-engine';
import type { Channel, FxSlot, MixerTrack, PlaylistClip } from '../types/daw';
import { audioEngine } from './audioEngine';
import { DEFAULT_MASTERING_SUITE_STATE } from './masteringState';
import { MasteringProcessor } from './masteringProcessor';

const RealOfflineAudioContext = (RealWebAudio as unknown as {
  OfflineAudioContext: typeof OfflineAudioContext;
}).OfflineAudioContext;

type EngineInternals = Record<string, any>;
const engine = audioEngine as unknown as EngineInternals;

const SAMPLE_RATE = 44100;
const BPM = 120;
const BARS = 2;
const DURATION_SECONDS = 4; // the export's minimum duration for a two-bar render
const FRAMES = Math.ceil(SAMPLE_RATE * DURATION_SECONDS);
const SECONDS_PER_STEP = 60 / BPM / 4;
const TOTAL_STEPS = Math.ceil(DURATION_SECONDS / SECONDS_PER_STEP);
const PARITY_TOLERANCE = 1e-6;
const AUDIBLE_FLOOR = 0.01;
const INSERT_EFFECT_FLOOR = 0.05;

const DELAY_SLOT: FxSlot = {
  id: 'fx-delay',
  type: 'delay',
  name: 'Delay',
  enabled: true,
  mix: 0.5,
  params: { time: 0.25, feedback: 0.3 },
};

const masterTrack = (): MixerTrack => ({
  id: 0,
  name: 'Master',
  color: '#3b82f6',
  volume: 1,
  pan: 0,
  mute: false,
  solo: false,
  fxSlots: [],
  peakL: 0,
  peakR: 0,
}) as MixerTrack;

const channelTrack = (fxSlots: FxSlot[]): MixerTrack => ({
  id: 1,
  name: 'Ch1',
  color: '#10b981',
  volume: 1,
  pan: 0,
  mute: false,
  solo: false,
  fxSlots,
  peakL: 0,
  peakR: 0,
}) as MixerTrack;

const makeChannel = (): Channel => ({
  id: 'ch',
  name: 'Synth',
  color: '#10b981',
  instrumentType: 'minisynth',
  mixerTrackId: 1,
  volume: 0.9,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: Array(16).fill(false),
  notes: [{ id: 'n', pitch: 60, start: 0, duration: 4, velocity: 0.9 }],
  synthParams: engine.getDefaultSynthParams(),
}) as unknown as Channel;

const makeClip = (): PlaylistClip => ({
  id: 'c',
  trackIndex: 0,
  startBar: 0,
  lengthBars: BARS,
  type: 'pattern',
  channelId: 'ch',
  color: '#10b981',
  name: 'C',
}) as unknown as PlaylistClip;

const maxAbs = (d: Float32Array): number => d.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

const maxAbsDiff = (a: Float32Array, b: Float32Array): number => {
  assert.equal(a.length, b.length, `render lengths differ (${a.length} vs ${b.length})`);
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
};

/**
 * Put the engine into the same state `renderTimelineOffline` leaves it in
 * before it schedules, except for the offline flags. Every field here was
 * checked against the export's setup block: omitting one (e.g. `bpm`) changes
 * the rendered note gate, so this list must track that block.
 */
const primeLiveEngine = (ctx: BaseAudioContext, mixerTracks: MixerTrack[], clips: PlaylistClip[]): void => {
  engine.ctx = ctx;
  engine.liveCtx = ctx;
  engine.isOfflineRendering = false;
  engine.offlineRenderLeaseHeld = false;
  engine.offlineRenderOperationDepth = 0;
  engine.masterGain = ctx.createGain();
  engine.grossBeatNode = ctx.createGain();
  engine.masterAnalyser = ctx.createAnalyser();
  engine.masterAnalyser.fftSize = 512;
  engine.masterAnalyser.smoothingTimeConstant = 0.8;
  engine.masteringProcessor = new MasteringProcessor(ctx as unknown as AudioContext, engine.masteringState);
  engine.masterGain.connect(engine.grossBeatNode);
  engine.grossBeatNode.connect(engine.masteringProcessor.input);
  engine.masteringProcessor.output.connect(engine.masterAnalyser);
  engine.masterAnalyser.connect(ctx.destination);
  engine.mixerChannels = new Map();
  engine.channelPanners = new Map();
  engine.mixerRoutingAdapter = null;
  engine.mixerRoutingChannelMap = null;
  engine.impulseResponses = new Map();
  engine.__fxSlotEffectMaps = new Map();
  engine.activeVoices = new Map();
  engine.activeVoiceChannelVolumes = new Map();
  engine.activeDrumPadVoices = new Map();
  engine.activeClipSources = new Set();
  engine.activeClipSourceLanes = new Map();
  engine.activeClipSourceChannels = new Map();
  engine.activeClipChannelVolumes = new Map();
  engine.activeChannels = structuredClone([makeChannel()]);
  engine.activeClips = structuredClone(clips);
  engine.refreshInaudibleTakeClipIds();
  engine.playbackProjectChannels = structuredClone([makeChannel()]);
  engine.playbackProjectMixerTracks = structuredClone(mixerTracks);
  engine.activeMixerTracks = structuredClone(mixerTracks);
  engine.activePlayMode = 'song';
  engine.activePatternId = undefined;
  engine.activePatternLengthSteps = undefined;
  engine.playlistLaneMutes = new Set();
  engine.isPlaying = true;
  engine.currentStep = 0;
  engine.currentBar = 1;
  engine.bpm = BPM;
  engine.metronome = false;
};

/** LIVE reference: build the chain the live way, then drive the transport's per-step entry point. */
const renderLive = async (mixerTracks: MixerTrack[]): Promise<Float32Array> => {
  const ctx = new RealOfflineAudioContext(2, FRAMES, SAMPLE_RATE);
  const clips = [makeClip()];
  primeLiveEngine(ctx, mixerTracks, clips);
  engine.updateMixerTrack(mixerTracks.find(track => track.id === 0));
  for (const track of mixerTracks) if (track.id !== 0) engine.updateMixerTrack(track);
  engine.syncMixerRouting(mixerTracks);
  for (let globalStep = 0; globalStep < TOTAL_STEPS; globalStep += 1) {
    engine.currentStep = globalStep % engine.currentStepsPerBar;
    engine.currentBar = Math.floor(globalStep / engine.currentStepsPerBar) + 1;
    engine.triggerCurrentStep(globalStep * SECONDS_PER_STEP);
  }
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
};

/** EXPORT: the production offline path. */
const renderExport = async (mixerTracks: MixerTrack[], includeMixerFx: boolean): Promise<Float32Array> => {
  const rendered: AudioBuffer = await engine.renderTimelineOffline(
    [makeChannel()],
    [makeClip()],
    mixerTracks,
    BPM,
    BARS,
    SAMPLE_RATE,
    includeMixerFx,
    'song',
    undefined,
    undefined,
    // DURATION_SECONDS is the export's pinned minimum-duration floor (12th
    // parameter). It historically landed one slot earlier, back when the
    // signature had no `playlistTracks`; since Phase 10A that slot feeds
    // derivePlaylistLaneMutes and the duration floor silently fell back to its
    // default — which only matched by coincidence (floor 4 s == this window).
    // Phase 6C made the distinction observable: a Song-master export without
    // an explicit floor now renders the decay tail past the song end, while a
    // pinned floor keeps the exact measurement window this parity comparison
    // requires (the live reference renders exactly FRAMES frames). Restoring
    // the documented intent; no assertion changes.
    undefined,
    DURATION_SECONDS,
  );
  return rendered.getChannelData(0).slice();
};

describe('LIVE/EXPORT PARITY: deterministic instrument + delay insert', () => {
  const savedGlobals: Record<string, unknown> = {};

  before(() => {
    for (const key of ['OfflineAudioContext', 'webkitOfflineAudioContext'] as const) {
      savedGlobals[key] = (globalThis as Record<string, unknown>)[key];
      (globalThis as Record<string, unknown>)[key] = RealOfflineAudioContext;
    }
    engine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
  });

  after(() => {
    for (const key of Object.keys(savedGlobals)) {
      (globalThis as Record<string, unknown>)[key] = savedGlobals[key];
    }
  });

  it('the delay insert is audible on both paths (guards against a vacuous parity pass)', async () => {
    const withDelay = [masterTrack(), channelTrack([DELAY_SLOT])];
    const withoutDelay = [masterTrack(), channelTrack([])];

    const liveWet = await renderLive(withDelay);
    const liveDry = await renderLive(withoutDelay);
    const exportWet = await renderExport(withDelay, true);
    const exportDry = await renderExport(withoutDelay, true);

    assert.ok(maxAbs(liveWet) > AUDIBLE_FLOOR, `live render must be audible (peak ${maxAbs(liveWet).toFixed(4)})`);
    assert.ok(maxAbs(exportWet) > AUDIBLE_FLOOR, `export render must be audible (peak ${maxAbs(exportWet).toFixed(4)})`);
    assert.ok(maxAbsDiff(liveWet, liveDry) > INSERT_EFFECT_FLOOR,
      `the live delay insert must change the signal (max Δ ${maxAbsDiff(liveWet, liveDry).toFixed(4)})`);
    assert.ok(maxAbsDiff(exportWet, exportDry) > INSERT_EFFECT_FLOOR,
      `the export delay insert must change the signal (max Δ ${maxAbsDiff(exportWet, exportDry).toFixed(4)})`);
  });

  it('live and export render the delay insert within the parity tolerance', async () => {
    const mixerTracks = [masterTrack(), channelTrack([DELAY_SLOT])];
    const live = await renderLive(mixerTracks);
    const exported = await renderExport(mixerTracks, true);

    const diff = maxAbsDiff(live, exported);
    assert.ok(diff <= PARITY_TOLERANCE,
      `live vs export max |Δ| ${diff} exceeds ${PARITY_TOLERANCE}`);
  });

  it('each path is repeatable, so the parity tolerance is not masking run-to-run noise', async () => {
    const mixerTracks = [masterTrack(), channelTrack([DELAY_SLOT])];
    const liveA = await renderLive(mixerTracks);
    const liveB = await renderLive(mixerTracks);
    const exportA = await renderExport(mixerTracks, true);
    const exportB = await renderExport(mixerTracks, true);

    assert.ok(maxAbsDiff(liveA, liveB) <= PARITY_TOLERANCE, 'live repeat must match within tolerance');
    assert.ok(maxAbsDiff(exportA, exportB) <= PARITY_TOLERANCE, 'export repeat must match within tolerance');
  });
});
