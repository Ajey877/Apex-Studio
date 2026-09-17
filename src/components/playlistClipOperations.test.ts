import assert from 'node:assert/strict';
import test from 'node:test';
import type { Channel, PlaylistClip, PlaylistTrack } from '../types/daw';
import {
  createPlaylistPatternClip,
  deletePlaylistClip,
  duplicatePlaylistClip,
  movePlaylistClip,
  resizePlaylistClipLeft,
  resizePlaylistClipRight,
  resolvePlaylistKeyboardShortcut,
  resolvePlaylistTargetChannel,
  snapBarPosition,
  splitPlaylistClip,
  updatePlaylistAutomationPoint,
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

test('resizePlaylistClipLeft reduces source offset when extending into available source', () => {
  const clip = { ...baseClip, startBar: 8, offsetSteps: 32 };
  const resized = resizePlaylistClipLeft(clip, 6, 0.25, 0.25, { totalBars: 32 });
  assert.equal(resized.startBar, 6);
  assert.equal(resized.lengthBars, 10);
  assert.equal(resized.offsetSteps, 0);
});

test('resizePlaylistClipLeft cannot extend beyond available source offset', () => {
  const clip = { ...baseClip, startBar: 8, offsetSteps: 16 };
  const resized = resizePlaylistClipLeft(clip, 0, 0.25, 0.25, { totalBars: 32 });
  assert.equal(resized.startBar, 7);
  assert.equal(resized.offsetSteps, 0);
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

test('resizePlaylistClipRight respects a minimum length without crossing a tight timeline', () => {
  const clip = { ...baseClip, startBar: 15, lengthBars: 1 };
  const resized = resizePlaylistClipRight(clip, 20, 0.25, 4, { totalBars: 16 });
  assert.equal(resized.lengthBars, 1);
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

test('updatePlaylistAutomationPoint clamps values and preserves other point data', () => {
  const clip: PlaylistClip = {
    ...baseClip,
    id: 'automation-1',
    type: 'automation',
    automationPoints: [
      { x: 0, y: 0.25, tension: 0.4 },
      { x: 0.5, y: 0.75, tension: -0.2 }
    ]
  };

  const updated = updatePlaylistAutomationPoint(clip, 1, 2);
  assert.equal(updated.automationPoints?.[1].y, 1);
  assert.equal(updated.automationPoints?.[1].tension, -0.2);
  assert.equal(updated.automationPoints?.[0].y, 0.25);
  assert.notStrictEqual(updated, clip);
});

test('updatePlaylistAutomationPoint rejects invalid clips and indexes', () => {
  assert.throws(() => updatePlaylistAutomationPoint(baseClip, 0, 0.5), /automation clip/);
  const clip: PlaylistClip = {
    ...baseClip,
    type: 'automation',
    automationPoints: [{ x: 0, y: 0.5, tension: 0 }]
  };
  assert.throws(() => updatePlaylistAutomationPoint(clip, 2, 0.5), /out of range/);
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

test('validatePlaylistClip rejects invalid bounds', () => {
  const result = validatePlaylistClip(baseClip, { totalBars: 0 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.includes('totalBars')));
});

test('resolvePlaylistTargetChannel maps track index to intended channel', () => {
  const channels = [
    { id: 'ch-drums', name: 'Drums', color: '#ff5722' },
    { id: 'ch-bass', name: 'Bass', color: '#00e5ff' },
    { id: 'ch-lead', name: 'Lead', color: '#ffd600' }
  ] as Channel[];

  assert.equal(resolvePlaylistTargetChannel(channels, 0)?.id, 'ch-drums');
  assert.equal(resolvePlaylistTargetChannel(channels, 1)?.id, 'ch-bass');
  assert.equal(resolvePlaylistTargetChannel(channels, 2)?.id, 'ch-lead');
  // Fallback for out-of-bounds track index
  assert.equal(resolvePlaylistTargetChannel(channels, 5)?.id, 'ch-drums');
  // Safe empty handling
  assert.equal(resolvePlaylistTargetChannel([], 0), undefined);
});

test('createPlaylistPatternClip assigns intended channel, colors, and names', () => {
  const channel: Channel = {
    id: 'ch-bass',
    name: 'Rolling Bass',
    color: '#00e5ff',
    instrumentType: 'minisynth',
    mixerTrackId: 2,
    volume: 0.8,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps: Array(16).fill(false),
    notes: [],
    synthParams: {} as any
  };
  const track: PlaylistTrack = {
    id: 2,
    name: 'Bass Lane',
    color: '#00bcd4',
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false
  };

  const clip = createPlaylistPatternClip(1, 4, channel, track, 4, 'clip-custom-id');
  assert.equal(clip.id, 'clip-custom-id');
  assert.equal(clip.trackIndex, 1);
  assert.equal(clip.startBar, 4);
  assert.equal(clip.lengthBars, 4);
  assert.equal(clip.type, 'pattern');
  assert.equal(clip.channelId, 'ch-bass');
  assert.equal(clip.name, 'Bass Lane Block');
  assert.equal(clip.color, '#00bcd4');
});

test('createPlaylistPatternClip falls back cleanly when track or channel metadata is minimal', () => {
  const channel: Channel = {
    id: 'ch-synth',
    name: 'Lead Synth',
    color: '#ff007f',
    instrumentType: 'minisynth',
    mixerTrackId: 1,
    volume: 0.8,
    pan: 0,
    pitch: 0,
    mute: false,
    solo: false,
    steps: [],
    notes: [],
    synthParams: {} as any
  };

  // Without track metadata
  const clipFromChannel = createPlaylistPatternClip(0, 0, channel);
  assert.equal(clipFromChannel.channelId, 'ch-synth');
  assert.equal(clipFromChannel.color, '#ff007f');
  assert.equal(clipFromChannel.name, 'Lead Synth Block');

  // Without channel or track metadata
  const fallbackClip = createPlaylistPatternClip(0, 2);
  assert.equal(fallbackClip.channelId, undefined);
  assert.equal(fallbackClip.color, '#ff6e00');
  assert.equal(fallbackClip.name, 'Track Block');
  assert.equal(fallbackClip.lengthBars, 4);
});

test('resolvePlaylistKeyboardShortcut: Delete and Backspace resolve to delete when hasSelection is true', () => {
  assert.equal(resolvePlaylistKeyboardShortcut({ key: 'Delete' }, true), 'delete');
  assert.equal(resolvePlaylistKeyboardShortcut({ key: 'Backspace' }, true), 'delete');
});

test('resolvePlaylistKeyboardShortcut: Delete and Backspace resolve to none when hasSelection is false', () => {
  assert.equal(resolvePlaylistKeyboardShortcut({ key: 'Delete' }, false), 'none');
  assert.equal(resolvePlaylistKeyboardShortcut({ key: 'Backspace' }, false), 'none');
});

test('resolvePlaylistKeyboardShortcut: Ctrl+D and Cmd+D resolve to duplicate when hasSelection is true', () => {
  assert.equal(resolvePlaylistKeyboardShortcut({ ctrlKey: true, key: 'd' }, true), 'duplicate');
  assert.equal(resolvePlaylistKeyboardShortcut({ ctrlKey: true, key: 'D' }, true), 'duplicate');
  assert.equal(resolvePlaylistKeyboardShortcut({ ctrlKey: true, code: 'KeyD' }, true), 'duplicate');
  assert.equal(resolvePlaylistKeyboardShortcut({ metaKey: true, key: 'd' }, true), 'duplicate');
  assert.equal(resolvePlaylistKeyboardShortcut({ metaKey: true, key: 'D' }, true), 'duplicate');
  assert.equal(resolvePlaylistKeyboardShortcut({ metaKey: true, code: 'KeyD' }, true), 'duplicate');
});

test('resolvePlaylistKeyboardShortcut: Ctrl+D and Cmd+D resolve to none when hasSelection is false', () => {
  assert.equal(resolvePlaylistKeyboardShortcut({ ctrlKey: true, key: 'd' }, false), 'none');
  assert.equal(resolvePlaylistKeyboardShortcut({ metaKey: true, key: 'd' }, false), 'none');
});

test('resolvePlaylistKeyboardShortcut: Shift+Ctrl/Cmd+D and Alt+Ctrl/Cmd+D are rejected (resolve to none)', () => {
  assert.equal(resolvePlaylistKeyboardShortcut({ ctrlKey: true, shiftKey: true, key: 'd' }, true), 'none');
  assert.equal(resolvePlaylistKeyboardShortcut({ metaKey: true, shiftKey: true, key: 'd' }, true), 'none');
  assert.equal(resolvePlaylistKeyboardShortcut({ ctrlKey: true, altKey: true, key: 'd' }, true), 'none');
  assert.equal(resolvePlaylistKeyboardShortcut({ metaKey: true, altKey: true, key: 'd' }, true), 'none');
  assert.equal(resolvePlaylistKeyboardShortcut({ ctrlKey: true, shiftKey: true, altKey: true, key: 'd' }, true), 'none');
});

test('resolvePlaylistKeyboardShortcut: Escape resolves to escape regardless of selection state', () => {
  assert.equal(resolvePlaylistKeyboardShortcut({ key: 'Escape' }, true), 'escape');
  assert.equal(resolvePlaylistKeyboardShortcut({ key: 'Escape' }, false), 'escape');
});

test('resolvePlaylistKeyboardShortcut: unrelated keys resolve to none', () => {
  assert.equal(resolvePlaylistKeyboardShortcut({ key: 'a' }, true), 'none');
  assert.equal(resolvePlaylistKeyboardShortcut({ key: 'Enter' }, true), 'none');
  assert.equal(resolvePlaylistKeyboardShortcut({ key: 'Space' }, true), 'none');
  assert.equal(resolvePlaylistKeyboardShortcut({ ctrlKey: true, key: 'c' }, true), 'none');
  assert.equal(resolvePlaylistKeyboardShortcut({ key: 'd' }, true), 'none'); // plain d without modifier
  assert.equal(resolvePlaylistKeyboardShortcut({}, true), 'none');
});
