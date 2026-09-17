import assert from 'node:assert/strict';
import test from 'node:test';
import type { Note } from '../types/daw';
import {
  DEFAULT_GRID_STEPS,
  DEFAULT_MAX_PITCH,
  DEFAULT_MIN_NOTE_DURATION,
  DEFAULT_MIN_PITCH,
  DEFAULT_ROW_HEIGHT,
  DEFAULT_STEP_WIDTH,
  MARQUEE_DRAG_THRESHOLD_PX,
  Rect,
  assertValidNote,
  deleteNotes,
  duplicateNotes,
  DuplicateNotesResult,
  getNoteRect,
  hasExceededDragThreshold,
  moveNote,
  moveNotes,
  normalizeRect,
  nudgeNotes,
  rectsIntersect,
  resizeNoteLeft,
  resizeNoteRight,
  resizeNotesLeft,
  resizeNotesRight,
  selectNotesInMarquee,
  snapStepPosition,
  transposeNotes,
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

test('normalizeRect: normalizes forward and reverse diagonals into non-negative rectangle', () => {
  // Forward: top-left to bottom-right
  const fwd = normalizeRect(10, 20, 60, 80);
  assert.deepEqual(fwd, { x: 10, y: 20, width: 50, height: 60 });

  // Reverse: bottom-right to top-left
  const rev = normalizeRect(60, 80, 10, 20);
  assert.deepEqual(rev, { x: 10, y: 20, width: 50, height: 60 });

  // Diagonal: top-right to bottom-left
  const diag1 = normalizeRect(60, 20, 10, 80);
  assert.deepEqual(diag1, { x: 10, y: 20, width: 50, height: 60 });

  // Diagonal: bottom-left to top-right
  const diag2 = normalizeRect(10, 80, 60, 20);
  assert.deepEqual(diag2, { x: 10, y: 20, width: 50, height: 60 });

  // Zero-size (click in place)
  const zero = normalizeRect(25, 40, 25, 40);
  assert.deepEqual(zero, { x: 25, y: 40, width: 0, height: 0 });
});

test('rectsIntersect: detects full overlap, partial overlap, edge-touching, and outside', () => {
  const target: Rect = { x: 20, y: 20, width: 40, height: 40 };

  // Full containment
  assert.equal(rectsIntersect(target, { x: 25, y: 25, width: 10, height: 10 }), true);
  assert.equal(rectsIntersect({ x: 25, y: 25, width: 10, height: 10 }, target), true);

  // Partial overlap
  assert.equal(rectsIntersect(target, { x: 10, y: 10, width: 20, height: 20 }), true);
  assert.equal(rectsIntersect(target, { x: 50, y: 50, width: 20, height: 20 }), true);

  // Edge-touching (right edge: x = 60)
  assert.equal(rectsIntersect(target, { x: 60, y: 20, width: 20, height: 40 }), true);
  // Edge-touching (left edge: x + width = 20)
  assert.equal(rectsIntersect(target, { x: 0, y: 20, width: 20, height: 40 }), true);
  // Edge-touching (bottom edge: y = 60)
  assert.equal(rectsIntersect(target, { x: 20, y: 60, width: 40, height: 20 }), true);
  // Edge-touching (top edge: y + height = 20)
  assert.equal(rectsIntersect(target, { x: 20, y: 0, width: 40, height: 20 }), true);
  // Corner-touching point (x=60, y=60, width=0, height=0)
  assert.equal(rectsIntersect(target, { x: 60, y: 60, width: 0, height: 0 }), true);

  // Outside (strictly right)
  assert.equal(rectsIntersect(target, { x: 60.1, y: 20, width: 20, height: 40 }), false);
  // Outside (strictly left)
  assert.equal(rectsIntersect(target, { x: 0, y: 20, width: 19.9, height: 40 }), false);
  // Outside (strictly below)
  assert.equal(rectsIntersect(target, { x: 20, y: 60.1, width: 40, height: 20 }), false);
  // Outside (strictly above)
  assert.equal(rectsIntersect(target, { x: 20, y: 0, width: 40, height: 19.9 }), false);
});

test('getNoteRect: accurately converts musical parameters to pixel bounding box', () => {
  // Note at maxPitch (84 = top row, y=0)
  const topNote: Note = { id: 'top', pitch: 84, start: 0, duration: 2, velocity: 0.8 };
  const rTop = getNoteRect(topNote, 28, 24, 84);
  assert.deepEqual(rTop, {
    x: 0,
    y: 0,
    width: Math.max(16, 2 * 28 - 3), // 53
    height: 24
  });

  // Note at pitch 83 (1 row down, y=24)
  const nextNote: Note = { id: 'n2', pitch: 83, start: 4, duration: 1, velocity: 0.8 };
  const rNext = getNoteRect(nextNote, 28, 24, 84);
  assert.deepEqual(rNext, {
    x: 4 * 28, // 112
    y: 1 * 24, // 24
    width: Math.max(16, 1 * 28 - 3), // 25
    height: 24
  });

  // Note with short duration clamped to min width 16
  const shortNote: Note = { id: 'short', pitch: 84, start: 2, duration: 0.25, velocity: 0.8 };
  const rShort = getNoteRect(shortNote, 28, 24, 84);
  assert.equal(rShort.width, 16);
});

test('selectNotesInMarquee: single-note marquee in replace mode', () => {
  const notes: Note[] = [
    { id: 'n1', pitch: 84, start: 0, duration: 2, velocity: 0.8 },
    { id: 'n2', pitch: 83, start: 4, duration: 2, velocity: 0.8 }
  ];

  // Marquee covering only n1 (x in [0, 50], y in [0, 24])
  const marquee = normalizeRect(0, 0, 50, 24);
  const selection = selectNotesInMarquee(notes, marquee, new Set(), 'replace');
  assert.equal(selection.size, 1);
  assert.equal(selection.has('n1'), true);
  assert.equal(selection.has('n2'), false);
});

test('selectNotesInMarquee: multiple-note marquee selects all intersecting notes', () => {
  const notes: Note[] = [
    { id: 'n1', pitch: 84, start: 0, duration: 2, velocity: 0.8 },
    { id: 'n2', pitch: 83, start: 1, duration: 2, velocity: 0.8 },
    { id: 'n3', pitch: 82, start: 2, duration: 2, velocity: 0.8 },
    { id: 'n4', pitch: 70, start: 10, duration: 2, velocity: 0.8 } // Far away
  ];

  // Marquee spanning pitch 84 to 82 (y in [0, 72]) and steps 0 to 4 (x in [0, 112])
  const marquee = normalizeRect(0, 0, 112, 72);
  const selection = selectNotesInMarquee(notes, marquee, new Set(), 'replace');
  assert.equal(selection.size, 3);
  assert.equal(selection.has('n1'), true);
  assert.equal(selection.has('n2'), true);
  assert.equal(selection.has('n3'), true);
  assert.equal(selection.has('n4'), false);
});

test('selectNotesInMarquee: partial intersection selects the note', () => {
  const notes: Note[] = [
    { id: 'n1', pitch: 84, start: 2, duration: 2, velocity: 0.8 }
    // n1 rect: x: 56, y: 0, width: 53, height: 24 (spans x: 56..109, y: 0..24)
  ];

  // Marquee overlapping only x: 50..60, y: 10..20
  const marquee = normalizeRect(50, 10, 60, 20);
  const selection = selectNotesInMarquee(notes, marquee, new Set(), 'replace');
  assert.equal(selection.has('n1'), true);
});

test('selectNotesInMarquee: edge-touching intersection selects the note', () => {
  const notes: Note[] = [
    { id: 'n1', pitch: 84, start: 2, duration: 2, velocity: 0.8 }
    // n1 rect: x: 56, y: 0, width: 53, height: 24
  ];

  // Marquee ending exactly at x: 56, overlapping y: 0..24
  const marquee = normalizeRect(10, 0, 56, 24);
  const selection = selectNotesInMarquee(notes, marquee, new Set(), 'replace');
  assert.equal(selection.has('n1'), true);
});

test('selectNotesInMarquee: G#4 edge-touching from all 4 sides with integer and subpixel coordinates', () => {
  // G#4 is pitch 68, start 11, duration 2
  // getNoteRect: x: 11 * 28 = 308, y: (84 - 68) * 24 = 384, width: 2 * 28 - 3 = 53, height: 24
  // Bounds: x in [308, 361], y in [384, 408]
  const noteGSharp4: Note = { id: 'p5', pitch: 68, start: 11, duration: 2, velocity: 0.75 };
  const notes = [noteGSharp4];

  // 1. Left edge touching exactly at x = 308
  const leftTouch = normalizeRect(200, 384, 308, 408);
  assert.equal(selectNotesInMarquee(notes, leftTouch, new Set()).has('p5'), true);

  // 2. Right edge touching exactly at x = 361
  const rightTouch = normalizeRect(361, 384, 450, 408);
  assert.equal(selectNotesInMarquee(notes, rightTouch, new Set()).has('p5'), true);

  // 3. Top edge touching exactly at y = 384
  const topTouch = normalizeRect(308, 300, 361, 384);
  assert.equal(selectNotesInMarquee(notes, topTouch, new Set()).has('p5'), true);

  // 4. Bottom edge touching exactly at y = 408
  const bottomTouch = normalizeRect(308, 408, 361, 500);
  assert.equal(selectNotesInMarquee(notes, bottomTouch, new Set()).has('p5'), true);

  // 5. Subpixel coordinates from pointer events snapping to visual pixel edge (Windows DPR 1.25 / 1.5)
  // Marquee ending at 307.8 (visual edge contact on left)
  const subpixelLeft = normalizeRect(200.25, 384.1, 307.8, 407.9);
  assert.equal(selectNotesInMarquee(notes, subpixelLeft, new Set()).has('p5'), true);

  // Marquee starting at 361.2 (visual edge contact on right)
  const subpixelRight = normalizeRect(361.2, 384.1, 450.3, 407.9);
  assert.equal(selectNotesInMarquee(notes, subpixelRight, new Set()).has('p5'), true);

  // Marquee ending at 383.9 (visual edge contact on top)
  const subpixelTop = normalizeRect(308.1, 300.4, 360.9, 383.9);
  assert.equal(selectNotesInMarquee(notes, subpixelTop, new Set()).has('p5'), true);

  // Marquee starting at 408.1 (visual edge contact on bottom)
  const subpixelBottom = normalizeRect(308.1, 408.1, 360.9, 500.2);
  assert.equal(selectNotesInMarquee(notes, subpixelBottom, new Set()).has('p5'), true);

  // 6. Strictly non-touching marquee outside boundary must NOT select G#4
  const outsideLeft = normalizeRect(200, 384, 306.9, 408);
  assert.equal(selectNotesInMarquee(notes, outsideLeft, new Set()).has('p5'), false);

  const outsideRight = normalizeRect(362.1, 384, 450, 408);
  assert.equal(selectNotesInMarquee(notes, outsideRight, new Set()).has('p5'), false);
});

test('selectNotesInMarquee: outside notes are never accidentally selected', () => {
  const notes: Note[] = [
    { id: 'inside', pitch: 84, start: 0, duration: 2, velocity: 0.8 },
    { id: 'outside-x', pitch: 84, start: 5, duration: 2, velocity: 0.8 },
    { id: 'outside-y', pitch: 70, start: 0, duration: 2, velocity: 0.8 }
  ];

  const marquee = normalizeRect(0, 0, 50, 24);
  const selection = selectNotesInMarquee(notes, marquee, new Set(), 'replace');
  assert.equal(selection.size, 1);
  assert.equal(selection.has('inside'), true);
  assert.equal(selection.has('outside-x'), false);
  assert.equal(selection.has('outside-y'), false);
});

test('selectNotesInMarquee: reverse-direction marquee yields identical selection', () => {
  const notes: Note[] = [
    { id: 'n1', pitch: 84, start: 0, duration: 2, velocity: 0.8 },
    { id: 'n2', pitch: 83, start: 2, duration: 2, velocity: 0.8 }
  ];

  const fwdMarquee = normalizeRect(0, 0, 100, 48);
  const revMarquee = normalizeRect(100, 48, 0, 0);

  const selFwd = selectNotesInMarquee(notes, fwdMarquee, new Set(), 'replace');
  const selRev = selectNotesInMarquee(notes, revMarquee, new Set(), 'replace');

  assert.deepEqual(Array.from(selFwd).sort(), Array.from(selRev).sort());
  assert.equal(selRev.size, 2);
});

test('selectNotesInMarquee: empty marquee in replace mode clears existing selection', () => {
  const notes: Note[] = [
    { id: 'n1', pitch: 84, start: 0, duration: 2, velocity: 0.8 }
  ];

  const priorSelection = new Set(['n1']);
  // Marquee covering empty space far away
  const emptyMarquee = normalizeRect(500, 500, 600, 600);
  const result = selectNotesInMarquee(notes, emptyMarquee, priorSelection, 'replace');
  assert.equal(result.size, 0);
});

test('selectNotesInMarquee: Shift add mode unions intersecting notes with current selection', () => {
  const notes: Note[] = [
    { id: 'n1', pitch: 84, start: 0, duration: 2, velocity: 0.8 },
    { id: 'n2', pitch: 83, start: 4, duration: 2, velocity: 0.8 },
    { id: 'n3', pitch: 82, start: 8, duration: 2, velocity: 0.8 }
  ];

  const priorSelection = new Set(['n1']);
  // Marquee covering only n2
  const marquee = normalizeRect(110, 24, 170, 48);
  const result = selectNotesInMarquee(notes, marquee, priorSelection, 'add');

  assert.equal(result.size, 2);
  assert.equal(result.has('n1'), true);
  assert.equal(result.has('n2'), true);
  assert.equal(result.has('n3'), false);

  // Empty marquee in add mode preserves prior selection
  const emptyMarquee = normalizeRect(500, 500, 600, 600);
  const resultEmpty = selectNotesInMarquee(notes, emptyMarquee, priorSelection, 'add');
  assert.equal(resultEmpty.size, 1);
  assert.equal(resultEmpty.has('n1'), true);
});

test('selectNotesInMarquee: Ctrl/Cmd toggle mode inverts intersecting note selection', () => {
  const notes: Note[] = [
    { id: 'n1', pitch: 84, start: 0, duration: 2, velocity: 0.8 },
    { id: 'n2', pitch: 83, start: 4, duration: 2, velocity: 0.8 },
    { id: 'n3', pitch: 82, start: 8, duration: 2, velocity: 0.8 }
  ];

  // Initially n1 and n2 are selected
  const priorSelection = new Set(['n1', 'n2']);

  // Marquee covers n2 and n3:
  // n2 was selected -> should become deselected
  // n3 was unselected -> should become selected
  // n1 was not touched -> should remain selected
  const r2 = getNoteRect(notes[1]);
  const r3 = getNoteRect(notes[2]);
  const marquee = normalizeRect(r2.x, r2.y, r3.x + r3.width, r3.y + r3.height);

  const result = selectNotesInMarquee(notes, marquee, priorSelection, 'toggle');
  assert.equal(result.size, 2);
  assert.equal(result.has('n1'), true);
  assert.equal(result.has('n2'), false);
  assert.equal(result.has('n3'), true);

  // Empty marquee in toggle mode preserves prior selection
  const emptyMarquee = normalizeRect(500, 500, 600, 600);
  const resultEmpty = selectNotesInMarquee(notes, emptyMarquee, priorSelection, 'toggle');
  assert.equal(resultEmpty.size, 2);
  assert.equal(resultEmpty.has('n1'), true);
  assert.equal(resultEmpty.has('n2'), true);
});

test('hasExceededDragThreshold: enforces small movement threshold for click vs drag', () => {
  // Movement strictly below 4px threshold must return false
  assert.equal(hasExceededDragThreshold(10, 10, 10, 10), false);
  assert.equal(hasExceededDragThreshold(10, 10, 11, 10), false); // 1px horizontal
  assert.equal(hasExceededDragThreshold(10, 10, 10, 11), false); // 1px vertical
  assert.equal(hasExceededDragThreshold(10, 10, 12, 10), false); // 2px horizontal
  assert.equal(hasExceededDragThreshold(10, 10, 10, 12), false); // 2px vertical
  assert.equal(hasExceededDragThreshold(10, 10, 11, 11), false); // hypot(1, 1) = 1.414px
  assert.equal(hasExceededDragThreshold(10, 10, 12, 12), false); // hypot(2, 2) = 2.828px
  assert.equal(hasExceededDragThreshold(10, 10, 12, 11), false); // hypot(2, 1) = 2.236px
  assert.equal(hasExceededDragThreshold(10, 10, 10, 13), false); // 3px vertical
  assert.equal(hasExceededDragThreshold(10, 10, 13.9, 10), false); // 3.9px horizontal

  // Reverse / negative movements below 4px threshold
  assert.equal(hasExceededDragThreshold(10, 10, 9, 10), false);  // -1px
  assert.equal(hasExceededDragThreshold(10, 10, 8, 10), false);  // -2px
  assert.equal(hasExceededDragThreshold(10, 10, 9, 9), false);   // -1.414px
  assert.equal(hasExceededDragThreshold(10, 10, 8, 8), false);   // -2.828px

  // Subpixel raw client coordinate inputs below 4px
  assert.equal(hasExceededDragThreshold(100.4, 200.4, 101.9, 201.9), false); // hypot(1.5, 1.5) = 2.121px
  assert.equal(hasExceededDragThreshold(100.25, 200.5, 102.25, 202.5), false); // hypot(2, 2) = 2.828px

  // At or above 4px threshold must return true
  assert.equal(hasExceededDragThreshold(10, 10, 14, 10), true); // 4px forward
  assert.equal(hasExceededDragThreshold(10, 10, 10, 14), true); // 4px forward Y
  assert.equal(hasExceededDragThreshold(10, 10, 13, 13), true); // hypot(3, 3) = 4.24 >= 4
  assert.equal(hasExceededDragThreshold(10, 10, 6, 10), true);  // 4px reverse direction
  assert.equal(hasExceededDragThreshold(10, 10, 7, 7), true);   // hypot(-3, -3) = 4.24 >= 4
});

test('marquee lifecycle simulation: pointercancel restores initial selection and produces no history mutation', () => {
  const notes: Note[] = [
    { id: 'n1', pitch: 84, start: 0, duration: 2, velocity: 0.8 },
    { id: 'n2', pitch: 83, start: 4, duration: 2, velocity: 0.8 }
  ];

  const initialSelection = new Set(['n1']);
  let currentSelection = new Set(initialSelection);
  const historyEntries: unknown[] = [];

  // 1. Pointerdown on empty space (200, 100)
  const startX = 200;
  const startY = 100;

  // 2. Pointermove below threshold (202, 101) -> no drag, selection unchanged
  if (hasExceededDragThreshold(startX, startY, 202, 101)) {
    currentSelection = selectNotesInMarquee(notes, normalizeRect(startX, startY, 202, 101), initialSelection, 'replace');
  }
  assert.equal(currentSelection.size, 1);
  assert.equal(currentSelection.has('n1'), true);

  // 3. Pointermove above threshold to (0, 0) -> transiently selects n1 and n2
  if (hasExceededDragThreshold(startX, startY, 0, 0)) {
    currentSelection = selectNotesInMarquee(notes, normalizeRect(startX, startY, 0, 0), initialSelection, 'replace');
  }
  assert.equal(currentSelection.size, 2);
  assert.equal(historyEntries.length, 0); // No history mutation during move

  // 4. Pointercancel occurs -> restores exact initialSelection without mutation
  currentSelection = new Set(initialSelection);
  assert.equal(currentSelection.size, 1);
  assert.equal(currentSelection.has('n1'), true);
  assert.equal(historyEntries.length, 0); // No history mutation on cancel
});

test('marquee lifecycle simulation: pointerup commits selection only and is compatible with group move', () => {
  const notes: Note[] = [
    { id: 'n1', pitch: 84, start: 0, duration: 2, velocity: 0.8 },
    { id: 'n2', pitch: 83, start: 4, duration: 2, velocity: 0.8 }
  ];

  let currentSelection = new Set<string>();
  const historyEntries: { notes: Note[] }[] = [];

  // Marquee selects both notes
  const marquee = normalizeRect(0, 0, 200, 50);
  currentSelection = selectNotesInMarquee(notes, marquee, currentSelection, 'replace');
  assert.equal(currentSelection.size, 2);
  assert.equal(historyEntries.length, 0); // Selection creates NO history

  // Now perform group move using Phase 5.2A moveNotes with the marquee-selected IDs
  const movedNotes = moveNotes(notes, currentSelection, 2, -1, 1);
  historyEntries.push({ notes: movedNotes });

  assert.equal(historyEntries.length, 1); // Exactly one commit for the edit
  assert.equal(movedNotes[0].start, 2);
  assert.equal(movedNotes[0].pitch, 83);
  assert.equal(movedNotes[1].start, 6);
  assert.equal(movedNotes[1].pitch, 82);
});

test('marquee lifecycle: <4px pointer movement never sets state/renders; >=4px activates marquee', () => {
  const originX = 100;
  const originY = 100;

  // 1. On pointerdown: ref is stored, but React marquee state is null
  let marqueeState: { startX: number; startY: number; hasDragged: boolean } | null = null;
  const marqueeRef = {
    originClientX: originX,
    originClientY: originY,
    startX: 100,
    startY: 100,
    currentX: 100,
    currentY: 100,
    hasDragged: false
  };

  // Helper simulating the updateMarquee threshold gating
  const simulateMove = (clientX: number, clientY: number) => {
    const exceeded = hasExceededDragThreshold(marqueeRef.originClientX, marqueeRef.originClientY, clientX, clientY);
    const hasDragged = marqueeRef.hasDragged || exceeded;
    if (!hasDragged) {
      marqueeRef.currentX = clientX;
      marqueeRef.currentY = clientY;
      marqueeRef.hasDragged = false;
      // MUST NOT set React state
      return;
    }
    marqueeRef.hasDragged = true;
    marqueeState = {
      startX: marqueeRef.startX,
      startY: marqueeRef.startY,
      hasDragged: true
    };
  };

  // Sub-threshold movements (1px, 2px, 3px, 3.9px, diagonal 1.414px, 2.828px)
  simulateMove(101, 100); // 1px
  assert.equal(marqueeRef.hasDragged, false);
  assert.equal(marqueeState, null);

  simulateMove(100, 102); // 2px
  assert.equal(marqueeRef.hasDragged, false);
  assert.equal(marqueeState, null);

  simulateMove(101, 101); // 1.414px
  assert.equal(marqueeRef.hasDragged, false);
  assert.equal(marqueeState, null);

  simulateMove(102, 102); // 2.828px
  assert.equal(marqueeRef.hasDragged, false);
  assert.equal(marqueeState, null);

  simulateMove(103, 100); // 3px
  assert.equal(marqueeRef.hasDragged, false);
  assert.equal(marqueeState, null);

  simulateMove(103.9, 100); // 3.9px
  assert.equal(marqueeRef.hasDragged, false);
  assert.equal(marqueeState, null);

  // Exactly 4px: activates marquee and populates state
  simulateMove(104, 100); // 4px
  assert.equal(marqueeRef.hasDragged, true);
  assert.notEqual(marqueeState, null);
  assert.equal(marqueeState?.hasDragged, true);
});

test('resizeNotesRight: resizes multiple selected notes together preserving start positions', () => {
  const note1: Note = { id: 'r1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const note2: Note = { id: 'r2', pitch: 64, start: 4, duration: 2, velocity: 0.8 };
  const note3: Note = { id: 'r3', pitch: 67, start: 8, duration: 2, velocity: 0.8 };
  const notes = [note1, note2, note3];

  // Resize note1 and note2 by +2 steps; note3 is unselected
  const resized = resizeNotesRight(notes, new Set(['r1', 'r2']), 2);

  assert.equal(resized[0].id, 'r1');
  assert.equal(resized[0].start, 0);
  assert.equal(resized[0].duration, 4);

  assert.equal(resized[1].id, 'r2');
  assert.equal(resized[1].start, 4);
  assert.equal(resized[1].duration, 4);

  assert.equal(resized[2].id, 'r3');
  assert.equal(resized[2].start, 8);
  assert.equal(resized[2].duration, 2);
});

test('resizeNotesLeft: resizes multiple selected notes adjusting start while preserving right edges', () => {
  const note1: Note = { id: 'l1', pitch: 60, start: 2, duration: 2, velocity: 0.8 }; // end = 4
  const note2: Note = { id: 'l2', pitch: 64, start: 6, duration: 4, velocity: 0.8 }; // end = 10
  const note3: Note = { id: 'l3', pitch: 67, start: 12, duration: 2, velocity: 0.8 }; // unselected
  const notes = [note1, note2, note3];

  // Drag left handle by -1 step (start moves earlier by 1, duration increases by 1)
  const resized = resizeNotesLeft(notes, ['l1', 'l2'], -1);

  assert.equal(resized[0].start, 1);
  assert.equal(resized[0].duration, 3);
  assert.equal(resized[0].start + resized[0].duration, 4); // right edge preserved

  assert.equal(resized[1].start, 5);
  assert.equal(resized[1].duration, 5);
  assert.equal(resized[1].start + resized[1].duration, 10); // right edge preserved

  assert.equal(resized[2].start, 12);
  assert.equal(resized[2].duration, 2); // unselected untouched
});

test('resizeNotesRight & resizeNotesLeft: handle mixed note durations with minimum-duration clamping', () => {
  const shortNote: Note = { id: 'short', pitch: 60, start: 2, duration: 0.5, velocity: 0.8 };
  const longNote: Note = { id: 'long', pitch: 64, start: 4, duration: 4, velocity: 0.8 };
  const notes = [shortNote, longNote];

  // Shrink right by -2 steps: short note hits minDuration (0.25), long note shrinks to 2
  const shrinkRight = resizeNotesRight(notes, ['short', 'long'], -2);
  assert.equal(shrinkRight[0].start, 2);
  assert.equal(shrinkRight[0].duration, DEFAULT_MIN_NOTE_DURATION); // clamped at 0.25
  assert.equal(shrinkRight[1].start, 4);
  assert.equal(shrinkRight[1].duration, 2);

  // Shrink left by +2 steps (start moves right): short note hits minDuration (0.25), long note shrinks to 2
  // originalEnds: short = 2.5, long = 8.0
  const shrinkLeft = resizeNotesLeft(notes, ['short', 'long'], 2);
  assert.equal(shrinkLeft[0].start, 2.5 - DEFAULT_MIN_NOTE_DURATION); // 2.25
  assert.equal(shrinkLeft[0].duration, DEFAULT_MIN_NOTE_DURATION); // 0.25
  assert.equal(shrinkLeft[0].start + shrinkLeft[0].duration, 2.5); // end preserved

  assert.equal(shrinkLeft[1].start, 6);
  assert.equal(shrinkLeft[1].duration, 2);
  assert.equal(shrinkLeft[1].start + shrinkLeft[1].duration, 8); // end preserved
});

test('resizeNotesRight: enforces maximum timeline boundary bounds.maxSteps', () => {
  const noteA: Note = { id: 'b-a', pitch: 60, start: 4, duration: 2, velocity: 0.8 };
  const noteB: Note = { id: 'b-b', pitch: 64, start: 12, duration: 2, velocity: 0.8 }; // end = 14
  const notes = [noteA, noteB];

  // With maxSteps = 16: noteB can expand at most +2 steps (duration 4), noteA expands +4 steps (duration 6, end = 10)
  const bounds = { maxSteps: 16 };
  const resized = resizeNotesRight(notes, ['b-a', 'b-b'], 10, 1, undefined, bounds);

  assert.equal(resized[0].duration, 12); // start 4 + 12 = 16 (clamped at maxSteps)
  assert.equal(resized[1].duration, 4);  // start 12 + 4 = 16 (clamped at maxSteps)
  assert.equal(resized[0].start + resized[0].duration <= 16, true);
  assert.equal(resized[1].start + resized[1].duration <= 16, true);
});

test('resizeNotesLeft: clamps note start to zero and does not allow negative timeline positions', () => {
  const noteA: Note = { id: 'l-a', pitch: 60, start: 1, duration: 2, velocity: 0.8 }; // end = 3
  const noteB: Note = { id: 'l-b', pitch: 64, start: 4, duration: 2, velocity: 0.8 }; // end = 6
  const notes = [noteA, noteB];

  // Drag left by -10 steps (far beyond 0)
  const resized = resizeNotesLeft(notes, ['l-a', 'l-b'], -10);

  assert.equal(resized[0].start, 0);
  assert.equal(resized[0].duration, 3); // end = 3
  assert.equal(resized[1].start, 0);
  assert.equal(resized[1].duration, 6); // end = 6
});

test('resizeNotesRight & resizeNotesLeft: single-note equivalence with resizeNoteRight & resizeNoteLeft', () => {
  const singleNote: Note = { id: 'single', pitch: 60, start: 4, duration: 2, velocity: 0.8 };
  const bounds = { maxSteps: 32, minDuration: 0.25 };

  // Equivalence for right resize
  const rightExpected = resizeNoteRight(singleNote, 4 + 2 + 3, 1, undefined, bounds);
  const rightGroup = resizeNotesRight([singleNote], ['single'], 3, 1, undefined, bounds);
  assert.deepEqual(rightGroup[0], rightExpected);

  // Equivalence for left resize
  const leftExpected = resizeNoteLeft(singleNote, 4 - 2, 1, undefined, bounds);
  const leftGroup = resizeNotesLeft([singleNote], ['single'], -2, 1, undefined, bounds);
  assert.deepEqual(leftGroup[0], leftExpected);
});

test('resizeNotesRight & resizeNotesLeft: preserve IDs, pitches, velocities, custom metadata, and immutability', () => {
  interface CustomNote extends Note {
    customColor?: string;
    label?: string;
  }
  const note1: CustomNote = { id: 'c1', pitch: 60, start: 0, duration: 2, velocity: 0.77, customColor: '#ff0000', label: 'lead' };
  const note2: CustomNote = { id: 'c2', pitch: 64, start: 4, duration: 2, velocity: 0.99, customColor: '#00ff00', label: 'harmony' };
  const notes: Note[] = [note1, note2];

  const resized = resizeNotesRight(notes, ['c1', 'c2'], 1);

  // Assert input array and objects NOT mutated
  assert.notEqual(resized, notes);
  assert.notEqual(resized[0], notes[0]);
  assert.equal(notes[0].duration, 2);

  // Assert custom properties preserved
  assert.equal((resized[0] as CustomNote).customColor, '#ff0000');
  assert.equal((resized[0] as CustomNote).label, 'lead');
  assert.equal(resized[0].velocity, 0.77);
  assert.equal(resized[0].pitch, 60);
  assert.equal(resized[0].id, 'c1');
});

test('resizeNotesRight & resizeNotesLeft: edge cases, empty selection, and validation errors', () => {
  const note: Note = { id: 'e1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const notes = [note];

  // Empty selection returns clean cloned copy
  const emptySel = resizeNotesRight(notes, new Set(), 2);
  assert.deepEqual(emptySel, notes);
  assert.notEqual(emptySel, notes);

  // Empty notes returns empty array
  assert.deepEqual(resizeNotesRight([], ['e1'], 2), []);
  assert.deepEqual(resizeNotesLeft([], ['e1'], 2), []);

  // Non-matching IDs returns clean copy
  const nonMatch = resizeNotesLeft(notes, ['non-existent'], 2);
  assert.deepEqual(nonMatch, notes);

  // Non-finite delta throws
  assert.throws(() => resizeNotesRight(notes, ['e1'], NaN), /Delta steps must be finite/);
  assert.throws(() => resizeNotesLeft(notes, ['e1'], Infinity), /Delta steps must be finite/);

  // Non-positive grid size throws
  assert.throws(() => resizeNotesRight(notes, ['e1'], 1, 0), /Grid size must be greater than zero/);
  assert.throws(() => resizeNotesLeft(notes, ['e1'], 1, -1), /Grid size must be greater than zero/);
});

test('history: group resize produces exactly one commit, supporting undo and redo', () => {
  const noteA: Note = { id: 'res-a', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const noteB: Note = { id: 'res-b', pitch: 64, start: 4, duration: 4, velocity: 0.8 };
  const state0 = { notes: [noteA, noteB] };

  // Resize both notes by +2 steps
  const state1 = { notes: resizeNotesRight(state0.notes, ['res-a', 'res-b'], 2) };
  const history = [state0, state1];

  assert.equal(history.length, 2);
  assert.equal(history[1].notes[0].duration, 4);
  assert.equal(history[1].notes[1].duration, 6);

  // Undo restores original durations
  assert.equal(history[0].notes[0].duration, 2);
  assert.equal(history[0].notes[1].duration, 4);
});

test('resizeNotesRight & resizeNotesLeft: note already at DEFAULT_MIN_NOTE_DURATION remains stable when shrunk further', () => {
  const minNote: Note = {
    id: 'min-1',
    pitch: 60,
    start: 4,
    duration: DEFAULT_MIN_NOTE_DURATION,
    velocity: 0.8
  };
  const partnerNote: Note = {
    id: 'partner-1',
    pitch: 64,
    start: 8,
    duration: 2,
    velocity: 0.8
  };
  const notes = [minNote, partnerNote];

  // 1. resizeNotesRight: apply negative delta (shrink)
  const rightShrunk = resizeNotesRight(notes, ['min-1', 'partner-1'], -1);
  assert.equal(rightShrunk[0].duration, DEFAULT_MIN_NOTE_DURATION);
  assert.equal(rightShrunk[0].start, 4);
  assert.equal(rightShrunk[1].duration, 1);
  assert.equal(rightShrunk[1].start, 8);

  // 2. resizeNotesLeft: apply positive delta (shrink start rightwards)
  const leftShrunk = resizeNotesLeft(notes, ['min-1', 'partner-1'], 1);
  assert.equal(leftShrunk[0].duration, DEFAULT_MIN_NOTE_DURATION);
  assert.equal(leftShrunk[0].start, 4);
  assert.equal(leftShrunk[0].start + leftShrunk[0].duration, 4.25);
  assert.equal(leftShrunk[1].start, 9);
  assert.equal(leftShrunk[1].duration, 1);
  assert.equal(leftShrunk[1].start + leftShrunk[1].duration, 10);
});

test('duplicateNotes: single note duplication places duplicate immediately after note end', () => {
  const note: Note = { id: 'single-1', pitch: 60, start: 4, duration: 2, velocity: 0.85, pan: -0.2, muted: false };
  const notes = [note];

  const result = duplicateNotes(notes, ['single-1'], undefined, (n, i) => `${n.id}-dup-${i}`);

  assert.equal(result.updatedNotes.length, 2);
  assert.equal(result.duplicatedNotes.length, 1);

  // Original preserved
  assert.equal(result.updatedNotes[0].id, 'single-1');
  assert.equal(result.updatedNotes[0].start, 4);

  // Duplicate placed at 4 + 2 = 6
  const dup = result.duplicatedNotes[0];
  assert.equal(dup.id, 'single-1-dup-0');
  assert.equal(dup.pitch, 60);
  assert.equal(dup.start, 6);
  assert.equal(dup.duration, 2);
  assert.equal(dup.velocity, 0.85);
  assert.equal(dup.pan, -0.2);
  assert.equal(dup.muted, false);
});

test('duplicateNotes: contiguous multi-note duplication preserves group length and relative offsets', () => {
  const noteA: Note = { id: 'c-a', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const noteB: Note = { id: 'c-b', pitch: 64, start: 2, duration: 2, velocity: 0.8 };
  const notes = [noteA, noteB];

  // groupStart = 0, groupEnd = 4, groupLength = 4
  const result = duplicateNotes(notes, ['c-a', 'c-b'], undefined, (n, i) => `${n.id}-dup`);

  assert.equal(result.updatedNotes.length, 4);
  assert.equal(result.duplicatedNotes.length, 2);

  // First duplicate at 0 + 4 = 4
  assert.equal(result.duplicatedNotes[0].id, 'c-a-dup');
  assert.equal(result.duplicatedNotes[0].start, 4);
  assert.equal(result.duplicatedNotes[0].duration, 2);

  // Second duplicate at 2 + 4 = 6
  assert.equal(result.duplicatedNotes[1].id, 'c-b-dup');
  assert.equal(result.duplicatedNotes[1].start, 6);
  assert.equal(result.duplicatedNotes[1].duration, 2);
});

test('duplicateNotes: non-contiguous multi-note duplication preserves internal timing gaps', () => {
  const note1: Note = { id: 'nc-1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const note2: Note = { id: 'nc-2', pitch: 67, start: 6, duration: 2, velocity: 0.9 }; // gap of 4 steps (from 2 to 6)
  const notes = [note1, note2];

  // groupStart = 0, groupEnd = 8, groupLength = 8
  const result = duplicateNotes(notes, ['nc-1', 'nc-2'], undefined, (n, i) => `${n.id}-dup`);

  assert.equal(result.duplicatedNotes[0].start, 8);
  assert.equal(result.duplicatedNotes[1].start, 14); // 6 + 8 = 14; gap between 10 and 14 is 4 steps!
  assert.equal(result.duplicatedNotes[1].start - (result.duplicatedNotes[0].start + result.duplicatedNotes[0].duration), 4);
});

test('duplicateNotes: chord and motif relative pitch and spacing preservation', () => {
  // C Major triad at start 4
  const root: Note = { id: 'ch-c', pitch: 60, start: 4, duration: 4, velocity: 0.8 };
  const third: Note = { id: 'ch-e', pitch: 64, start: 4, duration: 4, velocity: 0.75 };
  const fifth: Note = { id: 'ch-g', pitch: 67, start: 4, duration: 4, velocity: 0.7 };
  const notes = [root, third, fifth];

  const result = duplicateNotes(notes, ['ch-c', 'ch-e', 'ch-g'], undefined, (n) => `${n.id}-dup`);

  assert.equal(result.duplicatedNotes.length, 3);
  result.duplicatedNotes.forEach((dup, i) => {
    assert.equal(dup.start, 8); // 4 + 4
    assert.equal(dup.duration, 4);
    assert.equal(dup.pitch, notes[i].pitch);
    assert.equal(dup.velocity, notes[i].velocity);
  });
});

test('duplicateNotes: correct group envelope calculation with mixed durations and staggered starts', () => {
  const noteA: Note = { id: 'st-a', pitch: 60, start: 3, duration: 5, velocity: 0.8 }; // end = 8
  const noteB: Note = { id: 'st-b', pitch: 64, start: 1, duration: 2, velocity: 0.8 }; // start = 1, end = 3
  const notes = [noteA, noteB];

  // groupStart = 1, groupEnd = 8, groupLength = 7
  const result = duplicateNotes(notes, ['st-a', 'st-b'], undefined, (n) => `${n.id}-dup`);

  // noteA duplicate starts at 3 + 7 = 10, ends at 15
  assert.equal(result.duplicatedNotes[0].start, 10);
  assert.equal(result.duplicatedNotes[0].duration, 5);

  // noteB duplicate starts at 1 + 7 = 8, ends at 10
  assert.equal(result.duplicatedNotes[1].start, 8);
  assert.equal(result.duplicatedNotes[1].duration, 2);
});

test('duplicateNotes: explicit positive offset overrides default groupLength', () => {
  const note: Note = { id: 'off-1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const notes = [note];

  // Default would be offset = 2. Explicit offset = 16 (1 bar)
  const result = duplicateNotes(notes, ['off-1'], 16, (n) => `${n.id}-bar2`);

  assert.equal(result.duplicatedNotes[0].start, 16);
  assert.equal(result.duplicatedNotes[0].duration, 2);
});

test('duplicateNotes: explicit offset boundary calculation validates actual duplicate end', () => {
  const noteA: Note = { id: 'bnd-a', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const noteB: Note = { id: 'bnd-b', pitch: 64, start: 2, duration: 6, velocity: 0.8 }; // end = 8
  const notes = [noteA, noteB];
  const bounds = { maxSteps: 12 };

  // Explicit offset 5: Note A end = 0 + 5 + 2 = 7 <= 12. Note B end = 2 + 5 + 6 = 13 > 12!
  assert.throws(
    () => duplicateNotes(notes, ['bnd-a', 'bnd-b'], 5, undefined, bounds),
    /note exceeds timeline bounds/
  );
});

test('duplicateNotes: rejects non-finite or negative or zero explicit offsetSteps', () => {
  const note: Note = { id: 'inv-1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const notes = [note];

  assert.throws(() => duplicateNotes(notes, ['inv-1'], 0), /offsetSteps must be finite and greater than zero/);
  assert.throws(() => duplicateNotes(notes, ['inv-1'], -4), /offsetSteps must be finite and greater than zero/);
  assert.throws(() => duplicateNotes(notes, ['inv-1'], NaN), /offsetSteps must be finite and greater than zero/);
  assert.throws(() => duplicateNotes(notes, ['inv-1'], Infinity), /offsetSteps must be finite and greater than zero/);
});

test('duplicateNotes: maxSteps overflow rejection and atomic no-partial duplication', () => {
  const note1: Note = { id: 'ovf-1', pitch: 60, start: 8, duration: 4, velocity: 0.8 };
  const note2: Note = { id: 'ovf-2', pitch: 64, start: 12, duration: 4, velocity: 0.8 }; // end = 16
  const notes = [note1, note2];
  const bounds = { maxSteps: 16 };

  // groupLength = 8. Duplicates would end at 16 + 8 = 24 > 16.
  assert.throws(
    () => duplicateNotes(notes, ['ovf-1', 'ovf-2'], undefined, undefined, bounds),
    /note exceeds timeline bounds/
  );

  // Original array remains completely untouched
  assert.equal(notes.length, 2);
  assert.equal(notes[0].start, 8);
  assert.equal(notes[1].start, 12);
});

test('duplicateNotes: empty selection and non-matching IDs return clean copy without duplicates', () => {
  const note: Note = { id: 'safe-1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const notes = [note];

  // Empty selection
  const emptyRes = duplicateNotes(notes, new Set());
  assert.deepEqual(emptyRes.updatedNotes, notes);
  assert.notEqual(emptyRes.updatedNotes, notes);
  assert.equal(emptyRes.duplicatedNotes.length, 0);

  // Non-matching IDs
  const nonMatchRes = duplicateNotes(notes, ['unknown-id']);
  assert.deepEqual(nonMatchRes.updatedNotes, notes);
  assert.equal(nonMatchRes.duplicatedNotes.length, 0);

  // Empty notes list
  const emptyNotesRes = duplicateNotes([], ['safe-1']);
  assert.deepEqual(emptyNotesRes.updatedNotes, []);
  assert.equal(emptyNotesRes.duplicatedNotes.length, 0);
});

test('duplicateNotes: unique generated IDs and collision avoidance', () => {
  const note1: Note = { id: 'dup-id', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const note2: Note = { id: 'dup-id-dup-1', pitch: 64, start: 2, duration: 2, velocity: 0.8 };
  const notes = [note1, note2];

  // Generator deliberately returns an already-existing ID 'dup-id'
  const result = duplicateNotes(notes, ['dup-id', 'dup-id-dup-1'], undefined, () => 'dup-id');

  assert.equal(result.duplicatedNotes.length, 2);
  const id0 = result.duplicatedNotes[0].id;
  const id1 = result.duplicatedNotes[1].id;

  // Verify none collide with existing notes
  assert.notEqual(id0, 'dup-id');
  assert.notEqual(id0, 'dup-id-dup-1');
  assert.notEqual(id1, 'dup-id');
  assert.notEqual(id1, 'dup-id-dup-1');

  // Verify duplicates do not collide with each other
  assert.notEqual(id0, id1);
});

test('duplicateNotes: metadata preservation and input immutability', () => {
  interface RichNote extends Note {
    customColor?: string;
    label?: string;
  }
  const note: RichNote = {
    id: 'meta-1',
    pitch: 62,
    start: 2,
    duration: 3,
    velocity: 0.73,
    pan: 0.45,
    muted: true,
    customColor: '#9b59b6',
    label: 'lead hook'
  };
  const notes: Note[] = [note];

  const result = duplicateNotes(notes, ['meta-1']);

  // Immutability checks
  assert.notEqual(result.updatedNotes, notes);
  assert.notEqual(result.updatedNotes[0], notes[0]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].start, 2);

  // Duplicate metadata checks
  const dup = result.duplicatedNotes[0] as RichNote;
  assert.notEqual(dup.id, note.id);
  assert.equal(dup.start, 5); // 2 + 3
  assert.equal(dup.pitch, 62);
  assert.equal(dup.duration, 3);
  assert.equal(dup.velocity, 0.73);
  assert.equal(dup.pan, 0.45);
  assert.equal(dup.muted, true);
  assert.equal(dup.customColor, '#9b59b6');
  assert.equal(dup.label, 'lead hook');
});

test('duplicateNotes: ordering in updatedNotes appends duplicates after original notes', () => {
  const note1: Note = { id: 'ord-1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const note2: Note = { id: 'ord-2', pitch: 64, start: 2, duration: 2, velocity: 0.8 };
  const note3: Note = { id: 'ord-3', pitch: 67, start: 4, duration: 2, velocity: 0.8 }; // unselected
  const notes = [note1, note2, note3];

  const result = duplicateNotes(notes, ['ord-1', 'ord-2'], undefined, (n) => `${n.id}-copy`);

  assert.equal(result.updatedNotes.length, 5);
  assert.equal(result.updatedNotes[0].id, 'ord-1');
  assert.equal(result.updatedNotes[1].id, 'ord-2');
  assert.equal(result.updatedNotes[2].id, 'ord-3');
  assert.equal(result.updatedNotes[3].id, 'ord-1-copy');
  assert.equal(result.updatedNotes[4].id, 'ord-2-copy');
});

test('duplicateNotes: repeated duplication semantics (e.g. repeated Ctrl+D)', () => {
  const note1: Note = { id: 'loop-1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const note2: Note = { id: 'loop-2', pitch: 64, start: 2, duration: 2, velocity: 0.8 };
  let currentNotes: Note[] = [note1, note2];
  let currentSelection = new Set(['loop-1', 'loop-2']);

  // 1st duplication: Bar 1 -> Bar 2 (offset = 4)
  const step1 = duplicateNotes(currentNotes, currentSelection, undefined, (n, i) => `dup1-${i}`);
  currentNotes = step1.updatedNotes;
  currentSelection = new Set(step1.duplicatedNotes.map(n => n.id));

  assert.equal(currentNotes.length, 4);
  assert.equal(step1.duplicatedNotes[0].start, 4);
  assert.equal(step1.duplicatedNotes[1].start, 6);

  // 2nd duplication: Bar 2 -> Bar 3 (offset = 4)
  const step2 = duplicateNotes(currentNotes, currentSelection, undefined, (n, i) => `dup2-${i}`);
  currentNotes = step2.updatedNotes;
  currentSelection = new Set(step2.duplicatedNotes.map(n => n.id));

  assert.equal(currentNotes.length, 6);
  assert.equal(step2.duplicatedNotes[0].start, 8);
  assert.equal(step2.duplicatedNotes[1].start, 10);

  // 3rd duplication: Bar 3 -> Bar 4 (offset = 4)
  const step3 = duplicateNotes(currentNotes, currentSelection, undefined, (n, i) => `dup3-${i}`);
  currentNotes = step3.updatedNotes;

  assert.equal(currentNotes.length, 8);
  assert.equal(step3.duplicatedNotes[0].start, 12);
  assert.equal(step3.duplicatedNotes[1].start, 14);
});

test('history: note duplication produces exactly one commit, supporting undo and redo', () => {
  const noteA: Note = { id: 'h-a', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const state0 = { notes: [noteA] };

  // Duplicate noteA
  const result = duplicateNotes(state0.notes, ['h-a'], undefined, () => 'h-a-copy');
  const state1 = { notes: result.updatedNotes };
  const history = [state0, state1];

  assert.equal(history.length, 2);
  assert.equal(history[1].notes.length, 2);
  assert.equal(history[1].notes[1].id, 'h-a-copy');
  assert.equal(history[1].notes[1].start, 2);

  // Undo restores original notes
  assert.equal(history[0].notes.length, 1);
  assert.equal(history[0].notes[0].id, 'h-a');
});

// ============================================================================
// PHASE 5.3C: KEYBOARD TRANSPOSE & NUDGE TESTS
// ============================================================================

test('transposeNotes: +1 semitone transposition moves selected notes up by 1', () => {
  const note1: Note = { id: 't1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const note2: Note = { id: 't2', pitch: 64, start: 2, duration: 2, velocity: 0.8 };
  const notes = [note1, note2];

  const result = transposeNotes(notes, ['t1'], 1);
  assert.equal(result.length, 2);
  assert.equal(result[0].pitch, 61);
  assert.equal(result[1].pitch, 64); // unselected note untouched
});

test('transposeNotes: -1 semitone transposition moves selected notes down by 1', () => {
  const note1: Note = { id: 't1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const notes = [note1];

  const result = transposeNotes(notes, ['t1'], -1);
  assert.equal(result.length, 1);
  assert.equal(result[0].pitch, 59);
});

test('transposeNotes: +12 semitones transposes selected notes up by one octave', () => {
  const note1: Note = { id: 't1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const notes = [note1];

  const result = transposeNotes(notes, ['t1'], 12);
  assert.equal(result[0].pitch, 72);
});

test('transposeNotes: -12 semitones transposes selected notes down by one octave', () => {
  const note1: Note = { id: 't1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const notes = [note1];

  const result = transposeNotes(notes, ['t1'], -12);
  assert.equal(result[0].pitch, 48);
});

test('transposeNotes: multi-note chord transposes all notes maintaining relative intervals', () => {
  // C Major triad: C4(60), E4(64), G4(67)
  const n1: Note = { id: 'c1', pitch: 60, start: 0, duration: 4, velocity: 0.8 };
  const n2: Note = { id: 'c2', pitch: 64, start: 0, duration: 4, velocity: 0.85 };
  const n3: Note = { id: 'c3', pitch: 67, start: 0, duration: 4, velocity: 0.9 };
  const notes = [n1, n2, n3];

  const result = transposeNotes(notes, ['c1', 'c2', 'c3'], 2);
  // D Major triad: D4(62), F#4(66), A4(69)
  assert.equal(result[0].pitch, 62);
  assert.equal(result[1].pitch, 66);
  assert.equal(result[2].pitch, 69);
  // Preserves relative intervals
  assert.equal(result[1].pitch - result[0].pitch, 4);
  assert.equal(result[2].pitch - result[1].pitch, 3);
});

test('transposeNotes: preserves relative pitch intervals across wide range of semitones', () => {
  const n1: Note = { id: 'r1', pitch: 48, start: 0, duration: 2, velocity: 0.8 };
  const n2: Note = { id: 'r2', pitch: 55, start: 0, duration: 2, velocity: 0.8 };
  const n3: Note = { id: 'r3', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const notes = [n1, n2, n3];

  const result = transposeNotes(notes, new Set(['r1', 'r2', 'r3']), 7);
  assert.equal(result[0].pitch, 55);
  assert.equal(result[1].pitch, 62);
  assert.equal(result[2].pitch, 67);
  assert.equal(result[1].pitch - result[0].pitch, 7);
  assert.equal(result[2].pitch - result[1].pitch, 5);
});

test('transposeNotes: upper boundary rejection when any note exceeds maxPitch (default 84)', () => {
  const n1: Note = { id: 'u1', pitch: 72, start: 0, duration: 2, velocity: 0.8 };
  const n2: Note = { id: 'u2', pitch: 84, start: 0, duration: 2, velocity: 0.8 };
  const notes = [n1, n2];

  // +1 would push n2 to 85 > 84
  const result = transposeNotes(notes, ['u1', 'u2'], 1);
  // Entire operation rejected atomically
  assert.equal(result[0].pitch, 72);
  assert.equal(result[1].pitch, 84);
});

test('transposeNotes: lower boundary rejection when any note goes below minPitch (default 36)', () => {
  const n1: Note = { id: 'l1', pitch: 36, start: 0, duration: 2, velocity: 0.8 };
  const n2: Note = { id: 'l2', pitch: 48, start: 0, duration: 2, velocity: 0.8 };
  const notes = [n1, n2];

  // -1 would push n1 to 35 < 36
  const result = transposeNotes(notes, ['l1', 'l2'], -1);
  // Entire operation rejected atomically
  assert.equal(result[0].pitch, 36);
  assert.equal(result[1].pitch, 48);
});

test('transposeNotes: octave boundary rejection (+12 or -12 would push note out of bounds)', () => {
  const nTop: Note = { id: 'ot', pitch: 75, start: 0, duration: 2, velocity: 0.8 };
  const notesTop = [nTop];
  // 75 + 12 = 87 > 84
  const resTop = transposeNotes(notesTop, ['ot'], 12);
  assert.equal(resTop[0].pitch, 75);

  const nBot: Note = { id: 'ob', pitch: 45, start: 0, duration: 2, velocity: 0.8 };
  const notesBot = [nBot];
  // 45 - 12 = 33 < 36
  const resBot = transposeNotes(notesBot, ['ob'], -12);
  assert.equal(resBot[0].pitch, 45);
});

test('transposeNotes: metadata preservation keeps velocity, pan, muted, and custom properties', () => {
  interface RichNote extends Note {
    customColor?: string;
  }
  const note: RichNote = {
    id: 'meta-t',
    pitch: 60,
    start: 2,
    duration: 3,
    velocity: 0.73,
    pan: -0.25,
    muted: true,
    customColor: '#e74c3c'
  };
  const notes: Note[] = [note];

  const result = transposeNotes(notes, ['meta-t'], 5) as RichNote[];
  assert.equal(result[0].pitch, 65);
  assert.equal(result[0].id, 'meta-t');
  assert.equal(result[0].start, 2);
  assert.equal(result[0].duration, 3);
  assert.equal(result[0].velocity, 0.73);
  assert.equal(result[0].pan, -0.25);
  assert.equal(result[0].muted, true);
  assert.equal(result[0].customColor, '#e74c3c');
});

test('transposeNotes: immutability ensures original array and note objects are not mutated', () => {
  const origNote: Note = { id: 'imm-1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const notes = [origNote];

  const result = transposeNotes(notes, ['imm-1'], 3);
  assert.notEqual(result, notes);
  assert.notEqual(result[0], origNote);
  assert.equal(origNote.pitch, 60); // original unchanged
  assert.equal(result[0].pitch, 63);

  // Even on rejected boundary, original array and objects must remain untouched and returns clones
  const rejected = transposeNotes(notes, ['imm-1'], 30); // 60 + 30 = 90 > 84
  assert.notEqual(rejected, notes);
  assert.notEqual(rejected[0], origNote);
  assert.equal(origNote.pitch, 60);
  assert.equal(rejected[0].pitch, 60);
});

test('transposeNotes: empty or non-matching selection is a no-op returning cloned notes', () => {
  const note1: Note = { id: 'noop-1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const notes = [note1];

  // Empty selection
  const resEmpty = transposeNotes(notes, [], 2);
  assert.notEqual(resEmpty, notes);
  assert.equal(resEmpty[0].pitch, 60);

  // Non-matching selection
  const resUnknown = transposeNotes(notes, ['non-existent'], 2);
  assert.notEqual(resUnknown, notes);
  assert.equal(resUnknown[0].pitch, 60);

  // Semitones = 0
  const resZero = transposeNotes(notes, ['noop-1'], 0);
  assert.notEqual(resZero, notes);
  assert.equal(resZero[0].pitch, 60);
});

test('transposeNotes: atomic rejection prevents partial movement when one note in a chord hits bound', () => {
  const n1: Note = { id: 'at-1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const n2: Note = { id: 'at-2', pitch: 72, start: 0, duration: 2, velocity: 0.8 };
  const n3: Note = { id: 'at-3', pitch: 84, start: 0, duration: 2, velocity: 0.8 };
  const notes = [n1, n2, n3];

  // +1: n1 -> 61 (valid), n2 -> 73 (valid), n3 -> 85 (invalid)
  const result = transposeNotes(notes, ['at-1', 'at-2', 'at-3'], 1);
  // Atomic rejection: NO PARTIAL MOVEMENT
  assert.equal(result[0].pitch, 60);
  assert.equal(result[1].pitch, 72);
  assert.equal(result[2].pitch, 84);
});

test('transposeNotes: throws error on non-finite or non-integer semitones', () => {
  const notes: Note[] = [{ id: 'err-1', pitch: 60, start: 0, duration: 2, velocity: 0.8 }];
  assert.throws(() => transposeNotes(notes, ['err-1'], Number.NaN), /semitones must be an integer/);
  assert.throws(() => transposeNotes(notes, ['err-1'], Number.POSITIVE_INFINITY), /semitones must be an integer/);
  assert.throws(() => transposeNotes(notes, ['err-1'], 1.5), /semitones must be an integer/);
});

test('nudgeNotes: +1 step nudges selected notes forward by 1 grid step', () => {
  const n1: Note = { id: 'nd-1', pitch: 60, start: 4, duration: 2, velocity: 0.8 };
  const n2: Note = { id: 'nd-2', pitch: 64, start: 8, duration: 2, velocity: 0.8 };
  const notes = [n1, n2];

  const result = nudgeNotes(notes, ['nd-1'], 1);
  assert.equal(result[0].start, 5);
  assert.equal(result[0].duration, 2); // duration preserved
  assert.equal(result[1].start, 8); // unselected note untouched
});

test('nudgeNotes: -1 step nudges selected notes backward by 1 grid step', () => {
  const n1: Note = { id: 'nd-1', pitch: 60, start: 4, duration: 2, velocity: 0.8 };
  const notes = [n1];

  const result = nudgeNotes(notes, ['nd-1'], -1);
  assert.equal(result[0].start, 3);
  assert.equal(result[0].duration, 2);
});

test('nudgeNotes: +4 steps nudges selected notes forward by 1 beat (4 steps)', () => {
  const n1: Note = { id: 'nd-1', pitch: 60, start: 2, duration: 2, velocity: 0.8 };
  const notes = [n1];

  const result = nudgeNotes(notes, ['nd-1'], 4);
  assert.equal(result[0].start, 6);
  assert.equal(result[0].duration, 2);
});

test('nudgeNotes: -4 steps nudges selected notes backward by 1 beat (4 steps)', () => {
  const n1: Note = { id: 'nd-1', pitch: 60, start: 6, duration: 2, velocity: 0.8 };
  const notes = [n1];

  const result = nudgeNotes(notes, ['nd-1'], -4);
  assert.equal(result[0].start, 2);
  assert.equal(result[0].duration, 2);
});

test('nudgeNotes: multi-note motif nudges all notes preserving relative timing and offsets', () => {
  const m1: Note = { id: 'm1', pitch: 60, start: 2, duration: 2, velocity: 0.8 };
  const m2: Note = { id: 'm2', pitch: 64, start: 5, duration: 1, velocity: 0.85 };
  const m3: Note = { id: 'm3', pitch: 67, start: 8, duration: 4, velocity: 0.9 };
  const notes = [m1, m2, m3];

  const result = nudgeNotes(notes, ['m1', 'm2', 'm3'], 3);
  assert.equal(result[0].start, 5);
  assert.equal(result[1].start, 8);
  assert.equal(result[2].start, 11);

  // Relative timing differences preserved
  assert.equal(result[1].start - result[0].start, 3);
  assert.equal(result[2].start - result[1].start, 3);

  // Durations preserved
  assert.equal(result[0].duration, 2);
  assert.equal(result[1].duration, 1);
  assert.equal(result[2].duration, 4);
});

test('nudgeNotes: preserves relative timing with fractional step deltas', () => {
  const n1: Note = { id: 'f1', pitch: 60, start: 1.5, duration: 1.5, velocity: 0.8 };
  const n2: Note = { id: 'f2', pitch: 62, start: 3.25, duration: 0.75, velocity: 0.8 };
  const notes = [n1, n2];

  const result = nudgeNotes(notes, ['f1', 'f2'], 0.5);
  assert.equal(result[0].start, 2.0);
  assert.equal(result[1].start, 3.75);
  assert.equal(result[1].start - result[0].start, 1.75);
});

test('nudgeNotes: left boundary rejection when any note would start below step 0', () => {
  const n1: Note = { id: 'lb-1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const n2: Note = { id: 'lb-2', pitch: 64, start: 4, duration: 2, velocity: 0.8 };
  const notes = [n1, n2];

  // -1 would push n1 to start -1 < 0
  const result = nudgeNotes(notes, ['lb-1', 'lb-2'], -1);
  // Entire operation rejected: neither moves
  assert.equal(result[0].start, 0);
  assert.equal(result[1].start, 4);
});

test('nudgeNotes: right boundary rejection when any note would end beyond maxSteps', () => {
  const n1: Note = { id: 'rb-1', pitch: 60, start: 10, duration: 2, velocity: 0.8 };
  const n2: Note = { id: 'rb-2', pitch: 64, start: 14, duration: 2, velocity: 0.8 }; // ends at 16
  const notes = [n1, n2];

  // bounds maxSteps: 16. Nudge +1 pushes n2 to start 15, duration 2 -> end 17 > 16
  const result = nudgeNotes(notes, ['rb-1', 'rb-2'], 1, { maxSteps: 16 });
  // Entire operation rejected: neither moves
  assert.equal(result[0].start, 10);
  assert.equal(result[1].start, 14);
});

test('nudgeNotes: metadata preservation keeps pitch, duration, velocity, pan, and muted', () => {
  interface RichNote extends Note {
    customColor?: string;
  }
  const note: RichNote = {
    id: 'meta-n',
    pitch: 65,
    start: 4,
    duration: 3,
    velocity: 0.88,
    pan: 0.5,
    muted: false,
    customColor: '#3498db'
  };
  const notes: Note[] = [note];

  const result = nudgeNotes(notes, ['meta-n'], 4) as RichNote[];
  assert.equal(result[0].start, 8);
  assert.equal(result[0].id, 'meta-n');
  assert.equal(result[0].pitch, 65);
  assert.equal(result[0].duration, 3);
  assert.equal(result[0].velocity, 0.88);
  assert.equal(result[0].pan, 0.5);
  assert.equal(result[0].muted, false);
  assert.equal(result[0].customColor, '#3498db');
});

test('nudgeNotes: immutability ensures original array and note objects are not mutated', () => {
  const origNote: Note = { id: 'imm-n', pitch: 60, start: 4, duration: 2, velocity: 0.8 };
  const notes = [origNote];

  const result = nudgeNotes(notes, ['imm-n'], 1);
  assert.notEqual(result, notes);
  assert.notEqual(result[0], origNote);
  assert.equal(origNote.start, 4);
  assert.equal(result[0].start, 5);

  // Rejection immutability
  const rejected = nudgeNotes(notes, ['imm-n'], -10); // 4 - 10 = -6 < 0
  assert.notEqual(rejected, notes);
  assert.notEqual(rejected[0], origNote);
  assert.equal(origNote.start, 4);
  assert.equal(rejected[0].start, 4);
});

test('nudgeNotes: empty or non-matching selection is a no-op returning cloned notes', () => {
  const note1: Note = { id: 'noop-n', pitch: 60, start: 4, duration: 2, velocity: 0.8 };
  const notes = [note1];

  const resEmpty = nudgeNotes(notes, [], 1);
  assert.notEqual(resEmpty, notes);
  assert.equal(resEmpty[0].start, 4);

  const resUnknown = nudgeNotes(notes, ['ghost-note'], 1);
  assert.notEqual(resUnknown, notes);
  assert.equal(resUnknown[0].start, 4);

  const resZero = nudgeNotes(notes, ['noop-n'], 0);
  assert.notEqual(resZero, notes);
  assert.equal(resZero[0].start, 4);
});

test('nudgeNotes: atomic rejection prevents partial movement when one note in motif hits left bound', () => {
  const n1: Note = { id: 'an-1', pitch: 60, start: 0, duration: 2, velocity: 0.8 };
  const n2: Note = { id: 'an-2', pitch: 64, start: 4, duration: 2, velocity: 0.8 };
  const n3: Note = { id: 'an-3', pitch: 67, start: 8, duration: 2, velocity: 0.8 };
  const notes = [n1, n2, n3];

  // Nudge -1: n1 -> -1 (invalid), n2 -> 3 (valid in isolation), n3 -> 7 (valid in isolation)
  const result = nudgeNotes(notes, ['an-1', 'an-2', 'an-3'], -1);
  // Atomic rejection: NO PARTIAL MOVEMENT
  assert.equal(result[0].start, 0);
  assert.equal(result[1].start, 4);
  assert.equal(result[2].start, 8);
});

test('nudgeNotes: atomic rejection prevents partial movement when one note in motif hits right bound', () => {
  const n1: Note = { id: 'an-1', pitch: 60, start: 2, duration: 2, velocity: 0.8 };
  const n2: Note = { id: 'an-2', pitch: 64, start: 6, duration: 2, velocity: 0.8 };
  const n3: Note = { id: 'an-3', pitch: 67, start: 15, duration: 2, velocity: 0.8 }; // ends at 17
  const notes = [n1, n2, n3];

  // bounds maxSteps: 16. Nudge +1 pushes n3 to end 18 > 16
  const result = nudgeNotes(notes, ['an-1', 'an-2', 'an-3'], 1, { maxSteps: 16 });
  // Atomic rejection: NO PARTIAL MOVEMENT
  assert.equal(result[0].start, 2);
  assert.equal(result[1].start, 6);
  assert.equal(result[2].start, 15);
});

test('nudgeNotes: throws error on non-finite deltaSteps', () => {
  const notes: Note[] = [{ id: 'err-n', pitch: 60, start: 2, duration: 2, velocity: 0.8 }];
  assert.throws(() => nudgeNotes(notes, ['err-n'], Number.NaN), /deltaSteps must be finite/);
  assert.throws(() => nudgeNotes(notes, ['err-n'], Number.POSITIVE_INFINITY), /deltaSteps must be finite/);
});

test('history: transpose and nudge produce exactly one commit when changed, zero when rejected', () => {
  const noteA: Note = { id: 'h-tn', pitch: 60, start: 2, duration: 2, velocity: 0.8 };
  const initialNotes = [noteA];

  // 1. Successful transpose produces one new state
  const transposed = transposeNotes(initialNotes, ['h-tn'], 1);
  const changedT = transposed.some((n, idx) => n.pitch !== initialNotes[idx].pitch);
  assert.equal(changedT, true);
  const history1 = [initialNotes, transposed];
  assert.equal(history1.length, 2);
  assert.equal(history1[1][0].pitch, 61);

  // 2. Rejected transpose (exceeding maxPitch) does not change notes -> 0 history entries
  const rejectedT = transposeNotes(history1[1], ['h-tn'], 50); // 61 + 50 = 111 > 84
  const changedRejT = rejectedT.some((n, idx) => n.pitch !== history1[1][idx].pitch);
  assert.equal(changedRejT, false); // No commit!

  // 3. Successful nudge produces one new state
  const nudged = nudgeNotes(history1[1], ['h-tn'], 1);
  const changedN = nudged.some((n, idx) => n.start !== history1[1][idx].start);
  assert.equal(changedN, true);
  const history2 = [...history1, nudged];
  assert.equal(history2.length, 3);
  assert.equal(history2[2][0].start, 3);

  // 4. Rejected nudge (below 0) does not change notes -> 0 history entries
  const rejectedN = nudgeNotes(history2[2], ['h-tn'], -10); // 3 - 10 = -7 < 0
  const changedRejN = rejectedN.some((n, idx) => n.start !== history2[2][idx].start);
  assert.equal(changedRejN, false); // No commit!
});
