import { normalizeMixerTrackIdentityIntegrity } from './mixerTrackIdentity';
import { applyMacroRackUpdate } from './macroMappings';
import type {
  Channel,
  CollabComment,
  FxSlot,
  GrossBeatState,
  MasterMacroKnob,
  MidiMapping,
  MixerTrack,
  Pattern,
  ProjectMetadata,
  ProjectState,
  VocalTunerSettings
} from '../types/daw';
import { DEFAULT_GROSS_BEAT_STATE } from './projectState';
import { isRuntimeSupportedMeter, resolveProjectTimeSignature } from '../music/musicalTime';
import { formatTimeSignature, isSameTimeSignature, isSevenEightGrouping, resolveSevenEightGrouping } from '../music/meterPulse';
import { isCountInBars, type CountInBars } from '../music/countIn';
import { isPunchRecordingSettings, isSamePunchRecording, resolvePunchRecording, validatePunchRecording, type PunchRecordingSettings } from '../music/punchRecording';
import { getProjectTimelineBars } from './playlistTimeline';

/**
 * Authoritative runtime mutation boundary for ProjectState.
 * Every state mutation that reaches the live playback graph is normalized
 * against the existing mixer identity invariant before publication.
 */
export const applyRuntimeProjectStateMutation = (
  state: ProjectState,
  updater: (current: ProjectState) => ProjectState
): ProjectState => normalizeMixerTrackIdentityIntegrity(updater(state));

export const updateChannelInProjectState = (
  state: ProjectState,
  channelId: string,
  updates: Partial<Channel>
): ProjectState => ({
  ...state,
  channels: state.channels.map(ch => (ch.id === channelId ? { ...ch, ...updates } : ch))
});

export const updateMixerTrackInProjectState = (
  state: ProjectState,
  trackId: number,
  updates: Partial<MixerTrack>
): ProjectState => ({
  ...state,
  mixerTracks: state.mixerTracks.map(t => (t.id === trackId ? { ...t, ...updates } : t))
});

/**
 * Phase 70 — the collaboration panel's local author label.
 *
 * This build has no accounts and no network sync, so a note written here is
 * authored by the operator of this session. The label is deliberately generic:
 * the previous "Alex (You)" / "Maya Beats" identities were demo data and were
 * never part of the project document.
 */
export const LOCAL_COLLAB_AUTHOR = 'You';
export const LOCAL_COLLAB_AUTHOR_COLOR = '#ff6e00';

/** A note about to be stored in the project, stamped with the caller's clock. */
export const createLocalCollabComment = (
  text: string,
  barPosition: number,
  now: number,
  id: string = `c-${now}`
): CollabComment => ({
  id,
  author: LOCAL_COLLAB_AUTHOR,
  avatarColor: LOCAL_COLLAB_AUTHOR_COLOR,
  timestamp: now,
  barPosition,
  text,
  resolved: false
});

/** Newest note first, exactly like the panel has always listed them. */
export const addCollabCommentInProjectState = (
  state: ProjectState,
  comment: CollabComment
): ProjectState => ({
  ...state,
  comments: [comment, ...state.comments]
});

export const toggleCollabCommentResolvedInProjectState = (
  state: ProjectState,
  commentId: string
): ProjectState => ({
  ...state,
  comments: state.comments.map(comment =>
    comment.id === commentId ? { ...comment, resolved: !comment.resolved } : comment
  )
});

export const addFxSlotToProjectState = (
  state: ProjectState,
  trackId: number,
  slot: FxSlot
): ProjectState => ({
  ...state,
  mixerTracks: state.mixerTracks.map(t => {
    if (t.id === trackId) {
      return { ...t, fxSlots: [...t.fxSlots, slot] };
    }
    return t;
  })
});

export const deleteFxSlotFromProjectState = (
  state: ProjectState,
  trackId: number,
  slotId: string
): ProjectState => ({
  ...state,
  mixerTracks: state.mixerTracks.map(t => {
    if (t.id === trackId) {
      return { ...t, fxSlots: t.fxSlots.filter(s => s.id !== slotId) };
    }
    return t;
  })
});

export const updateFxSlotInProjectState = (
  state: ProjectState,
  trackId: number,
  slotId: string,
  updates: Partial<FxSlot>
): ProjectState => ({
  ...state,
  mixerTracks: state.mixerTracks.map(t => {
    if (t.id === trackId) {
      return {
        ...t,
        fxSlots: t.fxSlots.map(s => (s.id === slotId ? { ...s, ...updates } : s))
      };
    }
    return t;
  })
});

export const addPatternToProjectState = (
  state: ProjectState,
  pattern: Pattern
): ProjectState => ({
  ...state,
  patterns: [...state.patterns, pattern],
  selectedPatternId: pattern.id
});

/**
 * Updates one pattern by id, leaving every other pattern (and its identity)
 * untouched. Pattern-scoped state such as `lengthSteps` is written through here
 * so it participates in project history and persistence like any other edit.
 */
export const updatePatternInProjectState = (
  state: ProjectState,
  patternId: string,
  updates: Partial<Pattern>
): ProjectState => {
  if (!state.patterns.some(pattern => pattern.id === patternId)) return state;
  return {
    ...state,
    patterns: state.patterns.map(pattern => (
      pattern.id === patternId ? { ...pattern, ...updates } : pattern
    ))
  };
};

/**
 * Phase 1J: thrown when an edit tries to store a meter (or 7/8 grouping) the
 * runtime does not execute. Rejecting at the mutation boundary keeps the
 * document from holding a value the transport would silently play as 4/4.
 */
export class UnsupportedMeterEditError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedMeterEditError';
  }
}

const assertSupportedMeterUpdates = (updates: Partial<ProjectMetadata>): void => {
  if ('timeSignature' in updates && !isRuntimeSupportedMeter(updates.timeSignature)) {
    const value: unknown = updates.timeSignature;
    const label = Array.isArray(value) ? value.join('/') : String(value);
    throw new UnsupportedMeterEditError(
      `Unsupported time signature ${label}: only 4/4, 3/4, 6/8 and 7/8 are available.`
    );
  }
  if ('sevenEightGrouping' in updates && !isSevenEightGrouping(updates.sevenEightGrouping)) {
    throw new UnsupportedMeterEditError(
      `Unsupported 7/8 grouping ${String(updates.sevenEightGrouping)}: use 2+2+3, 3+2+2 or 2+3+2.`
    );
  }
  if ('countInBars' in updates && !isCountInBars(updates.countInBars)) {
    throw new InvalidRecordingSettingError(
      `Unsupported recording count-in ${String(updates.countInBars)}: use 0 (Off), 1 or 2 bars.`
    );
  }
  if ('punchRecording' in updates && !isPunchRecordingSettings(updates.punchRecording)) {
    throw new InvalidRecordingSettingError(
      'Unsupported punch recording range: it needs an enabled flag and 1-based punch-in and punch-out bar/beat positions.'
    );
  }
};

/**
 * Phase 1K: thrown when an edit tries to store a recording setting the
 * count-in workflow does not implement (anything except Off / 1 bar / 2 bars).
 */
export class InvalidRecordingSettingError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRecordingSettingError';
  }
}

export const updateProjectMetadataInProjectState = (
  state: ProjectState,
  updates: Partial<ProjectMetadata>
): ProjectState => {
  assertSupportedMeterUpdates(updates);
  return {
    ...state,
    meta: {
      ...state.meta,
      ...updates,
      ...('timeSignature' in updates && updates.timeSignature
        ? { timeSignature: [updates.timeSignature[0], updates.timeSignature[1]] as [number, number] }
        : {}),
      updated: Date.now()
    }
  };
};

/**
 * Phase 1J — the single meter edit used by Project Settings.
 *
 * Clip policy (bar-anchored): playlist clips store `startBar`/`lengthBars` and
 * patterns store absolute sixteenth-step data. A meter change rewrites ONLY
 * `meta.timeSignature`; every clip, pattern, note and marker keeps its stored
 * value bit-for-bit, so a clip that starts on bar 5 still starts on bar 5 and
 * switching back (or Undo) restores the exact previous timing. What changes is
 * the bar's duration, so clips land at a different time in seconds.
 *
 * Returns the SAME state object when the meter is already active (no history
 * entry), and throws `UnsupportedMeterEditError` for anything outside
 * 4/4, 3/4, 6/8 and 7/8.
 */
export const setProjectTimeSignatureInProjectState = (
  state: ProjectState,
  meter: unknown
): ProjectState => {
  if (!isRuntimeSupportedMeter(meter)) {
    assertSupportedMeterUpdates({ timeSignature: meter as [number, number] });
  }
  const supported = meter as readonly [number, number];
  if (isSameTimeSignature(state.meta.timeSignature, supported)) return state;
  return updateProjectMetadataInProjectState(state, { timeSignature: [supported[0], supported[1]] });
};

/** Phase 1J — choose the 7/8 accent grouping (2+2+3, 3+2+2 or 2+3+2). */
export const setSevenEightGroupingInProjectState = (
  state: ProjectState,
  grouping: unknown
): ProjectState => {
  if (!isSevenEightGrouping(grouping)) {
    assertSupportedMeterUpdates({ sevenEightGrouping: grouping as ProjectMetadata['sevenEightGrouping'] });
  }
  const current = state.meta.sevenEightGrouping;
  if (current === grouping) return state;
  return updateProjectMetadataInProjectState(state, { sevenEightGrouping: grouping as ProjectMetadata['sevenEightGrouping'] });
};

/**
 * Phase 1K — set the recording count-in length (0 = Off, 1 bar, 2 bars).
 *
 * Recording preference only: the value never touches notes, clips or timing
 * data. Returns the SAME state object when the setting is already active (no
 * history entry), and throws `InvalidRecordingSettingError` for anything that
 * is not 0, 1 or 2.
 */
export const setRecordingCountInBarsInProjectState = (
  state: ProjectState,
  bars: unknown
): ProjectState => {
  if (!isCountInBars(bars)) {
    assertSupportedMeterUpdates({ countInBars: bars as ProjectMetadata['countInBars'] });
  }
  if (state.meta.countInBars === bars) return state;
  return updateProjectMetadataInProjectState(state, { countInBars: bars as CountInBars });
};

/**
 * Phase 1L — set the punch-in / punch-out recording window.
 *
 * Recording preference only: it never touches notes, clips or timeline length.
 * The window is validated against the project's own resolved meter, 7/8
 * grouping and arrangement length at the mutation boundary, so the document can
 * never hold a window the runtime would refuse to record (a malformed bar/beat,
 * or punch-out at or before punch-in). A punch-out beyond the arrangement end
 * is accepted deliberately — the defined take behaviour truncates the take at
 * the end of the project.
 *
 * Returns the SAME state object when nothing actually changed (no history
 * entry), and throws `InvalidRecordingSettingError` otherwise.
 */
export const setPunchRecordingInProjectState = (
  state: ProjectState,
  settings: unknown
): ProjectState => {
  if (!isPunchRecordingSettings(settings)) {
    assertSupportedMeterUpdates({ punchRecording: settings as ProjectMetadata['punchRecording'] });
  }
  const next = settings as PunchRecordingSettings;
  const validation = validatePunchRecording(next, {
    meter: resolveProjectTimeSignature(state.meta),
    grouping: resolveSevenEightGrouping(state.meta),
    totalBars: getProjectTimelineBars(state),
  });
  if (!validation.valid) {
    throw new InvalidRecordingSettingError(validation.issues.map(issue => issue.message).join(' '));
  }
  const current = resolvePunchRecording(state.meta);
  const stored = state.meta.punchRecording;
  if (isPunchRecordingSettings(stored) && isSamePunchRecording(stored, next)) return state;
  if (stored === undefined && !next.enabled && isSamePunchRecording(current, next)) return state;
  return updateProjectMetadataInProjectState(state, {
    punchRecording: {
      enabled: next.enabled,
      inBar: next.inBar,
      inBeat: next.inBeat,
      outBar: next.outBar,
      outBeat: next.outBeat,
    },
  });
};

/** History label for a meter edit, e.g. "Change time signature to 7/8". */
export const getTimeSignatureEditLabel = (meter: readonly [number, number]): string =>
  `Change time signature to ${formatTimeSignature(meter)}`;

/**
 * Phase 51 — publishes a Master Macro Rack change.
 *
 * A macro rack edit is not "just" the knob array: each knob resolves, through its
 * mappings, to concrete channel / mixer / FX parameters. Writing the knobs alone
 * (the pre-Phase 51 behaviour) left every mapped parameter at its old value, so
 * the rack was decorative.
 *
 * `applyMacroRackUpdate` returns the knob array *and* every resolved parameter in
 * one new ProjectState. Because callers publish that single object through the
 * normal mutation + history boundary, a macro move is one atomic edit: it cannot
 * half-apply, and undo restores the knobs and every parameter they drove
 * together.
 */
export const updateMacroRackInProjectState = (
  state: ProjectState,
  macroKnobs: MasterMacroKnob[]
): ProjectState => applyMacroRackUpdate(state, macroKnobs);

export const updateVocalTunerInProjectState = (
  state: ProjectState,
  vocalTunerSettings: VocalTunerSettings
): ProjectState => ({
  ...state,
  vocalTuner: vocalTunerSettings
});

/**
 * Phase 79: atomic update for Gross Beat gate state. Like macroKnobs, the
 * project document owns the state — every modal toggle/step click/preset
 * select goes through this mutator so undo/redo, save/load, and project
 * replacement all preserve the pattern.
 */
export const updateGrossBeatInProjectState = (
  state: ProjectState,
  patch: Partial<GrossBeatState>
): ProjectState => {
  const base = state.grossBeatState ?? DEFAULT_GROSS_BEAT_STATE;
  const next: GrossBeatState = { ...base, ...patch };
  // Defensive: always keep exactly 16 boolean entries.
  if (!Array.isArray(next.gateSteps) || next.gateSteps.length !== 16 || next.gateSteps.some(s => typeof s !== 'boolean')) {
    next.gateSteps = [...DEFAULT_GROSS_BEAT_STATE.gateSteps];
  }
  next.mix = Math.max(0, Math.min(1, next.mix));
  return { ...state, grossBeatState: next };
};

export const updateMidiMappingsInProjectState = (
  state: ProjectState,
  midiMappings: MidiMapping[]
): ProjectState => ({
  ...state,
  midiMappings
});

export const isContinuousChannelUpdate = (updates: Partial<Channel>): boolean => {
  if (
    'notes' in updates ||
    'steps' in updates ||
    'mute' in updates ||
    'solo' in updates ||
    'customSample' in updates ||
    'instrumentType' in updates ||
    'name' in updates ||
    'color' in updates
  ) {
    return false;
  }
  if ('synthParams' in updates && updates.synthParams) {
    return Object.keys(updates.synthParams).length <= 2;
  }
  return 'volume' in updates || 'pan' in updates || 'pitch' in updates;
};

export const getChannelUpdateLabel = (updates: Partial<Channel>): string => {
  if ('notes' in updates) return 'Edit notes';
  if ('steps' in updates) return 'Edit steps';
  if ('mute' in updates) return 'Toggle channel mute';
  if ('solo' in updates) return 'Toggle channel solo';
  if ('volume' in updates) return 'Change channel volume';
  if ('pan' in updates) return 'Change channel pan';
  if ('pitch' in updates) return 'Change channel pitch';
  if ('customSample' in updates) return 'Assign sample';
  if ('synthParams' in updates) {
    return isContinuousChannelUpdate(updates) ? 'Change synth parameter' : 'Apply synth preset';
  }
  return 'Update channel';
};

export const isContinuousMixerUpdate = (updates: Partial<MixerTrack>): boolean => {
  if ('mute' in updates || 'solo' in updates || 'name' in updates || 'color' in updates) {
    return false;
  }
  if ('sidechain' in updates && updates.sidechain) {
    const keys = Object.keys(updates.sidechain);
    return keys.length === 1 && keys[0] === 'amount';
  }
  if ('auxSends' in updates) return true;
  return 'volume' in updates || 'pan' in updates;
};

export const getMixerUpdateLabel = (updates: Partial<MixerTrack>): string => {
  if ('volume' in updates) return 'Change mixer volume';
  if ('pan' in updates) return 'Change mixer pan';
  if ('mute' in updates) return 'Toggle mixer mute';
  if ('solo' in updates) return 'Toggle mixer solo';
  if ('sidechain' in updates) return 'Update sidechain';
  if ('auxSends' in updates) return 'Update aux send';
  return 'Update mixer track';
};

export const isContinuousFxUpdate = (updates: Partial<FxSlot>): boolean => {
  if ('enabled' in updates || 'type' in updates || 'name' in updates) {
    return false;
  }
  return 'mix' in updates || 'params' in updates;
};

export const getFxUpdateLabel = (updates: Partial<FxSlot>): string => {
  if ('enabled' in updates) {
    return updates.enabled ? 'Enable effect' : 'Bypass effect';
  }
  if ('mix' in updates) return 'Change effect mix';
  if ('params' in updates) return 'Update effect parameters';
  return 'Update effect';
};

export const isContinuousMetaUpdate = (updates: Partial<ProjectMetadata>): boolean => {
  if ('name' in updates || 'timeSignature' in updates || 'sevenEightGrouping' in updates || 'countInBars' in updates || 'punchRecording' in updates) {
    return false;
  }
  return 'swing' in updates || 'bpm' in updates;
};

export const getMetaUpdateLabel = (updates: Partial<ProjectMetadata>): string => {
  if ('bpm' in updates) return 'Change tempo';
  if ('swing' in updates) return 'Change swing';
  if ('name' in updates) return 'Rename project';
  if ('timeSignature' in updates) return 'Change time signature';
  if ('sevenEightGrouping' in updates) return 'Change 7/8 accent grouping';
  if ('countInBars' in updates) return 'Change recording count-in';
  if ('punchRecording' in updates) {
    return updates.punchRecording?.enabled ? 'Change punch recording range' : 'Turn off punch recording';
  }
  return 'Update project settings';
};

/**
 * Pattern edits are discrete clicks (never continuous drags), so they always
 * commit their own history entry.
 */
export const getPatternUpdateLabel = (updates: Partial<Pattern>): string => {
  if ('lengthSteps' in updates) return 'Change pattern length';
  if ('name' in updates) return 'Rename pattern';
  if ('color' in updates) return 'Change pattern color';
  return 'Update pattern';
};

export interface ContinuousBatcherOptions {
  debounceMs?: number;
  onCommit: (state: ProjectState, label: string) => void;
}

export class ContinuousHistoryBatcher {
  private active = false;
  private pendingState: ProjectState | null = null;
  private pendingLabel: string = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs: number;
  private onCommit: (state: ProjectState, label: string) => void;

  constructor(options: ContinuousBatcherOptions) {
    this.debounceMs = options.debounceMs ?? 300;
    this.onCommit = options.onCommit;
  }

  start(label?: string): void {
    this.active = true;
    if (label) this.pendingLabel = label;
  }

  update(nextState: ProjectState, label: string): void {
    this.pendingState = nextState;
    this.pendingLabel = label;
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.flush();
    }, this.debounceMs);
  }

  flush(overrideLabel?: string): boolean {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const hadPending = this.pendingState !== null;
    if (this.pendingState !== null) {
      const stateToCommit = this.pendingState;
      const labelToCommit = overrideLabel || this.pendingLabel;
      this.pendingState = null;
      this.active = false;
      this.onCommit(stateToCommit, labelToCommit);
    } else {
      this.active = false;
    }
    return hadPending;
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingState = null;
    this.active = false;
  }

  isActive(): boolean {
    return this.active || this.pendingState !== null || this.timer !== null;
  }
}
