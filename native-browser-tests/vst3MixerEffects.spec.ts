import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Vst3Service } from '../native/vst3/service.mjs';

const build = path.resolve('build/native-vst3');
const hostName = process.platform === 'win32' ? 'apex-vst3-host.exe' : 'apex-vst3-host';
const executable = [path.join(build, 'bin', hostName), path.join(build, 'bin/Release', hostName)].find(existsSync);
if (!executable) throw new Error('Build the native helper and redistributable MDA VST3 fixtures before Mixer-effect browser tests');
const fixtureRoot = path.join(build, 'VST3/Release');
let service: Vst3Service;
// This spec owns actual UI/state/history and offline export integration. Live Mixer PCM and timing are accepted only in the packaged Electron smoke through production IPC/preload.
test.beforeEach(() => { service = new Vst3Service(executable!, [fixtureRoot]); });
test.afterEach(async () => { await service.dispose(); });

async function setupProject(page: Page) {
  await page.exposeFunction('nativeMixerFxCall', async (method: string, args: any[]) => {
    switch (method) {
      case 'discoverEffects': return service.discover('mixer-browser', 'effect');
      case 'inspectEffect': return service.inspectEffect(args[0], args[1], 'mixer-browser');
      case 'describeEffect': return service.describeEffect(args[0], 'mixer-browser');
      case 'open': return service.open(args[0], args[1], args[2], 'mixer-browser', args[3] ?? 'instrument');
      case 'parameters': return service.parameters(args[0], args[1], 'mixer-browser');
      case 'processAudio': { const bytes = Buffer.from(args[2], 'base64'); const input = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); const output = await service.processAudio(args[0], args[1], input, args[3], 'mixer-browser', args[4] ?? []); return Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString('base64'); }
      case 'close': return service.close(args[0], 'mixer-browser');
      default: throw new Error(`Unauthorized Mixer-effect test operation: ${method}`);
    }
  });
  await page.addInitScript(() => {
    const call = (method: string, ...args: any[]) => (window as any).nativeMixerFxCall(method, args);
    (window as any).desktopApp = { isDesktop: true, vst3: {
      discoverEffects: () => call('discoverEffects'),
      inspectEffect: (...args: any[]) => call('inspectEffect', ...args),
      describeEffect: (...args: any[]) => call('describeEffect', ...args),
      open: (...args: any[]) => call('open', ...args),
      parameters: (...args: any[]) => call('parameters', ...args),
      processAudio: async (...args: any[]) => {
        const input = args[2] as Float32Array;
        const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x4000) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x4000, bytes.length)));
        const encoded = await call('processAudio', args[0], args[1], btoa(binary), args[3], args[4]);
        const decoded = atob(encoded);
        const output = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) output[i] = decoded.charCodeAt(i);
        return new Float32Array(output.buffer);
      },
      close: id => call('close', id),
    } };
  });
  await page.goto('http://localhost:3000');
  await page.locator('#nav-mixer').waitFor();
  await page.evaluate(async () => {
    // @ts-ignore use the actual project model and persistence boundary
    const { createDefaultProjectState } = await import('/src/state/projectState.ts');
    // @ts-ignore
    const { persistProjectState } = await import('/src/state/projectPersistence.ts');
    const state = createDefaultProjectState();
    const source = state.channels[0];
    const makeChannel = (id: string, name: string, mixerTrackId: number, pitch: number, duration: number) => ({
      ...source, id, name, instrumentType: 'minisynth', mixerTrackId, volume: 1, pan: 0, mute: false, solo: false,
      steps: Array(16).fill(false), notes: [{ id: `${id}-note`, pitch, start: 0, duration, velocity: 0.8 }],
    });
    state.channels = [makeChannel('mixer-fx-target', 'VST3 target signal', 1, 60, 16), makeChannel('mixer-fx-isolation', 'Unprocessed control signal', 2, 67, 16)];
    state.mixerTracks = state.mixerTracks.map((track: any) => ({ ...track,
      volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], routingTargetId: 0, auxSends: undefined,
    }));
    state.selectedChannelId = 'mixer-fx-target';
    await persistProjectState(state);
  });
  await page.reload();
  await page.locator('#nav-mixer').click();
  await page.locator('#mixer-strip-1').getByText('INS 1', { exact: true }).click();
  await expect(page.getByText('FX SLOTS (KICK / 808)', { exact: true })).toBeVisible();
}

async function addEffect(page: Page, name: string) {
  await page.getByTitle('Add Effect Plugin').click();
  await page.getByRole('button', { name: 'Native VST3 Effect', exact: true }).click();
  const picker = page.getByRole('region', { name: 'VST3 effect picker' });
  await expect(picker).toContainText(name, { timeout: 30000 });
  await picker.getByRole('button', { name: new RegExp(name) }).click();
  await expect(picker).toHaveCount(0, { timeout: 30000 });
}

async function persisted(page: Page) {
  return page.evaluate(async () => {
    // @ts-ignore read the real IndexedDB project record
    const { getPersistedProjectStateRecord } = await import('/src/audio/audioPersistence.ts');
    return JSON.parse(await getPersistedProjectStateRecord()).state;
  });
}

test('actual Mixer UI -> MDA inserts -> order/persistence, undo/redo, production export and missing-plugin safety', async ({ page }) => {
  test.setTimeout(120000);
  await setupProject(page);
  await addEffect(page, 'mda Delay');
  await addEffect(page, 'mda RezFilter');
  await expect.poll(async () => (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots.map((slot: any) => slot.vst3Effect?.name)).toEqual(['mda Delay', 'mda RezFilter']);
  const initial = await persisted(page);
  let slots = initial.mixerTracks.find((track: any) => track.id === 1).fxSlots;
  expect(slots.map((slot: any) => slot.vst3Effect?.name)).toEqual(['mda Delay', 'mda RezFilter']);

  const delayValue = page.getByRole('slider', { name: 'L Delay · mda Delay' });
  await delayValue.fill('0.08');
  await page.getByRole('slider', { name: 'Fb Mix · mda Delay' }).fill('0.9');
  await page.getByRole('button', { name: 'Apply native parameters' }).first().click();
  await expect.poll(async () => (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots[0].vst3Effect.state.parameters.length).toBeGreaterThan(0);
  const delaySlot = (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots[0];
  expect(delaySlot.vst3Effect.state.parameters).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 0, value: 0.08 }), expect.objectContaining({ id: 4, value: 0.9 }),
  ]));

  await page.getByRole('slider', { name: 'Freq · mda RezFilter', exact: true }).fill('0.12');
  await page.getByRole('button', { name: 'Apply native parameters' }).nth(1).click();
  await expect.poll(async () => (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots[1].vst3Effect.state.parameters.some((parameter: any) => parameter.id === 0 && parameter.value === 0.12)).toBe(true);

  // A parameter gesture is one project-history operation and survives Undo/Redo.
  await page.getByRole('slider', { name: 'Freq · mda RezFilter', exact: true }).fill('0.2');
  await page.getByRole('button', { name: 'Apply native parameters' }).nth(1).click();
  await expect.poll(async () => (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots[1].vst3Effect.state.parameters.find((parameter: any) => parameter.id === 0)?.value).toBe(0.2);
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Undo/ }).click();
  await expect.poll(async () => (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots[1].vst3Effect.state.parameters.find((parameter: any) => parameter.id === 0)?.value).toBe(0.12);
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Redo/ }).click();
  await expect.poll(async () => (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots[1].vst3Effect.state.parameters.find((parameter: any) => parameter.id === 0)?.value).toBe(0.2);

  await page.reload();
  await page.locator('#nav-mixer').click();
  await page.locator('#mixer-strip-1').getByText('INS 1', { exact: true }).click();
  await expect(page.getByText('FX SLOTS (KICK / 808)', { exact: true })).toBeVisible();
  slots = (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots;
  expect(slots.map((slot: any) => slot.vst3Effect?.name)).toEqual(['mda Delay', 'mda RezFilter']);
  expect(slots[0].vst3Effect.state.parameters).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 0, value: 0.08 }), expect.objectContaining({ id: 4, value: 0.9 }),
  ]));
  expect(slots[1].vst3Effect.state.parameters.find((parameter: any) => parameter.id === 0)?.value).toBe(0.2);

  // Exercise the actual WAV production path, then decode the emitted WAV back
  // to PCM and compare it against the explicit dry-export choice.
  const exportProof = await page.evaluate(async () => {
    // @ts-ignore real engine and project renderer
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore
    const { getPersistedProjectStateRecord } = await import('/src/audio/audioPersistence.ts');
    const state = JSON.parse(await getPersistedProjectStateRecord()).state;
    const clips = state.channels.map((channel: any, index: number) => ({
      id: `mixer-fx-export-${channel.id}`, type: 'pattern', channelId: channel.id, trackIndex: index,
      startBar: 0, lengthBars: 1, name: channel.name, color: '#fff',
    }));
    const wetWav = await audioEngine.renderProjectToWav(state.channels, clips, 120, 1, 16, state.mixerTracks, true);
    const dryWav = await audioEngine.renderProjectToWav(state.channels, clips, 120, 1, 16, state.mixerTracks, false);
    const context = audioEngine.getContext();
    const wet = await context.decodeAudioData(await wetWav.arrayBuffer());
    const dry = await context.decodeAudioData(await dryWav.arrayBuffer());
    const channels = Math.min(wet.numberOfChannels, dry.numberOfChannels, 2);
    const frames = Math.min(wet.length, dry.length);
    let diff = 0, energy = 0;
    for (let channel = 0; channel < channels; channel++) {
      const a = wet.getChannelData(channel), b = dry.getChannelData(channel);
      for (let frame = 0; frame < frames; frame++) { diff += (a[frame]! - b[frame]!) ** 2; energy += a[frame]! ** 2; }
    }
    return { wetFrames: wet.length, dryFrames: dry.length, sampleRate: wet.sampleRate, rmsDifference: Math.sqrt(diff / (frames * channels)), wetRms: Math.sqrt(energy / (frames * channels)), wetChannels: wet.numberOfChannels };
  });
  expect(exportProof.wetFrames).toBeGreaterThan(0);
  expect(exportProof.wetChannels).toBe(2);
  expect(exportProof.rmsDifference).toBeGreaterThan(1e-4);

  const missingPluginFailure = await page.evaluate(async missingPath => {
    // @ts-ignore real engine and IndexedDB project persistence
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore
    const { getPersistedProjectStateRecord } = await import('/src/audio/audioPersistence.ts');
    const persisted = JSON.parse(await getPersistedProjectStateRecord()).state;
    const original = persisted.mixerTracks.find((track: any) => track.id === 1).fxSlots.find((slot: any) => slot.type === 'vst3' && slot.enabled).vst3Effect.path;
    const renderState = structuredClone(persisted);
    const effect = renderState.mixerTracks.find((track: any) => track.id === 1).fxSlots.find((slot: any) => slot.type === 'vst3' && slot.enabled).vst3Effect;
    effect.path = missingPath;
    const clips = renderState.channels.map((channel: any, index: number) => ({
      id: `missing-plugin-${channel.id}`, type: 'pattern', channelId: channel.id, trackIndex: index,
      startBar: 0, lengthBars: 1, name: channel.name, color: '#fff',
    }));
    try {
      await audioEngine.renderProjectToWav(renderState.channels, clips, 120, 1, 16, renderState.mixerTracks, true);
      return { message: 'unexpected success', savedPathUnchanged: false };
    } catch (error) {
      const reloaded = JSON.parse(await getPersistedProjectStateRecord()).state;
      const savedPath = reloaded.mixerTracks.find((track: any) => track.id === 1).fxSlots.find((slot: any) => slot.type === 'vst3' && slot.enabled).vst3Effect.path;
      return { message: error instanceof Error ? error.message : String(error), savedPathUnchanged: savedPath === original };
    }
  }, path.join(fixtureRoot, 'missing-native-mixer-effect.vst3'));
  expect(missingPluginFailure.message).toContain('VST3 plugin missing');
  expect(missingPluginFailure.savedPathUnchanged).toBe(true);

  console.log('NATIVE_MIXER_EXPORT_AND_FAILURE_PROOF', JSON.stringify({ exportProof, missingPluginFailure }));

  const originalOrder = ['mda Delay', 'mda RezFilter'];
  const rezFilterCard = page.getByRole('button', { name: 'Bypass mda RezFilter', exact: true }).locator('xpath=../../..');
  const moveRezFilterEarlier = rezFilterCard.getByTitle('Move effect earlier in chain');
  await expect(moveRezFilterEarlier).toBeEnabled();
  await moveRezFilterEarlier.click();
  const reversedOrder = ['mda RezFilter', 'mda Delay'];
  await expect.poll(async () => (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots.map((slot: any) => slot.vst3Effect.name)).toEqual(reversedOrder);
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Undo/ }).click();
  await expect.poll(async () => (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots.map((slot: any) => slot.vst3Effect.name)).toEqual(originalOrder);
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Redo/ }).click();
  await expect.poll(async () => (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots.map((slot: any) => slot.vst3Effect.name)).toEqual(reversedOrder);

  // Browser assertions intentionally stop at UI/state/history and offline WAV
  // export. Real-time PCM/order/isolation/bypass/deadline/stop-restart acceptance
  // is owned by the packaged Electron smoke through production preload IPC.
  // Slot bypass is a project-level enabled flag, distinct from native plugin
  // parameters. Native parameter persistence is covered above; exercise the
  // actual Mixer bypass control and its history/persistence here.
  await page.getByRole('button', { name: 'Bypass mda Delay' }).click();
  await expect.poll(async () => (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots
    .find((slot: any) => slot.vst3Effect.name === 'mda Delay').enabled).toBe(false);
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Undo/ }).click();
  await expect.poll(async () => (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots
    .find((slot: any) => slot.vst3Effect.name === 'mda Delay').enabled).toBe(true);
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Redo/ }).click();
  await expect.poll(async () => (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots
    .find((slot: any) => slot.vst3Effect.name === 'mda Delay').enabled).toBe(false);
  await page.reload();
  const reloaded = await persisted(page);
  const reloadedTrack = reloaded.mixerTracks.find((track: any) => track.id === 1);
  expect(reloadedTrack.fxSlots.map((slot: any) => slot.vst3Effect.name)).toEqual(reversedOrder);
  expect(reloadedTrack.fxSlots.find((slot: any) => slot.vst3Effect.name === 'mda Delay').enabled).toBe(false);

  const proof = {
    plugins: ['mda Delay', 'mda RezFilter'],
    savedOrderUndoRedoReload: { originalOrder, reversedOrder, exact: reloadedTrack.fxSlots.map((slot: any) => slot.vst3Effect.name) },
    bypassParameterAndSlotStateUndoRedoReload: true,
    browserScope: 'Actual Mixer UI/plugin discovery/parameter persistence/history plus production WAV export only; no live-path performance claim from page.exposeFunction.',
    processedProductionWav: exportProof,
    missingPluginExportFailure: missingPluginFailure,
  };
  mkdirSync('build/native-evidence', { recursive: true });
  writeFileSync('build/native-evidence/apex-mixer-effect-browser-proof.json', JSON.stringify(proof, null, 2));
  console.log('NATIVE_MIXER_EFFECT_BROWSER_PROOF', JSON.stringify(proof));
});
