import type { InstrumentVoiceRenderer } from '../instrumentRegistry';

export const renderDrumPadVoice: InstrumentVoiceRenderer = ({
  channel,
  note,
  time,
  destination,
  audioContext,
  onEnded,
  getSampleBuffer,
}) => {
  const pad = channel.drumPads?.find(
    candidate => candidate.note === note.pitch && candidate.sampleId,
  );
  if (!pad || !getSampleBuffer) return;

  const buffer = getSampleBuffer(pad.sampleId);
  if (!buffer) return;

  const source = audioContext.createBufferSource();
  source.buffer = buffer;

  const playbackRate = Math.pow(
    2,
    Math.max(-24, Math.min(24, pad.tuneSemitones || 0)) / 12,
  );
  source.playbackRate.setValueAtTime(
    pad.reverse ? -playbackRate : playbackRate,
    time,
  );

  const gain = audioContext.createGain();
  const velocity = Math.max(0, Math.min(1, note.velocity ?? 0.8));
  gain.gain.setValueAtTime(
    velocity * Math.max(0, Math.min(1.25, pad.volume)) * channel.volume,
    time,
  );

  const panner = audioContext.createStereoPanner();
  panner.pan.setValueAtTime(
    Math.max(-1, Math.min(1, pad.pan)),
    time,
  );

  source.connect(gain);
  gain.connect(panner);
  panner.connect(destination);

  const startPct = Math.max(0, Math.min(1, pad.trimStart ?? 0));
  const endPct = Math.max(startPct, Math.min(1, pad.trimEnd ?? 1));
  const start = startPct * buffer.duration;
  const end = endPct * buffer.duration;
  const duration = Math.max(0.001, end - start);

  if (pad.loop && end > start) {
    source.loop = true;
    source.loopStart = start;
    source.loopEnd = end;
  }

  source.onended = () => onEnded?.();

  const offset = pad.reverse ? end : start;
  source.start(time, offset, pad.loop ? undefined : duration);

  return {
    stop: (stopTime?: number) => {
      const t = stopTime ?? audioContext.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.02);
      try { source.stop(t + 0.025); } catch (_) {}
    },
  };
};
