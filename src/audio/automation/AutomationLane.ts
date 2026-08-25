export type AutomationPoint = { time: number; value: number };

export type AutomationLaneOptions = {
  id: string;
  min?: number;
  max?: number;
  defaultValue?: number;
};

/** Deterministic, immutable automation lane with normalized point ordering. */
export class AutomationLane {
  readonly id: string;
  readonly min: number;
  readonly max: number;
  readonly defaultValue: number;
  private readonly points: readonly AutomationPoint[];

  constructor(options: AutomationLaneOptions, points: readonly AutomationPoint[] = []) {
    if (!options.id.trim()) throw new Error('Automation lane id must not be empty');
    const min = options.min ?? 0;
    const max = options.max ?? 1;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new Error('Automation lane range is invalid');
    }
    const defaultValue = options.defaultValue ?? min;
    if (!Number.isFinite(defaultValue) || defaultValue < min || defaultValue > max) {
      throw new Error('Automation lane default value is out of range');
    }
    this.id = options.id;
    this.min = min;
    this.max = max;
    this.defaultValue = defaultValue;
    this.points = AutomationLane.normalize(points, min, max);
  }

  getPoints(): readonly AutomationPoint[] {
    return this.points.map((point) => ({ ...point }));
  }

  withPoints(points: readonly AutomationPoint[]): AutomationLane {
    return new AutomationLane(this, points);
  }

  valueAt(time: number): number {
    if (!Number.isFinite(time)) throw new Error('Automation time must be finite');
    if (this.points.length === 0) return this.defaultValue;
    if (time <= this.points[0].time) return this.points[0].value;
    const last = this.points[this.points.length - 1];
    if (time >= last.time) return last.value;
    for (let index = 1; index < this.points.length; index += 1) {
      const right = this.points[index];
      const left = this.points[index - 1];
      if (time <= right.time) {
        const span = right.time - left.time;
        if (span <= 0) return right.value;
        const progress = (time - left.time) / span;
        return left.value + (right.value - left.value) * progress;
      }
    }
    return last.value;
  }

  private static normalize(points: readonly AutomationPoint[], min: number, max: number): AutomationPoint[] {
    const normalized = points.map((point) => {
      if (!Number.isFinite(point.time) || point.time < 0) throw new Error('Automation point time must be finite and non-negative');
      if (!Number.isFinite(point.value)) throw new Error('Automation point value must be finite');
      return { time: point.time, value: Math.min(max, Math.max(min, point.value)) };
    });
    normalized.sort((a, b) => a.time - b.time);
    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index].time === normalized[index - 1].time) {
        normalized.splice(index - 1, 1);
        index -= 1;
      }
    }
    return normalized;
  }
}
