import type { PlaylistClip, ProjectState } from '../types/daw';

/**
 * Phase 54 — the playlist timeline contract.
 *
 * `totalBars` used to be component-local React state inside `PlaylistArranger`
 * (`useState(32)`). It was therefore not part of the saved document, not part of
 * history, and — most importantly — the grid-click clip producer did not pass it
 * to `assertValidPlaylistClip`, so a clip clicked onto the last grid cell of a
 * 32-bar timeline was accepted at `startBar: 31`. Because export length is
 * derived from clip extents, the exported WAV was 35 bars long while the user
 * was looking at a 32-bar timeline.
 *
 * This module is the single authority for the timeline length. It keeps the
 * rule pure and shared so the component, the project document, persistence,
 * history and the export window all resolve the same number instead of keeping
 * separate copies that can drift:
 *
 *   ProjectState.totalBars
 *     -> PlaylistArranger clip bounds
 *       -> clip creation / shrink revalidation
 *         -> export render window
 *
 * Everything here is a pure function over plain values so it can be pinned by
 * tests without rendering React.
 */

/** New projects default to the documented 32-bar arrangement. */
export const DEFAULT_TIMELINE_BARS = 32;

/** Lower bound of the arranger's -8 control. */
export const MIN_TIMELINE_BARS = 8;
/**
 * Phase 1G — the single capacity authority for the playlist timeline (512 bars).
 * Every timeline length is resolved through `normalizeTimelineBars`, which clamps
 * to this value; no other module may declare or hard-code a timeline cap.
 */
export const MAX_TIMELINE_BARS = 512;

export interface TimelineClipBounds {
  totalBars?: number;
  maxTracks?: number;
}

/**
 * Resolve a stored timeline length to a usable one.
 *
 * A missing, non-numeric or non-positive value falls back to the default rather
 * than to the minimum: reading `0` as "shrink to 8 bars" would silently strand
 * (and then clamp away) the clips of a project whose length failed to load.
 * Values outside the supported range are clamped to the nearest legal length.
 */
export const normalizeTimelineBars = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_TIMELINE_BARS;
  return Math.min(MAX_TIMELINE_BARS, Math.max(MIN_TIMELINE_BARS, Math.round(numeric)));
};

/** The authoritative timeline length of a project document. */
export const getProjectTimelineBars = (state: Pick<ProjectState, 'totalBars'>): number =>
  normalizeTimelineBars(state.totalBars);

/**
 * Latest legal start bar for a clip of `lengthBars` on the timeline.
 *
 * This is the same rule `snapClipStart` / `resolveAudioDropStartBar` apply to
 * drops, moves and resizes; the grid-click producer is the one path that was
 * missing it.
 */
export const clampStartBarToTimeline = (
  requestedStartBar: number,
  lengthBars: number,
  bounds: TimelineClipBounds
): number => {
  const totalBars = normalizeTimelineBars(bounds.totalBars);
  const safeLength = Number.isFinite(lengthBars) && lengthBars > 0 ? lengthBars : 0;
  const maxStart = Math.max(0, totalBars - safeLength);
  const requested = Number.isFinite(requestedStartBar) ? requestedStartBar : 0;
  return Math.min(Math.max(0, requested), maxStart);
};

/**
 * Pull a single clip back inside the timeline.
 *
 * The clip's musical length is preserved where it fits; only a clip longer than
 * the entire timeline is shortened. Clips are moved rather than deleted so a
 * timeline change never destroys arrangement content silently, and so
 * re-expanding the timeline leaves them at a stable, valid position.
 *
 * Malformed clips (non-finite or non-positive geometry) are returned untouched —
 * repairing them is the validator's job, not this module's.
 */
export const clampClipToTimeline = <T extends PlaylistClip>(clip: T, totalBars: number): T => {
  const safeTotal = normalizeTimelineBars(totalBars);
  if (!Number.isFinite(clip.startBar) || !Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0) {
    return clip;
  }

  const lengthBars = Math.min(clip.lengthBars, safeTotal);
  const startBar = clampStartBarToTimeline(clip.startBar, lengthBars, { totalBars: safeTotal });

  if (lengthBars === clip.lengthBars && startBar === clip.startBar) return clip;
  return { ...clip, startBar, lengthBars };
};

/**
 * Clamp a whole playlist. Returns the original array when every clip already
 * fits, so referential-equality checks elsewhere (runtime synchronization) do
 * not see a spurious change.
 */
export const clampClipsToTimeline = <T extends PlaylistClip>(
  clips: readonly T[],
  totalBars: number
): T[] => {
  let changed = false;
  const next = clips.map(clip => {
    const clamped = clampClipToTimeline(clip, totalBars);
    if (clamped !== clip) changed = true;
    return clamped;
  });
  return changed ? next : (clips as T[]);
};

/**
 * Apply a requested timeline length to a project, revalidating the arrangement.
 *
 * Returning the same object when nothing changes keeps history's semantic
 * comparison and React's identity checks from recording a no-op edit.
 */
export const setTimelineBarsInProjectState = (state: ProjectState, requestedBars: number): ProjectState => {
  const totalBars = normalizeTimelineBars(requestedBars);
  const playlistClips = clampClipsToTimeline(state.playlistClips, totalBars);
  if (state.totalBars === totalBars && playlistClips === state.playlistClips) return state;
  return { ...state, totalBars, playlistClips };
};

/**
 * Revalidate a loaded document against its own declared timeline length.
 *
 * Called from `normalizeProjectState`, which is the single funnel every loaded,
 * recovered, replaced and restored project passes through, so a project saved
 * by an older build (or one whose clips overhang for any reason) can never
 * reach the arranger or the renderer in an invalid state.
 */
export const revalidateProjectTimeline = (state: ProjectState): ProjectState => {
  const totalBars = normalizeTimelineBars(state.totalBars);
  const playlistClips = clampClipsToTimeline(state.playlistClips, totalBars);
  if (state.totalBars === totalBars && playlistClips === state.playlistClips) return state;
  return { ...state, totalBars, playlistClips };
};
