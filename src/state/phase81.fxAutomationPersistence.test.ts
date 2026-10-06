/**
 * Phase 81 — persistence and lifecycle coverage for FX parameter automation and
 * FX MIDI CC mappings.
 *
 * The FX targets introduced in this phase live entirely inside existing
 * persisted collections (`playlistClips[].automationTarget` and
 * `midiMappings`), so they inherit the project's save/load, history and
 * replacement machinery. These tests prove that inheritance actually holds for
 * the new addressing — a composite `"<trackId>/<slotId>"` target id, a contract
 * `paramName`, and a CC mapping that names both — and that a target whose slot
 * or track is gone degrades to a safe no-op instead of being silently retargeted
 * or resurrected.
 *
 * Everything runs through the real production functions: `serializeProjectState`
 * / `normalizeProjectState`, `createHistory`, `updateFxSlotInProjectState`,
 * `deleteFxSlotFromProjectState`, `updatePlaylistAutomationTarget` and
 * `fxParameterControl.resolveFxParameterUpdate`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FxSlot, MixerTrack, PlaylistClip, ProjectState } from '../types/daw';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { serializeProjectState } from './projectPersistence';
import { createHistory, sanitizeProjectSnapshot } from './projectHistory';
import {
  addFxSlotToProjectState,
  deleteFxSlotFromProjectState,
  updateFxSlotInProjectState,
} from './projectMutations';
import { updatePlaylistAutomationTarget } from '../components/playlistClipOperations';
import { buildFxSlotParameterMapping } from '../audio/midiMappingRuntime';
import { formatFxSlotTargetId, resolveFxParameterUpdate, resolveFxSlot } from '../audio/fxParameterControl';
import { buildFxAutomationTarget, buildFxParamAutomationTarget, buildFxSlotAutomationTarget } from '../components/fxAutomationTargets';

const makeSlot = (id: string, type: FxSlot['type'], params: Record<string, number> = {}, mix = 0.8): FxSlot => ({
  id, type, name: `${type} ${id}`, enabled: true, mix, params,
});

const makeTrack = (id: number, fxSlots: FxSlot[], name = `Insert ${id}`): MixerTrack => ({
  id, name, color: '#ffffff', volume: 1, pan: 0, mute: false, solo: false, routingTargetId: 0, fxSlots,
} as MixerTrack);

const compressorSlot = () => makeSlot('fx-comp', 'compressor', { threshold: -18, knee: 24, ratio: 4, attack: 0.005, release: 0.15 });
const eqSlot = () => makeSlot('fx-eq', 'equalizer', { lowFreq: 120, lowGain: 0, lowQ: 0.9, midFreq: 1200, midGain: 0, midQ: 1.2, highFreq: 6500, highGain: 0, highQ: 0.8 });

const makeProject = (): ProjectState => ({
  ...createDefaultProjectState(),
  mixerTracks: [
    makeTrack(0, []),
    makeTrack(1, [eqSlot()]),
    makeTrack(2, [compressorSlot()]),
  ],
});

const fxParamClip = (state: ProjectState, paramId = 'threshold'): PlaylistClip => {
  const draft = buildFxParamAutomationTarget(state.mixerTracks, formatFxSlotTargetId(2, 'fx-comp'), paramId);
  assert.ok(draft, 'the fixture project must expose a bindable FX parameter');
  const clip: PlaylistClip = {
    id: 'auto-fx-param',
    trackIndex: 3,
    startBar: 0,
    lengthBars: 4,
    type: 'automation',
    color: '#00e5ff',
    name: 'Auto: FX',
    automationPoints: [{ x: 0, y: 0, tension: 0 }, { x: 1, y: 1, tension: 0 }],
  };
  return updatePlaylistAutomationTarget(clip, draft!);
};

/** Serialize -> parse -> normalize: the exact save/load boundary the app uses. */
const roundTrip = (state: ProjectState): ProjectState => {
  const serialized = serializeProjectState(state);
  const parsed = JSON.parse(serialized) as { state: ProjectState };
  return normalizeProjectState(parsed.state);
};

describe('Phase 81: FX automation targets survive save and reload', () => {
  it('preserves the target type, the composite target id, the param id and the envelope', () => {
    const state = makeProject();
    const clip = fxParamClip(state, 'threshold');
    const saved = roundTrip({ ...state, playlistClips: [clip] });

    const restored = saved.playlistClips[0]!;
    assert.equal(restored.type, 'automation');
    assert.equal(restored.automationTarget?.type, 'fx_param');
    assert.equal(restored.automationTarget?.targetId, '2/fx-comp');
    assert.equal(restored.automationTarget?.paramName, 'threshold');
    assert.deepEqual(restored.automationPoints, clip.automationPoints);
    assert.equal(restored.automationTarget?.label, clip.automationTarget?.label);
    assert.equal(restored.name, clip.name, 'the clip name is derived from the target label');
  });

  it('preserves every contract parameter id, not only the ones the fixture stores', () => {
    const state = makeProject();
    for (const paramId of ['threshold', 'knee', 'ratio', 'attack', 'release']) {
      const clip = fxParamClip(state, paramId);
      const restoredState = roundTrip({ ...state, playlistClips: [clip] });
      const restored = restoredState.playlistClips[0]!;
      assert.equal(restored.automationTarget?.paramName, paramId);
      const resolution = resolveFxParameterUpdate(
        restoredState.mixerTracks,
        restored.automationTarget!.targetId,
        restored.automationTarget!.paramName,
        0.5,
      );
      assert.equal(resolution.status, 'resolved', `${paramId} must still resolve after a reload`);
    }
  });

  it('preserves the wet/dry mix target and the legacy fx_mix addressing side by side', () => {
    const state = makeProject();
    const mixDraft = buildFxSlotAutomationTarget('fx_mix', state.mixerTracks, formatFxSlotTargetId(2, 'fx-comp'));
    const mixClip = updatePlaylistAutomationTarget(
      { id: 'auto-mix', trackIndex: 4, startBar: 0, lengthBars: 4, type: 'automation', color: '#00e5ff', name: 'Auto', automationPoints: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }] },
      mixDraft,
    );
    const legacyClip: PlaylistClip = {
      id: 'auto-legacy-mix', trackIndex: 5, startBar: 0, lengthBars: 4, type: 'automation',
      color: '#00e5ff', name: 'Auto: legacy', automationPoints: [{ x: 0, y: 0.25 }, { x: 1, y: 0.25 }],
      automationTarget: { type: 'fx_mix', targetId: 2, paramName: 'fx-comp', label: 'Legacy' },
    };

    const restored = roundTrip({ ...state, playlistClips: [mixClip, legacyClip] }).playlistClips;
    assert.equal(restored[0]!.automationTarget?.type, 'fx_mix');
    assert.equal(restored[0]!.automationTarget?.targetId, 2);
    assert.equal(restored[0]!.automationTarget?.paramName, 'fx-comp');
    assert.equal(restored[1]!.automationTarget?.type, 'fx_mix');
    assert.deepEqual(restored[1]!.automationTarget, legacyClip.automationTarget);
  });

  it('keeps the history snapshot representation identical to the persisted one', () => {
    const state = makeProject();
    const clip = fxParamClip(state, 'ratio');
    const snapshot = sanitizeProjectSnapshot({ ...state, playlistClips: [clip] });
    assert.equal(snapshot.playlistClips[0]!.automationTarget?.type, 'fx_param');
    assert.equal(snapshot.playlistClips[0]!.automationTarget?.targetId, '2/fx-comp');
    assert.equal(snapshot.playlistClips[0]!.automationTarget?.paramName, 'ratio');
  });
});

describe('Phase 81: MIDI CC mappings survive save and reload', () => {
  it('preserves a composite FX parameter binding byte-for-byte', () => {
    const state = makeProject();
    const mapping = buildFxSlotParameterMapping(21, state.mixerTracks, formatFxSlotTargetId(2, 'fx-comp'), 'threshold');
    assert.ok(mapping);
    const restored = roundTrip({ ...state, midiMappings: [mapping!] });
    assert.deepEqual(restored.midiMappings, [mapping]);
    const resolution = resolveFxParameterUpdate(restored.mixerTracks, mapping!.targetId, mapping!.paramName, 1);
    assert.equal(resolution.status, 'resolved');
    if (resolution.status === 'resolved') assert.equal(resolution.update.value, 0);
  });

  it('preserves the legacy bare-slot-id mix binding the shipped preset uses', () => {
    const state = makeProject();
    const legacy = { ccNumber: 1, targetType: 'fx_param' as const, targetId: 'fx-comp', paramName: 'mix' };
    const restored = roundTrip({ ...state, midiMappings: [legacy] });
    assert.deepEqual(restored.midiMappings, [legacy]);
    const resolution = resolveFxParameterUpdate(restored.mixerTracks, legacy.targetId, legacy.paramName, 0.5);
    assert.equal(resolution.status, 'resolved');
    if (resolution.status === 'resolved') {
      assert.equal(resolution.update.trackId, 2, 'a bare id still resolves by searching the tracks');
      assert.equal(resolution.update.isMix, true);
    }
  });
});

describe('Phase 81: undo and redo restore the parameter and the mapping', () => {
  it('undoes and redoes an FX parameter automation clip', () => {
    const state = makeProject();
    let history = createHistory(state);
    const clip = fxParamClip(state, 'threshold');

    history = history.commit({ ...state, playlistClips: [clip] }, 'Create FX automation');
    assert.equal(history.present.playlistClips.length, 1);
    assert.equal(history.present.playlistClips[0]!.automationTarget?.paramName, 'threshold');

    history = history.undo();
    assert.deepEqual(history.present.playlistClips, state.playlistClips, 'undo removes the clip');
    assert.equal(history.canRedo, true);

    history = history.redo();
    assert.equal(history.present.playlistClips[0]!.automationTarget?.type, 'fx_param');
    assert.equal(history.present.playlistClips[0]!.automationTarget?.targetId, '2/fx-comp');
    assert.equal(history.present.playlistClips[0]!.automationTarget?.paramName, 'threshold');
    assert.deepEqual(history.present.playlistClips[0]!.automationPoints, clip.automationPoints);
  });

  it('undoes and redoes a retarget to a different parameter on the same slot', () => {
    const state = makeProject();
    const withClip = { ...state, playlistClips: [fxParamClip(state, 'threshold')] };
    let history = createHistory(withClip);

    const retargeted = updatePlaylistAutomationTarget(
      withClip.playlistClips[0]!,
      buildFxParamAutomationTarget(state.mixerTracks, formatFxSlotTargetId(2, 'fx-comp'), 'release')!,
    );
    history = history.commit({ ...withClip, playlistClips: [retargeted] }, 'Retarget FX automation');
    assert.equal(history.present.playlistClips[0]!.automationTarget?.paramName, 'release');
    assert.equal(history.present.playlistClips[0]!.automationTarget?.targetId, '2/fx-comp');

    history = history.undo();
    assert.equal(history.present.playlistClips[0]!.automationTarget?.paramName, 'threshold', 'undo restores the previous parameter');

    history = history.redo();
    assert.equal(history.present.playlistClips[0]!.automationTarget?.paramName, 'release');
  });

  it('undoes and redoes an automated parameter value written into the slot', () => {
    const state = makeProject();
    let history = createHistory(state);

    const edited = updateFxSlotInProjectState(state, 2, 'fx-comp', { params: { threshold: -6, knee: 24, ratio: 4, attack: 0.005, release: 0.15 } });
    history = history.commit(edited, 'Update effect parameters');
    assert.equal(history.present.mixerTracks.find(t => t.id === 2)!.fxSlots[0]!.params.threshold, -6);

    history = history.undo();
    assert.equal(history.present.mixerTracks.find(t => t.id === 2)!.fxSlots[0]!.params.threshold, -18);
    assert.equal(history.present.mixerTracks.find(t => t.id === 1)!.fxSlots[0]!.params.midFreq, 1200, 'another insert is untouched');

    history = history.redo();
    assert.equal(history.present.mixerTracks.find(t => t.id === 2)!.fxSlots[0]!.params.threshold, -6);
  });

  it('undoes and redoes a MIDI CC binding', () => {
    const state = makeProject();
    let history = createHistory(state);
    const mapping = buildFxSlotParameterMapping(21, state.mixerTracks, formatFxSlotTargetId(1, 'fx-eq'), 'midFreq')!;

    history = history.commit({ ...state, midiMappings: [mapping] }, 'Bind MIDI CC');
    assert.deepEqual(history.present.midiMappings, [mapping]);

    history = history.undo();
    assert.deepEqual(history.present.midiMappings, []);

    history = history.redo();
    assert.deepEqual(history.present.midiMappings, [mapping]);
    assert.equal(resolveFxParameterUpdate(history.present.mixerTracks, mapping.targetId, mapping.paramName, 1).status, 'resolved');
  });
});

describe('Phase 81: FX slot and track lifecycle', () => {
  it('a deleted slot leaves the clip in place but makes the target unresolvable', () => {
    const state = makeProject();
    const clip = fxParamClip(state, 'threshold');
    const afterDelete = deleteFxSlotFromProjectState({ ...state, playlistClips: [clip] }, 2, 'fx-comp');

    // The document keeps the user's clip: nothing silently retargets or deletes it.
    assert.equal(afterDelete.playlistClips[0]!.automationTarget?.targetId, '2/fx-comp');
    assert.equal(afterDelete.playlistClips[0]!.automationTarget?.paramName, 'threshold');
    assert.deepEqual(afterDelete.mixerTracks.find(t => t.id === 2)!.fxSlots, []);

    const resolution = resolveFxParameterUpdate(afterDelete.mixerTracks, '2/fx-comp', 'threshold', 1);
    assert.equal(resolution.status, 'rejected');
    if (resolution.status === 'rejected') assert.match(resolution.reason, /no FX slot/i);
  });

  it('reordering slots inside a track keeps the target on the same effect', () => {
    const state = makeProject();
    const clip = fxParamClip(state, 'threshold');
    // A second slot is added and the array order is then swapped, so the
    // compressor is no longer the first slot on the track.
    const reordered = addFxSlotToProjectState(state, 2, makeSlot('fx-new', 'delay', { time: 0.2 }));
    const track2 = reordered.mixerTracks.find(t => t.id === 2)!;
    assert.deepEqual(track2.fxSlots.map(slot => slot.id), ['fx-comp', 'fx-new']);
    const withOrder = {
      ...reordered,
      mixerTracks: reordered.mixerTracks.map(t =>
        t.id === 2 ? { ...t, fxSlots: [track2.fxSlots[1]!, track2.fxSlots[0]!] } : t),
      playlistClips: [clip],
    };

    const restored = roundTrip(withOrder);
    const slots = restored.mixerTracks.find(t => t.id === 2)!.fxSlots;
    assert.deepEqual(slots.map(slot => slot.id), ['fx-new', 'fx-comp'], 'the reload keeps the new order');
    const resolution = resolveFxParameterUpdate(restored.mixerTracks, '2/fx-comp', 'threshold', 0.5);
    assert.equal(resolution.status, 'resolved');
    if (resolution.status === 'resolved') {
      assert.equal(resolution.update.fxType, 'compressor', 'the target still names the compressor, not the delay');
      assert.equal(resolution.update.slotId, 'fx-comp');
    }
  });

  it('a slot id reused on another insert is never addressed by a pinned target', () => {
    const state = makeProject();
    const reused = {
      ...state,
      mixerTracks: [
        makeTrack(0, []),
        makeTrack(1, [makeSlot('fx-comp', 'limiter', { ceiling: -1 })]),
        makeTrack(2, []),
      ],
    };
    const resolution = resolveFxParameterUpdate(reused.mixerTracks, '2/fx-comp', 'threshold', 1);
    assert.equal(resolution.status, 'rejected', 'track 2 no longer owns the slot');

    // A bare id would find the limiter slot but `threshold` is not a limiter
    // parameter, so it is still rejected rather than mis-applied.
    const bare = resolveFxParameterUpdate(reused.mixerTracks, 'fx-comp', 'threshold', 1);
    assert.equal(bare.status, 'rejected');
    const bareCeiling = resolveFxParameterUpdate(reused.mixerTracks, 'fx-comp', 'ceiling', 1);
    assert.equal(bareCeiling.status, 'resolved', 'a legacy bare id still resolves to the slot that owns it');
  });

  it('a deleted mixer track makes every target on it unresolvable without throwing', () => {
    const state = makeProject();
    const clip = fxParamClip(state, 'threshold');
    const mapping = buildFxSlotParameterMapping(21, state.mixerTracks, formatFxSlotTargetId(2, 'fx-comp'), 'threshold')!;
    const withoutTrack: ProjectState = {
      ...state,
      playlistClips: [clip],
      midiMappings: [mapping],
      mixerTracks: state.mixerTracks.filter(track => track.id !== 2),
    };

    const restored = roundTrip(withoutTrack);
    assert.equal(restored.playlistClips.length, 1, 'the clip survives; only its target is stale');
    assert.equal(resolveFxSlot(restored.mixerTracks, '2/fx-comp').status, 'unresolved');
    assert.equal(resolveFxParameterUpdate(restored.mixerTracks, mapping.targetId, mapping.paramName, 1).status, 'rejected');
    assert.equal(resolveFxParameterUpdate(restored.mixerTracks, '1/fx-eq', 'midFreq', 1).status, 'resolved', 'other inserts keep working');
  });

  it('a replaced project carries no targets from the previous document', () => {
    const state = makeProject();
    const clip = fxParamClip(state, 'threshold');
    const withWork = { ...state, playlistClips: [clip], midiMappings: [buildFxSlotParameterMapping(21, state.mixerTracks, '2/fx-comp', 'threshold')!] };
    assert.equal(roundTrip(withWork).playlistClips.length, 1);

    const replacement = roundTrip(createDefaultProjectState());
    assert.deepEqual(replacement.playlistClips, []);
    assert.deepEqual(replacement.midiMappings, []);
    assert.equal(resolveFxParameterUpdate(replacement.mixerTracks, '2/fx-comp', 'threshold', 1).status, 'rejected');
  });
});

describe('Phase 81: malformed serialized targets load safely', () => {
  it('loads a document whose automation target is garbage and resolves it to nothing', () => {
    const state = makeProject();
    const malformed: PlaylistClip[] = [
      {
        id: 'auto-bad-1', trackIndex: 0, startBar: 0, lengthBars: 4, type: 'automation',
        color: '#00e5ff', name: 'Bad', automationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        automationTarget: { type: 'fx_param', targetId: 'not-a-track/fx-comp', paramName: 'threshold' },
      },
      {
        id: 'auto-bad-2', trackIndex: 1, startBar: 0, lengthBars: 4, type: 'automation',
        color: '#00e5ff', name: 'Bad 2', automationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        automationTarget: { type: 'fx_param', targetId: '2/fx-comp', paramName: 'inventedParam' },
      },
      {
        id: 'auto-bad-3', trackIndex: 2, startBar: 0, lengthBars: 4, type: 'automation',
        color: '#00e5ff', name: 'Bad 3', automationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        automationTarget: { type: 'fx_param', targetId: '', paramName: '' },
      },
    ];

    const restored = roundTrip({ ...state, playlistClips: malformed });
    assert.equal(restored.playlistClips.length, 3, 'a malformed target never destroys the document');
    for (const clip of restored.playlistClips) {
      const resolution = resolveFxParameterUpdate(
        restored.mixerTracks,
        clip.automationTarget!.targetId,
        clip.automationTarget!.paramName,
        1,
      );
      assert.equal(resolution.status, 'rejected', `${clip.id} must not resolve`);
    }
    // The valid parameters on the same slot still work.
    assert.equal(resolveFxParameterUpdate(restored.mixerTracks, '2/fx-comp', 'threshold', 1).status, 'resolved');
  });

  it('loads a document whose midi mapping is garbage and reports it unsupported', () => {
    const state = makeProject();
    const restored = roundTrip({
      ...state,
      midiMappings: [
        { ccNumber: 21, targetType: 'fx_param', targetId: '2/fx-comp', paramName: 'inventedParam' },
        { ccNumber: 22, targetType: 'fx_param', targetId: '99/fx-comp', paramName: 'threshold' },
      ] as ProjectState['midiMappings'],
    });
    assert.equal(restored.midiMappings.length, 2);
    for (const mapping of restored.midiMappings) {
      assert.equal(
        resolveFxParameterUpdate(restored.mixerTracks, mapping.targetId, mapping.paramName, 1).status,
        'rejected',
      );
    }
  });
});

describe('Phase 81: the UI target builders publish persistable, resolvable targets', () => {
  it('builds a target for every contract parameter the project owns', () => {
    const state = makeProject();
    const cases: Array<[string, string, string]> = [
      ['1/fx-eq', 'lowFreq', 'equalizer'],
      ['1/fx-eq', 'highQ', 'equalizer'],
      ['2/fx-comp', 'threshold', 'compressor'],
      ['2/fx-comp', 'release', 'compressor'],
    ];
    for (const [targetId, paramId, fxType] of cases) {
      const draft = buildFxParamAutomationTarget(state.mixerTracks, targetId, paramId);
      assert.ok(draft, `${targetId}/${paramId} must be offered`);
      assert.equal(draft!.type, 'fx_param');
      assert.equal(draft!.targetId, targetId);
      assert.equal(draft!.paramName, paramId);
      assert.ok((draft!.label ?? '').length > 0);
      const resolution = resolveFxParameterUpdate(state.mixerTracks, draft!.targetId, draft!.paramName, 0.5);
      assert.equal(resolution.status, 'resolved');
      if (resolution.status === 'resolved') assert.equal(resolution.update.fxType, fxType);
    }
  });

  it('refuses to build a target for a parameter the contract does not own', () => {
    const state = makeProject();
    assert.equal(buildFxParamAutomationTarget(state.mixerTracks, '2/fx-comp', 'inventedParam'), null);
    assert.equal(buildFxParamAutomationTarget(state.mixerTracks, '2/fx-gone', 'threshold'), null);
    assert.equal(buildFxParamAutomationTarget(state.mixerTracks, 'bad/id', 'threshold'), null);
    assert.equal(buildFxParamAutomationTarget(state.mixerTracks, '2/fx-comp', ''), null);
  });

  it('picks a slot that can actually carry an fx_param target when the type is selected', () => {
    // A project whose first insert is a convolver reverb (no contract params).
    const state: ProjectState = {
      ...createDefaultProjectState(),
      mixerTracks: [
        makeTrack(0, []),
        makeTrack(1, [makeSlot('fx-verb', 'reverb', {}, 0.5)]),
        makeTrack(2, [compressorSlot()]),
      ],
    };
    const draft = buildFxAutomationTarget('fx_param', state.mixerTracks, null);
    assert.equal(draft.type, 'fx_param');
    assert.equal(draft.targetId, '2/fx-comp', 'the picker must not offer a parameterless slot');
    assert.equal(draft.paramName, 'threshold');

    const mixDraft = buildFxAutomationTarget('fx_mix', state.mixerTracks, null);
    assert.equal(mixDraft.type, 'fx_mix');
    assert.equal(mixDraft.targetId, 1, 'fx_mix keeps the legacy numeric track id');
    assert.equal(mixDraft.paramName, 'fx-verb');
    assert.equal(resolveFxSlot(state.mixerTracks, formatFxSlotTargetId(Number(mixDraft.targetId), mixDraft.paramName!)).status, 'resolved');
  });

  it('produces a safe empty target when the project has no FX slot at all', () => {
    const state: ProjectState = { ...createDefaultProjectState(), mixerTracks: [makeTrack(0, [])] };
    const paramDraft = buildFxAutomationTarget('fx_param', state.mixerTracks, null);
    assert.equal(paramDraft.targetId, '');
    assert.equal(resolveFxParameterUpdate(state.mixerTracks, paramDraft.targetId, paramDraft.paramName, 1).status, 'rejected');

    const mixDraft = buildFxAutomationTarget('fx_mix', state.mixerTracks, null);
    assert.equal(mixDraft.paramName, '');
    assert.equal(resolveFxSlot(state.mixerTracks, mixDraft.targetId).status, 'unresolved');
  });

  it('keeps the selected parameter when the user switches slot and the family supports it', () => {
    const state: ProjectState = {
      ...createDefaultProjectState(),
      mixerTracks: [
        makeTrack(0, []),
        makeTrack(1, [compressorSlot()]),
        makeTrack(2, [makeSlot('fx-comp-2', 'compressor', { threshold: -30 })]),
      ],
    };
    const moved = buildFxSlotAutomationTarget('fx_param', state.mixerTracks, '2/fx-comp-2', {
      type: 'fx_param', targetId: '1/fx-comp', paramName: 'threshold',
    });
    assert.equal(moved.targetId, '2/fx-comp-2');
    assert.equal(moved.paramName, 'threshold', 'the same parameter name survives the move');

    const toEq = buildFxSlotAutomationTarget('fx_param', state.mixerTracks, '1/fx-comp', {
      type: 'fx_param', targetId: '1/fx-comp', paramName: 'notOnThisSlot',
    });
    assert.equal(toEq.paramName, 'threshold', 'an unsupported parameter falls back to the slot\'s first one');
  });
});
