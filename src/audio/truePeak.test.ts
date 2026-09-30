import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  designInterpolatingFilters,
  measureTruePeak,
  TruePeakMeter,
} from './truePeak.ts';

/**
 * Inter-sample peak tests. The worst case in BS.1770-4 Annex 2 is a sine at
 * fs/4 sampled at 45 degrees: every sample sits at 1/sqrt(2) of the amplitude,
 * so a sample-peak meter reads -3.01 dBFS while the reconstructed waveform
 * peaks at 0 dBFS. A "TRUE PEAK" display that cannot show that gap is not
 * measuring true peak.
 */

const RATE = 48000;

function sine(rate: number, length: number, hz: number, amplitude: number, phase = 0): Float64Array {
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) out[i] = amplitude * Math.sin(2 * Math.PI * hz * i / rate + phase);
  return out;
}

function pushAll(meter: TruePeakMeter, left: Float64Array, right: Float64Array, chunk = left.length): void {
  for (let start = 0; start < left.length; start += chunk) {
    meter.pushFrame(left.subarray(start, start + chunk), right.subarray(start, start + chunk));
  }
}

describe('Phase 45: interpolation filter design', () => {
  it('builds one unity-DC-gain branch per oversampling phase', () => {
    const branches = designInterpolatingFilters(4, 12);
    assert.equal(branches.length, 4);
    for (const taps of branches) {
      assert.equal(taps.length, 12);
      assert.ok(Math.abs(taps.reduce((sum, t) => sum + t, 0) - 1) < 1e-12, 'branch must not change DC level');
    }
  });

  it('builds a phase-aligned kernel family: symmetric at zero delay, energy centred elsewhere', () => {
    const branches = designInterpolatingFilters(4, 12);
    const [phaseZero, phaseOne, , phaseThree] = branches;

    // The branch that lands on the input samples must be symmetric about the
    // kernel centre, otherwise the detector would favour early or late peaks.
    for (let m = 0; m < phaseZero.length; m++) {
      assert.ok(Math.abs(phaseZero[m] - phaseZero[phaseZero.length - 1 - m]) < 1e-12, `tap ${m} not symmetric`);
    }

    // The fractional branches are translates of the same windowed sinc. What
    // matters for a peak detector is that each branch stays centred and never
    // adds gain: the half-sample group delay is irrelevant to a magnitude.
    for (const taps of [phaseOne, phaseThree]) {
      const largestIndex = taps.reduce((best, tap, index) => (Math.abs(tap) > Math.abs(taps[best]) ? index : best), 0);
      assert.ok(largestIndex >= 3 && largestIndex <= 8, `branch energy is not centred (peak tap ${largestIndex})`);

      // Passband gain must stay at unity. An interpolator with overshoot would
      // report a true peak that the reconstruction cannot support, which is the
      // same class of defect this whole phase replaces.
      let maxGain = 0;
      for (let step = 0; step <= 512; step++) {
        const w = Math.PI * step / 512;
        let real = 0;
        let imag = 0;
        taps.forEach((tap, m) => { real += tap * Math.cos(w * m); imag -= tap * Math.sin(w * m); });
        maxGain = Math.max(maxGain, Math.hypot(real, imag));
      }
      assert.ok(maxGain <= 1.02, `branch ${taps === phaseOne ? 1 : 3} passband gain ${maxGain.toFixed(4)}`);
    }
  });

  it('rejects oversampling factors that cannot certify a true peak', () => {
    assert.throws(() => designInterpolatingFilters(1, 12), RangeError);
    assert.throws(() => designInterpolatingFilters(4, 2), RangeError);
  });
});

describe('Phase 45: true peak versus sample peak', () => {
  it('recovers 0 dBFS from an fs/4 sine whose sample peak is -3.01 dBFS', () => {
    const left = sine(RATE, 4096, RATE / 4, 0.999, Math.PI / 4);
    const meter = new TruePeakMeter();
    pushAll(meter, left, left);
    const reading = meter.getReading();

    assert.ok(
      Math.abs((reading.samplePeakDbfs ?? Number.NaN) - (-3.02)) <= 0.1,
      `sample peak was ${reading.samplePeakDbfs}`,
    );
    assert.ok(
      Math.abs((reading.truePeakDbfs ?? Number.NaN) - 0) <= 0.25,
      `true peak was ${reading.truePeakDbfs} dBFS; a sample peak would be ~3 dB low`,
    );
    assert.ok(reading.truePeakDbfs! > reading.samplePeakDbfs! + 2, 'true peak must exceed the sample peak here');
  });

  it('reads 0 dBFS for a mid-band full-scale sine, where sample peak already agrees', () => {
    const left = sine(RATE, 1 << 14, 997, 0.999);
    const reading = new TruePeakMeter();
    pushAll(reading, left, left);
    const got = reading.getReading();
    assert.ok(Math.abs((got.truePeakDbfs ?? Number.NaN) - (-0.01)) <= 0.1, `got ${got.truePeakDbfs}`);
    assert.ok(Math.abs((got.samplePeakDbfs ?? Number.NaN) - (-0.01)) <= 0.1);
  });

  it('never reports a true peak below the sample peak', () => {
    for (const hz of [30, 200, 1500, 6000, 12000]) {
      const left = sine(RATE, 1 << 13, hz, 0.8);
      const meter = new TruePeakMeter();
      pushAll(meter, left, left);
      const reading = meter.getReading();
      assert.ok(
        reading.truePeakDbfs! >= reading.samplePeakDbfs! - 0.02,
        `${hz} Hz: true peak ${reading.truePeakDbfs} below sample peak ${reading.samplePeakDbfs}`,
      );
    }
  });

  it('tracks level: half the amplitude is 6.02 dB quieter', () => {
    const loud = sine(RATE, 1 << 13, 997, 0.9);
    const quiet = sine(RATE, 1 << 13, 997, 0.45);
    const a = measureTruePeak(loud, loud);
    const b = measureTruePeak(quiet, quiet);
    assert.ok(Math.abs((a - b) - 6.02) <= 0.05, `measured ${a} vs ${b}`);
  });

  it('reports the louder channel and keeps channels separate', () => {
    const left = sine(RATE, 1 << 12, RATE / 4, 0.999, Math.PI / 4);
    const right = sine(RATE, 1 << 12, RATE / 4, 0.5, Math.PI / 4);
    const meter = new TruePeakMeter();
    pushAll(meter, left, right);
    const reading = meter.getReading();
    assert.ok(reading.leftDbfs! > 0 - 0.3 && reading.leftDbfs! < 0.3, `left ${reading.leftDbfs}`);
    assert.ok(Math.abs(reading.rightDbfs! - (-6.02)) <= 0.3, `right ${reading.rightDbfs}`);
    assert.ok(reading.truePeakDbfs === reading.leftDbfs);
  });

  it('finds a peak that straddles a chunk boundary', () => {
    const left = sine(RATE, 5000, RATE / 4, 0.999, Math.PI / 4);
    const whole = new TruePeakMeter();
    pushAll(whole, left, left);
    const streamed = new TruePeakMeter();
    pushAll(streamed, left, left, 137);
    assert.equal(streamed.getReading().truePeakDbfs, whole.getReading().truePeakDbfs);
  });

  it('reports no peak for digital silence', () => {
    const zero = new Float64Array(48000);
    const meter = new TruePeakMeter();
    pushAll(meter, zero, zero);
    const reading = meter.getReading();
    assert.equal(reading.truePeakDbfs, null);
    assert.equal(reading.samplePeakDbfs, null);
    assert.equal(reading.leftDbfs, null);
  });

  it('exposes the oversampling factor so the UI can label the method honestly', () => {
    const meter = new TruePeakMeter({ oversample: 8, tapsPerPhase: 12 });
    const left = sine(RATE, 1 << 12, RATE / 4, 0.999, Math.PI / 4);
    pushAll(meter, left, left);
    assert.equal(meter.getReading().oversample, 8);
    assert.ok(meter.getReading().truePeakDbfs! > -0.3, '8x must also reconstruct the overshoot');
  });

  it('clears maxima on reset', () => {
    const meter = new TruePeakMeter();
    const left = sine(RATE, 1 << 12, 997, 0.999);
    pushAll(meter, left, left);
    assert.ok(meter.getReading().truePeakDbfs! > -0.2);
    meter.reset();
    assert.equal(meter.getReading().truePeakDbfs, null);
    assert.equal(meter.samplesMeasuredCount, 0);
  });

  it('is deterministic: identical input, identical peak', () => {
    const left = sine(RATE, 1 << 12, 3300, 0.7, 0.9);
    const a = measureTruePeak(left, left);
    const b = measureTruePeak(left, left);
    assert.equal(a, b);
  });
});
