import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MixerChannelStrip } from './channelStrip';

class FakeParam {
  value = 0;
  setValueAtTime(value: number): void { this.value = value; }
}

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
  const context = {
    currentTime: 1.5,
    createGain: () => Object.assign(new FakeNode(), { gain: new FakeParam() }),
    createStereoPanner: () => Object.assign(new FakeNode(), { pan: new FakeParam() }),
    createAnalyser: () => new FakeAnalyser(),
  };
  return context as unknown as AudioContext;
}

describe('MixerChannelStrip', () => {
  it('builds gain, pan, output and meter nodes', () => {
    const strip = new MixerChannelStrip(fakeContext(), 1, 'Lead');
    assert.equal(strip.state.name, 'Lead');
    assert.equal(strip.input.connections[0], strip.gain);
    assert.equal(strip.gain.connections[0], strip.panner);
    assert.equal(strip.panner.connections[0], strip.output);
    assert.equal(strip.output.connections[0], strip.meter);
  });

  it('applies volume and pan to Web Audio parameters', () => {
    const strip = new MixerChannelStrip(fakeContext(), 1);
    strip.setVolumeDb(-6);
    strip.setPan(0.75);
    assert.equal(strip.state.volumeDb, -6);
    assert.equal((strip.gain.gain as unknown as FakeParam).value.toFixed(3), '0.501');
    assert.equal((strip.panner.pan as unknown as FakeParam).value, 0.75);
  });

  it('mutes and restores the gain stage', () => {
    const strip = new MixerChannelStrip(fakeContext(), 1);
    strip.setMuted(true);
    assert.equal((strip.gain.gain as unknown as FakeParam).value, 0);
    strip.setMuted(false);
    assert.equal((strip.gain.gain as unknown as FakeParam).value, 1);
  });

  it('honours global solo state', () => {
    const strip = new MixerChannelStrip(fakeContext(), 1);
    strip.setSoloState(true);
    assert.equal((strip.gain.gain as unknown as FakeParam).value, 0);
    strip.setSoloed(true);
    assert.equal((strip.gain.gain as unknown as FakeParam).value, 1);
  });

  it('reports deterministic silent meter levels', () => {
    const strip = new MixerChannelStrip(fakeContext(), 1);
    assert.deepEqual(strip.getMeterLevels(), { peak: 0, rms: 0 });
  });
});
