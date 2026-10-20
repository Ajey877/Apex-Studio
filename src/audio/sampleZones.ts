import type { Channel, CustomSampleData, Note, SampleZone } from '../types/daw';

export function findSampleZone(zones: SampleZone[] | undefined, note: Note): SampleZone | undefined {
  if (!zones?.length) return undefined;
  const velocity = Math.max(0, Math.min(127, Math.round((note.velocity ?? 0.8) * 127)));
  return zones.find(zone =>
    note.pitch >= zone.lowNote &&
    note.pitch <= zone.highNote &&
    velocity >= zone.lowVelocity &&
    velocity <= zone.highVelocity
  );
}

export function isImplicitDefaultSingleZone(
  channel: Pick<Channel, 'id' | 'sampleZones' | 'customSample' | 'synthParams'>,
  zone: SampleZone | undefined = channel.sampleZones?.[0],
  sampleLibrary?: ReadonlyArray<CustomSampleData>,
): boolean {
  if (!zone || (channel.sampleZones?.length ?? 0) !== 1) return false;
  if (zone.userAuthored) return false;
  if (zone.id !== `zone-${channel.id}` && zone.id !== `zone-default-${channel.id}`) {
    return false;
  }
  if (
    zone.lowNote !== 0 ||
    zone.highNote !== 127 ||
    (zone.lowVelocity ?? 0) !== 0 ||
    (zone.highVelocity ?? 127) !== 127 ||
    (zone.tuneSemitones ?? 0) !== 0
  ) {
    return false;
  }
  const channelLoop = Boolean(channel.synthParams?.sampleLoop);
  if ((zone.loop ?? channelLoop) !== channelLoop) return false;
  if (zone.loopStart !== undefined || zone.loopEnd !== undefined) return false;

  const hasDefaultPlaybackSettings =
    (zone.rootNote ?? 60) === 60 &&
    (zone.trimStart ?? 0) === 0 &&
    (zone.trimEnd ?? 1) === 1 &&
    Boolean(zone.reverse) === false;

  if (channel.customSample && zone.sampleId === channel.customSample.id) {
    const matchesCustomSample =
      (zone.rootNote ?? 60) === (channel.customSample.rootPitch ?? 60) &&
      (zone.trimStart ?? 0) === (channel.customSample.trimStart ?? 0) &&
      (zone.trimEnd ?? 1) === (channel.customSample.trimEnd ?? 1) &&
      Boolean(zone.reverse) === Boolean(channel.customSample.reverse);
    return matchesCustomSample || hasDefaultPlaybackSettings;
  }

  if (sampleLibrary) {
    return false;
  }

  return hasDefaultPlaybackSettings;
}

/**
 * True when `zone` reproduces the playback settings of the channel's body
 * sample: same source, root pitch, trims, reverse and loop flag.
 *
 * The multi-zone editor's derived full-range zone (`zone-<channelId>`) is made
 * exactly this way. Comparing content instead of trusting `userAuthored` is
 * deliberate: builds up to v1.2.2 stamped that derived zone `userAuthored: true`
 * as soon as *any* zone was edited, so a persisted project can carry a seed that
 * is flagged authored while still being an untouched projection of the sample.
 */
export function matchesChannelSampleProjection(
  channel: Pick<Channel, 'customSample' | 'synthParams'>,
  zone: SampleZone,
): boolean {
  const sample = channel.customSample;
  if (!sample?.id || zone.sampleId !== sample.id) return false;
  return (
    (zone.rootNote ?? 60) === (sample.rootPitch ?? 60) &&
    (zone.trimStart ?? 0) === (sample.trimStart ?? 0) &&
    (zone.trimEnd ?? 1) === (sample.trimEnd ?? 1) &&
    Boolean(zone.reverse) === Boolean(sample.reverse) &&
    Boolean(zone.loop) === Boolean(channel.synthParams?.sampleLoop)
  );
}

/**
 * A generated full-range "seed" zone of the channel's current `customSample`
 * that must not outlive a sample change.
 *
 * Identity is restricted to the two ids the multi-zone editor generates for its
 * derived view (`zone-<channelId>` / `zone-default-<channelId>`). Authored key
 * maps use other ids (`zone-<sampleId>-library`, `zone-<timestamp>`) and are
 * never matched here, so explicit splits and library-assigned zones survive.
 *
 * Two provenances are recognised:
 *  - the current, unflagged implicit view (matched through the same predicate
 *    the renderer and mutation boundary already use); and
 *  - a legacy seed that an older build persisted with `userAuthored: true`
 *    while every playback setting still mirrored the body sample.
 *
 * A zone flagged authored whose content differs from the body sample is real
 * user data and is preserved.
 */
export function isSupersededGeneratedSeedZone(
  channel: Pick<Channel, 'id' | 'sampleZones' | 'customSample' | 'synthParams'>,
  zone: SampleZone,
  sampleLibrary?: ReadonlyArray<CustomSampleData>,
): boolean {
  if (zone.id !== `zone-${channel.id}` && zone.id !== `zone-default-${channel.id}`) return false;
  if (zone.lowNote !== 0 || zone.highNote !== 127) return false;
  if ((zone.lowVelocity ?? 0) !== 0 || (zone.highVelocity ?? 127) !== 127) return false;
  if ((zone.tuneSemitones ?? 0) !== 0) return false;
  if (zone.loopStart !== undefined || zone.loopEnd !== undefined) return false;
  if (!matchesChannelSampleProjection(channel, zone)) {
    if (zone.userAuthored) return false;
    return isImplicitDefaultSingleZone(channel, zone, sampleLibrary);
  }
  return true;
}

export function getSamplePlaybackRate(notePitch: number, rootNote: number, channelPitch = 0, tuneSemitones = 0): number {
  return Math.pow(2, ((notePitch - rootNote) + channelPitch + tuneSemitones) / 12);
}

export function clampSampleRange(start = 0, end = 1): { start: number; end: number } {
  const safeStart = Math.max(0, Math.min(1, Number.isFinite(start) ? start : 0));
  const safeEnd = Math.max(safeStart, Math.min(1, Number.isFinite(end) ? end : 1));
  return { start: safeStart, end: safeEnd };
}
