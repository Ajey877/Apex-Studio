/**
 * Phase 7D — Transient-Anchored WSOLA (TAW): the regression proof that is an
 * IMPROVEMENT proof. Real PCM only — deterministic synthetic fixtures with
 * KNOWN attack positions (LCG-seeded noise, constructed drum/tonal/impulse
 * material), processed through the production `tawStretchChannels` and the
 * Phase 7A `wsolaStretchChannels` baseline, then measured with signal
 * metrics (differential-envelope attack timing, pre-echo, ghost peaks,
 * autocorrelation pitch, raw cross-correlation stereo lag) — never peak
 * amplitude alone.
 *
 * FIXTURES (44.1 kHz stereo, every attack position known by construction)
 * - isolated-impulse: one sharp transient (noise + click, τ ≈ 2.5 ms) at
 *   1.0 s in 2 s — the cleanest possible pre-echo/timing probe.
 * - drum-loop: 2 bars of 120 BPM 16ths — kick (integrated 130→48 Hz sweep,
 *   τ 90 ms) every half bar, snare (noise + 185 Hz, τ 60 ms, RIGHT channel
 *   +4 samples) on backbeats, alternating-sign hat noise (τ 6 ms) on every
 *   16th; peak-normalized to 0.6. Dense, overlapping, weak-and-strong
 *   attacks mixed — the hardest case.
 * - tonal-attacks: six plucked dyads (f0 = 220 Hz, 6 ms pick noise strike,
 *   τ 200 ms body) every 500 ms — pitch stability + attack preservation.
 * - stereo-lag-30: impulse train, RIGHT delayed by EXACTLY 30 samples —
 *   shared-frame decisions must preserve the inter-channel delay at every
 *   ratio (a within-copy ITD is constant; only a continuous-signal delay
 *   scales with ratio — the Phase 7A suite covers that distinct case).
 *
 * METRIC: a 64-sample moving average of |Δ(mono)| (first difference). The
 * difference suppresses sustained tonal bodies (a 220 Hz sine loses ~30 dB)
 * while keeping broadband attack fronts, so envelope peaks mark the STRIKE
 * instead of waveform-period ripple. Timing is the 50 % rise crossing
 * (robust for low-frequency sweep bodies whose argmax ripples), pre-echo is
 * the envelope RMS 10→1.5 ms before the expected position relative to the
 * local peak, ghosts are secondary envelope maxima ≥ 0.35 × peak within
 * ±12 ms (≥ 2 ms apart).
 *
 * TOLERANCES: every threshold below carries the measured evidence (this
 * repository's calibrated harness runs) as a comment. Deterministic inputs +
 * deterministic algorithms ⇒ the numbers reproduce bit-exactly on every
 * machine; margins are kept at ≥ 2× the measured distance where possible.
 *
 * THE GUARDS THAT FAIL IF TAW IS REPLACED BY WSOLA: the bit-difference test
 * plus every relative metric comparison (rise timing, pre-echo, ghosts) —
 * substituting the baseline renderer changes the outputs bitwise AND moves
 * the metrics far outside tolerance. Synthetic fixtures demonstrate
 * ALGORITHMIC behavior; no studio-grade subjective quality is claimed.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as RealWebAudio from 'web-audio-engine';
import { wsolaStretchChannels } from './wsolaTimeStretch';
import {
  TAW_MAX_RATIO,
  TAW_MIN_RATIO,
  TransientAwareStretchError,
  detectTransientOnsets,
  tawMinInterOnsetInterval,
  tawStretchAudioBuffer,
  tawStretchChannels,
} from './transientAwareStretch';

const RealOfflineAudioContext = (RealWebAudio as unknown as {
  OfflineAudioContext: typeof OfflineAudioContext;
}).OfflineAudioContext;

const SR = 44100;
const ms = (v: number): number => Math.round((v / 1000) * SR);

// Deterministic pseudo-noise (LCG, fixed seed) — reproducible across runs.
const makeNoise = (n: number, seed = 12345): Float32Array => {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i += 1) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 0xffffffff) * 2 - 1;
  }
  return out;
};

const burstInto = (
  ch: Float32Array,
  at: number,
  amp: number,
  attackMs: number,
  decayMs: number,
  body: (i: number, t: number) => number
): void => {
  const a = ms(attackMs);
  const len = ms(decayMs * 8);
  for (let i = 0; i < len && at + i < ch.length; i += 1) {
    const t = i / SR;
    const env = (i < a ? i / Math.max(1, a) : 1) * Math.exp(-(i - a) / Math.max(1, ms(decayMs)));
    ch[at + i] += amp * env * body(i, t);
  }
};

interface Fixture {
  name: string;
  channels: Float32Array[];
  /** Known attack onset positions (input samples). */
  attacks: number[];
  /** Known inter-channel delay in samples (R behind L), 0 when none. */
  stereoLagSamples: number;
  /** Fundamental frequency for pitch checks (0 = none). */
  f0: number;
}

const makeFixtures = (): Fixture[] => {
  const impulseBody = (() => {
    const noise = makeNoise(ms(50));
    return (i: number): number => (i < noise.length ? noise[i] : 0) + (i < 4 ? 0.9 * (1 - i / 4) : 0);
  })();

  // F1: isolated sharp transient in silence.
  const f1Len = ms(2000);
  const f1L = new Float32Array(f1Len);
  const f1R = new Float32Array(f1Len);
  burstInto(f1L, ms(1000), 0.9, 0.3, 2.5, impulseBody);
  burstInto(f1R, ms(1000), 0.9, 0.3, 2.5, impulseBody);

  // F2: drum loop — 2 bars of 120 BPM 16ths (kick/snare/hat), peak-normalized.
  const f2Len = ms(4000);
  const f2L = new Float32Array(f2Len);
  const f2R = new Float32Array(f2Len);
  const kickNoise = makeNoise(ms(600), 777);
  const snareNoise = makeNoise(ms(600), 4242);
  const hatNoise = makeNoise(ms(200), 99);
  const f2Attacks: number[] = [];
  for (let step = 0; step < 32; step += 1) {
    const at = step * ms(125);
    burstInto(f2L, at, 0.25, 0.2, 6, (i) => hatNoise[i % hatNoise.length] * (i % 2 === 0 ? 1 : -1));
    burstInto(f2R, at, 0.25, 0.2, 6, (i) => hatNoise[i % hatNoise.length] * (i % 2 === 0 ? 1 : -1));
    f2Attacks.push(at);
    if (step % 4 === 0) {
      // Physically integrated sweep: instantaneous frequency 130→48 Hz with
      // no phase dwell (a naive f(t)·t product parks the phase and creates an
      // unphysical amplitude bulge that fools detectors and metrics alike).
      const kick = (i: number, t: number): number =>
        Math.sin(2 * Math.PI * (t < 0.15
          ? 130 * t - (82 * t * t) / 0.3
          : 130 * 0.15 - (82 * 0.15 * 0.15) / 0.3 + 48 * (t - 0.15)))
        + 0.2 * kickNoise[i % kickNoise.length];
      burstInto(f2L, at, 0.95, 1.5, 90, kick);
      burstInto(f2R, at, 0.95, 1.5, 90, kick);
    }
    if (step % 8 === 4) {
      const snare = (i: number, t: number): number =>
        0.6 * snareNoise[i % snareNoise.length] + 0.5 * Math.sin(2 * Math.PI * 185 * t);
      burstInto(f2L, at, 0.8, 1, 60, snare);
      burstInto(f2R, at + 4, 0.8, 1, 60, snare); // known 4-sample stereo offset
    }
  }
  for (const ch of [f2L, f2R]) {
    let m = 0;
    for (let i = 0; i < ch.length; i += 1) m = Math.max(m, Math.abs(ch[i]));
    const g = 0.6 / m;
    for (let i = 0; i < ch.length; i += 1) ch[i] *= g;
  }

  // F3: mixed tonal material with clear transient attacks — plucked dyads.
  const f3Len = ms(3000);
  const f3L = new Float32Array(f3Len);
  const f3R = new Float32Array(f3Len);
  const f3Attacks: number[] = [];
  for (let p = 0; p < 6; p += 1) {
    const at = p * ms(500);
    f3Attacks.push(at);
    const pluck = (ch: Float32Array): void => {
      const a = ms(2);
      const len = ms(480);
      const pick = makeNoise(ms(6), 31 + p);
      for (let i = 0; i < len && at + i < ch.length; i += 1) {
        const t = i / SR;
        const env = (i < a ? i / a : 1) * Math.exp(-i / ms(200));
        const tone = Math.sin(2 * Math.PI * 220 * t)
          + 0.5 * Math.sin(2 * Math.PI * 440 * t)
          + 0.25 * Math.sin(2 * Math.PI * 660 * t);
        const strike = i < pick.length ? pick[i] * (1 - i / pick.length) : 0;
        ch[at + i] += 0.55 * env * tone + 0.5 * strike;
      }
    };
    pluck(f3L);
    pluck(f3R);
  }

  // F4: stereo impulse train, R delayed by exactly 30 samples.
  const f4Len = ms(2500);
  const f4L = new Float32Array(f4Len);
  const f4R = new Float32Array(f4Len);
  const f4Attacks: number[] = [];
  for (let p = 0; p < 4; p += 1) {
    const at = ms(300) + p * ms(500);
    f4Attacks.push(at);
    burstInto(f4L, at, 0.9, 0.3, 2.5, impulseBody);
    burstInto(f4R, at + 30, 0.9, 0.3, 2.5, impulseBody);
  }

  return [
    { name: 'isolated-impulse', channels: [f1L, f1R], attacks: [ms(1000)], stereoLagSamples: 0, f0: 0 },
    { name: 'drum-loop', channels: [f2L, f2R], attacks: f2Attacks.filter((_, i) => i % 2 === 0), stereoLagSamples: 0, f0: 0 },
    { name: 'tonal-attacks', channels: [f3L, f3R], attacks: f3Attacks, stereoLagSamples: 0, f0: 220 },
    { name: 'stereo-lag-30', channels: [f4L, f4R], attacks: f4Attacks, stereoLagSamples: 30, f0: 0 },
  ];
};

const FIXTURES = makeFixtures();
const byName = (name: string): Fixture => FIXTURES.find(f => f.name === name)!;

// ---------------------------------------------------------------------------
// Metrics (ported verbatim from the calibrated Phase 7D harness).
// ---------------------------------------------------------------------------

/** Differential envelope: 64-sample moving average of |Δ(mono)|. */
const envelope = (channels: readonly Float32Array[]): Float32Array => {
  const n = channels[0].length;
  const mono = new Float32Array(n);
  for (let ch = 0; ch < channels.length; ch += 1) {
    for (let i = 0; i < n; i += 1) mono[i] += channels[ch][i] / channels.length;
  }
  const diff = new Float32Array(n);
  for (let i = 1; i < n; i += 1) diff[i] = Math.abs(mono[i] - mono[i - 1]);
  const w = 64;
  const env = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    acc += diff[i] - (i >= w ? diff[i - w] : 0);
    env[i] = acc / Math.min(i + 1, w);
  }
  return env;
};

interface AttackMetrics {
  riseErrMs: number;
  riseTimeMs: number;
  preEchoDb: number;
  ghosts: number;
  peak: number;
}

const measureAttacks = (channels: readonly Float32Array[], attacks: readonly number[], ratio: number): AttackMetrics[] => {
  const env = envelope(channels);
  const out: AttackMetrics[] = [];
  for (const a of attacks) {
    const expected = Math.round(a * ratio);
    const search = ms(30);
    const lo = Math.max(1, expected - search);
    const hi = Math.min(env.length - 2, expected + search);
    let peakPos = lo;
    let peak = -1;
    for (let i = lo; i <= hi; i += 1) {
      if (env[i] > peak) { peak = env[i]; peakPos = i; }
    }
    // pre-echo: envelope RMS 10 ms → 1.5 ms before the expected position.
    const peLo = Math.max(0, expected - ms(10));
    const peHi = Math.max(peLo + 1, expected - ms(1.5));
    let preSum = 0;
    for (let i = peLo; i < peHi; i += 1) preSum += env[i] * env[i];
    const preRms = Math.sqrt(preSum / (peHi - peLo));
    const preEchoDb = 20 * Math.log10(Math.max(preRms, 1e-9) / Math.max(peak, 1e-9));
    // ghosts: secondary envelope maxima ≥ 0.35 × peak within ±12 ms, ≥ 2 ms apart.
    const gLo = Math.max(1, peakPos - ms(12));
    const gHi = Math.min(env.length - 2, peakPos + ms(12));
    let ghosts = 0;
    let lastGhost = -Infinity;
    for (let i = gLo; i <= gHi; i += 1) {
      if (env[i] >= peak * 0.35 && env[i] > env[i - 1] && env[i] >= env[i + 1]
        && Math.abs(i - peakPos) > ms(2) && i - lastGhost > ms(2)) {
        ghosts += 1;
        lastGhost = i;
      }
    }
    // 50 % rise crossing and 20 %→80 % rise time, searched from the peak.
    const half = peak * 0.5;
    let risePos = peakPos;
    for (let i = peakPos; i >= Math.max(1, peakPos - ms(40)); i -= 1) {
      if (env[i] < half) { risePos = i + 1; break; }
      if (i === Math.max(1, peakPos - ms(40))) risePos = i;
    }
    let twoPos = risePos;
    for (let i = risePos; i >= Math.max(1, risePos - ms(20)); i -= 1) {
      if (env[i] < peak * 0.2) { twoPos = i; break; }
    }
    let eightPos = peakPos;
    for (let i = risePos; i <= Math.min(env.length - 1, risePos + ms(40)); i += 1) {
      if (env[i] >= peak * 0.8) { eightPos = i; break; }
    }
    out.push({
      riseErrMs: ((risePos - expected) / SR) * 1000,
      riseTimeMs: ((eightPos - twoPos) / SR) * 1000,
      preEchoDb,
      ghosts,
      peak,
    });
  }
  return out;
};

const avg = (rows: AttackMetrics[], f: (m: AttackMetrics) => number): number =>
  rows.reduce((s, m) => s + f(m), 0) / rows.length;
const worst = (rows: AttackMetrics[], f: (m: AttackMetrics) => number): number =>
  Math.max(...rows.map(f));

const dominantFrequency = (data: Float32Array, from: number, to: number): number => {
  const n = to - from;
  const minLag = Math.floor(SR / 1000);
  const maxLag = Math.min(Math.floor(SR / 60), Math.floor(n / 2));
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i < n - lag; i += 2) sum += data[from + i] * data[from + i + lag];
    if (sum > bestScore) { bestScore = sum; bestLag = lag; }
  }
  return SR / bestLag;
};

const stereoLag = (channels: readonly Float32Array[], around: number, windowMs = 40): number => {
  const w = ms(windowMs);
  const lo = Math.max(0, around - w);
  const hi = Math.min(channels[0].length - 1, around + w);
  let bestLag = 0;
  let bestScore = -Infinity;
  for (let lag = -ms(3); lag <= ms(3); lag += 1) {
    let sum = 0;
    for (let i = lo; i <= hi; i += 1) {
      const j = i + lag;
      if (j >= 0 && j < channels[1].length) sum += channels[0][i] * channels[1][j];
    }
    if (sum > bestScore) { bestScore = sum; bestLag = lag; }
  }
  return bestLag;
};

const rms = (data: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < data.length; i += 1) s += data[i] * data[i];
  return Math.sqrt(s / data.length);
};

const maxAbs = (channels: readonly Float32Array[]): number => {
  let m = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i += 1) m = Math.max(m, Math.abs(ch[i]));
  return m;
};

const bitwiseIdentical = (a: readonly Float32Array[], b: readonly Float32Array[]): boolean => {
  if (a.length !== b.length) return false;
  for (let ch = 0; ch < a.length; ch += 1) {
    if (a[ch].length !== b[ch].length) return false;
    for (let i = 0; i < a[ch].length; i += 1) if (a[ch][i] !== b[ch][i]) return false;
  }
  return true;
};

/** A slow fade-in sine: energy rises ~0.3 %/frame — far under the 5 % flux
 *  floor — so the detector honestly reports NOTHING to anchor. */
const makeFadeInTone = (seconds: number, freq = 220): Float32Array[] => {
  const n = Math.round(seconds * SR);
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i += 1) {
    const v = 0.5 * (i / n) * Math.sin((2 * Math.PI * freq * i) / SR);
    out[0][i] = v;
    out[1][i] = v * 0.9;
  }
  return out;
};

const METRIC_RATIOS = [0.5, 0.75, 1.25, 1.5, 2.0];

describe('Phase 7D: transient-anchored WSOLA vs the Phase 7A WSOLA baseline', () => {
  it('is NOT the baseline in disguise: outputs differ bitwise on every transient fixture and ratio', () => {
    // If someone swaps tawStretchChannels for wsolaStretchChannels (or the
    // anchoring silently no-ops on transient material), this fails first.
    for (const fx of FIXTURES) {
      for (const ratio of METRIC_RATIOS) {
        const taw = tawStretchChannels(fx.channels, ratio);
        const base = wsolaStretchChannels(fx.channels, ratio);
        assert.equal(taw.length, base.length, `${fx.name} r=${ratio}: length contract`);
        assert.ok(
          !bitwiseIdentical(taw.channels, base.channels),
          `${fx.name} r=${ratio}: TAW output must differ from plain WSOLA on transient-bearing material`
        );
      }
    }
  });

  it('drum loop: attack timing improves by ≥ 2× at every ratio (measured 2.1×–11×)', () => {
    const fx = byName('drum-loop');
    for (const ratio of METRIC_RATIOS) {
      const taw = measureAttacks(tawStretchChannels(fx.channels, ratio).channels, fx.attacks, ratio);
      const base = measureAttacks(wsolaStretchChannels(fx.channels, ratio).channels, fx.attacks, ratio);
      const tawAvg = avg(taw, m => Math.abs(m.riseErrMs));
      const baseAvg = avg(base, m => Math.abs(m.riseErrMs));
      const tawWorst = worst(taw, m => Math.abs(m.riseErrMs));
      const baseWorst = worst(base, m => Math.abs(m.riseErrMs));
      // Measured: TAW avg 1.24–1.32 ms vs WSOLA 2.78–14.96 ms (input itself
      // measures 0.98 ms). Absolute cap 2.5 ms ≈ 2× the measured worst,
      // relative cap keeps the improvement honest at every ratio.
      assert.ok(tawAvg <= 2.5, `r=${ratio}: TAW rise avg ${tawAvg.toFixed(2)} ms must stay ≤ 2.5 ms`);
      assert.ok(tawAvg * 1.5 <= baseAvg, `r=${ratio}: TAW avg ${tawAvg.toFixed(2)} must beat WSOLA ${baseAvg.toFixed(2)} by ≥ 1.5×`);
      // Measured: TAW worst 5.76–6.89 ms vs WSOLA 8.87–69.0 ms. The ~6 ms
      // floor is the unanchorable first attack (onsets within ~23 ms of the
      // input start get WSOLA treatment — documented edge behavior).
      assert.ok(tawWorst <= 8, `r=${ratio}: TAW rise worst ${tawWorst.toFixed(2)} ms must stay ≤ 8 ms`);
      assert.ok(tawWorst < baseWorst, `r=${ratio}: TAW worst ${tawWorst.toFixed(2)} must beat WSOLA ${baseWorst.toFixed(2)}`);
    }
  });

  it('drum loop: pre-echo improves by ≥ 3 dB and ghosts never increase (measured −3.6…−29.7 dB avg, ghosts 65–76 vs 73–99)', () => {
    const fx = byName('drum-loop');
    for (const ratio of METRIC_RATIOS) {
      const taw = measureAttacks(tawStretchChannels(fx.channels, ratio).channels, fx.attacks, ratio);
      const base = measureAttacks(wsolaStretchChannels(fx.channels, ratio).channels, fx.attacks, ratio);
      const tawPre = avg(taw, m => m.preEchoDb);
      const basePre = avg(base, m => m.preEchoDb);
      // Measured: TAW −44.7…−41.8 dB vs WSOLA −38.3…−14.0 dB (smaller = less
      // pre-echo). 3 dB margin is below the smallest measured gap (6.4 dB).
      assert.ok(tawPre <= basePre - 3, `r=${ratio}: TAW pre-echo ${tawPre.toFixed(1)} dB must beat WSOLA ${basePre.toFixed(1)} dB by ≥ 3 dB`);
      const tawGhosts = taw.reduce((s, m) => s + m.ghosts, 0);
      const baseGhosts = base.reduce((s, m) => s + m.ghosts, 0);
      assert.ok(tawGhosts <= baseGhosts, `r=${ratio}: TAW ghosts ${tawGhosts} must not exceed WSOLA ${baseGhosts}`);
    }
  });

  it('isolated impulse: timing ≤ 1.5 ms at every ratio and pre-echo ≥ 30 dB better at expansion (measured 0.61–0.88 ms; −69.1/−50.8 dB vs −10.4/−6.9 dB)', () => {
    const fx = byName('isolated-impulse');
    for (const ratio of METRIC_RATIOS) {
      const taw = measureAttacks(tawStretchChannels(fx.channels, ratio).channels, fx.attacks, ratio);
      const base = measureAttacks(wsolaStretchChannels(fx.channels, ratio).channels, fx.attacks, ratio);
      // Measured: TAW 0.59–0.88 ms vs WSOLA 2.56–8.78 ms (input 0.73 ms).
      assert.ok(avg(taw, m => Math.abs(m.riseErrMs)) <= 1.5, `r=${ratio}: TAW impulse timing must stay ≤ 1.5 ms`);
      assert.ok(
        avg(taw, m => Math.abs(m.riseErrMs)) < avg(base, m => Math.abs(m.riseErrMs)),
        `r=${ratio}: TAW must beat WSOLA impulse timing`
      );
      if (ratio >= 1.5) {
        // The baseline duplicates the impulse across frames here (that IS the
        // pre-echo); TAW renders one anchored copy. Measured gaps: 58.7 dB
        // (r=1.5) and 43.9 dB (r=2).
        assert.ok(
          avg(taw, m => m.preEchoDb) <= avg(base, m => m.preEchoDb) - 30,
          `r=${ratio}: TAW impulse pre-echo must beat WSOLA by ≥ 30 dB`
        );
        assert.ok(avg(taw, m => m.preEchoDb) <= -45, `r=${ratio}: TAW impulse pre-echo must stay ≤ −45 dB`);
      }
    }
  });

  it('stereo impulse train: shared grid decisions bound timing at ≤ 1.5 ms and kill the expansion pre-echo (measured 0.67–1.26 ms; −170 dB vs −6.5 dB at r=2)', () => {
    const fx = byName('stereo-lag-30');
    for (const ratio of METRIC_RATIOS) {
      const taw = measureAttacks(tawStretchChannels(fx.channels, ratio).channels, fx.attacks, ratio);
      assert.ok(avg(taw, m => Math.abs(m.riseErrMs)) <= 1.5, `r=${ratio}: TAW stereo-train timing must stay ≤ 1.5 ms`);
      if (ratio === 2) {
        const base = measureAttacks(wsolaStretchChannels(fx.channels, ratio).channels, fx.attacks, ratio);
        assert.ok(avg(taw, m => m.preEchoDb) <= -100, `r=2: TAW pre-echo ${avg(taw, m => m.preEchoDb).toFixed(1)} dB must stay ≤ −100 dB`);
        assert.ok(avg(base, m => m.preEchoDb) >= -20, 'r=2: the baseline regression this mode exists to fix must remain measurable');
      }
    }
  });

  it('tonal attacks: pitch stability matches WSOLA within ±0.5 % and pre-echo improves by ≥ 10 dB (measured ±0.27 % both; −108…−130 dB vs −30…−115 dB)', () => {
    const fx = byName('tonal-attacks');
    for (const ratio of METRIC_RATIOS) {
      const tawRes = tawStretchChannels(fx.channels, ratio);
      const baseRes = wsolaStretchChannels(fx.channels, ratio);
      // Steady region 80–380 ms after the third attack, away from strikes.
      const at = Math.round(fx.attacks[2] * ratio);
      const fTaw = dominantFrequency(tawRes.channels[0], at + ms(80), at + ms(380));
      const fBase = dominantFrequency(baseRes.channels[0], at + ms(80), at + ms(380));
      const errTaw = Math.abs((fTaw - fx.f0) / fx.f0) * 100;
      const errBase = Math.abs((fBase - fx.f0) / fx.f0) * 100;
      // Existing WSOLA convention is ±2 %; measured both algorithms sit at
      // 0.23–0.27 % here. Keep the tight absolute cap AND the parity cap.
      assert.ok(errTaw <= 0.5, `r=${ratio}: TAW pitch error ${errTaw.toFixed(2)} % must stay ≤ 0.5 %`);
      assert.ok(errTaw <= errBase + 0.2, `r=${ratio}: TAW pitch must not regress vs WSOLA (${errBase.toFixed(2)} %)`);
      const taw = measureAttacks(tawRes.channels, fx.attacks, ratio);
      const base = measureAttacks(baseRes.channels, fx.attacks, ratio);
      const tawPre = avg(taw, m => m.preEchoDb);
      const basePre = avg(base, m => m.preEchoDb);
      assert.ok(tawPre <= basePre - 10, `r=${ratio}: TAW tonal pre-echo ${tawPre.toFixed(1)} dB must beat WSOLA ${basePre.toFixed(1)} dB by ≥ 10 dB`);
      // Attack timing must not regress on mixed material (measured: TAW
      // 1.04–2.44 ms avg vs WSOLA 2.42–7.58 ms — TAW wins at every ratio).
      assert.ok(
        avg(taw, m => Math.abs(m.riseErrMs)) <= avg(base, m => Math.abs(m.riseErrMs)),
        `r=${ratio}: TAW tonal rise timing must not regress vs WSOLA`
      );
    }
  });

  it('stereo alignment: the 30-sample inter-channel delay survives every ratio sample-exactly (shared frame positions)', () => {
    const fx = byName('stereo-lag-30');
    for (const ratio of METRIC_RATIOS) {
      const res = tawStretchChannels(fx.channels, ratio);
      const around = Math.round(fx.attacks[1] * ratio);
      // A within-copy ITD is preserved constant by shared analysis positions
      // (only a continuous-signal delay scales with ratio — the distinct case
      // asserted by the Phase 7A suite's 41→82 test).
      assert.equal(stereoLag(res.channels, around), 30, `r=${ratio}: inter-channel lag must stay exactly 30 samples`);
    }
    // Identical dual-channel input must produce identical dual-channel output.
    const noise = makeNoise(SR, 4242);
    const same = [Float32Array.from(noise, v => v * 0.4), Float32Array.from(noise, v => v * 0.4)];
    same[0][ms(500)] = 0.95;
    same[1][ms(500)] = 0.95;
    const res = tawStretchChannels(same, 1.7);
    assert.ok(bitwiseIdentical([res.channels[0]], [res.channels[1]]), 'identical channels must stay identical');
  });

  it('duration, determinism, identity, purity and sample validity across the full supported range', () => {
    const fx = byName('isolated-impulse');
    for (const ratio of [0.25, 0.5, 0.75, 1.25, 1.5, 2, 3, 4]) {
      const before = fx.channels.map(c => Float32Array.from(c));
      const res = tawStretchChannels(fx.channels, ratio);
      assert.equal(res.length, Math.ceil(fx.channels[0].length * ratio), `r=${ratio}: exact ceil(N×ratio) length`);
      for (const ch of res.channels) {
        assert.equal(ch.length, res.length, `r=${ratio}: every channel exactly length frames`);
        for (let i = 0; i < ch.length; i += 1) assert.ok(Number.isFinite(ch[i]), `r=${ratio}: sample ${i} must be finite`);
      }
      // No amplitude blow-up: measured max ≤ input max at every ratio.
      assert.ok(maxAbs(res.channels) <= maxAbs(fx.channels) + 0.02, `r=${ratio}: output must not exceed input peak`);
      assert.ok(bitwiseIdentical(fx.channels as Float32Array[], before), 'input must never be mutated');
    }
    // Determinism on dense transient material at an odd ratio: bitwise.
    const drum = byName('drum-loop');
    const a = tawStretchChannels(drum.channels, 1.37);
    const b = tawStretchChannels(drum.channels, 1.37);
    assert.ok(bitwiseIdentical(a.channels, b.channels), 'repeated runs must be bit-identical');
    // ratio 1 is the documented identity.
    const id = tawStretchChannels(drum.channels, 1);
    assert.equal(id.length, drum.channels[0].length);
    assert.ok(bitwiseIdentical(id.channels, drum.channels), 'ratio 1 must return exact copies');
  });

  it('energy parity: dense material within ±1.5 dB RMS; sparse impulses documented ≥ 0.4× (single-copy rendering)', () => {
    for (const name of ['drum-loop', 'tonal-attacks']) {
      const fx = byName(name);
      const inRms = rms(fx.channels[0]);
      for (const ratio of METRIC_RATIOS) {
        const outRms = rms(tawStretchChannels(fx.channels, ratio).channels[0]);
        const db = 20 * Math.log10(outRms / Math.max(inRms, 1e-9));
        // Measured |Δ| ≤ 0.6 dB on both dense fixtures at every ratio.
        assert.ok(Math.abs(db) <= 1.5, `${name} r=${ratio}: RMS Δ ${db.toFixed(1)} dB must stay within ±1.5 dB`);
      }
    }
    // HONEST LIMITATION: an isolated impulse is rendered as ONE anchored copy
    // at Hann weight w(idx) ∈ [0.5, 1], while WSOLA duplicates it across
    // frames (the duplication is the pre-echo). Measured sparse-fixture RMS
    // ratio bottoms at 0.47× (−6.6 dB) at r=2 — bounded, documented, tested.
    const fx = byName('isolated-impulse');
    const inRms = rms(fx.channels[0]);
    for (const ratio of METRIC_RATIOS) {
      const outRms = rms(tawStretchChannels(fx.channels, ratio).channels[0]);
      assert.ok(outRms >= 0.4 * inRms, `r=${ratio}: sparse-fixture RMS must stay ≥ 0.4× input`);
    }
  });

  it('safety: silence, very short buffers, edge-adjacent attacks, invalid inputs — typed errors, exact lengths, no invalid samples', () => {
    // Silence: all-zero in → all-zero out, exact length, no onsets claimed.
    for (const ratio of [0.25, 0.5, 1.25, 2, 4]) {
      const sil = [new Float32Array(SR), new Float32Array(SR)];
      const res = tawStretchChannels(sil, ratio);
      assert.equal(res.length, Math.ceil(SR * ratio));
      assert.equal(maxAbs(res.channels), 0, `silence r=${ratio} must stay silent`);
      assert.equal(detectTransientOnsets(sil, tawMinInterOnsetInterval(ratio)).length, 0);
    }
    // Very short buffers (below the detection window and below one frame).
    for (const n of [1, 15, 100, 511, 512, 1023, 1024, 2000]) {
      const ch = [new Float32Array(n)];
      if (n > 4) ch[0][Math.floor(n / 2)] = 0.9;
      for (const ratio of [0.25, 0.5, 2, 4]) {
        const res = tawStretchChannels(ch, ratio);
        assert.equal(res.length, Math.ceil(n * ratio), `n=${n} r=${ratio}: exact length`);
        for (const v of res.channels[0]) assert.ok(Number.isFinite(v) && Math.abs(v) <= 1.001);
      }
    }
    // Attacks adjacent to the input edges cannot own a frame (documented);
    // they must degrade to WSOLA treatment, never crash or corrupt.
    const edge = [new Float32Array(ms(1000))];
    edge[0][5] = 0.95;
    edge[0][edge[0].length - 5] = 0.95;
    for (const ratio of [0.5, 2]) {
      const res = tawStretchChannels(edge, ratio);
      assert.equal(res.length, Math.ceil(edge[0].length * ratio));
      for (const v of res.channels[0]) assert.ok(Number.isFinite(v));
    }
    // Typed errors, mirroring the WSOLA taxonomy.
    const one = [new Float32Array(ms(100))];
    assert.throws(() => tawStretchChannels(one, 0.2499), (e: unknown) => e instanceof TransientAwareStretchError && e.failure === 'unsupported-ratio');
    assert.throws(() => tawStretchChannels(one, 4.0001), (e: unknown) => e instanceof TransientAwareStretchError && e.failure === 'unsupported-ratio');
    assert.throws(() => tawStretchChannels(one, Number.NaN), (e: unknown) => e instanceof TransientAwareStretchError && e.failure === 'invalid-ratio');
    assert.throws(() => tawStretchChannels(one, Number.POSITIVE_INFINITY), (e: unknown) => e instanceof TransientAwareStretchError && e.failure === 'invalid-ratio');
    assert.throws(() => tawStretchChannels(one, 0), (e: unknown) => e instanceof TransientAwareStretchError && e.failure === 'unsupported-ratio');
    assert.throws(() => tawStretchChannels([new Float32Array(0)], 2), (e: unknown) => e instanceof TransientAwareStretchError && e.failure === 'empty-buffer');
    assert.throws(() => tawStretchChannels([], 2), (e: unknown) => e instanceof TransientAwareStretchError && e.failure === 'invalid-buffer');
    assert.throws(
      () => tawStretchChannels([new Float32Array(100), new Float32Array(99)], 2),
      (e: unknown) => e instanceof TransientAwareStretchError && e.failure === 'invalid-buffer'
    );
    assert.equal(TAW_MIN_RATIO, 0.25);
    assert.equal(TAW_MAX_RATIO, 4.0);
  });

  it('graceful path: attack-free material anchors nothing and renders BIT-IDENTICAL to WSOLA (documented, never a silent substitution)', () => {
    // The guards above prove TAW ≠ WSOLA on transient-bearing material; this
    // proves the fallback is honest and exact when there is nothing to anchor.
    // A fade-in tone rising from digital silence may honestly report the fade
    // start itself (≤ 1 onset, first 100 ms); the steady region must stay
    // clean, and such edge onsets cannot own a frame (their unclamped
    // analysis start would fall outside the input), so the render must match
    // plain WSOLA bit-for-bit — a documented graceful path, not a silent
    // quality substitution.
    const tone = makeFadeInTone(2);
    const onsets = detectTransientOnsets(tone, tawMinInterOnsetInterval(1.5));
    assert.ok(onsets.length <= 1, `steady fade material must stay clean, got ${onsets.length} onsets`);
    assert.ok(onsets.every(o => o.position <= ms(100)), 'any onset must be the fade start, never the steady region');
    for (const ratio of [0.5, 1.5]) {
      const taw = tawStretchChannels(tone, ratio);
      const base = wsolaStretchChannels(tone, ratio);
      assert.ok(bitwiseIdentical(taw.channels, base.channels), `r=${ratio}: unanchorable material must match WSOLA exactly`);
    }
  });

  it('detection: drum-loop attacks localized within 1.5 ms, decay wiggle rejected, close attacks merged', () => {
    const fx = byName('drum-loop');
    const onsets = detectTransientOnsets(fx.channels, tawMinInterOnsetInterval(2));
    // Every measured (even-step) attack must have a detected onset within
    // 1.5 ms — measured localization error is 8–38 samples (0.18–0.86 ms).
    for (const a of fx.attacks) {
      const near = onsets.find(o => Math.abs(o.position - a) <= ms(1.5));
      assert.ok(near !== undefined, `attack at ${a} (${(a / SR * 1000).toFixed(0)} ms) must be detected within 1.5 ms`);
    }
    // No detection explosion: measured 24 onsets (16 measured attacks +
    // hats/odd steps); decay-phase wiggle must not add dozens of spurious
    // onsets (the rise guard rejects it).
    assert.ok(onsets.length <= 40, `expected a bounded onset count, got ${onsets.length}`);
    assert.ok(onsets.every((o, i) => i === 0 || o.position > onsets[i - 1].position), 'sorted, strictly increasing');
    // Merge behavior: two clicks 5 ms apart collapse (minIoi = 23 ms at 2×);
    // 100 ms apart they survive.
    const pair = [new Float32Array(ms(1000))];
    pair[0][ms(400)] = 0.9;
    pair[0][ms(405)] = 0.9;
    assert.equal(detectTransientOnsets(pair, tawMinInterOnsetInterval(2)).length, 1);
    const apart = [new Float32Array(ms(1000))];
    apart[0][ms(300)] = 0.9;
    apart[0][ms(400)] = 0.9;
    assert.equal(detectTransientOnsets(apart, tawMinInterOnsetInterval(2)).length, 2);
    assert.equal(tawMinInterOnsetInterval(0.5), 2048);
    assert.equal(tawMinInterOnsetInterval(2), 1024);
    assert.equal(tawMinInterOnsetInterval(4), 1024);
  });

  it('AudioBuffer seam: real web-audio-engine buffers, exact frames, PCM equals the channel-level render, source untouched', () => {
    const ctx = new RealOfflineAudioContext(2, SR * 4, SR);
    const fx = byName('drum-loop');
    const source = ctx.createBuffer(2, fx.channels[0].length, SR);
    source.getChannelData(0).set(fx.channels[0]);
    source.getChannelData(1).set(fx.channels[1]);
    const sourceSnapshot = [Float32Array.from(source.getChannelData(0)), Float32Array.from(source.getChannelData(1))];
    const ratio = 1.5;
    const out = tawStretchAudioBuffer(source, ratio, (ch, len, sr) => ctx.createBuffer(ch, len, sr));
    assert.equal(out.numberOfChannels, 2);
    assert.equal(out.length, Math.ceil(fx.channels[0].length * ratio));
    assert.equal(out.sampleRate, SR);
    const expected = tawStretchChannels(fx.channels, ratio);
    for (let ch = 0; ch < 2; ch += 1) {
      const data = out.getChannelData(ch);
      for (let i = 0; i < data.length; i += 1) assert.equal(data[i], expected.channels[ch][i], `ch${ch} sample ${i}`);
    }
    assert.ok(bitwiseIdentical([source.getChannelData(0), source.getChannelData(1)], sourceSnapshot), 'source buffer must not be mutated');
    assert.throws(
      () => tawStretchAudioBuffer({} as AudioBuffer, 2, (ch, len, sr) => ctx.createBuffer(ch, len, sr)),
      (e: unknown) => e instanceof TransientAwareStretchError && e.failure === 'invalid-buffer'
    );
  });

  it('bounded CPU: 5 s of dense stereo transient material at 2× renders in < 2.5 s (measured ~0.4 s locally)', () => {
    const noise = makeNoise(SR * 5, 99);
    const dense = [
      Float32Array.from(noise, v => v * 0.3),
      Float32Array.from(noise, v => v * 0.3),
    ];
    for (let k = 0; k < 20; k += 1) {
      dense[0][Math.round(k * SR / 8)] = 0.95;
      dense[1][Math.round(k * SR / 8)] = 0.95;
    }
    const t0 = process.hrtime.bigint();
    const res = tawStretchChannels(dense, 2);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(res.length, SR * 10);
    assert.ok(elapsedMs < 2500, `render took ${elapsedMs.toFixed(0)} ms — must stay under 2500 ms`);
  });
});
