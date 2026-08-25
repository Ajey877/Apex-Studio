import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createTrackState, renameTrack, setTrackGain, setTrackPan, toggleTrackMute, toggleTrackSolo } from './trackModel';

test('creates a deterministic track with safe defaults', () => {
  assert.deepEqual(createTrackState('t1', 'Vocals'), { id: 't1', name: 'Vocals', gain: 1, pan: 0, muted: false, soloed: false });
});

test('validates gain and pan boundaries and finite values', () => {
  const track = createTrackState('t1');
  assert.equal(setTrackGain(track, 0).gain, 0);
  assert.equal(setTrackGain(track, 2).gain, 2);
  assert.equal(setTrackPan(track, -1).pan, -1);
  assert.equal(setTrackPan(track, 1).pan, 1);
  assert.throws(() => setTrackGain(track, -0.01), RangeError);
  assert.throws(() => setTrackGain(track, 2.01), RangeError);
  assert.throws(() => setTrackGain(track, Number.NaN), TypeError);
  assert.throws(() => setTrackPan(track, -1.01), RangeError);
  assert.throws(() => setTrackPan(track, 1.01), RangeError);
  assert.throws(() => setTrackPan(track, Number.POSITIVE_INFINITY), TypeError);
});

test('updates track state immutably', () => {
  const track = createTrackState('t1', 'Audio');
  const renamed = renameTrack(track, 'Bass');
  const muted = toggleTrackMute(renamed);
  const soloed = toggleTrackSolo(muted);
  assert.equal(track.name, 'Audio');
  assert.equal(track.muted, false);
  assert.equal(renamed.name, 'Bass');
  assert.equal(muted.muted, true);
  assert.equal(soloed.soloed, true);
});

test('rejects empty track identifiers and names', () => {
  assert.throws(() => createTrackState('', 'Track'), Error);
  assert.throws(() => createTrackState('t1', '   '), Error);
  assert.throws(() => renameTrack(createTrackState('t1'), '   '), Error);
});
