import { expect, test } from '@playwright/test';
import base from '../playwright.config';
import { writeLiveInputFixture } from '../scripts/live-input-fixture.mjs';
const launch = base.projects![0].use?.launchOptions;
test.use({ launchOptions: { ...launch, args: [...(launch?.args ?? []),
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${writeLiveInputFixture()}`, '--autoplay-policy=no-user-gesture-required'],
} });

/** Reads the accepted take's duration as displayed by the production recorder. */
const takeSeconds = async (page: import('@playwright/test').Page): Promise<number> => {
  const text = await page.locator('div:has(> span:text-is("RECORDED TAKE")) > span.font-mono').first().innerText();
  return Number.parseFloat(text.replace(/[^0-9.]/g, ''));
};

/**
 * Regression for the capture-coverage defect: a take was rejected for 128
 * missing frames at 48 kHz (and 128-256-frame gaps plus repeated timestamps at
 * 44.1 kHz) because the capture worklet stamped packets with AudioWorklet's
 * `currentFrame`, which Chrome only refreshes per audio-device buffer. Coverage
 * is enforced by `assembleRecordingPcm()`, which throws on any missing,
 * duplicated or out-of-order non-paused frame - so an accepted take of the
 * expected length IS the proof. These runs are the real-browser counterpart to
 * the deterministic unit regression in src/audio/recordingEngine.test.ts.
 */
for (const sampleRate of ['44100', '48000']) {
  test(`capture coverage @ ${sampleRate} Hz: take, pause, count-in punch and repeats assemble completely`, async ({ page }) => {
    test.setTimeout(150_000);
    await page.goto('http://localhost:3000');
    await page.getByRole('menuitem', { name: 'Audio', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Audio Settings…', exact: true }).click();
    await page.locator('#audio-sample-rate-select').selectOption(sampleRate);
    await page.getByRole('button', { name: /^(Initialize with Settings|Apply Engine Settings)$/ }).click();
    await expect(page.getByTestId('audio-actual-sample-rate')).toContainText(Number(sampleRate).toLocaleString());
    await page.getByRole('button', { name: 'Close Audio Settings', exact: true }).click();
    await page.locator('#nav-mixer').click();
    await expect.poll(async () => {
      await page.locator('#mixer-strip-1').getByText('INS 1', { exact: true }).click();
      return page.getByRole('button', { name: 'Enable monitoring on this insert' }).isEnabled();
    }).toBe(true);
    await page.getByRole('button', { name: 'Enable monitoring on this insert' }).click();
    await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('Active');

    // Reasonable UI-thread load so packet delivery is never accidentally always
    // timely. The audio thread must stay exact regardless of main-thread work.
    await page.evaluate(() => {
      const state = { stop: false };
      (window as unknown as { __uiLoad?: { stop: boolean } }).__uiLoad = state;
      const tick = () => {
        if (state.stop) return;
        const until = performance.now() + 8;
        let acc = 0;
        while (performance.now() < until) acc += Math.sqrt(Math.random() * 1e6);
        if (acc < 0) console.log('unreachable');
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const durations: Record<string, number> = {};
    const finishTake = async (label: string) => {
      await expect(page.getByText('RECORDED TAKE', { exact: true })).toBeVisible({ timeout: 15000 });
      durations[label] = await takeSeconds(page);
      console.log(`CAPTURE-COVERAGE ${sampleRate}Hz ${label}=${durations[label]}s`);
      await page.getByRole('button', { name: 'PLACE TAKE ON PLAYLIST', exact: true }).click();
      // Placing only succeeds if the assembled PCM passed the integrity checks.
      await expect(page.getByRole('dialog', { name: 'AUDIO RECORDER' })).not.toBeVisible({ timeout: 20000 });
    };

    try {
      // Monitoring plus a plain recording.
      await page.getByRole('button', { name: 'Arm recording', exact: true }).click();
      await page.getByRole('button', { name: 'START RECORDING', exact: true }).click();
      await expect(page.locator('[data-recorder-status="RECORDING"]')).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(800);
      await page.getByRole('button', { name: 'STOP & SAVE', exact: true }).click();
      await finishTake('take');

      // Pause / resume boundary: paused frames are excluded, with no resume gap.
      await page.getByRole('button', { name: 'Arm recording', exact: true }).click();
      await page.getByRole('button', { name: 'START RECORDING', exact: true }).click();
      await expect(page.locator('[data-recorder-status="RECORDING"]')).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: 'PAUSE', exact: true }).click();
      await expect(page.locator('[data-recorder-status="PAUSED"]')).toBeVisible();
      await page.waitForTimeout(400);
      await page.getByRole('button', { name: 'RESUME', exact: true }).click();
      await expect(page.locator('[data-recorder-status="RECORDING"]')).toBeVisible({ timeout: 15000 });
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: 'STOP & SAVE', exact: true }).click();
      await finishTake('pause');

      // Count-in into a punch window (bar 2 -> bar 3 = exactly one bar).
      await page.getByRole('button', { name: 'Arm recording', exact: true }).click();
      await page.locator('[data-count-in="1"]').click();
      await page.getByRole('switch', { name: 'Enable punch recording' }).click();
      await page.getByRole('spinbutton', { name: 'Punch-in bar', exact: true }).fill('2');
      await page.getByRole('spinbutton', { name: 'Punch-out bar', exact: true }).fill('3');
      await page.getByRole('button', { name: 'PUNCH RECORD', exact: true }).click();
      await expect(page.locator('[data-recorder-status="COUNT-IN → PUNCH"]')).toBeVisible();
      await expect(page.locator('[data-recorder-status="PUNCH RECORDING"]')).toBeVisible({ timeout: 15000 });
      await finishTake('punch');

      // Leave punch mode before the plain repeats, otherwise the transport still
      // offers PUNCH RECORD instead of START RECORDING.
      await page.getByRole('button', { name: 'Arm recording', exact: true }).click();
      await page.getByRole('switch', { name: 'Enable punch recording' }).click();
      await expect(page.getByRole('switch', { name: 'Enable punch recording' })).not.toBeChecked();

      // Repeated start/stop on the same session.
      for (let index = 0; index < 2; index++) {
        const dialog = page.getByRole('dialog', { name: 'AUDIO RECORDER' });
        if (!(await dialog.isVisible())) await page.getByRole('button', { name: 'Arm recording', exact: true }).click();
        await page.getByRole('button', { name: 'START RECORDING', exact: true }).click();
        await expect(page.locator('[data-recorder-status="RECORDING"]')).toBeVisible({ timeout: 15000 });
        await page.waitForTimeout(500);
        await page.getByRole('button', { name: 'STOP & SAVE', exact: true }).click();
        await finishTake(`repeat${index}`);
      }
    } finally {
      await page.evaluate(() => {
        const load = (window as unknown as { __uiLoad?: { stop: boolean } }).__uiLoad;
        if (load) load.stop = true;
      });
    }

    // Every take was accepted, so coverage was complete for each one.
    console.log(`CAPTURE-COVERAGE ${sampleRate}Hz durations ${JSON.stringify(durations)}`);
    expect(durations.take).toBeGreaterThanOrEqual(0.9);
    // ~1.2s recorded with ~0.6s paused: the paused frames must be excluded.
    expect(durations.pause).toBeGreaterThanOrEqual(0.9);
    expect(durations.pause).toBeLessThan(1.9);
    // A punch window of one bar must land on the exact planned frame count.
    expect(durations.punch).toBeGreaterThanOrEqual(1.5);
    expect(durations.punch).toBeLessThanOrEqual(2.5);
    expect(durations.repeat0).toBeGreaterThanOrEqual(0.4);
    expect(durations.repeat1).toBeGreaterThanOrEqual(0.4);
  });
}
