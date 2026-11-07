export type RecordingProjectGeneration = number;

export const nextRecordingProjectGeneration = (
  generation: RecordingProjectGeneration
): RecordingProjectGeneration => generation + 1;

export const isRecordingProjectGenerationCurrent = (
  recordingGeneration: RecordingProjectGeneration,
  currentGeneration: RecordingProjectGeneration
): boolean => recordingGeneration === currentGeneration;

/**
 * Applies a recording publication synchronously only while it still belongs to
 * the active project. Call after asynchronous asset registration/persistence;
 * the callback must contain the project-state/history commit as one JS turn.
 */
export const commitRecordingForCurrentProject = (
  recordingGeneration: RecordingProjectGeneration,
  currentGeneration: RecordingProjectGeneration,
  commit: () => void,
): boolean => {
  if (!isRecordingProjectGenerationCurrent(recordingGeneration, currentGeneration)) return false;
  commit();
  return true;
};
