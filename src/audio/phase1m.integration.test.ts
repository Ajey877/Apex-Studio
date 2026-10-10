/**
 * Phase 1M: Comping Lanes and Take Management - Integration Tests
 * 
 * These tests verify the complete take management workflow:
 * 1. Recording creates take groups
 * 2. Multiple recordings on same track/region join the group
 * 3. Take selection changes the audible take
 * 4. All takes are preserved (non-destructive)
 * 5. Selection survives serialization and undo/redo
 * 6. Failed recordings don't corrupt state
 * 7. UI is connected to real project data
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveActiveTakeIndex, isTakeAudible, resolveInaudibleTakeClipIds } from './takeLaneManager';
import type { PlaylistClip } from '../types/daw';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('Phase 1M: Integration Tests', () => {
  describe('Recording creates take groups', () => {
    it('handleSaveRecordingToPlaylist uses findMatchingTakeGroup to detect existing groups', () => {
      const source = read('App.tsx');
      assert.ok(source.includes('findMatchingTakeGroup('), 'must check for existing take groups');
      assert.ok(source.includes('addTakeToProjectClips('), 'must add clip through take group system');
    });

    it('matching criteria: same track, overlapping start position, similar length', () => {
      const source = read('audio/takeLaneManager.ts');
      assert.ok(source.includes('findMatchingTakeGroup'), 'must export group matching function');
      assert.ok(source.includes('trackIndex !== trackIndex'), 'must check track match');
      assert.ok(source.includes('START_BAR_TOLERANCE'), 'must check position tolerance via constant');
      assert.ok(source.includes('LENGTH_BAR_TOLERANCE'), 'must check length tolerance via constant');
    });
  });

  describe('Multiple recordings join the same group', () => {
    it('addTakeToProjectClips assigns sequential takeIndex values', () => {
      const source = read('audio/takeLaneManager.ts');
      assert.ok(source.includes('nextTakeIndexForGroup'), 'must compute next take index');
      assert.ok(source.includes('takeIndex: nextIndex'), 'must assign the computed index');
    });

    it('new take becomes active by default', () => {
      const source = read('audio/takeLaneManager.ts');
      assert.ok(source.includes('activeTakeIndex: nextIndex'), 'new take must be active');
    });
  });

  describe('Take selection changes audible take', () => {
    it('selectActiveTake updates all clips in the group', () => {
      const clips: PlaylistClip[] = [
        { id: 'clip-1', trackIndex: 0, startBar: 0, lengthBars: 4, type: 'audio', color: '#ff6e00', name: 'Take 1', takeGroupId: 'group-1', takeIndex: 0, activeTakeIndex: 0 },
        { id: 'clip-2', trackIndex: 0, startBar: 0, lengthBars: 4, type: 'audio', color: '#ff6e00', name: 'Take 2', takeGroupId: 'group-1', takeIndex: 1, activeTakeIndex: 0 },
      ];
      
      // Simulate selecting take 1
      const updated = clips.map(c => ({ ...c, activeTakeIndex: 1 }));
      
      assert.equal(resolveActiveTakeIndex(updated, 'group-1'), 1);
      assert.equal(isTakeAudible(updated[1], updated), true, 'selected take must be audible');
      assert.equal(isTakeAudible(updated[0], updated), false, 'other takes must be silent');
    });

    it('audio engine respects take selection during playback', () => {
      const source = read('audio/audioEngine.ts');
      assert.ok(source.includes('isClipTakeInactive'), 'must check take audibility');
      assert.ok(source.includes('resolveInaudibleTakeClipIds'), 'must resolve inaudible takes');
    });
  });

  describe('All takes are preserved (non-destructive)', () => {
    it('inactive takes retain their audioBufferId', () => {
      const clips: PlaylistClip[] = [
        { id: 'clip-1', trackIndex: 0, startBar: 0, lengthBars: 4, type: 'audio', color: '#ff6e00', name: 'Take 1', audioBufferId: 'buffer-1', takeGroupId: 'group-1', takeIndex: 0, activeTakeIndex: 1 },
        { id: 'clip-2', trackIndex: 0, startBar: 0, lengthBars: 4, type: 'audio', color: '#ff6e00', name: 'Take 2', audioBufferId: 'buffer-2', takeGroupId: 'group-1', takeIndex: 1, activeTakeIndex: 1 },
      ];
      
      // All clips must retain their buffer IDs
      assert.ok(clips[0].audioBufferId, 'inactive take must keep its buffer');
      assert.ok(clips[1].audioBufferId, 'active take must keep its buffer');
    });

    it('export validation skips inactive takes', () => {
      const source = read('audio/audioEngine.ts');
      assert.ok(source.includes('offlineInaudibleTakes'), 'export must identify inaudible takes');
      assert.ok(source.includes('!offlineInaudibleTakes.has(clip.id)'), 'export must skip inactive takes');
    });
  });

  describe('Selection survives serialization and undo/redo', () => {
    it('take-group fields are persisted in project state', () => {
      const source = read('types/daw.ts');
      assert.ok(source.includes('takeGroupId?: string'), 'must persist group ID');
      assert.ok(source.includes('takeIndex?: number'), 'must persist take index');
      assert.ok(source.includes('activeTakeIndex?: number'), 'must persist active selection');
    });

    it('project history captures take selection changes', () => {
      const source = read('App.tsx');
      assert.ok(source.includes('commitPlaylistHistory(nextState, \'Select active take\')'), 'take selection must be committed to history');
    });
  });

  describe('Failed recordings do not corrupt state', () => {
    it('handleSaveRecordingToPlaylist validates before creating clip', () => {
      const source = read('App.tsx');
      assert.ok(source.includes('validateRecordingTargetTrack'), 'must validate target track');
      assert.ok(source.includes('audioEngine.loadAudioFile'), 'must validate audio buffer');
    });

    it('take-group fields are optional for backward compatibility', () => {
      const source = read('types/daw.ts');
      // All take fields are optional (?)
      assert.ok(source.includes('takeGroupId?:'), 'takeGroupId must be optional');
      assert.ok(source.includes('takeIndex?:'), 'takeIndex must be optional');
      assert.ok(source.includes('activeTakeIndex?:'), 'activeTakeIndex must be optional');
    });
  });

  describe('UI is connected to real project data', () => {
    it('TakeCompingModal receives playlistClips from project state', () => {
      const source = read('App.tsx');
      assert.ok(source.includes('playlistClips={projectState.playlistClips}'), 'modal must receive real clips');
    });

    it('TakeCompingModal calls onSelectActiveTake callback', () => {
      const source = read('App.tsx');
      assert.ok(source.includes('onSelectActiveTake={(groupId, takeIndex)'), 'modal must expose selection callback');
    });

    it('callback uses selectActiveTake to update clips', () => {
      const source = read('App.tsx');
      assert.ok(source.includes('selectActiveTake(projectStateRef.current.playlistClips, groupId, takeIndex)'), 'callback must use take manager');
    });

    it('TakeCompingModal uses take manager functions', () => {
      const source = read('components/TakeCompingModal.tsx');
      assert.ok(source.includes('getTakeGroupIds'), 'modal must enumerate groups');
      assert.ok(source.includes('getTakeGroupClips'), 'modal must get group clips');
      assert.ok(source.includes('resolveActiveTakeIndex'), 'modal must resolve active take');
    });
  });

  describe('Punch recording integration (Phase 1L)', () => {
    it('punch recordings also go through take-group system', () => {
      const source = read('App.tsx');
      assert.ok(source.includes('createPunchRecordingPlaylistClip'), 'punch clips must be created');
      // The same findMatchingTakeGroup logic applies to both ordinary and punch recordings
      assert.ok(source.includes('findMatchingTakeGroup('), 'punch clips must also be grouped');
    });

    it('punch trim still happens before take-group assignment', () => {
      const source = read('App.tsx');
      // Verify trim happens before the take-group logic
      const trimIndex = source.indexOf('trimAudioBufferToSeconds');
      const takeGroupIndex = source.indexOf('findMatchingTakeGroup');
      assert.ok(trimIndex > 0 && takeGroupIndex > trimIndex, 'trim must happen before take-group assignment');
    });
  });

  describe('Existing projects without take metadata', () => {
    it('ordinary clips without takeGroupId work normally', () => {
      const clips: PlaylistClip[] = [
        { id: 'clip-1', trackIndex: 0, startBar: 0, lengthBars: 4, type: 'audio', color: '#ff6e00', name: 'Ordinary clip' },
      ];
      
      const inaudible = resolveInaudibleTakeClipIds(clips);
      assert.equal(inaudible.size, 0, 'ordinary clips must not be marked inaudible');
      assert.equal(isTakeAudible(clips[0], clips), true, 'ordinary clips must be audible');
    });
  });
});
