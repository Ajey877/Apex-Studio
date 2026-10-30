// Isolated diagnostic: reproduce packaged Desktop two-insert RezFilter silence
// (latency-two-filter, known-onset PCM) on the native helper. Not a production fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { NativeVst3Client, discoverVst3 } from '../native/vst3/client.mjs';

const build = path.resolve(process.env.APEX_NATIVE_BUILD ?? 'build/native-vst3');
const executableName = process.platform === 'win32' ? 'apex-vst3-host.exe' : 'apex-vst3-host';
const executable = [path.join(build, 'bin', executableName), path.join(build, 'bin/Release', executableName)].find(existsSync);
assert.ok(executable, 'Build the native host and MDA fixture first; see native/vst3/README.md');
const bundle = path.join(build, 'VST3/Release', 'mda-vst3.vst3');
assert.ok(existsSync(bundle), 'Real MDA VST3 fixture is required');
const sampleRate = 48000;
const blockFrames = 1024;
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();

const { plugins: effects, errors } = await discoverVst3(executable, [bundle], { kind: 'effect' });
assert.deepEqual(errors, []);
const delayPlugin = effects.find(plugin => plugin.name === 'mda Delay');
const rezFilterPlugin = effects.find(plugin => plugin.name === 'mda RezFilter');
assert.ok(delayPlugin && rezFilterPlugin, 'Pinned Delay and RezFilter fixtures must be factory-discovered');

// Exact packaged Mixer overlay from nativeVst3DesktopSmoke.ts.
const PACKAGED_REZFILTER_FIXTURE_PARAMETERS = [
  { id: 0, value: 0.8 },
  { id: 1, value: 0.25 },
  { id: 3, value: 0.5 },
  { id: 6, value: 0.5 },
  { id: 8, value: 0 },
  { id: 9, value: 1 },
];
const DELAY_BYPASS_PARAMETERS = [{ id: 4, value: 0 }];

function createKnownOnsetPcm(amplitude, totalFrames) {
  const onsetFrame = 256;
  const audio = new Float32Array(totalFrames * 2);
  let state = amplitude < 0.06 ? 0x51ed270b : 0x2c1b3c6d;
  for (let frame = onsetFrame; frame < totalFrames; frame++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const sample = ((state >>> 0) / 0x80000000 - 1) * amplitude;
    audio[frame] = sample;
    audio[totalFrames + frame] = sample;
  }
  return audio;
}

function createMixerNoisePcm(frames) {
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

function sliceBlock(pcm, totalFrames, blockIndex, frames = blockFrames) {
  const out = new Float32Array(frames * 2);
  const start = blockIndex * frames;
  out.set(pcm.subarray(start, start + frames), 0);
  out.set(pcm.subarray(totalFrames + start, totalFrames + start + frames), frames);
  return out;
}

function silenceBlock(frames = blockFrames) {
  return new Float32Array(frames * 2);
}

function compactTrace(trace, samples) {
  const rms = samples => {
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  };
  let nonzero = 0;
  for (const sample of samples) if (sample !== 0) nonzero++;
  return {
    block: trace?.block,
    frames: trace?.frames,
    sampleRate: trace?.sampleRate,
    mode: trace?.mode,
    classId: trace?.classId,
    cursor: trace?.cursor,
    silenceFlags: trace?.silenceFlags,
    pendingWasEmpty: trace?.pendingWasEmpty,
    queuedParameters: trace?.queuedParameters ?? [],
    inputRms: trace?.inputRms,
    inputNonzero: trace?.inputNonzero,
    outputBufferRms: trace?.outputBufferRms,
    outputBufferNonzero: trace?.outputBufferNonzero,
    extractedRms: trace?.extractedRms ?? rms(samples),
    extractedNonzero: trace?.extractedNonzero ?? nonzero,
  };
}

async function withClient(plugin, options, run) {
  const client = new NativeVst3Client(executable);
  try {
    const opened = await client.open(plugin, { kind: 'effect', sampleRate, ...options });
    return await run(client, opened);
  } finally {
    await client.dispose();
  }
}

async function inspectWithOverlay(plugin, overlay) {
  const state = { schema: 1, classId: plugin.classId, parameters: overlay };
  return withClient(plugin, { mode: 'offline', state }, async client => {
    await client.processAudio(1, new Float32Array(2));
    return client.snapshot();
  });
}

async function processTraced(client, input) {
  const reply = await client.processAudio(input.length / 2, input, [], 120, true);
  assert.ok(reply.processTrace, 'host must return processTrace when requested');
  return { samples: reply.samples, trace: compactTrace(reply.processTrace, reply.samples) };
}

async function warmupSilent(client, blocks) {
  const traces = [];
  for (let i = 0; i < blocks; i++) {
    const { trace } = await processTraced(client, silenceBlock());
    traces.push(trace);
  }
  return traces;
}

function summarize(name, traces) {
  const inputEnergy = traces.filter(trace => trace.inputRms > 1e-6).length;
  const outputEnergy = traces.filter(trace => trace.extractedRms > 1e-6).length;
  const bufferEnergy = traces.filter(trace => trace.outputBufferRms > 1e-6).length;
  const flaggedSilence = traces.filter(trace => Number(trace.silenceFlags) !== 0).length;
  return {
    name,
    blocks: traces.length,
    inputEnergy,
    outputEnergy,
    bufferEnergy,
    flaggedSilence,
    firstQueued: traces[0]?.queuedParameters ?? [],
    firstPendingWasEmpty: traces[0]?.pendingWasEmpty,
    first16: traces.slice(0, 16),
    silent: outputEnergy === 0 && inputEnergy > 0,
  };
}

async function runSingle({ name, inputFactory, warmupBlocks, overlay, reopen }) {
  const inspected = await inspectWithOverlay(rezFilterPlugin, overlay);
  const totalFrames = 50 * blockFrames;
  const input = inputFactory(totalFrames);
  return withClient({ ...rezFilterPlugin, state: inspected }, { mode: 'realtime', state: inspected }, async client => {
    if (overlay.length) await client.parameters(overlay);
    if (reopen) {
      await processTraced(client, sliceBlock(input, totalFrames, 0));
      const snapped = await client.snapshot();
      const reopened = new NativeVst3Client(executable);
      try {
        await reopened.open({ ...rezFilterPlugin, state: snapped }, { kind: 'effect', sampleRate, mode: 'realtime', state: snapped });
        if (overlay.length) await reopened.parameters(overlay);
        const warmup = await warmupSilent(reopened, warmupBlocks);
        const traces = [];
        for (let block = 0; block < 50; block++) traces.push((await processTraced(reopened, sliceBlock(input, totalFrames, block))).trace);
        return { ...summarize(name, traces), warmup: summarize(`${name}:warmup`, warmup), sampleRate, mode: 'realtime', sha, classId: rezFilterPlugin.classId };
      } finally {
        await reopened.dispose();
      }
    }
    const warmup = await warmupSilent(client, warmupBlocks);
    const traces = [];
    for (let block = 0; block < 50; block++) traces.push((await processTraced(client, sliceBlock(input, totalFrames, block))).trace);
    return { ...summarize(name, traces), warmup: summarize(`${name}:warmup`, warmup), sampleRate, mode: 'realtime', sha, classId: rezFilterPlugin.classId };
  });
}

async function runDelayThenFilter({ name, inputFactory, warmupBlocks }) {
  const delayState = await inspectWithOverlay(delayPlugin, DELAY_BYPASS_PARAMETERS);
  const filterState = await inspectWithOverlay(rezFilterPlugin, PACKAGED_REZFILTER_FIXTURE_PARAMETERS);
  const totalFrames = 50 * blockFrames;
  const input = inputFactory(totalFrames);
  const delayClient = new NativeVst3Client(executable);
  const filterClient = new NativeVst3Client(executable);
  try {
    await delayClient.open({ ...delayPlugin, state: delayState }, { kind: 'effect', sampleRate, mode: 'realtime', state: delayState });
    await filterClient.open({ ...rezFilterPlugin, state: filterState }, { kind: 'effect', sampleRate, mode: 'realtime', state: filterState });
    await delayClient.parameters(DELAY_BYPASS_PARAMETERS);
    await filterClient.parameters(PACKAGED_REZFILTER_FIXTURE_PARAMETERS);
    const delayWarmup = [], filterWarmup = [];
    for (let i = 0; i < warmupBlocks; i++) {
      const silent = silenceBlock();
      delayWarmup.push((await processTraced(delayClient, silent)).trace);
      filterWarmup.push((await processTraced(filterClient, silent)).trace);
    }
    const delayTraces = [], filterTraces = [];
    for (let block = 0; block < 50; block++) {
      const sliced = sliceBlock(input, totalFrames, block);
      const delayed = await processTraced(delayClient, sliced);
      delayTraces.push(delayed.trace);
      const filtered = await processTraced(filterClient, delayed.samples);
      filterTraces.push(filtered.trace);
    }
    return {
      name,
      sha,
      sampleRate,
      mode: 'realtime',
      delayClassId: delayPlugin.classId,
      filterClassId: rezFilterPlugin.classId,
      delay: summarize(`${name}:delay`, delayTraces),
      filter: summarize(`${name}:filter`, filterTraces),
      delayWarmup: summarize(`${name}:delay-warmup`, delayWarmup),
      filterWarmup: summarize(`${name}:filter-warmup`, filterWarmup),
    };
  } finally {
    await delayClient.dispose();
    await filterClient.dispose();
  }
}

test('RezFilter known-onset isolation: record processor buffers after process, not inferred output', async () => {
  const knownOnset = frames => createKnownOnsetPcm(0.08, frames);
  const mixerNoise = frames => {
    const audio = new Float32Array(frames * 2);
    for (let block = 0; block < frames / blockFrames; block++) {
      const noise = createMixerNoisePcm(blockFrames);
      audio.set(noise.subarray(0, blockFrames), block * blockFrames);
      audio.set(noise.subarray(blockFrames), frames + block * blockFrames);
    }
    return audio;
  };

  const reports = [];
  reports.push(await runSingle({
    name: 'single-immediate-noise-no-warmup',
    inputFactory: mixerNoise,
    warmupBlocks: 0,
    overlay: PACKAGED_REZFILTER_FIXTURE_PARAMETERS,
  }));
  reports.push(await runSingle({
    name: 'single-known-onset-no-warmup',
    inputFactory: knownOnset,
    warmupBlocks: 0,
    overlay: PACKAGED_REZFILTER_FIXTURE_PARAMETERS,
  }));
  reports.push(await runSingle({
    name: 'single-known-onset-warmup-16',
    inputFactory: knownOnset,
    warmupBlocks: 16,
    overlay: PACKAGED_REZFILTER_FIXTURE_PARAMETERS,
  }));
  reports.push(await runSingle({
    name: 'single-known-onset-reopen',
    inputFactory: knownOnset,
    warmupBlocks: 16,
    overlay: PACKAGED_REZFILTER_FIXTURE_PARAMETERS,
    reopen: true,
  }));
  reports.push(await runDelayThenFilter({
    name: 'delay-then-filter-immediate-noise-no-warmup',
    inputFactory: mixerNoise,
    warmupBlocks: 0,
  }));
  reports.push(await runDelayThenFilter({
    name: 'delay-then-filter-known-onset-no-warmup',
    inputFactory: knownOnset,
    warmupBlocks: 0,
  }));
  const packagedMatch = await runDelayThenFilter({
    name: 'packaged-match-delay-then-filter-known-onset-warmup-16',
    inputFactory: knownOnset,
    warmupBlocks: 16,
  });
  reports.push(packagedMatch);

  const evidence = {
    sha,
    branch,
    platform: process.platform,
    executable,
    sampleRate,
    blockFrames,
    overlay: PACKAGED_REZFILTER_FIXTURE_PARAMETERS,
    delayBypass: DELAY_BYPASS_PARAMETERS,
    reports,
    packagedMatchSilent: packagedMatch.filter.silent === true,
  };
  const evidenceDir = path.resolve('build/native-evidence');
  mkdirSync(evidenceDir, { recursive: true });
  const evidencePath = path.join(evidenceDir, 'rezfilter-known-onset-diag.json');
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
  console.log(`REZFILTER_KNOWN_ONSET_DIAG sha=${sha} branch=${branch} packagedMatchSilent=${evidence.packagedMatchSilent}`);
  for (const report of reports) {
    if (report.filter) {
      console.log(`  ${report.name}: delay in/out ${report.delay.inputEnergy}/${report.delay.outputEnergy} filter in/out ${report.filter.inputEnergy}/${report.filter.outputEnergy} flagged=${report.filter.flaggedSilence} firstQueued=${JSON.stringify(report.filter.firstQueued)}`);
    } else {
      console.log(`  ${report.name}: in/out ${report.inputEnergy}/${report.outputEnergy} flagged=${report.flaggedSilence} firstQueued=${JSON.stringify(report.firstQueued)}`);
    }
  }

  assert.equal(packagedMatch.delay.sampleRate ?? sampleRate, 48000);
  assert.equal(packagedMatch.filter.first16.length, 16);
  assert.ok(packagedMatch.filter.inputEnergy > 0, 'Delay→filter known-onset must present energy at the filter input');
  assert.ok(
    packagedMatch.filter.outputEnergy > 0,
    `Packaged-matching Delay→RezFilter known-onset was silent after processor->process: ${JSON.stringify({
      filterIn: packagedMatch.filter.inputEnergy,
      filterOut: packagedMatch.filter.outputEnergy,
      bufferOut: packagedMatch.filter.bufferEnergy,
      flagged: packagedMatch.filter.flaggedSilence,
      first16: packagedMatch.filter.first16,
    })}`,
  );
});
