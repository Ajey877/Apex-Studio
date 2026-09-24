import type { Note, SampleZone } from '../types/daw';

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

export function getSamplePlaybackRate(notePitch: number, rootNote: number, channelPitch = 0, tuneSemitones = 0): number {
  return Math.pow(2, ((notePitch - rootNote) + channelPitch + tuneSemitones) / 12);
}

export function clampSampleRange(start = 0, end = 1): { start: number; end: number } {
  const safeStart = Math.max(0, Math.min(1, Number.isFinite(start) ? start : 0));
  const safeEnd = Math.max(safeStart, Math.min(1, Number.isFinite(end) ? end : 1));
  return { start: safeStart, end: safeEnd };
}
