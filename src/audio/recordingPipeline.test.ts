import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecordingPlaylistClip,
  getRecordingAudioBufferId,
  getRecordingLengthBars,
  validateRecordingTargetTrack,
} from './recordingPipeline';
import type { AudioRecording, PlaylistTrack } from '../types/daw';

const tracks: PlaylistTrack[] = [
  { id: 1, name: 'Track 1', color: '#fff', volume: 1, pan: 0, mute: false, solo: false },
  { id: 2, name: 'Track 2', color: '#fff', volume: 1, pan: 0, mute: false, solo: false },
];

const recording = (overrides: Partial<AudioRecording> = {}): AudioRecording => ({
  id: 'rec-test-1',
  name: 'Recorded Take',
  timestamp: 1,
  durationSeconds: 3.1,
  audioBlob: new Blob(['audio-data'], { type: 'audio/webm' }),
  audioUrl: 'blob:test',
  waveform: [0.1, 0.7, 0.3],
  ...overrides,
});

const buffer = { duration: 3.1 } as AudioBuffer;

test('recording ID is deterministic and stable', () => {
  assert.equal(getRecordingAudioBufferId('rec-test-1'), 'recording-rec-test-1');
  assert.equal(getRecordingAudioBufferId('rec-test-1'), getRecordingAudioBufferId('rec-test-1'));
});

test('recording length is derived from BPM, not a fixed bar duration', () => {
  assert.equal(getRecordingLengthBars(3.1, 120), 2);
  assert.equal(getRecordingLengthBars(3.1, 60), 1);
});

test('invalid or stale playlist destinations are rejected', () => {
  assert.throws(() => validateRecordingTargetTrack(tracks, -1), /Invalid playlist track/);
  assert.throws(() => validateRecordingTargetTrack(tracks, 2), /no longer exists/);
  assert.throws(() => validateRecordingTargetTrack(tracks, 1.5), /Invalid playlist track/);
});

test('recording becomes an audio PlaylistClip with the registered buffer and real waveform', () => {
  const take = recording();
  const clip = createRecordingPlaylistClip(
    take,
    { id: getRecordingAudioBufferId(take.id), buffer, peaks: take.waveform, duration: buffer.duration },
    tracks,
    1,
    120,
    'rec-clip-test'
  );

  assert.equal(clip.type, 'audio');
  assert.equal(clip.audioBufferId, 'recording-rec-test-1');
  assert.equal(clip.trackIndex, 1);
  assert.equal(clip.lengthBars, 2);
  assert.deepEqual(clip.audioWaveform, [0.1, 0.7, 0.3]);
});

test('clip creation rejects mismatched buffer registration', () => {
  const take = recording();
  assert.throws(() => createRecordingPlaylistClip(
    take,
    { id: 'recording-other', buffer, peaks: take.waveform, duration: buffer.duration },
    tracks,
    0,
    120
  ), /registration does not match/);
});
