import { snapBarPosition } from './playlistClipOperations';

export interface AudioDropPlacementBounds {
  totalBars: number;
  gridBars?: number;
}

/**
 * Resolve the initial timeline position for a newly imported audio clip.
 *
 * The playlist historically placed dropped audio at the transport playhead.
 * That is valid only when the whole clip still fits inside the visible
 * arrangement. Clamp the playhead-derived position to the latest valid start
 * so imported audio can never be created beyond the arrangement boundary.
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
