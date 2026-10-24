/**
 * Phase 10B — Confidence-gated polyphonic transcription (multi-pitch).
 *
 * WHY THIS MODULE EXISTS
 * Phase 8C's Audio-to-MIDI is deliberately monophonic: it measures ONE f0 with
 * the shared YIN detector and refuses anything that is not a single harmonic
 * series. That refusal is a real product guarantee and it stays. What was
 * missing is the *other* thing users ask for — transcribing clear polyphonic
 * tonal material (chords, a melody over a held bass) into editable notes.
 *
 * So polyphonic transcription lives here, as a separate, explicit analysis mode
 * with its own measurements. It does not touch `pitchDetection.ts` (the YIN
 * detector the Vocal Tuner and monophonic mode share) and it cannot change a
 * monophonic result: the monophonic path never calls this module.
 *
 * APPROACH — short-time spectral analysis, harmonic salience with an
 * "explaining" model. Chosen after measuring the alternatives:
 *
 *   - A plain FFT peak picker is unusable: every overtone of a single note is a
 *     spectral peak, so a sawtooth C4 becomes C4+G4+C5+E5+... That is exactly the
 *     "turn harmonics into notes" failure the product must avoid.
 *   - NMF / deep models need a trained dictionary, a large fixed asset, and
 *     iteration counts that make CPU cost and determinism hard to bound. Out of
 *     scope for a local-first browser DAW with no new dependencies.
 *   - Harmonic salience with an *explaining* model is the smallest approach with
 *     the right failure mode. Each candidate pitch scores the measured magnitude
 *     at its harmonic series, restricted to the energy that notes already selected
 *     in that frame do not explain. Selecting a note records the energy its `1/h`
 *     harmonic model predicts, so the overtones of a note that was already found
 *     cannot be reported again as separate notes, while a genuine second note
 *     keeps whatever it adds on top of a bin it shares with a louder one (a melody
 *     two octaves above a held bass sits exactly on the bass's fourth harmonic).
 *     Blind bin-zeroing was tried first and erased exactly those shared notes.
 *   - Two further gates keep candidates honest: a candidate's measured fundamental
 *     must round to that candidate (so spectral leakage cannot be attributed to
 *     the neighbouring semitone), and it must clear an absolute share and a share
 *     relative to the frame's strongest note.
 *
 * Notes are then grouped per pitch across frames, split at re-attacks (same pitch,
 * new strike), filtered by the shared note-duration policy, quantized to the
 * caller's grid and converted to timeline time with the clip's resolved playback
 * rate — the same musical-time utilities the monophonic path uses. There is no
 * second time model.
 *
 * BOUNDED WORK — and why the budget is deterministic
 * Work is bounded by *counted* quantities, never by elapsed time: `POLY_MAX_FRAMES`
 * frames, one candidate per semitone over a fixed range, `POLY_HARMONICS`
 * harmonics and `POLY_MAX_VOICES` greedy passes per frame. A wall-clock bail-out
 * would make the result depend on machine speed, which would break determinism; a
 * counted budget keeps the same PCM always producing the same notes while still
 * capping CPU (a 30 s clip measures ~0.4 s in this environment).
 * `stats.analysisMilliseconds` is informational only and never feeds a decision.
 *
 * WHAT IT REFUSES (typed, with a message, zero mutation)
 * - `analysis-budget`     — the clip window is longer than one bounded pass;
 * - `silence-or-noise`    — no frame carries enough energy;
 * - `no-fundamentals`     — energy present, but no pitch inside C2–C6 (drums,
 *                           speech, material out of range, or a clip whose pitch
 *                           offset moved it out of range);
 * - `unreliable-harmonics`— the detected notes explain too little of the spectral
 *                           peaks (inharmonic bells, dense mixes) or the analysis
 *                           produced more events than a transcription should;
 * - `polyphony-exceeded`  — more than `POLY_MAX_VOICES` fundamentals over a
 *                           significant part of the clip;
 * - `short-coverage`      — too little of the clip is pitched to call it tonal;
 * - `no-notes`            — pitches survived but no note cleared the minimum
 *                           length.
 * Every refusal returns `notes: []`; the caller never mutates project state.
 *
 * HONEST LIMITS (measured — see `src/audio/phase10b.polyphonic.test.ts`)
 * - Fundamentals MIDI 36–84 (C2–C6). Templates are also built over a guard range
 *   outside it, only so an out-of-range note can explain its own harmonics instead
 *   of being reported as fake notes an octave up; guard notes are never emitted.
 * - Up to 4 simultaneous fundamentals. Denser material is refused rather than
 *   partially transcribed.
 * - Two fundamentals about a semitone apart in the same register merge during the
 *   analysis window; when they do, weak harmonic fragments can appear alongside
 *   them. This is measured and reported, not corrected.
 * - A note that shares its fundamental bin with a much louder note (for example a
 *   quiet octave above a loud bass) can be missed: over-explaining is chosen
 *   deliberately, because a missed note is recoverable by the user and a fake note
 *   is not.
 * - Velocity is a measured spectral-amplitude ratio against the loudest note in
 *   the clip (mapped into 0.2–1.0), not an absolute MIDI velocity, and confidence
 *   is the documented function of the note's spectral share below.
 * - No source separation, no instrument identification, no reverb removal.
 */
import {
  frequencyToMidi,
  midiToFrequency,
  midiToNoteName,
  monoDownmix,
} from './pitchDetection';
import { MIN_NOTE_DURATION_STEPS, quantizeDurationSteps } from '../music/noteDurationPolicy';

// --- Documented analysis envelope -------------------------------------------

/** STFT analysis window (~93 ms at 44.1 kHz). Long enough to resolve C2. */
export const POLY_FFT_SIZE = 4096;
/** STFT hop (~23 ms at 44.1 kHz). */
export const POLY_HOP = 1024;
/** Lowest transcribable fundamental: MIDI 36 = C2 (65.41 Hz). */
export const POLY_MIN_MIDI = 36;
/** Highest transcribable fundamental: MIDI 84 = C6 (1046.50 Hz). */
export const POLY_MAX_MIDI = 84;
/**
 * Templates are built over a wider *guard* range than the reportable one. A note
 * outside C2–C6 still owns its harmonic series: a C1 would otherwise be reported
 * as two fake notes an octave and a twelfth above it, because nothing in the
 * candidate set could explain its partials. Guard notes are never reported, but
 * they do explain their harmonics (and count as simultaneous voices).
 */
export const POLY_GUARD_MIN_MIDI = 21;
export const POLY_GUARD_MAX_MIDI = 96;
/** Maximum simultaneous fundamentals the analyzer reports. */
export const POLY_MAX_VOICES = 4;
/** Harmonics summed per candidate (stopping early at Nyquist). */
export const POLY_HARMONICS = 16;
/** Longest clip segment analysed in one pass. */
export const POLY_MAX_ANALYSIS_SECONDS = 30;
/** Hard frame budget: the deterministic bound on analysis work. */
export const POLY_MAX_FRAMES = 1600;
/**
 * The 1/h model is deliberately given this much head-room when it explains a
 * selected note. Real timbres roll off slower than 1/h, so a strict model leaves
 * a few percent of every overtone unexplained — and that residue is exactly what
 * turns into a fake note an octave or a twelfth above. Over-explaining is the
 * safer failure: a note that shares a bin with a louder note can then be missed
 * (documented), but a harmonic is never reported as a note of its own.
 */
export const POLY_HARMONIC_MODEL_SAFETY = 1.35;
/** A harmonic below this share of the fundamental is leakage, not a partial. */
export const POLY_HARMONIC_FIT_FLOOR = 0.03;
/** A candidate's measured fundamental must round to that candidate (±50 cents). */
export const POLY_FUNDAMENTAL_SEMITONE_TOLERANCE = 0.5;
/** How far a harmonic's implied f0 may sit from the candidate pitch (4 %). */
export const POLY_HARMONIC_PITCH_TOLERANCE = 0.04;
/** Absolute candidate floor: share of the frame's spectral magnitude. */
export const POLY_MIN_CANDIDATE_SHARE = 0.012;
/** Relative candidate floor: share of the strongest note in the same frame. */
export const POLY_RELATIVE_CANDIDATE_SHARE = 0.16;
/** Unexplained magnitude a candidate's own fundamental needs, as a share of the
 * frame's spectral magnitude. A bin that another note already accounts for is not
 * a new note. */
export const POLY_MIN_FUNDAMENTAL_SHARE = 0.01;
/** Per-frame RMS gate, absolute and relative to the loudest frame. */
export const POLY_RMS_FLOOR = 1e-4;
export const POLY_RMS_RELATIVE_FLOOR = 0.02;
/** Frames a note must persist to become an event (~70 ms at 44.1 kHz). */
export const POLY_MIN_NOTE_FRAMES = 5;
/** Silent frames tolerated inside a note (a frame drop, not a new note). */
export const POLY_GAP_FRAMES = 3;
/** Deepest amplitude dip that still splits a same-pitch note (re-attack). */
export const POLY_REATTACK_DIP = 0.45;
/** Most note events one clip may propose before the result is called unstable. */
export const POLY_MAX_NOTES = 256;
/** Two detections closer than this (semitones) are the same pitch, not a chord. */
export const POLY_MIN_PITCH_SEPARATION = 0.6;
/** A spectral peak must reach this share of the frame's loudest bin to count. */
export const POLY_EXPLAINED_PEAK_FLOOR = 0.05;
/** Median spectral peak share the detected notes must explain to be trusted. */
export const POLY_MIN_EXPLAINED_SHARE = 0.8;
/** Share of frames that must be pitched for a transcription to be offered. */
export const POLY_MIN_PITCHED_RATIO = 0.1;
/** Share of frames that may overflow the voice limit before refusing. */
export const POLY_MAX_OVERFLOW_RATIO = 0.25;

/** Refusals this mode can return (mapped into `AudioToMidiRefusal` by the caller). */
export type PolyphonicRefusal =
  | 'analysis-budget'
  | 'silence-or-noise'
  | 'no-fundamentals'
  | 'unreliable-harmonics'
  | 'polyphony-exceeded'
  | 'short-coverage'
  | 'no-notes';

/** The subset of the clip's resolved playback plan this analyzer needs. */
export interface PolyphonicPlan {
  /** Playback rate the engine applies (`timeStretchRate`). */
  playbackRate: number;
  /** Constant pitch offset the engine applies (detune + rate), in semitones. */
  pitchOffsetSemitones: number;
  /** Sixteenth-note steps per second at the project tempo. */
  stepsPerSecond: number;
  /** Audible length of the clip on the timeline, in seconds. */
  timelineSeconds: number;
}

export interface PolyphonicOptions {
  /** Shortest accepted note, in sixteenth-note steps. */
  minNoteSteps: number;
  /** Grid the note starts/lengths snap to, in steps. */
  quantizeSteps: number;
  /** Share of the frame's magnitude a candidate needs (default: the constant). */
  candidateShare?: number;
}

/** One measured candidate inside one frame. */
export interface PolyphonicFrameCandidate {
  /** Fractional MIDI number from the refined fundamental estimate. */
  midiFloat: number;
  /** Integer MIDI number this candidate is assigned to. */
  midi: number;
  /** Share of the frame's spectral magnitude this note's harmonics explain. */
  share: number;
  /** 0–1 confidence derived from `share` (see `POLY_CONFIDENCE_GAIN`). */
  confidence: number;
  /** Measured spectral amplitude of this note in the frame. */
  amplitude: number;
}

export interface PolyphonicFrame {
  index: number;
  /** Window centre in source seconds. */
  timeSeconds: number;
  /** Window RMS of the mono downmix. */
  rms: number;
  /** Candidates in descending salience order (empty for silent/unpitched frames). */
  candidates: PolyphonicFrameCandidate[];
  /** True when the greedy loop stopped because the voice limit was reached. */
  truncatedByVoiceLimit: boolean;
  /** Share of this frame's spectral magnitude the selected notes explain. */
  explainedShare: number;
}

export interface PolyphonicNote {
  index: number;
  /** Integer MIDI note number of the sounding pitch. */
  midi: number;
  /** Refined fractional pitch before rounding. */
  midiFloat: number;
  noteName: string;
  /** Relative to the clip's first beat (step 0 = the clip start). */
  startStep: number;
  durationSteps: number;
  startSeconds: number;
  endSeconds: number;
  /** Mean per-frame confidence, 0–1. */
  confidence: number;
  /** Mean signed cents between the measured pitch and `midi`. */
  centsOffset: number;
  /** Measured velocity, 0.2–1. */
  velocity: number;
  /** Frames that contributed to this note. */
  frameCount: number;
  /** Mean share of the frame's spectrum this note explained. */
  share: number;
}

export interface PolyphonicStats {
  frameCount: number;
  windowSamples: number;
  hopSamples: number;
  sampleRate: number;
  analysedSeconds: number;
  /** Frames with at least one candidate. */
  pitchedFrameCount: number;
  pitchedRatio: number;
  /** Loudest frame RMS (distinguishes silence from "signal, no fundamentals"). */
  peakRms: number;
  /** Median share of the strongest candidate per pitched frame. */
  medianCandidateShare: number;
  /**
   * Median share of a pitched frame's spectral magnitude the selected notes
   * explain. Tonal material explains most of its own spectrum; inharmonic and
   * dense material does not, and is refused on this measurement.
   */
  explainedShare: number;
  /** Largest simultaneous candidate count seen, and how often it occurred. */
  maxSimultaneousVoices: number;
  /** `voiceHistogram[n]` = frames with n candidates. */
  voiceHistogram: number[];
  /** Frames where the greedy loop hit `POLY_MAX_VOICES` with residual energy left. */
  voiceLimitFrames: number;
  /** Candidate notes before duration/range filtering. */
  candidateNoteCount: number;
  droppedShortNotes: number;
  /** Notes dropped because the clip's pitch offset moved them out of range. */
  outOfRangeNotes: number;
  /** Informational only: never used by a decision. */
  analysisMilliseconds?: number;
}

export interface PolyphonicAnalysis {
  status: 'ok' | 'rejected';
  refusal: PolyphonicRefusal | null;
  message: string;
  notes: PolyphonicNote[];
  frames: PolyphonicFrame[];
  stats: PolyphonicStats;
}

/**
 * A note that explains this share of a frame's magnitude is reported at full
 * confidence. The mapping is documented so "confidence" is a stated function of
 * a measured quantity, not a decorative number.
 */
export const POLY_CONFIDENCE_GAIN = 2;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const shareToConfidence = (share: number): number =>
  clamp01(Math.pow(clamp01(share) * POLY_CONFIDENCE_GAIN, 0.75));

// --- FFT ---------------------------------------------------------------------

interface FftTables {
  size: number;
  bitReversal: Uint32Array;
  cosTable: Float64Array;
  sinTable: Float64Array;
}

const fftTableCache = new Map<number, FftTables>();

/** Bit-reversal + twiddle tables. Pure maths, cached per size. */
const getFftTables = (size: number): FftTables => {
  const cached = fftTableCache.get(size);
  if (cached) return cached;
  const bits = Math.log2(size);
  const bitReversal = new Uint32Array(size);
  for (let i = 0; i < size; i += 1) {
    let reversed = 0;
    for (let b = 0; b < bits; b += 1) {
      reversed = (reversed << 1) | ((i >> b) & 1);
    }
    bitReversal[i] = reversed;
  }
  const cosTable = new Float64Array(size / 2);
  const sinTable = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i += 1) {
    // Direct evaluation (not a recurrence) so long windows do not accumulate
    // twiddle error; determinism and accuracy matter more than the one-off cost.
    cosTable[i] = Math.cos((-2 * Math.PI * i) / size);
    sinTable[i] = Math.sin((-2 * Math.PI * i) / size);
  }
  const tables: FftTables = { size, bitReversal, cosTable, sinTable };
  fftTableCache.set(size, tables);
  return tables;
};

/** In-place iterative radix-2 FFT. `re`/`im` must be `POLY_FFT_SIZE` long. */
export const fftInPlace = (re: Float64Array, im: Float64Array): void => {
  const { size, bitReversal, cosTable, sinTable } = getFftTables(re.length);
  for (let i = 0; i < size; i += 1) {
    const j = bitReversal[i];
    if (j > i) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= size; len <<= 1) {
    const half = len >> 1;
    const step = size / len;
    for (let start = 0; start < size; start += len) {
      for (let k = 0; k < half; k += 1) {
        const wr = cosTable[k * step];
        const wi = sinTable[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
};

/** Hann window (periodic form), cached. */
const hannCache = new Map<number, Float64Array>();
const getHannWindow = (size: number): Float64Array => {
  const cached = hannCache.get(size);
  if (cached) return cached;
  const window = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  hannCache.set(size, window);
  return window;
};

// --- Candidate templates -----------------------------------------------------

interface CandidateTemplate {
  midi: number;
  frequency: number;
  /** Expected bin of each harmonic plus the 1/h amplitude weight. */
  harmonics: Array<{ bin: number; weight: number }>;
}

const templateCache = new Map<string, CandidateTemplate[]>();

/**
 * One template per candidate pitch. Weights follow a `1/h` amplitude roll-off:
 * a real note is expected to carry most of its energy in the low harmonics, so a
 * candidate whose *fundamental* is present outscores the same energy explained
 * as somebody else's overtone.
 */
export const buildCandidateTemplates = (
  fftSize: number,
  sampleRate: number,
  minMidi = POLY_MIN_MIDI,
  maxMidi = POLY_MAX_MIDI,
  harmonics = POLY_HARMONICS,
): CandidateTemplate[] => {
  const key = `${fftSize}|${sampleRate}|${minMidi}|${maxMidi}|${harmonics}`;
  const cached = templateCache.get(key);
  if (cached) return cached;
  const binHz = sampleRate / fftSize;
  const templates: CandidateTemplate[] = [];
  for (let midi = minMidi; midi <= maxMidi; midi += 1) {
    const frequency = midiToFrequency(midi);
    const entries: Array<{ bin: number; weight: number }> = [];
    for (let h = 1; h <= harmonics; h += 1) {
      const harmonicHz = frequency * h;
      if (harmonicHz > sampleRate * 0.46) break;
      entries.push({ bin: harmonicHz / binHz, weight: 1 / h });
    }
    if (entries.length === 0) continue;
    templates.push({ midi, frequency, harmonics: entries });
  }
  templateCache.set(key, templates);
  return templates;
};

// --- Per-frame analysis ------------------------------------------------------

const SPECTRUM_BINS = POLY_FFT_SIZE / 2 + 1;

const scratchRe = new Float64Array(POLY_FFT_SIZE);
const scratchIm = new Float64Array(POLY_FFT_SIZE);
const scratchSpectrum = new Float64Array(SPECTRUM_BINS);
const scratchExplained = new Float64Array(SPECTRUM_BINS);
const scratchExcess = new Float64Array(POLY_HARMONICS);
const scratchBestExcess = new Float64Array(POLY_HARMONICS);

/** Magnitude spectrum (Hann-windowed, mean removed) of one frame. */
const computeSpectrum = (
  mono: Float64Array,
  start: number,
  window: Float64Array,
  out: Float64Array,
): void => {
  const size = POLY_FFT_SIZE;
  let mean = 0;
  for (let i = 0; i < size; i += 1) mean += mono[start + i];
  mean /= size;
  for (let i = 0; i < size; i += 1) {
    scratchRe[i] = (mono[start + i] - mean) * window[i];
    scratchIm[i] = 0;
  }
  fftInPlace(scratchRe, scratchIm);
  out[0] = Math.abs(scratchRe[0]);
  for (let k = 1; k < SPECTRUM_BINS; k += 1) {
    out[k] = Math.hypot(scratchRe[k], scratchIm[k]);
  }
};

/** Parabolic peak refinement around `bin` in a magnitude spectrum. */
const refinePeak = (
  spectrum: Float64Array,
  bin: number,
): { frequency: number; magnitude: number; binHz: number } => {
  const half = spectrum.length - 1;
  const centre = Math.max(1, Math.min(half - 2, Math.round(bin)));
  let best = centre;
  for (let k = centre - 1; k <= centre + 1; k += 1) {
    if (k >= 1 && k <= half - 2 && spectrum[k] > spectrum[best]) best = k;
  }
  const left = spectrum[best - 1];
  const mid = spectrum[best];
  const right = spectrum[best + 1];
  const denom = left - 2 * mid + right;
  let delta = 0;
  if (Math.abs(denom) > 1e-18) {
    delta = (0.5 * (left - right)) / denom;
    if (!(Math.abs(delta) <= 0.5)) delta = 0;
  }
  return { frequency: best + delta, magnitude: mid, binHz: 1 };
};

/** Sum of `|X[k]|` over the spectrum (the frame's spectral magnitude budget). */
const magnitudeSum = (spectrum: Float64Array): number => {
  let sum = 0;
  for (let k = 1; k < spectrum.length; k += 1) sum += spectrum[k];
  return sum;
};

/**
 * Masking-aware harmonic salience.
 *
 * For a candidate pitch the analyzer adds up the measured magnitude at that
 * pitch's harmonic series — but only the part of each bin that the notes already
 * selected *in this frame* do not explain. This is the difference between a
 * transcription and a peak lister:
 *
 *   - the overtones of an already-selected note are explained by that note, so
 *     they score ~0 and can never come back as separate notes;
 *   - a real second note keeps whatever it adds on top of a bin it shares with a
 *     louder note (a melody two octaves above a held bass sits exactly on the
 *     bass's fourth harmonic), which zeroing the shared bins would have erased.
 *
 * The `1/h` weight means a candidate whose *fundamental* is present outscores the
 * same energy explained as somebody else's far overtone.
 */
const scoreTemplate = (
  spectrum: Float64Array,
  explained: Float64Array,
  template: CandidateTemplate,
  excess: Float64Array,
  binHz: number,
): { salience: number; fundamental: number; fundamentalFrequency: number } => {
  const last = spectrum.length - 2;
  let salience = 0;
  let fundamental = 0;
  let fundamentalFrequency = template.frequency;
  for (let h = 1; h <= template.harmonics.length; h += 1) {
    const centre = Math.max(1, Math.min(last, Math.round(template.harmonics[h - 1].bin)));
    let peakBin = centre;
    for (let k = centre - 1; k <= centre + 1; k += 1) {
      if (k >= 1 && k <= last && spectrum[k] > spectrum[peakBin]) peakBin = k;
    }
    const unexplained = Math.max(0, spectrum[peakBin] - explained[peakBin]);
    excess[h - 1] = unexplained;
    salience += unexplained * template.harmonics[h - 1].weight;
    if (h === 1) {
      fundamental = unexplained;
      // Sub-bin refinement of the fundamental peak: the ultimate gate on whether
      // this template is even a candidate is that the measured pitch rounds to it.
      fundamentalFrequency = refinePeak(spectrum, peakBin).frequency * binHz;
    }
  }
  return { salience, fundamental, fundamentalFrequency };
};

/**
 * Amplitude of the selected note, in spectrum-magnitude units, fitted from the
 * energy it actually added (`measured(h) · h`, whose expectation is constant for
 * the `1/h` model). The median is robust to one or two harmonics being masked by
 * another note or weak in the source timbre.
 */
const fitHarmonicAmplitude = (
  excess: Float64Array,
  harmonicCount: number,
): number => {
  const values: number[] = [];
  const cutoff = POLY_HARMONIC_FIT_FLOOR * excess[0];
  for (let h = 1; h <= harmonicCount; h += 1) {
    const value = excess[h - 1];
    // Harmonics that carry only window leakage (well below the fundamental) say
    // nothing about the note's amplitude and must not drag the fit down.
    if (!(value > 0)) continue;
    if (h > 1 && value < cutoff) continue;
    values.push(value * h);
  }
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid] : 0.5 * (values[mid - 1] + values[mid]);
};

/**
 * Records the energy the selected note explains so later candidates in the same
 * frame cannot score it again. The prediction is capped at the measured
 * magnitude of each bin, so explaining never manufactures negative energy and a
 * quieter note that shares its fundamental with a louder note's overtone keeps
 * the part that is genuinely its own.
 */
const explainSelectedNote = (
  explained: Float64Array,
  spectrum: Float64Array,
  template: CandidateTemplate,
  amplitude: number,
): void => {
  if (!(amplitude > 0)) return;
  const last = spectrum.length - 2;
  for (let h = 1; h <= template.harmonics.length; h += 1) {
    const centre = Math.max(1, Math.min(last, Math.round(template.harmonics[h - 1].bin)));
    const predicted = (amplitude / h) * POLY_HARMONIC_MODEL_SAFETY;
    for (let k = centre - 1; k <= centre + 1; k += 1) {
      if (k >= 1 && k <= last) {
        explained[k] = Math.min(spectrum[k], explained[k] + predicted);
      }
    }
  }
};

/**
 * Fundamental estimate for a selected candidate.
 *
 * Uses every harmonic that carries meaningful magnitude and takes the
 * magnitude-weighted median of `peakFrequency / h`. That keeps the estimate
 * accurate when the fundamental itself is weak (a missing-fundamental timbre)
 * instead of trusting one bin.
 */
const estimateFundamental = (
  spectrum: Float64Array,
  template: CandidateTemplate,
  binHz: number,
  fundamentalHz: number,
): { frequency: number; amplitude: number } => {
  const half = spectrum.length - 1;
  const pairs: Array<{ f0: number; weight: number }> = [];
  let energy = 0;
  // The fundamental peak is the anchor; every other harmonic may only pull the
  // estimate a little. A template whose 2nd or 3rd partial slot happens to
  // contain another note's fundamental would otherwise drag the estimate onto the
  // wrong pitch entirely.
  pairs.push({ f0: fundamentalHz, weight: 1e9 });
  for (let h = 2; h <= template.harmonics.length; h += 1) {
    const expectedBin = (fundamentalHz * h) / binHz;
    const centre = Math.round(expectedBin);
    let best = -1;
    let bestMagnitude = 0;
    for (let k = centre - 1; k <= centre + 1; k += 1) {
      if (k >= 2 && k < half && spectrum[k] > bestMagnitude) {
        bestMagnitude = spectrum[k];
        best = k;
      }
    }
    if (best < 0 || !(bestMagnitude > 0)) continue;
    const refined = refinePeak(spectrum, best);
    const f0 = (refined.frequency * binHz) / h;
    if (Math.abs(f0 / fundamentalHz - 1) > POLY_HARMONIC_PITCH_TOLERANCE) continue;
    pairs.push({ f0, weight: bestMagnitude });
    energy += bestMagnitude * bestMagnitude;
  }
  pairs.sort((a, b) => a.f0 - b.f0);
  const totalWeight = pairs.reduce((sum, pair) => sum + pair.weight, 0);
  let running = 0;
  let frequency = fundamentalHz;
  for (const pair of pairs) {
    running += pair.weight;
    if (running >= totalWeight / 2) {
      frequency = pair.f0;
      break;
    }
  }
  return { frequency, amplitude: Math.sqrt(energy) };
};

// --- Note tracking -----------------------------------------------------------

interface Track {
  midi: number;
  frames: number[];
  midiFloats: number[];
  confidences: number[];
  shares: number[];
  amplitudes: number[];
}

/**
 * Groups a pitch's per-frame detections into note runs and splits a run at a
 * re-attack.
 *
 * A repeated note of the same pitch is the hard case for a frame tracker: the
 * pitch never changes, so only the amplitude envelope says there were two
 * events. A run is split at its deepest interior dip when that dip falls below
 * `POLY_REATTACK_DIP` of the run's peak and both sides recover above it. The
 * recursion is depth-bounded, so a wobbling envelope cannot explode into dozens
 * of notes.
 */
const splitAtReattacks = (
  frames: readonly number[],
  amplitudes: readonly number[],
  depth = 0,
): Array<{ from: number; to: number }> => {
  if (frames.length === 0) return [];
  if (depth >= 3 || frames.length < POLY_MIN_NOTE_FRAMES * 2) {
    return [{ from: 0, to: frames.length }];
  }
  let peak = 0;
  for (const amplitude of amplitudes) if (amplitude > peak) peak = amplitude;
  if (peak <= 0) return [{ from: 0, to: frames.length }];

  let splitIndex = -1;
  let deepest = peak * POLY_REATTACK_DIP;
  for (let i = 2; i < amplitudes.length - 2; i += 1) {
    const previous = amplitudes[i - 1];
    const current = amplitudes[i];
    const next = amplitudes[i + 1];
    if (!(current <= previous && current <= next)) continue;
    if (current >= deepest) continue;
    let leftPeak = 0;
    for (let k = 0; k < i; k += 1) if (amplitudes[k] > leftPeak) leftPeak = amplitudes[k];
    let rightPeak = 0;
    for (let k = i + 1; k < amplitudes.length; k += 1) if (amplitudes[k] > rightPeak) rightPeak = amplitudes[k];
    if (leftPeak < peak * 0.7 || rightPeak < peak * 0.7) continue;
    deepest = current;
    splitIndex = i;
  }
  if (splitIndex < 0) return [{ from: 0, to: frames.length }];

  const left = splitAtReattacks(frames.slice(0, splitIndex), amplitudes.slice(0, splitIndex), depth + 1);
  const right = splitAtReattacks(frames.slice(splitIndex), amplitudes.slice(splitIndex), depth + 1);
  const offset = splitIndex;
  return [
    ...left.map(range => ({ from: range.from, to: range.to })),
    ...right.map(range => ({ from: range.from + offset, to: range.to + offset })),
  ];
};

/** One measured note run, in source seconds, before project-step legalisation. */
interface RawNote {
  midi: number;
  midiFloat: number;
  startSeconds: number;
  endSeconds: number;
  confidence: number;
  cents: number;
  amplitude: number;
  share: number;
  frameCount: number;
}

/**
 * Turns measured note runs into project steps.
 *
 * Timing is the monophonic pipeline's timing: source seconds → timeline seconds
 * with the clip's real playback rate (already applied when the run was measured)
 * → the project's steps-per-second → the caller's quantize grid, with lengths
 * raised to the shared note-duration policy minimum. There is no second time
 * model. The same-pitch overlap rule is what keeps the result writable: two notes
 * of one pitch cannot sound at once, so an overlap extends the earlier note
 * instead of writing a duplicate the Piano Roll could not display distinctly.
 *
 * Exported because it is the layer the duration-policy audit probes directly
 * (`src/music/noteDurationPolicy.ts` → `polyphonic-transcription.note-timing`):
 * the shortest length this layer can emit must be the shared policy minimum.
 */
export const legalizePolyphonicTiming = (
  rawNotes: readonly RawNote[],
  plan: PolyphonicPlan,
  options: PolyphonicOptions,
): PolyphonicNote[] => {
  const grid = options.quantizeSteps > 0 ? options.quantizeSteps : MIN_NOTE_DURATION_STEPS;
  const maxAmplitude = rawNotes.reduce((max, note) => Math.max(max, note.amplitude), 0);
  const byPitch = new Map<number, PolyphonicNote[]>();
  const sorted = [...rawNotes].sort(
    (a, b) => (a.startSeconds - b.startSeconds) || (a.midi - b.midi),
  );
  for (const raw of sorted) {
    let startStep = Math.round((raw.startSeconds * plan.stepsPerSecond) / grid) * grid;
    let endStep = Math.round((raw.endSeconds * plan.stepsPerSecond) / grid) * grid;
    if (startStep < 0) startStep = 0;
    if (endStep <= startStep) endStep = startStep + grid;
    const durationSteps = quantizeDurationSteps(Math.max(options.minNoteSteps, endStep - startStep));
    if (durationSteps < options.minNoteSteps - 1e-9) continue;
    const loudness = maxAmplitude > 1e-12 ? Math.sqrt(clamp01(raw.amplitude / maxAmplitude)) : 0.6;
    const note: PolyphonicNote = {
      index: 0,
      midi: raw.midi,
      midiFloat: raw.midiFloat,
      noteName: midiToNoteName(raw.midi),
      startStep,
      durationSteps,
      startSeconds: startStep / plan.stepsPerSecond,
      endSeconds: (startStep + durationSteps) / plan.stepsPerSecond,
      confidence: clamp01(raw.confidence),
      centsOffset: raw.cents,
      velocity: Math.min(1, Math.max(0.2, 0.35 + 0.65 * loudness)),
      frameCount: raw.frameCount,
      share: raw.share,
    };
    const list = byPitch.get(note.midi) ?? [];
    const previous = list[list.length - 1];
    if (previous && note.startStep < previous.startStep + previous.durationSteps - 1e-9) {
      const mergedEnd = Math.max(
        previous.startStep + previous.durationSteps,
        note.startStep + note.durationSteps,
      );
      previous.durationSteps = quantizeDurationSteps(mergedEnd - previous.startStep);
      previous.endSeconds = previous.startStep + previous.durationSteps;
      previous.confidence = Math.max(previous.confidence, note.confidence);
      previous.share = Math.max(previous.share, note.share);
      previous.velocity = Math.max(previous.velocity, note.velocity);
      continue;
    }
    list.push(note);
    byPitch.set(note.midi, list);
  }

  const notes: PolyphonicNote[] = [];
  for (const list of byPitch.values()) notes.push(...list);
  notes.sort((a, b) => (a.startStep - b.startStep) || (a.midi - b.midi));
  notes.forEach((note, index) => { note.index = index; });
  return notes;
};

// --- Public entry point ------------------------------------------------------

export interface PolyphonicInput {
  /** Already windowed PCM channel data (the caller resolves the clip window). */
  channels: readonly Float32Array[];
  sampleRate: number;
  plan: PolyphonicPlan;
  options: PolyphonicOptions;
}

const medianOf = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
};

/**
 * Transcribes real PCM into polyphonic note events. Pure: identical input
 * (samples, sample rate, plan, options) always produces identical output.
 */
export const transcribePolyphonicPcm = (input: PolyphonicInput): PolyphonicAnalysis => {
  const started = typeof performance !== 'undefined' ? performance.now() : 0;
  const { channels, sampleRate, plan, options } = input;
  const window = getHannWindow(POLY_FFT_SIZE);
  const templates = buildCandidateTemplates(
    POLY_FFT_SIZE,
    sampleRate,
    POLY_GUARD_MIN_MIDI,
    POLY_GUARD_MAX_MIDI,
  );
  const binHz = sampleRate / POLY_FFT_SIZE;
  const channelCount = Math.max(1, channels.length);
  const totalSamples = channels[0]?.length ?? 0;

  const frameCount = totalSamples >= POLY_FFT_SIZE
    ? Math.floor((totalSamples - POLY_FFT_SIZE) / POLY_HOP) + 1
    : 0;

  const emptyStats: PolyphonicStats = {
    frameCount,
    windowSamples: POLY_FFT_SIZE,
    hopSamples: POLY_HOP,
    sampleRate,
    analysedSeconds: totalSamples / sampleRate,
    pitchedFrameCount: 0,
    pitchedRatio: 0,
    peakRms: 0,
    medianCandidateShare: 0,
    explainedShare: 0,
    maxSimultaneousVoices: 0,
    voiceHistogram: [],
    voiceLimitFrames: 0,
    candidateNoteCount: 0,
    droppedShortNotes: 0,
    outOfRangeNotes: 0,
  };

  if (totalSamples / sampleRate > POLY_MAX_ANALYSIS_SECONDS + 1e-9) {
    return {
      status: 'rejected',
      refusal: 'analysis-budget',
      message: `This clip's audible window is ${(totalSamples / sampleRate).toFixed(1)} s. Polyphonic transcription analyses up to ${POLY_MAX_ANALYSIS_SECONDS} s per clip, so nothing was transcribed. Trim or split the clip and analyse the section you need.`,
      notes: [],
      frames: [],
      stats: emptyStats,
    };
  }
  if (frameCount > POLY_MAX_FRAMES) {
    return {
      status: 'rejected',
      refusal: 'analysis-budget',
      message: `Polyphonic analysis is bounded to ${POLY_MAX_FRAMES} frames; this window needs ${frameCount}. Nothing was transcribed — trim the clip and analyse the section you need.`,
      notes: [],
      frames: [],
      stats: emptyStats,
    };
  }
  if (frameCount < 4) {
    return {
      status: 'rejected',
      refusal: 'short-coverage',
      message: 'The audible part of this clip is too short for a polyphonic analysis. Nothing was transcribed.',
      notes: [],
      frames: [],
      stats: emptyStats,
    };
  }

  const mono = monoDownmix(channels as Float32Array[]);

  // Pass 1: frame RMS, so the silence gate can be relative to the loudest frame.
  const frameRms = new Float64Array(frameCount);
  let maxRms = 0;
  for (let i = 0; i < frameCount; i += 1) {
    const start = i * POLY_HOP;
    let sumSquares = 0;
    for (let j = 0; j < POLY_FFT_SIZE; j += 1) {
      const value = mono[start + j];
      sumSquares += value * value;
    }
    const rms = Math.sqrt(sumSquares / POLY_FFT_SIZE) / channelCount;
    frameRms[i] = rms;
    if (rms > maxRms) maxRms = rms;
  }
  const rmsGate = Math.max(POLY_RMS_FLOOR, POLY_RMS_RELATIVE_FLOOR * maxRms);

  // Pass 2: per-frame greedy multi-pitch estimation with cancellation.
  const frames: PolyphonicFrame[] = [];
  const voiceHistogram = new Array<number>(POLY_MAX_VOICES + 2).fill(0);
  let pitchedFrameCount = 0;
  let voiceLimitFrames = 0;
  let maxSimultaneousVoices = 0;
  const topShares: number[] = [];
  const explainedShares: number[] = [];

  for (let i = 0; i < frameCount; i += 1) {
    const timeSeconds = (i * POLY_HOP + POLY_FFT_SIZE / 2) / sampleRate;
    if (frameRms[i] < rmsGate) {
      frames.push({
        index: i,
        timeSeconds,
        rms: frameRms[i],
        candidates: [],
        truncatedByVoiceLimit: false,
        explainedShare: 0,
      });
      voiceHistogram[0] += 1;
      continue;
    }
    computeSpectrum(mono, i * POLY_HOP, window, scratchSpectrum);
    const totalMagnitude = magnitudeSum(scratchSpectrum);
    if (!(totalMagnitude > 1e-12)) {
      frames.push({
        index: i,
        timeSeconds,
        rms: frameRms[i],
        candidates: [],
        truncatedByVoiceLimit: false,
        explainedShare: 0,
      });
      voiceHistogram[0] += 1;
      continue;
    }
    scratchExplained.fill(0);
    const fundamentalFloor = POLY_MIN_FUNDAMENTAL_SHARE * totalMagnitude;

    const selected: PolyphonicFrameCandidate[] = [];
    const selectedTemplates: CandidateTemplate[] = [];
    let truncated = false;
    let bestShare = 0;

    for (let voice = 0; voice < POLY_MAX_VOICES; voice += 1) {
      let bestTemplate: CandidateTemplate | null = null;
      let bestSalience = 0;
      let bestFundamentalHz = 0;
      for (const template of templates) {
        // A candidate that duplicates a pitch already selected this frame can
        // never be a second note: that pitch is taken.
        let duplicate = false;
        for (const chosen of selectedTemplates) {
          if (Math.abs(chosen.midi - template.midi) < 1) { duplicate = true; break; }
        }
        if (duplicate) continue;
        const score = scoreTemplate(
          scratchSpectrum,
          scratchExplained,
          template,
          scratchExcess,
          binHz,
        );
        // A genuine candidate is the pitch the spectrum actually measures, rounded
        // to the nearest semitone. This stops a loud note's spectral leakage (or
        // its own overtones) from being attributed to the neighbouring pitch.
        if (Math.abs(frequencyToMidi(score.fundamentalFrequency) - template.midi) > POLY_FUNDAMENTAL_SEMITONE_TOLERANCE) {
          continue;
        }
        // The candidate must also own energy at its own fundamental. Energy that a
        // selected note's harmonic already explains is that note's, not a new one.
        if (score.fundamental < fundamentalFloor) continue;
        if (score.salience > bestSalience) {
          bestSalience = score.salience;
          bestTemplate = template;
          bestFundamentalHz = score.fundamentalFrequency;
          scratchBestExcess.set(scratchExcess);
        }
      }
      if (!bestTemplate) break;
      const share = bestSalience / totalMagnitude;
      const absoluteFloor = options.candidateShare ?? POLY_MIN_CANDIDATE_SHARE;
      const floor = voice === 0 ? absoluteFloor : Math.max(absoluteFloor, POLY_RELATIVE_CANDIDATE_SHARE * bestShare);
      if (share < floor) break;

      const estimate = estimateFundamental(
        scratchSpectrum,
        bestTemplate,
        binHz,
        bestFundamentalHz,
      );
      const midiFloat = frequencyToMidi(estimate.frequency);
      // Guard-range notes are selected so they can explain their own harmonics,
      // but they are never reported as notes (see `POLY_GUARD_MIN_MIDI`).
      if (!(midiFloat >= POLY_GUARD_MIN_MIDI - 0.5 && midiFloat <= POLY_GUARD_MAX_MIDI + 0.5)) break;
      // Two candidates that measure the same pitch are one note with measurement
      // noise, not two voices of a chord.
      let samePitch = false;
      for (const chosen of selected) {
        if (Math.abs(chosen.midiFloat - midiFloat) < POLY_MIN_PITCH_SEPARATION) { samePitch = true; break; }
      }
      if (samePitch) break;

      selected.push({
        midiFloat,
        midi: Math.round(midiFloat),
        share,
        confidence: shareToConfidence(share),
        amplitude: fitHarmonicAmplitude(scratchBestExcess, bestTemplate.harmonics.length),
      });
      selectedTemplates.push(bestTemplate);
      if (voice === 0) bestShare = share;
      explainSelectedNote(
        scratchExplained,
        scratchSpectrum,
        bestTemplate,
        selected[selected.length - 1].amplitude,
      );
    }

    // Did the loop stop at the voice limit with audible content still unclaimed?
    if (selected.length >= POLY_MAX_VOICES) {
      let residualBest = 0;
      for (const template of templates) {
        let duplicate = false;
        for (const chosen of selectedTemplates) {
          if (Math.abs(chosen.midi - template.midi) < 1) { duplicate = true; break; }
        }
        if (duplicate) continue;
        const score = scoreTemplate(
          scratchSpectrum,
          scratchExplained,
          template,
          scratchExcess,
          binHz,
        );
        if (Math.abs(frequencyToMidi(score.fundamentalFrequency) - template.midi) > POLY_FUNDAMENTAL_SEMITONE_TOLERANCE) {
          continue;
        }
        if (score.fundamental < fundamentalFloor) continue;
        if (score.salience > residualBest) residualBest = score.salience;
      }
      if (residualBest / totalMagnitude >= Math.max(POLY_MIN_CANDIDATE_SHARE, POLY_RELATIVE_CANDIDATE_SHARE * bestShare)) {
        truncated = true;
        voiceLimitFrames += 1;
      }
    }

    // How much of the frame's *peak* energy the selected notes account for. Peak
    // mass, not total magnitude: broadband hiss fills thousands of low-level bins
    // and would otherwise dominate the ratio even on a perfectly clean note.
    let maxMagnitude = 0;
    for (let k = 1; k < scratchSpectrum.length - 1; k += 1) {
      if (scratchSpectrum[k] > maxMagnitude) maxMagnitude = scratchSpectrum[k];
    }
    const peakFloor = POLY_EXPLAINED_PEAK_FLOOR * maxMagnitude;
    let peakMass = 0;
    let explainedMass = 0;
    for (let k = 2; k < scratchSpectrum.length - 2; k += 1) {
      if (scratchSpectrum[k] < peakFloor) continue;
      if (!(scratchSpectrum[k] >= scratchSpectrum[k - 1] && scratchSpectrum[k] >= scratchSpectrum[k + 1])) continue;
      peakMass += scratchSpectrum[k];
      explainedMass += Math.min(scratchExplained[k], scratchSpectrum[k]);
    }
    const explainedShare = peakMass > 0 ? clamp01(explainedMass / peakMass) : 0;
    if (selected.length > 0) {
      pitchedFrameCount += 1;
      topShares.push(selected[0].share);
      explainedShares.push(explainedShare);
      if (selected.length > maxSimultaneousVoices) maxSimultaneousVoices = selected.length;
    }
    voiceHistogram[Math.min(selected.length, voiceHistogram.length - 1)] += 1;
    frames.push({
      index: i,
      timeSeconds,
      rms: frameRms[i],
      candidates: selected,
      truncatedByVoiceLimit: truncated,
      explainedShare,
    });
  }

  const stats: PolyphonicStats = {
    ...emptyStats,
    pitchedFrameCount,
    pitchedRatio: frameCount > 0 ? pitchedFrameCount / frameCount : 0,
    peakRms: maxRms,
    medianCandidateShare: medianOf(topShares),
    explainedShare: medianOf(explainedShares),
    maxSimultaneousVoices,
    voiceHistogram,
    voiceLimitFrames,
    candidateNoteCount: 0,
    droppedShortNotes: 0,
    outOfRangeNotes: 0,
  };

  const reject = (refusal: PolyphonicRefusal, message: string): PolyphonicAnalysis => ({
    status: 'rejected',
    refusal,
    message,
    notes: [],
    frames,
    stats,
  });

  if (pitchedFrameCount === 0) {
    if (maxRms > 1e-3) {
      return reject(
        'no-fundamentals',
        `This clip carries audio but no frame contains a note fundamental inside C2–C6 (MIDI ${POLY_MIN_MIDI}–${POLY_MAX_MIDI}). Drums, noise, speech and material outside that range are not transcribed, and nothing was transcribed.`,
      );
    }
    return reject(
      'silence-or-noise',
      'This clip measured as silence: no frame carries enough energy to analyse. Nothing was transcribed and the project was not changed.',
    );
  }
  if (stats.pitchedRatio < POLY_MIN_PITCHED_RATIO) {
    return reject(
      'short-coverage',
      `Only ${(stats.pitchedRatio * 100).toFixed(1)} % of this clip's frames contain a detectable note. Polyphonic transcription needs tonal material; the rest measured as silence, noise or unpitched sound. Nothing was transcribed.`,
    );
  }
  if (stats.explainedShare < POLY_MIN_EXPLAINED_SHARE) {
    return reject(
      'unreliable-harmonics',
      `The detected notes explain only ${(stats.explainedShare * 100).toFixed(0)} % of this clip's spectral energy: most of the sound does not follow a harmonic series above C2–C6. Bells, drums, dense mixes and heavy distortion are not transcribed; nothing was transcribed.`,
    );
  }
  if (voiceLimitFrames / Math.max(1, pitchedFrameCount) > POLY_MAX_OVERFLOW_RATIO) {
    return reject(
      'polyphony-exceeded',
      `${voiceLimitFrames} of ${pitchedFrameCount} pitched frames carry more than ${POLY_MAX_VOICES} simultaneous fundamentals. This build transcribes up to ${POLY_MAX_VOICES} voices; transcribing only some of them would misrepresent the audio, so nothing was transcribed.`,
    );
  }

  // Pass 3: group each pitch's detections into note runs. A pitch can be struck
  // more than once, so one pitch owns a *list* of tracks: keeping only the latest
  // would silently drop every earlier repetition of the same note.
  const tracksByMidi = new Map<number, Track[]>();
  for (const frame of frames) {
    for (const candidate of frame.candidates) {
      const pitchTracks = tracksByMidi.get(candidate.midi) ?? [];
      if (!tracksByMidi.has(candidate.midi)) tracksByMidi.set(candidate.midi, pitchTracks);
      let track = pitchTracks[pitchTracks.length - 1];
      const lastFrame = track ? track.frames[track.frames.length - 1] : -Infinity;
      if (!track || frame.index - lastFrame > POLY_GAP_FRAMES) {
        track = { midi: candidate.midi, frames: [], midiFloats: [], confidences: [], shares: [], amplitudes: [] };
        pitchTracks.push(track);
      }
      track.frames.push(frame.index);
      track.midiFloats.push(candidate.midiFloat);
      track.confidences.push(candidate.confidence);
      track.shares.push(candidate.share);
      track.amplitudes.push(candidate.amplitude);
    }
    // A pitch that disappears for more than the gap tolerance starts a new note
    // on its next detection; nothing to do here beyond the `lastFrame` check.
  }

  const frameSeconds = POLY_HOP / sampleRate;
  const windowHalfSeconds = POLY_FFT_SIZE / 2 / sampleRate;
  const windowQuarterSeconds = POLY_FFT_SIZE / 4 / sampleRate;
  const rate = Number.isFinite(plan.playbackRate) && plan.playbackRate > 0 ? plan.playbackRate : 1;
  const grid = options.quantizeSteps > 0 ? options.quantizeSteps : MIN_NOTE_DURATION_STEPS;
  const minFrames = Math.max(1, Math.ceil((options.minNoteSteps / (frameSeconds * plan.stepsPerSecond * (1 / rate)))));

  const rawNotes: RawNote[] = [];
  let droppedShortNotes = 0;

  // The engine sounds the clip transposed by `pitchOffsetSemitones` (the clip's
  // pitch shift plus the rate-induced shift). The analysis measured *source*
  // pitch, so the offset is added once, here, exactly like monophonic mode.
  const pitchOffset = Number.isFinite(plan.pitchOffsetSemitones) ? plan.pitchOffsetSemitones : 0;
  let outOfRangeNotes = 0;
  let suppressedOutOfRange = 0;

  const tracks: Track[] = [];
  for (const pitchTracks of tracksByMidi.values()) tracks.push(...pitchTracks);

  for (const track of tracks) {
    // A pitch outside the reportable range explains its harmonics but is not a
    // transcription result.
    if (track.midi < POLY_MIN_MIDI || track.midi > POLY_MAX_MIDI) {
      suppressedOutOfRange += 1;
      continue;
    }
    const runs = splitAtReattacks(track.frames, track.amplitudes);
    for (const run of runs) {
      const count = run.to - run.from;
      if (count < Math.max(POLY_MIN_NOTE_FRAMES, minFrames)) {
        droppedShortNotes += 1;
        continue;
      }
      const sliceFloats = track.midiFloats.slice(run.from, run.to);
      const sliceConfidences = track.confidences.slice(run.from, run.to);
      const sliceShares = track.shares.slice(run.from, run.to);
      const sliceAmplitudes = track.amplitudes.slice(run.from, run.to);
      const sourceMidiFloat = sliceFloats.reduce((sum, value) => sum + value, 0) / sliceFloats.length;
      const midiFloat = sourceMidiFloat + pitchOffset;
      const soundingMidi = Math.round(midiFloat);
      if (soundingMidi < POLY_MIN_MIDI || soundingMidi > POLY_MAX_MIDI) {
        outOfRangeNotes += 1;
        continue;
      }
      // A window detects the note as soon as it *overlaps* it, so the first
      // detected window centre can sit almost half a window before the onset and
      // the last one almost half a window past the offset. Both edges are pulled
      // in by a quarter window — measured against the fixtures to be the best
      // single correction for attack-decay material — then converted from source
      // time to timeline time with the clip's real playback rate, exactly what
      // the engine applies.
      const startSeconds = Math.max(0, (track.frames[run.from] * frameSeconds) + windowHalfSeconds + windowQuarterSeconds) / rate;
      const endSeconds = ((track.frames[run.to - 1] * frameSeconds) + windowHalfSeconds - windowQuarterSeconds) / rate;
      rawNotes.push({
        midi: soundingMidi,
        midiFloat,
        startSeconds,
        endSeconds: Math.min(endSeconds, plan.timelineSeconds),
        confidence: sliceConfidences.reduce((sum, value) => sum + value, 0) / sliceConfidences.length,
        cents: (midiFloat - soundingMidi) * 100,
        amplitude: sliceAmplitudes.reduce((sum, value) => sum + value, 0) / sliceAmplitudes.length,
        share: sliceShares.reduce((sum, value) => sum + value, 0) / sliceShares.length,
        frameCount: count,
      });
    }
  }

  stats.candidateNoteCount = rawNotes.length;
  stats.droppedShortNotes = droppedShortNotes;
  stats.outOfRangeNotes = outOfRangeNotes;

  if (rawNotes.length === 0) {
    if (suppressedOutOfRange > 0 || outOfRangeNotes > 0) {
      return reject(
        'no-fundamentals',
        `This clip's fundamentals fall outside the transcribed range C2–C6 (MIDI ${POLY_MIN_MIDI}–${POLY_MAX_MIDI})${Math.abs(pitchOffset) > 1e-9 ? ` once the clip's ${pitchOffset > 0 ? '+' : ''}${pitchOffset.toFixed(2)}-semitone pitch offset is applied` : ''}. Nothing was transcribed.`,
      );
    }
    return reject(
      'no-notes',
      `Polyphonic analysis found note material but no note survived the ${options.minNoteSteps}-step minimum length. Try a lower minimum length, or analyse a clip with longer, steadier notes. Nothing was transcribed.`,
    );
  }
  if (rawNotes.length > POLY_MAX_NOTES) {
    return reject(
      'unreliable-harmonics',
      `The analysis produced ${rawNotes.length} note candidates, which means the spectrum is churning rather than holding notes. Dense mixes, distortion and noisy material are not transcribed reliably; nothing was transcribed.`,
    );
  }

  const notes = legalizePolyphonicTiming(rawNotes, plan, options);

  if (notes.length === 0) {
    return reject(
      'no-notes',
      `Polyphonic analysis found pitches but no note survived the ${options.minNoteSteps}-step minimum length. Nothing was transcribed.`,
    );
  }

  stats.analysisMilliseconds = typeof performance !== 'undefined' ? performance.now() - started : undefined;

  return {
    status: 'ok',
    refusal: null,
    message: '',
    notes,
    frames,
    stats,
  };
};
