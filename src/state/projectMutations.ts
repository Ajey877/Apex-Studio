import type {
  Channel,
  FxSlot,
  MasterMacroKnob,
  MidiMapping,
  MixerTrack,
  Pattern,
  ProjectMetadata,
  ProjectState,
  VocalTunerSettings
} from '../types/daw';

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

export const updateProjectMetadataInProjectState = (
  state: ProjectState,
  updates: Partial<ProjectMetadata>
): ProjectState => ({
  ...state,
  meta: {
    ...state.meta,
    ...updates,
    updated: Date.now()
  }
});

export const updateMacroKnobsInProjectState = (
  state: ProjectState,
  macroKnobs: MasterMacroKnob[]
): ProjectState => ({
  ...state,
  macroKnobs
});

export const updateVocalTunerInProjectState = (
  state: ProjectState,
  vocalTunerSettings: VocalTunerSettings
): ProjectState => ({
  ...state,
  vocalTuner: vocalTunerSettings
});

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
  return 'volume' in updates || 'pan' in updates;
};

export const getMixerUpdateLabel = (updates: Partial<MixerTrack>): string => {
  if ('volume' in updates) return 'Change mixer volume';
  if ('pan' in updates) return 'Change mixer pan';
  if ('mute' in updates) return 'Toggle mixer mute';
  if ('solo' in updates) return 'Toggle mixer solo';
  if ('sidechain' in updates) return 'Update sidechain';
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
  if ('name' in updates || 'timeSignature' in updates || 'isEncrypted' in updates) {
    return false;
  }
  return 'swing' in updates || 'bpm' in updates;
};

export const getMetaUpdateLabel = (updates: Partial<ProjectMetadata>): string => {
  if ('bpm' in updates) return 'Change tempo';
  if ('swing' in updates) return 'Change swing';
  if ('name' in updates) return 'Rename project';
  if ('timeSignature' in updates) return 'Change time signature';
  return 'Update project settings';
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
