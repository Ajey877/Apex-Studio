export interface AutomationPoint {
  /** Time in seconds relative to the automation start. */
  time: number;
  value: number;
}

export interface AutomationParam {
  cancelScheduledValues(startTime: number): void;
  setValueAtTime(value: number, startTime: number): void;
  linearRampToValueAtTime(value: number, endTime: number): void;
}

/**
 * Immutable, deterministic automation curve.
 * Points must have finite, non-negative times and strictly increasing timestamps.
 */
export class AutomationCurve {
  readonly points: readonly AutomationPoint[];

  constructor(points: readonly AutomationPoint[]) {
    if (points.length === 0) throw new Error('Automation requires at least one point.');

    const normalized = points.map(point => ({ time: point.time, value: point.value }));
    for (let index = 0; index < normalized.length; index += 1) {
      const point = normalized[index];
      if (!Number.isFinite(point.time) || point.time < 0) {
        throw new Error(`Automation point ${index} has an invalid time.`);
      }
      if (!Number.isFinite(point.value)) {
        throw new Error(`Automation point ${index} has an invalid value.`);
      }
      if (index > 0 && point.time <= normalized[index - 1].time) {
        throw new Error('Automation point times must be strictly increasing.');
      }
    }

    this.points = Object.freeze(normalized);
  }

  get duration(): number {
    return this.points[this.points.length - 1].time;
  }

  /** Linear interpolation between points, clamped to the curve ends. */
  valueAt(time: number): number {
    if (!Number.isFinite(time)) throw new Error('Automation sample time must be finite.');
    if (time <= this.points[0].time) return this.points[0].value;

    for (let index = 1; index < this.points.length; index += 1) {
      const next = this.points[index];
      const previous = this.points[index - 1];
      if (time <= next.time) {
        const span = next.time - previous.time;
        const progress = (time - previous.time) / span;
        return previous.value + (next.value - previous.value) * progress;
      }
    }

    return this.points[this.points.length - 1].value;
  }

  /** Replace the future schedule without disturbing audio before startTime. */
  schedule(param: AutomationParam, startTime: number): void {
    if (!Number.isFinite(startTime)) throw new Error('Automation start time must be finite.');

    param.cancelScheduledValues(startTime);
    const first = this.points[0];
    param.setValueAtTime(first.value, startTime + first.time);

    for (let index = 1; index < this.points.length; index += 1) {
      const point = this.points[index];
      param.linearRampToValueAtTime(point.value, startTime + point.time);
    }
  }
}

export function clampAutomationPoints(
  points: readonly AutomationPoint[],
  min: number,
  max: number,
): AutomationPoint[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    throw new Error('Invalid automation range.');
  }
  return points.map(point => ({
    time: point.time,
    value: Math.max(min, Math.min(max, point.value)),
  }));
}
