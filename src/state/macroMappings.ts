/**
 * Phase 51 — Master Macro Rack runtime mapping engine.
 *
 * Before this module existed, `ProjectState.macroKnobs` was save/load + UI state
 * that nothing consumed at runtime: the macro rack persisted a knob value and a
 * list of mappings, the modal rendered them, and no resolved value ever reached
 * a channel, a mixer insert or an FX slot. Turning a macro knob changed the knob
 * and nothing else — the mappings were decorative.
 *
 * This module is the missing bridge. Its contract is deliberately small and
 * pure, so every consumer provably agrees on the resolved values:
 *
 *   (macro value, mapping) -> curve + hard-range clamp -> resolved parameter value
 *   -> single atomic ProjectState transition
 *
 * Why the transition is a *state* transition and not a direct audio-graph write:
 *
 *  - Live playback and offline export already read the same project collections.
 *    `App.synchronizeActivePlayback` forwards `channels` / `mixerTracks` to the
 *    running take, `audioEngine.updateMixerTrack` applies a track (including its
 *    FX chain) when the transport is idle, and `renderTimelineOffline` receives
 *    the very same `channels` / `mixerTracks` arguments. Writing resolved values
 *    into project state therefore makes live and offline converge by
 *    construction instead of by keeping two parallel implementations in sync.
 *  - The app publishes state through one history/mutation boundary, so a macro
 *    move that resolves to many parameters is a single undo entry.
 *
 * Determinism/idempotency guarantees that the rest of the system relies on:
 *
 *  - Resolution depends only on (knob value, mapping, current project identity)
 *    — never on the parameter's current value. Re-applying the same knobs to an
 *    already-resolved state produces the same values, so hydration re-application
 *    and repeated publication cannot drift.
 *  - Macros are applied in array order and mappings in declaration order; a later
 *    mapping targeting the same parameter wins. That makes the outcome of
 *    overlapping mappings explicit rather than order-of-iteration dependent.
 *  - An unresolvable target (stale id, removed track, no matching FX slot) is
 *    reported as unresolved and changes nothing. It never throws and never
 *    invents a target, so a project that references a deleted channel still
 *    loads and still applies every other mapping.
 */

import type {
  Channel,
  MasterMacroKnob,
  MixerTrack,
  ProjectState,
  SynthParameters
} from '../types/daw';
import {
  FILTER_CUTOFF_MIN_HZ,
  FILTER_CUTOFF_SPAN_HZ,
  MIXER_VOLUME_MAX
} from '../audio/parameterScaling';

export type MacroMapping = MasterMacroKnob['mappings'][number];
export type MacroTargetType = MacroMapping['targetType'];
export type MacroCurve = NonNullable<MacroMapping['curve']>;

/**
 * The seven mapping targets the runtime understands. Anything else is an
 * unknown target and resolves to a no-op instead of a guess.
 */
export const SUPPORTED_MACRO_TARGETS: readonly MacroTargetType[] = [
  'channel_volume',
  'channel_pan',
  'mixer_volume',
  'mixer_pan',
  'filter_cutoff',
  'reverb_wet',
  'delay_feedback'
];

export const MACRO_CURVES: readonly MacroCurve[] = ['linear', 'exponential', 'logarithmic'];

/** Highest filter cutoff a channel can carry (the automation path's hard ceiling). */
export const FILTER_CUTOFF_MAX_HZ = FILTER_CUTOFF_MIN_HZ + FILTER_CUTOFF_SPAN_HZ;

/**
 * Highest delay feedback the live/offline FX factory will build
 * (`liveFxChainHardening.createEffect` bounds `params.feedback` to 0..0.989 so
 * the internal feedback loop can never reach unity).
 */
export const DELAY_FEEDBACK_MAX = 0.989;

/**
 * Hard model limits per target. A mapping's declared min/max is a *request*; the
 * resolved value is always clamped here as well, so a mapping authored with
 * `min: 0.4, max: 1.5` on a channel volume can never write 1.5 into a 0..1 field.
 */
const MODEL_RANGES: Record<MacroTargetType, readonly [number, number]> = {
  channel_volume: [0, 1],
  channel_pan: [-1, 1],
  mixer_volume: [0, MIXER_VOLUME_MAX],
  mixer_pan: [-1, 1],
  filter_cutoff: [FILTER_CUTOFF_MIN_HZ, FILTER_CUTOFF_MAX_HZ],
  reverb_wet: [0, 1],
  delay_feedback: [0, DELAY_FEEDBACK_MAX]
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const clampToModelRange = (targetType: MacroTargetType, value: number): number => {
  const [min, max] = MODEL_RANGES[targetType];
  return clamp(value, min, max);
};

const isSupportedTarget = (targetType: unknown): targetType is MacroTargetType =>
  typeof targetType === 'string' && (SUPPORTED_MACRO_TARGETS as readonly string[]).includes(targetType);

const isCurve = (curve: unknown): curve is MacroCurve =>
  typeof curve === 'string' && (MACRO_CURVES as readonly string[]).includes(curve);

/**
 * Maps a normalized knob position (0..1) through a curve onto the mapping's
 * declared range, then clamps into the range.
 *
 * The three curves are one consistent family of power tapers on the *normalized*
 * position, so all of them:
 *   - ascend monotonically (turning a knob up always raises its target),
 *   - are exact at both endpoints (t = 0 is `min`, t = 1 is `max`),
 *   - are defined for every finite range, including ranges that touch or cross
 *     zero, because no branch assumes a positive endpoint.
 *
 *  - `linear`      — `min + (max - min) * t`         (constant rate)
 *  - `exponential` — `min + (max - min) * t²`         (slow start, accelerates)
 *  - `logarithmic` — `min + (max - min) * (1-(1-t)²)` (fast start, decelerates)
 *
 * `exponential` is the taper a "build-up sweep" wants: the target stays near
 * `min` through the first half of the travel and opens up at the end, which is
 * how a filter sweep is normally performed. `logarithmic` is its mirror image.
 *
 * The result is always clamped into `[min, max]`, so no curve can produce a
 * value outside the range the mapping declared. An inverted range (`min > max`)
 * is normalized first and behaves like the equivalent ascending range. An
 * unrecognised curve name degrades to `linear` rather than silently dropping an
 * otherwise valid mapping.
 */
export const resolveMacroCurveValue = (
  min: number,
  max: number,
  curve: MacroCurve | undefined,
  normalizedValue: number
): number => {
  const t = Number.isFinite(normalizedValue) ? clamp(normalizedValue, 0, 1) : 0;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;

  const low = Math.min(min, max);
  const high = Math.max(min, max);
  if (low === high) return low;

  const span = high - low;

  switch (curve) {
    case 'exponential':
      return clamp(low + span * t * t, low, high);
    case 'logarithmic':
      return clamp(low + span * (1 - (1 - t) * (1 - t)), low, high);
    case 'linear':
    default:
      return clamp(low + span * t, low, high);
  }
};

/** Stable identity of a resolved parameter, used to spot overlapping mappings. */
export const macroParameterKey = (
  targetType: MacroTargetType,
  targetId: string,
  parameter: string
): string => `${targetType}:${targetId}:${parameter}`;

/** One mapping that resolved to a concrete, writable parameter value. */
export interface ResolvedMacroParameter {
  macroId: string;
  macroName: string;
  mappingIndex: number;
  targetType: MacroTargetType;
  parameter: string;
  /** Channel id, mixer track id or `"<trackId>/<slotId>"` — a display/key id. */
  targetId: string;
  label: string;
  /** Fully resolved and clamped value, ready to be written into project state. */
  value: number;
}

/** One mapping that named no writable target and therefore changes nothing. */
export interface UnresolvedMacroTarget {
  macroId: string;
  macroName: string;
  mappingIndex: number;
  targetType: string;
  targetId: string | number;
  reason: string;
}

export interface MacroRackResolution {
  parameters: ResolvedMacroParameter[];
  unresolved: UnresolvedMacroTarget[];
}

const resolveChannel = (state: ProjectState, targetId: string | number): Channel | undefined =>
  state.channels.find(channel => channel.id === String(targetId));

const resolveMixerTrack = (state: ProjectState, targetId: string | number): MixerTrack | undefined => {
  const parsed = parseMixerTrackId(targetId);
  if (parsed === null) return undefined;
  return state.mixerTracks.find(track => track.id === parsed);
};

/**
 * Mixer targets are numeric model ids, but mapping UIs store the `value` of a
 * `<select>`/`<input>`, so `"3"` and `3` must resolve identically. Mirrors the
 * Phase 46 MIDI bridge so a macro and a CC agree on what `"3"` means.
 */
function parseMixerTrackId(targetId: string | number): number | null {
  if (typeof targetId === 'number') {
    return Number.isSafeInteger(targetId) ? targetId : null;
  }
  const trimmed = targetId.trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * FX targets are authored as a mixer track number ("Track #1"), but a mapping
 * written against a channel is equally meaningful, so a channel id resolves to
 * the insert that channel is routed to. Both spellings are documented and
 * deterministic; anything else is unresolved.
 */
const resolveFxTrack = (state: ProjectState, targetId: string | number): MixerTrack | undefined => {
  const direct = resolveMixerTrack(state, targetId);
  if (direct) return direct;
  const channel = resolveChannel(state, targetId);
  if (!channel) return undefined;
  return state.mixerTracks.find(track => track.id === channel.mixerTrackId);
};

/**
 * `filter_cutoff` drives the per-channel synth filter, the same
 * `channel.synthParams.filterCutoff` field the `channel_filter_cutoff`
 * automation target writes. A target may name the channel directly, or name the
 * mixer insert that one or more channels are routed to — in which case every
 * channel on that insert sweeps together, which is what a bus-level macro means.
 */
const resolveFilterChannels = (state: ProjectState, targetId: string | number): Channel[] => {
  const byId = resolveChannel(state, targetId);
  if (byId) return [byId];

  const trackId = parseMixerTrackId(targetId);
  if (trackId === null) return [];
  return state.channels.filter(channel => channel.mixerTrackId === trackId);
};

/** First FX slot of the requested type on a track; `undefined` when absent. */
const findFxSlot = (track: MixerTrack, type: 'reverb' | 'delay') =>
  track.fxSlots.find(slot => slot.type === type);

const macroLabel = (knob: MasterMacroKnob, detail: string): string =>
  `Macro "${knob.name || knob.id}": ${detail}`;

const describeMappingRange = (mapping: MacroMapping): string => {
  const curve = isCurve(mapping.curve) ? mapping.curve : 'linear';
  return `${curve} ${Math.min(mapping.min, mapping.max)}..${Math.max(mapping.min, mapping.max)}`;
};

const resolveMapping = (
  knob: MasterMacroKnob,
  macroId: string,
  macroName: string,
  mapping: MacroMapping,
  mappingIndex: number,
  state: ProjectState,
  normalizedValue: number
): ResolvedMacroParameter[] | UnresolvedMacroTarget => {
  const unresolved = (reason: string): UnresolvedMacroTarget => ({
    macroId,
    macroName,
    mappingIndex,
    targetType: String(mapping?.targetType),
    targetId: mapping?.targetId,
    reason
  });

  if (!mapping || typeof mapping !== 'object') {
    return unresolved('Mapping entry is malformed.');
  }
  if (!isSupportedTarget(mapping.targetType)) {
    return unresolved(`Target type "${String(mapping.targetType)}" has no runtime writer.`);
  }
  const targetType = mapping.targetType;
  if (!Number.isFinite(mapping.min) || !Number.isFinite(mapping.max)) {
    return unresolved('Mapping range min/max must be finite numbers.');
  }

  const value = clampToModelRange(
    targetType,
    resolveMacroCurveValue(mapping.min, mapping.max, mapping.curve, normalizedValue)
  );
  const targetId = String(mapping.targetId);

  switch (targetType) {
    case 'channel_volume': {
      const channel = resolveChannel(state, mapping.targetId);
      if (!channel) return unresolved(`No channel matches target id "${targetId}".`);
      return [{
        macroId, macroName, mappingIndex, targetType,
        parameter: 'channel.volume',
        targetId: channel.id,
        label: macroLabel(knob, `Channel "${channel.name}" volume ${describeMappingRange(mapping)}`),
        value
      }];
    }

    case 'channel_pan': {
      const channel = resolveChannel(state, mapping.targetId);
      if (!channel) return unresolved(`No channel matches target id "${targetId}".`);
      return [{
        macroId, macroName, mappingIndex, targetType,
        parameter: 'channel.pan',
        targetId: channel.id,
        label: macroLabel(knob, `Channel "${channel.name}" pan ${describeMappingRange(mapping)}`),
        value
      }];
    }

    case 'mixer_volume': {
      const track = resolveMixerTrack(state, mapping.targetId);
      if (!track) return unresolved(`No mixer track matches target id "${targetId}".`);
      return [{
        macroId, macroName, mappingIndex, targetType,
        parameter: 'mixerTrack.volume',
        targetId: String(track.id),
        label: macroLabel(knob, `Mixer "${track.name}" volume ${describeMappingRange(mapping)}`),
        value
      }];
    }

    case 'mixer_pan': {
      const track = resolveMixerTrack(state, mapping.targetId);
      if (!track) return unresolved(`No mixer track matches target id "${targetId}".`);
      return [{
        macroId, macroName, mappingIndex, targetType,
        parameter: 'mixerTrack.pan',
        targetId: String(track.id),
        label: macroLabel(knob, `Mixer "${track.name}" pan ${describeMappingRange(mapping)}`),
        value
      }];
    }

    case 'filter_cutoff': {
      const channels = resolveFilterChannels(state, mapping.targetId);
      if (channels.length === 0) {
        return unresolved(`No channel matches target id "${targetId}".`);
      }
      // A bus-scoped mapping resolves to one entry per routed channel so the
      // resolution stays a flat, inspectable list.
      return channels.map(channel => ({
        macroId, macroName, mappingIndex, targetType,
        parameter: 'channel.synthParams.filterCutoff',
        targetId: channel.id,
        label: macroLabel(knob, `Channel "${channel.name}" filter cutoff ${describeMappingRange(mapping)} (Hz)`),
        value
      }));
    }

    case 'reverb_wet': {
      const track = resolveFxTrack(state, mapping.targetId);
      if (!track) return unresolved(`No mixer track matches target id "${targetId}".`);
      const slot = findFxSlot(track, 'reverb');
      if (!slot) return unresolved(`Mixer track ${track.id} has no reverb slot to control.`);
      return [{
        macroId, macroName, mappingIndex, targetType,
        parameter: 'fxSlot.mix',
        targetId: `${track.id}/${slot.id}`,
        label: macroLabel(knob, `Reverb wet ${describeMappingRange(mapping)} on "${track.name}"`),
        value
      }];
    }

    case 'delay_feedback': {
      const track = resolveFxTrack(state, mapping.targetId);
      if (!track) return unresolved(`No mixer track matches target id "${targetId}".`);
      const slot = findFxSlot(track, 'delay');
      if (!slot) return unresolved(`Mixer track ${track.id} has no delay slot to control.`);
      return [{
        macroId, macroName, mappingIndex, targetType,
        parameter: 'fxSlot.feedback',
        targetId: `${track.id}/${slot.id}`,
        label: macroLabel(knob, `Delay feedback ${describeMappingRange(mapping)} on "${track.name}"`),
        value
      }];
    }

    default:
      return unresolved(`Target type "${String(targetType)}" has no runtime writer.`);
  }
};

/**
 * Resolves one macro knob against the current project state. Pure: it reads the
 * state to find targets and never mutates it.
 */
export const resolveMacroKnob = (
  knob: MasterMacroKnob,
  state: ProjectState
): MacroRackResolution => {
  const resolution: MacroRackResolution = { parameters: [], unresolved: [] };
  if (!knob || !Array.isArray(knob.mappings) || knob.mappings.length === 0) return resolution;

  const normalizedValue = Number.isFinite(knob.value) ? knob.value : 0;
  const macroId = typeof knob.id === 'string' ? knob.id : String(knob.id ?? '');
  const macroName = typeof knob.name === 'string' ? knob.name : macroId;

  knob.mappings.forEach((mapping, mappingIndex) => {
    const result = resolveMapping(
      knob, macroId, macroName, mapping, mappingIndex, state, normalizedValue
    );
    if (Array.isArray(result)) {
      resolution.parameters.push(...result);
    } else {
      resolution.unresolved.push(result);
    }
  });

  return resolution;
};

/**
 * Resolves the whole rack. Macros are visited in array order and mappings in
 * declaration order; overlapping mappings resolve to the last write.
 */
export const resolveMacroRack = (
  macroKnobs: readonly MasterMacroKnob[] | undefined,
  state: ProjectState
): MacroRackResolution => {
  const resolution: MacroRackResolution = { parameters: [], unresolved: [] };
  for (const knob of macroKnobs ?? []) {
    const knobResolution = resolveMacroKnob(knob, state);
    resolution.parameters.push(...knobResolution.parameters);
    resolution.unresolved.push(...knobResolution.unresolved);
  }
  return resolution;
};

/** Looks up one FX slot on a track; used to compare pending writes to live ones. */
const slotOf = (state: ProjectState, trackId: number, slotId: string) =>
  state.mixerTracks.find(track => track.id === trackId)?.fxSlots.find(slot => slot.id === slotId);

/**
 * Applies an already-resolved rack to project state as one atomic transition.
 *
 * When every resolved value already matches the state, the same state object is
 * returned by reference, which makes the whole operation idempotent by identity
 * and lets callers (hydration, autosave comparison, React publication) detect a
 * true no-op without a deep comparison.
 */
export const applyMacroResolution = (
  state: ProjectState,
  resolution: MacroRackResolution
): ProjectState => {
  if (resolution.parameters.length === 0) return state;

  // Resolve "last declared write wins" *before* comparing against the state.
  // Comparing intermediate values instead would let an earlier mapping's value
  // register as a change even when a later mapping restores the current value,
  // which would cost the operation its idempotency-by-identity guarantee.
  const winners = new Map<string, ResolvedMacroParameter>();
  for (const parameter of resolution.parameters) {
    winners.set(
      macroParameterKey(parameter.targetType, parameter.targetId, parameter.parameter),
      parameter
    );
  }

  const channels = new Map<string, Channel>();
  const synthParams = new Map<string, SynthParameters>();
  const mixerTracks = new Map<number, MixerTrack>();
  const fxMix = new Map<string, { trackId: number; slotId: string; value: number }>();
  const fxParams = new Map<string, { trackId: number; slotId: string; params: Record<string, number> }>();

  for (const parameter of winners.values()) {
    switch (parameter.parameter) {
      case 'channel.volume':
      case 'channel.pan': {
        const channel = resolveChannel(state, parameter.targetId);
        if (!channel) break;
        const field = parameter.parameter === 'channel.volume' ? 'volume' : 'pan';
        // An already-correct parameter is not rewritten, which keeps object
        // identity stable for React publication and autosave diffing.
        if (channel[field] === parameter.value) break;
        channels.set(channel.id, { ...(channels.get(channel.id) ?? channel), [field]: parameter.value } as Channel);
        break;
      }
      case 'channel.synthParams.filterCutoff': {
        const channel = resolveChannel(state, parameter.targetId);
        if (!channel) break;
        const base = synthParams.get(channel.id) ?? channel.synthParams;
        if (channel.synthParams.filterCutoff === parameter.value) break;
        synthParams.set(channel.id, { ...base, filterCutoff: parameter.value });
        break;
      }
      case 'mixerTrack.volume':
      case 'mixerTrack.pan': {
        const track = resolveMixerTrack(state, parameter.targetId);
        if (!track) break;
        const field = parameter.parameter === 'mixerTrack.volume' ? 'volume' : 'pan';
        if (track[field] === parameter.value) break;
        mixerTracks.set(track.id, { ...(mixerTracks.get(track.id) ?? track), [field]: parameter.value } as MixerTrack);
        break;
      }
      case 'fxSlot.mix':
      case 'fxSlot.feedback': {
        const { trackId, slotId } = splitFxTargetId(parameter.targetId);
        if (trackId === null) break;
        const slot = slotOf(state, trackId, slotId);
        if (!slot) break;
        if (parameter.parameter === 'fxSlot.mix') {
          if (slot.mix === parameter.value) break;
          fxMix.set(parameter.targetId, { trackId, slotId, value: parameter.value });
        } else {
          if (slot.params.feedback === parameter.value) break;
          fxParams.set(parameter.targetId, {
            trackId,
            slotId,
            params: { ...(fxParams.get(parameter.targetId)?.params ?? {}), feedback: parameter.value }
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // Rebuild FX slots once per touched slot so a mapping that writes both the wet
  // mix and a slot parameter stays a single slot object.
  const touchedTracks = new Set<number>();
  for (const entry of fxMix.values()) touchedTracks.add(entry.trackId);
  for (const entry of fxParams.values()) touchedTracks.add(entry.trackId);

  for (const trackId of touchedTracks) {
    const track = mixerTracks.get(trackId)
      ?? state.mixerTracks.find(candidate => candidate.id === trackId);
    if (!track) continue;

    mixerTracks.set(trackId, {
      ...track,
      fxSlots: track.fxSlots.map(slot => {
        const key = `${trackId}/${slot.id}`;
        const mix = fxMix.get(key);
        const params = fxParams.get(key);
        if (!mix && !params) return slot;
        return {
          ...slot,
          ...(mix ? { mix: mix.value } : {}),
          ...(params ? { params: { ...slot.params, ...params.params } } : {})
        };
      })
    });
  }

  if (channels.size === 0 && synthParams.size === 0 && mixerTracks.size === 0) return state;

  return {
    ...state,
    channels: state.channels.map(channel => {
      const channelUpdate = channels.get(channel.id);
      const synthUpdate = synthParams.get(channel.id);
      if (!channelUpdate && !synthUpdate) return channel;
      return {
        ...(channelUpdate ?? channel),
        ...(synthUpdate ? { synthParams: synthUpdate } : {})
      };
    }),
    mixerTracks: state.mixerTracks.map(track =>
      mixerTracks.get(track.id) ?? track
    )
  };
};

/** Splits the `"<trackId>/<slotId>"` display id back into its parts. */
function splitFxTargetId(targetId: string): { trackId: number | null; slotId: string } {
  const separator = targetId.indexOf('/');
  if (separator <= 0) return { trackId: null, slotId: '' };
  const trackId = Number(targetId.slice(0, separator));
  return {
    trackId: Number.isSafeInteger(trackId) ? trackId : null,
    slotId: targetId.slice(separator + 1)
  };
}

/**
 * The runtime entry point: writes the new knob values *and* every resolved
 * parameter into one new ProjectState.
 *
 * This is what makes a macro move atomic — the app publishes the returned state
 * through its normal mutation/history boundary, so the knob and all of its
 * targets land together and undo restores them together. Resolution runs against
 * `state`, the state the transition is applied to, so it composes with
 * `applyRuntimeProjectStateMutation` (which re-reads the live state inside the
 * updater).
 */
export const applyMacroRackUpdate = (
  state: ProjectState,
  macroKnobs: MasterMacroKnob[]
): ProjectState => {
  // Re-publishing the identical rack array is not a state change: keep the same
  // document object so a redundant publication stays a no-op by identity.
  const withKnobs: ProjectState =
    state.macroKnobs === macroKnobs ? state : { ...state, macroKnobs };
  if (!Array.isArray(macroKnobs) || macroKnobs.length === 0) return withKnobs;
  return applyMacroResolution(withKnobs, resolveMacroRack(macroKnobs, withKnobs));
};

/**
 * Re-applies the stored rack to a hydrated project. Used on project load, where
 * the persisted `macroKnobs` are the document of record for every mapped
 * parameter, so a reopened project restores the same resolved values.
 *
 * Idempotent: a state whose parameters already match the rack is returned
 * unchanged (referentially equal), which keeps load/save paths cheap and makes
 * the operation safe to call more than once.
 */
export const reapplyMacroRackOnHydration = (state: ProjectState): ProjectState => {
  const macroKnobs = state.macroKnobs;
  // A project with no rack resolves to nothing, so it is returned by reference:
  // hydration stays a true no-op for the vast majority of projects and cannot
  // churn identity comparisons (autosave diffing, React state publication).
  if (!Array.isArray(macroKnobs) || macroKnobs.length === 0) return state;
  return applyMacroRackUpdate(state, macroKnobs);
};

export interface MacroRackSummary {
  /** How many mappings resolved to a writable parameter. */
  applied: number;
  /** How many mappings named no writable target. */
  unresolved: number;
  /** Distinct parameters the rack currently controls. */
  parameters: number;
}

/** Compact status for the rack UI and tests: what the rack currently controls. */
export const summarizeMacroRack = (
  macroKnobs: readonly MasterMacroKnob[] | undefined,
  state: ProjectState
): MacroRackSummary => {
  const resolution = resolveMacroRack(macroKnobs, state);
  const parameters = new Set(
    resolution.parameters.map(parameter =>
      macroParameterKey(parameter.targetType, parameter.targetId, parameter.parameter)
    )
  );
  return {
    applied: resolution.parameters.length,
    unresolved: resolution.unresolved.length,
    parameters: parameters.size
  };
};
