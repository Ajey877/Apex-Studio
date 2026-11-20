// Phase 10G — the `export:*` IPC surface of desktop-export.cjs, driven through
// the handlers Electron would call, with stand-ins for `app`, `ipcMain`,
// `dialog` and the window. Real files in a temporary directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { registerExportStore, parseWavHeader, WAV_HEADER_BYTES, ROOT_NAME } = require('../desktop-export.cjs');
const fsp = nodeFs.promises;
const TRUSTED_URL = 'http://localhost:3000/';

async function harness(run, { smokeDir } = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'apex-export-ipc-'));
  const temp = path.join(base, 'temp'), music = path.join(base, 'Music');
  await fsp.mkdir(temp); await fsp.mkdir(music);
  const previous = { smoke: process.env.APEX_SMOKE_TEST, dir: process.env.APEX_SMOKE_EXPORT_DIR, start: process.env.ELECTRON_START_URL };
  delete process.env.ELECTRON_START_URL;
  if (smokeDir) { process.env.APEX_SMOKE_TEST = '1'; process.env.APEX_SMOKE_EXPORT_DIR = path.join(base, smokeDir); await fsp.mkdir(process.env.APEX_SMOKE_EXPORT_DIR); }
  else { delete process.env.APEX_SMOKE_TEST; delete process.env.APEX_SMOKE_EXPORT_DIR; }
  const handlers = new Map();
  const ipcMain = { handle: (channel, fn) => { assert.ok(!handlers.has(channel), `duplicate handler ${channel}`); handlers.set(channel, fn); } };
  const app = Object.assign(new EventEmitter(), { isPackaged: false, getPath: name => ({ temp, music, documents: base })[name] });
  const dialogCalls = [];
  const dialog = { next: { canceled: true }, showSaveDialog: async (win, options) => { dialogCalls.push({ win, options }); return dialog.next; } };
  const makeContents = id => Object.assign(new EventEmitter(), { id, mainFrame: { url: TRUSTED_URL } });
  const contents = makeContents(7);
  const win = { webContents: contents };
  const registered = registerExportStore({ app, ipcMain, dialog, getWindow: () => win });
  app.emit('web-contents-created', {}, contents);
  const invoke = (channel, ...args) => handlers.get(`export:${channel}`)({ sender: contents, senderFrame: contents.mainFrame }, ...args);
  try { await run({ base, temp, music, handlers, app, dialog, dialogCalls, contents, win, invoke, registered, makeContents }); }
  finally {
    app.emit('will-quit');
    for (const [key, value] of [['APEX_SMOKE_TEST', previous.smoke], ['APEX_SMOKE_EXPORT_DIR', previous.dir], ['ELECTRON_START_URL', previous.start]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fsp.rm(base, { recursive: true, force: true });
  }
}

const pcm16 = frames => { const out = new Uint8Array(frames * 4); for (let i = 0; i < out.length; i += 1) out[i] = (i * 31) & 0xff; return out; };
async function renderJob(invoke, frames = 5000) {
  const { jobId } = await invoke('begin', { bitDepth: 16, channels: 2 });
  await invoke('write', jobId, 0, pcm16(frames)); // a Uint8Array, as structured clone delivers it
  await invoke('finalize', jobId, { frames, sampleRate: 48000 });
  return jobId;
}

test('registers exactly the production export channels; the inspection channel exists only in smoke mode', async () => {
  await harness(async ({ handlers }) => {
    assert.deepEqual([...handlers.keys()].sort(), ['abort', 'appendScratch', 'begin', 'createScratch', 'finalize', 'readScratch', 'releaseScratch', 'save', 'stats', 'write'].map(name => `export:${name}`).sort());
  });
  await harness(async ({ handlers }) => { assert.ok(handlers.has('export:smokeInspect')); }, { smokeDir: 'smoke-out' });
});

test('only the main frame of the application window, on the trusted origin, may use the export store', async () => {
  await harness(async ({ handlers, contents, makeContents, temp }) => {
    const begin = handlers.get('export:begin');
    const config = { bitDepth: 16, channels: 2 };
    const other = makeContents(8);
    await assert.rejects(begin({ sender: other, senderFrame: other.mainFrame }, config), /denied for untrusted frame/, 'another window');
    await assert.rejects(begin({ sender: contents, senderFrame: { url: TRUSTED_URL } }, config), /denied/, 'a sub-frame');
    contents.mainFrame.url = 'https://example.com/';
    await assert.rejects(begin({ sender: contents, senderFrame: contents.mainFrame }, config), /denied/, 'a foreign origin');
    contents.mainFrame.url = 'not a url';
    await assert.rejects(begin({ sender: contents, senderFrame: contents.mainFrame }, config), /denied/);
    assert.equal(nodeFs.existsSync(path.join(temp, ROOT_NAME)), false, 'a denied call creates nothing on disk');
    contents.mainFrame.url = TRUSTED_URL;
    const { jobId } = await begin({ sender: contents, senderFrame: contents.mainFrame }, config);
    assert.equal(typeof jobId, 'string');
  });
});

test('export, scratch and save through the IPC handlers; the save dialog decides the destination', async () => {
  await harness(async ({ invoke, dialog, dialogCalls, music, win, temp }) => {
    const { jobId } = await invoke('begin', { bitDepth: 16, channels: 2, estimatedBytes: 100_000 });
    const { scratchId } = await invoke('createScratch', jobId);
    const effect = new Uint8Array(new Float32Array([0.25, -0.25, 0.5, -0.5]).buffer);
    await invoke('appendScratch', jobId, scratchId, effect);
    assert.deepEqual([...new Uint8Array(await invoke('readScratch', jobId, scratchId, 8, 8))], [...effect.subarray(8)]);
    await invoke('releaseScratch', jobId, scratchId);
    const audio = pcm16(5000);
    await invoke('write', jobId, 0, audio.subarray(0, 8000));
    await invoke('write', jobId, 1, audio.subarray(8000));
    await invoke('finalize', jobId, { frames: 5000, sampleRate: 44100 });
    assert.equal((await invoke('stats', jobId)).state, 'complete');
    assert.equal(nodeFs.readdirSync(temp).length, 1, `everything so far lives under the temp folder's ${ROOT_NAME}`);
    assert.deepEqual(nodeFs.readdirSync(path.join(temp, ROOT_NAME)), [`pid-${process.pid}`]);

    // The user cancels the dialog: nothing is written and the export stays available.
    assert.deepEqual(await invoke('save', jobId, '../../outside/My Song.wav'), { canceled: true });
    assert.equal(dialogCalls.length, 1);
    assert.equal(dialogCalls[0].win, win);
    assert.equal(dialogCalls[0].options.defaultPath, path.join(music, 'My Song.wav'), 'a hostile suggestion cannot leave the default folder');
    assert.deepEqual(dialogCalls[0].options.filters, [{ name: 'WAV audio', extensions: ['wav'] }]);
    assert.deepEqual(nodeFs.readdirSync(music), []);

    // The user picks a name without an extension.
    dialog.next = { canceled: false, filePath: path.join(music, 'chosen name') };
    const saved = await invoke('save', jobId, 'My Song.wav');
    assert.deepEqual(saved, { canceled: false, path: path.join(music, 'chosen name.wav'), bytes: WAV_HEADER_BYTES + audio.length, frames: 5000 });
    const file = nodeFs.readFileSync(saved.path);
    assert.deepEqual(parseWavHeader(file.subarray(0, WAV_HEADER_BYTES), file.length), { format: 1, channels: 2, sampleRate: 44100, bitDepth: 16, blockAlign: 4, dataBytes: audio.length, frames: 5000 });
    assert.ok(file.subarray(WAV_HEADER_BYTES).equals(Buffer.from(audio)));
    assert.deepEqual(nodeFs.readdirSync(music), ['chosen name.wav']);

    assert.deepEqual(await invoke('abort', jobId), { aborted: true });
    assert.deepEqual(nodeFs.readdirSync(path.join(temp, ROOT_NAME, `pid-${process.pid}`)), []);
    assert.ok(nodeFs.existsSync(saved.path));
  });
});

test('renderer crash, window destruction and reload discard the export; an in-page navigation does not', async () => {
  for (const [label, trigger, discards] of [
    ['render-process-gone', contents => contents.emit('render-process-gone', {}, { reason: 'crashed' }), true],
    ['destroyed', contents => contents.emit('destroyed'), true],
    ['reload', contents => contents.emit('did-start-navigation', {}, TRUSTED_URL, false, true), true],
    ['in-page navigation', contents => contents.emit('did-start-navigation', {}, `${TRUSTED_URL}#x`, true, true), false],
    ['sub-frame navigation', contents => contents.emit('did-start-navigation', {}, 'https://example.com/', false, false), false],
  ]) {
    await harness(async ({ invoke, contents, temp, registered }) => {
      const jobId = await renderJob(invoke);
      const { jobId: unused } = { jobId };
      const root = path.join(temp, ROOT_NAME, `pid-${process.pid}`);
      assert.equal(nodeFs.readdirSync(root).length, 1);
      trigger(contents);
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(registered.getStore().jobCount, discards ? 0 : 1, label);
      assert.equal(nodeFs.readdirSync(root).length, discards ? 0 : 1, label);
      if (discards) await assert.rejects(async () => invoke('stats', unused), /closed/, label);
    });
  }
});

test('application quit removes the export root synchronously, mid-export included', async () => {
  await harness(async ({ invoke, app, temp }) => {
    const { jobId } = await invoke('begin', { bitDepth: 16, channels: 2 });
    await invoke('write', jobId, 0, pcm16(1000));
    await invoke('createScratch', jobId);
    const root = path.join(temp, ROOT_NAME, `pid-${process.pid}`);
    assert.ok(nodeFs.existsSync(root));
    app.emit('will-quit');
    assert.equal(nodeFs.existsSync(root), false);
  });
});

test('temporary exports left by a dead process are removed at first use', async () => {
  await harness(async ({ invoke, temp }) => {
    const stale = path.join(temp, ROOT_NAME, 'pid-2147483646', 'job-crashed');
    await fsp.mkdir(stale, { recursive: true });
    await fsp.writeFile(path.join(stale, 'master.wav.partial'), Buffer.alloc(1024));
    await invoke('begin', { bitDepth: 16, channels: 2 });
    assert.deepEqual(nodeFs.readdirSync(path.join(temp, ROOT_NAME)), [`pid-${process.pid}`]);
  });
});

test('smoke mode saves to the launch-time folder without a dialog and reports what is on disk', async () => {
  await harness(async ({ invoke, dialogCalls, base }) => {
    const jobId = await renderJob(invoke, 4000);
    const saved = await invoke('save', jobId, '..\\..\\escape\\smoke song.wav');
    assert.equal(saved.path, path.join(base, 'smoke-out', 'smoke song.wav'));
    assert.equal(dialogCalls.length, 0);
    const inspected = await invoke('smokeInspect', jobId);
    assert.equal(inspected.jobCount, 1);
    assert.equal(inspected.job.state, 'complete');
    assert.deepEqual(inspected.saved.header, { format: 1, channels: 2, sampleRate: 48000, bitDepth: 16, blockAlign: 4, dataBytes: 16000, frames: 4000 });
    assert.match(inspected.saved.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(inspected.saved.directoryEntries, ['smoke song.wav']);
    await invoke('abort', jobId);
    const after = await invoke('smokeInspect', jobId);
    assert.deepEqual(after.rootEntries, []);
    assert.equal(after.jobCount, 0);
    assert.match(after.jobError, /closed/);
  }, { smokeDir: 'smoke-out' });
});
