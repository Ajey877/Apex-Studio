import type { InstrumentVoiceRenderer } from '../instrumentRegistry';

const midiToFrequency = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

export const renderSubtractiveSynthVoice: InstrumentVoiceRenderer = ({
  channel,
  note,
  time,
  destination,
  audioContext,
}) => {
  const ctx = audioContext;
  const p = channel.synthParams;
  const baseFreq = midiToFrequency(note.pitch + channel.pitch);
  const duration = (note.duration || 1) * 0.25;

  const ampGain = ctx.createGain();
  const vel = (note.velocity || 0.8) * channel.volume;
  const attack = Math.max(0.002, p.attack || 0.01);
  const decay = Math.max(0.01, p.decay || 0.15);
  const sustain = Math.max(0.001, p.sustain ?? 0.6);
  const release = Math.max(0.02, p.release || 0.2);

  ampGain.gain.setValueAtTime(0.0001, time);
  ampGain.gain.linearRampToValueAtTime(vel, time + attack);
  ampGain.gain.exponentialRampToValueAtTime(vel * sustain, time + attack + decay);

  const filter = ctx.createBiquadFilter();
  filter.type = p.filterType || 'lowpass';
  const cutoff = Math.min(18000, Math.max(40, p.filterCutoff || 2500));
  filter.frequency.setValueAtTime(cutoff, time);
  filter.Q.value = p.filterResonance || 2.0;

  const envAmt = p.filterEnvAmount || 0.5;
  if (envAmt > 0) {
    filter.frequency.exponentialRampToValueAtTime(
      Math.min(19000, cutoff + (envAmt * 6000)),
      time + attack,
    );
    filter.frequency.exponentialRampToValueAtTime(cutoff, time + attack + decay);
  }

  const unisonCount = Math.min(7, Math.max(1, p.unisonVoices || 1));
  const unisonDetuneCents = p.unisonDetune || 15;
  const oscList: OscillatorNode[] = [];

  const osc1 = ctx.createOscillator();
  osc1.type = p.osc1Type || 'sawtooth';
  const oct1Mult = Math.pow(2, p.osc1Octave || 0);
  osc1.frequency.setValueAtTime(baseFreq * oct1Mult, time);
  osc1.detune.setValueAtTime(p.osc1Detune || 0, time);
  oscList.push(osc1);

  const osc2 = ctx.createOscillator();
  osc2.type = p.osc2Type || 'square';
  const oct2Mult = Math.pow(2, p.osc2Octave || 0);
  osc2.frequency.setValueAtTime(baseFreq * oct2Mult, time);
  osc2.detune.setValueAtTime(p.osc2Detune || 12, time);
  oscList.push(osc2);

  const extraUnisonNodes: OscillatorNode[] = [];
  if (unisonCount > 1) {
    for (let u = 1; u < unisonCount; u++) {
      const sign = u % 2 === 1 ? 1 : -1;
      const detuneSpread = Math.ceil(u / 2) * (unisonDetuneCents / Math.floor(unisonCount / 2));
      const uOsc = ctx.createOscillator();
      uOsc.type = p.osc1Type || 'sawtooth';
      uOsc.frequency.setValueAtTime(baseFreq * oct1Mult, time);
      uOsc.detune.setValueAtTime((p.osc1Detune || 0) + (sign * detuneSpread), time);
      extraUnisonNodes.push(uOsc);
      oscList.push(uOsc);
    }
  }

  const oscMix1 = ctx.createGain();
  oscMix1.gain.value = (p.osc1Mix ?? 0.8) / (1 + extraUnisonNodes.length * 0.35);

  const oscMix2 = ctx.createGain();
  oscMix2.gain.value = p.osc2Mix ?? 0.5;

  let lfo: OscillatorNode | null = null;
  let lfoGain: GainNode | null = null;
  if (p.lfoRate && p.lfoDepth && p.lfoTarget !== 'none') {
    lfo = ctx.createOscillator();
    lfo.frequency.value = p.lfoRate || 4;
    lfoGain = ctx.createGain();

    if (p.lfoTarget === 'pitch') {
      lfoGain.gain.value = (p.lfoDepth || 0.2) * 50;
      lfo.connect(lfoGain);
      oscList.forEach(o => lfoGain!.connect(o.detune));
    } else if (p.lfoTarget === 'filter') {
      lfoGain.gain.value = (p.lfoDepth || 0.3) * 1200;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
    }
    lfo.start(time);
  }

  osc1.connect(oscMix1);
  extraUnisonNodes.forEach(u => u.connect(oscMix1));
  osc2.connect(oscMix2);
  oscMix1.connect(filter);
  oscMix2.connect(filter);
  filter.connect(ampGain);
  ampGain.connect(destination);

  oscList.forEach(o => o.start(time));

  const stopTime = time + duration;
  ampGain.gain.setValueAtTime(vel * sustain, stopTime);
  ampGain.gain.exponentialRampToValueAtTime(0.0001, stopTime + release);

  oscList.forEach(o => o.stop(stopTime + release + 0.05));
  if (lfo) lfo.stop(stopTime + release + 0.05);

  return {
    stop: (relTime?: number) => {
      const now = relTime ?? ctx.currentTime;
      ampGain.gain.cancelScheduledValues(now);
      ampGain.gain.setValueAtTime(ampGain.gain.value, now);
      ampGain.gain.exponentialRampToValueAtTime(0.0001, now + release);
      oscList.forEach(o => {
        try { o.stop(now + release + 0.05); } catch (_) {}
      });
      if (lfo) {
        try { lfo.stop(now + release + 0.05); } catch (_) {}
      }
    },
  };
};
