export interface PlaylistAudioPublicationToken {
  projectGeneration: number;
  playlistRevision: number;
}

export const capturePlaylistAudioPublicationToken = (
  projectGeneration: number,
  playlistRevision: number
): PlaylistAudioPublicationToken => ({
  projectGeneration,
  playlistRevision,
});

export const isPlaylistAudioPublicationCurrent = (
  token: PlaylistAudioPublicationToken,
  currentProjectGeneration: number,
  currentPlaylistRevision: number
): boolean => (
  token.projectGeneration === currentProjectGeneration &&
  token.playlistRevision === currentPlaylistRevision
);
