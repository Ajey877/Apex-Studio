import { MixerRoute, MixerRouteValidation, MixerRoutingGraph } from './mixerRouting';

export interface MixerAudioNodePair {
  input: AudioNode;
  output: AudioNode;
  /**
   * Phase 64 — optional leaf that must stay fed by `output`.
   *
   * The mixer's post-fader metering analyser hangs off the channel output. A
   * routing rebuild has to clear the output's edges to drop stale routes, and
   * Web Audio's no-argument `disconnect()` clears *every* edge — so without
   * this the strip lost its meter tap on the first Play (or the first mixer
   * edit) and reported silence for the rest of the session while the channel
   * was audibly playing. Taps are leaves: reconnecting them never changes the
   * audible routing, and a tap that fails to reconnect is ignored rather than
   * allowed to break a route change.
   */
  meterTap?: AudioNode;
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

    const previousRoutes = this.graph.getRoutes();
    const validation = this.graph.setRoute(trackId, targetId);
    if (!validation.valid) return validation;

    try {
      this.rebuildLiveGraph();
      return validation;
    } catch (error) {
      this.restoreGraph(previousRoutes);
      throw error;
    }
  }

  syncRoutes(routes: MixerRoute[]): MixerRouteValidation {
    const nextGraph = new MixerRoutingGraph(this.masterTrackId);
    for (const route of routes) {
      if (route.trackId === this.masterTrackId) continue;
      if (!this.nodes.has(route.trackId) || !this.nodes.has(route.targetId)) {
        return { valid: false, reason: `Mixer route ${route.trackId} -> ${route.targetId} references an unregistered track.` };
      }
      const validation = nextGraph.setRoute(route.trackId, route.targetId);
      if (!validation.valid) return validation;
    }

    const previousGraph = this.graph;
    const previousAppliedRoutes = this.appliedRoutes.map(route => ({ ...route }));
    this.graph = nextGraph;
    try {
      this.rebuildLiveGraph();
      return { valid: true };
    } catch (error) {
      this.graph = previousGraph;
      this.appliedRoutes = previousAppliedRoutes;
      this.rebuildLiveGraph();
      throw error;
    }
  }

  removeRoute(trackId: number): void {
    if (!this.nodes.has(trackId) || trackId === this.masterTrackId) return;
    const previousRoutes = this.graph.getRoutes();
    this.graph.removeRoute(trackId);
    try {
      this.rebuildLiveGraph();
    } catch (error) {
      this.restoreGraph(previousRoutes);
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

    this.disconnectOutputs();
    this.restoreMeterTaps();

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
      this.disconnectOutputs();
      this.restoreMeterTaps();
      for (const route of previousRoutes) {
        if (route.trackId === this.masterTrackId) continue;
        const source = this.nodes.get(route.trackId);
        const target = this.nodes.get(route.targetId);
        if (source && target) source.output.connect(target.input);
      }
      throw error;
    }
  }

  /** Clears every edge out of a non-master channel output, ready for re-routing. */
  private disconnectOutputs(): void {
    for (const [trackId, pair] of this.nodes) {
      if (trackId === this.masterTrackId) continue;
      pair.output.disconnect();
    }
  }

  /**
   * Re-attaches the metering taps that `disconnectOutputs()` just cleared.
   *
   * A tap that cannot be re-attached must not abort a routing change: the
   * audible graph is what this method is not responsible for, and a throw here
   * would roll back a valid route edit. It is therefore best effort.
   */
  private restoreMeterTaps(): void {
    for (const pair of this.nodes.values()) {
      if (!pair.meterTap) continue;
      try {
        pair.output.connect(pair.meterTap);
      } catch {
        // A detached tap only costs metering accuracy for that strip.
      }
    }
  }

  private restoreGraph(routes: MixerRoute[]): void {
    this.graph = new MixerRoutingGraph(this.masterTrackId);
    for (const route of routes) {
      if (route.trackId === this.masterTrackId) continue;
      const result = this.graph.setRoute(route.trackId, route.targetId);
      if (!result.valid) throw new Error(`Unable to restore mixer routing: ${result.reason ?? 'unknown error'}`);
    }
    this.appliedRoutes = routes.map(route => ({ ...route }));
    this.rebuildLiveGraph();
  }
}
