/**
 * UI-03D — Wavetable palette seam, unit level.
 *
 * Covers the seam in isolation: the waterfall background follows the document
 * theme with no stale cache, the Dark waveform and selected-frame colours are the
 * exact shipped literals, the Light colours are legible on the Light canvas, and
 * the per-frame stroke string is byte-identical to the legacy Dark output.
 * Token values come from the real `src/index.css`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  WAVETABLE_SIGNAL_COLORS,
  readWavetablePalette,
  waveFrameStroke,
} from './wavetableTheme';
import type { CanvasThemeDocument } from './canvasThemeTokens';
import { DARK_TOKENS, LIGHT_TOKENS, hexToRgb, makeThemeDocument as makeDocument } from './themeTestDocument';

const relativeLuminance = (rgb: [number, number, number]): number => {
  const lin = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722;
};

const contrast = (a: [number, number, number], b: [number, number, number]): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

/** Parses the `rgba(r, g, b, a)` string the draw loop assigns to strokeStyle. */
const parseRgba = (value: string): [number, number, number, number] => {
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(value);
  assert.ok(m, `expected an rgba() string, got ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
};

/** Alpha-composites a stroke over a canvas to get the colour actually painted. */
const compositeOver = (stroke: [number, number, number, number], canvas: [number, number, number]): [number, number, number] =>
  [0, 1, 2].map((i) => stroke[i] * stroke[3] + canvas[i] * (1 - stroke[3])) as [number, number, number];

describe('Wavetable palette seam (UI-03D)', () => {
  it('resolves the waterfall background from the active theme token', () => {
    assert.equal(readWavetablePalette(makeDocument('dark')).canvasBackground, DARK_TOKENS['--apex-canvas']);
    assert.equal(readWavetablePalette(makeDocument('light')).canvasBackground, LIGHT_TOKENS['--apex-canvas']);
  });

  it('keeps the Dark waveform and selected-frame colours exactly as shipped', () => {
    const dark = readWavetablePalette(makeDocument('dark'));
    assert.equal(dark.mode, 'dark');
    assert.equal(dark.signal.wave, '#00e5ff');
    assert.equal(dark.signal.current, '#ff6e00');
  });

  it('draws the Dark inactive frames byte-for-byte as the legacy literal string', () => {
    const signal = WAVETABLE_SIGNAL_COLORS.dark;
    for (let step = 0; step <= 16; step += 1) {
      const frameProgress = step / 16;
      const legacy = `rgba(0, 229, 255, ${0.15 + (1 - frameProgress) * 0.4})`;
      assert.equal(waveFrameStroke(signal, frameProgress), legacy, `frame progress ${frameProgress}`);
    }
  });

  it('uses the Light semantic cyan and gold for the Light signal colours', () => {
    const light = readWavetablePalette(makeDocument('light'));
    assert.equal(light.mode, 'light');
    assert.equal(light.signal.wave, LIGHT_TOKENS['--apex-cyan']);
    assert.equal(light.signal.current, LIGHT_TOKENS['--apex-gold']);
  });

  it('keeps the selected frame legible against the canvas in both themes (non-text, >= 3:1)', () => {
    for (const mode of ['dark', 'light'] as const) {
      const palette = readWavetablePalette(makeDocument(mode));
      const ratio = contrast(hexToRgb(palette.signal.current), hexToRgb(palette.canvasBackground));
      assert.ok(ratio >= 3, `${mode} selected frame ${palette.signal.current} on ${palette.canvasBackground}: ${ratio.toFixed(2)}:1`);
    }
  });

  it('keeps the strongest inactive frame visible on the Light canvas (>= 3:1 once composited)', () => {
    const light = readWavetablePalette(makeDocument('light'));
    const strongest = parseRgba(waveFrameStroke(light.signal, 0));
    const painted = compositeOver(strongest, hexToRgb(light.canvasBackground));
    const ratio = contrast(painted, hexToRgb(light.canvasBackground));
    assert.ok(ratio >= 3, `strongest Light frame composites to ${painted.map(Math.round)} : ${ratio.toFixed(2)}:1`);
  });

  it('fades the faintest inactive frame toward the canvas without inverting it', () => {
    for (const mode of ['dark', 'light'] as const) {
      const palette = readWavetablePalette(makeDocument(mode));
      const faintest = parseRgba(waveFrameStroke(palette.signal, 1));
      const strongest = parseRgba(waveFrameStroke(palette.signal, 0));
      assert.ok(faintest[3] < strongest[3], `${mode}: faintest alpha ${faintest[3]} < strongest ${strongest[3]}`);
      assert.ok(faintest[3] > 0, `${mode}: the faintest frame stays visible`);
    }
  });

  it('gives cyan text a Light value that clears AA on every surface it sits on, washes included', () => {
    // Real token values from src/index.css. The text sits on the panel header,
    // the cards, the well, and the translucent cyan wash of the badge and presets.
    const cyanText = hexToRgb(LIGHT_TOKENS['--apex-cyan-text']);
    const panelHeader = hexToRgb(LIGHT_TOKENS['--apex-panel-header']);
    const wash = (over: [number, number, number], alpha: number): [number, number, number] =>
      [0, 1, 2].map((i) => hexToRgb(LIGHT_TOKENS['--apex-cyan'])[i] * alpha + over[i] * (1 - alpha)) as [number, number, number];
    const surfaces = [
      panelHeader,
      hexToRgb(LIGHT_TOKENS['--apex-surface']),
      hexToRgb(LIGHT_TOKENS['--apex-surface-2']),
      hexToRgb(LIGHT_TOKENS['--apex-bg']),
      wash(panelHeader, 0.2),
      wash(hexToRgb(LIGHT_TOKENS['--apex-surface-2']), 0.1),
    ];
    for (const surface of surfaces) {
      const ratio = contrast(cyanText, surface);
      assert.ok(ratio >= 4.5, `Light cyan text on ${surface.map(Math.round)}: ${ratio.toFixed(2)}:1`);
    }
  });

  it('keeps the primary-button label at AA on the rest and hover fills in both themes', () => {
    // Button label: --apex-state-playing-fg. Rest fill: --apex-cyan. Hover fill:
    // --apex-cyan-strong (a solid token, not a brightness filter). Values come
    // from the real src/index.css. The browser suite measures the composited pixels.
    for (const [mode, tokens] of [['dark', DARK_TOKENS], ['light', LIGHT_TOKENS]] as const) {
      const label = hexToRgb(tokens['--apex-state-playing-fg']);
      for (const fill of ['--apex-cyan', '--apex-cyan-strong'] as const) {
        const ratio = contrast(label, hexToRgb(tokens[fill]));
        assert.ok(ratio >= 4.5, `${mode} button label on ${fill} ${tokens[fill]}: ${ratio.toFixed(2)}:1`);
      }
    }
  });

  it('keeps the hover fill distinct from the rest fill in both themes', () => {
    assert.notEqual(LIGHT_TOKENS['--apex-cyan-strong'], LIGHT_TOKENS['--apex-cyan']);
    assert.notEqual(DARK_TOKENS['--apex-cyan-strong'], DARK_TOKENS['--apex-cyan']);
  });

  it('keeps Dark cyan text identical to the decorative Dark cyan', () => {
    assert.equal(DARK_TOKENS['--apex-cyan-text'], DARK_TOKENS['--apex-cyan']);
  });

  it('follows a theme flip on the next read with no stale palette', () => {
    const doc = makeDocument('dark');
    const dark = readWavetablePalette(doc);
    assert.equal(dark.mode, 'dark');
    (doc.documentElement as unknown as { dataset: { theme: string } }).dataset.theme = 'light';
    const light = readWavetablePalette(doc);
    assert.equal(light.mode, 'light');
    assert.equal(light.canvasBackground, LIGHT_TOKENS['--apex-canvas']);
    assert.equal(light.signal.current, WAVETABLE_SIGNAL_COLORS.light.current);
  });

  it('returns the same object while the theme is unchanged (cheap per-frame reads)', () => {
    const doc = makeDocument('light');
    assert.equal(readWavetablePalette(doc), readWavetablePalette(doc));
  });

  it('falls back to the Dark canvas when no document is available (no DOM)', () => {
    const palette = readWavetablePalette(null);
    assert.equal(palette.mode, 'dark');
    assert.equal(palette.canvasBackground, '#151821');
  });

  it('falls back when the canvas token cannot be read', () => {
    const doc = {
      documentElement: { dataset: { theme: 'light' } },
      defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '' }) },
    } as unknown as CanvasThemeDocument;
    const palette = readWavetablePalette(doc);
    assert.equal(palette.mode, 'light');
    assert.equal(palette.canvasBackground, '#151821');
  });
});
