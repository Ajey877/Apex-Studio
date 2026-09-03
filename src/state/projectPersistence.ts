import type { AudioRecording, PlaylistClip, ProjectState } from '../types/daw';
import { getPersistedAudioClip, getPersistedProjectStateRecord, persistProjectStateRecord } from '../audio/audioPersistence';
import { normalizeProjectState } from './projectState';
import { getRecordingAudioBufferId } from '../audio/recordingPipeline';

export interface AudioHydrationEngine {
  loadAudioFile: (file: File | Blob, id: string) => Promise<{ buffer: AudioBuffer; peaks: number[]; duration: number }>;
}

export interface RestoredProjectState {
  state: ProjectState;
  restored: boolean;
  hydratedAudioIds: string[];
  missingAudioIds: string[];
}

const CURRENT_PROJECT_STATE_VERSION = 1;

/** Serialize project state without storing binary audio data or session-only object URLs. */
export const serializeProjectState = (state: ProjectState): string => JSON.stringify({
  persistenceVersion: CURRENT_PROJECT_STATE_VERSION,
  state
}, (key, value) => {
  if (key === 'audioBlob' || key === 'audioUrl' || key === 'blob' || key === 'url') return undefined;
  return value;
});

export const persistProjectState = async (state: ProjectState): Promise<void> => {
  await persistProjectStateRecord(serializeProjectState(state));
};

const getAudioIdsForProject = (state: ProjectState): string[] => {
  const ids = new Set<string>();

  state.recordings.forEach(recording => {
    ids.add(recording.audioBufferId || getRecordingAudioBufferId(recording.id));
  });

  state.playlistClips.forEach(clip => {
    if (clip.type === 'audio' && clip.audioBufferId) ids.add(clip.audioBufferId);
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

/** Restore the persisted project and re-register every referenced audio asset before playback. */
export const restorePersistedProjectState = async (
  audioEngine: AudioHydrationEngine,
  fallbackState: ProjectState
): Promise<RestoredProjectState> => {
  const stateJson = await getPersistedProjectStateRecord();
  if (!stateJson) {
    return { state: fallbackState, restored: false, hydratedAudioIds: [], missingAudioIds: [] };
  }

  try {
    const parsed = JSON.parse(stateJson) as { persistenceVersion?: number; state?: unknown };
    const rawState = parsed?.state ?? parsed;
    const state = normalizeProjectState(rawState);
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

    return {
      state: {
        ...state,
        recordings: restoredRecordings,
        playlistClips
      },
      restored: true,
      hydratedAudioIds: [...new Set(hydratedAudioIds)],
      missingAudioIds: [...new Set(missingAudioIds)]
    };
  } catch (error) {
    console.warn('[Apex Studio] Persisted project state could not be restored; using a fresh project.', error);
    return { state: fallbackState, restored: false, hydratedAudioIds: [], missingAudioIds: [] };
  }
};
