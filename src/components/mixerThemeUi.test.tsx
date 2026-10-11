/**
 * UI-03C — Mixer light/dark migration, asserted against the markup the real
 * component produces (`renderToStaticMarkup`, as in the UI-03B Mastering tests).
 *
 * 1. Both themes render the full console (strips, FX rack, sends, sidechain).
 * 2. Class attributes carry no colour literals — neutral chrome is tokenised.
 * 3. The intentional signal colours are exact in Dark and legible in Light.
 * 4. Track identity colours are unchanged in Dark and legible in Light.
 * 5. Switching theme changes presentation only: the rendered text, controls
 *    and values are identical, and the inputs' props are never mutated.
 * 6. The canvas draw loop reads the palette per frame (source-level guard; the
 *    live pixel repaint is proven in browser-tests/mixerTheme.spec.ts).
 */
import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Mixer } from './Mixer';
import type { MixerTrack } from '../types/daw';
import { MIXER_SIGNAL_COLORS, buildMixerMeterGradient, readMixerStripSurfaces, trackIdentityLabelColor } from './mixerTheme';
import { makeThemeDocument } from './themeTestDocument';

const noop = (): void => {};

const fixtureTracks = (): MixerTrack[] => [
  {
    id: 0, name: 'Master', color: '#ffffff', volume: 1, pan: 0, mute: false, solo: false,
    fxSlots: [{ id: 'fx-limit', type: 'limiter', name: 'Transparent Limiter', enabled: true, mix: 1, params: {} }],
    peakL: 0, peakR: 0,
  },
  {
    id: 1, name: 'Kick / 808', color: '#ff6e00', volume: 0.9, pan: -0.2, mute: false, solo: false,
    fxSlots: [], peakL: 0, peakR: 0,
    auxSends: [{ targetId: 2, amount: 0.5 }],
  },
  {
    id: 2, name: 'Hi-Hats', color: '#00ff88', volume: 0.7, pan: 0.1, mute: true, solo: false,
    fxSlots: [{ id: 'fx-eq', type: 'equalizer', name: '3-Band EQ', enabled: true, mix: 1, params: {} }],
    peakL: 0, peakR: 0,
    routingTargetId: 0,
  },
  {
    id: 3, name: 'Lead Pluck', color: '#00e5ff', volume: 1.1, pan: 0, mute: false, solo: true,
    fxSlots: [], peakL: 0, peakR: 0,
  },
  {
    id: 9, name: 'Reverb Return', color: '#ffaa00', volume: 0.8, pan: 0, mute: false, solo: false,
    fxSlots: [], peakL: 0, peakR: 0, isAux: true,
  } as MixerTrack,
];

const props = (tracks: MixerTrack[]) => ({
  tracks,
  selectedTrackId: 1,
  onSelectTrack: noop,
  onUpdateTrack: noop,
  onAddFxSlot: noop,
  onDeleteFxSlot: noop,
  onUpdateFxSlot: noop,
  isPlaying: false,
  onCreateAuxReturn: noop,
});

/** Renders the Mixer with `document` set to a double for the chosen theme. */
const renderMixer = (mode: 'dark' | 'light', tracks: MixerTrack[] = fixtureTracks()): string => {
  const holder = globalThis as { document?: unknown };
  const previous = holder.document;
  holder.document = makeThemeDocument(mode);
  try {
    return renderToStaticMarkup(React.createElement(Mixer, props(tracks)));
  } finally {
    if (previous === undefined) delete holder.document;
    else holder.document = previous;
  }
};

const stripTags = (markup: string): string => markup.replace(/<[^>]+>/g, '\u0000').split('\u0000').map((s) => s.trim()).filter(Boolean).join('|');

const classAttributes = (markup: string): string[] => [...markup.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);

const lightSurfaces = readMixerStripSurfaces(makeThemeDocument('light'));

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe('Mixer renders coherently in Dark and Light (UI-03C)', () => {
  it('both themes render the full console: strips, FX rack, sends and sidechain', () => {
    for (const mode of ['dark', 'light'] as const) {
      const markup = renderMixer(mode);
      assert.match(markup, /id="fl-mixer-console"/, mode);
      assert.match(markup, /STUDIO MIXING CONSOLE/, mode);
      for (const id of [0, 1, 2, 3]) assert.match(markup, new RegExp(`id="mixer-strip-${id}"`), `${mode} strip ${id}`);
      assert.match(markup, /FX SLOTS \(KICK \/ 808\)/, mode);
      assert.match(markup, /AUX SENDS \(POST-FADER\)/, mode);
      assert.match(markup, /\+ Add Post-Fader Send/, mode);
      assert.match(markup, /DYNAMIC SIDECHAIN DUCK/, mode);
    }
  });

  it('class attributes carry no colour literals in either theme (neutral chrome is tokenised)', () => {
    for (const mode of ['dark', 'light'] as const) {
      for (const cls of classAttributes(renderMixer(mode))) {
        assert.doesNotMatch(cls, /#[0-9a-fA-F]{3,8}\b/, `${mode}: literal in class "${cls}"`);
        assert.doesNotMatch(cls, /rgba?\(/, `${mode}: rgb literal in class "${cls}"`);
      }
    }
  });

  it('the VU gradient is exact in Dark and uses the light level stops in Light', () => {
    const dark = renderMixer('dark');
    const light = renderMixer('light');
    assert.ok(dark.includes(buildMixerMeterGradient(MIXER_SIGNAL_COLORS.dark)), 'dark meter gradient');
    assert.ok(dark.includes('linear-gradient(to top, #00ff00 60%, #ff6e00 85%, #ff0000 100%)'));
    assert.ok(light.includes(buildMixerMeterGradient(MIXER_SIGNAL_COLORS.light)), 'light meter gradient');
    assert.ok(!light.includes('#00ff00'), 'the bright Dark green must not appear in Light');
  });

  it('track identity: Dark keeps the stored colour; Light only adjusts names that fail AA', () => {
    const dark = renderMixer('dark');
    const light = renderMixer('light');
    assert.ok(dark.includes('color:#00ff88'), 'Dark Hi-Hats name keeps its identity colour');
    assert.ok(dark.includes('color:#00e5ff'), 'Dark Lead Pluck name keeps its identity colour');
    const adjusted = trackIdentityLabelColor('#00ff88', 'light', lightSurfaces);
    assert.ok(light.includes(`color:${adjusted}`), 'Light Hi-Hats name uses the legible variant');
    assert.ok(!light.includes('color:#00ff88'), 'the illegible Light name colour is gone');
    // A colour that already clears AA on Light is left exactly as stored.
    const legible = renderMixer('light', fixtureTracks().map((t) => (t.id === 2 ? { ...t, color: '#14734e' } : t)));
    assert.ok(legible.includes('color:#14734e'));
  });

  it('switching theme changes presentation only: text, controls and values are identical', () => {
    const dark = renderMixer('dark');
    const light = renderMixer('light');
    assert.equal(stripTags(light), stripTags(dark), 'visible text and readouts match across themes');
    const values = (markup: string) => [...markup.matchAll(/ value="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(values(light), values(dark), 'pan / volume / send / routing values match');
    assert.equal((light.match(/<input/g) ?? []).length, (dark.match(/<input/g) ?? []).length);
    assert.equal((light.match(/<select/g) ?? []).length, (dark.match(/<select/g) ?? []).length);
    assert.equal((light.match(/<button/g) ?? []).length, (dark.match(/<button/g) ?? []).length);
  });

  it('rendering in either theme never mutates the mixer state it was given', () => {
    const tracks = fixtureTracks();
    const before = JSON.stringify(tracks);
    renderMixer('dark', tracks);
    renderMixer('light', tracks);
    assert.equal(JSON.stringify(tracks), before, 'tracks (levels, mute/solo, routing, sends, FX) unchanged');
  });
});

describe('Aux-send decoration vs text foreground in rendered markup (UI-03C-fix)', () => {
  /** The full opening `<span|button|input ...>` tag that contains `needle`. */
  const tagWith = (markup: string, needle: string): string | undefined =>
    [...markup.matchAll(/<(span|button|input)\b[^>]*>/g)].map((m) => m[0]).find((tag) => tag.includes(needle));

  for (const mode of ['dark', 'light'] as const) {
    it(`${mode}: the identity dot and slider keep --apex-aux; every aux text uses --apex-aux-text`, () => {
      const markup = renderMixer(mode);

      // Decorative identity: the dot beside "AUX SENDS" and the send slider accent.
      assert.ok(markup.includes('<span class="w-2 h-2 bg-[var(--apex-aux)] rounded-full"></span>'), `${mode}: identity dot`);
      assert.ok(tagWith(markup, 'accent-[var(--apex-aux)]'), `${mode}: slider accent`);

      // Text foreground: the RETURN button, the send readout and the add-send hover.
      const returnButton = tagWith(markup, 'title="Create new aux return track"');
      assert.ok(returnButton, `${mode}: RETURN button rendered`);
      assert.match(returnButton!, /text-\[var\(--apex-aux-text\)\]/, `${mode}: RETURN label foreground`);
      const readout = markup.match(/<span class="[^"]*text-\[var\(--apex-aux-text\)\][^"]*">\d+%<\/span>/);
      assert.ok(readout, `${mode}: send % readout uses the text token`);
      assert.match(markup, /hover:text-\[var\(--apex-aux-text\)\]/, `${mode}: add-send hover text`);

      // No text may fall back to the decorative token: that colour is the failing 3:1 one.
      assert.doesNotMatch(markup, /text-\[var\(--apex-aux\)\]/, `${mode}: no text on the decorative token`);
      assert.doesNotMatch(markup, /hover:text-\[var\(--apex-aux\)\]/, `${mode}: no hover text on the decorative token`);
    });
  }

  it('the decorative and text tokens are the same classes in both themes (only values differ)', () => {
    const dark = renderMixer('dark');
    const light = renderMixer('light');
    const classesOf = (markup: string) => classAttributes(markup).filter((c) => c.includes('apex-aux'));
    assert.deepEqual(classesOf(light), classesOf(dark));
  });
});

describe('Mixer source guards (UI-03C)', () => {
  const mixerSource = readFileSync('src/components/Mixer.tsx', 'utf8');

  it('the FX slot controls the Mixer renders carry no colour literals either', () => {
    const fx = readFileSync('src/components/fxParameterControls.tsx', 'utf8');
    const code = fx.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/);
    assert.doesNotMatch(code, /rgba?\(/);
  });

  it('Mixer.tsx carries no colour literals of its own', () => {
    const code = mixerSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /#[0-9a-fA-F]{3,8}\b/);
    assert.doesNotMatch(code, /rgba?\(/);
  });

  it('the canvas draw loop reads the palette every frame and paints through it', () => {
    assert.match(mixerSource, /const livePalette = readMixerPalette\(\);/);
    assert.match(mixerSource, /ctx\.fillStyle = livePalette\.canvasBackground;/);
    assert.match(mixerSource, /grad\.addColorStop\(0, livePalette\.signal\.levelLow\)/);
    assert.match(mixerSource, /faderCtx\.fillStyle = livePalette\.signal\.spectrumBackdrop;/);
  });

  it('the DOM meter and track names read the hook-driven palette', () => {
    assert.match(mixerSource, /background: palette\.meterGradient/);
    assert.match(mixerSource, /trackIdentityLabelColor\(track\.color, palette\.mode, palette\.stripSurfaces\)/);
    assert.match(mixerSource, /const palette = useMixerPalette\(\);/);
  });
});
