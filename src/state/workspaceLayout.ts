/**
 * UI-02: Workspace layout preferences — persistent, validated, project-independent.
 * Stored in localStorage, never in ProjectState.
 */

export type WorkspaceDensity = 'compact' | 'comfy';

export const WORKSPACE_LAYOUT_KEYS = {
  browserWidth: 'apex:browserWidth',
  inspectorWidth: 'apex:inspectorWidth',
  density: 'apex:density',
} as const;

export const WORKSPACE_LAYOUT_LIMITS = {
  browser: { min: 140, max: 320, default: 156, collapsed: 40 },
  inspector: { min: 240, max: 360, default: 260, collapsed: 40 },
} as const;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const normalizeBrowserWidth = (value: unknown): number => {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n)) return WORKSPACE_LAYOUT_LIMITS.browser.default;
  return clamp(Math.round(n), WORKSPACE_LAYOUT_LIMITS.browser.min, WORKSPACE_LAYOUT_LIMITS.browser.max);
};

export const normalizeInspectorWidth = (value: unknown): number => {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n)) return WORKSPACE_LAYOUT_LIMITS.inspector.default;
  return clamp(Math.round(n), WORKSPACE_LAYOUT_LIMITS.inspector.min, WORKSPACE_LAYOUT_LIMITS.inspector.max);
};

export const normalizeDensity = (value: unknown): WorkspaceDensity => {
  if (value === 'compact' || value === 'comfy') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'compact' || v === 'comfy') return v as WorkspaceDensity;
  }
  return 'comfy';
};

export const readWorkspaceLayoutPreference = <T,>(
  key: string,
  parse: (raw: string) => T,
  fallback: T
): T => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return fallback;
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return parse(raw);
  } catch {
    return fallback;
  }
};

export const writeWorkspaceLayoutPreference = (key: string, value: string): void => {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(key, value);
  } catch {
    // inaccessible localStorage — silently ignore, do not crash
  }
};

export const loadBrowserWidth = (): number =>
  readWorkspaceLayoutPreference(WORKSPACE_LAYOUT_KEYS.browserWidth, v => normalizeBrowserWidth(v), WORKSPACE_LAYOUT_LIMITS.browser.default);

export const loadInspectorWidth = (): number =>
  readWorkspaceLayoutPreference(WORKSPACE_LAYOUT_KEYS.inspectorWidth, v => normalizeInspectorWidth(v), WORKSPACE_LAYOUT_LIMITS.inspector.default);

export const loadDensity = (): WorkspaceDensity =>
  readWorkspaceLayoutPreference(WORKSPACE_LAYOUT_KEYS.density, v => normalizeDensity(v), 'comfy');
