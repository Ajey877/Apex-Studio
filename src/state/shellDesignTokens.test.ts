import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * UI Milestone 1C — shell design-system guard.
 *
 * The transport and the view ribbon must consume shell tokens instead of the
 * legacy black/orange utility palette. These assertions exist so a later change
 * cannot quietly re-scatter hex values through the shell: the palette layer in
 * `index.css` exists for the parts of the app that have not been converted yet,
 * and the shell is no longer one of them.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const indexCss = () => read('src/index.css');
const uiAuditCss = () => read('src/uiAudit.css');
const transportSource = () => read('src/components/TransportBar.tsx');
const toolsMenuSource = () => read('src/components/TransportToolsMenu.tsx');

const SHELL_TOKENS = [
  // chrome surfaces
  '--apex-chrome-menu',
  '--apex-chrome-transport',
  '--apex-chrome-ribbon',
  '--apex-chrome-status',
  // panel surfaces
  '--apex-panel',
  '--apex-panel-header',
  '--apex-canvas',
  // control heights
  '--apex-control-sm',
  '--apex-control-md',
  '--apex-control-lg',
  // interaction states
  '--apex-state-hover',
  '--apex-state-pressed',
  '--apex-state-selected',
  '--apex-state-disabled',
  '--apex-state-focus',
  '--apex-state-playing',
  '--apex-state-recording',
  // type scale
  '--apex-type-micro',
  '--apex-type-label',
  '--apex-type-body',
  '--apex-type-emphasis',
  // compact control radius
  '--apex-radius-control',
];

const SHELL_PRIMITIVES = [
  '.apex-transport',
  '.apex-ribbon',
  '.apex-icon-btn',
  '.apex-tool-chip',
  '.apex-primary-action',
  '.apex-tool-cluster',
  '.apex-readout',
  '.apex-readout-label',
  '.apex-readout-value',
  '.apex-tab',
  '.apex-mode-switch',
  '.apex-tool-menu',
  '.apex-tool-menu-item',
];

test('index.css defines the shell token set the transport consumes', () => {
  const css = indexCss();
  for (const token of SHELL_TOKENS) {
    assert.ok(css.includes(`${token}:`), `${token} must be defined in index.css`);
  }
});

test('the shell tokens keep the Midnight Aurora palette as their base', () => {
  const css = indexCss();
  // Restrained violet accent, cyan secondary, danger only for record/error.
  assert.ok(css.includes('--apex-state-playing: var(--apex-accent)'));
  assert.ok(css.includes('--apex-state-recording: var(--apex-danger)'));
  assert.equal(/--apex-state-selected:[^;]*#ff6e00/.test(css), false, 'no legacy orange in the shell states');
});

test('index.css defines the shell primitives the transport consumes', () => {
  const css = indexCss();
  for (const primitive of SHELL_PRIMITIVES) {
    assert.ok(css.includes(primitive), `${primitive} must be defined in index.css`);
  }
});

test('the transport surface is themed through the chrome token, not a literal', () => {
  const css = indexCss();
  assert.ok(css.includes('#fl-transport-bar {'), 'the pinned selector must stay');
  assert.ok(css.includes('background: var(--apex-chrome-transport)'));
  assert.ok(css.includes('#fl-view-tabs {'), 'the pinned selector must stay');
  assert.ok(css.includes('background: var(--apex-chrome-ribbon)'));
});

test('the transport carries no legacy palette utilities any more', () => {
  for (const [name, source] of [
    ['TransportBar.tsx', transportSource()],
    ['TransportToolsMenu.tsx', toolsMenuSource()],
  ] as const) {
    const legacyColours = [...source.matchAll(/\b(?:bg|text|border|ring|from|to)-\[#[0-9a-fA-F]{3,8}(?:\/[0-9.]+)?\]/g)].map(
      match => match[0]
    );
    assert.deepEqual(legacyColours, [], `${name} still uses legacy palette utilities`);
  }
});

test('the shell typography scale is a four-step ladder, not arbitrary pixels', () => {
  for (const [name, source] of [
    ['TransportBar.tsx', transportSource()],
    ['TransportToolsMenu.tsx', toolsMenuSource()],
  ] as const) {
    const arbitrarySizes = [...source.matchAll(/text-\[\d+(?:\.\d+)?(?:px|rem)\]|text-\[#/g)].map(m => m[0]);
    assert.deepEqual(arbitrarySizes, [], `${name} must use the shell type tokens`);
    assert.equal(/\bfont-bold\b/.test(source), false, `${name} must use the two weight policy`);
  }
  const css = indexCss();
  for (const token of ['--apex-type-micro: 10px', '--apex-type-label: 11px', '--apex-type-body: 12px', '--apex-type-emphasis: 13px']) {
    assert.ok(css.includes(token), `${token} must be the shell scale`);
  }
});

test('the view ribbon keeps a single selected-state vocabulary', () => {
  const css = indexCss();
  assert.ok(css.includes('[aria-current="page"]'), 'the ribbon selects through aria-current');
  assert.ok(/\.apex-tab\[aria-current="page"\]/.test(css), 'the tab primitive owns the selected treatment');
  assert.ok(css.includes('--apex-state-selected'), 'selected state must come from a token');
});

test('the shell controls own their height instead of fighting the global rule', () => {
  const css = indexCss();
  assert.ok(css.includes('button { min-height: 30px; }'), 'the workspace rule stays for the rest of the app');
  assert.ok(/\.apex-icon-btn[\s\S]*min-height: 0/.test(css), 'shell primitives opt out explicitly');
});

test('the positional audit file no longer caps the tool cluster with viewport widths', () => {
  const audit = uiAuditCss();
  assert.ok(
    audit.includes('#fl-transport-bar > div:first-child > div:nth-child(4)'),
    'the selector the shell layout test pins must stay'
  );
  assert.ok(audit.includes('#fl-logo-btn > span::after'), 'the pinned brand selector must stay');
  assert.equal(
    /max-width:\s*3[04]vw/.test(stripComments(audit)),
    false,
    'the clipping cap is the defect being fixed'
  );
});

test('the brand no longer presents itself as a pro-tier product', () => {
  assert.equal(transportSource().includes('APEX STUDIO PRO'), false);
  assert.ok(uiAuditCss().includes("content: 'APEX STUDIO'"), 'the wordmark is still CSS-owned');
});

test('the transport still renders shell chrome only and keeps its existing runtime imports', () => {
  const source = transportSource();
  // Persistence and project state stay out of the header entirely.
  assert.equal(source.includes("from '../state/projectPersistence'"), false);
  assert.equal(source.includes("from '../state/projectState'"), false);
  // The MIDI activity listener and the shared fullscreen controller are existing
  // behaviour and must survive the redesign.
  assert.ok(source.includes("from '../audio/audioEngine'"), 'the MIDI activity listener stays');
  assert.ok(source.includes('fullscreenController.toggle'), 'fullscreen stays delegated');
});
