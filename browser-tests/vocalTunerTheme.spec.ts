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
  test('dark: dialog opens, scrim is themed, accents are distinct', async ({ page }) => {
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

    // Each of the four range inputs has a non-empty resolved accent-color.
    const accentColors = await dialog.locator('input[type="range"]').evaluateAll(
      (els) => els.map((e) => getComputedStyle(e as HTMLInputElement).accentColor));
    expect(accentColors).toHaveLength(4);
    for (const c of accentColors) {
      expect(c.length).toBeGreaterThan(3);
    }
    expect(new Set(accentColors).size).toBe(4);
  });
});
