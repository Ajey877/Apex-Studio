/**
 * Phase 1K — recording count-in setting: project-state persistence, mutation
 * boundary and engine publication.
 *
 * The setting is additive project metadata (`meta.countInBars`: 0 = Off, 1,
 * 2). Old documents omit it and keep the immediate-start behaviour; the
 * mutation boundary rejects anything outside {0, 1, 2}; the value never
 * touches notes, clips or stored musical positions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultProjectState,
  normalizeProjectState,
} from './projectState';
import { PROJECT_STATE_AUDIO_FIELDS } from './projectStateAudioConsumers';
import {
  InvalidRecordingSettingError,
  getMetaUpdateLabel,
  isContinuousMetaUpdate,
  setRecordingCountInBarsInProjectState,
  updateProjectMetadataInProjectState,
} from './projectMutations';
import { resynchronizeLiveEngineFromProjectState, type LiveEngineResynchronizationPort } from './liveEngineResynchronization';
import { resolveCountInBars } from '../music/countIn';
import type { ProjectState } from '../types/daw';

const baseState = (): ProjectState => createDefaultProjectState();

describe('Phase 1K TEST 1 — the count-in setting persists through the project document', () => {
  it('a saved setting round-trips through normalizeProjectState', () => {
    const state = setRecordingCountInBarsInProjectState(baseState(), 2);
    assert.equal(state.meta.countInBars, 2);
    const restored = normalizeProjectState(JSON.parse(JSON.stringify(state)));
    assert.equal(restored.meta.countInBars, 2);
  });

  it('legacy documents without the field resolve to Off without being rewritten', () => {
    const legacy = JSON.parse(JSON.stringify(baseState()));
    delete legacy.meta.countInBars;
    const restored = normalizeProjectState(legacy);
    assert.equal(restored.meta.countInBars, undefined);
    assert.equal(resolveCountInBars(restored.meta), 0);
  });

  it('a malformed stored value resolves to Off instead of throwing', () => {
    for (const bad of [5, -1, 1.5, '2', null]) {
      assert.equal(resolveCountInBars({ countInBars: bad }), 0, `value ${String(bad)}`);
    }
    // And it survives normalization without corrupting the document.
    const weird = normalizeProjectState({
      ...JSON.parse(JSON.stringify(baseState())),
      meta: { ...JSON.parse(JSON.stringify(baseState())).meta, countInBars: 9 },
    });
    assert.equal(resolveCountInBars(weird.meta), 0);
  });

  it('the setting never touches notes, clips or patterns', () => {
    const before = baseState();
    before.channels[0].notes = [{ id: 'n1', pitch: 60, start: 3, duration: 2, velocity: 0.8 }];
    const after = setRecordingCountInBarsInProjectState(before, 1);
    assert.deepEqual(after.channels, before.channels);
    assert.deepEqual(after.playlistClips, before.playlistClips);
    assert.deepEqual(after.patterns, before.patterns);
    assert.equal(after.meta.countInBars, 1);
  });
});

describe('Phase 1K TEST 2 — the mutation boundary rejects unknown lengths', () => {
  it('setRecordingCountInBarsInProjectState accepts 0, 1 and 2', () => {
    const state = baseState();
    assert.equal(setRecordingCountInBarsInProjectState(state, 0).meta.countInBars, 0);
    assert.equal(setRecordingCountInBarsInProjectState(state, 1).meta.countInBars, 1);
    assert.equal(setRecordingCountInBarsInProjectState(state, 2).meta.countInBars, 2);
  });

  it('anything else throws InvalidRecordingSettingError and stores nothing', () => {
    const state = baseState();
    for (const bad of [3, -1, 1.5, '1', undefined, null]) {
      assert.throws(
        () => setRecordingCountInBarsInProjectState(state, bad),
        InvalidRecordingSettingError,
        `value ${String(bad)} must be rejected`,
      );
    }
    assert.throws(
      () => updateProjectMetadataInProjectState(state, { countInBars: 4 as unknown as 0 }),
      InvalidRecordingSettingError,
    );
  });

  it('selecting the active value returns the same state (no history entry)', () => {
    const state = setRecordingCountInBarsInProjectState(baseState(), 1);
    assert.equal(setRecordingCountInBarsInProjectState(state, 1), state);
  });

  it('history labels and continuity classification cover the setting', () => {
    assert.equal(getMetaUpdateLabel({ countInBars: 1 }), 'Change recording count-in');
    assert.equal(isContinuousMetaUpdate({ countInBars: 1 }), false);
  });

  it('the audio-consumer registry documents the field as consumed', () => {
    const entry = PROJECT_STATE_AUDIO_FIELDS['meta.countInBars'];
    assert.ok(entry, 'meta.countInBars must be registered');
    assert.equal(entry.classification, 'consumed');
  });
});

describe('Phase 1K TEST 3 — the setting republishes to the engine like the meter', () => {
  it('resynchronizeLiveEngineFromProjectState forwards countInBars (optional port method)', () => {
    const seen: Array<number | undefined> = [];
    const port: LiveEngineResynchronizationPort = {
      setBpm: () => {},
      setTimeSignature: () => {},
      setSevenEightGrouping: () => {},
      setCountInBars: bars => { seen.push(bars); },
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
    const state = setRecordingCountInBarsInProjectState(baseState(), 2);
    resynchronizeLiveEngineFromProjectState(port, state, { metronome: false });
    assert.deepEqual(seen, [2]);
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
