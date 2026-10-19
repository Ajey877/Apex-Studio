/**
 * UI-03M — Multi-Zone Sampler theme contract.
 *
 * `MultiZoneSamplerModal` is DOM-rendered with no canvas, so every surface
 * follows the active palette through the existing `--apex-*` tokens. The
 * sampler's warm orange identity stays on `--apex-gold` (the mapping UI-03J and
 * UI-03K chose for Gross Beat and the Arpeggiator) and the root-pitch green
 * keeps its `--apex-success` meaning.
 *
 * `KeyZone.color` never reaches the project document: `commitZones` strips
 * `name` and `color` before publishing, and `SampleZone` has no colour field.
 * The four zone hues are therefore decorative chrome rather than stored data,
 * so they resolve through semantic tokens and are asserted here to be exactly
 * the four that clear WCAG 1.4.11 3:1 as a border on every surface they are
 * painted on, in both palettes.
 *
 * The zone hydration and every edit run inside `useEffect`/event handlers,
 * which `renderToStaticMarkup` does not execute. The rendered assertions below
 * therefore cover the chrome that is present on first paint (header, keymap
 * card, visualiser inset, piano-key strip, footer) in both themes, and the
 * zone blocks plus the inspector — which only exist after hydration or after
 * "Add Zone Split" — are pinned by scanning every `className` in the source.
 * Live Dark/Light resolution of those two regions is exercised in
 * browser-tests/multiZoneSamplerTheme.spec.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MultiZoneSamplerModal } from './MultiZoneSamplerModal';
import { DEFAULT_PROJECT } from '../audio/presets';
import type { Channel, CustomSampleData } from '../types/daw';

const source = readFileSync('src/components/MultiZoneSamplerModal.tsx', 'utf8').replace(/\r\n/g, '\n');

/** Source with comments stripped, so prose about a legacy literal cannot
    satisfy or trip a literal assertion. */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"])\/\/.*$/gm, '$1');

const noop = (): void => {};
const channels: Channel[] = DEFAULT_PROJECT.channels;

const library: CustomSampleData[] = [
  { id: 'sample-808', name: '808 Sub Kick', duration: 1.4, sampleRate: 44100, channels: 1, waveformPeaks: [0.2, 0.9, 0.4] },
  { id: 'sample-vox', name: 'Choir Aah', duration: 2.1, sampleRate: 44100, channels: 2, waveformPeaks: [0.3, 0.6] },
];

const render = (mode: 'dark' | 'light', sampleLibrary: CustomSampleData[] = []): string =>
  renderToStaticMarkup(
    React.createElement(
      'div',
      { 'data-theme': mode },
      React.createElement(MultiZoneSamplerModal, {
        isOpen: true,
        onClose: noop,
        channels,
        sampleLibrary,
        onUpdateChannel: noop,
      }),
    ),
  );

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

/** Any colour that cannot follow the theme: a literal, a fixed palette
    utility, or a Tailwind named-palette class. */
const UNTHEMED_CLASS =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to|via|fill|ring)-\[#|\b(?:text|bg|border|fill|ring)-(?:white|black)\b|bg-black(?:\/\d+)?\b|rgba?\(|\b(?:text|bg|border|ring|hover:text|hover:bg)-(?:red|amber|green|gray|zinc|neutral|orange|yellow|emerald|cyan|violet|purple|slate)-\d/i;

/** Every `className` in the source, including the branches that only render
    after zone hydration (the zone blocks and the inspector). */
const sourceClassNames = (text: string): string[] => {
  const out: string[] = [];
  for (const match of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  // The ternary branches inside a template className are covered by the raw
  // string above; the single-quoted literals inside them are matched too.
  for (const match of text.matchAll(/'([^']*(?:bg|text|border|ring|accent)-\[[^']*)'/g)) {
    out.push(match[1]);
  }
  return out;
};

const includes = (haystack: string, needle: string, message: string): void =>
  assert.ok(haystack.includes(needle), `${message}\n  expected to find: ${needle}`);

describe('Multi-Zone Sampler theme markup (UI-03M)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`renders the complete keymapper chrome with semantic theme classes in ${mode}`, () => {
      const markup = render(mode, library);
      assert.match(markup, new RegExp(`data-theme="${mode}"`));
      includes(markup, 'id="fl-multizone-sampler-modal"', 'the overlay keeps its id');
      includes(markup, 'role="dialog"', 'the overlay is a dialog');
      includes(markup, 'aria-modal="true"', 'the dialog is modal');
      includes(markup, 'aria-labelledby="fl-multizone-sampler-modal-title"', 'the dialog is named by its title');
      includes(markup, 'APEX MULTI-SAMPLE KEYMAPPER', 'the title text is unchanged');
      includes(markup, '>MULTI-ZONE<', 'the identity badge renders');
      includes(
        markup,
        'Map distinct audio samples across MIDI key ranges C0 - B8 with velocity splits',
        'the subtitle is unchanged',
      );
      includes(markup, 'aria-label="Close multi-zone sampler"', 'the close control keeps its accessible name');
      includes(markup, 'KEYBOARD SPLIT ZONE MAP (MIDI C1 - C7)', 'the keymap section renders');
      includes(markup, '>Add Zone Split<', 'the add-zone action renders');
      includes(
        markup,
        'Zone selection, tuning, trims and loop points are applied to playback',
        'the footer note is unchanged',
      );
      includes(markup, '>Apply Keymapping<', 'the footer action renders');

      // Eight octave lanes and a 48-key reference strip, both themed.
      const lanes = [...markup.matchAll(/>C(\d)</g)].map((m) => Number(m[1]));
      assert.deepEqual(lanes, [0, 1, 2, 3, 4, 5, 6, 7], 'the octave lane labels render');
      const keys = markup.match(/flex-1 border-r border-\[var\(--apex-border\)\]/g) ?? [];
      assert.equal(keys.length, 48, 'the reference piano strip renders all 48 keys');
      const accidentals = markup.match(/bg-\[var\(--apex-piano-key-accidental\)\]/g) ?? [];
      // 20 black keys in four octaves, plus the strip's own container background.
      assert.equal(accidentals.length, 21, 'the accidental keys use the themed piano token');
      const naturals = markup.match(/bg-\[var\(--apex-piano-key-natural\)\]/g) ?? [];
      assert.equal(naturals.length, 28, 'the natural keys use the themed piano token');

      // No zone is hydrated on first paint, so no inspector renders yet.
      assert.ok(!markup.includes('EDITING ZONE:'), 'the inspector waits for zone hydration');
    });
  }

  it('carries no fixed palette in any rendered class of either theme', () => {
    for (const mode of ['dark', 'light'] as const) {
      for (const lib of [[], library]) {
        const offenders = classAttributes(render(mode, lib))
          .filter((value) => UNTHEMED_CLASS.test(value));
        assert.deepEqual(offenders, [], `${mode} renders an unthemed class`);
      }
    }
  });

  it('carries no fixed palette in any className in the source, including the post-hydration branches', () => {
    const names = sourceClassNames(code);
    assert.ok(names.length > 40, `expected the full class surface, found ${names.length}`);
    const offenders = names.filter((value) => UNTHEMED_CLASS.test(value));
    assert.deepEqual(offenders, [], 'a className in the source still carries a fixed palette');
    assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/, 'no hex literal remains in the component code');
    assert.doesNotMatch(code, /rgba?\(/, 'no rgb()/rgba() literal remains in the component code');
    assert.doesNotMatch(code, /bg-black/, 'the redundant dark overlay fill is gone');
  });

  it('uses existing semantic tokens for surfaces, text, borders, hover and insets', () => {
    for (const token of [
      '--apex-surface',
      '--apex-surface-2',
      '--apex-surface-3',
      '--apex-panel-header',
      '--apex-chrome-inset',
      '--apex-canvas',
      '--apex-border',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-state-hover',
      '--apex-state-playing-fg',
      '--apex-piano-key-natural',
      '--apex-piano-key-accidental',
    ]) {
      assert.ok(code.includes(`var(${token})`), `multi-zone chrome consumes ${token}`);
    }
  });

  it('keeps the orange sampler identity, the root-pitch green and the destructive red meanings', () => {
    assert.match(code, /bg-\[var\(--apex-gold\)\]/, 'the identity tile and CTAs use the shared gold token');
    assert.match(
      code,
      /border-\[color-mix\(in_srgb,var\(--apex-gold\)_40%,transparent\)\]/,
      'the panel border and badge edge keep a gold wash',
    );
    assert.match(
      code,
      /bg-\[color-mix\(in_srgb,var\(--apex-gold\)_20%,transparent\)\]/,
      'the identity badge keeps a gold wash',
    );
    assert.match(code, /accent-\[var\(--apex-gold\)\]/, 'the key-range sliders keep the gold accent');
    assert.match(code, /text-\[var\(--apex-success\)\]/, 'the root-pitch read-out keeps its green meaning');
    assert.match(code, /accent-\[var\(--apex-success\)\]/, 'the root-pitch slider keeps the green accent');
    assert.match(code, /hover:text-\[var\(--apex-danger\)\]/, 'the destructive delete keeps its red meaning');
    assert.match(code, /var\(--apex-state-playing-fg\)/, 'filled controls use a theme-safe on-colour');
    assert.match(code, /ring-\[var\(--apex-accent-strong\)\]/, 'zone selection carries a themed ring');
    assert.match(
      code,
      /hover:bg-\[color-mix\(in_srgb,var\(--apex-gold\)_86%,var\(--apex-text\)\)\]/,
      'the gold CTAs keep a themed hover step',
    );
  });

  it('themes the zone identity palette and keeps it out of the project document', () => {
    includes(code, "const ZONE_IDENTITY_COLORS = [", 'the zone palette is a named constant');
    for (const token of ['--apex-gold', '--apex-success', '--apex-cyan-text', '--apex-aux-text']) {
      assert.ok(
        code.includes(`'var(${token})'`),
        `the zone palette resolves ${token} through a token reference`,
      );
    }
    assert.match(code, /color: ZONE_IDENTITY_COLORS\[index % ZONE_IDENTITY_COLORS\.length\]/,
      'hydrated zones take the palette by index');
    assert.match(code, /color: ZONE_IDENTITY_COLORS\[0\]/, 'the derived single zone takes the first hue');
    assert.match(code, /color: ZONE_IDENTITY_COLORS\[3\]/, 'a new zone takes the fourth hue');
    // The palette is decoration: it is stripped before anything is published.
    assert.match(code, /onUpdateChannel\(selectedChannel\.id, \{ sampleZones: updated\.map\(\(\{ name, color, \.\.\.zone \}\) => zone\) \}\)/,
      'publishing strips the local name and colour');
    assert.match(code, /\(\(\(\{ name, color, \.\.\.z \}\) => z\)\(zone\)\)/,
      'the derived-zone publish also strips the local name and colour');
    // The zone fill is a theme-relative wash, not a hex-alpha suffix.
    assert.match(code, /backgroundColor: `color-mix\(in srgb, \$\{zone\.color\} 22%, transparent\)`/,
      'the zone block fill is a token wash');
    assert.match(code, /borderColor: zone\.color/, 'the zone block border keeps the zone hue');
  });

  it('uses ModalFrame’s themed scrim and keeps the overlay geometry', () => {
    const markup = render('light');
    assert.match(
      markup,
      /class="apex-modal-overlay fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none"/,
      'the shared themed scrim replaces the dead black fill',
    );
  });

  it('names every icon-only control', () => {
    includes(code, 'aria-label="Close multi-zone sampler"', 'the close control is named');
    assert.match(code, /aria-label=\{`Delete zone \$\{selectedZone\.name\}`\}/,
      'the icon-only delete control gained an accessible name');
    includes(code, 'aria-label="Dismiss status message"', 'the toast dismiss control is named');
    // The \u2715 is text, so it needs 4.5:1 on the gold fill. A washed idle glyph
    // (78% of the on-colour) measures 3.92:1 in Light; full opacity measures
    // 11.23:1 Dark and 5.33:1 Light, matching WavetableSynthModal and
    // AudioSlicerModal.
    includes(
      code,
      'className="text-[var(--apex-state-playing-fg)] hover:text-[var(--apex-state-playing-fg)]"',
      'the toast dismiss glyph is the full on-colour in both states',
    );
    assert.doesNotMatch(
      code,
      /color-mix\(in_srgb,var\(--apex-state-playing-fg\)_\d+%,transparent\)/,
      'the on-colour is never washed below AA',
    );
  });

  it('keeps zone editing, audition and persistence wiring intact', () => {
    assert.match(code, /const persisted = selectedChannel\.sampleZones \|\| \[\];/,
      'hydration reads the persisted zones first');
    assert.match(code, /\} else if \(selectedChannel\.customSample\?\.id\) \{/,
      'a channel sample with no zones still derives one full-range zone');
    assert.match(code, /rootNote: selectedChannel\.customSample\.rootPitch \?\? 60/,
      'the derived zone keeps the stored root pitch');
    assert.match(code, /onUpdateChannel\(selectedChannel\.id, \{ sampleZones:/,
      'every zone edit publishes through onUpdateChannel');
    assert.match(code, /if \(zones\.length <= 1\) return;/,
      'the last zone cannot be deleted');
    assert.match(code, /audioEngine\.playNote\(targetChannel, \{ id: `zone-aud-\$\{Date\.now\(\)\}`, pitch: zone\.rootNote, start: 0, duration: 2, velocity: 0\.9 \}\);/,
      'audition still plays the zone root through the real engine');
    assert.match(code, /lowNote: Number\(e\.target\.value\)/, 'the low-key slider still writes lowNote');
    assert.match(code, /highNote: Number\(e\.target\.value\)/, 'the high-key slider still writes highNote');
    assert.match(code, /rootNote: Number\(e\.target\.value\)/, 'the root slider still writes rootNote');
    assert.match(code, /sampleId: e\.target\.value/, 'the sample selector still writes sampleId');
    assert.match(code, /name: e\.target\.value/, 'the zone-name field still writes name');
    // The range constraints are unchanged, so the keymap math is untouched.
    // These live in the inspector, which only renders after hydration, so they
    // are pinned on the source rather than on first-paint markup.
    assert.match(source, /min="0"\n\s*max=\{selectedZone\.highNote\}/, 'the low key keeps its MIDI floor and stays clamped below the high key');
    assert.match(source, /min=\{selectedZone\.lowNote\}\n\s*max="127"/, 'the high key keeps the 0-127 ceiling');
    assert.match(source, /min=\{selectedZone\.lowNote\}\n\s*max=\{selectedZone\.highNote\}\n\s*value=\{selectedZone\.rootNote\}/,
      'the root pitch stays clamped inside the zone range');
  });

  it('renders nothing while closed', () => {
    const closed = renderToStaticMarkup(
      React.createElement(MultiZoneSamplerModal, {
        isOpen: false,
        onClose: noop,
        channels,
        sampleLibrary: library,
        onUpdateChannel: noop,
      }),
    );
    assert.equal(closed, '');
  });
});
