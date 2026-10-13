/**
 * UI-03O — Hotkeys modal theme contract.
 *
 * `HotkeysModal` is DOM-rendered with no canvas, so every surface follows the
 * active palette through the existing `--apex-*` tokens. Its accent identity
 * (identity tile, tile glyph, category headings, tip glyph, "Got it" action)
 * stays on `--apex-accent` — the token the UI-1C compatibility layer already
 * resolved these `#ff6e00` literals to — while group cards, `kbd` chips, the tip
 * band and the text scale follow the shared surface/text steps.
 *
 * The documented shortcut table is product copy, not presentation: every row must
 * keep tracing to a real handler, which `src/state/hotkeyDocumentation.test.ts`
 * owns. It is re-pinned here so a restyle can never quietly drop a row.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HOTKEY_GROUPS, HotkeysModal } from './HotkeysModal';

const source = readFileSync('src/components/HotkeysModal.tsx', 'utf8');

const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

const noop = (): void => {};

const render = (mode: 'dark' | 'light', isOpen = true): string =>
  renderToStaticMarkup(React.createElement('div', { 'data-theme': mode }, React.createElement(HotkeysModal, { isOpen, onClose: noop })));

const classAttributes = (markup: string): string[] => [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

const UNTHEMED_CLASS =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to|via|fill|ring)-\[#|\b(?:text|bg|border|fill|ring)-(?:white|black)\b|bg-black(?:\/\d+)?\b|rgba?\(|\b(?:text|bg|border|ring)-(?:red|amber|green|gray|zinc|neutral|orange|yellow|emerald|cyan|violet|purple|slate)-\d/i;

const includes = (haystack: string, needle: string, message: string): void => assert.ok(haystack.includes(needle), `${message}\n  expected to find: ${needle}`);

/** Static markup escapes the copy JSX emits, so expected text is escaped too. */
const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

describe('Hotkeys modal theme markup (UI-03O)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`renders the whole shortcut sheet with semantic theme classes in ${mode}`, () => {
      const markup = render(mode);
      assert.match(markup, new RegExp(`data-theme="${mode}"`));
      includes(markup, 'id="hotkeys-modal"', 'the overlay keeps its id');
      includes(markup, 'role="dialog"', 'the overlay is a dialog');
      includes(markup, 'aria-modal="true"', 'the dialog is modal');
      includes(markup, 'aria-labelledby="hotkeys-modal-title"', 'the dialog is named by its title');
      includes(markup, 'STUDIO KEYBOARD SHORTCUTS &amp; HOTKEYS', 'the title text is unchanged');
      includes(markup, 'Desktop &amp; Hardware Controller Keybindings', 'the subtitle is unchanged');
      includes(markup, 'aria-label="Close hotkeys"', 'the close control keeps its accessible name');
      includes(markup, 'Tip: All shortcuts are active globally without taking focus away from knobs.', 'the tip is unchanged');
      includes(markup, '>Got it<', 'the dismiss action renders');
      for (const group of HOTKEY_GROUPS) {
        includes(markup, escapeHtml(group.category), `the ${group.category} category renders`);
        for (const item of group.items) {
          includes(markup, escapeHtml(item.key), `${item.key} still renders`);
          includes(markup, escapeHtml(item.desc), `${item.desc} still renders`);
        }
      }
      assert.equal(
        [...markup.matchAll(/<kbd /g)].length,
        HOTKEY_GROUPS.reduce((total, group) => total + group.items.length, 0),
        'every documented row keeps its kbd chip'
      );
    });
  }

  it('carries no fixed chrome palette in either theme', () => {
    for (const mode of ['dark', 'light'] as const) {
      const offenders = classAttributes(render(mode)).filter((value) => UNTHEMED_CLASS.test(value));
      assert.deepEqual(offenders, [], `${mode} renders an unthemed class`);
    }
  });

  it('uses existing semantic tokens for surfaces, text, borders and hover', () => {
    for (const token of [
      '--apex-surface',
      '--apex-surface-2',
      '--apex-panel-header',
      '--apex-canvas',
      '--apex-border',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-state-hover',
      '--apex-state-playing-fg'
    ]) {
      assert.ok(source.includes(`var(${token})`), `hotkeys chrome consumes ${token}`);
    }
    assert.doesNotMatch(code, /bg-black/, 'the redundant dark overlay fill is gone');
  });

  it('keeps the accent identity on the tile, headings, tip glyph and dismiss action', () => {
    assert.match(source, /text-\[var\(--apex-accent\)\]/, 'the tile glyph, headings and tip glyph keep the accent');
    assert.match(source, /bg-\[color-mix\(in_srgb,var\(--apex-accent\)_16%,transparent\)\]/, 'the identity tile keeps an accent wash');
    assert.match(source, /border-\[color-mix\(in_srgb,var\(--apex-accent\)_48%,transparent\)\]/, 'the identity tile keeps an accent edge');
    assert.match(source, /bg-\[var\(--apex-accent\)\]/, 'the dismiss action is a solid accent fill');
    assert.match(source, /hover:bg-\[var\(--apex-accent-strong\)\]/, 'the dismiss action keeps a themed hover step');
  });

  it('uses ModalFrame’s themed scrim and keeps the overlay geometry', () => {
    assert.match(
      render('light'),
      /class="apex-modal-overlay fixed inset-0 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4"/,
      'the shared themed scrim replaces the dead bg-black/85 fill'
    );
  });

  it('keeps the documented shortcut table byte-for-byte', () => {
    assert.equal(HOTKEY_GROUPS.length, 5, 'five categories are documented');
    assert.deepEqual(
      HOTKEY_GROUPS.map((group) => group.category),
      ['Project & File', 'Editing', 'Playback & Transport', 'View & Navigation', 'Live Performance & MIDI'],
      'the categories are unchanged'
    );
    assert.equal(
      HOTKEY_GROUPS.flatMap((group) => group.items.map((item) => item.key)).join('|'),
      [
        'Ctrl + N',
        'Ctrl + O',
        'Ctrl + S',
        'Ctrl + Z',
        'Ctrl + Y',
        'Space',
        'L',
        'R',
        'Home / 0',
        'M',
        'F6 / 1',
        'F7 / 2',
        'F5 / 3',
        'F9 / 4',
        'F8 / 5',
        'A - K',
        'W, E, T, Y, U',
        '1 - 9 (Numpad)',
        'Z / X'
      ].join('|'),
      'the documented keys are unchanged'
    );
  });

  it('renders nothing while closed', () => {
    assert.equal(render('dark', false), '<div data-theme="dark"></div>');
  });
});
