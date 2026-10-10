/**
 * Phase 1M: Comping Lanes and Take Management - Behavioral Tests
 * 
 * These tests exercise the actual production functions with realistic scenarios
 * to verify the complete take management workflow behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findMatchingTakeGroup,
  addTakeToProjectClips,
  resolveActiveTakeIndex,
  isTakeAudible,
  resolveInaudibleTakeClipIds,
  selectActiveTake,
  getTakeGroupClips,
  validateTakeGroup,
} from './takeLaneManager';
import type { PlaylistClip } from '../types/daw';

// Helper to create a minimal valid PlaylistClip
const makeClip = (overrides: Partial<PlaylistClip> & { id: string }): PlaylistClip => ({
  trackIndex: 0,
  startBar: 0,
  lengthBars: 4,
  type: 'audio',
  color: '#ff6e00',
  name: 'Test Clip',
  ...overrides,
});

describe('Phase 1M: Recording Integration - Real Behavior', () => {
  describe('First recording creates a take group', () => {
    it('a recording with no existing groups creates a new group', () => {
      const clips: PlaylistClip[] = [];
      const newClip = makeClip({ 
        id: 'rec-1', 
        trackIndex: 0, 
        startBar: 4, 
        lengthBars: 2,
        audioBufferId: 'buffer-1'
      });
      
      const matchingGroup = findMatchingTakeGroup(clips, newClip.trackIndex, newClip.startBar, newClip.lengthBars);
      assert.equal(matchingGroup, undefined, 'no group should match when no clips exist');
      
      const result = addTakeToProjectClips(clips, newClip, matchingGroup);
      assert.equal(result.length, 1, 'one clip should be added');
      assert.ok(result[0].takeGroupId, 'clip should have a takeGroupId');
      assert.equal(result[0].takeIndex, 0, 'first take should have index 0');
      assert.equal(result[0].activeTakeIndex, 0, 'first take should be active');
    });

    it('the created group has valid metadata', () => {
      const clips: PlaylistClip[] = [];
      const newClip = makeClip({ 
        id: 'rec-1', 
        trackIndex: 2, 
        startBar: 8, 
        lengthBars: 3,
        audioBufferId: 'buffer-1'
      });
      
      const matchingGroup = findMatchingTakeGroup(clips, newClip.trackIndex, newClip.startBar, newClip.lengthBars);
      const result = addTakeToProjectClips(clips, newClip, matchingGroup);
      
      assert.equal(result[0].trackIndex, 2, 'trackIndex should be preserved');
      assert.equal(result[0].startBar, 8, 'startBar should be preserved');
      assert.equal(result[0].lengthBars, 3, 'lengthBars should be preserved');
      assert.equal(result[0].audioBufferId, 'buffer-1', 'audioBufferId should be preserved');
    });
  });

  describe('Second recording joins existing group', () => {
    it('a recording at the same position joins the existing group', () => {
      // First recording creates a group
      let clips: PlaylistClip[] = [];
      const rec1 = makeClip({ 
        id: 'rec-1', 
        trackIndex: 0, 
        startBar: 4, 
        lengthBars: 2,
        audioBufferId: 'buffer-1'
      });
      
      let matchingGroup = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, matchingGroup);
      const groupId = clips[0].takeGroupId!;
      
      // Second recording at the same position
      const rec2 = makeClip({ 
        id: 'rec-2', 
        trackIndex: 0, 
        startBar: 4, 
        lengthBars: 2,
        audioBufferId: 'buffer-2'
      });
      
      matchingGroup = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(matchingGroup, groupId, 'second recording should match the existing group');
      
      clips = addTakeToProjectClips(clips, rec2, matchingGroup);
      assert.equal(clips.length, 2, 'should have 2 clips');
      assert.equal(clips[1].takeGroupId, groupId, 'second clip should be in the same group');
      assert.equal(clips[1].takeIndex, 1, 'second take should have index 1');
      assert.equal(clips[1].activeTakeIndex, 1, 'second take should now be active');
      assert.equal(clips[0].activeTakeIndex, 1, 'first take should now be inactive');
    });

    it('the new take becomes active automatically', () => {
      let clips: PlaylistClip[] = [];
      
      // Add first take
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 4 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      
      // Add second take
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 0, lengthBars: 4 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      clips = addTakeToProjectClips(clips, rec2, group);
      
      const activeIndex = resolveActiveTakeIndex(clips, clips[0].takeGroupId!);
      assert.equal(activeIndex, 1, 'the latest take should be active');
      assert.equal(isTakeAudible(clips[1], clips), true, 'the latest take should be audible');
      assert.equal(isTakeAudible(clips[0], clips), false, 'the older take should be silent');
    });
  });

  describe('Recordings on different tracks do not join', () => {
    it('a recording on a different track creates a separate group', () => {
      let clips: PlaylistClip[] = [];
      
      // First recording on track 0
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 4, lengthBars: 2 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId1 = clips[0].takeGroupId!;
      
      // Second recording on track 1
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 1, startBar: 4, lengthBars: 2 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, undefined, 'recording on different track should not match');
      
      clips = addTakeToProjectClips(clips, rec2, group);
      assert.equal(clips.length, 2, 'should have 2 clips');
      assert.notEqual(clips[1].takeGroupId, groupId1, 'second clip should be in a different group');
    });
  });

  describe('Recordings at different positions do not join', () => {
    it('a recording at a different position creates a separate group', () => {
      let clips: PlaylistClip[] = [];
      
      // First recording at bar 4
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 4, lengthBars: 2 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId1 = clips[0].takeGroupId!;
      
      // Second recording at bar 10 (far away)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 10, lengthBars: 2 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, undefined, 'recording at different position should not match');
      
      clips = addTakeToProjectClips(clips, rec2, group);
      assert.notEqual(clips[1].takeGroupId, groupId1, 'should be in different groups');
    });

    it('recordings within 0.1 bars join (floating-point tolerance for punch takes)', () => {
      let clips: PlaylistClip[] = [];
      
      // First recording at bar 4.0 (punch take with fractional start)
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 4.0, lengthBars: 2 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId = clips[0].takeGroupId!;
      
      // Second recording at bar 4.05 (within 0.1 tolerance — floating-point noise)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 4.05, lengthBars: 2 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, groupId, 'recording within 0.1 tolerance should match');
    });

    it('recordings 0.3 bars apart do NOT join (distinct recordings stay independent)', () => {
      let clips: PlaylistClip[] = [];
      
      // First recording at bar 4.0
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 4.0, lengthBars: 2 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId1 = clips[0].takeGroupId!;
      
      // Second recording at bar 4.3 (0.3 bars apart — distinct musical phrase)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 4.3, lengthBars: 2 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, undefined, 'recording 0.3 bars apart should NOT match — distinct recordings must stay independent');
      
      clips = addTakeToProjectClips(clips, rec2, group);
      assert.notEqual(clips[1].takeGroupId, groupId1, 'should be in separate groups');
    });

    it('recordings 1 full bar apart do not join', () => {
      let clips: PlaylistClip[] = [];
      
      // First recording at bar 4
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 4, lengthBars: 2 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId1 = clips[0].takeGroupId!;
      
      // Second recording at bar 5 (1 full bar apart — ordinary recording at next bar)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 5, lengthBars: 2 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, undefined, 'recording 1 bar apart should not match');
      
      clips = addTakeToProjectClips(clips, rec2, group);
      assert.notEqual(clips[1].takeGroupId, groupId1, 'should be in separate groups');
    });
  });

  describe('Recordings with different lengths', () => {
    it('recordings with lengths within 1 bar join (ceiling rounding tolerance)', () => {
      let clips: PlaylistClip[] = [];
      
      // First recording with length 2
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 2 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId = clips[0].takeGroupId!;
      
      // Second recording with length 3 (1 bar difference — within ceiling rounding tolerance)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 0, lengthBars: 3 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, groupId, 'recording within 1 bar length tolerance should match');
    });

    it('recordings with lengths differing by more than 1 bar do not join', () => {
      let clips: PlaylistClip[] = [];
      
      // First recording with length 2
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 2 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId = clips[0].takeGroupId!;
      
      // Second recording with length 4 (2 bars difference — beyond tolerance)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 0, lengthBars: 4 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, undefined, 'recording with length difference > 1 bar should not match');
    });

    it('a short recording cannot silently join a long group and become inaudible', () => {
      let clips: PlaylistClip[] = [];
      
      // First: a 4-bar recording creates a group
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 4, audioBufferId: 'buf-long' });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId = clips[0].takeGroupId!;
      
      // Second: a 1-bar recording at the same position (very different length)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 0, lengthBars: 1, audioBufferId: 'buf-short' });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      
      // The short recording must NOT join the long group
      assert.equal(group, undefined, 'short recording must not join long group — would silence unrelated audio');
      
      // If it did join, the short take (index 1) would become active and the long take would be silenced
      // This is the exact false-positive scenario we must prevent
      clips = addTakeToProjectClips(clips, rec2, group);
      assert.notEqual(clips[1].takeGroupId, groupId, 'short recording must be in its own group');
      
      // Verify both recordings remain audible in their own groups
      assert.equal(clips[0].audioBufferId, 'buf-long');
      assert.equal(clips[1].audioBufferId, 'buf-short');
      const inaudible = resolveInaudibleTakeClipIds(clips);
      assert.equal(inaudible.size, 0, 'neither recording should be silenced when in separate groups');
    });
  });

  describe('Take selection changes audible take', () => {
    it('selecting a different take changes which is audible', () => {
      let clips: PlaylistClip[] = [];
      
      // Create a group with 2 takes
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 4, audioBufferId: 'buf-1' });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 0, lengthBars: 4, audioBufferId: 'buf-2' });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      clips = addTakeToProjectClips(clips, rec2, group);
      
      // Initially, take 1 is active
      assert.equal(isTakeAudible(clips[0], clips), false);
      assert.equal(isTakeAudible(clips[1], clips), true);
      
      // Select take 0
      clips = selectActiveTake(clips, clips[0].takeGroupId!, 0);
      
      assert.equal(isTakeAudible(clips[0], clips), true, 'take 0 should now be audible');
      assert.equal(isTakeAudible(clips[1], clips), false, 'take 1 should now be silent');
    });

    it('selecting an invalid take index throws', () => {
      let clips: PlaylistClip[] = [];
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 4 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      
      assert.throws(
        () => selectActiveTake(clips, clips[0].takeGroupId!, 5),
        /does not exist in group/,
        'selecting non-existent take should throw'
      );
    });
  });

  describe('Inactive takes retain their audio buffers', () => {
    it('all takes keep their audioBufferId after selection changes', () => {
      let clips: PlaylistClip[] = [];
      
      // Create 3 takes
      for (let i = 0; i < 3; i++) {
        const rec = makeClip({ 
          id: `rec-${i}`, 
          trackIndex: 0, 
          startBar: 0, 
          lengthBars: 4, 
          audioBufferId: `buffer-${i}` 
        });
        const group = findMatchingTakeGroup(clips, rec.trackIndex, rec.startBar, rec.lengthBars);
        clips = addTakeToProjectClips(clips, rec, group);
      }
      
      // Select take 0
      clips = selectActiveTake(clips, clips[0].takeGroupId!, 0);
      
      // All takes should still have their buffers
      assert.equal(clips[0].audioBufferId, 'buffer-0');
      assert.equal(clips[1].audioBufferId, 'buffer-1');
      assert.equal(clips[2].audioBufferId, 'buffer-2');
      
      // But only take 0 should be audible
      assert.equal(isTakeAudible(clips[0], clips), true);
      assert.equal(isTakeAudible(clips[1], clips), false);
      assert.equal(isTakeAudible(clips[2], clips), false);
    });
  });

  describe('Playback filtering works correctly', () => {
    it('resolveInaudibleTakeClipIds returns only inactive takes', () => {
      let clips: PlaylistClip[] = [];
      
      // Create 3 takes
      for (let i = 0; i < 3; i++) {
        const rec = makeClip({ 
          id: `rec-${i}`, 
          trackIndex: 0, 
          startBar: 0, 
          lengthBars: 4, 
          audioBufferId: `buffer-${i}` 
        });
        const group = findMatchingTakeGroup(clips, rec.trackIndex, rec.startBar, rec.lengthBars);
        clips = addTakeToProjectClips(clips, rec, group);
      }
      
      // Initially take 2 is active
      let inaudible = resolveInaudibleTakeClipIds(clips);
      assert.equal(inaudible.size, 2, '2 takes should be inaudible');
      assert.ok(inaudible.has('rec-0'));
      assert.ok(inaudible.has('rec-1'));
      assert.ok(!inaudible.has('rec-2'));
      
      // Select take 0
      clips = selectActiveTake(clips, clips[0].takeGroupId!, 0);
      inaudible = resolveInaudibleTakeClipIds(clips);
      assert.equal(inaudible.size, 2, '2 takes should be inaudible');
      assert.ok(!inaudible.has('rec-0'));
      assert.ok(inaudible.has('rec-1'));
      assert.ok(inaudible.has('rec-2'));
    });

    it('ordinary clips are never marked inaudible', () => {
      const clips: PlaylistClip[] = [
        makeClip({ id: 'clip-1', trackIndex: 0, startBar: 0, lengthBars: 4 }),
        makeClip({ id: 'clip-2', trackIndex: 1, startBar: 4, lengthBars: 4 }),
      ];
      
      const inaudible = resolveInaudibleTakeClipIds(clips);
      assert.equal(inaudible.size, 0, 'ordinary clips should not be marked inaudible');
    });

    it('mixed ordinary and take clips filter correctly', () => {
      let clips: PlaylistClip[] = [
        makeClip({ id: 'ordinary-1', trackIndex: 0, startBar: 0, lengthBars: 4 }),
      ];
      
      // Add take group
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 1, startBar: 0, lengthBars: 4 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 1, startBar: 0, lengthBars: 4 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      clips = addTakeToProjectClips(clips, rec2, group);
      
      const inaudible = resolveInaudibleTakeClipIds(clips);
      assert.equal(inaudible.size, 1, 'only 1 inactive take should be inaudible');
      assert.ok(!inaudible.has('ordinary-1'), 'ordinary clip should not be inaudible');
      assert.ok(inaudible.has('rec-1'), 'inactive take should be inaudible');
      assert.ok(!inaudible.has('rec-2'), 'active take should not be inaudible');
    });
  });

  describe('Multiple take groups coexist', () => {
    it('independent take groups do not interfere', () => {
      let clips: PlaylistClip[] = [];
      
      // Create group 1 on track 0
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 4 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 0, lengthBars: 4 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      clips = addTakeToProjectClips(clips, rec2, group);
      
      // Create group 2 on track 1
      const rec3 = makeClip({ id: 'rec-3', trackIndex: 1, startBar: 0, lengthBars: 4 });
      group = findMatchingTakeGroup(clips, rec3.trackIndex, rec3.startBar, rec3.lengthBars);
      clips = addTakeToProjectClips(clips, rec3, group);
      
      // Select different takes in each group
      clips = selectActiveTake(clips, clips[0].takeGroupId!, 0);
      
      const groupId1 = clips[0].takeGroupId!;
      const groupId2 = clips[2].takeGroupId!;
      
      assert.notEqual(groupId1, groupId2, 'should have 2 different groups');
      
      // Group 1: take 0 is active
      assert.equal(isTakeAudible(clips[0], clips), true);
      assert.equal(isTakeAudible(clips[1], clips), false);
      
      // Group 2: take 0 is active (the only one)
      assert.equal(isTakeAudible(clips[2], clips), true);
      
      const inaudible = resolveInaudibleTakeClipIds(clips);
      assert.equal(inaudible.size, 1, 'only 1 take should be inaudible');
      assert.ok(inaudible.has('rec-2'));
    });
  });
});

// --- Phase 1M: Take-group matching safety regression -------------------------
// These tests verify that the matching rule prevents false-positive grouping
// that could silently silence unrelated recordings.

describe('Phase 1M: Take-Group Matching Safety', () => {
  describe('Genuine repeated takes still group correctly', () => {
    it('ordinary recordings at the same integer bar join correctly', () => {
      let clips: PlaylistClip[] = [];
      
      // First take: ordinary recording at bar 4 (integer from Math.floor)
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 4, lengthBars: 4 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId = clips[0].takeGroupId!;
      
      // Second take: same position, same length (genuine repeated take)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 4, lengthBars: 4 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, groupId, 'genuine repeated take should join the group');
    });

    it('ordinary recordings with ±1 bar length difference join (ceiling rounding)', () => {
      let clips: PlaylistClip[] = [];
      
      // First take: 2 bars (e.g., 3.1 seconds at 120 BPM → ceil(1.55) = 2)
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 2 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId = clips[0].takeGroupId!;
      
      // Second take: 3 bars (e.g., 4.1 seconds at 120 BPM → ceil(2.05) = 3)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 0, lengthBars: 3 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, groupId, 'takes with ±1 bar length difference should join (ceiling rounding tolerance)');
    });

    it('punch recordings with fractional startBar join correctly', () => {
      let clips: PlaylistClip[] = [];
      
      // First punch take: fractional start from punch plan
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 4.75, lengthBars: 2.5 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId = clips[0].takeGroupId!;
      
      // Second punch take: same fractional position (from same punch plan)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 4.75, lengthBars: 2.5 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, groupId, 'punch takes at same fractional position should join');
    });

    it('punch recordings with tiny floating-point differences join', () => {
      let clips: PlaylistClip[] = [];
      
      // First punch take
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 4.333333, lengthBars: 2.666667 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId = clips[0].takeGroupId!;
      
      // Second punch take: tiny floating-point noise (e.g., from BPM calculation)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 4.333340, lengthBars: 2.666670 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, groupId, 'punch takes with tiny floating-point differences should join');
    });
  });

  describe('Distinct nearby recordings remain independent', () => {
    it('recordings 0.2 bars apart do NOT join', () => {
      let clips: PlaylistClip[] = [];
      
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 4.0, lengthBars: 2 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId1 = clips[0].takeGroupId!;
      
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 4.2, lengthBars: 2 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, undefined, 'recordings 0.2 bars apart must NOT join');
      
      clips = addTakeToProjectClips(clips, rec2, group);
      assert.notEqual(clips[1].takeGroupId, groupId1, 'must be in separate groups');
    });

    it('recordings on the same track at different bars remain separate', () => {
      let clips: PlaylistClip[] = [];
      
      // Recording at bar 0
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 4 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId1 = clips[0].takeGroupId!;
      
      // Recording at bar 8 (different musical section)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 8, lengthBars: 4 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, undefined, 'recordings at different bars must NOT join');
      
      clips = addTakeToProjectClips(clips, rec2, group);
      assert.notEqual(clips[1].takeGroupId, groupId1, 'must be in separate groups');
    });
  });

  describe('Significantly different lengths do not accidentally join', () => {
    it('a 1-bar recording does not join a 4-bar group', () => {
      let clips: PlaylistClip[] = [];
      
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 4 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId1 = clips[0].takeGroupId!;
      
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 0, lengthBars: 1 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, undefined, '1-bar recording must NOT join 4-bar group');
      
      clips = addTakeToProjectClips(clips, rec2, group);
      assert.notEqual(clips[1].takeGroupId, groupId1, 'must be in separate groups');
    });

    it('a 10-bar recording does not join a 2-bar group', () => {
      let clips: PlaylistClip[] = [];
      
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 2 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId1 = clips[0].takeGroupId!;
      
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 0, lengthBars: 10 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, undefined, '10-bar recording must NOT join 2-bar group');
      
      clips = addTakeToProjectClips(clips, rec2, group);
      assert.notEqual(clips[1].takeGroupId, groupId1, 'must be in separate groups');
    });
  });

  describe('False match cannot silently make unrelated clip inaudible', () => {
    it('unrelated recordings remain audible even when nearby', () => {
      let clips: PlaylistClip[] = [];
      
      // First recording: a 4-bar phrase at bar 0
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 4, audioBufferId: 'buf-1' });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      
      // Second recording: a different phrase at bar 0.5 (close but distinct)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 0.5, lengthBars: 4, audioBufferId: 'buf-2' });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      clips = addTakeToProjectClips(clips, rec2, group);
      
      // Both recordings must be audible (in separate groups)
      const inaudible = resolveInaudibleTakeClipIds(clips);
      assert.equal(inaudible.size, 0, 'neither recording should be silenced');
      assert.equal(isTakeAudible(clips[0], clips), true, 'first recording must be audible');
      assert.equal(isTakeAudible(clips[1], clips), true, 'second recording must be audible');
    });

    it('adding a new recording never silences an existing independent group', () => {
      let clips: PlaylistClip[] = [];
      
      // Create a take group at bar 0
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 4, audioBufferId: 'buf-1' });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId1 = clips[0].takeGroupId!;
      
      // Add a second take to the same group
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 0, lengthBars: 4, audioBufferId: 'buf-2' });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      clips = addTakeToProjectClips(clips, rec2, group);
      
      // Now add a completely different recording at bar 10
      const rec3 = makeClip({ id: 'rec-3', trackIndex: 0, startBar: 10, lengthBars: 4, audioBufferId: 'buf-3' });
      group = findMatchingTakeGroup(clips, rec3.trackIndex, rec3.startBar, rec3.lengthBars);
      clips = addTakeToProjectClips(clips, rec3, group);
      
      // The existing group must remain intact and unaffected
      assert.equal(clips[2].takeGroupId !== groupId1, true, 'new recording must be in its own group');
      
      // The existing group's active take (rec-2) must still be audible
      assert.equal(isTakeAudible(clips[1], clips), true, 'existing active take must remain audible');
      
      // The new recording must also be audible (it's the only take in its group)
      assert.equal(isTakeAudible(clips[2], clips), true, 'new recording must be audible');
    });
  });

  describe('Existing take groups remain independent', () => {
    it('multiple groups at different positions coexist without interference', () => {
      let clips: PlaylistClip[] = [];
      
      // Group 1 at bar 0
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 4 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId1 = clips[0].takeGroupId!;
      
      // Group 2 at bar 8
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 8, lengthBars: 4 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      clips = addTakeToProjectClips(clips, rec2, group);
      const groupId2 = clips[1].takeGroupId!;
      
      // Group 3 at bar 16
      const rec3 = makeClip({ id: 'rec-3', trackIndex: 0, startBar: 16, lengthBars: 4 });
      group = findMatchingTakeGroup(clips, rec3.trackIndex, rec3.startBar, rec3.lengthBars);
      clips = addTakeToProjectClips(clips, rec3, group);
      const groupId3 = clips[2].takeGroupId!;
      
      // All groups must be independent
      assert.notEqual(groupId1, groupId2, 'groups at different positions must be independent');
      assert.notEqual(groupId2, groupId3, 'groups at different positions must be independent');
      assert.notEqual(groupId1, groupId3, 'groups at different positions must be independent');
      
      // All recordings must be audible (each is the only take in its group)
      const inaudible = resolveInaudibleTakeClipIds(clips);
      assert.equal(inaudible.size, 0, 'all recordings must be audible');
    });

    it('adding a take to one group does not affect other groups', () => {
      let clips: PlaylistClip[] = [];
      
      // Create group 1 at bar 0
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 4 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId1 = clips[0].takeGroupId!;
      
      // Create group 2 at bar 8
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 8, lengthBars: 4 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      clips = addTakeToProjectClips(clips, rec2, group);
      const groupId2 = clips[1].takeGroupId!;
      
      // Add a second take to group 1
      const rec3 = makeClip({ id: 'rec-3', trackIndex: 0, startBar: 0, lengthBars: 4 });
      group = findMatchingTakeGroup(clips, rec3.trackIndex, rec3.startBar, rec3.lengthBars);
      assert.equal(group, groupId1, 'should match group 1');
      clips = addTakeToProjectClips(clips, rec3, group);
      
      // Group 2 must remain unaffected
      assert.equal(clips[1].takeGroupId, groupId2, 'group 2 must remain intact');
      assert.equal(clips[1].activeTakeIndex, 0, 'group 2 active take must remain 0');
      
      // Group 1 should now have 2 takes
      const group1Clips = clips.filter(c => c.takeGroupId === groupId1);
      assert.equal(group1Clips.length, 2, 'group 1 should have 2 takes');
    });
  });

  describe('Phase 1L punch-recording behavior remains intact', () => {
    it('punch recordings with identical geometry join correctly', () => {
      let clips: PlaylistClip[] = [];
      
      // First punch take: exact geometry from punch plan
      const punchStartBar = 4.333;
      const punchLengthBars = 2.667;
      
      const rec1 = makeClip({ 
        id: 'punch-1', 
        trackIndex: 0, 
        startBar: punchStartBar, 
        lengthBars: punchLengthBars,
        audioBufferId: 'punch-buf-1'
      });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId = clips[0].takeGroupId!;
      
      // Second punch take: same geometry (from same punch plan)
      const rec2 = makeClip({ 
        id: 'punch-2', 
        trackIndex: 0, 
        startBar: punchStartBar, 
        lengthBars: punchLengthBars,
        audioBufferId: 'punch-buf-2'
      });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, groupId, 'punch takes with identical geometry should join');
      
      clips = addTakeToProjectClips(clips, rec2, group);
      assert.equal(clips.length, 2, 'should have 2 takes');
      assert.equal(clips[1].takeGroupId, groupId, 'second punch take should join the group');
    });

    it('punch recordings at different positions remain separate', () => {
      let clips: PlaylistClip[] = [];
      
      // Punch take at bar 4.333
      const rec1 = makeClip({ 
        id: 'punch-1', 
        trackIndex: 0, 
        startBar: 4.333, 
        lengthBars: 2.667,
        audioBufferId: 'punch-buf-1'
      });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId1 = clips[0].takeGroupId!;
      
      // Punch take at bar 12.5 (different punch position)
      const rec2 = makeClip({ 
        id: 'punch-2', 
        trackIndex: 0, 
        startBar: 12.5, 
        lengthBars: 2.667,
        audioBufferId: 'punch-buf-2'
      });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, undefined, 'punch takes at different positions must NOT join');
      
      clips = addTakeToProjectClips(clips, rec2, group);
      assert.notEqual(clips[1].takeGroupId, groupId1, 'must be in separate groups');
    });
  });
});

// --- Phase 1M: validateTakeGroup tolerance boundary tests ----------------------
// These tests verify that validateTakeGroup uses the same tolerances as
// findMatchingTakeGroup, so groups formed by matching are always valid.

describe('Phase 1M: validateTakeGroup Tolerance Boundaries', () => {
  describe('Groups within tolerance are valid', () => {
    it('exact match is valid', () => {
      const clips: PlaylistClip[] = [
        makeClip({ id: 'take-0', trackIndex: 0, startBar: 4.0, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 0 }),
        makeClip({ id: 'take-1', trackIndex: 0, startBar: 4.0, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 1 }),
      ];
      const result = validateTakeGroup(clips, 'g1');
      assert.equal(result.valid, true, 'exact match should be valid');
      assert.equal(result.issues.length, 0, 'no issues expected');
    });

    it('startBar within 0.1 bars is valid', () => {
      const clips: PlaylistClip[] = [
        makeClip({ id: 'take-0', trackIndex: 0, startBar: 4.0, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 0 }),
        makeClip({ id: 'take-1', trackIndex: 0, startBar: 4.05, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 1 }),
      ];
      const result = validateTakeGroup(clips, 'g1');
      assert.equal(result.valid, true, 'startBar difference of 0.05 should be valid (within 0.1 tolerance)');
      assert.equal(result.issues.length, 0, 'no issues expected');
    });

    it('startBar at exactly 0.1 bars is valid', () => {
      const clips: PlaylistClip[] = [
        makeClip({ id: 'take-0', trackIndex: 0, startBar: 4.0, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 0 }),
        makeClip({ id: 'take-1', trackIndex: 0, startBar: 4.1, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 1 }),
      ];
      const result = validateTakeGroup(clips, 'g1');
      assert.equal(result.valid, true, 'startBar difference of exactly 0.1 should be valid (boundary)');
      assert.equal(result.issues.length, 0, 'no issues expected');
    });

    it('lengthBars within 1 bar is valid', () => {
      const clips: PlaylistClip[] = [
        makeClip({ id: 'take-0', trackIndex: 0, startBar: 4.0, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 0 }),
        makeClip({ id: 'take-1', trackIndex: 0, startBar: 4.0, lengthBars: 2.5, takeGroupId: 'g1', takeIndex: 1 }),
      ];
      const result = validateTakeGroup(clips, 'g1');
      assert.equal(result.valid, true, 'lengthBars difference of 0.5 should be valid (within 1.0 tolerance)');
      assert.equal(result.issues.length, 0, 'no issues expected');
    });

    it('lengthBars at exactly 1 bar is valid', () => {
      const clips: PlaylistClip[] = [
        makeClip({ id: 'take-0', trackIndex: 0, startBar: 4.0, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 0 }),
        makeClip({ id: 'take-1', trackIndex: 0, startBar: 4.0, lengthBars: 3.0, takeGroupId: 'g1', takeIndex: 1 }),
      ];
      const result = validateTakeGroup(clips, 'g1');
      assert.equal(result.valid, true, 'lengthBars difference of exactly 1.0 should be valid (boundary)');
      assert.equal(result.issues.length, 0, 'no issues expected');
    });

    it('combined startBar and lengthBars within tolerance is valid', () => {
      const clips: PlaylistClip[] = [
        makeClip({ id: 'take-0', trackIndex: 0, startBar: 4.0, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 0 }),
        makeClip({ id: 'take-1', trackIndex: 0, startBar: 4.08, lengthBars: 2.8, takeGroupId: 'g1', takeIndex: 1 }),
      ];
      const result = validateTakeGroup(clips, 'g1');
      assert.equal(result.valid, true, 'both startBar (0.08) and lengthBars (0.8) within tolerance should be valid');
      assert.equal(result.issues.length, 0, 'no issues expected');
    });
  });

  describe('Groups outside tolerance are invalid', () => {
    it('startBar difference > 0.1 bars is invalid', () => {
      const clips: PlaylistClip[] = [
        makeClip({ id: 'take-0', trackIndex: 0, startBar: 4.0, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 0 }),
        makeClip({ id: 'take-1', trackIndex: 0, startBar: 4.11, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 1 }),
      ];
      const result = validateTakeGroup(clips, 'g1');
      assert.equal(result.valid, false, 'startBar difference of 0.11 should be invalid');
      assert.ok(result.issues.some(i => i.includes('start positions')), 'should report start position issue');
    });

    it('lengthBars difference > 1 bar is invalid', () => {
      const clips: PlaylistClip[] = [
        makeClip({ id: 'take-0', trackIndex: 0, startBar: 4.0, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 0 }),
        makeClip({ id: 'take-1', trackIndex: 0, startBar: 4.0, lengthBars: 3.1, takeGroupId: 'g1', takeIndex: 1 }),
      ];
      const result = validateTakeGroup(clips, 'g1');
      assert.equal(result.valid, false, 'lengthBars difference of 1.1 should be invalid');
      assert.ok(result.issues.some(i => i.includes('lengths')), 'should report length issue');
    });

    it('different trackIndex is invalid', () => {
      const clips: PlaylistClip[] = [
        makeClip({ id: 'take-0', trackIndex: 0, startBar: 4.0, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 0 }),
        makeClip({ id: 'take-1', trackIndex: 1, startBar: 4.0, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 1 }),
      ];
      const result = validateTakeGroup(clips, 'g1');
      assert.equal(result.valid, false, 'different trackIndex should be invalid');
      assert.ok(result.issues.some(i => i.includes('different tracks')), 'should report track issue');
    });

    it('combined startBar and lengthBars outside tolerance is invalid', () => {
      const clips: PlaylistClip[] = [
        makeClip({ id: 'take-0', trackIndex: 0, startBar: 4.0, lengthBars: 2.0, takeGroupId: 'g1', takeIndex: 0 }),
        makeClip({ id: 'take-1', trackIndex: 0, startBar: 4.2, lengthBars: 3.5, takeGroupId: 'g1', takeIndex: 1 }),
      ];
      const result = validateTakeGroup(clips, 'g1');
      assert.equal(result.valid, false, 'both startBar (0.2) and lengthBars (1.5) outside tolerance should be invalid');
      assert.ok(result.issues.some(i => i.includes('start positions')), 'should report start position issue');
      assert.ok(result.issues.some(i => i.includes('lengths')), 'should report length issue');
    });
  });

  describe('Groups formed by findMatchingTakeGroup are always valid', () => {
    it('grouped recordings pass validation', () => {
      let clips: PlaylistClip[] = [];
      
      // First recording creates a group
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 4.0, lengthBars: 2.0, audioBufferId: 'buf-1' });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      
      // Second recording within tolerance joins the group
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 4.05, lengthBars: 2.5, audioBufferId: 'buf-2' });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      clips = addTakeToProjectClips(clips, rec2, group);
      
      // Validate the group
      const groupId = clips[0].takeGroupId!;
      const result = validateTakeGroup(clips, groupId);
      assert.equal(result.valid, true, 'group formed by findMatchingTakeGroup should be valid');
      assert.equal(result.issues.length, 0, 'no issues expected');
    });

    it('punch recordings within tolerance pass validation', () => {
      let clips: PlaylistClip[] = [];
      
      // First punch recording
      const rec1 = makeClip({ id: 'punch-1', trackIndex: 0, startBar: 4.333, lengthBars: 2.667, audioBufferId: 'buf-1' });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      
      // Second punch recording with tiny floating-point difference
      const rec2 = makeClip({ id: 'punch-2', trackIndex: 0, startBar: 4.340, lengthBars: 2.670, audioBufferId: 'buf-2' });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      clips = addTakeToProjectClips(clips, rec2, group);
      
      // Validate the group
      const groupId = clips[0].takeGroupId!;
      const result = validateTakeGroup(clips, groupId);
      assert.equal(result.valid, true, 'punch group within tolerance should be valid');
      assert.equal(result.issues.length, 0, 'no issues expected');
    });
  });
});
