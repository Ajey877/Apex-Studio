import type { Channel, InstrumentType, Note } from '../types/daw';

export interface InstrumentVoiceContext {
  channel: Channel;
  note: Note;
  time: number;
  destination: AudioNode;
  /** The active live or OfflineAudioContext used for this render. */
  audioContext: BaseAudioContext;
  voiceId: string;
}

export type InstrumentVoiceRenderer = (context: InstrumentVoiceContext) => void;

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
