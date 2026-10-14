/**
 * UI-03P — Piano Roll residual migration, measured in a real Chromium.
 *
 * The Piano Roll was already tokenised; this spec covers the five literals the
 * batch replaced and the one measured defect it fixed:
 *
 *   - the four outline controls (Strum Chords, Extract 808 Bass, Ghost, Import
 *     .mid, Export .mid) resolve their borders through `color-mix()` on the cyan,
 *     gold and success tokens;
 *   - their labels clear AA on the toolbar surface in **both** palettes, and the
 *     literal/token pair that used to paint the cyan labels is shown to fail —
 *     `--apex-cyan` is 4.30:1 on the Light toolbar, which is why the labels moved
 *     to `--apex-cyan-text` (identical in Dark, darker in Light: 7.39:1);
 *   - the note-resize handles paint a real overlay: hovering a handle changes the
 *     computed background, and it is the theme ink rather than a black wash.
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

const colourDistance = (a: Rgba, b: Rgba): number =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]) * 255);

const token = async (page: Page, name: string): Promise<Rgba> => {
  const value = await page.evaluate(
    (tokenName) => getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim(),
    name,
  );
  return requireColor(value, name);
};

const readColour = (locator: Locator, property: 'color' | 'backgroundColor' | 'borderTopColor') =>
  locator.evaluate((element, prop) => getComputedStyle(element)[prop as 'color'], property).then((value) => parseColor(value));

const expectColor = async (
  locator: Locator,
  property: 'color' | 'backgroundColor' | 'borderTopColor',
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

/**
 * Compares the RGB channels only. The handle overlays are `color-mix()`ed with
 * `transparent`, so their alpha (0.2 / 0.4) is the point; the hue is what must
 * be the theme ink rather than a black wash.
 */
const expectColorRgb = async (
  locator: Locator,
  property: 'color' | 'backgroundColor' | 'borderTopColor',
  expected: Rgba,
  label: string,
  tolerance = 3,
): Promise<void> => {
  await expect
    .poll(
      () =>
        readColour(locator, property).then((got) =>
          got ? Math.max(Math.abs(got[0] - expected[0]), Math.abs(got[1] - expected[1]), Math.abs(got[2] - expected[2])) : Number.MAX_SAFE_INTEGER,
        ),
      { message: `${label}: expected rgb ${expected.slice(0, 3).map(Math.round).join(',')}`, timeout: 5_000, intervals: [50] },
    )
    .toBeLessThanOrEqual(tolerance);
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

const openPianoRoll = async (page: Page): Promise<Locator> => {
  await page.locator('#nav-piano-roll').click();
  const root = page.locator('#piano-roll-container');
  await expect(root).toBeVisible();
  return root;
};

/** The toolbar control that owns a given label, selected by its visible text. */
const controlFor = (root: Locator, label: string): Locator =>
  root.locator('button, label').filter({ has: root.page().getByText(label, { exact: true }) }).first();

for (const mode of ['dark', 'light'] as const) {
  test(`the Piano Roll toolbar resolves through the palette in ${mode}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await setTheme(mode)(page);
    await page.goto(APP_URL);
    await waitForApp(page);
    const root = await openPianoRoll(page);

    const surface = await page.evaluate(() => {
      const root = document.getElementById('piano-roll-container');
      const bar = root?.querySelector('div');
      return bar ? getComputedStyle(bar).backgroundColor : '';
    });
    expect(surface, 'toolbar band resolves a background').not.toBe('');

    // Four controls keep their outlines on the status tokens; their labels use
    // the text variants and clear AA on the toolbar surface.
    const cyan30 = await token(page, '--apex-cyan');
    const gold40 = await token(page, '--apex-gold');
    const success30 = await token(page, '--apex-success');
    const cases: Array<{ label: string; edge: Rgba; edgeAlpha: number; text: string }> = [
      { label: 'Strum Chords', edge: cyan30, edgeAlpha: 0.3, text: '--apex-cyan-text' },
      { label: 'Extract 808 Bass', edge: gold40, edgeAlpha: 0.4, text: '--apex-gold' },
      { label: 'Ghost', edge: success30, edgeAlpha: 0.4, text: '--apex-success' },
      { label: 'Import .mid', edge: cyan30, edgeAlpha: 0.3, text: '--apex-cyan-text' },
      { label: 'Export .mid', edge: success30, edgeAlpha: 0.3, text: '--apex-success' },
    ];
    for (const entry of cases) {
      const control = root.locator('button, label').filter({ hasText: entry.label }).first();
      await expect(control).toBeVisible();
      await expectColor(
        control,
        'borderTopColor',
        [entry.edge[0], entry.edge[1], entry.edge[2], entry.edgeAlpha],
        `${entry.label} outline`,
        3,
      );
      const label = control.getByText(entry.label, { exact: true });
      await expectColor(label, 'color', await token(page, entry.text), `${entry.label} label`);
      // AA against the control's own fill, which is the surface the text sits on.
      const fill = await control.evaluate((element) => getComputedStyle(element).backgroundColor).then(requireColorFrom);
      const colour = await readColour(label, 'color');
      const ratio = contrastRatio(colour!, fill);
      expect(ratio, `${mode} ${entry.label} label AA (${ratio.toFixed(2)}:1)`).toBeGreaterThanOrEqual(4.5);
    }

    // The negative control: the decorative cyan token on this surface fails AA in
    // Light — it is what the labels used before this batch.
    const toolbarSurface = await page.evaluate(() => {
      const control = [...document.querySelectorAll<HTMLElement>('#piano-roll-container button')].find(
        (element) => element.textContent?.trim() === 'Strum Chords',
      );
      return control ? getComputedStyle(control).backgroundColor : '';
    }).then(requireColorFrom);
    const decorativeRatio = contrastRatio(cyan30, toolbarSurface);
    if (mode === 'light') {
      expect(decorativeRatio, `light: --apex-cyan on the toolbar = ${decorativeRatio.toFixed(2)}:1`).toBeLessThan(4.5);
    }
    expect(contrastRatio(await token(page, '--apex-cyan-text'), toolbarSurface)).toBeGreaterThanOrEqual(4.5);

    // The note-resize handles paint a real overlay on hover, in the theme ink.
    const handle = root.locator('[aria-label="Resize note end"]').first();
    await expect(handle).toBeVisible();
    const idle = await readColour(handle, 'backgroundColor');
    await handle.hover();
    await expect
      .poll(async () => (await readColour(handle, 'backgroundColor'))?.[3] ?? 0, { timeout: 5_000, intervals: [50] })
      .toBeGreaterThan(0);
    const hovered = await readColour(handle, 'backgroundColor');
    expect(idle?.[3] ?? 0, 'the handle overlay is transparent at rest').toBe(0);
    // The overlay is the theme ink: #0d0f16 in Dark, #ffffff in Light — a
    // black wash before this batch, which was invisible on Dark notes.
    const ink = await token(page, '--apex-state-playing-fg');
    await expectColorRgb(handle, 'backgroundColor', ink, 'handle hover overlay');
    expect(hovered?.[3] ?? 0, 'handle hover mixes 20% ink').toBeCloseTo(0.2, 1);
    const grip = handle.locator('div').first();
    await expectColorRgb(grip, 'backgroundColor', ink, 'handle grip');
    const gripFill = await readColour(grip, 'backgroundColor');
    expect(gripFill?.[3] ?? 0, 'the grip mixes 40% ink').toBeCloseTo(0.4, 1);

    await page.screenshot({ path: `assets/screenshots/ui03p-piano-roll-${mode}.png` });
    expect(errors).toEqual([]);
  });
}

function requireColorFrom(value: string): Rgba {
  const parsed = parseColor(value);
  if (!parsed) throw new Error(`cannot parse "${value}"`);
  return parsed;
}

test('a theme flip repaints the open Piano Roll with no reload', async ({ page }) => {
  await setTheme('dark')(page);
  await page.goto(APP_URL);
  await waitForApp(page);
  const root = await openPianoRoll(page);
  const control = root.locator('button, label').filter({ hasText: 'Import .mid' }).first();
  const darkCyan = await token(page, '--apex-cyan');
  await expectColor(control, 'borderTopColor', [darkCyan[0], darkCyan[1], darkCyan[2], 0.3], 'dark outline', 3);

  await page.evaluate(() => {
    (window as unknown as { __ui03pMarker: string }).__ui03pMarker = 'alive';
    window.localStorage.setItem('apex:theme', 'light');
    document.documentElement.dataset.theme = 'light';
  });

  // The border keeps its 30 % mix; the hue is what flips with the palette.
  const lightCyan = await token(page, '--apex-cyan');
  await expectColorRgb(control, 'borderTopColor', lightCyan, 'light outline');
  expect(await page.evaluate(() => (window as unknown as { __ui03pMarker?: string }).__ui03pMarker)).toBe('alive');
});
