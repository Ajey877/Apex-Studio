import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { audioEngine } from './audioEngine';

type TestEngine = {
  ctx: AudioContext | null;
  activeVoices: Map<string, { stop: (time?: number) => void }>;
  timerId: ReturnType<typeof setTimeout> | null;
  isPlaying: boolean;
  currentStep: number;
  currentBar: number;
  stop: () => void;
};

const engine = audioEngine as unknown as TestEngine;

const originalState = {
  ctx: engine.ctx,
  activeVoices: engine.activeVoices,
  timerId: engine.timerId,
  isPlaying: engine.isPlaying,
  currentStep: engine.currentStep,
  currentBar: engine.currentBar,
};

afterEach(() => {
  if (engine.timerId) clearTimeout(engine.timerId);
  engine.ctx = originalState.ctx;
  engine.activeVoices = originalState.activeVoices;
  engine.timerId = originalState.timerId;
  engine.isPlaying = originalState.isPlaying;
  engine.currentStep = originalState.currentStep;
  engine.currentBar = originalState.currentBar;
});

describe('AudioEngine.stop', () => {
  it('stops every active voice, continues after an individual failure, clears voices, resets transport, and is idempotent', () => {
    const stopped: Array<[string, number | undefined]> = [];
    engine.ctx = { currentTime: 12.5 } as AudioContext;
    engine.activeVoices = new Map([
      ['voice-a', { stop: (time) => stopped.push(['voice-a', time]) }],
      ['voice-b', { stop: () => { throw new Error('already stopped'); } }],
      ['voice-c', { stop: (time) => stopped.push(['voice-c', time]) }],
    ]);
    engine.isPlaying = true;
    engine.currentStep = 7;
    engine.currentBar = 4;
    engine.timerId = setTimeout(() => undefined, 1000);

    engine.stop();

    assert.deepEqual(stopped, [
      ['voice-a', 12.5],
      ['voice-c', 12.5],
    ]);
    assert.equal(engine.activeVoices.size, 0);
    assert.equal(engine.timerId, null);
    assert.equal(engine.isPlaying, false);
    assert.equal(engine.currentStep, 0);
    assert.equal(engine.currentBar, 1);

    assert.doesNotThrow(() => engine.stop());
    assert.equal(engine.activeVoices.size, 0);
  });
});
