import type { ProjectState } from '../types/daw';
import { PRESET_PROJECTS } from '../audio/presets';
import { createDefaultProjectState } from './projectState';
import { sanitizeProjectSnapshot } from './projectHistory';
import { advancePlaylistAudioProjectGeneration } from './playlistAudioPublication';

/**
 * Phase 8A — destructive project replacement policy.
 *
 * Replacing the open project (demo templates, manifest/bundle import, "New
 * Session", backup restore) overwrites the single persisted project. The
 * decision of whether that needs an explicit confirmation + backup is kept
 * here as pure logic so the UI only has to render the plan.
 */

export type ProjectReplacementSource =
  | 'studio-demo'
  | 'new-session'
  | 'manifest-import'
  | 'bundle-import'
  | 'backup-restore'
  | 'unknown';

export interface ProjectReplacementPlan {
  /** True when the current project contains work that is not a pristine template. */
  requiresConfirmation: boolean;
  /** True when the current project must be backed up before it is replaced. */
  shouldBackup: boolean;
  currentName: string;
  incomingName: string;
  source: ProjectReplacementSource;
  reason: 'pristine-current' | 'current-has-work';
}

export interface PlanProjectReplacementOptions {
  source?: ProjectReplacementSource;
  /** Projects that count as "nothing to lose" (blank session + bundled demos by default). */
  templates?: ProjectState[];
}

let cachedTemplateFingerprints: Set<string> | null = null;

/**
 * Semantic fingerprint of a project document. Volatile metadata (ids and
 * timestamps) and UI selection state are ignored so that an untouched
 * template still matches after it has been persisted and restored.
 */
export const getProjectFingerprint = (state: ProjectState): string => {
  const snapshot = sanitizeProjectSnapshot(state);
  const { selectedPatternId: _pattern, selectedChannelId: _channel, selectedMixerTrackId: _mixer, ...document } = snapshot;
  return JSON.stringify({
    ...document,
    meta: {
      ...document.meta,
      id: '',
      created: 0,
      updated: 0,
      totalEditTimeSeconds: 0
    }
  });
};

const getDefaultTemplateFingerprints = (): Set<string> => {
  if (!cachedTemplateFingerprints) {
    cachedTemplateFingerprints = new Set<string>([
      getProjectFingerprint(createDefaultProjectState()),
      ...PRESET_PROJECTS.map(preset => getProjectFingerprint(preset.state))
    ]);
  }
  return cachedTemplateFingerprints;
};

/** A project is pristine when it is semantically identical to a blank session or an untouched bundled demo. */
export const isPristineProject = (state: ProjectState, templates?: ProjectState[]): boolean => {
  const fingerprint = getProjectFingerprint(state);
  if (templates) {
    return templates.some(template => getProjectFingerprint(template) === fingerprint);
  }
  return getDefaultTemplateFingerprints().has(fingerprint);
};

export const describeReplacementSource = (source: ProjectReplacementSource): string => {
  switch (source) {
    case 'studio-demo': return 'Studio demo';
    case 'new-session': return 'New session';
    case 'manifest-import': return 'Project manifest import';
    case 'bundle-import': return 'Portable bundle import';
    case 'backup-restore': return 'Backup restore';
    default: return 'Project load';
  }
};

export const planProjectReplacement = (
  current: ProjectState,
  incoming: ProjectState,
  options?: PlanProjectReplacementOptions
): ProjectReplacementPlan => {
  const source = options?.source ?? 'unknown';
  const currentName = current.meta?.name || 'Untitled Session';
  const incomingName = incoming.meta?.name || 'Untitled Session';
  const pristine = isPristineProject(current, options?.templates);

  return {
    requiresConfirmation: !pristine,
    shouldBackup: !pristine,
    currentName,
    incomingName,
    source,
    reason: pristine ? 'pristine-current' : 'current-has-work'
  };
};

/**
 * Runs the destructive part of a replacement only after its required backup
 * has completed. A rejected backup deliberately prevents `replace` from being
 * called, so callers cannot accidentally stop, hydrate, or reconcile first.
 */
export const runProjectReplacementAfterBackup = async <T>(
  backup: (() => Promise<void>) | undefined,
  replace: () => Promise<T> | T
): Promise<T> => {
  if (backup) await backup();
  // Invalidate pending dropped/bounced playlist-audio publications immediately
  // before the incoming project is allowed to become current.
  advancePlaylistAudioProjectGeneration();
  return replace();
};
