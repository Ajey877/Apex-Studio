import { audioEngine } from './audioEngine';
import type { PlaylistClip } from '../types/daw';
import { getAudioClipPlaybackContract, shouldSkipAudioClip } from './audioClipPlaybackContract';

const activeBufferSources = new Set<AudioBufferSourceNode>();
let installed = false;

/**
 * Keeps BufferSource-based playlist audio under transport control and routes
 * playlist clips through the mixer insert selected by their source channel.
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
      if (!ctx || shouldSkipAudioClip(clip)) return;

      const buffer = clip.audioBufferId ? engine.sampleBuffers?.get(clip.audioBufferId) : null;
      if (!buffer) return;

      const channel = clip.channelId
        ? (engine.activeChannels?.find((candidate: { id: string }) => candidate.id === clip.channelId) ?? engine.activeChannels?.[0])
        : engine.activeChannels?.[0];
      if (channel?.mute) return;

      const contract = getAudioClipPlaybackContract(clip, engine.bpm, buffer.duration);
      if (!contract) return;

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.setValueAtTime(contract.playbackRate, startTime);
      source.detune.setValueAtTime(contract.pitchShiftSemitones * 100, startTime);

      const gainNode = ctx.createGain();
      const panner = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
      const channelVolume = typeof channel?.volume === 'number' ? Math.max(0, Math.min(1.25, channel.volume)) : 1;
      const channelPan = typeof channel?.pan === 'number' ? Math.max(-1, Math.min(1, channel.pan)) : 0;
      gainNode.gain.setValueAtTime(channelVolume, startTime);
      if (panner) panner.pan.setValueAtTime(channelPan, startTime);

      if (contract.fadeInSeconds > 0) {
        gainNode.gain.setValueAtTime(0.0001, startTime);
        gainNode.gain.exponentialRampToValueAtTime(channelVolume, startTime + contract.fadeInSeconds);
      }
      if (contract.fadeOutSeconds > 0) {
        gainNode.gain.setValueAtTime(channelVolume, startTime + contract.fadeOutStartSeconds);
        gainNode.gain.exponentialRampToValueAtTime(0.0001, startTime + contract.clipDurationSeconds);
      }

      const mixerTrackId = typeof channel?.mixerTrackId === 'number'
        ? channel.mixerTrackId
        : Math.max(1, Math.floor(clip.trackIndex) + 1);
      const mixer = engine.getOrCreateMixerChannel(mixerTrackId);
      source.connect(gainNode);
      if (panner) {
        gainNode.connect(panner);
        panner.connect(mixer.input);
      } else {
        gainNode.connect(mixer.input);
      }

      source.start(startTime, contract.sourceOffsetSeconds, contract.sourceDurationSeconds);
      source.stop(startTime + contract.clipDurationSeconds);
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
