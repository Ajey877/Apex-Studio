import type { ProjectState } from '../types/daw';
import { notePlaylistAudioPlaylistRevision } from './playlistAudioPublication';

/**
 * Synchronize runtime consumers before publishing a new logical project state.
 * If synchronization fails, restore the previous runtime state when a focused
 * caller can provide that containment operation, then rethrow the failure.
 */
export function synchronizeBeforeRuntimePublication<T>(
  currentState: ProjectState,
  nextState: ProjectState,
  synchronize: (previous: ProjectState, next: ProjectState) => void,
  publish: (nextState: ProjectState) => T,
  restore?: (previousState: ProjectState) => void,
): T {
  try {
    synchronize(currentState, nextState);
  } catch (error) {
    if (restore) {
      try {
        restore(currentState);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          'Runtime synchronization failed and previous audio state could not be restored.',
        );
      }
    }
    throw error;
  }

  const result = publish(nextState);
  notePlaylistAudioPlaylistRevision(currentState.playlistClips, nextState.playlistClips);
  return result;
}
