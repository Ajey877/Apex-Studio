import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDECHAIN_LIMITS,
  amountToMaxReductionDb,
  hasSidechainFeedbackCycle,
  isLevelDetectedSidechain,
  normalizeSidechainSettings,
  resolveSidechainMode,
} from './sidechainCompression';
import type { SidechainSettings } from '../types/daw';

/**
 * Phase 9A — pure sidechain model: depth mapping, normalization and the
 * routing rules that keep the detector out of a feedback loop.
 */

test('the duck amount maps to the same depth ceiling in both modes', () => {
  assert.equal(amountToMaxReductionDb(0), 0);
  assert.ok(Math.abs(amountToMaxReductionDb(0.5) - 6.0206) < 0.001, 'amount 0.5 is a 6 dB maximum duck');
  assert.ok(Math.abs(amountToMaxReductionDb(0.75) - 12.0412) < 0.001, 'amount 0.75 is a 12 dB maximum duck');
  assert.ok(Math.abs(amountToMaxReductionDb(0.9) - 20) < 0.001, 'amount 0.9 is a 20 dB maximum duck');
  // The legacy envelope floors at 0.02 gain, so amount 1 is ~34 dB, never ∞.
  assert.ok(Math.abs(amountToMaxReductionDb(1) - -20 * Math.log10(0.02)) < 0.001);
  // Out-of-range values are clamped, never passed through.
  assert.equal(amountToMaxReductionDb(-3), 0);
  assert.ok(amountToMaxReductionDb(9) <= 48);
  assert.equal(amountToMaxReductionDb(Number.NaN), amountToMaxReductionDb(0.75), 'a non-numeric amount falls back to the default depth');
});

test('a legacy sidechain normalizes to the note-triggered mode', () => {
  const legacy = { enabled: true, sourceTrackId: 4, amount: 0.6, attackMs: 8, releaseMs: 200 };
  const normalized = normalizeSidechainSettings(legacy);
  assert.ok(normalized);
  assert.equal(normalized!.mode, 'note-trigger');
  assert.equal(normalized!.thresholdDb, -18, 'the detector defaults are filled in');
  assert.equal(normalized!.ratio, 4);
  assert.equal(resolveSidechainMode(normalized), 'note-trigger');
  assert.equal(isLevelDetectedSidechain(normalized), false);
});

test('an unknown mode never silently becomes level detection', () => {
  for (const mode of ['level', 'LEVEL-DETECTED', '', 42, null, undefined]) {
    const normalized = normalizeSidechainSettings({ enabled: true, sourceTrackId: 1, amount: 0.5, attackMs: 5, releaseMs: 100, mode });
    assert.equal(normalized!.mode, 'note-trigger', `mode ${String(mode)} must not select the detector`);
  }
  const level = normalizeSidechainSettings({ enabled: true, sourceTrackId: 1, amount: 0.5, attackMs: 5, releaseMs: 100, mode: 'level-detected' });
  assert.equal(level!.mode, 'level-detected');
  assert.equal(resolveSidechainMode(level), 'level-detected');
  assert.equal(isLevelDetectedSidechain(level), true);
  assert.equal(isLevelDetectedSidechain({ ...level!, enabled: false }), false, 'a disabled route is not active');
});

test('stored parameters are clamped into the engine ranges on load', () => {
  const normalized = normalizeSidechainSettings({
    enabled: true,
    sourceTrackId: 2,
    amount: 12,
    attackMs: 0,
    releaseMs: 99999,
    mode: 'level-detected',
    thresholdDb: 24,
    ratio: -4,
  });
  assert.ok(normalized);
  assert.equal(normalized!.amount, SIDECHAIN_LIMITS.amount.max);
  assert.equal(normalized!.attackMs, SIDECHAIN_LIMITS.attackMs.min);
  assert.equal(normalized!.releaseMs, SIDECHAIN_LIMITS.releaseMs.max);
  assert.equal(normalized!.thresholdDb, SIDECHAIN_LIMITS.thresholdDb.max);
  assert.equal(normalized!.ratio, SIDECHAIN_LIMITS.ratio.min);
  assert.equal(normalized!.mode, 'level-detected');

  const malformed = normalizeSidechainSettings({
    enabled: 'yes',
    sourceTrackId: 'x',
    amount: null,
    attackMs: {},
    releaseMs: Number.POSITIVE_INFINITY,
  });
  assert.ok(malformed);
  assert.equal(malformed!.enabled, false, 'only a real boolean enables a route');
  assert.equal(malformed!.sourceTrackId, 1);
  assert.equal(malformed!.amount, 0.75);
  assert.equal(malformed!.attackMs, 5);
  assert.equal(malformed!.releaseMs, 140);
  assert.equal(normalizeSidechainSettings(null), undefined);
  assert.equal(normalizeSidechainSettings('sidechain'), undefined);
});

test('a feedback loop through the destination is detected', () => {
  const routes = [
    { trackId: 1, targetId: 0 },
    { trackId: 2, targetId: 3 },
    { trackId: 3, targetId: 1 },
  ];
  // Destination 2 feeds the source 1, so tapping 1 to duck 2 closes a loop.
  assert.equal(hasSidechainFeedbackCycle(routes, 1, 2), true);
  // Source 3 feeds destination 2 (3 -> 1 -> master while 2 -> 3 is the loop
  // above); with a serial bus instead, the same shape is safe:
  const serial = [
    { trackId: 1, targetId: 0 },
    { trackId: 2, targetId: 0 },
    { trackId: 3, targetId: 2 },
  ];
  // Source 3 feeds destination 2, and nothing carries 2's audio back to 3.
  assert.equal(hasSidechainFeedbackCycle(serial, 3, 2), false);
  assert.equal(hasSidechainFeedbackCycle(serial, 1, 3), false);
  // Self-routing is always a loop.
  assert.equal(hasSidechainFeedbackCycle(routes, 2, 2), true);
  // Aux sends are audio edges too.
  const withAux = [...routes, { trackId: 4, targetId: 1 }];
  assert.equal(hasSidechainFeedbackCycle(withAux, 1, 4), true);
  // A route to master ends the walk.
  assert.equal(hasSidechainFeedbackCycle([{ trackId: 5, targetId: 0 }], 1, 5), false);
});

test('the note-triggered depth and the detector depth share one amount field', () => {
  const settings: SidechainSettings = {
    enabled: true,
    sourceTrackId: 1,
    amount: 0.75,
    attackMs: 5,
    releaseMs: 140,
    mode: 'level-detected',
  };
  const normalized = normalizeSidechainSettings(settings)!;
  assert.equal(normalized.amount, 0.75);
  assert.ok(Math.abs(amountToMaxReductionDb(normalized.amount) - 12.0412) < 0.001);
});
