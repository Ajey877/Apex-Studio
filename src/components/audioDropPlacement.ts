import { snapBarPosition } from './playlistClipOperations';

export interface AudioDropPlacementBounds {
  totalBars: number;
  gridBars?: number;
}

/**
 * Resolve the initial timeline position for an imported audio clip.
 * The imported clip must fit completely inside the usable arrangement.
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
  return snapBarPosition(Math.min(requestedStart, maxStart), gridBars);
}
