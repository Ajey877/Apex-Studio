import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  StudioBrowser,
  STUDIO_BROWSER_FOLDERS,
  STUDIO_BROWSER_INSTRUMENTS,
  STUDIO_BROWSER_DRUM_SAMPLES,
  filterStudioBrowserRows,
  type StudioBrowserProps,
} from '../components/StudioBrowser';
import { StatusBar } from '../components/StatusBar';
import { ApplicationMenuBarView } from '../components/ApplicationMenuBar';
import { TransportBar } from '../components/TransportBar';
import { createApplicationMenuCommandState } from './applicationMenuCommands';
import { PRESET_PROJECTS } from '../audio/presets';

/**
 * UI Milestone 1C — Step 3: studio browser shell contract.
 *
 * The browser is asset navigation chrome. These tests pin the parts of the
 * redesign that users and other code depend on:
 *   - every row and folder header is a native <button> (keyboard accessible
 *     without a script), with the shell focus-visible ring,
 *   - folder headers expose aria-expanded / aria-controls,
 *   - the sample audition state is exposed with aria-pressed,
 *   - the header, search, body and preview are four distinct surfaces,
 *   - the preview reports the real audition state and nothing else — no
 *     fabricated waveform, no fabricated telemetry,
 *   - the row handlers and their arguments are the existing App handlers.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative: string) => readFileSync(path.join(repoRoot, relative), 'utf8');

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const browserSource = () => read('src/components/StudioBrowser.tsx');
const indexCss = () => read('src/index.css');
const appSource = () => read('src/App.tsx');

const baseProps: StudioBrowserProps = {
  search: '',
  onSearchChange: () => {},
  expandedFolders: { instruments: true, drums: true, presets: true },
  onToggleFolder: () => {},
  previewingAudio: null,
  onOpenProjectManager: () => {},
  onAddInstrument: () => {},
  onAuditionSample: () => {},
  onLoadPresetProject: () => {},
};

const renderBrowser = (overrides: Partial<StudioBrowserProps> = {}): string =>
  renderToStaticMarkup(React.createElement(StudioBrowser, { ...baseProps, ...overrides }));

/** The tag name of every element carrying one of the interactive browser primitives. */
const interactiveTagsOf = (html: string): string[] => {
  // The exact class strings the component renders; matching them whole keeps
  // this from confusing `apex-browser-row-label` with the row control itself.
  const classes = [
    'class="apex-browser-row"',
    'class="apex-browser-row apex-browser-row--audition"',
    'class="apex-browser-folder-btn"',
    'class="apex-browser-action"',
  ];
  const tags: string[] = [];
  for (const cls of classes) {
    let index = html.indexOf(cls);
    while (index >= 0) {
      const tagStart = html.lastIndexOf('<', index);
      const tagEnd = html.indexOf('>', index);
      const tag = html.slice(tagStart, tagEnd + 1);
      tags.push(tag.startsWith('<button') ? 'button' : tag.slice(1).split(/\s/)[0]);
      index = html.indexOf(cls, index + cls.length);
    }
  }
  return tags;
};

// ---------------------------------------------------------------------------
// 1. Surfaces and structure
// ---------------------------------------------------------------------------

test('the browser renders as an aside with four distinct surfaces', () => {
  const html = renderBrowser();
  assert.ok(html.startsWith('<aside id="studio-browser"'), 'the browser is the app sidebar');
  assert.ok(html.includes('class="apex-browser-header"'), 'header surface');
  assert.ok(html.includes('class="apex-browser-search"'), 'search surface');
  assert.ok(html.includes('id="studio-browser-body"'), 'body surface');
  assert.ok(html.includes('id="studio-browser-preview"'), 'preview surface');
  assert.ok(html.includes('id="studio-browser-search"'), 'the search field is labelled by an id');
});

test('the browser keeps the shipped sidebar geometry contract', () => {
  const html = renderBrowser();
  assert.ok(
    html.includes('class="apex-sidebar w-56 md:w-64 flex flex-col shrink-0 border-r"'),
    'w-56 / md:w-64, flex column, shrink-0, right border — the shipped geometry'
  );
});

test('the browser still opens the project hub from its + New entry point', () => {
  const html = renderBrowser();
  assert.ok(html.includes('id="browser-new-project-btn"'));
  assert.ok(html.includes('aria-label="New project — open the project hub"'));
});

// ---------------------------------------------------------------------------
// 2. Native buttons and keyboard access
// ---------------------------------------------------------------------------

test('every row and folder header is a native button, and no div carries the interactive primitives', () => {
  const html = renderBrowser();
  const buttons = (html.match(/<button/g) ?? []).length;
  const expected =
    1 /* + New */ +
    STUDIO_BROWSER_FOLDERS.length /* folder headers */ +
    STUDIO_BROWSER_INSTRUMENTS.length +
    STUDIO_BROWSER_DRUM_SAMPLES.length +
    PRESET_PROJECTS.length;
  assert.equal(buttons, expected, 'every interactive row must be a <button>');

  const tags = interactiveTagsOf(html);
  assert.ok(tags.length >= expected, 'the interactive primitives must all render');
  for (const tag of tags) {
    assert.equal(tag, 'button', `${tag} must not carry an interactive browser primitive`);
  }
});

test('the component source keeps no clickable divs or cursor-pointer markup', () => {
  const source = stripComments(browserSource());
  assert.equal(source.includes('cursor-pointer'), false, 'no cursor-pointer rows');
  assert.equal(/<div[^>]*onClick/.test(source), false, 'no div with an onClick handler');
  assert.equal(source.includes('onKeyDown'), false, 'keyboard access comes from native buttons');
});

test('every rendered button is a real, focusable type="button" control', () => {
  const html = renderBrowser();
  assert.equal((html.match(/<button/g) ?? []).length, (html.match(/type="button"/g) ?? []).length);
});

test('the shell focus-visible ring is defined for every browser control', () => {
  const css = indexCss();
  assert.ok(css.includes('.apex-browser-row:focus-visible'));
  assert.ok(css.includes('.apex-browser-folder-btn:focus-visible'));
  assert.ok(css.includes('.apex-browser-action:focus-visible'));
  assert.ok(css.includes('.apex-browser-search:focus-within'), 'the search field shows its focus state');
});

// ---------------------------------------------------------------------------
// 3. Disclosure and audition state semantics
// ---------------------------------------------------------------------------

test('folder headers expose aria-expanded and aria-controls to their item groups', () => {
  const html = renderBrowser();
  for (const folder of STUDIO_BROWSER_FOLDERS) {
    const tag = html.slice(html.indexOf(`id="browser-folder-toggle-${folder.id}"`));
    const openTag = tag.slice(0, tag.indexOf('>'));
    assert.ok(openTag.includes('aria-expanded="true"'), `${folder.id} header reports expanded`);
    assert.ok(
      openTag.includes(`aria-controls="browser-folder-items-${folder.id}"`),
      `${folder.id} header controls its item group`
    );
    assert.ok(html.includes(`id="browser-folder-items-${folder.id}"`), `${folder.id} group renders`);
    assert.ok(
      html.includes(`role="group" aria-labelledby="browser-folder-toggle-${folder.id}"`),
      `${folder.id} group is labelled by its header`
    );
  }
});

test('collapsing a folder flips aria-expanded and removes its items from the DOM', () => {
  const html = renderBrowser({ expandedFolders: { instruments: false, drums: true, presets: true } });
  const tag = html.slice(html.indexOf('id="browser-folder-toggle-instruments"'));
  assert.ok(tag.slice(0, tag.indexOf('>')).includes('aria-expanded="false"'));
  assert.equal(html.includes('id="browser-folder-items-instruments"'), false, 'collapsed items do not render');
  assert.ok(html.includes('id="browser-folder-items-drums"'), 'other folders are unaffected');
});

/** The full opening tag of the button that announces `action`. */
const buttonTagOf = (html: string, action: string): string => {
  const labelIndex = html.indexOf(`aria-label="Audition ${action}"`);
  assert.ok(labelIndex > 0, `the row for ${action} must render`);
  const tagStart = html.lastIndexOf('<button', labelIndex);
  return html.slice(tagStart, html.indexOf('>', tagStart) + 1);
};

test('the drum sample rows expose the audition state with aria-pressed', () => {
  const idle = renderBrowser();
  for (const sample of STUDIO_BROWSER_DRUM_SAMPLES) {
    assert.ok(buttonTagOf(idle, sample.name).includes('aria-pressed="false"'),
      `${sample.name} reports idle while nothing is auditioning`);
  }

  const auditioning = renderBrowser({ previewingAudio: 'Snare_Trap_Hard.wav' });
  assert.ok(buttonTagOf(auditioning, 'Snare_Trap_Hard.wav').includes('aria-pressed="true"'),
    'the auditioned row reports active');
  assert.ok(buttonTagOf(auditioning, 'Clap_Studio_Dry.wav').includes('aria-pressed="false"'),
    'unselected rows stay idle');
});

// ---------------------------------------------------------------------------
// 4. Truthfulness: the preview surface
// ---------------------------------------------------------------------------

test('the preview surface reports the sample that is actually auditioning', () => {
  const idle = renderBrowser().slice(renderBrowser().indexOf('id="studio-browser-preview"'));
  assert.ok(idle.includes('Ready'), 'idle preview says Ready');
  assert.equal(idle.includes('Auditioning'), false);

  const active = renderBrowser({ previewingAudio: '808_Sub_Punch.wav' });
  const preview = active.slice(active.indexOf('id="studio-browser-preview"'));
  assert.ok(preview.includes('Auditioning'), 'active preview says Auditioning');
  assert.ok(preview.includes('808_Sub_Punch.wav'), 'the preview names the real sample');
  assert.ok(preview.includes('data-active="true"'));
});

test('the preview draws no fabricated waveform and the browser shows no fabricated telemetry', () => {
  const html = renderBrowser();
  const preview = html.slice(html.indexOf('id="studio-browser-preview"'));
  assert.equal(preview.includes('style='), false, 'no generated bar geometry');
  assert.equal((preview.match(/<div/g) ?? []).length, 2, 'state row, sample line — no generated bars');
  assert.equal(html.toLowerCase().includes('waveform'), false);

  for (const fabricated of ['CPU', 'FPS', 'LATENCY', 'MEMORY']) {
    assert.equal(html.includes(fabricated), false, `no fabricated ${fabricated} telemetry`);
  }

  const source = stripComments(browserSource());
  assert.equal(source.includes('Array.from'), false, 'no generated waveform bars');
});

// ---------------------------------------------------------------------------
// 5. Contents and search
// ---------------------------------------------------------------------------

test('the folder contents are exactly the shipped instrument, sample and demo lists', () => {
  const html = renderBrowser();
  for (const instrument of STUDIO_BROWSER_INSTRUMENTS) {
    assert.ok(html.includes(instrument.name), `${instrument.name} must be reachable`);
  }
  for (const sample of STUDIO_BROWSER_DRUM_SAMPLES) {
    assert.ok(html.includes(sample.name), `${sample.name} must be reachable`);
  }
  for (const preset of PRESET_PROJECTS) {
    assert.ok(html.includes(preset.name), `${preset.name} must be reachable`);
    assert.ok(html.includes(`${preset.bpm} BPM`), `${preset.name} shows its real tempo`);
  }
  assert.equal(STUDIO_BROWSER_INSTRUMENTS.length, 19);
  assert.equal(STUDIO_BROWSER_DRUM_SAMPLES.length, 5);
  assert.deepEqual(
    STUDIO_BROWSER_FOLDERS.map(folder => folder.id),
    ['instruments', 'drums', 'presets'],
    'the folder ids are the App expandedFolders keys'
  );
});

test('the search field filters every folder and empty folders say so', () => {
  const html = renderBrowser({ search: '808' });
  assert.ok(html.includes('value="808"'));

  assert.ok(html.includes('808 Tuned Sub Bass'));
  assert.ok(html.includes('808 Drum Machine'));
  assert.equal(html.includes('Grand Concert Piano'), false, 'non-matching instruments are hidden');

  assert.ok(html.includes('808_Sub_Punch.wav'));
  assert.equal(html.includes('Snare_Trap_Hard.wav'), false, 'non-matching samples are hidden');

  for (const preset of PRESET_PROJECTS) {
    assert.equal(html.includes(preset.name), false, 'no demo matches "808"');
  }
  assert.equal((html.match(/No matches/g) ?? []).length, 1, 'the empty folder reports no matches once');
});

test('filterStudioBrowserRows is a trimmed, case-insensitive name match', () => {
  assert.deepEqual(filterStudioBrowserRows(STUDIO_BROWSER_DRUM_SAMPLES, ''), STUDIO_BROWSER_DRUM_SAMPLES);
  assert.deepEqual(filterStudioBrowserRows(STUDIO_BROWSER_DRUM_SAMPLES, '   '), STUDIO_BROWSER_DRUM_SAMPLES);
  assert.deepEqual(
    filterStudioBrowserRows(STUDIO_BROWSER_INSTRUMENTS, '808').map(item => item.name),
    ['808 Tuned Sub Bass', '808 Drum Machine']
  );
  assert.deepEqual(
    filterStudioBrowserRows(STUDIO_BROWSER_INSTRUMENTS, 'SUPERSAW').map(item => item.name),
    ['JP-8000 Supersaw']
  );
  assert.deepEqual(filterStudioBrowserRows(STUDIO_BROWSER_INSTRUMENTS, 'zzz-no-such-instrument'), []);
});

// ---------------------------------------------------------------------------
// 6. Handlers, wiring and untouched contracts
// ---------------------------------------------------------------------------

test('the browser delegates to the existing App handlers with their original arguments', () => {
  const app = appSource();
  assert.ok(app.includes('onAuditionSample={handleAuditionSample}'), 'audition is the existing handler, unchanged');
  assert.ok(
    app.includes('handleAddChannel(instrument.type, instrument.name, instrument.color)'),
    'loading an instrument still calls handleAddChannel(type, name, color)'
  );
  assert.ok(
    app.includes("handleLoadProjectState(preset.state, { source: 'studio-demo' })"),
    'loading a demo still runs the existing replacement path with the studio-demo source'
  );
  assert.ok(app.includes('onOpenProjectManager={() => setIsProjectManagerOpen(true)}'));
});

test('the browser state stays owned by App exactly as before', () => {
  const app = appSource();
  assert.ok(app.includes("const [browserSearch, setBrowserSearch] = useState('')"));
  assert.ok(app.includes('const [previewingAudio, setPreviewingAudio] = useState<string | null>(null)'));
  assert.ok(app.includes('const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>'));
  assert.ok(app.includes('{isSidebarOpen && ('), 'the browser still mounts only while the sidebar is open');
});

test('the browser carries no legacy palette utilities or arbitrary type sizes', () => {
  const source = browserSource();
  const legacyColours = [...source.matchAll(/\b(?:bg|text|border|ring|from|to)-\[#(?:[0-9a-fA-F]{3,8})(?:\/[0-9.]+)?\]/g)].map(
    match => match[0]
  );
  assert.deepEqual(legacyColours, [], 'the browser must use the shell tokens');
  const arbitrarySizes = [...source.matchAll(/text-\[\d+(?:\.\d+)?(?:px|rem)\]|text-#/g)].map(m => m[0]);
  assert.deepEqual(arbitrarySizes, [], 'the browser must use the shell type tokens');
  assert.equal(/\bfont-bold\b/.test(source), false, 'the browser must use the two weight policy');
});

// ---------------------------------------------------------------------------
// 7. Shell document order with the existing chrome
// ---------------------------------------------------------------------------

const commandState = createApplicationMenuCommandState({
  canUndo: () => true,
  canRedo: () => true,
  hasSelectedChannel: () => true,
  canDeleteSelectedChannel: () => true,
  currentView: () => 'channel_rack',
  isBrowserOpen: () => true,
  isFullscreen: () => false,
  isMetronomeOn: () => false,
  isRecording: () => false,
});

test('the shell renders menu, transport, browser and status bar in document order', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      'div',
      { id: 'shell-order-fixture' },
      React.createElement(ApplicationMenuBarView, {
        openMenu: null,
        commandState,
        onToggleMenu: () => {},
        onHoverMenu: () => {},
        onDismiss: () => {},
        onRunCommand: () => {},
      }),
      React.createElement(TransportBar, {
        currentView: 'channel_rack',
        onSelectView: () => {},
        isPlaying: false,
        onTogglePlay: () => {},
        onStop: () => {},
        playMode: 'pat',
        onTogglePlayMode: () => {},
        isRecording: false,
        onToggleRecord: () => {},
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
        onUpdateMeta: () => {},
        currentStep: 0,
        currentBar: 1,
        metronome: false,
        onToggleMetronome: () => {},
        onOpenExport: () => {},
        onOpenProjectManager: () => {},
        onOpenCollab: () => {},
        onOpenAnalytics: () => {},
        onOpenHotkeys: () => {},
        onOpenMidi: () => {},
        collaboratorCount: 0,
        isSidebarOpen: true,
        onToggleSidebar: () => {},
      }),
      React.createElement(StudioBrowser, baseProps),
      React.createElement(StatusBar, {
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
        channelCount: 4,
        clipCount: 0,
      })
    )
  );

  const order = ['application-menu-bar', 'fl-transport-bar', 'studio-browser', 'studio-status-bar'].map(
    id => html.indexOf(`id="${id}"`)
  );
  assert.ok(order.every(index => index > 0), 'all four shell bands render');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'menu, transport, browser, status bar');
});
