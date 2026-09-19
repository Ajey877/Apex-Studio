import type { Channel, Pattern } from '../types/daw';
import { normalizePatternLengthSteps } from '../state/patternLength';

/**
 * Phase 9D — Channel Rack step-grid semantics.
 *
 * The rack renders the step grid of the SELECTED pattern and its width comes
 * from `Pattern.lengthSteps` — the rack keeps no length state of its own, so the
 * grid, Pattern Mode playback, persistence and Pattern export all read the same
 * declared value.
 *
 * Every helper below is pure so the grid's editing behaviour can be tested
 * without a DOM. They only ever touch `Channel.steps`; piano-roll notes and all
 * other channel fields are left alone.
 */

/** Steps the rack shows for a pattern: its declared length, normalized. */
export const getChannelRackStepLength = (
  patterns: Pattern[],
  selectedPatternId: string
): number => normalizePatternLengthSteps(
  patterns.find(pattern => pattern.id === selectedPatternId)?.lengthSteps
);

const gridLengthOf = (stepLength: number): number =>
  Number.isFinite(stepLength) && stepLength > 0 ? Math.floor(stepLength) : 0;

/**
 * Step data past the visible grid is preserved: a channel can hold steps beyond
 * the declared length (extending the pattern reveals them again), so a grid edit
 * must not silently erase what the user cannot see.
 */
const preserveStepsBeyondGrid = (existing: boolean[], gridLength: number): boolean[] => {
  const length = Math.max(gridLength, existing.length);
  const steps = new Array<boolean>(length).fill(false);
  for (let index = gridLength; index < length; index += 1) {
    steps[index] = existing[index] === true;
  }
  return steps;
};

/**
 * Toggles one grid cell. The array grows on demand so a channel that still holds
 * a shorter (legacy 16-step) array can be edited anywhere inside the declared
 * grid without a separate "resize" step.
 */
export const toggleChannelStep = (channel: Channel, stepIndex: number): boolean[] => {
  const steps = [...(channel.steps ?? [])];
  while (steps.length <= stepIndex) steps.push(false);
  steps[stepIndex] = !steps[stepIndex];
  return steps;
};

/** Fills every `interval` steps across the declared grid, preserving hidden steps. */
export const fillChannelSteps = (
  channel: Channel,
  interval: number,
  stepLength: number
): boolean[] => {
  const safeInterval = Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 1;
  const gridLength = gridLengthOf(stepLength);
  const steps = preserveStepsBeyondGrid(channel.steps ?? [], gridLength);
  for (let index = 0; index < gridLength; index += safeInterval) {
    steps[index] = true;
  }
  return steps;
};

/**
 * Clears the declared grid only. Anything the user cannot see (steps past the
 * declared length, kept when the length was reduced) survives, so clearing a
 * one-bar view of a two-bar channel never destroys the second bar.
 */
export const clearChannelSteps = (channel: Channel, stepLength: number): boolean[] =>
  preserveStepsBeyondGrid(channel.steps ?? [], gridLengthOf(stepLength));
