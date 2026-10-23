/**
 * Phase 9B — the lookahead limiter's settings must survive a save/load cycle.
 *
 * `maximizerLookaheadMs` is a new *persisted* field, so two things have to hold:
 *
 *  1. A project written by this version round-trips its exact value.
 *  2. A project written before this version — which only has the legacy boolean
 *     `maximizerLookahead` — keeps the meaning it had (true = 5 ms lookahead,
 *     false = direct) instead of silently becoming a different setting.
 *
 * The tests drive the real document normalizer (`normalizeProjectState`) and the
 * real control writer (`applyMasteringControlChange`), so they cover the path a
 * loaded project actually takes rather than a copy of it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { DEFAULT_MASTERING_SUITE_STATE, MASTERING_NORMALIZATION_BOUNDS } from '../audio/masteringState';
import { MASTERING_CONTROL_RANGES, applyMasteringControlChange } from '../audio/masteringControls';
import { MASTERING_LIMITER_DEFAULT_LOOKAHEAD_MS } from '../audio/masteringLimiter';

const withMastering = (masteringSuiteState: Record<string, unknown>) =>
  normalizeProjectState({ ...createDefaultProjectState(), masteringSuiteState }).masteringSuiteState!;

describe('Phase 9B — limiter lookahead is a persisted setting', () => {
  it('ships a documented default (5 ms lookahead, not direct)', () => {
    assert.equal(DEFAULT_MASTERING_SUITE_STATE.maximizerLookaheadMs, MASTERING_LIMITER_DEFAULT_LOOKAHEAD_MS);
    assert.equal(DEFAULT_MASTERING_SUITE_STATE.maximizerLookaheadMs, 5);
    assert.equal(DEFAULT_MASTERING_SUITE_STATE.maximizerLookahead, true);
  });

  it('round-trips an explicit value through project normalization', () => {
    for (const ms of [0, 1, 5, 12, 20]) {
      const state = withMastering({
        ...DEFAULT_MASTERING_SUITE_STATE,
        maximizerLookaheadMs: ms,
        maximizerLookahead: ms > 0,
      });
      assert.equal(state.maximizerLookaheadMs, ms, `${ms} ms must round-trip`);
      assert.equal(state.maximizerLookahead, ms > 0, `${ms} ms must keep the legacy boolean in step`);
    }
  });

  it('migrates a pre-9B project from the legacy boolean', () => {
    // A document written by Phase 9A has no `maximizerLookaheadMs` at all.
    const legacyOn = { ...DEFAULT_MASTERING_SUITE_STATE, maximizerLookahead: true } as Record<string, unknown>;
    delete legacyOn.maximizerLookaheadMs;
    assert.equal(withMastering(legacyOn).maximizerLookaheadMs, 5, 'lookahead on meant the documented 5 ms');

    const legacyOff = { ...DEFAULT_MASTERING_SUITE_STATE, maximizerLookahead: false } as Record<string, unknown>;
    delete legacyOff.maximizerLookaheadMs;
    assert.equal(withMastering(legacyOff).maximizerLookaheadMs, 0, 'lookahead off meant no delay');
  });

  it('lets an explicit millisecond value win over the legacy boolean', () => {
    const state = withMastering({ ...DEFAULT_MASTERING_SUITE_STATE, maximizerLookahead: false, maximizerLookaheadMs: 12 });
    assert.equal(state.maximizerLookaheadMs, 12);
    assert.equal(state.maximizerLookahead, false, 'the legacy field is preserved verbatim');
  });

  it('clamps out-of-range and malformed values to the documented bounds', () => {
    const bounds = MASTERING_NORMALIZATION_BOUNDS.maximizerLookaheadMs;
    assert.equal(withMastering({ ...DEFAULT_MASTERING_SUITE_STATE, maximizerLookaheadMs: 999 }).maximizerLookaheadMs, bounds.max);
    assert.equal(withMastering({ ...DEFAULT_MASTERING_SUITE_STATE, maximizerLookaheadMs: -4 }).maximizerLookaheadMs, bounds.min);
    assert.equal(withMastering({ ...DEFAULT_MASTERING_SUITE_STATE, maximizerLookaheadMs: 'loud' }).maximizerLookaheadMs, 5);
    assert.equal(withMastering({ ...DEFAULT_MASTERING_SUITE_STATE, maximizerLookaheadMs: Number.NaN }).maximizerLookaheadMs, 5);
  });

  it('keeps the slider inside the document bounds', () => {
    const bounds = MASTERING_NORMALIZATION_BOUNDS.maximizerLookaheadMs;
    const range = MASTERING_CONTROL_RANGES.maximizerLookaheadMs;
    assert.ok(range.min >= bounds.min);
    assert.ok(range.max <= bounds.max);
    assert.ok(range.min <= DEFAULT_MASTERING_SUITE_STATE.maximizerLookaheadMs!);
    assert.ok(range.max >= DEFAULT_MASTERING_SUITE_STATE.maximizerLookaheadMs!);
  });

  it('writes the millisecond field and the legacy boolean together', () => {
    const zero = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'maximizerLookaheadMs', '0');
    assert.equal(zero.maximizerLookaheadMs, 0);
    assert.equal(zero.maximizerLookahead, false, '0 ms is the direct mode, so the legacy flag turns off');

    const twenty = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'maximizerLookaheadMs', '20');
    assert.equal(twenty.maximizerLookaheadMs, 20);
    assert.equal(twenty.maximizerLookahead, true);

    // Out-of-range input is clamped to the control's range, not written raw.
    assert.equal(applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'maximizerLookaheadMs', '500').maximizerLookaheadMs, 20);
    assert.equal(applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'maximizerLookaheadMs', '-3').maximizerLookaheadMs, 0);

    // A no-op edit keeps the same object so no history entry is written.
    const unchanged = applyMasteringControlChange(DEFAULT_MASTERING_SUITE_STATE, 'maximizerLookaheadMs', '5');
    assert.equal(unchanged, DEFAULT_MASTERING_SUITE_STATE);
  });
});
