import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MixerRoutingGraph } from './mixerRouting';

describe('MixerRoutingGraph', () => {
  it('defaults every unassigned track to master', () => {
    const graph = new MixerRoutingGraph();
    assert.equal(graph.getRoute(4), 0);
  });

  it('accepts a bus route without creating a cycle', () => {
    const graph = new MixerRoutingGraph();
    assert.deepEqual(graph.setRoute(2, 8), { valid: true });
    assert.deepEqual(graph.setRoute(8, 0), { valid: true });
    assert.equal(graph.getRoute(2), 8);
  });

  it('rejects self-routing and preserves the previous route', () => {
    const graph = new MixerRoutingGraph();
    graph.setRoute(2, 8);
    const result = graph.setRoute(2, 2);
    assert.equal(result.valid, false);
    assert.equal(graph.getRoute(2), 8);
  });

  it('rejects multi-track cycles and rolls back the attempted route', () => {
    const graph = new MixerRoutingGraph();
    assert.equal(graph.setRoute(2, 8).valid, true);
    assert.equal(graph.setRoute(8, 5).valid, true);
    const result = graph.setRoute(5, 2);
    assert.equal(result.valid, false);
    assert.match(result.reason ?? '', /Routing cycle detected/);
    assert.equal(graph.getRoute(5), 0);
  });

  it('allows removing a non-master route', () => {
    const graph = new MixerRoutingGraph();
    graph.setRoute(3, 7);
    graph.removeRoute(3);
    assert.equal(graph.getRoute(3), 0);
  });
});
