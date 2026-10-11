import { expect, test, type Page } from '@playwright/test';

/** Matches the URL the existing browser suite and `webServer` config both use. */
const APP_URL = 'http://localhost:3000';

/**
 * UI-03C — the Mixer in both themes, verified against a real browser.
 *
 * What the DOM tests cannot prove: the Mixer opens in Dark and Light; the
 * master FFT canvas repaints its background when the theme flips without a
 * reload; reopening the Mixer after a switch shows the current palette, not a
 * stale one; track identity names stay legible in Light; and nothing about the
 * mixer state or the stored project changes across a theme switch.
 *
 * The FFT canvas paints its own background each frame (the palette's
 * `--apex-canvas`), so its top-left bitmap pixel is a deterministic read of the
 * palette in use, independent of whether audio is playing.
 */

const DARK_CANVAS = [21, 24, 33]; // #151821 = --apex-canvas (dark)
const LIGHT_CANVAS = [244, 246, 250]; // #f4f6fa = --apex-canvas (light)

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

const openMixer = async (page: Page) => {
  await page.locator('#nav-mixer').click();
  await expect(page.locator('#fl-mixer-console')).toBeVisible();
  // Let the rAF loop paint at least one frame before sampling pixels.
  await page.waitForTimeout(400);
};

const openPlaylist = async (page: Page) => {
  await page.locator('#nav-playlist').click();
  await expect(page.locator('#fl-mixer-console')).toHaveCount(0);
};

/** Commits the theme at the document level, the DOM effect of the Settings flow. */
const flipDocumentTheme = (page: Page, mode: 'dark' | 'light') =>
  page.evaluate((value) => {
    try {
      window.localStorage.setItem('apex:theme', value);
    } catch {
      /* storage failures are handled by the page under test */
    }
    document.documentElement.dataset.theme = value;
  }, mode);

/** Bitmap pixel (0,0) of the master FFT canvas: its palette background fill. */
const probeFftCorner = (page: Page): Promise<[number, number, number]> =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#fl-mixer-console canvas[width="180"]');
    if (!canvas) throw new Error('master FFT canvas not rendered');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('master FFT canvas has no 2d context');
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    return [pixel[0], pixel[1], pixel[2]];
  });

const pixelsClose = (actual: number[], expected: number[], tolerance = 3) =>
  actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance);

/** Everything the user can see or change in the Mixer, as plain data. */
const mixerSnapshot = (page: Page) =>
  page.evaluate(() => {
    const root = document.getElementById('fl-mixer-console');
    if (!root) throw new Error('mixer not rendered');
    return {
      text: root.innerText,
      values: [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].map(
        (el) => `${el.tagName}:${el.value}`
      ),
      strips: [...root.querySelectorAll<HTMLElement>('[id^="mixer-strip-"]')].map(
        (el) => `${el.id}:${el.className.includes('border-t-2')}`
      ),
    };
  });

/** Local storage minus the theme preference: the project and every other key. */
const persistedState = (page: Page) =>
  page.evaluate(() => {
    const out: Record<string, string | null> = {};
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (key && key !== 'apex:theme') out[key] = window.localStorage.getItem(key);
    }
    return out;
  });

/** Computed name colour and the strip surface it sits on, for contrast checks. */
const trackNameContrast = (page: Page) =>
  page.evaluate(() => {
    const parse = (value: string): [number, number, number] => {
      const m = /rgba?\(([^)]+)\)/.exec(value);
      if (!m) return [0, 0, 0];
      const p = m[1].split(',').map((x) => parseFloat(x));
      return [p[0], p[1], p[2]];
    };
    const lum = ([r, g, b]: [number, number, number]) => {
      const [R, G, B] = [r, g, b].map((c) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * R + 0.7152 * G + 0.0722 * B;
    };
    const ratio = (a: [number, number, number], b: [number, number, number]) => {
      const la = lum(a);
      const lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };
    const names = [...document.querySelectorAll<HTMLElement>('#fl-mixer-console [id^="mixer-strip-"] span.truncate, #fl-mixer-console [id^="mixer-strip-"] span.font-bold.truncate')];
    return names
      .filter((el) => el.textContent && el.textContent.trim().length > 0)
      .map((el) => {
        const strip = el.closest<HTMLElement>('[id^="mixer-strip-"]')!;
        const surface = parse(getComputedStyle(strip).backgroundColor);
        return {
          name: el.textContent!.trim(),
          color: getComputedStyle(el).color,
          ratio: ratio(parse(getComputedStyle(el).color), surface),
          selected: strip.className.includes('border-t-2'),
        };
      });
  });

test('the Mixer opens in Dark with the dark canvas palette', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await THEME_SET('dark')(page);
  await page.goto(APP_URL);
  await waitForApp(page);
  await openMixer(page);

  expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
  expect(pixelsClose(await probeFftCorner(page), DARK_CANVAS)).toBe(true);
  // Dark keeps the shipped identity: the Hi-Hats name is its stored colour.
  const names = await trackNameContrast(page);
  expect(names.length).toBeGreaterThan(0);

  await page.screenshot({ path: 'assets/screenshots/ui03c-mixer-dark.png' });
  expect(errors).toEqual([]);
});

test('the Mixer opens in Light, and track names clear AA on the light strips', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await THEME_SET('light')(page);
  await page.goto(APP_URL);
  await waitForApp(page);
  await openMixer(page);

  expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
  expect(pixelsClose(await probeFftCorner(page), LIGHT_CANVAS)).toBe(true);

  const names = await trackNameContrast(page);
  for (const entry of names) {
    expect(entry.ratio, `${entry.name} (${entry.color})`).toBeGreaterThanOrEqual(4.5);
  }

  await page.screenshot({ path: 'assets/screenshots/ui03c-mixer-light.png' });
  expect(errors).toEqual([]);
});

test('flipping the theme while the Mixer is open repaints its canvas without a reload', async ({ page }) => {
  await THEME_SET('dark')(page);
  await page.goto(APP_URL);
  await waitForApp(page);
  await openMixer(page);
  expect(pixelsClose(await probeFftCorner(page), DARK_CANVAS)).toBe(true);

  // Tag the window: a reload would discard this, so a surviving tag proves no reload.
  await page.evaluate(() => {
    (window as unknown as { __noReloadMarker: string }).__noReloadMarker = 'alive';
  });
  await flipDocumentTheme(page, 'light');

  await expect
    .poll(async () => pixelsClose(await probeFftCorner(page), LIGHT_CANVAS), { timeout: 2000 })
    .toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __noReloadMarker?: string }).__noReloadMarker)).toBe('alive');
  await page.screenshot({ path: 'assets/screenshots/ui03c-mixer-light-after-live-switch.png' });
});

test('reopening the Mixer after a theme change shows the current palette, not a stale one', async ({ page }) => {
  await THEME_SET('light')(page);
  await page.goto(APP_URL);
  await waitForApp(page);
  await openMixer(page);
  expect(pixelsClose(await probeFftCorner(page), LIGHT_CANVAS)).toBe(true);

  // Leave the Mixer, change the theme while it is unmounted, come back.
  await openPlaylist(page);
  await flipDocumentTheme(page, 'dark');
  await openMixer(page);
  expect(pixelsClose(await probeFftCorner(page), DARK_CANVAS)).toBe(true);

  // And back again, so a cache keyed on the previous mode cannot pass by luck.
  await openPlaylist(page);
  await flipDocumentTheme(page, 'light');
  await openMixer(page);
  expect(pixelsClose(await probeFftCorner(page), LIGHT_CANVAS)).toBe(true);
});

test('switching theme does not change mixer state, levels, routing or the stored project', async ({ page }) => {
  await THEME_SET('dark')(page);
  await page.goto(APP_URL);
  await waitForApp(page);
  await openMixer(page);

  const beforeMixer = await mixerSnapshot(page);
  const beforeStorage = await persistedState(page);
  const beforeNames = (await trackNameContrast(page)).map((entry) => entry.name);

  await flipDocumentTheme(page, 'light');
  await expect
    .poll(async () => pixelsClose(await probeFftCorner(page), LIGHT_CANVAS), { timeout: 2000 })
    .toBe(true);

  expect(await mixerSnapshot(page)).toEqual(beforeMixer);
  expect(await persistedState(page)).toEqual(beforeStorage);
  expect((await trackNameContrast(page)).map((entry) => entry.name)).toEqual(beforeNames);

  await flipDocumentTheme(page, 'dark');
  await expect
    .poll(async () => pixelsClose(await probeFftCorner(page), DARK_CANVAS), { timeout: 2000 })
    .toBe(true);
  expect(await mixerSnapshot(page)).toEqual(beforeMixer);
  expect(await persistedState(page)).toEqual(beforeStorage);
});

/**
 * UI-03C-fix — aux-send TEXT contrast in a real browser.
 *
 * Selects a track, adds a post-fader send through the normal UI, then measures
 * every element whose text foreground is `--apex-aux-text` against the colour it
 * actually sits on: the element's own translucent wash (the RETURN button) is
 * alpha-composited over its opaque ancestors. Hover is measured too, because the
 * RETURN wash is stronger on hover.
 */
const auxTextContrast = (page: Page) =>
  page.evaluate(() => {
    type Rgba = [number, number, number, number];
    const parse = (value: string): Rgba | null => {
      const srgb = /color\(srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*([\d.eE+-]+))?\)/.exec(value);
      if (srgb) {
        return [parseFloat(srgb[1]) * 255, parseFloat(srgb[2]) * 255, parseFloat(srgb[3]) * 255, srgb[4] === undefined ? 1 : parseFloat(srgb[4])];
      }
      const rgb = /rgba?\(([^)]+)\)/.exec(value);
      if (rgb) {
        const p = rgb[1].split(/[,\s/]+/).filter(Boolean).map((x) => parseFloat(x));
        return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
      }
      return null;
    };
    const luminance = ([r, g, b]: number[]) => {
      const [R, G, B] = [r, g, b].map((c) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * R + 0.7152 * G + 0.0722 * B;
    };
    /** Composites the element's translucent layers over the first opaque ancestor. */
    const effectiveBackground = (el: HTMLElement): [number, number, number] => {
      const layers: Rgba[] = [];
      for (let node: HTMLElement | null = el; node; node = node.parentElement) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color[3] > 0) layers.push(color);
        if (color && color[3] >= 1) break;
      }
      const deepest = layers[layers.length - 1];
      let base: [number, number, number] = deepest ? [deepest[0], deepest[1], deepest[2]] : [255, 255, 255];
      for (let i = layers.length - 2; i >= 0; i -= 1) {
        const [r, g, b, a] = layers[i];
        base = [r * a + base[0] * (1 - a), g * a + base[1] * (1 - a), b * a + base[2] * (1 - a)];
      }
      return base;
    };
    const measure = (label: string, el: HTMLElement) => {
      const text = parse(getComputedStyle(el).color);
      if (!text) throw new Error(`${label}: unreadable text colour`);
      const bg = effectiveBackground(el);
      const [hi, lo] = [luminance([text[0], text[1], text[2]]), luminance(bg)].sort((a, b) => b - a);
      return { label, ratio: (hi + 0.05) / (lo + 0.05), text: getComputedStyle(el).color };
    };
    const root = document.getElementById('fl-mixer-console');
    if (!root) throw new Error('mixer not rendered');
    const readout = [...root.querySelectorAll<HTMLElement>('[class*="text-[var(--apex-aux-text)]"]')];
    return {
      count: readout.length,
      rows: readout.map((el, index) => measure(`${index}:${el.textContent?.trim() ?? ''}`, el)),
      returnButton: root.querySelector<HTMLElement>('button[title="Create new aux return track"]'),
    };
  });

const auxTextUnderTheme = async (page: Page, mode: 'dark' | 'light') => {
  await THEME_SET(mode)(page);
  await page.goto(APP_URL);
  await waitForApp(page);
  await openMixer(page);
  // The strip centre is the fader (it stops click propagation); the label area selects the track.
  await page.locator('#mixer-strip-1').click({ position: { x: 12, y: 40 } });
  await page.locator('#fl-mixer-console button:has-text("+ Add Post-Fader Send")').click();
  await expect(page.locator('#fl-mixer-console span:has-text("%")').first()).toBeVisible();
  return page;
};

for (const mode of ['dark', 'light'] as const) {
  test(`aux-send text reaches 4.5:1 on its real background in ${mode}, idle and on hover`, async ({ page }) => {
    await auxTextUnderTheme(page, mode);

    const idle = await auxTextContrast(page);
    expect(idle.count, 'aux text elements rendered').toBeGreaterThanOrEqual(2);
    console.log(`[aux-contrast ${mode} idle]`, JSON.stringify(idle.rows.map((r) => [r.label, r.text, Number(r.ratio.toFixed(2))])));
    for (const row of idle.rows) {
      expect(row.ratio, `${mode} idle ${row.label} (${row.text})`).toBeGreaterThanOrEqual(4.5);
    }
    expect(idle.returnButton, 'RETURN button rendered').not.toBeNull();

    await page.locator('#fl-mixer-console button[title="Create new aux return track"]').hover();
    await page.waitForTimeout(250);
    const hover = await auxTextContrast(page);
    console.log(`[aux-contrast ${mode} hover]`, JSON.stringify(hover.rows.map((r) => [r.label, r.text, Number(r.ratio.toFixed(2))])));
    for (const row of hover.rows) {
      expect(row.ratio, `${mode} hover ${row.label} (${row.text})`).toBeGreaterThanOrEqual(4.5);
    }

    await page.locator('#fl-mixer-console').screenshot({ path: `assets/screenshots/ui03c-aux-${mode}.png` });
  });
}
