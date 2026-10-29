import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveAudioPortSession, LIVE_AUDIO_BLOCK_FRAMES } from '../../native/vst3/liveAudioPort.mjs';

const BLOCK_SAMPLES = LIVE_AUDIO_BLOCK_FRAMES * 2;
const pcm = (value = 0.25) => new Float32Array(BLOCK_SAMPLES).fill(value);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const waitFor = async (predicate: () => boolean, attempts = 40) => {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('timed out waiting for live-port condition');
};

async function openPair(processAudio: (request: any) => Promise<Float32Array>, extras: Record<string, unknown> = {}) {
  const channel = new MessageChannel();
  const session = createLiveAudioPortSession({
    sessionId: 'session-live', owner: 'owner-1', trackId: 1, slotId: 'fx-1', processAudio, ...extras,
  });
  const received: any[] = [];
  channel.port1.onmessage = event => received.push(event.data);
  session.attach(channel.port2);
  await waitFor(() => received.some(message => message.type === 'bound'));
  return {
    session, received, port: channel.port1,
    process: (sequence: number, samples = pcm(sequence + 1), timing?: Record<string, number>) => {
      channel.port1.postMessage({ type: 'process', sequence, samples, ...(timing ? { timing } : {}) }, [samples.buffer]);
    },
    close: () => { channel.port1.close(); channel.port2.close(); },
  };
}

test('live audio port correlates FIFO results to the originating sequence', async () => {
  const order: number[] = [];
  const pair = await openPair(async ({ sequence, samples }) => {
    order.push(sequence);
    await tick();
    return samples.map(value => value * 2) as Float32Array;
  });
  try {
    assert.equal(pair.received[0]?.type, 'bound');
    pair.process(0, pcm(0.1));
    pair.process(1, pcm(0.2));
    await waitFor(() => pair.received.filter(message => message.type === 'result').length === 2);
    const results = pair.received.filter(message => message.type === 'result');
    assert.deepEqual(results.map(message => message.sequence), [0, 1]);
    assert.deepEqual(order, [0, 1]);
    assert.ok(Math.abs(results[0].samples[0] - 0.2) < 1e-6);
    assert.ok(Math.abs(results[1].samples[0] - 0.4) < 1e-6);
  } finally { pair.close(); }
});

test('live audio port serializes overlapping process requests on one session', async () => {
  let current = 0, maximum = 0;
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const pair = await openPair(async ({ sequence, samples }) => {
    current++;
    maximum = Math.max(maximum, current);
    if (sequence === 0) await firstGate;
    current--;
    return samples;
  });
  try {
    pair.process(0);
    pair.process(1);
    await waitFor(() => current === 1);
    assert.equal(maximum, 1);
    assert.equal(pair.received.some(message => message.type === 'result'), false);
    releaseFirst!();
    await waitFor(() => pair.received.filter(message => message.type === 'result').length === 2);
    assert.equal(maximum, 1);
    assert.deepEqual(pair.received.filter(message => message.type === 'result').map(message => message.sequence), [0, 1]);
  } finally { pair.close(); }
});

test('live audio port rejects unauthorized identity before a port is attached', () => {
  assert.throws(() => createLiveAudioPortSession({
    sessionId: '', owner: 'owner-1', trackId: 1, slotId: 'fx-1', processAudio: async () => pcm(),
  }), /Invalid live audio session/);
  assert.throws(() => createLiveAudioPortSession({
    sessionId: 'session-live', owner: '', trackId: 1, slotId: 'fx-1', processAudio: async () => pcm(),
  }), /Invalid live audio owner/);
  assert.throws(() => createLiveAudioPortSession({
    sessionId: 'session-live', owner: 'owner-1', trackId: 1.5, slotId: 'fx-1', processAudio: async () => pcm(),
  }), /Invalid live audio identity/);
  const session = createLiveAudioPortSession({
    sessionId: 'session-live', owner: 'owner-1', trackId: 1, slotId: 'fx-1', processAudio: async () => pcm(),
  });
  assert.throws(() => session.attach(undefined), /Live audio port missing/);
  const channel = new MessageChannel();
  session.attach(channel.port2);
  assert.throws(() => session.attach(channel.port1), /Live audio port already bound/);
  channel.port1.close();
  channel.port2.close();
});

test('live audio port cancels an in-flight block when dispose races the native reply', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let processed = false;
  const pair = await openPair(async ({ samples }) => {
    processed = true;
    await gate;
    return samples;
  });
  try {
    pair.process(0);
    await waitFor(() => processed);
    const disposing = pair.session.dispose('explicit-stop');
    release!();
    await disposing;
    await tick(); await tick();
    assert.equal(pair.session.disposed, true);
    assert.ok(pair.received.some(message => message.type === 'cancelled' && message.sequence === 0 && message.reason === 'explicit-stop'));
    assert.equal(pair.received.some(message => message.type === 'result'), false,
      'a late native reply after shutdown must not be posted as success');
  } finally { pair.close(); }
});

test('closing the live audio port stops later process requests', async () => {
  const calls: number[] = [];
  const pair = await openPair(async ({ sequence, samples }) => {
    calls.push(sequence);
    return samples;
  });
  try {
    pair.port.close();
    await waitFor(() => pair.session.disposed);
    try { pair.process(0); } catch { /* closed ports reject postMessage */ }
    await tick(); await tick();
    assert.deepEqual(calls, []);
    assert.equal(pair.received.some(message => message.type === 'result'), false);
  } finally { pair.close(); }
});

test('live audio port accounts cancelled sequences instead of accepting them', async () => {
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const pair = await openPair(async ({ sequence, samples }) => {
    if (sequence === 0) await firstGate;
    return samples;
  });
  try {
    pair.process(0);
    await waitFor(() => pair.session.pending === 1);
    const disposing = pair.session.dispose('explicit-stop');
    pair.process(4);
    await tick();
    releaseFirst!();
    await disposing;
    await tick(); await tick();
    const cancelled = pair.received.filter(message => message.type === 'cancelled').map(message => message.sequence).sort((left, right) => left - right);
    assert.deepEqual(cancelled, [0, 4]);
    assert.equal(pair.received.some(message => message.type === 'result'), false);
  } finally { pair.close(); }
});

test('live-port stop returns while native process is blocked so session close can abort it', async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const pair = await openPair(async ({ samples }) => {
    order.push('process-entered');
    await gate;
    order.push('process-released');
    return samples;
  });
  try {
    pair.process(0);
    await waitFor(() => order.includes('process-entered'));
    pair.session.stop();
    order.push('stop-returned');
    order.push('native-close-started');
    assert.deepEqual(order, ['process-entered', 'stop-returned', 'native-close-started'],
      'native close/abort must start before the blocked process is released');
    assert.equal(pair.session.stopping, true);
    assert.equal(pair.session.disposed, false);
    assert.equal(pair.received.some(message => message.type === 'result'), false);
    release!();
    await pair.session.dispose('explicit-stop');
    await tick(); await tick();
    assert.equal(pair.session.disposed, true);
    assert.equal(pair.session.pending, 0);
    assert.ok(pair.received.some(message => message.type === 'cancelled' && message.sequence === 0 && message.reason === 'explicit-stop'));
    assert.equal(pair.received.some(message => message.type === 'result'), false,
      'a late native reply after shutdown must not be posted as success');
  } finally { pair.close(); }
});

test('malformed live-port PCM is rejected without a successful result', async () => {
  const fatals: Error[] = [];
  const pair = await openPair(async ({ samples }) => samples, { onFatal: (error: Error) => fatals.push(error) });
  try {
    pair.port.postMessage({ type: 'process', sequence: 0, samples: new Float32Array(8) });
    await waitFor(() => pair.received.some(message => message.type === 'error'));
    assert.equal(pair.received.some(message => message.type === 'result'), false);
    assert.equal(fatals.length, 1);
    assert.match(fatals[0].message, /Invalid native-effect live-port request/);
  } finally { pair.close(); }
});
