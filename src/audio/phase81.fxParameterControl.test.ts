/**
 * Phase 81 — shared FX parameter control semantics.
 *
 * These tests exercise the *production* resolver that both the `fx_param`
 * automation target (`audioEngine.applyAutomationValue`) and the MIDI CC bridge
 * (`midiMappingRuntime.resolveFxParamTarget`) call, so the range conversion and
 * the stale-target rules are proven once for both paths.
 *
 * Covered:
 *   1. every contract parameter of every family — plus the per-slot wet/dry
 *      mix — is representable as an FX parameter target and resolves,
 *   2. each target resolves to the intended track, slot and parameter,
 *   3. normalized values convert across each parameter's *real* range
 *      (compressor threshold -100..0 dB, EQ 20..20000 Hz, limiter drive
 *      -12..24 dB, …), not an assumed 0..1,
 *   4. min / max / default / out-of-range / non-finite / unknown values,
 *   5. missing tracks, deleted slots and moved slots fail safe and can never
 *      redirect a target onto a different insert,
 *   6. the legacy bare-slot-id form keeps resolving (existing documents and
 *      the shipped `fx-5-verb` + `mix` preset mapping).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FxSlot, FxType, MixerTrack } from '../types/daw';
import {
  FX_PARAMETER_FAMILIES,
  SLOT_MIX_PARAMETER,
  fxParamValueFromNormalized,
  fxParamValueToNormalized,
  listFxParameterSpecs,
  resolveFxParameterSpec,
} from './fxParameterContract';
import {
  FX_TARGET_ID_SEPARATOR,
  describeFxParameterUpdate,
  formatFxParameterRange,
  formatFxSlotTargetId,
  fxSlotParamToNormalized,
  fxTargetIdBelongsToTrack,
  listFxParameterOptions,
  listFxSlotOptions,
  parseFxSlotTargetId,
  resolveFxParameterUpdate,
  resolveFxSlot,
} from './fxParameterControl';

const makeSlot = (id: string, type: FxType, params: Record<string, number> = {}, mix = 0.8): FxSlot => ({
  id,
  type,
  name: `${type} ${id}`,
  enabled: true,
  mix,
  params,
});

const makeTrack = (id: number, fxSlots: FxSlot[], name = `Insert ${id}`): MixerTrack => ({
  id,
  name,
  color: '#ffffff',
  volume: 1,
  pan: 0,
  mute: false,
  solo: false,
  fxSlots,
} as MixerTrack);

/** One track per implemented family, each carrying a single slot. */
const fixtureTracks = (): MixerTrack[] => [
  makeTrack(1, [makeSlot('fx-eq', 'equalizer', { lowFreq: 120, lowQ: 0.9 })]),
  makeTrack(2, [makeSlot('fx-comp', 'compressor', { threshold: -18, ratio: 4 })]),
  makeTrack(3, [makeSlot('fx-delay', 'delay', { time: 0.35, feedback: 0.45 })]),
  makeTrack(4, [makeSlot('fx-lim', 'limiter', { ceiling: -0.3 })]),
  makeTrack(5, [makeSlot('fx-verb', 'reverb')]),
  makeTrack(6, [makeSlot('fx-dist', 'distortion', { drive: 20 })]),
];

const closeTo = (actual: number, expected: number, message?: string): void => {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9,
    message ?? `expected ${actual} to be within 1e-9 of ${expected}`,
  );
};

/** Every (fxType, paramId) pair the contract owns, including the slot mix. */
const allContractParams = (): Array<{ fxType: FxType; paramId: string }> => {
  const pairs: Array<{ fxType: FxType; paramId: string }> = [];
  for (const [fxType, family] of Object.entries(FX_PARAMETER_FAMILIES)) {
    if (!family) continue;
    for (const spec of family.parameters) pairs.push({ fxType: fxType as FxType, paramId: spec.id });
  }
  return pairs;
};

describe('Phase 81: contract normalized-value conversion', () => {
  it('resolves a spec for every family parameter and for the per-slot mix', () => {
    for (const { fxType, paramId } of allContractParams()) {
      assert.ok(resolveFxParameterSpec(fxType, paramId), `${fxType}.${paramId} must resolve to a spec`);
    }
    // `mix` is not a family parameter but every slot has it.
    for (const fxType of Object.keys(FX_PARAMETER_FAMILIES) as FxType[]) {
      assert.equal(resolveFxParameterSpec(fxType, 'mix'), SLOT_MIX_PARAMETER);
      assert.equal(resolveFxParameterSpec(fxType, 'mix')?.id, SLOT_MIX_PARAMETER.id);
    }
    // A param the contract does not own resolves to nothing.
    assert.equal(resolveFxParameterSpec('compressor', 'notARealParam'), null);
    assert.equal(resolveFxParameterSpec('distortion', 'drive'), null, 'curve-baked families own no contract param');
  });

  it('maps normalized 0 / 0.5 / 1 onto each parameter\'s real range, not an assumed 0..1', () => {
    for (const { fxType, paramId } of allContractParams()) {
      const spec = resolveFxParameterSpec(fxType, paramId)!;
      closeTo(fxParamValueFromNormalized(fxType, paramId, 0)!, spec.min, `${fxType}.${paramId} at 0`);
      closeTo(fxParamValueFromNormalized(fxType, paramId, 1)!, spec.max, `${fxType}.${paramId} at 1`);
      closeTo(
        fxParamValueFromNormalized(fxType, paramId, 0.5)!,
        spec.min + (spec.max - spec.min) / 2,
        `${fxType}.${paramId} at 0.5`,
      );
      // Ranges that are not 0..1 prove the conversion is not an identity.
      if (spec.min !== 0 || spec.max !== 1) {
        assert.notEqual(
          fxParamValueFromNormalized(fxType, paramId, 0.5),
          0.5,
          `${fxType}.${paramId} must not pass the normalized value through unchanged`,
        );
      }
    }
  });

  it('covers the concrete Phase 80 ranges the DSP enforces', () => {
    closeTo(fxParamValueFromNormalized('compressor', 'threshold', 0)!, -100);
    closeTo(fxParamValueFromNormalized('compressor', 'threshold', 1)!, 0);
    closeTo(fxParamValueFromNormalized('compressor', 'threshold', 0.5)!, -50);
    closeTo(fxParamValueFromNormalized('compressor', 'ratio', 1)!, 20);
    closeTo(fxParamValueFromNormalized('equalizer', 'lowFreq', 1)!, 20000);
    closeTo(fxParamValueFromNormalized('equalizer', 'lowGain', 0)!, -18);
    closeTo(fxParamValueFromNormalized('delay', 'time', 1)!, 10);
    // The contract's feedback ceiling stays strictly below the DelayEffect's
    // hard `< 0.99` bound, so full-scale automation can never throw.
    closeTo(fxParamValueFromNormalized('delay', 'feedback', 1)!, 0.989);
    closeTo(fxParamValueFromNormalized('limiter', 'drive', 1)!, 24);
    closeTo(fxParamValueFromNormalized('limiter', 'ceiling', 0)!, -12);
    closeTo(fxParamValueFromNormalized('equalizer', 'mix', 0.25)!, 0.25);
  });

  it('clamps out-of-range normalized values and falls back to the default for non-finite ones', () => {
    closeTo(fxParamValueFromNormalized('compressor', 'threshold', -3)!, -100);
    closeTo(fxParamValueFromNormalized('compressor', 'threshold', 7)!, 0);
    closeTo(fxParamValueFromNormalized('compressor', 'threshold', Number.NaN)!, -18, 'NaN -> contract default');
    closeTo(fxParamValueFromNormalized('compressor', 'threshold', Number.POSITIVE_INFINITY)!, -18);
    closeTo(fxParamValueFromNormalized('equalizer', 'midFreq', Number.NEGATIVE_INFINITY)!, 1200);
    assert.equal(fxParamValueFromNormalized('compressor', 'notARealParam', 0.5), null);
  });

  it('round-trips a contract value through the normalized domain', () => {
    for (const { fxType, paramId } of allContractParams()) {
      const spec = resolveFxParameterSpec(fxType, paramId)!;
      const normalized = fxParamValueToNormalized(fxType, paramId, spec.default)!;
      closeTo(fxParamValueFromNormalized(fxType, paramId, normalized)!, spec.default, `${fxType}.${paramId} round trip`);
    }
    closeTo(fxParamValueToNormalized('compressor', 'threshold', -50)!, 0.5);
    closeTo(fxParamValueToNormalized('compressor', 'threshold', -500)!, 0, 'below-range values clamp to 0');
    closeTo(fxParamValueToNormalized('compressor', 'threshold', 50)!, 1, 'above-range values clamp to 1');
    assert.equal(fxParamValueToNormalized('compressor', 'threshold', Number.NaN), null);
    assert.equal(fxParamValueToNormalized('compressor', 'notARealParam', 1), null);
  });

  it('lists the mix last for every family, including the curve-baked ones', () => {
    for (const fxType of Object.keys(FX_PARAMETER_FAMILIES) as FxType[]) {
      const specs = listFxParameterSpecs(fxType);
      assert.equal(specs[specs.length - 1]?.id, 'mix', `${fxType} must expose the slot mix`);
      const family = FX_PARAMETER_FAMILIES[fxType];
      assert.equal(specs.length, (family?.parameters.length ?? 0) + 1);
    }
    assert.equal(listFxParameterSpecs('equalizer').length, 10);
    assert.equal(listFxParameterSpecs('compressor').length, 6);
    assert.equal(listFxParameterSpecs('delay').length, 3);
    assert.equal(listFxParameterSpecs('limiter').length, 4);
    assert.equal(listFxParameterSpecs('reverb').length, 1, 'convolver reverb owns only the wet/dry mix');
    assert.equal(listFxParameterSpecs('distortion').length, 1);
  });
});

describe('Phase 81: FX target id addressing', () => {
  it('round-trips the composite "<trackId>/<slotId>" form', () => {
    const id = formatFxSlotTargetId(3, 'fx-delay');
    assert.equal(id, `3${FX_TARGET_ID_SEPARATOR}fx-delay`);
    assert.deepEqual(parseFxSlotTargetId(id), { trackId: 3, slotId: 'fx-delay' });
  });

  it('treats a bare id as "no track pinned" so the legacy form keeps working', () => {
    assert.deepEqual(parseFxSlotTargetId('fx-5-verb'), { trackId: null, slotId: 'fx-5-verb' });
    assert.deepEqual(parseFxSlotTargetId(7), { trackId: null, slotId: '7' });
    assert.deepEqual(parseFxSlotTargetId(''), { trackId: null, slotId: '' });
    assert.deepEqual(parseFxSlotTargetId('/orphan'), { trackId: null, slotId: '/orphan' });
    assert.deepEqual(parseFxSlotTargetId('not-a-number/fx'), { trackId: null, slotId: 'not-a-number/fx' });
  });

  it('attributes a composite id to its track and never to a bare numeric id', () => {
    assert.equal(fxTargetIdBelongsToTrack('3/fx-delay', 3), true);
    assert.equal(fxTargetIdBelongsToTrack('3/fx-delay', 4), false);
    assert.equal(fxTargetIdBelongsToTrack('fx-5-verb', 5), false, 'a bare id pins no track');
    assert.equal(fxTargetIdBelongsToTrack(5, 5), false, 'legacy numeric ids are not fx_param ids');
  });
});

describe('Phase 81: slot resolution', () => {
  const tracks = fixtureTracks();

  it('resolves a composite id strictly to the named track and slot', () => {
    const resolved = resolveFxSlot(tracks, '2/fx-comp');
    assert.equal(resolved.status, 'resolved');
    if (resolved.status !== 'resolved') return;
    assert.equal(resolved.track.id, 2);
    assert.equal(resolved.slot.id, 'fx-comp');
    assert.equal(resolved.slot.type, 'compressor');
  });

  it('resolves a legacy bare slot id by searching the tracks in order', () => {
    const resolved = resolveFxSlot(tracks, 'fx-verb');
    assert.equal(resolved.status, 'resolved');
    if (resolved.status !== 'resolved') return;
    assert.equal(resolved.track.id, 5);
    assert.equal(resolved.slot.id, 'fx-verb');
  });

  it('reports a reason instead of guessing for missing tracks, deleted slots and malformed ids', () => {
    for (const targetId of ['99/fx-comp', '2/fx-gone', '', 'fx-gone', 'x/y']) {
      const resolved = resolveFxSlot(tracks, targetId);
      assert.equal(resolved.status, 'unresolved', `${targetId} must not resolve`);
      if (resolved.status === 'unresolved') {
        assert.ok(resolved.reason.length > 0, `${targetId} must carry a reason`);
      }
    }
    assert.equal(resolveFxSlot(undefined, '1/fx-eq').status, 'unresolved');
    assert.equal(resolveFxSlot([], '1/fx-eq').status, 'unresolved');
  });

  it('never redirects a composite id onto a same-id slot on a different track', () => {
    // Track 2 owns "shared"; track 4 later grows a slot with the same id.
    const reordered = [
      makeTrack(2, [makeSlot('shared', 'compressor', { threshold: -18 })]),
      makeTrack(4, [makeSlot('shared', 'limiter', { ceiling: -0.3 })]),
    ];
    const resolved = resolveFxSlot(reordered, '2/shared');
    assert.equal(resolved.status, 'resolved');
    if (resolved.status !== 'resolved') return;
    assert.equal(resolved.track.id, 2);
    assert.equal(resolved.slot.type, 'compressor', 'the pinned track decides, not the first id match');

    // Deleting the pinned slot must fail safe rather than fall through to track 4.
    const afterDelete = [makeTrack(4, [makeSlot('shared', 'limiter', { ceiling: -0.3 })])];
    assert.equal(resolveFxSlot(afterDelete, '2/shared').status, 'unresolved');
  });
});

describe('Phase 81: shared FX parameter update resolution', () => {
  const tracks = fixtureTracks();

  it('resolves every contract parameter of every family to the intended track/slot/param', () => {
    const byType = new Map<FxType, { trackId: number; slotId: string }>([
      ['equalizer', { trackId: 1, slotId: 'fx-eq' }],
      ['compressor', { trackId: 2, slotId: 'fx-comp' }],
      ['delay', { trackId: 3, slotId: 'fx-delay' }],
      ['limiter', { trackId: 4, slotId: 'fx-lim' }],
    ]);

    let checked = 0;
    for (const { fxType, paramId } of allContractParams()) {
      const where = byType.get(fxType);
      if (!where) continue;
      const spec = resolveFxParameterSpec(fxType, paramId)!;
      const resolution = resolveFxParameterUpdate(
        tracks,
        formatFxSlotTargetId(where.trackId, where.slotId),
        paramId,
        0.75,
      );
      assert.equal(resolution.status, 'resolved', `${fxType}.${paramId} must resolve`);
      if (resolution.status !== 'resolved') continue;
      checked += 1;
      assert.equal(resolution.update.trackId, where.trackId);
      assert.equal(resolution.update.slotId, where.slotId);
      assert.equal(resolution.update.paramId, paramId);
      assert.equal(resolution.update.fxType, fxType);
      assert.equal(resolution.update.isMix, false);
      closeTo(
        resolution.update.value,
        spec.min + 0.75 * (spec.max - spec.min),
        `${fxType}.${paramId} converts 0.75 across its real range`,
      );
    }
    assert.equal(checked, allContractParams().length, 'every contract parameter must be automatable');
  });

  it('resolves the per-slot wet/dry mix for every family, including the curve-baked ones', () => {
    for (const track of tracks) {
      const slot = track.fxSlots[0]!;
      const resolution = resolveFxParameterUpdate(tracks, formatFxSlotTargetId(track.id, slot.id), 'mix', 0.4);
      assert.equal(resolution.status, 'resolved', `${slot.type} mix must resolve`);
      if (resolution.status !== 'resolved') continue;
      assert.equal(resolution.update.isMix, true);
      closeTo(resolution.update.value, 0.4);
      assert.equal(resolution.update.spec, SLOT_MIX_PARAMETER);
    }
  });

  it('accepts the legacy bare-slot-id form for the mix, matching the shipped preset mapping', () => {
    const resolution = resolveFxParameterUpdate(tracks, 'fx-verb', 'mix', 0.5);
    assert.equal(resolution.status, 'resolved');
    if (resolution.status !== 'resolved') return;
    assert.equal(resolution.update.trackId, 5);
    assert.equal(resolution.update.slotId, 'fx-verb');
    closeTo(resolution.update.value, 0.5);
  });

  it('rejects a parameter the contract does not own instead of passing it through', () => {
    const cases: Array<[string, string]> = [
      ['1/fx-eq', 'notARealParam'],
      ['6/fx-dist', 'drive'],   // distortion bakes drive into a waveshaper curve
      ['5/fx-verb', 'decay'],   // the convolver reverb owns no decay AudioParam
      ['3/fx-delay', 'delayTime'], // the contract id is `time`; `delayTime` is the AudioParam name
    ];
    for (const [targetId, paramId] of cases) {
      const resolution = resolveFxParameterUpdate(tracks, targetId, paramId, 0.5);
      assert.equal(resolution.status, 'rejected', `${targetId} ${paramId} must be rejected`);
      if (resolution.status === 'rejected') assert.ok(resolution.reason.includes(paramId));
    }
  });

  it('rejects empty, missing and non-string parameter ids', () => {
    for (const paramId of ['', '   ', undefined, null, 42, {}]) {
      const resolution = resolveFxParameterUpdate(tracks, '2/fx-comp', paramId, 0.5);
      assert.equal(resolution.status, 'rejected', `paramName ${String(paramId)} must be rejected`);
    }
  });

  it('rejects stale references safely: deleted slot, deleted track, unknown slot id', () => {
    const afterSlotDelete = [makeTrack(2, [])];
    assert.equal(resolveFxParameterUpdate(afterSlotDelete, '2/fx-comp', 'threshold', 0.5).status, 'rejected');
    assert.equal(resolveFxParameterUpdate([], '2/fx-comp', 'threshold', 0.5).status, 'rejected');
    assert.equal(resolveFxParameterUpdate(tracks, '77/fx-comp', 'threshold', 0.5).status, 'rejected');
    assert.equal(resolveFxParameterUpdate(tracks, '2/fx-missing', 'threshold', 0.5).status, 'rejected');
  });

  it('clamps out-of-range normalized input and defaults non-finite input', () => {
    const high = resolveFxParameterUpdate(tracks, '2/fx-comp', 'threshold', 4);
    assert.equal(high.status, 'resolved');
    if (high.status === 'resolved') closeTo(high.update.value, 0, 'above full scale saturates at the contract max');

    const low = resolveFxParameterUpdate(tracks, '2/fx-comp', 'threshold', -4);
    assert.equal(low.status, 'resolved');
    if (low.status === 'resolved') closeTo(low.update.value, -100);

    const nan = resolveFxParameterUpdate(tracks, '2/fx-comp', 'threshold', Number.NaN);
    assert.equal(nan.status, 'resolved');
    if (nan.status === 'resolved') {
      closeTo(nan.update.value, -18, 'non-finite input lands on the contract default, never NaN');
      closeTo(nan.update.normalized, 0);
    }
  });

  it('is deterministic: the same inputs always produce the same value', () => {
    const first = resolveFxParameterUpdate(tracks, '1/fx-eq', 'midFreq', 0.3);
    const second = resolveFxParameterUpdate(tracks, '1/fx-eq', 'midFreq', 0.3);
    assert.equal(first.status, 'resolved');
    assert.equal(second.status, 'resolved');
    if (first.status === 'resolved' && second.status === 'resolved') {
      assert.equal(first.update.value, second.update.value);
      assert.equal(describeFxParameterUpdate(first.update), describeFxParameterUpdate(second.update));
    }
  });

  it('never mutates the tracks it is given', () => {
    const snapshot = structuredClone(tracks);
    resolveFxParameterUpdate(tracks, '2/fx-comp', 'threshold', 0.9);
    resolveFxParameterUpdate(tracks, '1/fx-eq', 'mix', 0.1);
    assert.deepEqual(tracks, snapshot);
  });
});

describe('Phase 81: current-value normalization', () => {
  it('reads a stored slot value as its normalized control value', () => {
    const slot = makeSlot('fx-comp', 'compressor', { threshold: -50, ratio: 4 });
    closeTo(fxSlotParamToNormalized(slot, 'threshold'), 0.5);
    closeTo(fxSlotParamToNormalized(slot, 'mix'), 0.8, 'mix comes from slot.mix, not slot.params');
  });

  it('falls back to the contract default for a parameter the slot never stored', () => {
    const slot = makeSlot('fx-comp', 'compressor', {});
    closeTo(fxSlotParamToNormalized(slot, 'knee'), fxParamValueToNormalized('compressor', 'knee', 24)!);
    closeTo(fxSlotParamToNormalized(slot, 'notARealParam'), 0);
  });
});

describe('Phase 81: discovery for the automation picker and the MIDI binder', () => {
  const tracks = fixtureTracks();

  it('lists every slot with its composite target id', () => {
    const slots = listFxSlotOptions(tracks);
    assert.equal(slots.length, 6);
    assert.deepEqual(slots.map(slot => slot.targetId), [
      '1/fx-eq', '2/fx-comp', '3/fx-delay', '4/fx-lim', '5/fx-verb', '6/fx-dist',
    ]);
    assert.equal(slots.find(slot => slot.slotId === 'fx-eq')?.hasContractParams, true);
    assert.equal(slots.find(slot => slot.slotId === 'fx-verb')?.hasContractParams, false);
    assert.equal(slots.find(slot => slot.slotId === 'fx-dist')?.hasContractParams, false);
    assert.deepEqual(listFxSlotOptions(undefined), []);
  });

  it('lists every automatable parameter with its contract range and unit', () => {
    const options = listFxParameterOptions(tracks);
    // 9 EQ + 5 compressor + 2 delay + 3 limiter + 6 mixes (one per slot).
    assert.equal(options.length, 9 + 5 + 2 + 3 + 6);
    const threshold = options.find(option => option.paramId === 'threshold');
    assert.ok(threshold);
    assert.equal(threshold!.targetId, '2/fx-comp');
    assert.equal(threshold!.min, -100);
    assert.equal(threshold!.max, 0);
    assert.equal(threshold!.unit, 'dB');
    assert.equal(threshold!.isMix, false);
    assert.equal(formatFxParameterRange(threshold!), '-100\u20130 dB');
    assert.ok(options.some(option => option.paramId === 'mix' && option.isMix));
  });

  it('narrows by track and slot, and can exclude the mix', () => {
    assert.equal(listFxParameterOptions(tracks, { trackId: 3 }).length, 3);
    assert.equal(listFxParameterOptions(tracks, { trackId: 3, slotId: 'fx-delay' }).length, 3);
    assert.equal(listFxParameterOptions(tracks, { trackId: 3, includeMix: false }).length, 2);
    assert.deepEqual(listFxParameterOptions(tracks, { trackId: 99 }), []);
    assert.deepEqual(listFxParameterOptions(tracks, { slotId: 'fx-gone' }), []);
  });

  it('offers no parameter for a family whose DSP bakes its values', () => {
    const distortion = listFxParameterOptions(tracks, { trackId: 6, includeMix: false });
    assert.deepEqual(distortion, [], 'a curve-baked family has nothing honest to automate but its mix');
    const reverb = listFxParameterOptions(tracks, { trackId: 5 });
    assert.equal(reverb.length, 1);
    assert.equal(reverb[0]!.paramId, 'mix');
  });
});
