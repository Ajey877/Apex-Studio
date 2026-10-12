/**
 * UI-03G — Parametric EQ palette seam, unit level.
 *
 * Covers the seam in isolation: the graph chrome (canvas background, grid, axis
 * labels) follows the document theme with no stale cache; the Dark response
 * curve, spectrum and node rings are the exact shipped literals; and every
 * colour the graph paints clears its floor in both themes — 3:1 for the curve
 * and the node rings (non-text), 4.5:1 for the axis labels and the band number
 * (text). Token values come from the real `src/index.css`; band fills come from
 * the real `parametricEqBands.EQ_BAND_SPECS`, so neither table can drift.
 *
 * Negative controls are asserted alongside each floor: the value `main` painted
 * is shown to fail the same floor, so the tests would not pass against the
 * unmigrated component.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EQ_BAND_SPECS } from './parametricEqBands';
import {
  EQ_AXIS_LABEL_TOKEN,
  EQ_CANVAS_TOKEN,
  EQ_GRID_STRONG_TOKEN,
  EQ_GRID_TOKEN,
  readEqPalette,
} from './parametricEqTheme';
import type { CanvasThemeDocument } from './canvasThemeTokens';
import { DARK_TOKENS, LIGHT_TOKENS, hexToRgb, makeThemeDocument as makeDocument } from './themeTestDocument';

const relativeLuminance = (rgb: [number, number, number]): number => {
  const lin = rgb.map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722;
};

const contrast = (a: string, b: string): number => {
  const la = relativeLuminance(hexToRgb(a));
  const lb = relativeLuminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const BAND_FILLS = EQ_BAND_SPECS.map((spec) => spec.color);

describe('Parametric EQ palette seam (UI-03G)', () => {
  it('resolves the graph chrome from the active theme tokens', () => {
    for (const mode of ['dark', 'light'] as const) {
      const tokens = mode === 'dark' ? DARK_TOKENS : LIGHT_TOKENS;
      const palette = readEqPalette(makeDocument(mode));
      assert.equal(palette.mode, mode);
      assert.equal(palette.canvasBackground, tokens[EQ_CANVAS_TOKEN]);
      assert.equal(palette.gridLine, tokens[EQ_GRID_TOKEN]);
      assert.equal(palette.gridLineStrong, tokens[EQ_GRID_STRONG_TOKEN]);
      assert.equal(palette.axisLabel, tokens[EQ_AXIS_LABEL_TOKEN]);
    }
  });

  it('keeps the Dark response curve, spectrum and node rings exactly as shipped', () => {
    const dark = readEqPalette(makeDocument('dark')).graph;
    // The literals the canvas painted before UI-03G. Dark must not move.
    assert.equal(dark.curve, '#ff6e00');
    assert.equal(dark.spectrum, 'rgba(255, 110, 0, 0.15)');
    assert.equal(dark.nodeOutline, '#000000');
    assert.equal(dark.nodeOutlineSelected, '#ffffff');
  });

  it('uses the Light gold value for the Light curve and its spectrum', () => {
    const light = readEqPalette(makeDocument('light')).graph;
    assert.equal(light.curve, LIGHT_TOKENS['--apex-gold']);
    assert.equal(light.curve, '#9a5d00');
    assert.equal(light.spectrum, 'rgba(154, 93, 0, 0.15)');
  });

  it('keeps the response curve above the 3:1 non-text floor in both themes', () => {
    for (const mode of ['dark', 'light'] as const) {
      const palette = readEqPalette(makeDocument(mode));
      const ratio = contrast(palette.graph.curve, palette.canvasBackground);
      assert.ok(ratio >= 3, `${mode} curve ${palette.graph.curve} on ${palette.canvasBackground} = ${ratio.toFixed(2)}:1`);
    }
  });

  it('the shipped Dark curve clears 3:1, and the Light canvas would have rejected it', () => {
    // Why Light takes a different curve: the literal Dark stroke measures below
    // the 3:1 floor on the Light canvas (2.59:1, the same finding as UI-03E/F).
    assert.ok(contrast('#ff6e00', LIGHT_TOKENS['--apex-canvas']) < 3);
    assert.ok(contrast('#ff6e00', DARK_TOKENS['--apex-canvas']) >= 3);
  });

  it('keeps the axis labels at AA on the canvas in both themes', () => {
    for (const mode of ['dark', 'light'] as const) {
      const palette = readEqPalette(makeDocument(mode));
      const ratio = contrast(palette.axisLabel, palette.canvasBackground);
      assert.ok(ratio >= 4.5, `${mode} axis label ${palette.axisLabel} on ${palette.canvasBackground} = ${ratio.toFixed(2)}:1`);
    }
  });

  it('the shipped axis label would have failed AA in Dark', () => {
    // The grid label `main` painted: 2.41:1 on the Dark canvas. The shipped
    // Dark canvas was already below the text floor before this phase.
    assert.ok(contrast('#555560', DARK_TOKENS['--apex-canvas']) < 4.5);
  });

  it('keeps the band number at AA on every band fill in both themes', () => {
    assert.equal(BAND_FILLS.length, 3, 'the editor edits the three stages the insert builds');
    for (const mode of ['dark', 'light'] as const) {
      const label = readEqPalette(makeDocument(mode)).graph.nodeLabel;
      for (const fill of BAND_FILLS) {
        const ratio = contrast(label, fill);
        assert.ok(ratio >= 4.5, `${mode} node label ${label} on band fill ${fill} = ${ratio.toFixed(2)}:1`);
      }
    }
  });

  it('the shipped white band number would have failed AA on two of three fills', () => {
    // The one Dark delta. `main` painted `#ffffff` inside the node: 2.85:1 on
    // the low band, 2.10:1 on the mid band, 3.15:1 on the high band.
    const shipped = BAND_FILLS.map((fill) => contrast('#ffffff', fill));
    assert.ok(shipped.some((ratio) => ratio < 4.5), 'at least one fill rejected the shipped white label');
    assert.ok(shipped.every((ratio) => ratio < 4.5), 'no fill met AA with the shipped white label');
  });

  it('keeps the selected node ring above 3:1 on the canvas in both themes', () => {
    for (const mode of ['dark', 'light'] as const) {
      const palette = readEqPalette(makeDocument(mode));
      const ratio = contrast(palette.graph.nodeOutlineSelected, palette.canvasBackground);
      assert.ok(ratio >= 3, `${mode} selected ring ${palette.graph.nodeOutlineSelected} on ${palette.canvasBackground} = ${ratio.toFixed(2)}:1`);
    }
  });

  it('keeps the Dark node fills above 3:1 on the canvas, exactly as shipped', () => {
    // In Dark the fill is what locates a handle: the shipped unselected ring is
    // `#000000`, 1.18:1 on the Dark canvas, so it is an edge treatment rather
    // than the visible boundary. The fills are unchanged by this phase.
    const dark = readEqPalette(makeDocument('dark'));
    assert.equal(dark.graph.nodeOutline, '#000000', 'the shipped unselected ring is preserved');
    for (const fill of BAND_FILLS) {
      const ratio = contrast(fill, dark.canvasBackground);
      assert.ok(ratio >= 3, `dark band fill ${fill} on ${dark.canvasBackground} = ${ratio.toFixed(2)}:1`);
    }
  });

  it('gives Light a 3:1 unselected ring, because the preserved fills are too low there', () => {
    // The band fills are project data and stay as they are, but on the Light
    // canvas they measure 2.63:1 / 1.94:1 / 2.91:1 — under the 3:1 non-text
    // floor. That is why the Light unselected ring is `--apex-text` (15.12:1):
    // on a light canvas the ring, not the fill, is what locates a handle.
    const light = readEqPalette(makeDocument('light'));
    for (const fill of BAND_FILLS) {
      assert.ok(contrast(fill, light.canvasBackground) < 3, `${fill} is below 3:1 on the Light canvas`);
    }
    assert.ok(contrast(light.graph.nodeOutline, light.canvasBackground) >= 3);
  });

  it('the shipped selected ring would have vanished on the Light canvas', () => {
    // 1.08:1 — the same failure UI-03E recorded for the Slicer's white marker.
    assert.ok(contrast('#ffffff', LIGHT_TOKENS['--apex-canvas']) < 3);
    const light = readEqPalette(makeDocument('light'));
    assert.equal(light.graph.nodeOutlineSelected, LIGHT_TOKENS['--apex-accent']);
    assert.equal(light.graph.nodeOutline, LIGHT_TOKENS['--apex-text']);
  });

  it('leaves the band fills alone: they are project data, not theme tokens', () => {
    // The node fill is `band.color` from EQ_BAND_SPECS, which the band cards
    // render as a swatch from the same field. The seam must not own it.
    const seam = JSON.stringify(readEqPalette(makeDocument('dark')));
    for (const fill of BAND_FILLS) assert.ok(!seam.includes(fill), `${fill} must not be in the seam`);
  });

  it('never serves a stale palette after a theme flip', () => {
    const doc = makeDocument('dark');
    assert.equal(readEqPalette(doc).mode, 'dark');
    assert.equal(readEqPalette(doc).graph.curve, '#ff6e00');
    (doc as unknown as { documentElement: { dataset: { theme: string } } }).documentElement.dataset.theme = 'light';
    const light = readEqPalette(doc);
    assert.equal(light.mode, 'light');
    assert.equal(light.graph.curve, LIGHT_TOKENS['--apex-gold']);
    assert.equal(light.canvasBackground, LIGHT_TOKENS['--apex-canvas']);
    assert.equal(light.gridLine, LIGHT_TOKENS['--apex-grid-line']);
    (doc as unknown as { documentElement: { dataset: { theme: string } } }).documentElement.dataset.theme = 'dark';
    assert.equal(readEqPalette(doc).graph.curve, '#ff6e00');
    assert.equal(readEqPalette(doc).gridLine, DARK_TOKENS['--apex-grid-line']);
  });

  it('returns the same palette object for an unchanged theme (per-frame cost is one lookup)', () => {
    const doc = makeDocument('light');
    const first = readEqPalette(doc);
    assert.equal(readEqPalette(doc), first);
    assert.equal(readEqPalette(doc), first);
  });

  it('keeps separate caches per document', () => {
    const dark = makeDocument('dark');
    const light = makeDocument('light');
    assert.equal(readEqPalette(dark).mode, 'dark');
    assert.equal(readEqPalette(light).mode, 'light');
    assert.equal(readEqPalette(dark).mode, 'dark');
  });

  it('falls back to the Dark graph chrome when no document is available', () => {
    const palette = readEqPalette(null);
    assert.equal(palette.mode, 'dark');
    assert.equal(palette.canvasBackground, '#151821');
    assert.equal(palette.gridLine, '#242936');
    assert.equal(palette.gridLineStrong, '#343a4a');
    assert.equal(palette.axisLabel, '#8b95a8');
    assert.equal(palette.graph.curve, '#ff6e00');
  });

  it('falls back to the fixed Dark values when the tokens cannot be read', () => {
    const doc = {
      documentElement: { dataset: { theme: 'light' } },
      defaultView: { getComputedStyle: () => ({ getPropertyValue: () => '' }) },
    } as unknown as CanvasThemeDocument;
    const palette = readEqPalette(doc);
    assert.equal(palette.mode, 'light');
    assert.equal(palette.canvasBackground, '#151821');
    assert.equal(palette.gridLine, '#242936');
    assert.equal(palette.gridLineStrong, '#343a4a');
    assert.equal(palette.axisLabel, '#8b95a8');
    // Signal colours are per-mode constants, so they still follow the theme.
    assert.equal(palette.graph.curve, '#9a5d00');
  });
});
