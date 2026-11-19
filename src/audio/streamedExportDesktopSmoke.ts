// Executed ONLY by the packaged-runtime smoke launch flag, from
// nativeVst3DesktopSmoke.ts. It drives the production streamed song export
// (engine -> preload IPC -> main-process export store -> saved WAV) inside the
// packaged application and compares the saved file with the in-memory render.
import type { audioEngine } from './audioEngine';
import { getVst3Bridge, type Vst3Effect } from './nativeVst3Types';
import { StreamedExportCancelledError } from './streamedOfflineExport';
import { DesktopStreamedWavExport, estimateStreamedExportBytes, getDesktopExportStore } from './streamedWavExport';
import type { Channel, FxSlot, MixerTrack, PlaylistClip } from '../types/daw';

type Engine = typeof audioEngine;
type SmokeInspection = {
  root: string; rootEntries: string[]; jobCount: number; peakDiskBytes: number; jobError?: string;
  job?: { state: string; dataBytes: number; frames: number; savedPath: string | null };
  saved?: {
    path: string; bytes: number; sha256: string; directoryEntries: string[]; data?: Uint8Array;
    header: { format: number; channels: number; sampleRate: number; bitDepth: number; blockAlign: number; dataBytes: number; frames: number };
  };
};
type SmokeDesktop = {
  smokeTest?: boolean;
  exportStore?: { smokeInspect?: (jobId?: string, includeAudio?: boolean) => Promise<SmokeInspection> };
  vst3?: { smokeTimingSnapshot?: () => Promise<{ main?: { nativeServiceSessionCount?: number } }> };
};

const SAMPLE_RATE = 48000;
const BARS = 1;
const BPM = 120;
const WAV_HEADER_BYTES = 44;

const fail = (message: string): never => { throw new Error(`Packaged streamed export: ${message}`); };

export async function runStreamedExportDesktopSmoke(instance: Engine, instrumentChannel: Channel) {
  const desktop = (globalThis as unknown as { desktopApp?: SmokeDesktop }).desktopApp;
  // Same rule as the Mixer acceptance: this runs only in the explicit packaged
  // smoke launch. scripts/desktop-smoke.mjs requires status 'passed', so a
  // packaged build without the export store fails there.
  if (desktop?.smokeTest !== true || typeof desktop?.vst3?.smokeTimingSnapshot !== 'function') {
    return { status: 'not-run' as const, reason: 'The streamed export acceptance is restricted to the explicit packaged smoke-test launch.' };
  }
  const store = getDesktopExportStore();
  const inspect = desktop?.exportStore?.smokeInspect;
  const bridge = getVst3Bridge();
  if (!store || !inspect || !bridge) return fail('the export store bridge is missing from the packaged preload');
  const sessions = async () => (await desktop?.vst3?.smokeTimingSnapshot?.())?.main?.nativeServiceSessionCount ?? -1;

  const discovered = await bridge.discoverEffects();
  const identity = (name: string) => discovered.plugins.find(plugin => plugin.name === name) ?? fail(`fixture ${name} was not discovered`);
  const overdrive = await bridge.inspectEffect(identity('mda Overdrive'));
  const delay = await bridge.inspectEffect(identity('mda Delay'));
  const slot = (id: string, effect: Vst3Effect): FxSlot => ({ id, type: 'vst3', name: effect.name, enabled: true, mix: 1, params: {}, vst3Effect: effect });
  const track = (id: number, fxSlots: FxSlot[] = []) => ({ id, name: `Streamed smoke ${id}`, color: '#fff', volume: 1, pan: 0, mute: false, solo: false, fxSlots, peakL: 0, peakR: 0 }) as MixerTrack;
  const channel: Channel = { ...instrumentChannel, id: 'streamed-smoke-channel', mixerTrackId: 1 };
  const mixer = [track(0), track(1, [slot('streamed-smoke-overdrive', overdrive), slot('streamed-smoke-delay', delay)])];
  const clip: PlaylistClip = { id: 'streamed-smoke-clip', trackIndex: 0, startBar: 0, lengthBars: BARS, type: 'pattern', channelId: channel.id, name: 'Streamed smoke', color: '#fff' };
  const request = { channels: [channel], clips: [clip], mixerTracks: mixer, bpm: BPM, totalBars: BARS, sampleRate: SAMPLE_RATE, includeMixerFx: true, renderScope: 'song' as const, minimumDurationSeconds: 0.5 };

  await instance.releaseNativeInstruments();
  const sessionsBefore = await sessions();
  if (sessionsBefore < 0) fail('the helper session count is unavailable');

  // Reference: the in-memory production render of the same project.
  const reference = await instance.renderTimelineOffline([channel], [clip], mixer, BPM, BARS, SAMPLE_RATE, true, 'song', undefined, undefined, undefined, 0.5);

  // 1. Streamed 24-bit export, saved through the main process.
  const job = await DesktopStreamedWavExport.begin(store, { bitDepth: 24, sampleRate: SAMPLE_RATE, estimatedBytes: estimateStreamedExportBytes(reference.length, 24, 2) });
  let saved: NonNullable<SmokeInspection['saved']>;
  let result: Awaited<ReturnType<Engine['renderTimelineOfflineStreamed']>>;
  let peakDiskBytes = 0;
  try {
    result = await instance.renderTimelineOfflineStreamed(request, job);
    const finished = await job.finalize({ frames: result.frames, sampleRate: result.sampleRate });
    const outcome = await job.save('apex-smoke-streamed-export.wav');
    if (outcome.canceled || !outcome.path) fail('the smoke save destination was not used');
    const inspection = await inspect(job.jobId, true);
    peakDiskBytes = inspection.peakDiskBytes;
    saved = inspection.saved ?? fail(`the saved file could not be inspected: ${inspection.jobError ?? 'no saved file'}`);
    const { header } = saved;
    if (header.format !== 1 || header.channels !== 2 || header.bitDepth !== 24 || header.sampleRate !== SAMPLE_RATE || header.blockAlign !== 6) fail(`wrong WAV header ${JSON.stringify(header)}`);
    if (header.frames !== result.frames || finished.frames !== result.frames || saved.bytes !== WAV_HEADER_BYTES + result.frames * 6) fail(`frame count mismatch ${JSON.stringify({ header, result, finished, bytes: saved.bytes })}`);
    if (saved.directoryEntries.some(name => name.includes('.apex-partial'))) fail(`a partial file was left next to the saved WAV: ${saved.directoryEntries.join(', ')}`);
  } finally {
    await job.abort();
  }
  if (result.nativeInstruments !== 1 || result.nativeEffects !== 2 || result.passes !== 2) fail(`unexpected render plan ${JSON.stringify(result)}`);
  if (result.frames !== reference.length) fail(`streamed ${result.frames} frames, in-memory render ${reference.length}`);

  // Sample comparison of the saved 24-bit file with the in-memory render.
  const data = saved.data ?? fail('the saved audio was not returned for comparison');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const left = reference.getChannelData(0), right = reference.getChannelData(1);
  let maxDifference = 0, differenceSquares = 0, squares = 0, peak = 0;
  for (let frame = 0; frame < result.frames; frame += 1) {
    for (let ch = 0; ch < 2; ch += 1) {
      const offset = WAV_HEADER_BYTES + (frame * 2 + ch) * 3;
      const raw = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getInt8(offset + 2) << 16);
      const value = raw / 8388608;
      const expected = Math.max(-1, Math.min(1, (ch === 0 ? left : right)[frame]!));
      const difference = Math.abs(value - expected);
      if (difference > maxDifference) maxDifference = difference;
      differenceSquares += difference * difference;
      squares += value * value;
      if (Math.abs(value) > peak) peak = Math.abs(value);
    }
  }
  const rms = Math.sqrt(squares / (result.frames * 2));
  const differenceRms = Math.sqrt(differenceSquares / (result.frames * 2));
  if (!(rms > 0.001) || !(peak > 0.01)) fail(`the saved file is silent (rms ${rms}, peak ${peak})`);
  if (maxDifference > 1e-4 || differenceRms > 1e-5) fail(`the saved file differs from the in-memory render (max ${maxDifference}, rms ${differenceRms})`);

  const afterSave = await inspect();
  if (afterSave.jobCount !== 0 || afterSave.rootEntries.length !== 0) fail(`temporary export files were left: ${JSON.stringify(afterSave)}`);
  const sessionsAfterExport = await sessions();
  if (sessionsAfterExport !== sessionsBefore) fail(`helper sessions leaked after the export: ${sessionsBefore} before, ${sessionsAfterExport} after`);

  // 2. Cancel during the render: no file, no temporary files, no sessions.
  const controller = new AbortController();
  const cancelled = await DesktopStreamedWavExport.begin(store, { bitDepth: 16, sampleRate: SAMPLE_RATE });
  let cancelMessage = '';
  let cancelledAtProgress = -1;
  try {
    await instance.renderTimelineOfflineStreamed({
      ...request,
      onProgress: progress => { if (progress >= 30 && !controller.signal.aborted) { cancelledAtProgress = progress; controller.abort(); } },
    }, cancelled, { signal: controller.signal });
    fail('a cancelled export completed');
  } catch (error) {
    if (!(error instanceof StreamedExportCancelledError)) throw error;
    cancelMessage = error.message;
  } finally {
    await cancelled.abort();
  }
  const afterCancel = await inspect(cancelled.jobId);
  if (afterCancel.jobCount !== 0 || afterCancel.rootEntries.length !== 0 || !afterCancel.jobError) fail(`a cancelled export left files: ${JSON.stringify(afterCancel)}`);
  const sessionsAfterCancel = await sessions();
  if (sessionsAfterCancel !== sessionsBefore) fail(`helper sessions leaked after cancel: ${sessionsBefore} before, ${sessionsAfterCancel} after`);

  return {
    status: 'passed' as const,
    project: { nativeInstruments: result.nativeInstruments, nativeEffects: result.nativeEffects, bars: BARS, bpm: BPM },
    render: { frames: result.frames, sampleRate: result.sampleRate, passes: result.passes, windows: result.windows },
    savedFile: { name: saved.path.split(/[\\/]/).pop(), bytes: saved.bytes, sha256: saved.sha256, header: saved.header, directoryEntries: saved.directoryEntries },
    comparedWithInMemoryRender: { frames: reference.length, maxDifference, differenceRms, rms, peak },
    peakTemporaryDiskBytes: peakDiskBytes,
    exportRoot: afterSave.root,
    temporaryEntriesAfterSave: afterSave.rootEntries.length,
    cancel: { message: cancelMessage, atProgress: cancelledAtProgress, temporaryEntriesAfter: afterCancel.rootEntries.length, jobsAfter: afterCancel.jobCount },
    nativeServiceSessions: { before: sessionsBefore, afterExport: sessionsAfterExport, afterCancel: sessionsAfterCancel },
  };
}
