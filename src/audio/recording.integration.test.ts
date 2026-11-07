import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commitRecordingForCurrentProject, nextRecordingProjectGeneration } from '../state/recordingProjectLifecycle';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('recording to playlist integration', () => {
  it('uses the validated recording pipeline after AudioEngine registration', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

    assert.match(
      source,
      // Phase 1L adds the punch clip factory and its buffer trim to the same
      // validated pipeline import — a punch take never bypasses it.
      /import \{ createPunchRecordingPlaylistClip, createRecordingPlaylistClip, getRecordingAudioBufferId, trimAudioBufferToSeconds, validateRecordingTargetTrack, type PunchClipPlacement \} from '\.\/audio\/recordingPipeline';/
    );
    assert.match(
      source,
      /const targetTrack = validateRecordingTargetTrack\(projectState\.playlistTracks, targetTrackIndex\)[\s\S]*const targetTrackId = targetTrack\.id[\s\S]*const audioBufferId = getRecordingAudioBufferId\(recording\.id\)[\s\S]*await audioEngine\.loadAudioFile\(recording\.audioBlob, audioBufferId\)/
    );
    assert.match(
      source,
      // Phase 1L names the registration because a punch take re-registers a
      // trimmed buffer; it is still built from the buffer AudioEngine loaded.
      /let registration = \{ id: audioBufferId, buffer: loaded\.buffer, peaks: loaded\.peaks, duration: loaded\.duration \};[\s\S]*createRecordingPlaylistClip\(\s*persistedRecording,\s*registration,\s*currentState\.playlistTracks,\s*currentTargetTrackIndex,\s*currentState\.meta\.bpm/
    );
    assert.match(source, /recordings: \[\.\.\.currentState\.recordings, persistedRecording\]/);
    // Phase 1M: recordings are now routed through the take-group system
    assert.match(source, /findMatchingTakeGroup\(/);
    assert.match(source, /addTakeToProjectClips\(/);
    assert.match(source, /playlistClips: updatedClips/);

    // Phase 1L: the only re-registration a punch take may perform is the
    // trimmed buffer, and it must be persisted through AudioEngine before the
    // clip that references it is built — so nothing past punch-out can play,
    // export or survive a reload.
    assert.match(
      source,
      /trimAudioBufferToSeconds\(loaded\.buffer, punchPlacement\.trimSeconds[\s\S]*audioEngine\.setSampleBuffer\(audioBufferId, trimmed\);\s*await waitForSampleBufferPersistence\(audioEngine, audioBufferId\);\s*registration = \{ id: audioBufferId, buffer: trimmed, peaks: loaded\.peaks, duration: trimmed\.duration \};/
    );
  });

  it('delegates BPM-aware clip sizing to the recording pipeline contract', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

    assert.match(
      source,
      /createRecordingPlaylistClip\([\s\S]*currentState\.playlistTracks,\s*currentTargetTrackIndex,\s*currentState\.meta\.bpm/
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

  it('a project replacement during async audio registration cannot publish the stale take', async () => {
    let currentGeneration = 12;
    const recordingGeneration = currentGeneration;
    const incomingProject = { recordings: [] as string[], playlistClips: [] as string[] };
    const persistenceGate = deferred<void>();
    const replacementPersistence = deferred<void>();
    const replacementPersistenceRejected = assert.rejects(replacementPersistence.promise, /replacement persistence failed/);
    const pendingPublication = (async () => {
      await persistenceGate.promise;
      return commitRecordingForCurrentProject(recordingGeneration, currentGeneration, () => {
        incomingProject.recordings.push('stale-recording');
        incomingProject.playlistClips.push('stale-recording-clip');
      });
    })();

    currentGeneration = nextRecordingProjectGeneration(currentGeneration);
    replacementPersistence.reject(new Error('replacement persistence failed'));
    await replacementPersistenceRejected;
    persistenceGate.resolve();
    assert.equal(await pendingPublication, false);
    assert.deepEqual(incomingProject, { recordings: [], playlistClips: [] });
    let currentProjectCommits = 0;
    assert.equal(commitRecordingForCurrentProject(currentGeneration, currentGeneration, () => { currentProjectCommits++; }), true);
    assert.equal(currentProjectCommits, 1, 'the same gate permits a take from the still-current project');

    const appSource = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    assert.match(
      appSource,
      /const published = commitRecordingForCurrentProject\([\s\S]*?updatePlaylistProjectState\(nextState\);[\s\S]*?commitPlaylistHistory\(nextState,[\s\S]*?sessionBlobUrlRegistry\.transfer\(recording\.audioUrl \?\? ''\);[\s\S]*?if \(!published\)/,
      'the real App commit, history entry, and URL transfer stay behind the tested generation gate',
    );
  });
});
