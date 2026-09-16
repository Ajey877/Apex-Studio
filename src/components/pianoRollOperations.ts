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
