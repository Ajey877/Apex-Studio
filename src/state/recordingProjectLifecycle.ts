export type RecordingProjectGeneration = number;

export const nextRecordingProjectGeneration = (
  generation: RecordingProjectGeneration
): RecordingProjectGeneration => generation + 1;

export const isRecordingProjectGenerationCurrent = (
  recordingGeneration: RecordingProjectGeneration,
  currentGeneration: RecordingProjectGeneration
): boolean => recordingGeneration === currentGeneration;
