/**
 * UI-03H — Vocal Tuner theme, asserted against the markup the real component
 * produces (`renderToStaticMarkup`, as in the UI-03B/C/D/E/F/G suites) and
 * against the component source where a branch is only reachable after
 * interaction.
 *
 * 1. The dialog renders in full (title, presets, key grid, scale select,
 *    unavailable-state banner, four parameter sliders, footer).
 * 2. Class attributes carry no colour literal and no `text-white` / `text-black`
 *    / `bg-black` / Tailwind palette utility, so chrome follows the theme.
 * 3. The theme is expressed by CSS custom properties, not by the markup.
 * 4. The overlay is the shared scrim, supplied by ModalFrame.
 * 5. Each parameter slider keeps its distinct signal colour mapped to a
 *    semantic token (cyan for retune, success for formant, accent for
 *    vibrato, aux for humanize) and each primary/secondary action pairs a
 *    fill token with its matching on-colour label.
 *
 * The Vocal Tuner carries no canvas, so there is no `vocalTunerTheme.ts`
 * palette seam; chrome and data colours are resolved entirely through CSS
 * custom properties and token utilities.
 *
 * Live pixel contrast and theme-flip behaviour are proven in
 * browser-tests/vocalTunerTheme.spec.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VocalTunerModal } from './VocalTunerModal';
import { DEFAULT_PROJECT } from '../audio/presets';
import type { VocalTunerSettings } from '../types/daw';

const noop = (): void => {};

const settings: VocalTunerSettings = {
  enabled: true,
  rootKey: 0,
  scale: 'minor',
  retuneSpeedMs: 15,
  formantShift: 0,
  vibratoDepth: 0.2,
  humanize: 0.3,
};

const render = (overrides: Partial<VocalTunerSettings> = {}): string =>
  renderToStaticMarkup(
    React.createElement(VocalTunerModal, {
      isOpen: true,
      onClose: noop,
      vocalTunerSettings: { ...settings, ...overrides },
      onUpdateVocalTuner: noop,
      channels: DEFAULT_PROJECT.channels,
    })
  );

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);

const source = readFileSync('src/components/VocalTunerModal.tsx', 'utf8');

/** A colour literal, a white/black/alpha-black utility, or a Tailwind palette colour. */
const UNTHEMED =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|from|to|accent|ring|fill)-\[#|\b(?:text|bg|border)-(?:white|black)\b|bg-black|rgba?\(|\b(?:text|bg|border)-(?:red|amber|green|gray|zinc|neutral)-\d/i;

describe('Vocal Tuner theme markup (UI-03H)', () => {
  it('renders the full dialog with all preset, key, scale and slider sections', () => {
    const markup = render();
    assert.match(markup, /id="fl-vocal-tuner-modal-title"/);
    assert.match(markup, /AUTO-PITCH &amp; VOCAL TUNER/);
    assert.match(markup, /PRO VOCAL PRESETS/);
    assert.match(markup, /Hard Robotic Snap/);
    assert.match(markup, /1\. MUSICAL ROOT KEY/);
    assert.match(markup, /2\. TARGET MUSICAL SCALE/);
    assert.match(markup, /PITCH DETECTION UNAVAILABLE/);
    assert.match(markup, /RETUNE SPEED/);
    assert.match(markup, /FORMANT SHIFT/);
    assert.match(markup, /VIBRATO DEPTH/);
    assert.match(markup, /HUMANIZE/);
    assert.match(markup, /Reset Tuner/);
    assert.match(markup, /Apply &amp; Done/);
    assert.match(markup, /aria-label="Close vocal tuner"/);
  });

  it('renders both enabled and disabled badge states', () => {
    const on = render({ enabled: true });
    const off = render({ enabled: false });
    assert.match(on, /ENABLED \(NOT APPLIED\)/);
    assert.match(off, /DISABLED/);
    assert.match(on, /ON \(STORED\)/);
    assert.match(off, /OFF/);
  });

  it('carries no colour literal or white/black/palette utility in any class attribute', () => {
    const markups = [render({ enabled: true }), render({ enabled: false })];
    for (const markup of markups) {
      const offenders = classAttributes(markup).filter((cls) => UNTHEMED.test(cls));
      assert.deepEqual(offenders, [], 'class attributes must use semantic tokens only');
    }
  });

  it('expresses theme colour through CSS custom properties', () => {
    const classes = classAttributes(render()).join(' ');
    for (const token of [
      '--apex-surface',
      '--apex-surface-2',
      '--apex-surface-3',
      '--apex-chrome-inset',
      '--apex-panel-header',
      '--apex-canvas',
      '--apex-border',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-cyan',
      '--apex-cyan-strong',
      '--apex-cyan-text',
      '--apex-success',
      '--apex-accent',
      '--apex-aux',
      '--apex-aux-text',
      '--apex-gold',
      '--apex-state-playing-fg',
      '--apex-state-hover',
    ]) {
      assert.ok(classes.includes(`var(${token})`), `chrome uses ${token}`);
    }
  });

  it('uses the shared scrim: no hardcoded black overlay in the modal', () => {
    assert.doesNotMatch(source, /bg-black\/85/, 'no hardcoded black/85 scrim');
    assert.doesNotMatch(source, /bg-black\//, 'no hardcoded black scrim in the modal');
    // ModalFrame supplies apex-modal-overlay; the modal passes its own flex classes only.
    assert.match(source, /className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 select-none"/);
  });

  it('pairs the primary Apply & Done action with its on-colour label and strong hover', () => {
    assert.match(
      source,
      /bg-\[var\(--apex-cyan\)\] hover:bg-\[var\(--apex-cyan-strong\)\] text-\[var\(--apex-state-playing-fg\)\]/,
      'Apply & Done uses the cyan fill with the on-colour label and strong hover'
    );
  });

  it('uses the semantic signal-colour tokens for each parameter slider', () => {
    // Retune (cyan), Formant (success), Vibrato (accent), Humanize (aux).
    assert.match(source, /accent-\[var\(--apex-cyan\)\]/, 'retune slider uses cyan accent');
    assert.match(source, /text-\[var\(--apex-cyan-text\)\]/, 'retune readout uses cyan-text');
    assert.match(source, /accent-\[var\(--apex-success\)\]/, 'formant slider uses success accent');
    assert.match(source, /text-\[var\(--apex-success\)\]/, 'formant readout uses success');
    assert.match(source, /accent-\[var\(--apex-accent\)\]/, 'vibrato slider uses accent');
    assert.match(source, /text-\[var\(--apex-accent\)\]/, 'vibrato readout uses accent');
    assert.match(source, /accent-\[var\(--apex-aux\)\]/, 'humanize slider uses aux accent');
    assert.match(source, /text-\[var\(--apex-aux-text\)\]/, 'humanize readout uses aux-text');
  });

  it('uses the enabled-state success token (not hardcoded #00ff88) for the ON button and ENABLED badge', () => {
    assert.match(
      source,
      /\? 'bg-\[var\(--apex-success\)\] text-\[var\(--apex-state-playing-fg\)\] shadow-md'/,
      'the ON button uses success fill with the on-colour label'
    );
    assert.match(
      source,
      /bg-\[color-mix\(in_srgb,var\(--apex-success\)_20%,transparent\)\] text-\[var\(--apex-success\)\] border-\[color-mix\(in_srgb,var\(--apex-success\)_40%,transparent\)\]/,
      'the ENABLED badge uses a 20% success wash with a 40% success border'
    );
  });

  it('uses the gold token (not hardcoded #ffaa00) for the NOT APPLIED banners', () => {
    assert.match(source, /text-\[var\(--apex-gold\)\]/, 'banner labels use gold text');
    assert.match(
      source,
      /bg-\[color-mix\(in_srgb,var\(--apex-gold\)_20%,transparent\)\]/,
      'banner pills use a 20% gold wash'
    );
    assert.match(
      source,
      /border-\[color-mix\(in_srgb,var\(--apex-gold\)_40%,transparent\)\]/,
      'banner borders use a 40% gold wash'
    );
  });

  it('uses tokenised surfaces (not hardcoded dark greys) for cards, wells and select', () => {
    assert.match(source, /bg-\[var\(--apex-surface\)\]/, 'outer panel uses apex-surface');
    assert.match(source, /bg-\[var\(--apex-panel-header\)\]/, 'header/footer use apex-panel-header');
    assert.match(source, /bg-\[var\(--apex-surface-2\)\]/, 'section cards use apex-surface-2');
    assert.match(source, /bg-\[var\(--apex-chrome-inset\)\]/, 'warning bands use apex-chrome-inset');
    assert.match(source, /bg-\[var\(--apex-canvas\)\]/, 'pitch unavailable well uses apex-canvas');
  });

  it('contains no colour literal, white/black utility or palette utility in the component source', () => {
    // Gradient "from/to" values are var() references, so the only hex/rgba
    // occurrences are in comment text about Phases 52/79, not in class strings.
    assert.doesNotMatch(
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'),
      /#[0-9a-fA-F]{3,8}\b/,
      'hex literals are gone from code and markup'
    );
    assert.doesNotMatch(source, /rgba\(/, 'no literal rgba() paint strings');
    assert.doesNotMatch(source, /\b(?:text|bg|border)-(?:white|black)\b/, 'no white/black utilities');
    assert.doesNotMatch(source, /\b(?:text|bg|border)-(?:red|amber|green|gray|zinc|neutral)-\d/, 'no palette utilities');
  });

  it('keeps the Phase 52 truth copy and the NOT APPLIED banners intact', () => {
    const markup = render();
    assert.match(markup, /NO MEASURED PITCH/);
    assert.match(markup, /This build does not analyse audio/);
    assert.match(markup, /NOT APPLIED/);
    assert.match(markup, /PITCH DETECTION UNAVAILABLE/);
    // Preset names and label copy must survive.
    assert.match(markup, /Transparent Vocal Glue/);
    assert.match(markup, /Micro-variation preserve/);
    assert.match(markup, /LFO Pitch Modulation/);
  });

  it('renders nothing while closed', () => {
    const closed = renderToStaticMarkup(
      React.createElement(VocalTunerModal, {
        isOpen: false, onClose: noop, vocalTunerSettings: settings,
        onUpdateVocalTuner: noop, channels: DEFAULT_PROJECT.channels,
      })
    );
    assert.equal(closed, '', 'closed modal renders nothing');
  });
});
