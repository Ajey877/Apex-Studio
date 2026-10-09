/**
 * Phase 1G — Timeline Capacity Expansion (state, persistence and clip geometry).
 *
 * The playlist timeline used to be capped at 64 bars by `MAX_TIMELINE_BARS`.
 * This phase replaces that artificial ceiling with a finite 512-bar capacity
 * while keeping `MAX_TIMELINE_BARS` the single authority for the limit.
 *
 * Invariants pinned here:
 *
 *   - 512 is the one capacity authority; nothing else redeclares it.
 *   - Lengths in [MIN, 512] are legal; anything above 512 clamps to 512.
 *   - Clips at bar 64 and beyond are legal up to the authoritative bound.
 *   - Save/load and history preserve long arrangements (bar 100 and the last
 *     bar of a 512-bar timeline) instead of clamping them to the old cap.
 *   - Shrinking relocates clips inside the boundary; it never deletes them.
 *   - Legacy and malformed stored state keeps its pre-existing behaviour.
 *
 * Several tests here are deliberate regression anchors: they pass before and
 * after the change because the behaviour they protect must not move.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
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
import type { PlaylistClip, ProjectState } from '../types/daw';

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

const withBars = (totalBars: number, playlistClips: PlaylistClip[] = []): ProjectState => ({
  ...createDefaultProjectState(),
  totalBars,
  playlistClips,
});

/** The real save -> stored JSON -> load path used by persistence. */
const roundTrip = (state: ProjectState): ProjectState =>
  normalizeProjectState(JSON.parse(serializeProjectState(state)).state);

const SRC_ROOT = fileURLToPath(new URL('..', import.meta.url));

const walkSource = (dir: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkSource(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
};

// ---------------------------------------------------------------------------
// 1. The capacity authority.
// ---------------------------------------------------------------------------

test('Phase 1G: the timeline capacity authority is 512 bars', () => {
  assert.equal(MAX_TIMELINE_BARS, 512);
});

test('Phase 1G: the default and minimum timeline lengths are unchanged', () => {
  assert.equal(DEFAULT_TIMELINE_BARS, 32);
  assert.equal(MIN_TIMELINE_BARS, 8);
});

test('Phase 1G: MAX_TIMELINE_BARS is declared exactly once across production source', () => {
  const declarations = walkSource(SRC_ROOT)
    .filter(file => /export const MAX_TIMELINE_BARS\s*=/.test(readFileSync(file, 'utf8')))
    .map(file => path.relative(SRC_ROOT, file).replace(/\\/g, '/'));

  assert.deepEqual(
    declarations,
    ['state/playlistTimeline.ts'],
    'the timeline capacity must have exactly one authority',
  );
});

test('Phase 1G: no production timeline code hard-codes a 64-bar clamp', () => {
  // A literal 64 next to a timeline-length identifier would be a second, hidden
  // capacity authority that silently ignores MAX_TIMELINE_BARS. Matched in both
  // directions: `Math.min(64, totalBars + 8)` is as much a clamp as the reverse.
  const suspicious = /(totalBars|timelineBars|TimelineBars|TIMELINE_BARS)[^\n]{0,60}\b64\b|\b64\b[^\n]{0,60}(totalBars|timelineBars|TimelineBars|TIMELINE_BARS)/;
  const offenders = walkSource(SRC_ROOT)
    .filter(file => suspicious.test(readFileSync(file, 'utf8')))
    .map(file => path.relative(SRC_ROOT, file).replace(/\\/g, '/'));

  assert.deepEqual(offenders, [], 'no timeline-length code may clamp to a literal 64');
});

test('Phase 1G: the arranger and App consume the shared capacity, not a local copy', () => {
  const arranger = readFileSync(path.join(SRC_ROOT, 'components/PlaylistArranger.tsx'), 'utf8');
  assert.match(arranger, /MAX_TIMELINE_BARS/, 'the +8 control must be bounded by the shared authority');
  assert.doesNotMatch(arranger, /MAX_TIMELINE_BARS\s*=/, 'the arranger must not redeclare the cap');
});

// ---------------------------------------------------------------------------
// 2. Accepted and clamped lengths.
// ---------------------------------------------------------------------------

test('Phase 1G: lengths beyond the old 64-bar cap are accepted', () => {
  assert.equal(normalizeTimelineBars(65), 65);
  assert.equal(normalizeTimelineBars(96), 96);
  assert.equal(normalizeTimelineBars(128), 128);
  assert.equal(normalizeTimelineBars(256), 256);
  assert.equal(normalizeTimelineBars(512), 512);
});

test('Phase 1G: the maximum timeline length is 512 and anything above clamps to it', () => {
  assert.equal(normalizeTimelineBars(513), 512);
  assert.equal(normalizeTimelineBars(1024), 512);
  assert.equal(normalizeTimelineBars(4096), 512);
  assert.equal(normalizeTimelineBars(Number.MAX_SAFE_INTEGER), 512);
});

test('Phase 1G: fractional lengths still round before the bounds are applied', () => {
  assert.equal(normalizeTimelineBars(128.4), 128);
  assert.equal(normalizeTimelineBars(128.6), 129);
  assert.equal(normalizeTimelineBars(512.4), 512);
  assert.equal(normalizeTimelineBars(600.2), 512);
});

test('Phase 1G: the timeline-length action accepts 128 and 512 and clamps 513', () => {
  const base = createDefaultProjectState();
  assert.equal(setTimelineBarsInProjectState(base, 128).totalBars, 128);
  assert.equal(setTimelineBarsInProjectState(base, 512).totalBars, 512);
  assert.equal(setTimelineBarsInProjectState(base, 513).totalBars, 512);
});

test('Phase 1G: the +8 arranger step from 504 reaches exactly 512 and stops there', () => {
  // Mirrors `Math.min(MAX_TIMELINE_BARS, totalBars + 8)` in the arranger.
  assert.equal(Math.min(MAX_TIMELINE_BARS, 504 + 8), 512);
  assert.equal(Math.min(MAX_TIMELINE_BARS, 512 + 8), 512);
  assert.equal(normalizeTimelineBars(Math.min(MAX_TIMELINE_BARS, 512 + 8)), 512);
});

// ---------------------------------------------------------------------------
// 3. Save / load of long projects.
// ---------------------------------------------------------------------------

test('Phase 1G: a 65-bar project survives save and load', () => {
  assert.equal(roundTrip(withBars(65)).totalBars, 65);
});

test('Phase 1G: a 128-bar project survives save and load with its length intact', () => {
  const restored = roundTrip(withBars(128));
  assert.equal(restored.totalBars, 128);
  assert.equal(getProjectTimelineBars(restored), 128);
});

test('Phase 1G: a 512-bar project survives save and load with its length intact', () => {
  const restored = roundTrip(withBars(512));
  assert.equal(restored.totalBars, 512);
  assert.equal(getProjectTimelineBars(restored), 512);
});

test('Phase 1G: a clip at bar 100 survives save and load on a 128-bar timeline', () => {
  const project = withBars(128, [clip({ id: 'bar100', startBar: 100, lengthBars: 4 })]);
  const restored = roundTrip(project);

  assert.equal(restored.playlistClips.length, 1, 'the clip must not be deleted');
  assert.equal(restored.playlistClips[0].id, 'bar100');
  assert.equal(restored.playlistClips[0].startBar, 100, 'bar 100 must not be clamped to the old cap');
  assert.equal(restored.playlistClips[0].lengthBars, 4);
});

test('Phase 1G: a clip ending on the last bar of a 512-bar timeline survives save and load', () => {
  const project = withBars(512, [clip({ id: 'last', startBar: 508, lengthBars: 4 })]);
  const restored = roundTrip(project);

  assert.equal(restored.playlistClips.length, 1);
  assert.equal(restored.playlistClips[0].startBar, 508);
  assert.equal(restored.playlistClips[0].startBar + restored.playlistClips[0].lengthBars, 512);
});

test('Phase 1G: clips across the whole 512-bar span round-trip exactly', () => {
  const starts = [0, 63, 64, 100, 255, 300, 400, 508];
  const project = withBars(
    512,
    starts.map((startBar, index) => clip({ id: `c${index}`, startBar, lengthBars: 4 })),
  );
  const restored = roundTrip(project);

  assert.deepEqual(
    restored.playlistClips.map(c => [c.id, c.startBar, c.lengthBars]),
    starts.map((startBar, index) => [`c${index}`, startBar, 4]),
  );
});

test('Phase 1G: an over-capacity stored length is clamped to 512 on load, not to 64', () => {
  const restored = normalizeProjectState({ ...createDefaultProjectState(), totalBars: 9999 } as unknown as ProjectState);
  assert.equal(restored.totalBars, 512);
});

// ---------------------------------------------------------------------------
// 4. Clip geometry against the authoritative bounds.
// ---------------------------------------------------------------------------

test('Phase 1G: clips beyond bar 64 are legal on a 512-bar timeline', () => {
  const bounds = { totalBars: 512, maxTracks: 8 };
  for (const startBar of [64, 100, 300, 508]) {
    const result = validatePlaylistClip(clip({ startBar, lengthBars: 4 }), bounds);
    assert.equal(result.valid, true, `a clip at bar ${startBar} must be legal on a 512-bar timeline`);
  }
});

test('Phase 1G: a clip past the 512-bar boundary is still rejected', () => {
  const result = validatePlaylistClip(clip({ startBar: 510, lengthBars: 4 }), { totalBars: 512, maxTracks: 8 });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('clip exceeds playlist timeline bounds'));
});

test('Phase 1G: the grid-click producer creates a legal clip at bar 300 on a 512-bar timeline', () => {
  const bounds = { totalBars: 512, maxTracks: 8 };
  const startBar = clampStartBarToTimeline(300, 4, bounds);
  const created = createPlaylistPatternClip(0, startBar, undefined, undefined, 4, undefined, bounds);

  assert.equal(created.startBar, 300);
  assert.equal(validatePlaylistClip(created, bounds).valid, true);
});

test('Phase 1G: the grid-click producer rejects a clip overflowing the 512-bar boundary', () => {
  const bounds = { totalBars: 512, maxTracks: 8 };
  assert.throws(() => createPlaylistPatternClip(0, 600, undefined, undefined, 4, undefined, bounds));
});

test('Phase 1G: a click past the end of a 512-bar timeline clamps to the last legal start', () => {
  const bounds = { totalBars: 512, maxTracks: 8 };
  // Bar 510 would end at 514: pulled back to the last legal start, 508 (ends at 512).
  assert.equal(clampStartBarToTimeline(510, 4, bounds), 508);
  assert.equal(clampStartBarToTimeline(4096, 4, bounds), 508);
  // Bar 500 ends at 504, which is inside the boundary, so it is not moved.
  assert.equal(clampStartBarToTimeline(500, 4, bounds), 500, 'in-range clicks are not moved');
  assert.equal(clampStartBarToTimeline(200, 4, bounds), 200, 'in-range clicks are not moved');
});

test('Phase 1G: a clip near the end of a 512-bar timeline is left untouched by clamping', () => {
  const original = clip({ startBar: 500, lengthBars: 12 });
  assert.equal(clampClipToTimeline(original, 512), original);
  assert.equal(clampClipsToTimeline([original], 512)[0], original);
});

test('Phase 1G: a clip longer than the 512-bar timeline is shortened to fit, not discarded', () => {
  const clamped = clampClipToTimeline(clip({ startBar: 0, lengthBars: 600 }), 512);
  assert.equal(clamped.lengthBars, 512);
  assert.equal(clamped.startBar, 0);
});

// ---------------------------------------------------------------------------
// 5. Shrink behaviour at the new capacity.
// ---------------------------------------------------------------------------

test('Phase 1G: shrinking a 512-bar timeline to 128 relocates clips instead of deleting them', () => {
  const project = withBars(512, [
    clip({ id: 'far', startBar: 400, lengthBars: 4 }),
    clip({ id: 'inside', startBar: 60, lengthBars: 4 }),
  ]);

  const shrunk = setTimelineBarsInProjectState(project, 128);
  assert.equal(shrunk.totalBars, 128);
  assert.equal(shrunk.playlistClips.length, 2, 'no clip may be silently dropped');

  const far = shrunk.playlistClips.find(c => c.id === 'far');
  assert.ok(far, 'the relocated clip must still exist');
  assert.equal(far.startBar, 124, 'the clip is pulled back to the latest legal start on 128 bars');
  assert.equal(far.lengthBars, 4);

  const inside = shrunk.playlistClips.find(c => c.id === 'inside');
  assert.equal(inside?.startBar, 60, 'a clip that already fits keeps its exact position');
});

test('Phase 1G: shrinking from 512 to the old 64-bar size still relocates clips inside the boundary', () => {
  const project = withBars(512, [clip({ id: 'far', startBar: 400, lengthBars: 4 })]);
  const shrunk = setTimelineBarsInProjectState(project, 64);

  assert.equal(shrunk.totalBars, 64);
  assert.equal(shrunk.playlistClips.length, 1);
  assert.equal(shrunk.playlistClips[0].startBar, 60);
});

test('Phase 1G: undoing a 512 -> 128 shrink restores the long-bar clip position', () => {
  const initial = withBars(512, [clip({ id: 'far', startBar: 400, lengthBars: 4 })]);
  let history = createHistory(initial);

  history = history.commit(setTimelineBarsInProjectState(history.present, 128), 'Change timeline length');
  assert.equal(history.present.totalBars, 128);

  history = history.undo();
  assert.equal(history.present.totalBars, 512, 'undo restores the 512-bar timeline');
  assert.equal(history.present.playlistClips[0].startBar, 400, 'undo restores the original bar 400 position');
});

test('Phase 1G: re-expanding after a shrink does not corrupt relocated clips', () => {
  const project = withBars(512, [clip({ id: 'far', startBar: 400, lengthBars: 4 })]);
  const shrunk = setTimelineBarsInProjectState(project, 128);
  const expanded = setTimelineBarsInProjectState(shrunk, 512);

  assert.equal(expanded.totalBars, 512);
  assert.equal(expanded.playlistClips[0].startBar, 124);
  assert.deepEqual(clampClipsToTimeline(expanded.playlistClips, 512), expanded.playlistClips);
});

test('Phase 1G: setting the same 512-bar length is a no-op transition', () => {
  const project = withBars(512, [clip({ startBar: 400, lengthBars: 4 })]);
  assert.equal(setTimelineBarsInProjectState(project, 512), project);
  assert.equal(revalidateProjectTimeline(project), project);
});

// ---------------------------------------------------------------------------
// 6. Load-time revalidation.
// ---------------------------------------------------------------------------

test('Phase 1G: a stored 512-bar arrangement overhanging its boundary is pulled back, not stranded', () => {
  const stored = withBars(512, [clip({ id: 'over', startBar: 511, lengthBars: 4 })]);
  const normalized = normalizeProjectState(stored);

  assert.equal(normalized.playlistClips.length, 1, 'the clip must be preserved');
  assert.equal(normalized.playlistClips[0].startBar, 508);
  assert.ok(normalized.playlistClips[0].startBar + normalized.playlistClips[0].lengthBars <= 512);
});

test('Phase 1G: revalidation of a 128-bar document keeps in-range long-bar clips unchanged', () => {
  const project = withBars(128, [clip({ id: 'mid', startBar: 100, lengthBars: 8 })]);
  const revalidated = revalidateProjectTimeline(project);

  assert.equal(revalidated, project, 'a valid long arrangement must not be rewritten');
});

// ---------------------------------------------------------------------------
// 7. Legacy and malformed state — unchanged by Phase 1G.
// ---------------------------------------------------------------------------

test('Phase 1G (regression anchor): legacy 32- and 64-bar projects load at their stored length', () => {
  assert.equal(normalizeTimelineBars(32), 32);
  assert.equal(normalizeTimelineBars(64), 64);
  assert.equal(roundTrip(withBars(64)).totalBars, 64);
  assert.equal(roundTrip(withBars(32)).totalBars, 32);
});

test('Phase 1G (regression anchor): legacy 64-bar clips keep their exact positions', () => {
  const legacy = withBars(64, [clip({ id: 'legacy', startBar: 60, lengthBars: 4 })]);
  const restored = roundTrip(legacy);
  assert.equal(restored.playlistClips[0].startBar, 60);
  assert.equal(restored.playlistClips[0].lengthBars, 4);
});

test('Phase 1G (regression anchor): absent, non-numeric and non-positive lengths still fall back to the default', () => {
  assert.equal(normalizeTimelineBars(undefined), DEFAULT_TIMELINE_BARS);
  assert.equal(normalizeTimelineBars(null), DEFAULT_TIMELINE_BARS);
  assert.equal(normalizeTimelineBars(Number.NaN), DEFAULT_TIMELINE_BARS);
  assert.equal(normalizeTimelineBars('not-a-number'), DEFAULT_TIMELINE_BARS);
  assert.equal(normalizeTimelineBars(0), DEFAULT_TIMELINE_BARS);
  assert.equal(normalizeTimelineBars(-16), DEFAULT_TIMELINE_BARS);
  assert.equal(normalizeTimelineBars(Number.POSITIVE_INFINITY), DEFAULT_TIMELINE_BARS);
});

test('Phase 1G (regression anchor): a project without a stored length loads at the default', () => {
  const { totalBars: _dropped, ...withoutTimeline } = createDefaultProjectState();
  assert.equal(normalizeProjectState(withoutTimeline as ProjectState).totalBars, DEFAULT_TIMELINE_BARS);
});

test('Phase 1G (regression anchor): a malformed clip is returned untouched by timeline clamping', () => {
  const malformed = clip({ startBar: Number.NaN, lengthBars: 4 });
  assert.equal(clampClipToTimeline(malformed, 512), malformed);
});

test('Phase 1G (regression anchor): a zero-length clip is returned untouched by timeline clamping', () => {
  const malformed = clip({ startBar: 100, lengthBars: 0 });
  assert.equal(clampClipToTimeline(malformed, 512), malformed);
});
