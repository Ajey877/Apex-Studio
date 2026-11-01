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
function makeAsymmetricStereo(frames = 1024, leftFreq = 330, rightFreq = 660) {
  const audio = new Float32Array(frames * 2);
  for (let i = 0; i < frames; ++i) {
    audio[i] = Math.sin(i * 2 * Math.PI * leftFreq / sampleRate) * 0.18;
    audio[frames + i] = Math.cos(i * 2 * Math.PI * rightFreq / sampleRate) * 0.14;
  }
  return audio;
}
function makeMixerNoise(frames = 1024) {
  const audio = new Float32Array(frames * 2);
  let state = 0x6d2b79f5;
  for (let i = 0; i < frames; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const sample = ((state >>> 0) / 0x80000000 - 1) * 0.1;
    audio[i] = sample;
    audio[frames + i] = sample;
  }
  return audio;
}
const rms = audio => Math.sqrt(audio.reduce((sum, sample) => sum + sample * sample, 0) / audio.length);
const allFinite = audio => audio.every(Number.isFinite);
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

test('two simultaneous effect instances maintain isolated identity, DSP state, asymmetric stereo integrity, and mid-session parameter updates', async () => {
  const service = new Vst3Service(executable, [root]);
  const owner = 'two-instance-isolation';
  try {
    const delayA = await service.open(delay, sampleRate, 'realtime', owner, 'effect');
    const delayB = await service.open(delay, sampleRate, 'realtime', owner, 'effect');
    const filterA = await service.open(rezFilter, sampleRate, 'realtime', owner, 'effect');
    const filterB = await service.open(rezFilter, sampleRate, 'realtime', owner, 'effect');
    assert.notEqual(delayA.id, delayB.id);
    assert.notEqual(filterA.id, filterB.id);
    assert.equal(service.sessionCount, 4);

    // Distinct asymmetric stereo inputs and distinct parameter configurations
    await service.parameters(delayA.id, [{ id: 4, value: 0 }], owner); // 100% dry bypass
    await service.parameters(delayB.id, [{ id: 4, value: 0.5 }], owner); // wet mix active
    await service.parameters(filterA.id, [{ id: 0, value: 0.85 }, { id: 1, value: 0.2 }, { id: 8, value: 0 }, { id: 9, value: 1 }], owner);
    await service.parameters(filterB.id, [{ id: 0, value: 0.55 }, { id: 1, value: 0.6 }, { id: 8, value: 0 }, { id: 9, value: 1 }], owner);

    const inputA = makeAsymmetricStereo(1024, 330, 770);
    const inputB = makeAsymmetricStereo(1024, 520, 910);

    for (let block = 0; block < 12; block++) {
      const [outDelayA, outDelayB] = await Promise.all([
        service.processAudio(delayA.id, 1024, inputA, 120, owner, []),
        service.processAudio(delayB.id, 1024, inputB, 120, owner, []),
      ]);
      assert.equal(allFinite(outDelayA), true);
      assert.equal(allFinite(outDelayB), true);
      assert.equal(difference(inputA, outDelayA), 0, 'instance A dry mix must remain unaffected by instance B wet mix');
      // Asymmetric left/right channels must remain distinct in planar stereo output
      assert.ok(difference(outDelayA.subarray(0, 1024), outDelayA.subarray(1024)) > 0.05);

      const [outFilterA, outFilterB] = await Promise.all([
        service.processAudio(filterA.id, 1024, outDelayA, 120, owner, []),
        service.processAudio(filterB.id, 1024, outDelayB, 120, owner, []),
      ]);
      assert.equal(allFinite(outFilterA), true);
      assert.equal(allFinite(outFilterB), true);
      assert.ok(rms(outFilterA.subarray(0, 1024)) > 0.01, `filterA left channel must be audible on block ${block}`);
      assert.ok(rms(outFilterA.subarray(1024)) > 0.01, `filterA right channel must be audible on block ${block}`);
      assert.ok(rms(outFilterB) > 0.005, `filterB output must be audible on block ${block}`);
      assert.ok(difference(outFilterA, outFilterB) > 0.01, 'independent instances must produce distinct processed stereo signals');
    }

    // Mid-session parameter update on delayA only must change delayA without mutating delayB
    const refB = await service.processAudio(delayB.id, 1024, inputB, 120, owner, []);
    await service.parameters(delayA.id, [{ id: 4, value: 1 }], owner); // 100% wet (zero immediate dry output on silent delay line)
    const mutatedA = await service.processAudio(delayA.id, 1024, inputA, 120, owner, []);
    const afterB = await service.processAudio(delayB.id, 1024, inputB, 120, owner, []);
    assert.ok(difference(inputA, mutatedA) > 0.05, 'mid-session parameter change takes effect immediately on target instance');
    assert.ok(rms(afterB) > 0.05 && allFinite(afterB), 'untouched sibling instance continues processing normally');
    assert.ok(rms(refB) > 0.05);

    await service.close(delayA.id, owner);
    await service.close(delayB.id, owner);
    await service.close(filterA.id, owner);
    await service.close(filterB.id, owner);
    assert.equal(service.sessionCount, 0);
  } finally { await service.dispose(); }
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

const REZFILTER_OVERLAY = [
  { id: 0, value: 0.8 },
  { id: 1, value: 0.25 },
  { id: 3, value: 0.5 },
  { id: 6, value: 0.5 },
  { id: 8, value: 0 },
  { id: 9, value: 1 },
];

async function measureRestoredRezFilter(service, inspected, delayEffect, {
  owner, reverse, mode, reopen, preRollSilenceBlocks = 2,
}) {
  const dry = makeMixerNoise(1024);
  const silence = new Float32Array(2048);
  const openPair = async () => {
    const firstPlugin = reverse ? inspected : delayEffect;
    const secondPlugin = reverse ? delayEffect : inspected;
    const first = await service.open(firstPlugin, sampleRate, mode, owner, 'effect');
    const second = await service.open(secondPlugin, sampleRate, mode, owner, 'effect');
    return reverse
      ? { delayOpened: second, filterOpened: first }
      : { delayOpened: first, filterOpened: second };
  };
  let pair = await openPair();
  try {
    if (reopen) {
      await service.close(pair.delayOpened.id, owner);
      await service.close(pair.filterOpened.id, owner);
      pair = await openPair();
    }
    const flushed = await service.parameters(pair.filterOpened.id, REZFILTER_OVERLAY, owner);
    const overlayHeld = REZFILTER_OVERLAY.every(parameter => {
      const actual = flushed.find(entry => entry.id === parameter.id);
      return actual && actual.currentValue !== null && Math.abs(actual.currentValue - parameter.value) < 1e-6;
    });
    // Mirror the live two-insert Mixer pipeline: downstream insert receives
    // upstream pipeline-delay silence blocks before the first audible block.
    for (let s = 0; s < preRollSilenceBlocks; s++) {
      const silentOut = await service.processAudio(pair.filterOpened.id, 1024, silence, 120, owner, []);
      assert.equal(allFinite(silentOut), true);
      assert.equal(rms(silentOut), 0, 'silent pre-roll through RezFilter must produce exact finite silence');
    }
    const filterInput = reverse ? dry : await service.processAudio(pair.delayOpened.id, 1024, dry, 120, owner, []);
    const inputs = Array.from({ length: 16 }, () => new Float32Array(filterInput));
    const outputs = [];
    for (const block of inputs) outputs.push(await service.processAudio(pair.filterOpened.id, 1024, block, 120, owner, []));
    const blocks = outputs.map((output, index) => ({
      index,
      inputRms: rms(inputs[index]),
      outputRms: rms(output),
      finite: allFinite(output),
    }));
    return {
      owner, reverse, mode, reopen, overlayHeld,
      delaySession: pair.delayOpened.id, filterSession: pair.filterOpened.id,
      delayRms: reverse ? null : rms(filterInput),
      blocks,
      silentBlocks: blocks.filter(block => !block.finite || (block.inputRms > 0.01 && block.outputRms <= 0.01)).map(block => block.index),
    };
  } finally {
    await service.close(pair.delayOpened.id, owner).catch(() => {});
    await service.close(pair.filterOpened.id, owner).catch(() => {});
  }
}

test('realtime restored RezFilter stays audible across 20 varied open/reopen cycles including silent pre-roll and empty live parameter lists', async () => {
  const service = new Vst3Service(executable, [root]);
  const owner = 'rezfilter-restore-cycles';
  try {
    const inspected = await service.inspectEffect(rezFilter, { schema: 1, classId: rezFilter.classId, parameters: REZFILTER_OVERLAY }, owner);
    const delayInspected = await service.inspectEffect(delay, undefined, owner);
    const outcomes = [];
    for (let cycle = 0; cycle < 20; cycle++) {
      const outcome = await measureRestoredRezFilter(service, inspected, delayInspected, {
        owner: `${owner}-${cycle}`,
        reverse: cycle % 2 === 1,
        mode: cycle % 5 === 0 ? 'offline' : 'realtime',
        reopen: cycle % 4 === 3,
      });
      outcomes.push({
        cycle,
        reverse: outcome.reverse,
        mode: outcome.mode,
        reopen: outcome.reopen,
        overlayHeld: outcome.overlayHeld,
        delayRms: outcome.delayRms,
        firstOutputRms: outcome.blocks[0]?.outputRms ?? null,
        minOutputRms: Math.min(...outcome.blocks.map(block => block.outputRms)),
        silentBlocks: outcome.silentBlocks,
        filterSession: outcome.filterSession,
      });
      assert.equal(outcome.overlayHeld, true, `controller overlay lost on cycle ${cycle}: ${JSON.stringify(outcome)}`);
      assert.deepEqual(outcome.silentBlocks, [], `RezFilter DSP went silent on cycle ${cycle}: ${JSON.stringify(outcomes)}`);
    }
    assert.equal(outcomes.length, 20);
    assert.equal(outcomes.filter(outcome => outcome.reverse).length, 10);
    assert.ok(outcomes.some(outcome => outcome.reopen));
    assert.ok(outcomes.some(outcome => outcome.mode === 'offline'));
    assert.ok(outcomes.filter(outcome => outcome.mode === 'realtime').length >= 16);
  } finally { await service.dispose(); }
});

test('realtime restore plus saved overlay flush reaches RezFilter DSP on Delay then filter with empty live parameter list', async () => {
  const service = new Vst3Service(executable, [root]);
  const owner = 'rezfilter-realtime-init';
  try {
    const inspected = await service.inspectEffect(rezFilter, { schema: 1, classId: rezFilter.classId, parameters: REZFILTER_OVERLAY }, owner);
    const delayInspected = await service.inspectEffect(delay, undefined, owner);
    const delayOpened = await service.open(delayInspected, sampleRate, 'realtime', owner, 'effect');
    const defaultOpened = await service.open(rezFilter, sampleRate, 'realtime', owner, 'effect');
    const filterOpened = await service.open(inspected, sampleRate, 'realtime', owner, 'effect');
    try {
      // Open alone with saved state.parameters must already apply normalized parameters to DSP
      for (const parameter of REZFILTER_OVERLAY) {
        const actual = filterOpened.parameters.find(entry => entry.id === parameter.id);
        assert.ok(actual && actual.currentValue !== null && Math.abs(actual.currentValue - parameter.value) < 1e-6,
          `opened session must reflect saved overlay ${parameter.id}=${parameter.value}`);
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

test('cancellation, close-during-process, owner teardown and helper process lifetime leave no orphaned sessions or undefined state', async () => {
  const service = new Vst3Service(executable, [root]);
  try {
    const openedA = await service.open(delay, sampleRate, 'realtime', 'owner-a', 'effect');
    const openedB = await service.open(rezFilter, sampleRate, 'realtime', 'owner-b', 'effect');
    assert.equal(service.sessionCount, 2);

    // Cancel owner-a while a processAudio call is in flight; owner-b must remain healthy.
    const inFlight = service.processAudio(openedA.id, 4096, makeAudio(4096), 120, 'owner-a', [])
      .then(() => 'completed', error => String(error?.message ?? error));
    await service.close(openedA.id, 'owner-a');
    const inFlightOutcome = await inFlight;
    assert.match(inFlightOutcome, /cancelled|closed|not open|completed/i);
    assert.equal(service.sessionCount, 1);
    await assert.rejects(service.processAudio(openedA.id, 1024, makeAudio(1024), 120, 'owner-a', []), /closed or belongs to another renderer/);

    // Sibling instance owned by owner-b must still process cleanly after owner-a abort
    const healthyB = await service.processAudio(openedB.id, 1024, makeAudio(1024), 120, 'owner-b', []);
    assert.ok(rms(healthyB) > 0.01 && allFinite(healthyB));

    // closeOwner tears down remaining sessions for owner-b cleanly
    await service.closeOwner('owner-b');
    assert.equal(service.sessionCount, 0);

    // Direct NativeVst3Client helper process exits cleanly on dispose() and rejects subsequent requests
    const client = new NativeVst3Client(executable);
    try {
      await client.open(rezFilter, { kind: 'effect', sampleRate });
    } finally {
      await client.dispose();
    }
    await assert.rejects(client.snapshot(), /exited|cancelled|closed/i);

    const abortedClient = new NativeVst3Client(executable);
    try {
      await abortedClient.open(delay, { kind: 'effect', sampleRate });
      abortedClient.abort();
      await assert.rejects(abortedClient.snapshot(), /VST3 instance cancelled/);
    } finally {
      await abortedClient.dispose();
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
