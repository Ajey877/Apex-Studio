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
 *
 * Phase 49 adds the one distinction the gate was missing: the rule is about
 * invalid *new* clips, not about deleting clips that are already there. A
 * legacy audioless clip that hydration preserved (`audioUnavailable`, no
 * `audioBufferId`) is retained by `resolvePlaylistClipPublication()` instead of
 * being filtered out of the next unrelated playlist publication.
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
   * Phase 49: audio clips that violate the invariant but that the live playlist
   * already carries as unpublishable legacy clips. Hydration preserved them on
   * purpose, so they are published unchanged instead of being deleted by an
   * unrelated edit. These still block export and still need real audio.
   */
  retained: PlaylistClip[];
  /**
   * False only when a rejection (or a retained legacy clip travelling alone)
   * left nothing that differs from the live playlist, so the caller skips
   * publication instead of recording a no-op history entry and autosave. A
   * batch with no violations always publishes, exactly as it did before this
   * gate existed.
   */
  shouldPublish: boolean;
}

/**
 * True when `clip` violates the invariant but the live playlist is already
 * carrying an unpublishable audio clip with the same id.
 *
 * Identity is deliberately not required: the arranger rebuilds the clip object
 * it edits, and an edit of an already-retained legacy clip is still that same
 * legacy clip. The live clip has to violate the invariant itself, so a newly
 * introduced audioless clip can never borrow a healthy clip's id to slip into
 * project state — Phase 48's protection stays intact.
 */
const isAlreadyPresentLegacyAudioClip = (
  currentClips: readonly PlaylistClip[],
  clip: PlaylistClip,
): boolean => {
  if (isPublishablePlaylistClip(clip)) return false;
  if (typeof clip.id !== 'string' || clip.id.length === 0) return false;
  return currentClips.some(
    current => current.id === clip.id && !isPublishablePlaylistClip(current),
  );
};

/**
 * Decides what an incoming `onUpdateClips` payload may publish.
 *
 * `currentClips` is the live project playlist; `incomingClips` is whatever a
 * producer handed over. Valid clips are never dropped, so a legitimate
 * drag-drop travelling in the same array as an invalid clip still lands.
 *
 * Phase 49 — the invariant is about preventing invalid *new* audio clips from
 * entering project state, not about deleting clips that are already there. An
 * unpublishable clip that the live playlist is already carrying (hydration keeps
 * those, flagged `audioUnavailable`) is therefore *retained*, not refused, so an
 * unrelated playlist edit cannot silently delete it. Only genuinely new
 * audioless clips are removed from the publication.
 *
 * A payload with no violations is handed straight back by identity, so every
 * valid update behaves exactly as it did before this gate existed — including
 * the array-identity comparisons the additive-import merge relies on.
 */
export const resolvePlaylistClipPublication = (
  currentClips: readonly PlaylistClip[],
  incomingClips: PlaylistClip[],
): PlaylistClipPublicationDecision => {
  const publishable: PlaylistClip[] = [];
  const rejected: PlaylistClip[] = [];
  const retained: PlaylistClip[] = [];

  for (const clip of incomingClips) {
    if (isPublishablePlaylistClip(clip)) {
      publishable.push(clip);
    } else if (isAlreadyPresentLegacyAudioClip(currentClips, clip)) {
      publishable.push(clip);
      retained.push(clip);
    } else {
      rejected.push(clip);
    }
  }

  if (rejected.length === 0) {
    return {
      publishable: incomingClips,
      rejected,
      retained,
      // A batch with no violations publishes exactly as it did before this gate
      // existed; when the only violations were already-present legacy clips,
      // republishing the unchanged payload would be a no-op.
      shouldPublish: retained.length === 0 || !isSameClipSequence(currentClips, incomingClips),
    };
  }

  return {
    publishable,
    rejected,
    retained,
    shouldPublish: !isSameClipSequence(currentClips, publishable),
  };
};

const describeClipLabel = (clip: PlaylistClip): string =>
  `"${clip.name || clip.audioName || clip.id}"`;

const describeRejectedClip = (clip: PlaylistClip): string =>
  `${describeClipLabel(clip)} has no audio asset`;

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
 * Phase 49 — user-facing explanation for retained legacy clips.
 *
 * These clips were *not* refused: they were already in the playlist, hydration
 * kept them, and the edit that triggered this publication did not change them.
 * The rejection wording ("was not added to the playlist") would be a lie about
 * both what happened and what the clip is, so the retained case gets its own
 * wording: already present, kept, still has no audio, still blocks export.
 */
export const describeRetainedPlaylistAudioClips = (retained: readonly PlaylistClip[]): string => {
  const labels = retained.map(describeClipLabel).join(', ');
  const singular = retained.length === 1;
  const noun = singular ? 'Audio clip' : 'Audio clips';
  const verb = singular ? 'was' : 'were';
  const pronoun = singular ? 'it' : 'they';
  const has = singular ? 'has' : 'have';
  const blocks = singular ? 'blocks' : 'block';
  return (
    `${noun} ${labels} ${verb} already on the playlist and ${verb} retained, but ${pronoun} still ` +
    `${has} no audio asset and still ${blocks} WAV and stem export. Drop an audio file on the ` +
    'playlist, record a take, or bounce a channel instead.'
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
