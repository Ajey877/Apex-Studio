'use strict';
/**
 * Phase 10G — main-process export store.
 *
 * A streamed WAV export never holds the song in the renderer. The renderer
 * sends bounded PCM chunks here; this module owns the bytes on disk:
 *
 *  - the WAV being written (`master.wav.partial` -> `master.wav` once complete),
 *  - bounded scratch files for already-processed VST3 Mixer-effect PCM.
 *
 * Everything lives in one directory per job under a per-process root in the
 * system temporary folder. A job directory is removed when the job is aborted,
 * replaced, when its renderer goes away and when the application quits; roots
 * left behind by a process that died are swept at the next start.
 *
 * A destination chosen by the user is only ever replaced by a complete, valid
 * WAV: the finished file is copied next to the destination under a temporary
 * name and renamed over it, so a failure at any point leaves an existing
 * destination file untouched.
 *
 * `createExportStore` has no Electron dependency (it is unit-tested under
 * `node --test`); `registerExportStore` wires it to IPC.
 */
const path = require('node:path');
const nodeFs = require('node:fs');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

/** Largest IPC payload this store accepts or returns in one message. */
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const WAV_HEADER_BYTES = 44;
/** RIFF sizes are 32-bit: 36 + data must fit. */
const MAX_WAV_DATA_BYTES = 0xffffffff - 36;
const MAX_SCRATCH_FILES = 16;
const MAX_SCRATCH_BYTES = 16 * 1024 * 1024 * 1024;
const SCRATCH_FRAME_BYTES = 8; // interleaved stereo float32
const ROOT_NAME = 'apex-studio-export';
const PARTIAL_SUFFIX = '.apex-partial';

class ExportStoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ExportStoreError';
    if (code) this.code = code;
  }
}

function describeFsError(error, action) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (code === 'ENOSPC' || code === 'EDQUOT') {
    return new ExportStoreError(`The disk is full: ${action} could not be completed. Free some space and export again; no file was written.`, code);
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new ExportStoreError(`Permission denied: ${action} could not be completed (${code}). No file was written.`, code);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ExportStoreError(`${action} failed: ${message}. No file was written.`, code);
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

function buildWavHeader({ sampleRate, bitDepth, channels, dataBytes }) {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  const blockAlign = channels * (bitDepth / 8);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(bitDepth === 32 ? 3 : 1, 20); // IEEE float for 32-bit, PCM otherwise
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** Reads and validates a canonical 44-byte WAV header against the file size. */
function parseWavHeader(header, fileBytes) {
  if (!Buffer.isBuffer(header) || header.length < WAV_HEADER_BYTES) throw new ExportStoreError('WAV header is truncated.');
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE' ||
      header.toString('ascii', 12, 16) !== 'fmt ' || header.toString('ascii', 36, 40) !== 'data') {
    throw new ExportStoreError('WAV header chunk identifiers are invalid.');
  }
  const format = header.readUInt16LE(20);
  const channels = header.readUInt16LE(22);
  const sampleRate = header.readUInt32LE(24);
  const byteRate = header.readUInt32LE(28);
  const blockAlign = header.readUInt16LE(32);
  const bitDepth = header.readUInt16LE(34);
  const dataBytes = header.readUInt32LE(40);
  const riffBytes = header.readUInt32LE(4);
  if (header.readUInt32LE(16) !== 16 || blockAlign !== channels * (bitDepth / 8) || byteRate !== sampleRate * blockAlign ||
      format !== (bitDepth === 32 ? 3 : 1) || riffBytes !== 36 + dataBytes || dataBytes % blockAlign !== 0) {
    throw new ExportStoreError('WAV header fields are inconsistent.');
  }
  if (fileBytes !== undefined && fileBytes !== WAV_HEADER_BYTES + dataBytes) {
    throw new ExportStoreError(`WAV size mismatch: header declares ${dataBytes} data bytes, file holds ${fileBytes - WAV_HEADER_BYTES}.`);
  }
  return { format, channels, sampleRate, bitDepth, blockAlign, dataBytes, frames: dataBytes / blockAlign };
}

function sanitizeExportFileName(value) {
  const raw = typeof value === 'string' ? value : '';
  // Strip any directory part and characters Windows refuses in a file name.
  let name = raw.split(/[\\/]/).pop() || '';
  name = name.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').trim();
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = 'export';
  if (!/\.wav$/i.test(name)) name = `${name}.wav`;
  return name.slice(0, 200);
}

function createExportStore(options) {
  const root = options && options.root;
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new ExportStoreError('Export store root must be an absolute path.');
  const fs = (options && options.fs) || nodeFs.promises;
  const fsSync = (options && options.fsSync) || nodeFs;
  const jobs = new Map();
  let peakDiskBytes = 0;

  const diskBytes = () => {
    let total = 0;
    for (const job of jobs.values()) {
      total += job.dataBytes + (job.dataBytes || job.state === 'complete' ? WAV_HEADER_BYTES : 0);
      for (const scratch of job.scratch.values()) total += scratch.bytes;
    }
    return total;
  };
  const notePeak = job => {
    let jobBytes = job.dataBytes + WAV_HEADER_BYTES;
    for (const scratch of job.scratch.values()) jobBytes += scratch.bytes;
    if (jobBytes > job.peakDiskBytes) job.peakDiskBytes = jobBytes;
    const total = diskBytes();
    if (total > peakDiskBytes) peakDiskBytes = total;
  };

  const requireJob = (owner, jobId) => {
    const job = typeof jobId === 'string' ? jobs.get(jobId) : undefined;
    if (!job || job.owner !== owner) throw new ExportStoreError('Export job is closed or belongs to another renderer.');
    return job;
  };
  // Every operation on a job runs after the previous one, so two IPC messages
  // can never interleave their file positions.
  const serialize = (job, operation) => {
    const run = job.tail.then(operation, operation);
    job.tail = run.then(() => undefined, () => undefined);
    return run;
  };
  const failJob = (job, error) => {
    if (job.state === 'writing') job.state = 'failed';
    job.error = error;
  };
  const assertWritable = job => {
    if (job.state === 'failed') throw job.error || new ExportStoreError('Export job failed.');
    if (job.state !== 'writing') throw new ExportStoreError(`Export job is ${job.state}; it accepts no more audio.`);
  };

  const closeHandles = async job => {
    const handles = [job.handle, ...[...job.scratch.values()].map(scratch => scratch.handle)].filter(Boolean);
    job.handle = null;
    for (const scratch of job.scratch.values()) scratch.handle = null;
    await Promise.allSettled(handles.map(handle => handle.close()));
  };
  const removeJob = async job => {
    jobs.delete(job.id);
    job.state = 'aborted';
    await job.tail;
    await closeHandles(job);
    await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
  };

  const begin = async (owner, config) => {
    const sampleRate = config && config.sampleRate;
    const bitDepth = config && config.bitDepth;
    const channels = config && config.channels !== undefined ? config.channels : 2;
    const estimatedBytes = config && config.estimatedBytes;
    if (typeof owner !== 'string' || !owner) throw new ExportStoreError('Export job owner is required.');
    if (![16, 24, 32].includes(bitDepth)) throw new ExportStoreError('Export bit depth must be 16, 24 or 32.');
    if (channels !== 2) throw new ExportStoreError('Streamed export writes stereo WAV files.');
    if (sampleRate !== undefined && (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000)) {
      throw new ExportStoreError('Export sample rate must be an integer between 8000 and 192000 Hz.');
    }
    if (estimatedBytes !== undefined && (!Number.isFinite(estimatedBytes) || estimatedBytes < 0)) {
      throw new ExportStoreError('Export size estimate is invalid.');
    }
    // One export per renderer: starting a new one discards the previous job,
    // finished or not, so staged files never accumulate.
    for (const job of [...jobs.values()]) if (job.owner === owner) await removeJob(job);
    const id = crypto.randomUUID();
    const dir = path.join(root, `job-${id}`);
    try {
      await fs.mkdir(dir, { recursive: true });
      if (estimatedBytes && typeof fs.statfs === 'function') {
        let free;
        try {
          const stats = await fs.statfs(dir);
          free = Number(stats.bavail) * Number(stats.bsize);
        } catch { free = undefined; }
        if (free !== undefined && Number.isFinite(free) && free < estimatedBytes) {
          const gib = bytes => (bytes / (1024 ** 3)).toFixed(2);
          throw new ExportStoreError(`Not enough free disk space for this export: about ${gib(estimatedBytes)} GB is needed in ${root}, ${gib(free)} GB is free. No file was written.`, 'ENOSPC');
        }
      }
      const partialPath = path.join(dir, 'master.wav.partial');
      const handle = await fs.open(partialPath, 'wx+');
      const job = {
        id, owner, dir, partialPath, finalPath: path.join(dir, 'master.wav'), handle,
        sampleRate, bitDepth, channels, blockAlign: channels * (bitDepth / 8),
        dataBytes: 0, nextSequence: 0, state: 'writing', error: null, tail: Promise.resolve(),
        scratch: new Map(), nextScratch: 1, peakDiskBytes: 0, savedPath: null, frames: 0,
      };
      jobs.set(id, job);
      return { jobId: id, maxChunkBytes: MAX_CHUNK_BYTES };
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error instanceof ExportStoreError ? error : describeFsError(error, 'Creating the temporary export file');
    }
  };

  const write = (owner, jobId, sequence, bytes) => {
    const job = requireJob(owner, jobId);
    return serialize(job, async () => {
      assertWritable(job);
      const buffer = toBuffer(bytes);
      if (!buffer || buffer.length === 0 || buffer.length > MAX_CHUNK_BYTES || buffer.length % job.blockAlign !== 0) {
        const error = new ExportStoreError('Export audio chunk is malformed or exceeds the 4 MiB message bound.');
        failJob(job, error);
        throw error;
      }
      if (sequence !== job.nextSequence) {
        const error = new ExportStoreError(`Export audio chunk ${String(sequence)} arrived out of order (expected ${job.nextSequence}).`);
        failJob(job, error);
        throw error;
      }
      if (job.dataBytes + buffer.length > MAX_WAV_DATA_BYTES) {
        const error = new ExportStoreError('The export exceeds the 4 GiB limit of a WAV file. Export a shorter range, a lower sample rate or a lower bit depth.');
        failJob(job, error);
        throw error;
      }
      try {
        const { bytesWritten } = await job.handle.write(buffer, 0, buffer.length, WAV_HEADER_BYTES + job.dataBytes);
        if (bytesWritten !== buffer.length) throw Object.assign(new Error(`short write (${bytesWritten} of ${buffer.length} bytes)`), { code: 'ENOSPC' });
      } catch (error) {
        const failure = describeFsError(error, 'Writing the export');
        failJob(job, failure);
        throw failure;
      }
      job.dataBytes += buffer.length;
      job.nextSequence += 1;
      notePeak(job);
      return { dataBytes: job.dataBytes };
    });
  };

  const createScratch = (owner, jobId) => {
    const job = requireJob(owner, jobId);
    return serialize(job, async () => {
      assertWritable(job);
      if (job.scratch.size >= MAX_SCRATCH_FILES) throw new ExportStoreError('Export scratch file limit reached.');
      const scratchId = `scratch-${job.nextScratch++}`;
      const filePath = path.join(job.dir, `${scratchId}.f32`);
      try {
        const handle = await fs.open(filePath, 'wx+');
        job.scratch.set(scratchId, { id: scratchId, filePath, handle, bytes: 0 });
      } catch (error) {
        const failure = describeFsError(error, 'Creating temporary effect audio');
        failJob(job, failure);
        throw failure;
      }
      return { scratchId };
    });
  };
  const requireScratch = (job, scratchId) => {
    const scratch = typeof scratchId === 'string' ? job.scratch.get(scratchId) : undefined;
    if (!scratch || !scratch.handle) throw new ExportStoreError('Export scratch file is closed.');
    return scratch;
  };
  const appendScratch = (owner, jobId, scratchId, bytes) => {
    const job = requireJob(owner, jobId);
    return serialize(job, async () => {
      assertWritable(job);
      const scratch = requireScratch(job, scratchId);
      const buffer = toBuffer(bytes);
      if (!buffer || buffer.length === 0 || buffer.length > MAX_CHUNK_BYTES || buffer.length % SCRATCH_FRAME_BYTES !== 0) {
        const error = new ExportStoreError('Temporary effect audio chunk is malformed or exceeds the 4 MiB message bound.');
        failJob(job, error);
        throw error;
      }
      if (scratch.bytes + buffer.length > MAX_SCRATCH_BYTES) {
        const error = new ExportStoreError('Temporary effect audio exceeds the 16 GiB per-effect bound.');
        failJob(job, error);
        throw error;
      }
      try {
        const { bytesWritten } = await scratch.handle.write(buffer, 0, buffer.length, scratch.bytes);
        if (bytesWritten !== buffer.length) throw Object.assign(new Error(`short write (${bytesWritten} of ${buffer.length} bytes)`), { code: 'ENOSPC' });
      } catch (error) {
        const failure = describeFsError(error, 'Writing temporary effect audio');
        failJob(job, failure);
        throw failure;
      }
      scratch.bytes += buffer.length;
      notePeak(job);
      return { bytes: scratch.bytes };
    });
  };
  const readScratch = (owner, jobId, scratchId, byteOffset, byteLength) => {
    const job = requireJob(owner, jobId);
    return serialize(job, async () => {
      assertWritable(job);
      const scratch = requireScratch(job, scratchId);
      if (!Number.isSafeInteger(byteOffset) || !Number.isSafeInteger(byteLength) || byteOffset < 0 || byteLength < 1 ||
          byteLength > MAX_CHUNK_BYTES || byteOffset % SCRATCH_FRAME_BYTES !== 0 || byteLength % SCRATCH_FRAME_BYTES !== 0 ||
          byteOffset + byteLength > scratch.bytes) {
        throw new ExportStoreError('Temporary effect audio read is out of range or exceeds the 4 MiB message bound.');
      }
      const buffer = Buffer.allocUnsafe(byteLength);
      try {
        const { bytesRead } = await scratch.handle.read(buffer, 0, byteLength, byteOffset);
        if (bytesRead !== byteLength) throw new Error(`short read (${bytesRead} of ${byteLength} bytes)`);
      } catch (error) {
        const failure = describeFsError(error, 'Reading temporary effect audio');
        failJob(job, failure);
        throw failure;
      }
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    });
  };
  const releaseScratch = (owner, jobId, scratchId) => {
    const job = requireJob(owner, jobId);
    return serialize(job, async () => {
      const scratch = typeof scratchId === 'string' ? job.scratch.get(scratchId) : undefined;
      if (!scratch) return { released: false };
      job.scratch.delete(scratchId);
      if (scratch.handle) await scratch.handle.close().catch(() => {});
      await fs.rm(scratch.filePath, { force: true }).catch(() => {});
      return { released: true };
    });
  };

  const finalize = (owner, jobId, result) => {
    const job = requireJob(owner, jobId);
    return serialize(job, async () => {
      assertWritable(job);
      const frames = result && result.frames;
      const sampleRate = result && result.sampleRate !== undefined ? result.sampleRate : job.sampleRate;
      if (!Number.isSafeInteger(frames) || frames < 1) {
        const error = new ExportStoreError('The export produced no audio frames.');
        failJob(job, error);
        throw error;
      }
      if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
        const error = new ExportStoreError('Export sample rate must be an integer between 8000 and 192000 Hz.');
        failJob(job, error);
        throw error;
      }
      if (frames * job.blockAlign !== job.dataBytes) {
        const error = new ExportStoreError(`The export is incomplete: ${job.dataBytes / job.blockAlign} of ${frames} frames were received.`);
        failJob(job, error);
        throw error;
      }
      try {
        const header = buildWavHeader({ sampleRate, bitDepth: job.bitDepth, channels: job.channels, dataBytes: job.dataBytes });
        await job.handle.write(header, 0, header.length, 0);
        await job.handle.sync();
        // Validate what is actually on disk before the file may be called complete.
        const stat = await job.handle.stat();
        const check = Buffer.alloc(WAV_HEADER_BYTES);
        await job.handle.read(check, 0, WAV_HEADER_BYTES, 0);
        const parsed = parseWavHeader(check, stat.size);
        if (parsed.frames !== frames || parsed.sampleRate !== sampleRate || parsed.bitDepth !== job.bitDepth || parsed.channels !== job.channels) {
          throw new ExportStoreError('The finished WAV failed validation.');
        }
        await job.handle.close();
        job.handle = null;
        await fs.rename(job.partialPath, job.finalPath);
      } catch (error) {
        const failure = error instanceof ExportStoreError ? error : describeFsError(error, 'Finishing the export');
        failJob(job, failure);
        throw failure;
      }
      // Scratch audio has served its purpose once the master is complete.
      for (const scratch of [...job.scratch.values()]) {
        job.scratch.delete(scratch.id);
        if (scratch.handle) await scratch.handle.close().catch(() => {});
        await fs.rm(scratch.filePath, { force: true }).catch(() => {});
      }
      job.sampleRate = sampleRate;
      job.frames = frames;
      job.state = 'complete';
      return { frames, sampleRate, bitDepth: job.bitDepth, channels: job.channels, bytes: WAV_HEADER_BYTES + job.dataBytes };
    });
  };

  /** Copies the finished WAV to `destination` and atomically replaces it. */
  const save = (owner, jobId, destination) => {
    const job = requireJob(owner, jobId);
    return serialize(job, async () => {
      if (job.state !== 'complete') throw new ExportStoreError('Only a complete export can be saved.');
      if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new ExportStoreError('Export destination must be an absolute path.');
      const temporary = `${destination}.${crypto.randomBytes(6).toString('hex')}${PARTIAL_SUFFIX}`;
      try {
        await fs.copyFile(job.finalPath, temporary, nodeFs.constants.COPYFILE_EXCL);
        const handle = await fs.open(temporary, 'r+');
        try {
          const stat = await handle.stat();
          const check = Buffer.alloc(WAV_HEADER_BYTES);
          await handle.read(check, 0, WAV_HEADER_BYTES, 0);
          const parsed = parseWavHeader(check, stat.size);
          if (parsed.frames !== job.frames) throw new ExportStoreError('The copied WAV failed validation.');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temporary, destination);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error instanceof ExportStoreError ? error : describeFsError(error, `Saving ${path.basename(destination)}`);
      }
      job.savedPath = destination;
      return { path: destination, bytes: WAV_HEADER_BYTES + job.dataBytes, frames: job.frames };
    });
  };

  const abort = async (owner, jobId) => {
    const job = typeof jobId === 'string' ? jobs.get(jobId) : undefined;
    if (!job || job.owner !== owner) return { aborted: false };
    await removeJob(job);
    return { aborted: true };
  };

  const stats = (owner, jobId) => {
    const job = requireJob(owner, jobId);
    let scratchBytes = 0;
    for (const scratch of job.scratch.values()) scratchBytes += scratch.bytes;
    return {
      state: job.state, dataBytes: job.dataBytes, scratchBytes, scratchFiles: job.scratch.size,
      peakDiskBytes: job.peakDiskBytes, frames: job.frames, savedPath: job.savedPath,
    };
  };

  const disposeOwner = async owner => {
    await Promise.allSettled([...jobs.values()].filter(job => job.owner === owner).map(job => removeJob(job)));
  };
  const disposeAll = async () => {
    await Promise.allSettled([...jobs.values()].map(job => removeJob(job)));
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  };
  /**
   * Teardown for application shutdown, where no await can be relied on.
   * Each handle is closed through its own FileHandle (closing the raw
   * descriptor would be repeated, on a possibly reused number, when the handle
   * is collected). The close itself completes on the I/O thread pool while the
   * removal below retries; anything that still cannot be removed is swept by
   * the next launch, because this process id is then no longer alive.
   */
  const disposeAllSync = () => {
    for (const job of jobs.values()) {
      job.state = 'aborted';
      const handles = [job.handle, ...[...job.scratch.values()].map(scratch => scratch.handle)].filter(Boolean);
      job.handle = null;
      for (const scratch of job.scratch.values()) scratch.handle = null;
      for (const handle of handles) {
        try { Promise.resolve(handle.close()).catch(() => {}); } catch { /* already closed */ }
      }
    }
    jobs.clear();
    try { fsSync.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* swept at next launch */ }
  };

  return {
    root, begin, write, createScratch, appendScratch, readScratch, releaseScratch, finalize, save, abort, stats,
    disposeOwner, disposeAll, disposeAllSync,
    get jobCount() { return jobs.size; },
    get peakDiskBytes() { return peakDiskBytes; },
    /** Test/diagnostic view of where a job keeps its files. */
    describeJob(owner, jobId) {
      const job = requireJob(owner, jobId);
      return { dir: job.dir, partialPath: job.partialPath, finalPath: job.finalPath, state: job.state };
    },
  };
}

/**
 * Removes export roots left by application processes that no longer exist.
 * `base` is the shared `apex-studio-export` directory; every process writes
 * under `pid-<pid>` so a second running instance is never touched.
 */
function sweepStaleExportRoots(base, currentPid = process.pid, isAlive) {
  const alive = isAlive || (pid => {
    try { process.kill(pid, 0); return true; } catch (error) { return Boolean(error && error.code === 'EPERM'); }
  });
  const removed = [];
  let entries;
  try { entries = nodeFs.readdirSync(base, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    const match = /^pid-(\d+)$/.exec(entry.name);
    if (!match || !entry.isDirectory()) continue;
    const pid = Number(match[1]);
    if (pid === currentPid || alive(pid)) continue;
    try { nodeFs.rmSync(path.join(base, entry.name), { recursive: true, force: true }); removed.push(entry.name); } catch { /* best effort */ }
  }
  return removed;
}

function registerExportStore({ app, ipcMain, dialog, getWindow }) {
  let store = null;
  const getStore = () => {
    if (!store) {
      const base = path.join(app.getPath('temp'), ROOT_NAME);
      sweepStaleExportRoots(base);
      store = createExportStore({ root: path.join(base, `pid-${process.pid}`) });
    }
    return store;
  };
  const smoke = process.env.APEX_SMOKE_TEST === '1';
  const isTrustedUrl = value => {
    try {
      const url = new URL(value);
      if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
        return url.origin === new URL(process.env.ELECTRON_START_URL || 'http://localhost:3000').origin;
      }
      url.hash = ''; url.search = '';
      const expected = pathToFileURL(path.join(__dirname, 'dist/index.html')).href;
      return process.platform === 'win32' ? url.href.toLowerCase() === expected.toLowerCase() : url.href === expected;
    } catch { return false; }
  };
  const handle = (operation, fn) => ipcMain.handle(`export:${operation}`, async (event, ...args) => {
    const win = getWindow();
    if (!win || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame || !isTrustedUrl(event.senderFrame.url)) {
      throw new Error('Export IPC denied for untrusted frame');
    }
    return fn(String(event.sender.id), ...args);
  });
  handle('begin', (owner, config) => getStore().begin(owner, config));
  handle('write', (owner, jobId, sequence, bytes) => getStore().write(owner, jobId, sequence, bytes));
  handle('createScratch', (owner, jobId) => getStore().createScratch(owner, jobId));
  handle('appendScratch', (owner, jobId, scratchId, bytes) => getStore().appendScratch(owner, jobId, scratchId, bytes));
  handle('readScratch', (owner, jobId, scratchId, byteOffset, byteLength) => getStore().readScratch(owner, jobId, scratchId, byteOffset, byteLength));
  handle('releaseScratch', (owner, jobId, scratchId) => getStore().releaseScratch(owner, jobId, scratchId));
  handle('finalize', (owner, jobId, result) => getStore().finalize(owner, jobId, result));
  handle('abort', (owner, jobId) => getStore().abort(owner, jobId));
  handle('stats', (owner, jobId) => getStore().stats(owner, jobId));
  handle('save', async (owner, jobId, suggestedName) => {
    const name = sanitizeExportFileName(suggestedName);
    // Launch-time test destination: accepted from the launching process only,
    // never from web content, exactly like the smoke plug-in root.
    if (smoke && process.env.APEX_SMOKE_EXPORT_DIR) {
      const destination = path.join(process.env.APEX_SMOKE_EXPORT_DIR, name);
      return { canceled: false, ...(await getStore().save(owner, jobId, destination)) };
    }
    const win = getWindow();
    let directory;
    try { directory = app.getPath('music'); } catch { directory = app.getPath('documents'); }
    const choice = await dialog.showSaveDialog(win, {
      title: 'Save exported WAV',
      defaultPath: path.join(directory, name),
      filters: [{ name: 'WAV audio', extensions: ['wav'] }],
      properties: ['showOverwriteConfirmation', 'createDirectory'],
    });
    if (choice.canceled || !choice.filePath) return { canceled: true };
    const destination = /\.wav$/i.test(choice.filePath) ? choice.filePath : `${choice.filePath}.wav`;
    return { canceled: false, ...(await getStore().save(owner, jobId, destination)) };
  });
  if (smoke) {
    // Smoke-only evidence: what is on disk for a job and what is left in the
    // export root. Registered only when the launching process asked for it.
    handle('smokeInspect', async (owner, jobId, includeAudio) => {
      const current = getStore();
      const list = dir => { try { return nodeFs.readdirSync(dir); } catch { return []; } };
      const result = { root: current.root, rootEntries: list(current.root), jobCount: current.jobCount, peakDiskBytes: current.peakDiskBytes };
      if (typeof jobId === 'string') {
        try {
          const info = current.stats(owner, jobId);
          result.job = info;
          if (info.savedPath) {
            const bytes = nodeFs.readFileSync(info.savedPath);
            result.saved = {
              path: info.savedPath, bytes: bytes.length, header: parseWavHeader(bytes.subarray(0, WAV_HEADER_BYTES), bytes.length),
              sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
              directoryEntries: list(path.dirname(info.savedPath)),
            };
            // The saved file itself, for a sample comparison in the smoke run. Short renders only.
            if (includeAudio === true && bytes.length <= 16 * 1024 * 1024) result.saved.data = new Uint8Array(bytes);
          }
        } catch (error) {
          result.jobError = error instanceof Error ? error.message : String(error);
        }
      }
      return result;
    });
  }
  app.on('web-contents-created', (_event, contents) => {
    const close = () => { if (store) void store.disposeOwner(String(contents.id)); };
    contents.on('render-process-gone', close);
    contents.on('destroyed', close);
    contents.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) close(); });
  });
  app.on('will-quit', () => { if (store) store.disposeAllSync(); });
  return { getStore };
}

module.exports = {
  createExportStore, registerExportStore, sweepStaleExportRoots, buildWavHeader, parseWavHeader, sanitizeExportFileName,
  MAX_CHUNK_BYTES, WAV_HEADER_BYTES, MAX_WAV_DATA_BYTES, MAX_SCRATCH_FILES, PARTIAL_SUFFIX, ROOT_NAME,
};
