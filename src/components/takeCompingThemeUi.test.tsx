/**
 * UI-03N — Take Comping theme contract.
 *
 * `TakeCompingModal` is DOM-rendered with no canvas, so every chrome surface
 * follows the active palette through the existing `--apex-*` tokens; no
 * palette seam or theme observer is required.
 *
 * Two colour families are deliberately treated differently:
 *
 *   - **Chrome** (panel, header/footer bands, empty-state inset, group cards,
 *     take rows, borders, hover, the cyan identity tile) resolves through
 *     semantic tokens.
 *   - **The cyan take/recording identity** (tile, panel edge, selected group
 *     border, active-take fill, Check glyph and the Done CTA) stays on the
 *     `--apex-cyan` family — the same token family the audio-recorder and
 *     vocal-tuner identities use. Selection additionally carries a
 *     `--apex-accent-strong` ring and a `--apex-surface-3` step, so it never
 *     depends on a single colour alone.
 *
 * Take-group resolution (`getTakeGroupIds`, `getTakeGroupClips`,
 * `resolveActiveTakeIndex`, `selectActiveTake`) is owned by
 * `src/audio/takeLaneManager.ts` and its suites; this file pins the
 * presentation contract plus the wiring the modal itself owns. The group
 * list state is exercised here with real take-group clips because the shipped
 * default project contains no audio takes, so that branch cannot be reached
 * in the live app without recording.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TakeCompingModal } from './TakeCompingModal';
import type { PlaylistClip } from '../types/daw';

const source = readFileSync('src/components/TakeCompingModal.tsx', 'utf8');

/**
 * Source with comments stripped. Literal assertions run against this, so prose
 * *about* a legacy literal (this migration's own explanatory comment names the
 * dead black scrim) can neither satisfy nor trip them.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
const noop = (): void => {};

/** Every class string in the source, including the ternary branches that the
    first render never paints (expanded group, selected group, active take). */
const sourceClassNames = (text: string): string[] => {
  const out: string[] = [];
  for (const match of text.matchAll(/className=(?:\"([^\"]*)\"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  // The ternary branches inside a template className are covered by the raw
  // string above; the single-quoted literals inside them are matched too.
  for (const match of text.matchAll(/'([^']*(?:bg|text|border|ring|accent)-\[[^']*)'/g)) {
    out.push(match[1]);
  }
  return out;
};

/** Any colour that cannot follow the theme: a literal, a fixed palette
    utility, or a Tailwind named-palette class. */
const UNTHEMED_CLASS =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to|via|fill|ring)-\[#|\b(?:text|bg|border|fill|ring)-(?:white|black)\b|bg-black(?:\/\d+)?\b|rgba?\(|\b(?:text|bg|border|ring)-(?:red|amber|green|gray|zinc|neutral|orange|yellow|emerald|cyan|violet|purple|slate)-\d/i;

/** Two real take groups: one with an explicit active take, one that resolves
    to its latest take by default. Shapes come from the Phase 1M contract. */
const takeGroupsFixture: PlaylistClip[] = [
  { id: 'take-a1', trackIndex: 3, startBar: 0, lengthBars: 4, type: 'audio', color: '#00e5ff', name: 'Vocal Take A', audioName: 'vocal_take_1.wav', audioBufferId: 'buf-aaaaaaaaaaaaaaaa', takeGroupId: 'grp-vocal', takeIndex: 0, activeTakeIndex: 1 },
  { id: 'take-a2', trackIndex: 3, startBar: 0, lengthBars: 4, type: 'audio', color: '#00e5ff', name: 'Vocal Take B', audioName: 'vocal_take_2.wav', audioBufferId: 'buf-bbbbbbbbbbbbbbbb', takeGroupId: 'grp-vocal', takeIndex: 1, activeTakeIndex: 1 },
  { id: 'take-a3', trackIndex: 3, startBar: 0, lengthBars: 4, type: 'audio', color: '#00e5ff', name: 'Vocal Take C', audioName: 'vocal_take_3.wav', audioBufferId: 'buf-cccccccccccccccc', takeGroupId: 'grp-vocal', takeIndex: 2, activeTakeIndex: 1 },
  { id: 'take-b1', trackIndex: 4, startBar: 8, lengthBars: 2, type: 'audio', color: '#ff6e00', name: 'Bass Take A', audioBufferId: 'buf-dddddddddddddd', takeGroupId: 'grp-bass', takeIndex: 0 },
  { id: 'take-b2', trackIndex: 4, startBar: 8, lengthBars: 2, type: 'audio', color: '#ff6e00', name: 'Bass Take B', audioBufferId: 'buf-eeeeeeeeeeeeee', takeGroupId: 'grp-bass', takeIndex: 1 },
];

interface RenderOverrides {
  playlistClips?: PlaylistClip[];
  isOpen?: boolean;
}

const render = (mode: 'dark' | 'light', overrides: RenderOverrides = {}): string =>
  renderToStaticMarkup(
    React.createElement(
      'div',
      { 'data-theme': mode },
      React.createElement(TakeCompingModal, {
        isOpen: overrides.isOpen ?? true,
        onClose: noop,
        playlistClips: overrides.playlistClips ?? [],
        onSelectActiveTake: noop,
      }),
    ),
  );

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

const includes = (haystack: string, needle: string, message: string): void =>
  assert.ok(haystack.includes(needle), `${message}\n  expected to find: ${needle}`);

describe('Take Comping theme markup (UI-03N)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`renders the empty comping state with semantic theme classes in ${mode}`, () => {
      const markup = render(mode, { playlistClips: [] });
      assert.match(markup, new RegExp(`data-theme="${mode}"`));
      includes(markup, 'id="fl-take-comping-modal"', 'the overlay keeps its id');
      includes(markup, 'role="dialog"', 'the overlay is a dialog');
      includes(markup, 'aria-modal="true"', 'the dialog is modal');
      includes(markup, 'aria-labelledby="fl-take-comping-modal-title"', 'the dialog is named by its title');
      includes(markup, '>TAKE COMPING<', 'the title text is unchanged');
      includes(markup, 'Select the active take for each recording group', 'the subtitle is unchanged');
      includes(markup, 'aria-label="Close take comping"', 'the close control keeps its accessible name');
      includes(markup, '>No take groups found<', 'the empty state heading is unchanged');
      includes(markup, 'Record multiple takes on the same track to create take groups', 'the empty state hint is unchanged');
      includes(markup, '>0 take groups · 0 total takes<', 'the footer counts the empty project');
      includes(markup, '>Done<', 'the footer action renders');
    });

    it(`renders the take-group list with semantic theme classes in ${mode}`, () => {
      const markup = render(mode, { playlistClips: takeGroupsFixture });
      // Both groups resolve their active take through takeLaneManager:
      // the explicit selection wins, and the unselected group falls back to
      // its latest take.
      includes(markup, 'Track 4 · Bars 1–4', 'the first group reports its track and bar range');
      includes(markup, '3 takes · Active: Take 2', 'the explicit active take is reported');
      includes(markup, 'Track 5 · Bars 9–10', 'the second group reports its track and bar range');
      includes(markup, '2 takes · Active: Take 2', 'the default latest-take resolution is reported');
      includes(markup, '>2 take groups · 5 total takes<', 'the footer counts both groups and all takes');
      // The first render opens with no group expanded.
      assert.ok(!markup.includes('SELECT ACTIVE TAKE:'), 'groups start collapsed');
    });
  }

  it('carries no fixed chrome palette in any rendered state of either theme', () => {
    const states: ReadonlyArray<[string, RenderOverrides]> = [
      ['empty', { playlistClips: [] }],
      ['groups', { playlistClips: takeGroupsFixture }],
    ];
    for (const mode of ['dark', 'light'] as const) {
      for (const [label, overrides] of states) {
        const offenders = classAttributes(render(mode, overrides)).filter((value) => UNTHEMED_CLASS.test(value));
        assert.deepEqual(offenders, [], `${mode} ${label} renders an unthemed class`);
      }
    }
  });

  it('carries no fixed palette in any className in the source, including the non-first-paint branches', () => {
    const names = sourceClassNames(code);
    assert.ok(names.length > 15, `expected the full class surface, found ${names.length}`);
    const offenders = names.filter((value) => UNTHEMED_CLASS.test(value));
    assert.deepEqual(offenders, [], 'a className in the source still carries a fixed palette');
    assert.doesNotMatch(code, /rgba?\(/, 'no rgb()/rgba() literal remains in the component code');
    assert.doesNotMatch(code, /bg-black/, 'the redundant dark overlay fill is gone');
  });

  it('keeps the cyan take identity, the selection ring and the themed hover states', () => {
    assert.match(source, /bg-gradient-to-br from-\[var\(--apex-cyan\)\] to-\[var\(--apex-cyan-strong\)\]/, 'the identity tile keeps its cyan gradient');
    assert.match(
      source,
      /border-\[color-mix\(in_srgb,var\(--apex-cyan\)_40%,transparent\)\]/,
      'the panel edge keeps a cyan wash',
    );
    assert.match(
      source,
      /bg-\[var\(--apex-surface-3\)\] border-\[var\(--apex-cyan\)\] ring-2 ring-\[var\(--apex-accent-strong\)\] shadow-lg/,
      'the selected group keeps its identity border plus a themed ring and surface step',
    );
    assert.match(
      source,
      /border-\[var\(--apex-border\)\] hover:border-\[var\(--apex-grid-line-strong\)\]/,
      'the idle group card keeps a themed border and hover lift',
    );
    assert.match(
      source,
      /bg-\[color-mix\(in_srgb,var\(--apex-cyan\)_20%,transparent\)\] border-\[var\(--apex-cyan\)\] text-\[var\(--apex-text\)\]/,
      'the active take row keeps its cyan wash and themed text',
    );
    assert.match(
      source,
      /bg-\[var\(--apex-canvas\)\] border-\[var\(--apex-border\)\] text-\[var\(--apex-text-2\)\] hover:border-\[var\(--apex-grid-line-strong\)\] hover:bg-\[var\(--apex-surface-3\)\]/,
      'the idle take row keeps its inset surface and hover step',
    );
    assert.match(source, /<Check className="w-4 h-4 text-\[var\(--apex-cyan\)\]" \/>/, 'the active take glyph keeps its cyan meaning');
    assert.match(source, /bg-\[var\(--apex-cyan\)\] hover:bg-\[var\(--apex-cyan-strong\)\] text-\[var\(--apex-state-playing-fg\)\]/, 'the Done CTA keeps its cyan fill and hover step');
    assert.match(source, /var\(--apex-state-hover\)/, 'the close control keeps a themed hover wash');
  });

  it('uses existing semantic tokens for surfaces, text and borders', () => {
    for (const token of [
      '--apex-surface',
      '--apex-surface-2',
      '--apex-surface-3',
      '--apex-panel-header',
      '--apex-canvas',
      '--apex-border',
      '--apex-grid-line-strong',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-accent-strong',
      '--apex-state-hover',
      '--apex-state-playing-fg',
    ]) {
      assert.ok(source.includes(`var(${token})`), `take comping chrome consumes ${token}`);
    }
  });

  it('keeps the take-manager wiring and publishes selections through the parent', () => {
    assert.match(code, /const groupIds = getTakeGroupIds\(playlistClips\);/, 'the modal enumerates groups through the take manager');
    assert.match(code, /const clips = getTakeGroupClips\(playlistClips, groupId\);/, 'each group resolves its clips through the take manager');
    assert.match(code, /const activeIndex = resolveActiveTakeIndex\(clips, groupId\);/, 'each group resolves its active take through the take manager');
    assert.match(
      code,
      /const handleSelectTake = \(groupId: string, takeIndex: number\) => \{\s*onSelectActiveTake\(groupId, takeIndex\);\s*\};/,
      'a take selection publishes through the parent callback unchanged',
    );
    assert.match(
      code,
      /e\.stopPropagation\(\);\s*handleSelectTake\(group\.groupId, clip\.takeIndex \?\? 0\);/,
      'a take-row click does not toggle its group',
    );
    assert.match(
      code,
      /onClick=\{\(\) => setSelectedGroupId\(isSelected \? null : group\.groupId\)\}/,
      'group cards toggle their expanded state',
    );
    assert.match(code, /clip\.audioBufferId\?\.slice\(0, 12\)/, 'the buffer read-out shows the stored id prefix');
    assert.match(code, /Duration: \{clip\.lengthBars\.toFixed\(1\)\} bars/, 'the take duration read-out is unchanged');
    assert.doesNotMatch(code, /audioBufferId:/, 'no audio buffer id is fabricated');
  });

  it('stays a real feature: no demo or prototype wording', () => {
    assert.doesNotMatch(code, /DEMO|PROTOTYPE|INCOMPLETE/i, 'the modal is not described as a demo');
  });

  it('uses ModalFrame’s themed scrim and keeps the overlay geometry', () => {
    const markup = render('light');
    assert.match(
      markup,
      /class="apex-modal-overlay fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none"/,
      'the shared themed scrim replaces the dead bg-black/85 fill',
    );
  });

  it('renders nothing while closed', () => {
    const closed = renderToStaticMarkup(
      React.createElement(TakeCompingModal, {
        isOpen: false,
        onClose: noop,
        playlistClips: takeGroupsFixture,
        onSelectActiveTake: noop,
      }),
    );
    assert.equal(closed, '');
  });
});
