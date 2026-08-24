export interface MixerRoute {
  trackId: number;
  targetId: number;
}

export interface MixerRouteValidation {
  valid: boolean;
  reason?: string;
}

/**
 * Pure mixer routing rules used by the real-time audio graph.
 * A track may route to itself only by mistake; cycles are never allowed.
 */
export class MixerRoutingGraph {
  private readonly routes = new Map<number, number>();

  constructor(masterTrackId = 0) {
    this.routes.set(masterTrackId, masterTrackId);
  }

  setRoute(trackId: number, targetId: number): MixerRouteValidation {
    if (!Number.isInteger(trackId) || !Number.isInteger(targetId)) {
      return { valid: false, reason: 'Mixer track IDs must be integers.' };
    }
    if (trackId < 0 || targetId < 0) {
      return { valid: false, reason: 'Mixer track IDs cannot be negative.' };
    }
    if (trackId === targetId) {
      return { valid: false, reason: 'A mixer track cannot route to itself.' };
    }

    const previous = this.routes.get(trackId);
    this.routes.set(trackId, targetId);
    const cycle = this.findCycleFrom(trackId);
    if (cycle) {
      if (previous === undefined) this.routes.delete(trackId);
      else this.routes.set(trackId, previous);
      return { valid: false, reason: `Routing cycle detected: ${cycle.join(' -> ')}.` };
    }
    return { valid: true };
  }

  getRoute(trackId: number): number {
    return this.routes.get(trackId) ?? 0;
  }

  removeRoute(trackId: number): void {
    if (trackId !== 0) this.routes.delete(trackId);
  }

  getRoutes(): MixerRoute[] {
    return [...this.routes.entries()].map(([trackId, targetId]) => ({ trackId, targetId }));
  }

  private findCycleFrom(start: number): number[] | null {
    const path: number[] = [];
    const visited = new Set<number>();
    let current = start;

    while (true) {
      if (visited.has(current)) {
        const index = path.indexOf(current);
        return [...path.slice(index), current];
      }
      visited.add(current);
      path.push(current);

      const next = this.routes.get(current);
      if (next === undefined || next === 0) return null;
      current = next;
    }
  }
}
