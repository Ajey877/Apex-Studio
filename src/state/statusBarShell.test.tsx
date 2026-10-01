import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  StatusBar,
  activeWorkspaceViewLabel,
  type StatusBarProps,
} from '../components/StatusBar';
import { WORKSPACE_TABS } from '../components/TransportBar';

/**
 * UI Milestone 1C — Step 3: status bar shell contract.
 *
 * The status bar is informational chrome. These tests pin the parts of the
 * redesign that users depend on:
 *   - zero buttons — nothing in the footer is actionable, and none of the
 *     actions the old footer duplicated (Hotkeys, Export) come back,
 *   - no fabricated telemetry (the old "DSP CPU" readout) and no fake
 *     "STORAGE: LOCAL" chip,
 *   - the project name is the real meta.name,
 *   - save state comes from the existing saveError string,
 *   - the active view name comes from the existing workspace tab model,
 *   - the counts are the real project-state numbers App passes down.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const statusBarSource = () => read('src/components/StatusBar.tsx');
const indexCss = () => read('src/index.css');
const appSource = () => read('src/App.tsx');

const baseProps: StatusBarProps = {
  meta: {
    id: 'proj-shell',
    name: 'Shell Fixture',
    author: 'Test',
    bpm: 128,
    timeSignature: [4, 4],
    swing: 0,
    masterVolume: 1,
    masterPitch: 0,
    created: 0,
    updated: 0,
    version: 'test',
    offlineReady: true,
    totalEditTimeSeconds: 0,
  },
  currentView: 'channel_rack',
  saveError: null,
  channelCount: 4,
  clipCount: 0,
};

const renderStatusBar = (overrides: Partial<StatusBarProps> = {}): string =>
  renderToStaticMarkup(React.createElement(StatusBar, { ...baseProps, ...overrides }));

const VALUE_TAG = '<span class="apex-status-value">';

const valueAfter = (html: string, label: string): string => {
  const index = html.indexOf(`<span class="apex-status-label">${label}</span>`);
  assert.ok(index > 0, `the ${label} item must render`);
  const valueStart = html.indexOf(VALUE_TAG, index) + VALUE_TAG.length;
  const valueEnd = html.indexOf('</span>', valueStart);
  return html.slice(valueStart, valueEnd);
};

// ---------------------------------------------------------------------------
// 1. Informational only
// ---------------------------------------------------------------------------

test('the status bar renders zero buttons, inputs or other controls', () => {
  const html = renderStatusBar();
  assert.ok(html.startsWith('<footer id="studio-status-bar"'));
  assert.equal((html.match(/<button/g) ?? []).length, 0, 'the footer has nothing to press');
  assert.equal(html.includes('<input'), false);
  assert.equal(html.includes('<select'), false);
  assert.equal(html.includes('<a '), false);
  assert.equal(html.includes('role="button"'), false);
});

test('the status bar keeps the shipped footer geometry', () => {
  const html = renderStatusBar();
  assert.ok(
    html.includes('class="apex-statusbar h-6 shrink-0 select-none"'),
    'the 24px non-growing footer band'
  );
});

// ---------------------------------------------------------------------------
// 2. Truthfulness: no fabrication, no duplicate actions
// ---------------------------------------------------------------------------

test('the status bar ships no fabricated telemetry or fake storage state', () => {
  const html = renderStatusBar();
  for (const fabricated of ['DSP', 'CPU', 'STORAGE', 'LOCAL', 'FPS', 'LATENCY']) {
    assert.equal(html.includes(fabricated), false, `no fabricated ${fabricated} readout`);
  }
});

test('the status bar duplicates no transport or application-menu action', () => {
  const html = renderStatusBar().toLowerCase();
  for (const duplicated of ['hotkeys', 'export', 'render']) {
    assert.equal(html.includes(duplicated), false, `the ${duplicated} action belongs to the transport/menu`);
  }
  // "Save" appears exactly once, as the save-state label — information, not an action.
  assert.equal(
    (html.match(/<span class="apex-status-label">save<\/span>/g) ?? []).length,
    1,
    'Save appears once, as the status label'
  );
});

// ---------------------------------------------------------------------------
// 3. Real data in
// ---------------------------------------------------------------------------

test('the project name is the real meta.name', () => {
  assert.ok(renderStatusBar().includes('Shell Fixture'));
  const renamed = renderStatusBar({
    meta: { ...baseProps.meta, name: 'Late Night Session v2' },
  });
  assert.ok(renamed.includes('Late Night Session v2'));
  assert.equal(renamed.includes('Shell Fixture'), false);
  // The full name is also available as a title for truncated displays.
  assert.ok(renamed.includes('title="Late Night Session v2"'));
});

test('save state comes from the existing saveError string', () => {
  const saved = renderStatusBar();
  assert.ok(saved.includes('<span class="apex-status-value">Saved</span>'));
  assert.ok(saved.includes('data-state="ok"'));

  const failed = renderStatusBar({ saveError: 'QuotaExceededError: storage full' });
  assert.ok(failed.includes('<span class="apex-status-value">Save failed</span>'));
  assert.ok(failed.includes('data-state="error"'));
  assert.ok(failed.includes('title="QuotaExceededError: storage full"'), 'the real message stays reachable');

  // A successful save clears the error, and the bar says so.
  assert.ok(renderStatusBar({ saveError: null }).includes('>Saved</span>'));
});

test('the active view comes from the existing workspace tab model', () => {
  for (const tab of WORKSPACE_TABS) {
    const html = renderStatusBar({ currentView: tab.view });
    const value = valueAfter(html, 'View');
    assert.equal(value, tab.label, `${tab.view} must read as ${tab.label}`);
  }
});

test('activeWorkspaceViewLabel is the single mapping for all six views', () => {
  for (const tab of WORKSPACE_TABS) {
    assert.equal(activeWorkspaceViewLabel(tab.view), tab.label);
  }
});

test('the counts are the real project-state numbers App passes down', () => {
  const html = renderStatusBar({ channelCount: 7, clipCount: 12 });
  assert.equal(valueAfter(html, 'Channels'), '7');
  assert.equal(valueAfter(html, 'Clips'), '12');

  const empty = renderStatusBar({ channelCount: 1, clipCount: 0 });
  assert.equal(valueAfter(empty, 'Channels'), '1');
  assert.equal(valueAfter(empty, 'Clips'), '0');
});

// ---------------------------------------------------------------------------
// 4. Theming and wiring contracts
// ---------------------------------------------------------------------------

test('the status bar is themed by the chrome status token, not a legacy utility', () => {
  const css = indexCss();
  const blockStart = css.indexOf('.apex-statusbar {');
  assert.ok(blockStart > 0);
  const block = css.slice(blockStart, css.indexOf('}', blockStart));
  assert.ok(block.includes('background: var(--apex-chrome-status)'));
  assert.ok(css.includes('--apex-chrome-status:'), 'the token itself must stay defined');
});

test('the status bar derives view names from the tab model instead of copying the view list', () => {
  const source = stripComments(statusBarSource());
  assert.ok(source.includes("from './TransportBar'"), 'WORKSPACE_TABS is imported, not re-declared');
  for (const view of ['channel_rack', 'piano_roll', 'playlist', 'mixer', 'instruments', 'sampler']) {
    assert.equal(source.includes(`'${view}'`), false, `the view list must not be re-copied (${view})`);
  }
});

test('App wires the status bar to real project state and the existing saveError', () => {
  const app = appSource();
  assert.ok(app.includes('<StatusBar'));
  assert.ok(app.includes('meta={projectState.meta}'));
  assert.ok(app.includes('currentView={currentView}'));
  assert.ok(app.includes('saveError={saveError}'), 'save state is the existing saveError');
  assert.ok(app.includes('channelCount={projectState.channels.length}'), 'channel count is real state');
  assert.ok(app.includes('clipCount={projectState.playlistClips.length}'), 'clip count is real state');
});
