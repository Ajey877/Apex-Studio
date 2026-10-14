/**
 * UI-03Q — Project Settings residual scrim + warning-token migration.
 * The overlay carried a dead `bg-black/60`; the unsupported-meter alert used
 * `var(--apex-warning,#d97706)` — `--apex-warning` is defined nowhere, so the
 * border was a fixed amber in both themes. It now uses the existing
 * `--apex-gold` caution token (no new token added).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectSettingsModal } from './ProjectSettingsModal';
import { DARK_TOKENS, LIGHT_TOKENS, hexToRgb } from './themeTestDocument';

const noop = (): void => {};
const render = (timeSignature: unknown = [4, 4]): string =>
  renderToStaticMarkup(
    React.createElement(ProjectSettingsModal, {
      isOpen: true, timeSignature, sevenEightGrouping: undefined, countInBars: undefined,
      onSelectTimeSignature: noop, onSelectSevenEightGrouping: noop,
      onSelectCountInBars: noop, onClose: noop,
    })
  );
const source = readFileSync('src/components/ProjectSettingsModal.tsx', 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
const css = readFileSync('src/index.css', 'utf8');
const luminance = ([r, g, b]: [number, number, number]): number => {
  const ch = (v: number): number => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const contrast = (a: string, b: string): number => {
  const x = luminance(hexToRgb(a)); const y = luminance(hexToRgb(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe('Project Settings modal residual theme migration (UI-03Q)', () => {
  it('renders the settings contract', () => {
    const markup = render();
    assert.match(markup, /id="project-settings-modal"/);
    assert.match(markup, /id="project-settings-modal-title"/);
    assert.match(markup, /Project Settings/);
    assert.match(markup, /aria-label="Close Project Settings"/);
    assert.match(markup, /id="project-settings-active-meter"/);
  });
  it('the scrim is the shared themed primitive with no literal fill', () => {
    const markup = render();
    const root = markup.slice(0, markup.indexOf('>') + 1);
    assert.ok(root.includes('apex-modal-overlay'));
    assert.ok(!root.includes('bg-black'));
    assert.equal(/bg-black/.test(code), false);
  });
  it('the unsupported-meter alert uses the existing gold token, not an undefined token with a hex fallback', () => {
    assert.equal(css.includes('--apex-warning:'), false, 'precondition: --apex-warning is defined nowhere');
    assert.equal(code.includes('--apex-warning'), false);
    assert.equal(code.includes('#d97706'), false);
    const markup = render([13, 8]);
    assert.match(markup, /role="alert"/);
    assert.match(markup, /border-\[var\(--apex-gold\)\]/);
    assert.match(markup, /unsupported time signature/);
  });
  it('warning border and text clear their floors in both themes', () => {
    for (const tokens of [DARK_TOKENS, LIGHT_TOKENS]) {
      // Graphical indicator floor (SC 1.4.11) for the alert border.
      assert.ok(contrast(tokens['--apex-gold'], tokens['--apex-surface']) >= 3,
        `gold on surface: ${contrast(tokens['--apex-gold'], tokens['--apex-surface']).toFixed(2)}`);
      assert.ok(contrast(tokens['--apex-text'], tokens['--apex-surface']) >= 4.5);
      assert.ok(contrast(tokens['--apex-text-2'], tokens['--apex-surface']) >= 4.5);
    }
    // The rejected fixed amber fails the graphical floor in Light.
    assert.ok(contrast('#d97706', LIGHT_TOKENS['--apex-surface']) < 3.2);
  });
});
