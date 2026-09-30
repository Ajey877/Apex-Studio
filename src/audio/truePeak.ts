/**
 * Inter-sample true-peak measurement (BS.1770-4 Annex 2 style).
 *
 * A sample-peak reading is *not* a true-peak reading: an arbitrary waveform
 * can overshoot by up to +3.01 dB between two samples of a full-scale signal
 * at fs/4, and up to +6 dB is reachable for pathological reconstructions. The
 * only honest way to display "TRUE PEAK" is to reconstruct the continuous
 * waveform, which is what this module does: 4x (or higher) band-limited
 * interpolation through a zero-phase polyphase FIR, tracking the maximum
 * absolute value of the reconstructed signal.
 *
 * Pure and deterministic: fixed windowed-sinc coefficients designed from the
 * oversampling factor and tap count, no AudioContext, no `Date.now()`, no
 * randomness, so the same input always yields the same peak.
 *
 * Peaks are reported per channel and are maxima *since the last reset*, which
 * is the semantics a master meter needs for a loudness/peak pass over a take.
 */

export interface TruePeakOptions {
  /** Interpolation factor; >= 4 is what BS.1770-4 Annex 2 requires. */
  oversample?: number;
  /** Taps per polyphase branch. 12 keeps the reconstruction error well below 0.1 dB. */
  tapsPerPhase?: number;
}

export interface TruePeakReading {
  /** Reconstructed inter-sample peak, dBFS, or null when nothing was measured. */
  leftDbfs: number | null;
  rightDbfs: number | null;
  /** The value a master meter should display as TRUE PEAK. */
  truePeakDbfs: number | null;
  /** Largest raw sample magnitude, kept separate so it cannot be confused with true peak. */
  samplePeakLeftDbfs: number | null;
  samplePeakRightDbfs: number | null;
  samplePeakDbfs: number | null;
  /** Oversample factor actually in use, so the UI can label the method truthfully. */
  oversample: number;
}

/**
 * Blackman-windowed sinc, evaluated at the fractional offsets implied by
 * `oversample` and truncated to `tapsPerPhase` taps, normalised to unity DC
 * gain per branch. Deterministic and rate independent: interpolation between
 * samples does not depend on how fast the samples arrive.
 */
export function designInterpolatingFilters(oversample: number, tapsPerPhase: number): number[][] {
  if (!Number.isInteger(oversample) || oversample < 2) {
    throw new RangeError(`designInterpolatingFilters: oversample must be an integer >= 2 (got ${oversample})`);
  }
  if (!Number.isInteger(tapsPerPhase) || tapsPerPhase < 4) {
    throw new RangeError(`designInterpolatingFilters: tapsPerPhase must be an integer >= 4 (got ${tapsPerPhase})`);
  }

  const branches: number[][] = [];
  const centre = (tapsPerPhase - 1) / 2;
  for (let phase = 0; phase < oversample; phase++) {
    const taps = new Array<number>(tapsPerPhase);
    let sum = 0;
    for (let m = 0; m < tapsPerPhase; m++) {
      const offset = m - centre + phase / oversample;
      // sinc(x) = sin(pi x) / (pi x), with sinc(0) = 1.
      const sinc = offset === 0
        ? 1
        : Math.sin(Math.PI * offset) / (Math.PI * offset);
      const blackman = 0.42
        - 0.5 * Math.cos(2 * Math.PI * m / (tapsPerPhase - 1))
        + 0.08 * Math.cos(4 * Math.PI * m / (tapsPerPhase - 1));
      taps[m] = sinc * blackman;
      sum += taps[m];
    }
    // Unity gain at DC, so a constant signal is reproduced exactly.
    for (let m = 0; m < tapsPerPhase; m++) taps[m] /= sum;
    branches.push(taps);
  }
  return branches;
}

function toDbfs(peak: number): number | null {
  // A peak of exactly zero means the channel never produced a sample above
  // digital silence: report "not measured" rather than -100 dBFS.
  if (!(peak > 0) || !Number.isFinite(peak)) return null;
  return Math.round(20 * Math.log10(Math.min(peak, 1e6)) * 100) / 100;
}

/** One-shot helper for offline buffers (used by tests and future export QA). */
export function measureTruePeak(
  left: Float32Array | Float64Array,
  right: Float32Array | Float64Array | null,
  options: TruePeakOptions = {},
): number {
  const meter = new TruePeakMeter(options);
  const length = left.length;
  const chunk = 512;
  for (let start = 0; start < length; start += chunk) {
    const end = Math.min(start + chunk, length);
    const l = left.subarray(start, end);
    const r = right ? right.subarray(start, end) : l;
    meter.pushFrame(l, r);
  }
  const reading = meter.getReading();
  return reading.truePeakDbfs ?? Number.NEGATIVE_INFINITY;
}

/**
 * Streaming true-peak meter.
 *
 * `pushFrame` may be called with any frame count; a history of the previous
 * taps is carried over so block boundaries cannot hide a peak.
 */
export class TruePeakMeter {
  readonly oversample: number;
  readonly tapsPerPhase: number;
  private readonly branches: number[][];

  private readonly historyL: Float64Array;
  private readonly historyR: Float64Array;
  private peakInterpolatedL = 0;
  private peakInterpolatedR = 0;
  private peakSampleL = 0;
  private peakSampleR = 0;
  private samplesMeasured = 0;

  constructor(options: TruePeakOptions = {}) {
    this.oversample = options.oversample ?? 4;
    this.tapsPerPhase = options.tapsPerPhase ?? 12;
    this.branches = designInterpolatingFilters(this.oversample, this.tapsPerPhase);
    this.historyL = new Float64Array(this.tapsPerPhase);
    this.historyR = new Float64Array(this.tapsPerPhase);
  }

  pushFrame(left: ArrayLike<number>, right: ArrayLike<number>): void {
    const length = Math.min(left.length, right.length);
    if (length === 0) return;

    const taps = this.tapsPerPhase;
    const oversample = this.oversample;
    const branches = this.branches;

    // Working window: carried history followed by the new samples, so a peak
    // straddling the boundary is reconstructed exactly as inside a single file.
    const windowL = new Float64Array(taps + length);
    const windowR = new Float64Array(taps + length);
    windowL.set(this.historyL, 0);
    windowR.set(this.historyR, 0);
    for (let i = 0; i < length; i++) {
      windowL[taps + i] = left[i];
      windowR[taps + i] = right[i];
    }

    for (let i = 0; i < length; i++) {
      const sampleIndex = taps + i;
      const l = windowL[sampleIndex];
      const r = windowR[sampleIndex];
      if (Math.abs(l) > this.peakSampleL) this.peakSampleL = Math.abs(l);
      if (Math.abs(r) > this.peakSampleR) this.peakSampleR = Math.abs(r);

      for (let phase = 0; phase < oversample; phase++) {
        const coefficients = branches[phase];
        let accL = 0;
        let accR = 0;
        for (let m = 0; m < taps; m++) {
          const tap = coefficients[m];
          const windowIndex = sampleIndex - (taps - 1) + m;
          accL += tap * windowL[windowIndex];
          accR += tap * windowR[windowIndex];
        }
        if (Math.abs(accL) > this.peakInterpolatedL) this.peakInterpolatedL = Math.abs(accL);
        if (Math.abs(accR) > this.peakInterpolatedR) this.peakInterpolatedR = Math.abs(accR);
      }
      this.samplesMeasured += 1;
    }

    this.historyL.set(windowL.subarray(taps + length - taps, taps + length), 0);
    this.historyR.set(windowR.subarray(taps + length - taps, taps + length), 0);
  }

  reset(): void {
    this.historyL.fill(0);
    this.historyR.fill(0);
    this.peakInterpolatedL = 0;
    this.peakInterpolatedR = 0;
    this.peakSampleL = 0;
    this.peakSampleR = 0;
    this.samplesMeasured = 0;
  }

  get samplesMeasuredCount(): number {
    return this.samplesMeasured;
  }

  getReading(): TruePeakReading {
    const measured = this.samplesMeasured > 0;
    if (!measured) {
      return {
        leftDbfs: null,
        rightDbfs: null,
        truePeakDbfs: null,
        samplePeakLeftDbfs: null,
        samplePeakRightDbfs: null,
        samplePeakDbfs: null,
        oversample: this.oversample,
      };
    }
    return {
      leftDbfs: toDbfs(this.peakInterpolatedL),
      rightDbfs: toDbfs(this.peakInterpolatedR),
      truePeakDbfs: toDbfs(Math.max(this.peakInterpolatedL, this.peakInterpolatedR)),
      samplePeakLeftDbfs: toDbfs(this.peakSampleL),
      samplePeakRightDbfs: toDbfs(this.peakSampleR),
      samplePeakDbfs: toDbfs(Math.max(this.peakSampleL, this.peakSampleR)),
      oversample: this.oversample,
    };
  }
}
