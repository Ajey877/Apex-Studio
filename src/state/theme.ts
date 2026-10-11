export type ThemeMode = 'dark' | 'light';

/** UI-03A: the user's explicit selection is the only authority for the theme. */
export const THEME_STORAGE_KEY = 'apex:theme';
export const DEFAULT_THEME: ThemeMode = 'dark';
export const THEME_MODES: readonly ThemeMode[] = ['dark', 'light'];

/**
 * The document shape the theme writer needs. Structural on purpose so the same
 * function works against the real DOM, a test double, or nothing at all.
 */
export interface ThemeDocument {
  readonly documentElement?: { dataset: Record<string, string | undefined> } | null;
}

export const isThemeMode = (value: unknown): value is ThemeMode =>
  value === 'dark' || value === 'light';

export const normalizeThemeMode = (value: unknown): ThemeMode =>
  isThemeMode(value) ? value : DEFAULT_THEME;

export const readThemePreference = (): ThemeMode => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_THEME;
    return normalizeThemeMode(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
};

export const writeThemePreference = (mode: ThemeMode): void => {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(THEME_STORAGE_KEY, mode);
    }
  } catch {
    // Storage is optional; the in-memory theme remains authoritative.
  }
};

/**
 * Applies a theme to the document root, which is where every themed surface
 * resolves `:root[data-theme="…"]` from.
 *
 * The DOM write is deliberately small and non-throwing: a locked-down or
 * partially available document must never take the application down, and the
 * pre-paint bootstrap in `index.html` follows exactly this rule. The single
 * normalisation point means an invalid value can only ever resolve to the
 * default dark palette.
 */
export const applyThemeToDocument = (
  mode: unknown,
  doc: ThemeDocument | null | undefined = typeof document === 'undefined' ? null : document
): ThemeMode => {
  const applied = normalizeThemeMode(mode);
  try {
    const root = doc?.documentElement;
    if (root) root.dataset.theme = applied;
  } catch {
    // A root we cannot write to must not break startup; the CSS defaults to dark.
  }
  return applied;
};

/**
 * The complete effect of choosing a theme, in the order the user experiences it:
 * the root repaints immediately, then the preference is stored for the next
 * startup. Both steps are total, so a failing storage backend still repaints.
 *
 * `App` commits every theme change through this one call, which is why switching
 * themes cannot reach project state, history, transport or audio: this function
 * is only given a mode and an optional document.
 */
export const commitThemeSelection = (
  mode: unknown,
  doc: ThemeDocument | null | undefined = typeof document === 'undefined' ? null : document
): ThemeMode => {
  const applied = applyThemeToDocument(mode, doc);
  writeThemePreference(applied);
  return applied;
};
