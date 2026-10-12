import { expect, test } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

test.describe('UI-03H Vocal Tuner theme (smoke)', () => {
  test('the app boots dark and the vocal tuner dialog opens', async ({ page }) => {
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
    await expect(dialog.locator('#fl-vocal-tuner-modal-title')).toContainText('VOCAL TUNER');
  });
});
