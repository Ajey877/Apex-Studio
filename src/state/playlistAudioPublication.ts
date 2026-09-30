export interface PlaylistAudioPublicationToken {
  projectGeneration: number;
  playlistRevision: number;
}

let currentProjectGeneration = 0;
let currentPlaylistRevision = 0;

export const capturePlaylistAudioPublicationToken = (
  projectGeneration: number,
  playlistRevision: number
): PlaylistAudioPublicationToken => ({
  projectGeneration,
  playlistRevision,
});

export const captureCurrentPlaylistAudioPublicationToken = (): PlaylistAudioPublicationToken =>
  capturePlaylistAudioPublicationToken(currentProjectGeneration, currentPlaylistRevision);

/**
 * Invalidates all pending playlist-audio publications when a new project is
 * about to become current. The generation is intentionally monotonic so a
 * stale async callback can never become valid again by accident.
 */
export const advancePlaylistAudioProjectGeneration = (): number => {
  currentProjectGeneration += 1;
  return currentProjectGeneration;
};

/**
 * Records a committed playlist-clips change. This is deliberately based on
 * the existing project-state references rather than a second playlist model.
 */
export const notePlaylistAudioPlaylistRevision = (
  previousPlaylistClips: unknown,
  nextPlaylistClips: unknown
): number => {
  if (previousPlaylistClips !== nextPlaylistClips) {
    currentPlaylistRevision += 1;
  }
  return currentPlaylistRevision;
};

export const isPlaylistAudioPublicationCurrent = (
  token: PlaylistAudioPublicationToken,
  currentProjectGeneration: number,
  currentPlaylistRevision: number
): boolean => (
  token.projectGeneration === currentProjectGeneration &&
  token.playlistRevision === currentPlaylistRevision
);

/**
 * Project-generation half of the strict gate. Two independent additive imports
 * may legitimately race, so a sibling commit advancing the playlist revision is
 * not a conflict; a replaced project still is, and that check can never be
 * relaxed.
 */
export const isPlaylistAudioProjectGenerationCurrent = (
  token: PlaylistAudioPublicationToken,
  currentGeneration: number = currentProjectGeneration
): boolean => token.projectGeneration === currentGeneration;

interface PlaylistAudioClipIdentity {
  id?: string;
}

/**
 * True when `nextClips` keeps every entry of `previousClips` as the very same
 * object, in the same order, and only adds entries at the end.
 *
 * Reference equality is deliberate: a clip that was edited, moved or removed
 * in the meantime is not a pure append, so the update must stay under the
 * strict stale-publication protection.
 */
export const isPureAdditivePlaylistClipAppend = <T>(
  previousClips: readonly T[],
  nextClips: readonly T[]
): boolean => {
  if (nextClips.length < previousClips.length) return false;
  for (let index = 0; index < previousClips.length; index += 1) {
    if (nextClips[index] !== previousClips[index]) return false;
  }
  return true;
};

/**
 * Resolves a pending playlist-audio publication against the playlist that is
 * live *now* instead of the snapshot captured before the persistence await.
 *
 * Returns the clip array to publish, or `null` when the publication is a
 * genuine stale/conflicting edit that must be rejected. When nothing is left to
 * add the current array is handed back unchanged so the caller can detect the
 * no-op by reference.
 */
export const resolveAdditivePlaylistClipPublication = <T extends PlaylistAudioClipIdentity>(
  currentClips: readonly T[],
  captureTimeClips: readonly T[],
  capturedClips: readonly T[]
): T[] | null => {
  // Nobody touched the playlist while this import was in flight, so the captured
  // array is still authoritative. This keeps single imports behaving exactly as
  // they did before the additive path existed.
  if (currentClips === captureTimeClips) return capturedClips as T[];

  // The captured update must itself be a pure append onto the state it replaced.
  if (!isPureAdditivePlaylistClipAppend(captureTimeClips, capturedClips)) return null;

  // The clips this import carried forward must still be intact and in order in
  // the live playlist, otherwise publishing would overwrite a newer edit.
  if (!isPureAdditivePlaylistClipAppend(captureTimeClips, currentClips)) return null;

  const liveIds = new Set(currentClips.map(clip => clip.id));
  const appended = capturedClips
    .slice(captureTimeClips.length)
    .filter(clip => !liveIds.has(clip.id));
  if (appended.length === 0) return currentClips as T[];
  return [...currentClips, ...appended];
};

export const isCurrentPlaylistAudioPublication = (
  token: PlaylistAudioPublicationToken
): boolean => isPlaylistAudioPublicationCurrent(
  token,
  currentProjectGeneration,
  currentPlaylistRevision
);
