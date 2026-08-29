import { audioEngine } from './audioEngine';

const activeBufferSources = new Set<AudioBufferSourceNode>();
let installed = false;

/**
 * Ensures transport stop also stops BufferSource-based audio clips.
 * The existing synth voice registry cannot see playlist BufferSource nodes,
 * so this small lifecycle bridge keeps those nodes under transport control.
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

  const originalStop = audioEngine.stop.bind(audioEngine);
  audioEngine.stop = () => {
    originalStop();
    for (const source of Array.from(activeBufferSources)) {
      try { source.stop(); } catch (_) { /* already inactive */ }
      activeBufferSources.delete(source);
    }
  };
}

export function getActiveBufferSourceCount(): number {
  return activeBufferSources.size;
}

export function stopAllBufferSources(): void {
  for (const source of Array.from(activeBufferSources)) {
    try { source.stop(); } catch (_) { /* already inactive */ }
    activeBufferSources.delete(source);
  }
}
