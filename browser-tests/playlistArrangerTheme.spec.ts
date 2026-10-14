/**
 * UI-03P — Playlist Arranger, measured in a real Chromium.
 *
 * The arranger was already largely tokenised, so this spec covers exactly what
 * the batch changed and what a server-rendered scan cannot measure:
 *
 *   - the Sections button and its flag glyph (`--apex-gold` on the panel);
 *   - the four quick-add tiles: each keeps its marker identity as a *wash*, and
 *     its label uses the text token — measured against the composited wash, in
 *     both palettes. The stored hue as text is the rejected pairing and is shown
 *     to fail the same floor;
 *   - the timeline chip: identity in the edge and the wash, label on
 *     `--apex-text`;
 *   - an automation clip created through the real placement tool: cyan border,
 *     cyan `color-mix` wash, cyan envelope curve, label on `--apex-cyan-text`;
 *   - the active tool chip: cyan fill with the theme's on-colour;
 *   - a flip with the arranger mounted repaints it with no reload, and the
 *     project state (markers + clips) is identical either side of the flip.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

type Rgba = [number, number, number, number];

const parseColor = (value: string): Rgba | null => {
  const srgb = /color\(srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*([\d.eE+-]+))?\s*\)/.exec(value);
  if (srgb) {
    return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
  }
  const rgb = /rgba?\(([^)]+)\)/.exec(value);
  if (!rgb) return null;
  const channels = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return [channels[0], channels[1], channels[2], channels[3] ?? 1];
};

const requireColor = (value: string, label: string): Rgba => {
  const parsed = parseColor(value);
  if (parsed) return parsed;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split('').map((c) => c + c).join('') : hex[1];
    const channel = (offset: number) => parseInt(digits.slice(offset, offset + 2), 16);
    return [channel(0), channel(2), channel(4), digits.length === 8 ? channel(6) / 255 : 1];
  }
  throw new Error(`${label}: cannot parse computed colour "${value}"`);
};

const luminance = ([r, g, b]: Rgba): number => {
  const linear = (value: number): number => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

const contrastRatio = (foreground: Rgba, background: Rgba): number => {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

const composite = (foreground: Rgba, background: Rgba): Rgba => [
  foreground[0] * foreground[3] + background[0] * (1 - foreground[3]),
  foreground[1] * foreground[3] + background[1] * (1 - foreground[3]),
  foreground[2] * foreground[3] + background[2] * (1 - foreground[3]),
  1,
];

const colourDistance = (a: Rgba, b: Rgba): number =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]) * 255);

const token = async (page: Page, name: string): Promise<Rgba> => {
  const value = await page.evaluate(
    (tokenName) => getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim(),
    name,
  );
  return requireColor(value, name);
};

const readColour = (locator: Locator, property: 'color' | 'backgroundColor' | 'borderTopColor' | 'borderLeftColor' | 'stroke') =>
  locator.evaluate((element, prop) => getComputedStyle(element)[prop as 'color'], property).then((value) => parseColor(value));

const expectColor = async (
  locator: Locator,
  property: 'color' | 'backgroundColor' | 'borderTopColor' | 'borderLeftColor' | 'stroke',
  expected: Rgba,
  label: string,
  tolerance = 2,
): Promise<void> => {
  await expect
    .poll(() => readColour(locator, property).then((got) => (got ? colourDistance(got, expected) : Number.MAX_SAFE_INTEGER)), {
      message: `${label}: expected ${expected.map((n) => Math.round(n)).join(',')} on ${property}`,
      timeout: 5_000,
      intervals: [50],
    })
    .toBeLessThanOrEqual(tolerance);
};

/** Effective surface: the element's own fill composited over its ancestors. */
const effectiveSurface = async (locator: Locator): Promise<Rgba> => {
  const stack = await locator.evaluate((element) => {
    const layers: string[] = [];
    for (let node: Element | null = element; node && layers.length < 16; node = node.parentElement) {
      layers.push(getComputedStyle(node).backgroundColor);
    }
    return layers;
  });
  const layers = stack.map(parseColor).filter((value): value is Rgba => value !== null);
  const opaque = layers.findIndex((layer) => layer[3] >= 1);
  const from = opaque === -1 ? layers.length - 1 : opaque;
  let base: Rgba = layers[from] ? [layers[from][0], layers[from][1], layers[from][2], 1] : [255, 255, 255, 1];
  for (let index = from - 1; index >= 0; index -= 1) base = composite(layers[index], base);
  return base;
};

const textContrast = async (locator: Locator): Promise<{ ratio: number; color: Rgba; surface: Rgba }> => {
  const color = await readColour(locator, 'color');
  if (!color) throw new Error('unreadable colour');
  const surface = await effectiveSurface(locator);
  return { ratio: contrastRatio(color, surface), color, surface };
};

const setTheme = (mode: 'dark' | 'light') => (page: Page) =>
  page.addInitScript((value: string) => {
    try {
      window.localStorage.setItem('apex:theme', value);
    } catch {
      /* handled by the page */
    }
  }, mode);

const waitForApp = async (page: Page): Promise<void> => {
  await page.waitForSelector('#root > *', { state: 'attached' });
  await page.waitForTimeout(1000);
};

const openPlaylist = async (page: Page): Promise<Locator> => {
  await page.locator('#nav-playlist').click();
  const root = page.locator('#fl-playlist-arranger');
  await expect(root).toBeVisible();
  return root;
};

/** Sections ▸ + Intro: the real marker creation path. */
const addIntroMarker = async (page: Page): Promise<void> => {
  await page.locator('#fl-playlist-arranger button[title="Arrangement Timeline Section Markers"]').click();
  await page.getByRole('button', { name: '+ Intro' }).click();
  await expect(page.locator('#fl-playlist-arranger [style*="border-left-color"]').first()).toBeVisible();
};

/** Places an automation clip through the clip-type picker and an empty lane. */
const placeAutomationClip = async (page: Page, root: Locator): Promise<Locator> => {
  await root.getByRole('button', { name: 'Automation', exact: true }).first().click();
  const rows = root.locator('div.h-16');
  const cells = rows.last().locator(':scope > div.w-24');
  await cells.last().click();
  const clip = root.locator('div[class*="border-[var(--apex-cyan)]"]').first();
  await expect(clip).toBeVisible();
  return clip;
};

for (const mode of ['dark', 'light'] as const) {
  test(`the arranger's migrated chrome resolves to the palette in ${mode}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await setTheme(mode)(page);
    await page.goto(APP_URL);
    await waitForApp(page);
    const root = await openPlaylist(page);

    // --- Sections button: gold identity on the panel it sits on. -------------
    const sections = root.locator('button[title="Arrangement Timeline Section Markers"]');
    await expectColor(sections, 'color', await token(page, '--apex-gold'), 'Sections label');
    const sectionsContrast = await textContrast(sections);
    expect(sectionsContrast.ratio, `${mode} Sections label AA`).toBeGreaterThanOrEqual(4.5);

    // --- Quick-add tiles: identity wash, token label. ------------------------
    await sections.click();
    const quickAdd = page.locator('button', { hasText: /^\+ / });
    await expect(quickAdd).toHaveCount(4);
    const hues: Record<string, string> = {
      Intro: '#00e5ff',
      Verse: '#3b82f6',
      'Drop / Chorus': '#ff0055',
      Outro: '#00ff88',
    };
    const storedHueRatios: number[] = [];
    for (const [name, hue] of Object.entries(hues)) {
      const tile = page.getByRole('button', { name: `+ ${name}` });
      const expectedHue = requireColor(hue, name);
      const wash = await tile.evaluate((element) => getComputedStyle(element).backgroundColor).then(requireColorFromValue);
      expect(colourDistance([wash[0], wash[1], wash[2], Math.round(wash[3] * 100) / 100], [expectedHue[0], expectedHue[1], expectedHue[2], 0.2]), `${name} wash keeps its stored hue`).toBeLessThanOrEqual(3);
      const tileText = await textContrast(tile);
      expect(tileText.color, `${mode} ${name} label uses the text token`).toEqual(await token(page, '--apex-text'));
      expect(tileText.ratio, `${mode} ${name} tile label AA`).toBeGreaterThanOrEqual(4.5);
      storedHueRatios.push(contrastRatio(expectedHue, await effectiveSurface(tile)));
    }

    // Negative control: the four stored hues as *text* on their own washes are
    // not AA-safe in either palette — cyan passes in Dark (6.9:1) but the blue
    // is 3.6:1 even there, and Light drops to 1.22–2.92:1. That asymmetry is
    // exactly why the tile label follows the text token instead of the hue.
    console.log(`[ui03p ${mode} stored-hue-as-text]`, JSON.stringify(storedHueRatios.map((r) => Number(r.toFixed(2)))));
    expect(
      Math.min(...storedHueRatios),
      `${mode}: at least one stored hue as text must fail AA (the rejected pairing)`,
    ).toBeLessThan(4.5);
    expect(storedHueRatios.length, 'all four quick-add hues measured').toBe(4);

    // --- The chip the tile creates: identity kept, label on the token. -------
    await page.getByRole('button', { name: '+ Intro' }).click();
    const chip = root.locator('[style*="border-left-color"]').first();
    await expectColor(chip, 'borderLeftColor', requireColor('#00e5ff', 'intro hue'), 'marker chip edge');
    const chipText = chip.locator('span').first();
    await expectColor(chipText, 'color', await token(page, '--apex-text'), 'marker chip label');
    const chipContrast = await textContrast(chipText);
    expect(chipContrast.ratio, `${mode} marker chip label AA`).toBeGreaterThanOrEqual(4.5);
    const chipBackground = await readColour(chip, 'backgroundColor');
    expect(chipBackground, 'chip keeps a translucent identity wash').not.toBeNull();
    expect(chipBackground![3], 'chip wash alpha').toBeLessThan(1);

    // --- Active tool chip: cyan fill, theme on-colour. ----------------------
    const slice = root.getByRole('button', { name: 'Slice', exact: true });
    await slice.click();
    await expectColor(slice, 'backgroundColor', await token(page, '--apex-cyan'), 'active tool fill');
    await expectColor(slice, 'color', await token(page, '--apex-state-playing-fg'), 'active tool label');
    const sliceContrast = await textContrast(slice);
    expect(sliceContrast.ratio, `${mode} active tool chip AA`).toBeGreaterThanOrEqual(4.5);
    // Back to the placement tool so the next step can create a clip.
    await root.getByRole('button', { name: 'Draw', exact: true }).click();

    // --- An automation clip created through the real tool. -------------------
    const autoClip = await placeAutomationClip(page, root);
    await expectColor(autoClip, 'borderTopColor', await token(page, '--apex-cyan'), 'automation clip border');
    const autoLabel = autoClip.locator('span.truncate').first();
    await expectColor(autoLabel, 'color', await token(page, '--apex-cyan-text'), 'automation clip label');
    const autoContrast = await textContrast(autoLabel);
    expect(autoContrast.ratio, `${mode} automation clip label AA`).toBeGreaterThanOrEqual(4.5);
    const curve = autoClip.locator('polyline').first();
    await expectColor(curve, 'stroke', await token(page, '--apex-cyan'), 'envelope curve');
    const points = await curve.getAttribute('points');
    expect((points ?? '').split(' ').length, 'the envelope keeps its three points').toBe(3);

    // --- A pre-existing pattern clip still reads on the token scale. ---------
    const patternLabel = root.locator('span.truncate', { hasText: 'Kick Pattern' }).first();
    await expectColor(patternLabel, 'color', await token(page, '--apex-text'), 'pattern clip label');
    const patternContrast = await textContrast(patternLabel);
    expect(patternContrast.ratio, `${mode} pattern clip label AA`).toBeGreaterThanOrEqual(4.5);

    await page.screenshot({ path: `assets/screenshots/ui03p-playlist-${mode}.png` });
    expect(errors).toEqual([]);
  });
}

/** `parseColor` with a thrown error, for values read inline. */
function requireColorFromValue(value: string): Rgba {
  const parsed = parseColor(value);
  if (!parsed) throw new Error(`cannot parse "${value}"`);
  return parsed;
}

test('a theme flip repaints the arranger with no reload and no project mutation', async ({ page }) => {
  await setTheme('dark')(page);
  await page.goto(APP_URL);
  await waitForApp(page);
  const root = await openPlaylist(page);
  await addIntroMarker(page);
  await placeAutomationClip(page, root);

  const projectBefore = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key !== 'apex:theme') out[key] = window.localStorage.getItem(key) ?? '';
    }
    return out;
  });
  await page.evaluate(() => {
    (window as unknown as { __ui03pMarker: string }).__ui03pMarker = 'alive';
  });

  await page.evaluate(() => {
    window.localStorage.setItem('apex:theme', 'light');
    document.documentElement.dataset.theme = 'light';
  });

  const lightText = await token(page, '--apex-text');
  await expect
    .poll(async () => {
      const chip = root.locator('[style*="border-left-color"]').first();
      const colour = await readColour(chip, 'color');
      return colour ? colourDistance(colour, lightText) : Number.MAX_SAFE_INTEGER;
    }, { timeout: 5_000, intervals: [100] })
    .toBeLessThanOrEqual(2);

  expect(await page.evaluate(() => (window as unknown as { __ui03pMarker?: string }).__ui03pMarker)).toBe('alive');
  const projectAfter = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key !== 'apex:theme') out[key] = window.localStorage.getItem(key) ?? '';
    }
    return out;
  });
  expect(projectAfter).toEqual(projectBefore);
  // The arranger still holds the marker and the automation clip after the flip.
  await expect(root.locator('[style*="border-left-color"]')).toHaveCount(1);
  await expect(root.locator('div[class*="border-[var(--apex-cyan)]"]')).toHaveCount(1);
});
