import { expect, test, type Page } from '@playwright/test';

/** Matches the URL the existing browser suite and `webServer` config both use. */
const APP_URL = 'http://localhost:3000';

/**
 * UI-03B — the Mastering Suite in both themes, verified against a real browser.
 *
 * What the DOM-level tests cannot prove happens here: that the suite actually
 * opens in Dark and Light, that its surfaces resolve the semantic tokens to
 * different pixels per theme, that the canvas repaints when the theme flips
 * without a reload (and again when the modal is reopened), that the band
 * identity colours survive in computed style, and that none of this touches
 * the stored project or the mastering parameters.
 *
 * The canvas probe samples the goniometer's corner pixel: that corner is the
 * palette seam's `scopeBackground` fill and nothing else, so it is a direct
 * read of which palette the draw loop is currently using.
 */

const THEME_SET = (mode: 'dark' | 'light') => (page: Page) =>
  page.addInitScript((value: string) => {
    try {
      window.localStorage.setItem('apex:theme', value);
    } catch {
      /* the page under test handles storage failures itself */
    }
  }, mode);

const waitForApp = async (page: Page) => {
  await page.waitForSelector('#root > *', { state: 'attached' });
  await page.waitForTimeout(1200);
};

/** Opens the suite through the transport Tools menu, the production path. */
const openMasteringSuite = async (page: Page) => {
  await page.locator('#fl-tools-menu-btn').click();
  await page.locator('#fl-mastering-suite-btn').click();
  const dialog = page.locator('[role="dialog"]:has(#mastering-suite-modal-title)');
  await expect(dialog).toBeVisible();
  // Let the rAF draw loop paint at least one frame before sampling pixels.
  await page.waitForTimeout(600);
  return dialog;
};

const masteringDialog = (page: Page) =>
  page.locator('[role="dialog"]:has(#mastering-suite-modal-title)');

const switchThemeViaSettings = async (page: Page, mode: 'dark' | 'light') => {
  await page.locator('button[aria-label="Open Settings"]').first().click();
  const settings = page.locator('#appearance-settings-modal');
  await expect(settings).toBeVisible();
  await settings.locator(`label:has(input[value="${mode}"])`).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
};

/**
 * Commits the theme at the document level — exactly the DOM effect
 * `commitThemeSelection` produces — without needing to reach the Settings
 * dialog. Required while the mastering suite is open: its scrim is a
 * full-viewport `fixed inset-0` overlay, so nothing behind it is clickable.
 * The Settings flow itself is covered by `themeRuntime.spec.ts`.
 */
const flipDocumentTheme = (page: Page, mode: 'dark' | 'light') =>
  page.evaluate((value) => {
    try {
      window.localStorage.setItem('apex:theme', value);
    } catch {
      /* the page under test handles storage failures itself */
    }
    document.documentElement.dataset.theme = value;
  }, mode);

interface CanvasProbe {
  /** Corner pixel of the goniometer: the seam's scope background fill. */
  corner: [number, number, number];
  /** Computed background of the scope's wrapper — the same token via CSS. */
  wrapperBackground: [number, number, number];
}

const probeGoniometer = (page: Page): Promise<CanvasProbe> =>
  page.evaluate(() => {
    // Computed colours come back as `rgb(...)` for plain channels but as
    // `color(srgb ...)` (0..1 floats) when they were resolved through
    // color-mix — Chromium picks the notation, so handle both.
    const parse = (value: string): [number, number, number] => {
      const rgb = /rgba?\(([^)]+)\)/.exec(value);
      if (rgb) {
        const parts = rgb[1].split(',').map((part) => parseFloat(part));
        return [parts[0], parts[1], parts[2]];
      }
      const srgb = /color\(srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/.exec(value);
      if (srgb) {
        return [
          parseFloat(srgb[1]) * 255,
          parseFloat(srgb[2]) * 255,
          parseFloat(srgb[3]) * 255,
        ];
      }
      return [0, 0, 0];
    };
    // Scoped to the mastering dialog so no other surface's canvas can match.
    const dialog = document
      .getElementById('mastering-suite-modal-title')
      ?.closest('[role="dialog"]');
    const canvas = dialog?.querySelector<HTMLCanvasElement>('canvas[width="280"]') ?? null;
    if (!canvas) throw new Error('goniometer canvas not rendered');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('goniometer has no 2d context');
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    const wrapper = canvas.parentElement;
    if (!wrapper) throw new Error('goniometer canvas has no wrapper');
    return {
      corner: [pixel[0], pixel[1], pixel[2]],
      wrapperBackground: parse(getComputedStyle(wrapper).backgroundColor),
    };
  });

const channelClose = (actual: number, expected: number, tolerance = 10) =>
  Math.abs(actual - expected) <= tolerance;

const pixelsClose = (
  actual: [number, number, number],
  expected: [number, number, number],
  tolerance = 10
) => actual.every((channel, index) => channelClose(channel, expected[index], tolerance));

const panelBackground = (page: Page) =>
  page.evaluate(() => {
    const panel = document
      .getElementById('mastering-suite-modal-title')
      ?.closest('[role="dialog"] > div');
    if (!panel) throw new Error('mastering panel not rendered');
    return getComputedStyle(panel).backgroundColor;
  });

test('the suite opens in Dark and its chrome resolves the dark palette', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await THEME_SET('dark')(page);
  await page.goto(APP_URL);
  await waitForApp(page);

  const dialog = await openMasteringSuite(page);
  await expect(page.locator('#mastering-suite-modal-title')).toHaveText('APEX MASTERING SUITE');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');

  // The panel surface is the dark --apex-surface token, not a legacy literal.
  expect(await panelBackground(page)).toBe('rgb(25, 28, 37)');

  // Canvas chrome follows the same token the wrapper resolves through CSS:
  // the draw loop and the stylesheet agree on the dark inset surface.
  const probe = await probeGoniometer(page);
  expect(pixelsClose(probe.corner, probe.wrapperBackground)).toBe(true);
  expect(probe.corner[0]).toBeLessThan(60); // a dark scope in the dark theme

  await page.screenshot({ path: 'assets/screenshots/ui03b-mastering-dark.png' });
  await dialog.locator('button:has-text("3-Band Multiband Dynamics")').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'assets/screenshots/ui03b-mastering-dark-multiband.png' });
  expect(errors).toEqual([]);
});

test('the suite opens in Light and its chrome resolves the light palette', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await THEME_SET('light')(page);
  await page.goto(APP_URL);
  await waitForApp(page);

  await openMasteringSuite(page);
  expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
  expect(await panelBackground(page)).toBe('rgb(255, 255, 255)');

  const probe = await probeGoniometer(page);
  expect(pixelsClose(probe.corner, probe.wrapperBackground)).toBe(true);
  expect(probe.corner[0]).toBeGreaterThan(180); // a light scope in the light theme

  await page.screenshot({ path: 'assets/screenshots/ui03b-mastering-light.png' });
  await masteringDialog(page).locator('button:has-text("3-Band Multiband Dynamics")').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'assets/screenshots/ui03b-mastering-light-multiband.png' });
  expect(errors).toEqual([]);
});

test('switching themes while the suite is open repaints DOM and canvas without a reload', async ({ page }) => {
  await THEME_SET('dark')(page);
  await page.goto(APP_URL);
  await waitForApp(page);

  const projectBefore = await page.evaluate(() => window.localStorage.getItem('apex:project'));
  const statusBefore = await page.locator('#studio-status-bar').innerText();

  await openMasteringSuite(page);
  const darkProbe = await probeGoniometer(page);
  const darkPanel = await panelBackground(page);

  // Sample a stored control from the multiband tab, then return to metering:
  // the goniometer canvas only exists there, and it is what the repaint probe
  // below reads.
  await masteringDialog(page).locator('button:has-text("3-Band Multiband Dynamics")').click();
  const crossoverBefore = await masteringDialog(page)
    .locator('input[data-control-id="lowCrossFreq"]')
    .evaluate((el: HTMLInputElement) => el.value);
  await masteringDialog(page).locator('button:has-text("LUFS Loudness & Peak")').click();
  await page.waitForTimeout(600);

  // The suite's scrim covers the viewport, so Settings is not reachable while
  // it is open; commit the flip at the document level instead (same DOM write
  // the Settings flow produces — see flipDocumentTheme).
  await flipDocumentTheme(page, 'light');

  // The suite stayed open through the flip and repaints in place.
  await expect(masteringDialog(page)).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect
    .poll(async () => (await panelBackground(page)) !== darkPanel, { timeout: 5000 })
    .toBe(true);
  await expect
    .poll(
      async () => {
        const probe = await probeGoniometer(page);
        return pixelsClose(probe.corner, probe.wrapperBackground) && probe.corner[0] > 180;
      },
      { timeout: 5000 }
    )
    .toBe(true);

  // The canvas palette genuinely changed — not merely the CSS around it.
  const lightProbe = await probeGoniometer(page);
  expect(pixelsClose(lightProbe.corner, darkProbe.corner)).toBe(false);

  // Mastering parameters and the stored project are untouched by a display flip.
  await masteringDialog(page).locator('button:has-text("3-Band Multiband Dynamics")').click();
  const crossoverAfter = await masteringDialog(page)
    .locator('input[data-control-id="lowCrossFreq"]')
    .evaluate((el: HTMLInputElement) => el.value);
  expect(crossoverAfter).toBe(crossoverBefore);
  expect(await page.evaluate(() => window.localStorage.getItem('apex:project'))).toBe(projectBefore);
  expect(await page.locator('#studio-status-bar').innerText()).toBe(statusBefore);

  await page.screenshot({ path: 'assets/screenshots/ui03b-mastering-light-after-live-switch.png' });
});

test('reopening the suite after a theme change shows no stale canvas palette', async ({ page }) => {
  await THEME_SET('dark')(page);
  await page.goto(APP_URL);
  await waitForApp(page);

  // Open in dark, close, flip the theme while shut, reopen: the first frame
  // the suite paints must already be the light palette.
  await openMasteringSuite(page);
  await masteringDialog(page).locator('button[aria-label="Close mastering suite"]').click();
  await expect(masteringDialog(page)).toBeHidden();

  await switchThemeViaSettings(page, 'light');

  await page.locator('#fl-tools-menu-btn').click();
  await page.locator('#fl-mastering-suite-btn').click();
  await expect(masteringDialog(page)).toBeVisible();
  await page.waitForTimeout(600);

  expect(await panelBackground(page)).toBe('rgb(255, 255, 255)');
  const probe = await probeGoniometer(page);
  expect(pixelsClose(probe.corner, probe.wrapperBackground)).toBe(true);
  expect(probe.corner[0]).toBeGreaterThan(180);
});

test('band identity accents survive in both themes', async ({ page }) => {
  const bandColor = async (band: 'low' | 'mid' | 'high') =>
    page.evaluate((key) => {
      const dot = document.querySelector(`[data-band-accent="${key}"]`);
      if (!dot) throw new Error(`band accent ${key} not rendered`);
      return getComputedStyle(dot).backgroundColor;
    }, band);

  await THEME_SET('dark')(page);
  await page.goto(APP_URL);
  await waitForApp(page);
  await openMasteringSuite(page);
  await masteringDialog(page).locator('button:has-text("3-Band Multiband Dynamics")').click();
  await expect(masteringDialog(page).locator('[data-band-accent="low"]')).toBeVisible();

  // The exact legacy literals, untouched by the chrome migration.
  expect(await bandColor('low')).toBe('rgb(255, 170, 0)');
  expect(await bandColor('mid')).toBe('rgb(0, 255, 136)');
  expect(await bandColor('high')).toBe('rgb(0, 229, 255)');

  // Same identities in Light: identical hues, darkened for legibility. The
  // suite closes first because its scrim would cover the Settings dialog.
  await masteringDialog(page).locator('button[aria-label="Close mastering suite"]').click();
  await expect(masteringDialog(page)).toBeHidden();
  await switchThemeViaSettings(page, 'light');
  await openMasteringSuite(page);
  await masteringDialog(page).locator('button:has-text("3-Band Multiband Dynamics")').click();
  await expect(masteringDialog(page).locator('[data-band-accent="low"]')).toBeVisible();
  expect(await bandColor('low')).toBe('rgb(138, 92, 0)');
  expect(await bandColor('mid')).toBe('rgb(12, 122, 74)');
  expect(await bandColor('high')).toBe('rgb(0, 100, 128)');
});
