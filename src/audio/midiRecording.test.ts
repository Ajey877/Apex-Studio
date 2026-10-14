/**
 * MIDI performance recording — regression suite.
 *
 * These tests feed known note-on/note-off sequences through the production
 * recording boundary (`MidiPerformanceRecorder`, the same class App wires to
 * the engine's MIDI listener stream) with deterministic transport clocks,
 * and verify the notes that would be committed to the Piano Roll: pitch,
 * velocity, musical start and duration. They fail if captured events are
 * never turned into real channel notes, if a fixed tempo is substituted for
 * the project tempo, or if interrupted takes leave notes open.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MidiPerformanceRecorder,
  appendRecordedNotesToChannelInProjectState,
  transportPositionToSteps,
} from './midiRecording';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { createHistory } from '../state/projectHistory';
import { serializeProjectState } from '../state/projectPersistence';
import type { MidiEventPayload } from './audioEngine';

const TARGET = { channelId: 'ch-1', patternId: 'pat-1', patternLengthSteps: 16, bpm: 120 };

const atSeconds = (seconds: number, bpm = 120): { positionSteps: number } => ({
  positionSteps: transportPositionToSteps(seconds, bpm),
});

const on = (note: number, velocity = 100 / 127, midiChannel = 1): MidiEventPayload => ({
  type: 'noteOn',
  note,
  velocity,
  midiChannel,
});
const off = (note: number, midiChannel = 1): MidiEventPayload => ({
  type: 'noteOff',
  note,
  midiChannel,
});

const makeRecorder = () => {
  let seq = 0;
  return new MidiPerformanceRecorder({ createNoteId: () => `test-note-${seq++}` });
};

test('deterministic capture: pitch, velocity, start and duration from event timestamps', () => {
  const recorder = makeRecorder();
  assert.equal(recorder.start(TARGET, atSeconds(0)), true);
  // At 120 BPM one step (16th) is 0.125 s.
  recorder.handleMidiEvent(on(60, 100 / 127), atSeconds(0.25)); // step 2
  recorder.handleMidiEvent(on(64, 80 / 127), atSeconds(0.5)); // step 4 (overlap)
  recorder.handleMidiEvent(off(60), atSeconds(0.75)); // step 6 -> duration 4
  recorder.handleMidiEvent(off(64), atSeconds(1.0)); // step 8 -> duration 4
  const notes = recorder.stop(atSeconds(1.0));

  assert.deepEqual(
    notes.map(n => ({ pitch: n.pitch, start: n.start, duration: n.duration, velocity: n.velocity })),
    [
      { pitch: 60, start: 2, duration: 4, velocity: 100 / 127 },
      { pitch: 64, start: 4, duration: 4, velocity: 80 / 127 },
    ],
  );
  assert.equal(recorder.isRecording, false);
  assert.equal(recorder.openNoteCount, 0);
});

test('velocity-zero note-on is a note-off', () => {
  const recorder = makeRecorder();
  recorder.start(TARGET, atSeconds(0));
  recorder.handleMidiEvent(on(72, 0.5), atSeconds(0));
  recorder.handleMidiEvent({ type: 'noteOn', note: 72, velocity: 0, midiChannel: 1 }, atSeconds(0.5));
  const notes = recorder.stop(atSeconds(0.5));
  assert.equal(notes.length, 1);
  assert.equal(notes[0].duration, 4);
});

test('channel ownership: same pitch on different MIDI channels is two notes', () => {
  const recorder = makeRecorder();
  recorder.start(TARGET, atSeconds(0));
  recorder.handleMidiEvent(on(60), atSeconds(0, 120)); // ch 1, step 0
  recorder.handleMidiEvent(on(60, 90 / 127, 2), { positionSteps: 1 }); // ch 2, step 1
  recorder.handleMidiEvent(off(60, 2), { positionSteps: 2 }); // closes ch 2 only
  assert.equal(recorder.openNoteCount, 1);
  recorder.handleMidiEvent(off(60, 1), { positionSteps: 4 }); // closes ch 1
  const notes = recorder.stop({ positionSteps: 4 });
  assert.equal(notes.length, 2);
  const byVelocity = [...notes].sort((a, b) => a.duration - b.duration);
  assert.equal(byVelocity[0].duration, 1); // channel 2 gate
  assert.equal(byVelocity[1].duration, 4); // channel 1 gate
});

test('repeated pitch retrigger finalizes the previous gate first', () => {
  const recorder = makeRecorder();
  recorder.start(TARGET, atSeconds(0));
  recorder.handleMidiEvent(on(60), { positionSteps: 0 });
  const result = recorder.handleMidiEvent(on(60), { positionSteps: 2 });
  assert.equal(result.status, 'retriggered');
  recorder.handleMidiEvent(off(60), { positionSteps: 5 });
  const notes = recorder.stop({ positionSteps: 5 });
  assert.deepEqual(
    notes.map(n => [n.start, n.duration]),
    [
      [0, 2],
      [2, 3],
    ],
  );
});

test('timing uses the project tempo, never a fixed substitute', () => {
  // The same one-second performance lands on different steps at 90 vs 180 BPM.
  assert.equal(transportPositionToSteps(1, 90), 6);
  assert.equal(transportPositionToSteps(1, 180), 12);
  assert.equal(transportPositionToSteps(1, 130), 130 / 60 * 4);

  const recorder = makeRecorder();
  recorder.start({ ...TARGET, bpm: 90 }, atSeconds(0, 90));
  recorder.handleMidiEvent(on(60), atSeconds(1, 90)); // step 6 at 90 BPM
  recorder.handleMidiEvent(off(60), atSeconds(1.5, 90)); // step 9
  const notes = recorder.stop(atSeconds(1.5, 90));
  assert.equal(notes[0].start, 6);
  assert.equal(notes[0].duration, 3);
});

test('notes wrap into the pattern and clamp at its end; short taps get the minimum duration', () => {
  const recorder = makeRecorder();
  recorder.start(TARGET, { positionSteps: 0 });
  recorder.handleMidiEvent(on(60), { positionSteps: 14 }); // pattern step 14
  recorder.handleMidiEvent(on(62), { positionSteps: 20 }); // wraps to step 4 in next loop
  const notes = recorder.stop({ positionSteps: 22 });
  const first = notes.find(n => n.pitch === 60)!;
  const second = notes.find(n => n.pitch === 62)!;
  assert.equal(first.start, 14);
  assert.equal(first.duration, 2); // clamped to pattern end, not past step 16
  assert.equal(second.start, 4);
  assert.equal(second.duration, 2);

  const tap = makeRecorder();
  tap.start(TARGET, { positionSteps: 0 });
  tap.handleMidiEvent(on(65), { positionSteps: 3 });
  tap.handleMidiEvent(off(65), { positionSteps: 3.05 }); // shorter than the 0.25-step minimum
  const [tapNote] = tap.stop({ positionSteps: 3.05 });
  assert.equal(tapNote.duration, 0.25);
});

test('lifecycle: stop/disconnect while held finalizes notes; repeated start/stop is safe', () => {
  const recorder = makeRecorder();
  recorder.start(TARGET, { positionSteps: 0 });
  recorder.handleMidiEvent(on(60), { positionSteps: 1 });
  const stopped = recorder.stop({ positionSteps: 5 }); // stop while held
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].duration, 4);
  assert.equal(recorder.openNoteCount, 0);
  assert.deepEqual(recorder.stop({ positionSteps: 6 }), []); // second stop: nothing

  recorder.start(TARGET, { positionSteps: 0 });
  recorder.handleMidiEvent(on(67), { positionSteps: 2 });
  const disconnected = recorder.handleDeviceDisconnect({ positionSteps: 6 });
  assert.equal(disconnected.length, 1);
  assert.equal(disconnected[0].duration, 4);
  assert.equal(recorder.isRecording, false);

  // Starting twice does not retarget the running take.
  recorder.start(TARGET, { positionSteps: 0 });
  assert.equal(recorder.start({ ...TARGET, channelId: 'ch-2' }, { positionSteps: 0 }), false);
  assert.equal(recorder.activeTarget?.channelId, 'ch-1');
  recorder.cancel();
  assert.equal(recorder.isRecording, false);
  assert.deepEqual(recorder.stop({ positionSteps: 1 }), []); // cancelled take yields nothing
});

test('project integration: commit writes real channel notes only to the target channel', () => {
  const state = createDefaultProjectState();
  const targetBefore = state.channels.find(c => c.id === 'ch-1')!;
  const otherBefore = state.channels.find(c => c.id === 'ch-2')!;
  const existing = { id: 'existing', pitch: 50, start: 0, duration: 2, velocity: 0.7 };
  const withExisting = appendRecordedNotesToChannelInProjectState(state, 'ch-1', [existing]);
  assert.equal(withExisting.channels.find(c => c.id === 'ch-1')!.notes.length, 1);

  const recorded = [
    { id: 'rec-1', pitch: 60, start: 2, duration: 4, velocity: 100 / 127 },
    { id: 'rec-2', pitch: 64, start: 4, duration: 4, velocity: 80 / 127 },
  ];
  const next = appendRecordedNotesToChannelInProjectState(withExisting, 'ch-1', recorded);
  const targetAfter = next.channels.find(c => c.id === 'ch-1')!;
  assert.deepEqual(targetAfter.notes.map(n => n.id), ['existing', 'rec-1', 'rec-2']);
  assert.equal(next.channels.find(c => c.id === 'ch-2'), otherBefore, 'unrelated channel untouched');
  assert.notEqual(targetAfter, targetBefore);
  // Patterns are metadata in this model; a take never rewrites them.
  assert.equal(next.patterns, withExisting.patterns);
  // Empty takes / unknown channels produce no state change (no phantom history).
  assert.equal(appendRecordedNotesToChannelInProjectState(next, 'ch-1', []), next);
  assert.equal(appendRecordedNotesToChannelInProjectState(next, 'nope', recorded), next);
});

test('project integration: a committed take is one undoable/redoable history entry and survives save/load', () => {
  const initial = createDefaultProjectState();
  let history = createHistory(initial);
  const committed = appendRecordedNotesToChannelInProjectState(initial, 'ch-1', [
    { id: 'rec-1', pitch: 60, start: 2, duration: 4, velocity: 100 / 127 },
  ]);
  history = history.commit(committed, 'Record MIDI performance');
  assert.equal(history.present.channels.find(c => c.id === 'ch-1')!.notes.length, 1);

  history = history.undo();
  assert.equal(history.present.channels.find(c => c.id === 'ch-1')!.notes.length, 0);
  history = history.redo();
  assert.equal(history.present.channels.find(c => c.id === 'ch-1')!.notes.length, 1);

  const restored = normalizeProjectState(JSON.parse(serializeProjectState(history.present)).state);
  const note = restored.channels.find(c => c.id === 'ch-1')!.notes[0];
  assert.deepEqual(
    { pitch: note.pitch, start: note.start, duration: note.duration, velocity: note.velocity },
    { pitch: 60, start: 2, duration: 4, velocity: 100 / 127 },
  );
});

test('end to end: recorder output committed to the pattern channel is the note set playback reads', () => {
  const recorder = makeRecorder();
  recorder.start(TARGET, atSeconds(0));
  recorder.handleMidiEvent(on(60), atSeconds(0.25));
  recorder.handleMidiEvent(off(60), atSeconds(0.75));
  const notes = recorder.stop(atSeconds(0.75));
  const state = appendRecordedNotesToChannelInProjectState(createDefaultProjectState(), 'ch-1', notes);
  const channel = state.channels.find(c => c.id === 'ch-1')!;
  // Pattern playback and offline export both schedule `channel.notes`; the
  // recorded note must be there, inside the 16-step pattern, with its gate.
  assert.equal(channel.notes.length, 1);
  assert.ok(channel.notes[0].start + channel.notes[0].duration <= TARGET.patternLengthSteps);
});
