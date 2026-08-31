import type { PlaylistClip } from '../types/daw';

export const STEPS_PER_BAR = 16;
export const DEFAULT_GRID_BARS = 0.25;

export interface PlaylistBounds {
  totalBars?: number;
  maxTracks?: number;
}

export interface ClipValidationResult {
  valid: boolean;
  errors: string[];
}

const finite = (value: number): boolean => Number.isFinite(value);

const cloneClip = (clip: PlaylistClip): PlaylistClip => ({
  ...clip,
  automationPoints: clip.automationPoints?.map(point => ({ ...point })),
  spatialAudio: clip.spatialAudio ? { ...clip.spatialAudio } : undefined
});

export function validatePlaylistClip(clip: PlaylistClip, bounds: PlaylistBounds = {}): ClipValidationResult {
  const errors: string[] = [];

  if (!clip.id) errors.push('Clip id is required');
  if (!Number.isInteger(clip.trackIndex) || clip.trackIndex < 0) errors.push('trackIndex must be a non-negative integer');
  if (bounds.maxTracks !== undefined && clip.trackIndex >= bounds.maxTracks) errors.push('trackIndex exceeds playlist track count');
  if (!finite(clip.startBar) || clip.startBar < 0) errors.push('startBar must be finite and non-negative');
  if (!finite(clip.lengthBars) || clip.lengthBars <= 0) errors.push('lengthBars must be finite and greater than zero');
  if (bounds.totalBars !== undefined && clip.startBar + clip.lengthBars > bounds.totalBars) errors.push('clip exceeds playlist timeline bounds');
  if (clip.offsetSteps !== undefined && (!finite(clip.offsetSteps) || clip.offsetSteps < 0)) errors.push('offsetSteps must be finite and non-negative');
  if (clip.fadeInBars !== undefined && (!finite(clip.fadeInBars) || clip.fadeInBars < 0)) errors.push('fadeInBars must be non-negative');
  if (clip.fadeOutBars !== undefined && (!finite(clip.fadeOutBars) || clip.fadeOutBars < 0)) errors.push('fadeOutBars must be non-negative');
  if (clip.fadeInBars !== undefined && clip.fadeInBars > clip.lengthBars / 2) errors.push('fadeInBars exceeds half the clip length');
  if (clip.fadeOutBars !== undefined && clip.fadeOutBars > clip.lengthBars / 2) errors.push('fadeOutBars exceeds half the clip length');

  return { valid: errors.length === 0, errors };
}

export function assertValidPlaylistClip(clip: PlaylistClip, bounds: PlaylistBounds = {}): PlaylistClip {
  const result = validatePlaylistClip(clip, bounds);
  if (!result.valid) throw new Error(`Invalid playlist clip: ${result.errors.join('; ')}`);
  return clip;
}

export function snapBarPosition(value: number, gridBars: number = DEFAULT_GRID_BARS): number {
  if (!finite(value)) throw new Error('Timeline position must be finite');
  if (!finite(gridBars) || gridBars <= 0) throw new Error('Grid size must be greater than zero');
  return Math.max(0, Number((Math.round(value / gridBars) * gridBars).toFixed(6)));
}

export function snapClipStart(clip: PlaylistClip, requestedStartBar: number, gridBars = DEFAULT_GRID_BARS, bounds: PlaylistBounds = {}): PlaylistClip {
  const startBar = snapBarPosition(requestedStartBar, gridBars);
  const maxStart = bounds.totalBars === undefined ? Number.POSITIVE_INFINITY : Math.max(0, bounds.totalBars - clip.lengthBars);
  return assertValidPlaylistClip({ ...cloneClip(clip), startBar: Math.min(startBar, maxStart) }, bounds);
}

export function movePlaylistClip(
  clip: PlaylistClip,
  requestedStartBar: number,
  targetTrackIndex = clip.trackIndex,
  gridBars = DEFAULT_GRID_BARS,
  bounds: PlaylistBounds = {}
): PlaylistClip {
  if (!Number.isInteger(targetTrackIndex) || targetTrackIndex < 0) throw new Error('targetTrackIndex must be a non-negative integer');
  const moved = snapClipStart({ ...clip, trackIndex: targetTrackIndex }, requestedStartBar, gridBars, bounds);
  return assertValidPlaylistClip(moved, bounds);
}

export function resizePlaylistClipLeft(
  clip: PlaylistClip,
  requestedStartBar: number,
  gridBars = DEFAULT_GRID_BARS,
  minimumLengthBars = gridBars,
  bounds: PlaylistBounds = {}
): PlaylistClip {
  if (!finite(minimumLengthBars) || minimumLengthBars <= 0) throw new Error('minimumLengthBars must be greater than zero');
  const startBar = snapBarPosition(requestedStartBar, gridBars);
  const originalEnd = clip.startBar + clip.lengthBars;
  const maxStart = originalEnd - minimumLengthBars;
  const nextStart = Math.min(startBar, maxStart);
  const nextLength = originalEnd - nextStart;
  const deltaBars = nextStart - clip.startBar;

  const resized: PlaylistClip = {
    ...cloneClip(clip),
    startBar: nextStart,
    lengthBars: nextLength,
    offsetSteps: (clip.offsetSteps ?? 0) + Math.max(0, deltaBars * STEPS_PER_BAR)
  };

  return assertValidPlaylistClip(resized, bounds);
}

export function resizePlaylistClipRight(
  clip: PlaylistClip,
  requestedEndBar: number,
  gridBars = DEFAULT_GRID_BARS,
  minimumLengthBars = gridBars,
  bounds: PlaylistBounds = {}
): PlaylistClip {
  if (!finite(minimumLengthBars) || minimumLengthBars <= 0) throw new Error('minimumLengthBars must be greater than zero');
  const endBar = snapBarPosition(requestedEndBar, gridBars);
  const minimumEnd = clip.startBar + minimumLengthBars;
  const maxEnd = bounds.totalBars === undefined ? Number.POSITIVE_INFINITY : bounds.totalBars;
  const nextEnd = Math.max(minimumEnd, Math.min(endBar, maxEnd));

  const resized: PlaylistClip = {
    ...cloneClip(clip),
    lengthBars: nextEnd - clip.startBar
  };

  return assertValidPlaylistClip(resized, bounds);
}

export function splitPlaylistClip(
  clip: PlaylistClip,
  requestedSplitBar: number,
  gridBars = DEFAULT_GRID_BARS,
  bounds: PlaylistBounds = {}
): [PlaylistClip, PlaylistClip] {
  const splitBar = snapBarPosition(requestedSplitBar, gridBars);
  const clipEnd = clip.startBar + clip.lengthBars;
  if (splitBar <= clip.startBar || splitBar >= clipEnd) throw new Error('Split position must be inside the clip');

  const leftLength = splitBar - clip.startBar;
  const rightLength = clipEnd - splitBar;
  const sourceOffset = clip.offsetSteps ?? 0;
  const stamp = Date.now();

  const left: PlaylistClip = {
    ...cloneClip(clip),
    id: `${clip.id}-L-${stamp}`,
    lengthBars: leftLength,
    fadeOutBars: clip.fadeOutBars === undefined ? undefined : Math.min(clip.fadeOutBars, leftLength / 2)
  };
  const right: PlaylistClip = {
    ...cloneClip(clip),
    id: `${clip.id}-R-${stamp}`,
    startBar: splitBar,
    lengthBars: rightLength,
    offsetSteps: sourceOffset + leftLength * STEPS_PER_BAR,
    fadeInBars: clip.fadeInBars === undefined ? undefined : Math.min(clip.fadeInBars, rightLength / 2),
    fadeOutBars: clip.fadeOutBars === undefined ? undefined : Math.min(clip.fadeOutBars, rightLength / 2)
  };

  return [assertValidPlaylistClip(left, bounds), assertValidPlaylistClip(right, bounds)];
}

export function duplicatePlaylistClip(
  clip: PlaylistClip,
  id: string,
  startBar = clip.startBar,
  trackIndex = clip.trackIndex,
  gridBars = DEFAULT_GRID_BARS,
  bounds: PlaylistBounds = {}
): PlaylistClip {
  if (!id) throw new Error('Duplicate clip id is required');
  return movePlaylistClip({ ...cloneClip(clip), id }, startBar, trackIndex, gridBars, bounds);
}

export function deletePlaylistClip(clips: PlaylistClip[], clipId: string): PlaylistClip[] {
  return clips.filter(clip => clip.id !== clipId);
}

export function replacePlaylistClip(clips: PlaylistClip[], updatedClip: PlaylistClip, bounds: PlaylistBounds = {}): PlaylistClip[] {
  assertValidPlaylistClip(updatedClip, bounds);
  if (!clips.some(clip => clip.id === updatedClip.id)) throw new Error(`Clip not found: ${updatedClip.id}`);
  return clips.map(clip => clip.id === updatedClip.id ? cloneClip(updatedClip) : clip);
}
