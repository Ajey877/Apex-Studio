// Real native VST3 audio-effect host coverage. No plugin binaries are committed;
// build the pinned SDK's redistributable MDA fixture with npm run native:vst3:build.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { NativeVst3Client, discoverVst3 } from '../native/vst3/client.mjs';
import { Vst3Service } from '../native/vst3/service.mjs';

const build = path.resolve(process.env.APEX_NATIVE_BUILD ?? 'build/native-vst3');
const executableName = process.platform === 'win32' ? 'apex-vst3-host.exe' : 'apex-vst3-host';
const executable = [path.join(build, 'bin', executableName), path.join(build, 'bin/Release', executableName)].find(existsSync);
assert.ok(executable, 'Build the native host and MDA fixture first; see native/vst3/README.md');
const root = path.join(build, 'VST3/Release');
const bundle = path.join(root, 'mda-vst3.vst3');
assert.ok(existsSync(bundle), 'Real MDA VST3 fixture is required');
const sampleRate = 48000;
const { plugins: effects, errors } = await discoverVst3(executable, [bundle], { kind: 'effect' });
assert.deepEqual(errors, []);
const delay = effects.find(plugin => plugin.name === 'mda Delay');
const rezFilter = effects.find(plugin => plugin.name === 'mda RezFilter');
const multiBusEffect = effects.find(plugin => plugin.name === 'mda TalkBox');
assert.ok(delay && rezFilter && multiBusEffect, 'Pinned effect fixtures must be factory-discovered');
const { plugins: instruments } = await discoverVst3(executable, [bundle]);
const instrument = instruments.find(plugin => plugin.name === 'mda JX10');
assert.ok(instrument);

function makeAudio(frames = 4096) {
  const audio = new Float32Array(frames * 2);
  for (let i = 0; i < frames; ++i) {
    const sample = Math.sin(i * 2 * Math.PI * 440 / sampleRate) * 0.2;
    audio[i] = sample;
    audio[frames + i] = sample;
  }
  return audio;
}
const rms = audio => Math.sqrt(audio.reduce((sum, sample) => sum + sample * sample, 0) / audio.length);
const difference = (a, b) => {
  assert.equal(a.length, b.length);
  return Math.sqrt(a.reduce((sum, sample, i) => sum + (sample - b[i]) ** 2, 0) / a.length);
};
async function withEffect(plugin, options, run) {
  const client = new NativeVst3Client(executable);
  try {
    const { plugin: opened } = await client.open(plugin, { kind: 'effect', sampleRate, ...options });
    return await run(client, opened);
  } finally { await client.dispose(); }
}

// A block is sent as real planar float32 PCM, not MIDI or a generated test tone
// returned by the host. The response must retain exact frame/channel shape.
test('effect discovery is category-specific and real MDA stereo processing changes/bypasses actual audio', async () => {
  assert.ok(effects.length >= 20);
  assert.equal(new Set(effects.map(plugin => plugin.classId)).size, effects.length);
  for (const effect of effects) {
    assert.ok(effect.categories.includes('Fx'), `${effect.name} is categorized as an effect`);
    assert.ok(!effect.categories.includes('Instrument'));
    assert.ok(!effect.categories.includes('Generator'));
    assert.ok(!effect.categories.includes('Analyzer'));
  }
  assert.equal(instruments.some(plugin => plugin.classId === delay.classId), false);
  assert.equal(delay.classId, '5653546D6461796D64612064656C6179');

  const input = makeAudio();
  const dry = await withEffect(delay, {}, async client => (await client.processAudio(4096, input)).samples);
  const bypassed = await withEffect(delay, {}, async client =>
    (await client.processAudio(4096, input, [{ id: 4, value: 0 }])).samples);
  const wet = await withEffect(delay, {}, async client =>
    (await client.processAudio(4096, input, [{ id: 4, value: 1 }])).samples);
  assert.equal(dry.length, 8192);
  assert.ok(rms(dry) > 0.05, 'actual plugin output contains audio');
  assert.equal(difference(input, bypassed), 0, 'zero wet mix is an audio bypass control');
  assert.ok(difference(dry, wet) > 0.05, 'a genuine VST3 parameter changes processed samples');
  assert.equal(rms(wet), 0, 'the selected native wet-mix setting is measurably different');
});

test('effect parameters, opaque plugin state and reopen retain identical actual DSP output', async () => {
  const input = makeAudio();
  const client = new NativeVst3Client(executable);
  let savedState;
  try {
    const { plugin } = await client.open(delay, { kind: 'effect', sampleRate });
    const wetMix = plugin.parameters.find(parameter => parameter.id === 4);
    assert.equal(wetMix.name, 'Fb Mix');
    const updated = await client.parameters([{ id: wetMix.id, value: 0 }]);
    assert.equal(updated.find(parameter => parameter.id === wetMix.id).currentValue, 0);
    savedState = await client.snapshot();
    assert.equal(savedState.classId, delay.classId);
    assert.ok(savedState.component || savedState.controller || savedState.parameters.length);
  } finally { await client.dispose(); }

  const before = await withEffect(delay, {}, async fresh => {
    await fresh.parameters([{ id: 4, value: 0 }]);
    return (await fresh.processAudio(4096, input)).samples;
  });
  const after = await withEffect(delay, { state: savedState }, async reopened =>
    (await reopened.processAudio(4096, input)).samples);
  assert.equal(difference(before, after), 0);
});

test('effect order is audible: delay then resonant filter differs from filter then delay', async () => {
  const input = makeAudio();
  const run = async reverse => {
    const first = new NativeVst3Client(executable);
    const second = new NativeVst3Client(executable);
    try {
      await first.open(reverse ? rezFilter : delay, { kind: 'effect', sampleRate });
      await second.open(reverse ? delay : rezFilter, { kind: 'effect', sampleRate });
      const intermediate = (await first.processAudio(4096, input)).samples;
      return (await second.processAudio(4096, intermediate)).samples;
    } finally { await Promise.all([first.dispose(), second.dispose()]); }
  };
  const delayThenAmbience = await run(false);
  const ambienceThenDelay = await run(true);
  assert.ok(rms(delayThenAmbience) > 0);
  assert.ok(rms(ambienceThenDelay) > 0);
  assert.ok(difference(delayThenAmbience, ambienceThenDelay) > 1e-4);
});

test('realtime restore plus saved overlay flush reaches RezFilter DSP on Delay then filter with empty live parameter list', async () => {
  const overlay = [
    { id: 0, value: 0.8 },
    { id: 1, value: 0.25 },
    { id: 3, value: 0.5 },
    { id: 6, value: 0.5 },
    { id: 8, value: 0 },
    { id: 9, value: 1 },
  ];
  const service = new Vst3Service(executable, [root]);
  const owner = 'rezfilter-realtime-init';
  try {
    const inspected = await service.inspectEffect(rezFilter, { schema: 1, classId: rezFilter.classId, parameters: overlay }, owner);
    const delayInspected = await service.inspectEffect(delay, undefined, owner);
    const delayOpened = await service.open(delayInspected, sampleRate, 'realtime', owner, 'effect');
    const defaultOpened = await service.open(rezFilter, sampleRate, 'realtime', owner, 'effect');
    const filterOpened = await service.open(inspected, sampleRate, 'realtime', owner, 'effect');
    try {
      const flushed = await service.parameters(filterOpened.id, overlay, owner);
      for (const parameter of overlay) {
        const actual = flushed.find(entry => entry.id === parameter.id);
        assert.ok(actual && actual.currentValue !== null && Math.abs(actual.currentValue - parameter.value) < 1e-6,
          `production overlay flush must hold ${parameter.id}=${parameter.value}`);
      }
      const delayed = await service.processAudio(delayOpened.id, 1024, makeAudio(1024), 120, owner, []);
      assert.ok(rms(delayed) > 0.01, `Delay realtime restore was silent: ${rms(delayed)}`);
      const defaults = await service.processAudio(defaultOpened.id, 1024, delayed, 120, owner, []);
      const filtered = await service.processAudio(filterOpened.id, 1024, delayed, 120, owner, []);
      assert.ok(rms(filtered) > 0.01,
        `Delay→RezFilter realtime overlay was silent with empty live parameter list: delay=${rms(delayed)} filter=${rms(filtered)}`);
      assert.ok(difference(defaults, filtered) > 1e-4,
        `normalized overlay must change RezFilter DSP, not only controller metadata: default=${rms(defaults)} overlay=${rms(filtered)}`);
    } finally {
      await service.close(delayOpened.id, owner);
      await service.close(defaultOpened.id, owner);
      await service.close(filterOpened.id, owner);
    }
  } finally { await service.dispose(); }
});

test('inspect/restore of the packaged RezFilter overlay is audible on Delay then filter with no live parameter list', async () => {
  // Keep this overlay identical to PACKAGED_REZFILTER_FIXTURE_PARAMETERS in
  // src/audio/nativeVst3DesktopSmoke.ts. inspectEffect primes with 1 silent
  // sample, which cannot prove audibility; reopen and process a live-sized
  // block with the empty per-block parameter list the Mixer live port sends.
  const overlay = [
    { id: 0, value: 0.8 },
    { id: 1, value: 0.25 },
    { id: 3, value: 0.5 },
    { id: 6, value: 0.5 },
    { id: 8, value: 0 },
    { id: 9, value: 1 },
  ];
  const service = new Vst3Service(executable, [root]);
  const owner = 'rezfilter-init';
  try {
    const inspected = await service.inspectEffect(rezFilter, { schema: 1, classId: rezFilter.classId, parameters: overlay }, owner);
    for (const parameter of overlay) {
      assert.ok(inspected.state.parameters.some(entry => entry.id === parameter.id && Math.abs(entry.value - parameter.value) < 1e-6),
        `inspectEffect must persist overlay parameter ${parameter.id}`);
    }
    const delayInspected = await service.inspectEffect(delay, undefined, owner);
    const delayOpened = await service.open(delayInspected, sampleRate, 'offline', owner, 'effect');
    const filterOpened = await service.open(inspected, sampleRate, 'offline', owner, 'effect');
    try {
      for (const parameter of overlay) {
        const actual = filterOpened.parameters.find(entry => entry.id === parameter.id);
        assert.ok(actual && actual.currentValue !== null && Math.abs(actual.currentValue - parameter.value) < 1e-6,
          `restored RezFilter controller must hold overlay ${parameter.id}=${parameter.value}, got ${JSON.stringify(actual)}`);
      }
      const delayed = await service.processAudio(delayOpened.id, 1024, makeAudio(1024), 120, owner, []);
      assert.ok(rms(delayed) > 0.01, `Delay inspect/restore was silent: ${rms(delayed)}`);
      const filtered = await service.processAudio(filterOpened.id, 1024, delayed, 120, owner, []);
      assert.ok(rms(filtered) > 0.01,
        `Delay→RezFilter inspect/restore was silent with empty live parameter list: delay=${rms(delayed)} filter=${rms(filtered)}`);
      for (let block = 0; block < 8; block++) {
        const next = await service.processAudio(filterOpened.id, 1024, makeAudio(1024), 120, owner, []);
        assert.ok(rms(next) > 0.01, `RezFilter went silent on restored live block ${block}: ${rms(next)}`);
      }
    } finally {
      await service.close(delayOpened.id, owner);
      await service.close(filterOpened.id, owner);
    }
  } finally { await service.dispose(); }
});

test('service exposes genuine effect parameter metadata and captures persisted native controller/component state', async () => {
  const service = new Vst3Service(executable, [root]);
  const initial = { schema: 1, classId: delay.classId, parameters: [] };
  try {
    const described = await service.describeEffect(delay, 'describe-effect');
    assert.equal(described.controllerAvailable, true);
    assert.ok(described.parameters.length > 0);
    assert.ok(described.parameters.some(parameter => parameter.id === 4));
    const saved = await service.inspectEffect(delay, { ...initial, parameters: [{ id: 4, value: 0.25 }] }, 'inspect-effect');
    assert.equal(saved.classId, delay.classId);
    assert.equal(saved.state.classId, delay.classId);
    assert.ok(typeof saved.state.component === 'string' && saved.state.component.length > 0);
    assert.ok(saved.state.controller === undefined || (typeof saved.state.controller === 'string' && saved.state.controller.length > 0));
    assert.ok(saved.state.parameters.some(parameter => parameter.id === 4 && Math.abs(parameter.value - 0.25) < 1e-7));
  } finally { await service.dispose(); }
});

test('service enforces effect identity, owner, stereo bounds and explicit failure without losing retry', async () => {
  const service = new Vst3Service(executable, [root]);
  try {
    await assert.rejects(service.open(instrument, sampleRate, 'offline', 'effect-test', 'effect'), /not a VST3 audio effect/);
    assert.equal(service.sessionCount, 0);
    const opened = await service.open(delay, sampleRate, 'offline', 'effect-test', 'effect');
    await assert.rejects(service.processAudio(opened.id, 4096, makeAudio(), 120, 'other-owner'), /belongs to another renderer/);
    await assert.rejects(service.processAudio(opened.id, 4096, new Float32Array(10), 120, 'effect-test'), /stereo float32 block/);
    assert.equal(service.sessionCount, 1, 'validation failures do not mutate/close a valid effect session');
    const dry = makeAudio();
    const dryMetadata = await service.parameters(opened.id, [{ id: 4, value: 0 }], 'effect-test');
    assert.equal(dryMetadata.find(parameter => parameter.id === 4).currentValue, 0);
    const bypassed = await service.processAudio(opened.id, 4096, dry, 120, 'effect-test');
    assert.equal(difference(dry, bypassed), 0, 'separate parameter transaction reaches the next real audio block');
    await service.parameters(opened.id, [{ id: 4, value: 1 }], 'effect-test');
    const wet = await service.processAudio(opened.id, 4096, dry, 120, 'effect-test');
    assert.equal(wet.length, 8192);
    assert.equal(rms(wet), 0);
    await service.close(opened.id, 'effect-test');
    assert.equal(service.sessionCount, 0);
  } finally { await service.dispose(); }
});

test('unsupported class, bus layout, missing module and malformed native audio fail explicitly', async () => {
  const unsupportedLayout = new NativeVst3Client(executable);
  try {
    await assert.rejects(unsupportedLayout.open(multiBusEffect, { kind: 'effect', sampleRate }), /one-input\/one-output|stereo main/);
  } finally { await unsupportedLayout.dispose(); }
  const client = new NativeVst3Client(executable);
  try {
    await assert.rejects(client.open(instrument, { kind: 'effect', sampleRate }), /not a VST3 audio effect/);
  } finally { await client.dispose(); }
  const invalid = new NativeVst3Client(executable);
  try {
    await invalid.open(delay, { kind: 'effect', sampleRate });
    assert.throws(() => invalid.processAudio(4096, new Float32Array(4)), /planar stereo/);
    await assert.rejects(invalid.request({ command: 'process', frames: 1, events: [], audio: 'bad' }), /audio block/);
  } finally { await invalid.dispose(); }
  const missing = new NativeVst3Client(executable);
  try {
    await assert.rejects(missing.open({ ...delay, path: `${bundle}.missing` }, { kind: 'effect', sampleRate }), /module load failed/);
  } finally { await missing.dispose(); }
});
