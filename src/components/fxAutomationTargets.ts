/**
 * Phase 81 — FX automation target construction for the playlist automation
 * editor.
 *
 * The playlist automation clip carries a single `automationTarget`
 * `{ type, targetId, paramName, label }`. FX targets need three coordinates —
 * mixer insert, FX slot and contract parameter — so the addressing is:
 *
 *   `fx_param` : targetId = `"<trackId>/<slotId>"` (composite), paramName = contract param id
 *   `fx_mix`   : targetId = trackId (number),        paramName = slot id
 *
 * `fx_mix` keeps the addressing the engine already shipped so existing
 * documents stay valid; `fx_param` uses the composite form so a lane can never
 * be silently redirected to another insert after a slot is deleted, replaced or
 * reused.
 *
 * These builders are pure and live outside the component so the picker's
 * behaviour — including the "no contract parameter on this slot" and "project
 * has no FX slots" fallbacks — is directly testable without rendering React.
 * Every candidate slot and parameter comes from `fxParameterControl`, which
 * reads the FX contract, so the UI can only offer a parameter that has a real
 * AudioParam consumer.
 */

import type { AutomationTargetType, MixerTrack } from '../types/daw';
import {
  formatFxSlotTargetId,
  listFxParameterOptions,
  listFxSlotOptions,
  parseFxSlotTargetId,
  type FxParameterOption,
  type FxSlotOption,
} from '../audio/fxParameterControl';

export type FxAutomationTargetType = 'fx_mix' | 'fx_param';

export interface AutomationTargetDraft {
  type: AutomationTargetType;
  targetId: string | number;
  paramName?: string;
  label?: string;
}

const slotLabel = (slot: FxSlotOption, detail: string): string =>
  `${slot.trackName} ${slot.slotName} ${detail}`.trim();

/** The contract parameters a single slot offers to `fx_param` (the mix has its own target type). */
export const listFxSlotParameterOptions = (
  mixerTracks: readonly MixerTrack[] | undefined,
  trackId: number | null,
  slotId: string,
): FxParameterOption[] => {
  if (trackId === null || !slotId) return [];
  return listFxParameterOptions(mixerTracks, { trackId, slotId, includeMix: false });
};

/**
 * The composite `"<trackId>/<slotId>"` id an existing automation target
 * addresses, or `''` when it addresses no slot. Works for both FX target types
 * so the slot `<select>` has one stable value space.
 */
export const fxAutomationSlotTargetId = (target?: AutomationTargetDraft | null): string => {
  if (!target) return '';
  if (target.type === 'fx_param') {
    const parsed = parseFxSlotTargetId(target.targetId);
    return parsed.trackId === null || !parsed.slotId ? '' : formatFxSlotTargetId(parsed.trackId, parsed.slotId);
  }
  if (target.type === 'fx_mix') {
    const trackId = typeof target.targetId === 'number' ? target.targetId : Number(target.targetId);
    const slotId = typeof target.paramName === 'string' ? target.paramName : '';
    if (!Number.isSafeInteger(trackId) || !slotId) return '';
    return formatFxSlotTargetId(trackId, slotId);
  }
  return '';
};

/** An empty target that the engine resolves to "nothing to do" instead of a wrong parameter. */
const emptyFxTarget = (type: FxAutomationTargetType): AutomationTargetDraft =>
  type === 'fx_mix'
    ? { type, targetId: 0, paramName: '', label: 'FX Wet/Dry (no effect slot)' }
    : { type, targetId: '', paramName: '', label: 'FX Parameter (no effect slot)' };

/**
 * Picks the slot a target type should land on when the user selects it from
 * the type dropdown: the slot the clip already addresses when it is still
 * present, otherwise the first slot that can carry that target type.
 */
const preferredSlot = (
  mixerTracks: readonly MixerTrack[] | undefined,
  type: FxAutomationTargetType,
  current?: AutomationTargetDraft | null,
): FxSlotOption | undefined => {
  const slots = listFxSlotOptions(mixerTracks);
  if (slots.length === 0) return undefined;
  const currentId = fxAutomationSlotTargetId(current);
  const kept = currentId ? slots.find(slot => slot.targetId === currentId) : undefined;
  if (kept) return kept;
  if (type === 'fx_param') {
    // A slot whose family bakes its parameters into a curve (distortion,
    // bitcrusher, tape saturation, chorus, convolver reverb) owns no contract
    // parameter, so `fx_param` prefers a slot that has one.
    return slots.find(slot => slot.hasContractParams) ?? slots[0];
  }
  return slots[0];
};

/** Builds the target the type dropdown should publish when the user picks an FX target type. */
export const buildFxAutomationTarget = (
  type: FxAutomationTargetType,
  mixerTracks: readonly MixerTrack[] | undefined,
  current?: AutomationTargetDraft | null,
): AutomationTargetDraft => {
  const slot = preferredSlot(mixerTracks, type, current);
  if (!slot) return emptyFxTarget(type);

  if (type === 'fx_mix') {
    return {
      type,
      targetId: slot.trackId,
      paramName: slot.slotId,
      label: slotLabel(slot, 'Wet/Dry'),
    };
  }

  const params = listFxSlotParameterOptions(mixerTracks, slot.trackId, slot.slotId);
  const keptParam = typeof current?.paramName === 'string'
    ? params.find(param => param.paramId === current?.paramName)
    : undefined;
  const param = keptParam ?? params[0];
  if (!param) {
    // Honest empty state: the slot exists but its family has no AudioParam-
    // updatable parameter, so there is nothing to automate beyond the mix.
    return { type, targetId: slot.targetId, paramName: '', label: slotLabel(slot, '(no automatable parameter)') };
  }
  return {
    type,
    targetId: slot.targetId,
    paramName: param.paramId,
    label: slotLabel(slot, param.paramLabel),
  };
};

/** Builds the target published when the user picks a different FX slot. */
export const buildFxSlotAutomationTarget = (
  type: FxAutomationTargetType,
  mixerTracks: readonly MixerTrack[] | undefined,
  compositeSlotTargetId: string,
  current?: AutomationTargetDraft | null,
): AutomationTargetDraft => {
  const slot = listFxSlotOptions(mixerTracks).find(candidate => candidate.targetId === compositeSlotTargetId);
  if (!slot) return emptyFxTarget(type);

  if (type === 'fx_mix') {
    return { type, targetId: slot.trackId, paramName: slot.slotId, label: slotLabel(slot, 'Wet/Dry') };
  }

  const params = listFxSlotParameterOptions(mixerTracks, slot.trackId, slot.slotId);
  const kept = typeof current?.paramName === 'string'
    ? params.find(param => param.paramId === current?.paramName)
    : undefined;
  const param = kept ?? params[0];
  if (!param) {
    return { type, targetId: slot.targetId, paramName: '', label: slotLabel(slot, '(no automatable parameter)') };
  }
  return { type, targetId: slot.targetId, paramName: param.paramId, label: slotLabel(slot, param.paramLabel) };
};

/** Builds the target published when the user picks a different contract parameter. */
export const buildFxParamAutomationTarget = (
  mixerTracks: readonly MixerTrack[] | undefined,
  compositeSlotTargetId: string,
  paramId: string,
): AutomationTargetDraft | null => {
  const parsed = parseFxSlotTargetId(compositeSlotTargetId);
  if (parsed.trackId === null || !parsed.slotId || !paramId) return null;
  const option = listFxSlotParameterOptions(mixerTracks, parsed.trackId, parsed.slotId)
    .find(candidate => candidate.paramId === paramId);
  if (!option) return null;
  const slot = listFxSlotOptions(mixerTracks).find(candidate => candidate.targetId === compositeSlotTargetId);
  return {
    type: 'fx_param',
    targetId: compositeSlotTargetId,
    paramName: option.paramId,
    label: slot ? slotLabel(slot, option.paramLabel) : option.label,
  };
};
