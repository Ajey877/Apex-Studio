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
  test('dark: dialog opens with title, sliders and Apply & Done visible', async ({ page }) => {
    await page.addInitScript(() => {
      try { window.localStorage.setItem('apex:theme', 'dark'); } catch { /* noop */ }
    });
    await page.goto(APP_URL);
    await page.waitForSelector('#root > *', { state: 'attached' });
    await page.waitForTimeout(1200);

    const dialog = await openVocalTuner(page);

    // Title.
    await expect(dialog.locator('#fl-vocal-tuner-modal-title')).toContainText('VOCAL TUNER');

    // Four parameter sliders are present (retune, formant, vibrato, humanize).
    await expect(dialog.locator('input[type="range"]')).toHaveCount(4);

    // Apply & Done button renders.
    await expect(dialog.locator('button:has-text("Apply & Done")')).toBeVisible();

    // ENABLED badge is visible when enabled.
    await expect(dialog.locator('text=ENABLED (NOT APPLIED)')).toBeVisible();
  });
});
