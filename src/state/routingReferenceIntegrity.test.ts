import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultProjectState, deleteChannelFromProjectState, normalizeProjectState } from './projectState';
import { createHistory } from './projectHistory';

test('valid routing survives normalization unchanged', () => {
  const project = createDefaultProjectState();
  project.mixerTracks[1].routingTargetId = 2;

  const normalized = normalizeProjectState(project);

  assert.equal(normalized.mixerTracks.find(track => track.id === 1)?.routingTargetId, 2);
});

test('invalid routing destinations normalize safely to Master', () => {
  const project = createDefaultProjectState();
  const malformed = {
    ...project,
    mixerTracks: project.mixerTracks.map(track => (
      track.id === 1 ? { ...track, routingTargetId: 999 } : track
    ))
  } as unknown;

  const normalized = normalizeProjectState(malformed);

  assert.equal(normalized.mixerTracks.find(track => track.id === 1)?.routingTargetId, 0);
});

test('deleting a mixer destination clears dependent routes', () => {
  const project = createDefaultProjectState();
  project.mixerTracks[1].routingTargetId = 2;
  project.mixerTracks.push({ ...project.mixerTracks[1], id: 8, name: 'Unrelated Bus', routingTargetId: 1 });

  const result = deleteChannelFromProjectState(project, 'ch-2');

  assert.equal(result.removedMixerTrackId, 2);
  assert.equal(result.state.mixerTracks.some(track => track.id === 2), false);
  assert.equal(result.state.mixerTracks.find(track => track.id === 1)?.routingTargetId, 0);
});

test('unrelated routes remain unchanged when a destination is deleted', () => {
  const project = createDefaultProjectState();
  project.mixerTracks[1].routingTargetId = 2;
  project.mixerTracks.push({ ...project.mixerTracks[1], id: 8, name: 'Unrelated Bus', routingTargetId: 1 });

  const result = deleteChannelFromProjectState(project, 'ch-2');

  assert.equal(result.state.mixerTracks.find(track => track.id === 8)?.routingTargetId, 1);
});

test('undo and redo preserve the repaired routing state', () => {
  const project = createDefaultProjectState();
  project.mixerTracks[1].routingTargetId = 2;

  const deletion = deleteChannelFromProjectState(project, 'ch-2');
  const history = createHistory(project).commit(deletion.state, 'Delete channel');
  const undone = history.undo();
  const redone = undone.redo();

  assert.equal(undone.present.mixerTracks.find(track => track.id === 1)?.routingTargetId, 2);
  assert.equal(redone.present.mixerTracks.find(track => track.id === 1)?.routingTargetId, 0);
  assert.equal(redone.present.mixerTracks.some(track => track.id === 2), false);
});
