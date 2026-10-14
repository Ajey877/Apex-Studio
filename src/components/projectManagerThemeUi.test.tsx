/**
 * UI-03Q — Project Manager (Studio Project Hub) residual scrim migration.
 * See exportThemeUi.test.tsx for the batch rationale.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProjectManagerModal } from './ProjectManagerModal';
import { DEFAULT_PROJECT } from '../audio/presets';
import { DARK_TOKENS, LIGHT_TOKENS, hexToRgb } from './themeTestDocument';

const noop = (): void => {};
const render = (isOpen = true): string =>
  renderToStaticMarkup(
    React.createElement(ProjectManagerModal, {
      isOpen, onClose: noop, currentState: DEFAULT_PROJECT,
      onLoadProject: noop, onUpdateMeta: noop, onRequestManifestImport: noop,
    })
  );
const source = readFileSync('src/components/ProjectManagerModal.tsx', 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');
const luminance = ([r, g, b]: [number, number, number]): number => {
  const ch = (v: number): number => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const contrast = (a: string, b: string): number => {
  const x = luminance(hexToRgb(a)); const y = luminance(hexToRgb(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe('Project Manager modal residual theme migration (UI-03Q)', () => {
  it('renders the hub contract and returns nothing when closed', () => {
    const markup = render();
    assert.match(markup, /id="project-manager-modal"/);
    assert.match(markup, /STUDIO PROJECT HUB &amp; DEMO TEMPLATES|STUDIO PROJECT HUB/);
    assert.match(markup, /aria-label="Close project manager"/);
    assert.equal(render(false), '');
  });
  it('the scrim is the shared themed primitive with no literal fill', () => {
    const markup = render();
    const root = markup.slice(0, markup.indexOf('>') + 1);
    assert.ok(root.includes('apex-modal-overlay'));
    assert.ok(!root.includes('bg-black'));
    assert.equal(/bg-black|text-white|bg-white/.test(code), false);
  });
  it('keeps the hub behaviour seams (new session, manifest import, demos)', () => {
    assert.match(code, /handleCreateBlankProject/);
    assert.match(code, /onRequestManifestImport/);
    assert.match(code, /PRESET_PROJECTS/);
    assert.match(code, /listProjectBackups/);
  });
  it('title and body text clear AA on the panel in both themes', () => {
    for (const tokens of [DARK_TOKENS, LIGHT_TOKENS]) {
      assert.ok(contrast(tokens['--apex-text'], tokens['--apex-surface']) >= 4.5);
      assert.ok(contrast(tokens['--apex-text-2'], tokens['--apex-surface']) >= 4.5);
    }
  });
});
