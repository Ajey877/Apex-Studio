/**
 * UI-03F — Audio Recorder palette seam, unit level.
 *
 * Covers the seam in isolation: the canvas background follows the document
 * theme with no stale cache, the Dark waveform is the exact shipped literal, and
 * the waveform clears the non-text 3:1 floor on the canvas in both themes. Token
 * values come from the real `src/index.css`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readRecorderPalette } from './audioRecorderTheme';
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

describe('Audio Recorder palette seam (UI-03F)', () => {
  it('resolves the canvas background from the active theme token', () => {
    assert.equal(readRecorderPalette(makeDocument('dark')).canvasBackground, DARK_TOKENS['--apex-canvas']);
    assert.equal(readRecorderPalette(makeDocument('light')).canvasBackground, LIGHT_TOKENS['--apex-canvas']);
  });

  it('keeps the Dark waveform exactly as shipped', () => {
    const dark = readRecorderPalette(makeDocument('dark'));
    assert.equal(dark.mode, 'dark');
    // The literal the canvas stroked before UI-03F. Dark must not move.
    assert.equal(dark.signal.wave, '#ff6e00');
  });

  it('uses the Light gold value for the Light waveform', () => {
    const light = readRecorderPalette(makeDocument('light'));
    assert.equal(light.mode, 'light');
    assert.equal(light.signal.wave, LIGHT_TOKENS['--apex-gold']);
    assert.equal(light.signal.wave, '#9a5d00');
  });

  it('keeps the waveform above the 3:1 non-text floor on the canvas in both themes', () => {
    for (const mode of ['dark', 'light'] as const) {
      const palette = readRecorderPalette(makeDocument(mode));
      const ratio = contrast(hexToRgb(palette.signal.wave), hexToRgb(palette.canvasBackground));
      assert.ok(ratio >= 3, `${mode} waveform ${palette.signal.wave} on ${palette.canvasBackground} = ${ratio.toFixed(2)}:1`);
    }
  });

  it('the shipped Dark waveform clears 3:1, and the Light canvas would have rejected it', () => {
    // Why Light takes a different value: the literal Dark stroke measures below
    // the 3:1 floor on the Light canvas (2.59:1, UI-03E audit).
    assert.ok(contrast(hexToRgb('#ff6e00'), hexToRgb(LIGHT_TOKENS['--apex-canvas'])) < 3);
    assert.ok(contrast(hexToRgb('#ff6e00'), hexToRgb(DARK_TOKENS['--apex-canvas'])) >= 3);
  });

  it('never serves a stale palette after a theme flip', () => {
    const doc = makeDocument('dark');
    const dark = readRecorderPalette(doc);
    assert.equal(dark.mode, 'dark');
    (doc as unknown as { documentElement: { dataset: { theme: string } } }).documentElement.dataset.theme = 'light';
    const light = readRecorderPalette(doc);
    assert.equal(light.mode, 'light');
    assert.equal(light.signal.wave, LIGHT_TOKENS['--apex-gold']);
    assert.equal(light.canvasBackground, LIGHT_TOKENS['--apex-canvas']);
    (doc as unknown as { documentElement: { dataset: { theme: string } } }).documentElement.dataset.theme = 'dark';
    assert.equal(readRecorderPalette(doc).signal.wave, '#ff6e00');
  });

  it('returns the same palette object for an unchanged theme (per-frame cost is one lookup)', () => {
    const doc = makeDocument('light');
    const first = readRecorderPalette(doc);
    assert.equal(readRecorderPalette(doc), first);
    assert.equal(readRecorderPalette(doc), first);
  });

  it('keeps separate caches per document', () => {
    const dark = makeDocument('dark');
    const light = makeDocument('light');
    assert.equal(readRecorderPalette(dark).mode, 'dark');
    assert.equal(readRecorderPalette(light).mode, 'light');
    assert.equal(readRecorderPalette(dark).mode, 'dark');
  });

  it('falls back to the Dark canvas when no document is available', () => {
    const palette = readRecorderPalette(null);
    assert.equal(palette.mode, 'dark');
    assert.equal(palette.canvasBackground, '#151821');
    assert.equal(palette.signal.wave, '#ff6e00');
  });

  it('falls back to the fixed canvas colour when the token cannot be read', () => {
    const doc = {
      documentElement: { dataset: { theme: 'light' } },
      defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '' }) },
    } as unknown as CanvasThemeDocument;
    const palette = readRecorderPalette(doc);
    assert.equal(palette.mode, 'light');
    assert.equal(palette.canvasBackground, '#151821');
    assert.equal(palette.signal.wave, '#9a5d00');
  });
});
