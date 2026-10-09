/**
 * Phase 1J — the metronome click voice.
 *
 * One short sine blip per pulse, routed to the master bus. The downbeat and
 * plain-pulse voices keep the exact pre-Phase-1J sound (1400 Hz / 880 Hz,
 * 0.3 peak, 40 ms exponential decay, 50 ms lifetime) so existing 4/4 sessions
 * sound unchanged; group accents (6/8 pulse 4, 7/8 group starts) get a
 * distinct middle pitch so a 2+2+3 bar is audibly different from 3+2+2.
 */
import type { PulseLevel } from '../music/meterPulse';

export interface MetronomeClickVoice {
  readonly frequencyHz: number;
  readonly peakGain: number;
}

export const METRONOME_CLICK_VOICES: Readonly<Record<PulseLevel, MetronomeClickVoice>> = Object.freeze({
  downbeat: Object.freeze({ frequencyHz: 1400, peakGain: 0.3 }),
  accent: Object.freeze({ frequencyHz: 1100, peakGain: 0.3 }),
  pulse: Object.freeze({ frequencyHz: 880, peakGain: 0.3 }),
});

export const METRONOME_CLICK_DECAY_SECONDS = 0.04;
export const METRONOME_CLICK_LIFETIME_SECONDS = 0.05;

/** Minimal structural view of the AudioContext pieces the click uses. */
export interface MetronomeClickContext {
  createOscillator(): OscillatorNode;
  createGain(): GainNode;
}

/**
 * Schedules one click at `time` into `destination` and returns the oscillator
 * so the caller can cancel it (stop/seek/pause must silence clicks that were
 * scheduled inside the transport look-ahead but have not sounded yet).
 */
export function scheduleMetronomeClick(
  context: MetronomeClickContext,
  destination: AudioNode,
  time: number,
  level: PulseLevel
): OscillatorNode {
  const voice = METRONOME_CLICK_VOICES[level];
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.frequency.setValueAtTime(voice.frequencyHz, time);
  gain.gain.setValueAtTime(voice.peakGain, time);
  gain.gain.exponentialRampToValueAtTime(0.001, time + METRONOME_CLICK_DECAY_SECONDS);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(time);
  osc.stop(time + METRONOME_CLICK_LIFETIME_SECONDS);
  return osc;
}
