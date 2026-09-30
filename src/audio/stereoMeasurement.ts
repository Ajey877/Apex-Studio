/**
 * Stereo field measurement from *independent* left and right sample streams.
 *
 * The previous master meter derived "R" from the next sample of a mono
 * down-mix buffer, which made "correlation" a measurement of
 * `cos(2 * PI * f / sampleRate)` — i.e. a frequency comb, not phase — and made
 * a fully anti-phase master read `+1.00` (perfectly coherent) while its energy
 * cancelled to nothing. This module cannot do that: it requires two real
 * buffers and refuses to answer rather than guess.
 *
 *   correlation = sum(L * R) / sqrt(sum(L^2) * sum(R^2))
 *   mid  = (L + R) / 2
 *   side = (L - R) / 2
 *
 * Pure and deterministic: no AudioContext, no `Date.now()`, no `Math.random()`.
 * Silence yields `null`, never a reassuring +1.
 */

export interface StereoFieldOptions {
  /** Integration window for the correlation statistic, seconds. */
  windowSeconds?: number;
  /** Number of per-frame statistic slots kept (each pushFrame consumes one). */
  slotCount?: number;
  /** Mean power below which no correlation is reported (about -120 dBFS). */
  silencePowerThreshold?: number;
}

export interface StereoFieldReading {
  /** Pearson correlation of the two channels in [-1, 1], or null if unmeasured. */
  correlation: number | null;
  /** 10*log10(mean(S^2) / mean(M^2)); null when mid energy is not measurable. */
  sideMidRatioDb: number | null;
  /** Mid and side mean power in dBFS; null for silence. */
  midPowerDbfs: number | null;
  sidePowerDbfs: number | null;
  /** Frames of statistics accumulated (each `pushFrame` adds one). */
  frameCount: number;
  /** True once at least one non-silent frame has been measured. */
  isMeasuring: boolean;
}

export interface MidSidePoint {
  /** Normalised side component (horizontal axis of a goniometer). */
  x: number;
  /** Normalised mid component (vertical axis of a goniometer). */
  y: number;
}

/**
 * Mid/Side vectors for a phase scope, decimated by stride from real channels.
 *
 * Returned points are normalised by the largest mid/side magnitude in the same
 * window so the drawing scales with the signal instead of a fixed gain.
 */
export function computeMidSideVectors(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  pointCount = 64,
): MidSidePoint[] {
  const length = Math.min(left.length, right.length);
  if (length === 0 || pointCount <= 0) return [];

  const stride = Math.max(1, Math.floor(length / pointCount));
  const available = Math.max(1, Math.min(pointCount, Math.ceil(length / stride)));

  const mid = new Float64Array(available);
  const side = new Float64Array(available);
  let scale = 0;
  for (let i = 0; i < available; i++) {
    const index = i * stride;
    const l = left[index];
    const r = right[index];
    const m = (l + r) / 2;
    const s = (l - r) / 2;
    mid[i] = m;
    side[i] = s;
    scale = Math.max(scale, Math.abs(m), Math.abs(s));
  }

  // Digital silence carries no phase information; report no points rather
  // than a bright dot that looks like a measurement.
  if (!(scale > 0)) return [];

  const points: MidSidePoint[] = [];
  for (let i = 0; i < available; i++) {
    points.push({ x: side[i] / scale, y: mid[i] / scale });
  }
  return points;
}

/**
 * Sliding-window correlation and Mid/Side energies over two independent
 * channels. Frames of any length can be pushed; statistics are kept per frame
 * and rolled over `slotCount` frames, which bounds memory and gives a stable
 * meter response.
 */
export class StereoFieldMeter {
  private readonly slots: number;
  private readonly windowSeconds: number;
  private readonly silenceThreshold: number;

  private readonly sumLL: Float64Array;
  private readonly sumRR: Float64Array;
  private readonly sumLR: Float64Array;
  private readonly sumMid: Float64Array;
  private readonly sumSide: Float64Array;
  private readonly counts: Float64Array;

  private writeIndex = 0;
  private filled = 0;
  private totalLL = 0;
  private totalRR = 0;
  private totalLR = 0;
  private totalMid = 0;
  private totalSide = 0;
  private totalCount = 0;
  private framesMeasured = 0;
  private everMeasurable = false;

  constructor(options: StereoFieldOptions = {}) {
    this.slots = Math.max(2, Math.floor(options.slotCount ?? 32));
    this.windowSeconds = options.windowSeconds ?? 1.0;
    this.silenceThreshold = options.silencePowerThreshold ?? 1e-10;
    this.sumLL = new Float64Array(this.slots);
    this.sumRR = new Float64Array(this.slots);
    this.sumLR = new Float64Array(this.slots);
    this.sumMid = new Float64Array(this.slots);
    this.sumSide = new Float64Array(this.slots);
    this.counts = new Float64Array(this.slots);
  }

  /** Seconds of audio currently inside the sliding window (diagnostics/tests). */
  get windowDurationSeconds(): number {
    return this.totalCount > 0 ? this.totalCount / (this.framesMeasured * this.sampleRateEstimate) : 0;
  }

  private sampleRateEstimate = 48000;

  /** Lets the engine publish the true rate so window sizing can be reported. */
  setSampleRate(sampleRate: number): void {
    if (Number.isFinite(sampleRate) && sampleRate > 0) this.sampleRateEstimate = sampleRate;
  }

  pushFrame(left: ArrayLike<number>, right: ArrayLike<number>): void {
    const length = Math.min(left.length, right.length);
    if (length === 0) return;

    let ll = 0;
    let rr = 0;
    let lr = 0;
    let mid = 0;
    let side = 0;
    for (let i = 0; i < length; i++) {
      const l = left[i];
      const r = right[i];
      ll += l * l;
      rr += r * r;
      lr += l * r;
      const m = (l + r) * 0.5;
      const s = (l - r) * 0.5;
      mid += m * m;
      side += s * s;
    }

    const index = this.writeIndex;
    if (this.filled === this.slots) {
      this.totalLL -= this.sumLL[index];
      this.totalRR -= this.sumRR[index];
      this.totalLR -= this.sumLR[index];
      this.totalMid -= this.sumMid[index];
      this.totalSide -= this.sumSide[index];
      this.totalCount -= this.counts[index];
    } else {
      this.filled += 1;
    }

    this.sumLL[index] = ll;
    this.sumRR[index] = rr;
    this.sumLR[index] = lr;
    this.sumMid[index] = mid;
    this.sumSide[index] = side;
    this.counts[index] = length;
    this.totalLL += ll;
    this.totalRR += rr;
    this.totalLR += lr;
    this.totalMid += mid;
    this.totalSide += side;
    this.totalCount += length;

    this.writeIndex = (index + 1) % this.slots;
    this.framesMeasured += 1;
    if (this.meanPower(this.totalLL) > this.silenceThreshold
      || this.meanPower(this.totalRR) > this.silenceThreshold) {
      this.everMeasurable = true;
    }
  }

  reset(): void {
    this.sumLL.fill(0);
    this.sumRR.fill(0);
    this.sumLR.fill(0);
    this.sumMid.fill(0);
    this.sumSide.fill(0);
    this.counts.fill(0);
    this.writeIndex = 0;
    this.filled = 0;
    this.totalLL = 0;
    this.totalRR = 0;
    this.totalLR = 0;
    this.totalMid = 0;
    this.totalSide = 0;
    this.totalCount = 0;
    this.framesMeasured = 0;
    this.everMeasurable = false;
  }

  private meanPower(total: number): number {
    return this.totalCount > 0 ? total / this.totalCount : 0;
  }

  getReading(): StereoFieldReading {
    if (this.framesMeasured === 0 || this.totalCount === 0) {
      return {
        correlation: null,
        sideMidRatioDb: null,
        midPowerDbfs: null,
        sidePowerDbfs: null,
        frameCount: 0,
        isMeasuring: false,
      };
    }

    const meanLL = this.meanPower(this.totalLL);
    const meanRR = this.meanPower(this.totalRR);
    const meanLR = this.meanPower(this.totalLR);

    // Both channels must carry signal: a correlation against silence has no
    // meaning, and reporting +1 for it is exactly the defect this replaces.
    const canCorrelate = meanLL > this.silenceThreshold && meanRR > this.silenceThreshold;
    const denominator = Math.sqrt(meanLL * meanRR);
    const correlation = canCorrelate && denominator > 0
      ? Math.max(-1, Math.min(1, meanLR / denominator))
      : null;

    const meanMid = this.meanPower(this.totalMid);
    const meanSide = this.meanPower(this.totalSide);
    // A pure mono programme really does have zero side energy; the ratio is
    // floored at -90 dBFS because a readout of "-300 dB" is theatre rather
    // than a measurement.
    const sideMidRatio = meanMid > this.silenceThreshold && meanSide > 0
      ? Math.max(-90, 10 * Math.log10(meanSide / meanMid))
      : null;

    return {
      correlation: correlation === null ? null : Math.round(correlation * 100) / 100,
      sideMidRatioDb: sideMidRatio === null ? null : Math.round(sideMidRatio * 10) / 10,
      midPowerDbfs: meanMid > 0 ? Math.round(10 * Math.log10(meanMid) * 10) / 10 : null,
      sidePowerDbfs: meanSide > 0 ? Math.round(10 * Math.log10(meanSide) * 10) / 10 : null,
      frameCount: this.framesMeasured,
      isMeasuring: this.everMeasurable,
    };
  }
}
