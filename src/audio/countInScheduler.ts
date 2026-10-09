/**
 * Phase 1K — the recording count-in scheduler.
 *
 * Turns a `CountInSchedule` (src/music/countIn.ts) into real scheduled
 * metronome clicks and a capture moment. The class owns NO musical policy and
 * NO Web Audio types of its own: the host supplies the audio clock, the click
 * voice and the timer primitives, so the exact same scheduler runs inside
 * `audioEngine` (real `scheduleMetronomeClick` oscillators, real wall-clock
 * timers) and inside deterministic tests (pumped fake clock).
 *
 * Contract highlights (these are what Phase 1K verifies):
 *   - Every click of a count-in is scheduled up front — there is no interval
 *     timer, so a stop/cancel cannot leave a stale timer that clicks later.
 *   - Each click is tracked by its handle. `cancel()` stops every handle at
 *     "now", which pre-empts clicks that have not sounded yet (Web Audio rule:
 *     an oscillator stopped at or before its start time never plays).
 *   - `start()` while a count-in is active THROWS instead of double-scheduling
 *     (no duplicate clicks from a double-pressed Record button).
 *   - `retime()` (tempo change) re-times the remaining clicks in place: the
 *     musical plan — which beats click and the capture beat — is unchanged and
 *     clicks that already sounded are never replayed.
 *   - `restart()` (meter / 7/8 grouping change) rebuilds the full count-in
 *     under the new layout from the change point, keeping the SAME promise so
 *     a waiting recorder still starts exactly one count-in later.
 *   - `cancel()` rejects the waiting promise with `CountInCancelledError`, the
 *     signal for callers to abandon capture entirely (no take, no offset).
 */
import {
  buildCountInSchedule,
  isCountInBars,
  type CountInBars,
  type CountInSchedule,
} from '../music/countIn';
import { beatsPerBar, type MusicalBeats } from '../music/musicalTime';
import type { MeterPulseLayout, PulseLevel } from '../music/meterPulse';

/** Minimal handle of a scheduled click (a Web Audio oscillator in production). */
export interface CountInClickHandle {
  stop(when?: number): void;
  disconnect(): void;
}

/** The environment a count-in runs in: audio clock, click voice and timers. */
export interface CountInHost {
  /** Audio-clock seconds. */
  now(): number;
  /** Schedules one click at an absolute audio time and returns its handle. */
  scheduleClick(time: number, level: PulseLevel): CountInClickHandle;
  setTimer(fn: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export class CountInCancelledError extends Error {
  constructor(message = 'The recording count-in was cancelled') {
    super(message);
    this.name = 'CountInCancelledError';
  }
}

export interface CountInStartParams {
  bars: CountInBars;
  layout: MeterPulseLayout;
  bpm: number;
  /** Musical position (quarter beats) where the count-in starts. */
  startBeat: MusicalBeats;
  /** Scheduling lead so the first click never lands in the past. Default 30 ms. */
  leadSeconds?: number;
}

export interface CountInResult {
  readonly schedule: CountInSchedule;
  /** Audio-clock time the count-in started sounding. */
  readonly startTime: number;
  /** Audio-clock time capture must begin at. */
  readonly captureTime: number;
  /** Musical position (quarter beats) where capture begins. */
  readonly captureBeat: MusicalBeats;
}

interface ScheduledClick {
  /** ABSOLUTE musical beat the click sounds on (survives retiming anchors). */
  readonly beat: MusicalBeats;
  readonly level: PulseLevel;
  handle: CountInClickHandle;
  time: number;
}

interface ActiveCountIn {
  bars: CountInBars;
  layout: MeterPulseLayout;
  bpm: number;
  /** Musical anchor: the beat `startTime` corresponds to. */
  startBeat: MusicalBeats;
  startTime: number;
  leadSeconds: number;
  schedule: CountInSchedule;
  clicks: ScheduledClick[];
  captureBeat: MusicalBeats;
  captureTime: number;
  timer: unknown;
  resolve: (result: CountInResult) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

const DEFAULT_LEAD_SECONDS = 0.03;

const beatsToSecondsAt = (beats: number, bpm: number): number => beats * (60 / bpm);

export class CountInScheduler {
  private active: ActiveCountIn | null = null;

  constructor(private readonly host: CountInHost) {}

  get isRunning(): boolean {
    return this.active !== null;
  }

  /** Musical position (quarter beats) capture will begin at, or null. */
  get captureBeat(): MusicalBeats | null {
    return this.active ? this.active.captureBeat : null;
  }

  /** Audio-clock time capture will begin at, or null. */
  get captureTime(): number | null {
    return this.active ? this.active.captureTime : null;
  }

  /**
   * Starts a count-in of `bars` bars and resolves exactly when capture must
   * begin. Throws synchronously when a count-in is already running — the
   * caller keeps its existing promise and no second click set is scheduled.
   */
  start(params: CountInStartParams): Promise<CountInResult> {
    if (this.active) {
      throw new Error('A recording count-in is already running');
    }
    const bars = isCountInBars(params.bars) ? params.bars : 0;
    const bpm = Number.isFinite(params.bpm) && params.bpm > 0 ? params.bpm : 120;
    const leadSeconds = params.leadSeconds ?? DEFAULT_LEAD_SECONDS;
    const now = this.host.now();
    const startTime = now + leadSeconds;
    const schedule = buildCountInSchedule({ bars, layout: params.layout, bpm });
    const startBeat = Number.isFinite(params.startBeat) ? params.startBeat : 0;

    let resolve!: (result: CountInResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<CountInResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const active: ActiveCountIn = {
      bars,
      layout: params.layout,
      bpm,
      startBeat,
      startTime,
      leadSeconds,
      schedule,
      clicks: [],
      captureBeat: startBeat + schedule.durationBeats,
      captureTime: startTime + schedule.durationSeconds,
      timer: null,
      resolve,
      reject,
      settled: false,
    };
    this.active = active;

    for (const click of schedule.clicks) {
      const beat = startBeat + click.beatOffset;
      const time = this.timeForBeat(active, beat);
      active.clicks.push({ beat, level: click.level, time, handle: this.host.scheduleClick(time, click.level) });
    }

    // bars = 0 (Off) resolves on the next timer turn so callers can always
    // await uniformly; capture is immediately at the current position.
    this.armCompletionTimer(active);

    return promise;
  }

  /**
   * Aborts the active count-in: every pending click is silenced now and the
   * waiting promise rejects with `CountInCancelledError`. Idempotent.
   */
  cancel(): void {
    const active = this.active;
    if (!active) return;
    const now = this.host.now();
    this.stopClicks(active.clicks, now);
    active.clicks = [];
    this.clearCompletionTimer(active);
    if (this.active === active) this.active = null;
    if (!active.settled) {
      active.settled = true;
      active.reject(new CountInCancelledError());
    }
  }

  /**
   * Tempo change: the musical plan is unchanged (same clicks, same capture
   * beat) but every not-yet-sounded click is re-timed from now at the new
   * tempo. Stale scheduled clicks are stopped first, so nothing double-sounds
   * and clicks that already sounded are never replayed.
   */
  retime(bpm: number): void {
    const active = this.active;
    if (!active || active.settled) return;
    const nextBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : active.bpm;
    const now = this.host.now();
    const elapsedBeats = Math.max(0, (now - active.startTime) * active.bpm / 60);
    const newStartBeat = active.startBeat + elapsedBeats;

    const { sounded, pending } = this.splitByNow(active, now);
    this.stopClicks(pending, now);

    active.bpm = nextBpm;
    active.startBeat = newStartBeat;
    active.startTime = now;
    active.captureBeat = active.captureBeat; // unchanged by design
    active.captureTime = now + beatsToSecondsAt(active.captureBeat - newStartBeat, nextBpm);
    active.clicks = sounded.concat(pending.map(click => this.rescheduleClick(active, click.beat, click.level)));
    this.armCompletionTimer(active);
  }

  /**
   * Meter / grouping change: "N bars" no longer describes the same musical
   * length, so the full count-in restarts under the new layout. The restart
   * snaps UP to the next bar line of the new meter (exactly like the initial
   * start), so capture lands on a bar of the new grid — a correct recording
   * offset instead of a mid-bar one. The waiting promise survives: the
   * recorder still starts exactly one count-in after the new start.
   */
  restart(layout: MeterPulseLayout): void {
    const active = this.active;
    if (!active || active.settled) return;
    const now = this.host.now();
    const elapsedBeats = Math.max(0, (now - active.startTime) * active.bpm / 60);
    const positionBeat = active.startBeat + elapsedBeats;
    // Snap up to the new meter's bar line; already-on-a-line positions stay.
    const barBeats = beatsPerBar(layout.meter);
    const newStartBeat = Math.ceil(positionBeat / barBeats - 1e-9) * barBeats;

    const { sounded, pending } = this.splitByNow(active, now);
    this.stopClicks(pending, now);

    const schedule = buildCountInSchedule({ bars: active.bars, layout, bpm: active.bpm });
    active.layout = layout;
    active.schedule = schedule;
    active.startBeat = newStartBeat;
    active.startTime = now + beatsToSecondsAt(newStartBeat - positionBeat, active.bpm) + active.leadSeconds;
    active.captureBeat = newStartBeat + schedule.durationBeats;
    active.captureTime = active.startTime + schedule.durationSeconds;
    // Clicks that already sounded stay sounded; the full new bar pattern is
    // scheduled fresh from the snapped restart point.
    active.clicks = sounded.concat(
      schedule.clicks.map(click => this.rescheduleClick(active, newStartBeat + click.beatOffset, click.level))
    );
    this.armCompletionTimer(active);
  }

  /**
   * Accent-grouping change (same meter): the bar grid did not move, so the
   * pending clicks keep their exact times and only their VOICES update to the
   * new accents. The capture moment and the recording offset are untouched —
   * an accent grouping never moves notes, clips or the record point.
   */
  regroup(layout: MeterPulseLayout): void {
    const active = this.active;
    if (!active || active.settled) return;
    const sameMeter = layout.meter[0] === active.layout.meter[0] && layout.meter[1] === active.layout.meter[1];
    if (!sameMeter) {
      this.restart(layout);
      return;
    }
    const now = this.host.now();
    const schedule = buildCountInSchedule({ bars: active.bars, layout, bpm: active.bpm });
    active.layout = layout;
    active.schedule = schedule;
    // The count-in's musical origin (capture is always origin + durationBeats).
    const originBeat = active.captureBeat - schedule.durationBeats;
    const { sounded, pending } = this.splitByNow(active, now);
    this.stopClicks(pending, now);
    active.clicks = sounded.concat(pending.map(click => {
      const match = schedule.clicks.find(c => Math.abs(originBeat + c.beatOffset - click.beat) < 1e-6);
      const level = match ? match.level : click.level;
      return { beat: click.beat, level, time: click.time, handle: this.host.scheduleClick(click.time, level) };
    }));
    // captureTime / captureBeat / completion timer unchanged.
  }

  private splitByNow(active: ActiveCountIn, now: number): { sounded: ScheduledClick[]; pending: ScheduledClick[] } {
    const sounded: ScheduledClick[] = [];
    const pending: ScheduledClick[] = [];
    for (const click of active.clicks) {
      if (click.time > now - 1e-9) pending.push(click);
      else sounded.push(click);
    }
    return { sounded, pending };
  }

  private stopClicks(clicks: ScheduledClick[], now: number): void {
    for (const click of clicks) {
      try { click.handle.stop(now); } catch (_) { /* already stopped */ }
      try { click.handle.disconnect(); } catch (_) { /* already disconnected */ }
    }
  }

  private rescheduleClick(active: ActiveCountIn, beat: MusicalBeats, level: PulseLevel): ScheduledClick {
    const time = this.timeForBeat(active, beat);
    return { beat, level, time, handle: this.host.scheduleClick(time, level) };
  }

  private armCompletionTimer(active: ActiveCountIn): void {
    // Re-arming (retime/restart) must clear the previous timer first — a stale
    // completion timer would resolve capture early at the wrong offset.
    this.clearCompletionTimer(active);
    const now = this.host.now();
    const delayMs = Math.max(0, (active.captureTime - now) * 1000);
    active.timer = this.host.setTimer(() => {
      if (this.active !== active || active.settled) return;
      active.settled = true;
      active.timer = null;
      if (this.active === active) this.active = null;
      active.resolve({
        schedule: active.schedule,
        startTime: active.startTime,
        captureTime: active.captureTime,
        captureBeat: active.captureBeat,
      });
    }, delayMs);
  }

  private clearCompletionTimer(active: ActiveCountIn): void {
    if (active.timer === null) return;
    this.host.clearTimer(active.timer);
    active.timer = null;
  }

  private timeForBeat(active: ActiveCountIn, beat: MusicalBeats): number {
    return active.startTime + beatsToSecondsAt(beat - active.startBeat, active.bpm);
  }
}
