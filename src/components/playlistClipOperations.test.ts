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
  resolveClipClickBar,
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

// ---------------------------------------------------------------------------
// Drag interaction math — determinism tests
// These verify the origin-delta calculation that updateInteraction uses.
// The formula is: requestedStart = clip.startBar + (clientX - originX) / BAR_WIDTH
// which must produce correct snapped startBar for any mid-drag clientX.
// ---------------------------------------------------------------------------

const BAR_WIDTH = 96; // must match PlaylistArranger constant
const BOUNDS = { totalBars: 32, maxTracks: 8 };
const GRID = 0.25;

test('drag math: right by exactly one bar (96px) from bar 4 lands at bar 5', () => {
  const clip: PlaylistClip = { ...baseClip, startBar: 4, trackIndex: 0 };
  const originX = 500;
  const clientX = originX + BAR_WIDTH; // +96px = +1 bar
  const requestedStart = clip.startBar + (clientX - originX) / BAR_WIDTH;
  const moved = movePlaylistClip(clip, requestedStart, 0, GRID, BOUNDS);
  assert.equal(moved.startBar, 5);
});

test('drag math: left by half a bar (48px) from bar 4 lands at bar 3.5 (on 0.25 grid)', () => {
  const clip: PlaylistClip = { ...baseClip, startBar: 4, trackIndex: 0 };
  const originX = 500;
  const clientX = originX - 48; // -48px = -0.5 bar → requestedStart = 3.5, already on 0.25 grid
  const requestedStart = clip.startBar + (clientX - originX) / BAR_WIDTH;
  const moved = movePlaylistClip(clip, requestedStart, 0, GRID, BOUNDS);
  assert.equal(moved.startBar, 3.5);
});

test('drag math: multiple consecutive move events from the same origin produce correct monotonic positions', () => {
  // Simulate three pointer-move events during a single drag.
  // Each event uses the SAME frozen clip.startBar and originX (origin-delta, not incremental).
  const clip: PlaylistClip = { ...baseClip, startBar: 2, trackIndex: 0 };
  const originX = 300;

  const deltas = [48, 96, 192]; // 0.5 bar, 1 bar, 2 bars
  const expected = [2.5, 3, 4];

  for (let i = 0; i < deltas.length; i++) {
    const clientX = originX + deltas[i];
    const requestedStart = clip.startBar + (clientX - originX) / BAR_WIDTH;
    const moved = movePlaylistClip(clip, requestedStart, clip.trackIndex, GRID, BOUNDS);
    assert.equal(moved.startBar, expected[i], `delta ${deltas[i]}px should produce startBar ${expected[i]}`);
  }
});

test('drag math: left drag from non-zero startBar does not go negative; clamps to 0', () => {
  const clip: PlaylistClip = { ...baseClip, startBar: 0.5, trackIndex: 0 };
  const originX = 200;
  const clientX = originX - 200; // -200px = -2.08 bars → would go negative
  const requestedStart = clip.startBar + (clientX - originX) / BAR_WIDTH;
  const moved = movePlaylistClip(clip, requestedStart, 0, GRID, BOUNDS);
  assert.equal(moved.startBar, 0); // clamped to 0
});

test('drag math: vertical track change is independent of horizontal position', () => {
  const TRACK_HEIGHT = 64;
  const clip: PlaylistClip = { ...baseClip, startBar: 4, trackIndex: 1 };
  const originX = 500;
  const originY = 100;
  const clientX = originX + BAR_WIDTH; // +1 bar horizontally
  const clientY = originY + TRACK_HEIGHT; // +1 track vertically
  const requestedStart = clip.startBar + (clientX - originX) / BAR_WIDTH;
  const targetTrack = clip.trackIndex + Math.round((clientY - originY) / TRACK_HEIGHT);
  const moved = movePlaylistClip(clip, requestedStart, targetTrack, GRID, BOUNDS);
  assert.equal(moved.startBar, 5, 'horizontal move correct');
  assert.equal(moved.trackIndex, 2, 'vertical move correct');
});

// ---------------------------------------------------------------------------
// Slice tool click math — regression tests
// Clips render above the grid cells, so with the Slice tool active the click
// lands on the clip element and never reaches handleGridCellClick. The clip's
// onClick derives the bar from the click position inside the clip:
//   clickedBar = clip.startBar + (clientX - clipRect.left) / BAR_WIDTH
// and hands it to the existing splitClip() path (DEFAULT_GRID_BARS snapping).
// ---------------------------------------------------------------------------

const automationClip: PlaylistClip = {
  id: 'auto-1',
  trackIndex: 2,
  startBar: 4,
  lengthBars: 8,
  type: 'automation',
  color: '#00e5ff',
  name: 'Auto: Cutoff',
  automationTarget: { type: 'channel_filter_cutoff', targetId: 'ch-1', label: 'Cutoff' },
  automationPoints: [
    { x: 0, y: 0.2, tension: 0.3 },
    { x: 0.5, y: 0.85, tension: -0.2 },
    { x: 1, y: 0.3, tension: 0 }
  ]
};

const patternClip: PlaylistClip = {
  id: 'pat-1',
  trackIndex: 0,
  startBar: 4,
  lengthBars: 8,
  type: 'pattern',
  channelId: 'ch-1',
  color: '#ff6e00',
  name: 'Pattern Block',
  offsetSteps: 8
};

test('slice math: click offset inside the clip maps to the bar under the pointer', () => {
  const clipLeft = 1234.5; // viewport x of the clip's left edge (arbitrary scroll / layout)
  assert.equal(resolveClipClickBar(patternClip, clipLeft, clipLeft, BAR_WIDTH), 4);
  assert.equal(resolveClipClickBar(patternClip, clipLeft + BAR_WIDTH, clipLeft, BAR_WIDTH), 5);
  assert.equal(resolveClipClickBar(patternClip, clipLeft + 4 * BAR_WIDTH + 24, clipLeft, BAR_WIDTH), 8.25);
  // Only the offset from the clip edge matters, not where the clip sits on screen.
  assert.equal(
    resolveClipClickBar(patternClip, 60, 12, BAR_WIDTH),
    resolveClipClickBar(patternClip, 1048, 1000, BAR_WIDTH)
  );
  // A clip further down the timeline shifts the result by its start.
  assert.equal(resolveClipClickBar({ ...patternClip, startBar: 16 }, 300 + 48, 300, BAR_WIDTH), 16.5);
});

test('slice math: pattern, audio and automation clips split at the clicked bar with grid snapping', () => {
  const clipLeft = 500;
  const clickX = clipLeft + 4 * BAR_WIDTH + 13; // bar 8.135 -> snaps to 8.25

  const [patternLeft, patternRight] = splitPlaylistClip(patternClip, resolveClipClickBar(patternClip, clickX, clipLeft, BAR_WIDTH), GRID, BOUNDS);
  assert.equal(patternLeft.startBar, 4);
  assert.equal(patternLeft.lengthBars, 4.25);
  assert.equal(patternRight.startBar, 8.25);
  assert.equal(patternRight.lengthBars, 3.75);
  assert.equal(patternRight.offsetSteps, 8 + 4.25 * 16); // pattern / audio semantics untouched

  const [audioLeft, audioRight] = splitPlaylistClip(baseClip, resolveClipClickBar(baseClip, clickX, clipLeft, BAR_WIDTH), GRID, BOUNDS);
  assert.equal(audioLeft.lengthBars, 4.25);
  assert.equal(audioRight.startBar, 8.25);
  assert.equal(audioRight.offsetSteps, 68);
  assert.equal(audioLeft.audioBufferId, 'buffer-1');
  assert.equal(audioRight.audioBufferId, 'buffer-1');

  // Automation clips go through the Phase 6.2 envelope remap: both halves
  // meet at the seam value and offsetSteps is left alone.
  const [autoLeft, autoRight] = splitPlaylistClip(automationClip, resolveClipClickBar(automationClip, clickX, clipLeft, BAR_WIDTH), GRID, BOUNDS);
  assert.equal(autoLeft.lengthBars, 4.25);
  assert.equal(autoRight.startBar, 8.25);
  assert.equal(autoLeft.offsetSteps, undefined);
  assert.equal(autoRight.offsetSteps, undefined);
  const seamLeft = autoLeft.automationPoints![autoLeft.automationPoints!.length - 1];
  const seamRight = autoRight.automationPoints![0];
  assert.equal(seamLeft.x, 1);
  assert.equal(seamRight.x, 0);
  assert.equal(seamLeft.y, seamRight.y);
  assert.equal(autoLeft.automationPoints!.length, 3); // 0, 0.5 (now at bar 8), seam
  assert.equal(autoRight.automationPoints!.length, 2); // seam, 1
  assert.equal(autoLeft.automationTarget?.targetId, 'ch-1');
  assert.equal(autoRight.automationTarget?.targetId, 'ch-1');
});

test('slice math: clicks that snap onto a clip edge are rejected instead of producing a degenerate clip', () => {
  const clipLeft = 500;
  const clipRight = clipLeft + patternClip.lengthBars * BAR_WIDTH - 4; // rendered width is lengthBars * 96 - 4
  // Left edge and the first few pixels snap back to the clip start.
  assert.throws(() => splitPlaylistClip(patternClip, resolveClipClickBar(patternClip, clipLeft, clipLeft, BAR_WIDTH), GRID, BOUNDS), /inside the clip/);
  assert.throws(() => splitPlaylistClip(patternClip, resolveClipClickBar(patternClip, clipLeft + 11, clipLeft, BAR_WIDTH), GRID, BOUNDS), /inside the clip/);
  // Right edge snaps to the clip end.
  assert.throws(() => splitPlaylistClip(patternClip, resolveClipClickBar(patternClip, clipRight, clipLeft, BAR_WIDTH), GRID, BOUNDS), /inside the clip/);
  // Just past the snap threshold produces the smallest grid-sized piece.
  const [edgeLeft, edgeRight] = splitPlaylistClip(patternClip, resolveClipClickBar(patternClip, clipLeft + 13, clipLeft, BAR_WIDTH), GRID, BOUNDS);
  assert.equal(edgeLeft.lengthBars, 0.25);
  assert.equal(edgeRight.startBar, 4.25);
  // Non-finite geometry surfaces as an invalid split (the UI shows its status message).
  assert.throws(() => splitPlaylistClip(patternClip, resolveClipClickBar(patternClip, Number.NaN, clipLeft, BAR_WIDTH), GRID, BOUNDS), /finite/);
});
