/**
 * UI-03N — Sidechain Routing theme contract.
 *
 * `SidechainRoutingModal` is DOM-rendered with no canvas, so every chrome
 * surface follows the active palette through the existing `--apex-*` tokens;
 * no palette seam or theme observer is required.
 *
 * Three colour families are deliberately treated differently:
 *
 *   - **Chrome** (panel, header/footer bands, flow card, select cards,
 *     parameter cards, borders, hover, close) resolves through semantic tokens.
 *   - **Identity and read-out colours are the modal's audio-state vocabulary**:
 *     the amber matrix identity stays on `--apex-gold`, the destination/ducked
 *     read-out keeps cyan on `--apex-cyan-text`, the attack and ducking-depth
 *     read-outs keep green on `--apex-success`, and the preview meter keeps its
 *     VU-style green → amber → red gradient through `--apex-success`,
 *     `--apex-gold` and `--apex-danger`.
 *   - **The audition note's `color: '#ff6e00'` is data for `audioEngine.playNote`**
 *     (the same category UI-03A explicitly preserves for `ch.color` and
 *     `PAD_COLORS`), so it survives the migration byte-for-byte.
 *
 * The Phase 79 routing semantics — note-triggered (no level detector) and the
 * exact `SidechainSettings` payload the engine consumes — are owned by the
 * engine suites; this file pins the presentation contract plus the wiring the
 * modal itself owns.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SidechainRoutingModal } from './SidechainRoutingModal';
import { DEFAULT_PROJECT } from '../audio/presets';
import type { MixerTrack } from '../types/daw';

const source = readFileSync('src/components/SidechainRoutingModal.tsx', 'utf8');

/**
 * Source with comments stripped. Literal assertions run against this, so prose
 * *about* a legacy literal (this migration's own explanatory comment names the
 * dead black scrim) can neither satisfy nor trip them.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
const noop = (): void => {};
const mixerTracks: MixerTrack[] = DEFAULT_PROJECT.mixerTracks;

const countOf = (haystack: string, needle: string): number => {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
};

const render = (mode: 'dark' | 'light', overrides: { isOpen?: boolean } = {}): string =>
  renderToStaticMarkup(
    React.createElement(
      'div',
      { 'data-theme': mode },
      React.createElement(SidechainRoutingModal, {
        isOpen: overrides.isOpen ?? true,
        onClose: noop,
        mixerTracks,
        onUpdateMixerTracks: noop,
      }),
    ),
  );

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

/** Any colour that cannot follow the theme: a literal, a fixed palette
    utility, or a Tailwind named-palette class. */
const UNTHEMED_CLASS =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|accent|from|to|via|fill|ring)-\[#|\b(?:text|bg|border|fill|ring)-(?:white|black)\b|bg-black(?:\/\d+)?\b|rgba?\(|\b(?:text|bg|border|ring)-(?:red|amber|green|gray|zinc|neutral|orange|yellow|emerald|cyan|violet|purple|slate)-\d/i;

const includes = (haystack: string, needle: string, message: string): void =>
  assert.ok(haystack.includes(needle), `${message}\n  expected to find: ${needle}`);

describe('Sidechain Routing theme markup (UI-03N)', () => {
  for (const mode of ['dark', 'light'] as const) {
    it(`renders the complete routing matrix with semantic theme classes in ${mode}`, () => {
      const markup = render(mode);
      assert.match(markup, new RegExp(`data-theme="${mode}"`));
      includes(markup, 'id="fl-sidechain-routing-modal"', 'the overlay keeps its id');
      includes(markup, 'role="dialog"', 'the overlay is a dialog');
      includes(markup, 'aria-modal="true"', 'the dialog is modal');
      includes(markup, 'aria-labelledby="fl-sidechain-routing-modal-title"', 'the dialog is named by its title');
      includes(markup, 'DYNAMIC SIDECHAIN DUCKING &amp; MODULATION MATRIX', 'the title text is unchanged');
      includes(markup, '>PEAK DUCK DSP<', 'the identity badge renders');
      includes(
        markup,
        'Route trigger tracks (Kick / Snare) to dynamically compress frequency bands on destination tracks (808 / Synths)',
        'the subtitle is unchanged',
      );
      includes(markup, 'aria-label="Close sidechain routing"', 'the close control keeps its accessible name');
      includes(markup, '>Audition Pump<', 'the audition action renders');
      includes(markup, 'SIDECHAIN TRIGGER SOURCE', 'the source card label is unchanged');
      includes(markup, 'TARGET DESTINATION (DUCKED)', 'the destination card label is unchanged');
      includes(markup, 'Notes on this track trigger the ducking envelope (no level detector)', 'the source note is unchanged');
      includes(markup, 'Volume on this track will be ducked when trigger hits', 'the destination note is unchanged');
      includes(markup, 'preview ~0.0 dB', 'the static preview read-out renders at its initial 0 dB');
      includes(markup, '>visual preview<', 'the meter disclaimer is unchanged');
      includes(markup, 'Ducking is triggered by notes on the source track (no level detector)', 'the footer note is unchanged');
      includes(markup, '>Apply Sidechain Matrix<', 'the apply action renders');

      // Eight default mixer tracks, both selects open on the shipped defaults
      // (source track 1 = Kick / 808, destination track 2 = Snares & Claps).
      // React's static markup marks the chosen option with `selected=""`.
      assert.equal(countOf(markup, '<select'), 2, 'source and destination selects render');
      assert.equal(countOf(markup, '<option'), 16, 'each select lists all eight tracks');
      includes(markup, '<option value="1" selected="">Track #1: Kick / 808</option>', 'the source select opens on track 1');
      includes(markup, '<option value="2" selected="">Track #2: Snares &amp; Claps</option>', 'the destination select opens on track 2');

      // The three Phase-79 parameter cards keep their exact ranges and read-outs.
      const ranges = [...markup.matchAll(/<input[^>]*type="range"[^>]*>/g)].map((m) => m[0]);
      assert.equal(ranges.length, 3, 'exactly the three implemented parameters render as sliders');
      assert.ok(ranges[0].includes('min="0"') && ranges[0].includes('max="1"') && ranges[0].includes('step="0.01"'), 'the ducking-depth range is unchanged');
      assert.ok(ranges[1].includes('min="1"') && ranges[1].includes('max="50"'), 'the attack range is unchanged');
      assert.ok(ranges[2].includes('min="20"') && ranges[2].includes('max="500"'), 'the release range is unchanged');
      includes(markup, '>85%<', 'the ducking depth read-out renders');
      includes(markup, '>5 ms<', 'the attack read-out renders');
      includes(markup, '>120 ms<', 'the release read-out renders');
    });
  }

  it('carries no fixed chrome palette in any rendered state of either theme', () => {
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
      '--apex-grid-line-strong',
      '--apex-text',
      '--apex-text-2',
      '--apex-text-3',
      '--apex-state-hover',
      '--apex-state-playing-fg',
    ]) {
      assert.ok(source.includes(`var(${token})`), `sidechain chrome consumes ${token}`);
    }
    assert.doesNotMatch(code, /bg-black/, 'the redundant dark overlay fill is gone');
  });

  it('keeps the amber identity, the cyan destination read-out and the VU meter meanings', () => {
    assert.match(source, /bg-\[var\(--apex-gold\)\]/, 'the identity tile and CTAs use the gold token');
    assert.match(
      source,
      /border-\[color-mix\(in_srgb,var\(--apex-gold\)_40%,transparent\)\]/,
      'the panel border and badge edge keep a gold wash',
    );
    assert.match(
      source,
      /bg-\[color-mix\(in_srgb,var\(--apex-gold\)_20%,transparent\)\]/,
      'the identity badge keeps a gold wash',
    );
    assert.match(source, /text-\[var\(--apex-gold\)\]/, 'the source label and meter read-out keep the amber meaning');
    assert.match(source, /text-\[var\(--apex-cyan-text\)\]/, 'the destination label and release read-out keep their cyan meaning');
    assert.match(source, /text-\[var\(--apex-success\)\]/, 'the attack read-out keeps its green meaning');
    assert.match(
      source,
      /bg-gradient-to-r from-\[var\(--apex-success\)\] via-\[var\(--apex-gold\)\] to-\[var\(--apex-danger\)\]/,
      'the preview meter keeps its green → amber → red audio-state gradient',
    );
    assert.match(source, /var\(--apex-state-playing-fg\)/, 'filled controls use a theme-safe on-colour');
    assert.match(
      source,
      /hover:bg-\[color-mix\(in_srgb,var\(--apex-gold\)_86%,var\(--apex-text\)\)\]/,
      'the gold CTAs keep a themed hover step',
    );
  });

  it('keeps the audition note data colour as data, not as a UI literal', () => {
    assert.equal(countOf(code, "color: '#ff6e00'"), 1, 'the playNote call keeps the stored note colour exactly once');
    assert.match(code, /instrumentType: 'sub_808'/, 'the audition keeps its 808 instrument');
    assert.match(code, /mixerTrackId: selectedDestTrackId/, 'the audition routes to the selected destination track');
  });

  it('uses ModalFrame’s themed scrim and keeps the overlay geometry', () => {
    const markup = render('light');
    assert.match(
      markup,
      /class="apex-modal-overlay fixed inset-0 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none"/,
      'the shared themed scrim replaces the dead bg-black/85 fill',
    );
  });

  it('keeps the note-triggered routing truth and the Phase 79 payload intact', () => {
    for (const phrase of ['no level detector', 'note-triggered']) {
      assert.ok(source.includes(phrase), `the truth wording "${phrase}" survives`);
    }
    assert.doesNotMatch(code, /lookahead/i, 'no lookahead claim is reintroduced');
    // The engine consumes exactly these five fields — the deprecated
    // threshold/lowFreqOnly/highPassFilterHz fields must not be emitted.
    assert.match(
      code,
      /const sidechain: SidechainSettings = \{\s*enabled: isEnabled,\s*sourceTrackId,\s*amount: duckAmount,\s*attackMs,\s*releaseMs,\s*\};/,
      'handleApplyRouting emits exactly the five engine-consumed fields',
    );
    assert.match(code, /if \(t\.id === selectedDestTrackId\)/, 'only the destination track receives the sidechain settings');
    assert.match(code, /onUpdateMixerTracks\(updated\);/, 'the routing matrix publishes through the project mutation');
    assert.match(
      code,
      /setStatusMessage\(`Applied Sidechain Ducking to \$\{destTrack\.name\} \(Source: \$\{sourceTrack\.name\}\)`\);/,
      'the apply toast keeps its exact wording',
    );
    assert.match(code, /setStatusMessage\('Auditioning Sidechain Ducking Envelope\.\.\.'\);/, 'the audition toast keeps its exact wording');
  });

  it('keeps the meter animation and the inert forward-compat state unrendered', () => {
    assert.match(
      code,
      /if \(!isOpen \|\| !isEnabled\) return;/,
      'the meter interval only runs while open and enabled',
    );
    assert.match(
      code,
      /const pulse = \(Math\.sin\(now \/ 150\) \+ 1\) \/ 2;\s*setMeterReduction\(pulse \* duckAmount \* 18\);/,
      'the simulated kick pulse keeps its waveform and 18 dB ceiling',
    );
    for (const inert of ['thresholdDb', 'lowFreqOnly', 'highPassFilterHz']) {
      assert.ok(code.includes(inert), `the inert ${inert} state is preserved for Phase 88`);
    }
    const markup = render('light');
    assert.doesNotMatch(markup, /THRESHOLD|LOW FREQ|HIGH PASS/i, 'the inert parameters are not presented as controls');
  });

  it('renders nothing while closed', () => {
    const closed = renderToStaticMarkup(
      React.createElement(SidechainRoutingModal, {
        isOpen: false,
        onClose: noop,
        mixerTracks,
        onUpdateMixerTracks: noop,
      }),
    );
    assert.equal(closed, '');
  });
});
