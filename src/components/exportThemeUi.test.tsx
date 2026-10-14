/**
 * UI-03Q — Export modal residual scrim migration.
 * Interiors were already tokenised; the last literal was the dead
 * `bg-black/85` fill on the ModalFrame overlay (the unlayered
 * `apex-modal-overlay` rule already owned the rendered scrim).
 * Live pixels are measured in `browser-tests/exportTheme.spec.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExportModal } from './ExportModal';
import { DEFAULT_PROJECT } from '../audio/presets';
import { DARK_TOKENS, LIGHT_TOKENS, hexToRgb } from './themeTestDocument';

const noop = (): void => {};
const render = (isOpen = true): string =>
  renderToStaticMarkup(
    React.createElement(ExportModal, {
      isOpen, onClose: noop, channels: DEFAULT_PROJECT.channels,
      clips: DEFAULT_PROJECT.playlistClips, mixerTracks: DEFAULT_PROJECT.mixerTracks,
      meta: DEFAULT_PROJECT.meta, patternLengthSteps: 16,
      playlistTracks: DEFAULT_PROJECT.playlistTracks,
    })
  );
const source = readFileSync('src/components/ExportModal.tsx', 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
const luminance = ([r, g, b]: [number, number, number]): number => {
  const ch = (v: number): number => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const contrast = (a: string, b: string): number => {
  const x = luminance(hexToRgb(a)); const y = luminance(hexToRgb(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe('Export modal residual theme migration (UI-03Q)', () => {
  it('renders the dialog contract and returns nothing when closed', () => {
    const markup = render();
    assert.match(markup, /id="export-modal"/);
    assert.match(markup, /id="export-modal-title"/);
    assert.match(markup, /PROJECT EXPORT/);
    assert.match(markup, /aria-label="Close export"/);
    assert.equal(render(false), '');
  });
  it('the scrim is the shared themed primitive with no literal fill', () => {
    const root = render().slice(0, render().indexOf('>') + 1);
    assert.ok(root.includes('apex-modal-overlay'));
    assert.ok(!root.includes('bg-black'));
    assert.equal(/bg-black|text-white|bg-white/.test(code), false);
  });
  it('keeps the render-in-flight dismissal guard', () => {
    assert.match(code, /dismissible=\{!isRendering\}/);
    assert.match(code, /disabled=\{isRendering\}/);
  });
  it('title and body text clear AA on the panel in both themes', () => {
    for (const tokens of [DARK_TOKENS, LIGHT_TOKENS]) {
      assert.ok(contrast(tokens['--apex-text'], tokens['--apex-surface']) >= 4.5);
      assert.ok(contrast(tokens['--apex-text-2'], tokens['--apex-surface']) >= 4.5);
      assert.ok(contrast(tokens['--apex-text-3'], tokens['--apex-panel-header']) >= 4.5);
    }
    assert.notEqual(DARK_TOKENS['--apex-modal-overlay'], LIGHT_TOKENS['--apex-modal-overlay']);
  });
});
