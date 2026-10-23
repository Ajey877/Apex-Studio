/**
 * Phase 8B — wavetable presets.
 *
 * Presets are plain, engine-consumed parameter sets. Applying one writes a
 * `WavetableParameters` object onto the channel and switches the channel to the
 * `wavetable` instrument, so choosing a preset changes both the saved project
 * state and the rendered signal. They live in `src/audio/` (not the modal) so
 * the DSP tests can prove each preset produces a different table.
 */
import type { WavetableParameters } from '../types/daw';

export interface WavetablePreset {
  readonly name: string;
  readonly description: string;
  /** Values merged over the channel's current settings (then clamped). */
  readonly values: Partial<WavetableParameters>;
}

export const WAVETABLE_PRESETS: readonly WavetablePreset[] = Object.freeze([
  {
    name: 'Warm Analog',
    description: 'Saw-weighted morph, light 3-voice unison',
    values: {
      morph: 0.45,
      warpMode: 'none',
      warpAmount: 0,
      harmonics: [1, 0.72, 0.5, 0.34, 0.22, 0.14, 0.09, 0.05],
      unisonVoices: 3,
      unisonDetuneCents: 9,
      unisonSpread: 0.2,
    },
  },
  {
    name: 'Hyper Supersaw',
    description: '7-voice detuned saw stack, wide stereo',
    values: {
      morph: 0.5,
      warpMode: 'none',
      warpAmount: 0,
      harmonics: [1, 0.85, 0.7, 0.55, 0.45, 0.35, 0.28, 0.2],
      unisonVoices: 7,
      unisonDetuneCents: 32,
      unisonSpread: 0.9,
    },
  },
  {
    name: 'Metallic Table',
    description: 'Metallic frame with a bent phase',
    values: {
      morph: 1,
      warpMode: 'bend',
      warpAmount: 0.55,
      harmonics: [0.8, 1, 0.75, 0.6, 0.5, 0.4, 0.3, 0.25],
      unisonVoices: 2,
      unisonDetuneCents: 6,
      unisonSpread: 0.35,
    },
  },
  {
    name: 'Reese Growl',
    description: 'Hollow morph, pulse-width difference, tight unison',
    values: {
      morph: 0.7,
      warpMode: 'pwm',
      warpAmount: 0.4,
      harmonics: [1, 0.6, 0.4, 0.3, 0.2, 0.12, 0.08, 0.04],
      unisonVoices: 5,
      unisonDetuneCents: 24,
      unisonSpread: 0.15,
    },
  },
  {
    name: 'Glass Sync',
    description: 'Hard-sync table read with a bright partial shape',
    values: {
      morph: 0.8,
      warpMode: 'sync',
      warpAmount: 0.45,
      harmonics: [0.9, 0.5, 0.7, 0.3, 0.5, 0.25, 0.35, 0.2],
      unisonVoices: 4,
      unisonDetuneCents: 12,
      unisonSpread: 0.6,
    },
  },
]);
