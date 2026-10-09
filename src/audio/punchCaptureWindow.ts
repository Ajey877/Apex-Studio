/**
 * Phase 1L — the punch-out stop moment.
 *
 * A punch take has a fixed musical length, so capture must STOP at a planned
 * audio-clock instant instead of waiting for the user to press Stop. This class
 * owns that single instant and nothing else: no audio nodes, no microphone, no
 * recorder, no second capture path. It is the mirror image of
 * `CountInScheduler`, which owns the pre-roll BEFORE capture; the capture
 * itself stays in `RecordingEngine`.
 *
 * Contract (verified by `phase1l.punchCaptureWindow.test.ts`):
 *   - `arm()` resolves exactly at `captureTime + durationBeats` of the active
 *     tempo, and only once;
 *   - `arm()` while a window is active THROWS — a double-pressed Record can
 *     never arm two stop moments for one take;
 *   - `retime()` (tempo change during the take) preserves the MUSICAL length:
 *     the remaining beats are re-measured at the new tempo from now, so a
 *     120 → 60 BPM change doubles the remaining wall-clock time instead of
 *     cutting the take short;
 *   - `cancel()` clears the timer and rejects with `PunchCancelledError`, so no
 *     stale timer can stop a later take or resolve a promise nobody awaits.
 */
import { beatsToSeconds, type MusicalBeats } from '../music/musicalTime';

/** The environment the window runs in: an audio clock and timer primitives. */
export interface PunchWindowHost {
  /** Audio-clock seconds. */
  now(): number;
  setTimer(fn: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export class PunchCancelledError extends Error {
  constructor(message = 'The punch recording was cancelled') {
    super(message);
    this.name = 'PunchCancelledError';
  }
}

export interface PunchWindowArmParams {
  /** Audio-clock moment capture began (the punch-in moment). */
  captureTime: number;
  /** Musical length of the capture window in quarter-note beats. */
  durationBeats: MusicalBeats;
  bpm: number;
}

export interface PunchWindowResult {
  /** Audio-clock moment capture must stop. */
  readonly stopTime: number;
  readonly durationBeats: MusicalBeats;
  readonly bpm: number;
}

interface ActiveWindow {
  captureTime: number;
  startTime: number;
  durationBeats: MusicalBeats;
  bpm: number;
  stopTime: number;
  timer: unknown;
  resolve: (result: PunchWindowResult) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

export class PunchCaptureWindow {
  private active: ActiveWindow | null = null;

  constructor(private readonly host: PunchWindowHost) {}

  get isActive(): boolean {
    return this.active !== null;
  }

  /** Audio-clock moment the armed take must stop at, or null. */
  get stopTime(): number | null {
    return this.active ? this.active.stopTime : null;
  }

  /** Musical length of the armed take in quarter beats, or null. */
  get durationBeats(): MusicalBeats | null {
    return this.active ? this.active.durationBeats : null;
  }

  /**
   * Arms the stop moment for one take and resolves exactly when capture must
   * stop. Throws synchronously when a window is already armed.
   */
  arm(params: PunchWindowArmParams): Promise<PunchWindowResult> {
    if (this.active) {
      throw new Error('A punch recording capture window is already armed');
    }
    // The window's musical length, in quarter beats. Not a note duration and
    // not a step-domain quantity: it is converted straight to seconds at the
    // project tempo below, which is the only unit a timer can be armed with.
    const windowBeats = Number.isFinite(params.durationBeats) && params.durationBeats > 0
      ? params.durationBeats
      : 0;
    const bpm = Number.isFinite(params.bpm) && params.bpm > 0 ? params.bpm : 120;
    const now = this.host.now();
    const captureTime = Number.isFinite(params.captureTime) ? params.captureTime : now;

    let resolve!: (result: PunchWindowResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<PunchWindowResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const active: ActiveWindow = {
      captureTime,
      startTime: now,
      durationBeats: windowBeats,
      bpm,
      stopTime: captureTime + beatsToSeconds(windowBeats, bpm),
      timer: null,
      resolve,
      reject,
      settled: false,
    };
    this.active = active;
    this.armTimer(active);
    return promise;
  }

  /**
   * Tempo change during the take: the musical length of the punch window is
   * preserved, so the remaining beats are re-measured at the new tempo from
   * now. The punch-in moment never moves — audio already captured stays where
   * it was recorded.
   */
  retime(bpm: number): void {
    const active = this.active;
    if (!active || active.settled) return;
    const nextBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : active.bpm;
    const now = this.host.now();
    const elapsedBeats = Math.max(0, (now - active.startTime) * active.bpm / 60);
    const remainingBeats = Math.max(0, active.durationBeats - elapsedBeats);
    active.bpm = nextBpm;
    active.startTime = now;
    active.durationBeats = remainingBeats;
    active.stopTime = now + beatsToSeconds(remainingBeats, nextBpm);
    this.armTimer(active);
  }

  /** Aborts the armed take: the timer is cleared and the promise rejects. */
  cancel(): void {
    const active = this.active;
    if (!active) return;
    this.clearTimer(active);
    if (this.active === active) this.active = null;
    if (!active.settled) {
      active.settled = true;
      active.reject(new PunchCancelledError());
    }
  }

  private armTimer(active: ActiveWindow): void {
    // Re-arming after a retime must clear the previous timer: a stale stop
    // timer would end the take at the old tempo's moment.
    this.clearTimer(active);
    const now = this.host.now();
    const delayMs = Math.max(0, (active.stopTime - now) * 1000);
    active.timer = this.host.setTimer(() => {
      if (this.active !== active || active.settled) return;
      active.settled = true;
      active.timer = null;
      if (this.active === active) this.active = null;
      active.resolve({
        stopTime: active.stopTime,
        durationBeats: active.durationBeats,
        bpm: active.bpm,
      });
    }, delayMs);
  }

  private clearTimer(active: ActiveWindow): void {
    if (active.timer === null) return;
    this.host.clearTimer(active.timer);
    active.timer = null;
  }
}
