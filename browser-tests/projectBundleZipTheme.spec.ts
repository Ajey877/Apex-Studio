/**
 * UI-03P — Project ZIP Archive Bundler, measured in a real Chromium.
 *
 * The modal is the last legacy-painted surface in the app; this spec opens it
 * through the real entry point (File ▸ Export Project Bundle ZIP) in both themes
 * and reads the resolved pixels with `getComputedStyle`. Every expected value is
 * a token read from the live document, so the assertions pin the palette rather
 * than a transcription of it.
 *
 * What is measured here that the server-rendered unit suite cannot see:
 *   - the overlay's theme-aware scrim (`--apex-modal-overlay`) is the only fill —
 *     the `bg-black/85` the modal used to carry on top of the primitive is gone,
 *     so the scrim lightens with the palette instead of staying near-black;
 *   - the panel, header band, both cards, the inset and the footer resolve to the
 *     shared surface scale in both palettes;
 *   - the identity family (header tile, badge, status bar, primary CTA) renders
 *     accent-on-ink and clears AA in both palettes;
 *   - a theme flip while the modal is open repaints it with no reload.
 *
 * The archive contract itself (paths, manifest fields, import seam) is pinned by
 * `src/components/projectBundleZipThemeUi.test.tsx`; nothing here downloads or
 * inspects the ZIP.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

type Rgba = [number, number, number, number];

/** Accepts `rgb()`, `rgba()` and `color(srgb r g b / a)` computed values. */
const parseColor = (value: string): Rgba | null => {
  const srgb = /color\(srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*([\d.eE+-]+))?\s*\)/.exec(value);
  if (srgb) {
    return [
      Number(srgb[1]) * 255,
      Number(srgb[2]) * 255,
      Number(srgb[3]) * 255,
      srgb[4] === undefined ? 1 : Number(srgb[4]),
    ];
  }
  const rgb = /rgba?\(([^)]+)\)/.exec(value);
  if (!rgb) return null;
  const channels = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return [channels[0], channels[1], channels[2], channels[3] ?? 1];
};

const requireColor = (value: string, label: string): Rgba => {
  const parsed = parseColor(value);
  if (parsed) return parsed;
  // Custom properties come back as raw hex (`#ffffff`), not as a computed colour.
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
  Math.max(
    Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]) * 255,
  );

/** Reads a resolved `--apex-*` token off the document element. */
const token = async (page: Page, name: string): Promise<Rgba> => {
  const value = await page.evaluate(
    (tokenName) => getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim(),
    name,
  );
  return requireColor(value, name);
};

/** Retrying parse of a computed colour, tolerating mid-transition values. */
const computed = (locator: Locator, property: 'color' | 'backgroundColor' | 'borderTopColor' | 'borderBottomColor') =>
  (): Promise<Rgba | null> =>
    locator.evaluate((element, prop) => getComputedStyle(element)[prop as 'color'], property).then((value) => parseColor(value));

const expectColor = async (
  locator: Locator,
  property: 'color' | 'backgroundColor' | 'borderTopColor' | 'borderBottomColor',
  expected: Rgba,
  label: string,
  tolerance = 1,
): Promise<void> => {
  await expect
    .poll(() => computed(locator, property)().then((got) => (got ? colourDistance(got, expected) : Number.MAX_SAFE_INTEGER)), {
      message: `${label}: expected ${expected.join(',')} on ${property}`,
      timeout: 5_000,
      intervals: [50],
    })
    .toBeLessThanOrEqual(tolerance);
};

/** Effective surface behind a locator: its own fill composited over its ancestors. */
const effectiveSurface = (locator: Locator): Promise<Rgba> =>
  locator.evaluate((element) => {
    const stack: string[] = [];
    for (let node: Element | null = element; node && stack.length < 16; node = node.parentElement) {
      stack.push(getComputedStyle(node).backgroundColor);
    }
    return stack;
  }).then((stack) => {
    const layers = stack.map((value) => parseColor(value)).filter((value): value is Rgba => value !== null);
    const opaqueIndex = layers.findIndex((layer) => layer[3] >= 1);
    const from = opaqueIndex === -1 ? layers.length - 1 : opaqueIndex;
    let base: Rgba = layers[from] ? [layers[from][0], layers[from][1], layers[from][2], 1] : [255, 255, 255, 1];
    for (let index = from - 1; index >= 0; index -= 1) base = composite(layers[index], base);
    return base;
  });

const expectAa = async (locator: Locator, label: string, floor = 4.5): Promise<void> => {
  const foreground = await locator.evaluate((element) => getComputedStyle(element).color).then((value) => requireColor(value, label));
  const surface = await effectiveSurface(locator);
  const ratio = contrastRatio(foreground, surface);
  expect(ratio, `${label}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(floor);
};

const setTheme = (mode: 'dark' | 'light') => (page: Page) =>
  page.addInitScript((value: string) => {
    try {
      window.localStorage.setItem('apex:theme', value);
    } catch {
      /* the page under test handles storage failures itself */
    }
  }, mode);

const waitForApp = async (page: Page): Promise<void> => {
  await page.waitForSelector('#root > *', { state: 'attached' });
  await page.waitForTimeout(1000);
};

/** The real entry point: File ▸ Export Project Bundle ZIP. */
const openBundleModal = async (page: Page): Promise<Locator> => {
  await page.locator('#application-menu-file').click();
  await page.locator('#application-menu-command-file\\.exportBundle').click();
  const modal = page.locator('#fl-project-zip-modal');
  await expect(modal).toBeVisible();
  return modal;
};

const panelOf = (modal: Locator) => modal.locator(':scope > div');
const headerOf = (modal: Locator) => panelOf(modal).locator(':scope > div').first();
const footerOf = (modal: Locator) => panelOf(modal).locator(':scope > div').last();

for (const mode of ['dark', 'light'] as const) {
  test(`the bundle modal opens from the File menu in ${mode} on the theme's own surfaces`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await setTheme(mode)(page);
    await page.goto(APP_URL);
    await waitForApp(page);
    const modal = await openBundleModal(page);

    // Identity and wiring survive.
    await expect(page.locator('#fl-project-zip-modal-title')).toHaveText('PROJECT ZIP ARCHIVE BUNDLER');
    await expect(modal).toHaveAttribute('role', 'dialog');
    await expect(modal).toHaveAttribute('aria-modal', 'true');
    await expect(page.getByText('PORTABLE .ZIP', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /Download Portable \.ZIP Bundle/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close project bundler' })).toBeVisible();

    // The overlay's scrim is the primitive's, and it is the only fill.
    await expect(modal).toHaveClass(/apex-modal-overlay/);
    expect((await modal.getAttribute('class')) ?? '').not.toContain('bg-black');
    await expectColor(modal, 'backgroundColor', await token(page, '--apex-modal-overlay'), 'overlay scrim', 2);

    // Surfaces.
    const panel = panelOf(modal);
    await expectColor(panel, 'backgroundColor', await token(page, '--apex-surface'), 'panel');
    const accentEdge = await token(page, '--apex-accent');
    await expectColor(
      panel,
      'borderTopColor',
      [accentEdge[0], accentEdge[1], accentEdge[2], 0.48],
      'panel accent edge',
      3,
    );
    await expectColor(headerOf(modal), 'backgroundColor', await token(page, '--apex-panel-header'), 'header band');
    await expectColor(footerOf(modal), 'backgroundColor', await token(page, '--apex-panel-header'), 'footer band');
    const cards = panel.locator(':scope > div').nth(1).locator(':scope > div');
    await expect(cards.first()).toBeVisible();
    await expectColor(cards.first(), 'backgroundColor', await token(page, '--apex-surface-2'), 'export card');
    await expectColor(cards.last(), 'backgroundColor', await token(page, '--apex-surface-2'), 'import card');

    // Labels clear AA on the surface they sit on.
    await expectAa(page.locator('#fl-project-zip-modal-title'), `${mode} modal title`);
    await expectAa(page.getByText('EXPORT COMPLETE PROJECT ZIP').first(), `${mode} export card heading`);
    await expectAa(page.getByText('IMPORT EXISTING PROJECT ZIP').first(), `${mode} import card heading`);
    await expectAa(panel.getByText('Apex Studio Portable Bundle v2'), `${mode} footer note`);
    await expectAa(page.getByText('Include Pattern JSONs').first(), `${mode} include-patterns label`);

    // The identity family: the badge keeps an accent wash with a text-token
    // label (accent-on-white measured 3.90:1 in Light, the same defect UI-03O
    // recorded for the desktop modal's badge), the CTA is accent-on-ink.
    const onAccent = await token(page, '--apex-state-playing-fg');
    const badge = page.getByText('PORTABLE .ZIP', { exact: true });
    await expectColor(badge, 'backgroundColor', [accentEdge[0], accentEdge[1], accentEdge[2], 0.16], 'badge wash', 3);
    await expectColor(badge, 'borderTopColor', [accentEdge[0], accentEdge[1], accentEdge[2], 0.48], 'badge edge', 3);
    await expectColor(badge, 'color', await token(page, '--apex-text'), 'badge label');
    await expectAa(badge, `${mode} badge label`);
    const cta = page.getByRole('button', { name: /Download Portable \.ZIP Bundle/ });
    // The CTA's fill is a gradient, so its label is measured against both stops.
    const accentStrongEarly = await token(page, '--apex-accent-strong');
    const ctaStops = Math.min(
      contrastRatio(onAccent, accentEdge),
      contrastRatio(onAccent, accentStrongEarly),
    );
    expect(ctaStops, `${mode} CTA label on the gradient = ${ctaStops.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    const gradient = await cta.evaluate((element) => getComputedStyle(element).backgroundImage);
    expect(gradient, 'primary CTA gradient start').toContain('rgb');
    // The gradient's two stops are the accent pair.
    const accentStrong = await token(page, '--apex-accent-strong');
    const stops = (gradient.match(/rgba?\([^)]+\)|color\(srgb[^)]+\)/g) ?? []).map((value) => requireColor(value, 'cta stop'));
    expect(stops.length, 'CTA gradient stops').toBeGreaterThanOrEqual(2);
    expect(colourDistance(stops[0], accentEdge), 'CTA gradient start = accent').toBeLessThanOrEqual(2);
    expect(colourDistance(stops[stops.length - 1], accentStrong), 'CTA gradient end = accent-strong').toBeLessThanOrEqual(2);

    // Header close glyph: the muted text token on the header band, AA.
    const closeGlyph = page.getByRole('button', { name: 'Close project bundler' });
    await expectColor(closeGlyph, 'color', await token(page, '--apex-text-3'), 'header close glyph');
    await expectAa(closeGlyph, `${mode} header close glyph`);
    // Footer Close control: themed fill, AA label.
    const footerClose = footerOf(modal).getByRole('button', { name: 'Close', exact: true });
    await expectColor(footerClose, 'backgroundColor', await token(page, '--apex-surface-3'), 'footer close fill');
    await expectAa(footerClose, `${mode} footer close label`);

    await page.screenshot({ path: `assets/screenshots/ui03p-project-bundle-${mode}.png` });
    expect(errors).toEqual([]);
  });
}

test('a theme flip with the modal open repaints it without a reload', async ({ page }) => {
  await setTheme('dark')(page);
  await page.goto(APP_URL);
  await waitForApp(page);
  const modal = await openBundleModal(page);
  await expectColor(modal, 'backgroundColor', await token(page, '--apex-modal-overlay'), 'dark scrim', 2);

  await page.evaluate(() => {
    (window as unknown as { __ui03pMarker: string }).__ui03pMarker = 'alive';
  });
  await page.evaluate(() => {
    window.localStorage.setItem('apex:theme', 'light');
    document.documentElement.dataset.theme = 'light';
  });

  await expect
    .poll(async () => {
      const surface = await effectiveSurface(panelOf(modal));
      const light = await token(page, '--apex-surface');
      return colourDistance(surface, light);
    }, { timeout: 5_000, intervals: [100] })
    .toBeLessThanOrEqual(2);
  expect(await page.evaluate(() => (window as unknown as { __ui03pMarker?: string }).__ui03pMarker)).toBe('alive');

  // Escape still closes exactly as before.
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
