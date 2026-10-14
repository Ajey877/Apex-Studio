/**
 * Virtual MIDI input bridge for touch / pointer recording.
 *
 * This is the single, framework-agnostic shared abstraction that lets the app's
 * existing on-screen note controls (the Piano Roll virtual piano keys today, and
 * any future pointer-driven key) feed the SAME normalized event path the hardware
 * recorder already consumes — without synthesizing fake external hardware events
 * and without duplicating the MIDI recording engine.
 *
 * For every virtual note-on / note-off it emits a `MidiEventPayload` of the
 * exact shape `audioEngine` delivers for real hardware bytes, then routes it to:
 *   1. the live instrument monitor (`MidiNoteInputRuntime`) — identical to how a
 *      hardware note is monitored/auditioned, so live sound is preserved;
 *   2. the `MidiPerformanceRecorder`, but ONLY while a take is armed. The
 *      recorder stamps the event from the AudioContext transport itself, so
 *      captured timing matches a hardware performance of the same gestures.
 *
 * Design constraints it honours (see the task brief):
 *  - It never opens a Web MIDI system and never calls `audioEngine.addMidiListener`;
 *    virtual events therefore do NOT reach MIDI Learn / CC mapping or any other
 *    hardware listener, and physical MIDI input behaviour is untouched.
 *  - It holds no project state and performs no mutation: capture stays entirely
 *    with `MidiPerformanceRecorder`, finalization/commit with the caller.
 *  - There is no automatic note-off. Callers own the pointer lifecycle and MUST
 *    call `noteOff` (or `releaseAll`) on release / cancellation / unmount, so a
 *    missed pointer-up cannot leave a stuck voice or a stuck recorded note.
 */

import type { MidiRecordingClock } from './midiRecording';
import type { MidiEventPayload } from './audioEngine';

/** Live instrument monitor (audition). Mirrors `MidiNoteInputRuntime`. */
export interface VirtualMidiLiveMonitor {
  handleMidiEvent(event: MidiEventPayload): unknown;
}

/** Recorder (capture). Mirrors `MidiPerformanceRecorder`. */
export interface VirtualMidiRecorder {
  readonly isRecording: boolean;
  handleMidiEvent(event: MidiEventPayload, clock: MidiRecordingClock): unknown;
}

/** Ports the bridge needs. All are lazy getters so refs can populate post-mount. */
export interface VirtualMidiInputBridgePorts {
  /** Live instrument monitor. May be `null` during teardown. */
  getLiveMonitor: () => VirtualMidiLiveMonitor | null;
  /** Recorder (capture). May be `null` during teardown. */
  getRecorder: () => VirtualMidiRecorder | null;
  /** Transport musical position used to stamp recorded events. */
  getClock: () => MidiRecordingClock;
}

export interface VirtualMidiNoteOptions {
  /** Normalized velocity 0..1. Defaults to 0.9 (the legacy audition level). */
  velocity?: number;
  /** Voice MIDI channel 1..16. Defaults to 1 (the off-spec/simulated convention). */
  midiChannel?: number;
}

const clampMidiChannel = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1, Math.min(16, Math.round(value)))
    : 1;

const clampVelocity = (value: number | undefined): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(1 / 127, Math.min(1, value))
    : 0.9;

interface HeldVirtualKey {
  pitch: number;
  midiChannel: number;
}

/**
 * Routes virtual note-on/off into the live monitor and (when armed) the recorder
 * through the identical `MidiEventPayload` the hardware path uses.
 */
export class VirtualMidiInputBridge {
  // Keys this bridge has opened, keyed by `${midiChannel}:${pitch}`, so `noteOff`
  // and `releaseAll` only ever close notes the bridge itself started.
  private readonly heldKeys = new Map<string, HeldVirtualKey>();

  constructor(private readonly ports: VirtualMidiInputBridgePorts) {}

  /** True only while a MIDI take is armed — virtual input never records otherwise. */
  get isRecording(): boolean {
    return this.ports.getRecorder()?.isRecording ?? false;
  }

  noteOn(pitch: number, options: VirtualMidiNoteOptions = {}): void {
    const midiChannel = clampMidiChannel(options.midiChannel);
    const velocity = clampVelocity(options.velocity);
    const key = `${midiChannel}:${pitch}`;
    // A re-press of an already-held key is a legitimate retrigger; the underlying
    // runtimes finalize the previous gate. We still track it so `noteOff` can
    // release it and the held count stays accurate.
    this.heldKeys.set(key, { pitch, midiChannel });
    this.route({ type: 'noteOn', note: pitch, velocity, midiChannel });
  }

  noteOff(pitch: number, options: VirtualMidiNoteOptions = {}): void {
    const midiChannel = clampMidiChannel(options.midiChannel);
    const key = `${midiChannel}:${pitch}`;
    const held = this.heldKeys.get(key);
    if (!held) return; // never release a note this bridge did not open
    this.heldKeys.delete(key);
    this.route({ type: 'noteOff', note: pitch, midiChannel });
  }

  /** Releases every key this bridge currently holds (teardown / cancellation). */
  releaseAll(): void {
    for (const held of this.heldKeys.values()) {
      this.route({ type: 'noteOff', note: held.pitch, midiChannel: held.midiChannel });
    }
    this.heldKeys.clear();
  }

  /** Number of virtual keys currently held down. */
  get heldCount(): number {
    return this.heldKeys.size;
  }

  private route(event: MidiEventPayload): void {
    this.ports.getLiveMonitor()?.handleMidiEvent(event);
    const recorder = this.ports.getRecorder();
    if (recorder?.isRecording) {
      recorder.handleMidiEvent(event, this.ports.getClock());
    }
  }
}
