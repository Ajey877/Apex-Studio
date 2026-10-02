import type { FxSlot, MixerTrack, ParametricEqBand } from '../types/daw';

/**
 * Phase 52 — Parametric EQ publication.
 *
 * The 7-band editor never reached audio: `onUpdateTrack` was destructured and
 * never called, and the band array lived in React state, so moving a band moved
 * a number on screen and nothing else.
 *
 * This module owns the mapping between the editor and the **production** insert
 * EQ. The production `equalizer` slot is a three-stage biquad chain —
 * lowshelf, peaking, highshelf (see `liveFxChainHardening.createEqualizer`, and
 * the legacy `AudioEngine.createFxNode` branch it mirrors). That is what the
 * engine has always built, so the editor now edits exactly those three stages
 * and publishes them into the slot's params.
 *
 * Deliberate constraints:
 *  - Only the three filter types the chain implements are offered. A
 *    highpass/lowpass stage would be drawn and then silently dropped.
 *  - There is no per-band bypass in the engine, so a disabled band is
 *    published as `gain: 0`. For lowshelf/peaking/highshelf a 0 dB gain with
 *    any Q is exactly transparent, so "disabled" is an accurate bypass rather
 *    than a UI-only flag.
 *  - The param names are the engine's contract (`lowFreq`, `lowQ`, `lowGain`,
 *    `midFreq`, …). Renaming them here without changing the readers would
 *    silently fall back to defaults, so they are declared once, below.
 */

export type EqBandRole = 'low' | 'mid' | 'high';

export const EQ_BAND_ROLES: readonly EqBandRole[] = ['low', 'mid', 'high'];

/** The filter type each stage of the production chain implements. */
export const EQ_BAND_FILTER_TYPE: Readonly<Record<EqBandRole, ParametricEqBand['type']>> = {
  low: 'lowshelf',
  mid: 'peaking',
  high: 'highshelf',
};

export interface EqBandSpec {
  readonly role: EqBandRole;
  readonly label: string;
  readonly color: string;
  readonly defaultFrequency: number;
  readonly defaultGain: number;
  readonly defaultQ: number;
}

export const EQ_BAND_SPECS: readonly EqBandSpec[] = [
  { role: 'low', label: 'LOW SHELF', color: '#e67e22', defaultFrequency: 120, defaultGain: 0, defaultQ: 0.9 },
  { role: 'mid', label: 'MID BELL', color: '#2ecc71', defaultFrequency: 1200, defaultGain: 0, defaultQ: 1.2 },
  { role: 'high', label: 'HIGH SHELF', color: '#3498db', defaultFrequency: 6500, defaultGain: 0, defaultQ: 0.8 },
];

/** Slot-param names, in the exact spelling the production readers use. */
export const eqParamNames = (role: EqBandRole) => ({
  frequency: `${role}Freq`,
  gain: `${role}Gain`,
  q: `${role}Q`,
});

export const EQ_FREQ_MIN_HZ = 20;
export const EQ_FREQ_MAX_HZ = 20000;
export const EQ_GAIN_MIN_DB = -18;
export const EQ_GAIN_MAX_DB = 18;
export const EQ_Q_MIN = 0.1;
export const EQ_Q_MAX = 10;

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

const bandIdFor = (role: EqBandRole): number => EQ_BAND_ROLES.indexOf(role) + 1;

export const createFlatEqBands = (): ParametricEqBand[] =>
  EQ_BAND_SPECS.map(spec => ({
    id: bandIdFor(spec.role),
    type: EQ_BAND_FILTER_TYPE[spec.role],
    frequency: spec.defaultFrequency,
    gain: spec.defaultGain,
    q: spec.defaultQ,
    enabled: true,
    color: spec.color,
  }));

export interface EqPreset {
  readonly name: string;
  readonly bands: readonly ParametricEqBand[];
}

const presetBand = (
  role: EqBandRole,
  frequency: number,
  gain: number,
  q: number
): ParametricEqBand => {
  const spec = EQ_BAND_SPECS.find(candidate => candidate.role === role)!;
  return {
    id: bandIdFor(role),
    type: EQ_BAND_FILTER_TYPE[role],
    frequency,
    gain,
    q,
    enabled: true,
    color: spec.color,
  };
};

/**
 * Three-band presets. The previous seven-band presets also carried highpass and
 * lowpass stages the engine never built; those were dropped rather than drawn as
 * inert controls.
 */
export const EQ_PRESETS: readonly EqPreset[] = [
  {
    name: 'Vocal Clarity & Air',
    bands: [presetBand('low', 200, -2, 0.9), presetBand('mid', 2800, 3.5, 1.5), presetBand('high', 11000, 4.5, 0.7)],
  },
  {
    name: '808 Sub Bass Sculpt',
    bands: [presetBand('low', 65, 4, 1.2), presetBand('mid', 800, 1.5, 2.0), presetBand('high', 6000, -6, 0.8)],
  },
  {
    name: 'Master Bus Polish',
    bands: [presetBand('low', 100, 1.2, 0.7), presetBand('mid', 1500, 0, 1.0), presetBand('high', 12500, 2.5, 0.7)],
  },
  {
    name: 'Punchy Drum Bus',
    bands: [presetBand('low', 85, 3.5, 1.0), presetBand('mid', 2500, 2.5, 1.8), presetBand('high', 10000, 2.0, 0.8)],
  },
];

/** The slot id the editor owns on a given track, so it can be re-found. */
export const EQ_SLOT_ID_PREFIX = 'fx-eq-';

export const findEqualizerSlot = (track: MixerTrack): FxSlot | undefined =>
  track.fxSlots.find(slot => slot.type === 'equalizer');

/**
 * Editor bands -> production slot params.
 *
 * A disabled band is published as 0 dB gain, which is a true bypass for these
 * filter types, so the published params fully describe what the chain does.
 */
export const eqBandsToSlotParams = (bands: readonly ParametricEqBand[]): Record<string, number> => {
  const params: Record<string, number> = {};
  for (const spec of EQ_BAND_SPECS) {
    const role = spec.role;
    const band = bands.find(candidate => candidate.id === bandIdFor(role));
    const names = eqParamNames(role);
    if (!band) {
      params[names.frequency] = spec.defaultFrequency;
      params[names.gain] = 0;
      params[names.q] = spec.defaultQ;
      continue;
    }
    params[names.frequency] = clamp(band.frequency, EQ_FREQ_MIN_HZ, EQ_FREQ_MAX_HZ);
    params[names.gain] = band.enabled ? clamp(band.gain, EQ_GAIN_MIN_DB, EQ_GAIN_MAX_DB) : 0;
    params[names.q] = clamp(band.q, EQ_Q_MIN, EQ_Q_MAX);
  }
  return params;
};

/** Production slot params -> editor bands. Missing params fall back to flat. */
export const eqBandsFromSlotParams = (params: Record<string, number | string | boolean>): ParametricEqBand[] =>
  EQ_BAND_SPECS.map(spec => {
    const names = eqParamNames(spec.role);
    const frequency = Number(params[names.frequency]);
    const gain = Number(params[names.gain]);
    const q = Number(params[names.q]);
    return {
      id: bandIdFor(spec.role),
      type: EQ_BAND_FILTER_TYPE[spec.role],
      frequency: Number.isFinite(frequency) ? clamp(frequency, EQ_FREQ_MIN_HZ, EQ_FREQ_MAX_HZ) : spec.defaultFrequency,
      gain: Number.isFinite(gain) ? clamp(gain, EQ_GAIN_MIN_DB, EQ_GAIN_MAX_DB) : spec.defaultGain,
      q: Number.isFinite(q) ? clamp(q, EQ_Q_MIN, EQ_Q_MAX) : spec.defaultQ,
      enabled: true,
      color: spec.color,
    };
  });

/**
 * Reads the bands the track will actually be rendered with. A track with no EQ
 * insert reports flat bands — that is the engine's real behaviour, because no
 * EQ node exists in the chain.
 */
export const readEqBandsFromTrack = (track: MixerTrack): ParametricEqBand[] => {
  const slot = findEqualizerSlot(track);
  return slot ? eqBandsFromSlotParams(slot.params) : createFlatEqBands();
};

/**
 * Publishes the editor's bands onto the track, creating the EQ insert when the
 * track does not have one. Creating the insert is what makes the values reach
 * audio at all, and it goes through the caller's normal `onUpdateTrack`
 * mutation, so history, persistence and the live mixer stay consistent.
 */
export const publishEqBandsToTrack = (track: MixerTrack, bands: readonly ParametricEqBand[]): MixerTrack => {
  const params = eqBandsToSlotParams(bands);
  const existing = findEqualizerSlot(track);

  if (existing) {
    return {
      ...track,
      fxSlots: track.fxSlots.map(slot =>
        slot.id === existing.id ? { ...slot, params: { ...slot.params, ...params } } : slot
      ),
    };
  }

  const created: FxSlot = {
    id: `${EQ_SLOT_ID_PREFIX}${track.id}`,
    type: 'equalizer',
    name: '3-Band EQ',
    enabled: true,
    // The insert EQ has no dry path in the engine (the wet/dry wrapper is in
    // series), so a full mix is the only setting that passes the whole signal
    // through the filters.
    mix: 1,
    params,
  };

  return { ...track, fxSlots: [...track.fxSlots, created] };
};
