import { expect, test } from '@playwright/test';
import base from '../playwright.config';
import { writeLiveInputFixture } from '../scripts/live-input-fixture.mjs';
const launch = base.projects![0].use?.launchOptions;
test.use({ launchOptions: { ...launch, args: [...(launch?.args ?? []),
  '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${writeLiveInputFixture()}`, '--autoplay-policy=no-user-gesture-required'],
} });

test('real fake-device getUserMedia -> production Mixer PCM, processing, shared recording and release', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const evidence = { calls: 0, streams: [] as MediaStream[] };
    (window as any).__inputCaptureEvidence = evidence;
    navigator.mediaDevices.getUserMedia = async constraints => {
      evidence.calls++;
      const stream = await original(constraints); evidence.streams.push(stream);
      const clone = stream.clone.bind(stream);
      stream.clone = () => { const consumer = clone(); evidence.streams.push(consumer); return consumer; };
      return stream;
    };
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
  await expect.poll(async () => {
    await page.locator('#mixer-strip-1').getByText('INS 1', { exact: true }).click();
    return page.getByRole('button', { name: 'Enable monitoring on this insert' }).isEnabled();
  }).toBe(true);
  await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('OFF');
  expect(await page.evaluate(() => (window as any).__inputCaptureEvidence.calls)).toBe(0);
  console.log('INPUT-STAGE enabling');
  await page.getByRole('button', { name: 'Enable monitoring on this insert' }).click({ timeout: 10_000 });
  await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('Active');
  console.log('INPUT-STAGE active; measuring');
  const evidence = await page.evaluate(async () => {
    // @ts-ignore Browser Vite production modules, not a test engine
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore
    const { runLiveInputAcceptance } = await import('/src/audio/liveInputAcceptance.ts');
    return runLiveInputAcceptance(audioEngine);
  });
  const resources = await page.evaluate(() => {
    const value = (window as any).__inputCaptureEvidence;
    return { calls: value.calls, tracks: value.streams.flatMap((stream: MediaStream) => stream.getTracks().map(track => track.readyState)) };
  });
  expect(resources.calls, 'monitor + recorder must share one physical acquisition').toBe(1);
  expect(resources.tracks.length).toBe(3);
  expect(resources.tracks.every((state: string) => state === 'ended')).toBe(true);
  // A deliberate restart uses a fresh physical acquisition and can be disabled via the real UI.
  await page.getByRole('button', { name: 'Enable monitoring on this insert' }).click();
  await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('Active');
  await page.getByRole('button', { name: 'Arm recording', exact: true }).click();
  await page.locator('[data-count-in="0"]').click();
  await page.getByRole('button', { name: 'START RECORDING', exact: true }).click();
  await expect(page.locator('[data-recorder-status="RECORDING"]')).toBeVisible();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'PAUSE', exact: true }).click();
  await page.getByRole('button', { name: 'RESUME', exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: 'STOP & SAVE', exact: true }).click();
  await expect(page.getByText('RECORDED TAKE', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'PLACE TAKE ON PLAYLIST', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'AUDIO RECORDER' })).not.toBeVisible();
  await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('Active');
  await page.getByRole('button', { name: 'Disable monitoring' }).click();
  await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('OFF');
  expect(await page.evaluate(() => (window as any).__inputCaptureEvidence.calls)).toBe(2);
  expect(await page.evaluate(() => (window as any).__inputCaptureEvidence.streams.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  // Component unmount must release its route too.
  await page.getByRole('button', { name: 'Enable monitoring on this insert' }).click();
  await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('Active');
  await page.locator('#nav-channel-rack').click();
  expect(await page.evaluate(() => (window as any).__inputCaptureEvidence.streams.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
  await testInfo.attach('live-input-pcm-evidence.json', { body: JSON.stringify({ ...evidence, resources }, null, 2), contentType: 'application/json' });
  console.log('LIVE-INPUT-PCM-EVIDENCE', JSON.stringify({ ...evidence, resources }));
});

test('AudioRecorderModal count-in and punch preserve active monitoring and share its native input', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('http://localhost:3000');
  await page.evaluate(() => {
    const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    (window as any).__punchCapture = { calls: 0, streams: [] };
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stats = (window as any).__punchCapture; stats.calls++;
      const stream = await native(constraints); stats.streams.push(stream); return stream;
    };
  });
  await page.getByRole('menuitem', { name: 'Audio', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Audio Settings…', exact: true }).click();
  await page.locator('#audio-sample-rate-select').selectOption('48000');
  await page.getByRole('button', { name: /^(Initialize with Settings|Apply Engine Settings)$/ }).click();
  await expect(page.getByTestId('audio-actual-sample-rate')).toContainText('48,000');
  await page.getByRole('button', { name: 'Close Audio Settings', exact: true }).click();
  await page.locator('#nav-mixer').click();
  await page.locator('#mixer-strip-1').getByText('INS 1', { exact: true }).click();
  await page.getByRole('button', { name: 'Enable monitoring on this insert' }).click();
  await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('Active');
  const assertActive = async () => {
    const signal = await page.evaluate(async () => {
      // @ts-ignore real production engine
      const { audioEngine } = await import('/src/audio/audioEngine.ts');
      return { status: audioEngine.liveInputMonitor.getSnapshot().status, peak: audioEngine.getMixerTrackPeak(1) };
    });
    expect(signal.status).toBe('active'); expect(signal.peak).toBeGreaterThan(0.01);
    expect(await page.evaluate(() => (window as any).__punchCapture.calls)).toBe(1);
  };
  await page.getByRole('button', { name: 'Arm recording', exact: true }).click();
  await page.locator('[data-count-in="1"]').click();
  await page.getByRole('button', { name: 'START RECORDING', exact: true }).click();
  await expect(page.locator('[data-recorder-status="COUNT-IN"]')).toBeVisible(); await assertActive();
  await expect(page.locator('[data-recorder-status="RECORDING"]')).toBeVisible({ timeout: 15000 });
  await assertActive(); await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'STOP & SAVE', exact: true }).click();
  await expect(page.getByText('RECORDED TAKE', { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'PLACE TAKE ON PLAYLIST', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'AUDIO RECORDER' })).not.toBeVisible(); await assertActive();
  // Placing a take closes the recorder and clears the record arm; open a new take.
  await page.getByRole('button', { name: 'Arm recording', exact: true }).click();
  await page.getByRole('switch', { name: 'Enable punch recording' }).click();
  await page.getByRole('spinbutton', { name: 'Punch-out bar', exact: true }).fill('3');
  await page.getByRole('spinbutton', { name: 'Punch-in bar', exact: true }).fill('2');
  await page.getByRole('button', { name: 'PUNCH RECORD', exact: true }).click();
  await expect(page.locator('[data-recorder-status="COUNT-IN → PUNCH"]')).toBeVisible(); await assertActive();
  await expect(page.locator('[data-recorder-status="PUNCH RECORDING"]')).toBeVisible({ timeout: 15000 }); await assertActive();
  await expect(page.getByText('RECORDED TAKE', { exact: true })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('[data-punch-take-placement]')).toContainText('starts at bar 2.00');
  await page.getByRole('button', { name: 'PLACE TAKE ON PLAYLIST', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'AUDIO RECORDER' })).not.toBeVisible(); await assertActive();
  await page.getByRole('button', { name: 'Disable monitoring', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__punchCapture.streams.every((stream: MediaStream) => stream.getTracks().every(track => track.readyState === 'ended')))).toBe(true);
});
