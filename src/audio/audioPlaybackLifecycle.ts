import { audioEngine } from './audioEngine';
import type { PlaylistClip } from '../types/daw';

const activeBufferSources = new Set<AudioBufferSourceNode>();
let installed = false;

/**
 * Keeps BufferSource-based playlist audio under transport control and routes
 * playlist clips through the mixer insert selected by their playlist lane.
 */
export function installAudioPlaybackLifecycle(): void {
  if (installed || typeof window === 'undefined' || typeof AudioContext === 'undefined') return;
  installed = true;

  const contextPrototype = AudioContext.prototype;
  const originalCreateBufferSource = contextPrototype.createBufferSource;
  contextPrototype.createBufferSource = function (...args: Parameters<AudioContext['createBufferSource']>) {
    const source = originalCreateBufferSource.apply(this, args);
    activeBufferSources.add(source);
    source.addEventListener('ended', () => activeBufferSources.delete(source), { once: true });
    return source;
  };

  const engine = audioEngine as any;
  const originalStop = engine.stop.bind(audioEngine);
  engine.stop = () => {
    originalStop();
    stopAllBufferSources();
  };

  const originalClipPlayback = engine.playAudioClipWithFades?.bind(audioEngine);
  if (typeof originalClipPlayback === 'function') {
    engine.playAudioClipWithFades = (clip: PlaylistClip, startTime: number) => {
      const ctx = engine.ctx as AudioContext | null;
      if (!ctx) return;
      const buffer = clip.audioBufferId ? engine.sampleBuffers?.get(clip.audioBufferId) : null;
      if (!buffer) return;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      if (typeof clip.pitchShiftSemitones === 'number') source.detune.setValueAtTime(clip.pitchShiftSemitones * 100, startTime);
      if (typeof clip.timeStretchRate === 'number' && clip.timeStretchRate > 0) source.playbackRate.setValueAtTime(clip.timeStretchRate, startTime);

      // Playlist lane 0 maps to mixer insert 1; master remains mixer track 0.
      const mixerTrackId = Math.max(1, Math.floor(clip.trackIndex) + 1);
      const mixer = engine.getOrCreateMixerChannel(mixerTrackId);
      const gainNode = ctx.createGain();
      const bpm = Math.max(20, Number(engine.bpm) || 120);
      const secondsPerBar = 240 / bpm;
      const clipDurationSec = Math.max(0.005, clip.lengthBars * secondsPerBar);
      const fadeInSec = Math.min(clipDurationSec, Math.max(0.005, (clip.fadeInBars || 0) * secondsPerBar));
      const fadeOutSec = Math.min(clipDurationSec, Math.max(0.005, (clip.fadeOutBars || 0) * secondsPerBar));
      const fadeOutStart = Math.max(startTime + fadeInSec, startTime + clipDurationSec - fadeOutSec);

      gainNode.gain.setValueAtTime(0.0001, startTime);
      gainNode.gain.exponentialRampToValueAtTime(1.0, startTime + fadeInSec);
      gainNode.gain.setValueAtTime(1.0, fadeOutStart);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + clipDurationSec);
      source.connect(gainNode);
      gainNode.connect(mixer.input);
      source.start(startTime);
      source.stop(startTime + clipDurationSec);
    };
  }
}

export function getActiveBufferSourceCount(): number { return activeBufferSources.size; }

export function stopAllBufferSources(): void {
  for (const source of Array.from(activeBufferSources)) {
    try { source.stop(); } catch (_) { /* already inactive */ }
    activeBufferSources.delete(source);
  }
}
