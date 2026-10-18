/**
 * Archive path for one project audio asset. The asset id stays in the bundle
 * manifest; this path is only its ZIP storage key.
 */
export const buildBundleAudioAssetPath = (audioId: string, assetIndex: number): string => {
  const filePart = audioId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'audio';
  return `audio/${assetIndex + 1}_${filePart}.bin`;
};
