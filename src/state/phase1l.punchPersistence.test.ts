/**
 * Phase 1L — punch-in / punch-out recording: project-state persistence, the
 * mutation boundary, history and engine publication.
 *
 * The window is additive project metadata (`meta.punchRecording`): old
 * documents omit it and keep recording ordinary takes, the mutation boundary
 * refuses a window the runtime could not record, and every real change is one
 * discrete undo step. A punch take itself is an ordinary playlist-clip append:
 * it must never move, resize or delete any other clip.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultProjectState,
  normalizeProjectState,
} from './projectState';
import { serializeProjectState } from './projectPersistence';
import { createHistory } from './projectHistory';
import { PROJECT_STATE_AUDIO_FIELDS } from './projectStateAudioConsumers';
import {
  InvalidRecordingSettingError,
  getMetaUpdateLabel,
  isContinuousMetaUpdate,
  setPunchRecordingInProjectState,
  setRecordingCountInBarsInProjectState,
  updateProjectMetadataInProjectState,
} from './projectMutations';
import {
  resynchronizeLiveEngineFromProjectState,
  type LiveEngineResynchronizationPort,
} from './liveEngineResynchronization';
import { resolvePunchRecording } from '../music/punchRecording';
import type { PlaylistClip, ProjectState } from '../types/daw';

const baseState = (): ProjectState => createDefaultProjectState();

const punch = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  inBar: 5,
  inBeat: 1,
  outBar: 9,
  outBeat: 1,
  ...overrides,
});

const roundTrip = (state: ProjectState): ProjectState =>
  normalizeProjectState(JSON.parse(serializeProjectState(state)).state);

const clip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: 'clip-existing',
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'pattern',
  color: '#ff6e00',
  name: 'Existing block',
  ...overrides,
});

describe('Phase 1L TEST 1 — the punch window persists with the project document', () => {
  it('a saved window round-trips through serialize and normalize', () => {
    const state = setPunchRecordingInProjectState(baseState(), punch());
    assert.deepEqual(state.meta.punchRecording, punch());
    assert.deepEqual(roundTrip(state).meta.punchRecording, punch());
  });

  it('a disabled window still persists, so turning punch off is remembered', () => {
    const state = setPunchRecordingInProjectState(baseState(), punch({ enabled: false }));
    assert.equal(state.meta.punchRecording?.enabled, false);
    assert.equal(roundTrip(state).meta.punchRecording?.enabled, false);
  });

  it('legacy documents without the field resolve to punch off and are not rewritten', () => {
    const legacy = JSON.parse(JSON.stringify(baseState()));
    delete legacy.meta.punchRecording;
    const restored = normalizeProjectState(legacy);
    assert.equal(restored.meta.punchRecording, undefined);
    assert.equal(resolvePunchRecording(restored.meta).enabled, false);
  });

  it('a malformed stored window resolves to punch off instead of throwing', () => {
    for (const bad of ['bar 5', { enabled: true }, { enabled: 'yes', inBar: 1, inBeat: 1, outBar: 2, outBeat: 1 }, null]) {
      const weird = normalizeProjectState({
        ...JSON.parse(JSON.stringify(baseState())),
        meta: { ...JSON.parse(JSON.stringify(baseState())).meta, punchRecording: bad },
      });
      assert.equal(resolvePunchRecording(weird.meta).enabled, false, `value ${JSON.stringify(bad)}`);
    }
  });

  it('the window never touches notes, clips, patterns or the timeline length', () => {
    const before = baseState();
    before.channels[0].notes = [{ id: 'n1', pitch: 60, start: 3, duration: 2, velocity: 0.8 }];
    before.playlistClips = [clip()];
    const after = setPunchRecordingInProjectState(before, punch());
    assert.deepEqual(after.channels, before.channels);
    assert.deepEqual(after.playlistClips, before.playlistClips);
    assert.deepEqual(after.patterns, before.patterns);
    assert.equal(after.totalBars, before.totalBars);
  });
});

describe('Phase 1L TEST 2 — the mutation boundary refuses a window that cannot be recorded', () => {
  it('accepts a window inside the arrangement', () => {
    assert.deepEqual(setPunchRecordingInProjectState(baseState(), punch()).meta.punchRecording, punch());
  });

  it('rejects punch-out at or before punch-in', () => {
    for (const bad of [punch({ outBar: 5, outBeat: 1 }), punch({ outBar: 4, outBeat: 1 })]) {
      assert.throws(
        () => setPunchRecordingInProjectState(baseState(), bad),
        InvalidRecordingSettingError,
        JSON.stringify(bad),
      );
    }
  });

  it('rejects a beat past the end of the project meter bar', () => {
    assert.throws(() => setPunchRecordingInProjectState(baseState(), punch({ inBeat: 5 })), InvalidRecordingSettingError);
    // The same window is legal once the project is in 7/8 (seven eighth pulses).
    const sevenEight = setPunchRecordingInProjectState(baseState(), { enabled: false, inBar: 1, inBeat: 1, outBar: 2, outBeat: 1 });
    const asSevenEight = { ...sevenEight, meta: { ...sevenEight.meta, timeSignature: [7, 8] as [number, number] } };
    assert.doesNotThrow(() => setPunchRecordingInProjectState(asSevenEight, punch({ inBeat: 7 })));
  });

  it('rejects a punch-in past the arrangement end but allows a punch-out past it', () => {
    const state = { ...baseState(), totalBars: 8 };
    assert.throws(() => setPunchRecordingInProjectState(state, punch({ inBar: 9 })), InvalidRecordingSettingError);
    // Truncated at the project end, not refused.
    assert.doesNotThrow(() => setPunchRecordingInProjectState(state, punch({ outBar: 20 })));
  });

  it('rejects a malformed shape and stores nothing', () => {
    for (const bad of [undefined, null, 'bar 5', { enabled: true }, { enabled: true, inBar: 0, inBeat: 1, outBar: 2, outBeat: 1 }]) {
      assert.throws(
        () => setPunchRecordingInProjectState(baseState(), bad),
        InvalidRecordingSettingError,
        `value ${JSON.stringify(bad)}`,
      );
    }
    assert.throws(
      () => updateProjectMetadataInProjectState(baseState(), { punchRecording: 'nope' as never }),
      InvalidRecordingSettingError,
    );
  });

  it('re-selecting the same window returns the same state (no history entry)', () => {
    const state = setPunchRecordingInProjectState(baseState(), punch());
    assert.equal(setPunchRecordingInProjectState(state, punch()), state);
  });

  it('history labels and continuity classification cover the setting', () => {
    assert.equal(getMetaUpdateLabel({ punchRecording: punch() }), 'Change punch recording range');
    assert.equal(getMetaUpdateLabel({ punchRecording: punch({ enabled: false }) }), 'Turn off punch recording');
    assert.equal(isContinuousMetaUpdate({ punchRecording: punch() }), false);
  });

  it('the audio-consumer registry documents the field as consumed', () => {
    const entry = PROJECT_STATE_AUDIO_FIELDS['meta.punchRecording'];
    assert.ok(entry, 'meta.punchRecording must be registered');
    assert.equal(entry.classification, 'consumed');
  });

  it('the count-in setting is unaffected by a punch edit', () => {
    const state = setRecordingCountInBarsInProjectState(baseState(), 2);
    const after = setPunchRecordingInProjectState(state, punch());
    assert.equal(after.meta.countInBars, 2);
  });
});

describe('Phase 1L TEST 3 — undo, redo and history keep the window', () => {
  it('a punch edit is one undo step and redo restores it', () => {
    const start = createHistory(baseState());
    const withPunch = setPunchRecordingInProjectState(start.present, punch());
    const committed = start.commit(withPunch, 'Change punch recording range');
    assert.deepEqual(committed.present.meta.punchRecording, punch());
    assert.equal(committed.canUndo, true);
    const undone = committed.undo();
    assert.equal(undone.present.meta.punchRecording, undefined, 'undo returns to the document without a window');
    const redone = undone.redo();
    assert.deepEqual(redone.present.meta.punchRecording, punch());
    assert.deepEqual(undone.future.map(entry => entry.label), ['Change punch recording range']);
  });
});

describe('Phase 1L TEST 4 — a punch take preserves every other clip', () => {
  it('appending a take keeps the existing clips bit-identical and survives a save', () => {
    const before = { ...baseState(), playlistClips: [clip(), clip({ id: 'clip-two', trackIndex: 2, startBar: 8 })] };
    const snapshot = JSON.parse(JSON.stringify(before.playlistClips));
    const take: PlaylistClip = {
      id: 'punch-clip-1',
      trackIndex: 4,
      startBar: 4,
      lengthBars: 4,
      type: 'audio',
      audioBufferId: 'recording-rec-1',
      audioName: 'Punch Take',
      audioWaveform: [0.5],
      audioUnavailable: false,
      color: '#ff6e00',
      name: 'Punch Take',
    };
    const after = { ...before, playlistClips: [...before.playlistClips, take] };
    assert.deepEqual(after.playlistClips.slice(0, 2), snapshot, 'no existing clip moved, resized or changed');
    assert.equal(after.playlistClips.length, 3);
    const restored = roundTrip(after);
    assert.deepEqual(restored.playlistClips.map(c => c.id), ['clip-existing', 'clip-two', 'punch-clip-1']);
    const restoredTake = restored.playlistClips.find(c => c.id === 'punch-clip-1');
    assert.equal(restoredTake?.startBar, 4);
    assert.equal(restoredTake?.lengthBars, 4);
  });
});

describe('Phase 1L TEST 5 — the window republishes to the engine like the count-in', () => {
  it('resynchronizeLiveEngineFromProjectState forwards punchRecording', () => {
    const seen: unknown[] = [];
    const port: LiveEngineResynchronizationPort = {
      setBpm: () => {},
      setTimeSignature: () => {},
      setSevenEightGrouping: () => {},
      setCountInBars: () => {},
      setPunchRecording: settings => { seen.push(settings); },
      setSwing: () => {},
      setMetronome: () => {},
      setGrossBeatState: () => {},
      setMasterVolume: () => {},
      isPlaybackActive: () => true,
      synchronizePlaybackState: () => {},
      updateMixerTrack: () => {},
      updateChannel: () => {},
      getChannelPanner: () => null,
    };
    const state = setPunchRecordingInProjectState(baseState(), punch());
    resynchronizeLiveEngineFromProjectState(port, state, { metronome: false });
    assert.deepEqual(seen, [punch()]);
  });

  it('a port without the optional method (narrow test ports) still resynchronizes', () => {
    const port: LiveEngineResynchronizationPort = {
      setBpm: () => {},
      setTimeSignature: () => {},
      setSwing: () => {},
      setMetronome: () => {},
      setGrossBeatState: () => {},
      setMasterVolume: () => {},
      isPlaybackActive: () => true,
      synchronizePlaybackState: () => {},
      updateMixerTrack: () => {},
      updateChannel: () => {},
      getChannelPanner: () => null,
    };
    assert.doesNotThrow(() => {
      resynchronizeLiveEngineFromProjectState(port, baseState(), { metronome: false });
    });
  });
});
