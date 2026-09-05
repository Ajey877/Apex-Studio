import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultProjectState } from './projectState';
import {
  DEFAULT_HISTORY_MAX_ENTRIES,
  createHistory,
  sanitizeProjectSnapshot
} from './projectHistory';
import type { ProjectState } from '../types/daw';

const makeState = (value: number): ProjectState => {
  const state = createDefaultProjectState();
  state.meta.name = `Project ${value}`;
  state.meta.updated = value;
  state.channels[0].notes = [{
    id: `note-${value}`,
    pitch: 60 + value,
    start: value,
    duration: 1,
    velocity: 0.8
  }];
  return state;
};

test('initial history is empty', () => {
  const history = createHistory(makeState(0));
  assert.equal(history.past.length, 0);
  assert.equal(history.future.length, 0);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.present.meta.name, 'Project 0');
});

test('commit creates a past entry and updates present', () => {
  const history = createHistory(makeState(0)).commit(makeState(1), 'Change Volume');
  assert.equal(history.past.length, 1);
  assert.equal(history.past[0].label, 'Change Volume');
  assert.equal(history.present.meta.name, 'Project 1');
  assert.equal(history.future.length, 0);
  assert.equal(history.canUndo, true);
});

test('undo restores the previous state', () => {
  const history = createHistory(makeState(0)).commit(makeState(1), 'Edit');
  const undone = history.undo();
  assert.equal(undone.present.meta.name, 'Project 0');
  assert.equal(undone.past.length, 0);
  assert.equal(undone.future.length, 1);
  assert.equal(undone.canRedo, true);
});

test('redo restores the undone state', () => {
  const history = createHistory(makeState(0)).commit(makeState(1), 'Edit');
  const redone = history.undo().redo();
  assert.equal(redone.present.meta.name, 'Project 1');
  assert.equal(redone.past.length, 1);
  assert.equal(redone.future.length, 0);
});

test('multiple undo and redo operations walk history in order', () => {
  let history = createHistory(makeState(0));
  history = history.commit(makeState(1), 'B');
  history = history.commit(makeState(2), 'C');
  history = history.commit(makeState(3), 'D');

  history = history.undo().undo();
  assert.equal(history.present.meta.name, 'Project 1');
  assert.equal(history.future.length, 2);

  history = history.redo().redo();
  assert.equal(history.present.meta.name, 'Project 3');
  assert.equal(history.future.length, 0);
});

test('empty undo and redo are safe no-ops', () => {
  const history = createHistory(makeState(0));
  assert.strictEqual(history.undo(), history);
  assert.strictEqual(history.redo(), history);
});

test('undo followed by a new edit clears redo history', () => {
  let history = createHistory(makeState(0));
  history = history.commit(makeState(1), 'B');
  history = history.commit(makeState(2), 'C');
  history = history.undo();
  history = history.commit(makeState(3), 'D');

  assert.equal(history.present.meta.name, 'Project 3');
  assert.equal(history.future.length, 0);
  assert.equal(history.canRedo, false);
});

test('50-entry limit keeps only the newest history entries', () => {
  let history = createHistory(makeState(0));
  for (let i = 1; i <= DEFAULT_HISTORY_MAX_ENTRIES + 10; i += 1) {
    history = history.commit(makeState(i), `Edit ${i}`);
  }

  assert.equal(history.past.length, DEFAULT_HISTORY_MAX_ENTRIES);
  assert.equal(history.past[0].state.meta.name, 'Project 10');
  assert.equal(history.past.at(-1)?.state.meta.name, 'Project 59');
});

test('oldest entry is discarded only when the limit is exceeded', () => {
  let history = createHistory(makeState(0));
  for (let i = 1; i <= DEFAULT_HISTORY_MAX_ENTRIES; i += 1) {
    history = history.commit(makeState(i), `Edit ${i}`);
  }
  assert.equal(history.past[0].state.meta.name, 'Project 0');

  history = history.commit(makeState(DEFAULT_HISTORY_MAX_ENTRIES + 1), 'Newest');
  assert.equal(history.past[0].state.meta.name, 'Project 1');
});

test('no-op commit ignores object identity and transient updated timestamp', () => {
  const initial = makeState(0);
  const equivalent = structuredClone(initial);
  equivalent.meta.updated = 999999999;
  const history = createHistory(initial);
  const committed = history.commit(equivalent, 'No Op');

  assert.strictEqual(committed, history);
  assert.equal(committed.past.length, 0);
});

test('labels are preserved only in history entries', () => {
  const history = createHistory(makeState(0)).commit(makeState(1), 'Split Clip');
  assert.equal(history.past[0].label, 'Split Clip');
  assert.equal('label' in history.present, false);
  assert.equal(JSON.stringify(history.present).includes('Split Clip'), false);
});

test('reset clears past and future and establishes a new present', () => {
  let history = createHistory(makeState(0));
  history = history.commit(makeState(1), 'B');
  history = history.commit(makeState(2), 'C');
  history = history.undo();
  history = history.reset(makeState(9));

  assert.equal(history.present.meta.name, 'Project 9');
  assert.equal(history.past.length, 0);
  assert.equal(history.future.length, 0);
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
});

test('snapshots are independent from later state mutation', () => {
  const source = makeState(0);
  let history = createHistory(source);
  const next = makeState(1);
  history = history.commit(next, 'Edit');

  next.meta.name = 'Mutated outside history';
  next.channels[0].notes[0].pitch = 120;
  source.meta.name = 'Mutated source';

  assert.equal(history.past[0].state.meta.name, 'Project 0');
  assert.equal(history.present.meta.name, 'Project 1');
  assert.equal(history.present.channels[0].notes[0].pitch, 61);
});

test('binary and session-only fields are removed while audio references remain', () => {
  const state = makeState(0);
  const audioBlob = new Blob(['audio']);
  state.recordings = [{
    id: 'rec-1',
    name: 'Take 1',
    timestamp: 1,
    durationSeconds: 1,
    waveform: [0, 1],
    audioBufferId: 'buffer-1',
    audioBlob,
    audioUrl: 'blob:session-url'
  }];
  state.channels[0].customSample = {
    id: 'sample-1',
    name: 'Sample',
    duration: 1,
    sampleRate: 44100,
    channels: 1,
    waveformPeaks: [0.1],
    blob: audioBlob,
    url: 'blob:sample-url'
  };

  const snapshot = sanitizeProjectSnapshot(state);
  assert.equal(snapshot.recordings[0].audioBufferId, 'buffer-1');
  assert.equal('audioBlob' in snapshot.recordings[0], false);
  assert.equal('audioUrl' in snapshot.recordings[0], false);
  assert.ok(snapshot.channels[0].customSample);
  assert.equal('blob' in snapshot.channels[0].customSample!, false);
  assert.equal('url' in snapshot.channels[0].customSample!, false);
});

test('normalization is applied before a snapshot is stored', () => {
  const state = makeState(0);
  const raw = structuredClone(state) as ProjectState & { extraField?: string };
  raw.extraField = 'not part of the model';
  const snapshot = sanitizeProjectSnapshot(raw);

  assert.equal('extraField' in snapshot, false);
  assert.equal(snapshot.meta.name, state.meta.name);
  assert.equal(snapshot.channels.length, state.channels.length);
});

test('rapid duplicate commits do not grow history', () => {
  let history = createHistory(makeState(0));
  const same = makeState(1);
  history = history.commit(same, 'Edit');
  for (let i = 0; i < 20; i += 1) {
    history = history.commit(structuredClone(same), `Duplicate ${i}`);
  }

  assert.equal(history.past.length, 1);
  assert.equal(history.present.meta.name, 'Project 1');
});

test('recording references remain usable after undo and redo', () => {
  const base = makeState(0);
  const withRecording = structuredClone(base);
  withRecording.recordings = [{
    id: 'rec-1',
    name: 'Take 1',
    timestamp: 1,
    durationSeconds: 2,
    waveform: [0.1, 0.8],
    audioBufferId: 'recording-buffer-1'
  }];
  withRecording.playlistClips = [{
    id: 'clip-1',
    trackIndex: 0,
    startBar: 1,
    lengthBars: 2,
    type: 'audio',
    audioBufferId: 'recording-buffer-1',
    color: '#fff',
    name: 'Take 1'
  }];

  const history = createHistory(base).commit(withRecording, 'Add Recording');
  const undone = history.undo();
  const redone = undone.redo();

  assert.equal(undone.present.recordings.length, 0);
  assert.equal(redone.present.recordings[0].audioBufferId, 'recording-buffer-1');
  assert.equal(redone.present.playlistClips[0].audioBufferId, 'recording-buffer-1');
});
