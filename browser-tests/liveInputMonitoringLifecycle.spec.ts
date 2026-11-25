import { expect, test } from '@playwright/test';
import base from '../playwright.config';
import { writeLiveInputFixture } from '../scripts/live-input-fixture.mjs';
const launch = base.projects![0].use?.launchOptions;
test.use({ launchOptions: { ...launch, args: [...(launch?.args ?? []),
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${writeLiveInputFixture()}`, '--autoplay-policy=no-user-gesture-required'],
} });

test('production lifecycle: suspension, reconfiguration, project replacement, hardware change and unload revoke live routes', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('http://localhost:3000');
  await page.locator('#nav-mixer').click();
  await page.evaluate(() => {
    const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    (window as any).__captureRoots = [];
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = await native(constraints); (window as any).__captureRoots.push(stream); return stream;
    };
  });
  const enable = async () => {
    await page.locator('#mixer-strip-1').getByText('INS 1', { exact: true }).click();
    await page.getByRole('button', { name: 'Enable monitoring on this insert' }).click();
    await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('Active');
  };
  const off = async () => {
    await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('OFF');
    expect(await page.evaluate(() => (window as any).__captureRoots.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  };
  await enable();
  await page.evaluate(async () => {
    // @ts-ignore actual Vite application engine
    const { audioEngine } = await import('/src/audio/audioEngine.ts'); await audioEngine.getContext().suspend();
  });
  await off();
  await page.evaluate(async () => {
    // @ts-ignore
    const { audioEngine } = await import('/src/audio/audioEngine.ts'); await audioEngine.getContext().resume();
  });
  await off(); await enable();
  await page.evaluate(async () => {
    // @ts-ignore
    const { audioEngine } = await import('/src/audio/audioEngine.ts'); await audioEngine.reconfigureAudioContext({ sampleRate: 48000 });
  });
  await off(); await enable();
  // Simulated notification, not simulated audio: real native tracks must end.
  await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event('devicechange')));
  await off(); await enable();
  await page.getByRole('menuitem', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: /^New Session/ }).click();
  const confirm = page.getByRole('button', { name: 'Back Up & Replace', exact: true });
  if (await confirm.isVisible()) await confirm.click();
  await off(); await enable();
  await page.evaluate(() => window.addEventListener('beforeunload', () => localStorage.setItem('monitor-unload-proof', JSON.stringify({
    released: (window as any).__captureRoots.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === 'ended')),
  }))));
  page.on('dialog', dialog => dialog.accept());
  await page.reload();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('monitor-unload-proof') ?? 'null'))).toEqual({ released: true });
  await page.locator('#nav-mixer').click();
  await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('OFF');
});
