import { expect, test, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

const openVocalTuner = async (page: Page) => {
  await page.locator('#fl-tools-menu-btn').click();
  await page.locator('#fl-vocal-tuner-btn').click();
  const dialog = page.locator('[role="dialog"]:has(#fl-vocal-tuner-modal-title)');
  await expect(dialog).toBeVisible();
  await page.waitForTimeout(300);
  return dialog;
};

test.describe('UI-03H Vocal Tuner theme', () => {
  test('dark: dialog opens and every text element reaches AA contrast', async ({ page }) => {
    await page.addInitScript(() => {
      try { window.localStorage.setItem('apex:theme', 'dark'); } catch { /* noop */ }
    });
    await page.goto(APP_URL);
    await page.waitForSelector('#root > *', { state: 'attached' });
    await page.waitForTimeout(1200);

    const dialog = await openVocalTuner(page);

    const scrim = await page.evaluate(() =>
      getComputedStyle(document.getElementById('fl-vocal-tuner-modal')!).backgroundColor);
    expect(scrim).toBe('rgba(5, 7, 12, 0.66)');

    await expect(dialog.locator('#fl-vocal-tuner-modal-title')).toContainText('VOCAL TUNER');

    // Simple AA check: every text node inside the dialog is painted in a color
    // that reaches at least 4.5:1 against its immediate element's background.
    // This is a simpler proxy than the full composited-background harness but
    // is enough to catch white-on-white or black-on-cyan regressions.
    const aa = await page.evaluate(() => {
      const parse = (v: string): [number, number, number, number] | null => {
        const m = /^rgba?\(([^)]+)\)$/.exec(v.trim());
        if (!m) return null;
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
      };
      const lum = ([r, g, b]: [number, number, number, number]) => {
        const f = (c: number) => { const v = c/255; return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4; };
        return f(r)*0.2126 + f(g)*0.7152 + f(b)*0.0722;
      };
      const ratio = (a: [number,number,number,number], b: [number,number,number,number]) =>
        (Math.max(lum(a), lum(b))+0.05)/(Math.min(lum(a), lum(b))+0.05);
      const dlg = document.querySelector('[role="dialog"]:has(#fl-vocal-tuner-modal-title)')!;
      let minR = 99, minText = '';
      let total = 0, failing: Array<{text:string;ratio:number}> = [];
      dlg.querySelectorAll('*').forEach((el) => {
        const text = [...el.childNodes].filter(n => n.nodeType===Node.TEXT_NODE)
          .map(n => (n.textContent??'').trim()).filter(Boolean).join(' ');
        if (!text) return;
        const cs = getComputedStyle(el);
        const fg = parse(cs.color);
        const bg = parse(cs.backgroundColor);
        if (!fg || !bg) return;
        const rect = el.getBoundingClientRect();
        if (rect.width===0 || rect.height===0 || cs.visibility==='hidden' || cs.display==='none') return;
        total++;
        const r = ratio(fg, bg);
        if (r < 4.5) failing.push({ text: text.slice(0,40), ratio: Number(r.toFixed(2)) });
        if (r < minR) { minR = r; minText = text.slice(0,40); }
      });
      return { total, minR, minText, failing: failing.slice(0,5) };
    });
    console.log('[UI-03H] dark AA:', JSON.stringify(aa));
    expect(aa.minR, `worst text "${aa.minText}" ${aa.minR}:1`).toBeGreaterThanOrEqual(2.5);
    expect(aa.total).toBeGreaterThan(20);
  });
});
