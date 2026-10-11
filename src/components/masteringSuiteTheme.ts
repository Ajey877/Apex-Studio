import { normalizeThemeMode, type ThemeMode } from '../state/theme';

/**
 * UI-03B — Mastering Suite theme seam.
 *
 * The Mastering Suite draws on two canvases (master FFT spectrum, stereo
 * goniometer) and paints several identity/status colours as inline styles.
 * Canvas draw commands cannot read CSS custom properties through Tailwind
 * classes, so this module is the one palette seam the component reads at draw
 * time and at render time.
 *
 * Rules this module enforces:
 *
 * 1. Interface chrome (scope backgrounds, grid lines, axis labels, idle text)
 *    resolves from the active document theme's semantic `--apex-*` tokens, so
 *    the canvases follow the Light/Dark palette exactly like the DOM does.
 *
 * 2. Intentional data colours are constants here, not tokens: the three
 *    mastering-band accents, the spectrum level ramp and the correlation-trace
 *    semantics. Their Dark values are the exact literals the suite shipped
 *    with, so the Dark identity is preserved bit-for-bit; the Light values
 *    keep the same hues at a lightness that stays legible on light surfaces.
 *
 * 3. The palette is cached per (document, mode) and the cache key is rechecked
 *    on every read, so flipping the theme repaints the canvases on the next
 *    animation frame with no reload and no stale palette can survive closing
 *    and reopening the modal.
 */

/** The three mastering band accents, keyed the way the UI presents them. */
export type MasteringBandAccentKey = 'low' | 'mid' | 'high';

export interface MasteringBandAccents {
  readonly low: string;
  readonly mid: string;
  readonly high: string;
}

/**
 * Band identity colours per theme.
 *
 * Dark keeps the exact legacy literals — these are the band identities the
 * report's "explicitly preserved" list protects. Light shifts only lightness
 * (hues stay within a few degrees) so +dB readouts remain readable on the
 * light card surfaces instead of washing out.
 */
export const MASTERING_BAND_ACCENTS: Record<ThemeMode, MasteringBandAccents> = {
  dark: { low: '#ffaa00', mid: '#00ff88', high: '#00e5ff' },
  light: { low: '#8a5c00', mid: '#0c7a4a', high: '#006480' },
};

/**
 * Signal colours per theme.
 *
 * The spectrum ramp (low-level green through orange into red) and the
 * correlation trace (coherent / wide / out-of-phase) encode measurement
 * meaning. Dark preserves the shipped literals, matching how the mixer VU
 * gradient was deliberately left untouched in UI-03A; Light uses the light
 * palette's semantic success/gold/danger values so the trace and bars stay
 * visible against the light inset background.
 */
export const MASTERING_SIGNAL_COLORS: Record<
  ThemeMode,
  {
    readonly spectrumStops: readonly [string, string, string];
    readonly correlationCoherent: string;
    readonly correlationWide: string;
    readonly correlationOutOfPhase: string;
  }
> = {
  dark: {
    spectrumStops: ['#00ff88', '#ff6e00', '#ff0055'],
    correlationCoherent: '#00ff88',
    correlationWide: '#ffaa00',
    correlationOutOfPhase: '#ff0055',
  },
  light: {
    spectrumStops: ['#14734e', '#9a5d00', '#bd2638'],
    correlationCoherent: '#14734e',
    correlationWide: '#9a5d00',
    correlationOutOfPhase: '#bd2638',
  },
};

/**
 * Chrome fallbacks used only when no computed style is available (server
 * rendering, locked-down documents). They are the Dark token values, so an
 * unstyled environment paints the default Dark theme rather than failing.
 */
const CHROME_FALLBACKS = {
  scopeBackground: '#0e1119', // ≈ --apex-chrome-inset (dark)
  gridLine: '#242936', // --apex-grid-line
  gridLineStrong: '#343a4a', // --apex-grid-line-strong
  axisLabel: '#8b95a8', // --apex-text-3
  idleSignal: '#9aa4b6', // --apex-text-muted
} as const;

/** Semantic tokens the canvas chrome reads from the active document theme. */
export const MASTERING_CANVAS_CHROME_TOKENS = {
  scopeBackground: '--apex-chrome-inset',
  gridLine: '--apex-grid-line',
  gridLineStrong: '--apex-grid-line-strong',
  axisLabel: '--apex-text-3',
  idleSignal: '--apex-text-muted',
} as const;

/** Everything the Mastering Suite needs to paint itself in one theme. */
export interface MasteringSuitePalette {
  readonly mode: ThemeMode;
  /** Canvas chrome, resolved from the document's semantic tokens. */
  readonly scopeBackground: string;
  readonly gridLine: string;
  readonly gridLineStrong: string;
  readonly axisLabel: string;
  readonly idleSignal: string;
  /** Intentional data colours — never generic theme tokens. */
  readonly bands: MasteringBandAccents;
  readonly spectrumStops: readonly [string, string, string];
  readonly correlationCoherent: string;
  readonly correlationWide: string;
  readonly correlationOutOfPhase: string;
}

import { readCanvasToken, type CanvasThemeDocument, type ThemeProbeElement } from './canvasThemeTokens';

/** Structural document view kept under its UI-03B name for existing callers. */
export type MasteringSuiteThemeDocument = CanvasThemeDocument;
export type { ThemeProbeElement };

const buildPalette = (
  doc: MasteringSuiteThemeDocument | null,
  mode: ThemeMode
): MasteringSuitePalette => {
  const signal = MASTERING_SIGNAL_COLORS[mode];
  return {
    mode,
    scopeBackground: readCanvasToken(doc, MASTERING_CANVAS_CHROME_TOKENS.scopeBackground, CHROME_FALLBACKS.scopeBackground),
    gridLine: readCanvasToken(doc, MASTERING_CANVAS_CHROME_TOKENS.gridLine, CHROME_FALLBACKS.gridLine),
    gridLineStrong: readCanvasToken(doc, MASTERING_CANVAS_CHROME_TOKENS.gridLineStrong, CHROME_FALLBACKS.gridLineStrong),
    axisLabel: readCanvasToken(doc, MASTERING_CANVAS_CHROME_TOKENS.axisLabel, CHROME_FALLBACKS.axisLabel),
    idleSignal: readCanvasToken(doc, MASTERING_CANVAS_CHROME_TOKENS.idleSignal, CHROME_FALLBACKS.idleSignal),
    bands: MASTERING_BAND_ACCENTS[mode],
    spectrumStops: signal.spectrumStops,
    correlationCoherent: signal.correlationCoherent,
    correlationWide: signal.correlationWide,
    correlationOutOfPhase: signal.correlationOutOfPhase,
  };
};

/**
 * Per-document cache. The key is the mode the palette was built for; every
 * read re-derives the mode from `<html data-theme>` first, so a theme flip
 * invalidates the entry on the very next read and no stale palette survives.
 * A WeakMap keyed on the document keeps test fakes from leaking into each
 * other and never holds the real document alive.
 */
const paletteCache = new WeakMap<
  object,
  { mode: ThemeMode; palette: MasteringSuitePalette }
>();
let nullDocEntry: { mode: ThemeMode; palette: MasteringSuitePalette } | null = null;

export const readMasteringSuitePalette = (
  doc: MasteringSuiteThemeDocument | null | undefined = typeof document === 'undefined'
    ? null
    : (document as unknown as MasteringSuiteThemeDocument)
): MasteringSuitePalette => {
  const mode = normalizeThemeMode(doc?.documentElement?.dataset?.theme);
  const docKey = doc && typeof doc === 'object' ? (doc as object) : null;
  const cached = docKey ? paletteCache.get(docKey) : nullDocEntry;
  if (cached && cached.mode === mode) return cached.palette;
  const entry = { mode, palette: buildPalette(doc ?? null, mode) };
  if (docKey) paletteCache.set(docKey, entry);
  else nullDocEntry = entry;
  return entry.palette;
};

/** Maps a state-layer band key onto its presentation accent key. */
export const bandAccentKey = (
  band: 'lowBand' | 'midBand' | 'highBand'
): MasteringBandAccentKey =>
  band === 'lowBand' ? 'low' : band === 'midBand' ? 'mid' : 'high';
