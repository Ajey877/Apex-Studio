import type { InstrumentVoiceRenderer } from '../instrumentRegistry';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const midiToFrequency = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

/**
 * Phase 20C proof instrument.
 *
 * This renderer is deliberately independent of AudioEngine: it only consumes
 * InstrumentVoiceContext and the Web Audio node factory exposed by the
 * destination's context. That makes the same implementation usable by live
 * and OfflineAudioContext rendering without importing engine internals.
 */
export const renderIndependentPluckVoice: InstrumentVoiceRenderer = ({
  channel,
  note,
  time,
  destination,
  audioContext,
  onEnded,
}) => {
  const ctx = audioContext;
  const frequency = midiToFrequency(note.pitch + channel.pitch);
  const velocity = clamp((note.velocity ?? 0.8) * channel.volume, 0, 1);
  const duration = clamp((note.duration || 1) * 0.2, 0.05, 1.5);

  const output = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  const body = ctx.createOscillator();
  const overtone = ctx.createOscillator();
  const overtoneGain = ctx.createGain();
  const panner = ctx.createStereoPanner();

  body.type = 'triangle';
  body.frequency.setValueAtTime(frequency, time);

  overtone.type = 'sine';
  overtone.frequency.setValueAtTime(frequency * 2.01, time);
  overtoneGain.gain.setValueAtTime(velocity * 0.22, time);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(clamp(frequency * 5, 900, 11000), time);
  filter.Q.value = 1.1;

  panner.pan.setValueAtTime(clamp(note.pan ?? channel.pan, -1, 1), time);

  output.gain.setValueAtTime(0.0001, time);
  output.gain.linearRampToValueAtTime(Math.max(0.001, velocity), time + 0.004);
  output.gain.exponentialRampToValueAtTime(0.0001, time + duration);

  body.connect(filter);
  overtone.connect(overtoneGain);
  overtoneGain.connect(filter);
  filter.connect(output);
  output.connect(panner);
  panner.connect(destination);

  body.start(time);
  overtone.start(time);
  body.onended = () => onEnded?.();
  body.stop(time + duration + 0.02);
  overtone.stop(time + duration + 0.02);

  return {
    stop: (relTime?: number) => {
      const now = relTime ?? ctx.currentTime;
      output.gain.cancelScheduledValues?.(now);
      output.gain.setValueAtTime(Math.max(0.0001, output.gain.value), now);
      output.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);
      try { body.stop(now + 0.025); } catch (_) {}
      try { overtone.stop(now + 0.025); } catch (_) {}
    },
  };
};
