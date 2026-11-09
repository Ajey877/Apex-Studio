import { expect, test, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { createDefaultProjectState } from '../src/state/projectState';
import type { ProjectState } from '../src/types/daw';

const APP_URL = 'http://localhost:3000';

const makePcmWav = (frameCount = 4096): Uint8Array => {
  const sampleRate = 44_100;
  const bytesPerSample = 2;
  const pcmBytes = frameCount * bytesPerSample;
  const bytes = new Uint8Array(44 + pcmBytes);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) bytes[offset + index] = text.charCodeAt(index);
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, pcmBytes, true);
  for (let index = 0; index < frameCount; index += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.25 * 32767);
    view.setInt16(44 + index * bytesPerSample, sample, true);
  }
  return bytes;
};

const stateWithAudio = (name: string, audioId: string): ProjectState => {
  const base = createDefaultProjectState();
  return {
    ...base,
    meta: { ...base.meta, name },
    playlistClips: [{
      id: `browser-zip-clip-${audioId}`,
      trackIndex: 0,
      startBar: 1,
      lengthBars: 1,
      type: 'audio',
      audioBufferId: audioId,
      audioName: 'ZIP Audio',
      audioWaveform: [0.1, 0.8],
      audioUnavailable: false,
      color: '#ff6e00',
      name: 'ZIP Audio',
    }],
  };
};

const makeZipBuffer = async (state: ProjectState, audioId: string, wav: Uint8Array): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file('project_manifest.json', JSON.stringify(state));
  zip.file('audio/1_browser-import.wav', wav);
  zip.file('bundle_manifest.json', JSON.stringify({
    format: 'apex-studio-project-bundle',
    formatVersion: 2,
    audioFiles: [{ id: audioId, path: 'audio/1_browser-import.wav', mimeType: 'audio/wav', size: wav.length }],
  }));
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
};

const openBundleModal = async (page: Page): Promise<void> => {
  await page.locator('#application-menu-file').click();
  await page.locator('[id="application-menu-command-file.exportBundle"]').click();
  await expect(page.locator('#fl-project-zip-modal')).toBeVisible();
};

const readProjectAndAudio = async (page: Page, ids: string[]) => page.evaluate(async audioIds => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('apex-studio-audio', 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<{
      current: { stateJson: string } | undefined;
      recovery: { stateJson: string } | undefined;
      audio: Record<string, { size: number; type: string; text: string } | null>;
      projectKeys: string[];
    }>((resolve, reject) => {
      const transaction = db.transaction(['clips', 'projects'], 'readonly');
      const clips = transaction.objectStore('clips');
      const projects = transaction.objectStore('projects');
      const currentRequest = projects.get('current-project');
      const recoveryRequest = projects.get('recovery-snapshot');
      const keysRequest = projects.getAllKeys();
      const audio: Record<string, Blob | null> = {};
      for (const id of audioIds) {
        const request = clips.get(id);
        request.onsuccess = () => { audio[id] = request.result?.blob ?? null; };
      }
      transaction.oncomplete = async () => {
        const audioInfo: Record<string, { size: number; type: string; text: string } | null> = {};
        for (const id of audioIds) {
          const blob = audio[id];
          audioInfo[id] = blob ? { size: blob.size, type: blob.type, text: await blob.text() } : null;
        }
        resolve({
          current: currentRequest.result,
          recovery: recoveryRequest.result,
          audio: audioInfo,
          projectKeys: (keysRequest.result ?? []).map(String),
        });
      };
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}, ids);

test('Portable ZIP import commits project and decodable audio together, then reports the imported document', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(APP_URL);
  await expect(page.locator('#application-menu-file')).toBeVisible();

  const audioId = 'browser-zip-usable-audio';
  const wav = makePcmWav();
  await openBundleModal(page);
  await page.locator('#fl-project-zip-modal input[type="file"]').setInputFiles({
    name: 'portable-audio.zip',
    mimeType: 'application/zip',
    buffer: await makeZipBuffer(stateWithAudio('Browser ZIP Import', audioId), audioId, wav),
  });

  const confirmation = page.locator('#project-replace-confirm-modal');
  await expect(confirmation).toBeVisible({ timeout: 30_000 });
  await confirmation.locator('#project-replace-confirm-btn').click();
  await expect(page.locator('#fl-project-zip-modal').getByText(/Imported "Browser ZIP Import" and restored 1 audio asset/)).toBeVisible({ timeout: 30_000 });

  const stored = await readProjectAndAudio(page, [audioId]);
  expect(JSON.parse(stored.current!.stateJson).state.meta.name).toBe('Browser ZIP Import');
  expect(stored.recovery!.stateJson).toBe(stored.current!.stateJson);
  expect(stored.audio[audioId]).toMatchObject({ size: wav.length, type: 'audio/wav' });
  expect(stored.projectKeys).toContain('current-project');
  expect(stored.projectKeys).toContain('recovery-snapshot');
  expect(stored.projectKeys.some(key => key.startsWith('backup:'))).toBe(true);
  expect(errors).toEqual([]);
});

test('cancelling the replacement confirmation leaves project records and imported audio unchanged', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(APP_URL);
  await expect(page.locator('#application-menu-file')).toBeVisible();

  const current = createDefaultProjectState();
  current.meta.name = 'Browser Current Project';
  const oldAudioId = 'browser-existing-audio';
  const oldWav = makePcmWav(2048);
  const oldStateJson = JSON.stringify({ persistenceVersion: 1, state: current });
  await page.evaluate(async ({ stateJson, audioId, audioBytes }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('apex-studio-audio', 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('clips')) request.result.createObjectStore('clips', { keyPath: 'id' });
        if (!request.result.objectStoreNames.contains('projects')) request.result.createObjectStore('projects', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(['clips', 'projects'], 'readwrite');
        transaction.objectStore('clips').put({
          id: audioId,
          blob: new Blob([new Uint8Array(audioBytes)], { type: 'audio/wav' }),
          mimeType: 'audio/wav',
          createdAt: 1,
        });
        transaction.objectStore('projects').put({ id: 'current-project', stateJson, updatedAt: 1 });
        transaction.objectStore('projects').put({ id: 'recovery-snapshot', stateJson, updatedAt: 1 });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }, { stateJson: oldStateJson, audioId: oldAudioId, audioBytes: [...oldWav] });

  await page.reload();
  await expect(page.getByText('Browser Current Project', { exact: true }).first()).toBeVisible({ timeout: 30_000 });
  const before = await readProjectAndAudio(page, [oldAudioId, 'browser-cancelled-import-audio']);
  expect(JSON.parse(before.current!.stateJson).state.meta.name).toBe('Browser Current Project');

  const importedAudioId = 'browser-cancelled-import-audio';
  const importWav = makePcmWav();
  await openBundleModal(page);
  await page.locator('#fl-project-zip-modal input[type="file"]').setInputFiles({
    name: 'cancelled-portable-audio.zip',
    mimeType: 'application/zip',
    buffer: await makeZipBuffer(stateWithAudio('Should Not Replace', importedAudioId), importedAudioId, importWav),
  });

  const confirmation = page.locator('#project-replace-confirm-modal');
  await expect(confirmation).toBeVisible({ timeout: 30_000 });
  await confirmation.locator('#project-replace-cancel-btn').click();
  await expect(page.locator('#fl-project-zip-modal').getByText(/Import cancelled — the current project was kept unchanged/)).toBeVisible();

  const after = await readProjectAndAudio(page, [oldAudioId, importedAudioId]);
  expect(JSON.parse(after.current!.stateJson).state.meta.name).toBe('Browser Current Project');
  expect(after.recovery!.stateJson).toBe(before.recovery!.stateJson);
  expect(after.audio[oldAudioId]).toMatchObject({ size: oldWav.length, type: 'audio/wav' });
  expect(after.audio[importedAudioId]).toBeNull();
  expect(after.projectKeys.some(key => key.startsWith('backup:'))).toBe(false);
  expect(errors).toEqual([]);
});
