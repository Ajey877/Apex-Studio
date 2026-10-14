/**
 * UI-03P — App error fallback theme migration.
 *
 * `AppErrorBoundary` is the last full-screen surface that was painted with raw
 * literals (`bg-black`, `text-white`, `border-white/10`, `bg-white/5`,
 * `bg-black/30`, a white primary button). When a child throws during the first
 * render, the fallback replaces the whole app — so on the Light palette the user
 * got a black screen with white text, and the reload button was white-on-white
 * against the panel. This is the only surface in the batch that can appear before
 * any panel mounts; it is migrated to the same tokens as everything else, which
 * matters because the theme is already decided on `<html data-theme>` by the
 * pre-paint bootstrap, so every token resolves even at that moment.
 *
 * The fallback is captured the way a class boundary can be tested without a DOM:
 * the instance's error state is set the same way `getDerivedStateFromError` sets
 * it, then `render()` is serialised. That also pins the two states a DOM test
 * cannot reach here — the message details block is conditional, and the reload
 * action keeps its `window.location.reload()` handler (asserted at source level,
 * because firing it in a unit test would reload the test runner page).
 *
 * Rendered-pixel proof is deliberately not claimed: the fallback cannot be
 * reached in a browser run without crashing the app under test, so the evidence
 * for this file is unit-level (this suite) plus the palette math below. That
 * limitation is recorded in `UI03P_*_THEME_REPORT.md`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppErrorBoundary } from './AppErrorBoundary';
import { DARK_TOKENS, LIGHT_TOKENS, hexToRgb } from './themeTestDocument';

const source = readFileSync('src/components/AppErrorBoundary.tsx', 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

/**
 * Serialises the fallback by putting a fresh instance into the state
 * `getDerivedStateFromError` produces. `children` is never reached in this state.
 */
const renderFallback = (errorMessage: string | null): string => {
  const boundary = new AppErrorBoundary({ children: null });
  boundary.state = { hasError: true, errorMessage };
  return renderToStaticMarkup(boundary.render() as React.ReactElement);
};

interface BoundaryInternals {
  state: { hasError: boolean; errorMessage: string | null };
  render: () => React.ReactNode;
}

const asInternals = (boundary: AppErrorBoundary): BoundaryInternals =>
  boundary as unknown as BoundaryInternals;

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

const COLOUR_TOKEN =
  /#[0-9a-f]{3,8}\b|\[#|(?:text|bg|border|divide|ring|from|to|placeholder|accent|fill|stroke)-(?:white|black)\b|rgba?\(|(?:text|bg|border|divide|ring|fill|stroke|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]/i;

const luminance = ([r, g, b]: [number, number, number]): number => {
  const channel = (input: number): number => {
    const v = input / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (foreground: string, background: string): number => {
  const first = luminance(hexToRgb(foreground));
  const second = luminance(hexToRgb(background));
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

describe('App error fallback theme migration (UI-03P)', () => {
  it('renders an unthemed child untouched while no error has been caught', () => {
    const boundary = new AppErrorBoundary({ children: React.createElement('span', null, 'OK') });
    assert.equal(renderToStaticMarkup(boundary.render() as React.ReactElement), '<span>OK</span>');
    assert.equal(asInternals(boundary).state.hasError, false);
  });

  it('renders the full fallback, with the technical-details block only when there is a message', () => {
    const markup = renderFallback('Error: boom');
    assert.match(markup, /Apex Studio could not load this view\./);
    assert.match(markup, /The application hit an unexpected error\. Reload Apex Studio to try again\./);
    assert.match(markup, /Technical details/);
    assert.match(markup, /Error: boom/);
    assert.match(markup, /Reload Apex Studio/);
    assert.equal(renderFallback(null).includes('Technical details'), false);
  });

  it('carries no colour literal: every surface resolves through the palette', () => {
    const offenders = classAttributes(renderFallback('Error: boom')).flatMap((value) =>
      value.split(/\s+/).filter((token) => COLOUR_TOKEN.test(token))
    );
    assert.deepEqual(offenders, []);
    assert.equal(/bg-black|text-white|bg-white|border-white|from-black|to-black/.test(code), false);
    for (const token of [
      'bg-[var(--apex-bg)]',
      'text-[var(--apex-text)]',
      'border-[var(--apex-border)]',
      'bg-[var(--apex-surface)]',
      'text-[var(--apex-text-3)]',
      'text-[var(--apex-text-2)]',
      'bg-[var(--apex-canvas)]',
      'bg-[var(--apex-accent)]',
      'text-[var(--apex-state-playing-fg)]',
      'hover:bg-[var(--apex-accent-strong)]'
    ]) {
      assert.ok(code.includes(token), `expected the fallback to use ${token}`);
    }
  });

  it('keeps the boundary contract: derived state, console report and reload action', () => {
    assert.match(code, /static getDerivedStateFromError\(error: unknown\): AppErrorBoundaryState/);
    assert.match(code, /errorMessage: error instanceof Error \? error\.message : null/);
    assert.match(code, /componentDidCatch\(error: unknown, info: ErrorInfo\)/);
    assert.match(code, /console\.error\('\[Apex Studio\] Unhandled application render error\.', error, info\.componentStack\)/);
    assert.match(code, /private readonly children: ReactNode;/);
    assert.match(code, /private handleReload = \(\) => \{\s*window\.location\.reload\(\);\s*\};/);
    assert.match(code, /type="button"/);
    assert.match(code, /onClick=\{this\.handleReload\}/);
  });

  it('every fallback pairing clears AA in both palettes, and the literals it replaced are pinned', () => {
    for (const [mode, tokens] of [['dark', DARK_TOKENS], ['light', LIGHT_TOKENS]] as const) {
      const page = tokens['--apex-bg'];
      const panel = tokens['--apex-surface'];
      const inset = tokens['--apex-canvas'];
      const step = (label: string, fg: string, bg: string, floor = 4.5): void => {
        const measured = contrastRatio(fg, bg);
        assert.ok(measured >= floor, `${mode}: ${label} = ${measured.toFixed(2)}:1 (floor ${floor})`);
      };
      step('heading + body on the page background', tokens['--apex-text'], page);
      step('eyebrow on the panel', tokens['--apex-text-3'], panel);
      step('description on the panel', tokens['--apex-text-2'], panel);
      step('technical details on the inset', tokens['--apex-text-3'], inset);
      step('reload label on the accent fill', tokens['--apex-state-playing-fg'], tokens['--apex-accent']);
      step('reload label on the accent hover fill', tokens['--apex-state-playing-fg'], tokens['--apex-accent-strong']);
    }

    // The literal the old fallback used is the defect: white text is not legible
    // on the Light page, and a white button is invisible on a white panel.
    assert.ok(contrastRatio('#ffffff', LIGHT_TOKENS['--apex-bg']) < 1.2, 'white text on the light page');
    assert.ok(contrastRatio('#ffffff', LIGHT_TOKENS['--apex-surface']) < 1.2, 'the white reload button on the light panel');
    // And the adopted tokens are the reason it now passes.
    assert.ok(contrastRatio(LIGHT_TOKENS['--apex-text'], LIGHT_TOKENS['--apex-bg']) >= 4.5);
    assert.ok(contrastRatio(DARK_TOKENS['--apex-text'], DARK_TOKENS['--apex-bg']) >= 4.5);
  });
});
