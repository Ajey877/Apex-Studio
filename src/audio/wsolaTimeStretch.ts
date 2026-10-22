/**
 * Phase 7A: the first real pitch-preserving time-stretch — WSOLA.
 *
 * WHAT THIS IS
 * A deterministic, pure-signal implementation of WSOLA (Waveform Similarity
 * Overlap-Add, Verhelst & Roelands 1990): the classic time-domain algorithm
 * that changes DURATION while preserving the local periodicity of the signal,
 * so the dominant pitch of tonal material stays put. It works on plain
 * Float32Array channel data (plus a thin AudioBuffer wrapper), so it is fully
 * testable in Node against real PCM with zero Web Audio mocks.
 *
 * HOW IT WORKS
 * - The output is synthesized frame by frame with a FIXED synthesis hop
 *   (50 % overlap) and a Hann window whose halves sum to 1, so overlap-added
 *   frames reconstruct amplitude without normalization.
 * - The input (analysis) position advances by hop / ratio per frame. Around
 *   each nominal analysis position, a similarity search picks the integer
 *   offset whose first half-frame best matches (by summed cross-correlation)
 *   the windowed tail of the previously synthesized frame. Tracking waveform
 *   similarity instead of copying blindly is what keeps phase continuity —
 *   and therefore pitch — intact.
 * - MULTI-CHANNEL: the similarity score is summed across ALL channels, so one
 *   shared offset is applied per frame. Channel alignment (stereo image,
 *   inter-channel delay) is preserved by construction — channels can never
 *   drift apart.
 *
 * SUPPORTED RANGE AND HONEST LIMITATIONS
 * - Ratio bounds: 0.25× … 4.0× (WSOLA_MIN_RATIO / WSOLA_MAX_RATIO). Outside
 *   that range the call throws a typed error; nothing is rendered.
 * - Best quality sits roughly in 0.5×–2.0× on tonal/quasi-periodic material.
 *   At extreme ratios and on transient-heavy material (drums), time-domain
 *   OLA smears transients and can produce mild doubling/echo artifacts. This
 *   is inherent to WSOLA-class algorithms; no transient-preservation or
 *   formant processing is performed or claimed.
 * - The first and last half-frame of the output carry a short Hann fade
 *   (~11.6 ms at 44.1 kHz) because edge samples receive only one windowed
 *   contribution. This is standard OLA edge behavior and click-free.
 * - Silence in stays silence out (all similarity scores tie at zero and the
 *   deterministic first-candidate rule wins), and output length is exactly
 *   ceil(inputLength × ratio) for every ratio.
 * - Inputs shorter than one analysis frame are zero-padded to a working
 *   length; the result is the stretched content followed by silence rather
 *   than garbage.
 * - Fully deterministic: no randomness, no time-varying state — identical
 *   input produces bit-identical output on every run.
 */

/** Minimum supported stretch ratio (output duration / input duration). */
export const WSOLA_MIN_RATIO = 0.25;
/** Maximum supported stretch ratio (output duration / input duration). */
export const WSOLA_MAX_RATIO = 4.0;
/** Analysis/synthesis frame in samples (~23 ms at 44.1 kHz). */
export const WSOLA_FRAME_SIZE = 1024;
/** Fixed output hop: 50 % overlap with the Hann window (w[n] + w[n+H] = 1). */
export const WSOLA_SYNTHESIS_HOP = WSOLA_FRAME_SIZE / 2;
/** Similarity search radius in input samples around the nominal position. */
export const WSOLA_SEARCH_DELTA = WSOLA_FRAME_SIZE / 4;
/** Decimation used ONLY for similarity scoring (OLA itself uses every sample). */
export const WSOLA_SCORE_STRIDE = 2;

export type WsolaStretchFailure =
  | 'invalid-ratio'
  | 'unsupported-ratio'
  | 'empty-buffer'
  | 'invalid-buffer';

/** Typed failure so callers report honest, specific messages instead of guessing. */
export class WsolaTimeStretchError extends Error {
  public readonly failure: WsolaStretchFailure;
  constructor(failure: WsolaStretchFailure, message: string) {
    super(message);
    this.name = 'WsolaTimeStretchError';
    this.failure = failure;
  }
}

export interface WsolaStretchResult {
  /** One processed Float32Array per input channel, all exactly `length` frames. */
  channels: Float32Array[];
  /** Exact output length in frames: ceil(inputLength × ratio). */
  length: number;
}

/** Periodic Hann window: with a 50 % hop the overlapping halves sum to 1. */
const buildHannWindow = (size: number): Float32Array => {
  const window = new Float32Array(size);
  for (let n = 0; n < size; n += 1) {
    window[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / size);
  }
  return window;
};

const assertSupportedRatio = (ratio: number): void => {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
    throw new WsolaTimeStretchError('invalid-ratio', `Stretch ratio must be a finite number, got: ${String(ratio)}.`);
  }
  if (ratio < WSOLA_MIN_RATIO || ratio > WSOLA_MAX_RATIO) {
    throw new WsolaTimeStretchError(
      'unsupported-ratio',
      `WSOLA stretch supports ratios from ${WSOLA_MIN_RATIO}× to ${WSOLA_MAX_RATIO}× — ${ratio}× is outside that range.`
    );
  }
};

/**
 * Stretches raw interleaved-free channel data by `ratio` with pitch preserved
 * (see the module docs for the honest tolerance/quality envelope). Never
 * mutates the input arrays.
 */
export const wsolaStretchChannels = (
  channels: readonly Float32Array[],
  ratio: number
): WsolaStretchResult => {
  assertSupportedRatio(ratio);
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new WsolaTimeStretchError('invalid-buffer', 'WSOLA stretch needs at least one channel of audio data.');
  }
  const inputLength = channels[0].length;
  for (const channel of channels) {
    if (!(channel instanceof Float32Array)) {
      throw new WsolaTimeStretchError('invalid-buffer', 'WSOLA stretch needs Float32Array channel data.');
    }
    if (channel.length !== inputLength) {
      throw new WsolaTimeStretchError('invalid-buffer', 'WSOLA stretch needs every channel to be the same length.');
    }
  }
  if (inputLength === 0) {
    throw new WsolaTimeStretchError('empty-buffer', 'The audio buffer is empty — nothing to stretch.');
  }

  const outputLength = Math.ceil(inputLength * ratio);
  // ratio 1 is the documented identity: hand back exact copies, unprocessed.
  if (ratio === 1) {
    return { channels: channels.map(channel => Float32Array.from(channel)), length: inputLength };
  }

  const frameSize = WSOLA_FRAME_SIZE;
  const synthesisHop = WSOLA_SYNTHESIS_HOP;
  const searchDelta = WSOLA_SEARCH_DELTA;
  const scoreStride = WSOLA_SCORE_STRIDE;
  const halfFrame = synthesisHop;

  // Working copies with a deterministic zero tail so candidate windows near
  // the end (and short inputs) read zeros instead of falling off the array.
  const paddedLength = inputLength + frameSize + searchDelta;
  const channelCount = channels.length;
  const padded: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch += 1) {
    const copy = new Float32Array(paddedLength);
    copy.set(channels[ch], 0);
    padded.push(copy);
  }

  const window = buildHannWindow(frameSize);
  const output: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch += 1) output.push(new Float32Array(outputLength));

  // Per-channel windowed tail of the previously added frame: the correlation
  // target that makes the search lock onto waveform-similar positions.
  const tails: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch += 1) tails.push(new Float32Array(halfFrame));

  const analysisHop = synthesisHop / ratio;
  const maxCandidateStart = paddedLength - frameSize;
  const scoreTaps = Math.ceil(halfFrame / scoreStride);

  for (let outPos = 0, k = 0; outPos < outputLength; outPos += synthesisHop, k += 1) {
    const nominal = Math.round(k * analysisHop);
    const lo = Math.max(0, nominal - searchDelta);
    const hi = Math.max(lo, Math.min(maxCandidateStart, nominal + searchDelta));

    // Deterministic similarity search; ties keep the earliest candidate.
    let best = lo;
    let bestScore = -Infinity;
    for (let candidate = lo; candidate <= hi; candidate += 1) {
      let score = 0;
      for (let ch = 0; ch < channelCount; ch += 1) {
        const data = padded[ch];
        const tail = tails[ch];
        for (let t = 0; t < scoreTaps; t += 1) {
          const i = t * scoreStride;
          score += data[candidate + i] * tail[i];
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
    }

    // Overlap-add the windowed frame and capture its windowed tail as the
    // next correlation target.
    const writeFrames = Math.min(frameSize, outputLength - outPos);
    for (let ch = 0; ch < channelCount; ch += 1) {
      const data = padded[ch];
      const out = output[ch];
      for (let i = 0; i < writeFrames; i += 1) {
        out[outPos + i] += data[best + i] * window[i];
      }
    }
    for (let ch = 0; ch < channelCount; ch += 1) {
      const data = padded[ch];
      const tail = tails[ch];
      for (let i = 0; i < halfFrame; i += 1) {
        tail[i] = data[best + halfFrame + i] * window[halfFrame + i];
      }
    }
  }

  return { channels: output, length: outputLength };
};

/** AudioBuffer-shaped inputs/outputs; the buffer factory is injected so tests
 *  and every audio backend stay interchangeable (same seam as
 *  `trimAudioBufferToSeconds`). The source buffer is never mutated. */
export const wsolaStretchAudioBuffer = (
  buffer: AudioBuffer,
  ratio: number,
  createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => AudioBuffer
): AudioBuffer => {
  assertSupportedRatio(ratio);
  if (!buffer || typeof buffer.getChannelData !== 'function' || typeof buffer.numberOfChannels !== 'number') {
    throw new WsolaTimeStretchError('invalid-buffer', 'WSOLA stretch needs a real AudioBuffer source.');
  }
  if (!(buffer.sampleRate > 0)) {
    throw new WsolaTimeStretchError('invalid-buffer', `The source buffer has an unusable sample rate (${String(buffer.sampleRate)}).`);
  }
  if (buffer.numberOfChannels < 1) {
    throw new WsolaTimeStretchError('invalid-buffer', 'The source buffer has no channels to stretch.');
  }
  if (buffer.length === 0) {
    throw new WsolaTimeStretchError('empty-buffer', 'The audio buffer is empty — nothing to stretch.');
  }

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) channels.push(buffer.getChannelData(ch));

  const stretched = wsolaStretchChannels(channels, ratio);
  const output = createBuffer(buffer.numberOfChannels, stretched.length, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    output.getChannelData(ch).set(stretched.channels[ch]);
  }
  return output;
};

/**
 * Normalized peak waveform for a stretched buffer, matching the 64-peak
 * convention `audioEngine.loadAudioFile` established for clip rendering.
 * Real peaks from the processed PCM — never fabricated.
 */
export const computeStretchWaveformPeaks = (channels: readonly Float32Array[], peakCount = 64): number[] => {
  if (channels.length === 0 || channels[0].length === 0) return [];
  const data = channels[0];
  const blockSize = Math.floor(data.length / peakCount);
  const peaks: number[] = [];
  for (let i = 0; i < peakCount; i += 1) {
    let max = 0;
    const from = i * blockSize;
    const to = Math.min(data.length, from + Math.max(1, blockSize));
    for (let j = from; j < to; j += 1) {
      const value = Math.abs(data[j] || 0);
      if (value > max) max = value;
    }
    peaks.push(Math.min(1, max));
  }
  return peaks;
};
