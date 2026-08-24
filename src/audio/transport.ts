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

/** Audio-clock transport: musical position follows AudioContext time. */
export class AudioClockTransport {
  private readonly context: AudioContext;
  private readonly lookAheadSeconds: number;
  private readonly scheduleIntervalMs: number;
  private timerId: number | null = null;
  private nextEventTime = 0;
  private clockOrigin = 0;
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

  setCallbacks(callbacks: TransportCallbacks): void { this.callbacks = callbacks; }

  setBpm(bpm: number): void {
    if (!Number.isFinite(bpm) || bpm <= 0) return;
    this.updatePositionFromClock();
    this.state.bpm = Math.min(999, Math.max(20, bpm));
    this.updateMusicalPosition(this.state.positionSeconds);
    this.emitState();
  }

  setMode(mode: TransportMode): void { this.state.mode = mode; this.emitState(); }

  getState(): Readonly<TransportState> {
    this.updatePositionFromClock();
    return this.state;
  }

  start(): void {
    if (this.state.playing) return;
    const now = this.context.currentTime;
    this.clockOrigin = now - this.state.positionSeconds;
    this.nextEventTime = now;
    this.state.playing = true;
    this.schedule();
    this.emitState();
  }

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
    }
    this.emitState();
  }

  dispose(): void { this.stop(false); this.callbacks = {}; }

  private get stepDurationSeconds(): number { return 60 / this.state.bpm / this.state.stepsPerBeat; }
  private get stepsPerBar(): number { return this.state.beatsPerBar * this.state.stepsPerBeat; }

  private schedule = (): void => {
    if (!this.state.playing) return;
    const horizon = this.context.currentTime + this.lookAheadSeconds;
    while (this.nextEventTime <= horizon) {
      const position = Math.max(0, this.nextEventTime - this.clockOrigin);
      const absoluteStep = Math.floor(position / this.stepDurationSeconds + 1e-9);
      this.callbacks.onStep?.(
        absoluteStep % this.stepsPerBar,
        Math.floor(absoluteStep / this.stepsPerBar) + 1,
        this.nextEventTime,
      );
      this.nextEventTime += this.stepDurationSeconds;
    }
    this.updatePositionFromClock();
    this.emitState();
    this.timerId = window.setTimeout(this.schedule, this.scheduleIntervalMs);
  };

  private updatePositionFromClock(): void {
    if (!this.state.playing) return;
    const position = Math.max(0, this.context.currentTime - this.clockOrigin);
    this.state.positionSeconds = position;
    this.updateMusicalPosition(position);
  }

  private updateMusicalPosition(position: number): void {
    const absoluteStep = Math.floor(position / this.stepDurationSeconds + 1e-9);
    this.state.step = absoluteStep % this.stepsPerBar;
    this.state.bar = Math.floor(absoluteStep / this.stepsPerBar) + 1;
  }

  private emitState(): void { this.callbacks.onStateChange?.(this.state); }
}
