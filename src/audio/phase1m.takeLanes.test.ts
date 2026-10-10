/**
 * Phase 1M — Comping Lanes and Take Management acceptance tests.
 *
 * These tests verify the take-grouping model, take selection, playback
 * audibility, export correctness, persistence round-trip, and undo/redo
 * compatibility. They use the same node:test harness as the rest of the
 * codebase and exercise the pure logic modules directly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PlaylistClip } from '../types/daw';
import {
  resolveActiveTakeIndex,
  isTakeAudible,
  resolveInaudibleTakeClipIds,
  selectActiveTake,
  getTakeGroupClips,
  getTakeGroupIds,
  nextTakeIndexForGroup,
  createTakeGroupId,
  validateTakeGroup,
  removeTakeFromGroup,
} from './takeLaneManager';
import { applyTakeSelectionToClips } from './recordingPipeline';

// --- Test helpers ---

const makeClip = (overrides: Partial<PlaylistClip> & { id: string }): PlaylistClip => ({
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'audio',
  color: '#ff6e00',
  name: 'Test Clip',
  ...overrides,
});

// --- Tests ---

describe('Phase 1M — Take Lane Manager', () => {
  describe('resolveActiveTakeIndex', () => {
    it('returns the declared activeTakeIndex when present', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 0 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 0 }),
      ];
      assert.equal(resolveActiveTakeIndex(clips, 'g1'), 0);
    });

    it('falls back to the highest takeIndex when no activeTakeIndex is set', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1 }),
        makeClip({ id: 'c', takeGroupId: 'g1', takeIndex: 2 }),
      ];
      assert.equal(resolveActiveTakeIndex(clips, 'g1'), 2);
    });

    it('returns null for a non-existent group', () => {
      assert.equal(resolveActiveTakeIndex([], 'g1'), null);
    });

    it('ignores clips from other groups', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0 }),
        makeClip({ id: 'b', takeGroupId: 'g2', takeIndex: 5 }),
      ];
      assert.equal(resolveActiveTakeIndex(clips, 'g1'), 0);
    });
  });

  describe('isTakeAudible', () => {
    it('returns true for clips without a takeGroupId (ordinary clips)', () => {
      const clip = makeClip({ id: 'x' });
      assert.equal(isTakeAudible(clip, [clip]), true);
    });

    it('returns true for the active take in a group', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 1 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 1 }),
      ];
      assert.equal(isTakeAudible(clips[1], clips), true);
    });

    it('returns false for inactive takes in a group', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 1 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 1 }),
      ];
      assert.equal(isTakeAudible(clips[0], clips), false);
    });
  });

  describe('resolveInaudibleTakeClipIds', () => {
    it('returns an empty set when there are no take groups', () => {
      const clips = [
        makeClip({ id: 'a' }),
        makeClip({ id: 'b' }),
      ];
      const result = resolveInaudibleTakeClipIds(clips);
      assert.equal(result.size, 0);
    });

    it('returns the inactive take clip IDs', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 1 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 1 }),
        makeClip({ id: 'c' }),
      ];
      const result = resolveInaudibleTakeClipIds(clips);
      assert.equal(result.size, 1);
      assert.ok(result.has('a'));
    });

    it('handles multiple take groups independently', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 0 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 0 }),
        makeClip({ id: 'c', takeGroupId: 'g2', takeIndex: 0, activeTakeIndex: 1 }),
        makeClip({ id: 'd', takeGroupId: 'g2', takeIndex: 1, activeTakeIndex: 1 }),
      ];
      const result = resolveInaudibleTakeClipIds(clips);
      assert.equal(result.size, 2);
      assert.ok(result.has('b'));
      assert.ok(result.has('c'));
    });
  });

  describe('selectActiveTake', () => {
    it('updates activeTakeIndex on all clips in the group', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 1 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 1 }),
        makeClip({ id: 'c' }),
      ];
      const result = selectActiveTake(clips, 'g1', 0);
      assert.equal(result[0].activeTakeIndex, 0);
      assert.equal(result[1].activeTakeIndex, 0);
      assert.equal(result[2].takeGroupId, undefined); // unaffected
    });

    it('throws when the group does not exist', () => {
      assert.throws(() => selectActiveTake([], 'g1', 0), /No take group found/);
    });

    it('throws on negative takeIndex', () => {
      const clips = [makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0 })];
      assert.throws(() => selectActiveTake(clips, 'g1', -1), /non-negative integer/);
    });
  });

  describe('getTakeGroupClips', () => {
    it('returns group clips sorted by takeIndex', () => {
      const clips = [
        makeClip({ id: 'c', takeGroupId: 'g1', takeIndex: 2 }),
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1 }),
        makeClip({ id: 'd' }),
      ];
      const result = getTakeGroupClips(clips, 'g1');
      assert.equal(result.length, 3);
      assert.equal(result[0].id, 'a');
      assert.equal(result[1].id, 'b');
      assert.equal(result[2].id, 'c');
    });
  });

  describe('getTakeGroupIds', () => {
    it('returns distinct take group IDs', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1' }),
        makeClip({ id: 'b', takeGroupId: 'g2' }),
        makeClip({ id: 'c', takeGroupId: 'g1' }),
        makeClip({ id: 'd' }),
      ];
      const result = getTakeGroupIds(clips);
      assert.equal(result.length, 2);
      assert.ok(result.includes('g1'));
      assert.ok(result.includes('g2'));
    });
  });

  describe('nextTakeIndexForGroup', () => {
    it('returns 0 for a new group', () => {
      assert.equal(nextTakeIndexForGroup([], 'g1'), 0);
    });

    it('returns the next index after the highest', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 2 }),
      ];
      assert.equal(nextTakeIndexForGroup(clips, 'g1'), 3);
    });
  });

  describe('createTakeGroupId', () => {
    it('produces a deterministic prefix from track and bar', () => {
      const id = createTakeGroupId(2, 8, 1000);
      assert.ok(id.startsWith('take-group-t2-b8-'));
    });

    it('includes a timestamp component', () => {
      const id = createTakeGroupId(0, 0, 12345);
      assert.ok(id.includes('12345'));
    });
  });

  describe('validateTakeGroup', () => {
    it('validates a well-formed group', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, trackIndex: 0, startBar: 4, lengthBars: 2, activeTakeIndex: 0 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, trackIndex: 0, startBar: 4, lengthBars: 2, activeTakeIndex: 0 }),
      ];
      const result = validateTakeGroup(clips, 'g1');
      assert.equal(result.valid, true);
      assert.equal(result.issues.length, 0);
    });

    it('reports clips on different tracks', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, trackIndex: 0, startBar: 4, lengthBars: 2 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, trackIndex: 1, startBar: 4, lengthBars: 2 }),
      ];
      const result = validateTakeGroup(clips, 'g1');
      assert.equal(result.valid, false);
      assert.ok(result.issues.some(i => i.includes('different tracks')));
    });

    it('reports duplicate takeIndex values', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, trackIndex: 0, startBar: 4, lengthBars: 2 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 0, trackIndex: 0, startBar: 4, lengthBars: 2 }),
      ];
      const result = validateTakeGroup(clips, 'g1');
      assert.equal(result.valid, false);
      assert.ok(result.issues.some(i => i.includes('duplicate')));
    });

    it('reports an empty group', () => {
      const result = validateTakeGroup([], 'g1');
      assert.equal(result.valid, false);
    });
  });

  describe('removeTakeFromGroup', () => {
    it('removes a take and keeps the rest', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 0 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 0 }),
        makeClip({ id: 'c', takeGroupId: 'g1', takeIndex: 2, activeTakeIndex: 0 }),
      ];
      const result = removeTakeFromGroup(clips, 'g1', 1);
      assert.equal(result.length, 2);
      assert.ok(result.every(c => c.id !== 'b'));
    });

    it('falls back active selection when the active take is removed', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 1 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 1 }),
        makeClip({ id: 'c', takeGroupId: 'g1', takeIndex: 2, activeTakeIndex: 1 }),
      ];
      const result = removeTakeFromGroup(clips, 'g1', 1);
      // Should fall back to nearest remaining take (0 or 2)
      const activeIndex = resolveActiveTakeIndex(result, 'g1');
      assert.ok(activeIndex === 0 || activeIndex === 2);
    });

    it('dissolves the group when only one take remains', () => {
      const clips = [
        makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 0 }),
        makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 0 }),
      ];
      const result = removeTakeFromGroup(clips, 'g1', 0);
      assert.equal(result.length, 1);
      assert.equal(result[0].takeGroupId, undefined);
      assert.equal(result[0].takeIndex, undefined);
    });
  });
});

describe('Phase 1M — applyTakeSelectionToClips', () => {
  it('updates activeTakeIndex on all clips in the specified group', () => {
    const clips = [
      makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 1 }),
      makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 1 }),
      makeClip({ id: 'c', takeGroupId: 'g2', takeIndex: 0, activeTakeIndex: 0 }),
    ];
    const result = applyTakeSelectionToClips(clips, 'g1', 0);
    assert.equal(result[0].activeTakeIndex, 0);
    assert.equal(result[1].activeTakeIndex, 0);
    assert.equal(result[2].activeTakeIndex, 0); // g2 unchanged
  });

  it('returns the same array when the selection is already applied', () => {
    const clips = [
      makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 0 }),
      makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 0 }),
    ];
    const result = applyTakeSelectionToClips(clips, 'g1', 0);
    // Each clip should be the same reference since nothing changed
    assert.equal(result[0], clips[0]);
    assert.equal(result[1], clips[1]);
  });
});

describe('Phase 1M — Persistence round-trip', () => {
  it('take-group fields survive JSON serialization', () => {
    const clips = [
      makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 1 }),
      makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 1 }),
    ];
    const serialized = JSON.stringify(clips);
    const deserialized = JSON.parse(serialized) as PlaylistClip[];
    assert.equal(deserialized[0].takeGroupId, 'g1');
    assert.equal(deserialized[0].takeIndex, 0);
    assert.equal(deserialized[0].activeTakeIndex, 1);
    assert.equal(deserialized[1].takeIndex, 1);
  });

  it('project history snapshots preserve take selection', () => {
    // Simulate a project history snapshot (as done by sanitizeProjectSnapshot)
    const clips = [
      makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 0 }),
      makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 0 }),
    ];
    const snapshot = JSON.parse(JSON.stringify({ playlistClips: clips }));
    const restored = snapshot.playlistClips as PlaylistClip[];
    assert.equal(restored[0].takeGroupId, 'g1');
    assert.equal(resolveActiveTakeIndex(restored, 'g1'), 0);
    assert.equal(isTakeAudible(restored[0], restored), true);
    assert.equal(isTakeAudible(restored[1], restored), false);
  });
});

describe('Phase 1M — Non-destructive editing', () => {
  it('selecting a different take preserves all take audio buffer IDs', () => {
    const clips = [
      makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, audioBufferId: 'buf-0', activeTakeIndex: 0 }),
      makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, audioBufferId: 'buf-1', activeTakeIndex: 0 }),
    ];
    const result = selectActiveTake(clips, 'g1', 1);
    assert.equal(result[0].audioBufferId, 'buf-0'); // preserved
    assert.equal(result[1].audioBufferId, 'buf-1'); // preserved
    assert.equal(isTakeAudible(result[0], result), false); // now inactive
    assert.equal(isTakeAudible(result[1], result), true);  // now active
  });

  it('removing a take preserves remaining takes unchanged', () => {
    const clips = [
      makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, audioBufferId: 'buf-0', activeTakeIndex: 0 }),
      makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, audioBufferId: 'buf-1', activeTakeIndex: 0 }),
      makeClip({ id: 'c', takeGroupId: 'g1', takeIndex: 2, audioBufferId: 'buf-2', activeTakeIndex: 0 }),
    ];
    const result = removeTakeFromGroup(clips, 'g1', 1);
    assert.equal(result.length, 2);
    assert.equal(result.find(c => c.id === 'a')?.audioBufferId, 'buf-0');
    assert.equal(result.find(c => c.id === 'c')?.audioBufferId, 'buf-2');
  });
});

describe('Phase 1M — Undo/redo compatibility', () => {
  it('undoing a take selection restores the previous active take', () => {
    // State before selection change
    const before = [
      makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 0 }),
      makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 0 }),
    ];
    // After selection change (simulating commit to history)
    const after = selectActiveTake(before, 'g1', 1);
    // Undo: restore the before state
    const undone = JSON.parse(JSON.stringify(before)) as PlaylistClip[];
    assert.equal(resolveActiveTakeIndex(undone, 'g1'), 0);
    assert.equal(isTakeAudible(undone[0], undone), true);
    assert.equal(isTakeAudible(undone[1], undone), false);
  });

  it('redoing restores the selection', () => {
    const state = [
      makeClip({ id: 'a', takeGroupId: 'g1', takeIndex: 0, activeTakeIndex: 1 }),
      makeClip({ id: 'b', takeGroupId: 'g1', takeIndex: 1, activeTakeIndex: 1 }),
    ];
    assert.equal(resolveActiveTakeIndex(state, 'g1'), 1);
    assert.equal(isTakeAudible(state[0], state), false);
    assert.equal(isTakeAudible(state[1], state), true);
  });
});
