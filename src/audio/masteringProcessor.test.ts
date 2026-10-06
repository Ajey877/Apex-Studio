import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MasteringProcessor } from './masteringProcessor';
import { DEFAULT_MASTERING_SUITE_STATE } from './masteringState';

class FakeParam {
  value = 0;
  setValueAtTime(value: number) { this.value = value; }
}
class FakeNode {
  connections: unknown[][] = [];
  disconnected = false;
  connect(destination: unknown, ...args: unknown[]) { this.connections.push([destination, ...args]); }
  disconnect() { this.disconnected = true; }
}
class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakeBiquad extends FakeNode { frequency = new FakeParam(); type = 'lowpass'; }
class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  knee = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}
class FakeWaveShaper extends FakeNode { curve: Float32Array | null = null; oversample = 'none'; }

function fakeContext() {
  const nodes: FakeNode[] = [];
  const make = <T extends FakeNode>(node: T): T => { nodes.push(node); return node; };
  const context = {
    currentTime: 2,
    sampleRate: 48000,
    createGain: () => make(new FakeGain()),
    createBiquadFilter: () => make(new FakeBiquad()),
    createDynamicsCompressor: () => make(new FakeCompressor()),
    createWaveShaper: () => make(new FakeWaveShaper()),
    createChannelSplitter: () => make(new FakeNode()),
    createChannelMerger: () => make(new FakeNode()),
  };
  return { context: context as unknown as AudioContext, nodes };
}

describe('Phase 89 real master processor', () => {
  it('routes the enabled master signal through multiband, stereo, and ceiling stages', () => {
    const { context, nodes } = fakeContext();
    const processor = new MasteringProcessor(context, DEFAULT_MASTERING_SUITE_STATE);
    const gains = nodes.filter((node): node is FakeGain => node instanceof FakeGain);
    const compressors = nodes.filter((node): node is FakeCompressor => node instanceof FakeCompressor);
    const shaper = nodes.find((node): node is FakeWaveShaper => node instanceof FakeWaveShaper);

    assert.equal(gains[2].gain.value, 0, 'bypass path is muted when mastering is enabled');
    assert.equal(gains[3].gain.value, 1, 'processed path is audible when mastering is enabled');
    assert.equal(compressors.length, 4, 'three band compressors plus the maximizer');
    assert.equal(compressors[0].threshold.value, DEFAULT_MASTERING_SUITE_STATE.lowBand.threshold);
    assert.equal(compressors[3].threshold.value, DEFAULT_MASTERING_SUITE_STATE.maximizerThreshold);
    assert.equal(shaper?.oversample, '4x');
    assert.ok(shaper?.curve instanceof Float32Array);
    assert.ok(processor.input.connections.length >= 2, 'input feeds both bypass and processing paths');
    processor.dispose();
  });

  it('updates processing parameters and safely bypasses the chain', () => {
    const { context, nodes } = fakeContext();
    const processor = new MasteringProcessor(context, DEFAULT_MASTERING_SUITE_STATE);
    const changed = {
      ...DEFAULT_MASTERING_SUITE_STATE,
      enabled: false,
      lowBand: { ...DEFAULT_MASTERING_SUITE_STATE.lowBand, threshold: -31, ratio: 6 },
      stereoSpread: 1.8,
      maximizerCeiling: -1,
    };
    processor.setState(changed);
    const gains = nodes.filter((node): node is FakeGain => node instanceof FakeGain);
    const compressors = nodes.filter((node): node is FakeCompressor => node instanceof FakeCompressor);
    const shaper = nodes.find((node): node is FakeWaveShaper => node instanceof FakeWaveShaper);

    assert.equal(gains[2].gain.value, 1, 'bypass path is audible when disabled');
    assert.equal(gains[3].gain.value, 0, 'processed path is muted when disabled');
    assert.equal(compressors[0].threshold.value, -31);
    assert.equal(compressors[0].ratio.value, 6);
    assert.equal(compressors[3].threshold.value, changed.maximizerThreshold);
    assert.equal(shaper?.curve?.[shaper.curve.length - 1], Math.pow(10, -1 / 20));
    processor.dispose();
    processor.dispose();
    assert.equal(nodes.every(node => node.disconnected), true, 'dispose is idempotent and releases every node');
  });
});
