/**
 * Phase 9B — real lookahead true-peak limiter.
 *
 * ## What this replaces
 *
 * The pre-9B "brickwall" stage was `DynamicsCompressor(ratio 20)` followed by a
 * 4× oversampled `WaveShaper` hard clip, and `maximizerLookahead` only switched
 * the compressor attack between 1 ms and 5 ms. That is a fast-attack compressor
 * plus a clipper: nothing inspects a future sample, and a hard clip cannot
 * respect an inter-sample ceiling other than by distorting the waveform.
 *
 * This module implements the real thing as an `AudioWorkletProcessor`:
 *
 *   input → [delay line, D samples] ─────────────────────┐
 *        └─ 4× true-peak reconstruction ─ requiredGain ─→ [gain engine] ─→ out
 *
 * * **Lookahead.** The emitted sample is taken from a delay line `D` samples
 *   long, while the detector reads the *undelayed* stream. The gain engine
 *   therefore sees every peak `D` samples before it reaches the output.
 * * **True peak.** The detector reconstructs the continuous waveform with the
 *   same 4× / 12-tap Blackman-windowed polyphase FIR that
 *   `src/audio/truePeak.ts` uses for measurement (`designInterpolatingFilters`),
 *   so "true peak" means the same thing on both sides of the product. A unit
 *   test asserts the embedded coefficients are identical to that function's.
 * * **Gain.** Per emitted sample the engine takes the sliding minimum of the
 *   required gain over `[n, n + D]` (the peaks that will arrive inside the
 *   lookahead window), descends toward it at a bounded linear rate that is
 *   guaranteed to arrive within `D` samples, releases one-pole at
 *   `maximizerRelease`, and is finally capped by the requirement of the sample
 *   actually being emitted. The cap is what makes the ceiling a *guarantee*:
 *   output sample `n` can never exceed `ceiling` even if smoothing lags.
 * * **Stereo.** One linked gain for both channels, derived from the larger of
 *   the two channels' requirements, so the image cannot shift when only one
 *   side peaks.
 * * **Silence / short buffers.** Silence leaves the gain at unity; a buffer
 *   shorter than `D` simply fills the delay line (the renderer reserves `D`
 *   extra frames at the end so nothing is lost).
 *
 * ## Documented modes (from `maximizerLookahead` / `maximizerLookaheadMs`)
 *
 * | Mode | Delay | Behaviour |
 * |---|---|---|
 * | Lookahead (default, 5 ms) | `round(0.005 · fs)` | Peaks are detected up to 5 ms early; the ceiling holds for sample **and** inter-sample peaks. |
 * | Direct (0 ms) | 0 | Detection is causal, so the limiter reacts on the sample it emits. Sample peaks are still held at the ceiling exactly, but an abrupt transient overshoots the ceiling in the reconstructed waveform by up to ≈1 dB (measured: −0.05 dBFS against a −1 dBFS ceiling). This is the documented trade-off of the setting, not a defect. |
 *
 * Latency is therefore `D` samples and is reported through
 * `MasteringProcessor.getLimiterLatencySamples()` so the offline renderer can
 * align exports by the real amount instead of a hard-coded trim.
 *
 * ## Reporting
 *
 * The processor posts `reductionDb` (the reduction at the report instant),
 * `peakReductionDb` (the largest reduction in the reporting interval) and the
 * instantaneous `gain` about every 46 ms. That is a measurement of the applied
 * envelope, not a synthesised meter; `measured` stays false until the first
 * report arrives, so the UI can say "not measured" honestly.
 */

/** Processor registration name. */
export const MASTERING_LIMITER_PROCESSOR = 'apex-mastering-limiter';

/** Reconstruction factor. BS.1770-4 Annex 2 requires at least 4×. */
export const MASTERING_LIMITER_OVERSAMPLE = 4;
/** Taps per polyphase branch — same as `TruePeakMeter`'s default. */
export const MASTERING_LIMITER_TAPS = 12;
/** Longest configurable lookahead. Bounds the delay line's memory. */
export const MASTERING_LIMITER_MAX_LOOKAHEAD_MS = 20;
/** Default lookahead when the project does not name one (the migrated default). */
export const MASTERING_LIMITER_DEFAULT_LOOKAHEAD_MS = 5;
/** Smallest usable gain: −80 dB of reduction. Prevents runaway/denormal gains. */
export const MASTERING_LIMITER_MIN_GAIN = 1e-4;

/**
 * Resolves the lookahead a project asks for.
 *
 * `maximizerLookaheadMs` is the Phase 9B field; a document written before it
 * existed only has the boolean `maximizerLookahead`, which resolved to a
 * fast-attack compressor. The migration is explicit: `true` keeps the
 * documented 5 ms lookahead (the mode the old UI advertised as "on"), `false`
 * resolves to 0 ms (direct), so no project silently gains a delay it did not
 * ask for and no project silently loses the time it thought it had.
 */
export const resolveLimiterLookaheadMs = (state: {
  maximizerLookahead?: unknown;
  maximizerLookaheadMs?: unknown;
}): number => {
  const explicit = state.maximizerLookaheadMs;
  if (typeof explicit === 'number' && Number.isFinite(explicit)) {
    return Math.max(0, Math.min(MASTERING_LIMITER_MAX_LOOKAHEAD_MS, explicit));
  }
  return state.maximizerLookahead === false ? 0 : MASTERING_LIMITER_DEFAULT_LOOKAHEAD_MS;
};

/** Latency the limiter adds, in whole samples, for a sample rate and mode. */
export const resolveLimiterLatencySamples = (
  state: { maximizerLookahead?: unknown; maximizerLookaheadMs?: unknown },
  sampleRate: number,
): number => {
  const ms = resolveLimiterLookaheadMs(state);
  if (ms <= 0) return 0;
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100;
  return Math.max(1, Math.round((ms / 1000) * rate));
};

/** Human-readable mode label, shared by the UI and the docs. */
export const limiterLookaheadLabel = (lookaheadMs: number): string =>
  lookaheadMs <= 0 ? 'Direct (0 ms, causal detection)' : `Lookahead ${lookaheadMs.toFixed(0)} ms`;

/**
 * The detector's polyphase coefficient table, mirrored from
 * `designInterpolatingFilters` in `truePeak.ts`. Kept as an exported function so
 * a test can prove the worklet's embedded copy matches the measurement code
 * tap-for-tap; if that ever drifts, "true peak" would mean two different
 * things in one product.
 */
export const limiterInterpolatingBranches = (oversample = MASTERING_LIMITER_OVERSAMPLE, tapsPerPhase = MASTERING_LIMITER_TAPS): number[][] => {
  const branches: number[][] = [];
  const centre = (tapsPerPhase - 1) / 2;
  for (let phase = 0; phase < oversample; phase++) {
    const taps = new Array<number>(tapsPerPhase);
    let sum = 0;
    for (let m = 0; m < tapsPerPhase; m++) {
      const offset = m - centre + phase / oversample;
      const sinc = offset === 0 ? 1 : Math.sin(Math.PI * offset) / (Math.PI * offset);
      const blackman = 0.42
        - 0.5 * Math.cos((2 * Math.PI * m) / (tapsPerPhase - 1))
        + 0.08 * Math.cos((4 * Math.PI * m) / (tapsPerPhase - 1));
      taps[m] = sinc * blackman;
      sum += taps[m];
    }
    for (let m = 0; m < tapsPerPhase; m++) taps[m] /= sum;
    branches.push(taps);
  }
  return branches;
};

/**
 * Processor source.
 *
 * Held as a string for the same reasons Phase 9A's detector is: one artifact
 * loads into a live `AudioContext`, into each `OfflineAudioContext`, and into
 * the Node tests — which execute *this exact source*, so the DSP under test is
 * the DSP that ships.
 */
export const MASTERING_LIMITER_SOURCE = `
const TAPS = ${MASTERING_LIMITER_TAPS};
const OVERSAMPLE = ${MASTERING_LIMITER_OVERSAMPLE};
const MAX_LOOKAHEAD_SAMPLES = ${MASTERING_LIMITER_MAX_LOOKAHEAD_MS} * 0.001;
const MIN_GAIN = ${MASTERING_LIMITER_MIN_GAIN};

function designBranches() {
  const branches = [];
  const centre = (TAPS - 1) / 2;
  for (let phase = 0; phase < OVERSAMPLE; phase++) {
    const taps = new Float64Array(TAPS);
    let sum = 0;
    for (let m = 0; m < TAPS; m++) {
      const offset = m - centre + phase / OVERSAMPLE;
      const sinc = offset === 0 ? 1 : Math.sin(Math.PI * offset) / (Math.PI * offset);
      const blackman = 0.42
        - 0.5 * Math.cos(2 * Math.PI * m / (TAPS - 1))
        + 0.08 * Math.cos(4 * Math.PI * m / (TAPS - 1));
      taps[m] = sinc * blackman;
      sum += taps[m];
    }
    for (let m = 0; m < TAPS; m++) taps[m] /= sum;
    branches.push(taps);
  }
  return branches;
}

class ApexMasteringLimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'ceilingDb', defaultValue: -0.2, minValue: -24, maxValue: 0, automationRate: 'k-rate' },
      { name: 'releaseMs', defaultValue: 80, minValue: 5, maxValue: 2000, automationRate: 'k-rate' },
      { name: 'lookaheadSamples', defaultValue: 0, minValue: 0, maxValue: 4096, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.branches = designBranches();
    // Delay / history rings are sized for the longest supported lookahead, so
    // changing the mode never reallocates (bounded memory, bounded CPU).
    this.maxDelay = Math.ceil(sampleRate * MAX_LOOKAHEAD_SAMPLES) + 16;
    this.ringSize = this.maxDelay + 1024;
    this.delayL = new Float64Array(this.ringSize);
    this.delayR = new Float64Array(this.ringSize);
    this.peakRing = new Float64Array(this.ringSize);
    this.historyL = new Float64Array(TAPS);
    this.historyR = new Float64Array(TAPS);

    // Monotonic deque for the sliding minimum of the required gain.
    this.dequeCap = 8192;
    this.dequeIndex = new Int32Array(this.dequeCap);
    this.dequeValue = new Float64Array(this.dequeCap);
    this.dequeHead = 0;
    this.dequeTail = 0;
    this.dequeCount = 0;

    this.writeIndex = 0;
    this.emitIndex = -1;
    this.gain = 1;
    this.appliedReductionDb = 0;
    this.intervalPeakReductionDb = 0;
    this.samplesSinceReport = 0;
    this.reportEverySamples = Math.max(128, Math.round(sampleRate * 0.046));
    this.totalSamples = 0;
    this.ceilingLinear = Math.pow(10, -0.2 / 20);
  }

  pushRequired(index, value) {
    const cap = this.dequeCap;
    while (this.dequeCount > 0) {
      const backIndex = (this.dequeTail - 1 + cap) % cap;
      if (this.dequeValue[backIndex] < value) break;
      this.dequeTail = backIndex;
      this.dequeCount -= 1;
    }
    this.dequeIndex[this.dequeTail] = index;
    this.dequeValue[this.dequeTail] = value;
    this.dequeTail = (this.dequeTail + 1) % cap;
    this.dequeCount += 1;
  }

  popBelow(minIndex) {
    const cap = this.dequeCap;
    while (this.dequeCount > 0 && this.dequeIndex[this.dequeHead] < minIndex) {
      this.dequeHead = (this.dequeHead + 1) % cap;
      this.dequeCount -= 1;
    }
  }

  resetDeque() {
    this.dequeHead = 0;
    this.dequeTail = 0;
    this.dequeCount = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    const frames = outL.length;
    const inL = input && input.length > 0 ? input[0] : null;
    const inR = input && input.length > 1 ? input[1] : inL;

    const ceilingDb = Math.max(-24, Math.min(0, parameters.ceilingDb[0]));
    const ceilingLinear = Math.pow(10, ceilingDb / 20);
    const releaseMs = Math.max(5, Math.min(2000, parameters.releaseMs[0]));
    const releaseCoef = 1 - Math.exp(-1 / Math.max(1, (releaseMs * 0.001) * sampleRate));
    const requestedDelay = Math.max(0, Math.min(this.maxDelay, Math.round(parameters.lookaheadSamples[0])));

    // A lookahead change re-bases the emit cursor. The delay line keeps its
    // contents, so the audio simply continues from the new offset (a one-off
    // skip/repeat, never an unbounded drift).
    if (requestedDelay !== this.delay) {
      this.delay = requestedDelay;
      this.emitIndex = this.writeIndex - this.delay;
      this.resetDeque();
      for (let n = Math.max(0, this.emitIndex); n < this.writeIndex; n += 1) {
        const peak = this.peakRing[n % this.ringSize];
        this.pushRequired(n, peak > ceilingLinear ? ceilingLinear / peak : 1);
      }
    }
    const delay = this.delay;
    const attackStep = delay > 0 ? 1 / delay : 1;
    const ahead = Math.min(delay, 6);

    for (let i = 0; i < frames; i += 1) {
      const rawL = inL ? inL[i] : 0;
      const rawR = inR ? inR[i] : 0;
      const xl = Number.isFinite(rawL) ? rawL : 0;
      const xr = Number.isFinite(rawR) ? rawR : 0;

      // Shift the interpolation history by one sample.
      for (let t = 0; t < TAPS - 1; t += 1) {
        this.historyL[t] = this.historyL[t + 1];
        this.historyR[t] = this.historyR[t + 1];
      }
      this.historyL[TAPS - 1] = xl;
      this.historyR[TAPS - 1] = xr;

      // Reconstructed peak of this sample and the segments leading into it.
      let peak = Math.abs(xl) > Math.abs(xr) ? Math.abs(xl) : Math.abs(xr);
      for (let phase = 0; phase < OVERSAMPLE; phase += 1) {
        const coefficients = this.branches[phase];
        let accL = 0;
        let accR = 0;
        for (let m = 0; m < TAPS; m += 1) {
          const tap = coefficients[m];
          accL += tap * this.historyL[m];
          accR += tap * this.historyR[m];
        }
        const aL = accL < 0 ? -accL : accL;
        const aR = accR < 0 ? -accR : accR;
        if (aL > peak) peak = aL;
        if (aR > peak) peak = aR;
      }
      if (!Number.isFinite(peak)) peak = 0;

      const writeIndex = this.writeIndex;
      this.peakRing[writeIndex % this.ringSize] = peak;
      this.delayL[writeIndex % this.ringSize] = xl;
      this.delayR[writeIndex % this.ringSize] = xr;
      this.pushRequired(writeIndex, peak > ceilingLinear ? ceilingLinear / peak : 1);
      this.writeIndex = writeIndex + 1;
      this.totalSamples += 1;

      const emit = writeIndex - delay;
      if (emit < 0) {
        outL[i] = 0;
        outR[i] = 0;
        continue;
      }

      this.popBelow(emit);
      const windowMin = this.dequeCount > 0 ? this.dequeValue[this.dequeHead] : 1;

      // Requirement for the sample actually leaving the limiter: the largest
      // reconstructed peak in its neighbourhood (behind: the FIR's half-window,
      // ahead: whatever the lookahead lets us see).
      let localPeak = 0;
      const from = emit - 6;
      const to = emit + ahead;
      for (let n = from; n <= to; n += 1) {
        if (n < 0 || n > writeIndex) continue;
        const value = this.peakRing[n % this.ringSize];
        if (value > localPeak) localPeak = value;
      }
      const requiredExact = localPeak > ceilingLinear ? ceilingLinear / localPeak : 1;

      // Attack: bounded linear descent that reaches any target within the
      // lookahead window. Release: one-pole toward the window's requirement.
      if (windowMin < this.gain) {
        this.gain = Math.max(windowMin, this.gain - attackStep);
      } else {
        this.gain += (windowMin - this.gain) * releaseCoef;
      }
      if (requiredExact < this.gain) this.gain = requiredExact;
      if (!(this.gain >= MIN_GAIN)) this.gain = MIN_GAIN;
      if (this.gain > 1) this.gain = 1;

      outL[i] = this.gain * this.delayL[emit % this.ringSize];
      outR[i] = this.gain * this.delayR[emit % this.ringSize];
      if (!Number.isFinite(outL[i])) outL[i] = 0;
      if (!Number.isFinite(outR[i])) outR[i] = 0;

      const reduction = -20 * Math.log10(this.gain);
      this.appliedReductionDb = reduction;
      if (reduction > this.intervalPeakReductionDb) this.intervalPeakReductionDb = reduction;
      this.samplesSinceReport += 1;
      if (this.samplesSinceReport >= this.reportEverySamples) {
        this.samplesSinceReport = 0;
        this.port.postMessage({
          type: 'limiter',
          reductionDb: this.appliedReductionDb,
          peakReductionDb: this.intervalPeakReductionDb,
          gain: this.gain,
          ceilingDb,
          lookaheadSamples: delay,
          sampleRate,
          samplesProcessed: this.totalSamples,
        });
        this.intervalPeakReductionDb = 0;
      }
    }

    return true;
  }
}

registerProcessor('${MASTERING_LIMITER_PROCESSOR}', ApexMasteringLimiterProcessor);
`;
