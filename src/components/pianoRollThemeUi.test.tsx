/**
 * UI-03P — Piano Roll residual theme migration.
 *
 * The Piano Roll was already tokenised by UI-04 (147 `--apex-*` uses) and kept
 * exactly five literal chrome surfaces: four outline-only toolbar controls and
 * the note-resize handles. The tool controls repeated the defect UI-03O recorded
 * for other tool surfaces — a raw hue used as *text and border* on a light
 * surface (`#00bcd4` on white = 1.9:1, `#ff9800` = 2.1:1, `#2ecc71` = 1.9:1) —
 * and the handle overlays were raw black washes, which read as no feedback at all
 * on the Dark palette.
 *
 * Migrated:
 *
 *   - Strum / Import .mid  `border-[#00bcd4]/30`   → cyan 30 % `color-mix`
 *   - Extract 808 Bass     `border-[#ff9800]/40`   → gold 40 % `color-mix`
 *   - Ghost / Export .mid  `border-[#2ecc71]/40|30` → success 40 % / 30 % `color-mix`
 *   - resize hover         `hover:bg-black/20`     → playing-fg 20 % `color-mix`
 *   - resize grip          `bg-black/40`           → playing-fg 40 % `color-mix`
 *
 * `--apex-state-playing-fg` is the theme's “ink that sits on a bright fill”, so
 * the handle overlay darkens the note in Dark and lightens it in Light — one
 * expression, correct in both palettes. The Ghost control already used
 * `text-[var(--apex-success)]`, so this only brings its border home.
 *
 * One measured defect the migration was required to fix: the cyan toolbar labels
 * used the *decorative* `--apex-cyan`, which is 4.30:1 on the Light toolbar
 * surface (`#087da8` on `#f4f6fa`) — below AA for 10 px text. They now use
 * `--apex-cyan-text`, the text variant the theme already declares for exactly
 * this case (identical to `--apex-cyan` in Dark, darker in Light: 7.39:1).
 * The rejected pairing is pinned below so the suite cannot regress into it.
 *
 * Preserved (project data, not chrome): every channel-identity hue in the note
 * fills, the velocity ramp and the channel dot — these are stored on the channel
 * and painted verbatim (UI-03A §“Explicitly preserved”).
 *
 * Live pixels in both palettes are measured in `browser-tests/pianoRollTheme.spec.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PianoRoll } from './PianoRoll';
import { DEFAULT_PROJECT } from '../audio/presets';
import { DARK_TOKENS, LIGHT_TOKENS, hexToRgb } from './themeTestDocument';

const noop = (): void => {};

const render = (): string =>
  renderToStaticMarkup(
    React.createElement(PianoRoll, {
      channel: DEFAULT_PROJECT.channels[1],
      allChannels: DEFAULT_PROJECT.channels,
      onSelectChannel: noop,
      onUpdateChannel: noop,
      currentStep: 0,
      isPlaying: false,
      bpm: DEFAULT_PROJECT.meta.bpm,
      onCreateChannelFromMidiImport: () => 'ch-new',
      patternLengthSteps: 32
    })
  );

const source = readFileSync('src/components/PianoRoll.tsx', 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

/**
 * A concrete colour, an arbitrary `[#…]` utility, a white/black utility, a raw
 * `rgb()`/`rgba()`, or a Tailwind palette class — applied per whitespace token.
 */
const COLOUR_TOKEN =
  /#[0-9a-f]{3,8}\b|\[#|(?:text|bg|border|divide|ring|from|to|placeholder|accent|fill|stroke)-(?:white|black)\b|rgba?\(|(?:text|bg|border|divide|ring|fill|stroke|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]/i;

/** Channel-identity hues: stored on the channel, painted verbatim. */
const DATA_HUES = new Set(DEFAULT_PROJECT.channels.map((channel) => channel.color.toLowerCase()));

const luminance = ([r, g, b]: [number, number, number]): number => {
  const channel = (input: number): number => {
    const v = input / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (foreground: string, background: string): number => {
  const first = luminance(hexToRgb(foreground));
  const second = luminance(hexToRgb(background));
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

describe('Piano Roll residual theme migration (UI-03P)', () => {
  it('renders the editor toolbar, the channel selector and the note grid', () => {
    const markup = render();
    for (const label of [
      'Strum Chords',
      'Extract 808 Bass',
      'Ghost',
      'Velocities',
      'Humanize',
      'Import .mid',
      'Export .mid',
      'Clear all notes'
    ]) {
      assert.ok(markup.includes(label), `expected the toolbar to render ${label}`);
    }
    assert.match(markup, /id="piano-roll-container"/);
    assert.match(markup, /accept="\.mid,\.midi"/);
    assert.match(markup, /aria-label="Resize note start"/);
    assert.match(markup, /aria-label="Resize note end"/);
  });

  it('leaves no colour literal in a class attribute, and none in the source outside the data hues', () => {
    const offenders: string[] = [];
    for (const value of classAttributes(render())) {
      for (const token of value.split(/\s+/)) {
        if (!COLOUR_TOKEN.test(token)) continue;
        const hue = token.match(/#[0-9a-f]{3,8}/i);
        if (hue && ([...DATA_HUES] as string[]).includes(hue[0].toLowerCase())) continue;
        offenders.push(token);
      }
    }
    assert.deepEqual(offenders, []);
    // The five migrated expressions are gone as literals.
    assert.equal(/\[#00bcd4\]|\[#ff9800\]|\[#2ecc71\]|bg-black\/20|bg-black\/40/.test(code), false);
  });

  it('the four toolbar outlines now resolve through the shared status tokens', () => {
    assert.equal(
      (code.match(/border-\[color-mix\(in_srgb,var\(--apex-cyan\)_30%,transparent\)\]/g) ?? []).length,
      2,
      'Strum Chords and Import .mid share the cyan outline'
    );
    assert.equal(
      (code.match(/border-\[color-mix\(in_srgb,var\(--apex-gold\)_40%,transparent\)\]/g) ?? []).length,
      1,
      'Extract 808 Bass uses the gold outline'
    );
    assert.equal(
      (code.match(/border-\[color-mix\(in_srgb,var\(--apex-success\)_(?:40|30)%,transparent\)\]/g) ?? []).length,
      2,
      'Ghost and Export .mid share the success outline'
    );
    // The labels use the *text* variant of the cyan token, not the decorative one.
    assert.equal((code.match(/text-\[var\(--apex-cyan\)\]/g) ?? []).length, 0);
    assert.equal((code.match(/text-\[var\(--apex-cyan-text\)\]/g) ?? []).length, 3, 'STAMP, Strum Chords and Import .mid');
    assert.match(code, /text-\[var\(--apex-gold\)\]/, 'the Extract 808 Bass label');
    assert.match(code, /text-\[var\(--apex-success\)\]/, 'the Ghost label');
  });

  it('the note-resize handles use the theme ink so the overlay works on both palettes', () => {
    assert.equal(
      (code.match(/hover:bg-\[color-mix\(in_srgb,var\(--apex-state-playing-fg\)_20%,transparent\)\]/g) ?? []).length,
      2,
      'both handle hovers'
    );
    assert.match(code, /bg-\[color-mix\(in_srgb,var\(--apex-state-playing-fg\)_40%,transparent\)\]/, 'the grip');
    // Three mixes total — two hovers and the grip — and no other new ones.
    assert.equal((code.match(/var\(--apex-state-playing-fg\)_/g) ?? []).length, 3);
    // Both handles keep the separator role they are announced with.
    assert.equal((code.match(/aria-label="Resize note (?:start|end)"/g) ?? []).length, 2);
  });

  it('keeps the editor behaviour and the channel-identity data untouched', () => {
    for (const seam of [
      /const handleStrumNotes/,
      /const handleExtractBassline/,
      /const handleHumanizeVelocities/,
      /const handleQuantizeNotes/,
      /const handleClearAllNotes/,
      /const handleImportMidi/,
      /const handleExportMidi/,
      /const handleVelocityChange/,
      /midiNoteToName|getNoteName/,
      /channel\.color/
    ]) {
      assert.match(code, seam);
    }
    // The channel dot is painted from the stored hue, in the markup.
    const markup = render();
    assert.match(markup, /background-color:#ff(?:c107|5722|[0-9a-f]{4})/i);
  });

  it('clears AA in both palettes, and the rejected pairing is pinned', () => {
    for (const [mode, tokens] of [['dark', DARK_TOKENS], ['light', LIGHT_TOKENS]] as const) {
      const surface = tokens['--apex-surface-2'];
      const step = (label: string, fg: string, floor = 4.5): void => {
        const measured = contrastRatio(fg, surface);
        assert.ok(measured >= floor, `${mode}: ${label} = ${measured.toFixed(2)}:1 (floor ${floor})`);
      };
      step('the cyan text label', tokens['--apex-cyan-text']);
      step('the gold label', tokens['--apex-gold']);
      step('the success label', tokens['--apex-success']);
      step('the Ghost label on its active surface-3 fill', tokens['--apex-success'], 4.5);
    }

    // The defect this batch measured and fixed: the decorative cyan on the Light
    // toolbar surface is below AA, which is why the labels moved to the text
    // variant. Both the raw literal and the token it replaced are pinned.
    for (const rejected of ['#00bcd4', LIGHT_TOKENS['--apex-cyan']]) {
      const measured = contrastRatio(rejected, LIGHT_TOKENS['--apex-surface-2']);
      assert.ok(measured < 4.5, `${rejected} on the light toolbar must be shown to fail (${measured.toFixed(2)}:1)`);
    }
    assert.ok(
      contrastRatio(LIGHT_TOKENS['--apex-cyan-text'], LIGHT_TOKENS['--apex-surface-2']) >= 4.5,
      'the adopted text token clears AA'
    );
    // The three scanned literals are all below AA on the Light toolbar too.
    for (const literal of ['#00bcd4', '#ff9800', '#2ecc71']) {
      const measured = contrastRatio(literal, LIGHT_TOKENS['--apex-surface-2']);
      assert.ok(measured < 4.5, `${literal} as text on the light toolbar must fail (${measured.toFixed(2)}:1)`);
    }
  });
});
