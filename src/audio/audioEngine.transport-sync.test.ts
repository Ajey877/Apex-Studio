import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('AudioEngine transport UI synchronization', () => {
  it('exposes transport state separately from look-ahead step callbacks', () => {
    const source = readFileSync(new URL('./audioEngine.ts', import.meta.url), 'utf8');
    assert.match(source, /TransportState/);
    assert.match(source, /setTransportStateCallback/);
    assert.match(source, /onStateChange:/);
    assert.match(source, /this\.transportStateCallback\?\.\(state\)/);
  });

  it('updates the live transport BPM while playing', () => {
    const source = readFileSync(new URL('./audioEngine.ts', import.meta.url), 'utf8');
    assert.match(source, /if \(this\.transport\) \{\s*this\.transport\.setBpm\(this\.bpm\);/);
  });

  it('does not drive the React playhead from the look-ahead step callback', () => {
    const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
    assert.match(source, /setTransportStateCallback\(handleTransportState\)/);
    assert.doesNotMatch(source, /setStepCallback\(handleStepTick\)/);
  });
});
