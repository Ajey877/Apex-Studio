/**
 * Virtual MIDI input bridge — phone-sized browser workflow test.
 *
 * A user with NO physical/Web-MIDI hardware records a performance using the
 * on-screen Piano Roll virtual piano keys. The keys route note-on/note-off
 * through the shared `VirtualMidiInputBridge` into the SAME normalized event
 * path the hardware recorder consumes, so an armed take captures them.
 *
 * This is the real UI path (React pointer handlers -> bridge -> live monitor +
 * `MidiPerformanceRecorder`, stamped from the AudioContext transport). The
 * existing midiRecording.spec.ts covers the simulated-hardware path; here we
 * exercise the virtual-keyboard path specifically.
 *
 * Timing is real-time (not pinned to a fake clock), so we assert pitch exactly
 * and assert structural timing properties (notes are placed inside the pattern,
 * have positive duration, and are ordered by press time) rather than exact step
 * numbers.
 */
import { expect, test, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

const openPianoRoll = async (page: Page): Promise<void> => {
  await page.setViewportSize({ width: 390, height: 844 }); // phone-sized viewport
  await page.goto(APP_URL);
  await page.waitForSelector('#root > *', { state: 'attached' });
  await page.waitForTimeout(800);
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

// Press a virtual key for `holdMs` using a fresh pointer id, then release it.
const tapKey = async (
  page: Page,
  pitch: number,
  holdMs: number,
  pointerId: number,
): Promise<void> => {
  const sel = `#piano-key-${pitch}`;
  await page.dispatchEvent(sel, 'pointerdown', {
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    bubbles: true,
  });
  await page.waitForTimeout(holdMs);
  await page.dispatchEvent(sel, 'pointerup', {
    pointerId,
    pointerType: 'touch',
    isPrimary: true,
    button: 0,
    bubbles: true,
  });
};

const recordedBlocks = (page: Page) => page.locator('[id^="note-block-midi-rec-"]');
const blockLeftPx = (page: Page, id: string): Promise<number> =>
  page.locator(`#${id}`).evaluate((el) => parseFloat((el as HTMLElement).style.left) || 0);
const blockWidthPx = (page: Page, id: string): Promise<number> =>
  page.locator(`#${id}`).evaluate((el) => parseFloat((el as HTMLElement).style.width) || 0);
const blockName = (page: Page, id: string): Promise<string> =>
  page.locator(`#${id}`).evaluate((el) => (el.textContent ?? '').trim());

const keyName = (page: Page, pitch: number): Promise<string> =>
  page
    .locator(`#piano-key-${pitch}`)
    .locator('span')
    .first()
    .innerText();

test.describe('Virtual piano keyboard recording (phone viewport)', () => {
  test('armed take captures tapped virtual keys with the correct pitches', async ({ page }) => {
    await openPianoRoll(page);
    await armRecording(page);

    // Press C4 then E4 (distinct pitches), each held briefly.
    await tapKey(page, 60, 300, 1);
    await page.waitForTimeout(120);
    await tapKey(page, 64, 300, 2);

    await stopRecording(page);

    const blocks = recordedBlocks(page);
    await expect(blocks).toHaveCount(2);

    const ids = await blocks.evaluateAll((els) => els.map((el) => el.id));
    const names = new Set(await Promise.all(ids.map((id) => blockName(page, id))));

    // Pitches are deterministic: the take recorded exactly the two keys pressed.
    const expectedNames = new Set([await keyName(page, 60), await keyName(page, 64)]);
    expect(names).toEqual(expectedNames);

    // Structural timing: both notes sit inside the pattern with a real gate.
    for (const id of ids) {
      expect(await blockLeftPx(page, id)).toBeGreaterThanOrEqual(0);
      expect(await blockWidthPx(page, id)).toBeGreaterThan(0);
    }
    // And they are ordered by press time (C4 started before E4).
    const [firstId, secondId] = ids;
    expect(await blockLeftPx(page, firstId)).toBeLessThanOrEqual(
      await blockLeftPx(page, secondId),
    );
  });

  test('simultaneous keys record two overlapping notes with no stuck voices', async ({ page }) => {
    await openPianoRoll(page);
    await armRecording(page);

    // Hold two keys at once (different pointer ids), then release together.
    const sel60 = '#piano-key-60';
    const sel64 = '#piano-key-64';
    await page.dispatchEvent(sel60, 'pointerdown', { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, bubbles: true });
    await page.dispatchEvent(sel64, 'pointerdown', { pointerId: 2, pointerType: 'touch', isPrimary: true, button: 0, bubbles: true });
    await page.waitForTimeout(300);
    await page.dispatchEvent(sel60, 'pointerup', { pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, bubbles: true });
    await page.dispatchEvent(sel64, 'pointerup', { pointerId: 2, pointerType: 'touch', isPrimary: true, button: 0, bubbles: true });

    await stopRecording(page);

    const blocks = recordedBlocks(page);
    // Exactly two notes: no stuck/duplicate voice from the chord.
    await expect(blocks).toHaveCount(2);

    const ids = await blocks.evaluateAll((els) => els.map((el) => el.id));
    const names = new Set(await Promise.all(ids.map((id) => blockName(page, id))));
    const expectedNames = new Set([await keyName(page, 60), await keyName(page, 64)]);
    expect(names).toEqual(expectedNames);

    // Overlap: the two starts are within a short window (both held together).
    const lefts = await Promise.all(ids.map((id) => blockLeftPx(page, id)));
    expect(Math.abs(lefts[0] - lefts[1])).toBeLessThanOrEqual(
      await blockWidthPx(page, ids[0]),
    );
  });

  test('virtual keys do NOT record anything unless the take is armed', async ({ page }) => {
    await openPianoRoll(page);
    // No arming: just tap keys.
    await tapKey(page, 60, 200, 1);
    await tapKey(page, 64, 200, 2);
    await page.waitForTimeout(200);

    // No recorded note blocks exist without an armed take.
    await expect(recordedBlocks(page)).toHaveCount(0);
  });
});
