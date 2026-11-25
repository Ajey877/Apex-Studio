// Genuine packaged Windows application + Chromium fake microphone. No dev server,
// synthetic MediaStream, alternate engine, or physical-hardware claim.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { _electron, expect } from '@playwright/test';
import { writeLiveInputFixture } from './live-input-fixture.mjs';

const evidenceDir = path.resolve('build/live-input-evidence');
mkdirSync(evidenceDir, { recursive: true });
const evidenceFile = path.join(evidenceDir, 'packaged-windows.json');
if (process.platform !== 'win32') {
  writeFileSync(evidenceFile, JSON.stringify({ status: 'NOT_VERIFIED', reason: 'Requires Windows and the actual packaged executable.', physicalHardware: 'NOT_VERIFIED' }, null, 2));
  console.error('NOT_VERIFIED: Windows packaged application cannot be exercised on this host.');
  process.exit(3);
}
const packageDir = path.resolve('dist-electron/win-unpacked');
const name = readdirSync(packageDir).find(file => /apex.*\.exe$/i.test(file));
assert.ok(name, 'Packaged Apex executable missing. Run npm run package:win:dir first.');
const executablePath = path.join(packageDir, name);
assert.ok(existsSync(executablePath));
const profile = mkdtempSync(path.resolve('build/live-input-profile-'));
const fixture = writeLiveInputFixture();
const env = { ...process.env, APEX_ACCEPTANCE: '1', APEX_ACCEPTANCE_USER_DATA: profile };
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${fixture}`, '--autoplay-policy=no-user-gesture-required'];
let app;
const evidence = { status: 'RUNNING', source: 'Chromium fake audio device, 440 Hz mono WAV', physicalHardware: 'NOT_VERIFIED', executablePath };
try {
  app = await _electron.launch({ executablePath, env, args, timeout: 180000 });
  const page = await app.firstWindow();
  page.on('dialog', dialog => dialog.accept());
  await page.waitForFunction(() => !!window.__apexAcceptance);
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    window.__inputCaptureEvidence = { calls: 0, streams: [] };
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stats = window.__inputCaptureEvidence; stats.calls++;
      const stream = await original(constraints); stats.streams.push(stream);
      const clone = stream.clone.bind(stream);
      stream.clone = () => { const consumer = clone(); stats.streams.push(consumer); return consumer; };
      return stream;
    };
  });
  await page.getByRole('menuitem', { name: 'Audio', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Audio Settings…', exact: true }).click();
  await page.locator('#audio-input-device-select').selectOption('');
  await page.locator('#audio-sample-rate-select').selectOption('48000');
  await page.getByRole('button', { name: /^(Initialize with Settings|Apply Engine Settings)$/ }).click();
  await expect(page.getByTestId('audio-actual-sample-rate')).toContainText('48,000');
  await page.getByRole('button', { name: 'Close Audio Settings', exact: true }).click();
  await page.locator('#nav-mixer').click();
  await page.locator('#mixer-strip-1').getByText('INS 1', { exact: true }).click();
  await page.getByRole('button', { name: 'Enable monitoring on this insert' }).click();
  await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('Active');
  evidence.pcm = await page.evaluate(() => window.__apexAcceptance.runLiveInputAcceptance());
  evidence.resources = await page.evaluate(() => ({ calls: window.__inputCaptureEvidence.calls,
    tracks: window.__inputCaptureEvidence.streams.flatMap(stream => stream.getTracks().map(track => track.readyState)) }));
  assert.equal(evidence.resources.calls, 1);
  assert.deepEqual(evidence.resources.tracks, ['ended', 'ended', 'ended']);
  // Complete a take through the shipped AudioRecorderModal, while monitoring.
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
  evidence.recorderModal = 'record/pause/resume/stop/persist/place completed';
  await page.getByRole('button', { name: 'Disable monitoring', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__inputCaptureEvidence.calls), 2);
  assert.equal(await page.evaluate(() => window.__inputCaptureEvidence.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))), true);
  await page.evaluate(() => window.__apexAcceptance.saveProject());
  // Close with an active monitor: the app's own beforeunload handler must release it.
  await page.getByRole('button', { name: 'Enable monitoring on this insert' }).click();
  await expect(page.getByRole('region', { name: 'Live audio input' })).toContainText('Active');
  await page.evaluate(() => window.addEventListener('beforeunload', () => {
    localStorage.setItem('input-acceptance-shutdown', JSON.stringify({
      state: window.__apexAcceptance.liveInputState(),
      released: window.__inputCaptureEvidence.streams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')),
    }));
  }));
  await app.close(); app = undefined;
  const reopened = await _electron.launch({ executablePath, env, args, timeout: 180000 });
  app = reopened;
  const reopenedPage = await reopened.firstWindow();
  await reopenedPage.waitForFunction(() => !!window.__apexAcceptance);
  evidence.shutdown = await reopenedPage.evaluate(() => JSON.parse(localStorage.getItem('input-acceptance-shutdown') ?? 'null'));
  assert.equal(evidence.shutdown?.state.status, 'off'); assert.equal(evidence.shutdown?.released, true);
  assert.equal(await reopenedPage.evaluate(() => window.__apexAcceptance.liveInputState().status), 'off');
  evidence.status = 'PASS';
} catch (error) {
  evidence.status = 'FAIL'; evidence.error = String(error?.stack ?? error); process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
  console.log('PACKAGED-LIVE-INPUT', JSON.stringify(evidence));
}
