/**
 * Regression — active take must paint on top in the Playlist.
 *
 * Defect (reproduced on main @ 65f9438): Playlist clip nodes are absolutely
 * positioned siblings painted in DOM order, and every take of a comping group
 * covers the same timeline region. The arranger rendered
 * `projectState.playlistClips` in raw array order, so after selecting an older
 * take through Take Comping, the *silenced* later-recorded take still painted
 * over the active one: playback followed the selection, the picture did not.
 *
 * Fix: `orderClipsForTakeRendering` (src/audio/takeLaneManager.ts) derives the
 * visual order from the current take state — within each take group the active
 * take renders last (topmost) among its own group-mates — and PlaylistArranger
 * renders through it. The persisted clip array is never reordered for painting.
 *
 * These tests exercise the real helper, the real `selectActiveTake` pipeline,
 * and the real `PlaylistArranger` DOM (renderToStaticMarkup, same harness as
 * playlistArrangerThemeUi.test.tsx) — no source-text assertions.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlaylistArranger } from './PlaylistArranger';
import {
  addTakeToProjectClips,
  findMatchingTakeGroup,
  isTakeAudible,
  orderClipsForTakeRendering,
  resolveActiveTakeIndex,
  selectActiveTake,
} from '../audio/takeLaneManager';
import type { PlaylistClip, PlaylistTrack } from '../types/daw';

const noop = (): void => {};

const makeClip = (overrides: Partial<PlaylistClip> & { id: string }): PlaylistClip => ({
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'audio',
  color: '#00ff88',
  name: 'Test Clip',
  audioBufferId: 'buf-test',
  ...overrides,
});

/** Deep-freezes an array of clips so any mutation attempt throws (ESM strict). */
const deepFreeze = <T extends object>(items: T[]): readonly T[] => {
  for (const item of items) Object.freeze(item);
  return Object.freeze(items);
};

const ids = (clips: readonly PlaylistClip[]): string[] => clips.map(c => c.id);

/**
 * Persisted fixture — array order deliberately puts the active take of group A
 * *before* its newer inactive group-mate, with ordinary clips interleaved:
 *
 *   slot 0: plain-start   (track 0, ordinary)
 *   slot 1: take-a1       (track 0, group A, takeIndex 0, ACTIVE)
 *   slot 2: plain-mid     (track 0, ordinary)
 *   slot 3: take-a2       (track 0, group A, takeIndex 1, inactive, newer)
 *   slot 4: take-b1       (track 1, group B, takeIndex 0)
 *   slot 5: take-b2       (track 1, group B, takeIndex 1, ACTIVE by default)
 *   slot 6: plain-end     (track 1, ordinary)
 */
const buildFixture = (): PlaylistClip[] => [
  makeClip({ id: 'plain-start', trackIndex: 0, startBar: 0, lengthBars: 2, type: 'pattern', name: 'Intro Pattern' }),
  makeClip({ id: 'take-a1', trackIndex: 0, startBar: 4, lengthBars: 2, name: 'Vocal Take 1', takeGroupId: 'grp-a', takeIndex: 0, activeTakeIndex: 0 }),
  makeClip({ id: 'plain-mid', trackIndex: 0, startBar: 8, lengthBars: 2, name: 'Plain Mid' }),
  makeClip({ id: 'take-a2', trackIndex: 0, startBar: 4, lengthBars: 2, name: 'Vocal Take 2', takeGroupId: 'grp-a', takeIndex: 1, activeTakeIndex: 0 }),
  makeClip({ id: 'take-b1', trackIndex: 1, startBar: 0, lengthBars: 4, name: 'Bass Take 1', takeGroupId: 'grp-b', takeIndex: 0 }),
  makeClip({ id: 'take-b2', trackIndex: 1, startBar: 0, lengthBars: 4, name: 'Bass Take 2', takeGroupId: 'grp-b', takeIndex: 1 }),
  makeClip({ id: 'plain-end', trackIndex: 1, startBar: 8, lengthBars: 2, type: 'pattern', name: 'Outro Pattern' }),
];

const tracks: PlaylistTrack[] = [
  { id: 1, name: 'Audio 1', color: '#00ff88', volume: 1, pan: 0, mute: false, solo: false },
  { id: 2, name: 'Audio 2', color: '#00ff88', volume: 1, pan: 0, mute: false, solo: false },
];

/** Renders the real arranger and returns clip ids in DOM order (paint order:
    later sibling paints on top). Track rows render in order, so this is
    track 0's clips followed by track 1's clips, each in its paint order. */
const renderDomClipOrder = (clips: readonly PlaylistClip[]): string[] => {
  const markup = renderToStaticMarkup(
    React.createElement(PlaylistArranger, {
      tracks,
      clips: clips as PlaylistClip[],
      patterns: [],
      channels: [],
      onUpdateTracks: noop,
      onUpdateClips: noop,
      onAddTrack: noop,
      currentBar: 1,
      isPlaying: false,
      bpm: 120,
      totalBars: 16,
      onUpdateTotalBars: noop,
    })
  );
  return [...markup.matchAll(/data-clip-id="([^"]+)"/g)].map(m => m[1]);
};

describe('orderClipsForTakeRendering — pure paint-order helper', () => {
  it('moves an older active take above its newer inactive group-mate', () => {
    const clips = buildFixture();
    const ordered = orderClipsForTakeRendering(clips);
    // take-a1 is active (activeTakeIndex 0) but sits before take-a2 in the
    // persisted array; visually it must render last within group A's slots.
    assert.deepEqual(ids(ordered), [
      'plain-start', 'take-a2', 'plain-mid', 'take-a1',
      'take-b1', 'take-b2', 'plain-end',
    ]);
  });

  it('switching the active take reverses the visual ordering', () => {
    const clips = buildFixture();
    const take2Active = selectActiveTake(clips, 'grp-a', 1);
    const ordered = orderClipsForTakeRendering(take2Active);
    // take-a2 (slot 3) is now active; take-a1 must render first within the
    // group's slots — the exact reverse of the previous test's group order.
    assert.deepEqual(ids(ordered).slice(0, 4), ['plain-start', 'take-a1', 'plain-mid', 'take-a2']);
    // Group B is untouched by the selection and keeps its order.
    assert.deepEqual(ids(ordered).slice(4), ['take-b1', 'take-b2', 'plain-end']);
  });

  it('applies the default-active rule (latest take) when nothing is declared', () => {
    // Array order puts the newest take first; the default active take (highest
    // takeIndex) must still paint on top.
    const clips = [
      makeClip({ id: 't2', takeGroupId: 'g', takeIndex: 1 }),
      makeClip({ id: 't1', takeGroupId: 'g', takeIndex: 0 }),
    ];
    assert.equal(resolveActiveTakeIndex(clips, 'g'), 1);
    assert.deepEqual(ids(orderClipsForTakeRendering(clips)), ['t1', 't2']);
  });

  it('does not mutate the input array or clone clips (persisted data untouched)', () => {
    const frozen = deepFreeze(buildFixture());
    const before = ids(frozen);
    const ordered = orderClipsForTakeRendering(frozen);
    // Frozen input: any in-place write would have thrown.
    assert.deepEqual(ids(frozen), before, 'persisted array order must be unchanged');
    assert.notEqual(ordered, frozen, 'helper must return a new array');
    // Clips are reused by reference — nothing cloned, nothing written through.
    for (const clip of ordered) assert.ok(frozen.includes(clip), 'output clips are the same object references');
  });

  it('keeps ordinary clips and unrelated groups at their exact positions', () => {
    const clips = buildFixture();
    const ordered = orderClipsForTakeRendering(clips);
    // Ordinary clips never move, even when they sit between group-mates.
    assert.equal(ordered[0].id, 'plain-start');
    assert.equal(ordered[2].id, 'plain-mid');
    assert.equal(ordered[6].id, 'plain-end');
    // Group B (active take already last) keeps its exact slot order.
    assert.equal(ordered[4].id, 'take-b1');
    assert.equal(ordered[5].id, 'take-b2');
    // Each group keeps exactly the slots it occupied before.
    const groupASlotsBefore = clips.map((c, i) => (c.takeGroupId === 'grp-a' ? i : -1)).filter(i => i >= 0);
    const groupASlotsAfter = ordered.map((c, i) => (c.takeGroupId === 'grp-a' ? i : -1)).filter(i => i >= 0);
    assert.deepEqual(groupASlotsAfter, groupASlotsBefore, 'the active take must not jump over unrelated clips');
  });

  it('is stable and defensive for degenerate groups', () => {
    const lone = [makeClip({ id: 'solo', takeGroupId: 'g-solo', takeIndex: 0 })];
    assert.deepEqual(ids(orderClipsForTakeRendering(lone)), ['solo'], 'a lone take never moves');

    // A corrupt activeTakeIndex that matches no take must not reorder anything.
    const corrupt = [
      makeClip({ id: 'c1', takeGroupId: 'g', takeIndex: 0, activeTakeIndex: 7 }),
      makeClip({ id: 'c2', takeGroupId: 'g', takeIndex: 1, activeTakeIndex: 7 }),
    ];
    assert.deepEqual(ids(orderClipsForTakeRendering(corrupt)), ['c1', 'c2']);

    // No take groups at all: identity order.
    const plain = buildFixture().filter(c => !c.takeGroupId);
    assert.deepEqual(ids(orderClipsForTakeRendering(plain)), ids(plain));
  });
});

describe('PlaylistArranger DOM — active take paints on top', () => {
  it('renders the selected older take above the newer inactive take', () => {
    const clips = buildFixture();
    // Sanity: take-a1 is the selected/audible take, take-a2 is silenced.
    const takeA1 = clips.find(c => c.id === 'take-a1')!;
    const takeA2 = clips.find(c => c.id === 'take-a2')!;
    assert.equal(isTakeAudible(takeA1, clips), true);
    assert.equal(isTakeAudible(takeA2, clips), false);

    const domOrder = renderDomClipOrder(clips);
    assert.deepEqual(domOrder, [
      'plain-start', 'take-a2', 'plain-mid', 'take-a1',
      'take-b1', 'take-b2', 'plain-end',
    ], 'within a track row, the active take must be the last DOM sibling of its group (painted on top)');
    assert.ok(domOrder.indexOf('take-a1') > domOrder.indexOf('take-a2'),
      'DEFECT REGRESSION: inactive take-a2 must not paint over active take-a1');
  });

  it('reverses the DOM stacking when the active take is switched through Take Comping', () => {
    const clips = buildFixture();
    const switched = selectActiveTake(clips, 'grp-a', 1);

    const before = renderDomClipOrder(clips);
    const after = renderDomClipOrder(switched);

    assert.ok(before.indexOf('take-a1') > before.indexOf('take-a2'), 'take-a1 active: painted above take-a2');
    assert.ok(after.indexOf('take-a2') > after.indexOf('take-a1'), 'take-a2 active: painted above take-a1');
    // Unrelated clips keep their DOM positions across the switch.
    for (const id of ['plain-start', 'plain-mid', 'take-b1', 'take-b2', 'plain-end']) {
      assert.equal(after.indexOf(id), before.indexOf(id), `${id} must not move when group A's active take changes`);
    }
  });

  it('restacks immediately when a selection is undone (previous state re-renders as before)', () => {
    const clips = buildFixture();
    const switched = selectActiveTake(clips, 'grp-a', 1);
    const firstPass = renderDomClipOrder(clips);
    const switchedPass = renderDomClipOrder(switched);
    // Undo restores the previous clip array; the derived paint order must
    // follow with no extra bookkeeping.
    const undonePass = renderDomClipOrder(clips);
    assert.notDeepEqual(switchedPass, firstPass, 'the switch must visibly restack the group');
    assert.deepEqual(undonePass, firstPass, 'undoing the selection must restore the original stacking immediately');
  });

  it('never mutates the clips prop while rendering', () => {
    const frozen = deepFreeze(buildFixture());
    const before = ids(frozen);
    renderDomClipOrder(frozen); // deep-frozen input: any render-time mutation throws
    assert.deepEqual(ids(frozen), before, 'rendering must not reorder or rewrite persisted project data');
  });

  it('follows the real recording pipeline: two takes at one position, then select Take 1', () => {
    // Rebuild the reported scenario through the production take-group pipeline.
    let clips: PlaylistClip[] = [];
    const rec1 = makeClip({ id: 'rec-take-1', trackIndex: 0, startBar: 4, lengthBars: 2, name: 'Vocal Take 1', audioBufferId: 'buf-1' });
    clips = addTakeToProjectClips(clips, rec1, findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars));
    const rec2 = makeClip({ id: 'rec-take-2', trackIndex: 0, startBar: 4, lengthBars: 2, name: 'Vocal Take 2', audioBufferId: 'buf-2' });
    clips = addTakeToProjectClips(clips, rec2, findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars));
    const groupId = clips[0].takeGroupId!;

    // Take 2 (the newest) is active by default and already paints on top.
    assert.equal(resolveActiveTakeIndex(clips, groupId), 1);
    assert.deepEqual(renderDomClipOrder(clips), ['rec-take-1', 'rec-take-2']);

    // Select Take 1 exactly like TakeCompingModal's onSelectActiveTake does.
    const selected = selectActiveTake(clips, groupId, 0);
    assert.equal(resolveActiveTakeIndex(selected, groupId), 0, 'playback selection updated');
    assert.equal(isTakeAudible(selected[0], selected), true, 'Take 1 audible');
    assert.equal(isTakeAudible(selected[1], selected), false, 'Take 2 silenced');

    const domOrder = renderDomClipOrder(selected);
    assert.deepEqual(domOrder, ['rec-take-2', 'rec-take-1'],
      'the active Take 1 must paint above the silenced Take 2');
    assert.deepEqual(ids(selected), ['rec-take-1', 'rec-take-2'],
      'the persisted project array must keep its stored order');
  });
});
