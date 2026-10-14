/**
 * UI-03Q — Sample Manager residual scrim migration.
 * See exportThemeUi.test.tsx for the batch rationale. The waveform trim
 * markers keep their semantic success/danger tokens (UI-04 pin).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SampleManagerModal } from './SampleManagerModal';
import { DEFAULT_PROJECT } from '../audio/presets';
import { DARK_TOKENS, LIGHT_TOKENS, hexToRgb } from './themeTestDocument';

const noop = (): void => {};
const render = (isOpen = true): string =>
  renderToStaticMarkup(
    React.createElement(SampleManagerModal, {
      isOpen, onClose: noop, channels: DEFAULT_PROJECT.channels,
      sampleLibrary: DEFAULT_PROJECT.sampleLibrary ?? [],
      selectedChannel: DEFAULT_PROJECT.channels[0],
      onSampleImported: noop, onAssignSampleToChannel: noop, onCreateChannelFromSample: noop,
    })
  );
const source = readFileSync('src/components/SampleManagerModal.tsx', 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
const luminance = ([r, g, b]: [number, number, number]): number => {
  const ch = (v: number): number => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const contrast = (a: string, b: string): number => {
  const x = luminance(hexToRgb(a)); const y = luminance(hexToRgb(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe('Sample Manager modal residual theme migration (UI-03Q)', () => {
  it('renders the loader contract and returns nothing when closed', () => {
    const markup = render();
    assert.match(markup, /id="sample-manager-modal-title"/);
    assert.match(markup, /APEX AUDIO SAMPLE LOADER/);
    assert.match(markup, /aria-label="Close sample manager"/);
    assert.equal(render(false), '');
  });
  it('the scrim is the shared themed primitive with no literal fill', () => {
    const markup = render();
    const root = markup.slice(0, markup.indexOf('>') + 1);
    assert.ok(root.includes('apex-modal-overlay'));
    assert.ok(!root.includes('bg-black'));
    assert.equal(/bg-black|text-white|bg-white/.test(code), false);
  });
  it('keeps the trim-marker and import behaviour seams', () => {
    assert.match(code, /shadow-\[0_0_8px_var\(--apex-success\)\]/);
    assert.match(code, /shadow-\[0_0_8px_var\(--apex-danger\)\]/);
    assert.match(code, /onSampleImported/);
    assert.match(code, /onCreateChannelFromSample/);
  });
  it('title, body and trim markers clear their floors in both themes', () => {
    for (const tokens of [DARK_TOKENS, LIGHT_TOKENS]) {
      assert.ok(contrast(tokens['--apex-text'], tokens['--apex-surface']) >= 4.5);
      assert.ok(contrast(tokens['--apex-success'], tokens['--apex-canvas']) >= 3);
      assert.ok(contrast(tokens['--apex-danger'], tokens['--apex-canvas']) >= 3);
    }
  });
});
