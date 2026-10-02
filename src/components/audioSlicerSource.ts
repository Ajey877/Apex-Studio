import type { Channel } from '../types/daw';

/**
 * Phase 52 — Audio Slicer source resolution.
 *
 * The slicer modal used to synthesize a drum break with `Math.sin` and
 * `Math.random()` whenever the target channel had no loaded sample, then draw
 * that buffer as the channel's waveform and report "N slices detected" and
 * "Successfully mapped N chops". Every one of those numbers described audio
 * that does not exist in the user's project.
 *
 * There is now exactly one source of truth for what the slicer is allowed to
 * operate on: a real, already-loaded sample buffer. When there isn't one the
 * slicer resolves to an explicit unavailable state and reports nothing.
 */

export type SlicerAudioSource =
  /** A real decoded sample buffer belonging to the target channel. */
  | { kind: 'sample'; buffer: AudioBuffer; sampleId: string }
  /** There is no target channel to slice. */
  | { kind: 'no-channel' }
  /** The channel has no sample assigned to it. */
  | { kind: 'no-sample'; channelName: string }
  /**
   * The channel names a sample id, but that audio is not loaded in this
   * session (missing/unavailable asset). This is the same distinction the rest
   * of the app makes with `audioUnavailable`, and it must never be filled in
   * with generated audio.
   */
  | { kind: 'buffer-missing'; channelName: string; sampleId: string };

export const resolveSlicerAudioSource = (
  channel: Channel | undefined,
  getSampleBuffer: (id: string) => AudioBuffer | undefined
): SlicerAudioSource => {
  if (!channel) return { kind: 'no-channel' };

  const sampleId = channel.customSample?.id;
  if (!sampleId) return { kind: 'no-sample', channelName: channel.name };

  const buffer = getSampleBuffer(sampleId);
  if (!buffer) return { kind: 'buffer-missing', channelName: channel.name, sampleId };

  return { kind: 'sample', buffer, sampleId };
};

export const isSlicerSourceReady = (
  source: SlicerAudioSource
): source is { kind: 'sample'; buffer: AudioBuffer; sampleId: string } => source.kind === 'sample';

/**
 * The message shown instead of a waveform when there is nothing real to slice.
 * Returned by the module so tests assert the exact string a user reads.
 */
export const slicerSourceMessage = (source: SlicerAudioSource): string => {
  switch (source.kind) {
    case 'no-channel':
      return 'Add or select a channel with a loaded sample to use the slicer.';
    case 'no-sample':
      return `"${source.channelName}" has no sample assigned. Load or import a sample into this channel to slice it.`;
    case 'buffer-missing':
      return `The audio for "${source.channelName}" is not loaded in this session, so there is nothing to slice. Re-import the sample to restore it.`;
    case 'sample':
      return '';
  }
};
