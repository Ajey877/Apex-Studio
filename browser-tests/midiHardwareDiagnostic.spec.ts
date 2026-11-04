import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const DIAGNOSTIC_URL = 'http://localhost:3000/midi-hardware-diagnostic.html';

interface HarnessPacket {
  portId: string;
  bytes: number[];
  timestamp: number | null;
}

declare global {
  interface Window {
    __midiBenchHarness?: {
      sentPackets: HarnessPacket[];
      setPermissionGranted: (granted: boolean) => void;
      setThrowOnSendAttempt: (id: string, attempt: number) => void;
      sendAttempts: (id: string) => number;
      setOutputState: (id: string, state: 'connected' | 'disconnected') => void;
      removeOutputFromAccess: (id: string) => void;
      restoreOutputInAccess: (id: string) => void;
      emitInput: (id: string, bytes: number[]) => void;
      requestCalls: () => number;
    };
  }
}

async function installFakeWebMidi(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let permissionGranted = true;
    let requests = 0;
    const sentPackets: HarnessPacket[] = [];
    const input = {
      id: 'loopback-in-1',
      name: 'Test Loopback Input',
      manufacturer: 'Arena Simulation',
      type: 'input',
      state: 'connected',
      connection: 'open',
      onmidimessage: null as ((event: { data: Uint8Array; timeStamp: number }) => void) | null,
    };
    const makeOutput = (id: string, name: string, supportsClear = true) => ({
      id,
      name,
      manufacturer: 'Arena Simulation',
      type: 'output',
      state: 'connected' as 'connected' | 'disconnected',
      connection: 'closed' as 'open' | 'closed',
      sendAttempts: 0,
      throwOnSendAttempt: null as number | null,
      open() {
        if (this.state === 'connected') this.connection = 'open';
        return Promise.resolve(this);
      },
      send(data: number[] | Uint8Array, timestamp?: number) {
        this.sendAttempts += 1;
        if (this.throwOnSendAttempt === this.sendAttempts) {
          this.throwOnSendAttempt = null;
          throw new Error(`simulated send failure on attempt ${this.sendAttempts}`);
        }
        if (this.state !== 'connected' || this.connection !== 'open') throw new Error('fake output disconnected');
        const bytes = Array.from(data);
        sentPackets.push({ portId: id, bytes, timestamp: timestamp ?? null });
        // This is a JavaScript-only loopback simulation for the harness UI test.
        setTimeout(() => input.onmidimessage?.({ data: Uint8Array.from(bytes), timeStamp: timestamp ?? performance.now() }), 0);
      },
      clear: supportsClear ? () => {} : undefined,
    });
    const outputA = makeOutput('usb-out-1', 'Simulated Interface Out 1');
    const outputB = makeOutput('usb-out-2', 'Simulated Interface Out 2');
    const outputClearless = makeOutput('usb-out-clearless', 'Simulated Legacy Interface Out', false);
    const inputs = new Map([[input.id, input]]);
    const outputs = new Map([[outputA.id, outputA], [outputB.id, outputB], [outputClearless.id, outputClearless]]);
    const allOutputs = new Map(outputs);
    const access = {
      inputs,
      outputs,
      onstatechange: null as ((event: { port: unknown }) => void) | null,
    };

    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: async () => {
        requests += 1;
        if (!permissionGranted) throw new DOMException('Simulated MIDI permission denied', 'NotAllowedError');
        return access;
      },
    });

    window.__midiBenchHarness = {
      sentPackets,
      setPermissionGranted(granted) { permissionGranted = granted; },
      setThrowOnSendAttempt(id, attempt) {
        const port = allOutputs.get(id);
        if (port) port.throwOnSendAttempt = attempt;
      },
      sendAttempts(id) { return allOutputs.get(id)?.sendAttempts ?? 0; },
      setOutputState(id, state) {
        const port = allOutputs.get(id);
        if (!port) return;
        port.state = state;
        port.connection = 'closed';
        if (state === 'connected') outputs.set(id, port);
        else outputs.delete(id);
        access.onstatechange?.({ port });
      },
      removeOutputFromAccess(id) {
        const port = allOutputs.get(id);
        if (!port) return;
        port.state = 'disconnected';
        port.connection = 'closed';
        outputs.delete(id);
        access.onstatechange?.({ port });
      },
      restoreOutputInAccess(id) {
        const port = allOutputs.get(id);
        if (!port) return;
        port.state = 'connected';
        port.connection = 'closed';
        outputs.set(id, port);
        access.onstatechange?.({ port });
      },
      emitInput(id, bytes) {
        if (id !== input.id) return;
        input.onmidimessage?.({ data: Uint8Array.from(bytes), timeStamp: performance.now() });
      },
      requestCalls: () => requests,
    };
  });
}

test.describe('Standalone external MIDI hardware diagnostic — Chromium harness', () => {
  test('records permission, stable device identity, timestamped bytes and exact loopback comparison', async ({ page }) => {
    await installFakeWebMidi(page);
    await page.goto(DIAGNOSTIC_URL);
    await expect(page.getByRole('heading', { name: 'External MIDI Hardware Diagnostic' })).toBeVisible();
    await page.locator('#request-midi-access-btn').click();

    await expect(page.locator('#permission-status')).toContainText('Granted');
    await expect(page.locator('#selected-device-status')).toContainText('usb-out-1');
    await page.locator('#midi-output-select').selectOption('usb-out-1');
    await page.locator('#midi-input-select').selectOption('loopback-in-1');
    await page.locator('#midi-channel-select').selectOption('4');
    await page.locator('#note-pitch').fill('60');
    await page.locator('#note-velocity').fill('100');
    await page.locator('#note-gate-ms').fill('120');
    await page.locator('#send-test-note-btn').click();

    await expect
      .poll(async () => page.evaluate(() => window.__midiBenchHarness?.sentPackets.length ?? 0))
      .toBe(2);
    await expect(page.locator('#event-log')).toContainText('output-send');
    await expect(page.locator('#event-log')).toContainText('"schedulingStatus":"complete"');
    await expect(page.locator('#selected-device-status')).not.toContainText('note release pending');
    await expect
      .poll(async () => page.locator('#event-log').evaluate(element => (element.textContent?.match(/loopback-midi-in/g) ?? []).length))
      .toBe(2);
    await page.locator('#compare-loopback-btn').click();
    await expect(page.locator('#loopback-summary')).toContainText('Exact byte matches: 2; missing: 0; extra: 0');
    await expect(page.locator('#loopback-summary')).toContainText('usb-out-1');

    const sent = await page.evaluate(() => window.__midiBenchHarness?.sentPackets ?? []);
    expect(sent.map(packet => packet.bytes)).toEqual([
      [0x93, 60, 100],
      [0x83, 60, 0],
    ]);
    expect(sent.every(packet => packet.timestamp !== null)).toBe(true);
    const jsonPromise = page.waitForEvent('download');
    await page.locator('#download-json-btn').click();
    const download = await jsonPromise;
    expect(download.suggestedFilename()).toMatch(/^apex-midi-diagnostic-.*\.json$/);
    const reportPath = await download.path();
    expect(reportPath).not.toBeNull();
    const report = JSON.parse(await readFile(reportPath!, 'utf8')) as {
      unresolvedRecovery: { pendingNoteReleases: unknown[]; reconnectRecoveries: unknown[] };
    };
    expect(report.unresolvedRecovery).toEqual({ pendingNoteReleases: [], reconnectRecoveries: [] });
  });

  test('keeps accepted Note On ownership after the Note Off send throws, then recovers on the same output and reports pending state', async ({ page }) => {
    await installFakeWebMidi(page);
    await page.goto(DIAGNOSTIC_URL);
    await page.locator('#request-midi-access-btn').click();
    await page.locator('#midi-output-select').selectOption('usb-out-1');
    await page.locator('#midi-channel-select').selectOption('5');
    await page.locator('#note-pitch').fill('68');
    await page.locator('#note-velocity').fill('91');
    await page.locator('#note-gate-ms').fill('2000');
    await page.evaluate(() => window.__midiBenchHarness?.setThrowOnSendAttempt('usb-out-1', 2));
    await page.locator('#send-test-note-btn').click();

    await expect.poll(async () => page.evaluate(() => window.__midiBenchHarness?.sendAttempts('usb-out-1') ?? 0)).toBe(2);
    await expect.poll(async () => page.evaluate(() => window.__midiBenchHarness?.sentPackets.length ?? 0)).toBe(1);
    await expect(page.locator('#event-log')).toContainText('test-note-partial-schedule');
    await expect(page.locator('#event-log')).toContainText('"noteOnAccepted":true');
    await expect(page.locator('#event-log')).toContainText('"noteOffAccepted":false');
    await expect(page.locator('#selected-device-status')).toContainText('note release pending');
    await expect(page.locator('#send-test-note-btn')).toBeDisabled();

    const initiallyAccepted = await page.evaluate(() => window.__midiBenchHarness?.sentPackets ?? []);
    expect(initiallyAccepted.map(packet => packet.bytes)).toEqual([[0x94, 68, 91]]);
    expect(initiallyAccepted[0].timestamp).not.toBeNull();
    const pendingJsonPromise = page.waitForEvent('download');
    await page.locator('#download-json-btn').click();
    const pendingJsonDownload = await pendingJsonPromise;
    const pendingJsonPath = await pendingJsonDownload.path();
    expect(pendingJsonPath).not.toBeNull();
    const pendingReport = JSON.parse(await readFile(pendingJsonPath!, 'utf8')) as {
      unresolvedRecovery: {
        pendingNoteReleases: Array<{
          outputDeviceId: string;
          midiChannel: number;
          pitch: number;
          noteOffState: string;
          intendedOnTimeMs: number;
          intendedOffTimeMs: number;
        }>;
        reconnectRecoveries: unknown[];
      };
    };
    expect(pendingReport.unresolvedRecovery.pendingNoteReleases).toHaveLength(1);
    expect(pendingReport.unresolvedRecovery.pendingNoteReleases[0]).toMatchObject({
      outputDeviceId: 'usb-out-1',
      midiChannel: 5,
      pitch: 68,
      noteOffState: 'pending',
    });
    expect(pendingReport.unresolvedRecovery.pendingNoteReleases[0].intendedOffTimeMs)
      .toBeGreaterThan(pendingReport.unresolvedRecovery.pendingNoteReleases[0].intendedOnTimeMs);

    const pendingCsvPromise = page.waitForEvent('download');
    await page.locator('#download-csv-btn').click();
    const pendingCsvDownload = await pendingCsvPromise;
    const pendingCsvPath = await pendingCsvDownload.path();
    expect(pendingCsvPath).not.toBeNull();
    const pendingCsv = await readFile(pendingCsvPath!, 'utf8');
    expect(pendingCsv).toContain('unresolved-recovery-snapshot');
    expect(pendingCsv).toContain('pendingNoteReleases');
    expect(pendingCsv).toContain('usb-out-1');

    await page.evaluate(() => window.__midiBenchHarness?.removeOutputFromAccess('usb-out-1'));
    await expect(page.locator('#selected-device-status')).toContainText('reconnect recovery pending');
    await page.evaluate(() => window.__midiBenchHarness?.restoreOutputInAccess('usb-out-1'));
    await expect.poll(async () => page.locator('#event-log').textContent(), { timeout: 3000 })
      .toContain('reconnect-recovery-complete');

    const recoveredPackets = await page.evaluate(() => window.__midiBenchHarness?.sentPackets ?? []);
    expect(recoveredPackets.map(packet => packet.bytes)).toEqual([
      [0x94, 68, 91],
      [0x84, 68, 0],
    ]);
    expect(recoveredPackets.every(packet => packet.portId === 'usb-out-1')).toBe(true);
    expect(recoveredPackets[1].timestamp).not.toBeNull();
    expect(recoveredPackets[1].timestamp!).toBeGreaterThanOrEqual(recoveredPackets[0].timestamp! + 1);
    expect(recoveredPackets.some(packet => packet.portId === 'usb-out-2')).toBe(false);
    expect(recoveredPackets.some(packet => (packet.bytes[0] & 0xf0) === 0xb0 && packet.bytes[1] === 123)).toBe(false);

    const modeledReceiver = new Set<string>();
    for (const packet of [...recoveredPackets].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))) {
      const [status, pitch, velocity] = packet.bytes;
      const channel = (status & 0x0f) + 1;
      if ((status & 0xf0) === 0x90 && velocity > 0) modeledReceiver.add(`${channel}:${pitch}`);
      if ((status & 0xf0) === 0x80 || ((status & 0xf0) === 0x90 && velocity === 0)) modeledReceiver.delete(`${channel}:${pitch}`);
    }
    expect([...modeledReceiver]).toEqual([]);
    await expect(page.locator('#selected-device-status')).not.toContainText('recovery pending');
    await expect(page.locator('#send-test-note-btn')).toBeEnabled();
  });

  test('retries a failed Note Off only after its intended gate and clears ownership after the same-output retry succeeds', async ({ page }) => {
    await installFakeWebMidi(page);
    await page.goto(DIAGNOSTIC_URL);
    await page.locator('#request-midi-access-btn').click();
    await page.locator('#midi-output-select').selectOption('usb-out-1');
    await page.locator('#midi-channel-select').selectOption('3');
    await page.locator('#note-pitch').fill('67');
    await page.locator('#note-gate-ms').fill('20');
    await page.evaluate(() => window.__midiBenchHarness?.setThrowOnSendAttempt('usb-out-1', 2));
    await page.locator('#send-test-note-btn').click();

    await expect(page.locator('#selected-device-status')).toContainText('note release pending');
    await expect.poll(async () => page.locator('#event-log').textContent(), { timeout: 3000 })
      .toContain('test-note-off-retry-scheduled');
    await expect.poll(async () => page.evaluate(() => window.__midiBenchHarness?.sentPackets.length ?? 0)).toBe(2);
    await expect.poll(async () => page.locator('#event-log').textContent(), { timeout: 3000 })
      .toContain('test-note-release-settled');

    const retriedPackets = await page.evaluate(() => window.__midiBenchHarness?.sentPackets ?? []);
    expect(retriedPackets.map(packet => packet.portId)).toEqual(['usb-out-1', 'usb-out-1']);
    expect(retriedPackets.map(packet => packet.bytes)).toEqual([
      [0x92, 67, 96],
      [0x82, 67, 0],
    ]);
    expect(retriedPackets[1].timestamp).not.toBeNull();
    expect(retriedPackets[1].timestamp!).toBeGreaterThanOrEqual(retriedPackets[0].timestamp! + 1);
    expect(await page.evaluate(() => window.__midiBenchHarness?.sendAttempts('usb-out-1') ?? 0)).toBe(3);
    await expect(page.locator('#selected-device-status')).not.toContainText('note release pending');
    await expect(page.locator('#send-test-note-btn')).toBeEnabled();
  });

  test('keeps queue timing and sustain recovery after log clearing on a clear-less output', async ({ page }) => {
    await installFakeWebMidi(page);
    await page.goto(DIAGNOSTIC_URL);
    await page.locator('#request-midi-access-btn').click();
    await page.locator('#midi-output-select').selectOption('usb-out-clearless');
    await page.locator('#midi-channel-select').selectOption('3');
    await page.locator('#note-pitch').fill('67');
    await page.locator('#note-velocity').fill('96');
    await page.locator('#note-gate-ms').fill('650');
    await page.locator('#sustain-down-btn').click();
    await page.locator('#send-test-note-btn').click();
    await expect
      .poll(async () => page.evaluate(() => window.__midiBenchHarness?.sentPackets.length ?? 0))
      .toBe(3);
    const queuedPackets = await page.evaluate(() => window.__midiBenchHarness?.sentPackets ?? []);
    const latestQueuedTimestamp = Math.max(...queuedPackets.map(packet => packet.timestamp ?? 0));
    await page.locator('#clear-log-btn').click();

    await page.evaluate(() => window.__midiBenchHarness?.setOutputState('usb-out-clearless', 'disconnected'));
    await expect(page.locator('#event-log')).toContainText('output-queue-clear-unavailable');
    await page.evaluate(() => window.__midiBenchHarness?.setOutputState('usb-out-clearless', 'connected'));

    await expect(page.locator('#selected-device-status')).toContainText('recovery pending');
    await expect(page.locator('#send-test-note-btn')).toBeDisabled();
    await page.waitForTimeout(100);
    await expect(page.locator('#event-log')).not.toContainText('reconnect-recovery-complete');
    await expect
      .poll(async () => page.locator('#event-log').textContent(), { timeout: 3000 })
      .toContain('reconnect-recovery-complete');

    const recoveredPackets = await page.evaluate(() => window.__midiBenchHarness?.sentPackets ?? []);
    expect(recoveredPackets).toHaveLength(5);
    expect(recoveredPackets.slice(-2).every(packet => packet.portId === 'usb-out-clearless')).toBe(true);
    expect(recoveredPackets.slice(-2).every(packet => (packet.timestamp ?? 0) > latestQueuedTimestamp)).toBe(true);
    expect(recoveredPackets.slice(-2).map(packet => packet.bytes)).toEqual([
      [0xb2, 64, 0],
      [0x82, 67, 0],
    ]);
    await expect(page.locator('#selected-device-status')).not.toContainText('recovery pending');
    await expect(page.locator('#send-test-note-btn')).toBeEnabled();
  });

  test('recovers only tracked notes and sustain on the reconnected output, never the sibling output', async ({ page }) => {
    await installFakeWebMidi(page);
    await page.goto(DIAGNOSTIC_URL);
    await page.locator('#request-midi-access-btn').click();
    await page.locator('#midi-output-select').selectOption('usb-out-1');
    await page.locator('#midi-channel-select').selectOption('2');
    await page.locator('#note-pitch').fill('64');
    await page.locator('#note-velocity').fill('90');
    await page.locator('#note-gate-ms').fill('1500');
    await page.locator('#sustain-down-btn').click();
    await page.locator('#send-test-note-btn').click();
    await expect
      .poll(async () => page.evaluate(() => window.__midiBenchHarness?.sentPackets.length ?? 0))
      .toBe(3);

    await page.evaluate(() => window.__midiBenchHarness?.removeOutputFromAccess('usb-out-1'));
    await expect(page.locator('#event-log')).toContainText('output-disconnected');
    await expect(page.locator('#selected-device-status')).toContainText('usb-out-1');
    await expect(page.locator('#selected-device-status')).toContainText('disconnected');
    await expect(page.locator('#midi-output-select')).toHaveValue('usb-out-1');
    await page.evaluate(() => window.__midiBenchHarness?.restoreOutputInAccess('usb-out-1'));

    await expect
      .poll(async () => page.locator('#event-log').textContent())
      .toContain('reconnect-recovery-complete');
    const sent = await page.evaluate(() => window.__midiBenchHarness?.sentPackets ?? []);
    expect(sent.filter(packet => packet.portId === 'usb-out-2')).toHaveLength(0);
    expect(sent.some(packet => packet.portId === 'usb-out-1' && packet.bytes[0] === 0xb1 && packet.bytes[1] === 64 && packet.bytes[2] === 0)).toBe(true);
    expect(sent.some(packet => packet.portId === 'usb-out-1' && packet.bytes[0] === 0x81 && packet.bytes[1] === 64 && packet.bytes[2] === 0)).toBe(true);
    expect(sent.some(packet => (packet.bytes[0] & 0xf0) === 0xb0 && packet.bytes[1] === 123)).toBe(false);
    await expect(page.locator('#selected-device-status')).toContainText('usb-out-1');
  });
});
