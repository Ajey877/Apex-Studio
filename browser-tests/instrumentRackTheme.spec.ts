import { expect, test, type Locator, type Page } from '@playwright/test';
import { measureTextContrast } from './themeContrast';

const APP_URL = 'http://localhost:3000';

const setTheme = (mode: 'dark' | 'light') => async (page: Page): Promise<void> => {
  await page.addInitScript((value: string) => {
    try { window.localStorage.setItem('apex:theme', value); } catch { /* handled by the app */ }
  }, mode);
};

const waitForApp = async (page: Page): Promise<void> => {
  await page.waitForSelector('#root > *', { state: 'attached' });
  await page.waitForTimeout(1000);
};

const switchTheme = async (page: Page, mode: 'dark' | 'light'): Promise<void> => {
  await page.locator('button[aria-label="Open Settings"]').first().click();
  const settings = page.locator('#appearance-settings-modal');
  await expect(settings).toBeVisible();
  await settings.locator(`label:has(input[value="${mode}"])`).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
  await page.keyboard.press('Escape');
  await expect(settings).toBeHidden();
};

const measureIdentityOutline = async (marker: Locator): Promise<number> =>
  marker.evaluate((element) => {
    const parse = (color: string): [number, number, number, number] => {
      const srgb = /color\(srgb\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)(?:\s*\/\s*([\d.eE+-]+))?\s*\)/i.exec(color);
      if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255, srgb[4] === undefined ? 1 : Number(srgb[4])];
      const rgb = /rgba?\(([^)]+)\)/.exec(color);
      if (!rgb) throw new Error(`Cannot parse marker color ${color}`);
      const channels = rgb[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      return [channels[0], channels[1], channels[2], channels[3] ?? 1];
    };
    const luminance = ([r, g, b]: [number, number, number, number]) => {
      const linear = [r, g, b].map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    const foreground = luminance(parse(getComputedStyle(element).borderTopColor));
    let surface: HTMLElement | null = element.parentElement;
    let background: [number, number, number, number] | null = null;
    while (surface) {
      const candidate = parse(getComputedStyle(surface).backgroundColor);
      if (candidate[3] > 0) {
        background = candidate;
        if (candidate[3] >= 1) break;
      }
      surface = surface.parentElement;
    }
    if (!background || background[3] < 1) throw new Error('No opaque identity-marker surface found');
    const backgroundLuminance = luminance(background);
    return (Math.max(foreground, backgroundLuminance) + 0.05) / (Math.min(foreground, backgroundLuminance) + 0.05);
  });

test.describe('UI-03S identity labels and Drum Sampler MIDI labels', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: Grand Concert Piano identity is preserved beside an AA label`, async ({ page }) => {
      await setTheme(mode)(page);
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto(APP_URL);
      await waitForApp(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      const search = page.locator('#studio-browser-search');
      await search.fill('Grand Concert Piano');
      const load = page.getByRole('button', { name: 'Load Grand Concert Piano into the channel rack' });
      await expect(load).toBeVisible();
      await load.click();

      const channel = page.locator('#fl-channel-rack button[title="Click to open Instrument Synth Rack"]').filter({ hasText: 'Grand Concert Piano' });
      await expect(channel).toBeVisible();
      await channel.click();
      const rack = page.locator('#fl-instrument-rack');
      await expect(rack).toBeVisible();

      const label = rack.getByTestId('instrument-name');
      const marker = rack.getByTestId('instrument-identity-marker');
      await expect(label).toHaveText('Grand Concert Piano');
      await expect(marker).toHaveAttribute('data-identity-color', '#e0e0e0');
      const labelContrast = await measureTextContrast(label);
      expect(labelContrast.ratio, `${mode} Grand Concert Piano label`).toBeGreaterThanOrEqual(4.5);
      const markerContrast = await measureIdentityOutline(marker);
      expect(markerContrast, `${mode} Grand Concert Piano identity outline`).toBeGreaterThanOrEqual(3);
      await expect(marker).toHaveCSS('background-color', 'rgb(224, 224, 224)');

      await page.waitForTimeout(400);
      const projectBeforeThemeSwitch = await page.evaluate(() => window.localStorage.getItem('apex:project'));
      await page.screenshot({ path: `assets/screenshots/ui03s-instrument-rack-grand-piano-${mode}.png` });
      await switchTheme(page, mode === 'dark' ? 'light' : 'dark');
      const afterSwitch = await measureTextContrast(label);
      expect(afterSwitch.ratio, 'live theme switch keeps the identity label readable').toBeGreaterThanOrEqual(4.5);
      await expect(marker).toHaveAttribute('data-identity-color', '#e0e0e0');
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => window.localStorage.getItem('apex:project'))).toBe(projectBeforeThemeSwitch);
    });

    test(`${mode}: every Drum Sampler MIDI label clears AA and pad hues stay unchanged`, async ({ page }) => {
      await setTheme(mode)(page);
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto(APP_URL);
      await waitForApp(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      await page.locator('#nav-channel-rack').click();
      const firstChannel = page.locator('#fl-channel-rack button[title="Click to open Instrument Synth Rack"]').first();
      await expect(firstChannel).toBeVisible();
      await firstChannel.click();
      const rack = page.locator('#fl-instrument-rack');
      await expect(rack).toBeVisible();
      const labels = rack.locator('[data-testid^="drum-midi-label-"]');
      await expect(labels).toHaveCount(16);

      const expectedIdentityColors = [
        '#ff6e00', '#ff9800', '#ffc107', '#00ff88',
        '#00e5ff', '#a855f7', '#ef4444', '#ec4899',
      ];
      const actualIdentityColors: string[] = [];
      for (let index = 0; index < await labels.count(); index += 1) {
        const label = labels.nth(index);
        const marker = label.locator('[data-pad-identity-color]');
        const expectedNote = 36 + index;
        await expect(label).toHaveAttribute('data-midi-note', String(expectedNote));
        await expect(label).toHaveText(`MIDI ${expectedNote}`);
        const contrast = await measureTextContrast(label);
        expect(contrast.ratio, `${mode} MIDI ${expectedNote}`).toBeGreaterThanOrEqual(4.5);
        const color = await marker.getAttribute('data-pad-identity-color');
        expect(color).toBe(expectedIdentityColors[index % expectedIdentityColors.length]);
        const outlineContrast = await measureIdentityOutline(marker);
        expect(outlineContrast, `${mode} pad marker outline ${color}`).toBeGreaterThanOrEqual(3);
        actualIdentityColors.push(color ?? '');
      }
      expect(new Set(actualIdentityColors.slice(0, 8)).size).toBe(8);

      const projectBeforeHover = await page.evaluate(() => window.localStorage.getItem('apex:project'));
      await page.screenshot({ path: `assets/screenshots/ui03s-drum-sampler-${mode}.png` });
      await labels.nth(7).hover();
      const hoveredLabel = await measureTextContrast(labels.nth(7));
      expect(hoveredLabel.ratio, `${mode} hovered Drum Sampler MIDI label`).toBeGreaterThanOrEqual(4.5);
      await expect(labels.nth(7).locator('[data-pad-identity-color]')).toHaveAttribute('data-pad-identity-color', expectedIdentityColors[7]);
      expect(await page.evaluate(() => window.localStorage.getItem('apex:project'))).toBe(projectBeforeHover);
    });
  }
});
