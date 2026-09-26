import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveInitialAudioDropStartBar } from './audioDropPlacement';

test('imports at the end of the arrangement inside the last valid start', () => {
  assert.equal(resolveInitialAudioDropStartBar(32, 4, { totalBars: 32 }), 28);
});

test('preserves a valid playhead-derived start position', () => {
  assert.equal(resolveInitialAudioDropStartBar(9, 4, { totalBars: 32 }), 8);
});

test('never creates a negative initial position', () => {
  assert.equal(resolveInitialAudioDropStartBar(1, 4, { totalBars: 32 }), 0);
});

test('handles clips longer than the arrangement at bar zero', () => {
  assert.equal(resolveInitialAudioDropStartBar(32, 40, { totalBars: 32 }), 0);
});
