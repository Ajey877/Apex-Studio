import type { Note } from '../types/daw';

export const DEFAULT_MIN_PITCH = 36; // C2
export const DEFAULT_MAX_PITCH = 84; // C6
export const DEFAULT_GRID_STEPS = 1; // 1 step = 1/16th note
export const DEFAULT_MIN_NOTE_DURATION = 0.25; // 1/64th step minimum length

export interface NoteBounds {
  minPitch?: number;
  maxPitch?: number;
  maxSteps?: number;
  minDuration?: number;
  gridSteps?: number;
}

export interface NoteValidationResult {
  valid: boolean;
  errors: string[];
}

const finite = (value: number): boolean => Number.isFinite(value);

export const cloneNote = (note: Note): Note => ({ ...note });

export function validateNote(note: Note, bounds: NoteBounds = {}): NoteValidationResult {
  const errors: string[] = [];
  const minPitch = bounds.minPitch ?? DEFAULT_MIN_PITCH;
  const maxPitch = bounds.maxPitch ?? DEFAULT_MAX_PITCH;
  const minDuration = bounds.minDuration ?? DEFAULT_MIN_NOTE_DURATION;

  if (!note.id) errors.push('Note id is required');
  if (!Number.isInteger(note.pitch)) errors.push('pitch must be an integer');
  if (note.pitch < minPitch || note.pitch > maxPitch) {
    errors.push(`pitch must be between ${minPitch} and ${maxPitch}`);
  }
  if (!finite(note.start) || note.start < 0) errors.push('start must be finite and non-negative');
  if (!finite(note.duration) || note.duration < minDuration) {
    errors.push(`duration must be finite and at least ${minDuration}`);
  }
  if (bounds.maxSteps !== undefined) {
    if (!finite(bounds.maxSteps) || bounds.maxSteps <= 0) {
      errors.push('maxSteps must be finite and greater than zero');
    } else if (finite(note.start) && finite(note.duration) && note.start + note.duration > bounds.maxSteps) {
      errors.push('note exceeds timeline bounds');
    }
  }
  if (note.velocity !== undefined && (!finite(note.velocity) || note.velocity < 0 || note.velocity > 1)) {
    errors.push('velocity must be between 0 and 1');
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidNote(note: Note, bounds: NoteBounds = {}): Note {
  const result = validateNote(note, bounds);
  if (!result.valid) throw new Error(`Invalid note: ${result.errors.join('; ')}`);
  return note;
}

export function snapStepPosition(value: number, gridSteps = DEFAULT_GRID_STEPS): number {
  if (!finite(value)) throw new Error('Step position must be finite');
  if (!finite(gridSteps) || gridSteps <= 0) throw new Error('Grid size must be greater than zero');
  return Math.max(0, Number((Math.round(value / gridSteps) * gridSteps).toFixed(6)));
}

export function moveNote(
  note: Note,
  requestedStart: number,
  requestedPitch: number,
  gridSteps = DEFAULT_GRID_STEPS,
  bounds: NoteBounds = {}
): Note {
  const minPitch = bounds.minPitch ?? DEFAULT_MIN_PITCH;
  const maxPitch = bounds.maxPitch ?? DEFAULT_MAX_PITCH;
  const clampedPitch = Math.max(minPitch, Math.min(maxPitch, Math.round(requestedPitch)));

  const snappedStart = snapStepPosition(requestedStart, gridSteps);
  const maxStart = bounds.maxSteps === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, bounds.maxSteps - note.duration);
  const finalStart = Math.min(snappedStart, maxStart);

  const moved: Note = {
    ...cloneNote(note),
    start: finalStart,
    pitch: clampedPitch
  };

  return assertValidNote(moved, bounds);
}

export function resizeNoteRight(
  note: Note,
  requestedEnd: number,
  gridSteps = DEFAULT_GRID_STEPS,
  minimumDuration?: number,
  bounds: NoteBounds = {}
): Note {
  const minDuration = minimumDuration ?? bounds.minDuration ?? DEFAULT_MIN_NOTE_DURATION;
  if (!finite(minDuration) || minDuration <= 0) {
    throw new Error('minimumDuration must be greater than zero');
  }
  const snappedEnd = snapStepPosition(requestedEnd, gridSteps);
  const maxEnd = bounds.maxSteps === undefined ? Number.POSITIVE_INFINITY : bounds.maxSteps;
  if (maxEnd < note.start + minDuration && bounds.maxSteps !== undefined) {
    throw new Error('Note start exceeds bounds for minimum duration');
  }

  const minimumEnd = Math.min(maxEnd, note.start + minDuration);
  const nextEnd = Math.max(minimumEnd, Math.min(snappedEnd, maxEnd));
  const nextDuration = Number((nextEnd - note.start).toFixed(6));

  const resized: Note = {
    ...cloneNote(note),
    duration: nextDuration
  };

  return assertValidNote(resized, bounds);
}

export function resizeNoteLeft(
  note: Note,
  requestedStart: number,
  gridSteps = DEFAULT_GRID_STEPS,
  minimumDuration?: number,
  bounds: NoteBounds = {}
): Note {
  const minDuration = minimumDuration ?? bounds.minDuration ?? DEFAULT_MIN_NOTE_DURATION;
  if (!finite(minDuration) || minDuration <= 0) {
    throw new Error('minimumDuration must be greater than zero');
  }
  const originalEnd = note.start + note.duration;
  const maxStart = originalEnd - minDuration;
  if (maxStart < 0) throw new Error('Original note end is smaller than minimum duration');

  const snappedStart = snapStepPosition(requestedStart, gridSteps);
  const nextStart = Math.max(0, Math.min(snappedStart, maxStart));
  const nextDuration = Number((originalEnd - nextStart).toFixed(6));

  const resized: Note = {
    ...cloneNote(note),
    start: nextStart,
    duration: nextDuration
  };

  return assertValidNote(resized, bounds);
}

export function updateNoteInNotes(notes: Note[], updatedNote: Note, bounds: NoteBounds = {}): Note[] {
  assertValidNote(updatedNote, bounds);
  if (!notes.some(n => n.id === updatedNote.id)) {
    throw new Error(`Note not found: ${updatedNote.id}`);
  }
  return notes.map(n => (n.id === updatedNote.id ? cloneNote(updatedNote) : n));
}

export function moveNotes(
  notes: Note[],
  selectedIds: Set<string> | string[],
  requestedDeltaSteps: number,
  requestedDeltaPitch: number,
  gridSteps = DEFAULT_GRID_STEPS,
  bounds: NoteBounds = {}
): Note[] {
  if (!finite(requestedDeltaSteps) || !finite(requestedDeltaPitch)) {
    throw new Error('Delta values must be finite');
  }
  if (!finite(gridSteps) || gridSteps <= 0) {
    throw new Error('Grid size must be greater than zero');
  }

  const idSet = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  if (idSet.size === 0) {
    return notes.map(cloneNote);
  }

  const selectedNotes = notes.filter(n => idSet.has(n.id));
  if (selectedNotes.length === 0) {
    return notes.map(cloneNote);
  }

  const minPitch = bounds.minPitch ?? DEFAULT_MIN_PITCH;
  const maxPitch = bounds.maxPitch ?? DEFAULT_MAX_PITCH;

  // Compute group bounding envelope
  let groupMinStart = Number.POSITIVE_INFINITY;
  let groupMaxEnd = Number.NEGATIVE_INFINITY;
  let groupMinPitch = Number.POSITIVE_INFINITY;
  let groupMaxPitch = Number.NEGATIVE_INFINITY;

  for (const n of selectedNotes) {
    if (n.start < groupMinStart) groupMinStart = n.start;
    const noteEnd = n.start + n.duration;
    if (noteEnd > groupMaxEnd) groupMaxEnd = noteEnd;
    if (n.pitch < groupMinPitch) groupMinPitch = n.pitch;
    if (n.pitch > groupMaxPitch) groupMaxPitch = n.pitch;
  }

  // Snap requested deltas to grid
  const snappedDeltaSteps = Math.round(requestedDeltaSteps / gridSteps) * gridSteps;
  const snappedDeltaPitch = Math.round(requestedDeltaPitch);

  // Collective boundary clamping
  // 1. Minimum start >= 0 -> delta >= -groupMinStart
  const minAllowedDeltaSteps = -groupMinStart;
  // 2. Maximum end <= maxSteps (if specified) -> delta <= bounds.maxSteps - groupMaxEnd
  const maxAllowedDeltaSteps = bounds.maxSteps === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(minAllowedDeltaSteps, bounds.maxSteps - groupMaxEnd);

  const clampedDeltaSteps = Math.max(minAllowedDeltaSteps, Math.min(maxAllowedDeltaSteps, snappedDeltaSteps));
  const finalDeltaSteps = Number(clampedDeltaSteps.toFixed(6));

  // 3. Minimum pitch >= minPitch -> delta >= minPitch - groupMinPitch
  const minAllowedDeltaPitch = minPitch - groupMinPitch;
  // 4. Maximum pitch <= maxPitch -> delta <= maxPitch - groupMaxPitch
  const maxAllowedDeltaPitch = maxPitch - groupMaxPitch;

  const clampedDeltaPitch = Math.max(minAllowedDeltaPitch, Math.min(maxAllowedDeltaPitch, snappedDeltaPitch));
  const finalDeltaPitch = Math.round(clampedDeltaPitch);

  // Apply clamped deltas to selected notes, preserve unselected notes
  return notes.map(n => {
    if (!idSet.has(n.id)) {
      return cloneNote(n);
    }
    const moved: Note = {
      ...cloneNote(n),
      start: Number((n.start + finalDeltaSteps).toFixed(6)),
      pitch: n.pitch + finalDeltaPitch
    };
    return assertValidNote(moved, bounds);
  });
}

export function deleteNotes(
  notes: Note[],
  selectedIds: Set<string> | string[]
): Note[] {
  const idSet = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  if (idSet.size === 0) {
    return notes.map(cloneNote);
  }
  return notes.filter(n => !idSet.has(n.id)).map(cloneNote);
}

export function resizeNotesRight(
  notes: Note[],
  selectedIds: Set<string> | string[],
  requestedDeltaSteps: number,
  gridSteps = DEFAULT_GRID_STEPS,
  minimumDuration?: number,
  bounds: NoteBounds = {}
): Note[] {
  if (!finite(requestedDeltaSteps)) {
    throw new Error('Delta steps must be finite');
  }
  if (!finite(gridSteps) || gridSteps <= 0) {
    throw new Error('Grid size must be greater than zero');
  }

  const idSet = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  if (idSet.size === 0 || notes.length === 0) {
    return notes.map(cloneNote);
  }

  return notes.map(note => {
    if (!idSet.has(note.id)) {
      return cloneNote(note);
    }
    const requestedEnd = note.start + note.duration + requestedDeltaSteps;
    return resizeNoteRight(note, requestedEnd, gridSteps, minimumDuration, bounds);
  });
}

export function resizeNotesLeft(
  notes: Note[],
  selectedIds: Set<string> | string[],
  requestedDeltaSteps: number,
  gridSteps = DEFAULT_GRID_STEPS,
  minimumDuration?: number,
  bounds: NoteBounds = {}
): Note[] {
  if (!finite(requestedDeltaSteps)) {
    throw new Error('Delta steps must be finite');
  }
  if (!finite(gridSteps) || gridSteps <= 0) {
    throw new Error('Grid size must be greater than zero');
  }

  const idSet = selectedIds instanceof Set ? selectedIds : new Set(selectedIds);
  if (idSet.size === 0 || notes.length === 0) {
    return notes.map(cloneNote);
  }

  return notes.map(note => {
    if (!idSet.has(note.id)) {
      return cloneNote(note);
    }
    const requestedStart = note.start + requestedDeltaSteps;
    return resizeNoteLeft(note, requestedStart, gridSteps, minimumDuration, bounds);
  });
}

export const DEFAULT_STEP_WIDTH = 28;
export const DEFAULT_ROW_HEIGHT = 24;
export const MARQUEE_DRAG_THRESHOLD_PX = 4;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MarqueeSelectionMode = 'replace' | 'add' | 'toggle';

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  const rx1 = Math.round(x1);
  const ry1 = Math.round(y1);
  const rx2 = Math.round(x2);
  const ry2 = Math.round(y2);
  const x = Math.min(rx1, rx2);
  const y = Math.min(ry1, ry2);
  const width = Math.abs(rx2 - rx1);
  const height = Math.abs(ry2 - ry1);
  return { x, y, width, height };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  const EPSILON = 1e-4;
  return (
    a.x <= b.x + b.width + EPSILON &&
    a.x + a.width >= b.x - EPSILON &&
    a.y <= b.y + b.height + EPSILON &&
    a.y + a.height >= b.y - EPSILON
  );
}

export function getNoteRect(
  note: Note,
  stepWidth = DEFAULT_STEP_WIDTH,
  rowHeight = DEFAULT_ROW_HEIGHT,
  maxPitch = DEFAULT_MAX_PITCH
): Rect {
  const x = note.start * stepWidth;
  const y = (maxPitch - note.pitch) * rowHeight;
  const width = Math.max(16, note.duration * stepWidth - 3);
  const height = rowHeight;
  return { x, y, width, height };
}

export function selectNotesInMarquee(
  notes: Note[],
  marqueeRect: Rect,
  currentSelection: Set<string> | string[],
  mode: MarqueeSelectionMode = 'replace',
  stepWidth = DEFAULT_STEP_WIDTH,
  rowHeight = DEFAULT_ROW_HEIGHT,
  maxPitch = DEFAULT_MAX_PITCH
): Set<string> {
  const baseSet = currentSelection instanceof Set ? currentSelection : new Set(currentSelection);
  const validNoteIds = new Set(notes.map(n => n.id));
  const intersectingIds = new Set<string>();

  for (const note of notes) {
    const noteRect = getNoteRect(note, stepWidth, rowHeight, maxPitch);
    if (rectsIntersect(noteRect, marqueeRect)) {
      intersectingIds.add(note.id);
    }
  }

  if (mode === 'replace') {
    return intersectingIds;
  }

  const result = new Set<string>();

  if (mode === 'add') {
    for (const id of baseSet) {
      if (validNoteIds.has(id)) {
        result.add(id);
      }
    }
    for (const id of intersectingIds) {
      result.add(id);
    }
    return result;
  }

  if (mode === 'toggle') {
    for (const id of baseSet) {
      if (validNoteIds.has(id) && !intersectingIds.has(id)) {
        result.add(id);
      }
    }
    for (const id of intersectingIds) {
      if (!baseSet.has(id)) {
        result.add(id);
      }
    }
    return result;
  }

  return result;
}

export function hasExceededDragThreshold(
  startX: number,
  startY: number,
  currentX: number,
  currentY: number,
  threshold = MARQUEE_DRAG_THRESHOLD_PX
): boolean {
  return Math.hypot(currentX - startX, currentY - startY) >= threshold;
}
