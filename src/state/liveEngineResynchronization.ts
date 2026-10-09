import type { Channel, GrossBeatState, MixerTrack, PlaylistClip, PlaylistTrack, ProjectState } from '../types/daw';
import { getSelectedPatternLengthSteps } from './patternLength';
import { DEFAULT_GROSS_BEAT_STATE } from './projectState';

/**
 * Phase 66 F2: re-publish the authoritative project runtime state to the live
 * engine after an offline render released its lease.
 *
 * An offline timeline render swaps the engine's live graph for the frozen
 * offline take and fences live callers out (`AudioEngine.renderTimelineOffline`,
 * Phase 50/51). Everything the user changes while the export runs — tempo, swing,
 * mixer moves, channel edits, playlist edits — is written to the project document
 * in React, but the engine calls that would apply it are discarded by the lease,
 * and the App only publishes those values on a *change*. Without this step the
 * engine keeps playing the pre-render tempo/swing/mixer while the UI shows the
 * new ones (`/tmp/probes/p3_lease.ts`).
 *
 * The project document is the source of truth, so this is a publication and not
 * a merge: the engine's settings are set, a running take receives the playback
 * collections through the same merge path a live edit uses, and a stopped engine
 * additionally gets the mixer/channel graph state a concrete control owns. It
 * deliberately does not create graph state that the engine has never built (a
 * channel with no panner is left alone) — the same rule `App.tsx` follows when it
 * publishes a stopped engine.
 */
export interface LiveEngineResynchronizationPort {
  setBpm(bpm: number): void;
  setTimeSignature(meter: readonly [number, number] | undefined): void;
  /** Phase 1J: 7/8 metronome accent grouping (optional for narrow test ports). */
  setSevenEightGrouping?(grouping: string | undefined): void;
  /** Phase 1K: recording count-in length (optional for narrow test ports). */
  setCountInBars?(bars: number | undefined): void;
  setSwing(swing: number): void;
  setMetronome(enabled: boolean): void;
  setGrossBeatState(state: GrossBeatState): void;
  setMasterVolume(linearGain: number): void;
  isPlaybackActive(): boolean;
  synchronizePlaybackState(update: {
    channels?: Channel[];
    clips?: PlaylistClip[];
    mixerTracks?: MixerTrack[];
    playlistTracks?: PlaylistTrack[];
    patternLengthSteps?: number;
  }): void;
  updateMixerTrack(track: MixerTrack): void;
  updateChannel(channel: Channel): void;
  getChannelPanner(channelId: string): unknown;
}

export interface LiveEngineResynchronizationOptions {
  /**
   * Transport metronome: UI/transport state rather than project data, so the
   * caller supplies it. It is fenced by the lease like every other live write.
   */
  metronome: boolean;
}

export function resynchronizeLiveEngineFromProjectState(
  engine: LiveEngineResynchronizationPort,
  state: ProjectState,
  options: LiveEngineResynchronizationOptions,
): void {
  engine.setBpm(state.meta.bpm);
  // Phase 1F/1I: the meter is runtime state the same way tempo is — a render
  // lease release must re-publish it so the live take plays the project's
  // actual bar size (resolved to the legacy 4/4 grid when unsupported).
  engine.setTimeSignature(state.meta.timeSignature);
  engine.setSevenEightGrouping?.(state.meta.sevenEightGrouping);
  // Phase 1K: the recording count-in setting travels with the rest of the
  // project runtime state (post-render resync included).
  engine.setCountInBars?.(state.meta.countInBars);
  engine.setSwing(state.meta.swing);
  engine.setMetronome(options.metronome);
  // Phase 79: Gross Beat state is project-owned. Any path that republishes
  // project state to the engine (load, undo/redo, post-offline-resync) must
  // push the gate pattern so the master bus can't drift out of sync with the
  // document.
  engine.setGrossBeatState(state.grossBeatState ?? DEFAULT_GROSS_BEAT_STATE);
  // Phase 79: ProjectMetadata.masterVolume was previously persisted but not
  // applied; wiring it here (trivial setTargetAtTime on the existing master
  // gain node) makes it real without adding new DSP.
  engine.setMasterVolume(typeof state.meta.masterVolume === 'number' ? state.meta.masterVolume : 1.0);

  // A take the renderer resumed is a running take: project edits belong in it via
  // the same merge path a live edit uses, so in-flight automation values survive
  // until their next automation event. This is a no-op when nothing is playing.
  engine.synchronizePlaybackState({
    channels: state.channels,
    clips: state.playlistClips,
    mixerTracks: state.mixerTracks,
    playlistTracks: state.playlistTracks,
    patternLengthSteps: getSelectedPatternLengthSteps(state),
  });

  if (engine.isPlaybackActive()) return;

  for (const track of state.mixerTracks) {
    engine.updateMixerTrack(track);
  }
  for (const channel of state.channels) {
    if (engine.getChannelPanner(channel.id)) {
      engine.updateChannel(channel);
    }
  }
}
