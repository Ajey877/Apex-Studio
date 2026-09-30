import type { PlaylistClip } from '../types/daw';

/**
 * Phase 48 — audio clip publication invariant.
 *
 * Every consumer downstream of project state treats `audioBufferId` as
 * mandatory for a `type: 'audio'` playlist clip:
 *
 *   - `AudioEngine.playAudioClipWithFades()` returns without a buffer, so the
 *     clip is silent;
 *   - the Phase 8C missing-audio surfaces key off `audioUnavailable === true`,
 *     so an audioless clip is never flagged;
 *   - `AudioEngine.renderTimelineOffline()` throws, which blocks WAV *and*
 *     stem export for the whole project (Phase 8B, deliberately).
 *
 * Before this module existed nothing enforced that invariant on the way in, so
 * a UI could publish an audio clip that looked healthy (it can carry a
 * decorative `audioWaveform`), played nothing, silently survived save/reload,
 * and deadlocked export.
 *
 * This module is the single, pure statement of the rule. It is intentionally
 * dependency-light: it imports only the clip type and validates nothing beyond
 * the audio-asset requirement.
 */

/**
 * True when a clip may enter project state.
 *
 * Only `type: 'audio'` carries an extra requirement: a non-empty string
 * `audioBufferId`. Pattern and automation clips are always publishable, and an
 * audio clip that merely *lost* its asset (`audioUnavailable: true`, set by
 * hydration) still has a real id and stays publishable — Phase 8C already
 * surfaces that case.
 */
export const isPublishablePlaylistClip = (clip: PlaylistClip): boolean => {
  if (clip.type !== 'audio') return true;
  return typeof clip.audioBufferId === 'string' && clip.audioBufferId.trim().length > 0;
};

export interface PlaylistClipIntegrityPartition {
  /** Clips that satisfy the invariant, in incoming order, by identity. */
  publishable: PlaylistClip[];
  /** Audio clips that violate it, in incoming order, by identity. */
  rejected: PlaylistClip[];
}

/** Splits an incoming clip collection without reordering or copying its clips. */
export const partitionUnpublishableAudioClips = (
  clips: readonly PlaylistClip[],
): PlaylistClipIntegrityPartition => {
  const publishable: PlaylistClip[] = [];
  const rejected: PlaylistClip[] = [];
  for (const clip of clips) {
    if (isPublishablePlaylistClip(clip)) publishable.push(clip);
    else rejected.push(clip);
  }
  return { publishable, rejected };
};

/** Identity-preserving equality of two clip sequences. */
const isSameClipSequence = (
  left: readonly PlaylistClip[],
  right: readonly PlaylistClip[],
): boolean =>
  left.length === right.length && left.every((clip, index) => clip === right[index]);

export interface PlaylistClipPublicationDecision {
  /** Clips safe to publish, in incoming order. */
  publishable: PlaylistClip[];
  /** Audio clips refused by the invariant. */
  rejected: PlaylistClip[];
  /**
   * False only when a rejection left nothing that differs from the live
   * playlist, so the caller skips publication instead of recording a no-op
   * history entry and autosave. A batch with no rejections always publishes,
   * exactly as it did before this gate existed.
   */
  shouldPublish: boolean;
}

/**
 * Decides what an incoming `onUpdateClips` payload may publish.
 *
 * `currentClips` is the live project playlist; `incomingClips` is whatever a
 * producer handed over. Valid clips are never dropped, so a legitimate
 * drag-drop travelling in the same array as an invalid clip still lands.
 *
 * A payload with no violations is handed straight back by identity, so every
 * valid update behaves exactly as it did before this gate existed — including
 * the array-identity comparisons the additive-import merge relies on.
 */
export const resolvePlaylistClipPublication = (
  currentClips: readonly PlaylistClip[],
  incomingClips: PlaylistClip[],
): PlaylistClipPublicationDecision => {
  const { publishable, rejected } = partitionUnpublishableAudioClips(incomingClips);
  if (rejected.length === 0) {
    return { publishable: incomingClips, rejected, shouldPublish: true };
  }
  return { publishable, rejected, shouldPublish: !isSameClipSequence(currentClips, publishable) };
};

const describeRejectedClip = (clip: PlaylistClip): string => {
  const label = clip.name || clip.audioName || clip.id;
  return `"${label}" has no audio asset`;
};

/**
 * User-facing explanation for refused clips, routed through the existing
 * save-error banner. It states what was refused and the three supported ways
 * to get real audio onto the playlist.
 */
export const describeRejectedPlaylistAudioClips = (rejected: readonly PlaylistClip[]): string => {
  const labels = rejected.map(describeRejectedClip).join(', ');
  const noun = rejected.length === 1 ? 'Audio clip' : 'Audio clips';
  return (
    `${noun} ${labels} and was not added to the playlist. An audio clip without audio cannot play ` +
    'and blocks WAV and stem export. Drop an audio file on the playlist, record a take, or bounce a channel instead.'
  );
};

/**
 * Legacy recovery: flags every audio clip that has no usable `audioBufferId`
 * as `audioUnavailable`, routing already-persisted invalid clips into the
 * existing Phase 8C surfaces (red clip badge, app-wide banner, and the
 * "delete this clip" remediation text) instead of leaving them invisible.
 *
 * Clips are never deleted and no buffer id is invented. Returns the input
 * array itself when nothing needs flagging, so normalizing an already-clean
 * project does not churn object identity.
 */
export const markAudioClipsMissingBufferId = <T extends PlaylistClip>(clips: T[]): T[] => {
  let changed = false;
  const flagged = clips.map(clip => {
    if (isPublishablePlaylistClip(clip) || clip.audioUnavailable === true) return clip;
    changed = true;
    return { ...clip, audioUnavailable: true };
  });
  return changed ? flagged : clips;
};
