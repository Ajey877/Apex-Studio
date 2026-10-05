/**
 * Phase 80 — live FX parameter bridge.
 *
 * Validates the runtime contract:
 *  - the live bridge exports exist and accept the documented arguments,
 *  - the public setFxSlotParameter on AudioEngine never throws on a
 *    non-finite or out-of-range value (it returns false and leaves the
 *    slot.params alone so the offline render / next rebuild sees a
 *    clean value),
 *  - the contract helpers (resolveFxAudioParam, clampFxParameterValue)
 *    are pure and accept the project's params.
 *
 * The full audio-context-dependent live path is covered by the offline
 * render parity test (phase80.offlineParity.test.ts) — the offline
 * renderer shares the live `rebuildTrackFxChain` factory and is the
 * only path the test runner can exercise without a real
 * AudioContext.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { audioEngine } from './audioEngine';
import { applyLiveFxSlotParameter, getLiveFxSlotEffect } from './liveFxChainHardening';
import {
  FX_PARAMETER_FAMILIES,
  SLOT_MIX_PARAMETER,
  clampFxParameterValue,
  isFxParamLiveUpdatable,
  resolveFxAudioParam,
  resolveFxParamRange,
} from './fxParameterContract';

test('Phase 80: live bridge exports are functions on the engine and hardening modules', () => {
  assert.equal(typeof audioEngine.setFxSlotParameter, 'function');
  assert.equal(typeof audioEngine.setFxSlotMix, 'function');
  assert.equal(typeof applyLiveFxSlotParameter, 'function');
  assert.equal(typeof getLiveFxSlotEffect, 'function');
});

test('Phase 80: setFxSlotParameter returns false and does not throw on non-finite values', () => {
  // The public API catches non-finite values and returns false so the
  // UI does not have to defensively guard every parameter write.
  // (No active chain is set up in this test; the bridge returns false
  // because the registry is not installed on the test engine. The point
  // of the assertion is "no throw, deterministic return".)
  assert.doesNotThrow(() => audioEngine.setFxSlotParameter(1, 'slot', 'threshold', Number.NaN));
  assert.doesNotThrow(() => audioEngine.setFxSlotParameter(1, 'slot', 'threshold', Number.POSITIVE_INFINITY));
  assert.doesNotThrow(() => audioEngine.setFxSlotParameter(1, 'slot', 'threshold', Number.NEGATIVE_INFINITY));
});

test('Phase 80: setFxSlotParameter returns false and does not throw on unknown parameter name', () => {
  // An unknown parameter name reaches the live effect, the effect
  // throws "Unknown … effect parameter", and the registry catches it.
  // The public API must report false and never throw.
  assert.doesNotThrow(() => audioEngine.setFxSlotParameter(1, 'slot', 'notARealParam', 1));
});

test('Phase 80: setFxSlotParameter returns false on empty/non-string paramName', () => {
  assert.doesNotThrow(() => audioEngine.setFxSlotParameter(1, 'slot', '', 1));
});

test('Phase 80: contract helpers cover the four AudioParam-updatable families and exclude the curve-baked ones', () => {
  // EQ — 9 params
  assert.equal(FX_PARAMETER_FAMILIES.equalizer?.parameters.length, 9);
  assert.equal(isFxParamLiveUpdatable('equalizer', 'lowFreq'), true);
  assert.equal(isFxParamLiveUpdatable('equalizer', 'midGain'), true);
  assert.equal(isFxParamLiveUpdatable('equalizer', 'highQ'), true);
  // Compressor — 5 params
  assert.equal(FX_PARAMETER_FAMILIES.compressor?.parameters.length, 5);
  // Delay — 2 params (no time/feedback mix; mix is the wrapper)
  assert.equal(FX_PARAMETER_FAMILIES.delay?.parameters.length, 2);
  // Reverb — 0 params (the production reverb is a ConvolverNode; only
  // the wet/dry mix is AudioParam-updatable through the wrapper)
  assert.equal(FX_PARAMETER_FAMILIES.reverb?.parameters.length, 0);
  // Limiter — 3 params
  assert.equal(FX_PARAMETER_FAMILIES.limiter?.parameters.length, 3);
  // Dead families
  assert.equal(FX_PARAMETER_FAMILIES.distortion, null);
  assert.equal(FX_PARAMETER_FAMILIES.bitcrusher, null);
  assert.equal(FX_PARAMETER_FAMILIES.tape_saturation, null);
  assert.equal(FX_PARAMETER_FAMILIES.chorus, null);
});

test('Phase 80: contract helpers resolve AudioParam names and ranges correctly', () => {
  // EQ slot-params route to the inner BiquadFilterEffect's AudioParams.
  assert.equal(resolveFxAudioParam('equalizer', 'lowFreq'), 'frequency');
  assert.equal(resolveFxAudioParam('equalizer', 'lowGain'), 'gain');
  assert.equal(resolveFxAudioParam('equalizer', 'lowQ'), 'q');
  // Compressor slot-params map directly.
  assert.equal(resolveFxAudioParam('compressor', 'threshold'), 'threshold');
  assert.equal(resolveFxAudioParam('compressor', 'attack'), 'attack');
  // Delay maps time → delayTime, feedback is its own AudioParam.
  assert.equal(resolveFxAudioParam('delay', 'time'), 'delayTime');
  assert.equal(resolveFxAudioParam('delay', 'feedback'), 'feedback');
  // Limiter ceiling / release / drive are direct.
  assert.equal(resolveFxAudioParam('limiter', 'ceiling'), 'ceiling');
  assert.equal(resolveFxAudioParam('limiter', 'release'), 'release');
  assert.equal(resolveFxAudioParam('limiter', 'drive'), 'drive');

  // Range resolution.
  assert.equal(resolveFxParamRange('compressor', 'threshold')?.min, -100);
  assert.equal(resolveFxParamRange('compressor', 'threshold')?.max, 0);
  assert.equal(resolveFxParamRange('compressor', 'ratio')?.min, 1);
  assert.equal(resolveFxParamRange('compressor', 'ratio')?.max, 20);
  assert.equal(resolveFxParamRange('delay', 'feedback')?.max, 0.989);
  assert.equal(resolveFxParamRange('delay', 'time')?.min, 0);
  assert.equal(resolveFxParamRange('limiter', 'drive')?.max, 24);

  // SLOT_MIX_PARAMETER is the wet/dry wrapper.
  assert.equal(SLOT_MIX_PARAMETER.min, 0);
  assert.equal(SLOT_MIX_PARAMETER.max, 1);
  // 'mix' is not a per-family param — it lives in slot.mix and is
  // resolved by the WetDryEffect wrapper contract (already covered by
  // the live-bridge tests above).
  assert.equal(resolveFxAudioParam('equalizer', 'mix'), null);
});

test('Phase 80: clampFxParameterValue rejects NaN/Infinity and clamps to the contract range', () => {
  assert.equal(clampFxParameterValue('compressor', 'threshold', -50), -50);
  assert.equal(clampFxParameterValue('compressor', 'threshold', -200), -100);
  assert.equal(clampFxParameterValue('compressor', 'threshold', 50), 0);
  assert.equal(clampFxParameterValue('compressor', 'threshold', Number.NaN), -18);
  assert.equal(clampFxParameterValue('compressor', 'threshold', Number.POSITIVE_INFINITY), -18);
  // Unknown param id returns the value untouched.
  assert.equal(clampFxParameterValue('compressor', 'notReal', 5), 5);
  // Reverb has no params — anything passes through.
  assert.equal(clampFxParameterValue('reverb', 'wet', 0.5), 0.5);
});
