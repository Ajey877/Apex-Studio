import { expect, test, type Page } from '@playwright/test';

/** Matches the URL the existing browser suite and `webServer` config both use. */
const APP_URL = 'http://localhost:3000';

/**
 * UI-03H — the Vocal Tuner surface in a real browser, in both themes.
 *
 * The Vocal Tuner has no canvas, so the suite proves what DOM-only tests
 * cannot: the dialog opens in Dark and Light; every piece of visible text
 * reaches WCAG AA against its computed composited background; the scrim is
 * the shared overlay token; and the four parameter sliders paint their
 * signal accents through `accent-color` (a non-inherited CSS property the
 * markup-only suites cannot resolve).
 *
 * The suite never opens a microphone and never plays audio, consistent with
 * Phase 52: the panel is stored-intent only.
 */

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

const switchThemeViaSettings = async (page: Page, mode: 'dark' | 'light') => {
  await page.locator('button[aria-label="Open Settings"]').first().click();
  const settings = page.locator('#appearance-settings-modal');
  await expect(settings).toBeVisible();
  await settings.locator(`label:has(input[value="${mode}"])`).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
};

/** Opens the Vocal Tuner the way a user does: Tools → Vocal tuner. */
const openVocalTuner = async (page: Page) => {
  await page.locator('#fl-tools-menu-btn').click();
  const vtBtn = page.locator('#fl-vocal-tuner-btn');
  await expect(vtBtn).toBeVisible();
  await vtBtn.click();
  const dialog = page.locator('[role="dialog"]:has(#fl-vocal-tuner-modal-title)');
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(300);
  return dialog;
};

/**
 * Every visible text node in the dialog, with the contrast of its computed
 * colour against the colour painted behind it. The background is composited
 * from the nearest opaque ancestor outward.
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

    const dialog = document.querySelector('[role="dialog"]:has(#fl-vocal-tuner-modal-title)');
    if (!dialog) throw new Error('Vocal Tuner dialog not rendered');
    const results: Array<{ text: string; ratio: number; fontSize: number; bold: boolean }> = [];
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
    dialog.querySelectorAll('select').forEach((el) => {
      const field = el as HTMLSelectElement;
      const text = field.selectedOptions[0]?.textContent ?? '';
      if (text.trim()) measure(el, text.trim());
    });
    return results;
  });

const overlayBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.getElementById('fl-vocal-tuner-modal') as HTMLElement).backgroundColor);

const requiredRatio = (entry: { fontSize: number; bold: boolean }) =>
  entry.fontSize >= 24 || (entry.bold && entry.fontSize >= 18.66) ? 3 : 4.5;

const expectAllTextAA = (mode: string, texts: Awaited<ReturnType<typeof measureDialogText>>) => {
  const failing = texts.filter((t) => t.ratio < requiredRatio(t));
  const worst = texts.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  console.log(`[UI-03H] ${mode}: ${texts.length} text nodes, min ${worst.ratio}:1 ("${worst.text}")`);
  expect(failing, `text below AA in ${mode}: ${JSON.stringify(failing, null, 2)}`).toEqual([]);
};

/** Reads the four sliders' resolved accent-colour and the Apply button's fill. */
const readAccents = (page: Page) =>
  page.evaluate(() => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]:has(#fl-vocal-tuner-modal-title)');
    if (!dialog) throw new Error('Vocal Tuner dialog not rendered');
    const sliders = [...dialog.querySelectorAll<HTMLInputElement>('input[type="range"]')];
    if (sliders.length < 4) throw new Error(`expected 4 sliders, found ${sliders.length}`);
    // The four in source order: retune (cyan), formant (success), vibrato (accent), humanize (aux).
    const accents = sliders.map((s) => getComputedStyle(s).accentColor);
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button')];
    const applyBtn = buttons.find((b) => (b.textContent ?? '').includes('Apply & Done')) ?? buttons[buttons.length - 1];
    const applyBg = applyBtn ? getComputedStyle(applyBtn).backgroundColor : '';
    return { accents, applyBg };
  });

test.describe('UI-03H Vocal Tuner theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: text reaches AA and the scrim is the shared overlay token`, async ({ page }) => {
      await THEME_SET(page, mode);
      await page.goto(APP_URL);
      await waitForApp(page);
      if (mode === 'light') await switchThemeViaSettings(page, 'light');
      const dialog = await openVocalTuner(page);
      await expect(dialog).toBeVisible();

      expectAllTextAA(mode, await measureDialogText(page));
      expect(await overlayBackground(page)).toBe(mode === 'dark' ? DARK_SCRIM : LIGHT_SCRIM);

      // Each slider carries the semantic signal colour that distinguishes it,
      // resolved to a concrete accent by the UA at runtime.
      const accents = await readAccents(page);
      expect(accents.accents).toHaveLength(4);
      for (const c of accents.accents) {
        // Accent is always a resolved non-token colour (rgb/rgba/color(...)).
        expect(c).toMatch(/^(?:rgb|color|oklch|oklab)\(/);
      }
      // The four resolved accents must be pairwise distinct (cyan ≠ green ≠
      // violet ≠ aux) — that is the whole point of using separate signal
      // tokens.
      const uniq = new Set(accents.accents);
      expect(uniq.size, 'the four slider accents resolve to distinct colours').toBe(4);
    });
  }

  test('the ENABLED/ON and Apply & Done buttons stay AA in both themes', async ({ page }) => {
    await THEME_SET(page, 'dark');
    await page.goto(APP_URL);
    await waitForApp(page);
    let dialog = await openVocalTuner(page);
    expectAllTextAA('dark', await measureDialogText(page));
    await dialog.locator('button[aria-label="Close vocal tuner"]').click();
    await expect(dialog).toBeHidden();
    await switchThemeViaSettings(page, 'light');
    dialog = await openVocalTuner(page);
    expectAllTextAA('light', await measureDialogText(page));
  });
});
