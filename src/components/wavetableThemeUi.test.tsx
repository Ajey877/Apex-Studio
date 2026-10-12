/**
 * UI-03D — Wavetable preview theme, asserted against the markup the real
 * component produces (`renderToStaticMarkup`, as in the UI-03B/C suites).
 *
 * 1. The dialog renders in full (title, controls, presets, footer).
 * 2. Class attributes carry no colour literals and no `text-white` / `text-black`
 *    / `bg-black` utilities, so chrome follows the active theme's tokens.
 * 3. The theme is expressed by CSS custom properties, not by the markup.
 * 4. The waterfall draw loop paints from the palette seam each frame, and the
 *    overlay uses the shared modal scrim token.
 *
 * The live pixel repaint and the computed text contrast are proven in
 * browser-tests/wavetableTheme.spec.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WavetableSynthModal } from './WavetableSynthModal';
import type { Channel } from '../types/daw';

const noop = (): void => {};

const channels = [{ id: 'ch-1', name: 'Lead', color: '#00e5ff' }] as unknown as Channel[];

const render = () =>
  renderToStaticMarkup(
    React.createElement(WavetableSynthModal, {
      isOpen: true,
      onClose: noop,
      channels,
      onUpdateChannel: noop,
    })
  );

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);

const source = readFileSync('src/components/WavetableSynthModal.tsx', 'utf8');

describe('Wavetable preview theme markup (UI-03D)', () => {
  it('renders the full dialog', () => {
    const markup = render();
    assert.match(markup, /id="fl-wavetable-synth-modal-title"/);
    assert.match(markup, /ADVANCED SYNTH PREVIEW \(WAVETABLE NOT IMPLEMENTED\)/);
    assert.match(markup, /<canvas/);
    assert.match(markup, /WAVETABLE MORPH \(WT POS\)/);
    assert.match(markup, /Close Preview/);
  });

  it('carries no colour literal or white/black utility in any class attribute', () => {
    const offenders = classAttributes(render()).filter((cls) =>
      /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|from|to|accent|ring)-\[#|\b(?:text|bg|border)-(?:white|black)\b|bg-black|rgba?\(/i.test(cls)
    );
    assert.deepEqual(offenders, [], 'class attributes must use semantic tokens only');
  });

  it('expresses theme colour through CSS custom properties, not markup', () => {
    const classes = classAttributes(render()).join(' ');
    for (const token of ['--apex-surface', '--apex-text', '--apex-text-3', '--apex-cyan', '--apex-state-playing-fg', '--apex-canvas']) {
      assert.ok(classes.includes(`var(${token})`), `chrome uses ${token}`);
    }
  });

  it('gives both primary buttons a solid AA hover fill, not a brightness filter', () => {
    assert.equal(
      source.match(/hover:bg-\[var\(--apex-cyan-strong\)\]/g)?.length,
      2,
      'Audition C3 and Close Preview both use the cyan-strong hover fill'
    );
    assert.doesNotMatch(source, /hover:brightness-/, 'brightness hover filters are gone');
  });

  it('keeps toast text at full strength: no translucent playing-fg text (dismiss glyph included)', () => {
    assert.doesNotMatch(
      source,
      /text-\[var\(--apex-state-playing-fg\)\]\/\d/,
      'toast text on the cyan fill must not be alpha-blended; the dismiss glyph reached only 3.56:1 at 80%'
    );
  });

  it('uses the shared modal scrim token for the overlay', () => {
    assert.match(source, /apex-modal-overlay/, 'overlay uses the shared scrim token');
    assert.doesNotMatch(source, /bg-black\//, 'no hardcoded black scrim');
  });

  it('paints the waterfall from the palette seam every frame', () => {
    assert.match(source, /readWavetablePalette\(\)/, 'the draw loop reads the palette each frame');
    assert.match(source, /ctx\.fillStyle = palette\.canvasBackground/, 'background comes from the seam');
    assert.match(source, /palette\.signal\.current/, 'selected frame comes from the seam');
    assert.match(source, /waveFrameStroke\(palette\.signal, frameProgress\)/, 'inactive frames come from the seam');
  });

  it('contains no colour literal in the component source (the seam owns the palette)', () => {
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, 'hex literals belong in wavetableTheme.ts');
    assert.doesNotMatch(source, /rgba\(0, 229, 255/, 'the legacy waveform literal is gone from the component');
  });

  it('keeps the preview-only truth copy unchanged', () => {
    const markup = render();
    assert.match(markup, /Preview only: this window does not change how the channel sounds/);
    assert.match(markup, /NOT APPLIED — NO WAVETABLE OSCILLATOR IN THE ENGINE/);
  });
});
