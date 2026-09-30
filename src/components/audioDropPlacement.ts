import { snapBarPosition } from './playlistClipOperations';

export interface AudioDropPlacementBounds {
  totalBars: number;
  gridBars?: number;
}

export const DEFAULT_BAR_WIDTH_PX = 96;

/**
 * Convert client drop coordinates into a timeline bar position.
 * Uses the arrangement's horizontal pixel width per bar.
 */
export function resolveTimelineBarFromClientX(
  clientX: number,
  trackLeftPx: number,
  barWidthPx: number = DEFAULT_BAR_WIDTH_PX
): number {
  if (!Number.isFinite(barWidthPx) || barWidthPx <= 0) {
    throw new Error('barWidthPx must be finite and greater than zero');
  }
  return (clientX - trackLeftPx) / barWidthPx;
}

/**
 * Resolve the timeline startBar for a dropped audio clip from a requested bar position.
 * Snaps to the arrangement grid (default 0.25 bars) and clamps within legal bounds
 * [0, totalBars - lengthBars]. If snapping would push the clip past maxStart,
 * floor-snaps down to keep it fully within the arrangement.
 */
export function resolveAudioDropStartBar(
  requestedStartBar: number,
  lengthBars: number,
  { totalBars, gridBars = 0.25 }: AudioDropPlacementBounds
): number {
  if (!Number.isFinite(totalBars) || totalBars <= 0) {
    throw new Error('totalBars must be finite and greater than zero');
  }
  if (!Number.isFinite(lengthBars) || lengthBars <= 0) {
    throw new Error('lengthBars must be finite and greater than zero');
  }

  const requestedStart = Math.max(0, Number.isFinite(requestedStartBar) ? requestedStartBar : 0);
  const maxStart = Math.max(0, totalBars - lengthBars);
  const boundedStart = Math.min(requestedStart, maxStart);
  const snappedStart = snapBarPosition(boundedStart, gridBars);

  if (snappedStart <= maxStart) return snappedStart;

  return Math.max(0, Math.floor((maxStart / gridBars) + 1e-9) * gridBars);
}

/**
 * Resolve the initial timeline startBar for an imported audio clip directly from
 * drop event coordinates (e.clientX) and track lane bounds.
 */
export function resolveAudioDropStartBarFromClientX(
  clientX: number,
  trackLeftPx: number,
  lengthBars: number,
  bounds: AudioDropPlacementBounds,
  barWidthPx: number = DEFAULT_BAR_WIDTH_PX
): number {
  const requestedBar = resolveTimelineBarFromClientX(clientX, trackLeftPx, barWidthPx);
  return resolveAudioDropStartBar(requestedBar, lengthBars, bounds);
}

/**
 * Backwards-compatible resolver for playhead-derived start position.
 * Treats currentBar as 1-based (playhead bar 1 -> bar 0).
 */
export function resolveInitialAudioDropStartBar(
  currentBar: number,
  lengthBars: number,
  bounds: AudioDropPlacementBounds
): number {
  const requestedStart = Math.max(0, Number.isFinite(currentBar) ? currentBar - 1 : 0);
  return resolveAudioDropStartBar(requestedStart, lengthBars, bounds);
}
