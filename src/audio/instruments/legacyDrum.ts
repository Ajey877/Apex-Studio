import type { InstrumentVoiceRenderer } from '../instrumentRegistry';
import { createLegacyVoiceHandle } from './legacyVoiceLifecycle';
import { midiToFrequency, createNoiseBuffer } from './legacyVoiceUtils';

export const renderLegacyDrumVoice: InstrumentVoiceRenderer = ({ channel, note, time, destination, audioContext, onEnded }) => {
  const ctx = audioContext;
  const lifecycleSources: AudioScheduledSourceNode[] = [];
const pitch = note.pitch % 12; // Modulo to map drum pad
    const vel = (note.velocity || 0.8) * channel.volume;

    // Pitch mapping:
    // 0 / 36 = Kick, 1 / 38 = Snare, 2 / 42 = Closed HiHat, 3 / 46 = Open HiHat
    // 4 / 39 = Clap, 5 / 35 = 808 Sub, 6 / 37 = Rim, 7 / 48 = Tom, 8 / 49 = Crash
    const drumIndex = note.pitch >= 35 ? (note.pitch - 35) % 9 : note.pitch % 9;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vel, time);
    gain.connect(destination);

    switch (drumIndex) {
      case 1: // 36: Kick
      case 0: {
        const osc = ctx.createOscillator();
      lifecycleSources.push(osc);
        const oscGain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(140, time);
        osc.frequency.exponentialRampToValueAtTime(38, time + 0.12);

        oscGain.gain.setValueAtTime(1.0, time);
        oscGain.gain.exponentialRampToValueAtTime(0.001, time + 0.35);

        osc.connect(oscGain);
        oscGain.connect(gain);
        osc.start(time);
        osc.stop(time + 0.36);
        break;
      }
      case 3: // 38: Snare
      case 2: {
        // Noise + body tone
        const osc = ctx.createOscillator();
      lifecycleSources.push(osc);
        const oscGain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(185, time);
        osc.frequency.exponentialRampToValueAtTime(90, time + 0.08);

        oscGain.gain.setValueAtTime(0.7, time);
        oscGain.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
        osc.connect(oscGain);
        oscGain.connect(gain);
        osc.start(time);
        osc.stop(time + 0.19);

        // Noise buffer
        const noiseBuffer = createNoiseBuffer(audioContext, 0.2);
        const noiseSource = ctx.createBufferSource();
      lifecycleSources.push(noiseSource);
        noiseSource.buffer = noiseBuffer;

        const noiseFilter = ctx.createBiquadFilter();
        noiseFilter.type = 'highpass';
        noiseFilter.frequency.value = 1200;

        const noiseGain = ctx.createGain();
        noiseGain.gain.setValueAtTime(0.8, time);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, time + 0.22);

        noiseSource.connect(noiseFilter);
        noiseFilter.connect(noiseGain);
        noiseGain.connect(gain);
        noiseSource.start(time);
        noiseSource.stop(time + 0.23);
        break;
      }
      case 4: // Clap
      case 5: { // 808 Sub Bass
        if (drumIndex === 5) {
          const osc = ctx.createOscillator();
      lifecycleSources.push(osc);
          const oscGain = ctx.createGain();
          osc.type = 'sine';
          const subFreq = midiToFrequency(note.pitch || 36);
          osc.frequency.setValueAtTime(subFreq * 1.5, time);
          osc.frequency.exponentialRampToValueAtTime(subFreq, time + 0.04);

          oscGain.gain.setValueAtTime(1.0, time);
          oscGain.gain.exponentialRampToValueAtTime(0.001, time + 0.8);
          osc.connect(oscGain);
          oscGain.connect(gain);
          osc.start(time);
          osc.stop(time + 0.82);
        } else {
          // Clap
          const noise = ctx.createBufferSource();
      lifecycleSources.push(noise);
          noise.buffer = createNoiseBuffer(audioContext, 0.25);
          const filter = ctx.createBiquadFilter();
          filter.type = 'bandpass';
          filter.frequency.value = 1400;
          filter.Q.value = 2.0;

          const clapGain = ctx.createGain();
          // Triple burst
          clapGain.gain.setValueAtTime(0.9, time);
          clapGain.gain.exponentialRampToValueAtTime(0.05, time + 0.015);
          clapGain.gain.setValueAtTime(0.9, time + 0.025);
          clapGain.gain.exponentialRampToValueAtTime(0.05, time + 0.04);
          clapGain.gain.setValueAtTime(1.0, time + 0.05);
          clapGain.gain.exponentialRampToValueAtTime(0.001, time + 0.25);

          noise.connect(filter);
          filter.connect(clapGain);
          clapGain.connect(gain);
          noise.start(time);
          noise.stop(time + 0.26);
        }
        break;
      }
      case 7: { // Closed HiHat (42)
        const noise = ctx.createBufferSource();
      lifecycleSources.push(noise);
        noise.buffer = createNoiseBuffer(audioContext, 0.08);
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 7500;

        const hhGain = ctx.createGain();
        hhGain.gain.setValueAtTime(0.7, time);
        hhGain.gain.exponentialRampToValueAtTime(0.001, time + 0.06);

        noise.connect(filter);
        filter.connect(hhGain);
        hhGain.connect(gain);
        noise.start(time);
        noise.stop(time + 0.07);
        break;
      }
      case 8: { // Open HiHat (46)
        const noise = ctx.createBufferSource();
      lifecycleSources.push(noise);
        noise.buffer = createNoiseBuffer(audioContext, 0.45);
        const filter = ctx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 6500;

        const openGain = ctx.createGain();
        openGain.gain.setValueAtTime(0.8, time);
        openGain.gain.exponentialRampToValueAtTime(0.001, time + 0.42);

        noise.connect(filter);
        filter.connect(openGain);
        openGain.connect(gain);
        noise.start(time);
        noise.stop(time + 0.44);
        break;
      }
      default: {
        // Perc / Rim / Tom
        const osc = ctx.createOscillator();
      lifecycleSources.push(osc);
        const oscGain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(320, time);
        osc.frequency.exponentialRampToValueAtTime(110, time + 0.09);

        oscGain.gain.setValueAtTime(0.7, time);
        oscGain.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
        osc.connect(oscGain);
        oscGain.connect(gain);
        osc.start(time);
        osc.stop(time + 0.13);
      }
    }
  
  return createLegacyVoiceHandle(lifecycleSources, onEnded);
};