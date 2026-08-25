import { AutomationCurve, type AutomationParam } from '../parameterAutomation';
import { AutomationLane } from './AutomationLane';

export type AutomationBinding = {
  laneId: string;
  targetId: string;
};

type BoundLane = {
  lane: AutomationLane;
  target: AutomationParam;
  targetId: string;
};

/**
 * Coordinates automation lanes and their AudioParam targets.
 * Each lane has one target and each target can have one lane.
 */
export class AutomationController {
  private readonly lanes = new Map<string, BoundLane>();
  private readonly targets = new Map<string, string>();

  addLane(
    lane: AutomationLane,
    targetId: string,
    target: AutomationParam,
  ): void {
    if (!targetId.trim()) {
      throw new Error('Automation target id must not be empty.');
    }

    if (this.lanes.has(lane.id)) {
      throw new Error(`Automation lane "${lane.id}" already exists.`);
    }

    if (this.targets.has(targetId)) {
      throw new Error(`Automation target "${targetId}" is already bound.`);
    }

    this.lanes.set(lane.id, {
      lane,
      target,
      targetId,
    });

    this.targets.set(targetId, lane.id);
  }

  replaceLane(lane: AutomationLane): void {
    const existing = this.lanes.get(lane.id);

    if (!existing) {
      throw new Error(`Automation lane "${lane.id}" does not exist.`);
    }

    this.lanes.set(lane.id, {
      ...existing,
      lane,
    });
  }

  removeLane(laneId: string): boolean {
    const existing = this.lanes.get(laneId);

    if (!existing) {
      return false;
    }

    this.lanes.delete(laneId);
    this.targets.delete(existing.targetId);

    return true;
  }

  getLane(laneId: string): AutomationLane | undefined {
    return this.lanes.get(laneId)?.lane;
  }

  getBindings(): readonly AutomationBinding[] {
    return [...this.lanes.entries()]
      .map(([laneId, binding]) => ({
        laneId,
        targetId: binding.targetId,
      }))
      .sort((a, b) => a.laneId.localeCompare(b.laneId));
  }

  schedule(startTime: number): void {
    if (!Number.isFinite(startTime)) {
      throw new Error('Automation start time must be finite.');
    }

    const bindings = [...this.lanes.values()]
      .sort((a, b) => a.lane.id.localeCompare(b.lane.id));

    for (const binding of bindings) {
      const points = binding.lane.getPoints();

      if (points.length === 0) {
        binding.target.cancelScheduledValues(startTime);
        binding.target.setValueAtTime(
          binding.lane.defaultValue,
          startTime,
        );
        continue;
      }

      new AutomationCurve(points).schedule(
        binding.target,
        startTime,
      );
    }
  }

  clear(startTime: number): void {
    if (!Number.isFinite(startTime)) {
      throw new Error('Automation start time must be finite.');
    }

    for (const binding of this.lanes.values()) {
      binding.target.cancelScheduledValues(startTime);
      binding.target.setValueAtTime(
        binding.lane.defaultValue,
        startTime,
      );
    }
  }

  get size(): number {
    return this.lanes.size;
  }
}