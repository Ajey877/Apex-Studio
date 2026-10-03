/**
 * Phase 46 — runtime MIDI CC mapping bridge.
 *
 * Before this module existed, `ProjectState.midiMappings` was save/load state
 * that nothing consumed at runtime: the audio engine dispatched CC events to its
 * listeners, but no listener ever applied a stored mapping to the mapped DAW
 * parameter. This module is the missing bridge:
 *
 *   MIDI CC event -> stored `ProjectState.midiMappings` -> matching mapping
 *                 -> target parameter mutation / audio-engine parameter update
 *
 * Design constraints it honours:
 *  - It is a consumer of the engine's *existing* MIDI event stream
 *    (`audioEngine.addMidiListener`); it never opens a second MIDI system.
 *  - Project-state targets are expressed as pure state transitions, so the app
 *    routes them through `mutateProjectState` and undo/redo semantics, runtime
 *    publication and persistence stay intact.
 *  - The master output is not project state in this codebase: nothing applies
 *    `meta.masterVolume` to the audio graph, while the engine's `master_vol`
 *    parameter (the one master-volume automation drives) is live. That target
 *    therefore goes through the engine's existing parameter API.
 *  - Ranges come from `parameterScaling`, the same module the automation path
 *    uses, so a CC and an automation lane agree on every parameter's range.
 *  - Targets without an existing runtime setter or documented range are
 *    reported as `unsupported` and change nothing rather than inventing
 *    behaviour.
 */

import type { Channel, MidiMapping, MixerTrack, Note, ProjectState } from '../types/daw';
import type { MidiEventPayload } from './audioEngine';
import {
  channelVolumeFromNormalized,
  clampNormalized,
  filterCutoffFromNormalized,
  filterResonanceFromNormalized,
  fxMixFromNormalized,
  mixerVolumeFromNormalized,
  panFromNormalized,
} from './parameterScaling';
import {
  getChannelUpdateLabel,
  getFxUpdateLabel,
  getMixerUpdateLabel,
  updateChannelInProjectState,
  updateFxSlotInProjectState,
  updateMixerTrackInProjectState,
} from '../state/projectMutations';

export const MIDI_CC_MIN = 0;
export const MIDI_CC_MAX = 127;

/**
 * MIDI 0-127 -> normalized 0..1.
 *
 * The engine already normalizes incoming bytes (`value: data2 / 127`) before it
 * dispatches a CC event, so the bridge consumes normalized values. Raw sources
 * (learn capture, tests, future virtual controls) use this helper instead of
 * re-deriving the ratio.
 */
export const normalizeMidiCcValue = (rawCcValue: number): number => {
  if (!Number.isFinite(rawCcValue)) return 0;
  return Math.max(MIDI_CC_MIN, Math.min(MIDI_CC_MAX, rawCcValue)) / MIDI_CC_MAX;
};

/** First mapping bound to the CC number wins; the mapping model has no MIDI channel field. */
export const findMidiMappingForCc = (
  mappings: readonly MidiMapping[] | undefined,
  ccNumber: number,
): MidiMapping | undefined =>
  (mappings ?? []).find(mapping => Boolean(mapping) && mapping.ccNumber === ccNumber);

/** What a mapping resolves to once the current project state is taken into account. */
export type MidiCcResolution =
  | {
      kind: 'project';
      status: 'supported';
      parameter: string;
      value: number;
      label: string;
      /** Pure transition: never mutates the state it is given. */
      apply: (state: ProjectState) => ProjectState;
    }
  | { kind: 'engine-master-volume'; status: 'supported'; parameter: string; value: number; label: string }
  | { kind: 'unsupported'; status: 'unsupported'; reason: string };

const unsupported = (reason: string): MidiCcResolution => ({ kind: 'unsupported', status: 'unsupported', reason });

const midiLabel = (mapping: MidiMapping, detail: string): string =>
  `MIDI CC ${mapping.ccNumber}: ${detail}`;

const findChannel = (state: ProjectState, targetId: string | number): Channel | undefined =>
  state.channels.find(channel => channel.id === String(targetId));

const findMixerTrack = (state: ProjectState, trackId: number): MixerTrack | undefined =>
  state.mixerTracks.find(track => track.id === trackId);

/**
 * Mixer targets are numeric model ids, but the mapping UIs store the `value` of
 * a `<select>`/`<input>`, so `"3"` and `3` must resolve identically.
 */
const toMixerTrackId = (targetId: string | number): number | null => {
  if (typeof targetId === 'number') {
    return Number.isSafeInteger(targetId) ? targetId : null;
  }
  const trimmed = targetId.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

/**
 * `fx_param` covers two shapes that both already have a runtime setter and a
 * documented range:
 *
 *  1. a channel synth parameter — `targetId` is a channel id and `paramName`
 *     names the `SynthParameters` field (`filterCutoff`, `filterResonance`),
 *     matching the MIDI Learn quick-arm buttons;
 *  2. an FX slot wet/dry mix — `targetId` is the `FxSlot.id` and `paramName` is
 *     `mix`, matching the shipped preset mapping (`fx-5-verb` + `mix`) and the
 *     `fx_mix` automation target.
 *
 * Anything else (e.g. a channel-wide "reverb" amount, or arbitrary
 * `FxSlot.params` entries which are only read when a chain is built) has no
 * runtime setter and is reported instead of guessed at.
 */
const resolveFxParamTarget = (
  mapping: MidiMapping,
  state: ProjectState,
  normalizedValue: number,
): MidiCcResolution => {
  const paramName = typeof mapping.paramName === 'string' ? mapping.paramName.trim() : '';
  if (!paramName) {
    return unsupported(
      `fx_param mapping for target "${String(mapping.targetId)}" has no paramName, so it names no parameter.`,
    );
  }

  const channel = findChannel(state, mapping.targetId);
  if (channel) {
    if (paramName === 'filterCutoff') {
      const updates: Partial<Channel> = {
        synthParams: { ...channel.synthParams, filterCutoff: filterCutoffFromNormalized(normalizedValue) },
      };
      return {
        kind: 'project',
        status: 'supported',
        parameter: 'fx_param.filterCutoff',
        value: updates.synthParams!.filterCutoff,
        label: midiLabel(mapping, getChannelUpdateLabel(updates)),
        apply: current => updateChannelInProjectState(current, channel.id, updates),
      };
    }
    if (paramName === 'filterResonance') {
      const updates: Partial<Channel> = {
        synthParams: { ...channel.synthParams, filterResonance: filterResonanceFromNormalized(normalizedValue) },
      };
      return {
        kind: 'project',
        status: 'supported',
        parameter: 'fx_param.filterResonance',
        value: updates.synthParams!.filterResonance,
        label: midiLabel(mapping, getChannelUpdateLabel(updates)),
        apply: current => updateChannelInProjectState(current, channel.id, updates),
      };
    }
    return unsupported(
      `Channel "${channel.id}" has no runtime setter for FX parameter "${paramName}".`,
    );
  }

  if (paramName === 'mix') {
    for (const track of state.mixerTracks) {
      const slot = track.fxSlots.find(candidate => candidate.id === String(mapping.targetId));
      if (!slot) continue;
      const updates = { mix: fxMixFromNormalized(normalizedValue) };
      return {
        kind: 'project',
        status: 'supported',
        parameter: 'fx_param.mix',
        value: updates.mix,
        label: midiLabel(mapping, getFxUpdateLabel(updates)),
        apply: current => updateFxSlotInProjectState(current, track.id, slot.id, updates),
      };
    }
    return unsupported(`No FX slot matches target id "${String(mapping.targetId)}".`);
  }

  return unsupported(`FX parameter "${paramName}" has no runtime setter.`);
};

/**
 * Resolves a stored mapping against the current project state. Pure and
 * deterministic: the returned `apply` never mutates the state it receives.
 */
export const resolveMidiCcTarget = (
  mapping: MidiMapping,
  state: ProjectState,
  normalizedValue: number = 0.5,
): MidiCcResolution => {
  const value = clampNormalized(normalizedValue);

  switch (mapping.targetType) {
    case 'master_vol':
      return {
        kind: 'engine-master-volume',
        status: 'supported',
        parameter: 'master_vol',
        value,
        label: midiLabel(mapping, 'Master output volume'),
      };

    case 'channel_vol': {
      const channel = findChannel(state, mapping.targetId);
      if (!channel) return unsupported(`No channel matches target id "${String(mapping.targetId)}".`);
      const updates: Partial<Channel> = { volume: channelVolumeFromNormalized(value) };
      return {
        kind: 'project',
        status: 'supported',
        parameter: 'channel_vol',
        value: updates.volume!,
        label: midiLabel(mapping, getChannelUpdateLabel(updates)),
        apply: current => updateChannelInProjectState(current, channel.id, updates),
      };
    }

    case 'channel_pan': {
      const channel = findChannel(state, mapping.targetId);
      if (!channel) return unsupported(`No channel matches target id "${String(mapping.targetId)}".`);
      const updates: Partial<Channel> = { pan: panFromNormalized(value) };
      return {
        kind: 'project',
        status: 'supported',
        parameter: 'channel_pan',
        value: updates.pan!,
        label: midiLabel(mapping, getChannelUpdateLabel(updates)),
        apply: current => updateChannelInProjectState(current, channel.id, updates),
      };
    }

    case 'mixer_vol':
    case 'mixer_pan': {
      const trackId = toMixerTrackId(mapping.targetId);
      const track = trackId === null ? undefined : findMixerTrack(state, trackId);
      if (!track) return unsupported(`No mixer track matches target id "${String(mapping.targetId)}".`);
      const updates: Partial<MixerTrack> =
        mapping.targetType === 'mixer_vol'
          ? { volume: mixerVolumeFromNormalized(value) }
          : { pan: panFromNormalized(value) };
      return {
        kind: 'project',
        status: 'supported',
        parameter: mapping.targetType,
        value: mapping.targetType === 'mixer_vol' ? updates.volume! : updates.pan!,
        label: midiLabel(mapping, getMixerUpdateLabel(updates)),
        apply: current => updateMixerTrackInProjectState(current, track.id, updates),
      };
    }

    case 'fx_param':
      return resolveFxParamTarget(mapping, state, value);

    default:
      return unsupported(`Mapping target "${String(mapping.targetType)}" has no runtime setter.`);
  }
};

export interface MidiCcMappingRuntimePorts {
  /** Reads the live project state (App keeps it in a ref for pointer-speed access). */
  getProjectState(): ProjectState;
  /**
   * Publishes a MIDI-driven project edit through the app's mutation/history
   * path (`mutateProjectState`), exactly like a UI fader drag.
   */
  applyProjectMutation(updater: (state: ProjectState) => ProjectState, label: string): void;
  /** Applies a normalized 0..1 master output value through the audio engine. */
  applyMasterVolume(normalizedValue: number): void;
}

export type MidiCcDispatchStatus = 'applied' | 'unmapped' | 'unsupported' | 'ignored';

export interface MidiCcDispatchResult {
  status: MidiCcDispatchStatus;
  ccNumber?: number;
  parameter?: string;
  value?: number;
  reason?: string;
}

/**
 * Applies incoming CC events to the project's stored `midiMappings`.
 *
 * The runtime is engine-driven: the app registers `handleMidiEvent` on the
 * audio engine's MIDI listener list, so hardware events reach the same
 * parameter bridge regardless of which modal is open.
 */
export class MidiCcMappingRuntime {
  constructor(private readonly ports: MidiCcMappingRuntimePorts) {}

  handleMidiEvent(event: MidiEventPayload | null | undefined): MidiCcDispatchResult {
    if (!event || event.type !== 'cc' || typeof event.cc !== 'number' || !Number.isFinite(event.cc)) {
      return { status: 'ignored' };
    }

    const ccNumber = Math.round(event.cc);
    // The engine dispatches `data2 / 127`; clamp defensively so a malformed
    // event can never write an out-of-range parameter value.
    const normalizedValue = clampNormalized(event.value ?? 0);
    const state = this.ports.getProjectState();
    const mapping = findMidiMappingForCc(state.midiMappings, ccNumber);
    if (!mapping) return { status: 'unmapped', ccNumber };

    const resolution = resolveMidiCcTarget(mapping, state, normalizedValue);
    if (resolution.kind === 'unsupported') {
      return { status: 'unsupported', ccNumber, reason: resolution.reason };
    }

    if (resolution.kind === 'engine-master-volume') {
      this.ports.applyMasterVolume(resolution.value);
      return { status: 'applied', ccNumber, parameter: resolution.parameter, value: resolution.value };
    }

    // Re-resolve against the freshest state inside the updater so a CC stream
    // never clobbers an unrelated edit made between resolution and publication.
    this.ports.applyProjectMutation(current => resolution.apply(current), resolution.label);
    return { status: 'applied', ccNumber, parameter: resolution.parameter, value: resolution.value };
  }
}

/** Display label used by the mapping UIs when a binding carries no explicit parameter name. */
export const defaultMidiMappingLabel = (
  targetType: MidiMapping['targetType'],
  targetId: string | number,
): string => (targetType === 'master_vol' ? 'Master Volume' : `${targetType} #${targetId}`);

/** Builds a mapping from a captured CC number and the target the user asked to bind. */
export const createMidiMappingForCc = (
  ccNumber: number,
  targetType: MidiMapping['targetType'],
  targetId: string | number,
  paramName?: string,
): MidiMapping => ({
  ccNumber: Number.isFinite(ccNumber) ? Math.max(MIDI_CC_MIN, Math.min(MIDI_CC_MAX, Math.round(ccNumber))) : MIDI_CC_MIN,
  targetType,
  targetId,
  paramName: paramName ?? defaultMidiMappingLabel(targetType, targetId),
});

export interface MidiLearnTarget {
  targetType: MidiMapping['targetType'];
  targetId: string | number;
  paramName?: string;
}

export interface MidiLearnCapture {
  ccNumber: number;
  mapping: MidiMapping;
  mappings: MidiMapping[];
}

/**
 * A target owns at most one CC and a CC owns at most one target: learning
 * replaces both. When the learned target names a specific parameter (e.g. a
 * channel `filterCutoff`), only that exact parameter is replaced, so a sibling
 * `filterResonance` binding on the same channel survives.
 */
const isSameMidiTarget = (mapping: MidiMapping, target: MidiLearnTarget): boolean =>
  mapping.targetType === target.targetType &&
  String(mapping.targetId) === String(target.targetId) &&
  (target.paramName === undefined || mapping.paramName === target.paramName);

/**
 * MIDI Learn capture: turns the first incoming CC event into the requested
 * mapping. Returns `null` for anything that is not a CC, so note/pitch-bend
 * traffic is ignored while learning.
 */
export const resolveMidiLearnCapture = (
  event: MidiEventPayload | null | undefined,
  existingMappings: readonly MidiMapping[] | undefined,
  target: MidiLearnTarget,
): MidiLearnCapture | null => {
  if (!event || event.type !== 'cc' || typeof event.cc !== 'number' || !Number.isFinite(event.cc)) {
    return null;
  }

  const ccNumber = Math.max(MIDI_CC_MIN, Math.min(MIDI_CC_MAX, Math.round(event.cc)));
  const mapping = createMidiMappingForCc(ccNumber, target.targetType, target.targetId, target.paramName);
  const mappings = [
    ...(existingMappings ?? []).filter(
      existing => existing.ccNumber !== ccNumber && !isSameMidiTarget(existing, target),
    ),
    mapping,
  ];

  return { ccNumber, mapping, mappings };
};

/**
 * Phase 61: Canonical Channel Rack audibility predicate.
 *
 * A channel is audible iff it is not muted (`!channel.mute`) AND either no
 * channel in `channels` has `solo: true` or this channel has `solo: true`.
 * Consequently, a channel with both `solo: true` and `mute: true` is silent
 * itself while still solo-silencing non-soloed channels.
 */
export const isRackChannelAudible = (
  channel: Pick<Channel, 'mute' | 'solo'>,
  channels: readonly Pick<Channel, 'mute' | 'solo'>[],
): boolean => {
  if (channel.mute) return false;
  const hasSolo = channels.some(candidate => Boolean(candidate.solo));
  return !hasSolo || Boolean(channel.solo);
};

export interface MidiNoteInputRuntimePorts {
  getProjectState(): ProjectState;
  getSelectedChannelId?(): string | null | undefined;
  playNote(channel: Channel, note: Note, startTime?: number, bpm?: number): void;
  stopChannelNote(channelId: string, pitch: number): number | void;
}

export type MidiNoteDispatchStatus = 'note_on' | 'note_off' | 'muted' | 'ignored';

export interface MidiNoteDispatchResult {
  status: MidiNoteDispatchStatus;
  channelId?: string;
  note?: number;
  velocity?: number;
  midiChannel?: number;
}

interface HeldMidiNoteEntry {
  channelId: string;
  pitch: number;
  midiChannel: number;
}

/**
 * Phase 61: Hardware Web MIDI keyboard performance bridge (`noteOn` / `noteOff`).
 *
 * Consumes the audio engine's existing `midiListeners` stream alongside
 * `MidiCcMappingRuntime`, routing incoming MIDI `noteOn` messages to the
 * active/selected Channel Rack instrument and stopping the sustaining voice
 * on the originating channel when the matching `noteOff` arrives.
 */
export class MidiNoteInputRuntime {
  private readonly heldNotes = new Map<string, HeldMidiNoteEntry>();

  constructor(private readonly ports: MidiNoteInputRuntimePorts) {}

  handleMidiEvent(event: MidiEventPayload | null | undefined): MidiNoteDispatchResult {
    if (!event || (event.type !== 'noteOn' && event.type !== 'noteOff')) {
      return { status: 'ignored' };
    }
    if (typeof event.note !== 'number' || !Number.isFinite(event.note)) {
      return { status: 'ignored' };
    }

    const pitch = Math.max(0, Math.min(127, Math.round(event.note)));
    const midiChannel =
      typeof event.midiChannel === 'number' && Number.isFinite(event.midiChannel)
        ? Math.max(1, Math.min(16, Math.round(event.midiChannel)))
        : 1;
    const noteKey = `${midiChannel}:${pitch}`;

    const isNoteOff =
      event.type === 'noteOff' ||
      (event.type === 'noteOn' && typeof event.velocity === 'number' && event.velocity <= 0);

    if (isNoteOff) {
      let held = this.heldNotes.get(noteKey);
      let matchedKey = noteKey;
      if (!held && event.midiChannel === undefined) {
        for (const [key, entry] of this.heldNotes.entries()) {
          if (entry.pitch === pitch) {
            held = entry;
            matchedKey = key;
            break;
          }
        }
      }
      if (held) {
        this.heldNotes.delete(matchedKey);
        this.ports.stopChannelNote(held.channelId, pitch);
        return {
          status: 'note_off',
          channelId: held.channelId,
          note: pitch,
          midiChannel: held.midiChannel,
        };
      }

      const state = this.ports.getProjectState();
      const selectedId = this.ports.getSelectedChannelId?.() ?? state.selectedChannelId;
      const fallbackChannel = state.channels.find(c => c.id === selectedId) ?? state.channels[0];
      if (fallbackChannel) {
        this.ports.stopChannelNote(fallbackChannel.id, pitch);
      }
      return {
        status: 'note_off',
        channelId: fallbackChannel?.id,
        note: pitch,
        midiChannel,
      };
    }

    const state = this.ports.getProjectState();
    const selectedId = this.ports.getSelectedChannelId?.() ?? state.selectedChannelId;
    const channel = state.channels.find(c => c.id === selectedId) ?? state.channels[0];
    if (!channel) {
      return { status: 'ignored' };
    }

    if (!isRackChannelAudible(channel, state.channels)) {
      return {
        status: 'muted',
        channelId: channel.id,
        note: pitch,
        midiChannel,
      };
    }

    const existing = this.heldNotes.get(noteKey);
    if (existing) {
      this.ports.stopChannelNote(existing.channelId, pitch);
    }

    const velocity = Math.max(1 / 127, clampNormalized(event.velocity ?? 0.8));
    this.heldNotes.set(noteKey, {
      channelId: channel.id,
      pitch,
      midiChannel,
    });

    this.ports.playNote(
      channel,
      {
        id: `midi-${midiChannel}-${pitch}-${Date.now()}`,
        pitch,
        start: 0,
        duration: 8,
        velocity,
      },
      undefined,
      state.meta?.bpm ?? 120,
    );

    return {
      status: 'note_on',
      channelId: channel.id,
      note: pitch,
      velocity,
      midiChannel,
    };
  }

  releaseAllNotes(): void {
    for (const entry of this.heldNotes.values()) {
      this.ports.stopChannelNote(entry.channelId, entry.pitch);
    }
    this.heldNotes.clear();
  }
}

