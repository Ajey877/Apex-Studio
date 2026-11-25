import { expect, test } from '@playwright/test';
import base from '../playwright.config';
import { writeLiveInputFixture } from '../scripts/live-input-fixture.mjs';
const launch = base.projects![0].use?.launchOptions;
test.use({ launchOptions: { ...launch, args: [...(launch?.args ?? []),
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${writeLiveInputFixture()}`, '--autoplay-policy=no-user-gesture-required'],
} });

/**
 * Regression for the destructive monitoring-init path: `startLiveInputMonitoring`
 * used to call `prepareTracks()` (which stops every native session first) and
 * then `updateMixerTrack()` for every track (which unconditionally rebuilds each
 * FX chain), so enabling monitoring during playback tore down a running Mixer
 * graph. It now prepares only what is genuinely absent or stale and rebuilds
 * nothing that already matches.
 *
 * Scope, stated plainly: this proves the renderer-side graph is preserved while
 * the transport plays - transport continuity, zero chain rebuilds, monitored PCM
 * through the insert's own FX chain, fader/pan/mute/solo/routing, and clean
 * disable. It does NOT host a live native VST3 insert: measured here, the worklet
 * fails closed with "Native effect missed its real-time processing deadline"
 * because a renderer-side stub services PCM on the main thread. Native session
 * preservation is covered by the deterministic regression in
 * src/audio/nativeVst3EffectRuntime.test.ts and by the packaged Windows run.
 */
test('enabling monitoring during active playback preserves the running Mixer graph', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    // The documented acceptance gate (APEX_ACCEPTANCE=1 on a packaged launch). It
    // exposes the app's real handlers to acceptance tooling; it substitutes no
    // audio path.
    (window as unknown as { desktopApp?: unknown }).desktopApp = { packagedAcceptance: true };
  });
  await page.goto('http://localhost:3000');
  await page.getByRole('menuitem', { name: 'Audio', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Audio Settings…', exact: true }).click();
  await page.locator('#audio-sample-rate-select').selectOption('48000');
  await page.getByRole('button', { name: /^(Initialize with Settings|Apply Engine Settings)$/ }).click();
  await expect(page.getByTestId('audio-actual-sample-rate')).toContainText('48,000');
  await page.getByRole('button', { name: 'Close Audio Settings', exact: true }).click();

  // Playback must already be running when monitoring is enabled.
  await page.locator('#nav-mixer').click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

  const evidence = await page.evaluate(async () => {
    const acceptance = (window as unknown as {
      __apexAcceptance?: { runLiveInputGraphPreservationAcceptance: (o: { liveNativeInsert?: boolean }) => Promise<Record<string, unknown>> };
    }).__apexAcceptance;
    if (!acceptance) throw new Error('The acceptance surface is not available.');
    return acceptance.runLiveInputGraphPreservationAcceptance({ liveNativeInsert: false });
  });
  console.log('GRAPH-PRESERVATION', JSON.stringify(evidence));

  // 1. No live Mixer chain was torn down and rebuilt by monitoring init.
  expect(evidence.tracksRebuiltDuringMonitoringInit, 'no live Mixer chain was rebuilt').toEqual([]);

  // 2. Playback continued and the transport did not reset.
  const before = evidence.transportBefore as { playing: boolean; positionSeconds: number };
  const after = evidence.transportAfter as { playing: boolean; positionSeconds: number };
  expect(before.playing, 'playback was already running').toBe(true);
  expect(after.playing, 'playback continued through monitoring init').toBe(true);
  expect(after.positionSeconds, 'transport position kept advancing').toBeGreaterThan(before.positionSeconds);

  // 3. Disabling monitoring removed the input without stopping the project.
  const afterDisable = evidence.transportAfterDisable as { playing: boolean };
  expect(afterDisable.playing, 'disabling monitoring did not stop the project').toBe(true);

  // 4. The scenario itself asserted the monitored insert's real PCM behaviour:
  // input through its own FX chain, fader, pan, mute, solo, routing and removal.
  const baseline = evidence.baseline as { left: number; input: number };
  expect(baseline.input, 'real monitored input PCM').toBeGreaterThan(0.02);
  expect(baseline.left, 'input passed through the insert FX chain').toBeGreaterThan(0.005);
  // The input tap carries only the monitored producer, so it is the exact probe.
  const offInput = (evidence.off as { input: number }).input;
  expect(offInput, 'monitored producer removed from the insert input on disable').toBeLessThan(baseline.input * 0.05);

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
});
