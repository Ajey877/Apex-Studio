import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMetadata, validateParameterChanges } from '../../native/vst3/parameters.mjs';
import { assertVst3Instrument } from './nativeVst3Types';
import { withVst3Parameters } from './nativeVst3Parameters';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { createHistory } from '../state/projectHistory';
import { updateChannelInProjectState } from '../state/projectMutations';
import { serializeProjectState } from '../state/projectPersistence';
const parameter = { id: 6, name: 'Real metadata contract', shortTitle: '', units: '', defaultValue: .5, currentValue: .4, flags: 1, stepCount: 0 };
test('metadata contract accepts unavailable controller/current value and rejects malformed or duplicate metadata/choices', () => {
  assert.deepEqual(validateMetadata([], false), []);
  assert.deepEqual(validateMetadata([{ ...parameter, currentValue: null }], true)[0].currentValue, null);
  for (const ps of [[parameter], null]) assert.throws(() => validateMetadata(ps, false));
  for (const ps of [[parameter, parameter], [{ ...parameter, defaultValue: NaN }], [{ ...parameter, currentValue: Infinity }],
    [{ ...parameter, id: 2 ** 32 }], [{ ...parameter, flags: -1 }], [{ ...parameter, name: 'x'.repeat(513) }],
    [{ ...parameter, stepCount: -1 }], [{ ...parameter, choices: [{ label: 'invented', value: .5 }] }], Array(4097).fill(parameter)]) assert.throws(() => validateMetadata(ps, true));
});
test('privileged validator refuses read-only/hidden/program writes, invalid values/IDs, unknowns and duplicate/oversized queues', () => {
  for (const flags of [2, 16, 32768]) assert.throws(() => validateParameterChanges([{ id: 6, value: .3 }], [{ ...parameter, flags }]));
  for (const changes of [[], null, [{ id: 6, value: NaN }], [{ id: 6, value: Infinity }], [{ id: 6, value: -.1 }], [{ id: 6, value: 1.1 }],
    [{ id: -1, value: .1 }], [{ id: 6.5, value: .1 }], [{ id: 2 ** 32, value: .1 }], [{ id: 7, value: .1 }],
    [{ id: 6, value: .1 }, { id: 6, value: .2 }], Array(4097).fill({ id: 6, value: .1 })]) assert.throws(() => validateParameterChanges(changes, [parameter]));
  assert.deepEqual(validateParameterChanges([{ id: 6, value: .1 }], [parameter]), [{ id: 6, value: .1 }]);
});
test('one explicit batch preserves streams/class identity, immutable state, undo/redo, reload and legacy absent overrides', () => {
  const state = createDefaultProjectState(), id = state.channels[0].id;
  const instrument = { path: 'test.vst3', classId: 'A'.repeat(32), name: 'Fixture contract', vendor: '', version: '',
    state: { schema: 1 as const, classId: 'A'.repeat(32), component: '010203', controller: 'abcd', parameters: [] } };
  const original = updateChannelInProjectState(state, id, { instrumentType: 'vst3', vst3: instrument });
  const updated = withVst3Parameters(instrument, [{ id: 6, value: .1 }, { id: 7, value: .2 }]);
  const legacy = { ...instrument, state: { ...instrument.state, parameters: undefined } };
  assertVst3Instrument(legacy);
  assert.equal(withVst3Parameters(legacy, [{ id: 6, value: .2 }]).state.parameters[0].value, .2);
  assert.deepEqual(instrument.state.parameters, []); assert.equal(updated.state.component, '010203'); assert.equal(updated.state.controller, 'abcd');
  assert.equal(updated.classId, instrument.classId);
  const history = createHistory(original).commit(updateChannelInProjectState(original, id, { vst3: updated }), 'Edit VST3 parameters');
  assert.equal(history.past.length, 1);
  assert.deepEqual(history.undo().present.channels[0].vst3, instrument);
  assert.deepEqual(history.undo().redo().present.channels[0].vst3, updated);
  assert.deepEqual(normalizeProjectState(JSON.parse(serializeProjectState(history.present)).state).channels[0].vst3, updated);
  assert.deepEqual(normalizeProjectState(state).channels, state.channels);
  for (const changes of [[{ id: 6, value: NaN }], [{ id: -1, value: .1 }], []]) assert.throws(() => withVst3Parameters(instrument, changes));
});
