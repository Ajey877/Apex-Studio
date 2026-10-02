import type { PlaylistClip } from '../types/daw';

/**
 * Phase 52 — Warp target resolution.
 *
 * Before this module existed, App handed the Warp processor
 * `projectState.playlistClips[0] || null`: whichever clip happened to be first
 * in the array, regardless of which clip the user had selected in the Playlist
 * Arranger. With more than one clip on the timeline the tool silently edited
 * the wrong one, and with zero clips it still rendered a full control surface
 * and reported success.
 *
 * Resolution is a pure function so the target choice can be pinned by tests
 * without rendering React, and so the modal can render an explicit state for
 * every non-actionable case instead of inventing a target.
 *
 * Only `audio` clips are actionable: `pitchShiftSemitones` and
 * `timeStretchRate` are consumed by the engine's audio-clip source
 * (`playAudioClipWithFades`). Pattern and automation clips carry the same
 * optional fields but nothing reads them, so offering to warp one would be a
 * promise the engine does not keep.
 */

export type WarpTargetResolution =
  /** An audio clip the engine will actually warp. */
  | { kind: 'ready'; clip: PlaylistClip }
  /** Nothing is selected — the user has not clicked a clip. */
  | { kind: 'no-selection' }
  /** A clip id is selected but is not in the project (stale selection). */
  | { kind: 'missing'; clipId: string }
  /** The selected clip is a pattern/automation clip; the engine ignores warp fields on it. */
  | { kind: 'unsupported-type'; clip: PlaylistClip };

export const resolveWarpTarget = (
  clips: readonly PlaylistClip[],
  selectedClipId: string | null | undefined
): WarpTargetResolution => {
  if (!selectedClipId) return { kind: 'no-selection' };

  const clip = clips.find(candidate => candidate.id === selectedClipId);
  if (!clip) return { kind: 'missing', clipId: selectedClipId };
  if (clip.type !== 'audio') return { kind: 'unsupported-type', clip };

  return { kind: 'ready', clip };
};

export const isWarpTargetReady = (
  resolution: WarpTargetResolution
): resolution is { kind: 'ready'; clip: PlaylistClip } => resolution.kind === 'ready';

/**
 * The user-facing explanation for a non-actionable target. Returned by the
 * module (not written inline in JSX) so the regression tests assert the exact
 * string a user reads.
 */
export const warpTargetMessage = (resolution: WarpTargetResolution): string => {
  switch (resolution.kind) {
    case 'no-selection':
      return 'Select an audio clip in the Playlist Arranger first — this tool edits the clip you select, not a default one.';
    case 'missing':
      return 'The selected clip is no longer in the project. Select an audio clip in the Playlist Arranger.';
    case 'unsupported-type':
      return `"${resolution.clip.name}" is a ${resolution.clip.type} clip. Pitch and playback-rate warping is applied to audio clips only — pattern and automation clips are unaffected by these controls.`;
    case 'ready':
      return '';
  }
};

/**
 * What the Warp processor actually does to an audio clip. Stated here so the
 * modal, the transport tooltip and the regression tests all agree on one
 * description instead of paraphrasing it in three places.
 */
export const WARP_BEHAVIOUR_SUMMARY =
  'Pitch and playback-rate adjustment on the selected audio clip (resampler-style repitch). ' +
  'Pitch and speed move together, as on a tape or sampler.';
