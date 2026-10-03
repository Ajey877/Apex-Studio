import { snapBarPosition } from './playlistClipOperations';

export interface AudioDropPlacementBounds {
  totalBars: number;
  gridBars?: number;
  maxTracks?: number;
}

export type PlaylistPlacementBounds = AudioDropPlacementBounds;

export const DEFAULT_BAR_WIDTH_PX = 96;
export const DEFAULT_TRACK_HEIGHT_PX = 64;

export interface PlaylistCoordinateContext {
  /** Viewport-relative left edge of the playlist container or track element. */
  viewportLeft?: number;
  /** Horizontal scroll offset in pixels. */
  scrollLeft?: number;
  /** Viewport-relative top edge of the playlist container or track element. */
  viewportTop?: number;
  /** Vertical scroll offset in pixels. */
  scrollTop?: number;
  /** Direct element bounding client rect left (convenience if element.getBoundingClientRect() is passed). */
  trackLeft?: number;
  /** Direct element bounding client rect top (convenience if element.getBoundingClientRect() is passed). */
  trackTop?: number;
  /** Pixels per bar (default: 96). */
  barWidth?: number;
  /** Pixels per track row (default: 64). */
  trackHeight?: number;
  /** Timeline horizontal/vertical zoom or scale factor (default: 1). */
  zoom?: number;
}

export interface PlaylistDropPlacementResult {
  contentX: number;
  contentY: number;
  rawBar: number;
  startBar: number;
  trackIndex: number;
}

/**
 * Convert client mouse/drop coordinates into playlist content coordinates,
 * taking into account horizontal/vertical scrolling, viewport offsets,
 * track-row offsets, and timeline zoom/scale.
 */
export function clientToPlaylistContentCoordinates(
  clientX: number,
  clientY: number,
  context: PlaylistCoordinateContext = {}
): { contentX: number; contentY: number } {
  const zoom = context.zoom ?? 1;
  if (!Number.isFinite(zoom) || zoom <= 0) {
    throw new Error('zoom must be finite and greater than zero');
  }

  // Uses the playlist timeline's horizontal coordinate system:
  // (clientX - timelineOriginX) / zoom + scrollLeft
  // If trackLeft is provided without viewportLeft, trackLeft is used as the origin.
  const originX = context.viewportLeft ?? context.trackLeft ?? 0;
  const scrollX = context.scrollLeft ?? 0;
  const contentX = (clientX - originX) / zoom + scrollX;

  const originY = context.viewportTop ?? context.trackTop ?? 0;
  const scrollY = context.scrollTop ?? 0;
  const contentY = (clientY - originY) / zoom + scrollY;

  return { contentX, contentY };
}

/**
 * Convert playlist content X coordinate into fractional timeline bar position.
 */
export function contentXToTimelineBar(
  contentX: number,
  barWidth: number = DEFAULT_BAR_WIDTH_PX
): number {
  if (!Number.isFinite(barWidth) || barWidth <= 0) {
    throw new Error('barWidth must be finite and greater than zero');
  }
  return contentX / barWidth;
}

/**
 * Convert client drop coordinates into a timeline bar position.
 * Uses the arrangement's horizontal pixel width per bar.
 */
export function resolveTimelineBarFromClientX(
  clientX: number,
  trackLeftPx: number,
  barWidthPx: number = DEFAULT_BAR_WIDTH_PX
): number {
  const { contentX } = clientToPlaylistContentCoordinates(clientX, 0, {
    trackLeft: trackLeftPx,
    barWidth: barWidthPx,
  });
  return contentXToTimelineBar(contentX, barWidthPx);
}

/**
 * Resolve the timeline startBar for an audio clip from a requested bar position.
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
 * Complete unified placement calculation for playlist drops:
 * clientX/clientY -> playlist content coordinates -> timeline position ->
 * grid-snapped bar -> boundary-clamped startBar and trackIndex.
 */
export function resolvePlaylistDropPlacement(
  clientX: number,
  clientY: number,
  lengthBars: number,
  context: PlaylistCoordinateContext,
  bounds: PlaylistPlacementBounds
): PlaylistDropPlacementResult {
  const { contentX, contentY } = clientToPlaylistContentCoordinates(clientX, clientY, context);
  const barWidth = context.barWidth ?? DEFAULT_BAR_WIDTH_PX;
  const trackHeight = context.trackHeight ?? DEFAULT_TRACK_HEIGHT_PX;
  const rawBar = contentXToTimelineBar(contentX, barWidth);
  const startBar = resolveAudioDropStartBar(rawBar, lengthBars, bounds);
  const rawTrack = Math.floor(contentY / trackHeight);
  let trackIndex = Math.max(0, Number.isFinite(rawTrack) ? rawTrack : 0);
  if (bounds.maxTracks !== undefined && bounds.maxTracks > 0) {
    trackIndex = Math.min(trackIndex, bounds.maxTracks - 1);
  }

  return {
    contentX,
    contentY,
    rawBar,
    startBar,
    trackIndex,
  };
}

/**
 * Shared coordinate helper for moving existing playlist clips:
 * calculates delta in content coordinates, applies grid snapping, and clamps
 * within timeline and track boundaries.
 */
export function resolvePlaylistClipMove(
  clip: { startBar: number; trackIndex: number; lengthBars: number },
  originX: number,
  originY: number,
  clientX: number,
  clientY: number,
  context: PlaylistCoordinateContext = {},
  bounds: PlaylistPlacementBounds
): { startBar: number; trackIndex: number } {
  const zoom = context.zoom ?? 1;
  const barWidth = context.barWidth ?? DEFAULT_BAR_WIDTH_PX;
  const trackHeight = context.trackHeight ?? DEFAULT_TRACK_HEIGHT_PX;

  const deltaContentX = (clientX - originX) / zoom;
  const deltaBars = deltaContentX / barWidth;
  const requestedStart = clip.startBar + deltaBars;
  const startBar = resolveAudioDropStartBar(requestedStart, clip.lengthBars, bounds);

  const deltaContentY = (clientY - originY) / zoom;
  const deltaTracks = Math.round(deltaContentY / trackHeight);
  let trackIndex = Math.max(0, clip.trackIndex + deltaTracks);
  if (bounds.maxTracks !== undefined && bounds.maxTracks > 0) {
    trackIndex = Math.min(trackIndex, bounds.maxTracks - 1);
  }

  return { startBar, trackIndex };
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
  const { startBar } = resolvePlaylistDropPlacement(
    clientX,
    0,
    lengthBars,
    { trackLeft: trackLeftPx, barWidth: barWidthPx },
    bounds
  );
  return startBar;
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
