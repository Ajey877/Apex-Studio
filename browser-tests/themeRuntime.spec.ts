import { expect, test, type Page } from '@playwright/test';

/** Matches the URL the existing browser suite and `webServer` config both use. */
const APP_URL = 'http://localhost:3000';

/**
 * UI-03A — Light/Dark theme foundation, verified against a real browser.
 *
 * These are the guarantees that cannot be proven by reading source: that the
 * stored preference reaches the document before React's first commit, that the
 * switch is immediate and survives a reload, that hostile storage cannot stop
 * startup, and that the shell is actually readable in both palettes.
 *
 * The scan below is deliberately scoped to the shell and the Settings dialog —
 * the surfaces this phase migrated. Channel-rack identity colours, the sample
 * browser and canvas-rendered panels still carry component-level literals; those
 * are recorded as remaining migration work rather than asserted here.
 */

const SHELL_SELECTORS = [
  '#application-menu-bar',
  '#fl-transport-bar',
  '#fl-view-tabs',
  '#studio-status-bar',
  '#appearance-settings-modal',
] as const;

const THEME_SET = (mode: 'dark' | 'light') => (page: Page) =>
  page.addInitScript((value: string) => {
    try {
      window.localStorage.setItem('apex:theme', value);
    } catch {
      /* the page under test handles storage failures itself */
    }
  }, mode);

/**
 * Records what `<html data-theme>` held at the exact moment the React root node
 * was parsed, plus every distinct value the attribute took afterwards.
 *
 * The root node is inserted by the HTML parser, before any module script runs, so
 * the recorded value is the palette the very first frame is painted with. A
 * `null` here means nothing had chosen a palette yet — the flash this phase
 * removes.
 *
 * `rootCaptured` is a separate flag on purpose. `atRootInsert === null` cannot be
 * used as the "not captured yet" sentinel, because `null` is also a legitimate
 * observation: with the pre-paint bootstrap missing, the attribute really is
 * unset when the root is parsed, and a later React `useLayoutEffect` would then
 * overwrite that first `null` with the correct theme and conceal the regression.
 */
const RECORD_THEME_AT_ROOT = (page: Page) =>
  page.addInitScript(() => {
    const probe = { atRootInsert: null as string | null, rootCaptured: false, seen: [] as string[] };
    (window as unknown as { __themeProbe: typeof probe }).__themeProbe = probe;
    const note = () => {
      const value = document.documentElement?.dataset.theme ?? null;
      if (!probe.rootCaptured && document.getElementById('root')) {
        probe.atRootInsert = value;
        probe.rootCaptured = true;
      }
      if (value !== null && probe.seen[probe.seen.length - 1] !== value) probe.seen.push(value);
    };
    // Observing the Document node survives the parser replacing documentElement.
    new MutationObserver(note).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    note();
  });

/** Reads the probe the helper above installs. */
const readThemeProbe = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as {
        __themeProbe: { atRootInsert: string | null; rootCaptured: boolean; seen: string[] };
      }).__themeProbe
  );

const waitForApp = async (page: Page) => {
  await page.waitForSelector('#root > *', { state: 'attached' });
  await page.waitForTimeout(1200);
};

const readTheme = (page: Page) =>
  page.evaluate(() => ({
    attr: document.documentElement.dataset.theme,
    colorScheme: getComputedStyle(document.documentElement).colorScheme,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
  }));

test('the stored theme is on the document before React renders its first commit', async ({ page }) => {
  await THEME_SET('light')(page);
  await RECORD_THEME_AT_ROOT(page);
  await page.goto(APP_URL);
  await waitForApp(page);

  const probe = await readThemeProbe(page);
  expect(probe.rootCaptured).toBe(true);
  // The React root is parsed after the inline bootstrap, so the palette is already
  // decided by the time the root node exists. Without the bootstrap this is null —
  // see the dedicated regression test below, which proves it cannot be concealed.
  expect(probe.atRootInsert).toBe('light');
  // Nothing ever repainted the document with the other theme along the way.
  expect(probe.seen).toEqual(['light']);

  const theme = await readTheme(page);
  expect(theme.attr).toBe('light');
  expect(theme.colorScheme).toBe('light');
});

test('the dark default is applied the same way when nothing is stored', async ({ page }) => {
  await RECORD_THEME_AT_ROOT(page);
  await page.goto(APP_URL);
  await waitForApp(page);
  const probe = await readThemeProbe(page);
  expect(probe.rootCaptured).toBe(true);
  expect(probe.atRootInsert).toBe('dark');
  expect(probe.seen).toEqual(['dark']);
  const theme = await readTheme(page);
  expect(theme.attr).toBe('dark');
  expect(theme.colorScheme).toBe('dark');
});

/**
 * Regression guard for the probe itself.
 *
 * The pre-paint bootstrap is a real production mechanism, so this test removes it
 * rather than mocking the observation: the dev server's own document is served
 * back with that one inline script stripped, and everything else — React, the
 * theme state module, the layout effect — stays exactly as it ships.
 *
 * With a correct probe, the first observation (nothing had chosen a palette when
 * the root was parsed) survives as `null` even though React reaches the right
 * palette moments later in a layout effect. With the previous sentinel bug,
 * `atRootInsert === null` was indistinguishable from "not captured yet", the
 * later `light` update overwrote it, and this test would have reported the
 * pre-paint guarantee as satisfied when it was not.
 */
test('a missing pre-paint bootstrap cannot be concealed by the React layout effect', async ({ page, request }) => {
  await THEME_SET('light')(page);
  await RECORD_THEME_AT_ROOT(page);

  const response = await request.get(`${APP_URL}/`);
  const html = await response.text();
  const withoutBootstrap = html.replace(/<script>try\{document\.documentElement\.dataset\.theme[\s\S]*?<\/script>/, '');
  // If the script ever moves or is renamed, fail loudly here instead of silently
  // asserting nothing about the pre-paint path.
  expect(withoutBootstrap).not.toBe(html);
  expect(withoutBootstrap).not.toContain('documentElement.dataset.theme');

  await page.route(`${APP_URL}/`, route =>
    route.fulfill({ status: 200, contentType: 'text/html', body: withoutBootstrap })
  );

  await page.goto(APP_URL);
  await waitForApp(page);

  const probe = await readThemeProbe(page);
  // React still lands on the stored preference, in a layout effect, with no flash
  // of the other theme — the app-level behaviour is not what is under test here.
  expect(probe.seen).toContain('light');
  expect(probe.seen).not.toContain('dark');
  expect((await readTheme(page)).attr).toBe('light');

  // The probe must not let that later update stand in for the missing pre-paint
  // step: the root's first observation was "no palette chosen yet", and it stays
  // that way.
  expect(probe.rootCaptured).toBe(true);
  expect(probe.atRootInsert).toBeNull();
});

test('switching to Light in Settings applies immediately, persists and spares the project', async ({ page }) => {
  // Seeded through the live page rather than an init script: an init script runs on
  // every navigation, so it would overwrite the preference that the reload below
  // is meant to prove survived.
  await page.goto(APP_URL);
  await waitForApp(page);
  await page.evaluate(() => window.localStorage.setItem('apex:theme', 'dark'));
  await page.reload();
  await waitForApp(page);
  const darkBackground = (await readTheme(page)).bodyBackground;
  expect(darkBackground).toBe('rgb(17, 19, 26)');

  const projectBefore = await page.locator('#studio-status-bar').innerText();

  await page.locator('button[aria-label="Open Settings"]').first().click();
  const dialog = page.locator('#appearance-settings-modal');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog).toHaveAttribute('aria-labelledby', 'appearance-settings-modal-title');

  await dialog.locator('label:has(input[value="light"])').click();

  // Immediate: no reload, no navigation — the attribute and the palette flip in place.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect
    .poll(async () => (await readTheme(page)).colorScheme, { timeout: 5000 })
    .toBe('light');
  expect(await page.evaluate(() => window.localStorage.getItem('apex:theme'))).toBe('light');

  // The project, transport and mixer state are untouched by a display preference.
  expect(await page.locator('#studio-status-bar').innerText()).toBe(projectBefore);

  // Dismissal follows the shared modal convention.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Persistence across a full reload, re-applied pre-paint.
  await page.reload();
  await waitForApp(page);
  const afterReload = await readTheme(page);
  expect(afterReload.attr).toBe('light');
  expect(afterReload.colorScheme).toBe('light');
  expect(afterReload.bodyBackground).not.toBe(darkBackground);
});

test('the View menu exposes a working Settings command', async ({ page }) => {
  await page.goto(APP_URL);
  await waitForApp(page);
  await page.locator('#application-menu-view').click();
  const item = page.locator('#application-menu-command-view\\.settings');
  await expect(item).toBeVisible();
  await expect(item).toHaveText(/Settings/);
  await item.click();
  await expect(page.locator('#appearance-settings-modal')).toBeVisible();
});

test('an unrecognised stored theme falls back to dark instead of breaking startup', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await THEME_SET('sepia' as 'dark')(page);
  await page.goto(APP_URL);
  await waitForApp(page);
  expect((await readTheme(page)).attr).toBe('dark');
  expect(errors).toEqual([]);
});

test('a storage backend that throws on access still boots', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage blocked');
      },
    });
  });
  await page.goto(APP_URL);
  await waitForApp(page);
  expect((await readTheme(page)).attr).toBe('dark');
  await expect(page.locator('#application-menu-bar')).toBeVisible();
  expect(errors).toEqual([]);
});

test('shell and Settings text reach WCAG AA in both themes', async ({ page }) => {
  const SCAN = (selectors: readonly string[]) => {
    const parse = (value: string) => {
      const match = /rgba?\(([^)]+)\)/.exec(value);
      if (!match) return null;
      const parts = match[1].split(',').map(part => parseFloat(part));
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const over = (fg: { r: number; g: number; b: number; a: number }, bg: { r: number; g: number; b: number }) => ({
      r: fg.r * fg.a + bg.r * (1 - fg.a),
      g: fg.g * fg.a + bg.g * (1 - fg.a),
      b: fg.b * fg.a + bg.b * (1 - fg.a),
      a: 1,
    });
    const luminance = (color: { r: number; g: number; b: number }) => {
      const channel = (value: number) => {
        const v = value / 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    };
    const ratio = (a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }) => {
      const first = luminance(a);
      const second = luminance(b);
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    };
    const effectiveBackground = (element: Element) => {
      let node: Element | null = element;
      let accumulated: { r: number; g: number; b: number; a: number } | null = null;
      while (node) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color.a > 0) {
          accumulated = accumulated ? over(accumulated, color) : color;
          if (accumulated.a >= 0.999) return accumulated;
        }
        node = node.parentElement;
      }
      return accumulated ?? { r: 255, g: 255, b: 255, a: 1 };
    };

    const failures: string[] = [];
    for (const selector of selectors) {
      const root = document.querySelector(selector);
      // A missing surface would silently pass, so it fails loudly instead.
      if (!root) {
        failures.push(`${selector} is not rendered`);
        continue;
      }
      for (const element of root.querySelectorAll('*')) {
        const text = Array.from(element.childNodes)
          .filter(node => node.nodeType === 3)
          .map(node => (node.textContent ?? '').trim())
          .join(' ')
          .trim();
        if (text.length < 2) continue;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        const rect = element.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) continue;
        const foreground = parse(style.color);
        if (!foreground) continue;
        const background = effectiveBackground(element);
        const composed = foreground.a < 1 ? over(foreground, background) : foreground;
        const size = parseFloat(style.fontSize);
        const weight = parseInt(style.fontWeight, 10) || 400;
        const large = size >= 24 || (size >= 18.66 && weight >= 700);
        const minimum = large ? 3 : 4.5;
        const measured = ratio(composed, background);
        if (measured < minimum) {
          failures.push(
            `${selector} "${text.slice(0, 40)}" ${measured.toFixed(2)}:1 < ${minimum}:1 (${style.color})`
          );
        }
      }
    }
    return failures;
  };

  for (const mode of ['dark', 'light'] as const) {
    await THEME_SET(mode)(page);
    await page.goto(APP_URL);
    await waitForApp(page);
    await page.locator('button[aria-label="Open Settings"]').first().click();
    await expect(page.locator('#appearance-settings-modal')).toBeVisible();
    const failures = await page.evaluate(SCAN, SHELL_SELECTORS as unknown as string[]);
    expect(failures, `${mode} shell contrast failures`).toEqual([]);
    await page.keyboard.press('Escape');
  }
});
