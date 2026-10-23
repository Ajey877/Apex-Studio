/**
 * Phase 8C — Audio-to-MIDI: real monophonic transcription of an audio clip.
 *
 * WHAT THIS MODULE DOES
 * 1. Resolves the audible window of a playlist audio clip in SOURCE samples:
 *    `offsetSteps` trim, `lengthBars` window and `timeStretchRate` are applied
 *    exactly the way `audioEngine.playAudioClipWithFades` applies them, so the
 *    analysed samples are the samples the user hears.
 * 2. Measures pitch with the SHARED YIN detector (`pitchDetection.ts` — the
 *    same implementation the Vocal Tuner's offline correction uses; there is
 *    no second detector in the codebase).
 * 3. Maps measured F0 to sounding MIDI pitch, compensating the clip's real
 *    transforms: `pitchShiftSemitones` is a detune in cents and
 *    `timeStretchRate` is a playback rate — so the sounding pitch is
 *    `measured + pitchShiftSemitones + 12·log2(rate)` and the sounding time is
 *    `source time / rate`.
 * 4. Segments the voiced contour into notes: a sustained pitch stays one note,
 *    a persistent semitone change starts a new one, a short dip does not, and
 *    gaps close the note. Pitches are the segment median, so vibrato and noisy
 *    frame-to-frame wobble cannot explode into extra notes.
 * 5. Converts note times to the project's authoritative sixteenth-note steps
 *    with the real BPM (`stepsToBeats`/`beatsToSeconds`), legalises durations
 *    with `quantizeDurationSteps` and refuses to emit overlaps.
 *
 * WHAT IT REFUSES (typed, with a message, ZERO mutation)
 * - anything that is not a real audio clip with real PCM;
 * - clips whose analysis window is outside the source, shorter than an honest
 *   analysis, or longer than the supported window;
 * - silence, noise and pitch that is not confidently voiced;
 * - material whose measured pitch is not harmonically consistent (chords and
 *   other polyphonic sources) — this tool does NOT do polyphonic transcription,
 *   chord separation or source separation;
 * - material that only yields a churn of ultra-short notes.
 *
 * LIMITS, STATED PLAINLY
 * - Monophonic, clearly voiced melodic material whose fundamentals lie inside
 *   75–1000 Hz (≈ E2–B5). Harmonics are never reported as extra notes.
 * - No formant, timbre or instrument identification; no velocity other than a
 *   loudness-derived estimate.
 * - No per-note manual pitch correction here: the user reviews and edits the
 *   committed notes in the Piano Roll.
 * - Pure and deterministic: identical PCM + options ⇒ identical notes.
 */
import type { PlaylistClip } from '../types/daw';
import { beatsPerBar, stepsPerBar } from '../music/musicalTime';
import {
  MIN_NOTE_DURATION_STEPS,
  quantizeDurationSteps,
} from '../music/noteDurationPolicy';
import {
  PITCH_ANALYSIS_HOP,
  PITCH_ANALYSIS_WINDOW,
  PITCH_F0_MAX_HZ,
  PITCH_F0_MIN_HZ,
  PITCH_MIN_SOURCE_FRAMES,
  PitchDetectionError,
  detectPitchFrames,
  frequencyToMidi,
  midiToNoteName,
  type DetectedPitchFrame,
  type PitchFrameDetection,
} from './pitchDetection';


/** Shortest audible window worth analysing (a musically useless sliver). */
export const AUDIO_TO_MIDI_MIN_WINDOW_SECONDS = 0.25;
/** Longest clip this MVP analyses in one pass (bounded CPU, honest about it). */
export const AUDIO_TO_MIDI_MAX_ANALYSIS_SECONDS = 30;
/** Default controls: fine timing, conservative confidence, no coarse snap. */
export const AUDIO_TO_MIDI_DEFAULT_MIN_NOTE_STEPS = 0.5;
export const AUDIO_TO_MIDI_DEFAULT_SENSITIVITY = 0.5;
export const AUDIO_TO_MIDI_DEFAULT_QUANTIZE_STEPS = 0.25;
export const AUDIO_TO_MIDI_MIN_NOTE_STEPS_FLOOR = MIN_NOTE_DURATION_STEPS;
export const AUDIO_TO_MIDI_MAX_NOTE_STEPS = 8;
export const AUDIO_TO_MIDI_MIN_SENSITIVITY = 0.2;
export const AUDIO_TO_MIDI_MAX_SENSITIVITY = 0.95;
/** Timing grids the UI offers (in sixteenth-note steps). */
export const AUDIO_TO_MIDI_QUANTIZE_CHOICES: readonly number[] = [0.25, 0.5, 1, 2, 4];

/** Harmonic-consistency window: three fundamentals, clamped. */
export const AUDIO_TO_MIDI_HARMONIC_PERIODS = 3;
export const AUDIO_TO_MIDI_HARMONIC_MIN_WINDOW = 512;
/** Half-width of the centred median filter over the pitch contour (~35 ms). */
export const AUDIO_TO_MIDI_SMOOTH_FRAMES = 12;
/** Frames an alternative semitone must persist before a note change is accepted (~15 ms). */
export const AUDIO_TO_MIDI_SEMITONE_CONFIRM_FRAMES = 5;
/** Silent frames that close a note (~12 ms). */
export const AUDIO_TO_MIDI_GAP_FRAMES = 12;
/** Minimum share of the clip that must be confidently voiced. */
export const AUDIO_TO_MIDI_MIN_VOICED_RATIO = 0.15;
/** Below this coverage the clip is mostly unpitched; refusals say so explicitly. */
export const AUDIO_TO_MIDI_SHORT_COVERAGE_RATIO = 0.2;
export const AUDIO_TO_MIDI_MIN_VOICED_FRAMES = 12;
/** Median confidence a transcribable clip must reach. */
export const AUDIO_TO_MIDI_MIN_CONFIDENCE = 0.45;
/** Median harmonic energy ratio below which the source is not monophonic enough. */
export const AUDIO_TO_MIDI_MIN_HARMONIC_RATIO = 0.6;

/** Most notes this MVP will propose for one clip (a churn means unreliable input). */
export const AUDIO_TO_MIDI_MAX_NOTES = 192;

export type AudioToMidiRefusal =
  | 'invalid-options'
  | 'not-audio-clip'
  | 'no-source-audio'
  | 'source-unavailable'
  | 'source-too-short'
  | 'clip-outside-source'
  | 'clip-too-long'
  | 'short-coverage'
  | 'silence-or-noise'
  | 'unreliable-pitch'
  | 'polyphonic-suspected'
  | 'no-notes';

/** Typed refusal so the UI can show a specific, honest message. */
export class AudioToMidiError extends Error {
  public readonly failure: AudioToMidiRefusal;
  constructor(failure: AudioToMidiRefusal, message: string) {
    super(message);
    this.name = 'AudioToMidiError';
    this.failure = failure;
  }
}

export interface AudioToMidiOptions {
  /** Shortest accepted note, in sixteenth-note steps. */
  minNoteSteps?: number;
  /** YIN confidence a frame must reach to count as voiced. */
  sensitivity?: number;
  /** Grid the note starts/lengths snap to, in steps (0.25 = the duration grid). */
  quantizeSteps?: number;
}

export interface ResolvedAudioToMidiOptions {
  minNoteSteps: number;
  sensitivity: number;
  quantizeSteps: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Validates the three user controls. Throws a typed error, never clamps silently. */
export const normalizeAudioToMidiOptions = (
  candidate?: AudioToMidiOptions | null
): ResolvedAudioToMidiOptions => {
  const raw = candidate && typeof candidate === 'object' ? candidate : {};
  const minNoteSteps = raw.minNoteSteps ?? AUDIO_TO_MIDI_DEFAULT_MIN_NOTE_STEPS;
  const sensitivity = raw.sensitivity ?? AUDIO_TO_MIDI_DEFAULT_SENSITIVITY;
  const quantizeSteps = raw.quantizeSteps ?? AUDIO_TO_MIDI_DEFAULT_QUANTIZE_STEPS;

  if (
    typeof minNoteSteps !== 'number' ||
    !Number.isFinite(minNoteSteps) ||
    minNoteSteps < AUDIO_TO_MIDI_MIN_NOTE_STEPS_FLOOR ||
    minNoteSteps > AUDIO_TO_MIDI_MAX_NOTE_STEPS
  ) {
    throw new AudioToMidiError(
      'invalid-options',
      `Minimum note length must be between ${AUDIO_TO_MIDI_MIN_NOTE_STEPS_FLOOR} and ${AUDIO_TO_MIDI_MAX_NOTE_STEPS} sixteenth-note steps.`
    );
  }
  if (
    typeof sensitivity !== 'number' ||
    !Number.isFinite(sensitivity) ||
    sensitivity < AUDIO_TO_MIDI_MIN_SENSITIVITY ||
    sensitivity > AUDIO_TO_MIDI_MAX_SENSITIVITY
  ) {
    throw new AudioToMidiError(
      'invalid-options',
      `Sensitivity (pitch confidence floor) must be between ${AUDIO_TO_MIDI_MIN_SENSITIVITY} and ${AUDIO_TO_MIDI_MAX_SENSITIVITY}.`
    );
  }
  if (
    typeof quantizeSteps !== 'number' ||
    !Number.isFinite(quantizeSteps) ||
    quantizeSteps < MIN_NOTE_DURATION_STEPS ||
    quantizeSteps > 4 ||
    Math.abs(quantizeSteps / MIN_NOTE_DURATION_STEPS - Math.round(quantizeSteps / MIN_NOTE_DURATION_STEPS)) > 1e-9
  ) {
    throw new AudioToMidiError(
      'invalid-options',
      `The timing grid must be one of ${AUDIO_TO_MIDI_QUANTIZE_CHOICES.join(', ')} steps.`
    );
  }
  return { minNoteSteps, sensitivity, quantizeSteps };
};

/** Project timing facts the transcription needs. */
export interface AudioToMidiTimingContext {
  bpm: number;
  timeSignature: readonly [number, number];
}

/** How a clip is actually heard: source window plus the two real transforms. */
export interface ClipTimelinePlan {
  /** Where the clip starts on the timeline, in sixteenth-note steps. */
  clipStartStep: number;
  /** Audible length of the clip on the timeline, in seconds. */
  timelineSeconds: number;
  /** Where analysis starts inside the source buffer, in seconds. */
  sourceOffsetSeconds: number;
  /** Source-buffer seconds the audible window covers. */
  sourceWindowSeconds: number;
  /** Playback rate the engine applies (`timeStretchRate`). */
  playbackRate: number;
  /** Constant pitch offset the engine applies (detune + rate), in semitones. */
  pitchOffsetSemitones: number;
  /** Sixteenth-note steps per second at the project tempo. */
  stepsPerSecond: number;
  /** 0 when the clip has no trim/pitch/rate transforms. */
  hasTransforms: boolean;
}

export const secondsPerBar = (meter: readonly [number, number], bpm: number): number =>
  beatsPerBar(meter) * (60 / bpm);

/**
 * Derives the audible source window and the two constant transforms of a clip.
 * Mirrors `audioEngine.playAudioClipWithFades`:
 *
 *   bufferOffset   = (offsetSteps · secondsPerStep) · rate
 *   audibleBuffer  = min(buffer.duration − offset, lengthBars · secondsPerBar · rate)
 *
 * Throws typed refusals when the window cannot be analysed honestly.
 */
export const describeClipTimeline = (
  clip: PlaylistClip,
  timing: AudioToMidiTimingContext,
  bufferDurationSeconds: number
): ClipTimelinePlan => {
  if (!clip || clip.type !== 'audio') {
    throw new AudioToMidiError(
      'not-audio-clip',
      'Audio-to-MIDI analyses audio clips. Select an audio clip in the Playlist Arranger — pattern and automation clips carry no source audio.'
    );
  }
  if (!clip.audioBufferId) {
    throw new AudioToMidiError(
      'no-source-audio',
      `"${clip.name}" has no source audio asset, so there is nothing to analyse.`
    );
  }
  const bpm = Number.isFinite(timing?.bpm) && timing.bpm > 0 ? timing.bpm : 120;
  const meter = Array.isArray(timing?.timeSignature) && timing.timeSignature.length === 2
    ? timing.timeSignature
    : ([4, 4] as const);
  const barSeconds = secondsPerBar(meter, bpm);
  if (!Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0) {
    throw new AudioToMidiError(
      'not-audio-clip',
      `"${clip.name}" has an invalid length, so its audible window cannot be resolved.`
    );
  }
  if (!Number.isFinite(bufferDurationSeconds) || bufferDurationSeconds <= 0) {
    throw new AudioToMidiError(
      'source-too-short',
      `"${clip.name}" has no usable source audio (${String(bufferDurationSeconds)} s).`
    );
  }

  const secondsPerStep = 60 / bpm / 4;
  const stepsPerSecond = 1 / secondsPerStep;
  const rawRate = clip.timeStretchRate;
  const playbackRate = Number.isFinite(rawRate) && (rawRate as number) > 0 ? (rawRate as number) : 1;
  const pitchShift = Number.isFinite(clip.pitchShiftSemitones) ? (clip.pitchShiftSemitones as number) : 0;
  const pitchOffsetSemitones = pitchShift + 12 * Math.log2(playbackRate);

  const timelineSeconds = clip.lengthBars * barSeconds;
  const sourceOffsetSeconds = Math.max(0, (clip.offsetSteps || 0) * secondsPerStep) * playbackRate;
  if (sourceOffsetSeconds >= bufferDurationSeconds) {
    throw new AudioToMidiError(
      'clip-outside-source',
      `"${clip.name}" is trimmed past the end of its source audio (offset ${sourceOffsetSeconds.toFixed(2)} s of ${bufferDurationSeconds.toFixed(2)} s), so no audible audio remains to analyse.`
    );
  }
  const sourceWindowSeconds = Math.min(
    bufferDurationSeconds - sourceOffsetSeconds,
    timelineSeconds * playbackRate
  );
  if (sourceWindowSeconds * 1000 <= 0) {
    throw new AudioToMidiError('clip-outside-source', `"${clip.name}" has no audible audio inside its source.`);
  }

  return {
    clipStartStep: Math.max(0, clip.startBar || 0) * stepsPerBar(meter),
    timelineSeconds,
    sourceOffsetSeconds,
    sourceWindowSeconds,
    playbackRate,
    pitchOffsetSemitones,
    stepsPerSecond,
    hasTransforms:
      Math.abs(playbackRate - 1) > 1e-9 || Math.abs(pitchShift) > 1e-9 || (clip.offsetSteps || 0) > 0,
  };
};

/** One proposed MIDI note, already in project steps. */
export interface TranscribedMidiNote {
  index: number;
  /** Integer MIDI note number of the sounding pitch. */
  midi: number;
  noteName: string;
  /** Relative to the clip's first beat (step 0 = the clip start). */
  startStep: number;
  durationSteps: number;
  /** Timeline seconds from the clip start. */
  startSeconds: number;
  endSeconds: number;
  /** 0–1 mean YIN confidence of the frames in the note. */
  confidence: number;
  /** Mean signed cents between the measured pitch and `midi`. */
  centsOffset: number;
  /** Loudness-derived velocity (0.2–1). */
  velocity: number;
}

export interface AudioToMidiStats {
  frameCount: number;
  voicedFrameCount: number;
  voicedRatio: number;
  medianConfidence: number;
  medianF0Hz: number | null;
  medianHarmonicRatio: number;
  analysedSourceSeconds: number;
  /** Loudest frame RMS — distinguishes silence from "signal, no stable pitch". */
  peakRms: number;
  analysisMilliseconds?: number;
  segmentsFound: number;
  droppedShortSegments: number;
  noteCount: number;
  meanConfidence: number;
  lowestMidi: number | null;
  highestMidi: number | null;
}

export interface AudioToMidiAnalysis {
  status: 'ok' | 'rejected';
  refusal: AudioToMidiRefusal | null;
  /** Empty when accepted; a complete sentence otherwise. */
  message: string;
  plan: ClipTimelinePlan | null;
  notes: TranscribedMidiNote[];
  stats: AudioToMidiStats | null;
  settings: ResolvedAudioToMidiOptions;
  /** Raw detector output (voiced frames only are meaningful; kept for diagnostics/tests). */
  detection: PitchFrameDetection | null;
}

/**
 * Spectral test for "is this one harmonic series?".
 *
 * For a genuinely monophonic harmonic tone, almost all energy lies on integer
 * multiples of its fundamental. A chord or a mixed source puts energy on
 * frequencies that are not multiples of the measured F0, so the ratio drops.
 * This is a check on the SHARED detector's answer, not a second pitch detector.
 */
export const harmonicEnergyRatio = (
  x: Float64Array | Float32Array,
  start: number,
  f0Hz: number,
  sampleRate: number,
  windowSamples: number = PITCH_ANALYSIS_WINDOW,
  maxHarmonics = 40
): number => {
  if (!(f0Hz > 0)) return 0;
  let total = 0;
  for (let n = 0; n < windowSamples; n += 1) {
    const sample = x[start + n];
    total += sample * sample;
  }
  if (total <= 1e-12) return 0;
  let harmonic = 0;
  for (let k = 1; k <= maxHarmonics; k += 1) {
    const frequency = f0Hz * k;
    if (frequency >= sampleRate / 2) break;
    const omega = (2 * Math.PI * frequency) / sampleRate;
    let re = 0;
    let im = 0;
    for (let n = 0; n < windowSamples; n += 1) {
      const sample = x[start + n];
      re += sample * Math.cos(omega * n);
      im += sample * Math.sin(omega * n);
    }
    const amplitude = (2 / windowSamples) * Math.sqrt(re * re + im * im);
    harmonic += (amplitude * amplitude) / 2;
  }
  // `total` is a SUM over samples; harmonic energy is per-sample-equivalent, so
  // compare against the mean energy per sample.
  return clamp(harmonic / (total / windowSamples), 0, 1);
};

interface RawSegment {
  startFrame: number;
  endFrame: number; // exclusive
  midis: number[];
  confidences: number[];
  rms: number[];
}

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
};

/**
 * Centred running median of a voiced MIDI contour.
 *
 * This is what makes vibrato (and frame-to-frame jitter) harmless: a ±30 cent
 * vibrato at 5 Hz oscillates around ONE pitch, and the median over ~100 ms is
 * that pitch. A real note change is a step, which the same filter keeps (it
 * only smears the boundary by the filter's half-width, which the note times
 * account for).
 */
export const smoothPitchContour = (
  values: readonly (number | null)[],
  halfWindow: number = AUDIO_TO_MIDI_SMOOTH_FRAMES
): (number | null)[] => {
  const out: (number | null)[] = new Array(values.length).fill(null);
  const buffer: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] === null) continue;
    buffer.length = 0;
    for (let k = i - halfWindow; k <= i + halfWindow; k += 1) {
      const value = k >= 0 && k < values.length ? values[k] : null;
      if (value !== null) buffer.push(value);
    }
    out[i] = median(buffer);
  }
  return out;
};

/**
 * Turns a voiced pitch contour into note segments.
 *
 * The contour is smoothed first (`smoothPitchContour`), then:
 * - a run of frames whose smoothed semitone differs from the current note is
 *   only accepted after `AUDIO_TO_MIDI_SEMITONE_CONFIRM_FRAMES` frames, so a
 *   brief wobble never splits a note;
 * - `AUDIO_TO_MIDI_GAP_FRAMES` unvoiced frames close the note, so breaths and
 *   gaps stay gaps;
 * - segments shorter than `minFrames` are dropped when they end a note, and
 *   merged into the previous note when they merely return to its pitch.
 */
export const segmentPitchContour = (
  frames: readonly DetectedPitchFrame[],
  options: { sensitivity: number; minFrames: number }
): { segments: RawSegment[]; dropped: number } => {
  const { sensitivity, minFrames } = options;
  const usable = frames.map(frame =>
    frame.voiced && frame.f0Hz !== null && frame.confidence >= sensitivity
      ? frequencyToMidi(frame.f0Hz as number)
      : null
  );
  const smoothed = smoothPitchContour(usable);

  const segments: RawSegment[] = [];
  let current: RawSegment | null = null;
  let currentSemitone = 0;
  let changeRunStart: number | null = null;
  let changeRunSemitone = 0;
  let unvoicedRun = 0;
  let dropped = 0;

  const push = (segment: RawSegment, frame: DetectedPitchFrame, midi: number) => {
    segment.endFrame = frame.index + 1;
    segment.midis.push(midi);
    segment.confidences.push(frame.confidence);
    segment.rms.push(frame.rms);
  };

  const close = (segment: RawSegment | null) => {
    if (!segment) return;
    if (segment.endFrame - segment.startFrame < minFrames) {
      dropped += 1;
      const previous = segments[segments.length - 1];
      if (previous && Math.round(median(previous.midis)) === Math.round(median(segment.midis))) {
        previous.endFrame = segment.endFrame;
        previous.midis.push(...segment.midis);
        previous.confidences.push(...segment.confidences);
        previous.rms.push(...segment.rms);
        dropped -= 1;
      }
      return;
    }
    segments.push(segment);
  };

  for (const frame of frames) {
    const measured = usable[frame.index];
    const smoothedValue = smoothed[frame.index];

    if (measured === null || smoothedValue === null) {
      unvoicedRun += 1;
      changeRunStart = null;
      if (current && unvoicedRun >= AUDIO_TO_MIDI_GAP_FRAMES) {
        close(current);
        current = null;
      }
      continue;
    }

    unvoicedRun = 0;
    if (!current) {
      current = {
        startFrame: frame.index,
        endFrame: frame.index + 1,
        midis: [measured],
        confidences: [frame.confidence],
        rms: [frame.rms],
      };
      currentSemitone = Math.round(smoothedValue);
      changeRunStart = null;
      continue;
    }

    push(current, frame, measured);
    const semitone = Math.round(smoothedValue);
    if (semitone === currentSemitone) {
      changeRunStart = null;
      continue;
    }
    if (changeRunStart === null || semitone !== changeRunSemitone) {
      changeRunStart = frame.index;
      changeRunSemitone = semitone;
    }
    if (frame.index - changeRunStart + 1 < AUDIO_TO_MIDI_SEMITONE_CONFIRM_FRAMES) continue;

    // Accepted change: cut the old note at the run start and start the new note
    // there, so the new note's onset is where the pitch actually moved.
    const splitAt = changeRunStart;
    const keepCount = Math.max(1, splitAt - current.startFrame);
    const beforeJoin: RawSegment = {
      startFrame: current.startFrame,
      endFrame: splitAt,
      midis: current.midis.slice(0, keepCount),
      confidences: current.confidences.slice(0, keepCount),
      rms: current.rms.slice(0, keepCount),
    };
    const tail: RawSegment = {
      startFrame: splitAt,
      endFrame: current.endFrame,
      midis: current.midis.slice(keepCount),
      confidences: current.confidences.slice(keepCount),
      rms: current.rms.slice(keepCount),
    };
    close(beforeJoin);
    current = tail.midis.length > 0 ? tail : {
      startFrame: splitAt,
      endFrame: frame.index + 1,
      midis: [measured],
      confidences: [frame.confidence],
      rms: [frame.rms],
    };
    currentSemitone = Math.round(smoothedValue);
    changeRunStart = null;
  }
  close(current);
  return { segments, dropped };
};

const REFUSAL_MESSAGES = {
  'short-coverage': (ratio: number) =>
    `Only ${(ratio * 100).toFixed(1)} % of this clip's frames carry a confidently measured pitch. Audio-to-MIDI needs steady, clearly voiced monophonic melodic material: silence, breaths, noise, chords, heavy vibrato and rapid pitch movement all measure as unvoiced. Nothing was transcribed and the project was not changed.`,
  'silence-or-noise': () =>
    'This clip measured as silence or unpitched noise: almost no frame carries a confident fundamental. Nothing was transcribed and the project was not changed.',
  'unreliable-pitch': (confidence: number) =>
    `The measured pitch in this clip is not stable enough to transcribe (median confidence ${(confidence * 100).toFixed(0)} %). Pitch-shifted noise, speech-like or mixed material cannot be turned into reliable notes; nothing was transcribed.`,
  'polyphonic-suspected': (ratio: number) =>
    `The audio is not a single harmonic series (${(ratio * 100).toFixed(0)} % of the measured energy sits on the detected fundamental's harmonics). Chords and other polyphonic material are NOT transcribed by this tool — separate the source into a monophonic line first. Nothing was transcribed.`,
  'no-notes': (minSteps: number) =>
    `No note survived the ${minSteps}-step minimum length and the confidence filter, so there is nothing to commit. Try a lower minimum length or a cleaner monophonic take.`,
} as const;

/** Median harmonic ratio sampled across the confidently voiced frames. */
const sampleHarmonicRatio = (
  mono: Float64Array | Float32Array,
  frames: readonly DetectedPitchFrame[],
  sampleRate: number,
  windowSamples: number = PITCH_ANALYSIS_WINDOW,
  maxSamples = 96
): number => {
  const voiced = frames.filter(frame => frame.voiced && frame.f0Hz !== null);
  if (voiced.length === 0) return 0;
  const step = Math.max(1, Math.floor(voiced.length / maxSamples));
  const ratios: number[] = [];
  for (let i = 0; i < voiced.length; i += step) {
    const frame = voiced[i];
    // A period-scaled window (3 periods, clamped) keeps the check valid for
    // vibrato: over fewer periods the modulated pitch barely drifts, so an
    // honest melody is not misread as a chord.
    const f0 = frame.f0Hz as number;
    const periodWindow = Math.min(
      PITCH_ANALYSIS_WINDOW,
      Math.max(AUDIO_TO_MIDI_HARMONIC_MIN_WINDOW, Math.round(AUDIO_TO_MIDI_HARMONIC_PERIODS * sampleRate / f0))
    );
    const start = Math.min(Math.max(0, mono.length - periodWindow), frame.index * PITCH_ANALYSIS_HOP);
    ratios.push(harmonicEnergyRatio(mono, start, f0, sampleRate, periodWindow));
  }
  return median(ratios);
};

/**
 * Transcribes real PCM into project-step MIDI notes. Pure: the caller supplies
 * the source channel data and a resolved plan; nothing is mutated.
 */
export const transcribePcmToMidi = (
  channels: readonly Float32Array[],
  sampleRate: number,
  plan: ClipTimelinePlan,
  optionsCandidate?: AudioToMidiOptions | null
): AudioToMidiAnalysis => {
  const settings = normalizeAudioToMidiOptions(optionsCandidate);
  const empty: AudioToMidiAnalysis = {
    status: 'rejected',
    refusal: null,
    message: '',
    plan,
    notes: [],
    stats: null,
    settings,
    detection: null,
  };

  const totalSamples = channels[0]?.length ?? 0;
  const offsetSamples = Math.round(plan.sourceOffsetSeconds * sampleRate);
  const windowSamples = Math.min(
    totalSamples - offsetSamples,
    Math.round(plan.sourceWindowSeconds * sampleRate)
  );
  if (
    windowSamples < PITCH_MIN_SOURCE_FRAMES ||
    windowSamples / sampleRate < AUDIO_TO_MIDI_MIN_WINDOW_SECONDS
  ) {
    throw new AudioToMidiError(
      'source-too-short',
      `The audible part of this clip is ${(windowSamples / sampleRate).toFixed(3)} s — too short for an honest pitch analysis. Nothing was transcribed.`
    );
  }
  if (windowSamples / sampleRate > AUDIO_TO_MIDI_MAX_ANALYSIS_SECONDS) {
    throw new AudioToMidiError(
      'clip-too-long',
      `This clip's audible window is ${(windowSamples / sampleRate).toFixed(1)} s. Audio-to-MIDI in this build analyses up to ${AUDIO_TO_MIDI_MAX_ANALYSIS_SECONDS} s per clip; trim the clip (or split it) and analyse the section you need. Nothing was transcribed.`
    );
  }

  const slice = channels.map(data => data.subarray(offsetSamples, offsetSamples + windowSamples));
  let detection: PitchFrameDetection;
  try {
    detection = detectPitchFrames(slice, sampleRate);
  } catch (error) {
    if (error instanceof PitchDetectionError) {
      throw new AudioToMidiError('source-too-short', error.message);
    }
    throw error;
  }

  const frameSeconds = detection.hopSamples / sampleRate;
  const stepsPerFrame = frameSeconds * plan.stepsPerSecond;
  const minFrames = Math.max(1, Math.ceil(settings.minNoteSteps / stepsPerFrame));
  const { segments, dropped } = segmentPitchContour(detection.frames, {
    sensitivity: settings.sensitivity,
    minFrames,
  });

  const mono = (() => {
    const mixed = new Float32Array(windowSamples);
    for (const data of slice) {
      for (let i = 0; i < windowSamples; i += 1) mixed[i] += data[i] / slice.length;
    }
    return mixed;
  })();
  // Measure harmonic consistency over the SAME window the detector used: a
  // long window on vibrato would compare against a moving fundamental and
  // wrongly classify an honest melody as polyphonic.
  const harmonicRatio = sampleHarmonicRatio(
    mono,
    detection.frames,
    sampleRate,
    detection.windowSamples
  );

  const voicedConfidences = detection.frames
    .filter(frame => frame.voiced)
    .map(frame => frame.confidence);
  const medianConfidence = median(voicedConfidences);
  const maxRms = segments.reduce(
    (max, segment) => Math.max(max, ...segment.rms),
    0
  );

  const notes: TranscribedMidiNote[] = [];
  const grid = settings.quantizeSteps;
  let previousEnd = 0;
  for (const segment of segments) {
    const midiFloat = median(segment.midis) + plan.pitchOffsetSemitones;
    const midi = Math.round(midiFloat);
    if (midi < 0 || midi > 127) continue;
    // A note starts at its first frame's window START (the frame that first
    // contains the new pitch) and ends at the CENTRE of the last frame that
    // carried it — half a window past that frame's start. Both edges are then
    // converted from source time to timeline time with the clip's real playback
    // rate, which is what the engine applies.
    const halfWindowSeconds = PITCH_ANALYSIS_WINDOW / 2 / sampleRate;
    const startSeconds = (segment.startFrame * frameSeconds) / plan.playbackRate;
    const endSeconds = (((segment.endFrame - 1) * frameSeconds) + halfWindowSeconds) / plan.playbackRate;
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) continue;
    const clampedEnd = Math.min(endSeconds, plan.timelineSeconds);

    // Quantize to the chosen grid so the note sits on a legal project time.
    let startStep = Math.round((startSeconds * plan.stepsPerSecond) / grid) * grid;
    let endStep = Math.round((clampedEnd * plan.stepsPerSecond) / grid) * grid;
    if (startStep < previousEnd) startStep = Math.ceil(previousEnd / grid) * grid;
    if (endStep <= startStep) endStep = startStep + grid;
    const durationSteps = quantizeDurationSteps(
      Math.max(settings.minNoteSteps, endStep - startStep)
    );
    if (durationSteps < settings.minNoteSteps - 1e-9) continue;

    const segmentRms = segment.rms.reduce((sum, value) => sum + value, 0) / Math.max(1, segment.rms.length);
    const loudness = maxRms > 1e-9 ? Math.sqrt(clamp(segmentRms / maxRms, 0, 1)) : 0.6;
    const velocity = clamp(0.35 + 0.65 * loudness, 0.2, 1);

    notes.push({
      index: notes.length,
      midi,
      noteName: midiToNoteName(midi),
      startStep,
      durationSteps,
      startSeconds: startStep / plan.stepsPerSecond,
      endSeconds: (startStep + durationSteps) / plan.stepsPerSecond,
      confidence: segment.confidences.reduce((sum, value) => sum + value, 0) / Math.max(1, segment.confidences.length),
      centsOffset: (midiFloat - midi) * 100,
      velocity,
    });
    previousEnd = startStep + durationSteps;
  }

  const stats: AudioToMidiStats = {
    frameCount: detection.frameCount,
    voicedFrameCount: detection.voicedFrameCount,
    voicedRatio: detection.voicedRatio,
    medianConfidence,
    medianF0Hz: detection.medianF0Hz,
    medianHarmonicRatio: harmonicRatio,
    analysedSourceSeconds: windowSamples / sampleRate,
    peakRms: detection.frames.reduce((max, frame) => Math.max(max, frame.rms), 0),
    segmentsFound: segments.length,
    droppedShortSegments: dropped,
    noteCount: notes.length,
    meanConfidence: notes.length > 0
      ? notes.reduce((sum, note) => sum + note.confidence, 0) / notes.length
      : 0,
    lowestMidi: notes.length > 0 ? Math.min(...notes.map(note => note.midi)) : null,
    highestMidi: notes.length > 0 ? Math.max(...notes.map(note => note.midi)) : null,
  };

  const reject = (refusal: AudioToMidiRefusal, message: string): AudioToMidiAnalysis => ({
    ...empty,
    refusal,
    message,
    stats,
    detection,
  });

  if (
    detection.voicedFrameCount < AUDIO_TO_MIDI_MIN_VOICED_FRAMES ||
    detection.voicedRatio < AUDIO_TO_MIDI_MIN_VOICED_RATIO
  ) {
    // Energy but no stable fundamental is a different failure from silence:
    // say so, because chords/noise are what the user usually has.
    if (stats.peakRms > 1e-3) {
      return reject(
        'unreliable-pitch',
        'This clip carries audio but almost no frame yields a stable fundamental. Noise, chords and other polyphonic material are NOT transcribed by this tool, and pitches outside 75–1000 Hz are honestly unvoiced — nothing was transcribed.'
      );
    }
    return reject('silence-or-noise', REFUSAL_MESSAGES['silence-or-noise']());
  }
  if (detection.voicedRatio < AUDIO_TO_MIDI_SHORT_COVERAGE_RATIO) {
    // Confident frames exist but the clip is mostly unpitched: report the
    // coverage honestly rather than inventing notes for the gaps.
    return reject('short-coverage', REFUSAL_MESSAGES['short-coverage'](detection.voicedRatio));
  }
  if (medianConfidence < AUDIO_TO_MIDI_MIN_CONFIDENCE) {
    return reject('unreliable-pitch', REFUSAL_MESSAGES['unreliable-pitch'](medianConfidence));
  }
  if (harmonicRatio < AUDIO_TO_MIDI_MIN_HARMONIC_RATIO) {
    return reject('polyphonic-suspected', REFUSAL_MESSAGES['polyphonic-suspected'](harmonicRatio));
  }
  if (notes.length === 0) {
    return reject('no-notes', REFUSAL_MESSAGES['no-notes'](settings.minNoteSteps));
  }
  if (notes.length > AUDIO_TO_MIDI_MAX_NOTES) {
    return reject(
      'unreliable-pitch',
      `The analysis produced ${notes.length} notes, which means the pitch contour is churning rather than holding notes. Nothing was transcribed — this tool does not guess through unstable input.`
    );
  }

  return { ...empty, status: 'ok', refusal: null, message: '', notes, stats, detection };
};

/** Minimal surface of an AudioBuffer this module needs (keeps tests trivial). */
export interface AnalysableBuffer {
  duration: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/**
 * End-to-end analysis of a real playlist audio clip: resolve its audible window,
 * then transcribe it. Throws typed `AudioToMidiError`s for unusable clips.
 */
export const analyseAudioClipForMidi = (
  clip: PlaylistClip,
  buffer: AnalysableBuffer,
  timing: AudioToMidiTimingContext,
  options?: AudioToMidiOptions | null
): AudioToMidiAnalysis => {
  const settings = normalizeAudioToMidiOptions(options);
  if (!buffer || typeof buffer.getChannelData !== 'function') {
    throw new AudioToMidiError(
      'source-unavailable',
      'The source audio for this clip is not available in memory or in the project audio store, so nothing was analysed.'
    );
  }
  const plan = describeClipTimeline(clip, timing, buffer.duration);
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    channels.push(buffer.getChannelData(ch));
  }
  return transcribePcmToMidi(channels, buffer.sampleRate, plan, settings);
};
