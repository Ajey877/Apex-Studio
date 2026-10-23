/**
 * Shared monophonic pitch detection (YIN) used by every offline analysis in
 * this project.
 *
 * WHY THIS MODULE EXISTS
 * Phase 8A shipped a validated YIN detector inside `vocalPitchCorrection.ts`
 * and Phase 8C needs the same measurement for Audio-to-MIDI. Copying a second
 * detector would mean two implementations could drift apart (different
 * thresholds, different gating, one fixed and one not). The detector, the
 * framing, the RMS gate and the median stability filter therefore live here,
 * and BOTH consumers call `detectPitchFrames`:
 *
 *   - `vocalPitchCorrection.ts` maps the frames onto a key/scale and renders
 *     pitch-correction grains;
 *   - `audioToMidi.ts` maps the same frames onto MIDI notes.
 *
 * WHAT IT MEASURES
 * YIN (de Cheveigné & Kawahara 2002), textbook form: difference function over
 * a 1536-sample window, cumulative-mean normalised difference, absolute
 * threshold 0.12 on the first local dip, local-minimum walk, parabolic
 * interpolation of the dip, plus a subharmonic guard (a dip at half the chosen
 * lag that maps above the supported range means the true fundamental is out of
 * range, so the frame is honestly unvoiced).
 *
 * WHAT IT REFUSES TO GUESS
 * - Frames quieter than max(1e-4, 2 % of the loudest frame) are never pitched
 *   (silence and room-floor noise are not notes).
 * - F0 outside [75, 1000] Hz (~E2–B5) is unvoiced, never clamped.
 * - Frames further than ±3 % from the ±2-frame median of voiced neighbours are
 *   unstable and reported unvoiced. Chords and noisy material therefore
 *   produce few confident frames instead of a fabricated melody.
 *
 * Deterministic: pure float math over the input, no randomness, no clock.
 */
/** Supported fundamental range (≈ E2–B5). `vocalPitchCorrection` re-exports these. */
export const PITCH_F0_MIN_HZ = 75;
export const PITCH_F0_MAX_HZ = 1000;

/** Analysis hop in samples (~2.9 ms at 44.1 kHz). */
export const PITCH_ANALYSIS_HOP = 128;
/** YIN window in samples (~34.8 ms at 44.1 kHz). */
export const PITCH_ANALYSIS_WINDOW = 1536;
/** YIN absolute threshold on the cumulative-mean normalised difference. */
export const PITCH_YIN_THRESHOLD = 0.12;
/** Per-frame RMS gate: absolute floor and fraction of the loudest frame. */
export const PITCH_RMS_FLOOR = 1e-4;
export const PITCH_RMS_RELATIVE_FLOOR = 0.02;
/** Median stability filter: ±3 % over ±2 neighbouring voiced frames. */
export const PITCH_STABILITY_TOLERANCE = 0.03;
/** Sources shorter than this cannot be analysed honestly. */
export const PITCH_MIN_SOURCE_FRAMES = 2048;

/** Typed failure for unusable sources (callers translate it to their own message). */
export class PitchDetectionError extends Error {
  public readonly failure: 'unsupported-source';
  constructor(message: string) {
    super(message);
    this.name = 'PitchDetectionError';
    this.failure = 'unsupported-source';
  }
}

/** One analysis frame of real PCM. */
export interface DetectedPitchFrame {
  index: number;
  /** Window start in seconds. */
  timeSeconds: number;
  /** Measured fundamental in Hz (null unless confidently voiced). */
  f0Hz: number | null;
  /** 0–1 periodicity confidence (1 − CMNDF at the dip); 0 when unvoiced. */
  confidence: number;
  /** Periodic, loud enough, stable and inside the supported F0 range. */
  voiced: boolean;
  /** Window RMS (0–1 scale of the source samples). */
  rms: number;
}

export interface PitchFrameDetection {
  sampleRate: number;
  frameCount: number;
  hopSamples: number;
  windowSamples: number;
  frames: DetectedPitchFrame[];
  voicedFrameCount: number;
  /** voicedFrameCount / frameCount (0 when there are no frames). */
  voicedRatio: number;
  /** Median measured F0 over voiced frames, or null when nothing is voiced. */
  medianF0Hz: number | null;
  f0RangeHz: { min: number; max: number } | null;
}

interface YinResult {
  f0: number;
  confidence: number;
}

/** Stereo-safe mono downmix: every later decision is made on this signal. */
export const monoDownmix = (channels: readonly Float32Array[]): Float64Array => {
  const length = channels[0].length;
  const mono = new Float64Array(length);
  const scale = 1 / channels.length;
  for (const data of channels) {
    for (let i = 0; i < length; i += 1) mono[i] += data[i] * scale;
  }
  return mono;
};

export const validatePitchSource = (
  channels: readonly Float32Array[],
  sampleRate: number
): void => {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new PitchDetectionError('Pitch analysis needs at least one audio channel.');
  }
  if (typeof sampleRate !== 'number' || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new PitchDetectionError(`Sample rate ${String(sampleRate)} is not usable.`);
  }
  const length = channels[0].length;
  for (const data of channels) {
    if (!(data instanceof Float32Array)) {
      throw new PitchDetectionError('Pitch analysis needs Float32Array channel data.');
    }
    if (data.length !== length) {
      throw new PitchDetectionError('All channels must have the same length.');
    }
  }
  if (length < PITCH_MIN_SOURCE_FRAMES) {
    throw new PitchDetectionError(
      `The source is ${length} frames — shorter than the ${PITCH_MIN_SOURCE_FRAMES}-frame minimum an honest pitch analysis needs. Nothing was processed.`
    );
  }
};

/**
 * One YIN measurement over `x[start .. start + window)`.
 * Returns null when no dip below the threshold exists inside the τ range that
 * maps into [PITCH_F0_MIN_HZ, PITCH_F0_MAX_HZ].
 */
export const yinMeasure = (
  x: Float64Array,
  start: number,
  sampleRate: number,
  tauMin: number,
  tauMax: number,
  diff: Float64Array,
  cmnd: Float64Array,
  windowSamples: number = PITCH_ANALYSIS_WINDOW
): YinResult | null => {
  const W = windowSamples;
  const terms = W - tauMax; // integration terms per lag

  // Difference function for every lag 1..tauMax (the cumulative mean needs the
  // small lags even though only [tauMin, tauMax] can be selected).
  for (let tau = 1; tau <= tauMax; tau += 1) {
    let sum = 0;
    for (let j = 0; j < terms; j += 1) {
      const delta = x[start + j] - x[start + j + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }

  // Cumulative-mean normalised difference.
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau += 1) {
    running += diff[tau];
    cmnd[tau] = running > 0 ? (diff[tau] * tau) / running : 1;
  }

  // First dip below the absolute threshold, walked to its local minimum.
  let best = -1;
  for (let tau = tauMin; tau <= tauMax; tau += 1) {
    if (cmnd[tau] < PITCH_YIN_THRESHOLD) {
      let walked = tau;
      while (walked + 1 <= tauMax && cmnd[walked + 1] < cmnd[walked]) walked += 1;
      best = walked;
      break;
    }
  }
  if (best < 0) return null;

  // Subharmonic artefact guard: any integer multiple of a true period also
  // zeroes the difference function, so a tone ABOVE the supported range can dip
  // at τ = 2·T0 and masquerade as an in-range note an octave lower. If the
  // half-lag is an equally good or better dip and maps above PITCH_F0_MAX_HZ,
  // the frame is honestly unvoiced — never re-pitched to a fabricated
  // subharmonic. (In-range detections are never overridden: for a real periodic
  // tone the half-period difference is large, so this guard cannot misfire on
  // the supported range.)
  const halfLag = Math.round(best / 2);
  if (halfLag >= 2 && cmnd[halfLag] <= cmnd[best] && sampleRate / halfLag > PITCH_F0_MAX_HZ) {
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
  if (!Number.isFinite(f0) || f0 < PITCH_F0_MIN_HZ || f0 > PITCH_F0_MAX_HZ) return null;
  const confidence = Math.max(0, Math.min(1, 1 - cmnd[best]));
  return { f0, confidence };
};

/**
 * Full pitch analysis of real PCM. Never throws on unvoiced material —
 * silence, noise and out-of-range tones analyse to honest zero-voiced results.
 * Throws `PitchDetectionError` only for unusable sources.
 */
export const detectPitchFrames = (
  channels: readonly Float32Array[],
  sampleRate: number
): PitchFrameDetection => {
  validatePitchSource(channels, sampleRate);

  const mono = monoDownmix(channels);
  const N = mono.length;
  const W = PITCH_ANALYSIS_WINDOW;
  const HOP = PITCH_ANALYSIS_HOP;
  const frameCount = Math.max(0, Math.floor((N - W) / HOP) + 1);

  const tauMin = Math.max(2, Math.floor(sampleRate / PITCH_F0_MAX_HZ));
  const tauMax = Math.min(Math.ceil(sampleRate / PITCH_F0_MIN_HZ), W - 64);

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
  const rmsGate = Math.max(PITCH_RMS_FLOOR, PITCH_RMS_RELATIVE_FLOOR * maxFrameRms);
  for (let i = 0; i < frameCount; i += 1) {
    if (frameRms[i] < rmsGate) continue; // silence / floor: never pitched
    const measured = yinMeasure(mono, i * HOP, sampleRate, tauMin, tauMax, diff, cmnd, W);
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
    if (Math.abs(rawF0[i] - med) <= PITCH_STABILITY_TOLERANCE * med) voiced[i] = 1;
  }

  const frames: DetectedPitchFrame[] = new Array(frameCount);
  const voicedF0: number[] = [];
  for (let i = 0; i < frameCount; i += 1) {
    const isVoiced = voiced[i] === 1;
    if (isVoiced) voicedF0.push(rawF0[i]);
    frames[i] = {
      index: i,
      timeSeconds: (i * HOP) / sampleRate,
      f0Hz: isVoiced ? rawF0[i] : null,
      confidence: isVoiced ? rawConfidence[i] : 0,
      voiced: isVoiced,
      rms: frameRms[i],
    };
  }
  const sorted = [...voicedF0].sort((a, b) => a - b);
  const medianF0Hz = sorted.length === 0
    ? null
    : sorted.length % 2
      ? sorted[sorted.length >> 1]
      : 0.5 * (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]);

  return {
    sampleRate,
    frameCount,
    hopSamples: HOP,
    windowSamples: W,
    frames,
    voicedFrameCount: voicedF0.length,
    voicedRatio: frameCount > 0 ? voicedF0.length / frameCount : 0,
    medianF0Hz,
    f0RangeHz: sorted.length > 0 ? { min: sorted[0], max: sorted[sorted.length - 1] } : null,
  };
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Human-readable note name for an integer MIDI number (C4 = 60). */
export const midiToNoteName = (midi: number): string => {
  const rounded = Math.round(midi);
  const pitchClass = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${NOTE_NAMES[pitchClass]}${octave}`;
};

/** Frequency (Hz) → fractional MIDI number (A4 = 440 Hz = 69). */
export const frequencyToMidi = (frequencyHz: number): number =>
  69 + 12 * Math.log2(frequencyHz / 440);

/** Fractional MIDI number → frequency in Hz. */
export const midiToFrequency = (midi: number): number =>
  440 * Math.pow(2, (midi - 69) / 12);
