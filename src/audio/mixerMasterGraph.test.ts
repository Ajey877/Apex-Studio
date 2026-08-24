import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MixerChannelStrip } from './channelStrip';
import { MixerMasterGraph } from './mixerMasterGraph';

class FakeParam { value = 0; setValueAtTime(value: number): void { this.value = value; } }
class FakeNode {
  readonly connections: unknown[] = [];
  connect(target: unknown): void { this.connections.push(target); }
  disconnect(): void { this.connections.length = 0; }
}
class FakeAnalyser extends FakeNode {
  fftSize = 32;
  smoothingTimeConstant = 0;
  getFloatTimeDomainData(target: Float32Array): void { target.fill(0); }
}
function fakeContext(): AudioContext {
  return {
    currentTime: 1,
    createGain: () => Object.assign(new FakeNode(), { gain: new FakeParam() }),
    createStereoPanner: () => Object.assign(new FakeNode(), { pan: new FakeParam() }),
    createAnalyser: () => new FakeAnalyser(),
  } as unknown as AudioContext;
}
function connections(node: AudioNode): unknown[] { return (node as unknown as FakeNode).connections; }

describe('MixerMasterGraph', () => {
  it('routes channels to the master and master to the destination', () => {
    const context = fakeContext();
    const graph = new MixerMasterGraph(context);
    const channel = new MixerChannelStrip(context, 1, 'Lead');
    const destination = new FakeNode();
    graph.addChannel(channel);
    graph.connectDestination(destination as unknown as AudioNode);

    assert.deepEqual(connections(channel.output), [graph.master.input]);
    assert.deepEqual(connections(graph.master.output), [destination]);
  });

  it('propagates global solo state across channels', () => {
    const context = fakeContext();
    const graph = new MixerMasterGraph(context);
    const first = new MixerChannelStrip(context, 1);
    const second = new MixerChannelStrip(context, 2);
    graph.addChannel(first);
    graph.addChannel(second);

    first.setSoloed(true);
    graph.refreshSoloState();
    assert.equal((first.gain.gain as unknown as FakeParam).value, 1);
    assert.equal((second.gain.gain as unknown as FakeParam).value, 0);

    first.setSoloed(false);
    graph.refreshSoloState();
    assert.equal((second.gain.gain as unknown as FakeParam).value, 1);
  });

  it('rejects duplicate channel IDs', () => {
    const context = fakeContext();
    const graph = new MixerMasterGraph(context);
    graph.addChannel(new MixerChannelStrip(context, 1));
    assert.throws(() => graph.addChannel(new MixerChannelStrip(context, 1)), /already registered/);
  });
});
