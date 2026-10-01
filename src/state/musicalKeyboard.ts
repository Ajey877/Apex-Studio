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
