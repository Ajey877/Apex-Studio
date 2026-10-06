import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_THEME, THEME_STORAGE_KEY, normalizeThemeMode, readThemePreference, writeThemePreference } from './theme';

const withWindow = (storage: Storage | null, run: () => void) => {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { localStorage: storage };
  try { run(); } finally {
    if (previous === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = previous;
  }
};

test('UI-03 defaults to the existing dark appearance', () => {
  assert.equal(DEFAULT_THEME, 'dark');
  assert.equal(normalizeThemeMode(undefined), 'dark');
  assert.equal(normalizeThemeMode('invalid'), 'dark');
});

test('UI-03 accepts only light and dark modes', () => {
  assert.equal(normalizeThemeMode('light'), 'light');
  assert.equal(normalizeThemeMode('dark'), 'dark');
  assert.equal(THEME_STORAGE_KEY, 'apex:theme');
});

test('theme preference reads and persists light and dark values', () => {
  let stored: string | null = 'light';
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; },
  } as unknown as Storage;
  withWindow(storage, () => {
    assert.equal(readThemePreference(), 'light');
    writeThemePreference('dark');
    assert.equal(stored, 'dark');
  });
});

test('invalid stored values fall back to dark and storage failures never throw', () => {
  const invalid = { getItem: () => 'sepia', setItem: () => undefined } as unknown as Storage;
  withWindow(invalid, () => assert.equal(readThemePreference(), 'dark'));
  const throwing = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  } as unknown as Storage;
  withWindow(throwing, () => {
    assert.equal(readThemePreference(), 'dark');
    assert.doesNotThrow(() => writeThemePreference('light'));
  });
  withWindow(null, () => {
    assert.equal(readThemePreference(), 'dark');
    assert.doesNotThrow(() => writeThemePreference('light'));
  });
});

test('theme preference is independent from project state', () => {
  assert.notEqual(THEME_STORAGE_KEY, 'projectState');
  assert.notEqual(THEME_STORAGE_KEY, 'apex:project');
});
