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
  for (const name of ['mda Delay', 'mda Overdrive', 'mda Limiter']) {
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
  // These tests compare separate renders with each other, so every plug-in here has to give the
  // same output each time it is loaded. Several upstream mda effects do not: mda RezFilter, for
  // example, never initialises its LFO phase and envelope state (mdaRezFilterProcessor.cpp reads
  // `phi`, `env`, `env2` and `bufl` before anything writes them), so two renders of one project
  // differ on Windows. The fixture is therefore limited to the plug-ins whose output is compared
  // between separate renders elsewhere in the native gates; instances repeat to reach 8 + 8.
  const names = ['mda Piano', 'mda EPiano', 'mda JX10'].filter(name => instruments[name]);
  const fx = ['mda Delay', 'mda Overdrive', 'mda Limiter', 'mda Delay', 'mda Overdrive', 'mda Limiter', 'mda Delay', 'mda Overdrive'];
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
  /** Renders with the default Mastering Suite state enabled (the product default). Off unless stated. */
  mastering?: boolean;
  swing?: number;
  /** Sample buffers to register before rendering: decaying noise of the given length, by buffer id. */
  samples?: Record<string, { seconds: number; decay: number }>;
  /**
   * Observes every AudioBufferSourceNode the streamed export creates on an offline context and
   * reports, in `sources`, whether each was disconnected, whether its buffer was dropped, and
   * when that happened relative to the end of its audio.
   */
  trackSources?: boolean;
};
/** What `trackSources` reports. Times are context seconds. */
type SourceReport = {
  created: number; played: number;
  /** Played sources that were not disconnected or still hold their buffer. */
  unreleased: number;
  /** Sources that never played but are connected or hold a buffer. */
  unplayedHeld: number;
  disconnectedMoreThanOnce: number;
  /** Released while the context was still rendering, i.e. by the `ended` event and not by the end-of-pass sweep. */
  releasedWhileRendering: number;
  /** Smallest (disconnect time − end of the source's audio); negative means released early. */
  earliestRelease: number | null;
  /** Largest (disconnect time − end of the source's audio) among sources released while rendering. */
  latestRelease: number | null;
  /** Played sources per offline context, in creation order (one context per pass). */
  playedPerPass: number[];
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
    // Mastering is off unless a test asks for it: those tests record how far separate
    // renders are from each other next to how far the streamed export is from one.
    engine.setMasteringState({ ...DEFAULT_MASTERING_SUITE_STATE, enabled: cfg.mastering === true });
    engine.setSwing(cfg.swing ?? 0);
    let seed = 0x2f6e2b1;
    for (const [id, shape] of Object.entries(cfg.samples ?? {})) {
      const buffer = new AudioBuffer({ length: Math.round(shape.seconds * 48000), numberOfChannels: 1, sampleRate: 48000 });
      const data = buffer.getChannelData(0);
      for (let index = 0; index < data.length; index += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        data[index] = (seed / 0x80000000 - 1) * 0.6 * Math.exp(-shape.decay * index / 48000);
      }
      engine.setSampleBuffer(id, buffer);
    }
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
      type SourceRecord = { node: AudioBufferSourceNode; context: BaseAudioContext; connects: number; disconnects: number; played: boolean; end: number; releasedAt: number; contextEnd: number };
      const records: SourceRecord[] = [];
      const offlinePrototype = OfflineAudioContext.prototype as any;
      if (cfg.trackSources) {
        const create = BaseAudioContext.prototype.createBufferSource;
        offlinePrototype.createBufferSource = function (this: OfflineAudioContext) {
          const node = create.call(this);
          const record: SourceRecord = { node, context: this, connects: 0, disconnects: 0, played: false, end: 0, releasedAt: -1, contextEnd: this.length / this.sampleRate };
          records.push(record);
          const connect = node.connect.bind(node) as (...args: any[]) => any;
          const disconnect = node.disconnect.bind(node) as (...args: any[]) => any;
          const start = node.start.bind(node) as (...args: any[]) => any;
          (node as any).connect = (...args: any[]) => { record.connects += 1; return connect(...args); };
          (node as any).disconnect = (...args: any[]) => {
            if (record.disconnects === 0) record.releasedAt = this.currentTime;
            record.disconnects += 1;
            return disconnect(...args);
          };
          (node as any).start = (...args: any[]) => {
            record.played = true;
            // Where its audio stops: the end of its buffer, or the end of the render if that comes first.
            record.end = Math.min(record.contextEnd, Math.max(0, Number(args[0] ?? 0)) + Math.max(0, (node.buffer?.duration ?? 0) - Number(args[1] ?? 0)));
            return start(...args);
          };
          return node;
        };
      }
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
      } finally {
        delete offlinePrototype.createBufferSource;
      }
      if (cfg.trackSources) {
        const played = records.filter(record => record.played);
        const contexts = [...new Set(records.map(record => record.context))];
        // The context's clock is read on the control thread and can be one render quantum behind.
        const whileRendering = played.filter(record => record.disconnects > 0 && record.releasedAt < record.contextEnd - 256 / record.context.sampleRate);
        const lead = played.filter(record => record.disconnects > 0).map(record => record.releasedAt - record.end);
        out.sources = {
          created: records.length,
          played: played.length,
          unreleased: played.filter(record => record.disconnects === 0 || record.node.buffer !== null).length,
          unplayedHeld: records.filter(record => !record.played && ((record.connects > 0 && record.disconnects === 0) || record.node.buffer !== null)).length,
          disconnectedMoreThanOnce: records.filter(record => record.disconnects > 1).length,
          releasedWhileRendering: whileRendering.length,
          earliestRelease: lead.length ? Math.min(...lead) : null,
          latestRelease: whileRendering.length ? Math.max(...whileRendering.map(record => record.releasedAt - record.end)) : null,
          playedPerPass: contexts.map(context => played.filter(record => record.context === context).length),
        };
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

// ---- bounded-lookahead timeline scheduling ------------------------------------
// The streamed export schedules timeline steps from its window driver, one lookahead ahead of the
// render, where the in-memory export schedules the whole song before rendering starts.
const STREAM_WINDOW_FRAMES = 196_608;
const STREAM_AHEAD_FRAMES = STREAM_WINDOW_FRAMES + 256 + 16_384 + 4096;
/** Steps that can be scheduled and not yet rendered: one window plus the lookahead, plus one step and one render quantum. */
const pendingStepBound = (sampleRate: number, bpm: number) => Math.ceil((STREAM_AHEAD_FRAMES + 128) / (sampleRate * 15 / bpm)) + 1;

/** The first parameter of an instrument fixture that a `vst3_param` lane can drive. */
async function automatableParameterId(instrument: any): Promise<number> {
  const { id, parameters = [] } = await service.open(instrument, 48000, 'offline', OWNER, 'instrument');
  await service.close(id, OWNER);
  const parameter = parameters.find((candidate: any) => (candidate.flags & 1) && !(candidate.flags & (2 | 8 | 16 | 32768)) && candidate.currentValue !== null);
  if (!parameter) throw new Error(`${instrument.name} has no automatable parameter`);
  return parameter.id;
}

/** A song that uses every part of the step scheduler; `totalBars` only changes how long it plays. */
function schedulerProject(totalBars: number, pianoParameterId: number, bpm = 120) {
  const piano = nativeChannel('piano', 1, 'mda Piano', 60, {
    // The last note is held for ten beats, so its release lies two windows after its onset.
    notes: [...line('piano', 60), { id: 'piano-held', pitch: 43, start: 2.5, duration: 40, velocity: 0.7 }],
  });
  const channels = [
    piano,
    // First note in bar 6: its instance is opened after the render has started.
    nativeChannel('late', 2, 'mda JX10', 52),
    nativeChannel('arp', 3, 'mda EPiano', 48, {
      notes: [{ id: 'arp-0', pitch: 48, start: 0, duration: 4, velocity: 0.8 }, { id: 'arp-1', pitch: 55, start: 8, duration: 4, velocity: 0.8 }],
      arp: { enabled: true, mode: 'up', rate: '1/16', octaves: 2, gate: 0.8, swing: 0, strumMs: 12 },
    }),
    channel('synth', 4, { notes: line('synth', 36, 3) }),
    channel('drums', 5, {
      instrumentType: 'drumpad',
      drumPads: [
        { id: 'open', note: 36, name: 'Open', sampleId: 'open', volume: 1, pan: -0.2, tuneSemitones: 0, chokeGroup: 1 },
        { id: 'closed', note: 38, name: 'Closed', sampleId: 'closed', volume: 0.9, pan: 0.2, tuneSemitones: 0, chokeGroup: 1 },
      ],
      // Each closed hit chokes the open one while it is still ringing.
      notes: [[0, 36], [3, 38], [6, 36], [7, 38], [10, 36], [13.5, 38]].map(([start, pitch], index) => ({ id: `d-${index}`, pitch, start, duration: 1, velocity: 0.9 })),
    }),
  ];
  const automation = (id: string, target: any, points: Array<[number, number]>, startBar: number, lengthBars: number) => ({
    id, type: 'automation', trackIndex: 7, startBar, lengthBars, name: id, color: '#fff', automationTarget: target,
    automationPoints: points.map(([x, y]) => ({ x, y })),
  });
  const clips = [
    clip('c-piano', 'piano', totalBars), clip('c-arp', 'arp', totalBars, 2), clip('c-synth', 'synth', totalBars, 3), clip('c-drums', 'drums', totalBars, 4),
    { ...clip('c-late', 'late', totalBars - 5, 1), startBar: 5 },
    // Fractional start, trimmed, with both fades; lane 6 plays through mixer track 7.
    { id: 'c-audio', type: 'audio', trackIndex: 6, startBar: 1.25, lengthBars: 2, audioBufferId: 'loop', offsetSteps: 1, fadeInBars: 0.25, fadeOutBars: 0.5, name: 'loop', color: '#fff' },
    automation('a-vol', { type: 'mixer_vol', targetId: 4 }, [[0, 0.9], [0.5, 0.3], [1, 0.8]], 0, totalBars),
    automation('a-pan', { type: 'channel_pan', targetId: 'synth' }, [[0, 0.1], [1, 0.9]], 1, 3),
    automation('a-send', { type: 'mixer_send1', targetId: 1 }, [[0, 0], [1, 0.8]], 0, 4),
    automation('a-native', {
      type: 'vst3_param', targetId: 'piano',
      native: { path: instruments['mda Piano'].path, classId: instruments['mda Piano'].classId, automationId: instruments['mda Piano'].automationId ?? null, parameterId: pianoParameterId },
    }, [[0, 0.2], [1, 0.8]], 0, 4),
  ];
  const tracks = [
    track(0),
    track(1, { auxSends: [{ targetId: 8, amount: 0.4 }], fxSlots: [nativeSlot('f1', effects['mda Overdrive'])] }),
    track(2), track(3, { routingTargetId: 9 }),
    // Ducked by every drum hit (note-triggered sidechain).
    track(4, { sidechain: { enabled: true, sourceTrackId: 5, amount: 0.75, attackMs: 5, releaseMs: 140 } }),
    track(5), track(7),
    track(8, { isAux: true, fxSlots: [nativeSlot('f8', effects['mda Delay'])] }),
    track(9, { volume: 0.8, pan: 0.25 }),
  ];
  return { bpm, totalBars, channels, clips, tracks };
}
const schedulerSamples = { open: { seconds: 1.5, decay: 2 }, closed: { seconds: 0.2, decay: 30 }, loop: { seconds: 5, decay: 0.3 } };

test('bounded-lookahead scheduling gives the same file: swing, arpeggio, automation, sends, routing, audio clip, sidechain, choke and a late VST3 instrument', async ({ page }) => {
  test.setTimeout(300_000);
  const sampleRate = 48000;
  const project = schedulerProject(8, await automatableParameterId(instruments['mda Piano']));
  const config = { project, sampleRate, swing: 0.35, samples: schedulerSamples };
  const outcome = await run(page, { ...config, reference: true, fileName: 'scheduler.wav' });
  expect(outcome.error).toBeUndefined();
  const reference = floatSamples(Buffer.from(outcome.reference.wav, 'base64'));
  const streamed = floatSamples(readSaved(outcome.streamed.saved.path).bytes);
  const diff = compare(reference, streamed);
  expect(diff.framesB).toBe(diff.framesA);
  expect(diff.rms).toBeGreaterThan(0.01);
  expect(diff.maxDiff).toBeLessThanOrEqual(PARITY_MAX_DIFF);
  expect(diff.rmsDiff).toBeLessThanOrEqual(PARITY_RMS_DIFF);
  const { scheduling } = outcome.streamed.result;
  expect(outcome.streamed.result).toMatchObject({ nativeInstruments: 3, nativeEffects: 2, passes: 3 });
  // Every step was scheduled, never more than one lookahead ahead, and the late instrument was silent before its first note.
  expect(scheduling.scheduledSteps).toBe(scheduling.timelineSteps);
  expect(scheduling.timelineSteps).toBe(project.totalBars * 16);
  expect(scheduling.peakPendingSteps).toBeLessThanOrEqual(pendingStepBound(sampleRate, project.bpm));
  expect(scheduling.peakPendingSteps).toBeLessThan(scheduling.timelineSteps / 2);
  expect(scheduling.leadInDiscardedFrames).toBe(0);
  expect(service.sessionCount).toBe(0);
  // Control: a second in-memory render of the same project.
  const repeat = await run(page, { ...config, reference: true, streamed: false });
  const control = compare(reference, floatSamples(Buffer.from(repeat.reference.wav, 'base64')));
  evidence.boundedLookaheadParity = {
    sampleRate, ...diff, bitExact: diff.maxDiff === 0, windows: outcome.streamed.result.windows, scheduling,
    inMemoryRepeat: { maxDiff: control.maxDiff, rmsDiff: control.rmsDiff },
  };
  console.log('STREAMED_EXPORT_LOOKAHEAD_PARITY', JSON.stringify(evidence.boundedLookaheadParity));
});

test('what the streamed export has scheduled ahead does not grow with the length of the song', async ({ page }) => {
  test.setTimeout(420_000);
  const sampleRate = 48000;
  // One bar is exactly half a window at this tempo, so every window boundary falls at the same
  // place in a bar and the two songs can be compared window for window.
  const bpm = 240 * sampleRate / (STREAM_WINDOW_FRAMES / 2);
  const pianoParameterId = await automatableParameterId(instruments['mda Piano']);
  const runs: any[] = [];
  for (const totalBars of [8, 32]) {
    const project = schedulerProject(totalBars, pianoParameterId, bpm);
    const outcome = await run(page, { project, sampleRate, swing: 0.35, samples: schedulerSamples, bitDepth: 24, fileName: `bounded-${totalBars}.wav` });
    expect(outcome.error, `${totalBars} bars`).toBeUndefined();
    const { scheduling, frames, windows, pcmSources } = outcome.streamed.result;
    expect(pcmSources.started, `${totalBars} bars`).toBeGreaterThan(0);
    expect(pcmSources.released, `${totalBars} bars`).toBe(pcmSources.started);
    expect(scheduling.scheduledSteps, `${totalBars} bars`).toBe(totalBars * 16);
    expect(scheduling.peakPendingSteps, `${totalBars} bars`).toBeLessThanOrEqual(pendingStepBound(sampleRate, bpm));
    expect(scheduling.leadInDiscardedFrames, `${totalBars} bars`).toBe(0);
    runs.push({ totalBars, frames, windows, ...scheduling });
  }
  const [short, long] = runs;
  expect(long.timelineSteps).toBe(short.timelineSteps * 4);
  expect(long.frames).toBeGreaterThan(short.frames * 3);
  // Four times the song, and no more steps, VST3 events or sources held at any one time. Sources
  // are released when the browser reports them ended, which is not tied to a window boundary,
  // hence the allowance on that one counter.
  expect(long.peakPendingSteps).toBe(short.peakPendingSteps);
  expect(long.peakRetainedVst3Events).toBeLessThanOrEqual(short.peakRetainedVst3Events);
  expect(long.peakLiveAudioSources).toBeLessThanOrEqual(Math.ceil(short.peakLiveAudioSources * 1.1));
  evidence.boundedLookaheadCounters = { bpm, runs };
  console.log('STREAMED_EXPORT_LOOKAHEAD_COUNTERS', JSON.stringify(evidence.boundedLookaheadCounters));
});

// ---- mastering enabled --------------------------------------------------------
type RegionDiff = { maxDiff: number; rmsDiff: number; rms: number };
/** Differences of two stereo renders in the first half second, the rest of the song and the tail after it. */
function regions(a: Float32Array, b: Float32Array, sampleRate: number, songFrames: number): Record<'startup' | 'body' | 'tail', RegionDiff> {
  const span = (from: number, to: number): RegionDiff => {
    let maxDiff = 0, sumDiff = 0, sum = 0;
    for (let index = from * 2; index < to * 2; index += 1) {
      const diff = Math.abs(a[index]! - b[index]!);
      if (diff > maxDiff) maxDiff = diff;
      sumDiff += diff * diff;
      sum += a[index]! * a[index]!;
    }
    const count = Math.max(1, (to - from) * 2);
    return { maxDiff, rmsDiff: Math.sqrt(sumDiff / count), rms: Math.sqrt(sum / count) };
  };
  const startupEnd = Math.round(sampleRate / 2);
  return { startup: span(0, startupEnd), body: span(startupEnd, songFrames), tail: span(songFrames, a.length / 2) };
}
/** The shift of `b` against `a`, in frames, that correlates best (0 = aligned), with the correlation at that shift. */
function bestLag(a: Float32Array, b: Float32Array, frames: number, maxLag = 480) {
  let best = { lag: Number.NaN, correlation: -Infinity };
  let energyA = 0, energyB = 0;
  for (let index = maxLag * 2; index < (frames - maxLag) * 2; index += 1) { energyA += a[index]! * a[index]!; energyB += b[index]! * b[index]!; }
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let index = maxLag * 2; index < (frames - maxLag) * 2; index += 1) sum += a[index]! * b[index + lag * 2]!;
    const correlation = sum / Math.sqrt(energyA * energyB);
    if (correlation > best.correlation) best = { lag, correlation };
  }
  return best;
}
const summarise = (pairs: Array<Record<string, RegionDiff>>) => Object.fromEntries((['startup', 'body', 'tail'] as const).map(region => [region, {
  maxDiff: pairs.map(pair => pair[region]!.maxDiff), rmsDiff: pairs.map(pair => pair[region]!.rmsDiff),
  worstMaxDiff: Math.max(...pairs.map(pair => pair[region]!.maxDiff)), worstRmsDiff: Math.max(...pairs.map(pair => pair[region]!.rmsDiff)),
}]));

test('mastering enabled: streamed export equals the in-memory export in startup, body, alignment and tail, with the run-to-run spread recorded', async ({ page }) => {
  test.setTimeout(600_000);
  const sampleRate = 48000;
  const RENDERS = 3;
  // VST3 instruments on two tracks, VST3 inserts on both and on the master, and a built-in synth,
  // through the default Mastering Suite (multiband, maximizer with 5 ms lookahead) as the dialog exports it.
  const project = {
    bpm: 120, totalBars: 4,
    channels: [nativeChannel('piano', 1, 'mda Piano', 60), nativeChannel('lead', 2, 'mda JX10', 55), channel('synth', 3, { notes: line('synth', 43, 3) })],
    clips: [clip('c1', 'piano', 4), clip('c2', 'lead', 4, 1), clip('c3', 'synth', 4, 2)],
    tracks: [
      track(0, { fxSlots: [nativeSlot('m1', effects['mda Limiter'])] }),
      track(1, { fxSlots: [nativeSlot('f1', effects['mda Overdrive'])] }),
      track(2, { fxSlots: [nativeSlot('f2', effects['mda Delay'])] }),
      track(3),
    ],
  };
  const songFrames = Math.round(project.totalBars * 4 * 60 / project.bpm * sampleRate);
  const inMemory: Float32Array[] = [], streamed: Float32Array[] = [];
  let result: any;
  for (let index = 0; index < RENDERS; index += 1) {
    const outcome = await run(page, { project, sampleRate, mastering: true, reference: true, fileName: `mastered-${index}.wav` });
    expect(outcome.error, `render ${index}`).toBeUndefined();
    const saved = readSaved(outcome.streamed.saved.path);
    const referenceBytes = Buffer.from(outcome.reference.wav, 'base64');
    expect(saved.header, `render ${index}`).toEqual({ format: 3, channels: 2, sampleRate, bitDepth: 32, blockAlign: 8, dataBytes: outcome.reference.frames * 8, frames: outcome.reference.frames });
    expect(saved.bytes.length, `render ${index}`).toBe(referenceBytes.length);
    expect(outcome.streamed.result, `render ${index}`).toMatchObject({ frames: outcome.reference.frames, passes: 3, nativeInstruments: 2, nativeEffects: 3 });
    expect(service.sessionCount, `render ${index}`).toBe(0);
    inMemory.push(floatSamples(referenceBytes));
    streamed.push(floatSamples(saved.bytes));
    result = outcome.streamed.result;
  }
  // The song window plus the four-second tail.
  expect(inMemory[0]!.length / 2).toBe(songFrames + 4 * sampleRate);
  const pairsOf = (list: Float32Array[]) => list.flatMap((first, i) => list.slice(i + 1).map(second => regions(first, second, sampleRate, songFrames)));
  const control = pairsOf(inMemory);
  const streamedRepeat = pairsOf(streamed);
  const cross = inMemory.flatMap(reference => streamed.map(candidate => regions(reference, candidate, sampleRate, songFrames)));
  // Every region carries signal: the first notes, the song, and the delay and release tails after it.
  for (const region of ['startup', 'body', 'tail'] as const) expect(cross[0]![region].rms, region).toBeGreaterThan(1e-3);
  // Each streamed render against each in-memory render, in each region, inside the same limits as
  // the mastering-off tests. The control pairs are not part of the limit; they are recorded.
  for (const [index, pair] of cross.entries()) {
    for (const region of ['startup', 'body', 'tail'] as const) {
      expect(pair[region].maxDiff, `pair ${index} ${region}`).toBeLessThanOrEqual(PARITY_MAX_DIFF);
      expect(pair[region].rmsDiff, `pair ${index} ${region}`).toBeLessThanOrEqual(PARITY_RMS_DIFF);
    }
  }
  // Latency alignment: the limiter's lookahead is trimmed identically, so no shift correlates better than none.
  const alignment = streamed.map(candidate => bestLag(inMemory[0]!, candidate, Math.min(songFrames, 2 * sampleRate)));
  for (const [index, entry] of alignment.entries()) {
    expect(entry.lag, `streamed render ${index}`).toBe(0);
    expect(entry.correlation, `streamed render ${index}`).toBeGreaterThan(0.999999);
  }
  evidence.masteringEnabledParity = {
    sampleRate, renders: RENDERS, frames: inMemory[0]!.length / 2, songFrames, passes: result.passes, windows: result.windows,
    limits: { maxDiff: PARITY_MAX_DIFF, rmsDiff: PARITY_RMS_DIFF },
    signalRms: Object.fromEntries((['startup', 'body', 'tail'] as const).map(region => [region, cross[0]![region].rms])),
    controlInMemoryVsInMemory: summarise(control),
    controlStreamedVsStreamed: summarise(streamedRepeat),
    streamedVsInMemory: summarise(cross),
    alignment,
    scheduling: result.scheduling,
  };
  console.log('STREAMED_EXPORT_MASTERING_PARITY', JSON.stringify(evidence.masteringEnabledParity));
});

test('PCM sources are disconnected and lose their buffer when they have played, never earlier, and the file is unchanged', async ({ page }) => {
  test.setTimeout(240_000);
  const sampleRate = 48000;
  // Two VST3 instruments, one with a VST3 insert: the first pass feeds instrument blocks, the
  // second feeds instrument blocks and the processed-effect windows. Long enough for five windows.
  const project = {
    bpm: 120, totalBars: 8,
    channels: [nativeChannel('piano', 1, 'mda Piano', 60), nativeChannel('keys', 2, 'mda EPiano', 52), channel('synth', 3, { notes: line('synth', 48) })],
    clips: [clip('c1', 'piano', 8), clip('c2', 'keys', 8, 1), clip('c3', 'synth', 8, 2)],
    tracks: [track(0), track(1, { fxSlots: [nativeSlot('fx1', effects['mda Delay'])] }), track(2), track(3)],
  };
  const outcome = await run(page, { project, sampleRate, reference: true, trackSources: true, fileName: 'sources.wav' });
  expect(outcome.error).toBeUndefined();
  const result = outcome.streamed.result;
  const sources: SourceReport = outcome.sources;
  expect(result).toMatchObject({ passes: 2, nativeInstruments: 2, nativeEffects: 1 });

  // The engine's own count and the independent observation agree: everything started was released.
  expect(result.pcmSources.started).toBeGreaterThan(0);
  expect(result.pcmSources.released).toBe(result.pcmSources.started);
  expect(sources.played).toBe(result.pcmSources.started);
  expect(sources.created).toBe(sources.played);
  expect(sources.unreleased).toBe(0);
  expect(sources.unplayedHeld).toBe(0);
  expect(sources.disconnectedMoreThanOnce).toBe(0);
  // Both kinds: the second pass plays the same instrument blocks plus one source per window for the effect.
  expect(sources.playedPerPass).toHaveLength(2);
  expect(sources.playedPerPass[1]!).toBeGreaterThan(sources.playedPerPass[0]!);
  // Most are released by their `ended` event while the render is still running...
  expect(sources.releasedWhileRendering).toBeGreaterThan(sources.played / 2);
  // ...and none before its audio has been rendered. The `ended` event is sent while the render
  // quantum that holds the source's last frame is being rendered, and the clock read here still
  // shows the start of that quantum, so a release can read up to 128 frames early. A source
  // cut short would show in the file comparison below.
  expect(sources.earliestRelease!).toBeGreaterThanOrEqual(-2 * 128 / sampleRate);

  // The same file as the in-memory export.
  const saved = readSaved(outcome.streamed.saved.path);
  const diff = compare(floatSamples(Buffer.from(outcome.reference.wav, 'base64')), floatSamples(saved.bytes));
  expect(saved.header.frames).toBe(outcome.reference.frames);
  expect(diff.framesB).toBe(diff.framesA);
  expect(diff.rms).toBeGreaterThan(0.01);
  expect(diff.maxDiff).toBeLessThanOrEqual(PARITY_MAX_DIFF);
  expect(diff.rmsDiff).toBeLessThanOrEqual(PARITY_RMS_DIFF);
  expect(service.sessionCount).toBe(0);

  evidence.pcmSourceRelease = { sampleRate, frames: result.frames, windows: result.windows, pcmSources: result.pcmSources, observed: sources, parity: diff };
  console.log('STREAMED_EXPORT_SOURCE_RELEASE', JSON.stringify(evidence.pcmSourceRelease));
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
    expect(outcome.streamed.result.pcmSources.started).toBeGreaterThan(0);
    expect(outcome.streamed.result.pcmSources.released).toBe(outcome.streamed.result.pcmSources.started);
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
    const outcome = await run(page, { project, sampleRate: 48000, fileName: `${label}.wav`, trackSources: true, ...config });
    hooks = {};
    expect(outcome.streamed, `${label}: must not complete`).toBeUndefined();
    // Every PCM source the stopped export had started is disconnected and has dropped its buffer.
    const sources: SourceReport = outcome.sources;
    expect(sources.unreleased, `${label}: PCM sources released`).toBe(0);
    expect(sources.unplayedHeld, `${label}: no PCM source left connected`).toBe(0);
    expect(sources.disconnectedMoreThanOnce, `${label}: PCM sources released once`).toBe(0);
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
    report[label] = { error: outcome.error, nextExportMaxDiff: diff.maxDiff, pcmSourcesPlayed: sources.played, pcmSourcesUnreleased: sources.unreleased };
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
