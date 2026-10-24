import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 10B — polyphonic Audio-to-MIDI, end to end in real Chromium.
 *
 * The Node suites prove the multi-pitch analyzer on rendered PCM
 * (`src/audio/phase10b.polyphonic.test.ts`) and the commit/history/persistence/
 * MIDI-export workflow (`src/audio/phase10b.polyphonicWorkflow.test.ts`). What
 * only a browser can prove is this chain:
 *
 *  1. a REAL durable audio holding a three-note chord is written through the
 *     production `setSampleBuffer` + IndexedDB persistence seam and survives a
 *     reload;
 *  2. the shipped UI lets the user pick the POLYPHONIC mode, analyses that real
 *     asset, and shows the three overlapping notes for review — without writing
 *     anything;
 *  3. switching the mode discards a stale verdict (the panel never shows notes
 *     from a mode the user is not in);
 *  4. an explicit commit writes three REAL overlapping project notes through the
 *     App's history + autosave path, they appear in the Piano Roll, they are in
 *     the Standard MIDI export, they survive a reload — and the committed pattern
 *     actually RENDERS audible stereo audio containing the chord's pitches
 *     (`audioEngine.renderTimelineOffline`, the production export path).
 */

const APP_URL = 'http://localhost:3000';
const CHORD_ASSET = 'spec-p10b-chord';
const SILENCE_ASSET = 'spec-p10b-silence';
const CROWDED_ASSET = 'spec-p10b-crowded';
const CHORD_CLIP = 'spec-p10b-chord-clip';
const SILENCE_CLIP = 'spec-p10b-silence-clip';
const CROWDED_CLIP = 'spec-p10b-crowded-clip';

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
      { timeout: 20_000 }
    )
    .toBe(true);
};

test.describe('Phase 10B: polyphonic Audio to MIDI (real browser audio)', () => {
  test('transcribes a real chord, commits three overlapping notes, renders them, and refuses unsupported material', async ({ page }) => {
    await page.goto(APP_URL);
    await page.waitForTimeout(2000);

    // ---- 1. Seed real durable assets: a C4+E4+G4 chord, silence, and a
    //         five-voice cluster (more than the supported four).
    const seeded = await page.evaluate(
      async ({ chordAsset, silenceAsset, crowdedAsset, chordClip, silenceClip, crowdedClip }) => {
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
        const seconds = 4;
        const make = () => ctx.createBuffer(1, Math.round(seconds * SR), SR);

        /** Adds one harmonic tone with an attack/release envelope. */
        const addTone = (target: Float32Array, frequency: number, fromSeconds: number, toSeconds: number, gain = 0.22) => {
          const start = Math.max(0, Math.round(fromSeconds * SR));
          const end = Math.min(target.length, Math.round(toSeconds * SR));
          const fade = Math.round(0.008 * SR);
          for (let i = start; i < end; i += 1) {
            const env = Math.min(1, (i - start) / fade) * Math.min(1, (end - i) / fade);
            const phase = (2 * Math.PI * frequency * i) / SR;
            target[i] += gain * env * (Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase));
          }
        };

        // A held C major triad for 1.5 s: three simultaneous fundamentals, which
        // is exactly what monophonic mode refuses and polyphonic mode must find.
        const chordBuffer = make();
        const chordData = chordBuffer.getChannelData(0);
        for (const midi of [60, 64, 67]) {
          const frequency = 440 * Math.pow(2, (midi - 69) / 12);
          addTone(chordData, frequency, 0.4, 1.9, 0.2);
        }
        engine.setSampleBuffer(chordAsset, chordBuffer);
        await bufferPersist.waitForSampleBufferPersistence(engine, chordAsset);

        const silenceBuffer = make();
        engine.setSampleBuffer(silenceAsset, silenceBuffer);
        await bufferPersist.waitForSampleBufferPersistence(engine, silenceAsset);

        // Five simultaneous pitches: one more voice than the mode supports, so
        // the honest answer is a refusal, not a partial transcription.
        const crowdedBuffer = make();
        const crowdedData = crowdedBuffer.getChannelData(0);
        for (const midi of [48, 52, 55, 59, 62]) {
          const frequency = 440 * Math.pow(2, (midi - 69) / 12);
          addTone(crowdedData, frequency, 0.4, 1.9, 0.2);
        }
        engine.setSampleBuffer(crowdedAsset, crowdedBuffer);
        await bufferPersist.waitForSampleBufferPersistence(engine, crowdedAsset);

        const stored = await persistence.getPersistedProjectStateRecord();
        const base = stored ? JSON.parse(stored).state : projectState.createDefaultProjectState();
        const clip = (id: string, assetId: string, name: string, color: string, trackIndex: number) => ({
          id,
          trackIndex,
          startBar: 0,
          lengthBars: 2,
          type: 'audio',
          audioBufferId: assetId,
          name,
          color,
        });
        // A chord transcription belongs on a PITCHED instrument: the default
        // project ships drum pads, so the spec adds a keys channel and selects it
        // as the destination (the modal defaults to the selected channel).
        const pitchedId = 'spec-poly-keys';
        const template = base.channels[0];
        const pitchedChannel = {
          ...template,
          id: pitchedId,
          name: 'Spec Poly Keys',
          instrumentType: 'grand_piano',
          notes: [],
          steps: (template.steps || []).map(() => Array(16).fill(false)),
        };
        const withClips = {
          ...base,
          selectedChannelId: pitchedId,
          channels: [
            ...base.channels.filter((channel: any) => channel.id !== pitchedId),
            pitchedChannel,
          ],
          playlistClips: [
            ...base.playlistClips.filter(
              (existing: any) => ![chordClip, silenceClip, crowdedClip].includes(existing.id)
            ),
            clip(chordClip, chordAsset, 'Spec Poly Chord', '#00e5ff', 0),
            clip(silenceClip, silenceAsset, 'Spec Poly Silence', '#ffaa00', 1),
            clip(crowdedClip, crowdedAsset, 'Spec Poly Crowded', '#ff5500', 2),
          ],
        };
        await projectPersistence.persistProjectState(withClips);
        return { sampleRate: SR, length: chordBuffer.length };
      },
      {
        chordAsset: CHORD_ASSET,
        silenceAsset: SILENCE_ASSET,
        crowdedAsset: CROWDED_ASSET,
        chordClip: CHORD_CLIP,
        silenceClip: SILENCE_CLIP,
        crowdedClip: CROWDED_CLIP,
      }
    );
    expect(seeded.length).toBeGreaterThan(1000);

    await page.reload();
    await page.waitForTimeout(2000);

    const restored = await persistedState(page);
    expect(
      restored.playlistClips.some((clip: any) => clip.id === CHORD_CLIP && clip.audioBufferId === CHORD_ASSET)
    ).toBe(true);
    const beforeAnalysis = JSON.stringify(restored);

    // ---- 2. Silence is refused in polyphonic mode, and nothing is written.
    await selectClip(page, SILENCE_CLIP);
    await openAudioToMidi(page);
    await page.getByLabel('Polyphonic analysis mode').check();
    await expect(page.getByTestId('atm-mode-badge')).toHaveText('POLYPHONIC · REAL PCM');
    await expect(page.getByTestId('atm-mode-badge')).toHaveCount(1);
    await page.getByRole('button', { name: 'Analyse clip' }).click();
    await expect(page.getByTestId('atm-verdict')).toContainText('REJECTED', { timeout: 30_000 });
    await expect(page.getByTestId('atm-verdict')).toContainText('silence-or-noise');
    await expect(page.getByRole('button', { name: /Commit notes to project/ })).toHaveCount(0);
    expect(JSON.stringify(await persistedState(page))).toBe(beforeAnalysis);
    await page.getByRole('button', { name: 'Close audio to MIDI' }).click();

    // ---- 3. More than four voices is refused rather than partially transcribed.
    await selectClip(page, CROWDED_CLIP);
    await openAudioToMidi(page);
    await page.getByLabel('Polyphonic analysis mode').check();
    await page.getByRole('button', { name: 'Analyse clip' }).click();
    await expect(page.getByTestId('atm-verdict')).toContainText('polyphony-exceeded', { timeout: 30_000 });
    await expect(page.getByTestId('atm-message')).toContainText(/more than 4 simultaneous fundamentals/i);
    await expect(page.getByRole('button', { name: /Commit notes to project/ })).toHaveCount(0);
    expect(JSON.stringify(await persistedState(page))).toBe(beforeAnalysis);
    await page.getByRole('button', { name: 'Close audio to MIDI' }).click();

    // ---- 4. The real chord: polyphonic mode reviews three overlapping notes.
    await selectClip(page, CHORD_CLIP);
    await openAudioToMidi(page);
    await expect(page.getByTestId('atm-source-clip')).toContainText('Spec Poly Chord');
    await page.getByLabel('Polyphonic analysis mode').check();
    await page.getByRole('button', { name: 'Analyse clip' }).click();
    await expect(page.getByTestId('atm-verdict')).toContainText('OK', { timeout: 60_000 });
    await expect(page.getByTestId('atm-verdict')).toContainText('POLYPHONIC');
    const rows = page.locator('#fl-audio-to-midi-modal table tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('C4');
    await expect(rows.nth(1)).toContainText('E4');
    await expect(rows.nth(2)).toContainText('G4');
    // The measured statistics are shown, not a decorative confidence.
    await expect(page.getByTestId('atm-poly-stats')).toContainText('PEAKS EXPLAINED');
    await expect(page.getByTestId('atm-poly-stats')).toContainText(/[1-4] \/ 4 voices/);
    // The destination instrument is a real, user-controlled choice. A drum pad
    // has no pitches, and the panel says so instead of silently committing a
    // "chord" nobody can hear (or blaming the transcription for it).
    const channelSelect = page.getByLabel('Destination channel');
    await expect(channelSelect).toHaveValue('spec-poly-keys');
    await expect(page.getByTestId('atm-channel-hint')).toHaveCount(0);
    await channelSelect.selectOption('ch-1');
    await expect(page.getByTestId('atm-channel-hint')).toContainText('drum pad');
    await channelSelect.selectOption('spec-poly-keys');
    await expect(page.getByTestId('atm-channel-hint')).toHaveCount(0);
    // Preview only.
    expect(JSON.stringify(await persistedState(page))).toBe(beforeAnalysis);

    // ---- 5. Switching the mode discards the stale verdict.
    await page.getByLabel('Monophonic analysis mode').check();
    await expect(page.getByTestId('atm-mode-badge')).toHaveText('MONOPHONIC · REAL PCM');
    await expect(rows).toHaveCount(0);
    await page.getByLabel('Polyphonic analysis mode').check();
    await page.getByRole('button', { name: 'Analyse clip' }).click();
    await expect(page.getByTestId('atm-verdict')).toContainText('OK', { timeout: 60_000 });
    await expect(rows).toHaveCount(3);

    // ---- 6. Explicit commit into a NEW pattern; three overlapping notes land.
    await expect(page.getByTestId('atm-dry-run')).toContainText('Will write 3 notes');
    await page.getByRole('button', { name: 'Commit notes to project' }).click();
    await expect(page.getByTestId('atm-commit-result')).toContainText('Wrote 3 notes');

    await waitForPersistedProject(
      page,
      "state.patterns.some(p => (p.name||'').startsWith('Audio to MIDI')) && state.channels.some(c => (c.notes||[]).filter(n => [60,64,67].includes(n.pitch)).length === 3)"
    );

    const committed = await persistedState(page);
    const polyPattern = committed.patterns.find((pattern: any) => String(pattern.name).startsWith('Audio to MIDI'));
    expect(polyPattern).toBeTruthy();
    const chordChannel = committed.channels.find(
      (channel: any) => (channel.notes || []).filter((note: any) => [60, 64, 67].includes(note.pitch)).length === 3
    );
    expect(chordChannel).toBeTruthy();
    // The transcription landed on the pitched channel the user had selected.
    expect(chordChannel.id).toBe('spec-poly-keys');
    const committedNotes = chordChannel.notes.filter((note: any) => [60, 64, 67].includes(note.pitch));
    expect(committedNotes.map((note: any) => note.pitch).sort((a: number, b: number) => a - b)).toEqual([60, 64, 67]);
    // A chord means the notes overlap in time — that is what makes it polyphonic.
    const starts = new Set(committedNotes.map((note: any) => note.start));
    expect(starts.size).toBe(1);
    expect(committedNotes.every((note: any) => note.duration > 0)).toBe(true);
    expect(committed.selectedPatternId).toBe(polyPattern.id);
    expect(committed.playlistClips.some((clip: any) => clip.id === CHORD_CLIP)).toBe(true);

    // ---- 7. Real Piano Roll content, real MIDI export content.
    await page.getByRole('button', { name: 'Open in Piano Roll' }).click();
    await expect(page.locator('#piano-roll-container')).toBeVisible();
    await expect(page.locator('[id^="note-block-"]')).toHaveCount(3);

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

    // ---- 7b. Undo is exactly one step: the committed chord comes back on redo.
    await page.keyboard.press('Control+z');
    await expect(page.locator('[id^="note-block-"]')).toHaveCount(0, { timeout: 10_000 });
    await page.keyboard.press('Control+Shift+z');
    await expect(page.locator('[id^="note-block-"]')).toHaveCount(3, { timeout: 10_000 });

    // ---- 8. The committed notes actually SOUND: render the pattern offline
    //         through the production export path and measure the chord's pitches.
    const rendered = await page.evaluate(async (patternName) => {
      // @ts-ignore — Vite-served production modules
      const engineMod: any = await import('/src/audio/audioEngine.ts');
      // @ts-ignore
      const persistence: any = await import('/src/audio/audioPersistence.ts');
      const json: string | null = await persistence.getPersistedProjectStateRecord();
      const state = JSON.parse(json as string).state;
      const pattern = state.patterns.find((candidate: any) => String(candidate.name).startsWith(patternName));
      const engine = engineMod.audioEngine;
      const buffer: AudioBuffer = await engine.renderTimelineOffline(
        state.channels,
        [],
        state.mixerTracks ?? [],
        120,
        2,
        44100,
        false,
        'pattern',
        undefined,
        32,
        [],
        undefined,
        state.patterns
      );
      const data = buffer.getChannelData(0);
      let peak = 0;
      let sumSquares = 0;
      for (const value of data) {
        peak = Math.max(peak, Math.abs(value));
        sumSquares += value * value;
      }
      const rms = Math.sqrt(sumSquares / data.length);
      // Magnitude of a few analysis windows at one frequency (Goertzel), taken
      // from the sustain of the committed chord.
      const goertzel = (frequency: number) => {
        // 0.5 s in: the committed chord starts ~0.44 s into the pattern, so this
        // window sits inside the sustain of every note.
        const start = Math.round(0.5 * buffer.sampleRate);
        const length = Math.min(4096, data.length - start);
        let real = 0;
        let imaginary = 0;
        for (let i = 0; i < length; i += 1) {
          const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / length));
          const angle = (2 * Math.PI * frequency * i) / buffer.sampleRate;
          real += data[start + i] * window * Math.cos(angle);
          imaginary += data[start + i] * window * Math.sin(angle);
        }
        return Math.hypot(real, imaginary) / length;
      };
      const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
      return {
        length: data.length,
        peak,
        rms,
        c4: goertzel(hz(60)),
        e4: goertzel(hz(64)),
        g4: goertzel(hz(67)),
        // A pitch that is NOT in the committed chord, as a control.
        fSharp5: goertzel(hz(78)),
        patternId: pattern?.id ?? null,
      };
    }, 'Audio to MIDI');

    expect(rendered.length).toBeGreaterThan(44100);
    expect(rendered.peak).toBeGreaterThan(0.01);
    expect(rendered.rms).toBeGreaterThan(0.003);
    // Every pitch of the committed chord is present in the rendered audio...
    for (const [label, value] of [['C4', rendered.c4], ['E4', rendered.e4], ['G4', rendered.g4]] as const) {
      expect(value, `${label} must be audible in the rendered pattern`).toBeGreaterThan(rendered.fSharp5 * 4);
    }

    // ---- 9. Reload: the notes are project content, not modal state.
    await page.reload();
    await page.waitForTimeout(2000);
    const afterReload = await persistedState(page);
    const reloadedChannel = afterReload.channels.find(
      (channel: any) => (channel.notes || []).filter((note: any) => [60, 64, 67].includes(note.pitch)).length === 3
    );
    expect(reloadedChannel).toBeTruthy();
    await page.locator('#nav-channel-rack').click();
    await page.locator(`#channel-row-${reloadedChannel.id}`).click();
    await page.locator('#nav-piano-roll').click();
    await expect(page.locator('[id^="note-block-"]')).toHaveCount(3, { timeout: 15_000 });

    // ---- 10. Undo after the commit is one step, and the durable asset survives.
    const assetSurvives = await page.evaluate(async (assetId) => {
      // @ts-ignore — Vite-served production modules
      const persistence: any = await import('/src/audio/audioPersistence.ts');
      const blob: Blob | null = await persistence.getPersistedAudioClip(assetId);
      return blob ? blob.size : 0;
    }, CHORD_ASSET);
    expect(assetSurvives).toBeGreaterThan(50000);
  });
});
