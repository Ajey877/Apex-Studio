import { expect, test, type Page } from '@playwright/test';

/** Matches the URL the existing browser suite and `webServer` config both use. */
const APP_URL = 'http://localhost:3000';

/**
 * UI-03G — the Parametric EQ surface in a real browser, in both themes.
 *
 * What the DOM tests cannot prove: the dialog opens in Dark and Light; every
 * piece of visible text reaches WCAG AA against the colour it is actually
 * painted over (computed, alpha-composited, not read from source); the scrim is
 * the shared overlay token; the response-curve canvas paints the active theme's
 * palette — background, grid and curve; and switching the theme while the dialog
 * stays open repaints that canvas with no reload.
 *
 * The suite never plays audio. With no analyser data the spectrum trace is flat,
 * which is why the assertions cover the curve, the grid and the background
 * rather than the spectrum fill.
 */

const DARK_CANVAS = [21, 24, 33]; // #151821 = --apex-canvas (dark)
const LIGHT_CANVAS = [244, 246, 250]; // #f4f6fa = --apex-canvas (light)
const DARK_GRID = [36, 41, 54]; // #242936 = --apex-grid-line (dark)
const LIGHT_GRID = [229, 233, 240]; // #e5e9f0 = --apex-grid-line (light)
const DARK_CURVE = [255, 110, 0]; // #ff6e00 = the shipped Dark response curve
const LIGHT_CURVE = [154, 93, 0]; // #9a5d00 = Light --apex-gold
// Band identity colours. Dark paints the stored value; Light paints the seam's
// display mapping (EQ_BAND_DISPLAY_COLORS), because the stored colours measure
// 2.63 / 1.94 / 2.91:1 on the Light canvas.
const BAND_STORED = [
  [230, 126, 34], // #e67e22 low shelf
  [46, 204, 113], // #2ecc71 mid bell
  [52, 152, 219], // #3498db high shelf
];
const BAND_LIGHT = [
  [194, 97, 71], // #c26147
  [31, 138, 77], // #1f8a4d
  [34, 127, 190], // #227fbe
];
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

const eqDialog = (page: Page) =>
  page.locator('[role="dialog"]:has(#parametric-eq-modal-title)');

const switchThemeViaSettings = async (page: Page, mode: 'dark' | 'light') => {
  await page.locator('button[aria-label="Open Settings"]').first().click();
  const settings = page.locator('#appearance-settings-modal');
  await expect(settings).toBeVisible();
  await settings.locator(`label:has(input[value="${mode}"])`).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
};

/** Opens the 3-band EQ from the transport tools menu, the way a user does. */
const openEq = async (page: Page) => {
  await page.locator('#fl-tools-menu-btn').click();
  await page.locator('#fl-master-eq-btn').click();
  const dialog = eqDialog(page);
  await expect(dialog).toBeVisible();
  // The graph repaints every animation frame; give the first frames a beat.
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
 * Histogram of the EQ canvas. The background fill covers the large majority of
 * the bitmap, so the most frequent colour is the palette in use. The curve
 * stroke and the grid lines are antialiased, so both are counted with a small
 * tolerance around their exact token value.
 */
const canvasPalette = (page: Page, colours: { curve: number[]; grid: number[]; bands?: number[][] }) =>
  page.evaluate(({ curve, grid, bands }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('#parametric-eq-modal-overlay canvas');
    if (!canvas) throw new Error('EQ canvas not rendered');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('EQ canvas has no 2d context');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const near = (i: number, rgb: number[], tol: number) =>
      Math.abs(data[i] - rgb[0]) <= tol &&
      Math.abs(data[i + 1] - rgb[1]) <= tol &&
      Math.abs(data[i + 2] - rgb[2]) <= tol;
    const counts = new Map<string, number>();
    let curveCount = 0;
    let gridCount = 0;
    const bandCounts = (bands ?? []).map(() => 0);
    for (let i = 0; i < data.length; i += 4) {
      const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (near(i, curve, 8)) curveCount += 1;
      if (near(i, grid, 6)) gridCount += 1;
      (bands ?? []).forEach((band, index) => {
        if (near(i, band, 6)) bandCounts[index] += 1;
      });
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
      curveCount,
      gridCount,
      bandCounts,
    };
  }, colours);

/**
 * The other theme's grid must be ABSENT, but "absent" cannot mean a literal zero
 * pixel count. A +/-6 tolerance box around one theme's `--apex-grid-line` also
 * catches antialiased edge pixels of the other theme's node rings, which this
 * phase introduced: Dark's white selected ring contributes 1 px inside the Light
 * grid box (measured at (234, 235, 235)), and Light's `--apex-text` ring is only
 * dRGB(12, 9, 9) from Dark's `#242936`, contributing 9 px. A grid that was really
 * painted would contribute thousands (this theme's own grid measures ~5.2-5.5k),
 * so requiring at least a 100x difference is a far stronger control than zero and
 * cannot be tripped by antialiasing.
 */
const expectOtherGridAbsent = (mode: string, other: number, own: number) => {
  expect(own, `${mode}: this theme's grid is painted`).toBeGreaterThan(1000);
  expect(
    other,
    `${mode}: the other theme's grid is absent (measured ${other} vs ${own} of this theme's)`
  ).toBeLessThan(own / 100);
};

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
        const L = parts[0];
        let a = parts[1];
        let b = parts[2];
        if (oklch) {
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

    const dialog = document.querySelector('[role="dialog"]:has(#parametric-eq-modal-title)');
    if (!dialog) throw new Error('EQ dialog not rendered');
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
      // A range input paints no value text of its own; its readouts are the
      // adjacent labels, already measured above.
      if (field instanceof HTMLInputElement && field.type === 'range') return;
      const text = field instanceof HTMLSelectElement ? field.selectedOptions[0]?.textContent ?? '' : field.value;
      if (text.trim()) measure(el, `[${field.getAttribute('aria-label') ?? field.tagName.toLowerCase()}] ${text.trim()}`);
    });
    return results;
  });

/** The scrim the overlay actually paints, read from computed style. */
const overlayBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.getElementById('parametric-eq-modal-overlay') as HTMLElement).backgroundColor);

const requiredRatio = (entry: { fontSize: number; bold: boolean }) =>
  entry.fontSize >= 24 || (entry.bold && entry.fontSize >= 18.66) ? 3 : 4.5;

const expectAllTextAA = (mode: string, texts: Awaited<ReturnType<typeof measureDialogText>>) => {
  const failing = texts.filter((t) => t.ratio < requiredRatio(t));
  const worst = texts.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  console.log(`[UI-03G] ${mode}: ${texts.length} text nodes, min ${worst.ratio}:1 ("${worst.text}")`);
  expect(failing, `text below AA in ${mode}: ${JSON.stringify(failing, null, 2)}`).toEqual([]);
};

test.describe('UI-03G Parametric EQ theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: text reaches AA, the scrim is the token and the graph paints this theme`, async ({ page }) => {
      await THEME_SET(page, mode);
      await page.goto(APP_URL);
      await waitForApp(page);
      if (mode === 'light') await switchThemeViaSettings(page, 'light');
      const dialog = await openEq(page);
      await expect(dialog.locator('canvas')).toHaveCount(1);

      expectAllTextAA(mode, await measureDialogText(page));

      // The overlay is the shared --apex-modal-overlay token in both themes.
      expect(await overlayBackground(page)).toBe(mode === 'dark' ? DARK_SCRIM : LIGHT_SCRIM);

      // The canvas paints this theme's background, grid and curve — and none of
      // the other theme's.
      const own = mode === 'dark' ? DARK_CANVAS : LIGHT_CANVAS;
      const other = mode === 'dark' ? LIGHT_CANVAS : DARK_CANVAS;
      const ownCurve = mode === 'dark' ? DARK_CURVE : LIGHT_CURVE;
      const otherCurve = mode === 'dark' ? LIGHT_CURVE : DARK_CURVE;
      const ownGrid = mode === 'dark' ? DARK_GRID : LIGHT_GRID;
      const otherGrid = mode === 'dark' ? LIGHT_GRID : DARK_GRID;

      const ownBands = mode === 'dark' ? BAND_STORED : BAND_LIGHT;
      const otherBands = mode === 'dark' ? BAND_LIGHT : BAND_STORED;
      const report = await canvasPalette(page, { curve: ownCurve, grid: ownGrid, bands: ownBands });
      console.log(`[UI-03G] ${mode} canvas: top rgb(${report.top}) x${report.topCount}/${report.total}, curve px ${report.curveCount}, grid px ${report.gridCount}, band px ${JSON.stringify(report.bandCounts)}`);
      expect(report.top, 'the canvas background is this theme\'s --apex-canvas').toEqual(own);
      expect(report.topCount / report.total).toBeGreaterThan(0.9);
      expect(report.curveCount, 'the response curve is painted in this theme\'s colour').toBeGreaterThan(0);
      expect(report.gridCount, 'the frequency/dB grid is painted from this theme\'s grid token').toBeGreaterThan(0);

      // Every band node is painted, in this theme's display colour. The nodes
      // are small (measured 36-92 px each), so this needs a real lower bound
      // rather than "> 0" to be meaningful.
      report.bandCounts.forEach((count, index) => {
        expect(count, `${mode}: band ${index + 1} node is painted in this theme's display colour`).toBeGreaterThan(20);
      });

      const otherReport = await canvasPalette(page, { curve: otherCurve, grid: otherGrid, bands: otherBands });
      expect(otherReport.top).not.toEqual(other);
      expect(otherReport.curveCount, 'the other theme\'s curve colour is absent').toBe(0);
      expectOtherGridAbsent(mode, otherReport.gridCount, report.gridCount);
      // Only the Light direction is asserted absent, because that is the
      // regression this mapping fixes: the stored colours painted on the Light
      // canvas (2.63 / 1.94 / 2.91:1). The Dark direction is deliberately not
      // asserted: Light's mid display colour #1f8a4d lies almost exactly on the
      // blend path from #2ecc71 to the Dark canvas, so the Dark node's
      // antialiased rim passes through it and contributes ~2 px. That is an
      // edge artifact, not a wrong-theme fill.
      if (mode === 'light') {
        otherReport.bandCounts.forEach((count, index) => {
          expect(count, `the stored band ${index + 1} colour is no longer painted on the Light canvas`).toBe(0);
        });
      }
    });

    test(`${mode}: editing a band keeps every control at AA and republishes`, async ({ page }) => {
      await THEME_SET(page, mode);
      await page.goto(APP_URL);
      await waitForApp(page);
      if (mode === 'light') await switchThemeViaSettings(page, 'light');
      const dialog = await openEq(page);

      // A preset exercises the publication path and repaints all three cards.
      await dialog.locator('button:has-text("Vocal Clarity & Air")').click();
      await expect(dialog.locator('button:has-text("Band 2")')).toBeVisible();

      // Move the mid band's gain through the slider: the sign colour changes.
      const gain = dialog.locator('input[type="range"][min="-18"]');
      await gain.fill('-6');
      await expect(dialog.locator('text=-6 dB').first()).toBeVisible();
      // Controls ease between states (`transition`); measure them at rest.
      await page.waitForTimeout(500);

      expectAllTextAA(mode, await measureDialogText(page));
    });
  }

  test('a live theme flip repaints the open graph in both directions', async ({ page }) => {
    await THEME_SET(page, 'dark');
    await page.goto(APP_URL);
    await waitForApp(page);
    await openEq(page);

    let report = await canvasPalette(page, { curve: DARK_CURVE, grid: DARK_GRID });
    expect(report.top).toEqual(DARK_CANVAS);
    expect(report.curveCount).toBeGreaterThan(0);
    expect(report.gridCount).toBeGreaterThan(0);

    await flipDocumentTheme(page, 'light');
    await page.waitForTimeout(250);
    report = await canvasPalette(page, { curve: LIGHT_CURVE, grid: LIGHT_GRID });
    expect(report.top, 'the canvas is repainted in Light with no reload').toEqual(LIGHT_CANVAS);
    expect(report.curveCount).toBeGreaterThan(0);
    expect(report.gridCount).toBeGreaterThan(0);
    const stale = await canvasPalette(page, { curve: DARK_CURVE, grid: DARK_GRID, bands: BAND_STORED });
    expect(stale.curveCount, 'no stale Dark curve after the flip').toBe(0);
    expectOtherGridAbsent('after the flip', stale.gridCount, report.gridCount);
    expect(stale.top, 'no stale Dark background after the flip').not.toEqual(DARK_CANVAS);
    // Light is the direction where absence is provable, so the flip check uses it.
    stale.bandCounts.forEach((count, index) => {
      expect(count, `no stale stored band ${index + 1} colour after the flip to Light`).toBe(0);
    });

    await flipDocumentTheme(page, 'dark');
    await page.waitForTimeout(250);
    report = await canvasPalette(page, { curve: DARK_CURVE, grid: DARK_GRID });
    expect(report.top, 'the canvas is repainted back in Dark').toEqual(DARK_CANVAS);
    expect(report.curveCount).toBeGreaterThan(0);
  });
});
