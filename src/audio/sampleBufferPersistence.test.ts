import test from 'node:test';
import assert from 'node:assert/strict';
import { installSampleBufferPersistence, waitForSampleBufferPersistence } from './sampleBufferPersistence';

const createEngine = () => {
  const calls: string[] = [];
  const engine = {
    setSampleBuffer(id: string, _buffer: AudioBuffer) {
      calls.push(id);
    }
  };
  return { engine, calls };
};

const fakeBuffer = { duration: 1 } as AudioBuffer;

test('sample buffer persistence waits for the asynchronous asset write', async () => {
  const { engine, calls } = createEngine();
  let persisted = false;
  installSampleBufferPersistence(engine, {
    encode: () => new Blob(['wav'], { type: 'audio/wav' }),
    persistAudioClip: async (_id, blob) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(await blob.text(), 'wav');
      persisted = true;
    }
  });

  engine.setSampleBuffer('asset-1', fakeBuffer);
  assert.deepEqual(calls, ['asset-1']);
  assert.equal(persisted, false);
  await waitForSampleBufferPersistence(engine, 'asset-1');
  assert.equal(persisted, true);
});

test('sample buffer persistence exposes write failures through the wait gate', async () => {
  const { engine } = createEngine();
  const expected = new Error('quota exceeded');
  installSampleBufferPersistence(engine, {
    encode: () => new Blob(['wav']),
    persistAudioClip: async () => { throw expected; },
    onError: () => undefined
  });

  engine.setSampleBuffer('asset-fail', fakeBuffer);
  await assert.rejects(
    () => waitForSampleBufferPersistence(engine, 'asset-fail'),
    error => error === expected
  );
});
