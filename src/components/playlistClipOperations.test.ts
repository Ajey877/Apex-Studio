import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlaylistClip } from '../types/daw';
import {
  deletePlaylistClip,
  duplicatePlaylistClip,
  movePlaylistClip,
  resizePlaylistClipLeft,
  resizePlaylistClipRight,
  snapBarPosition,
  splitPlaylistClip,
  validatePlaylistClip
} from './playlistClipOperations';

const baseClip: PlaylistClip = {
  id: 'clip-1',
  trackIndex: 0,
  startBar: 4,
  lengthBars: 8,
  type: 'audio',
  color: '#00ff88',
  name: 'Vocal',
  audioBufferId: 'buffer-1',
  offsetSteps: 0,
  fadeInBars: 0.5,
  fadeOutBars: 0.5
};

test('snapBarPosition snaps to the requested grid', () => {
  assert.equal(snapBarPosition(4.37, 0.25), 4.25);
  assert.equal(snapBarPosition(4.13, 0.25), 4.25);
  assert.equal(snapBarPosition(-2, 0.25), 0);
});

test('movePlaylistClip snaps and changes playlist lane', () => {
  const moved = movePlaylistClip(baseClip, 10.13, 2, 0.25, { totalBars: 32, maxTracks: 8 });
  assert.equal(moved.startBar, 10.25);
  assert.equal(moved.trackIndex, 2);
  assert.equal(moved.lengthBars, 8);
});

test('movePlaylistClip clamps to the timeline end', () => {
  const moved = movePlaylistClip(baseClip, 30, 0, 0.25, { totalBars: 32, maxTracks: 8 });
  assert.equal(moved.startBar, 24);
  assert.equal(moved.startBar + moved.lengthBars, 32);
});

test('resizePlaylistClipLeft preserves end and advances source offset', () => {
  const resized = resizePlaylistClipLeft(baseClip, 6.13, 0.25, 0.25, { totalBars: 32 });
  assert.equal(resized.startBar, 6.25);
  assert.equal(resized.lengthBars, 5.75);
  assert.equal(resized.offsetSteps, 36);
});

test('resizePlaylistClipRight preserves start and changes duration', () => {
  const resized = resizePlaylistClipRight(baseClip, 14.13, 0.25, 0.25, { totalBars: 32 });
  assert.equal(resized.startBar, 4);
  assert.equal(resized.lengthBars, 10.25);
});

test('resizePlaylistClipRight cannot exceed timeline bounds', () => {
  const resized = resizePlaylistClipRight(baseClip, 40, 0.25, 0.25, { totalBars: 16 });
  assert.equal(resized.lengthBars, 12);
  assert.equal(resized.startBar + resized.lengthBars, 16);
});

test('splitPlaylistClip creates contiguous clips and advances right offset', () => {
  const [left, right] = splitPlaylistClip(baseClip, 8.13, 0.25, { totalBars: 32 });
  assert.equal(left.startBar, 4);
  assert.equal(left.lengthBars, 4.25);
  assert.equal(right.startBar, 8.25);
  assert.equal(right.lengthBars, 3.75);
  assert.equal(right.offsetSteps, 68);
  assert.notEqual(left.id, right.id);
});

test('splitPlaylistClip rejects boundary splits', () => {
  assert.throws(() => splitPlaylistClip(baseClip, 4, 0.25), /inside the clip/);
  assert.throws(() => splitPlaylistClip(baseClip, 12, 0.25), /inside the clip/);
});

test('duplicatePlaylistClip creates an independent clip identity', () => {
  const duplicate = duplicatePlaylistClip(baseClip, 'clip-2', 16, 3, 0.25, { totalBars: 32, maxTracks: 8 });
  assert.equal(duplicate.id, 'clip-2');
  assert.equal(duplicate.startBar, 16);
  assert.equal(duplicate.trackIndex, 3);
  assert.equal(duplicate.lengthBars, 8);
});

test('deletePlaylistClip removes only the requested clip', () => {
  const second = { ...baseClip, id: 'clip-2', startBar: 16 };
  const remaining = deletePlaylistClip([baseClip, second], 'clip-1');
  assert.deepEqual(remaining.map(clip => clip.id), ['clip-2']);
});

test('validatePlaylistClip catches invalid timeline values', () => {
  const result = validatePlaylistClip({ ...baseClip, startBar: -1 }, { totalBars: 32 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('startBar')));
});
