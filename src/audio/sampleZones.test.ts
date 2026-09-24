import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clampSampleRange, findSampleZone, getSamplePlaybackRate } from './sampleZones';
import type { Note, SampleZone } from '../types/daw';

const note = (pitch: number, velocity: number): Note => ({
  id: 'n', pitch, start: 0, duration: 1, velocity
});

const zones: SampleZone[] = [
  { id: 'low', sampleId: 'soft', lowNote: 0, highNote: 59, rootNote: 48, lowVelocity: 0, highVelocity: 89, tuneSemitones: 0 },
  { id: 'high', sampleId: 'hard', lowNote: 60, highNote: 127, rootNote: 60, lowVelocity: 90, highVelocity: 127, tuneSemitones: 2 }
];

describe('sampler zone resolution', () => {
  test('selects by both key range and MIDI velocity', () => {
    assert.equal(findSampleZone(zones, note(48, 0.5))?.id, 'low');
    assert.equal(findSampleZone(zones, note(60, 1))?.id, 'high');
    assert.equal(findSampleZone(zones, note(48, 1))?.id, undefined);
  });

  test('uses root pitch and tuning for playback rate', () => {
    assert.equal(getSamplePlaybackRate(60, 60), 1);
    assert.ok(Math.abs(getSamplePlaybackRate(72, 60) - 2) < 1e-9);
    assert.ok(Math.abs(getSamplePlaybackRate(60, 60, 0, 12) - 2) < 1e-9);
  });

  test('clamps invalid trim ranges safely', () => {
    assert.deepEqual(clampSampleRange(-1, 2), { start: 0, end: 1 });
    assert.deepEqual(clampSampleRange(0.8, 0.2), { start: 0.8, end: 0.8 });
  });
});
