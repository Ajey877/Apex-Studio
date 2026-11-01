import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { createLiveAudioPortSession } from '../../native/vst3/liveAudioPort.mjs';
import { VST3_FX_BLOCK_FRAMES } from './nativeVst3EffectRuntime';

test('live audio port processes independent stereo blocks across two bound sessions without cross-talk', async () => {
  const channelA = new MessageChannel();
  const channelB = new MessageChannel();
  const receivedA: any[] = [];
  const receivedB: any[] = [];
  channelA.port2.on('message', message => receivedA.push(message));
  channelB.port2.on('message', message => receivedB.push(message));
  channelA.port2.start();
  channelB.port2.start();

  const seenCalls: Array<{ sessionId: string; firstL: number; firstR: number }> = [];
  const processAudio = async ({ sessionId, samples }: { sessionId: string; samples: Float32Array }) => {
    seenCalls.push({ sessionId, firstL: samples[0]!, firstR: samples[VST3_FX_BLOCK_FRAMES]! });
    const gain = sessionId === 'session-a' ? 2 : -3;
    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i]! * gain;
    return out;
  };

  const sessionA = createLiveAudioPortSession({
    sessionId: 'session-a', owner: 'owner-1', trackId: 1, slotId: 'slot-1', processAudio,
  });
  const sessionB = createLiveAudioPortSession({
    sessionId: 'session-b', owner: 'owner-1', trackId: 1, slotId: 'slot-2', processAudio,
  });
  sessionA.attach(channelA.port1);
  sessionB.attach(channelB.port1);

  try {
    const inputA = new Float32Array(VST3_FX_BLOCK_FRAMES * 2);
    inputA.fill(0.1, 0, VST3_FX_BLOCK_FRAMES);
    inputA.fill(-0.2, VST3_FX_BLOCK_FRAMES);
    const inputB = new Float32Array(VST3_FX_BLOCK_FRAMES * 2);
    inputB.fill(0.25, 0, VST3_FX_BLOCK_FRAMES);
    inputB.fill(0.05, VST3_FX_BLOCK_FRAMES);

    channelA.port2.postMessage({ type: 'process', sequence: 0, samples: inputA }, [inputA.buffer]);
    channelB.port2.postMessage({ type: 'process', sequence: 0, samples: inputB }, [inputB.buffer]);
    await new Promise(resolve => setTimeout(resolve, 25));

    assert.ok(receivedA.some(m => m?.type === 'bound' && m.sessionId === 'session-a'));
    assert.ok(receivedB.some(m => m?.type === 'bound' && m.sessionId === 'session-b'));
    const resultA = receivedA.find(m => m?.type === 'result');
    const resultB = receivedB.find(m => m?.type === 'result');
    assert.ok(resultA && resultB);
    assert.equal(resultA.sequence, 0);
    assert.equal(resultB.sequence, 0);
    assert.ok(Math.abs(resultA.samples[0] - 0.2) < 1e-6);
    assert.ok(Math.abs(resultA.samples[VST3_FX_BLOCK_FRAMES] - -0.4) < 1e-6);
    assert.ok(Math.abs(resultB.samples[0] - -0.75) < 1e-6);
    assert.ok(Math.abs(resultB.samples[VST3_FX_BLOCK_FRAMES] - -0.15) < 1e-6);
    assert.equal(seenCalls.length, 2);
  } finally {
    await sessionA.dispose();
    await sessionB.dispose();
    channelA.port2.close();
    channelB.port2.close();
  }
});

test('live audio port rejects overlapping requests and stops non-blockingly without delivering stale PCM', async () => {
  const channel = new MessageChannel();
  const received: any[] = [];
  channel.port2.on('message', message => received.push(message));
  channel.port2.start();

  let rejectInFlight: ((error: Error) => void) | undefined;
  const bound = createLiveAudioPortSession({
    sessionId: 'session-stop', owner: 'owner-1', trackId: 1, slotId: 'slot-1',
    processAudio: () => new Promise<Float32Array>((_resolve, reject) => { rejectInFlight = reject; }),
  });
  bound.attach(channel.port1);

  try {
    const first = new Float32Array(VST3_FX_BLOCK_FRAMES * 2).fill(0.1);
    channel.port2.postMessage({ type: 'process', sequence: 3, samples: first }, [first.buffer]);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.ok(rejectInFlight, 'native request is in flight');

    // stop() is synchronous and non-blocking even while native processing is in flight
    bound.stop('explicit-stop');
    assert.equal(bound.stopping, true);

    rejectInFlight!(new Error('VST3 instance cancelled'));
    await new Promise(resolve => setTimeout(resolve, 15));

    assert.equal(received.some(m => m?.type === 'result'), false, 'no stale PCM result after stop');
    assert.ok(received.some(m => m?.type === 'cancelled' && m.sequence === 3), 'cancelled notice emitted for in-flight sequence');
  } finally {
    await bound.dispose();
    channel.port2.close();
  }

  // Overlap check on a fresh port
  const overlapChannel = new MessageChannel();
  const overlapMessages: any[] = [];
  overlapChannel.port2.on('message', message => overlapMessages.push(message));
  overlapChannel.port2.start();
  let releaseFirst: ((out: Float32Array) => void) | undefined;
  const overlapBound = createLiveAudioPortSession({
    sessionId: 'session-overlap', owner: 'owner-1', trackId: 1, slotId: 'slot-1',
    processAudio: () => new Promise<Float32Array>(resolve => { releaseFirst = resolve; }),
  });
  overlapBound.attach(overlapChannel.port1);
  try {
    const a = new Float32Array(VST3_FX_BLOCK_FRAMES * 2);
    const b = new Float32Array(VST3_FX_BLOCK_FRAMES * 2);
    overlapChannel.port2.postMessage({ type: 'process', sequence: 0, samples: a }, [a.buffer]);
    overlapChannel.port2.postMessage({ type: 'process', sequence: 1, samples: b }, [b.buffer]);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(overlapMessages.some(m => m?.type === 'error' && /overlapping/i.test(m.reason)));
    releaseFirst?.(new Float32Array(VST3_FX_BLOCK_FRAMES * 2));
  } finally {
    await overlapBound.dispose();
    overlapChannel.port2.close();
  }
});
