import { useEffect, useState } from 'react';
import { normalizeThemeMode, type ThemeMode } from '../state/theme';
import { readCanvasToken, type CanvasThemeDocument } from './canvasThemeTokens';

/**
 * UI-03C/UI-03S — Mixer theme seam and targeted identity contrast.
 *
 * The Mixer paints two canvases (master FFT strip and the master-fader spectrum
 * backdrop) and uses a few inline colours (the VU meter gradient and the
 * per-track identity colour on channel names). Interface chrome in the Mixer is
 * already expressed through `--apex-*` classes; this module covers the values
 * that cannot be expressed as classes.
 *
 * Rules:
 *
 * 1. Canvas chrome (the FFT background) resolves from the document's semantic
 *    tokens each frame, so flipping the theme repaints on the next frame with
 *    no reload, and reopening the Mixer never reads a stale palette.
 *
 * 2. Intentional signal colours are constants per mode, not generic tokens:
 *    the green/orange/red level gradient (VU meter and FFT bars). Dark keeps
 *    the exact legacy literals. Light uses the darker semantic success / gold /
 *    danger values with the same green → orange → red order, because the bright
 *    Dark greens measure ~1.2:1 against the light meter track (see the report).
 *
 * 3. Track identity colours are preserved in project data. The Mixer adjusts
 *    only the rendered track-name foreground, in either theme when needed,
 *    moving the colour's HSL lightness the smallest amount that clears WCAG AA
 *    (4.5:1) on every strip surface while keeping its hue and saturation.
 */

/** Semantic tokens the canvas chrome reads from the active document theme. */
export const MIXER_CANVAS_TOKENS = {
  canvasBackground: '--apex-canvas',
} as const;

const CHROME_FALLBACKS = {
  canvasBackground: '#151821', // --apex-canvas (dark)
} as const;

/** Surfaces a track name sits on; a name must clear AA on every one of them. */
export const MIXER_STRIP_SURFACE_TOKENS = ['--apex-surface-2', '--apex-panel'] as const;
const STRIP_SURFACE_FALLBACKS: Record<(typeof MIXER_STRIP_SURFACE_TOKENS)[number], string> = {
  '--apex-surface-2': '#202430',
  '--apex-panel': '#191c25',
};

export interface MixerSignalColors {
  /** Low level stop of the level gradient (bottom of the meter). */
  readonly levelLow: string;
  /** Middle level stop (≈ -6 dB region). */
  readonly levelMid: string;
  /** High level stop (clip region). */
  readonly levelHigh: string;
  /** Master-fader spectrum backdrop bars. */
  readonly spectrumBackdrop: string;
}

/** Intentional signal colours per theme. Dark = shipped literals. */
export const MIXER_SIGNAL_COLORS: Record<ThemeMode, MixerSignalColors> = {
  dark: {
    levelLow: '#00ff00',
    levelMid: '#ff6e00',
    levelHigh: '#ff0000',
    spectrumBackdrop: 'rgba(0, 255, 136, 0.25)',
  },
  light: {
    levelLow: '#14734e', // = Light --apex-success
    levelMid: '#9a5d00', // = Light --apex-gold
    levelHigh: '#bd2638', // = Light --apex-danger
    spectrumBackdrop: 'rgba(20, 115, 78, 0.3)',
  },
};

/** Gradient stop positions, identical to the shipped meter and FFT. */
export const MIXER_LEVEL_STOPS = { canvasMid: 0.6, cssMid: '60%', cssHighStart: '85%' } as const;

export interface MixerPalette {
  readonly mode: ThemeMode;
  readonly canvasBackground: string;
  readonly signal: MixerSignalColors;
  /** CSS gradient for the DOM VU meter fill. */
  readonly meterGradient: string;
  /** RGB of the surfaces a track name sits on (for identity legibility). */
  readonly stripSurfaces: Array<[number, number, number]>;
}

export const buildMixerMeterGradient = (signal: MixerSignalColors): string =>
  `linear-gradient(to top, ${signal.levelLow} ${MIXER_LEVEL_STOPS.cssMid}, ${signal.levelMid} ${MIXER_LEVEL_STOPS.cssHighStart}, ${signal.levelHigh} 100%)`;

const buildPalette = (doc: CanvasThemeDocument | null, mode: ThemeMode): MixerPalette => {
  const signal = MIXER_SIGNAL_COLORS[mode];
  return {
    mode,
    canvasBackground: readCanvasToken(doc, MIXER_CANVAS_TOKENS.canvasBackground, CHROME_FALLBACKS.canvasBackground),
    signal,
    meterGradient: buildMixerMeterGradient(signal),
    stripSurfaces: readMixerStripSurfaces(doc),
  };
};

const paletteCache = new WeakMap<object, { mode: ThemeMode; palette: MixerPalette }>();
let nullDocEntry: { mode: ThemeMode; palette: MixerPalette } | null = null;

/**
 * Returns the Mixer palette for the document's current theme. The mode is
 * re-derived from `<html data-theme>` on every call, so a flip invalidates the
 * cache entry on the next read.
 */
export const readMixerPalette = (
  doc: CanvasThemeDocument | null | undefined = typeof document === 'undefined'
    ? null
    : (document as unknown as CanvasThemeDocument)
): MixerPalette => {
  const mode = normalizeThemeMode(doc?.documentElement?.dataset?.theme);
  const docKey = doc && typeof doc === 'object' ? (doc as object) : null;
  const cached = docKey ? paletteCache.get(docKey) : nullDocEntry;
  if (cached && cached.mode === mode) return cached.palette;
  const entry = { mode, palette: buildPalette(doc ?? null, mode) };
  if (docKey) paletteCache.set(docKey, entry);
  else nullDocEntry = entry;
  return entry.palette;
};

// ---------------------------------------------------------------------------
// Track identity legibility
// ---------------------------------------------------------------------------

const WCAG_AA = 4.5;

const parseHex = (value: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
};

/** Hex or `rgb()/rgba()` (what a resolved computed style returns). */
const parseColor = (value: string): [number, number, number] | null => {
  const hex = parseHex(value);
  if (hex) return hex;
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(value.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

const toHex = (rgb: [number, number, number]): string =>
  '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('');

const luminance = ([r, g, b]: [number, number, number]): number => {
  const lin = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722;
};

export const contrastRatio = (a: [number, number, number], b: [number, number, number]): number => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const rgbToHsl = ([r, g, b]: [number, number, number]): [number, number, number] => {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h / 6, s, l];
};

const hslToRgb = ([h, s, l]: [number, number, number]): [number, number, number] => {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
};

/**
 * Track-name colour for the Mixer strip.
 *
 * Returns the track colour unchanged when it already clears AA on every strip
 * surface. Otherwise, adjusts only HSL lightness by the smallest amount that
 * clears AA in either theme (hue and saturation remain stable). The project
 * value is never rewritten. Unparseable values are returned untouched.
 */
export const trackIdentityLabelColor = (
  color: string,
  mode: ThemeMode,
  surfaces: ReadonlyArray<[number, number, number]>
): string => {
  const rgb = parseHex(color);
  if (!rgb) return color;
  const clears = (candidate: [number, number, number]) =>
    surfaces.every((surface) => contrastRatio(candidate, surface) >= WCAG_AA);
  if (clears(rgb)) return color;
  const [h, s, l] = rgbToHsl(rgb);
  // Prefer the direction appropriate to the active palette if both sides are
  // equally close; the surfaces, rather than the mode alone, decide whether a
  // lighter or darker foreground is actually required.
  const preferredDirection = mode === 'dark' ? 1 : -1;
  for (let step = 1; step <= 1000; step += 1) {
    const delta = step / 1000;
    const directions = [preferredDirection, -preferredDirection] as const;
    for (const direction of directions) {
      const lightness = Math.max(0, Math.min(1, l + delta * direction));
      const candidate = hslToRgb([h, s, lightness]).map((c) => Math.round(c)) as [number, number, number];
      if (clears(candidate)) return toHex(candidate);
    }
  }
  return '#000000';
};

/** Strip surfaces as RGB, read from the active document with dark fallbacks. */
export const readMixerStripSurfaces = (
  doc: CanvasThemeDocument | null | undefined = typeof document === 'undefined'
    ? null
    : (document as unknown as CanvasThemeDocument)
): Array<[number, number, number]> =>
  MIXER_STRIP_SURFACE_TOKENS.map((token) => {
    const resolved = readCanvasToken(doc ?? null, token, STRIP_SURFACE_FALLBACKS[token]);
    return parseColor(resolved) ?? parseHex(STRIP_SURFACE_FALLBACKS[token])!;
  });

/**
 * DOM-side palette. Canvas drawing reads the seam every frame; the DOM only
 * re-renders on React state changes, so this hook also observes `data-theme`.
 * The seam caches per (document, mode), so an unchanged theme returns the same
 * object and React skips the re-render.
 */
export const useMixerPalette = (): MixerPalette => {
  const [palette, setPalette] = useState<MixerPalette>(() => readMixerPalette());
  useEffect(() => {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
    const apply = () => setPalette(readMixerPalette());
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return palette;
};
