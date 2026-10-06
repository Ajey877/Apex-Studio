import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { DEFAULT_MASTERING_SUITE_STATE } from '../audio/masteringState';

describe('Phase 89 mastering settings are project-owned', () => {
  it('provides defaults for new projects', () => {
    const project = createDefaultProjectState();
    assert.deepEqual(project.masteringSuiteState, DEFAULT_MASTERING_SUITE_STATE);
  });

  it('round-trips custom mastering settings through project normalization', () => {
    const project = createDefaultProjectState();
    const settings = {
      ...DEFAULT_MASTERING_SUITE_STATE,
      enabled: false,
      stereoSpread: 1.7,
      maximizerCeiling: -0.8,
      lowBand: { ...DEFAULT_MASTERING_SUITE_STATE.lowBand, threshold: -30, ratio: 5 },
    };
    const normalized = normalizeProjectState({ ...project, masteringSuiteState: settings });
    assert.deepEqual(normalized.masteringSuiteState, settings);
  });

  it('migrates older projects and clamps malformed settings safely', () => {
    const project: Record<string, unknown> = { ...createDefaultProjectState() };
    delete project.masteringSuiteState;
    const migrated = normalizeProjectState(project);
    assert.deepEqual(migrated.masteringSuiteState, DEFAULT_MASTERING_SUITE_STATE);

    const malformed = normalizeProjectState({
      ...project,
      masteringSuiteState: {
        enabled: true,
        stereoSpread: 99,
        maximizerCeiling: -99,
        lowBand: { enabled: true, threshold: -1000, ratio: 0, attack: 20, release: 100, gain: 99, knee: 6, solo: false, mute: false },
      },
    });
    assert.equal(malformed.masteringSuiteState?.stereoSpread, 2);
    assert.equal(malformed.masteringSuiteState?.maximizerCeiling, -1);
    assert.equal(malformed.masteringSuiteState?.lowBand.threshold, -48);
    assert.equal(malformed.masteringSuiteState?.lowBand.ratio, 1);
    assert.equal(malformed.masteringSuiteState?.lowBand.gain, 12);
  });
});
