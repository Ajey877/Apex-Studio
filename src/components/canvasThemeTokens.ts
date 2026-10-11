/**
 * UI-03C — shared canvas token resolver.
 *
 * Canvas draw commands cannot read CSS custom properties through Tailwind
 * classes, and a 2D context silently ignores a fillStyle that still contains a
 * `var()` reference. This module reads a semantic token from the active
 * document and returns a concrete colour the context accepts. It was extracted
 * from the UI-03B Mastering Suite seam so the Mixer uses the same resolution
 * rules rather than a second copy.
 */

import type { ThemeMode } from '../state/theme';

/**
 * Structural document view: just what the seam needs. The real `document`
 * satisfies it, and tests supply fakes without a DOM library.
 */
export interface CanvasThemeDocument {
  readonly documentElement?:
    | { dataset?: Record<string, string | undefined> | null; appendChild?: (node: unknown) => unknown }
    | null
    | undefined;
  readonly defaultView?:
    | {
        getComputedStyle?:
          | ((element: unknown) => {
              getPropertyValue?: (name: string) => unknown;
              backgroundColor?: string;
            } | null)
          | undefined;
      }
    | null
    | undefined;
  readonly createElement?: ((tag: string) => ThemeProbeElement) | undefined;
}

/** The hidden probe element used to resolve token references to real colours. */
export interface ThemeProbeElement {
  style: { display?: string; backgroundColor?: string };
  remove?: () => void;
}

const readRawToken = (doc: CanvasThemeDocument | null, token: string): string => {
  try {
    const root = doc?.documentElement;
    const compute = doc?.defaultView?.getComputedStyle;
    if (!root || typeof compute !== 'function') return '';
    const value = compute(root)?.getPropertyValue?.(token);
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
};

/**
 * Resolves a semantic token to a concrete colour the canvas can paint with.
 *
 * Custom properties are returned *as declared*: a token built from
 * `color-mix(... var(--apex-...) ...)` keeps its `var()` references, and a
 * canvas context cannot resolve those — assigning such a string to
 * `fillStyle` is silently ignored. Dark's `--apex-chrome-inset` is exactly
 * such a token. When the declared value still carries references, the token
 * is painted onto a hidden probe element and read back through a normal
 * (fully resolved) computed property. Plain hex/rgb tokens take the fast
 * path and never touch the DOM.
 */
export const readCanvasToken = (
  doc: CanvasThemeDocument | null,
  token: string,
  fallback: string
): string => {
  const raw = readRawToken(doc, token);
  if (raw.length === 0) return fallback;
  if (!raw.includes('var(') && !raw.includes('color-mix(')) return raw;
  try {
    if (!doc || typeof doc.createElement !== 'function') return fallback;
    const probe = doc.createElement('div');
    probe.style.display = 'none';
    probe.style.backgroundColor = `var(${token})`;
    doc.documentElement?.appendChild?.(probe);
    const resolved = doc.defaultView?.getComputedStyle?.(probe)?.backgroundColor ?? '';
    if (typeof probe.remove === 'function') probe.remove();
    const text = typeof resolved === 'string' ? resolved.trim() : '';
    return text.length > 0 ? text : fallback;
  } catch {
    return fallback;
  }
};


