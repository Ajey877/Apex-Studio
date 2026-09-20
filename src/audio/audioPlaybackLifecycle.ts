import { audioEngine } from './audioEngine';

interface PlaybackLifecycleEngine {
  stop: () => void;
  ctx: AudioContext | null;
}

const activeBufferSources = new Set<AudioBufferSourceNode>();
let installed = false;

/**
 * Keeps BufferSource-based playlist audio under transport control.
 *
 * Clip scheduling, fade envelopes, seek offsets and mixer routing live in
 * `audioEngine.playAudioClipWithFades` — the single production implementation.
 * This module tracks every buffer source created by the context so an engine
 * stop can cancel whatever the take scheduled, and exposes the live source
 * count for diagnostics. The engine additionally cancels its own take's clip
 * sources on pause, seek and song end.
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

  // Minimal type-safe internal access interface to engine runtime properties without architectural rewrite.
  const engine = audioEngine as unknown as PlaybackLifecycleEngine;
  const originalStop = engine.stop.bind(audioEngine);
  engine.stop = () => {
    originalStop();
    stopAllBufferSources();
  };
}

export function getActiveBufferSourceCount(): number { return activeBufferSources.size; }

export function stopAllBufferSources(): void {
  for (const source of Array.from(activeBufferSources)) {
    try { source.stop(); } catch (_) { /* already inactive */ }
    activeBufferSources.delete(source);
  }
}
