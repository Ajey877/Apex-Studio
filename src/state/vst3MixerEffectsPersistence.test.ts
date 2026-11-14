import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { createHistory } from './projectHistory';
import { addFxSlotToProjectState, deleteFxSlotFromProjectState, moveFxSlotInProjectState, updateFxSlotInProjectState } from './projectMutations';
import { serializeProjectState } from './projectPersistence';
import type { FxSlot } from '../types/daw';
import type { Vst3Effect } from '../audio/nativeVst3Types';

const effect: Vst3Effect = {
  path: 'C:/Authorized/VST3/mda-vst3.vst3',
  classId: '5653546D6461796D64612064656C6179',
  name: 'mda Delay', vendor: 'MDA', version: '1.0.0',
  state: {
    schema: 1,
    classId: '5653546D6461796D64612064656C6179',
    component: '01020304', controller: 'aabbccdd',
    parameters: [{ id: 4, value: 0.75 }],
  },
};
const slot = (id: string): FxSlot => ({ id, type: 'vst3', name: 'mda Delay', enabled: true, mix: 1, params: {}, vst3Effect: structuredClone(effect) });

test('native Mixer effect identity, state and slot order survive project serialize/restore', () => {
  const base = createDefaultProjectState();
  const state = {
    ...base,
    mixerTracks: base.mixerTracks.map(track => track.id === 1 ? { ...track, fxSlots: [slot('native-a'), slot('native-b')] } : track),
  };
  const encoded = serializeProjectState(state);
  const restored = normalizeProjectState(JSON.parse(encoded).state);
  const fx = restored.mixerTracks.find(track => track.id === 1)!.fxSlots;
  assert.deepEqual(fx.map(item => item.id), ['native-a', 'native-b']);
  assert.deepEqual(fx[0]!.vst3Effect, effect);
  assert.match(encoded, /component/);
  assert.doesNotMatch(encoded, /Float32Array|ArrayBuffer/);
});

test('native Mixer effect add, edit, reorder, undo, redo and removal are project-history mutations', () => {
  const defaultState = createDefaultProjectState();
  const base = { ...defaultState, mixerTracks: defaultState.mixerTracks.map(track => track.id === 1 ? { ...track, fxSlots: [] } : track) };
  const first = slot('native-a'), second = slot('native-b');
  const added = addFxSlotToProjectState(base, 1, first);
  const history = createHistory(base).commit(added, 'Add VST3 Mixer effect');
  assert.equal(history.canUndo, true);
  const updatedEffect = { ...effect, state: { ...effect.state, parameters: [{ id: 4, value: 0.25 }] } };
  const updated = updateFxSlotInProjectState(history.present, 1, first.id, { vst3Effect: updatedEffect });
  const editedHistory = history.commit(updated, 'Edit VST3 effect parameters');
  assert.equal(editedHistory.present.mixerTracks.find(track => track.id === 1)!.fxSlots[0]!.vst3Effect!.state.parameters[0]!.value, 0.25);
  const withSecond = addFxSlotToProjectState(editedHistory.present, 1, second);
  const withSecondHistory = editedHistory.commit(withSecond, 'Add second VST3 effect');
  const moved = moveFxSlotInProjectState(withSecondHistory.present, 1, second.id, -1);
  const movedHistory = withSecondHistory.commit(moved, 'Reorder Mixer effects');
  assert.deepEqual(movedHistory.present.mixerTracks.find(track => track.id === 1)!.fxSlots.map(item => item.id), ['native-b', 'native-a']);
  const undone = movedHistory.undo();
  assert.deepEqual(undone.present.mixerTracks.find(track => track.id === 1)!.fxSlots.map(item => item.id), ['native-a', 'native-b']);
  const redone = undone.redo();
  assert.deepEqual(redone.present.mixerTracks.find(track => track.id === 1)!.fxSlots.map(item => item.id), ['native-b', 'native-a']);
  const deleted = deleteFxSlotFromProjectState(redone.present, 1, first.id);
  assert.deepEqual(deleted.mixerTracks.find(track => track.id === 1)!.fxSlots.map(item => item.id), ['native-b']);
});

test('re-saving an identical plug-in state in another key order records no undo step', () => {
  // Regression for packaged p5. The regained document is legitimately rebuilt from
  // a parameter list, so its keys arrive in another order. History compared the two
  // with JSON.stringify, whose output follows insertion order, so closing an editor
  // that changed nothing pushed an undo entry whose restore changed nothing either.
  // Undo then appeared to do nothing, and the NEXT undo -- the one that mattered --
  // looked broken.
  const base = createDefaultProjectState();
  const withSlot = {
    ...base,
    mixerTracks: base.mixerTracks.map(track => track.id === 1 ? { ...track, fxSlots: [slot('native-a')] } : track),
  };
  const history = createHistory(withSlot);
  const present = history.present;
  const sameValuesOtherOrder = JSON.parse(JSON.stringify(present));
  const fx = sameValuesOtherOrder.mixerTracks.find((track: { id: number }) => track.id === 1).fxSlots[0];
  const state = fx.vst3Effect.state;
  fx.vst3Effect.state = {
    parameters: state.parameters, controller: state.controller, component: state.component,
    classId: state.classId, schema: state.schema,
  };
  const after = history.commit(sameValuesOtherOrder, 'Close editor (nothing changed)');
  assert.equal(after.past.length, history.past.length, 'an identical document adds no history entry');
  assert.equal(after, history, 'the history object is returned unchanged');

  // A genuine change in the same representation must still be recorded.
  const changed = JSON.parse(JSON.stringify(present));
  changed.mixerTracks.find((track: { id: number }) => track.id === 1).fxSlots[0].vst3Effect
    .state.parameters[0].value = 0.25;
  assert.equal(history.commit(changed, 'Edit plug-in state').past.length, 1,
    'a real parameter change is still one undo step');
});
