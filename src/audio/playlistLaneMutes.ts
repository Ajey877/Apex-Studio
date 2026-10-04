import type { PlaylistClip, PlaylistTrack } from '../types/daw';

/**
 * Phase 64 — Playlist lane mute semantics, in one place.
 *
 * The live scheduler (`AudioEngine.isPlaylistLaneMuted`), the offline renderer
 * and the MIDI export must all drop exactly the same clips when a lane is muted
 * or soled away. Lane rows are array indices — the same coordinate space as
 * `PlaylistClip.trackIndex` — and clips whose row is missing from the collection
 * are never muted.
 */

/** Lane rows muted in project state; empty when the project has no lane data. */
export function derivePlaylistLaneMutes(tracks?: PlaylistTrack[]): Set<number> {
  const mutes = new Set<number>();
  if (!Array.isArray(tracks)) return mutes;
  tracks.forEach((track, index) => {
    if (track && track.mute === true) mutes.add(index);
  });
  return mutes;
}

/** A clip is lane-muted when its playlist row is muted. Mirrors the trigger boundary. */
export function isClipLaneMuted(
  clip: Pick<PlaylistClip, 'trackIndex'>,
  laneMutes: Set<number>
): boolean {
  if (laneMutes.size === 0) return false;
  if (!Number.isFinite(clip.trackIndex)) return false;
  return laneMutes.has(Math.floor(clip.trackIndex));
}
