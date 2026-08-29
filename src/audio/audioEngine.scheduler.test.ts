import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

describe('AudioEngine look-ahead scheduler integration', () => {
  it('uses AudioClockTransport and no longer contains the recursive legacy scheduler', () => {
    const source = readFileSync(new URL('./audioEngine.ts', import.meta.url), 'utf8');
    assert.match(source, /AudioClockTransport/);
    assert.match(source, /this\.transport\.start\(\)/);
    assert.match(source, /this\.transport\.stop\(\)/);
    assert.match(source, /playbackGeneration/);
    assert.doesNotMatch(source, /const scheduleInterval = \(\) =>/);
    assert.doesNotMatch(source, /setTimeout\(scheduleInterval/);
  });

  it('schedules step audio using the transport-provided audio time', () => {
    const source = readFileSync(new URL('./audioEngine.ts', import.meta.url), 'utf8');
    assert.match(source, /triggerCurrentStep\(audioTime \+ swingOffsetSeconds\)/);
    assert.match(source, /const now = audioTime \?\? this\.ctx\.currentTime/);
  });
});
