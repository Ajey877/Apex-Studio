import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPRESENTATIVE_PROJECT } from '../../fixtures/representative-project.mjs';
import { compileProject, renderProjectSources } from '../../web/project-model.mjs';
import { createProjectRenderer, decodeWav16Bit, encodeWav16Bit, hashBytes32, interleaveFloat32Stereo, ProjectRenderCancelledError } from '../../web/project-render-core.mjs';
import { maxAbsDifference, renderProjectReference, summarizeStereo } from '../../web/project-render-reference.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wasm = Uint8Array.from(readFileSync(join(root, 'dsp/gain_biquad_engine.wasm')));
const TOLERANCE = 1e-6;
const PCM_TOLERANCE = (1 / 32767) + 1e-7;

test('representative fixture compiles 4 independent tracks, 2 buses and 48 scheduled clip events', () => {
  const compiled = compileProject(REPRESENTATIVE_PROJECT);
  assert.deepEqual(compiled.tracks.map(track => track.id), ['kick', 'hat', 'bass', 'keys']);
  assert.equal(compiled.buses.length, 2);
  assert.equal(compiled.eventCount, 48);
  assert.equal(compiled.totalFrames, 204000);
  assert.deepEqual(compiled.tracks.map(track => track.source.kind), ['sample', 'sample', 'instrument', 'instrument']);
  const sources = renderProjectSources(compiled);
  const sourceHashes = sources.map(source => hashBytes32(new Uint8Array(source.buffer, source.byteOffset, source.byteLength)));
  assert.equal(new Set(sourceHashes).size, sources.length, 'each track has a distinct scheduled source');
  assert.ok(sources.every(source => rms(source) > 1e-5));
  assert.ok(sources.every(source => source.subarray(source.length - 1000).every(sample => sample === 0)), 'all scheduled source voices release to silence before the fixture tail ends');
});

test('independent JS reference produces finite stereo, non-silent stems and routed buses', () => {
  const reference = renderProjectReference(REPRESENTATIVE_PROJECT);
  assert.equal(reference.info.durationFrames, 204000);
  assert.equal(reference.tracks.length, 4);
  assert.equal(reference.buses.length, 2);
  assert.ok(reference.tracks.every(track => summarizeStereo(track).left.rms > 1e-5));
  assert.ok(reference.buses.every(bus => summarizeStereo(bus).left.rms > 1e-5));
  assert.equal(summarizeStereo(reference.master).left.nonFinite, 0);
  assert.ok(summarizeStereo(reference.master).left.peak > 0.01);
});

test('fader automation before vs after the WASM insert is measurably not equivalent', () => {
  const correctOrder = renderProjectReference(REPRESENTATIVE_PROJECT, { captureStems: false });
  const alternateOrder = renderProjectReference(REPRESENTATIVE_PROJECT, { captureStems: false, automationBeforeInsert: true });
  const delta = maxAbsDifference(correctOrder.master.left, alternateOrder.master.left).maxAbsDiff;
  assert.ok(delta > 1e-6, `order sensitivity ${delta} did not exceed the 1e-6 tolerance`);
});

test('shared WASM project renderer matches scalar reference and reuses fixed memory across serial exports', () => {
  const reference = renderProjectReference(REPRESENTATIVE_PROJECT);
  const renderer = createProjectRenderer(wasm);
  const hashes = new Set();
  let first;
  let last;
  for (let job = 0; job < 12; job++) {
    last = renderer.renderProjectSync(REPRESENTATIVE_PROJECT, { captureStems: job === 0 });
    if (job === 0) first = last;
    const left = maxAbsDifference(last.master.left, reference.master.left);
    const right = maxAbsDifference(last.master.right, reference.master.right);
    assert.ok(left.maxAbsDiff <= TOLERANCE, `master L maxAbsDiff ${left.maxAbsDiff}`);
    assert.ok(right.maxAbsDiff <= TOLERANCE, `master R maxAbsDiff ${right.maxAbsDiff}`);
    assert.equal(left.nonFinite + right.nonFinite, 0);
    const wav = encodeWav16Bit(last.master, last.info.sampleRate);
    hashes.add(hashBytes32(wav));
    assert.equal(decodeWav16Bit(wav).frames, reference.info.durationFrames);
    assert.equal(renderer.snapshot().memoryBytes, 131072);
  }
  assert.equal(hashes.size, 1);
  assert.equal(last.memory.engineInstances, 1);
  assert.equal(last.memory.jobsCompleted, 12);
  assert.equal(last.memory.memoryBytesAtStart, 131072);
  assert.equal(last.memory.memoryBytes, 131072);
  assert.equal(last.tracks.length, 0, 'only first export requested full stem capture');
  assert.equal(first.tracks.length, 4);
  assert.equal(first.buses.length, 2);
  for (let i = 0; i < first.tracks.length; i++) {
    assert.ok(maxAbsDifference(first.tracks[i].left, reference.tracks[i].left).maxAbsDiff <= TOLERANCE);
    assert.ok(maxAbsDifference(first.tracks[i].right, reference.tracks[i].right).maxAbsDiff <= TOLERANCE);
  }
  for (let i = 0; i < first.buses.length; i++) {
    assert.ok(maxAbsDifference(first.buses[i].left, reference.buses[i].left).maxAbsDiff <= TOLERANCE);
    assert.ok(maxAbsDifference(first.buses[i].right, reference.buses[i].right).maxAbsDiff <= TOLERANCE);
  }
  assert.equal(last.metrics.blocks, Math.ceil(204000 / 128));
});

test('cancelled render resets slots; the same engine renders a clean full project afterward', async () => {
  const renderer = createProjectRenderer(wasm);
  let cancelNow = false;
  await assert.rejects(renderer.renderProject(REPRESENTATIVE_PROJECT, {
    jobId: 'unit-cancel',
    yieldEveryBlocks: 8,
    shouldCancel: () => cancelNow,
    onProgress: () => { cancelNow = true; },
  }), ProjectRenderCancelledError);
  const afterCancel = renderer.snapshot();
  assert.equal(afterCancel.jobsStarted, 1);
  assert.equal(afterCancel.jobsCancelled, 1);
  assert.equal(afterCancel.jobsCompleted, 0);
  assert.equal(afterCancel.memoryBytes, 131072);
  const ref = renderProjectReference(REPRESENTATIVE_PROJECT, { captureStems: false });
  const after = await renderer.renderProject(REPRESENTATIVE_PROJECT, { jobId: 'unit-recovery' });
  assert.ok(maxAbsDifference(after.master.left, ref.master.left).maxAbsDiff <= TOLERANCE);
  assert.equal(after.memory.jobsCancelled, 1);
  assert.equal(after.memory.jobsCompleted, 1);
  assert.equal(after.memory.memoryBytes, 131072);
});

test('PCM16 WAV encoder writes a valid stereo file within declared quantization tolerance', () => {
  const reference = renderProjectReference(REPRESENTATIVE_PROJECT, { captureStems: false });
  const wav = encodeWav16Bit(reference.master, reference.info.sampleRate);
  const decoded = decodeWav16Bit(wav);
  assert.equal(wav.length, 44 + reference.info.durationFrames * 4);
  assert.equal(decoded.frames, reference.info.durationFrames);
  assert.equal(decoded.sampleRate, 48000);
  assert.ok(maxAbsDifference(decoded.left, reference.master.left).maxAbsDiff <= PCM_TOLERANCE);
  assert.ok(maxAbsDifference(decoded.right, reference.master.right).maxAbsDiff <= PCM_TOLERANCE);
});

test('float32 PCM interleave preserves independent stereo channel samples', () => {
  const interleaved = interleaveFloat32Stereo({ left: Float32Array.from([-1, 0.25, 0]), right: Float32Array.from([1, -0.25, 0.5]) });
  assert.deepEqual([...interleaved], [-1, 1, 0.25, -0.25, 0, 0.5]);
  assert.throws(() => interleaveFloat32Stereo({ left: Float32Array.of(1), right: Float32Array.of() }), /matching/);
});

test('project validation rejects unsupported route targets and invalid schedule controls', () => {
  const badRoute = structuredClone(REPRESENTATIVE_PROJECT);
  badRoute.tracks[0].routes[0].busId = 'missing-bus';
  assert.throws(() => compileProject(badRoute), /missing bus/);
  const badTempo = structuredClone(REPRESENTATIVE_PROJECT);
  badTempo.tempoBpm = 0;
  assert.throws(() => compileProject(badTempo), /invalid sample rate, tempo/);
});

function rms(buffer) {
  let sum = 0;
  for (const value of buffer) sum += value * value;
  return Math.sqrt(sum / Math.max(1, buffer.length));
}
