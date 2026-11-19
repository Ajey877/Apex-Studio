// Phase 10G — streamed VST3 song export.
//
// Real Chromium, the production engine modules, the real native helper with the
// MDA fixtures and the real main-process export store writing real files. Only
// the transport is test-owned: Electron IPC is replaced by Playwright bindings
// (base64), exactly as in the other native specs. The packaged Electron smoke
// owns the IPC/preload path itself.
import { test, expect, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vst3Service } from '../native/vst3/service.mjs';
// @ts-ignore CommonJS main-process module
import exportStoreModule from '../desktop-export.cjs';

const { createExportStore, parseWavHeader, WAV_HEADER_BYTES } = exportStoreModule as any;
const build = path.resolve('build/native-vst3');
const hostName = process.platform === 'win32' ? 'apex-vst3-host.exe' : 'apex-vst3-host';
const executable = [path.join(build, 'bin', hostName), path.join(build, 'bin/Release', hostName)].find(existsSync);
if (!executable) throw new Error('Build the native helper and redistributable MDA VST3 fixtures before streamed-export browser tests');
const fixtureRoot = path.join(build, 'VST3/Release');
const OWNER = 'streamed-export';

type Hooks = {
  vst3?: (method: string, args: any[]) => Promise<{ value: unknown } | void> | { value: unknown } | void;
  store?: (method: string, args: any[]) => Promise<void> | void;
};
let service: Vst3Service;
let store: any;
let workDir: string;
let saveDir: string;
let hooks: Hooks;
let peakSessions: number;
let instruments: Record<string, any>;
let effects: Record<string, any>;

const b64 = (view: ArrayBufferView) => Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');
const filesUnder = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (current: string) => {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full); else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
};

test.beforeEach(async ({ page }) => {
  service = new Vst3Service(executable!, [fixtureRoot]);
  workDir = mkdtempSync(path.join(os.tmpdir(), 'apex-streamed-export-'));
  saveDir = path.join(workDir, 'saved');
  mkdirSync(saveDir);
  store = createExportStore({ root: path.join(workDir, 'store') });
  hooks = {};
  peakSessions = 0;
  instruments = {};
  effects = {};
  for (const plugin of (await service.discover(OWNER)).plugins) instruments[plugin.name] = await service.inspect(plugin, undefined, OWNER);
  for (const name of ['mda Delay', 'mda Overdrive', 'mda RezFilter', 'mda Image', 'mda Limiter', 'mda Dynamics', 'mda Bandisto', 'mda Combo']) {
    const plugin = (await service.discover(OWNER, 'effect')).plugins.find((candidate: any) => candidate.name === name);
    if (!plugin) throw new Error(`MDA effect fixture ${name} is missing`);
    effects[name] = await service.inspectEffect(plugin, undefined, OWNER);
  }

  await page.exposeFunction('streamedVst3Call', async (method: string, args: any[]) => {
    const hooked = await hooks.vst3?.(method, args);
    if (hooked) return hooked.value;
    switch (method) {
      case 'discover': return service.discover(OWNER);
      case 'discoverEffects': return service.discover(OWNER, 'effect');
      case 'open': {
        const opened = await service.open(args[0], args[1], args[2], OWNER, args[3] ?? 'instrument');
        peakSessions = Math.max(peakSessions, service.sessionCount);
        return opened;
      }
      case 'process': return b64(await service.process(args[0], args[1], args[2], args[3], OWNER, args[4] ?? undefined));
      case 'processAudio': {
        const bytes = Buffer.from(args[2], 'base64');
        const input = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        return b64(await service.processAudio(args[0], args[1], input, args[3], OWNER, args[4] ?? undefined));
      }
      case 'close': return service.close(args[0], OWNER);
      default: throw new Error(`Unauthorized streamed-export test operation: ${method}`);
    }
  });
  await page.exposeFunction('streamedStoreCall', async (method: string, args: any[]) => {
    await hooks.store?.(method, args);
    switch (method) {
      case 'begin': return store.begin(OWNER, args[0]);
      case 'write': return store.write(OWNER, args[0], args[1], Buffer.from(args[2], 'base64'));
      case 'createScratch': return store.createScratch(OWNER, args[0]);
      case 'appendScratch': return store.appendScratch(OWNER, args[0], args[1], Buffer.from(args[2], 'base64'));
      case 'readScratch': return b64(await store.readScratch(OWNER, args[0], args[1], args[2], args[3]));
      case 'releaseScratch': return store.releaseScratch(OWNER, args[0], args[1]);
      case 'finalize': return store.finalize(OWNER, args[0], args[1]);
      // The production handler shows a save dialog; the test names the destination folder instead.
      case 'save': return { canceled: false, ...(await store.save(OWNER, args[0], path.join(saveDir, path.basename(String(args[1]))))) };
      case 'abort': return store.abort(OWNER, args[0]);
      case 'stats': return store.stats(OWNER, args[0]);
      default: throw new Error(`Unauthorized export-store test operation: ${method}`);
    }
  });
  await page.addInitScript(() => {
    const encode = (bytes: Uint8Array) => {
      let text = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)) as unknown as number[]);
      return btoa(text);
    };
    const decode = (text: string) => {
      const binary = atob(text);
      const out = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
      return out;
    };
    const pcm = (text: string) => { const bytes = decode(text); return new Float32Array(bytes.buffer, 0, bytes.length / 4); };
    const vst3 = (method: string, ...args: any[]) => (window as any).streamedVst3Call(method, args);
    const exportStore = (method: string, ...args: any[]) => (window as any).streamedStoreCall(method, args);
    (window as any).desktopApp = {
      isDesktop: true,
      vst3: {
        discover: () => vst3('discover'),
        discoverEffects: () => vst3('discoverEffects'),
        open: (...args: any[]) => vst3('open', ...args),
        close: (id: string) => vst3('close', id),
        process: async (id: string, frames: number, events: unknown, bpm: number, parameters: unknown) => pcm(await vst3('process', id, frames, events, bpm, parameters)),
        processAudio: async (id: string, frames: number, audio: Float32Array, bpm: number, parameters: unknown) =>
          pcm(await vst3('processAudio', id, frames, encode(new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)), bpm, parameters)),
      },
      exportStore: {
        begin: (config: unknown) => exportStore('begin', config),
        write: (jobId: string, sequence: number, bytes: Uint8Array) => exportStore('write', jobId, sequence, encode(bytes)),
        createScratch: (jobId: string) => exportStore('createScratch', jobId),
        appendScratch: (jobId: string, scratchId: string, bytes: Uint8Array) => exportStore('appendScratch', jobId, scratchId, encode(bytes)),
        readScratch: async (jobId: string, scratchId: string, offset: number, length: number) => decode(await exportStore('readScratch', jobId, scratchId, offset, length)),
        releaseScratch: (jobId: string, scratchId: string) => exportStore('releaseScratch', jobId, scratchId),
        finalize: (jobId: string, result: unknown) => exportStore('finalize', jobId, result),
        save: (jobId: string, name: string) => exportStore('save', jobId, name),
        abort: (jobId: string) => exportStore('abort', jobId),
        stats: (jobId: string) => exportStore('stats', jobId),
      },
    };
  });
  await page.goto('http://localhost:3000');
  await page.locator('#fl-export-btn').waitFor();
});

test.afterEach(async () => {
  await service.dispose();
  await store.disposeAll();
  rmSync(workDir, { recursive: true, force: true });
});

// ---- project fixtures -------------------------------------------------------
const colors = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#eab308'];
const track = (id: number, extra: Record<string, unknown> = {}) => ({
  id, name: id === 0 ? 'Master' : `Ins ${id}`, color: colors[id % 8], volume: 1, pan: 0, mute: false, solo: false, fxSlots: [] as any[], peakL: 0, peakR: 0, ...extra,
});
const nativeSlot = (id: string, effect: any) => ({ id, type: 'vst3', name: effect.name, enabled: true, mix: 1, params: {}, vst3Effect: effect });
const line = (prefix: string, base: number, length = 2) => [[0, base], [4, base + 4], [8, base + 7], [12, base + 12]]
  .map(([start, pitch], index) => ({ id: `${prefix}-${index}`, pitch, start, duration: length, velocity: 0.8 }));
const channel = (id: string, mixerTrackId: number, extra: Record<string, unknown> = {}) => ({
  id, name: id, color: colors[mixerTrackId % 8], instrumentType: 'minisynth', mixerTrackId, volume: 0.8, pan: 0, pitch: 0, mute: false, solo: false,
  steps: Array(16).fill(false), notes: [] as any[], ...extra,
});
const nativeChannel = (id: string, mixerTrackId: number, instrument: string, base: number, extra: Record<string, unknown> = {}) =>
  channel(id, mixerTrackId, { instrumentType: 'vst3', vst3: instruments[instrument], notes: line(id, base), ...extra });
const clip = (id: string, channelId: string, lengthBars: number, trackIndex = 0) =>
  ({ id, trackIndex, startBar: 0, lengthBars, type: 'pattern', channelId, color: '#10b981', name: id });

function eightPlusEight(totalBars: number) {
  const names = ['mda Piano', 'mda EPiano', 'mda DX10', 'mda JX10'].filter(name => instruments[name]);
  const fx = ['mda Delay', 'mda Overdrive', 'mda RezFilter', 'mda Image', 'mda Limiter', 'mda Dynamics', 'mda Bandisto', 'mda Combo'];
  const channels: any[] = [], clips: any[] = [], tracks: any[] = [track(0)];
  for (let index = 0; index < 8; index += 1) {
    channels.push(nativeChannel(`v${index}`, index + 1, names[index % names.length]!, 40 + index * 3, { volume: 0.35 }));
    clips.push(clip(`c${index}`, `v${index}`, totalBars, index));
    tracks.push(track(index + 1, { fxSlots: [nativeSlot(`f${index}`, effects[fx[index]!])] }));
  }
  return { bpm: 120, totalBars, channels, clips, tracks };
}

type RunConfig = {
  project: { bpm: number; totalBars: number; channels: any[]; clips: any[]; tracks: any[] };
  sampleRate?: number; bitDepth?: 16 | 24 | 32; reference?: boolean; streamed?: boolean; fileName?: string; abortAtProgress?: number;
};
/** Renders in the page with the production engine: optionally the in-memory reference, then the streamed export. */
async function run(page: Page, config: RunConfig) {
  return page.evaluate(async (cfg: RunConfig) => {
    // @ts-ignore actual application modules
    const { audioEngine: engine } = await import('/src/audio/audioEngine.ts');
    // @ts-ignore
    const { DEFAULT_MASTERING_SUITE_STATE } = await import('/src/audio/masteringState.ts');
    // @ts-ignore
    const { audioBufferToWav } = await import('/src/audio/wavEncoder.ts');
    // @ts-ignore
    const { DesktopStreamedWavExport, getDesktopExportStore } = await import('/src/audio/streamedWavExport.ts');
    // Mastering is run-to-run variable on its own; parity is asserted on the mix it receives.
    engine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: false });
    const { channels, clips, tracks, bpm, totalBars } = cfg.project;
    for (const item of channels) if (item.instrumentType !== 'vst3' && !item.synthParams) item.synthParams = engine.getDefaultSynthParams();
    const encode = (bytes: Uint8Array) => {
      let text = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)) as unknown as number[]);
      return btoa(text);
    };
    const out: any = {};
    if (cfg.reference) {
      const buffer = await engine.renderTimelineOffline(channels, clips, tracks, bpm, totalBars, cfg.sampleRate, true, 'song');
      out.reference = { frames: buffer.length, sampleRate: buffer.sampleRate, wav: encode(new Uint8Array(await audioBufferToWav(buffer, cfg.bitDepth ?? 32).arrayBuffer())) };
    }
    if (cfg.streamed !== false) {
      const controller = new AbortController();
      let job: any;
      try {
        job = await DesktopStreamedWavExport.begin(getDesktopExportStore(), { bitDepth: cfg.bitDepth ?? 32 });
        const progress: Array<[number, string]> = [];
        const result = await engine.renderTimelineOfflineStreamed({
          channels, clips, mixerTracks: tracks, bpm, totalBars, sampleRate: cfg.sampleRate, includeMixerFx: true, renderScope: 'song',
          onProgress: (value: number, status: string) => {
            progress.push([value, status]);
            if (cfg.abortAtProgress !== undefined && value >= cfg.abortAtProgress) controller.abort();
          },
        }, job, { signal: controller.signal });
        const finished = await job.finalize({ frames: result.frames, sampleRate: result.sampleRate });
        const stats = await job.stats();
        const saved = await job.save(cfg.fileName ?? 'streamed.wav');
        out.streamed = { result, finished, stats, saved, progress };
      } catch (error: any) {
        out.error = { message: String(error?.message ?? error), name: error?.name };
        if (job) await job.abort();
      }
      out.offlineRendering = engine.isOfflineRendering;
    }
    return out;
  }, config);
}

function floatSamples(bytes: Buffer): Float32Array {
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset + WAV_HEADER_BYTES, bytes.byteOffset + bytes.length));
}
function compare(a: Float32Array, b: Float32Array) {
  let maxDiff = 0, sumSquares = 0, sumDiff = 0;
  const count = Math.min(a.length, b.length);
  for (let index = 0; index < count; index += 1) {
    const diff = Math.abs(a[index]! - b[index]!);
    if (diff > maxDiff) maxDiff = diff;
    sumDiff += diff * diff;
    sumSquares += a[index]! * a[index]!;
  }
  return { framesA: a.length / 2, framesB: b.length / 2, maxDiff, rms: Math.sqrt(sumSquares / Math.max(1, count)), rmsDiff: Math.sqrt(sumDiff / Math.max(1, count)) };
}
const readSaved = (file: string) => {
  const bytes = readFileSync(file);
  return { bytes, header: parseWavHeader(bytes.subarray(0, WAV_HEADER_BYTES), bytes.length) };
};
// The engine itself is not bit-repeatable between two renders of some graphs
// (differences up to ~3e-5 were measured between two in-memory renders). The
// streamed export has to stay inside that envelope; it is normally bit-exact.
const PARITY_MAX_DIFF = 1e-4;
const PARITY_RMS_DIFF = 1e-5;
const evidence: Record<string, unknown> = {};
test.afterAll(() => {
  mkdirSync('build/native-evidence', { recursive: true });
  writeFileSync('build/native-evidence/native-vst3-streamed-export.json', JSON.stringify(evidence, null, 2));
});

test('streamed export equals the in-memory export: VST3 instrument, VST3 insert and a built-in channel', async ({ page }) => {
  test.setTimeout(120_000);
  const results: any[] = [];
  for (const sampleRate of [44100, 48000]) {
    const project = {
      bpm: 120, totalBars: 2,
      channels: [nativeChannel('piano', 1, 'mda Piano', 60), channel('synth', 2, { notes: line('synth', 48) })],
      clips: [clip('c1', 'piano', 2), clip('c2', 'synth', 2, 1)],
      tracks: [track(0), track(1, { fxSlots: [nativeSlot('fx1', effects['mda Delay'])] }), track(2)],
    };
    const outcome = await run(page, { project, sampleRate, reference: true, fileName: `parity-${sampleRate}.wav` });
    expect(outcome.error).toBeUndefined();
    const saved = readSaved(outcome.streamed.saved.path);
    const reference = Buffer.from(outcome.reference.wav, 'base64');
    expect(saved.header).toEqual({ format: 3, channels: 2, sampleRate, bitDepth: 32, blockAlign: 8, dataBytes: outcome.reference.frames * 8, frames: outcome.reference.frames });
    expect(saved.bytes.length).toBe(reference.length);
    expect(saved.bytes.subarray(0, WAV_HEADER_BYTES).equals(reference.subarray(0, WAV_HEADER_BYTES))).toBe(true);
    const diff = compare(floatSamples(reference), floatSamples(saved.bytes));
    expect(diff.framesB).toBe(diff.framesA);
    expect(diff.rms).toBeGreaterThan(0.01);
    expect(diff.maxDiff).toBeLessThanOrEqual(PARITY_MAX_DIFF);
    expect(diff.rmsDiff).toBeLessThanOrEqual(PARITY_RMS_DIFF);
    expect(outcome.streamed.result).toMatchObject({ frames: outcome.reference.frames, sampleRate, passes: 2, nativeInstruments: 1, nativeEffects: 1 });
    expect(outcome.streamed.stats).toMatchObject({ state: 'complete', scratchFiles: 0, scratchBytes: 0 });
    expect(outcome.offlineRendering).toBe(false);
    expect(service.sessionCount).toBe(0);
    // Control: a second in-memory render of the same project. The evidence records how far two
    // in-memory renders are from each other, next to how far the streamed export is from one.
    const repeat = await run(page, { project, sampleRate, reference: true, streamed: false });
    const control = compare(floatSamples(reference), floatSamples(Buffer.from(repeat.reference.wav, 'base64')));
    expect(control.framesB).toBe(control.framesA);
    results.push({
      sampleRate, ...diff, bitExact: diff.maxDiff === 0, windows: outcome.streamed.result.windows,
      inMemoryRepeat: { maxDiff: control.maxDiff, rmsDiff: control.rmsDiff },
    });
  }
  evidence.parityInstrumentInsertBuiltin = results;
  console.log('STREAMED_EXPORT_PARITY', JSON.stringify(results));
});

test('streamed export equals the in-memory export: insert chain, bus routing and a master insert', async ({ page }) => {
  test.setTimeout(180_000);
  const projects: Record<string, RunConfig['project'] & { passes: number }> = {
    insertChain: {
      bpm: 120, totalBars: 2, passes: 3,
      channels: [nativeChannel('a', 1, 'mda Piano', 60)], clips: [clip('c', 'a', 2)],
      tracks: [track(0), track(1, { fxSlots: [nativeSlot('f1', effects['mda Overdrive']), nativeSlot('f2', effects['mda Delay'])] })],
    },
    busAndMaster: {
      bpm: 120, totalBars: 2, passes: 4,
      channels: [nativeChannel('a', 1, 'mda Piano', 60), nativeChannel('b', 2, 'mda EPiano', 55)],
      clips: [clip('c', 'a', 2), clip('d', 'b', 2, 1)],
      tracks: [
        track(0, { fxSlots: [nativeSlot('m1', effects['mda Limiter'])] }),
        track(1, { routingTargetId: 3, fxSlots: [nativeSlot('f1', effects['mda Overdrive'])] }),
        track(2, { routingTargetId: 3 }),
        track(3, { fxSlots: [nativeSlot('f3', effects['mda Delay'])] }),
      ],
    },
  };
  const results: Record<string, unknown> = {};
  for (const [name, { passes, ...project }] of Object.entries(projects)) {
    const outcome = await run(page, { project, sampleRate: 48000, reference: true, fileName: `${name}.wav` });
    expect(outcome.error, name).toBeUndefined();
    const diff = compare(floatSamples(Buffer.from(outcome.reference.wav, 'base64')), floatSamples(readSaved(outcome.streamed.saved.path).bytes));
    expect(diff.framesB, name).toBe(diff.framesA);
    expect(diff.rms, name).toBeGreaterThan(0.01);
    expect(diff.maxDiff, name).toBeLessThanOrEqual(PARITY_MAX_DIFF);
    expect(diff.rmsDiff, name).toBeLessThanOrEqual(PARITY_RMS_DIFF);
    expect(outcome.streamed.result.passes, name).toBe(passes);
    expect(service.sessionCount, name).toBe(0);
    results[name] = { ...diff, bitExact: diff.maxDiff === 0, passes };
  }
  evidence.parityRouting = results;
  console.log('STREAMED_EXPORT_ROUTING_PARITY', JSON.stringify(results));
});

test('8 VST3 instruments and 8 VST3 effects export at 16-bit, 24-bit and 32-bit float within the 16-session helper limit', async ({ page }) => {
  test.setTimeout(240_000);
  const project = eightPlusEight(2);
  const files: Record<number, { bytes: Buffer; header: any }> = {};
  const summary: any[] = [];
  for (const bitDepth of [32, 24, 16] as const) {
    peakSessions = 0;
    const outcome = await run(page, { project, sampleRate: 48000, bitDepth, fileName: `eight-${bitDepth}.wav` });
    expect(outcome.error, `${bitDepth}-bit`).toBeUndefined();
    expect(outcome.streamed.result).toMatchObject({ passes: 2, nativeInstruments: 8, nativeEffects: 8 });
    // Pass 1 holds eight instrument and eight effect instances at once: exactly the helper's limit.
    expect(peakSessions).toBe(16);
    expect(service.sessionCount).toBe(0);
    files[bitDepth] = readSaved(outcome.streamed.saved.path);
    expect(files[bitDepth].header).toMatchObject({ format: bitDepth === 32 ? 3 : 1, channels: 2, sampleRate: 48000, bitDepth, frames: outcome.streamed.result.frames });
    expect(outcome.streamed.stats.peakDiskBytes).toBeGreaterThan(8 * outcome.streamed.result.frames * 8);
    summary.push({ bitDepth, frames: outcome.streamed.result.frames, bytes: files[bitDepth].bytes.length, windows: outcome.streamed.result.windows, peakDiskBytes: outcome.streamed.stats.peakDiskBytes, peakSessions });
  }
  expect(files[24].header.frames).toBe(files[32].header.frames);
  expect(files[16].header.frames).toBe(files[32].header.frames);
  const float = floatSamples(files[32].bytes);
  let peak = 0, worst24 = 0, worst16 = 0;
  for (let index = 0; index < float.length; index += 1) {
    const value = Math.max(-1, Math.min(1, float[index]!));
    peak = Math.max(peak, Math.abs(float[index]!));
    worst24 = Math.max(worst24, Math.abs(files[24].bytes.readIntLE(WAV_HEADER_BYTES + index * 3, 3) / 0x800000 - value));
    worst16 = Math.max(worst16, Math.abs(files[16].bytes.readInt16LE(WAV_HEADER_BYTES + index * 2) / 0x8000 - value));
  }
  expect(peak).toBeGreaterThan(0.05);
  // Three separate renders: quantisation step plus the engine's run-to-run envelope.
  expect(worst24).toBeLessThanOrEqual(PARITY_MAX_DIFF + 2 / 0x800000);
  expect(worst16).toBeLessThanOrEqual(PARITY_MAX_DIFF + 2 / 0x8000);
  evidence.eightPlusEight = { summary, peak, worst24, worst16 };
  console.log('STREAMED_EXPORT_8_PLUS_8', JSON.stringify(evidence.eightPlusEight));
});

test('cancel and every failure stop the export with no output file, clean up, and leave the engine exportable', async ({ page }) => {
  test.setTimeout(300_000);
  const base = eightPlusEight(4);
  const project = { ...base, channels: base.channels.slice(0, 3), clips: base.clips.slice(0, 3), tracks: base.tracks.slice(0, 4) };
  const clean = await run(page, { project, sampleRate: 48000, fileName: 'clean.wav' });
  expect(clean.error).toBeUndefined();
  const cleanSamples = floatSamples(readSaved(clean.streamed.saved.path).bytes);
  const report: Record<string, unknown> = {};

  const expectFailure = async (label: string, config: Partial<RunConfig>, message: RegExp, arm: () => void = () => {}) => {
    hooks = {};
    arm();
    const outcome = await run(page, { project, sampleRate: 48000, fileName: `${label}.wav`, ...config });
    hooks = {};
    expect(outcome.streamed, `${label}: must not complete`).toBeUndefined();
    expect(outcome.error?.message ?? '', label).toMatch(message);
    expect(outcome.offlineRendering, `${label}: render lease released`).toBe(false);
    expect(service.sessionCount, `${label}: helper sessions closed`).toBe(0);
    expect(store.jobCount, `${label}: export job discarded`).toBe(0);
    expect(filesUnder(path.join(workDir, 'store')), `${label}: temporary files removed`).toEqual([]);
    expect(readdirSync(saveDir).filter(name => name.startsWith(label)), `${label}: no output file`).toEqual([]);
    // The next export works and is the same audio as before the failure.
    const next = await run(page, { project, sampleRate: 48000, fileName: 'next.wav' });
    expect(next.error, `${label}: next export`).toBeUndefined();
    const diff = compare(cleanSamples, floatSamples(readSaved(next.streamed.saved.path).bytes));
    expect(diff.framesB, `${label}: next export frames`).toBe(diff.framesA);
    expect(diff.maxDiff, `${label}: next export audio`).toBeLessThanOrEqual(PARITY_MAX_DIFF);
    report[label] = { error: outcome.error, nextExportMaxDiff: diff.maxDiff };
  };

  await expectFailure('cancel-first-pass', { abortAtProgress: 30 }, /^Export cancelled\.$/);
  await expectFailure('cancel-master-pass', { abortAtProgress: 75 }, /^Export cancelled\.$/);
  const missingInstrument = structuredClone(project);
  missingInstrument.channels[0].vst3 = { ...missingInstrument.channels[0].vst3, path: path.join(fixtureRoot, 'not-installed.vst3') };
  await expectFailure('missing-instrument', { project: missingInstrument }, /VST3 plugin missing/);
  const missingEffect = structuredClone(project);
  missingEffect.tracks[1].fxSlots[0].vst3Effect = { ...missingEffect.tracks[1].fxSlots[0].vst3Effect, path: path.join(fixtureRoot, 'not-installed.vst3') };
  await expectFailure('missing-effect', { project: missingEffect }, /VST3 plugin missing/);
  // The helper session disappears while the export is using it.
  let calls = 0;
  await expectFailure('effect-session-lost', {}, /.+/, () => {
    calls = 0;
    hooks.vst3 = async (method, args) => { if (method === 'processAudio' && ++calls === 10) await service.close(args[0], OWNER); };
  });
  await expectFailure('instrument-session-lost', {}, /.+/, () => {
    calls = 0;
    hooks.vst3 = async (method, args) => { if (method === 'process' && ++calls === 10) await service.close(args[0], OWNER); };
  });
  await expectFailure('effect-malformed-pcm', {}, /malformed\/non-finite PCM/, () => {
    calls = 0;
    hooks.vst3 = method => (method === 'processAudio' && ++calls === 9 ? { value: b64(new Float32Array(100)) } : undefined);
  });
  await expectFailure('instrument-non-finite-pcm', {}, /Invalid VST3 PCM batch/, () => {
    calls = 0;
    hooks.vst3 = (method, args) => (method === 'process' && ++calls === 9 ? { value: b64(new Float32Array(args[1] * 2).fill(Number.NaN)) } : undefined);
  });
  await expectFailure('disk-full-master', {}, /disk is full/i, () => {
    calls = 0;
    hooks.store = method => { if (method === 'write' && ++calls === 2) throw Object.assign(new Error('The disk is full: Writing the export could not be completed. Free some space and export again; no file was written.'), { code: 'ENOSPC' }); };
  });
  await expectFailure('disk-full-effect-scratch', {}, /disk is full/i, () => {
    calls = 0;
    hooks.store = method => { if (method === 'appendScratch' && ++calls === 3) throw Object.assign(new Error('The disk is full: Writing temporary effect audio could not be completed. Free some space and export again; no file was written.'), { code: 'ENOSPC' }); };
  });
  evidence.failures = report;
  console.log('STREAMED_EXPORT_FAILURES', JSON.stringify(report));
});

test('Export dialog: a VST3 song is rendered to disk, saved through the store, and can be cancelled', async ({ page }) => {
  test.setTimeout(240_000);
  await page.evaluate(async ({ instrument, effect }) => {
    // @ts-ignore actual project model and persistence boundary
    const { createDefaultProjectState } = await import('/src/state/projectState.ts');
    // @ts-ignore
    const { persistProjectState } = await import('/src/state/projectPersistence.ts');
    const state = createDefaultProjectState();
    const notes = [[0, 60], [4, 64], [8, 67], [12, 72]].map(([start, pitch], index) => ({ id: `n${index}`, pitch, start, duration: 3, velocity: 0.8 }));
    state.channels = [{ ...state.channels[0], id: 'native-song', name: 'Native song', instrumentType: 'vst3', vst3: instrument, mixerTrackId: 1, volume: 0.8, pan: 0, mute: false, solo: false, steps: Array(16).fill(false), notes }];
    state.selectedChannelId = 'native-song';
    state.mixerTracks = state.mixerTracks.map((item: any) => ({ ...item, volume: 1, pan: 0, mute: false, solo: false, routingTargetId: 0, auxSends: undefined,
      fxSlots: item.id === 1 ? [{ id: 'native-fx', type: 'vst3', name: effect.name, enabled: true, mix: 1, params: {}, vst3Effect: effect }] : [] }));
    state.playlistClips = [{ id: 'song-clip', trackIndex: 0, startBar: 0, lengthBars: 24, type: 'pattern', channelId: 'native-song', patternId: state.selectedPatternId, color: '#10b981', name: 'Song' }];
    await persistProjectState(state);
  }, { instrument: instruments['mda Piano'], effect: effects['mda Delay'] });
  await page.reload();
  await page.locator('#fl-export-btn').click();
  const dialog = page.locator('#export-modal');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /WAV \(16-bit\)/ }).click();
  const fileNameInput = dialog.locator('input').first();
  await fileNameInput.fill('dialog song.wav');

  // 1. Cancel while rendering.
  await dialog.getByRole('button', { name: 'START EXPORT' }).click();
  const cancel = dialog.getByTestId('export-streamed-cancel');
  await expect(cancel).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close export' })).toBeDisabled();
  await cancel.click();
  await expect(dialog.getByText('Export cancelled. No file was written.')).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByRole('button', { name: 'START EXPORT' })).toBeEnabled();
  await expect.poll(() => store.jobCount).toBe(0);
  await expect.poll(() => service.sessionCount).toBe(0);
  expect(filesUnder(path.join(workDir, 'store'))).toEqual([]);
  expect(readdirSync(saveDir)).toEqual([]);

  // 2. Export again, to completion: no blob, no audition, a store-backed save.
  await dialog.getByRole('button', { name: 'START EXPORT' }).click();
  const ready = dialog.getByTestId('export-streamed-ready');
  await expect(ready).toBeVisible({ timeout: 180_000 });
  await expect(dialog.getByText('Timeline WAV master render complete. Choose where to save it.')).toBeVisible();
  await expect(dialog.getByTestId('export-audition')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: /^DOWNLOAD/ })).toHaveCount(0);
  expect(readdirSync(saveDir), 'nothing is written to the destination before Save').toEqual([]);
  expect(filesUnder(path.join(workDir, 'store')).map(file => path.basename(file))).toEqual(['master.wav']);
  await dialog.getByTestId('export-streamed-save').click();
  await expect(dialog.getByText('Timeline WAV master saved.')).toBeVisible();
  await expect(dialog.getByTestId('export-streamed-saved-path')).toContainText('dialog song.wav');
  const saved = readSaved(path.join(saveDir, 'dialog song.wav'));
  expect(saved.header).toMatchObject({ format: 1, channels: 2, bitDepth: 16, blockAlign: 4 });
  // 24 bars at the project tempo, plus at most the 4-second tail.
  const bpm = await page.evaluate(async () => {
    // @ts-ignore
    const { getPersistedProjectStateRecord } = await import('/src/audio/audioPersistence.ts');
    return JSON.parse(await getPersistedProjectStateRecord()).state.meta.bpm as number;
  });
  const songSeconds = 24 * 4 * 60 / bpm;
  expect(saved.header.frames / saved.header.sampleRate).toBeGreaterThanOrEqual(songSeconds - 0.01);
  expect(saved.header.frames / saved.header.sampleRate).toBeLessThanOrEqual(songSeconds + 4.01);
  let peak = 0;
  for (let offset = WAV_HEADER_BYTES; offset < saved.bytes.length; offset += 2) peak = Math.max(peak, Math.abs(saved.bytes.readInt16LE(offset)));
  expect(peak).toBeGreaterThan(1000);

  // 3. Closing the dialog discards the temporary export; the saved file stays.
  await dialog.getByRole('button', { name: 'Close export' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => store.jobCount).toBe(0);
  expect(filesUnder(path.join(workDir, 'store'))).toEqual([]);
  expect(existsSync(path.join(saveDir, 'dialog song.wav'))).toBe(true);
  expect(service.sessionCount).toBe(0);
  evidence.dialog = { savedFrames: saved.header.frames, sampleRate: saved.header.sampleRate, bytes: saved.bytes.length, peak };
});
