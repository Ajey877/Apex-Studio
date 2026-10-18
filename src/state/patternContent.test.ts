/**
 * Independent patterns — state-model regression coverage.
 *
 * Pre-fix defect (reproduced in Chromium against the shipped demo): every
 * pattern shared one set of channel content. "Add pattern" produced a pattern
 * that already contained the whole beat, toggling a step in "Pattern 4"
 * removed it from "Main Groove", and the playlist could not place a different
 * pattern for the same instrument. These tests pin the repaired contract:
 *
 *   AC1  a new pattern starts empty; the previous pattern keeps its content;
 *   AC2  editing the selected pattern never changes another pattern;
 *   AC3  clone copies a pattern exactly, and the copy is independent;
 *   AC4  selecting a pattern never changes what any placed clip plays;
 *   AC5  legacy (shared-content) documents load and round-trip unchanged, and
 *        become independent — content preserved — at the first pattern operation;
 *   AC6  save/reload, undo/redo and channel deletion keep every pattern exact;
 *   AC7  a MIDI take lands in the pattern it started in.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Channel, Note, Pattern, PlaylistClip, ProjectState } from '../types/daw';
import {
  addEmptyPatternToProjectState,
  clonePatternInProjectState,
  countProjectNotes,
  ensureIndependentPatterns,
  hasStoredPatternContent,
  normalizePatternContentModel,
  removeChannelFromPatternContent,
  resolveClipChannelContent,
  resolvePatternChannelContent,
  selectPatternInProjectState,
} from './patternContent';
import { createDefaultProjectState, deleteChannelFromProjectState, normalizeProjectState } from './projectState';
import { addPatternToProjectState, updateChannelInProjectState } from './projectMutations';
import { serializeProjectState } from './projectPersistence';
import { createHistory } from './projectHistory';
import { getProjectFingerprint, isPristineProject } from './projectReplacement';
import { toggleChannelStep } from '../components/channelRackOperations';
import { appendRecordedNotesToChannelInProjectState } from '../audio/midiRecording';
import {
  createPlaylistPatternClip,
  setPlaylistClipPattern,
} from '../components/playlistClipOperations';
import { findLaneBouncePatternClip } from '../components/playlistBounceTarget';
import { DEFAULT_PROJECT, PRESET_PROJECTS } from '../audio/presets';

const note = (id: string, pitch: number, start: number): Note => ({ id, pitch, start, duration: 1, velocity: 0.8 });

const activeSteps = (steps: readonly boolean[]): number[] =>
  steps.flatMap((on, index) => (on ? [index] : []));

const channelById = (state: ProjectState, id: string): Channel => {
  const channel = state.channels.find(candidate => candidate.id === id);
  assert.ok(channel, `channel ${id} exists`);
  return channel;
};

const patternById = (state: ProjectState, id: string): Pattern => {
  const pattern = state.patterns.find(candidate => candidate.id === id);
  assert.ok(pattern, `pattern ${id} exists`);
  return pattern;
};

/** What the Channel Rack shows for `channelId` once `patternId` is selected. */
const contentOf = (state: ProjectState, patternId: string, channelId: string) => {
  const selected = selectPatternInProjectState(state, patternId);
  const channel = channelById(selected, channelId);
  return { steps: activeSteps(channel.steps), notes: channel.notes.map(n => `${n.pitch}@${n.start}`) };
};

const toggle = (state: ProjectState, channelId: string, step: number): ProjectState =>
  updateChannelInProjectState(state, channelId, { steps: toggleChannelStep(channelById(state, channelId), step) });

const pattern = (id: string, name = id): Pattern => ({ id, name, color: '#ff6e00', lengthSteps: 16 });

/** A default project (kick 0/4/8/12, snare 4/12) with a melody note on ch-1. */
const baseState = (): ProjectState => {
  const state = createDefaultProjectState();
  state.channels[0].notes = [note('k-n1', 36, 2)];
  return state;
};

const patternClip = (id: string, channelId: string, startBar: number, patternId?: string): PlaylistClip => ({
  id,
  trackIndex: 0,
  startBar,
  lengthBars: 1,
  type: 'pattern',
  channelId,
  color: '#ff6e00',
  name: id,
  ...(patternId ? { patternId } : {}),
});

describe('AC1: a new pattern starts empty and the previous pattern keeps its content', () => {
  it('Add pattern selects an empty pattern and stores Pattern 1 unchanged', () => {
    const before = baseState();
    const after = addPatternToProjectState(before, pattern('pat-2', 'Pattern 2'));

    assert.equal(after.selectedPatternId, 'pat-2');
    for (const channel of after.channels) {
      assert.deepEqual(activeSteps(channel.steps), [], `${channel.id} has no active steps in the new pattern`);
      assert.deepEqual(channel.notes, [], `${channel.id} has no notes in the new pattern`);
    }
    assert.deepEqual(contentOf(after, 'pat-1', 'ch-1'), { steps: [0, 4, 8, 12], notes: ['36@2'] });
    assert.deepEqual(contentOf(after, 'pat-1', 'ch-2'), { steps: [4, 12], notes: [] });
  });

  it('every non-content channel field survives the switch', () => {
    const before = baseState();
    const after = addEmptyPatternToProjectState(before, pattern('pat-2'));
    for (const channel of before.channels) {
      const { steps: _s, notes: _n, ...rest } = channel;
      const { steps: _s2, notes: _n2, ...afterRest } = channelById(after, channel.id);
      assert.deepEqual(afterRest, rest);
    }
  });

  it('a duplicate pattern id is a no-op', () => {
    const state = baseState();
    assert.equal(addEmptyPatternToProjectState(state, pattern('pat-1')), state);
  });
});

describe('AC2: editing the selected pattern never changes another pattern', () => {
  it('toggling a step in Pattern 2 leaves Pattern 1 untouched (the shipped defect)', () => {
    let state = addPatternToProjectState(baseState(), pattern('pat-2'));
    state = toggle(state, 'ch-1', 0);
    state = toggle(state, 'ch-1', 6);

    assert.deepEqual(contentOf(state, 'pat-1', 'ch-1'), { steps: [0, 4, 8, 12], notes: ['36@2'] });
    assert.deepEqual(contentOf(state, 'pat-2', 'ch-1'), { steps: [0, 6], notes: [] });
  });

  it('edits made in Pattern 1 after switching back stay in Pattern 1', () => {
    let state = addPatternToProjectState(baseState(), pattern('pat-2'));
    state = toggle(state, 'ch-2', 2);
    state = selectPatternInProjectState(state, 'pat-1');
    state = toggle(state, 'ch-2', 8);

    assert.deepEqual(contentOf(state, 'pat-1', 'ch-2'), { steps: [4, 8, 12], notes: [] });
    assert.deepEqual(contentOf(state, 'pat-2', 'ch-2'), { steps: [2], notes: [] });
  });

  it('switching back and forth is lossless', () => {
    let state = addPatternToProjectState(baseState(), pattern('pat-2'));
    state = toggle(state, 'ch-1', 3);
    const roundTripped = selectPatternInProjectState(selectPatternInProjectState(state, 'pat-1'), 'pat-2');
    assert.deepEqual(roundTripped.channels, state.channels);
    assert.deepEqual(contentOf(roundTripped, 'pat-1', 'ch-1'), contentOf(state, 'pat-1', 'ch-1'));
  });

  it('re-selecting the selected pattern or an unknown id returns the same state', () => {
    const state = baseState();
    assert.equal(selectPatternInProjectState(state, 'pat-1'), state);
    assert.equal(selectPatternInProjectState(state, 'missing'), state);
  });
});

describe('AC3: clone pattern', () => {
  it('copies every channel and the declared length, and selects the copy', () => {
    const source = { ...baseState() };
    source.patterns = [{ ...source.patterns[0], lengthSteps: 32 }];
    const cloned = clonePatternInProjectState(source, 'pat-1', pattern('pat-copy', 'Pattern 1 (copy)'));

    assert.equal(cloned.selectedPatternId, 'pat-copy');
    assert.equal(patternById(cloned, 'pat-copy').lengthSteps, 32);
    assert.deepEqual(contentOf(cloned, 'pat-copy', 'ch-1'), { steps: [0, 4, 8, 12], notes: ['36@2'] });
    assert.deepEqual(contentOf(cloned, 'pat-copy', 'ch-2'), { steps: [4, 12], notes: [] });
  });

  it('the copy is independent of its source in both directions', () => {
    let state = clonePatternInProjectState(baseState(), 'pat-1', pattern('pat-copy'));
    state = toggle(state, 'ch-1', 4);
    assert.deepEqual(contentOf(state, 'pat-1', 'ch-1').steps, [0, 4, 8, 12]);
    state = selectPatternInProjectState(state, 'pat-1');
    state = toggle(state, 'ch-1', 15);
    assert.deepEqual(contentOf(state, 'pat-copy', 'ch-1').steps, [0, 8, 12]);
  });

  it('can clone a pattern that is not selected', () => {
    let state = addPatternToProjectState(baseState(), pattern('pat-2'));
    state = toggle(state, 'ch-2', 9);
    state = clonePatternInProjectState(state, 'pat-1', pattern('pat-3'));
    assert.deepEqual(activeSteps(channelById(state, 'ch-1').steps), [0, 4, 8, 12]);
    assert.deepEqual(contentOf(state, 'pat-2', 'ch-2').steps, [9]);
  });

  it('an unknown source or duplicate id is a no-op', () => {
    const state = baseState();
    assert.equal(clonePatternInProjectState(state, 'missing', pattern('pat-x')), state);
    assert.equal(clonePatternInProjectState(state, 'pat-1', pattern('pat-1')), state);
  });
});

describe('AC4: selecting a pattern never changes what a placed clip plays', () => {
  it('every clip resolves to the same content before and after a swap', () => {
    let state = addPatternToProjectState(baseState(), pattern('pat-2'));
    state = toggle(state, 'ch-1', 2);
    state = {
      ...state,
      playlistClips: [patternClip('c1', 'ch-1', 0, 'pat-1'), patternClip('c2', 'ch-1', 1, 'pat-2')],
    };
    const resolveAll = (s: ProjectState) => s.playlistClips.map(clip => {
      const content = resolveClipChannelContent(s.patterns, clip, channelById(s, 'ch-1'));
      return { steps: activeSteps(content.steps), notes: content.notes.map(n => n.id) };
    });
    const before = resolveAll(state);
    assert.deepEqual(before, [{ steps: [0, 4, 8, 12], notes: ['k-n1'] }, { steps: [2], notes: [] }]);
    assert.deepEqual(resolveAll(selectPatternInProjectState(state, 'pat-1')), before);
  });

  it('a channel with no content in a pattern resolves to empty there', () => {
    const state = addPatternToProjectState(baseState(), pattern('pat-2'));
    const parked = selectPatternInProjectState(state, 'pat-1');
    const content = resolvePatternChannelContent(patternById(parked, 'pat-2'), {
      id: 'ch-new',
      steps: [true],
      notes: [note('x', 60, 0)],
    });
    assert.deepEqual(content.steps, []);
    assert.deepEqual(content.notes, []);
  });

  it('new playlist clips are stamped with the pattern they play; clips can be re-targeted', () => {
    const state = addPatternToProjectState(baseState(), pattern('pat-2'));
    const clip = createPlaylistPatternClip(0, 0, state.channels[0], state.playlistTracks[0], 4, 'clip-new', {}, patternById(state, 'pat-2'));
    assert.equal(clip.patternId, 'pat-2');
    const legacy = createPlaylistPatternClip(0, 0, state.channels[0], state.playlistTracks[0], 4, 'clip-legacy');
    assert.equal('patternId' in legacy, false, 'callers without a pattern keep the historical clip shape');

    const retargeted = setPlaylistClipPattern([clip], 'clip-new', state.patterns, 'pat-1');
    assert.equal(retargeted[0].patternId, 'pat-1');
    assert.throws(() => setPlaylistClipPattern([clip], 'clip-new', state.patterns, 'nope'), /Pattern not found/);
  });

  it('a lane bounce renders the pattern its earliest clip plays', () => {
    const clips = [
      patternClip('late', 'ch-1', 4, 'pat-1'),
      patternClip('early', 'ch-1', 1, 'pat-2'),
      { ...patternClip('other-lane', 'ch-1', 0, 'pat-1'), trackIndex: 3 },
    ];
    assert.equal(findLaneBouncePatternClip(clips, 0, 'ch-1')?.id, 'early');
    assert.equal(findLaneBouncePatternClip(clips, 0, 'ch-2'), undefined);
  });
});

describe('AC5: legacy shared-content documents', () => {
  /** A document saved before patterns owned content: three patterns, no stored content. */
  const legacyState = (): ProjectState => {
    const state = baseState();
    state.patterns = [pattern('pat-1', 'Main'), pattern('pat-2', 'Melody'), pattern('pat-3', 'Hats')];
    state.selectedPatternId = 'pat-2';
    state.playlistClips = [patternClip('legacy-1', 'ch-1', 0), patternClip('legacy-2', 'ch-2', 1)];
    return state;
  };

  it('every legacy pattern resolves to the live content, exactly as before', () => {
    const state = legacyState();
    for (const p of state.patterns) {
      const content = resolvePatternChannelContent(p, channelById(state, 'ch-1'));
      assert.deepEqual(activeSteps(content.steps), [0, 4, 8, 12]);
    }
    for (const clip of state.playlistClips) {
      const channel = channelById(state, clip.channelId!);
      assert.equal(resolveClipChannelContent(state.patterns, clip, channel).steps, channel.steps);
    }
  });

  it('save -> reload does not rewrite a legacy document', () => {
    const state = legacyState();
    const reloaded = normalizeProjectState(JSON.parse(serializeProjectState(state)).state);
    assert.deepEqual(reloaded.patterns, state.patterns);
    assert.deepEqual(reloaded.playlistClips.map(c => c.patternId), [undefined, undefined]);
    assert.deepEqual(reloaded.channels.map(c => c.steps), state.channels.map(c => c.steps));
  });

  it('the first pattern operation gives every pattern its own copy and pins legacy clips', () => {
    const migrated = ensureIndependentPatterns(legacyState());
    assert.equal(hasStoredPatternContent(patternById(migrated, 'pat-2')), false, 'the selected pattern stays live');
    for (const id of ['pat-1', 'pat-3']) {
      const stored = patternById(migrated, id);
      assert.ok(hasStoredPatternContent(stored));
      assert.deepEqual(activeSteps(resolvePatternChannelContent(stored, channelById(migrated, 'ch-1')).steps), [0, 4, 8, 12]);
      assert.deepEqual(resolvePatternChannelContent(stored, channelById(migrated, 'ch-1')).notes.map(n => n.id), ['k-n1']);
    }
    assert.deepEqual(migrated.playlistClips.map(c => c.patternId), ['pat-2', 'pat-2'], 'pinned to the content they played');
    assert.equal(ensureIndependentPatterns(migrated), migrated, 'idempotent');
  });

  it('after migration, editing one legacy pattern changes no other pattern and no clip', () => {
    let state = selectPatternInProjectState(legacyState(), 'pat-3');
    state = toggle(state, 'ch-1', 1);
    assert.deepEqual(contentOf(state, 'pat-1', 'ch-1').steps, [0, 4, 8, 12]);
    assert.deepEqual(contentOf(state, 'pat-2', 'ch-1').steps, [0, 4, 8, 12]);
    assert.deepEqual(contentOf(state, 'pat-3', 'ch-1').steps, [0, 1, 4, 8, 12]);
    const clip = state.playlistClips[0];
    assert.deepEqual(activeSteps(resolveClipChannelContent(state.patterns, clip, channelById(state, 'ch-1')).steps), [0, 4, 8, 12]);
  });

  it('the shipped demo projects are legacy documents that keep working unchanged', () => {
    for (const project of [DEFAULT_PROJECT, ...PRESET_PROJECTS.map(preset => preset.state)]) {
      assert.ok(project.patterns.every(p => !hasStoredPatternContent(p)));
      const normalized = normalizeProjectState(project);
      assert.deepEqual(normalized.patterns, project.patterns);
    }
  });
});

describe('AC6: persistence, history and channel deletion', () => {
  const twoPatternState = (): ProjectState => {
    let state = addPatternToProjectState(baseState(), pattern('pat-2'));
    state = toggle(state, 'ch-1', 5);
    state = updateChannelInProjectState(state, 'ch-2', { notes: [note('s-n1', 40, 7)] });
    return state;
  };

  it('save -> reload preserves both patterns exactly', () => {
    const state = twoPatternState();
    const reloaded = normalizeProjectState(JSON.parse(serializeProjectState(state)).state);
    assert.equal(reloaded.selectedPatternId, 'pat-2');
    assert.deepEqual(reloaded.patterns, state.patterns);
    assert.deepEqual(reloaded.channels.map(c => [c.steps, c.notes]), state.channels.map(c => [c.steps, c.notes]));
    assert.deepEqual(contentOf(reloaded, 'pat-1', 'ch-1'), { steps: [0, 4, 8, 12], notes: ['36@2'] });
    assert.deepEqual(contentOf(reloaded, 'pat-2', 'ch-2'), { steps: [], notes: ['40@7'] });
  });

  it('undo/redo of Add pattern and of an edit restores every pattern', () => {
    const initial = baseState();
    let history = createHistory(initial);
    history = history.commit(addPatternToProjectState(history.present, pattern('pat-2')), 'Add pattern');
    history = history.commit(toggle(history.present, 'ch-1', 9), 'Toggle step');

    assert.deepEqual(contentOf(history.present, 'pat-2', 'ch-1').steps, [9]);
    const undoneEdit = history.undo();
    assert.deepEqual(contentOf(undoneEdit.present, 'pat-2', 'ch-1').steps, []);
    const undoneAdd = undoneEdit.undo();
    assert.equal(undoneAdd.present.patterns.length, 1);
    assert.deepEqual(activeSteps(channelById(undoneAdd.present, 'ch-1').steps), [0, 4, 8, 12]);
    const redone = undoneAdd.redo().redo();
    assert.deepEqual(contentOf(redone.present, 'pat-2', 'ch-1').steps, [9]);
    assert.deepEqual(contentOf(redone.present, 'pat-1', 'ch-1').steps, [0, 4, 8, 12]);
  });

  it('deleting a channel removes its content from every pattern; undo restores it', () => {
    const state = selectPatternInProjectState(twoPatternState(), 'pat-1');
    const { state: deleted } = deleteChannelFromProjectState(state, 'ch-2');
    for (const p of deleted.patterns) {
      if (hasStoredPatternContent(p)) assert.equal(p.channelContent.some(entry => entry.channelId === 'ch-2'), false);
    }
    const history = createHistory(state).commit(deleted, 'Delete channel').undo();
    assert.deepEqual(contentOf(history.present, 'pat-2', 'ch-2'), { steps: [], notes: ['40@7'] });
    assert.equal(removeChannelFromPatternContent(deleted, 'ch-2'), deleted, 'no-op once removed');
  });

  it('normalization drops stored content for unknown channels and repairs malformed entries', () => {
    const state = selectPatternInProjectState(twoPatternState(), 'pat-1');
    const stored = patternById(state, 'pat-2');
    const corrupt: ProjectState = {
      ...state,
      patterns: state.patterns.map(p => (p.id !== 'pat-2' ? p : {
        ...stored,
        channelContent: [
          ...stored.channelContent!,
          { channelId: 'ghost', steps: [true], notes: [] },
          { channelId: 'ch-1', steps: [true], notes: [] },
          { channelId: 'ch-2', steps: [1, 'x', true] as unknown as boolean[], notes: [null] as unknown as Note[] },
        ],
      })),
    };
    const normalized = normalizePatternContentModel(corrupt);
    const entries = patternById(normalized, 'pat-2').channelContent!;
    assert.deepEqual(entries.map(e => e.channelId), ['ch-1', 'ch-2'], 'ghost and duplicate entries dropped');
    assert.deepEqual(activeSteps(entries[0].steps), [5], 'the first entry for a channel wins');
    assert.equal(normalizePatternContentModel(normalized), normalized, 'idempotent');
  });

  it('a selection written without the swap is repaired without losing either pattern', () => {
    const state = selectPatternInProjectState(twoPatternState(), 'pat-1');
    const bypassed: ProjectState = { ...state, selectedPatternId: 'pat-2' };
    const repaired = normalizeProjectState(bypassed);
    assert.deepEqual(activeSteps(channelById(repaired, 'ch-1').steps), [5], 'Pattern 2 is now the live content');
    assert.equal(hasStoredPatternContent(patternById(repaired, 'pat-2')), false);
    assert.deepEqual(contentOf(repaired, 'pat-1', 'ch-1'), { steps: [0, 4, 8, 12], notes: ['36@2'] });
  });

  it('a non-array channelContent is treated as absent (live content)', () => {
    const state = baseState();
    state.patterns = [pattern('pat-1'), { ...pattern('pat-2'), channelContent: null as unknown as undefined }];
    const normalized = normalizePatternContentModel(state);
    assert.equal('channelContent' in patternById(normalized, 'pat-2'), false);
  });
});

describe('AC7: MIDI takes land in the pattern they started in', () => {
  it('a take finalized after switching patterns is written to its own pattern', () => {
    let state = addPatternToProjectState(baseState(), pattern('pat-2'));
    state = selectPatternInProjectState(state, 'pat-1');
    const take = [note('rec-1', 64, 3)];
    const committed = appendRecordedNotesToChannelInProjectState(state, 'ch-1', take, 'pat-2');

    assert.deepEqual(channelById(committed, 'ch-1').notes.map(n => n.id), ['k-n1'], 'the selected pattern is untouched');
    assert.deepEqual(contentOf(committed, 'pat-2', 'ch-1').notes, ['64@3']);
  });

  it('a take into the still-selected pattern appends to the live notes', () => {
    const state = baseState();
    const committed = appendRecordedNotesToChannelInProjectState(state, 'ch-1', [note('rec-2', 65, 1)], 'pat-1');
    assert.deepEqual(channelById(committed, 'ch-1').notes.map(n => n.id), ['k-n1', 'rec-2']);
  });

  it('an unknown target pattern records nothing', () => {
    const state = baseState();
    assert.equal(appendRecordedNotesToChannelInProjectState(state, 'ch-1', [note('rec-3', 60, 0)], 'nope'), state);
  });
});

describe('Project-level views stay truthful', () => {
  it('Total Notes counts every pattern once', () => {
    let state = addPatternToProjectState(baseState(), pattern('pat-2'));
    state = updateChannelInProjectState(state, 'ch-2', { notes: [note('a', 60, 0), note('b', 62, 1)] });
    assert.equal(countProjectNotes(state.patterns, state.channels), 3);
    const legacy = baseState();
    legacy.patterns.push(pattern('pat-legacy'));
    assert.equal(countProjectNotes(legacy.patterns, legacy.channels), 1, 'shared legacy content counts once');
  });

  it('an untouched demo stays pristine after only switching patterns', () => {
    const demo = normalizeProjectState(structuredClone(PRESET_PROJECTS[0].state));
    assert.equal(isPristineProject(demo), true);
    const switched = selectPatternInProjectState(demo, demo.patterns[1].id);
    assert.notEqual(switched, demo);
    assert.equal(isPristineProject(switched), true, 'a tab click is not work that needs a backup');
    assert.equal(getProjectFingerprint(switched), getProjectFingerprint(demo));
  });

  it('pristine detection is independent of WHICH legacy pattern was selected before the first swap', () => {
    const demo = normalizeProjectState(structuredClone(PRESET_PROJECTS[0].state));
    const last = demo.patterns[demo.patterns.length - 1].id;
    // A raw selection write (what older builds stored) and a real swap from it.
    const rawSelection: ProjectState = { ...demo, selectedPatternId: last };
    const swappedFromLast = selectPatternInProjectState(rawSelection, demo.patterns[0].id);
    assert.deepEqual(swappedFromLast.playlistClips.map(c => c.patternId).filter(Boolean).length > 0, true, 'legacy clips were pinned');
    for (const candidate of [rawSelection, swappedFromLast]) {
      assert.equal(isPristineProject(candidate), true);
      assert.equal(getProjectFingerprint(candidate), getProjectFingerprint(demo));
    }
  });

  it('re-pointing a clip at a pattern with different content is real work', () => {
    let state = addPatternToProjectState(baseState(), pattern('pat-2'));
    state = toggle(state, 'ch-1', 3);
    state = { ...state, playlistClips: [patternClip('c1', 'ch-1', 0, 'pat-1')] };
    const retargeted = { ...state, playlistClips: setPlaylistClipPattern(state.playlistClips, 'c1', state.patterns, 'pat-2') };
    assert.notEqual(getProjectFingerprint(retargeted), getProjectFingerprint(state));
  });

  it('an edit inside a non-selected pattern is real work', () => {
    const demo = normalizeProjectState(structuredClone(PRESET_PROJECTS[0].state));
    let edited = selectPatternInProjectState(demo, demo.patterns[1].id);
    edited = toggle(edited, edited.channels[0].id, 1);
    edited = selectPatternInProjectState(edited, demo.patterns[0].id);
    assert.equal(isPristineProject(edited), false);
  });
});
