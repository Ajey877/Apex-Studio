/**
 * MIDI performance recording — browser workflow test.
 *
 * The second describe block pins transport-boundary integrity through the
 * real UI: Pause, Pattern/Song mode switch, playlist ruler seek and
 * transport Stop each close an active take immediately (record toggle
 * releases, the held gate becomes an ordinary note block whose width never
 * changes again, and later events cannot join the closed take). Exact step
 * positions for every boundary — including natural Song end, which needs a
 * seeded arrangement to reach quickly in a browser — are pinned
 * deterministically in src/audio/midiTransportBoundary.test.ts.
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
      type: 'input' as const,
      state: 'connected' as 'connected' | 'disconnected',
      onmidimessage: null as null | ((event: { data: Uint8Array }) => void),
    };
    const output = {
      id: 'midi-recording-test-output',
      name: 'Recording Test Output',
      type: 'output' as const,
      state: 'connected' as 'connected' | 'disconnected',
      onmidimessage: null as null | ((event: { data: Uint8Array }) => void),
    };
    const access = {
      inputs: new Map([[input.id, input]]),
      outputs: new Map([[output.id, output]]),
      onstatechange: null as null | ((event: { port: typeof input | typeof output }) => void),
    };
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: async () => access,
    });
    const target = window as unknown as {
      __midiRecordingInput: typeof input;
      __midiRecordingOutput: typeof output;
      __midiRecordingAccess: typeof access;
    };
    target.__midiRecordingInput = input;
    target.__midiRecordingOutput = output;
    target.__midiRecordingAccess = access;
  });
};

const changeMidiPortState = async (
  page: Page,
  portType: 'input' | 'output',
  state: 'connected' | 'disconnected',
): Promise<void> => {
  await page.evaluate(({ portType: nextType, state: nextState }) => {
    const target = window as unknown as {
      __midiRecordingInput: { state: 'connected' | 'disconnected'; onmidimessage: unknown };
      __midiRecordingOutput: { state: 'connected' | 'disconnected' };
      __midiRecordingAccess: {
        onstatechange: ((event: { port: unknown }) => void) | null;
      };
    };
    const port = nextType === 'input' ? target.__midiRecordingInput : target.__midiRecordingOutput;
    port.state = nextState;
    if (!target.__midiRecordingAccess.onstatechange) throw new Error('simulated MIDI access has no state-change listener');
    target.__midiRecordingAccess.onstatechange({ port });
    if (nextType === 'input' && nextState === 'disconnected') {
      target.__midiRecordingInput.onmidimessage = null;
    }
  }, { portType, state });
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

  test('input disconnect finalizes a held note once, releases it, and reconnects cleanly', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await installSimulatedMidiDevice(page);
    await page.goto(APP_URL);
    await page.waitForSelector('#root > *', { state: 'attached' });
    await page.waitForTimeout(1200);
    await page.locator('#nav-piano-roll').click();

    const toggle = page.getByTestId('midi-record-toggle');
    const target = page.getByTestId('midi-record-target');
    await expect(toggle).toBeVisible();
    const originalTarget = (await target.innerText()).trim();
    await page.waitForFunction(() => {
      const windowWithMidi = window as unknown as {
        __midiRecordingInput?: { onmidimessage: unknown };
        __midiRecordingAccess?: { onstatechange: unknown };
      };
      return Boolean(windowWithMidi.__midiRecordingInput?.onmidimessage && windowWithMidi.__midiRecordingAccess?.onstatechange);
    });

    const recordedBlocks = page.locator('[id^="note-block-midi-rec-"]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await sendMidi(page, [[0x90, 60, 100]]); // C4 on; deliberately no note-off
    await page.waitForTimeout(350);

    // An output disconnect is unrelated: it must not end the active input take.
    await changeMidiPortState(page, 'output', 'disconnected');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(recordedBlocks).toHaveCount(0);

    // The input disconnect is the capture boundary. The open gate must be
    // committed to the original selected channel/pattern immediately.
    await changeMidiPortState(page, 'input', 'disconnected');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(recordedBlocks).toHaveCount(1);
    await expect(target).toContainText(originalTarget);
    const widthAtDisconnect = await recordedBlocks.first().evaluate(element =>
      Number.parseFloat((element as HTMLElement).style.width),
    );
    expect(widthAtDisconnect).toBeGreaterThan(16);

    // The take is finalized at disconnect, not at some later user action: its
    // rendered gate width is immutable while the transport continues running.
    await page.waitForTimeout(650);
    const widthAfterDelay = await recordedBlocks.first().evaluate(element =>
      Number.parseFloat((element as HTMLElement).style.width),
    );
    expect(widthAfterDelay).toBe(widthAtDisconnect);

    // A duplicate notification for the same disconnected state cannot commit
    // another note. Reconnection reattaches the input for a fresh performance.
    await changeMidiPortState(page, 'input', 'disconnected');
    await expect(recordedBlocks).toHaveCount(1);
    await changeMidiPortState(page, 'input', 'connected');
    await page.waitForFunction(() => {
      const input = (window as unknown as {
        __midiRecordingInput?: { onmidimessage: unknown };
      }).__midiRecordingInput;
      return Boolean(input?.onmidimessage);
    });

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await sendMidi(page, [[0x90, 64, 90]]); // E4 on after reconnect
    await page.waitForTimeout(300);
    await sendMidi(page, [[0x80, 64, 0]]);
    await toggle.click(); // ordinary manual stop still finalizes correctly
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(recordedBlocks).toHaveCount(2);
  });
});

test.describe('MIDI takes end at transport boundaries', () => {
  // Opens the Piano Roll, arms a take, and holds C4 down. Returns the record
  // toggle and the recorded-block locator for boundary assertions.
  const armTakeWithHeldNote = async (page: Page) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await installSimulatedMidiDevice(page);
    await page.goto(APP_URL);
    await page.waitForSelector('#root > *', { state: 'attached' });
    await page.waitForTimeout(1200);
    await page.locator('#nav-piano-roll').click();
    const toggle = page.getByTestId('midi-record-toggle');
    await expect(toggle).toBeVisible();
    await page.waitForFunction(() => {
      const input = (window as unknown as {
        __midiRecordingInput?: { onmidimessage: unknown };
      }).__midiRecordingInput;
      return Boolean(input?.onmidimessage);
    });
    const recordedBlocks = page.locator('[id^="note-block-midi-rec-"]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await sendMidi(page, [[0x90, 60, 100]]); // C4 on; deliberately held
    await page.waitForTimeout(400);
    return { toggle, recordedBlocks };
  };

  const blockWidth = async (recordedBlocks: ReturnType<Page['locator']>): Promise<number> =>
    recordedBlocks.first().evaluate(element =>
      Number.parseFloat((element as HTMLElement).style.width),
    );

  // After a boundary the closed take is immutable: the physical key release
  // and fresh notes (monitored live, but no take is armed) change nothing.
  const expectClosedTakeImmutable = async (
    page: Page,
    recordedBlocks: ReturnType<Page['locator']>,
  ): Promise<void> => {
    const widthAtBoundary = await blockWidth(recordedBlocks);
    expect(widthAtBoundary).toBeGreaterThan(16);
    await sendMidi(page, [[0x80, 60, 0]]); // late release of the held key
    await sendMidi(page, [[0x90, 64, 90]]); // a new note after the boundary
    await page.waitForTimeout(300);
    await sendMidi(page, [[0x80, 64, 0]]);
    await expect(recordedBlocks).toHaveCount(1);
    expect(await blockWidth(recordedBlocks)).toBe(widthAtBoundary);
  };

  test('pause closes the held gate and resuming does not continue the take', async ({ page }) => {
    const { toggle, recordedBlocks } = await armTakeWithHeldNote(page);

    const playButton = page.locator('#fl-play-btn');
    await expect(playButton).toHaveAttribute('aria-label', 'Pause');
    await playButton.click(); // pause at the held note

    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(recordedBlocks).toHaveCount(1);
    await expect(playButton).toHaveAttribute('aria-label', 'Play');

    await playButton.click(); // resume: no take is armed anymore
    await expect(playButton).toHaveAttribute('aria-label', 'Pause');
    await expectClosedTakeImmutable(page, recordedBlocks);
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  });

  test('Pattern/Song mode switch closes the take before restarting playback', async ({ page }) => {
    const { toggle, recordedBlocks } = await armTakeWithHeldNote(page);

    const modeToggle = page.locator('#fl-playmode-toggle');
    await expect(modeToggle).toHaveAttribute('data-mode', 'pat');
    await modeToggle.click();

    await expect(modeToggle).toHaveAttribute('data-mode', 'song');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(recordedBlocks).toHaveCount(1);
    await expectClosedTakeImmutable(page, recordedBlocks);
  });

  test('playlist ruler seek closes the take at the pre-seek position', async ({ page }) => {
    const { toggle, recordedBlocks } = await armTakeWithHeldNote(page);

    await page.locator('#nav-playlist').click();
    await page.getByText('BAR 5', { exact: true }).click(); // seek far from bar 1
    await page.locator('#nav-piano-roll').click();

    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(recordedBlocks).toHaveCount(1);
    await expectClosedTakeImmutable(page, recordedBlocks);
  });

  test('transport Stop still finalizes the held note exactly once', async ({ page }) => {
    const { toggle, recordedBlocks } = await armTakeWithHeldNote(page);

    await page.locator('#fl-stop-btn').click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(recordedBlocks).toHaveCount(1);

    // Stopping again cannot commit the take a second time.
    await page.locator('#fl-stop-btn').click();
    await expect(recordedBlocks).toHaveCount(1);
    await expectClosedTakeImmutable(page, recordedBlocks);
  });
});
