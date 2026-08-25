import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEffectProcessor, type EffectType } from './effectProcessor';

class FakeParam {
  value = 0;
}

class FakeNode {
  disconnected = false;
  disconnect(): void { this.disconnected = true; }
}

class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakeFilter extends FakeNode {
  type: BiquadFilterType = 'lowpass';
  frequency = new FakeParam();
  Q = new FakeParam();
  gain = new FakeParam();
}
class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  ratio = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
}
class FakeDelay extends FakeNode { delayTime = new FakeParam(); }
class FakeShaper extends FakeNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
}

function fakeContext(): AudioContext {
  return {
    createGain: () => new FakeGain(),
    createBiquadFilter: () => new FakeFilter(),
    createDynamicsCompressor: () => new FakeCompressor(),
    createDelay: () => new FakeDelay(),
    createWaveShaper: () => new FakeShaper(),
  } as unknown as AudioContext;
}

describe('createEffectProcessor', () => {
  const types: EffectType[] = ['gain', 'lowpass', 'highpass', 'eq', 'compressor', 'delay', 'distortion'];

  it('creates every supported processor type', () => {
    const context = fakeContext();
    for (const type of types) {
      const processor = createEffectProcessor(context, type);
      assert.equal(processor.type, type);
      assert.ok(processor.node);
      processor.dispose();
      assert.equal((processor.node as unknown as FakeNode).disconnected, true);
    }
  });

  it('converts gain dB to linear gain and clamps it', () => {
    const processor = createEffectProcessor(fakeContext(), 'gain', { gainDb: 6 });
    assert.ok(Math.abs((processor.node as unknown as FakeGain).gain.value - 1.9952623149688795) < 1e-12);

    processor.setParameters({ gainDb: -100 });
    assert.equal((processor.node as unknown as FakeGain).gain.value, 0);
  });

  it('configures filter frequency, Q, and EQ gain', () => {
    const filter = createEffectProcessor(fakeContext(), 'eq', {
      frequencyHz: 2500,
      q: 2,
      gainDb: 6,
    }).node as unknown as FakeFilter;

    assert.equal(filter.type, 'peaking');
    assert.equal(filter.frequency.value, 2500);
    assert.equal(filter.Q.value, 2);
    assert.equal(filter.gain.value, 6);
  });

  it('configures compressor and delay timing parameters', () => {
    const compressor = createEffectProcessor(fakeContext(), 'compressor', {
      thresholdDb: -18,
      ratio: 8,
      attackSeconds: 0.01,
      releaseSeconds: 0.4,
    }).node as unknown as FakeCompressor;
    assert.equal(compressor.threshold.value, -18);
    assert.equal(compressor.ratio.value, 8);
    assert.equal(compressor.attack.value, 0.01);
    assert.equal(compressor.release.value, 0.4);

    const delay = createEffectProcessor(fakeContext(), 'delay', { delaySeconds: 0.5 }).node as unknown as FakeDelay;
    assert.equal(delay.delayTime.value, 0.5);
  });

  it('creates a real distortion curve and uses oversampling', () => {
    const shaper = createEffectProcessor(fakeContext(), 'distortion', { drive: 0.5 }).node as unknown as FakeShaper;
    assert.ok(shaper.curve instanceof Float32Array);
    assert.equal(shaper.curve.length, 1024);
    assert.equal(shaper.oversample, '4x');
  });
});
