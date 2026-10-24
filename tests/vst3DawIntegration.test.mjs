// Real SDK processor -> production InstrumentRegistry -> Apex live/offline mixer
// -> context.destination / production WAV encoder. No mock PCM or fake plugin.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as WebAudio from 'web-audio-engine';
import { Vst3Service } from '../native/vst3/service.mjs';
import { NativeVst3Client, renderNativeSequence } from '../native/vst3/client.mjs';

const build = path.resolve(process.env.APEX_NATIVE_BUILD ?? 'build/native-vst3');
const name = process.platform === 'win32' ? 'apex-vst3-host.exe' : 'apex-vst3-host';
const executable = [path.join(build, 'bin', name), path.join(build, 'bin/Release', name)].find(existsSync);
assert.ok(executable, 'Build the native host and MDA fixture before running the DAW integration tests');
const root = path.join(build, 'VST3/Release');
const service = new Vst3Service(executable, [root]);
const bridge = {
  paths: async () => [root], choosePath: async () => null,
  discover: () => service.discover(), inspect: (...args) => service.inspect(...args),
  describe: (...args) => service.describe(...args), parameters: (...args) => service.parameters(...args),
  open: (...args) => service.open(...args), process: (id, frames, events, bpm, parameters) => service.process(id, frames, events, bpm, 'local', parameters), close: (...args) => service.close(...args),
};
globalThis.desktopApp = { isDesktop: true, vst3: bridge };
globalThis.window = globalThis;
globalThis.AudioContext = class extends WebAudio.RenderingAudioContext {
  constructor() { super({ sampleRate: 48000 }); }
};
globalThis.OfflineAudioContext = WebAudio.OfflineAudioContext;
globalThis.document ??= { createElement: () => ({}) };
const { audioEngine } = await import('../src/audio/audioEngine.ts');
const { getVst3Diagnostics } = await import('../src/audio/nativeVst3Runtime.ts');
const { createDefaultProjectState, normalizeProjectState } = await import('../src/state/projectState.ts');
const { updateChannelInProjectState } = await import('../src/state/projectMutations.ts');
const { serializeProjectState, getAudioIdsForProject } = await import('../src/state/projectPersistence.ts');
const { createHistory } = await import('../src/state/projectHistory.ts');
const { audioBufferToWav } = await import('../src/audio/wavEncoder.ts');
const AudioEngine = audioEngine.constructor;
const rate = 48000;
const evidence = path.resolve('build/native-evidence');
await mkdir(evidence, { recursive: true });
const discovery = await bridge.discover();
const plugin = discovery.plugins.find(item => item.name === 'mda JX10');
assert.ok(plugin);
let instrument = await bridge.inspect(plugin);
instrument = await bridge.inspect(plugin, { ...instrument.state, parameters: [{ id: 14, value: 0 }, { id: 18, value: 0 }] });
const channel = {
  id: 'native-daw', name: 'MDA instrument channel', instrumentType: 'vst3', vst3: instrument,
  color: '#7e57c2', mixerTrackId: 1, volume: 1, pan: 0, pitch: 0, mute: false, solo: false,
  steps: Array(16).fill(false), notes: [{ id: 'score-a', pitch: 60, start: 2, duration: 2, velocity: 0.8 }],
  synthParams: audioEngine.getDefaultSynthParams(),
};
const tracks = [0, 1].map(id => ({ id, name: `Insert ${id}`, color: '#fff', volume: 1, pan: 0, mute: false, solo: false, fxSlots: [], peakL: 0, peakR: 0 }));
const clip = { id: 'native-pattern', trackIndex: 0, startBar: 1, lengthBars: 1, type: 'pattern', channelId: channel.id, color: '#fff', name: 'Native pattern' };
function engine() {
  const result = new AudioEngine();
  result.setMasteringState({ enabled: false });
  result.setBpm(120);
  return result;
}
const rms = (values, start = 0, end = values.length) => {
  let sum = 0;
  for (let i = start; i < end; ++i) sum += values[i] ** 2;
  return Math.sqrt(sum / (end - start));
};
const difference = (a, b) => {
  assert.equal(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < a.length; ++i) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum / a.length);
};
async function exportSong(ch = channel, mixer = tracks, arrangement = [clip], instance = engine()) {
  return instance.renderTimelineOffline([ch], arrangement, mixer, 120, 2, rate, true, 'song', undefined, undefined, undefined, 4);
}
async function reference(events, frames = rate * 4, blockSize = 4096) {
  const client = new NativeVst3Client(executable);
  try {
    await client.open(plugin, { state: instrument.state, sampleRate: rate });
    return await renderNativeSequence(client, { frames, events, blockSize });
  } finally { await client.dispose(); }
}
const events = [
  { frame: 108000, type: 'on', pitch: 60, noteId: 1, velocity: 0.8 },
  { frame: 120000, type: 'off', pitch: 60, noteId: 1 },
];

test.after(async () => { audioEngine.stop(); await service.dispose(); });

test('genuine selection uses the existing channel mutation, normalization and history model', () => {
  const initial = createDefaultProjectState();
  const id = initial.channels[0].id;
  const selected = updateChannelInProjectState(initial, id, { instrumentType: 'vst3', vst3: instrument });
  assert.equal(initial.channels[0].vst3, undefined);
  assert.equal(selected.channels[0].id, id);
  assert.deepEqual(normalizeProjectState(selected).channels[0].vst3, instrument);
  const history = createHistory(initial).commit(selected, 'Load VST3 instrument');
  assert.equal(history.undo().present.channels[0].vst3, undefined);
  assert.deepEqual(history.undo().redo().present.channels[0].vst3, instrument);
  assert.ok(!getAudioIdsForProject(selected).includes(plugin.path), 'plugin paths are not audio-asset IDs');
});

test('production song export contains actual plugin PCM at the Playlist/Piano Roll musical positions', async () => {
  const output = await exportSong();
  const [expected] = await reference(events);
  const actual = output.getChannelData(0);
  assert.equal(output.sampleRate, rate);
  assert.equal(output.length, 192000);
  assert.equal(rms(actual, 0, 108000), 0, 'bar-1 clip + step-2 note must not sound early');
  const onset = actual.findIndex(sample => Math.abs(sample) > 1e-7);
  assert.ok(onset >= 108000 && onset < 108064, `actual native onset ${onset}`);
  assert.ok(rms(actual, 109000, 119000) > 0.01);
  assert.ok(rms(actual, 132000, 192000) < 1e-7, 'actual plugin note-off reaches DSP');
  assert.ok(difference(actual, expected) < 1e-6, 'production export must match independently rendered SDK PCM, not a placeholder signal');
  for (const depth of [16, 24, 32]) {
    const wav = Buffer.from(await audioBufferToWav(output, depth).arrayBuffer());
    assert.equal(wav.readUInt32LE(24), rate);
    await writeFile(path.join(evidence, `apex-song-vst3-${depth}.wav`), wav);
  }
  await writeFile(path.join(evidence, 'apex-song-metrics.json'), JSON.stringify({ onsetFrame: onset, expectedOnsetFrame: 108000,
    noteRms: rms(actual, 109000, 119000), releasedRms: rms(actual, 132000), nativeReferenceDifferenceRms: difference(actual, expected),
    path: 'AudioEngine.renderTimelineOffline -> InstrumentRegistry(vst3) -> native processor -> channel/mixer/master -> WAV',
  }, null, 2));
  assert.equal(service.sessionCount, 0);
});

test('fractional onsets, channel pitch and velocity are supplied by the existing Apex scheduler', async () => {
  const notes = [{ id: 'fraction', pitch: 60, start: 0.375, duration: 1.5, velocity: 0.25 }];
  const output = await exportSong({ ...channel, pitch: 12, notes }, tracks, [{ ...clip, startBar: 0 }]);
  const [expected] = await reference([
    { frame: 2250, type: 'on', pitch: 72, velocity: 0.25, noteId: 1 },
    { frame: 11250, type: 'off', pitch: 72, noteId: 1 },
  ]);
  assert.equal(rms(output.getChannelData(0), 0, 2250), 0);
  assert.ok(difference(output.getChannelData(0), expected) < 1e-6);
});

test('native output uses channel gain/pan, intended mixer fader, effects and master—not a parallel output', async () => {
  const dry = await exportSong();
  const quiet = await exportSong(channel, tracks.map(track => track.id === 1 ? { ...track, volume: 0.25 } : track));
  assert.ok(Math.abs(rms(quiet.getChannelData(0)) / rms(dry.getChannelData(0)) - 0.25) < 1e-5);
  const channelQuiet = await exportSong({ ...channel, volume: 0.5 });
  assert.ok(Math.abs(rms(channelQuiet.getChannelData(0)) / rms(dry.getChannelData(0)) - 0.5) < 1e-5);
  const muted = await exportSong(channel, tracks.map(track => track.id === 1 ? { ...track, mute: true } : track));
  assert.equal(rms(muted.getChannelData(0)), 0);
  const masterMuted = await exportSong(channel, tracks.map(track => track.id === 0 ? { ...track, volume: 0 } : track));
  assert.equal(rms(masterMuted.getChannelData(0)), 0);
  const left = await exportSong({ ...channel, pan: -1 });
  assert.ok(rms(left.getChannelData(0)) > 0.01);
  assert.ok(rms(left.getChannelData(1)) < 1e-7);
  const wet = await exportSong(channel, tracks.map(track => track.id === 1 ? { ...track, fxSlots: [
    { id: 'native-delay', type: 'delay', name: 'Native output delay', enabled: true, mix: 1, params: { time: 0.125, feedback: 0.3 } },
  ] } : track));
  assert.ok(difference(wet.getChannelData(0), dry.getChannelData(0)) > 0.005);
});

async function advanceLive(instance, seconds) {
  const context = instance.getContext();
  const end = context.currentTime + seconds;
  while (context.currentTime < end) {
    // Drive the REAL AudioClockTransport scheduling callback against a
    // deterministic audio clock, without waiting seconds of physical playback.
    if (instance.transport?.getState().playing) {
      clearTimeout(instance.transport.timerId);
      instance.transport.schedule();
    }
    await instance.flushNativeLiveForTest();
    context.processTo(context.currentTime + 0.01);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

test('real live Play/Piano Roll path reaches context.destination; note-off leaves overlapping native voice intact', async () => {
  const instance = engine();
  const native = { ...channel, notes: [
    { id: 'first', pitch: 60, start: 0, duration: 2, velocity: 0.8 },
    { id: 'second', pitch: 67, start: 1, duration: 4, velocity: 0.7 },
  ] };
  try {
    await instance.play([native], [], 'pat', undefined, tracks, 16);
    assert.equal(instance.isPlaybackActive(), true);
    await advanceLive(instance, 1.1);
    const data = instance.getContext().exportAsAudioData();
    const actual = data.channelData[0];
    const onset = actual.findIndex(sample => Math.abs(sample) > 1e-7);
    assert.ok(onset >= 1440 && onset < 1504, `live transport lead: got ${onset}, expected 1440`);
    assert.ok(rms(actual, 19200, 28800) > 0.005, 'second native voice sounds after first note-off');
    assert.ok(rms(actual, 40800, 48000) < 1e-7, 'all native voices release after actual note-off');
    const [expected] = await reference([
      { frame: 0, type: 'on', pitch: 60, velocity: 0.8, noteId: 1 },
      { frame: 6000, type: 'on', pitch: 67, velocity: 0.7, noteId: 2 },
      { frame: 12000, type: 'off', pitch: 60, noteId: 1 },
      { frame: 30000, type: 'off', pitch: 67, noteId: 2 },
    ], actual.length - 1440, 1024);
    assert.ok(difference(actual.subarray(1440), expected) < 1e-6, `live reference difference ${difference(actual.subarray(1440), expected)} first-note ${difference(actual.subarray(1440,7440),expected.subarray(0,6000))}`);
    const buffer = { length: data.length, sampleRate: data.sampleRate, numberOfChannels: 2, getChannelData: index => data.channelData[index] };
    await writeFile(path.join(evidence, 'apex-live-vst3.wav'), Buffer.from(await audioBufferToWav(buffer, 32).arrayBuffer()));
    await writeFile(path.join(evidence, 'apex-live-metrics.json'), JSON.stringify({ onsetFrame: onset,
      overlapRms: rms(actual, 19200, 28800), releasedRms: rms(actual, 40800, 48000),
      nativeReferenceDifferenceRms: difference(actual.subarray(1440), expected),
      path: 'AudioClockTransport -> playNote -> InstrumentRegistry(vst3) -> native processor -> live mixer/master -> context.destination',
      environment: 'Real Web Audio DSP in RenderingAudioContext; not a physical-device assertion',
    }, null, 2));
    assert.ok(!getVst3Diagnostics().some(item => /underrun|deadline|behind/.test(item.message)));
    instance.stop();
    await instance.releaseNativeInstruments();
    const stoppedAt = instance.getContext().currentTime;
    await advanceLive(instance, 0.2);
    const stopped = instance.getContext().exportAsAudioData().channelData[0];
    assert.equal(rms(stopped, Math.ceil(stoppedAt * rate)), 0, 'stop cancels every queued PCM source');
    assert.equal(service.sessionCount, 0);
  } finally { instance.stop(); await instance.releaseNativeInstruments(); }
});

test('hardware MIDI monitoring holds past notated fallback and actual stopChannelNote releases only its native note', async () => {
  const instance = engine();
  try {
    await instance.prepareVst3Channel(channel);
    instance.playNote(channel, { id: 'midi-held', pitch: 60, start: 0, duration: 8, velocity: 0.8 }, undefined, 120, 2);
    await advanceLive(instance, 1.4);
    let data = instance.getContext().exportAsAudioData().channelData[0];
    assert.ok(rms(data, rate, Math.floor(1.3 * rate)) > 0.005, 'hardware voice must not auto-release at 8 steps');
    assert.equal(instance.stopChannelNote(channel.id, 60, 2), 1);
    await advanceLive(instance, 0.35);
    data = instance.getContext().exportAsAudioData().channelData[0];
    assert.ok(rms(data, Math.floor(1.65 * rate)) < 1e-7);
  } finally { instance.stop(); await instance.releaseNativeInstruments(); }
});

test('production serialization, disk reload and undo/redo preserve identity/state and restore identical exported PCM', async () => {
  const project = { ...createDefaultProjectState(), channels: [channel], playlistClips: [clip], mixerTracks: tracks };
  const file = path.join(evidence, 'apex-vst3-project.json');
  await writeFile(file, serializeProjectState(project));
  const restored = normalizeProjectState(JSON.parse(await readFile(file, 'utf8')).state);
  assert.deepEqual(restored.channels[0].vst3, instrument);
  const history = createHistory(restored);
  const builtin = { ...restored, channels: [{ ...restored.channels[0], instrumentType: 'minisynth' }] };
  const undo = history.commit(builtin, 'Switch instrument').undo();
  assert.deepEqual(undo.present.channels[0].vst3, instrument);
  const before = await exportSong();
  const after = await exportSong(undo.present.channels[0]);
  assert.equal(difference(before.getChannelData(0), after.getChannelData(0)), 0);
});

test('missing/invalid state fails actual song export without data loss; relink/retry succeeds', async () => {
  const invalidCases = [
    { ...instrument, path: path.join(root, 'missing.vst3') },
    { ...instrument, state: { ...instrument.state, component: 'zz' } },
    { ...instrument, state: { ...instrument.state, classId: '00000000000000000000000000000000' } },
  ];
  for (const vst3 of invalidCases) {
    const original = JSON.stringify(vst3);
    await assert.rejects(exportSong({ ...channel, vst3 }), /missing|hex digit|identity|invalid/);
    assert.equal(JSON.stringify(vst3), original);
    assert.equal(service.sessionCount, 0);
  }
  const good = await exportSong();
  assert.ok(rms(good.getChannelData(0)) > 0.01);
});

test('browser keeps saved native configuration but refuses unsupported audible native exports', async () => {
  delete globalThis.desktopApp;
  try {
    const data = JSON.stringify(channel);
    await assert.rejects(exportSong(), /desktop application/);
    assert.equal(JSON.stringify(channel), data);
    const silent = await exportSong({ ...channel, mute: true });
    assert.equal(rms(silent.getChannelData(0)), 0);
  } finally { globalThis.desktopApp = { isDesktop: true, vst3: bridge }; }
});

test('repeated play/stop/reopen and project/channel replacement release native resources without stale output', async () => {
  const instance = engine();
  try {
    for (let iteration = 0; iteration < 5; ++iteration) {
      await instance.play([{ ...channel, notes: [{ id: 'repeat', pitch: 60, start: 0, duration: 1, velocity: 0.8 }] }], [], 'pat', undefined, tracks, 16);
      await advanceLive(instance, 0.2);
      assert.ok(service.sessionCount > 0);
      instance.reconcileNativeInstruments([]); // project/channel replacement
      instance.stop();
      await instance.releaseNativeInstruments();
      assert.equal(service.sessionCount, 0);
      const position = instance.getContext().currentTime;
      await advanceLive(instance, 0.12);
      const values = instance.getContext().exportAsAudioData().channelData[0];
      assert.equal(rms(values, Math.ceil(position * rate)), 0);
    }
  } finally { instance.stop(); await instance.releaseNativeInstruments(); }
});

test('Stop during async native Play preparation cancels the take and reaps the pending helper', async () => {
  const instance = engine();
  const pending = instance.play([channel], [], 'pat', undefined, tracks, 16);
  instance.stop();
  await pending;
  await instance.releaseNativeInstruments();
  assert.equal(instance.isPlaybackActive(), false);
  assert.equal(service.sessionCount, 0);
});

test('live channel fader and pan control the shared native PCM output, including already queued buffers', async () => {
  const instance = engine();
  try {
    await instance.prepareVst3Channel(channel);
    instance.playNote(channel, { id: 'fader-held', pitch: 60, start: 0, duration: 8, velocity: 0.8 }, undefined, 120, 2);
    await advanceLive(instance, 0.2);
    instance.updateChannel({ ...channel, pan: -1 });
    await advanceLive(instance, 0.2);
    const panned = instance.getContext().exportAsAudioData();
    assert.ok(rms(panned.channelData[0], 12000, 16800) > 0.01);
    assert.ok(rms(panned.channelData[1], 12000, 16800) < 1e-7);
    instance.updateChannel({ ...channel, volume: 0 });
    const position = instance.getContext().currentTime;
    await advanceLive(instance, 0.2);
    assert.equal(rms(instance.getContext().exportAsAudioData().channelData[0], Math.ceil(position * rate)), 0);
  } finally { instance.stop(); await instance.releaseNativeInstruments(); }
});

test('privileged native service enforces approved locations, owner identity and bounded batches/instances', async () => {
  const denied = new Vst3Service(executable, [path.join(build, 'not-an-approved-location')]);
  await assert.rejects(denied.open(instrument, rate, 'offline'), /not authorized/);
  await denied.dispose();
  const opened = await service.open(instrument, rate, 'offline', 'owner-a');
  try {
    await assert.rejects(service.process(opened.id, 128, [], 120, 'owner-b'), /another renderer/);
    await service.close(opened.id, 'owner-b');
    assert.equal(service.sessionCount, 1);
    await assert.rejects(service.process(opened.id, 16385, [], 120, 'owner-a'), /bounds/);
    await assert.rejects(service.process(opened.id, 128, Array(4097).fill({}), 120, 'owner-a'), /bounds/);
    await assert.rejects(service.process(opened.id, 128, [{ offset: -1, type: 'on', pitch: 60, noteId: 1 }], 120, 'owner-a'), /MIDI event/);
    await assert.rejects(service.process(opened.id, 128, [], NaN, 'owner-a'), /tempo/);
  } finally { await service.closeOwner('owner-a'); }
  const instances = await Promise.all(Array.from({ length: 16 }, () => service.open(instrument, rate, 'offline', 'bounded-owner')));
  assert.equal(instances.length, 16);
  await assert.rejects(service.open(instrument, rate, 'offline', 'bounded-owner'), /session limit/);
  await service.closeOwner('bounded-owner');
  assert.equal(service.sessionCount, 0);
});

test('real abrupt helper failure and deadline through production export preserve project data and allow retry', async () => {
  const { cp } = await import('node:fs/promises');
  const faultName = process.platform === 'win32' ? 'apex-vst3-protocol-fault.exe' : 'apex-vst3-protocol-fault';
  const fault = [path.join(build, 'bin', faultName), path.join(build, 'bin/Release', faultName)].find(existsSync);
  assert.ok(fault);
  const faults = path.join(build, 'host-failure');
  await mkdir(faults, { recursive: true });
  const failingService = new Vst3Service(fault, [faults]);
  // This executable NEVER supplies audio. Success evidence always uses the
  // genuine native host; the fixture is exclusively for crash/hang rejection.
  globalThis.desktopApp.vst3 = { ...bridge,
    describe: (...args) => service.describe(...args), parameters: (...args) => service.parameters(...args),
  open: (...args) => failingService.open(...args), process: (...args) => failingService.process(...args), close: (...args) => failingService.close(...args),
  };
  try {
    for (const condition of ['crash', 'hang']) {
      const file = path.join(faults, `${condition}.vst3`);
      await cp(plugin.path, file, { recursive: true });
      const failedChannel = { ...channel, vst3: { ...instrument, path: file } };
      const saved = JSON.stringify(failedChannel);
      const start = Date.now();
      await assert.rejects(exportSong(failedChannel), condition === 'hang' ? /timed out/ : /helper exited/);
      assert.ok(Date.now() - start < 5000, 'helper failures have a finite cleanup deadline');
      assert.equal(JSON.stringify(failedChannel), saved);
      assert.equal(failingService.sessionCount, 0);
    }
  } finally { globalThis.desktopApp.vst3 = bridge; await failingService.dispose(); }
  assert.ok(rms((await exportSong()).getChannelData(0)) > 0.01);
});

test('closed live contexts are replaced before native preparation without cancelling the new take', async () => {
  const instance = engine();
  try {
    await instance.prepareVst3Channel(channel);
    const previous = instance.getContext();
    await previous.close();
    await instance.play([{ ...channel, notes: [{ id: 'reopen', pitch: 60, start: 0, duration: 2, velocity: 0.8 }] }], [], 'pat', undefined, tracks, 16);
    assert.notEqual(instance.getContext(), previous);
    assert.equal(instance.isPlaybackActive(), true);
    await advanceLive(instance, 0.2);
    assert.ok(rms(instance.getContext().exportAsAudioData().channelData[0]) > 0.001);
  } finally { instance.stop(); await instance.releaseNativeInstruments(); }
  assert.equal(service.sessionCount, 0);
});

test('real control-thread underrun stops native sources visibly and a fresh take recovers without stale PCM', async () => {
  const instance = engine();
  try {
    const native = { ...channel, notes: [{ id: 'underrun', pitch: 60, start: 0, duration: 8, velocity: 0.8 }] };
    const original = JSON.stringify(native);
    await instance.play([native], [], 'pat', undefined, tracks, 16);
    await instance.flushNativeLiveForTest();
    instance.getContext().processTo(0.3); // real missed producer deadlines, not a fake bridge
    await instance.flushNativeLiveForTest();
    assert.match(getVst3Diagnostics().find(item => item.channelId === native.id)?.message ?? '', /underrun/);
    const position = instance.getContext().currentTime;
    await advanceLive(instance, 0.1);
    assert.equal(rms(instance.getContext().exportAsAudioData().channelData[0], Math.ceil(position * rate)), 0);
    assert.equal(JSON.stringify(native), original);
    instance.stop();
    await instance.releaseNativeInstruments();
    await instance.play([native], [], 'pat', undefined, tracks, 16);
    await advanceLive(instance, 0.2);
    assert.ok(!/underrun/.test(getVst3Diagnostics().find(item => item.channelId === native.id)?.message ?? ''));
  } finally { instance.stop(); await instance.releaseNativeInstruments(); }
  assert.equal(service.sessionCount, 0);
});

test('project edits during async Play preparation cancel obsolete snapshots instead of starting stale notes/mutes', async () => {
  const instance = engine();
  const pending = instance.play([channel], [], 'pat', undefined, tracks, 16);
  instance.reconcileNativeInstruments([{ ...channel, mute: true, notes: [] }]);
  await pending;
  await instance.releaseNativeInstruments();
  assert.equal(instance.isPlaybackActive(), false);
  assert.equal(service.sessionCount, 0);
});

test('real privileged parameter service forwards metadata, authorizes owners, bounds writes and excludes processing races', async () => {
  const metadata = await service.describe(instrument, 'parameter-owner');
  assert.equal(metadata.controllerAvailable, true);
  assert.ok(metadata.parameters.some(p => p.name === 'VCF Freq' && p.id === 6));
  assert.equal(service.sessionCount, 0);
  const opened = await service.open(instrument, rate, 'realtime', 'parameter-owner');
  try {
    await assert.rejects(service.parameters(opened.id, [{ id: 6, value: .1 }], 'other-owner'), /another renderer/);
    await assert.rejects(service.parameters(opened.id, [{ id: 6, value: NaN }], 'parameter-owner'), /Invalid/);
    const processing = service.process(opened.id, 1024, [], 120, 'parameter-owner');
    await assert.rejects(service.parameters(opened.id, [{ id: 6, value: .1 }], 'parameter-owner'), /Concurrent/);
    await processing;
    const editing = service.parameters(opened.id, [{ id: 6, value: .1 }], 'parameter-owner');
    await assert.rejects(service.process(opened.id, 1024, [], 120, 'parameter-owner'), /Concurrent/);
    assert.ok(Math.abs((await editing).find(p => p.id === 6).currentValue - .1) < 1e-7);
  } finally { await service.closeOwner('parameter-owner'); }
  assert.equal(service.sessionCount, 0);
});

test('parameter edit changes a held real live voice, saved production export, and exact undo/redo/reopen sound', async () => {
  const metadata = await bridge.describe(instrument), frequency = metadata.parameters.find(p => p.name === 'VCF Freq');
  assert.equal(frequency.id, 6);
  const original = { ...channel, notes: [{ id: 'held-param', pitch: 60, start: 0, duration: 16, velocity: .8 }] };
  async function live(value, configured = original) {
    const instance = engine(); let edited = configured;
    try {
      await instance.play([configured], [], 'pat', undefined, tracks, 16);
      await advanceLive(instance, .25);
      if (value !== undefined) {
        const count = service.sessionCount;
        await instance.editVst3Parameters(configured, [{ id: frequency.id, value }], () => true, vst3 => {
          edited = { ...configured, vst3 };
          instance.reconcileNativeInstruments([edited]);
        });
        assert.equal(service.sessionCount, count, 'editing must retain the running native instance/held note');
      }
      await advanceLive(instance, .75);
      return { pcm: instance.getContext().exportAsAudioData().channelData[0].slice(), edited };
    } finally { instance.stop(); await instance.releaseNativeInstruments(); }
  }
  const baseline = await live(), unchanged = await live(frequency.currentValue), changed = await live(.05);
  const controlDifference = difference(baseline.pcm, unchanged.pcm);
  assert.ok(controlDifference < 1e-6, `unchanged parameter should not change PCM: ${controlDifference}`);
  const liveDifference = difference(baseline.pcm.subarray(24000, 44000), changed.pcm.subarray(24000, 44000));
  assert.ok(liveDifference > .001, `real held-note edit difference RMS ${liveDifference}`);
  assert.ok(rms(changed.pcm, 24000, 44000) > .00001);
  const initial = { ...createDefaultProjectState(), channels: [original], mixerTracks: tracks, playlistClips: [clip] };
  const history = createHistory(initial).commit(updateChannelInProjectState(initial, original.id, { vst3: changed.edited.vst3 }), 'Edit VST3 parameters');
  assert.equal(history.past.length, 1);
  const dry = await exportSong(original), wet = await exportSong(changed.edited);
  const offlineDifference = difference(dry.getChannelData(0), wet.getChannelData(0));
  assert.ok(offlineDifference > .001);
  const renderState = state => exportSong(state.channels[0]);
  const undo = await renderState(history.undo().present), redo = await renderState(history.undo().redo().present);
  const reopened = await renderState(normalizeProjectState(JSON.parse(serializeProjectState(history.present)).state));
  assert.equal(difference(undo.getChannelData(0), dry.getChannelData(0)), 0);
  assert.equal(difference(redo.getChannelData(0), wet.getChannelData(0)), 0);
  assert.equal(difference(reopened.getChannelData(0), wet.getChannelData(0)), 0);
  const liveUndo = await live(undefined, history.undo().present.channels[0]);
  const liveRedo = await live(undefined, history.undo().redo().present.channels[0]);
  const liveReload = await live(undefined, normalizeProjectState(JSON.parse(serializeProjectState(history.present)).state).channels[0]);
  assert.equal(difference(liveUndo.pcm, baseline.pcm), 0);
  assert.equal(difference(liveRedo.pcm, liveReload.pcm), 0);
  assert.ok(difference(liveRedo.pcm.subarray(24000, 44000), baseline.pcm.subarray(24000, 44000)) > .001);
  // Independently restored native client reference through the same real SDK,
  // compared against production song export, not another test-only oscillator.
  const client = new NativeVst3Client(executable);
  try {
    await client.open(plugin, { state: changed.edited.vst3.state, sampleRate: rate });
    const [ref] = await renderNativeSequence(client, { frames: wet.length, events: [
      { frame: 96000, type: 'on', pitch: 60, noteId: 1, velocity: .8 },
      { frame: 192000 - 1, type: 'off', pitch: 60, noteId: 1 },
    ] });
    assert.ok(difference(ref.subarray(98000, 150000), wet.getChannelData(0).subarray(98000, 150000)) < 1e-6);
  } finally { await client.dispose(); }
  const metrics = { plugin: plugin.name, parameter: frequency.name, id: frequency.id, sampleRate: rate,
    referenceValue: frequency.currentValue, editedValue: .05, liveComparedFrames: [24000, 44000],
    liveReferenceRms: rms(baseline.pcm, 24000, 44000), liveEditedRms: rms(changed.pcm, 24000, 44000),
    liveDifferenceRms: liveDifference, unchangedDifferenceRms: controlDifference,
    offlineComparedFrames: [0, dry.length], offlineDifferenceRms: offlineDifference,
    undoDifferenceRms: 0, redoDifferenceRms: 0, reopenDifferenceRms: 0, liveUndoDifferenceRms: 0, liveRedoReloadDifferenceRms: 0 };
  await writeFile(path.join(evidence, 'apex-parameter-metrics.json'), JSON.stringify(metrics, null, 2));
  console.log('NATIVE_PARAMETER_PCM_PROOF', JSON.stringify(metrics));
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=Real VST3 parameter live and export proof::${JSON.stringify(metrics)}`);
  assert.equal(service.sessionCount, 0);
});

test('failed/stale/cancelled native parameter transactions do not publish, clean up and permit retry', async () => {
  for (const mode of ['invalid', 'stale', 'late-cancel', 'publish-failure', 'stop']) {
    const instance = engine(); let published = false, current = true;
    const parameters = bridge.parameters;
    if (mode === 'late-cancel') bridge.parameters = async (...args) => { const result = await parameters(...args); current = false; return result; };
    try {
      const updating = instance.editVst3Parameters(channel, [{ id: mode === 'invalid' ? 0xffffffff : 6, value: .1 }], () => current, () => {
        if (mode === 'publish-failure') throw new Error('Publication rejected');
        published = true;
      });
      if (mode === 'stale') current = false;
      if (mode === 'stop') await instance.releaseNativeInstruments();
      await assert.rejects(updating);
      assert.equal(published, false); assert.equal(channel.vst3, instrument);
    } finally { bridge.parameters = parameters; instance.stop(); await instance.releaseNativeInstruments(); }
  }
  const instance = engine();
  try { await instance.editVst3Parameters(channel, [{ id: 6, value: .1 }], () => true, () => {}); }
  finally { await instance.releaseNativeInstruments(); }
  assert.equal(service.sessionCount, 0);
});
