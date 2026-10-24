import { test, expect } from '@playwright/test';

// Genuine WAV import -> real IndexedDB -> actual App/Playlist/editor controls ->
// project history -> application reload -> production OfflineAudioContext export.
for (const channels of [1, 2]) test(`integrated waveform editor: ${channels}-channel audio, safe commit, undo/redo and reload/export`, async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('http://localhost:3000');
  await page.evaluate(async channels => {
    // @ts-ignore Vite production module imports in the actual browser
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore
    const { audioBufferToWav } = await import('/src/audio/wavEncoder.ts');
    // @ts-ignore
    const { waitForSampleBufferPersistence } = await import('/src/audio/sampleBufferPersistence.ts');
    // @ts-ignore
    const { createDefaultProjectState } = await import('/src/state/projectState.ts');
    // @ts-ignore
    const { persistProjectState } = await import('/src/state/projectPersistence.ts');
    const ctx = audioEngine.getContext(), frames = Math.round(ctx.sampleRate * 0.4);
    const pcm = ctx.createBuffer(channels, frames, ctx.sampleRate);
    for (let c = 0; c < channels; c++) for (let i = 0; i < frames; i++) pcm.getChannelData(c)[i] = (0.1 + 0.3 * i / frames) * (c ? -0.5 : 1);
    // This enters through Apex's actual file decoder, not a test-only buffer registry.
    const file = new File([audioBufferToWav(pcm, 32)], 'asymmetric-recorded-take.wav', { type: 'audio/wav' });
    const loaded = await audioEngine.loadAudioFile(file, 'editor-original');
    audioEngine.setSampleBuffer('editor-original', loaded.buffer);
    await waitForSampleBufferPersistence(audioEngine, 'editor-original');
    const state = createDefaultProjectState();
    const clip = { id: 'edit-target', name: 'Asymmetric recorded audio', audioName: file.name, audioBufferId: 'editor-original', type: 'audio', trackIndex: 0, startBar: 0.5, lengthBars: loaded.buffer.duration / 2, color: '#00d2aa' };
    state.meta = { ...state.meta, bpm: 120, totalBars: 4 };
    state.playlistClips = [{ ...clip, id: 'unrelated', name: 'Shared original - untouched', trackIndex: 1, startBar: 1.5 }, clip];
    state.mixerTracks = state.mixerTracks.map((track: any) => ({ ...track, volume: 1, pan: 0, mute: false, solo: false, fxSlots: [] }));
    await persistProjectState(state);
    sessionStorage.setItem('wave-editor-frames', String(loaded.buffer.length));
  }, channels);
  await page.reload();
  await page.locator('#nav-playlist').click();
  const open = async () => {
    await page.locator('[data-clip-id="edit-target"]').click({ position: { x: 8, y: 24 } });
    await page.getByRole('button', { name: 'Open in Audio Editor', exact: true }).click();
    await expect(page.getByTestId('editor-audio-info')).toContainText(`${channels} channel(s)`);
  };
  await open();
  const modal = page.getByRole('dialog', { name: 'Waveform Audio Editor' });
  const canvas = modal.locator('canvas');
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.1, bounds.y + 80);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + 80); await page.mouse.up();
  expect(Number(await modal.getByLabel('Selection start frame', { exact: true }).inputValue())).toBeGreaterThan(0);
  await modal.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await modal.getByRole('slider', { name: 'Waveform position' }).press('End');
  await modal.getByRole('slider', { name: 'Waveform position' }).press('Home');
  await modal.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await modal.getByRole('button', { name: 'reverse', exact: true }).click();
  await expect(modal.getByRole('status')).toContainText('reverse:');
  await modal.getByRole('button', { name: 'Preview edited selection' }).click();
  await modal.getByRole('button', { name: 'Stop audition' }).click();
  await modal.getByRole('button', { name: 'Cancel / close draft' }).click();
  expect(await page.evaluate(async () => {
    // @ts-ignore
    const { listPersistedAudioClipIds } = await import('/src/audio/audioPersistence.ts');
    return (await listPersistedAudioClipIds()).filter((id: string) => id.startsWith('waveform-edit-'));
  })).toEqual([]);
  await open();
  const frames = await page.evaluate(() => Number(sessionStorage.getItem('wave-editor-frames')));
  const a = Math.floor(frames / 4), b = Math.floor(frames * 3 / 4);
  await modal.getByLabel('Selection start frame', { exact: true }).fill(String(a));
  await modal.getByLabel('Selection end frame', { exact: true }).fill(String(b));
  await modal.getByRole('button', { name: 'reverse', exact: true }).click();
  await expect(modal.getByRole('status')).toContainText('reverse:');
  await modal.getByLabel('Normalize target dBFS').fill('-6');
  await modal.getByRole('button', { name: 'Normalize selection' }).click();
  await expect(modal.getByRole('status')).toContainText('normalize:');
  await modal.getByRole('button', { name: 'fade in', exact: true }).click();
  await expect(modal.getByRole('status')).toContainText('fade-in:');
  await modal.getByRole('button', { name: 'Undo draft' }).click();
  await modal.getByRole('button', { name: 'Redo draft' }).click();
  // Draft history restores the full selection; explicitly restore the precise range.
  await modal.getByLabel('Selection start frame', { exact: true }).fill(String(a));
  await modal.getByLabel('Selection end frame', { exact: true }).fill(String(b));
  await modal.getByRole('button', { name: 'Crop to selection' }).click();
  await expect(page.getByTestId('editor-audio-info')).toContainText(`${b - a} frames`);
  await modal.getByRole('button', { name: 'Apply to selected clip' }).click();
  await expect(modal).not.toBeVisible();
  const storedClip = async () => page.evaluate(async () => {
    // @ts-ignore
    const { getPersistedProjectStateRecord } = await import('/src/audio/audioPersistence.ts');
    const state = JSON.parse(await getPersistedProjectStateRecord()).state;
    return state.playlistClips.find((clip: any) => clip.id === 'edit-target');
  });
  await expect.poll(async () => (await storedClip()).audioBufferId).toMatch(/^waveform-edit-/);
  const committed = await storedClip();
  const evidence = await page.evaluate(async ({ id, a, b }) => {
    // @ts-ignore
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    const original = audioEngine.getSampleBuffer('editor-original'), edited = audioEngine.getSampleBuffer(id);
    let peak = 0, error = 0;
    for (let c = 0; c < original.numberOfChannels; c++) for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(original.getChannelData(c)[i]));
    for (let c = 0; c < edited.numberOfChannels; c++) for (let i = 0; i < edited.length; i++) {
      const normalized = Math.fround(original.getChannelData(c)[b - 1 - i] * Math.pow(10, -6 / 20) / peak);
      const expected = Math.fround(normalized * i / (b - a - 1));
      error = Math.max(error, Math.abs(edited.getChannelData(c)[i] - expected));
    }
    return { error, frames: edited.length, channels: edited.numberOfChannels, sampleRate: edited.sampleRate, originalSampleRate: original.sampleRate };
  }, { id: committed.audioBufferId, a, b });
  expect(evidence.error).toBeLessThan(1e-7); expect(evidence.frames).toBe(b - a); expect(evidence.channels).toBe(channels); expect(evidence.sampleRate).toBe(evidence.originalSampleRate);
  await page.locator('#fl-playlist-arranger').getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await storedClip()).audioBufferId).toBe('editor-original');
  await page.locator('#fl-playlist-arranger').getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(async () => (await storedClip()).audioBufferId).toBe(committed.audioBufferId);
  const renderProof = async () => page.evaluate(async id => {
    // @ts-ignore
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore
    const { getPersistedProjectStateRecord } = await import('/src/audio/audioPersistence.ts');
    // @ts-ignore
    const { DEFAULT_MASTERING_SUITE_STATE } = await import('/src/audio/masteringState.ts');
    const state = JSON.parse(await getPersistedProjectStateRecord()).state;
    const selected = state.playlistClips.find((clip: any) => clip.id === 'edit-target');
    const other = state.playlistClips.find((clip: any) => clip.id === 'unrelated');
    if (other.audioBufferId !== 'editor-original') throw new Error('Unrelated shared clip changed');
    if (selected.audioBufferId !== id) throw new Error('Stale project asset');
    audioEngine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
    const output = await audioEngine.renderTimelineOffline(state.channels, [selected], state.mixerTracks, 120, 1, 48000, true, 'song');
    const pcm = output.getChannelData(0); let peak = 0, hash = 2166136261;
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (const value of pcm) peak = Math.max(peak, Math.abs(value));
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    const buffer = audioEngine.getSampleBuffer(id); let checksum = 2166136261;
    for (let c = 0; c < buffer.numberOfChannels; c++) for (const byte of new Uint8Array(buffer.getChannelData(c).buffer)) checksum = Math.imul(checksum ^ byte, 16777619) >>> 0;
    return { peak, hash, checksum, frames: buffer.length, channels: buffer.numberOfChannels };
  }, committed.audioBufferId);
  const before = await renderProof(); expect(before.peak).toBeGreaterThan(0.01);
  await page.reload();
  await expect.poll(async () => page.evaluate(async id => {
    // @ts-ignore
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    return !!audioEngine.getSampleBuffer(id);
  }, committed.audioBufferId)).toBe(true);
  const after = await renderProof(); expect(after).toEqual(before);
  console.log('WAVEFORM_EDITOR_PRODUCTION_PROOF', JSON.stringify({ channels, ...evidence, ...after, reloadExportEqual: true }));
});
