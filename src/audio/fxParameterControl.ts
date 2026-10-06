/**
 * Phase 81 — shared FX parameter control semantics.
 *
 * Three runtime paths drive the same FX slot parameters from a normalized
 * 0..1 control value:
 *
 *   1. playlist automation clips (`audioEngine.applyAutomationValue`, target
 *      type `fx_param`),
 *   2. hardware MIDI CC (`midiMappingRuntime.resolveFxParamTarget`),
 *   3. the mixer's per-slot parameter editor (`fxParameterControls`, which
 *      already writes contract values directly and only needs the discovery
 *      helpers below).
 *
 * Before this module, (1) did not exist at all and (2) only understood the
 * slot wet/dry `mix` — every in-contract DSP parameter (EQ bands, compressor
 * threshold/knee/ratio/attack/release, delay time/feedback, limiter
 * ceiling/release/drive) was unreachable from both. Each of those paths would
 * otherwise need its own range conversion and its own idea of how a target
 * names a track + slot + parameter, which is exactly how automation, a
 * hardware knob and a UI fader end up disagreeing about the same parameter.
 *
 * The contract (`fxParameterContract.ts`) stays the single source of truth for
 * ids, ranges, defaults and units. This module adds only:
 *
 *   - a deterministic *address* for an FX parameter (track id + slot id +
 *     contract param id), including the `"<trackId>/<slotId>"` composite form
 *     `macroMappings.ts` already uses for FX targets;
 *   - resolution of that address against a real `MixerTrack[]`, which reports
 *     a reason instead of guessing when the track, the slot or the parameter
 *     is missing (a deleted slot or a stale project reference must fail safe);
 *   - the normalized <-> contract conversion, delegated to the contract so a
 *     parameter's range is defined exactly once.
 *
 * Everything here is pure: no audio-graph writes, no project-state mutation.
 * The callers own the write, which keeps the "project state is the source of
 * truth" property Phase 80 established.
 */

import type { FxSlot, FxType, MixerTrack } from '../types/daw';
import {
  SLOT_MIX_PARAMETER,
  fxParamValueFromNormalized,
  fxParamValueToNormalized,
  listFxParameterSpecs,
  resolveFxParameterSpec,
  type FxParameterSpec,
  type FxParamUnit,
} from './fxParameterContract';

/** The `AutomationTargetType` / `MidiMapping.targetType` value this module resolves. */
export const FX_PARAM_TARGET_TYPE = 'fx_param' as const;

/** Separator for the composite `"<trackId>/<slotId>"` FX target id. */
export const FX_TARGET_ID_SEPARATOR = '/';

/**
 * Builds the deterministic composite target id for a slot.
 *
 * A bare slot id is ambiguous the moment two tracks own a slot with the same
 * id, and — more importantly — it cannot survive an FX slot being deleted and
 * a *different* slot later reusing that id on another track. The composite
 * form pins the track, so an automation clip or a CC mapping can never be
 * silently redirected to another insert.
 */
export const formatFxSlotTargetId = (trackId: number, slotId: string): string =>
  `${trackId}${FX_TARGET_ID_SEPARATOR}${slotId}`;

export interface FxSlotTargetId {
  /** `null` when the id is a bare slot id (no track pinned) or is malformed. */
  trackId: number | null;
  slotId: string;
}

/**
 * Splits an FX target id. Accepts both shapes:
 *
 *   - `"<trackId>/<slotId>"` — the deterministic Phase 81 form;
 *   - `"<slotId>"` — the legacy form shipped by the `fx-5-verb` + `mix`
 *     preset mapping and by MIDI Learn captures taken before this phase. A
 *     bare id keeps resolving by searching the tracks in array order, so
 *     existing controller bindings keep working.
 */
export const parseFxSlotTargetId = (targetId: string | number): FxSlotTargetId => {
  if (typeof targetId === 'number') {
    return Number.isSafeInteger(targetId) ? { trackId: null, slotId: String(targetId) } : { trackId: null, slotId: '' };
  }
  if (typeof targetId !== 'string') return { trackId: null, slotId: '' };
  const separator = targetId.indexOf(FX_TARGET_ID_SEPARATOR);
  if (separator <= 0) return { trackId: null, slotId: targetId };
  const trackId = Number(targetId.slice(0, separator));
  if (!Number.isSafeInteger(trackId)) {
    // A malformed composite is treated as one opaque bare id. Slot ids never
    // contain the separator, so this can only ever resolve to nothing — the
    // safe answer for a hand-edited or corrupted document.
    return { trackId: null, slotId: targetId };
  }
  return { trackId, slotId: targetId.slice(separator + 1) };
};

/** True when the param id names the per-slot wet/dry mix owned by the WetDry wrapper. */
export const isFxSlotMixParam = (paramId: string): boolean => paramId === SLOT_MIX_PARAMETER.id;

export type FxSlotLookup =
  | { status: 'resolved'; track: MixerTrack; slot: FxSlot }
  | { status: 'unresolved'; reason: string };

/**
 * Resolves an FX target id to a real track + slot.
 *
 * A composite id is resolved strictly: the slot must live on the named track.
 * That is what stops a deleted slot (or one moved to another insert) from
 * quietly addressing a different effect. A bare id falls back to the legacy
 * first-match-in-array-order search so pre-Phase 81 mappings keep working.
 */
export const resolveFxSlot = (
  mixerTracks: readonly MixerTrack[] | undefined,
  targetId: string | number,
): FxSlotLookup => {
  const tracks = mixerTracks ?? [];
  const { trackId, slotId } = parseFxSlotTargetId(targetId);
  if (!slotId) {
    return { status: 'unresolved', reason: `FX target id "${String(targetId)}" names no slot.` };
  }

  if (trackId !== null) {
    const track = tracks.find(candidate => candidate.id === trackId);
    if (!track) {
      return { status: 'unresolved', reason: `No mixer track matches FX target id "${String(targetId)}".` };
    }
    const slot = track.fxSlots.find(candidate => candidate.id === slotId);
    if (!slot) {
      return {
        status: 'unresolved',
        reason: `Mixer track ${trackId} has no FX slot "${slotId}" (deleted, replaced or moved).`,
      };
    }
    return { status: 'resolved', track, slot };
  }

  for (const track of tracks) {
    const slot = track.fxSlots.find(candidate => candidate.id === slotId);
    if (slot) return { status: 'resolved', track, slot };
  }
  return { status: 'unresolved', reason: `No FX slot matches target id "${String(targetId)}".` };
};

export interface FxParameterUpdate {
  trackId: number;
  slotId: string;
  /** Contract slot-param id (`'time'`, `'threshold'`, …) or `'mix'`. */
  paramId: string;
  fxType: FxType;
  spec: FxParameterSpec;
  /** The value in the contract's own units/range — what `FxSlot` stores. */
  value: number;
  /** The normalized 0..1 value the caller supplied, clamped. */
  normalized: number;
  /** True when the update targets `FxSlot.mix` rather than `FxSlot.params`. */
  isMix: boolean;
}

export type FxParameterResolution =
  | { status: 'resolved'; update: FxParameterUpdate }
  | { status: 'rejected'; reason: string };

/**
 * The single resolution path shared by automation and MIDI CC.
 *
 * Given a target id, a param id and a normalized 0..1 value, it answers
 * either with the fully-validated contract value to write (and where to write
 * it) or with a human-readable reason. It never throws and never invents a
 * target: a missing track, a deleted slot, an empty or non-contract param id
 * and a non-finite value are all rejected or defaulted here, once, so no
 * caller has to re-derive the rules.
 */
export const resolveFxParameterUpdate = (
  mixerTracks: readonly MixerTrack[] | undefined,
  targetId: string | number,
  paramId: unknown,
  normalizedValue: number,
): FxParameterResolution => {
  const id = typeof paramId === 'string' ? paramId.trim() : '';
  if (!id) {
    return { status: 'rejected', reason: `FX target "${String(targetId)}" has no paramName, so it names no parameter.` };
  }

  const lookup = resolveFxSlot(mixerTracks, targetId);
  if (lookup.status !== 'resolved') return { status: 'rejected', reason: lookup.reason };

  const spec = resolveFxParameterSpec(lookup.slot.type, id);
  if (!spec) {
    return {
      status: 'rejected',
      reason: `FX parameter "${id}" is not in the ${lookup.slot.type} contract, so it has no AudioParam consumer.`,
    };
  }

  const value = fxParamValueFromNormalized(lookup.slot.type, id, normalizedValue);
  if (value === null) {
    return { status: 'rejected', reason: `FX parameter "${id}" has no contract range on ${lookup.slot.type}.` };
  }

  return {
    status: 'resolved',
    update: {
      trackId: lookup.track.id,
      slotId: lookup.slot.id,
      paramId: id,
      fxType: lookup.slot.type,
      spec,
      value,
      normalized: Number.isFinite(normalizedValue) ? Math.max(0, Math.min(1, normalizedValue)) : 0,
      isMix: isFxSlotMixParam(id),
    },
  };
};

/**
 * Reads a slot's current value for a contract param as a normalized 0..1
 * control value. Returns the spec default (normalized) when the slot has never
 * stored the param, so a lane seeded from an untouched slot starts at the
 * value the DSP is actually using.
 */
export const fxSlotParamToNormalized = (slot: FxSlot, paramId: string): number => {
  const spec = resolveFxParameterSpec(slot.type, paramId);
  if (!spec) return 0;
  if (isFxSlotMixParam(paramId)) {
    return fxParamValueToNormalized(slot.type, paramId, Number(slot.mix)) ?? 0;
  }
  const raw = slot.params?.[paramId];
  const stored = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(stored)) {
    return fxParamValueToNormalized(slot.type, paramId, spec.default) ?? 0;
  }
  return fxParamValueToNormalized(slot.type, paramId, stored) ?? 0;
};

export interface FxSlotOption {
  /** Composite, deterministic `"<trackId>/<slotId>"` id — safe to use as a `<select>` value. */
  targetId: string;
  trackId: number;
  slotId: string;
  fxType: FxType;
  trackName: string;
  slotName: string;
  label: string;
  /** True when the slot's family owns at least one contract DSP parameter. */
  hasContractParams: boolean;
}

/**
 * Every FX slot in the project, in mixer order, addressed by the composite
 * target id. This is the discovery surface the automation target picker and
 * the MIDI Learn binder share, so both list exactly the slots that exist.
 */
export const listFxSlotOptions = (mixerTracks: readonly MixerTrack[] | undefined): FxSlotOption[] => {
  const options: FxSlotOption[] = [];
  for (const track of mixerTracks ?? []) {
    for (const slot of track.fxSlots) {
      options.push({
        targetId: formatFxSlotTargetId(track.id, slot.id),
        trackId: track.id,
        slotId: slot.id,
        fxType: slot.type,
        trackName: track.name,
        slotName: slot.name,
        label: `${track.name} · ${slot.name}`,
        hasContractParams: listFxParameterSpecs(slot.type).some(spec => !isFxSlotMixParam(spec.id)),
      });
    }
  }
  return options;
};

export interface FxParameterOption {
  /** Composite, deterministic id for `automationTarget.targetId` / `MidiMapping.targetId`. */
  targetId: string;
  trackId: number;
  slotId: string;
  paramId: string;
  fxType: FxType;
  /** The contract's own label for the parameter, e.g. `"Low Frequency"`. */
  paramLabel: string;
  /** Fully qualified label, e.g. `"Insert 1 · Studio EQ · Low Frequency"`. */
  label: string;
  unit: FxParamUnit;
  min: number;
  max: number;
  default: number;
  /** True when the option is the slot's wet/dry mix rather than a family DSP param. */
  isMix: boolean;
}

const unitSuffix = (unit: FxParamUnit): string => {
  switch (unit) {
    case 'dB': return ' dB';
    case 'Hz': return ' Hz';
    case 'ms': return ' ms';
    case 's': return ' s';
    case 'percent': return ' %';
    case 'bits': return ' bit';
    case 'ratio': return ':1';
    default: return '';
  }
};

/**
 * Discovery for the automation target picker and the MIDI Learn binder: every
 * contract parameter of every slot on the given tracks (optionally narrowed to
 * one track / one slot), each with the deterministic composite target id and a
 * human-readable label.
 *
 * This is what makes the supported set *selectable* rather than merely
 * implementable: the UI cannot offer a parameter the contract does not own,
 * and cannot offer a slot that does not exist.
 *
 * `includeMix: false` drops the per-slot wet/dry mix, which the automation UI
 * exposes through its own dedicated `fx_mix` target so the same parameter is
 * not offered through two different addresses.
 */
export const listFxParameterOptions = (
  mixerTracks: readonly MixerTrack[] | undefined,
  filter?: { trackId?: number; slotId?: string; includeMix?: boolean },
): FxParameterOption[] => {
  const includeMix = filter?.includeMix !== false;
  const options: FxParameterOption[] = [];
  for (const track of mixerTracks ?? []) {
    if (filter?.trackId !== undefined && track.id !== filter.trackId) continue;
    for (const slot of track.fxSlots) {
      if (filter?.slotId !== undefined && slot.id !== filter.slotId) continue;
      for (const spec of listFxParameterSpecs(slot.type)) {
        const isMix = isFxSlotMixParam(spec.id);
        if (isMix && !includeMix) continue;
        options.push({
          targetId: formatFxSlotTargetId(track.id, slot.id),
          trackId: track.id,
          slotId: slot.id,
          paramId: spec.id,
          fxType: slot.type,
          paramLabel: spec.label,
          label: `${track.name} · ${slot.name} · ${spec.label}`,
          unit: spec.unit,
          min: spec.min,
          max: spec.max,
          default: spec.default,
          isMix,
        });
      }
    }
  }
  return options;
};

/** Human-readable description of a resolved update, for history labels and status text. */
export const describeFxParameterUpdate = (update: FxParameterUpdate): string =>
  `${update.spec.label} ${update.value.toFixed(3)}${unitSuffix(update.spec.unit)}`;

/** Contract range as UI text, e.g. `"-100–0 dB"` or `"20–20000 Hz"`. */
export const formatFxParameterRange = (spec: Pick<FxParameterSpec, 'unit' | 'min' | 'max'>): string =>
  `${spec.min}\u2013${spec.max}${unitSuffix(spec.unit)}`;

/**
 * True when an automation / CC target id addresses `trackId`.
 *
 * Used by the offline stem exporter so an FX parameter clip is included in the
 * stem of the insert it actually drives (the legacy numeric-target comparison
 * cannot see a composite `"<trackId>/<slotId>"` id).
 */
export const fxTargetIdBelongsToTrack = (targetId: string | number, trackId: number): boolean => {
  const parsed = parseFxSlotTargetId(targetId);
  return parsed.trackId === trackId;
};
