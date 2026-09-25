import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyMixerRoutingSelection } from './Mixer';
import { MixerRoutingAdapter } from '../audio/mixerRoutingAdapter';
import { MixerRoutingGraph } from '../audio/mixerRouting';
import { createDefaultProjectState, deleteChannelFromProjectState } from '../state/projectState';
import { serializeProjectState } from '../state/projectPersistence';
import { updateMixerTrackInProjectState } from '../state/projectMutations';
import { createHistory } from '../state/projectHistory';

describe('Phase 28B mixer routing UI flow', () => {
  it('UI route selection updates routingTargetId through the existing mutation path', () => {
    const project = createDefaultProjectState();
    const source = project.mixerTracks.find(track => track.id === 1)!;
    const destination = project.mixerTracks.find(track => track.id === 2)!;
    let next = project;

    const changed = applyMixerRoutingSelection(
      project.mixerTracks,
      source.id,
      destination.id,
      (trackId, updates) => {
        next = updateMixerTrackInProjectState(next, trackId, updates);
      },
    );

    assert.equal(changed, true);
    assert.equal(next.mixerTracks.find(track => track.id === source.id)?.routingTargetId, destination.id);
  });

  it('a valid route change reaches the live routing graph', () => {
    class FakeNode {
      connections: FakeNode[] = [];
      connect(target: FakeNode) { this.connections.push(target); }
      disconnect() { this.connections = []; }
    }

    const nodes = new Map<number, { input: AudioNode; output: AudioNode }>();
    const masterInput = new FakeNode();
    const sourceOutput = new FakeNode();
    nodes.set(0, { input: masterInput as unknown as AudioNode, output: new FakeNode() as unknown as AudioNode });
    nodes.set(1, { input: new FakeNode() as unknown as AudioNode, output: sourceOutput as unknown as AudioNode });
    const adapter = new MixerRoutingAdapter(nodes);
    assert.deepEqual(adapter.setRoute(1, 0), { valid: true });
    assert.equal(sourceOutput.connections[0], masterInput);
  });

  it('routing participates in undo/redo', () => {
    const project = createDefaultProjectState();
    const edited = updateMixerTrackInProjectState(project, 1, { routingTargetId: 2 });
    const history = createHistory(project).commit(edited, 'Route mixer track');
    const undone = history.undo();
    const redone = undone.redo();

    assert.equal(undone.present.mixerTracks.find(track => track.id === 1)?.routingTargetId, 0);
    assert.equal(redone.present.mixerTracks.find(track => track.id === 1)?.routingTargetId, 2);
  });

  it('routingTargetId survives project persistence serialization and normalization', () => {
    const project = createDefaultProjectState();
    const edited = updateMixerTrackInProjectState(project, 1, { routingTargetId: 2 });
    const restored = JSON.parse(serializeProjectState(edited)) as { state: typeof project };

    assert.equal(restored.state.mixerTracks.find(track => track.id === 1)?.routingTargetId, 2);
  });

  it('deleting a destination repairs dependent routes to Master', () => {
    const project = createDefaultProjectState();
    project.mixerTracks = project.mixerTracks.map(track =>
      track.id === 1 ? { ...track, routingTargetId: 2 } : track
    );

    const channelForTrackTwo = project.channels.find(channel => channel.mixerTrackId === 2);
    assert.ok(channelForTrackTwo);

    const result = deleteChannelFromProjectState(project, channelForTrackTwo!.id);
    assert.equal(result.removedMixerTrackId, 2);
    assert.equal(result.state.mixerTracks.some(track => track.id === 2), false);
    assert.equal(result.state.mixerTracks.find(track => track.id === 1)?.routingTargetId, 0);
  });

  it('preserves Phase 27 invalid/self/cycle rejection', () => {
    const graph = new MixerRoutingGraph();
    assert.equal(graph.setRoute(1, 1).valid, false);
    assert.equal(graph.setRoute(1, 2).valid, true);
    assert.equal(graph.setRoute(2, 3).valid, true);
    assert.equal(graph.setRoute(3, 1).valid, false);
  });
});
