import { Channel, PlaylistClip } from '../types/daw';

export interface OfflineProjectRendererOptions {
  channels: Channel[];
  clips: PlaylistClip[];
  bpm: number;
  totalBars: number;
  sampleRate?: number;
  getAudioBuffer: (id: string) => AudioBuffer | undefined;
}

export interface OfflineRenderPlanItem {
  clipId: string;
  type: PlaylistClip['type'];
  startSeconds: number;
  durationSeconds: number;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/**
 * Phase 8B — export integrity (P1-4: Placeholder Audio Stem clip breaks export).
 *
 * An audio clip whose asset cannot be resolved (placeholder/never-registered
 * buffer id, missing audioBufferId, or a clip hydration marked as
 * `audioUnavailable` because its persisted audio is gone) must never be
 * silently skipped: that produced a "successful" WAV containing silence where
 * the clip's audio belonged. These helpers let every offline render path fail
 * safely with a descriptive error *before* any audio is rendered or encoded.
 */
export const isAudioClipExportable = (
  clip: PlaylistClip,
  resolveBuffer: (id: string) => AudioBuffer | undefined
): boolean => {
  if (clip.type !== 'audio' || clip.mute) return true;
  if (!clip.audioBufferId) return false;
  if (clip.audioUnavailable) return false;
  return Boolean(resolveBuffer(clip.audioBufferId));
};

const describeUnexportableClip = (
  clip: PlaylistClip,
  resolveBuffer: (id: string) => AudioBuffer | undefined
): string => {
  const label = clip.name || clip.audioName || clip.id;
  if (!clip.audioBufferId) {
    return `Audio clip "${label}" is missing an audioBufferId.`;
  }
  if (clip.audioUnavailable) {
    return `Audio clip "${label}" (buffer ID: ${clip.audioBufferId}) references an unavailable audio asset; its persisted audio could not be restored.`;
  }
  if (!resolveBuffer(clip.audioBufferId)) {
    return `Missing audio buffer for clip "${label}" (buffer ID: ${clip.audioBufferId}). The audio asset is not loaded in memory.`;
  }
  return `Audio clip "${label}" cannot be exported.`;
};

/**
 * Throws when any unmuted audio clip in the timeline references an audio
 * asset that cannot be resolved, so callers never render a misleading
 * partial/silent export. Muted clips are skipped (they render nothing).
 */
export const assertAudioClipsExportable = (
  clips: PlaylistClip[],
  resolveBuffer: (id: string) => AudioBuffer | undefined
): void => {
  const problems = clips.filter(clip => !isAudioClipExportable(clip, resolveBuffer));
  if (problems.length === 0) return;
  const detail = describeUnexportableClip(problems[0], resolveBuffer);
  const suffix = problems.length > 1 ? ` (${problems.length} audio clips cannot be exported)` : '';
  throw new Error(`${detail}${suffix}`);
};

export function getOfflineRenderPlan(clips: PlaylistClip[], bpm: number, totalBars: number): OfflineRenderPlanItem[] {
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const secondsPerBar = (60 / safeBpm) * 4;
  const limit = Math.max(0, totalBars) * secondsPerBar;

  return clips
    .filter(clip => !clip.mute)
    .map(clip => ({
      clipId: clip.id,
      type: clip.type,
      startSeconds: Math.max(0, clip.startBar * secondsPerBar),
      durationSeconds: Math.max(0, clip.lengthBars * secondsPerBar),
    }))
    .filter(item => item.startSeconds < limit && item.durationSeconds > 0)
    .map(item => ({ ...item, durationSeconds: Math.min(item.durationSeconds, limit - item.startSeconds) }));
}

function scheduleAutomation(clip: PlaylistClip, gain: GainNode, panner: StereoPannerNode, start: number, duration: number, channel: Channel) {
  const points = [...(clip.automationPoints ?? [])].sort((a, b) => a.x - b.x);
  if (!points.length || !clip.automationTarget) return;
  const target = clip.automationTarget;
  const matches = String(target.targetId) === String(channel.id) || String(target.targetId) === String(channel.mixerTrackId);
  if (!matches) return;

  if (target.type === 'channel_vol' || target.type === 'mixer_vol') {
    gain.gain.setValueAtTime(clamp(points[0].y, 0, 1) * channel.volume, start);
    for (const point of points.slice(1)) gain.gain.linearRampToValueAtTime(clamp(point.y, 0, 1) * channel.volume, start + clamp(point.x, 0, 1) * duration);
  } else if (target.type === 'channel_pan' || target.type === 'mixer_pan') {
    panner.pan.setValueAtTime(clamp(points[0].y * 2 - 1, -1, 1), start);
    for (const point of points.slice(1)) panner.pan.linearRampToValueAtTime(clamp(point.y * 2 - 1, -1, 1), start + clamp(point.x, 0, 1) * duration);
  }
}

function scheduleFade(gain: GainNode, start: number, duration: number, fadeInBars = 0, fadeOutBars = 0, secondsPerBar: number) {
  const fadeIn = clamp(fadeInBars, 0, 1) * secondsPerBar;
  const fadeOut = clamp(fadeOutBars, 0, 1) * secondsPerBar;
  const inEnd = Math.min(duration, fadeIn);
  const outStart = Math.max(0, duration - fadeOut);
  gain.gain.setValueAtTime(0.0001, start);
  if (inEnd > 0) gain.gain.linearRampToValueAtTime(1, start + inEnd);
  else gain.gain.setValueAtTime(1, start);
  if (fadeOut > 0) {
    gain.gain.setValueAtTime(1, start + outStart);
    gain.gain.linearRampToValueAtTime(0.0001, start + duration);
  }
}

export async function renderProjectTimelineOffline(options: OfflineProjectRendererOptions): Promise<AudioBuffer> {
  // Fail before any rendering starts: a missing/placeholder/unavailable audio
  // asset must reject the export instead of rendering a silent stand-in.
  assertAudioClipsExportable(options.clips, options.getAudioBuffer);

  const safeBpm = Number.isFinite(options.bpm) && options.bpm > 0 ? options.bpm : 120;
  const secondsPerBeat = 60 / safeBpm;
  const secondsPerBar = secondsPerBeat * 4;
  const totalDurationSeconds = Math.max(4, options.totalBars * secondsPerBar);
  const sampleRate = options.sampleRate ?? 44100;
  const offlineCtx = new OfflineAudioContext(2, Math.ceil(sampleRate * totalDurationSeconds), sampleRate);
  const master = offlineCtx.createGain();
  master.gain.value = 1;
  master.connect(offlineCtx.destination);

  for (const clip of options.clips) {
    const start = clip.startBar * secondsPerBar;
    const clipDuration = Math.min(clip.lengthBars * secondsPerBar, totalDurationSeconds - start);
    if (clip.mute || clipDuration <= 0 || start >= totalDurationSeconds) continue;
    const channel = options.channels.find(c => c.id === clip.channelId) ?? options.channels[0];
    if (!channel || channel.mute) continue;

    if (clip.type === 'audio' && clip.audioBufferId) {
      const buffer = options.getAudioBuffer(clip.audioBufferId);
      if (!buffer) continue;
      const source = offlineCtx.createBufferSource();
      source.buffer = buffer;
      const gain = offlineCtx.createGain();
      const panner = offlineCtx.createStereoPanner();
      const rate = clamp(clip.timeStretchRate ?? 1, 0.5, 2);
      source.playbackRate.value = rate;
      source.detune.value = clamp(clip.pitchShiftSemitones ?? 0, -24, 24) * 100;
      const sourceOffset = Math.max(0, (clip.offsetSteps ?? 0) * (secondsPerBeat / 4));
      if (sourceOffset >= buffer.duration) continue;
      const sourceDuration = Math.min(buffer.duration - sourceOffset, clipDuration * rate);
      const baseGain = clamp(channel.volume, 0, 1.25);
      gain.gain.value = baseGain;
      panner.pan.value = clamp(channel.pan, -1, 1);
      scheduleFade(gain, start, clipDuration, clip.fadeInBars, clip.fadeOutBars, secondsPerBar);
      scheduleAutomation(clip, gain, panner, start, clipDuration, channel);
      source.connect(gain);
      gain.connect(panner);
      panner.connect(master);
      source.start(start, sourceOffset, Math.max(0, sourceDuration));
      continue;
    }

    if (clip.type === 'pattern') {
      const gain = offlineCtx.createGain();
      const panner = offlineCtx.createStereoPanner();
      gain.gain.value = clamp(channel.volume, 0, 1.25);
      panner.pan.value = clamp(channel.pan, -1, 1);
      scheduleAutomation(clip, gain, panner, start, clipDuration, channel);
      gain.connect(panner);
      panner.connect(master);
      for (const note of channel.notes ?? []) {
        if (note.muted) continue;
        const noteStart = start + ((note.start - (clip.offsetSteps ?? 0)) * secondsPerBeat / 4);
        const noteDuration = Math.min(note.duration * secondsPerBeat / 4, clipDuration - Math.max(0, noteStart - start));
        if (noteStart < start || noteStart >= totalDurationSeconds || noteDuration <= 0) continue;
        const osc = offlineCtx.createOscillator();
        const noteGain = offlineCtx.createGain();
        osc.type = channel.synthParams?.osc1Type ?? 'sawtooth';
        osc.frequency.value = 440 * Math.pow(2, (note.pitch - 69) / 12);
        noteGain.gain.setValueAtTime(0.0001, noteStart);
        const velocity = clamp(note.velocity ?? 0.8, 0, 1) * gain.gain.value;
        noteGain.gain.linearRampToValueAtTime(velocity, noteStart + 0.005);
        noteGain.gain.exponentialRampToValueAtTime(0.0001, noteStart + noteDuration + 0.05);
        osc.connect(noteGain);
        noteGain.connect(gain);
        osc.start(noteStart);
        osc.stop(noteStart + noteDuration + 0.06);
      }
    }
  }

  return offlineCtx.startRendering();
}
