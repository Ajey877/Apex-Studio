/**
 * Computer-keyboard MIDI recording — browser workflow test.
 *
 * Playing the Piano Roll with the computer keyboard (A–K row) must feed the
 * SAME shared input path as hardware and the on-screen keys
 * (`MusicalKeyboardHeldNotes` -> `VirtualMidiInputBridge` -> live monitor +
 * `MidiPerformanceRecorder`), so an armed take captures the performance
 * with onset/duration following the actual key presses and releases. This
 * spec drives the real UI with real `KeyboardEvent`s (Playwright
 * `page.keyboard`), complementing the deterministic step-exact suite in
 * src/audio/computerKeyboardMidiInput.test.ts and the simulated-hardware
 * workflow in midiRecording.spec.ts.
 *
 * Timing is real-time, so pitch is asserted exactly (via the rendered note
 * names, read from the piano keys themselves) and duration structurally
 * (a long hold renders a wider block than a short tap).
 */
import { expect, test, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

const openPianoRoll = async (page: Page): Promise<void> => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(APP_URL);
  await page.waitForSelector('#root > *', { state: 'attached' });
  await expect(page.locator('#fl-orientation-lock-overlay')).toHaveCount(0);
  await page.waitForTimeout(400);
  await page.locator('#nav-piano-roll').click();
  await page.waitForSelector('#piano-key-60', { state: 'visible' });
};

const armRecording = async (page: Page): Promise<void> => {
  const toggle = page.getByTestId('midi-record-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
};

const stopRecording = async (page: Page): Promise<void> => {
  const toggle = page.getByTestId('midi-record-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
};

// Hold a computer-keyboard musical key for `holdMs`, then release it.
const holdKey = async (page: Page, key: string, holdMs: number): Promise<void> => {
  await page.keyboard.down(key);
  await page.waitForTimeout(holdMs);
  await page.keyboard.up(key);
};

const recordedBlocks = (page: Page) => page.locator('[id^="note-block-midi-rec-"]');

interface RecordedNote { name: string; left: number; width: number }

const recordedNotes = async (page: Page): Promise<RecordedNote[]> => {
  const data = await recordedBlocks(page).evaluateAll((els) =>
    els.map((el) => {
      const e = el as HTMLElement;
      return {
        name: (e.textContent ?? '').trim(),
        left: parseFloat(e.style.left) || 0,
        width: parseFloat(e.style.width) || 0,
      };
    }),
  );
  return data.sort((a, b) => a.left - b.left);
};

// Same note-name reader as virtualMidiInput.spec.ts: skip the decorative
// root dot and the "OCT" tag rendered inside the key button.
const keyName = (page: Page, pitch: number): Promise<string> =>
  page.locator(`#piano-key-${pitch}`).evaluate((el) => {
    const texts = [...el.querySelectorAll('span')]
      .map((s) => (s.textContent ?? '').trim())
      .filter((t) => t.length > 0 && t !== 'OCT');
    return texts[0] ?? '';
  });

test.describe('Computer-keyboard MIDI recording', () => {
  test('armed take captures A–K playing with hold-following durations', async ({ page }) => {
    await openPianoRoll(page);
    await armRecording(page);

    // KeyA = C4 (60) held long; KeyD = E4 (64) tapped short.
    await holdKey(page, 'a', 650);
    await page.waitForTimeout(120);
    await holdKey(page, 'd', 150);

    await stopRecording(page);

    await expect(recordedBlocks(page)).toHaveCount(2);
    const notes = await recordedNotes(page);
    const name60 = await keyName(page, 60);
    const name64 = await keyName(page, 64);
    expect(new Set(notes.map((n) => n.name))).toEqual(new Set([name60, name64]));

    // Duration follows the hold (not a fixed gate): the long-held C4 block
    // is wider than the short-tapped E4 block, and C4 started first.
    const c4 = notes.find((n) => n.name === name60)!;
    const e4 = notes.find((n) => n.name === name64)!;
    expect(c4.width).toBeGreaterThan(e4.width);
    expect(c4.left).toBeLessThanOrEqual(e4.left);
    for (const n of notes) expect(n.width).toBeGreaterThan(0);
  });

  test('octave shift while held releases the original pitch; re-press uses the new octave', async ({ page }) => {
    await openPianoRoll(page);
    await armRecording(page);

    await page.keyboard.down('a'); // C4 (60) at octave 0
    await page.waitForTimeout(300);
    await page.keyboard.press('x'); // octave +1 while A is still held
    await page.waitForTimeout(150);
    await page.keyboard.up('a'); // must release 60, not 72
    await page.waitForTimeout(120);
    await holdKey(page, 'a', 300); // now C5 (72)

    await stopRecording(page);

    await expect(recordedBlocks(page)).toHaveCount(2);
    const notes = await recordedNotes(page);
    const name60 = await keyName(page, 60);
    const name72 = await keyName(page, 72);
    expect(new Set(notes.map((n) => n.name))).toEqual(new Set([name60, name72]));
    // Performed order preserved: the C4 block starts no later than C5.
    const c4 = notes.find((n) => n.name === name60)!;
    const c5 = notes.find((n) => n.name === name72)!;
    expect(c4.left).toBeLessThanOrEqual(c5.left);
  });

  test('window blur releases a held key; the later keyup cannot duplicate the note', async ({ page }) => {
    await openPianoRoll(page);
    await armRecording(page);

    await page.keyboard.down('a');
    await page.waitForTimeout(350);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForTimeout(150);
    await page.keyboard.up('a'); // physical release after blur: must be inert

    await stopRecording(page);

    // Exactly one note: the gate closed at blur, nothing reopened/duplicated.
    await expect(recordedBlocks(page)).toHaveCount(1);
    const notes = await recordedNotes(page);
    expect(notes[0].name).toBe(await keyName(page, 60));
    expect(notes[0].width).toBeGreaterThan(0);
  });

  test('computer keyboard does NOT record unless the take is armed', async ({ page }) => {
    await openPianoRoll(page);
    await holdKey(page, 'a', 250);
    await holdKey(page, 'd', 250);
    await page.waitForTimeout(200);
    await expect(recordedBlocks(page)).toHaveCount(0);
  });
});
