import { PlaylistClip } from '../types/daw';

export function clampPlaylistClipStartBar(clip: PlaylistClip, totalBars: number): PlaylistClip {
  const maxStart = Math.max(0, totalBars - clip.lengthBars);
  const startBar = Math.min(Math.max(0, clip.startBar), maxStart);
  return startBar === clip.startBar ? clip : { ...clip, startBar };
}

export function clampPlaylistClipsToBounds(clips: PlaylistClip[], totalBars: number): PlaylistClip[] {
  return clips.map(clip => clampPlaylistClipStartBar(clip, totalBars));
}
