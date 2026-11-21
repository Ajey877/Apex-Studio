import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioDeviceManager } from './audioDeviceManager';
import { ManagedAudioInput } from './managedAudioInput';
import { LiveInputMonitor } from './liveInputMonitor';
import { mixerSoloAudibleIds } from './mixerSolo';
import type { MixerTrack } from '../types/daw';

class Track extends EventTarget {
  readyState = 'live';
  stops = 0;
  constructor(readonly channels = 1) { super(); }
  stop() { this.stops++; this.readyState = 'ended'; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
  getSettings() { return { channelCount: this.channels, latency: 0.01 }; }
}
class Stream {
  track: Track;
  clones: Stream[] = [];
  constructor(channels = 1) { this.track = new Track(channels); }
  getTracks() { return [this.track]; }
  getAudioTracks() { return this.getTracks(); }
  clone() { const clone = new Stream(this.track.channels); this.clones.push(clone); return clone; }
}
class Context extends EventTarget {
  state = 'running';
  baseLatency = 0.003;
  outputLatency = 0.01;
  sources: Array<{ destination: unknown; disconnected: boolean; connect(destination: unknown): void; disconnect(): void }> = [];
  fail: 'create' | 'connect' | null = null;
  async resume() { this.state = 'running'; }
  change(state: string) { this.state = state; this.dispatchEvent(new Event('statechange')); }
  createMediaStreamSource() {
    if (this.fail === 'create') throw new Error('source failed');
    const source = { destination: null as unknown, disconnected: false,
      connect: (destination: unknown) => { if (this.fail === 'connect') throw new Error('connect failed'); source.destination = destination; },
      disconnect() { this.disconnected = true; } };
    this.sources.push(source);
    return source;
  }
}
function fixture(channels = 1) {
  const devices = new AudioDeviceManager({ storage: null, getMediaDevices: () => undefined, getPermissions: () => undefined });
  const root = new Stream(channels);
  const requests: MediaStreamConstraints[] = [];
  const pool = new ManagedAudioInput(devices, async constraints => { requests.push(constraints); return root as unknown as MediaStream; });
  const monitor = new LiveInputMonitor(devices, pool);
  const context = new Context();
  const destination = {} as AudioNode;
  const start = () => monitor.start(context as unknown as AudioContext, destination, 3);
  return { devices, root, requests, pool, monitor, context, destination, start };
}

test('OFF by default; one producer edge to the supplied insert, no duplicate start, idempotent cleanup and restart', async () => {
  const f = fixture();
  assert.equal(f.monitor.getSnapshot().status, 'off');
  await f.start();
  assert.equal(f.devices.getSnapshot().microphonePermission, 'granted');
  assert.equal(f.context.sources[0].destination, f.destination);
  assert.equal(f.monitor.getSnapshot().trackId, 3);
  await assert.rejects(f.start(), /Disable the existing/);
  assert.equal(f.requests.length, 1);
  f.monitor.stop(); f.monitor.stop();
  assert.equal(f.context.sources[0].disconnected, true);
  assert.equal(f.root.track.stops, 1);
  // A new capture root is needed after a real hardware track was stopped.
  const g = fixture(); await g.start(); g.monitor.stop();
  assert.equal(g.root.track.stops, 1);
});

for (const channels of [1, 2]) test(`${channels}-channel capture preserves source layout`, async () => {
  const f = fixture(channels); await f.start();
  assert.equal(f.monitor.getSnapshot().channels, channels);
  assert.equal(f.monitor.getSnapshot().inputLatency, 0.01);
  f.monitor.stop();
});

test('unsupported multichannel capture fails closed and releases input', async () => {
  const f = fixture(4); await assert.rejects(f.start(), /mono or stereo/);
  assert.equal(f.monitor.getSnapshot().status, 'failed');
  assert.equal(f.root.track.stops, 1); assert.equal(f.context.sources.length, 0);
});

for (const fail of ['create', 'connect'] as const) test(`partial ${fail} failure rolls back tracks and graph`, async () => {
  const f = fixture(); f.context.fail = fail;
  await assert.rejects(f.start(), /failed/);
  assert.equal(f.monitor.getSnapshot().status, 'failed');
  assert.equal(f.root.track.stops, 1);
  assert.ok(f.context.sources.every(source => source.disconnected));
});

for (const name of ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'AbortError']) test(`${name} input failure leaves no route`, async () => {
  const f = fixture();
  const pool = new ManagedAudioInput(f.devices, async () => { throw new DOMException('capture unavailable', name); });
  const monitor = new LiveInputMonitor(f.devices, pool);
  await assert.rejects(monitor.start(f.context as unknown as AudioContext, f.destination, 1));
  assert.equal(monitor.getSnapshot().status, 'failed'); assert.equal(f.context.sources.length, 0);
  if (name === 'NotAllowedError') assert.equal(f.devices.getSnapshot().microphonePermission, 'denied');
});

test('selected exact input uses existing device constraints; no different-device takeover while leased', async () => {
  const f = fixture(); f.devices.selectInputDevice('physical-a'); await f.start();
  assert.deepEqual((f.requests[0].audio as MediaTrackConstraints).deviceId, { exact: 'physical-a' });
  await assert.rejects(f.pool.acquire('physical-b'), /different input/);
  assert.equal(f.requests.length, 1); f.monitor.stop();
});

test('unavailable selected device blocks acquisition rather than falling back', async () => {
  const f = fixture(); f.devices.selectInputDevice('missing');
  f.devices.translateAndRecordCaptureFailure(new DOMException('gone', 'NotFoundError'), 'missing');
  await assert.rejects(f.start(), /unavailable/); assert.equal(f.requests.length, 0);
});

test('device preference change and permission revocation disable, never automatically restart', async () => {
  for (const action of ['device', 'permission']) {
    const f = fixture(); await f.start();
    if (action === 'device') f.devices.selectInputDevice('new-input');
    else f.devices.translateAndRecordCaptureFailure(new DOMException('revoked', 'NotAllowedError'));
    assert.equal(f.monitor.getSnapshot().status, 'failed');
    assert.equal(f.root.track.stops, 1);
    f.devices.notifyInputCaptureSucceeded();
    assert.equal(f.monitor.getSnapshot().status, 'failed');
  }
});

for (const state of ['suspended', 'closed', 'interrupted']) test(`context ${state} stops without auto restart`, async () => {
  const f = fixture(); await f.start(); f.context.change(state);
  assert.equal(f.monitor.getSnapshot().status, 'off');
  assert.equal(f.root.track.stops, 1);
  f.context.change('running'); assert.equal(f.monitor.getSnapshot().status, 'off');
});

test('unexpected stream end clears source and releases its capture', async () => {
  const f = fixture(); await f.start(); f.root.clones[0].track.end();
  assert.equal(f.monitor.getSnapshot().status, 'failed');
  assert.equal(f.context.sources[0].disconnected, true); assert.equal(f.root.track.stops, 1);
});

test('stop while permission pending releases late capture without creating a route', async () => {
  const f = fixture(); let resolve!: (stream: MediaStream) => void;
  const pool = new ManagedAudioInput(f.devices, () => new Promise(res => { resolve = res; }));
  const monitor = new LiveInputMonitor(f.devices, pool);
  const starting = monitor.start(f.context as unknown as AudioContext, f.destination, 1);
  await Promise.resolve(); monitor.stop();
  resolve(f.root as unknown as MediaStream); await starting;
  assert.equal(f.root.track.stops, 1); assert.equal(f.context.sources.length, 0);
  assert.equal(monitor.getSnapshot().status, 'off');
});

test('recording and monitor leases share one acquisition; either stop order retains the other', async () => {
  for (const recorderFirst of [true, false]) {
    const f = fixture(); const recording = await f.pool.acquire(); await f.start();
    assert.equal(f.requests.length, 1);
    if (recorderFirst) {
      recording.release(); assert.equal(f.root.track.stops, 0);
      assert.equal(f.monitor.getSnapshot().status, 'active'); f.monitor.stop();
    } else {
      f.monitor.stop(); assert.equal(f.root.track.stops, 0);
      assert.equal(recording.stream.getAudioTracks()[0].readyState, 'live'); recording.release();
    }
    assert.equal(f.root.track.stops, 1);
  }
});

test('concurrent consumers deduplicate a pending acquisition; final release permits restart', async () => {
  const f = fixture(); const [a, b] = await Promise.all([f.pool.acquire(), f.pool.acquire()]);
  assert.equal(f.requests.length, 1); assert.notEqual(a.stream, b.stream);
  a.release(); a.release(); assert.equal(f.root.track.stops, 0); b.release();
  // Simulate hardware supplying a fresh live track on reopening.
  f.root.track = new Track(); const c = await f.pool.acquire();
  assert.equal(f.requests.length, 2); c.release(); assert.equal(f.root.track.stops, 1);
});

test('solo topology retains the solo path and buses/returns, not sibling sources', () => {
  const tracks = [0, 1, 2, 3, 4].map(id => ({ id, routingTargetId: id === 1 || id === 2 ? 3 : 0, solo: false, auxSends: id === 1 ? [{ targetId: 4, amount: 0.5 }] : [] })) as MixerTrack[];
  assert.equal(mixerSoloAudibleIds(tracks), null);
  tracks[1].solo = true; assert.deepEqual([...mixerSoloAudibleIds(tracks)!].sort(), [0, 1, 3, 4]);
  tracks[1].solo = false; tracks[3].solo = true;
  assert.deepEqual([...mixerSoloAudibleIds(tracks)!].sort(), [0, 1, 2, 3]);
});

test('hardware devicechange stops even the system-default input; passive listener is removed at shutdown', async () => {
  let devicechange: EventListener | null = null;
  const devices = new AudioDeviceManager({ storage: null, getPermissions: () => undefined,
    getMediaDevices: () => ({ getUserMedia: async () => { throw new Error('not used'); }, enumerateDevices: async () => [],
      addEventListener: (_type, listener) => { devicechange = listener; },
      removeEventListener: () => { devicechange = null; } }) });
  await devices.initializePassiveMonitoring();
  const root = new Stream();
  const monitor = new LiveInputMonitor(devices, new ManagedAudioInput(devices, async () => root as unknown as MediaStream));
  await monitor.start(new Context() as unknown as AudioContext, {} as AudioNode, 1);
  devicechange!(new Event('devicechange'));
  assert.equal(monitor.getSnapshot().status, 'off'); assert.equal(root.track.stops, 1);
  devices.disposeMonitoring(); assert.equal(devicechange, null);
});

test('unsupported browser capture API reports failure without a graph or a pending session', async () => {
  const f = fixture();
  const pool = new ManagedAudioInput(f.devices);
  const monitor = new LiveInputMonitor(f.devices, pool);
  await assert.rejects(monitor.start(f.context as unknown as AudioContext, f.destination, 1), /not supported/);
  assert.equal(monitor.getSnapshot().status, 'failed'); assert.equal(f.context.sources.length, 0);
});

test('clone construction failure releases an already acquired physical stream', async () => {
  const f = fixture();
  f.root.clone = () => { throw new Error('clone failed'); };
  await assert.rejects(f.start(), /clone failed/);
  assert.equal(f.root.track.stops, 1); assert.equal(f.context.sources.length, 0);
});

test('concurrent permission failure rolls back the pending pool and a retry can acquire', async () => {
  const f = fixture(); let calls = 0;
  const pool = new ManagedAudioInput(f.devices, async () => {
    if (++calls === 1) throw new DOMException('dismissed', 'NotAllowedError');
    return f.root as unknown as MediaStream;
  });
  const failures = await Promise.allSettled([pool.acquire(), pool.acquire()]);
  assert.ok(failures.every(result => result.status === 'rejected'));
  const retry = await pool.acquire(); assert.equal(calls, 2); retry.release();
  assert.equal(f.root.track.stops, 1);
});

test('old pending start cannot attach after stop and a new start', async () => {
  const f = fixture(); let resolve!: (stream: MediaStream) => void;
  const pool = new ManagedAudioInput(f.devices, () => new Promise(res => { resolve = res; }));
  const monitor = new LiveInputMonitor(f.devices, pool);
  const old = monitor.start(f.context as unknown as AudioContext, f.destination, 1);
  await Promise.resolve(); monitor.stop();
  const next = monitor.start(f.context as unknown as AudioContext, f.destination, 2);
  resolve(f.root as unknown as MediaStream); await Promise.all([old, next]);
  assert.equal(f.context.sources.length, 1); assert.equal(monitor.getSnapshot().trackId, 2);
  assert.equal(f.root.track.stops, 0); monitor.stop(); assert.equal(f.root.track.stops, 1);
});

test('failed Mixer/native FX preparation is reported before acquiring a microphone', async () => {
  const f = fixture();
  await assert.rejects(f.monitor.start(f.context as unknown as AudioContext, f.destination, 1, async () => {
    throw new Error('Mixer insert could not prepare');
  }), /Mixer insert could not prepare/);
  assert.equal(f.requests.length, 0); assert.equal(f.monitor.getSnapshot().status, 'failed');
});

test('cancelled asynchronous Mixer preparation cannot capture or publish a stale project graph', async () => {
  const f = fixture(); let finish!: () => void; let published = false;
  const starting = f.monitor.start(f.context as unknown as AudioContext, f.destination, 1, async isCurrent => {
    await new Promise<void>(resolve => { finish = resolve; });
    if (isCurrent()) published = true;
  });
  f.monitor.stop(); finish(); await starting;
  assert.equal(f.requests.length, 0); assert.equal(published, false);
  assert.equal(f.monitor.getSnapshot().status, 'off');
});

test('default aliases share the canonical preference session without an exact device constraint', async () => {
  const f = fixture(); const a = await f.pool.acquire('default'); const b = await f.pool.acquire('');
  assert.equal(f.requests.length, 1); assert.equal((f.requests[0].audio as MediaTrackConstraints).deviceId, undefined);
  a.release(); b.release(); assert.equal(f.root.track.stops, 1);
});
