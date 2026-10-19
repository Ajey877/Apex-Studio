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

test('deleting an orphaned mixer destination removes incoming aux sends and redirects dependent routes', () => {
  const project = createDefaultProjectState();
  project.mixerTracks[1].routingTargetId = 2;
  project.mixerTracks[1].auxSends = [
    { targetId: 2, amount: 0.37 },
    { targetId: 3, amount: 0.64 },
  ];
  project.mixerTracks[4].routingTargetId = 3;
  project.mixerTracks[4].auxSends = [{ targetId: 2, amount: 0.58 }];
  const originalMixerTracks = structuredClone(project.mixerTracks);

  const result = deleteChannelFromProjectState(project, 'ch-2');

  assert.equal(result.removedMixerTrackId, 2);
  assert.equal(result.state.mixerTracks.some(track => track.id === 2), false);
  const sourceTrack = result.state.mixerTracks.find(track => track.id === 1);
  assert.ok(sourceTrack);
  assert.equal(sourceTrack.routingTargetId, 0);
  assert.deepEqual(sourceTrack.auxSends, [{ targetId: 3, amount: 0.64 }]);

  const otherSourceTrack = result.state.mixerTracks.find(track => track.id === 4);
  assert.ok(otherSourceTrack);
  assert.equal(otherSourceTrack.auxSends, undefined);
  assert.equal(otherSourceTrack.routingTargetId, 3);
  assert.deepEqual(project.mixerTracks, originalMixerTracks);
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


test('project replacement normalization repairs identity gaps before routing validation', () => {
  const incoming = createDefaultProjectState();
  incoming.channels[0] = { ...incoming.channels[0], mixerTrackId: 500 };
  incoming.mixerTracks = incoming.mixerTracks.map(track => (
    track.id === 1 ? { ...track, routingTargetId: 2 } : track
  ));

  const replaced = normalizeProjectState(JSON.parse(JSON.stringify(incoming)));
  const channelIds = replaced.channels.map(channel => channel.mixerTrackId);

  assert.equal(new Set(channelIds).size, channelIds.length);
  for (const id of channelIds) {
    assert.equal(replaced.mixerTracks.filter(track => track.id === id).length, 1);
  }
  assert.equal(replaced.mixerTracks.find(track => track.id === 1)?.routingTargetId, 2);
});
