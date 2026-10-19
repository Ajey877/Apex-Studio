/**
 * UI-03M — Master Macro Rack theme contract.
 *
 * `MasterMacroRackModal` is DOM/SVG-rendered with no canvas, so every chrome
 * surface follows the active palette through the existing `--apex-*` tokens;
 * no palette seam or theme observer is required.
 *
 * Two colour families are deliberately treated differently:
 *
 *   - **Chrome** (panel, header/footer bands, cards, matrix rows, borders,
 *     hover and the rack's green identity) resolves through semantic tokens.
 *     The green identity stays on `--apex-success` — the same token the
 *     compatibility layer already resolved `#00ff88` text to — and the curve
 *     chip keeps its cyan read-out on `--apex-cyan-text`.
 *   - **`macro.color` is persisted project data** (`ProjectState.macroKnobs[].color`,
 *     validated by `isMacroKnob`), the same category UI-03A explicitly preserves
 *     for `ch.color` and `PAD_COLORS`. It is asserted here to survive verbatim on
 *     the value arc, the selected-card border, the range accent and the mapping
 *     swatch, and to no longer be painted as 10px text — a stored neon identity
 *     hue measures 1.13–3.34:1 on the Light palette, so those labels use
 *     `--apex-text`. Selection also carries a themed `--apex-accent-strong` ring,
 *     so it never depends on a data colour alone.
 *
 * Macro resolution, publication and the project mutation path are owned by
 * `src/state/macroMappings.ts` and its own suites; this file pins the
 * presentation contract plus the wiring the modal itself owns.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MasterMacroRackModal } from './MasterMacroRackModal';
import { DEFAULT_PROJECT } from '../audio/presets';
import type { Channel, MasterMacroKnob, MixerTrack } from '../types/daw';

const source = readFileSync('src/components/MasterMacroRackModal.tsx', 'utf8').replace(/\r\n/g, '\n');

/**
 * Source with comments stripped. Literal assertions run against this, so prose
 * *about* a legacy literal (this migration's own explanatory comment names the
 * dead black scrim) can neither satisfy nor trip them.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
const noop = (): void => {};
const channels: Channel[] = DEFAULT_PROJECT.channels;
const mixerTracks: MixerTrack[] = DEFAULT_PROJECT.mixerTracks;

/** The persisted identity colours the shipped rack defaults carry. */
const DATA_COLORS = ['#ff6e00', '#00ff88', '#00e5ff', '#a855f7', '#ffaa00'] as const;

const singleMacro: MasterMacroKnob[] = [{
  id: 'macro-solo',
  name: 'SOLO SWEEP',
  value: 0.75,
  color: '#00e5ff',
  mappings: [{ targetType: 'filter_cutoff', targetId: 3, min: 120, max: 9000, curve: 'logarithmic' }],
}];

interface RenderOverrides {
  macroKnobs?: MasterMacroKnob[];
  isOpen?: boolean;
}

const render = (mode: 'dark' | 'light', overrides: RenderOverrides = {}): string =>
  renderToStaticMarkup(
    React.createElement(
      'div',
      { 'data-theme': mode },
      React.createElement(MasterMacroRackModal, {
        isOpen: overrides.isOpen ?? true,
        onClose: noop,
        mixerTracks,
        channels,
        macroKnobs: overrides.macroKnobs,
        onUpdateMacros: noop,
      }),
    ),
  );

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

/** Any colour that cannot follow the theme: a literal, a fixed palette
    utility, or a Tailwind named-palette class. */
const UNTHEMED_CLASS =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to|via|fill|ring)-\[#|\b(?:text|bg|border|fill|ring)-(?:white|black)\b|bg-black(?:\/\d+)?\b|rgba?\(|\b(?:text|bg|border|ring)-(?:red|amber|green|gray|zinc|neutral|orange|yellow|emerald|cyan|violet|purple|slate)-\d/i;

/** Every rendered state: the union must carry no fixed chrome palette. */
const ALL_STATES: ReadonlyArray<[mode: 'dark' | 'light', overrides: RenderOverrides]> = [
  ['dark', {}],
  ['light', {}],
  ['dark', { macroKnobs: singleMacro }],
  ['light', { macroKnobs: singleMacro }],
  ['dark', { macroKnobs: [] }],
  ['light', { macroKnobs: [] }],
];

const includes = (haystack: string, needle: string, message: string): void =>
  assert.ok(haystack.includes(needle), `${message}\n  expected to find: ${needle}`);

describe('Master Macro Rack theme markup (UI-03M)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`renders the complete macro rack with semantic theme classes in ${mode}`, () => {
      const markup = render(mode);
      assert.match(markup, new RegExp(`data-theme="${mode}"`));
      includes(markup, 'id="fl-master-macro-modal"', 'the overlay keeps its id');
      includes(markup, 'role="dialog"', 'the overlay is a dialog');
      includes(markup, 'aria-modal="true"', 'the dialog is modal');
      includes(markup, 'aria-labelledby="fl-master-macro-modal-title"', 'the dialog is named by its title');
      includes(markup, 'MASTER MACRO PERFORMANCE RACK', 'the title text is unchanged');
      includes(markup, '>MULTI-TARGET MATRIX<', 'the identity badge renders');
      includes(
        markup,
        'Map single rotary macro controllers to multiple filter cutoffs, wet levels, and dynamic sweeps',
        'the subtitle is unchanged',
      );
      includes(markup, 'aria-label="Close macro rack"', 'the close control keeps its accessible name');
      includes(markup, '>Add Macro<', 'the add-macro action renders');
      includes(markup, 'Macro Automation Dispatcher Active', 'the footer note is unchanged');
      includes(markup, '>Done<', 'the footer action renders');

      // The four shipped knobs render, and the first is the selected one.
      for (const name of [
        'DROP BUILDUP (SWEEP)', 'SUB CRUSH &amp; TENSION',
        'SPACE &amp; STEREO WIDTH', 'LO-FI VINYL DUCK',
      ]) {
        includes(markup, name, `the ${name} knob renders`);
      }
      includes(markup, 'MAPPED DESTINATIONS FOR:', 'the matrix renders for the selected knob');
      // `targetType.replace('_', ' ')` only replaces the first underscore, and
      // the `uppercase` class does the casing, so the markup text stays lower.
      includes(markup, '>filter cutoff<', 'the selected knob’s first mapping target renders');
      includes(markup, '>reverb wet<', 'the selected knob’s second mapping target renders');
      includes(markup, 'font-bold text-[var(--apex-text)] uppercase', 'the target label keeps its uppercase treatment');
      includes(markup, '→ Track #1', 'the mapping target id is unchanged');
      includes(markup, 'MIN: <strong', 'the mapping range floor renders');
      includes(markup, 'MAX: <strong', 'the mapping range ceiling renders');
      includes(markup, '>exponential<', 'the curve chip renders the stored curve');
      includes(
        markup,
        'Controls all targets below proportionally with custom curves',
        'the matrix hint is unchanged',
      );

      // Four knob cards, each with a value arc, a range input and a read-out.
      const ranges = [...markup.matchAll(/<input[^>]*type="range"[^>]*>/g)].map((m) => m[0]);
      assert.equal(ranges.length, 4, 'one rotary range input per macro knob');
      for (const range of ranges) {
        assert.ok(range.includes('min="0"'), 'the knob range keeps its 0 floor');
        assert.ok(range.includes('max="1"'), 'the knob range keeps its 1 ceiling');
        assert.ok(range.includes('step="0.01"'), 'the knob range keeps its step');
      }
      const arcs = [...markup.matchAll(/stroke-dasharray="([^"]*)"/g)].map((m) => m[1]);
      assert.equal(arcs.length, 4, 'one value arc per macro knob');
      assert.deepEqual(arcs, ['20, 100', '50, 100', '35, 100', '10, 100'],
        'each arc reports its stored knob value');
    });
  }

  it('carries no fixed chrome palette in any rendered state of either theme', () => {
    for (const [mode, overrides] of ALL_STATES) {
      const offenders = classAttributes(render(mode, overrides))
        .filter((value) => UNTHEMED_CLASS.test(value));
      assert.deepEqual(offenders, [], `${mode} ${JSON.stringify(overrides)} renders an unthemed class`);
    }
  });

  it('uses existing semantic tokens for surfaces, text, borders, hover and insets', () => {
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
      '--apex-state-hover',
      '--apex-state-playing-fg',
    ]) {
      assert.ok(source.includes(`var(${token})`), `macro rack chrome consumes ${token}`);
    }
    assert.doesNotMatch(code, /bg-black/, 'the redundant dark overlay fill is gone');
  });

  it('keeps the rack’s green identity, the MAX ceiling and the curve chip meanings', () => {
    assert.match(source, /bg-\[var\(--apex-success\)\]/, 'the identity tile and CTAs use the success token');
    assert.match(
      source,
      /border-\[color-mix\(in_srgb,var\(--apex-success\)_40%,transparent\)\]/,
      'the panel border and badge edge keep a success wash',
    );
    assert.match(
      source,
      /bg-\[color-mix\(in_srgb,var\(--apex-success\)_20%,transparent\)\]/,
      'the identity badge keeps a success wash',
    );
    assert.match(source, /text-\[var\(--apex-success\)\]/, 'the MAX ceiling keeps its green meaning');
    assert.match(source, /text-\[var\(--apex-cyan-text\)\]/, 'the curve chip keeps its cyan read-out');
    assert.match(source, /var\(--apex-state-playing-fg\)/, 'filled controls use a theme-safe on-colour');
    assert.match(
      source,
      /hover:bg-\[color-mix\(in_srgb,var\(--apex-success\)_82%,var\(--apex-text\)\)\]/,
      'the green CTAs keep a themed hover step',
    );
  });

  it('preserves the persisted macro identity colour as data, and never as text', () => {
    // The arc stroke, the selected border, the range accent and the mapping
    // swatch all still read `macro.color` / `currentMacro.color` verbatim.
    assert.match(source, /stroke=\{macro\.color\}/, 'the value arc keeps the stored identity colour');
    assert.match(source, /accentColor: macro\.color/, 'the rotary slider keeps the stored identity colour');
    assert.match(
      source,
      /style=\{isSelected \? \{ borderColor: macro\.color \} : undefined\}/,
      'only the selected card paints the stored identity colour inline',
    );
    assert.match(
      code,
      /border-\[var\(--apex-border\)\] hover:border-\[var\(--apex-grid-line-strong\)\]/,
      'the idle card takes its border from tokens, so its hover lift actually paints',
    );
    assert.match(
      source,
      /backgroundColor: currentMacro\.color/,
      'the mapping swatch keeps the stored identity colour',
    );
    // …but no label is painted with it: `style={{ color: macro.color }}` is gone.
    assert.doesNotMatch(code, /color: macro\.color/, 'the knob label no longer paints the data colour as text');
    assert.doesNotMatch(code, /color: currentMacro\.color/, 'the matrix label no longer paints the data colour as text');
    // The defaults and the add-macro rotation keep the exact stored hues.
    for (const color of DATA_COLORS) {
      assert.ok(code.includes(`'${color}'`), `the persisted identity colour ${color} is unchanged`);
    }
    // Selection never depends on a data colour alone.
    assert.match(source, /ring-\[var\(--apex-accent-strong\)\]/, 'selection also carries a themed ring');
  });

  it('uses ModalFrame’s themed scrim and keeps the overlay geometry', () => {
    const markup = render('light');
    assert.match(
      markup,
      /class="apex-modal-overlay fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none"/,
      'the shared themed scrim replaces the dead bg-black/85 fill',
    );
  });

  it('keeps the knob publication and add-macro wiring intact', () => {
    assert.match(source, /const updated = macros\.map\(m => m\.id === id \? \{ \.\.\.m, value: val \} : m\);/,
      'a knob change maps only the edited knob');
    assert.match(source, /setMacros\(updated\);/, 'the knob change updates local state');
    assert.match(source, /if \(onUpdateMacros\) \{\n\s*onUpdateMacros\(updated\);/,
      'the knob change publishes the whole rack');
    assert.match(source, /id: `macro-\$\{Date\.now\(\)\}`/, 'a new macro keeps its generated id');
    assert.match(source, /name: `MACRO \$\{macros\.length \+ 1\} \(CUSTOM\)`/, 'a new macro keeps its generated name');
    assert.match(source, /value: 0\.5,\n\s*color: \[('#[0-9a-f]{6}', ){4}'#[0-9a-f]{6}'\]\[macros\.length % 5\]/,
      'a new macro keeps the stored identity-colour rotation');
    assert.match(source, /if \(onUpdateMacros\) onUpdateMacros\(updated\);/, 'adding a macro publishes the rack');
    assert.match(source, /setSelectedMacroId\(newMacro\.id\);/, 'adding a macro selects it');
    assert.match(
      source,
      /useState<MasterMacroKnob\[\]>\(macroKnobs\.length > 0 \? macroKnobs : DEFAULT_MACRO_KNOBS\)/,
      'an empty persisted rack still falls back to the shipped defaults',
    );
  });

  it('renders the fallback rack when the project stores no macro knobs', () => {
    for (const mode of ['dark', 'light'] as const) {
      const markup = render(mode, { macroKnobs: [] });
      includes(markup, 'DROP BUILDUP (SWEEP)', 'an empty persisted rack falls back to the shipped knobs');
      const ranges = [...markup.matchAll(/<input[^>]*type="range"[^>]*>/g)];
      assert.equal(ranges.length, 4, 'the fallback rack renders four knobs');
    }
  });

  it('renders a single stored knob without the matrix losing its target rows', () => {
    const markup = render('light', { macroKnobs: singleMacro });
    includes(markup, 'SOLO SWEEP', 'the stored knob renders');
    includes(markup, '>75<', 'the knob value read-out renders');
    includes(markup, '75%', 'the knob percentage renders');
    includes(markup, '>filter cutoff<', 'the single mapping renders');
    includes(markup, '1 MAPPINGS', 'the mapping count reflects the single stored mapping');
    includes(markup, '→ Track #3', 'the mapping target id renders');
    includes(markup, '>logarithmic<', 'the stored curve renders');
    includes(markup, 'MIN: <strong class="text-[var(--apex-text)]">120</strong>', 'the range floor is themed');
    includes(markup, 'MAX: <strong class="text-[var(--apex-success)]">9000</strong>', 'the range ceiling keeps its green meaning');
    includes(markup, 'stroke="#00e5ff"', 'the arc keeps the stored identity colour');
    includes(markup, 'style="accent-color:#00e5ff"', 'the slider keeps the stored identity colour');
  });

  it('renders nothing while closed', () => {
    const closed = renderToStaticMarkup(
      React.createElement(MasterMacroRackModal, {
        isOpen: false,
        onClose: noop,
        mixerTracks,
        channels,
        onUpdateMacros: noop,
      }),
    );
    assert.equal(closed, '');
  });
});
