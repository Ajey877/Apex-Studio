/**
 * Regression coverage for the transport's start lead (Stage B).
 *
 * `AudioClockTransport.start()` used to schedule the very first step at
 * `ctx.currentTime` itself — zero look-ahead — while every later step was
 * scheduled 75–100 ms ahead by the look-ahead window. The audio thread had
 * therefore already passed the first step's instant by the time its nodes were
 * created, so the first step of every take sounded late. Stage A measured this
 * in a real browser: 0.11 ms – 8.48 ms of lateness on the first step, while
 * every step scheduled inside the look-ahead window was exact.
 *
 * The lead is applied by anchoring `clockOrigin` and `nextEventTime` by the
 * SAME amount, which keeps `nextEventTime - clockOrigin === positionSeconds` so
 * the scheduler derives the step index it would have derived without the lead.
 * The alternative — shifting only `nextEventTime` — advances the derived
 * position by a full lead and skips a step whenever the start position sits
 * within one lead of a step boundary (measured: 24 % of resumes at 120 BPM with
 * a 30 ms lead, and step 0 dropped entirely at 999 BPM). T4, T5 and T6 below
 * exist specifically to reject that alternative.
 *
 * SCOPE: these tests pin the SCHEDULING CONTRACT against a fake clock. They
 * prove which audio time each step is handed to the audio graph and that no
 * step is duplicated or skipped. They do NOT prove real-hardware timing — that
 * is the Stage A browser measurement, which remains a separate activity and is
 * not replaced by anything here.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AudioClockTransport, START_LEAD_SECONDS } from './transport';
import { swingOffsetSecondsForStep } from './parameterScaling';

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

const STEP_SECONDS_AT_120_BPM = 0.125;

interface StepEvent {
  step: number;
  bar: number;
  audioTime: number;
}

interface Harness {
  fake: FakeAudioContext;
  transport: AudioClockTransport;
  events: StepEvent[];
  songEnds: () => number;
}

function makeTransport(options: {
  lookAheadSeconds?: number;
  scheduleIntervalMs?: number;
  bpm?: number;
  mode?: 'pat' | 'song';
  patternLoopSteps?: number;
  songEndSteps?: number;
} = {}): Harness {
  const fake = new FakeAudioContext();
  const transport = new AudioClockTransport(fake as unknown as AudioContext, {
    lookAheadSeconds: options.lookAheadSeconds ?? 0.1,
    scheduleIntervalMs: options.scheduleIntervalMs ?? 25,
  });
  const events: StepEvent[] = [];
  let songEndCount = 0;
  transport.setCallbacks({
    onStep: (step, bar, audioTime) => events.push({ step, bar, audioTime }),
    onSongEnd: () => { songEndCount += 1; },
  });
  if (options.bpm !== undefined) transport.setBpm(options.bpm);
  if (options.mode !== undefined) transport.setMode(options.mode);
  if (options.patternLoopSteps !== undefined) transport.setPatternLoopSteps(options.patternLoopSteps);
  if (options.songEndSteps !== undefined) transport.setSongEndSteps(options.songEndSteps);
  return { fake, transport, events, songEnds: () => songEndCount };
}

/** Fires every armed timer callback once, with the clock parked at `seconds`. */
function pumpAt(fake: FakeAudioContext, seconds: number): void {
  fake.currentTime = seconds;
  const pending = timers;
  timers = [];
  for (const callback of pending) callback();
}

/** Fires every armed timer callback once per tick, advancing the fake clock. */
function pump(fake: FakeAudioContext, ticks = 1, tickSeconds = 0.025): void {
  for (let i = 0; i < ticks; i += 1) {
    fake.currentTime = Number((fake.currentTime + tickSeconds).toFixed(10));
    const pending = timers;
    timers = [];
    for (const callback of pending) callback();
  }
}

describe('transport start lead — first-step scheduling', () => {
  it('T1: the first step is scheduled one lead in the future, never at the clock', () => {
    const { fake, transport, events } = makeTransport();
    fake.currentTime = 7.5;
    transport.start();

    assert.equal(events.length, 1);
    // The lead must not disturb the step's identity or its musical position.
    assert.equal(events[0].step, 0);
    assert.equal(events[0].bar, 1);
    // ...but its audio time must be strictly in the future: this is the defect.
    assert.ok(
      events[0].audioTime > fake.currentTime,
      `first step scheduled at ${events[0].audioTime} but the clock is already ${fake.currentTime}`,
    );
    assert.ok(Math.abs(events[0].audioTime - fake.currentTime - START_LEAD_SECONDS) < 1e-9);
  });

  it('T2: subsequent steps keep the grid the lead establishes', () => {
    const { fake, transport, events } = makeTransport();
    transport.start();
    const origin = events[0].audioTime;

    pump(fake, 14);
    assert.ok(events.length >= 4, `expected at least 4 steps, got ${events.length}`);

    for (let i = 0; i < 4; i += 1) {
      assert.equal(events[i].step, i, `step identity at index ${i}`);
      assert.equal(events[i].bar, 1, `bar at index ${i}`);
      assert.ok(
        Math.abs(events[i].audioTime - (origin + i * STEP_SECONDS_AT_120_BPM)) < 1e-9,
        `grid time at index ${i}`,
      );
    }
    // The interval contract is what the lead must never touch.
    for (let i = 1; i < 4; i += 1) {
      assert.ok(
        Math.abs(events[i].audioTime - events[i - 1].audioTime - STEP_SECONDS_AT_120_BPM) < 1e-9,
        `interval between steps ${i - 1} and ${i}`,
      );
    }
  });

  it('T3: the first step fires exactly once and is never skipped', () => {
    const { fake, transport, events } = makeTransport();
    transport.start();
    assert.equal(events.length, 1);
    assert.equal(events[0].step, 0);

    // A second start() while playing is still a no-op.
    transport.start();
    assert.equal(events.length, 1);

    pump(fake, 14);
    assert.equal(events[0].step, 0, 'the first event is step 0');
    assert.equal(events.filter(event => event.step === 0).length, 1, 'step 0 fires once per pass');
    assert.deepEqual(events.map(event => event.step), [0, 1, 2, 3]);
  });

  it('T4: resuming from any position re-triggers that position’s own step', () => {
    // Rejects the "shift only nextEventTime" variant: it advances the position
    // the scheduler derives by a full lead, so every start position within one
    // lead of a step boundary skipped a step — 24 % of resumes at 120 BPM with
    // a 30 ms lead (measured: 96/400).
    const SAMPLES = 400;
    const mismatches: string[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const frac = (i / SAMPLES) * STEP_SECONDS_AT_120_BPM;
      const { fake, transport, events } = makeTransport();
      transport.start();
      // Park the playhead inside one step, at every fractional offset across it.
      fake.currentTime = 0.5 + START_LEAD_SECONDS + frac;
      transport.pause();
      const pausedStep = transport.getState().step;
      const before = events.length;
      transport.start();
      const resumed = events[before]?.step;
      if (resumed !== pausedStep) {
        mismatches.push(`frac=${frac.toFixed(5)} paused=${pausedStep} resumed=${resumed}`);
      }
    }
    assert.deepEqual(
      mismatches,
      [],
      `${mismatches.length}/${SAMPLES} resumes triggered the wrong step`,
    );
  });

  it('T5: a fresh start emits step 0 at every supported tempo', () => {
    // At 999 BPM a step is 15.015 ms — shorter than the 30 ms lead — so a lead
    // applied to `nextEventTime` alone would floor() to step 1 and drop step 0.
    for (const bpm of [20, 60, 90, 120, 200, 300, 999]) {
      const { transport, events } = makeTransport({ bpm });
      transport.start();
      assert.ok(events.length >= 1, `bpm ${bpm}: at least one event at start`);
      assert.equal(events[0].step, 0, `bpm ${bpm}: a fresh start must begin on step 0`);
      assert.equal(events[0].bar, 1, `bpm ${bpm}: a fresh start must begin in bar 1`);
    }
  });

  it('T6: a pattern loop keeps its phase across a pause and resume', () => {
    // Swept across every fractional offset inside a step: a single sample point
    // can sit where the extra lead does not cross a step boundary and would hide
    // the phase shift the "shift only nextEventTime" variant produces.
    const LOOP = 4;
    const SAMPLES = 200;
    const mismatches: string[] = [];

    for (let i = 0; i < SAMPLES; i += 1) {
      const frac = (i / SAMPLES) * STEP_SECONDS_AT_120_BPM;
      const { fake, transport, events } = makeTransport({ mode: 'pat', patternLoopSteps: LOOP });
      transport.start();
      pump(fake, 20);

      fake.currentTime = 0.5 + START_LEAD_SECONDS + frac;
      transport.pause();
      const pausedStep = transport.getState().step;
      const before = events.length;

      transport.start();
      pump(fake, 40);
      const after = events.slice(before).map(event => event.step);

      if (after.length < LOOP) {
        mismatches.push(`frac=${frac.toFixed(5)}: only ${after.length} steps after resume`);
        continue;
      }
      if (after[0] !== pausedStep) {
        mismatches.push(`frac=${frac.toFixed(5)}: resumed on step ${after[0]}, paused on ${pausedStep}`);
        continue;
      }
      for (let k = 1; k < LOOP; k += 1) {
        const expected = (pausedStep + k) % LOOP;
        if (after[k] !== expected) {
          mismatches.push(`frac=${frac.toFixed(5)}: phase +${k} is ${after[k]}, expected ${expected}`);
          break;
        }
      }
    }

    assert.deepEqual(mismatches, [], `${mismatches.length} sample(s) lost the loop phase`);
  });

  it('T7: the lead stays inside the look-ahead window at every configuration', () => {
    // A lead at or beyond the horizon would defer step 0 to the next timer tick
    // instead of emitting it synchronously from start().
    for (const lookAheadSeconds of [0.025, 0.05, 0.1, 0.2]) {
      const { fake, transport, events } = makeTransport({ lookAheadSeconds });
      fake.currentTime = 3;
      transport.start();

      assert.ok(events.length >= 1, `lookAhead ${lookAheadSeconds}: step 0 must still be emitted at start`);
      assert.equal(events[0].step, 0, `lookAhead ${lookAheadSeconds}: the first event must be step 0`);
      const lead = events[0].audioTime - fake.currentTime;
      assert.ok(lead > 0, `lookAhead ${lookAheadSeconds}: the lead must be positive, got ${lead}`);
      assert.ok(
        lead < lookAheadSeconds,
        `lookAhead ${lookAheadSeconds}: the lead (${lead}) must stay inside the look-ahead window`,
      );
      assert.ok(
        lead <= START_LEAD_SECONDS + 1e-12,
        `lookAhead ${lookAheadSeconds}: the lead (${lead}) must never exceed START_LEAD_SECONDS`,
      );
    }
  });
});

describe('transport start lead — contracts the lead must not disturb', () => {
  it('T8: song mode still halts exactly on its end, exactly once', () => {
    const { fake, transport, events, songEnds } = makeTransport({ mode: 'song', songEndSteps: 32 });
    transport.start();
    pump(fake, 400);

    const oneBar = Array.from({ length: 16 }, (_, step) => step);
    assert.equal(events.length, 32, 'exactly one pass of 32 steps is scheduled');
    assert.deepEqual(events.slice(0, 16).map(event => event.step), oneBar);
    assert.deepEqual(events.slice(16).map(event => event.step), oneBar);
    assert.equal(songEnds(), 1, 'onSongEnd fires exactly once');

    const state = transport.getState();
    assert.equal(state.playing, false);
    assert.ok(Math.abs(state.positionSeconds - 32 * STEP_SECONDS_AT_120_BPM) < 1e-9);

    // Nothing keeps playing past the end, even if a stale timer fires.
    const stale = timers.splice(0);
    for (const callback of stale) callback();
    assert.equal(events.length, 32);
  });

  it('T9: a tempo change while playing still preserves the musical position', () => {
    // Phase 1J: the step count already reached must survive a tempo change; the
    // seconds are rescaled. The lead only shifts where the take's timeline
    // starts, so pumping whole steps of music keeps this contract intact.
    const { fake, transport, events } = makeTransport();
    transport.start();
    // Park on 1.5 s of MUSIC: the take's timeline started one lead after start(),
    // so the clock has to run that much further for 1.5 s to have elapsed.
    pumpAt(fake, 1.5 + START_LEAD_SECONDS);

    const before = transport.getState();
    transport.setBpm(60);
    const after = transport.getState();

    assert.equal(after.bpm, 60);
    // 1.5 s at 120 BPM is step 12, which is 3 beats = 3.0 s at 60 BPM.
    assert.equal(after.step, 12, 'the step reached before the change is preserved');
    assert.ok(Math.abs(after.positionSeconds - 3.0) < 1e-9, 'the seconds are rescaled, not kept');
    assert.ok(after.step >= before.step, 'the position must never jump backwards and replay steps');
    assert.equal(
      events.filter(event => event.step === 0).length,
      1,
      'step 0 is never re-issued by the tempo change',
    );
  });

  it('T10: the transport grid stays swing-free and the engine’s swing gate is unchanged', () => {
    // Swing is applied by the engine on top of the transport's step time, never
    // inside the transport, so the grid the lead establishes must stay exact.
    const { fake, transport, events } = makeTransport();
    transport.start();
    pump(fake, 14);

    for (let i = 1; i < 4; i += 1) {
      assert.ok(
        Math.abs(events[i].audioTime - events[i - 1].audioTime - STEP_SECONDS_AT_120_BPM) < 1e-9,
        `the transport must not displace step ${i}`,
      );
    }

    // The groove displacement itself is unchanged by the lead.
    assert.equal(
      swingOffsetSecondsForStep(0, STEP_SECONDS_AT_120_BPM),
      0,
      'a zero swing setting still means no displacement',
    );
    assert.ok(
      swingOffsetSecondsForStep(0.5, STEP_SECONDS_AT_120_BPM) > 0,
      'a configured groove still displaces',
    );

    // ...and it is still gated to odd steps, so step 0 — the step the lead
    // moves — is never swung and lands exactly on the led grid.
    const engineSource = readFileSync(new URL('./audioEngine.ts', import.meta.url), 'utf8');
    assert.match(
      engineSource,
      /step % 2 === 1[\s\S]{0,80}\? swingOffsetSecondsForStep\(this\.swing, secondsPerStep\)/,
      'swing is still applied to odd steps only',
    );
    assert.match(
      engineSource,
      /triggerCurrentStep\(audioTime \+ swingOffsetSeconds\)/,
      'swing is still layered on top of the transport step time',
    );
  });
});
