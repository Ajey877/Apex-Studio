/**
 * Canonical musical-time arithmetic. One beat is always a QUARTER NOTE;
 * one legacy sixteenth-note step is 0.25 beats, independent of meter.
 *
 * No project/audio/UI imports, quantization, BPM clamping or fallback policy.
 * Existing callers own their validation (engine: 20–300 BPM; standalone
 * transport: 20–999). Signed quantities are useful for offsets. IEEE-754
 * NaN/Infinity propagation is intentional: this layer must not silently repair
 * malformed legacy input or introduce exceptions into existing scheduling.
 * Meter validation is explicit because meter arithmetic is a new API.
 * Phase 1F: runtime consumers resolve the project meter through
 * `resolveProjectTimeSignature()` (supported meters run at their own bar size;
 * missing/unsupported metadata keeps the LEGACY_TIME_SIGNATURE 4/4 grid).
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

/**
 * Phase 1F — meters the runtime executes truthfully at their own bar size.
 *
 * `stepsPerBar(meter)` of one of these values is the authoritative runtime bar
 * size for transport, pattern/song playback, playlist scheduling, offline
 * render, bounce, recording timing and MIDI export:
 *
 *   [4, 4]  16 sixteenth-note steps per bar (the legacy grid);
 *   [3, 4]  12 sixteenth-note steps per bar (3 quarter-note beats);
 *   [6, 8]  MECHANICAL support only: 12 sixteenth-note steps per bar, three
 *           quarter-note beats. There is deliberately NO dotted-quarter beat
 *           grouping, NO 2+3/3+2 subdivision and NO compound beat display —
 *           the runtime treats it as a 12-step bar until a future phase adds
 *           true compound-meter behaviour.
 *
 * Every other stored meter ([7, 8], [5, 4], [2, 4], …) is explicitly DEFERRED:
 * irregular beat grouping is not implemented and the Phase 1A pinned MIDI
 * contract still requires the legacy grid for them, so they resolve to the
 * documented [4, 4] legacy behaviour instead of being half-truthful.
 */
export const isRuntimeSupportedMeter = (candidate: unknown): candidate is TimeSignature => {
  if (!Array.isArray(candidate) || candidate.length !== 2) return false;
  const [numerator, denominator] = candidate;
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) return false;
  if (numerator === 4 && denominator === 4) return true;
  if (numerator === 3 && denominator === 4) return true;
  if (numerator === 6 && denominator === 8) return true;
  return false;
};

/**
 * Phase 1F — the single meter resolution authority.
 *
 * Returns the project's actual runtime `TimeSignature`: the stored value when
 * it is a supported meter, otherwise the [4, 4] legacy fallback. Missing or
 * legacy metadata (no `timeSignature` field at all) therefore keeps behaving
 * exactly like 4/4 — the pre-Phase-1F behaviour — and unsupported values can
 * never put the runtime on a half-implemented grid.
 *
 * Pure: never mutates the supplied metadata and never touches pattern data
 * (`Pattern.lengthSteps` stays an absolute step quantity regardless of meter).
 */
export function resolveProjectTimeSignature(
  meta: { timeSignature?: unknown } | null | undefined
): TimeSignature {
  const candidate = meta !== null && typeof meta === 'object'
    ? (meta as { timeSignature?: unknown }).timeSignature
    : undefined;
  if (isRuntimeSupportedMeter(candidate)) {
    return Object.freeze([candidate[0], candidate[1]] as const);
  }
  return LEGACY_TIME_SIGNATURE;
}
