import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Vst3Service } from '../native/vst3/service.mjs';

const build = path.resolve('build/native-vst3'), name = process.platform === 'win32' ? 'apex-vst3-host.exe' : 'apex-vst3-host';
const executable = [path.join(build, 'bin', name), path.join(build, 'bin/Release', name)].find(existsSync);
if (!executable) throw new Error('Build the actual native helper/MDA fixture before the native browser gate');
let service: Vst3Service;
let deferReply = false, releaseReply: (() => void) | undefined, editedCount = 0;
test.beforeEach(() => { deferReply = false; releaseReply = undefined; editedCount = 0; service = new Vst3Service(executable, [path.join(build, 'VST3/Release')]); });
test.afterEach(async () => { releaseReply?.(); await service.dispose(); });
async function setup(page: Page, contract?: string) {
  const plugin = (await service.discover()).plugins.find(p => p.name === 'mda JX10')!;
  const instrument = await service.inspect(plugin);
  // Test-only transport replacing Electron IPC, NOT a processor substitute.
  // All positive metadata/updates/PCM come from the production privileged service.
  await page.exposeFunction('nativeTestCall', async (method: string, args: any[]) => {
    if (method === 'describe' && contract) {
      const p = { id: 6, name: 'Contract read-only', shortTitle: '', units: '', defaultValue: .5, currentValue: .4, flags: 2, stepCount: 0 };
      if (contract === 'absent') return { controllerAvailable: false, parameters: [] };
      if (contract === 'error') throw new Error('Metadata query failed');
      if (contract === 'list-missing' || contract === 'list-invalid') return {
        controllerAvailable: true,
        parameters: [{ ...p, name: 'Contract unlabeled list', flags: 9, stepCount: 2, currentValue: .5,
          ...(contract === 'list-invalid' ? { choices: [{ value: 0, label: 'Incomplete choice table' }] } : {}) }],
      };
      return { controllerAvailable: true, parameters: [p, { ...p, id: 7, name: 'Contract hidden', flags: 16 }, ...Array.from({ length: 70 }, (_, i) => ({ ...p, id: 100 + i, name: `Contract writable ${i}`, flags: 1 }))] };
    }
    switch (method) {
      case 'discover': return service.discover();
      case 'inspect': return service.inspect(args[0], args[1]);
      case 'describe': return service.describe(args[0]);
      case 'open': return service.open(args[0], args[1], args[2]);
      case 'parameters': { const result = await service.parameters(args[0], args[1]); editedCount++; if (deferReply) await new Promise<void>(resolve => { releaseReply = resolve; }); return result; }
      case 'process': return Array.from(await service.process(args[0], args[1], args[2], args[3], 'local', args[4]));
      case 'close': return service.close(args[0]);
      default: throw new Error('Unauthorized test operation');
    }
  });
  await page.addInitScript(() => {
    const call = (method: string, ...args: any[]) => (window as any).nativeTestCall(method, args);
    (window as any).desktopApp = { vst3: {
      discover: () => call('discover'), inspect: (...args: any[]) => call('inspect', ...args),
      describe: (...args: any[]) => call('describe', ...args), open: (...args: any[]) => call('open', ...args),
      parameters: (...args: any[]) => call('parameters', ...args), close: (...args: any[]) => call('close', ...args),
      process: async (...args: any[]) => new Float32Array(await call('process', ...args)),
    } };
  });
  await page.goto('http://localhost:3000');
  await page.locator('#nav-instruments').waitFor();
  await page.evaluate(async instrument => {
    // @ts-ignore actual application modules and IndexedDB, no test-only project model
    const { createDefaultProjectState } = await import('/src/state/projectState.ts');
    // @ts-ignore
    const { persistProjectState } = await import('/src/state/projectPersistence.ts');
    const state = createDefaultProjectState();
    state.channels = [{ ...state.channels[0], instrumentType: 'vst3', vst3: instrument }, { ...state.channels[1], id: 'other-channel', instrumentType: 'minisynth' }];
    state.selectedChannelId = state.channels[0].id;
    await persistProjectState(state);
  }, instrument);
  await page.reload(); await page.locator('#nav-instruments').click();
  return page.getByRole('region', { name: 'VST3 parameter editor', exact: true });
}
async function stored(page: Page) {
  return page.evaluate(async () => {
    // @ts-ignore
    const { getPersistedProjectStateRecord } = await import('/src/audio/audioPersistence.ts');
    return JSON.parse(await getPersistedProjectStateRecord()).state.channels[0].vst3;
  });
}
async function render(page: Page) {
  return page.evaluate(async () => {
    // @ts-ignore
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore
    const { getPersistedProjectStateRecord } = await import('/src/audio/audioPersistence.ts');
    const state = JSON.parse(await getPersistedProjectStateRecord()).state;
    const ch = { ...state.channels[0], notes: [{ id: 'browser-real', pitch: 60, start: 0, duration: 4, velocity: .8 }], volume: 1, pan: 0, mute: false, solo: false };
    const tracks = state.mixerTracks.map((t: any) => ({ ...t, volume: 1, pan: 0, mute: false, solo: false, fxSlots: [] }));
    audioEngine.setMasteringState({ enabled: false });
    const output = await audioEngine.renderTimelineOffline([ch], [{ id: 'param-song', type: 'pattern', channelId: ch.id, trackIndex: 0, startBar: 0, lengthBars: 1, name: 'Native', color: '#fff' }], tracks, 120, 1, 48000, true, 'song', undefined, undefined, undefined, .5);
    const pcm = output.getChannelData(0); let rms = 0, hash = 2166136261;
    for (const sample of pcm) rms += sample ** 2;
    for (const byte of new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return { rms: Math.sqrt(rms / pcm.length), hash, sampleRate: output.sampleRate };
  });
}
test('actual App controls -> real MDA processor -> history/IndexedDB/reload/production song export', async ({ page }) => {
  test.setTimeout(90000);
  const editor = await setup(page);
  await expect(editor.getByRole('slider', { name: 'VCF Freq', exact: false })).toBeVisible();
  const original = await stored(page), reference = await render(page);
  await editor.getByRole('searchbox', { name: 'Search parameters' }).fill('VCF Freq');
  const slider = editor.getByRole('slider', { name: 'VCF Freq', exact: false });
  await slider.fill('0.2'); await slider.fill('0.1'); await slider.fill('0.05');
  expect((await stored(page)).state.parameters).toEqual(original.state.parameters);
  await editor.getByRole('button', { name: 'Apply parameter changes', exact: true }).click();
  await expect.poll(async () => (await stored(page)).state.parameters.find((p: any) => p.id === 6)?.value).toBe(.05);
  const changed = await render(page); expect(changed.hash).not.toBe(reference.hash);
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Undo/ }).click();
  await expect.poll(async () => (await stored(page)).state.parameters).toEqual(original.state.parameters);
  expect(await render(page)).toEqual(reference);
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Redo/ }).click();
  await expect.poll(async () => (await stored(page)).state.parameters.find((p: any) => p.id === 6)?.value).toBe(.05);
  expect(await render(page)).toEqual(changed);
  await page.reload(); await page.locator('#nav-instruments').click();
  expect(await render(page)).toEqual(changed);
  await expect(page.getByRole('slider', { name: 'VCF Freq', exact: false })).toHaveValue('0.05');
  const evidence = { reference, changed, undoRedoReloadExact: true };
  mkdirSync('build/native-evidence', { recursive: true });
  writeFileSync('build/native-evidence/apex-browser-parameter-proof.json', JSON.stringify(evidence, null, 2));
  console.log('NATIVE_BROWSER_PARAMETER_PROOF', JSON.stringify(evidence));
});
for (const contract of ['readonly', 'absent', 'error']) test(`UI negative metadata contract: ${contract} (not native audio evidence)`, async ({ page }) => {
  const editor = await setup(page, contract);
  if (contract === 'absent') await expect(editor).toContainText('no edit controller');
  else if (contract === 'error') await expect(editor.getByRole('alert')).toContainText('Metadata query failed');
  else {
    await expect(editor).toContainText('Read-only');
    expect(await editor.getByRole('slider').count()).toBe(31);
    await expect(editor).not.toContainText('Contract hidden');
    await editor.getByRole('searchbox').fill('writable 69');
    expect(await editor.getByRole('slider').count()).toBe(1);
  }
});

test('late real native acknowledgement after channel switch cannot publish to either channel', async ({ page }) => {
  const editor = await setup(page), original = await stored(page);
  await editor.getByRole('slider', { name: 'VCF Freq', exact: false }).fill('0.05');
  deferReply = true;
  await editor.getByRole('button', { name: 'Apply parameter changes', exact: true }).click();
  await expect.poll(() => editedCount).toBe(1);
  await page.getByRole('combobox', { name: 'Instrument channel', exact: true }).selectOption('other-channel');
  releaseReply!();
  await expect.poll(() => service.sessionCount).toBe(0);
  expect(await stored(page)).toEqual(original);
  await expect(page.getByRole('region', { name: 'VST3 parameter editor', exact: true })).toHaveCount(0);
});

test('failed real service validation leaves the actual App project untouched', async ({ page }) => {
  // Deliberately bad metadata is a negative UI contract fixture. The production
  // service must reject its unknown ID rather than publish this draft.
  const editor = await setup(page, 'readonly'), original = await stored(page);
  await editor.getByRole('searchbox').fill('writable 69');
  await editor.getByRole('slider').fill('0.2');
  await editor.getByRole('button', { name: 'Apply parameter changes', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Unknown or read-only');
  expect(await stored(page)).toEqual(original);
});

test('production desktop smoke algorithm saves edited state and reopens actual App with identical native PCM', async ({ page }) => {
  test.setTimeout(90000);
  await setup(page);
  const smoke = () => page.evaluate(async () => {
    // @ts-ignore exact production script used by packaged Windows smoke
    const { runDesktopVst3Smoke } = await import('/src/audio/nativeVst3DesktopSmoke.ts');
    return runDesktopVst3Smoke();
  });
  const saved = await smoke();
  await page.reload();
  await page.locator('#nav-instruments').waitFor();
  await page.evaluate(() => { (window as any).desktopApp.smokeReopen = true; });
  const reopened = await smoke();
  expect(reopened.pcmChecksum).toBe(saved.pcmChecksum);
  expect(reopened.savedStateChecksum).toBe(saved.savedStateChecksum);
  expect(reopened.parameterValue).toBe(.05);
  expect(reopened.parameterExportDifferenceRms).toBeGreaterThan(.001);
  expect(reopened.uiRestored).toBe(true);
  console.log('NATIVE_SMOKE_ALGORITHM_PROOF', JSON.stringify({ ...reopened, applicationStage: 'cold-page-reload-in-Chromium', proof: 'Production smoke algorithm with real Node service/MDA via test-only transport; NOT packaged Electron IPC or a process-restart claim' }));
});

for (const action of ['close panel', 'reset', 'replace']) test(`pending real edit is fenced immediately on ${action}`, async ({ page }) => {
  const editor = await setup(page), original = await stored(page);
  await editor.getByRole('slider', { name: 'VCF Freq', exact: false }).fill('0.05');
  deferReply = true;
  await editor.getByRole('button', { name: 'Apply parameter changes', exact: true }).click();
  await expect.poll(() => editedCount).toBe(1);
  if (action === 'close panel') await page.getByRole('button', { name: 'VST3 instruments — desktop only', exact: true }).click();
  else if (action === 'reset') await page.getByRole('button', { name: 'Reset to plugin defaults (undoable)', exact: true }).click();
  else await page.getByRole('button', { name: 'Use built-in MiniSynth instead (undoable)', exact: true }).click();
  releaseReply!();
  if (action === 'reset') await expect.poll(async () => (await stored(page)).state.parameters.length).toBe(0);
  else if (action === 'replace') await expect(page.getByRole('region', { name: 'VST3 parameter editor', exact: true })).toHaveCount(0);
  else await expect.poll(() => service.sessionCount).toBe(0);
  expect((await stored(page)).state.parameters).toEqual(original.state.parameters);
});


// Negative metadata contract fixtures: not positive native audio evidence.
for (const contract of ['list-missing', 'list-invalid']) test(`list metadata safety: ${contract} cannot stage or apply a write`, async ({ page }) => {
  const editor = await setup(page, contract), original = await stored(page);
  if (contract === 'list-missing') {
    await expect(editor).toContainText('Contract unlabeled list');
    await expect(editor).toContainText('Normalized: 0.50000');
    await expect(editor).toContainText('List choices unavailable; editing disabled.');
    await editor.getByRole('searchbox').fill('unlabeled');
    await expect(editor).toContainText('1 matching parameters');
  } else {
    // Keep the shared metadata validation fail-closed, not silently accept bad labels.
    await expect(editor.getByRole('alert')).toContainText('Invalid VST3 parameter choices');
  }
  await expect(editor.getByRole('slider')).toHaveCount(0);
  await expect(editor.getByRole('combobox')).toHaveCount(0);
  await expect(editor.getByRole('button', { name: 'Apply parameter changes', exact: true })).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Discard parameter draft', exact: true })).toBeDisabled();
  expect(editedCount).toBe(0);
  expect(await stored(page)).toEqual(original);
});

test('genuine labeled MDA list uses controller choices and applies its selected normalized value', async ({ page }) => {
  const editor = await setup(page), original = await stored(page);
  const metadata = await service.describe(original);
  const glide = metadata.parameters.find(p => p.name === 'Glide');
  expect(glide.flags & 8).toBe(8);
  expect(glide.stepCount).toBeGreaterThan(0);
  expect(glide.choices.length).toBe(glide.stepCount + 1);
  await editor.getByRole('searchbox').fill('Glide');
  const selector = editor.getByRole('combobox', { name: /^Glide · ID / });
  await expect(selector).toBeVisible();
  await expect(editor.getByRole('slider')).toHaveCount(0);
  for (const choice of glide.choices) {
    await expect(selector.getByRole('option', { name: choice.label, exact: true })).toHaveAttribute('value', String(choice.value));
  }
  const choice = glide.choices.find(c => c.value !== glide.currentValue);
  await selector.selectOption(String(choice.value));
  expect(await stored(page)).toEqual(original);
  await editor.getByRole('button', { name: 'Apply parameter changes', exact: true }).click();
  await expect.poll(async () => (await stored(page)).state.parameters.find(p => p.id === glide.id)?.value).toBe(choice.value);
});
