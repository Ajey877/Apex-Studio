/**
 * Phase 8A — shared scale table guard.
 *
 * The scale interval definitions moved out of PianoRoll.tsx into
 * src/music/scalePresets.ts so the vocal pitch-correction DSP and the Piano
 * Roll share ONE authoritative table. These tests pin:
 *  - the historical Piano Roll display list is preserved exactly (14 entries,
 *    same ids, names, interval sets, same order — minor first);
 *  - the DSP-facing table covers EVERY member of the MusicalScale union,
 *    including locrian (which the Piano Roll list never displayed but old
 *    projects can persist);
 *  - every interval set is a sane scale: starts at 0, strictly increasing,
 *    inside one octave;
 *  - unknown ids are refused, never defaulted.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MusicalScale } from '../types/daw';
import { MUSICAL_SCALE_INTERVALS, SCALE_PRESETS, isMusicalScale, scaleIntervals } from './scalePresets';

/** The complete MusicalScale union, written out so a new member forces this test to update. */
const UNION_MEMBERS: MusicalScale[] = [
  'major', 'minor', 'harmonic_minor', 'melodic_minor', 'dorian', 'phrygian',
  'lydian', 'mixolydian', 'locrian', 'pentatonic_minor', 'pentatonic_major',
  'blues', 'japanese_hirajoshi', 'arabic_double_harmonic', 'whole_tone',
];

describe('shared scale presets (Phase 8A)', () => {
  it('preserves the historical Piano Roll list exactly', () => {
    const expected: [string, string, number[]][] = [
      ['minor', 'Natural Minor (Aeolian)', [0, 2, 3, 5, 7, 8, 10]],
      ['major', 'Major (Ionian)', [0, 2, 4, 5, 7, 9, 11]],
      ['harmonic_minor', 'Harmonic Minor', [0, 2, 3, 5, 7, 8, 11]],
      ['melodic_minor', 'Melodic Minor', [0, 2, 3, 5, 7, 9, 11]],
      ['dorian', 'Dorian', [0, 2, 3, 5, 7, 9, 10]],
      ['phrygian', 'Phrygian', [0, 1, 3, 5, 7, 8, 10]],
      ['lydian', 'Lydian', [0, 2, 4, 6, 7, 9, 11]],
      ['mixolydian', 'Mixolydian', [0, 2, 4, 5, 7, 9, 10]],
      ['pentatonic_minor', 'Minor Pentatonic', [0, 3, 5, 7, 10]],
      ['pentatonic_major', 'Major Pentatonic', [0, 2, 4, 7, 9]],
      ['blues', 'Blues Scale', [0, 3, 5, 6, 7, 10]],
      ['japanese_hirajoshi', 'Japanese Hirajoshi', [0, 2, 3, 7, 8]],
      ['arabic_double_harmonic', 'Arabic Double Harmonic', [0, 1, 4, 5, 7, 8, 11]],
      ['whole_tone', 'Whole Tone', [0, 2, 4, 6, 8, 10]],
    ];
    assert.equal(SCALE_PRESETS.length, expected.length);
    for (let i = 0; i < expected.length; i += 1) {
      const [id, name, notes] = expected[i];
      assert.equal(SCALE_PRESETS[i].id, id, `entry ${i} id (order preserved)`);
      assert.equal(SCALE_PRESETS[i].name, name, `entry ${i} name`);
      assert.deepEqual([...SCALE_PRESETS[i].notes], notes, `entry ${i} intervals`);
    }
  });

  it('covers every MusicalScale union member, including locrian', () => {
    for (const scale of UNION_MEMBERS) {
      assert.ok(isMusicalScale(scale), `${scale} must resolve`);
      const intervals = scaleIntervals(scale);
      assert.ok(intervals.length >= 5 && intervals.length <= 12, `${scale}: ${intervals.length} notes`);
      assert.equal(intervals[0], 0, `${scale} starts at the root`);
      for (let i = 1; i < intervals.length; i += 1) {
        assert.ok(intervals[i] > intervals[i - 1], `${scale} strictly increasing at ${i}`);
        assert.ok(intervals[i] < 12, `${scale} stays inside one octave`);
      }
      assert.deepEqual([...intervals], [...MUSICAL_SCALE_INTERVALS[scale]]);
    }
    assert.deepEqual([...scaleIntervals('locrian')], [0, 1, 3, 5, 6, 8, 10]);
  });

  it('refuses unknown scale ids instead of defaulting', () => {
    assert.equal(isMusicalScale('chromatic'), false, 'chromatic is NOT a MusicalScale union member (the vocal DSP special-cases it explicitly)');
    assert.equal(isMusicalScale(''), false);
    assert.equal(isMusicalScale(null), false);
    assert.equal(isMusicalScale(42), false);
    assert.throws(() => scaleIntervals('chromatic' as MusicalScale), /Unknown musical scale/);
    assert.throws(() => scaleIntervals('blues_minor' as MusicalScale), /Unknown musical scale/);
  });
});
