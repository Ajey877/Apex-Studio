import type { Pattern, ProjectState } from '../types/daw';
import { updatePatternInProjectState } from './projectMutations';

/**
 * Phase 9D — Pattern length source of truth.
 *
 * `Pattern.lengthSteps` is the ONE authoritative length of a pattern. Everything
 * that needs a pattern length derives it from project state through this module:
 *
 *   Channel Rack grid   -> `normalizePatternLengthSteps(selectedPattern.lengthSteps)`
 *   Pattern Mode loop   -> `AudioEngine.play(..., getSelectedPatternLengthSteps(state))`
 *                          -> `resolvePatternLoopLengthSteps()`
 *   Pattern Loop export -> `renderTimelineOffline(..., patternLengthSteps)`
 *                          -> the same `resolvePatternLoopLengthSteps()`
 *   Piano Roll width    -> floor-expanded by the same declared length
 *
 * Loop *resolution* stays single-sourced in the audio engine
 * (`resolvePatternLoopLengthSteps` / `resolvePlayableContentLengthSteps`): this
 * module only owns the declared value — how it is read, validated and written
 * through project mutations. It deliberately contains no playback or export
 * length algorithm of its own.
 */

/** One bar of the step grid. Pattern lengths are always whole bars. */
export const PATTERN_STEPS_PER_BAR = 16;

/** A new/default pattern is one bar long, matching the default project and every preset. */
export const DEFAULT_PATTERN_LENGTH_STEPS = PATTERN_STEPS_PER_BAR;

/**
 * Lengths the Channel Rack offers as explicit choices. The model itself is not
 * limited to these: `Pattern.lengthSteps` is a plain number and 64-step patterns
 * load, play and export correctly.
 */
export const PATTERN_LENGTH_CHOICES: readonly number[] = [16, 32];

/**
 * Normalizes a declared pattern length to the value the rest of the app uses:
 * a positive whole number of bars, or the 16-step default when the input is
 * missing/invalid. Quantizing to whole bars matches the audio engine's own
 * resolution, so the declared value and resolved loop boundary cannot disagree.
 *
 * There is intentionally no new maximum here: the existing Pattern model uses a
 * number and already supports at least 64. Phase 9D does not narrow that model;
 * the Channel Rack merely keeps its existing 16/32 choices.
 */
export const normalizePatternLengthSteps = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_PATTERN_LENGTH_STEPS;
  }
  return Math.max(1, Math.ceil(value / PATTERN_STEPS_PER_BAR)) * PATTERN_STEPS_PER_BAR;
};

/** Whole bars needed to contain a declared pattern length (export render window). */
export const getPatternLengthBars = (value: unknown): number =>
  normalizePatternLengthSteps(value) / PATTERN_STEPS_PER_BAR;

/** The pattern `selectedPatternId` points at, or `undefined` when nothing matches. */
export const findPatternById = (state: ProjectState, patternId: string): Pattern | undefined =>
  state.patterns.find(pattern => pattern.id === patternId);

/** The pattern the Channel Rack / Pattern Mode / Pattern export operate on. */
export const getSelectedPattern = (state: ProjectState): Pattern | undefined =>
  findPatternById(state, state.selectedPatternId);

/**
 * Declared length of the selected pattern, normalized. Callers pass this to the
 * audio engine and export instead of reaching into `patterns` themselves, so
 * playback, editing and export always agree on one value.
 */
export const getSelectedPatternLengthSteps = (state: ProjectState): number =>
  normalizePatternLengthSteps(getSelectedPattern(state)?.lengthSteps);

/**
 * Writes a pattern's declared length through the project mutation layer.
 *
 * `Channel.steps` and `Channel.notes` are deliberately not resized:
 *
 * - 16 -> 32: a shorter steps array is valid; the Channel Rack grows it only
 *   when a cell is actually written.
 * - 32 -> 16: all later step/note data is preserved internally but Pattern Mode
 *   and Pattern export ignore it because the declared Pattern length is
 *   authoritative. Extending (or undoing) reveals the data again.
 *
 * This is the only non-destructive choice in the current model: channels are
 * Channel-scoped and shared by patterns, so changing one Pattern must never erase
 * channel data another pattern or undo state may still need.
 *
 * Pure and idempotent: an unknown pattern id, or a length already in effect,
 * returns the state object unchanged so history records no phantom entry.
 */
export const setPatternLengthStepsInProjectState = (
  state: ProjectState,
  patternId: string,
  lengthSteps: number
): ProjectState => {
  const pattern = findPatternById(state, patternId);
  if (!pattern) return state;

  const nextLengthSteps = normalizePatternLengthSteps(lengthSteps);
  if (pattern.lengthSteps === nextLengthSteps) return state;
  return updatePatternInProjectState(state, patternId, { lengthSteps: nextLengthSteps });
};
