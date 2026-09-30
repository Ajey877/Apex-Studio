import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  designKWeighting,
  KWeightingFilter,
  LoudnessMeter,
} from './loudnessMeasurement.ts';

/**
 * Every expected value below is derived from ITU-R BS.1770-4 itself, not from
 * this implementation: the 1 kHz anchor, the K-weighting table published in
 * the recommendation, and closed-form results for pure tones.
 */

const SAMPLE_RATE = 48000;
/** Amplitude of a sine whose RMS power is `dbfs` (RMS reference, not peak). */
function sineAmplitudeForRms(dbfs: number): number {
  return Math.SQRT2 * 10 ** (dbfs / 20);
}

function tone(rate: number, seconds: number, hz: number, amplitude: number, phase = 0): Float64Array {
  const length = Math.floor(seconds * rate);
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) out[i] = amplitude * Math.sin(2 * Math.PI * hz * i / rate + phase);
  return out;
}

function measure(signal: { left: Float64Array; right: Float64Array }, rate = SAMPLE_RATE, options = {}) {
  const meter = new LoudnessMeter(rate, options);
  const chunk = 128;
  for (let start = 0; start < signal.left.length; start += chunk) {
    meter.pushFrame(
      signal.left.subarray(start, start + chunk),
      signal.right.subarray(start, start + chunk),
    );
  }
  return meter.getReading();
}

describe('Phase 45: K-weighting coefficients (BS.1770-4)', () => {
  it('reproduces the filter table published for 48 kHz', () => {
    const { highShelf, highPass } = designKWeighting(48000);
    // ITU-R BS.1770-4 stage 1 (high shelf) and stage 2 (RLB high-pass).
    assert.ok(Math.abs(highShelf.b0 - 1.53512485958697) < 1e-9);
    assert.ok(Math.abs(highShelf.b1 + 2.69169618940638) < 1e-9);
    assert.ok(Math.abs(highShelf.b2 - 1.19839281085285) < 1e-9);
    assert.ok(Math.abs(highShelf.a1 + 1.69065929318241) < 1e-9);
    assert.ok(Math.abs(highShelf.a2 - 0.73248077421585) < 1e-9);
    assert.ok(Math.abs(highPass.a1 + 1.99004745638735) < 1e-5);
    assert.ok(Math.abs(highPass.a2 - 0.99007268354808) < 1e-5);
  });

  it('is derived per sample rate instead of assuming 48 kHz', () => {
    const at48 = designKWeighting(48000);
    const at441 = designKWeighting(44100);
    assert.notDeepEqual(at48.highShelf, at441.highShelf, 'coefficients must change with the sample rate');
    assert.notDeepEqual(at48.highPass, at441.highPass);
  });

  it('has the +0.691 dB gain at 1 kHz that the LUFS anchor cancels, and +4 dB shelving', () => {
    const responseAt = (hz: number, rate: number) => {
      const { highShelf, highPass } = designKWeighting(rate);
      const stage = (c: typeof highShelf) => {
        const w = 2 * Math.PI * hz / rate;
        const real = c.b0 + c.b1 * Math.cos(w) + c.b2 * Math.cos(2 * w);
        const imag = -(c.b1 * Math.sin(w) + c.b2 * Math.sin(2 * w));
        const dReal = 1 + c.a1 * Math.cos(w) + c.a2 * Math.cos(2 * w);
        const dImag = -(c.a1 * Math.sin(w) + c.a2 * Math.sin(2 * w));
        return Math.hypot(real, imag) / Math.hypot(dReal, dImag);
      };
      return 20 * Math.log10(stage(highShelf) * stage(highPass));
    };
    // The -0.691 dB LUFS offset exists because K-weighting gains +0.691 dB at
    // 1 kHz; the shelf plateaus at +4 dB; and low frequencies are removed.
    assert.ok(Math.abs(responseAt(1000, 48000) - 0.691) < 0.02, `1 kHz gain was ${responseAt(1000, 48000)}`);
    assert.ok(Math.abs(responseAt(16000, 48000) - 4.0) < 0.1, `HF shelf gain was ${responseAt(16000, 48000)}`);
    assert.ok(responseAt(50, 48000) < -3.5, `50 Hz attenuation was ${responseAt(50, 48000)}`);
    assert.ok(responseAt(20, 48000) < -12.0, `20 Hz attenuation was ${responseAt(20, 48000)}`);
    // Rate-adaptive: the same acoustic frequency must weigh the same.
    assert.ok(Math.abs(responseAt(50, 44100) - responseAt(50, 48000)) < 0.05);
  });

  it('rejects a nonsense sample rate instead of silently mis-measuring', () => {
    assert.throws(() => designKWeighting(0), RangeError);
    assert.throws(() => new LoudnessMeter(Number.NaN), RangeError);
  });

  it('filters a DC input down to silence (RLB high-pass working)', () => {
    const filter = new KWeightingFilter(48000);
    let last = 1;
    for (let i = 0; i < 200000; i++) last = filter.process(1);
    assert.ok(Math.abs(last) < 1e-6, `DC did not decay: ${last}`);
  });
});

describe('Phase 45: loudness reference tones', () => {
  it('reads -20.0 LUFS for a 1 kHz sine at -20 dBFS RMS in one channel', () => {
    const left = tone(48000, 10, 1000, sineAmplitudeForRms(-20));
    const right = new Float64Array(left.length);
    const reading = measure({ left, right });
    assert.ok(
      Math.abs((reading.integratedLufs ?? Number.NaN) - (-20.0)) <= 0.2,
      `integrated was ${reading.integratedLufs}`,
    );
    assert.ok(Math.abs((reading.momentaryLufs ?? Number.NaN) - (-20.0)) <= 0.2);
    assert.ok(Math.abs((reading.shortTermLufs ?? Number.NaN) - (-20.0)) <= 0.2);
  });

  it('adds the second channel: the same tone in L and R is 3.01 dB louder', () => {
    // BS.1770-4 sums weighted per-channel powers, Y = sum(g_i * P_i). A meter
    // that folds the channels down to mono before measuring cannot produce
    // this 3.01 dB step - the fabricated predecessor read both cases as the
    // single-channel level.
    const left = tone(48000, 10, 1000, sineAmplitudeForRms(-20));
    const mono = measure({ left, right: new Float64Array(left.length) });
    const stereo = measure({ left, right: left.slice() });
    const delta = (stereo.integratedLufs ?? 0) - (mono.integratedLufs ?? 0);
    assert.ok(Math.abs(delta - 3.01) <= 0.2, `channel summation gave ${delta.toFixed(2)} dB`);
  });

  it('attenuates 50 Hz relative to 1 kHz by the K-weighting difference, not by 0 dB', () => {
    // K(50 Hz) = -3.93 dB and K(1 kHz) = +0.70 dB at equal RMS power, so the
    // low tone must read ~4.6 dB quieter. An unweighted RMS meter reads the two
    // as identical, which is the defect under repair.
    const left = tone(48000, 10, 50, sineAmplitudeForRms(-20));
    const reading = measure({ left, right: new Float64Array(left.length) });
    assert.ok(
      Math.abs((reading.integratedLufs ?? Number.NaN) - (-24.6)) <= 0.3,
      `50 Hz tone measured ${reading.integratedLufs} LUFS`,
    );
    const delta = (reading.integratedLufs ?? 0) - (-20.0);
    assert.ok(delta < -4.0, `expected >4 dB of low-frequency attenuation, got ${delta.toFixed(2)}`);
  });

  it('weighs a bright tone up by the HF shelf', () => {
    const left = tone(48000, 10, 4000, sineAmplitudeForRms(-20));
    const reading = measure({ left, right: new Float64Array(left.length) });
    assert.ok(
      Math.abs((reading.integratedLufs ?? Number.NaN) - (-16.7)) <= 0.3,
      `4 kHz tone measured ${reading.integratedLufs} LUFS`,
    );
  });

  it('doubles the reading power-law: +6.02 dB of level is +6.0 dB of loudness', () => {
    const quiet = tone(48000, 5, 1000, sineAmplitudeForRms(-26));
    const loud = tone(48000, 5, 1000, sineAmplitudeForRms(-20));
    const a = measure({ left: quiet, right: new Float64Array(quiet.length) });
    const b = measure({ left: loud, right: new Float64Array(loud.length) });
    assert.ok(Math.abs((b.integratedLufs! - a.integratedLufs!) - 6.0) <= 0.2);
  });

  it('agrees between 44.1 kHz and 48 kHz for the same acoustic signal', () => {
    for (const rate of [44100, 48000]) {
      const left = tone(rate, 10, 1000, sineAmplitudeForRms(-20));
      const reading = measure({ left, right: new Float64Array(left.length) }, rate);
      assert.ok(Math.abs((reading.integratedLufs ?? Number.NaN) - (-20.0)) <= 0.2, `${rate} Hz -> ${reading.integratedLufs}`);
    }
  });
});

describe('Phase 45: silence, gating and accumulation', () => {
  it('reports no loudness at all for digital silence', () => {
    const zero = new Float64Array(48000 * 5);
    const reading = measure({ left: zero, right: zero.slice() });
    assert.equal(reading.momentaryLufs, null);
    assert.equal(reading.shortTermLufs, null);
    assert.equal(reading.integratedLufs, null);
    assert.equal(reading.gatedBlockCount, 0);
    assert.ok(reading.blockCount > 0, 'blocks must still be produced so the meter is provably running');
  });

  it('reports nothing before a single block has been received', () => {
    const meter = new LoudnessMeter(48000);
    const reading = meter.getReading();
    assert.equal(reading.integratedLufs, null);
    assert.equal(reading.isMeasuring, false);
    assert.equal(reading.blockCount, 0);
    meter.pushFrame(new Float64Array(128), new Float64Array(128));
    assert.equal(meter.getReading().blockCount, 0, 'a 400 ms block must not appear from 2.7 ms of audio');
  });

  it('gates silence out of the integrated value instead of averaging it in', () => {
    const rate = 48000;
    const seconds = 20;
    const length = Math.floor(seconds * rate);
    const left = new Float64Array(length);
    const right = new Float64Array(length);
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      const on = t >= 5 && t < 15;
      left[i] = on ? 0.1 * Math.sin(2 * Math.PI * 200 * t) : 0;
      right[i] = left[i];
    }
    const reading = measure({ left, right });
    const toneLufs = -21.1;
    // 15 % of the blocks are silence; folding them in unweighted would pull the
    // average down by 10*log10(197/103) = 2.8 dB. Gating must not.
    assert.ok(
      Math.abs((reading.integratedLufs ?? Number.NaN) - toneLufs) <= 0.3,
      `gated integrated was ${reading.integratedLufs}`,
    );
    assert.ok(reading.blockCount >= 190, `block count was ${reading.blockCount}`);
    assert.ok(
      reading.gatedBlockCount < reading.blockCount - 50,
      `expected the silent blocks to be gated out, saw ${reading.gatedBlockCount}/${reading.blockCount}`,
    );
    const dilution = 10 * Math.log10(reading.blockCount / reading.gatedBlockCount);
    assert.ok(dilution > 2.0, `expected >=2 dB of silence to have been excluded, got ${dilution.toFixed(2)}`);
  });

  it('accumulates integrated loudness over the session rather than tracking momentary', () => {
    const rate = 48000;
    const meter = new LoudnessMeter(rate);
    const chunk = 128;
    const push = (signal: Float64Array, other: Float64Array) => {
      for (let start = 0; start < signal.length; start += chunk) {
        meter.pushFrame(signal.subarray(start, start + chunk), other.subarray(start, start + chunk));
      }
    };
    const loud = tone(rate, 5, 200, sineAmplitudeForRms(-14));
    const quiet = tone(rate, 5, 200, sineAmplitudeForRms(-24));
    push(loud, loud.slice());
    const afterLoud = meter.getReading();
    push(quiet, quiet.slice());
    const afterQuiet = meter.getReading();

    // Momentary follows the current 400 ms exactly; integrated is a gated
    // average of everything since the reset, so it may only move a fraction.
    // The tone is present in both channels at -14 / -24 dBFS RMS, so the
    // programme level is -14 + 3.01 + 0.70 - 0.69 = -11.98 LUFS (and -21.98).
    assert.ok(Math.abs((afterLoud.momentaryLufs ?? 0) - (-11.98)) <= 0.3);
    assert.ok(Math.abs((afterQuiet.momentaryLufs ?? 0) - (-21.98)) <= 0.3);
    const momentaryShift = Math.abs((afterQuiet.momentaryLufs ?? 0) - (afterLoud.momentaryLufs ?? 0));
    const integratedShift = Math.abs((afterQuiet.integratedLufs ?? 0) - (afterLoud.integratedLufs ?? 0));
    assert.ok(momentaryShift > 9.0, `momentary should move ~10 dB, moved ${momentaryShift}`);
    assert.ok(integratedShift < momentaryShift / 2, `integrated moved ${integratedShift}, too close to momentary`);
    assert.ok(
      (afterQuiet.integratedLufs ?? 0) > -24.0 + 0.5,
      'integrated must not collapse to the newest block',
    );
    assert.ok(afterQuiet.blockCount > afterLoud.blockCount, 'block count must grow as audio arrives');
  });

  it('does not derive short-term or integrated from momentary by a factor', () => {
    // The predecessor published shortTerm = momentary * 0.95 and
    // integrated = momentary * 0.92. Those multiplications are illegal: for a
    // steady tone all three must agree, and a multiplicative relation would
    // make the "LUFS" figures depend on the sign of the value.
    const left = tone(48000, 8, 1000, sineAmplitudeForRms(-18));
    const reading = measure({ left, right: new Float64Array(left.length) });
    assert.ok(Math.abs((reading.momentaryLufs ?? 0) - (reading.shortTermLufs ?? 0)) <= 0.1);
    assert.ok(Math.abs((reading.momentaryLufs ?? 0) - (reading.integratedLufs ?? 0)) <= 0.1);
    assert.ok(Math.abs((reading.integratedLufs ?? 0) - (-18.0)) <= 0.3);
    // A scaled reading would differ by ~1 dB at this level; assert the gap is gone.
    assert.ok(Math.abs((reading.integratedLufs ?? 0) - reading.momentaryLufs! * 0.92) > 0.5);
  });

  it('produces exactly the BS.1770-4 number of gating blocks', () => {
    const seconds = 10;
    const left = tone(48000, seconds, 1000, sineAmplitudeForRms(-20));
    const reading = measure({ left, right: new Float64Array(left.length) });
    // blocks = round((T - 0.4) / (0.4 * 0.25)) + 1 = 97 for 10 seconds
    assert.equal(reading.blockCount, Math.round((seconds - 0.4) / 0.1) + 1);
  });

  it('is stable under an arbitrary chunk size (the engine pumps 128-sample quanta)', () => {
    const left = tone(48000, 6, 1000, sineAmplitudeForRms(-16));
    const right = left.slice();
    const results: Array<number | null> = [];
    for (const chunk of [128, 1200, 4096, 9973]) {
      const meter = new LoudnessMeter(48000);
      for (let start = 0; start < left.length; start += chunk) {
        meter.pushFrame(left.subarray(start, start + chunk), right.subarray(start, start + chunk));
      }
      results.push(meter.getReading().integratedLufs);
    }
    for (const value of results) {
      assert.ok(Math.abs((value ?? Number.NaN) - (results[0] ?? Number.NaN)) <= 0.1, `chunk sizes disagree: ${results.join(', ')}`);
    }
  });

  it('forgets everything on reset so sessions cannot be merged', () => {
    const left = tone(48000, 10, 1000, sineAmplitudeForRms(-10));
    const meter = new LoudnessMeter(48000);
    meter.pushFrame(left, left.slice());
    assert.ok(meter.getReading().blockCount > 0);
    meter.reset();
    const cleared = meter.getReading();
    assert.equal(cleared.integratedLufs, null);
    assert.equal(cleared.momentaryLufs, null);
    assert.equal(cleared.blockCount, 0);
    assert.equal(cleared.measuredSeconds, 0);
    // After reset the same quiet tone must be measured from scratch: both
    // channels at -30 dBFS RMS is -30 + 3.01 + 0.70 - 0.69 = -26.98 LUFS, so a
    // value still pulled up by the loud history would be a failure here.
    const quiet = tone(48000, 10, 1000, sineAmplitudeForRms(-30));
    const post = new LoudnessMeter(48000);
    post.pushFrame(quiet, quiet.slice());
    assert.ok(
      Math.abs((post.getReading().integratedLufs ?? Number.NaN) - (-26.98)) <= 0.3,
      `reset did not clear accumulated energy: ${post.getReading().integratedLufs}`,
    );
  });
});
