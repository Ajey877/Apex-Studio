import { expect, test } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

const contrastRatio = (foreground: string, background: string): number => {
  const luminance = (color: string): number => {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length < 3) throw new Error(`Cannot parse computed color: ${color}`);
    const linear = channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

test.describe('UI-03J Gross Beat theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: themed chrome, effect colors, and gate controls`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.addInitScript((value: string) => {
        try { window.localStorage.setItem('apex:theme', value); } catch { /* noop */ }
      }, mode);
      await page.goto(APP_URL);
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      await page.locator('#fl-tools-menu-btn').click();
      await page.locator('#fl-gross-beat-btn').click();
      const dialog = page.locator('#gross-beat-modal');
      const panel = dialog.locator(':scope > div');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-labelledby', 'gross-beat-modal-title');
      await expect(dialog.locator('#gross-beat-modal-title')).toHaveText('MASTER GATE');
      await expect(dialog.getByText('16-step gate on the master bus, live and in export.')).toBeVisible();

      const expected = mode === 'dark'
        ? {
            panel: 'rgb(25, 28, 37)',
            header: 'rgb(31, 36, 49)',
            gold: 'rgb(255, 184, 107)',
            success: 'rgb(98, 215, 164)',
            surface3: 'rgb(38, 43, 56)',
            scrim: 'rgba(5, 7, 12, 0.66)',
          }
        : {
            panel: 'rgb(255, 255, 255)',
            header: 'rgb(231, 235, 242)',
            gold: 'rgb(154, 93, 0)',
            success: 'rgb(20, 115, 78)',
            surface3: 'rgb(232, 236, 243)',
            scrim: 'rgba(24, 32, 45, 0.55)',
          };

      await expect(panel).toHaveCSS('background-color', expected.panel);
      await expect(panel.locator(':scope > div').first()).toHaveCSS('background-color', expected.header);
      await expect(dialog).toHaveCSS('background-color', expected.scrim);

      const brandTile = panel.locator(':scope > div').first().locator('div.w-8.h-8');
      await expect(brandTile).toHaveCSS('background-color', expected.gold);
      const depthReadout = dialog.locator('span.font-mono').filter({ hasText: /^100%$/ });
      await expect(depthReadout).toHaveCSS('color', expected.gold);
      const depthContrast = await depthReadout.evaluate((element) => {
        let surface = element.parentElement;
        while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') {
          surface = surface.parentElement;
        }
        if (!surface) throw new Error('Could not find the gate-depth surface');
        return {
          foreground: getComputedStyle(element).color,
          background: getComputedStyle(surface).backgroundColor,
        };
      });
      expect(contrastRatio(depthContrast.foreground, depthContrast.background)).toBeGreaterThanOrEqual(4.5);

      const titleContrast = await dialog.locator('#gross-beat-modal-title').evaluate((element) => ({
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(element.parentElement!.parentElement!.parentElement!.parentElement!).backgroundColor,
      }));
      expect(contrastRatio(titleContrast.foreground, titleContrast.background)).toBeGreaterThanOrEqual(4.5);
      const cta = dialog.getByRole('button', { name: 'Apply & Close' });
      const ctaContrast = await cta.evaluate((element) => ({
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(element).backgroundColor,
      }));
      await expect(cta).toHaveCSS('background-color', expected.gold);
      expect(contrastRatio(ctaContrast.foreground, ctaContrast.background)).toBeGreaterThanOrEqual(4.5);

      const range = dialog.locator('input[type="range"]');
      await expect(range).toHaveAttribute('min', '0');
      await expect(range).toHaveAttribute('max', '1');
      await expect(range).toHaveAttribute('step', '0.05');
      await expect(range).toHaveValue('1');
      await expect(dialog.locator('select option')).toHaveCount(5);

      // Turning on the effect keeps the success state distinct from the orange
      // Gross Beat identity color, with a theme-safe foreground in both modes.
      await dialog.getByRole('button', { name: 'BYPASS' }).click();
      const activePower = dialog.getByRole('button', { name: 'EFFECT ACTIVE' });
      await dialog.locator('#gross-beat-modal-title').hover();
      await expect(activePower).toHaveCSS('background-color', expected.success);
      const activePowerContrast = await activePower.evaluate((element) => ({
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(element).backgroundColor,
      }));
      expect(contrastRatio(activePowerContrast.foreground, activePowerContrast.background)).toBeGreaterThanOrEqual(4.5);

      // Selecting a preset and editing the 16-step grid still updates the live
      // ProjectState-owned pattern; the theme change only replaces its paint.
      await dialog.getByRole('button', { name: /Half-Bar Chop/ }).click();
      const steps = dialog.locator('div.grid-cols-16 > div');
      await expect(steps).toHaveCount(16);
      await expect(steps.nth(0).locator('div.w-full')).toHaveCSS('background-color', expected.gold);
      await expect(steps.nth(8).locator('div.w-full')).toHaveCSS('background-color', expected.surface3);

      await steps.nth(8).click();
      await dialog.locator('#gross-beat-modal-title').hover();
      await expect(steps.nth(8).locator('div.w-full')).toHaveCSS('background-color', expected.gold);
      await dialog.getByRole('button', { name: 'All Open' }).click();
      await expect(steps.nth(15).locator('div.w-full')).toHaveCSS('background-color', expected.gold);
      await dialog.getByRole('button', { name: 'Invert' }).click();
      await expect(steps.nth(0).locator('div.w-full')).toHaveCSS('background-color', expected.surface3);

      await range.focus();
      await range.press('ArrowLeft');
      await expect(range).toHaveValue('0.95');
      await expect(dialog.locator('span.font-mono').filter({ hasText: /^95%$/ })).toBeVisible();
      await expect(dialog.getByText('Closed steps: 10% gain')).toBeVisible();

      await cta.click();
      await expect(dialog).toBeHidden();
    });
  }
});
