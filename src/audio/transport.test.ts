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

    // Audio time is the AudioContext clock, while seek(2) is musical position.
    // At context time 0.4 the first post-seek event is scheduled 5ms ahead.
    assert.ok(events.some(time => Math.abs(time - 0.405) < 1e-9));
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

describe('AudioClockTransport pause and resume', () => {
  it('pause freezes the clock position; resume continues from the paused step', () => {
    const fakeContext = new FakeAudioContext();
    const context = fakeContext as unknown as AudioContext;
    const transport = new AudioClockTransport(context, {
      lookAheadSeconds: 0.1,
      scheduleIntervalMs: 25,
    });
    const events: number[] = [];
    transport.setCallbacks({ onStep: (step) => events.push(step) });

    transport.start();
    fakeContext.currentTime = 0.5;
    const scheduled = timers.shift();
    assert.ok(scheduled);
    scheduled();
    assert.deepEqual(events, [0, 1, 2, 3, 4]);

    transport.pause();
    const paused = transport.getState();
    assert.equal(paused.playing, false);
    assert.ok(Math.abs(paused.positionSeconds - 0.5) < 1e-9);
    assert.equal(paused.step, 4);
    assert.equal(paused.bar, 1);

    // Even a stale timer firing after the pause schedules nothing.
    const stale = timers.shift();
    assert.ok(stale);
    stale();
    assert.deepEqual(events, [0, 1, 2, 3, 4]);

    // Resume re-triggers the paused step (4) instead of restarting at step 0.
    transport.start();
    assert.equal(transport.getState().playing, true);
    assert.deepEqual(events, [0, 1, 2, 3, 4, 4]);
  });

  it('seek while stopped moves the position and start plays from there', () => {
    const fakeContext = new FakeAudioContext();
    const context = fakeContext as unknown as AudioContext;
    const transport = new AudioClockTransport(context);
    const events: Array<{ step: number; bar: number }> = [];
    transport.setCallbacks({ onStep: (step, bar) => events.push({ step, bar }) });

    transport.seek(1);
    const stopped = transport.getState();
    assert.equal(stopped.playing, false);
    assert.equal(stopped.positionSeconds, 1);
    assert.equal(stopped.step, 8);
    assert.equal(stopped.bar, 1);

    transport.start();
    assert.deepEqual(events[0], { step: 8, bar: 1 });
  });
});

describe('AudioClockTransport song end', () => {
  it('song mode schedules exactly through its real end and halts on the end position', () => {
    const fakeContext = new FakeAudioContext();
    const context = fakeContext as unknown as AudioContext;
    const transport = new AudioClockTransport(context, {
      lookAheadSeconds: 0.1,
      scheduleIntervalMs: 25,
    });
    const events: number[] = [];
    let songEnds = 0;
    transport.setCallbacks({
      onStep: (step) => events.push(step),
      onSongEnd: () => { songEnds += 1; },
    });

    transport.setSongEndSteps(32);
    transport.start();

    // Pump well past the end; scheduling must never run past step 31.
    for (let tick = 0; tick < 48; tick += 1) {
      fakeContext.currentTime = tick * 0.125;
      const pending = timers;
      timers = [];
      for (const callback of pending) callback();
    }

    // The bar grid wraps the reported step at 16, so 32 steps are two bars.
    const oneBar = Array.from({ length: 16 }, (_, step) => step);
    assert.equal(events.length, 32);
    assert.deepEqual(events.slice(0, 16), oneBar);
    assert.deepEqual(events.slice(16), oneBar);
    assert.equal(songEnds, 1);

    const state = transport.getState();
    assert.equal(state.playing, false);
    assert.ok(Math.abs(state.positionSeconds - 32 * 0.125) < 1e-9);
    assert.equal(state.step, 0);
    assert.equal(state.bar, 3);

    // Nothing keeps playing past the end, even if a stale timer fires.
    const pending = timers;
    timers = [];
    for (const callback of pending) callback();
    assert.equal(events.length, 32);
  });

  it('clearing the song end returns the transport to looping', () => {
    const fakeContext = new FakeAudioContext();
    const context = fakeContext as unknown as AudioContext;
    const transport = new AudioClockTransport(context, {
      lookAheadSeconds: 0.1,
      scheduleIntervalMs: 25,
    });
    const events: Array<{ step: number; bar: number }> = [];
    transport.setCallbacks({ onStep: (step, bar) => events.push({ step, bar }) });

    transport.setSongEndSteps(32);
    transport.start();
    for (let tick = 0; tick < 40; tick += 1) {
      fakeContext.currentTime = tick * 0.125;
      const pending = timers;
      timers = [];
      for (const callback of pending) callback();
    }
    assert.equal(transport.getState().playing, false);
    assert.equal(events.length, 32);

    // Pattern Mode semantics: no end -> the bar grid loops again. The pump
    // loop above left the clock at 4.875s, past the 4.0s end position.
    transport.setSongEndSteps();
    transport.start();
    fakeContext.currentTime = 5.0;
    const scheduled = timers.shift();
    assert.ok(scheduled);
    scheduled();

    assert.equal(transport.getState().playing, true);
    assert.ok(events.length > 32, 'steps keep flowing after the end is cleared');
    // The resumed first event is on bar 3: the position continued from step
    // 32 (the end) instead of restarting at zero.
    assert.deepEqual(events[32], { step: 0, bar: 3 });
  });
});
