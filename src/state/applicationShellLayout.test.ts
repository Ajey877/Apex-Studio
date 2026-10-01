import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Shell layout invariants.
 *
 * `src/uiAudit.css` and `src/index.css` position the transport with
 * position-implicit selectors such as
 * `#fl-transport-bar > div:first-child > div:nth-child(4)`.
 * Those rules only stay correct while the transport keeps its current parent and
 * child order, so the application menu is required to be a *sibling above*
 * `#fl-transport-bar`. These assertions fail loudly if that structure changes.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');

const appSource = () => read('src/App.tsx');
const uiAuditCss = () => read('src/uiAudit.css');
const indexCss = () => read('src/index.css');
const transportSource = () => read('src/components/TransportBar.tsx');
const menuSource = () => read('src/components/ApplicationMenuBar.tsx');

test('the application menu is rendered before the transport, as a sibling', () => {
  const app = appSource();
  const menuIndex = app.indexOf('<ApplicationMenuBar');
  const transportIndex = app.indexOf('<TransportBar\n');
  assert.ok(menuIndex >= 0, 'App must render the application menu bar');
  assert.ok(transportIndex >= 0, 'App must render the transport bar');
  assert.ok(menuIndex < transportIndex, 'the menu must sit above the transport');
});

test('nothing is inserted between the shell root and the transport that could re-scope the transport CSS', () => {
  const app = appSource();
  const rootIndex = app.indexOf('id="phantom-mobile-daw"');
  assert.ok(rootIndex >= 0);
  const transportIndex = app.indexOf('<TransportBar\n');
  const between = app.slice(rootIndex, transportIndex);
  for (const forbidden of ['<main', '<aside', '<section']) {
    assert.equal(
      between.includes(forbidden),
      false,
      `${forbidden} must not wrap the transport; it would change #fl-transport-bar's positional context`
    );
  }
  assert.ok(between.includes('<ApplicationMenuBar'), 'the menu must be the only element added above the transport');
});

/** Removes block and line comments so prose about the transport cannot be mistaken for code. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

test('App never reaches into the transport with the id the positional CSS depends on', () => {
  const appCode = stripComments(appSource());
  assert.equal(appCode.includes('fl-transport-bar'), false);
  assert.equal(appCode.includes('getElementById(\'fl-transport-bar\')'), false);
  assert.equal(stripComments(menuSource()).includes('fl-transport-bar'), false);
});

test('the transport keeps its existing structure and positional contract', () => {
  const transport = transportSource();
  assert.ok(transport.includes('id="fl-transport-bar"'));
  assert.ok(
    transport.includes('<div className="h-12 flex items-center justify-between px-2 sm:px-3 md:px-4 gap-2 md:gap-4 overflow-hidden">'),
    'the top nav row must keep its original className so the responsive overrides still match'
  );
  assert.ok(transport.includes('id="fl-view-tabs"'));
});

test('every transport control the shell audit documented is still rendered', () => {
  const transport = transportSource();
  for (const id of [
    'fl-playmode-toggle',
    'fl-play-btn',
    'fl-stop-btn',
    'fl-record-btn',
    'fl-metronome-btn',
    'fl-bpm-input',
    'fl-logo-btn',
    'project-name-btn',
    'fl-export-btn',
    'fl-hotkeys-btn',
    'fl-fullscreen-btn',
    'nav-channel-rack',
    'nav-piano-roll',
    'nav-playlist',
    'nav-mixer',
    'nav-instruments',
    'nav-sampler',
  ]) {
    assert.ok(transport.includes(`id="${id}"`), `transport control ${id} must still exist`);
  }
});

test('the transport component is left with a single implementation of fullscreen toggling', () => {
  const transport = transportSource();
  assert.ok(
    transport.includes('fullscreenController.toggle'),
    'the transport must delegate to the shared fullscreen controller'
  );
  assert.equal(
    transport.includes('document.documentElement.requestFullscreen'),
    false,
    'the transport must not keep a second requestFullscreen implementation'
  );
});

test('the positional CSS the shell depends on is untouched', () => {
  const audit = uiAuditCss();
  assert.ok(audit.includes('#fl-transport-bar > div:first-child > div:nth-child(4)'));
  assert.ok(audit.includes('#fl-logo-btn > span::after'));

  const css = indexCss();
  assert.ok(css.includes('#fl-transport-bar {'));
  assert.ok(css.includes('#fl-view-tabs {'));
  assert.ok(css.includes('#fl-playlist-arranger > .flex-1.flex.overflow-hidden > div:first-child'));
});

test('no stylesheet nests the menu inside the transport or the playlist', () => {
  for (const css of [indexCss(), uiAuditCss()]) {
    assert.equal(css.includes('#fl-transport-bar #application-menu-bar'), false);
    assert.equal(css.includes('#fl-playlist-arranger #application-menu-bar'), false);
    assert.equal(css.includes('#fl-transport-bar > #application-menu-bar'), false);
  }
});

test('the menu bar owns a slot above the transport and cannot be clipped by it', () => {
  const menu = menuSource();
  assert.ok(menu.includes('shrink-0'), 'the menu must not be squeezed by the workspace flex column');
  assert.ok(menu.includes('relative'), 'the menu must establish its own stacking context for its dropdown');
  assert.ok(menu.includes('z-50'), 'the dropdown must paint above the workspace');
});

test('the shell keeps rendering the workspace views the menu exposes', () => {
  const app = appSource();
  for (const view of ['channel_rack', 'piano_roll', 'playlist', 'mixer', 'instruments', 'sampler']) {
    assert.ok(app.includes(`currentView === '${view}'`), `workspace view ${view} must still be rendered`);
  }
});

test('the global keydown handler still drives note input from unmodified keys', () => {
  const app = appSource();
  assert.ok(app.includes('getKeyboardNotePitch'), 'note entry must still be routed through the audited helper');
  // Phase 50's offline-render guard pins this exact expression, so note codes must
  // keep being recognised through KEY_NOTE_MAP in the keydown handler.
  assert.ok(app.includes('KEY_NOTE_MAP[e.code]'), 'note entry must still be gated by the note map');
});

test('the global keydown handler reads the shared note map rather than a private copy', () => {
  const app = appSource();
  assert.ok(
    app.includes("from './state/musicalKeyboard'"),
    'App must import the note map instead of re-declaring it'
  );
  assert.equal(
    stripComments(app).includes("const KEY_NOTE_MAP: Record<string, number> = {"),
    false,
    'the inline note map must not come back, or the shortcut tests would stop covering real note entry'
  );
});
