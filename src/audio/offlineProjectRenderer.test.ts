import test from 'node:test';
import assert from 'node:assert/strict';
import { getOfflineRenderPlan } from './offlineProjectRenderer';
import type { PlaylistClip } from '../types/daw';

const clip = (overrides: Partial<PlaylistClip>): PlaylistClip => ({
  id: 'clip-1',
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'audio',
  audioBufferId: 'audio-1',
  color: '#fff',
  name: 'Audio',
  ...overrides,
});

test('offline render plan uses real clip positions and clips at render boundary', () => {
  const plan = getOfflineRenderPlan([
    clip({ id: 'first', startBar: 2, lengthBars: 4 }),
    clip({ id: 'late', startBar: 8, lengthBars: 4 }),
    clip({ id: 'muted', startBar: 1, lengthBars: 2, mute: true }),
  ], 120, 10);

  assert.equal(plan.length, 2);
  assert.equal(plan[0].startSeconds, 4);
  assert.equal(plan[0].durationSeconds, 8);
  assert.equal(plan[1].startSeconds, 16);
  assert.equal(plan[1].durationSeconds, 4);
});

test('offline render plan ignores zero-length clips and invalid negative duration', () => {
  const plan = getOfflineRenderPlan([
    clip({ id: 'zero', lengthBars: 0 }),
    clip({ id: 'negative', lengthBars: -2 }),
  ], 120, 8);
  assert.deepEqual(plan, []);
});
