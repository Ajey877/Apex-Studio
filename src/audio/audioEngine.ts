import { beatsPerBar, stepsPerBar, stepsToBeats, beatsToSeconds, SIXTEENTH_STEPS_PER_BEAT, LEGACY_TIME_SIGNATURE, resolveProjectTimeSignature, type TimeSignature } from '../music/musicalTime';
import { DEFAULT_SEVEN_EIGHT_GROUPING, isSevenEightGrouping, resolveMeterPulseLayout, resolveMetronomeClickLevel, type MeterPulseLayout, type SevenEightGrouping } from '../music/meterPulse';
import { captureBarNumbers, planCountInCapturePosition, resolveCountInBars, type CountInBars } from '../music/countIn';
import { CountInCancelledError, CountInScheduler, type CountInClickHandle, type CountInResult } from './countInScheduler';
import { DEFAULT_PUNCH_RECORDING, planPunchCapture, resolvePunchRecording, type PunchCapturePlan, type PunchRecordingSettings } from '../music/punchRecording';
import { PunchCancelledError, PunchCaptureWindow, type PunchWindowResult } from './punchCaptureWindow';
import { scheduleMetronomeClick } from './metronomeClick';
import { arpStepSeconds, resolveArpNoteDurationSteps, resolveArpRateSteps } from './noteGate';
import { resolveInaudibleTakeClipIds } from './takeLaneManager';

import { 
  Channel, 
  Note, 
  MixerTrack, 
  FxSlot, 
  PlaylistClip, 
  PlaylistTrack,
  SynthParameters,
  AudioRecording,
  GrossBeatState,
  MasteringSuiteState,
  SidechainSettings
} from '../types/daw';
import { AudioClockTransport, TransportState } from './transport';
import {
  GROSS_BEAT_OPEN_GAIN,
  grossBeatAlternatingSteps,
  resolveGrossBeatGateGain,
} from './grossBeatGate';
import { LoudnessMeter } from './loudnessMeasurement';
import { TruePeakMeter } from './truePeak';
import { StereoFieldMeter, computeMidSideVectors } from './stereoMeasurement';
import { createMeasurementWindowPlanner, MeasurementWindowPlanner } from './masterMeasurementStream';
import { DEFAULT_MASTERING_SUITE_STATE, normalizeMasteringSuiteState } from './masteringState';
import { MasteringProcessor } from './masteringProcessor';
import type { AudioLatencyMetrics, MasterMeasurementSnapshot } from '../types/daw';
import { ChorusEffect } from './effects/ChorusEffect';
import { WetDryEffect } from './effects/WetDryEffect';
import { createInstrumentRegistry, InstrumentRegistry, InstrumentVoiceHandle } from './instrumentRegistry';
import { MixerRoutingAdapter } from './mixerRoutingAdapter';
import { buildDryStemMixerTracks, buildWetStemMixerTracks, getDirectAuxSendSourceIds, getUpstreamMixerTrackIds } from './auxStemRouting';
import { renderIndependentPluckVoice } from './instruments/independentPluck';
import { renderSubtractiveSynthVoice } from './instruments/subtractiveSynth';
import { renderFmSynthVoice } from './instruments/fmSynth';
import { renderSamplerVoice } from './instruments/sampler';
import { renderDrumPadVoice } from './instruments/drumPad';
import { renderGrandPianoVoice, renderRhodesVoice, renderOrganVoice, renderPluckedGuitarVoice, renderStringsVoice, renderPizzicatoVoice, renderBrassVoice, renderMarimbaVoice } from './instruments/legacyAcoustic';
import { renderAcid303Voice, renderReeseBassVoice, render808SubVoice, renderSupersawVoice, renderAmbientPadVoice, renderVoxChoirVoice, renderChiptuneVoice } from './instruments/legacySynth';
import {
  channelVolumeFromNormalized,
  clampProjectSwing,
  filterCutoffFromNormalized,
  filterResonanceFromNormalized,
  fxMixFromNormalized,
  masterOutputGainFromNormalized,
  mixerVolumeFromNormalized,
  panFromNormalized,
  pitchFromNormalized,
  swingOffsetSecondsForStep,
  arpStrumSecondsForVoice
} from './parameterScaling';
import { isRackChannelAudible } from './midiMappingRuntime';
import { derivePlaylistLaneMutes, isClipLaneMuted } from './playlistLaneMutes';
import { isFxParamLiveUpdatableByName } from './fxLiveSync';
import {
  fxTargetIdBelongsToTrack,
  resolveFxParameterUpdate,
  resolveFxSlot,
} from './fxParameterControl';
import { resolveFxParameterSpec } from './fxParameterContract';

// Phase 1F: the legacy 4/4 grid (LEGACY_TIME_SIGNATURE) remains the DEFAULT
// for the pure resolvers below — missing/unsupported project meters must keep
// the historic behaviour. Runtime paths that know the project meter pass it
// explicitly, and the engine instance uses its resolved `this.meter` bar size.
// There is deliberately no fixed STEPS_PER_BAR runtime constant any more.

/** True when the meter is the legacy 4/4 grid. */
const isLegacyMeter = (meter: TimeSignature): boolean => meter[0] === 4 && meter[1] === 4;

export { isRackChannelAudible };

export type MidiEventPayload = {
  type: 'noteOn' | 'noteOff' | 'cc' | 'pitchBend';
  note?: number;
  velocity?: number;
  cc?: number;
  value?: number;
  midiChannel?: number;
};

export interface InternalMidiMessageEvent {
  data: Uint8Array | number[];
}

interface WindowWithWebKitAudio extends Window {
  OfflineAudioContext?: typeof OfflineAudioContext;
  webkitAudioContext?: typeof AudioContext;
  webkitOfflineAudioContext?: typeof OfflineAudioContext;
}

interface ChainedAudioNode extends AudioNode {
  _chainEnd?: AudioNode;
}

function setChainEnd<T extends AudioNode>(node: T, chainEnd: AudioNode): T {
  (node as ChainedAudioNode)._chainEnd = chainEnd;
  return node;
}

function getChainEnd(node: AudioNode): AudioNode {
  return (node as ChainedAudioNode)._chainEnd ?? node;
}

export type OfflineRenderScope = 'song' | 'pattern';
export type OfflineRenderProgress = (progress: number, status: string) => void;

/**
 * Project-owned data that the live scheduler is allowed to receive while a
 * playback take is running. The engine deliberately does not accept the
 * complete React state object: these are the only collections consumed by
 * real-time playback and each is cloned at the synchronization boundary.
 */
export interface PlaybackStateUpdate {
  channels?: Channel[];
  clips?: PlaylistClip[];
  mixerTracks?: MixerTrack[];
  /**
   * Playlist lane rows whose `mute` flag belongs to the live take. A muted lane
   * silences the pattern and audio clips placed on it without touching the
   * mixer insert they route to, so lanes sharing an insert stay independent.
   */
  playlistTracks?: PlaylistTrack[];
  /**
   * Declared `Pattern.lengthSteps` of the pattern Pattern Mode is playing. It is
   * project state like the collections above, so a 16 <-> 32 length change made
   * while the transport runs moves the loop boundary of the active take instead
   * of waiting for a restart. Song Mode ignores it (bar-grid scheduling).
   */
  patternLengthSteps?: number;
}

export interface MixerChannel {
  input: GainNode;
  output: GainNode;
  duckingGain: GainNode;
  panner: StereoPannerNode | GainNode;
  analyser: AnalyserNode;
  fxNodes: AudioNode[];
  sidechain?: SidechainSettings;
  /**
   * Phase 64 — the post-fader metering tap, declared so `MixerRoutingAdapter`
   * can re-attach it after a routing rebuild clears the output's edges.
   * `analyser` is the tap; it is never part of the audible signal path.
   */
  meterTap?: AudioNode;
  /**
   * Phase 88 — per-source post-fader aux send gains. Each entry is
   * `output -> GainNode(amount) -> target.input`. Stored on the source
   * channel so `disconnectOutputs` / `syncAuxSends` can recreate the edge
   * after a bus rebuild without leaking. The map key is the target track id.
   */
  auxSendGains?: Map<number, GainNode>;
}

export interface ChannelPannerEntry {
  panner: StereoPannerNode | GainNode;
  mixerTrackId: number;
  destination: AudioNode;
  pan: number;
}

const isPlaybackRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Playback automation mutates the isolated active channel/mixer objects. To
 * merge a project edit without erasing those transient values, compare the
 * incoming project value with the last project value received by playback:
 * unchanged project fields keep their active value, while changed fields are
 * copied in. This keeps project edits authoritative without ever sharing a
 * project object with the renderer.
 */
const playbackValuesEqual = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => playbackValuesEqual(value, right[index]));
  }
  if (isPlaybackRecord(left) || isPlaybackRecord(right)) {
    if (!isPlaybackRecord(left) || !isPlaybackRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && playbackValuesEqual(left[key], right[key]));
  }
  return false;
};

/**
 * Phase 10B + Phase 80: a per-track edit where the only fields that changed
 * are a subset of `slot.mix` and `slot.params` values for previously-known,
 * enabled slots. Used during a live take to skip the full FX chain rebuild
 * and route the new values directly to the live AudioEffect's AudioParams.
 *
 * A `params` change is live-routable ONLY when the change is finite numeric
 * and the AudioEffect's setParameter contract accepts the name; the
 * live-bridge registry silently refuses anything else. Any structural
 * change (new slot, removed slot, enabled/disabled change, type change,
 * name change) returns `false` so the safe fall-back (a full rebuild via
 * `updateMixerTrack`) handles it instead.
 */
interface TrackLiveFxDiff {
  onlyLiveUpdatableChanged: boolean;
  mixChanges: Array<{ slotId: string; mix: number }>;
  /**
   * Each entry is a single AudioParam that the live AudioEffect accepts
   * for the named slot — i.e. the value was finite and the AudioParam
   * name maps to a real contract entry. The live-bridge path consumes
   * these; values that the bridge refuses are dropped (the project
   * state is still authoritative for the next chain rebuild).
   */
  paramChanges: Array<{ slotId: string; paramName: string; value: number }>;
}

function trackLiveUpdatableChanged(previous: MixerTrack, next: MixerTrack): TrackLiveFxDiff {
  const mixChanges: Array<{ slotId: string; mix: number }> = [];
  const paramChanges: Array<{ slotId: string; paramName: string; value: number }> = [];
  if (previous.id !== next.id) return { onlyLiveUpdatableChanged: false, mixChanges, paramChanges };
  if (previous.fxSlots.length !== next.fxSlots.length) return { onlyLiveUpdatableChanged: false, mixChanges, paramChanges };
  const previousById = new Map(previous.fxSlots.map(slot => [slot.id, slot]));
  for (const nextSlot of next.fxSlots) {
    const prevSlot = previousById.get(nextSlot.id);
    if (!prevSlot) return { onlyLiveUpdatableChanged: false, mixChanges, paramChanges };
    if (prevSlot.type !== nextSlot.type) return { onlyLiveUpdatableChanged: false, mixChanges, paramChanges };
    if (prevSlot.enabled !== nextSlot.enabled) return { onlyLiveUpdatableChanged: false, mixChanges, paramChanges };
    // Detect changed params (numeric only — string/boolean params are
    // not in the live contract).
    const prevParams = (prevSlot.params ?? {}) as Record<string, unknown>;
    const nextParams = (nextSlot.params ?? {}) as Record<string, unknown>;
    const allKeys = new Set<string>([...Object.keys(prevParams), ...Object.keys(nextParams)]);
    for (const key of allKeys) {
      const prevValue = prevParams[key];
      const nextValue = nextParams[key];
      if (playbackValuesEqual(prevValue, nextValue)) continue;
      // Phase 80: only the AudioParam-updatable families accept live
      // param edits. The contract registry (FX_PARAMETER_FAMILIES) is
      // the source of truth; we import it dynamically to avoid the
      // module-load cycle between fxParameterContract and audioEngine.
      const liveUpdatable = isFxParamLiveUpdatableByName(nextSlot.type, key);
      if (!liveUpdatable) return { onlyLiveUpdatableChanged: false, mixChanges, paramChanges };
      if (typeof nextValue !== 'number' || !Number.isFinite(nextValue)) continue;
      paramChanges.push({ slotId: nextSlot.id, paramName: key, value: nextValue });
    }
    if (prevSlot.mix !== nextSlot.mix) {
      mixChanges.push({ slotId: nextSlot.id, mix: nextSlot.mix });
    }
  }
  const topLevelKeys: ReadonlyArray<keyof MixerTrack> = ['name', 'color', 'volume', 'pan', 'mute', 'solo', 'peakL', 'peakR', 'sidechain', 'routingTargetId', 'sends', 'auxSends', 'isAux'];
  const optionalKeys = ['height', 'armedForRecord'];
  for (const key of optionalKeys) {
    if (!playbackValuesEqual((previous as any)[key], (next as any)[key])) {
      return { onlyLiveUpdatableChanged: false, mixChanges, paramChanges };
    }
  }
  for (const key of topLevelKeys) {
    if (!playbackValuesEqual((previous as any)[key], (next as any)[key])) {
      return { onlyLiveUpdatableChanged: false, mixChanges, paramChanges };
    }
  }
  return {
    onlyLiveUpdatableChanged: mixChanges.length > 0 || paramChanges.length > 0,
    mixChanges,
    paramChanges,
  };
}

const mergePlaybackProjectEdits = (
  activeValue: unknown,
  previousProjectValue: unknown,
  nextProjectValue: unknown
): unknown => {
  if (playbackValuesEqual(nextProjectValue, previousProjectValue)) return activeValue;

  if (isPlaybackRecord(activeValue) && isPlaybackRecord(previousProjectValue) && isPlaybackRecord(nextProjectValue)) {
    const merged = structuredClone(activeValue) as Record<string, unknown>;
    const keys = new Set([...Object.keys(previousProjectValue), ...Object.keys(nextProjectValue)]);

    for (const key of keys) {
      const hadPreviousValue = Object.prototype.hasOwnProperty.call(previousProjectValue, key);
      const hasNextValue = Object.prototype.hasOwnProperty.call(nextProjectValue, key);
      if (!hasNextValue) {
        if (hadPreviousValue) delete merged[key];
        continue;
      }
      if (!hadPreviousValue) {
        merged[key] = structuredClone(nextProjectValue[key]);
        continue;
      }
      if (playbackValuesEqual(nextProjectValue[key], previousProjectValue[key])) continue;

      merged[key] = mergePlaybackProjectEdits(
        activeValue[key],
        previousProjectValue[key],
        nextProjectValue[key]
      );
    }
    return merged;
  }

  return structuredClone(nextProjectValue);
};

/**
 * Deterministic PRNG used by the offline reverb-impulse generator.
 *
 * `Math.random()` is non-seeded, so an offline convolution reverb would produce
 * a different tail on every export and the regression suite could not detect a
 * DSP regression from a sample mismatch. A small linear congruential generator
 * is sufficient for an impulse response: only amplitude distribution matters,
 * and any reproducible noise source with reasonable autocorrelation works.
 */
function createSeededRandom(seed: number): () => number {
  // Park-Miller LCG constants: a well-known deterministic 31-bit PRNG.
  const a = 16807;
  const m = 2147483647;
  let state = Math.abs(Math.floor(seed)) % m;
  if (state === 0) state = 1;
  return () => {
    state = (a * state) % m;
    return (state - 1) / (m - 1);
  };
}

/**
 * The musical extent of a channel's content: the furthest **onset** position
 * (not end position), rounded up to whole bars of the supplied meter.
 *
 * NOTE TAILS MUST NOT CHANGE MUSICAL LOOP/PATTERN EXTENT.  A note starting at
 * 15.75 with duration 1 (ending at 16.75) does not push a 16-step content
 * extent to 32.  The note's gate/tail still sounds at its onset and plays for
 * its legitimate duration, but the loop boundary remains determined by onset
 * positions and the step array alone.
 *
 * `patternLengthSteps` overrides content when supplied (Pattern mode uses the
 * declared pattern length; Song mode / bounce leave it undefined).
 *
 * Phase 1F/1I: `meter` sets the bar size the extent rounds up to — 16 steps
 * for the default legacy 4/4, 12 for 3/4 or mechanical 6/8, and 14 for 7/8.
 * A DECLARED pattern length in a non-legacy meter is kept as an absolute step
 * quantity (never re-rounded onto the new bar grid), because `Pattern.lengthSteps`
 * must not be silently reinterpreted when the meter changes.
 */
export function resolvePlayableContentLengthSteps(
  channel?: Channel,
  patternLengthSteps?: number,
  meter: TimeSignature = LEGACY_TIME_SIGNATURE
): number {
  const barSteps = stepsPerBar(meter);
  const declared = typeof patternLengthSteps === 'number' && Number.isFinite(patternLengthSteps) && patternLengthSteps > 0;
  if (!channel) {
    if (!declared) return barSteps;
    // Legacy 4/4 keeps its historic whole-bar rounding; other supported meters
    // treat the declared length as absolute steps.
    return isLegacyMeter(meter)
      ? Math.max(1, Math.ceil(patternLengthSteps / barSteps)) * barSteps
      : Math.max(1, Math.ceil(patternLengthSteps));
  }

  if (declared && !isLegacyMeter(meter)) {
    // The declared pattern length is authoritative and absolute; channel data
    // beyond it is ignored exactly the way legacy Pattern mode ignores it.
    return Math.max(1, Math.ceil(patternLengthSteps));
  }

  let maxStep = 0;

  if (declared) {
    maxStep = Math.max(maxStep, patternLengthSteps);
  }

  if (Array.isArray(channel.steps) && channel.steps.length > 0) {
    maxStep = Math.max(maxStep, channel.steps.length);
  }

  // Onset positions only — note tails must not expand the loop extent.
  if (Array.isArray(channel.notes) && channel.notes.length > 0) {
    for (const note of channel.notes) {
      if (typeof note.start === 'number' && Number.isFinite(note.start) && note.start >= 0) {
        maxStep = Math.max(maxStep, note.start);
      }
    }
  }

  const bars = Math.max(1, Math.ceil(maxStep / barSteps));
  return bars * barSteps;
}

/**
 * Pattern Mode loops over the declared length of the pattern that is playing.
 *
 * `Pattern.lengthSteps` is authoritative when supplied: channel data may be
 * longer because reducing a pattern length intentionally preserves hidden steps
 * and piano-roll notes, but those events are ignored until the declared length
 * is extended again. This gives an exact 0..15 -> 0 or 0..31 -> 0 boundary and
 * prevents a padded `Channel.steps` array from silently overriding the pattern.
 *
 * The content-derived branch is the compatibility fallback for legacy/internal
 * callers that do not have a Pattern model. Content extent uses **onset**
 * positions only — note tails must not expand the loop (Phase 1E invariant).
 *
 * Song Mode clip repetition and bounce both use `resolvePlayableContentLengthSteps`
 * directly, which applies the same onset-only rule.
 */
export function resolvePatternLoopLengthSteps(
  channels: Channel[],
  patternLengthSteps?: number,
  meter: TimeSignature = LEGACY_TIME_SIGNATURE
): number {
  if (typeof patternLengthSteps === 'number' && Number.isFinite(patternLengthSteps) && patternLengthSteps > 0) {
    return resolvePlayableContentLengthSteps(undefined, patternLengthSteps, meter);
  }

  let loopLengthSteps = resolvePlayableContentLengthSteps(undefined, undefined, meter);
  for (const channel of channels) {
    loopLengthSteps = Math.max(loopLengthSteps, resolvePlayableContentLengthSteps(channel, undefined, meter));
  }
  return loopLengthSteps;
}

/**
 * Fractional `Note.start` onsets are real project data: Piano Roll chord
 * stamping writes a per-note strum offset in fractional steps, "Strum Chords"
 * writes `step + idx * 0.04`, and MIDI import quantises to quarter steps. The
 * scheduler fires one event per step boundary, so an onset belongs to the
 * boundary at or before it and its fractional remainder is a displacement from
 * that boundary — `4.25` sounds a quarter of a step after the step-4 boundary.
 *
 * Returns the displacement in steps for an onset that belongs to `currentStep`,
 * or `null` when the onset does not belong to this step at all (it is earlier,
 * later, or unusable). Integer onsets therefore resolve to a displacement of
 * exactly `0`, which keeps their historic timing byte-identical, and an onset
 * can only ever belong to one step, so it cannot be triggered twice.
 */
export function noteOnsetOffsetSteps(start: unknown, currentStep: number): number | null {
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) return null;
  const offsetSteps = start - currentStep;
  return offsetSteps >= 0 && offsetSteps < 1 ? offsetSteps : null;
}

/**
 * Phase 1K — what a finished count-in promises the recorder.
 *
 * `captureTime` is the audio-clock moment `MediaRecorder` must start at;
 * `captureBar`/`clipStartBar` are the musical position that moment corresponds
 * to, so the take can be placed on the playlist at the exact bar recording
 * began on. Cancelling the count-in rejects with `CountInCancelledError` and
 * no capture must happen at all — that is what keeps count-in clicks (and any
 * pre-roll) out of the recorded take.
 */
export interface RecordingCountInResult extends CountInResult {
  readonly bars: CountInBars;
  /** 1-based transport bar where capture begins. */
  readonly captureBar: number;
  /** 0-based playlist `startBar` the recorded clip must be placed at. */
  readonly clipStartBar: number;
}

export { CountInCancelledError, PunchCancelledError };

/**
 * Phase 1L — one armed punch take.
 *
 * The engine runs the SAME count-in scheduler Phase 1K introduced, but plans it
 * backwards from the punch-in: the pre-roll occupies the bars immediately
 * before punch-in, so the count-in's capture moment IS the punch-in and no
 * pre-roll audio can enter the take. `phase` distinguishes the two halves of
 * the take because their cancellation rules differ — a stop or a seek kills
 * either, while the arrangement running out only kills a take that has not
 * started capturing yet (an armed window already ends at the project end).
 */
export interface PunchRecordingSession {
  /** The musical window that was armed, including the project-end rule. */
  readonly plan: PunchCapturePlan;
  /** Audio-clock moment capture began (the punch-in moment). */
  readonly captureTime: number;
  /**
   * Resolves exactly when capture must stop (punch-out) and rejects with
   * `PunchCancelledError` when the take is aborted. The caller owns the
   * recorder: it starts `RecordingEngine` after the session resolves and stops
   * it when `punchOut` resolves.
   */
  readonly punchOut: Promise<PunchWindowResult>;
}

class AudioEngine {
  public isOfflineRendering = false;
  private offlineRenderLeaseHeld = false;
  private offlineRenderCompleteCallback: (() => void) | null = null;
  private offlineRenderOperationDepth = 0;
  private liveSampleBuffersDuringOfflineRender: Map<string, AudioBuffer> | null = null;
  private liveProjectSampleBufferIdsDuringOfflineRender: Set<string> | null = null;
  private liveSessionSampleBufferIdsDuringOfflineRender: Set<string> | null = null;
  private liveCtx: AudioContext | null = null;
  private ctx: AudioContext | null = null;
  private transport: AudioClockTransport | null = null;
  private playbackGeneration = 0;
  private masterGain: GainNode | null = null;
  private masteringProcessor: MasteringProcessor | null = null;
  private masteringState: MasteringSuiteState = structuredClone(DEFAULT_MASTERING_SUITE_STATE);
  private masterAnalyser: AnalyserNode | null = null;
  private grossBeatNode: GainNode | null = null;
  /**
   * Phase 45 master metering tap. `masterAnalyser` above stays exactly where
   * it was (it down-mixes to mono, which is fine for the spectrum the mixer
   * already reads); the splitter below is what makes an independent L/R
   * measurement possible. Both analysers are leaves, mirroring the working
   * per-channel analyser, so nothing about the audible graph changes.
   */
  private masterSplitter: ChannelSplitterNode | null = null;
  private masterAnalyserL: AnalyserNode | null = null;
  private masterAnalyserR: AnalyserNode | null = null;
  private loudnessMeter: LoudnessMeter | null = null;
  private truePeakMeter: TruePeakMeter | null = null;
  private stereoFieldMeter: StereoFieldMeter | null = null;
  private measurementPlanner: MeasurementWindowPlanner = createMeasurementWindowPlanner();
  private measurementPumping = false;
  private measurementTimerId: ReturnType<typeof setInterval> | null = null;
  private measurementScratch: { left: Float32Array; right: Float32Array } | null = null;
  private mixerChannels: Map<number, MixerChannel> = new Map();
  private channelPanners: Map<string, ChannelPannerEntry> = new Map();
  private mixerRoutingAdapter: MixerRoutingAdapter | null = null;
  private mixerRoutingChannelMap: Map<number, MixerChannel> | null = null;

  private grossBeatState: GrossBeatState = {
    enabled: false,
    mix: 1.0,
    // Phase 57: the only Gross Beat behaviour the engine implements is a
    // 16-step amplitude gate on the master bus. There is no time, pitch or
    // tape state to carry.
    gateSteps: grossBeatAlternatingSteps(),
  };

  private activeVoices: Map<string, { stop: (time?: number) => void }> = new Map();
  /** Per-voice post-envelope channel volume trim so live `Channel.volume` and `channel_vol` automation modulate sustaining voices without double-scaling. */
  private activeVoiceChannelVolumes: Map<string, { channelId: string; baseVolume: number; gainNode: GainNode }> = new Map();
  /** Renderer handles currently participating in drum-pad choke groups. */
  private activeDrumPadVoices: Map<number, Map<string, InstrumentVoiceHandle>> = new Map();
  /** Buffer sources of the active take's playlist audio; cancelled by stop/pause/seek. */
  private activeClipSources: Set<AudioBufferSourceNode> = new Set();
  /** Playlist lane row each active clip source was started from, so a live lane mute can cancel exactly that lane's audio. */
  private activeClipSourceLanes: Map<AudioBufferSourceNode, number> = new Map();
  /** Channel Rack channel ID each channel-affiliated active clip source was started from. */
  private activeClipSourceChannels: Map<AudioBufferSourceNode, string> = new Map();
  /** Per-clip post-fade channel volume trim for channel-affiliated audio clips. */
  private activeClipChannelVolumes: Map<AudioBufferSourceNode, { channelId: string; baseVolume: number; gainNode: GainNode }> = new Map();
  /** Playlist lane rows muted for the active take; enforced before clips reach their mixer insert. */
  private playlistLaneMutes: Set<number> = new Set();
  /** Phase 1M — clip IDs of take-group members that are not the active take. Refreshed when clips change. */
  private inaudibleTakeClipIds: Set<string> | null = null;
  private sampleBuffers: Map<string, AudioBuffer> = new Map();
  /** Project-owned ids are replaced atomically at the project replacement boundary. */
  private projectOwnedSampleBufferIds: Set<string> = new Set();
  /** Buffers deliberately resident outside the active project (imports, previews, internal aliases). */
  private sessionSampleBufferIds: Set<string> = new Set();
  private impulseResponses: Map<string, AudioBuffer> = new Map();
  private readonly instrumentRegistry: InstrumentRegistry;

  // Recording
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];
  private recordingAnalyser: AnalyserNode | null = null;

  // MIDI
  private midiAccess: MIDIAccess | null = null;
  private midiListeners: ((e: MidiEventPayload) => void)[] = [];

  constructor() {
    // All built-in voices now enter through one registry boundary. The voice
    // implementations remain unchanged; this phase separates dispatch from
    // audio generation so a future external instrument can implement the same
    // contract without another growing instrumentType switch.
    this.instrumentRegistry = createInstrumentRegistry({
      drumpad: renderDrumPadVoice,
      fmsynth: renderFmSynthVoice,
      fm_bell: renderFmSynthVoice,
      grand_piano: renderGrandPianoVoice,
      rhodes_epiano: renderRhodesVoice,
      hammond_organ: renderOrganVoice,
      nylon_guitar: renderPluckedGuitarVoice,
      harpsichord: renderPluckedGuitarVoice,
      strings_ensemble: renderStringsVoice,
      pizzicato_strings: renderPizzicatoVoice,
      cinematic_brass: renderBrassVoice,
      acid_303: renderAcid303Voice,
      reese_bass: renderReeseBassVoice,
      slap_bass: renderReeseBassVoice,
      sub_808: render808SubVoice,
      supersaw_lead: renderSupersawVoice,
      ambient_pad: renderAmbientPadVoice,
      vox_choir: renderVoxChoirVoice,
      marimba_bell: renderMarimbaVoice,
      chiptune_8bit: renderChiptuneVoice,
      independent_pluck: renderIndependentPluckVoice,
      minisynth: renderSubtractiveSynthVoice,
      wavetable: renderSubtractiveSynthVoice,
      sampler: renderSamplerVoice,
    }, renderSubtractiveSynthVoice);
  }

  /** True while a timeline render owns the shared engine's mutable audio state. */
  public isOfflineRenderLeaseHeld(): boolean {
    return this.offlineRenderLeaseHeld;
  }

  /**
   * Registers the callback invoked once an offline timeline render has released
   * the render lease — on success and on failure, after the live graph and a
   * previously running take have been restored.
   *
   * The lease deliberately discards every live mutation issued while the offline
   * graph owns the engine (Phase 50/51): a live write must never reach the frozen
   * take. The other half of that contract is the owner's: whatever the user
   * changed in the project document while the export ran has to be re-published
   * to the live engine when the lease ends, otherwise playback keeps the
   * pre-render tempo/swing/mixer while the UI shows the new values. The engine
   * cannot re-publish project state itself, so it reports the release and the
   * project document's owner answers with the authoritative state.
   */
  public setOfflineRenderCompleteCallback(callback: (() => void) | null): void {
    this.offlineRenderCompleteCallback = callback;
  }

  private notifyOfflineRenderComplete(): void {
    const callback = this.offlineRenderCompleteCallback;
    if (!callback) return;
    try {
      callback();
    } catch (error) {
      // A failed re-publication must not turn a finished export into a failure.
      console.error('[Apex Studio] Offline render completion handler failed', error);
    }
  }

  /** Renderer-owned graph work is allowed; live callers remain fenced out. */
  private shouldBlockLiveMutation(): boolean {
    return this.offlineRenderLeaseHeld && this.offlineRenderOperationDepth === 0;
  }

  private withOfflineRenderOperation<T>(operation: () => T): T {
    this.offlineRenderOperationDepth += 1;
    try {
      return operation();
    } finally {
      this.offlineRenderOperationDepth -= 1;
    }
  }

  public init() {
    if (this.shouldBlockLiveMutation() || this.isOfflineRendering) return;
    const isOffline = this.ctx && (typeof (this.ctx as any).startRendering === 'function' || (typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext));
    if (this.ctx && this.ctx.state !== 'closed') {
      if (!isOffline && this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {});
      }
      return;
    }

    const AudioContextClass = window.AudioContext || (window as unknown as WindowWithWebKitAudio).webkitAudioContext;
    this.ctx = new AudioContextClass({ latencyHint: 'interactive' });

    // Master bus with the master amplitude gate
    this.masterGain = this.ctx.createGain();
    this.grossBeatNode = this.ctx.createGain();
    this.masterAnalyser = this.ctx.createAnalyser();
    this.masterAnalyser.fftSize = 512;
    this.masterAnalyser.smoothingTimeConstant = 0.8;

    this.masteringProcessor?.dispose();
    // Lightweight test/fallback contexts may not implement the full Web Audio DSP API.
    // Keep those contexts usable with a transparent master path; real browser AudioContext
    // supports these nodes and receives the complete mastering processor.
    const supportsMasteringDsp =
      typeof (this.ctx as any).createChannelSplitter === 'function' &&
      typeof (this.ctx as any).createChannelMerger === 'function' &&
      typeof (this.ctx as any).createDynamicsCompressor === 'function' &&
      typeof (this.ctx as any).createWaveShaper === 'function';
    this.masteringProcessor = supportsMasteringDsp
      ? new MasteringProcessor(this.ctx, this.masteringState)
      : null;
    this.masterGain.connect(this.grossBeatNode);
    if (this.masteringProcessor) {
      this.grossBeatNode.connect(this.masteringProcessor.input);
      this.masteringProcessor.output.connect(this.masterAnalyser);
    } else {
      this.grossBeatNode.connect(this.masterAnalyser);
    }
    this.masterAnalyser.connect(this.ctx.destination);
    this.createMasterMeasurementTap(this.ctx);

    // Build default reverb impulse response
    this.buildReverbImpulse(2.5, 2.0);

    // Initialize default mixer tracks (0 to 8)
    for (let i = 0; i <= 8; i++) {
      this.getOrCreateMixerChannel(i);
    }
    this.mixerRoutingAdapter = new MixerRoutingAdapter(this.mixerChannels);
    this.mixerRoutingChannelMap = this.mixerChannels;

    this.transport = new AudioClockTransport(this.ctx);

    // Init Web MIDI
    this.initMidi();
  }

  public getContext(): AudioContext {
    if (this.shouldBlockLiveMutation()) {
      if (this.liveCtx) return this.liveCtx;
      throw new Error('A live audio context is unavailable while an offline render is isolated.');
    }
    if (this.isOfflineRendering && this.ctx) {
      return this.ctx;
    }
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || (window as unknown as WindowWithWebKitAudio).webkitAudioContext;
      this.ctx = new AudioContextClass({ latencyHint: 'interactive' });
    }
    const isOffline = typeof (this.ctx as any).startRendering === 'function' || (typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext);
    if (!isOffline && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private getLiveSampleBufferStore(): Map<string, AudioBuffer> {
    return this.shouldBlockLiveMutation() && this.liveSampleBuffersDuringOfflineRender
      ? this.liveSampleBuffersDuringOfflineRender
      : this.sampleBuffers;
  }

  private getLiveProjectSampleBufferIds(): Set<string> {
    return this.shouldBlockLiveMutation() && this.liveProjectSampleBufferIdsDuringOfflineRender
      ? this.liveProjectSampleBufferIdsDuringOfflineRender
      : this.projectOwnedSampleBufferIds;
  }

  private getLiveSessionSampleBufferIds(): Set<string> {
    return this.shouldBlockLiveMutation() && this.liveSessionSampleBufferIdsDuringOfflineRender
      ? this.liveSessionSampleBufferIdsDuringOfflineRender
      : this.sessionSampleBufferIds;
  }

  public getSampleBuffer(id: string): AudioBuffer | undefined {
    return this.getLiveSampleBufferStore().get(id);
  }

  private setSessionSampleBuffer(id: string, buffer: AudioBuffer): void {
    this.getLiveSampleBufferStore().set(id, buffer);
    this.getLiveSessionSampleBufferIds().add(id);
  }

  public setSampleBuffer(id: string, buffer: AudioBuffer): void {
    this.getLiveSampleBufferStore().set(id, buffer);
    if (!this.getLiveProjectSampleBufferIds().has(id)) this.getLiveSessionSampleBufferIds().add(id);
  }

  /**
   * Establishes the active project's ownership boundary without clearing
   * legitimate session-only buffers. Outgoing project-owned buffers are
   * released unless they were explicitly retained as session assets.
   */
  public setProjectSampleBufferOwnership(ids: Iterable<string>): void {
    const sampleBuffers = this.getLiveSampleBufferStore();
    const projectOwnedIds = this.getLiveProjectSampleBufferIds();
    const sessionIds = this.getLiveSessionSampleBufferIds();
    const nextProjectIds = new Set<string>();
    for (const id of ids) if (id) nextProjectIds.add(id);

    for (const id of projectOwnedIds) {
      if (nextProjectIds.has(id)) continue;
      if (!sessionIds.has(id)) sampleBuffers.delete(id);
    }

    for (const id of projectOwnedIds) {
      if (!nextProjectIds.has(id)) projectOwnedIds.delete(id);
    }

    for (const id of nextProjectIds) {
      projectOwnedIds.add(id);
      sessionIds.delete(id);
    }
  }

  /** Project-owned buffers currently resident in the engine. */
  public getProjectOwnedSampleBufferIds(): string[] {
    const sampleBuffers = this.getLiveSampleBufferStore();
    return [...this.getLiveProjectSampleBufferIds()].filter(id => sampleBuffers.has(id));
  }

  /** Session-only/internal buffers currently resident in the engine. */
  public getSessionSampleBufferIds(): string[] {
    const sampleBuffers = this.getLiveSampleBufferStore();
    return [...this.getLiveSessionSampleBufferIds()].filter(id => sampleBuffers.has(id));
  }

  /**
   * Assets eligible to keep during persistence reconciliation. This is the
   * ownership-aware replacement for treating every resident engine buffer as
   * a project reference.
   */
  public getPersistableSampleBufferIds(): string[] {
    return [...new Set([
      ...this.getProjectOwnedSampleBufferIds(),
      ...this.getSessionSampleBufferIds()
    ])];
  }

  /** Ids of every audio asset currently registered in memory. */
  public getSampleBufferIds(): string[] {
    return [...this.getLiveSampleBufferStore().keys()];
  }

  /** The seeded impulse prepared for the current offline render, if one exists. */
  public getOfflineReverbImpulseResponse(): AudioBuffer | undefined {
    if (!this.isOfflineRendering) return undefined;
    return this.impulseResponses.get('default');
  }

  private buildReverbImpulse(duration: number, decay: number, options?: { seed?: number }) {
    if (!this.ctx) return;
    const rate = this.ctx.sampleRate;
    const length = rate * duration;
    const impulse = this.ctx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    // Offline renders must produce a byte-identical WAV for the same project
    // (regression coverage depends on that — see `src/audio/exportParity.test.ts`).
    // Math.random() would change the convolution tail between exports, so the
    // renderer is the only offline caller and supplies an explicit seed. The
    // live engine keeps its existing seeded RNG behaviour.
    const seed = options?.seed;
    const rng = typeof seed === 'number' ? createSeededRandom(seed) : Math.random;

    for (let i = 0; i < length; i++) {
      const n = i / length;
      const factor = Math.pow(1 - n, decay);
      left[i] = (rng() * 2 - 1) * factor;
      right[i] = (rng() * 2 - 1) * factor;
    }
    this.impulseResponses.set('default', impulse);
  }

  /**
   * A clip is lane-muted when its playlist row is muted. Lane mute is enforced
   * at the trigger boundary — before the clip reaches its routed mixer insert —
   * so muting one lane can never silence another lane or a channel that shares
   * the same insert.
   *
   * `laneMutes` is the project-derived mute set; passing an empty set makes
   * the check branch-free so callers in the hot path don't pay for the
   * row-lookup when the project has no muted lanes.
   */
  private isClipPlaylistLaneMuted(clip: PlaylistClip, laneMutes: Set<number>): boolean {
    if (laneMutes.size === 0) return false;
    if (!Number.isFinite(clip.trackIndex)) return false;
    return laneMutes.has(Math.floor(clip.trackIndex));
  }

  /**
   * Phase 1M — true when a clip is part of a take group but is not the active
   * take. Inactive takes are silent during playback and export, so the
   * musician hears only the selected comp. Clips without a `takeGroupId` are
   * never inaudible by this rule.
   */
  private isClipTakeInactive(clip: PlaylistClip): boolean {
    if (!clip.takeGroupId) return false;
    if (!this.inaudibleTakeClipIds) return false;
    return this.inaudibleTakeClipIds.has(clip.id);
  }

  /** Phase 1M — refreshes the set of inaudible take-clip IDs from the current active clips. */
  private refreshInaudibleTakeClipIds(): void {
    this.inaudibleTakeClipIds = resolveInaudibleTakeClipIds(this.activeClips);
  }

  public getOrCreateMixerChannel(trackId: number) {
    if (this.shouldBlockLiveMutation()) {
      throw new Error('Live mixer channels cannot be created during an offline render.');
    }
    if (!this.ctx) this.init();
    const ctx = this.ctx!;

    if (this.mixerChannels.has(trackId)) {
      return this.mixerChannels.get(trackId)!;
    }

    const input = ctx.createGain();
    const output = ctx.createGain();
    const duckingGain = ctx.createGain();
    const panner: StereoPannerNode | GainNode = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.7;

    // Connect input -> panner -> duckingGain -> output -> analyser
    input.connect(panner);
    panner.connect(duckingGain);
    duckingGain.connect(output);
    output.connect(analyser);

    if (trackId === 0) {
      // Master channel routes to masterGain
      output.connect(this.masterGain!);
    } else {
      // Insert tracks route to master channel input (track 0)
      const masterChannel = this.getOrCreateMixerChannel(0);
      output.connect(masterChannel.input);
    }

    const channelObj: MixerChannel = {
      input,
      output,
      duckingGain,
      panner,
      analyser,
      fxNodes: [] as AudioNode[],
      meterTap: analyser,
      auxSendGains: new Map<number, GainNode>(),
    };

    this.mixerChannels.set(trackId, channelObj);
    return channelObj;
  }

  public hasMixerChannel(trackId: number): boolean {
    return this.mixerChannels.has(trackId);
  }

  public removeMixerChannel(trackId: number): void {
    if (this.shouldBlockLiveMutation()) return;
    if (trackId === 0) return; // Master track must never be disconnected or removed

    const channel = this.mixerChannels.get(trackId);
    if (!channel) return;

    try {
      channel.input.disconnect();
    } catch (_) {}

    channel.fxNodes.forEach(node => {
      try {
        node.disconnect();
      } catch (_) {}
    });
    channel.fxNodes = [];

    try {
      channel.panner.disconnect();
    } catch (_) {}

    try {
      channel.duckingGain.disconnect();
    } catch (_) {}

    try {
      channel.output.disconnect();
    } catch (_) {}

    try {
      channel.analyser.disconnect();
    } catch (_) {}

    // Phase 88: disconnect aux send gains owned by this source
    if (channel.auxSendGains) {
      for (const gain of channel.auxSendGains.values()) {
        try { gain.disconnect(); } catch (_) {}
      }
      channel.auxSendGains.clear();
    }

    // Phase 88: remove incoming aux sends from other tracks that targeted the deleted track
    for (const [, otherChannel] of this.mixerChannels) {
      if (!otherChannel.auxSendGains?.has(trackId)) continue;
      const gain = otherChannel.auxSendGains.get(trackId)!;
      try { otherChannel.output.disconnect(gain as unknown as AudioNode); } catch (_) {}
      try { gain.disconnect(); } catch (_) {}
      otherChannel.auxSendGains.delete(trackId);
    }

    if (this.channelPanners) {
      for (const [channelId, entry] of [...this.channelPanners.entries()]) {
        if (entry.mixerTrackId === trackId) {
          this.removeChannelPanner(channelId);
        }
      }
    }

    this.mixerChannels.delete(trackId);
  }

  private clampChannelPan(pan: unknown): number {
    const numeric = typeof pan === 'number' && Number.isFinite(pan) ? pan : 0;
    return Math.max(-1, Math.min(1, numeric));
  }

  private applyPanToNode(panner: StereoPannerNode | GainNode, pan: number, time: number): void {
    if (!panner || typeof panner !== 'object' || !('pan' in panner) || !panner.pan) return;
    const clamped = this.clampChannelPan(pan);
    if (typeof panner.pan.setValueAtTime === 'function') {
      panner.pan.setValueAtTime(clamped, time);
    } else {
      panner.pan.value = clamped;
    }
  }

  private applyGainToNode(gainNode: GainNode, gainValue: number, time: number): void {
    if (!gainNode || typeof gainNode !== 'object' || !('gain' in gainNode) || !gainNode.gain) return;
    const clamped = Math.max(0, Number.isFinite(gainValue) ? gainValue : 1);
    if (typeof gainNode.gain.setValueAtTime === 'function') {
      gainNode.gain.setValueAtTime(clamped, time);
    } else {
      gainNode.gain.value = clamped;
    }
  }

  private isChannelAudibleInTake(
    channel: Pick<Channel, 'mute' | 'solo'>,
    channels: readonly Pick<Channel, 'mute' | 'solo'>[] = this.activeChannels,
  ): boolean {
    return isRackChannelAudible(channel, channels);
  }

  private isAudioClipChannelAudible(clip: PlaylistClip): boolean {
    if (!clip.channelId) return true;
    const channel = this.activeChannels.find(candidate => candidate.id === clip.channelId);
    if (!channel) return true;
    return this.isChannelAudibleInTake(channel);
  }

  private cleanupVoiceChannelVolume(voiceId: string): void {
    const entry = this.activeVoiceChannelVolumes?.get(voiceId);
    if (!entry) return;
    this.activeVoiceChannelVolumes.delete(voiceId);
    try {
      entry.gainNode.disconnect();
    } catch (_) {}
  }

  private cleanupClipChannelVolume(source: AudioBufferSourceNode): void {
    this.activeClipSourceChannels?.delete(source);
    const entry = this.activeClipChannelVolumes?.get(source);
    if (!entry) return;
    this.activeClipChannelVolumes.delete(source);
    try {
      entry.gainNode.disconnect();
    } catch (_) {}
  }

  private updateChannelVolumeForActiveAudio(channelId: string, volume: number, time?: number): void {
    if (!this.ctx) return;
    const effectiveTime = typeof time === 'number' && Number.isFinite(time)
      ? time
      : (this.ctx.currentTime ?? 0);
    const clampedVol = Math.max(0, Number.isFinite(volume) ? volume : 0);

    if (this.activeVoiceChannelVolumes) {
      for (const entry of this.activeVoiceChannelVolumes.values()) {
        if (entry.channelId !== channelId) continue;
        const ratio = entry.baseVolume > 1e-4 ? clampedVol / entry.baseVolume : clampedVol;
        this.applyGainToNode(entry.gainNode, ratio, effectiveTime);
      }
    }

    if (this.activeClipChannelVolumes) {
      for (const entry of this.activeClipChannelVolumes.values()) {
        if (entry.channelId !== channelId) continue;
        const ratio = entry.baseVolume > 1e-4 ? clampedVol / entry.baseVolume : clampedVol;
        this.applyGainToNode(entry.gainNode, ratio, effectiveTime);
      }
    }
  }

  /**
   * Returns (creating if needed) the shared per-channel stereo panner that sits
   * between all voices/clips of `channel` and its target `mixerChannel.input`.
   *
   * Keeping one panner per `Channel.id` rather than mutating `MixerTrack.pan`
   * preserves independent Channel vs. Mixer Track panning, allows multiple
   * channels to share a mixer insert with distinct channel pans, and lets live
   * `Channel.pan` edits, `channel_pan` automation, and MIDI CC mappings update
   * an in-flight channel AudioParam without restarting playback.
   */
  public getOrCreateChannelPanner(
    channel: Pick<Channel, 'id' | 'pan' | 'mixerTrackId'>,
    time?: number,
  ): (StereoPannerNode | GainNode) | null {
    if (this.shouldBlockLiveMutation() || !this.ctx) return null;
    if (typeof this.ctx.createStereoPanner !== 'function') return null;

    const mixerChannel = this.getOrCreateMixerChannel(channel.mixerTrackId);
    if (!mixerChannel?.input) return null;

    if (!this.channelPanners) {
      this.channelPanners = new Map();
    }

    const effectiveTime = typeof time === 'number' && Number.isFinite(time)
      ? time
      : (this.ctx.currentTime ?? 0);
    const clampedPan = this.clampChannelPan(channel.pan);
    let entry = this.channelPanners.get(channel.id);

    if (!entry) {
      const panner = this.ctx.createStereoPanner();
      if (typeof (panner as unknown as { connect?: unknown }).connect === 'function') {
        panner.connect(mixerChannel.input);
      }
      entry = {
        panner,
        mixerTrackId: channel.mixerTrackId,
        destination: mixerChannel.input,
        pan: clampedPan,
      };
      this.channelPanners.set(channel.id, entry);
      this.applyPanToNode(panner, clampedPan, effectiveTime);
      return panner;
    }

    if (entry.mixerTrackId !== channel.mixerTrackId || entry.destination !== mixerChannel.input) {
      try {
        entry.panner.disconnect();
      } catch (_) {}
      if (typeof (entry.panner as unknown as { connect?: unknown }).connect === 'function') {
        entry.panner.connect(mixerChannel.input);
      }
      entry.mixerTrackId = channel.mixerTrackId;
      entry.destination = mixerChannel.input;
    }

    if (entry.pan !== clampedPan) {
      entry.pan = clampedPan;
      this.applyPanToNode(entry.panner, clampedPan, effectiveTime);
    }

    return entry.panner;
  }

  public getChannelPanner(channelId: string): (StereoPannerNode | GainNode) | undefined {
    return this.channelPanners?.get(channelId)?.panner;
  }

  public updateChannel(
    channel: Pick<Channel, 'id' | 'pan' | 'mixerTrackId'> & Partial<Pick<Channel, 'volume'>>,
    atTime?: number,
  ): void {
    if (this.shouldBlockLiveMutation() || !this.ctx) return;
    const now = typeof atTime === 'number' && Number.isFinite(atTime)
      ? atTime
      : (this.ctx.currentTime ?? 0);
    if (typeof channel.volume === 'number' && Number.isFinite(channel.volume)) {
      this.updateChannelVolumeForActiveAudio(channel.id, channel.volume, now);
    }
    if (typeof this.ctx.createStereoPanner !== 'function') return;
    const panner = this.getOrCreateChannelPanner(channel, now);
    if (!panner) return;
    const clampedPan = this.clampChannelPan(channel.pan);
    const entry = this.channelPanners?.get(channel.id);
    if (entry) {
      entry.pan = clampedPan;
    }
    this.applyPanToNode(panner, clampedPan, now);
  }

  public removeChannelPanner(channelId: string): void {
    if (this.shouldBlockLiveMutation() || !this.channelPanners) return;
    const entry = this.channelPanners.get(channelId);
    if (!entry) return;
    try {
      entry.panner.disconnect();
    } catch (_) {}
    this.channelPanners.delete(channelId);
  }

  private syncChannelPanners(channels: Channel[], time: number): void {
    if (!this.channelPanners) {
      this.channelPanners = new Map();
      return;
    }
    const nextIds = new Set(channels.map(channel => channel.id));
    for (const channelId of [...this.channelPanners.keys()]) {
      if (!nextIds.has(channelId)) {
        this.removeChannelPanner(channelId);
      }
    }
    for (const channel of channels) {
      if (this.channelPanners.has(channel.id)) {
        this.updateChannel(channel, time);
      }
    }
  }

  public updateMixerTrack(track: MixerTrack) {
    if (this.shouldBlockLiveMutation()) return;
    const channel = this.getOrCreateMixerChannel(track.id);
    if (!this.ctx) return;

    channel.sidechain = track.sidechain;

    const now = this.ctx.currentTime;
    const targetVol = track.mute ? 0 : track.volume;
    channel.output.gain.setTargetAtTime(targetVol, now, 0.02);

    if ('pan' in channel.panner && channel.panner.pan) {
      channel.panner.pan.setTargetAtTime(track.pan, now, 0.02);
    }

    // Update FX chain if any
    this.rebuildTrackFxChain(track);
    this.applyMixerTrackRouting(track);
  }

  private ensureMixerRoutingAdapter(): MixerRoutingAdapter {
    if (!this.mixerChannels.has(0)) this.getOrCreateMixerChannel(0);
    if (!this.mixerRoutingAdapter || this.mixerRoutingChannelMap !== this.mixerChannels) {
      this.mixerRoutingAdapter = new MixerRoutingAdapter(this.mixerChannels);
      this.mixerRoutingChannelMap = this.mixerChannels;
    }
    return this.mixerRoutingAdapter;
  }

  private applyMixerTrackRouting(track: MixerTrack): void {
    if (track.id === 0) return;
    const adapter = this.ensureMixerRoutingAdapter();
    const existingRoutes = new Map(
      adapter
        .getRoutes()
        .filter(route => this.mixerChannels.has(route.trackId))
        .map(route => [route.trackId, route.targetId]),
    );
    for (const trackId of this.mixerChannels.keys()) {
      if (trackId !== 0 && !existingRoutes.has(trackId)) existingRoutes.set(trackId, 0);
    }
    existingRoutes.set(track.id, track.routingTargetId ?? 0);
    const result = adapter.syncRoutes(
      [...existingRoutes.entries()].map(([trackId, targetId]) => ({ trackId, targetId })),
    );
    if (!result.valid) {
      console.error('[AudioEngine] Mixer routing update rejected', {
        trackId: track.id,
        targetId: track.routingTargetId ?? 0,
        reason: result.reason,
      });
    } else {
      // Phase 88: bus rebuild cleared aux taps; restore them and sync this track's sends
      this.restoreAuxSendConnections();
      this.syncAuxSendsForTrack(track);
    }
  }

  private syncMixerRouting(tracks: MixerTrack[]): void {
    // Some state-only synchronization paths (and their test doubles) can run
    // without a constructed audio master. Routing is an audio-graph concern;
    // defer it until the production mixer graph exists.
    if (!this.mixerChannels.has(0)) return;
    const adapter = this.ensureMixerRoutingAdapter();
    const routes = tracks
      .filter(track => track.id !== 0)
      .map(track => ({ trackId: track.id, targetId: track.routingTargetId ?? 0 }));
    const result = adapter.syncRoutes(routes);
    if (!result.valid) throw new Error(result.reason ?? 'Invalid mixer routing.');
    // Phase 88: bus rebuild cleared output edges including aux taps; restore them
    this.restoreAuxSendConnections();
    // Phase 88: sync all aux sends after bus topology is stable
    this.syncAllAuxSends(tracks);
  }

  // Phase 88: aux send graph — post-fader GainNode per send
  private clampAuxSendAmount(amount: unknown): number {
    const n = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
    return Math.max(0, Math.min(1, n));
  }

  private ensureAuxSendGainsMap(channel: MixerChannel): Map<number, GainNode> {
    if (!channel.auxSendGains) channel.auxSendGains = new Map<number, GainNode>();
    return channel.auxSendGains;
  }

  /**
   * Validates that adding aux edges `newAux` to the combined bus+aux graph
   * does not introduce a cycle. Returns null if valid, or a reason string.
   */
  private validateAuxSendsNoCycle(
    tracks: MixerTrack[],
    newAuxForSource?: { sourceId: number; auxSends: Array<{ targetId: number; amount: number }> }
  ): string | null {
    // Build adjacency from routingTargetId + auxSends (including proposed change)
    const adj = new Map<number, Set<number>>();
    for (const t of tracks) {
      if (t.id === 0) continue;
      const target = t.routingTargetId ?? 0;
      if (target !== 0) {
        if (!adj.has(t.id)) adj.set(t.id, new Set());
        adj.get(t.id)!.add(target);
      }
      let sends = t.auxSends ?? [];
      if (newAuxForSource && t.id === newAuxForSource.sourceId) {
        sends = newAuxForSource.auxSends;
      }
      for (const s of sends) {
        if (s.targetId === 0 || s.targetId === t.id) continue;
        if (!adj.has(t.id)) adj.set(t.id, new Set());
        adj.get(t.id)!.add(s.targetId);
      }
    }
    // DFS cycle detection
    const visited = new Set<number>();
    const stack = new Set<number>();
    const dfs = (node: number): boolean => {
      if (stack.has(node)) return true;
      if (visited.has(node)) return false;
      visited.add(node);
      stack.add(node);
      const neighbors = adj.get(node);
      if (neighbors) {
        for (const n of neighbors) {
          if (n === 0) continue;
          if (dfs(n)) return true;
        }
      }
      stack.delete(node);
      return false;
    };
    for (const id of adj.keys()) {
      if (dfs(id)) return 'Aux send would create a routing cycle.';
    }
    return null;
  }

  public syncAuxSendsForTrack(track: MixerTrack, allTracks?: MixerTrack[]): void {
    if (this.shouldBlockLiveMutation() || !this.ctx) return;
    // Master cannot send
    if (track.id === 0) {
      const ch = this.mixerChannels.get(track.id);
      if (ch?.auxSendGains) {
        for (const g of ch.auxSendGains.values()) { try { g.disconnect(); } catch (_) {} }
        ch.auxSendGains.clear();
      }
      return;
    }
    // Validate no cycle if allTracks provided
    if (allTracks) {
      const cycleReason = this.validateAuxSendsNoCycle(allTracks, { sourceId: track.id, auxSends: track.auxSends ?? [] });
      if (cycleReason) {
        console.error('[AudioEngine] Aux send update rejected', { trackId: track.id, reason: cycleReason });
        return;
      }
    }
    const channel = this.mixerChannels.get(track.id);
    if (!channel) return;
    const map = this.ensureAuxSendGainsMap(channel);
    const desired = (track.auxSends ?? []).slice(0, 2);
    const desiredIds = new Set(desired.map(s => s.targetId));
    // Remove stale
    for (const [targetId, gain] of [...map.entries()]) {
      if (!desiredIds.has(targetId)) {
        try { channel.output.disconnect(gain as unknown as AudioNode); } catch (_) {}
        try { gain.disconnect(); } catch (_) {}
        map.delete(targetId);
      }
    }
    // Add / update
    for (const send of desired) {
      const clamped = this.clampAuxSendAmount(send.amount);
      if (clamped <= 1e-6) {
        // Keep gain but set to 0; still connected so automation can drive it later
      }
      if (!Number.isInteger(send.targetId) || send.targetId === track.id || send.targetId === 0) continue;
      const targetChannel = this.mixerChannels.get(send.targetId);
      if (!targetChannel) {
        // Target not yet created as audio channel; ensure it exists so the send has a destination
        try { this.getOrCreateMixerChannel(send.targetId); } catch (_) {}
        const tc2 = this.mixerChannels.get(send.targetId);
        if (!tc2) continue;
        // continue to connect to tc2
      }
      const targetCh = this.mixerChannels.get(send.targetId)!;
      let gain = map.get(send.targetId);
      if (!gain) {
        gain = this.ctx.createGain();
        gain.gain.value = clamped;
        map.set(send.targetId, gain);
        try { channel.output.connect(gain); } catch (_) {}
        try { gain.connect(targetCh.input); } catch (_) {}
      } else {
        // Update amount
        const now = this.ctx.currentTime;
        if (typeof gain.gain.setTargetAtTime === 'function') {
          gain.gain.setTargetAtTime(clamped, now, 0.02);
        } else {
          gain.gain.value = clamped;
        }
        // Ensure connections exist (in case bus rebuild cleared output edge)
        try { channel.output.connect(gain); } catch (_) {}
        try { gain.connect(targetCh.input); } catch (_) {}
      }
    }
  }

  private syncAllAuxSends(tracks: MixerTrack[]): void {
    if (!this.mixerChannels.has(0)) return;
    // First validate global cycle — if any cycle, log and skip offending tracks?
    // We already validate per-track in syncAuxSendsForTrack, but do a full check first.
    const cycle = this.validateAuxSendsNoCycle(tracks);
    if (cycle) {
      console.error('[AudioEngine] Aux send sync rejected due to cycle', { reason: cycle });
      return;
    }
    for (const track of tracks) {
      if (track.id === 0) continue;
      this.syncAuxSendsForTrack(track);
    }
    // Ensure any aux gains whose target track was removed are pruned
    const validIds = new Set(tracks.map(t => t.id));
    for (const [, ch] of this.mixerChannels) {
      if (!ch.auxSendGains) continue;
      for (const [tid, gain] of [...ch.auxSendGains.entries()]) {
        if (!validIds.has(tid)) {
          try { gain.disconnect(); } catch (_) {}
          ch.auxSendGains.delete(tid);
        }
      }
    }
    this.restoreAuxSendConnections();
  }

  private restoreAuxSendConnections(): void {
    if (!this.ctx) return;
    for (const [, channel] of this.mixerChannels) {
      if (!channel.auxSendGains || channel.auxSendGains.size === 0) continue;
      for (const gain of channel.auxSendGains.values()) {
        try { channel.output.connect(gain); } catch (_) {}
        // gain -> target.input is already connected; but ensure it stays
        // No-op if already connected; Web Audio allows duplicate connect.
      }
      // Meter tap was restored by MixerRoutingAdapter.restoreMeterTaps; ensure aux gains don't interfere
    }
  }

  public rebuildTrackFxChain(track: MixerTrack) {
    if (this.shouldBlockLiveMutation() || !this.ctx) return;
    const ctx = this.ctx;
    const channel = this.getOrCreateMixerChannel(track.id);

    // Disconnect existing FX
    channel.input.disconnect();
    channel.fxNodes.forEach(node => node.disconnect());
    channel.fxNodes = [];

    let currentSource: AudioNode = channel.input;

    track.fxSlots.forEach(slot => {
      if (!slot.enabled) return;

      const fxNode = this.createFxNode(slot);
      if (fxNode) {
        currentSource.connect(fxNode);
        const chainEnd = getChainEnd(fxNode);
        currentSource = chainEnd;
        channel.fxNodes.push(fxNode);
        if (chainEnd !== fxNode) channel.fxNodes.push(chainEnd);
      }
    });

    currentSource.connect(channel.panner);
  }

  /**
   * Legacy single-switch FX factory. Phase 10C-B deliberately kept it in sync
   * with `liveFxChainHardening.createEffect` for chorus, and
   * `phase10cB.test.ts` still exercises that defensive contract on the
   * unwrapped path, so the factory is retained.
   *
   * Phase 58 removed the dead mixer `gross_beat` insert from `FxType`. Its
   * unity-gain branch had no defensive contract and is gone; slots persisted
   * by pre-Phase-58 projects now fall through to `default` and are dropped.
   * Phase 57's master-bus `grossBeat` amplitude gate is a separate subsystem
   * (see `grossBeatGate.ts`) and is unaffected.
   */
  private createFxNode(slot: FxSlot): AudioNode | null {
    if (!this.ctx) return null;
    const ctx = this.ctx;

    switch (slot.type) {
      case 'equalizer': {
        // 3-band EQ: Lowshelf, Peaking, Highshelf
        const low = ctx.createBiquadFilter();
        low.type = 'lowshelf';
        low.frequency.value = Number(slot.params.lowFreq || 120);
        low.gain.value = Number(slot.params.lowGain || 0);

        const mid = ctx.createBiquadFilter();
        mid.type = 'peaking';
        mid.frequency.value = Number(slot.params.midFreq || 1200);
        mid.gain.value = Number(slot.params.midGain || 0);
        mid.Q.value = Number(slot.params.midQ || 1.2);

        const high = ctx.createBiquadFilter();
        high.type = 'highshelf';
        high.frequency.value = Number(slot.params.highFreq || 6500);
        high.gain.value = Number(slot.params.highGain || 0);

        low.connect(mid);
        mid.connect(high);

        // Return container wrapper object
        setChainEnd(low, high);
        return low;
      }
      case 'distortion': {
        const waveshaper = ctx.createWaveShaper();
        const drive = Number(slot.params.drive || 20);
        const curve = new Float32Array(512);
        const deg = Math.PI / 180;
        const k = typeof drive === 'number' ? drive : 20;
        for (let i = 0; i < 512; ++i) {
          const x = (i * 2) / 512 - 1;
          curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
        }
        waveshaper.curve = curve;
        waveshaper.oversample = '4x';
        return waveshaper;
      }
      case 'compressor': {
        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = Number(slot.params.threshold || -18);
        comp.knee.value = Number(slot.params.knee || 24);
        comp.ratio.value = Number(slot.params.ratio || 4);
        comp.attack.value = Number(slot.params.attack || 0.005);
        comp.release.value = Number(slot.params.release || 0.15);
        return comp;
      }
      case 'delay': {
        const delay = ctx.createDelay();
        delay.delayTime.value = Number(slot.params.time || 0.35);
        const feedback = ctx.createGain();
        feedback.gain.value = Number(slot.params.feedback || 0.45);
        delay.connect(feedback);
        feedback.connect(delay);
        return delay;
      }
      case 'reverb': {
        const convolver = ctx.createConvolver();
        const impulse = this.impulseResponses.get('default');
        if (impulse) {
          convolver.buffer = impulse;
        }
        return convolver;
      }
      case 'bitcrusher': {
        const waveshaper = ctx.createWaveShaper();
        const bits = Number(slot.params.bits || 4);
        const steps = Math.pow(2, bits);
        const curve = new Float32Array(512);
        for (let i = 0; i < 512; i++) {
          const x = (i * 2) / 512 - 1;
          curve[i] = Math.round(x * steps) / steps;
        }
        waveshaper.curve = curve;
        return waveshaper;
      }
      case 'limiter': {
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -0.5;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.001;
        limiter.release.value = 0.05;
        return limiter;
      }
      case 'tape_saturation': {
        // Vintage Analog Tape & Tube Saturation Unit
        const drive = Number(slot.params.drive || 35);
        const warmth = Number(slot.params.warmth || 0.8);
        const flutter = Number(slot.params.flutter || 0.001);

        const shaper = ctx.createWaveShaper();
        const curve = new Float32Array(1024);
        const k = drive * 0.1;
        for (let i = 0; i < 1024; i++) {
          const x = (i * 2) / 1024 - 1;
          // Soft asymmetric saturation curve mimicking triode tube & analog tape compression
          curve[i] = Math.tanh(x * (1 + k)) * (1 - 0.1 * Math.sin(Math.PI * x));
        }
        shaper.curve = curve;
        shaper.oversample = '4x';

        // Tape head warmth filter (soft roll-off above 16kHz)
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 16000 - (warmth * 4000);
        filter.Q.value = 0.7;

        shaper.connect(filter);
        setChainEnd(shaper, filter);
        return shaper;
      }
      case 'chorus': {
        // Phase 10C-B: defensive parity with liveFxChainHardening.createEffect.
        // The hardening patch installed at app init already routes both live
        // and offline FX chains through that factory, so `createFxNode` is
        // currently a dead path. Wiring chorus here guarantees the legacy
        // single-switch factory can never silently drop a chorus slot if a
        // future refactor bypasses the patch (or if the patch is uninstalled
        // for any reason). The full wet/dry wrapping matches the live path so
        // a slot.mix change and the chorus modulation behavior are identical
        // between the two factories.
        const rate = Math.max(0.05, Math.min(20, Number(slot.params.rate ?? 1.2) || 1.2));
        const delaySec = Math.max(0.005, Math.min(0.08, Number(slot.params.delay ?? 0.02) || 0.02));
        const depthSec = Math.max(0, Math.min(Math.min(0.02, delaySec), Number(slot.params.depth ?? 0.003) || 0));
        const mix = Math.max(0, Math.min(1, Number(slot.mix) || 0));
        const chorus = new ChorusEffect(ctx, slot.id, rate, depthSec, delaySec, 1);
        const wrapper = new WetDryEffect(ctx, chorus, mix);
        setChainEnd(wrapper.input, wrapper.output);
        return wrapper.input;
      }
      default:
        return null;
    }
  }

  // Instrument sound triggers
  public playNote(
    channel: Channel,
    note: Note,
    startTime?: number,
    bpm: number = 120,
    midiChannel?: number,
  ) {
    if (this.shouldBlockLiveMutation()) return;
    if (!this.ctx) this.init();
    const ctx = this.ctx!;
    const time = startTime ?? ctx.currentTime;

    // Check if arpeggiator is enabled on this channel
    if (channel.arp && channel.arp.enabled) {
      this.playArpSequence(channel, note, time, bpm);
      return;
    }

    this.playSingleVoice(channel, note, time, midiChannel);
  }

  /**
   * The authoritative tempo for instrument rendering, in BPM.
   *
   * Phase 1B: renderers receive this so they can convert `Note.duration`
   * (sixteenth-note steps) into a gate in seconds. It is the engine's live
   * tempo, which `App` keeps in sync with `ProjectState.meta.bpm` and which
   * `renderTimelineOffline` sets to the export's own tempo before scheduling —
   * so a renderer never guesses, and an export gate always equals the gate the
   * user monitored.
   */
  private getRenderBpm(): number {
    return Number.isFinite(this.bpm) && this.bpm > 0 ? this.bpm : 120;
  }

  public playSingleVoice(channel: Channel, note: Note, time: number, midiChannel?: number) {
    if (this.shouldBlockLiveMutation() || !this.ctx) return;
    if (channel.mute) return;
    if (
      this.isPlaying &&
      this.activeChannels.some(candidate => candidate.id === channel.id) &&
      !this.isChannelAudibleInTake(channel)
    ) {
      return;
    }

    const mixerChannel = this.getOrCreateMixerChannel(channel.mixerTrackId);
    const voiceId = midiChannel === undefined
      ? `${channel.id}-${note.pitch}-${Math.random()}`
      : `${channel.id}-${note.pitch}-midi-${midiChannel}-${Math.random()}`;

    // Trigger Dynamic Sidechain Ducking on receiving tracks
    this.triggerSidechainDucking(channel.mixerTrackId, time);

    let voiceHandle: InstrumentVoiceHandle | void;
    let notePanner: StereoPannerNode | null = null;
    let voiceTrimGain: GainNode | null = null;
    const cleanupNotePanner = () => {
      if (notePanner) {
        try {
          notePanner.disconnect();
        } catch (_) {}
        notePanner = null;
      }
      if (voiceTrimGain) {
        try {
          voiceTrimGain.disconnect();
        } catch (_) {}
        voiceTrimGain = null;
      }
      this.activeVoiceChannelVolumes?.delete(voiceId);
    };
    const onEnded = () => {
      cleanupNotePanner();
      if (voiceHandle && this.activeVoices.get(voiceId) === voiceHandle) {
        this.activeVoices.delete(voiceId);
      }
      this.removeDrumPadChokeVoice(voiceId, voiceHandle);
    };

    const pad = channel.instrumentType === 'drumpad'
      ? channel.drumPads?.find(candidate => candidate.note === note.pitch)
      : undefined;
    const chokeGroup = pad?.chokeGroup || 0;
    const sampledDrumPadBuffer = pad?.sampleId
      ? this.sampleBuffers.get(pad.sampleId)
      : undefined;
    const canChokeDrumPad =
      channel.instrumentType === 'drumpad' &&
      Boolean(pad?.sampleId) &&
      Boolean(sampledDrumPadBuffer) &&
      chokeGroup > 0;

    const usesCustomSamplerOverride =
      channel.instrumentType !== 'drumpad' && Boolean(channel.customSample && channel.customSample.id);
    const renderer = channel.instrumentType === 'drumpad'
      ? this.instrumentRegistry.get('drumpad')
      : usesCustomSamplerOverride
        ? this.instrumentRegistry.get('sampler')
        : this.instrumentRegistry.get(channel.instrumentType);

    const hasNotePan = typeof note.pan === 'number' && Number.isFinite(note.pan);
    let voiceDestination: AudioNode = mixerChannel.input;
    let channelPanApplied = false;

    if (hasNotePan) {
      // Note-level pan overrides Channel.pan for this specific voice without
      // mutating the shared channel panner used by other notes on the channel.
      const rendererOwnsNotePanner =
        channel.instrumentType === 'independent_pluck' && !usesCustomSamplerOverride;
      if (rendererOwnsNotePanner) {
        voiceDestination = mixerChannel.input;
        channelPanApplied = false;
      } else if (typeof this.ctx.createStereoPanner === 'function' && mixerChannel?.input) {
        notePanner = this.ctx.createStereoPanner();
        this.applyPanToNode(notePanner, note.pan!, time);
        if (typeof (notePanner as unknown as { connect?: unknown }).connect === 'function') {
          notePanner.connect(mixerChannel.input);
        }
        voiceDestination = notePanner;
        channelPanApplied = true;
      }
    } else {
      const channelPanner = this.getOrCreateChannelPanner(channel, time);
      if (channelPanner) {
        voiceDestination = channelPanner;
        channelPanApplied = true;
      }
    }

    const rawVol = typeof channel.volume === 'number' && Number.isFinite(channel.volume)
      ? Math.max(0, channel.volume)
      : 0.8;
    const baseVolume = rawVol > 1e-4 ? rawVol : 1;
    const rendererChannel = rawVol > 1e-4 ? channel : { ...channel, volume: 1 };
    let rendererDestination: AudioNode = voiceDestination;

    if (typeof this.ctx.createGain === 'function' && voiceDestination) {
      voiceTrimGain = this.ctx.createGain();
      if (rawVol <= 1e-4) {
        this.applyGainToNode(voiceTrimGain, 0, time);
      }
      if (typeof (voiceTrimGain as unknown as { connect?: unknown }).connect === 'function') {
        voiceTrimGain.connect(voiceDestination);
      }
      rendererDestination = voiceTrimGain;
    }

    let rendererFailed = false;
    try {
      voiceHandle = renderer({
        channel: rendererChannel,
        note,
        time,
        destination: rendererDestination,
        audioContext: this.ctx!,
        voiceId,
        bpm: this.getRenderBpm(),
        channelPanApplied,
        onEnded,
        getSampleBuffer: (id) => this.sampleBuffers.get(id),
      });
    } catch (error) {
      rendererFailed = true;
      console.error('[AudioEngine] Instrument renderer failed', {
        instrumentType: channel.instrumentType,
        voiceId,
        error,
      });
    }

    if (rendererFailed) {
      cleanupNotePanner();
      return;
    }

    if (!voiceHandle && (channel.customSample?.id || channel.instrumentType === 'sampler')) {
      // Preserve the pre-22C sampler behavior: an unavailable custom sample,
      // and a sampler channel without a sample, both fall back to subtractive synthesis.
      try {
        voiceHandle = renderSubtractiveSynthVoice({
          channel: rendererChannel,
          note,
          time,
          destination: rendererDestination,
          audioContext: this.ctx!,
          voiceId,
          bpm: this.getRenderBpm(),
          channelPanApplied,
          onEnded,
        });
      } catch (error) {
        cleanupNotePanner();
        console.error('[AudioEngine] Sampler fallback renderer failed', {
          instrumentType: channel.instrumentType,
          voiceId,
          error,
        });
        return;
      }
    }

    if (
      voiceHandle &&
      (typeof voiceHandle !== 'object' || typeof voiceHandle.stop !== 'function')
    ) {
      cleanupNotePanner();
      console.error('[AudioEngine] Instrument renderer returned an invalid voice handle', {
        instrumentType: channel.instrumentType,
        voiceId,
      });
      return;
    }

    if (!voiceHandle) {
      // Phase 1C (D9): the drum-pad sample route is the only sampler-family
      // path with no substitute voice. A pad whose referenced asset could not
      // be restored therefore used to become completely silent with no
      // diagnostic anywhere in the stack — `renderDrumPadVoice` bare-returns,
      // and the fallback branch above only fires for `customSample?.id ||
      // sampler`, which a drum-pad channel never satisfies. Report it through
      // the engine's existing diagnostic channel so the dropped voice is at
      // least observable. This deliberately does NOT invent a substitute
      // voice: a drum pad is not a synth lead, and playing one would be a new
      // sound-design decision, not a bug fix.
      if (channel.instrumentType === 'drumpad' && pad?.sampleId && !sampledDrumPadBuffer) {
        console.error('[AudioEngine] Drum pad sample unavailable', {
          instrumentType: channel.instrumentType,
          voiceId,
          sampleId: pad.sampleId,
          pitch: note.pitch,
        });
      }
      cleanupNotePanner();
      return;
    }

    if (canChokeDrumPad) {
      this.stopDrumPadChokeGroup(chokeGroup, time);
    }

    if (voiceTrimGain) {
      if (!this.activeVoiceChannelVolumes) {
        this.activeVoiceChannelVolumes = new Map();
      }
      this.activeVoiceChannelVolumes.set(voiceId, {
        channelId: channel.id,
        baseVolume,
        gainNode: voiceTrimGain,
      });
    }

    this.activeVoices.set(voiceId, voiceHandle);
    if (canChokeDrumPad && chokeGroup > 0) {
      const voices = this.activeDrumPadVoices.get(chokeGroup) || new Map<string, InstrumentVoiceHandle>();
      voices.set(voiceId, voiceHandle);
      this.activeDrumPadVoices.set(chokeGroup, voices);
    }
  }

  private stopDrumPadChokeGroup(group: number, time: number) {
    const voices = this.activeDrumPadVoices.get(group);
    if (!voices) return;

    for (const [voiceId, handle] of voices) {
      try {
        handle.stop(time);
      } catch (_) {}
      this.cleanupVoiceChannelVolume(voiceId);
      if (this.activeVoices.get(voiceId) === handle) {
        this.activeVoices.delete(voiceId);
      }
    }
    this.activeDrumPadVoices.delete(group);
  }

  private removeDrumPadChokeVoice(
    voiceId: string,
    handle: InstrumentVoiceHandle | void,
  ) {
    if (!handle) return;

    for (const [group, voices] of this.activeDrumPadVoices) {
      if (voices.get(voiceId) !== handle) continue;
      voices.delete(voiceId);
      if (voices.size === 0) {
        this.activeDrumPadVoices.delete(group);
      }
      break;
    }
  }
  // Real-Time Arpeggiator & Euclidean Rhythm Engine
  public generateEuclideanPattern(steps: number = 16, hits: number = 5, rotate: number = 0): boolean[] {
    const pattern = new Array(steps).fill(false);
    if (hits <= 0) return pattern;
    if (hits >= steps) return new Array(steps).fill(true);
    let bucket = 0;
    for (let i = 0; i < steps; i++) {
      bucket += hits;
      if (bucket >= steps) {
        bucket -= steps;
        pattern[i] = true;
      }
    }
    if (rotate > 0) {
      const rot = rotate % steps;
      return [...pattern.slice(steps - rot), ...pattern.slice(0, steps - rot)];
    }
    return pattern;
  }

  /**
   * Schedules the channel's arpeggiator voices for one incoming note.
   *
   * Phase 68 F1: the modal's "Strum Micro-Delay" (`ArpSettings.strumMs`, a
   * declared 0–50 ms) is applied here as a per-voice micro-delay on top of the
   * rate grid — voice 0 never moves, so a zero delay is byte-identical to the
   * historic schedule, and every later voice rolls behind it. Live playback and
   * the offline renderer both reach this method through `playNote`, so the take
   * and the bounce keep sharing one arpeggiator.
   */
  public playArpSequence(channel: Channel, rootNote: Note, startTime: number, bpm: number) {
    if (this.shouldBlockLiveMutation()) return;
    const arp = channel.arp;
    if (!arp) return;

    // Phase 1B: one canonical step table now feeds BOTH the onset spacing and
    // the note duration. `arpStepSeconds` is arithmetically identical to the
    // previous rate divisions, so Phase 70's onsets are unchanged; but the
    // duration is now expressed in STEPS instead of seconds, which is what
    // `Note.duration` means everywhere else in the product.
    const rateSteps = resolveArpRateSteps(arp.rate);
    const stepDuration = arpStepSeconds(arp.rate, bpm);
    const arpNoteDurationSteps = resolveArpNoteDurationSteps(rateSteps, arp.gate);

    const octaves = arp.octaves || 1;
    const basePitch = rootNote.pitch;
    const pitches: number[] = [];

    // Form arpeggiation chord tones
    for (let oct = 0; oct < octaves; oct++) {
      pitches.push(basePitch + oct * 12);
      pitches.push(basePitch + 3 + oct * 12);
      pitches.push(basePitch + 7 + oct * 12);
      pitches.push(basePitch + 10 + oct * 12);
    }

    let sequence: number[] = [];
    if (arp.mode === 'up') sequence = [...pitches];
    else if (arp.mode === 'down') sequence = [...pitches].reverse();
    else if (arp.mode === 'updown') sequence = [...pitches, ...pitches.slice(1, -1).reverse()];
    else if (arp.mode === 'random') sequence = [...pitches].sort(() => Math.random() - 0.5);
    else if (arp.mode === 'chord_strum') sequence = [...pitches];
    else if (arp.mode === 'euclidean') {
      const euc = this.generateEuclideanPattern(arp.euclideanSteps || 16, arp.euclideanHits || 5, arp.euclideanRotate || 0);
      let pIdx = 0;
      euc.forEach((hit, idx) => {
        if (hit) {
          // The Strum Micro-Delay rolls every voice of the sequence: voice 0
          // stays on the grid and each later voice follows by `arp.strumMs`.
          const voiceIndex = pIdx;
          const t = startTime + (idx * stepDuration) + arpStrumSecondsForVoice(arp.strumMs, voiceIndex);
          const p = pitches[pIdx % pitches.length];
          pIdx++;
          this.playSingleVoice(channel, {
            ...rootNote,
            pitch: p,
            duration: arpNoteDurationSteps
          }, t);
        }
      });
      return;
    }

    const totalSteps = Math.min(16, sequence.length * 2);
    for (let i = 0; i < totalSteps; i++) {
      const pitch = sequence[i % sequence.length];
      const t = startTime + (i * stepDuration) + arpStrumSecondsForVoice(arp.strumMs, i);
      this.playSingleVoice(channel, {
        ...rootNote,
        pitch,
        duration: arpNoteDurationSteps
      }, t);
    }
  }

  // Dynamic Sidechain Ducking Processor (Kick to Bass / Lead ducking)
  public triggerSidechainDucking(sourceTrackId: number, time: number) {
    if (this.shouldBlockLiveMutation() || !this.ctx) return;

    this.mixerChannels.forEach((targetChannel, targetId) => {
      if (targetId === sourceTrackId) return;
      if (targetChannel.sidechain && targetChannel.sidechain.enabled && targetChannel.sidechain.sourceTrackId === sourceTrackId) {
        const duckAmount = targetChannel.sidechain.amount ?? 0.75;
        const attackSec = (targetChannel.sidechain.attackMs ?? 5) / 1000;
        const releaseSec = (targetChannel.sidechain.releaseMs ?? 140) / 1000;
        const minGain = Math.max(0.02, 1.0 - duckAmount);

        const duckParam = targetChannel.duckingGain.gain;
        duckParam.cancelScheduledValues(time);
        duckParam.setValueAtTime(duckParam.value, time);
        duckParam.linearRampToValueAtTime(minGain, time + attackSec);
        duckParam.exponentialRampToValueAtTime(1.0, time + attackSec + releaseSec);
      }
    });
  }

  /**
   * Phase 57: MASTER BRAKE.
   *
   * A master-gain fade to silence and back. It is NOT tape-speed deceleration,
   * a turntable slowdown or a pitch-changing tape stop - the engine has no
   * playback-rate or pitch processing to decelerate.
   */
  public triggerMasterBrake(durationMs: number = 600) {
    if (this.shouldBlockLiveMutation() || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const durSec = durationMs / 1000;

    if (this.grossBeatNode) {
      this.grossBeatNode.gain.cancelScheduledValues(now);
      this.grossBeatNode.gain.setValueAtTime(GROSS_BEAT_OPEN_GAIN, now);
      // Master gain fade to silence, then straight back to unity.
      this.grossBeatNode.gain.exponentialRampToValueAtTime(0.0001, now + durSec);
      this.grossBeatNode.gain.setValueAtTime(GROSS_BEAT_OPEN_GAIN, now + durSec + 0.05);
    }
  }

  public setGrossBeatState(state: Partial<GrossBeatState>) {
    if (this.shouldBlockLiveMutation()) return;
    this.grossBeatState = { ...this.grossBeatState, ...state };
    if (!this.ctx || !this.grossBeatNode) return;
    const now = this.ctx.currentTime;
    if (!this.grossBeatState.enabled) {
      this.grossBeatNode.gain.cancelScheduledValues(now);
      this.grossBeatNode.gain.setTargetAtTime(GROSS_BEAT_OPEN_GAIN, now, 0.01);
    }
  }

  public getGrossBeatState(): GrossBeatState {
    return { ...this.grossBeatState };
  }

  // Music Theory Chord Voicing & Strum Engine
  public applyChordVoicing(pitches: number[], voicing: string): number[] {
    if (pitches.length <= 1) return pitches;
    const sorted = [...pitches].sort((a, b) => a - b);
    if (voicing === 'root') return sorted;
    if (voicing === 'inversion1') {
      const first = sorted.shift()!;
      return [...sorted, first + 12];
    }
    if (voicing === 'inversion2') {
      if (sorted.length >= 2) {
        const first = sorted.shift()!;
        const second = sorted.shift()!;
        return [...sorted, first + 12, second + 12];
      }
      return sorted;
    }
    if (voicing === 'drop2') {
      if (sorted.length >= 4) {
        const secondFromTop = sorted[sorted.length - 2];
        const rest = sorted.filter((_, i) => i !== sorted.length - 2);
        return [secondFromTop - 12, ...rest].sort((a, b) => a - b);
      }
      return sorted;
    }
    if (voicing === 'open_spread') {
      return sorted.map((p, idx) => (idx % 2 === 1 ? p + 12 : p));
    }
    return sorted;
  }

  // Bass Note Auto-Extractor: Extracts root notes from chord progressions
  public extractBassNotesFromChords(notes: Note[]): Note[] {
    if (!notes || notes.length === 0) return [];
    // Group notes by step
    const stepMap = new Map<number, Note[]>();
    notes.forEach(note => {
      const step = Math.round(note.start);
      if (!stepMap.has(step)) stepMap.set(step, []);
      stepMap.get(step)!.push(note);
    });

    const bassNotes: Note[] = [];
    stepMap.forEach((stepNotes, step) => {
      // Find lowest pitch
      const lowest = stepNotes.reduce((min, n) => (n.pitch < min.pitch ? n : min), stepNotes[0]);
      // Transpose down into bass range C1-C3 (24 - 48)
      let bassPitch = lowest.pitch;
      while (bassPitch > 48) bassPitch -= 12;
      while (bassPitch < 24) bassPitch += 12;

      bassNotes.push({
        id: `bass-${Date.now()}-${step}-${Math.random().toString(36).substr(2, 4)}`,
        pitch: bassPitch,
        start: lowest.start,
        duration: lowest.duration || 2,
        velocity: 0.95
      });
    });

    return bassNotes.sort((a, b) => a.start - b.start);
  }

  // Audio File Loader
  public async loadAudioFile(file: File | Blob, id: string): Promise<{ buffer: AudioBuffer; peaks: number[]; duration: number }> {
    const ctx = this.getContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    this.setSessionSampleBuffer(id, audioBuffer);

    const rawData = audioBuffer.getChannelData(0);
    const numPeaks = 64;
    const blockSize = Math.floor(rawData.length / numPeaks);
    const peaks: number[] = [];
    for (let i = 0; i < numPeaks; i++) {
      let max = 0;
      for (let j = 0; j < blockSize; j++) {
        const val = Math.abs(rawData[i * blockSize + j] || 0);
        if (val > max) max = val;
      }
      peaks.push(Math.min(1.0, max));
    }
    return { buffer: audioBuffer, peaks, duration: audioBuffer.duration };
  }

  // Automation Evaluator
  public interpolateAutomationCurve(points: { x: number; y: number; tension?: number }[], relX: number): number {
    if (!points || points.length === 0) return 0.5;
    if (points.length === 1) return points[0].y;

    const sorted = [...points].sort((a, b) => a.x - b.x);
    if (relX <= sorted[0].x) return sorted[0].y;
    if (relX >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;

    for (let i = 0; i < sorted.length - 1; i++) {
      const p1 = sorted[i];
      const p2 = sorted[i + 1];
      if (relX >= p1.x && relX <= p2.x) {
        const segT = (relX - p1.x) / (p2.x - p1.x);
        // Linear or ease
        const tension = p1.tension || 0;
        let curvedT = segT;
        if (tension > 0) {
          curvedT = Math.pow(segT, 1 + tension * 2);
        } else if (tension < 0) {
          curvedT = 1 - Math.pow(1 - segT, 1 + Math.abs(tension) * 2);
        }
        return p1.y + (p2.y - p1.y) * curvedT;
      }
    }
    return 0.5;
  }

  public applyAutomationValue(
    target: { type: string; targetId: string | number; paramName?: string },
    value: number, // 0 to 1
    channels: Channel[],
    mixerTracks: MixerTrack[],
    atTime?: number
  ) {
    if (this.shouldBlockLiveMutation() || !this.ctx) return;
    const now = atTime ?? this.ctx.currentTime;

    if (target.type === 'master_vol') {
      if (this.masterGain) {
        this.masterGain.gain.setTargetAtTime(masterOutputGainFromNormalized(value), now, 0.02);
      }
    } else if (target.type === 'channel_vol') {
      const targetVol = channelVolumeFromNormalized(value);
      const ch = channels.find(c => String(c.id) === String(target.targetId));
      if (ch) {
        ch.volume = targetVol;
      }
      this.updateChannelVolumeForActiveAudio(String(target.targetId), targetVol, now);
    } else if (target.type === 'channel_pan') {
      const ch = channels.find(c => c.id === target.targetId);
      const targetPan = panFromNormalized(value);
      if (ch) {
        ch.pan = targetPan;
        this.updateChannel(ch, now);
      } else {
        const panner = this.getChannelPanner(String(target.targetId));
        if (panner) {
          const entry = this.channelPanners?.get(String(target.targetId));
          if (entry) entry.pan = this.clampChannelPan(targetPan);
          this.applyPanToNode(panner, targetPan, now);
        }
      }
    } else if (target.type === 'channel_filter_cutoff') {
      const ch = channels.find(c => c.id === target.targetId);
      if (ch && ch.synthParams) {
        ch.synthParams.filterCutoff = filterCutoffFromNormalized(value);
      }
    } else if (target.type === 'mixer_vol') {
      const trk = mixerTracks.find(t => t.id === Number(target.targetId));
      if (trk) {
        trk.volume = mixerVolumeFromNormalized(value);
      }
      const mixerChannel = this.mixerChannels.get(Number(target.targetId));
      if (mixerChannel) {
        const targetVol = (trk && trk.mute) ? 0 : mixerVolumeFromNormalized(value);
        mixerChannel.output.gain.setTargetAtTime(targetVol, now, 0.02);
      }
    } else if (target.type === 'mixer_pan') {
      const trk = mixerTracks.find(t => t.id === Number(target.targetId));
      const targetPan = panFromNormalized(value);
      if (trk) {
        trk.pan = targetPan;
      }
      const mixerChannel = this.mixerChannels.get(Number(target.targetId));
      if (mixerChannel && 'pan' in mixerChannel.panner && mixerChannel.panner.pan) {
        mixerChannel.panner.pan.setTargetAtTime(targetPan, now, 0.02);
      }
    } else if (target.type === 'channel_filter_res') {
      const ch = channels.find(c => c.id === target.targetId);
      if (ch && ch.synthParams) {
        // Map the automation's normalized 0-1 value onto the model's 0-20 resonance
        // range. New voices constructed at note-trigger read this value, so the
        // next note already hears the automated Q.
        ch.synthParams.filterResonance = filterResonanceFromNormalized(value);
      }
    } else if (target.type === 'channel_pitch') {
      const ch = channels.find(c => c.id === target.targetId);
      if (ch) {
        // Map normalized 0-1 onto the FL Studio-style ±12 semitone offset so the
        // middle of the curve is no transposition. Every note trigger reads
        // `channel.pitch`, so writing it here takes effect on the next note.
        ch.pitch = pitchFromNormalized(value);
      }
    } else if (target.type === 'fx_mix') {
      const trackId = Number(target.targetId);
      const trk = mixerTracks.find(t => t.id === trackId);
      if (trk) {
        const slotId = target.paramName;
        if (slotId) {
          const slot = trk.fxSlots.find(s => s.id === slotId);
          if (slot) {
            // Offline renders consume slot.mix at chain construction time. Update
            // the slot's mix so the next export rebuild (or next offline take)
            // observes the automated value. Live playback updates the running
            // WetDry via the patch registry, when installed, so the user hears
            // the change without a chain rebuild.
            slot.mix = fxMixFromNormalized(value);
            const registry = (this as unknown as {
              __liveFxChainRegistry?: {
                applyLiveMix(trackId: number, slotId: string, mix: number, currentTime: number): boolean;
              };
            }).__liveFxChainRegistry;
            registry?.applyLiveMix(trackId, slotId, slot.mix, now);
          }
        }
      }
    } else if (target.type === 'fx_param') {
      // Phase 81: real automation for every parameter the FX contract owns.
      //
      // The resolution, the range conversion and the "is this parameter real?"
      // test all come from `fxParameterControl`, the same module the MIDI CC
      // bridge uses, so a lane and a hardware knob can never disagree about a
      // parameter's range. A target whose track, slot or parameter is gone
      // resolves to `rejected` and changes nothing — a deleted insert must
      // never redirect the lane onto a different effect.
      const resolution = resolveFxParameterUpdate(mixerTracks, target.targetId, target.paramName, value);
      if (resolution.status !== 'resolved') return;
      const { update } = resolution;
      const trk = mixerTracks.find(t => t.id === update.trackId);
      const slot = trk?.fxSlots.find(s => s.id === update.slotId);
      if (!trk || !slot) return;
      const registry = this.getLiveFxChainRegistry();
      if (update.isMix) {
        // Same destination as the legacy `fx_mix` target: `FxSlot.mix`, owned
        // by the WetDry wrapper. Writing it here keeps the offline rebuild and
        // the live AudioParam on one value.
        slot.mix = update.value;
        registry?.applyLiveMix(update.trackId, update.slotId, update.value, now);
        return;
      }
      // The contract id (`'time'`, `'threshold'`, …) is what `FxSlot.params`
      // stores and what the live registry accepts; the registry owns the
      // slot-param -> AudioParam rename (delay `time` -> `delayTime`, EQ bands
      // -> `frequency`/`gain`/`q`). Resolving the AudioParam name here instead
      // would fork that table.
      slot.params = { ...slot.params, [update.paramId]: update.value };
      registry?.applyLiveParameter(update.trackId, update.slotId, update.paramId, update.value, now);
    } else if (target.type === 'mixer_send1' || target.type === 'mixer_send2') {
      const trackId = Number(target.targetId);
      const idx = target.type === 'mixer_send1' ? 0 : 1;
      const trk = mixerTracks.find(t => t.id === trackId);
      if (!trk || !trk.auxSends || !trk.auxSends[idx]) return;
      const clamped = Math.max(0, Math.min(1, value));
      trk.auxSends[idx].amount = clamped;
      const ch = this.mixerChannels.get(trackId);
      const gain = ch?.auxSendGains?.get(trk.auxSends[idx].targetId);
      if (gain) {
        if (typeof gain.gain.setTargetAtTime === 'function') {
          gain.gain.setTargetAtTime(clamped, now, 0.02);
        } else {
          gain.gain.value = clamped;
        }
      }
    }
  }

  /**
   * Phase 81: the live FX chain registry installed by
   * `installLiveFxChainHardening`, or `undefined` when no chain has been built
   * (playback never started, slot disabled, or the hardening is not installed).
   *
   * Callers must treat `undefined` as "the value is in the isolated take's
   * project state; the next chain rebuild or offline render will pick it up",
   * never as an error — that is the Phase 80 "state is the source of truth"
   * contract.
   */
  private getLiveFxChainRegistry(): {
    applyLiveMix(trackId: number, slotId: string, mix: number, currentTime: number): boolean;
    applyLiveParameter(trackId: number, slotId: string, paramName: string, value: number, currentTime: number): boolean;
  } | undefined {
    return (this as unknown as {
      __liveFxChainRegistry?: {
        applyLiveMix(trackId: number, slotId: string, mix: number, currentTime: number): boolean;
        applyLiveParameter(trackId: number, slotId: string, paramName: string, value: number, currentTime: number): boolean;
      };
    }).__liveFxChainRegistry;
  }

  /**
   * Phase 10B: Apply a slot.mix change to the live WetDry wrapper without
   * tearing down the active chain. Returns true when the patch supplied an
   * updated live WetDry, false when the caller must rebuild the chain (e.g.
   * stopped playback with no live instance) — the project state is updated
   * either way so the next chain rebuild picks up the value.
   */
  public setFxSlotMix(trackId: number, slotId: string, mix: number): boolean {
    if (this.shouldBlockLiveMutation()) return false;
    const bounded = Math.max(0, Math.min(1, Number(mix)));
    if (!Number.isFinite(bounded)) return false;
    const track = this.activeMixerTracks.find(t => t.id === trackId);
    if (track) {
      const slot = track.fxSlots.find(s => s.id === slotId);
      if (slot) slot.mix = bounded;
    }
    const now = this.ctx?.currentTime ?? 0;
    const registry = (this as unknown as {
      __liveFxChainRegistry?: {
        applyLiveMix(trackId: number, slotId: string, mix: number, currentTime: number): boolean;
      };
    }).__liveFxChainRegistry;
    return registry?.applyLiveMix(trackId, slotId, bounded, now) ?? false;
  }

  /**
   * Phase 80: Apply a single named FX parameter to the live AudioEffect
   * backing the slot on the given track, without rebuilding the chain.
   *
   * Returns true when the live chain accepted the new value (so the user
   * hears the change immediately). Returns false when:
   *   - the engine is offline-rendering or otherwise fenced,
   *   - the value is non-finite,
   *   - no live WetDry/effect exists for that slot (e.g. playback stopped
   *     and the chain hasn't been built yet),
   *   - the inner effect rejected the parameter (unknown name or
   *     out-of-range value — `BiquadFilterEffect.setParameter` throws
   *     `RangeError` for an out-of-range frequency, etc.).
   *
   * In all "false" cases the project state has already been updated (the
   * caller is expected to mutate ProjectState first), so the next chain
   * rebuild — or the next offline export — picks the value up. This is the
   * "state is the source of truth" property Phase 80 requires.
   */
  public setFxSlotParameter(
    trackId: number,
    slotId: string,
    paramName: string,
    value: number,
  ): boolean {
    if (this.shouldBlockLiveMutation()) return false;
    if (!Number.isFinite(value)) return false;
    if (typeof paramName !== 'string' || !paramName.trim()) return false;
    const track = this.activeMixerTracks.find(t => t.id === trackId);
    if (track) {
      const slot = track.fxSlots.find(s => s.id === slotId);
      if (slot) {
        slot.params = { ...slot.params, [paramName]: value };
      }
    }
    const now = this.ctx?.currentTime ?? 0;
    const registry = (this as unknown as {
      __liveFxChainRegistry?: {
        applyLiveParameter(
          trackId: number,
          slotId: string,
          paramName: string,
          value: number,
          currentTime: number,
        ): boolean;
      };
    }).__liveFxChainRegistry;
    return registry?.applyLiveParameter(trackId, slotId, paramName, value, now) ?? false;
  }

  public stopNote(voiceId: string) {
    if (this.shouldBlockLiveMutation()) return;
    if (this.activeVoices.has(voiceId)) {
      const voice = this.activeVoices.get(voiceId);
      voice?.stop();
      this.cleanupVoiceChannelVolume(voiceId);
      this.activeVoices.delete(voiceId);
      this.removeDrumPadChokeVoice(voiceId, voice);
    }
  }

  public stopChannelNote(channelId: string, pitch: number, midiChannel?: number): number {
    if (this.shouldBlockLiveMutation()) return 0;
    if (!Number.isFinite(pitch)) return 0;
    const normalizedPitch = Math.round(pitch);
    const prefix = midiChannel === undefined
      ? `${channelId}-${normalizedPitch}-`
      : `${channelId}-${normalizedPitch}-midi-${midiChannel}-`;
    let stopped = 0;
    for (const voiceId of Array.from(this.activeVoices.keys())) {
      if (voiceId.startsWith(prefix)) {
        this.stopNote(voiceId);
        stopped += 1;
      }
    }
    return stopped;
  }

  public stopChannelVoices(channelId: string): void {
    if (this.shouldBlockLiveMutation()) return;
    const prefix = `${channelId}-`;
    for (const [voiceId, voice] of this.activeVoices.entries()) {
      if (voiceId.startsWith(prefix)) {
        try {
          voice.stop();
        } catch (_) {}
        this.cleanupVoiceChannelVolume(voiceId);
        this.activeVoices.delete(voiceId);
        this.removeDrumPadChokeVoice(voiceId, voice);
      }
    }
  }



  // 2. 3-Osc Subtractive MiniSynth
  // --- Acoustic & Orchestral Instrument Synthesis Engines ---

































  public midiToFreq(midiNote: number): number {
    return 440 * Math.pow(2, (midiNote - 69) / 12);
  }

  public getDefaultSynthParams(): SynthParameters {
    return getDefaultSynthParamsValue();
  }

  // Metering & Visualizers
  public getMasterFrequencyData(array: Uint8Array) {
    if (this.isOfflineRendering) {
      array.fill(0);
      return;
    }
    if (this.masterAnalyser) {
      this.masterAnalyser.getByteFrequencyData(array);
    }
  }

  public getMasterWaveformData(array: Uint8Array) {
    if (this.isOfflineRendering) {
      array.fill(128);
      return;
    }
    if (this.masterAnalyser) {
      this.masterAnalyser.getByteTimeDomainData(array);
    }
  }

  public getMixerTrackPeak(trackId: number): number {
    if (this.isOfflineRendering) return 0;
    const channel = this.mixerChannels.get(trackId);
    if (!channel || !this.ctx) return 0;
    const array = new Uint8Array(128);
    channel.analyser.getByteTimeDomainData(array);
    let max = 0;
    for (let i = 0; i < array.length; i++) {
      const val = Math.abs(array[i] - 128) / 128;
      if (val > max) max = val;
    }
    return max;
  }

  // Real-time Audio Recorder (Microphone/Line-In)
  public async startAudioRecording(): Promise<MediaStream> {
    if (this.shouldBlockLiveMutation()) {
      throw new Error('Recording cannot start while an offline render is running.');
    }
    if (!this.ctx) await this.init();
    this.recordedChunks = [];

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }
    });

    this.mediaStream = stream;
    const source = this.ctx!.createMediaStreamSource(stream);
    this.recordingAnalyser = this.ctx!.createAnalyser();
    this.recordingAnalyser.fftSize = 256;
    source.connect(this.recordingAnalyser);

    this.mediaRecorder = new MediaRecorder(stream);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.recordedChunks.push(e.data);
      }
    };
    this.mediaRecorder.start();

    return stream;
  }

  public getRecordingPeak(): number {
    if (!this.recordingAnalyser) return 0;
    const array = new Uint8Array(128);
    this.recordingAnalyser.getByteTimeDomainData(array);
    let max = 0;
    for (let i = 0; i < array.length; i++) {
      const val = Math.abs(array[i] - 128) / 128;
      if (val > max) max = val;
    }
    return max;
  }

  public async stopAudioRecording(): Promise<AudioRecording> {
    return new Promise((resolve) => {
      if (!this.mediaRecorder) {
        resolve({
          id: `rec-${Date.now()}`,
          name: 'Take 1',
          timestamp: Date.now(),
          durationSeconds: 1,
          waveform: [0.2, 0.5, 0.8, 0.4, 0.1],
        });
        return;
      }

      this.mediaRecorder.onstop = async () => {
        const blob = new Blob(this.recordedChunks, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        
        // Stop stream tracks
        if (this.mediaStream) {
          this.mediaStream.getTracks().forEach(t => t.stop());
          this.mediaStream = null;
        }

        // Generate waveform preview
        const waveform = [0.1, 0.3, 0.6, 0.9, 0.7, 0.4, 0.8, 0.5, 0.2, 0.6, 0.3];

        const rec: AudioRecording = {
          id: `rec-${Date.now()}`,
          name: `Vocal Take ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
          timestamp: Date.now(),
          durationSeconds: 4,
          audioBlob: blob,
          audioUrl: url,
          waveform,
        };

        resolve(rec);
      };

      this.mediaRecorder.stop();
    });
  }

  // Web MIDI API Integration
  public async initMidi() {
    try {
      if (typeof navigator !== 'undefined' && navigator.requestMIDIAccess) {
        this.midiAccess = await navigator.requestMIDIAccess({ sysex: false });
        
        const attachInputs = () => {
          for (const input of this.midiAccess.inputs.values()) {
            input.onmidimessage = this.handleMidiMessage.bind(this);
          }
        };

        attachInputs();
        this.midiAccess.onstatechange = () => {
          attachInputs();
        };
      }
    } catch (err) {
      console.log('Web MIDI access not available or user denied permission');
    }
  }

  public getConnectedMidiDevices(): { id: string; name: string; manufacturer?: string; state: string; type: 'input' | 'output' }[] {
    const devices: { id: string; name: string; manufacturer?: string; state: string; type: 'input' | 'output' }[] = [];
    if (this.midiAccess) {
      for (const input of this.midiAccess.inputs.values()) {
        devices.push({
          id: input.id || `midi-in-${devices.length}`,
          name: input.name || 'Generic MIDI Controller',
          manufacturer: input.manufacturer || 'Hardware Device',
          state: input.state || 'connected',
          type: 'input'
        });
      }
      for (const output of this.midiAccess.outputs.values()) {
        devices.push({
          id: output.id || `midi-out-${devices.length}`,
          name: output.name || 'MIDI Out Port',
          manufacturer: output.manufacturer || 'Hardware Device',
          state: output.state || 'connected',
          type: 'output'
        });
      }
    }
    return devices;
  }

  public addMidiListener(listener: (e: MidiEventPayload) => void) {
    this.midiListeners.push(listener);
  }

  public removeMidiListener(listener: (e: MidiEventPayload) => void) {
    this.midiListeners = this.midiListeners.filter(l => l !== listener);
  }

  private handleMidiMessage(event: InternalMidiMessageEvent | MIDIMessageEvent) {
    const [status, data1, data2] = event.data;
    const command = status >> 4;
    const midiChannel = (status & 0xf) + 1;

    if (command === 9 && data2 > 0) {
      // Note On
      this.midiListeners.forEach(l => l({ type: 'noteOn', note: data1, velocity: data2 / 127, midiChannel }));
    } else if (command === 8 || (command === 9 && data2 === 0)) {
      // Note Off
      this.midiListeners.forEach(l => l({ type: 'noteOff', note: data1, midiChannel }));
    } else if (command === 11) {
      // Control Change (CC)
      this.midiListeners.forEach(l => l({ type: 'cc', cc: data1, value: data2 / 127, midiChannel }));
    } else if (command === 14) {
      // Pitch Bend
      const bendVal = ((data2 << 7) + data1 - 8192) / 8192;
      this.midiListeners.forEach(l => l({ type: 'pitchBend', value: bendVal, midiChannel }));
    }
  }

  /**
   * Offline timeline render used by export.
   *
   * `patternLengthSteps` is the declared `Pattern.lengthSteps` of the pattern a
   * Pattern Loop export renders. It is additive and optional: Song exports and
   * every existing caller keep their behaviour, and a Pattern export without it
   * resolves the loop from channel content exactly as before. When supplied it is
   * handed to the same `resolvePatternLoopLengthSteps()` Pattern Mode plays with,
   * so a pattern that declares 32 steps exports a 32-step loop even when steps
   * 16-31 hold no notes. Loop length is never re-derived here.
   */
  public async renderTimelineOffline(
    channels: Channel[],
    clips: PlaylistClip[],
    mixerTracks: MixerTrack[],
    bpm: number,
    totalBars: number,
    sampleRate?: number,
    includeMixerFx = false,
    renderScope: OfflineRenderScope = 'song',
    onProgress?: OfflineRenderProgress,
    patternLengthSteps?: number,
    playlistTracks?: PlaylistTrack[],
    minimumDurationSeconds: number = 4,
  ): Promise<AudioBuffer> {
    if (this.offlineRenderLeaseHeld) {
      throw new Error('An offline timeline render is already running.');
    }
    this.offlineRenderLeaseHeld = true;
    let transportToResume: AudioClockTransport | null = null;
    try {
      onProgress?.(15, `Preparing ${renderScope === 'pattern' ? 'pattern loop' : 'song'} export...`);

      // Phase 10A: a muted playlist lane must behave like a muted clip during
      // export — a missing audio buffer on a silenced lane should never fail the
      // export, and that lane's clips are dropped from the rendered WAV exactly
      // the way the live scheduler drops them at the trigger boundary.
      const offlineLaneMutes = this.derivePlaylistLaneMutes(playlistTracks);

      // Validate audio buffers for all audible audio clips.
      // Phase 8B (P1-4): an unresolvable or unavailable audio asset (placeholder
      // stem, missing buffer, or hydration-flagged `audioUnavailable`) must fail
      // the export up front instead of rendering a misleading silent WAV.
      // Phase 10A: lane-muted clips are silently dropped, so their missing
      // buffers must not fail the export — only audible clips are validated.
      // Phase 1M: inactive takes are silently dropped like muted-lane clips.
      const offlineInaudibleTakes = resolveInaudibleTakeClipIds(clips);
      for (const clip of clips) {
        if (clip.type === 'audio' && !clip.mute && !this.isClipPlaylistLaneMuted(clip, offlineLaneMutes) && !offlineInaudibleTakes.has(clip.id)) {
          if (!clip.audioBufferId) {
            throw new Error(
              `Audio clip "${clip.name || clip.audioName || clip.id}" is missing an audioBufferId.`
            );
          }
          if (clip.audioUnavailable) {
            throw new Error(
              `Audio clip "${clip.name || clip.audioName || clip.id}" (buffer ID: ${clip.audioBufferId}) references an unavailable audio asset; its persisted audio could not be restored.`
            );
          }
          const buffer = this.sampleBuffers.get(clip.audioBufferId);
          if (!buffer) {
            throw new Error(
              `Missing audio buffer for clip "${clip.name || clip.audioName || clip.id}" (buffer ID: ${clip.audioBufferId}). The audio asset is not loaded in memory.`
            );
          }
        }
      }

      const previous = {
        ctx: this.ctx,
        liveCtx: this.liveCtx,
        transport: this.transport,
        transportWasPlaying: this.transport?.getState().playing ?? false,
        masterGain: this.masterGain,
        masteringProcessor: this.masteringProcessor,
        masterAnalyser: this.masterAnalyser,
        grossBeatNode: this.grossBeatNode,
        mixerChannels: this.mixerChannels,
        channelPanners: this.channelPanners,
        impulseResponses: this.impulseResponses,
        activeVoices: this.activeVoices,
        activeVoiceChannelVolumes: this.activeVoiceChannelVolumes,
        activeDrumPadVoices: this.activeDrumPadVoices,
        activeClipSources: this.activeClipSources,
        activeClipSourceLanes: this.activeClipSourceLanes,
        activeClipSourceChannels: this.activeClipSourceChannels,
        activeClipChannelVolumes: this.activeClipChannelVolumes,
        isPlaying: this.isPlaying,
        activeChannels: this.activeChannels,
        activeClips: this.activeClips,
        activeMixerTracks: this.activeMixerTracks,
        mixerRoutingAdapter: this.mixerRoutingAdapter,
        mixerRoutingChannelMap: this.mixerRoutingChannelMap,
        playbackProjectChannels: this.playbackProjectChannels,
        playbackProjectMixerTracks: this.playbackProjectMixerTracks,
        activePlayMode: this.activePlayMode,
        activePatternId: this.activePatternId,
        activePatternLengthSteps: this.activePatternLengthSteps,
        currentStep: this.currentStep,
        currentBar: this.currentBar,
        bpm: this.bpm,
        metronome: this.metronome,
        playlistLaneMutes: this.playlistLaneMutes,
        sampleBuffers: this.sampleBuffers,
        projectOwnedSampleBufferIds: this.projectOwnedSampleBufferIds,
        sessionSampleBufferIds: this.sessionSampleBufferIds,
        liveSampleBuffersDuringOfflineRender: this.liveSampleBuffersDuringOfflineRender,
        liveProjectSampleBufferIdsDuringOfflineRender: this.liveProjectSampleBufferIdsDuringOfflineRender,
        liveSessionSampleBufferIdsDuringOfflineRender: this.liveSessionSampleBufferIdsDuringOfflineRender,
      };
      if (previous.transport && previous.transportWasPlaying) {
        transportToResume = previous.transport;
        previous.transport.stop(false);
      }
      const safeBpm = Math.max(20, Math.min(300, Number(bpm) || 120));
      const secondsPerStep = beatsToSeconds(stepsToBeats(1), safeBpm);
      const requestedMinimumDuration = Number.isFinite(minimumDurationSeconds) && minimumDurationSeconds >= 0
        ? minimumDurationSeconds
        : 4;
      // Phase 1F: the render window uses the resolved project meter, so a 3/4
      // export renders 12-step (1.5 s @ 120 BPM) bars exactly like live playback.
      const totalDurationSeconds = Math.max(
        requestedMinimumDuration,
        Math.max(1, totalBars) * beatsPerBar(this.meter) * beatsToSeconds(1, safeBpm),
      );
      const renderSampleRate = sampleRate ?? previous.ctx?.sampleRate ?? 44100;
      const OfflineContextClass =
        (typeof window !== 'undefined' && (window as unknown as WindowWithWebKitAudio).OfflineAudioContext) ||
        (typeof window !== 'undefined' && (window as unknown as WindowWithWebKitAudio).webkitOfflineAudioContext) ||
        (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
      if (!OfflineContextClass) {
        throw new Error('OfflineAudioContext is unavailable in this environment.');
      }
      const offlineCtx = new OfflineContextClass(
        2,
        Math.ceil(renderSampleRate * totalDurationSeconds),
        renderSampleRate,
      );
      this.isOfflineRendering = true;
      this.liveCtx = previous.ctx;
      try {
        this.withOfflineRenderOperation(() => {
          this.ctx = offlineCtx as unknown as AudioContext;
          this.transport = null;
          this.masterGain = offlineCtx.createGain();
          this.grossBeatNode = offlineCtx.createGain();
          this.masterAnalyser = offlineCtx.createAnalyser();
          this.masterAnalyser.fftSize = 512;
          this.masterAnalyser.smoothingTimeConstant = 0.8;
          const offlineSupportsMasteringDsp =
            typeof (offlineCtx as any).createChannelSplitter === 'function' &&
            typeof (offlineCtx as any).createChannelMerger === 'function' &&
            typeof (offlineCtx as any).createDynamicsCompressor === 'function' &&
            typeof (offlineCtx as any).createWaveShaper === 'function';
          this.masteringProcessor = offlineSupportsMasteringDsp
            ? new MasteringProcessor(offlineCtx as unknown as AudioContext, this.masteringState)
            : null;
          this.masterGain.connect(this.grossBeatNode);
          if (this.masteringProcessor) {
            this.grossBeatNode.connect(this.masteringProcessor.input);
            this.masteringProcessor.output.connect(this.masterAnalyser);
          } else {
            this.grossBeatNode.connect(this.masterAnalyser);
          }
          this.masterAnalyser.connect(offlineCtx.destination);
          this.mixerChannels = new Map();
          this.channelPanners = new Map();
          this.mixerRoutingAdapter = null;
          this.mixerRoutingChannelMap = null;
          this.impulseResponses = new Map();
          this.activeVoices = new Map();
          this.activeVoiceChannelVolumes = new Map();
          this.activeDrumPadVoices = new Map();
          this.activeClipSources = new Set();
          this.activeClipSourceLanes = new Map();
          this.activeClipSourceChannels = new Map();
          this.activeClipChannelVolumes = new Map();
          this.activeChannels = structuredClone(channels);
          this.activeClips = structuredClone(clips);
          this.refreshInaudibleTakeClipIds();
          this.playbackProjectChannels = structuredClone(channels);
          this.playbackProjectMixerTracks = [];
          this.activePlayMode = renderScope === 'pattern' ? 'pat' : 'song';
          this.sampleBuffers = new Map(previous.sampleBuffers);
          this.projectOwnedSampleBufferIds = new Set(previous.projectOwnedSampleBufferIds);
          this.sessionSampleBufferIds = new Set(previous.sessionSampleBufferIds);
          this.liveSampleBuffersDuringOfflineRender = previous.sampleBuffers;
          this.liveProjectSampleBufferIdsDuringOfflineRender = previous.projectOwnedSampleBufferIds;
          this.liveSessionSampleBufferIdsDuringOfflineRender = previous.sessionSampleBufferIds;
        });
        onProgress?.(40, `Offline graph ready (${renderScope === 'pattern' ? 'pattern' : 'song'} mode).`);
        this.activePatternId = undefined;
        // An offline Pattern render is its own take: it must not inherit (or leave
        // behind) the declared length of a live playback take.
        this.activePatternLengthSteps = renderScope === 'pattern' ? patternLengthSteps : undefined;
        this.isPlaying = true;
        this.currentStep = 0;
        this.currentBar = 1;
        this.bpm = safeBpm;
        this.metronome = false;

        // `includeMixerFx` decides whether the offline graph carries the mixer
        // inserts the user monitored, and with them any FX automation lane.
        //
        // Every production export states its intent explicitly, so nothing here
        // relies on the parameter default: the Export modal forwards the Phase 52
        // product default (`DEFAULT_INCLUDE_MIXER_FX === true`) to both the master
        // WAV render and `renderProjectStems`, and Bounce-In-Place passes `true`.
        // A normal export therefore renders the full FX graph.
        //
        // `false` is two things at once, both deliberate: the dry bounce a user
        // can still choose on purpose, and the engine-boundary default. Live mixer
        // FX (especially convolution and feedback delay) can make
        // OfflineAudioContext rendering disproportionately expensive, so an
        // internal caller that omits the argument gets the bounded graph rather
        // than an accidental full one. See
        // src/audio/phase81.offlineExportFxAutomation.test.ts.
        const tracks = [...mixerTracks].sort((a, b) => a.id - b.id);
        const renderTracks = includeMixerFx
          ? tracks
          : tracks.map(track => ({ ...track, fxSlots: [] }));
        this.activeMixerTracks = structuredClone(renderTracks);
        this.playbackProjectMixerTracks = structuredClone(renderTracks);
        // Phase 10A: share the project's lane-mute derivation with the offline
        // scheduler so the trigger boundary drops muted-lane clips the same way
        // the live `play()` boundary does. Without this, the offline renderer
        // would still call `playAudioClipWithFades` on muted-lane audio clips.
        this.playlistLaneMutes = offlineLaneMutes;
        this.withOfflineRenderOperation(() => {
          if (includeMixerFx) {
            // Phase 10A: a seeded impulse is required so offline exports are
            // byte-deterministic across runs. Only this offline branch seeds it —
            // the live engine builds its convolution impulse elsewhere and keeps
            // its existing non-deterministic tail.
            this.buildReverbImpulse(2.5, 2.0, { seed: 0x10a4eb });
          }
          const masterTrack = renderTracks.find(track => track.id === 0);
          if (masterTrack) this.updateMixerTrack(masterTrack); else this.getOrCreateMixerChannel(0);
          for (const track of renderTracks) if (track.id !== 0) this.updateMixerTrack(track);
          this.syncMixerRouting(renderTracks);
        });
        const totalSteps = Math.ceil(totalDurationSeconds / secondsPerStep);
        // A Pattern Loop export must wrap at the same boundary as Pattern Mode
        // playback, otherwise steps beyond the first bar render silence. Song
        // exports keep the one-bar grid the playlist is scheduled on. The declared
        // pattern length is passed to the same resolver playback uses, so a
        // declared 32-step pattern exports 32 steps even with an empty second bar.
        const patternLoopSteps = renderScope === 'pattern'
          ? resolvePatternLoopLengthSteps(this.activeChannels, patternLengthSteps, this.meter)
          : this.currentStepsPerBar;
        const scheduleStartProgress = 40;
        const scheduleEndProgress = 65;
        // Schedule the offline timeline in small cooperative batches so the browser
        // can service rendering/UI work instead of appearing unresponsive on longer exports.
        const offlineStepsPerBar = this.currentStepsPerBar;
        for (let globalStep = 0; globalStep < totalSteps; globalStep += 1) {
          this.currentStep = globalStep % patternLoopSteps;
          this.currentBar = Math.floor(globalStep / offlineStepsPerBar) + 1;
          // Same groove conversion the live scheduler uses, so an offline export
          // swings exactly as much as the take the user monitored.
          const swingOffsetSeconds = this.currentStep % 2 === 1
            ? swingOffsetSecondsForStep(this.swing, secondsPerStep)
            : 0;
          const audioTime = globalStep * secondsPerStep + swingOffsetSeconds;
          if (audioTime >= totalDurationSeconds) break;
          this.withOfflineRenderOperation(() => this.triggerCurrentStep(audioTime));
          if ((globalStep + 1) % 4 === 0 || globalStep === totalSteps - 1) {
            const scheduleProgress = scheduleStartProgress + Math.round(((globalStep + 1) / totalSteps) * (scheduleEndProgress - scheduleStartProgress));
            onProgress?.(scheduleProgress, `Scheduling ${renderScope === 'pattern' ? 'pattern' : 'song'} audio (${globalStep + 1}/${totalSteps} steps)...`);
          }

          if ((globalStep + 1) % 16 === 0 && globalStep + 1 < totalSteps) {
            await new Promise<void>(resolve => setTimeout(resolve, 0));
          }
        }
        onProgress?.(70, `Rendering offline audio (${totalDurationSeconds.toFixed(2)}s)...`);
        const renderedBuffer = await offlineCtx.startRendering();
        onProgress?.(85, 'Offline render complete. Encoding WAV...');
        return renderedBuffer;
      } finally {
        this.isOfflineRendering = false;
        this.liveCtx = previous.liveCtx;
        this.ctx = previous.ctx;
        this.transport = previous.transport;
        if (this.masteringProcessor && this.masteringProcessor !== previous.masteringProcessor) this.masteringProcessor.dispose();
        this.masteringProcessor = previous.masteringProcessor;
        this.masteringProcessor?.setState(this.masteringState);
        this.masterGain = previous.masterGain;
        this.masterAnalyser = previous.masterAnalyser;
        this.grossBeatNode = previous.grossBeatNode;
        this.mixerChannels = previous.mixerChannels;
        this.channelPanners = previous.channelPanners;
        this.mixerRoutingAdapter = previous.mixerRoutingAdapter;
        this.mixerRoutingChannelMap = previous.mixerRoutingChannelMap;
        this.impulseResponses = previous.impulseResponses;
        this.activeVoices = previous.activeVoices;
        this.activeVoiceChannelVolumes = previous.activeVoiceChannelVolumes;
        this.activeDrumPadVoices = previous.activeDrumPadVoices;
        this.activeClipSources = previous.activeClipSources;
        this.activeClipSourceLanes = previous.activeClipSourceLanes;
        this.activeClipSourceChannels = previous.activeClipSourceChannels;
        this.activeClipChannelVolumes = previous.activeClipChannelVolumes;
        this.isPlaying = previous.isPlaying;
        this.activeChannels = previous.activeChannels;
        this.activeClips = previous.activeClips;
        this.refreshInaudibleTakeClipIds();
        this.activeMixerTracks = previous.activeMixerTracks;
        this.playbackProjectChannels = previous.playbackProjectChannels;
        this.playbackProjectMixerTracks = previous.playbackProjectMixerTracks;
        this.activePlayMode = previous.activePlayMode;
        this.activePatternId = previous.activePatternId;
        this.activePatternLengthSteps = previous.activePatternLengthSteps;
        this.currentStep = previous.currentStep;
        this.currentBar = previous.currentBar;
        this.bpm = previous.bpm;
        this.metronome = previous.metronome;
        this.playlistLaneMutes = previous.playlistLaneMutes;
        this.sampleBuffers = previous.sampleBuffers;
        this.projectOwnedSampleBufferIds = previous.projectOwnedSampleBufferIds;
        this.sessionSampleBufferIds = previous.sessionSampleBufferIds;
        this.liveSampleBuffersDuringOfflineRender = previous.liveSampleBuffersDuringOfflineRender;
        this.liveProjectSampleBufferIdsDuringOfflineRender = previous.liveProjectSampleBufferIdsDuringOfflineRender;
        this.liveSessionSampleBufferIdsDuringOfflineRender = previous.liveSessionSampleBufferIdsDuringOfflineRender;
      }
    } finally {
      this.offlineRenderLeaseHeld = false;
      try {
        if (transportToResume) transportToResume.start();
      } finally {
        // The live engine is back and a resumed take is running again: this is
        // the moment the project document re-publishes itself, so a change made
        // during the render cannot be left behind on the offline side.
        this.notifyOfflineRenderComplete();
      }
    }
  }

  // High-Grade Offline Audio Renderer (WAV, MP3, MIDI, Stems)
  public async renderProjectToWav(
    channels: Channel[],
    clips: PlaylistClip[],
    bpm: number,
    totalBars: number,
    bitDepth: 16 | 24 | 32 = 24,
    mixerTracks?: MixerTrack[],
    includeMixerFx: boolean = false,
    playlistTracks?: PlaylistTrack[]
  ): Promise<Blob> {
    const renderedBuffer = await this.renderTimelineOffline(
      channels,
      clips,
      mixerTracks ?? [],
      bpm,
      totalBars,
      undefined,
      includeMixerFx,
      'song',
      undefined,
      undefined,
      playlistTracks
    );
    return this.audioBufferToWav(renderedBuffer, bitDepth);
  }

  // Multi-Track Offline Stem Exporter: Renders individual isolated tracks with real DSP & FX
  public async renderProjectStems(
    channels: Channel[],
    clips: PlaylistClip[],
    mixerTracksOrBpm: MixerTrack[] | number,
    bpmOrTotalBars?: number,
    totalBarsOrBitDepth?: number | (16 | 24 | 32),
    bitDepthParam?: 16 | 24 | 32,
    renderScope: OfflineRenderScope = 'song',
    patternLengthSteps?: number,
    playlistTracks?: PlaylistTrack[],
    includeMixerFx: boolean = false
  ): Promise<{ stems: Record<string, Blob>; master: Blob }> {
    let mixerTracks: MixerTrack[] = [];
    let bpm = 120;
    let totalBars = 4;
    let bitDepth: 16 | 24 | 32 = 24;

    if (Array.isArray(mixerTracksOrBpm)) {
      mixerTracks = mixerTracksOrBpm;
      bpm = Number(bpmOrTotalBars) || 120;
      totalBars = Number(totalBarsOrBitDepth) || 4;
      bitDepth = bitDepthParam ?? 24;
    } else {
      bpm = Number(mixerTracksOrBpm) || 120;
      totalBars = Number(bpmOrTotalBars) || 4;
      bitDepth = (totalBarsOrBitDepth as (16 | 24 | 32)) ?? 24;
      mixerTracks = [];
    }

    // Phase 10A: stems must honour playlist lane mutes exactly like the master
    // mix and the live scheduler — a muted lane is dropped before the stem
    // pipeline runs its per-clip filters, so a missing audio buffer on a
    // silenced lane never aborts the export.
    const stemLaneMutes = this.derivePlaylistLaneMutes(playlistTracks);

    // 1. Render Full Master Mix using verified offline timeline renderer
    const masterBuffer = await this.renderTimelineOffline(
      channels,
      clips,
      mixerTracks,
      bpm,
      totalBars,
      undefined,
      includeMixerFx,
      renderScope,
      undefined,
      patternLengthSteps,
      playlistTracks
    );
    const master = this.audioBufferToWav(masterBuffer, bitDepth);

    const stems: Record<string, Blob> = {};

    // 2. Render each channel stem
    for (const channel of channels) {
      const channelAudible = isRackChannelAudible(channel, channels);
      const effectiveChannel: Channel = channelAudible ? channel : { ...channel, mute: true };
      const channelClips = clips.filter(clip => {
        if (clip.mute) return false;
        if (this.isClipPlaylistLaneMuted(clip, stemLaneMutes)) return false;
        if (this.isClipTakeInactive(clip)) return false;
        if (clip.type === 'pattern') {
          return clip.channelId === channel.id;
        }
        if (clip.type === 'audio') {
          return clip.channelId === channel.id;
        }
        if (clip.type === 'automation') {
          const target = clip.automationTarget;
          if (!target) return false;
          return (
            String(target.targetId) === String(channel.id) ||
            this.automationClipTargetsMixerTrack(clip, channel.mixerTrackId)
          );
        }
        return false;
      });

      // Phase 88: a channel can feed a bus that owns the aux send. Strip sends
      // from the entire render snapshot so no downstream bus can leak wet audio
      // into a nominally dry channel stem.
      const dryMixerTracks = buildDryStemMixerTracks(mixerTracks);
      const stemBuffer = await this.renderTimelineOffline(
        [effectiveChannel],
        channelClips,
        dryMixerTracks,
        bpm,
        totalBars,
        undefined,
        includeMixerFx,
        renderScope,
        undefined,
        patternLengthSteps,
        playlistTracks
      );

      const cleanName = (channel.name || `Channel_${channel.id}`).replace(/[^a-zA-Z0-9_-]/g, '_');
      stems[`${channel.id}_${cleanName}.wav`] = this.audioBufferToWav(stemBuffer, bitDepth);
    }

    // Phase 88: render wet stems for each aux return (isAux or targeted by any auxSend)
    {
      const auxiliaryTrackIds = new Set<number>();
      for (const t of mixerTracks) {
        if ((t as unknown as { isAux?: unknown }).isAux === true) auxiliaryTrackIds.add(t.id);
        for (const s of t.auxSends ?? []) auxiliaryTrackIds.add(s.targetId);
      }
      const auxReturns = mixerTracks.filter(t => auxiliaryTrackIds.has(t.id));
      const DUMMY_SILENT_ID = 9999;
      const dummyExists = mixerTracks.some(t => t.id === DUMMY_SILENT_ID);
      for (const ret of auxReturns) {
        // Keep direct senders distinct (their outputs are diverted to silence),
        // but include every upstream track routed into those senders when selecting
        // channels for the wet render (e.g. instrument -> subgroup -> reverb).
        const sourceMixerIds = getDirectAuxSendSourceIds(mixerTracks, ret.id);
        if (sourceMixerIds.size === 0) continue;
        const wetSourceMixerIds = getUpstreamMixerTrackIds(mixerTracks, sourceMixerIds);
        const sourceChannelIds = new Set(channels.filter(c => wetSourceMixerIds.has(c.mixerTrackId)).map(c => c.id));
        if (sourceChannelIds.size === 0) continue;
        const wetChannels = channels.filter(c => sourceChannelIds.has(c.id)).map(c => {
          const audible = isRackChannelAudible(c, channels);
          return audible ? c : { ...c, mute: true } as typeof c;
        });
        const wetClips = clips.filter(clip => {
          if (clip.mute) return false;
          if (this.isClipPlaylistLaneMuted(clip, stemLaneMutes)) return false;
          if (this.isClipTakeInactive(clip)) return false;
          if (clip.type === 'pattern' || clip.type === 'audio') {
            return !!clip.channelId && sourceChannelIds.has(clip.channelId);
          }
          if (clip.type === 'automation' && clip.automationTarget) {
            const tgt = clip.automationTarget as unknown as { targetId: unknown };
            // include automation that targets source tracks or the return itself
            const tid = Number(tgt.targetId);
            if (wetSourceMixerIds.has(tid) || tid === ret.id) return true;
            if (sourceChannelIds.has(String(tgt.targetId))) return true;
            // also fx_param composite
            if (typeof tgt.targetId === 'string' && (tgt.targetId as string).includes('/')) {
              const part = Number((tgt.targetId as string).split('/')[0]);
              if (wetSourceMixerIds.has(part) || part === ret.id) return true;
            }
            return false;
          }
          return false;
        });
        if (wetChannels.length === 0 && wetClips.length === 0) continue;
        // Build wet mixer graph: source direct goes to dummy silent, aux -> return -> master
        // Isolate this return: remove sends to every other return, including
        // sends owned by upstream buses, while preserving this return's path.
        const wetMixerTracks: typeof mixerTracks = buildWetStemMixerTracks(
          mixerTracks,
          sourceMixerIds,
          ret.id,
          DUMMY_SILENT_ID
        );
        if (!dummyExists && !wetMixerTracks.some(t => t.id === DUMMY_SILENT_ID)) {
          wetMixerTracks.push({
            id: DUMMY_SILENT_ID,
            name: 'Silent Dummy',
            color: '#000000',
            volume: 0,
            pan: 0,
            mute: false,
            solo: false,
            peakL: 0,
            peakR: 0,
            fxSlots: [],
            routingTargetId: 0,
          } as unknown as typeof mixerTracks[0]);
        }
        try {
          const wetBuffer = await this.renderTimelineOffline(
            wetChannels,
            wetClips,
            wetMixerTracks,
            bpm,
            totalBars,
            undefined,
            includeMixerFx,
            renderScope,
            undefined,
            patternLengthSteps,
            playlistTracks
          );
          const cleanRetName = (ret.name || `Return_${ret.id}`).replace(/[^a-zA-Z0-9_-]/g, '_');
          stems[`return_${ret.id}_${cleanRetName}.wav`] = this.audioBufferToWav(wetBuffer, bitDepth);
        } catch (e) {
          console.warn('[AudioEngine] Wet return stem render failed', { returnId: ret.id, error: String(e) });
        }
      }
    }

    // 3. Render unassociated audio clips (recordings / samples not assigned to a channel)
    // Group them by playlist trackIndex
    const channelIds = new Set(channels.map(c => c.id));
    const unassociatedAudioClips = clips.filter(
      clip =>
        clip.type === 'audio' &&
        !clip.mute &&
        !this.isClipPlaylistLaneMuted(clip, stemLaneMutes) &&
        !this.isClipTakeInactive(clip) &&
        (!clip.channelId || !channelIds.has(clip.channelId))
    );

    const clipsByTrack = new Map<number, PlaylistClip[]>();
    for (const clip of unassociatedAudioClips) {
      const trackIdx = Number.isFinite(clip.trackIndex) ? Math.floor(clip.trackIndex) : 0;
      const list = clipsByTrack.get(trackIdx) || [];
      list.push(clip);
      clipsByTrack.set(trackIdx, list);
    }

    for (const [trackIdx, trackClips] of clipsByTrack.entries()) {
      const mixerTrackId = Math.max(1, trackIdx + 1);
      const trackAutomationClips = clips.filter(clip => {
        if (clip.mute || clip.type !== 'automation' || !clip.automationTarget) return false;
        if (this.isClipPlaylistLaneMuted(clip, stemLaneMutes)) return false;
        if (this.isClipTakeInactive(clip)) return false;
        return this.automationClipTargetsMixerTrack(clip, mixerTrackId);
      });

      const stemBuffer = await this.renderTimelineOffline(
        [],
        [...trackClips, ...trackAutomationClips],
        mixerTracks,
        bpm,
        totalBars,
        undefined,
        includeMixerFx,
        renderScope,
        undefined,
        patternLengthSteps,
        playlistTracks
      );

      const trackNum = trackIdx + 1;
      const trackClipNames = trackClips.map(c => c.name || c.audioName).filter(Boolean);
      const firstClipName = trackClipNames[0] || `Audio_Track_${trackNum}`;
      const cleanName = firstClipName.replace(/[^a-zA-Z0-9_-]/g, '_');
      stems[`track_${trackNum}_${cleanName}.wav`] = this.audioBufferToWav(stemBuffer, bitDepth);
    }

    return { stems, master };
  }

  // AudioBuffer to Lossless WAV encoder with IEEE Float or PCM Header
  private audioBufferToWav(buffer: AudioBuffer, bitDepth: 16 | 24 | 32): Blob {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = bitDepth === 32 ? 3 : 1; // 3 = IEEE Float, 1 = PCM
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;

    const dataLength = buffer.length * blockAlign;
    const bufferLength = 44 + dataLength;
    const arrayBuffer = new ArrayBuffer(bufferLength);
    const view = new DataView(arrayBuffer);

    // RIFF identifier
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    this.writeString(view, 8, 'WAVE');
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, format, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);
    this.writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // Interleave left and right channels
    const left = buffer.getChannelData(0);
    const right = numChannels > 1 ? buffer.getChannelData(1) : left;

    let offset = 44;
    for (let i = 0; i < buffer.length; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = ch === 0 ? left[i] : right[i];
        const clamped = Math.max(-1, Math.min(1, sample));

        if (bitDepth === 16) {
          view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
          offset += 2;
        } else if (bitDepth === 24) {
          const val = clamped < 0 ? clamped * 0x800000 : clamped * 0x7fffff;
          view.setUint8(offset, val & 0xff);
          view.setUint8(offset + 1, (val >> 8) & 0xff);
          view.setUint8(offset + 2, (val >> 16) & 0xff);
          offset += 3;
        } else {
          view.setFloat32(offset, clamped, true);
          offset += 4;
        }
      }
    }

    return new Blob([view], { type: 'audio/wav' });
  }

  private writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  // --- Transport & Sequencer Loop ---
  private bpm: number = 128;
  /**
   * Phase 1F — the resolved project meter. It owns the runtime BAR SIZE:
   * steps per bar, seconds per bar, bar boundaries for transport/scheduler,
   * playlist clip scheduling, offline render, bounce and fades. It never
   * rewrites absolute step quantities (`Pattern.lengthSteps`, `offsetSteps`).
   * Defaults to the legacy 4/4 grid; App publishes the project value with
   * `setTimeSignature`, and unsupported/missing metadata resolves to [4,4].
   * Content EXTENT stays owned by the Phase 1E resolver, which receives this
   * meter only as its bar-rounding unit.
   */
  private meter: TimeSignature = LEGACY_TIME_SIGNATURE;
  /**
   * Project swing as the project document stores it: a 0..0.5 fraction where
   * 0.5 is the Channel Rack's "100 %". It is never converted to a 0..100 scale —
   * `swingOffsetSecondsForStep` owns the conversion so the live scheduler and
   * the offline renderer cannot disagree about the unit.
   */
  private swing: number = 0;
  private metronome: boolean = false;
  /** Phase 1J: 7/8 accent grouping and the cached pulse layout it produces. */
  private sevenEightGrouping: SevenEightGrouping = DEFAULT_SEVEN_EIGHT_GROUPING;
  private metronomePulseLayout: MeterPulseLayout | null = null;
  /** Phase 1J: clicks scheduled ahead of the audio clock, cancelled on stop/seek/pause. */
  private activeMetronomeClicks: Set<OscillatorNode> = new Set();
  /**
   * Phase 1K — recording count-in.
   *
   * `countInBars` is the persisted project setting (0 = Off, 1, 2). The
   * scheduler owns its click oscillators in its own handle list (NOT in
   * `activeMetronomeClicks`): count-in clicks are an explicit recording
   * affordance and must keep sounding even when the metronome toggle is off,
   * while stop/pause/seek cancel them through `cancelRecordingCountIn()`.
   */
  private countInBars: CountInBars = 0;
  private countInScheduler: CountInScheduler | null = null;
  /**
   * Phase 1L — punch-in / punch-out recording.
   *
   * `punchRecording` is the persisted project setting (`meta.punchRecording`,
   * bar/beat anchored). The capture window owns only the punch-out stop moment;
   * capture itself stays in the one `RecordingEngine` path and the pre-roll
   * stays in the one `CountInScheduler`.
   */
  private punchRecording: PunchRecordingSettings = DEFAULT_PUNCH_RECORDING;
  private punchWindow: PunchCaptureWindow | null = null;
  private activePunchTake: { plan: PunchCapturePlan; phase: 'pre-roll' | 'capture' } | null = null;
  private isPlaying: boolean = false;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private currentStep: number = 0;
  private currentBar: number = 1;
  private stepCallback: ((step: number, bar: number) => void) | null = null;
  private transportStateCallback: ((state: Readonly<TransportState>) => void) | null = null;
  private activeChannels: Channel[] = [];
  private activeClips: PlaylistClip[] = [];
  private activeMixerTracks: MixerTrack[] = [];
  /** Last project-owned values supplied to the active playback take. */
  private playbackProjectChannels: Channel[] = [];
  private playbackProjectMixerTracks: MixerTrack[] = [];
  private activePlayMode: 'pat' | 'song' = 'pat';
  private activePatternId?: string;
  /** Declared `Pattern.lengthSteps` of the pattern the active take is looping. */
  private activePatternLengthSteps?: number;

  public setBpm(bpm: number) {
    if (this.shouldBlockLiveMutation()) return;
    this.bpm = Math.max(20, Math.min(300, bpm));
    if (this.transport) {
      this.transport.setBpm(this.bpm);
    }
    // Phase 1K: a tempo change re-times the remaining count-in clicks in
    // place — the musical capture position is unchanged, only its wall-clock
    // moment moves. Stale scheduled clicks are stopped inside the scheduler.
    this.countInScheduler?.retime(this.bpm);
    // Phase 1L: the same rule for an armed punch take — the punched length is
    // musical, so the remaining beats are re-measured at the new tempo instead
    // of the take being cut short (or over-run) by the change.
    this.punchWindow?.retime(this.bpm);
  }

  /**
   * Phase 1F/1I — publish the project's time signature to the runtime.
   *
   * The value goes through the single meter resolution authority, so missing
   * or unsupported metadata keeps the legacy 4/4 grid and a supported meter
   * (3/4, mechanical 6/8, or 7/8) becomes the truthful bar size for playback,
   * scheduling, offline render and bounce. The running transport remaps its
   * bar grid in place; the next take also receives the meter in `play()`.
   */
  public setTimeSignature(meter: TimeSignature | readonly [number, number] | undefined) {
    if (this.shouldBlockLiveMutation()) return;
    const resolved = resolveProjectTimeSignature({ timeSignature: meter });
    if (resolved[0] === this.meter[0] && resolved[1] === this.meter[1]) return;
    this.meter = resolved;
    if (this.transport) {
      this.transport.setTimeSignature(resolved);
    }
    // Phase 1L: punch positions are bar-anchored, so a meter change moves the
    // moment the user chose. A punch take planned under the old meter would
    // capture the wrong bars, so it is aborted (and the UI says so) rather than
    // silently re-targeted. This runs before the count-in restart below, which
    // then finds nothing to restart.
    this.cancelPunchRecording();
    // Phase 1K: "N bars" of count-in no longer describes the same musical
    // length after a meter change, so the count-in restarts under the new
    // bar grid from the change point (its waiting promise survives).
    this.countInScheduler?.restart(this.getMetronomePulseLayout());
  }

  /** The meter the runtime currently plays with (always a resolved value). */
  public getTimeSignature(): TimeSignature {
    return this.meter;
  }

  /** Runtime bar size in sixteenth-note steps under the resolved meter. */
  private get currentStepsPerBar(): number {
    return stepsPerBar(this.meter);
  }

  /** Runtime bar duration in seconds under the resolved meter at `bpm`. */
  private secondsPerBarAt(bpm: number): number {
    return beatsToSeconds(beatsPerBar(this.meter), bpm);
  }

  /**
   * Accepts `ProjectMetadata.swing` (the 0..0.5 project fraction) unchanged.
   *
   * The transport does not need to be rebuilt: both scheduler offsets read this
   * value every step, so a swing edit is audible on the next step.
   */
  public setSwing(swing: number) {
    if (this.shouldBlockLiveMutation()) return;
    this.swing = clampProjectSwing(swing);
  }

  public setMetronome(enabled: boolean) {
    if (this.shouldBlockLiveMutation()) return;
    this.metronome = enabled;
    // Turning the click off must also silence clicks already scheduled inside
    // the transport look-ahead window.
    if (!enabled) this.cancelScheduledMetronomeClicks();
  }

  /**
   * Phase 1J — the 7/8 accent grouping (`ProjectMetadata.sevenEightGrouping`).
   * Unknown values resolve to the 2+2+3 default. Takes effect from the next
   * scheduled step; the grouping is ignored in 4/4, 3/4 and 6/8.
   */
  public setSevenEightGrouping(grouping: SevenEightGrouping | string | undefined) {
    if (this.shouldBlockLiveMutation()) return;
    const resolved = isSevenEightGrouping(grouping) ? grouping : DEFAULT_SEVEN_EIGHT_GROUPING;
    if (resolved === this.sevenEightGrouping) return;
    this.sevenEightGrouping = resolved;
    this.metronomePulseLayout = null;
    // Phase 1K: the accent grouping is part of the count-in's click pattern.
    // Same meter → pending clicks keep their times and only their accents
    // update (the capture offset never moves with an accent grouping).
    this.countInScheduler?.regroup(this.getMetronomePulseLayout());
  }

  public getSevenEightGrouping(): SevenEightGrouping {
    return this.sevenEightGrouping;
  }

  /** Phase 1J — the pulse layout the metronome clicks for the resolved meter. */
  public getMetronomePulseLayout(): MeterPulseLayout {
    const cached = this.metronomePulseLayout;
    if (cached && cached.meter[0] === this.meter[0] && cached.meter[1] === this.meter[1]) return cached;
    const layout = resolveMeterPulseLayout(this.meter, this.sevenEightGrouping);
    this.metronomePulseLayout = layout;
    return layout;
  }

  /** Stops (or pre-empts) every click that has been scheduled but not finished. */
  private cancelScheduledMetronomeClicks(): void {
    if (this.activeMetronomeClicks.size === 0) return;
    const now = this.ctx?.currentTime ?? 0;
    for (const osc of Array.from(this.activeMetronomeClicks)) {
      // stop(now) before the scheduled start means the click never sounds.
      try { osc.stop(now); } catch (_) { /* already stopped */ }
      try { osc.disconnect(); } catch (_) { /* already disconnected */ }
    }
    this.activeMetronomeClicks.clear();
  }

  // --- Phase 1K: recording count-in / pre-roll -----------------------------

  /**
   * Phase 1K — the recording count-in length in bars: 0 (Off), 1 or 2.
   * Unknown values resolve to Off (see `resolveCountInBars`).
   */
  public setCountInBars(bars: CountInBars | number | undefined): void {
    if (this.shouldBlockLiveMutation()) return;
    this.countInBars = resolveCountInBars({ countInBars: bars });
  }

  public getCountInBars(): CountInBars {
    return this.countInBars;
  }

  /** True while a count-in is counting down to its capture moment. */
  public isCountInRunning(): boolean {
    return this.countInScheduler?.isRunning ?? false;
  }

  /**
   * Phase 1K — runs the recording count-in and resolves exactly when capture
   * must begin.
   *
   * The count-in clicks `bars` full bars of the ACTIVE meter's pulse layout
   * (project tempo, time signature and 7/8 accent grouping) starting from the
   * next bar line of the transport grid. The resolved `captureBar` /
   * `clipStartBar` describe the musical position capture begins on, so the
   * recorded take can be placed at exactly that bar.
   *
   * With `bars = 0` (or the project setting Off) this resolves at the current
   * position and schedules no clicks — the pre-Phase-1K immediate start.
   *
   * Lifecycle guarantees:
   *   - a second call while a count-in is running THROWS instead of scheduling
   *     a duplicate click set;
   *   - `stop()`, `pause()`, `seek()` and `cancelRecordingCountIn()` reject the
   *     waiting promise with `CountInCancelledError` and silence every pending
   *     click (no stale timers, no late clicks, no capture offset);
   *   - a tempo change re-times the remaining clicks in place; a meter or
   *     grouping change restarts the count-in under the new layout. Either
   *     way the promise still resolves one full count-in after the audible
   *     clicks, so `captureBar` is correct when capture begins.
   *   - count-in clicks are pure audio events: no note, step or pattern data
   *     is written, and the caller must not start `MediaRecorder` before this
   *     promise resolves (which is what keeps clicks out of the recorded take).
   */
  public beginRecordingCountIn(bars?: CountInBars | number): Promise<RecordingCountInResult> {
    if (this.shouldBlockLiveMutation()) {
      return Promise.reject(new Error('Recording is unavailable while an offline render is running'));
    }
    const resolvedBars = resolveCountInBars({ countInBars: bars ?? this.countInBars });
    if (!this.ctx) this.init();
    const ctx = this.ctx;
    if (!ctx) return Promise.reject(new Error('Audio context unavailable for the recording count-in'));
    if (ctx.state === 'suspended') void ctx.resume();
    const plan = planCountInCapturePosition(this.transportPositionBeats(), this.meter, resolvedBars);
    const scheduler = this.ensureCountInScheduler();
    // Throws synchronously when a count-in already runs — a double-pressed
    // Record button must never schedule a second click set.
    const started = scheduler.start({
      bars: resolvedBars,
      layout: this.getMetronomePulseLayout(),
      bpm: this.bpm,
      startBeat: plan.startBeat,
    });
    return started.then(result => {
      // Bar numbers are derived at resolve time so a restart (meter change)
      // during the count-in reports the capture position that actually
      // happened, not the one planned before the change.
      const barsInfo = captureBarNumbers(result.captureBeat, result.schedule.layout.meter);
      return {
        ...result,
        bars: resolvedBars,
        captureBar: barsInfo.captureBar,
        clipStartBar: barsInfo.clipStartBar,
      };
    });
  }

  /**
   * Phase 1K — aborts an active count-in: pending clicks are silenced and the
   * waiting recorder promise rejects with `CountInCancelledError` (no take).
   */
  public cancelRecordingCountIn(): void {
    this.countInScheduler?.cancel();
  }

  private ensureCountInScheduler(): CountInScheduler {
    if (this.countInScheduler) return this.countInScheduler;
    const scheduleTimer = (fn: () => void, delayMs: number): unknown =>
      typeof window !== 'undefined' ? window.setTimeout(fn, delayMs) : setTimeout(fn, delayMs);
    const clearTimer = (handle: unknown): void => {
      if (typeof window !== 'undefined') window.clearTimeout(handle as number);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
    };
    this.countInScheduler = new CountInScheduler({
      now: () => this.ctx?.currentTime ?? 0,
      scheduleClick: (time, level) => {
        const context = this.ctx;
        if (!context) throw new Error('Audio context unavailable for the count-in click');
        return scheduleMetronomeClick(context, this.masterGain || context.destination, time, level);
      },
      setTimer: scheduleTimer,
      clearTimer,
    });
    return this.countInScheduler;
  }

  // --- Phase 1L: punch-in / punch-out recording ----------------------------

  /**
   * Phase 1L — the persisted punch setting, published like the count-in.
   * Missing or malformed values resolve to the disabled default, so a project
   * saved before Phase 1L keeps recording ordinary takes.
   */
  public setPunchRecording(settings: unknown): void {
    if (this.shouldBlockLiveMutation()) return;
    this.punchRecording = resolvePunchRecording({ punchRecording: settings });
  }

  public getPunchRecording(): PunchRecordingSettings {
    return this.punchRecording;
  }

  public isPunchRecordingEnabled(): boolean {
    return this.punchRecording.enabled;
  }

  /** True while a punch take is counting in or capturing. */
  public isPunchTakeActive(): boolean {
    return this.activePunchTake !== null;
  }

  /** The punch window currently being captured, or null. */
  public getActivePunchPlan(): PunchCapturePlan | null {
    return this.activePunchTake?.plan ?? null;
  }

  /**
   * Phase 1L — plans a punch take without arming anything.
   *
   * The same pure policy the UI validates with (`src/music/punchRecording.ts`),
   * read against the engine's live tempo, meter and 7/8 grouping so the plan
   * the recorder arms is the plan the transport and the count-in will execute.
   * Throws `RangeError` for an invalid window instead of planning a take of the
   * wrong music.
   */
  public planPunchTake(options: { settings?: unknown; countInBars?: unknown; totalBars?: number } = {}): PunchCapturePlan {
    const settings = resolvePunchRecording({ punchRecording: options.settings ?? this.punchRecording });
    return planPunchCapture({
      settings,
      meter: this.meter,
      grouping: this.sevenEightGrouping,
      totalBars: Number.isFinite(options.totalBars) && (options.totalBars as number) > 0
        ? (options.totalBars as number)
        : 0,
      countInBars: options.countInBars ?? this.countInBars,
      bpm: this.bpm,
    });
  }

  /**
   * Phase 1L — arms one punch take: pre-roll first, capture second, punch-out
   * scheduled.
   *
   * The pre-roll is the existing Phase 1K count-in, planned BACKWARDS from the
   * punch-in (`startBeat = punchIn - countInBeats`), so the scheduler's capture
   * moment is exactly the punch-in. `RecordingEngine.start()` must only run
   * after the returned promise resolves — that is what keeps count-in clicks and
   * any other pre-roll audio out of the take. `punchOut` then resolves at the
   * punch-out moment, where the caller stops capture.
   *
   * Lifecycle guarantees:
   *   - a stale take is cancelled before a new one is armed, and a second
   *     `beginRecordingCountIn` while one runs still throws, so a double-pressed
   *     Record can never arm two recorders or two stop moments;
   *   - the playhead is moved to the pre-roll start, so the transport position
   *     and the take's musical position agree (this runs BEFORE anything is
   *     armed, because `seek()` cancels count-ins and punch takes);
   *   - `stop()`, `pause()`, `seek()` and `cancelPunchRecording()` abort both
   *     phases: pending count-in clicks are silenced, the stop moment is
   *     cleared and the waiting promise rejects (no take, no partial offset);
   *   - a tempo change re-times the remaining pre-roll and the remaining punch
   *     window in place, preserving both musical lengths;
   *   - a meter change aborts the take: `meta.punchRecording` is bar-anchored,
   *     so bar 9 beat 1 now means a different moment, and the capture position
   *     the user chose no longer exists. Cancelling is the only honest answer;
   *   - the arrangement running out aborts a take that has not started
   *     capturing; an armed capture window already ends at the project end.
   */
  public beginPunchRecording(options: { settings?: unknown; countInBars?: unknown; totalBars?: number } = {}): Promise<PunchRecordingSession> {
    if (this.shouldBlockLiveMutation()) {
      return Promise.reject(new Error('Recording is unavailable while an offline render is running'));
    }
    const settings = resolvePunchRecording({ punchRecording: options.settings ?? this.punchRecording });
    if (!settings.enabled) {
      return Promise.reject(new Error('Punch recording is off: enable it before starting a punch take'));
    }
    let plan: PunchCapturePlan;
    try {
      plan = planPunchCapture({
        settings,
        meter: this.meter,
        grouping: this.sevenEightGrouping,
        totalBars: Number.isFinite(options.totalBars) && (options.totalBars as number) > 0
          ? (options.totalBars as number)
          : 0,
        countInBars: options.countInBars ?? this.countInBars,
        bpm: this.bpm,
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Invalid punch recording range'));
    }
    if (!this.ctx) this.init();
    const ctx = this.ctx;
    if (!ctx) return Promise.reject(new Error('Audio context unavailable for punch recording'));
    if (ctx.state === 'suspended') void ctx.resume();

    // Drop any stale take (and its count-in / stop moment) before arming.
    this.cancelPunchRecording();
    // Park the playhead at the pre-roll start so the transport and the take
    // agree on position. Must happen before arming: seek() cancels takes.
    if (plan.countInStartBeat > 1e-9 && this.transport) {
      this.seek(beatsToSeconds(plan.countInStartBeat, this.bpm));
    }

    const take: { plan: PunchCapturePlan; phase: 'pre-roll' | 'capture' } = { plan, phase: 'pre-roll' };
    this.activePunchTake = take;
    const scheduler = this.ensureCountInScheduler();
    const started = scheduler.start({
      bars: plan.countInBars,
      layout: this.getMetronomePulseLayout(),
      bpm: this.bpm,
      startBeat: plan.countInStartBeat,
    });
    // A count-in that never reaches capture (stop/seek/cancel) leaves no armed
    // take behind. This handler only clears bookkeeping; the caller's await on
    // the returned promise still sees the rejection.
    void started.catch(() => {
      if (this.activePunchTake === take) this.activePunchTake = null;
    });

    return started.then(result => {
      if (this.activePunchTake !== take) throw new PunchCancelledError();
      take.phase = 'capture';
      const punchOut = this.ensurePunchWindow().arm({
        captureTime: result.captureTime,
        durationBeats: plan.captureDurationBeats,
        bpm: this.bpm,
      });
      // A take that reached its punch-out — or was cancelled — is finished, so
      // the engine must stop reporting it as armed. `isPunchTakeActive()` is
      // what the transport lifecycle checks, and a stale "armed" flag would
      // make a later stop/seek cancel a take that no longer exists.
      void punchOut.then(
        () => { if (this.activePunchTake === take) this.activePunchTake = null; },
        () => { if (this.activePunchTake === take) this.activePunchTake = null; },
      );
      return { plan, captureTime: result.captureTime, punchOut };
    });
  }

  /**
   * Phase 1L — aborts an armed punch take: pending pre-roll clicks are
   * silenced, the punch-out moment is cleared and every waiting promise
   * rejects. Idempotent, and a no-op for an ordinary (non-punch) count-in.
   */
  public cancelPunchRecording(): void {
    if (!this.activePunchTake) return;
    this.activePunchTake = null;
    this.countInScheduler?.cancel();
    this.punchWindow?.cancel();
  }

  /**
   * The arrangement ran out before punch-in. Only a take that has not started
   * capturing is cancelled: an armed capture window already ends at the project
   * end, so cancelling it would discard a complete take.
   */
  private cancelPunchPreRoll(): void {
    if (this.activePunchTake?.phase !== 'pre-roll') return;
    this.cancelPunchRecording();
  }

  private ensurePunchWindow(): PunchCaptureWindow {
    if (this.punchWindow) return this.punchWindow;
    const scheduleTimer = (fn: () => void, delayMs: number): unknown =>
      typeof window !== 'undefined' ? window.setTimeout(fn, delayMs) : setTimeout(fn, delayMs);
    const clearTimer = (handle: unknown): void => {
      if (typeof window !== 'undefined') window.clearTimeout(handle as number);
      else clearTimeout(handle as ReturnType<typeof setTimeout>);
    };
    this.punchWindow = new PunchCaptureWindow({
      now: () => this.ctx?.currentTime ?? 0,
      setTimer: scheduleTimer,
      clearTimer,
    });
    return this.punchWindow;
  }

  /** Musical position of the transport in quarter beats (0 when never played). */
  private transportPositionBeats(): number {
    const state = this.transport?.getState();
    if (!state) return 0;
    return (state.positionSeconds * this.bpm) / 60;
  }

  /**
   * Phase 79: apply `ProjectMetadata.masterVolume` to the master bus gain.
   * This was previously a persisted-but-inert value (documented as such in
   * midiMappingRuntime). Wiring it here is a one-line setTargetAtTime — no
   * new DSP, just the same master-gain automation already uses — so it
   * satisfies "wire if trivial".
   */
  /** Phase 89: keep the live and offline master processors synchronized with project state. */
  public setMasteringState(state: MasteringSuiteState): void {
    this.masteringState = normalizeMasteringSuiteState(state);
    if (!this.isOfflineRendering) this.masteringProcessor?.setState(this.masteringState);
  }

  public setMasterVolume(linearGain: number) {
    if (this.shouldBlockLiveMutation() || !this.ctx || !this.masterGain) return;
    const clamped = Math.max(0, Math.min(1.5, linearGain));
    this.masterGain.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.02);
  }

  public setStepCallback(cb: (step: number, bar: number) => void) {
    this.stepCallback = cb;
  }

  public setTransportStateCallback(cb: ((state: Readonly<TransportState>) => void) | null) {
    this.transportStateCallback = cb;
  }

  /**
   * Creates an isolated copy of the project data a playback take runs on.
   * The scheduler mutates channel volume/pan/filter values while evaluating
   * automation, so playback must operate on clones: live automation must
   * never write through to ProjectState (history entries and saved projects
   * would otherwise capture transient playback values).
   */
  public createPlaybackSnapshot(
    channels: Channel[],
    clips: PlaylistClip[],
    mixerTracks: MixerTrack[]
  ): { channels: Channel[]; clips: PlaylistClip[]; mixerTracks: MixerTrack[] } {
    return {
      channels: structuredClone(channels),
      clips: structuredClone(clips),
      mixerTracks: structuredClone(mixerTracks)
    };
  }

  /**
   * Phase 81: true when an automation clip's target addresses `trackId`.
   *
   * Numeric-target forms (`mixer_vol`, `mixer_pan`, and the legacy `fx_mix`,
   * whose `targetId` is the mixer track id) compare directly, exactly as before
   * this phase. The Phase 81 `fx_param` form carries a composite
   * `"<trackId>/<slotId>"` id, so it is resolved through `fxParameterControl`
   * — without that, an offline stem render would silently drop the FX
   * automation that drives the insert it is rendering and diverge from the
   * live take.
   */
  private automationClipTargetsMixerTrack(clip: PlaylistClip, trackId: number): boolean {
    if (clip.type !== 'automation' || !clip.automationTarget) return false;
    const target = clip.automationTarget;
    if (target.type === 'fx_param') return fxTargetIdBelongsToTrack(target.targetId, trackId);
    return String(target.targetId) === String(trackId);
  }

  private getAutomationTargetKey(clip: PlaylistClip): string | null {
    if (clip.type !== 'automation' || !clip.automationTarget) return null;
    const target = clip.automationTarget;
    return `${target.type}:${String(target.targetId)}:${target.paramName ?? ''}`;
  }

  private isAutomationClipActiveAtCurrentPosition(clip: PlaylistClip): boolean {
    if (clip.type !== 'automation' || clip.mute || this.isPlaylistLaneMuted(clip) || !clip.automationTarget) return false;
    if (!Number.isFinite(clip.startBar) || !Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0) return false;
    const currentBarPosition = Math.max(0, this.currentBar - 1) + (this.currentStep / this.currentStepsPerBar);
    return currentBarPosition >= clip.startBar && currentBarPosition <= clip.startBar + clip.lengthBars;
  }

  /**
   * Removing or moving the last active automation clip for a target must not
   * leave its previous transient value latched in the isolated take. Restore
   * that target from the latest project baseline; a still-active replacement
   * clip remains authoritative and will be evaluated on the next scheduler
   * callback.
   */
  private resetAutomationTargetsForClipChanges(previousClips: PlaylistClip[], nextClips: PlaylistClip[]): void {
    const nextActiveTargets = new Set(
      nextClips
        .filter(clip => this.isAutomationClipActiveAtCurrentPosition(clip))
        .map(clip => this.getAutomationTargetKey(clip))
        .filter((key): key is string => Boolean(key))
    );

    for (const previousClip of previousClips) {
      const previousTargetKey = this.getAutomationTargetKey(previousClip);
      if (!previousTargetKey) continue;

      const nextVersion = nextClips.find(clip => clip.id === previousClip.id);
      const structuralChange = !nextVersion ||
        previousClip.mute !== nextVersion.mute ||
        previousClip.startBar !== nextVersion.startBar ||
        previousClip.lengthBars !== nextVersion.lengthBars ||
        !playbackValuesEqual(previousClip.automationTarget, nextVersion.automationTarget);
      if (structuralChange && !nextActiveTargets.has(previousTargetKey)) {
        this.resetActiveAutomationTarget(previousClip.automationTarget!);
      }
    }
  }

  private resetAutomationTargetsForLaneMuteChange(newlyMutedLanes: ReadonlySet<number>): void {
    if (newlyMutedLanes.size === 0) return;
    const remainingActiveTargets = new Set(
      this.activeClips
        .filter(clip => this.isAutomationClipActiveAtCurrentPosition(clip))
        .map(clip => this.getAutomationTargetKey(clip))
        .filter((key): key is string => Boolean(key)),
    );

    for (const clip of this.activeClips) {
      if (clip.type !== 'automation' || clip.mute || !clip.automationTarget) continue;
      if (!Number.isFinite(clip.trackIndex) || !newlyMutedLanes.has(Math.floor(clip.trackIndex))) continue;
      const targetKey = this.getAutomationTargetKey(clip);
      if (targetKey && !remainingActiveTargets.has(targetKey)) {
        this.resetActiveAutomationTarget(clip.automationTarget);
      }
    }
  }

  private resetActiveAutomationTarget(target: NonNullable<PlaylistClip['automationTarget']>): void {
    const now = this.ctx?.currentTime ?? 0;
    if (target.type === 'channel_vol' || target.type === 'channel_pan' || target.type === 'channel_filter_cutoff' || target.type === 'channel_filter_res' || target.type === 'channel_pitch') {
      const activeChannel = this.activeChannels.find(channel => String(channel.id) === String(target.targetId));
      const projectChannel = this.playbackProjectChannels.find(channel => String(channel.id) === String(target.targetId));
      if (!activeChannel || !projectChannel) return;

      if (target.type === 'channel_vol') {
        activeChannel.volume = projectChannel.volume;
        this.updateChannelVolumeForActiveAudio(activeChannel.id, activeChannel.volume, now);
      }
      if (target.type === 'channel_pan') {
        activeChannel.pan = projectChannel.pan;
        this.updateChannel(activeChannel, now);
      }
      if (target.type === 'channel_filter_cutoff' && activeChannel.synthParams && projectChannel.synthParams) {
        activeChannel.synthParams.filterCutoff = projectChannel.synthParams.filterCutoff;
      }
      if (target.type === 'channel_filter_res' && activeChannel.synthParams && projectChannel.synthParams) {
        activeChannel.synthParams.filterResonance = projectChannel.synthParams.filterResonance;
      }
      if (target.type === 'channel_pitch') {
        activeChannel.pitch = projectChannel.pitch;
      }
      return;
    }

    if (target.type === 'mixer_vol' || target.type === 'mixer_pan') {
      const trackId = Number(target.targetId);
      const activeTrack = this.activeMixerTracks.find(track => track.id === trackId);
      const projectTrack = this.playbackProjectMixerTracks.find(track => track.id === trackId);
      if (!activeTrack || !projectTrack) return;

      if (target.type === 'mixer_vol') activeTrack.volume = projectTrack.volume;
      if (target.type === 'mixer_pan') activeTrack.pan = projectTrack.pan;
      this.updateMixerTrack(activeTrack);
      return;
    }

    if (target.type === 'fx_mix') {
      // Reset to the project's declared slot.mix and re-apply on the live chain
      // so a removed/finished automation clip does not leave the wet/dry value
      // latched at the last automation value.
      const trackId = Number(target.targetId);
      const slotId = target.paramName;
      if (!slotId) return;
      const activeTrack = this.activeMixerTracks.find(track => track.id === trackId);
      const projectTrack = this.playbackProjectMixerTracks.find(track => track.id === trackId);
      if (!activeTrack || !projectTrack) return;
      const activeSlot = activeTrack.fxSlots.find(slot => slot.id === slotId);
      const projectSlot = projectTrack.fxSlots.find(slot => slot.id === slotId);
      if (!activeSlot || !projectSlot) return;
      activeSlot.mix = projectSlot.mix;
      const registry = (this as unknown as {
        __liveFxChainRegistry?: {
          applyLiveMix(trackId: number, slotId: string, mix: number, currentTime: number): boolean;
        };
      }).__liveFxChainRegistry;
      registry?.applyLiveMix(trackId, slotId, projectSlot.mix, now);
      return;
    }

    if (target.type === 'fx_param') {
      // Phase 81: mirror the `fx_mix` reset for the whole contract. When the
      // last active automation clip for an FX parameter is removed, muted or
      // finished, the take must fall back to the project's declared value
      // instead of leaving the last automated value latched in the running
      // AudioParam. A target whose track/slot/param no longer exists resolves
      // to nothing and is left alone — there is no live parameter to reset.
      const lookup = resolveFxSlot(this.activeMixerTracks, target.targetId);
      if (lookup.status !== 'resolved') return;
      const paramId = typeof target.paramName === 'string' ? target.paramName.trim() : '';
      if (!paramId) return;
      const projectLookup = resolveFxSlot(this.playbackProjectMixerTracks, target.targetId);
      if (projectLookup.status !== 'resolved') return;
      const activeSlot = lookup.slot;
      const projectSlot = projectLookup.slot;
      // The project document is the baseline being restored, so the contract
      // lookup uses the project slot's family. A live slot whose type no longer
      // matches simply rejects the value at the AudioEffect and stays untouched.
      const spec = resolveFxParameterSpec(projectSlot.type, paramId);
      if (!spec) return;
      const registry = this.getLiveFxChainRegistry();
      if (spec.id === 'mix') {
        activeSlot.mix = projectSlot.mix;
        registry?.applyLiveMix(lookup.track.id, activeSlot.id, activeSlot.mix, now);
        return;
      }
      const stored = projectSlot.params?.[paramId];
      const restored = typeof stored === 'number' && Number.isFinite(stored) ? stored : spec.default;
      activeSlot.params = { ...activeSlot.params, [paramId]: restored };
      registry?.applyLiveParameter(lookup.track.id, activeSlot.id, paramId, restored, now);
      return;
    }

    if (target.type === 'mixer_send1' || target.type === 'mixer_send2') {
      const trackId = Number(target.targetId);
      const idx = target.type === 'mixer_send1' ? 0 : 1;
      const activeTrack = this.activeMixerTracks.find(track => track.id === trackId);
      const projectTrack = this.playbackProjectMixerTracks.find(track => track.id === trackId);
      if (!activeTrack || !projectTrack || !activeTrack.auxSends || !projectTrack.auxSends || !activeTrack.auxSends[idx] || !projectTrack.auxSends[idx]) return;
      activeTrack.auxSends[idx].amount = projectTrack.auxSends[idx].amount;
      const ch = this.mixerChannels.get(trackId);
      const gain = ch?.auxSendGains?.get(activeTrack.auxSends[idx].targetId);
      if (gain) {
        const restored = projectTrack.auxSends[idx].amount;
        if (typeof gain.gain.setTargetAtTime === 'function') gain.gain.setTargetAtTime(restored, now, 0.02);
        else gain.gain.value = restored;
      }
      return;
    }

    if (target.type === 'master_vol' && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(1, now, 0.02);
    }
  }

  /**
   * Applies an edit to the isolated playback take without replacing the
   * project object used by React/history/persistence. Playlist clips are
   * replaced as a cloned schedule, while channel and mixer collections merge
   * only fields that changed in project state so an in-flight automation value
   * remains active until the next automation event.
   */
  public synchronizePlaybackState(update: PlaybackStateUpdate): void {
    if (this.shouldBlockLiveMutation() || !this.isPlaying) return;

    // Adopt the declared pattern length before merging channel edits so a length
    // change that arrives together with content is resolved against the new value.
    const patternLengthChanged = typeof update.patternLengthSteps === 'number'
      && update.patternLengthSteps !== this.activePatternLengthSteps;
    if (patternLengthChanged) {
      this.activePatternLengthSteps = update.patternLengthSteps;
    }

    if (update.channels) {
      const now = this.ctx?.currentTime ?? 0;
      const previousChannels = this.activeChannels;
      const previouslyAudibleIds = new Set(
        previousChannels
          .filter(channel => isRackChannelAudible(channel, previousChannels))
          .map(channel => channel.id),
      );
      const previousProjectById = new Map(this.playbackProjectChannels.map(channel => [channel.id, channel]));
      const activeById = new Map(this.activeChannels.map(channel => [channel.id, channel]));
      const nextChannelIds = new Set(update.channels.map(channel => channel.id));

      for (const prevChannel of previousChannels) {
        if (!nextChannelIds.has(prevChannel.id)) {
          this.stopChannelVoices(prevChannel.id);
          this.stopActiveClipSourcesForChannel(prevChannel.id);
        }
      }

      this.activeChannels = update.channels.map(channel => {
        const previousProject = previousProjectById.get(channel.id);
        const active = activeById.get(channel.id);
        const nextChannel = (!previousProject || !active)
          ? structuredClone(channel)
          : (mergePlaybackProjectEdits(active, previousProject, channel) as Channel);
        const panOrRoutingChanged = !previousProject
          || previousProject.pan !== channel.pan
          || previousProject.mixerTrackId !== channel.mixerTrackId;
        const volumeChanged = !previousProject || previousProject.volume !== channel.volume;
        if (panOrRoutingChanged || volumeChanged || this.channelPanners?.has(nextChannel.id)) {
          this.updateChannel(nextChannel, now);
        }
        return nextChannel;
      });
      this.syncChannelPanners(this.activeChannels, now);
      this.playbackProjectChannels = structuredClone(update.channels);

      const positionSeconds = this.transport?.getState().positionSeconds ?? 0;
      for (const nextChannel of this.activeChannels) {
        const wasAudible = previouslyAudibleIds.has(nextChannel.id);
        const isNowAudible = isRackChannelAudible(nextChannel, this.activeChannels);
        if (wasAudible && !isNowAudible) {
          this.stopChannelVoices(nextChannel.id);
          this.stopActiveClipSourcesForChannel(nextChannel.id);
        } else if (!wasAudible && isNowAudible && this.activePlayMode === 'song') {
          this.retriggerAudioClipsForChannelAtPosition(positionSeconds, nextChannel.id);
        }
      }
    }

    // Re-resolve once after either source changed. With a declared length the
    // Pattern owns the boundary; without one, legacy content-derived takes still
    // follow channel edits. Song Mode stays on its bar-relative playlist grid.
    if ((update.channels || patternLengthChanged) && this.activePlayMode === 'pat') {
      this.transport?.setPatternLoopSteps(
        resolvePatternLoopLengthSteps(this.activeChannels, this.activePatternLengthSteps, this.meter)
      );
    }

    if (update.clips) {
      // The scheduler never mutates clips; replacing this clone makes move,
      // resize, split and delete edits visible to the next scheduled step.
      this.resetAutomationTargetsForClipChanges(this.activeClips, update.clips);
      this.activeClips = structuredClone(update.clips);
      this.refreshInaudibleTakeClipIds();
      if (this.activePlayMode === 'song') {
        // A clip edit moves the arrangement's real end; the running take must
        // stop at the new end instead of a stale one.
        this.transport?.setSongEndSteps(this.resolveSongEndSteps());
      }
    }

    if (update.mixerTracks) {
      const previousProjectById = new Map(this.playbackProjectMixerTracks.map(track => [track.id, track]));
      const activeById = new Map(this.activeMixerTracks.map(track => [track.id, track]));
      const nextTracks = update.mixerTracks.map(track => {
        const previousProject = previousProjectById.get(track.id);
        const active = activeById.get(track.id);
        const projectChanged = !previousProject || !playbackValuesEqual(track, previousProject);
        const nextTrack = !previousProject || !active
          ? structuredClone(track)
          : mergePlaybackProjectEdits(active, previousProject, track) as MixerTrack;

        if (projectChanged) {
          // Phase 10B + Phase 80: when an in-flight track edit only touched
          // slot.mix and/or in-contract slot.params on already-built FX
          // slots, route the new values directly to the live AudioParams
          // and skip the full chain rebuild. The active track is updated
          // so a future render/export sees the new values and
          // `applyAutomationValue` for fx_mix reads the same source.
          const diff = previousProject
            ? trackLiveUpdatableChanged(previousProject, track)
            : { onlyLiveUpdatableChanged: false, mixChanges: [], paramChanges: [] };
          if (diff.onlyLiveUpdatableChanged) {
            const now = this.ctx?.currentTime ?? 0;
            const registry = (this as unknown as {
              __liveFxChainRegistry?: {
                applyLiveMix(trackId: number, slotId: string, mix: number, currentTime: number): boolean;
                applyLiveParameter(trackId: number, slotId: string, paramName: string, value: number, currentTime: number): boolean;
              };
            }).__liveFxChainRegistry;
            for (const change of diff.mixChanges) {
              const slot = nextTrack.fxSlots.find(s => s.id === change.slotId);
              if (slot) slot.mix = change.mix;
              const updated = registry?.applyLiveMix(nextTrack.id, change.slotId, change.mix, now);
              if (!updated && !this.isOfflineRendering) {
                this.updateMixerTrack(nextTrack);
                break;
              }
            }
            for (const change of diff.paramChanges) {
              const slot = nextTrack.fxSlots.find(s => s.id === change.slotId);
              if (slot) {
                slot.params = { ...slot.params, [change.paramName]: change.value };
              }
              const updated = registry?.applyLiveParameter(nextTrack.id, change.slotId, change.paramName, change.value, now);
              if (!updated && !this.isOfflineRendering) {
                // Live chain rejected the value (out-of-range, unknown
                // name) — the project state has already been updated so
                // the next chain rebuild / next offline export will
                // pick it up. We don't force a rebuild here because a
                // bad value should not destroy the running chain.
                continue;
              }
            }
          } else {
            this.updateMixerTrack(nextTrack);
          }
        }
        return nextTrack;
      });
      const nextTrackIds = new Set(update.mixerTracks.map(track => track.id));
      for (const trackId of this.activeMixerTracks.map(track => track.id)) {
        if (!nextTrackIds.has(trackId)) this.removeMixerChannel(trackId);
      }
      this.activeMixerTracks = nextTracks;
      this.playbackProjectMixerTracks = structuredClone(update.mixerTracks);
      this.syncMixerRouting(nextTracks);
    }

    if (update.playlistTracks) {
      const previousMutes = this.playlistLaneMutes;
      const nextMutes = this.derivePlaylistLaneMutes(update.playlistTracks);
      const newlyMutedLanes = new Set<number>();
      // A lane muted mid-take goes silent at once: its in-flight clip audio is
      // cancelled and the scheduler stops triggering its pattern clips. The
      // routed mixer insert is left untouched so lanes and channels sharing it
      // keep sounding.
      for (const lane of nextMutes) {
        if (!previousMutes.has(lane)) {
          newlyMutedLanes.add(lane);
          this.stopActiveClipSourcesForLane(lane);
        }
      }
      this.playlistLaneMutes = nextMutes;
      this.resetAutomationTargetsForLaneMuteChange(newlyMutedLanes);
      // Unmuting mid-take must not wait for a future start-bar trigger: the
      // lane's clip spanning the playhead restarts from the correct offset,
      // exactly like a seek landing inside it.
      if (this.activePlayMode === 'song') {
        const positionSeconds = this.transport?.getState().positionSeconds ?? 0;
        let anyLaneUnmuted = false;
        for (const lane of previousMutes) {
          if (nextMutes.has(lane)) continue;
          anyLaneUnmuted = true;
          this.retriggerAudioClipsAtPosition(positionSeconds, lane);
        }
        if (anyLaneUnmuted) {
          this.rebaseAutomationAtPosition(positionSeconds);
        }
      }
    }
  }

  /** True only while the live transport owns an active playback take. */
  public isPlaybackActive(): boolean {
    return this.isPlaying;
  }

  public play(
    channels: Channel[],
    clips: PlaylistClip[],
    mode: 'pat' | 'song',
    patternId?: string,
    mixerTracks?: MixerTrack[],
    patternLengthSteps?: number,
    playlistTracks?: PlaylistTrack[]
  ) {
    if (this.shouldBlockLiveMutation()) return;
    if (!this.ctx) this.init();
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }

    // A new take tears down the previous take's audio without resetting the
    // transport position: Stop already resets it to bar one, Pause keeps it,
    // so Play resumes from wherever the playhead currently is.
    this.playbackGeneration++;
    this.stopActivePlaybackAudio();
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    const currentGeneration = this.playbackGeneration;

    const playbackSnapshot = this.createPlaybackSnapshot(channels, clips, mixerTracks ?? []);
    // A new take is a new measurement session: starting from a stale
    // integrated value would publish a loudness number for audio that was
    // never part of this take.
    this.resetMasterMeasurement();
    this.startMasterMeasurementPump();
    this.isPlaying = true;
    this.activeChannels = playbackSnapshot.channels;
    this.activeClips = playbackSnapshot.clips;
    this.refreshInaudibleTakeClipIds();
    this.activeMixerTracks = playbackSnapshot.mixerTracks;
    this.playlistLaneMutes = this.derivePlaylistLaneMutes(playlistTracks);
    this.playbackProjectChannels = structuredClone(playbackSnapshot.channels);
    this.playbackProjectMixerTracks = structuredClone(playbackSnapshot.mixerTracks);
    this.activePlayMode = mode;
    this.activePatternId = patternId;
    this.activePatternLengthSteps = patternLengthSteps;

    // Apply the current project mixer graph at transport start. Subsequent
    // mixer edits use synchronizePlaybackState and update only the changed
    // active track while the transport remains running.
    if (this.activeMixerTracks.length > 0 && this.mixerChannels) {
      const nextTrackIds = new Set(this.activeMixerTracks.map(track => track.id));
      for (const trackId of [...this.mixerChannels.keys()]) {
        if (trackId !== 0 && !nextTrackIds.has(trackId)) {
          this.removeMixerChannel(trackId);
        }
      }
    }
    for (const track of this.activeMixerTracks) this.updateMixerTrack(track);
    this.syncMixerRouting(this.activeMixerTracks);
    this.syncChannelPanners(this.activeChannels, this.ctx?.currentTime ?? 0);

    if (!this.transport && this.ctx) {
      this.transport = new AudioClockTransport(this.ctx);
    }
    if (!this.transport) return;

    this.transport.setBpm(this.bpm);
    // Phase 1F: the take plays under the resolved project meter. This remaps
    // the transport bar grid (bar numbers, beat count, song-end position).
    this.transport.setTimeSignature(this.meter);
    this.transport.setMode(mode);
    // Pattern Mode loops over the pattern length (16/32/64 steps); Song Mode
    // keeps the one-bar grid that playlist scheduling is built on.
    this.transport.setPatternLoopSteps(
      mode === 'pat'
        ? resolvePatternLoopLengthSteps(this.activeChannels, patternLengthSteps, this.meter)
        : undefined
    );
    // Song Mode owns its real end from the active clip schedule; Pattern Mode
    // loops its declared length forever (Phase 9D).
    const songEndSteps = mode === 'song' ? this.resolveSongEndSteps() : null;
    this.transport.setSongEndSteps(songEndSteps ?? undefined);
    // Starting at or beyond the arrangement's real end restarts from the top.
    if (songEndSteps !== null) {
      const stepDurationSeconds = beatsToSeconds(stepsToBeats(1), this.bpm);
      if (this.transport.getState().positionSeconds >= songEndSteps * stepDurationSeconds - 1e-9) {
        this.transport.seek(0);
      }
    }
    if (this.transport.getState().playing) {
      // Replacing a running take must restart the scheduler loop cleanly.
      this.transport.stop(false);
    }
    this.transport.setCallbacks({
      onStep: (step, bar, audioTime) => {
        if (this.offlineRenderLeaseHeld || !this.isPlaying || this.playbackGeneration !== currentGeneration) return;

        this.currentStep = step;
        this.currentBar = bar;

        const secondsPerBeat = beatsToSeconds(1, this.bpm);
        const secondsPerStep = secondsPerBeat / SIXTEENTH_STEPS_PER_BEAT;
        const swingOffsetSeconds = step % 2 === 1
          ? swingOffsetSecondsForStep(this.swing, secondsPerStep)
          : 0;

        this.triggerCurrentStep(audioTime + swingOffsetSeconds);

        if (this.stepCallback) {
          this.stepCallback(step, bar);
        }
      },
      onStateChange: (state) => {
        if (this.offlineRenderLeaseHeld || !this.isPlaying || this.playbackGeneration !== currentGeneration) return;
        this.transportStateCallback?.(state);
      },
      onSongEnd: () => {
        if (this.offlineRenderLeaseHeld || this.playbackGeneration !== currentGeneration) return;
        this.handleSongEnd();
      }
    });

    this.transport.start();

    // Resuming a take at a mid-arrangement position must restore the audio the
    // previous take silenced: playlist clips spanning the position restart
    // from their correct offset and automation is re-based instead of
    // latching the pre-pause value. A fresh start at position 0 leaves the
    // scheduler's first-bar triggers untouched.
    const resumedPositionSeconds = this.transport.getState().positionSeconds;
    if (resumedPositionSeconds > 0) {
      this.syncEnginePositionFromTransport();
      this.retriggerAudioClipsAtPosition(resumedPositionSeconds);
      this.rebaseAutomationAtPosition(resumedPositionSeconds);
    }
  }

 public stop() {
  if (this.shouldBlockLiveMutation()) return;
  // Phase 1K/1L: a stop aborts any count-in and any armed punch take.
  this.cancelRecordingCountIn();
  this.cancelPunchRecording();
  this.isPlaying = false;
  this.playbackGeneration++;
  this.stopMasterMeasurementPump();
  this.resetMasterMeasurement();

  if (this.timerId) {
    clearTimeout(this.timerId);
    this.timerId = null;
  }

  if (this.transport) {
    this.transport.stop();
  }

  this.stopActivePlaybackAudio();

  this.currentStep = 0;
  this.currentBar = 1;
}

  /**
   * Pauses the live take at its current position: everything the transport
   * scheduled ahead — note voices and playlist clip sources — stops
   * immediately, while the transport keeps the exact position so Play resumes
   * from here. Transport actions never touch project data.
   */
  public pause(): void {
    if (this.shouldBlockLiveMutation()) return;
    // Phase 1K: pausing freezes the musical position the count-in is counting
    // toward, so the count-in aborts exactly like a stop (pending clicks
    // silenced, waiting recorder cancelled).
    this.cancelRecordingCountIn();
    // Phase 1L: a paused transport has no punch-in or punch-out to reach.
    this.cancelPunchRecording();
    if (!this.isPlaying || !this.transport) return;
    this.playbackGeneration++;
    this.stopActivePlaybackAudio();
    this.transport.pause();
    this.isPlaying = false;
    // The last measurement stays readable, but the pump stops so the numbers
    // cannot drift into a state that no longer corresponds to any audio.
    this.stopMasterMeasurementPump();
    this.syncEnginePositionFromTransport();
    const state = this.transport.getState();
    this.transportStateCallback?.(state);
  }

  /**
   * Moves the playhead to `positionSeconds` in every transport state
   * (stopped, paused, playing). While playing, audio scheduled for the old
   * position is cancelled, playlist audio clips spanning the new position
   * restart from their correct offset, and automation is re-based so no
   * pre-seek value stays latched until the next step boundary.
   */
  public seek(positionSeconds: number): void {
    if (this.shouldBlockLiveMutation()) return;
    // Phase 1K/1L: a seek aborts an in-flight count-in or armed punch take.
    this.cancelRecordingCountIn();
    this.cancelPunchRecording();
    const transport = this.transport;
    if (!transport || !this.ctx) return;
    const boundedPosition = this.boundSeekPosition(positionSeconds);

    if (this.isPlaying) {
      this.stopActivePlaybackAudio();
    }
    transport.seek(boundedPosition);
    // A seek jumps the programme position: discard the session rather than
    // average two unrelated positions into one "integrated" figure.
    this.resetMasterMeasurement();
    this.syncEnginePositionFromTransport();

    if (this.isPlaying) {
      this.retriggerAudioClipsAtPosition(boundedPosition);
      this.rebaseAutomationAtPosition(boundedPosition);
    }
    const state = transport.getState();
    this.transportStateCallback?.(state);
  }

  /** Stops every playlist clip source and note voice of the active take. */
  private stopActivePlaybackAudio(): void {
    for (const source of Array.from(this.activeClipSources)) {
      try { source.stop(); } catch (_) { /* already inactive */ }
      this.cleanupClipChannelVolume(source);
      this.activeClipSources.delete(source);
    }
    this.activeClipSourceLanes.clear();
    this.activeClipSourceChannels?.clear();
    this.activeClipChannelVolumes?.clear();

    const now = this.ctx?.currentTime;
    for (const [voiceId, voice] of this.activeVoices.entries()) {
      try {
        voice.stop(now);
      } catch (_) {
        // Continue stopping remaining voices even if one has already stopped.
      }
      this.cleanupVoiceChannelVolume(voiceId);
    }
    this.activeVoices.clear();
    this.activeVoiceChannelVolumes?.clear();
    this.activeDrumPadVoices.clear();
    // Phase 1J: clicks the transport scheduled inside its look-ahead window
    // belong to the interrupted position; without this a stop/seek/pause let
    // up to ~100 ms of stale clicks sound (and a seek doubled them).
    this.cancelScheduledMetronomeClicks();
  }

  /** Keeps the engine's step/bar mirror aligned with the authoritative transport position. */
  private syncEnginePositionFromTransport(): void {
    const state = this.transport?.getState();
    if (!state) return;
    this.currentStep = state.step;
    this.currentBar = state.bar;
  }

  /**
   * Playlist lane rows muted in project state. Rows are array indices — the
   * same coordinate space as `PlaylistClip.trackIndex`. Clips whose row is
   * missing from the collection are never muted.
   */
  private derivePlaylistLaneMutes(tracks?: PlaylistTrack[]): Set<number> {
    return derivePlaylistLaneMutes(tracks);
  }

  /**
   * A clip is lane-muted when its playlist row is muted. Lane mute is enforced
   * at the trigger boundary — before the clip reaches its routed mixer insert —
   * so muting one lane can never silence another lane or a channel that shares
   * the same insert.
   */
  private isPlaylistLaneMuted(clip: PlaylistClip): boolean {
    return isClipLaneMuted(clip, this.playlistLaneMutes);
  }

  /** Silences one lane immediately: cancels that lane's in-flight clip audio only. */
  private stopActiveClipSourcesForLane(laneIndex: number): void {
    for (const source of Array.from(this.activeClipSources)) {
      if (this.activeClipSourceLanes.get(source) !== laneIndex) continue;
      try { source.stop(); } catch (_) { /* already inactive */ }
      this.cleanupClipChannelVolume(source);
      this.activeClipSources.delete(source);
      this.activeClipSourceLanes.delete(source);
    }
  }

  /** Silences one channel's in-flight playlist audio clips immediately. */
  private stopActiveClipSourcesForChannel(channelId: string): void {
    for (const source of Array.from(this.activeClipSources)) {
      if (this.activeClipSourceChannels?.get(source) !== channelId) continue;
      try { source.stop(); } catch (_) { /* already inactive */ }
      this.cleanupClipChannelVolume(source);
      this.activeClipSources.delete(source);
      this.activeClipSourceLanes.delete(source);
    }
  }

  /** Total steps the Song Mode arrangement occupies, or null when it has none. */
  private resolveSongEndSteps(): number | null {
    let endSteps = 0;
    const stepsBar = this.currentStepsPerBar;
    for (const clip of this.activeClips) {
      if (!Number.isFinite(clip.startBar) || !Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0) continue;
      endSteps = Math.max(endSteps, (clip.startBar + clip.lengthBars) * stepsBar);
    }
    return endSteps > 0 ? endSteps : null;
  }

  /** Song Mode seeks never land past the arrangement's real end. */
  private boundSeekPosition(positionSeconds: number): number {
    const next = Math.max(0, Number.isFinite(positionSeconds) ? positionSeconds : 0);
    if (this.activePlayMode !== 'song') return next;
    const endSteps = this.resolveSongEndSteps();
    if (endSteps === null) return next;
    const stepDurationSeconds = beatsToSeconds(stepsToBeats(1), this.bpm);
    return Math.min(next, endSteps * stepDurationSeconds);
  }

  /**
   * Starts every unmuted audio clip whose body spans `positionSeconds` so a
   * seek (or resume) into a clip restarts it from the correct offset instead
   * of waiting for — or missing — its start-bar trigger. A clip that begins
   * exactly at the position is left to the scheduler's start-bar trigger so
   * it can never sound twice.
   *
   * With `laneIndex` the sweep is limited to clips on that playlist row; it is
   * used when a lane is unmuted mid-take so only that lane's spanning clip
   * restarts. Without it (seek/resume), still-muted lanes are skipped.
   */
  private retriggerAudioClipsAtPosition(positionSeconds: number, laneIndex?: number): void {
    const ctx = this.ctx;
    if (!ctx || positionSeconds <= 0) return;
    const stepDurationSeconds = beatsToSeconds(stepsToBeats(1), this.bpm);
    const now = ctx.currentTime;
    for (const clip of this.activeClips) {
      if (clip.type !== 'audio' || clip.mute) continue;
      if (this.isClipTakeInactive(clip)) continue;
      if (!this.isAudioClipChannelAudible(clip)) continue;
      if (laneIndex === undefined) {
        if (this.isPlaylistLaneMuted(clip)) continue;
      } else {
        if (!Number.isFinite(clip.trackIndex) || Math.floor(clip.trackIndex) !== laneIndex) continue;
      }
      if (!Number.isFinite(clip.startBar) || !Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0) continue;
      const startSeconds = clip.startBar * this.currentStepsPerBar * stepDurationSeconds;
      const endSeconds = startSeconds + clip.lengthBars * this.currentStepsPerBar * stepDurationSeconds;
      if (positionSeconds <= startSeconds || positionSeconds >= endSeconds) continue;
      this.playAudioClipWithFades(clip, now, positionSeconds - startSeconds);
    }
  }

  private retriggerAudioClipsForChannelAtPosition(positionSeconds: number, channelId: string): void {
    const ctx = this.ctx;
    if (!ctx || positionSeconds <= 0) return;
    const stepDurationSeconds = beatsToSeconds(stepsToBeats(1), this.bpm);
    const now = ctx.currentTime;
    for (const clip of this.activeClips) {
      if (clip.type !== 'audio' || clip.mute || clip.channelId !== channelId) continue;
      if (this.isClipTakeInactive(clip)) continue;
      if (this.isPlaylistLaneMuted(clip) || !this.isAudioClipChannelAudible(clip)) continue;
      if (!Number.isFinite(clip.startBar) || !Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0) continue;
      const startSeconds = clip.startBar * this.currentStepsPerBar * stepDurationSeconds;
      const endSeconds = startSeconds + clip.lengthBars * this.currentStepsPerBar * stepDurationSeconds;
      if (positionSeconds <= startSeconds || positionSeconds >= endSeconds) continue;
      this.playAudioClipWithFades(clip, now, positionSeconds - startSeconds);
    }
  }

  /**
   * Writes the automation values at `positionSeconds` into the isolated take
   * so a seek does not leave the pre-seek value latched until the next
   * scheduled step re-evaluates the active clips.
   */
  private rebaseAutomationAtPosition(positionSeconds: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const secondsPerBar = this.secondsPerBarAt(this.bpm);
    const barPosition = positionSeconds / secondsPerBar;
    const now = ctx.currentTime;
    for (const clip of this.activeClips) {
      if (clip.type !== 'automation' || clip.mute || this.isPlaylistLaneMuted(clip) || !clip.automationTarget) continue;
      if (!clip.automationPoints || clip.automationPoints.length < 2) continue;
      if (!Number.isFinite(clip.startBar) || !Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0) continue;
      if (barPosition < clip.startBar || barPosition > clip.startBar + clip.lengthBars) continue;
      const relX = (barPosition - clip.startBar) / clip.lengthBars;
      const value = this.interpolateAutomationCurve(clip.automationPoints, relX);
      this.applyAutomationValue(clip.automationTarget, value, this.activeChannels, this.activeMixerTracks, now);
    }
  }

  /** Song Mode reached its real end: halt the take exactly on the end position. */
  private handleSongEnd(): void {
    // Phase 1K: the arrangement ended — any count-in would capture past the
    // song's end at a stale offset.
    this.cancelRecordingCountIn();
    // Phase 1L: only a take still counting in is abandoned here. A take already
    // capturing has a punch-out that is the project end by definition, so it
    // completes normally instead of throwing away a finished take.
    this.cancelPunchPreRoll();
    this.playbackGeneration++;
    this.stopActivePlaybackAudio();
    this.isPlaying = false;
    this.stopMasterMeasurementPump();
    const state = this.transport?.getState();
    if (state) {
      this.currentStep = state.step;
      this.currentBar = state.bar;
      this.transportStateCallback?.(state);
    }
  }

  private triggerCurrentStep(audioTime?: number) {
    if (!this.ctx) return;
    const now = audioTime ?? this.ctx.currentTime;
    // `now` is the already (possibly swung) step boundary the transport reported
    // for this step. A fractional `Note.start` keeps its sub-step remainder as a
    // displacement from that boundary; integer onsets resolve to 0 and keep their
    // exact historic timing. Live playback and the offline renderer share this
    // method, so an export cannot place a note anywhere the take did not.
    const safeBpm = Number.isFinite(this.bpm) && this.bpm > 0 ? this.bpm : 120;
    const secondsPerStep = beatsToSeconds(stepsToBeats(1), safeBpm);

    // Phase 1J: the click grid comes from the resolved project meter and the
    // authoritative transport step — quarter pulses in 4/4 and 3/4, eighth
    // pulses in 6/8 (3+3) and 7/8 (configurable grouping) — instead of a
    // hardcoded `step % 4` that ignored the meter. The step is folded onto the
    // bar grid so long patterns accent every bar line.
    if (this.metronome) {
      const level = resolveMetronomeClickLevel(this.getMetronomePulseLayout(), this.currentStep);
      if (level !== null) {
        const osc = scheduleMetronomeClick(this.ctx, this.masterGain || this.ctx.destination, now, level);
        this.activeMetronomeClicks.add(osc);
        const release = () => { this.activeMetronomeClicks.delete(osc); };
        if (typeof (osc as { addEventListener?: unknown }).addEventListener === 'function') {
          osc.addEventListener('ended', release);
        } else {
          (osc as unknown as { onended?: (() => void) | null }).onended = release;
        }
      }
    }

    // Phase 57: 16-step amplitude gate on the master bus. The gain comes from
    // the shared resolver so the live transport and the offline/export
    // renderer (which both call this method) stay behaviourally identical.
    if (this.grossBeatState.enabled && this.grossBeatNode) {
      const targetGain = resolveGrossBeatGateGain(this.grossBeatState, this.currentStep);
      this.grossBeatNode.gain.cancelScheduledValues(now);
      this.grossBeatNode.gain.setTargetAtTime(targetGain, now, 0.012);
    }

    if (this.activePlayMode === 'pat') {
      // Trigger all channel active steps
      this.activeChannels.forEach(channel => {
        if (!this.isChannelAudibleInTake(channel)) return;

        // 1. Step sequencer trigger
        if (channel.steps && channel.steps[this.currentStep]) {
          const defaultPitch = channel.instrumentType === 'drumpad' ? 36 : 60;
          this.playNote(channel, {
            id: `seq-${channel.id}-${this.currentStep}`,
            pitch: defaultPitch,
            start: this.currentStep,
            duration: 1,
            velocity: 0.9
          }, now, safeBpm);
        }

        // 2. Piano roll notes starting on this step
        if (channel.notes) {
          channel.notes.forEach(note => {
            const offsetSteps = noteOnsetOffsetSteps(note.start, this.currentStep);
            if (offsetSteps !== null) {
              this.playNote(channel, note, now + offsetSteps * secondsPerStep, safeBpm);
            }
          });
        }
      });
    } else {
      // Song mode: trigger clips in current bar
      const barIdx = this.currentBar - 1;
      const stepsBar = this.currentStepsPerBar;
      const currentGlobalStep = (barIdx * stepsBar) + this.currentStep;

      // 1. Evaluate automation clips at current bar & step
      this.activeClips.forEach(clip => {
        if (clip.type === 'automation' && !clip.mute && !this.isPlaylistLaneMuted(clip) && clip.automationTarget && clip.automationPoints && clip.automationPoints.length >= 2) {
          const currentTotalBar = barIdx + (this.currentStep / stepsBar);
          if (currentTotalBar >= clip.startBar && currentTotalBar <= clip.startBar + clip.lengthBars) {
            const relX = (currentTotalBar - clip.startBar) / clip.lengthBars;
            const val = this.interpolateAutomationCurve(clip.automationPoints, relX);
            this.applyAutomationValue(clip.automationTarget, val, this.activeChannels, this.activeMixerTracks, now);
          }
        }
      });

      this.activeClips.forEach(clip => {
        if (clip.type === 'pattern') {
          const clipStartStep = clip.startBar * stepsBar;
          const clipEndStep = clipStartStep + (clip.lengthBars * stepsBar);

          if (currentGlobalStep >= clipStartStep && currentGlobalStep < clipEndStep) {
            const channel = this.activeChannels.find(c => c.id === clip.channelId);
            if (channel && this.isChannelAudibleInTake(channel) && !this.isPlaylistLaneMuted(clip)) {
              const loopLength = resolvePlayableContentLengthSteps(channel, undefined, this.meter);
              const stepOffset = clip.offsetSteps || 0;
              const relStep = ((currentGlobalStep - clipStartStep + stepOffset) % loopLength + loopLength) % loopLength;

              if (channel.steps && channel.steps[relStep]) {
                const defaultPitch = channel.instrumentType === 'drumpad' ? 36 : 60;
                this.playNote(channel, {
                  id: `song-${channel.id}-${relStep}`,
                  pitch: defaultPitch,
                  start: relStep,
                  duration: 1,
                  velocity: 0.9
                }, now, safeBpm);
              }
              if (channel.notes) {
                channel.notes.forEach(note => {
                  const offsetSteps = noteOnsetOffsetSteps(note.start, relStep);
                  if (offsetSteps !== null) {
                    this.playNote(channel, note, now + offsetSteps * secondsPerStep, safeBpm);
                  }
                });
              }
            }
          }
        } else if (clip.type === 'audio') {
          const clipStartStep = clip.startBar * stepsBar;
          if (
            currentGlobalStep === clipStartStep &&
            !clip.mute &&
            !this.isPlaylistLaneMuted(clip) &&
            !this.isClipTakeInactive(clip) &&
            this.isAudioClipChannelAudible(clip)
          ) {
            // Trigger audio clip at its start bar
            this.playAudioClipWithFades(clip, now);
          }
        }
      });
    }
  }

  /**
   * `positionOffsetSeconds` is how far into the clip the transport position
   * already is when the source is (re)started — 0 for the normal start-bar
   * trigger, and `position - clipStart` for seek/resume re-triggers. The
   * clip's own `offsetSteps` trim is applied first, so both compose.
   */
  private playAudioClipWithFades(clip: PlaylistClip, startTime: number, positionOffsetSeconds = 0) {
    if (!this.ctx) return;
    if (!this.isAudioClipChannelAudible(clip)) return;
    const buf = clip.audioBufferId ? this.sampleBuffers.get(clip.audioBufferId) : null;
    if (!buf) return;

    if (!Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0) return;

    const safeBpm = Number.isFinite(this.bpm) && this.bpm > 0 ? this.bpm : 120;
    const secondsPerStep = beatsToSeconds(stepsToBeats(1), safeBpm);
    const offsetSeconds =
      Math.max(0, (clip.offsetSteps || 0) * secondsPerStep) + Math.max(0, positionOffsetSeconds);

    if (offsetSeconds >= buf.duration) return;

    // Phase 1F: a clip's bar length converts through the resolved project
    // meter, so a 3/4 audio clip lasts 12 steps (not 16) per declared bar.
    const clipDurationSec = clip.lengthBars * this.secondsPerBarAt(safeBpm);
    if (!Number.isFinite(clipDurationSec) || clipDurationSec <= 0.0005) return;

    const rate = Number.isFinite(clip.timeStretchRate) && (clip.timeStretchRate ?? 1) > 0 ? (clip.timeStretchRate ?? 1) : 1;
    const playDurationBufferSec = clipDurationSec * rate;
    const actualDurationBufferSec = Math.min(buf.duration - offsetSeconds, playDurationBufferSec);
    if (actualDurationBufferSec <= 0) return;

    const effectiveDuration = Math.min(clipDurationSec, actualDurationBufferSec / rate);
    if (effectiveDuration <= 0.0005) return;

    const source = this.ctx.createBufferSource();
    source.buffer = buf;

    // Pitch shift / Playback rate
    if (clip.pitchShiftSemitones) {
      source.detune.setValueAtTime(clip.pitchShiftSemitones * 100, startTime);
    }
    if (clip.timeStretchRate) {
      source.playbackRate.setValueAtTime(clip.timeStretchRate, startTime);
    }

    const gainNode = this.ctx.createGain();

    // Safe fade envelope calculation: in and out cannot invert or exceed half duration
    const maxFade = effectiveDuration / 2;
    const secondsPerBar = this.secondsPerBarAt(safeBpm);
    const requestedFadeIn = Math.max(0, (clip.fadeInBars || 0) * secondsPerBar);
    const requestedFadeOut = Math.max(0, (clip.fadeOutBars || 0) * secondsPerBar);

    const minMicroFade = Math.min(0.002, maxFade);
    const fadeInSec = Math.min(maxFade, requestedFadeIn > 0 ? requestedFadeIn : minMicroFade);
    const fadeOutSec = Math.min(maxFade, requestedFadeOut > 0 ? requestedFadeOut : minMicroFade);

    const t0 = startTime;
    const t1 = startTime + fadeInSec;
    const t2 = Math.max(t1, startTime + effectiveDuration - fadeOutSec);
    const t3 = startTime + effectiveDuration;

    let mixerTrackId = Math.max(1, Math.floor(clip.trackIndex) + 1);
    let baseGain = 1.0;
    let clipChannel: Channel | undefined;
    if (clip.channelId) {
      const ch = this.activeChannels.find(c => c.id === clip.channelId);
      if (ch) {
        if (!this.isChannelAudibleInTake(ch)) return;
        clipChannel = ch;
        if (Number.isFinite(ch.mixerTrackId)) {
          mixerTrackId = ch.mixerTrackId;
        }
        if (Number.isFinite(ch.volume)) {
          baseGain = Math.max(0, ch.volume);
        }
      }
    }

    const effectiveBaseVolume = baseGain > 1e-4 ? baseGain : 1.0;
    const peakGain = Math.max(0.0001, effectiveBaseVolume);
    gainNode.gain.setValueAtTime(0.0001, t0);
    if (fadeInSec > 0.0001) {
      gainNode.gain.exponentialRampToValueAtTime(peakGain, t1);
    } else {
      gainNode.gain.setValueAtTime(peakGain, t0);
    }

    if (t2 > t1) {
      gainNode.gain.setValueAtTime(peakGain, t2);
    }

    if (fadeOutSec > 0.0001 && t3 > t2) {
      gainNode.gain.exponentialRampToValueAtTime(0.0001, t3);
    }

    source.connect(gainNode);
    const mixer = this.getOrCreateMixerChannel(mixerTrackId);
    const clipDestination = clipChannel
      ? this.getOrCreateChannelPanner(clipChannel, startTime)
      : null;

    if (clipChannel && typeof this.ctx.createGain === 'function') {
      const clipTrimGain = this.ctx.createGain();
      if (baseGain <= 1e-4) {
        this.applyGainToNode(clipTrimGain, 0, startTime);
      }
      gainNode.connect(clipTrimGain);
      clipTrimGain.connect(clipDestination ?? mixer.input);
      if (!this.activeClipSourceChannels) {
        this.activeClipSourceChannels = new Map();
      }
      if (!this.activeClipChannelVolumes) {
        this.activeClipChannelVolumes = new Map();
      }
      this.activeClipSourceChannels.set(source, clipChannel.id);
      this.activeClipChannelVolumes.set(source, {
        channelId: clipChannel.id,
        baseVolume: effectiveBaseVolume,
        gainNode: clipTrimGain,
      });
    } else {
      gainNode.connect(clipDestination ?? mixer.input);
    }

    source.start(startTime, offsetSeconds, actualDurationBufferSec);
    source.stop(startTime + effectiveDuration);

    // Keep the take's playlist audio under transport control: pause, seek and
    // stop cancel it instead of letting it keep playing as zombie audio.
    this.activeClipSources.add(source);
    if (Number.isFinite(clip.trackIndex)) {
      this.activeClipSourceLanes.set(source, Math.floor(clip.trackIndex));
    }
    source.addEventListener('ended', () => {
      this.cleanupClipChannelVolume(source);
      this.activeClipSources.delete(source);
      this.activeClipSourceLanes.delete(source);
    }, { once: true });
  }

  /**
   * Fast offline Bounce-In-Place / Channel Render.
   *
   * The channel is read over its full playable length — the same
   * `resolvePlayableContentLengthSteps()` resolution Song Mode loops a pattern
   * clip with — so 32/64-step sequences and piano-roll notes past step 15 are
   * rendered instead of being cut to the first bar. The stem always contains
   * whole passes of that content and is at least `minBars` long.
   *
   * `bpm` is the project tempo; it must come from project state so the stem's
   * step spacing matches the arrangement grid. A non-finite value falls back to
   * the transport tempo, which App keeps in sync with `meta.bpm`. The rendered
   * length is returned so callers can derive `PlaylistClip.lengthBars` from the
   * audio that was actually produced instead of a fixed number.
   *
   * Phase 64 — optional mixer pass-through. Bouncing a playlist lane used to be
   * dry: the insert FX, the strip fader and the bus routing the user monitored
   * were bypassed, so the bounced clip did not sound like the lane it replaced.
   * Callers that want the monitored mix pass the project's `mixerTracks` (and
   * opt into FX with `includeMixerFx`, the same default-on/opt-in switch the WAV
   * export uses). Omitting the options keeps the historical dry contract for
   * internal callers that render a bare channel.
   */
  public async bounceChannelToAudioClip(
    channel: Channel,
    bpm: number,
    minBars: number = 1,
    options: { mixerTracks?: MixerTrack[]; includeMixerFx?: boolean } = {}
  ): Promise<{ buffer: AudioBuffer; waveform: number[]; lengthBars: number; bpm: number }> {
    const requestedBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : this.bpm;
    const safeBpm = Math.max(20, Math.min(300, requestedBpm));
    const sampleRate = this.ctx?.sampleRate || 44100;

    const loopLengthSteps = resolvePlayableContentLengthSteps(channel, undefined, this.meter);
    const stepsBar = this.currentStepsPerBar;
    const loopLengthBars = loopLengthSteps / stepsBar;
    const safeMinBars = Number.isFinite(minBars) && minBars > 0 ? minBars : 1;
    const passes = Math.max(1, Math.ceil(safeMinBars / loopLengthBars));
    const lengthBars = passes * loopLengthBars;

    const stepDuration = beatsToSeconds(stepsToBeats(1), safeBpm);
    const durationSec = lengthBars * stepsBar * stepDuration;

    // Bounce-In-Place is an offline scheduling/rendering operation, not a second
    // instrument DSP implementation. The existing timeline renderer already
    // drives InstrumentRegistry -> instrument renderer against OfflineAudioContext.
    // Disable arpeggiation and channel mute here to preserve the historical
    // bounce contract: this method renders the channel's own step/note content,
    // independent of live transport-only controls.
    const bounceChannel = {
      ...structuredClone(channel),
      arp: undefined,
      mute: false,
    };

    const renderedBuffer = await this.renderTimelineOffline(
      [bounceChannel],
      [],
      Array.isArray(options.mixerTracks) ? options.mixerTracks : [],
      safeBpm,
      lengthBars,
      sampleRate,
      options.includeMixerFx === true,
      'pattern',
      undefined,
      loopLengthSteps,
      undefined,
      durationSec,
    );

    // The offline renderer is intentionally sized to the exact bounce duration
    // above, so the returned AudioBuffer remains contract-compatible with the
    // existing PlaylistClip lengthBars metadata.
    const waveform: number[] = [];
    const left = renderedBuffer.getChannelData(0);
    const blockSize = Math.max(1, Math.floor(renderedBuffer.length / 32));
    for (let b = 0; b < 32; b += 1) {
      let max = 0;
      const offset = b * blockSize;
      for (let j = 0; j < blockSize && offset + j < renderedBuffer.length; j += 1) {
        max = Math.max(max, Math.abs(left[offset + j]));
      }
      waveform.push(Math.min(1.0, max * 1.5));
    }

    // Session-only convenience registration. The caller registers the buffer under
    // the clip's own asset id via setSampleBuffer (which is what gets persisted).
    const bufId = `bounced-${channel.id}-${Date.now()}`;
    this.setSessionSampleBuffer(bufId, renderedBuffer);

    return { buffer: renderedBuffer, waveform, lengthBars, bpm: safeBpm };
  }


  /**
   * Master-bus measurement snapshot.
   *
   * Every number here comes from samples that actually passed the master
   * output: BS.1770-4 loudness from the splitter tap, inter-sample peaks from
   * the oversampled detector, and correlation from independent L/R buffers.
   * Fields stay null until the audio exists to measure them - a meter may show
   * less, but it must never show a measurement it did not make.
   */
  public getMasterLoudnessMetrics(): MasterMeasurementSnapshot {
    // During an offline bounce `ctx` and `masterAnalyser` are swapped for the
    // render graph, so reading them here would meter a non-real-time graph and
    // present it as live. Same protection the spectrum getters already use.
    if (this.isOfflineRendering) {
      return this.unavailableMasterMeasurement('offline-render');
    }
    if (!this.loudnessMeter || !this.truePeakMeter || !this.stereoFieldMeter) {
      return this.unavailableMasterMeasurement('engine-idle');
    }

    const loudness = this.loudnessMeter.getReading();
    const peaks = this.truePeakMeter.getReading();
    const field = this.stereoFieldMeter.getReading();
    const measured = loudness.blockCount > 0 || peaks.truePeakDbfs !== null;
    const truePeakDbfs = peaks.truePeakDbfs;

    return {
      momentaryLufs: loudness.momentaryLufs,
      shortTermLufs: loudness.shortTermLufs,
      integratedLufs: loudness.integratedLufs,
      blockCount: loudness.blockCount,
      gatedBlockCount: loudness.gatedBlockCount,
      measuredSeconds: loudness.measuredSeconds,
      shortTermReady: loudness.shortTermReady,
      truePeakDbfs,
      truePeakLeftDbfs: peaks.leftDbfs,
      truePeakRightDbfs: peaks.rightDbfs,
      samplePeakDbfs: peaks.samplePeakDbfs,
      oversampleFactor: peaks.oversample,
      phaseCorrelation: field.correlation,
      sideMidRatioDb: field.sideMidRatioDb,
      midPowerDbfs: field.midPowerDbfs,
      sidePowerDbfs: field.sidePowerDbfs,
      headroomDb: truePeakDbfs === null ? null : Math.round(-truePeakDbfs * 10) / 10,
      // Clipping is decided from the reconstructed peak, not from the largest
      // sample value: fs/4 material can overshoot by 3 dB between samples.
      isClipping: truePeakDbfs === null ? null : truePeakDbfs >= 0,
      isPumping: this.measurementPumping,
      droppedSampleCount: this.measurementPlanner.unreadSampleCount,
      sampleRate: this.ctx?.sampleRate ?? null,
      availability: measured ? 'measured' : 'no-audio',
    };
  }

  /**
   * Goniometer vectors built from real Mid/Side of the master bus.
   *
   * Returns nothing when there is no signal: an empty scope is the honest
   * rendering of "not measured", where a fabricated cluster of points would be
   * a drawing of a stereo field that was never observed.
   */
  public getStereoVectors(numPoints: number = 64): { x: number; y: number }[] {
    if (this.isOfflineRendering) return [];
    const windows = this.readMasterChannelWindows();
    if (!windows) return [];
    return computeMidSideVectors(windows.left, windows.right, numPoints);
  }

  /**
   * Sample rate and latency of the live context, for surfaces that must not
   * print a hard-coded "44.1kHz". Null means "there is no audio context yet",
   * which the UI renders as an unavailable state rather than a guess.
   */
  public getSampleRate(): number | null {
    const ctx = this.liveCtx ?? this.ctx;
    return ctx ? ctx.sampleRate : null;
  }

  public getLatencyMetrics(): AudioLatencyMetrics | null {
    const ctx = this.liveCtx ?? this.ctx;
    if (!ctx) return null;
    const baseLatency = (ctx as AudioContext & { baseLatency?: number }).baseLatency;
    const outputLatency = (ctx as AudioContext & { outputLatency?: number }).outputLatency;
    // Chromium renders in fixed 128-frame quanta; that is a block size, not a
    // round-trip latency, so both are reported and labelled separately.
    const renderQuantumSamples = 128;
    return {
      sampleRate: ctx.sampleRate,
      baseLatencySeconds: Number.isFinite(baseLatency) ? (baseLatency as number) : null,
      outputLatencySeconds: Number.isFinite(outputLatency) ? (outputLatency as number) : null,
      renderQuantumSamples,
      renderQuantumSeconds: renderQuantumSamples / ctx.sampleRate,
    };
  }

  /**
   * Discards every accumulated measurement. Callers that replace a project or
   * restart a take must not keep an integrated value that belongs to the
   * previous programme.
   */
  public resetMasterMeasurement(): void {
    this.loudnessMeter?.reset();
    this.truePeakMeter?.reset();
    this.stereoFieldMeter?.reset();
    this.measurementPlanner.reset();
  }

  private unavailableMasterMeasurement(availability: MasterMeasurementSnapshot['availability']): MasterMeasurementSnapshot {
    return {
      momentaryLufs: null,
      shortTermLufs: null,
      integratedLufs: null,
      blockCount: 0,
      gatedBlockCount: 0,
      measuredSeconds: 0,
      shortTermReady: false,
      truePeakDbfs: null,
      truePeakLeftDbfs: null,
      truePeakRightDbfs: null,
      samplePeakDbfs: null,
      oversampleFactor: this.truePeakMeter ? this.truePeakMeter.getReading().oversample : null,
      phaseCorrelation: null,
      sideMidRatioDb: null,
      midPowerDbfs: null,
      sidePowerDbfs: null,
      headroomDb: null,
      isClipping: null,
      isPumping: false,
      droppedSampleCount: this.measurementPlanner.unreadSampleCount,
      sampleRate: this.getSampleRate(),
      availability,
    };
  }

  /**
   * Adds the stereo measurement tap: master output -> ChannelSplitter(2) ->
   * one analyser per channel, both as leaves. The audible path is untouched.
   */
  private createMasterMeasurementTap(ctx: AudioContext | OfflineAudioContext): void {
    this.disposeMasterMeasurementTap();
    if (typeof ctx.createChannelSplitter !== 'function' || typeof ctx.createAnalyser !== 'function') {
      return;
    }

    const splitter = ctx.createChannelSplitter(2);
    // 4096 samples keeps ~85 ms of history at 48 kHz, which is more headroom
    // than the pump interval needs, so no audio is ever skipped between reads.
    const analyserL = ctx.createAnalyser();
    const analyserR = ctx.createAnalyser();
    for (const analyser of [analyserL, analyserR]) {
      analyser.fftSize = 4096;
      // Smoothing belongs to the FFT; time-domain reads must see raw samples
      // or the reconstructed peak and block energies would be filtered values.
      analyser.smoothingTimeConstant = 0;
    }

    this.masterSplitter = splitter;
    this.masterAnalyserL = analyserL;
    this.masterAnalyserR = analyserR;

    if (this.grossBeatNode) {
      this.grossBeatNode.connect(splitter);
      splitter.connect(analyserL, 0);
      splitter.connect(analyserR, 1);
    }

    const sampleRate = ctx.sampleRate;
    this.loudnessMeter = new LoudnessMeter(sampleRate);
    this.truePeakMeter = new TruePeakMeter({ oversample: 4, tapsPerPhase: 12 });
    this.stereoFieldMeter = new StereoFieldMeter();
    this.stereoFieldMeter.setSampleRate(sampleRate);
    this.measurementPlanner.reset();
  }

  private disposeMasterMeasurementTap(): void {
    try { this.masterSplitter?.disconnect(); } catch (_) { /* already torn down */ }
    try { this.masterAnalyserL?.disconnect(); } catch (_) { /* already torn down */ }
    try { this.masterAnalyserR?.disconnect(); } catch (_) { /* already torn down */ }
    this.masterSplitter = null;
    this.masterAnalyserL = null;
    this.masterAnalyserR = null;
    this.measurementScratch = null;
  }

  /**
   * Measurement is driven by the engine, not by whoever happens to be looking.
   * A modal that only samples while it is mounted would silently freeze the
   * integrated value, which is how a stale figure ends up presented as live.
   */
  private startMasterMeasurementPump(): void {
    if (this.measurementTimerId !== null) return;
    this.measurementPumping = true;
    this.measurementTimerId = setInterval(() => {
      this.pumpMasterMeasurement();
    }, 20);
    // A live timer holds the Node event loop open (tests, SSR). The pump is
    // housekeeping, never a reason to keep a process alive; browsers return a
    // plain number here, hence the capability check.
    const timer = this.measurementTimerId as unknown as { unref?: () => void };
    if (typeof timer?.unref === 'function') timer.unref();
  }

  private stopMasterMeasurementPump(): void {
    if (this.measurementTimerId !== null) {
      clearInterval(this.measurementTimerId);
      this.measurementTimerId = null;
    }
    this.measurementPumping = false;
  }

  /**
   * Consumes only the samples that arrived since the previous read.
   *
   * An AnalyserNode only offers the tail of its input, so the engine maps the
   * context clock onto a sample index and takes exactly the new region. If the
   * page was throttled and audio went by unread, the shortfall is counted and
   * published instead of being quietly guessed at.
   */
  private pumpMasterMeasurement(): void {
    if (this.isOfflineRendering) return;
    const ctx = this.ctx;
    if (!ctx || !this.masterAnalyserL || !this.masterAnalyserR) return;
    if (!this.loudnessMeter || !this.truePeakMeter || !this.stereoFieldMeter) return;

    const windows = this.readMasterChannelWindows();
    if (!windows) return;

    const size = windows.left.length;
    // Absolute sample index of the newest frame the context has rendered. The
    // planner decides which part of the tail has not been measured yet, and
    // counts anything that went by unread (published as droppedSampleCount
    // rather than quietly guessed at).
    const plan = this.measurementPlanner.plan(Math.floor(ctx.currentTime * ctx.sampleRate), size);
    if (plan.primed || plan.count <= 0) return;

    const left = windows.left.subarray(plan.offset, plan.offset + plan.count);
    const right = windows.right.subarray(plan.offset, plan.offset + plan.count);
    this.loudnessMeter.pushFrame(left, right);
    this.truePeakMeter.pushFrame(left, right);
    this.stereoFieldMeter.pushFrame(left, right);
  }

  /** Raw, unsmoothed time-domain windows of the two master channels. */
  private readMasterChannelWindows(): { left: Float32Array; right: Float32Array } | null {
    const analyserL = this.masterAnalyserL;
    const analyserR = this.masterAnalyserR;
    if (!analyserL || !analyserR) return null;

    const size = analyserL.fftSize;
    if (!this.measurementScratch || this.measurementScratch.left.length !== size) {
      this.measurementScratch = { left: new Float32Array(size), right: new Float32Array(size) };
    }
    analyserL.getFloatTimeDomainData(this.measurementScratch.left);
    analyserR.getFloatTimeDomainData(this.measurementScratch.right);
    return this.measurementScratch;
  }

  // Real-time timeline tape scrub audition sound synthesis
  public playTimelineScrubSound(bar: number, speedMultiplier: number = 1.0) {
    if (this.shouldBlockLiveMutation()) return;
    const ctx = this.getContext();
    if (ctx.state === 'suspended') ctx.resume();

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    // Analog tape scrub pitch calculation based on bar and scrub speed
    const baseFreq = 110 * Math.pow(2, ((bar % 12) + 24) / 12);
    const scrubPitch = Math.max(60, Math.min(3000, baseFreq * speedMultiplier));

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(scrubPitch, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, scrubPitch * 0.4), now + 0.08);

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(Math.min(4000, scrubPitch * 1.5), now);
    filter.Q.value = 3.0;

    gain.gain.setValueAtTime(0.2, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.connect(filter);
    filter.connect(gain);
    if (this.masterGain) {
      gain.connect(this.masterGain);
    } else {
      gain.connect(ctx.destination);
    }

    osc.start(now);
    osc.stop(now + 0.09);
  }
}

/**
 * Default synth parameters shared by the engine and by preset construction.
 * Exported at module scope so presets can call it without importing the
 * `audioEngine` singleton (which would create a circular import between
 * `audioEngine` and `presets` and trigger a TDZ at module load).
 */
export function getDefaultSynthParamsValue(): SynthParameters {
  return {
    osc1Type: 'sawtooth',
    osc1Octave: 0,
    osc1Detune: 0,
    osc1Mix: 0.8,

    osc2Type: 'square',
    osc2Octave: 0,
    osc2Detune: 7,
    osc2Mix: 0.5,

    filterType: 'lowpass',
    filterCutoff: 3500,
    filterResonance: 2.5,
    filterEnvAmount: 0.4,

    attack: 0.01,
    decay: 0.25,
    sustain: 0.6,
    release: 0.2,

    lfoRate: 4,
    lfoDepth: 0.1,
    lfoTarget: 'none',

    fmCarrierMultiplier: 1.0,
    fmModulatorMultiplier: 2.0,
    fmModulationIndex: 200,
    fmFeedback: 0,

    sampleRootNote: 60,
    sampleGlide: 0,
    sampleReverse: false,
    sampleLoop: false,
    sampleDrive: 0,
  };
}

export const audioEngine = new AudioEngine();
