import type { Channel, MixerTrack, ProjectState } from '../types/daw';

export const MASTER_MIXER_TRACK_ID = 0;

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > MASTER_MIXER_TRACK_ID;

const collectOccupiedMixerTrackIds = (projectState: ProjectState): Set<number> => {
  const occupied = new Set<number>();

  for (const channel of projectState.channels) {
    if (isPositiveSafeInteger(channel.mixerTrackId)) {
      occupied.add(channel.mixerTrackId);
    }
  }

  for (const mixerTrack of projectState.mixerTracks) {
    if (isPositiveSafeInteger(mixerTrack.id)) {
      occupied.add(mixerTrack.id);
    }
  }

  return occupied;
};

export const getOccupiedMixerTrackIds = (projectState: ProjectState): Set<number> =>
  collectOccupiedMixerTrackIds(projectState);

/** Enforces the project-level channel <-> mixer-track identity invariant. */
export const normalizeMixerTrackIdentityIntegrity = (projectState: ProjectState): ProjectState => {
  const mixerTracksById = new Map<number, MixerTrack>();
  const mixerTracks: MixerTrack[] = [];

  for (const track of projectState.mixerTracks) {
    if (!Number.isSafeInteger(track.id) || track.id < MASTER_MIXER_TRACK_ID) continue;
    if (mixerTracksById.has(track.id)) continue;
    mixerTracksById.set(track.id, track);
    mixerTracks.push(track);
  }

  const usedChannelIds = new Set<number>();
  const usedIds = new Set<number>(mixerTracks.map(track => track.id));
  let nextId = Math.max(
    deriveNextMixerTrackId({ ...projectState, mixerTracks }),
    MASTER_MIXER_TRACK_ID + 1
  );
  let changed = mixerTracks.length !== projectState.mixerTracks.length;

  const allocate = (): number => {
    while (usedIds.has(nextId) || nextId === MASTER_MIXER_TRACK_ID) nextId += 1;
    if (nextId >= Number.MAX_SAFE_INTEGER) throw new Error('Mixer track identity space is exhausted.');
    const id = nextId++;
    usedIds.add(id);
    return id;
  };

  const channels = projectState.channels.map(channel => {
    const originalId = channel.mixerTrackId;
    const uniqueValidId = isPositiveSafeInteger(originalId) && !usedChannelIds.has(originalId);
    const existingTrack = uniqueValidId ? mixerTracksById.get(originalId) : undefined;
    const mixerTrackId = uniqueValidId && existingTrack ? originalId : allocate();
    usedChannelIds.add(mixerTrackId);

    if (!existingTrack) {
      const createdTrack: MixerTrack = {
        id: mixerTrackId,
        name: channel.name,
        color: channel.color,
        volume: channel.volume,
        pan: channel.pan,
        mute: channel.mute,
        solo: channel.solo,
        stereoWidth: 1,
        fxSlots: [],
        peakL: 0,
        peakR: 0,
        routingTargetId: 0
      };
      mixerTracks.push(createdTrack);
      mixerTracksById.set(mixerTrackId, createdTrack);
      changed = true;
    }

    if (mixerTrackId !== originalId) {
      changed = true;
      return { ...channel, mixerTrackId };
    }
    return channel;
  });

  if (!changed) return projectState;
  return {
    ...projectState,
    channels,
    mixerTracks,
    nextMixerTrackId: Math.max(projectState.nextMixerTrackId || 0, nextId)
  };
};

const findDuplicateIds = (ids: number[]): number[] => {
  const counts = new Map<number, number>();
  for (const id of ids) {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort((a, b) => a - b);
};

/** Detects duplicate records within each identity-bearing collection.
 * A channel ID appearing once and the corresponding MixerTrack ID appearing once
 * is the normal representation of the same mixer identity, not a duplicate.
 */
export const findDuplicateMixerTrackIdentities = (projectState: ProjectState): number[] => {
  const channelDuplicates = findDuplicateIds(
    projectState.channels
      .map(channel => channel.mixerTrackId)
      .filter(isPositiveSafeInteger)
  );
  const mixerDuplicates = findDuplicateIds(
    projectState.mixerTracks
      .map(mixerTrack => mixerTrack.id)
      .filter(isPositiveSafeInteger)
  );

  return [...new Set([...channelDuplicates, ...mixerDuplicates])].sort((a, b) => a - b);
};

export const deriveNextMixerTrackId = (projectState: ProjectState): number => {
  let highestOccupiedId = MASTER_MIXER_TRACK_ID;

  for (const id of collectOccupiedMixerTrackIds(projectState)) {
    highestOccupiedId = Math.max(highestOccupiedId, id);
  }

  if (highestOccupiedId >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Mixer track identity space is exhausted.');
  }

  return highestOccupiedId + 1;
};

export const normalizeNextMixerTrackId = (
  projectState: ProjectState,
  persistedValue: unknown
): number => {
  const safeDerivedValue = deriveNextMixerTrackId(projectState);

  if (!isPositiveSafeInteger(persistedValue)) {
    return safeDerivedValue;
  }

  return Math.max(persistedValue, safeDerivedValue);
};

export interface MixerTrackIdentityAllocation {
  mixerTrackId: number;
  nextMixerTrackId: number;
}

export const allocateMixerTrackIdentity = (
  projectState: ProjectState
): MixerTrackIdentityAllocation => {
  const occupied = collectOccupiedMixerTrackIds(projectState);
  let candidate = isPositiveSafeInteger(projectState.nextMixerTrackId)
    ? projectState.nextMixerTrackId
    : deriveNextMixerTrackId(projectState);

  while (candidate === MASTER_MIXER_TRACK_ID || occupied.has(candidate)) {
    if (candidate >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Mixer track identity space is exhausted.');
    }
    candidate += 1;
  }

  if (candidate >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Mixer track identity space is exhausted.');
  }

  return {
    mixerTrackId: candidate,
    nextMixerTrackId: candidate + 1
  };
};

export const appendChannelWithAllocatedMixerTrackId = (
  projectState: ProjectState,
  channel: Omit<Channel, 'mixerTrackId'>
): ProjectState => {
  const allocation = allocateMixerTrackIdentity(projectState);

  const mixerTrack: MixerTrack = {
    id: allocation.mixerTrackId,
    name: channel.name,
    color: channel.color,
    volume: channel.volume,
    pan: channel.pan,
    mute: channel.mute,
    solo: channel.solo,
    stereoWidth: 1,
    fxSlots: [],
    peakL: 0,
    peakR: 0,
    routingTargetId: MASTER_MIXER_TRACK_ID
  };

  return {
    ...projectState,
    channels: [
      ...projectState.channels,
      { ...channel, mixerTrackId: allocation.mixerTrackId }
    ],
    mixerTracks: [...projectState.mixerTracks, mixerTrack],
    nextMixerTrackId: allocation.nextMixerTrackId
  };
};
