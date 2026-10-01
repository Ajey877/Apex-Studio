import type { ProjectState } from '../types/daw';
import { createDefaultProjectState } from './projectState';
import type { ProjectReplacementSource } from './projectReplacement';

/**
 * The single New Session request used by both the Project Hub tile and the
 * File → New Session menu command.
 *
 * This is intentionally not a second project-creation mechanism: it produces the
 * same blank document and the same replacement source the Hub has always used, so
 * both entry points funnel into `App.handleLoadProjectState`, which owns the
 * Phase 8A confirmation + backup policy, runtime synchronization, history reset,
 * audio hydration and persistence.
 */
export const NEW_SESSION_SOURCE: ProjectReplacementSource = 'new-session';

export interface NewSessionRequest {
  state: ProjectState;
  options: { source: ProjectReplacementSource };
}

export const createNewSessionRequest = (): NewSessionRequest => ({
  state: createDefaultProjectState(),
  options: { source: NEW_SESSION_SOURCE },
});
