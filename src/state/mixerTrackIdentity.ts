import type { Channel, ProjectState } from '../types/daw';

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

export const findDuplicateMixerTrackIdentities = (projectState: ProjectState): number[] => {
  const counts = new Map<number, number>();

  for (const channel of projectState.channels) {
    if (isPositiveSafeInteger(channel.mixerTrackId)) {
      counts.set(channel.mixerTrackId, (counts.get(channel.mixerTrackId) ?? 0) + 1);
    }
  }

  for (const mixerTrack of projectState.mixerTracks) {
    if (isPositiveSafeInteger(mixerTrack.id)) {
      counts.set(mixerTrack.id, (counts.get(mixerTrack.id) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort((a, b) => a - b);
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

  return {
    ...projectState,
    channels: [
      ...projectState.channels,
      { ...channel, mixerTrackId: allocation.mixerTrackId }
    ],
    nextMixerTrackId: allocation.nextMixerTrackId
  };
};
