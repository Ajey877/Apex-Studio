import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 8B — the wavetable instrument end to end in a real browser.
 *
 * This is an integration test, not a canvas/DOM check:
 *
 *  1. The settings controls are driven through the real UI (range inputs).
 *  2. The Audition button plays the production wavetable voice into the live
 *     AudioContext; the master output is tapped with an AudioWorklet (the same
 *     technique as `realtimeExportParity.spec.ts`) and real PCM is compared
 *     between two morph settings.
 *  3. The autosaved project document is read back from IndexedDB, proving the
 *     UI edit reached persisted channel state, and that state is rendered with
 *     the production offline exporter to show the exported signal differs too.
 */

const APP_URL = 'http://localhost:3000';

const wavetableDialog = (page: Page) => page.locator('#fl-wavetable-synth-modal');

const openWavetable = async (page: Page) => {
  await page.locator('#fl-tools-menu-btn').click();
  await page.locator('#fl-wavetable-btn').click();
  const dialog = wavetableDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
};

/**
 * Drives a controlled range input the way React observes it: write through the
 * native value setter, then dispatch `input` (React 19 maps onChange to it).
 */
const setRange = async (page: Page, selector: string, value: number) => {
  const input = page.locator(selector);
  await expect(input).toBeVisible();
  await input.evaluate((element, next) => {
    const inputElement = element as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(inputElement, String(next));
    inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    inputElement.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
};

/** Installs a PCM tap on the engine's master analyser output. */
const startCapture = async (page: Page) => {
  await page.evaluate(async () => {
    // @ts-ignore — browser-side import served by Vite.
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    audioEngine.init();
    const context = audioEngine.getContext();
    await context.resume();
    const workletSource = `
      class ApexWavetableTap extends AudioWorkletProcessor {
        process(inputs, outputs) {
          const input = inputs[0] || [];
          const output = outputs[0] || [];
          for (const channel of output) channel.fill(0);
          const leftInput = input[0];
          const left = (leftInput && leftInput.length ? leftInput : new Float32Array(128)).slice();
          this.port.postMessage({ left: left.buffer }, [left.buffer]);
          return true;
        }
      }
      registerProcessor('apex-wavetable-tap', ApexWavetableTap);
    `;
    const blobUrl = URL.createObjectURL(new Blob([workletSource], { type: 'application/javascript' }));
    await context.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);
    const tap = new AudioWorkletNode(context, 'apex-wavetable-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    const state = {
      blocks: [] as Float32Array[],
      active: true,
      tap,
    };
    tap.port.onmessage = (event: MessageEvent) => {
      if (!state.active) return;
      state.blocks.push(new Float32Array(event.data.left));
    };
    audioEngine.masterAnalyser.connect(tap);
    tap.connect(context.destination);
    (window as unknown as { __apexWavetableTap?: typeof state }).__apexWavetableTap = state;
  });
};

interface CaptureMetrics {
  peak: number;
  rms: number;
  roughness: number;
  samples: number;
}

/** Stops the tap and reduces the captured PCM to comparable signal metrics. */
const stopCapture = async (page: Page): Promise<CaptureMetrics> =>
  page.evaluate(() => {
    const state = (window as unknown as {
      __apexWavetableTap?: { blocks: Float32Array[]; active: boolean; tap: AudioWorkletNode };
    }).__apexWavetableTap;
    if (!state) throw new Error('wavetable tap was not installed');
    state.active = false;
    const length = state.blocks.reduce((sum, block) => sum + block.length, 0);
    const merged = new Float32Array(length);
    let offset = 0;
    for (const block of state.blocks) {
      merged.set(block, offset);
      offset += block.length;
    }
    let peak = 0;
    let peakIndex = 0;
    for (let i = 0; i < merged.length; i++) {
      const value = Math.abs(merged[i]);
      if (value > peak) {
        peak = value;
        peakIndex = i;
      }
    }
    // Analyse a steady window after the onset (the audition note sustains).
    const start = Math.min(merged.length - 1, peakIndex + 4800);
    const end = Math.min(merged.length, start + 8192);
    let sum = 0;
    let delta = 0;
    let level = 0;
    for (let i = Math.max(1, start); i < end; i++) {
      sum += merged[i] * merged[i];
      delta += Math.abs(merged[i] - merged[i - 1]);
      level += Math.abs(merged[i]);
    }
    const count = Math.max(1, end - start);
    try {
      state.tap.port.onmessage = null;
      state.tap.disconnect();
    } catch {
      /* the page may be closing */
    }
    delete (window as unknown as { __apexWavetableTap?: unknown }).__apexWavetableTap;
    return {
      peak,
      rms: Math.sqrt(sum / count),
      roughness: level > 0 ? delta / level : 0,
      samples: merged.length,
    };
  });

const auditionAndCapture = async (page: Page): Promise<CaptureMetrics> => {
  await startCapture(page);
  await page.locator('#wt-audition').click();
  await expect(page.locator('#fl-wavetable-synth-modal')).toContainText('Auditioning');
  await page.waitForTimeout(1400);
  return stopCapture(page);
};

/** Reads the autosaved project document, waiting for the 350 ms autosave. */
const readPersistedProject = async (page: Page): Promise<any> => {
  await page.waitForTimeout(900);
  return page.evaluate(async () => {
    // @ts-ignore — browser-side import served by Vite.
    const { getPersistedProjectStateRecord } = await import('/src/audio/audioPersistence.ts');
    const record = await getPersistedProjectStateRecord();
    if (!record) throw new Error('no persisted project document');
    return JSON.parse(record).state;
  });
};

test.describe('Phase 8B wavetable instrument', () => {
  test.setTimeout(90_000);

  test('editing morph changes the auditioned signal and the saved settings', async ({ page }) => {
    await page.goto(APP_URL);
    await page.waitForSelector('#root > *', { state: 'attached' });
    await page.waitForTimeout(1200);

    const dialog = await openWavetable(page);
    await expect(dialog.locator('#fl-wavetable-synth-modal-title')).toHaveText('WAVETABLE SYNTH');

    // Switch the selected channel to the real instrument (single history step).
    await dialog.locator('#wt-enable').click();
    await expect(dialog).toContainText('USES THE WAVETABLE ENGINE');

    await setRange(page, '#wt-morph', 0);
    await expect(dialog.locator('#wt-frame-readout')).toContainText('FRAME 1 / 6');
    const sine = await auditionAndCapture(page);

    await setRange(page, '#wt-morph', 1);
    await expect(dialog.locator('#wt-frame-readout')).toContainText('FRAME 6 / 6');
    const metallic = await auditionAndCapture(page);

    // Both auditions really produced audio through the live graph.
    expect(sine.peak).toBeGreaterThan(0.001);
    expect(metallic.peak).toBeGreaterThan(0.001);
    expect(sine.samples).toBeGreaterThan(2048);

    // And the two settings are measurably different signals: the metallic
    // frame has a much higher sample-to-sample roughness (brighter spectrum).
    expect(metallic.roughness).toBeGreaterThan(sine.roughness * 1.2);
    expect(Math.abs(metallic.rms - sine.rms)).toBeGreaterThan(0);
    expect(Number.isFinite(sine.rms) && Number.isFinite(metallic.rms)).toBe(true);

    const persisted = await readPersistedProject(page);
    const channel = persisted.channels.find((candidate: any) => candidate.id === persisted.selectedChannelId)
      ?? persisted.channels[0];
    expect(channel.instrumentType).toBe('wavetable');
    expect(channel.wavetable.morph).toBeCloseTo(1, 3);
    expect(channel.wavetable.warpMode).toBe('none');
  });

  test('a preset changes saved settings and the exported signal', async ({ page }) => {
    await page.goto(APP_URL);
    await page.waitForSelector('#root > *', { state: 'attached' });
    await page.waitForTimeout(1200);

    const dialog = await openWavetable(page);
    await dialog.locator('#wt-preset-1').click();
    await expect(dialog).toContainText('Hyper Supersaw');
    await expect(dialog).toContainText('USES THE WAVETABLE ENGINE');

    const persisted = await readPersistedProject(page);
    const channel = persisted.channels.find((candidate: any) => candidate.id === persisted.selectedChannelId)
      ?? persisted.channels[0];
    expect(channel.instrumentType).toBe('wavetable');
    expect(channel.wavetable.unisonVoices).toBe(7);
    expect(channel.wavetable.unisonDetuneCents).toBe(32);
    expect(channel.wavetable.unisonSpread).toBeCloseTo(0.9, 3);
    expect(channel.wavetable.morph).toBeCloseTo(0.5, 3);

    // Render the saved channel with the production offline exporter twice:
    // once as saved, once with a different morph. The export must be audible
    // and must follow the persisted setting.
    const rendered = await page.evaluate(async (channelState: any) => {
      // @ts-ignore — browser-side import served by Vite.
      const { audioEngine } = await import('/src/audio/audioEngine.ts');
      const master = {
        id: 0, name: 'Master', color: '#3b82f6', volume: 1, pan: 0, mute: false,
        solo: false, fxSlots: [], peakL: 0, peakR: 0,
      };
      const insert = {
        id: channelState.mixerTrackId, name: 'WT Insert', color: '#10b981', volume: 1,
        pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0,
      };
      const notes = [
        { id: 'n1', pitch: 60, start: 0, duration: 4, velocity: 0.9 },
        { id: 'n2', pitch: 67, start: 8, duration: 4, velocity: 0.9 },
      ];
      const withNotes = { ...channelState, notes };
      const clip = {
        id: 'wt-export-clip', trackIndex: 0, startBar: 0, lengthBars: 1, type: 'pattern',
        channelId: channelState.id, color: '#10b981', name: 'WT export',
      };
      const render = (ch: any) =>
        audioEngine.renderTimelineOffline(
          [ch], [clip], [master, insert], 120, 1, 44100, false, 'song',
        );
      const saved = await render(withNotes);
      const alternate = await render({
        ...withNotes,
        wavetable: { ...withNotes.wavetable, morph: 0.05, warpMode: 'sync', warpAmount: 0.8 },
      });
      const a = saved.getChannelData(0);
      const b = alternate.getChannelData(0);
      let peak = 0;
      let diff = 0;
      for (let i = 0; i < a.length; i++) {
        peak = Math.max(peak, Math.abs(a[i]));
        diff = Math.max(diff, Math.abs(a[i] - b[i]));
      }
      return { peak, diff, length: a.length };
    }, channel);

    expect(rendered.length).toBeGreaterThan(44100);
    expect(rendered.peak).toBeGreaterThan(0.0005);
    expect(rendered.diff).toBeGreaterThan(0.0005);
  });

  test('each channel keeps its own wavetable settings', async ({ page }) => {
    await page.goto(APP_URL);
    await page.waitForSelector('#root > *', { state: 'attached' });
    await page.waitForTimeout(1200);

    const dialog = await openWavetable(page);
    await dialog.locator('#wt-preset-2').click();
    await expect(dialog).toContainText('Metallic Table');
    await page.waitForTimeout(900);

    const channelOptions = await dialog.locator('#wt-channel-select option').count();
    expect(channelOptions).toBeGreaterThan(1);
    await dialog.locator('#wt-channel-select').selectOption({ index: 1 });
    await page.waitForTimeout(200);

    // The second channel was never given wavetable settings, so it shows the
    // safe defaults rather than inheriting the first channel's preset.
    await expect(dialog.locator('#wt-frame-readout')).not.toContainText('FRAME 6 / 6');
    await expect(dialog.locator('#wt-warp-mode')).toHaveValue('none');

    const persisted = await readPersistedProject(page);
    const [first, second] = persisted.channels;
    expect(first.instrumentType).toBe('wavetable');
    expect(first.wavetable.warpMode).toBe('bend');
    expect(second.wavetable?.warpMode ?? 'none').toBe('none');
  });
});
