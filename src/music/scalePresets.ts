import type { MusicalScale } from '../types/daw';

/**
 * Phase 8A: the ONE authoritative table of scale intervals for every
 * `MusicalScale` the project supports.
 *
 * Before this module existed the interval lists lived only inside
 * `PianoRoll.tsx` (as a local, untyped `SCALE_PRESETS` array, and without
 * `locrian`, which the `MusicalScale` union nevertheless allows and old
 * projects may persist). The vocal pitch-correction DSP needs the same
 * definitions, so they moved here unchanged — same ids, same names, same
 * interval sets, same display order for the Piano Roll — plus the standard
 * locrian intervals, and a typed lookup that refuses unknown ids instead of
 * guessing.
 *
 * `SCALE_PRESETS` keeps EXACTLY the historical Piano Roll list (14 entries,
 * minor first) so that UI and its tests are untouched; `MUSICAL_SCALE_INTERVALS`
 * is the complete union (15 entries) keyed by scale id for DSP use.
 */

export interface ScalePreset {
  id: MusicalScale;
  name: string;
  /** Semitone offsets from the root, within one octave. */
  notes: number[];
}

/** The Piano Roll's historical display list — order and content preserved. */
export const SCALE_PRESETS: ScalePreset[] = [
  { id: 'minor', name: 'Natural Minor (Aeolian)', notes: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'major', name: 'Major (Ionian)', notes: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'harmonic_minor', name: 'Harmonic Minor', notes: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodic_minor', name: 'Melodic Minor', notes: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'dorian', name: 'Dorian', notes: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', name: 'Phrygian', notes: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', name: 'Lydian', notes: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', name: 'Mixolydian', notes: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'pentatonic_minor', name: 'Minor Pentatonic', notes: [0, 3, 5, 7, 10] },
  { id: 'pentatonic_major', name: 'Major Pentatonic', notes: [0, 2, 4, 7, 9] },
  { id: 'blues', name: 'Blues Scale', notes: [0, 3, 5, 6, 7, 10] },
  { id: 'japanese_hirajoshi', name: 'Japanese Hirajoshi', notes: [0, 2, 3, 7, 8] },
  { id: 'arabic_double_harmonic', name: 'Arabic Double Harmonic', notes: [0, 1, 4, 5, 7, 8, 11] },
  { id: 'whole_tone', name: 'Whole Tone', notes: [0, 2, 4, 6, 8, 10] },
];

/**
 * Complete interval table for the `MusicalScale` union: the 14 Piano Roll
 * presets plus standard locrian ([0, 1, 3, 5, 6, 8, 10]) — a valid persisted
 * scale the Piano Roll list never displayed.
 */
const buildScaleIntervals = (): Readonly<Record<MusicalScale, readonly number[]>> => {
  const table: Record<string, readonly number[]> = {};
  for (const preset of SCALE_PRESETS) table[preset.id] = Object.freeze([...preset.notes]);
  table.locrian = Object.freeze([0, 1, 3, 5, 6, 8, 10]);
  return Object.freeze(table) as Readonly<Record<MusicalScale, readonly number[]>>;
};

export const MUSICAL_SCALE_INTERVALS: Readonly<Record<MusicalScale, readonly number[]>> = buildScaleIntervals();

/** True when `value` is a scale id the table can resolve. */
export const isMusicalScale = (value: unknown): value is MusicalScale =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(MUSICAL_SCALE_INTERVALS, value);

/**
 * Interval set for a scale id. Throws on unknown ids — callers must refuse
 * unsupported input rather than fall back to a different scale.
 */
export const scaleIntervals = (scale: MusicalScale): readonly number[] => {
  if (!isMusicalScale(scale)) {
    throw new Error(`Unknown musical scale "${String(scale)}" — no interval definition exists for it.`);
  }
  return MUSICAL_SCALE_INTERVALS[scale];
};
