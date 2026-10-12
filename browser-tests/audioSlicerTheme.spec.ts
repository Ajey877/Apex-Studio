import { expect, test, type Page } from '@playwright/test';

/** Matches the URL the existing browser suite and `webServer` config both use. */
const APP_URL = 'http://localhost:3000';

/**
 * UI-03E — the Audio Slicer surface in a real browser, in both themes.
 *
 * What the DOM tests cannot prove: the dialog opens in Dark and Light; every
 * piece of visible text reaches WCAG AA against the colour it is actually
 * painted over (computed, alpha-composited, not read from source); the waveform
 * canvas paints the active theme's palette; and switching themes while the
 * dialog stays open repaints that canvas with no reload.
 *
 * Reaching the canvas requires a real sample: Phase 52 removed the synthesized
 * breakbeat, so with no loaded sample the modal renders its honest empty state
 * and never draws a waveform. This suite generates a small WAV in memory and
 * imports it through the product's own Sample Manager file input, so the canvas
 * branch under test is the one a user actually gets. No audio fixture is added
 * to the repository and no production import path is changed for the test.
 */

const DARK_CANVAS = [21, 24, 33]; // #151821 = --apex-canvas (dark)
const LIGHT_CANVAS = [244, 246, 250]; // #f4f6fa = --apex-canvas (light)
const DARK_WAVE = [255, 110, 0]; // #ff6e00 = the shipped Dark waveform literal
const LIGHT_WAVE = [154, 93, 0]; // #9a5d00 = Light --apex-gold

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

const slicerDialog = (page: Page) =>
  page.locator('[role="dialog"]:has(#audio-slicer-modal-title)');

const sampleManagerDialog = (page: Page) =>
  page.locator('[role="dialog"]:has(#sample-manager-modal-title)');

/**
 * A minimal 16-bit mono PCM WAV: one second of sharp decaying hits at 8 Hz, so
 * the transient detector has real onsets to find and the slicer produces real
 * chop pads. Built in memory — nothing is written to the repository.
 */
const makeTransientWav = (): Buffer => {
  const sampleRate = 44100;
  const numSamples = sampleRate; // 1 second
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i += 1) {
    const t = i / sampleRate;
    const env = Math.exp(-30 * (t % 0.125)); // a sharp hit every 125 ms
    const value = Math.sin(2 * Math.PI * 110 * t) * env * 0.85;
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), 44 + i * 2);
  }
  return buffer;
};

/**
 * Imports the generated WAV through the Sample Manager and assigns it to the
 * first channel. This is the product's own import workflow — the hidden file
 * input behind the dropzone — so the slicer sees a genuinely decoded buffer.
 */
const importTransientSample = async (page: Page) => {
  await page.locator('#fl-tools-menu-btn').click();
  await page.locator('#fl-sampler-modal-btn').click();
  const manager = sampleManagerDialog(page);
  await expect(manager).toBeVisible();

  await manager.locator('input[type="file"]').setInputFiles({
    name: 'ui03e-transients.wav',
    mimeType: 'audio/wav',
    buffer: makeTransientWav(),
  });

  // Decoding and persisting are asynchronous; the sample panel only appears
  // once the engine has a real buffer for the import.
  await expect(manager.locator('#sample-manager-sample-panel')).toBeVisible({ timeout: 20_000 });
  await manager.locator('button:has-text("Assign to Channel")').click();
  await expect(manager).toBeHidden();
};

const openSlicer = async (page: Page) => {
  await page.locator('#fl-tools-menu-btn').click();
  await page.locator('#fl-slicer-btn').click();
  const dialog = slicerDialog(page);
  await expect(dialog).toBeVisible();
  // The canvas paints in an effect, not an animation loop; give React a beat.
  await page.waitForTimeout(400);
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

/**
 * Histogram of the waveform canvas.
 *
 * The corner probe the Wavetable suite uses is not safe here: the transient
 * detector always emits a slice at time 0, so a marker line is painted at x=0.
 * The background fill still covers the large majority of the bitmap, so the
 * most frequent colour is a deterministic read of the palette in use. The
 * waveform is drawn with an unblended fillRect, so its exact RGB is present.
 */
const canvasPalette = (page: Page, targets: number[][]) =>
  page.evaluate((rgbTargets: number[][]) => {
    const canvas = document.querySelector<HTMLCanvasElement>('#audio-slicer-modal canvas');
    if (!canvas) throw new Error('slicer canvas not rendered');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('slicer canvas has no 2d context');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = new Map<string, number>();
    for (let i = 0; i < data.length; i += 4) {
      const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
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
      targets: rgbTargets.map((rgb) => ({ rgb, count: counts.get(`${rgb[0]},${rgb[1]},${rgb[2]}`) ?? 0 })),
    };
  }, targets);

const pixelsClose = (actual: number[], expected: number[], tolerance = 3) =>
  actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance);

const countFor = (report: { targets: Array<{ rgb: number[]; count: number }> }, target: number[]) =>
  report.targets.find((t) => t.rgb[0] === target[0] && t.rgb[1] === target[1] && t.rgb[2] === target[2])?.count ?? 0;

/**
 * Every visible text node in the dialog (or in the element matched by `scope`),
 * with the contrast of its computed colour against the colour painted behind
 * it. The background is composited from the nearest opaque ancestor outward, so
 * translucent washes are measured as they are displayed.
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

    const dialog = root ?? document.querySelector('[role="dialog"]:has(#audio-slicer-modal-title)');
    if (!dialog) throw new Error('slicer dialog not rendered');
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

/** Composited `filter` and `opacity` on the element and its ancestors. */
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

test.describe('UI-03E Audio Slicer theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: every visible text reaches WCAG AA and the canvas paints this theme`, async ({ page }) => {
      await THEME_SET(page, mode);
      await page.goto(APP_URL);
      await waitForApp(page);
      if (mode === 'light') await switchThemeViaSettings(page, 'light');
      await importTransientSample(page);
      const dialog = await openSlicer(page);

      // The canvas only exists once a real sample is loaded (Phase 52).
      await expect(dialog.locator('canvas')).toHaveCount(1);

      const texts = await measureDialogText(page);
      expect(texts.length).toBeGreaterThan(20);
      const failing = texts.filter((t) => t.ratio < requiredRatio(t));
      const worst = texts.reduce((a, b) => (b.ratio < a.ratio ? b : a));
      console.log(`[UI-03E] ${mode}: ${texts.length} text nodes, min ${worst.ratio}:1 ("${worst.text}")`);
      expect(
        failing,
        `text below AA in ${mode}: ${JSON.stringify(failing, null, 2)}`
      ).toEqual([]);

      const report = await canvasPalette(page, [DARK_CANVAS, LIGHT_CANVAS, DARK_WAVE, LIGHT_WAVE]);
      const expectedCanvas = mode === 'dark' ? DARK_CANVAS : LIGHT_CANVAS;
      const otherCanvas = mode === 'dark' ? LIGHT_CANVAS : DARK_CANVAS;
      const expectedWave = mode === 'dark' ? DARK_WAVE : LIGHT_WAVE;
      const otherWave = mode === 'dark' ? LIGHT_WAVE : DARK_WAVE;

      // The background fill dominates the bitmap, so the modal colour is a
      // deterministic read of the palette in use.
      expect(pixelsClose(report.top, expectedCanvas), `canvas is painted with ${expectedCanvas}, got ${report.top}`).toBe(true);
      expect(report.topCount / report.total).toBeGreaterThan(0.5);
      expect(countFor(report, otherCanvas), 'the other theme background is not painted').toBe(0);
      expect(countFor(report, expectedWave), 'the waveform is painted in this theme signal colour').toBeGreaterThan(0);
      expect(countFor(report, otherWave), 'the other theme waveform colour is not painted').toBe(0);

      await dialog.screenshot({ path: `assets/screenshots/ui03e-audio-slicer-${mode}.png` });
    });
  }

  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: the empty state reaches WCAG AA before any sample is loaded`, async ({ page }) => {
      await THEME_SET(page, mode);
      await page.goto(APP_URL);
      await waitForApp(page);
      if (mode === 'light') await switchThemeViaSettings(page, 'light');

      // No import: Phase 52 makes this the honest first-run state, and it is a
      // different set of surfaces from the loaded state (the gold warning sits
      // on the canvas well, which was a dark hole in Light before this change).
      const dialog = await openSlicer(page);
      await expect(dialog.locator('canvas')).toHaveCount(0);
      await expect(dialog.locator('text=NO SAMPLE TO SLICE')).toBeVisible();

      const texts = await measureDialogText(page);
      expect(texts.length).toBeGreaterThan(10);
      const failing = texts.filter((t) => t.ratio < requiredRatio(t));
      const worst = texts.reduce((a, b) => (b.ratio < a.ratio ? b : a));
      console.log(`[UI-03E] ${mode} empty state: ${texts.length} text nodes, min ${worst.ratio}:1 ("${worst.text}")`);
      expect(
        failing,
        `empty-state text below AA in ${mode}: ${JSON.stringify(failing, null, 2)}`
      ).toEqual([]);

      await dialog.screenshot({ path: `assets/screenshots/ui03e-audio-slicer-${mode}-empty.png` });
    });
  }

  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: the status toast and its dismiss glyph keep AA contrast`, async ({ page }) => {
      await THEME_SET(page, mode);
      await page.goto(APP_URL);
      await waitForApp(page);
      if (mode === 'light') await switchThemeViaSettings(page, 'light');
      await importTransientSample(page);
      const dialog = await openSlicer(page);

      // Publishing real chops raises the toast. It auto-dismisses after 3 s, so
      // measure immediately after the click.
      const publish = dialog.locator('button:has-text("Map Chops to Piano Roll")');
      await expect(publish).toBeEnabled();
      await publish.click();

      const toast = dialog.locator('div.shadow-md:has(button)');
      await expect(toast).toBeVisible();
      const probeId = `ui03e-${mode}-toast`;
      await toast.evaluate((el, id) => el.setAttribute('data-ui03e-probe', id), probeId);
      const scope = `[data-ui03e-probe="${probeId}"]`;

      const entries = await measureDialogText(page, scope);
      const message = entries.find((t) => t.text.length > 1 && t.text !== '✕');
      const dismiss = entries.find((t) => t.text === '✕');
      expect(message, 'toast message measured').toBeDefined();
      expect(dismiss, 'toast dismiss glyph measured').toBeDefined();
      console.log(
        `[UI-03E] ${mode} toast message: ${message!.ratio}:1 (text ${message!.color}); dismiss ✕: ${dismiss!.ratio}:1 (text ${dismiss!.color})`
      );
      expect(message!.ratio, `${mode} toast message ${message!.color}: ${message!.ratio}:1`).toBeGreaterThanOrEqual(4.5);
      expect(dismiss!.ratio, `${mode} toast dismiss ✕ ${dismiss!.color}: ${dismiss!.ratio}:1`).toBeGreaterThanOrEqual(4.5);

      const dismissButton = toast.locator('button');
      await dismissButton.evaluate((el, id) => el.setAttribute('data-ui03e-probe', id), `${probeId}-x`);
      const guards = await compositingGuards(page, `[data-ui03e-probe="${probeId}-x"]`);
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
    await importTransientSample(page);
    const dialog = await openSlicer(page);
    await expect(dialog.locator('canvas')).toHaveCount(1);

    const dark = await canvasPalette(page, [DARK_CANVAS, LIGHT_CANVAS, DARK_WAVE, LIGHT_WAVE]);
    expect(pixelsClose(dark.top, DARK_CANVAS), 'starts on the dark canvas').toBe(true);
    expect(countFor(dark, DARK_WAVE)).toBeGreaterThan(0);

    await flipDocumentTheme(page, 'light');
    await page.waitForTimeout(400);
    const light = await canvasPalette(page, [DARK_CANVAS, LIGHT_CANVAS, DARK_WAVE, LIGHT_WAVE]);
    expect(pixelsClose(light.top, LIGHT_CANVAS), 'the open canvas repainted for light').toBe(true);
    expect(countFor(light, LIGHT_WAVE), 'the waveform repainted in the light signal colour').toBeGreaterThan(0);
    expect(countFor(light, DARK_WAVE), 'no stale dark waveform pixels').toBe(0);
    expect(countFor(light, DARK_CANVAS), 'no stale dark background pixels').toBe(0);

    await flipDocumentTheme(page, 'dark');
    await page.waitForTimeout(400);
    const back = await canvasPalette(page, [DARK_CANVAS, LIGHT_CANVAS, DARK_WAVE, LIGHT_WAVE]);
    expect(pixelsClose(back.top, DARK_CANVAS), 'the open canvas repainted back to dark').toBe(true);
    expect(countFor(back, DARK_WAVE)).toBeGreaterThan(0);
    expect(countFor(back, LIGHT_CANVAS), 'no stale light background pixels').toBe(0);
  });

  test('reopening after a Settings switch shows the current palette, not a stale one', async ({ page }) => {
    await THEME_SET(page, 'dark');
    await page.goto(APP_URL);
    await waitForApp(page);
    await importTransientSample(page);
    const dialog = await openSlicer(page);
    expect(pixelsClose((await canvasPalette(page, [DARK_CANVAS])).top, DARK_CANVAS)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await switchThemeViaSettings(page, 'light');
    await openSlicer(page);
    expect(pixelsClose((await canvasPalette(page, [LIGHT_CANVAS])).top, LIGHT_CANVAS)).toBe(true);
  });

  test('visible content and controls are identical across themes', async ({ page }) => {
    await THEME_SET(page, 'dark');
    await page.goto(APP_URL);
    await waitForApp(page);
    await importTransientSample(page);
    const dialog = await openSlicer(page);
    const darkText = await dialog.innerText();
    const darkControls = await dialog.locator('button, input, select').count();
    await page.keyboard.press('Escape');

    await switchThemeViaSettings(page, 'light');
    const reopened = await openSlicer(page);
    expect(await reopened.innerText()).toBe(darkText);
    expect(await reopened.locator('button, input, select').count()).toBe(darkControls);
  });
});
