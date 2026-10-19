/**
 * Shared finalization for MIDI performance takes.
 *
 * A take is timed by the transport's continuous musical position, so any
 * transport discontinuity — pause, playlist seek, Pattern/Song mode switch,
 * natural Song end, manual Stop, or the input device disappearing — must
 * close the take at the position *before* the discontinuity. If it did not,
 * a note held across the boundary would be timed against a paused, jumped
 * or reset clock: stretched across the gap, extended to the new playhead,
 * or collapsed to the minimum duration by a backward jump, and its live
 * monitor voice would be left in stale held-note bookkeeping after the
 * engine tore the take's audio down.
 *
 * `finishMidiTake` is the single finalization path the App uses for every
 * way a take can end. It reuses the recorder's existing commit semantics:
 * `MidiPerformanceRecorder.stop` closes held gates at the supplied clock
 * and returns the take's notes, which the caller's `commitTake` port writes
 * to the take's original channel/pattern as one history entry (App passes
 * `appendRecordedNotesToChannelInProjectState` through its mutation layer).
 * Project mutation therefore stays with the App — this module and the audio
 * engine never touch project state.
 *
 * Boundary endings pass `releaseHeldNotes: true` so held live-monitor notes
 * are released and their bookkeeping cleared even when no take is armed
 * (a keyboard can also vanish while merely being monitored). Ending a take
 * from the record toggle passes no release: a key the player is still
 * physically holding keeps sounding until its own note-off, exactly as
 * before. Calling it when nothing is recording is always safe, so each
 * boundary finalizes at most once: the first call closes the take, later
 * calls find no recorder running and only re-release an already-empty
 * held-note set.
 */

import type { Note } from '../types/daw';
import type {
  MidiPerformanceRecorder,
  MidiRecordingClock,
  MidiRecordingTarget,
} from './midiRecording';

export interface MidiTakeFinalizationPorts {
  /** The recorder holding the in-flight take (`null` during teardown). */
  getRecorder: () => MidiPerformanceRecorder | null;
  /** Transport clock sampled when no explicit boundary clock is supplied. */
  getClock: () => MidiRecordingClock;
  /** Commits the finalized notes to the take's original channel/pattern. */
  commitTake: (target: MidiRecordingTarget, notes: readonly Note[]) => void;
  /** Releases every held live-monitor note and clears its bookkeeping. */
  releaseHeldNotes: () => void;
  /** Resets recording UI state (armed flag, target label, captured count). */
  onTakeEnded: () => void;
}

export interface FinishMidiTakeOptions {
  /**
   * Explicit pre-boundary position (e.g. the Song-end endpoint reported by
   * the engine). Defaults to the ports' live transport clock, which the
   * caller must sample *before* moving the playhead.
   */
  clock?: MidiRecordingClock;
  /**
   * Transport boundaries and device loss also release held live-monitor
   * notes; ending a take from the record toggle does not.
   */
  releaseHeldNotes?: boolean;
}

/**
 * Ends the active take, if any: held gates close at the boundary clock, the
 * recording UI resets, and a non-empty take commits through `commitTake`
 * against the target captured when the take started. Returns `true` when a
 * take was actually finalized.
 */
export const finishMidiTake = (
  ports: MidiTakeFinalizationPorts,
  options: FinishMidiTakeOptions = {},
): boolean => {
  const recorder = ports.getRecorder();
  let finalized = false;
  if (recorder?.isRecording) {
    const target = recorder.activeTarget;
    const notes = recorder.stop(options.clock ?? ports.getClock());
    finalized = true;
    ports.onTakeEnded();
    if (target && notes.length > 0) {
      ports.commitTake(target, notes);
    }
  }
  if (options.releaseHeldNotes) {
    ports.releaseHeldNotes();
  }
  return finalized;
};
