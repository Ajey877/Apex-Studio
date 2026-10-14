/**
 * MIDI performance recording — browser workflow test.
 *
 * A deterministic SIMULATED Web MIDI input (the same fixture pattern as
 * midiControllerContrast.spec.ts) feeds raw note bytes through the app's
 * real production path: engine `handleMidiMessage` -> listener stream ->
 * live instrument bridge + `MidiPerformanceRecorder` (stamped from the
 * AudioContext transport) -> commit into `Channel.notes` on stop.
 *
 * What is simulated: the physical keyboard only. Timing/pitch/velocity
 * correctness of the capture itself is pinned deterministically in
 * src/audio/midiRecording.test.ts; here we assert the real UI workflow —
 * the target is identifiable before recording, the take is captured while
 * the transport runs, and stopping writes editable Piano Roll note blocks.
 * Physical-device validation still requires real hardware.
 */
import { expect, test, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

const installSimulatedMidiDevice = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const input = {
      id: 'midi-recording-test-input',
      name: 'Recording Test Keyboard',
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
    (window as unknown as { __midiRecordingInput: typeof input }).__midiRecordingInput = input;
  });
};

const sendMidi = async (page: Page, bytes: number[][]): Promise<void> => {
  await page.evaluate((messages: number[][]) => {
    const input = (window as unknown as {
      __midiRecordingInput: { onmidimessage: ((event: { data: Uint8Array }) => void) | null };
    }).__midiRecordingInput;
    if (!input.onmidimessage) throw new Error('simulated MIDI input has no listener');
    for (const data of messages) {
      input.onmidimessage({ data: new Uint8Array(data) });
    }
  }, bytes);
};

test.describe('MIDI recording into the Piano Roll', () => {
  test('simulated keyboard performance becomes editable Piano Roll notes', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await installSimulatedMidiDevice(page);
    await page.goto(APP_URL);
    await page.waitForSelector('#root > *', { state: 'attached' });
    await page.waitForTimeout(1200);

    // Open the Piano Roll: the recording target (channel · pattern) must be
    // identifiable before recording begins.
    await page.locator('#nav-piano-roll').click();
    const toggle = page.getByTestId('midi-record-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // The label names the actual target channel and pattern of the loaded
    // project (whatever they are called), in `Channel · Pattern` form.
    await expect(page.getByTestId('midi-record-target')).toContainText('·');
    const targetLabel = (await page.getByTestId('midi-record-target').innerText()).trim();
    expect(targetLabel.length).toBeGreaterThan(3);

    await page.waitForFunction(() => {
      const input = (window as unknown as {
        __midiRecordingInput?: { onmidimessage: unknown };
      }).__midiRecordingInput;
      return Boolean(input?.onmidimessage);
    });

    // Start the take (this also starts the transport) and play two
    // overlapping notes on the simulated keyboard.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await sendMidi(page, [[0x90, 60, 100]]); // C4 on, velocity 100
    await page.waitForTimeout(350);
    await sendMidi(page, [[0x90, 64, 80]]); // E4 on (overlap)
    await page.waitForTimeout(350);
    await sendMidi(page, [[0x80, 60, 0]]); // C4 off
    await sendMidi(page, [[0x90, 64, 0]]); // E4 off via velocity-zero note-on

    // Stopping the take commits real notes: Piano Roll note blocks appear.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    const recordedBlocks = page.locator('[id^="note-block-midi-rec-"]');
    await expect(recordedBlocks).toHaveCount(2);

    // The notes are ordinary editable Piano Roll data: select one.
    await recordedBlocks.first().click();
  });
});
