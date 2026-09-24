import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createEvenSlices, detectTransientSlices } from './sampleSlicer';

describe('sample slicer', () => {
  test('creates deterministic even slices that cover the full sample', () => {
    const slices = createEvenSlices(4);
    assert.equal(slices.length, 4);
    assert.equal(slices[0].start, 0);
    assert.equal(slices[0].end, 0.25);
    assert.equal(slices[3].end, 1);
  });

  test('detects strong onset changes and returns ordered non-overlapping slices', () => {
    const sample = { waveformPeaks: [0, 0.02, 0.9, 0.05, 0.02, 0.02, 0.8, 0.03, 0.01, 0.01] };
    const slices = detectTransientSlices(sample, 4);
    assert.ok(slices.length >= 2);
    assert.equal(slices[0].start, 0);
    assert.equal(slices[slices.length - 1].end, 1);
    for (let i = 1; i < slices.length; i++) {
      assert.ok(slices[i].start >= slices[i - 1].end);
    }
  });

  test('handles empty waveform safely', () => {
    assert.deepEqual(detectTransientSlices({ waveformPeaks: [] }, 8), [
      { id: 'slice-1', start: 0, end: 1, peak: 0 }
    ]);
  });
});
