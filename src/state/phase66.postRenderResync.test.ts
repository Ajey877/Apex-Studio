/**
 * Phase 66 — F2: re-publishing the authoritative project runtime state to the
 * live engine after an offline render releases its lease.
 *
 * The render lease (Phase 50/51) fences live writes out of the frozen offline
 * take. Whatever the user changes while an export runs — tempo, swing, mixer
 * moves, channel edits — is written to the project document in React, but the
 * engine calls that would apply it are swallowed, and the App only publishes
 * those values on a *change*, never after the render. The engine therefore kept
 * playing the pre-render tempo/swing/mixer while the UI showed the new ones
 * (`/tmp/probes/p3_lease.ts`).
 *
 * `resynchronizeLiveEngineFromProjectState` is the single publication point for
 * the other half of that contract: when the lease is released, the project
 * document — the source of truth — is re-published to the live engine. A stopped
 * engine gets the settings and the mixer/channel graph state; a take that the
 * renderer resumed gets the playback collections merged into the running take,
 * exactly like a live edit made while playing would have been.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultProjectState } from './projectState';
import { resynchronizeLiveEngineFromProjectState } from './liveEngineResynchronization';
import type { Channel, MixerTrack, PlaylistTrack, ProjectState } from '../types/daw';

interface RecordedCall {
  method: string;
  args: unknown[];
}

interface PlaybackUpdateLike {
  channels?: Channel[];
  clips?: ProjectState['playlistClips'];
  mixerTracks?: MixerTrack[];
  playlistTracks?: PlaylistTrack[];
  patternLengthSteps?: number;
}

function createRecordingEngine(options: { playing: boolean; knownPannerChannelIds?: string[] } = { playing: false }) {
  const calls: RecordedCall[] = [];
  const known = new Set(options.knownPannerChannelIds ?? []);
  const engine = {
    setBpm(bpm: number) { calls.push({ method: 'setBpm', args: [bpm] }); },
    setSwing(swing: number) { calls.push({ method: 'setSwing', args: [swing] }); },
    setMetronome(enabled: boolean) { calls.push({ method: 'setMetronome', args: [enabled] }); },
    setGrossBeatState(state: unknown) { calls.push({ method: 'setGrossBeatState', args: [state] }); },
    setMasterVolume(gain: number) { calls.push({ method: 'setMasterVolume', args: [gain] }); },
    isPlaybackActive() { return options.playing; },
    synchronizePlaybackState(update: PlaybackUpdateLike) {
      calls.push({ method: 'synchronizePlaybackState', args: [update] });
    },
    updateMixerTrack(track: MixerTrack) { calls.push({ method: 'updateMixerTrack', args: [track] }); },
    updateChannel(channel: Channel) { calls.push({ method: 'updateChannel', args: [channel] }); },
    getChannelPanner(channelId: string) { return known.has(channelId) ? { pan: null } : undefined; },
  };
  return { engine, calls, methodsOf: (method: string) => calls.filter(call => call.method === method) };
}

const withTempo = (state: ProjectState, bpm: number, swing: number): ProjectState => ({
  ...state,
  meta: { ...state.meta, bpm, swing },
});

describe('Phase 66 F2 — the live engine is re-published from the project document', () => {
  it('publishes the project tempo, swing and metronome', () => {
    const state = withTempo(createDefaultProjectState(), 200, 0.4);
    const { engine, methodsOf } = createRecordingEngine();

    resynchronizeLiveEngineFromProjectState(engine, state, { metronome: true });

    assert.deepEqual(methodsOf('setBpm')[0]?.args, [200], 'the engine must end on the project tempo');
    assert.deepEqual(methodsOf('setSwing')[0]?.args, [0.4], 'and on the project swing');
    assert.deepEqual(methodsOf('setMetronome')[0]?.args, [true], 'and on the transport metronome state');
  });

  it('publishes every mixer track to a stopped engine', () => {
    const state = createDefaultProjectState();
    const { engine, methodsOf } = createRecordingEngine();

    resynchronizeLiveEngineFromProjectState(engine, state, { metronome: false });

    assert.deepEqual(
      methodsOf('updateMixerTrack').map(call => (call.args[0] as MixerTrack).id),
      state.mixerTracks.map(track => track.id),
      'a mixer move made during the render reaches the live graph',
    );
  });

  it('publishes only the channels the engine already knows', () => {
    const state = createDefaultProjectState();
    const knownChannelId = state.channels[0].id;
    const { engine, methodsOf } = createRecordingEngine({ playing: false, knownPannerChannelIds: [knownChannelId] });

    resynchronizeLiveEngineFromProjectState(engine, state, { metronome: false });

    const published = methodsOf('updateChannel').map(call => (call.args[0] as Channel).id);
    assert.deepEqual(published, [knownChannelId], 'the publication must not build channel graph state that does not exist');
  });

  it('merges the playback collections into a take the renderer resumed', () => {
    const state = createDefaultProjectState();
    const { engine, methodsOf } = createRecordingEngine({ playing: true });

    resynchronizeLiveEngineFromProjectState(engine, state, { metronome: false });

    const updates = methodsOf('synchronizePlaybackState');
    assert.equal(updates.length, 1, 'one playback publication, not one per collection');
    const update = updates[0].args[0] as PlaybackUpdateLike;
    assert.equal(update.channels, state.channels);
    assert.equal(update.clips, state.playlistClips);
    assert.equal(update.mixerTracks, state.mixerTracks);
    assert.equal(update.playlistTracks, state.playlistTracks);
    assert.equal(
      methodsOf('updateMixerTrack').length,
      0,
      'a running take merges project edits; the graph is not overwritten behind the automation that owns it',
    );
    assert.equal(methodsOf('updateChannel').length, 0);
  });

  it('resolves the declared pattern length from the project, not a caller constant', () => {
    const base = createDefaultProjectState();
    const state: ProjectState = {
      ...base,
      patterns: base.patterns.map(pattern => pattern.id === base.selectedPatternId ? { ...pattern, lengthSteps: 32 } : pattern),
    };
    const { engine, methodsOf } = createRecordingEngine({ playing: true });

    resynchronizeLiveEngineFromProjectState(engine, state, { metronome: false });

    assert.equal(
      (methodsOf('synchronizePlaybackState')[0].args[0] as PlaybackUpdateLike).patternLengthSteps,
      32,
      'a pattern length change made during the render moves the running loop boundary',
    );
  });

  it('is idempotent: re-publishing the same document publishes the same values', () => {
    const state = withTempo(createDefaultProjectState(), 145, 0.25);
    const first = createRecordingEngine();
    const second = createRecordingEngine();

    resynchronizeLiveEngineFromProjectState(first.engine, state, { metronome: false });
    resynchronizeLiveEngineFromProjectState(second.engine, state, { metronome: false });

    assert.deepEqual(
      first.calls.map(call => call.method),
      second.calls.map(call => call.method),
      'the publication is a pure function of the project state',
    );
  });
});
