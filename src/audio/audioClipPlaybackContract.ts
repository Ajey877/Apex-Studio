import type { PlaylistClip } from '../types/daw';

export const AUDIO_CLIP_STEPS_PER_BAR = 16;
export const MIN_AUDIO_CLIP_RATE = 0.5;
export const MAX_AUDIO_CLIP_RATE = 2;
export const MIN_AUDIO_CLIP_PITCH = -24;
export const MAX_AUDIO_CLIP_PITCH = 24;

export interface AudioClipPlaybackContract {
  startSeconds: number;
  clipDurationSeconds: number;
  sourceOffsetSeconds: number;
  sourceDurationSeconds: number;
  playbackRate: number;
  pitchShiftSemitones: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  fadeOutStartSeconds: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function getAudioClipPlaybackContract(
  clip: PlaylistClip,
  bpm: number,
  bufferDuration: number
): AudioClipPlaybackContract | null {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const secondsPerBeat = 60 / safeBpm;
  const secondsPerBar = secondsPerBeat * 4;
  const startSeconds = Math.max(0, clip.startBar * secondsPerBar);
  const clipDurationSeconds = Math.max(0, clip.lengthBars * secondsPerBar);
  const sourceOffsetSeconds = Math.max(0, clip.offsetSteps ?? 0) * (secondsPerBeat / 4);
  const playbackRate = clamp(clip.timeStretchRate ?? 1, MIN_AUDIO_CLIP_RATE, MAX_AUDIO_CLIP_RATE);
  const pitchShiftSemitones = clamp(clip.pitchShiftSemitones ?? 0, MIN_AUDIO_CLIP_PITCH, MAX_AUDIO_CLIP_PITCH);
  const fadeInSeconds = Math.min(clipDurationSeconds, clamp(clip.fadeInBars ?? 0, 0, 1) * secondsPerBar);
  const fadeOutSeconds = Math.min(clipDurationSeconds, clamp(clip.fadeOutBars ?? 0, 0, 1) * secondsPerBar);
  const fadeOutStartSeconds = Math.max(fadeInSeconds, clipDurationSeconds - fadeOutSeconds);
  const availableSourceDuration = Math.max(0, bufferDuration - sourceOffsetSeconds);
  const sourceDurationSeconds = Math.min(availableSourceDuration, clipDurationSeconds * playbackRate);

  if (clipDurationSeconds <= 0 || sourceOffsetSeconds >= bufferDuration || sourceDurationSeconds <= 0) return null;

  return {
    startSeconds,
    clipDurationSeconds,
    sourceOffsetSeconds,
    sourceDurationSeconds,
    playbackRate,
    pitchShiftSemitones,
    fadeInSeconds,
    fadeOutSeconds,
    fadeOutStartSeconds,
  };
}

export function shouldSkipAudioClip(clip: PlaylistClip, channelMuted = false): boolean {
  return clip.type !== 'audio' || !!clip.mute || channelMuted;
}
