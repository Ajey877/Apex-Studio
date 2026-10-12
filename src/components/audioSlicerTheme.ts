import { normalizeThemeMode, type ThemeMode } from '../state/theme';
import { readCanvasToken, type CanvasThemeDocument } from './canvasThemeTokens';

/**
 * UI-03E — Audio Slicer theme seam.
 *
 * The slicer paints one waveform canvas whenever the buffer, the slice set or
 * the active slice changes. Canvas draw commands cannot read CSS custom
 * properties, so this module is the single palette seam the canvas reads on
 * every repaint. It follows the Mastering (UI-03B), Mixer (UI-03C) and
 * Wavetable (UI-03D) seams.
 *
 * Rules:
 *
 * 1. Chrome (the waveform background) resolves from the active document theme's
 *    semantic `--apex-*` tokens through the shared resolver, so a theme flip
 *    repaints without a reload.
 *
 * 2. The waveform, the slice markers and the slice badges are intentional signal
 *    colours, constant per mode rather than generic tokens. Dark keeps the
 *    shipped literals exactly. Light uses the same hue families at a lightness
 *    that stays visible on the light canvas.
 *
 * 3. The palette is cached per (document, mode). The mode is re-derived from
 *    `<html data-theme>` on every read, so an unchanged theme costs one lookup.
 */

/** Semantic token the waveform background reads from the active theme. */
export const SLICER_CANVAS_TOKEN = '--apex-canvas';
const CANVAS_FALLBACK = '#151821'; // --apex-canvas (dark)

export interface SlicerSignalColors {
  /** Fill of the waveform body. */
  readonly wave: string;
  /** Vertical boundary line for the slice currently auditioning. */
  readonly markerActive: string;
  /** Vertical boundary line for every other slice. */
  readonly markerInactive: string;
  /** Badge fill behind the number of the active slice. */
  readonly badgeActive: string;
  /** Badge fill behind the number of every other slice. */
  readonly badgeInactive: string;
  /** Badge number on the active badge. */
  readonly badgeTextActive: string;
  /** Badge number on every other badge. */
  readonly badgeTextInactive: string;
}

/**
 * Dark keeps the exact shipped literals: `#ff6e00` waveform, `#00e5ff` active
 * marker and badge, `#ffffff` inactive marker, `#222225` inactive badge, and
 * black/white badge numbers.
 *
 * Light reuses the Light semantic values of the same hue families. The shipped
 * `#ff6e00` waveform measures 2.59:1 on the Light canvas `#f4f6fa`, below the
 * 3:1 non-text floor, so Light takes `--apex-gold` (`#9a5d00`, 4.93:1). The
 * shipped `#ffffff` inactive marker measures 1.08:1 on the Light canvas and
 * would be invisible, so Light takes `--apex-text-2` (`#465267`, 7.29:1).
 */
export const SLICER_SIGNAL_COLORS: Record<ThemeMode, SlicerSignalColors> = {
  dark: {
    wave: '#ff6e00',
    markerActive: '#00e5ff',
    markerInactive: '#ffffff',
    badgeActive: '#00e5ff',
    badgeInactive: '#222225',
    badgeTextActive: '#000000',
    badgeTextInactive: '#ffffff',
  },
  light: {
    wave: '#9a5d00', // = Light --apex-gold
    markerActive: '#087da8', // = Light --apex-cyan
    markerInactive: '#465267', // = Light --apex-text-2
    badgeActive: '#087da8', // = Light --apex-cyan
    badgeInactive: '#e8ecf3', // = Light --apex-surface-3
    badgeTextActive: '#ffffff', // = Light --apex-state-playing-fg
    badgeTextInactive: '#18202d', // = Light --apex-text
  },
};

export interface SlicerPalette {
  readonly mode: ThemeMode;
  readonly canvasBackground: string;
  readonly signal: SlicerSignalColors;
}

const buildPalette = (doc: CanvasThemeDocument | null, mode: ThemeMode): SlicerPalette => ({
  mode,
  canvasBackground: readCanvasToken(doc, SLICER_CANVAS_TOKEN, CANVAS_FALLBACK),
  signal: SLICER_SIGNAL_COLORS[mode],
});

const paletteCache = new WeakMap<object, { mode: ThemeMode; palette: SlicerPalette }>();
let nullDocEntry: { mode: ThemeMode; palette: SlicerPalette } | null = null;

/**
 * Returns the Slicer palette for the document's current theme. Called on every
 * canvas repaint, so it must stay cheap: the cache returns the same object
 * until `data-theme` changes.
 */
export const readSlicerPalette = (
  doc: CanvasThemeDocument | null | undefined = typeof document === 'undefined'
    ? null
    : (document as unknown as CanvasThemeDocument)
): SlicerPalette => {
  const mode = normalizeThemeMode(doc?.documentElement?.dataset?.theme);
  const docKey = doc && typeof doc === 'object' ? (doc as object) : null;
  const cached = docKey ? paletteCache.get(docKey) : nullDocEntry;
  if (cached && cached.mode === mode) return cached.palette;
  const entry = { mode, palette: buildPalette(doc ?? null, mode) };
  if (docKey) paletteCache.set(docKey, entry);
  else nullDocEntry = entry;
  return entry.palette;
};
