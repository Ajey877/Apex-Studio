import type { Channel, InstrumentType, Note } from '../types/daw';

export interface InstrumentVoiceContext {
  channel: Channel;
  note: Note;
  time: number;
  destination: AudioNode;
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

  // The fallback is deliberately not inserted under every instrument type.
  // This keeps the registry extensible: unknown/new instrument types can use
  // the same safe fallback without pretending they have a dedicated renderer.
  return {
    get: (instrumentType: InstrumentType) => registry.get(instrumentType) ?? fallback,
    has: (instrumentType: InstrumentType) => registry.has(instrumentType),
  };

};
