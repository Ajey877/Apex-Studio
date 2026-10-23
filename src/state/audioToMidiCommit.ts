/**
 * Phase 8C — committing an Audio-to-MIDI transcription into real project data.
 *
 * THE PROJECT MODEL THIS RESPECTS
 * Patterns own their content (`src/state/patternContent.ts`): the SELECTED
 * pattern's notes live on `Channel.notes`, every other pattern's notes live in
 * `Pattern.channelContent`. Writing "some notes somewhere" is therefore not a
 * thing that can be done safely by assignment; every commit goes through
 * `updatePatternChannelContentInProjectState`, which resolves the right place
 * for the requested (pattern, channel) pair and returns a new state object.
 *
 * NON-DESTRUCTIVE BY DEFAULT
 * - `mode: 'append'` (default) keeps every existing note and places the
 *   transcription AFTER the notes that pattern already holds for that channel
 *   (offset to the next grid step, never on top of them). Two clips transcribed
 *   into one pattern therefore both survive, and the second never silently
 *   doubles the first.
 * - `mode: 'replace'` is only allowed with `confirmReplace: true`. Without it
 *   the commit throws a typed `existing-notes` refusal, so a stray click can
 *   never delete a user's part.
 *
 * The function is pure (state in → new state out). History, persistence and the
 * Piano Roll are the caller's existing layers: the App runs this updater inside
 * `mutateProjectState`, which is the same path every other edit uses, so the
 * commit is one undoable step and is autosaved by the existing project writer.
 */
import type { Note, Pattern, ProjectState } from '../types/daw';
import { MIN_NOTE_DURATION_STEPS, quantizeDurationSteps } from '../music/noteDurationPolicy';
import { updatePatternChannelContentInProjectState } from './patternContent';
import { normalizePatternLengthSteps } from './patternLength';
import type { TranscribedMidiNote } from '../audio/audioToMidi';

export type AudioToMidiCommitFailure =
  | 'no-notes'
  | 'unknown-pattern'
  | 'unknown-channel'
  | 'pattern-too-short'
  | 'existing-notes'
  | 'invalid-note';

/** Typed commit failure so the UI can show the exact reason nothing changed. */
export class AudioToMidiCommitError extends Error {
  public readonly failure: AudioToMidiCommitFailure;
  constructor(failure: AudioToMidiCommitFailure, message: string) {
    super(message);
    this.name = 'AudioToMidiCommitError';
    this.failure = failure;
  }
}

export type AudioToMidiCommitMode = 'append' | 'replace';

export interface AudioToMidiCommitRequest {
  patternId: string;
  channelId: string;
  notes: readonly TranscribedMidiNote[];
  /** `append` (default) keeps existing notes; `replace` requires `confirmReplace`. */
  mode?: AudioToMidiCommitMode;
  confirmReplace?: boolean;
  /** Prefix for the generated note ids (deterministic in tests). */
  idPrefix?: string;
}

export interface AudioToMidiCommitResult {
  state: ProjectState;
  notesWritten: number;
  /** Notes that already existed on that channel in that pattern. */
  existingNoteCount: number;
  mode: AudioToMidiCommitMode;
  /** Steps the append had to skip so it did not land on existing notes. */
  offsetSteps: number;
  /** Last step occupied by the committed notes. */
  lastStepUsed: number;
  patternLengthSteps: number;
}

/** Converts proposed notes into real `Note` records with stable ids. */
export const toProjectNotes = (
  notes: readonly TranscribedMidiNote[],
  idPrefix = 'audio-to-midi'
): Note[] =>
  notes.map((note, index) => {
    if (
      !Number.isFinite(note.midi) ||
      note.midi < 0 ||
      note.midi > 127 ||
      !Number.isFinite(note.startStep) ||
      note.startStep < 0 ||
      !Number.isFinite(note.durationSteps) ||
      note.durationSteps <= 0
    ) {
      throw new AudioToMidiCommitError(
        'invalid-note',
        `Note ${index + 1} (${note.noteName ?? note.midi}) has an unusable pitch or timing and was not committed.`
      );
    }
    return {
      id: `${idPrefix}-${index}`,
      pitch: Math.round(note.midi),
      start: note.startStep,
      duration: quantizeDurationSteps(note.durationSteps),
      velocity: Math.min(1, Math.max(0.05, note.velocity)),
    };
  });

const channelNotesInPattern = (
  state: ProjectState,
  pattern: Pattern,
  channelId: string
): Note[] => {
  if (!Array.isArray(pattern.channelContent)) {
    // Selected pattern: content lives on the live channel.
    const channel = state.channels.find(candidate => candidate.id === channelId);
    return Array.isArray(channel?.notes) ? channel.notes : [];
  }
  const entry = pattern.channelContent.find(candidate => candidate.channelId === channelId);
  return entry && Array.isArray(entry.notes) ? entry.notes : [];
};

/**
 * Writes a transcription into one pattern/channel pair. Pure: returns the new
 * project state (or throws before changing anything).
 */
export const commitAudioToMidiNotes = (
  state: ProjectState,
  request: AudioToMidiCommitRequest
): AudioToMidiCommitResult => {
  const mode: AudioToMidiCommitMode = request.mode === 'replace' ? 'replace' : 'append';
  if (!request.notes || request.notes.length === 0) {
    throw new AudioToMidiCommitError('no-notes', 'There are no transcribed notes to commit.');
  }
  const pattern = state.patterns.find(candidate => candidate.id === request.patternId);
  if (!pattern) {
    throw new AudioToMidiCommitError(
      'unknown-pattern',
      'The destination pattern is no longer in the project. Nothing was written.'
    );
  }
  const channel = state.channels.find(candidate => candidate.id === request.channelId);
  if (!channel) {
    throw new AudioToMidiCommitError(
      'unknown-channel',
      'The destination channel is no longer in the project. Nothing was written.'
    );
  }

  const existing = channelNotesInPattern(state, pattern, request.channelId);
  if (mode === 'replace' && !request.confirmReplace) {
    throw new AudioToMidiCommitError(
      'existing-notes',
      `"${pattern.name}" already holds ${existing.length} note${existing.length === 1 ? '' : 's'} for "${channel.name}". Replacing them needs explicit confirmation — nothing was written.`
    );
  }

  const incoming = toProjectNotes(request.notes, request.idPrefix ?? 'audio-to-midi');
  const transcriptionExtent = incoming.reduce(
    (max, note) => Math.max(max, note.start + note.duration),
    0
  );
  const patternLengthSteps = normalizePatternLengthSteps(pattern.lengthSteps);
  const occupied = existing.reduce(
    (max, note) => Math.max(max, (note.start || 0) + (note.duration || 0)),
    0
  );
  // Appending starts after everything the pattern already holds, aligned to the
  // duration grid so the placed notes stay legal.
  const offsetSteps =
    mode === 'append' && occupied > 0
      ? Math.ceil(occupied / MIN_NOTE_DURATION_STEPS) * MIN_NOTE_DURATION_STEPS
      : 0;
  const lastStepUsed = offsetSteps + transcriptionExtent;
  if (lastStepUsed > patternLengthSteps) {
    throw new AudioToMidiCommitError(
      'pattern-too-short',
      mode === 'replace'
        ? `The transcription needs ${Math.ceil(lastStepUsed)} steps but "${pattern.name}" is ${patternLengthSteps} steps long. Choose a longer pattern (or create one) — notes were not shortened or dropped silently.`
        : `"${pattern.name}" already holds notes up to step ${Math.ceil(occupied)}, and the transcription needs ${Math.ceil(transcriptionExtent)} more steps (pattern length ${patternLengthSteps}). Nothing was written — choose a longer pattern, a new pattern, or replace the existing notes explicitly.`
    );
  }

  const placed = offsetSteps > 0
    ? incoming.map(note => ({ ...note, start: note.start + offsetSteps }))
    : incoming;
  const notes = mode === 'replace' ? placed : [...existing, ...placed];
  const next = updatePatternChannelContentInProjectState(
    state,
    pattern.id,
    channel.id,
    () => ({ notes })
  );

  return {
    state: next,
    notesWritten: incoming.length,
    existingNoteCount: existing.length,
    mode,
    offsetSteps,
    lastStepUsed,
    patternLengthSteps,
  };
};

/**
 * Length a NEW destination pattern needs so the transcription fits whole: the
 * transcription's extent rounded up to a whole 4-step beat, at least one bar of
 * sixteenth steps. Exported so the preview and the App create an identical
 * pattern instead of two guesses.
 */
export const audioToMidiNewPatternLengthSteps = (
  notes: readonly TranscribedMidiNote[]
): number => {
  const extent = notes.reduce(
    (max, note) => Math.max(max, note.startStep + quantizeDurationSteps(note.durationSteps)),
    0
  );
  return Math.max(16, Math.ceil(extent / 4) * 4);
};

/** Existing notes on a channel in a pattern (display/confirmation support). */
export const countChannelNotesInPattern = (
  state: ProjectState,
  patternId: string,
  channelId: string
): number => {
  const pattern = state.patterns.find(candidate => candidate.id === patternId);
  if (!pattern) return 0;
  return channelNotesInPattern(state, pattern, channelId).length;
};

/** Notes occupied so far — how far an appended transcription must be pushed. */
export const lastOccupiedStep = (
  state: ProjectState,
  patternId: string,
  channelId: string
): number => {
  const pattern = state.patterns.find(candidate => candidate.id === patternId);
  if (!pattern) return 0;
  return channelNotesInPattern(state, pattern, channelId).reduce(
    (max, note) => Math.max(max, (note.start || 0) + (note.duration || 0)),
    0
  );
};
