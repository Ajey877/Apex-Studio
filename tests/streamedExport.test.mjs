// Phase 10G — renderer-side pieces of the streamed VST3 song export that do
// not need a browser: the pass planner, the tail-aware content writer, the WAV
// sample encoder shared with the in-memory export, and the renderer target
// writing through the real main-process export store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  planNativeEffectLevels, StreamedContentWriter, sliceInterleavedWindow, concatFloat32,
  StreamedExportCancelledError, isStreamedExportCancelled, throwIfStreamedExportCancelled,
  STREAM_CHUNK_FRAMES, STREAM_WINDOW_FRAMES,
} from '../src/audio/streamedOfflineExport.ts';
import {
  DesktopStreamedWavExport, STREAMED_EXPORT_MESSAGE_BYTES, estimateStreamedExportBytes, exportUsesNativeVst3, getDesktopExportStore,
} from '../src/audio/streamedWavExport.ts';
import { audioBufferToWav, encodeInterleavedWavSamples } from '../src/audio/wavEncoder.ts';
import { usesStreamedWavExport, describeStreamedExportFailure, formatExportBytes } from '../src/components/ExportModal.tsx';

const require = createRequire(import.meta.url);
const { createExportStore, parseWavHeader, WAV_HEADER_BYTES, MAX_CHUNK_BYTES } = require('../desktop-export.cjs');
const fsp = nodeFs.promises;

/** The preload bridge, bound to one owner, over the real store. `log` records message sizes. */
function bridgeFor(store, owner, saveDir, log = []) {
  return {
    begin: config => store.begin(owner, config),
    write: (jobId, sequence, bytes) => { log.push(bytes.length); return store.write(owner, jobId, sequence, bytes); },
    createScratch: jobId => store.createScratch(owner, jobId),
    appendScratch: (jobId, scratchId, bytes) => { log.push(bytes.length); return store.appendScratch(owner, jobId, scratchId, bytes); },
    readScratch: async (jobId, scratchId, offset, length) => new Uint8Array(await store.readScratch(owner, jobId, scratchId, offset, length)),
    releaseScratch: (jobId, scratchId) => store.releaseScratch(owner, jobId, scratchId),
    finalize: (jobId, result) => store.finalize(owner, jobId, result),
    save: async (jobId, name) => ({ canceled: false, ...(await store.save(owner, jobId, path.join(saveDir, name))) }),
    abort: jobId => store.abort(owner, jobId),
    stats: async jobId => store.stats(owner, jobId),
  };
}

async function withStore(run) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-streamed-test-'));
  const store = createExportStore({ root: path.join(base, 'store') });
  try { await run({ store, base }); }
  finally { await store.disposeAll(); await fsp.rm(base, { recursive: true, force: true }); }
}

/** Interleaved stereo test signal including out-of-range, negative-zero and non-finite samples. */
function signal(frames, seed = 0) {
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Math.sin((i + seed) * 0.0371) * 1.3;
  out.set([1, -1, 0, -0, 1.5, -1.5, 0.5, -0.5, 1e-9, -1e-9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.999999, -0.999999, 3.0517578125e-5], 0);
  return out;
}

const fakeAudioBuffer = (interleaved, sampleRate) => {
  const frames = interleaved.length / 2;
  const channels = [new Float32Array(frames), new Float32Array(frames)];
  for (let i = 0; i < frames; i += 1) { channels[0][i] = interleaved[i * 2]; channels[1][i] = interleaved[i * 2 + 1]; }
  return { numberOfChannels: 2, sampleRate, length: frames, duration: frames / sampleRate, getChannelData: index => channels[index] };
};

test('streamed sample encoding is byte-identical to the in-memory WAV export for every bit depth', async () => {
  const interleaved = signal(20_000);
  for (const bitDepth of [16, 24, 32]) {
    const reference = new Uint8Array(await audioBufferToWav(fakeAudioBuffer(interleaved, 48000), bitDepth).arrayBuffer());
    const streamed = encodeInterleavedWavSamples(interleaved, bitDepth);
    assert.equal(streamed.length, interleaved.length * bitDepth / 8);
    assert.ok(Buffer.from(streamed).equals(Buffer.from(reference.subarray(WAV_HEADER_BYTES))), `${bitDepth}-bit sample bytes match audioBufferToWav`);
    // Encoding in pieces gives the same bytes as encoding at once.
    const pieces = [interleaved.subarray(0, 2), interleaved.subarray(2, 9000), interleaved.subarray(9000)].map(part => encodeInterleavedWavSamples(part, bitDepth));
    assert.ok(Buffer.concat(pieces.map(piece => Buffer.from(piece))).equals(Buffer.from(streamed)));
  }
});

for (const bitDepth of [16, 24, 32]) {
  test(`the renderer target writes a ${bitDepth}-bit file identical to the in-memory export, in bounded whole-frame messages`, () => withStore(async ({ store, base }) => {
    const sampleRate = 44100;
    // More than two 1 MiB messages at every bit depth, and not a multiple of any chunk size.
    const interleaved = signal(600_011, bitDepth);
    const sizes = [];
    const job = await DesktopStreamedWavExport.begin(bridgeFor(store, 'r1', base, sizes), { bitDepth });
    for (let offset = 0; offset < interleaved.length; offset += STREAM_CHUNK_FRAMES * 2) {
      await job.write(interleaved.subarray(offset, Math.min(interleaved.length, offset + STREAM_CHUNK_FRAMES * 2)));
    }
    assert.equal(job.frames, 600_011);
    const finished = await job.finalize({ frames: 600_011, sampleRate });
    assert.equal(finished.bytes, WAV_HEADER_BYTES + 600_011 * 2 * bitDepth / 8);
    const saved = await job.save('out.wav');
    const file = await fsp.readFile(saved.path);
    const reference = Buffer.from(await audioBufferToWav(fakeAudioBuffer(interleaved, sampleRate), bitDepth).arrayBuffer());
    assert.ok(file.equals(reference), 'header and audio are byte-identical to audioBufferToWav');
    assert.deepEqual(parseWavHeader(file.subarray(0, WAV_HEADER_BYTES), file.length).frames, 600_011);
    const frameBytes = 2 * bitDepth / 8;
    assert.ok(sizes.length >= 3);
    assert.ok(sizes.every(size => size > 0 && size <= STREAMED_EXPORT_MESSAGE_BYTES && size <= MAX_CHUNK_BYTES && size % frameBytes === 0),
      'every message is at most 1 MiB and a whole number of frames');
    await job.abort();
  }));
}

test('the renderer target refuses to complete a short export and discards it on abort', () => withStore(async ({ store, base }) => {
  const job = await DesktopStreamedWavExport.begin(bridgeFor(store, 'r1', base), { bitDepth: 24 });
  await job.write(signal(1000));
  await assert.rejects(job.finalize({ frames: 1001, sampleRate: 48000 }), /incomplete: 1000 of 1001 frames/);
  await job.abort();
  await job.abort();
  assert.equal(store.jobCount, 0);
  await assert.rejects(job.write(signal(10)), /already closed/);
  assert.deepEqual(await fsp.readdir(base).then(names => names.filter(name => name !== 'store')), []);
}));

test('effect scratch PCM round-trips through the store exactly, in bounded messages', () => withStore(async ({ store, base }) => {
  const sizes = [];
  const job = await DesktopStreamedWavExport.begin(bridgeFor(store, 'r1', base, sizes), { bitDepth: 16 });
  const scratch = await job.createScratch('vst3-effect-1-a');
  const pcm = signal(STREAM_WINDOW_FRAMES + 12_345, 3).map(value => (Number.isFinite(value) ? value : 0));
  for (let offset = 0; offset < pcm.length; offset += 30_000) await scratch.append(pcm.subarray(offset, Math.min(pcm.length, offset + 30_000)));
  assert.equal(scratch.frames, STREAM_WINDOW_FRAMES + 12_345);
  // One streaming window plus margin is read back at once by the engine.
  const window = await scratch.read(4096, STREAM_WINDOW_FRAMES + 256);
  assert.equal(window.length, (STREAM_WINDOW_FRAMES + 256) * 2);
  assert.deepEqual(Buffer.from(window.buffer, window.byteOffset, window.byteLength), Buffer.from(pcm.buffer, pcm.byteOffset + 4096 * 8, (STREAM_WINDOW_FRAMES + 256) * 8));
  const last = await scratch.read(scratch.frames - 7, 7);
  assert.deepEqual([...last], [...pcm.subarray(pcm.length - 14)]);
  await assert.rejects(scratch.read(scratch.frames - 7, 8));
  assert.ok(sizes.every(size => size <= STREAMED_EXPORT_MESSAGE_BYTES && size % 8 === 0));
  await scratch.release();
  await scratch.release();
  assert.equal((await job.stats()).scratchFiles, 0);
  await job.abort();
}));

test('pass planner: independent tracks share one pass, chains and routing add passes', () => {
  const levels = (tracks, edges = [], sequential = false) => planNativeEffectLevels(tracks, edges, sequential).map(item => `${item.trackId}:${item.slotId}@${item.level}`);
  // Eight inserts on eight tracks that only feed the master: one capture pass.
  const eight = Array.from({ length: 8 }, (_, index) => ({ id: index + 1, slotIds: ['fx'] }));
  const toMaster = eight.map(track => ({ sourceTrackId: track.id, targetTrackId: 0 }));
  assert.deepEqual(new Set(planNativeEffectLevels([...eight, { id: 0, slotIds: [] }], toMaster, false).map(item => item.level)), new Set([1]));
  // Two inserts on one track are a chain.
  assert.deepEqual(levels([{ id: 1, slotIds: ['a', 'b'] }, { id: 0, slotIds: [] }], [{ sourceTrackId: 1, targetTrackId: 0 }]), ['1:a@1', '1:b@2']);
  // A master insert hears every processed track.
  assert.deepEqual(levels([{ id: 1, slotIds: ['a'] }, { id: 2, slotIds: ['b'] }, { id: 0, slotIds: ['m'] }],
    [{ sourceTrackId: 1, targetTrackId: 0 }, { sourceTrackId: 2, targetTrackId: 0 }]), ['1:a@1', '2:b@1', '0:m@2']);
  // Track 1 → bus 3 → master, with inserts on all three.
  assert.deepEqual(levels([{ id: 1, slotIds: ['a'] }, { id: 2, slotIds: [] }, { id: 3, slotIds: ['bus'] }, { id: 0, slotIds: ['m'] }],
    [{ sourceTrackId: 1, targetTrackId: 3 }, { sourceTrackId: 2, targetTrackId: 3 }, { sourceTrackId: 3, targetTrackId: 0 }]), ['1:a@1', '3:bus@2', '0:m@3']);
  // An aux send is an audio edge too.
  assert.deepEqual(levels([{ id: 1, slotIds: ['a'] }, { id: 5, slotIds: ['verb'] }, { id: 0, slotIds: [] }],
    [{ sourceTrackId: 1, targetTrackId: 0 }, { sourceTrackId: 5, targetTrackId: 0 }, { sourceTrackId: 1, targetTrackId: 5 }]), ['1:a@1', '5:verb@2']);
  // A level-detected sidechain keeps the historic one-effect-per-pass order.
  assert.deepEqual(levels([{ id: 1, slotIds: ['a'] }, { id: 2, slotIds: ['b', 'c'] }, { id: 0, slotIds: [] }], toMaster.slice(0, 2), true), ['1:a@1', '2:b@2', '2:c@3']);
  assert.deepEqual(levels([{ id: 1, slotIds: [] }, { id: 0, slotIds: [] }], [{ sourceTrackId: 1, targetTrackId: 0 }]), []);
  // A target ordered before its source is refused instead of rendered wrongly.
  assert.throws(() => planNativeEffectLevels([{ id: 0, slotIds: ['m'] }, { id: 1, slotIds: ['a'] }], [{ sourceTrackId: 1, targetTrackId: 0 }], false), /upstream-first/);
});

/** The Song-export tail rule of the in-memory path, restated for the comparison. */
function expectedFrames(content, songFrames, tailFrames) {
  let lastAudible = -1;
  for (let frame = songFrames + tailFrames - 1; frame >= 0; frame -= 1) {
    if (Math.abs(content[frame * 2]) > 1e-4 || Math.abs(content[frame * 2 + 1]) > 1e-4) { lastAudible = frame; break; }
  }
  if (tailFrames <= 0 || lastAudible < 0) return songFrames;
  return Math.min(songFrames + tailFrames, Math.max(songFrames, lastAudible + 1 + 512));
}

test('content writer applies the Song tail rule while streaming, for any chunking', async () => {
  const songFrames = 10_000, tailFrames = 6000;
  const cases = {
    silentTail: frame => (frame < songFrames ? 0.3 : 0),
    decayInsideTail: frame => (frame < songFrames + 2500 ? 0.3 : 0),
    audibleToTheEnd: () => 0.3,
    entirelySilent: () => 0,
    belowThresholdTail: frame => (frame < songFrames ? 0.3 : 5e-5),
    rightChannelOnlyTail: (frame, channel) => (frame < songFrames ? 0.3 : channel === 1 && frame < songFrames + 100 ? 0.01 : 0),
    endsWithinTrimMargin: frame => (frame < songFrames + tailFrames - 100 ? 0.3 : 0),
  };
  for (const [name, shape] of Object.entries(cases)) {
    const content = new Float32Array((songFrames + tailFrames) * 2);
    for (let frame = 0; frame < songFrames + tailFrames; frame += 1) { content[frame * 2] = shape(frame, 0); content[frame * 2 + 1] = shape(frame, 1); }
    const want = expectedFrames(content, songFrames, tailFrames);
    for (const chunkFrames of [1, 127, 4096, 9999, 10_000, 10_001, 50_000]) {
      const parts = [];
      const writer = new StreamedContentWriter(async part => { parts.push(part.slice()); }, songFrames, tailFrames);
      for (let offset = 0; offset < content.length; offset += chunkFrames * 2) await writer.push(content.subarray(offset, Math.min(content.length, offset + chunkFrames * 2)));
      // Frames past the content window are ignored, not written.
      await writer.push(new Float32Array(64).fill(0.9));
      const frames = await writer.finish();
      const written = concatFloat32(parts);
      assert.equal(frames, want, `${name} @ chunk ${chunkFrames}: frame count`);
      assert.equal(written.length, want * 2, `${name} @ chunk ${chunkFrames}: written frames equal the reported count`);
      assert.deepEqual(Buffer.from(written.buffer, 0, written.byteLength), Buffer.from(content.buffer, 0, want * 8), `${name} @ chunk ${chunkFrames}: bytes`);
      await assert.rejects(writer.push(new Float32Array(2)), /already finalized/);
    }
  }
  // Pattern-scope renders have no tail region: exactly the song window is written.
  const parts = [];
  const writer = new StreamedContentWriter(async part => { parts.push(part.slice()); }, 1000, 0);
  await writer.push(new Float32Array(3000).fill(0.5));
  assert.equal(await writer.finish(), 1000);
  assert.equal(concatFloat32(parts).length, 2000);
  // A short render is padded with silence, never reported shorter than the song.
  const short = [];
  const padded = new StreamedContentWriter(async part => { short.push(part.slice()); }, 9000, 100);
  await padded.push(new Float32Array(2000).fill(0.5));
  assert.equal(await padded.finish(), 9000);
  const all = concatFloat32(short);
  assert.equal(all.length, 18_000);
  assert.ok(all.subarray(2000).every(value => value === 0));
});

test('window slicing clips a tap chunk to the content window', () => {
  const chunk = Float32Array.from({ length: 20 }, (_, index) => index); // frames 100..109
  assert.deepEqual([...sliceInterleavedWindow(chunk, 100, 0, 1000)], [...chunk]);
  assert.deepEqual([...sliceInterleavedWindow(chunk, 100, 104, 1000)], [...chunk.subarray(8)]);
  assert.deepEqual([...sliceInterleavedWindow(chunk, 100, 90, 13)], [...chunk.subarray(0, 6)]);
  assert.deepEqual([...sliceInterleavedWindow(chunk, 100, 103, 2)], [...chunk.subarray(6, 10)]);
  assert.equal(sliceInterleavedWindow(chunk, 100, 110, 50).length, 0);
  assert.equal(sliceInterleavedWindow(chunk, 100, 0, 100).length, 0);
});

test('cancellation is a distinct, recognisable error', () => {
  const controller = new AbortController();
  assert.doesNotThrow(() => throwIfStreamedExportCancelled(controller.signal));
  assert.doesNotThrow(() => throwIfStreamedExportCancelled(undefined));
  controller.abort();
  assert.throws(() => throwIfStreamedExportCancelled(controller.signal), error => error instanceof StreamedExportCancelledError && isStreamedExportCancelled(error));
  assert.equal(isStreamedExportCancelled(Object.assign(new Error('x'), { name: 'StreamedExportCancelledError' })), true, 'survives structured cloning');
  assert.equal(isStreamedExportCancelled(new Error('VST3 helper exited')), false);
  assert.equal(isStreamedExportCancelled(null), false);
});

test('the streamed path is chosen only for a desktop full-song WAV export that contains native VST3 audio', () => {
  for (const format of ['wav16', 'wav24', 'wav32']) {
    assert.equal(usesStreamedWavExport(format, 'song', true, true), true);
    assert.equal(usesStreamedWavExport(format, 'pattern', true, true), false, 'pattern loop keeps the in-memory path');
    assert.equal(usesStreamedWavExport(format, 'song', false, true), false, 'browser build has no export store');
    assert.equal(usesStreamedWavExport(format, 'song', true, false), false, 'no-VST3 project keeps the in-memory path');
  }
  assert.equal(usesStreamedWavExport('stems', 'song', true, true), false);
  assert.equal(usesStreamedWavExport('midi', 'song', true, true), false);

  const vst3Channel = { instrumentType: 'vst3' }, synth = { instrumentType: 'minisynth' };
  const fxTrack = enabled => ({ fxSlots: [{ type: 'vst3', enabled }, { type: 'reverb', enabled: true }] });
  assert.equal(exportUsesNativeVst3([synth], [{ fxSlots: [] }], true), false);
  assert.equal(exportUsesNativeVst3([synth, vst3Channel], [], false), true);
  assert.equal(exportUsesNativeVst3([synth], [fxTrack(true)], true), true);
  assert.equal(exportUsesNativeVst3([synth], [fxTrack(true)], false), false, 'Mixer FX excluded from this export');
  assert.equal(exportUsesNativeVst3([synth], [fxTrack(false)], true), false, 'a bypassed insert is not rendered');
  assert.equal(exportUsesNativeVst3([synth], [{}], true), false);

  assert.equal(getDesktopExportStore(), undefined, 'absent outside the desktop application');
  globalThis.desktopApp = { exportStore: { begin() {}, write() {} } };
  try { assert.equal(typeof getDesktopExportStore().begin, 'function'); }
  finally { delete globalThis.desktopApp; }
  globalThis.desktopApp = { exportStore: { begin: 'no' } };
  try { assert.equal(getDesktopExportStore(), undefined); }
  finally { delete globalThis.desktopApp; }
});

test('disk estimate covers the WAV plus one float32 scratch per native effect', () => {
  const tenMinutes = 600 * 48000;
  assert.equal(estimateStreamedExportBytes(tenMinutes, 24, 0), 44 + tenMinutes * 6);
  assert.equal(estimateStreamedExportBytes(tenMinutes, 32, 8), 44 + tenMinutes * 8 + 8 * tenMinutes * 8);
  assert.equal(estimateStreamedExportBytes(1000, 16, -3), 44 + 4000);
});

test('export failures are reported without transport noise and always say nothing was saved', () => {
  assert.equal(describeStreamedExportFailure(new Error("Error invoking remote method 'export:write': ExportStoreError: The disk is full: Writing the export could not be completed. Free some space and export again; no file was written.")),
    'Export failed: The disk is full: Writing the export could not be completed. Free some space and export again; no file was written.');
  assert.equal(describeStreamedExportFailure(new Error("Error invoking remote method 'vst3:process': Error: VST3 helper exited (SIGKILL). ")),
    'Export failed: VST3 helper exited (SIGKILL). No file was written.');
  assert.equal(describeStreamedExportFailure(new Error('VST3 helper timed out after 2000ms')), 'Export failed: VST3 helper timed out after 2000ms. No file was written.');
  assert.equal(describeStreamedExportFailure(new Error('VST3 plugin missing: C:\\Plugins\\Synth.vst3. Add its folder and relink; saved state has not been changed.')),
    'Export failed: VST3 plugin missing: C:\\Plugins\\Synth.vst3. Add its folder and relink; saved state has not been changed. No file was written.');
  assert.equal(describeStreamedExportFailure(new Error('')), 'Export failed: The export could not be completed. No file was written.');
  assert.equal(describeStreamedExportFailure('plain text'), 'Export failed: plain text. No file was written.');
  assert.equal(formatExportBytes(0), '0 MB');
  assert.equal(formatExportBytes(1.5 * 1024 * 1024), '1.5 MB');
  assert.equal(formatExportBytes(345.6 * 1024 * 1024), '346 MB');
  assert.equal(formatExportBytes(Number.NaN), '0 MB');
});
