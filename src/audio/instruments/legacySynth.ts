import type { InstrumentVoiceRenderer } from '../instrumentRegistry';
import { midiToFrequency } from './legacyVoiceUtils';

export const renderAcid303Voice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 1) * 0.25;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel, time + 0.004);
    ampGain.gain.exponentialRampToValueAtTime(vel * 0.4, time + 0.15);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.1);

    // 24dB Diode Ladder Resonant Filter
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 14.0; // Acid squeal
    filter.frequency.setValueAtTime(f0 * 12, time);
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, f0 * 1.5), time + 0.18);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0, time);

    osc.connect(filter);
    filter.connect(ampGain);
    ampGain.connect(destination);

    osc.start(time);
    osc.stop(time + duration + 0.15);
  
};

export const renderReeseBassVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.3;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel, time + 0.02);
    ampGain.gain.setValueAtTime(vel * 0.9, time + duration);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.15);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 950;
    filter.Q.value = 3.0;

    const detunes = [-16, 0, 16];
    detunes.forEach((d) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0, time);
      osc.detune.setValueAtTime(d, time);
      const g = ctx.createGain();
      g.gain.value = 0.33;
      osc.connect(g);
      g.connect(filter);
      osc.start(time);
      osc.stop(time + duration + 0.2);
    });

    filter.connect(ampGain);
    ampGain.connect(destination);
  
};

export const render808SubVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.4;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    // Pitch punch drop
    osc.frequency.setValueAtTime(f0 * 1.8, time);
    osc.frequency.exponentialRampToValueAtTime(f0, time + 0.035);

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel, time + 0.003);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.5);

    osc.connect(ampGain);
    ampGain.connect(destination);

    osc.start(time);
    osc.stop(time + duration + 0.55);
  
};

export const renderSupersawVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.3;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel * 0.9, time + 0.015);
    ampGain.gain.setValueAtTime(vel * 0.85, time + duration);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.25);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 8500;
    filter.Q.value = 2.0;

    const supersawDetunes = [-24, -14, -6, 0, 6, 14, 24];
    supersawDetunes.forEach((d) => {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0, time);
      osc.detune.setValueAtTime(d, time);
      const g = ctx.createGain();
      g.gain.value = 0.14;
      osc.connect(g);
      g.connect(filter);
      osc.start(time);
      osc.stop(time + duration + 0.3);
    });

    filter.connect(ampGain);
    ampGain.connect(destination);
  
};

export const renderAmbientPadVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.45;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel * 0.8, time + 0.35); // Slow bloom
    ampGain.gain.setValueAtTime(vel * 0.8, time + duration);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.7);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(600, time);
    filter.frequency.exponentialRampToValueAtTime(2800, time + 0.4);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(f0, time);
    osc1.detune.setValueAtTime(-7, time);

    const osc2 = ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(f0, time);
    osc2.detune.setValueAtTime(7, time);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(ampGain);
    ampGain.connect(destination);

    osc1.start(time); osc2.start(time);
    osc1.stop(time + duration + 0.75); osc2.stop(time + duration + 0.75);
  
};

export const renderVoxChoirVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.35;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel * 0.85, time + 0.08);
    ampGain.gain.setValueAtTime(vel * 0.85, time + duration);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.3);

    // Formant filter 1 & 2 ("Ah" vowel: 800Hz / 1200Hz)
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 800;
    f1.Q.value = 5.0;

    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 1200;
    f2.Q.value = 6.0;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0, time);

    // Natural voice vibrato
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.5;
    const vibGain = ctx.createGain();
    vibGain.gain.value = 6;
    vib.connect(osc.detune);
    vib.start(time);

    osc.connect(f1); osc.connect(f2);
    f1.connect(ampGain); f2.connect(ampGain);
    ampGain.connect(destination);

    osc.start(time);
    osc.stop(time + duration + 0.35); vib.stop(time + duration + 0.35);
  
};

export const renderChiptuneVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 1) * 0.2;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(vel * 0.8, time);
    ampGain.gain.setValueAtTime(vel * 0.8, time + duration);
    ampGain.gain.setValueAtTime(0.0001, time + duration + 0.01); // Instant 8-bit gating

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(f0, time);

    osc.connect(ampGain);
    ampGain.connect(destination);

    osc.start(time);
    osc.stop(time + duration + 0.02);
  
};
