export type ThemeMode = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'apex:theme';
export const DEFAULT_THEME: ThemeMode = 'dark';

export const normalizeThemeMode = (value: unknown): ThemeMode =>
  value === 'light' ? 'light' : DEFAULT_THEME;

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
