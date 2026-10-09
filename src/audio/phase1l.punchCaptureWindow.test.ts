/**
 * Phase 1L — the punch-out stop moment (`PunchCaptureWindow`).
 *
 * A punch take must stop on its own, so this class owns exactly one scheduled
 * instant. The checks pin the lifecycle the recorder depends on: it resolves
 * once at the right audio-clock moment, a tempo change preserves the MUSICAL
 * length instead of cutting the take short, and a cancel can never leave a
 * stale timer that stops a later take.
 *
 * A pumped fake clock keeps the assertions exact; the production host (the
 * engine's audio clock + window timers) is exercised end to end in
 * `phase1l.punchRecording.test.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PunchCancelledError, PunchCaptureWindow } from './punchCaptureWindow';

interface FakeTimer { at: number; fn: () => void; cleared: boolean }

class FakeHost {
  clock = 0;
  readonly timers: FakeTimer[] = [];
  now = (): number => this.clock;
  setTimer = (fn: () => void, delayMs: number): number => {
    this.timers.push({ at: this.clock + delayMs / 1000, fn, cleared: false });
    return this.timers.length;
  };
  clearTimer = (handle: unknown): void => {
    const timer = this.timers[(handle as number) - 1];
    if (timer) timer.cleared = true;
  };
  /** Advances the clock, firing every timer that comes due. */
  advance(seconds: number): void {
    const target = this.clock + seconds;
    while (this.clock < target - 1e-12) {
      const due = this.timers
        .filter(timer => !timer.cleared && timer.at <= target + 1e-12)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) { this.clock = target; return; }
      this.clock = Math.max(this.clock, due.at);
      due.cleared = true;
      due.fn();
    }
  }
  get liveTimers(): FakeTimer[] {
    return this.timers.filter(timer => !timer.cleared);
  }
}

const r = (value: number): number => Math.round(value * 1e6) / 1e6;

describe('Phase 1L — the punch window resolves at the punch-out moment', () => {
  it('resolves exactly captureTime + the musical length at the active tempo', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    // 16 quarter beats at 120 BPM = 8 s of capture, starting at audio time 2.
    const armed = punchWindow.arm({ captureTime: 2, durationBeats: 16, bpm: 120 });
    assert.equal(r(punchWindow.stopTime as number), 10);
    assert.equal(punchWindow.isActive, true);
    host.advance(9.9);
    assert.equal(punchWindow.isActive, true, 'capture must still be running just before punch-out');
    host.advance(0.2);
    const result = await armed;
    assert.equal(r(result.stopTime), 10);
    assert.equal(result.durationBeats, 16);
    assert.equal(punchWindow.isActive, false);
  });

  it('resolves only once — a second advance does not resolve anything new', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    let resolutions = 0;
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 4, bpm: 120 });
    void armed.then(() => { resolutions += 1; });
    host.advance(10);
    await armed;
    assert.equal(resolutions, 1);
    assert.equal(host.liveTimers.length, 0, 'the stop timer is consumed, never re-armed');
  });

  it('throws instead of arming two stop moments for one take', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const first = punchWindow.arm({ captureTime: 0, durationBeats: 4, bpm: 120 });
    const settled = first.catch(() => undefined);
    assert.throws(() => punchWindow.arm({ captureTime: 0, durationBeats: 8, bpm: 120 }), /already armed/);
    assert.equal(r(punchWindow.stopTime as number), 2, 'the first take keeps its own punch-out');
    punchWindow.cancel();
    await settled;
  });

  it('a zero-length window resolves immediately instead of hanging', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 0, bpm: 120 });
    host.advance(0.001);
    await armed;
    assert.equal(punchWindow.isActive, false);
  });
});

describe('Phase 1L — a tempo change preserves the punched length', () => {
  it('halving the tempo stretches the remaining beats instead of cutting the take short', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    // 8 quarter beats at 120 BPM = 4 s, captured from audio time 0.
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 8, bpm: 120 });
    host.advance(1);
    // 1 s at 120 BPM is 2 beats captured, so 6 beats are still owed.
    punchWindow.retime(60);
    assert.equal(r(punchWindow.stopTime as number), 7, 'the remaining 6 beats now take 6 s at 60 BPM');
    host.advance(5.9);
    assert.equal(punchWindow.isActive, true, 'the take must not be cut short by the tempo change');
    host.advance(0.2);
    const result = await armed;
    assert.equal(r(result.stopTime), 7);
    assert.equal(result.durationBeats, 6, 'the musical length that was left when the tempo changed');
  });

  it('doubling the tempo shortens the remaining wall-clock time but not the beats', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 8, bpm: 120 });
    host.advance(1);
    punchWindow.retime(240);
    assert.equal(r(punchWindow.stopTime as number), 2.5, 'the remaining 6 beats take 1.5 s at 240 BPM');
    host.advance(2);
    const result = await armed;
    assert.equal(result.durationBeats, 6);
  });

  it('re-arming clears the previous stop timer, so no stale timer fires early', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 8, bpm: 120 });
    host.advance(1);
    const beforeRetime = host.timers.length;
    punchWindow.retime(240);
    const stale = host.timers.slice(0, beforeRetime);
    assert.ok(stale.every(timer => timer.cleared), 'the pre-retime timer must be cleared');
    host.advance(2);
    await armed;
    assert.equal(punchWindow.isActive, false);
  });

  it('an invalid tempo is ignored rather than stopping the take', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 4, bpm: 120 });
    host.advance(0.5);
    punchWindow.retime(Number.NaN);
    assert.equal(r(punchWindow.stopTime as number), 2);
    host.advance(2);
    await armed;
  });
});

describe('Phase 1L — cancelling a punch take leaves nothing behind', () => {
  it('clears the timer and rejects with PunchCancelledError', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 16, bpm: 120 });
    host.advance(1);
    punchWindow.cancel();
    await assert.rejects(armed, PunchCancelledError);
    assert.equal(host.liveTimers.length, 0, 'no stop timer may survive a cancel');
    assert.equal(punchWindow.isActive, false);
    assert.equal(punchWindow.stopTime, null);
  });

  it('is idempotent and safe when nothing is armed', () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    assert.doesNotThrow(() => punchWindow.cancel());
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 4, bpm: 120 });
    punchWindow.cancel();
    assert.doesNotThrow(() => punchWindow.cancel());
    return assert.rejects(armed, PunchCancelledError);
  });

  it('a cancelled take can be followed by a fresh one with its own punch-out', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const first = punchWindow.arm({ captureTime: 0, durationBeats: 4, bpm: 120 });
    punchWindow.cancel();
    await assert.rejects(first, PunchCancelledError);
    const second = punchWindow.arm({ captureTime: 10, durationBeats: 4, bpm: 120 });
    assert.equal(r(punchWindow.stopTime as number), 12);
    host.advance(12);
    const result = await second;
    assert.equal(r(result.stopTime), 12);
  });

  it('cancelling after the take resolved does not resurrect it', async () => {
    const host = new FakeHost();
    const punchWindow = new PunchCaptureWindow(host);
    const armed = punchWindow.arm({ captureTime: 0, durationBeats: 4, bpm: 120 });
    host.advance(3);
    const result = await armed;
    assert.equal(r(result.stopTime), 2);
    assert.doesNotThrow(() => punchWindow.cancel());
    assert.equal(punchWindow.isActive, false);
  });
});
