/**
 * UI-03 Phase 1: Theme preference — persistent, validated, project-independent.
 *
 * The theme is an application preference, never project content:
 * - stored in localStorage under the single namespaced key `apex:theme`
 *   (same discipline as workspaceLayout.ts: never in ProjectState, never in
 *   the IndexedDB project documents, never changing the persistence version),
 * - parsed with a safe dark fallback for anything unrecognized,
 * - readable/writable even when the browser environment is hostile (no
 *   window, no localStorage, privacy mode, quota errors) — a preference must
 *   never crash the application,
 * - applied to the document root as `data-theme="light"` for light mode.
 *   Dark is the default (unmarked) scope, so switching back to dark removes
 *   the attribute rather than setting a second value.
 */

export type ThemeMode = 'dark' | 'light';

export const THEME_PREFERENCE_KEY = 'apex:theme';

/** Fired on window whenever the applied theme changes (canvas consumers re-read the palette). */
export const THEME_CHANGE_EVENT = 'apex:themechange';

export interface ThemeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ThemeWindow {
  localStorage?: ThemeStorage;
}

export interface ThemeDocument {
  documentElement: { dataset: Record<string, string> };
}

export interface ThemeEventTarget {
  dispatchEvent: (event: Event) => boolean;
}

/**
 * Coerces an unknown stored value into a valid theme. Only the two valid
 * modes survive, case-insensitively and trimmed; everything else (missing,
 * malformed, unsupported like 'system', non-strings) falls back to dark.
 */
export const normalizeTheme = (value: unknown): ThemeMode => {
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'dark' || v === 'light') return v;
  }
  return 'dark';
};

const resolveWindow = (win?: ThemeWindow | null): ThemeWindow | null => {
  if (win !== undefined && win !== null) return win;
  if (typeof window !== 'undefined') return window as unknown as ThemeWindow;
  return null;
};

/**
 * Reads the stored theme preference. Returns 'dark' when there is no window,
 * no storage, nothing stored, or storage throws — the default theme is always
 * a safe answer.
 */
export const loadThemePreference = (win?: ThemeWindow | null): ThemeMode => {
  const target = resolveWindow(win);
  try {
    if (!target || !target.localStorage) return 'dark';
    const raw = target.localStorage.getItem(THEME_PREFERENCE_KEY);
    if (raw === null) return 'dark';
    return normalizeTheme(raw);
  } catch {
    return 'dark';
  }
};

/**
 * Persists the theme preference. A safe no-op when the window or storage is
 * unavailable or the write fails (quota, privacy mode) — never throws.
 */
export const writeThemePreference = (mode: ThemeMode, win?: ThemeWindow | null): void => {
  const target = resolveWindow(win);
  try {
    if (!target || !target.localStorage) return;
    target.localStorage.setItem(THEME_PREFERENCE_KEY, mode);
  } catch {
    // Inaccessible localStorage — silently ignore, do not crash.
  }
};

/**
 * Applies the theme to the document root. Light sets `data-theme="light"`;
 * dark removes the attribute because the default (unmarked) CSS scope is the
 * dark Midnight Aurora palette. Safe no-op without a document (node/SSR).
 */
export const applyThemeToDocument = (mode: ThemeMode, doc?: ThemeDocument | null): void => {
  let target = doc;
  if (target === undefined) {
    target = typeof document !== 'undefined' ? (document as unknown as ThemeDocument) : null;
  }
  try {
    if (!target) return;
    if (mode === 'light') {
      target.documentElement.dataset.theme = 'light';
    } else {
      delete target.documentElement.dataset.theme;
    }
  } catch {
    // Headless environment — theme application is best-effort.
  }
};

/**
 * Announces a theme change on the window so canvas-based visualizations can
 * re-read the CSS-variable palette and redraw (Phase 4). Safe no-op without
 * a dispatchable target.
 */
export const announceThemeChange = (mode: ThemeMode, target?: ThemeEventTarget | null): void => {
  let destination: ThemeEventTarget | null = target;
  if (destination === undefined) {
    destination = typeof window !== 'undefined' ? (window as unknown as ThemeEventTarget) : null;
  }
  try {
    if (!destination) return;
    const detail = { theme: mode };
    const event: Event =
      typeof CustomEvent !== 'undefined'
        ? new CustomEvent(THEME_CHANGE_EVENT, { detail })
        : Object.assign(new Event(THEME_CHANGE_EVENT), { detail });
    destination.dispatchEvent(event);
  } catch {
    // Detached or headless environment — canvas consumers re-read on their
    // next scheduled draw instead.
  }
};
