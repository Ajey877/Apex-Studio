/**
 * UI-03E — Audio Slicer palette seam, unit level.
 *
 * Covers the seam in isolation: the waveform background follows the document
 * theme with no stale cache, the Dark signal colours are the exact shipped
 * literals, and every Light signal colour is legible on the surface it is
 * painted over. Token values come from the real `src/index.css`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SLICER_SIGNAL_COLORS, readSlicerPalette } from './audioSlicerTheme';
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

type Rgb = [number, number, number];

describe('Audio Slicer palette seam (UI-03E)', () => {
  it('resolves the waveform background from the active theme token', () => {
    assert.equal(readSlicerPalette(makeDocument('dark')).canvasBackground, DARK_TOKENS['--apex-canvas']);
    assert.equal(readSlicerPalette(makeDocument('light')).canvasBackground, LIGHT_TOKENS['--apex-canvas']);
  });

  it('keeps every Dark signal colour exactly as shipped', () => {
    const dark = readSlicerPalette(makeDocument('dark'));
    assert.equal(dark.mode, 'dark');
    // These are the literals the canvas painted before UI-03E. Dark must not
    // move: the waveform body, the markers and the badges are signal colours.
    assert.equal(dark.signal.wave, '#ff6e00');
    assert.equal(dark.signal.markerActive, '#00e5ff');
    assert.equal(dark.signal.markerInactive, '#ffffff');
    assert.equal(dark.signal.badgeActive, '#00e5ff');
    assert.equal(dark.signal.badgeInactive, '#222225');
    assert.equal(dark.signal.badgeTextActive, '#000000');
    assert.equal(dark.signal.badgeTextInactive, '#ffffff');
  });

  it('uses the Light semantic values for the Light signal colours', () => {
    const light = readSlicerPalette(makeDocument('light'));
    assert.equal(light.mode, 'light');
    assert.equal(light.signal.wave, LIGHT_TOKENS['--apex-gold']);
    assert.equal(light.signal.markerActive, LIGHT_TOKENS['--apex-cyan']);
    assert.equal(light.signal.markerInactive, LIGHT_TOKENS['--apex-text-2']);
    assert.equal(light.signal.badgeActive, LIGHT_TOKENS['--apex-cyan']);
    assert.equal(light.signal.badgeInactive, LIGHT_TOKENS['--apex-surface-3']);
    assert.equal(light.signal.badgeTextActive, LIGHT_TOKENS['--apex-state-playing-fg']);
    assert.equal(light.signal.badgeTextInactive, LIGHT_TOKENS['--apex-text']);
  });

  it('keeps the waveform visible on the canvas in both themes (non-text, >= 3:1)', () => {
    for (const mode of ['dark', 'light'] as const) {
      const palette = readSlicerPalette(makeDocument(mode));
      const ratio = contrast(hexToRgb(palette.signal.wave), hexToRgb(palette.canvasBackground));
      assert.ok(
        ratio >= 3,
        `${mode} waveform ${palette.signal.wave} on ${palette.canvasBackground}: ${ratio.toFixed(2)}:1`
      );
    }
  });

  it('keeps both slice markers visible on the canvas in both themes (non-text, >= 3:1)', () => {
    for (const mode of ['dark', 'light'] as const) {
      const palette = readSlicerPalette(makeDocument(mode));
      const canvas = hexToRgb(palette.canvasBackground);
      for (const key of ['markerActive', 'markerInactive'] as const) {
        const ratio = contrast(hexToRgb(palette.signal[key]), canvas);
        assert.ok(
          ratio >= 3,
          `${mode} ${key} ${palette.signal[key]} on ${palette.canvasBackground}: ${ratio.toFixed(2)}:1`
        );
      }
    }
  });

  it('keeps both badge numbers readable on their badge fill in both themes (text, >= 4.5:1)', () => {
    for (const mode of ['dark', 'light'] as const) {
      const signal = readSlicerPalette(makeDocument(mode)).signal;
      const pairs: Array<[string, string]> = [
        ['badgeTextActive', 'badgeActive'],
        ['badgeTextInactive', 'badgeInactive'],
      ];
      for (const [textKey, fillKey] of pairs) {
        const ratio = contrast(hexToRgb(signal[textKey]), hexToRgb(signal[fillKey]));
        assert.ok(
          ratio >= 4.5,
          `${mode} ${textKey} ${signal[textKey]} on ${fillKey} ${signal[fillKey]}: ${ratio.toFixed(2)}:1`
        );
      }
    }
  });

  it('keeps the Light badge fill distinct from the Light canvas so the badge reads as a chip', () => {
    const light = readSlicerPalette(makeDocument('light')).signal;
    assert.notEqual(light.badgeInactive, light.badgeActive);
    const ratio = contrast(hexToRgb(light.badgeInactive), hexToRgb(LIGHT_TOKENS['--apex-canvas']));
    assert.ok(ratio >= 1.05, `Light inactive badge is distinguishable from the canvas: ${ratio.toFixed(2)}:1`);
  });

  it('gives cyan text a Light value that clears AA on the surfaces the chart sits on', () => {
    // The sensitivity readout uses --apex-cyan-text on a card, and the section
    // icons use the decorative --apex-cyan. Values come from the real index.css.
    const cyanText = hexToRgb(LIGHT_TOKENS['--apex-cyan-text']);
    const surfaces: Rgb[] = [
      hexToRgb(LIGHT_TOKENS['--apex-surface-2']),
      hexToRgb(LIGHT_TOKENS['--apex-surface']),
      hexToRgb(LIGHT_TOKENS['--apex-bg']),
      hexToRgb(LIGHT_TOKENS['--apex-panel-header']),
    ];
    for (const surface of surfaces) {
      const ratio = contrast(cyanText, surface);
      assert.ok(ratio >= 4.5, `Light cyan text on ${surface.map(Math.round)}: ${ratio.toFixed(2)}:1`);
    }
  });

  it('keeps the primary-button label at AA on the rest and hover fills in both themes', () => {
    // Button label: --apex-state-playing-fg. Rest fill: --apex-cyan. Hover fill:
    // --apex-cyan-strong, a solid token rather than a brightness filter. The
    // browser suite measures the composited pixels.
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

  it('follows a theme flip on the next read with no stale palette', () => {
    const doc = makeDocument('dark');
    const dark = readSlicerPalette(doc);
    assert.equal(dark.mode, 'dark');
    (doc.documentElement as unknown as { dataset: { theme: string } }).dataset.theme = 'light';
    const light = readSlicerPalette(doc);
    assert.equal(light.mode, 'light');
    assert.equal(light.canvasBackground, LIGHT_TOKENS['--apex-canvas']);
    assert.equal(light.signal.wave, SLICER_SIGNAL_COLORS.light.wave);
  });

  it('returns the same object while the theme is unchanged (cheap per-repaint reads)', () => {
    const doc = makeDocument('light');
    assert.equal(readSlicerPalette(doc), readSlicerPalette(doc));
  });

  it('falls back to the Dark canvas when no document is available (no DOM)', () => {
    const palette = readSlicerPalette(null);
    assert.equal(palette.mode, 'dark');
    assert.equal(palette.canvasBackground, '#151821');
  });

  it('falls back when the canvas token cannot be read', () => {
    const doc = {
      documentElement: { dataset: { theme: 'light' } },
      defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '' }) },
    } as unknown as CanvasThemeDocument;
    const palette = readSlicerPalette(doc);
    assert.equal(palette.mode, 'light');
    assert.equal(palette.canvasBackground, '#151821');
  });
});
