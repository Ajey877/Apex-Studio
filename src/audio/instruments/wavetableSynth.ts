/**
 * Phase 8B — the `wavetable` instrument renderer.
 *
 * A voice is a bounded unison stack of `PeriodicWave` oscillators built from
 * the table in `wavetableTables.ts`. The table is interpolated between six
 * waveform frames, warped, harmonic-shaped and band-limited before it reaches
 * the oscillator, so morph / warp / harmonic edits change the real signal and
 * live playback and offline export share one implementation.
 *
 * The envelope, gate, filter, pitch and voice-lifecycle conventions are the
 * same ones `renderSubtractiveSynthVoice` uses: `resolveGateSeconds` with the
 * neutral 1.0x character, attack → decay → sustain, exponential release to
 * 1e-4, `onEnded` fired by the first oscillator, and a `stop()` handle.
 *
 * Voice allocation is bounded: at most `WAVETABLE_MAX_UNISON_VOICES` (7)
 * oscillators per note, one filter and one amp gain, with the unison sum
 * divided by the voice count so a correlated stack can never exceed unit peak.
 */
import type { InstrumentVoiceRenderer } from '../instrumentRegistry';
import { GATE_CHARACTER, resolveGateSeconds } from '../noteGate';
import {
  WAVETABLE_MAX_UNISON_VOICES,
  getCachedWavetableShape,
  normalizeWavetableParameters,
} from '../wavetableTables';

const midiToFrequency = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);

const MIN_GAIN = 1e-4;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const renderWavetableVoice: InstrumentVoiceRenderer = ({
  channel,
  note,
  time,
  destination,
  audioContext,
  bpm,
  onEnded,
}) => {
  const ctx = audioContext;
  const p = channel.synthParams;
  const wavetable = normalizeWavetableParameters(channel.wavetable);
  const baseFreq = midiToFrequency(note.pitch + channel.pitch);
  const duration = resolveGateSeconds(note.duration, bpm, {
    characterFactor: GATE_CHARACTER.neutral,
    fallbackSteps: 1,
  });

  const velocity = Number.isFinite(note.velocity) ? note.velocity : 0.8;
  const channelVolume = Number.isFinite(channel.volume) ? channel.volume : 0.8;
  const vel = Math.max(MIN_GAIN, Math.min(1, velocity * Math.max(0, channelVolume)));

  const attack = Math.max(0.002, p.attack || 0.01);
  const decay = Math.max(0.01, p.decay || 0.15);
  const sustain = clamp(p.sustain ?? 0.6, 0.001, 1);
  const release = Math.max(0.02, p.release || 0.2);

  const ampGain = ctx.createGain();
  ampGain.gain.setValueAtTime(MIN_GAIN, time);
  ampGain.gain.linearRampToValueAtTime(vel, time + attack);
  // Explicitly anchor the sustain plateau: the decay ramp already ends there,
  // and pinning the value keeps the hold independent of how a host interpolates
  // toward the later release event.
  ampGain.gain.exponentialRampToValueAtTime(
    Math.max(MIN_GAIN, vel * sustain),
    time + attack + decay,
  );
  ampGain.gain.setValueAtTime(Math.max(MIN_GAIN, vel * sustain), time + attack + decay);

  const filter = ctx.createBiquadFilter();
  filter.type = p.filterType || 'lowpass';
  const cutoff = clamp(Number.isFinite(p.filterCutoff) ? p.filterCutoff : 2500, 40, 18000);
  filter.frequency.setValueAtTime(cutoff, time);
  filter.Q.value = clamp(Number.isFinite(p.filterResonance) ? p.filterResonance : 1, 0, 20);

  const filterEnvAmount = clamp(Number.isFinite(p.filterEnvAmount) ? p.filterEnvAmount : 0, 0, 1);
  if (filterEnvAmount > 0) {
    filter.frequency.exponentialRampToValueAtTime(
      Math.min(19000, cutoff + filterEnvAmount * 6000),
      time + attack,
    );
    filter.frequency.exponentialRampToValueAtTime(cutoff, time + attack + decay);
  }

  const shape = getCachedWavetableShape(wavetable);

  // Real browsers always provide createPeriodicWave. Minimal test doubles that
  // do not are given a standard oscillator so a mocked graph still builds; the
  // wavetable shape itself is still reported by the tests that render audio.
  const supportsPeriodicWave = typeof ctx.createPeriodicWave === 'function';
  const periodicWave = supportsPeriodicWave
    ? ctx.createPeriodicWave(shape.real, shape.imag, { disableNormalization: true })
    : null;

  const unisonVoices = Math.round(
    clamp(wavetable.unisonVoices, 1, WAVETABLE_MAX_UNISON_VOICES),
  );
  const detuneCents = clamp(wavetable.unisonDetuneCents, 0, 50);
  const spread = clamp(wavetable.unisonSpread, 0, 1);

  // Uncorrelated unison gains 1/sqrt(n); correlated (detune 0) can sum to n, so
  // the safe bound is 1/n. Using it unconditionally guarantees |voice| ≤ 1.
  const voiceGainValue = 1 / unisonVoices;

  const voiceBus = ctx.createGain();
  voiceBus.gain.setValueAtTime(1, time);
  voiceBus.connect(filter);
  filter.connect(ampGain);
  ampGain.connect(destination);

  const oscillators: OscillatorNode[] = [];
  const addOscillator = (osc: OscillatorNode) => {
    oscillators.push(osc);
  };

  for (let index = 0; index < unisonVoices; index++) {
    const offset = unisonVoices === 1 ? 0 : (2 * index) / (unisonVoices - 1) - 1;
    const osc = ctx.createOscillator();
    if (periodicWave && typeof osc.setPeriodicWave === 'function') {
      osc.setPeriodicWave(periodicWave);
    } else {
      osc.type = 'sawtooth';
    }
    osc.frequency.setValueAtTime(baseFreq, time);
    osc.detune.setValueAtTime(offset * detuneCents, time);

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(voiceGainValue, time);
    osc.connect(voiceGain);

    const pan = clamp(offset * spread, -1, 1);
    if (spread > 0 && unisonVoices > 1 && typeof ctx.createStereoPanner === 'function' && pan !== 0) {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(pan, time);
      voiceGain.connect(panner);
      panner.connect(voiceBus);
    } else {
      voiceGain.connect(voiceBus);
    }

    addOscillator(osc);
  }

  oscillators.forEach((osc) => osc.start(time));
  const first = oscillators[0];
  if (first) first.onended = () => onEnded?.();

  const stopTime = time + duration;
  ampGain.gain.setValueAtTime(Math.max(MIN_GAIN, vel * sustain), stopTime);
  ampGain.gain.exponentialRampToValueAtTime(MIN_GAIN, stopTime + release);

  const teardownTime = stopTime + release + 0.05;
  oscillators.forEach((osc) => {
    try {
      osc.stop(teardownTime);
    } catch (_) {}
  });

  return {
    stop: (releaseTime?: number) => {
      const now = releaseTime ?? ctx.currentTime;
      try {
        ampGain.gain.cancelScheduledValues(now);
        ampGain.gain.setValueAtTime(Math.max(MIN_GAIN, ampGain.gain.value), now);
        ampGain.gain.exponentialRampToValueAtTime(MIN_GAIN, now + release);
      } catch (_) {}
      const stopAt = now + release + 0.05;
      oscillators.forEach((osc) => {
        try {
          osc.stop(stopAt);
        } catch (_) {}
      });
    },
  };
};
