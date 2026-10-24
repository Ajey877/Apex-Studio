// Real native integration tests. Deliberately fail (not skip) if not built.
// Run `npm run test:native-vst3`; this is NOT proof of desktop channel hosting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NativeVst3Client, discoverVst3, renderNativeSequence } from '../native/vst3/client.mjs';
import { audioBufferToWav } from '../src/audio/wavEncoder.ts';

const build = path.resolve(process.env.APEX_NATIVE_BUILD ?? 'build/native-vst3');
const exeName = process.platform === 'win32' ? 'apex-vst3-host.exe' : 'apex-vst3-host';
const faultName = process.platform === 'win32' ? 'apex-vst3-protocol-fault.exe' : 'apex-vst3-protocol-fault';
const exe = [path.join(build, 'bin', exeName), path.join(build, 'bin/Release', exeName)].find(existsSync);
const fault = [path.join(build, 'bin', faultName), path.join(build, 'bin/Release', faultName)].find(existsSync);
assert.ok(exe && fault, 'Build native host, protocol fault fixture, and mda-vst3 first; see native/vst3/README.md');
const bundle = path.join(build, 'VST3/Release/mda-vst3.vst3');
assert.ok(existsSync(bundle), 'Real MDA VST3 fixture is required');
const rate = 48000;
const evidenceDir = path.resolve('build/native-evidence');
await mkdir(evidenceDir, { recursive: true });
const discovery = await discoverVst3(exe, [bundle]);
assert.deepEqual(discovery.errors, []);
const plugin = discovery.plugins.find(p => p.name === 'mda JX10');
assert.ok(plugin, 'SDK instrument must genuinely be discovered by factory enumeration');
assert.equal(plugin.classId, '5653544D44416A6D6461206A78313000');

async function withClient(fn, options) {
  const client = new NativeVst3Client(exe);
  try { const opened = await client.open(plugin, options); return await fn(client, opened.plugin); }
  finally { await client.dispose(); }
}
const on = (frame, pitch = 60, velocity = 0.8, noteId = 1) => ({ frame, type: 'on', pitch, velocity, noteId });
const off = (frame, pitch = 60, noteId = 1) => ({ frame, type: 'off', pitch, noteId });
const rms = (samples, start = 0, end = samples.length) => {
  let sum = 0;
  for (let i = start; i < end; ++i) sum += samples[i] ** 2;
  return Math.sqrt(sum / (end - start));
};
const difference = (a, b) => {
  assert.equal(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < a.length; ++i) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum / a.length);
};
const hash = values => createHash('sha256').update(Buffer.from(values.buffer, values.byteOffset, values.byteLength)).digest('hex');
async function render(events, options = {}, settings = {}) {
  return withClient((client) => renderNativeSequence(client, { frames: rate * 3, events, ...settings }), options);
}

// Short release keeps the note-off assertion deterministic, without guessing a
// hard-coded parameter index. The plugin's stable ParamID is sent to its DSP.
async function shortReleaseState() {
  return withClient(async (client, info) => {
    const changes = ['ENV Rel', 'VCF Rel'].map(name => {
      const param = info.parameters.find(p => p.name === name);
      assert.ok(param); return { id: param.id, value: 0 };
    });
    await client.process(1, [], changes);
    return client.snapshot();
  });
}
const releaseState = await shortReleaseState();

test('factory scan returns real instrument identities, not effects, controllers or invented entries', () => {
  assert.deepEqual(discovery.plugins.map(p => p.name).sort(), ['mda DX10', 'mda EPiano', 'mda JX10', 'mda Piano']);
  assert.equal(new Set(discovery.plugins.map(p => p.classId)).size, 4);
  for (const entry of discovery.plugins) {
    assert.equal(entry.vendor, 'mda');
    assert.ok(entry.categories.includes('Instrument'));
    assert.match(entry.classId, /^[A-F0-9]{32}$/);
  }
});

test('user location scan retains missing/broken diagnostics and valid identities; never fabricates a fallback', async () => {
  const root = await mkdtemp(path.join(build, 'scan-test-'));
  try {
    const broken = path.join(root, 'broken.vst3');
    await mkdir(broken);
    const missing = path.join(root, 'missing');
    const result = await discoverVst3(exe, [root, bundle, missing, bundle]);
    assert.equal(result.plugins.length, 4, 'duplicate bundle is not loaded twice');
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors.find(e => e.path === missing));
    assert.match(result.errors.find(e => e.path === broken).error, /load failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('actual plugin DSP distinguishes note/silence, pitch, velocity and parameter state; WAV contains the same PCM', async () => {
  const events = [on(4800), off(24000)];
  const [note] = await render(events, { state: releaseState });
  const [silent] = await render([], { state: releaseState });
  const [higher] = await render([on(4800, 72), off(24000, 72)], { state: releaseState });
  const [soft] = await render([on(4800, 60, 0.2), off(24000)], { state: releaseState });
  assert.equal(rms(silent), 0, 'untriggered instrument must be silent');
  assert.equal(rms(note, 0, 4800), 0, 'no audio before MIDI timestamp');
  assert.ok(rms(note, 6000, 23000) > 0.001, 'MIDI must trigger actual DSP');
  assert.ok(rms(note, rate * 2) < 1e-7, 'note-off must release voice');
  assert.ok(difference(note, higher) > 0.01, 'pitch changes plugin output');
  assert.ok(difference(note, soft) > 0.005, 'velocity changes plugin output');
  assert.ok(rms(note) > rms(soft), 'velocity affects measured level');
  // A second real plugin is an independent DSP negative control: a constant
  // fabricated tone per MIDI event cannot satisfy the timbre comparison.
  const piano = discovery.plugins.find(p => p.name === 'mda Piano');
  const other = new NativeVst3Client(exe);
  let pianoAudio;
  try {
    await other.open(piano);
    [pianoAudio] = await renderNativeSequence(other, { frames: note.length, events });
  } finally { await other.dispose(); }
  assert.ok(difference(note, pianoAudio) > 0.01);
  const buffer = { numberOfChannels: 2, sampleRate: rate, length: note.length,
    getChannelData: channel => channel === 0 ? note : note };
  for (const depth of [16, 24, 32]) {
    const wav = Buffer.from(await audioBufferToWav(buffer, depth).arrayBuffer());
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(24), rate);
    assert.equal(wav.length, 44 + note.length * 2 * (depth / 8));
    if (depth === 32) for (let i = 0; i < note.length; ++i) assert.equal(wav.readFloatLE(44 + i * 8), note[i]);
    await writeFile(path.join(evidenceDir, `mda-jx10-${depth}.wav`), wav);
  }
  const metrics = { plugin, sampleRate: rate, frames: note.length, silenceRms: rms(silent), noteRms: rms(note),
    gateRms: rms(note, 6000, 23000), releasedRms: rms(note, rate * 2), softRms: rms(soft),
    pitchDifferenceRms: difference(note, higher), velocityDifferenceRms: difference(note, soft),
    differentPluginRms: difference(note, pianoAudio), pcmSha256: hash(note),
    scope: 'Native DSP plus Apex WAV encoder only; NOT production transport/export integration' };
  await writeFile(path.join(evidenceDir, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log('Native DSP evidence:', JSON.stringify(metrics));
});

test('sample-accurate boundary events survive the pinned fixture correction (including 16, 704 and 4096)', async () => {
  for (const start of [0, 1, 16, 704, 4096, 4800]) {
    const [pcm] = await render([on(start), off(24000)], { state: releaseState });
    if (start) assert.equal(rms(pcm, 0, start), 0);
    assert.ok(rms(pcm, start, 24000) > 0.001, `note at frame ${start} is not dropped`);
  }
});

test('note-off releases plugin voice, while omitted note-off keeps the same voice sounding', async () => {
  const [released] = await render([on(4800), off(24000)], { state: releaseState });
  const [held] = await render([on(4800)], { state: releaseState });
  assert.ok(rms(held, rate * 2) > 0.001);
  assert.ok(rms(released, rate * 2) < rms(held, rate * 2) * 1e-4);
});

test('one persistent instance handles overlapping notes with stable note identities', async () => {
  const [chord] = await render([on(4800), on(9600, 67, 0.8, 2), off(24000), off(48000, 67, 2)], { state: releaseState });
  const [single] = await render([on(4800), off(24000)], { state: releaseState });
  assert.ok(rms(chord, 30000, 47000) > 0.001, 'first note-off does not silence second voice');
  assert.ok(difference(chord, single) > 0.01);
  assert.equal(rms(chord, rate * 2), 0);
});

test('SDK realtime and offline modes produce the same real DSP output, independent of IPC batch size', async () => {
  const events = [on(4800), off(24000)];
  const [realtime] = await render(events, { state: releaseState, mode: 'realtime' }, { blockSize: 512 });
  const [offline] = await render(events, { state: releaseState, mode: 'offline' }, { blockSize: 4096 });
  assert.ok(rms(realtime) > 0.001);
  assert.ok(difference(realtime, offline) < 1e-6);
  // This verifies kRealtime DSP mode, NOT an AudioContext or physical device.
});

test('identity, opaque component state and explicit stable parameter IDs survive disk save/reopen', async () => {
  const saved = { plugin, state: releaseState };
  const file = path.join(evidenceDir, 'plugin-state.json');
  await writeFile(file, JSON.stringify(saved));
  const reopened = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(reopened, saved);
  assert.ok(reopened.state.component.length > 0, 'real component stream captured');
  assert.deepEqual(reopened.state.parameters.map(p => p.id), [14, 18]);
  const [before] = await render([on(4800), off(24000)], { state: saved.state });
  const [after] = await render([on(4800), off(24000)], { state: reopened.state });
  assert.equal(difference(before, after), 0);
  const modified = structuredClone(reopened.state);
  modified.parameters.push({ id: 6, value: 0.05 }); // real JX10 VCF Freq ParamID
  const [filtered] = await render([on(4800), off(24000)], { state: modified });
  assert.ok(difference(before, filtered) > 0.005, 'persisted stable parameter reaches plugin DSP');
});

test('missing module, wrong class, corrupt/foreign state and unknown parameter fail non-destructively; retry works', async () => {
  const saved = JSON.stringify({ plugin, state: releaseState });
  const cases = [
    [{ ...plugin, path: path.join(build, 'missing.vst3') }, releaseState, /load failed/],
    [{ ...plugin, classId: '00000000000000000000000000000000' }, undefined, /class ID/],
    [plugin, { ...releaseState, classId: '00000000000000000000000000000000' }, /identity/],
    [plugin, { ...releaseState, component: 'zz' }, /hex digit/],
    [plugin, { ...releaseState, component: '' }, /rejected saved/],
    [plugin, { ...releaseState, parameters: [{ id: 4294967295, value: 0.5 }] }, /no longer exists/],
  ];
  const client = new NativeVst3Client(exe);
  try {
    for (const [target, state, message] of cases) {
      await assert.rejects(client.open(target, { state }), message);
      assert.equal(JSON.stringify({ plugin, state: releaseState }), saved, 'original saved data must not be discarded or changed');
      await client.open(plugin, { state: releaseState });
      const [audio] = await renderNativeSequence(client, { frames: 48000, events: [on(4800), off(24000)] });
      assert.ok(rms(audio) > 0.001, 'relink/retry recovers real audio');
      await client.request({ command: 'close' });
    }
  } finally { await client.dispose(); }
});

test('out-of-range events fail the instance; no fabricated/silent success is returned', async () => {
  await withClient(async client => {
    await assert.rejects(client.process(512, [{ offset: 512, type: 'on', pitch: 60, noteId: 1, velocity: 1 }]), /offset out of range/);
    await assert.rejects(client.process(512), /No plugin/);
  });
});

test('helper exit, malformed response and hung process reject and reclaim resources', async () => {
  for (const command of ['exit', 'malformed', 'hang']) {
    const client = new NativeVst3Client(fault, { timeoutMs: 200 });
    try {
      await assert.rejects(client.request({ command }), /exited|Invalid.*frame|timed out/);
      await assert.rejects(client.request({ command: 'process' }), /exited|Invalid.*frame|timed out/);
    } finally { await client.dispose(); }
  }
});

test('cancellation rejects queued work; fresh helper can reload preserved state', async () => {
  const client = new NativeVst3Client(fault);
  const pending = client.request({ command: 'hang' });
  const queued = client.request({ command: 'hang' });
  const rejected = Promise.all([assert.rejects(pending, /cancelled/), assert.rejects(queued, /cancelled/)]);
  client.abort();
  await rejected;
  await client.dispose();
  await withClient(async client => {
    const [audio] = await renderNativeSequence(client, { frames: 48000, events: [on(4800), off(24000)] });
    assert.ok(rms(audio) > 0.001);
  }, { state: releaseState });
});

test('genuine metadata forwards current/default, units, steps and real enum labels; zero-frame edits reach DSP and snapshots', async () => {
  await withClient(async (client, info) => {
    assert.equal(info.controllerAvailable, true);
    const p = info.parameters.find(p => p.name === 'VCF Freq');
    assert.ok(p && p.flags & 1); assert.equal(p.units, '%'); assert.equal(p.stepCount, 0);
    assert.equal(typeof p.shortTitle, 'string'); assert.ok(p.currentValue >= 0 && p.currentValue <= 1);
    const list = info.parameters.find(p => p.name === 'Glide');
    assert.ok(list.choices.some(c => c.label === 'Poly')); assert.equal(list.choices.length, list.stepCount + 1);
    const updated = await client.parameters([{ id: p.id, value: 0.1 }]);
    assert.ok(Math.abs(updated.find(item => item.id === p.id).currentValue - .1) < 1e-7);
    const state = await client.snapshot(); assert.equal(state.parameters.find(item => item.id === p.id).value, .1);
    await withClient(async (_other, reopened) => {
      assert.ok(Math.abs(reopened.parameters.find(item => item.id === p.id).currentValue - .1) < 1e-7);
    }, { state });
  });
});

test('native parameter flush rejects malformed, duplicate, unknown, oversized and out-of-range batches; fresh retry works', async () => {
  const bad = [null, {}, Array(4097).fill({ id: 6, value: .1 }), [{ id: 6, value: .1 }, { id: 6, value: .2 }],
    [{ id: -1, value: .1 }], [{ id: 2 ** 32, value: .1 }], [{ id: 6.5, value: .1 }], [{ id: 0xffffffff, value: .1 }],
    [{ id: 6, value: NaN }], [{ id: 6, value: Infinity }], [{ id: 6, value: -.1 }], [{ id: 6, value: 1.1 }],
    [{ id: 1886548852, value: .5 }]];
  for (const changes of bad) await withClient(async client => { await assert.rejects(client.parameters(changes)); });
  await withClient(async client => { await client.parameters([{ id: 6, value: .2 }]); });
});

test('parameter request timeout/crash/malformed helper responses reject all work, dispose and allow real-plugin retry', async () => {
  for (const mode of ['hang', 'crash', 'malformed']) {
    // Protocol fault fixture is negative-only; never supplies positive PCM.
    const client = new NativeVst3Client(fault, { timeoutMs: 50 });
    try {
      await assert.rejects(client.parameters([{ id: mode, value: .1 }]));
      await assert.rejects(client.parameters([{ id: 6, value: .2 }]));
    } finally { await client.dispose(); }
  }
  await withClient(async client => { await client.parameters([{ id: 6, value: .2 }]); });
});
