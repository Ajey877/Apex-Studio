import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { createHistory } from './projectHistory';
import { serializeProjectState } from './projectPersistence';
import * as projectMutations from './projectMutations';
import {
  applyMacroRackUpdate,
  reapplyMacroRackOnHydration,
  resolveMacroRack
} from './macroMappings';
import type { MasterMacroKnob, ProjectState } from '../types/daw';

/**
 * Phase 51 regression: the Master Macro Rack used to be decorative.
 *
 * Pre-Phase 51 the only macro mutation was a plain field write — the knob array
 * was persisted and the modal rendered it, but no mapping was ever resolved into
 * a channel, a mixer insert or an FX slot. Turning a macro knob changed the knob
 * and nothing else.
 *
 * These tests pin the defect itself (so it cannot silently return), pin the
 * atomic replacement, and pin the two places the fix could plausibly be
 * over-applied: undo/redo and the save path.
 */

const rack: MasterMacroKnob[] = [
  {
    id: 'macro-1',
    name: 'DROP BUILDUP (SWEEP)',
    value: 1,
    color: '#ff6e00',
    mappings: [
      { targetType: 'channel_volume', targetId: 'ch-1', min: 0.2, max: 1, curve: 'linear' },
      { targetType: 'mixer_volume', targetId: 2, min: 0, max: 1.25, curve: 'linear' },
      { targetType: 'filter_cutoff', targetId: 'ch-1', min: 200, max: 18000, curve: 'exponential' },
      { targetType: 'reverb_wet', targetId: 2, min: 0.1, max: 0.9, curve: 'linear' }
    ]
  }
];

const channelOf = (state: ProjectState, id: string) =>
  state.channels.find(channel => channel.id === id)!;
const trackOf = (state: ProjectState, id: number) =>
  state.mixerTracks.find(track => track.id === id)!;
const slotOf = (state: ProjectState, trackId: number, slotId: string) =>
  trackOf(state, trackId).fxSlots.find(slot => slot.id === slotId)!;

/** Exactly what the pre-Phase 51 mutation did: write the knob array, nothing else. */
const writeKnobsOnly = (state: ProjectState, macroKnobs: MasterMacroKnob[]): ProjectState => ({
  ...state,
  macroKnobs
});

test('the defect is reproducible: writing knobs only leaves every mapped parameter stale', () => {
  const state = createDefaultProjectState();
  const before = {
    channelVolume: channelOf(state, 'ch-1').volume,
    channelCutoff: channelOf(state, 'ch-1').synthParams.filterCutoff,
    mixerVolume: trackOf(state, 2).volume,
    reverbMix: slotOf(state, 2, 'fx-2-verb').mix
  };

  const defectiveWrite = writeKnobsOnly(state, rack);

  assert.equal(defectiveWrite.macroKnobs![0].value, 1, 'the knob moved');
  assert.equal(channelOf(defectiveWrite, 'ch-1').volume, before.channelVolume);
  assert.equal(channelOf(defectiveWrite, 'ch-1').synthParams.filterCutoff, before.channelCutoff);
  assert.equal(trackOf(defectiveWrite, 2).volume, before.mixerVolume);
  assert.equal(slotOf(defectiveWrite, 2, 'fx-2-verb').mix, before.reverbMix);
});

test('the pre-Phase 51 knob-only setter no longer exists', () => {
  // Guards the regression directly: reintroducing a mutation that publishes the
  // knob array without applying it should be a deliberate, visible change.
  assert.equal(
    (projectMutations as Record<string, unknown>).updateMacroKnobsInProjectState,
    undefined,
    'updateMacroKnobsInProjectState must not come back as a knob-only write'
  );
  assert.equal(typeof projectMutations.updateMacroRackInProjectState, 'function');
});

test('the Phase 51 mutation applies every mapped parameter with the knob value', () => {
  const state = createDefaultProjectState();

  const next = projectMutations.updateMacroRackInProjectState(state, rack);

  assert.equal(next.macroKnobs![0].value, 1);
  assert.equal(channelOf(next, 'ch-1').volume, 1);
  assert.equal(trackOf(next, 2).volume, 1.25);
  assert.equal(channelOf(next, 'ch-1').synthParams.filterCutoff, 18000);
  assert.equal(slotOf(next, 2, 'fx-2-verb').mix, 0.9);
});

test('the resolved state and the rack description agree, so they cannot drift', () => {
  const state = createDefaultProjectState();
  const applied = applyMacroRackUpdate(state, rack);
  const resolution = resolveMacroRack(rack, applied);

  for (const parameter of resolution.parameters) {
    if (parameter.parameter === 'channel.volume') {
      assert.equal(channelOf(applied, parameter.targetId).volume, parameter.value);
    }
    if (parameter.parameter === 'mixerTrack.volume') {
      assert.equal(trackOf(applied, Number(parameter.targetId)).volume, parameter.value);
    }
    if (parameter.parameter === 'channel.synthParams.filterCutoff') {
      assert.equal(channelOf(applied, parameter.targetId).synthParams.filterCutoff, parameter.value);
    }
  }
  // Re-resolving against the already-applied state yields identical values.
  const reapplied = applyMacroRackUpdate(applied, rack);
  assert.equal(reapplied, applied);
});

test('a macro move is one atomic history entry that undo restores completely', () => {
  const state = createDefaultProjectState();
  const previous = {
    knobValue: 0.2,
    channelVolume: channelOf(state, 'ch-1').volume,
    mixerVolume: trackOf(state, 2).volume,
    reverbMix: slotOf(state, 2, 'fx-2-verb').mix
  };
  const initialRack: MasterMacroKnob[] = [{ ...rack[0], value: previous.knobValue }];
  const initialState = writeKnobsOnly(state, initialRack);

  const history = createHistory(initialState).commit(
    projectMutations.updateMacroRackInProjectState(initialState, rack),
    'Update macro controls'
  );

  assert.equal(history.past.length, 1, 'the whole multi-target move is one entry');

  const undone = history.undo();
  assert.equal(undone.present.macroKnobs![0].value, previous.knobValue);
  assert.equal(channelOf(undone.present, 'ch-1').volume, previous.channelVolume);
  assert.equal(trackOf(undone.present, 2).volume, previous.mixerVolume);
  assert.equal(slotOf(undone.present, 2, 'fx-2-verb').mix, previous.reverbMix);

  const redone = undone.redo();
  assert.equal(redone.present.macroKnobs![0].value, 1);
  assert.equal(channelOf(redone.present, 'ch-1').volume, 1);
  assert.equal(trackOf(redone.present, 2).volume, 1.25);
  assert.equal(slotOf(redone.present, 2, 'fx-2-verb').mix, 0.9);
});

test('a saved and reopened project keeps the applied parameters', () => {
  const applied = applyMacroRackUpdate(createDefaultProjectState(), rack);

  const reopened = normalizeProjectState(JSON.parse(serializeProjectState(applied)).state);

  assert.equal(reopened.macroKnobs![0].value, 1);
  assert.equal(channelOf(reopened, 'ch-1').volume, 1);
  assert.equal(trackOf(reopened, 2).volume, 1.25);
  assert.equal(slotOf(reopened, 2, 'fx-2-verb').mix, 0.9);
});

test('hydration re-applies the stored rack to a stale document', () => {
  const applied = applyMacroRackUpdate(createDefaultProjectState(), rack);
  // A document whose saved parameters never captured the macro values: the exact
  // state a pre-Phase 51 save produced.
  const stale = writeKnobsOnly(createDefaultProjectState(), rack);

  const hydrated = reapplyMacroRackOnHydration(stale);

  assert.equal(channelOf(hydrated, 'ch-1').volume, channelOf(applied, 'ch-1').volume);
  assert.equal(trackOf(hydrated, 2).volume, trackOf(applied, 2).volume);
  assert.equal(channelOf(hydrated, 'ch-1').synthParams.filterCutoff, 18000);
  assert.equal(slotOf(hydrated, 2, 'fx-2-verb').mix, 0.9);
});

test('hydration is not applied on the save path, so a manual override survives', () => {
  // The fix must not become "macros always win": a user who deliberately moves a
  // macro-mapped fader keeps that edit when the project is saved and reloaded.
  const applied = applyMacroRackUpdate(createDefaultProjectState(), rack);
  const overridden: ProjectState = {
    ...applied,
    channels: applied.channels.map(channel =>
      channel.id === 'ch-1' ? { ...channel, volume: 0.42 } : channel
    )
  };

  const savedAndReloaded = normalizeProjectState(JSON.parse(serializeProjectState(overridden)).state);

  assert.equal(channelOf(savedAndReloaded, 'ch-1').volume, 0.42, 'the manual edit is preserved');
  // Loading that document (a hydration boundary) is where the rack re-asserts.
  assert.equal(channelOf(reapplyMacroRackOnHydration(savedAndReloaded), 'ch-1').volume, 1);
});

test('a macro whose targets are missing still applies the targets it does have', () => {
  const state = createDefaultProjectState();
  const partiallyStale: MasterMacroKnob[] = [
    {
      ...rack[0],
      mappings: [
        ...rack[0].mappings,
        { targetType: 'channel_volume', targetId: 'bass', min: 0.4, max: 1, curve: 'linear' }
      ]
    }
  ];

  const next = projectMutations.updateMacroRackInProjectState(state, partiallyStale);
  const resolution = resolveMacroRack(partiallyStale, state);

  assert.equal(resolution.unresolved.length, 1);
  assert.match(resolution.unresolved[0].reason, /"bass"/);
  assert.equal(channelOf(next, 'ch-1').volume, 1, 'the resolvable mappings still apply');
  assert.equal(trackOf(next, 2).volume, 1.25);
});
