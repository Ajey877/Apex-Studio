/**
 * UI-03O — Desktop app modal theme contract.
 *
 * `DesktopAppModal` is DOM-rendered with no canvas, so every surface follows the
 * active palette through the existing `--apex-*` tokens. Four colour families are
 * deliberately treated differently:
 *
 *   - **Chrome** (panel, header/footer bands, tab strip, cards, inset wells,
 *     borders, hover, close) resolves through the shared semantic tokens.
 *   - **The desktop-app identity** (header tile gradient, readiness badge, active
 *     tab, status toast, both download/install CTAs and the footer action) is one
 *     accent family on `--apex-accent` / `--apex-accent-strong`. That is the token
 *     the UI-1C compatibility layer already resolved these `#ff6e00` literals to,
 *     so the migration turns a violet-plus-raw-amber mix into a single coherent
 *     identity without changing the already-mapped surfaces.
 *   - **The per-card glyph triad** keeps three distinct meanings on
 *     `--apex-success`, `--apex-cyan-text` and `--apex-gold`, and the DPI read-out
 *     sub-label keeps `--apex-aux-text` — the same hue mapping UI-03M used for its
 *     multi-hue identity set.
 *   - **The generated Windows bundle** is payload, not chrome: the `.bat`, `.ps1`,
 *     `.vbs`, `electron.cjs`, `preload.cjs`, `package.json` and README texts that
 *     `generateWindowsZipBundle` writes into the ZIP keep their bytes exactly,
 *     including `backgroundColor: "#0a0a0b"` inside the generated `electron.cjs`.
 *
 * Only the default `windows_exe` tab renders without interaction (this suite has
 * no DOM, so the tab buttons cannot be clicked here). The other three tabs are
 * covered two ways: every `className` in the file is scanned for literals, and
 * `browser-tests/desktopAppTheme.spec.ts` clicks each tab in a real Chromium
 * against the live application and measures the resolved colours.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesktopAppModal } from './DesktopAppModal';

const source = readFileSync('src/components/DesktopAppModal.tsx', 'utf8');

const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

/** Template literals hold generated payload (and one comment), not UI chrome. */
const payload = [...code.matchAll(/`[^`]*`/g)].map((match) => match[0]).join('\n');
const chrome = code.replace(/`[^`]*`/g, '``');

const classAttributes = (text: string): string[] => [
  ...[...text.matchAll(/className="([^"]*)"/g)].map((match) => match[1]),
  ...[...text.matchAll(/className=\{`([^`]*)`\}/g)].map((match) => match[1])
];

const UNTHEMED_CLASS =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to|via|fill|ring)-\[#|\b(?:text|bg|border|fill|ring)-(?:white|black)\b|bg-black(?:\/\d+)?\b|rgba?\(|\b(?:text|bg|border|ring)-(?:red|amber|green|gray|zinc|neutral|orange|yellow|emerald|cyan|violet|purple|slate)-\d/i;

const includes = (haystack: string, needle: string, message: string): void => assert.ok(haystack.includes(needle), `${message}\n  expected to find: ${needle}`);

/** The modal reads screen geometry and the page origin while rendering. */
const withDesktopWindowStub = <T,>(run: () => T): T => {
  const holder = globalThis as { window?: unknown };
  const previous = holder.window;
  holder.window = {
    innerWidth: 1920,
    innerHeight: 1080,
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    devicePixelRatio: 1,
    location: { origin: 'https://apex-studio.test' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  };
  try {
    return run();
  } finally {
    if (previous === undefined) delete holder.window;
    else holder.window = previous;
  }
};

const render = (mode: 'dark' | 'light', isOpen = true): string =>
  withDesktopWindowStub(() =>
    renderToStaticMarkup(
      React.createElement(
        'div',
        { 'data-theme': mode },
        React.createElement(DesktopAppModal, {
          isOpen,
          onClose: () => undefined
        })
      )
    )
  );

describe('Desktop app modal theme markup (UI-03O)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`renders the Windows bundle tab with semantic theme classes in ${mode}`, () => {
      const markup = render(mode);
      assert.match(markup, new RegExp(`data-theme="${mode}"`));
      includes(markup, 'id="fl-desktop-app-modal"', 'the overlay keeps its id');
      includes(markup, 'role="dialog"', 'the overlay is a dialog');
      includes(markup, 'aria-modal="true"', 'the dialog is modal');
      includes(markup, 'aria-labelledby="fl-desktop-app-modal-title"', 'the dialog is named by its title');
      includes(markup, 'WINDOWS .EXE &amp; DESKTOP SUITE', 'the title text is unchanged');
      includes(markup, 'WINDOWS 10 / 11 NATIVE', 'the readiness badge is unchanged');
      includes(markup, 'aria-label="Close desktop app"', 'the close control keeps its accessible name');
      includes(markup, 'Windows .EXE &amp; Launcher Bundle', 'the default tab label is unchanged');
      includes(markup, '1-Click App (PWA)', 'the PWA tab label is unchanged');
      includes(markup, 'CLI Exe Build Commands', 'the CLI tab label is unchanged');
      includes(markup, 'Desktop Display &amp; Scaling (1920×1080)', 'the display tab reports the live viewport');
      includes(markup, 'READY-TO-USE WINDOWS SUITE', 'the download card is unchanged');
      includes(markup, 'Download Windows Standalone .EXE &amp; Launcher Bundle', 'the download heading is unchanged');
      includes(markup, 'Download Windows .EXE Bundle (.ZIP)', 'the download action is unchanged');
      includes(markup, '1-Click Batch Runner', 'the launcher card is unchanged');
      includes(markup, 'PowerShell .EXE Builder', 'the builder card is unchanged');
      includes(markup, 'Low-Latency Audio Mode', 'the audio-mode card is unchanged');
      includes(markup, 'How to Use on Any Windows PC (Windows 10 / 11)', 'the instructions card is unchanged');
      includes(markup, 'Direct Hardware Driver &amp; Web Audio Subsystem Connected', 'the footer note is unchanged');
      includes(markup, '>Close<', 'the footer action renders');
      assert.equal(
        [...markup.matchAll(/<button /g)].length,
        7,
        'the tab strip, the download action, the close control and the footer action are the only controls'
      );
    });
  }

  it('themes every className in the file, including the three tabs the unit render cannot reach', () => {
    const classes = classAttributes(chrome);
    assert.ok(classes.length >= 60, `the modal declares its surfaces (found ${classes.length})`);
    const offenders = classes.filter((value) => UNTHEMED_CLASS.test(value));
    assert.deepEqual(offenders, [], 'every className resolves through a semantic token');
  });

  it('carries no fixed chrome palette in the rendered default tab of either theme', () => {
    for (const mode of ['dark', 'light'] as const) {
      const offenders = classAttributes(render(mode)).filter((value) => UNTHEMED_CLASS.test(value));
      assert.deepEqual(offenders, [], `${mode} renders an unthemed class`);
    }
  });

  it('keeps the accent identity on one family and the per-card meanings distinct', () => {
    assert.match(
      source,
      /bg-gradient-to-br from-\[var\(--apex-accent\)\] to-\[var\(--apex-accent-strong\)\]/,
      'the header tile keeps a themed identity gradient'
    );
    assert.match(source, /bg-\[var\(--apex-accent\)\]/, 'the status toast and both CTAs keep the accent fill');
    assert.match(source, /hover:bg-\[var\(--apex-accent-strong\)\]/, 'the accent CTAs keep a themed hover step');
    assert.match(source, /text-\[var\(--apex-accent\)\]/, 'the active tab keeps the accent');
    // Measured in Chromium: accent-on-accent-wash is 3.90:1 (Light) / 4.23:1
    // (Dark) for the 9px bold readiness badge — below AA in both palettes. The wash and edge carry the
    // accent identity; the labels use the primary text token.
    assert.match(
      source,
      /bg-\[color-mix\(in_srgb,var\(--apex-accent\)_16%,transparent\)\] text-\[var\(--apex-text\)\] border/,
      'the readiness badge label follows the primary text token',
    );
    assert.match(
      source,
      /rounded text-\[10px\] font-mono font-bold bg-\[color-mix\(in_srgb,var\(--apex-accent\)_16%,transparent\)\] text-\[var\(--apex-text\)\]/,
      'the Windows-suite badge label follows the primary text token',
    );
    assert.match(source, /border-\[color-mix\(in_srgb,var\(--apex-accent\)_48%,transparent\)\]/, 'the panel and download card keep an accent edge');
    assert.match(source, /text-\[var\(--apex-success\)\]/, 'the green glyph/copy keep their meaning');
    assert.match(source, /text-\[var\(--apex-cyan-text\)\]/, 'the cyan glyph/copy keep their meaning');
    assert.match(source, /text-\[var\(--apex-gold\)\]/, 'the amber glyph/copy keep their meaning');
    assert.match(source, /text-\[var\(--apex-aux-text\)\]/, 'the colour-depth sub-label keeps the aux hue');
    assert.match(source, /text-\[var\(--apex-state-playing-fg\)\]/, 'filled controls use a theme-safe on-colour');
  });

  it('uses the shared surface/text steps and drops the dead dark scrim', () => {
    for (const token of [
      '--apex-surface',
      '--apex-surface-2',
      '--apex-surface-3',
      '--apex-panel-header',
      '--apex-canvas',
      '--apex-border',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-state-hover'
    ]) {
      assert.ok(source.includes(`var(${token})`), `desktop-app chrome consumes ${token}`);
    }
    assert.doesNotMatch(code, /bg-black/, 'the redundant dark overlay fill is gone');
  });

  it('uses ModalFrame’s themed scrim and keeps the overlay geometry', () => {
    assert.match(
      render('light'),
      /class="apex-modal-overlay fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none"/,
      'the shared themed scrim replaces the dead bg-black/85 fill'
    );
  });

  it('keeps the generated Windows bundle payload byte-for-byte', () => {
    for (const file of [
      'ApexStudio-Windows-Launcher.bat',
      'Build-Windows-EXE.ps1',
      'ApexStudio-Silent.vbs',
      'electron.cjs',
      'preload.cjs',
      'README_WINDOWS_EXE.txt'
    ]) {
      includes(source, `zip.file('${file}'`, `the bundle still ships ${file}`);
    }
    includes(payload, 'backgroundColor: "#0a0a0b"', 'the generated Electron window colour is payload, not chrome');
    assert.deepEqual(payload.match(/#[0-9a-fA-F]{3,8}/g) ?? [], ['#0a0a0b'], 'the generated payload keeps exactly the colour it shipped with');
    assert.equal((chrome.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).length, 0, 'no colour literal survives in the rendered chrome');
  });

  it('keeps the installer actions, the live engine read-out and the toast wiring intact', () => {
    assert.match(code, /if \(!isOpen\) return null;/, 'the open guard is untouched');
    assert.match(code, /deferredPrompt\.prompt\(\);/, 'the PWA install prompt is unchanged');
    assert.match(code, /window\.addEventListener\('beforeinstallprompt', handleBeforeInstallPrompt\);/, 'the install-prompt listener is unchanged');
    assert.match(code, /const read = \(\) => setAudioEngineInfo\(audioEngine\.getLatencyMetrics\(\)\);/, 'the latency read-out still reads the live engine');
    assert.match(code, /const timerId = setInterval\(read, 1000\);/, 'the latency read-out keeps its cadence');
    assert.match(code, /setTimeout\(\(\) => setStatusMessage\(null\), 6000\);/, 'the install hint still self-clears');
    assert.match(
      code,
      /navigator\.clipboard\.writeText\(`npm install electron electron-builder --save-dev\\nnpx electron-builder --win --x64`\);/,
      'the copied build commands are unchanged'
    );
    assert.match(code, /aria-label="Dismiss status message"/, 'the toast dismiss glyph is named for assistive technology');
    assert.match(code, /new JSZip\(\)/, 'the ZIP bundle builder is unchanged');
    assert.match(
      code,
      /a\.download = `ApexStudio_Windows_EXE_Bundle_\$\{new Date\(\)\.toISOString\(\)\.slice\(0, 10\)\}\.zip`;/,
      'the download name is unchanged'
    );
  });

  it('renders nothing while closed', () => {
    assert.equal(render('dark', false), '<div data-theme="dark"></div>');
  });
});
