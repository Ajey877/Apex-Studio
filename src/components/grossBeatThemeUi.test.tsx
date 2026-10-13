/**
 * UI-03J — Gross Beat theme contract.
 *
 * The modal is DOM-rendered (no canvas), so neutral UI chrome consumes the
 * active palette directly through existing `--apex-*` tokens. The gate's
 * orange identity remains on the shared gold token; playback, enabled and
 * brake states keep their existing semantic meanings.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GrossBeatModal } from './GrossBeatModal';
import type { GrossBeatState } from '../types/daw';

const source = readFileSync('src/components/GrossBeatModal.tsx', 'utf8');
const noop = (): void => {};

const defaultState: GrossBeatState = {
  enabled: false,
  mix: 1,
  gateSteps: Array(16).fill(true),
};

const render = (
  mode: 'dark' | 'light',
  grossBeatState: GrossBeatState = defaultState,
): string => renderToStaticMarkup(
  React.createElement(
    'div',
    { 'data-theme': mode },
    React.createElement(GrossBeatModal, {
      isOpen: true,
      onClose: noop,
      currentStep: 0,
      isPlaying: false,
      grossBeatState,
      onUpdateGrossBeat: noop,
    }),
  ),
);

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

const fixedPaletteClass =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to)-\[#|\b(?:text|bg|border)-(?:white|black)\b|bg-black(?:\/\d+)?\b|\b(?:text|bg|border)-(?:red|amber|green|gray|zinc|neutral)-\d/i;

describe('Gross Beat theme markup (UI-03J)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`renders the complete Gross Beat surface with semantic theme classes in ${mode}`, () => {
      const markup = render(mode);
      assert.match(markup, new RegExp(`data-theme="${mode}"`));
      assert.match(markup, /id="gross-beat-modal-title"/);
      assert.match(markup, /MASTER GATE/);
      assert.match(markup, /AMPLITUDE GATE/);
      assert.match(markup, /GATE DEPTH/);
      assert.match(markup, /MASTER BRAKE/);
      assert.match(markup, /GATE PATTERN PRESETS/);
      assert.match(markup, /16-STEP AMPLITUDE GATE GRID/);
      assert.match(markup, /Apply &amp; Close/);
      assert.match(markup, /aria-label="Close Gross Beat"/);
      for (const step of Array.from({ length: 16 }, (_, index) => index + 1)) {
        assert.ok(markup.includes(`>${step}<`), `expected gate step ${step}`);
      }
      for (const name of [
        'Half-Bar Chop', 'Long Hold', 'Alternating 16ths',
        'Pump Gap', 'Triplet Chop', 'Broken 16ths',
      ]) {
        assert.ok(markup.includes(name), `expected the ${name} preset`);
      }
    });
  }

  it('uses existing semantic tokens for surfaces, text, borders, interaction and shadow', () => {
    const markup = render('dark');
    const offenders = classAttributes(markup).filter((value) => fixedPaletteClass.test(value));
    assert.deepEqual(offenders, [], 'rendered classes must not carry fixed palette colours');

    for (const token of [
      '--apex-surface',
      '--apex-surface-2',
      '--apex-surface-3',
      '--apex-panel-header',
      '--apex-chrome-inset',
      '--apex-border',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-state-hover',
      '--apex-state-selected-border',
      '--apex-shadow',
    ]) {
      assert.ok(source.includes(`var(${token})`), `Gross Beat chrome consumes ${token}`);
    }
  });

  it('keeps the orange effect identity and the distinct playback, enabled, and brake meanings', () => {
    assert.match(source, /bg-\[var\(--apex-gold\)\]/, 'effect and open-step orange uses the shared gold token');
    assert.match(source, /text-\[var\(--apex-gold\)\]/, 'effect readouts retain the orange identity');
    assert.match(source, /var\(--apex-state-playing\)/, 'the playhead uses the playing-state token');
    assert.match(source, /var\(--apex-success\)/, 'the active effect keeps a distinct enabled-state color');
    assert.match(source, /var\(--apex-danger\)/, 'the triggered brake keeps its danger-state color');
    assert.match(source, /var\(--apex-state-playing-fg\)/, 'filled effect controls use a theme-safe on-colour');
    assert.match(source, /var\(--apex-state-recording-fg\)/, 'the active brake uses its theme-safe on-colour');
  });

  it('uses ModalFrame’s themed scrim and removes the redundant black overlay fill', () => {
    const markup = render('light');
    assert.match(
      markup,
      /class="apex-modal-overlay fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none"/,
    );
    assert.doesNotMatch(source, /bg-black\//);
  });

  it('preserves the bypass/active labels and all persisted gate values', () => {
    const bypass = render('dark');
    const enabledState: GrossBeatState = {
      enabled: true,
      mix: 0.5,
      gateSteps: Array.from({ length: 16 }, (_, index) => index < 8),
    };
    const active = render('light', enabledState);
    assert.match(bypass, />BYPASS</);
    assert.match(active, />EFFECT ACTIVE</);
    assert.match(active, /50%/);
    assert.match(source, /onUpdateGrossBeat\(patch\)/);
    assert.match(source, /publish\(\{ enabled: true, gateSteps: \[\.\.\.found\.steps\] \}\)/);
    assert.match(source, /publish\(\{ gateSteps: newSteps \}\)/);
    assert.match(source, /grossBeatState\.gateSteps\.map\(s => !s\)/);
    assert.match(source, /isPlaying && currentStep === idx/);
  });

  it('keeps the gate-depth and transient master-brake controls unchanged', () => {
    const markup = render('dark');
    assert.match(markup, /type="range"[^>]*min="0"[^>]*max="1"[^>]*step="0\.05"/);
    for (const duration of ['250', '500', '800', '1200', '1800']) {
      assert.match(markup, new RegExp(`value="${duration}"`), `expected the ${duration}ms brake choice`);
    }
    assert.match(source, /audioEngine\.triggerMasterBrake\(brakeDuration\)/);
    assert.match(source, /setBrakeDuration\(parseInt\(e\.target\.value\)\)/);
  });

  it('renders nothing while closed', () => {
    const closed = renderToStaticMarkup(
      React.createElement(GrossBeatModal, {
        isOpen: false,
        onClose: noop,
        currentStep: 0,
        isPlaying: false,
        grossBeatState: defaultState,
        onUpdateGrossBeat: noop,
      }),
    );
    assert.equal(closed, '');
  });
});
