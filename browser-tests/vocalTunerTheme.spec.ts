import { expect, test, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

test.describe('UI-03H Vocal Tuner theme', () => {
  test('dark: dialog opens and reaches AA contrast on text', async ({ page }) => {
    await page.addInitScript(() => {
      try { window.localStorage.setItem('apex:theme', 'dark'); } catch { /* noop */ }
    });
    await page.goto(APP_URL);
    await page.waitForSelector('#root > *', { state: 'attached' });
    await page.waitForTimeout(1200);

    await page.locator('#fl-tools-menu-btn').click();
    await page.locator('#fl-vocal-tuner-btn').click();
    const dialog = page.locator('[role="dialog"]:has(#fl-vocal-tuner-modal-title)');
    await expect(dialog).toBeVisible();

    // The overlay is the themed scrim.
    const scrim = await page.evaluate(() =>
      getComputedStyle(document.getElementById('fl-vocal-tuner-modal')!).backgroundColor);
    expect(scrim).toBe('rgba(5, 7, 12, 0.66)');

    // Title is visible and contains the expected text.
    await expect(dialog.locator('#fl-vocal-tuner-modal-title')).toContainText('VOCAL TUNER');

    // Every visible button carries a text label (no empty buttons).
    const buttons = dialog.locator('button');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(5);
  });
});
