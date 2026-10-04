import type { Channel, PlaylistClip } from '../types/daw';

/**
 * Phase 64 — which channel a playlist lane's BOUNCE button renders.
 *
 * The button used to pass the lane index straight to `channels[trackIndex]`.
 * That is wrong for every lane whose index does not coincide with its channel:
 * in the shipped factory project the lanes are kick / hi-hat / 808 / pluck while
 * the channel list is kick / snare / hi-hat / 808 / pluck, so lane 2 bounced the
 * snare, lane 3 bounced the hi-hat, lane 4 bounced the 808 — and a lane with no
 * channel at that index fell through to `channels[0]` and bounced the kick.
 *
 * A lane's material is identified by its clips, exactly as playback, the stem
 * renderer and the MIDI export identify it: `PlaylistClip.channelId`. Automation
 * clips carry no channel and are not material. When a lane holds more than one
 * channel (an arrangement can fade one out and another in), the earliest content
 * decides, and the full list is reported so callers can explain the choice.
 */
export type PlaylistBounceTargetStatus = 'ready' | 'empty' | 'no-channel';

export interface PlaylistBounceTarget {
  status: PlaylistBounceTargetStatus;
  /** Channel to render, or `null` when the lane cannot be bounced. */
  channelId: string | null;
  /** Every channel the lane's clips reference, in timeline order. */
  channelIds: string[];
  /** Bar the lane's content starts at; the bounce is anchored here, not at bar 1. */
  startBar: number;
}

const NO_TARGET: PlaylistBounceTarget = { status: 'empty', channelId: null, channelIds: [], startBar: 0 };

export function resolvePlaylistBounceTarget(
  channels: Channel[],
  clips: PlaylistClip[],
  laneIndex: number,
): PlaylistBounceTarget {
  if (!Number.isFinite(laneIndex)) return NO_TARGET;
  const lane = Math.floor(laneIndex);

  const laneClips = (Array.isArray(clips) ? clips : [])
    .filter(clip => clip && Number.isFinite(clip.trackIndex) && Math.floor(clip.trackIndex) === lane)
    .sort((a, b) => (a.startBar ?? 0) - (b.startBar ?? 0));

  if (laneClips.length === 0) return NO_TARGET;

  const channelIds: string[] = [];
  for (const clip of laneClips) {
    if (!clip.channelId) continue;
    if (!channelIds.includes(clip.channelId)) channelIds.push(clip.channelId);
  }

  const firstClipBar = laneClips[0].startBar;
  const startBar = Number.isFinite(firstClipBar) && firstClipBar > 0 ? Math.floor(firstClipBar) : 0;
  if (channelIds.length === 0) return { status: 'no-channel', channelId: null, channelIds: [], startBar };

  const primary = channels.find(channel => channel && channel.id === channelIds[0]);
  if (!primary) return { status: 'no-channel', channelId: null, channelIds, startBar };

  return { status: 'ready', channelId: primary.id, channelIds, startBar };
}
