import type { InstrumentVoiceRenderer } from '../instrumentRegistry';
import { midiToFrequency, createNoiseBuffer } from './legacyVoiceUtils';

export const renderGrandPianoVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.4;

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.0001, time);
    masterGain.gain.linearRampToValueAtTime(vel, time + 0.003); // Hammer strike
    masterGain.gain.exponentialRampToValueAtTime(vel * 0.4, time + 0.3);
    masterGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.4);

    // Filter - acoustic damping
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const cutoff = Math.min(16000, f0 * 6 + vel * 3000);
    filter.frequency.setValueAtTime(cutoff, time);
    filter.frequency.exponentialRampToValueAtTime(f0 * 2, time + duration + 0.3);

    // Harmonic partials (f0, 2*f0, 3*f0, 4*f0) with inharmonicity
    const osc1 = ctx.createOscillator();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(f0, time);

    const osc2 = ctx.createOscillator();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(f0 * 2.002, time);

    const osc3 = ctx.createOscillator();
    osc3.type = 'sine';
    osc3.frequency.setValueAtTime(f0 * 3.006, time);

    const g1 = ctx.createGain(); g1.gain.value = 0.7;
    const g2 = ctx.createGain(); g2.gain.value = 0.3;
    const g3 = ctx.createGain(); g3.gain.value = 0.15;

    // Hammer noise click transient
    const hammer = ctx.createBufferSource();
    hammer.buffer = createNoiseBuffer(audioContext, 0.015);
    const hammerFilter = ctx.createBiquadFilter();
    hammerFilter.type = 'bandpass';
    hammerFilter.frequency.value = Math.min(6000, f0 * 3);
    const hammerGain = ctx.createGain();
    hammerGain.gain.setValueAtTime(vel * 0.25, time);
    hammerGain.gain.exponentialRampToValueAtTime(0.001, time + 0.015);
    hammer.connect(hammerFilter);
    hammerFilter.connect(hammerGain);
    hammerGain.connect(filter);

    osc1.connect(g1); g1.connect(filter);
    osc2.connect(g2); g2.connect(filter);
    osc3.connect(g3); g3.connect(filter);
    filter.connect(masterGain);
    masterGain.connect(destination);

    osc1.start(time); osc2.start(time); osc3.start(time); hammer.start(time);
    const stopTime = time + duration + 0.5;
    osc1.stop(stopTime); osc2.stop(stopTime); osc3.stop(stopTime); hammer.stop(time + 0.02);
  
};

export const renderRhodesVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.35;

    const mainGain = ctx.createGain();
    mainGain.gain.setValueAtTime(0.0001, time);
    mainGain.gain.linearRampToValueAtTime(vel, time + 0.005);
    mainGain.gain.exponentialRampToValueAtTime(vel * 0.5, time + 0.25);
    mainGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.3);

    // Fundamental Sine Tine
    const tine = ctx.createOscillator();
    tine.type = 'sine';
    tine.frequency.setValueAtTime(f0, time);

    // Bell overtone at 3.98x
    const bell = ctx.createOscillator();
    bell.type = 'sine';
    bell.frequency.setValueAtTime(f0 * 3.98, time);
    const bellGain = ctx.createGain();
    bellGain.gain.setValueAtTime(vel * 0.4, time);
    bellGain.gain.exponentialRampToValueAtTime(0.001, time + 0.15);

    // Tremolo LFO
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 4.8;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.08;
    const tremGain = ctx.createGain();
    tremGain.gain.value = 0.92;
    lfo.connect(lfoGain);
    lfoGain.connect(tremGain.gain);

    tine.connect(mainGain);
    bell.connect(bellGain);
    bellGain.connect(mainGain);
    mainGain.connect(tremGain);
    tremGain.connect(destination);

    tine.start(time); bell.start(time); lfo.start(time);
    const stopTime = time + duration + 0.35;
    tine.stop(stopTime); bell.stop(time + 0.2); lfo.stop(stopTime);
  
};

export const renderOrganVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 1.5) * 0.35;

    const organGain = ctx.createGain();
    organGain.gain.setValueAtTime(vel * 0.7, time);
    organGain.gain.setValueAtTime(vel * 0.7, time + duration);
    organGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.05);

    // Additive Drawbars: 16' (0.5x), 8' (1x), 4' (2x), 2 2/3' (3x), 2' (4x)
    const harmonics = [0.5, 1.0, 2.0, 3.0, 4.0];
    const amplitudes = [0.6, 1.0, 0.7, 0.4, 0.3];

    harmonics.forEach((h, i) => {
  const ctx = audioContext;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f0 * h, time);
      const g = ctx.createGain();
      g.gain.value = amplitudes[i] * 0.25;
      osc.connect(g);
      g.connect(organGain);
      osc.start(time);
      osc.stop(time + duration + 0.08);
    });

    // Rotary Leslie chorus LFO
    const rotaryLfo = ctx.createOscillator();
    rotaryLfo.frequency.value = 6.2;
    const rotaryDepth = ctx.createGain();
    rotaryDepth.gain.value = 0.05;
    rotaryLfo.connect(rotaryDepth);

    organGain.connect(destination);
    rotaryLfo.start(time);
    rotaryLfo.stop(time + duration + 0.1);
  
};

export const renderPluckedGuitarVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.4;

    const pluckGain = ctx.createGain();
    pluckGain.gain.setValueAtTime(0.0001, time);
    pluckGain.gain.linearRampToValueAtTime(vel, time + 0.002);
    pluckGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.25);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.min(14000, f0 * 8), time);
    filter.frequency.exponentialRampToValueAtTime(f0 * 1.5, time + 0.3);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(f0, time);

    const osc2 = ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(f0, time);
    osc2.detune.setValueAtTime(4, time);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(pluckGain);
    pluckGain.connect(destination);

    osc1.start(time); osc2.start(time);
    osc1.stop(time + duration + 0.3); osc2.stop(time + duration + 0.3);
  
};

export const renderStringsVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.4;

    const strGain = ctx.createGain();
    strGain.gain.setValueAtTime(0.0001, time);
    strGain.gain.linearRampToValueAtTime(vel * 0.8, time + 0.12); // Bowing swell
    strGain.gain.setValueAtTime(vel * 0.8, time + duration);
    strGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.4);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 5200;

    // Detuned violin unison voices
    const detunes = [-12, -5, 0, 5, 12];
    detunes.forEach((d) => {
  const ctx = audioContext;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0, time);
      osc.detune.setValueAtTime(d, time);
      const g = ctx.createGain();
      g.gain.value = 0.18;
      osc.connect(g);
      g.connect(filter);
      osc.start(time);
      osc.stop(time + duration + 0.5);
    });

    // Natural string vibrato
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibGain = ctx.createGain();
    vibGain.gain.value = 4;
    vib.connect(vibGain);
    vibGain.connect(filter.frequency);
    vib.start(time + 0.1);
    vib.stop(time + duration + 0.5);

    filter.connect(strGain);
    strGain.connect(destination);
  
};

export const renderPizzicatoVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;

    const pizzGain = ctx.createGain();
    pizzGain.gain.setValueAtTime(0.0001, time);
    pizzGain.gain.linearRampToValueAtTime(vel, time + 0.002);
    pizzGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.35);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(f0 * 2.2, time);
    filter.Q.value = 3.0;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f0, time);

    osc.connect(filter);
    filter.connect(pizzGain);
    pizzGain.connect(destination);

    osc.start(time);
    osc.stop(time + 0.4);
  
};

export const renderBrassVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;
    const duration = (note.duration || 2) * 0.35;

    const brassGain = ctx.createGain();
    brassGain.gain.setValueAtTime(0.0001, time);
    brassGain.gain.linearRampToValueAtTime(vel * 0.9, time + 0.05); // Brass swell
    brassGain.gain.setValueAtTime(vel * 0.9, time + duration);
    brassGain.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.2);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(400, time);
    filter.frequency.exponentialRampToValueAtTime(Math.min(9000, f0 * 7), time + 0.07);
    filter.frequency.exponentialRampToValueAtTime(f0 * 3, time + 0.3);
    filter.Q.value = 4.0;

    const osc1 = ctx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(f0, time);
    osc1.detune.setValueAtTime(-8, time);

    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.setValueAtTime(f0, time);
    osc2.detune.setValueAtTime(8, time);

    osc1.connect(filter);
    osc2.connect(filter);
    filter.connect(brassGain);
    brassGain.connect(destination);

    osc1.start(time); osc2.start(time);
    osc1.stop(time + duration + 0.25); osc2.stop(time + duration + 0.25);
  
};

export const renderMarimbaVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext }) => {const f0 = midiToFrequency(note.pitch + channel.pitch);
    const vel = (note.velocity || 0.8) * channel.volume;

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.0001, time);
    ampGain.gain.linearRampToValueAtTime(vel, time + 0.002);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.45);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(f0, time);

    // Wooden strike ping (4th harmonic)
    const ping = ctx.createOscillator();
    ping.type = 'sine';
    ping.frequency.setValueAtTime(f0 * 4, time);
    const pingGain = ctx.createGain();
    pingGain.gain.setValueAtTime(vel * 0.3, time);
    pingGain.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

    osc.connect(ampGain);
    ping.connect(pingGain);
    pingGain.connect(ampGain);
    ampGain.connect(destination);

    osc.start(time); ping.start(time);
    osc.stop(time + 0.5); ping.stop(time + 0.05);
  
};
