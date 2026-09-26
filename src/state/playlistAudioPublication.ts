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

export const isCurrentPlaylistAudioPublication = (
  token: PlaylistAudioPublicationToken
): boolean => isPlaylistAudioPublicationCurrent(
  token,
  currentProjectGeneration,
  currentPlaylistRevision
);
