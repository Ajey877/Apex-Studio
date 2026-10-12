import { expect, test, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

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

test.describe('UI-03H Vocal Tuner theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: dialog opens with themed scrim, title, sliders and primary button`, async ({ page }) => {
      await page.addInitScript((value: string) => {
        try { window.localStorage.setItem('apex:theme', value); } catch { /* noop */ }
      }, mode);
      await page.goto(APP_URL);
      await page.waitForSelector('#root > *', { state: 'attached' });
      await page.waitForTimeout(1200);
      if (mode === 'light') await switchThemeViaSettings(page, 'light');

      const dialog = await openVocalTuner(page);

      await expect(dialog.locator('#fl-vocal-tuner-modal-title')).toContainText('VOCAL TUNER');
      await expect(dialog.locator('input[type="range"]')).toHaveCount(4);
      await expect(dialog.locator('button:has-text("Apply & Done")')).toBeVisible();
      await expect(dialog.locator('text=ENABLED (NOT APPLIED)')).toBeVisible();

      // Overlay scrim is the themed token.
      const overlay = page.locator('#fl-vocal-tuner-modal');
      const expectedScrim = mode === 'dark' ? 'rgba(5, 7, 12, 0.66)' : 'rgba(24, 32, 45, 0.55)';
      await expect(overlay).toHaveCSS('background-color', expectedScrim);

      // The panel's background resolves to the surface token (not the legacy
      // dark #121214 panel), so Light paints a light panel.
      const panelBg = await dialog.evaluate((d) => getComputedStyle(d.firstElementChild as HTMLElement).backgroundColor);
      if (mode === 'dark') {
        // Dark --apex-surface is #191c25 = rgb(25, 28, 37).
        expect(panelBg).toBe('rgb(25, 28, 37)');
      } else {
        // Light --apex-surface is #ffffff.
        expect(panelBg).toBe('rgb(255, 255, 255)');
      }
    });
  }
});
