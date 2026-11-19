// Phase 10F: the framed helper protocol must survive plugins that print.
//
// mda Piano (the Steinberg SDK sample, unmodified) calls printf() from its
// audio loop whenever the summed voices leave [-2, 2], which is exactly what
// many overlapping notes do. Before the fix that text left through the same
// pipe as the response frames and the parent rejected the session with
// "Invalid VST3 helper frame".
//
// These tests use the REAL helper executable, the REAL Vst3Service and the
// production AudioEngine export path. Only the tests that need a helper to
// misbehave on purpose (malformed/duplicate/truncated frames) use the IPC
// fault fixture, which never supplies audio.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import * as WebAudio from 'web-audio-engine';
import { Vst3Service } from '../native/vst3/service.mjs';
import { NativeVst3Client } from '../native/vst3/client.mjs';

const build = path.resolve(process.env.APEX_NATIVE_BUILD ?? 'build/native-vst3');
const exeName = process.platform === 'win32' ? 'apex-vst3-host.exe' : 'apex-vst3-host';
const faultName = process.platform === 'win32' ? 'apex-vst3-protocol-fault.exe' : 'apex-vst3-protocol-fault';
const executable = [path.join(build, 'bin', exeName), path.join(build, 'bin/Release', exeName)].find(existsSync);
const fault = [path.join(build, 'bin', faultName), path.join(build, 'bin/Release', faultName)].find(existsSync);
assert.ok(executable && fault, 'Build the native host, the protocol fault fixture and mda-vst3 first; see native/vst3/README.md');
const root = path.join(build, 'VST3/Release');
const rate = 48000;
const evidenceDir = path.resolve('build/native-evidence');
await mkdir(evidenceDir, { recursive: true });
const evidence = { platform: process.platform, arch: process.arch, node: process.version, cases: {} };

const service = new Vst3Service(executable, [root]);
const instruments = (await service.discover('local', 'instrument')).plugins;
const effects = (await service.discover('local', 'effect')).plugins;
const byName = name => {
  const found = instruments.find(item => item.name === name) ?? effects.find(item => item.name === name);
  assert.ok(found, `${name} must be discovered by the real helper`);
  return found;
};
const piano = byName('mda Piano');
// The printf under test, exactly as the SDK sample formats it.
const PIANO_PRINT = /what is this\?\s+-?\d+,\s+-?\d/;


const hash = values => createHash('sha256').update(Buffer.from(values.buffer, values.byteOffset, values.byteLength)).digest('hex');
const rms = (values, start = 0, end = values.length) => {
  let sum = 0;
  for (let i = start; i < end; ++i) sum += values[i] ** 2;
  return Math.sqrt(sum / Math.max(1, end - start));
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(read, accept, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (accept(value) || Date.now() > deadline) return value;
    await sleep(10);
  }
}

/** Diagnostics travel on their own pipes and can trail the responses; wait
 *  until the byte counts stop moving before reading totals. */
async function settledDiagnostics(read, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let previous = read();
  for (;;) {
    await sleep(100);
    const current = read();
    if (!current || !previous) return current;
    if ((current.stdout.bytes === previous.stdout.bytes && current.stderr.bytes === previous.stderr.bytes) || Date.now() > deadline) return current;
    previous = current;
  }
}

/** Never-released note-ons: every block adds `voices` more overlapping notes. */
function overlappingBlock(block, frames, voices, firstNoteId) {
  const events = [];
  const step = Math.max(1, Math.floor(frames / voices));
  for (let i = 0; i < voices; ++i) {
    events.push({ offset: Math.min(frames - 1, i * step), type: 'on', pitch: 36 + ((block * 7 + i) % 60),
      noteId: firstNoteId + i, velocity: 0.8 });
  }
  return events;
}

/** Render `blocks` dense blocks through one real service session. */
async function renderOverlapping(session, { blocks, frames, voices, owner = 'local' }) {
  const output = new Float32Array(blocks * frames * 2);
  let noteId = 1;
  for (let block = 0; block < blocks; ++block) {
    const samples = await service.process(session.id, frames, overlappingBlock(block, frames, voices, noteId), 120, owner);
    noteId += voices;
    assert.equal(samples.length, frames * 2, `block ${block} is a complete planar stereo block`);
    output.set(samples, block * frames * 2);
  }
  return output;
}
const assertFinite = (samples, label) => assert.ok(samples.every(Number.isFinite), `${label}: every sample is finite`);

// ---------------------------------------------------------------------------
// Production export wiring: AudioEngine.renderTimelineOffline -> desktop bridge
// -> Vst3Service -> real helper -> mda Piano. All asynchronous setup happens
// here, before the first test is registered, so the runner never reaches the
// `after` hook while this module is still being evaluated.
// ---------------------------------------------------------------------------
const exportDiagnostics = [];
let killNextExportAfterBlocks = 0;
const bridge = {
  paths: async () => [root], choosePath: async () => null,
  discover: () => service.discover(), inspect: (...args) => service.inspect(...args),
  describe: (...args) => service.describe(...args), parameters: (...args) => service.parameters(...args),
  open: (...args) => service.open(...args),
  process: async (id, frames, events, bpm, parameters) => {
    if (killNextExportAfterBlocks > 0 && --killNextExportAfterBlocks === 0) {
      // A real crash of the real helper while the export is waiting on it.
      const pending = service.process(id, frames, events, bpm, 'local', parameters);
      process.kill(service.getSessionHelperPid(id), 'SIGKILL');
      return pending;
    }
    return service.process(id, frames, events, bpm, 'local', parameters);
  },
  close: async (id, ...rest) => {
    // Read the plug-in output of this export's helper before it is released.
    // (Optional call: on an implementation without the diagnostics accessor
    // the export must fail for its real reason, not on this bookkeeping.)
    const diagnostics = await settledDiagnostics(() => service.getSessionDiagnostics?.(id) ?? null, 3000);
    if (diagnostics) exportDiagnostics.push(diagnostics);
    return service.close(id, ...rest);
  },
};
globalThis.desktopApp = { isDesktop: true, vst3: bridge };
globalThis.window = globalThis;
globalThis.AudioContext = class extends WebAudio.RenderingAudioContext {
  constructor() { super({ sampleRate: rate }); }
};
globalThis.OfflineAudioContext = WebAudio.OfflineAudioContext;
globalThis.document ??= { createElement: () => ({}) };
const { audioEngine } = await import('../src/audio/audioEngine.ts');
const AudioEngine = audioEngine.constructor;
const pianoInstrument = await service.inspect(piano);
// 64 long notes entered over one bar: far more simultaneous notes than the
// plugin has voices, which is the condition that makes it print.
const denseNotes = Array.from({ length: 64 }, (_, i) => ({ id: `n${i}`, pitch: 36 + ((i * 5) % 60), start: (i % 16) * 0.25,
  duration: 12, velocity: 1 }));
const pianoChannel = {
  id: 'piano-dense', name: 'mda Piano dense chord', instrumentType: 'vst3', vst3: pianoInstrument,
  color: '#7e57c2', mixerTrackId: 1, volume: 1, pan: 0, pitch: 0, mute: false, solo: false,
  steps: Array(16).fill(false), notes: denseNotes, synthParams: audioEngine.getDefaultSynthParams(),
};
const tracks = [0, 1].map(id => ({ id, name: `Insert ${id}`, color: '#fff', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 }));
const clip = { id: 'piano-pattern', trackIndex: 0, startBar: 0, lengthBars: 1, type: 'pattern', channelId: pianoChannel.id, color: '#fff', name: 'Dense piano' };
function exportSong(channel = pianoChannel) {
  const engine = new AudioEngine();
  engine.setMasteringState({ enabled: false });
  engine.setBpm(120);
  return engine.renderTimelineOffline([channel], [clip], tracks, 120, 2, rate, true, 'song', undefined, undefined, undefined, 4);
}
test.after(async () => {
  audioEngine.stop();
  await service.dispose();
  await writeFile(path.join(evidenceDir, 'apex-vst3-protocol-isolation.json'), JSON.stringify(evidence, null, 2));
});


// ---------------------------------------------------------------------------
// The defect itself. This test fails on the pre-fix implementation with
// "Invalid VST3 helper frame" on the first dense block.
// ---------------------------------------------------------------------------
test('REGRESSION: mda Piano with many overlapping notes renders through the real Vst3Service and helper', async () => {
  const session = await service.open(piano, rate, 'offline');
  let output;
  try {
    output = await renderOverlapping(session, { blocks: 64, frames: 1024, voices: 48 });
    assert.equal(service.sessionCount, 1, 'the session survives its own plugin printing');
    assertFinite(output, 'mda Piano');
    assert.ok(rms(output) > 0.01, 'the plugin produced real audio');
    // The plugin really did print, and that text is still available. If this
    // were zero the test would not be exercising the defect at all.
    const diagnostics = await eventually(() => service.getSessionDiagnostics(session.id), value => value.stdout.bytes > 0);
    assert.ok(diagnostics.stdout.bytes > 0, 'mda Piano printed to stdout during this render');
    assert.match(diagnostics.stdout.text, PIANO_PRINT, 'the plugin text is preserved as a diagnostic');
    evidence.cases.overlapping = { blocks: 64, frames: 1024, noteOns: 64 * 48, pcmSha256: hash(output),
      pluginStdoutBytes: diagnostics.stdout.bytes, pluginStderrBytes: diagnostics.stderr.bytes };
  } finally { await service.close(session.id); }
  assert.equal(service.sessionCount, 0);

  // Same input, fresh helper: bit-identical PCM, so no frame was dropped,
  // reordered or contaminated by the text that was flowing next to it.
  const again = await service.open(piano, rate, 'offline');
  try {
    const repeat = await renderOverlapping(again, { blocks: 64, frames: 1024, voices: 48 });
    assert.equal(hash(repeat), hash(output), 'two renders of the same dense passage are bit-identical');
  } finally { await service.close(again.id); }
});

test('repeated note-on/note-off on mda Piano keeps the protocol in step for hundreds of requests', async () => {
  const session = await service.open(piano, rate, 'realtime');
  try {
    const frames = 512;
    let noteId = 1, energy = 0;
    const held = [];
    for (let block = 0; block < 300; ++block) {
      const events = [];
      // Release what the previous block started, then retrigger a wide chord.
      while (held.length) { const note = held.pop(); events.push({ offset: 0, type: 'off', pitch: note.pitch, noteId: note.noteId }); }
      for (let i = 0; i < 24; ++i) {
        const note = { pitch: 30 + ((block + i * 3) % 72), noteId: noteId++ };
        held.push(note);
        events.push({ offset: 1 + i * 20, type: 'on', pitch: note.pitch, noteId: note.noteId, velocity: 1 });
      }
      const samples = await service.process(session.id, frames, events, 120);
      assert.equal(samples.length, frames * 2);
      assertFinite(samples, `block ${block}`);
      energy += rms(samples);
    }
    assert.ok(energy > 0.1, 'retriggered notes are audible');
    const diagnostics = await settledDiagnostics(() => service.getSessionDiagnostics(session.id));
    evidence.cases.retrigger = { blocks: 300, pluginStdoutBytes: diagnostics.stdout.bytes };
    assert.equal(service.sessionCount, 1);
  } finally { await service.close(session.id); }
});

test('several instances of the same printing instrument run concurrently without cross-talk', async () => {
  const count = 4;
  const sessions = [];
  try {
    for (let i = 0; i < count; ++i) sessions.push(await service.open(piano, rate, 'offline'));
    assert.equal(new Set(sessions.map(session => service.getSessionHelperPid(session.id))).size, count,
      'each instance is its own helper process');
    // All four render at the same time, each with its own pipes.
    const outputs = await Promise.all(sessions.map(session => renderOverlapping(session, { blocks: 24, frames: 2048, voices: 40 })));
    for (const [index, output] of outputs.entries()) {
      assertFinite(output, `instance ${index}`);
      assert.equal(hash(output), hash(outputs[0]), `instance ${index} produced the same PCM as instance 0`);
    }
    // Diagnostics can trail the responses, so give each stream time to arrive.
    const diagnostics = [];
    for (const session of sessions) diagnostics.push(await settledDiagnostics(() => service.getSessionDiagnostics(session.id)));
    for (const [index, item] of diagnostics.entries()) {
      assert.ok(item.stdout.bytes > 0, `instance ${index} kept its own plugin output`);
    }
    evidence.cases.sameInstrument = { instances: count, pcmSha256: hash(outputs[0]),
      pluginStdoutBytes: diagnostics.map(item => item.stdout.bytes) };
  } finally { for (const session of sessions) await service.close(session.id); }
  assert.equal(service.sessionCount, 0);
});

test('different plugins processing concurrently are unaffected by a neighbour that floods stdout', async () => {
  const quietNames = ['mda JX10', 'mda EPiano', 'mda DX10'];
  const delay = byName('mda Delay');
  const chord = block => [0, 4, 7, 12].map((interval, i) => ({ offset: i * 8, type: block % 2 ? 'off' : 'on', pitch: 48 + interval,
    noteId: 1 + i, velocity: 0.7 }));
  const tone = Float32Array.from({ length: 2048 * 2 }, (_, i) => 0.25 * Math.sin((i % 2048) * 0.05));
  async function renderQuiet(session, kind) {
    const output = new Float32Array(16 * 2048 * 2);
    for (let block = 0; block < 16; ++block) {
      const samples = kind === 'effect'
        ? await service.processAudio(session.id, 2048, tone, 120)
        : await service.process(session.id, 2048, chord(block), 120);
      output.set(samples, block * 2048 * 2);
    }
    return output;
  }
  // Reference: each quiet plugin on its own.
  const solo = {};
  for (const name of quietNames) {
    const session = await service.open(byName(name), rate, 'offline');
    try { solo[name] = hash(await renderQuiet(session, 'instrument')); } finally { await service.close(session.id); }
  }
  const soloDelay = await (async () => {
    const session = await service.open(delay, rate, 'offline', 'local', 'effect');
    try { return hash(await renderQuiet(session, 'effect')); } finally { await service.close(session.id); }
  })();

  const noisy = await service.open(piano, rate, 'offline');
  const quiet = [];
  for (const name of quietNames) quiet.push({ name, session: await service.open(byName(name), rate, 'offline') });
  const effect = await service.open(delay, rate, 'offline', 'local', 'effect');
  try {
    const [, delayed, ...rendered] = await Promise.all([
      renderOverlapping(noisy, { blocks: 16, frames: 4096, voices: 48 }),
      renderQuiet(effect, 'effect'),
      ...quiet.map(item => renderQuiet(item.session, 'instrument')),
    ]);
    for (const [index, item] of quiet.entries()) {
      assert.equal(hash(rendered[index]), solo[item.name], `${item.name} is bit-identical to its solo render`);
      assert.equal(service.getSessionDiagnostics(item.session.id).stdout.bytes, 0,
        `${item.name} printed nothing, and nothing from mda Piano was attributed to it`);
    }
    assert.equal(hash(delayed), soloDelay, 'the effect insert is bit-identical to its solo render');
    const noisyBytes = (await settledDiagnostics(() => service.getSessionDiagnostics(noisy.id))).stdout.bytes;
    assert.ok(noisyBytes > 0, 'mda Piano printed while the others were processing');
    evidence.cases.mixedPlugins = { quiet: quietNames, effect: delay.name, noisyStdoutBytes: noisyBytes };
    assert.equal(service.sessionCount, 5);
  } finally {
    for (const session of [noisy, effect, ...quiet.map(item => item.session)]) await service.close(session.id);
  }
});

test('megabytes of real plugin stdout neither corrupt nor stall processing, and the retained text is bounded', async () => {
  const session = await service.open(piano, rate, 'offline');
  try {
    const started = Date.now();
    // Maximum-size blocks with 512 full-velocity note-ons each: the plugin
    // prints one line per out-of-range sample, megabytes over this render.
    const frames = 16384, blocks = 48, perBlock = 512;
    const output = new Float32Array(blocks * frames * 2);
    let noteId = 1;
    for (let block = 0; block < blocks; ++block) {
      const events = Array.from({ length: perBlock }, (_, i) => ({ offset: i * (frames / perBlock), type: 'on',
        pitch: 36 + (i % 40), noteId: noteId++, velocity: 1 }));
      output.set(await service.process(session.id, frames, events, 120), block * frames * 2);
    }
    const elapsed = Date.now() - started;
    assertFinite(output, 'flooded render');
    const diagnostics = await settledDiagnostics(() => service.getSessionDiagnostics(session.id));
    assert.ok(diagnostics.stdout.bytes > 1024 * 1024, `expected more than 1 MiB of plugin output, saw ${diagnostics.stdout.bytes} bytes`);
    assert.ok(diagnostics.stdout.truncated, 'only a tail is kept');
    assert.ok(Buffer.byteLength(diagnostics.stdout.text) <= 8192, 'the retained diagnostic text is bounded');
    assert.match(diagnostics.stdout.text, PIANO_PRINT);
    assert.ok(elapsed < 60000, `flooded render finished in ${elapsed} ms`);
    evidence.cases.realFlood = { blocks: 48, frames: 16384, noteOns: 48 * 512, elapsedMs: elapsed, pluginStdoutBytes: diagnostics.stdout.bytes,
      retainedBytes: Buffer.byteLength(diagnostics.stdout.text) };
  } finally { await service.close(session.id); }
});

// ---------------------------------------------------------------------------
// Production export path (wiring is at the top of this file).
// ---------------------------------------------------------------------------
test('REGRESSION: production offline export of an overlapping mda Piano part completes and is repeatable', async () => {
  exportDiagnostics.length = 0;
  const first = await exportSong();
  const left = first.getChannelData(0);
  assert.equal(first.sampleRate, rate);
  assertFinite(left, 'export');
  assert.ok(rms(left) > 0.01, 'the export contains the plugin audio');
  assert.equal(service.sessionCount, 0, 'the export released its helper');
  const printed = await eventually(() => exportDiagnostics.reduce((sum, item) => sum + item.stdout.bytes, 0), value => value > 0);
  assert.ok(printed > 0, 'mda Piano printed during this export, so the export exercised the defect');
  const second = await exportSong();
  assert.equal(hash(second.getChannelData(0)), hash(left), 'a second export is bit-identical');
  assert.equal(hash(second.getChannelData(1)), hash(first.getChannelData(1)));
  evidence.cases.productionExport = { frames: first.length, pcmSha256: hash(left), pluginStdoutBytes: printed };
});

test('a helper killed during a pending export request fails that export only; repeated exports afterwards succeed', async () => {
  const reference = hash((await exportSong()).getChannelData(0));
  const saved = JSON.stringify(pianoChannel);
  killNextExportAfterBlocks = 2;
  const started = Date.now();
  await assert.rejects(exportSong(), /VST3 helper exited/);
  assert.ok(Date.now() - started < 10000, 'the failure is reported promptly');
  assert.equal(killNextExportAfterBlocks, 0);
  assert.equal(service.sessionCount, 0, 'the failed export left no session behind');
  assert.equal(JSON.stringify(pianoChannel), saved, 'project data is untouched by the failure');
  for (let attempt = 0; attempt < 3; ++attempt) {
    const retry = await exportSong();
    assert.equal(hash(retry.getChannelData(0)), reference, `export ${attempt + 1} after the failure matches the reference`);
    assert.equal(service.sessionCount, 0);
  }
});

test('terminating the real helper while a request is pending rejects it, closes the session and leaves the service usable', async () => {
  const session = await service.open(piano, rate, 'offline');
  const pid = service.getSessionHelperPid(session.id);
  assert.ok(Number.isInteger(pid) && pid > 0);
  const pending = service.process(session.id, 16384, overlappingBlock(0, 16384, 64, 1), 120);
  process.kill(pid, 'SIGKILL');
  await assert.rejects(pending, /VST3 helper exited/);
  assert.equal(service.sessionCount, 0);
  await assert.rejects(service.process(session.id, 512, [], 120), /session is closed/);
  const replacement = await service.open(piano, rate, 'offline');
  try {
    const samples = await service.process(replacement.id, 1024, overlappingBlock(0, 1024, 48, 1), 120);
    assertFinite(samples, 'replacement session');
  } finally { await service.close(replacement.id); }
});

// ---------------------------------------------------------------------------
// Protocol-level behaviour of the real client against a helper that
// misbehaves on purpose. The fixture uses the same channel code as the host.
// ---------------------------------------------------------------------------
test('diagnostic text on stdout and stderr is counted exactly, bounded in memory and never reaches the frame parser', async () => {
  const client = new NativeVst3Client(fault, { timeoutMs: 30000 });
  try {
    const bytes = 8 * 1024 * 1024;
    let expected = 0;
    // Ordering: every response carries the sequence number of its own request.
    for (let sequence = 1; sequence <= 6; ++sequence) {
      const response = await client.request({ command: 'noise', bytes, sequence });
      assert.equal(response.sequence, sequence, 'responses stay correlated with their requests');
      assert.equal(response.samples.length, 0, 'the fixture never supplies audio');
      expected += bytes;
    }
    const diagnostics = await eventually(() => client.diagnostics(),
      value => value.stdout.bytes === expected && value.stderr.bytes === expected);
    assert.equal(diagnostics.stdout.bytes, expected, 'every stdout byte was drained');
    assert.equal(diagnostics.stderr.bytes, expected, 'every stderr byte was drained');
    assert.ok(diagnostics.stdout.truncated && diagnostics.stderr.truncated);
    assert.ok(Buffer.byteLength(diagnostics.stdout.text) <= 8192 && Buffer.byteLength(diagnostics.stderr.text) <= 8192);
    assert.match(diagnostics.stdout.text, /fixture stdout/);
    assert.match(diagnostics.stderr.text, /fixture stderr/);
    evidence.cases.fixtureFlood = { requests: 6, stdoutBytes: diagnostics.stdout.bytes, stderrBytes: diagnostics.stderr.bytes,
      retainedStdout: Buffer.byteLength(diagnostics.stdout.text), retainedStderr: Buffer.byteLength(diagnostics.stderr.text) };
  } finally { await client.dispose(); }
});

test('a parent that stops reading for a while cannot deadlock a helper that is printing', async () => {
  const client = new NativeVst3Client(fault, { timeoutMs: 30000 });
  try {
    // Far more than any pipe buffer holds, so the helper must wait for us.
    const pending = client.request({ command: 'noise', bytes: 4 * 1024 * 1024, sequence: 7 });
    const blockedUntil = Date.now() + 400;
    while (Date.now() < blockedUntil) { /* event loop deliberately blocked */ }
    assert.equal((await pending).sequence, 7);
    assert.equal((await client.request({ command: 'noise', bytes: 0, sequence: 8 })).sequence, 8);
  } finally { await client.dispose(); }
});

test('frame-shaped bytes on stdout are diagnostics, never a response', async () => {
  const client = new NativeVst3Client(fault, { timeoutMs: 400 });
  try {
    // The fixture writes a perfectly valid frame to stdout and then waits.
    await assert.rejects(client.request({ command: 'stdout-frame' }), /timed out/);
    const diagnostics = client.diagnostics();
    assert.ok(diagnostics.stdout.bytes > 0, 'the bytes were received on the diagnostic channel');
    assert.match(diagnostics.stdout.text, /"ok":true/);
  } finally { await client.dispose(); }
});

test('genuine protocol errors are still reported: malformed, truncated, duplicate and unsolicited frames', async () => {
  const cases = [
    ['malformed', /Invalid VST3 helper frame/],
    ['oversized', /Invalid VST3 helper frame/],
    ['truncated', /VST3 helper exited/],
    ['duplicate', /Unsolicited VST3 helper response/],
    ['bad-json', /JSON|Unexpected/],
    ['bad-pcm', /Non-finite plugin PCM/],
  ];
  for (const [command, expected] of cases) {
    const client = new NativeVst3Client(fault, { timeoutMs: 2000 });
    try {
      await assert.rejects(client.request({ command }), expected, command);
      assert.ok(client.isDead, `${command}: the client is closed`);
      // The failure is sticky: no later request can be answered by stale bytes.
      await assert.rejects(client.request({ command: 'noise', bytes: 0, sequence: 1 }), expected, `${command}: later requests`);
    } finally { await client.dispose(); }
  }
  // A frame that arrives when nothing was asked is an error, not a response
  // waiting to be matched to whatever request comes next.
  const client = new NativeVst3Client(fault, { timeoutMs: 2000 });
  try {
    assert.equal((await client.request({ command: 'late-extra', sequence: 3 })).sequence, 3);
    await eventually(() => client.isDead, Boolean, 3000);
    await assert.rejects(client.request({ command: 'noise', bytes: 0, sequence: 4 }), /Unsolicited VST3 helper response/);
  } finally { await client.dispose(); }
});

test('the helper refuses to start without its protocol channel instead of answering on stdout', async () => {
  const { spawn } = await import('node:child_process');
  for (const binary of [executable, fault]) {
    // The pre-fix invocation: three pipes, no protocol descriptor named.
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out = [], err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.stdin.on('error', () => {});
    child.stdin.end('{"command":"close"}\n');
    const guard = setTimeout(() => child.kill('SIGKILL'), 15000);
    const code = await new Promise(resolve => child.on('close', resolve));
    clearTimeout(guard);
    assert.equal(code, 3, `${path.basename(binary)} exits with the documented status`);
    assert.equal(Buffer.concat(out).length, 0, 'nothing is written to stdout');
    assert.match(Buffer.concat(err).toString('utf8'), /protocol channel unavailable/);
  }
  // And the client never treats stdout as a fallback when the pipe is missing.
  const { setNativeHelperSpawnForTests } = await import('../native/vst3/client.mjs');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  setNativeHelperSpawnForTests(() => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { setImmediate(() => child.emit('close', 0, null)); return true; };
    return child;
  });
  try {
    const client = new NativeVst3Client(executable);
    await assert.rejects(client.request({ command: 'close' }), /protocol channel is unavailable/);
    await client.dispose();
  } finally { setNativeHelperSpawnForTests(null); }
});

test('the real helper is spawned with a dedicated protocol pipe and told which descriptor it is', async () => {
  const { setNativeHelperSpawnForTests, PROTOCOL_FD } = await import('../native/vst3/client.mjs');
  const { spawn } = await import('node:child_process');
  const seen = [];
  setNativeHelperSpawnForTests((file, args, options) => { seen.push({ file, args, options }); return spawn(file, args, options); });
  try {
    const client = new NativeVst3Client(executable);
    try {
      const opened = await client.open(piano, { sampleRate: rate });
      assert.equal(opened.ok, true);
    } finally { await client.dispose(); }
  } finally { setNativeHelperSpawnForTests(null); }
  assert.equal(PROTOCOL_FD, 3);
  assert.deepEqual(seen[0].args, ['--protocol-fd=3']);
  assert.deepEqual(seen[0].options.stdio, ['pipe', 'pipe', 'pipe', 'pipe']);
  assert.equal(seen[0].options.shell, false, 'the real helper never goes through a shell');
});

test('a helper that can no longer write responses shuts down instead of carrying on unheard', {
  skip: process.platform === 'linux' ? false : 'needs /dev/full to make a response write fail without SIGPIPE',
}, async () => {
  const { spawn } = await import('node:child_process');
  const { openSync, closeSync } = await import('node:fs');
  // Descriptor 3 accepts no data, so the very first response fails to write.
  const full = openSync('/dev/full', 'w');
  try {
    const child = spawn(executable, ['--protocol-fd=3'], { stdio: ['pipe', 'pipe', 'pipe', full] });
    const out = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.resume();
    child.stdin.on('error', () => {});
    // Two requests: the helper must stop after the first unanswerable one.
    child.stdin.write('{"command":"snapshot"}\n{"command":"snapshot"}\n');
    // A helper that kept waiting for requests would hang here; bound it.
    const guard = setTimeout(() => child.kill('SIGKILL'), 15000);
    const code = await new Promise(resolve => child.on('close', resolve));
    clearTimeout(guard);
    assert.equal(code, 4, 'documented status for a broken protocol channel');
    assert.equal(Buffer.concat(out).length, 0, 'the response was not diverted to stdout');
  } finally { closeSync(full); }
});
