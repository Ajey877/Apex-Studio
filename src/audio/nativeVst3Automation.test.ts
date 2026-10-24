import test from 'node:test';
import assert from 'node:assert/strict';
import type { Channel, PlaylistClip } from '../types/daw';
import { NativeAutomationTimeline, nativeTarget, nativeTargetMatches, validateNativeCurve, interpolateCurve } from './nativeVst3Automation';
import { validateProcessParameters, validateParameterChanges } from '../../native/vst3/parameters.mjs';
import { createDefaultProjectState, normalizeProjectState } from '../state/projectState';
import { serializeProjectState } from '../state/projectPersistence';
import { createHistory } from '../state/projectHistory';
import { updatePlaylistAutomationTarget } from '../components/playlistClipOperations';

const parameter = { id: 6, name: 'Contract parameter', shortTitle: '', units: '', flags: 1, stepCount: 0, defaultValue: .9, currentValue: .9 };
const initial = createDefaultProjectState();
const channel = { ...initial.channels[0], instrumentType: 'vst3', vst3: { path: '/contract.vst3', classId: 'A'.repeat(32), name: 'Contract', vendor: '', version: '', automationId: 'binding-a', state: { schema: 1, classId: 'A'.repeat(32), parameters: [] } } } as Channel;
const clip: PlaylistClip = { id: 'native-auto', type: 'automation', trackIndex: 0, startBar: 0, lengthBars: 1, name: 'Contract automation', color: '#fff', automationTarget: nativeTarget(channel, parameter), automationPoints: [{ x: 0, y: .1 }, { x: 1, y: .9 }] };
function timeline(clips = [clip]) { const t = new NativeAutomationTimeline(); t.set(clips, 2); t.clock(0, 0); return t; }
const base = new Map([[6, .9]]);

test('native automation target pins channel, exact path/class and binding, not editable base state', () => {
  assert.ok(nativeTargetMatches(clip.automationTarget!, channel));
  for (const c of [{ ...channel, id: 'other' }, { ...channel, instrumentType: 'minisynth' },
    ...['path', 'classId', 'automationId'].map(k => ({ ...channel, vst3: { ...channel.vst3!, [k]: 'replacement' } }))]) {
    assert.equal(nativeTargetMatches(clip.automationTarget!, c as Channel), false);
  }
  assert.ok(nativeTargetMatches(clip.automationTarget!, { ...channel, vst3: { ...channel.vst3!, state: { ...channel.vst3!.state, parameters: [{ id: 6, value: .2 }] } } }));
});

test('shared tension interpolation, frame conversion and multiple ordered values per block', () => {
  assert.equal(interpolateCurve([{ x: 0, y: 0, tension: 1 }, { x: 1, y: 1 }], .5), .125);
  const points = timeline().points(channel, [parameter], base, new Set(), 0, 1024, 48000);
  assert.equal(points.length, 8);
  points.forEach((p, i) => { assert.equal(p.offset, i * 128); assert.equal(p.value, .1 + .8 * i * 128 / 96000); });
  assert.deepEqual(validateProcessParameters(points, [parameter], 1024), points);
  assert.equal(timeline().points(channel, [parameter], base, new Set(), 1024 / 48000, 1024, 48000)[0].value, .1 + .8 * 1024 / 96000);
});

test('clip starts, exact vertices and end latch; removal resets once to base; stale target never writes', () => {
  const c = { ...clip, startBar: .001, lengthBars: .001, automationPoints: [{ x: 0, y: .2 }, { x: .5, y: .8 }, { x: 1, y: .3 }] };
  const t = timeline([c]), previous = new Set<number>();
  const points = t.points(channel, [parameter], base, previous, 0, 512, 48000);
  assert.deepEqual(points.map(p => [p.offset, p.value]), [[0,.9], [96,.2], [128,.6], [144,.8], [192,.3]]);
  assert.equal(t.points(channel, [parameter], base, previous, 1, 1024, 48000)[0].value, .3);
  t.set([], 2);
  assert.deepEqual(t.points(channel, [parameter], base, previous, 2, 1024, 48000), [{ id: 6, value: .9, offset: 0 }]);
  assert.deepEqual(t.points(channel, [parameter], base, previous, 3, 1024, 48000), []);
  assert.deepEqual(timeline().points({ ...channel, id: 'other' }, [parameter], base, new Set(), 0, 1024, 48000), []);
});

test('loop clocks rebase within a block; stop clears all clocks/events; constant values are coalesced', () => {
  const t = timeline(); t.clock(.01, 0);
  const points = t.points(channel, [parameter], base, new Set(), 0, 1024, 48000);
  assert.equal(points.find(p => p.offset === 480)?.value, .1);
  t.clear();
  assert.deepEqual(t.points(channel, [parameter], base, new Set(), 0, 1024, 48000), []);
  const constant = timeline([{ ...clip, automationPoints: [{ x: 0, y: .2 }, { x: 1, y: .2 }] }]);
  assert.deepEqual(constant.points(channel, [parameter], base, new Set(), 0, 1024, 48000), [{ id: 6, value: .2, offset: 0 }]);
});

test('malformed curves, unknown/nonautomatable IDs, bad values/offsets fail closed; editor duplicates still rejected', () => {
  for (const points of [[], [{ x: 0, y: NaN }, { x: 1, y: 0 }], [{ x: 0, y: 0 }, { x: 0, y: 1 }], [{ x: 0, y: -1 }, { x: 1, y: 0 }]]) {
    assert.throws(() => validateNativeCurve({ ...clip, automationPoints: points }));
  }
  assert.throws(() => timeline().points(channel, [], base, new Set(), 0, 1024, 48000), /metadata/);
  for (const params of [[{ ...parameter, id: 7 }], [{ ...parameter, flags: 2 }]]) assert.throws(() => timeline().points(channel, params, base, new Set(), 0, 1024, 48000), /unavailable/);
  for (const p of [{ id: 6, value: NaN, offset: 0 }, { id: 99, value: .2, offset: 0 }, ...[-1, .5, 1024, Infinity].map(offset => ({ id: 6, value: .2, offset }))]) {
    assert.throws(() => validateProcessParameters([p], [parameter], 1024));
  }
  assert.throws(() => validateProcessParameters([{ id: 6, value: .2, offset: 20 }, { id: 6, value: .3, offset: 10 }], [parameter], 1024));
  assert.throws(() => validateParameterChanges([{ id: 6, value: .2 }, { id: 6, value: .3 }], [parameter]));
});

test('native targets and ordinary Playlist edits survive immutable history and serialized reopen without runtime data', () => {
  const p = { ...initial, channels: [channel], playlistClips: [] as PlaylistClip[] };
  let h = createHistory(p).commit({ ...p, playlistClips: [clip] }, 'Create lane');
  const states = [h.present];
  for (const c of [{ ...clip, automationPoints: [{ x: 0, y: .3 }, { x: 1, y: .6 }] }, { ...clip, startBar: 2 },
    updatePlaylistAutomationTarget(clip, nativeTarget(channel, { ...parameter, id: 7 }))]) {
    h = h.commit({ ...p, playlistClips: [c] }, 'Edit automation'); states.push(h.present);
  }
  h = h.commit({ ...p, playlistClips: [] }, 'Delete lane');
  for (const expected of [...states].reverse()) { h = h.undo(); assert.deepEqual(h.present, expected); }
  h = h.redo();
  const serialized = serializeProjectState(h.present);
  const loaded = normalizeProjectState(JSON.parse(serialized).state);
  assert.deepEqual(loaded.playlistClips, h.present.playlistClips);
  assert.deepEqual(loaded.channels[0].vst3, channel.vst3);
  assert.equal(serialized.includes('clocks'), false);
});

test('tempo/meter bar duration, delayed entry, overlap precedence and explicit legacy binding', () => {
  const t = new NativeAutomationTimeline(); t.set([clip], 1.8); t.clock(.03, 0);
  assert.ok(Math.abs(t.points(channel, [parameter], base, new Set(), .93, 1024, 48000)[0].value - .5) < 1e-12);
  const later = { ...clip, id: 'overlap', automationPoints: [{ x: 0, y: .3 }, { x: 1, y: .3 }] };
  assert.equal(timeline([clip, later]).points(channel, [parameter], base, new Set(), .5, 1024, 48000)[0].value, .3);
  const old = { ...channel, vst3: { ...channel.vst3!, automationId: undefined } };
  assert.ok(nativeTargetMatches(nativeTarget(old, parameter), old));
  assert.equal(nativeTargetMatches(nativeTarget(old, parameter), channel), false);
});

// Performance contracts: synthetic metadata is used only for scheduler work
// counts. Positive native PCM proofs remain the MDA integration gate.
const workCounters = () => ({ clockRecords: 0, clockSegments: 0, boundaryVisits: 0, boundaryComparisons: 0, offsetSorts: 0,
  candidateOffsets: 0, evaluations: 0, winnerComparisons: 0, curveComparisons: 0, outputPoints: 0 });

test('4096-node curve is prepared once; block interpolation never reads/copies/sorts source nodes', () => {
  let reads = 0;
  const points = Array.from({ length: 4096 }, (_, i) => ({
    get x() { reads++; return i / 4095; }, get y() { reads++; return i / 4095; }, tension: i % 2 ? -.2 : .3,
  }));
  const dense = { ...clip, lengthBars: 1024 / 96000, automationPoints: points };
  const t = timeline([dense]); reads = 0;
  t.set([dense], 2); // engine's repeated immutable step snapshot: no reprepare
  assert.equal(reads, 0);
  const work = workCounters();
  const originalSort = Array.prototype.sort;
  let sorts = 0;
  let output: ReturnType<NativeAutomationTimeline['points']>;
  // Independent counter: catches copying/sorting prepared curves too, not only
  // source-array reads or self-reported work metrics. This call is synchronous.
  Array.prototype.sort = function(...args) { sorts++; return originalSort.apply(this, args); };
  try { output = t.points(channel, [parameter], base, new Set(), 0, 1024, 48000, work); }
  finally { Array.prototype.sort = originalSort; }
  assert.equal(sorts, 2, 'one bounded clock-event sort and one shared offset sort, no interpolation sorts');
  assert.equal(reads, 0);
  assert.equal(work.offsetSorts, 1);
  assert.equal(work.candidateOffsets, 1024);
  assert.equal(work.evaluations, 1024);
  assert.ok(work.curveComparisons <= 12 * work.evaluations);
  assert.ok(work.boundaryVisits <= 4096);
  for (const p of output) assert.equal(p.value, interpolateCurve(points, (p.offset! / 48000 / 2) / dense.lengthBars));
  const moved = { ...dense, startBar: 1 };
  t.set([moved], 2); // genuine update recompiles from new immutable snapshot
  assert.equal(t.points(channel, [parameter], base, new Set(), 0, 1024, 48000)[0].value, .9);
});

test('maximum 128 clips / 4096 nodes are indexed by channel, exact binding and parameter', () => {
  const channels = Array.from({ length: 4 }, (_, i) => ({ ...channel, id: `stress-${i}` }));
  const metadata = Array.from({ length: 4 }, (_, i) => ({ ...parameter, id: i }));
  const clips = Array.from({ length: 128 }, (_, i) => ({ ...clip, id: `stress-${i}`,
    automationTarget: nativeTarget(channels[i % 4], metadata[(i >>> 2) % 4]),
    automationPoints: Array.from({ length: 32 }, (_, j) => ({ x: j / 31, y: j / 31 })),
  }));
  const t = timeline(clips), work = workCounters();
  const out = t.points(channels[0], metadata, new Map(), new Set(), 0, 1024, 48000, work);
  assert.equal(new Set(out.map(p => p.id)).size, 4);
  assert.equal(work.offsetSorts, 1);
  assert.equal(work.evaluations, 4 * work.candidateOffsets);
  assert.ok(work.boundaryVisits <= 32 * 32, 'unrelated channels do not contribute nodes');
  assert.ok(work.winnerComparisons <= work.evaluations * 5);
  assert.ok(work.curveComparisons <= work.evaluations * 5);
  assert.deepEqual(t.points({ ...channels[0], vst3: { ...channel.vst3!, automationId: 'stale' } }, metadata, base, new Set(), 0, 1024, 48000), []);
  assert.throws(() => t.set([...clips, clips[0]], 2), /Invalid/);
  assert.throws(() => t.set([...clips.slice(1), { ...clips[0], automationPoints: [...clips[0].automationPoints, { x: 1, y: 0 }] }], 2), /Invalid/);
  assert.deepEqual(t.points(channels[0], metadata, new Map(), new Set(), 0, 1024, 48000), out, 'failed preparation is atomic');
});

test('128 parameters with dense constant curves are legal even when candidates × parameters exceeds 4096', () => {
  const metadata = Array.from({ length: 128 }, (_, id) => ({ ...parameter, id }));
  const clips = metadata.map(p => ({ ...clip, id: `constant-${p.id}`, lengthBars: 1024 / 96000,
    automationTarget: nativeTarget(channel, p),
    automationPoints: Array.from({ length: 32 }, (_, i) => ({ x: (i + p.id / 128) / 32, y: .3 })),
  }));
  const t = timeline(clips), work = workCounters();
  const start = performance.now();
  const out = t.points(channel, metadata, new Map(), new Set(), 0, 1024, 48000, work);
  console.log('NATIVE_AUTOMATION_MAX_VALID_WORK', JSON.stringify({ ...work, diagnosticMs: performance.now() - start }));
  assert.equal(out.length, 128);
  assert.equal(work.offsetSorts, 1);
  assert.ok(work.candidateOffsets <= 1024);
  assert.equal(work.evaluations, work.candidateOffsets * 128);
  assert.ok(work.winnerComparisons <= work.evaluations * 2);
  assert.ok(work.curveComparisons <= work.evaluations * 5);
  out.forEach(p => { assert.equal(p.offset, 0); assert.equal(p.value, .3); });
});

test('excessive varying schedule fails at the 4097th changed value without growing output or publishing previous IDs', () => {
  const metadata = Array.from({ length: 128 }, (_, id) => ({ ...parameter, id }));
  const clips = metadata.map(p => ({ ...clip, id: `varying-${p.id}`, lengthBars: 1024 / 96000,
    automationTarget: nativeTarget(channel, p),
    automationPoints: Array.from({ length: 32 }, (_, i) => ({ x: (i + p.id / 128) / 32, y: i / 31 })),
  }));
  const t = timeline(clips), work = workCounters(), previous = new Set([127]);
  assert.throws(() => t.points(channel, metadata, new Map(), previous, 0, 1024, 48000, work), /point limit/);
  assert.equal(work.outputPoints, 4096);
  // Endpoint holds can coalesce: bound evaluations too, not just array size.
  assert.ok(work.evaluations < 6 * 1024);
  assert.ok(work.candidateOffsets <= 1024);
  assert.deepEqual(previous, new Set([127]));
  assert.throws(() => t.points(channel, metadata, new Map(), previous, 0, 16384, 48000, work), /point limit/);
  assert.equal(work.outputPoints, 4096);
  assert.ok(work.candidateOffsets <= 16384);
  assert.deepEqual(previous, new Set([127]));
  assert.throws(() => t.points(channel, metadata, new Map(), previous, 0, 16385, 48000, work), /Invalid.*block/);
  assert.equal(work.candidateOffsets, 0);
});

test('old clock history cannot add phantom boundary offsets; only applicable mapping and current discontinuity are expanded', () => {
  const dense = { ...clip, startBar: 50, lengthBars: .01,
    automationPoints: Array.from({ length: 4096 }, (_, i) => ({ x: i / 4095, y: i / 4095 })),
  };
  const t = timeline([dense]);
  // Every historical mapping would project these boundaries into the same block
  // in the old implementation, despite being obsolete long before that block.
  for (let i = 1; i < 1000; i++) t.clock(i / 1000, i / 1000 + i * 1e-5);
  t.clock(1, 20);
  const work = workCounters();
  const out = t.points(channel, [parameter], base, new Set(), 100, 1024, 48000, work);
  assert.equal(work.clockRecords, 128);
  assert.equal(work.clockSegments, 1);
  assert.equal(work.boundaryVisits, 0);
  assert.equal(work.candidateOffsets, 8);
  assert.deepEqual(out, [{ id: 6, value: 1, offset: 0 }]);
  const reset = timeline(); reset.clock(10, .5); reset.clock(10.01, 0);
  const fresh = new NativeAutomationTimeline(); fresh.set([clip], 2); fresh.clock(10, .5); fresh.clock(10.01, 0);
  const a = reset.points(channel, [parameter], base, new Set(), 10, 1024, 48000, work);
  assert.equal(work.clockSegments, 2);
  assert.deepEqual(a, fresh.points(channel, [parameter], base, new Set(), 10, 1024, 48000));
  assert.equal(a.find(p => p.offset === 480)?.value, .1);
});

test('prepared overlap/end tie precedence and sorted interpolation exactly match the original evaluator', async () => {
  const { interpolateSortedCurve } = await import('./automation/curve');
  const points = Array.from({ length: 100 }, (_, i) => ({ x: i / 99, y: (i * 31 % 100) / 100, tension: (i % 3 - 1) * .37 }));
  for (let i = 0; i <= 1000; i++) assert.equal(interpolateSortedCurve(points, i / 1000), interpolateCurve(points, i / 1000));
  points.forEach(p => assert.equal(interpolateSortedCurve(points, p.x), interpolateCurve(points, p.x)));
  const clips = [
    { ...clip, id: 'under', lengthBars: 2 },
    { ...clip, id: 'over', lengthBars: .5, automationPoints: [{ x: 0, y: .8 }, { x: 1, y: .8 }] },
    { ...clip, id: 'later', startBar: 1.5, lengthBars: .25 },
  ];
  const t = timeline(clips);
  for (const bar of [0, .499999, .5, .500001, 1, 1.5, 1.75, 1.9999, 2, 3]) {
    let latest = -Infinity, expected = parameter.currentValue;
    for (const c of clips) {
      if (bar < c.startBar) continue;
      const event = Math.min(bar, c.startBar + c.lengthBars);
      if (event >= latest) { latest = event; expected = interpolateCurve(c.automationPoints!, Math.min(1, (bar - c.startBar) / c.lengthBars)); }
    }
    assert.equal(t.points(channel, [parameter], base, new Set(), bar * 2, 1, 48000)[0].value, expected);
  }
});


test('dense sub-sample boundaries across 128 in-block wraps visit frame buckets, not nodes × clocks', () => {
  const dense = { ...clip, lengthBars: 4 / 96000,
    automationPoints: Array.from({ length: 4096 }, (_, i) => ({ x: i / 4095, y: .3 })),
  };
  const t = new NativeAutomationTimeline(); t.set([dense], 2);
  for (let i = 0; i < 128; i++) t.clock(i * 8 / 48000, 0);
  const work = workCounters();
  const out = t.points(channel, [parameter], base, new Set(), 0, 1024, 48000, work);
  assert.equal(work.clockSegments, 128);
  assert.ok(work.boundaryVisits <= 1024 + 2 * 128);
  assert.ok(work.boundaryComparisons <= work.boundaryVisits * 12);
  assert.ok(work.candidateOffsets <= 1024);
  assert.equal(out.length, 1); assert.equal(out[0].value, .3);
});

test('clock span filtering keeps actual boundaries and stepped/list outputs through tempo/rewind discontinuities', () => {
  const stepped = { ...parameter, flags: 9, stepCount: 2, choices: [{ value: 0, label: 'A' }, { value: .5, label: 'B' }, { value: 1, label: 'C' }] };
  const c = { ...clip, lengthBars: .01, automationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
  const t = timeline([c]); t.clock(.01, 0); t.clock(.02, .005);
  const out = t.points(channel, [stepped], base, new Set(), .01, 1024, 48000);
  assert.deepEqual(out, t.points(channel, [stepped], base, new Set(), .01, 1024, 48000));
  assert.equal(out[0].value, 0);
  out.forEach(p => { assert.ok(stepped.choices.some(c => c.value === p.value)); assert.ok(Number.isInteger(p.offset)); });
  for (let i = 1; i < out.length; i++) assert.ok(out[i].offset! > out[i - 1].offset!);
  // A future mapping must not project its curve nodes backwards into this block.
  const future = timeline([c]); future.clock(10, 0);
  assert.deepEqual(future.points(channel, [stepped], base, new Set(), 0, 1024, 48000), timeline([c]).points(channel, [stepped], base, new Set(), 0, 1024, 48000));
});
