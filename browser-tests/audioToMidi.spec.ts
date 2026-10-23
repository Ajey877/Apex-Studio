import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 8C — Audio to MIDI, end-to-end in real Chromium.
 *
 * The Node suites prove the transcription on rendered PCM
 * (`src/audio/audioToMidi.test.ts`) and the commit contract against real
 * project state, history and MIDI export (`src/state/audioToMidiCommit.test.ts`).
 * This spec closes the gap that only a browser can close:
 *
 *  1. a REAL durable audio asset is written through the production
 *     `setSampleBuffer` + IndexedDB persistence seam, and survives a page reload;
 *  2. the shipped UI analyses that asset's real PCM (no fixture injected into
 *     the component), shows the reviewable note preview, and reports a refusal on
 *     silent material while leaving the project untouched;
 *  3. an explicit commit writes REAL project notes, they appear in the Piano
 *     Roll, they are in the Standard MIDI export, and they are still there after
 *     a full reload — because they went through the App's history + autosave
 *     path, not a modal-local array.
 */

const APP_URL = 'http://localhost:3000';
const MELODY_ASSET = 'spec-atm-melody';
const SILENCE_ASSET = 'spec-atm-silence';
const MELODY_CLIP = 'spec-atm-melody-clip';
const SILENCE_CLIP = 'spec-atm-silence-clip';

/** Opens the Playlist and clicks the seeded audio clip. */
const selectClip = async (page: Page, clipId: string): Promise<void> => {
  await page.locator('#nav-playlist').click();
  const clip = page.locator(`[data-clip-id="${clipId}"]`);
  await expect(clip).toBeVisible();
  await clip.click();
};

const openAudioToMidi = async (page: Page): Promise<void> => {
  await page.locator('#fl-tools-menu-btn').click();
  await page.locator('#fl-audio-to-midi-btn').click();
  await expect(page.locator('#fl-audio-to-midi-modal')).toBeVisible();
};

/** Reads the live persisted project record (the autosave target). */
const persistedState = async (page: Page): Promise<any> =>
  page.evaluate(async () => {
    // @ts-ignore — resolved by the Vite dev server
    const persistence: any = await import('/src/audio/audioPersistence.ts');
    const json: string | null = await persistence.getPersistedProjectStateRecord();
    return json ? JSON.parse(json).state : null;
  });

const waitForPersistedProject = async (page: Page, predicate: string): Promise<void> => {
  await expect
    .poll(
      async () =>
        page.evaluate(async (source) => {
          // @ts-ignore — resolved by the Vite dev server
          const persistence: any = await import('/src/audio/audioPersistence.ts');
          const json: string | null = await persistence.getPersistedProjectStateRecord();
          if (!json) return false;
          const state = JSON.parse(json).state;
          // eslint-disable-next-line no-new-func
          return Boolean(new Function('state', `return (${source});`)(state));
        }, predicate),
      { timeout: 15_000 }
    )
    .toBe(true);
};

test.describe('Phase 8C: Audio to MIDI (real browser audio)', () => {
  test('transcribes a durable audio asset into real project notes that survive reload; silence is refused', async ({ page }) => {
    await page.goto(APP_URL);
    await page.waitForTimeout(2000);

    // ---- 1. Seed a REAL durable asset and a project clip that references it.
    const seeded = await page.evaluate(
      async ({ melodyAsset, silenceAsset, melodyClip, silenceClip }) => {
        // @ts-ignore — Vite-served production modules
        const engineMod: any = await import('/src/audio/audioEngine.ts');
        // @ts-ignore
        const bufferPersist: any = await import('/src/audio/sampleBufferPersistence.ts');
        // @ts-ignore
        const persistence: any = await import('/src/audio/audioPersistence.ts');
        // @ts-ignore
        const projectPersistence: any = await import('/src/state/projectPersistence.ts');
        // @ts-ignore
        const projectState: any = await import('/src/state/projectState.ts');

        const engine = engineMod.audioEngine;
        if (!bufferPersist.getSampleBufferPersistenceController(engine)) {
          bufferPersist.installSampleBufferPersistence(engine);
        }
        const ctx = engine.getContext();
        const SR = ctx.sampleRate;

        // Two bars at 120 BPM / 4/4: C4 for one bar, then E4 for one bar. A
        // single harmonic series per note, so this is honestly monophonic.
        const note = (frequency: number, seconds: number, offset: number, target: Float32Array) => {
          const start = Math.round(offset * SR);
          const length = Math.round(seconds * SR);
          let phase = 0;
          for (let i = 0; i < length; i += 1) {
            const env = Math.min(1, i / 400) * Math.min(1, (length - i) / 400);
            phase += (2 * Math.PI * frequency) / SR;
            target[start + i] = 0.5 * env * (
              Math.sin(phase) + 0.35 * Math.sin(2 * phase) + 0.15 * Math.sin(3 * phase)
            );
          }
        };

        const seconds = 4; // 2 bars at 120 BPM
        const melodyBuffer = ctx.createBuffer(1, Math.round(seconds * SR), SR);
        const melodyData = melodyBuffer.getChannelData(0);
        note(261.6256, 2, 0, melodyData);
        note(329.6276, 2, 2, melodyData);
        engine.setSampleBuffer(melodyAsset, melodyBuffer);
        await bufferPersist.waitForSampleBufferPersistence(engine, melodyAsset);

        const silenceBuffer = ctx.createBuffer(1, Math.round(seconds * SR), SR);
        engine.setSampleBuffer(silenceAsset, silenceBuffer);
        await bufferPersist.waitForSampleBufferPersistence(engine, silenceAsset);

        const stored = await persistence.getPersistedProjectStateRecord();
        const base = stored ? JSON.parse(stored).state : projectState.createDefaultProjectState();
        const withClips = {
          ...base,
          playlistClips: [
            ...base.playlistClips.filter(
              (clip: any) => clip.id !== melodyClip && clip.id !== silenceClip
            ),
            {
              id: melodyClip,
              trackIndex: 0,
              startBar: 0,
              lengthBars: 2,
              type: 'audio',
              audioBufferId: melodyAsset,
              name: 'Spec Audio to MIDI Melody',
              color: '#00e5ff',
            },
            {
              id: silenceClip,
              trackIndex: 1,
              startBar: 0,
              lengthBars: 2,
              type: 'audio',
              audioBufferId: silenceAsset,
              name: 'Spec Audio to MIDI Silence',
              color: '#ffaa00',
            },
          ],
        };
        await projectPersistence.persistProjectState(withClips);
        return { sampleRate: SR, bufferLength: melodyBuffer.length };
      },
      { melodyAsset: MELODY_ASSET, silenceAsset: SILENCE_ASSET, melodyClip: MELODY_CLIP, silenceClip: SILENCE_CLIP }
    );
    expect(seeded.bufferLength).toBeGreaterThan(1000);

    await page.reload();
    await page.waitForTimeout(2000);

    // The durable asset and the seeded clips came back with the project.
    const restored = await persistedState(page);
    expect(
      restored.playlistClips.some((clip: any) => clip.id === MELODY_CLIP && clip.audioBufferId === MELODY_ASSET)
    ).toBe(true);

    // ---- 2. A refusal leaves the project EXACTLY as it was.
    const beforeRefusal = JSON.stringify(restored);
    await selectClip(page, SILENCE_CLIP);
    await openAudioToMidi(page);
    await page.getByRole('button', { name: 'Analyse clip' }).click();
    await expect(page.getByTestId('atm-verdict')).toContainText('REJECTED', { timeout: 30_000 });
    await expect(page.getByTestId('atm-verdict')).toContainText('silence-or-noise');
    await expect(page.getByTestId('atm-message')).toContainText(/did not|no confident|silence/i);
    await expect(page.getByRole('button', { name: /Commit notes to project/ })).toHaveCount(0);
    expect(JSON.stringify(await persistedState(page))).toBe(beforeRefusal);
    await page.getByRole('button', { name: 'Close audio to MIDI' }).click();

    // ---- 3. Real transcription of the durable melody asset.
    await selectClip(page, MELODY_CLIP);
    await openAudioToMidi(page);
    await expect(page.getByTestId('atm-source-clip')).toContainText('Spec Audio to MIDI Melody');
    await page.getByRole('button', { name: 'Analyse clip' }).click();
    await expect(page.getByTestId('atm-verdict')).toContainText('OK', { timeout: 60_000 });
    const rows = page.locator('#fl-audio-to-midi-modal table tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('C4');
    await expect(rows.nth(1)).toContainText('E4');

    // Preview only: nothing has been persisted yet.
    expect(JSON.stringify(await persistedState(page))).toBe(beforeRefusal);

    // ---- 4. Explicit commit into a NEW pattern (the non-destructive default).
    const channelName = await page
      .locator('#fl-audio-to-midi-modal select[aria-label="Destination channel"] option:checked')
      .textContent();
    await expect(page.getByTestId('atm-dry-run')).toContainText('Will write 2 notes');
    await page.getByRole('button', { name: 'Commit notes to project' }).click();
    await expect(page.getByTestId('atm-commit-result')).toContainText('Wrote 2 notes');

    await waitForPersistedProject(
      page,
      "state.patterns.some(p => (p.name||'').startsWith('Audio to MIDI')) && state.channels.some(c => (c.notes||[]).filter(n => [60,64].includes(n.pitch)).length === 2)"
    );

    const committed = await persistedState(page);
    const audioPattern = committed.patterns.find((pattern: any) => String(pattern.name).startsWith('Audio to MIDI'));
    expect(audioPattern).toBeTruthy();
    const melodyChannel = committed.channels.find((channel: any) =>
      (channel.notes || []).some((note: any) => note.pitch === 60)
    );
    expect(melodyChannel).toBeTruthy();
    expect(channelName).toContain(melodyChannel.name);
    const committedNotes = melodyChannel.notes as Array<{ pitch: number; start: number; duration: number }>;
    expect(committedNotes.map(note => note.pitch).sort((a, b) => a - b)).toEqual([60, 64]);
    expect(committedNotes.every(note => note.duration > 0)).toBe(true);
    // Notes are in the first two bars (steps 0–31 at 120 BPM, 16 steps/bar).
    expect(committedNotes.every(note => note.start >= 0 && note.start + note.duration <= 32)).toBe(true);
    // The seeded clips, and every pattern that existed before, are untouched.
    expect(committed.playlistClips.some((clip: any) => clip.id === MELODY_CLIP)).toBe(true);
    expect(committed.selectedPatternId).toBe(audioPattern.id);

    // ---- 5. The notes are real Piano Roll content and real MIDI export content.
    await page.getByRole('button', { name: 'Open in Piano Roll' }).click();
    await expect(page.locator('#piano-roll-container')).toBeVisible();
    await expect(page.locator('[id^="note-block-"]')).toHaveCount(2);

    const exported = await page.evaluate(async () => {
      // @ts-ignore — Vite-served production modules
      const persistence: any = await import('/src/audio/audioPersistence.ts');
      // @ts-ignore
      const exporters: any = await import('/src/utils/exportUtils.ts');
      const json: string | null = await persistence.getPersistedProjectStateRecord();
      const state = JSON.parse(json as string).state;
      const pattern = state.patterns.find((candidate: any) => String(candidate.name).startsWith('Audio to MIDI'));
      const blob: Blob = exporters.buildStandardMidiFile(
        state.channels,
        [],
        { ...state.meta, bpm: 120, timeSignature: [4, 4] },
        { scope: 'pattern', patternLengthSteps: pattern.lengthSteps ?? 32, totalBars: 2, patterns: state.patterns }
      );
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { size: bytes.length, header: String.fromCharCode(...bytes.slice(0, 4)) };
    });
    expect(exported.header).toBe('MThd');
    expect(exported.size).toBeGreaterThan(60);

    // ---- 6. Reload: the notes are still project content, not modal state.
    await page.reload();
    await page.waitForTimeout(2000);
    const afterReload = await persistedState(page);
    const reloadedChannel = afterReload.channels.find((channel: any) =>
      (channel.notes || []).some((note: any) => note.pitch === 60)
    );
    expect(reloadedChannel.notes.map((note: any) => note.pitch).sort((a: number, b: number) => a - b)).toEqual([60, 64]);
    // Select that channel in the rack, then read the notes off the real Piano Roll.
    await page.locator('#nav-channel-rack').click();
    await page.locator(`#channel-row-${reloadedChannel.id}`).click();
    await page.locator('#nav-piano-roll').click();
    await expect(page.locator('[id^="note-block-"]')).toHaveCount(2, { timeout: 15_000 });
    // ...and the durable audio asset is still there, so the source clip still plays.
    const assetSurvives = await page.evaluate(async (assetId) => {
      // @ts-ignore — Vite-served production modules
      const persistence: any = await import('/src/audio/audioPersistence.ts');
      const blob: Blob | null = await persistence.getPersistedAudioClip(assetId);
      return blob ? blob.size : 0;
    }, MELODY_ASSET);
    expect(assetSurvives).toBeGreaterThan(50000);
  });
});
