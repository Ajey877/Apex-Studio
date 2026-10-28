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
