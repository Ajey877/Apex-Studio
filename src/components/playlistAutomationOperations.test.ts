import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import type { PlaylistClip, Channel, MixerTrack } from '../types/daw';
import {
  addPlaylistAutomationPoint,
  movePlaylistAutomationPoint,
  deletePlaylistAutomationPoint,
  updatePlaylistAutomationTarget,
  updatePlaylistAutomationPoint
} from './playlistClipOperations';
import { createHistory } from '../state/projectHistory';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { audioEngine } from '../audio/audioEngine';

const createBaseAutoClip = (points = [
  { x: 0, y: 0.2, tension: 0 },
  { x: 0.5, y: 0.8, tension: 0 },
  { x: 1, y: 0.4, tension: 0 }
]): PlaylistClip => ({
  id: 'auto-clip-1',
  trackIndex: 2,
  startBar: 0,
  lengthBars: 4,
  type: 'automation',
  color: '#00e5ff',
  name: 'Auto: Filter Cutoff',
  automationTarget: {
    type: 'channel_filter_cutoff',
    targetId: 'ch-synth-1',
    label: 'Synth - Filter Cutoff'
  },
  automationPoints: points
});

describe('Phase 6.1 Automation Point Operations', () => {
  test('addPlaylistAutomationPoint inserts point in sorted order', () => {
    const clip = createBaseAutoClip([
      { x: 0, y: 0.1, tension: 0 },
      { x: 1, y: 0.9, tension: 0 }
    ]);

    const { clip: updated, pointIndex } = addPlaylistAutomationPoint(clip, 0.4, 0.6);
    assert.equal(updated.automationPoints?.length, 3);
    assert.equal(pointIndex, 1);
    assert.deepEqual(updated.automationPoints?.[1], { x: 0.4, y: 0.6, tension: 0 });
    assert.equal(updated.automationPoints?.[0].x, 0);
    assert.equal(updated.automationPoints?.[2].x, 1);
  });

  test('addPlaylistAutomationPoint clamps coordinates to [0, 1]', () => {
    const clip = createBaseAutoClip([
      { x: 0, y: 0.2, tension: 0 },
      { x: 1, y: 0.8, tension: 0 }
    ]);

    const { clip: updated1 } = addPlaylistAutomationPoint(clip, -0.5, 1.5);
    // Near x=0 updates existing point at x=0
    assert.equal(updated1.automationPoints?.[0].y, 1);

    const { clip: updated2 } = addPlaylistAutomationPoint(clip, 0.7, -0.2);
    assert.equal(updated2.automationPoints?.[1].y, 0);
  });

  test('addPlaylistAutomationPoint updates existing point within duplicate threshold', () => {
    const clip = createBaseAutoClip([
      { x: 0, y: 0.2, tension: 0 },
      { x: 0.5, y: 0.5, tension: 0 },
      { x: 1, y: 0.8, tension: 0 }
    ]);

    // Inserting at 0.502 (within 0.005 of 0.5) updates point instead of adding duplicate
    const { clip: updated, pointIndex } = addPlaylistAutomationPoint(clip, 0.502, 0.95);
    assert.equal(updated.automationPoints?.length, 3);
    assert.equal(pointIndex, 1);
    assert.equal(updated.automationPoints?.[1].y, 0.95);
  });

  test('addPlaylistAutomationPoint rejects non-automation clips or non-finite inputs', () => {
    const patternClip: PlaylistClip = {
      id: 'pat-1',
      trackIndex: 0,
      startBar: 0,
      lengthBars: 4,
      type: 'pattern',
      color: '#fff',
      name: 'Pattern 1'
    };

    assert.throws(() => addPlaylistAutomationPoint(patternClip, 0.5, 0.5), /automation clip/);
    assert.throws(() => addPlaylistAutomationPoint(createBaseAutoClip(), Number.NaN, 0.5), /finite/);
  });

  test('movePlaylistAutomationPoint updates both X and Y with boundary clamping', () => {
    const clip = createBaseAutoClip();
    const { clip: updated, nextIndex } = movePlaylistAutomationPoint(clip, 1, 0.6, 0.3);

    assert.equal(nextIndex, 1);
    assert.equal(updated.automationPoints?.[1].x, 0.6);
    assert.equal(updated.automationPoints?.[1].y, 0.3);

    // Clamping outside bounds
    const { clip: clamped, nextIndex: clampedIdx } = movePlaylistAutomationPoint(clip, 1, 1.5, -0.2);
    assert.equal(clamped.automationPoints?.[clampedIdx].x, 1);
    assert.equal(clamped.automationPoints?.[clampedIdx].y, 0);
  });

  test('movePlaylistAutomationPoint snaps X to grid subdivisions when requested', () => {
    const clip = createBaseAutoClip();
    // 4 bars * 4 steps per bar = 16 steps total
    const { clip: snapped } = movePlaylistAutomationPoint(clip, 1, 0.52, 0.5, 16);
    // 0.52 * 16 = 8.32 -> rounds to 8/16 = 0.5
    assert.equal(snapped.automationPoints?.[1].x, 0.5);

    const { clip: snapped2 } = movePlaylistAutomationPoint(clip, 1, 0.58, 0.5, 16);
    // 0.58 * 16 = 9.28 -> rounds to 9/16 = 0.5625
    assert.equal(snapped2.automationPoints?.[1].x, 0.5625);
  });

  test('movePlaylistAutomationPoint re-sorts array and returns new index when moving across peers', () => {
    const clip = createBaseAutoClip([
      { x: 0, y: 0.1, tension: 0 },
      { x: 0.3, y: 0.5, tension: 0 },
      { x: 0.7, y: 0.6, tension: 0 },
      { x: 1, y: 0.9, tension: 0 }
    ]);

    // Move point 1 (was x=0.3) past point 2 to x=0.85
    const { clip: moved, nextIndex } = movePlaylistAutomationPoint(clip, 1, 0.85, 0.75);
    assert.equal(nextIndex, 2);
    assert.equal(moved.automationPoints?.[2].x, 0.85);
    assert.equal(moved.automationPoints?.[1].x, 0.7);
  });

  test('deletePlaylistAutomationPoint removes point and retains minimum two points', () => {
    const clip = createBaseAutoClip([
      { x: 0, y: 0.1, tension: 0 },
      { x: 0.5, y: 0.5, tension: 0 },
      { x: 1, y: 0.9, tension: 0 }
    ]);

    const updated = deletePlaylistAutomationPoint(clip, 1);
    assert.equal(updated.automationPoints?.length, 2);
    assert.equal(updated.automationPoints?.[0].x, 0);
    assert.equal(updated.automationPoints?.[1].x, 1);

    // Deleting when only 2 points remain throws to preserve lane integrity
    assert.throws(() => deletePlaylistAutomationPoint(updated, 0), /at least two/);
  });

  test('updatePlaylistAutomationTarget binds to channel, mixer, or master without fallback', () => {
    const clip = createBaseAutoClip();

    // Channel volume binding
    const chBound = updatePlaylistAutomationTarget(clip, {
      type: 'channel_vol',
      targetId: 'ch-lead-2',
      label: 'Lead 2 - Volume'
    });
    assert.equal(chBound.automationTarget?.type, 'channel_vol');
    assert.equal(chBound.automationTarget?.targetId, 'ch-lead-2');
    assert.equal(chBound.name, 'Auto: Lead 2 - Volume');

    // Mixer volume binding
    const mixerBound = updatePlaylistAutomationTarget(clip, {
      type: 'mixer_vol',
      targetId: 3,
      label: 'Insert 3 - Volume'
    });
    assert.equal(mixerBound.automationTarget?.type, 'mixer_vol');
    assert.equal(mixerBound.automationTarget?.targetId, 3);
    assert.equal(mixerBound.name, 'Auto: Insert 3 - Volume');

    // Master volume binding
    const masterBound = updatePlaylistAutomationTarget(clip, {
      type: 'master_vol',
      targetId: 0,
      label: 'Master Out'
    });
    assert.equal(masterBound.automationTarget?.type, 'master_vol');
    assert.equal(masterBound.automationTarget?.targetId, 0);
    assert.equal(masterBound.name, 'Auto: Master Out');
  });

  test('automation operations participate in project undo / redo history', () => {
    const initialState = createDefaultProjectState();
    const clip = createBaseAutoClip([
      { x: 0, y: 0.2, tension: 0 },
      { x: 1, y: 0.8, tension: 0 }
    ]);
    initialState.playlistClips = [clip];

    let history = createHistory(initialState);

    // 1. Add point
    const { clip: withAdded } = addPlaylistAutomationPoint(clip, 0.5, 0.9);
    history = history.commit({ ...initialState, playlistClips: [withAdded] }, 'Add automation node');
    assert.equal(history.present.playlistClips[0].automationPoints?.length, 3);

    // 2. Move point
    const { clip: withMoved } = movePlaylistAutomationPoint(withAdded, 1, 0.6, 0.4);
    history = history.commit({ ...initialState, playlistClips: [withMoved] }, 'Move automation node');
    assert.equal(history.present.playlistClips[0].automationPoints?.[1].x, 0.6);

    // 3. Undo move
    history = history.undo();
    assert.equal(history.present.playlistClips[0].automationPoints?.[1].x, 0.5);

    // 4. Undo add
    history = history.undo();
    assert.equal(history.present.playlistClips[0].automationPoints?.length, 2);

    // 5. Redo add
    history = history.redo();
    assert.equal(history.present.playlistClips[0].automationPoints?.length, 3);
  });

  test('automation clips and points survive project normalization and serialization', () => {
    const state = createDefaultProjectState();
    const clip = createBaseAutoClip();
    state.playlistClips = [clip];

    const normalized = normalizeProjectState(state);
    assert.equal(normalized.playlistClips.length, 1);
    const restoredClip = normalized.playlistClips[0];
    assert.equal(restoredClip.type, 'automation');
    assert.equal(restoredClip.automationPoints?.length, 3);
    assert.equal(restoredClip.automationTarget?.type, 'channel_filter_cutoff');
    assert.equal(restoredClip.automationTarget?.targetId, 'ch-synth-1');

    // JSON round trip
    const serialized = JSON.parse(JSON.stringify(normalized));
    const reNormalized = normalizeProjectState(serialized);
    assert.deepEqual(reNormalized.playlistClips[0].automationPoints, clip.automationPoints);
  });

  test('audioEngine evaluates and applies automation values accurately', () => {
    const points = [
      { x: 0, y: 0.2 },
      { x: 0.5, y: 0.8 },
      { x: 1, y: 0.4 }
    ];

    // Curve interpolation
    assert.equal(audioEngine.interpolateAutomationCurve(points, 0), 0.2);
    assert.equal(audioEngine.interpolateAutomationCurve(points, 0.5), 0.8);
    assert.equal(audioEngine.interpolateAutomationCurve(points, 1), 0.4);
    // Midway between 0 and 0.5: linear value is 0.5
    assert.equal(Number(audioEngine.interpolateAutomationCurve(points, 0.25).toFixed(4)), 0.5);

    // Target application: Channel Volume
    const mockChannel: Channel = {
      id: 'ch-test-1',
      name: 'Test Synth',
      color: '#ff6e00',
      instrumentType: 'minisynth',
      mixerTrackId: 1,
      volume: 0.8,
      pan: 0,
      pitch: 0,
      mute: false,
      solo: false,
      steps: [],
      notes: [],
      synthParams: {
        osc1Type: 'sawtooth',
        osc1Octave: 0,
        osc1Detune: 0,
        osc1Mix: 1,
        osc2Type: 'square',
        osc2Octave: 0,
        osc2Detune: 0,
        osc2Mix: 0,
        filterType: 'lowpass',
        filterCutoff: 1000,
        filterResonance: 1,
        filterEnvAmount: 0,
        attack: 0.01,
        decay: 0.1,
        sustain: 1,
        release: 0.1,
        lfoRate: 1,
        lfoDepth: 0,
        lfoTarget: 'none',
        fmCarrierMultiplier: 1,
        fmModulatorMultiplier: 1,
        fmModulationIndex: 0,
        fmFeedback: 0,
        sampleRootNote: 60,
        sampleGlide: 0,
        sampleReverse: false,
        sampleLoop: false,
        sampleDrive: 0
      }
    };

    audioEngine.applyAutomationValue(
      { type: 'channel_vol', targetId: 'ch-test-1' },
      0.35,
      [mockChannel],
      [],
      0
    );
    assert.equal(mockChannel.volume, 0.35);

    // Channel Filter Cutoff
    audioEngine.applyAutomationValue(
      { type: 'channel_filter_cutoff', targetId: 'ch-test-1' },
      0.5,
      [mockChannel],
      [],
      0
    );
    // 40 + (0.5^2) * 18000 = 40 + 0.25 * 18000 = 4540
    assert.equal(mockChannel.synthParams.filterCutoff, 4540);

    // Mixer Volume
    const mockMixerTrack: MixerTrack = {
      id: 2,
      name: 'Insert 2',
      color: '#fff',
      volume: 1.0,
      pan: 0,
      mute: false,
      solo: false,
      stereoWidth: 1,
      peakL: 0,
      peakR: 0,
      fxSlots: []
    };

    audioEngine.applyAutomationValue(
      { type: 'mixer_vol', targetId: 2 },
      0.6,
      [],
      [mockMixerTrack],
      0
    );
    assert.equal(mockMixerTrack.volume, 0.6 * 1.25);
  });
});
