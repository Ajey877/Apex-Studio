import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MixerChannelStrip } from './channelStrip';
import { MixerMasterGraph } from './mixerMasterGraph';

class FakeParam { value = 0; setValueAtTime(value: number): void { this.value = value; } }
class FakeNode { readonly connections: unknown[] = []; connect(target: unknown): void { this.connections.push(target); } disconnect(): void { this.connections.length = 0; } }
class FakeAnalyser extends FakeNode { fftSize = 32; smoothingTimeConstant = 0; getFloatTimeDomainData(target: Float32Array): void { target.fill(0); } }
function context(): AudioContext { return { currentTime: 0, createGain: () => Object.assign(new FakeNode(), { gain: new FakeParam() }), createStereoPanner: () => Object.assign(new FakeNode(), { pan: new FakeParam() }), createAnalyser: () => new FakeAnalyser() } as unknown as AudioContext; }
function connections(node: AudioNode): unknown[] { return (node as unknown as FakeNode).connections; }

describe('master integration', () => {
  it('keeps channel meter tap and master routing independent', () => {
    const audioContext = context();
    const graph = new MixerMasterGraph(audioContext);
    const channel = new MixerChannelStrip(audioContext, 1);
    graph.addChannel(channel);
    assert.equal(connections(channel.output).length, 2);
    assert.ok(connections(channel.output).includes(channel.meter));
    assert.ok(connections(channel.output).includes(graph.master.input));
  });
});
