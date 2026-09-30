/**
 * ITU-R BS.1770-4 loudness measurement (stereo).
 *
 * Pure, deterministic DSP: no DOM, no AudioContext, no Web Audio nodes, no
 * `Date.now()` and no `Math.random()`. Every value returned by this module is
 * derived from samples that were actually pushed into it, which is what makes
 * it usable both from the live engine and from unit tests that feed offline
 * generated audio.
 *
 * Pipeline (BS.1770-4 §1):
 *   1. K-weighting per channel — a high shelf ("head") followed by a steep
 *      high-pass ("RLB").
 *   2. Gating blocks of 400 ms, 75 % overlap (100 ms hop).
 *   3. Mean square per block per channel, summed with channel weighting
 *      coefficients (L/R = 1.0).
 *   4. Block loudness: -0.691 + 10*log10(sum(g_i * z_i)).
 *   5. Absolute gate at -70 LKFS, then relative gate at 10 dB below the
 *      absolute-gated average. Integrated loudness averages the mean-square
 *      values of the blocks that pass both gates.
 *
 * The K-weighting coefficients are derived for the *actual* sample rate using
 * the method of B. De Man (matching the published 48 kHz table of BS.1770-4 to
 * ~1e-12 and staying correct at 44.1 kHz), rather than hard-coding the 48 kHz
 * coefficient table and hoping.
 *
 * Silence is silence: when no block survives the gates there is no integrated
 * number, and `null` is reported instead of a fabricated value.
 */

/** Loudness units relative to full scale, referenced to digital silence. */
export const LUFS_ANCHOR_DB = -0.691;
/** BS.1770-4 absolute gating threshold in LKFS. */
export const ABSOLUTE_GATE_LUFS = -70.0;
/** BS.1770-4 relative gating offset in dB. */
export const RELATIVE_GATE_DB = 10.0;
/** Gating block duration required by BS.1770-4. */
export const GATING_BLOCK_SECONDS = 0.4;
/** Gating block overlap required by BS.1770-4 (25 % hop). */
export const GATING_BLOCK_OVERLAP = 0.75;
/** EBU Tech 3341 short-term window. */
export const SHORT_TERM_SECONDS = 3.0;

export interface BiquadCoefficients {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export interface KWeightingCoefficients {
  /** Stage 1: high shelf modelling the head. */
  highShelf: BiquadCoefficients;
  /** Stage 2: steep high-pass (RLB) suppressing low frequencies. */
  highPass: BiquadCoefficients;
}

/**
 * The two K-weighting stages, re-derived for `sampleRate`.
 *
 * Exposed separately from `KWeightingFilter` so that a unit test can assert
 * the 48 kHz result against the table published in ITU-R BS.1770-4.
 */
export function designKWeighting(sampleRate: number): KWeightingCoefficients {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError(`designKWeighting: invalid sampleRate ${sampleRate}`);
  }

  // Analog prototype parameters recovered from the published 48 kHz filter by
  // De Man; the shelf gain is 4.0 dB (3.99984385397 after rounding of the
  // published coefficients).
  const shelfGainDb = 3.99984385397;
  const shelfQ = 0.7071752369554193;
  const shelfFcHz = 1681.9744509555319;
  const highPassQ = 0.5003270373253953;
  const highPassFcHz = 38.13547087613982;

  const tan = Math.tan;
  const PI = Math.PI;

  // --- Stage 1: high shelf, bilinear transform with frequency prewarp ---
  const kShelf = tan(PI * shelfFcHz / sampleRate);
  const vH = 10 ** (shelfGainDb / 20);
  const vB = vH ** 0.499666774155;
  const shelfDen = 1 + kShelf / shelfQ + kShelf * kShelf;
  const highShelf: BiquadCoefficients = {
    b0: (vH + vB * kShelf / shelfQ + kShelf * kShelf) / shelfDen,
    b1: 2 * (kShelf * kShelf - vH) / shelfDen,
    b2: (vH - vB * kShelf / shelfQ + kShelf * kShelf) / shelfDen,
    a1: 2 * (kShelf * kShelf - 1) / shelfDen,
    a2: (1 - kShelf / shelfQ + kShelf * kShelf) / shelfDen,
  };

  // --- Stage 2: high-pass, zeros at DC, bilinear with prewarp ---
  const kHp = tan(PI * highPassFcHz / sampleRate);
  const hpDen = 1 + kHp / highPassQ + kHp * kHp;
  const highPass: BiquadCoefficients = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: 2 * (kHp * kHp - 1) / hpDen,
    a2: (1 - kHp / highPassQ + kHp * kHp) / hpDen,
  };

  return { highShelf, highPass };
}

/** Direct Form I biquad with retained state, for continuous streaming. */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(private readonly c: BiquadCoefficients) {}

  process(x: number): number {
    const c = this.c;
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/** K-weighting for one channel: shelf then high-pass, as BS.1770-4 requires. */
export class KWeightingFilter {
  private readonly shelf: Biquad;
  private readonly highPass: Biquad;

  constructor(sampleRate: number) {
    const coefficients = designKWeighting(sampleRate);
    this.shelf = new Biquad(coefficients.highShelf);
    this.highPass = new Biquad(coefficients.highPass);
  }

  process(x: number): number {
    return this.highPass.process(this.shelf.process(x));
  }

  reset(): void {
    this.shelf.reset();
    this.highPass.reset();
  }
}

export interface LoudnessMeterOptions {
  /** Override for the channel weighting coefficients (defaults to 1.0 / 1.0). */
  channelGains?: [number, number];
  blockSeconds?: number;
  overlap?: number;
  absoluteGateLufs?: number;
  relativeGateDb?: number;
  shortTermSeconds?: number;
}

export interface LoudnessReading {
  /** Loudness of the most recent 400 ms block, or null when nothing was measured. */
  momentaryLufs: number | null;
  /** Loudness over the sliding 3 s window; null until any block exists. */
  shortTermLufs: number | null;
  /** Gated integrated loudness over every block since the last reset. */
  integratedLufs: number | null;
  /** Number of complete gating blocks produced so far. */
  blockCount: number;
  /** Blocks that survived the absolute gate. */
  absoluteGatedBlockCount: number;
  /** Blocks that survived both gates and therefore feed the integrated value. */
  gatedBlockCount: number;
  /** Seconds of audio actually accumulated since the last reset. */
  measuredSeconds: number;
  /** True once the short-term window is fully covered by real blocks. */
  shortTermReady: boolean;
  /** True while the meter is receiving audio (blocks have been produced). */
  isMeasuring: boolean;
}

/**
 * Streaming BS.1770-4 loudness meter.
 *
 * Frames of arbitrary length are pushed in; the meter keeps a circular buffer
 * of the last 400 ms per channel, a running mean-square sum, and the history
 * of every block so the integrated value can accumulate (and be re-gated) as
 * material arrives.
 */
export class LoudnessMeter {
  private readonly sampleRate: number;
  private readonly blockLength: number;
  private readonly hopLength: number;
  private readonly shortTermBlocks: number;
  private readonly gains: [number, number];
  private readonly absoluteGate: number;
  private readonly relativeGateDb: number;

  private readonly filterL: KWeightingFilter;
  private readonly filterR: KWeightingFilter;

  private readonly circleL: Float64Array;
  private readonly circleR: Float64Array;
  private circlePos = 0;
  private samplesReceived = 0;

  /** Mean-square per channel for every completed block, in arrival order. */
  private blocksL = new Float64Array(1024);
  private blocksR = new Float64Array(1024);
  private blockCount = 0;

  constructor(sampleRate: number, options: LoudnessMeterOptions = {}) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError(`LoudnessMeter: invalid sampleRate ${sampleRate}`);
    }
    this.sampleRate = sampleRate;
    const blockSeconds = options.blockSeconds ?? GATING_BLOCK_SECONDS;
    const overlap = options.overlap ?? GATING_BLOCK_OVERLAP;
    this.blockLength = Math.max(1, Math.round(blockSeconds * sampleRate));
    this.hopLength = Math.max(1, Math.round(this.blockLength * (1 - overlap)));
    this.shortTermBlocks = Math.max(1, Math.round((options.shortTermSeconds ?? SHORT_TERM_SECONDS) * sampleRate / this.hopLength));
    this.gains = options.channelGains ?? [1.0, 1.0];
    this.absoluteGate = options.absoluteGateLufs ?? ABSOLUTE_GATE_LUFS;
    this.relativeGateDb = options.relativeGateDb ?? RELATIVE_GATE_DB;

    this.filterL = new KWeightingFilter(sampleRate);
    this.filterR = new KWeightingFilter(sampleRate);
    this.circleL = new Float64Array(this.blockLength);
    this.circleR = new Float64Array(this.blockLength);
  }

  /** Samples per produced block (25 % of the block length, i.e. 100 ms). */
  get hop(): number {
    return this.hopLength;
  }

  /**
   * Consume one aligned pair of frames. Only whole blocks are reported, so a
   * partial tail simply stays in the circular buffer until more audio arrives.
   */
  pushFrame(left: ArrayLike<number>, right: ArrayLike<number>): void {
    const length = Math.min(left.length, right.length);
    for (let i = 0; i < length; i++) {
      const filteredL = this.filterL.process(left[i]);
      const filteredR = this.filterR.process(right[i]);

      this.circleL[this.circlePos] = filteredL;
      this.circleR[this.circlePos] = filteredR;
      this.circlePos = this.circlePos + 1 >= this.blockLength ? 0 : this.circlePos + 1;
      this.samplesReceived += 1;

      // A block boundary is reached every hop after the first full block. The
      // mean square is summed straight out of the ring buffer rather than kept
      // as a running sum: sliding sums of squares drift over long sessions,
      // and a meter that drifts is a meter that lies.
      if (this.samplesReceived >= this.blockLength
        && (this.samplesReceived - this.blockLength) % this.hopLength === 0) {
        let blockSumL = 0;
        let blockSumR = 0;
        for (let j = 0; j < this.blockLength; j++) {
          const vl = this.circleL[j];
          const vr = this.circleR[j];
          blockSumL += vl * vl;
          blockSumR += vr * vr;
        }
        this.pushBlock(blockSumL / this.blockLength, blockSumR / this.blockLength);
      }
    }
  }

  /** Clears every accumulated measurement: filters, blocks, and gate state. */
  reset(): void {
    this.filterL.reset();
    this.filterR.reset();
    this.circleL.fill(0);
    this.circleR.fill(0);
    this.circlePos = 0;
    this.samplesReceived = 0;
    this.blockCount = 0;
  }

  /** Total number of gating blocks held; used by tests and by the UI. */
  get completedBlockCount(): number {
    return this.blockCount;
  }

  get secondsMeasured(): number {
    return this.samplesReceived / this.sampleRate;
  }

  private pushBlock(zL: number, zR: number): void {
    if (this.blockCount >= this.blocksL.length) {
      const nextLength = this.blocksL.length * 2;
      const nextL = new Float64Array(nextLength);
      const nextR = new Float64Array(nextLength);
      nextL.set(this.blocksL);
      nextR.set(this.blocksR);
      this.blocksL = nextL;
      this.blocksR = nextR;
    }
    this.blocksL[this.blockCount] = zL;
    this.blocksR[this.blockCount] = zR;
    this.blockCount += 1;
  }

  private loudnessOf(zL: number, zR: number): number {
    return LUFS_ANCHOR_DB + 10 * Math.log10(this.gains[0] * zL + this.gains[1] * zR);
  }

  private static isSilent(power: number): boolean {
    return !(power > 0) || !Number.isFinite(power);
  }

  /**
   * Snapshot of every derived loudness value. Never advances the measurement:
   * a meter may be read as often as a UI likes without changing the result.
   */
  getReading(): LoudnessReading {
    const count = this.blockCount;
    if (count === 0) {
      return {
        momentaryLufs: null,
        shortTermLufs: null,
        integratedLufs: null,
        blockCount: 0,
        absoluteGatedBlockCount: 0,
        gatedBlockCount: 0,
        measuredSeconds: this.secondsMeasured,
        shortTermReady: false,
        isMeasuring: false,
      };
    }

    // Momentary: the newest block only, ungated (BS.1770-4 gates integrated
    // loudness; momentary and short-term are the plain block values).
    const lastL = this.blocksL[count - 1];
    const lastR = this.blocksR[count - 1];
    const momentary = LoudnessMeter.isSilent(this.gains[0] * lastL + this.gains[1] * lastR)
      ? null
      : this.loudnessOf(lastL, lastR);

    // Short-term: power average of the blocks covering the last 3 seconds.
    const windowStart = Math.max(0, count - this.shortTermBlocks);
    let windowL = 0;
    let windowR = 0;
    for (let j = windowStart; j < count; j++) {
      windowL += this.blocksL[j];
      windowR += this.blocksR[j];
    }
    const windowSize = count - windowStart;
    const shortTerm = this.loudnessOf(windowL / windowSize, windowR / windowSize);

    // Integrated: absolute gate, then relative gate, then average the mean
    // squares of the surviving blocks (BS.1770-4 §2 equations 5-7).
    let absoluteGated = 0;
    let sumLAboveAbsolute = 0;
    let sumRAboveAbsolute = 0;
    for (let j = 0; j < count; j++) {
      if (this.loudnessOf(this.blocksL[j], this.blocksR[j]) > this.absoluteGate) {
        absoluteGated += 1;
        sumLAboveAbsolute += this.blocksL[j];
        sumRAboveAbsolute += this.blocksR[j];
      }
    }
    let integrated: number | null = null;
    let gatedBlockCount = 0;
    if (absoluteGated > 0) {
      const relativeGate = this.loudnessOf(sumLAboveAbsolute / absoluteGated, sumRAboveAbsolute / absoluteGated)
        - this.relativeGateDb;
      let sumL = 0;
      let sumR = 0;
      for (let j = 0; j < count; j++) {
        const blockLufs = this.loudnessOf(this.blocksL[j], this.blocksR[j]);
        if (blockLufs > this.absoluteGate && blockLufs > relativeGate) {
          gatedBlockCount += 1;
          sumL += this.blocksL[j];
          sumR += this.blocksR[j];
        }
      }
      if (gatedBlockCount > 0) {
        integrated = this.loudnessOf(sumL / gatedBlockCount, sumR / gatedBlockCount);
      }
    }

    return {
      momentaryLufs: finiteOrNull(momentary),
      shortTermLufs: finiteOrNull(shortTerm),
      integratedLufs: finiteOrNull(integrated),
      blockCount: count,
      absoluteGatedBlockCount: absoluteGated,
      gatedBlockCount,
      measuredSeconds: this.secondsMeasured,
      shortTermReady: count >= this.shortTermBlocks,
      isMeasuring: true,
    };
  }
}

/** Digital silence has no loudness: report "not measured", never -Infinity. */
function finiteOrNull(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}
