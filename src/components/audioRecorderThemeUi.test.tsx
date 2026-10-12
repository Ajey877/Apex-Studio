/**
 * UI-03F — Audio Recorder theme, asserted against the markup the real component
 * produces (`renderToStaticMarkup`, as in the UI-03B/C/D/E suites) and against
 * the component source where a branch is only reachable after interaction.
 *
 * 1. The dialog renders in full in each punch state.
 * 2. Class attributes carry no colour literal and no `text-white` / `text-black`
 *    / `bg-black` / Tailwind palette utility, so chrome follows the theme.
 * 3. The theme is expressed by CSS custom properties, not by the markup.
 * 4. The overlay is the shared scrim, supplied by ModalFrame.
 * 5. The canvas paints from the palette seam on every frame, so a theme flip is
 *    picked up without an observer, and the animation loop is still cancelled.
 * 6. Each on-colour pair (label on fill) uses the matching semantic pair.
 *
 * Contrast of the live text and the repaint on a real theme flip are proven in
 * browser-tests/audioRecorderTheme.spec.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AudioRecorderModal } from './AudioRecorderModal';

const noop = (): void => {};

const baseProps = {
  isOpen: true,
  projectGeneration: 1,
  getCurrentProjectGeneration: () => 1,
  countInBars: 0,
  onUpdateCountInBars: noop,
  onClose: noop,
  onRegisterProjectReplacementHandler: noop,
  onSaveRecording: noop,
} as const;

const PUNCH = { enabled: true, inBar: 5, inBeat: 1, outBar: 9, outBeat: 1 };

const render = (overrides: Partial<React.ComponentProps<typeof AudioRecorderModal>> = {}) =>
  renderToStaticMarkup(React.createElement(AudioRecorderModal, { ...baseProps, ...overrides }));

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);

const source = readFileSync('src/components/AudioRecorderModal.tsx', 'utf8');

/** A colour literal, a white/black/alpha-black utility, or a Tailwind palette colour. */
const UNTHEMED =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|from|to|accent|ring|fill)-\[#|\b(?:text|bg|border)-(?:white|black)\b|bg-black|rgba?\(|\b(?:text|bg|border)-(?:red|amber|green|gray|zinc|neutral)-\d/i;

describe('Audio Recorder theme markup (UI-03F)', () => {
  it('renders the full dialog with punch unavailable (ordinary recording)', () => {
    const markup = render();
    assert.match(markup, /id="audio-recorder-modal-title"/);
    assert.match(markup, /AUDIO RECORDER/);
    assert.match(markup, /START RECORDING/);
    assert.match(markup, /Count-in/);
    assert.match(markup, /aria-label="Close audio recorder"/);
    assert.match(markup, /aria-label="Recording count-in length"/);
  });

  it('renders the punch section, punch-on and punch-off, with its controls', () => {
    const on = render({ punchRecording: PUNCH, onUpdatePunchRecording: noop });
    assert.match(on, /data-testid="audio-recorder-punch"/);
    assert.match(on, /PUNCH RECORD/);
    assert.match(on, /aria-label="Punch-in bar"/);
    assert.match(on, /data-punch-range-preview/);
    const off = render({ punchRecording: { ...PUNCH, enabled: false }, onUpdatePunchRecording: noop });
    assert.match(off, /aria-checked="false"/);
    assert.match(off, /Off — recording runs until you press Stop, exactly as before\./);
  });

  it('carries no colour literal or white/black/palette utility in any class attribute', () => {
    const markups = [
      render(),
      render({ punchRecording: PUNCH, onUpdatePunchRecording: noop }),
      render({ punchRecording: { ...PUNCH, enabled: false }, onUpdatePunchRecording: noop }),
    ];
    for (const markup of markups) {
      const offenders = classAttributes(markup).filter((cls) => UNTHEMED.test(cls));
      assert.deepEqual(offenders, [], 'class attributes must use semantic tokens only');
    }
  });

  it('expresses theme colour through CSS custom properties', () => {
    const classes = classAttributes(render({ punchRecording: PUNCH, onUpdatePunchRecording: noop })).join(' ');
    for (const token of [
      '--apex-surface',
      '--apex-surface-3',
      '--apex-bg',
      '--apex-canvas',
      '--apex-border',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-accent',
      '--apex-accent-strong',
      '--apex-state-playing-fg',
      '--apex-state-selected',
      '--apex-state-selected-border',
    ]) {
      assert.ok(classes.includes(`var(${token})`), `chrome uses ${token}`);
    }
  });

  it('gives the primary action its on-accent label, not black', () => {
    const markup = render();
    const start = /<button[^>]*>(?:(?!<\/button>).)*START RECORDING/s.exec(markup)?.[0] ?? '';
    assert.ok(start.includes('bg-[var(--apex-accent)]'), 'Start uses the accent fill');
    assert.ok(start.includes('text-[var(--apex-state-playing-fg)]'), 'Start label uses the on-accent token');
    assert.ok(start.includes('hover:bg-[var(--apex-accent-strong)]'), 'Start hover uses the strong accent');
  });

  it('uses the shared scrim: the overlay class is supplied by ModalFrame, not by the modal', () => {
    const markup = render();
    assert.match(markup, /class="apex-modal-overlay fixed inset-0 backdrop-blur-sm z-50/);
    assert.doesNotMatch(source, /bg-black\//, 'no hardcoded black scrim in the modal');
  });

  it('paints the canvas from the palette seam on every frame, and still cancels the loop', () => {
    assert.match(source, /import \{ readRecorderPalette \} from '\.\/audioRecorderTheme'/);
    assert.match(source, /const palette = readRecorderPalette\(\)/, 'the palette is read in the frame callback');
    assert.match(source, /context\.fillStyle = palette\.canvasBackground/, 'background comes from the seam');
    assert.match(source, /context\.strokeStyle = palette\.signal\.wave/, 'waveform comes from the seam');
    assert.match(source, /return \(\) => cancelAnimationFrame\(animationId\)/, 'the animation loop is cancelled on cleanup');
    assert.doesNotMatch(source, /new MutationObserver/, 'no observer is attached: the per-frame read already follows the theme');
  });

  it('pairs each on-colour label with its fill using the semantic pair', () => {
    assert.match(
      source,
      /bg-\[var\(--apex-state-recording\)\] hover:opacity-80 text-\[var\(--apex-state-recording-fg\)\]/,
      'STOP & SAVE uses the recording fill with its on-colour label'
    );
    assert.match(
      source,
      /\?\s*'bg-\[var\(--apex-accent\)\] text-\[var\(--apex-state-playing-fg\)\] border-\[var\(--apex-accent\)\]'/,
      'active count-in chip uses the on-accent label'
    );
    assert.match(
      source,
      /text-\[color-mix\(in_srgb,var\(--apex-danger\)_70%,var\(--apex-text\)\)\]" data-punch-issue/,
      'validation issues use danger mixed toward the primary text (AA in both themes)'
    );
    assert.match(
      source,
      /rounded-lg text-xs text-\[color-mix\(in_srgb,var\(--apex-danger\)_70%,var\(--apex-text\)\)\]"/,
      'the error box uses the same danger text mix'
    );
    assert.match(
      source,
      /bg-\[var\(--apex-surface-2\)\] hover:bg-\[var\(--apex-surface-3\)\] text-\[var\(--apex-text\)\]/,
      'Cancel and Pause use the secondary surface with the primary text'
    );
  });

  it('contains no colour literal, white/black utility or palette utility in the component source', () => {
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, 'hex literals belong in audioRecorderTheme.ts');
    assert.doesNotMatch(source, /rgba\(/, 'no literal rgba() paint strings');
    assert.doesNotMatch(source, /\b(?:text|bg|border)-(?:white|black)\b/, 'no white/black utilities');
    assert.doesNotMatch(source, /\b(?:text|bg|border)-(?:red|amber|green|gray|zinc|neutral)-\d/, 'no palette utilities');
  });

  it('keeps the Phase 1L and 1K truth copy unchanged', () => {
    const markup = render({ punchRecording: PUNCH, onUpdatePunchRecording: noop });
    assert.match(markup, /Pre-roll: off — capture starts immediately at punch-in\./);
    assert.match(source, /Off — recording runs until you press Stop, exactly as before\./);
    assert.match(source, /The take stops at the end of the arrangement\./);
  });
});
