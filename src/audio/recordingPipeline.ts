import type { AudioRecording, PlaylistClip, PlaylistTrack } from '../types/daw';

export interface RecordingBufferRegistration {
  id: string;
  buffer: AudioBuffer;
  peaks: number[];
  duration: number;
}

export const getRecordingAudioBufferId = (recordingId: string): string => {
  if (!recordingId.trim()) throw new Error('Recording ID is required');
  return `recording-${recordingId}`;
};

export const getRecordingLengthBars = (durationSeconds: number, bpm: number): number => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('Recording duration must be greater than zero');
  const safeBpm = Number.isFinite(bpm) ? Math.max(20, bpm) : 120;
  const secondsPerBar = 240 / safeBpm;
  return Math.max(1, Math.ceil(durationSeconds / secondsPerBar));
};

export const validateRecordingTargetTrack = (tracks: PlaylistTrack[], targetTrackIndex: number): PlaylistTrack => {
  if (!Number.isInteger(targetTrackIndex) || targetTrackIndex < 0) {
    throw new Error('Invalid playlist track selected for the recording');
  }
  const track = tracks[targetTrackIndex];
  if (!track) throw new Error('The selected playlist track no longer exists');
  return track;
};

export const createRecordingPlaylistClip = (
  recording: AudioRecording,
  registration: RecordingBufferRegistration,
  tracks: PlaylistTrack[],
  targetTrackIndex: number,
  bpm: number,
  id = `rec-clip-${Date.now()}`
): PlaylistClip => {
  if (!recording.audioBlob || recording.audioBlob.size === 0) throw new Error('The recording contains no audio data');
  if (registration.id !== getRecordingAudioBufferId(recording.id)) throw new Error('Recording audio buffer registration does not match the recording');
  if (!registration.buffer || registration.buffer.duration <= 0) throw new Error('The recording audio buffer is invalid');
  if (!Array.isArray(registration.peaks) || registration.peaks.length === 0) throw new Error('The recording waveform is unavailable');

  validateRecordingTargetTrack(tracks, targetTrackIndex);
  const lengthBars = getRecordingLengthBars(registration.duration, bpm);

  return {
    id,
    trackIndex: targetTrackIndex,
    startBar: 0,
    lengthBars,
    type: 'audio',
    audioBufferId: registration.id,
    audioName: recording.name,
    audioWaveform: registration.peaks,
    audioUnavailable: false,
    color: '#ff6e00',
    name: recording.name
  };
};
