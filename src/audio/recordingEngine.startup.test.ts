import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordingEngine, hasActiveRecordingEngineSession } from './recordingEngine';
import { DeterministicAudioContext, DeterministicMediaStream } from './recordingCaptureTestHarness';

test('capture startup failure disconnects locally-created nodes and releases the microphone/session token', async () => {
  const stream = new DeterministicMediaStream();
  const context = new DeterministicAudioContext();
  const source = {
    disconnected: false,
    connect() { return context.destination as unknown as AudioNode; },
    disconnect() { this.disconnected = true; },
  };
  const engine = new RecordingEngine(() => context as unknown as AudioContext, {
    getUserMedia: async () => stream as unknown as MediaStream,
    createInputSource: () => source,
    createCaptureNode: () => { throw new Error('AudioWorklet node construction failed'); },
  });

  await assert.rejects(engine.prepare(), /AudioWorklet node construction failed/);
  assert.equal(source.disconnected, true);
  assert.equal(stream.tracks[0].stopped, true);
  assert.equal(engine.getState(), 'idle');
  assert.equal(hasActiveRecordingEngineSession(), false);
});

test('interrupted audio context during preparation rejects instead of opening an unclocked take', async () => {
  const stream = new DeterministicMediaStream();
  const context = new DeterministicAudioContext();
  const engine = new RecordingEngine(() => context as unknown as AudioContext, {
    getUserMedia: async () => stream as unknown as MediaStream,
    createCaptureNode: (_context, _processorName, options) => context.makeCaptureNode(options),
  });
  const preparing = engine.prepare();
  const node = await context.captureNodeReady;
  await context.suspend();
  await assert.rejects(preparing, /audio context was interrupted/i);
  assert.equal(node.commands.some(command => command.direction === 'main-to-processor' && command.type === 'cancel'), true);
  assert.equal(stream.tracks[0].stopped, true);
  assert.equal(engine.getState(), 'idle');
  assert.equal(hasActiveRecordingEngineSession(), false);
});
