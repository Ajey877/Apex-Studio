import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MASTERING_BAND_ACCENTS,
  MASTERING_CANVAS_CHROME_TOKENS,
  MASTERING_SIGNAL_COLORS,
  bandAccentKey,
  readMasteringSuitePalette,
  type MasteringSuiteThemeDocument,
} from './masteringSuiteTheme';

/**
 * UI-03B — Mastering Suite theme seam.
 *
 * The seam is the deterministic palette-reading joint between the document
 * theme and everything the Mastering Suite paints outside Tailwind's reach:
 * the two canvases and the inline band accents. These tests pin down the
 * guarantees the migration depends on:
 *
 *   1. canvas chrome resolves from the active document's semantic tokens,
 *   2. flipping `data-theme` changes the palette on the very next read —
 *      no reload, no stale cache,
 *   3. the intentional data colours (band accents, spectrum ramp,
 *      correlation semantics) stay exact literals in Dark and keep their
 *      hues in Light,
 *   4. a missing or hostile style environment falls back instead of throwing.
 */

interface FakeDocOptions {
  theme?: string;
  tokens?: Record<string, string>;
  throwOnCompute?: boolean;
}

/** A document double that records how often computed style is consulted. */
const fakeDocument = (options: FakeDocOptions = {}) => {
  const state = {
    theme: options.theme,
    tokens: { ...(options.tokens ?? {}) },
    computeCalls: 0,
  };
  const doc = {
    state,
    documentElement: {
      dataset: {} as Record<string, string | undefined>,
    },
    defaultView: {
      getComputedStyle: () => {
        state.computeCalls += 1;
        if (options.throwOnCompute) throw new Error('computed style unavailable');
        return {
          getPropertyValue: (name: string) => state.tokens[name] ?? '',
        };
      },
    },
  };
  if (options.theme !== undefined) doc.documentElement.dataset.theme = options.theme;
  return doc as unknown as MasteringSuiteThemeDocument & {
    state: typeof state;
    documentElement: { dataset: Record<string, string | undefined> };
  };
};

const DARK_TOKENS: Record<string, string> = {
  [MASTERING_CANVAS_CHROME_TOKENS.scopeBackground]: 'rgb(14, 17, 25)',
  [MASTERING_CANVAS_CHROME_TOKENS.gridLine]: 'rgb(36, 41, 54)',
  [MASTERING_CANVAS_CHROME_TOKENS.gridLineStrong]: 'rgb(52, 58, 74)',
  [MASTERING_CANVAS_CHROME_TOKENS.axisLabel]: 'rgb(139, 149, 168)',
  [MASTERING_CANVAS_CHROME_TOKENS.idleSignal]: 'rgb(154, 164, 182)',
};

const LIGHT_TOKENS: Record<string, string> = {
  [MASTERING_CANVAS_CHROME_TOKENS.scopeBackground]: 'rgb(227, 232, 240)',
  [MASTERING_CANVAS_CHROME_TOKENS.gridLine]: 'rgb(229, 233, 240)',
  [MASTERING_CANVAS_CHROME_TOKENS.gridLineStrong]: 'rgb(201, 208, 220)',
  [MASTERING_CANVAS_CHROME_TOKENS.axisLabel]: 'rgb(91, 104, 121)',
  [MASTERING_CANVAS_CHROME_TOKENS.idleSignal]: 'rgb(89, 103, 124)',
};

describe('UI-03B — the canvas palette reads the active document theme', () => {
  it('resolves every chrome colour from the semantic tokens of a dark document', () => {
    const doc = fakeDocument({ theme: 'dark', tokens: DARK_TOKENS });
    const palette = readMasteringSuitePalette(doc);
    assert.equal(palette.mode, 'dark');
    assert.equal(palette.scopeBackground, DARK_TOKENS[MASTERING_CANVAS_CHROME_TOKENS.scopeBackground]);
    assert.equal(palette.gridLine, DARK_TOKENS[MASTERING_CANVAS_CHROME_TOKENS.gridLine]);
    assert.equal(palette.gridLineStrong, DARK_TOKENS[MASTERING_CANVAS_CHROME_TOKENS.gridLineStrong]);
    assert.equal(palette.axisLabel, DARK_TOKENS[MASTERING_CANVAS_CHROME_TOKENS.axisLabel]);
    assert.equal(palette.idleSignal, DARK_TOKENS[MASTERING_CANVAS_CHROME_TOKENS.idleSignal]);
  });

  it('follows a theme flip on the next read, without a reload and without a manual reset', () => {
    const doc = fakeDocument({ theme: 'dark', tokens: DARK_TOKENS });
    const dark = readMasteringSuitePalette(doc);
    assert.equal(dark.mode, 'dark');
    assert.equal(dark.scopeBackground, 'rgb(14, 17, 25)');

    // Settings writes the new mode onto the same document root; the computed
    // token values flip with it. The very next read must see the new palette.
    doc.documentElement.dataset.theme = 'light';
    doc.state.tokens = { ...LIGHT_TOKENS };

    const light = readMasteringSuitePalette(doc);
    assert.equal(light.mode, 'light');
    assert.equal(light.scopeBackground, 'rgb(227, 232, 240)');
    assert.equal(light.gridLine, 'rgb(229, 233, 240)');
    assert.equal(light.axisLabel, 'rgb(91, 104, 121)');
    assert.notEqual(light.scopeBackground, dark.scopeBackground);
  });

  it('caches per mode: repeated reads in one theme do not re-resolve styles', () => {
    const doc = fakeDocument({ theme: 'dark', tokens: DARK_TOKENS });
    const first = readMasteringSuitePalette(doc);
    const callsAfterFirst = doc.state.computeCalls;
    assert.ok(callsAfterFirst > 0, 'the first read consults computed style');
    const second = readMasteringSuitePalette(doc);
    assert.equal(second, first, 'the cached palette object is reused');
    assert.equal(doc.state.computeCalls, callsAfterFirst, 'no additional computed-style reads');
  });

  it('never serves a stale palette after the mode changed underneath it', () => {
    const doc = fakeDocument({ theme: 'dark', tokens: DARK_TOKENS });
    const dark = readMasteringSuitePalette(doc);
    doc.documentElement.dataset.theme = 'light';
    doc.state.tokens = { ...LIGHT_TOKENS };
    const light = readMasteringSuitePalette(doc);
    // And flipping back restores the dark entry, still without staleness.
    doc.documentElement.dataset.theme = 'dark';
    doc.state.tokens = { ...DARK_TOKENS };
    const darkAgain = readMasteringSuitePalette(doc);
    assert.equal(darkAgain.scopeBackground, dark.scopeBackground);
    assert.notEqual(darkAgain.scopeBackground, light.scopeBackground);
  });
});

describe('UI-03B — intentional data colours are preserved, not tokenised', () => {
  it('keeps the exact legacy band accents in Dark', () => {
    assert.deepEqual(MASTERING_BAND_ACCENTS.dark, { low: '#ffaa00', mid: '#00ff88', high: '#00e5ff' });
  });

  it('keeps the exact legacy spectrum ramp and correlation semantics in Dark', () => {
    assert.deepEqual(MASTERING_SIGNAL_COLORS.dark.spectrumStops, ['#00ff88', '#ff6e00', '#ff0055']);
    assert.equal(MASTERING_SIGNAL_COLORS.dark.correlationCoherent, '#00ff88');
    assert.equal(MASTERING_SIGNAL_COLORS.dark.correlationWide, '#ffaa00');
    assert.equal(MASTERING_SIGNAL_COLORS.dark.correlationOutOfPhase, '#ff0055');
  });

  const hexToRgb = (hex: string) => ({
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  });

  const hueDegrees = ({ r, g, b }: { r: number; g: number; b: number }): number => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const delta = max - min;
    const hue =
      max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    return (hue * 60 + 360) % 360;
  };

  it('keeps each band identity hue in Light while darkening it for legibility', () => {
    for (const key of ['low', 'mid', 'high'] as const) {
      const dark = MASTERING_BAND_ACCENTS.dark[key];
      const light = MASTERING_BAND_ACCENTS.light[key];
      const darkHue = hueDegrees(hexToRgb(dark));
      const lightHue = hueDegrees(hexToRgb(light));
      const hueDrift = Math.min(
        Math.abs(darkHue - lightHue),
        360 - Math.abs(darkHue - lightHue)
      );
      assert.ok(hueDrift <= 12, `${key} band hue must survive the theme flip (drift ${hueDrift}°)`);
      // Dark stays byte-identical to the legacy literal; Light is a distinct,
      // darker rendering of the same identity.
      assert.notEqual(light, dark);
      const lightLuma = hexToRgb(light);
      assert.ok(
        Math.max(lightLuma.r, lightLuma.g, lightLuma.b) < 200,
        `${key} light accent must not be a pastel on white cards`
      );
    }
  });

  it('keeps the light signal ramp readable while retaining the green-gold-red order', () => {
    const { spectrumStops } = MASTERING_SIGNAL_COLORS.light;
    const [low, mid, high] = spectrumStops.map(hexToRgb).map(hueDegrees);
    assert.ok(low > 90 && low < 180, 'the low-level stop stays green');
    assert.ok(mid > 20 && mid < 60, 'the mid stop stays gold/orange');
    assert.ok(high < 15 || high > 345, 'the hot stop stays red');
    assert.notDeepEqual([...spectrumStops], [...MASTERING_SIGNAL_COLORS.dark.spectrumStops]);
  });

  it('exposes the palette on the seam the component reads', () => {
    const doc = fakeDocument({ theme: 'dark', tokens: DARK_TOKENS });
    const palette = readMasteringSuitePalette(doc);
    assert.equal(palette.bands, MASTERING_BAND_ACCENTS.dark);
    assert.equal(palette.spectrumStops, MASTERING_SIGNAL_COLORS.dark.spectrumStops);
  });
});

describe('UI-03B — tokens that still carry var()/color-mix() are resolved before canvas use', () => {
  it('paints referenced tokens through a hidden probe instead of handing var() to the canvas', () => {
    const probes: Array<{ style: { display?: string; backgroundColor?: string }; removed: boolean }> = [];
    const doc = {
      documentElement: {
        dataset: { theme: 'dark' },
        appendChild: () => {},
      },
      createElement: () => {
        const probe = {
          style: {} as { display?: string; backgroundColor?: string },
          removed: false,
          remove(this: { removed: boolean }) {
            this.removed = true;
          },
        };
        probes.push(probe);
        return probe;
      },
      defaultView: {
        getComputedStyle: (element: unknown) => {
          const probe = element as (typeof probes)[number];
          if (probe && probes.includes(probe)) {
            // What a real browser answers for a probe painted with the token.
            return { backgroundColor: 'rgb(14, 17, 25)' };
          }
          return {
            getPropertyValue: (name: string) =>
              name === MASTERING_CANVAS_CHROME_TOKENS.scopeBackground
                ? 'color-mix(in srgb, #000000 34%, var(--apex-chrome-transport))'
                : DARK_TOKENS[name] ?? '',
          };
        },
      },
    } as unknown as MasteringSuiteThemeDocument;

    const palette = readMasteringSuitePalette(doc);
    // The canvas receives a concrete colour, never the unresolved declaration.
    assert.equal(palette.scopeBackground, 'rgb(14, 17, 25)');
    assert.ok(!palette.scopeBackground.includes('var('));
    assert.equal(probes.length, 1, 'only the referenced token needs a probe');
    assert.equal(probes[0].style.backgroundColor, `var(${MASTERING_CANVAS_CHROME_TOKENS.scopeBackground})`);
    assert.equal(probes[0].removed, true, 'the probe never lingers in the document');
    // The plain tokens skipped the probe entirely.
    assert.equal(palette.gridLine, DARK_TOKENS[MASTERING_CANVAS_CHROME_TOKENS.gridLine]);
  });
});

describe('UI-03B — the seam is total: no document state can break a draw call', () => {
  it('falls back to the dark chrome constants when computed style is missing', () => {
    const doc = { documentElement: { dataset: { theme: 'dark' } } } as unknown as MasteringSuiteThemeDocument;
    const palette = readMasteringSuitePalette(doc);
    assert.equal(palette.mode, 'dark');
    assert.equal(palette.gridLine, '#242936');
    assert.equal(palette.axisLabel, '#8b95a8');
  });

  it('falls back when getComputedStyle throws', () => {
    const doc = fakeDocument({ theme: 'light', throwOnCompute: true });
    const palette = readMasteringSuitePalette(doc);
    assert.equal(palette.mode, 'light');
    assert.equal(palette.scopeBackground, '#0e1119');
    // Data colours never depend on the style environment.
    assert.equal(palette.bands, MASTERING_BAND_ACCENTS.light);
  });

  it('treats a missing or unrecognised data-theme as the dark default', () => {
    const unset = fakeDocument({});
    assert.equal(readMasteringSuitePalette(unset).mode, 'dark');
    const bogus = fakeDocument({ theme: 'sepia' });
    assert.equal(readMasteringSuitePalette(bogus).mode, 'dark');
  });

  it('reads the real global default without a document argument', () => {
    // Node has no `document`; the seam must still answer with the dark palette.
    const palette = readMasteringSuitePalette();
    assert.equal(palette.mode, 'dark');
    assert.equal(palette.bands, MASTERING_BAND_ACCENTS.dark);
  });
});

describe('UI-03B — band key mapping', () => {
  it('maps every state-layer band onto its presentation accent', () => {
    assert.equal(bandAccentKey('lowBand'), 'low');
    assert.equal(bandAccentKey('midBand'), 'mid');
    assert.equal(bandAccentKey('highBand'), 'high');
  });
});
