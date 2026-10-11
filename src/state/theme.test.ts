import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_THEME,
  THEME_MODES,
  THEME_STORAGE_KEY,
  applyThemeToDocument,
  isThemeMode,
  normalizeThemeMode,
  readThemePreference,
  writeThemePreference,
} from './theme';

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
  assert.deepEqual([...THEME_MODES], ['dark', 'light']);
});

test('isThemeMode accepts exactly the two supported modes and nothing else', () => {
  assert.equal(isThemeMode('dark'), true);
  assert.equal(isThemeMode('light'), true);
  for (const rejected of ['Dark', 'LIGHT', 'system', 'auto', '', null, undefined, 0, 1, true, {}, []]) {
    assert.equal(isThemeMode(rejected), false, `${String(rejected)} is not a theme mode`);
  }
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

/**
 * UI-03A — the pre-paint contract.
 *
 * `applyThemeToDocument` is the only place a theme mode becomes a document
 * attribute. The pre-paint script in index.html applies the same rule before
 * React mounts, so these assertions stand in for both callers.
 */
test('applyThemeToDocument writes the normalised mode onto the document root', () => {
  const dataset: Record<string, string | undefined> = {};
  const applied = applyThemeToDocument('light', { documentElement: { dataset } });
  assert.equal(applied, 'light');
  assert.equal(dataset.theme, 'light');

  applyThemeToDocument('dark', { documentElement: { dataset } });
  assert.equal(dataset.theme, 'dark');
});

test('applyThemeToDocument normalises an invalid or missing mode to dark', () => {
  for (const invalid of ['sepia', '', null, undefined, 42, {}, 'Dark']) {
    const dataset: Record<string, string | undefined> = { theme: 'light' };
    const applied = applyThemeToDocument(invalid, { documentElement: { dataset } });
    assert.equal(applied, 'dark', `${String(invalid)} must resolve to the default theme`);
    assert.equal(dataset.theme, 'dark');
  }
});

test('applyThemeToDocument survives a missing or hostile document', () => {
  assert.equal(applyThemeToDocument('light', null), 'light');
  assert.equal(applyThemeToDocument('light', undefined as never), 'light');
  assert.equal(applyThemeToDocument('light', {}), 'light');

  const hostile = {
    get documentElement(): never { throw new Error('detached'); },
  };
  assert.doesNotThrow(() => applyThemeToDocument('light', hostile));
  assert.equal(applyThemeToDocument('light', hostile), 'light');

  const frozen = {
    documentElement: {
      get dataset(): never { throw new Error('sealed'); },
    },
  };
  assert.doesNotThrow(() => applyThemeToDocument('dark', frozen));
});

test('every theme mode round-trips through storage and the document root', () => {
  let stored: string | null = null;
  const storage = {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; },
  } as unknown as Storage;
  for (const mode of THEME_MODES) {
    const dataset: Record<string, string | undefined> = {};
    withWindow(storage, () => {
      writeThemePreference(mode);
      applyThemeToDocument(mode, { documentElement: { dataset } });
      assert.equal(stored, mode, `${mode} must persist under ${THEME_STORAGE_KEY}`);
      assert.equal(dataset.theme, mode, `${mode} must reach the document root`);
    });
  }
});
