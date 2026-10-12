import { normalizeThemeMode, type ThemeMode } from '../state/theme';
import { readCanvasToken, type CanvasThemeDocument } from './canvasThemeTokens';

/**
 * UI-03F — Audio Recorder theme seam.
 *
 * The recorder paints a live input-level waveform on a 2D canvas every animation
 * frame while it is open. Canvas draw commands cannot read CSS custom
 * properties, so this module is the single palette seam the canvas reads. It
 * follows the Mastering (UI-03B), Mixer (UI-03C), Wavetable (UI-03D) and Audio
 * Slicer (UI-03E) seams.
 *
 * Rules:
 *
 * 1. The canvas background resolves from the active document theme's semantic
 *    `--apex-*` token through the shared resolver, so it follows the theme.
 *
 * 2. The waveform is an intentional signal colour, constant per mode. Dark keeps
 *    the shipped literal exactly. Light uses the Light value of the same hue
 *    family as the Audio Slicer's waveform.
 *
 * 3. The palette is cached per (document, mode). The mode is re-derived from
 *    `<html data-theme>` on every read, so an unchanged theme costs one lookup.
 *    The recorder's draw loop reads the palette on every frame, so a theme flip
 *    is picked up on the next frame with no observer to attach or clean up.
 */

/** Semantic token the canvas background reads from the active theme. */
export const RECORDER_CANVAS_TOKEN = '--apex-canvas';
const CANVAS_FALLBACK = '#151821'; // --apex-canvas (dark)

export interface RecorderSignalColors {
  /** Stroke of the live input-level waveform. */
  readonly wave: string;
}

/**
 * Dark keeps the shipped `#ff6e00` waveform exactly. Light takes `--apex-gold`
 * (`#9a5d00`, 4.93:1 on the Light canvas `#f4f6fa`): the shipped orange measures
 * 2.59:1 there, below the 3:1 non-text floor. This is the same Light value the
 * Audio Slicer uses for its waveform.
 */
export const RECORDER_SIGNAL_COLORS: Record<ThemeMode, RecorderSignalColors> = {
  dark: {
    wave: '#ff6e00',
  },
  light: {
    wave: '#9a5d00', // = Light --apex-gold
  },
};

export interface RecorderPalette {
  readonly mode: ThemeMode;
  readonly canvasBackground: string;
  readonly signal: RecorderSignalColors;
}

const buildPalette = (doc: CanvasThemeDocument | null, mode: ThemeMode): RecorderPalette => ({
  mode,
  canvasBackground: readCanvasToken(doc, RECORDER_CANVAS_TOKEN, CANVAS_FALLBACK),
  signal: RECORDER_SIGNAL_COLORS[mode],
});

const paletteCache = new WeakMap<object, { mode: ThemeMode; palette: RecorderPalette }>();
let nullDocEntry: { mode: ThemeMode; palette: RecorderPalette } | null = null;

/**
 * Returns the recorder palette for the document's current theme. Called on every
 * animation frame, so it must stay cheap: the cache returns the same object
 * until `data-theme` changes.
 */
export const readRecorderPalette = (
  doc: CanvasThemeDocument | null | undefined = typeof document === 'undefined'
    ? null
    : (document as unknown as CanvasThemeDocument)
): RecorderPalette => {
  const mode = normalizeThemeMode(doc?.documentElement?.dataset?.theme);
  const docKey = doc && typeof doc === 'object' ? (doc as object) : null;
  const cached = docKey ? paletteCache.get(docKey) : nullDocEntry;
  if (cached && cached.mode === mode) return cached.palette;
  const entry = { mode, palette: buildPalette(doc ?? null, mode) };
  if (docKey) paletteCache.set(docKey, entry);
  else nullDocEntry = entry;
  return entry.palette;
};
