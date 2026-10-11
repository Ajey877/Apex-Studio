import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { serializeProjectState } from './projectPersistence';
import { createHistory } from './projectHistory';
import {
  DEFAULT_MASTERING_SUITE_STATE,
  MASTERING_NORMALIZATION_BOUNDS,
} from '../audio/masteringState';
import {
  MASTERING_CONTROL_TARGETS,
  applyMasteringControlChange,
  toggleBandMute,
  toggleBandSolo,
} from '../audio/masteringControls';
import type { MasteringSuiteState } from '../types/daw';

/**
 * Phase 90 — the newly exposed controls must survive the project lifecycle.
 *
 * They reuse the existing `masteringSuiteState` document field, so the contract
 * under test is the one Phase 89 established: a control writes project state,
 * project state normalizes on the way through persistence and history, and the
 * engine bridge re-reads it. These tests pin the Phase 90 fields into that path
 * and prove undo/redo treats a mastering edit like any other edit.
 */

/** A state where every Phase 90 field differs from its default. */
const EDITED: MasteringSuiteState = {
  ...DEFAULT_MASTERING_SUITE_STATE,
  lowCrossFreq: 320,
  highCrossFreq: 9000,
  maximizerRelease: 240,
  lowBand: { ...DEFAULT_MASTERING_SUITE_STATE.lowBand, attack: 44, release: 260, knee: 9.5, solo: true, mute: false },
  midBand: { ...DEFAULT_MASTERING_SUITE_STATE.midBand, attack: 6, release: 85, knee: 2.5, solo: false, mute: true },
  highBand: { ...DEFAULT_MASTERING_SUITE_STATE.highBand, attack: 60, release: 420, knee: 11.5, solo: true, mute: false },
};

const projectWith = (masteringSuiteState: MasteringSuiteState) =>
  ({ ...createDefaultProjectState(), masteringSuiteState });

describe('Phase 90 — mastering controls survive project persistence round-trips', () => {
  it('round-trips every Phase 90 field through project normalization unchanged', () => {
    const normalized = normalizeProjectState(projectWith(EDITED));
    assert.deepEqual(normalized.masteringSuiteState, EDITED);
  });

  it('round-trips through serialization, the path autosave and history both use', () => {
    const serialized = serializeProjectState(projectWith(EDITED));
    const restored = normalizeProjectState(JSON.parse(serialized).state);
    assert.deepEqual(restored.masteringSuiteState, EDITED);
    // Spot-check the fields by name so a future serializer change that drops
    // them fails here rather than silently reverting the user's settings.
    assert.equal(restored.masteringSuiteState?.lowCrossFreq, 320);
    assert.equal(restored.masteringSuiteState?.highCrossFreq, 9000);
    assert.equal(restored.masteringSuiteState?.maximizerRelease, 240);
    assert.equal(restored.masteringSuiteState?.lowBand.attack, 44);
    assert.equal(restored.masteringSuiteState?.midBand.mute, true);
    assert.equal(restored.masteringSuiteState?.highBand.solo, true);
  });

  it('accepts every value each control can produce, so no edit is rewritten on save', () => {
    for (const target of MASTERING_CONTROL_TARGETS) {
      for (const raw of ['-1e9', '0', '1e9']) {
        const next = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, target, raw);
        const roundTripped = normalizeProjectState(projectWith(next)).masteringSuiteState;
        assert.deepEqual(roundTripped, next, `${target} <- ${raw} did not survive normalization`);
      }
    }
  });

  it('clamps a hand-edited project back inside the document bounds', () => {
    const malformed = normalizeProjectState(projectWith({
      ...DEFAULT_MASTERING_SUITE_STATE,
      lowCrossFreq: 99999,
      highCrossFreq: -5,
      maximizerRelease: 1e6,
      lowBand: { ...DEFAULT_MASTERING_SUITE_STATE.lowBand, attack: -20, release: 1e6, knee: 999 },
    }));
    const bounds = MASTERING_NORMALIZATION_BOUNDS;
    assert.equal(malformed.masteringSuiteState?.lowCrossFreq, bounds.lowCrossFreq.max);
    assert.equal(malformed.masteringSuiteState?.highCrossFreq, bounds.highCrossFreq.min);
    assert.equal(malformed.masteringSuiteState?.maximizerRelease, bounds.maximizerRelease.max);
    assert.equal(malformed.masteringSuiteState?.lowBand.attack, bounds.band.attack.min);
    assert.equal(malformed.masteringSuiteState?.lowBand.release, bounds.band.release.max);
    assert.equal(malformed.masteringSuiteState?.lowBand.knee, bounds.band.knee.max);
  });

  it('gives a project with no mastering block the defaults, including the Phase 90 fields', () => {
    const bare: Record<string, unknown> = { ...createDefaultProjectState() };
    delete bare.masteringSuiteState;
    const migrated = normalizeProjectState(bare);
    assert.equal(migrated.masteringSuiteState?.lowCrossFreq, 150);
    assert.equal(migrated.masteringSuiteState?.highCrossFreq, 3500);
    assert.equal(migrated.masteringSuiteState?.maximizerRelease, 80);
    assert.equal(migrated.masteringSuiteState?.lowBand.attack, 20);
    assert.equal(migrated.masteringSuiteState?.lowBand.knee, 6);
    assert.equal(migrated.masteringSuiteState?.midBand.solo, false);
  });
});

describe('Phase 90 — mastering control edits participate in undo/redo', () => {
  it('undoes and redoes a crossover edit like any other project edit', () => {
    const history0 = createHistory(createDefaultProjectState());
    const afterLowCross = { ...history0.present, masteringSuiteState: applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'lowCrossFreq', '300') };
    const history1 = history0.commit(afterLowCross, 'Update mastering settings');

    assert.equal(history1.canUndo, true);
    assert.equal(history1.present.masteringSuiteState?.lowCrossFreq, 300);
    assert.equal(history1.present.masteringSuiteState?.highCrossFreq, 3500, 'an unrelated field is untouched');

    const undone = history1.undo();
    assert.equal(undone.present.masteringSuiteState?.lowCrossFreq, 150, 'undo restores the previous crossover');

    const redone = undone.redo();
    assert.equal(redone.present.masteringSuiteState?.lowCrossFreq, 300, 'redo reapplies it');
  });

  it('undoes a band dynamics edit without disturbing the other bands', () => {
    const history0 = createHistory(createDefaultProjectState());
    const edited = {
      ...history0.present,
      masteringSuiteState: applyMasteringControlChange(
        applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'highBand.knee', '11'),
        'highBand.attack', '88'
      ),
    };
    const history1 = history0.commit(edited, 'Update mastering settings');
    assert.equal(history1.present.masteringSuiteState?.highBand.knee, 11);
    assert.equal(history1.present.masteringSuiteState?.highBand.attack, 88);

    const undone = history1.undo();
    assert.deepEqual(undone.present.masteringSuiteState, DEFAULT_MASTERING_SUITE_STATE);
    assert.equal(undone.present.masteringSuiteState?.lowBand.knee, DEFAULT_MASTERING_SUITE_STATE.lowBand.knee);
  });

  it('undoes solo and mute toggles', () => {
    const history0 = createHistory(createDefaultProjectState());
    const soloed = { ...history0.present, masteringSuiteState: toggleBandSolo(DEFAULT_MASTERING_SUITE_STATE, 'midBand') };
    const history1 = history0.commit(soloed, 'Update mastering settings');
    assert.equal(history1.present.masteringSuiteState?.midBand.solo, true);

    const muted = { ...history1.present, masteringSuiteState: toggleBandMute(history1.present.masteringSuiteState!, 'midBand') };
    const history2 = history1.commit(muted, 'Update mastering settings');
    assert.equal(history2.present.masteringSuiteState?.midBand.mute, true);
    assert.equal(history2.present.masteringSuiteState?.midBand.solo, true, 'solo survives the mute commit');

    assert.equal(history2.undo().present.masteringSuiteState?.midBand.mute, false, 'undo clears the mute');
    assert.equal(history2.undo().undo().present.masteringSuiteState?.midBand.solo, false, 'undo again clears the solo');
  });

  it('does not record a history entry when a control writes an unusable value', () => {
    const history0 = createHistory(createDefaultProjectState());
    const unchanged = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'lowCrossFreq', 'not a number');
    const history1 = history0.commit({ ...history0.present, masteringSuiteState: unchanged }, 'Update mastering settings');
    assert.equal(history1.canUndo, false, 'a no-op edit must not create an undo step');
  });

  it('treats a repeated identical value as no change, matching the control contract', () => {
    const history0 = createHistory(createDefaultProjectState());
    const same = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'maximizerRelease', String(DEFAULT_MASTERING_SUITE_STATE.maximizerRelease));
    const history1 = history0.commit({ ...history0.present, masteringSuiteState: same }, 'Update mastering settings');
    assert.equal(history1.canUndo, false);
  });
});
