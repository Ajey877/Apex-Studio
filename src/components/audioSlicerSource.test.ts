import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Channel } from '../types/daw';
import {
  isSlicerSourceReady,
  resolveSlicerAudioSource,
  slicerSourceMessage,
} from './audioSlicerSource';

const channel = (over: Partial<Channel> = {}): Channel => ({
  id: 'ch-1',
  name: 'Vox Chop',
  color: '#ff6e00',
  instrumentType: 'sampler',
  mixerTrackId: 1,
  volume: 1,
  pan: 0,
  pitch: 0,
  mute: false,
  solo: false,
  steps: [],
  notes: [],
  synthParams: {} as Channel['synthParams'],
  ...over,
});

const fakeBuffer = { duration: 2, sampleRate: 48000 } as unknown as AudioBuffer;

describe('Phase 52 — Audio Slicer source resolution', () => {
  it('resolves a real loaded sample buffer', () => {
    const source = resolveSlicerAudioSource(
      channel({ customSample: { id: 'sample-1', name: 'break.wav', duration: 2, sampleRate: 48000, channels: 2, waveformPeaks: [] } }),
      id => (id === 'sample-1' ? fakeBuffer : undefined)
    );
    assert.ok(isSlicerSourceReady(source));
    assert.equal(source.buffer, fakeBuffer);
    assert.equal(source.sampleId, 'sample-1');
    assert.equal(slicerSourceMessage(source), '');
  });

  it('resolves to no-sample when the channel has no sample assigned', () => {
    const source = resolveSlicerAudioSource(channel(), () => fakeBuffer);
    assert.equal(source.kind, 'no-sample');
    assert.ok(!isSlicerSourceReady(source));
    assert.ok(slicerSourceMessage(source).includes('no sample assigned'));
  });

  it('resolves to buffer-missing when the named sample is not loaded, and never fabricates one', () => {
    const source = resolveSlicerAudioSource(
      channel({ customSample: { id: 'missing-1', name: 'gone.wav', duration: 1, sampleRate: 48000, channels: 1, waveformPeaks: [] } }),
      () => undefined
    );
    assert.equal(source.kind, 'buffer-missing');
    assert.ok(!isSlicerSourceReady(source));
    assert.ok(slicerSourceMessage(source).includes('not loaded'));
  });

  it('resolves to no-channel when there is no target channel', () => {
    const source = resolveSlicerAudioSource(undefined, () => fakeBuffer);
    assert.equal(source.kind, 'no-channel');
  });
});

describe('Phase 52 — Audio Slicer has no fabricated waveform generator', () => {
  // The modal used to synthesize a breakbeat with Math.sin/Math.random and draw
  // it as the user's audio. Those primitives must not reappear in the modal.
  const source = readFileSync(
    path.resolve(fileURLToPath(new URL('.', import.meta.url)), 'AudioSlicerModal.tsx'),
    'utf8'
  );

  it('does not synthesize audio buffers', () => {
    // A generated waveform needs a trig/random source, an oscillator, or both.
    assert.ok(!/Math\.sin\s*\(/.test(source), 'the slicer must not synthesize a waveform with Math.sin');
    assert.ok(!/Math\.cos\s*\(/.test(source), 'the slicer must not synthesize a waveform with Math.cos');
    assert.ok(!/Math\.random\s*\(/.test(source), 'the slicer must not synthesize noise with Math.random');
    assert.ok(!/createOscillator\s*\(/.test(source), 'the slicer must not synthesize with an oscillator');

    // `createBuffer(2, ...)` allocates a buffer; `createBufferSource()` merely
    // plays an existing one and is how a real sample is auditioned.
    assert.ok(
      !/createBuffer\s*\(\s*\d/.test(source),
      'the slicer must not allocate an audio buffer to fill with generated audio'
    );

    // Reading channel data to draw a real waveform is fine. Writing into it is
    // how the fabricated breakbeat was produced.
    assert.ok(
      !/getChannelData\([^)]*\)\s*\[[^\]]*\]\s*[+\-*/]?=/.test(source),
      'the slicer must not write into a decoded buffer'
    );
  });

  it('routes its source through the audited resolver', () => {
    assert.ok(source.includes('resolveSlicerAudioSource'), 'the modal must use the audited source resolver');
    assert.ok(source.includes('slicerSourceMessage'), 'the modal must render the audited unavailable message');
  });
});
