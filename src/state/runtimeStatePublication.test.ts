import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDefaultProjectState } from './projectState';
import { createHistory } from './projectHistory';
import { synchronizeBeforeRuntimePublication } from './runtimeStatePublication';

describe('Phase 32 runtime state ↔ AudioEngine failure containment', () => {
  it('reproduces the pre-fix publication failure boundary', () => {
    const current = createDefaultProjectState();
    const next = {
      ...current,
      mixerTracks: current.mixerTracks.map(track =>
        track.id === 0 ? { ...track, volume: 0.25 } : track
      ),
    };
    let projectStateRef = current;
    let reactProjectState = current;
    let history = createHistory(current);
    let liveMixerVolume = current.mixerTracks[0].volume;

    const synchronize = () => {
      liveMixerVolume = next.mixerTracks[0].volume;
      throw new Error('injected AudioEngine synchronization failure');
    };

    // This is the exact unsafe ordering from before Phase 32: the logical ref
    // is published before the runtime synchronizer is allowed to fail.
    projectStateRef = next;
    assert.throws(() => synchronize(), /injected AudioEngine synchronization failure/);

    assert.equal(projectStateRef.mixerTracks[0].volume, 0.25);
    assert.equal(reactProjectState.mixerTracks[0].volume, current.mixerTracks[0].volume);
    assert.equal(history.present.mixerTracks[0].volume, current.mixerTracks[0].volume);
    assert.equal(liveMixerVolume, 0.25);
  });

  it('contains a failed mutation before publishing state or history and restores the live mixer', () => {
    const current = createDefaultProjectState();
    const next = {
      ...current,
      mixerTracks: current.mixerTracks.map(track =>
        track.id === 0 ? { ...track, volume: 0.25 } : track
      ),
    };
    let projectStateRef = current;
    let reactProjectState = current;
    let history = createHistory(current);
    let liveMixerVolume = current.mixerTracks[0].volume;
    let published = false;

    const synchronize = () => {
      liveMixerVolume = next.mixerTracks[0].volume;
      throw new Error('injected AudioEngine synchronization failure');
    };
    const restore = (previous: typeof current) => {
      liveMixerVolume = previous.mixerTracks[0].volume;
    };

    assert.throws(
      () => synchronizeBeforeRuntimePublication(
        current,
        next,
        synchronize,
        publishedState => {
          published = true;
          projectStateRef = publishedState;
          reactProjectState = publishedState;
          history = history.commit(publishedState, 'failed mutation');
        },
        restore,
      ),
      /injected AudioEngine synchronization failure/,
    );

    assert.equal(published, false);
    assert.equal(projectStateRef, current);
    assert.equal(reactProjectState, current);
    assert.equal(history.present, current);
    assert.equal(liveMixerVolume, current.mixerTracks[0].volume);
  });

  it('contains the same failure boundary for undo and redo publication', () => {
    const current = createDefaultProjectState();
    const next = {
      ...current,
      mixerTracks: current.mixerTracks.map(track =>
        track.id === 0 ? { ...track, pan: 0.5 } : track
      ),
    };
    const committed = createHistory(current).commit(next, 'mixer edit');

    let history = committed;
    let projectStateRef = committed.present;
    let reactProjectState = committed.present;
    let livePan = committed.present.mixerTracks[0].pan;
    const synchronize = () => {
      livePan = current.mixerTracks[0].pan;
      throw new Error('injected undo/redo synchronization failure');
    };
    const restore = (previous: typeof current) => {
      livePan = previous.mixerTracks[0].pan;
    };

    const undone = history.undo();
    assert.throws(
      () => synchronizeBeforeRuntimePublication(
        committed.present,
        undone.present,
        synchronize,
        publishedState => {
          history = undone;
          projectStateRef = publishedState;
          reactProjectState = publishedState;
        },
        restore,
      ),
      /injected undo/redo synchronization failure/,
    );

    assert.equal(history, committed);
    assert.equal(projectStateRef, committed.present);
    assert.equal(reactProjectState, committed.present);
    assert.equal(livePan, committed.present.mixerTracks[0].pan);
  });
});
