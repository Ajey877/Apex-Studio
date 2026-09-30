import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BAR_WIDTH_PX,
  resolveAudioDropStartBar,
  resolveAudioDropStartBarFromClientX,
  resolveInitialAudioDropStartBar,
  resolveTimelineBarFromClientX,
} from './audioDropPlacement';

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

test('drop near Bar 8 places audio near Bar 8', () => {
  const trackLeft = 150;
  const clientX = trackLeft + 8 * DEFAULT_BAR_WIDTH_PX;
  const startBar = resolveAudioDropStartBarFromClientX(
    clientX,
    trackLeft,
    4,
    { totalBars: 32, gridBars: 0.25 },
    DEFAULT_BAR_WIDTH_PX
  );
  assert.equal(startBar, 8);
});

test('drop near Bar 16 places audio near Bar 16', () => {
  const trackLeft = 150;
  const clientX = trackLeft + 16 * DEFAULT_BAR_WIDTH_PX;
  const startBar = resolveAudioDropStartBarFromClientX(
    clientX,
    trackLeft,
    4,
    { totalBars: 32, gridBars: 0.25 },
    DEFAULT_BAR_WIDTH_PX
  );
  assert.equal(startBar, 16);
});

test('drop near/end beyond legal position clamps to latest legal position', () => {
  const trackLeft = 100;
  // Dropping at Bar 30 with totalBars=32 and lengthBars=4 must clamp to 28
  const clientX = trackLeft + 30 * DEFAULT_BAR_WIDTH_PX;
  const startBar = resolveAudioDropStartBarFromClientX(
    clientX,
    trackLeft,
    4,
    { totalBars: 32, gridBars: 0.25 },
    DEFAULT_BAR_WIDTH_PX
  );
  assert.equal(startBar, 28);
});

test('32-bar timeline + 4-bar clip has maximum start = 28', () => {
  const trackLeft = 100;
  // Dropping at Bar 28
  const at28 = resolveAudioDropStartBarFromClientX(
    trackLeft + 28 * DEFAULT_BAR_WIDTH_PX,
    trackLeft,
    4,
    { totalBars: 32 }
  );
  assert.equal(at28, 28);

  // Dropping at Bar 32 (timeline end)
  const at32 = resolveAudioDropStartBarFromClientX(
    trackLeft + 32 * DEFAULT_BAR_WIDTH_PX,
    trackLeft,
    4,
    { totalBars: 32 }
  );
  assert.equal(at32, 28);

  // Dropping far beyond the timeline
  const farPast = resolveAudioDropStartBarFromClientX(
    trackLeft + 50 * DEFAULT_BAR_WIDTH_PX,
    trackLeft,
    4,
    { totalBars: 32 }
  );
  assert.equal(farPast, 28);
  assert.ok(farPast + 4 <= 32);
});

test('grid snapping remains 0.25 bars for drop coordinates', () => {
  const trackLeft = 100;
  // +8.10 bars -> snaps to 8.0
  const snappedDown = resolveAudioDropStartBarFromClientX(
    trackLeft + 8.1 * DEFAULT_BAR_WIDTH_PX,
    trackLeft,
    4,
    { totalBars: 32, gridBars: 0.25 }
  );
  assert.equal(snappedDown, 8.0);

  // +8.20 bars -> snaps to 8.25
  const snappedUp = resolveAudioDropStartBarFromClientX(
    trackLeft + 8.2 * DEFAULT_BAR_WIDTH_PX,
    trackLeft,
    4,
    { totalBars: 32, gridBars: 0.25 }
  );
  assert.equal(snappedUp, 8.25);

  // +8.38 bars -> snaps to 8.5
  const snappedMid = resolveAudioDropStartBarFromClientX(
    trackLeft + 8.38 * DEFAULT_BAR_WIDTH_PX,
    trackLeft,
    4,
    { totalBars: 32, gridBars: 0.25 }
  );
  assert.equal(snappedMid, 8.5);
});

test('negative/outside-left drop clamps correctly to bar 0', () => {
  const trackLeft = 200;
  // 50px to the left of the track lane
  const startBar = resolveAudioDropStartBarFromClientX(
    trackLeft - 50,
    trackLeft,
    4,
    { totalBars: 32, gridBars: 0.25 }
  );
  assert.equal(startBar, 0);
});

test('production PlaylistArranger uses drop location rather than currentBar for audio drop', () => {
  const arrangerSource = readFileSync(
    fileURLToPath(new URL('./PlaylistArranger.tsx', import.meta.url)),
    'utf8'
  );
  // Must capture e.clientX and e.currentTarget.getBoundingClientRect()
  assert.match(arrangerSource, /const\s+dropClientX\s*=\s*e\.clientX;/);
  assert.match(arrangerSource, /const\s+trackRect\s*=\s*e\.currentTarget\.getBoundingClientRect\(\);/);

  // Audio drop must invoke resolveAudioDropStartBarFromClientX
  assert.match(
    arrangerSource,
    /startBar:\s*resolveAudioDropStartBarFromClientX\(\s*dropClientX,\s*trackRect\.left,\s*durationBars,\s*\{\s*totalBars,\s*gridBars:\s*DEFAULT_GRID_BARS\s*\},\s*BAR_WIDTH\s*\)/
  );

  // Automation path remains unchanged: startBar: barIndex
  assert.match(
    arrangerSource,
    /if\s*\(clipTypeToAdd\s*===\s*'automation'\)\s*\{[\s\S]*?startBar:\s*barIndex,\s*lengthBars:\s*4,\s*type:\s*'automation'/
  );
});
