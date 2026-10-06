import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { audioEngine } from './audioEngine';
import { LoudnessMeter } from './loudnessMeasurement';
import { TruePeakMeter } from './truePeak';
import { StereoFieldMeter } from './stereoMeasurement';

/**
 * Phase 45 truthfulness guards.
 *
 * Two kinds of test live here on purpose:
 *  - behavioural proof that the *pre-fix* algorithm could not satisfy the
 *    criteria the new modules meet, so these criteria genuinely discriminate
 *    the defect that was reported (and not merely the refactor);
 *  - source-boundary guards on the engine, because a meter that quietly grows a
 *    `* 0.92` again would still pass every maths test in this repository.
 */

const ENGINE_SOURCE = readFileSync(new URL('./audioEngine.ts', import.meta.url), 'utf8');
const MODAL_SOURCE = readFileSync(new URL('../components/MasteringSuiteModal.tsx', import.meta.url), 'utf8');

/**
 * Transcribed from the audited baseline (164502f7, `getMasterLoudnessMetrics`):
 * RMS-as-LUFS with the single -0.691 constant, next-sample-as-"R", momentary
 * scaled into "short-term" and "integrated", sample peak called TRUE PEAK, and
 * correlation forced to +1 when the buffer is silent.
 */
function legacyMasterMetrics(mono: Float32Array) {
  const bufferLength = 256;
  let sumSquares = 0;
  let peak = 0;
  let sumL = 0;
  let sumR = 0;
  let sumDot = 0;
  for (let i = 0; i < bufferLength; i++) {
    const val = mono[i];
    sumSquares += val * val;
    const absVal = Math.abs(val);
    if (absVal > peak) peak = absVal;
    const l = val;
    const r = i < bufferLength - 1 ? mono[i + 1] * 0.98 : val;
    sumL += l * l;
    sumR += r * r;
    sumDot += l * r;
  }
  const denom = Math.sqrt(sumL * sumR);
  const phaseCorrelation = denom > 1e-6 ? Math.max(-1, Math.min(1, sumDot / denom)) : 1.0;
  const rms = Math.sqrt(sumSquares / bufferLength);
  const dbfs = 20 * Math.log10(Math.max(1e-5, rms));
  const lufs = Math.max(-70, Math.min(0, dbfs - 0.691));
  const peakDbfs = 20 * Math.log10(Math.max(1e-5, peak));
  return {
    momentaryLufs: Number(lufs.toFixed(1)),
    shortTermLufs: Number((lufs * 0.95).toFixed(1)),
    integratedLufs: Number((lufs * 0.92).toFixed(1)),
    truePeakDbfs: Number(peakDbfs.toFixed(1)),
    phaseCorrelation: Number(phaseCorrelation.toFixed(2)),
    isClipping: peak >= 0.99,
  };
}

const monoDownMix = (left: Float64Array, right: Float64Array): Float32Array => {
  const out = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) out[i] = (left[i] + right[i]) / 2;
  return out;
};

function tone(seconds: number, hz: number, rmsDbfs: number, channelSign = 1, rate = 48000) {
  const length = Math.floor(seconds * rate);
  const left = new Float64Array(length);
  const right = new Float64Array(length);
  const amplitude = Math.SQRT2 * 10 ** (rmsDbfs / 20);
  for (let i = 0; i < length; i++) {
    const v = amplitude * Math.sin(2 * Math.PI * hz * i / rate);
    left[i] = v;
    right[i] = v * channelSign;
  }
  return { left, right };
}

function feedMeter<T extends { pushFrame(l: Float64Array | Float32Array, r: Float64Array | Float32Array): void }>(
  meter: T,
  left: Float64Array,
  right: Float64Array,
): T {
  for (let start = 0; start < left.length; start += 128) {
    meter.pushFrame(left.subarray(start, start + 128), right.subarray(start, start + 128));
  }
  return meter;
}

describe('Phase 45: the audited defect fails the new criteria', () => {
  it('legacy: an anti-phase master reads as silent AND perfectly coherent', () => {
    const { left, right } = tone(10, 1000, -20, -1);
    const legacy = legacyMasterMetrics(monoDownMix(left, right));

    // The down-mix cancels, so the old meter called it silence...
    assert.equal(legacy.momentaryLufs, -70);
    assert.ok(legacy.integratedLufs > -70 && legacy.integratedLufs < -60, `integrated was ${legacy.integratedLufs}`);
    // ...and reported the cancellation as the most reassuring value possible.
    assert.equal(legacy.phaseCorrelation, 1.0, 'expected the legacy forced +1 to reproduce');

    // The replacement module measures the same 10 seconds honestly.
    const loudness = feedMeter(new LoudnessMeter(48000), left, right).getReading();
    assert.ok(Math.abs((loudness.integratedLufs ?? Number.NaN) - (-16.99)) <= 0.3, `got ${loudness.integratedLufs}`);
    const field = feedMeter(new StereoFieldMeter(), left, right).getReading();
    assert.equal(field.correlation, -1);
  });

  it('legacy: loudness barely moves with frequency (no K-weighting) and swings with the read position', () => {
    const bassSignal = tone(10, 50, -20);
    const brightSignal = tone(10, 8000, -20);
    const bassMono = monoDownMix(bassSignal.left, bassSignal.right);
    const brightMono = monoDownMix(brightSignal.left, brightSignal.right);
    const bass = legacyMasterMetrics(bassMono);
    const bright = legacyMasterMetrics(brightMono);
    // 256 samples cannot even contain a cycle of a 50 Hz tone, so the legacy
    // reading depended on where the window happened to land, and it never
    // approached the true weighting difference between these two tones.
    assert.ok(Math.abs(bass.momentaryLufs - bright.momentaryLufs) < 2.0,
      `legacy spread was ${bass.momentaryLufs} vs ${bright.momentaryLufs}`);
    const halfCycleShift = legacyMasterMetrics(bassMono.subarray(64));
    assert.ok(Math.abs(halfCycleShift.momentaryLufs - bass.momentaryLufs) > 1.0,
      'expected the legacy window-position sensitivity to be observable');

    const bassMetered = feedMeter(new LoudnessMeter(48000), bassSignal.left, bassSignal.right).getReading();
    const brightMetered = feedMeter(new LoudnessMeter(48000), brightSignal.left, brightSignal.right).getReading();
    const spread = (brightMetered.integratedLufs ?? 0) - (bassMetered.integratedLufs ?? 0);
    // K(8 kHz) - K(50 Hz) = 4.04 - (-3.93) = 7.97 dB of real perceived difference.
    assert.ok(spread > 7.0, `K-weighting spread was only ${spread.toFixed(2)} dB`);
  });

  it('the replacement meter is not sensitive to where the read happened to land', () => {
    const { left, right } = tone(10, 50, -20);
    const values: number[] = [];
    for (const skip of [0, 64, 333, 1000]) {
      const meter = new LoudnessMeter(48000);
      feedMeter(meter, left.subarray(skip), right.subarray(skip));
      values.push(meter.getReading().integratedLufs!);
    }
    const spread = Math.max(...values) - Math.min(...values);
    assert.ok(spread <= 0.2, `integrated moved ${spread.toFixed(2)} dB with the read offset: ${values.join(', ')}`);
  });

  it('legacy: "integrated" is a scaled copy of momentary, not an accumulation', () => {
    const { left, right } = tone(10, 1000, -18);
    const legacy = legacyMasterMetrics(monoDownMix(left, right));
    // Scaling a negative dB figure by 0.95 / 0.92 moves it *towards* zero, so
    // the old UI showed a steady programme as getting louder on average.
    assert.ok(Math.abs(legacy.shortTermLufs - legacy.momentaryLufs * 0.95) <= 0.1,
      `short-term ${legacy.shortTermLufs} vs momentary ${legacy.momentaryLufs}`);
    assert.ok(Math.abs(legacy.integratedLufs - legacy.momentaryLufs * 0.92) <= 0.1,
      `integrated ${legacy.integratedLufs} vs momentary ${legacy.momentaryLufs}`);
    assert.ok(legacy.shortTermLufs > legacy.momentaryLufs, 'legacy short-term rose above momentary on a negative value');

    const reading = feedMeter(new LoudnessMeter(48000), left, right).getReading();
    // For steady material all three must agree within rounding; the old
    // multiplications made them differ by ~1 dB depending on the sign.
    assert.ok(Math.abs((reading.momentaryLufs ?? 0) - (reading.shortTermLufs ?? 0)) <= 0.15);
    assert.ok(Math.abs((reading.momentaryLufs ?? 0) - (reading.integratedLufs ?? 0)) <= 0.15);
    assert.ok(Math.abs((reading.integratedLufs ?? 0) - (reading.momentaryLufs ?? 0) * 0.92) > 0.5,
      'integrated must not be a scaled copy of momentary');
  });

  it('legacy: sample peak labelled TRUE PEAK misses the overshoot it claims to catch', () => {
    const rate = 48000;
    const length = 4096;
    const left = new Float64Array(length);
    for (let i = 0; i < length; i++) left[i] = 0.999 * Math.sin(2 * Math.PI * (rate / 4) * i / rate + Math.PI / 4);
    const legacy = legacyMasterMetrics(Float32Array.from(left));
    assert.ok(legacy.truePeakDbfs < -2.9 && legacy.truePeakDbfs > -3.1, `legacy read ${legacy.truePeakDbfs}`);
    assert.equal(legacy.isClipping, false, 'legacy saw no clipping in a signal that exceeds 0 dBFS');

    const metered = feedMeter(new TruePeakMeter(), left, left).getReading();
    assert.ok(metered.truePeakDbfs! > -0.3, `true peak read ${metered.truePeakDbfs}`);
    assert.ok(metered.samplePeakDbfs! < -2.9, 'sample peak must still be reported separately');
  });

  it('legacy: digital silence produced a loudness figure anyway', () => {
    const zero = new Float32Array(256);
    const legacy = legacyMasterMetrics(zero);
    assert.equal(legacy.momentaryLufs, -70, 'legacy floor was a number, not an absence of measurement');
    assert.equal(legacy.truePeakDbfs, -100);
    assert.equal(legacy.phaseCorrelation, 1.0);

    const loudness = feedMeter(new LoudnessMeter(48000), new Float64Array(48000), new Float64Array(48000)).getReading();
    assert.equal(loudness.integratedLufs, null);
    assert.equal(loudness.momentaryLufs, null);
    assert.equal(feedMeter(new TruePeakMeter(), new Float64Array(48000), new Float64Array(48000)).getReading().truePeakDbfs, null);
  });
});

describe('Phase 45: engine measurement surface', () => {
  it('reports unmeasured, not a default, when no audio context exists', () => {
    const snapshot = audioEngine.getMasterLoudnessMetrics();
    assert.equal(snapshot.availability, 'engine-idle');
    assert.equal(snapshot.momentaryLufs, null);
    assert.equal(snapshot.shortTermLufs, null);
    assert.equal(snapshot.integratedLufs, null);
    assert.equal(snapshot.truePeakDbfs, null);
    assert.equal(snapshot.samplePeakDbfs, null);
    assert.equal(snapshot.phaseCorrelation, null);
    assert.equal(snapshot.headroomDb, null);
    // `isClipping` may be null ("cannot tell"), but must never be a confident
    // false presented as a passed check.
    assert.equal(snapshot.isClipping, null);
    assert.equal(snapshot.blockCount, 0);
    assert.deepEqual(audioEngine.getStereoVectors(32), [], 'no tap must not yield an invented goniometer trace');
  });

  it('exposes context facts instead of hard-coded ones', () => {
    assert.equal(audioEngine.getSampleRate(), null, 'no context yet, so no sample rate may be claimed');
    assert.equal(audioEngine.getLatencyMetrics(), null);
  });

  it('keeps the loudness getter name and signature the bounce guard slices on', () => {
    const bounceStart = ENGINE_SOURCE.indexOf('public async bounceChannelToAudioClip(');
    const loudnessStart = ENGINE_SOURCE.indexOf('public getMasterLoudnessMetrics()', bounceStart);
    assert.ok(bounceStart >= 0 && loudnessStart > bounceStart, 'bounceInPlace.test.ts boundary would break');
    const region = ENGINE_SOURCE.slice(bounceStart, loudnessStart);
    assert.doesNotMatch(region, /Math\.sin\(/, 'DSP must stay out of the bounce->loudness region');
    assert.doesNotMatch(region, /copyToChannel\(/);
  });

  it('no longer contains any of the fabricated metric expressions', () => {
    assert.doesNotMatch(ENGINE_SOURCE, /dbfs - 0\.691/, 'RMS minus a constant is not K-weighted loudness');
    assert.doesNotMatch(ENGINE_SOURCE, /lufs \* 0\.95/, 'short-term may not be a scaled momentary');
    assert.doesNotMatch(ENGINE_SOURCE, /lufs \* 0\.92/, 'integrated may not be a scaled momentary');
    assert.doesNotMatch(ENGINE_SOURCE, /dataArray\[i \+ 1\] \* 0\.98/, 'the next sample is not the right channel');
    assert.doesNotMatch(ENGINE_SOURCE, /dataArray\[idx \+ 1\][^\n]*0\.95/, 'adjacent samples are not mid/side');
    assert.doesNotMatch(ENGINE_SOURCE, /integratedLufs: -14\.2/, 'no hard-coded measurement seed');
    assert.doesNotMatch(ENGINE_SOURCE, /phaseCorrelation: 0\.95/, 'no hard-coded correlation seed');
    assert.doesNotMatch(ENGINE_SOURCE, /truePeakDbfs: -6\.0/, 'no hard-coded true peak seed');
    assert.match(ENGINE_SOURCE, /createChannelSplitter\(2\)/, 'a real stereo tap must exist');
    assert.match(ENGINE_SOURCE, /splitter\.connect\(analyserL, 0\)/);
    assert.match(ENGINE_SOURCE, /splitter\.connect\(analyserR, 1\)/);
  });

  it('guards both measurement getters against the offline render graph', () => {
    for (const method of ['getMasterLoudnessMetrics', 'getStereoVectors']) {
      const start = ENGINE_SOURCE.indexOf(`public ${method}(`);
      assert.ok(start > 0, method);
      const body = ENGINE_SOURCE.slice(start, start + 1200);
      assert.match(body, /isOfflineRendering/, `${method} must refuse to meter the bounce graph`);
    }
  });

  it('resets measurement on every lifecycle boundary that starts a new session', () => {
    const call = (name: string) => {
      const start = ENGINE_SOURCE.indexOf(name);
      assert.ok(start > 0, name);
      assert.match(ENGINE_SOURCE.slice(start, start + 700), /resetMasterMeasurement\(\)/, `${name} must invalidate the measurement session`);
    };
    call('public seek(');
    const stopStart = ENGINE_SOURCE.indexOf(' public stop() {');
    assert.match(ENGINE_SOURCE.slice(stopStart, stopStart + 400), /resetMasterMeasurement\(\)/, 'stop must invalidate the session');
    const playStart = ENGINE_SOURCE.indexOf('const playbackSnapshot = this.createPlaybackSnapshot');
    assert.match(ENGINE_SOURCE.slice(playStart, playStart + 500), /resetMasterMeasurement\(\)/, 'a new take must start clean');
  });

  it('drives measurement from the engine, not from a mounted component', () => {
    assert.match(ENGINE_SOURCE, /startMasterMeasurementPump\(\)/);
    assert.match(ENGINE_SOURCE, /stopMasterMeasurementPump\(\)/);
    assert.match(ENGINE_SOURCE, /new LoudnessMeter\(sampleRate\)/);
    assert.match(ENGINE_SOURCE, /new TruePeakMeter\(/);
    // The DSP itself lives in the pure modules, not in the engine file.
    assert.doesNotMatch(ENGINE_SOURCE.slice(ENGINE_SOURCE.indexOf('private createMasterMeasurementTap')), /Math\.log10\(sumSquares/);
  });
});

describe('Phase 45: mastering surface presents only measured values', () => {
  it('has no seed measurement and no generated signal', () => {
    assert.doesNotMatch(MODAL_SOURCE, /integratedLufs: -14\.2/);
    assert.doesNotMatch(MODAL_SOURCE, /momentaryLufs: -24/);
    assert.doesNotMatch(MODAL_SOURCE, /phaseCorrelation: 0\.95/);
    assert.doesNotMatch(MODAL_SOURCE, /Date\.now\(\)/, 'spectrum bars must not be animated from the clock');
    assert.doesNotMatch(MODAL_SOURCE, /Math\.random/, 'no random telemetry');
    assert.match(MODAL_SOURCE, /useState<MasterMeasurementSnapshot \| null>\(null\)/, 'measurement state must start empty');
    assert.match(MODAL_SOURCE, /audioEngine\.getMasterFrequencyData\(/, 'the spectrum must reuse the real analyser');
    assert.doesNotMatch(MODAL_SOURCE, /ReductionDb/, 'no fabricated gain-reduction readouts');
  });

  it('drops the claims the code cannot support', () => {
    assert.doesNotMatch(MODAL_SOURCE, /✓ PASS/, 'no pass verdict before measurement');
    assert.doesNotMatch(MODAL_SOURCE, /READY FOR STEM & MASTER EXPORT/);
    assert.doesNotMatch(MODAL_SOURCE, /Zero-latency inter-sample peak protection/);
    assert.doesNotMatch(MODAL_SOURCE, /2\.5ms INTERPOLATED/);
    assert.doesNotMatch(MODAL_SOURCE, /44\.1kHz/, 'the sample rate must be read, not printed');
    assert.doesNotMatch(MODAL_SOURCE, /Commercial-grade loudness compliance/);
    assert.doesNotMatch(MODAL_SOURCE, /SUITE ACTIVE/);
    assert.match(MODAL_SOURCE, /PROCESSING ENABLED/);
    assert.match(MODAL_SOURCE, /LIVE \\+ OFFLINE PATH/);
    assert.match(MODAL_SOURCE, /BYPASSED/);
    assert.doesNotMatch(MODAL_SOURCE, /NOT APPLIED \\u2014 NO PROCESSING IN SIGNAL PATH/);
    assert.match(MODAL_SOURCE, /NOT MEASURED/);
  });

  it('gates every compliance verdict on a real integrated measurement', () => {
    const complianceHelper = MODAL_SOURCE.slice(
      MODAL_SOURCE.indexOf('const complianceText'),
      MODAL_SOURCE.indexOf('const complianceText') + 400,
    );
    assert.match(complianceHelper, /integratedLufs === null/, 'verdict must be withheld without measurement');
    assert.match(complianceHelper, /NOT MEASURED/);
  });
});
