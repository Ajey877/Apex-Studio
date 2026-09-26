import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveInitialAudioDropStartBar } from './audioDropPlacement';

test('imported audio at the playhead is clamped so the whole clip fits inside the arrangement', () => {
  assert.equal(resolveInitialAudioDropStartBar(32, 4, { totalBars: 32 }), 28);
  assert.equal(resolveInitialAudioDropStartBar(32, 1, { totalBars: 32 }), 31);
});

test('imported audio at a valid playhead position keeps its intended timeline start', () => {
  assert.equal(resolveInitialAudioDropStartBar(9, 4, { totalBars: 32 }), 8);
});

test('initial audio placement never becomes negative', () => {
  assert.equal(resolveInitialAudioDropStartBar(1, 4, { totalBars: 32 }), 0);
  assert.equal(resolveInitialAudioDropStartBar(0, 4, { totalBars: 32 }), 0);
});

test('initial audio placement snaps to the existing playlist grid', () => {
  assert.equal(resolveInitialAudioDropStartBar(10.13, 4, { totalBars: 32, gridBars: 0.25 }), 9);
  assert.equal(resolveInitialAudioDropStartBar(32, 3.6, { totalBars: 32, gridBars: 0.25 }), 28.25);
});
