import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TrackRegistry } from './trackRegistry';
import { TrackAudioRouter } from './trackAudioRouter';

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
  return {
    currentTime: 1,
    createGain: () => Object.assign(new FakeNode(), { gain: new FakeParam() }),
    createStereoPanner: () => Object.assign(new FakeNode(), { pan: new FakeParam() }),
    createAnalyser: () => new FakeAnalyser(),
  } as unknown as AudioContext;
}

describe('TrackAudioRouter', () => {
  it('creates one runtime strip per registry track and applies state', () => {
    const registry = new TrackRegistry();
    const first = registry.create('Lead');
    const second = registry.create('Bass');
    registry.setVolume(first.id, -6);
    registry.setPan(second.id, 0.5);

    const router = new TrackAudioRouter(fakeContext(), registry);
    router.sync();

    assert.ok(router.getStrip(first.id));
    assert.ok(router.getStrip(second.id));
    assert.equal(router.getStrip(first.id)?.state.volumeDb, -6);
    assert.equal(router.getStrip(second.id)?.state.pan, 0.5);
  });

  it('removes runtime strips when tracks are removed', () => {
    const registry = new TrackRegistry();
    const track = registry.create('Lead');
    const router = new TrackAudioRouter(fakeContext(), registry);
    router.sync();
    assert.ok(router.getStrip(track.id));

    registry.remove(track.id);
    router.sync();
    assert.equal(router.getStrip(track.id), undefined);
  });

  it('propagates global solo state deterministically', () => {
    const registry = new TrackRegistry();
    const first = registry.create('Lead');
    const second = registry.create('Bass');
    const router = new TrackAudioRouter(fakeContext(), registry);
    router.sync();

    registry.setSolo(first.id, true);
    router.sync();

    assert.equal((router.getStrip(first.id)?.gain.gain as unknown as FakeParam).value, 1);
    assert.equal((router.getStrip(second.id)?.gain.gain as unknown as FakeParam).value, 0);
  });

  it('disposes all runtime strips and rejects further access', () => {
    const registry = new TrackRegistry();
    registry.create('Lead');
    const router = new TrackAudioRouter(fakeContext(), registry);
    router.sync();
    router.dispose();
    assert.throws(() => router.sync(), /disposed/);
  });
});
