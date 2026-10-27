import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Vst3Service } from '../native/vst3/service.mjs';
import { VST3_FX_PIPELINE_FRAMES } from '../src/audio/nativeVst3EffectRuntime';

const build = path.resolve('build/native-vst3');
const hostName = process.platform === 'win32' ? 'apex-vst3-host.exe' : 'apex-vst3-host';
const executable = [path.join(build, 'bin', hostName), path.join(build, 'bin/Release', hostName)].find(existsSync);
if (!executable) throw new Error('Build the native helper and redistributable MDA VST3 fixtures before Mixer-effect browser tests');
const fixtureRoot = path.join(build, 'VST3/Release');
let service: Vst3Service;
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
    const makeChannel = (id: string, name: string, mixerTrackId: number, pitch: number) => ({
      ...source, id, name, instrumentType: 'minisynth', mixerTrackId, volume: 1, pan: 0, mute: false, solo: false,
      steps: Array(16).fill(false), notes: [{ id: `${id}-note`, pitch, start: 0, duration: 8, velocity: 0.8 }],
    });
    state.channels = [makeChannel('mixer-fx-target', 'VST3 target signal', 1, 60), makeChannel('mixer-fx-isolation', 'Unprocessed control signal', 2, 67)];
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

async function captureProductionMixer(page: Page) {
  const captured = await page.evaluate(async () => {
    // @ts-ignore actual application AudioEngine singleton
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore actual mastering state
    const { DEFAULT_MASTERING_SUITE_STATE } = await import('/src/audio/masteringState.ts');
    // @ts-ignore read the actual persisted project snapshot
    const { getPersistedProjectStateRecord } = await import('/src/audio/audioPersistence.ts');
    const state = JSON.parse(await getPersistedProjectStateRecord()).state;
    audioEngine.init();
    audioEngine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
    audioEngine.setBpm(120);
    const context = audioEngine.getContext();
    await context.resume();
    const source = `class ApexMixerAcceptanceCapture extends AudioWorkletProcessor {
      constructor(){super();this.left=new Float32Array(1024);this.right=new Float32Array(1024);this.fill=0;this.capture=false;this.port.onmessage=event=>{this.capture=event.data==='start';};}
      process(inputs,outputs){const input=inputs[0],out=outputs[0];if(out)for(const channel of out)channel.fill(0);
        if(!this.capture)return true;const l=input&&input[0],r=input&&(input[1]||input[0]);if(!l||!r)return true;
        for(let i=0;i<l.length;i++){this.left[this.fill]=l[i];this.right[this.fill]=r[i];if(++this.fill===1024){const pcm=new Float32Array(2048);pcm.set(this.left);pcm.set(this.right,1024);this.port.postMessage(pcm,[pcm.buffer]);this.fill=0;}}
        return true;}
    } registerProcessor('apex-mixer-acceptance-capture',ApexMixerAcceptanceCapture);`;
    const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
    try { await context.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const captures = new Map<number, { blocks: Float32Array[]; node: AudioWorkletNode; silent: GainNode }>();
    for (const trackId of [1, 2]) {
      const mixer = audioEngine.getOrCreateMixerChannel(trackId);
      const node = new AudioWorkletNode(context, 'apex-mixer-acceptance-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
      const blocks: Float32Array[] = [];
      node.port.onmessage = event => { if (event.data instanceof Float32Array) blocks.push(event.data); };
      const silent = context.createGain(); silent.gain.value = 0;
      mixer.analyser.connect(node); node.connect(silent); silent.connect(context.destination);
      captures.set(trackId, { blocks, node, silent });
    }
    await audioEngine.play(state.channels, [], 'pat', undefined, state.mixerTracks, 16);
    for (const capture of captures.values()) capture.node.port.postMessage('start');
    await new Promise(resolve => setTimeout(resolve, 1800));
    for (const capture of captures.values()) capture.node.port.postMessage('stop');
    await new Promise(resolve => setTimeout(resolve, 20));
    audioEngine.stop();
    await audioEngine.releaseNativeInstruments();
    await new Promise(resolve => setTimeout(resolve, 80));
    const output: Record<string, { rms: number; frames: number; pcm: Float32Array[] }> = {};
    for (const [trackId, capture] of captures) {
      capture.node.port.close(); capture.node.disconnect(); capture.silent.disconnect();
      const samples = capture.blocks;
      let square = 0, count = 0;
      for (const block of samples) for (const sample of block) { square += sample * sample; count++; }
      output[String(trackId)] = { rms: count ? Math.sqrt(square / count) : 0, frames: count / 2, pcm: samples };
    }
    const captureId = crypto.randomUUID();
    const store = (window as any).__nativeMixerFxCaptures ??= {};
    store[captureId] = output;
    return { captureId, tracks: Object.fromEntries(Object.entries(output).map(([id, value]) => [id, { rms: value.rms, frames: value.frames }])) };
  });
  // The test starts/stops AudioEngine directly to tap its real Mixer analysers.
  // Synchronize App's transport state through its actual Stop control so Mixer
  // edit controls are enabled before subsequent assertions/gestures.
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  return captured;
}

async function compareCapture(page: Page, leftId: string, rightId: string, trackId: string, rightOffsetFrames = 0) {
  return page.evaluate(({ leftId, rightId, trackId, rightOffsetFrames }) => {
    const store = (window as any).__nativeMixerFxCaptures;
    const left = store?.[leftId]?.[trackId]?.pcm as Float32Array[] | undefined;
    const right = store?.[rightId]?.[trackId]?.pcm as Float32Array[] | undefined;
    if (!left || !right) throw new Error('PCM capture was not retained in the browser test page');
    const a = left.flatMap(block => Array.from(block)), b = right.flatMap(block => Array.from(block));
    const offsetSamples = rightOffsetFrames * 2;
    const count = Math.min(a.length, b.length - offsetSamples);
    let sum = 0;
    for (let index = 0; index < count; index++) sum += (a[index]! - b[index + offsetSamples]!) ** 2;
    delete store[leftId]; delete store[rightId];
    return count ? Math.sqrt(sum / count) : 0;
  }, { leftId, rightId, trackId, rightOffsetFrames });
}

test('actual Mixer UI -> MDA inserts -> AudioEngine live capture, track isolation, order, bypass, persistence and undo/redo', async ({ page }) => {
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

  const orderA = await captureProductionMixer(page);
  const rezFilterCard = page.getByRole('button', { name: 'Bypass mda RezFilter', exact: true }).locator('xpath=../../..');
  const moveRezFilterEarlier = rezFilterCard.getByTitle('Move effect earlier in chain');
  await expect(moveRezFilterEarlier).toBeEnabled();
  await moveRezFilterEarlier.click();
  await expect.poll(async () => (await persisted(page)).mixerTracks.find((track: any) => track.id === 1).fxSlots.map((slot: any) => slot.vst3Effect.name)).toEqual(['mda RezFilter', 'mda Delay']);
  const orderB = await captureProductionMixer(page);
  const track1OrderDifference = await compareCapture(page, orderA.captureId, orderB.captureId, '1');
  expect(orderA.tracks['1']!.rms).toBeGreaterThan(1e-4);
  expect(orderB.tracks['1']!.rms).toBeGreaterThan(1e-4);
  expect(track1OrderDifference).toBeGreaterThan(1e-4);
  const controlRmsDifference = Math.abs(orderA.tracks['2']!.rms - orderB.tracks['2']!.rms);
  expect(orderA.tracks['2']!.rms).toBeGreaterThan(1e-4);
  expect(controlRmsDifference).toBeLessThan(Math.max(0.005, orderA.tracks['2']!.rms * 0.15));

  // Plugin bypass keeps both native FIFOs. Mixer-slot bypass removes the Delay
  // node, so align the shorter capture by exactly its declared fixed pipeline
  // buffer; this comparison does not claim inter-track compensation.
  const delayBypass = page.getByRole('slider', { name: 'Bypass · mda Delay' });
  await delayBypass.fill('1');
  await page.getByRole('button', { name: 'Apply native parameters' }).nth(1).click();
  const pluginBypass = await captureProductionMixer(page);
  await page.getByRole('button', { name: 'Bypass mda Delay' }).click();
  const slotBypass = await captureProductionMixer(page);
  const bypassDifference = await compareCapture(page, pluginBypass.captureId, slotBypass.captureId, '1', VST3_FX_PIPELINE_FRAMES);
  expect(bypassDifference).toBeLessThan(Math.max(0.02, pluginBypass.tracks['1']!.rms * 0.25));

  const proof = {
    plugins: ['mda Delay', 'mda RezFilter'],
    liveOrderDifferenceRms: track1OrderDifference,
    unaffectedTrackRmsBefore: orderA.tracks['2']!.rms,
    unaffectedTrackRmsAfter: orderB.tracks['2']!.rms,
    bypassDifferenceRms: bypassDifference,
    savedParametersAndUndoRedoReopen: true,
    capture: 'production AudioClockTransport and live Mixer track AnalyserNode tapped by a test-only PCM AudioWorklet; input is scheduled project MiniSynth note data',
    processedProductionWav: exportProof,
    missingPluginExportFailure: missingPluginFailure,
  };
  mkdirSync('build/native-evidence', { recursive: true });
  writeFileSync('build/native-evidence/apex-mixer-effect-browser-proof.json', JSON.stringify(proof, null, 2));
  console.log('NATIVE_MIXER_EFFECT_BROWSER_PROOF', JSON.stringify(proof));
});
