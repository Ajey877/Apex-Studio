/**
 * UI-03C — Mixer palette seam, unit level.
 *
 * Covers the seam in isolation: palette values follow the document theme with
 * no stale cache, the Dark signal colours are the exact shipped literals, the
 * Light level colours clear the non-text contrast the meter needs, and track
 * identity colours are preserved in Dark and only made legible (hue kept) in
 * Light. Token values are read from the real `src/index.css`, so the contrast
 * assertions test the palettes the app actually ships.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MIXER_SIGNAL_COLORS,
  buildMixerMeterGradient,
  contrastRatio,
  readMixerPalette,
  readMixerStripSurfaces,
  trackIdentityLabelColor,
} from './mixerTheme';
import type { CanvasThemeDocument } from './canvasThemeTokens';

import { hexToRgb, LIGHT_TOKENS, DARK_TOKENS, makeThemeDocument as makeDocument } from './themeTestDocument';

const TOKENS_BY_MODE = { dark: DARK_TOKENS, light: LIGHT_TOKENS } as const;

const TRACK_COLORS = ['#00ff88', '#ff6e00', '#00e5ff', '#ffaa00', '#7e57c2', '#ff0055', '#ffffff'];

describe('Mixer palette seam (UI-03C)', () => {
  it('resolves the canvas background from the active theme token', () => {
    assert.equal(readMixerPalette(makeDocument('dark')).canvasBackground, DARK_TOKENS['--apex-canvas']);
    assert.equal(readMixerPalette(makeDocument('light')).canvasBackground, LIGHT_TOKENS['--apex-canvas']);
  });

  it('follows a theme flip on the next read with no stale palette', () => {
    const doc = makeDocument('dark');
    const dark = readMixerPalette(doc);
    assert.equal(dark.mode, 'dark');
    // Same document object, theme flipped the way the app does it.
    (doc.documentElement as unknown as { dataset: { theme: string } }).dataset.theme = 'light';
    const light = readMixerPalette(doc);
    assert.equal(light.mode, 'light');
    assert.notEqual(light, dark);
    assert.equal(light.signal.levelLow, MIXER_SIGNAL_COLORS.light.levelLow);
    assert.notEqual(light.canvasBackground, dark.canvasBackground);
  });

  it('returns the cached object while the theme is unchanged', () => {
    const doc = makeDocument('light');
    assert.equal(readMixerPalette(doc), readMixerPalette(doc));
  });

  it('reopening (a fresh document read) never returns the other theme palette', () => {
    readMixerPalette(makeDocument('light'));
    const dark = readMixerPalette(makeDocument('dark'));
    assert.equal(dark.mode, 'dark');
    assert.equal(dark.canvasBackground, DARK_TOKENS['--apex-canvas']);
  });

  it('keeps the Dark level gradient byte-identical to the shipped Mixer', () => {
    assert.equal(
      readMixerPalette(makeDocument('dark')).meterGradient,
      'linear-gradient(to top, #00ff00 60%, #ff6e00 85%, #ff0000 100%)'
    );
    assert.deepEqual(MIXER_SIGNAL_COLORS.dark, {
      levelLow: '#00ff00',
      levelMid: '#ff6e00',
      levelHigh: '#ff0000',
      spectrumBackdrop: 'rgba(0, 255, 136, 0.25)',
    });
  });

  it('keeps the Light level gradient in the same green → orange → red order', () => {
    assert.equal(
      buildMixerMeterGradient(MIXER_SIGNAL_COLORS.light),
      `linear-gradient(to top, ${MIXER_SIGNAL_COLORS.light.levelLow} 60%, ${MIXER_SIGNAL_COLORS.light.levelMid} 85%, ${MIXER_SIGNAL_COLORS.light.levelHigh} 100%)`
    );
    assert.equal(MIXER_SIGNAL_COLORS.light.levelLow, LIGHT_TOKENS['--apex-success']);
    assert.equal(MIXER_SIGNAL_COLORS.light.levelMid, LIGHT_TOKENS['--apex-gold']);
    assert.equal(MIXER_SIGNAL_COLORS.light.levelHigh, LIGHT_TOKENS['--apex-danger']);
  });

  it('Light level colours reach the 3:1 non-text contrast a meter needs on the light meter track', () => {
    const track = hexToRgb(LIGHT_TOKENS['--apex-chrome-inset']);
    for (const stop of [MIXER_SIGNAL_COLORS.light.levelLow, MIXER_SIGNAL_COLORS.light.levelMid, MIXER_SIGNAL_COLORS.light.levelHigh]) {
      assert.ok(contrastRatio(hexToRgb(stop), track) >= 3, `${stop} should reach 3:1 on the light meter track`);
    }
  });

  it('documents the measured failure the Light adjustment fixes (shipped Dark green is ~1.2:1 on Light)', () => {
    const track = hexToRgb(LIGHT_TOKENS['--apex-chrome-inset']);
    assert.ok(contrastRatio(hexToRgb('#00ff00'), track) < 2, 'the untouched Dark green would be near-invisible on Light');
  });

  it('reads strip surfaces as RGB from the active theme', () => {
    const light = readMixerStripSurfaces(makeDocument('light'));
    assert.deepEqual(light[0], hexToRgb(LIGHT_TOKENS['--apex-surface-2']));
    assert.deepEqual(light[1], hexToRgb(LIGHT_TOKENS['--apex-panel']));
    const dark = readMixerStripSurfaces(makeDocument('dark'));
    assert.deepEqual(dark[0], hexToRgb(DARK_TOKENS['--apex-surface-2']));
    // Dark --apex-panel is a var() alias, so it must still resolve to real RGB.
    assert.equal(dark[1].length, 3);
    assert.ok(dark[1].every(Number.isFinite));
  });

  it('total fallback: a document with no computed style still yields the Dark palette', () => {
    const palette = readMixerPalette({} as CanvasThemeDocument);
    assert.equal(palette.canvasBackground, '#151821');
    assert.equal(palette.mode, 'dark');
  });
});

describe('Mixer track identity colours (UI-03C)', () => {
  const darkSurfaces = readMixerStripSurfaces(makeDocument('dark'));
  const lightSurfaces = readMixerStripSurfaces(makeDocument('light'));

  it('Dark returns every track colour exactly as stored', () => {
    for (const color of TRACK_COLORS) {
      assert.equal(trackIdentityLabelColor(color, 'dark', darkSurfaces), color);
    }
  });

  it('Light: every track name clears AA (4.5:1) on every strip surface', () => {
    for (const color of TRACK_COLORS) {
      const adjusted = trackIdentityLabelColor(color, 'light', lightSurfaces);
      for (const surface of lightSurfaces) {
        assert.ok(
          contrastRatio(hexToRgb(adjusted), surface) >= 4.5,
          `${color} → ${adjusted} should clear 4.5:1 on the light strip`
        );
      }
    }
  });

  it('Light keeps the hue of an adjusted track colour', () => {
    const hueOf = ([r, g, b]: [number, number, number]) => {
      const rn = r / 255, gn = g / 255, bn = b / 255;
      const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn), d = max - min;
      if (d === 0) return 0;
      let h = max === rn ? (gn - bn) / d : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
      h *= 60;
      return h < 0 ? h + 360 : h;
    };
    for (const color of ['#00ff88', '#ff6e00', '#00e5ff']) {
      const adjusted = trackIdentityLabelColor(color, 'light', lightSurfaces);
      const delta = Math.abs(hueOf(hexToRgb(adjusted)) - hueOf(hexToRgb(color)));
      assert.ok(Math.min(delta, 360 - delta) <= 6, `${color} → ${adjusted} drifted ${delta.toFixed(1)}°`);
    }
  });

  it('Light leaves an already-legible colour untouched', () => {
    assert.equal(trackIdentityLabelColor('#14734e', 'light', lightSurfaces), '#14734e');
  });

  it('returns unparseable colour strings untouched in both themes', () => {
    assert.equal(trackIdentityLabelColor('var(--apex-text)', 'light', lightSurfaces), 'var(--apex-text)');
    assert.equal(trackIdentityLabelColor('rebeccapurple', 'dark', darkSurfaces), 'rebeccapurple');
  });
});

/**
 * Resolves a surface token to RGB the way the cascade does for the tokens the
 * aux-send text sits on: `var()` aliases are followed, and the Dark
 * `--apex-chrome-inset` formula `color-mix(in srgb, #000 P%, X)` is applied.
 */
const resolveSurface = (tokens: Record<string, string>, name: string): [number, number, number] => {
  const value = tokens[name];
  assert.ok(value, `token ${name} is declared`);
  const ref = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (ref) return resolveSurface(tokens, ref[1]);
  const mixed = /^color-mix\(in srgb, #000000 (\d+)%, (.+)\)$/.exec(value.trim());
  if (mixed) {
    const inner = resolveSurface(tokens, /var\((--[\w-]+)\)/.exec(mixed[2])![1]);
    const keep = 1 - Number(mixed[1]) / 100;
    return inner.map((c) => c * keep) as [number, number, number];
  }
  return hexToRgb(value);
};

/** `color-mix(in srgb, fg A%, transparent)` composited over an opaque background. */
const composite = (fg: [number, number, number], bg: [number, number, number], alpha: number): [number, number, number] =>
  fg.map((c, i) => c * alpha + bg[i] * (1 - alpha)) as [number, number, number];

/** Backgrounds the aux-send TEXT labels actually sit on in the Mixer. */
const auxTextBackgrounds = (tokens: Record<string, string>) => {
  const panel = resolveSurface(tokens, '--apex-panel');
  const aux = hexToRgb(tokens['--apex-aux']);
  return {
    'aux section (--apex-panel)': panel,
    'send card (--apex-surface-2)': resolveSurface(tokens, '--apex-surface-2'),
    'FX rack (--apex-chrome-inset)': resolveSurface(tokens, '--apex-chrome-inset'),
    'strip canvas (--apex-canvas)': resolveSurface(tokens, '--apex-canvas'),
    '+ RETURN idle (aux 15% over panel)': composite(aux, panel, 0.15),
    '+ RETURN hover (aux 30% over panel)': composite(aux, panel, 0.3),
  };
};

describe('Aux-send identity and text tokens (UI-03C-fix)', () => {
  it('Dark keeps the shipped violet for decoration, and a lighter same-hue text token', () => {
    assert.equal(DARK_TOKENS['--apex-aux'], '#7e57c2', 'decorative identity unchanged');
    assert.equal(DARK_TOKENS['--apex-aux-text'], '#af96d9');
    const hueOf = (hex: string) => {
      const [r, g, b] = hexToRgb(hex).map((c) => c / 255);
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      const h = max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const drift = Math.abs(hueOf(DARK_TOKENS['--apex-aux']) - hueOf(DARK_TOKENS['--apex-aux-text']));
    assert.ok(Math.min(drift, 360 - drift) <= 2, `same hue (drift ${drift.toFixed(2)}°)`);
  });

  it('Light text token is the same violet as the decoration (Light behaviour unchanged)', () => {
    assert.equal(LIGHT_TOKENS['--apex-aux'], '#5b3aa8');
    assert.equal(LIGHT_TOKENS['--apex-aux-text'], '#5b3aa8');
  });

  for (const mode of ['dark', 'light'] as const) {
    it(`${mode}: aux-send text reaches 4.5:1 on every real aux text background`, () => {
      const tokens = TOKENS_BY_MODE[mode];
      const text = hexToRgb(tokens['--apex-aux-text']);
      for (const [label, bg] of Object.entries(auxTextBackgrounds(tokens))) {
        const ratio = contrastRatio(text, bg);
        assert.ok(ratio >= 4.5, `${mode} aux text on ${label}: ${ratio.toFixed(2)}:1`);
      }
    });
  }

  it('the defect is real: the decorative violet alone fails 4.5:1 on Dark text backgrounds', () => {
    const decorative = hexToRgb(DARK_TOKENS['--apex-aux']);
    const failing = Object.entries(auxTextBackgrounds(DARK_TOKENS))
      .filter(([, bg]) => contrastRatio(decorative, bg) < 4.5);
    assert.equal(failing.length, Object.keys(auxTextBackgrounds(DARK_TOKENS)).length, 'every Dark aux text background failed before the fix');
  });
});
