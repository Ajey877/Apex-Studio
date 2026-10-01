import assert from 'node:assert/strict';
import test from 'node:test';
import { KEY_NOTE_MAP, getKeyboardNotePitch, isNoteInputCode } from './musicalKeyboard';

test('the note map keeps the audited QWERTY piano layout', () => {
  assert.deepEqual(KEY_NOTE_MAP, {
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
    Numpad1: 36,
    Numpad2: 38,
    Numpad3: 42,
    Numpad4: 46,
    Numpad5: 49,
    Numpad6: 39,
    Numpad7: 51,
    Numpad8: 48,
    Numpad9: 45,
  });
});

test('note input is unchanged for the QWERTY row across octave shifts', () => {
  assert.equal(getKeyboardNotePitch('KeyA', 0), 60);
  assert.equal(getKeyboardNotePitch('KeyA', 1), 72);
  assert.equal(getKeyboardNotePitch('KeyA', -1), 48);
  assert.equal(getKeyboardNotePitch('Semicolon', 0), 76);
  assert.equal(getKeyboardNotePitch('KeyW', 2), 85);
});

test('numpad pads never transpose, matching the existing drum-pad behaviour', () => {
  assert.equal(getKeyboardNotePitch('Numpad1', 0), 36);
  assert.equal(getKeyboardNotePitch('Numpad1', 2), 36);
  assert.equal(getKeyboardNotePitch('Numpad9', -2), 45);
});

test('non-note codes resolve to no pitch', () => {
  for (const code of ['KeyN', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'Space', 'F5', 'F11', 'Digit1', 'Escape']) {
    assert.equal(getKeyboardNotePitch(code, 0), null, `${code} must not trigger a note`);
    assert.equal(isNoteInputCode(code), false);
  }
});

test('isNoteInputCode agrees with the note map', () => {
  for (const code of Object.keys(KEY_NOTE_MAP)) {
    assert.equal(isNoteInputCode(code), true);
  }
});
