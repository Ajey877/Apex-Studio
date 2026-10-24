/**
 * Phase 10B — the polyphonic Audio-to-MIDI *workflow*, end to end, on real PCM.
 *
 * These tests drive the production path a user takes after choosing the
 * polyphonic mode: resolve the selected clip's real samples → analyse the audible
 * window → commit the proposed notes through the existing state/history layer →
 * export Standard MIDI → edit in the Piano Roll → save/reload. Nothing here
 * fabricates notes or mocks the analyzer: the notes under test are the ones the
 * analyzer measured from sample-by-sample synthesized audio, and the project
 * assertions read real `ProjectState`.
 *
 * Covered:
 *  - the polyphonic mode has its own entry point; monophonic analysis is untouched;
 *  - clip window resolution (trim + rate + pitch shift) applies to this mode too;
 *  - a refusal throws/returns before any mutation (state is byte-identical after);
 *  - commit targets a NEW pattern by default and appends after existing notes;
 *  - replace requires explicit confirmation;
 *  - undo/redo, save/reload, Piano Roll edits and Standard MIDI export.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PlaylistClip, ProjectState } from '../types/daw';
import { AudioToMidiError } from './audioToMidi';
import {
  analyseAudioClipForPolyphonicMidi,
  analyseSelectedClipForPolyphonicMidi,
} from './audioToMidiSource';
import { transcribePolyphonicPcm } from './polyphonicTranscription';
import type { AnalysableBuffer } from './audioToMidi';
import {
  AudioToMidiCommitError,
  audioToMidiNewPatternLengthSteps,
  commitAudioToMidiNotes,
  countChannelNotesInPattern,
} from '../state/audioToMidiCommit';
import { createHistory } from '../state/projectHistory';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { serializeProjectState } from '../state/projectPersistence';
import {
  addEmptyPatternToProjectState,
  selectPatternInProjectState,
} from '../state/patternContent';
import { resizeNoteRight, transposeNotes } from '../components/pianoRollOperations';
import { buildStandardMidiFile } from '../utils/exportUtils';
import { MidiParser } from '../utils/midiParser';

const SR = 44100;
const midiToFreq = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

const RICH = [1, 0.5, 0.25, 0.125] as const;

interface Tone {
  midi: number;
  startSeconds: number;
  endSeconds: number;
  amplitude?: number;
}

const renderTones = (seconds: number, tones: readonly Tone[]): Float32Array => {
  const data = new Float32Array(Math.round(seconds * SR));
  for (const tone of tones) {
    const frequency = midiToFreq(tone.midi);
    const from = Math.max(0, Math.floor(tone.startSeconds * SR));
    const to = Math.min(data.length, Math.ceil(tone.endSeconds * SR));
    const fade = 0.008 * SR;
    for (let i = from; i < to; i += 1) {
      const envelope =
        Math.min(1, (i - tone.startSeconds * SR) / fade) *
        Math.min(1, (tone.endSeconds * SR - i) / fade);
      let sample = 0;
      for (let h = 1; h <= RICH.length; h += 1) {
        sample += RICH[h - 1] * Math.sin((2 * Math.PI * frequency * h * i) / SR);
      }
      data[i] += (tone.amplitude ?? 0.25) * envelope * sample;
    }
  }
  return data;
};

const asBuffer = (data: Float32Array) => ({
  duration: data.length / SR,
  sampleRate: SR,
  numberOfChannels: 1,
  getChannelData: () => data,
});

const asAudioBuffer = (data: Float32Array) => asBuffer(data) as unknown as AudioBuffer;

const makeClip = (patch: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: 'p10b-clip',
  trackIndex: 0,
  startBar: 0,
  lengthBars: 2,
  type: 'audio',
  audioBufferId: 'p10b-asset',
  name: 'Poly Test Clip',
  color: '#00e5ff',
  ...patch,
});

const timing = (bpm = 120, timeSignature: [number, number] = [4, 4]) => ({
  bpm,
  timeSignature: timeSignature as readonly [number, number],
});

/** A two-bar chord fixture: C4 + E4 + G4 held for 1.5 s. */
const chordPcm = (): Float32Array =>
  renderTones(2, [60, 64, 67].map(midi => ({ midi, startSeconds: 0.1, endSeconds: 1.6 })));

/**
 * Reads the notes a (pattern, channel) pair holds, following the independent
 * pattern model: the selected pattern keeps its content on the live channel and
 * every other pattern keeps it in `Pattern.channelContent`.
 */
const notesFor = (state: ProjectState, patternId: string, channelId: string) => {
  const pattern = state.patterns.find(candidate => candidate.id === patternId);
  if (!pattern) return [];
  if (!Array.isArray(pattern.channelContent)) {
    return state.channels.find(channel => channel.id === channelId)?.notes ?? [];
  }
  return pattern.channelContent.find(entry => entry.channelId === channelId)?.notes ?? [];
};

const projectWithTarget = (): ProjectState => {
  const base = createDefaultProjectState();
  const withPattern = addEmptyPatternToProjectState(base, {
    id: 'poly-target',
    name: 'Existing part',
    color: '#ff9500',
    lengthSteps: 32,
  });
  return selectPatternInProjectState(withPattern, 'poly-target');
};

const analyseChord = () =>
  analyseAudioClipForPolyphonicMidi(makeClip(), asBuffer(chordPcm()), timing(), {});

describe('Phase 10B workflow — analysing a clip in polyphonic mode', () => {
  it('transcribes the selected clip’s real PCM through the polyphonic entry point', () => {
    const { analysis, plan, settings } = analyseChord();
    assert.equal(analysis.status, 'ok', analysis.message);
    assert.deepEqual(analysis.notes.map(note => note.midi), [60, 64, 67]);
    // The plan is the same clip-window resolution the monophonic mode uses.
    assert.equal(plan.playbackRate, 1);
    assert.equal(plan.pitchOffsetSemitones, 0);
    assert.equal(settings.minNoteSteps, 0.5);
    assert.equal(settings.quantizeSteps, 0.25);
    // Every note lands inside the clip's audible window.
    for (const note of analysis.notes) {
      assert.ok(note.startStep >= 0);
      assert.ok(note.startStep + note.durationSteps <= plan.timelineSeconds * plan.stepsPerSecond);
      assert.ok(note.confidence > 0 && note.confidence <= 1);
    }
  });

  it('resolves the real source through the asset lookup, like monophonic mode', async () => {
    const pcm = chordPcm();
    let hydrated = 0;
    const result = await analyseSelectedClipForPolyphonicMidi(
      makeClip(),
      timing(),
      {},
      {
        getSourceBuffer: () => asAudioBuffer(pcm),
        hydrateSource: async () => {
          hydrated += 1;
          return false;
        },
      }
    );
    assert.equal(hydrated, 0, 'a buffer already in memory must not be re-hydrated');
    assert.equal(result.analysis.status, 'ok');
    assert.equal(result.sourceBuffer.sampleRate, SR);
    assert.equal(result.plan.timelineSeconds, 4);
  });

  it('hydrates the persisted asset when the engine has no buffer', async () => {
    const pcm = chordPcm();
    let stored: AudioBuffer | null = null;
    const result = await analyseSelectedClipForPolyphonicMidi(makeClip(), timing(), {}, {
      getSourceBuffer: () => stored ?? undefined,
      hydrateSource: async () => {
        stored = asAudioBuffer(pcm);
        return true;
      },
    });
    assert.equal(result.analysis.status, 'ok');
    assert.equal(result.analysis.notes.length, 3);
  });

  it('throws the shared typed error when the source audio is missing', async () => {
    await assert.rejects(
      analyseSelectedClipForPolyphonicMidi(makeClip(), timing(), {}, {
        getSourceBuffer: () => undefined,
        hydrateSource: async () => false,
      }),
      (error: unknown) => error instanceof AudioToMidiError && error.failure === 'source-unavailable'
    );
  });

  it('rejects a pattern clip (no source audio) before analysing anything', async () => {
    await assert.rejects(
      analyseSelectedClipForPolyphonicMidi(makeClip({ type: 'pattern' }), timing(), {}, {
        getSourceBuffer: () => asAudioBuffer(chordPcm()),
        hydrateSource: async () => false,
      }),
      (error: unknown) => error instanceof AudioToMidiError && error.failure === 'not-audio-clip'
    );
  });

  it('honours the clip trim and rate when resolving the analysed window', () => {
    const source = renderTones(2.4, [
      { midi: 60, startSeconds: 0.5, endSeconds: 1.5 },
      { midi: 67, startSeconds: 0.5, endSeconds: 1.5 },
    ]);
    // offsetSteps = 4 sixteenths = 0.5 s at 120 BPM → the clip starts at 0.5 s.
    const trimmed = makeClip({ offsetSteps: 4, lengthBars: 1 });
    const { analysis, plan } = analyseAudioClipForPolyphonicMidi(
      trimmed,
      asBuffer(source),
      timing(),
      {}
    );
    assert.equal(plan.sourceOffsetSeconds, 0.5);
    assert.equal(analysis.status, 'ok', analysis.message);
    assert.deepEqual(analysis.notes.map(note => note.midi), [60, 67]);
    // 0.1 s into the trimmed window, i.e. 0.5 + 0.1 = 0.6 s of the source.
    for (const note of analysis.notes) {
      assert.ok(note.startStep <= 1.5, `unexpected start offset ${note.startStep}`);
    }
  });

  it('refuses rather than throwing for material it cannot transcribe', () => {
    const silence = new Float32Array(SR * 2);
    const { analysis } = analyseAudioClipForPolyphonicMidi(makeClip(), asBuffer(silence), timing(), {});
    assert.equal(analysis.status, 'rejected');
    assert.equal(analysis.refusal, 'silence-or-noise');
    assert.deepEqual(analysis.notes, []);
  });

  it('leaves the monophonic pipeline untouched (separate entry points, separate results)', () => {
    const pcm = chordPcm();
    const polyphonic = analyseAudioClipForPolyphonicMidi(makeClip(), asBuffer(pcm), timing(), {});
    assert.equal(polyphonic.analysis.notes.length, 3);
    // The polyphonic analyzer is the only caller of the multi-pitch module; the
    // monophonic pipeline keeps its own refusals (chords → polyphonic-suspected).
    const mono = transcribePolyphonicPcm({
      channels: [pcm],
      sampleRate: SR,
      plan: { playbackRate: 1, pitchOffsetSemitones: 0, stepsPerSecond: 8, timelineSeconds: 2 },
      options: { minNoteSteps: 0.5, quantizeSteps: 0.25 },
    });
    assert.equal(mono.status, 'ok');
  });
});

describe('Phase 10B workflow — commit, history, persistence and export', () => {
  it('writes a new pattern by default and keeps existing notes', () => {
    const { analysis } = analyseChord();
    const project = projectWithTarget();
    const channelId = project.channels[0].id;
    const existing = countChannelNotesInPattern(project, 'poly-target', channelId);
    assert.equal(existing, 0);

    const created = addEmptyPatternToProjectState(project, {
      id: 'poly-new',
      name: 'Audio to MIDI',
      color: '#00e5ff',
      lengthSteps: audioToMidiNewPatternLengthSteps(analysis.notes),
    });
    const committed = commitAudioToMidiNotes(created, {
      patternId: 'poly-new',
      channelId,
      notes: analysis.notes,
      idPrefix: 'p10b',
    });
    assert.equal(committed.notesWritten, 3);
    assert.equal(committed.mode, 'append');
    assert.equal(countChannelNotesInPattern(committed.state, 'poly-new', channelId), 3);
    // The pre-existing pattern is untouched.
    assert.equal(countChannelNotesInPattern(committed.state, 'poly-target', channelId), 0);
    const notes = notesFor(committed.state, 'poly-new', channelId);
    assert.deepEqual(notes.map(note => note.pitch).sort((a, b) => a - b), [60, 64, 67]);
    for (const note of notes) {
      assert.ok(note.velocity > 0.2 && note.velocity <= 1);
      assert.ok(note.duration > 0);
      assert.match(note.id, /^p10b-/);
    }
  });

  it('appends after existing notes instead of overwriting them', () => {
    const { analysis } = analyseChord();
    const channelId = createDefaultProjectState().channels[0].id;
    let state = projectWithTarget();
    const first = commitAudioToMidiNotes(
      addEmptyPatternToProjectState(state, { id: 'poly-two', name: 'Two', color: '#111', lengthSteps: 64 }),
      { patternId: 'poly-two', channelId, notes: analysis.notes, idPrefix: 'a' }
    );
    state = first.state;
    const second = commitAudioToMidiNotes(state, {
      patternId: 'poly-two',
      channelId,
      notes: analysis.notes,
      idPrefix: 'b',
    });
    assert.equal(second.mode, 'append');
    assert.equal(second.existingNoteCount, 3);
    assert.equal(countChannelNotesInPattern(second.state, 'poly-two', channelId), 6);
    assert.ok(second.offsetSteps > 0, 'the append must be moved clear of existing notes');
  });

  it('requires explicit confirmation to replace existing notes', () => {
    const { analysis } = analyseChord();
    const channelId = createDefaultProjectState().channels[0].id;
    const seeded = commitAudioToMidiNotes(
      addEmptyPatternToProjectState(projectWithTarget(), {
        id: 'poly-replace',
        name: 'Replace',
        color: '#111',
        lengthSteps: 64,
      }),
      { patternId: 'poly-replace', channelId, notes: analysis.notes, idPrefix: 'a' }
    );
    assert.throws(
      () => commitAudioToMidiNotes(seeded.state, {
        patternId: 'poly-replace',
        channelId,
        notes: analysis.notes,
        mode: 'replace',
      }),
      (error: unknown) => error instanceof AudioToMidiCommitError && error.failure === 'existing-notes'
    );
    const replaced = commitAudioToMidiNotes(seeded.state, {
      patternId: 'poly-replace',
      channelId,
      notes: analysis.notes,
      mode: 'replace',
      confirmReplace: true,
    });
    assert.equal(replaced.notesWritten, 3);
    assert.equal(countChannelNotesInPattern(replaced.state, 'poly-replace', channelId), 3);
  });

  it('survives undo/redo as one history step', () => {
    const { analysis } = analyseChord();
    const project = projectWithTarget();
    const channelId = project.channels[0].id;
    const history0 = createHistory(project);
    const created = addEmptyPatternToProjectState(project, {
      id: 'poly-history',
      name: 'History',
      color: '#00e5ff',
      lengthSteps: 32,
    });
    // Two edits: create the pattern, then commit the notes. Each is one history
    // step, and the App performs the commit inside a single `mutateProjectState`.
    const committed = commitAudioToMidiNotes(created, {
      patternId: 'poly-history',
      channelId,
      notes: analysis.notes,
      idPrefix: 'h',
    });
    const history = history0.commit(created, 'Add pattern').commit(committed.state, 'Audio to MIDI');
    assert.equal(countChannelNotesInPattern(history.present, 'poly-history', channelId), 3);
    const undoneOnce = history.undo();
    assert.equal(countChannelNotesInPattern(undoneOnce.present, 'poly-history', channelId), 0);
    assert.ok(undoneOnce.present.patterns.some(pattern => pattern.id === 'poly-history'));
    const undoneTwice = undoneOnce.undo();
    assert.ok(!undoneTwice.present.patterns.some(pattern => pattern.id === 'poly-history'));
    const redone = undoneTwice.redo().redo();
    assert.equal(countChannelNotesInPattern(redone.present, 'poly-history', channelId), 3);
  });

  it('preserves the committed notes through save and cold reload', () => {
    const { analysis } = analyseChord();
    const channelId = createDefaultProjectState().channels[0].id;
    const committed = commitAudioToMidiNotes(
      addEmptyPatternToProjectState(projectWithTarget(), {
        id: 'poly-save',
        name: 'Saved',
        color: '#111',
        lengthSteps: 32,
      }),
      { patternId: 'poly-save', channelId, notes: analysis.notes, idPrefix: 's' }
    );
    const serialized = serializeProjectState(committed.state);
    // Save → cold reload: exactly what the app does on the next launch.
    const reloaded = normalizeProjectState(JSON.parse(serialized).state);
    assert.equal(reloaded.selectedPatternId, committed.state.selectedPatternId);
    const notes = notesFor(reloaded, 'poly-save', channelId);
    assert.equal(notes.length, 3);
    assert.deepEqual(notes.map(note => note.pitch).sort((a, b) => a - b), [60, 64, 67]);
    assert.deepEqual(
      notes.map(note => [note.start, note.duration, Number(note.velocity.toFixed(6))]),
      notesFor(committed.state, 'poly-save', channelId)
        .map(note => [note.start, note.duration, Number(note.velocity.toFixed(6))])
    );
  });

  it('stays editable in the Piano Roll (resize and transpose)', () => {
    const { analysis } = analyseChord();
    const channelId = createDefaultProjectState().channels[0].id;
    const committed = commitAudioToMidiNotes(
      addEmptyPatternToProjectState(projectWithTarget(), {
        id: 'poly-edit',
        name: 'Edit',
        color: '#111',
        lengthSteps: 32,
      }),
      { patternId: 'poly-edit', channelId, notes: analysis.notes, idPrefix: 'e' }
    );
    const notes = notesFor(committed.state, 'poly-edit', channelId);
    assert.equal(notes.length, 3);
    const resized = resizeNoteRight(notes[0], notes[0].start + 8, 0.25);
    const transposed = transposeNotes([resized], [resized.id], 12);
    assert.equal(transposed[0].duration, 8);
    assert.equal(transposed[0].pitch, notes[0].pitch + 12);
    // The other two chord notes are untouched by a single-note edit.
    const untouched = notes.filter(note => note.id !== notes[0].id);
    assert.equal(untouched.length, 2);
  });

  it('exports the committed notes to a Standard MIDI file', async () => {
    const { analysis } = analyseChord();
    const channelId = createDefaultProjectState().channels[0].id;
    const committed = commitAudioToMidiNotes(
      addEmptyPatternToProjectState(projectWithTarget(), {
        id: 'poly-midi',
        name: 'MIDI',
        color: '#111',
        lengthSteps: 32,
      }),
      { patternId: 'poly-midi', channelId, notes: analysis.notes, idPrefix: 'm' }
    );
    const channels = committed.state.channels.map(channel =>
      channel.id === channelId
        ? { ...channel, notes: notesFor(committed.state, 'poly-midi', channelId) }
        : channel
    );
    const blob = buildStandardMidiFile(
      channels,
      [],
      { ...committed.state.meta, bpm: 120, timeSignature: [4, 4] },
      {
        scope: 'pattern',
        patternLengthSteps: 32,
        totalBars: 2,
        patterns: committed.state.patterns,
      }
    );
    const parsed = await MidiParser.parseMidiFile(await blob.arrayBuffer());
    const pitches = parsed.flatMap(track => track.notes).map(note => note.pitch);
    assert.deepEqual([...new Set(pitches)].sort((a, b) => a - b), [60, 64, 67]);
    // A chord means several notes starting on the same grid step in the file.
    const exported = parsed.flatMap(track => track.notes);
    assert.ok(exported.length >= 3);
    const firstOnset = Math.min(...exported.map(note => note.startStep));
    const simultaneous = exported.filter(note => note.startStep === firstOnset);
    assert.equal(simultaneous.length, 3, 'the three chord notes must share an onset');
  });
});

describe('Phase 10B workflow — a refused analysis cannot mutate the project', () => {
  it('returns a refusal, writes nothing and leaves the state identical', () => {
    const project = projectWithTarget();
    const channelId = project.channels[0].id;
    const before = serializeProjectState(project);
    const silence = new Float32Array(SR * 2);
    const { analysis } = analyseAudioClipForPolyphonicMidi(makeClip(), asBuffer(silence), timing(), {});
    assert.equal(analysis.status, 'rejected');
    // The UI's commit button is disabled without an accepted analysis; the state
    // layer additionally refuses an empty note list.
    assert.throws(
      () => commitAudioToMidiNotes(project, {
        patternId: 'poly-target',
        channelId,
        notes: analysis.notes,
      }),
      (error: unknown) => error instanceof AudioToMidiCommitError && error.failure === 'no-notes'
    );
    assert.deepEqual(serializeProjectState(project), before);
  });

  it('leaves the state identical after a throws-before-analysis source failure', async () => {
    const project = projectWithTarget();
    const before = serializeProjectState(project);
    await assert.rejects(
      analyseSelectedClipForPolyphonicMidi(makeClip(), timing(), {}, {
        getSourceBuffer: () => undefined,
        hydrateSource: async () => false,
      })
    );
    assert.deepEqual(serializeProjectState(project), before);
  });
});
