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

const contrastRatio = (foreground: string, background: string): number => {
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    if (!channels || channels.length < 3) throw new Error(`Cannot parse computed color: ${color}`);
    const linear = channels.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

test.describe('UI-03I MIDI Controller theme', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: dialog chrome, MIDI states, pads, and theme-aware keys`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.addInitScript((value: string) => {
        try { window.localStorage.setItem('apex:theme', value); } catch { /* noop */ }
      }, mode);
      await page.goto(APP_URL);
      await page.waitForSelector('#root > *', { state: 'attached' });
      await page.waitForTimeout(1200);
      if (mode === 'light') await switchThemeViaSettings(page, 'light');
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      await page.locator('#fl-midi-hub-btn').click();
      const dialog = page.locator('#midi-controller-modal-overlay');
      const panel = page.locator('#midi-controller-modal-container');
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-labelledby', 'midi-controller-modal-title');
      await expect(dialog.locator('#midi-controller-modal-title')).toContainText('Hardware MIDI & Controller Hub');
      await expect(dialog.locator('#tab-midi-devices')).toContainText('Connected Devices');
      await expect(dialog.getByText('Web MIDI Engine Active')).toBeVisible();
      await expect(dialog.getByText('No Hardware MIDI Devices Detected')).toBeVisible();

      // Main surfaces and title resolve from the active palette, not the legacy dark literals.
      const expected = mode === 'dark'
        ? { panel: 'rgb(25, 28, 37)', header: 'rgb(31, 36, 49)', accent: 'rgb(155, 138, 251)', success: 'rgb(98, 215, 164)', pianoKey: 'rgb(32, 36, 48)' }
        : { panel: 'rgb(255, 255, 255)', header: 'rgb(231, 235, 242)', accent: 'rgb(101, 82, 206)', success: 'rgb(20, 115, 78)', pianoKey: 'rgb(255, 255, 255)' };
      await expect(panel).toHaveCSS('background-color', expected.panel);
      const header = panel.locator(':scope > div').first();
      await expect(header).toHaveCSS('background-color', expected.header);
      await expect(dialog.locator('#tab-midi-devices')).toHaveCSS('color', expected.accent);
      await expect(dialog.locator('span.animate-pulse').first()).toHaveCSS('background-color', expected.success);
      await expect(dialog).toHaveCSS(
        'background-color',
        mode === 'dark' ? 'rgba(5, 7, 12, 0.66)' : 'rgba(24, 32, 45, 0.55)'
      );

      const titleColors = await dialog.evaluate((root) => ({
        foreground: getComputedStyle(root.querySelector('#midi-controller-modal-title')!).color,
        background: getComputedStyle(root.querySelector('#midi-controller-modal-container')!).backgroundColor,
      }));
      expect(contrastRatio(titleColors.foreground, titleColors.background)).toBeGreaterThanOrEqual(4.5);
      const descriptionColors = await header.locator('p').evaluate((element) => ({
        foreground: getComputedStyle(element).color,
        background: getComputedStyle(element.parentElement!.parentElement!.parentElement!).backgroundColor,
      }));
      expect(contrastRatio(descriptionColors.foreground, descriptionColors.background)).toBeGreaterThanOrEqual(4.5);

      // The MIDI Learn armed banner and quick-arm controls still work after their chrome was tokenised.
      await dialog.locator('#tab-midi-learn').click();
      await expect(dialog.getByRole('button', { name: /Master Volume/ })).toBeVisible();
      await dialog.getByRole('button', { name: /Master Volume/ }).click();
      await expect(dialog.getByText(/MIDI Learn Armed: Waiting for Hardware CC Knob \/ Fader/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog.getByText(/MIDI Learn Armed:/)).toBeHidden();

      // Identity hues on the MPC pads are preserved; only the keyboard's structural surface follows the theme.
      await dialog.locator('#tab-midi-virtual').click();
      const pads = dialog.locator('button[style*="border-bottom"]');
      await expect(pads).toHaveCount(8);
      await expect(pads.first()).toHaveCSS('border-bottom-color', 'rgb(255, 87, 34)');
      const keys = dialog.locator('div.relative.h-32 button');
      await expect(keys).toHaveCount(15);
      await expect(keys.first()).toHaveCSS('background-color', expected.pianoKey);

      await dialog.locator('#tab-midi-monitor').click();
      await expect(dialog.getByText('Real-Time Raw MIDI Ingress Log')).toBeVisible();
      await expect(dialog.getByText(/No MIDI events received yet/)).toBeVisible();
      await dialog.getByRole('button', { name: 'Close MIDI controller' }).click();
      await expect(dialog).toBeHidden();
    });
  }
});
