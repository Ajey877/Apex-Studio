import type { ProjectState } from '../types/daw';

/**
 * Synchronize the runtime consumer before publishing a new logical project state.
 *
 * The synchronizer is intentionally outside the state/history layer: if it throws,
 * the caller must not publish the candidate state or history entry.
 */
export function synchronizeBeforeRuntimePublication<T>(
  currentState: ProjectState,
  nextState: ProjectState,
  synchronize: (previous: ProjectState, next: ProjectState) => void,
  publish: (nextState: ProjectState) => T,
): T {
  synchronize(currentState, nextState);
  return publish(nextState);
}
