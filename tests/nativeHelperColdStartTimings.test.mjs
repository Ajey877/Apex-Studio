// Deterministic coverage for the native helper cold-start forensics that a
// real-time deadline miss is diagnosed from. No plug-in binary and no Electron:
// a stand-in helper speaks the real framed protocol over a stub child process,
// with delays injected at chosen stages, so the attribution is what is under test.
//
// Why this exists: the packaged Windows acceptance fails intermittently with
// "Native effect missed its real-time processing deadline" inside the first few
// blocks of playback. The worklet fails closed when a 1024-frame block fills
// while the previous block's result is still outstanding, so the real budget is
// one block period (21.33 ms at 48 kHz). Diagnosing that needs the budget split
// across helper start-up, serial-queue wait, request serialization, the helper
// round trip and frame parsing - and those spans must not be confusable with
// each other. Each test below injects a delay in exactly one place and asserts
// that only the corresponding span reports it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NativeVst3Client, setNativeHelperSpawnForTests } from '../native/vst3/client.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function frame(json, pcm = Buffer.alloc(0)) {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(body.length, 0);
  header.writeUInt32LE(pcm.length, 4);
  return Buffer.concat([header, body, pcm]);
}

/**
 * A helper double whose handler may be async, so a delay can be injected at a
 * chosen stage. Like the real helper it answers on the dedicated protocol pipe
 * (the fourth stdio entry); stdout and stderr carry diagnostics only.
 */
function fakeHelper(handler) {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.protocol = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr, child.protocol];
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', 0, null)); };
  child.stdin.on('finish', () => setImmediate(() => child.emit('close', 0, null)));
  let buffered = '';
  child.stdin.on('data', chunk => {
    buffered += chunk.toString('utf8');
    let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      if (!line.trim()) continue;
      const request = JSON.parse(line);
      void Promise.resolve(handler(request)).then(response => {
        if (response === undefined) return;
        if (response instanceof Error) child.protocol.write(frame({ ok: false, error: response.message }));
        else child.protocol.write(frame({ ok: true, ...response }));
      });
    }
  });
  return child;
}

const openResponse = { plugin: { name: 'Fixture', classId: 'abcd', latencySamples: 0, parameters: [], controllerAvailable: false } };

test('helper start-up spans are stamped in order and report an injected cold load', async () => {
  // The plug-in load is the stage most often blamed for a cold-start miss, so it
  // has to be separately visible from process spawn and protocol bind.
  const coldMs = 120;
  let opened = false;
  setNativeHelperSpawnForTests(() => fakeHelper(async request => {
    if (request.command === 'open') {
      if (!opened) { opened = true; await sleep(coldMs); }
      return openResponse;
    }
    return { frames: request.frames };
  }));
  const client = new NativeVst3Client('/fake/apex-vst3-host.exe', { timeoutMs: 5000 });
  try {
    await client.open({ path: '/fake/plugin.vst3', classId: 'abcd' }, { sampleRate: 48000, mode: 'realtime', kind: 'effect' });
    const t = client.lifecycleTimings();
    assert.equal(client.pid, 4242, 'the helper pid must be recorded so a cold test cannot reuse a warm helper');
    for (const key of ['constructedAtMs', 'spawnedAtMs', 'protocolBoundAtMs', 'firstRequestWrittenAtMs',
      'firstResponseAtMs', 'openCompletedAtMs']) {
      assert.equal(typeof t[key], 'number', `${key} must be stamped`);
    }
    assert.ok(t.constructedAtMs <= t.spawnedAtMs, 'construction precedes spawn');
    assert.ok(t.spawnedAtMs <= t.protocolBoundAtMs, 'spawn precedes protocol bind');
    assert.ok(t.protocolBoundAtMs <= t.firstRequestWrittenAtMs, 'protocol bind precedes the first request');
    assert.ok(t.firstRequestWrittenAtMs <= t.firstResponseAtMs, 'the first request precedes its response');
    // The whole injected delay lands in the plug-in load, which is the first
    // request's round trip - not in spawn and not in the queue.
    assert.ok(t.firstRequestRoundTripMs >= coldMs - 5,
      `the injected ${coldMs} ms cold load must show in firstRequestRoundTripMs, got ${t.firstRequestRoundTripMs}`);
    assert.ok(t.constructedToOpenCompletedMs >= coldMs - 5,
      `total start-up must include the cold load, got ${t.constructedToOpenCompletedMs}`);
    assert.ok(t.spawnToProtocolBoundMs < coldMs,
      `process spawn/protocol bind must not absorb the plug-in load, got ${t.spawnToProtocolBoundMs}`);
  } finally {
    await client.dispose();
    setNativeHelperSpawnForTests(null);
  }
});

test('a slow first block is attributed to the helper round trip, not to queueing', async () => {
  // This is the discriminating measurement: a cold first block and a block stuck
  // behind another request look identical in a total, and only the split tells
  // them apart.
  const slowMs = 100;
  let processed = 0;
  setNativeHelperSpawnForTests(() => fakeHelper(async request => {
    if (request.command === 'open') return openResponse;
    processed++;
    if (processed === 1) await sleep(slowMs);
    return { frames: request.frames };
  }));
  const client = new NativeVst3Client('/fake/apex-vst3-host.exe', { timeoutMs: 5000 });
  try {
    await client.open({ path: '/fake/plugin.vst3', classId: 'abcd' }, { sampleRate: 48000, kind: 'effect' });
    const block = new Float32Array(2048);
    const cold = {};
    await client.processAudio(1024, block, [], 120, cold);
    const warm = {};
    await client.processAudio(1024, block, [], 120, warm);

    assert.ok(cold.helperRoundTripMs >= slowMs - 5,
      `the cold block's helper round trip must show the injected ${slowMs} ms, got ${cold.helperRoundTripMs}`);
    assert.ok(cold.queueWaitMs < slowMs / 2,
      `a lone request must not be reported as queue wait, got ${cold.queueWaitMs}`);
    assert.ok(warm.helperRoundTripMs < cold.helperRoundTripMs,
      `the warm block must be measurably faster (${warm.helperRoundTripMs} vs ${cold.helperRoundTripMs})`);
    assert.equal(cold.command, 'process', 'the span must name the command it measured');
    assert.ok(cold.requestBytes > 0, 'the serialized request size must be recorded');
    assert.ok(typeof cold.serializeMs === 'number', 'serialization cost must be recorded');
    assert.ok(typeof cold.frameParseMs === 'number', 'response frame parse cost must be recorded');
  } finally {
    await client.dispose();
    setNativeHelperSpawnForTests(null);
  }
});

test('a block queued behind another request reports queue wait, not helper time', async () => {
  // The helper channel is strictly serial, so a parameter poll in flight when an
  // audio block arrives delays that block by the poll's whole duration. That has
  // to be visible as queue wait, otherwise a serialization problem reads as a
  // slow plug-in.
  const blockerMs = 120;
  let processed = 0;
  setNativeHelperSpawnForTests(() => fakeHelper(async request => {
    if (request.command === 'open') return openResponse;
    processed++;
    if (processed === 1) await sleep(blockerMs);
    return { frames: request.frames };
  }));
  const client = new NativeVst3Client('/fake/apex-vst3-host.exe', { timeoutMs: 5000 });
  try {
    await client.open({ path: '/fake/plugin.vst3', classId: 'abcd' }, { sampleRate: 48000, kind: 'effect' });
    const block = new Float32Array(2048);
    const first = {};
    const second = {};
    const blocker = client.processAudio(1024, block, [], 120, first);
    // Issued while the first is still in flight, so it must wait for the channel.
    const queued = client.processAudio(1024, block, [], 120, second);
    await Promise.all([blocker, queued]);

    assert.ok(second.queueWaitMs >= blockerMs - 10,
      `the queued block must report waiting for the channel, got ${second.queueWaitMs}`);
    assert.ok(second.helperRoundTripMs < blockerMs / 2,
      `the queued block's own helper time must exclude the blocker, got ${second.helperRoundTripMs}`);
    assert.ok(first.queueWaitMs < second.queueWaitMs,
      `the first request must not report the second's wait (${first.queueWaitMs} vs ${second.queueWaitMs})`);
  } finally {
    await client.dispose();
    setNativeHelperSpawnForTests(null);
  }
});

test('a helper that never answers is reported as a timeout, not as a slow block', async () => {
  // A cold helper that hangs must surface as a failure with the start-up stamps
  // intact, so a timeout is distinguishable from a merely slow block. The helper
  // answers nothing at all here, so no response stamp may exist anywhere.
  setNativeHelperSpawnForTests(() => fakeHelper(async () => {
    await sleep(10000);
    return { frames: 1024 };
  }));
  const client = new NativeVst3Client('/fake/apex-vst3-host.exe', { timeoutMs: 150 });
  try {
    const timings = {};
    await assert.rejects(client.processAudio(1024, new Float32Array(2048), [], 120, timings), /timed out/);
    assert.equal(typeof timings.writeAtMs, 'number', 'the request must have reached the helper');
    assert.equal(timings.responseAtMs, null, 'a timed-out request must not report a response');
    assert.equal(timings.helperRoundTripMs, null, 'a timed-out request must not report a round trip');
    assert.ok(timings.queueWaitMs >= 0, 'queue wait is still measured for a timed-out request');
    const t = client.lifecycleTimings();
    assert.equal(t.firstResponseAtMs, null, 'no response ever arrived');
    assert.equal(typeof t.firstRequestWrittenAtMs, 'number', 'the request was written before the timeout');
  } finally {
    await client.dispose();
    setNativeHelperSpawnForTests(null);
  }
});

test('omitting the timings argument leaves the protocol path unchanged', async () => {
  // The instrumentation is additive: production callers that pass no timings
  // object must get exactly the behaviour they had before.
  setNativeHelperSpawnForTests(() => fakeHelper(request => (
    request.command === 'open' ? openResponse : { frames: request.frames })));
  const client = new NativeVst3Client('/fake/apex-vst3-host.exe', { timeoutMs: 5000 });
  try {
    const opened = await client.open({ path: '/fake/plugin.vst3', classId: 'abcd' }, { sampleRate: 48000, kind: 'effect' });
    assert.equal(opened.plugin.name, 'Fixture');
    const result = await client.processAudio(1024, new Float32Array(2048), [], 120);
    assert.equal(result.frames, 1024);
    assert.equal(typeof client.lifecycleTimings().openCompletedAtMs, 'number',
      'lifecycle stamps are collected regardless, they cost nothing per block');
  } finally {
    await client.dispose();
    setNativeHelperSpawnForTests(null);
  }
});
