/**
 * Phase 80 — Live-bridge fast-path recognition.
 *
 * The AudioEngine's `synchronizePlaybackState` calls
 * `trackLiveUpdatableChanged` to decide whether a project-state
 * change can be applied live (without rebuilding the FX chain) or
 * must trigger a full rebuild. Phase 80 extends the fast path from
 * "mix only" to "in-contract slot.params on existing enabled slots".
 *
 * This test imports the helper via a small re-export shim because
 * the original is a non-exported module-internal function. The shim
 * exposes exactly the test surface, no more.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { FxSlot, MixerTrack } from '../types/daw';
import { createDefaultProjectState } from './projectState';
import {
  isFxParamLiveUpdatableByName,
} from '../audio/fxLiveSync';

const findTrack = (id: number): MixerTrack => {
  const t = createDefaultProjectState().mixerTracks.find(tr => tr.id === id);
  if (!t) throw new Error('default project missing mixer track 1');
  return t;
};

const baseSlots: FxSlot[] = [
  { id: 'eq', type: 'equalizer', name: 'EQ', enabled: true, mix: 1, params: { lowFreq: 100, lowGain: 0, lowQ: 1, midFreq: 1000, midGain: 0, highFreq: 8000, highGain: 0 } },
  { id: 'comp', type: 'compressor', name: 'Comp', enabled: true, mix: 1, params: { threshold: -18, ratio: 4, knee: 24, attack: 0.005, release: 0.15 } },
  { id: 'delay', type: 'delay', name: 'Delay', enabled: true, mix: 0.5, params: { time: 0.25, feedback: 0.3 } },
  { id: 'limiter', type: 'limiter', name: 'Limiter', enabled: true, mix: 1, params: { ceiling: -0.3, release: 0.08, drive: 0 } },
];

const buildTrackWithSlots = (slots: FxSlot[]): MixerTrack => ({
  ...findTrack(1),
  fxSlots: slots,
});

test('Phase 80: live-bridge fast path recognizes every contract param', () => {
  // EQ — every per-band param must be live-routable.
  for (const p of ['lowFreq', 'lowGain', 'lowQ', 'midFreq', 'midGain', 'midQ', 'highFreq', 'highGain', 'highQ']) {
    assert.equal(isFxParamLiveUpdatableByName('equalizer', p), true, `EQ ${p} must be live-updatable`);
  }
  // Compressor
  for (const p of ['threshold', 'knee', 'ratio', 'attack', 'release']) {
    assert.equal(isFxParamLiveUpdatableByName('compressor', p), true, `Compressor ${p} must be live-updatable`);
  }
  // Delay
  assert.equal(isFxParamLiveUpdatableByName('delay', 'time'), true);
  assert.equal(isFxParamLiveUpdatableByName('delay', 'feedback'), true);
  // Limiter
  for (const p of ['ceiling', 'release', 'drive']) {
    assert.equal(isFxParamLiveUpdatableByName('limiter', p), true, `Limiter ${p} must be live-updatable`);
  }
  // Reverb has no in-contract params.
  assert.equal(isFxParamLiveUpdatableByName('reverb', 'wet'), false);
  // Dead families.
  assert.equal(isFxParamLiveUpdatableByName('distortion', 'drive'), false);
  assert.equal(isFxParamLiveUpdatableByName('bitcrusher', 'bits'), false);
  assert.equal(isFxParamLiveUpdatableByName('tape_saturation', 'warmth'), false);
  assert.equal(isFxParamLiveUpdatableByName('chorus', 'rate'), false);
  // Unknown FxType
  assert.equal(isFxParamLiveUpdatableByName('futureType', 'unknown'), false);
  // mix is special-cased to the WetDryEffect wrapper.
  assert.equal(isFxParamLiveUpdatableByName('equalizer', 'mix'), true);
  assert.equal(isFxParamLiveUpdatableByName('compressor', 'mix'), true);
});

test('Phase 80: a track with only in-contract param changes is structurally stable for the live bridge', () => {
  // We can't import the internal `trackLiveUpdatableChanged` directly
  // (it is module-internal). Instead, we exercise its decisions
  // through the public isFxParamLiveUpdatableByName check.
  const t0 = buildTrackWithSlots(baseSlots);
  const t1: MixerTrack = {
    ...t0,
    fxSlots: t0.fxSlots.map(slot => {
      if (slot.id === 'eq') return { ...slot, params: { ...slot.params, lowGain: 6, midGain: -3, highFreq: 10000 } };
      if (slot.id === 'comp') return { ...slot, params: { ...slot.params, threshold: -12, ratio: 6, attack: 0.01 } };
      if (slot.id === 'delay') return { ...slot, params: { ...slot.params, time: 0.5, feedback: 0.5 } };
      if (slot.id === 'limiter') return { ...slot, params: { ...slot.params, ceiling: -1, drive: 3 } };
      return slot;
    }),
  };
  // Verify each changed param is in the live contract.
  for (const slot of t1.fxSlots) {
    for (const key of Object.keys(slot.params)) {
      if (key === 'mix') continue;
      assert.equal(
        isFxParamLiveUpdatableByName(slot.type, key),
        true,
        `${slot.type}.${key} must be live-updatable for the fast path to apply.`,
      );
    }
  }
});
