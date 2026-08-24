import { MixerRoute, MixerRouteValidation, MixerRoutingGraph } from './mixerRouting';

export interface MixerAudioNodePair {
  input: AudioNode;
  output: AudioNode;
}

/**
 * Applies the pure mixer routing rules to the live Web Audio graph.
 * Routing is rebuilt as one deterministic operation so stale connections
 * cannot survive a route change and invalid routes never reach the graph.
 */
export class MixerRoutingAdapter {
  private graph: MixerRoutingGraph;
  private readonly nodes: Map<number, MixerAudioNodePair>;
  private readonly masterTrackId: number;
  private appliedRoutes: MixerRoute[] = [];

  constructor(nodes: Map<number, MixerAudioNodePair>, masterTrackId = 0) {
    if (!nodes.has(masterTrackId)) {
      throw new Error(`Mixer master track ${masterTrackId} is not registered.`);
    }
    this.nodes = nodes;
    this.masterTrackId = masterTrackId;
    this.graph = new MixerRoutingGraph(masterTrackId);
  }

  setRoute(trackId: number, targetId: number): MixerRouteValidation {
    const source = this.nodes.get(trackId);
    const target = this.nodes.get(targetId);
    if (!source || !target) {
      return { valid: false, reason: 'Both mixer source and target tracks must be registered.' };
    }

    const previousGraph = this.graph;
    const previousRoutes = this.appliedRoutes.map(route => ({ ...route }));
    const validation = this.graph.setRoute(trackId, targetId);
    if (!validation.valid) return validation;

    try {
      this.rebuildLiveGraph();
      return validation;
    } catch (error) {
      this.graph = previousGraph;
      this.appliedRoutes = previousRoutes;
      try {
        this.rebuildLiveGraph();
      } catch {
        // Preserve the original failure. A failed AudioNode connection is
        // surfaced to the caller rather than hidden behind a second error.
      }
      throw error;
    }
  }

  removeRoute(trackId: number): void {
    if (!this.nodes.has(trackId) || trackId === this.masterTrackId) return;
    const previousGraph = this.graph;
    const previousRoutes = this.appliedRoutes.map(route => ({ ...route }));
    this.graph.removeRoute(trackId);

    try {
      this.rebuildLiveGraph();
    } catch (error) {
      this.graph = previousGraph;
      this.appliedRoutes = previousRoutes;
      try {
        this.rebuildLiveGraph();
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  sync(): void {
    this.rebuildLiveGraph();
  }

  getRoutes(): MixerRoute[] {
    return this.graph.getRoutes();
  }

  getRoute(trackId: number): number {
    return this.graph.getRoute(trackId);
  }

  private rebuildLiveGraph(): void {
    const routes = this.graph.getRoutes();
    const previousRoutes = this.appliedRoutes.map(route => ({ ...route }));

    for (const pair of this.nodes.values()) {
      pair.output.disconnect();
    }

    try {
      for (const route of routes) {
        if (route.trackId === this.masterTrackId) continue;
        const source = this.nodes.get(route.trackId);
        const target = this.nodes.get(route.targetId);
        if (!source || !target) {
          throw new Error(`Mixer route ${route.trackId} -> ${route.targetId} references an unregistered track.`);
        }
        source.output.connect(target.input);
      }
      this.appliedRoutes = routes.map(route => ({ ...route }));
    } catch (error) {
      for (const pair of this.nodes.values()) {
        pair.output.disconnect();
      }
      for (const route of previousRoutes) {
        if (route.trackId === this.masterTrackId) continue;
        const source = this.nodes.get(route.trackId);
        const target = this.nodes.get(route.targetId);
        if (source && target) source.output.connect(target.input);
      }
      throw error;
    }
  }
}
