import { snapBarPosition } from './playlistClipOperations';

export interface AudioDropPlacementBounds {
  totalBars: number;
  gridBars?: number;
}

/**
 * Resolve the initial timeline position for an imported audio clip.
 * The imported clip must fit completely inside the usable arrangement.
 *
 * The legal upper bound is applied after snapping as well. When the final
 * legal start falls between grid points, snap downward so the clip remains
 * both grid-aligned and fully inside the arrangement.
 */
export function resolveInitialAudioDropStartBar(
  currentBar: number,
  lengthBars: number,
  { totalBars, gridBars = 0.25 }: AudioDropPlacementBounds
): number {
  if (!Number.isFinite(totalBars) || totalBars <= 0) {
    throw new Error('totalBars must be finite and greater than zero');
  }
  if (!Number.isFinite(lengthBars) || lengthBars <= 0) {
    throw new Error('lengthBars must be finite and greater than zero');
  }

  const requestedStart = Math.max(0, Number.isFinite(currentBar) ? currentBar - 1 : 0);
  const maxStart = Math.max(0, totalBars - lengthBars);
  const boundedStart = Math.min(requestedStart, maxStart);
  const snappedStart = snapBarPosition(boundedStart, gridBars);

  if (snappedStart <= maxStart) return snappedStart;

  return Math.max(0, Math.floor((maxStart / gridBars) + 1e-9) * gridBars);
}
