import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('recording to playlist integration', () => {
  it('uses the validated recording pipeline after AudioEngine registration', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

    assert.match(
      source,
      /import \{ createRecordingPlaylistClip, getRecordingAudioBufferId, validateRecordingTargetTrack \} from '\.\/audio\/recordingPipeline';/
    );
    assert.match(source, /validateRecordingTargetTrack\(projectState\.playlistTracks, targetTrackIndex\)/);
    assert.match(source, /const audioBufferId = getRecordingAudioBufferId\(recording\.id\)/);
    assert.match(source, /await audioEngine\.loadAudioFile\(recording\.audioBlob, audioBufferId\)/);
    assert.match(source, /createRecordingPlaylistClip\(/);
    assert.match(source, /id: audioBufferId/);
    assert.match(source, /buffer: loaded\.buffer/);
    assert.match(source, /peaks: loaded\.peaks/);
    assert.match(source, /duration: loaded\.duration/);
    assert.match(source, /playlistClips: \[\.\.\.prev\.playlistClips, newClip\]/);
  });

  it('delegates BPM-aware clip sizing to the recording pipeline contract', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

    assert.match(source, /createRecordingPlaylistClip\(/);
    assert.match(source, /projectState\.meta\.bpm/);
    assert.doesNotMatch(source, /const secondsPerBar = 240 \/ Math\.max\(20, projectState\.meta\.bpm\)/);
    assert.doesNotMatch(source, /Math\.ceil\(recording\.durationSeconds \/ secondsPerBar\)/);
  });

  it('cancels an active recording when the recorder modal closes', () => {
    const source = readFileSync(new URL('../components/AudioRecorderModal.tsx', import.meta.url), 'utf8');
    assert.match(source, /engineRef\.current\?\.cancel\(\)/);
  });
});
