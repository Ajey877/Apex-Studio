import type { Channel, CustomSampleData, PlaylistClip, ProjectState } from '../types/daw';

/**
 * Phase 8C — missing audio visibility (P1-11: "Missing audio invisible / startup only warns").
 *
 * Project hydration already knows which persisted audio assets could not be
 * restored: playlist audio clips are flagged through `PlaylistClip.audioUnavailable`
 * and channel samples through `CustomSampleData.audioUnavailable`. Until now that
 * knowledge was only reachable from the developer console (a `console.warn` at
 * startup) and became a user-visible surprise at export time.
 *
 * These helpers are the single source of truth for the user-visible
 * "this audio is missing" state:
 * - the playlist marks the affected clips,
 * - the sample loader marks the affected samples,
 * - the app-wide banner summarises every affected asset.
 *
 * Nothing here fabricates, substitutes or synthesises audio: a missing asset is
 * described, never hidden and never faked.
 */

export const MISSING_AUDIO_CLIP_BADGE_LABEL = 'MISSING AUDIO';
export const MISSING_AUDIO_SAMPLE_BADGE_LABEL = 'SAMPLE MISSING';

/** True only for audio clips whose persisted asset could not be restored. */
export const isPlaylistClipAudioUnavailable = (
  clip: Pick<PlaylistClip, 'type' | 'audioUnavailable'>
): boolean => clip.type === 'audio' && clip.audioUnavailable === true;

/** True only for samples whose persisted asset could not be restored. */
export const isSampleAudioUnavailable = (
  sample?: Pick<CustomSampleData, 'audioUnavailable'> | null
): boolean => sample?.audioUnavailable === true;

export const isChannelSampleAudioUnavailable = (
  channel: Pick<Channel, 'customSample'>
): boolean => isSampleAudioUnavailable(channel.customSample);

export const getPlaylistClipAudioLabel = (clip: PlaylistClip): string =>
  clip.name || clip.audioName || clip.id;

/** User-facing explanation for one unavailable playlist clip (also used as its tooltip/aria-label). */
export const describeMissingAudioClip = (clip: PlaylistClip): string => {
  const label = getPlaylistClipAudioLabel(clip);
  const asset = clip.audioBufferId ? ` (audio asset ID: ${clip.audioBufferId})` : '';
  return `Audio unavailable for clip "${label}"${asset}: the saved audio could not be restored from local storage, so this clip plays nothing. Export is blocked until you re-import the file by dropping it on the playlist again, or delete this clip.`;
};

/** User-facing explanation for one unavailable sample (also used as its tooltip/aria-label). */
export const describeMissingAudioSample = (sample: CustomSampleData, channelName?: string): string => {
  const label = sample.name || sample.id;
  const channel = channelName ? ` on channel "${channelName}"` : '';
  return `Sample "${label}"${channel} (audio asset ID: ${sample.id}) is unavailable: the saved audio could not be restored from local storage, so this channel falls back to its instrument instead of the sample. Re-import the file in the sample loader to replace it.`;
};

export interface MissingAudioClipEntry {
  clipId: string;
  name: string;
  audioBufferId?: string;
}

export interface MissingAudioSampleEntry {
  channelId: string;
  channelName: string;
  sampleId: string;
  sampleName: string;
}

export interface MissingAudioAssetsSummary {
  clips: MissingAudioClipEntry[];
  samples: MissingAudioSampleEntry[];
  totalCount: number;
  /** One description per affected asset, in project order. */
  messages: string[];
}

export const summarizeMissingAudioAssets = (
  clips: readonly PlaylistClip[],
  channels: readonly Channel[]
): MissingAudioAssetsSummary => {
  const missingClips = clips.filter(isPlaylistClipAudioUnavailable);
  const missingSamples = channels.filter(isChannelSampleAudioUnavailable);

  const messages = [
    ...missingClips.map(describeMissingAudioClip),
    ...missingSamples.map(channel => describeMissingAudioSample(channel.customSample as CustomSampleData, channel.name))
  ];

  return {
    clips: missingClips.map(clip => ({
      clipId: clip.id,
      name: getPlaylistClipAudioLabel(clip),
      audioBufferId: clip.audioBufferId
    })),
    samples: missingSamples.map(channel => {
      const sample = channel.customSample as CustomSampleData;
      return {
        channelId: channel.id,
        channelName: channel.name,
        sampleId: sample.id,
        sampleName: sample.name || sample.id
      };
    }),
    totalCount: missingClips.length + missingSamples.length,
    messages
  };
};

/** Every missing audio asset referenced by the current project state. */
export const collectMissingAudioAssets = (
  state: Pick<ProjectState, 'playlistClips' | 'channels'>
): MissingAudioAssetsSummary =>
  summarizeMissingAudioAssets(state.playlistClips ?? [], state.channels ?? []);

/**
 * Stable identity for the currently missing asset set, so a dismissed banner
 * reappears when the set actually changes instead of being permanently hidden.
 */
export const getMissingAudioAssetsSignature = (summary: MissingAudioAssetsSummary): string => [
  ...summary.clips.map(clip => `clip:${clip.clipId}`),
  ...summary.samples.map(sample => `sample:${sample.channelId}:${sample.sampleId}`)
].join('|');

/** One accurate sentence describing every missing asset; empty string when nothing is missing. */
export const describeMissingAudioAssets = (summary: MissingAudioAssetsSummary): string => {
  if (summary.totalCount === 0) return '';

  const parts: string[] = [];
  if (summary.clips.length > 0) {
    parts.push(`${summary.clips.length} playlist audio clip${summary.clips.length === 1 ? '' : 's'} (${summary.clips.map(clip => clip.name).join(', ')})`);
  }
  if (summary.samples.length > 0) {
    parts.push(`${summary.samples.length} sample${summary.samples.length === 1 ? '' : 's'} (${summary.samples.map(sample => sample.sampleName).join(', ')})`);
  }

  const assetWord = summary.totalCount === 1 ? 'audio asset' : 'audio assets';
  const instructions = summary.clips.length > 0
    ? ' Playback is silent for those clips and export stays blocked until you re-import the audio or remove the affected clips.'
    : ' Re-import the affected files in the sample loader to replace the missing samples.';

  return `${summary.totalCount} ${assetWord} could not be restored from local storage: ${parts.join(' and ')}.${instructions}`;
};
