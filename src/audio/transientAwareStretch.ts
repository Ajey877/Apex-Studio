/**
 * Phase 7D: Transient-Anchored WSOLA (TAW) — the transient-aware companion to
 * `wsolaTimeStretch.ts`, for drums, percussion and any attack-rich material.
 *
 * WHAT THIS IS
 * The exact WSOLA overlap-add skeleton of Phase 7A (fixed 512-sample synthesis
 * hop, periodic Hann 1024, shared multi-channel analysis positions, output
 * length exactly ceil(inputLength × ratio), ratio 1 = identity) with ONE
 * targeted change: detected input transients ANCHOR the analysis grid. Each
 * owned attack is read by exactly one frame at high window weight and written
 * at output position round(onset × ratio), so attack timing survives the
 * stretch instead of being smeared by free-floating similarity search.
 *
 * HOW IT WORKS
 * 1. DETECTION — summed squared-energy flux on a 256/64 grid, RELATIVE to the
 *    previous frame energy (Δe/e) so weak attacks on decaying tails (hats over
 *    a kick) stay salient next to dominant ones; a moving-median threshold
 *    (±93 ms, 3×) adapts locally; peak-picking is refined to the sample-level
 *    attack front (25 % crossing of a 17-sample smoothed |mono| envelope) and
 *    guarded by an amplitude-rise test (≥ 2× within ~6 ms) that rejects decay
 *    wiggle of tonal tails. Onsets closer than max(1024, 1024/ratio) samples
 *    are merged, keeping the stronger flux, so every survivor can own a
 *    distinct frame.
 * 2. OWNERSHIP — onset o owns the frame k = round(round(o×ratio)/512 − 1)
 *    when the attack lands at window index idx ∈ [128, 896] (Hann weight
 *    ≥ 0.15, in practice 0.5–1.0 because idx ∈ [256, 768] by construction)
 *    and the unclamped analysis start o − idx lies inside the padded input.
 *    Onsets too close to the input edges cannot be placed honestly: they stay
 *    UNOWNED and receive the ordinary WSOLA treatment — never a crushed or
 *    clamped anchor.
 * 3. RIGID GRID RAMPS — frames whose interpolated window would cover an owned
 *    onset at weight ≥ w(128) ≈ 0.15 (the forbidden band [o−896, o−128]) are
 *    pinned deterministically: a pre-ramp ending exactly at o−1024 (window
 *    weight 0 at the attack) and a post-ramp starting exactly at o+1 and
 *    re-tiling at the analysis hop. Between control points (anchor frames,
 *    ramp ends, and any rare fallback jump) the grid offset is interpolated
 *    linearly, so analysis hops stay positive and bounded — no post-jump
 *    pile-ups, no duplicated attacks, no crossfade clicks (Hann COLA w[n] +
 *    w[n+512] = 1 holds by construction: frames always tile the OUTPUT at
 *    512 regardless of where they read).
 * 4. FREE FRAMES run the same similarity search as WSOLA, restricted to
 *    starts outside the forbidden bands; the multi-channel score sum keeps
 *    ONE shared position per frame, so stereo alignment is preserved exactly.
 *
 * MEASURED BEHAVIOR (deterministic PCM fixtures, differential-envelope
 * metrics; see transientAwareStretch.test.ts — synthetic fixtures demonstrate
 * algorithmic behavior, not studio-grade subjective quality)
 * - Isolated impulse, stereo impulse trains, drum loops and tonal attacks all
 *   show large attack-timing and pre-echo improvements over WSOLA at every
 *   supported ratio; pitch error on tonal material matches WSOLA (±0.3 %).
 * - Stereo inter-channel delay is preserved sample-exactly (shared positions).
 *
 * HONEST LIMITATIONS
 * - The attack sample itself is rendered by a single frame at Hann weight
 *   w(idx) ∈ [0.5, 1.0] (no second frame may duplicate it), so an isolated
 *   impulse can measure up to ~6 dB below a WSOLA render that duplicates the
 *   impulse across frames. That duplication IS the pre-echo artifact TAW
 *   removes; dense material (real drums) measures ≈ 0 dB RMS difference.
 * - Onsets within ~23 ms of the input start or end cannot own a frame and get
 *   WSOLA treatment for that attack.
 * - When detection finds NO onsets (silence, ambient pads with no attacks),
 *   every frame is free and the output is bit-identical to `wsolaStretchChannels`
 *   — a documented graceful path, not a silent quality substitution: on
 *   transient-bearing material the outputs provably differ.
 * - Same supported ratio bounds as WSOLA (0.25×–4.0×), same typed-error
 *   discipline, same determinism (bit-identical repeated runs), silence in →
 *   silence out, exact ceil(length × ratio) output, input never mutated.
 * - Bounded cost: detection is O(N × channels) on a 64-sample grid; the grid
 *   construction is O(onsets log onsets); synthesis matches WSOLA.
 */
import {
  WSOLA_FRAME_SIZE,
  WSOLA_MAX_RATIO,
  WSOLA_MIN_RATIO,
  WSOLA_SCORE_STRIDE,
  WSOLA_SEARCH_DELTA,
  WSOLA_SYNTHESIS_HOP,
  WsolaTimeStretchError,
  type WsolaStretchResult,
} from './wsolaTimeStretch';

export { WSOLA_MAX_RATIO as TAW_MAX_RATIO, WSOLA_MIN_RATIO as TAW_MIN_RATIO };

export type TransientAwareStretchFailure =
  | 'invalid-ratio'
  | 'unsupported-ratio'
  | 'empty-buffer'
  | 'invalid-buffer';

/** Typed failure so callers report honest, specific messages instead of guessing. */
export class TransientAwareStretchError extends Error {
  public readonly failure: TransientAwareStretchFailure;
  constructor(failure: TransientAwareStretchFailure, message: string) {
    super(message);
    this.name = 'TransientAwareStretchError';
    this.failure = failure;
  }
}

/** A stretch strategy selectable in the Warp processor. 'wsola' is the
 *  Phase 7A compatibility baseline; 'transient' is the Phase 7D TAW path. */
export type WarpStretchStrategy = 'wsola' | 'transient';

// Detection parameters (all deterministic, sample-rate-relative).
/** Energy integration window (samples): ~5.8 ms at 44.1 kHz. */
export const TAW_ENERGY_WINDOW = 256;
/** Energy grid hop (samples): flux resolution ~1.45 ms at 44.1 kHz. */
export const TAW_ENERGY_HOP = 64;
/** Threshold = C × moving median of the relative flux … */
export const TAW_FLUX_MEDIAN_C = 3;
/** … and never below this absolute relative-novelty floor (silence = 0 flux). */
export const TAW_FLUX_FLOOR = 0.05;
/** Moving-median half-radius in flux frames (±93 ms at 44.1 kHz). */
export const TAW_MEDIAN_RADIUS_FRAMES = 64;
/** Attack-front refinement window around a flux peak (samples back/forward). */
export const TAW_REFINE_PRE = 128;
export const TAW_REFINE_POST = 384;
/** Causal smoothing span for the refinement envelope (samples). */
export const TAW_SMOOTH_SPAN = 17;
/** Rise guard: the smoothed amplitude must at least double within the
 *  pre-window to count as an attack (rejects tonal decay wiggle). */
export const TAW_RISE_GUARD = 2;
/** Amplitude ratio defining the attack front (25 % of the local peak). */
export const TAW_FRONT_RATIO = 0.25;
/** Owned window-index band: an anchor places its onset at Hann weight ≥ 0.15. */
export const TAW_ANCHOR_IDX_MIN = 128;
export const TAW_ANCHOR_IDX_MAX = 896;
/** Forbidden band around an owned onset o: starts s ∈ [o−896, o−128] would
 *  cover o at window weight ≥ w(128) ≈ 0.15 — only the anchor may do that. */
export const TAW_FORBID_BACK = 896;
export const TAW_FORBID_FRONT = 128;

/** Minimum inter-onset interval so every survivor can own a distinct frame:
 *  one analysis frame apart in the INPUT (1024), and one WINDOW apart in the
 *  output (1024/ratio input samples land 1024 output samples apart). */
export const tawMinInterOnsetInterval = (ratio: number): number =>
  Math.max(WSOLA_FRAME_SIZE, Math.ceil(WSOLA_FRAME_SIZE / ratio));

export interface TawOnset {
  /** Refined attack-front position in input samples. */
  position: number;
  /** Relative energy flux at the detection frame (merge strength). */
  flux: number;
}

/**
 * Deterministic transient onset detection on raw channel data. Returns the
 * refined attack fronts, sorted, merged to `minIoi` samples. Silent and
 * attack-free material yields an empty list — the stretch then reproduces
 * plain WSOLA output bit-identically (documented graceful path).
 */
export const detectTransientOnsets = (
  channels: readonly Float32Array[],
  minIoi: number
): TawOnset[] => {
  const n = channels[0].length;
  const chCount = channels.length;
  if (n < TAW_ENERGY_WINDOW + TAW_ENERGY_HOP) return [];

  // Summed squared energy on a coarse grid (O(N) sliding window).
  const frames = Math.floor((n - TAW_ENERGY_WINDOW) / TAW_ENERGY_HOP) + 1;
  const energy = new Float64Array(frames);
  let acc = 0;
  for (let i = 0; i < TAW_ENERGY_WINDOW; i += 1) {
    let s = 0;
    for (let ch = 0; ch < chCount; ch += 1) s += channels[ch][i] * channels[ch][i];
    acc += s;
  }
  energy[0] = acc;
  for (let j = 1; j < frames; j += 1) {
    const out = (j - 1) * TAW_ENERGY_HOP;
    const inn = out + TAW_ENERGY_WINDOW;
    for (let i = out; i < out + TAW_ENERGY_HOP && i < n; i += 1) {
      let so = 0;
      let si = 0;
      for (let ch = 0; ch < chCount; ch += 1) {
        so += channels[ch][i] * channels[ch][i];
        if (inn + (i - out) < n) {
          const v = channels[ch][inn + (i - out)];
          si += v * v;
        }
      }
      acc += si - so;
    }
    energy[j] = Math.max(0, acc);
  }

  // RELATIVE positive energy flux (Δe / previous energy): absolute flux is
  // dominated by the loudest transient class in the clip (a kick at t=0
  // outruns every hat by 100×); the relative rise keeps weak-but-genuine
  // attacks on decaying tails salient, and stays 0 for silence.
  const flux = new Float64Array(frames);
  const epsEnergy = 1e-10;
  // Frame 0 rises from digital silence: treat audible energy as novelty 1.
  flux[0] = energy[0] > TAW_FLUX_FLOOR ? 1 : 0;
  for (let j = 1; j < frames; j += 1) {
    flux[j] = Math.max(0, energy[j] - energy[j - 1]) / (energy[j - 1] + epsEnergy);
  }

  // Locally adaptive threshold: moving median of the relative flux. Decay
  // wobble sits near the median; genuine attacks spike above C × median.
  const threshold = new Float64Array(frames);
  const win: number[] = [];
  for (let j = 0; j < frames; j += 1) {
    win.length = 0;
    const lo = Math.max(0, j - TAW_MEDIAN_RADIUS_FRAMES);
    const hi = Math.min(frames - 1, j + TAW_MEDIAN_RADIUS_FRAMES);
    for (let m = lo; m <= hi; m += 1) win.push(flux[m]);
    win.sort((a, b) => a - b);
    const median = win[win.length >> 1];
    threshold[j] = Math.max(TAW_FLUX_MEDIAN_C * median, TAW_FLUX_FLOOR);
  }

  // Sample-level attack-front refinement on a smoothed |mono| envelope (zero
  // crossings of tonal bodies must not jitter the front estimate).
  const absMono = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    let s = 0;
    for (let ch = 0; ch < chCount; ch += 1) s += Math.abs(channels[ch][i]);
    absMono[i] = s / chCount;
  }
  const smooth = new Float32Array(n);
  let smoothAcc = 0;
  for (let i = 0; i < n; i += 1) {
    smoothAcc += absMono[i];
    if (i >= TAW_SMOOTH_SPAN) smoothAcc -= absMono[i - TAW_SMOOTH_SPAN];
    smooth[i] = smoothAcc / Math.min(i + 1, TAW_SMOOTH_SPAN);
  }

  const candidates: TawOnset[] = [];
  for (let j = 0; j < frames - 1; j += 1) {
    const prev = j > 0 ? flux[j - 1] : -1;
    if (flux[j] > threshold[j] && flux[j] >= prev && flux[j] > flux[j + 1]) {
      const p = j * TAW_ENERGY_HOP;
      const lo = Math.max(0, p - TAW_REFINE_PRE);
      const hi = Math.min(n - 1, p + TAW_REFINE_POST);
      let peakPos = p;
      let peakVal = -1;
      for (let i = lo; i <= hi; i += 1) {
        if (smooth[i] > peakVal) { peakVal = smooth[i]; peakPos = i; }
      }
      let front = peakPos;
      const frontThr = TAW_FRONT_RATIO * peakVal;
      for (let i = Math.max(lo, peakPos - TAW_ENERGY_WINDOW); i <= peakPos; i += 1) {
        if (smooth[i] >= frontThr) { front = i; break; }
      }
      // Attack-rise guard: a genuine transient at least doubles the smoothed
      // amplitude within ~6 ms before the front. Decay-phase wiggle of tonal
      // tails fails this and is not anchored.
      const preLo = Math.max(0, front - TAW_ENERGY_WINDOW);
      const preHi = Math.max(preLo, front - 32);
      let pre = 0;
      for (let i = preLo; i <= preHi; i += 1) if (smooth[i] > pre) pre = smooth[i];
      if (peakVal < TAW_RISE_GUARD * pre) continue;
      candidates.push({ position: front, flux: flux[j] });
    }
  }

  // Merge to the minimum inter-onset interval, keeping the stronger flux.
  candidates.sort((a, b) => a.position - b.position);
  const merged: TawOnset[] = [];
  for (const c of candidates) {
    const last = merged[merged.length - 1];
    if (last && c.position - last.position < minIoi) {
      if (c.flux > last.flux) merged[merged.length - 1] = c;
    } else {
      merged.push(c);
    }
  }
  return merged;
};

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
    throw new TransientAwareStretchError('invalid-ratio', `Stretch ratio must be a finite number, got: ${String(ratio)}.`);
  }
  if (ratio < WSOLA_MIN_RATIO || ratio > WSOLA_MAX_RATIO) {
    throw new TransientAwareStretchError(
      'unsupported-ratio',
      `Transient-aware stretch supports ratios from ${WSOLA_MIN_RATIO}× to ${WSOLA_MAX_RATIO}× — ${ratio}× is outside that range.`
    );
  }
};

/**
 * Stretches raw channel data by `ratio` with transients anchored (see module
 * docs for the measured quality envelope and honest limitations). Same
 * contract as `wsolaStretchChannels`: never mutates input, exact output
 * length, fully deterministic. With no detected onsets the result is
 * bit-identical to WSOLA — a documented graceful path, never a silent
 * substitution on transient-bearing material.
 */
export const tawStretchChannels = (
  channels: readonly Float32Array[],
  ratio: number
): WsolaStretchResult => {
  assertSupportedRatio(ratio);
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new TransientAwareStretchError('invalid-buffer', 'Transient-aware stretch needs at least one channel of audio data.');
  }
  const inputLength = channels[0].length;
  for (const channel of channels) {
    if (!(channel instanceof Float32Array)) {
      throw new TransientAwareStretchError('invalid-buffer', 'Transient-aware stretch needs Float32Array channel data.');
    }
    if (channel.length !== inputLength) {
      throw new TransientAwareStretchError('invalid-buffer', 'Transient-aware stretch needs every channel to be the same length.');
    }
  }
  if (inputLength === 0) {
    throw new TransientAwareStretchError('empty-buffer', 'The audio buffer is empty — nothing to stretch.');
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
  const channelCount = channels.length;

  // Working copies with a deterministic zero tail (same seam as WSOLA).
  const paddedLength = inputLength + frameSize + searchDelta;
  const padded: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch += 1) {
    const copy = new Float32Array(paddedLength);
    copy.set(channels[ch], 0);
    padded.push(copy);
  }
  const window = buildHannWindow(frameSize);
  const output: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch += 1) output.push(new Float32Array(outputLength));
  const tails: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch += 1) tails.push(new Float32Array(halfFrame));

  const analysisHop = synthesisHop / ratio;
  const frameCount = Math.ceil(outputLength / synthesisHop);
  const maxCandidateStart = paddedLength - frameSize;

  // Onsets: merged so every survivor can own a distinct frame.
  const onsets = detectTransientOnsets(channels, tawMinInterOnsetInterval(ratio));

  // Ownership: onset o owns the frame k that places o at output round(o×ratio)
  // with an honest, unclamped analysis start. Onsets too close to the input
  // edges stay unowned and receive ordinary WSOLA treatment.
  interface Anchor { onset: number; start: number; idx: number; flux: number }
  const anchors = new Map<number, Anchor>();
  const ownedOnsets: number[] = [];
  for (const o of onsets) {
    const t = Math.round(o.position * ratio);
    let k = Math.round(t / synthesisHop - 1);
    if (k < 0) k = 0;
    if (k > frameCount - 1) k = frameCount - 1;
    const idx = t - k * synthesisHop;
    if (idx < TAW_ANCHOR_IDX_MIN || idx > TAW_ANCHOR_IDX_MAX) continue;
    const start = o.position - idx;
    if (start < 0 || start > maxCandidateStart) continue;
    const existing = anchors.get(k);
    if (existing) {
      if (o.flux > existing.flux) {
        anchors.set(k, { onset: o.position, start, idx, flux: o.flux });
        ownedOnsets.push(o.position);
      }
      continue; // weaker onset is demoted (unowned)
    }
    anchors.set(k, { onset: o.position, start, idx, flux: o.flux });
    ownedOnsets.push(o.position);
  }
  ownedOnsets.sort((a, b) => a - b);

  // Control-point grid. Around every anchor the analysis grid is RIGID:
  //   pre-ramp   frames end exactly at the onset (window weight 0 there),
  //   the anchor reads the onset at weight w(idx) ≥ 0.5,
  //   post-ramp  frames start exactly after the onset and re-tile at the
  //              analysis hop (plus one restart frame so the next free frame
  //              sees hop ≈ analysisHop).
  // Between control points the grid offset is interpolated linearly, so hops
  // stay positive and bounded — no post-jump pile-ups. A rare fallback jump
  // becomes a control point too, so the grid follows reality instead of
  // fighting it for dozens of frames.
  const cpFrames: number[] = [];
  const cpOffsets: number[] = [];
  const addCP = (frame: number, offset: number): void => {
    if (cpFrames.length > 0 && frame <= cpFrames[cpFrames.length - 1]) return; // strictly increasing
    cpFrames.push(frame);
    cpOffsets.push(offset);
  };
  const anchorKeys = [...anchors.keys()].sort((a, b) => a - b);
  let prevEnd = -1; // last frame consumed by the previous anchor's ramps
  for (let ai = 0; ai < anchorKeys.length; ai += 1) {
    const kOwn = anchorKeys[ai];
    const a = anchors.get(kOwn)!;
    const idx = a.idx;
    const o = a.onset;
    const offA = a.start - kOwn * analysisHop;
    // Rigid pre-ramp: frames whose interpolated window would cover the onset
    // at weight ≥ w(128) read exactly up to o−1024 instead, tiling at the
    // analysis hop. +1 restart frame keeps the merge hop ≈ analysisHop.
    const needPre = Math.floor((TAW_FORBID_BACK - idx) / analysisHop) + 1;
    const roomPre = Math.max(0, Math.min(needPre, kOwn - prevEnd - 1));
    let rigidPre = roomPre;
    while (rigidPre > 0 && o - frameSize - (rigidPre - 1) * analysisHop < 0) rigidPre -= 1;
    if (rigidPre > 0) {
      const offP = o - frameSize + analysisHop - kOwn * analysisHop;
      addCP(kOwn - rigidPre, offP);
      addCP(kOwn - 1, offP);
    }
    addCP(kOwn, offA);
    // Rigid post-ramp: frames whose interpolated start would land inside the
    // forbidden band start at o+1 and re-tile at the analysis hop.
    const needPost = Math.max(0, Math.floor((idx - TAW_FORBID_FRONT) / analysisHop)) + 1;
    const nextK = ai + 1 < anchorKeys.length ? anchorKeys[ai + 1] : frameCount;
    let rigidPost = Math.max(0, Math.min(needPost, nextK - kOwn - 2));
    while (rigidPost > 0 && o + 1 + (rigidPost - 1) * analysisHop > maxCandidateStart) rigidPost -= 1;
    if (rigidPost > 0) {
      const offQ = o + 1 - analysisHop - kOwn * analysisHop;
      addCP(kOwn + 1, offQ);
      addCP(kOwn + rigidPost, offQ);
    }
    prevEnd = kOwn + rigidPost;
  }

  const offsetAt = (k: number): number => {
    if (cpFrames.length === 0) return 0;
    if (k <= cpFrames[0]) return cpOffsets[0];
    const last = cpFrames.length - 1;
    if (k >= cpFrames[last]) return cpOffsets[last];
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cpFrames[mid] <= k) lo = mid;
      else hi = mid;
    }
    const o1 = cpOffsets[lo];
    const o2 = cpOffsets[hi];
    return o1 + (o2 - o1) * ((k - cpFrames[lo]) / (cpFrames[hi] - cpFrames[lo]));
  };
  const insertCP = (frame: number, offset: number): void => {
    // Jump control point (rare): keep the list sorted.
    let pos = cpFrames.length;
    while (pos > 0 && cpFrames[pos - 1] > frame) pos -= 1;
    if (pos > 0 && cpFrames[pos - 1] === frame) return;
    cpFrames.splice(pos, 0, frame);
    cpOffsets.splice(pos, 0, offset);
  };

  // Rigid frames: fixed analysis start, no search. Anchors plus every frame
  // inside a flat control-point segment (the ramps).
  const rigidStart = new Map<number, number>();
  for (const kOwn of anchorKeys) rigidStart.set(kOwn, anchors.get(kOwn)!.start);
  for (let ci = 0; ci < cpFrames.length - 1; ci += 1) {
    if (cpOffsets[ci] === cpOffsets[ci + 1]) {
      for (let k = cpFrames[ci]; k <= cpFrames[ci + 1]; k += 1) {
        const s = Math.round(k * analysisHop + cpOffsets[ci]);
        if (s >= 0 && s <= maxCandidateStart) rigidStart.set(k, s);
      }
    }
  }

  const scoreTaps = Math.ceil(halfFrame / scoreStride);

  for (let k = 0, outPos = 0; outPos < outputLength; outPos += synthesisHop, k += 1) {
    let best: number;
    const rigid = rigidStart.get(k);
    if (rigid !== undefined) {
      best = rigid;
    } else {
      const nominal = Math.max(0, Math.min(maxCandidateStart, Math.round(k * analysisHop + offsetAt(k))));
      const lo = Math.max(0, nominal - searchDelta);
      const hi = Math.max(lo, Math.min(maxCandidateStart, nominal + searchDelta));
      // Forbidden bands: starts whose window covers an owned onset at
      // weight ≥ w(128). Only the anchor (and its zero-weight ramps) may.
      const forbidden: Array<[number, number]> = [];
      for (const o of ownedOnsets) {
        if (o - TAW_FORBID_FRONT + 1 < lo) continue;
        if (o - TAW_FORBID_BACK > hi) break;
        const fLo = Math.max(lo, o - TAW_FORBID_BACK);
        const fHi = Math.min(hi, o - TAW_FORBID_FRONT);
        if (fLo <= fHi) forbidden.push([fLo, fHi]);
      }
      const allowed: Array<[number, number]> = [];
      let cursor = lo;
      for (const [fLo, fHi] of forbidden) {
        if (fLo > cursor) allowed.push([cursor, fLo - 1]);
        cursor = Math.max(cursor, fHi + 1);
      }
      if (cursor <= hi) allowed.push([cursor, hi]);

      if (allowed.length === 0) {
        // Deterministic fallback: nearest band-edge point to the nominal.
        const points: number[] = [];
        for (const o of ownedOnsets) {
          if (o - TAW_FORBID_BACK - searchDelta > nominal) break;
          if (o - TAW_FORBID_FRONT + searchDelta < nominal) continue;
          const pBack = o - TAW_FORBID_BACK - 1;
          const pFront = o - TAW_FORBID_FRONT + 1;
          if (pBack >= 0 && pBack <= maxCandidateStart) points.push(pBack);
          if (pFront >= 0 && pFront <= maxCandidateStart) points.push(pFront);
        }
        let fallback = nominal;
        let bestDist = Infinity;
        for (const p of points) {
          const d = Math.abs(p - nominal);
          if (d < bestDist || (d === bestDist && p < fallback)) { bestDist = d; fallback = p; }
        }
        best = Math.max(0, Math.min(maxCandidateStart, fallback));
        if (Math.abs(best - nominal) > 64) insertCP(k, best - k * analysisHop);
      } else {
        // Same similarity search as WSOLA (ties keep the earliest candidate),
        // restricted to allowed intervals.
        best = allowed[0][0];
        let bestScore = -Infinity;
        for (const [aLo, aHi] of allowed) {
          for (let candidate = aLo; candidate <= aHi; candidate += 1) {
            let score = 0;
            for (let ch = 0; ch < channelCount; ch += 1) {
              const data = padded[ch];
              const tail = tails[ch];
              for (let t = 0; t < scoreTaps; t += 1) {
                const i = t * scoreStride;
                score += data[candidate + i] * tail[i];
              }
            }
            if (score > bestScore) { bestScore = score; best = candidate; }
          }
        }
        if (Math.abs(best - nominal) > searchDelta + 64) insertCP(k, best - k * analysisHop);
      }
    }

    // Overlap-add the windowed frame and capture its windowed tail as the
    // next correlation target (identical to WSOLA).
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
 *  and every audio backend stay interchangeable (same seam as WSOLA). The
 *  source buffer is never mutated. */
export const tawStretchAudioBuffer = (
  buffer: AudioBuffer,
  ratio: number,
  createBuffer: (numberOfChannels: number, length: number, sampleRate: number) => AudioBuffer
): AudioBuffer => {
  assertSupportedRatio(ratio);
  if (!buffer || typeof buffer.getChannelData !== 'function' || typeof buffer.numberOfChannels !== 'number') {
    throw new TransientAwareStretchError('invalid-buffer', 'Transient-aware stretch needs a real AudioBuffer source.');
  }
  if (!(buffer.sampleRate > 0)) {
    throw new TransientAwareStretchError('invalid-buffer', `The source buffer has an unusable sample rate (${String(buffer.sampleRate)}).`);
  }
  if (buffer.numberOfChannels < 1) {
    throw new TransientAwareStretchError('invalid-buffer', 'The source buffer has no channels to stretch.');
  }
  if (buffer.length === 0) {
    throw new TransientAwareStretchError('empty-buffer', 'The audio buffer is empty — nothing to stretch.');
  }

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) channels.push(buffer.getChannelData(ch));

  const stretched = tawStretchChannels(channels, ratio);
  const output = createBuffer(buffer.numberOfChannels, stretched.length, buffer.sampleRate);
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    output.getChannelData(ch).set(stretched.channels[ch]);
  }
  return output;
};

/** Re-export so callers can catch either renderer's typed failure uniformly. */
export { WsolaTimeStretchError };
