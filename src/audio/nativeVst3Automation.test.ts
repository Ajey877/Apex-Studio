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
