/**
 * Phase 81 — the UI discovery surface for FX parameter automation and MIDI CC.
 *
 * The automation target picker and the MIDI Learn binder are both fed by
 * `fxParameterControl`'s option lists, so the set of parameters a user can pick
 * is exactly the set the FX contract says has a real AudioParam consumer. These
 * tests exercise that discovery layer as production code (it is what the
 * components render into `<option>` elements and what they publish when the user
 * picks one), plus a wiring check that the two components really do consume it
 * rather than carrying their own hardcoded parameter list.
 *
 * The components themselves are not statically rendered: `PlaylistArranger`'s
 * automation editor is opened by a pointer interaction on internal state and
 * this repo has no DOM test environment. That limitation is stated here rather
 * than papered over by asserting on markup that was never produced.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { FxSlot, FxType, MixerTrack, ProjectState } from '../types/daw';
import {
  formatFxParameterRange,
  listFxParameterOptions,
  listFxSlotOptions,
  resolveFxParameterUpdate,
  type FxParameterOption,
} from '../audio/fxParameterControl';
import { FX_PARAMETER_FAMILIES, resolveFxParameterSpec } from '../audio/fxParameterContract';
import {
  buildFxAutomationTarget,
  buildFxParamAutomationTarget,
  buildFxSlotAutomationTarget,
  fxAutomationSlotTargetId,
  listFxSlotParameterOptions,
} from './fxAutomationTargets';
import {
  FX_SLOT_PARAM_UI_TARGET,
  defaultFxSlotParameterSelection,
  isFxSlotParamUiTarget,
  normalizeMidiLearnTargetSelection,
} from './MidiLearnModal';
import { buildFxSlotParameterMapping, resolveMidiCcTarget } from '../audio/midiMappingRuntime';
import { createDefaultProjectState } from '../state/projectState';

const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const read = (relative: string): string => readFileSync(path.resolve(repoRoot, relative), 'utf8');

const makeSlot = (id: string, type: FxType, params: Record<string, number> = {}, mix = 0.8): FxSlot => ({
  id, type, name: `${type} ${id}`, enabled: true, mix, params,
});

const makeTrack = (id: number, fxSlots: FxSlot[], name = `Insert ${id}`): MixerTrack => ({
  id, name, color: '#ffffff', volume: 1, pan: 0, mute: false, solo: false, routingTargetId: 0, fxSlots,
} as MixerTrack);

/** One slot per contract family, so the picker surface covers the whole contract. */
const FAMILY_FIXTURE: Array<{ fxType: FxType; trackId: number; slotId: string }> = [
  { fxType: 'equalizer', trackId: 1, slotId: 'fx-eq' },
  { fxType: 'compressor', trackId: 2, slotId: 'fx-comp' },
  { fxType: 'delay', trackId: 3, slotId: 'fx-delay' },
  { fxType: 'limiter', trackId: 4, slotId: 'fx-lim' },
  { fxType: 'reverb', trackId: 5, slotId: 'fx-verb' },
  { fxType: 'distortion', trackId: 6, slotId: 'fx-dist' },
];

const familyTracks = (): MixerTrack[] =>
  FAMILY_FIXTURE.map(entry => makeTrack(entry.trackId, [makeSlot(entry.slotId, entry.fxType)]));

const composite = (trackId: number, slotId: string): string => `${trackId}/${slotId}`;

describe('Phase 81: the FX slot picker lists exactly the slots the project owns', () => {
  it('offers every slot with a composite, deterministic id and a track-qualified label', () => {
    const options = listFxSlotOptions(familyTracks());
    assert.equal(options.length, FAMILY_FIXTURE.length);
    for (const [index, entry] of FAMILY_FIXTURE.entries()) {
      const option = options[index]!;
      assert.equal(option.targetId, composite(entry.trackId, entry.slotId));
      assert.equal(option.trackId, entry.trackId);
      assert.equal(option.slotId, entry.slotId);
      assert.equal(option.fxType, entry.fxType);
      assert.equal(option.label, `Insert ${entry.trackId} · ${entry.fxType} ${entry.slotId}`);
    }
  });

  it('reports which slots own contract parameters, so fx_param never offers a dead end', () => {
    const byType = new Map(listFxSlotOptions(familyTracks()).map(option => [option.fxType, option.hasContractParams]));
    assert.equal(byType.get('equalizer'), true);
    assert.equal(byType.get('compressor'), true);
    assert.equal(byType.get('delay'), true);
    assert.equal(byType.get('limiter'), true);
    // Families whose parameters are baked into a curve own only the mix.
    assert.equal(byType.get('reverb'), false);
    assert.equal(byType.get('distortion'), false);
  });

  it('distinguishes two inserts that reuse the same slot id', () => {
    const tracks = [
      makeTrack(1, [makeSlot('fx', 'compressor', { threshold: -18 })]),
      makeTrack(2, [makeSlot('fx', 'delay', { time: 0.2 })]),
    ];
    const options = listFxSlotOptions(tracks);
    assert.deepEqual(options.map(option => option.targetId), ['1/fx', '2/fx']);
    assert.notEqual(options[0]!.label, options[1]!.label);
  });

  it('is empty (not crashing) for a project with no FX slot at all', () => {
    assert.deepEqual(listFxSlotOptions([]), []);
    assert.deepEqual(listFxSlotOptions(undefined), []);
    assert.deepEqual(listFxSlotOptions([makeTrack(0, [])]), []);
  });
});

describe('Phase 81: the parameter picker lists exactly the contract parameters', () => {
  it('offers every contract parameter of every family plus the mix, and nothing else', () => {
    const tracks = familyTracks();
    for (const entry of FAMILY_FIXTURE) {
      const options = listFxParameterOptions(tracks, { trackId: entry.trackId, slotId: entry.slotId });
      const family = FX_PARAMETER_FAMILIES[entry.fxType];
      const expectedIds = family ? [...family.parameters.map(spec => spec.id), 'mix'] : ['mix'];
      assert.deepEqual(
        options.map(option => option.paramId),
        expectedIds,
        `${entry.fxType} must offer its whole contract family and the mix`,
      );
      for (const option of options) {
        assert.equal(option.targetId, composite(entry.trackId, entry.slotId));
        assert.equal(option.fxType, entry.fxType);
        // Every offered option must be something the engine can actually apply.
        assert.equal(
          resolveFxParameterUpdate(tracks, option.targetId, option.paramId, 0.5).status,
          'resolved',
          `${entry.fxType}.${option.paramId} is offered but does not resolve`,
        );
      }
    }
  });

  it('excludes the mix from the fx_param list so a parameter is never offered twice', () => {
    const tracks = familyTracks();
    for (const entry of FAMILY_FIXTURE) {
      const withoutMix = listFxSlotParameterOptions(tracks, entry.trackId, entry.slotId);
      assert.equal(withoutMix.some(option => option.isMix), false, `${entry.fxType} fx_param list must not include the mix`);
      assert.equal(withoutMix.length + 1, listFxParameterOptions(tracks, { trackId: entry.trackId, slotId: entry.slotId }).length);
    }
  });

  it('never leaks options from another slot when a slot is selected', () => {
    const tracks = [
      makeTrack(1, [makeSlot('fx-a', 'compressor'), makeSlot('fx-b', 'delay')]),
      makeTrack(2, [makeSlot('fx-a', 'limiter')]),
    ];
    const scoped = listFxParameterOptions(tracks, { trackId: 1, slotId: 'fx-a' });
    assert.ok(scoped.length > 0);
    assert.deepEqual([...new Set(scoped.map(option => option.targetId))], ['1/fx-a']);

    const everyOption = listFxParameterOptions(tracks);
    assert.ok(everyOption.some(option => option.targetId === '2/fx-a'), 'an unfiltered list sees every track');
    // The trap this locks down: filtering by slot id alone still spans tracks.
    const bySlotOnly = listFxParameterOptions(tracks, { slotId: 'fx-a' });
    assert.deepEqual([...new Set(bySlotOnly.map(option => option.targetId))].sort(), ['1/fx-a', '2/fx-a']);
    assert.equal(listFxSlotParameterOptions(tracks, null, 'fx-a').length, 0, 'no track selected => no parameter options');
    assert.equal(listFxSlotParameterOptions(tracks, 1, '').length, 0, 'no slot selected => no parameter options');
  });

  it('labels each parameter with its real DSP range and unit', () => {
    const options = listFxParameterOptions(familyTracks(), { trackId: 2, slotId: 'fx-comp' });
    const threshold = options.find(option => option.paramId === 'threshold')!;
    assert.equal(threshold.min, -100);
    assert.equal(threshold.max, 0);
    assert.equal(formatFxParameterRange(threshold), '-100\u20130 dB');
    assert.equal(threshold.label, 'Insert 2 · compressor fx-comp · Threshold');

    const mix = options.find(option => option.isMix)!;
    assert.equal(formatFxParameterRange(mix), '0\u20131');

    const delayTime = listFxParameterOptions(familyTracks(), { trackId: 3, slotId: 'fx-delay' })
      .find(option => option.paramId === 'time')!;
    assert.equal(formatFxParameterRange(delayTime), '0\u201310 s');
    assert.equal(delayTime.paramLabel, 'Delay Time', 'the label is human text...');
    assert.equal(delayTime.paramId, 'time', '...but the id the document stores is the contract id `time`');

    const eqLowFreq = listFxParameterOptions(familyTracks(), { trackId: 1, slotId: 'fx-eq' })
      .find(option => option.paramId === 'lowFreq')!;
    assert.match(formatFxParameterRange(eqLowFreq), /Hz$/);
  });

  it('is empty for a slot that does not exist rather than falling back to another one', () => {
    const tracks = familyTracks();
    assert.deepEqual(listFxParameterOptions(tracks, { trackId: 2, slotId: 'fx-gone' }), []);
    assert.deepEqual(listFxParameterOptions(tracks, { trackId: 99, slotId: 'fx-comp' }), []);
  });
});

describe('Phase 81: the automation target builders publish resolvable targets', () => {
  it('builds a target for every contract parameter of every family', () => {
    const tracks = familyTracks();
    let built = 0;
    for (const entry of FAMILY_FIXTURE) {
      for (const option of listFxSlotParameterOptions(tracks, entry.trackId, entry.slotId)) {
        const draft = buildFxParamAutomationTarget(tracks, option.targetId, option.paramId);
        assert.ok(draft, `${entry.fxType}.${option.paramId} must be buildable`);
        assert.equal(draft!.type, 'fx_param');
        assert.equal(draft!.targetId, composite(entry.trackId, entry.slotId));
        assert.equal(draft!.paramName, option.paramId);
        assert.ok((draft!.label ?? '').includes(option.paramLabel), 'the label names the parameter');
        assert.equal(resolveFxParameterUpdate(tracks, draft!.targetId, draft!.paramName!, 1).status, 'resolved');
        built += 1;
      }
    }
    const contractParams = Object.values(FX_PARAMETER_FAMILIES)
      .reduce((total, family) => total + (family ? family.parameters.length : 0), 0);
    assert.ok(contractParams > 0);
    assert.equal(built, contractParams, 'every contract parameter must be selectable in the UI');
  });

  it('returns null instead of a plausible-looking target for anything unbindable', () => {
    const tracks = familyTracks();
    assert.equal(buildFxParamAutomationTarget(tracks, '2/fx-comp', 'notAParam'), null);
    assert.equal(buildFxParamAutomationTarget(tracks, '2/fx-gone', 'threshold'), null);
    assert.equal(buildFxParamAutomationTarget(tracks, '99/fx-comp', 'threshold'), null);
    assert.equal(buildFxParamAutomationTarget(tracks, 'fx-comp', 'threshold'), null, 'a bare id pins no track');
    assert.equal(buildFxParamAutomationTarget(tracks, '', 'threshold'), null);
    assert.equal(buildFxParamAutomationTarget(tracks, '2/fx-comp', ''), null);
    assert.equal(buildFxParamAutomationTarget(tracks, '5/fx-verb', 'mix'), null, 'the mix is the fx_mix target');
    assert.equal(buildFxParamAutomationTarget([], '2/fx-comp', 'threshold'), null);
    assert.equal(buildFxParamAutomationTarget(undefined, '2/fx-comp', 'threshold'), null);
  });

  it('picks a slot the target type can actually drive when the user selects the type', () => {
    // Insert 1 is a convolver reverb: it has a mix but no contract parameter.
    const tracks = [
      makeTrack(0, []),
      makeTrack(1, [makeSlot('fx-verb', 'reverb', {}, 0.5)]),
      makeTrack(2, [makeSlot('fx-comp', 'compressor', { threshold: -18 })]),
    ];
    const mix = buildFxAutomationTarget('fx_mix', tracks, null);
    assert.equal(mix.type, 'fx_mix');
    assert.equal(mix.targetId, 1, 'fx_mix keeps the legacy numeric track id');
    assert.equal(mix.paramName, 'fx-verb');
    // `fx_mix` keeps its own long-shipped engine branch: `targetId` is the
    // mixer track id and `paramName` is the slot id. Assert exactly that path.
    const mixTrack = tracks.find(track => track.id === Number(mix.targetId));
    assert.ok(mixTrack, 'the fx_mix target must name a track that exists');
    assert.ok(mixTrack!.fxSlots.some(slot => slot.id === mix.paramName), 'the fx_mix target must name a slot that exists');
    // The equivalent composite addressing of the same slot resolves to the mix.
    const mixResolution = resolveFxParameterUpdate(tracks, '1/fx-verb', 'mix', 0.5);
    assert.equal(mixResolution.status, 'resolved');
    if (mixResolution.status === 'resolved') {
      assert.equal(mixResolution.update.trackId, 1);
      assert.equal(mixResolution.update.slotId, 'fx-verb');
      assert.equal(mixResolution.update.isMix, true);
    }

    const param = buildFxAutomationTarget('fx_param', tracks, null);
    assert.equal(param.type, 'fx_param');
    assert.equal(param.targetId, '2/fx-comp', 'fx_param must not land on a parameterless slot');
    assert.equal(param.paramName, 'threshold');
    assert.equal(resolveFxParameterUpdate(tracks, param.targetId, param.paramName!, 0.5).status, 'resolved');
  });

  it('reports an honest empty state when the slot has no contract parameter', () => {
    const tracks = [makeTrack(0, []), makeTrack(1, [makeSlot('fx-verb', 'reverb', {}, 0.5)])];
    const draft = buildFxAutomationTarget('fx_param', tracks, null);
    assert.equal(draft.targetId, '1/fx-verb');
    assert.equal(draft.paramName, '', 'no invented parameter');
    assert.match(draft.label ?? '', /no automatable parameter/);
    assert.equal(resolveFxParameterUpdate(tracks, draft.targetId, draft.paramName, 1).status, 'rejected');
    // The user can still automate its mix through the other target type.
    const mix = buildFxAutomationTarget('fx_mix', tracks, null);
    assert.equal(mix.paramName, 'fx-verb');
    assert.ok(!/no automatable/.test(mix.label ?? ''));
    assert.ok(tracks.find(track => track.id === Number(mix.targetId))!.fxSlots.some(slot => slot.id === mix.paramName));
  });

  it('reports an honest empty state when the project has no FX slot', () => {
    const tracks = [makeTrack(0, [])];
    const param = buildFxAutomationTarget('fx_param', tracks, null);
    assert.equal(param.targetId, '');
    assert.equal(param.paramName, '');
    assert.match(param.label ?? '', /no effect slot/);
    assert.equal(resolveFxParameterUpdate(tracks, param.targetId, param.paramName, 1).status, 'rejected');

    const mix = buildFxAutomationTarget('fx_mix', tracks, null);
    assert.equal(mix.targetId, 0);
    assert.equal(mix.paramName, '');
    assert.match(mix.label ?? '', /no effect slot/);
  });

  it('keeps the parameter selection when the user switches slot and the family supports it', () => {
    const tracks = [
      makeTrack(0, []),
      makeTrack(1, [makeSlot('fx-a', 'compressor', { threshold: -18 })]),
      makeTrack(2, [makeSlot('fx-b', 'compressor', { threshold: -30 })]),
    ];
    const moved = buildFxSlotAutomationTarget('fx_param', tracks, '2/fx-b', {
      type: 'fx_param', targetId: '1/fx-a', paramName: 'threshold',
    });
    assert.equal(moved.targetId, '2/fx-b');
    assert.equal(moved.paramName, 'threshold');

    const across = buildFxSlotAutomationTarget('fx_param', tracks, '2/fx-b', {
      type: 'fx_param', targetId: '1/fx-a', paramName: 'release',
    });
    assert.equal(across.paramName, 'release', 'a compressor parameter survives a move to another compressor');
  });

  it('falls back to the slot\'s first parameter when the carried selection does not exist', () => {
    const tracks = [
      makeTrack(0, []),
      makeTrack(1, [makeSlot('fx-a', 'compressor', { threshold: -18 })]),
      makeTrack(2, [makeSlot('fx-b', 'delay', { time: 0.2 })]),
    ];
    const moved = buildFxSlotAutomationTarget('fx_param', tracks, '2/fx-b', {
      type: 'fx_param', targetId: '1/fx-a', paramName: 'threshold',
    });
    assert.equal(moved.targetId, '2/fx-b');
    assert.equal(moved.paramName, 'time', 'a delay has no threshold; the picker offers its own first parameter');
    assert.equal(resolveFxParameterUpdate(tracks, moved.targetId, moved.paramName!, 0.5).status, 'resolved');
  });

  it('returns the empty target when the picked slot has since disappeared', () => {
    const tracks = familyTracks();
    assert.deepEqual(buildFxSlotAutomationTarget('fx_param', tracks, '2/fx-gone', null), {
      type: 'fx_param', targetId: '', paramName: '', label: 'FX Parameter (no effect slot)',
    });
    assert.deepEqual(buildFxSlotAutomationTarget('fx_mix', tracks, 'not-a-slot', null), {
      type: 'fx_mix', targetId: 0, paramName: '', label: 'FX Wet/Dry (no effect slot)',
    });
  });

  it('normalizes both FX target types onto one composite id for the slot select', () => {
    assert.equal(fxAutomationSlotTargetId({ type: 'fx_param', targetId: '2/fx-comp', paramName: 'threshold' }), '2/fx-comp');
    assert.equal(fxAutomationSlotTargetId({ type: 'fx_mix', targetId: 2, paramName: 'fx-comp' }), '2/fx-comp');
    assert.equal(fxAutomationSlotTargetId({ type: 'fx_mix', targetId: '2', paramName: 'fx-comp' }), '2/fx-comp');
    // Anything that does not pin a slot collapses to '' so the select shows its
    // placeholder instead of silently pointing at another insert.
    assert.equal(fxAutomationSlotTargetId({ type: 'fx_param', targetId: 'fx-comp', paramName: 'threshold' }), '');
    assert.equal(fxAutomationSlotTargetId({ type: 'fx_param', targetId: 'x/fx-comp', paramName: 'threshold' }), '');
    assert.equal(fxAutomationSlotTargetId({ type: 'fx_mix', targetId: 2, paramName: '' }), '');
    assert.equal(fxAutomationSlotTargetId({ type: 'fx_mix', targetId: Number.NaN, paramName: 'fx-comp' }), '');
    assert.equal(fxAutomationSlotTargetId({ type: 'master_vol', targetId: 0 }), '');
    assert.equal(fxAutomationSlotTargetId(null), '');
    assert.equal(fxAutomationSlotTargetId(undefined), '');
  });
});

describe('Phase 81: the MIDI Learn binder offers the same surface and binds it', () => {
  it('seeds the form on the first bindable slot parameter, never on an unbindable one', () => {
    const tracks = familyTracks();
    const seed = defaultFxSlotParameterSelection(tracks);
    assert.ok(seed);
    assert.equal(seed!.slotTargetId, '1/fx-eq');
    assert.ok(listFxSlotParameterOptions(tracks, 1, 'fx-eq').some(option => option.paramId === seed!.paramId));

    // A project whose only slot is a convolver reverb can still bind the mix,
    // which is a real, long-shipped fx_param target, so the form seeds on it
    // rather than on nothing.
    const reverbOnly = defaultFxSlotParameterSelection([makeTrack(1, [makeSlot('fx-verb', 'reverb')])]);
    assert.deepEqual(reverbOnly, { slotTargetId: '1/fx-verb', paramId: 'mix' });
    assert.ok(buildFxSlotParameterMapping(21, [makeTrack(1, [makeSlot('fx-verb', 'reverb')])], reverbOnly!.slotTargetId, reverbOnly!.paramId));
    assert.equal(defaultFxSlotParameterSelection([]), null);
    assert.equal(defaultFxSlotParameterSelection([makeTrack(1, [])]), null);
  });

  it('keeps the UI-local FX mode distinct from the legacy channel fx_param mode', () => {
    assert.equal(FX_SLOT_PARAM_UI_TARGET, 'fx_slot_param');
    assert.equal(isFxSlotParamUiTarget(FX_SLOT_PARAM_UI_TARGET), true);
    assert.equal(isFxSlotParamUiTarget('fx_param'), false, 'the legacy channel mode is a different thing');
    assert.equal(isFxSlotParamUiTarget('master_vol'), false);

    // The legacy `fx_param` UI mode still means the channel synth filter cutoff.
    const legacy = normalizeMidiLearnTargetSelection('fx_param', 'ch-1', [{ id: 'ch-1' } as never], familyTracks());
    assert.equal(legacy.targetId, 'ch-1');
    assert.equal(legacy.paramName, 'filterCutoff');
  });

  it('binds every contract parameter to a mapping the runtime resolves and labels', () => {
    const tracks = familyTracks();
    const state: ProjectState = { ...createDefaultProjectState(), mixerTracks: tracks };
    for (const entry of FAMILY_FIXTURE) {
      for (const option of listFxSlotParameterOptions(tracks, entry.trackId, entry.slotId)) {
        const mapping = buildFxSlotParameterMapping(21, tracks, option.targetId, option.paramId);
        assert.ok(mapping, `${entry.fxType}.${option.paramId} must be bindable`);
        assert.equal(mapping!.targetType, 'fx_param');
        assert.equal(mapping!.targetId, composite(entry.trackId, entry.slotId));
        assert.equal(mapping!.paramName, option.paramId);
        assert.equal(mapping!.ccNumber, 21);

        const resolution = resolveMidiCcTarget(mapping!, state, 1);
        assert.equal(resolution.status, 'supported', `${entry.fxType}.${option.paramId} must resolve`);
        assert.equal(resolution.parameter, `fx_param.${option.paramId}`);
        assert.equal(resolution.value, option.max, 'full-scale CC reaches the contract maximum');
        assert.ok(
          resolution.label.startsWith('MIDI CC 21: '),
          `the history/status label must name the CC, got "${resolution.label}"`,
        );
        assert.ok(
          resolution.label.includes(option.paramLabel),
          `the label must name the parameter, got "${resolution.label}"`,
        );
        assert.equal(resolveFxParameterSpec(entry.fxType, option.paramId)?.label, option.paramLabel);
      }
    }
  });

  it('refuses to bind a mix parameter through the fx_param contract path', () => {
    const tracks = familyTracks();
    // `buildFxSlotParameterMapping` accepts the mix because `fx_param.mix` is a
    // real, long-shipped target; it rejects anything the contract does not own.
    assert.equal(buildFxSlotParameterMapping(21, tracks, '2/fx-comp', 'mix')?.paramName, 'mix');
    assert.equal(buildFxSlotParameterMapping(21, tracks, '2/fx-comp', 'notAParam'), null);
    assert.equal(buildFxSlotParameterMapping(21, tracks, '2/fx-gone', 'threshold'), null);
    assert.equal(buildFxSlotParameterMapping(21, tracks, 'fx-comp', 'threshold'), null);
    assert.equal(buildFxSlotParameterMapping(21, tracks, '2/fx-comp', ''), null);
  });

  it('two mappings to different FX parameters stay distinguishable', () => {
    const tracks = familyTracks();
    const state: ProjectState = { ...createDefaultProjectState(), mixerTracks: tracks };
    const first = buildFxSlotParameterMapping(21, tracks, '2/fx-comp', 'threshold')!;
    const second = buildFxSlotParameterMapping(22, tracks, '3/fx-delay', 'time')!;
    assert.notEqual(first.targetId, second.targetId);
    assert.notEqual(first.paramName, second.paramName);
    const firstResolution = resolveMidiCcTarget(first, state, 1);
    const secondResolution = resolveMidiCcTarget(second, state, 1);
    assert.equal(firstResolution.status, 'supported');
    assert.equal(secondResolution.status, 'supported');
    if (firstResolution.status !== 'supported' || secondResolution.status !== 'supported') return;
    assert.notEqual(firstResolution.parameter, secondResolution.parameter);
    assert.notEqual(firstResolution.label, secondResolution.label);
    assert.equal(firstResolution.parameter, 'fx_param.threshold');
    assert.equal(secondResolution.parameter, 'fx_param.time');
    assert.equal(firstResolution.value, 0, 'compressor threshold full scale is 0 dBFS');
    assert.equal(secondResolution.value, 10, 'delay time full scale is 10 s');
  });
});

describe('Phase 81: the pickers render the contract list, not a hardcoded one', () => {
  it('PlaylistArranger builds its FX options from the contract helpers', () => {
    const source = read('src/components/PlaylistArranger.tsx');
    for (const helper of [
      'buildFxAutomationTarget',
      'buildFxSlotAutomationTarget',
      'buildFxParamAutomationTarget',
      'listFxSlotParameterOptions',
      'fxAutomationSlotTargetId',
    ]) {
      assert.ok(source.includes(helper), `PlaylistArranger must consume ${helper}`);
    }
    assert.ok(source.includes('listFxSlotOptions(mixerTracks)'), 'the slot list must come from fxParameterControl');
    assert.ok(source.includes('formatFxParameterRange(option)'), 'the parameter label must show the real DSP range');
    assert.ok(source.includes('<option value="fx_param">FX Slot Parameter</option>'), 'the target type must be selectable');
    assert.ok(source.includes('<option value="fx_mix">FX Slot Wet/Dry Mix</option>'), 'the mix target must stay selectable');
    // The whole point of the shared layer: no parameter list is duplicated in JSX.
    for (const forbidden of ['value="threshold"', 'value="ratio"', 'value="delayTime"', 'value="ceiling"', 'value="lowFreq"']) {
      assert.equal(source.includes(forbidden), false, `PlaylistArranger must not hardcode ${forbidden}`);
    }
    // A stale target must be visible, not silently retargeted.
    assert.ok(source.includes('missing FX slot'), 'a deleted slot must be reported in the picker');
    assert.ok(source.includes('no automatable parameter'), 'a parameterless slot must be reported in the picker');
  });

  it('MidiLearnModal builds its FX options from the contract helpers', () => {
    const source = read('src/components/MidiLearnModal.tsx');
    assert.ok(source.includes('listFxSlotOptions(mixerTracks)'), 'the slot list must come from fxParameterControl');
    assert.ok(source.includes('listFxParameterOptions(mixerTracks)'), 'the parameter list must come from fxParameterControl');
    assert.ok(
      source.includes('filter(option => option.targetId === fxSlotTargetId)'),
      'the parameter list must be scoped to the selected slot',
    );
    assert.ok(source.includes('<option value={FX_SLOT_PARAM_UI_TARGET}>FX Slot Parameter</option>'));
    assert.ok(source.includes('buildFxSlotParameterMapping'), 'binding must go through the shared mapper');
    assert.ok(source.includes('defaultFxSlotParameterSelection(mixerTracks)'), 'the form must seed on a bindable parameter');
    for (const forbidden of ['value="threshold"', 'value="ratio"', 'value="ceiling"', 'value="lowFreq"']) {
      assert.equal(source.includes(forbidden), false, `MidiLearnModal must not hardcode ${forbidden}`);
    }
  });

  it('every parameter the pickers can offer is applied by the engine', () => {
    const tracks = familyTracks();
    const offered = new Set<string>();
    for (const option of listFxParameterOptions(tracks)) {
      offered.add(`${option.fxType}.${option.paramId}`);
    }
    for (const [fxType, family] of Object.entries(FX_PARAMETER_FAMILIES)) {
      if (!family) continue;
      for (const spec of family.parameters) {
        assert.ok(offered.has(`${fxType}.${spec.id}`), `${fxType}.${spec.id} is in the contract but not offered`);
      }
      assert.ok(offered.has(`${fxType}.mix`), `${fxType}.mix must be offered`);
    }
    const offeredOptions: FxParameterOption[] = listFxParameterOptions(tracks);
    assert.equal(offeredOptions.length, offered.size, 'no duplicate offers');
  });
});
