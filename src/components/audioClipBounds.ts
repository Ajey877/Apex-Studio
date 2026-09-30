import { PlaylistClip } from '../types/daw';

export function clampAudioClipStartBar(clip: PlaylistClip, totalBars: number): PlaylistClip {
  const maxStart = Math.max(0, totalBars - clip.lengthBars);
  const startBar = Math.min(Math.max(0, clip.startBar), maxStart);
  return startBar === clip.startBar ? clip : { ...clip, startBar };
}
