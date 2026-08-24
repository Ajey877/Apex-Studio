import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AudioClockTransport } from './transport';

class FakeAudioContext {
  private _currentTime = 0;

  get currentTime(): number {
    return this._currentTime;
  }

  set currentTime(value: number) {
    this._currentTime = value;
  }
}

type TimerCallback = () => void;

const realWindow = (globalThis as any).window;
let timers: TimerCallback[] = [];

beforeEach(() => {
  timers = [];
  (globalThis as any).window = {
    setTimeout: (callback: TimerCallback) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => undefined,
  };
});

afterEach(() => {
  (globalThis as any).window = realWindow;
});

describe('AudioClockTransport', () => {
  it('schedules steps from the AudioContext clock, not wall-clock drift', () => {
    const fakeContext = new FakeAudioContext();
    const context = fakeContext as unknown as AudioContext;
    const transport = new AudioClockTransport(context, {
      lookAheadSeconds: 0.1,
      scheduleIntervalMs: 25,
    });
    const events: Array<{ step: number; bar: number; audioTime: number }> = [];

    transport.setCallbacks({
      onStep: (step, bar, audioTime) => events.push({ step, bar, audioTime }),
    });

    transport.start();
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { step: 0, bar: 1, audioTime: 0 });

    fakeContext.currentTime = 0.13;
    const scheduled = timers.shift();
    assert.ok(scheduled);
    scheduled();

    assert.equal(events.length, 2);
    assert.equal(events[1].step, 1);
    assert.equal(events[1].bar, 1);
    assert.ok(Math.abs(events[1].audioTime - 0.125) < 1e-9);
  });

  it('keeps musical position continuous when BPM changes while playing', () => {
    const fakeContext = new FakeAudioContext();
    const context = fakeContext as unknown as AudioContext;
    const transport = new AudioClockTransport(context);

    transport.start();
    fakeContext.currentTime = 1.5;
    transport.setBpm(60);

    const state = transport.getState();
    assert.equal(state.bpm, 60);
    assert.ok(Math.abs(state.positionSeconds - 1.5) < 1e-9);
    assert.equal(state.step, 6);
    assert.equal(state.bar, 1);
  });

  it('seeks without leaving stale scheduled time behind', () => {
    const fakeContext = new FakeAudioContext();
    const context = fakeContext as unknown as AudioContext;
    const transport = new AudioClockTransport(context);
    const events: number[] = [];

    transport.setCallbacks({ onStep: (_step, _bar, audioTime) => events.push(audioTime) });
    transport.start();
    fakeContext.currentTime = 0.4;
    transport.seek(2);

    const scheduled = timers.pop();
    assert.ok(scheduled);
    scheduled();

    assert.ok(events.some(time => Math.abs(time - 2.005) < 1e-9));
    assert.equal(transport.getState().positionSeconds, 2);
  });

  it('clamps BPM to the supported musical range', () => {
    const context = new FakeAudioContext() as unknown as AudioContext;
    const transport = new AudioClockTransport(context);

    transport.setBpm(1);
    assert.equal(transport.getState().bpm, 20);

    transport.setBpm(5000);
    assert.equal(transport.getState().bpm, 999);
  });
});
