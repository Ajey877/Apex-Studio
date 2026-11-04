import { expect, test, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

interface RecordedMidiPacket {
  seq: number;
  portId: string;
  bytes: number[];
  timestamp: number | null;
  recordedAtPerfMs: number;
  cancelledByClearAtPerfMs: number | null;
}

interface RecordedClearEvent {
  portId: string;
  clearedAtPerfMs: number;
  cancelledPacketSeqs: number[];
}

declare global {
  interface Window {
    __apexMidiTestHarness?: {
      sentPackets: RecordedMidiPacket[];
      clearCounts: Record<string, number>;
      clearEvents: RecordedClearEvent[];
      openCounts: Record<string, number>;
      requestCalls: number;
      setPermissionGranted: (granted: boolean) => void;
      setOutputState: (portId: string, nextState: 'connected' | 'disconnected') => void;
      clearRecorded: () => void;
    };
  }
}

async function installInstrumentedWebMidiHarness(
  page: Page,
  initiallyGranted = true,
): Promise<void> {
  await page.addInitScript((permissionInitiallyGranted: boolean) => {
    let nextSeq = 1;
    let permissionGranted = permissionInitiallyGranted;
    let requestCalls = 0;
    const sentPackets: RecordedMidiPacket[] = [];
    const clearEvents: RecordedClearEvent[] = [];
    const clearCounts: Record<string, number> = {
      'out-synth-a': 0,
      'out-drum-b': 0,
    };
    const openCounts: Record<string, number> = {
      'out-synth-a': 0,
      'out-drum-b': 0,
    };

    const makeInput = (id: string, name: string, manufacturer: string) => ({
      id,
      name,
      manufacturer,
      type: 'input',
      state: 'connected',
      connection: 'open',
      onmidimessage: null as ((ev: { data: Uint8Array }) => void) | null,
      open() {
        this.connection = 'open';
        return Promise.resolve(this);
      },
    });

    const makeOutput = (
      id: string,
      name: string,
      manufacturer: string,
      initialConnection: 'open' | 'closed',
    ) => {
      const port = {
        id,
        name,
        manufacturer,
        type: 'output',
        state: 'connected' as 'connected' | 'disconnected',
        connection: initialConnection as 'open' | 'closed',
        open() {
          openCounts[id] = (openCounts[id] || 0) + 1;
          if (port.state === 'connected') {
            port.connection = 'open';
          }
          return Promise.resolve(port);
        },
        send(data: number[] | Uint8Array, timestamp?: number) {
          if (port.state !== 'connected' || port.connection !== 'open') {
            throw new Error(`MIDIOutput ${id} is not open (${port.state}/${port.connection})`);
          }
          sentPackets.push({
            seq: nextSeq++,
            portId: id,
            bytes: Array.from(data),
            timestamp: typeof timestamp === 'number' ? timestamp : null,
            recordedAtPerfMs: performance.now(),
            cancelledByClearAtPerfMs: null,
          });
        },
        clear() {
          const clearedAtPerfMs = performance.now();
          clearCounts[id] = (clearCounts[id] || 0) + 1;
          const cancelledPacketSeqs: number[] = [];
          for (const pkt of sentPackets) {
            if (
              pkt.portId === id &&
              pkt.cancelledByClearAtPerfMs === null &&
              pkt.timestamp !== null &&
              pkt.timestamp > clearedAtPerfMs
            ) {
              pkt.cancelledByClearAtPerfMs = clearedAtPerfMs;
              cancelledPacketSeqs.push(pkt.seq);
            }
          }
          clearEvents.push({
            portId: id,
            clearedAtPerfMs,
            cancelledPacketSeqs,
          });
        },
      };
      return port;
    };

    const inputA = makeInput('in-keystep', 'Arturia KeyStep 37', 'Arturia');
    const outputA = makeOutput('out-synth-a', 'Sequential Prophet-6', 'Sequential', 'closed');
    const outputB = makeOutput('out-drum-b', 'Elektron Digitakt', 'Elektron', 'open');

    const inputs = new Map([[inputA.id, inputA]]);
    const outputs = new Map([
      [outputA.id, outputA],
      [outputB.id, outputB],
    ]);

    const access = {
      sysexEnabled: false,
      inputs,
      outputs,
      onstatechange: null as ((ev: { port: unknown }) => void) | null,
    };

    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      writable: true,
      value: () => {
        requestCalls += 1;
        if (!permissionGranted) {
          const error = new DOMException('Web MIDI permission denied by test harness', 'NotAllowedError');
          return Promise.reject(error);
        }
        return Promise.resolve(access);
      },
    });

    window.__apexMidiTestHarness = {
      sentPackets,
      clearCounts,
      clearEvents,
      openCounts,
      get requestCalls() {
        return requestCalls;
      },
      setPermissionGranted(granted: boolean) {
        permissionGranted = granted;
        if (granted) {
          for (const port of outputs.values()) {
            port.connection = 'closed';
          }
        }
      },
      setOutputState(portId: string, nextState: 'connected' | 'disconnected') {
        const target = outputs.get(portId);
        if (!target) return;
        target.state = nextState;
        target.connection = 'closed';
        if (typeof access.onstatechange === 'function') {
          access.onstatechange({ port: target });
        }
      },
      clearRecorded() {
        sentPackets.length = 0;
        clearEvents.length = 0;
        clearCounts['out-synth-a'] = 0;
        clearCounts['out-drum-b'] = 0;
      },
    };
  }, initiallyGranted);
}

test.describe('Phase 1 External MIDI Output — Chromium E2E', () => {
  test('surfaces denied MIDI permission and recovers UI/device discovery after grant and re-grant', async ({ page }) => {
    await installInstrumentedWebMidiHarness(page, false);
    await page.goto(APP_URL);
    await page.waitForSelector('#root > *', { state: 'attached' });
    await page.locator('#fl-midi-hub-btn').click();

    const midiDialog = page.locator('#midi-controller-modal-overlay');
    await expect(midiDialog).toBeVisible();
    await expect(midiDialog.getByTestId('web-midi-hardware-warning')).toContainText('Web MIDI Permission Denied');
    await expect(midiDialog).toContainText('No Hardware MIDI Devices Detected');
    const outputSection = midiDialog.getByTestId('midi-output-devices-section');

    const initialRequests = await page.evaluate(() => window.__apexMidiTestHarness?.requestCalls ?? 0);
    await page.evaluate(() => window.__apexMidiTestHarness?.setPermissionGranted(true));
    await midiDialog.locator('#rescan-midi-devices-btn').click();
    await expect(outputSection.getByTestId('midi-output-card-out-synth-a')).toContainText('Ready');
    const opensAfterGrant = await page.evaluate(() => window.__apexMidiTestHarness?.openCounts['out-synth-a'] ?? 0);
    expect(opensAfterGrant).toBeGreaterThanOrEqual(1);

    await page.evaluate(() => window.__apexMidiTestHarness?.setPermissionGranted(false));
    await midiDialog.locator('#rescan-midi-devices-btn').click();
    await expect(midiDialog.getByTestId('web-midi-hardware-warning')).toContainText('Web MIDI Permission Denied');
    await expect(midiDialog).toContainText('No Hardware MIDI Devices Detected');

    await page.evaluate(() => window.__apexMidiTestHarness?.setPermissionGranted(true));
    await midiDialog.locator('#rescan-midi-devices-btn').click();
    await expect(outputSection.getByTestId('midi-output-card-out-synth-a')).toContainText('Ready');
    await expect
      .poll(async () => page.evaluate(() => window.__apexMidiTestHarness?.requestCalls ?? 0))
      .toBeGreaterThan(initialRequests + 2);
    const opensAfterRegrant = await page.evaluate(() => window.__apexMidiTestHarness?.openCounts['out-synth-a'] ?? 0);
    expect(opensAfterRegrant).toBeGreaterThan(opensAfterGrant);
  });

  test('routes pattern playback to an instrumented MIDIOutput with real timestamps, deterministic stop cleanup, hot-unplug safety, undo/redo, and export truthfulness', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await installInstrumentedWebMidiHarness(page);

    await page.goto(APP_URL);
    await page.waitForSelector('#root > *', { state: 'attached' });
    await page.waitForTimeout(600);

    // 1. Open Hardware MIDI & Controller Hub and verify separated Input / Output sections + opened port readiness
    await page.locator('#fl-midi-hub-btn').click();
    const midiDialog = page.locator('#midi-controller-modal-overlay');
    await expect(midiDialog).toBeVisible();

    const inputSection = midiDialog.getByTestId('midi-input-devices-section');
    const outputSection = midiDialog.getByTestId('midi-output-devices-section');
    await expect(inputSection).toBeVisible();
    await expect(outputSection).toBeVisible();
    await expect(inputSection).toContainText('Arturia KeyStep 37');
    await expect(outputSection).toContainText('Sequential Prophet-6');
    await expect(outputSection).toContainText('Elektron Digitakt');

    await expect
      .poll(async () => page.evaluate(() => window.__apexMidiTestHarness?.openCounts['out-synth-a'] ?? 0))
      .toBeGreaterThanOrEqual(1);
    await expect(outputSection.getByTestId('midi-output-card-out-synth-a')).toContainText('Ready');

    // 2. Configure ch-kick (pitch 36, 1-step note at step 0) -> External Only, Prophet-6, MIDI Ch 4
    const routingSection = midiDialog.getByTestId('channel-midi-output-routing');
    await expect(routingSection).toBeVisible();

    await routingSection.getByTestId('midi-out-mode-ch-kick').selectOption('external');
    await routingSection.getByTestId('midi-out-device-ch-kick').selectOption('out-synth-a');
    await routingSection.getByTestId('midi-out-channel-ch-kick').selectOption('4');
    await expect(routingSection.getByTestId('midi-out-status-ch-kick')).toContainText('Ready · Ch 4');

    await midiDialog.locator('#close-midi-modal-btn').click();
    await expect(midiDialog).toBeHidden();

    // 3. Start real transport playback and verify timestamped Note On (0x93) and Note Off (0x83) on Prophet-6 only
    await page.evaluate(() => window.__apexMidiTestHarness?.clearRecorded());
    await page.locator('#fl-play-btn').click();

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const pkts = window.__apexMidiTestHarness?.sentPackets ?? [];
            const synthOns = pkts.filter(
              p => p.portId === 'out-synth-a' && p.bytes[0] === 0x93 && p.bytes[1] === 36 && p.bytes[2] > 0,
            );
            const synthOffs = pkts.filter(
              p => p.portId === 'out-synth-a' && p.bytes[0] === 0x83 && p.bytes[1] === 36,
            );
            return synthOns.length >= 1 && synthOffs.length >= 1;
          }),
        { timeout: 8000 },
      )
      .toBe(true);

    const playbackAudit = await page.evaluate(() => {
      const pkts = window.__apexMidiTestHarness?.sentPackets ?? [];
      const firstOn = pkts.find(p => p.portId === 'out-synth-a' && p.bytes[0] === 0x93 && p.bytes[1] === 36)!;
      const firstOff = pkts.find(p => p.portId === 'out-synth-a' && p.bytes[0] === 0x83 && p.bytes[1] === 36)!;
      const drumPackets = pkts.filter(p => p.portId === 'out-drum-b');
      return {
        onTimestamp: firstOn.timestamp,
        offTimestamp: firstOff.timestamp,
        durationMs:
          firstOn.timestamp !== null && firstOff.timestamp !== null
            ? firstOff.timestamp - firstOn.timestamp
            : -1,
        drumPacketCount: drumPackets.length,
      };
    });

    expect(playbackAudit.onTimestamp).not.toBeNull();
    expect(playbackAudit.offTimestamp).not.toBeNull();
    expect(playbackAudit.durationMs).toBeGreaterThan(50);
    expect(playbackAudit.drumPacketCount).toBe(0);

    await page.locator('#fl-stop-btn').click();

    // 4A. Deterministic Stop cleanup while a multi-step note (ch-808 b1, 4 steps = ~428.6 ms)
    //     is genuinely active, while ch-snare (first note at step 4) is routed to out-drum-b Ch 10.
    await page.locator('#fl-midi-hub-btn').click();
    await expect(midiDialog).toBeVisible();
    await routingSection.getByTestId('midi-out-mode-ch-kick').selectOption('off');
    await routingSection.getByTestId('midi-out-mode-ch-808').selectOption('external');
    await routingSection.getByTestId('midi-out-device-ch-808').selectOption('out-synth-a');
    await routingSection.getByTestId('midi-out-channel-ch-808').selectOption('4');
    await expect(routingSection.getByTestId('midi-out-status-ch-808')).toContainText('Ready · Ch 4');

    await routingSection.getByTestId('midi-out-mode-ch-snare').selectOption('external');
    await routingSection.getByTestId('midi-out-device-ch-snare').selectOption('out-drum-b');
    await routingSection.getByTestId('midi-out-channel-ch-snare').selectOption('10');
    await expect(routingSection.getByTestId('midi-out-status-ch-snare')).toContainText('Ready · Ch 10');

    await midiDialog.locator('#close-midi-modal-btn').click();
    await expect(midiDialog).toBeHidden();

    const activeStopAudit = await page.evaluate(async () => {
      // @ts-ignore — shared production singleton used by App and scheduler
      const { audioEngine } = await import('/src/audio/audioEngine.ts');
      const harness = window.__apexMidiTestHarness!;
      harness.clearRecorded();

      (document.getElementById('fl-play-btn') as HTMLButtonElement).click();

      const deadline = performance.now() + 4000;
      let preStopActiveCount = 0;
      while (performance.now() < deadline) {
        const now = performance.now();
        const activeCount = audioEngine.getActiveExternalMidiNoteCount('ch-808');
        const soundingOn = harness.sentPackets.some(
          p =>
            p.portId === 'out-synth-a' &&
            p.bytes[0] === 0x93 &&
            p.bytes[1] === 36 &&
            p.bytes[2] > 0 &&
            (p.timestamp === null || p.timestamp <= now),
        );
        if (activeCount >= 1 && soundingOn) {
          preStopActiveCount = activeCount;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 4));
      }

      const stopBtn = document.getElementById('fl-stop-btn') as HTMLButtonElement;
      stopBtn.click();
      const postStopActiveCount = audioEngine.getActiveExternalMidiNoteCount();
      const postStopCh808Count = audioEngine.getActiveExternalMidiNoteCount('ch-808');
      const packetCountImmediatelyAfterStop = harness.sentPackets.length;

      // Wait 300 ms past Stop to confirm zero stale Note On events fire afterward
      await new Promise(resolve => setTimeout(resolve, 300));

      const synthPackets = harness.sentPackets.filter(p => p.portId === 'out-synth-a');
      const drumPackets = harness.sentPackets.filter(p => p.portId === 'out-drum-b');
      const latePacketsAfterStop = harness.sentPackets.slice(packetCountImmediatelyAfterStop);
      const lateNoteOns = latePacketsAfterStop.filter(
        p => (p.bytes[0] & 0xf0) === 0x90 && p.bytes[2] > 0,
      );

      return {
        preStopActiveCount,
        postStopActiveCount,
        postStopCh808Count,
        synthClearCount: harness.clearCounts['out-synth-a'],
        drumClearCount: harness.clearCounts['out-drum-b'],
        drumPacketCount: drumPackets.length,
        hasImmediateNoteOff: synthPackets.some(
          p => p.bytes[0] === 0x83 && p.bytes[1] === 36 && p.bytes[2] === 0 && p.timestamp === null,
        ),
        hasAllNotesOffCc123: synthPackets.some(
          p => p.bytes[0] === 0xb3 && p.bytes[1] === 123 && p.bytes[2] === 0,
        ),
        nonCh4SynthPackets: synthPackets.filter(p => (p.bytes[0] & 0x0f) !== 3).length,
        lateNoteOnsCount: lateNoteOns.length,
      };
    });

    expect(activeStopAudit.preStopActiveCount).toBeGreaterThanOrEqual(1);
    expect(activeStopAudit.synthClearCount).toBeGreaterThanOrEqual(1);
    expect(activeStopAudit.hasImmediateNoteOff).toBe(true);
    expect(activeStopAudit.hasAllNotesOffCc123).toBe(true);
    expect(activeStopAudit.postStopActiveCount).toBe(0);
    expect(activeStopAudit.postStopCh808Count).toBe(0);
    expect(activeStopAudit.drumClearCount).toBe(0);
    expect(activeStopAudit.drumPacketCount).toBe(0);
    expect(activeStopAudit.nonCh4SynthPackets).toBe(0);
    expect(activeStopAudit.lateNoteOnsCount).toBe(0);

    // 4B. Deterministic Stop cleanup while genuinely pending future timestamped MIDI events
    //     sit in out-synth-a's Web MIDI queue (ch-hihat triggers every 2 steps inside the 100 ms look-ahead).
    await page.locator('#fl-midi-hub-btn').click();
    await expect(midiDialog).toBeVisible();
    await routingSection.getByTestId('midi-out-mode-ch-808').selectOption('off');
    await routingSection.getByTestId('midi-out-mode-ch-hihat').selectOption('external');
    await routingSection.getByTestId('midi-out-device-ch-hihat').selectOption('out-synth-a');
    await routingSection.getByTestId('midi-out-channel-ch-hihat').selectOption('4');
    await expect(routingSection.getByTestId('midi-out-status-ch-hihat')).toContainText('Ready · Ch 4');
    await midiDialog.locator('#close-midi-modal-btn').click();
    await expect(midiDialog).toBeHidden();

    const queuedFutureStopAudit = await page.evaluate(async () => {
      // @ts-ignore — shared production singleton used by App and scheduler
      const { audioEngine } = await import('/src/audio/audioEngine.ts');
      const harness = window.__apexMidiTestHarness!;
      harness.clearRecorded();

      (document.getElementById('fl-play-btn') as HTMLButtonElement).click();

      const deadline = performance.now() + 4000;
      let pendingFutureNoteOnsAtStop = 0;
      while (performance.now() < deadline) {
        const now = performance.now();
        const pendingFutureNoteOns = harness.sentPackets.filter(
          p =>
            p.portId === 'out-synth-a' &&
            p.cancelledByClearAtPerfMs === null &&
            (p.bytes[0] & 0xf0) === 0x90 &&
            p.bytes[2] > 0 &&
            p.timestamp !== null &&
            p.timestamp > now + 2,
        );
        if (pendingFutureNoteOns.length >= 1) {
          pendingFutureNoteOnsAtStop = pendingFutureNoteOns.length;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1));
      }

      const stopTriggeredPerfMs = performance.now();
      (document.getElementById('fl-stop-btn') as HTMLButtonElement).click();
      const postStopActiveCount = audioEngine.getActiveExternalMidiNoteCount();
      const packetCountRightAfterStop = harness.sentPackets.length;

      // Wait 300 ms (well past the 100 ms look-ahead horizon) to prove no stale Note On fires after Stop
      await new Promise(resolve => setTimeout(resolve, 300));

      const cancelledFutureNoteOns = harness.sentPackets.filter(
        p =>
          p.portId === 'out-synth-a' &&
          (p.bytes[0] & 0xf0) === 0x90 &&
          p.bytes[2] > 0 &&
          p.cancelledByClearAtPerfMs !== null,
      );
      const lastSynthClearMs =
        harness.clearEvents.filter(e => e.portId === 'out-synth-a').at(-1)?.clearedAtPerfMs ??
        stopTriggeredPerfMs;
      const uncancelledFutureNoteOnsAfterStop = harness.sentPackets.filter(
        p =>
          p.portId === 'out-synth-a' &&
          (p.bytes[0] & 0xf0) === 0x90 &&
          p.bytes[2] > 0 &&
          p.cancelledByClearAtPerfMs === null &&
          p.timestamp !== null &&
          p.timestamp > lastSynthClearMs,
      );
      const latePacketsAfterStop = harness.sentPackets.slice(packetCountRightAfterStop);
      const lateNoteOns = latePacketsAfterStop.filter(
        p => (p.bytes[0] & 0xf0) === 0x90 && p.bytes[2] > 0,
      );

      return {
        pendingFutureNoteOnsAtStop,
        synthClearCount: harness.clearCounts['out-synth-a'],
        cancelledFutureNoteOnCount: cancelledFutureNoteOns.length,
        uncancelledFutureNoteOnCount: uncancelledFutureNoteOnsAfterStop.length,
        postStopActiveCount,
        lateNoteOnsCount: lateNoteOns.length,
      };
    });

    expect(queuedFutureStopAudit.pendingFutureNoteOnsAtStop).toBeGreaterThanOrEqual(1);
    expect(queuedFutureStopAudit.synthClearCount).toBeGreaterThanOrEqual(1);
    expect(queuedFutureStopAudit.cancelledFutureNoteOnCount).toBeGreaterThanOrEqual(1);
    expect(queuedFutureStopAudit.uncancelledFutureNoteOnCount).toBe(0);
    expect(queuedFutureStopAudit.postStopActiveCount).toBe(0);
    expect(queuedFutureStopAudit.lateNoteOnsCount).toBe(0);

    // 5. Verify hot-disconnect & reconnect honesty without silent output substitution
    await page.locator('#fl-midi-hub-btn').click();
    await expect(midiDialog).toBeVisible();
    await routingSection.getByTestId('midi-out-mode-ch-hihat').selectOption('off');
    await routingSection.getByTestId('midi-out-mode-ch-snare').selectOption('off');
    await routingSection.getByTestId('midi-out-mode-ch-kick').selectOption('external');
    await routingSection.getByTestId('midi-out-device-ch-kick').selectOption('out-synth-a');
    await routingSection.getByTestId('midi-out-channel-ch-kick').selectOption('4');
    await expect(routingSection.getByTestId('midi-out-status-ch-kick')).toContainText('Ready · Ch 4');

    await page.evaluate(() => window.__apexMidiTestHarness?.setOutputState('out-synth-a', 'disconnected'));
    await expect(outputSection.getByTestId('midi-output-card-out-synth-a')).toContainText('Disconnected');
    await expect(midiDialog.getByTestId('midi-out-status-ch-kick')).toHaveText('Disconnected');
    await expect(midiDialog.getByTestId('channel-midi-route-row-ch-kick')).toContainText(
      'Hardware device disconnected',
    );
    await expect(midiDialog.getByTestId('midi-out-device-ch-kick')).toHaveValue('out-synth-a');

    // Close modal and run brief playback while out-synth-a is disconnected: out-drum-b MUST NOT be substituted!
    await midiDialog.locator('#close-midi-modal-btn').click();
    await expect(midiDialog).toBeHidden();
    await page.evaluate(() => window.__apexMidiTestHarness?.clearRecorded());
    await page.locator('#fl-play-btn').click();
    await page.waitForTimeout(220);
    await page.locator('#fl-stop-btn').click();
    const disconnectedSubstitutedCount = await page.evaluate(
      () => window.__apexMidiTestHarness?.sentPackets.length ?? -1,
    );
    expect(disconnectedSubstitutedCount).toBe(0);

    // Reopen modal and reconnect out-synth-a -> re-opens port and returns to Ready · Ch 4
    await page.locator('#fl-midi-hub-btn').click();
    await expect(midiDialog).toBeVisible();
    await page.evaluate(() => window.__apexMidiTestHarness?.setOutputState('out-synth-a', 'connected'));
    await expect(midiDialog.getByTestId('midi-out-status-ch-kick')).toContainText('Ready · Ch 4');
    await expect(midiDialog.getByTestId('midi-out-device-ch-kick')).toHaveValue('out-synth-a');

    // Change MIDI channel 4 -> 7 to exercise discrete Undo / Redo history entries
    await routingSection.getByTestId('midi-out-channel-ch-kick').selectOption('7');
    await expect(midiDialog.getByTestId('midi-out-status-ch-kick')).toContainText('Ready · Ch 7');

    await midiDialog.locator('#close-midi-modal-btn').click();
    await expect(midiDialog).toBeHidden();

    // 6. Verify Undo / Redo of channel MIDI output routing
    await page.keyboard.press('Control+z');
    await page.locator('#fl-midi-hub-btn').click();
    await expect(midiDialog).toBeVisible();
    await expect(midiDialog.getByTestId('midi-out-channel-ch-kick')).toHaveValue('4');
    await expect(midiDialog.getByTestId('midi-out-status-ch-kick')).toContainText('Ready · Ch 4');
    await midiDialog.locator('#close-midi-modal-btn').click();
    await expect(midiDialog).toBeHidden();

    await page.keyboard.press('Control+Shift+z');
    await page.locator('#fl-midi-hub-btn').click();
    await expect(midiDialog).toBeVisible();
    await expect(midiDialog.getByTestId('midi-out-channel-ch-kick')).toHaveValue('7');
    await expect(midiDialog.getByTestId('midi-out-status-ch-kick')).toContainText('Ready · Ch 7');
    await midiDialog.locator('#close-midi-modal-btn').click();
    await expect(midiDialog).toBeHidden();

    // 7. Verify Export Modal external-MIDI truthfulness notice
    await page.locator('#fl-export-btn').click();
    const exportNotice = page.getByTestId('export-external-midi-notice');
    await expect(exportNotice).toBeVisible();
    await expect(exportNotice).toContainText(
      'External MIDI hardware audio is not included in offline WAV/stem exports',
    );
  });

  for (const trial of [1, 2, 3] as const) {
    test(`repeated stability trial #${trial}: active-note and future-queue Stop cleanup leaves zero stuck notes or stale events`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await installInstrumentedWebMidiHarness(page);

      await page.goto(APP_URL);
      await page.waitForSelector('#root > *', { state: 'attached' });
      await page.waitForTimeout(500);

      await page.locator('#fl-midi-hub-btn').click();
      const midiDialog = page.locator('#midi-controller-modal-overlay');
      await expect(midiDialog).toBeVisible();

      const routingSection = midiDialog.getByTestId('channel-midi-output-routing');
      await routingSection.getByTestId('midi-out-mode-ch-808').selectOption('external');
      await routingSection.getByTestId('midi-out-device-ch-808').selectOption('out-synth-a');
      await routingSection.getByTestId('midi-out-channel-ch-808').selectOption('6');
      await expect(routingSection.getByTestId('midi-out-status-ch-808')).toContainText('Ready · Ch 6');

      await routingSection.getByTestId('midi-out-mode-ch-hihat').selectOption('external');
      await routingSection.getByTestId('midi-out-device-ch-hihat').selectOption('out-synth-a');
      await routingSection.getByTestId('midi-out-channel-ch-hihat').selectOption('6');

      await routingSection.getByTestId('midi-out-mode-ch-snare').selectOption('external');
      await routingSection.getByTestId('midi-out-device-ch-snare').selectOption('out-drum-b');
      await routingSection.getByTestId('midi-out-channel-ch-snare').selectOption('10');

      await midiDialog.locator('#close-midi-modal-btn').click();
      await expect(midiDialog).toBeHidden();

      const trialAudit = await page.evaluate(async () => {
        // @ts-ignore — shared production singleton used by App and scheduler
        const { audioEngine } = await import('/src/audio/audioEngine.ts');
        const harness = window.__apexMidiTestHarness!;
        harness.clearRecorded();

        (document.getElementById('fl-play-btn') as HTMLButtonElement).click();

        const deadline = performance.now() + 4000;
        let sawActiveAndPending = false;
        while (performance.now() < deadline) {
          const now = performance.now();
          const activeCount = audioEngine.getActiveExternalMidiNoteCount('ch-808');
          const sounding808 = harness.sentPackets.some(
            p =>
              p.portId === 'out-synth-a' &&
              p.bytes[0] === 0x95 &&
              p.bytes[1] === 36 &&
              p.bytes[2] > 0 &&
              (p.timestamp === null || p.timestamp <= now),
          );
          if (activeCount >= 1 && sounding808) {
            sawActiveAndPending = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 3));
        }

        (document.getElementById('fl-stop-btn') as HTMLButtonElement).click();
        const activeAfterStop = audioEngine.getActiveExternalMidiNoteCount();
        const packetCountAtStop = harness.sentPackets.length;

        await new Promise(resolve => setTimeout(resolve, 250));

        const synthPackets = harness.sentPackets.filter(p => p.portId === 'out-synth-a');
        const lateNoteOns = harness.sentPackets
          .slice(packetCountAtStop)
          .filter(p => (p.bytes[0] & 0xf0) === 0x90 && p.bytes[2] > 0);

        return {
          sawActiveAndPending,
          activeAfterStop,
          synthClearCount: harness.clearCounts['out-synth-a'],
          drumClearCount: harness.clearCounts['out-drum-b'],
          drumPacketCount: harness.sentPackets.filter(p => p.portId === 'out-drum-b').length,
          hasNoteOff808: synthPackets.some(p => p.bytes[0] === 0x85 && p.bytes[1] === 36),
          hasAllNotesOffCh6: synthPackets.some(p => p.bytes[0] === 0xb5 && p.bytes[1] === 123 && p.bytes[2] === 0),
          lateNoteOnsCount: lateNoteOns.length,
        };
      });

      expect(trialAudit.sawActiveAndPending).toBe(true);
      expect(trialAudit.activeAfterStop).toBe(0);
      expect(trialAudit.synthClearCount).toBeGreaterThanOrEqual(1);
      expect(trialAudit.hasNoteOff808).toBe(true);
      expect(trialAudit.hasAllNotesOffCh6).toBe(true);
      expect(trialAudit.drumClearCount).toBe(0);
      expect(trialAudit.drumPacketCount).toBe(0);
      expect(trialAudit.lateNoteOnsCount).toBe(0);
    });
  }
});
