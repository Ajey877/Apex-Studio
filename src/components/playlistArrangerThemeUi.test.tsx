/**
 * UI-03P — Playlist Arranger residual theme migration.
 *
 * The arranger was already largely tokenised (UI-04 and earlier UI-03 work), but
 * it still carried chrome on raw literals and it was one of the last two
 * consumers of the UI-1C compatibility layer in `index.css`:
 *
 *   1. **Chrome** — the clip-type/tool active chips, the Sections button and its
 *      flag glyph, the automation clip wash/border/label, the automation editor
 *      footer, the track-state dot, the bounce hover and the quick-add marker
 *      tiles now resolve through the shared tokens (`--apex-cyan`,
 *      `--apex-cyan-text`, `--apex-gold`, `--apex-success`, `--apex-state-playing-fg`).
 *   2. **The text half of the preserved signal** — `text-[#00e5ff]` and
 *      `text-[#00ff88]` were mapped by the compatibility layer only for *text*,
 *      so in Light the dropped-audio label became `--apex-success` (#14734e) on
 *      the clip's preserved dark-green body: **2.00:1**. The audio label now
 *      paints the signal colour directly (escaping the layer), exactly like the
 *      waveform bars beside it. This is the measured defect that forced the
 *      migration; the assertion is pinned below.
 *
 * Preserved as project data (UI-03A §“Explicitly preserved”), pinned by exact
 * count so nothing can hide behind the allowance:
 *
 *   - `AUDIO_CLIP_SIGNAL_COLOR` (#00ff88) — the stored clip `color` on both
 *     creation paths, plus the available-audio border, label and waveform bars.
 *   - The audio clip's dark surface steps (`bg-[#002b1a]/90`, `hover:bg-[#003d24]`)
 *     and the fade overlay drawn on top of it (`from-black/80`,
 *     `border-white/40`, `text-white`) — a media scrim over a preserved signal
 *     surface, the same category as UI-03O's one surviving on-colour.
 *   - `MARKER_PRESETS` / `MARKER_KIND_COLORS` hues, which are stored on each
 *     `ArrangementMarker` and repainted verbatim as the chip's own identity.
 *
 * Live pixels, hover states and both palettes are measured in
 * `browser-tests/playlistArrangerTheme.spec.ts`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlaylistArranger } from './PlaylistArranger';
import { DEFAULT_PROJECT } from '../audio/presets';
import type { ArrangementMarker, PlaylistClip } from '../types/daw';
import { DARK_TOKENS, LIGHT_TOKENS, hexToRgb } from './themeTestDocument';

const noop = (): void => {};

const markers: ArrangementMarker[] = [
  { id: 'marker-1', name: 'Intro', bar: 1, color: '#00e5ff' },
  { id: 'marker-2', name: 'Drop / Chorus', bar: 3, color: '#ff0055' }
];

/** One clip per render branch, so every migrated surface is actually exercised. */
const clips: PlaylistClip[] = [
  {
    id: 'clip-pattern',
    trackIndex: 0,
    startBar: 0,
    lengthBars: 2,
    type: 'pattern',
    patternId: 'pat-1',
    channelId: 'ch-kick',
    color: '#ff5722',
    name: 'Kick Pattern'
  },
  {
    id: 'clip-auto',
    trackIndex: 1,
    startBar: 0,
    lengthBars: 2,
    type: 'automation',
    color: '#00e5ff',
    name: 'Filter Sweep',
    automationTarget: { type: 'channel_filter_cutoff', targetId: 'ch-kick', paramName: 'filter', label: 'Filter' },
    automationPoints: [
      { x: 0, y: 0.2 },
      { x: 0.6, y: 0.85 }
    ]
  },
  {
    id: 'clip-audio',
    trackIndex: 2,
    startBar: 0,
    lengthBars: 2,
    type: 'audio',
    audioBufferId: 'buf-1',
    audioName: 'stem.wav',
    audioWaveform: [0.4, 0.7, 0.5],
    color: '#00ff88',
    name: 'Kick [Stem]',
    fadeInBars: 0.25,
    fadeOutBars: 0.25
  },
  {
    id: 'clip-missing',
    trackIndex: 3,
    startBar: 0,
    lengthBars: 2,
    type: 'audio',
    audioBufferId: 'buf-2',
    audioName: 'gone.wav',
    audioUnavailable: true,
    color: '#00ff88',
    name: 'Gone [Stem]'
  }
];

const render = (): string =>
  renderToStaticMarkup(
    React.createElement(PlaylistArranger, {
      tracks: DEFAULT_PROJECT.playlistTracks.slice(0, 4),
      clips,
      patterns: DEFAULT_PROJECT.patterns,
      channels: DEFAULT_PROJECT.channels,
      markers,
      onUpdateTracks: noop,
      onUpdateClips: noop,
      onUpdateMarkers: noop,
      onAddTrack: noop,
      currentBar: 1,
      isPlaying: false,
      bpm: DEFAULT_PROJECT.meta.bpm,
      totalBars: 32,
      onUpdateTotalBars: noop
    })
  );

const source = readFileSync('src/components/PlaylistArranger.tsx', 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

const classAttributes = (markup: string): string[] =>
  [...markup.matchAll(/class="([^"]*)"/g)].map((match) => match[1]);

const UNTHEMED =
  /#[0-9a-f]{3,8}\b|\b(?:text|bg|border|from|to|accent|ring|fill|divide|placeholder|caret|shadow)-\[#|\b(?:text|bg|border|divide|ring|from|to|placeholder)-(?:white|black)\b|\brgba?\(|\b(?:text|bg|border)-(?:red|amber|green|gray|zinc|neutral|orange|yellow|emerald|cyan|violet|purple|slate)-[0-9]/i;

/** The complete, exact allow-list of preserved literals in a class attribute. */
const PRESERVED_CLASS_TOKENS = [
  'bg-[#002b1a]/90',
  'hover:bg-[#003d24]',
  'from-black/80',
  'border-white/40',
  'text-white'
] as const;

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

/** `0…1` weight blend of two six-digit hex values, the way `color-mix` rounds. */
const blend = (weight: number, top: string, bottom: string): string => {
  const [tr, tg, tb] = hexToRgb(top);
  const [br, bg, bb] = hexToRgb(bottom);
  const channel = (a: number, b: number): number => Math.round(a * weight + b * (1 - weight));
  return `#${[channel(tr, br), channel(tg, bg), channel(tb, bb)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
};

/**
 * One level of `var()` indirection, the way Chromium's computed style resolves
 * it: Dark declares `--apex-panel: var(--apex-surface)`.
 */
const resolveToken = (tokens: Record<string, string>, name: string): string => {
  const value = tokens[name];
  const reference = /^var\((--[\w-]+)\)$/.exec((value ?? '').trim());
  return reference ? tokens[reference[1]] : value;
};

describe('Playlist Arranger residual theme migration (UI-03P)', () => {
  it('renders the toolbar, the ruler, both marker chips and every clip branch', () => {
    const markup = render();
    assert.match(markup, /Sections \(2\)/);
    for (const label of ['Pattern', 'Automation', 'Draw', 'Slice', 'Erase', 'Add Track Row']) {
      assert.ok(markup.includes(label), `expected the toolbar to render ${label}`);
    }
    assert.match(markup, /id="add-playlist-track-btn"/);
    assert.match(markup, /TRACK LANES/);
    // The four clip branches and the two marker chips are all present.
    assert.match(markup, /Kick Pattern/);
    assert.match(markup, /Filter Sweep/);
    assert.match(markup, /Kick \[Stem\]/);
    assert.match(markup, /MISSING AUDIO/);
    assert.ok(markup.includes('Intro'));
    assert.ok(markup.includes('Drop / Chorus'));
  });

  it('leaves no unthemed class attribute behind: only the pinned preserved tokens remain', () => {
    const offenders = new Set<string>();
    for (const value of classAttributes(render())) {
      for (const token of value.split(/\s+/)) {
        if (!UNTHEMED.test(token)) continue;
        if ((PRESERVED_CLASS_TOKENS as readonly string[]).includes(token)) continue;
        offenders.add(token);
      }
    }
    assert.deepEqual([...offenders].sort(), []);
  });

  it('pins the preserved signal palette to an exact, counted allowance', () => {
    const markup = render();
    const occurrences = (needle: string): number => markup.split(needle).length - 1;
    assert.equal(occurrences('bg-[#002b1a]/90'), 1, 'the preserved available-audio surface');
    assert.equal(occurrences('hover:bg-[#003d24]'), 1, 'its preserved hover step');
    // The scrim pair renders on every audio clip — the available one and the
    // unavailable one alike, which is the pre-existing `isAudio` condition this
    // presentation pass does not touch — so two clips carry four handles.
    assert.equal(occurrences('from-black/80'), 4, 'the fade scrim on both audio clips');
    assert.equal(occurrences('border-white/40'), 4, 'both fade-handle edges per clip');
    assert.equal(occurrences('text-white'), 4, 'the IN/OUT labels');
    assert.equal(occurrences('>IN<'), 2, 'the fade-in label');
    assert.equal(occurrences('>OUT<'), 2, 'the fade-out label');
    // The waveform bars are painted from the constant, not from a class.
    assert.equal(occurrences('background-color:#00ff88'), 32, 'one bar per waveform slot');

    assert.match(code, /const AUDIO_CLIP_SIGNAL_COLOR = '#00ff88';/);
    assert.equal((code.match(/AUDIO_CLIP_SIGNAL_COLOR/g) ?? []).length, 7, 'constant, three creation paths (including whole-pattern lane bounce), border, label, bars');
    assert.equal((code.match(/color: AUDIO_CLIP_SIGNAL_COLOR/g) ?? []).length, 4, 'the stored clip colour on three creation paths, plus the label');
    assert.match(code, /: 'bg-\[#002b1a\]\/90 hover:bg-\[#003d24\]'/);
    assert.equal((code.match(/text-white/g) ?? []).length, 2, 'both IN/OUT labels of the media scrim');
  });

  it('keeps every marker hue as stored data, including the four quick-add kinds', () => {
    assert.match(
      code,
      /const MARKER_KIND_COLORS = \{\s*intro: '#00e5ff',\s*verse: '#3b82f6',\s*drop: '#ff0055',\s*outro: '#00ff88'\s*\} as const;/
    );
    for (const kind of ['intro', 'verse', 'drop', 'outro']) {
      assert.match(
        code,
        new RegExp(`handleAddMarker\\('[^']+', currentBar, MARKER_KIND_COLORS\\.${kind}\\)`),
        `the ${kind} quick-add tile must create its marker with the stored hue`
      );
    }
    assert.match(code, /name: 'EDM \/ Dance Structure'/);
    assert.match(code, /name: 'Pop \/ Radio Hit \(3 Min\)'/);
    assert.match(code, /name: 'Hip-Hop \/ Trap Beat'/);
    assert.equal((code.match(/color: '#00ff88' \}/g) ?? []).length, 3, 'the outro preset in each marker preset');
  });

  it('the marker chip keeps its stored hue in the wash and edge, and its label on the text token', () => {
    const markup = render();
    assert.match(markup, /background-color:#00e5ff22/);
    assert.match(markup, /border-left-color:#00e5ff/);
    assert.match(markup, /background-color:#ff005522/);
    assert.match(markup, /border-left-color:#ff0055/);
    assert.match(markup, /color:var\(--apex-text\)/);
    // A chip hue is never painted as text again (`border-left-color` and
    // `background-color` are kept out of the match on purpose: the edge and the
    // wash keep the identity). The one deliberate exception is the dropped audio
    // clip's own label, which paints the preserved signal colour.
    const asText = (needle: string): number =>
      (markup.match(new RegExp(`(?:^|[;\\s"])color:${needle}`, 'g')) ?? []).length;
    assert.equal(asText('#00e5ff'), 0, 'the cyan marker hue is not a text colour');
    assert.equal(asText('#ff0055'), 0, 'the drop marker hue is not a text colour');
    assert.equal(asText('#00ff88'), 1, 'only the available audio label paints the signal colour');
  });

  it('the quick-add grid paints its identity wash from the stored hue with a token label', () => {
    assert.match(
      code,
      /style=\{\{\s*backgroundColor: `\$\{MARKER_KIND_COLORS\.intro\}33`,\s*borderColor: `\$\{MARKER_KIND_COLORS\.intro\}66`\s*\}\}/
    );
    assert.match(
      code,
      /style=\{\{\s*backgroundColor: `\$\{MARKER_KIND_COLORS\.outro\}33`,\s*borderColor: `\$\{MARKER_KIND_COLORS\.outro\}66`\s*\}\}/
    );
    assert.equal(
      (code.match(/className="p-1 rounded border text-\[var\(--apex-text\)\] hover:brightness-125"/g) ?? []).length,
      4,
      'all four quick-add tiles use the token label'
    );
  });

  it('the migrated chrome resolves through the shared tokens', () => {
    assert.equal(
      /text-\[#00e5ff\]|text-\[#00ff88\]|bg-\[#00e5ff\]|border-\[#00e5ff\]|bg-\[#00ff88\]|bg-\[#ffaa00\]|text-\[#ffaa00\]|border-\[#ffaa00\]|bg-\[#002233\]|border-\[#00ff88\]/.test(code),
      false,
      'no chrome literal survives'
    );
    assert.equal(
      (code.match(/bg-\[var\(--apex-cyan\)\] text-\[var\(--apex-state-playing-fg\)\] shadow/g) ?? []).length,
      2,
      'the Automation and Slice active chips'
    );
    assert.match(
      code,
      /text-\[var\(--apex-gold\)\] border border-\[color-mix\(in_srgb,var\(--apex-gold\)_30%,transparent\)\]/,
      'the Sections button'
    );
    assert.match(code, /<Flag className="w-3\.5 h-3\.5 text-\[var\(--apex-gold\)\]" \/>/);
    assert.match(
      code,
      /bg-\[color-mix\(in_srgb,var\(--apex-cyan\)_16%,var\(--apex-panel\)\)\] border-\[var\(--apex-cyan\)\] hover:bg-\[color-mix\(in_srgb,var\(--apex-cyan\)_24%,var\(--apex-panel\)\)\]/,
      'the automation clip wash'
    );
    assert.match(
      code,
      /isAuto \? 'text-\[var\(--apex-cyan-text\)\]' : isAudioMissing \? 'text-\[var\(--apex-danger\)\]' : isAudio \? '' : 'text-\[var\(--apex-text\)\]'/,
      'the clip label family'
    );
    assert.match(code, /style=\{\{ stroke: 'var\(--apex-cyan\)' \}\}/, 'the envelope curve');
    assert.match(code, /fill: isPointSelected \? 'var\(--apex-cyan\)' : 'var\(--apex-text\)'/, 'the envelope points');
    assert.match(code, /stroke: isPointSelected \? 'var\(--apex-text\)' : 'none'/, 'the selected point ring');
    assert.match(code, /border-t border-\[color-mix\(in_srgb,var\(--apex-cyan\)_40%,transparent\)\]/, 'the envelope footer rule');
    assert.match(
      code,
      /bg-\[var\(--apex-cyan\)\] flex items-center justify-center text-\[var\(--apex-state-playing-fg\)\] font-bold/,
      'the envelope footer glyph tile'
    );
    assert.match(
      code,
      /bg-\[color-mix\(in_srgb,var\(--apex-cyan\)_20%,transparent\)\] text-\[var\(--apex-cyan-text\)\] font-mono/,
      'the envelope point chip'
    );
    assert.match(code, /'bg-\[var\(--apex-success\)\] border-\[var\(--apex-success\)\]'/, 'the unmuted track dot');
    assert.match(code, /hover:bg-\[var\(--apex-success\)\] hover:text-\[var\(--apex-state-playing-fg\)\]/, 'the bounce hover');
  });

  it('keeps the arrangement behaviour the migration must not touch', () => {
    for (const seam of [
      /const MARKER_PRESETS/,
      /onUpdateMarkers\(updated\);/,
      /setIsMarkerMenuOpen\(false\);/,
      /setStatusMessage\(`Added section marker: \$\{name\} at Bar \$\{bar\}`\)/,
      /handleTrackMute/,
      /handleBounceTrack/,
      /const handleAdjustClipFade/,
      /title=\{`Fade In: \$\{\(clip\.fadeInBars \|\| 0\)\} Bars \(Click to extend\)`\}/,
      /title=\{`Fade Out: \$\{\(clip\.fadeOutBars \|\| 0\)\} Bars \(Click to extend\)`\}/,
      /MISSING_AUDIO_CLIP_BADGE_LABEL/,
      /addPlaylistAutomationPoint/,
      /id="add-playlist-track-btn"/
    ]) {
      assert.match(code, seam);
    }
  });

  it('every migrated pairing clears AA in both palettes, and the rejected pairing is pinned', () => {
    for (const [mode, tokens] of [['dark', DARK_TOKENS], ['light', LIGHT_TOKENS]] as const) {
      const panel = resolveToken(tokens, '--apex-panel');
      const step = (label: string, fg: string, bg: string, floor = 4.5): void => {
        const measured = contrastRatio(fg, bg);
        assert.ok(measured >= floor, `${mode}: ${label} = ${measured.toFixed(2)}:1 (floor ${floor})`);
      };

      // Sections button + its flag glyph: gold identity on the panel.
      step('Sections label', resolveToken(tokens, '--apex-gold'), panel);
      // Active tool chip: the cyan fill carries the theme's on-colour label.
      step('active tool chip', resolveToken(tokens, '--apex-state-playing-fg'), resolveToken(tokens, '--apex-cyan'));
      // Quick-add tiles: the text token on the 20 % identity wash.
      for (const hue of ['#00e5ff', '#3b82f6', '#ff0055', '#00ff88']) {
        step(`quick-add tile label on ${hue}`, resolveToken(tokens, '--apex-text'), blend(0.2, hue, panel));
        step(
          `marker chip label on ${hue}`,
          resolveToken(tokens, '--apex-text'),
          blend(0.133, hue, resolveToken(tokens, '--apex-panel-header'))
        );
      }
      // Automation clip: the cyan text token on the 16 % cyan wash over the panel.
      step(
        'automation clip label',
        resolveToken(tokens, '--apex-cyan-text'),
        blend(0.16, resolveToken(tokens, '--apex-cyan'), panel)
      );
      // The preserved audio label on the preserved clip surface.
      step('#00ff88 label on the preserved audio surface', '#00ff88', blend(0.9, '#002b1a', resolveToken(tokens, '--apex-canvas')));
    }

    // The pairing UI-03P rejected: a stored hue painted as the chip's *text* on
    // the Light ribbon. Two of the four presets fail AA there, and the audio
    // label — the one the compatibility layer actually remapped — measured
    // 2.00:1. The adopted label follows --apex-text instead, so the same chips
    // clear the floor.
    const lightHeader = resolveToken(LIGHT_TOKENS, '--apex-panel-header');
    assert.ok(contrastRatio('#00e5ff', lightHeader) < 4.5, 'cyan as text on the light ribbon fails AA');
    assert.ok(contrastRatio('#00ff88', lightHeader) < 4.5, 'green as text on the light ribbon fails AA');
    const rejectedAudioLabel = contrastRatio(LIGHT_TOKENS['--apex-success'], blend(0.9, '#002b1a', LIGHT_TOKENS['--apex-canvas']));
    assert.ok(
      rejectedAudioLabel < 3,
      `the layer's remapped audio label must be shown to fail (measured ${rejectedAudioLabel.toFixed(2)}:1)`
    );
    const adoptedAudioLabel = contrastRatio('#00ff88', blend(0.9, '#002b1a', LIGHT_TOKENS['--apex-canvas']));
    assert.ok(adoptedAudioLabel >= 4.5, `the adopted signal label clears AA (${adoptedAudioLabel.toFixed(2)}:1)`);
  });
});
