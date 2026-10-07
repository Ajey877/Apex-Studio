/**
 * Canonical musical-time arithmetic. One beat is always a QUARTER NOTE;
 * one legacy sixteenth-note step is 0.25 beats, independent of meter.
 *
 * No project/audio/UI imports, quantization, BPM clamping or fallback policy.
 * Existing callers own their validation (engine: 20–300 BPM; standalone
 * transport: 20–999). Signed quantities are useful for offsets. IEEE-754
 * NaN/Infinity propagation is intentional: this layer must not silently repair
 * malformed legacy input or introduce exceptions into existing scheduling.
 * Meter validation is explicit because meter arithmetic is a new API; runtime
 * consumers still pass LEGACY_TIME_SIGNATURE, NOT project metadata.
 *
 * Numeric aliases avoid casts/schema changes at the legacy boundaries. Stored
 * Note.start/duration remain steps in Phase 1A; only conversions use beats.
 */
export type MusicalBeats = number;
export type Seconds = number;
export type MidiTicks = number;
export type TimeSignature = readonly [numerator: number, denominator: number];

export const SIXTEENTH_STEPS_PER_BEAT = 4;
export const DEFAULT_MIDI_PPQ = 480;
/** Compatibility grid, not a default argument for meter-aware conversions. */
export const LEGACY_TIME_SIGNATURE: TimeSignature = Object.freeze([4, 4] as const);

export const stepsToBeats = (steps: number): MusicalBeats => steps / SIXTEENTH_STEPS_PER_BEAT;
export const beatsToSteps = (beats: MusicalBeats): number => beats * SIXTEENTH_STEPS_PER_BEAT;

export const beatsToSeconds = (beats: MusicalBeats, bpm: number): Seconds => beats * (60 / bpm);
export const secondsToBeats = (seconds: Seconds, bpm: number): MusicalBeats => seconds * bpm / 60;

/** Positive integer numerator and power-of-two note-value denominator. */
export function beatsPerBar([numerator, denominator]: TimeSignature): MusicalBeats {
  if (!Number.isSafeInteger(numerator) || numerator <= 0 ||
      !Number.isSafeInteger(denominator) || denominator <= 0 ||
      2 ** Math.round(Math.log2(denominator)) !== denominator) {
    throw new RangeError('Time signature requires a positive integer numerator and power-of-two denominator');
  }
  return numerator * (4 / denominator);
}

export const stepsPerBar = (meter: TimeSignature): number => beatsToSteps(beatsPerBar(meter));
export const beatsToBars = (beats: MusicalBeats, meter: TimeSignature): number => beats / beatsPerBar(meter);
export const barsToBeats = (bars: number, meter: TimeSignature): MusicalBeats => bars * beatsPerBar(meter);

/** Exact conversion only: MIDI writers retain their own rounding/minimum policy. */
export const beatsToMidiTicks = (beats: MusicalBeats, ppq: number): MidiTicks => beats * ppq;
export const midiTicksToBeats = (ticks: MidiTicks, ppq: number): MusicalBeats => ticks / ppq;
export const millisecondsToSeconds = (milliseconds: number): Seconds => milliseconds / 1000;

/** MIDI tempo metadata; keep division before writer rounding (not seconds × 1e6). */
export const bpmToMicrosecondsPerQuarter = (bpm: number): number => 60_000_000 / bpm;
