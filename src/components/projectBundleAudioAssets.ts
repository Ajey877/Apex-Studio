import { buildBundleAudioAssetPath } from './projectBundleAudioPath';

export type BundleAudioAssetFailure = 'missing' | 'unreadable';

export class BundleAudioAssetError extends Error {
  readonly audioId: string;

  constructor(audioId: string, failure: BundleAudioAssetFailure) {
    const reason = failure === 'missing'
      ? 'is missing or empty'
      : 'could not be read from local storage';
    super(
      `Cannot export a complete bundle: audio asset "${audioId}" ${reason}. ` +
      'Make this audio available in the project and try again.'
    );
    this.name = 'BundleAudioAssetError';
    this.audioId = audioId;
  }
}

export interface CollectedBundleAudioAsset {
  id: string;
  path: string;
  mimeType: string;
  size: number;
  blob: Blob;
}

/**
 * Collect every required audio asset before the caller generates a ZIP.
 * A partial collection is never returned: any missing, empty, or unreadable
 * asset aborts the operation with an actionable error.
 */
export const collectBundleAudioAssets = async (
  audioIds: readonly string[],
  readAudio: (audioId: string) => Promise<Blob | null | undefined>
): Promise<CollectedBundleAudioAsset[]> => {
  const assets: CollectedBundleAudioAsset[] = [];

  for (const audioId of audioIds) {
    let blob: Blob | null | undefined;
    try {
      blob = await readAudio(audioId);
    } catch {
      throw new BundleAudioAssetError(audioId, 'unreadable');
    }

    if (!blob || blob.size === 0) {
      throw new BundleAudioAssetError(audioId, 'missing');
    }

    assets.push({
      id: audioId,
      path: buildBundleAudioAssetPath(audioId, assets.length),
      mimeType: blob.type || 'application/octet-stream',
      size: blob.size,
      blob
    });
  }

  return assets;
};
