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
}

/**
 * Audio-clock scheduler foundation.
 * JavaScript timers only wake the scheduler; musical events are timestamped
 * against AudioContext.currentTime so callback jitter does not move the event.
 */
export class AudioClockTransport {
  private readonly context: AudioContext;
  private readonly lookAheadSeconds: number;
  private readonly scheduleIntervalMs: number;
  private timerId: number | null = null;
  private nextEventTime = 0;
  private state: TransportState = {
    bpm: 120,
    beatsPerBar: 4,
    stepsPerBeat: 4,
    mode: 'pat',
    playing: false,
    positionSeconds: 0,
    step: 0,
    bar: 1,
  };
  private callbacks: TransportCallbacks = {};

  constructor(context: AudioContext, options: { lookAheadSeconds?: number; scheduleIntervalMs?: number } = {}) {
    this.context = context;
    this.lookAheadSeconds = Math.max(0.025, options.lookAheadSeconds ?? 0.1);
    this.scheduleIntervalMs = Math.max(10, options.scheduleIntervalMs ?? 25);
  }

  setCallbacks(callbacks: TransportCallbacks): void {
    this.callbacks = callbacks;
  }

  setBpm(bpm: number): void {
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    this.state.bpm = Math.min(999, Math.max(20, bpm));
  }

  setMode(mode: TransportMode): void {
    this.state.mode = mode;
  }

  getState(): Readonly<TransportState> {
    return this.state;
  }

  start(): void {
    if (this.state.playing) return;
    const now = this.context.currentTime;
    this.state.playing = true;
    this.nextEventTime = Math.max(now, this.state.positionSeconds + now);
    this.schedule();
    this.emitState();
  }

  stop(resetPosition = true): void {
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
    const stepDuration = this.stepDurationSeconds;
    const absoluteStep = Math.floor(next / stepDuration);
    this.state.step = absoluteStep % this.stepsPerBar;
    this.state.bar = Math.floor(absoluteStep / this.stepsPerBar) + 1;
    if (this.state.playing) {
      this.nextEventTime = this.context.currentTime + 0.005;
    }
    this.emitState();
  }

  dispose(): void {
    this.stop(false);
    this.callbacks = {};
  }

  private get stepDurationSeconds(): number {
    return 60 / this.state.bpm / this.state.stepsPerBeat;
  }

  private get stepsPerBar(): number {
    return this.state.beatsPerBar * this.state.stepsPerBeat;
  }

  private schedule = (): void => {
    if (!this.state.playing) return;

    const horizon = this.context.currentTime + this.lookAheadSeconds;
    while (this.nextEventTime < horizon) {
      const relative = this.nextEventTime - this.context.currentTime;
      const absoluteStep = Math.max(0, Math.floor(this.state.positionSeconds / this.stepDurationSeconds));
      const step = absoluteStep % this.stepsPerBar;
      const bar = Math.floor(absoluteStep / this.stepsPerBar) + 1;

      this.state.step = step;
      this.state.bar = bar;
      this.callbacks.onStep?.(step, bar, this.nextEventTime);

      this.nextEventTime += this.stepDurationSeconds;
      this.state.positionSeconds += this.stepDurationSeconds;

      // Keep unused variable from becoming a misleading timing source.
      void relative;
    }

    this.emitState();
    this.timerId = window.setTimeout(this.schedule, this.scheduleIntervalMs);
  };

  private emitState(): void {
    this.callbacks.onStateChange?.(this.state);
  }
}
