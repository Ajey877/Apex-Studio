import type { MixerTrack } from '../types/daw';

/**
 * Build a dry channel-stem mixer snapshot. Aux sends can exist on any mixer
 * track in the channel's downstream routing path, not just the channel's
 * directly assigned track, so strip them from every track in this render.
 * The input project objects remain immutable.
 */
export function buildDryStemMixerTracks(mixerTracks: MixerTrack[]): MixerTrack[] {
  return mixerTracks.map(track =>
    track.auxSends?.length ? { ...track, auxSends: [] } : track
  );
}

/** Return mixer tracks that send directly to the requested auxiliary return. */
export function getDirectAuxSendSourceIds(mixerTracks: MixerTrack[], returnId: number): Set<number> {
  return new Set(
    mixerTracks
      .filter(track => track.auxSends?.some(send => send.targetId === returnId))
      .map(track => track.id)
  );
}

/**
 * Resolve the upstream routing closure for a set of tracks. Tracks are linked
 * by routingTargetId (source -> destination), so walk backwards until no new
 * upstream track is found. This captures instrument -> subgroup -> aux send.
 */
export function getUpstreamMixerTrackIds(mixerTracks: MixerTrack[], sinkIds: Set<number>): Set<number> {
  const included = new Set(sinkIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const track of mixerTracks) {
      if (included.has(track.id)) continue;
      if (typeof track.routingTargetId === 'number' && included.has(track.routingTargetId)) {
        included.add(track.id);
        changed = true;
      }
    }
  }
  return included;
}


/**
 * Build an isolated wet-return snapshot. Keep only sends to the selected return,
 * and divert each direct sender's ordinary bus output to the silent sink so the
 * return stem contains neither dry source audio nor audio from other returns.
 */
export function buildWetStemMixerTracks(
  mixerTracks: MixerTrack[],
  sourceIds: Set<number>,
  returnId: number,
  silentSinkId: number
): MixerTrack[] {
  return mixerTracks.map(track => ({
    ...track,
    ...(sourceIds.has(track.id) ? { routingTargetId: silentSinkId } : {}),
    auxSends: (track.auxSends ?? []).filter(send => send.targetId === returnId),
  }));
}
