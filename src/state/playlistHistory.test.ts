import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultProjectState } from './projectState';
import { createPlaylistHistory } from './playlistHistory';

const makeState = () => {
  const state = createDefaultProjectState();
  state.playlistTracks[0].name = 'Track 1';
  state.playlistClips = [];
  state.markers = [];
  return state;
};

test('playlist history starts empty', () => {
  const history = createPlaylistHistory(makeState());
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.pastLength, 0);
  assert.equal(history.futureLength, 0);
});

test('playlist edits can be undone and redone without changing unrelated project state', () => {
  const initial = makeState();
  const edited = structuredClone(initial);
  edited.playlistTracks[0].name = 'Main Track';
  edited.channels[0].volume = 0.42;

  let history = createPlaylistHistory(initial);
  history = history.commit(edited, 'Rename Playlist Track');

  const current = structuredClone(edited);
  const undone = history.undo(current);
  assert.equal(undone.state.playlistTracks[0].name, 'Track 1');
  assert.equal(undone.state.channels[0].volume, 0.42);

  const redone = undone.history.redo(undone.state);
  assert.equal(redone.state.playlistTracks[0].name, 'Main Track');
  assert.equal(redone.state.channels[0].volume, 0.42);
});

test('new playlist edit clears redo', () => {
  const initial = makeState();
  const first = structuredClone(initial);
  first.playlistTracks[0].name = 'A';
  const second = structuredClone(first);
  second.playlistTracks[0].name = 'B';
  const branch = structuredClone(initial);
  branch.playlistTracks[0].name = 'C';

  let history = createPlaylistHistory(initial);
  history = history.commit(first, 'A');
  history = history.commit(second, 'B');
  const undone = history.undo(second);
  const branched = undone.history.commit(branch, 'C');

  assert.equal(branched.canRedo, false);
  assert.equal(branched.futureLength, 0);
  assert.equal(branched.document.playlistTracks[0].name, 'C');
});

test('identical playlist state is a no-op', () => {
  const initial = makeState();
  const history = createPlaylistHistory(initial);
  const committed = history.commit(structuredClone(initial), 'No Op');
  assert.strictEqual(committed, history);
});

test('reset starts a fresh playlist history for a loaded project', () => {
  const initial = makeState();
  const edited = structuredClone(initial);
  edited.playlistTracks[0].name = 'Edited';
  let history = createPlaylistHistory(initial).commit(edited, 'Edit');

  const loaded = structuredClone(initial);
  loaded.playlistTracks[0].name = 'Loaded Project';
  history = history.reset(loaded);

  assert.equal(history.document.playlistTracks[0].name, 'Loaded Project');
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
});
