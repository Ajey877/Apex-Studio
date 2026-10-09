/**
 * Phase 1M — Comping Lanes and Take Management.
 *
 * Groups multiple recording passes (takes) that share the same musical region
 * into a "take group." Each take is a full PlaylistClip with its own audio
 * buffer, but only the take whose `takeIndex` matches the group's
 * `activeTakeIndex` is audible during playback, export, and persistence.
 *
 * Non-destructive: every recorded take is preserved regardless of which is
 * active. Switching the active take never deletes or modifies the audio of
 * inactive takes.
 *
 * This module owns the pure logic only — no audio nodes, no React, no timers.
 * The audio engine, offline renderer, and persistence layer all call into
 * these functions to decide take audibility.
 *
 * Contract:
 *   - Clips without `takeGroupId` are ordinary clips; take rules do not apply.
 *   - Clips with `takeGroupId` participate in take selection. Within a group,
 *     the clip whose `takeIndex === activeTakeIndex` is the active take.
 *   - A group with no `activeTakeIndex` set defaults to the highest
 *     `takeIndex + 1` (the last recorded take) as active.
 *   - `isTakeAudible()` returns true only for the active take in its group,
 *     and true for any clip that is not part of a take group.
 *   - `selectActiveTake()` updates the active take for every clip in a group.
 */
import type { PlaylistClip } from '../types/daw';

/**
 * Resolves the active take index for a take group. When no explicit selection
 * exists, the latest take (highest `takeIndex`) is active by default — this
 * matches the standard DAW convention where the most recent recording is
 * what the musician hears.
 */
export const resolveActiveTakeIndex = (clips: readonly PlaylistClip[], takeGroupId: string): number | null => {
  const groupClips = clips.filter(c => c.takeGroupId === takeGroupId);
  if (groupClips.length === 0) return null;

  // If any clip in the group declares activeTakeIndex, use it.
  const declared = groupClips.find(c => typeof c.activeTakeIndex === 'number');
  if (declared && typeof declared.activeTakeIndex === 'number') {
    return declared.activeTakeIndex;
  }

  // Default: the highest takeIndex in the group is active.
  const maxTakeIndex = Math.max(...groupClips.map(c => typeof c.takeIndex === 'number' ? c.takeIndex : 0));
  return maxTakeIndex;
};

/**
 * True when a clip is part of a take group AND is not the active take.
 * Inactive takes are audible = false; everything else (ordinary clips, the
 * active take, clips without a takeGroupId) is audible = true.
 */
export const isTakeAudible = (clip: PlaylistClip, allClips: readonly PlaylistClip[]): boolean => {
  if (!clip.takeGroupId) return true;
  const activeIndex = resolveActiveTakeIndex(allClips, clip.takeGroupId);
  if (activeIndex === null) return true;
  const clipTakeIndex = typeof clip.takeIndex === 'number' ? clip.takeIndex : 0;
  return clipTakeIndex === activeIndex;
};

/**
 * Builds a lookup set of clip IDs that should be silenced because they belong
 * to a take group but are not the active take. This is more efficient than
 * calling `isTakeAudible` per-clip during playback scheduling.
 */
export const resolveInaudibleTakeClipIds = (clips: readonly PlaylistClip[]): Set<string> => {
  const inaudible = new Set<string>();
  // Group clips by takeGroupId
  const groups = new Map<string, PlaylistClip[]>();
  for (const clip of clips) {
    if (!clip.takeGroupId) continue;
    const list = groups.get(clip.takeGroupId);
    if (list) list.push(clip);
    else groups.set(clip.takeGroupId, [clip]);
  }
  for (const [, groupClips] of groups) {
    const activeIndex = resolveActiveTakeIndex(groupClips, groupClips[0].takeGroupId!);
    if (activeIndex === null) continue;
    for (const clip of groupClips) {
      const clipTakeIndex = typeof clip.takeIndex === 'number' ? clip.takeIndex : 0;
      if (clipTakeIndex !== activeIndex) {
        inaudible.add(clip.id);
      }
    }
  }
  return inaudible;
};

/**
 * Selects a specific take as active within its group. Updates `activeTakeIndex`
 * on every clip in the group so the selection is consistent regardless of
 * which clip is inspected. Returns a new clip array; inactive takes are
 * preserved unchanged (non-destructive).
 */
export const selectActiveTake = (
  clips: readonly PlaylistClip[],
  takeGroupId: string,
  takeIndex: number
): PlaylistClip[] => {
  if (!Number.isInteger(takeIndex) || takeIndex < 0) {
    throw new Error('Take index must be a non-negative integer');
  }
  let groupFound = false;
  const result = clips.map(clip => {
    if (clip.takeGroupId !== takeGroupId) return clip;
    groupFound = true;
    if (clip.activeTakeIndex === takeIndex) return clip;
    return { ...clip, activeTakeIndex: takeIndex };
  });
  if (!groupFound) {
    throw new Error(`No take group found with id "${takeGroupId}"`);
  }
  return result;
};

/**
 * Returns all clips belonging to a take group, sorted by takeIndex ascending.
 */
export const getTakeGroupClips = (
  clips: readonly PlaylistClip[],
  takeGroupId: string
): PlaylistClip[] => {
  return clips
    .filter(c => c.takeGroupId === takeGroupId)
    .sort((a, b) => (a.takeIndex ?? 0) - (b.takeIndex ?? 0));
};

/**
 * Returns all distinct take group IDs present in the clip list.
 */
export const getTakeGroupIds = (clips: readonly PlaylistClip[]): string[] => {
  const ids = new Set<string>();
  for (const clip of clips) {
    if (clip.takeGroupId) ids.add(clip.takeGroupId);
  }
  return [...ids];
};

/**
 * Computes the next `takeIndex` for a new take being added to an existing
 * group, or 0 if the group is new.
 */
export const nextTakeIndexForGroup = (clips: readonly PlaylistClip[], takeGroupId: string): number => {
  const groupClips = clips.filter(c => c.takeGroupId === takeGroupId);
  if (groupClips.length === 0) return 0;
  return Math.max(...groupClips.map(c => typeof c.takeIndex === 'number' ? c.takeIndex : -1)) + 1;
};

/**
 * Generates a deterministic take group ID from the track and position so that
 * multiple recordings at the same location are automatically grouped.
 */
export const createTakeGroupId = (trackIndex: number, startBar: number, timestamp?: number): string => {
  const ts = timestamp ?? Date.now();
  return `take-group-t${trackIndex}-b${startBar}-${ts}`;
};

/**
 * Validates that a take group is well-formed: all clips share the same
 * geometry (trackIndex, startBar, lengthBars), have unique takeIndex values,
 * and the active take index references an existing take.
 */
export const validateTakeGroup = (
  clips: readonly PlaylistClip[],
  takeGroupId: string
): { valid: boolean; issues: string[] } => {
  const groupClips = getTakeGroupClips(clips, takeGroupId);
  const issues: string[] = [];

  if (groupClips.length === 0) {
    issues.push(`Take group "${takeGroupId}" has no clips`);
    return { valid: false, issues };
  }

  // Check geometry consistency
  const ref = groupClips[0];
  for (const clip of groupClips.slice(1)) {
    if (clip.trackIndex !== ref.trackIndex) {
      issues.push(`Take group "${takeGroupId}" has clips on different tracks`);
    }
    if (clip.startBar !== ref.startBar) {
      issues.push(`Take group "${takeGroupId}" has clips at different start positions`);
    }
    if (clip.lengthBars !== ref.lengthBars) {
      issues.push(`Take group "${takeGroupId}" has clips with different lengths`);
    }
  }

  // Check unique takeIndex values
  const indices = groupClips.map(c => c.takeIndex ?? 0);
  const unique = new Set(indices);
  if (unique.size !== indices.length) {
    issues.push(`Take group "${takeGroupId}" has duplicate takeIndex values`);
  }

  // Check activeTakeIndex references a real take
  const activeIndex = resolveActiveTakeIndex(groupClips, takeGroupId);
  if (activeIndex !== null && !unique.has(activeIndex)) {
    issues.push(`Take group "${takeGroupId}" activeTakeIndex ${activeIndex} does not match any take`);
  }

  return { valid: issues.length === 0, issues };
};

/**
 * Removes a specific take from a group. If the removed take was the active
 * one, the active selection falls back to the nearest remaining take. If it
 * was the only take, the remaining clip loses its take-group fields (becomes
 * an ordinary clip).
 */
export const removeTakeFromGroup = (
  clips: readonly PlaylistClip[],
  takeGroupId: string,
  takeIndexToRemove: number
): PlaylistClip[] => {
  const groupClips = getTakeGroupClips(clips, takeGroupId);
  if (groupClips.length === 0) return [...clips];

  const remaining = groupClips.filter(c => (c.takeIndex ?? 0) !== takeIndexToRemove);

  // If only one or zero remain, dissolve the group
  if (remaining.length <= 1) {
    const result: PlaylistClip[] = [];
    for (const clip of clips) {
      if (clip.takeGroupId !== takeGroupId) {
        result.push(clip);
        continue;
      }
      if ((clip.takeIndex ?? 0) === takeIndexToRemove) continue; // deleted
      // Last remaining clip: strip take-group fields, becomes ordinary
      const { takeGroupId: _g, takeIndex: _t, activeTakeIndex: _a, ...rest } = clip as PlaylistClip & { takeGroupId?: string; takeIndex?: number; activeTakeIndex?: number };
      result.push(rest as PlaylistClip);
    }
    return result;
  }

  // Check if the removed take was the active one
  const currentActive = resolveActiveTakeIndex(groupClips, takeGroupId);
  const wasActive = currentActive === takeIndexToRemove;

  const result: PlaylistClip[] = [];
  for (const clip of clips) {
    if (clip.takeGroupId !== takeGroupId) {
      result.push(clip);
      continue;
    }
    if ((clip.takeIndex ?? 0) === takeIndexToRemove) continue; // deleted
    if (wasActive) {
      // Fall back to the nearest remaining take
      const fallback = remaining.reduce((best, c) => {
        const ci = c.takeIndex ?? 0;
        const bi = best.takeIndex ?? 0;
        return Math.abs(ci - takeIndexToRemove) < Math.abs(bi - takeIndexToRemove) ? c : best;
      }, remaining[0]);
      const fallbackIndex = fallback.takeIndex ?? 0;
      if (clip.activeTakeIndex !== fallbackIndex) {
        result.push({ ...clip, activeTakeIndex: fallbackIndex });
      } else {
        result.push(clip);
      }
    } else {
      result.push(clip);
    }
  }
  return result;
};
