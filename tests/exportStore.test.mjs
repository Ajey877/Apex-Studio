// Phase 10G — main-process export store (desktop-export.cjs).
//
// The store is the only code that touches the disk during a streamed VST3 song
// export. These tests drive it directly, with real files in a temporary
// directory: WAV correctness for every bit depth, bounded and ordered writes,
// scratch files, atomic save, failure wording, and cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createExportStore, sweepStaleExportRoots, buildWavHeader, parseWavHeader, sanitizeExportFileName,
  MAX_CHUNK_BYTES, WAV_HEADER_BYTES, MAX_SCRATCH_FILES, PARTIAL_SUFFIX,
} = require('../desktop-export.cjs');

const fsp = nodeFs.promises;
const OWNER = 'renderer-1';

async function withStore(run, options = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-export-test-'));
  const root = path.join(base, 'store');
  const store = createExportStore({ root, ...options });
  try { await run({ store, base, root }); }
  finally {
    await store.disposeAll();
    await fsp.rm(base, { recursive: true, force: true });
  }
}

const listFiles = async dir => {
  const out = [];
  const walk = async current => {
    let entries;
    try { entries = await fsp.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full); else out.push(path.relative(dir, full));
    }
  };
  await walk(dir);
  return out.sort();
};

/** Deterministic PCM bytes for `frames` stereo frames at a bit depth. */
function pcm(frames, bitDepth, seed = 1) {
  const bytesPerSample = bitDepth / 8;
  const buffer = Buffer.alloc(frames * 2 * bytesPerSample);
  for (let i = 0; i < frames * 2; i += 1) {
    const value = Math.sin((i + seed) * 0.013) * 0.8;
    const offset = i * bytesPerSample;
    if (bitDepth === 32) buffer.writeFloatLE(value, offset);
    else if (bitDepth === 24) buffer.writeIntLE(Math.round(value * 0x7fffff), offset, 3);
    else buffer.writeInt16LE(Math.round(value * 0x7fff), offset);
  }
  return buffer;
}

/** A promises-fs whose file handles fail a write once `failAfterBytes` were written. */
function failingFs(code, failAfterBytes, match = () => true) {
  let written = 0;
  return {
    ...fsp,
    open: async (file, flags, mode) => {
      const handle = await fsp.open(file, flags, mode);
      if (!match(String(file))) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'write') {
            return async (buffer, ...rest) => {
              if (written + buffer.length > failAfterBytes) throw Object.assign(new Error(`${code}: injected failure, write`), { code });
              written += buffer.length;
              return target.write(buffer, ...rest);
            };
          }
          const value = target[property];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
  };
}

test('WAV header builder and parser agree for every supported bit depth', () => {
  for (const bitDepth of [16, 24, 32]) {
    const dataBytes = 1000 * 2 * (bitDepth / 8);
    const header = buildWavHeader({ sampleRate: 48000, bitDepth, channels: 2, dataBytes });
    assert.equal(header.length, WAV_HEADER_BYTES);
    assert.equal(header.toString('latin1', 0, 4), 'RIFF');
    assert.equal(header.readUInt32LE(4), 36 + dataBytes);
    assert.equal(header.toString('latin1', 8, 16), 'WAVEfmt ');
    assert.equal(header.readUInt16LE(20), bitDepth === 32 ? 3 : 1, 'format tag: IEEE float for 32-bit, PCM otherwise');
    assert.equal(header.readUInt32LE(28), 48000 * 2 * (bitDepth / 8), 'byte rate');
    assert.equal(header.toString('latin1', 36, 40), 'data');
    assert.deepEqual(parseWavHeader(header, WAV_HEADER_BYTES + dataBytes),
      { format: bitDepth === 32 ? 3 : 1, channels: 2, sampleRate: 48000, bitDepth, blockAlign: 2 * (bitDepth / 8), dataBytes, frames: 1000 });
    assert.throws(() => parseWavHeader(header, WAV_HEADER_BYTES + dataBytes - 4), /size mismatch/);
  }
  assert.throws(() => parseWavHeader(Buffer.alloc(10), 10), /truncated/);
});

for (const bitDepth of [16, 24, 32]) {
  test(`streams a ${bitDepth}-bit WAV to disk and saves it byte for byte`, () => withStore(async ({ store, base, root }) => {
    const frames = 300_000;
    const audio = pcm(frames, bitDepth);
    const { jobId, maxChunkBytes } = await store.begin(OWNER, { bitDepth, channels: 2 });
    assert.equal(maxChunkBytes, MAX_CHUNK_BYTES);
    const chunk = 1024 * 1024 - ((1024 * 1024) % (2 * bitDepth / 8));
    let sequence = 0;
    for (let offset = 0; offset < audio.length; offset += chunk) {
      // A Uint8Array view, as it arrives over IPC, is accepted as well as a Buffer.
      const part = audio.subarray(offset, Math.min(audio.length, offset + chunk));
      await store.write(OWNER, jobId, sequence, sequence % 2 ? new Uint8Array(part) : part);
      sequence += 1;
    }
    const { partialPath, finalPath } = store.describeJob(OWNER, jobId);
    assert.ok(nodeFs.existsSync(partialPath) && !nodeFs.existsSync(finalPath), 'only the partial file exists while writing');
    const finished = await store.finalize(OWNER, jobId, { frames, sampleRate: 44100 });
    assert.deepEqual(finished, { frames, sampleRate: 44100, bitDepth, channels: 2, bytes: WAV_HEADER_BYTES + audio.length });
    assert.ok(!nodeFs.existsSync(partialPath) && nodeFs.existsSync(finalPath), 'the partial file is renamed on completion');

    const destination = path.join(base, `song-${bitDepth}.wav`);
    const saved = await store.save(OWNER, jobId, destination);
    assert.deepEqual(saved, { path: destination, bytes: WAV_HEADER_BYTES + audio.length, frames });
    const file = await fsp.readFile(destination);
    const header = parseWavHeader(file.subarray(0, WAV_HEADER_BYTES), file.length);
    assert.deepEqual(header, { format: bitDepth === 32 ? 3 : 1, channels: 2, sampleRate: 44100, bitDepth, blockAlign: 2 * bitDepth / 8, dataBytes: audio.length, frames });
    assert.ok(file.subarray(WAV_HEADER_BYTES).equals(audio), 'the audio bytes are exactly the bytes that were streamed');
    assert.deepEqual((await fsp.readdir(base)).sort(), [`song-${bitDepth}.wav`, 'store'], 'no partial copy is left next to the saved file');
    assert.equal(store.stats(OWNER, jobId).savedPath, destination);

    await store.abort(OWNER, jobId);
    assert.deepEqual(await listFiles(root), [], 'discarding the job removes its temporary files');
    assert.ok(nodeFs.existsSync(destination), 'a saved copy outlives the job');
  }));
}

test('rejects malformed, oversize and out-of-order audio and never completes that job', () => withStore(async ({ store, root }) => {
  const begin = async () => (await store.begin(OWNER, { bitDepth: 16, channels: 2 })).jobId;
  let jobId = await begin();
  await store.write(OWNER, jobId, 0, pcm(100, 16));
  await assert.rejects(store.write(OWNER, jobId, 2, pcm(100, 16)), /out of order \(expected 1\)/);
  await assert.rejects(store.write(OWNER, jobId, 1, pcm(100, 16)), /out of order/, 'a failed job stays failed');
  await assert.rejects(store.finalize(OWNER, jobId, { frames: 100, sampleRate: 48000 }), /out of order/);

  jobId = await begin(); // one job per renderer: the failed one is discarded
  assert.equal(store.jobCount, 1);
  await assert.rejects(store.write(OWNER, jobId, 0, Buffer.alloc(MAX_CHUNK_BYTES + 4)), /4 MiB/);
  jobId = await begin();
  await assert.rejects(store.write(OWNER, jobId, 0, Buffer.alloc(6)), /malformed/, 'not a whole number of frames');
  jobId = await begin();
  await assert.rejects(store.write(OWNER, jobId, 0, Buffer.alloc(0)), /malformed/);
  jobId = await begin();
  await assert.rejects(store.write(OWNER, jobId, 0, 'not bytes'), /malformed/);
  await store.abort(OWNER, jobId);
  assert.deepEqual(await listFiles(root), []);
}));

test('finalize rejects a frame-count mismatch and an empty export', () => withStore(async ({ store }) => {
  let { jobId } = await store.begin(OWNER, { bitDepth: 24, channels: 2 });
  await store.write(OWNER, jobId, 0, pcm(1000, 24));
  await assert.rejects(store.finalize(OWNER, jobId, { frames: 1001, sampleRate: 48000 }), /incomplete|frames/i);
  await assert.rejects(store.save(OWNER, jobId, path.join(os.tmpdir(), 'never.wav')), /Only a complete export/);
  ({ jobId } = await store.begin(OWNER, { bitDepth: 24, channels: 2 }));
  await assert.rejects(store.finalize(OWNER, jobId, { frames: 0, sampleRate: 48000 }));
  ({ jobId } = await store.begin(OWNER, { bitDepth: 24, channels: 2 }));
  await store.write(OWNER, jobId, 0, pcm(10, 24));
  await assert.rejects(store.finalize(OWNER, jobId, { frames: 10, sampleRate: 7999 }), /sample rate/i);
}));

test('validates the job configuration', () => withStore(async ({ store }) => {
  await assert.rejects(store.begin(OWNER, { bitDepth: 8, channels: 2 }), /bit depth/);
  await assert.rejects(store.begin(OWNER, { bitDepth: 16, channels: 1 }), /stereo/);
  await assert.rejects(store.begin(OWNER, { bitDepth: 16, channels: 2, sampleRate: 500000 }), /sample rate/);
  await assert.rejects(store.begin(OWNER, { bitDepth: 16, channels: 2, estimatedBytes: -1 }), /estimate/);
  await assert.rejects(store.begin('', { bitDepth: 16, channels: 2 }), /owner/);
  assert.throws(() => createExportStore({ root: 'relative/path' }), /absolute/);
  assert.equal(store.jobCount, 0);
}));

test('refuses to start when the estimate exceeds the free disk space', () => withStore(async ({ store, root }) => {
  await assert.rejects(store.begin(OWNER, { bitDepth: 32, channels: 2, estimatedBytes: Number.MAX_SAFE_INTEGER }),
    error => /Not enough free disk space/.test(error.message) && /No file was written\.$/.test(error.message) && error.code === 'ENOSPC');
  assert.equal(store.jobCount, 0);
  assert.deepEqual(await listFiles(root), []);
}));

test('scratch files round-trip float32 PCM in bounded reads and are removed on release', () => withStore(async ({ store, root }) => {
  const { jobId } = await store.begin(OWNER, { bitDepth: 24, channels: 2 });
  const { scratchId } = await store.createScratch(OWNER, jobId);
  const audio = pcm(200_000, 32, 7);
  const half = audio.length / 2;
  assert.deepEqual(await store.appendScratch(OWNER, jobId, scratchId, audio.subarray(0, half)), { bytes: half });
  assert.deepEqual(await store.appendScratch(OWNER, jobId, scratchId, audio.subarray(half)), { bytes: audio.length });
  const middle = await store.readScratch(OWNER, jobId, scratchId, 8 * 1234, 8 * 4096);
  assert.ok(Buffer.from(middle).equals(audio.subarray(8 * 1234, 8 * 1234 + 8 * 4096)));
  const tail = await store.readScratch(OWNER, jobId, scratchId, audio.length - 80, 80);
  assert.ok(Buffer.from(tail).equals(audio.subarray(audio.length - 80)));
  await assert.rejects(store.readScratch(OWNER, jobId, scratchId, audio.length - 8, 16), /out of range/);
  await assert.rejects(store.readScratch(OWNER, jobId, scratchId, 0, MAX_CHUNK_BYTES + 8), /out of range|4 MiB/);
  await assert.rejects(store.readScratch(OWNER, jobId, scratchId, 3, 8), /out of range|4 MiB|malformed/);
  assert.equal(store.stats(OWNER, jobId).scratchFiles, 1);
  assert.ok(store.stats(OWNER, jobId).peakDiskBytes >= audio.length);
  assert.deepEqual(await store.releaseScratch(OWNER, jobId, scratchId), { released: true });
  assert.deepEqual(await store.releaseScratch(OWNER, jobId, scratchId), { released: false });
  assert.deepEqual((await listFiles(root)).filter(file => file.endsWith('.f32')), [], 'the scratch file is gone');
  await assert.rejects(store.readScratch(OWNER, jobId, scratchId, 0, 8), /closed/);

  const ids = [];
  for (let i = 0; i < MAX_SCRATCH_FILES; i += 1) ids.push((await store.createScratch(OWNER, jobId)).scratchId);
  await assert.rejects(store.createScratch(OWNER, jobId), /limit/);
  assert.equal(new Set(ids).size, MAX_SCRATCH_FILES);
  // Malformed temporary audio fails the whole job: nothing built on it can complete.
  await assert.rejects(store.appendScratch(OWNER, jobId, ids[0], Buffer.alloc(12)), /malformed/);
  await assert.rejects(store.write(OWNER, jobId, 0, pcm(10, 24)), /malformed/);
}));

test('a job belongs to one renderer; another renderer cannot read, write, save or discard it', () => withStore(async ({ store, base }) => {
  const { jobId } = await store.begin(OWNER, { bitDepth: 16, channels: 2 });
  await store.write(OWNER, jobId, 0, pcm(100, 16));
  const { scratchId } = await store.createScratch(OWNER, jobId);
  assert.throws(() => store.write('renderer-2', jobId, 1, pcm(100, 16)), /another renderer/);
  assert.throws(() => store.readScratch('renderer-2', jobId, scratchId, 0, 8), /another renderer/);
  assert.throws(() => store.finalize('renderer-2', jobId, { frames: 100, sampleRate: 48000 }), /another renderer/);
  assert.throws(() => store.save('renderer-2', jobId, path.join(base, 'stolen.wav')), /another renderer/);
  assert.throws(() => store.stats('renderer-2', jobId), /another renderer/);
  assert.deepEqual(await store.abort('renderer-2', jobId), { aborted: false });
  assert.throws(() => store.write(OWNER, 'no-such-job', 0, pcm(1, 16)), /closed/);
  // A second renderer has its own job; disposing one owner leaves the other intact.
  const other = await store.begin('renderer-2', { bitDepth: 16, channels: 2 });
  assert.equal(store.jobCount, 2);
  await store.disposeOwner('renderer-2');
  assert.equal(store.jobCount, 1);
  assert.throws(() => store.stats('renderer-2', other.jobId), /closed/);
  await store.write(OWNER, jobId, 1, pcm(100, 16));
  await store.finalize(OWNER, jobId, { frames: 200, sampleRate: 48000 });
}));

test('a failed save leaves an existing destination untouched and the job saveable', () => withStore(async ({ store, base }) => {
  const { jobId } = await store.begin(OWNER, { bitDepth: 16, channels: 2 });
  const audio = pcm(5000, 16);
  await store.write(OWNER, jobId, 0, audio);
  await store.finalize(OWNER, jobId, { frames: 5000, sampleRate: 48000 });

  const destination = path.join(base, 'existing.wav');
  await fsp.writeFile(destination, 'previous export');
  await assert.rejects(store.save(OWNER, jobId, 'relative.wav'), /absolute/);
  await assert.rejects(store.save(OWNER, jobId, path.join(base, 'missing-folder', 'song.wav')),
    error => /^Saving song\.wav failed: /.test(error.message) && /No file was written\.$/.test(error.message));
  // The destination is a directory: the copy succeeds, the final rename cannot.
  const blocked = path.join(base, 'blocked.wav');
  await fsp.mkdir(blocked);
  await fsp.writeFile(path.join(blocked, 'keep.txt'), 'keep');
  await assert.rejects(store.save(OWNER, jobId, blocked), /No file was written\.$/);
  assert.equal(await fsp.readFile(path.join(blocked, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await fsp.readFile(destination, 'utf8'), 'previous export', 'a failed save does not touch other files');
  assert.deepEqual((await fsp.readdir(base)).filter(name => name.endsWith(PARTIAL_SUFFIX)), [], 'no partial copy is left behind');

  // A successful save replaces the existing file atomically, and can be repeated.
  await store.save(OWNER, jobId, destination);
  assert.ok((await fsp.readFile(destination)).subarray(WAV_HEADER_BYTES).equals(audio));
  await store.save(OWNER, jobId, path.join(base, 'second copy.wav'));
  assert.ok((await fsp.readFile(path.join(base, 'second copy.wav'))).equals(await fsp.readFile(destination)));
}));

test('a full disk while writing fails the job with a clear message and leaves no output', () => withStore(async ({ store, root }) => {
  const { jobId } = await store.begin(OWNER, { bitDepth: 32, channels: 2 });
  await store.write(OWNER, jobId, 0, pcm(1000, 32));
  await assert.rejects(store.write(OWNER, jobId, 1, pcm(1000, 32)),
    error => error.name === 'ExportStoreError' && error.code === 'ENOSPC' &&
      error.message === 'The disk is full: Writing the export could not be completed. Free some space and export again; no file was written.');
  await assert.rejects(store.write(OWNER, jobId, 2, pcm(1000, 32)), /disk is full/, 'the job stays failed');
  await assert.rejects(store.finalize(OWNER, jobId, { frames: 1000, sampleRate: 48000 }), /disk is full/);
  assert.equal(store.stats(OWNER, jobId).state, 'failed');
  await store.abort(OWNER, jobId);
  assert.deepEqual(await listFiles(root), []);
}, { fs: failingFs('ENOSPC', 44 + 8000, file => file.endsWith('.partial')) }));

test('a scratch write failure and a permission failure are reported, not swallowed', async () => {
  await withStore(async ({ store }) => {
    const { jobId } = await store.begin(OWNER, { bitDepth: 16, channels: 2 });
    const { scratchId } = await store.createScratch(OWNER, jobId);
    await store.appendScratch(OWNER, jobId, scratchId, pcm(100, 32));
    await assert.rejects(store.appendScratch(OWNER, jobId, scratchId, pcm(100, 32)), /disk is full/);
    await assert.rejects(store.write(OWNER, jobId, 0, pcm(10, 16)), /disk is full/, 'a scratch failure fails the whole job');
  }, { fs: failingFs('ENOSPC', 800, file => file.endsWith('.f32')) });
  await withStore(async ({ store }) => {
    const { jobId } = await store.begin(OWNER, { bitDepth: 16, channels: 2 });
    await assert.rejects(store.write(OWNER, jobId, 0, pcm(10, 16)),
      error => /^Permission denied: Writing the export could not be completed \(EACCES\)\. No file was written\.$/.test(error.message));
  }, { fs: failingFs('EACCES', 0, file => file.endsWith('.partial')) });
});

test('writes are applied in order even when they are issued without awaiting', () => withStore(async ({ store, base }) => {
  const { jobId } = await store.begin(OWNER, { bitDepth: 16, channels: 2 });
  const parts = Array.from({ length: 20 }, (_, index) => pcm(997, 16, index * 31));
  await Promise.all(parts.map((part, index) => store.write(OWNER, jobId, index, part)));
  await store.finalize(OWNER, jobId, { frames: 997 * 20, sampleRate: 48000 });
  const destination = path.join(base, 'ordered.wav');
  await store.save(OWNER, jobId, destination);
  assert.ok((await fsp.readFile(destination)).subarray(WAV_HEADER_BYTES).equals(Buffer.concat(parts)));
}));

test('cancel, renderer loss and shutdown remove every temporary file', async () => {
  await withStore(async ({ store, root }) => {
    const { jobId } = await store.begin(OWNER, { bitDepth: 24, channels: 2 });
    await store.write(OWNER, jobId, 0, pcm(1000, 24));
    const { scratchId } = await store.createScratch(OWNER, jobId);
    await store.appendScratch(OWNER, jobId, scratchId, pcm(1000, 32));
    // Abort while a write is still queued: the write settles, nothing is left.
    const racing = store.write(OWNER, jobId, 1, pcm(1000, 24)).catch(error => error);
    assert.deepEqual(await store.abort(OWNER, jobId), { aborted: true });
    await racing;
    assert.deepEqual(await listFiles(root), []);
    assert.equal(store.jobCount, 0);
    assert.deepEqual(await store.abort(OWNER, jobId), { aborted: false }, 'abort is idempotent');
    assert.throws(() => store.write(OWNER, jobId, 2, pcm(10, 24)), /closed/);

    // Renderer loss: every job of that owner goes, finished or not.
    const finished = await store.begin('gone', { bitDepth: 16, channels: 2 });
    await store.write('gone', finished.jobId, 0, pcm(10, 16));
    await store.finalize('gone', finished.jobId, { frames: 10, sampleRate: 48000 });
    await store.disposeOwner('gone');
    assert.deepEqual(await listFiles(root), []);
  });
  // Application shutdown is synchronous.
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-export-test-'));
  try {
    const root = path.join(base, 'pid-1');
    const store = createExportStore({ root });
    const { jobId } = await store.begin(OWNER, { bitDepth: 16, channels: 2 });
    await store.write(OWNER, jobId, 0, pcm(1000, 16));
    await store.createScratch(OWNER, jobId);
    store.disposeAllSync();
    assert.equal(nodeFs.existsSync(root), false);
    assert.equal(store.jobCount, 0);
  } finally { await fsp.rm(base, { recursive: true, force: true }); }
});

test('stale roots of dead processes are swept; a live process and unrelated folders are kept', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-export-test-'));
  try {
    for (const name of ['pid-11', 'pid-22', 'pid-33', 'notes', 'pid-abc']) {
      await fsp.mkdir(path.join(base, name, 'job-x'), { recursive: true });
      await fsp.writeFile(path.join(base, name, 'job-x', 'master.wav.partial'), 'x');
    }
    await fsp.writeFile(path.join(base, 'pid-44'), 'a file, not a folder');
    const removed = sweepStaleExportRoots(base, 22, pid => pid === 33);
    assert.deepEqual(removed.map(entry => path.basename(String(entry))).sort(), ['pid-11']);
    assert.deepEqual((await fsp.readdir(base)).sort(), ['notes', 'pid-22', 'pid-33', 'pid-44', 'pid-abc']);
    assert.deepEqual(sweepStaleExportRoots(path.join(base, 'does-not-exist')), []);
  } finally { await fsp.rm(base, { recursive: true, force: true }); }
});

test('suggested file names cannot escape the chosen folder', () => {
  assert.equal(sanitizeExportFileName('my_song_master.wav'), 'my_song_master.wav');
  for (const hostile of ['../../etc/passwd', 'C:\\Windows\\system32\\x.wav', 'a/b/c.wav', 'con.wav\u0000', '   ', '', null, undefined, 42]) {
    const name = sanitizeExportFileName(hostile);
    assert.equal(typeof name, 'string');
    assert.ok(name.length > 0 && name.length <= 255, `non-empty bounded name for ${String(hostile)}`);
    assert.ok(!/[\\/\u0000-\u001f:*?"<>|]/.test(name), `no path or reserved characters in ${JSON.stringify(name)}`);
    assert.ok(/\.wav$/i.test(name), `${JSON.stringify(name)} keeps a .wav extension`);
    assert.equal(path.basename(name), name);
  }
});
