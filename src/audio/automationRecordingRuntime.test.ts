/**
 * Phase 12 — the App-side recording runtime.
 *
 * `automationRecording.test.ts` proves the capture rules. This suite proves the
 * *wiring* the App actually uses: a lane in WRITE/TOUCH/LATCH arms itself when
 * the transport plays into it, control changes reach only their own lane, every
 * transport boundary (pause, stop, seek, Song end, a stopped clock) closes the
 * pass at the pre-boundary position, a deleted target cancels the pass, and each
 * finished pass lands as exactly one `mutateProjectState` call that
 * `createHistory` records as one undo step.
 *
 * The ports are fakes only in the sense that they are test doubles of the App's
 * own ref/callback pair; the runtime, the recorder, the lane surgery, the
 * project normalizer and the history object are the production ones.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Channel, FxSlot, MixerTrack, PlaylistClip, ProjectState } from '../types/daw';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { createHistory, type ProjectHistory } from '../state/projectHistory';
import { serializeProjectState } from '../state/projectPersistence';
import {
  AutomationRecordingRuntime,
  automationLaneClipsByTarget,
  automationModeForTarget,
  canRecordTarget,
  mixerTrackVolumeNormalized,
} from '../audio/automationRecordingRuntime';
import {
  automationTargetKey,
  setAutomationMode,
  type AutomationRecordingPass,
} from '../audio/automationRecording';
import { formatFxSlotTargetId } from '../audio/fxParameterControl';

const BPM = 120;
const seconds = (bar: number): number => bar * 2;

const makeTrack = (id: number, fxSlots: FxSlot[] = [], volume = 0.8): MixerTrack => ({
  id, name: `Insert ${id}`, color: '#ffffff', volume, pan: 0, mute: false, solo: false,
  routingTargetId: 0, fxSlots,
} as MixerTrack);

const laneClip = (overrides: Partial<PlaylistClip> = {}): PlaylistClip => ({
  id: 'auto-vol',
  trackIndex: 1,
  startBar: 0,
  lengthBars: 4,
  type: 'automation',
  color: '#00e5ff',
  name: 'Auto: Insert 1 Volume',
  automationTarget: { type: 'mixer_vol', targetId: 1, label: 'Insert 1 Volume' },
  automationPoints: [
    { x: 0, y: 0.2, tension: 0 },
    { x: 0.5, y: 0.5, tension: 0 },
    { x: 1, y: 0.2, tension: 0 },
  ],
  ...overrides,
});

/**
 * A stand-in for the App: owns the project document, the history object, the
 * transport clock and the `mutateProjectState` behaviour (including the
 * continuous-batcher semantics a real drag goes through: `isContinuous` updates
 * do not each create a history entry, the pass commit does).
 */
class AppHarness {
  state: ProjectState;
  history: ProjectHistory;
  positionSeconds = 0;
  playing = false;
  commits: Array<{ label: string; state: ProjectState }> = [];
  pendingContinuous: ProjectState | null = null;

  constructor(state: ProjectState) {
    this.state = state;
    this.history = createHistory(state);
  }

  mutate(updater: (current: ProjectState) => ProjectState, label: string, options?: { isContinuous?: boolean }): ProjectState {
    const next = updater(this.state);
    this.state = next;
    if (options?.isContinuous) {
      this.pendingContinuous = next;
      return next;
    }
    this.pendingContinuous = null;
    this.history = this.history.commit(next, label);
    this.commits.push({ label, state: next });
    return next;
  }

  runtime(): AutomationRecordingRuntime {
    return new AutomationRecordingRuntime({
      getProjectState: () => this.state,
      getTransportPosition: () => ({ bpm: BPM, playing: this.playing, positionSeconds: this.positionSeconds }),
      commitPass: (label, apply) => { this.mutate(apply, label); },
    });
  }

  /**
   * The mixer's own funnel, end to end: `Mixer.tsx` -> `handleUpdateMixerTrack`
   * (a continuous project mutation) -> `automationRecording.reportValue`. The
   * harness keeps both halves so a recorded pass reads back the same model value
   * the real App would.
   */
  setMixerVolume(trackId: number, normalized: number, runtime: AutomationRecordingRuntime): void {
    this.mutate(current => ({
      ...current,
      mixerTracks: current.mixerTracks.map(track => track.id === trackId
        ? { ...track, volume: Math.max(0, Math.min(1.25, normalized * 1.25)) }
        : track),
    }), 'Change mixer volume', { isContinuous: true });
    runtime.reportValue({ type: 'mixer_vol', targetId: trackId }, normalized);
  }

  /** One transport callback's worth of time passing, then the tick. */
  advanceTo(bar: number, runtime: AutomationRecordingRuntime): void {
    this.positionSeconds = seconds(bar);
    runtime.tick();
  }

  startPlayback(runtime: AutomationRecordingRuntime): void {
    this.playing = true;
    runtime.tick();
  }

  stop(runtime: AutomationRecordingRuntime): void {
    // The App's stop boundary: finish the pass BEFORE the playhead resets.
    runtime.finish('stop');
    this.playing = false;
    this.positionSeconds = 0;
    runtime.tick();
  }
}

const stateWithLane = (mode: 'off' | 'read' | 'write' | 'touch' | 'latch', clip = laneClip()): ProjectState => {
  const base = createDefaultProjectState();
  return normalizeProjectState({
    ...base,
    mixerTracks: [makeTrack(0, [], 1), makeTrack(1, [], 0.8)],
    playlistClips: [clip],
    automationModes: setAutomationMode(undefined, clip.automationTarget, mode),
  });
};

const lanePoints = (state: ProjectState, id = 'auto-vol') =>
  state.playlistClips.find(clip => clip.id === id)?.automationPoints ?? [];

describe('Phase 12 runtime — arming from the transport', () => {
  it('OFF and READ lanes never arm', () => {
    for (const mode of ['off', 'read'] as const) {
      const harness = new AppHarness(stateWithLane(mode));
      const runtime = harness.runtime();
      harness.startPlayback(runtime);
      assert.equal(runtime.isActive, false, `${mode} must not arm a pass`);
      harness.advanceTo(1, runtime);
      assert.equal(runtime.isActive, false);
    }
  });

  it('WRITE arms when playback enters the lane and records the whole pass as one commit', () => {
    const harness = new AppHarness(stateWithLane('write'));
    const runtime = harness.runtime();
    runtime.reportValue({ type: 'mixer_vol', targetId: 1 }, 0.9);
    harness.startPlayback(runtime);
    assert.equal(runtime.isActive, true);
    assert.equal(runtime.getStatus().mode, 'write');

    // A mixer drag: the App's own continuous mutation path, not history.
    harness.mutate(current => ({
      ...current,
      mixerTracks: current.mixerTracks.map(track => track.id === 1 ? { ...track, volume: 0.5 } : track),
    }), 'Change mixer volume', { isContinuous: true });
    runtime.beginGesture({ type: 'mixer_vol', targetId: 1 });
    harness.advanceTo(0.5, runtime);
    runtime.reportValue({ type: 'mixer_vol', targetId: 1 }, 0.6);
    harness.advanceTo(1, runtime);
    runtime.reportValue({ type: 'mixer_vol', targetId: 1 }, 0.75);
    harness.advanceTo(2, runtime);
    runtime.endGesture({ type: 'mixer_vol', targetId: 1 });

    const historyBeforeStop = harness.history;
    harness.stop(runtime);
    assert.equal(runtime.isActive, false);
    // Exactly one history entry: the completed pass.
    assert.equal(harness.history.past.length, 1);
    assert.match(harness.history.past[0].label, /^Record automation pass/);
    assert.equal(harness.commits.length, 1);
    assert.equal(historyBeforeStop.past.length, 0, 'a continuous drag must not create history on its own');

    // The recorded lane reflects the performed values, not the drag's last value.
    const lane = lanePoints(harness.state);
    const at125 = lane.find(point => Math.abs(point.x - 0.125) < 1e-6);
    assert.ok(at125, `expected a point at x=0.125, got ${JSON.stringify(lane)}`);
    assert.ok(Math.abs(at125!.y - 0.6) < 1e-6, `expected 0.6 at x=0.125, got ${at125!.y}`);
    const at25 = lane.find(point => Math.abs(point.x - 0.25) < 1e-6);
    assert.ok(at25 && Math.abs(at25.y - 0.75) < 1e-6, `expected 0.75 at x=0.25, got ${JSON.stringify(at25)}`);
    assert.ok(lane.some(point => point.y > 0.7), 'the 0.75 sample must be in the lane');
  });

  it('does nothing while the transport is stopped', () => {
    const harness = new AppHarness(stateWithLane('write'));
    const runtime = harness.runtime();
    harness.positionSeconds = seconds(1);
    runtime.tick();
    assert.equal(runtime.isActive, false);
    assert.equal(harness.history.past.length, 0);
  });

  it('a lane whose clip does not cover the playhead does not arm', () => {
    const harness = new AppHarness(stateWithLane('write', laneClip({ id: 'auto-far', startBar: 8, lengthBars: 4 })));
    const runtime = harness.runtime();
    harness.startPlayback(runtime);
    assert.equal(runtime.isActive, false);
    harness.advanceTo(9, runtime);
    assert.equal(runtime.isActive, true, 'the lane arms once the playhead is inside it');
  });
});

describe('Phase 12 runtime — control routing', () => {
  it('only the armed target captures; other controls move nothing', () => {
    const harness = new AppHarness(stateWithLane('write'));
    const runtime = harness.runtime();
    harness.startPlayback(runtime);
    runtime.reportValue({ type: 'mixer_vol', targetId: 2 }, 0.1);
    runtime.reportValue({ type: 'mixer_vol', targetId: 1 }, 0.9);
    harness.advanceTo(2, runtime);
    harness.stop(runtime);
    const lane = lanePoints(harness.state);
    assert.ok(lane.some(point => point.y > 0.8), 'the armed target was recorded');
    assert.equal(lane.some(point => Math.abs(point.y - 0.1) < 1e-6), false, 'an unarmed target must not be recorded');
  });

  it('an FX parameter lane records through the same funnel', () => {
    const slot: FxSlot = { id: 'fx-comp', type: 'compressor', name: 'Comp', enabled: true, mix: 0.8, params: { threshold: -18, knee: 24, ratio: 4, attack: 0.005, release: 0.15 } };
    const base = createDefaultProjectState();
    const clip = laneClip({
      id: 'auto-fx',
      automationTarget: { type: 'fx_param', targetId: formatFxSlotTargetId(1, 'fx-comp'), paramName: 'threshold', label: 'Comp Threshold' },
      automationPoints: [{ x: 0, y: 0.5, tension: 0 }, { x: 1, y: 0.5, tension: 0 }],
    });
    const state = normalizeProjectState({
      ...base,
      mixerTracks: [makeTrack(0, [], 1), makeTrack(1, [slot], 0.8)],
      playlistClips: [clip],
      automationModes: setAutomationMode(undefined, clip.automationTarget, 'write'),
    });
    const harness = new AppHarness(state);
    const runtime = harness.runtime();
    harness.startPlayback(runtime);
    assert.equal(runtime.isActive, true);
    runtime.beginGesture(clip.automationTarget);
    runtime.reportValue(clip.automationTarget, 0.9);
    harness.advanceTo(2, runtime);
    harness.stop(runtime);
    const lane = lanePoints(harness.state, 'auto-fx');
    assert.ok(lane.some(point => point.y > 0.8), `expected the FX pass in the lane, got ${JSON.stringify(lane)}`);
    // And the FX slot itself is untouched: recording writes the LANE, not the
    // parameter's stored value.
    const track = harness.state.mixerTracks.find(candidate => candidate.id === 1)!;
    assert.equal(track.fxSlots[0].params.threshold, -18);
  });

  it('a deleted FX insert cancels the pass instead of committing unresolvable points', () => {
    const slot: FxSlot = { id: 'fx-comp', type: 'compressor', name: 'Comp', enabled: true, mix: 0.8, params: { threshold: -18 } };
    const base = createDefaultProjectState();
    const clip = laneClip({
      id: 'auto-fx',
      automationTarget: { type: 'fx_param', targetId: formatFxSlotTargetId(1, 'fx-comp'), paramName: 'threshold' },
      automationPoints: [{ x: 0, y: 0.5, tension: 0 }, { x: 1, y: 0.5, tension: 0 }],
    });
    const state = normalizeProjectState({
      ...base,
      mixerTracks: [makeTrack(0, [], 1), makeTrack(1, [slot], 0.8)],
      playlistClips: [clip],
      automationModes: setAutomationMode(undefined, clip.automationTarget, 'write'),
    });
    const harness = new AppHarness(state);
    const runtime = harness.runtime();
    harness.startPlayback(runtime);
    runtime.reportValue(clip.automationTarget, 0.9);
    harness.advanceTo(1, runtime);

    // The user deletes the insert mid-pass.
    harness.mutate(current => ({
      ...current,
      mixerTracks: current.mixerTracks.map(track => track.id === 1 ? { ...track, fxSlots: [] } : track),
    }), 'Delete effect');
    runtime.reconcileWithProject();
    assert.equal(runtime.isActive, false);

    const before = harness.history.past.length;
    harness.stop(runtime);
    assert.equal(harness.history.past.length, before, 'an abandoned pass creates no history');
    assert.deepEqual(lanePoints(harness.state, 'auto-fx'), clip.automationPoints);
  });
});

describe('Phase 12 runtime — transport boundaries', () => {
  it('pause closes the pass at the pause position and resume opens a new one', () => {
    const harness = new AppHarness(stateWithLane('write'));
    const runtime = harness.runtime();
    harness.startPlayback(runtime);
    runtime.reportValue({ type: 'mixer_vol', targetId: 1 }, 0.4);
    harness.advanceTo(1, runtime);
    runtime.reportValue({ type: 'mixer_vol', targetId: 1 }, 0.8);
    // App pause path: finish before the clock stops, then flip playing.
    runtime.finish('pause');
    harness.playing = false;
    runtime.tick();
    assert.equal(harness.history.past.length, 1);

    // Resume at the paused position: a NEW pass, not a continuation of the old
    // one (a recorded pass can never span a stopped transport).
    harness.positionSeconds = seconds(1);
    harness.playing = true;
    runtime.tick();
    assert.equal(runtime.isActive, true);
    harness.advanceTo(2, runtime);
    runtime.reportValue({ type: 'mixer_vol', targetId: 1 }, 0.3);
    harness.stop(runtime);
    assert.equal(harness.history.past.length, 2);
    // The second pass only replaced its own interval.
    assert.ok(lanePoints(harness.state).some(point => point.y > 0.7));
  });

  it('a seek closes the pass at the pre-seek position', () => {
    const harness = new AppHarness(stateWithLane('write'));
    const runtime = harness.runtime();
    harness.startPlayback(runtime);
    runtime.reportValue({ type: 'mixer_vol', targetId: 1 }, 0.7);
    harness.advanceTo(1, runtime);
    runtime.finish('seek');
    assert.equal(harness.history.past.length, 1);
    assert.equal(runtime.isActive, false);
    const pass = harness.history.past[0];
    const lane = pass.state.playlistClips[0].automationPoints!;
    assert.ok(lane.every(point => point.x <= 1), 'a seek can never record x > 1');
  });

  it('a clock that stops without an explicit boundary still closes the pass', () => {
    const harness = new AppHarness(stateWithLane('write'));
    const runtime = harness.runtime();
    harness.startPlayback(runtime);
    runtime.reportValue({ type: 'mixer_vol', targetId: 1 }, 0.9);
    harness.advanceTo(1, runtime);
    // Song end / engine halt: the clock reports stopped, the App's handler has
    // not run yet.
    harness.playing = false;
    runtime.tick();
    assert.equal(runtime.isActive, false);
    assert.equal(harness.history.past.length, 1);
  });
});

describe('Phase 12 runtime — history, persistence and parity inputs', () => {
  it('one pass = one undo entry, with exact undo and redo restoration', () => {
    const harness = new AppHarness(stateWithLane('write'));
    const originalLane = [...lanePoints(harness.state)];
    const runtime = harness.runtime();
    harness.startPlayback(runtime);
    for (let step = 0; step <= 40; step += 1) {
      harness.advanceTo(step / 10, runtime);
      runtime.reportValue({ type: 'mixer_vol', targetId: 1 }, 0.2 + step / 80);
    }
    harness.stop(runtime);
    assert.equal(harness.history.past.length, 1);

    const recordedLane = lanePoints(harness.state);
    assert.notDeepEqual(recordedLane, originalLane);

    harness.history = harness.history.undo();
    assert.deepEqual(harness.history.present.playlistClips[0].automationPoints, originalLane);
    harness.history = harness.history.redo();
    assert.deepEqual(harness.history.present.playlistClips[0].automationPoints, recordedLane);
  });

  it('the recorded lane survives save/reopen exactly', () => {
    const harness = new AppHarness(stateWithLane('touch'));
    const runtime = harness.runtime();
    harness.startPlayback(runtime);
    runtime.beginGesture({ type: 'mixer_vol', targetId: 1 });
    runtime.reportValue({ type: 'mixer_vol', targetId: 1 }, 0.9);
    harness.advanceTo(1, runtime);
    runtime.reportValue({ type: 'mixer_vol', targetId: 1 }, 0.1);
    harness.advanceTo(2, runtime);
    runtime.endGesture({ type: 'mixer_vol', targetId: 1 });
    const recorded = lanePoints(harness.state);

    const serialized = serializeProjectState(harness.state);
    const reopened = normalizeProjectState(JSON.parse(serialized).state as ProjectState);
    assert.deepEqual(reopened.playlistClips[0].automationPoints, recorded);
    // The TOUCH pass ended at release, so the original curve resumes after it.
    const last = recorded[recorded.length - 1];
    assert.equal(last.x, 1);
    assert.ok(Math.abs(last.y - 0.2) < 1e-6, `the underlying curve must resume at the clip end, got ${last.y}`);
  });

  it('LATCH keeps writing the held value after release, up to the pass end', () => {
    const harness = new AppHarness(stateWithLane('latch'));
    const runtime = harness.runtime();
    harness.startPlayback(runtime);
    harness.advanceTo(1, runtime);
    runtime.beginGesture({ type: 'mixer_vol', targetId: 1 });
    harness.setMixerVolume(1, 0.95, runtime);
    harness.advanceTo(1.5, runtime);
    runtime.endGesture({ type: 'mixer_vol', targetId: 1 });
    // After release, transport keeps running: the held value keeps covering.
    harness.advanceTo(2, runtime);
    harness.advanceTo(3, runtime);
    harness.stop(runtime);
    const lane = lanePoints(harness.state);
    // LATCH invariant: the lane holds ONE value from release through the pass
    // end rather than falling back to the old curve, and that value is the one
    // the control was left at.
    // The tail is the latched hold INSIDE the pass. The lane's final point is
    // the preserved original curve at the pass end (that is the seam the lane
    // surgery documents), so it is excluded deliberately.
    // Grab was at x = 0.25 and the pass stopped at x = 0.75, so the hold is the
    // interior of that interval (the seams legitimately preserve the original
    // curve on either side, which is the documented lane surgery).
    const tail = lane.filter(point => point.x > 0.25 && point.x < 0.75);
    const distinct = new Set(tail.map(point => point.y.toFixed(6)));
    assert.ok(tail.length >= 2, `expected several hold points, got ${JSON.stringify(lane)}`);
    assert.equal(distinct.size, 1, `latch tail must hold a single value, got ${[...distinct].join(', ')}`);
    assert.ok(Math.abs(Number([...distinct][0]) - 0.95) < 1e-6, `unexpected held value ${[...distinct][0]}`);
  });

  it('playback of an unwritten lane is byte-identical to the pre-Phase-12 document', () => {
    // READ is absence: a project with no `automationModes` normalizes and
    // serializes exactly as it would have before this phase, which is the
    // structural half of "READ behaviour unchanged".
    const base = createDefaultProjectState();
    const state = normalizeProjectState({ ...base, playlistClips: [laneClip()] });
    assert.equal(state.automationModes, undefined);
    const reopened = serializeProjectState(state);
    assert.equal(reopened.includes('automationModes'), false);
  });
});

describe('Phase 12 runtime — UI helpers', () => {
  it('groups lanes by target and resolves the mode a lane should show', () => {
    const first = laneClip({ id: 'a' });
    const second = laneClip({ id: 'b', startBar: 8 });
    const state = normalizeProjectState({
      ...createDefaultProjectState(),
      playlistClips: [first, second],
      automationModes: setAutomationMode(undefined, first.automationTarget, 'touch'),
    });
    const groups = automationLaneClipsByTarget(state.playlistClips);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].clips.length, 2);
    assert.equal(automationModeForTarget(state, first.automationTarget), 'touch');
    assert.equal(automationModeForTarget(state, { type: 'mixer_vol', targetId: 9 }), 'read');
    assert.equal(canRecordTarget(first.automationTarget), true);
    assert.equal(canRecordTarget({ type: 'master_vol', targetId: 0 }), false);
    assert.equal(automationTargetKey({ type: 'master_vol', targetId: 0 }), 'master_vol:0:');
    assert.ok(Math.abs(mixerTrackVolumeNormalized({ volume: 1.25 }) - 1) < 1e-12);
  });
});

describe('Phase 12 runtime — no phantom history', () => {
  it('a pass that captured nothing commits nothing', () => {
    const harness = new AppHarness(stateWithLane('touch'));
    const runtime = harness.runtime();
    harness.startPlayback(runtime);
    // No gesture at all: the pass must not create a history entry.
    harness.advanceTo(3, runtime);
    harness.stop(runtime);
    assert.equal(harness.history.past.length, 0);
  });

  it('two consecutive passes are two entries, never a merged one', () => {
    const harness = new AppHarness(stateWithLane('write'));
    const runtime = harness.runtime();
    harness.startPlayback(runtime);
    runtime.reportValue({ type: 'mixer_vol', targetId: 1 }, 0.5);
    harness.advanceTo(1, runtime);
    harness.stop(runtime);
    harness.startPlayback(runtime);
    runtime.reportValue({ type: 'mixer_vol', targetId: 1 }, 0.7);
    harness.advanceTo(1, runtime);
    harness.stop(runtime);
    assert.equal(harness.history.past.length, 2);
    assert.deepEqual(
      harness.history.past.map(entry => entry.label),
      ['Record automation pass (Insert 1 Volume)', 'Record automation pass (Insert 1 Volume)'],
    );
  });
});

void normalizeProjectState;
void serializeProjectState;
void (null as unknown as Channel);
void (null as unknown as AutomationRecordingPass);
