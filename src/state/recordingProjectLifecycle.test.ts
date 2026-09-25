import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRecordingProjectGenerationCurrent,
  nextRecordingProjectGeneration,
} from './recordingProjectLifecycle';

test('recording generation invalidates stale takes at project replacement', () => {
  let generation = 0;
  const recordingGeneration = generation;

  generation = nextRecordingProjectGeneration(generation);

  assert.equal(isRecordingProjectGenerationCurrent(recordingGeneration, generation), false);
});

test('recording generation remains valid without project replacement', () => {
  const generation = 0;
  assert.equal(isRecordingProjectGenerationCurrent(generation, generation), true);
});

test('stale recording cannot mutate the incoming project through the commit gate', () => {
  let generation = 0;
  const recordingGeneration = generation;
  const incomingProject = {
    recordings: [] as string[],
    playlistClips: [] as string[],
  };

  generation = nextRecordingProjectGeneration(generation);

  if (isRecordingProjectGenerationCurrent(recordingGeneration, generation)) {
    incomingProject.recordings.push('stale-recording');
    incomingProject.playlistClips.push('stale-clip');
  }

  assert.deepEqual(incomingProject, { recordings: [], playlistClips: [] });
});

test('finished take becomes stale after replacement before Apply Take', () => {
  let generation = 4;
  const finishedTakeGeneration = generation;

  generation = nextRecordingProjectGeneration(generation);

  assert.equal(
    isRecordingProjectGenerationCurrent(finishedTakeGeneration, generation),
    false
  );
});
