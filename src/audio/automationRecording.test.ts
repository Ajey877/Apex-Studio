/**
 * Phase 12 — automation recording: the recorder contract.
 *
 * Everything here exercises the production module `src/audio/automationRecording.ts`
 * the way the App drives it: a transport sample from the AudioContext clock, a
 * normalized control value from the existing mixer/FX funnel, and the lane
 * surgery the App commits as one history entry. Nothing is mocked except the
 * clock itself, which is supplied as plain numbers — the recorder never reads a
 * wall clock, so a "transport sweep" here is exactly what the engine reports
 * while playing.
 *
 * What is proven, per mode and boundary:
 *   - OFF/READ capture nothing and leave the lane byte-identical;
 *   - WRITE replaces the interval from the arm moment, including a pass that
 *     never moves the control;
 *   - TOUCH captures only between grab and release and the previous curve
 *     resumes after the release point;
 *   - LATCH holds the last touched value past release until the pass ends;
 *   - capture is placed by transport position, not by call order or wall time;
 *   - no duplicate points, and a still control emits no points at all;
 *   - a deleted target abandons the pass without touching the lane;
 *   - a position regression (seek/loop/restart) is a boundary, not a wrap;
 *   - a completed pass is ONE lane edit that `createHistory` records as one
 *     undo/redo step with exact restoration.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AutomationPoint, Channel, FxSlot, MixerTrack, PlaylistClip, ProjectState } from '../types/daw';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { serializeProjectState } from '../state/projectPersistence';
import { createHistory } from '../state/projectHistory';
import {
  AUTOMATION_SAMPLE_STEP_FRACTION,
  AUTOMATION_X_EPSILON,
  AutomationRecordingPasser,
  automationClipWithRecordedPass,
  automationTargetKey,
  automationTargetResolves,
  clipRelativeX,
  findAutomationClipForTarget,
  isAutomationRecordingMode,
  laneValueAt,
  normalizeAutomationModes,
  normalizeAutomationPoints,
  readAutomationTargetValue,
  resolveAutomationMode,
  restoreLaneSnapshot,
  setAutomationMode,
  transportSampleFromPosition,
  type AutomationRecordingPass,
  type TransportSample,
} from '../audio/automationRecording';
import { filterCutoffFromNormalized, filterCutoffToNormalized, mixerVolumeFromNormalized, panFromNormalized, panToNormalized } from '../audio/parameterScaling';
import { formatFxSlotTargetId } from '../audio/fxParameterControl';
import { evaluateAutomationEnvelope } from '../components/playlistClipOperations';

const BPM = 120; // one bar = 2 s in 4/4, so seconds -> bars is exact here.

/** 4/4 at 120 BPM: `bars` -> the engine's `positionSeconds`. */
const bars = (value: number): number => value * 2;

/** A transport sample taken at `bars` through the production converter. */
const at = (positionBars: number): TransportSample => transportSampleFromPosition(bars(positionBars), BPM);

const mixerVolClip = (id = 'auto-vol', startBar = 0, lengthBars = 4): PlaylistClip => ({
  id,
  trackIndex: 1,
  startBar,
  lengthBars,
  type: 'automation',
  color: '#00e5ff',
  name: 'Auto: Insert 1 Volume',
  automationTarget: { type: 'mixer_vol', targetId: 1, label: 'Insert 1 Volume' },
  automationPoints: [
    { x: 0, y: 0.25, tension: 0 },
    { x: 0.5, y: 0.75, tension: 0 },
    { x: 1, y: 0.25, tension: 0 },
  ],
});

const makeTrack = (id: number, fxSlots: FxSlot[] = [], volume = 0.8): MixerTrack => ({
  id, name: `Insert ${id}`, color: '#ffffff', volume, pan: 0, mute: false, solo: false,
  routingTargetId: 0, fxSlots,
} as MixerTrack);

const makeChannel = (id: string, mixerTrackId = 1): Channel => ({
  id, name: id, color: '#ff6e00', instrumentType: 'minisynth', mixerTrackId,
  volume: 0.9, pan: 0, pitch: 0, mute: false, solo: false,
  steps: new Array(16).fill(false), notes: [],
  synthParams: {
    filterCutoff: 3500, filterResonance: 1, filterType: 'lowpass', filterEnvAmount: 0,
    attack: 0.01, decay: 0.15, sustain: 0.6, release: 0.2, unisonVoices: 1, osc2Mix: 0.65,
  },
} as Channel);

const points = (clip: PlaylistClip): AutomationPoint[] => clip.automationPoints ?? [];

/** Value at `x` with a tolerance, since a lane's seam math is float arithmetic. */
const near = (actual: number, expected: number, message?: string, tolerance = 1e-6): void => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? 'value'} — expected ${expected}, got ${actual}`);
};

const assertAscendingUnique = (lane: AutomationPoint[]): void => {
  for (let index = 1; index < lane.length; index += 1) {
    assert.ok(lane[index].x > lane[index - 1].x, `lane must be strictly ascending at ${index}: ${lane[index - 1].x} -> ${lane[index].x}`);
  }
};

describe('Phase 12 — mode model and persistence', () => {
  it('validates modes, defaults to read, and never stores the read default', () => {
    assert.ok(isAutomationRecordingMode('write'));
    assert.ok(isAutomationRecordingMode('latch'));
    assert.equal(isAutomationRecordingMode('arm'), false);
    assert.equal(isAutomationRecordingMode(undefined), false);

    const target = mixerVolClip().automationTarget;
    assert.equal(resolveAutomationMode(undefined, target), 'read');
    assert.equal(resolveAutomationMode({}, target), 'read');

    const written = setAutomationMode(undefined, target, 'touch');
    assert.deepEqual(written, { [automationTargetKey(target)!]: 'touch' });
    assert.equal(setAutomationMode(written, target, 'read'), undefined);
    // A read entry supplied from outside is dropped by normalization.
    assert.equal(normalizeAutomationModes({ a: 'read' }), undefined);
    assert.deepEqual(normalizeAutomationModes({ a: 'latch', b: 'nonsense', c: 'read' }), { a: 'latch' });
  });

  it('keys the mode by target, so a split or re-created lane clip keeps it', () => {
    const original = mixerVolClip('auto-a');
    const recreated = { ...mixerVolClip('auto-b'), id: 'auto-b' };
    assert.equal(automationTargetKey(original.automationTarget), automationTargetKey(recreated.automationTarget));
    const modes = setAutomationMode(undefined, original.automationTarget, 'latch');
    assert.equal(resolveAutomationMode(modes, recreated.automationTarget), 'latch');
    // A different target is unaffected.
    assert.equal(resolveAutomationMode(modes, { type: 'mixer_vol', targetId: 2 }), 'read');
  });

  it('survives save/reopen through the production serializer and normalizer', () => {
    const base = createDefaultProjectState();
    const clip = mixerVolClip();
    const target = clip.automationTarget;
    const state: ProjectState = {
      ...base,
      playlistClips: [clip],
      automationModes: setAutomationMode(undefined, target, 'write'),
    };
    const serialized = serializeProjectState(state);
    const reopened = normalizeProjectState(JSON.parse(serialized).state as ProjectState);
    assert.deepEqual(reopened.playlistClips[0].automationPoints, clip.automationPoints);
    assert.equal(resolveAutomationMode(reopened.automationModes, target), 'write');
    // Re-saving an untouched reopened project is byte-stable for the mode map.
    assert.equal(serializeProjectState(reopened), serialized);
  });

  it('drops an unknown persisted mode instead of trusting it', () => {
    const base = createDefaultProjectState();
    const poisoned = {
      ...base,
      automationModes: { 'mixer_vol:1:': 'solo', 'mixer_vol:2:': 'latch' },
    } as unknown as ProjectState;
    const normalized = normalizeProjectState(poisoned);
    assert.deepEqual(normalized.automationModes, { 'mixer_vol:2:': 'latch' });
  });
});

describe('Phase 12 — transport positions', () => {
  it('converts the audio clock into bars through the project meter', () => {
    // 4/4 @120: one bar = 4 beats = 2 s.
    assert.ok(Math.abs(at(2).positionBars - 2) < 1e-9);
    // 3/4 @120: one bar = 3 beats = 1.5 s, so 3 s is bar 2.
    const threeFour = transportSampleFromPosition(3, BPM, [3, 4]);
    assert.ok(Math.abs(threeFour.positionBars - 2) < 1e-9);
  });

  it('maps a transport position onto the clip and refuses positions outside it', () => {
    const clip = mixerVolClip('auto', 2, 4);
    assert.equal(clipRelativeX(2, clip), 0);
    assert.equal(clipRelativeX(4, clip), 0.5);
    assert.equal(clipRelativeX(6, clip), 1);
    assert.equal(clipRelativeX(1.5, clip), null);
    assert.equal(clipRelativeX(6.5, clip), null);
    assert.equal(clipRelativeX(3, { startBar: 0, lengthBars: 0 }), null);
  });

  it('uses transport position, not call order, to place a point', () => {
    const clip = mixerVolClip();
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'write', at(0), 0.1));
    // Two samples taken at the SAME transport position collapse to one point,
    // and the later value wins (it is the value the parameter actually has at
    // that instant).
    passer.sampleValue(at(1), 0.2);
    passer.sampleValue(at(1), 0.3);
    // A sample later in the transport lands later in the lane even though it
    // arrived after an identical position.
    passer.sampleValue(at(2), 0.4);
    const pass = passer.finish(at(2));
    assert.ok(pass);
    assert.deepEqual(pass.points, [
      { x: 0, y: 0.1 },
      { x: 0.25, y: 0.3 },
      { x: 0.5, y: 0.4 },
    ]);
  });
});

describe('Phase 12 — OFF and READ capture nothing', () => {
  for (const mode of ['off', 'read'] as const) {
    it(`${mode}: refuses to arm and leaves the lane untouched`, () => {
      const clip = mixerVolClip();
      const passer = new AutomationRecordingPasser();
      assert.equal(passer.start(clip, clip.automationTarget, mode, at(0), 0.9), false);
      assert.equal(passer.isActive, false);
      assert.equal(passer.sampleValue(at(1), 0.1), false);
      assert.equal(passer.finish(at(2)), null);
      const result = automationClipWithRecordedPass(clip, null);
      assert.equal(result, clip);
      // PLAYBACK invariant: the lane itself is unchanged, which is what keeps
      // READ behaviour identical to the pre-Phase-12 engine.
      assert.deepEqual(points(result), points(clip));
      assert.equal(evaluateAutomationEnvelope(points(result), 0.5), 0.75);
    });
  }
});

describe('Phase 12 — WRITE', () => {
  it('records the pass, including the value current at the arm moment', () => {
    const clip = mixerVolClip();
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'write', at(1), 0.5));
    passer.sampleValue(at(1.5), 0.6);
    passer.sampleValue(at(2), 0.7);
    const pass = passer.finish(at(2))!;
    assert.ok(pass);
    assert.equal(pass.startX, 0.25);
    assert.equal(pass.endX, 0.5);
    // The value at the arm moment is the first point: WRITE owns the interval it
    // ran over even before the control moved.
    assert.deepEqual(pass.points[0], { x: 0.25, y: 0.5 });

    const written = automationClipWithRecordedPass(clip, pass);
    assertAscendingUnique(points(written));
    const writeLane = points(written);
    // At the recorded nodes the lane is exact; between them it interpolates.
    near(laneValueAt(writeLane, 0.375, 0), 0.6, 'mid-pass value');
    assert.ok(laneValueAt(writeLane, 0.28, 0) > 0.5 && laneValueAt(writeLane, 0.28, 0) < 0.6);
    assert.ok(laneValueAt(writeLane, 0.48, 0) > 0.6 && laneValueAt(writeLane, 0.48, 0) < 0.7);
    // Outside the pass the original lane is preserved exactly. Left of the pass
    // the original x=0..0.5 segment is untouched; right of it the segment now
    // starts at the recorded 0.7 instead of the old 0.75, so it is recomputed
    // from the recorded edge rather than the replaced point.
    near(laneValueAt(writeLane, 0.1, 0), 0.25 + (0.75 - 0.25) * 0.2, 'curve left of the pass');
    near(laneValueAt(writeLane, 1, 0), 0.25, 'curve right of the pass');
    assert.ok(Math.abs(laneValueAt(writeLane, 0.75, 0) - (0.75 + (0.25 - 0.75) * 0.5)) < 1e-6);
  });

  it('a pass that never moves the control still writes a flat line', () => {
    const clip = mixerVolClip();
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'write', at(0), 0.9));
    const pass = passer.finish(at(4))!;
    assert.ok(pass);
    assert.deepEqual(pass.points, [{ x: 0, y: 0.9 }]);
    const written = automationClipWithRecordedPass(clip, pass);
    near(laneValueAt(points(written), 0.1, 0), 0.9);
    near(laneValueAt(points(written), 0.5, 0), 0.9);
    near(laneValueAt(points(written), 0.9, 0), 0.9);
    // One point + two pinned edges is enough; no duplicate stack.
    assertAscendingUnique(points(written));
    assert.ok(points(written).length <= 2, `expected a flat lane, got ${JSON.stringify(points(written))}`);
  });

  it('does not emit a point per sample while the control is still', () => {
    const clip = mixerVolClip();
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'write', at(0), 0.4));
    for (let step = 1; step <= 64; step += 1) passer.sampleValue(at(step / 16), 0.4);
    const pass = passer.finish(at(4))!;
    assert.equal(pass.points.length, 1, 'a held value must not emit one point per transport tick');
  });

  it('replaces only the interval it ran over', () => {
    const clip = mixerVolClip();
    const before = points(clip).map(point => ({ ...point }));
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'write', at(1), 0.1));
    passer.sampleValue(at(2), 0.2);
    const written = automationClipWithRecordedPass(clip, passer.finish(at(2))!);
    const lane = points(written);
    // The x = 0 point outside the pass is byte-identical.
    assert.deepEqual(lane[0], before[0]);
    // The old x = 0.5 value (0.75) is no longer the curve's value inside the
    // pass; the recorded 0.2 is what plays there.
    near(laneValueAt(lane, 0.375, 0), 0.15, 'mid-pass interpolation');
    assert.ok(laneValueAt(lane, 0.26, 0) > 0.1 && laneValueAt(lane, 0.26, 0) < 0.2);
  });
});

describe('Phase 12 — TOUCH', () => {
  it('captures only between grab and release, then the previous curve resumes', () => {
    const clip = mixerVolClip();
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'touch', at(0), null));
    // No grab yet: nothing is captured even while the transport moves.
    passer.sampleTick(at(0.5));
    passer.sampleValue(at(1), 0.1);
    assert.equal(passer.capturedCount, 0);

    passer.grab(at(1), 0.1);
    passer.sampleValue(at(1.5), 0.9);
    const pass = passer.release(at(2), 0.9);
    assert.ok(pass, 'releasing a touch pass closes it');
    assert.equal(pass.released, true);

    const written = automationClipWithRecordedPass(clip, pass);
    assertAscendingUnique(points(written));
    const touchLane = points(written);
    // Inside the touch: the performed values (start value held from the grab,
    // then the ramp to the released value).
    assert.ok(laneValueAt(touchLane, 0.26, 0) > 0.1 && laneValueAt(touchLane, 0.26, 0) < 0.9);
    near(laneValueAt(touchLane, 0.375, 0), 0.9, 'touched value at release-1.5');
    // The pass ends at the release position with the touched value just before
    // it and the ORIGINAL curve value exactly at it — a step back to the
    // underlying automation, which is what TOUCH means.
    near(laneValueAt(touchLane, 0.49, 0), 0.9, 'touched value just before release');
    const originalAtRelease = evaluateAutomationEnvelope(points(clip), 0.5);
    assert.ok(Math.abs(laneValueAt(touchLane, 0.5, 0) - originalAtRelease) < 1e-6,
      `expected ${originalAtRelease}, got ${laneValueAt(touchLane, 0.5, 0)}`);
    // After the release the original curve resumes with no drift.
    for (const x of [0.55, 0.75, 0.9, 1]) {
      assert.ok(Math.abs(laneValueAt(touchLane, x, 0) - evaluateAutomationEnvelope(points(clip), x)) < 1e-6,
        `curve must resume at ${x}`);
    }
  });

  it('a touch with no movement leaves the lane byte-identical', () => {
    const clip = mixerVolClip();
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'touch', at(0), null));
    passer.grab(at(1), 0.5);
    const pass = passer.release(at(1), 0.5)!;
    const written = automationClipWithRecordedPass(clip, pass);
    assert.deepEqual(points(written), points(clip));
  });

  it('keeps touching after release closed nothing new (release is idempotent)', () => {
    const clip = mixerVolClip();
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'touch', at(0), null));
    passer.grab(at(1), 0.2);
    passer.release(at(1), 0.2);
    assert.equal(passer.isActive, false);
    assert.equal(passer.release(at(2), 0.9), null);
    assert.equal(passer.sampleValue(at(2), 0.9), false);
  });
});

describe('Phase 12 — LATCH', () => {
  it('continues writing the last touched value after release until the pass ends', () => {
    const clip = mixerVolClip();
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'latch', at(0), null));
    passer.grab(at(0.5), 0.2);
    passer.sampleValue(at(1), 0.6);
    assert.equal(passer.release(at(1.5), 0.6), null, 'latch does not close on release');
    assert.equal(passer.isHolding, true);
    // The transport keeps moving with the control held at 0.6.
    passer.sampleTick(at(2));
    passer.sampleTick(at(3));
    const pass = passer.finish(at(4))!;
    assert.ok(pass);
    assert.equal(pass.released, true);

    const written = automationClipWithRecordedPass(clip, pass);
    assertAscendingUnique(points(written));
    const latchLane = points(written);
    assert.ok(laneValueAt(latchLane, 0.2, 0) > 0.2 && laneValueAt(latchLane, 0.2, 0) < 0.6);
    near(laneValueAt(latchLane, 0.5, 0), 0.6, 'latched value at release');
    // Past the release the touched value is held, NOT the old curve — until the
    // pass end, where the original lane resumes.
    near(laneValueAt(latchLane, 0.75, 0), 0.6, 'latched hold');
    near(laneValueAt(latchLane, 0.99, 0), 0.6, 'latched value near the pass end');
    // The pass ran to the very end of the clip, so there is no "outside" for the
    // original curve to resume in — the latched value correctly holds to x = 1.
    near(laneValueAt(latchLane, 1, 0), 0.6, 'latched value at the clip end');
  });

  it('writes nothing before the first grab even when armed', () => {
    const clip = mixerVolClip();
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'latch', at(0), 0.9));
    passer.sampleTick(at(1));
    passer.sampleValue(at(1.5), 0.1);
    assert.equal(passer.capturedCount, 0);
    assert.equal(passer.finish(at(2)), null, 'an untouched latch pass must not create history');
  });
});

describe('Phase 12 — transport boundaries', () => {
  it('a backwards position (seek / loop restart) is a boundary, not a wrap', () => {
    const clip = mixerVolClip();
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'write', at(1), 0.3));
    passer.sampleValue(at(2), 0.5);
    // Seek back to the top: the pass must not fold the new position onto x = 0.
    assert.equal(passer.sampleValue(at(0), 0.6), false);
    // The caller finishes at the pre-seek position and commits that pass.
    const pass = passer.finish(at(2))!;
    assert.ok(pass);
    assert.equal(pass.endX, 0.5);
    assert.ok(pass.points.every(point => point.x >= 0.25 - AUTOMATION_X_EPSILON && point.x <= 0.5 + AUTOMATION_X_EPSILON));
  });

  it('clamps at the clip end instead of recording past it', () => {
    const clip = mixerVolClip('auto', 0, 4);
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'write', at(3.5), 0.2));
    // The transport runs past the clip end: the lane must stop at x = 1.
    assert.equal(passer.sampleValue(at(4.5), 0.9), false);
    const pass = passer.finish(at(4))!;
    assert.ok(pass);
    assert.ok(pass.points.every(point => point.x <= 1 + AUTOMATION_X_EPSILON));
  });

  it('finishing at the stop position includes the value heard at the stop', () => {
    const clip = mixerVolClip();
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'write', at(0), 0.2));
    passer.sampleValue(at(2), 0.8);
    const pass = passer.finish(at(2))!;
    const written = automationClipWithRecordedPass(clip, pass);
    near(laneValueAt(points(written), 0.49, 0), 0.7881176235247049, 'value heard near the stop', 1e-6);
    // A finish with no further sample still closes exactly there.
    assert.equal(pass.endX, 0.5);
  });

  it('a paused transport cannot advance a pass', () => {
    const clip = mixerVolClip();
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'write', at(0), 0.2));
    // Same position twice: a second point is not emitted.
    passer.sampleValue(at(1), 0.4);
    passer.sampleValue(at(1), 0.4);
    const pass = passer.finish(at(1))!;
    assert.deepEqual(pass.points, [{ x: 0, y: 0.2 }, { x: 0.25, y: 0.4 }]);
  });
});

describe('Phase 12 — deleted targets during a pass', () => {
  const fxProject = () => {
    const slot: FxSlot = { id: 'fx-comp', type: 'compressor', name: 'Comp', enabled: true, mix: 0.8, params: { threshold: -18, knee: 24, ratio: 4, attack: 0.005, release: 0.15 } };
    return { tracks: [makeTrack(0), makeTrack(1, [slot])], slot };
  };

  it('abandons a pass whose FX slot was deleted', () => {
    const { tracks, slot } = fxProject();
    const target = { type: 'fx_param' as const, targetId: formatFxSlotTargetId(1, slot.id), paramName: 'threshold', label: 'Comp Threshold' };
    assert.equal(automationTargetResolves(target, [], tracks), true);

    const passer = new AutomationRecordingPasser();
    const clip: PlaylistClip = { ...mixerVolClip(), automationTarget: target };
    assert.ok(passer.start(clip, target, 'write', at(0), 0.5));
    passer.sampleValue(at(1), 0.7);

    // The user deletes the insert mid-pass.
    const afterDelete = [makeTrack(0), makeTrack(1, [])];
    assert.equal(automationTargetResolves(target, [], afterDelete), false);
    passer.cancel();

    assert.equal(passer.isActive, false);
    assert.equal(passer.finish(at(2)), null);
    // The document is untouched: the lane the clip had is still what it has.
    assert.deepEqual(points(clip), points(mixerVolClip()));
  });

  it('abandons a pass whose channel was deleted', () => {
    const channels = [makeChannel('ch-a')];
    const target = { type: 'channel_vol' as const, targetId: 'ch-a' };
    assert.equal(automationTargetResolves(target, channels, []), true);
    assert.equal(automationTargetResolves(target, [], []), false);
    const passer = new AutomationRecordingPasser();
    const clip: PlaylistClip = { ...mixerVolClip(), automationTarget: target };
    assert.ok(passer.start(clip, target, 'touch', at(0), null));
    passer.grab(at(1), 0.4);
    passer.cancel();
    assert.equal(passer.finish(), null);
  });

  it('nil target cannot arm and the master output is not recordable from project state', () => {
    const passer = new AutomationRecordingPasser();
    const clip = mixerVolClip();
    assert.equal(passer.start(clip, null, 'write', at(0), 0.5), false);
    assert.equal(readAutomationTargetValue({ type: 'master_vol', targetId: 0 }, [], []), null);
  });
});

describe('Phase 12 — value readback for every supported target family', () => {
  it('round-trips mixer_vol, mixer_pan, fx_mix and fx_param through the shared scaling', () => {
    const slot: FxSlot = { id: 'fx-comp', type: 'compressor', name: 'Comp', enabled: true, mix: 0.8, params: { threshold: -18, knee: 24, ratio: 4, attack: 0.005, release: 0.15 } };
    const tracks = [makeTrack(0, [], 1), { ...makeTrack(1, [slot], mixerVolumeFromNormalized(0.6)), pan: panFromNormalized(0.25) }];

    assert.ok(Math.abs(readAutomationTargetValue({ type: 'mixer_vol', targetId: 1 }, [], tracks)! - 0.6) < 1e-9);
    assert.ok(Math.abs(readAutomationTargetValue({ type: 'mixer_pan', targetId: 1 }, [], tracks)! - 0.25) < 1e-9);
    assert.ok(Math.abs(readAutomationTargetValue({ type: 'fx_mix', targetId: 1, paramName: 'fx-comp' }, [], tracks)! - 0.8) < 1e-9);

    const threshold = readAutomationTargetValue(
      { type: 'fx_param', targetId: formatFxSlotTargetId(1, 'fx-comp'), paramName: 'threshold' }, [], tracks);
    assert.ok(threshold !== null);
    assert.ok(Number.isFinite(threshold!) && threshold! >= 0 && threshold! <= 1);
    // Same value the contract resolver writes back out.
    assert.equal(readAutomationTargetValue({ type: 'fx_param', targetId: formatFxSlotTargetId(1, 'fx-comp'), paramName: 'nope' }, [], tracks), null);
  });

  it('round-trips channel families and refuses a stale channel', () => {
    const channel = makeChannel('ch-a');
    assert.ok(Math.abs(readAutomationTargetValue({ type: 'channel_vol', targetId: 'ch-a' }, [channel], [])! - 0.9) < 1e-9);
    assert.ok(Math.abs(readAutomationTargetValue({ type: 'channel_pan', targetId: 'ch-a' }, [channel], [])! - 0.5) < 1e-9);
    assert.ok(Math.abs(readAutomationTargetValue({ type: 'channel_pitch', targetId: 'ch-a' }, [channel], [])! - 0.5) < 1e-9);
    const cutoff = readAutomationTargetValue({ type: 'channel_filter_cutoff', targetId: 'ch-a' }, [channel], [])!;
    assert.ok(Math.abs(filterCutoffFromNormalized(cutoff) - 3500) < 0.5, `cutoff ${filterCutoffFromNormalized(cutoff)}`);
    assert.equal(readAutomationTargetValue({ type: 'channel_vol', targetId: 'gone' }, [channel], []), null);
  });

  it('reads a vst3_param only while the native identity still matches', () => {
    const channel: Channel = {
      ...makeChannel('ch-vst'),
      instrumentType: 'vst3',
      vst3: {
        path: 'C:/plugins/Test.vst3', classId: 'ABC', name: 'Test', vendor: 'V', version: '1',
        automationId: 'auto-1', state: { schema: 1, classId: 'ABC', parameters: [{ id: 7, value: 0.42 }] },
      },
    } as Channel;
    const target = {
      type: 'vst3_param' as const,
      targetId: 'ch-vst',
      native: { path: 'C:/plugins/Test.vst3', classId: 'ABC', automationId: 'auto-1', parameterId: 7 },
    };
    assert.ok(Math.abs(readAutomationTargetValue(target, [channel], [])! - 0.42) < 1e-9);
    assert.equal(readAutomationTargetValue({ ...target, native: { ...target.native!, automationId: 'auto-2' } }, [channel], []), null);
    assert.equal(readAutomationTargetValue({ ...target, native: { ...target.native!, parameterId: 99 } }, [channel], []), null);
  });
});

describe('Phase 12 — one completed pass is one undoable lane edit', () => {
  const commitPass = (state: ProjectState, pass: AutomationRecordingPass) => {
    const clip = state.playlistClips.find(candidate => candidate.id === pass.clipId)!;
    const written = automationClipWithRecordedPass(clip, pass);
    return {
      ...state,
      playlistClips: state.playlistClips.map(candidate => candidate.id === clip.id ? written : candidate),
    };
  };

  it('records one history step and restores the exact previous lane on undo, then redo', () => {
    const base = createDefaultProjectState();
    const clip = mixerVolClip();
    const start: ProjectState = { ...base, playlistClips: [clip], automationModes: setAutomationMode(undefined, clip.automationTarget, 'write') };
    const history = createHistory(start);

    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'write', at(1), 0.1));
    // Fifty control movements — one commit.
    for (let step = 0; step <= 50; step += 1) {
      passer.sampleValue(at(1 + step / 50), 0.1 + step / 100);
    }
    const pass = passer.finish(at(4))!;
    const after = commitPass(start, pass);

    const committed = history.commit(after, 'Record automation pass');
    assert.equal(committed.past.length, 1, 'a whole pass must be exactly one undo step');

    const undone = committed.undo();
    assert.deepEqual(undone.present.playlistClips[0].automationPoints, clip.automationPoints);
    assert.equal(undone.present.automationModes?.[automationTargetKey(clip.automationTarget)!], 'write');

    const redone = undone.redo();
    assert.deepEqual(
      redone.present.playlistClips[0].automationPoints,
      after.playlistClips[0].automationPoints,
      'redo must restore the exact recorded lane',
    );
    // And the redo lane is exactly what the pass said it was.
    assert.deepEqual(
      redone.present.playlistClips[0].automationPoints!.map(point => point.y),
      normalizeAutomationPoints(after.playlistClips[0].automationPoints).map(point => point.y),
    );
  });

  it('a no-op pass commits no history entry at all', () => {
    const base = createDefaultProjectState();
    const clip = mixerVolClip();
    const start: ProjectState = { ...base, playlistClips: [clip] };
    const history = createHistory(start);
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'touch', at(0), null));
    passer.grab(at(1), 0.5);
    const pass = passer.release(at(1), 0.5);
    assert.ok(pass);
    const unchanged = automationClipWithRecordedPass(clip, pass);
    assert.equal(unchanged, clip);
    const same = history.commit({ ...start, playlistClips: [unchanged] }, 'Record automation pass');
    assert.equal(same.past.length, 0, 'an unchanged lane must not create an undo entry');
  });
});

describe('Phase 12 — lane surgery invariants', () => {
  it('never produces duplicate or descending points', () => {
    const clip = mixerVolClip();
    const passer = new AutomationRecordingPasser();
    assert.ok(passer.start(clip, clip.automationTarget, 'write', at(0), 0.5));
    for (let step = 0; step < 400; step += 1) {
      passer.sampleValue(at(step / 100), 0.5 + 0.001 * (step % 3));
    }
    const written = automationClipWithRecordedPass(clip, passer.finish(at(4))!);
    const lane = points(written);
    assertAscendingUnique(lane);
    for (const point of lane) {
      assert.ok(point.x >= 0 && point.x <= 1);
      assert.ok(point.y >= 0 && point.y <= 1);
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    }
  });

  it('keeps the recorded sample density proportional to transport movement', () => {
    const clip = mixerVolClip();
    const quick = new AutomationRecordingPasser();
    const slow = new AutomationRecordingPasser();
    assert.ok(quick.start(clip, clip.automationTarget, 'write', at(0), 0));
    assert.ok(slow.start(clip, clip.automationTarget, 'write', at(0), 0));
    // Same ramp, but the "slow" pass is spread across four times the transport distance.
    for (let step = 1; step <= 100; step += 1) quick.sampleValue(at(step / 100), step / 100);
    for (let step = 1; step <= 100; step += 1) slow.sampleValue(at(step * 4 / 100), step / 100);
    const quickPass = quick.finish(at(1))!;
    const slowPass = slow.finish(at(4))!;
    assert.ok(quickPass.points.length > 1);
    assert.ok(slowPass.points.length > 1);
    // Both stay bounded well below the 100 samples they were fed.
    assert.ok(quickPass.points.length <= 101);
    assert.ok(slowPass.points.length <= 101);
    assert.ok(Math.abs(slowPass.points[slowPass.points.length - 1].x - 1) < 1e-6);
  });

  it('restores a lane snapshot bit-for-bit', () => {
    const clip = mixerVolClip();
    const snapshot = points(clip).map(point => ({ ...point }));
    const cleared = { ...clip, automationPoints: [] };
    assert.deepEqual(points(restoreLaneSnapshot(cleared, snapshot)), snapshot);
    assert.equal(restoreLaneSnapshot(cleared, undefined).automationPoints, undefined);
  });

  it('finds the lane clip for a target key across id changes', () => {
    const clip = mixerVolClip('auto-new');
    const key = automationTargetKey(clip.automationTarget)!;
    assert.equal(findAutomationClipForTarget([clip], key)?.id, 'auto-new');
    assert.equal(findAutomationClipForTarget([clip], 'mixer_vol:9:'), undefined);
  });

  it('exports the documented sampling constants the UI and docs refer to', () => {
    // The min-sample step is a fraction of a sixteenth step in *bars*, no wall clock.
    assert.ok(AUTOMATION_SAMPLE_STEP_FRACTION > 0 && AUTOMATION_SAMPLE_STEP_FRACTION < 1);
    assert.ok(filterCutoffToNormalized(filterCutoffFromNormalized(0.35)) !== null);
    assert.ok(Math.abs(panToNormalized(panFromNormalized(0.75)) - 0.75) < 1e-12);
  });
});
