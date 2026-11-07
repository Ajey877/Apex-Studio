import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleRecordingPcm, type RecordingPcmBlock } from './recordingPcm';

const block = (frameStart: number, samples: number[]): RecordingPcmBlock => ({
  frameStart,
  frameCount: samples.length,
  channelCount: 1,
  samples: Float32Array.from(samples),
});

const flatten = (chunks: readonly Float32Array[]): number[] => chunks.flatMap(chunk => [...chunk]);

test('PCM assembly includes the start frame and excludes the exclusive stop frame', () => {
  const assembled = assembleRecordingPcm({
    blocks: [block(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])],
    startFrame: 2,
    stopFrame: 7,
  });
  assert.equal(assembled.frameCount, 5);
  assert.deepEqual(flatten(assembled.chunks), [2, 3, 4, 5, 6]);
});

test('missing non-paused input frames reject instead of padding or silently shifting audio', () => {
  assert.throws(
    () => assembleRecordingPcm({
      blocks: [block(10, [10, 11, 12]), block(14, [14, 15])],
      startFrame: 10,
      stopFrame: 16,
    }),
    /lost 1 input frames/,
  );
});

test('pause intervals are omitted from ordinary takes and can be silence-filled without gaps', () => {
  const blocks = [block(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])];
  const pauseIntervals = [{ startFrame: 3, endFrame: 6 }];
  const ordinary = assembleRecordingPcm({ blocks, startFrame: 0, stopFrame: 10, pauseIntervals });
  assert.equal(ordinary.frameCount, 7);
  assert.deepEqual(flatten(ordinary.chunks), [0, 1, 2, 6, 7, 8, 9]);

  const preserved = assembleRecordingPcm({
    blocks,
    startFrame: 0,
    stopFrame: 10,
    pauseIntervals,
    preservePausedTimeline: true,
  });
  assert.equal(preserved.frameCount, 10);
  assert.deepEqual(flatten(preserved.chunks), [0, 1, 2, 0, 0, 0, 6, 7, 8, 9]);
});

test('a gap inside an explicitly paused interval is not mistaken for missing active audio', () => {
  const assembled = assembleRecordingPcm({
    blocks: [block(0, [0, 1, 2]), block(6, [6, 7, 8, 9])],
    startFrame: 0,
    stopFrame: 10,
    pauseIntervals: [{ startFrame: 3, endFrame: 6 }],
  });
  assert.equal(assembled.frameCount, 7);
  assert.deepEqual(flatten(assembled.chunks), [0, 1, 2, 6, 7, 8, 9]);
});
