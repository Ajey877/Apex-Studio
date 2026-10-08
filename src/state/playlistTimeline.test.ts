/**
 * Phase 54 — Playlist timeline bounds and `totalBars` ownership.
 *
 * Before this phase the playlist timeline length was component-local React
 * state inside `PlaylistArranger` (`useState(32)`). Two consequences were
 * proven on current main:
 *
 *   1. `handleGridCellClick` created clips without passing the component's own
 *      `bounds`, so `assertValidPlaylistClip` received `{}` and skipped its
 *      timeline check. A 4-bar clip clicked onto the last grid cell of a
 *      32-bar timeline was accepted at `startBar: 31` and ended at bar 35.
 *   2. Export length is derived from clip extents
 *      (`getProjectRenderBars`), never from the timeline, so that clip made the
 *      exported WAV 35 bars long while the user was looking at 32.
 *
 * This suite pins the contract that fixes both: the timeline length is owned by
 * `ProjectState`, it is durable across save/load and project replacement, it
 * participates in undo/redo, shortening it revalidates clips instead of
 * stranding them outside the boundary, and the export window can never exceed
 * the timeline the user can see.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_TIMELINE_BARS,
  MAX_TIMELINE_BARS,
  MIN_TIMELINE_BARS,
  clampClipToTimeline,
  clampClipsToTimeline,
  clampStartBarToTimeline,
  getProjectTimelineBars,
  normalizeTimelineBars,
  revalidateProjectTimeline,
  setTimelineBarsInProjectState,
} from './playlistTimeline';
import { createDefaultProjectState, normalizeProjectState } from './projectState';
import { serializeProjectState } from './projectPersistence';
import { createHistory } from './projectHistory';
import { createPlaylistPatternClip, validatePlaylistClip } from '../components/playlistClipOperations';
import { getProjectRenderBars } from '../utils/exportUtils';
import type { PlaylistClip, ProjectState } from '../types/daw';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const clip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: 'clip-1',
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'pattern',
  color: '#ff6e00',
  name: 'Track Block',
  ...overrides,
});

// ---------------------------------------------------------------------------
// 1 + 2. Grid-click creation is clamped, and cannot leave the timeline.
// ---------------------------------------------------------------------------

test('Phase 54: the grid-click producer passes real timeline bounds', () => {
  const arranger = read('../components/PlaylistArranger.tsx');

  // The automation and pattern branches must both resolve a clamped start bar
  // against the timeline contract before publishing a clip.
  assert.match(
    arranger,
    /clampStartBarToTimeline\(/,
    'the grid-click path must clamp the requested bar against the timeline',
  );
  assert.match(
    arranger,
    /createPlaylistPatternClip\(/,
    'the pattern branch must still go through createPlaylistPatternClip',
  );
  assert.match(
    arranger,
    /bounds/,
    'the grid-click path must use the component bounds derived from totalBars',
  );

  // The regression that caused this phase: a bare `bounds`-less create call.
  assert.ok(
    !/createPlaylistPatternClip\(\s*trackIndex,\s*barIndex,\s*targetChannel,\s*tracks\[trackIndex\]\s*\)/.test(
      arranger,
    ),
    'createPlaylistPatternClip must not be called with the raw, unclamped barIndex',
  );
});

test('Phase 54: a clip created on the final grid cell ends inside the timeline', () => {
  const totalBars = 32;
  const bounds = { totalBars, maxTracks: 8 };

  // Every bar of a 32-bar timeline, including the last clickable one.
  for (const barIndex of [0, 20, 27, 28, 30, 31]) {
    const startBar = clampStartBarToTimeline(barIndex, 4, bounds);
    const created = createPlaylistPatternClip(0, startBar, undefined, undefined, 4, undefined, bounds);

    assert.ok(
      created.startBar + created.lengthBars <= totalBars,
      `click at bar ${barIndex} produced a clip ending at ${created.startBar + created.lengthBars}`,
    );
    assert.equal(
      validatePlaylistClip(created, bounds).valid,
      true,
      `click at bar ${barIndex} produced an invalid clip`,
    );
  }
});

test('Phase 54: clamping only affects creation that would overflow', () => {
  const bounds = { totalBars: 32, maxTracks: 8 };

  // A bar with room left of the boundary is placed exactly where it was clicked.
  assert.equal(clampStartBarToTimeline(4, 4, bounds), 4);
  assert.equal(clampStartBarToTimeline(28, 4, bounds), 28);

  // Only the overflowing clicks are pulled back to the latest legal start.
  assert.equal(clampStartBarToTimeline(30, 4, bounds), 28);
  assert.equal(clampStartBarToTimeline(31, 4, bounds), 28);
  assert.equal(clampStartBarToTimeline(120, 4, bounds), 28);
});

// ---------------------------------------------------------------------------
// 3. Ownership defaults and normalization.
// ---------------------------------------------------------------------------

test('Phase 54: a new project owns a valid default timeline length', () => {
  const project = createDefaultProjectState();
  assert.equal(project.totalBars, DEFAULT_TIMELINE_BARS);
  assert.equal(getProjectTimelineBars(project), DEFAULT_TIMELINE_BARS);
});

test('Phase 54: an absent or corrupt timeline length falls back to the default', () => {
  assert.equal(normalizeTimelineBars(undefined), DEFAULT_TIMELINE_BARS);
  assert.equal(normalizeTimelineBars(null), DEFAULT_TIMELINE_BARS);
  assert.equal(normalizeTimelineBars(Number.NaN), DEFAULT_TIMELINE_BARS);
  assert.equal(normalizeTimelineBars('not-a-number'), DEFAULT_TIMELINE_BARS);
  // A non-positive length must never be read as "shrink to the minimum": that
  // would silently strand existing clips. It is treated as absent.
  assert.equal(normalizeTimelineBars(0), DEFAULT_TIMELINE_BARS);
  assert.equal(normalizeTimelineBars(-16), DEFAULT_TIMELINE_BARS);
});

test('Phase 54: an out-of-range timeline length is clamped into the supported range', () => {
  assert.equal(normalizeTimelineBars(1), MIN_TIMELINE_BARS);
  assert.equal(normalizeTimelineBars(4096), MAX_TIMELINE_BARS);
  assert.equal(normalizeTimelineBars(37), 37);
});

// ---------------------------------------------------------------------------
// 3 (cont). Save / load round-trip.
// ---------------------------------------------------------------------------

test('Phase 54: save/load preserves totalBars and revalidates clips against it', () => {
  const project: ProjectState = {
    ...createDefaultProjectState(),
    totalBars: 48,
    playlistClips: [clip({ id: 'a', startBar: 40, lengthBars: 8 })],
  };

  const serialized = serializeProjectState(project);
  const restored = JSON.parse(serialized).state as ProjectState;

  assert.equal(restored.totalBars, 48, 'totalBars must survive the persistence round-trip');
  assert.equal(getProjectTimelineBars(restored), 48);
  for (const restoredClip of restored.playlistClips) {
    assert.ok(
      restoredClip.startBar + restoredClip.lengthBars <= 48,
      'a loaded project must be revalidated against its declared timeline length',
    );
  }
});

test('Phase 54: a legacy project with an overhanging clip is revalidated on load', () => {
  // The exact shape the pre-Phase-54 grid-click bug produced.
  const legacy = {
    ...createDefaultProjectState(),
    totalBars: 32,
    playlistClips: [clip({ id: 'legacy', startBar: 31, lengthBars: 4 })],
  };

  const normalized = normalizeProjectState(legacy);
  assert.equal(normalized.totalBars, 32);
  assert.equal(normalized.playlistClips.length, 1, 'the clip must be preserved, not deleted');
  assert.ok(normalized.playlistClips[0].startBar + normalized.playlistClips[0].lengthBars <= 32);
  assert.equal(normalized.playlistClips[0].startBar, 28, 'it is pulled back to the latest legal start');
});

test('Phase 54: a project without a stored timeline length loads at the default', () => {
  const { totalBars: _dropped, ...withoutTimeline } = createDefaultProjectState();
  const normalized = normalizeProjectState(withoutTimeline as ProjectState);

  assert.equal(normalized.totalBars, DEFAULT_TIMELINE_BARS);
  assert.equal(getProjectTimelineBars(normalized), DEFAULT_TIMELINE_BARS);
});

// ---------------------------------------------------------------------------
// 4. Project replacement.
// ---------------------------------------------------------------------------

test('Phase 54: project replacement carries the incoming timeline length', () => {
  // Replacement works on whole sanitized documents, so a replaced project's
  // timeline length must travel with it rather than reverting to the default.
  const incoming: ProjectState = {
    ...createDefaultProjectState(),
    meta: { ...createDefaultProjectState().meta, name: 'Incoming' },
    totalBars: 16,
  };

  const replaced = normalizeProjectState(JSON.parse(JSON.stringify(incoming)) as ProjectState);
  assert.equal(replaced.totalBars, 16);
  assert.equal(getProjectTimelineBars(replaced), 16);
});

test('Phase 54: a fresh New Session does not inherit the previous timeline length', () => {
  const previous: ProjectState = { ...createDefaultProjectState(), totalBars: 64 };
  assert.equal(previous.totalBars, 64);

  // New Session builds its own document rather than mutating the old one.
  const fresh = createDefaultProjectState();
  assert.equal(fresh.totalBars, DEFAULT_TIMELINE_BARS);
});

// ---------------------------------------------------------------------------
// 5. Undo / redo.
// ---------------------------------------------------------------------------

test('Phase 54: a timeline length change is a single undoable history entry', () => {
  const initial = createDefaultProjectState();
  let history = createHistory(initial);

  const widened = setTimelineBarsInProjectState(history.present, 48);
  history = history.commit(widened, 'Change timeline length');
  assert.equal(history.present.totalBars, 48);

  history = history.undo();
  assert.equal(history.present.totalBars, DEFAULT_TIMELINE_BARS, 'undo restores the previous length');

  history = history.redo();
  assert.equal(history.present.totalBars, 48, 'redo re-applies the new length');
});

test('Phase 54: shrinking the timeline and undoing restores clip positions', () => {
  const initial: ProjectState = {
    ...createDefaultProjectState(),
    totalBars: 32,
    playlistClips: [clip({ id: 'keep', startBar: 20, lengthBars: 4 })],
  };
  let history = createHistory(initial);

  const shrunk = setTimelineBarsInProjectState(history.present, 8);
  history = history.commit(shrunk, 'Change timeline length');
  assert.equal(history.present.totalBars, 8);
  for (const shrunkClip of history.present.playlistClips) {
    assert.ok(shrunkClip.startBar + shrunkClip.lengthBars <= 8);
  }

  history = history.undo();
  assert.equal(history.present.totalBars, 32);
  assert.equal(history.present.playlistClips[0].startBar, 20, 'undo restores the original position');
  assert.equal(history.present.playlistClips[0].lengthBars, 4);
});

// ---------------------------------------------------------------------------
// 6. Shrink / re-expand behaviour.
// ---------------------------------------------------------------------------

test('Phase 54: shrinking the timeline cannot leave clips beyond the boundary', () => {
  const project: ProjectState = {
    ...createDefaultProjectState(),
    totalBars: 32,
    playlistClips: [
      clip({ id: 'inside', startBar: 4, lengthBars: 4 }),
      clip({ id: 'straddling', startBar: 28, lengthBars: 4 }),
      clip({ id: 'beyond', startBar: 40, lengthBars: 4 }),
    ],
  };

  const shrunk = setTimelineBarsInProjectState(project, 16);
  assert.equal(shrunk.totalBars, 16);
  assert.equal(shrunk.playlistClips.length, 3, 'no clip is silently dropped');
  for (const clamped of shrunk.playlistClips) {
    assert.ok(
      clamped.startBar + clamped.lengthBars <= 16,
      `clip ${clamped.id} ends at ${clamped.startBar + clamped.lengthBars} on a 16-bar timeline`,
    );
    assert.ok(clamped.startBar >= 0, `clip ${clamped.id} has a negative startBar`);
  }
  // A clip that already fitted is untouched.
  assert.equal(shrunk.playlistClips[0].startBar, 4);
});

test('Phase 54: re-expanding the timeline does not corrupt clip positions', () => {
  const project: ProjectState = {
    ...createDefaultProjectState(),
    totalBars: 32,
    playlistClips: [clip({ id: 'a', startBar: 28, lengthBars: 4 })],
  };

  const shrunk = setTimelineBarsInProjectState(project, 8);
  const reExpanded = setTimelineBarsInProjectState(shrunk, 32);

  assert.equal(reExpanded.totalBars, 32);
  for (const expandedClip of reExpanded.playlistClips) {
    assert.ok(Number.isFinite(expandedClip.startBar));
    assert.ok(expandedClip.startBar >= 0);
    assert.ok(expandedClip.lengthBars > 0);
    assert.ok(expandedClip.startBar + expandedClip.lengthBars <= 32);
  }
  // Re-expanding is stable: clamping again changes nothing.
  assert.deepEqual(clampClipsToTimeline(reExpanded.playlistClips, 32), reExpanded.playlistClips);
});

test('Phase 54: a clip longer than the whole timeline is shortened to fit', () => {
  const clamped = clampClipToTimeline(clip({ startBar: 4, lengthBars: 40 }), 8);
  assert.equal(clamped.lengthBars, 8);
  assert.equal(clamped.startBar, 0);
  assert.ok(clamped.startBar + clamped.lengthBars <= 8);
});

test('Phase 54: clamping leaves an already-valid clip identical', () => {
  const original = clip({ startBar: 4, lengthBars: 4 });
  assert.equal(clampClipsToTimeline([original], 32)[0], original, 'unchanged clips keep their identity');
  assert.equal(clampClipToTimeline(original, 32), original);
});

test('Phase 54: setting the same timeline length is a no-op state transition', () => {
  const project = createDefaultProjectState();
  assert.equal(setTimelineBarsInProjectState(project, DEFAULT_TIMELINE_BARS), project);
  assert.equal(revalidateProjectTimeline(project), project);
});

// ---------------------------------------------------------------------------
// 7. Export honesty.
// ---------------------------------------------------------------------------

test('Phase 54: song export length never exceeds the authoritative timeline', () => {
  const totalBars = 32;
  // The exact overhanging clip the grid-click bug produced.
  const clips = [clip({ id: 'overflow', startBar: 31, lengthBars: 4 })];

  const renderBars = getProjectRenderBars(clips, 'song', undefined, totalBars);
  assert.ok(renderBars <= totalBars, `export asked for ${renderBars} bars on a ${totalBars}-bar timeline`);
  assert.equal(renderBars, totalBars);
});

test('Phase 54: displayed timeline and exported render agree for a full arrangement', () => {
  const totalBars = 32;
  const clips = [
    clip({ id: 'a', startBar: 0, lengthBars: 4 }),
    clip({ id: 'b', startBar: 28, lengthBars: 4 }),
  ];

  const displayed = totalBars;
  const exported = getProjectRenderBars(clips, 'song', undefined, totalBars);
  assert.equal(displayed, exported);
});

test('Phase 54: export still ends at the last clip when the arrangement is short', () => {
  const totalBars = 32;
  const clips = [clip({ id: 'a', startBar: 0, lengthBars: 4 }), clip({ id: 'b', startBar: 4, lengthBars: 4 })];

  // Documented behaviour: "Render through the last playlist clip".
  assert.equal(getProjectRenderBars(clips, 'song', undefined, totalBars), 8);
  assert.equal(getProjectRenderBars(clips, 'song'), 8, 'omitting totalBars keeps the legacy callers working');
});

test('Phase 54: the export modal feeds the authoritative timeline into render length', () => {
  const modal = read('../components/ExportModal.tsx');
  assert.match(
    modal,
    /getProjectRenderBars\(clips,\s*scope,\s*patternLengthSteps,\s*totalBars,\s*meta\.timeSignature\)/,
    'the render window must be resolved against the project timeline (and the project meter)',
  );

  // App resolves the timeline once, from ProjectState, and hands the same value
  // to both the arranger and the export modal.
  const app = read('../App.tsx');
  assert.match(
    app,
    /const projectTimelineBars = getProjectTimelineBars\(projectState\)/,
    'App must resolve the timeline from ProjectState',
  );
  // (Bounded span: the props contain `=>` arrow handlers, so a `[^>]` run stops early.)
  assert.match(
    app,
    /<ExportModal[\s\S]{0,2000}?totalBars=\{projectTimelineBars\}/,
    'the export modal must receive it',
  );
  assert.match(
    app,
    /<PlaylistArranger[\s\S]{0,2000}?totalBars=\{projectTimelineBars\}/,
    'the arranger must receive it',
  );
});
