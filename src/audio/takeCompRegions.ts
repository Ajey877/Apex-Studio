/**
 * Phase 10A — Phrase-level take comping.
 *
 * Phase 1M grouped alternative recording passes into a *take group* and let the
 * musician hear exactly one whole take at a time (`activeTakeIndex`). That is
 * whole-take comping: pick a pass, hear all of it. Real comping picks the best
 * phrase of each pass and assembles one performance out of many takes.
 *
 * This module owns the pure model for that:
 *
 *   - a **comp region** is an explicit, persisted phrase: a start, a length and
 *     the `takeIndex` that sounds inside it, plus the crossfade that joins it to
 *     the region that follows;
 *   - regions are stored on the group's clips (`PlaylistClip.compRegions`), in
 *     musical bars *relative to the take group's start*, so moving the group
 *     moves the comp with it;
 *   - `resolveTakeCompPlan()` turns the validated regions plus the real take
 *     clips into **segments** — the exact (take, start, end, fade) rectangles the
 *     audio engine has to schedule. Equal-power crossfade windows are resolved
 *     here and bounded by the neighbouring phrases and by the material each take
 *     really has;
 *   - `resolveTakeCompRegionAudibility()` answers the question the whole
 *     playback/export stack already asks: which take clips are silent?
 *
 * Nothing here touches Web Audio, React, timers or storage. The engine, the
 * offline timeline renderer, project normalization and the comping UI all read
 * the same functions, so live playback, WAV export, save/load and the editor
 * cannot disagree about what a comp is.
 *
 * Backwards compatibility: a group with no `compRegions` (or whose regions do
 * not survive validation) keeps the Phase 1M whole-take contract byte for byte —
 * `resolveTakeCompPlan()` returns `null` and every call site falls back to
 * `activeTakeIndex`.
 */
import type { PlaylistClip, TakeCompRegion } from '../types/daw';

/** Bars (relative to the group start) below which two numbers count as equal. */
export const COMP_EPSILON_BARS = 1e-6;

/** Smallest region the editor will create or keep. A 64th of a bar is ~31 ms at 120 BPM 4/4. */
export const MIN_COMP_REGION_BARS = 1 / 64;

/**
 * Shortest boundary that still counts as a crossfade rather than a guarded cut.
 * ~5 ms at 120 BPM 4/4 — long enough to remove the click, short enough that it
 * only appears where the material genuinely cannot overlap.
 */
export const MIN_COMP_CROSSFADE_BARS = 0.0025;

/**
 * Default trailing crossfade for a new phrase boundary: a 16th of a bar
 * (~125 ms at 120 BPM 4/4). Long enough to be audible as a blend without
 * smearing consonants.
 */
export const DEFAULT_COMP_CROSSFADE_BARS = 0.0625;

/** Fade applied inside a phrase when a boundary cannot support an overlap at all. */
const CUT_GUARD_BARS = MIN_COMP_CROSSFADE_BARS;

export type CompRegionIssueCode =
  | 'malformed'
  | 'duplicate-id'
  | 'out-of-range'
  | 'overlap'
  | 'missing-take'
  | 'duplicate-take'
  | 'missing-asset'
  | 'trimmed';

export interface CompRegionIssue {
  code: CompRegionIssueCode;
  message: string;
  regionId?: string;
  takeIndex?: number;
}

export interface NormalizedCompRegions {
  regions: TakeCompRegion[];
  issues: CompRegionIssue[];
}

export interface TakeCompSegment {
  /** Take clip that supplies this segment's audio. */
  takeClipId: string;
  takeIndex: number;
  /** Regions covered by this segment; more than one when adjacent phrases use the same take. */
  regionIds: string[];
  /** Segment start in bars relative to the take group's start. */
  startBar: number;
  /** Segment end in bars relative to the take group's start. */
  endBar: number;
  /** Equal-power fade-in length in bars (0 when the take's own fade-in applies). */
  fadeInBars: number;
  /** Equal-power fade-out length in bars (0 when the take's own fade-out applies). */
  fadeOutBars: number;
  /** The segment starts at the take group's start: the take clip's own fade-in applies. */
  usesClipFadeIn: boolean;
  /** The segment ends at the take group's end: the take clip's own fade-out applies. */
  usesClipFadeOut: boolean;
  /** Group-relative bar where this segment's leading crossfade begins, when it has one. */
  crossfadeInStartBar?: number;
  /** Group-relative bar where this segment's trailing crossfade begins, when it has one. */
  crossfadeOutStartBar?: number;
}

export interface TakeCompPlan {
  groupId: string;
  /** Validated, sorted, non-overlapping regions. Never empty. */
  regions: TakeCompRegion[];
  /** Playable segments in timeline order. */
  segments: TakeCompSegment[];
  /** Bars of the group that no segment covers (leading gap + gaps between phrases). */
  gaps: Array<{ startBar: number; lengthBars: number }>;
  /** Total length of the group in bars. */
  lengthBars: number;
  issues: CompRegionIssue[];
}

export interface TakeCompMaterial {
  /** Bars of source material that exist *before* the take's timeline origin. */
  leadInBars: number;
  /** Bars of source material between the take's timeline origin and the end of its buffer. */
  totalBars: number;
}

export interface TakeCompPlanInput {
  clips: readonly PlaylistClip[];
  takeGroupId: string;
  /**
   * Real material available in a take, in timeline bars. Omit (or return
   * `Infinity` total / 0 lead-in) when the buffer is not loaded; the plan is
   * then material-agnostic and the engine truncates at playback instead.
   */
  takeMaterial?: (clip: PlaylistClip) => TakeCompMaterial;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/**
 * `Infinity` is the honest "unknown" for a take whose buffer is not loaded yet:
 * it never clamps a crossfade, and the engine still truncates by `Buffer.duration`.
 */
export const UNBOUNDED_COMP_MATERIAL: TakeCompMaterial = { leadInBars: 0, totalBars: Infinity };

/** Normalizes one region, returning `null` when it cannot represent audio. */
const normalizeRegion = (
  raw: unknown,
  index: number,
  issues: CompRegionIssue[],
): TakeCompRegion | null => {
  if (!isRecord(raw)) {
    issues.push({ code: 'malformed', message: `Comp region ${index + 1} is not an object; dropped.` });
    return null;
  }
  const startBar = raw.startBar;
  const lengthBars = raw.lengthBars;
  const takeIndex = raw.takeIndex;
  if (!isFiniteNumber(takeIndex) || !Number.isInteger(takeIndex) || takeIndex < 0) {
    issues.push({
      code: 'malformed',
      message: `Comp region ${index + 1} has no valid take index; dropped.`,
    });
    return null;
  }
  if (!isFiniteNumber(startBar) || !isFiniteNumber(lengthBars) || lengthBars <= 0) {
    issues.push({
      code: 'malformed',
      message: `Comp region ${index + 1} has invalid boundaries; dropped.`,
      takeIndex,
    });
    return null;
  }
  if (startBar < -COMP_EPSILON_BARS) {
    issues.push({
      code: 'out-of-range',
      message: `Comp region ${index + 1} starts before the take group; dropped.`,
      takeIndex,
    });
    return null;
  }
  if (lengthBars < MIN_COMP_REGION_BARS) {
    issues.push({
      code: 'malformed',
      message: `Comp region ${index + 1} is shorter than ${MIN_COMP_REGION_BARS.toFixed(6)} bars; dropped.`,
      takeIndex,
    });
    return null;
  }
  const rawId = raw.id;
  const id = typeof rawId === 'string' && rawId.trim().length > 0 ? rawId : `comp-${startBar}-${takeIndex}`;
  const rawCrossfade = raw.crossfadeBars;
  let crossfadeBars = 0;
  if (rawCrossfade !== undefined) {
    if (isFiniteNumber(rawCrossfade) && rawCrossfade >= 0) {
      crossfadeBars = rawCrossfade;
    } else {
      issues.push({
        code: 'malformed',
        message: `Comp region "${id}" has an invalid crossfade; reset to 0.`,
        regionId: id,
        takeIndex,
      });
    }
  }
  return {
    id,
    startBar: Math.max(0, startBar),
    lengthBars,
    takeIndex,
    crossfadeBars,
  };
};

/**
 * Validates and canonicalizes a persisted `PlaylistClip.compRegions` value:
 * drops unrepresentable entries, sorts by position, and refuses overlapping
 * phrases (the later one is dropped) so the audio graph can never receive two
 * different takes claiming the same instant.
 *
 * Gaps are *not* an error — a gap is silence, which is what deleting a phrase
 * out of the middle of a comp means.
 */
export const normalizeCompRegions = (value: unknown): NormalizedCompRegions => {
  const issues: CompRegionIssue[] = [];
  if (value === undefined || value === null) return { regions: [], issues };
  if (!Array.isArray(value)) {
    issues.push({ code: 'malformed', message: 'Comp regions are not a list; ignored.' });
    return { regions: [], issues };
  }
  const parsed: TakeCompRegion[] = [];
  const seenIds = new Set<string>();
  value.forEach((raw, index) => {
    const region = normalizeRegion(raw, index, issues);
    if (!region) return;
    if (seenIds.has(region.id)) {
      issues.push({
        code: 'duplicate-id',
        message: `Comp region id "${region.id}" is repeated; the later copy was dropped.`,
        regionId: region.id,
      });
      return;
    }
    seenIds.add(region.id);
    parsed.push(region);
  });

  parsed.sort((a, b) => (a.startBar - b.startBar) || a.id.localeCompare(b.id));

  const regions: TakeCompRegion[] = [];
  let previousEnd = -Infinity;
  for (const region of parsed) {
    if (region.startBar < previousEnd - COMP_EPSILON_BARS) {
      issues.push({
        code: 'overlap',
        message: `Comp region "${region.id}" overlaps the phrase before it; dropped.`,
        regionId: region.id,
        takeIndex: region.takeIndex,
      });
      continue;
    }
    regions.push(region);
    previousEnd = Math.max(previousEnd, region.startBar + region.lengthBars);
  }
  return { regions, issues };
};

/** Groups clips by `takeGroupId`, preserving array order inside each group. */
export const groupTakeClips = (clips: readonly PlaylistClip[]): Map<string, PlaylistClip[]> => {
  const groups = new Map<string, PlaylistClip[]>();
  for (const clip of clips) {
    if (!clip.takeGroupId) continue;
    const list = groups.get(clip.takeGroupId);
    if (list) list.push(clip);
    else groups.set(clip.takeGroupId, [clip]);
  }
  return groups;
};

/**
 * Resolves the group's canonical region list.
 *
 * Regions are group state persisted on every clip of the group (clips are the
 * project's persistence unit; there is no group object to hang them on). The
 * canonical copy is the one carried by the lowest `takeIndex` (ties broken by
 * clip id), so a hand-edited or partially-written project still resolves to one
 * deterministic value instead of depending on array order.
 */
export const resolveCanonicalCompRegions = (
  groupClips: readonly PlaylistClip[],
): NormalizedCompRegions => {
  if (groupClips.length === 0) return { regions: [], issues: [] };
  const ordered = [...groupClips].sort((a, b) =>
    ((a.takeIndex ?? 0) - (b.takeIndex ?? 0)) || a.id.localeCompare(b.id));
  for (const clip of ordered) {
    if (!clip.compRegions) continue;
    const normalized = normalizeCompRegions(clip.compRegions);
    if (normalized.regions.length > 0) return normalized;
  }
  return { regions: [], issues: [] };
};

const takeIndexOf = (clip: PlaylistClip): number => (typeof clip.takeIndex === 'number' ? clip.takeIndex : 0);

/**
 * Turns validated regions into the segments the engine schedules.
 *
 * Crossfade placement is resolved per boundary, in this order:
 *
 *   1. **Centred** (`[b - c/2, b + c/2]`) when both neighbours have the material
 *      to reach into each other — the normal case, and the only one where the
 *      seam sits exactly on the musical boundary the musician drew.
 *   2. **Post-roll** (`[b, b + c]`) when only the outgoing take has tail
 *      material (e.g. the incoming take's phrase starts at its very first sample).
 *   3. **Pre-roll** (`[b - c, b]`) when only the incoming take has lead-in
 *      material (e.g. the outgoing take's phrase ends at its last sample).
 *   4. **Guarded cut** when neither side can overlap: two short equal-power
 *      fades inside the phrases, which is honest — no invented audio, no click.
 *
 * Adjacent phrases that name the *same* take are merged into one segment: their
 * audio is sample-continuous, so a crossfade there would only dip the level.
 */
export const resolveTakeCompPlan = (input: TakeCompPlanInput): TakeCompPlan | null => {
  const groupClips = input.clips.filter(c => c.takeGroupId === input.takeGroupId);
  if (groupClips.length === 0) return null;

  const issues: CompRegionIssue[] = [];
  const canonical = resolveCanonicalCompRegions(groupClips);
  issues.push(...canonical.issues);
  if (canonical.regions.length === 0) return null;

  const lengthBars = Math.max(
    0,
    ...groupClips.map(c => (isFiniteNumber(c.lengthBars) && c.lengthBars > 0 ? c.lengthBars : 0)),
  );
  if (!(lengthBars > 0)) return null;

  const materialFor = input.takeMaterial ?? (() => UNBOUNDED_COMP_MATERIAL);

  // takeIndex -> clip. Duplicates resolve to the lowest clip id so the choice is
  // deterministic; the duplicate is reported rather than silently ambiguous.
  const takeClips = new Map<number, PlaylistClip>();
  for (const clip of [...groupClips].sort((a, b) => a.id.localeCompare(b.id))) {
    const index = takeIndexOf(clip);
    if (takeClips.has(index)) {
      issues.push({
        code: 'duplicate-take',
        message: `Take index ${index} is carried by more than one clip; "${takeClips.get(index)!.id}" is used.`,
        takeIndex: index,
      });
      continue;
    }
    takeClips.set(index, clip);
  }

  interface Span {
    regionIds: string[];
    takeClip: PlaylistClip;
    start: number;
    end: number;
    fadeIn: number;
    fadeOut: number;
    usesClipFadeIn: boolean;
    usesClipFadeOut: boolean;
    crossfadeInStart?: number;
    crossfadeOutStart?: number;
  }

  const spans: Span[] = [];
  for (const region of canonical.regions) {
    const takeClip = takeClips.get(region.takeIndex);
    if (!takeClip) {
      issues.push({
        code: 'missing-take',
        message: `Comp region "${region.id}" names take ${region.takeIndex}, which is not in the group; silent.`,
        regionId: region.id,
        takeIndex: region.takeIndex,
      });
      continue;
    }
    if (takeClip.audioUnavailable) {
      issues.push({
        code: 'missing-asset',
        message: `Comp region "${region.id}" references take ${region.takeIndex}, whose audio asset is unavailable; its persisted audio could not be restored.`,
        regionId: region.id,
        takeIndex: region.takeIndex,
      });
      continue;
    }
    let start = Math.max(0, region.startBar);
    let end = start + region.lengthBars;
    if (end > lengthBars + COMP_EPSILON_BARS) {
      issues.push({
        code: 'out-of-range',
        message: `Comp region "${region.id}" runs past the end of the take group; trimmed.`,
        regionId: region.id,
        takeIndex: region.takeIndex,
      });
      end = lengthBars;
    }
    if (end - start < MIN_COMP_REGION_BARS) continue;
    spans.push({
      regionIds: [region.id],
      takeClip,
      start,
      end,
      fadeIn: 0,
      fadeOut: 0,
      usesClipFadeIn: false,
      usesClipFadeOut: false,
    });
  }

  // Boundary crossfades between adjacent phrases.
  const regionById = new Map(canonical.regions.map(r => [r.id, r]));
  for (let i = 0; i < spans.length - 1; i += 1) {
    const a = spans[i];
    const b = spans[i + 1];
    if (Math.abs(b.start - a.end) > COMP_EPSILON_BARS) continue; // a gap is silence
    if (a.takeClip.id === b.takeClip.id) continue; // merged below

    const boundary = a.end;
    const outgoingRegion = regionById.get(a.regionIds[a.regionIds.length - 1])!;
    const incomingRegion = regionById.get(b.regionIds[0])!;
    const want = Math.min(
      outgoingRegion.crossfadeBars,
      (a.end - a.start) / 2,
      (b.end - b.start) / 2,
    );

    const materialA = materialFor(a.takeClip);
    const materialB = materialFor(b.takeClip);
    const tailAvail = Math.max(0, Math.min(materialA.totalBars, 1e9) - boundary);
    const leadAvail = Math.max(0, boundary + Math.max(0, materialB.leadInBars));

    let c = 0;
    let windowStart = boundary;
    let windowEnd = boundary;
    if (want >= MIN_COMP_CROSSFADE_BARS) {
      const centredCapacity = Math.min(tailAvail, leadAvail, boundary) * 2;
      if (centredCapacity >= MIN_COMP_CROSSFADE_BARS) {
        c = Math.min(want, centredCapacity);
        windowStart = boundary - c / 2;
        windowEnd = boundary + c / 2;
      } else if (tailAvail >= MIN_COMP_CROSSFADE_BARS) {
        c = Math.min(want, tailAvail);
        windowStart = boundary;
        windowEnd = boundary + c;
      } else if (leadAvail >= MIN_COMP_CROSSFADE_BARS) {
        c = Math.min(want, leadAvail, a.end - a.start);
        windowStart = boundary - c;
        windowEnd = boundary;
      }
    }

    if (c >= MIN_COMP_CROSSFADE_BARS) {
      a.end = windowEnd;
      a.fadeOut = c;
      a.crossfadeOutStart = windowStart;
      b.start = windowStart;
      b.fadeIn = c;
      b.crossfadeInStart = windowStart;
    } else {
      // No usable overlap: short equal-power guards inside each phrase.
      const guardA = Math.min(CUT_GUARD_BARS, (a.end - a.start) / 4);
      const guardB = Math.min(CUT_GUARD_BARS, (b.end - b.start) / 4);
      a.fadeOut = Math.max(a.fadeOut, guardA);
      b.fadeIn = Math.max(b.fadeIn, guardB);
    }
  }

  // Merge sample-continuous neighbours that resolved to the same take.
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.takeClip.id === span.takeClip.id &&
      Math.abs(span.start - last.end) <= COMP_EPSILON_BARS &&
      last.fadeOut === 0 &&
      span.fadeIn === 0
    ) {
      last.end = span.end;
      last.fadeOut = span.fadeOut;
      last.regionIds.push(...span.regionIds);
      if (span.crossfadeOutStart !== undefined) last.crossfadeOutStart = span.crossfadeOutStart;
      continue;
    }
    merged.push({ ...span, regionIds: [...span.regionIds] });
  }

  // Bound every span by the material its take really has.
  const segments: TakeCompSegment[] = [];
  for (const span of merged) {
    const material = materialFor(span.takeClip);
    const availableStart = -Math.max(0, material.leadInBars);
    let start = span.start;
    let end = span.end;
    if (start < availableStart) start = availableStart;
    if (Number.isFinite(material.totalBars) && end > material.totalBars) {
      end = material.totalBars;
    }
    if (end - start < MIN_COMP_REGION_BARS) {
      issues.push({
        code: 'trimmed',
        message: `Take ${takeIndexOf(span.takeClip)} has no audio for region "${span.regionIds[0]}"; silent.`,
        regionId: span.regionIds[0],
        takeIndex: takeIndexOf(span.takeClip),
      });
      continue;
    }
    const fadeIn = Math.min(span.fadeIn, end - start);
    const fadeOut = Math.min(span.fadeOut, end - start);
    // Keep the two fades inside the span even when the material clamped it.
    const overlap = fadeIn + fadeOut - (end - start);
    const scale = overlap > 0 ? (end - start) / (fadeIn + fadeOut) : 1;
    segments.push({
      takeClipId: span.takeClip.id,
      takeIndex: takeIndexOf(span.takeClip),
      regionIds: span.regionIds,
      startBar: start,
      endBar: end,
      fadeInBars: fadeIn * scale,
      fadeOutBars: fadeOut * scale,
      usesClipFadeIn: false,
      usesClipFadeOut: false,
      crossfadeInStartBar: span.crossfadeInStart,
      crossfadeOutStartBar: span.crossfadeOutStart,
    });
  }
  segments.sort((a, b) => (a.startBar - b.startBar) || a.takeIndex - b.takeIndex);

  // Group-edge fades: the take's own fade-in/out frame the assembled performance.
  if (segments.length > 0) {
    const first = segments[0];
    if (first.startBar <= COMP_EPSILON_BARS) {
      first.startBar = 0;
      first.usesClipFadeIn = true;
      first.fadeInBars = 0;
      first.crossfadeInStartBar = undefined;
    }
    const last = segments[segments.length - 1];
    if (Math.abs(last.endBar - lengthBars) <= COMP_EPSILON_BARS) {
      last.endBar = lengthBars;
      last.usesClipFadeOut = true;
      last.fadeOutBars = 0;
      last.crossfadeOutStartBar = undefined;
    }
  }

  // Gaps: real silence the musician should see, not a rounding artefact.
  const gaps: Array<{ startBar: number; lengthBars: number }> = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.startBar > cursor + COMP_EPSILON_BARS) {
      gaps.push({ startBar: cursor, lengthBars: segment.startBar - cursor });
    }
    cursor = Math.max(cursor, segment.endBar);
  }
  if (cursor < lengthBars - COMP_EPSILON_BARS) {
    gaps.push({ startBar: cursor, lengthBars: lengthBars - cursor });
  }

  return {
    groupId: input.takeGroupId,
    regions: canonical.regions,
    segments,
    gaps,
    lengthBars,
    issues,
  };
};

/**
 * Phase 10A — comp issues that must block a mixdown.
 *
 * A phrase whose take audio could not be restored is the Phase 8B case: the
 * project expects audible material there, so rendering a WAV with a silent hole
 * would be a misleading result. Export refuses (the editor already shows the
 * phrase as unavailable, and the comp can be repointed or reverted).
 *
 * A phrase naming a take that no longer exists is *not* on this list: there is no
 * asset to restore, the phrase is dropped deterministically, and the remaining
 * phrases still render.
 */
export const resolveBlockingCompIssues = (
  clips: readonly PlaylistClip[],
): CompRegionIssue[] => {
  const blocking: CompRegionIssue[] = [];
  for (const [groupId, groupClips] of groupTakeClips(clips)) {
    if (resolveCanonicalCompRegions(groupClips).regions.length === 0) continue;
    const plan = resolveTakeCompPlan({ clips: groupClips, takeGroupId: groupId });
    if (!plan) continue;
    for (const issue of plan.issues) {
      if (issue.code === 'missing-asset') blocking.push(issue);
    }
  }
  return blocking;
};

/**
 * Comp-aware audibility, in the same shape the engine already consumes.
 *
 * A take clip is inaudible when it carries no segment. Clips outside take groups
 * are never inaudible by this rule, and a group without valid comp regions keeps
 * the Phase 1M whole-take answer exactly.
 */
export const resolveTakeCompRegionAudibility = (clips: readonly PlaylistClip[]): Set<string> => {
  const inaudible = new Set<string>();
  const groups = groupTakeClips(clips);
  for (const [groupId, groupClips] of groups) {
    const canonical = resolveCanonicalCompRegions(groupClips);
    if (canonical.regions.length === 0) continue;
    const plan = resolveTakeCompPlan({ clips: groupClips, takeGroupId: groupId });
    const audibleTakes = new Set<number>((plan?.segments ?? []).map(segment => segment.takeIndex));
    for (const clip of groupClips) {
      if (!audibleTakes.has(takeIndexOf(clip))) inaudible.add(clip.id);
    }
  }
  return inaudible;
};

/**
 * Equal-power crossfade law: `sin(t·π/2)` rising, `cos(t·π/2)` falling. The two
 * halves sum to a constant *power* (rather than a constant amplitude), which is
 * what stops a blend between two uncorrelated takes from dipping at the seam.
 *
 * Exported so the engine builds its `AudioParam` curves from the same numbers
 * the tests measure against.
 */
export const equalPowerGainAt = (t: number, direction: 'in' | 'out'): number => {
  const clamped = Math.min(1, Math.max(0, t));
  return direction === 'in'
    ? Math.sin((clamped * Math.PI) / 2)
    : Math.cos((clamped * Math.PI) / 2);
};

/** Sample points for `AudioParam.setValueCurveAtTime`, scaled to `peak`. */
export const createEqualPowerFadeCurve = (
  direction: 'in' | 'out',
  peak = 1,
  points = 33,
): Float32Array => {
  const count = Math.max(2, Math.floor(points));
  const curve = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    curve[index] = equalPowerGainAt(index / (count - 1), direction) * peak;
  }
  return curve;
};

/** The region covering a group-relative bar, or `null` in a gap. */
export const findCompRegionAtBar = (
  regions: readonly TakeCompRegion[],
  bar: number,
): TakeCompRegion | null => {
  for (const region of regions) {
    if (bar >= region.startBar - COMP_EPSILON_BARS && bar < region.startBar + region.lengthBars - COMP_EPSILON_BARS) {
      return region;
    }
  }
  return null;
};

export interface CompRegionDraftOptions {
  /** Default crossfade for a freshly split boundary. */
  crossfadeBars?: number;
}

const withNormalized = (
  regions: readonly TakeCompRegion[],
): TakeCompRegion[] => normalizeCompRegions(regions).regions;

/**
 * Splits the region that contains `bar` into two phrases that both keep the
 * same take. Returns the input (normalized) when the cut would produce a phrase
 * shorter than `MIN_COMP_REGION_BARS`, so the editor can never create one it
 * would immediately reject.
 */
export const splitCompRegionAtBar = (
  regions: readonly TakeCompRegion[],
  bar: number,
  options: CompRegionDraftOptions = {},
): TakeCompRegion[] => {
  const crossfadeBars = options.crossfadeBars ?? DEFAULT_COMP_CROSSFADE_BARS;
  const normalized = withNormalized(regions);
  const target = findCompRegionAtBar(normalized, bar);
  if (!target) return normalized;
  const leftLength = bar - target.startBar;
  const rightLength = target.startBar + target.lengthBars - bar;
  if (leftLength < MIN_COMP_REGION_BARS || rightLength < MIN_COMP_REGION_BARS) return normalized;
  const next: TakeCompRegion[] = [];
  for (const region of normalized) {
    if (region.id !== target.id) {
      next.push(region);
      continue;
    }
    next.push({ ...region, lengthBars: leftLength, crossfadeBars });
    next.push({
      id: `${region.id}-b`,
      startBar: bar,
      lengthBars: rightLength,
      takeIndex: region.takeIndex,
      crossfadeBars: region.crossfadeBars,
    });
  }
  return withNormalized(next);
};

/** Removes a phrase. The timeline it covered becomes silence, not a shift. */
export const removeCompRegion = (
  regions: readonly TakeCompRegion[],
  regionId: string,
): TakeCompRegion[] => withNormalized(regions.filter(region => region.id !== regionId));

const clampRegionStart = (value: number): number => Math.max(0, value);

/**
 * Moves a phrase's start (and therefore its length) without letting it pass into
 * its neighbours or below the group start.
 */
export const moveCompRegionStart = (
  regions: readonly TakeCompRegion[],
  regionId: string,
  nextStartBar: number,
): TakeCompRegion[] => {
  const normalized = withNormalized(regions);
  const index = normalized.findIndex(region => region.id === regionId);
  if (index < 0) return normalized;
  const region = normalized[index];
  const previous = normalized[index - 1];
  const minimumStart = previous ? previous.startBar + previous.lengthBars : 0;
  const maximumStart = region.startBar + region.lengthBars - MIN_COMP_REGION_BARS;
  const startBar = Math.min(maximumStart, Math.max(minimumStart, clampRegionStart(nextStartBar)));
  const lengthBars = region.startBar + region.lengthBars - startBar;
  if (Math.abs(startBar - region.startBar) < COMP_EPSILON_BARS) return normalized;
  const next = [...normalized];
  next[index] = { ...region, startBar, lengthBars };
  return withNormalized(next);
};

/**
 * Trims a phrase's trailing edge. It cannot cross into the next phrase, and it
 * cannot shrink below `MIN_COMP_REGION_BARS`.
 */
export const resizeCompRegionEnd = (
  regions: readonly TakeCompRegion[],
  regionId: string,
  nextEndBar: number,
): TakeCompRegion[] => {
  const normalized = withNormalized(regions);
  const index = normalized.findIndex(region => region.id === regionId);
  if (index < 0) return normalized;
  const region = normalized[index];
  const next = normalized[index + 1];
  const maximumEnd = next ? next.startBar : Number.POSITIVE_INFINITY;
  const minimumEnd = region.startBar + MIN_COMP_REGION_BARS;
  const end = Math.min(maximumEnd, Math.max(minimumEnd, nextEndBar));
  const lengthBars = end - region.startBar;
  if (Math.abs(lengthBars - region.lengthBars) < COMP_EPSILON_BARS) return normalized;
  const result = [...normalized];
  result[index] = { ...region, lengthBars };
  return withNormalized(result);
};

/** Points a phrase at another take of the same group. */
export const setCompRegionTake = (
  regions: readonly TakeCompRegion[],
  regionId: string,
  takeIndex: number,
): TakeCompRegion[] => {
  if (!Number.isInteger(takeIndex) || takeIndex < 0) return withNormalized(regions);
  return withNormalized(regions.map(region =>
    region.id === regionId ? { ...region, takeIndex } : region));
};

/** Sets the crossfade that joins a phrase to the one that follows it. */
export const setCompRegionCrossfade = (
  regions: readonly TakeCompRegion[],
  regionId: string,
  crossfadeBars: number,
): TakeCompRegion[] => {
  const value = Number.isFinite(crossfadeBars) && crossfadeBars > 0 ? crossfadeBars : 0;
  return withNormalized(regions.map(region =>
    region.id === regionId ? { ...region, crossfadeBars: value } : region));
};

/**
 * Builds the first comp from a whole-take selection: one phrase spanning the
 * group, playing the currently active take. This is what "start comping" does —
 * it never guesses phrases the musician has not drawn.
 */
export const createInitialCompRegions = (
  groupClips: readonly PlaylistClip[],
  activeTakeIndex: number,
  crossfadeBars: number = DEFAULT_COMP_CROSSFADE_BARS,
): TakeCompRegion[] => {
  const lengthBars = Math.max(
    0,
    ...groupClips.map(clip => (isFiniteNumber(clip.lengthBars) && clip.lengthBars > 0 ? clip.lengthBars : 0)),
  );
  if (!(lengthBars > 0)) return [];
  const available = groupClips.some(clip => takeIndexOf(clip) === activeTakeIndex);
  const takeIndex = available ? activeTakeIndex : takeIndexOf(groupClips[0]);
  return withNormalized([{ id: 'comp-1', startBar: 0, lengthBars, takeIndex, crossfadeBars }]);
};

/**
 * Writes a comp to every clip of its group (or clears it) without touching take
 * audio. `null` restores the Phase 1M whole-take behaviour; the previous
 * `activeTakeIndex` is preserved so reverting a comp is not a second edit.
 */
export const applyCompRegionsToClips = (
  clips: readonly PlaylistClip[],
  takeGroupId: string,
  regions: readonly TakeCompRegion[] | null,
): PlaylistClip[] => {
  const normalized = regions === null ? [] : withNormalized(regions);
  const canonical = normalized.length > 0 ? normalized : null;
  return clips.map(clip => {
    if (clip.takeGroupId !== takeGroupId) return clip;
    if (canonical === null) {
      if (!clip.compRegions) return clip;
      const { compRegions: _dropped, ...rest } = clip;
      return rest as PlaylistClip;
    }
    return { ...clip, compRegions: canonical.map(region => ({ ...region })) };
  });
};

/**
 * Replicates the canonical comp across every clip of a group and drops
 * comp regions from groups that have none of their own. Project normalization
 * calls this so a hand-edited or partially written document resolves to one
 * deterministic comp per group.
 */
export const normalizeTakeCompRegionsInClips = (clips: PlaylistClip[]): PlaylistClip[] => {
  const groups = groupTakeClips(clips);
  const canonicalByGroup = new Map<string, TakeCompRegion[]>();
  for (const [groupId, groupClips] of groups) {
    canonicalByGroup.set(groupId, resolveCanonicalCompRegions(groupClips).regions);
  }
  if (canonicalByGroup.size === 0 && !clips.some(clip => clip.compRegions)) return clips;
  return clips.map(clip => {
    const groupId = clip.takeGroupId;
    if (!groupId) {
      if (!clip.compRegions) return clip;
      const { compRegions: _dropped, ...rest } = clip;
      return rest as PlaylistClip;
    }
    const canonical = canonicalByGroup.get(groupId) ?? [];
    if (canonical.length === 0) {
      if (!clip.compRegions) return clip;
      const { compRegions: _dropped, ...rest } = clip;
      return rest as PlaylistClip;
    }
    if (
      Array.isArray(clip.compRegions) &&
      clip.compRegions.length === canonical.length &&
      clip.compRegions.every((region, index) =>
        region.id === canonical[index].id &&
        region.startBar === canonical[index].startBar &&
        region.lengthBars === canonical[index].lengthBars &&
        region.takeIndex === canonical[index].takeIndex &&
        region.crossfadeBars === canonical[index].crossfadeBars)
    ) {
      return clip;
    }
    return { ...clip, compRegions: canonical.map(region => ({ ...region })) };
  });
};
