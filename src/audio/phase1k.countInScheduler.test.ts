/**
 * Phase 1K — CountInScheduler against a pumped fake host.
 *
 * The scheduler is the production unit `audioEngine.beginRecordingCountIn`
 * drives. These tests run it with a fake audio clock / click voice / timer
 * (deterministic) and pin the lifecycle contract:
 *   - click times follow tempo and pulse layout, capture resolves one count-in
 *     after the start;
 *   - cancel() silences every pending click (stop before start = never sounds),
 *     clears the completion timer and rejects with CountInCancelledError;
 *   - a second start() throws instead of double-scheduling clicks;
 *   - retime() (tempo change) re-times remaining clicks without duplicates or
 *     stale timers, keeping the capture BEAT;
 *   - restart() (meter/grouping change) rebuilds the full count-in under the
 *     new layout while the waiting promise survives.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CountInCancelledError, CountInScheduler, type CountInHost } from './countInScheduler';
import { resolveMeterPulseLayout } from '../music/meterPulse';

class FakeClick {
  readonly stops: number[];
  disconnected = false;
  constructor(readonly time: number, readonly level: string) {
    // Production `scheduleMetronomeClick` pre-schedules its own stop one
    // lifetime after the click; a later stop() at/before the start pre-empts it.
    this.stops = [time + 0.05];
  }
  stop(when?: number): void { this.stops.push(when ?? Number.NaN); }
  disconnect(): void { this.disconnected = true; }
  /** Web Audio rule: stopped at/before its start time → it never plays. */
  get audible(): boolean {
    const last = this.stops[this.stops.length - 1];
    return !this.disconnected && last !== undefined && last > this.time;
  }
}

class FakeHost implements CountInHost {
  time = 0;
  clicks: FakeClick[] = [];
  timers: Array<{ id: number; at: number; fn: () => void; cleared: boolean }> = [];
  private nextTimerId = 1;

  now(): number { return this.time; }
  scheduleClick(time: number, level: string): FakeClick {
    const click = new FakeClick(time, level);
    this.clicks.push(click);
    return click;
  }
  setTimer(fn: () => void, delayMs: number): unknown {
    const entry = { id: this.nextTimerId, at: this.time + delayMs / 1000, fn, cleared: false };
    this.timers.push(entry);
    return entry.id;
  }
  clearTimer(handle: unknown): void {
    const entry = this.timers.find(t => t.id === handle);
    if (entry) entry.cleared = true;
  }
  /** Advances the fake clock, firing due timers in chronological order. */
  advanceTo(until: number): void {
    for (;;) {
      const due = this.timers
        .filter(t => !t.cleared && t.at <= until + 1e-12)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.cleared = true;
      this.time = Math.max(this.time, due.at);
      due.fn();
    }
    this.time = Math.max(this.time, until);
  }
  audibleClicks(): FakeClick[] { return this.clicks.filter(c => c.audible); }
}

const r = (x: number) => Math.round(x * 1e6) / 1e6;

describe('Phase 1K TEST 1 — count-in timing and capture moment', () => {
  it('1-bar 4/4 at 120 BPM clicks 4 quarters and resolves capture at 2.03 s (30 ms lead)', async () => {
    const host = new FakeHost();
    const scheduler = new CountInScheduler(host);
    const resultPromise = scheduler.start({
      bars: 1, layout: resolveMeterPulseLayout([4, 4]), bpm: 120, startBeat: 0,
    });
    host.advanceTo(2.5);
    const result = await resultPromise;
    assert.deepEqual(host.audibleClicks().map(c => r(c.time)), [0.03, 0.53, 1.03, 1.53]);
    assert.deepEqual(host.audibleClicks().map(c => c.level), ['downbeat', 'pulse', 'pulse', 'pulse']);
    assert.equal(r(result.captureTime), 2.03);
    assert.equal(result.captureBeat, 4);
    assert.equal(r(result.schedule.durationSeconds), 2);
    assert.equal(scheduler.isRunning, false, 'a resolved count-in is no longer active');
  });

  it('2-bar 6/8 at 120 BPM clicks 12 eighth pulses and captures at 3.03 s', async () => {
    const host = new FakeHost();
    const scheduler = new CountInScheduler(host);
    const resultPromise = scheduler.start({
      bars: 2, layout: resolveMeterPulseLayout([6, 8]), bpm: 120, startBeat: 0,
    });
    host.advanceTo(3.5);
    const result = await resultPromise;
    assert.equal(host.audibleClicks().length, 12);
    // Eighths are 0.25 s apart; the 7th click (bar 2 downbeat) lands at 1.53 s.
    assert.equal(r(host.audibleClicks()[6].time), 1.53);
    assert.equal(host.audibleClicks()[6].level, 'downbeat');
    assert.equal(r(result.captureTime), 3.03);
    assert.equal(result.captureBeat, 6);
  });

  it('7/8 count-in follows the selected grouping accents', async () => {
    const host = new FakeHost();
    const scheduler = new CountInScheduler(host);
    void scheduler.start({
      bars: 1, layout: resolveMeterPulseLayout([7, 8], '3+2+2'), bpm: 120, startBeat: 0,
    });
    host.advanceTo(2);
    assert.deepEqual(host.audibleClicks().map(c => c.level), ['downbeat', 'pulse', 'pulse', 'accent', 'pulse', 'accent', 'pulse']);
    assert.equal(r(host.audibleClicks()[3].time), 0.78); // pulse 3 = 0.75 s + lead
  });

  it('bars=0 resolves immediately with no clicks (Off)', async () => {
    const host = new FakeHost();
    const scheduler = new CountInScheduler(host);
    const resultPromise = scheduler.start({
      bars: 0, layout: resolveMeterPulseLayout([4, 4]), bpm: 120, startBeat: 8,
    });
    host.advanceTo(0.1);
    const result = await resultPromise;
    assert.equal(host.clicks.length, 0);
    assert.equal(result.captureBeat, 8, 'Off captures at the request position');
    assert.equal(result.schedule.clicks.length, 0);
  });
});

describe('Phase 1K TEST 2 — cancellation leaves no stale clicks or timers', () => {
  it('cancel() pre-empts every pending click and rejects with CountInCancelledError', async () => {
    const host = new FakeHost();
    const scheduler = new CountInScheduler(host);
    const resultPromise = scheduler.start({
      bars: 2, layout: resolveMeterPulseLayout([4, 4]), bpm: 120, startBeat: 0,
    });
    host.advanceTo(0.6); // first click sounded at 0.03; the rest are pending
    assert.equal(host.clicks.length, 8);
    scheduler.cancel();
    await assert.rejects(resultPromise, CountInCancelledError);
    const pending = host.clicks.filter(c => c.time > 0.6);
    assert.ok(pending.length > 0);
    assert.ok(pending.every(c => !c.audible), 'every pending click must be silenced');
    assert.equal(scheduler.isRunning, false);
    // The completion timer is cleared: advancing time fires nothing new.
    const clickCount = host.clicks.length;
    host.advanceTo(5);
    assert.equal(host.clicks.length, clickCount, 'no clicks scheduled after cancel');
  });

  it('cancel() before the first click silences the whole count-in', async () => {
    const host = new FakeHost();
    const scheduler = new CountInScheduler(host);
    const resultPromise = scheduler.start({
      bars: 1, layout: resolveMeterPulseLayout([4, 4]), bpm: 120, startBeat: 0,
    });
    scheduler.cancel();
    await assert.rejects(resultPromise, CountInCancelledError);
    assert.ok(host.clicks.every(c => !c.audible));
  });

  it('cancel() with no active count-in is a safe no-op', () => {
    const scheduler = new CountInScheduler(new FakeHost());
    scheduler.cancel();
    assert.equal(scheduler.isRunning, false);
  });

  it('a second start() while counting throws instead of scheduling duplicate clicks', async () => {
    const host = new FakeHost();
    const scheduler = new CountInScheduler(host);
    const first = scheduler.start({ bars: 2, layout: resolveMeterPulseLayout([4, 4]), bpm: 120, startBeat: 0 });
    const settled = assert.rejects(first, CountInCancelledError);
    const before = host.clicks.length;
    assert.throws(() => {
      scheduler.start({ bars: 2, layout: resolveMeterPulseLayout([4, 4]), bpm: 120, startBeat: 0 });
    }, /already running/);
    assert.equal(host.clicks.length, before, 'no second click set was scheduled');
    scheduler.cancel();
    await settled;
  });
});

describe('Phase 1K TEST 3 — tempo changes retime in place, meter changes restart', () => {
  it('retime() keeps the capture beat and re-times only the remaining clicks (no duplicates)', async () => {
    const host = new FakeHost();
    const scheduler = new CountInScheduler(host);
    const resultPromise = scheduler.start({
      bars: 1, layout: resolveMeterPulseLayout([4, 4]), bpm: 120, startBeat: 0,
    });
    host.advanceTo(0.6); // click 1 sounded at 0.03 (beat 0); beat 1 was scheduled at 0.53
    const soundedBefore = host.audibleClicks().filter(c => c.time <= 0.6).length;
    assert.equal(soundedBefore, 2, 'beats 0 and 1 already sounded');
    scheduler.retime(60); // quarter note now lasts 1 s
    host.advanceTo(5);
    const result = await resultPromise;
    const audible = host.audibleClicks();
    // Exactly 4 audible clicks total: nothing replayed, nothing skipped.
    assert.equal(audible.length, 4);
    // Clicks after the change are 1 s apart (60 BPM quarters).
    const late = audible.filter(c => c.time > 0.6).map(c => c.time);
    assert.equal(late.length, 2);
    for (let i = 1; i < late.length; i++) assert.ok(Math.abs(late[i] - late[i - 1] - 1) < 1e-6);
    // The musical plan is unchanged: capture still on beat 4 of the count-in.
    assert.equal(result.captureBeat, 4);
    // ~1.14 beats elapsed before the change; the remaining ~2.86 beats at
    // 60 BPM put capture at ≈ 3.46 s.
    assert.ok(result.captureTime > 3 && result.captureTime < 4.2, `captureTime=${result.captureTime}`);
    // No timer leak: every completion timer was cleared or has fired.
    assert.ok(host.timers.every(t => t.cleared || t.at <= host.time + 1e-9));
  });

  it('restart() rebuilds the full count-in under a new meter layout; the promise survives', async () => {
    const host = new FakeHost();
    const scheduler = new CountInScheduler(host);
    const resultPromise = scheduler.start({
      bars: 1, layout: resolveMeterPulseLayout([4, 4]), bpm: 120, startBeat: 0,
    });
    host.advanceTo(0.6);
    // Meter switches to 7/8 mid-count-in: "1 bar" is now 7 eighths of 7/8 and
    // the restart snaps to the next 7/8 bar line (beat 3.5 = bar 2).
    scheduler.restart(resolveMeterPulseLayout([7, 8], '2+2+3'));
    host.advanceTo(4);
    const result = await resultPromise;
    // The restarted count-in is a full 7/8 bar: 7 eighth clicks from the snap.
    const afterRestart = host.audibleClicks().filter(c => c.time >= 0.6);
    assert.equal(afterRestart.length, 7);
    assert.deepEqual(afterRestart.map(c => c.level), ['downbeat', 'pulse', 'accent', 'pulse', 'accent', 'pulse', 'pulse']);
    assert.equal(result.schedule.layout.meter[0], 7);
    // Capture is one 7/8 bar after the snapped restart line: beat 3.5 + 3.5 = 7
    // — exactly bar 3 of the new grid, so the recording offset stays a bar line.
    assert.equal(result.captureBeat, 7);
    // The first restarted click lands on the snapped bar line (1.18 s of lead-in
    // to the line + 30 ms scheduling lead).
    assert.ok(Math.abs(afterRestart[0].time - 1.81) < 1e-6, `first restart click at ${afterRestart[0].time}`);
    // No duplicate/stale clicks: audible clicks are strictly increasing in time.
    const times = host.audibleClicks().map(c => c.time);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], 'clicks must not duplicate');
  });

  it('retime() and restart() with no active count-in are safe no-ops', () => {
    const scheduler = new CountInScheduler(new FakeHost());
    scheduler.retime(90);
    scheduler.restart(resolveMeterPulseLayout([7, 8]));
    assert.equal(scheduler.isRunning, false);
  });

  it('a tempo change before any click moves the whole schedule (still 4 distinct clicks)', async () => {
    const host = new FakeHost();
    const scheduler = new CountInScheduler(host);
    const resultPromise = scheduler.start({
      bars: 1, layout: resolveMeterPulseLayout([4, 4]), bpm: 120, startBeat: 0,
    });
    scheduler.retime(240); // quarters now 0.25 s
    host.advanceTo(2);
    const result = await resultPromise;
    const audible = host.audibleClicks();
    assert.equal(audible.length, 4);
    assert.deepEqual(audible.map(c => r(c.time)), [0, 0.25, 0.5, 0.75]);
    assert.equal(r(result.captureTime), 1);
    assert.equal(result.captureBeat, 4);
  });
});
