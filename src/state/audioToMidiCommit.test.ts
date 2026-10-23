/**
 * Phase 8C — committing Audio-to-MIDI notes into real project state.
 *
 * These tests exercise the production state layer (pattern content, history,
 * serialization and the Standard MIDI writer), not a mocked store:
 *
 *  - append keeps existing notes; replace needs explicit confirmation;
 *  - the commit targets the requested pattern/channel in the independent-pattern
 *    model, whether or not that pattern is the selected one;
 *  - refusals throw before returning any state (the caller's state object is
 *    untouched, so a failed commit cannot change the project);
 *  - undo restores the previous notes and redo restores the committed ones;
 *  - save → load preserves the notes exactly;
 *  - the committed notes reach Standard MIDI export.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Note, Pattern, ProjectState } from '../types/daw';
import type { TranscribedMidiNote } from '../audio/audioToMidi';
import { buildStandardMidiFile } from '../utils/exportUtils';
import { resizeNoteRight, transposeNotes } from '../components/pianoRollOperations';
import { MidiParser } from '../utils/midiParser';
import { addPatternToProjectState } from './projectMutations';
import { createHistory } from './projectHistory';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { serializeProjectState } from './projectPersistence';
import {
  addEmptyPatternToProjectState,
  selectPatternInProjectState,
  updatePatternChannelContentInProjectState,
} from './patternContent';
import {
  AudioToMidiCommitError,
  commitAudioToMidiNotes,
  countChannelNotesInPattern,
  lastOccupiedStep,
  toProjectNotes,
} from './audioToMidiCommit';

const note = (id: string, pitch: number, start: number, duration = 1): Note => ({
  id,
  pitch,
  start,
  duration,
  velocity: 0.8,
});

const transcribed = (
  midi: number,
  startStep: number,
  durationSteps = 2
): TranscribedMidiNote => ({
  index: 0,
  midi,
  noteName: 'X',
  startStep,
  durationSteps,
  startSeconds: startStep * 0.125,
  endSeconds: (startStep + durationSteps) * 0.125,
  confidence: 0.9,
  centsOffset: 0,
  velocity: 0.8,
});

const baseState = (): ProjectState => {
  const state = createDefaultProjectState();
  const channel = state.channels[0];
  const pattern = state.patterns[0];
  return {
    ...state,
    channels: state.channels.map(candidate =>
      candidate.id === channel.id
        ? { ...candidate, instrumentType: 'wavetable', notes: [note('existing-1', 55, 10)] }
        : candidate
    ),
    patterns: state.patterns.map(candidate =>
      candidate.id === pattern.id ? { ...candidate, lengthSteps: 32 } : candidate
    ),
  };
};

const channelId = (state: ProjectState) => state.channels[0].id;
const patternId = (state: ProjectState) => state.patterns[0].id;

const notesOf = (state: ProjectState, targetPatternId: string, targetChannelId: string): Note[] => {
  const selected = selectPatternInProjectState(state, targetPatternId);
  const channel = selected.channels.find(candidate => candidate.id === targetChannelId);
  return channel?.notes ?? [];
};

describe('Audio-to-MIDI commit: non-destructive defaults', () => {
  it('appends to existing notes and keeps them intact', () => {
    const state = baseState();
    const result = commitAudioToMidiNotes(state, {
      patternId: patternId(state),
      channelId: channelId(state),
      notes: [transcribed(60, 0), transcribed(64, 2)],
    });
    assert.equal(result.mode, 'append');
    assert.equal(result.notesWritten, 2);
    assert.equal(result.existingNoteCount, 1);
    const notes = notesOf(result.state, patternId(state), channelId(state));
    assert.equal(notes.length, 3);
    assert.ok(notes.some(candidate => candidate.id === 'existing-1'));
    assert.deepEqual(
      notes.filter(candidate => candidate.id.startsWith('audio-to-midi')).map(candidate => `${candidate.pitch}@${candidate.start}`),
      ['60@11', '64@13']
    );
    assert.equal(result.offsetSteps, 11);
    // The caller's state object was not mutated.
    assert.equal(state.channels[0].notes?.length, 1);
  });

  it('refuses to replace existing notes without explicit confirmation', () => {
    const state = baseState();
    assert.throws(
      () =>
        commitAudioToMidiNotes(state, {
          patternId: patternId(state),
          channelId: channelId(state),
          notes: [transcribed(60, 0)],
          mode: 'replace',
        }),
      (error: unknown) =>
        error instanceof AudioToMidiCommitError && error.failure === 'existing-notes'
    );
    assert.equal(state.channels[0].notes?.length, 1, 'a refused commit must not touch state');
  });

  it('replaces when the caller confirms', () => {
    const state = baseState();
    const result = commitAudioToMidiNotes(state, {
      patternId: patternId(state),
      channelId: channelId(state),
      notes: [transcribed(72, 0)],
      mode: 'replace',
      confirmReplace: true,
    });
    const notes = notesOf(result.state, patternId(state), channelId(state));
    assert.equal(notes.length, 1);
    assert.equal(notes[0].pitch, 72);
  });

  it('refuses when the transcription does not fit the destination pattern', () => {
    const state = baseState(); // 32 steps
    assert.throws(
      () =>
        commitAudioToMidiNotes(state, {
          patternId: patternId(state),
          channelId: channelId(state),
          notes: [transcribed(60, 31, 4)],
        }),
      (error: unknown) =>
        error instanceof AudioToMidiCommitError && error.failure === 'pattern-too-short'
    );
  });

  it('refuses unknown destinations and empty note lists', () => {
    const state = baseState();
    assert.throws(
      () => commitAudioToMidiNotes(state, { patternId: 'nope', channelId: channelId(state), notes: [transcribed(60, 0)] }),
      (error: unknown) => error instanceof AudioToMidiCommitError && error.failure === 'unknown-pattern'
    );
    assert.throws(
      () => commitAudioToMidiNotes(state, { patternId: patternId(state), channelId: 'nope', notes: [transcribed(60, 0)] }),
      (error: unknown) => error instanceof AudioToMidiCommitError && error.failure === 'unknown-channel'
    );
    assert.throws(
      () => commitAudioToMidiNotes(state, { patternId: patternId(state), channelId: channelId(state), notes: [] }),
      (error: unknown) => error instanceof AudioToMidiCommitError && error.failure === 'no-notes'
    );
  });
});

describe('Audio-to-MIDI commit: independent patterns', () => {
  it('writes into a non-selected pattern without touching the selected one', () => {
    const state = baseState();
    const second: Pattern = {
      id: 'pattern-b',
      name: 'Pattern B',
      color: '#fff',
      lengthSteps: 32,
    };
    // Adding a pattern selects it; the previous pattern's content is moved into
    // its stored `channelContent`, which is exactly the situation this commit
    // must handle (a destination that is NOT the selected pattern).
    const withSecond = addEmptyPatternToProjectState(state, second);
    assert.equal(withSecond.selectedPatternId, 'pattern-b');
    assert.equal(countChannelNotesInPattern(withSecond, 'pattern-b', channelId(state)), 0);

    const result = commitAudioToMidiNotes(withSecond, {
      patternId: patternId(state),
      channelId: channelId(state),
      notes: [transcribed(60, 0), transcribed(62, 2)],
    });

    // The destination pattern (pat-1, not selected) holds the appended notes...
    assert.equal(countChannelNotesInPattern(result.state, patternId(state), channelId(state)), 3);
    // ...and the selected pattern stays empty.
    assert.equal(countChannelNotesInPattern(result.state, 'pattern-b', channelId(state)), 0);
    // No selection, channel assignment or instrument change happened.
    assert.equal(result.state.selectedPatternId, 'pattern-b');
    assert.equal(result.state.selectedChannelId, withSecond.selectedChannelId);
  });

  it('a replace that the user confirms is still one undo step', () => {
    const state = baseState();
    const result = commitAudioToMidiNotes(state, {
      patternId: patternId(state),
      channelId: channelId(state),
      notes: [transcribed(60, 0, 2)],
      mode: 'replace',
      confirmReplace: true,
    });
    const history = createHistory(state).commit(result.state, 'Audio to MIDI (replace)');
    assert.equal(notesOf(history.present, patternId(state), channelId(state)).length, 1);
    assert.deepEqual(
      notesOf(history.undo().present, patternId(state), channelId(state)).map(note => note.id),
      ['existing-1'],
      'undo restores the replaced note'
    );
  });

  it('appends to a pattern that already has stored content', () => {
    const state = baseState();
    const second: Pattern = { id: 'pattern-c', name: 'Pattern C', color: '#fff', lengthSteps: 32 };
    // Select pattern-c (empty), then select pattern-1 back: pattern-c now owns
    // stored content, so the commit must edit `channelContent`, not the channel.
    let withSecond = addEmptyPatternToProjectState(state, second);
    withSecond = updatePatternChannelContentInProjectState(
      withSecond,
      'pattern-c',
      channelId(state),
      () => ({ notes: [note('c-1', 48, 4)] })
    );
    withSecond = selectPatternInProjectState(withSecond, patternId(state));
    const result = commitAudioToMidiNotes(withSecond, {
      patternId: 'pattern-c',
      channelId: channelId(state),
      notes: [transcribed(72, 8)],
    });
    const entry = result.state.patterns
      .find(candidate => candidate.id === 'pattern-c')
      ?.channelContent?.find(candidate => candidate.channelId === channelId(state));
    assert.ok(entry);
    assert.deepEqual(entry!.notes.map(candidate => candidate.pitch), [48, 72]);
  });
});

describe('Audio-to-MIDI commit: history, persistence and export', () => {
  it('undo restores the previous notes and redo restores the committed ones', () => {
    const state = baseState();
    const result = commitAudioToMidiNotes(state, {
      patternId: patternId(state),
      channelId: channelId(state),
      notes: [transcribed(60, 0), transcribed(67, 4)],
    });

    const history = createHistory(state).commit(result.state, 'Audio to MIDI');
    assert.equal(history.past.length, 1);
    assert.equal(notesOf(history.present, patternId(state), channelId(state)).length, 3);

    const undone = history.undo();
    const afterUndo = notesOf(undone.present, patternId(state), channelId(state));
    assert.deepEqual(afterUndo.map(candidate => candidate.id), ['existing-1']);

    const redone = undone.redo();
    const afterRedo = notesOf(redone.present, patternId(state), channelId(state));
    // Appended content starts after the note that was already there (step 11).
    assert.deepEqual(
      afterRedo.map(candidate => `${candidate.pitch}@${candidate.start}`),
      ['55@10', '60@11', '67@15']
    );
  });

  it('survives a save → load cycle with the notes intact', () => {
    const state = baseState();
    const result = commitAudioToMidiNotes(state, {
      patternId: patternId(state),
      channelId: channelId(state),
      notes: [transcribed(60, 0, 2), transcribed(64, 2, 2)],
    });
    const serialized = serializeProjectState(result.state);
    const loaded = normalizeProjectState(JSON.parse(serialized).state);
    const restored = notesOf(loaded, patternId(state), channelId(state));
    assert.deepEqual(
      restored.map(candidate => [candidate.pitch, candidate.start, candidate.duration]),
      [[55, 10, 1], [60, 11, 2], [64, 13, 2]]
    );
  });

  it('keeps Piano Roll edits to committed notes through history and save → load', () => {
    const state = baseState();
    const result = commitAudioToMidiNotes(state, {
      patternId: patternId(state),
      channelId: channelId(state),
      notes: [transcribed(60, 0, 2), transcribed(64, 4, 2)],
    });

    // The Piano Roll's own edit helpers operate on the committed notes exactly
    // like on recorded or imported ones: transposing a note and lengthening it
    // are ordinary Note edits.
    const notes = notesOf(result.state, patternId(state), channelId(state));
    const transposed = transposeNotes(notes, [notes[1].id], 12);
    const resized = transposed.map(note =>
      note.id === notes[1].id ? resizeNoteRight(note, note.start + 4) : note
    );
    const target = resized.find(note => note.id === notes[1].id);
    assert.ok(target);
    assert.equal(target!.pitch, 72);
    assert.equal(target!.duration, 4);

    const edited = updatePatternChannelContentInProjectState(
      result.state,
      patternId(state),
      channelId(state),
      () => ({ notes: resized })
    );
    const history = createHistory(state).commit(result.state, 'Audio to MIDI').commit(edited, 'Edit note');
    const undone = history.undo();
    assert.deepEqual(
      notesOf(undone.present, patternId(state), channelId(state)).map(note => note.pitch),
      [55, 60, 64]
    );
    const redone = undone.redo();
    assert.deepEqual(
      notesOf(redone.present, patternId(state), channelId(state)).map(note => note.pitch),
      [55, 72, 64]
    );

    const loaded = normalizeProjectState(JSON.parse(serializeProjectState(redone.present)).state);
    const restored = notesOf(loaded, patternId(state), channelId(state)).find(note => note.pitch === 72);
    assert.ok(restored, 'the edited note survives save → load');
    assert.equal(restored!.duration, 4);
  });

  it('exports the committed notes in the Standard MIDI file', async () => {
    const state = baseState();
    const result = commitAudioToMidiNotes(state, {
      patternId: patternId(state),
      channelId: channelId(state),
      notes: [transcribed(60, 0), transcribed(64, 4), transcribed(67, 8)],
    });
    // Export exactly the target channel (its committed notes are the live
    // content of the selected pattern).
    const channels = result.state.channels
      .filter(candidate => candidate.id === channelId(state))
      .map(candidate => ({ ...candidate, notes: notesOf(result.state, patternId(state), channelId(state)) }));
    const blob = buildStandardMidiFile(
      channels,
      [],
      { ...result.state.meta, bpm: 120, timeSignature: [4, 4] },
      {
        scope: 'pattern',
        patternLengthSteps: 32,
        totalBars: 2,
        patterns: result.state.patterns,
      }
    );
    const buffer = await blob.arrayBuffer();
    const parsed = await MidiParser.parseMidiFile(buffer);
    const exported = parsed.flatMap(track => track.notes).map(entry => entry.pitch);
    // The pattern repeats to fill the export window, so pitches appear more
    // than once; what matters is that every committed note is in the file.
    assert.deepEqual([...new Set(exported)].sort((a, b) => a - b), [55, 60, 64, 67]);
    assert.ok(exported.length >= 4);
  });
});

describe('Audio-to-MIDI commit: conversions and helpers', () => {
  it('legalises durations onto the project grid and keeps velocity in range', () => {
    const notes = toProjectNotes([
      { ...transcribed(60, 0, 0.6), velocity: 3 },
      { ...transcribed(62, 2, 0.1), velocity: -1 },
    ]);
    assert.equal(notes[0].duration, 0.5);
    assert.equal(notes[0].velocity, 1);
    assert.equal(notes[1].duration, 0.25);
    assert.equal(notes[1].velocity, 0.05);
  });

  it('rejects an unusable note instead of writing a broken one', () => {
    assert.throws(
      () => toProjectNotes([{ ...transcribed(60, 0), midi: 200 }]),
      (error: unknown) => error instanceof AudioToMidiCommitError && error.failure === 'invalid-note'
    );
  });

  it('reports how much of the destination is already occupied', () => {
    const state = baseState();
    assert.equal(lastOccupiedStep(state, patternId(state), channelId(state)), 11);
  });
});
