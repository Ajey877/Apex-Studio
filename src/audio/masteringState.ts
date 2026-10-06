import type { MasteringSuiteState, MultibandBandSettings } from '../types/daw';

export const DEFAULT_MASTERING_SUITE_STATE: MasteringSuiteState = {
  enabled: true,
  lufsTarget: -14,
  lowCrossFreq: 150,
  highCrossFreq: 3500,
  lowBand: { enabled: true, threshold: -18, ratio: 3, attack: 20, release: 100, gain: 1, knee: 6, solo: false, mute: false },
  midBand: { enabled: true, threshold: -22, ratio: 2.5, attack: 15, release: 80, gain: 0, knee: 4, solo: false, mute: false },
  highBand: { enabled: true, threshold: -20, ratio: 2, attack: 10, release: 60, gain: 1.5, knee: 3, solo: false, mute: false },
  stereoSpread: 1.15,
  monoSubFreq: 120,
  maximizerThreshold: -3.5,
  maximizerCeiling: -0.2,
  maximizerRelease: 80,
  maximizerLookahead: true,
};

const finite = (value: unknown, fallback: number, min: number, max: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

function normalizeBand(value: unknown, fallback: MultibandBandSettings): MultibandBandSettings {
  const candidate = value && typeof value === 'object' ? value as Partial<MultibandBandSettings> : {};
  return {
    enabled: bool(candidate.enabled, fallback.enabled),
    threshold: finite(candidate.threshold, fallback.threshold, -48, 0),
    ratio: finite(candidate.ratio, fallback.ratio, 1, 20),
    attack: finite(candidate.attack, fallback.attack, 0.1, 500),
    release: finite(candidate.release, fallback.release, 1, 2000),
    gain: finite(candidate.gain, fallback.gain, -12, 12),
    knee: finite(candidate.knee, fallback.knee, 0, 40),
    solo: bool(candidate.solo, fallback.solo),
    mute: bool(candidate.mute, fallback.mute),
  };
}

/** Migrate old projects and clamp malformed mastering values at the document boundary. */
export function normalizeMasteringSuiteState(value: unknown): MasteringSuiteState {
  const candidate = value && typeof value === 'object' ? value as Partial<MasteringSuiteState> : {};
  const fallback = DEFAULT_MASTERING_SUITE_STATE;
  return {
    enabled: bool(candidate.enabled, fallback.enabled),
    lufsTarget: finite(candidate.lufsTarget, fallback.lufsTarget, -24, -6),
    lowCrossFreq: finite(candidate.lowCrossFreq, fallback.lowCrossFreq, 40, 1000),
    highCrossFreq: finite(candidate.highCrossFreq, fallback.highCrossFreq, 500, 18000),
    lowBand: normalizeBand(candidate.lowBand, fallback.lowBand),
    midBand: normalizeBand(candidate.midBand, fallback.midBand),
    highBand: normalizeBand(candidate.highBand, fallback.highBand),
    stereoSpread: finite(candidate.stereoSpread, fallback.stereoSpread, 0, 2),
    monoSubFreq: finite(candidate.monoSubFreq, fallback.monoSubFreq, 20, 500),
    maximizerThreshold: finite(candidate.maximizerThreshold, fallback.maximizerThreshold, -12, 0),
    maximizerCeiling: finite(candidate.maximizerCeiling, fallback.maximizerCeiling, -1, 0),
    maximizerRelease: finite(candidate.maximizerRelease, fallback.maximizerRelease, 10, 500),
    maximizerLookahead: bool(candidate.maximizerLookahead, fallback.maximizerLookahead),
  };
}
