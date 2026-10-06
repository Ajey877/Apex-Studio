import assert from 'node:assert/strict';
import test from 'node:test';
import {
  THEME_CHANGE_EVENT,
  THEME_PREFERENCE_KEY,
  announceThemeChange,
  applyThemeToDocument,
  loadThemePreference,
  normalizeTheme,
  writeThemePreference,
} from './themePreference';

/**
 * UI-03 Phase 0 — theme preference contract (RED until Phase 1 lands).
 *
 * The theme is an application preference, never project content:
 * - a namespaced `apex:theme` localStorage key, project-independent (same
 *   discipline as workspaceLayout.ts — it must never enter ProjectState or the
 *   IndexedDB project documents),
 * - safe parsing that defaults to dark for anything unrecognized,
 * - graceful behavior when window/storage are unavailable (SSR, node test
 *   environment, privacy mode, quota errors) — the app must never crash on a
 *   preference it cannot read or write,
 * - initial application through `document.documentElement.dataset.theme` so
 *   the CSS `:root[data-theme="light"]` scope can take effect before paint.
 *
 * Repo convention (no jsdom in the tsx suite): every behaviour is covered
 * through small injected fakes. The functions under test accept their
 * environment as an optional parameter and default to the real globals.
 */

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface WindowLike {
  localStorage?: StorageLike;
}

interface DocumentLike {
  documentElement: { dataset: Record<string, string> };
}

const makeStorage = (
  initial: Record<string, string> = {}
): { storage: StorageLike; items: Map<string, string> } => {
  const items = new Map(Object.entries(initial));
  const storage: StorageLike = {
    getItem: key => (items.has(key) ? items.get(key)! : null),
    setItem: (key, value) => {
      items.set(key, String(value));
    },
  };
  return { storage, items };
};

const makeThrowingStorage = (phase: 'get' | 'set' = 'get'): StorageLike => ({
  getItem: () => {
    if (phase === 'get') throw new Error('Storage access is blocked');
    return null;
  },
  setItem: () => {
    if (phase === 'set') throw new Error('Quota exceeded');
  },
});

const makeDocument = (): DocumentLike => ({ documentElement: { dataset: {} } });

// --- key -------------------------------------------------------------------

test('the theme preference uses the namespaced apex:theme key', () => {
  assert.equal(THEME_PREFERENCE_KEY, 'apex:theme');
});

// --- normalization -----------------------------------------------------------

test('normalizeTheme accepts the two valid modes', () => {
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('light'), 'light');
});

test('normalizeTheme is case-insensitive and trims whitespace', () => {
  assert.equal(normalizeTheme('LIGHT'), 'light');
  assert.equal(normalizeTheme(' Dark '), 'dark');
  assert.equal(normalizeTheme(' lIghT '), 'light');
});

test('normalizeTheme falls back to dark for anything unrecognized', () => {
  const invalid: unknown[] = [
    undefined,
    null,
    '',
    'system',
    'neon',
    'black',
    'dark-mode',
    'lighter',
    0,
    1,
    true,
    {},
    [],
  ];
  for (const value of invalid) {
    assert.equal(normalizeTheme(value), 'dark', `expected dark fallback for ${JSON.stringify(value)}`);
  }
});

// --- persistence: read --------------------------------------------------------

test('loadThemePreference defaults to dark when there is no window (node/SSR)', () => {
  assert.equal(typeof window, 'undefined', 'the tsx suite runs without a window global');
  assert.equal(loadThemePreference(), 'dark');
});

test('loadThemePreference defaults to dark for empty, missing, or malformed storage', () => {
  assert.equal(loadThemePreference({} as WindowLike), 'dark');
  const { storage } = makeStorage();
  assert.equal(loadThemePreference({ localStorage: storage }), 'dark');
  const { storage: garbage } = makeStorage({ 'apex:theme': 'neon' });
  assert.equal(loadThemePreference({ localStorage: garbage }), 'dark');
  const { storage: normalized } = makeStorage({ 'apex:theme': ' LIGHT ' });
  assert.equal(loadThemePreference({ localStorage: normalized }), 'light');
});

test('loadThemePreference survives an inaccessible localStorage', () => {
  assert.equal(loadThemePreference({ localStorage: makeThrowingStorage('get') }), 'dark');
});

// --- persistence: write ---------------------------------------------------------

test('writeThemePreference stores the raw mode under the namespaced key', () => {
  const { storage, items } = makeStorage();
  writeThemePreference('light', { localStorage: storage });
  assert.equal(items.get('apex:theme'), 'light');
  writeThemePreference('dark', { localStorage: storage });
  assert.equal(items.get('apex:theme'), 'dark');
});

test('writeThemePreference is a safe no-op without window, storage, or quota', () => {
  assert.doesNotThrow(() => writeThemePreference('light'));
  assert.doesNotThrow(() => writeThemePreference('light', {} as WindowLike));
  assert.doesNotThrow(() => writeThemePreference('light', { localStorage: makeThrowingStorage('set') }));
});

test('write then load round-trips the preference', () => {
  const { storage } = makeStorage();
  const win = { localStorage: storage } as WindowLike;
  writeThemePreference('light', win);
  assert.equal(loadThemePreference(win), 'light');
  writeThemePreference('dark', win);
  assert.equal(loadThemePreference(win), 'dark');
});

// --- initial application --------------------------------------------------------

test('applyThemeToDocument activates the light scope via data-theme="light"', () => {
  const doc = makeDocument();
  applyThemeToDocument('light', doc);
  assert.equal(doc.documentElement.dataset.theme, 'light');
});

test('applyThemeToDocument returns to the default (dark) scope by removing the attribute', () => {
  const doc = makeDocument();
  applyThemeToDocument('light', doc);
  applyThemeToDocument('dark', doc);
  assert.equal('theme' in doc.documentElement.dataset, false, 'dark is the default scope; the attribute must be removed, not set to "dark"');
});

test('applyThemeToDocument is a safe no-op without a document', () => {
  assert.doesNotThrow(() => applyThemeToDocument('light'));
});

// --- theme change announcement (canvas integration, Phase 4) -----------------

test('announceThemeChange dispatches apex:themechange with the theme detail', () => {
  const seen: Array<{ type: string; detail: unknown }> = [];
  const win = {
    dispatchEvent: (event: Event) => {
      seen.push({ type: event.type, detail: (event as { detail?: unknown }).detail });
      return true;
    },
  };
  announceThemeChange('light', win);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'apex:themechange');
  assert.equal(THEME_CHANGE_EVENT, 'apex:themechange');
  assert.deepEqual(seen[0].detail, { theme: 'light' });
});

test('announceThemeChange is a safe no-op without a window', () => {
  assert.doesNotThrow(() => announceThemeChange('dark'));
});
