// Real native VST3 audio-effect host coverage. No plugin binaries are committed;
// build the pinned SDK's redistributable MDA fixture with npm run native:vst3:build.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

test('smoke-only native failure capture binds zero-output evidence to the exact helper instance and request', async () => {
  const service = new Vst3Service(executable, [root]);
  const owner = 'native-failure-evidence-test';
  const profile = sequence => ({ requestId: `diagnostic-runtime:${sequence}`, trackId: 1, slotId: 'diagnostic-delay', sequence,
    inputBlockStartContextFrame: sequence * 1024, submittedContextFrame: sequence * 1024 + 1024,
    submittedOutputFrame: sequence * 1024 + 1024, dueOutputFrame: 2048 + sequence * 1024,
    dueContextFrame: 2048 + sequence * 1024, sampleRate });
  const silentDelay = { ...delay, state: { schema: 1, classId: delay.classId, parameters: [{ id: 4, value: 1 }] } };
  const opened = await service.open(silentDelay, sampleRate, 'realtime', owner, 'effect', true);
  try {
    assert.equal(opened.smokeOpenEvidence.helperSessionId, opened.id);
    assert.equal(opened.smokeOpenEvidence.helperProcessId > 0, true);
    assert.equal(opened.smokeOpenEvidence.pluginClassId, delay.classId);
    assert.equal(opened.smokeOpenEvidence.stateSnapshot.captured, false);
    assert.ok(opened.smokeOpenEvidence.stateApplication.lifecycleOrder.includes('processor.setProcessing(true)'));
    const input = makeAudio(1024);
    const output = await service.processAudio(opened.id, 1024, input, 120, owner, [], profile(0));
    assert.equal(rms(output), 0, 'the genuine MDA Delay instance returns the selected silent output');
    const firstProcessEvidence = service.takeSmokeProcessEvidence(opened.id, owner);
    assert.ok(firstProcessEvidence);
    assert.equal(firstProcessEvidence.helperSessionId, opened.id);
    assert.equal(firstProcessEvidence.requestProfile.requestId, 'diagnostic-runtime:0');
    assert.equal(firstProcessEvidence.processorCallResult, 'kResultOk');
    assert.ok(firstProcessEvidence.stateApplication.firstProcess.queuedSavedOverrides.some(parameter => parameter.id === 4));
    assert.equal(firstProcessEvidence.stateSnapshot.captured, false);
    const evidence = service.takeSmokeFailureEvidence(opened.id, owner);
    assert.ok(evidence);
    assert.equal(evidence.helperSessionId, opened.id);
    assert.equal(evidence.pluginClassId, delay.classId);
    assert.equal(evidence.slotId, 'diagnostic-delay');
    assert.equal(evidence.requestId, 'diagnostic-runtime:0');
    assert.equal(evidence.sequence, 0);
    assert.ok(evidence.input.leftRms > 0 && evidence.input.rightRms > 0 && evidence.input.monoSumRms > 0);
    assert.equal(evidence.output.combinedRms, 0);
    assert.equal(evidence.channels.output, 2);
    assert.ok(evidence.parameters.controllerReadbacksAfterProcess.some(parameter => parameter.id === 4 && parameter.currentValue === 1));
    assert.ok(evidence.parameters.savedPendingOverridesBeforeBlock.values.some(parameter => parameter.id === 4 && parameter.value === 1));
    assert.ok(evidence.stateApplication.normalizedOverridesApplied.some(parameter => parameter.id === 4 && parameter.queuedForFirstProcess));
    assert.ok(evidence.stateApplication.lifecycleOrder.indexOf('component.setActive(true)') < evidence.stateApplication.lifecycleOrder.indexOf('processor.setProcessing(true)'));
    assert.equal(evidence.stateSnapshot.captured, false, 'failure capture does not suspend processing for a component snapshot');
    assert.equal(Object.hasOwn(evidence, 'pcm'), false, 'evidence contains no unbounded PCM data');
    assert.equal(Object.hasOwn(evidence, 'audio'), false, 'evidence contains no raw audio payload');
    assert.ok(JSON.stringify(evidence).length < 12_000, 'evidence remains bounded');
    await service.processAudio(opened.id, 1024, input, 120, owner, [], profile(1));
    assert.equal(service.takeSmokeFailureEvidence(opened.id, owner), null, 'only the first silent block is recorded per native instance');
  } finally { await service.close(opened.id, owner); }
});

test('RezFilter restores component and controller state in order, while normalized overrides reach native DSP', async () => {
  const service = new Vst3Service(executable, [root]);
  const requested = [
    { id: 0, value: 0.8 }, { id: 1, value: 0.25 }, { id: 3, value: 0.5 },
    { id: 6, value: 0.5 }, { id: 8, value: 0 }, { id: 9, value: 1 },
  ];
  const competing = requested.map(change => ({ ...change }));
  competing.find(change => change.id === 0).value = 0.45;
  competing.find(change => change.id === 1).value = 0.85;
  const initial = { schema: 1, classId: rezFilter.classId, parameters: [] };
  const makeState = (componentState, parameters = []) => ({
    schema: 1, classId: rezFilter.classId,
    ...(componentState ? { component: componentState } : {}),
    parameters,
  });
  const makeNoiseBlock = (startFrame, seedState) => {
    const input = new Float32Array(2048);
    let state = seedState.value;
    for (let i = 0; i < 1024; ++i) {
      if (startFrame + i < 256) continue;
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      const sample = ((state >>> 0) / 0x80000000 - 1) * 0.08;
      input[i] = sample;
      input[1024 + i] = sample;
    }
    seedState.value = state;
    return input;
  };
  const originalPathMode = process.env.APEX_REZFILTER_ORIGINAL_PATH === '1';
  const originalEvidencePath = process.env.APEX_REZFILTER_ORIGINAL_EVIDENCE;
  const originalCases = [];
  let originalContext = null;
  const stereoMetrics = audio => {
    const frames = audio.length / 2;
    const left = audio.subarray(0, frames);
    const right = audio.subarray(frames);
    let sumSquares = 0;
    let differenceSquares = 0;
    for (let frame = 0; frame < frames; ++frame) {
      const sum = audio[frame] + audio[frames + frame];
      const difference = audio[frame] - audio[frames + frame];
      sumSquares += sum * sum;
      differenceSquares += difference * difference;
    }
    return {
      leftRms: rms(left), rightRms: rms(right), monoSumRms: Math.sqrt(sumSquares / frames),
      monoDifferenceRms: Math.sqrt(differenceSquares / frames), combinedRms: rms(audio),
    };
  };
  const runOriginalPath = async (caseName, state) => {
    const client = new NativeVst3Client(executable);
    try {
      // Deliberately match the historical helper calls: no evidence flags,
      // failure profile, parameter request, callback, or per-block native read.
      const { plugin: opened } = await client.open(rezFilter, { kind: 'effect', sampleRate, state });
      const observed = new Map(opened.parameters.map(parameter => [parameter.id, parameter.currentValue]));
      const inputBlocks = [];
      const blocks = [];
      const seedState = { value: 0x2c1b3c6d };
      for (let start = 0; start < 50 * 1024; start += 1024) {
        const input = makeNoiseBlock(start, seedState);
        inputBlocks.push(input);
        blocks.push((await client.processAudio(1024, input)).samples);
      }
      // Keep the historical snapshot exactly after block 50; all RMS work is
      // pure JavaScript and deferred until after that native operation.
      const snapshot = await client.snapshot();
      return { caseName, observed, openedParameters: opened.parameters, inputBlocks, blocks, snapshot };
    } finally { await client.dispose(); }
  };
  const inspectComponent = async component => {
    const auditClient = new NativeVst3Client(executable);
    try {
      return (await auditClient.open(rezFilter, {
        kind: 'effect', sampleRate, state: makeState(component, undefined),
      })).plugin;
    } finally { await auditClient.dispose(); }
  };
  const recordOriginalCase = (result, auditPlugin, state) => {
    const blockEvidence = result.blocks.map((output, blockIndex) => ({
      blockIndex, frameIndex: blockIndex * 1024, frames: 1024,
      input: stereoMetrics(result.inputBlocks[blockIndex]), output: stereoMetrics(output),
    }));
    const flattened = Float32Array.from(result.blocks.flatMap(block => [...block]));
    const firstExactZeroOutputBlock = blockEvidence.find(block => block.output.combinedRms === 0)?.blockIndex ?? null;
    const firstAtOrBelowExistingBlockThreshold = blockEvidence.find(block => block.output.combinedRms <= 1e-5)?.blockIndex ?? null;
    const onsetPosition = result.blocks[0]?.findIndex((sample, index) => index < 1024 && Math.abs(sample) >= 1e-6) ?? -1;
    const parameterIds = new Set(requested.map(({ id }) => id));
    const selectParameters = parameters => parameters
      .filter(parameter => parameterIds.has(parameter.id))
      .map(({ id, name, defaultValue, currentValue }) => ({ id, name, defaultValue, currentValue }));
    const record = {
      caseName: result.caseName, helperPath: 'historical NativeVst3Client open/process/snapshot path; capture flags omitted',
      componentStateProvided: Boolean(state.component), normalizedOverrides: state.parameters,
      pluginClassId: rezFilter.classId, blockCount: blockEvidence.length,
      aggregateOutputRms: rms(flattened), firstExactZeroOutputBlock,
      firstOutputBlockAtOrBelowExistingThreshold: firstAtOrBelowExistingBlockThreshold,
      onsetPositionInFirstBlockLeftChannel: onsetPosition, blockEvidence,
      parameterMetadata: {
        requested, competing, defaults: originalContext.defaults,
        measuredInstanceAtOpen: selectParameters(result.openedParameters),
        postSnapshotReopenedAuditInstance: selectParameters(auditPlugin.parameters),
      },
      postProcessingSnapshot: {
        componentStateCaptured: typeof result.snapshot.component === 'string',
        componentStateBytes: typeof result.snapshot.component === 'string' ? result.snapshot.component.length / 2 : 0,
        controllerStateCaptured: typeof result.snapshot.controller === 'string',
        normalizedParameters: result.snapshot.parameters,
      },
    };
    originalCases.push(record);
    if (originalEvidencePath) {
      mkdirSync(path.dirname(originalEvidencePath), { recursive: true });
      writeFileSync(originalEvidencePath, `${JSON.stringify({
        schema: 1,
        test: 'historical uninstrumented RezFilter path after preceding vst3Effects tests',
        pluginClassId: rezFilter.classId,
        operationPath: 'NativeVst3Client.open without capture flags; 50 processAudio calls without failure profiles; post-process snapshot; separate audit reopen as historically done',
        originalContext, cases: originalCases,
      })}\n`);
    }
    return record;
  };
  const diagnosticCases = [];
  const evidencePath = process.env.APEX_REZFILTER_STATE_EVIDENCE;
  const saveDiagnostic = () => {
    if (!evidencePath) return;
    mkdirSync(path.dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify({
      schema: 1,
      test: 'RezFilter restores component and controller state in order, while normalized overrides reach native DSP',
      pluginClassId: rezFilter.classId,
      capture: 'passive same-instance per-block native controller readbacks and stereo input/output RMS; no snapshot/suspension during measured blocks',
      cases: diagnosticCases,
    })}\n`);
  };
  const run = async (caseName, state) => {
    const client = new NativeVst3Client(executable);
    const helperSessionId = randomUUID();
    const runtimeId = `rezfilter-state-${randomUUID()}`;
    const slotId = `rezfilter-${caseName}`;
    try {
      const { plugin: opened } = await client.open(rezFilter, {
        kind: 'effect', sampleRate, state, captureFailureEvidence: true, captureBlockAudit: true,
        diagnosticParameterIds: requested.map(({ id }) => id),
      });
      const observed = new Map(opened.parameters.map(parameter => [parameter.id, parameter.currentValue]));
      const blocks = [];
      const blockEvidence = [];
      let firstProcessEvidence = null;
      let failureEvidence = null;
      const seedState = { value: 0x2c1b3c6d };
      for (let start = 0; start < 50 * 1024; start += 1024) {
        const sequence = start / 1024;
        const requestProfile = {
          requestId: `${runtimeId}:${sequence}`, trackId: 1, slotId, sequence,
          inputBlockStartContextFrame: start, submittedContextFrame: start + 1024,
          submittedOutputFrame: start + 1024, dueOutputFrame: start + 1024, dueContextFrame: start + 1024,
          sampleRate, serviceSessionId: helperSessionId, helperPid: client.pid, runtimeId,
        };
        const result = await client.processAudio(1024, makeNoiseBlock(start, seedState), [], 120, requestProfile);
        blocks.push(result.samples);
        if (result.blockEvidence) blockEvidence.push(result.blockEvidence);
        if (result.firstProcessEvidence) firstProcessEvidence = result.firstProcessEvidence;
        if (result.failureEvidence) failureEvidence = result.failureEvidence;
      }
      return {
        caseName, helperSessionId, helperProcessId: client.pid, runtimeId, pluginClassId: rezFilter.classId,
        observed, blocks, blockEvidence, firstProcessEvidence, failureEvidence, openEvidence: opened.smokeOpenEvidence,
      };
    } finally { await client.dispose(); }
  };
  const recordCase = async (caseName, state) => {
    const result = await run(caseName, state);
    const flattened = Float32Array.from(result.blocks.flatMap(block => [...block]));
    const zeroBlock = result.blockEvidence.find(block => block.output?.combinedRms === 0);
    const belowPerBlockThreshold = result.blockEvidence.find(block => block.output?.combinedRms <= 1e-5);
    diagnosticCases.push({
      caseName, helperSessionId: result.helperSessionId, helperProcessId: result.helperProcessId,
      runtimeId: result.runtimeId, pluginClassId: result.pluginClassId, openEvidence: result.openEvidence,
      firstProcessEvidence: result.firstProcessEvidence, failureEvidence: result.failureEvidence,
      measuredBlockCount: result.blockEvidence.length, aggregateOutputRms: rms(flattened),
      firstExactZeroOutputBlock: zeroBlock?.blockIndex ?? null,
      firstOutputBlockAtOrBelowPerBlockThreshold: belowPerBlockThreshold?.blockIndex ?? null,
      blockEvidence: result.blockEvidence,
      postRunSnapshot: { captured: false, observation: 'No snapshot was taken; the measured instance was not suspended.' },
    });
    saveDiagnostic();
    return result;
  };
  const firstBlockControllerValues = (result, key = 'controllerParametersAfterProcess') =>
    new Map((result.blockEvidence[0]?.[key]?.values ?? []).map(parameter => [parameter.id, parameter.value]));
  try {
    const defaults = await service.inspectEffect(rezFilter, initial, 'rezfilter-state-test');
    const configured = await service.inspectEffect(rezFilter, { ...defaults.state, parameters: requested }, 'rezfilter-state-test');
    const defaultParameters = await service.describeEffect(rezFilter, 'rezfilter-state-test');
    const defaultsById = new Map(defaultParameters.parameters.map(parameter => [parameter.id, parameter.currentValue]));
    if (originalPathMode) {
      originalContext = {
        requested, competing,
        defaults: defaultParameters.parameters.filter(parameter => requested.some(value => value.id === parameter.id)),
      };
      assert.ok(defaults.state.component);
      assert.ok(configured.state.component);
      // Preserve the historical state/assertion sequence, including snapshots
      // and the separate component-state reopen audit after each measured run.
      assert.equal(defaults.state.controller, undefined);
      assert.equal(configured.state.controller, undefined);
      for (const { id, value } of requested) {
        assert.ok(configured.state.parameters.some(change => change.id === id && Math.abs(change.value - value) < 1e-6));
      }

      const defaultComponent = await runOriginalPath('default-component-state', makeState(defaults.state.component));
      const defaultEffective = await inspectComponent(defaultComponent.snapshot.component);
      recordOriginalCase(defaultComponent, defaultEffective, makeState(defaults.state.component));
      for (const { id } of requested) {
        assert.ok(Math.abs(defaultEffective.parameters.find(parameter => parameter.id === id).currentValue - defaultsById.get(id)) < 1e-6,
          `component restore retains default processor parameter ${id}`);
      }

      const componentRestored = await runOriginalPath('configured-component-state-no-normalized-overrides', makeState(configured.state.component));
      for (const { id, value } of requested) {
        assert.ok(Math.abs(componentRestored.observed.get(id) - value) < 1e-6,
          `controller metadata is synchronized from component parameter ${id}`);
      }
      const componentEffective = await inspectComponent(componentRestored.snapshot.component);
      recordOriginalCase(componentRestored, componentEffective, makeState(configured.state.component));
      for (const { id, value } of requested) {
        assert.ok(Math.abs(componentEffective.parameters.find(parameter => parameter.id === id).currentValue - value) < 1e-6,
          `component restore preserves effective DSP parameter ${id}`);
      }
      const componentPcm = Float32Array.from(componentRestored.blocks.flatMap(block => [...block]));
      assert.ok(rms(componentPcm) > 1e-4, 'component-restored RezFilter produces nonzero native PCM');

      const overridden = await runOriginalPath('configured-component-state-conflicting-overrides',
        makeState(configured.state.component, competing));
      const effective = await inspectComponent(overridden.snapshot.component);
      recordOriginalCase(overridden, effective, makeState(configured.state.component, competing));
      for (const { id, value } of competing) {
        const activeValue = effective.parameters.find(parameter => parameter.id === id).currentValue;
        assert.ok(Math.abs(activeValue - value) < 1e-6, `normalized override takes precedence in native DSP parameter ${id}`);
      }
      const pcm = Float32Array.from(overridden.blocks.flatMap(block => [...block]));
      assert.ok(rms(pcm) > 1e-4, 'configured RezFilter output is nonzero for the deterministic known-onset signal');
      for (let block = 1; block < overridden.blocks.length; ++block) {
        assert.ok(rms(overridden.blocks[block]) > 1e-5, `configured native output block ${block} is not silent`);
      }
      const onset = pcm.findIndex((sample, index) => index < 1024 && Math.abs(sample) >= 1e-6);
      assert.equal(onset, 256, 'known-onset signal appears in the first native block without extra plugin latency');

      const defaultPcm = Float32Array.from(defaultComponent.blocks.flatMap(block => [...block]));
      assert.ok(difference(pcm, defaultPcm) > 1e-4,
        'normalized DSP values measurably control the actual native RezFilter output');
      return;
    }
    assert.ok(defaults.state.component);
    assert.ok(configured.state.component);
    // The pinned MDA controller does not implement getState, so there is no
    // separate controller stream to restore. The host still restores the
    // component stream, then calls controller.setComponentState(component).
    assert.equal(defaults.state.controller, undefined);
    assert.equal(configured.state.controller, undefined);
    for (const { id, value } of requested) {
      assert.ok(configured.state.parameters.some(change => change.id === id && Math.abs(change.value - value) < 1e-6));
    }

    await recordCase('fresh-default-state', initial);
    const defaultComponent = await recordCase('default-component-state-no-overrides', makeState(defaults.state.component));
    const defaultEffective = firstBlockControllerValues(defaultComponent);
    for (const { id } of requested) {
      assert.ok(Math.abs(defaultEffective.get(id) - defaultsById.get(id)) < 1e-6,
        `component restore retains default processor parameter ${id}`);
    }

    // Restore the configured component state without a normalized patch. Every
    // parameter readback below comes from the same instance producing these blocks.
    const componentRestored = await recordCase('configured-component-state-no-normalized-overrides', makeState(configured.state.component));
    for (const { id, value } of requested) {
      assert.ok(Math.abs(componentRestored.observed.get(id) - value) < 1e-6,
        `controller metadata is synchronized from component parameter ${id}`);
    }
    const componentEffective = firstBlockControllerValues(componentRestored);
    for (const { id, value } of requested) {
      assert.ok(Math.abs(componentEffective.get(id) - value) < 1e-6,
        `component restore preserves effective DSP parameter ${id}`);
    }
    const componentPcm = Float32Array.from(componentRestored.blocks.flatMap(block => [...block]));
    assert.ok(rms(componentPcm) > 1e-4, 'component-restored RezFilter produces nonzero native PCM');

    // Repeat the restored component with its intended normalized parameters,
    // then with the test's conflicting values. Native readbacks and PCM are
    // collected from the same helper instance in each case.
    await recordCase('configured-component-state-with-intended-normalized-overrides',
      makeState(configured.state.component, requested));
    const overridden = await recordCase('configured-component-state-with-conflicting-normalized-overrides',
      makeState(configured.state.component, competing));
    const effective = firstBlockControllerValues(overridden);
    for (const { id, value } of competing) {
      const activeValue = effective.get(id);
      assert.ok(Math.abs(activeValue - value) < 1e-6, `normalized override takes precedence in native DSP parameter ${id}`);
    }
    const pcm = Float32Array.from(overridden.blocks.flatMap(block => [...block]));
    assert.ok(rms(pcm) > 1e-4, 'configured RezFilter output is nonzero for the deterministic known-onset signal');
    for (let block = 1; block < overridden.blocks.length; ++block) {
      assert.ok(rms(overridden.blocks[block]) > 1e-5, `configured native output block ${block} is not silent`);
    }
    const onset = pcm.findIndex((sample, index) => index < 1024 && Math.abs(sample) >= 1e-6);
    assert.equal(onset, 256, 'known-onset signal appears in the first native block without extra plugin latency');

    const defaultPcm = Float32Array.from(defaultComponent.blocks.flatMap(block => [...block]));
    assert.ok(difference(pcm, defaultPcm) > 1e-4,
      'normalized DSP values measurably control the actual native RezFilter output');
  } finally {
    await service.dispose();
  }
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
