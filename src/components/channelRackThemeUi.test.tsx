/**
 * UI-03P — Channel Rack residual theme migration.
 *
 * The rack was already tokenised (174 `--apex-*` uses); its last chrome literals
 * were the two per-row action hovers, `hover:text-red-400` on **CLR** and on the
 * delete control. Tailwind's `red-400` is not a theme token: it stayed the same
 * red in Light, ignored the palette's own danger hue, and was not the colour the
 * rest of the app uses for a destructive hover. Both now resolve through
 * `--apex-danger` (#ff5f6d Dark / #bd2638 Light), the same token the delete
 * affordances elsewhere already use — so this only unifies an existing meaning.
 *
 * The rack's remaining colour literals are channel-identity data: the colour each
 * `Channel` stores (`#ff5722`…`#9c27b0`), painted verbatim as the selector dot,
 * the step-cell accents and the mixer-strip stripe. UI-03A §“Explicitly
 * preserved” keeps those as project data, and they are pinned here by set so the
 * allowance cannot quietly grow.
 *
 * Live pixels and the hover state are measured in
 * `browser-tests/channelRackTheme.spec.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChannelRack } from './ChannelRack';
import { DEFAULT_PROJECT } from '../audio/presets';
import { DARK_TOKENS, LIGHT_TOKENS, hexToRgb } from './themeTestDocument';

const noop = (): void => {};

const render = (): string =>
  renderToStaticMarkup(
    React.createElement(ChannelRack, {
      channels: DEFAULT_PROJECT.channels,
      patterns: DEFAULT_PROJECT.patterns,
      selectedPatternId: DEFAULT_PROJECT.patterns[0].id,
      onSelectPattern: noop,
      onAddPattern: noop,
      onUpdatePatternLength: noop,
      selectedChannelId: DEFAULT_PROJECT.channels[0].id,
      onSelectChannel: noop,
      onUpdateChannel: noop,
      onAddChannel: noop,
      onDeleteChannel: noop,
      onOpenPianoRoll: noop,
      onOpenInstrument: noop,
      currentStep: 0,
      isPlaying: false,
      swing: 0,
      onUpdateSwing: noop
    })
  );

const source = readFileSync('src/components/ChannelRack.tsx', 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

const COLOUR_TOKEN =
  /#[0-9a-f]{3,8}\b|\[#|(?:text|bg|border|divide|ring|from|to|placeholder|accent|fill|stroke)-(?:white|black)\b|rgba?\(|(?:text|bg|border|divide|ring|fill|stroke|accent)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]/i;

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

describe('Channel Rack residual theme migration (UI-03P)', () => {
  it('renders the rack with every channel row and the pattern lane', () => {
    const markup = render();
    assert.match(markup, /id="fl-channel-rack"/);
    assert.equal((markup.match(/id="channel-row-/g) ?? []).length, DEFAULT_PROJECT.channels.length);
    assert.match(markup, /title="Clear steps"/);
    assert.match(markup, /SWING/);
    for (const channel of DEFAULT_PROJECT.channels) {
      assert.ok(markup.includes(channel.name), `expected the row for ${channel.name}`);
    }
  });

  it('the destructive hovers resolve through the danger token, not a Tailwind palette class', () => {
    assert.equal(/hover:text-red-400|text-red-400/.test(code), false);
    assert.equal(
      (code.match(/hover:text-\[var\(--apex-danger\)\]/g) ?? []).length,
      2,
      'CLR and delete share the danger hover'
    );
    assert.match(code, /title="Clear steps"/);
    assert.match(code, /disabled=\{channels\.length <= 1\}/);
    assert.match(code, /'Cannot delete the last channel'/);
  });

  it('leaves no colour literal in a class attribute outside the channel-identity hues', () => {
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
  });

  it('keeps the channel-identity hues as stored data', () => {
    // Every channel colour in the fixture reaches the markup as an inline paint.
    const markup = render();
    for (const channel of DEFAULT_PROJECT.channels) {
      assert.ok(
        markup.toLowerCase().includes(channel.color.toLowerCase()),
        `expected ${channel.color} (${channel.name}) to be painted`
      );
    }
    assert.match(code, /ch\.color/);
  });

  it('keeps the rack behaviour the migration must not touch', () => {
    for (const seam of [
      /onUpdateChannel\(ch\.id, \{ mute: !ch\.mute \}\)/,
      /onDeleteChannel\(ch\.id\)/,
      /onOpenPianoRoll\(ch\.id\)/,
      /onOpenInstrument\(ch\.id\)/,
      /onUpdateSwing/,
      /id="fl-channel-rack"/,
      /id=\{`channel-row-\$\{ch\.id\}`\}/
    ]) {
      assert.match(code, seam);
    }
  });

  it('the danger hover clears AA on the row surface in both palettes', () => {
    /** Dark declares `--apex-panel: var(--apex-surface)`; resolve one level. */
    const resolve = (tokens: Record<string, string>, name: string): string => {
      const value = (tokens[name] ?? '').trim();
      const reference = /^var\((--[\w-]+)\)$/.exec(value);
      return reference ? tokens[reference[1]] : value;
    };
    for (const [mode, tokens] of [['dark', DARK_TOKENS], ['light', LIGHT_TOKENS]] as const) {
      const rowSurface = resolve(tokens, '--apex-panel');
      const measured = contrastRatio(resolve(tokens, '--apex-danger'), rowSurface);
      assert.ok(
        measured >= 4.5,
        `${mode}: the danger hover label on the row surface = ${measured.toFixed(2)}:1`
      );
      // The palette class it replaced is the same red in both themes.
      assert.ok(
        contrastRatio('#f87171', rowSurface) > 0,
        'sanity: the rejected red-400 literal resolves'
      );
    }
    // The literal this batch removed is not the palette's danger hue.
    assert.notEqual('#f87171', LIGHT_TOKENS['--apex-danger']);
    assert.notEqual('#f87171', DARK_TOKENS['--apex-danger']);
  });
});
