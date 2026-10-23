/**
 * Phase 8B — real wavetable oscillator tables.
 *
 * This module is the single source of truth for a wavetable voice's shape.
 * `renderWavetableVoice` turns the result into a `PeriodicWave` oscillator, and
 * the wavetable modal draws the very same samples, so the display is the sound
 * the engine generates rather than an illustration of it.
 *
 * How the table is built (all deterministic, no randomness):
 *
 *   1. Six phase-aligned single-cycle frames are declared as harmonic series
 *      (sine phase, so every frame starts at zero with a rising edge):
 *      sine, triangle, saw, square, hollow (formant) and metallic.
 *   2. `morph` linearly interpolates between adjacent frame amplitudes, so the
 *      morph position changes the generated waveform.
 *   3. `warpMode` applies a real table transform:
 *        - `pwm`  : table(x) - table(x - duty) with duty = 0.5 - 0.45·amount
 *        - `bend` : table(x^(1 + 2·amount)) phase distortion
 *        - `sync` : table(frac(x · (1 + 3·amount))) hard-sync read
 *   4. Partial gain 1–8 (`harmonics`) scales those harmonics of the table.
 *   5. The cycle is truncated to `WAVETABLE_HARMONIC_LIMIT` harmonics (a
 *      band-limited series), DC is removed and the cycle is peak-normalised.
 *      The truncated coefficients are what `createPeriodicWave` receives.
 *
 * Limits: the table is a band-limited harmonic series with 64 partials. It is
 * not oversampled, and no aliasing-free guarantee is made for the hard-sync
 * warp at extreme pitches; the oscillator's own band limiting is relied upon
 * for playback.
 */
import type { WavetableParameters, WavetableWarpMode } from '../types/daw';

export const WAVETABLE_FRAME_COUNT = 6;
export const WAVETABLE_FRAME_LABELS: readonly string[] = [
  'Sine',
  'Triangle',
  'Saw',
  'Square',
  'Hollow',
  'Metallic',
];

/** Band limit of the generated cycle. Also the highest coefficient sent to the oscillator. */
export const WAVETABLE_HARMONIC_LIMIT = 64;
/** Partials exposed as user-controlled harmonic gain (H1–H8). */
export const WAVETABLE_HARMONIC_CONTROLS = 8;
export const WAVETABLE_MAX_UNISON_VOICES = 7;
export const WAVETABLE_MAX_UNISON_DETUNE_CENTS = 50;
export const WAVETABLE_SAMPLE_COUNT = 1024;
export const WAVETABLE_DISPLAY_SAMPLE_COUNT = 256;

export const WAVETABLE_WARP_MODES: readonly WavetableWarpMode[] = ['none', 'pwm', 'bend', 'sync'];
export const WAVETABLE_WARP_LABELS: Record<WavetableWarpMode, string> = {
  none: 'None (table morph only)',
  pwm: 'Pulse-width difference (PWM)',
  bend: 'Phase bend',
  sync: 'Hard sync (table read)',
};

export const DEFAULT_WAVETABLE_HARMONICS: readonly number[] = [1, 0.7, 0.5, 0.35, 0.25, 0.18, 0.12, 0.08];

/**
 * Safe defaults for projects saved before the wavetable engine existed.
 * Stereo spread defaults to 0 so an untouched wavetable channel stays mono
 * (and therefore obeys the same channel-pan parity contract as every other
 * instrument); the UI and presets set a wider value deliberately.
 */
export const DEFAULT_WAVETABLE_PARAMETERS: Readonly<WavetableParameters> = Object.freeze({
  morph: 0.35,
  harmonics: [...DEFAULT_WAVETABLE_HARMONICS],
  warpMode: 'none',
  warpAmount: 0,
  unisonVoices: 3,
  unisonDetuneCents: 8,
  unisonSpread: 0,
});

const TAU = Math.PI * 2;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const finiteOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** Clamps persisted (possibly older or hand-edited) settings into engine bounds. */
export const normalizeWavetableParameters = (input: unknown): WavetableParameters => {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<WavetableParameters> & {
    unisonDetune?: unknown;
    warpMode?: unknown;
  };

  const rawHarmonics = Array.isArray(raw.harmonics) ? raw.harmonics : [];
  const harmonics: number[] = [];
  for (let i = 0; i < WAVETABLE_HARMONIC_CONTROLS; i++) {
    harmonics.push(clamp(finiteOr(rawHarmonics[i], DEFAULT_WAVETABLE_HARMONICS[i]), 0, 1));
  }

  const warpModeCandidate = typeof raw.warpMode === 'string' ? raw.warpMode : '';
  const warpMode: WavetableWarpMode = WAVETABLE_WARP_MODES.includes(warpModeCandidate as WavetableWarpMode)
    ? (warpModeCandidate as WavetableWarpMode)
    : DEFAULT_WAVETABLE_PARAMETERS.warpMode;

  // Accept the pre-8B persisted `unisonDetune` spelling as an alias so an early
  // preview document that stored cents under that name is not silently reset.
  const detuneSource = raw.unisonDetuneCents ?? raw.unisonDetune;

  return {
    morph: clamp(finiteOr(raw.morph, DEFAULT_WAVETABLE_PARAMETERS.morph), 0, 1),
    harmonics,
    warpMode,
    warpAmount: clamp(finiteOr(raw.warpAmount, DEFAULT_WAVETABLE_PARAMETERS.warpAmount), 0, 1),
    unisonVoices: Math.round(
      clamp(
        finiteOr(raw.unisonVoices, DEFAULT_WAVETABLE_PARAMETERS.unisonVoices),
        1,
        WAVETABLE_MAX_UNISON_VOICES,
      ),
    ),
    unisonDetuneCents: clamp(
      finiteOr(detuneSource, DEFAULT_WAVETABLE_PARAMETERS.unisonDetuneCents),
      0,
      WAVETABLE_MAX_UNISON_DETUNE_CENTS,
    ),
    unisonSpread: clamp(finiteOr(raw.unisonSpread, DEFAULT_WAVETABLE_PARAMETERS.unisonSpread), 0, 1),
  };
};

/** Resolves a channel's (possibly absent) wavetable settings to safe parameters. */
export const resolveWavetableParameters = (input: unknown): WavetableParameters =>
  normalizeWavetableParameters(input);

type HarmonicSpec = ReadonlyArray<readonly [number, number]>;

const range = (count: number): number[] => Array.from({ length: count }, (_, index) => index);

/**
 * Phase-aligned frame definitions: every frame is a sum of sine partials
 * (`amp · sin(2π·n·x)`), so frame 0 = sine, and the saw/square frames are
 * their classic Fourier series. Perceptual brightness is balanced by
 * peak-normalising each frame once, lazily.
 */
const FRAME_SPECS: readonly HarmonicSpec[] = [
  // 0 — sine
  [[1, 1]],
  // 1 — triangle: Σ (-1)^(k+1) sin((2k-1)x)/(2k-1)²
  range(16).map((i) => [2 * i + 1, (i % 2 === 0 ? 1 : -1) / Math.pow(2 * i + 1, 2)]),
  // 2 — saw: Σ sin(nx)/n
  range(48).map((i) => [i + 1, 1 / (i + 1)]),
  // 3 — square: Σ_odd sin(nx)/n
  range(24).map((i) => [2 * i + 1, 1 / (2 * i + 1)]),
  // 4 — hollow/formant: odd partials with a bump around H9–H15
  [
    [1, 0.6], [3, 0.5], [5, 0.45], [7, 0.4], [9, 0.3], [11, 0.22],
    [13, 0.16], [15, 0.12], [17, 0.09], [19, 0.07], [23, 0.05],
  ],
  // 5 — metallic: dense low and high partials
  [
    [1, 0.7], [2, 0.35], [3, 0.5], [4, 0.55], [5, 0.2], [6, 0.45],
    [7, 0.5], [8, 0.3], [9, 0.25], [10, 0.35], [11, 0.4], [12, 0.2],
    [13, 0.3], [14, 0.25], [15, 0.2], [17, 0.15], [19, 0.12], [23, 0.1],
  ],
];

const evaluateSeries = (
  amplitudes: Float64Array,
  phase: number,
  harmonicLimit: number = WAVETABLE_HARMONIC_LIMIT,
): number => {
  let sum = 0;
  for (let n = 1; n <= harmonicLimit; n++) {
    const amp = amplitudes[n];
    if (amp !== 0) sum += amp * Math.sin(TAU * n * phase);
  }
  return sum;
};

/** Peak-normalised amplitude vectors for the six frames (computed once). */
let normalizedFrameAmplitudes: Float64Array[] | null = null;

const getFrameAmplitudes = (): Float64Array[] => {
  if (normalizedFrameAmplitudes) return normalizedFrameAmplitudes;
  normalizedFrameAmplitudes = FRAME_SPECS.map((spec) => {
    const amplitudes = new Float64Array(WAVETABLE_HARMONIC_LIMIT + 1);
    for (const [harmonic, amp] of spec) {
      if (harmonic >= 1 && harmonic <= WAVETABLE_HARMONIC_LIMIT) amplitudes[harmonic] += amp;
    }
    const probeCount = 512;
    let peak = 0;
    for (let i = 0; i < probeCount; i++) {
      peak = Math.max(peak, Math.abs(evaluateSeries(amplitudes, i / probeCount)));
    }
    const scale = peak > 1e-9 ? 1 / peak : 0;
    for (let n = 1; n <= WAVETABLE_HARMONIC_LIMIT; n++) amplitudes[n] *= scale;
    return amplitudes;
  });
  return normalizedFrameAmplitudes;
};

/** Harmonic amplitudes of the frame table at a morph position (before warp). */
export const morphFrameAmplitudes = (morph: number): Float64Array => {
  const frames = getFrameAmplitudes();
  const position = clamp(morph, 0, 1) * (WAVETABLE_FRAME_COUNT - 1);
  const lower = Math.min(Math.floor(position), WAVETABLE_FRAME_COUNT - 1);
  const upper = Math.min(lower + 1, WAVETABLE_FRAME_COUNT - 1);
  const frac = position - lower;
  const out = new Float64Array(WAVETABLE_HARMONIC_LIMIT + 1);
  const a = frames[lower];
  const b = frames[upper];
  for (let n = 1; n <= WAVETABLE_HARMONIC_LIMIT; n++) {
    out[n] = a[n] * (1 - frac) + b[n] * frac;
  }
  return out;
};

/** The continuous (untruncated) cycle the warp modes read from. */
const warpSource = (amplitudes: Float64Array, params: WavetableParameters) => {
  const amount = clamp(params.warpAmount, 0, 1);
  const mode: WavetableWarpMode = params.warpMode;

  if (mode === 'pwm') {
    const duty = 0.5 - amount * 0.45;
    return (x: number) =>
      evaluateSeries(amplitudes, x) - evaluateSeries(amplitudes, x - duty + 1);
  }
  if (mode === 'bend') {
    const exponent = 1 + amount * 2;
    return (x: number) => evaluateSeries(amplitudes, Math.pow(x, exponent));
  }
  if (mode === 'sync') {
    const ratio = 1 + amount * 3;
    return (x: number) => evaluateSeries(amplitudes, (x * ratio) % 1);
  }
  return (x: number) => evaluateSeries(amplitudes, x);
};

export interface WavetableShape {
  /** One peak-normalised, DC-free cycle. This is what the UI draws. */
  readonly samples: Float32Array;
  /** Real coefficients for `createPeriodicWave` (index 0 = DC = 0). */
  readonly real: Float32Array;
  /** Imaginary coefficients for `createPeriodicWave` (index 0 = DC = 0). */
  readonly imag: Float32Array;
  /** Peak of the cycle before normalisation (0 when the table is silent). */
  readonly preNormalizationPeak: number;
}

/**
 * Builds the single-cycle table, band-limits it and returns both the samples
 * and the oscillator coefficients. Pure and deterministic: same parameters in,
 * identical samples out.
 */
export const buildWavetableShape = (
  input: unknown,
  sampleCount: number = WAVETABLE_SAMPLE_COUNT,
  harmonicLimit: number = WAVETABLE_HARMONIC_LIMIT,
): WavetableShape => {
  const params = normalizeWavetableParameters(input);
  const count = Number.isFinite(sampleCount) && sampleCount >= 16
    ? Math.floor(sampleCount)
    : WAVETABLE_SAMPLE_COUNT;
  const amplitudes = morphFrameAmplitudes(params.morph);
  const waveAt = warpSource(amplitudes, params);

  const raw = new Float64Array(count);
  for (let i = 0; i < count; i++) raw[i] = waveAt(i / count);

  const requestedLimit = Number.isFinite(harmonicLimit) ? Math.floor(harmonicLimit) : WAVETABLE_HARMONIC_LIMIT;
  const limit = Math.max(
    1,
    Math.min(WAVETABLE_HARMONIC_LIMIT, requestedLimit, Math.floor(count / 2) - 1),
  );
  const real = new Float64Array(limit + 1);
  const imag = new Float64Array(limit + 1);
  const scale = 2 / count;
  for (let n = 1; n <= limit; n++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < count; i++) {
      const angle = (TAU * n * i) / count;
      re += raw[i] * Math.cos(angle);
      im += raw[i] * Math.sin(angle);
    }
    real[n] = re * scale;
    imag[n] = im * scale;
  }

  // Harmonic gain (partials 1–8) is a real spectral shape control.
  const shaped = new Float64Array(limit + 1);
  for (let n = 1; n <= limit; n++) {
    const gain = n <= WAVETABLE_HARMONIC_CONTROLS ? params.harmonics[n - 1] : 1;
    shaped[n] = Number.isFinite(gain) ? gain : 1;
    real[n] *= shaped[n];
    imag[n] *= shaped[n];
  }

  const samples = new Float32Array(count);
  let peak = 0;
  for (let i = 0; i < count; i++) {
    let value = 0;
    for (let n = 1; n <= limit; n++) {
      const angle = (TAU * n * i) / count;
      value += real[n] * Math.cos(angle) + imag[n] * Math.sin(angle);
    }
    samples[i] = value;
    peak = Math.max(peak, Math.abs(value));
  }

  if (peak > 1e-9) {
    const normalize = 1 / peak;
    for (let i = 0; i < count; i++) samples[i] *= normalize;
    for (let n = 1; n <= limit; n++) {
      real[n] *= normalize;
      imag[n] *= normalize;
    }
  } else {
    samples.fill(0);
    real.fill(0);
    imag.fill(0);
  }

  return {
    samples,
    real: Float32Array.from(real),
    imag: Float32Array.from(imag),
    preNormalizationPeak: peak,
  };
};

/** Convenience: the peak-normalised cycle only. */
export const buildWavetableSamples = (
  input: unknown,
  sampleCount: number = WAVETABLE_SAMPLE_COUNT,
  harmonicLimit: number = WAVETABLE_HARMONIC_LIMIT,
): Float32Array => buildWavetableShape(input, sampleCount, harmonicLimit).samples;

const shapeCache = new Map<string, WavetableShape>();
const SHAPE_CACHE_LIMIT = 48;

/**
 * Deterministic cache key for the generated table. Morph/warp are quantised to
 * 1/2000 so a slider drag reuses one table per practical step.
 */
export const wavetableCacheKey = (params: WavetableParameters, sampleCount: number): string => {
  const harmonics = params.harmonics.map((value) => value.toFixed(3)).join(',');
  return [
    sampleCount,
    params.morph.toFixed(4),
    params.warpMode,
    params.warpAmount.toFixed(4),
    harmonics,
  ].join('|');
};

/**
 * Cached table for the render path. Bounded to `SHAPE_CACHE_LIMIT` entries so
 * a long editing session cannot grow the cache without limit.
 */
export const getCachedWavetableShape = (
  input: unknown,
  sampleCount: number = WAVETABLE_SAMPLE_COUNT,
): WavetableShape => {
  const params = normalizeWavetableParameters(input);
  const key = wavetableCacheKey(params, sampleCount);
  const cached = shapeCache.get(key);
  if (cached) return cached;
  const shape = buildWavetableShape(params, sampleCount);
  if (shapeCache.size >= SHAPE_CACHE_LIMIT) {
    const oldest = shapeCache.keys().next();
    if (!oldest.done) shapeCache.delete(oldest.value);
  }
  shapeCache.set(key, shape);
  return shape;
};

export const clearWavetableShapeCache = (): void => {
  shapeCache.clear();
};

/** Frame position (0 … 15) the UI reports for a morph value. */
export const wavetableFramePosition = (morph: number, frames: number = 16): number => {
  const safeFrames = Math.max(1, Math.floor(frames));
  const position = clamp(morph, 0, 1) * (safeFrames - 1);
  return Math.round(position);
};
