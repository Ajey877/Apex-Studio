import type { Channel, MixerTrack } from '../types/daw';

/**
 * Allocates the next mixer-track identity without deriving it from collection size.
 * Existing project data is preserved; the allocator only chooses a new identity.
 */
export function allocateStableMixerTrackId(
  channels: ReadonlyArray<Pick<Channel, 'mixerTrackId'>>,
  mixerTracks: ReadonlyArray<Pick<MixerTrack, 'id'>>,
): number {
  let maxId = 0;

  for (const channel of channels) {
    if (Number.isSafeInteger(channel.mixerTrackId) && channel.mixerTrackId >= 0) {
      maxId = Math.max(maxId, channel.mixerTrackId);
    }
  }

  for (const mixerTrack of mixerTracks) {
    if (Number.isSafeInteger(mixerTrack.id) && mixerTrack.id >= 0) {
      maxId = Math.max(maxId, mixerTrack.id);
    }
  }

  const nextId = maxId + 1;
  if (!Number.isSafeInteger(nextId)) {
    throw new Error('Mixer track identity space is exhausted.');
  }

  return nextId;
}
