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

test.describe('UI-03K Arpeggiator theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: themed chrome, arp identity, and pattern controls`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.addInitScript((value: string) => {
        try { window.localStorage.setItem('apex:theme', value); } catch { /* noop */ }
      }, mode);
      await page.goto(APP_URL);
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      await page.locator('button[title="Arpeggiator & Euclidean Rhythm Engine"]').first().click();
      const dialog = page.locator('[aria-labelledby="arpeggiator-modal-title"]');
      const panel = dialog.locator(':scope > div');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('role', 'dialog');
      await expect(dialog.locator('#arpeggiator-modal-title')).toHaveText(/ARPEGGIATOR$/);

      const expected = mode === 'dark'
        ? {
            panel: 'rgb(25, 28, 37)',
            header: 'rgb(31, 36, 49)',
            gold: 'rgb(255, 184, 107)',
            success: 'rgb(98, 215, 164)',
            surface3: 'rgb(38, 43, 56)',
            cyanText: 'rgb(103, 217, 255)',
            playingFg: 'rgb(13, 15, 22)',
            scrim: 'rgba(5, 7, 12, 0.66)',
          }
        : {
            panel: 'rgb(255, 255, 255)',
            header: 'rgb(231, 235, 242)',
            gold: 'rgb(154, 93, 0)',
            success: 'rgb(20, 115, 78)',
            surface3: 'rgb(232, 236, 243)',
            cyanText: 'rgb(6, 87, 117)',
            playingFg: 'rgb(255, 255, 255)',
            scrim: 'rgba(24, 32, 45, 0.55)',
          };

      await expect(panel).toHaveCSS('background-color', expected.panel);
      await expect(panel.locator(':scope > div').first()).toHaveCSS('background-color', expected.header);
      await expect(dialog).toHaveCSS('background-color', expected.scrim);

      // The warm orange arpeggiator identity lands on the shared gold token,
      // with a theme-safe on-colour in both modes.
      const brandTile = panel.locator(':scope > div').first().locator('div.w-8.h-8');
      await expect(brandTile).toHaveCSS('background-color', expected.gold);
      const titleContrast = await dialog.locator('#arpeggiator-modal-title').evaluate((element) => ({
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(element.parentElement!.parentElement!.parentElement!.parentElement!).backgroundColor,
      }));
      expect(contrastRatio(titleContrast.foreground, titleContrast.background)).toBeGreaterThanOrEqual(4.5);

      const gateReadout = dialog.locator('span.font-mono').filter({ hasText: /^85%$/ });
      await expect(gateReadout).toHaveCSS('color', expected.success);
      const strumReadout = dialog.locator('span.font-mono').filter({ hasText: /^15ms$/ });
      await expect(strumReadout).toHaveCSS('color', expected.cyanText);
      const strumContrast = await strumReadout.evaluate((element) => {
        let surface = element.parentElement;
        while (surface && getComputedStyle(surface).backgroundColor === 'rgba(0, 0, 0, 0)') {
          surface = surface.parentElement;
        }
        if (!surface) throw new Error('Could not find the strum slider surface');
        return {
          foreground: getComputedStyle(element).color,
          background: getComputedStyle(surface).backgroundColor,
        };
      });
      expect(contrastRatio(strumContrast.foreground, strumContrast.background)).toBeGreaterThanOrEqual(4.5);

      const cta = dialog.getByRole('button', { name: 'Save Arp Settings' });
      const ctaContrast = await cta.evaluate((element) => ({
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(element).backgroundColor,
      }));
      await expect(cta).toHaveCSS('background-color', expected.gold);
      expect(contrastRatio(ctaContrast.foreground, ctaContrast.background)).toBeGreaterThanOrEqual(4.5);

      // Neutral hover keeps moving toward contrast on the audition control.
      const audition = dialog.getByRole('button', { name: 'Audition Pattern' });
      const restBg = await audition.evaluate((element) => getComputedStyle(element).backgroundColor);
      await expect(audition).toHaveCSS('background-color', expected.surface3);
      await audition.hover();
      const hoverBg = await audition.evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(hoverBg).not.toBe(restBg);

      // Enabling the arp keeps the success state distinct from the gold
      // identity color, with a theme-safe foreground in both modes.
      await dialog.getByRole('button', { name: 'OFF', exact: true }).click();
      const onButton = dialog.getByRole('button', { name: 'ON', exact: true });
      await dialog.locator('#arpeggiator-modal-title').hover();
      await expect(onButton).toHaveCSS('background-color', expected.success);
      const onContrast = await onButton.evaluate((element) => ({
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(element).backgroundColor,
      }));
      expect(contrastRatio(onContrast.foreground, onContrast.background)).toBeGreaterThanOrEqual(4.5);
      await expect(dialog.getByText('ENABLED')).toBeVisible();

      // Switching to the euclidean mode still renders the live pattern; the
      // theme change only replaces its paint.
      await dialog.getByRole('button', { name: /EUCLIDEAN RHYTHM/ }).click();
      await expect(dialog.getByText('EUCLIDEAN RHYTHM GENERATOR')).toBeVisible();
      await expect(dialog.locator('span.font-mono').filter({ hasText: /^E\(5, 16\)$/ })).toBeVisible();
      const steps = dialog.locator('div[class*="min-w-[12px]"]');
      await expect(steps).toHaveCount(16);
      const hits = steps.filter({ hasText: /\d/ });
      await expect(hits).toHaveCount(5);
      await expect(hits.nth(0)).toHaveCSS('background-color', expected.gold);
      const hitContrast = await hits.nth(0).evaluate((element) => ({
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(element).backgroundColor,
      }));
      expect(contrastRatio(hitContrast.foreground, hitContrast.background)).toBeGreaterThanOrEqual(4.5);
      const offs = steps.filter({ hasNotText: /\d/ });
      await expect(offs.nth(0)).toHaveCSS('background-color', expected.surface3);

      // Editing the generator updates the readout and the painted grid.
      const stepsRange = dialog.locator('input[type="range"][min="4"][max="32"]');
      await stepsRange.focus();
      await stepsRange.press('ArrowRight');
      await expect(dialog.locator('span.font-mono').filter({ hasText: /^E\(5, 17\)$/ })).toBeVisible();
      await expect(steps).toHaveCount(17);
      await expect(steps.filter({ hasText: /\d/ })).toHaveCount(5);

      // The octave slider keeps its range and live readout.
      const octavesRange = dialog.locator('input[type="range"][min="1"][max="4"]');
      await expect(octavesRange).toHaveValue('2');
      await octavesRange.focus();
      await octavesRange.press('ArrowRight');
      await expect(dialog.locator('span.font-mono').filter({ hasText: /^3 Oct$/ })).toBeVisible();

      await cta.click();
      await expect(dialog).toBeHidden();
    });
  }
});
