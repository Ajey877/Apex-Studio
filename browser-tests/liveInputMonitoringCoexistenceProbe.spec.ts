import { expect, test } from '@playwright/test';
import base from '../playwright.config';
import { writeLiveInputFixture } from '../scripts/live-input-fixture.mjs';
const launch = base.projects![0].use?.launchOptions;
test.use({ launchOptions: { ...launch, args: [...(launch?.args ?? []),
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${writeLiveInputFixture()}`, '--autoplay-policy=no-user-gesture-required'],
} });

/** Typed view of the packaged-acceptance surface this spec drives. */
type AcceptanceSurface = {
  armNativeMonitoringCoexistenceProbe: (trackId: number, slotId: string, options?: { inputSignal?: boolean }) => Promise<unknown>;
  measureNativeMonitoringCoexistence: (label: string) => Promise<{
    label: string;
    monitor: { status: string };
    native: { prepared: boolean; nodeId: string | null };
    pcm: { insertInputRms: number; insertOutputRms: number };
    mixerTracksRebuiltSinceArm: number[];
    unverified: string[];
  }>;
  disarmNativeMonitoringCoexistenceProbe: () => Promise<unknown>;
  liveInputState: () => Promise<{ status: string }>;
};
const surface = () => (window as unknown as { __apexAcceptance: AcceptanceSurface }).__apexAcceptance;

/**
 * Exercises the measurement surface that the packaged native VST3 + live-input
 * coexistence acceptance reads, so that instrumentation cannot ship broken.
 *
 * Scope, stated plainly: a browser has no native helper process, so this proves
 * the PROBE (arm / measure / disarm, the deterministic insert signal, monitored
 * input PCM deltas, the rebuild spy, and honest reporting of unobservable native
 * fields). It is NOT evidence about native VST3 - that comes only from
 * scripts/packaged-native-monitoring-acceptance.mjs on packaged Windows.
 */
test('coexistence probe measures insert PCM and reports native fields as unverified without a helper', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    (window as unknown as { desktopApp?: unknown }).desktopApp = { packagedAcceptance: true };
  });
  await page.goto('http://localhost:3000');
  await page.getByRole('menuitem', { name: 'Audio', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Audio Settings…', exact: true }).click();
  await page.locator('#audio-input-device-select').selectOption('');
  await page.locator('#audio-sample-rate-select').selectOption('48000');
  await page.getByRole('button', { name: /^(Initialize with Settings|Apply Engine Settings)$/ }).click();
  await expect(page.getByTestId('audio-actual-sample-rate')).toContainText('48,000');
  await page.getByRole('button', { name: 'Close Audio Settings', exact: true }).click();
  await page.locator('#nav-mixer').click();

  await page.evaluate(() => surface().armNativeMonitoringCoexistenceProbe(1, 'probe-slot', { inputSignal: true }));
  try {
    const before = await page.evaluate(() => surface().measureNativeMonitoringCoexistence('before'));

    // The deterministic insert signal must be measurably present on the insert input.
    expect(before.pcm.insertInputRms, 'deterministic insert signal reaches the insert input').toBeGreaterThan(0.05);
    // No native helper here, so those fields must be declared unverified, not faked.
    expect(before.native.prepared, 'no native session exists in a browser').toBe(false);
    expect(before.native.nodeId, 'no native node exists in a browser').toBeNull();
    expect(before.unverified).toContain('nativeProcessingBlocks');
    expect(before.unverified).toContain('nativeServiceSessionCount');
    expect(Array.isArray(before.mixerTracksRebuiltSinceArm)).toBe(true);
    expect(before.monitor.status, 'monitoring is off before it is enabled').toBe('off');

    // Enabling monitoring through the real UI must add measurable input PCM.
    await page.locator('#mixer-strip-1').getByText('INS 1', { exact: true }).click();
    await page.getByRole('button', { name: 'Enable monitoring on this insert' }).click();
    await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('Active');
    await page.waitForTimeout(600);
    const during = await page.evaluate(() => surface().measureNativeMonitoringCoexistence('during'));
    expect(during.monitor.status).toBe('active');
    expect(during.pcm.insertInputRms, 'monitored microphone adds to the insert input')
      .toBeGreaterThan(before.pcm.insertInputRms * 1.03);

    // Disabling must remove the monitored contribution and leave the signal intact.
    await page.locator('#mixer-strip-1').getByText('INS 1', { exact: true }).click();
    await page.getByRole('button', { name: 'Disable monitoring' }).click();
    await expect.poll(async () => (await page.evaluate(() => surface().liveInputState())).status).toBe('off');
    await page.waitForTimeout(600);
    const after = await page.evaluate(() => surface().measureNativeMonitoringCoexistence('after'));
    expect(after.monitor.status).toBe('off');
    expect(after.pcm.insertInputRms, 'monitored input removed on disable')
      .toBeLessThan(during.pcm.insertInputRms * 0.97);
    expect(after.pcm.insertInputRms, 'deterministic signal survives monitoring being disabled').toBeGreaterThan(0.05);

    console.log('COEXISTENCE-PROBE', JSON.stringify({
      inputRms: { before: before.pcm.insertInputRms, during: during.pcm.insertInputRms, after: after.pcm.insertInputRms },
      unverified: before.unverified,
    }));
  } finally {
    await page.evaluate(() => surface().disarmNativeMonitoringCoexistenceProbe());
  }
});
