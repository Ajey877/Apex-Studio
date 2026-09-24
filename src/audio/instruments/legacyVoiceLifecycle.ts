import type { InstrumentVoiceHandle } from '../instrumentRegistry';

export const createLegacyVoiceHandle = (
  sources: AudioScheduledSourceNode[],
  onEnded?: () => void,
): InstrumentVoiceHandle => {
  let stopped = false;
  let completed = false;
  let remaining = sources.length;

  const complete = () => {
    if (completed) return;
    completed = true;
    onEnded?.();
  };

  if (remaining === 0) {
    complete();
  } else {
    for (const source of sources) {
      source.onended = () => {
        if (remaining > 0) remaining -= 1;
        if (remaining === 0) complete();
      };
    }
  }

  return {
    stop: (time?: number) => {
      if (stopped) return;
      stopped = true;
      for (const source of sources) {
        try {
          source.stop(time);
        } catch {
          // A source that has already stopped is safe to ignore.
        }
      }
    },
  };
};
