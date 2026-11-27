/**
 * Phase 12 — the App-side automation recording runtime.
 *
 * `automationRecording.ts` owns the *rules*; this module owns the *wiring*: it
 * keeps the recorder pointed at the live project state, feeds it transport
 * ticks and control changes, arms/finishes passes at the transport boundaries
 * the App already handles (pause, stop, seek, Song end), and asks the App to
 * commit a finished pass as ONE project mutation.
 *
 * Why a separate runtime and not state inside the component tree: a pass spans
 * many React renders (a fader drag emits dozens of changes), the transport
 * callback fires outside React, and a finished pass must be committed exactly
 * once. A plain object with a synchronous mutation port makes all three
 * deterministic and directly testable — the App only supplies ports and the
 * one-line boundary calls.
 */

import type {
  AutomationRecordingMode,
  MixerTrack,
  PlaylistClip,
  ProjectState,
} from '../types/daw';
import {
  AutomationRecordingPasser,
  automationClipWithRecordedPass,
  automationTargetKey,
  automationTargetResolves,
  readAutomationTargetValue,
  resolveAutomationMode,
  transportSampleFromPosition,
  type AutomationRecordingPass,
  type AutomationRecordingTarget,
  type TransportSample,
} from './automationRecording';
import { resolveProjectTimeSignature, type TimeSignature } from '../music/musicalTime';
import { mixerVolumeToNormalized } from './parameterScaling';

/** The transport position shape `audioEngine.getTransportMusicalPosition()` returns. */
export interface AutomationTransportPosition {
  bpm: number;
  playing: boolean;
  positionSeconds: number;
}

export interface AutomationRecordingRuntimePorts {
  /** The live project document (App keeps it in a ref for pointer-speed access). */
  getProjectState(): ProjectState;
  /** The audio engine's transport clock; never a wall clock. */
  getTransportPosition(): AutomationTransportPosition;
  /**
   * Publishes a finished pass through `mutateProjectState`, so it is exactly one
   * history entry, one autosave and one engine synchronisation.
   */
  commitPass(label: string, apply: (state: ProjectState) => ProjectState): void;
  /** Called after every state transition of the recorder so the UI can mirror it. */
  onChange?(): void;
}

export interface AutomationRecordingStatus {
  active: boolean;
  holding: boolean;
  mode: AutomationRecordingMode;
  targetKey: string | null;
  clipId: string | null;
  capturedPoints: number;
}

const EMPTY_STATUS: AutomationRecordingStatus = {
  active: false,
  holding: false,
  mode: 'read',
  targetKey: null,
  clipId: null,
  capturedPoints: 0,
};

const meterOf = (state: ProjectState): TimeSignature =>
  resolveProjectTimeSignature({ timeSignature: state.meta.timeSignature });

export class AutomationRecordingRuntime {
  private passer: AutomationRecordingPasser | null = null;
  private meter: TimeSignature | undefined;
  private lastPlaying = false;
  /** Last normalized value seen per target key, used when the model cannot be read. */
  private readonly knownValues = new Map<string, number>();

  constructor(private readonly ports: AutomationRecordingRuntimePorts) {}

  getStatus(): AutomationRecordingStatus {
    const passer = this.passer;
    if (!passer || !passer.isActive) return { ...EMPTY_STATUS };
    return {
      active: true,
      holding: passer.isHolding,
      mode: passer.activeMode,
      targetKey: passer.activeClip ? automationTargetKey(passer.activeClip.automationTarget) : null,
      clipId: passer.activeClip?.id ?? null,
      capturedPoints: passer.capturedCount,
    };
  }

  get isActive(): boolean {
    return Boolean(this.passer?.isActive);
  }

  private sample(): TransportSample {
    const state = this.ports.getProjectState();
    const position = this.ports.getTransportPosition();
    const meter = this.meter ?? meterOf(state);
    const sample = transportSampleFromPosition(position.positionSeconds, position.bpm || state.meta.bpm, meter);
    return { ...sample, playing: position.playing };
  }

  /**
   * Begins a pass for the automation clip that owns `target`, when that target's
   * configured mode records. Returns `false` (and arms nothing) for OFF/READ, a
   * clip that is not an automation lane, or an already-running pass.
   */
  arm(clip: PlaylistClip | null | undefined, target?: AutomationRecordingTarget | null): boolean {
    if (this.passer?.isActive) return false;
    if (!clip || clip.type !== 'automation') return false;
    const resolvedTarget = target ?? clip.automationTarget ?? null;
    if (!resolvedTarget) return false;
    const state = this.ports.getProjectState();
    const mode = resolveAutomationMode(state.automationModes, resolvedTarget);
    if (mode === 'off' || mode === 'read') return false;
    // A target whose model is already gone never starts a pass.
    if (!automationTargetResolves(resolvedTarget, state.channels, state.mixerTracks)) return false;

    this.meter = meterOf(state);
    const passer = new AutomationRecordingPasser({ meter: this.meter });
    const sample = this.sample();
    if (!sample.playing) return false;
    const value = this.readValue(resolvedTarget);
    if (!passer.start(clip, resolvedTarget, mode, sample, value)) {
      this.meter = undefined;
      return false;
    }
    this.passer = passer;
    this.ports.onChange?.();
    return true;
  }

  /** True when the control for `targetKey` is the one the active pass records. */
  isRecordingTarget(targetKey: string | null | undefined): boolean {
    if (!targetKey || !this.passer?.isActive) return false;
    const clip = this.passer.activeClip;
    return Boolean(clip) && automationTargetKey(clip!.automationTarget) === targetKey;
  }

  /**
   * A control's new value, already normalized 0..1 by the caller's funnel.
   * Everything the mixer, channel rack and FX panels publish reaches the lane
   * through this one entry point; there is no second capture path.
   */
  reportValue(target: AutomationRecordingTarget | null | undefined, normalizedValue: number | null | undefined): boolean {
    const key = automationTargetKey(target ?? null);
    if (key && typeof normalizedValue === 'number' && Number.isFinite(normalizedValue)) {
      this.knownValues.set(key, Math.max(0, Math.min(1, normalizedValue)));
    }
    const passer = this.passer;
    if (!passer?.isActive) return false;
    if (!this.isRecordingTarget(key)) return false;
    const wrote = passer.sampleValue(this.sample(), normalizedValue);
    if (wrote) this.ports.onChange?.();
    return wrote;
  }

  /**
   * The user grabbed a control (pointer down).
   *
   * `target` may be omitted by call sites that know a gesture started but not
   * which lane it belongs to (the mixer's faders and pan knobs already funnel
   * their value through `reportValue`, so the armed lane is the right owner).
   * Passing `null` explicitly means "no lane" and is a no-op.
   */
  beginGesture(target?: AutomationRecordingTarget | null): boolean {
    const resolved = this.gestureTarget(target);
    if (!resolved) return false;
    const passer = this.passer!;
    const sample = this.sample();
    const wrote = passer.grab(sample, this.readValue(resolved));
    if (wrote) this.ports.onChange?.();
    return wrote;
  }

  /** The user released a control. TOUCH closes its pass here; LATCH keeps holding. */
  endGesture(target?: AutomationRecordingTarget | null): boolean {
    const resolved = this.gestureTarget(target);
    if (!resolved) return false;
    const passer = this.passer!;
    const sample = this.sample();
    const pass = passer.release(sample, this.readValue(resolved));
    this.ports.onChange?.();
    if (!pass) return true;
    this.passer = null;
    this.meter = undefined;
    this.commit(pass);
    return true;
  }

  /**
   * Resolves which target a gesture applies to: an explicit target must match the
   * armed pass, an omitted one falls back to the armed pass's own target.
   */
  private gestureTarget(target?: AutomationRecordingTarget | null): AutomationRecordingTarget | null {
    const passer = this.passer;
    if (!passer?.isActive) return null;
    const clip = passer.activeClip;
    if (!clip?.automationTarget) return null;
    if (target === undefined) return clip.automationTarget;
    if (target === null) return null;
    return this.isRecordingTarget(automationTargetKey(target)) ? target : null;
  }

  /**
   * Transport advanced. Called from the App's existing transport-state
   * subscription.
   *
   * Two jobs:
   *   1. Arm a pass for every lane whose configured mode records and whose clip
   *      covers the playhead — a WRITE/TOUCH/LATCH lane records itself as soon as
   *      the transport plays through it, the way a DAW lane in those modes does.
   *      Nothing is armed while the transport is stopped.
   *   2. Feed the running pass a tick, so WRITE and LATCH cover the interval
   *      they ran over even when the control itself did not move.
   */
  tick(): void {
    const position = this.ports.getTransportPosition();
    const passer = this.passer;
    if (!passer?.isActive) {
      this.lastPlaying = position.playing;
      if (position.playing) this.armLaneAtPlayhead();
      return;
    }
    const sample = this.sample();
    // A transport that stopped without an App boundary call is still a boundary:
    // a pass can never span a stopped transport.
    if (!position.playing && this.lastPlaying) {
      this.lastPlaying = false;
      this.finish();
      return;
    }
    this.lastPlaying = position.playing;
    if (passer.sampleTick({ ...sample, playing: position.playing })) this.ports.onChange?.();
  }

  /**
   * Closes the running pass at the current transport position and commits it.
   * Call before the App moves the playhead (stop, pause, seek, Song end) so the
   * pass ends where the audio actually stopped.
   */
  finish(reason?: string): boolean {
    const passer = this.passer;
    if (!passer?.isActive) return false;
    const pass = passer.finish(this.sample());
    this.passer = null;
    this.meter = undefined;
    this.lastPlaying = false;
    this.ports.onChange?.();
    if (!pass) return false;
    this.commit(pass, reason);
    return true;
  }

  /** Discards the pass without touching the document (project replaced, target deleted). */
  cancel(): void {
    this.passer?.cancel();
    this.passer = null;
    this.meter = undefined;
    this.lastPlaying = false;
    this.ports.onChange?.();
  }

  /**
   * Guards a running pass against a structural edit that removed its target:
   * a deleted mixer insert, channel or FX slot cancels the pass instead of
   * letting it commit points nothing can resolve. Called by the App after every
   * project mutation.
   */
  reconcileWithProject(): void {
    const passer = this.passer;
    if (!passer?.isActive) return;
    const clip = passer.activeClip;
    const state = this.ports.getProjectState();
    const target = clip?.automationTarget ?? null;
    const laneClip = clip ? state.playlistClips.find(candidate => candidate.id === clip.id) : undefined;
    if (!clip || !target || !laneClip || laneClip.type !== 'automation') {
      this.cancel();
      return;
    }
    // The target must still resolve, and its lane must still be in a recording
    // mode: switching a lane to READ/OFF mid-pass stops recording immediately.
    if (!automationTargetResolves(target, state.channels, state.mixerTracks)) {
      this.cancel();
      return;
    }
    const mode = resolveAutomationMode(state.automationModes, target);
    if (mode === 'off' || mode === 'read') this.cancel();
  }

  /**
   * Arms the pass for whichever recording-mode lane the playhead is inside.
   *
   * One lane at a time: a pass records one target, and arming a second target
   * mid-pass would silently retarget what the user is performing. If the
   * playhead is inside several recording lanes, the lowest track/clip order wins
   * and the others arm on the next tick after this pass closes.
   */
  private armLaneAtPlayhead(): boolean {
    const state = this.ports.getProjectState();
    if (!state.automationModes) return false;
    const position = this.ports.getTransportPosition();
    const meter = meterOf(state);
    const sample = transportSampleFromPosition(position.positionSeconds, position.bpm || state.meta.bpm, meter);
    for (const clip of state.playlistClips) {
      if (clip.type !== 'automation' || clip.mute || !clip.automationTarget) continue;
      if (!Number.isFinite(clip.startBar) || !Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0) continue;
      if (sample.positionBars < clip.startBar || sample.positionBars > clip.startBar + clip.lengthBars) continue;
      if (resolveAutomationMode(state.automationModes, clip.automationTarget) === 'read') continue;
      return this.arm(clip, clip.automationTarget);
    }
    return false;
  }

  private readValue(target: AutomationRecordingTarget | null | undefined): number | null {
    const state = this.ports.getProjectState();
    const key = automationTargetKey(target ?? null);
    const known = key ? this.knownValues.get(key) : undefined;
    const model = readAutomationTargetValue(target ?? null, state.channels, state.mixerTracks);
    if (model !== null) return model;
    return known ?? null;
  }

  private commit(pass: AutomationRecordingPass, reason?: string): void {
    const state = this.ports.getProjectState();
    const clip = state.playlistClips.find(candidate => candidate.id === pass.clipId);
    if (!clip) return;
    // The lane surgery is pure; a pass that changed nothing returns the same
    // clip and must not create an undo entry.
    const updated = automationClipWithRecordedPass(clip, pass);
    if (updated === clip) return;
    const labelName = clip.automationTarget?.label?.trim() || clip.name;
    this.ports.commitPass(
      `Record automation pass (${labelName})`,
      current => {
        // Re-read the clip inside the updater: a sibling edit between the pass
        // ending and this commit must not be clobbered.
        const live = current.playlistClips.find(candidate => candidate.id === pass.clipId);
        if (!live) return current;
        const next = automationClipWithRecordedPass(live, pass);
        if (next === live) return current;
        return {
          ...current,
          playlistClips: current.playlistClips.map(candidate => candidate.id === live.id ? next : candidate),
        };
      },
    );
    void reason;
  }
}

/** The mode map entry a target currently resolves to, for the UI. */
export const automationModeForTarget = (
  state: Pick<ProjectState, 'automationModes'>,
  target: AutomationRecordingTarget | null | undefined,
): AutomationRecordingMode => resolveAutomationMode(state.automationModes, target);

/** Lane clips grouped by target key — what the playlist automation editor lists. */
export const automationLaneClipsByTarget = (
  clips: readonly PlaylistClip[],
): Array<{ targetKey: string; target: AutomationRecordingTarget; clips: PlaylistClip[] }> => {
  const groups = new Map<string, { targetKey: string; target: AutomationRecordingTarget; clips: PlaylistClip[] }>();
  for (const clip of clips) {
    if (clip.type !== 'automation' || !clip.automationTarget) continue;
    const key = automationTargetKey(clip.automationTarget);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.clips.push(clip);
    else groups.set(key, { targetKey: key, target: clip.automationTarget, clips: [clip] });
  }
  return [...groups.values()].sort((left, right) => left.targetKey.localeCompare(right.targetKey));
};

/** True when a target can be recorded: automation target types the model reads back. */
export const canRecordTarget = (target: AutomationRecordingTarget | null | undefined): boolean =>
  Boolean(automationTargetKey(target)) && target?.type !== 'master_vol';

/**
 * Normalized 0..1 value of a mixer track's fader, for the Mixer's capture call.
 * Delegates to the shared inverse in `parameterScaling`, so the value a lane
 * records from the fader is the exact value `applyAutomationValue` maps back.
 */
export const mixerTrackVolumeNormalized = (track: Pick<MixerTrack, 'volume'>): number =>
  mixerVolumeToNormalized(Number(track.volume));
