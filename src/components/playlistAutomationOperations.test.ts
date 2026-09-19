import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import type { PlaylistClip, Channel, MixerTrack, AutomationPoint } from '../types/daw';
import {
  addPlaylistAutomationPoint,
  movePlaylistAutomationPoint,
  deletePlaylistAutomationPoint,
  updatePlaylistAutomationTarget,
  updatePlaylistAutomationPoint,
  nextSelectedPointIndex,
  findAutomationPointIndexNearX,
  resolveAddNodePosition,
  splitPlaylistClip,
  splitAutomationPoints,
  evaluateAutomationEnvelope,
  resizePlaylistClipLeft,
  resizePlaylistClipRight,
  duplicatePlaylistClip,
  validatePlaylistClip,
  DEFAULT_GRID_BARS
} from './playlistClipOperations';
import { createHistory } from '../state/projectHistory';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { serializeProjectState } from '../state/projectPersistence';
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

    // Y clamps outside [0, 1]
    const { clip: yClamped } = movePlaylistAutomationPoint(clip, 1, 0.6, -0.2);
    assert.equal(yClamped.automationPoints?.[1].x, 0.6);
    assert.equal(yClamped.automationPoints?.[1].y, 0);

    // Free movement near (but not onto) the endpoint still works
    const { clip: nearEdge } = movePlaylistAutomationPoint(clip, 1, 0.999, 0.5);
    assert.equal(nearEdge.automationPoints?.[1].x, 0.999);

    // X clamped to 1 collides with the endpoint at x=1: the X is rejected
    // (no coincident points / zero-width segments), the Y still applies.
    const { clip: xRejected, nextIndex: rejectedIdx } = movePlaylistAutomationPoint(clip, 1, 1.5, -0.2);
    assert.equal(rejectedIdx, 1);
    assert.equal(xRejected.automationPoints?.[1].x, 0.5);
    assert.equal(xRejected.automationPoints?.[1].y, 0);
    assert.equal(xRejected.automationPoints?.[2].x, 1);
  });

  test('movePlaylistAutomationPoint never produces coincident X after grid snapping', () => {
    const clip = createBaseAutoClip([
      { x: 0, y: 0.1, tension: 0 },
      { x: 0.5, y: 0.5, tension: 0 },
      { x: 0.5625, y: 0.9, tension: 0 },
      { x: 1, y: 0.2, tension: 0 }
    ]);

    // Requested snap step 8 (x=0.5) is occupied by point 1: nearest free step
    // search engages. Steps 7 (0.4375) and 9 (0.5625) are both 1 step away and
    // free; the tie deterministically resolves to the lower step.
    const { clip: moved, nextIndex } = movePlaylistAutomationPoint(clip, 2, 0.51, 0.4, 16);
    const xs = moved.automationPoints!.map(p => p.x);
    assert.deepEqual(xs, [0, 0.4375, 0.5, 1]);
    assert.equal(nextIndex, 1);
    assert.equal(moved.automationPoints?.[1].y, 0.4);

    // Unsnapped drop exactly onto another point's X is rejected as well.
    const { clip: unsnapped } = movePlaylistAutomationPoint(clip, 2, 0.5, 0.7);
    assert.equal(unsnapped.automationPoints?.[2].x, 0.5625);
    assert.equal(unsnapped.automationPoints?.[2].y, 0.7);

    // Envelope has no zero-width segments after every operation.
    const sorted = [...unsnapped.automationPoints!].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i].x - sorted[i - 1].x > 0, 'point X values must be strictly increasing');
    }
  });

  test('movePlaylistAutomationPoint keeps snapped moves working near occupied steps', () => {
    const clip = createBaseAutoClip([
      { x: 0, y: 0.1, tension: 0 },
      { x: 0.3, y: 0.5, tension: 0 },
      { x: 0.7, y: 0.6, tension: 0 },
      { x: 1, y: 0.9, tension: 0 }
    ]);

    // Requested step round(0.71*16)=11 -> 0.6875 (free) -> applied; it sorts
    // in front of the off-grid point at 0.7.
    const { clip: moved, nextIndex } = movePlaylistAutomationPoint(clip, 1, 0.71, 0.75, 16);
    assert.equal(moved.automationPoints?.[1].x, 0.6875);
    assert.equal(moved.automationPoints?.[1].y, 0.75);
    assert.equal(nextIndex, 1);

    // Requested step round(0.73*16)=12 -> 0.75 free -> crossing peers works.
    const { clip: crossed } = movePlaylistAutomationPoint(clip, 1, 0.73, 0.8, 16);
    assert.equal(crossed.automationPoints?.[2].x, 0.75);
    assert.equal(crossed.automationPoints?.[1].x, 0.7);
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

    // Test seam: the engine only applies automation once an AudioContext
    // exists (production always has one: the transport or the offline
    // renderer). Node tests install a minimal fake context plus fake audio
    // graph nodes and restore the originals afterwards.
    const engine = audioEngine as unknown as Record<PropertyKey, unknown>;
    const originalCtx = engine.ctx;
    const originalMasterGain = engine.masterGain;
    const originalMixerChannels = engine.mixerChannels;
    const masterGainCalls: Array<[number, number, number]> = [];
    const mixerGainCalls: Array<[number, number, number]> = [];
    const mixerPanCalls: Array<[number, number, number]> = [];

    engine.ctx = { currentTime: 0 };
    engine.masterGain = {
      gain: { setTargetAtTime: (value: number, time: number, tc: number) => { masterGainCalls.push([value, time, tc]); } }
    };
    engine.mixerChannels = new Map([
      [2, {
        output: { gain: { setTargetAtTime: (value: number, time: number, tc: number) => { mixerGainCalls.push([value, time, tc]); } } },
        panner: { pan: { setTargetAtTime: (value: number, time: number, tc: number) => { mixerPanCalls.push([value, time, tc]); } } }
      }]
    ]);

    try {
      // Channel Volume
      audioEngine.applyAutomationValue(
        { type: 'channel_vol', targetId: 'ch-test-1' },
        0.35,
        [mockChannel],
        [],
        0
      );
      assert.equal(mockChannel.volume, 0.35);

      // Channel Pan (0..1 -> -1..1)
      audioEngine.applyAutomationValue(
        { type: 'channel_pan', targetId: 'ch-test-1' },
        0.25,
        [mockChannel],
        [],
        0
      );
      assert.equal(mockChannel.pan, -0.5);

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

      // Master Volume (0..1 -> * 1.2 on the master gain AudioParam)
      audioEngine.applyAutomationValue(
        { type: 'master_vol', targetId: 0 },
        0.5,
        [],
        [],
        0
      );
      assert.deepEqual(masterGainCalls, [[0.6, 0, 0.02]]);

      // Mixer Insert Volume: data model *and* smoothed AudioParam update
      audioEngine.applyAutomationValue(
        { type: 'mixer_vol', targetId: 2 },
        0.6,
        [],
        [mockMixerTrack],
        0
      );
      assert.equal(mockMixerTrack.volume, 0.6 * 1.25);
      assert.deepEqual(mixerGainCalls, [[0.6 * 1.25, 0, 0.02]]);

      // Muted insert: the AudioParam is driven to 0, the data model still
      // records the automation value.
      mockMixerTrack.mute = true;
      audioEngine.applyAutomationValue(
        { type: 'mixer_vol', targetId: 2 },
        0.6,
        [],
        [mockMixerTrack],
        0
      );
      assert.equal(mockMixerTrack.volume, 0.6 * 1.25);
      assert.equal(mixerGainCalls[1][0], 0);
      mockMixerTrack.mute = false;

      // Mixer Insert Pan (0..1 -> -1..1)
      audioEngine.applyAutomationValue(
        { type: 'mixer_pan', targetId: 2 },
        0.25,
        [],
        [mockMixerTrack],
        0
      );
      assert.equal(mockMixerTrack.pan, -0.5);
      assert.deepEqual(mixerPanCalls, [[-0.5, 0, 0.02]]);
    } finally {
      engine.ctx = originalCtx;
      engine.masterGain = originalMasterGain;
      engine.mixerChannels = originalMixerChannels;
    }
  });

  test('selected automation point index never survives a clip change', () => {
    // Re-selecting the same clip keeps the point selection (explicit point
    // interactions re-set it anyway).
    assert.equal(nextSelectedPointIndex('clip-a', 2, 'clip-a'), 2);

    // Selecting a different clip clears it.
    assert.equal(nextSelectedPointIndex('clip-a', 2, 'clip-b'), null);

    // A newly created clip being selected clears it.
    assert.equal(nextSelectedPointIndex('clip-a', 2, 'auto-clip-new'), null);

    // Clip deletion / editor close clears it.
    assert.equal(nextSelectedPointIndex('clip-a', 2, null), null);
    assert.equal(nextSelectedPointIndex(null, null, 'clip-b'), null);
  });

  test('+ Add Node resolves a free position on a fresh default clip', () => {
    const clip = createBaseAutoClip(); // template points at x = 0, 0.5, 1
    const pos = resolveAddNodePosition(clip.automationPoints!);
    assert.equal(pos.x, 0.25); // earliest widest gap (0..0.5) midpoint, not the occupied center
    assert.ok(Math.abs(pos.y - 0.5) < 1e-9); // sits on the linear envelope

    // The drawer's add path therefore really adds on a fresh clip.
    const { clip: updated, pointIndex } = addPlaylistAutomationPoint(clip, pos.x, pos.y);
    assert.equal(updated.automationPoints!.length, 4);
    assert.equal(pointIndex, 1);
    assert.ok(Math.abs(updated.automationPoints![1].y - pos.y) < 1e-9);
  });

  test('resolveAddNodePosition handles sparse and degenerate envelopes', () => {
    assert.deepEqual(resolveAddNodePosition([]), { x: 0.5, y: 0.5 });

    // Single point: widest gap is [0, 0.6]; value holds the point's y.
    const single = resolveAddNodePosition([{ x: 0.6, y: 0.3, tension: 0 }]);
    assert.equal(single.x, 0.3);
    assert.equal(single.y, 0.3);

    // Point pinned at the timeline start: widest gap is [0, 1].
    const atStart = resolveAddNodePosition([{ x: 0, y: 0.8, tension: 0 }]);
    assert.equal(atStart.x, 0.5);
    assert.equal(atStart.y, 0.8);
  });

  test('addPlaylistAutomationPoint merge never moves a point onto an occupied X', () => {
    const clip = createBaseAutoClip([
      { x: 0, y: 0.1, tension: 0 },
      { x: 0.5, y: 0.5, tension: 0 },
      { x: 0.504, y: 0.6, tension: 0 },
      { x: 1, y: 0.9, tension: 0 }
    ]);

    // Click at 0.504 merges into the first point within the threshold (0.5);
    // its X must not advance onto the occupied 0.504 - only the Y updates.
    const { clip: updated, pointIndex } = addPlaylistAutomationPoint(clip, 0.504, 0.3);
    assert.equal(pointIndex, 1);
    assert.deepEqual(updated.automationPoints!.map(p => p.x), [0, 0.5, 0.504, 1]);
    assert.equal(updated.automationPoints![1].y, 0.3);
  });

  test('findAutomationPointIndexNearX selects the nearest point within tolerance', () => {
    const points = [{ x: 0, y: 0 }, { x: 0.5, y: 0.5, tension: 0 }, { x: 1, y: 1 }];
    assert.equal(findAutomationPointIndexNearX(points, 0.504, 0.01), 1);
    assert.equal(findAutomationPointIndexNearX(points, 0.49, 0.005), null);
    // Equidistant points resolve to the lowest index.
    assert.equal(findAutomationPointIndexNearX([{ x: 0.4, y: 0 }, { x: 0.6, y: 0 }], 0.5, 0.2), 0);
    assert.equal(findAutomationPointIndexNearX(points, Number.NaN, 0.1), null);
    assert.equal(findAutomationPointIndexNearX(points, 0.5, -1), null);
  });

  test('playback snapshots isolate automation writes from project state', () => {
    const state = createDefaultProjectState();
    const projectChannelsBefore = JSON.stringify(state.channels);
    const projectMixerBefore = JSON.stringify(state.mixerTracks);

    const snapshot = audioEngine.createPlaybackSnapshot(state.channels, state.playlistClips, state.mixerTracks);
    assert.notEqual(snapshot.channels, state.channels);
    assert.notEqual(snapshot.channels[0], state.channels[0]);
    assert.notEqual(snapshot.clips, state.playlistClips);
    assert.notEqual(snapshot.mixerTracks, state.mixerTracks);
    assert.deepEqual(snapshot.channels, state.channels);

    // Engine seam (same rationale as in the applyAutomationValue test above).
    const engine = audioEngine as unknown as Record<PropertyKey, unknown>;
    const originalCtx = engine.ctx;
    engine.ctx = { currentTime: 0 };
    try {
      const insertTrack = state.mixerTracks.find(t => t.id === 1) ?? state.mixerTracks[state.mixerTracks.length - 1];
      audioEngine.applyAutomationValue(
        { type: 'channel_vol', targetId: state.channels[0].id },
        0.11,
        snapshot.channels,
        snapshot.mixerTracks,
        0
      );
      audioEngine.applyAutomationValue(
        { type: 'channel_filter_cutoff', targetId: state.channels[0].id },
        1,
        snapshot.channels,
        snapshot.mixerTracks,
        0
      );
      audioEngine.applyAutomationValue(
        { type: 'mixer_vol', targetId: insertTrack.id },
        0.44,
        snapshot.channels,
        snapshot.mixerTracks,
        0
      );
    } finally {
      engine.ctx = originalCtx;
    }

    // The playback take received the automation values...
    assert.equal(snapshot.channels[0].volume, 0.11);
    assert.equal(snapshot.channels[0].synthParams.filterCutoff, 40 + 1 * 18000);
    const automatedInsertId = (state.mixerTracks.find(t => t.id === 1) ?? state.mixerTracks[state.mixerTracks.length - 1]).id;
    const snapshotInsert = snapshot.mixerTracks.find(t => t.id === automatedInsertId)!;
    assert.equal(snapshotInsert.volume, 0.44 * 1.25);

    // ...while the project state that feeds undo/redo and saves is untouched.
    assert.equal(JSON.stringify(state.channels), projectChannelsBefore);
    assert.equal(JSON.stringify(state.mixerTracks), projectMixerBefore);
  });
});

// ---------------------------------------------------------------------------
// Phase 6.2: automation clip split & resize semantics
// ---------------------------------------------------------------------------

/** Bar positions are compared with a tolerance that absorbs the six-decimal X quantization. */
const BAR_TOLERANCE = 1e-5;
const VALUE_TOLERANCE = 2e-6;
const STEP_BAR = 1 / 16;

const assertClose = (actual: number, expected: number, tolerance: number, message?: string) => {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message ?? `expected ${actual} to be within ${tolerance} of ${expected}`
  );
};

const createMultiTensionClip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  ...createBaseAutoClip([
    { x: 0, y: 0.2, tension: 0.3 },
    { x: 0.5, y: 0.85, tension: -0.2 },
    { x: 1, y: 0.3, tension: 0 }
  ]),
  id: 'auto-clip-mt',
  startBar: 4,
  lengthBars: 8,
  ...overrides
});

const relXAtBar = (clip: PlaylistClip, bar: number): number => (bar - clip.startBar) / clip.lengthBars;

/** Value Song Mode would apply for `clip` at `bar`, using the engine's own evaluator. */
const playbackValueAtBar = (clip: PlaylistClip, bar: number): number =>
  audioEngine.interpolateAutomationCurve(clip.automationPoints!, relXAtBar(clip, bar));

const pointBars = (clip: PlaylistClip): number[] =>
  clip.automationPoints!.map(point => clip.startBar + point.x * clip.lengthBars);

const assertWellFormedEnvelope = (clip: PlaylistClip, label: string) => {
  const points = clip.automationPoints!;
  assert.ok(points.length >= 2, `${label}: needs at least two points`);
  assert.equal(points[0].x, 0, `${label}: first point must sit at x=0`);
  assert.equal(points[points.length - 1].x, 1, `${label}: last point must sit at x=1`);
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i].x > points[i - 1].x, `${label}: point X values must be strictly increasing`);
  }
  for (const point of points) {
    assert.ok(point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1, `${label}: points must stay normalized`);
  }
  assert.deepEqual(validatePlaylistClip(clip, { totalBars: 64, maxTracks: 16 }).errors, []);
};

/**
 * Mirrors the Song Mode automation pass in audioEngine: at every 1/16 step,
 * every automation clip whose inclusive window contains the position is
 * evaluated. Returns, per step, the values of all clips that fired.
 */
const songModeSweep = (clips: PlaylistClip[], fromBar: number, toBar: number): Array<{ bar: number; values: number[] }> => {
  const steps: Array<{ bar: number; values: number[] }> = [];
  const totalSteps = Math.round((toBar - fromBar) / STEP_BAR);
  for (let i = 0; i <= totalSteps; i++) {
    const bar = fromBar + i * STEP_BAR;
    const values: number[] = [];
    for (const clip of clips) {
      if (clip.type !== 'automation' || clip.mute || !clip.automationTarget || !clip.automationPoints || clip.automationPoints.length < 2) continue;
      if (bar >= clip.startBar && bar <= clip.startBar + clip.lengthBars) {
        values.push(audioEngine.interpolateAutomationCurve(clip.automationPoints, relXAtBar(clip, bar)));
      }
    }
    steps.push({ bar, values });
  }
  return steps;
};

describe('Phase 6.2 Automation Split & Resize Semantics', () => {
  test('evaluateAutomationEnvelope mirrors the engine evaluator across tensions', () => {
    const points: AutomationPoint[] = [
      { x: 0, y: 0.1, tension: 0.6 },
      { x: 0.3, y: 0.9, tension: 0 },
      { x: 0.55, y: 0.35, tension: -0.8 },
      { x: 1, y: 0.7, tension: 1 }
    ];
    for (let i = 0; i <= 512; i++) {
      const relX = i / 512;
      assert.equal(evaluateAutomationEnvelope(points, relX), audioEngine.interpolateAutomationCurve(points, relX));
    }
    for (const point of points) {
      assert.equal(evaluateAutomationEnvelope(points, point.x), audioEngine.interpolateAutomationCurve(points, point.x));
    }
    // Held values outside the outermost points and degenerate envelopes.
    const inner = [{ x: 0.25, y: 0.4 }, { x: 0.75, y: 0.6 }];
    assert.equal(evaluateAutomationEnvelope(inner, 0), 0.4);
    assert.equal(evaluateAutomationEnvelope(inner, 1), 0.6);
    assert.equal(evaluateAutomationEnvelope([{ x: 0.5, y: 0.33 }], 0.9), 0.33);
    assert.equal(evaluateAutomationEnvelope([], 0.5), 0.5);
  });

  test('split exactly on an existing point uses it as the shared boundary (lossless)', () => {
    const clip = createMultiTensionClip();
    const [left, right] = splitPlaylistClip(clip, 8, DEFAULT_GRID_BARS, { totalBars: 64 });

    assert.equal(left.startBar, 4);
    assert.equal(left.lengthBars, 4);
    assert.equal(right.startBar, 8);
    assert.equal(right.lengthBars, 4);

    // The point at x=0.5 closes the left half and opens the right half; it is
    // not duplicated next to a synthesized seam point.
    assert.deepEqual(left.automationPoints, [
      { x: 0, y: 0.2, tension: 0.3 },
      { x: 1, y: 0.85, tension: -0.2 }
    ]);
    assert.deepEqual(right.automationPoints, [
      { x: 0, y: 0.85, tension: -0.2 },
      { x: 1, y: 0.3, tension: 0 }
    ]);
    assertWellFormedEnvelope(left, 'left');
    assertWellFormedEnvelope(right, 'right');

    // Every segment maps 1:1 onto an original segment with the same tension,
    // so the audible envelope is reproduced at every step of the timeline.
    for (let bar = 4; bar <= 12 + 1e-9; bar += STEP_BAR) {
      const expected = playbackValueAtBar(clip, bar);
      if (bar <= 8) assertClose(playbackValueAtBar(left, bar), expected, 1e-9, `left @ ${bar}`);
      if (bar >= 8) assertClose(playbackValueAtBar(right, bar), expected, 1e-9, `right @ ${bar}`);
    }

    // The source clip is untouched.
    assert.deepEqual(clip.automationPoints, [
      { x: 0, y: 0.2, tension: 0.3 },
      { x: 0.5, y: 0.85, tension: -0.2 },
      { x: 1, y: 0.3, tension: 0 }
    ]);
  });

  test('split between points synthesizes a seam at the envelope value and remaps both halves', () => {
    const clip = createMultiTensionClip();
    // Bar 6 -> xSplit = 0.25, inside the first segment (tension 0.3).
    const [left, right] = splitPlaylistClip(clip, 6, DEFAULT_GRID_BARS, { totalBars: 64 });
    const expectedSeam = audioEngine.interpolateAutomationCurve(clip.automationPoints!, 0.25);

    assert.equal(left.automationPoints!.length, 2);
    assert.equal(right.automationPoints!.length, 3);

    const leftEnd = left.automationPoints![1];
    const rightStart = right.automationPoints![0];
    assert.equal(leftEnd.x, 1);
    assert.equal(rightStart.x, 0);
    assert.equal(leftEnd.y, rightStart.y);
    assertClose(leftEnd.y, expectedSeam, 1e-6);

    // The cut segment's tension (from its opening point) is carried onto the
    // right half's opening point; untouched points keep their own tension.
    assert.deepEqual(left.automationPoints![0], { x: 0, y: 0.2, tension: 0.3 });
    assert.equal(rightStart.tension, 0.3);
    assertClose(right.automationPoints![1].x, 1 / 3, 1e-12); // (0.5 - 0.25) / 0.75, full precision
    assertClose(pointBars(right)[1], 8, 1e-12); // ...so the point stays exactly on bar 8
    assert.equal(right.automationPoints![1].y, 0.85);
    assert.equal(right.automationPoints![1].tension, -0.2);
    assert.deepEqual(right.automationPoints![2], { x: 1, y: 0.3, tension: 0 });
    assertWellFormedEnvelope(left, 'left');
    assertWellFormedEnvelope(right, 'right');

    // Uncut segments (and the head of an ease-in cut) reproduce the original
    // envelope exactly; the seam value is shared bit-for-bit by both halves.
    for (let bar = 4; bar <= 6 + 1e-9; bar += STEP_BAR) {
      assertClose(playbackValueAtBar(left, bar), playbackValueAtBar(clip, bar), VALUE_TOLERANCE, `left @ ${bar}`);
    }
    for (let bar = 8; bar <= 12 + 1e-9; bar += STEP_BAR) {
      assertClose(playbackValueAtBar(right, bar), playbackValueAtBar(clip, bar), VALUE_TOLERANCE, `right @ ${bar}`);
    }
    assert.equal(playbackValueAtBar(left, 6), playbackValueAtBar(right, 6));
    assertClose(playbackValueAtBar(right, 8), 0.85, 1e-9);

    // The approximated tail keeps the direction of the original segment.
    let previous = playbackValueAtBar(right, 6);
    for (let bar = 6 + STEP_BAR; bar <= 8 + 1e-9; bar += STEP_BAR) {
      const value = playbackValueAtBar(right, bar);
      assert.ok(value >= previous - 1e-12, `right half must keep rising through the cut segment (bar ${bar})`);
      previous = value;
    }
  });

  test('two-point envelope split is lossless for a linear ramp and continuous with tension', () => {
    const ramp = createBaseAutoClip([
      { x: 0, y: 0, tension: 0 },
      { x: 1, y: 1, tension: 0 }
    ]);
    const [left, right] = splitPlaylistClip(ramp, 1, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.deepEqual(left.automationPoints, [{ x: 0, y: 0, tension: 0 }, { x: 1, y: 0.25, tension: 0 }]);
    assert.deepEqual(right.automationPoints, [{ x: 0, y: 0.25, tension: 0 }, { x: 1, y: 1, tension: 0 }]);
    for (let bar = 0; bar <= 4 + 1e-9; bar += STEP_BAR) {
      const expected = playbackValueAtBar(ramp, bar);
      if (bar <= 1) assertClose(playbackValueAtBar(left, bar), expected, 1e-9);
      if (bar >= 1) assertClose(playbackValueAtBar(right, bar), expected, 1e-9);
    }

    const curved = createBaseAutoClip([
      { x: 0, y: 0.1, tension: 0.5 },
      { x: 1, y: 0.9, tension: 0 }
    ]);
    const [curvedLeft, curvedRight] = splitPlaylistClip(curved, 3, DEFAULT_GRID_BARS, { totalBars: 64 });
    const seam = audioEngine.interpolateAutomationCurve(curved.automationPoints!, 0.75);
    assert.equal(curvedLeft.automationPoints!.length, 2);
    assert.equal(curvedRight.automationPoints!.length, 2);
    assertClose(curvedLeft.automationPoints![1].y, seam, 1e-6);
    assert.equal(curvedLeft.automationPoints![1].y, curvedRight.automationPoints![0].y);
    assert.equal(curvedLeft.automationPoints![0].tension, 0.5);
    assert.equal(curvedRight.automationPoints![0].tension, 0.5);
    assert.equal(playbackValueAtBar(curvedLeft, 3), playbackValueAtBar(curvedRight, 3));
    // Ease-in curves are self-similar from their origin: the head is exact.
    for (let bar = 0; bar <= 3 + 1e-9; bar += STEP_BAR) {
      assertClose(playbackValueAtBar(curvedLeft, bar), playbackValueAtBar(curved, bar), VALUE_TOLERANCE);
    }
  });

  test('near-edge splits keep both halves valid and every point on its bar', () => {
    const clip = createMultiTensionClip({ startBar: 0 }); // bars 0..8

    const [tinyLeft, bigRight] = splitPlaylistClip(clip, 0.25, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(tinyLeft.lengthBars, 0.25);
    assert.equal(bigRight.startBar, 0.25);
    assert.equal(bigRight.lengthBars, 7.75);
    assertWellFormedEnvelope(tinyLeft, 'tiny left');
    assertWellFormedEnvelope(bigRight, 'big right');
    assert.deepEqual(tinyLeft.automationPoints!.map(p => p.x), [0, 1]);
    assert.equal(bigRight.automationPoints!.length, 3);
    assertClose(pointBars(bigRight)[1], 4, BAR_TOLERANCE); // the x=0.5 point still sits on bar 4
    assert.equal(bigRight.automationPoints![0].tension, 0.3);
    assert.equal(playbackValueAtBar(tinyLeft, 0.25), playbackValueAtBar(bigRight, 0.25));
    assertClose(playbackValueAtBar(tinyLeft, 0.25), playbackValueAtBar(clip, 0.25), 1e-6);

    const [bigLeft, tinyRight] = splitPlaylistClip(clip, 7.75, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(bigLeft.lengthBars, 7.75);
    assert.equal(tinyRight.startBar, 7.75);
    assert.equal(tinyRight.lengthBars, 0.25);
    assertWellFormedEnvelope(bigLeft, 'big left');
    assertWellFormedEnvelope(tinyRight, 'tiny right');
    assert.equal(bigLeft.automationPoints!.length, 3);
    assertClose(pointBars(bigLeft)[1], 4, BAR_TOLERANCE);
    assert.deepEqual(tinyRight.automationPoints!.map(p => p.x), [0, 1]);
    assert.equal(tinyRight.automationPoints![0].tension, -0.2); // cut segment opened by the x=0.5 point
    assert.equal(playbackValueAtBar(bigLeft, 7.75), playbackValueAtBar(tinyRight, 7.75));
    assertClose(playbackValueAtBar(tinyRight, 7.75), playbackValueAtBar(clip, 7.75), 1e-6);

    // Boundary splits are still rejected, and the envelope helper refuses
    // positions that would collapse a half onto its own endpoint.
    assert.throws(() => splitPlaylistClip(clip, 0, DEFAULT_GRID_BARS), /inside the clip/);
    assert.throws(() => splitPlaylistClip(clip, 8, DEFAULT_GRID_BARS), /inside the clip/);
    assert.throws(() => splitAutomationPoints(clip.automationPoints!, 0), /inside the envelope/);
    assert.throws(() => splitAutomationPoints(clip.automationPoints!, 1), /inside the envelope/);
    assert.throws(() => splitAutomationPoints(clip.automationPoints!, Number.NaN), /inside the envelope/);
  });

  test('seam continuity holds for every grid position and coincident-boundary tolerance', () => {
    const clip = createMultiTensionClip({
      automationPoints: [
        { x: 0, y: 0.2, tension: 0.3 },
        { x: 0.3125, y: 0.9, tension: -0.5 },
        { x: 0.5, y: 0.85, tension: -0.2 },
        { x: 0.75, y: 0.1, tension: 0.8 },
        { x: 1, y: 0.3, tension: 0 }
      ]
    });

    for (let splitBar = 4.25; splitBar < 12; splitBar += DEFAULT_GRID_BARS) {
      const [left, right] = splitPlaylistClip(clip, splitBar, DEFAULT_GRID_BARS, { totalBars: 64 });
      assertWellFormedEnvelope(left, `left @ ${splitBar}`);
      assertWellFormedEnvelope(right, `right @ ${splitBar}`);
      const leftSeam = playbackValueAtBar(left, splitBar);
      const rightSeam = playbackValueAtBar(right, splitBar);
      assert.equal(leftSeam, rightSeam, `seam mismatch @ ${splitBar}`);
      assertClose(leftSeam, playbackValueAtBar(clip, splitBar), 1e-6, `seam drifted from source @ ${splitBar}`);
      // A split on an existing point shares it (n + 1 points overall); a split
      // inside a segment synthesizes one seam point per half (n + 2).
      const xSplit = relXAtBar(clip, splitBar);
      const landsOnPoint = clip.automationPoints!.some(point => Math.abs(point.x - xSplit) < 1e-6);
      assert.equal(
        left.automationPoints!.length + right.automationPoints!.length,
        clip.automationPoints!.length + (landsOnPoint ? 1 : 2),
        `point count @ ${splitBar}`
      );
      // Every original point keeps its bar position in whichever half it landed.
      const survivingBars = [...pointBars(left).slice(0, -1), ...pointBars(right).slice(1)];
      for (const bar of pointBars(clip)) {
        if (Math.abs(bar - splitBar) < 1e-9) continue; // the shared boundary is represented by the seam itself
        assert.ok(survivingBars.some(candidate => Math.abs(candidate - bar) < 1e-9), `point @ bar ${bar} lost after split @ ${splitBar}`);
      }
    }

    // A point within the coincidence tolerance of the split is the boundary
    // rather than a near-duplicate of a synthesized seam point.
    const nearly = splitAutomationPoints([
      { x: 0, y: 0.1, tension: 0 },
      { x: 0.5000004, y: 0.7, tension: 0.4 },
      { x: 1, y: 0.2, tension: 0 }
    ], 0.5);
    assert.deepEqual(nearly.left, [{ x: 0, y: 0.1, tension: 0 }, { x: 1, y: 0.7, tension: 0.4 }]);
    assert.deepEqual(nearly.right, [{ x: 0, y: 0.7, tension: 0.4 }, { x: 1, y: 0.2, tension: 0 }]);

    // Halves lacking an outer endpoint receive one holding the neighbouring
    // value, which is exactly what playback does past the outermost points.
    const inner = splitAutomationPoints([{ x: 0.4, y: 0.25, tension: 0 }, { x: 0.8, y: 0.75, tension: 0 }], 0.2);
    assert.deepEqual(inner.left, [{ x: 0, y: 0.25, tension: 0 }, { x: 1, y: 0.25, tension: 0 }]);
    assert.equal(inner.right[0].x, 0);
    assert.equal(inner.right[0].y, 0.25);
    assert.equal(inner.right[inner.right.length - 1].x, 1);
    assert.equal(inner.right[inner.right.length - 1].y, 0.75);
    // The kept points land at their remapped positions: (0.4 - 0.2) / 0.8 and (0.8 - 0.2) / 0.8.
    assertClose(inner.right[1].x, 0.25, 1e-12);
    assertClose(inner.right[2].x, 0.75, 1e-12);
    assertClose(evaluateAutomationEnvelope(inner.right, 0.25), 0.25, 1e-12);
    assertClose(evaluateAutomationEnvelope(inner.right, 0.75), 0.75, 1e-12);
    assertClose(evaluateAutomationEnvelope(inner.right, 0.5), 0.5, 1e-12); // linear between the two kept points

    // Constant / empty envelopes are position independent and pass through.
    assert.deepEqual(splitAutomationPoints([{ x: 0.5, y: 0.6 }], 0.3), { left: [{ x: 0.5, y: 0.6 }], right: [{ x: 0.5, y: 0.6 }] });
    assert.deepEqual(splitAutomationPoints([], 0.3), { left: [], right: [] });
  });

  test('timing preservation: points keep their absolute bar positions on a non power-of-two split', () => {
    const clip = createMultiTensionClip({
      startBar: 3,
      lengthBars: 6,
      automationPoints: [
        { x: 0, y: 0.2, tension: 0 },
        { x: 0.125, y: 0.6, tension: 0.7, lfoRateHz: 2, lfoDepth: 0.3 },
        { x: 0.5, y: 0.85, tension: -0.2 },
        { x: 0.75, y: 0.4, tension: 0 },
        { x: 1, y: 0.3, tension: 0 }
      ]
    });
    const sourceBars = pointBars(clip); // 3, 3.75, 6, 7.5, 9

    const [left, right] = splitPlaylistClip(clip, 5, DEFAULT_GRID_BARS, { totalBars: 64 }); // xSplit = 1/3
    const leftBars = pointBars(left);
    const rightBars = pointBars(right);

    assert.equal(leftBars.length, 3); // 3, 3.75, seam @ 5
    assertClose(leftBars[0], sourceBars[0], BAR_TOLERANCE);
    assertClose(leftBars[1], sourceBars[1], BAR_TOLERANCE);
    assertClose(leftBars[2], 5, BAR_TOLERANCE);

    assert.equal(rightBars.length, 4); // seam @ 5, 6, 7.5, 9
    assertClose(rightBars[0], 5, BAR_TOLERANCE);
    assertClose(rightBars[1], sourceBars[2], BAR_TOLERANCE);
    assertClose(rightBars[2], sourceBars[3], BAR_TOLERANCE);
    assertClose(rightBars[3], sourceBars[4], BAR_TOLERANCE);

    // Per-point data (tension, LFO modulation) travels with the point.
    assert.equal(left.automationPoints![1].tension, 0.7);
    assert.equal(left.automationPoints![1].lfoRateHz, 2);
    assert.equal(left.automationPoints![1].lfoDepth, 0.3);
    assert.equal(right.automationPoints![1].tension, -0.2);
    // Ordering is preserved on both sides.
    assert.deepEqual(left.automationPoints!.map(p => p.y).slice(0, 2), [0.2, 0.6]);
    assert.deepEqual(right.automationPoints!.map(p => p.y).slice(1), [0.85, 0.4, 0.3]);
    assertWellFormedEnvelope(left, 'left');
    assertWellFormedEnvelope(right, 'right');
  });

  test('automation split never advances offsetSteps; pattern and audio splits are unchanged', () => {
    const fresh = createMultiTensionClip();
    assert.equal(fresh.offsetSteps, undefined);
    const [freshLeft, freshRight] = splitPlaylistClip(fresh, 6, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(freshLeft.offsetSteps, undefined);
    assert.equal(freshRight.offsetSteps, undefined);

    // A stale offset (e.g. written by an older split) is carried, never grown.
    const stale = createMultiTensionClip({ offsetSteps: 32 });
    const [staleLeft, staleRight] = splitPlaylistClip(stale, 6, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(staleLeft.offsetSteps, 32);
    assert.equal(staleRight.offsetSteps, 32);

    // Splitting a half again keeps the same rule.
    const [, again] = splitPlaylistClip(staleRight, 10, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(again.offsetSteps, 32);
    assert.equal(again.startBar, 10);

    // Pattern clips keep the source-offset advance and untouched fields.
    const pattern: PlaylistClip = {
      id: 'pat-split',
      trackIndex: 0,
      startBar: 4,
      lengthBars: 8,
      type: 'pattern',
      channelId: 'ch-1',
      color: '#ff6e00',
      name: 'Pattern Block',
      offsetSteps: 8
    };
    const [patternLeft, patternRight] = splitPlaylistClip(pattern, 8.25, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(patternLeft.offsetSteps, 8);
    assert.equal(patternRight.offsetSteps, 8 + 4.25 * 16);
    assert.equal(patternRight.startBar, 8.25);
    assert.equal(patternRight.lengthBars, 3.75);
    assert.equal(patternLeft.automationPoints, undefined);

    // Audio clips as well (fades clamp to the new half lengths).
    const audio: PlaylistClip = {
      id: 'audio-split',
      trackIndex: 1,
      startBar: 4,
      lengthBars: 8,
      type: 'audio',
      color: '#00ff88',
      name: 'Vocal',
      audioBufferId: 'buffer-1',
      offsetSteps: 0,
      fadeInBars: 0.5,
      fadeOutBars: 0.5
    };
    const [audioLeft, audioRight] = splitPlaylistClip(audio, 8.13, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(audioLeft.lengthBars, 4.25);
    assert.equal(audioRight.offsetSteps, 68);
    assert.equal(audioRight.fadeInBars, 0.5);
  });

  test('left / right resize keeps relative-X stretch semantics and grants automation no offset credit', () => {
    const clip = createMultiTensionClip({ startBar: 8, lengthBars: 4 }); // bars 8..12
    const sourcePoints = clip.automationPoints!.map(p => ({ ...p }));

    // Left extension is free for automation (no source material to run out of).
    const extended = resizePlaylistClipLeft(clip, 6, DEFAULT_GRID_BARS, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(extended.startBar, 6);
    assert.equal(extended.lengthBars, 6);
    assert.equal(extended.offsetSteps, 0);
    assert.deepEqual(extended.automationPoints, sourcePoints); // relative X untouched...
    assertClose(pointBars(extended)[1], 9, BAR_TOLERANCE); // ...so the middle point stretched from bar 10 to bar 9

    // A stale offset neither enables nor limits the extension: identical result.
    const staleClip = createMultiTensionClip({ startBar: 8, lengthBars: 4, offsetSteps: 32 });
    const staleExtended = resizePlaylistClipLeft(staleClip, 6, DEFAULT_GRID_BARS, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(staleExtended.startBar, 6);
    assert.equal(staleExtended.lengthBars, 6);
    assert.equal(staleExtended.offsetSteps, 0);
    const farExtended = resizePlaylistClipLeft(staleClip, 0, DEFAULT_GRID_BARS, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(farExtended.startBar, 0); // not clamped to startBar - offsetSteps / 16
    assert.equal(farExtended.lengthBars, 12);
    assert.equal(farExtended.offsetSteps, 0);
    const beyondZero = resizePlaylistClipLeft(staleClip, -3, DEFAULT_GRID_BARS, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(beyondZero.startBar, 0);

    // Left shrink compresses the envelope, normalizes the offset and respects the minimum length.
    const shrunk = resizePlaylistClipLeft(staleClip, 9, DEFAULT_GRID_BARS, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(shrunk.startBar, 9);
    assert.equal(shrunk.lengthBars, 3);
    assert.equal(shrunk.offsetSteps, 0);
    assert.deepEqual(shrunk.automationPoints, sourcePoints);
    assertClose(pointBars(shrunk)[1], 10.5, BAR_TOLERANCE);
    const minimal = resizePlaylistClipLeft(clip, 11.9, DEFAULT_GRID_BARS, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(minimal.startBar, 11.75);
    assert.equal(minimal.lengthBars, 0.25);

    // Right resize: points untouched, offset untouched, bounds respected.
    const widened = resizePlaylistClipRight(clip, 16, DEFAULT_GRID_BARS, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(widened.startBar, 8);
    assert.equal(widened.lengthBars, 8);
    assert.equal(widened.offsetSteps, undefined);
    assert.deepEqual(widened.automationPoints, sourcePoints);
    assertClose(pointBars(widened)[1], 12, BAR_TOLERANCE);
    const clamped = resizePlaylistClipRight(clip, 40, DEFAULT_GRID_BARS, DEFAULT_GRID_BARS, { totalBars: 16 });
    assert.equal(clamped.startBar + clamped.lengthBars, 16);
    const narrowed = resizePlaylistClipRight(clip, 8.1, DEFAULT_GRID_BARS, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(narrowed.lengthBars, 0.25);

    // Audio clips keep the source-preserving rule exactly as before.
    const audio: PlaylistClip = {
      id: 'audio-resize',
      trackIndex: 1,
      startBar: 8,
      lengthBars: 8,
      type: 'audio',
      color: '#00ff88',
      name: 'Vocal',
      audioBufferId: 'buffer-1',
      offsetSteps: 16
    };
    const audioExtended = resizePlaylistClipLeft(audio, 0, DEFAULT_GRID_BARS, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(audioExtended.startBar, 7); // limited by the 16 steps of available source
    assert.equal(audioExtended.offsetSteps, 0);
    const audioShrunk = resizePlaylistClipLeft(audio, 10, DEFAULT_GRID_BARS, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(audioShrunk.startBar, 10);
    assert.equal(audioShrunk.offsetSteps, 48);
    const noSource: PlaylistClip = { ...audio, offsetSteps: 0 };
    assert.equal(resizePlaylistClipLeft(noSource, 4, DEFAULT_GRID_BARS, DEFAULT_GRID_BARS, { totalBars: 64 }).startBar, 8);
  });

  test('endpoint pinning: first and last points keep x=0 / x=1 while Y stays editable', () => {
    const clip = createMultiTensionClip();

    const { clip: firstMoved, nextIndex: firstIndex } = movePlaylistAutomationPoint(clip, 0, 0.4, 0.9);
    assert.equal(firstIndex, 0);
    assert.equal(firstMoved.automationPoints![0].x, 0);
    assert.equal(firstMoved.automationPoints![0].y, 0.9);
    assert.equal(firstMoved.automationPoints![0].tension, 0.3);

    const { clip: lastMoved, nextIndex: lastIndex } = movePlaylistAutomationPoint(clip, 2, 0.3, 0.05);
    assert.equal(lastIndex, 2);
    assert.equal(lastMoved.automationPoints![2].x, 1);
    assert.equal(lastMoved.automationPoints![2].y, 0.05);

    // Grid snapping and out-of-range requests cannot unpin an endpoint either.
    const { clip: snappedFirst } = movePlaylistAutomationPoint(clip, 0, 0.7, 0.5, 16);
    assert.equal(snappedFirst.automationPoints![0].x, 0);
    const { clip: overshotLast } = movePlaylistAutomationPoint(clip, 2, 1.5, 1.5, 16);
    assert.equal(overshotLast.automationPoints![2].x, 1);
    assert.equal(overshotLast.automationPoints![2].y, 1);

    // Interior points keep the Phase 6.1 snap / collision behaviour.
    const { clip: interior } = movePlaylistAutomationPoint(clip, 1, 0.6, 0.3);
    assert.equal(interior.automationPoints![1].x, 0.6);
    const { clip: snappedInterior } = movePlaylistAutomationPoint(clip, 1, 0.58, 0.5, 16);
    assert.equal(snappedInterior.automationPoints![1].x, 0.5625);
    const { clip: blocked, nextIndex: blockedIndex } = movePlaylistAutomationPoint(clip, 1, 1, 0.3);
    assert.equal(blockedIndex, 1);
    assert.equal(blocked.automationPoints![1].x, 0.5); // cannot land on the pinned endpoint
    assert.equal(blocked.automationPoints![2].x, 1);

    // Two-point envelopes: both points are endpoints.
    const ramp = createBaseAutoClip([{ x: 0, y: 0, tension: 0 }, { x: 1, y: 1, tension: 0 }]);
    assert.equal(movePlaylistAutomationPoint(ramp, 0, 0.9, 0.2).clip.automationPoints![0].x, 0);
    assert.equal(movePlaylistAutomationPoint(ramp, 1, 0.1, 0.2).clip.automationPoints![1].x, 1);

    // Adding right next to an endpoint (below the merge threshold) edits its
    // value without nudging it off the clip edge.
    const { clip: mergedStart, pointIndex: mergedStartIndex } = addPlaylistAutomationPoint(clip, 0.003, 0.65);
    assert.equal(mergedStartIndex, 0);
    assert.equal(mergedStart.automationPoints!.length, 3);
    assert.equal(mergedStart.automationPoints![0].x, 0);
    assert.equal(mergedStart.automationPoints![0].y, 0.65);
    const { clip: mergedEnd } = addPlaylistAutomationPoint(clip, 0.998, 0.15);
    assert.equal(mergedEnd.automationPoints![2].x, 1);
    assert.equal(mergedEnd.automationPoints![2].y, 0.15);
    // Interior merges still follow the click position.
    const { clip: mergedInterior } = addPlaylistAutomationPoint(clip, 0.503, 0.5);
    assert.equal(mergedInterior.automationPoints![1].x, 0.503);

    // Pinned endpoints stay pinned on split halves too.
    const [left, right] = splitPlaylistClip(clip, 6, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(movePlaylistAutomationPoint(left, 1, 0.2, 0.7).clip.automationPoints![1].x, 1);
    assert.equal(movePlaylistAutomationPoint(right, 0, 0.8, 0.7).clip.automationPoints![0].x, 0);
  });

  test('duplicates and split halves are independent and keep their target binding', () => {
    const clip = createMultiTensionClip();
    const duplicate = duplicatePlaylistClip(clip, 'auto-clip-mt-copy', 12, 2, DEFAULT_GRID_BARS, { totalBars: 64, maxTracks: 16 });

    assert.notEqual(duplicate.id, clip.id);
    assert.equal(duplicate.startBar, 12);
    assert.deepEqual(duplicate.automationPoints, clip.automationPoints);
    assert.notEqual(duplicate.automationPoints, clip.automationPoints);
    assert.notEqual(duplicate.automationPoints![1], clip.automationPoints![1]);
    assert.deepEqual(duplicate.automationTarget, clip.automationTarget);
    assert.notEqual(duplicate.automationTarget, clip.automationTarget);

    // Editing the duplicate never reaches the source.
    const { clip: editedDuplicate } = movePlaylistAutomationPoint(duplicate, 1, 0.7, 0.1);
    assert.equal(editedDuplicate.automationPoints![1].x, 0.7);
    assert.equal(clip.automationPoints![1].x, 0.5);
    duplicate.automationPoints![1].y = 0.01;
    assert.equal(clip.automationPoints![1].y, 0.85);

    const rebound = updatePlaylistAutomationTarget(duplicate, { type: 'mixer_vol', targetId: 3, label: 'Insert 3 - Volume' });
    assert.equal(rebound.automationTarget?.type, 'mixer_vol');
    assert.equal(rebound.automationTarget?.targetId, 3);
    assert.equal(rebound.name, 'Auto: Insert 3 - Volume');
    assert.equal(clip.automationTarget?.type, 'channel_filter_cutoff');
    assert.equal(clip.automationTarget?.targetId, 'ch-synth-1');
    assert.equal(duplicate.automationTarget?.type, 'channel_filter_cutoff');

    // Split halves each carry their own copy of the binding.
    const [left, right] = splitPlaylistClip(clip, 6, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.deepEqual(left.automationTarget, clip.automationTarget);
    assert.deepEqual(right.automationTarget, clip.automationTarget);
    assert.notEqual(left.automationTarget, right.automationTarget);
    assert.notEqual(left.automationTarget, clip.automationTarget);
    assert.notEqual(left.automationPoints, right.automationPoints);
    assert.equal(left.trackIndex, clip.trackIndex);
    assert.equal(right.trackIndex, clip.trackIndex);
    assert.equal(left.color, clip.color);
    const reboundLeft = updatePlaylistAutomationTarget(left, { type: 'master_vol', targetId: 0, label: 'Master Out' });
    assert.equal(reboundLeft.automationTarget?.type, 'master_vol');
    assert.equal(right.automationTarget?.type, 'channel_filter_cutoff');
    assert.equal(clip.automationTarget?.type, 'channel_filter_cutoff');
  });

  test('workflow: create -> edit -> split -> seam -> resize -> endpoint -> undo/redo -> save/reload -> Song Mode', () => {
    const state = createDefaultProjectState();
    const targetChannel = state.channels[0];

    // create: the arranger's default automation clip shape, bound to a real channel.
    const created = createMultiTensionClip({
      id: 'auto-workflow',
      trackIndex: 0,
      startBar: 4,
      lengthBars: 8,
      automationTarget: { type: 'channel_filter_cutoff', targetId: targetChannel.id, label: `${targetChannel.name} Filter Cutoff` }
    });
    state.playlistClips = [created];
    let history = createHistory(state);
    const commit = (clips: PlaylistClip[], label: string) => {
      history = history.commit({ ...history.present, playlistClips: clips }, label);
    };

    // edit: add a node and move it.
    const { clip: withNode, pointIndex } = addPlaylistAutomationPoint(created, 0.75, 0.1);
    assert.equal(pointIndex, 2);
    const { clip: edited } = movePlaylistAutomationPoint(withNode, pointIndex, 0.8, 0.05, 32);
    assert.equal(edited.automationPoints![2].x, 0.8125);
    commit([edited], 'Edit automation');

    // split at bar 6 (inside the first segment).
    const [left, right] = splitPlaylistClip(edited, 6, DEFAULT_GRID_BARS, { totalBars: 64 });
    commit([left, right], 'Split automation clip');
    assert.equal(history.present.playlistClips.length, 2);

    // seam check: the two halves agree with each other and with the source.
    const seamValue = playbackValueAtBar(left, 6);
    assert.equal(seamValue, playbackValueAtBar(right, 6));
    assertClose(seamValue, playbackValueAtBar(edited, 6), 1e-6);
    assertClose(pointBars(right)[1], 8, BAR_TOLERANCE);
    assertClose(pointBars(right)[2], 10.5, BAR_TOLERANCE);

    // resize: extend the left half leftwards (stretch) and the right half rightwards.
    const leftResized = resizePlaylistClipLeft(left, 2, DEFAULT_GRID_BARS, DEFAULT_GRID_BARS, { totalBars: 64 });
    const rightResized = resizePlaylistClipRight(right, 14, DEFAULT_GRID_BARS, DEFAULT_GRID_BARS, { totalBars: 64 });
    assert.equal(leftResized.startBar, 2);
    assert.equal(leftResized.lengthBars, 4);
    assert.equal(leftResized.offsetSteps, 0);
    assert.equal(rightResized.lengthBars, 8);
    assert.deepEqual(leftResized.automationPoints, left.automationPoints);
    assert.deepEqual(rightResized.automationPoints, right.automationPoints);
    commit([leftResized, rightResized], 'Resize automation clips');
    // The seam still meets at bar 6 after both resizes.
    assert.equal(playbackValueAtBar(leftResized, 6), playbackValueAtBar(rightResized, 6));

    // endpoint check: dragging the seam points only changes their value.
    const { clip: leftEdited } = movePlaylistAutomationPoint(leftResized, 1, 0.4, 0.95, 16);
    const { clip: rightEdited } = movePlaylistAutomationPoint(rightResized, 0, 0.6, 0.95, 32);
    assert.equal(leftEdited.automationPoints![1].x, 1);
    assert.equal(rightEdited.automationPoints![0].x, 0);
    assert.equal(leftEdited.automationPoints![1].y, 0.95);
    assert.equal(rightEdited.automationPoints![0].y, 0.95);
    commit([leftEdited, rightEdited], 'Edit seam value');
    assert.equal(playbackValueAtBar(leftEdited, 6), playbackValueAtBar(rightEdited, 6));

    // undo / redo.
    history = history.undo();
    assert.equal(history.present.playlistClips[0].automationPoints![1].y, left.automationPoints![1].y);
    history = history.undo();
    assert.equal(history.present.playlistClips[0].startBar, 4);
    assert.equal(history.present.playlistClips[1].lengthBars, 6);
    history = history.undo();
    assert.equal(history.present.playlistClips.length, 1);
    assert.deepEqual(history.present.playlistClips[0].automationPoints, edited.automationPoints);
    history = history.redo();
    assert.equal(history.present.playlistClips.length, 2);
    assert.deepEqual(history.present.playlistClips[0].automationPoints, left.automationPoints);
    history = history.redo();
    history = history.redo();
    assert.equal(history.present.playlistClips[0].startBar, 2);
    assert.equal(history.present.playlistClips[0].automationPoints![1].y, 0.95);
    assert.equal(history.present.playlistClips[1].automationPoints![0].y, 0.95);

    // save / reload.
    const serialized = serializeProjectState(history.present);
    const reloaded = normalizeProjectState(JSON.parse(serialized).state);
    assert.equal(reloaded.playlistClips.length, 2);
    assert.deepEqual(reloaded.playlistClips[0].automationPoints, leftEdited.automationPoints);
    assert.deepEqual(reloaded.playlistClips[1].automationPoints, rightEdited.automationPoints);
    assert.deepEqual(reloaded.playlistClips[0].automationTarget, created.automationTarget);
    assert.equal(reloaded.playlistClips[0].offsetSteps, 0);
    assert.equal(reloaded.playlistClips[1].offsetSteps, undefined);
    assertWellFormedEnvelope(reloaded.playlistClips[0], 'reloaded left');
    assertWellFormedEnvelope(reloaded.playlistClips[1], 'reloaded right');

    // Song Mode: the playback snapshot is isolated from the project and the
    // seam applies the same filter cutoff from either half.
    const snapshot = audioEngine.createPlaybackSnapshot(reloaded.channels, reloaded.playlistClips, reloaded.mixerTracks);
    assert.notEqual(snapshot.clips, reloaded.playlistClips);
    assert.deepEqual(snapshot.clips, reloaded.playlistClips);
    const seamSteps = songModeSweep(snapshot.clips, 6, 6);
    assert.equal(seamSteps[0].values.length, 2);
    assert.equal(seamSteps[0].values[0], seamSteps[0].values[1]);

    const engine = audioEngine as unknown as Record<PropertyKey, unknown>;
    const originalCtx = engine.ctx;
    engine.ctx = { currentTime: 0 };
    try {
      const cutoffs: number[] = [];
      for (const clip of snapshot.clips) {
        audioEngine.applyAutomationValue(clip.automationTarget!, playbackValueAtBar(clip, 6), snapshot.channels, snapshot.mixerTracks, 0);
        cutoffs.push(snapshot.channels[0].synthParams.filterCutoff);
      }
      assert.equal(cutoffs[0], cutoffs[1]);
      assert.equal(cutoffs[0], 40 + Math.pow(0.95, 2) * 18000);
    } finally {
      engine.ctx = originalCtx;
    }
    // The saved project itself was not written to by playback.
    assert.equal(reloaded.channels[0].synthParams.filterCutoff, targetChannel.synthParams.filterCutoff);
  });

  test('playback seam regression: split clips reproduce the source envelope with no glitch at the seam', () => {
    // Lossless case: a split on an existing point.
    const clip = createMultiTensionClip({ startBar: 0 });
    const [left, right] = splitPlaylistClip(clip, 4, DEFAULT_GRID_BARS, { totalBars: 64 });
    const sweep = songModeSweep([left, right], 0, 8);
    for (const step of sweep) {
      const expected = playbackValueAtBar(clip, step.bar);
      assert.ok(step.values.length >= 1, `no clip active at bar ${step.bar}`);
      for (const value of step.values) assertClose(value, expected, 1e-9, `bar ${step.bar}`);
    }
    // At the seam both halves are inside their inclusive window: whichever
    // fires last, the value is the same.
    const seam = sweep.find(step => Math.abs(step.bar - 4) < 1e-12)!;
    assert.equal(seam.values.length, 2);
    assert.equal(seam.values[0], seam.values[1]);

    // Linear envelopes split anywhere are lossless as well.
    const linear = createBaseAutoClip([
      { x: 0, y: 0.9, tension: 0 },
      { x: 0.4, y: 0.1, tension: 0 },
      { x: 0.7, y: 0.6, tension: 0 },
      { x: 1, y: 0.2, tension: 0 }
    ]);
    for (const splitBar of [0.25, 1.25, 2.75, 3.75]) {
      const [a, b] = splitPlaylistClip(linear, splitBar, DEFAULT_GRID_BARS, { totalBars: 64 });
      for (const step of songModeSweep([a, b], 0, 4)) {
        for (const value of step.values) assertClose(value, playbackValueAtBar(linear, step.bar), 2e-6, `split ${splitBar} @ bar ${step.bar}`);
      }
    }

    // Curved envelopes split mid-segment: continuous at the seam, exact at
    // every original point, and the neighbouring left clip never drifts.
    const curvedSplit = splitPlaylistClip(clip, 2, DEFAULT_GRID_BARS, { totalBars: 64 });
    const curvedSweep = songModeSweep(curvedSplit, 0, 8);
    const curvedSeam = curvedSweep.find(step => Math.abs(step.bar - 2) < 1e-12)!;
    assert.equal(curvedSeam.values.length, 2);
    assert.equal(curvedSeam.values[0], curvedSeam.values[1]);
    assertClose(curvedSeam.values[0], playbackValueAtBar(clip, 2), 1e-6);
    for (const step of curvedSweep) {
      if (step.bar <= 2) assertClose(step.values[0], playbackValueAtBar(clip, step.bar), 1e-9, `left @ ${step.bar}`);
      if (step.bar >= 4) assertClose(step.values[step.values.length - 1], playbackValueAtBar(clip, step.bar), 1e-9, `right @ ${step.bar}`);
    }
    // Through the cut segment (bars 2..4) the right half stays inside the
    // source segment's value range (no overshoot) and keeps its direction,
    // and the seam itself introduces no discontinuity: the value change across
    // the seam step is in line with the neighbouring steps.
    const cutStart = playbackValueAtBar(clip, 2);
    const cutEnd = playbackValueAtBar(clip, 4);
    let previousValue = cutStart;
    for (const step of curvedSweep) {
      if (step.bar < 2 || step.bar > 4) continue;
      const value = step.values[step.values.length - 1];
      assert.ok(value >= Math.min(cutStart, cutEnd) - 1e-9 && value <= Math.max(cutStart, cutEnd) + 1e-9, `overshoot @ ${step.bar}`);
      assert.ok(value >= previousValue - 1e-12, `direction change @ ${step.bar}`);
      previousValue = value;
    }
    const seamIndex = curvedSweep.findIndex(step => Math.abs(step.bar - 2) < 1e-12);
    const stepBefore = curvedSweep[seamIndex].values[0] - curvedSweep[seamIndex - 1].values[0];
    const stepAfter = curvedSweep[seamIndex + 1].values[0] - curvedSweep[seamIndex].values[1];
    assert.ok(stepBefore > 0 && stepAfter > 0, 'the envelope keeps rising across the seam');
    assert.ok(Math.max(stepBefore, stepAfter) < 0.05, 'no audible jump at the seam step');
  });
});
