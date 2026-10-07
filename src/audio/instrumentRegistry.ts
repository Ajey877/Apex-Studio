import type { Channel, InstrumentType, Note } from '../types/daw';

export interface InstrumentVoiceContext {
  channel: Channel;
  note: Note;
  time: number;
  destination: AudioNode;
  /** The active live or OfflineAudioContext used for this render. */
  audioContext: BaseAudioContext;
  voiceId: string;
  /**
   * The authoritative project/transport tempo for this render, in BPM.
   *
   * Phase 1B: required so a renderer can turn `Note.duration` (sixteenth-note
   * steps) into a gate in seconds. Renderers must never guess, default or
   * hard-code a tempo — the scheduling path already resolved it, and live and
   * offline renders both receive the same value, which is what keeps an export
   * gate identical to the gate the user monitored.
   */
  bpm: number;
  /** True when `destination` already applies channel-level panning (`Channel.pan`). */
  channelPanApplied?: boolean;
  /** Called by a standalone renderer when its scheduled voice naturally completes. */
  onEnded?: () => void;
  /** Narrow lookup into AudioEngine's in-memory sample buffer cache. */
  getSampleBuffer?: (id: string) => AudioBuffer | undefined;
}

export interface InstrumentVoiceHandle {
  stop: (time?: number) => void;
}

export type InstrumentVoiceRenderer = (context: InstrumentVoiceContext) => InstrumentVoiceHandle | void;

export interface InstrumentRegistry {
  get(instrumentType: InstrumentType): InstrumentVoiceRenderer;
  has(instrumentType: InstrumentType): boolean;
}

export const createInstrumentRegistry = (
  renderers: Partial<Record<InstrumentType, InstrumentVoiceRenderer>>,
  fallback: InstrumentVoiceRenderer,
): InstrumentRegistry => {
  const registry = new Map<InstrumentType, InstrumentVoiceRenderer>();

  for (const [instrumentType, renderer] of Object.entries(renderers)) {
    if (renderer) {
      registry.set(instrumentType as InstrumentType, renderer);
    }
  }

  return {
    get: (instrumentType: InstrumentType) => registry.get(instrumentType) ?? fallback,
    has: (instrumentType: InstrumentType) => registry.has(instrumentType),
  };
};
