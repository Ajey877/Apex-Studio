/**
 * MIDI performance recording into the Piano Roll.
 *
 * This is the capture half of the hardware-MIDI workflow. It consumes the
 * audio engine's *existing* MIDI listener stream (the same normalized
 * `MidiEventPayload`s the live instrument bridge in `midiMappingRuntime`
 * consumes) — it never opens a second Web MIDI system, and live monitoring
 * stays with `MidiNoteInputRuntime`, which runs alongside it.
 *
 * Timing contract
 * ---------------
 * Notes are never timed from React renders or button clicks. Every event is
 * stamped by the caller with a `MidiRecordingClock` sampled from the audio
 * engine's AudioContext transport at message arrival
 * (`AudioEngine.getTransportMusicalPosition()`): the transport's continuous
 * `positionSeconds`, converted through the *project* tempo
 * (`secondsToBeats(positionSeconds, bpm) * 4` sixteenth steps). There is no
 * default or fixed tempo anywhere in this module: a take started at 90 BPM
 * and the same wall-clock performance at 180 BPM produce different step
 * positions, and the unit tests pin that.
 *
 * The transport position is continuous (unwrapped), so a note held across a
 * pattern loop keeps its true duration; only its start is folded into the
 * target pattern (`absoluteStep % patternLengthSteps`). A note whose gate
 * would run past the pattern end is clamped to the pattern end, and a gate
 * shorter than the shared minimum note duration
 * (`MIN_NOTE_DURATION_STEPS`, Phase 1D) is raised to that minimum — recorded
 * data therefore always satisfies the Piano Roll note contract and never
 * contains a zero-length note.
 *
 * Note ownership
 * --------------
 * Open notes are keyed by `${midiChannel}:${pitch}`: the same pitch held on
 * two MIDI channels is two notes, a repeated strike of an already-open key
 * finalizes the previous gate first (matching the live bridge, which stops
 * the sustaining voice before retriggering), and a note-off only closes the
 * gate opened on its own channel. Velocity-zero note-ons are note-offs, as
 * in the engine's raw decoder and the live bridge.
 *
 * Captured notes are plain `Note`s in the existing schema. They are held
 * inside the recorder — not written to project state — until the take is
 * finalized (`stop` / `handleDeviceDisconnect`), at which point the caller
 * commits them in ONE project-history entry through
 * `appendRecordedNotesToChannelInProjectState`, so a whole take undoes and
 * redoes as a unit and is never half-written by an interrupted stream.
 * No quantization is applied: captured timing is preserved as performed.
 */

import type { Note, ProjectState } from '../types/daw';
import type { MidiEventPayload } from './audioEngine';
import { secondsToBeats, SIXTEENTH_STEPS_PER_BEAT } from '../music/musicalTime';
import { MIN_NOTE_DURATION_STEPS } from '../music/noteDurationPolicy';
import { updateChannelInProjectState } from '../state/projectMutations';
import { updatePatternChannelContentInProjectState } from '../state/patternContent';

/** The explicit destination of a take, captured when recording starts. */
export interface MidiRecordingTarget {
  channelId: string;
  patternId: string;
  /** Declared `Pattern.lengthSteps` of the target pattern at take start. */
  patternLengthSteps: number;
  /** Project tempo (`ProjectMetadata.bpm`) at take start. */
  bpm: number;
}

/**
 * Musical clock sampled at MIDI-message arrival. `positionSteps` is the
 * transport's continuous (unwrapped) sixteenth-step position.
 */
export interface MidiRecordingClock {
  positionSteps: number;
}

export type MidiRecordingEventStatus =
  | 'note_opened'
  | 'note_closed'
  | 'retriggered'
  | 'ignored';

export interface MidiRecordingEventResult {
  status: MidiRecordingEventStatus;
  pitch?: number;
  midiChannel?: number;
}

interface OpenRecordedNote {
  pitch: number;
  midiChannel: number;
  velocity: number;
  /** Continuous (unwrapped) step position of the note-on. */
  startAbsoluteSteps: number;
  sequence: number;
}

const roundSteps = (value: number): number => Number(value.toFixed(6));

const clampMidiChannel = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(16, Math.round(value)))
    : 1;

const clampPitch = (value: number): number => Math.max(0, Math.min(127, Math.round(value)));

/**
 * Converts an AudioContext-transport position into continuous steps through
 * the project tempo. This is the single seconds->steps mapping recording
 * uses; the engine calls it when stamping incoming MIDI events.
 */
export const transportPositionToSteps = (positionSeconds: number, bpm: number): number => {
  if (!Number.isFinite(positionSeconds) || !Number.isFinite(bpm) || bpm <= 0) return 0;
  return Math.max(0, secondsToBeats(positionSeconds, bpm) * SIXTEENTH_STEPS_PER_BEAT);
};

/**
 * Appends finalized recorded notes to a channel's Piano Roll notes through
 * the project mutation layer. Returns the identical state object when there
 * is nothing to commit (empty take, unknown channel or pattern), so callers
 * record no phantom history entry. Existing notes — in this and every other
 * channel — are preserved untouched and in order.
 *
 * Independent patterns: with `patternId` (the take's target pattern, captured
 * at take start) the notes land in THAT pattern even when the user selected a
 * different pattern before the take was finalized — the live channel when it
 * is still selected, its stored content otherwise. Without it, the notes go to
 * the live channel content (the selected pattern), the historical contract.
 */
export const appendRecordedNotesToChannelInProjectState = (
  state: ProjectState,
  channelId: string,
  notes: readonly Note[],
  patternId?: string,
): ProjectState => {
  if (notes.length === 0) return state;
  const channel = state.channels.find(candidate => candidate.id === channelId);
  if (!channel) return state;
  const recorded = notes.map(note => ({ ...note }));
  if (patternId !== undefined) {
    return updatePatternChannelContentInProjectState(state, patternId, channelId, current => ({
      notes: [...current.notes.map(note => ({ ...note })), ...recorded],
    }));
  }
  return updateChannelInProjectState(state, channelId, {
    notes: [...(channel.notes ?? []), ...recorded],
  });
};

export interface MidiPerformanceRecorderOptions {
  /** Deterministic note-id source for tests; defaults to a take-scoped counter. */
  createNoteId?: (sequence: number) => string;
}

/**
 * One recorder instance serves the app for its lifetime; each take is a
 * `start` … `stop` cycle. The recorder holds no project state and performs
 * no mutation — finalization only *returns* notes.
 */
export class MidiPerformanceRecorder {
  private target: MidiRecordingTarget | null = null;
  private readonly openNotes = new Map<string, OpenRecordedNote>();
  private completedNotes: Note[] = [];
  private sequence = 0;
  private readonly createNoteId: (sequence: number) => string;

  constructor(options: MidiPerformanceRecorderOptions = {}) {
    this.createNoteId = options.createNoteId ?? (sequence => `midi-rec-${sequence}`);
  }

  get isRecording(): boolean {
    return this.target !== null;
  }

  get activeTarget(): MidiRecordingTarget | null {
    return this.target ? { ...this.target } : null;
  }

  /** Notes still held down (no note-off yet). */
  get openNoteCount(): number {
    return this.openNotes.size;
  }

  /** Completed gates captured so far in this take (not yet committed). */
  get capturedNoteCount(): number {
    return this.completedNotes.length + this.openNotes.size;
  }

  /**
   * Begins a take against an explicit target. Starting while a take is
   * already running is a no-op (`false`): the running take keeps its
   * original channel, pattern and tempo rather than being silently
   * retargeted mid-performance.
   */
  start(target: MidiRecordingTarget, _clock: MidiRecordingClock): boolean {
    if (this.target) return false;
    if (!target.channelId || !target.patternId) return false;
    if (!Number.isFinite(target.patternLengthSteps) || target.patternLengthSteps <= 0) return false;
    if (!Number.isFinite(target.bpm) || target.bpm <= 0) return false;
    this.target = { ...target, patternLengthSteps: Math.floor(target.patternLengthSteps) };
    this.openNotes.clear();
    this.completedNotes = [];
    this.sequence = 0;
    return true;
  }

  handleMidiEvent(
    event: MidiEventPayload | null | undefined,
    clock: MidiRecordingClock,
  ): MidiRecordingEventResult {
    if (!this.target || !event || (event.type !== 'noteOn' && event.type !== 'noteOff')) {
      return { status: 'ignored' };
    }
    if (typeof event.note !== 'number' || !Number.isFinite(event.note)) {
      return { status: 'ignored' };
    }
    const positionSteps = Number.isFinite(clock?.positionSteps)
      ? Math.max(0, clock.positionSteps)
      : 0;
    const pitch = clampPitch(event.note);
    const midiChannel = clampMidiChannel(event.midiChannel);
    const key = `${midiChannel}:${pitch}`;

    const isNoteOff =
      event.type === 'noteOff' ||
      (event.type === 'noteOn' && typeof event.velocity === 'number' && event.velocity <= 0);

    if (isNoteOff) {
      let open = this.openNotes.get(key);
      let openKey = key;
      if (!open && event.midiChannel === undefined) {
        // Channel-less simulated/off-spec sources close the first matching pitch.
        for (const [candidateKey, candidate] of this.openNotes.entries()) {
          if (candidate.pitch === pitch) {
            open = candidate;
            openKey = candidateKey;
            break;
          }
        }
      }
      if (!open) return { status: 'ignored', pitch, midiChannel };
      this.openNotes.delete(openKey);
      this.finalize(open, positionSteps);
      return { status: 'note_closed', pitch, midiChannel: open.midiChannel };
    }

    const retriggered = this.openNotes.has(key);
    if (retriggered) {
      const previous = this.openNotes.get(key)!;
      this.openNotes.delete(key);
      this.finalize(previous, positionSteps);
    }
    const velocity =
      typeof event.velocity === 'number' && Number.isFinite(event.velocity)
        ? Math.max(1 / 127, Math.min(1, event.velocity))
        : 0.8;
    this.openNotes.set(key, {
      pitch,
      midiChannel,
      velocity,
      startAbsoluteSteps: positionSteps,
      sequence: this.sequence++,
    });
    return { status: retriggered ? 'retriggered' : 'note_opened', pitch, midiChannel };
  }

  /**
   * Ends the take: every still-held note is finalized at the stop position
   * (never left open, never zero-length) and the captured notes are returned
   * in performed order for a single history commit. Safe to call when no
   * take is running — it returns no notes.
   */
  stop(clock: MidiRecordingClock): Note[] {
    if (!this.target) return [];
    const positionSteps = Number.isFinite(clock?.positionSteps)
      ? Math.max(0, clock.positionSteps)
      : 0;
    for (const open of this.openNotes.values()) {
      this.finalize(open, positionSteps);
    }
    this.openNotes.clear();
    const notes = this.completedNotes;
    this.completedNotes = [];
    this.target = null;
    return notes;
  }

  /**
   * A device disappearing mid-take finalizes exactly like a stop: held gates
   * are closed at the disconnect position instead of hanging forever. The
   * caller commits the returned notes and releases the live voices.
   */
  handleDeviceDisconnect(clock: MidiRecordingClock): Note[] {
    return this.stop(clock);
  }

  /** Discards the take without producing notes (project replacement, teardown). */
  cancel(): void {
    this.openNotes.clear();
    this.completedNotes = [];
    this.target = null;
  }

  private finalize(open: OpenRecordedNote, endAbsoluteSteps: number): void {
    const target = this.target;
    if (!target) return;
    const patternLength = target.patternLengthSteps;
    const start = roundSteps(open.startAbsoluteSteps % patternLength);
    const rawDuration = Math.max(0, endAbsoluteSteps - open.startAbsoluteSteps);
    const roomInPattern = Math.max(0, patternLength - start);
    if (roomInPattern <= 0) return;
    const duration = roundSteps(
      Math.min(Math.max(rawDuration, MIN_NOTE_DURATION_STEPS), roomInPattern),
    );
    if (!(duration > 0)) return;
    this.completedNotes.push({
      id: this.createNoteId(open.sequence),
      pitch: open.pitch,
      start,
      duration,
      velocity: open.velocity,
    });
    // Performed order: by absolute onset, then by arrival sequence for
    // simultaneous onsets (chords keep their played ordering).
    this.completedNotes.sort((a, b) => {
      const byStart = a.start - b.start;
      return byStart !== 0 ? byStart : 0;
    });
  }
}
