import { beatsPerBar, beatsToSeconds, stepsPerBar, LEGACY_TIME_SIGNATURE, resolveProjectTimeSignature, SIXTEENTH_STEPS_PER_BEAT, type TimeSignature } from '../music/musicalTime';
export type TransportMode = 'pat' | 'song';

export interface TransportState {
  bpm: number;
  beatsPerBar: number;
  stepsPerBeat: number;
  mode: TransportMode;
  playing: boolean;
  positionSeconds: number;
  step: number;
  bar: number;
}

export interface TransportCallbacks {
  onStep?: (step: number, bar: number, audioTime: number) => void;
  onStateChange?: (state: Readonly<TransportState>) => void;
  /** Fired once when Song Mode reaches the end of the arrangement. */
  onSongEnd?: () => void;
}

/**
 * Scheduling lead applied when the transport starts, so the first step of a take
 * reaches the audio thread with the same safety margin every later step already
 * gets. Without it `start()` scheduled step 0 at `ctx.currentTime` itself — zero
 * look-ahead — and the audio thread had already passed that instant by the time
 * the step's nodes were created, so the first step of every take sounded late
 * (Stage A measured 0.11 ms – 8.48 ms of lateness in the production play path,
 * while every step scheduled inside the look-ahead window was exact).
 *
 * 0.03 s matches `DEFAULT_LEAD_SECONDS` in `countInScheduler.ts`, which solves
 * the identical problem ("so the first click never lands in the past") for
 * count-in clicks.
 */
export const START_LEAD_SECONDS = 0.03;

/** Audio-clock transport: musical position follows AudioContext time. */
export class AudioClockTransport {
  private readonly context: AudioContext;
  private readonly lookAheadSeconds: number;
  private readonly scheduleIntervalMs: number;
  /** Start lead, clamped so it can never fall outside the look-ahead window. */
  private readonly startLeadSeconds: number;
  private timerId: number | null = null;
  private nextEventTime = 0;
  /** Absolute musical step assigned to the next scheduled event. */
  private nextAbsoluteStep = 0;
  private clockOrigin = 0;
  private state: TransportState = {
    bpm: 120,
    beatsPerBar: beatsPerBar(LEGACY_TIME_SIGNATURE),
    stepsPerBeat: SIXTEENTH_STEPS_PER_BEAT,
    mode: 'pat',
    playing: false,
    positionSeconds: 0,
    step: 0,
    bar: 1,
  };
  private callbacks: TransportCallbacks = {};
  private patternLoopSteps: number | null = null;
  /** First absolute step index at which Song Mode stops; null loops forever. */
  private songEndSteps: number | null = null;
  /**
   * Phase 1F/1I — the resolved project meter. It determines the bar grid the
   * step counter is mapped onto (bar numbers and quarter-note beat count); the
   * step duration itself stays a sixteenth note at the transport tempo.
   * Defaults to the legacy 4/4 grid so an unconfigured transport keeps its old behavior.
   */
  private meter: TimeSignature = LEGACY_TIME_SIGNATURE;

  constructor(context: AudioContext, options: { lookAheadSeconds?: number; scheduleIntervalMs?: number } = {}) {
    this.context = context;
    this.lookAheadSeconds = Math.max(0.025, options.lookAheadSeconds ?? 0.1);
    this.scheduleIntervalMs = Math.max(10, options.scheduleIntervalMs ?? 25);
    // `start()` schedules synchronously, so a lead at or beyond the look-ahead
    // horizon would defer step 0 to the next timer tick instead of emitting it
    // immediately. Keeping the lead strictly inside the window preserves that
    // existing contract for any configured look-ahead, including the 25 ms floor.
    this.startLeadSeconds = Math.min(START_LEAD_SECONDS, this.lookAheadSeconds * 0.5);
  }

  setCallbacks(callbacks: TransportCallbacks): void { this.callbacks = callbacks; }

  /**
   * Phase 1J correction: a tempo change preserves the MUSICAL position (the
   * continuous step/beat count), not the elapsed seconds. Previously the
   * seconds were kept and re-divided by the new step length, so a 120 → 60 BPM
   * change at step 12 jumped back to step 6 and steps 6–11 were scheduled a
   * second time (duplicate notes and metronome clicks); speeding up skipped
   * steps instead. Now the clock origin is re-anchored so the step already
   * reached stays reached, and the next unscheduled step keeps its index and is
   * placed on the new tempo's grid. Steps already handed out inside the
   * look-ahead window keep their old-tempo times; the new tempo applies from the
   * first step not yet scheduled, never earlier than the last scheduled one.
   */
  setBpm(bpm: number): void {
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    this.updatePositionFromClock();
    const previousStepSeconds = this.stepDurationSeconds;
    const positionSteps = this.state.positionSeconds / previousStepSeconds;
    const lastScheduledTime = this.nextEventTime - previousStepSeconds;
    this.state.bpm = Math.min(999, Math.max(20, bpm));
    const nextStepSeconds = this.stepDurationSeconds;
    this.state.positionSeconds = positionSteps * nextStepSeconds;
    if (this.state.playing) {
      this.clockOrigin = this.context.currentTime - this.state.positionSeconds;
      // Already-scheduled look-ahead events keep their original audio times.
      // Continue the unscheduled musical grid one new-tempo step after the
      // last committed event, rather than preserving the old time-derived
      // offset (which can shift the next event and its step index).
      this.nextEventTime = Math.max(
        lastScheduledTime + nextStepSeconds,
        this.context.currentTime + 1e-6,
      );
    }
    this.updateMusicalPosition(this.state.positionSeconds);
    this.emitState();
  }

  /**
   * Phase 1F/1I — publish the resolved project meter. The bar grid remaps the
   * current absolute step position (12 steps in 3/4, 14 in 7/8), so the
   * reported bar/beat stay truthful through the change; unsupported values
   * resolve to the legacy 4/4 grid.
   */
  setTimeSignature(meter: TimeSignature): void {
    const resolved = resolveProjectTimeSignature({ timeSignature: meter });
    if (resolved[0] === this.meter[0] && resolved[1] === this.meter[1]) return;
    this.updatePositionFromClock();
    this.meter = resolved;
    this.state.beatsPerBar = beatsPerBar(resolved);
    this.updateMusicalPosition(this.state.positionSeconds);
    this.emitState();
  }

  setMode(mode: TransportMode): void { this.state.mode = mode; this.emitState(); }

  /**
   * Song Mode owns its real end: the absolute step index at which no more
   * musical content is scheduled. `null` (the Pattern Mode default) keeps the
   * grid looping forever. Changing the value while playing takes effect at the
   * next scheduling tick, so a live edit that shortens the arrangement stops
   * the transport at the new end.
   */
  setSongEndSteps(steps?: number): void {
    this.songEndSteps = typeof steps === 'number' && Number.isFinite(steps) && steps > 0
      ? Math.max(1, Math.floor(steps))
      : null;
  }

  /**
   * Pattern Mode loops over the length of the pattern being played instead of a
   * fixed bar. Clearing it falls back to the bar grid. Song Mode always uses the
   * bar grid because playlist scheduling is bar-relative.
   */
  setPatternLoopSteps(steps?: number): void {
    const next = typeof steps === 'number' && Number.isFinite(steps) && steps > 0
      ? Math.max(1, Math.floor(steps))
      : null;
    if (next === this.patternLoopSteps) return;
    // The wrap length only changes how the continuous step counter is reported,
    // so musical position and scheduling stay intact.
    this.updatePositionFromClock();
    this.patternLoopSteps = next;
    this.updateMusicalPosition(this.state.positionSeconds);
    this.emitState();
  }

  getState(): Readonly<TransportState> {
    this.updatePositionFromClock();
    return this.state;
  }

  start(): void {
    if (this.state.playing) return;
    const now = this.context.currentTime;
    // Anchoring the clock origin and the first event time by the SAME lead keeps
    // `nextEventTime - clockOrigin === positionSeconds`, so the reported position
    // (currentTime - clockOrigin) and the event grid stay in lockstep — the
    // take's timeline simply begins one lead later instead of drifting.
    //
    // Step identity is owned by the separate `nextAbsoluteStep` counter, which is
    // seeded from the start position and is independent of the lead, so the lead
    // cannot skip, duplicate or mis-number a step. Shifting only `nextEventTime`
    // (leaving `clockOrigin = now - position`) is what would have been unsafe: it
    // advances the derived position by a full lead and starts on the wrong step.
    //
    // The lead stays strictly inside the look-ahead window (see the constructor)
    // so `schedule()` still emits step 0 inside `start()` rather than deferring
    // it to the next timer tick.
    //
    // The reported position therefore trails the start position by exactly one
    // lead until the first step sounds; from that instant onward position and
    // audio stay in lockstep as before.
    this.clockOrigin = now + this.startLeadSeconds - this.state.positionSeconds;
    this.nextEventTime = now + this.startLeadSeconds;
    this.nextAbsoluteStep = Math.floor(this.state.positionSeconds / this.stepDurationSeconds + 1e-9);
    this.state.playing = true;
    this.schedule();
    this.emitState();
  }

  /**
   * Pauses playback at the current clock position. Unlike `stop()`, the
   * position (seconds, bar, step) is preserved so a following `start()`
   * resumes exactly where the music stopped.
   */
  pause(): void { this.stop(false); }

  stop(resetPosition = true): void {
    this.updatePositionFromClock();
    this.state.playing = false;
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
    if (resetPosition) {
      this.state.positionSeconds = 0;
      this.state.step = 0;
      this.state.bar = 1;
    }
    this.emitState();
  }

  seek(positionSeconds: number): void {
    const next = Math.max(0, Number.isFinite(positionSeconds) ? positionSeconds : 0);
    this.state.positionSeconds = next;
    this.updateMusicalPosition(next);
    if (this.state.playing) {
      this.clockOrigin = this.context.currentTime - next;
      this.nextEventTime = this.context.currentTime + 0.005;
      this.nextAbsoluteStep = Math.floor(next / this.stepDurationSeconds + 1e-9);
    }
    this.emitState();
  }

  dispose(): void { this.stop(false); this.callbacks = {}; }

  private get stepDurationSeconds(): number { return beatsToSeconds(1, this.state.bpm) / this.state.stepsPerBeat; }
  private get stepsPerBar(): number { return stepsPerBar(this.meter); }
  /** Number of steps the reported musical position wraps at. */
  private get stepLoopLength(): number {
    return this.state.mode === 'pat' && this.patternLoopSteps !== null
      ? this.patternLoopSteps
      : this.stepsPerBar;
  }

  private schedule = (): void => {
    if (!this.state.playing) return;
    const horizon = this.context.currentTime + this.lookAheadSeconds;
    while (this.nextEventTime <= horizon) {
      const absoluteStep = this.nextAbsoluteStep;
      if (this.songEndSteps !== null && absoluteStep >= this.songEndSteps) {
        this.finishAtSongEnd();
        return;
      }
      this.callbacks.onStep?.(
        absoluteStep % this.stepLoopLength,
        Math.floor(absoluteStep / this.stepsPerBar) + 1,
        this.nextEventTime,
      );
      this.nextEventTime += this.stepDurationSeconds;
      this.nextAbsoluteStep += 1;
    }
    this.updatePositionFromClock();
    this.emitState();
    this.timerId = window.setTimeout(this.schedule, this.scheduleIntervalMs);
  };

  /**
   * Song Mode reached its real end: halt exactly on the end position instead
   * of wrapping. The last audible step is `songEndSteps - 1`; the reported
   * position is the first silent position after the arrangement.
   */
  private finishAtSongEnd(): void {
    this.state.playing = false;
    if (this.timerId !== null) {
      window.clearTimeout(this.timerId);
      this.timerId = null;
    }
    const endPositionSeconds = this.songEndSteps * this.stepDurationSeconds;
    this.state.positionSeconds = endPositionSeconds;
    this.updateMusicalPosition(endPositionSeconds);
    this.callbacks.onSongEnd?.();
    this.emitState();
  }

  private updatePositionFromClock(): void {
    if (!this.state.playing) return;
    const position = Math.max(0, this.context.currentTime - this.clockOrigin);
    this.state.positionSeconds = position;
    this.updateMusicalPosition(position);
  }

  private updateMusicalPosition(position: number): void {
    const absoluteStep = Math.floor(position / this.stepDurationSeconds + 1e-9);
    this.state.step = absoluteStep % this.stepLoopLength;
    this.state.bar = Math.floor(absoluteStep / this.stepsPerBar) + 1;
  }

  private emitState(): void { this.callbacks.onStateChange?.(this.state); }
}
