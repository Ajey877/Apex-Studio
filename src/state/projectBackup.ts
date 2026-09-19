import type { ProjectState } from '../types/daw';
import {
  PROJECT_BACKUP_ID_PREFIX,
  deleteProjectBackupRecord,
  isProjectBackupId,
  listProjectBackupRecords,
  persistProjectBackupRecord,
  type StoredProjectBackup
} from '../audio/audioPersistence';
import { normalizeProjectState } from './projectState';
import { getAudioIdsForProject, serializeProjectState } from './projectPersistence';

/**
 * Phase 8A — project replacement backups.
 *
 * Loading a demo, importing a manifest/bundle or starting a new session used to
 * overwrite the only persisted project (and reconcile away its audio) with no
 * way back. Before a destructive replacement the current project is now stored
 * as a backup record; the newest MAX_PROJECT_BACKUPS are retained and any audio
 * they reference survives persisted-audio reconciliation until they rotate out.
 */

export const MAX_PROJECT_BACKUPS = 5;

export type ProjectBackupReason = 'replace' | 'manual';

export interface ProjectBackupSummary {
  id: string;
  name: string;
  reason: string;
  createdAt: number;
  channelCount: number;
  clipCount: number;
  recordingCount: number;
  audioIds: string[];
}

export interface ProjectBackupStorage {
  persistProjectBackupRecord: (record: StoredProjectBackup) => Promise<void>;
  listProjectBackupRecords: () => Promise<StoredProjectBackup[]>;
  deleteProjectBackupRecord: (id: string) => Promise<void>;
}

export interface CreateProjectBackupOptions {
  reason?: ProjectBackupReason;
  /** Injected for deterministic ids/timestamps in tests. */
  now?: number;
  id?: string;
}

export interface BackupProjectOptions extends CreateProjectBackupOptions {
  storage?: ProjectBackupStorage;
  maxBackups?: number;
}

export interface BackupProjectResult {
  record: StoredProjectBackup;
  /** Older backups that were rotated out to honour the retention limit. */
  removedIds: string[];
}

/** Raised when a backup could not be written; callers must not treat this as a successful backup. */
export class ProjectBackupError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ProjectBackupError';
    this.cause = cause;
  }
}

const defaultStorage: ProjectBackupStorage = {
  persistProjectBackupRecord,
  listProjectBackupRecords,
  deleteProjectBackupRecord
};

const resolveStorage = (storage?: ProjectBackupStorage): ProjectBackupStorage => storage ?? defaultStorage;

const randomSuffix = (): string => Math.random().toString(36).slice(2, 8);

export const createProjectBackupId = (now: number): string =>
  `${PROJECT_BACKUP_ID_PREFIX}${now}-${randomSuffix()}`;

const sortNewestFirst = (records: StoredProjectBackup[]): StoredProjectBackup[] =>
  [...records].sort((left, right) => (right.createdAt - left.createdAt) || right.id.localeCompare(left.id));

/** Parses a stored backup document; returns null when it is unreadable instead of throwing. */
export const parseProjectBackupState = (record: Pick<StoredProjectBackup, 'stateJson'>): ProjectState | null => {
  try {
    const parsed = JSON.parse(record.stateJson) as { persistenceVersion?: number; state?: unknown };
    const rawState = parsed && typeof parsed === 'object' && 'state' in parsed ? parsed.state : parsed;
    return normalizeProjectState(rawState);
  } catch (error) {
    console.warn('[Apex Studio] Project backup could not be parsed.', error);
    return null;
  }
};

/** Builds the storage record for a project snapshot without binary audio or session-only URLs. */
export const createProjectBackupRecord = (
  state: ProjectState,
  options?: CreateProjectBackupOptions
): StoredProjectBackup => {
  const now = options?.now ?? Date.now();
  const id = options?.id ?? createProjectBackupId(now);
  if (!isProjectBackupId(id)) {
    throw new ProjectBackupError(`Project backup ids must start with "${PROJECT_BACKUP_ID_PREFIX}"`);
  }
  return {
    id,
    name: state.meta?.name || 'Untitled Session',
    reason: options?.reason ?? 'replace',
    createdAt: now,
    stateJson: serializeProjectState(state)
  };
};

export const summarizeProjectBackup = (record: StoredProjectBackup): ProjectBackupSummary => {
  const state = parseProjectBackupState(record);
  return {
    id: record.id,
    name: record.name,
    reason: record.reason,
    createdAt: record.createdAt,
    channelCount: state?.channels.length ?? 0,
    clipCount: state?.playlistClips.length ?? 0,
    recordingCount: state?.recordings.length ?? 0,
    audioIds: state ? getAudioIdsForProject(state) : []
  };
};

/**
 * Stores a backup of `state` and enforces the retention limit (newest first).
 * Throws ProjectBackupError when the backup itself cannot be written; retention
 * clean-up failures are logged but never fail a successfully written backup.
 */
export const backupProjectBeforeReplacement = async (
  state: ProjectState,
  options?: BackupProjectOptions
): Promise<BackupProjectResult> => {
  const storage = resolveStorage(options?.storage);
  const maxBackups = Math.max(1, Math.floor(options?.maxBackups ?? MAX_PROJECT_BACKUPS));
  const record = createProjectBackupRecord(state, options);

  try {
    await storage.persistProjectBackupRecord(record);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Project backup could not be written';
    throw new ProjectBackupError(`Project backup failed: ${message}`, error);
  }

  const removedIds: string[] = [];
  try {
    const existing = sortNewestFirst(await storage.listProjectBackupRecords());
    const overflow = existing.filter(candidate => candidate.id !== record.id).slice(Math.max(0, maxBackups - 1));
    for (const stale of overflow) {
      await storage.deleteProjectBackupRecord(stale.id);
      removedIds.push(stale.id);
    }
  } catch (error) {
    console.warn('[Apex Studio] Project backup retention clean-up failed; extra backups were kept.', error);
  }

  return { record, removedIds };
};

/** Newest-first summaries for the Project Hub. */
export const listProjectBackups = async (storage?: ProjectBackupStorage): Promise<ProjectBackupSummary[]> => {
  const records = await resolveStorage(storage).listProjectBackupRecords();
  return sortNewestFirst(records).map(summarizeProjectBackup);
};

/** Loads a backup as a normalized ProjectState, or null when it no longer exists / cannot be parsed. */
export const restoreProjectBackupState = async (
  id: string,
  storage?: ProjectBackupStorage
): Promise<ProjectState | null> => {
  const records = await resolveStorage(storage).listProjectBackupRecords();
  const record = records.find(candidate => candidate.id === id);
  return record ? parseProjectBackupState(record) : null;
};

export const deleteProjectBackup = async (id: string, storage?: ProjectBackupStorage): Promise<void> => {
  await resolveStorage(storage).deleteProjectBackupRecord(id);
};

/** Audio asset ids referenced by any retained backup; these must survive reconciliation. */
export const getAudioIdsReferencedByBackups = async (storage?: ProjectBackupStorage): Promise<string[]> => {
  const records = await resolveStorage(storage).listProjectBackupRecords();
  const ids = new Set<string>();
  for (const record of records) {
    const state = parseProjectBackupState(record);
    if (!state) continue;
    for (const id of getAudioIdsForProject(state)) ids.add(id);
  }
  return [...ids];
};
