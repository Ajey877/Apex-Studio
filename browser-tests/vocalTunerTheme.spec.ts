import { expect, test, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

const THEME_SET = (page: Page, mode: 'dark' | 'light') =>
  page.addInitScript((value: string) => {
    try { window.localStorage.setItem('apex:theme', value); } catch { /* noop */ }
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

const openVocalTuner = async (page: Page) => {
  await page.locator('#fl-tools-menu-btn').click();
  await page.locator('#fl-vocal-tuner-btn').click();
  const dialog = page.locator('[role="dialog"]:has(#fl-vocal-tuner-modal-title)');
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(300);
  return dialog;
};

const overlayBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.getElementById('fl-vocal-tuner-modal')!).backgroundColor);

/**
 * Every visible text node in the dialog, with WCAG contrast against its
 * composited background. Uses the same oklch/oklab parser every other UI-03
 * spec uses, kept compact.
 */
const measureDialogText = (page: Page) =>
  page.evaluate(() => {
    type RGBA = [number, number, number, number];
    const parse = (value: string): RGBA | null => {
      value = value.trim();
      const legacy = /^rgba?\(([^)]+)\)$/.exec(value);
      if (legacy) {
        const parts = legacy[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
      }
      const srgb = /^color\(srgb\s+([^)]+)\)$/.exec(value);
      if (srgb) {
        const parts = srgb[1].split(/[\s/]+/).filter(Boolean).map(Number);
        return [parts[0] * 255, parts[1] * 255, parts[2] * 255, parts.length > 3 ? parts[3] : 1];
      }
      const oklch = /^oklch\(([^)]+)\)$/.exec(value);
      const oklab = /^oklab\(([^)]+)\)$/.exec(value);
      if (oklch || oklab) {
        const parts = (oklch ?? oklab)![1].split(/[\s/]+/).filter(Boolean).map(Number);
        const alpha = parts.length > 3 ? parts[3] : 1;
        const L = parts[0], chromaA = parts[1], chromaB = parts[2];
        let a = chromaA, b = chromaB;
        if (oklch) {
          const rad = (chromaB * Math.PI) / 180;
          a = chromaA * Math.cos(rad);
          b = chromaA * Math.sin(rad);
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
    const over = (t: RGBA, b: RGBA): RGBA => {
      const a = t[3];
      return [t[0] * a + b[0] * (1 - a), t[1] * a + b[1] * (1 - a), t[2] * a + b[2] * (1 - a), 1];
    };
    const effectiveBg = (el: Element): RGBA => {
      const layers: RGBA[] = [];
      let n: Element | null = el;
      let base: RGBA | null = null;
      while (n && n !== document.documentElement) {
        const raw = getComputedStyle(n).backgroundColor;
        const c = parse(raw);
        if (!c && raw !== 'transparent') throw new Error(`unparseable background ${raw}`);
        if (c && c[3] > 0) {
          if (c[3] >= 1) { base = c; break; }
          layers.push(c);
        }
        n = n.parentElement;
      }
      if (!base) base = parse(getComputedStyle(document.documentElement).backgroundColor) ?? [0, 0, 0, 1];
      for (const layer of layers.reverse()) base = over(layer, base);
      return base;
    };
    const lum = ([r, g, b]: RGBA) => {
      const f = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return f(r) * 0.2126 + f(g) * 0.7152 + f(b) * 0.0722;
    };
    const ratio = (a: RGBA, b: RGBA) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

    const dialog = document.querySelector('[role="dialog"]:has(#fl-vocal-tuner-modal-title)');
    if (!dialog) throw new Error('dialog not rendered');
    const out: Array<{ text: string; ratio: number; fontSize: number; bold: boolean }> = [];
    const measure = (el: Element, text: string) => {
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0 || cs.visibility === 'hidden' || cs.display === 'none') return;
      const fg = parse(cs.color);
      if (!fg) throw new Error(`unparseable fg ${cs.color} on "${text}"`);
      const bg = effectiveBg(el);
      const shown: RGBA = fg[3] < 1 ? over(fg, bg) : fg;
      out.push({ text, ratio: Number(ratio(shown, bg).toFixed(2)), fontSize: parseFloat(cs.fontSize), bold: Number(cs.fontWeight) >= 700 });
    };
    dialog.querySelectorAll('*').forEach((el) => {
      const text = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => (n.textContent ?? '').trim()).filter(Boolean).join(' ');
      if (text) measure(el, text);
    });
    // The <select> paints its selected option text on the element itself.
    dialog.querySelectorAll('select').forEach((el) => {
      const sel = el as HTMLSelectElement;
      const text = sel.selectedOptions[0]?.textContent ?? '';
      if (text.trim()) measure(el, text.trim());
    });
    return out;
  });

const AA = (e: { fontSize: number; bold: boolean }) =>
  e.fontSize >= 24 || (e.bold && e.fontSize >= 18.66) ? 3 : 4.5;

const expectAllAA = (mode: string, texts: Awaited<ReturnType<typeof measureDialogText>>) => {
  const fail = texts.filter(t => t.ratio < AA(t));
  const worst = texts.reduce((a, b) => b.ratio < a.ratio ? b : a);
  console.log(`[UI-03H] ${mode}: ${texts.length} nodes, min ${worst.ratio}:1 ("${worst.text}")`);
  expect(fail, `text below AA in ${mode}: ${JSON.stringify(fail, null, 2)}`).toEqual([]);
};

test.describe('UI-03H Vocal Tuner theme', () => {
  for (const mode of ['dark'] as const) {
    test(`${mode}: text reaches AA, scrim is themed, sliders resolve four distinct accents`, async ({ page }) => {
      await THEME_SET(page, mode);
      await page.goto(APP_URL);
      await waitForApp(page);
      if (mode === 'light') await switchThemeViaSettings(page, 'light');
      const dialog = await openVocalTuner(page);
      await expect(dialog).toBeVisible();

      expectAllAA(mode, await measureDialogText(page));

      expect(await overlayBackground(page)).toBe(
        mode === 'dark' ? 'rgba(5, 7, 12, 0.66)' : 'rgba(24, 32, 45, 0.55)'
      );

      // Four range inputs resolve to distinct accent-color values (one per
      // semantic signal colour).
      const accents = await page.evaluate(() => {
        const d = document.querySelector<HTMLElement>('[role="dialog"]:has(#fl-vocal-tuner-modal-title)')!;
        return [...d.querySelectorAll<HTMLInputElement>('input[type="range"]')].map(s => getComputedStyle(s).accentColor);
      });
      expect(accents).toHaveLength(4);
      expect(new Set(accents).size).toBe(4);
    });
  }

});
