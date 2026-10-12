import { expect, test, type Page } from '@playwright/test';

/** Matches the URL the existing browser suite and `webServer` config both use. */
const APP_URL = 'http://localhost:3000';

/**
 * UI-03F — the Audio Recorder surface in a real browser, in both themes.
 *
 * What the DOM tests cannot prove: the dialog opens in Dark and Light; every
 * piece of visible text reaches WCAG AA against the colour it is actually
 * painted over (computed, alpha-composited, not read from source); the scrim is
 * the shared overlay token; the live waveform canvas paints the active theme's
 * palette; the validation and error surfaces stay legible; and switching the
 * theme while the dialog stays open repaints that canvas with no reload.
 *
 * The suite never touches the microphone. The recorder is opened from the
 * transport's own "Arm recording" control, and the error surface is reached
 * deterministically through the product's punch validation, so the suite runs
 * unchanged on a machine (or CI runner) with no audio input device.
 */

const DARK_CANVAS = [21, 24, 33]; // #151821 = --apex-canvas (dark)
const LIGHT_CANVAS = [244, 246, 250]; // #f4f6fa = --apex-canvas (light)
const DARK_WAVE = [255, 110, 0]; // #ff6e00 = the shipped Dark waveform literal
const LIGHT_WAVE = [154, 93, 0]; // #9a5d00 = Light --apex-gold
const DARK_SCRIM = 'rgba(5, 7, 12, 0.66)'; // --apex-modal-overlay (dark)
const LIGHT_SCRIM = 'rgba(24, 32, 45, 0.55)'; // --apex-modal-overlay (light)

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

const recorderDialog = (page: Page) =>
  page.locator('[role="dialog"]:has(#audio-recorder-modal-title)');

const switchThemeViaSettings = async (page: Page, mode: 'dark' | 'light') => {
  await page.locator('button[aria-label="Open Settings"]').first().click();
  const settings = page.locator('#appearance-settings-modal');
  await expect(settings).toBeVisible();
  await settings.locator(`label:has(input[value="${mode}"])`).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
};

/** Opens the recorder from the transport, the same way a user does. */
const openRecorder = async (page: Page) => {
  await page.locator('button[aria-label="Arm recording"]').first().click();
  const dialog = recorderDialog(page);
  await expect(dialog).toBeVisible();
  // The waveform repaints every animation frame; give the first frames a beat.
  await page.waitForTimeout(400);
  return dialog;
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

/**
 * Histogram of the live waveform canvas. The background fill covers the large
 * majority of the bitmap, so the most frequent colour is the palette in use.
 * The stroke is antialiased, so the waveform is counted with a small tolerance.
 */
const canvasPalette = (page: Page, wave: number[]) =>
  page.evaluate((waveRgb: number[]) => {
    const canvas = document.querySelector<HTMLCanvasElement>('#audio-recorder-modal canvas');
    if (!canvas) throw new Error('recorder canvas not rendered');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('recorder canvas has no 2d context');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = new Map<string, number>();
    let waveCount = 0;
    for (let i = 0; i < data.length; i += 4) {
      const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (
        Math.abs(data[i] - waveRgb[0]) <= 8 &&
        Math.abs(data[i + 1] - waveRgb[1]) <= 8 &&
        Math.abs(data[i + 2] - waveRgb[2]) <= 8
      ) {
        waveCount += 1;
      }
    }
    let top = '';
    let topCount = 0;
    for (const [key, count] of counts) {
      if (count > topCount) {
        topCount = count;
        top = key;
      }
    }
    return {
      total: canvas.width * canvas.height,
      top: top.split(',').map(Number),
      topCount,
      waveCount,
    };
  }, wave);

/**
 * Every visible text node in the dialog, with the contrast of its computed
 * colour against the colour painted behind it. The background is composited from
 * the nearest opaque ancestor outward, so translucent washes are measured as they
 * are displayed. Form values are measured as well, since they are text the user
 * reads and edits.
 */
const measureDialogText = (page: Page) =>
  page.evaluate(() => {
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
      // Chrome serialises color-mix() results as oklab() and Tailwind's palette
      // utilities as oklch(); convert both to sRGB.
      const oklch = /^oklch\(([^)]+)\)$/.exec(value.trim());
      const oklab = /^oklab\(([^)]+)\)$/.exec(value.trim());
      if (oklch || oklab) {
        const parts = (oklch ?? oklab)![1].split(/[\s/]+/).filter(Boolean).map(Number);
        const alpha = parts.length > 3 ? parts[3] : 1;
        let L = parts[0];
        let a = parts[1];
        let b = parts[2];
        if (oklch) {
          // oklch = lightness, chroma, hue in degrees -> oklab a/b components.
          const chroma = parts[1];
          const radians = (parts[2] * Math.PI) / 180;
          a = chroma * Math.cos(radians);
          b = chroma * Math.sin(radians);
        }
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

    const dialog = document.querySelector('[role="dialog"]:has(#audio-recorder-modal-title)');
    if (!dialog) throw new Error('recorder dialog not rendered');
    const results: Array<{ text: string; ratio: number; fontSize: number; bold: boolean; color: string; background: string }> = [];
    const measure = (el: Element, text: string) => {
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
        background: cs.backgroundColor,
      });
    };
    dialog.querySelectorAll('*').forEach((el) => {
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? '').trim())
        .filter(Boolean)
        .join(' ');
      if (text) measure(el, text);
    });
    dialog.querySelectorAll('input, select').forEach((el) => {
      const field = el as HTMLInputElement | HTMLSelectElement;
      const text = field instanceof HTMLSelectElement ? field.selectedOptions[0]?.textContent ?? '' : field.value;
      if (text.trim()) measure(el, `[${field.getAttribute('aria-label') ?? field.tagName.toLowerCase()}] ${text.trim()}`);
    });
    return results;
  });

/** The scrim the overlay actually paints, read from computed style. */
const overlayBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.getElementById('audio-recorder-modal') as HTMLElement).backgroundColor);

const requiredRatio = (entry: { fontSize: number; bold: boolean }) =>
  entry.fontSize >= 24 || (entry.bold && entry.fontSize >= 18.66) ? 3 : 4.5;

const expectAllTextAA = (mode: string, state: string, texts: Awaited<ReturnType<typeof measureDialogText>>) => {
  const failing = texts.filter((t) => t.ratio < requiredRatio(t));
  const worst = texts.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  console.log(`[UI-03F] ${mode} ${state}: ${texts.length} text nodes, min ${worst.ratio}:1 ("${worst.text}")`);
  expect(failing, `text below AA in ${mode} ${state}: ${JSON.stringify(failing, null, 2)}`).toEqual([]);
};

test.describe('UI-03F Audio Recorder theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: idle text reaches AA, the scrim is the token and the waveform paints this theme`, async ({ page }) => {
      await THEME_SET(page, mode);
      await page.goto(APP_URL);
      await waitForApp(page);
      if (mode === 'light') await switchThemeViaSettings(page, 'light');
      const dialog = await openRecorder(page);
      await expect(dialog.locator('canvas')).toHaveCount(1);

      expectAllTextAA(mode, 'idle', await measureDialogText(page));

      // The overlay is the shared --apex-modal-overlay token in both themes.
      expect(await overlayBackground(page)).toBe(mode === 'dark' ? DARK_SCRIM : LIGHT_SCRIM);

      // The canvas paints this theme's background and waveform, and never the other's.
      const own = mode === 'dark' ? DARK_CANVAS : LIGHT_CANVAS;
      const other = mode === 'dark' ? LIGHT_CANVAS : DARK_CANVAS;
      const ownWave = mode === 'dark' ? DARK_WAVE : LIGHT_WAVE;
      const otherWave = mode === 'dark' ? LIGHT_WAVE : DARK_WAVE;
      const report = await canvasPalette(page, ownWave);
      console.log(`[UI-03F] ${mode} canvas: top rgb(${report.top}) x${report.topCount}/${report.total}, wave px ${report.waveCount}`);
      expect(report.top, 'the canvas background is this theme\'s --apex-canvas').toEqual(own);
      expect(report.topCount / report.total).toBeGreaterThan(0.9);
      expect(report.waveCount, 'the waveform is painted in this theme\'s colour').toBeGreaterThan(0);
      const otherReport = await canvasPalette(page, otherWave);
      expect(otherReport.top).not.toEqual(other);
      expect(otherReport.waveCount, 'the other theme\'s waveform colour is absent').toBe(0);
    });

    test(`${mode}: validation and error surfaces reach AA`, async ({ page }) => {
      await THEME_SET(page, mode);
      await page.goto(APP_URL);
      await waitForApp(page);
      if (mode === 'light') await switchThemeViaSettings(page, 'light');
      const dialog = await openRecorder(page);

      // Punch on, then a window that cannot be recorded: punch-out before punch-in.
      await dialog.locator('button[aria-label="Enable punch recording"]').click();
      await dialog.locator('input[aria-label="Punch-in bar"]').fill('5');
      await dialog.locator('input[aria-label="Punch-out bar"]').fill('1');
      await expect(dialog.locator('[data-punch-issue]').first()).toBeVisible();

      // Start refuses to arm: the message appears in the error box as well as
      // inline next to the punch window, so it is shown twice.
      await dialog.locator('button:has-text("PUNCH RECORD")').click();
      await expect(dialog.getByText('Punch-out must come after punch-in.')).toHaveCount(2);
      // Controls ease between states (`transition`); measure them at rest.
      await page.waitForTimeout(500);

      expectAllTextAA(mode, 'error', await measureDialogText(page));
    });
  }

  test('a live theme flip repaints the open waveform in both directions', async ({ page }) => {
    await THEME_SET(page, 'dark');
    await page.goto(APP_URL);
    await waitForApp(page);
    await openRecorder(page);

    let report = await canvasPalette(page, DARK_WAVE);
    expect(report.top).toEqual(DARK_CANVAS);
    expect(report.waveCount).toBeGreaterThan(0);

    await flipDocumentTheme(page, 'light');
    await page.waitForTimeout(250);
    report = await canvasPalette(page, LIGHT_WAVE);
    expect(report.top, 'the canvas is repainted in Light with no reload').toEqual(LIGHT_CANVAS);
    expect(report.waveCount).toBeGreaterThan(0);
    expect((await canvasPalette(page, DARK_WAVE)).waveCount, 'no stale Dark waveform after the flip').toBe(0);
    expect((await canvasPalette(page, DARK_WAVE)).top, 'no stale Dark background after the flip').not.toEqual(DARK_CANVAS);

    await flipDocumentTheme(page, 'dark');
    await page.waitForTimeout(250);
    report = await canvasPalette(page, DARK_WAVE);
    expect(report.top, 'the canvas is repainted back in Dark').toEqual(DARK_CANVAS);
    expect(report.waveCount).toBeGreaterThan(0);
  });
});
