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

    it('recordings within 0.5 bars still join (tolerance)', () => {
      let clips: PlaylistClip[] = [];
      
      // First recording at bar 4.0
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 4.0, lengthBars: 2 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId = clips[0].takeGroupId!;
      
      // Second recording at bar 4.3 (within tolerance)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 4.3, lengthBars: 2 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, groupId, 'recording within tolerance should match');
    });

    it('recordings beyond 0.5 bars do not join', () => {
      let clips: PlaylistClip[] = [];
      
      // First recording at bar 4.0
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 4.0, lengthBars: 2 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId = clips[0].takeGroupId!;
      
      // Second recording at bar 4.6 (beyond tolerance)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 4.6, lengthBars: 2 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, undefined, 'recording beyond tolerance should not match');
    });
  });

  describe('Recordings with different lengths', () => {
    it('recordings with similar lengths (within 50%) join', () => {
      let clips: PlaylistClip[] = [];
      
      // First recording with length 2
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 2 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId = clips[0].takeGroupId!;
      
      // Second recording with length 2.5 (within 50%)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 0, lengthBars: 2.5 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, groupId, 'recording with similar length should match');
    });

    it('recordings with very different lengths do not join', () => {
      let clips: PlaylistClip[] = [];
      
      // First recording with length 2
      const rec1 = makeClip({ id: 'rec-1', trackIndex: 0, startBar: 0, lengthBars: 2 });
      let group = findMatchingTakeGroup(clips, rec1.trackIndex, rec1.startBar, rec1.lengthBars);
      clips = addTakeToProjectClips(clips, rec1, group);
      const groupId = clips[0].takeGroupId!;
      
      // Second recording with length 4 (100% different, beyond tolerance)
      const rec2 = makeClip({ id: 'rec-2', trackIndex: 0, startBar: 0, lengthBars: 4 });
      group = findMatchingTakeGroup(clips, rec2.trackIndex, rec2.startBar, rec2.lengthBars);
      assert.equal(group, undefined, 'recording with very different length should not match');
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
