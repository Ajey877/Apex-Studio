import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import type { PlaylistClip, Channel, MixerTrack } from '../types/daw';
import {
  addPlaylistAutomationPoint,
  movePlaylistAutomationPoint,
  deletePlaylistAutomationPoint,
  updatePlaylistAutomationTarget,
  updatePlaylistAutomationPoint,
  nextSelectedPointIndex,
  findAutomationPointIndexNearX,
  resolveAddNodePosition
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
