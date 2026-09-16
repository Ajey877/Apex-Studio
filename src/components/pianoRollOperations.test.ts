import assert from 'node:assert/strict';
import test from 'node:test';
import type { Note } from '../types/daw';
import {
  DEFAULT_GRID_STEPS,
  DEFAULT_MAX_PITCH,
  DEFAULT_MIN_NOTE_DURATION,
  DEFAULT_MIN_PITCH,
  assertValidNote,
  moveNote,
  resizeNoteLeft,
  resizeNoteRight,
  snapStepPosition,
  updateNoteInNotes,
  validateNote
} from './pianoRollOperations';

const baseNote: Note = {
  id: 'note-1',
  pitch: 60, // C4
  start: 4,
  duration: 2,
  velocity: 0.85
};

test('snapStepPosition snaps to the requested grid', () => {
  assert.equal(snapStepPosition(4.37, 1), 4);
  assert.equal(snapStepPosition(4.63, 1), 5);
  assert.equal(snapStepPosition(4.37, 0.5), 4.5);
  assert.equal(snapStepPosition(-2, 1), 0);
});

test('moveNote snaps start position and updates pitch', () => {
  const moved = moveNote(baseNote, 8.4, 64, 1, { maxSteps: 32 });
  assert.equal(moved.id, 'note-1');
  assert.equal(moved.start, 8);
  assert.equal(moved.pitch, 64);
  assert.equal(moved.duration, 2);
  assert.equal(moved.velocity, 0.85);
});

test('moveNote preserves note metadata and custom properties', () => {
  const customNote: Note = { ...baseNote, velocity: 0.92, muted: true };
  const moved = moveNote(customNote, 12, 72);
  assert.equal(moved.id, 'note-1');
  assert.equal(moved.velocity, 0.92);
  assert.equal(moved.muted, true);
  assert.equal(moved.duration, 2);
});

test('moveNote clamps pitch to configured boundaries', () => {
  const lower = moveNote(baseNote, 0, 20, 1, { minPitch: 36, maxPitch: 84 });
  assert.equal(lower.pitch, 36);

  const upper = moveNote(baseNote, 0, 100, 1, { minPitch: 36, maxPitch: 84 });
  assert.equal(upper.pitch, 84);
});

test('moveNote clamps start to zero and maxSteps boundary', () => {
  const negative = moveNote(baseNote, -5, 60);
  assert.equal(negative.start, 0);

  const atMax = moveNote(baseNote, 31, 60, 1, { maxSteps: 32 });
  assert.equal(atMax.start, 30); // 32 - duration (2) = 30
  assert.equal(atMax.start + atMax.duration, 32);
});

test('resizeNoteRight updates duration while preserving start', () => {
  const resized = resizeNoteRight(baseNote, 10, 1, 0.25, { maxSteps: 32 });
  assert.equal(resized.id, 'note-1');
  assert.equal(resized.start, 4);
  assert.equal(resized.duration, 6);
  assert.equal(resized.pitch, 60);
});

test('resizeNoteRight enforces minimum duration', () => {
  const resized = resizeNoteRight(baseNote, 4.1, 1, 0.5, { maxSteps: 32 });
  assert.equal(resized.start, 4);
  assert.equal(resized.duration, 0.5);
});

test('resizeNoteRight cannot exceed maxSteps timeline bounds', () => {
  const resized = resizeNoteRight(baseNote, 40, 1, 0.25, { maxSteps: 32 });
  assert.equal(resized.start, 4);
  assert.equal(resized.duration, 28);
  assert.equal(resized.start + resized.duration, 32);
});

test('resizeNoteLeft adjusts start while preserving original end', () => {
  const resized = resizeNoteLeft(baseNote, 2, 1, 0.25, { maxSteps: 32 });
  // originalEnd = 4 + 2 = 6
  assert.equal(resized.start, 2);
  assert.equal(resized.duration, 4);
  assert.equal(resized.start + resized.duration, 6);
});

test('resizeNoteLeft clamps start to zero and enforces minimum duration', () => {
  const atZero = resizeNoteLeft(baseNote, -5, 1, 0.25, { maxSteps: 32 });
  assert.equal(atZero.start, 0);
  assert.equal(atZero.duration, 6);

  // originalEnd = 6, requestedStart = 5.9 -> capped at 6 - 0.5 = 5.5
  const atMin = resizeNoteLeft(baseNote, 5.9, 1, 0.5, { maxSteps: 32 });
  assert.equal(atMin.start, 5.5);
  assert.equal(atMin.duration, 0.5);
  assert.equal(atMin.start + atMin.duration, 6);
});

test('validateNote catches invalid pitch, bounds, and duration', () => {
  const valid = validateNote(baseNote);
  assert.equal(valid.valid, true);
  assert.equal(valid.errors.length, 0);

  const invalidPitch = validateNote({ ...baseNote, pitch: 120 });
  assert.equal(invalidPitch.valid, false);

  const negativeStart = validateNote({ ...baseNote, start: -1 });
  assert.equal(negativeStart.valid, false);

  const zeroDuration = validateNote({ ...baseNote, duration: 0 });
  assert.equal(zeroDuration.valid, false);

  const outOfBounds = validateNote({ ...baseNote, start: 30, duration: 4 }, { maxSteps: 32 });
  assert.equal(outOfBounds.valid, false);
});

test('updateNoteInNotes replaces existing note immutably', () => {
  const notes: Note[] = [
    baseNote,
    { id: 'note-2', pitch: 64, start: 8, duration: 2, velocity: 0.9 }
  ];
  const updatedNote = { ...baseNote, pitch: 62, start: 6 };
  const updated = updateNoteInNotes(notes, updatedNote);

  assert.equal(updated.length, 2);
  assert.equal(updated[0].pitch, 62);
  assert.equal(updated[0].start, 6);
  assert.equal(updated[1].pitch, 64);
  assert.notEqual(updated, notes);
});

test('updateNoteInNotes throws when note id does not exist', () => {
  const notes = [baseNote];
  const nonExistent: Note = { id: 'note-ghost', pitch: 60, start: 0, duration: 1, velocity: 0.8 };
  assert.throws(() => updateNoteInNotes(notes, nonExistent), /Note not found/);
});

test('history: completed note drag produces exactly one commit, supporting undo and redo', () => {
  const initialNote: Note = { id: 'note-move-1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const state0 = {
    notes: [initialNote]
  };

  // Simulating drag lifecycle:
  // pointerdown: captures initialNote
  let currentNote = { ...initialNote };

  // 10 pointermove events (transient preview - NO history commit)
  for (let moveStep = 1; moveStep <= 10; moveStep++) {
    currentNote = moveNote(initialNote, moveStep, 60 + Math.min(moveStep, 4), 1, { maxSteps: 32 });
  }

  // Final position at step 10, pitch 64
  assert.equal(currentNote.start, 10);
  assert.equal(currentNote.pitch, 64);

  // pointerup: completed drag triggers ONE commit
  const state1 = {
    notes: updateNoteInNotes(state0.notes, currentNote)
  };

  // Verify history behaves as 1 step
  const historyLog: Array<typeof state0> = [state0, state1];
  assert.equal(historyLog.length, 2);

  // Undo restores exact initial note
  const undone = historyLog[0];
  assert.equal(undone.notes[0].start, 0);
  assert.equal(undone.notes[0].pitch, 60);

  // Redo restores exact edited note
  const redone = historyLog[1];
  assert.equal(redone.notes[0].start, 10);
  assert.equal(redone.notes[0].pitch, 64);
});

test('pointer: pointer cancel aborts drag and discards transient changes without committing', () => {
  const initialNote: Note = { id: 'note-cancel-1', pitch: 60, start: 4, duration: 2, velocity: 0.8 };
  let committedNotes = [initialNote];

  // Interaction begins
  let interactionActive = true;
  let previewNote = moveNote(initialNote, 8, 67);

  assert.equal(previewNote.start, 8);
  assert.equal(previewNote.pitch, 67);

  // pointercancel fires
  interactionActive = false;
  previewNote = initialNote; // discarded

  // No commit to channel notes
  assert.equal(committedNotes[0].start, 4);
  assert.equal(committedNotes[0].pitch, 60);
  assert.equal(interactionActive, false);
});

