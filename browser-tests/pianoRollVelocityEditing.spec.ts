import { expect, test, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';
const CHANNEL_ID = 'ch-kick';

const velocityStalk = (page: Page, noteId: string) =>
  page.locator(`#piano-roll-container [data-velocity-note-id="${noteId}"]`);

const openPianoRoll = async (page: Page): Promise<void> => {
  await page.goto(APP_URL);
  await page.waitForSelector('#root > *', { state: 'attached' });
  await expect(page.locator('#fl-orientation-lock-overlay')).toHaveCount(0);
  await page.locator('#nav-piano-roll').click();
  await expect(page.locator('#piano-roll-container')).toBeVisible();
  await expect(page.getByTestId('piano-roll-velocity-lane')).toBeVisible();
  await expect(velocityStalk(page, 'n1')).toBeVisible();
};

/** Pointer coordinates on a stalk, with `velocity` measured from the cell bottom. */
const pointForVelocity = async (
  page: Page,
  noteId: string,
  velocity: number,
): Promise<{ x: number; y: number }> => {
  const stalk = velocityStalk(page, noteId);
  const stalkBox = await stalk.boundingBox();
  const cellBox = await stalk.locator('xpath=..').boundingBox();
  if (!stalkBox || !cellBox) throw new Error(`Velocity stalk ${noteId} has no visible box`);
  return {
    x: stalkBox.x + stalkBox.width / 2,
    y: cellBox.y + cellBox.height * (1 - velocity),
  };
};

const displayedVelocity = async (page: Page, noteId: string): Promise<number> =>
  velocityStalk(page, noteId).evaluate(element => Number.parseFloat((element as HTMLElement).style.height) / 100);

const readSavedVelocity = async (page: Page, noteId: string): Promise<number | null> =>
  page.evaluate(async ({ channelId, targetNoteId }) => {
    // @ts-ignore — served by Vite in the browser workflow
    const persistence: any = await import('/src/audio/audioPersistence.ts');
    const serialized: string | null = await persistence.getPersistedProjectStateRecord();
    if (!serialized) return null;
    const state = JSON.parse(serialized).state;
    const channel = state.channels.find((candidate: any) => candidate.id === channelId);
    return channel?.notes.find((note: any) => note.id === targetNoteId)?.velocity ?? null;
  }, { channelId: CHANNEL_ID, targetNoteId: noteId });

const waitForSavedDisplayedVelocity = async (page: Page, noteId: string): Promise<number> => {
  const shown = await displayedVelocity(page, noteId);
  await expect.poll(async () => {
    const saved = await readSavedVelocity(page, noteId);
    return typeof saved === 'number' && Math.round(saved * 100) === Math.round(shown * 100);
  }, { timeout: 15_000, intervals: [50, 100, 250] }).toBe(true);
  return (await readSavedVelocity(page, noteId))!;
};

const noteGeometry = async (page: Page, noteId: string) =>
  page.locator(`#note-block-${noteId}`).evaluate(element => {
    const note = element as HTMLElement;
    return { left: note.style.left, width: note.style.width, selected: note.classList.contains('ring-2') };
  });

test.describe('Piano Roll velocity editing', () => {
  test('click edits the intended note and saved, exported, and played velocity agree', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await openPianoRoll(page);
    // Seed the browser's IndexedDB record before comparing UI edits with the
    // persisted project; a fresh test context starts with no saved document.
    await page.keyboard.press('Control+s');
    await expect.poll(async () => (await readSavedVelocity(page, 'n2')) === 0.9, { timeout: 10_000 }).toBe(true);
    const before = await readSavedVelocity(page, 'n2');
    expect(before).toBeCloseTo(0.9, 2);

    const target = await pointForVelocity(page, 'n2', 0.35);
    await page.mouse.click(target.x, target.y);

    const shown = await displayedVelocity(page, 'n2');
    const saved = await waitForSavedDisplayedVelocity(page, 'n2');
    expect(shown).toBeCloseTo(0.35, 1);
    expect(saved).toBeCloseTo(shown, 2);
    expect(await readSavedVelocity(page, 'n1')).toBeCloseTo(1, 2);
    expect(await readSavedVelocity(page, 'n3')).toBeCloseTo(0.95, 2);

    const exportedVelocity = await page.evaluate(async ({ channelId, noteId }) => {
      // @ts-ignore — production Piano Roll export helper
      const { buildPianoRollMidiExport } = await import('/src/components/PianoRoll.tsx');
      // @ts-ignore — production MIDI parser
      const { MidiParser } = await import('/src/utils/midiParser.ts');
      // @ts-ignore — persisted source of truth
      const persistence: any = await import('/src/audio/audioPersistence.ts');
      const serialized: string = await persistence.getPersistedProjectStateRecord();
      const state = JSON.parse(serialized).state;
      const channel = state.channels.find((candidate: any) => candidate.id === channelId);
      const blob: Blob = buildPianoRollMidiExport(channel.notes, state.meta.bpm, channel.name);
      const tracks = await MidiParser.parseMidiFile(await blob.arrayBuffer());
      return tracks.flatMap((track: any) => track.notes)
        .find((note: any) => Math.abs(note.startStep - 6) < 0.01)?.velocity ?? null;
    }, { channelId: CHANNEL_ID, noteId: 'n2' });
    expect(exportedVelocity).not.toBeNull();
    expect(exportedVelocity!).toBeCloseTo(Math.round(saved * 127) / 127, 3);

    // Play a fresh take after editing and observe the real scheduler's Note
    // object. This proves the state published by the stalk is the value playback
    // consumes, not merely a changed decoration in the lane.
    await page.evaluate(async () => {
      // @ts-ignore — shared production singleton used by App and the scheduler
      const { audioEngine } = await import('/src/audio/audioEngine.ts');
      const original = audioEngine.playNote.bind(audioEngine);
      const trace: number[] = [];
      (window as any).__velocityPlaybackTrace = trace;
      (window as any).__restoreVelocityPlaybackTrace = () => {
        audioEngine.playNote = original;
      };
      audioEngine.playNote = ((channel: any, note: any, ...args: any[]) => {
        if (note.id === 'n2') trace.push(note.velocity);
        return original(channel, note, ...args);
      }) as any;
    });

    await page.locator('#fl-play-btn').click();
    await expect.poll(() => page.evaluate(() => (window as any).__velocityPlaybackTrace?.length ?? 0), {
      timeout: 5_000,
      intervals: [50, 100, 250],
    }).toBeGreaterThan(0);
    const played = await page.evaluate(() => (window as any).__velocityPlaybackTrace as number[]);
    await page.locator('#fl-play-btn').click();
    await page.evaluate(() => (window as any).__restoreVelocityPlaybackTrace?.());
    expect(played.some(velocity => Math.abs(velocity - saved) < 1e-8)).toBe(true);
  });

  test('drag continuously edits each crossed note, leaves grid geometry alone, and is one undo/redo step', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await openPianoRoll(page);
    const initial = {
      n1: await displayedVelocity(page, 'n1'),
      n2: await displayedVelocity(page, 'n2'),
      n3: await displayedVelocity(page, 'n3'),
    };
    const geometry = {
      n1: await noteGeometry(page, 'n1'),
      n2: await noteGeometry(page, 'n2'),
      n3: await noteGeometry(page, 'n3'),
    };

    const start = await pointForVelocity(page, 'n1', 0.3);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (const [noteId, velocity] of [['n2', 0.55], ['n3', 0.2]] as const) {
      const next = await pointForVelocity(page, noteId, velocity);
      await page.mouse.move(next.x, next.y, { steps: 3 });
    }
    await page.mouse.up();

    const edited = {
      n1: await displayedVelocity(page, 'n1'),
      n2: await displayedVelocity(page, 'n2'),
      n3: await displayedVelocity(page, 'n3'),
    };
    expect(edited.n1).toBeCloseTo(0.3, 1);
    expect(edited.n2).toBeCloseTo(0.55, 1);
    expect(edited.n3).toBeCloseTo(0.2, 1);
    for (const noteId of ['n1', 'n2', 'n3']) {
      const after = await noteGeometry(page, noteId);
      expect(after.left, `${noteId} did not move in the note grid`).toBe(geometry[noteId as keyof typeof geometry].left);
      expect(after.width, `${noteId} did not resize in the note grid`).toBe(geometry[noteId as keyof typeof geometry].width);
      expect(after.selected, `${noteId} was not selected by the velocity drag`).toBe(geometry[noteId as keyof typeof geometry].selected);
    }

    await page.keyboard.press('Control+z');
    await expect.poll(async () => ({
      n1: await displayedVelocity(page, 'n1'),
      n2: await displayedVelocity(page, 'n2'),
      n3: await displayedVelocity(page, 'n3'),
    })).toEqual(initial);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(async () => ({
      n1: await displayedVelocity(page, 'n1'),
      n2: await displayedVelocity(page, 'n2'),
      n3: await displayedVelocity(page, 'n3'),
    })).toEqual(edited);
  });

  test('release outside the lane cleans up and cannot move/select a grid note', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await openPianoRoll(page);
    const targetNote = page.locator('#note-block-n1');
    await targetNote.scrollIntoViewIfNeeded();
    const beforeGrid = await noteGeometry(page, 'n1');
    const start = await pointForVelocity(page, 'n1', 0.4);

    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    const gridBox = await targetNote.boundingBox();
    if (!gridBox) throw new Error('The note-grid target is not visible');
    await page.mouse.move(gridBox.x + gridBox.width / 2, gridBox.y + gridBox.height / 2, { steps: 4 });
    const velocityAtRelease = await displayedVelocity(page, 'n1');
    await page.mouse.up();

    const afterGrid = await noteGeometry(page, 'n1');
    expect(afterGrid.left).toBe(beforeGrid.left);
    expect(afterGrid.width).toBe(beforeGrid.width);
    expect(afterGrid.selected).toBe(beforeGrid.selected);
    expect(velocityAtRelease).toBeGreaterThanOrEqual(0.05);
    expect(velocityAtRelease).toBeLessThanOrEqual(1);
    expect(await displayedVelocity(page, 'n1')).toBeCloseTo(velocityAtRelease, 2);

    // A second interaction must begin normally; a missed outside release would
    // leave the first pointer session active and swallow this edit.
    const next = await pointForVelocity(page, 'n2', 0.6);
    await page.mouse.click(next.x, next.y);
    expect(await displayedVelocity(page, 'n2')).toBeCloseTo(0.6, 1);
  });

  test('selection rerenders and stationary horizontal scrolling do not retarget a held edit', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await openPianoRoll(page);
    const scroller = page.locator('#piano-roll-container div.flex-1.overflow-auto.custom-scrollbar').first();
    await scroller.evaluate(element => { (element as HTMLElement).scrollLeft = 0; });

    // Change selection first to force a render, then edit by note id.
    const selectedGridNote = page.locator('#note-block-n2');
    await selectedGridNote.scrollIntoViewIfNeeded();
    await selectedGridNote.click();
    expect((await noteGeometry(page, 'n2')).selected).toBe(true);

    const start = await pointForVelocity(page, 'n2', 0.4);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    const scrollMetrics = await scroller.evaluate(element => {
      const node = element as HTMLElement;
      return { current: node.scrollLeft, max: node.scrollWidth - node.clientWidth };
    });
    expect(scrollMetrics.max).toBeGreaterThanOrEqual(112);
    await scroller.evaluate((element, next) => { (element as HTMLElement).scrollLeft = next; }, Math.min(scrollMetrics.current + 112, scrollMetrics.max));
    await page.mouse.up();

    expect(await displayedVelocity(page, 'n2')).toBeCloseTo(0.4, 1);
    expect(await displayedVelocity(page, 'n3')).toBeCloseTo(0.95, 2);
    expect((await noteGeometry(page, 'n2')).selected).toBe(true);
    const saved = await waitForSavedDisplayedVelocity(page, 'n2');
    expect(saved).toBeCloseTo(0.4, 1);
  });
});
