import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { serializeProjectState } from './projectPersistence';
import { createHistory } from './projectHistory';
import { updateMixerTrackInProjectState } from './projectMutations';
import type { MixerTrack, ProjectState, SidechainSettings } from '../types/daw';

/**
 * Phase 9A — the real level-detected sidechain is project state, so it has to
 * survive normalization, save/load and undo/redo exactly like every other mixer
 * parameter, and legacy documents must keep their note-triggered response.
 */

const withSidechain = (state: ProjectState, trackId: number, sidechain: unknown): ProjectState => ({
  ...state,
  mixerTracks: state.mixerTracks.map(track => (track.id === trackId ? { ...track, sidechain } as MixerTrack : track)),
});

const trackOf = (state: ProjectState, trackId: number) => state.mixerTracks.find(track => track.id === trackId);

test('a document written before Phase 9A loads as note-triggered, not level-detected', () => {
  const base = createDefaultProjectState();
  const legacy = {
    enabled: true,
    sourceTrackId: 1,
    threshold: -22,
    amount: 0.6,
    attackMs: 6,
    releaseMs: 180,
    lowFreqOnly: true,
    highPassFilterHz: 120,
  };
  const normalized = normalizeProjectState(withSidechain(base, 2, legacy));
  const sidechain = trackOf(normalized, 2)?.sidechain;

  assert.ok(sidechain, 'the route survives normalization');
  assert.equal(sidechain!.mode, 'note-trigger', 'no mode in the document means the legacy envelope');
  assert.equal(sidechain!.thresholdDb, -18, 'the detector defaults are filled for a later switch');
  assert.equal(sidechain!.ratio, 4);
  assert.equal(sidechain!.amount, 0.6);
  assert.equal(sidechain!.attackMs, 6);
  assert.equal(sidechain!.releaseMs, 180);
  for (const ghost of ['threshold', 'lowFreqOnly', 'highPassFilterHz', 'gainReductionDb']) {
    assert.equal(Object.prototype.hasOwnProperty.call(sidechain, ghost), false, `${ghost} stays stripped`);
  }
});

test('a level-detected route survives normalization, save and reload', () => {
  const base = createDefaultProjectState();
  const route: SidechainSettings = {
    enabled: true,
    sourceTrackId: 1,
    amount: 0.9,
    attackMs: 2,
    releaseMs: 70,
    mode: 'level-detected',
    thresholdDb: -27,
    ratio: 6,
  };
  const saved = serializeProjectState(withSidechain(base, 2, route));
  const reloaded = normalizeProjectState(JSON.parse(saved).state);
  const sidechain = trackOf(reloaded, 2)?.sidechain;
  assert.ok(sidechain);
  assert.deepEqual(sidechain, route, 'every detector parameter round-trips unchanged');
});

test('out-of-range detector values are clamped on load instead of reaching an AudioParam', () => {
  const base = createDefaultProjectState();
  const normalized = normalizeProjectState(withSidechain(base, 2, {
    enabled: true,
    sourceTrackId: 1,
    amount: 3,
    attackMs: -5,
    releaseMs: 9000,
    mode: 'level-detected',
    thresholdDb: 40,
    ratio: 99,
  }));
  const sidechain = trackOf(normalized, 2)?.sidechain;
  assert.ok(sidechain);
  assert.equal(sidechain!.amount, 1);
  assert.equal(sidechain!.attackMs, 1);
  assert.equal(sidechain!.releaseMs, 500);
  assert.equal(sidechain!.thresholdDb, 0);
  assert.equal(sidechain!.ratio, 20);
});

test('switching a route to level detection and back is undoable and redoable', () => {
  const initial = createDefaultProjectState();
  let history = createHistory(initial);
  const legacy: SidechainSettings = {
    enabled: true,
    sourceTrackId: 1,
    amount: 0.5,
    attackMs: 5,
    releaseMs: 120,
    mode: 'note-trigger',
    thresholdDb: -18,
    ratio: 4,
  };
  history = history.commit(updateMixerTrackInProjectState(history.present, 2, { sidechain: legacy }), 'Update sidechain');

  const level: SidechainSettings = { ...legacy, mode: 'level-detected', thresholdDb: -24, ratio: 8 };
  history = history.commit(updateMixerTrackInProjectState(history.present, 2, { sidechain: level }), 'Update sidechain');
  assert.equal(trackOf(history.present, 2)?.sidechain?.mode, 'level-detected');
  assert.equal(trackOf(history.present, 2)?.sidechain?.thresholdDb, -24);

  history = history.undo();
  assert.equal(trackOf(history.present, 2)?.sidechain?.mode, 'note-trigger', 'undo restores the legacy route');

  history = history.redo();
  assert.equal(trackOf(history.present, 2)?.sidechain?.mode, 'level-detected');
  assert.equal(trackOf(history.present, 2)?.sidechain?.ratio, 8);

  history = history.undo();
  history = history.undo();
  assert.equal(trackOf(history.present, 2)?.sidechain, undefined, 'undoing the first change removes the route');
});
