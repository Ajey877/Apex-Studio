/**
 * The virtual piano keyboard's key-to-pitch map, extracted so the global keydown
 * handler and the application-shell shortcut tests share one source of truth.
 *
 * These codes are only reachable *without* a modifier. Every application menu
 * accelerator requires Ctrl/Cmd, so claiming a modifier combination never takes a
 * note away from the keyboard. Do not add bare-letter application shortcuts.
 */
export const KEY_NOTE_MAP: Record<string, number> = {
  // QWERTY White & Black Piano Keys (C4 to E5)
  KeyA: 60,
  KeyW: 61,
  KeyS: 62,
  KeyE: 63,
  KeyD: 64,
  KeyF: 65,
  KeyT: 66,
  KeyG: 67,
  KeyY: 68,
  KeyH: 69,
  KeyU: 70,
  KeyJ: 71,
  KeyK: 72,
  KeyO: 73,
  KeyL: 74,
  KeyP: 75,
  Semicolon: 76,

  // Numeric Keypad (Numpad 1..9 MPC Drum & Bass triggers)
  Numpad1: 36,
  Numpad2: 38,
  Numpad3: 42,
  Numpad4: 46,
  Numpad5: 49,
  Numpad6: 39,
  Numpad7: 51,
  Numpad8: 48,
  Numpad9: 45
};

export const isNoteInputCode = (code: string): boolean => KEY_NOTE_MAP[code] !== undefined;

/**
 * Resolves the MIDI pitch a physical key triggers, or null when the key is not a
 * note key. Numpad pads are fixed drum triggers and never transpose; the QWERTY
 * row follows the current keyboard octave.
 */
export const getKeyboardNotePitch = (code: string, keyboardOctave: number): number | null => {
  const basePitch = KEY_NOTE_MAP[code];
  if (basePitch === undefined) return null;
  const isNumpad = code.startsWith('Numpad');
  return isNumpad ? basePitch : basePitch + keyboardOctave * 12;
};

/** Velocity the computer keyboard has always played at (legacy `playNote` level). */
export const COMPUTER_KEYBOARD_VELOCITY = 0.95;

/** Voice MIDI channel for computer-keyboard notes (the simulated-input convention). */
export const COMPUTER_KEYBOARD_MIDI_CHANNEL = 1;

/**
 * Structural view of the shared virtual-input bridge
 * (`VirtualMidiInputBridge`), declared locally so this module stays
 * dependency-free. The bridge routes every note-on/off to the live
 * instrument monitor and, while a take is armed, to the MIDI recorder with
 * transport-stamped timing.
 */
export interface KeyboardNoteSink {
  noteOn(pitch: number, options?: { velocity?: number; midiChannel?: number }): void;
  noteOff(pitch: number, options?: { velocity?: number; midiChannel?: number }): void;
}

interface HeldKeyboardNote {
  pitch: number;
  midiChannel: number;
}

/**
 * Held-note bookkeeping for the computer (QWERTY/numpad) musical keyboard.
 *
 * The global key handler delegates note lifecycle to this tracker so
 * computer-keyboard playing uses the SAME shared input pipeline as hardware
 * MIDI and the on-screen piano keys, instead of a direct fixed-duration
 * audition that the recorder could never capture. Responsibilities:
 *
 *  - `press` stores the pitch the handler resolved (via
 *    `getKeyboardNotePitch`) from the octave in effect AT KEYDOWN against
 *    the physical `KeyboardEvent.code`, then sends `noteOn` through the
 *    sink (the virtual-input bridge). A press of an already-held code (OS
 *    key-repeat, duplicate keydown) is a no-op.
 *  - `release` looks up the STORED pitch for the physical code — never the
 *    current octave, which the player may have changed with Z/X mid-hold —
 *    and sends the matching `noteOff`. Releasing a code that is not held
 *    (e.g. the physical keyup arriving after a blur already released it) is
 *    a no-op. When two physical keys hold the same pitch (reachable only
 *    via an octave shift between presses), the pitch keeps sounding until
 *    the last key holding it releases.
 *  - `releaseAll` is the lost-keyup safety net (window blur, unmount): it
 *    sends `noteOff` for every pitch this tracker opened — and only those,
 *    so on-screen keys sharing the bridge are untouched — and clears the
 *    bookkeeping. It is safe when the sink is unavailable (teardown): the
 *    bookkeeping still clears and nothing throws. There is deliberately no
 *    fixed-duration fallback outside the shared input pipeline.
 *  - `forgetAll` drops the bookkeeping WITHOUT sending note-offs, for the
 *    transport-boundary path where the bridge/runtime have already
 *    released every held voice; it keeps a later physical keyup inert.
 */
export class MusicalKeyboardHeldNotes {
  private readonly held = new Map<string, HeldKeyboardNote>();

  constructor(private readonly getSink: () => KeyboardNoteSink | null) {}

  /** Number of physical keys currently held down. */
  get heldCount(): number {
    return this.held.size;
  }

  /**
   * Starts the note for a physical key at the pitch resolved at keydown.
   * Returns `true` when a note was started; `false` for an unusable pitch
   * and for a code that is already held.
   */
  press(code: string, pitch: number): boolean {
    if (this.held.has(code)) return false;
    if (!Number.isFinite(pitch)) return false;
    this.held.set(code, { pitch, midiChannel: COMPUTER_KEYBOARD_MIDI_CHANNEL });
    this.getSink()?.noteOn(pitch, {
      velocity: COMPUTER_KEYBOARD_VELOCITY,
      midiChannel: COMPUTER_KEYBOARD_MIDI_CHANNEL,
    });
    return true;
  }

  /**
   * Stops the note started for a physical key, using the pitch stored at
   * keydown. Returns `true` when the key was held.
   */
  release(code: string): boolean {
    const entry = this.held.get(code);
    if (!entry) return false;
    this.held.delete(code);
    if (!this.isPitchStillHeld(entry)) {
      this.getSink()?.noteOff(entry.pitch, { midiChannel: entry.midiChannel });
    }
    return true;
  }

  /** Sends note-off for every held pitch and clears the bookkeeping. */
  releaseAll(): void {
    const sink = this.getSink();
    const released = new Set<string>();
    for (const entry of this.held.values()) {
      const key = `${entry.midiChannel}:${entry.pitch}`;
      if (released.has(key)) continue;
      released.add(key);
      sink?.noteOff(entry.pitch, { midiChannel: entry.midiChannel });
    }
    this.held.clear();
  }

  /** Clears the bookkeeping without sending note-offs (already released). */
  forgetAll(): void {
    this.held.clear();
  }

  private isPitchStillHeld(entry: HeldKeyboardNote): boolean {
    for (const other of this.held.values()) {
      if (other.pitch === entry.pitch && other.midiChannel === entry.midiChannel) {
        return true;
      }
    }
    return false;
  }
}
