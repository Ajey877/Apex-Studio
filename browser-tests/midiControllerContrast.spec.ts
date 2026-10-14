import { expect, test, type Page } from '@playwright/test';
import { hasTranslucentBackgroundLayer, measureTextContrast } from './themeContrast';

const APP_URL = 'http://localhost:3000';

test.describe('UI-03S MIDI Controller alpha-wash status labels', () => {
  for (const mode of ['dark', 'light'] as const) {
    test(`${mode}: all four live MIDI event labels clear AA over their composited washes`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.addInitScript((theme: string) => {
        try { window.localStorage.setItem('apex:theme', theme); } catch { /* handled by the app */ }

        const input = {
          id: 'ui03s-test-midi-input',
          name: 'UI-03S Test MIDI Input',
          manufacturer: 'Apex Studio test fixture',
          state: 'connected',
          onmidimessage: null as null | ((event: { data: Uint8Array }) => void),
        };
        const access = {
          inputs: new Map([[input.id, input]]),
          outputs: new Map(),
          onstatechange: null as null | (() => void),
        };
        Object.defineProperty(navigator, 'requestMIDIAccess', {
          configurable: true,
          value: async () => access,
        });
        (window as unknown as { __ui03sMidiInput: typeof input }).__ui03sMidiInput = input;
      }, mode);

      await page.goto(APP_URL);
      await page.waitForSelector('#root > *', { state: 'attached' });
      await page.waitForTimeout(1200);
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);

      await page.locator('#fl-midi-hub-btn').click();
      const dialog = page.locator('#midi-controller-modal-overlay');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('UI-03S Test MIDI Input')).toBeVisible();
      await dialog.locator('#tab-midi-monitor').click();
      await expect(dialog.getByText('Real-Time Raw MIDI Ingress Log')).toBeVisible();

      await page.waitForFunction(() => {
        const input = (window as unknown as {
          __ui03sMidiInput?: { onmidimessage: ((event: { data: Uint8Array }) => void) | null };
        }).__ui03sMidiInput;
        return Boolean(input?.onmidimessage);
      });
      await page.evaluate(() => {
        const input = (window as unknown as {
          __ui03sMidiInput: { onmidimessage: ((event: { data: Uint8Array }) => void) | null };
        }).__ui03sMidiInput;
        if (!input.onmidimessage) throw new Error('test MIDI input has no listener');
        for (const data of [
          [0x90, 60, 100], // noteOn
          [0x80, 60, 0],   // noteOff
          [0xb0, 1, 64],   // cc
          [0xe0, 0, 64],   // pitchBend
        ]) {
          input.onmidimessage({ data: new Uint8Array(data) });
        }
      });

      for (const eventType of ['noteOn', 'noteOff', 'cc', 'pitchBend']) {
        const badge = dialog.getByText(eventType, { exact: true });
        await expect(badge).toBeVisible();
        const contrast = await measureTextContrast(badge);
        expect(hasTranslucentBackgroundLayer(contrast.backgroundLayers), `${eventType} wash is composited`).toBe(true);
        expect(contrast.ratio, `${mode} ${eventType} event label`).toBeGreaterThanOrEqual(4.5);
      }

      await page.screenshot({ path: `assets/screenshots/ui03s-midi-controller-status-${mode}.png` });
    });
  }
});
