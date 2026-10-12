import { normalizeThemeMode, type ThemeMode } from '../state/theme';
import { readCanvasToken, type CanvasThemeDocument } from './canvasThemeTokens';

/**
 * UI-03G — Parametric EQ theme seam.
 *
 * The EQ editor paints its frequency grid, the live FFT spectrum, the composite
 * response curve and the draggable band nodes on one 2D canvas, on every
 * animation frame, while the modal is open. Canvas draw commands cannot read CSS
 * custom properties, so this module is the single palette seam the canvas reads.
 * It follows the Mastering (UI-03B), Mixer (UI-03C), Wavetable (UI-03D), Audio
 * Slicer (UI-03E) and Audio Recorder (UI-03F) seams.
 *
 * Rules:
 *
 * 1. Chrome inside the graph — the canvas background, the frequency/dB grid and
 *    the axis labels — resolves from the active document theme's semantic
 *    `--apex-*` tokens through the shared resolver, so a theme flip repaints
 *    without a reload.
 *
 * 2. The spectrum, the response curve and the node rings are intentional signal
 *    colours, constant per mode rather than generic tokens. Dark keeps the
 *    shipped literals exactly, with the one documented exception of the node
 *    number (see EQ_GRAPH_COLORS).
 *
 * 3. The band node FILL is a display mapping of `band.color`, not the stored
 *    value itself. `band.color` is project-owned data from
 *    `parametricEqBands.EQ_BAND_SPECS` and is never rewritten; `EQ_BAND_DISPLAY_COLORS`
 *    below maps it to the colour this theme can actually show, and both the
 *    canvas node and the band card's swatch read that one mapping.
 *
 * 4. The palette is cached per (document, mode). The mode is re-derived from
 *    `<html data-theme>` on every read, so an unchanged theme costs one lookup.
 *    The editor's draw loop reads the palette on every frame, so a theme flip is
 *    picked up on the next frame with no observer to attach or clean up.
 */

/** Semantic tokens the graph chrome reads from the active theme. */
export const EQ_CANVAS_TOKEN = '--apex-canvas';
export const EQ_GRID_TOKEN = '--apex-grid-line';
export const EQ_GRID_STRONG_TOKEN = '--apex-grid-line-strong';
export const EQ_AXIS_LABEL_TOKEN = '--apex-text-3';

/* Dark values of the four tokens; used only when a token cannot be read. */
const CANVAS_FALLBACK = '#151821'; // --apex-canvas (dark)
const GRID_FALLBACK = '#242936'; // --apex-grid-line (dark)
const GRID_STRONG_FALLBACK = '#343a4a'; // --apex-grid-line-strong (dark)
const AXIS_LABEL_FALLBACK = '#8b95a8'; // --apex-text-3 (dark)

export interface EqGraphColors {
  /** Fill under the live FFT spectrum trace. */
  readonly spectrum: string;
  /** Stroke of the composite EQ response curve. */
  readonly curve: string;
  /** Ring around an unselected band node. */
  readonly nodeOutline: string;
  /** Ring around the selected band node. */
  readonly nodeOutlineSelected: string;
  /** Band number drawn inside a node. */
  readonly nodeLabel: string;
}

/**
 * Dark keeps the shipped literals: `rgba(255, 110, 0, 0.15)` spectrum,
 * `#ff6e00` response curve (6.32:1 on the Dark canvas `#151821`), `#000000`
 * unselected node ring and `#ffffff` selected node ring.
 *
 * The one Dark delta is the node number, `#ffffff` -> `#000000`. The shipped
 * white measures 2.85:1 on the low band's `#e67e22`, 2.10:1 on the mid band's
 * `#2ecc71` and 3.15:1 on the high band's `#3498db` — below the 4.5:1 a 9px bold
 * label needs, in the theme that was already "correct". Black measures 7.37:1,
 * 9.99:1 and 6.66:1 on the same three fills. The band fills themselves are
 * unchanged, so the EQ's colour language is preserved; only the number painted
 * on top of them moved.
 *
 * Light takes the Light value of the same hue families: `#9a5d00`
 * (`--apex-gold`, 4.93:1 on the Light canvas `#f4f6fa`) for the curve and its
 * spectrum, because the shipped `#ff6e00` measures 2.59:1 there — the same
 * finding UI-03E and UI-03F recorded. The shipped `#ffffff` selected node ring
 * measures 1.08:1 on the Light canvas and would be invisible, so the selected
 * ring takes `--apex-accent` (`#6552ce`, 5.32:1) and the unselected ring
 * `--apex-text` (`#18202d`, 15.12:1). That keeps Dark's two-colour selection cue
 * alive on a light canvas instead of collapsing it to one invisible ring.
 *
 * The unselected ring is the one place the two themes are deliberately NOT
 * symmetric. Dark keeps `#000000` even though it measures 1.18:1 on the Dark
 * canvas: there the handle is located by its FILL (6.22:1 / 8.44:1 / 5.62:1),
 * and the ring is only an edge treatment. Light takes `--apex-text` so the ring
 * carries contrast in its own right — before the band display mapping below
 * existed, the stored fills measured 2.63:1 / 1.94:1 / 2.91:1 on the Light
 * canvas and the ring was the only thing left to locate a handle. The mapped
 * fills now clear 3:1 as well, so the ring is a reinforcement rather than the
 * sole boundary.
 */
export const EQ_GRAPH_COLORS: Record<ThemeMode, EqGraphColors> = {
  dark: {
    spectrum: 'rgba(255, 110, 0, 0.15)',
    curve: '#ff6e00',
    nodeOutline: '#000000',
    nodeOutlineSelected: '#ffffff',
    nodeLabel: '#000000',
  },
  light: {
    spectrum: 'rgba(154, 93, 0, 0.15)', // #9a5d00 = Light --apex-gold at 15%
    curve: '#9a5d00', // = Light --apex-gold
    nodeOutline: '#18202d', // = Light --apex-text
    nodeOutlineSelected: '#6552ce', // = Light --apex-accent
    nodeLabel: '#000000',
  },
};

/**
 * UI-03G fix 2 — band identity colour -> display colour, per mode.
 *
 * `band.color` is persisted project data (see `EQ_BAND_SPECS`), so it is never
 * rewritten: this table maps the STORED value to the colour actually painted,
 * and both display surfaces read it — the canvas node fill and the band card's
 * swatch. Keeping one mapping is what stops the node and its card disagreeing.
 *
 * Why Light needs one at all: before this migration the canvas painted a
 * hardcoded `#101014` in BOTH themes, so in Light the bands sat on a dark
 * background and measured 6.66 / 9.03 / 6.02:1. Theming the canvas to
 * `--apex-canvas` (`#f4f6fa`) dropped the same stored colours to 2.63 / 1.94 /
 * 2.91:1 — below the 3:1 non-text floor. That regression was introduced by the
 * theme migration itself, not inherited, so it is fixed here rather than
 * documented as pre-existing.
 *
 * The Light values are the stored hues darkened to clear 3:1 on the Light
 * canvas. Each also clears 3:1 on the Dark canvas, so a theme flip that reaches
 * one surface a frame before the other cannot produce an invisible band.
 * Measured on `#f4f6fa`: low 3.81:1, mid 4.04:1, high 4.00:1. The three stay
 * clearly distinct from each other (CIE76 dE 76-84, against a ~20 threshold) and
 * from the Light response curve `#9a5d00` (dE 28-97; the shipped Dark pairing of
 * `#e67e22` on `#ff6e00` is only dE 19.5). The low band takes a 15 degree hue
 * shift (28 -> 13) for that last separation: at its stored hue, any darkening
 * that reaches 3:1 lands within dE 13 of the curve.
 *
 * Dark maps nothing. The stored colours already clear 3:1 on the Dark canvas
 * (6.22 / 8.44 / 5.62:1), so Dark renders exactly as it did before.
 *
 * A colour that is not one of the three — a legacy or hand-edited project —
 * falls through unchanged, so this table can never make an unknown band vanish.
 */
export type EqBandDisplayMap = Readonly<Record<string, string>>;

export const EQ_BAND_DISPLAY_COLORS: Record<ThemeMode, EqBandDisplayMap> = {
  dark: {},
  light: {
    '#e67e22': '#c26147', // low shelf
    '#2ecc71': '#1f8a4d', // mid bell
    '#3498db': '#227fbe', // high shelf
  },
};

export interface EqPalette {
  readonly mode: ThemeMode;
  readonly canvasBackground: string;
  /** Frequency lines and the non-zero dB lines. */
  readonly gridLine: string;
  /** The 0 dB reference line. */
  readonly gridLineStrong: string;
  /** The frequency and dB axis labels. */
  readonly axisLabel: string;
  readonly graph: EqGraphColors;
  /**
   * The colour to PAINT for a band, given its stored `band.color`. Both the
   * canvas node and the band card's swatch must go through this so they agree.
   */
  readonly bandFill: (storedColor: string) => string;
}

const buildPalette = (doc: CanvasThemeDocument | null, mode: ThemeMode): EqPalette => {
  const display = EQ_BAND_DISPLAY_COLORS[mode];
  return {
    mode,
    canvasBackground: readCanvasToken(doc, EQ_CANVAS_TOKEN, CANVAS_FALLBACK),
    gridLine: readCanvasToken(doc, EQ_GRID_TOKEN, GRID_FALLBACK),
    gridLineStrong: readCanvasToken(doc, EQ_GRID_STRONG_TOKEN, GRID_STRONG_FALLBACK),
    axisLabel: readCanvasToken(doc, EQ_AXIS_LABEL_TOKEN, AXIS_LABEL_FALLBACK),
    graph: EQ_GRAPH_COLORS[mode],
    // Case-insensitive on purpose: project files are hand-editable JSON.
    bandFill: (storedColor: string) =>
      display[String(storedColor).toLowerCase()] ?? storedColor,
  };
};

const paletteCache = new WeakMap<object, { mode: ThemeMode; palette: EqPalette }>();
let nullDocEntry: { mode: ThemeMode; palette: EqPalette } | null = null;

/**
 * Returns the EQ palette for the document's current theme. Called on every
 * animation frame, so it must stay cheap: the cache returns the same object
 * until `data-theme` changes.
 */
export const readEqPalette = (
  doc: CanvasThemeDocument | null | undefined = typeof document === 'undefined'
    ? null
    : (document as unknown as CanvasThemeDocument)
): EqPalette => {
  const mode = normalizeThemeMode(doc?.documentElement?.dataset?.theme);
  const docKey = doc && typeof doc === 'object' ? (doc as object) : null;
  const cached = docKey ? paletteCache.get(docKey) : nullDocEntry;
  if (cached && cached.mode === mode) return cached.palette;
  const entry = { mode, palette: buildPalette(doc ?? null, mode) };
  if (docKey) paletteCache.set(docKey, entry);
  else nullDocEntry = entry;
  return entry.palette;
};
