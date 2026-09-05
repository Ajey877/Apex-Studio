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
    assert.match(
      source,
      /const targetTrack = validateRecordingTargetTrack\(projectState\.playlistTracks, targetTrackIndex\)[\s\S]*const targetTrackId = targetTrack\.id[\s\S]*const audioBufferId = getRecordingAudioBufferId\(recording\.id\)[\s\S]*await audioEngine\.loadAudioFile\(recording\.audioBlob, audioBufferId\)/
    );
    assert.match(
      source,
      /createRecordingPlaylistClip\(\s*persistedRecording,\s*\{ id: audioBufferId, buffer: loaded\.buffer, peaks: loaded\.peaks, duration: loaded\.duration \},\s*prev\.playlistTracks,\s*prev\.playlistTracks\.findIndex\(track => track\.id === targetTrackId\),\s*prev\.meta\.bpm/
    );
    assert.match(source, /recordings: \[\.\.\.prev\.recordings, persistedRecording\]/);
    assert.match(source, /playlistClips: \[\.\.\.prev\.playlistClips, createRecordingPlaylistClip\(/);
  });

  it('delegates BPM-aware clip sizing to the recording pipeline contract', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

    assert.match(
      source,
      /createRecordingPlaylistClip\([\s\S]*prev\.playlistTracks\.findIndex\(track => track\.id === targetTrackId\),\s*prev\.meta\.bpm/
    );
    assert.doesNotMatch(source, /const secondsPerBar = 240 \/ Math\.max\(20, projectState\.meta\.bpm\)/);
    assert.doesNotMatch(source, /Math\.ceil\(recording\.durationSeconds \/ secondsPerBar\)/);
  });

  it('gates editing and autosave until startup hydration completes', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

    assert.match(source, /const \[isProjectHydrating, setIsProjectHydrating\] = useState\(true\)/);
    assert.match(source, /if \(isProjectHydrating\)/);
    assert.match(source, /projectPersistenceReadyRef\.current = true/);
    assert.match(source, /if \(!projectPersistenceReadyRef\.current\) return/);
  });

  it('cancels an active recording when the recorder modal closes', () => {
    const source = readFileSync(new URL('../components/AudioRecorderModal.tsx', import.meta.url), 'utf8');
    assert.match(source, /engineRef\.current\?\.cancel\(\)/);
  });
});
