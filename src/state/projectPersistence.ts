import type { AudioRecording, Channel, PlaylistClip, ProjectState } from '../types/daw';
import { deletePersistedAudioClip, getPersistedAudioClip, getPersistedProjectRecoverySnapshotRecord, getPersistedProjectStateRecord, listPersistedAudioClipIds, listProjectBackupRecords, persistProjectRecoverySnapshotRecord, persistProjectStateRecord, replacePersistedProjectStateRecord, type StoredProjectBackup } from '../audio/audioPersistence';
import { normalizeProjectState } from './projectState';
import { getRecordingAudioBufferId } from '../audio/recordingPipeline';
import { isSampleAudioUnavailable } from './audioAssetAvailability';

export interface AudioHydrationEngine {
  loadAudioFile: (file: File | Blob, id: string) => Promise<{ buffer: AudioBuffer; peaks: number[]; duration: number }>;
}

export interface HydratedAudioResult {
  state: ProjectState;
  hydratedAudioIds: string[];
  missingAudioIds: string[];
}

export interface RestoredProjectState {
  state: ProjectState;
  restored: boolean;
  recovered: boolean;
  hydratedAudioIds: string[];
  missingAudioIds: string[];
}

const CURRENT_PROJECT_STATE_VERSION = 1;
let persistenceWriteQueue: Promise<void> = Promise.resolve();

/** Serialize project state without storing binary audio data or session-only object URLs. */
export const serializeProjectState = (state: ProjectState): string => JSON.stringify({
  persistenceVersion: CURRENT_PROJECT_STATE_VERSION,
  state
}, (key, value) => {
  if (key === 'audioBlob' || key === 'audioUrl' || key === 'blob' || key === 'url') return undefined;
  return value;
});

/**
 * Keep autosave writes ordered. IndexedDB transactions are atomic, but multiple
 * asynchronous saves must not be allowed to complete out of order when a large
 * project or slow storage makes an earlier write take longer than a later one.
 */
export const persistProjectState = async (state: ProjectState): Promise<void> => {
  const serialized = serializeProjectState(state);
  const write = persistenceWriteQueue.then(async () => {
    await persistProjectStateRecord(serialized);
    try {
      await persistProjectRecoverySnapshotRecord(serialized);
    } catch (error) {
      // The live project is already durable; a recovery-snapshot failure should not
      // turn a successful save into a reported save failure.
      console.warn('[Apex Studio] Recovery snapshot update failed after project save.', error);
    }
  });
  persistenceWriteQueue = write.catch(() => undefined);
  await write;
};

export const getAudioIdsForProject = (state: ProjectState): string[] => {
  const ids = new Set<string>();

  state.recordings?.forEach(recording => {
    ids.add(recording.audioBufferId || getRecordingAudioBufferId(recording.id));
  });

  state.playlistClips?.forEach(clip => {
    if (clip.type === 'audio' && clip.audioBufferId) ids.add(clip.audioBufferId);
  });

  state.channels?.forEach(channel => {
    if (channel.customSample?.id) ids.add(channel.customSample.id);
    channel.sampleZones?.forEach(zone => {
      if (zone.sampleId) ids.add(zone.sampleId);
    });
  });

  return [...ids];
};

const hydrateRecording = async (
  recording: AudioRecording,
  audioEngine: AudioHydrationEngine
): Promise<{ recording: AudioRecording; hydrated: boolean; audioId: string }> => {
  const audioId = recording.audioBufferId || getRecordingAudioBufferId(recording.id);
  const blob = await getPersistedAudioClip(audioId);
  if (!blob || blob.size === 0) {
    return { recording: { ...recording, audioBufferId: audioId }, hydrated: false, audioId };
  }

  await audioEngine.loadAudioFile(blob, audioId);
  return {
    recording: {
      ...recording,
      audioBufferId: audioId,
      audioBlob: blob,
      audioUrl: URL.createObjectURL(blob)
    },
    hydrated: true,
    audioId
  };
};

/**
 * Hydrate all audio assets referenced by a ProjectState into AudioEngine memory.
 * Restores recording blobs and URLs, marks clips and channel samples as
 * available/unavailable, and loads available blobs into the audio engine.
 */
export const hydrateProjectAudio = async (
  state: ProjectState,
  audioEngine: AudioHydrationEngine
): Promise<HydratedAudioResult> => {
  const hydratedAudioIds: string[] = [];
  const missingAudioIds: string[] = [];

  const restoredRecordings = await Promise.all(state.recordings.map(async recording => {
    try {
      const result = await hydrateRecording(recording, audioEngine);
      if (result.hydrated) hydratedAudioIds.push(result.audioId);
      else missingAudioIds.push(result.audioId);
      return result.recording;
    } catch (error) {
      const audioId = recording.audioBufferId || getRecordingAudioBufferId(recording.id);
      missingAudioIds.push(audioId);
      console.warn(`[Apex Studio] Could not restore recording audio ${audioId}`, error);
      return { ...recording, audioBufferId: audioId };
    }
  }));

  const loadedIds = new Set(hydratedAudioIds);
  const clipIds = getAudioIdsForProject({ ...state, recordings: restoredRecordings });
  for (const audioId of clipIds) {
    if (loadedIds.has(audioId)) continue;
    try {
      const blob = await getPersistedAudioClip(audioId);
      if (!blob || blob.size === 0) {
        missingAudioIds.push(audioId);
        continue;
      }
      await audioEngine.loadAudioFile(blob, audioId);
      hydratedAudioIds.push(audioId);
      loadedIds.add(audioId);
    } catch (error) {
      missingAudioIds.push(audioId);
      console.warn(`[Apex Studio] Could not restore audio asset ${audioId}`, error);
    }
  }

  const missingIds = new Set(missingAudioIds);
  const playlistClips: PlaylistClip[] = state.playlistClips.map(clip => {
    if (clip.type !== 'audio' || !clip.audioBufferId) return clip;
    return { ...clip, audioUnavailable: missingIds.has(clip.audioBufferId) };
  });

  // Phase 8C (P1-11): channel samples are hydrated from the same asset store, so
  // they carry the same availability flag. Unchanged channels keep their identity
  // to avoid pointless state churn.
  const channels: Channel[] = state.channels.map(channel => {
    const sample = channel.customSample;
    if (!sample?.id) return channel;
    const audioUnavailable = missingIds.has(sample.id);
    if (isSampleAudioUnavailable(sample) === audioUnavailable) return channel;
    return { ...channel, customSample: { ...sample, audioUnavailable } };
  });

  return {
    state: {
      ...state,
      recordings: restoredRecordings,
      playlistClips,
      channels
    },
    hydratedAudioIds: [...new Set(hydratedAudioIds)],
    missingAudioIds: [...new Set(missingAudioIds)]
  };
};

/** Restore the persisted project and re-register every referenced audio asset before playback. */
export const restorePersistedProjectState = async (
  audioEngine: AudioHydrationEngine,
  fallbackState: ProjectState
): Promise<RestoredProjectState> => {
  const stateJson = await getPersistedProjectStateRecord();

  const recoverFromSerialized = async (
    candidateJson: string,
    source: string
  ): Promise<RestoredProjectState | null> => {
    try {
      const parsed = JSON.parse(candidateJson) as { persistenceVersion?: number; state?: unknown };
      const rawState = parsed?.state ?? parsed;
      const state = normalizeProjectState(rawState);
      const hydrated = await hydrateProjectAudio(state, audioEngine);
      return {
        state: hydrated.state,
        restored: true,
        recovered: source !== 'current-project',
        hydratedAudioIds: hydrated.hydratedAudioIds,
        missingAudioIds: hydrated.missingAudioIds
      };
    } catch (error) {
      console.warn(`[Apex Studio] Project recovery candidate (${source}) could not be restored.`, error);
      return null;
    }
  };

  if (stateJson) {
    const current = await recoverFromSerialized(stateJson, 'current-project');
    if (current) return current;
  }

  // Keep one separate last-known-good snapshot. It is intentionally attempted
  // before replacement backups because it is the closest recovery point.
  const recoveryJson = await getPersistedProjectRecoverySnapshotRecord();
  if (recoveryJson) {
    const recovered = await recoverFromSerialized(recoveryJson, 'recovery-snapshot');
    if (recovered) {
      try {
        // Atomically replace the corrupt active record with the valid snapshot.
        await replacePersistedProjectStateRecord(recoveryJson);
      } catch (error) {
        console.warn('[Apex Studio] Could not replace the corrupt project record with its recovery snapshot.', error);
      }
      return recovered;
    }
  }

  // Last resort: retained pre-replacement backups.
  try {
    const backups = [...await listProjectBackupRecords()]
      .sort((left, right) => (right.createdAt - left.createdAt) || right.id.localeCompare(left.id));

    for (const backup of backups) {
      const recovered = await recoverFromSerialized(backup.stateJson, `backup:${backup.id}`);
      if (!recovered) continue;
      try {
        await replacePersistedProjectStateRecord(backup.stateJson);
      } catch (error) {
        console.warn('[Apex Studio] Could not promote the backup to the active project record.', error);
      }
      return recovered;
    }
  } catch (error) {
    console.warn('[Apex Studio] Project backup recovery lookup failed.', error);
  }

  if (stateJson) {
    console.warn('[Apex Studio] Persisted project state could not be restored; using a fresh project.');
  }
  return {
    state: fallbackState,
    restored: false,
    recovered: false,
    hydratedAudioIds: [],
    missingAudioIds: []
  };
};

export interface AudioReconciliationOptions {
  additionalStates?: ProjectState[];
  history?: {
    present: ProjectState;
    past: readonly { state: ProjectState }[];
    future: readonly { state: ProjectState }[];
  };
  additionalReferencedIds?: Iterable<string>;
  storage?: {
    listPersistedAudioClipIds: () => Promise<string[]>;
    deletePersistedAudioClip: (id: string) => Promise<void>;
    /** Optional override for the retained project backups whose audio must survive. */
    listProjectBackupRecords?: () => Promise<StoredProjectBackup[]>;
  };
}

/**
 * Audio ids referenced by a stored backup document. Unreadable backups
 * contribute nothing (they cannot be restored, so their audio is not needed).
 */
export const getAudioIdsFromStoredBackup = (record: Pick<StoredProjectBackup, 'stateJson'>): string[] => {
  try {
    const parsed = JSON.parse(record.stateJson) as { state?: unknown } | null;
    const rawState = parsed && typeof parsed === 'object' && 'state' in parsed ? parsed.state : parsed;
    if (!rawState || typeof rawState !== 'object') return [];
    return getAudioIdsForProject(rawState as ProjectState);
  } catch {
    return [];
  }
};

export interface AudioReconciliationResult {
  preservedIds: string[];
  removedIds: string[];
}

/**
 * Reconciles persisted audio assets against the active project state (and optional history states).
 * - Preserves any asset referenced by the active project, additional states, or history past/future.
 * - Preserves any asset referenced by a retained project backup (Phase 8A replacement safety net).
 * - Removes unreferenced orphan assets from persistent storage.
 * - Does not modify or corrupt the project state.
 * - Never deletes an asset merely because it was missing or temporarily unavailable during hydration.
 */
export const reconcilePersistedAudio = async (
  activeState: ProjectState,
  options?: AudioReconciliationOptions
): Promise<AudioReconciliationResult> => {
  const referencedIds = new Set<string>(getAudioIdsForProject(activeState));

  if (options?.additionalStates) {
    for (const state of options.additionalStates) {
      for (const id of getAudioIdsForProject(state)) {
        referencedIds.add(id);
      }
    }
  }

  if (options?.history) {
    for (const id of getAudioIdsForProject(options.history.present)) {
      referencedIds.add(id);
    }
    for (const entry of options.history.past) {
      for (const id of getAudioIdsForProject(entry.state)) {
        referencedIds.add(id);
      }
    }
    for (const entry of options.history.future) {
      for (const id of getAudioIdsForProject(entry.state)) {
        referencedIds.add(id);
      }
    }
  }

  if (options?.additionalReferencedIds) {
    for (const id of options.additionalReferencedIds) {
      if (id) referencedIds.add(id);
    }
  }

  const listFn = options?.storage?.listPersistedAudioClipIds ?? listPersistedAudioClipIds;
  const deleteFn = options?.storage?.deletePersistedAudioClip ?? deletePersistedAudioClip;
  const listBackupsFn = options?.storage?.listProjectBackupRecords ?? listProjectBackupRecords;

  // If the backups cannot be enumerated we must not guess: the thrown error aborts
  // reconciliation before anything is deleted (saveAndReconcileProjectState logs it).
  for (const backup of await listBackupsFn()) {
    for (const id of getAudioIdsFromStoredBackup(backup)) {
      referencedIds.add(id);
    }
  }

  const persistedIds = await listFn();
  const preservedIds: string[] = [];
  const removedIds: string[] = [];

  for (const id of persistedIds) {
    if (referencedIds.has(id)) {
      preservedIds.push(id);
    } else {
      await deleteFn(id);
      removedIds.push(id);
    }
  }

  return {
    preservedIds,
    removedIds
  };
};

export interface SaveAndReconcileOptions extends AudioReconciliationOptions {
  reconcileAudio?: boolean;
}

/**
 * Persists the project state and, when requested, reconciles persisted audio assets.
 * Audio reconciliation only runs if project persistence succeeds first.
 * Reconciliation failure will not turn a successful project persistence write into a save failure.
 */
export const saveAndReconcileProjectState = async (
  state: ProjectState,
  options?: SaveAndReconcileOptions
): Promise<AudioReconciliationResult | null> => {
  await persistProjectState(state);
  if (options?.reconcileAudio === false) {
    return null;
  }
  try {
    return await reconcilePersistedAudio(state, options);
  } catch (reconcileError) {
    console.warn('[Apex Studio] Audio reconciliation failed after save.', reconcileError);
    return null;
  }
};

