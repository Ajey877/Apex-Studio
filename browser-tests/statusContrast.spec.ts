import { expect, test, type Locator, type Page } from '@playwright/test';
import { hasTranslucentBackgroundLayer, measureTextContrast } from './themeContrast';

const APP_URL = 'http://localhost:3000';

const setTheme = (mode: 'dark' | 'light') => (page: Page) =>
  page.addInitScript((value: string) => {
    try { window.localStorage.setItem('apex:theme', value); } catch { /* handled by the app */ }
  }, mode);

const waitForApp = async (page: Page): Promise<void> => {
  await page.waitForSelector('#root > *', { state: 'attached' });
  await page.waitForTimeout(1200);
};

const openToolsItem = async (page: Page, id: string): Promise<void> => {
  await page.locator('#fl-tools-menu-btn').click();
  await page.locator(`#${id}`).click();
};

const expectAlphaBadgeAA = async (label: Locator, context: string): Promise<void> => {
  const contrast = await measureTextContrast(label);
  expect(hasTranslucentBackgroundLayer(contrast.backgroundLayers), `${context} is measured over its alpha fill`).toBe(true);
  expect(contrast.ratio, `${context} rendered contrast`).toBeGreaterThanOrEqual(4.5);
};

test.describe('UI-03S themed active status labels', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: Vocal Tuner, Gross Beat, Arpeggiator, and Mastering status labels clear AA`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await setTheme(mode)(page);
      await page.goto(APP_URL);
      await waitForApp(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      await openToolsItem(page, 'fl-vocal-tuner-btn');
      const vocal = page.locator('[role="dialog"]:has(#fl-vocal-tuner-modal-title)');
      await expect(vocal).toBeVisible();
      const vocalOff = vocal.getByRole('button', { name: 'OFF', exact: true });
      if (await vocalOff.count()) await vocalOff.click();
      const vocalEnabled = vocal.getByText('ENABLED (NOT APPLIED)', { exact: true });
      await expect(vocalEnabled).toBeVisible();
      await expectAlphaBadgeAA(vocalEnabled, `${mode} Vocal Tuner enabled badge`);
      await page.screenshot({ path: `assets/screenshots/ui03s-vocal-tuner-status-${mode}.png` });
      await vocal.getByRole('button', { name: 'Close vocal tuner' }).click();
      await expect(vocal).toBeHidden();

      await openToolsItem(page, 'fl-gross-beat-btn');
      const gross = page.locator('#gross-beat-modal');
      await expect(gross).toBeVisible();
      const amplitudeGate = gross.getByText('AMPLITUDE GATE', { exact: true });
      await expect(amplitudeGate).toBeVisible();
      await expectAlphaBadgeAA(amplitudeGate, `${mode} Gross Beat amplitude-gate badge`);
      await page.screenshot({ path: `assets/screenshots/ui03s-gross-beat-status-${mode}.png` });
      await gross.getByRole('button', { name: 'Close Gross Beat' }).click();
      await expect(gross).toBeHidden();

      await page.locator('#nav-channel-rack').click();
      await page.locator('#fl-channel-rack button[title="Arpeggiator & Euclidean Rhythm Engine"]').first().click();
      const arp = page.locator('[aria-labelledby="arpeggiator-modal-title"]');
      await expect(arp).toBeVisible();
      const off = arp.getByRole('button', { name: 'OFF', exact: true });
      if (await off.count()) await off.click();
      const arpEnabled = arp.getByText('ENABLED', { exact: true });
      await expect(arpEnabled).toBeVisible();
      await expectAlphaBadgeAA(arpEnabled, `${mode} Arpeggiator enabled badge`);
      await page.screenshot({ path: `assets/screenshots/ui03s-arpeggiator-status-${mode}.png` });
      await arp.getByRole('button', { name: 'Close arpeggiator' }).click();
      await expect(arp).toBeHidden();

      await openToolsItem(page, 'fl-mastering-suite-btn');
      const mastering = page.locator('[role="dialog"]:has(#mastering-suite-modal-title)');
      await expect(mastering).toBeVisible();
      const enableChain = mastering.locator('button[aria-label="Enable master processing"]');
      if (await enableChain.count()) await enableChain.click();
      const activeChain = mastering.locator('button[aria-label="Bypass master processing"]');
      await expect(activeChain).toBeVisible();
      await expectAlphaBadgeAA(activeChain, `${mode} Mastering active-chain toggle`);
      await page.screenshot({ path: `assets/screenshots/ui03s-mastering-suite-status-${mode}.png` });
      await mastering.getByRole('button', { name: 'Close mastering suite' }).click();
      await expect(mastering).toBeHidden();
    });
  }
});
