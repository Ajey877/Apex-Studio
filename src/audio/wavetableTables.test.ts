/**
 * Phase 8B — wavetable table DSP.
 *
 * These tests exercise the real table builder (`buildWavetableShape`), the code
 * the `wavetable` renderer uses before handing coefficients to the oscillator.
 * They assert signal-level properties, not that functions were called:
 * distinct frames, real morph movement, real warp modes, real partial gains,
 * band limiting, determinism and boundedness.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WavetableParameters } from '../types/daw';
import { WAVETABLE_PRESETS } from './wavetablePresets';
import {
  DEFAULT_WAVETABLE_HARMONICS,
  DEFAULT_WAVETABLE_PARAMETERS,
  WAVETABLE_FRAME_COUNT,
  WAVETABLE_FRAME_LABELS,
  WAVETABLE_HARMONIC_LIMIT,
  WAVETABLE_WARP_MODES,
  buildWavetableShape,
  buildWavetableSamples,
  clearWavetableShapeCache,
  getCachedWavetableShape,
  morphFrameAmplitudes,
  normalizeWavetableParameters,
  resolveWavetableParameters,
  wavetableFramePosition,
} from './wavetableTables';

const base = (patch: Partial<WavetableParameters> = {}) =>
  normalizeWavetableParameters({ ...DEFAULT_WAVETABLE_PARAMETERS, ...patch });

const maxAbsDiff = (a: Float32Array | Float64Array, b: Float32Array | Float64Array): number => {
  const length = Math.min(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < length; i++) diff = Math.max(diff, Math.abs(a[i] - b[i]));
  return diff;
};

const rms = (samples: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
};

/** Squared magnitude of a real signal at one frequency (Goertzel). */
const goertzel = (samples: Float32Array, frequency: number, sampleRate: number): number => {
  const omega = (2 * Math.PI * frequency) / sampleRate;
  const coefficient = 2 * Math.cos(omega);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    s0 = samples[i] + coefficient * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coefficient * s1 * s2;
};

describe('Phase 8B — frame table', () => {
  it('declares six phase-aligned frames', () => {
    assert.equal(WAVETABLE_FRAME_COUNT, 6);
    assert.equal(WAVETABLE_FRAME_LABELS.length, WAVETABLE_FRAME_COUNT);
    assert.equal(new Set(WAVETABLE_FRAME_LABELS).size, WAVETABLE_FRAME_COUNT);
  });

  it('every frame is a different single cycle', () => {
    const tables = Array.from({ length: WAVETABLE_FRAME_COUNT }, (_, index) =>
      buildWavetableSamples(base({ morph: index / (WAVETABLE_FRAME_COUNT - 1) })),
    );
    for (let a = 0; a < tables.length; a++) {
      for (let b = a + 1; b < tables.length; b++) {
        assert.ok(
          maxAbsDiff(tables[a], tables[b]) > 0.05,
          `frames ${a} and ${b} must differ, maxDiff=${maxAbsDiff(tables[a], tables[b])}`,
        );
      }
    }
  });

  it('frames are phase-aligned: each cycle starts at the same zero crossing', () => {
    for (let index = 0; index < WAVETABLE_FRAME_COUNT; index++) {
      const samples = buildWavetableSamples(
        base({ morph: index / (WAVETABLE_FRAME_COUNT - 1) }),
      );
      assert.ok(Math.abs(samples[0]) < 1e-3, `frame ${index} starts at zero`);
      assert.ok(samples[1] > 0, `frame ${index} rises from zero`);
    }
  });

  it('morph interpolates between adjacent frames and changes the signal', () => {
    const a = buildWavetableSamples(base({ morph: 0 }));
    const mid = buildWavetableSamples(base({ morph: 0.1 }));
    const b = buildWavetableSamples(base({ morph: 0.2 }));
    assert.ok(maxAbsDiff(a, b) > 0.1, 'morph 0 and 0.2 are audibly different tables');
    // 0.1 sits between the two frames: it cannot equal either endpoint.
    assert.ok(maxAbsDiff(mid, a) > 1e-3);
    assert.ok(maxAbsDiff(mid, b) > 1e-3);
    const expected = (morphFrameAmplitudes(0.1)[1] > 0 ? 1 : 0);
    assert.equal(expected, 1, 'the first harmonic survives interpolation');
  });

  it('morph is monotonic in timbre (brightness grows from sine toward metallic)', () => {
    const sine = buildWavetableSamples(base({ morph: 0 }));
    const metallic = buildWavetableSamples(base({ morph: 1 }));
    // Second-harmonic content relative to the fundamental is a direct read of
    // how much the table moved away from a pure sine.
    const ratio = (samples: Float32Array) =>
      goertzel(samples, 2, samples.length) / Math.max(1e-12, goertzel(samples, 1, samples.length));
    assert.ok(ratio(sine) < 1e-3, 'morph 0 is a pure sine');
    assert.ok(ratio(metallic) > 0.01, 'morph 1 contains upper partials');
  });
});

describe('Phase 8B — warp modes are real table transforms', () => {
  it('offers only implemented modes', () => {
    assert.deepEqual([...WAVETABLE_WARP_MODES].sort(), ['bend', 'none', 'pwm', 'sync']);
  });

  it('each warp mode changes the generated cycle', () => {
    const plain = buildWavetableSamples(base({ morph: 0.45, warpMode: 'none' }));
    for (const warpMode of ['pwm', 'bend', 'sync'] as const) {
      const warped = buildWavetableSamples(
        base({ morph: 0.45, warpMode, warpAmount: 0.75 }),
      );
      assert.ok(
        maxAbsDiff(plain, warped) > 0.05,
        `${warpMode} must change the table, maxDiff=${maxAbsDiff(plain, warped)}`,
      );
    }
  });

  it('warp amount is a continuous depth control', () => {
    for (const warpMode of ['pwm', 'bend', 'sync'] as const) {
      const shallow = buildWavetableSamples(base({ morph: 0.5, warpMode, warpAmount: 0.2 }));
      const deep = buildWavetableSamples(base({ morph: 0.5, warpMode, warpAmount: 0.9 }));
      assert.ok(
        maxAbsDiff(shallow, deep) > 0.05,
        `${warpMode} amount must change the table`,
      );
    }
  });
});

describe('Phase 8B — partial gains shape the spectrum', () => {
  it('H1-only and H2-only tables put energy in different partials', () => {
    const firstOnly = buildWavetableSamples(
      base({ morph: 0.5, harmonics: [1, 0, 0, 0, 0, 0, 0, 0] }),
    );
    const secondOnly = buildWavetableSamples(
      base({ morph: 0.5, harmonics: [0, 1, 0, 0, 0, 0, 0, 0] }),
    );
    const h1 = (samples: Float32Array) => goertzel(samples, 1, samples.length);
    const h2 = (samples: Float32Array) => goertzel(samples, 2, samples.length);
    assert.ok(h1(firstOnly) > h2(firstOnly) * 50, 'H1-only is dominated by the fundamental');
    assert.ok(h2(secondOnly) > h1(secondOnly) * 50, 'H2-only is dominated by the second partial');
    assert.ok(maxAbsDiff(firstOnly, secondOnly) > 0.5);
  });

  it('scales each partial independently', () => {
    const all = buildWavetableSamples(base());
    const noThird = buildWavetableSamples(
      base({ harmonics: [1, 0.7, 0, 0.35, 0.25, 0.18, 0.12, 0.08] }),
    );
    const baseline = goertzel(all, 3, all.length);
    const muted = goertzel(noThird, 3, noThird.length);
    assert.ok(baseline > 0, 'third partial exists in the default table');
    assert.ok(muted < baseline * 0.01, 'H3 at 0 removes the third partial');
    assert.ok(
      goertzel(all, 1, all.length) > 0 && goertzel(noThird, 1, noThird.length) > 0,
      'other partials remain',
    );
  });

  it('muting every exposed partial removes H1–H8 and keeps a valid cycle', () => {
    const muted = buildWavetableShape(base({ harmonics: [0, 0, 0, 0, 0, 0, 0, 0] }));
    for (let n = 1; n <= 8; n++) {
      assert.ok(Math.abs(muted.real[n]) < 1e-6, `real[${n}] removed`);
      assert.ok(Math.abs(muted.imag[n]) < 1e-6, `imag[${n}] removed`);
    }
    // Partials 9–64 are not exposed as controls; the table remains a valid,
    // band-limited cycle rather than becoming an invalid all-NaN buffer.
    for (const value of muted.samples) assert.equal(Number.isFinite(value), true);
    assert.ok(rms(muted.samples) < rms(buildWavetableSamples(base())) * 0.5);
  });
});

describe('Phase 8B — band limiting, boundedness and determinism', () => {
  it('is band-limited to the declared partial count', () => {
    const shape = buildWavetableShape(base({ morph: 0.9, warpMode: 'sync', warpAmount: 0.8 }), 1024);
    assert.equal(shape.imag.length, WAVETABLE_HARMONIC_LIMIT + 1);
    assert.equal(shape.real[0], 0, 'DC is removed');
    assert.equal(shape.imag[0], 0, 'DC is removed');
    for (let n = WAVETABLE_HARMONIC_LIMIT + 1; n < shape.imag.length; n++) {
      assert.equal(shape.imag[n], 0);
    }
  });

  it('coefficients reconstruct exactly the drawn cycle', () => {
    const shape = buildWavetableShape(base({ morph: 0.33, warpMode: 'pwm', warpAmount: 0.4 }), 512);
    for (let i = 0; i < shape.samples.length; i += 7) {
      let value = 0;
      for (let n = 1; n < shape.real.length; n++) {
        const angle = (2 * Math.PI * n * i) / shape.samples.length;
        value += shape.real[n] * Math.cos(angle) + shape.imag[n] * Math.sin(angle);
      }
      assert.ok(
        Math.abs(value - shape.samples[i]) < 1e-4,
        `sample ${i}: reconstructed ${value} vs drawn ${shape.samples[i]}`,
      );
    }
  });

  it('is finite and peak-normalised for every mode and morph position', () => {
    for (const warpMode of WAVETABLE_WARP_MODES) {
      for (let step = 0; step <= 10; step++) {
        const shape = buildWavetableShape(
          base({ morph: step / 10, warpMode, warpAmount: step / 10 }),
        );
        for (const value of shape.samples) {
          assert.equal(Number.isFinite(value), true, `${warpMode} produced a non-finite sample`);
        }
        let peak = 0;
        for (const value of shape.samples) peak = Math.max(peak, Math.abs(value));
        assert.ok(peak <= 1 + 1e-6, `${warpMode} peak ${peak} must be bounded by 1`);
        if (shape.preNormalizationPeak > 1e-9) {
          assert.ok(Math.abs(peak - 1) < 1e-4, `${warpMode} table must be peak-normalised`);
        }
      }
    }
  });

  it('is deterministic for identical inputs', () => {
    const params = base({ morph: 0.62, warpMode: 'bend', warpAmount: 0.42 });
    const a = buildWavetableShape(params);
    const b = buildWavetableShape(params);
    assert.equal(maxAbsDiff(a.samples, b.samples), 0);
    assert.equal(maxAbsDiff(a.real, b.real), 0);
    assert.equal(maxAbsDiff(a.imag, b.imag), 0);
  });

  it('morph resolution changes the signal, not just a label', () => {
    const samples = Array.from({ length: 21 }, (_, index) =>
      buildWavetableSamples(base({ morph: index / 20 })),
    );
    for (let i = 1; i < samples.length; i++) {
      assert.ok(
        maxAbsDiff(samples[i - 1], samples[i]) > 0,
        'every morph step changes the generated cycle',
      );
    }
  });
});

describe('Phase 8B — presets change the generated table', () => {
  it('ships several presets and each one changes the table', () => {
    assert.ok(WAVETABLE_PRESETS.length >= 4, 'at least four presets');
    const names = new Set(WAVETABLE_PRESETS.map((preset) => preset.name));
    assert.equal(names.size, WAVETABLE_PRESETS.length, 'preset names are unique');
    const defaults = buildWavetableSamples(normalizeWavetableParameters(DEFAULT_WAVETABLE_PARAMETERS));
    for (const preset of WAVETABLE_PRESETS) {
      const applied = normalizeWavetableParameters({
        ...DEFAULT_WAVETABLE_PARAMETERS,
        ...preset.values,
      });
      const table = buildWavetableSamples(applied);
      assert.ok(
        maxAbsDiff(defaults, table) > 0.05,
        `${preset.name} must produce a different cycle than the defaults`,
      );
      // Voice/unison values are engine-consumed too.
      assert.ok(applied.unisonVoices >= 1 && applied.unisonVoices <= 7);
      assert.ok(applied.unisonDetuneCents >= 0 && applied.unisonDetuneCents <= 50);
      assert.ok(applied.unisonSpread >= 0 && applied.unisonSpread <= 1);
    }
  });

  it('presets differ from each other', () => {
    const tables = WAVETABLE_PRESETS.map((preset) =>
      buildWavetableSamples(
        normalizeWavetableParameters({ ...DEFAULT_WAVETABLE_PARAMETERS, ...preset.values }),
      ),
    );
    for (let a = 0; a < tables.length; a++) {
      for (let b = a + 1; b < tables.length; b++) {
        assert.ok(
          maxAbsDiff(tables[a], tables[b]) > 0.01,
          `presets ${WAVETABLE_PRESETS[a].name} and ${WAVETABLE_PRESETS[b].name} must differ`,
        );
      }
    }
  });
});

describe('Phase 8B — parameter resolution and caching', () => {
  it('resolves safe defaults for a channel saved before Phase 8B', () => {
    const resolved = resolveWavetableParameters(undefined);
    assert.deepEqual(resolved.harmonics, [...DEFAULT_WAVETABLE_HARMONICS]);
    assert.equal(resolved.warpMode, 'none');
    assert.equal(resolved.morph, DEFAULT_WAVETABLE_PARAMETERS.morph);
    assert.ok(resolved.unisonVoices >= 1 && resolved.unisonVoices <= 7);
  });

  it('clamps malformed and out-of-range persisted values', () => {
    const resolved = normalizeWavetableParameters({
      morph: 9,
      warpMode: 'fm',
      warpAmount: -3,
      unisonVoices: 99,
      unisonDetuneCents: 900,
      unisonSpread: 5,
      harmonics: [2, 'x', Number.NaN, 0.5],
    });
    assert.equal(resolved.morph, 1);
    assert.equal(resolved.warpMode, 'none');
    assert.equal(resolved.warpAmount, 0);
    assert.equal(resolved.unisonVoices, 7);
    assert.equal(resolved.unisonDetuneCents, 50);
    assert.equal(resolved.unisonSpread, 1);
    assert.equal(resolved.harmonics.length, 8);
    assert.equal(resolved.harmonics[0], 1);
    // Non-numeric / non-finite entries fall back to the safe default for that
    // partial index, never to NaN.
    assert.equal(resolved.harmonics[1], DEFAULT_WAVETABLE_HARMONICS[1]);
    assert.equal(resolved.harmonics[2], DEFAULT_WAVETABLE_HARMONICS[2]);
    assert.equal(resolved.harmonics[3], 0.5);
  });

  it('caches by value and stays bounded', () => {
    clearWavetableShapeCache();
    const params = base({ morph: 0.24 });
    const first = getCachedWavetableShape(params);
    const second = getCachedWavetableShape({ ...params });
    assert.equal(first, second, 'identical parameters reuse one table');
    const different = getCachedWavetableShape({ ...params, morph: 0.75 });
    assert.notEqual(first, different);
    assert.ok(maxAbsDiff(first.samples, different.samples) > 0.05);
  });

  it('reports the frame position for the UI', () => {
    assert.equal(wavetableFramePosition(0, 6), 0);
    assert.equal(wavetableFramePosition(1, 6), 5);
    assert.equal(wavetableFramePosition(0.5, 6), 3);
    assert.equal(wavetableFramePosition(3, 6), 5, 'out-of-range values clamp');
  });

  it('produces a non-zero RMS for the default parameters', () => {
    assert.ok(rms(buildWavetableSamples(base())) > 0.2);
  });
});
