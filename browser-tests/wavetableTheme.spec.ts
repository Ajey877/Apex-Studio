import { expect, test, type Page } from '@playwright/test';

/** Matches the URL the existing browser suite and `webServer` config both use. */
const APP_URL = 'http://localhost:3000';

/**
 * UI-03D — the Wavetable preview surface in both themes, in a real browser.
 *
 * What the DOM tests cannot prove: the dialog opens in Dark and Light; every
 * piece of visible text in it reaches WCAG AA against the colour it is actually
 * painted over (computed, alpha-composited, not read from source); the waterfall
 * canvas repaints its background and current-frame stroke for the active theme,
 * including after a theme flip while the dialog stays open; and nothing the user
 * can see or change differs between the two themes except presentation.
 *
 * The canvas paints its background every frame, so its top-left bitmap pixel is a
 * deterministic read of the palette in use. The current-frame stroke is drawn in
 * the intentional per-mode signal colour, so its exact RGB must appear in the
 * bitmap.
 */

const DARK_CANVAS = [21, 24, 33]; // #151821 = --apex-canvas (dark)
const LIGHT_CANVAS = [244, 246, 250]; // #f4f6fa = --apex-canvas (light)
const DARK_CURRENT = [255, 110, 0]; // #ff6e00 = Dark shipped current-frame literal
const LIGHT_CURRENT = [154, 93, 0]; // #9a5d00 = Light current-frame signal colour

const THEME_SET = (page: Page, mode: 'dark' | 'light') =>
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

const wavetableDialog = (page: Page) =>
  page.locator('[role="dialog"]:has(#fl-wavetable-synth-modal-title)');

const openWavetable = async (page: Page) => {
  await page.locator('#fl-tools-menu-btn').click();
  await page.locator('#fl-wavetable-btn').click();
  const dialog = wavetableDialog(page);
  await expect(dialog).toBeVisible();
  // Let the rAF draw loop paint at least one frame before sampling pixels.
  await page.waitForTimeout(600);
  return dialog;
};

const switchThemeViaSettings = async (page: Page, mode: 'dark' | 'light') => {
  await page.locator('button[aria-label="Open Settings"]').first().click();
  const settings = page.locator('#appearance-settings-modal');
  await expect(settings).toBeVisible();
  await settings.locator(`label:has(input[value="${mode}"])`).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
};

/** Commits the theme at the document level while the dialog stays open. */
const flipDocumentTheme = (page: Page, mode: 'dark' | 'light') =>
  page.evaluate((value) => {
    try {
      window.localStorage.setItem('apex:theme', value);
    } catch {
      /* storage failures are handled by the page under test */
    }
    document.documentElement.dataset.theme = value;
  }, mode);

/** Bitmap pixel (0,0) of the waterfall canvas: its palette background fill. */
const probeCanvasCorner = (page: Page): Promise<[number, number, number]> =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#fl-wavetable-synth-modal canvas');
    if (!canvas) throw new Error('waterfall canvas not rendered');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('waterfall canvas has no 2d context');
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    return [pixel[0], pixel[1], pixel[2]];
  });

/** How many bitmap pixels are exactly this RGB (the current-frame stroke colour). */
const countExactPixels = (page: Page, rgb: number[]): Promise<number> =>
  page.evaluate((target: number[]) => {
    const canvas = document.querySelector<HTMLCanvasElement>('#fl-wavetable-synth-modal canvas');
    if (!canvas) throw new Error('waterfall canvas not rendered');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('waterfall canvas has no 2d context');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === target[0] && data[i + 1] === target[1] && data[i + 2] === target[2]) count += 1;
    }
    return count;
  }, rgb);

const pixelsClose = (actual: number[], expected: number[], tolerance = 3) =>
  actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance);

/**
 * Every visible text node in the dialog (or in the element matched by `scope`),
 * with the contrast of its computed colour against the colour painted behind
 * it. The background is composited from the nearest opaque ancestor outward,
 * so translucent washes (hover, `bg-…/10`) are measured as they are displayed.
 */
const measureDialogText = (page: Page, scope: string | null = null) =>
  page.evaluate((scopeSelector: string | null) => {
    const root = scopeSelector ? document.querySelector(scopeSelector) : null;
    type RGBA = [number, number, number, number];
    const parse = (value: string): RGBA | null => {
      const legacy = /^rgba?\(([^)]+)\)$/.exec(value.trim());
      if (legacy) {
        const parts = legacy[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
      }
      const srgb = /^color\(srgb\s+([^)]+)\)$/.exec(value.trim());
      if (srgb) {
        const parts = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number);
        return [parts[0] * 255, parts[1] * 255, parts[2] * 255, parts.length > 3 ? parts[3] : 1];
      }
      // Chrome serialises color-mix() results as oklab(); convert to sRGB.
      const oklab = /^oklab\(([^)]+)\)$/.exec(value.trim());
      if (oklab) {
        const parts = oklab[1].split(/[\s/]+/).filter(Boolean).map(Number);
        const [L, a, b] = parts;
        const alpha = parts.length > 3 ? parts[3] : 1;
        const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
        const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
        const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
        const linear = [
          4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
          -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
          -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
        ];
        const gamma = (v: number) => {
          const c = Math.min(1, Math.max(0, v));
          return (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255;
        };
        return [gamma(linear[0]), gamma(linear[1]), gamma(linear[2]), alpha];
      }
      return null;
    };
    const over = (top: RGBA, below: RGBA): RGBA => {
      const a = top[3];
      return [top[0] * a + below[0] * (1 - a), top[1] * a + below[1] * (1 - a), top[2] * a + below[2] * (1 - a), 1];
    };
    const effectiveBackground = (el: Element): RGBA => {
      const layers: RGBA[] = [];
      let node: Element | null = el;
      let base: RGBA | null = null;
      while (node && node !== document.documentElement) {
        const raw = getComputedStyle(node).backgroundColor;
        const c = parse(raw);
        if (!c && raw !== 'transparent') throw new Error(`unparseable background ${raw}`);
        if (c && c[3] > 0) {
          if (c[3] >= 1) {
            base = c;
            break;
          }
          layers.push(c);
        }
        node = node.parentElement;
      }
      if (!base) base = parse(getComputedStyle(document.documentElement).backgroundColor) ?? [0, 0, 0, 1];
      for (const layer of layers.reverse()) base = over(layer, base);
      return base;
    };
    const luminance = ([r, g, b]: RGBA) => {
      const lin = [r, g, b].map((c) => {
        const v = c / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722;
    };
    const ratio = (a: RGBA, b: RGBA) => {
      const la = luminance(a);
      const lb = luminance(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    };

    const dialog = root ?? document.querySelector('[role="dialog"]:has(#fl-wavetable-synth-modal-title)');
    if (!dialog) throw new Error('wavetable dialog not rendered');
    const results: Array<{ text: string; ratio: number; fontSize: number; bold: boolean; color: string; background: string }> = [];
    [...(root ? [root] : []), ...dialog.querySelectorAll('*')].forEach((el) => {
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? '').trim())
        .filter(Boolean)
        .join(' ');
      if (!text) return;
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') return;
      const fg = parse(cs.color);
      if (!fg) throw new Error(`unparseable text colour ${cs.color} on "${text}"`);
      const bg = effectiveBackground(el);
      const shown: RGBA = fg[3] < 1 ? over(fg, bg) : fg;
      results.push({
        text,
        ratio: Number(ratio(shown, bg).toFixed(2)),
        fontSize: parseFloat(cs.fontSize),
        bold: Number(cs.fontWeight) >= 700,
        color: cs.color,
        background: getComputedStyle(el).backgroundColor,
      });
    });
    return results;
  }, scope);

/**
 * Computed `filter` and `opacity` on the element and its ancestors, up to the
 * dialog. A non-neutral value is painted on top of the computed colours, so a
 * measurement taken from computed styles would not reflect what is on screen.
 * This guard is what made the earlier hover defect invisible to that method.
 */
const compositingGuards = (page: Page, scope: string) =>
  page.evaluate((selector: string) => {
    const out: string[] = [];
    let node: Element | null = document.querySelector(selector);
    while (node && node.getAttribute('role') !== 'dialog') {
      const cs = getComputedStyle(node);
      if (cs.filter !== 'none') out.push(`filter ${cs.filter} on <${node.tagName.toLowerCase()}>`);
      if (cs.opacity !== '1') out.push(`opacity ${cs.opacity} on <${node.tagName.toLowerCase()}>`);
      node = node.parentElement;
    }
    return out;
  }, scope);

const requiredRatio = (entry: { fontSize: number; bold: boolean }) =>
  entry.fontSize >= 24 || (entry.bold && entry.fontSize >= 18.66) ? 3 : 4.5;

test.describe('UI-03D Wavetable preview theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: every visible text reaches WCAG AA and the canvas paints this theme`, async ({ page }) => {
      await THEME_SET(page, mode);
      await page.goto(APP_URL);
      await waitForApp(page);
      if (mode === 'light') await switchThemeViaSettings(page, 'light');
      await openWavetable(page);

      const texts = await measureDialogText(page);
      expect(texts.length).toBeGreaterThan(20);
      const failing = texts.filter((t) => t.ratio < requiredRatio(t));
      const worst = texts.reduce((a, b) => (b.ratio < a.ratio ? b : a));
      console.log(`[UI-03D] ${mode}: ${texts.length} text nodes, min ${worst.ratio}:1 ("${worst.text}")`);
      expect(
        failing,
        `text below AA in ${mode}: ${JSON.stringify(failing, null, 2)}`
      ).toEqual([]);

      const corner = await probeCanvasCorner(page);
      expect(pixelsClose(corner, mode === 'dark' ? DARK_CANVAS : LIGHT_CANVAS)).toBe(true);
      const current = mode === 'dark' ? DARK_CURRENT : LIGHT_CURRENT;
      expect(await countExactPixels(page, current)).toBeGreaterThan(0);

      await wavetableDialog(page).screenshot({ path: `assets/screenshots/ui03d-wavetable-${mode}.png` });
    });
  }

  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: primary buttons keep AA text in rest, hover and keyboard-focus states`, async ({ page }) => {
      await THEME_SET(page, mode);
      await page.goto(APP_URL);
      await waitForApp(page);
      if (mode === 'light') await switchThemeViaSettings(page, 'light');
      const dialog = await openWavetable(page);

      const buttons = ['Audition C4', 'Close'] as const;
      for (const name of buttons) {
        const locator = dialog.locator(`button:has-text("${name}")`);
        await expect(locator).toHaveCount(1);
        const probeId = `ui03d-${mode}-${name.replace(/\W+/g, '-').toLowerCase()}`;
        await locator.evaluate((el, id) => el.setAttribute('data-ui03d-probe', id), probeId);
        const scope = `[data-ui03d-probe="${probeId}"]`;

        const measure = async (state: 'rest' | 'hover' | 'focus') => {
          const entries = await measureDialogText(page, scope);
          const entry = entries.find((t) => t.text.includes(name));
          expect(entry, `${name} text measured in ${state}`).toBeDefined();
          const background = await locator.evaluate((el) => getComputedStyle(el).backgroundColor);
          const guards = await compositingGuards(page, scope);
          console.log(`[UI-03D] ${mode} "${name}" ${state}: ${entry!.ratio}:1 (text ${entry!.color}, bg ${background})`);
          expect(guards, `${name} ${state}: compositing must be neutral`).toEqual([]);
          expect(
            entry!.ratio,
            `${mode} "${name}" ${state} text ${entry!.color} on ${background}: ${entry!.ratio}:1`
          ).toBeGreaterThanOrEqual(4.5);
          return { ratio: entry!.ratio, background };
        };

        await page.mouse.move(0, 0);
        await page.waitForTimeout(400);
        const rest = await measure('rest');

        await locator.hover();
        await page.waitForTimeout(400);
        const hover = await measure('hover');
        // The hover rule must actually apply in this browser, not just be declared.
        expect(hover.background, `${name} hover changes the fill`).not.toBe(rest.background);

        await page.mouse.move(0, 0);
        await page.waitForTimeout(400);
        await page.keyboard.press('Shift');
        await locator.focus();
        await page.waitForTimeout(300);
        expect(await locator.evaluate((el) => el.matches(':focus-visible')), `${name} shows focus-visible`).toBe(true);
        const focus = await measure('focus');
        expect(focus.background, `${name} focus leaves the fill unchanged`).toBe(rest.background);
      }
    });
  }

  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: the Audition status toast and its dismiss glyph keep AA contrast`, async ({ page }) => {
      await THEME_SET(page, mode);
      await page.goto(APP_URL);
      await waitForApp(page);
      if (mode === 'light') await switchThemeViaSettings(page, 'light');
      const dialog = await openWavetable(page);

      // The toast is transient (auto-dismiss after 2 s), so measure it right after it appears.
      await dialog.locator('button:has-text("Audition C4")').click();
      const toast = dialog.locator('div.shadow-md:has(button)');
      await expect(toast).toBeVisible();
      const probeId = `ui03d-${mode}-toast`;
      await toast.evaluate((el, id) => el.setAttribute('data-ui03d-probe', id), probeId);
      const scope = `[data-ui03d-probe="${probeId}"]`;

      const entries = await measureDialogText(page, scope);
      const message = entries.find((t) => t.text.includes('Auditioning'));
      const dismiss = entries.find((t) => t.text === '✕');
      expect(message, 'toast message measured').toBeDefined();
      expect(dismiss, 'toast dismiss glyph measured').toBeDefined();
      console.log(`[UI-03D] ${mode} toast message: ${message!.ratio}:1 (text ${message!.color}); dismiss ✕: ${dismiss!.ratio}:1 (text ${dismiss!.color})`);
      expect(message!.ratio, `${mode} toast message ${message!.color}: ${message!.ratio}:1`).toBeGreaterThanOrEqual(4.5);
      expect(dismiss!.ratio, `${mode} toast dismiss ✕ ${dismiss!.color}: ${dismiss!.ratio}:1`).toBeGreaterThanOrEqual(4.5);

      const dismissButton = toast.locator('button');
      await dismissButton.evaluate((el, id) => el.setAttribute('data-ui03d-probe', id), `${probeId}-x`);
      const guards = await compositingGuards(page, `[data-ui03d-probe="${probeId}-x"]`);
      expect(guards, 'dismiss glyph: compositing must be neutral').toEqual([]);

      // The dismiss handler is unchanged: the glyph still closes the toast.
      await dismissButton.click();
      await expect(toast).toBeHidden();
    });
  }

  test('a theme flip repaints the open canvas with no reload', async ({ page }) => {
    await THEME_SET(page, 'dark');
    await page.goto(APP_URL);
    await waitForApp(page);
    await openWavetable(page);
    expect(pixelsClose(await probeCanvasCorner(page), DARK_CANVAS)).toBe(true);

    await flipDocumentTheme(page, 'light');
    await page.waitForTimeout(300);
    expect(pixelsClose(await probeCanvasCorner(page), LIGHT_CANVAS)).toBe(true);
    expect(await countExactPixels(page, LIGHT_CURRENT)).toBeGreaterThan(0);

    await flipDocumentTheme(page, 'dark');
    await page.waitForTimeout(300);
    expect(pixelsClose(await probeCanvasCorner(page), DARK_CANVAS)).toBe(true);
    expect(await countExactPixels(page, DARK_CURRENT)).toBeGreaterThan(0);
  });

  test('reopening after a Settings switch shows the current palette, not a stale one', async ({ page }) => {
    await THEME_SET(page, 'dark');
    await page.goto(APP_URL);
    await waitForApp(page);
    await openWavetable(page);
    await page.keyboard.press('Escape');
    await expect(wavetableDialog(page)).toBeHidden();

    await switchThemeViaSettings(page, 'light');
    await openWavetable(page);
    expect(pixelsClose(await probeCanvasCorner(page), LIGHT_CANVAS)).toBe(true);
  });

  test('visible content and controls are identical across themes', async ({ page }) => {
    await THEME_SET(page, 'dark');
    await page.goto(APP_URL);
    await waitForApp(page);
    await openWavetable(page);
    const darkText = await wavetableDialog(page).innerText();
    const darkControls = await wavetableDialog(page).locator('button, input, select').count();
    await page.keyboard.press('Escape');

    await switchThemeViaSettings(page, 'light');
    await openWavetable(page);
    expect(await wavetableDialog(page).innerText()).toBe(darkText);
    expect(await wavetableDialog(page).locator('button, input, select').count()).toBe(darkControls);
  });
});
