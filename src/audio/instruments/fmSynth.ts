import type { InstrumentVoiceRenderer } from '../instrumentRegistry';

const midiToFrequency = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

export const renderFmSynthVoice: InstrumentVoiceRenderer = ({
  channel,
  note,
  time,
  destination,
  audioContext,
  onEnded,
}) => {
  const ctx = audioContext;
  const p = channel.synthParams;
  const carrierFreq = midiToFrequency(note.pitch + channel.pitch);
  const modFreq = carrierFreq * (p.fmModulatorMultiplier || 2.0);
  const modIndex = (p.fmModulationIndex || 150) * (note.velocity || 0.8);

  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.setValueAtTime(carrierFreq, time);

  const modulator = ctx.createOscillator();
  modulator.type = 'sine';
  modulator.frequency.setValueAtTime(modFreq, time);

  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(modIndex, time);
  modGain.gain.exponentialRampToValueAtTime(0.001, time + (p.decay || 0.4));

  modulator.connect(modGain);
  modGain.connect(carrier.frequency);

  const ampGain = ctx.createGain();
  const vel = (note.velocity || 0.8) * channel.volume;
  const attack = p.attack || 0.01;
  const decay = p.decay || 0.5;
  const release = p.release || 0.2;
  ampGain.gain.setValueAtTime(0.001, time);
  ampGain.gain.linearRampToValueAtTime(vel, time + attack);
  ampGain.gain.exponentialRampToValueAtTime(0.0001, time + decay + release);

  carrier.connect(ampGain);
  ampGain.connect(destination);

  carrier.start(time);
  modulator.start(time);
  carrier.onended = () => onEnded?.();
  const stopTime = time + decay + release + 0.05;
  carrier.stop(stopTime);
  modulator.stop(stopTime);

  return {
    stop: (relTime?: number) => {
      const now = relTime ?? ctx.currentTime;
      ampGain.gain.cancelScheduledValues(now);
      ampGain.gain.setValueAtTime(ampGain.gain.value, now);
      ampGain.gain.exponentialRampToValueAtTime(0.0001, now + release);
      try { carrier.stop(now + release + 0.05); } catch (_) {}
      try { modulator.stop(now + release + 0.05); } catch (_) {}
    },
  };
};
