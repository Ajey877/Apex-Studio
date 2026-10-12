/**
 * UI-03E — Audio Slicer theme, asserted against the markup the real component
 * produces (`renderToStaticMarkup`, as in the UI-03B/C/D suites).
 *
 * 1. The dialog renders in full (title, controls, waveform section, footer).
 * 2. Class attributes carry no colour literals and no `text-white` / `text-black`
 *    / `bg-black` utilities, so chrome follows the active theme's tokens.
 * 3. The theme is expressed by CSS custom properties, not by the markup.
 * 4. The canvas draw loop paints from the palette seam and repaints when the
 *    theme flips, and the overlay uses the shared modal scrim token.
 *
 * The live pixel repaint and the computed text contrast are proven in
 * browser-tests/audioSlicerTheme.spec.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AudioSlicerModal } from './AudioSlicerModal';
import type { Channel } from '../types/daw';

const noop = (): void => {};

// No `customSample`, so the modal renders its honest empty state (Phase 52):
// it must never draw audio that does not exist in the project.
const channels = [{ id: 'ch-1', name: 'Kick', instrumentType: 'sampler' }] as unknown as Channel[];

const render = () =>
  renderToStaticMarkup(
    React.createElement(AudioSlicerModal, {
      isOpen: true,
      onClose: noop,
      channels,
      onUpdateChannel: noop,
    })
  );

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);

const source = readFileSync('src/components/AudioSlicerModal.tsx', 'utf8');

describe('Audio Slicer theme markup (UI-03E)', () => {
  it('renders the full dialog', () => {
    const markup = render();
    assert.match(markup, /id="audio-slicer-modal-title"/);
    assert.match(markup, /SAMPLE TRANSIENT SLICER &amp; CHOPPER/);
    assert.match(markup, /AUTO-CHOP/);
    assert.match(markup, /TARGET CHANNEL/);
    assert.match(markup, /DETECTION MODE/);
    assert.match(markup, /THRESHOLD SENSITIVITY/);
    assert.match(markup, /SAMPLE WAVEFORM — NO AUDIO LOADED/);
    assert.match(markup, /Map Chops to Piano Roll/);
    assert.match(markup, /Map to 16 Steps/);
    assert.match(markup, /Done/);
  });

  it('carries no colour literal or white/black utility in any class attribute', () => {
    const offenders = classAttributes(render()).filter((cls) =>
      /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|from|to|accent|ring)-\[#|\b(?:text|bg|border)-(?:white|black)\b|bg-black|rgba?\(/i.test(cls)
    );
    assert.deepEqual(offenders, [], 'class attributes must use semantic tokens only');
  });

  it('expresses theme colour through CSS custom properties, not markup', () => {
    const classes = classAttributes(render()).join(' ');
    for (const token of [
      '--apex-surface',
      '--apex-surface-2',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-cyan',
      '--apex-cyan-text',
      '--apex-state-playing-fg',
      '--apex-canvas',
      '--apex-gold',
      '--apex-border',
    ]) {
      assert.ok(classes.includes(`var(${token})`), `chrome uses ${token}`);
    }
  });

  it('gives the primary action a solid AA hover fill, not a brightness filter', () => {
    assert.ok(
      source.includes('hover:bg-[var(--apex-cyan-strong)]'),
      'Map Chops to Piano Roll uses the cyan-strong hover fill'
    );
    assert.doesNotMatch(source, /hover:brightness-/, 'brightness hover filters are gone');
  });

  it('keeps toast text at full strength: no translucent playing-fg text (dismiss glyph included)', () => {
    assert.doesNotMatch(
      source,
      /text-\[var\(--apex-state-playing-fg\)\]\/\d/,
      'toast text on the cyan fill must not be alpha-blended'
    );
    assert.doesNotMatch(source, /text-black\/80/, 'the active pad duration is no longer alpha-blended');
  });

  it('uses the shared modal scrim token for the overlay', () => {
    assert.match(source, /apex-modal-overlay/, 'overlay uses the shared scrim token');
    assert.doesNotMatch(source, /bg-black\//, 'no hardcoded black scrim');
  });

  it('paints the waveform canvas from the palette seam on every repaint', () => {
    assert.match(source, /readSlicerPalette\(\)/, 'the draw loop reads the palette');
    assert.match(source, /ctx\.fillStyle = palette\.canvasBackground/, 'background comes from the seam');
    assert.match(source, /ctx\.fillStyle = signal\.wave/, 'waveform comes from the seam');
    assert.match(
      source,
      /ctx\.strokeStyle = isActive \? signal\.markerActive : signal\.markerInactive/,
      'slice markers come from the seam'
    );
    assert.match(
      source,
      /ctx\.fillStyle = isActive \? signal\.badgeActive : signal\.badgeInactive/,
      'slice badges come from the seam'
    );
    assert.match(
      source,
      /ctx\.fillStyle = isActive \? signal\.badgeTextActive : signal\.badgeTextInactive/,
      'badge numbers come from the seam'
    );
  });

  it('repaints the canvas when the theme flips, so an open dialog is never stale', () => {
    assert.match(
      source,
      /new MutationObserver\(draw\)/,
      'a theme mutation triggers the same draw function'
    );
    assert.match(
      source,
      /observer\.observe\(document\.documentElement, \{ attributeFilter: \['data-theme'\] \}\)/,
      'the observer watches the theme attribute the settings switch writes'
    );
    assert.match(source, /observer\.disconnect\(\)/, 'the observer is cleaned up');
  });

  it('contains no colour literal in the component source (the seam owns the palette)', () => {
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, 'hex literals belong in audioSlicerTheme.ts');
    assert.doesNotMatch(source, /rgba\(/, 'no literal rgba() paint strings');
  });

  it('keeps the Phase 52 truth copy unchanged', () => {
    const markup = render();
    assert.match(markup, /NO SAMPLE TO SLICE/);
    assert.match(
      markup,
      /&quot;Kick&quot; has no sample assigned\. Load or import a sample into this channel to slice it\./
    );
    assert.match(markup, /Nothing to slice yet/);
  });
});
