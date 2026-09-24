import type { InstrumentVoiceRenderer } from '../instrumentRegistry';
import { clampSampleRange, findSampleZone, getSamplePlaybackRate } from '../sampleZones';

export const renderSamplerVoice: InstrumentVoiceRenderer = ({
  channel,
  note,
  time,
  destination,
  audioContext,
  voiceId,
  onEnded,
  getSampleBuffer,
}) => {
  if (!getSampleBuffer) return;

  const zone = findSampleZone(channel.sampleZones, note);
  const sample = channel.customSample;
  const sampleId = zone?.sampleId || sample?.id;
  const buffer = sampleId ? getSampleBuffer(sampleId) : undefined;

  if (!buffer) return;

  const rootPitch = zone?.rootNote ?? sample?.rootPitch ?? 60;
  const tuneSemitones = zone?.tuneSemitones ?? 0;
  const playbackRate = getSamplePlaybackRate(
    note.pitch,
    rootPitch,
    channel.pitch || 0,
    tuneSemitones,
  );
  const reverse = zone?.reverse ?? sample?.reverse ?? false;

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.setValueAtTime(reverse ? -playbackRate : playbackRate, time);

  const gain = audioContext.createGain();
  const velocity = Math.max(0, Math.min(1, note.velocity ?? 0.8));
  gain.gain.setValueAtTime(velocity * channel.volume, time);

  const filter = audioContext.createBiquadFilter();
  filter.type = channel.synthParams?.filterType || 'lowpass';
  filter.frequency.setValueAtTime(channel.synthParams?.filterCutoff || 18000, time);
  filter.Q.value = channel.synthParams?.filterResonance || 1.0;

  source.connect(filter);
  filter.connect(gain);
  gain.connect(destination);

  const { start: trimStartPct, end: trimEndPct } = clampSampleRange(
    zone?.trimStart ?? sample?.trimStart ?? 0,
    zone?.trimEnd ?? sample?.trimEnd ?? 1,
  );
  const trimStart = trimStartPct * buffer.duration;
  const trimEnd = trimEndPct * buffer.duration;
  const duration = Math.max(0.001, trimEnd - trimStart);
  const loop = zone?.loop ?? channel.synthParams?.sampleLoop ?? false;
  const loopStartPct = Math.max(
    trimStartPct,
    Math.min(trimEndPct, zone?.loopStart ?? trimStartPct),
  );
  const loopEndPct = Math.max(
    loopStartPct,
    Math.min(trimEndPct, zone?.loopEnd ?? trimEndPct),
  );

  if (loop && loopEndPct > loopStartPct) {
    source.loop = true;
    source.loopStart = loopStartPct * buffer.duration;
    source.loopEnd = loopEndPct * buffer.duration;
  }

  source.onended = () => onEnded?.();

  const offset = reverse ? trimEnd : trimStart;
  source.start(time, offset, loop ? undefined : duration);

  return {
    stop: (stopTime?: number) => {
      const t = stopTime ?? audioContext.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
      try { source.stop(t + 0.06); } catch (_) {}
    },
  };
};
