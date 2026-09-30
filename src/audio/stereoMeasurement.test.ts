import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMidSideVectors,
  StereoFieldMeter,
} from './stereoMeasurement.ts';

/**
 * Stereo truthfulness tests.
 *
 * The audited predecessor had no independent right channel at all: it read one
 * sample out of a mono down-mix buffer and called the next sample "R", which
 * made "phase correlation" a measurement of cos(2*pi*f/sampleRate). The two
 * tests that pin the fix are therefore (1) anti-phase must read -1 and (2) the
 * reading must not depend on the programme's frequency content.
 */

const RATE = 48000;

function channelPair(seconds: number, make: (t: number) => [number, number]): { left: Float64Array; right: Float64Array } {
  const length = Math.floor(seconds * RATE);
  const left = new Float64Array(length);
  const right = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const [l, r] = make(i / RATE);
    left[i] = l;
    right[i] = r;
  }
  return { left, right };
}

function measurePair(left: Float64Array, right: Float64Array, chunk = 1024, options = {}) {
  const meter = new StereoFieldMeter(options);
  for (let start = 0; start < left.length; start += chunk) {
    meter.pushFrame(left.subarray(start, start + chunk), right.subarray(start, start + chunk));
  }
  return meter.getReading();
}

/** Deterministic pseudo-noise (no Math.random, so failures are reproducible). */
function noise(length: number, seed = 7): Float64Array {
  const out = new Float64Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = state / 0x3fffffff - 1;
  }
  return out;
}

describe('Phase 45: phase correlation from real L/R', () => {
  it('reads +1 for identical channels', () => {
    const { left, right } = channelPair(2, t => {
      const v = 0.3 * Math.sin(2 * Math.PI * 440 * t);
      return [v, v];
    });
    const reading = measurePair(left, right);
    assert.ok(Math.abs((reading.correlation ?? Number.NaN) - 1) <= 0.01, `correlation was ${reading.correlation}`);
  });

  it('reads -1 for a fully anti-phase master, and never +1', () => {
    const { left, right } = channelPair(2, t => {
      const v = 0.3 * Math.sin(2 * Math.PI * 440 * t);
      return [v, -v];
    });
    const reading = measurePair(left, right);
    assert.equal(reading.correlation, -1);
    assert.ok((reading.correlation ?? 0) < 0, 'anti-phase material must not look coherent');
  });

  it('reads 0 for quadrature (90 degree) material', () => {
    const { left, right } = channelPair(2, t => [
      0.3 * Math.sin(2 * Math.PI * 440 * t),
      0.3 * Math.cos(2 * Math.PI * 440 * t),
    ]);
    const reading = measurePair(left, right);
    assert.ok(Math.abs(reading.correlation ?? Number.NaN) <= 0.05, `correlation was ${reading.correlation}`);
  });

  it('reads near 0 for independent noise, and a sensible intermediate value for a wide mix', () => {
    const length = Math.floor(2 * RATE);
    const independent = measurePair(noise(length, 3), noise(length, 99));
    assert.ok(Math.abs(independent.correlation ?? Number.NaN) <= 0.08, `independent gave ${independent.correlation}`);

    // Mid plus opposite-polarity side offets = a decorrelated, wide programme.
    const { left, right } = channelPair(2, t => {
      const mid = 0.3 * Math.sin(2 * Math.PI * 120 * t);
      const side = 0.2 * noise(1, Math.floor(t * RATE))[0];
      return [mid + side, mid - side];
    });
    const wide = measurePair(left, right);
    assert.ok(wide.correlation !== null && wide.correlation > -0.9 && wide.correlation < 0.9);
  });

  it('reports no correlation instead of a reassuring +1 when there is no signal', () => {
    const zero = new Float64Array(Math.floor(2 * RATE));
    assert.equal(measurePair(zero, zero).correlation, null);

    // One dead channel is not "perfectly mono coherent": it is unmeasurable.
    const live = channelPair(2, t => [0.3 * Math.sin(2 * Math.PI * 440 * t), 0]).left;
    const dead = new Float64Array(live.length);
    const reading = measurePair(live, dead);
    assert.equal(reading.correlation, null);
  });

  it('does not change with the programme frequency (the 1-sample-difference artefact is gone)', () => {
    // cos(2*pi*f/fs) would give +0.97 at 1 kHz, +0.69 at 6 kHz, 0.00 at
    // 12 kHz and -0.49 at 16 kHz for perfectly in-phase material.
    for (const hz of [100, 440, 1000, 4000, 6000, 10000, 12000]) {
      const { left, right } = channelPair(2, t => {
        const v = 0.3 * Math.sin(2 * Math.PI * hz * t);
        return [v, v];
      });
      const reading = measurePair(left, right);
      assert.ok(
        (reading.correlation ?? Number.NaN) > 0.98,
        `${hz} Hz in-phase material read ${reading.correlation}; correlation must not track frequency`,
      );
    }
  });

  it('measures the same correlation regardless of chunk size', () => {
    const { left, right } = channelPair(1, t => {
      const v = Math.sin(2 * Math.PI * 300 * t) * 0.4;
      const w = 0.6 * v + 0.4 * noise(1, Math.floor(t * RATE))[0];
      return [v, w];
    });
    const fine = measurePair(left, right, 64);
    const coarse = measurePair(left, right, 4096);
    assert.ok(Math.abs((fine.correlation ?? 0) - (coarse.correlation ?? 1)) <= 0.05);
  });

  it('accumulates side/mid energy and clears on reset', () => {
    const { left, right } = channelPair(1, t => {
      const v = 0.3 * Math.sin(2 * Math.PI * 440 * t);
      return [v, v];
    });
    const meter = new StereoFieldMeter();
    meter.pushFrame(left, right);
    const mono = meter.getReading();
    assert.ok(mono.frameCount === 1);
    assert.ok(mono.midPowerDbfs !== null && mono.midPowerDbfs > -20, 'mono mid power should be near the signal level');
    assert.ok(mono.sidePowerDbfs === null || mono.sidePowerDbfs < -60, 'mono content must have no side energy');
    meter.reset();
    const cleared = meter.getReading();
    assert.equal(cleared.correlation, null);
    assert.equal(cleared.frameCount, 0);
    assert.equal(cleared.isMeasuring, false);
  });
});

describe('Phase 45: goniometer vectors from real mid/side', () => {
  it('draws a vertical line for mono material (side energy is zero)', () => {
    const { left, right } = channelPair(0.25, t => {
      const v = 0.3 * Math.sin(2 * Math.PI * 1000 * t);
      return [v, v];
    });
    const points = computeMidSideVectors(left, right, 64);
    assert.ok(points.length > 8);
    const maxSide = Math.max(...points.map(p => Math.abs(p.x)));
    const maxMid = Math.max(...points.map(p => Math.abs(p.y)));
    assert.ok(maxMid > 0.9, 'mid axis should span the trace');
    assert.ok(maxSide < 1e-9, `mono material produced side energy: ${maxSide}`);
  });

  it('draws a horizontal line for anti-phase material (mid energy is zero)', () => {
    const { left, right } = channelPair(0.25, t => {
      const v = 0.3 * Math.sin(2 * Math.PI * 1000 * t);
      return [v, -v];
    });
    const points = computeMidSideVectors(left, right, 64);
    const maxSide = Math.max(...points.map(p => Math.abs(p.x)));
    const maxMid = Math.max(...points.map(p => Math.abs(p.y)));
    assert.ok(maxSide > 0.9, 'side axis should span the trace');
    assert.ok(maxMid < 1e-9, `anti-phase material produced mid energy: ${maxMid}`);
  });

  it('scales with the signal instead of a fixed gain', () => {
    const loud = channelPair(0.1, t => [0.5 * Math.sin(2 * Math.PI * 500 * t), 0.2 * Math.sin(2 * Math.PI * 900 * t)]);
    const points = computeMidSideVectors(loud.left, loud.right, 32);
    const extremes = points.flatMap(p => [Math.abs(p.x), Math.abs(p.y)]);
    assert.ok(Math.max(...extremes) <= 1 + 1e-9, 'normalised points must stay inside the box');
    assert.ok(Math.abs(Math.max(...extremes) - 1) < 1e-6);
  });

  it('produces no points for silence or empty input', () => {
    const zero = new Float64Array(2048);
    assert.deepEqual(computeMidSideVectors(zero, zero, 64), []);
    assert.deepEqual(computeMidSideVectors(new Float64Array(0), new Float64Array(0), 64), []);
  });

  it('uses mid/side definitions, not a 0.95 fudge factor', () => {
    const left = Float64Array.from([1, 0, -1, 0]);
    const right = Float64Array.from([0, 1, 0, -1]);
    const points = computeMidSideVectors(left, right, 4);
    // M = (L+R)/2 and S = (L-R)/2 give equal magnitudes here; after
    // normalisation every point must sit at the same radius.
    const radii = points.map(p => Math.hypot(p.x, p.y));
    for (const radius of radii) assert.ok(Math.abs(radius - radii[0]) < 1e-12, `radii differ: ${radii.join(', ')}`);
  });
});
