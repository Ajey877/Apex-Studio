import { expect, test } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

interface RecordedMidiPacket {
  portId: string;
  bytes: number[];
  timestamp: number | null;
  recordedAtPerfMs: number;
}

declare global {
  interface Window {
    __apexMidiTestHarness?: {
      sentPackets: RecordedMidiPacket[];
      clearCounts: Record<string, number>;
      openCounts: Record<string, number>;
      setOutputState: (portId: string, nextState: 'connected' | 'disconnected') => void;
      clearRecorded: () => void;
    };
  }
}

test.describe('Phase 1 External MIDI Output — Chromium E2E', () => {
  test('routes pattern playback to an instrumented MIDIOutput with real timestamps, cleanup, hot-unplug safety, undo/redo, and export truthfulness', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 960 });

    await page.addInitScript(() => {
      const sentPackets: RecordedMidiPacket[] = [];
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
              portId: id,
              bytes: Array.from(data),
              timestamp: typeof timestamp === 'number' ? timestamp : null,
              recordedAtPerfMs: performance.now(),
            });
          },
          clear() {
            clearCounts[id] = (clearCounts[id] || 0) + 1;
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
        value: () => Promise.resolve(access),
      });

      window.__apexMidiTestHarness = {
        sentPackets,
        clearCounts,
        openCounts,
        setOutputState(portId: string, nextState: 'connected' | 'disconnected') {
          const target = outputs.get(portId);
          if (!target) return;
          target.state = nextState;
          target.connection = nextState === 'connected' ? 'closed' : 'closed';
          if (typeof access.onstatechange === 'function') {
            access.onstatechange({ port: target });
          }
        },
        clearRecorded() {
          sentPackets.length = 0;
        },
      };
    });

    await page.goto(APP_URL);
    await page.waitForSelector('#root > *', { state: 'attached' });

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

    // 2. Configure ch-1 (808 Kick Sub, which has 4-on-the-floor steps on Pattern 1) -> External Only, Prophet-6, MIDI Ch 4
    const routingSection = midiDialog.getByTestId('channel-midi-output-routing');
    await expect(routingSection).toBeVisible();

    await routingSection.getByTestId('midi-out-mode-ch-1').selectOption('external');
    await routingSection.getByTestId('midi-out-device-ch-1').selectOption('out-synth-a');
    await routingSection.getByTestId('midi-out-channel-ch-1').selectOption('4');
    await expect(routingSection.getByTestId('midi-out-status-ch-1')).toContainText('Ready · Ch 4');

    // Close modal via dedicated close button (never Escape while <select> has focus)
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

    // 4. Stop transport and verify queued MIDI messages are cleared and cleaned up
    await page.locator('#fl-stop-btn').click();
    await expect
      .poll(async () => page.evaluate(() => window.__apexMidiTestHarness?.clearCounts['out-synth-a'] ?? 0))
      .toBeGreaterThanOrEqual(1);

    // 5. Verify hot-disconnect & reconnect honesty without silent output substitution
    await page.locator('#fl-midi-hub-btn').click();
    await expect(midiDialog).toBeVisible();

    await page.evaluate(() => window.__apexMidiTestHarness?.setOutputState('out-synth-a', 'disconnected'));
    await expect(midiDialog.getByTestId('midi-out-status-ch-1')).toContainText('Device Disconnected');
    await expect(midiDialog.getByTestId('midi-out-device-ch-1')).toHaveValue('out-synth-a');

    await page.evaluate(() => window.__apexMidiTestHarness?.setOutputState('out-synth-a', 'connected'));
    await expect(midiDialog.getByTestId('midi-out-status-ch-1')).toContainText('Ready · Ch 4');

    await midiDialog.locator('#close-midi-modal-btn').click();
    await expect(midiDialog).toBeHidden();

    // 6. Verify Undo / Redo of channel MIDI output routing
    await page.keyboard.press('Control+z');
    await page.locator('#fl-midi-hub-btn').click();
    await expect(midiDialog).toBeVisible();
    await expect(midiDialog.getByTestId('midi-out-channel-ch-1')).toHaveValue('1');
    await midiDialog.locator('#close-midi-modal-btn').click();
    await expect(midiDialog).toBeHidden();

    await page.keyboard.press('Control+y');
    await page.locator('#fl-midi-hub-btn').click();
    await expect(midiDialog).toBeVisible();
    await expect(midiDialog.getByTestId('midi-out-channel-ch-1')).toHaveValue('4');
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
});
