import type { Channel, PlaylistClip, PlaylistTrack, AutomationPoint, AutomationTargetType } from '../types/daw';

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

/**
 * Two normalized X values closer than this are treated as the same envelope
 * position. It matches the six-decimal quantization the interactive point
 * operations (add / move) apply to X.
 */
const AUTOMATION_X_EPSILON = 1e-6;

const cloneClip = (clip: PlaylistClip): PlaylistClip => ({
  ...clip,
  // Deep-copy nested objects so duplicates / split halves never share state
  // with their source clip (a shared automationTarget would let a rebind on
  // one clip leak into the other).
  automationTarget: clip.automationTarget ? { ...clip.automationTarget } : undefined,
  automationPoints: clip.automationPoints?.map(point => ({ ...point })),
  spatialAudio: clip.spatialAudio ? { ...clip.spatialAudio } : undefined
});

// Split remapping keeps full float precision on purpose: quantizing remapped X
// would move points off their original bar positions. Clamping only guards
// against float noise at the [0, 1] edges.
const clampUnit = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * Pure evaluator for a normalized automation envelope.
 *
 * This deliberately mirrors audioEngine.interpolateAutomationCurve so that
 * editing operations (split remapping in particular) sample the envelope
 * exactly the way Song Mode playback does: tension lives on the point that
 * opens a segment (positive = ease-in / exponential, negative = ease-out /
 * logarithmic), and the first / last values are held outside the outermost
 * points. Keep the two in sync; the automation test-suite cross-checks them.
 */
export function evaluateAutomationEnvelope(points: AutomationPoint[], relX: number): number {
  if (!Array.isArray(points) || points.length === 0) return 0.5;
  if (points.length === 1) return points[0].y;

  const sorted = [...points].sort((a, b) => a.x - b.x);
  if (relX <= sorted[0].x) return sorted[0].y;
  if (relX >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;

  for (let i = 0; i < sorted.length - 1; i++) {
    const p1 = sorted[i];
    const p2 = sorted[i + 1];
    if (relX >= p1.x && relX <= p2.x) {
      const segT = (relX - p1.x) / (p2.x - p1.x);
      const tension = p1.tension || 0;
      let curvedT = segT;
      if (tension > 0) {
        curvedT = Math.pow(segT, 1 + tension * 2);
      } else if (tension < 0) {
        curvedT = 1 - Math.pow(1 - segT, 1 + Math.abs(tension) * 2);
      }
      return p1.y + (p2.y - p1.y) * curvedT;
    }
  }
  return 0.5;
}

/**
 * Cuts a normalized automation envelope at xSplit (strictly inside (0, 1))
 * into two envelopes that are each remapped back onto [0, 1]:
 *
 * - the left half keeps the points in [0, xSplit] (x' = x / xSplit) and ends
 *   at x = 1 with the envelope value at the split;
 * - the right half keeps the points in [xSplit, 1]
 *   (x' = (x - xSplit) / (1 - xSplit)) and begins at x = 0 with that same
 *   value, so the seam is continuous during playback;
 * - a point sitting exactly at xSplit becomes the shared boundary of both
 *   halves instead of being duplicated next to a synthesized one;
 * - point order, tension and any extra per-point data are preserved. When
 *   the split lands inside a segment, the segment's tension (which lives on
 *   its opening point) is carried onto the right half's opening point so the
 *   curve keeps its character on both sides of the seam.
 *
 * Halves that would otherwise lack an outer endpoint get one that holds the
 * neighbouring value, which is exactly what playback does past the outermost
 * points, so the audible envelope is unchanged.
 */
export function splitAutomationPoints(
  points: AutomationPoint[],
  xSplit: number
): { left: AutomationPoint[]; right: AutomationPoint[] } {
  if (!finite(xSplit) || xSplit <= AUTOMATION_X_EPSILON || xSplit >= 1 - AUTOMATION_X_EPSILON) {
    throw new Error('Automation split position must be strictly inside the envelope');
  }
  if (!Array.isArray(points) || points.length < 2) {
    // An empty or single-point envelope is a constant: playback returns the
    // same value everywhere, so both halves simply keep it.
    const copy = Array.isArray(points) ? points.map(point => ({ ...point })) : [];
    return { left: copy, right: copy.map(point => ({ ...point })) };
  }

  const sorted = points.map(point => ({ ...point })).sort((a, b) => a.x - b.x);
  const boundaryIndex = sorted.findIndex(point => Math.abs(point.x - xSplit) < AUTOMATION_X_EPSILON);

  let leftBoundary: AutomationPoint;
  let rightBoundary: AutomationPoint;
  if (boundaryIndex !== -1) {
    // Shared boundary: the existing point closes the left half and opens the
    // right half, keeping its value and its tension on both sides.
    leftBoundary = { ...sorted[boundaryIndex], x: 1 };
    rightBoundary = { ...sorted[boundaryIndex], x: 0 };
  } else {
    const splitValue = clampUnit(evaluateAutomationEnvelope(sorted, xSplit));
    let openingIndex = -1;
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].x < xSplit) openingIndex = i;
    }
    const cutsSegment = openingIndex !== -1 && openingIndex < sorted.length - 1;
    const inheritedTension = cutsSegment ? (sorted[openingIndex].tension ?? 0) : 0;
    leftBoundary = { x: 1, y: splitValue, tension: 0 };
    rightBoundary = { x: 0, y: splitValue, tension: inheritedTension };
  }

  const left: AutomationPoint[] = sorted
    .filter(point => point.x < xSplit - AUTOMATION_X_EPSILON)
    .map(point => ({ ...point, x: clampUnit(point.x / xSplit) }));
  left.push(leftBoundary);

  const right: AutomationPoint[] = [
    rightBoundary,
    ...sorted
      .filter(point => point.x > xSplit + AUTOMATION_X_EPSILON)
      .map(point => ({ ...point, x: clampUnit((point.x - xSplit) / (1 - xSplit)) }))
  ];

  if (left[0].x > 0) left.unshift({ x: 0, y: left[0].y, tension: 0 });
  if (right[right.length - 1].x < 1) right.push({ x: 1, y: right[right.length - 1].y, tension: 0 });

  return { left, right };
}

export function validatePlaylistClip(clip: PlaylistClip, bounds: PlaylistBounds = {}): ClipValidationResult {
  const errors: string[] = [];

  if (!clip.id) errors.push('Clip id is required');
  if (!Number.isInteger(clip.trackIndex) || clip.trackIndex < 0) errors.push('trackIndex must be a non-negative integer');
  if (bounds.maxTracks !== undefined && (!Number.isInteger(bounds.maxTracks) || bounds.maxTracks <= 0)) errors.push('maxTracks must be a positive integer');
  if (bounds.maxTracks !== undefined && Number.isInteger(clip.trackIndex) && clip.trackIndex >= bounds.maxTracks) errors.push('trackIndex exceeds playlist track count');
  if (bounds.totalBars !== undefined && (!finite(bounds.totalBars) || bounds.totalBars <= 0)) errors.push('totalBars must be finite and greater than zero');
  if (!finite(clip.startBar) || clip.startBar < 0) errors.push('startBar must be finite and non-negative');
  if (!finite(clip.lengthBars) || clip.lengthBars <= 0) errors.push('lengthBars must be finite and greater than zero');
  if (bounds.totalBars !== undefined && finite(clip.startBar) && finite(clip.lengthBars) && clip.startBar + clip.lengthBars > bounds.totalBars) errors.push('clip exceeds playlist timeline bounds');
  if (clip.offsetSteps !== undefined && (!finite(clip.offsetSteps) || clip.offsetSteps < 0)) errors.push('offsetSteps must be finite and non-negative');
  if (clip.fadeInBars !== undefined && (!finite(clip.fadeInBars) || clip.fadeInBars < 0)) errors.push('fadeInBars must be non-negative');
  if (clip.fadeOutBars !== undefined && (!finite(clip.fadeOutBars) || clip.fadeOutBars < 0)) errors.push('fadeOutBars must be non-negative');
  if (finite(clip.lengthBars) && clip.lengthBars > 0) {
    if (clip.fadeInBars !== undefined && clip.fadeInBars > clip.lengthBars / 2) errors.push('fadeInBars exceeds half the clip length');
    if (clip.fadeOutBars !== undefined && clip.fadeOutBars > clip.lengthBars / 2) errors.push('fadeOutBars exceeds half the clip length');
  }

  if (clip.type === 'automation' && clip.automationPoints) {
    for (let i = 0; i < clip.automationPoints.length; i++) {
      const pt = clip.automationPoints[i];
      if (!finite(pt.x) || pt.x < 0 || pt.x > 1) {
        errors.push(`Automation point ${i} x must be finite and between 0 and 1`);
      }
      if (!finite(pt.y) || pt.y < 0 || pt.y > 1) {
        errors.push(`Automation point ${i} y must be finite and between 0 and 1`);
      }
    }
  }

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
  // Automation clips are normalized envelopes: their points stretch and
  // compress with the clip (relative X) and there is no hidden source
  // material before the clip start. offsetSteps therefore grants no
  // left-extension credit and never limits it; it is normalized to 0 so a
  // stale value (e.g. from an older split) cannot pretend otherwise.
  // Pattern / audio clips keep the source-preserving rule: extending left may
  // only reveal material that exists before the current offset.
  const isAutomation = clip.type === 'automation';
  const sourceOffset = isAutomation ? 0 : (clip.offsetSteps ?? 0);
  const maxExtensionLeft = sourceOffset / STEPS_PER_BAR;
  const minSourcePreservingStart = isAutomation ? 0 : Math.max(0, clip.startBar - maxExtensionLeft);
  const nextStart = Math.max(minSourcePreservingStart, Math.min(startBar, maxStart));
  const nextLength = originalEnd - nextStart;
  const deltaBars = nextStart - clip.startBar;

  const resized: PlaylistClip = {
    ...cloneClip(clip),
    startBar: nextStart,
    lengthBars: nextLength,
    offsetSteps: isAutomation ? 0 : Math.max(0, sourceOffset + deltaBars * STEPS_PER_BAR),
    fadeInBars: clip.fadeInBars === undefined ? undefined : Math.min(clip.fadeInBars, nextLength / 2),
    fadeOutBars: clip.fadeOutBars === undefined ? undefined : Math.min(clip.fadeOutBars, nextLength / 2)
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
  const maxEnd = bounds.totalBars === undefined ? Number.POSITIVE_INFINITY : bounds.totalBars;
  if (maxEnd < clip.startBar) throw new Error('Clip start exceeds playlist timeline bounds');
  const minimumEnd = Math.min(maxEnd, clip.startBar + minimumLengthBars);
  const nextEnd = Math.max(minimumEnd, Math.min(endBar, maxEnd));

  const resized: PlaylistClip = {
    ...cloneClip(clip),
    lengthBars: nextEnd - clip.startBar,
    fadeInBars: clip.fadeInBars === undefined ? undefined : Math.min(clip.fadeInBars, (nextEnd - clip.startBar) / 2),
    fadeOutBars: clip.fadeOutBars === undefined ? undefined : Math.min(clip.fadeOutBars, (nextEnd - clip.startBar) / 2)
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
    fadeInBars: clip.fadeInBars === undefined ? undefined : Math.min(clip.fadeInBars, rightLength / 2),
    fadeOutBars: clip.fadeOutBars === undefined ? undefined : Math.min(clip.fadeOutBars, rightLength / 2)
  };

  if (clip.type === 'automation') {
    // An automation clip has no source material to offset into: playback
    // evaluates its envelope purely by relative position inside the clip. So
    // instead of advancing offsetSteps, the envelope itself is cut at the
    // split position and each half is remapped onto its own [0, 1] range,
    // keeping every point at its original bar position and both halves
    // meeting at the exact envelope value of the split bar.
    if (clip.automationPoints) {
      const xSplit = leftLength / clip.lengthBars;
      const halves = splitAutomationPoints(clip.automationPoints, xSplit);
      left.automationPoints = halves.left;
      right.automationPoints = halves.right;
    }
  } else {
    right.offsetSteps = sourceOffset + leftLength * STEPS_PER_BAR;
  }

  return [assertValidPlaylistClip(left, bounds), assertValidPlaylistClip(right, bounds)];
}

/**
 * Bar position under a pointer inside a rendered clip. Clips are laid out at
 * startBar * barWidthPx from the row origin, so the bar is the clip's start
 * plus the pointer's offset from the clip's left edge, in bars. Used by the
 * Slice tool: clips render above the grid cells, so a click on a clip never
 * reaches the grid-cell handler and the bar must be derived from the clip's
 * own geometry. Pure arithmetic - non-finite input yields a non-finite bar,
 * which the split path rejects like any other invalid split position.
 */
export function resolveClipClickBar(clip: PlaylistClip, clientX: number, clipLeftPx: number, barWidthPx: number): number {
  return clip.startBar + (clientX - clipLeftPx) / barWidthPx;
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

export function updatePlaylistAutomationPoint(
  clip: PlaylistClip,
  pointIndex: number,
  newY: number
): PlaylistClip {
  if (clip.type !== 'automation' || !clip.automationPoints) {
    throw new Error('Automation point updates require an automation clip with points');
  }
  if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= clip.automationPoints.length) {
    throw new Error('Automation point index is out of range');
  }
  if (!finite(newY)) throw new Error('Automation point value must be finite');

  const updated = cloneClip(clip);
  updated.automationPoints![pointIndex] = {
    ...updated.automationPoints![pointIndex],
    y: Math.max(0, Math.min(1, newY))
  };
  return assertValidPlaylistClip(updated);
}

export function addPlaylistAutomationPoint(
  clip: PlaylistClip,
  normX: number,
  normY: number
): { clip: PlaylistClip; pointIndex: number } {
  if (clip.type !== 'automation') {
    throw new Error('Adding automation points requires an automation clip');
  }
  if (!finite(normX) || !finite(normY)) {
    throw new Error('Automation point coordinates must be finite');
  }

  const clampedX = Math.max(0, Math.min(1, Number(normX.toFixed(6))));
  const clampedY = Math.max(0, Math.min(1, Number(normY.toFixed(6))));
  const points = clip.automationPoints ? clip.automationPoints.map(p => ({ ...p })) : [];

  // If a point exists within 0.005 on normalized X, update its Y instead of stacking a duplicate
  const existingIdx = points.findIndex(p => Math.abs(p.x - clampedX) < 0.005);
  if (existingIdx !== -1) {
    // Never move the existing point onto an X that another point already
    // occupies, and never nudge a pinned endpoint off the clip edge; in those
    // cases only its Y follows the interaction.
    const isPinnedEndpoint = existingIdx === 0 || existingIdx === points.length - 1;
    const nextX = isPinnedEndpoint || points.some((p, i) => i !== existingIdx && Math.abs(p.x - clampedX) < 1e-9)
      ? points[existingIdx].x
      : clampedX;
    const mergedPoint = {
      ...points[existingIdx],
      x: nextX,
      y: clampedY
    };
    points[existingIdx] = mergedPoint;
    points.sort((a, b) => a.x - b.x);
    // Track the updated point by identity: a value lookup would misresolve
    // whenever the kept X (or Y) equals another point's.
    const pointIndex = points.indexOf(mergedPoint);
    const updated = cloneClip(clip);
    updated.automationPoints = points;
    return { clip: assertValidPlaylistClip(updated), pointIndex: Math.max(0, pointIndex) };
  }

  const newPoint: AutomationPoint = { x: clampedX, y: clampedY, tension: 0 };
  points.push(newPoint);
  points.sort((a, b) => a.x - b.x);

  const pointIndex = points.indexOf(newPoint);
  const updated = cloneClip(clip);
  updated.automationPoints = points;
  return { clip: assertValidPlaylistClip(updated), pointIndex: Math.max(0, pointIndex) };
}

export function movePlaylistAutomationPoint(
  clip: PlaylistClip,
  pointIndex: number,
  newX: number,
  newY: number,
  snapGridSteps?: number
): { clip: PlaylistClip; nextIndex: number } {
  if (clip.type !== 'automation' || !clip.automationPoints) {
    throw new Error('Automation point moves require an automation clip with points');
  }
  if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= clip.automationPoints.length) {
    throw new Error('Automation point index is out of range');
  }
  if (!finite(newX) || !finite(newY)) {
    throw new Error('Automation point coordinates must be finite');
  }

  const epsilon = 1e-9;
  const points = clip.automationPoints.map(p => ({ ...p }));
  const isOccupiedByOther = (x: number): boolean =>
    points.some((p, i) => i !== pointIndex && Math.abs(p.x - x) < epsilon);

  const targetY = Number(Math.max(0, Math.min(1, newY)).toFixed(6));

  // Endpoint pinning: the first point always anchors x = 0 and the last point
  // always anchors x = 1 so the envelope spans the whole clip (and split
  // halves keep meeting at their seam). Only their Y is editable; interior
  // points keep the snap / collision rules below.
  const pinnedX = pointIndex === 0 ? 0 : pointIndex === points.length - 1 ? 1 : null;

  // Resolve the target X so that two points can never share the same X:
  // coincident points create zero-width envelope segments, which evaluate as
  // an instantaneous value step during playback.
  let resolvedX: number | null;
  if (pinnedX !== null) {
    resolvedX = pinnedX;
  } else if (snapGridSteps !== undefined && finite(snapGridSteps) && snapGridSteps > 0) {
    const steps = Math.floor(snapGridSteps);
    const requestedStep = Math.round(Math.max(0, Math.min(1, newX)) * steps);
    resolvedX = null;
    // Clamp to the nearest free grid step. Equidistant candidates resolve to
    // the lower step so the outcome is deterministic.
    for (let radius = 0; radius <= steps + 1 && resolvedX === null; radius++) {
      const candidates = radius === 0 ? [requestedStep] : [requestedStep - radius, requestedStep + radius];
      for (const step of candidates) {
        if (step < 0 || step > steps) continue;
        const candidate = Number((step / steps).toFixed(6));
        if (!isOccupiedByOther(candidate)) {
          resolvedX = candidate;
          break;
        }
      }
    }
  } else {
    const clampedX = Math.max(0, Math.min(1, newX));
    resolvedX = isOccupiedByOther(clampedX) ? null : Number(clampedX.toFixed(6));
  }

  // If every candidate position is taken, the point keeps its previous X; the
  // Y update still applies. The previous X is collision-free by invariant.
  const targetX = resolvedX ?? points[pointIndex].x;

  const movingPoint = { ...points[pointIndex], x: targetX, y: targetY };
  points[pointIndex] = movingPoint;

  // Stable sort by x
  points.sort((a, b) => a.x - b.x);
  const nextIndex = points.indexOf(movingPoint);

  const updated = cloneClip(clip);
  updated.automationPoints = points;
  return { clip: assertValidPlaylistClip(updated), nextIndex: Math.max(0, nextIndex) };
}

export function deletePlaylistAutomationPoint(
  clip: PlaylistClip,
  pointIndex: number
): PlaylistClip {
  if (clip.type !== 'automation' || !clip.automationPoints) {
    throw new Error('Automation point deletion requires an automation clip with points');
  }
  if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= clip.automationPoints.length) {
    throw new Error('Automation point index is out of range');
  }
  if (clip.automationPoints.length <= 2) {
    throw new Error('Automation clip must retain at least two automation points');
  }

  const points = clip.automationPoints.map(p => ({ ...p }));
  points.splice(pointIndex, 1);

  const updated = cloneClip(clip);
  updated.automationPoints = points;
  return assertValidPlaylistClip(updated);
}

/**
 * Pure selection rule for automation point selection across clip changes.
 * A selected point index is only meaningful while the same clip stays
 * selected; switching clips, selecting a fresh clip, or closing/deleting the
 * clip always clears it so a later Delete can never hit an unintended point.
 */
export function nextSelectedPointIndex(
  previousClipId: string | null,
  previousPointIndex: number | null,
  nextClipId: string | null
): number | null {
  if (nextClipId === null || nextClipId === undefined) return null;
  if (previousClipId !== nextClipId) return null;
  return previousPointIndex;
}

/**
 * Finds the index of the point nearest to normX within tolerance, or null.
 * Ties resolve to the lowest index. Used to turn a click near an existing
 * point into an explicit point selection instead of an accidental relocation.
 */
export function findAutomationPointIndexNearX(
  points: AutomationPoint[],
  normX: number,
  tolerance: number
): number | null {
  if (!Array.isArray(points) || !finite(normX) || !finite(tolerance) || tolerance < 0) return null;
  let bestIndex: number | null = null;
  let bestDistance = tolerance;
  for (let i = 0; i < points.length; i++) {
    const distance = Math.abs(points[i].x - normX);
    if (distance > tolerance) continue;
    if (bestIndex === null || distance < bestDistance) {
      bestIndex = i;
      bestDistance = distance;
    }
  }
  return bestIndex;
}

/**
 * Chooses a collision-free insert position for a new automation node: the
 * midpoint of the widest gap between consecutive points (timeline edges count
 * as gaps). The value is the linear envelope value at that position, matching
 * the rendered polyline. Deterministic: ties pick the earliest gap.
 */
export function resolveAddNodePosition(points: AutomationPoint[]): { x: number; y: number } {
  if (!Array.isArray(points) || points.length === 0) return { x: 0.5, y: 0.5 };

  const sorted = [...points].sort((a, b) => a.x - b.x);
  let bestStart = 0;
  let bestEnd = sorted[0].x;
  let bestLeftY = sorted[0].y;   // y to hold when the gap starts at the timeline edge
  let bestRightY = sorted[0].y;  // y to hold when the gap ends at the timeline edge
  let hasLeftPoint = false;
  let hasRightPoint = sorted.length > 0;

  for (let i = 0; i < sorted.length - 1; i++) {
    const width = sorted[i + 1].x - sorted[i].x;
    if (width > bestEnd - bestStart) {
      bestStart = sorted[i].x;
      bestEnd = sorted[i + 1].x;
      bestLeftY = sorted[i].y;
      bestRightY = sorted[i + 1].y;
      hasLeftPoint = true;
      hasRightPoint = true;
    }
  }
  const tailWidth = 1 - sorted[sorted.length - 1].x;
  if (tailWidth > bestEnd - bestStart) {
    bestStart = sorted[sorted.length - 1].x;
    bestEnd = 1;
    bestLeftY = sorted[sorted.length - 1].y;
    bestRightY = sorted[sorted.length - 1].y;
    hasLeftPoint = true;
    hasRightPoint = false;
  }

  const x = Number(Math.max(0, Math.min(1, (bestStart + bestEnd) / 2)).toFixed(6));
  let y: number;
  if (bestEnd - bestStart < 1e-9) {
    y = bestLeftY;
  } else if (hasLeftPoint && hasRightPoint) {
    const t = (x - bestStart) / (bestEnd - bestStart);
    y = bestLeftY + (bestRightY - bestLeftY) * t;
  } else if (hasRightPoint) {
    y = bestRightY;
  } else {
    y = bestLeftY;
  }
  return { x, y: Number(Math.max(0, Math.min(1, y)).toFixed(6)) };
}

export function updatePlaylistAutomationTarget(
  clip: PlaylistClip,
  target: {
    type: AutomationTargetType;
    targetId: string | number;
    paramName?: string;
    label?: string;
  }
): PlaylistClip {
  if (clip.type !== 'automation') {
    throw new Error('Target updates require an automation clip');
  }
  if (!target || !target.type) {
    throw new Error('Automation target and target type are required');
  }

  const updated = cloneClip(clip);
  updated.automationTarget = { ...target };
  if (target.label) {
    updated.name = `Auto: ${target.label}`;
  }
  return assertValidPlaylistClip(updated);
}

export function deletePlaylistClip(clips: PlaylistClip[], clipId: string): PlaylistClip[] {
  return clips.filter(clip => clip.id !== clipId);
}

export function replacePlaylistClip(clips: PlaylistClip[], updatedClip: PlaylistClip, bounds: PlaylistBounds = {}): PlaylistClip[] {
  assertValidPlaylistClip(updatedClip, bounds);
  if (!clips.some(clip => clip.id === updatedClip.id)) throw new Error(`Clip not found: ${updatedClip.id}`);
  return clips.map(clip => clip.id === updatedClip.id ? cloneClip(updatedClip) : clip);
}

export function resolvePlaylistTargetChannel(channels: Channel[], trackIndex: number): Channel | undefined {
  if (!Array.isArray(channels) || channels.length === 0) return undefined;
  return channels[trackIndex] ?? channels[0];
}

export function createPlaylistPatternClip(
  trackIndex: number,
  startBar: number,
  channel?: Channel,
  track?: PlaylistTrack,
  lengthBars = 4,
  id?: string,
  bounds: PlaylistBounds = {}
): PlaylistClip {
  const clipId = id || `clip-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`;
  const clip: PlaylistClip = {
    id: clipId,
    trackIndex,
    startBar,
    lengthBars,
    type: 'pattern',
    channelId: channel?.id,
    color: track?.color || channel?.color || '#ff6e00',
    name: `${track?.name || channel?.name || 'Track'} Block`
  };
  return assertValidPlaylistClip(clip, bounds);
}

export type PlaylistKeyboardAction = 'delete' | 'duplicate' | 'escape' | 'none';

export function resolvePlaylistKeyboardShortcut(
  event: {
    key?: string;
    code?: string;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
  },
  hasSelection: boolean
): PlaylistKeyboardAction {
  if (event.key === 'Escape') {
    return 'escape';
  }

  const isCtrlOrMeta = Boolean(event.ctrlKey || event.metaKey);
  const isShift = Boolean(event.shiftKey);
  const isAlt = Boolean(event.altKey);

  if (isCtrlOrMeta && !isShift && !isAlt && (event.key === 'd' || event.key === 'D' || event.code === 'KeyD')) {
    return hasSelection ? 'duplicate' : 'none';
  }

  if (!isCtrlOrMeta && !isShift && !isAlt && (event.key === 'Delete' || event.key === 'Backspace')) {
    return hasSelection ? 'delete' : 'none';
  }

  return 'none';
}
