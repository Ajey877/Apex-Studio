/**
 * Phase 8A — Offline vocal pitch correction DSP.
 *
 * WHAT THIS MODULE IS
 * A small, deterministic, dependency-free pitch-correction pipeline for
 * MONOPHONIC vocal-style material:
 *
 *   analyse  →  YIN fundamental-frequency detection per frame on the mono
 *               downmix, RMS gating, ±3 % median stability filtering, then
 *               mapping of every confidently voiced frame to the nearest
 *               allowed note of the project's root key + scale;
 *   correct  →  a phase-aligned grain renderer (pitch-synchronous-style
 *               overlap-add) that resamples each voiced grain by the
 *               measured→corrected pitch ratio while the output timeline is
 *               the input timeline: duration is preserved EXACTLY (same
 *               sample count), unvoiced/in-tune material passes through
 *               BIT-IDENTICAL, and stereo channels share every timing and
 *               pitch decision (inter-channel delay is invariant).
 *
 * WHAT THIS MODULE IS NOT
 * - Not a live/real-time processor: it runs offline over whole buffers
 *   (render-and-commit), with no microphone, no AudioWorklet and no claim
 *   about the live signal path.
 * - Not polyphonic: chords and polyphonic material are classified with low
 *   periodicity confidence and left untouched — never "corrected" toward a
 *   fabricated single note.
 * - No formant preservation, no vibrato processing, no humanize: those
 *   persisted settings are explicitly NOT applied by this milestone.
 * - Not studio-grade marketing: the evidence is deterministic PCM fixtures
 *   (known sines, glides, mixed voiced/unvoiced material) measuring F0 error,
 *   target-note accuracy, duration, stereo invariance, determinism and click
 *   bounds — see vocalPitchCorrection.test.ts.
 *
 * ALGORITHM NOTES
 * F0 detection — YIN (de Cheveigné & Kawahara 2002), textbook form:
 *   difference function d(τ) over a 1536-sample window, cumulative-mean
 *   normalized difference, absolute threshold 0.12 on the first local dip,
 *   parabolic interpolation of the dip. Frame RMS must clear
 *   max(1e-4, 2 % of the loudest frame) so silence and room-floor noise are
 *   never "pitched", and a two-pass ±3 % median filter over ±2 neighbouring
 *   voiced frames removes isolated instability. The measured F0 must land in
 *   [75, 1000] Hz (≈ E2–B5: bass through soprano fundamentals) — outside
 *   that documented range frames are honestly unvoiced, never clamped.
 *
 * Scale mapping — allowed pitch classes are (rootKey + interval) mod 12 from
 *   the single authoritative table in src/music/scalePresets.ts (every
 *   MusicalScale union member, plus the legacy stored value 'chromatic' =
 *   all twelve semitones). The target for a measured MIDI pitch is the
 *   nearest allowed note; EXACT ties resolve DOWN (documented, tested).
 *   Frames whose target is farther than ±200 cents (the documented
 *   correction envelope — the widest gap any supported scale can demand is
 *   ±150 cents, so the cap only rejects detection outliers) or within the
 *   5-cent in-tune dead zone are not actively corrected: what needs nothing
 *   is touched by nothing.
 *
 * Correction renderer — phase-aligned overlap-add grains:
 *   every analysis frame that needs correction emits one Hann grain of
 *   1536 samples centred at its OUTPUT position o[i] = i·hop + window/2
 *   (output timeline = input timeline ⇒ exact duration), reading the source
 *   around a phase-aligned analysis centre a[i] with slope
 *   r[i] = 2^((correctedMidi − measuredMidi)/12) and linear interpolation.
 *   a[i] advances by r[i]·hop per frame modulo one measured period T0
 *   (|a[i] − o[i]| ≤ T0/2), which keeps grains phase-coherent for sustained
 *   pitches instead of restarting phase every hop. Grains overlap 12:1 and
 *   are divided by their exact accumulated window sum (normalized OLA), then
 *   crossfaded with the untouched original over ~8.7 ms wherever the
 *   correction weight changes, with ~11.6 ms edge fades at buffer ends.
 *
 * Retune speed — correctedMidi follows the per-frame target through a
 *   one-pole glide with time constant retuneSpeedMs (0–80 ms, the persisted
 *   setting's documented range): 0 ms snaps to the target note per frame
 *   (the hard "robotic" behaviour), larger values glide. The smoothing state
 *   resets at every correction-run boundary so segments never smear into
 *   each other.
 *
 * Determinism — pure integer/float math over the input; no randomness, no
 *   Date, no async. Identical input + settings ⇒ bit-identical output, and
 *   the input is never mutated.
 */
import type { MusicalScale } from '../types/daw';
import { isMusicalScale, scaleIntervals } from '../music/scalePresets';

// ---------------------------------------------------------------------------
// Documented constants (pinned by tests)
// ---------------------------------------------------------------------------

/** Supported fundamental-frequency range (≈ E2–B5). */
export const VOCAL_F0_MIN_HZ = 75;
export const VOCAL_F0_MAX_HZ = 1000;
/** Documented pitch-correction envelope: ±2 semitones. */
export const VOCAL_MAX_CORRECTION_CENTS = 200;
/** Frames within this distance of their target need (and get) no correction. */
export const VOCAL_IN_TUNE_DEADZONE_CENTS = 5;
/** Sources shorter than this cannot be analysed honestly (typed refusal). */
export const VOCAL_MIN_SOURCE_FRAMES = 2048;
/** Analysis / synthesis hop in samples (~2.9 ms at 44.1 kHz). */
export const VOCAL_ANALYSIS_HOP = 128;
/** YIN window and grain length in samples (~34.8 ms at 44.1 kHz). */
export const VOCAL_ANALYSIS_WINDOW = 1536;
/** YIN absolute threshold on the cumulative-mean normalized difference. */
export const VOCAL_YIN_THRESHOLD = 0.12;
/** Crossfade length (samples) between corrected and untouched regions. */
export const VOCAL_CROSSFADE_SAMPLES = 384;
/** Edge fade (samples): buffer ends stay original. */
export const VOCAL_EDGE_FADE_SAMPLES = 512;
/** The persisted retune-speed setting's supported range. */
export const VOCAL_MIN_RETUNE_MS = 0;
export const VOCAL_MAX_RETUNE_MS = 80;
/** Per-frame RMS gate: absolute floor and fraction of the loudest frame. */
export const VOCAL_RMS_FLOOR = 1e-4;
export const VOCAL_RMS_RELATIVE_FLOOR = 0.02;
/** Median stability filter: ±3 % over ±2 neighbouring voiced frames. */
export const VOCAL_STABILITY_TOLERANCE = 0.03;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VocalCorrectionFailure =
  | 'invalid-settings'
  | 'unsupported-source'
  | 'correction-failed';

/** Typed DSP failure so callers can surface honest, specific messages. */
export class VocalPitchCorrectionError extends Error {
  public readonly failure: VocalCorrectionFailure;
  constructor(failure: VocalCorrectionFailure, message: string) {
    super(message);
    this.name = 'VocalPitchCorrectionError';
    this.failure = failure;
  }
}

/**
 * The settings the correction actually consumes. `rootKey`/`scale` come from
 * the persisted VocalTunerSettings; 'chromatic' is accepted because legacy
 * projects could store it (the historical modal offered it) and it has a
 * well-defined meaning: every semitone is allowed, so correction quantizes
 * to the nearest semitone. formantShift / vibratoDepth / humanize are NOT
 * part of this milestone and are deliberately not read.
 */
export interface VocalCorrectionSettings {
  rootKey: number;
  scale: MusicalScale | 'chromatic';
  retuneSpeedMs: number;
}

export interface VocalPitchFrame {
  index: number;
  /** Frame time in seconds (window start). */
  timeSeconds: number;
  /** Measured fundamental in Hz, or null when not confidently voiced. */
  f0Hz: number | null;
  /** 0–1 periodicity confidence (1 − CMNDF at the chosen dip); 0 when unvoiced. */
  confidence: number;
  /** Confidently voiced: periodic, loud enough, stable and in the F0 range. */
  voiced: boolean;
  measuredMidi: number | null;
  /** Nearest allowed scale note (null when unvoiced). */
  targetMidi: number | null;
  /**
   * The pitch the renderer drives this frame to, after retune-speed
   * smoothing (null unless the frame is actively corrected).
   */
  correctedMidi: number | null;
  /** Signed cents from the measured pitch to its target (null when unvoiced). */
  centsToTarget: number | null;
  /** True when this frame receives pitch-shifting grains. */
  correctionActive: boolean;
}

export interface VocalPitchAnalysis {
  sampleRate: number;
  frameCount: number;
  hopSamples: number;
  frames: VocalPitchFrame[];
  voicedFrameCount: number;
  /** voicedFrameCount / frameCount (0 when there are no frames). */
  voicedRatio: number;
  /** Frames that will actually be pitch-shifted (voiced, out of dead zone, within cap). */
  correctedFrameCount: number;
  correctedSeconds: number;
  /** Mean |correctedMidi − measuredMidi| in cents over actively corrected frames (0 when none). */
  meanCentsApplied: number;
  maxCentsApplied: number;
  /** Median measured F0 over voiced frames, or null when nothing is voiced. */
  medianF0Hz: number | null;
  f0RangeHz: { min: number; max: number } | null;
  /** True when material is confidently voiced but needs no correction anywhere. */
  inTune: boolean;
}

/** Plan-display summary derived from a real analysis (note names, no fabrication). */
export interface VocalCorrectionSummary {
  voicedRatio: number;
  voicedSeconds: number;
  correctedSeconds: number;
  meanCentsApplied: number;
  maxCentsApplied: number;
  medianF0Hz: number | null;
  measuredNoteName: string | null;
  targetNoteName: string | null;
  f0RangeHz: { min: number; max: number } | null;
  inTune: boolean;
}

// ---------------------------------------------------------------------------
// Settings validation and scale mapping (pure)
// ---------------------------------------------------------------------------

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Validates correction settings and returns a normalized copy. Refusals are
 * typed and actionable; nothing is silently clamped or defaulted.
 */
export const validateVocalCorrectionSettings = (candidate: unknown): VocalCorrectionSettings => {
  if (!candidate || typeof candidate !== 'object') {
    throw new VocalPitchCorrectionError('invalid-settings', 'Pitch correction needs the tuner settings object (root key, scale, retune speed).');
  }
  const record = candidate as Record<string, unknown>;
  const rootKey = record.rootKey;
  if (typeof rootKey !== 'number' || !Number.isInteger(rootKey) || rootKey < 0 || rootKey > 11) {
    throw new VocalPitchCorrectionError(
      'invalid-settings',
      `Root key must be a whole number of semitones from 0 (C) to 11 (B) — got ${String(rootKey)}.`
    );
  }
  const scale = record.scale;
  if (typeof scale !== 'string' || (scale !== 'chromatic' && !isMusicalScale(scale))) {
    throw new VocalPitchCorrectionError(
      'invalid-settings',
      `Scale "${String(scale)}" is not a supported correction target. Choose one of the project's musical scales.`
    );
  }
  const retuneSpeedMs = record.retuneSpeedMs;
  if (typeof retuneSpeedMs !== 'number' || !Number.isFinite(retuneSpeedMs)
    || retuneSpeedMs < VOCAL_MIN_RETUNE_MS || retuneSpeedMs > VOCAL_MAX_RETUNE_MS) {
    throw new VocalPitchCorrectionError(
      'invalid-settings',
      `Retune speed must be between ${VOCAL_MIN_RETUNE_MS} ms (hard snap) and ${VOCAL_MAX_RETUNE_MS} ms — got ${String(retuneSpeedMs)}.`
    );
  }
  return { rootKey, scale: scale as MusicalScale | 'chromatic', retuneSpeedMs };
};

/** Allowed pitch classes (0–11, sorted) for a root key and scale. */
export const vocalScalePitchClasses = (rootKey: number, scale: MusicalScale | 'chromatic'): number[] => {
  if (scale === 'chromatic') return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const intervals = scaleIntervals(scale);
  const classes = new Set<number>();
  for (const interval of intervals) classes.add(((rootKey + interval) % 12 + 12) % 12);
  return [...classes].sort((a, b) => a - b);
};

/**
 * Nearest allowed scale note to a (possibly fractional) MIDI pitch.
 * Returns the target MIDI number and the signed cents from `midi` to it.
 * EXACT ties resolve DOWN — documented and pinned by tests.
 */
export const nearestScaleMidi = (
  midi: number,
  rootKey: number,
  scale: MusicalScale | 'chromatic'
): { midi: number; cents: number } => {
  if (typeof midi !== 'number' || !Number.isFinite(midi)) {
    throw new VocalPitchCorrectionError('invalid-settings', `Cannot map a non-finite pitch (${String(midi)}) to a scale note.`);
  }
  const pitchClasses = vocalScalePitchClasses(rootKey, scale);
  let bestMidi = Math.round(midi);
  let bestDistance = Infinity;
  const base = 12 * Math.floor(midi / 12);
  for (const pc of pitchClasses) {
    for (const candidate of [base + pc - 12, base + pc, base + pc + 12]) {
      const distance = Math.abs(candidate - midi);
      if (distance < bestDistance - 1e-9) {
        bestDistance = distance;
        bestMidi = candidate;
      } else if (Math.abs(distance - bestDistance) <= 1e-9 && candidate < bestMidi) {
        bestMidi = candidate; // documented tie-break: the lower scale note
      }
    }
  }
  return { midi: bestMidi, cents: (bestMidi - midi) * 100 };
};

/** Human-readable note name for an integer MIDI number (C4 = 60). */
export const midiToNoteName = (midi: number): string => {
  const rounded = Math.round(midi);
  const pc = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${NOTE_NAMES[pc]}${octave}`;
};

const freqToMidi = (f: number): number => 69 + 12 * Math.log2(f / 440);

// ---------------------------------------------------------------------------
// Source validation
// ---------------------------------------------------------------------------

const validateSource = (channels: readonly Float32Array[], sampleRate: number): void => {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new VocalPitchCorrectionError('unsupported-source', 'Pitch correction needs at least one audio channel.');
  }
  if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new VocalPitchCorrectionError('unsupported-source', `Sample rate ${String(sampleRate)} is not usable.`);
  }
  const length = channels[0].length;
  for (const data of channels) {
    if (!(data instanceof Float32Array)) {
      throw new VocalPitchCorrectionError('unsupported-source', 'Pitch correction needs Float32Array channel data.');
    }
    if (data.length !== length) {
      throw new VocalPitchCorrectionError('unsupported-source', 'All channels must have the same length.');
    }
  }
  if (length < VOCAL_MIN_SOURCE_FRAMES) {
    throw new VocalPitchCorrectionError(
      'unsupported-source',
      `The source is ${length} frames — shorter than the ${VOCAL_MIN_SOURCE_FRAMES}-frame minimum a honest pitch analysis needs. Nothing was processed.`
    );
  }
};

// ---------------------------------------------------------------------------
// YIN F0 detection
// ---------------------------------------------------------------------------

interface YinResult {
  f0: number;
  confidence: number;
}

/**
 * One YIN measurement over `x[start .. start+VOCAL_ANALYSIS_WINDOW)`.
 * Textbook cumulative-mean normalized difference with absolute threshold,
 * first-dip selection, local-minimum walk and parabolic interpolation.
 * Returns null when no dip below the threshold exists inside the τ range
 * that maps into [VOCAL_F0_MIN_HZ, VOCAL_F0_MAX_HZ].
 */
const yinMeasure = (
  x: Float64Array,
  start: number,
  sampleRate: number,
  tauMin: number,
  tauMax: number,
  diff: Float64Array,
  cmnd: Float64Array
): YinResult | null => {
  const W = VOCAL_ANALYSIS_WINDOW;
  const terms = W - tauMax; // integration terms per lag

  // Difference function for every lag 1..tauMax (the cumulative mean needs
  // the small lags even though only [tauMin, tauMax] can be selected).
  for (let tau = 1; tau <= tauMax; tau += 1) {
    let sum = 0;
    for (let j = 0; j < terms; j += 1) {
      const delta = x[start + j] - x[start + j + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // Cumulative-mean normalized difference.
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau += 1) {
    running += diff[tau];
    cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
  }

  // First dip below the absolute threshold, walked to its local minimum.
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    if (cmnd[tau] < VOCAL_YIN_THRESHOLD) {
      let walked = tau;
      while (walked + 1 <= tauMax && cmnd[walked + 1] < cmnd[walked]) walked += 1;
      best = walked;
      break;
    }
  }
  if (best < 0) return null;

  // Subharmonic artefact guard: any integer multiple of a true period also
  // zeroes the difference function, so a tone ABOVE the supported range can
  // dip at τ = 2·T0 and masquerade as an in-range note an octave lower. If
  // the half-lag is an equally good or better dip and maps above
  // VOCAL_F0_MAX_HZ, the frame is honestly unvoiced — never re-pitched to a
  // fabricated subharmonic. (In-range detections are never overridden: for a
  // real periodic tone the half-period difference is large, so this guard
  // cannot misfire on the supported range.)
  const halfLag = Math.round(best / 2);
  if (halfLag >= 2 && cmnd[halfLag] <= cmnd[best] && sampleRate / halfLag > VOCAL_F0_MAX_HZ) {
    return null;
  }

  // Parabolic interpolation around the dip.
  let tauStar = best;
  if (best > 1 && best < tauMax) {
    const s0 = cmnd[best - 1];
    const s1 = cmnd[best];
    const s2 = cmnd[best + 1];
    const denom = s0 - 2 * s1 + s2;
    if (Math.abs(denom) > 1e-15) {
      const adjustment = (0.5 * (s0 - s2)) / denom;
      if (Math.abs(adjustment) <= 1) tauStar = best + adjustment;
    }
  }
  const f0 = sampleRate / tauStar;
  if (!Number.isFinite(f0) || f0 < VOCAL_F0_MIN_HZ || f0 > VOCAL_F0_MAX_HZ) return null;
  const confidence = Math.max(0, Math.min(1, 1 - cmnd[best]));
  return { f0, confidence };
};

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** Mono downmix used for every shared decision (stereo-safe by construction). */
const monoDownmix = (channels: readonly Float32Array[]): Float64Array => {
  const length = channels[0].length;
  const mono = new Float64Array(length);
  const scale = 1 / channels.length;
  for (const data of channels) {
    for (let i = 0; i < length; i += 1) mono[i] += data[i] * scale;
  }
  return mono;
};

/**
 * Full pitch analysis of real PCM. Never throws on unvoiced material —
 * silence, noise and out-of-range tones analyse to honest zero-voiced
 * results. Typed refusals only for invalid settings/sources.
 */
export const analyseVocalPitch = (
  channels: readonly Float32Array[],
  sampleRate: number,
  settingsCandidate: unknown
): VocalPitchAnalysis => {
  const settings = validateVocalCorrectionSettings(settingsCandidate);
  validateSource(channels, sampleRate);

  const mono = monoDownmix(channels);
  const N = mono.length;
  const W = VOCAL_ANALYSIS_WINDOW;
  const HOP = VOCAL_ANALYSIS_HOP;
  const frameCount = Math.max(0, Math.floor((N - W) / HOP) + 1);

  const tauMin = Math.max(2, Math.floor(sampleRate / VOCAL_F0_MAX_HZ));
  const tauMax = Math.min(Math.ceil(sampleRate / VOCAL_F0_MIN_HZ), W - 64);

  const diff = new Float64Array(tauMax + 2);
  const cmnd = new Float64Array(tauMax + 2);

  // Pass 1: raw YIN measurement + per-frame RMS.
  const rawF0 = new Float64Array(frameCount); // 0 = none
  const rawConfidence = new Float64Array(frameCount);
  const rawVoiced = new Uint8Array(frameCount);
  const frameRms = new Float64Array(frameCount);
  let maxFrameRms = 0;
  for (let i = 0; i < frameCount; i += 1) {
    const start = i * HOP;
    let sumSquares = 0;
    for (let j = 0; j < W; j += 1) {
      const s = mono[start + j];
      sumSquares += s * s;
    }
    const rmsValue = Math.sqrt(sumSquares / W);
    frameRms[i] = rmsValue;
    if (rmsValue > maxFrameRms) maxFrameRms = rmsValue;
  }
  const rmsGate = Math.max(VOCAL_RMS_FLOOR, VOCAL_RMS_RELATIVE_FLOOR * maxFrameRms);
  for (let i = 0; i < frameCount; i += 1) {
    if (frameRms[i] < rmsGate) continue; // silence / floor: never pitched
    const measured = yinMeasure(mono, i * HOP, sampleRate, tauMin, tauMax, diff, cmnd);
    if (measured) {
      rawF0[i] = measured.f0;
      rawConfidence[i] = measured.confidence;
      rawVoiced[i] = 1;
    }
  }

  // Pass 2: ±3 % median stability over ±2 neighbouring raw-voiced frames.
  const STABILITY_NEIGHBOURS = 2;
  const voiced = new Uint8Array(frameCount);
  const windowBuffer: number[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    if (!rawVoiced[i]) continue;
    windowBuffer.length = 0;
    for (let k = i - STABILITY_NEIGHBOURS; k <= i + STABILITY_NEIGHBOURS; k += 1) {
      if (k >= 0 && k < frameCount && rawVoiced[k]) windowBuffer.push(rawF0[k]);
    }
    windowBuffer.sort((a, b) => a - b);
    const mid = windowBuffer.length >> 1;
    const med = windowBuffer.length % 2
      ? windowBuffer[mid]
      : 0.5 * (windowBuffer[mid - 1] + windowBuffer[mid]);
    if (Math.abs(rawF0[i] - med) <= VOCAL_STABILITY_TOLERANCE * med) voiced[i] = 1;
  }

  // Pass 3: scale mapping + retune-speed smoothing of the corrected contour.
  const frames: VocalPitchFrame[] = new Array(frameCount);
  const hopSeconds = HOP / sampleRate;
  const glideCoefficient = settings.retuneSpeedMs <= 0
    ? 1
    : 1 - Math.exp((-hopSeconds * 1000) / settings.retuneSpeedMs);

  let voicedFrameCount = 0;
  let correctedFrameCount = 0;
  let centsSum = 0;
  let maxCents = 0;
  const voicedF0: number[] = [];
  let glideState: number | null = null; // corrected-MIDI one-pole state
  let previousActive = false;

  for (let i = 0; i < frameCount; i += 1) {
    const isVoiced = voiced[i] === 1;
    if (isVoiced) {
      voicedFrameCount += 1;
      voicedF0.push(rawF0[i]);
    }
    const f0Hz = isVoiced ? rawF0[i] : null;
    const measuredMidi = f0Hz === null ? null : freqToMidi(f0Hz);
    const target = measuredMidi === null ? null : nearestScaleMidi(measuredMidi, settings.rootKey, settings.scale);
    const centsToTarget = target === null ? null : target.cents;

    let correctionActive = false;
    let correctedMidi: number | null = null;
    if (isVoiced && measuredMidi !== null && target !== null && centsToTarget !== null) {
      const need = Math.abs(centsToTarget);
      if (need > VOCAL_IN_TUNE_DEADZONE_CENTS && need <= VOCAL_MAX_CORRECTION_CENTS) {
        correctionActive = true;
        if (!previousActive || glideState === null) {
          // Run start: the glide begins at the measured pitch.
          glideState = measuredMidi;
        }
        glideState += (target.midi - glideState) * glideCoefficient;
        correctedMidi = glideCoefficient >= 1 ? target.midi : glideState;
        const appliedCents = Math.abs(correctedMidi - measuredMidi) * 100;
        centsSum += appliedCents;
        if (appliedCents > maxCents) maxCents = appliedCents;
        correctedFrameCount += 1;
      }
    }
    previousActive = correctionActive;

    frames[i] = {
      index: i,
      timeSeconds: (i * HOP) / sampleRate,
      f0Hz,
      confidence: isVoiced ? rawConfidence[i] : 0,
      voiced: isVoiced,
      measuredMidi,
      targetMidi: target === null ? null : target.midi,
      correctedMidi,
      centsToTarget,
      correctionActive,
    };
  }

  voicedF0.sort((a, b) => a - b);
  const medianF0Hz = voicedF0.length === 0
    ? null
    : voicedF0.length % 2
      ? voicedF0[voicedF0.length >> 1]
      : 0.5 * (voicedF0[(voicedF0.length >> 1) - 1] + voicedF0[voicedF0.length >> 1]);

  return {
    sampleRate,
    frameCount,
    hopSamples: HOP,
    frames,
    voicedFrameCount,
    voicedRatio: frameCount > 0 ? voicedFrameCount / frameCount : 0,
    correctedFrameCount,
    correctedSeconds: (correctedFrameCount * HOP) / sampleRate,
    meanCentsApplied: correctedFrameCount > 0 ? centsSum / correctedFrameCount : 0,
    maxCentsApplied: maxCents,
    medianF0Hz,
    f0RangeHz: voicedF0.length > 0 ? { min: voicedF0[0], max: voicedF0[voicedF0.length - 1] } : null,
    inTune: voicedFrameCount > 0 && correctedFrameCount === 0,
  };
};

/**
 * Plan-display summary derived from a real analysis and the settings the
 * correction will use (note names come from the same mapping the renderer
 * applies — never a parallel estimate).
 */
export const summariseVocalCorrection = (
  analysis: VocalPitchAnalysis,
  settingsCandidate: unknown
): VocalCorrectionSummary => {
  const settings = validateVocalCorrectionSettings(settingsCandidate);
  const median = analysis.medianF0Hz;
  const medianMidi = median === null ? null : freqToMidi(median);
  const target = medianMidi === null ? null : nearestScaleMidi(medianMidi, settings.rootKey, settings.scale);
  return {
    voicedRatio: analysis.voicedRatio,
    voicedSeconds: (analysis.voicedFrameCount * analysis.hopSamples) / analysis.sampleRate,
    correctedSeconds: analysis.correctedSeconds,
    meanCentsApplied: analysis.meanCentsApplied,
    maxCentsApplied: analysis.maxCentsApplied,
    medianF0Hz: median,
    measuredNoteName: medianMidi === null ? null : midiToNoteName(medianMidi),
    targetNoteName: target === null ? null : midiToNoteName(target.midi),
    f0RangeHz: analysis.f0RangeHz,
    inTune: analysis.inTune,
  };
};

// ---------------------------------------------------------------------------
// Correction renderer
// ---------------------------------------------------------------------------

/** Precomputed Hann window for the grain length. */
let hannTable: Float64Array | null = null;
const getHann = (): Float64Array => {
  if (hannTable === null) {
    const L = VOCAL_ANALYSIS_WINDOW;
    const table = new Float64Array(L);
    for (let t = 0; t < L; t += 1) {
      table[t] = 0.5 * (1 - Math.cos((2 * Math.PI * t) / L));
    }
    hannTable = table;
  }
  return hannTable;
};

/**
 * Corrects pitch on real PCM channel data. Returns NEW Float32Arrays of the
 * EXACT input length; the input is never mutated. When nothing needs
 * correction (in-tune, unvoiced, silent) the output is a bit-identical copy —
 * the renderer never touches material it cannot improve.
 */
export const vocalCorrectChannels = (
  channels: readonly Float32Array[],
  sampleRate: number,
  settingsCandidate: unknown
): Float32Array[] => {
  const settings = validateVocalCorrectionSettings(settingsCandidate);
  validateSource(channels, sampleRate);

  try {
    const analysis = analyseVocalPitch(channels, sampleRate, settings);
    const N = channels[0].length;
    if (analysis.correctedFrameCount === 0) {
      return channels.map((data) => Float32Array.from(data));
    }

    const HOP = VOCAL_ANALYSIS_HOP;
    const W = VOCAL_ANALYSIS_WINDOW;
    const L = W; // grain length == analysis window
    const half = L / 2;
    const hann = getHann();
    const mono = monoDownmix(channels);

    // ---- correction weight contour (shared across channels) ----
    const rawWeight = new Float64Array(N);
    for (const frame of analysis.frames) {
      if (!frame.correctionActive) continue;
      const centre = frame.index * HOP + half;
      const from = Math.max(0, centre - (HOP >> 1));
      const to = Math.min(N, centre + (HOP >> 1));
      for (let p = from; p < to; p += 1) rawWeight[p] = 1;
    }
    // Box-smooth into linear crossfades of VOCAL_CROSSFADE_SAMPLES.
    const CF = VOCAL_CROSSFADE_SAMPLES;
    const integral = new Float64Array(N + 1);
    for (let p = 0; p < N; p += 1) integral[p + 1] = integral[p] + rawWeight[p];
    const weight = new Float64Array(N);
    for (let p = 0; p < N; p += 1) {
      const a = Math.max(0, p - (CF >> 1));
      const b = Math.min(N, p + (CF >> 1) + 1);
      weight[p] = (integral[b] - integral[a]) / (b - a);
    }
    // Edge fades: buffer ends stay original.
    const EDGE = VOCAL_EDGE_FADE_SAMPLES;
    for (let p = 0; p < Math.min(EDGE, N); p += 1) weight[p] *= p / EDGE;
    for (let p = 0; p < Math.min(EDGE, N); p += 1) weight[N - 1 - p] *= p / EDGE;

    // ---- grain accumulation (shared pointers/ratios; per-channel reads) ----
    const channelCount = channels.length;
    const accum: Float64Array[] = [];
    for (let ch = 0; ch < channelCount; ch += 1) accum.push(new Float64Array(N));
    const norm = new Float64Array(N);

    let runActive = false;
    let lastAnalysisCentre = 0;

    for (const frame of analysis.frames) {
      if (!frame.correctionActive || frame.f0Hz === null || frame.correctedMidi === null || frame.measuredMidi === null) {
        runActive = false;
        continue;
      }
      const outputCentre = frame.index * HOP + half;
      const ratio = Math.pow(2, (frame.correctedMidi - frame.measuredMidi) / 12);
      const period = sampleRate / frame.f0Hz;

      let analysisCentre: number;
      if (!runActive) {
        analysisCentre = outputCentre; // run start: phase-aligned to output
      } else {
        // Advance by ratio·hop, re-quantized modulo one measured period so the
        // grain stays phase-coherent AND |analysis − output| ≤ period/2
        // (duration preserved: the pointer never runs away from the timeline).
        const predicted = lastAnalysisCentre + ratio * HOP;
        const cycles = Math.round((predicted - outputCentre) / period);
        analysisCentre = predicted - cycles * period;
      }
      runActive = true;
      lastAnalysisCentre = analysisCentre;

      for (let t = -half; t < half; t += 1) {
        const p = outputCentre + t;
        if (p < 0 || p >= N) continue;
        const windowWeight = hann[t + half];
        if (windowWeight <= 0) continue;
        norm[p] += windowWeight;
        const sourcePos = analysisCentre + ratio * t;
        const clamped = sourcePos < 0 ? 0 : sourcePos > N - 1.000001 ? N - 1.000001 : sourcePos;
        const i0 = Math.floor(clamped);
        const frac = clamped - i0;
        const i1 = Math.min(i0 + 1, N - 1);
        for (let ch = 0; ch < channelCount; ch += 1) {
          const data = channels[ch];
          const sample = data[i0] + frac * (data[i1] - data[i0]);
          accum[ch][p] += windowWeight * sample;
        }
      }
    }

    // ---- mix corrected grains with the untouched original ----
    const output: Float32Array[] = [];
    for (let ch = 0; ch < channelCount; ch += 1) {
      const source = channels[ch];
      const out = new Float32Array(N);
      for (let p = 0; p < N; p += 1) {
        const w = weight[p];
        if (w <= 0) {
          out[p] = source[p]; // untouched: bit-identical passthrough
          continue;
        }
        const corrected = norm[p] > 1e-9 ? accum[ch][p] / norm[p] : 0;
        out[p] = w * corrected + (1 - w) * source[p];
      }
      output.push(out);
    }
    return output;
  } catch (error) {
    if (error instanceof VocalPitchCorrectionError) throw error;
    throw new VocalPitchCorrectionError(
      'correction-failed',
      `Pitch correction failed (${error instanceof Error ? error.message : String(error)}). Nothing was rendered.`
    );
  }
};

/**
 * AudioBuffer seam: corrects a real AudioBuffer into a NEW buffer of the same
 * channel count, length and sample rate, using the caller's buffer factory
 * (the same seam the WSOLA/TAW renderers use).
 */
export const vocalCorrectAudioBuffer = (
  buffer: AudioBuffer,
  settingsCandidate: unknown,
  createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => AudioBuffer
): AudioBuffer => {
  const settings = validateVocalCorrectionSettings(settingsCandidate);
  if (!buffer || typeof buffer.numberOfChannels !== 'number' || buffer.numberOfChannels < 1) {
    throw new VocalPitchCorrectionError('unsupported-source', 'Pitch correction needs a real AudioBuffer with at least one channel.');
  }
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) channels.push(buffer.getChannelData(ch));
  const corrected = vocalCorrectChannels(channels, buffer.sampleRate, settings);
  const output = createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let ch = 0; ch < corrected.length; ch += 1) output.copyToChannel(corrected[ch], ch);
  return output;
};
