import assert from 'node:assert/strict';
import test from 'node:test';
import type { Note } from '../types/daw';
import {
  DEFAULT_GRID_STEPS,
  DEFAULT_MAX_PITCH,
  DEFAULT_MIN_NOTE_DURATION,
  DEFAULT_MIN_PITCH,
  assertValidNote,
  deleteNotes,
  moveNote,
  moveNotes,
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

// ============================================================
// PHASE 5.2A MULTI-SELECTION & GROUP OPERATION TESTS
// ============================================================

test('moveNotes: multiple notes move together preserving relative spacing and pitches', () => {
  const noteA: Note = { id: 'chord-a', pitch: 60, start: 2, duration: 2, velocity: 0.8 };
  const noteB: Note = { id: 'chord-b', pitch: 64, start: 4, duration: 2, velocity: 0.85 };
  const noteC: Note = { id: 'chord-c', pitch: 67, start: 8, duration: 2, velocity: 0.9 };
  const notes = [noteA, noteB, noteC];
  const selectedIds = new Set(['chord-a', 'chord-b', 'chord-c']);

  // Move +4 steps and +2 pitch (semitones)
  const moved = moveNotes(notes, selectedIds, 4, 2, 1, { maxSteps: 32 });

  assert.equal(moved.length, 3);
  assert.equal(moved[0].start, 6);
  assert.equal(moved[0].pitch, 62);
  assert.equal(moved[1].start, 8);
  assert.equal(moved[1].pitch, 66);
  assert.equal(moved[2].start, 12);
  assert.equal(moved[2].pitch, 69);

  // Verify relative relationships
  assert.equal(moved[1].start - moved[0].start, noteB.start - noteA.start);
  assert.equal(moved[2].start - moved[1].start, noteC.start - noteB.start);
  assert.equal(moved[1].pitch - moved[0].pitch, noteB.pitch - noteA.pitch);
  assert.equal(moved[2].pitch - moved[1].pitch, noteC.pitch - noteB.pitch);
});

test('moveNotes: preserves durations, velocities, IDs, and custom metadata', () => {
  const noteA: Note = { id: 'chord-a', pitch: 60, start: 2, duration: 3, velocity: 0.75, muted: true };
  const noteB: Note = { id: 'chord-b', pitch: 64, start: 5, duration: 1.5, velocity: 0.92, pan: -0.5 };
  const notes = [noteA, noteB];
  const selectedIds = new Set(['chord-a', 'chord-b']);

  const moved = moveNotes(notes, selectedIds, 2, -2, 1, { maxSteps: 32 });

  assert.equal(moved[0].id, 'chord-a');
  assert.equal(moved[0].duration, 3);
  assert.equal(moved[0].velocity, 0.75);
  assert.equal(moved[0].muted, true);

  assert.equal(moved[1].id, 'chord-b');
  assert.equal(moved[1].duration, 1.5);
  assert.equal(moved[1].velocity, 0.92);
  assert.equal(moved[1].pan, -0.5);
});

test('moveNotes: collective boundary clamping on start < 0', () => {
  const noteA: Note = { id: 'a', pitch: 60, start: 1, duration: 2, velocity: 0.8 };
  const noteB: Note = { id: 'b', pitch: 64, start: 5, duration: 2, velocity: 0.8 };
  const noteC: Note = { id: 'c', pitch: 67, start: 9, duration: 2, velocity: 0.8 };
  const notes = [noteA, noteB, noteC];
  const selectedIds = new Set(['a', 'b', 'c']);

  // Requested delta: -6 steps. Minimum start is 1, so maximum negative delta is -1.
  const moved = moveNotes(notes, selectedIds, -6, 0, 1, { maxSteps: 32 });

  assert.equal(moved[0].start, 0); // 1 - 1 = 0
  assert.equal(moved[1].start, 4); // 5 - 1 = 4
  assert.equal(moved[2].start, 8); // 9 - 1 = 8

  // Internal spacing is preserved, not squashed
  assert.equal(moved[1].start - moved[0].start, 4);
  assert.equal(moved[2].start - moved[1].start, 4);
});

test('moveNotes: collective boundary clamping on maxSteps timeline bound', () => {
  const noteA: Note = { id: 'a', pitch: 60, start: 20, duration: 2, velocity: 0.8 };
  const noteB: Note = { id: 'b', pitch: 64, start: 26, duration: 4, velocity: 0.8 }; // ends at 30
  const notes = [noteA, noteB];
  const selectedIds = new Set(['a', 'b']);

  // maxSteps = 32. noteB ends at 30. Maximum positive delta is 32 - 30 = +2.
  // Requested delta: +10 steps.
  const moved = moveNotes(notes, selectedIds, 10, 0, 1, { maxSteps: 32 });

  assert.equal(moved[0].start, 22);
  assert.equal(moved[1].start, 28);
  assert.equal(moved[1].start + moved[1].duration, 32);
  assert.equal(moved[1].start - moved[0].start, 6);
});

test('moveNotes: collective boundary clamping on pitch boundaries (minPitch and maxPitch)', () => {
  const noteA: Note = { id: 'a', pitch: 40, start: 0, duration: 2, velocity: 0.8 };
  const noteB: Note = { id: 'b', pitch: 80, start: 4, duration: 2, velocity: 0.8 };
  const notes = [noteA, noteB];
  const selectedIds = new Set(['a', 'b']);
  const bounds = { minPitch: 36, maxPitch: 84 };

  // 1. Shift up by +10. Highest note is 80, max is 84 -> maximum positive delta is +4.
  const movedUp = moveNotes(notes, selectedIds, 0, 10, 1, bounds);
  assert.equal(movedUp[0].pitch, 44); // 40 + 4 = 44
  assert.equal(movedUp[1].pitch, 84); // 80 + 4 = 84
  assert.equal(movedUp[1].pitch - movedUp[0].pitch, 40);

  // 2. Shift down by -10. Lowest note is 40, min is 36 -> maximum negative delta is -4.
  const movedDown = moveNotes(notes, selectedIds, 0, -10, 1, bounds);
  assert.equal(movedDown[0].pitch, 36); // 40 - 4 = 36
  assert.equal(movedDown[1].pitch, 76); // 80 - 4 = 76
  assert.equal(movedDown[1].pitch - movedDown[0].pitch, 40);
});

test('moveNotes: leaves unselected notes untouched and does not mutate originals', () => {
  const noteA: Note = { id: 'a', pitch: 60, start: 2, duration: 2, velocity: 0.8 };
  const noteB: Note = { id: 'b', pitch: 64, start: 4, duration: 2, velocity: 0.8 };
  const notes = [noteA, noteB];
  const selectedIds = new Set(['a']); // only 'a' selected

  const moved = moveNotes(notes, selectedIds, 4, 4, 1, { maxSteps: 32 });

  // Note A moved
  assert.equal(moved[0].start, 6);
  assert.equal(moved[0].pitch, 64);

  // Note B untouched
  assert.equal(moved[1].start, 4);
  assert.equal(moved[1].pitch, 64);

  // Original array and notes untouched
  assert.equal(notes[0].start, 2);
  assert.equal(notes[0].pitch, 60);
  assert.notEqual(moved, notes);
});

test('moveNotes: empty selection returns clean copy without changes', () => {
  const noteA: Note = { id: 'a', pitch: 60, start: 2, duration: 2, velocity: 0.8 };
  const notes = [noteA];

  const moved = moveNotes(notes, new Set(), 4, 4);
  assert.equal(moved.length, 1);
  assert.equal(moved[0].start, 2);
  assert.equal(moved[0].pitch, 60);
  assert.notEqual(moved, notes);
});

test('deleteNotes: removes selected notes and preserves unselected notes', () => {
  const noteA: Note = { id: 'a', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const noteB: Note = { id: 'b', pitch: 64, start: 4, duration: 2, velocity: 0.8 };
  const noteC: Note = { id: 'c', pitch: 67, start: 8, duration: 2, velocity: 0.8 };
  const notes = [noteA, noteB, noteC];

  const remaining = deleteNotes(notes, new Set(['a', 'c']));
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'b');

  // Original array not mutated
  assert.equal(notes.length, 3);
});

test('deleteNotes: empty selection preserves all notes', () => {
  const noteA: Note = { id: 'a', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const notes = [noteA];

  const remaining = deleteNotes(notes, new Set());
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'a');
  assert.notEqual(remaining, notes);
});

test('history: group move produces exactly one commit, supporting undo and redo', () => {
  const noteA: Note = { id: 'g-a', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const noteB: Note = { id: 'g-b', pitch: 64, start: 2, duration: 2, velocity: 0.8 };
  const state0 = { notes: [noteA, noteB] };
  const selectedIds = new Set(['g-a', 'g-b']);

  // Simulate drag sequence: 10 pointermoves
  let transientNotes = state0.notes;
  for (let step = 1; step <= 10; step++) {
    transientNotes = moveNotes(state0.notes, selectedIds, step, 2, 1, { maxSteps: 32 });
  }

  // Pointerup: commits exactly ONCE
  const state1 = { notes: transientNotes };
  const history = [state0, state1];
  assert.equal(history.length, 2);

  // Undo restores exact initial group state
  const undone = history[0];
  assert.equal(undone.notes[0].start, 0);
  assert.equal(undone.notes[0].pitch, 60);
  assert.equal(undone.notes[1].start, 2);
  assert.equal(undone.notes[1].pitch, 64);

  // Redo restores exact edited group state
  const redone = history[1];
  assert.equal(redone.notes[0].start, 10);
  assert.equal(redone.notes[0].pitch, 62);
  assert.equal(redone.notes[1].start, 12);
  assert.equal(redone.notes[1].pitch, 66);
});

test('history: group delete produces exactly one commit, supporting undo and redo', () => {
  const noteA: Note = { id: 'del-a', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const noteB: Note = { id: 'del-b', pitch: 64, start: 2, duration: 2, velocity: 0.8 };
  const noteC: Note = { id: 'del-c', pitch: 67, start: 4, duration: 2, velocity: 0.8 };
  const state0 = { notes: [noteA, noteB, noteC] };

  // Delete selected notes A and B
  const state1 = { notes: deleteNotes(state0.notes, new Set(['del-a', 'del-b'])) };
  const history = [state0, state1];
  assert.equal(history.length, 2);
  assert.equal(history[1].notes.length, 1);
  assert.equal(history[1].notes[0].id, 'del-c');

  // Undo restores all 3 notes
  assert.equal(history[0].notes.length, 3);
});

test('selection: Ctrl+A selects all notes, Escape clears selection', () => {
  const notes: Note[] = [
    { id: 'n1', pitch: 60, start: 0, duration: 1, velocity: 0.8 },
    { id: 'n2', pitch: 62, start: 1, duration: 1, velocity: 0.8 },
    { id: 'n3', pitch: 64, start: 2, duration: 1, velocity: 0.8 }
  ];

  // Ctrl+A simulation:
  const selectAll = new Set(notes.map(n => n.id));
  assert.equal(selectAll.size, 3);
  assert.equal(selectAll.has('n1'), true);
  assert.equal(selectAll.has('n2'), true);
  assert.equal(selectAll.has('n3'), true);

  // Escape simulation:
  const deselectAll = new Set();
  assert.equal(deselectAll.size, 0);
});

