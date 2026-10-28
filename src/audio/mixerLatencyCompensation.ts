export interface MixerLatencyRoute {
  trackId: number;
  targetId: number;
}

export interface MixerLatencyEdge {
  id: string;
  sourceTrackId: number;
  targetTrackId: number;
}

export interface MixerLatencyCompensation {
  /** Delay inserted on each channel's direct producer input before it joins routed audio. */
  directInputDelayFrames: Map<number, number>;
  /** Delay inserted on each mixer-route/aux-send edge before its destination sum. */
  routeDelayFrames: Map<string, number>;
  /** End-to-end fixed live pipeline latency at each channel output. */
  outputLatencyFrames: Map<number, number>;
}

/**
 * Aligns every branch at every mixer summing input, not just the final master
 * output. A channel's direct source path and each routed child path are delayed
 * to the slowest arrival before that channel's own native inserts are applied.
 * This composes through nested mixer buses and preserves project-relative frame
 * positions without adding any latency to the native effect runtime itself.
 */
export function computeMixerLatencyCompensation(
  trackIds: Iterable<number>,
  routes: readonly MixerLatencyEdge[],
  pipelineFramesForTrack: (trackId: number) => number,
): MixerLatencyCompensation {
  const known = new Set(trackIds);
  const incoming = new Map<number, MixerLatencyEdge[]>();
  for (const route of routes) {
    if (!known.has(route.sourceTrackId) || !known.has(route.targetTrackId)) {
      throw new Error(`Mixer latency route ${route.sourceTrackId} -> ${route.targetTrackId} references an unknown track.`);
    }
    if (!Number.isInteger(route.sourceTrackId) || !Number.isInteger(route.targetTrackId) || route.sourceTrackId === route.targetTrackId) {
      throw new Error('Mixer latency routes must connect distinct integer track IDs.');
    }
    const list = incoming.get(route.targetTrackId) ?? [];
    list.push(route);
    incoming.set(route.targetTrackId, list);
  }

  const directInputDelayFrames = new Map<number, number>();
  const routeDelayFrames = new Map<string, number>();
  const outputLatencyFrames = new Map<number, number>();
  const visiting = new Set<number>();

  const visit = (trackId: number): number => {
    const cached = outputLatencyFrames.get(trackId);
    if (cached !== undefined) return cached;
    if (visiting.has(trackId)) throw new Error('Mixer latency compensation requires an acyclic routing graph.');
    visiting.add(trackId);
    const edges = incoming.get(trackId) ?? [];
    const arrivals = edges.map(edge => ({ edge, frames: visit(edge.sourceTrackId) }));
    const alignedInputFrames = Math.max(0, ...arrivals.map(arrival => arrival.frames));
    directInputDelayFrames.set(trackId, alignedInputFrames);
    for (const { edge, frames } of arrivals) {
      routeDelayFrames.set(edge.id, alignedInputFrames - frames);
    }
    const ownPipelineFrames = pipelineFramesForTrack(trackId);
    if (!Number.isSafeInteger(ownPipelineFrames) || ownPipelineFrames < 0) {
      throw new Error(`Mixer track ${trackId} has an invalid native pipeline latency budget.`);
    }
    const outputFrames = alignedInputFrames + ownPipelineFrames;
    if (!Number.isSafeInteger(outputFrames)) throw new Error(`Mixer track ${trackId} latency exceeds the supported frame range.`);
    outputLatencyFrames.set(trackId, outputFrames);
    visiting.delete(trackId);
    return outputFrames;
  };

  for (const trackId of known) visit(trackId);
  return { directInputDelayFrames, routeDelayFrames, outputLatencyFrames };
}
