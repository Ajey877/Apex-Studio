import { normalizeThemeMode, type ThemeMode } from '../state/theme';
import { readCanvasToken, type CanvasThemeDocument } from './canvasThemeTokens';

/**
 * UI-03D — Wavetable preview theme seam.
 *
 * The Wavetable preview paints one waterfall canvas on every animation frame.
 * Canvas draw commands cannot read CSS custom properties, so this module is the
 * single palette seam the canvas reads each frame. It follows the Mixer (UI-03C)
 * and Mastering (UI-03B) seams.
 *
 * Rules:
 *
 * 1. Chrome (the waterfall background) resolves from the active document
 *    theme's semantic `--apex-*` tokens through the shared resolver, so a theme
 *    flip repaints on the next frame with no reload.
 *
 * 2. The waveform and the selected-frame highlight are intentional signal
 *    colours, constant per mode rather than generic tokens. Dark keeps the
 *    shipped literals exactly. Light uses the same hue families at a lightness
 *    that stays visible on the light canvas.
 *
 * 3. The palette is cached per (document, mode). The mode is re-derived from
 *    `<html data-theme>` on every read, so an unchanged theme costs one lookup.
 */

/** Semantic token the waterfall background reads from the active theme. */
export const WAVETABLE_CANVAS_TOKEN = '--apex-canvas';
const CANVAS_FALLBACK = '#151821'; // --apex-canvas (dark)

export interface WavetableSignalColors {
  /** Hex of the inactive frames' stroke (rgb is taken, alpha varies per frame). */
  readonly wave: string;
  /** Alpha at `frameProgress` 1 (the faintest inactive frame). */
  readonly waveAlphaFloor: number;
  /** Alpha added at `frameProgress` 0 (the strongest inactive frame). */
  readonly waveAlphaSpan: number;
  /** Hex of the stroke for the frame at the current morph position. */
  readonly current: string;
}

/**
 * Dark keeps the exact shipped waterfall literals: `rgba(0, 229, 255, …)` for the
 * inactive frames and `#ff6e00` for the selected frame. Light uses the Light
 * `--apex-cyan` family and a darker amber for the selected frame, so the selected
 * frame clears 3:1 against the light canvas.
 */
export const WAVETABLE_SIGNAL_COLORS: Record<ThemeMode, WavetableSignalColors> = {
  dark: {
    wave: '#00e5ff',
    waveAlphaFloor: 0.15,
    waveAlphaSpan: 0.4,
    current: '#ff6e00',
  },
  light: {
    wave: '#087da8', // = Light --apex-cyan
    waveAlphaFloor: 0.3,
    waveAlphaSpan: 0.6,
    current: '#9a5d00', // = Light --apex-gold
  },
};

export interface WavetablePalette {
  readonly mode: ThemeMode;
  readonly canvasBackground: string;
  readonly signal: WavetableSignalColors;
}

const parseHex = (value: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
};

/**
 * Stroke colour for an inactive frame. `frameProgress` is `f / (numFrames - 1)`
 * from the draw loop: 0 is the strongest inactive frame, 1 the faintest. The Dark output is byte-for-byte the
 * legacy `rgba(0, 229, 255, ${0.15 + (1 - frameProgress) * 0.4})` string.
 */
export const waveFrameStroke = (signal: WavetableSignalColors, frameProgress: number): string => {
  const rgb = parseHex(signal.wave) ?? [0, 229, 255];
  const alpha = signal.waveAlphaFloor + (1 - frameProgress) * signal.waveAlphaSpan;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
};

const buildPalette = (doc: CanvasThemeDocument | null, mode: ThemeMode): WavetablePalette => ({
  mode,
  canvasBackground: readCanvasToken(doc, WAVETABLE_CANVAS_TOKEN, CANVAS_FALLBACK),
  signal: WAVETABLE_SIGNAL_COLORS[mode],
});

const paletteCache = new WeakMap<object, { mode: ThemeMode; palette: WavetablePalette }>();
let nullDocEntry: { mode: ThemeMode; palette: WavetablePalette } | null = null;

/**
 * Returns the Wavetable palette for the document's current theme. Called from
 * the canvas draw loop, so it must stay cheap: the cache returns the same object
 * until `data-theme` changes.
 */
export const readWavetablePalette = (
  doc: CanvasThemeDocument | null | undefined = typeof document === 'undefined'
    ? null
    : (document as unknown as CanvasThemeDocument)
): WavetablePalette => {
  const mode = normalizeThemeMode(doc?.documentElement?.dataset?.theme);
  const docKey = doc && typeof doc === 'object' ? (doc as object) : null;
  const cached = docKey ? paletteCache.get(docKey) : nullDocEntry;
  if (cached && cached.mode === mode) return cached.palette;
  const entry = { mode, palette: buildPalette(doc ?? null, mode) };
  if (docKey) paletteCache.set(docKey, entry);
  else nullDocEntry = entry;
  return entry.palette;
};
