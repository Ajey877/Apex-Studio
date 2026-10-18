import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Independent patterns — end-to-end in real Chromium.
 *
 * Pre-fix (reproduced against the shipped demo before this change): the
 * Channel Rack showed ONE shared set of channel content for every pattern tab.
 * "Add pattern" created a pattern that already contained the whole beat,
 * toggling a step in it removed that step from "Main Groove", and the playlist
 * had no way to place a different pattern for the same instrument.
 *
 * These specs drive the real UI and the real production audio engine:
 *  1. Channel Rack: a new pattern is empty, edits stay in their pattern, clone
 *     copies exactly, and everything survives an autosave + page reload.
 *  2. Playlist: drawn clips play the selected pattern, existing demo clips keep
 *     playing the pattern they played, and a clip can be re-targeted.
 *  3. Audio: the production offline renderer (the same scheduler as live Song
 *     Mode) renders a Verse | Chorus | Empty arrangement of ONE channel as three
 *     audibly different bars, in a real OfflineAudioContext.
 *  4. History: selecting a pattern is a view change, never an undo step. Undo
 *     and Redo of an edit made after a selection keep that pattern selected and
 *     restore its exact content, and no later no-op commit (a click on a
 *     playlist clip) can record a selection-only undo step.
 */

const APP_URL = 'http://localhost:3000';

const rack = (page: Page): Locator => page.locator('#fl-channel-rack');

/** Ids of the active step cells currently shown in the Channel Rack. */
const activeStepIds = async (page: Page): Promise<string[]> =>
  rack(page).locator('button[id^="step-"]').evaluateAll(cells =>
    cells.filter(cell => cell.className.includes('apex-step-active')).map(cell => cell.id));

const patternTabs = (page: Page): Locator => rack(page).locator('button[id^="pattern-tab-"]');

const selectTab = async (page: Page, label: string): Promise<void> => {
  const tab = patternTabs(page).filter({ hasText: new RegExp(`^${label}$`, 'i') });
  await tab.click();
  await expect(tab).toHaveAttribute('aria-pressed', 'true');
};

const openRack = async (page: Page): Promise<void> => {
  await page.locator('#nav-channel-rack').click();
  await expect(rack(page)).toBeVisible();
  await expect(patternTabs(page).first()).toBeVisible();
};

/** Waits until the autosaved IndexedDB record satisfies `predicate`. */
const waitForPersistedProject = async (
  page: Page,
  predicate: string,
): Promise<void> => {
  await expect.poll(async () => page.evaluate(async (source) => {
    // @ts-ignore — resolved by the Vite dev server
    const persistence: any = await import('/src/audio/audioPersistence.ts');
    const json: string | null = await persistence.getPersistedProjectStateRecord();
    if (!json) return false;
    const state = JSON.parse(json).state;
    // eslint-disable-next-line no-new-func
    return Boolean(new Function('state', `return (${source});`)(state));
  }, predicate), { timeout: 10_000 }).toBe(true);
};

test.describe('Independent patterns in the Channel Rack', () => {
  test('a new pattern is empty, edits stay in their pattern, clone copies, and all of it survives a reload', async ({ page }) => {
    await page.goto(APP_URL);
    await openRack(page);

    await selectTab(page, 'Main Groove');
    const mainGroove = await activeStepIds(page);
    expect(mainGroove.length, 'the demo groove has content').toBeGreaterThan(10);
    expect(mainGroove).toContain('step-ch-kick-0');

    // AC1 — Add pattern: the new pattern starts EMPTY.
    await rack(page).locator('#add-pattern-btn').click();
    const newTab = patternTabs(page).last();
    await expect(newTab).toHaveText(/PATTERN 4/i);
    await expect(newTab).toHaveAttribute('aria-pressed', 'true');
    expect(await activeStepIds(page)).toEqual([]);

    // AC2 — edits in Pattern 4 stay in Pattern 4.
    await rack(page).locator('#step-ch-kick-2').click();
    await rack(page).locator('#step-ch-snare-6').click();
    expect(await activeStepIds(page)).toEqual(['step-ch-kick-2', 'step-ch-snare-6']);

    await selectTab(page, 'Main Groove');
    expect(await activeStepIds(page), 'Main Groove is untouched by the Pattern 4 edit').toEqual(mainGroove);

    await selectTab(page, 'Pattern 4');
    expect(await activeStepIds(page)).toEqual(['step-ch-kick-2', 'step-ch-snare-6']);

    // AC3 — Clone: an exact, independent copy.
    await selectTab(page, 'Main Groove');
    await rack(page).locator('#clone-pattern-btn').click();
    const cloneTab = patternTabs(page).last();
    await expect(cloneTab).toHaveText(/MAIN GROOVE \(COPY\)/i);
    await expect(cloneTab).toHaveAttribute('aria-pressed', 'true');
    expect(await activeStepIds(page)).toEqual(mainGroove);
    await rack(page).locator('#step-ch-kick-0').click();
    expect(await activeStepIds(page)).not.toContain('step-ch-kick-0');
    await selectTab(page, 'Main Groove');
    expect(await activeStepIds(page), 'editing the clone leaves its source alone').toEqual(mainGroove);

    // AC6 — autosave + reload keeps every pattern exact.
    await waitForPersistedProject(page, `state.patterns.length === 5 && state.selectedPatternId === 'pat-1'
      && state.patterns.filter(p => Array.isArray(p.channelContent)).length === 4`);
    await page.reload();
    await openRack(page);
    await expect(patternTabs(page)).toHaveCount(5);
    await selectTab(page, 'Main Groove');
    expect(await activeStepIds(page)).toEqual(mainGroove);
    await selectTab(page, 'Pattern 4');
    expect(await activeStepIds(page)).toEqual(['step-ch-kick-2', 'step-ch-snare-6']);
    await selectTab(page, 'Main Groove \\(copy\\)');
    expect(await activeStepIds(page)).toEqual(mainGroove.filter(id => id !== 'step-ch-kick-0'));
  });

  test('undo restores the pattern that was edited', async ({ page }) => {
    await page.goto(APP_URL);
    await openRack(page);
    await rack(page).locator('#add-pattern-btn').click();
    await rack(page).locator('#step-ch-hihat-3').click();
    expect(await activeStepIds(page)).toEqual(['step-ch-hihat-3']);
    await page.keyboard.press('Control+z');
    await expect.poll(() => activeStepIds(page)).toEqual([]);
    await page.keyboard.press('Control+z');
    // Undoing "Add pattern" removes Pattern 4 and restores Main Groove's content.
    await expect(patternTabs(page)).toHaveCount(3);
    await selectTab(page, 'Main Groove');
    expect(await activeStepIds(page)).toContain('step-ch-kick-0');
  });
});

/**
 * Review follow-up — pattern selection and undo/redo.
 *
 * Reproduced against PR #243 head 7e53c86: selecting a pattern swapped the live
 * content but left project history's present at the pre-selection snapshot, so
 * the next edit was committed against it. Undoing an edit made in Pattern 2
 * jumped back to Pattern 1 (whose different content then hid the undo), and a
 * plain click on a playlist clip after a selection recorded an undo step whose
 * only effect was to switch the pattern back.
 */
const expectSelectedPattern = async (page: Page, label: string): Promise<void> => {
  const tab = patternTabs(page).filter({ hasText: new RegExp(`^${label}$`, 'i') });
  await expect(tab, `${label} is the selected pattern`).toHaveAttribute('aria-pressed', 'true');
  await expect(patternTabs(page).and(page.locator('[aria-pressed="true"]'))).toHaveCount(1);
};

const noteBlockIds = async (page: Page): Promise<string[]> =>
  page.locator('#piano-roll-container [id^="note-block-"]').evaluateAll(nodes => nodes.map(node => node.id).sort());

test.describe('Pattern selection is not an undo step', () => {
  test('Select Pattern 2 -> edit steps -> Undo -> Redo keeps Pattern 2 selected and restores its content', async ({ page }) => {
    await page.goto(APP_URL);
    await openRack(page);
    await expectSelectedPattern(page, 'Main Groove');
    const mainGroove = await activeStepIds(page);
    expect(mainGroove).toContain('step-ch-kick-0');

    // 1. Select Pattern 2 (the demo's "Melody & Pluck").
    await selectTab(page, 'Melody & Pluck');
    const pattern2Before = await activeStepIds(page);

    // 2. Edit its steps.
    await rack(page).locator('#step-ch-kick-0').click();
    const pattern2Edited = pattern2Before.filter(id => id !== 'step-ch-kick-0');
    await expect.poll(() => activeStepIds(page)).toEqual(pattern2Edited);

    // 3. Undo: Pattern 2 stays selected and gets its pre-edit content back.
    await page.keyboard.press('Control+z');
    await expectSelectedPattern(page, 'Melody & Pluck');
    await expect.poll(() => activeStepIds(page)).toEqual(pattern2Before);

    // 4. Redo: Pattern 2 stays selected and gets its edit back.
    await page.keyboard.press('Control+Shift+z');
    await expectSelectedPattern(page, 'Melody & Pluck');
    await expect.poll(() => activeStepIds(page)).toEqual(pattern2Edited);

    // Data integrity: Pattern 1 never changed, Pattern 2 keeps its edit.
    await selectTab(page, 'Main Groove');
    expect(await activeStepIds(page)).toEqual(mainGroove);
    await selectTab(page, 'Melody & Pluck');
    expect(await activeStepIds(page)).toEqual(pattern2Edited);
  });

  test('Select Pattern 2 -> draw a Piano Roll note -> Undo -> Redo keeps Pattern 2 selected and restores its notes', async ({ page }) => {
    await page.goto(APP_URL);
    await openRack(page);
    await selectTab(page, 'Melody & Pluck');

    await page.locator('#nav-piano-roll').click();
    const roll = page.locator('#piano-roll-container');
    await expect(roll).toBeVisible();
    const target = page.getByTestId('midi-record-target');
    await expect(target).toContainText('Melody & Pluck');
    const notesBefore = await noteBlockIds(page);

    await roll.getByTitle('Draw Note (Pencil)').click();
    await roll.locator('div.cursor-pointer[data-step="15"]').first().click();
    await expect.poll(async () => (await noteBlockIds(page)).length).toBe(notesBefore.length + 1);
    const notesDrawn = await noteBlockIds(page);

    await page.keyboard.press('Control+z');
    await expect(target, 'Undo keeps the edited pattern selected').toContainText('Melody & Pluck');
    await expect.poll(() => noteBlockIds(page)).toEqual(notesBefore);

    await page.keyboard.press('Control+Shift+z');
    await expect(target, 'Redo keeps the edited pattern selected').toContainText('Melody & Pluck');
    await expect.poll(() => noteBlockIds(page)).toEqual(notesDrawn);

    // Data integrity: Main Groove's notes never changed; Pattern 2 keeps the note.
    await openRack(page);
    await selectTab(page, 'Main Groove');
    await page.locator('#nav-piano-roll').click();
    await expect(target).toContainText('Main Groove');
    expect(await noteBlockIds(page)).toEqual(notesBefore);
    await openRack(page);
    await selectTab(page, 'Melody & Pluck');
    await page.locator('#nav-piano-roll').click();
    await expect(target).toContainText('Melody & Pluck');
    expect(await noteBlockIds(page)).toEqual(notesDrawn);
  });

  test('undo after switching patterns shows the pattern the undone edit was made in', async ({ page }) => {
    await page.goto(APP_URL);
    await openRack(page);
    const mainGroove = await activeStepIds(page);

    // Give Pattern 2 its own content (an undoable edit made in Pattern 2)...
    await selectTab(page, 'Melody & Pluck');
    await rack(page).locator('#step-ch-kick-0').click();
    const pattern2Edited = mainGroove.filter(id => id !== 'step-ch-kick-0');
    await expect.poll(() => activeStepIds(page)).toEqual(pattern2Edited);

    // ...then switch to Main Groove and edit it.
    await selectTab(page, 'Main Groove');
    expect(await activeStepIds(page)).toEqual(mainGroove);
    const offStep = ['step-ch-kick-1', 'step-ch-kick-2', 'step-ch-kick-3', 'step-ch-kick-5'].find(id => !mainGroove.includes(id));
    expect(offStep, 'the demo kick has an empty step to fill').toBeTruthy();
    await rack(page).locator(`#${offStep}`).click();
    const mainEdited = [...mainGroove, offStep as string].sort();
    await expect.poll(async () => (await activeStepIds(page)).sort()).toEqual(mainEdited);

    // Undo reverts the Main Groove edit and shows Main Groove, not Pattern 2.
    await page.keyboard.press('Control+z');
    await expectSelectedPattern(page, 'Main Groove');
    await expect.poll(() => activeStepIds(page)).toEqual(mainGroove);

    await page.keyboard.press('Control+Shift+z');
    await expectSelectedPattern(page, 'Main Groove');
    await expect.poll(async () => (await activeStepIds(page)).sort()).toEqual(mainEdited);

    // Pattern 2 kept its own edit throughout.
    await selectTab(page, 'Melody & Pluck');
    expect(await activeStepIds(page)).toEqual(pattern2Edited);
  });

  test('a selection never becomes an undo step of its own', async ({ page }) => {
    await page.goto(APP_URL);
    await openRack(page);
    await selectTab(page, 'Melody & Pluck');

    await page.locator('#nav-playlist').click();
    const arranger = page.locator('#fl-playlist-arranger');
    await expect(arranger).toBeVisible();
    const undoButton = arranger.getByTitle('Undo playlist edit');
    const picker = arranger.locator('#playlist-pattern-picker');
    await expect(picker.locator('option:checked')).toHaveText('Melody & Pluck');
    await expect(undoButton, 'a fresh project has nothing to undo').toBeDisabled();

    // Select a demo clip without moving it: a playlist interaction that changes nothing.
    await arranger.locator('[data-clip-id="clip-1"]').click();
    await expect(undoButton, 'clicking a clip after a selection records no undo step').toBeDisabled();

    // Pattern selection from the playlist picker is not undoable either.
    await picker.selectOption({ label: 'Hi-Hat Rolls' });
    await expect(picker.locator('option:checked')).toHaveText('Hi-Hat Rolls');
    await arranger.locator('[data-clip-id="clip-1"]').click();
    await expect(undoButton).toBeDisabled();
    await page.keyboard.press('Control+z');
    await expect(picker.locator('option:checked'), 'Undo never reverts a selection on its own').toHaveText('Hi-Hat Rolls');
  });
});

test.describe('Independent patterns in the Playlist', () => {
  test('drawn clips play the selected pattern; demo clips keep theirs; clips can be re-targeted', async ({ page }) => {
    await page.goto(APP_URL);
    await openRack(page);
    await rack(page).locator('#add-pattern-btn').click();
    await expect(patternTabs(page).last()).toHaveText(/PATTERN 4/i);

    await page.locator('#nav-playlist').click();
    const arranger = page.locator('#fl-playlist-arranger');
    await expect(arranger).toBeVisible();

    // The picker names the selected pattern; the demo clips still say what they play.
    const picker = arranger.locator('#playlist-pattern-picker');
    await expect(picker).toBeVisible();
    await expect(picker.locator('option:checked')).toHaveText('Pattern 4');
    await expect(arranger.locator('[data-testid="clip-pattern-clip-1"]')).toHaveText('Main Groove');

    // Draw a clip on lane 0, bar 12: it plays Pattern 4.
    const before = await arranger.locator('[data-clip-id]').count();
    await arranger.locator('[data-playlist-cell="0:12"]').click();
    await expect(arranger.locator('[data-clip-id]')).toHaveCount(before + 1);
    const newClipId = await arranger.locator('[data-clip-id]').evaluateAll(
      (nodes, known) => nodes.map(node => node.getAttribute('data-clip-id')).find(id => id && !(known as string[]).includes(id)),
      ['clip-1', 'clip-2', 'clip-3', 'clip-4', 'clip-5', 'clip-6', 'clip-7'],
    );
    expect(newClipId).toBeTruthy();
    const badge = arranger.locator(`[data-testid="clip-pattern-${newClipId}"]`);
    await expect(badge).toHaveText('All instruments');
    await expect(badge).toHaveAttribute('title', /Whole pattern: Pattern 4/);
    // The clip preview draws the content the clip plays: Pattern 4 is still
    // empty, while the demo kick clip shows Main Groove's kick hits.
    const newPreview = arranger.locator(`[data-testid="clip-steps-${newClipId}"]`);
    await expect(newPreview).toHaveAttribute('data-active-steps', '');
    const demoKickSteps = await arranger.locator('[data-testid="clip-steps-clip-1"]').getAttribute('data-active-steps');
    expect(demoKickSteps?.split(',')).toContain('0');

    // Choosing another pattern in the picker changes what the NEXT clip plays.
    await picker.selectOption({ label: 'Hi-Hat Rolls' });
    await expect(picker.locator('option:checked')).toHaveText('Hi-Hat Rolls');
    await expect(badge, 'an existing clip keeps its pattern').toHaveAttribute('title', /Whole pattern: Pattern 4/);

    // Re-target the drawn clip from the selected-clip inspector.
    await arranger.locator(`[data-clip-id="${newClipId}"]`).click();
    const clipPattern = page.locator('#selected-clip-pattern');
    await expect(clipPattern.locator('option:checked')).toHaveText('Pattern 4');
    await clipPattern.selectOption({ label: 'Melody & Pluck' });
    await expect(badge).toHaveAttribute('title', /Whole pattern: Melody & Pluck/);
    // Melody & Pluck holds the demo's (migrated) content, so the re-targeted clip
    // now previews the same kick hits as the demo kick clip.
    await expect(newPreview).toHaveAttribute('data-active-steps', Array.from({ length: 16 }, (_, i) => i).join(','));
  });
});

test.describe('Independent patterns are audible in the production renderer', () => {
  test('one channel renders Verse | Chorus | Empty as three different bars', async ({ page }) => {
    await page.goto(APP_URL);
    const result = await page.evaluate(async () => {
      // @ts-ignore — resolved by the Vite dev server
      const engineModule: any = await import('/src/audio/audioEngine.ts');
      // @ts-ignore
      const patternModule: any = await import('/src/state/patternContent.ts');
      const engine = engineModule.audioEngine;
      const synthParams = { ...engine.getDefaultSynthParams(), osc1Type: 'sine', osc1Mix: 1, osc2Mix: 0 };
      const channel = {
        id: 'ch-lead', name: 'Lead', color: '#10b981', instrumentType: 'minisynth',
        mixerTrackId: 1, volume: 0.9, pan: 0, pitch: 0, mute: false, solo: false,
        steps: Array(16).fill(false),
        // Verse (selected pattern -> live channel content): C4 for most of the bar.
        notes: [{ id: 'v1', pitch: 60, start: 0, duration: 12, velocity: 0.9 }],
        synthParams,
      };
      let state: any = {
        patterns: [{ id: 'pat-verse', name: 'Verse', color: '#f00', lengthSteps: 16 }],
        selectedPatternId: 'pat-verse',
        channels: [channel],
        playlistClips: [],
      };
      // Build the Chorus and an Empty pattern through the production transitions.
      state = patternModule.addEmptyPatternToProjectState(state, { id: 'pat-chorus', name: 'Chorus', color: '#0f0', lengthSteps: 16 });
      state = { ...state, channels: state.channels.map((c: any) => ({ ...c, notes: [{ id: 'c1', pitch: 72, start: 0, duration: 12, velocity: 0.9 }] })) };
      state = patternModule.addEmptyPatternToProjectState(state, { id: 'pat-empty', name: 'Empty', color: '#00f', lengthSteps: 16 });
      state = patternModule.selectPatternInProjectState(state, 'pat-verse');

      const clip = (id: string, startBar: number, patternId: string) => ({
        id, trackIndex: 0, startBar, lengthBars: 1, type: 'pattern', channelId: 'ch-lead', color: '#fff', name: id, patternId,
      });
      const clips = [clip('a', 0, 'pat-verse'), clip('b', 1, 'pat-chorus'), clip('c', 2, 'pat-empty')];
      const mixerTracks = [
        { id: 0, name: 'Master', color: '#fff', volume: 1, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
        { id: 1, name: 'Lead', color: '#fff', volume: 1, pan: 0, mute: false, solo: false, stereoWidth: 1, peakL: 0, peakR: 0, fxSlots: [] },
      ];

      const analyse = (buffer: AudioBuffer) => {
        const data = buffer.getChannelData(0);
        const sr = buffer.sampleRate;
        const barSeconds = 2; // 4/4 at 120 BPM
        return [0, 1, 2].map(bar => {
          const start = Math.floor((bar * barSeconds + 0.25) * sr);
          const size = 8192;
          const window = data.subarray(start, start + size);
          let energy = 0;
          for (let i = 0; i < window.length; i += 1) energy += window[i] * window[i];
          const rms = Math.sqrt(energy / window.length);
          // Autocorrelation pitch estimate over 100..1000 Hz.
          let bestLag = 0;
          let best = -Infinity;
          for (let lag = Math.floor(sr / 1000); lag <= Math.floor(sr / 100); lag += 1) {
            let sum = 0;
            for (let i = 0; i + lag < window.length; i += 1) sum += window[i] * window[i + lag];
            if (sum > best) { best = sum; bestLag = lag; }
          }
          return { rms, f0: bestLag > 0 ? sr / bestLag : 0 };
        });
      };

      const withPatterns: AudioBuffer = await engine.renderTimelineOffline(
        state.channels, clips, mixerTracks, 120, 3, 44100, false, 'song', undefined, undefined, undefined, undefined, state.patterns,
      );
      // The historical contract (no pattern model): every clip plays the live channel content.
      const withoutPatterns: AudioBuffer = await engine.renderTimelineOffline(
        state.channels, clips, mixerTracks, 120, 3, 44100, false, 'song',
      );
      return { patterned: analyse(withPatterns), legacy: analyse(withoutPatterns) };
    });

    const [verse, chorus, empty] = result.patterned;
    expect(verse.rms, 'Verse bar is audible').toBeGreaterThan(0.005);
    expect(chorus.rms, 'Chorus bar is audible').toBeGreaterThan(0.005);
    expect(verse.f0, `Verse plays C4 (~261.6 Hz), got ${verse.f0}`).toBeGreaterThan(245);
    expect(verse.f0).toBeLessThan(280);
    expect(chorus.f0, `Chorus plays C5 (~523.3 Hz), got ${chorus.f0}`).toBeGreaterThan(490);
    expect(chorus.f0).toBeLessThan(560);
    expect(empty.rms, `the Empty pattern bar is silent, got rms ${empty.rms}`).toBeLessThan(verse.rms / 100);

    // Without the pattern model every bar is the Verse — the pre-fix behaviour.
    const [legacyFirst, legacySecond, legacyThird] = result.legacy;
    expect(Math.abs(legacySecond.f0 - legacyFirst.f0)).toBeLessThan(15);
    expect(legacyThird.rms).toBeGreaterThan(0.005);
  });
});
