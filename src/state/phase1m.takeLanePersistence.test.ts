/**
 * Phase 1M — Take lane persistence and normalization tests.
 *
 * Verifies that take-group fields survive project save/load through
 * `normalizeProjectState` and `serializeProjectState`, and that project
 * replacement and history snapshots preserve take selection.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PlaylistClip, ProjectState } from '../types/daw';
import { normalizeProjectState, createDefaultProjectState } from './projectState';
import { serializeProjectState } from './projectPersistence';
import { createHistory } from './projectHistory';
import { resolveActiveTakeIndex, isTakeAudible } from '../audio/takeLaneManager';

const makeClip = (overrides: Partial<PlaylistClip> & { id: string }): PlaylistClip => ({
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'audio',
  color: '#ff6e00',
  name: 'Test Clip',
  audioBufferId: 'buf-test',
  ...overrides,
});

const stateWithTakeClips = (): ProjectState => {
  const base = createDefaultProjectState();
  return {
    ...base,
    playlistClips: [
      makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 1, audioBufferId: 'buf-a' }),
      makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 1, audioBufferId: 'buf-b' }),
    ],
  };
};

describe('Phase 1M — Project normalization preserves take fields', () => {
  it('normalizeProjectState keeps takeGroupId, takeIndex, activeTakeIndex', () => {
    const state = stateWithTakeClips();
    const normalized = normalizeProjectState(state);
    const clips = normalized.playlistClips;
    assert.equal(clips.length, 2);
    assert.equal(clips[0].takeGroupId, 'g1');
    assert.equal(clips[0].takeIndex, 0);
    assert.equal(clips[0].activeTakeIndex, 1);
    assert.equal(clips[1].takeIndex, 1);
  });

  it('take selection is preserved after normalization', () => {
    const state = stateWithTakeClips();
    const normalized = normalizeProjectState(state);
    const clips = normalized.playlistClips;
    assert.equal(resolveActiveTakeIndex(clips, 'g1'), 1);
    assert.equal(isTakeAudible(clips[0], clips), false);
    assert.equal(isTakeAudible(clips[1], clips), true);
  });
});

describe('Phase 1M — Serialization round-trip', () => {
  it('take fields survive serialize → parse', () => {
    const state = stateWithTakeClips();
    const serialized = serializeProjectState(state);
    const parsed = JSON.parse(serialized);
    const clips = parsed.state.playlistClips as PlaylistClip[];
    assert.equal(clips[0].takeGroupId, 'g1');
    assert.equal(clips[0].takeIndex, 0);
    assert.equal(clips[0].activeTakeIndex, 1);
    assert.equal(clips[1].takeIndex, 1);
  });
});

describe('Phase 1M — Project history preserves take selection', () => {
  it('commit/undo/redo preserves take-group fields', () => {
    const state1 = stateWithTakeClips();
    const history = createHistory(state1);

    // Change take selection
    const state2: ProjectState = {
      ...state1,
      playlistClips: state1.playlistClips.map(c => ({ ...c, activeTakeIndex: 0 })),
    };
    const history2 = history.commit(state2, 'Select take 0');

    assert.equal(resolveActiveTakeIndex(history2.present.playlistClips, 'g1'), 0);

    // Undo
    const history3 = history2.undo();
    assert.equal(resolveActiveTakeIndex(history3.present.playlistClips, 'g1'), 1);

    // Redo
    const history4 = history3.redo();
    assert.equal(resolveActiveTakeIndex(history4.present.playlistClips, 'g1'), 0);
  });
});

describe('Phase 1M — Pre-Phase 1M projects load correctly', () => {
  it('a project without take fields loads without errors', () => {
    const legacyState: Partial<ProjectState> = {
      meta: {
        id: 'test',
        name: 'Legacy',
        author: 'test',
        bpm: 120,
        timeSignature: [4, 4],
        swing: 0,
        masterVolume: 1,
        masterPitch: 0,
        created: Date.now(),
        updated: Date.now(),
        version: '1.0',
        offlineReady: false,
        totalEditTimeSeconds: 0,
      },
      patterns: [],
      channels: [],
      playlistTracks: [],
      playlistClips: [
        makeClip({ id: 'legacy-1', audioBufferId: 'buf-legacy' }),
      ],
      mixerTracks: [],
      recordings: [],
      comments: [],
      collaborators: [],
      midiMappings: [],
      selectedPatternId: '',
      selectedChannelId: '',
      selectedMixerTrackId: 0,
      nextMixerTrackId: 1,
    };
    const normalized = normalizeProjectState(legacyState as ProjectState);
    assert.equal(normalized.playlistClips[0].takeGroupId, undefined);
    assert.equal(normalized.playlistClips[0].takeIndex, undefined);
  });
});
