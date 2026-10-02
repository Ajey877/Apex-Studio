import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BAR_WIDTH_PX,
  DEFAULT_TRACK_HEIGHT_PX,
  clientToPlaylistContentCoordinates,
  contentXToTimelineBar,
  resolveAudioDropStartBar,
  resolveAudioDropStartBarFromClientX,
  resolveInitialAudioDropStartBar,
  resolvePlaylistClipMove,
  resolvePlaylistDropPlacement,
  resolveTimelineBarFromClientX,
} from './audioDropPlacement';

// --- Baseline tests ---

test('imports at the end of the arrangement inside the last valid start', () => {
  assert.equal(resolveInitialAudioDropStartBar(32, 4, { totalBars: 32 }), 28);
});

test('preserves a valid playhead-derived start position', () => {
  assert.equal(resolveInitialAudioDropStartBar(9, 4, { totalBars: 32 }), 8);
});

test('never creates a negative initial position', () => {
  assert.equal(resolveInitialAudioDropStartBar(1, 4, { totalBars: 32 }), 0);
});

test('handles clips longer than the arrangement at bar zero', () => {
  assert.equal(resolveInitialAudioDropStartBar(32, 40, { totalBars: 32 }), 0);
});

test('snaps a non-grid-aligned legal start down without exceeding the timeline', () => {
  const start = resolveInitialAudioDropStartBar(32, 3.9, { totalBars: 32, gridBars: 0.25 });
  assert.equal(start, 28);
  assert.ok(start + 3.9 <= 32);
});

test('resolveTimelineBarFromClientX converts drop coordinates to timeline bar position', () => {
  const trackLeft = 200;
  const barWidth = 96;
  assert.equal(resolveTimelineBarFromClientX(trackLeft, trackLeft, barWidth), 0);
  assert.equal(resolveTimelineBarFromClientX(trackLeft + 8 * barWidth, trackLeft, barWidth), 8);
  assert.equal(resolveTimelineBarFromClientX(trackLeft + 16 * barWidth, trackLeft, barWidth), 16);
});

// --- Required DAW Placement Model Tests A through J ---

test('A. No horizontal scroll: converts clientX directly to timeline bar', () => {
  const viewportLeft = 176;
  const scrollLeft = 0;
  const clientX = viewportLeft + 8 * DEFAULT_BAR_WIDTH_PX; // Drop at Bar 8
  const placement = resolvePlaylistDropPlacement(
    clientX,
    0,
    4,
    { viewportLeft, scrollLeft, barWidth: DEFAULT_BAR_WIDTH_PX },
    { totalBars: 32, gridBars: 0.25 }
  );

  assert.equal(placement.contentX, 8 * DEFAULT_BAR_WIDTH_PX);
  assert.equal(placement.rawBar, 8);
  assert.equal(placement.startBar, 8);
});

test('B. Horizontal scroll: correctly accounts for scrollLeft and preserves logical position', () => {
  const viewportLeft = 176;
  // Playlist horizontally scrolled by 10 bars (960px)
  const scrollLeft = 10 * DEFAULT_BAR_WIDTH_PX;
  // User drops at the 8th bar of the visible window
  const clientX = viewportLeft + 8 * DEFAULT_BAR_WIDTH_PX;
  const placement = resolvePlaylistDropPlacement(
    clientX,
    0,
    4,
    { viewportLeft, scrollLeft, barWidth: DEFAULT_BAR_WIDTH_PX },
    { totalBars: 32, gridBars: 0.25 }
  );

  // Logical position: 8 visible bars + 10 scrolled bars = Bar 18
  assert.equal(placement.contentX, 18 * DEFAULT_BAR_WIDTH_PX);
  assert.equal(placement.rawBar, 18);
  assert.equal(placement.startBar, 18);

  // Equivalent using trackLeft (scrolled element bounding rect)
  const trackLeft = viewportLeft - scrollLeft;
  const trackPlacement = resolvePlaylistDropPlacement(
    clientX,
    0,
    4,
    { trackLeft, barWidth: DEFAULT_BAR_WIDTH_PX },
    { totalBars: 32, gridBars: 0.25 }
  );
  assert.equal(trackPlacement.startBar, 18);
});

test('C. Different viewport offsets: correctly offsets client coordinates with varied layouts', () => {
  // Wide sidebar (320px) + 4 bars scroll
  const widePlacement = resolvePlaylistDropPlacement(
    320 + 6 * DEFAULT_BAR_WIDTH_PX,
    0,
    4,
    { viewportLeft: 320, scrollLeft: 4 * DEFAULT_BAR_WIDTH_PX, barWidth: DEFAULT_BAR_WIDTH_PX },
    { totalBars: 32, gridBars: 0.25 }
  );
  assert.equal(widePlacement.startBar, 10);

  // Compact sidebar (144px) + 0 scroll
  const compactPlacement = resolvePlaylistDropPlacement(
    144 + 5 * DEFAULT_BAR_WIDTH_PX,
    0,
    4,
    { viewportLeft: 144, scrollLeft: 0, barWidth: DEFAULT_BAR_WIDTH_PX },
    { totalBars: 32, gridBars: 0.25 }
  );
  assert.equal(compactPlacement.startBar, 5);
});

test('D. Grid snapping: snaps fractional drop coordinates to 0.25-bar increments', () => {
  const ctx = { viewportLeft: 100, scrollLeft: 0, barWidth: DEFAULT_BAR_WIDTH_PX };
  const bounds = { totalBars: 32, gridBars: 0.25 };

  // 8.10 bars -> snaps down to 8.00
  const p1 = resolvePlaylistDropPlacement(100 + 8.10 * DEFAULT_BAR_WIDTH_PX, 0, 4, ctx, bounds);
  assert.equal(p1.startBar, 8.0);

  // 8.20 bars -> snaps up to 8.25
  const p2 = resolvePlaylistDropPlacement(100 + 8.20 * DEFAULT_BAR_WIDTH_PX, 0, 4, ctx, bounds);
  assert.equal(p2.startBar, 8.25);

  // 8.38 bars -> snaps to 8.50
  const p3 = resolvePlaylistDropPlacement(100 + 8.38 * DEFAULT_BAR_WIDTH_PX, 0, 4, ctx, bounds);
  assert.equal(p3.startBar, 8.5);

  // 8.70 bars -> snaps to 8.75
  const p4 = resolvePlaylistDropPlacement(100 + 8.70 * DEFAULT_BAR_WIDTH_PX, 0, 4, ctx, bounds);
  assert.equal(p4.startBar, 8.75);
});

test('E. Drop at beginning: clamps negative and zero drops safely to Bar 0', () => {
  const ctx = { viewportLeft: 200, scrollLeft: 0, barWidth: DEFAULT_BAR_WIDTH_PX };
  const bounds = { totalBars: 32, gridBars: 0.25 };

  // Drop 50px outside-left of the arrangement
  const pNegative = resolvePlaylistDropPlacement(150, 0, 4, ctx, bounds);
  assert.equal(pNegative.startBar, 0);

  // Drop exactly at Bar 0
  const pZero = resolvePlaylistDropPlacement(200, 0, 4, ctx, bounds);
  assert.equal(pZero.startBar, 0);
});

test('F. Drop in middle: places clip accurately at Bar 16', () => {
  const clientX = 150 + 16 * DEFAULT_BAR_WIDTH_PX;
  const placement = resolvePlaylistDropPlacement(
    clientX,
    0,
    4,
    { viewportLeft: 150, scrollLeft: 0, barWidth: DEFAULT_BAR_WIDTH_PX },
    { totalBars: 32, gridBars: 0.25 }
  );
  assert.equal(placement.startBar, 16);
});

test('G. Drop near arrangement end: clamps 4-bar clip on 32-bar timeline to latest legal start Bar 28', () => {
  const ctx = { viewportLeft: 100, scrollLeft: 0, barWidth: DEFAULT_BAR_WIDTH_PX };
  const bounds = { totalBars: 32, gridBars: 0.25 };

  // Drop at Bar 28 (exact legal max)
  const at28 = resolvePlaylistDropPlacement(100 + 28 * DEFAULT_BAR_WIDTH_PX, 0, 4, ctx, bounds);
  assert.equal(at28.startBar, 28);

  // Drop at Bar 30
  const at30 = resolvePlaylistDropPlacement(100 + 30 * DEFAULT_BAR_WIDTH_PX, 0, 4, ctx, bounds);
  assert.equal(at30.startBar, 28);

  // Drop at Bar 31
  const at31 = resolvePlaylistDropPlacement(100 + 31 * DEFAULT_BAR_WIDTH_PX, 0, 4, ctx, bounds);
  assert.equal(at31.startBar, 28);

  // Drop at Bar 32 (timeline edge)
  const at32 = resolvePlaylistDropPlacement(100 + 32 * DEFAULT_BAR_WIDTH_PX, 0, 4, ctx, bounds);
  assert.equal(at32.startBar, 28);

  // Drop far past the timeline
  const farPast = resolvePlaylistDropPlacement(100 + 60 * DEFAULT_BAR_WIDTH_PX, 0, 4, ctx, bounds);
  assert.equal(farPast.startBar, 28);
  assert.ok(farPast.startBar + 4 <= 32);
});

test('H. Clip longer than arrangement: clamps to Bar 0 without overflow', () => {
  const ctx = { viewportLeft: 100, scrollLeft: 0, barWidth: DEFAULT_BAR_WIDTH_PX };
  const bounds = { totalBars: 32, gridBars: 0.25 };

  // 40-bar clip on 32-bar timeline
  const pLong = resolvePlaylistDropPlacement(100 + 10 * DEFAULT_BAR_WIDTH_PX, 0, 40, ctx, bounds);
  assert.equal(pLong.startBar, 0);
});

test('I. Existing clip movement: shares coordinate helper to move clips with snapping and clamping', () => {
  const clip = { startBar: 4, trackIndex: 1, lengthBars: 4 };
  const originX = 100;
  const originY = 100;

  // Move right by 3 bars (+288px), down by 1 track (+64px)
  const movedNormal = resolvePlaylistClipMove(
    clip,
    originX,
    originY,
    originX + 3 * DEFAULT_BAR_WIDTH_PX,
    originY + DEFAULT_TRACK_HEIGHT_PX,
    { barWidth: DEFAULT_BAR_WIDTH_PX, trackHeight: DEFAULT_TRACK_HEIGHT_PX },
    { totalBars: 32, maxTracks: 8, gridBars: 0.25 }
  );
  assert.equal(movedNormal.startBar, 7);
  assert.equal(movedNormal.trackIndex, 2);

  // Drag far past arrangement end
  const movedPastEnd = resolvePlaylistClipMove(
    clip,
    originX,
    originY,
    originX + 30 * DEFAULT_BAR_WIDTH_PX,
    originY,
    { barWidth: DEFAULT_BAR_WIDTH_PX, trackHeight: DEFAULT_TRACK_HEIGHT_PX },
    { totalBars: 32, maxTracks: 8, gridBars: 0.25 }
  );
  assert.equal(movedPastEnd.startBar, 28);

  // Drag far to the left
  const movedLeft = resolvePlaylistClipMove(
    clip,
    originX,
    originY,
    originX - 10 * DEFAULT_BAR_WIDTH_PX,
    originY,
    { barWidth: DEFAULT_BAR_WIDTH_PX, trackHeight: DEFAULT_TRACK_HEIGHT_PX },
    { totalBars: 32, maxTracks: 8, gridBars: 0.25 }
  );
  assert.equal(movedLeft.startBar, 0);
});

test('J. Imported audio placement: full drop event simulation with horizontal scroll and target track', () => {
  const viewportLeft = 176;
  const scrollLeft = 10 * DEFAULT_BAR_WIDTH_PX; // 960px
  const trackTop = 120;
  const clientX = viewportLeft + 8 * DEFAULT_BAR_WIDTH_PX; // Bar 18 logical
  const clientY = trackTop + 2 * DEFAULT_TRACK_HEIGHT_PX; // Track 2

  const result = resolvePlaylistDropPlacement(
    clientX,
    clientY,
    4,
    {
      viewportLeft,
      scrollLeft,
      viewportTop: trackTop,
      scrollTop: 0,
      barWidth: DEFAULT_BAR_WIDTH_PX,
      trackHeight: DEFAULT_TRACK_HEIGHT_PX,
    },
    { totalBars: 32, gridBars: 0.25, maxTracks: 4 }
  );

  assert.equal(result.startBar, 18);
  assert.equal(result.trackIndex, 2);
  assert.equal(result.contentX, 18 * DEFAULT_BAR_WIDTH_PX);
  assert.ok(result.startBar + 4 <= 32);
});

test('production PlaylistArranger uses unified coordinate placement for audio drop and clip move', () => {
  const arrangerSource = readFileSync(
    fileURLToPath(new URL('./PlaylistArranger.tsx', import.meta.url)),
    'utf8'
  );

  // Must reference timelineScrollContainerRef
  assert.match(arrangerSource, /timelineScrollContainerRef\s*=\s*useRef<HTMLDivElement\s*\|\s*null>\(null\);/);
  assert.match(arrangerSource, /ref=\{timelineScrollContainerRef\}/);

  // Audio drop must invoke resolvePlaylistDropPlacement
  assert.match(arrangerSource, /const\s+dropPlacement\s*=\s*resolvePlaylistDropPlacement\(/);
  assert.match(arrangerSource, /startBar:\s*dropPlacement\.startBar,/);

  // Clip move must invoke resolvePlaylistClipMove
  assert.match(arrangerSource, /const\s+movedCoords\s*=\s*resolvePlaylistClipMove\(/);
  assert.match(arrangerSource, /movePlaylistClip\(\s*clip,\s*movedCoords\.startBar,\s*movedCoords\.trackIndex/);

  /**
   * Phase 54 — the automation branch used to be asserted as `startBar: barIndex`,
   * i.e. the unclamped click bar. That was the bug, not the contract: a 4-bar
   * automation clip clicked onto the last cell of a 32-bar timeline was created
   * ending at bar 35. Both grid-click producers now resolve their start bar
   * through the shared timeline clamp before publishing.
   */
  assert.match(
    arrangerSource,
    /if\s*\(clipTypeToAdd\s*===\s*'automation'\)\s*\{[\s\S]*?startBar:\s*clampStartBarToTimeline\(/,
    'the automation branch must clamp its start bar against the timeline'
  );
  assert.doesNotMatch(
    arrangerSource,
    /startBar:\s*barIndex,\s*lengthBars:\s*4,\s*type:\s*'automation'/,
    'no grid-click producer may publish an unclamped click bar'
  );

  /**
   * Phase 48 — this suite previously stopped at the automation branch, which
   * left the sibling `clipTypeToAdd === 'audio'` producer unasserted. That
   * producer built a `type: 'audio'` clip with a decorative `audioWaveform` and
   * no `audioBufferId`: silent in playback, invisible to the missing-audio
   * surfaces, and a hard blocker for WAV/stem export. Assert here that it stays
   * gone, and that the three real audio insertion paths still supply an id.
   */
  assert.doesNotMatch(arrangerSource, /clipTypeToAdd\s*===\s*'audio'/);
  assert.doesNotMatch(arrangerSource, /audio-clip-\$\{Date\.now\(\)\}/);
  assert.doesNotMatch(arrangerSource, /Audio Stem \/ Vocal/);

  // Legitimate audio clip creation keeps its buffer registration.
  assert.match(arrangerSource, /audioBufferId:\s*bufId,/);
  assert.match(arrangerSource, /bounceChannelToAudioClip\(/);
});
