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

  if (
    channel.customSample &&
    zone.sampleId === channel.customSample.id &&
    (zone.rootNote ?? 60) !== 60 &&
    (zone.rootNote ?? 60) !== (channel.customSample.rootPitch ?? 60)
  ) {
    return false;
  }

  if (sampleLibrary && zone.sampleId !== channel.customSample?.id) {
    const librarySample = sampleLibrary.find(sample => sample.id === zone.sampleId);
    if (librarySample) {
      if ((zone.rootNote ?? 60) !== (librarySample.rootPitch ?? 60)) return false;
      if ((zone.trimStart ?? 0) !== (librarySample.trimStart ?? 0)) return false;
      if ((zone.trimEnd ?? 1) !== (librarySample.trimEnd ?? 1)) return false;
      if (Boolean(zone.reverse) !== Boolean(librarySample.reverse)) return false;
    }
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
